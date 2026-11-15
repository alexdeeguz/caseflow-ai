create table caseflow.document_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references caseflow.documents(id),
  requested_by uuid not null references caseflow.users(id),
  previous_job_id uuid unique references caseflow.document_processing_jobs(id),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'ready', 'failed', 'cancelled')),
  stage text check (stage in ('extracting', 'waiting_for_ocr', 'collecting')),
  attempt_count integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts = 5),
  lease_token uuid,
  lease_expires_at timestamptz,
  failure_code text check (failure_code in (
    'invalid_document', 'limit_exceeded', 'storage_unavailable',
    'ocr_unavailable', 'attempts_exhausted', 'internal_error'
  )),
  source_bucket text not null,
  source_key text not null,
  source_version_id text not null check (
    length(source_version_id) between 1 and 1024 and source_version_id <> 'null'
  ),
  source_checksum_sha256 text not null
    check (source_checksum_sha256 ~ '^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,

  constraint processing_attempts check (attempt_count between 0 and max_attempts),
  constraint processing_stage check ((status = 'processing') = (stage is not null)),
  constraint processing_failure check ((status = 'failed') = (failure_code is not null)),
  constraint processing_finished check (
    (status in ('ready', 'failed', 'cancelled')) = (finished_at is not null)
  ),
  constraint processing_lease check (
    (lease_token is null and lease_expires_at is null) or
    (status = 'processing' and lease_token is not null and lease_expires_at is not null)
  ),
  constraint processing_timestamps check (updated_at >= created_at and finished_at >= created_at)
);

create unique index processing_one_initial_job on caseflow.document_processing_jobs(document_id)
  where previous_job_id is null;
create unique index processing_one_active_job on caseflow.document_processing_jobs(document_id)
  where status in ('queued', 'processing');
create index processing_document_newest on caseflow.document_processing_jobs(document_id, created_at desc, id desc);
create index processing_requester on caseflow.document_processing_jobs(requested_by);
create index processing_expired_leases on caseflow.document_processing_jobs(lease_expires_at, id)
  where lease_expires_at is not null;

create table caseflow.processing_dispatches (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references caseflow.document_processing_jobs(id),
  status text not null default 'pending' check (status in ('pending', 'leased', 'sent')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_failure_code text check (last_failure_code = 'dispatch_unavailable'),
  message_id text check (length(message_id) between 1 and 128 and message_id !~ '[[:cntrl:]]'),
  created_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz,

  constraint dispatch_lease check (
    (status = 'leased' and lease_token is not null and lease_expires_at is not null) or
    (status <> 'leased' and lease_token is null and lease_expires_at is null)
  ),
  constraint dispatch_sent check (
    (status = 'sent' and sent_at is not null and message_id is not null and last_failure_code is null) or
    (status <> 'sent' and sent_at is null and message_id is null)
  ),
  constraint dispatch_timestamps check (sent_at >= created_at)
);

create index dispatch_pending on caseflow.processing_dispatches(available_at, id) where status = 'pending';
create index dispatch_leased on caseflow.processing_dispatches(lease_expires_at, id) where status = 'leased';

alter table caseflow.document_processing_jobs enable row level security;
alter table caseflow.processing_dispatches enable row level security;

create policy read_processing_jobs on caseflow.document_processing_jobs for select to caseflow_runtime
using (exists (select 1 from caseflow.documents d where d.id = document_processing_jobs.document_id));

-- Dispatch credentials are provisioned separately when the queue sender is deployed.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'caseflow_dispatcher') then
    create role caseflow_dispatcher nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end $$;
grant usage on schema caseflow to caseflow_dispatcher;

revoke all on caseflow.document_processing_jobs, caseflow.processing_dispatches
  from public, anon, authenticated, service_role, caseflow_runtime, caseflow_dispatcher;
grant select (id, document_id, requested_by, status, stage, attempt_count, max_attempts,
  failure_code, created_at, updated_at, finished_at)
  on caseflow.document_processing_jobs to caseflow_runtime;

-- Internal only. Callers hold the permission/case/document locks and authorize the actor.
create function caseflow.enqueue_document_processing(p_document uuid, p_actor uuid, p_previous uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  document caseflow.documents;
  job_id uuid;
  queued_at timestamptz := clock_timestamp();
begin
  select * into document from caseflow.documents where id = p_document for update;
  if document.id is null then raise exception 'NOT_FOUND'; end if;
  if document.status <> 'available' or document.checksum_sha256 is null
    or document.object_version_id is null then raise exception 'DOCUMENT_UNAVAILABLE'; end if;

  insert into caseflow.document_processing_jobs(document_id, requested_by, previous_job_id,
    source_bucket, source_key, source_version_id, source_checksum_sha256, created_at, updated_at)
  values (document.id, p_actor, p_previous, document.storage_bucket, document.object_key,
    document.object_version_id, document.checksum_sha256, queued_at, queued_at)
  returning id into job_id;

  insert into caseflow.processing_dispatches(job_id, created_at, available_at)
  values (job_id, queued_at, queued_at);
  insert into caseflow.audit_events(actor_id, target_id, action, after_value)
  values (p_actor, document.id, 'document.processing_queued', jsonb_build_object(
    'caseId', document.case_id, 'jobId', job_id, 'previousJobId', p_previous, 'status', 'queued'));
  return job_id;
end;
$$;

-- The future start/retry endpoint supplies the job the administrator last observed.
create function caseflow.request_document_processing(p_case uuid, p_document uuid, p_expected_job uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  document caseflow.documents;
  latest caseflow.document_processing_jobs;
begin
  perform pg_advisory_xact_lock(734921, 1);
  actor := caseflow.require_actor();
  if actor.role not in ('admin', 'super_admin') then raise exception 'FORBIDDEN'; end if;
  perform caseflow.require_upload_case(p_case);
  document := caseflow.require_document(p_case, p_document);
  if document.status <> 'available' then raise exception 'DOCUMENT_UNAVAILABLE'; end if;

  select * into latest from caseflow.document_processing_jobs
    where document_id = document.id order by created_at desc, id desc limit 1 for update;
  if latest.id is not null then
    if latest.previous_job_id is not distinct from p_expected_job then return latest.id; end if;
    if latest.id is distinct from p_expected_job or latest.status not in ('failed', 'cancelled') then
      raise exception 'PROCESSING_CONFLICT';
    end if;
  elsif p_expected_job is not null then
    raise exception 'PROCESSING_CONFLICT';
  end if;

  return caseflow.enqueue_document_processing(document.id, actor.id, p_expected_job);
end;
$$;

-- Claim/acknowledge in short transactions; send to SQS only after the claim commits.
-- A crash after sending but before acknowledgment can redeliver the same job ID.
create function caseflow.claim_processing_dispatches(p_limit integer)
returns table (dispatch_id uuid, job_id uuid, lease_token uuid, lease_expires_at timestamptz, attempt_count integer)
language plpgsql security definer set search_path = '' as $$
declare claimed_at timestamptz := clock_timestamp();
begin
  if p_limit is null or p_limit not between 1 and 25 then raise exception 'INVALID_INPUT'; end if;
  return query
    with candidates as (
      select d.id from caseflow.processing_dispatches d
      where (d.status = 'pending' and d.available_at <= claimed_at)
        or (d.status = 'leased' and d.lease_expires_at <= claimed_at)
      order by d.available_at, d.id limit p_limit for update skip locked
    )
    update caseflow.processing_dispatches d set status = 'leased',
      lease_token = gen_random_uuid(), lease_expires_at = claimed_at + interval '60 seconds',
      attempt_count = d.attempt_count + 1
    from candidates c where d.id = c.id
    returning d.id, d.job_id, d.lease_token, d.lease_expires_at, d.attempt_count;
end;
$$;

create function caseflow.finish_processing_dispatch(p_dispatch uuid, p_token uuid, p_message_id text)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_dispatch is null or p_token is null or p_message_id is null
    or length(p_message_id) not between 1 and 128 or p_message_id ~ '[[:cntrl:]]' then
    raise exception 'INVALID_INPUT';
  end if;
  update caseflow.processing_dispatches set status = 'sent', message_id = p_message_id,
    sent_at = clock_timestamp(), lease_token = null, lease_expires_at = null, last_failure_code = null
  where id = p_dispatch and status = 'leased' and lease_token = p_token
    and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

create function caseflow.retry_processing_dispatch(p_dispatch uuid, p_token uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_dispatch is null or p_token is null then raise exception 'INVALID_INPUT'; end if;
  update caseflow.processing_dispatches set status = 'pending',
    available_at = clock_timestamp() + interval '30 seconds',
    lease_token = null, lease_expires_at = null, last_failure_code = 'dispatch_unavailable'
  where id = p_dispatch and status = 'leased' and lease_token = p_token
    and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

revoke all on function caseflow.enqueue_document_processing(uuid, uuid, uuid),
  caseflow.request_document_processing(uuid, uuid, uuid),
  caseflow.claim_processing_dispatches(integer),
  caseflow.finish_processing_dispatch(uuid, uuid, text), caseflow.retry_processing_dispatch(uuid, uuid)
  from public, anon, authenticated, service_role, caseflow_runtime, caseflow_dispatcher;
grant execute on function caseflow.request_document_processing(uuid, uuid, uuid) to caseflow_runtime;
grant execute on function caseflow.claim_processing_dispatches(integer),
  caseflow.finish_processing_dispatch(uuid, uuid, text), caseflow.retry_processing_dispatch(uuid, uuid)
  to caseflow_dispatcher;

create or replace function caseflow.complete_document_upload(p_case uuid, p_session uuid, p_object_version text)
returns caseflow.document_upload_sessions
language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  session caseflow.document_upload_sessions;
  document caseflow.documents;
  finished timestamptz;
begin
  session := caseflow.check_document_upload(p_case, p_session);
  if session.status <> 'pending' then return session; end if;
  actor := caseflow.require_actor();
  if p_object_version is null or length(p_object_version) not between 1 and 1024
    or p_object_version = 'null' then raise exception 'INVALID_INPUT'; end if;

  finished := clock_timestamp();
  update caseflow.documents set status = 'available', object_version_id = p_object_version,
    uploaded_at = finished, updated_at = finished, version = version + 1
    where id = session.document_id and status = 'pending_upload' returning * into document;
  if not found then raise exception 'UPLOAD_CONFLICT'; end if;
  update caseflow.document_upload_sessions set status = 'completed', finished_at = finished
    where id = session.id returning * into session;
  insert into caseflow.audit_events(actor_id, target_id, action, before_value, after_value)
  values (actor.id, document.id, 'document.uploaded', jsonb_build_object('status', 'pending_upload'),
    jsonb_build_object('caseId', p_case, 'sessionId', session.id, 'status', document.status,
      'filename', document.filename, 'contentType', document.content_type,
      'sizeBytes', document.size_bytes, 'version', document.version));
  perform caseflow.enqueue_document_processing(document.id, actor.id, null);
  return session;
end;
$$;

