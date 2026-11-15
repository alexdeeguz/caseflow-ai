alter table caseflow.audit_events add column service_name text;
alter table caseflow.audit_events drop constraint audit_events_check;
alter table caseflow.audit_events add constraint audit_actor check (
  ((actor_id is not null or operator_name is not null) and service_name is null)
  or (actor_id is null and operator_name is null and service_name is not null
    and service_name = 'document_processor')
);

alter table caseflow.document_processing_jobs
  add column pipeline_version text not null default '1' check (pipeline_version = '1'),
  add column collection_attempt_count integer not null default 0
    check (collection_attempt_count between 0 and 5),
  add column ocr_request jsonb,
  add column ocr_requested_at timestamptz,
  add column ocr_page_count integer check (ocr_page_count between 1 and 20),
  add column textract_job_id text unique
    check (textract_job_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  add column textract_started_at timestamptz,
  add constraint processing_ocr_request check (
    (ocr_request is null and ocr_requested_at is null and ocr_page_count is null)
    or (ocr_request is not null and jsonb_typeof(ocr_request) = 'object'
      and ocr_requested_at is not null and ocr_page_count is not null)
  ),
  add constraint processing_textract_job check (
    (textract_job_id is null and textract_started_at is null)
    or (textract_job_id is not null and textract_started_at is not null and ocr_request is not null)
  ),
  add constraint processing_ocr_stage check (
    stage not in ('waiting_for_ocr', 'collecting') or textract_job_id is not null
  );

alter table caseflow.document_processing_jobs
  drop constraint document_processing_jobs_failure_code_check;
alter table caseflow.document_processing_jobs add constraint processing_failure_code check (
  failure_code in ('invalid_document', 'limit_exceeded', 'storage_unavailable',
    'ocr_unavailable', 'attempts_exhausted', 'internal_error',
    'ocr_budget_exceeded', 'ocr_incomplete', 'ocr_results_expired')
);

create index processing_waiting_ocr on caseflow.document_processing_jobs(textract_started_at, id)
  where status = 'processing' and stage = 'waiting_for_ocr';
create index processing_queued_progress on caseflow.document_processing_jobs(updated_at, id)
  where status = 'queued';

create table caseflow.processing_ocr_days (
  day date primary key,
  pages_reserved integer not null default 0 check (pages_reserved between 0 and 100)
);

create table caseflow.processing_ocr_reservations (
  job_id uuid primary key references caseflow.document_processing_jobs(id),
  day date not null references caseflow.processing_ocr_days(day),
  page_count integer not null check (page_count between 1 and 20),
  reserved_at timestamptz not null default clock_timestamp()
);
create index processing_ocr_reservation_day on caseflow.processing_ocr_reservations(day, job_id);

create table caseflow.document_processing_results (
  job_id uuid primary key references caseflow.document_processing_jobs(id),
  pipeline_version text not null check (pipeline_version = '1'),
  extraction_method text not null check (extraction_method in ('native', 'ocr')),
  page_count integer not null check (page_count between 1 and 20),
  artifact_set_id uuid not null unique,
  storage_bucket text not null,
  artifacts jsonb not null check (jsonb_typeof(artifacts) = 'object'),
  created_at timestamptz not null default clock_timestamp()
);

alter table caseflow.processing_ocr_days enable row level security;
alter table caseflow.processing_ocr_reservations enable row level security;
alter table caseflow.document_processing_results enable row level security;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'caseflow_processor') then
    create role caseflow_processor nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end $$;
grant usage on schema caseflow to caseflow_processor;
revoke all on caseflow.processing_ocr_days, caseflow.processing_ocr_reservations,
  caseflow.document_processing_results
  from public, anon, authenticated, service_role, caseflow_runtime,
    caseflow_dispatcher, caseflow_processor;
revoke all on all tables in schema caseflow from caseflow_processor;
revoke all on all sequences in schema caseflow from caseflow_processor;

-- Internal transitions share the caller's locks and transaction, including their audit record.
create function caseflow.end_processing_job(p_job uuid, p_status text, p_failure text)
returns caseflow.document_processing_jobs
language plpgsql security definer set search_path = '' as $$
declare
  previous caseflow.document_processing_jobs;
  changed caseflow.document_processing_jobs;
  changed_at timestamptz := clock_timestamp();
begin
  if p_status is null or p_status not in ('failed', 'cancelled')
    or (p_status = 'failed') <> (p_failure is not null) then
    raise exception 'INVALID_INPUT';
  end if;

  select * into previous from caseflow.document_processing_jobs where id = p_job for update;
  if previous.id is null then raise exception 'NOT_FOUND'; end if;
  if previous.status not in ('queued', 'processing') then return previous; end if;

  update caseflow.document_processing_jobs set status = p_status, stage = null,
    failure_code = p_failure, lease_token = null, lease_expires_at = null,
    updated_at = changed_at, finished_at = changed_at
    where id = p_job returning * into changed;

  insert into caseflow.audit_events(service_name, target_id, action, before_value, after_value)
  select 'document_processor', changed.document_id, 'document.processing_' || p_status,
    jsonb_build_object('jobId', p_job, 'status', previous.status, 'stage', previous.stage),
    jsonb_build_object('caseId', d.case_id, 'jobId', p_job, 'status', changed.status,
      'failureCode', changed.failure_code, 'attemptCount', changed.attempt_count,
      'collectionAttemptCount', changed.collection_attempt_count)
  from caseflow.documents d where d.id = changed.document_id;
  return changed;
end;
$$;

-- All processor entry points take the same lock order as administrative mutations.
create function caseflow.lock_processing_job(p_job uuid)
returns caseflow.document_processing_jobs
language plpgsql security definer set search_path = '' as $$
declare
  job caseflow.document_processing_jobs;
  document caseflow.documents;
  target_case caseflow.cases;
begin
  if p_job is null then raise exception 'INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(734921, 1);

  select c.* into target_case from caseflow.cases c
    join caseflow.documents d on d.case_id = c.id
    join caseflow.document_processing_jobs j on j.document_id = d.id
    where j.id = p_job for update of c;
  if target_case.id is null then raise exception 'NOT_FOUND'; end if;

  select d.* into document from caseflow.documents d
    join caseflow.document_processing_jobs j on j.document_id = d.id
    where j.id = p_job for update of d;
  select * into job from caseflow.document_processing_jobs where id = p_job for update;

  if job.status in ('queued', 'processing') then
    if target_case.archived_at is not null or document.status <> 'available' then
      return caseflow.end_processing_job(p_job, 'cancelled', null);
    end if;
    if job.source_bucket is distinct from document.storage_bucket
      or job.source_key is distinct from document.object_key
      or job.source_version_id is distinct from document.object_version_id
      or job.source_checksum_sha256 is distinct from document.checksum_sha256 then
      return caseflow.end_processing_job(p_job, 'failed', 'invalid_document');
    end if;
  end if;
  return job;
end;
$$;

create function caseflow.processing_claim_payload(p_job uuid, p_outcome text)
returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object('outcome', p_outcome, 'jobId', j.id, 'status', j.status,
    'stage', j.stage, 'failureCode', j.failure_code) ||
    case when p_outcome = 'claimed' then jsonb_build_object(
      'leaseToken', j.lease_token, 'leaseExpiresAt', j.lease_expires_at,
      'pipelineVersion', j.pipeline_version, 'attemptCount', j.attempt_count,
      'collectionAttemptCount', j.collection_attempt_count,
      'documentId', d.id, 'caseId', d.case_id, 'contentType', d.content_type,
      'sizeBytes', d.size_bytes, 'sourceBucket', j.source_bucket, 'sourceKey', j.source_key,
      'sourceVersionId', j.source_version_id, 'sourceChecksumSha256', j.source_checksum_sha256,
      'ocrRequest', j.ocr_request, 'ocrRequestedAt', j.ocr_requested_at,
      'textractJobId', j.textract_job_id,
      'artifactPrefix', d.storage_environment || '/cases/' || d.case_id::text ||
        '/documents/' || d.id::text || '/processed/' || j.id::text || '/')
    else '{}'::jsonb end
  from caseflow.document_processing_jobs j join caseflow.documents d on d.id = j.document_id
  where j.id = p_job;
$$;

create function caseflow.claim_document_processing(p_job uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  job caseflow.document_processing_jobs;
  claimed_at timestamptz;
begin
  job := caseflow.lock_processing_job(p_job);
  claimed_at := clock_timestamp();
  if job.status in ('ready', 'failed', 'cancelled') then
    return caseflow.processing_claim_payload(p_job, 'terminal');
  end if;
  if job.stage in ('waiting_for_ocr', 'collecting') then
    return caseflow.processing_claim_payload(p_job, 'waiting');
  end if;
  if job.lease_expires_at > claimed_at then
    return caseflow.processing_claim_payload(p_job, 'busy');
  end if;
  if job.ocr_requested_at <= claimed_at - interval '6 days' then
    perform caseflow.end_processing_job(p_job, 'failed', 'ocr_results_expired');
    return caseflow.processing_claim_payload(p_job, 'terminal');
  end if;
  if job.attempt_count >= job.max_attempts then
    perform caseflow.end_processing_job(p_job, 'failed', 'attempts_exhausted');
    return caseflow.processing_claim_payload(p_job, 'terminal');
  end if;

  update caseflow.document_processing_jobs set status = 'processing', stage = 'extracting',
    attempt_count = attempt_count + 1, lease_token = gen_random_uuid(),
    lease_expires_at = claimed_at + interval '180 seconds', updated_at = claimed_at
    where id = p_job;
  return caseflow.processing_claim_payload(p_job, 'claimed');
end;
$$;

create function caseflow.renew_document_processing_lease(p_job uuid, p_token uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare job caseflow.document_processing_jobs;
begin
  if p_token is null then raise exception 'INVALID_INPUT'; end if;
  job := caseflow.lock_processing_job(p_job);
  if job.status <> 'processing' or job.lease_token is distinct from p_token
    or job.lease_expires_at <= clock_timestamp() then return false; end if;

  update caseflow.document_processing_jobs set lease_expires_at = clock_timestamp() + interval '180 seconds'
    where id = p_job;
  return true;
end;
$$;

create function caseflow.prepare_document_ocr(
  p_job uuid, p_token uuid, p_pages integer, p_topic_arn text, p_role_arn text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  job caseflow.document_processing_jobs;
  request jsonb;
  prepared_at timestamptz;
  reservation_day date;
begin
  if p_token is null or p_pages is null or p_pages not between 1 and 20
    or p_topic_arn is null or p_topic_arn !~ '^arn:aws:sns:us-east-2:[0-9]{12}:AmazonTextract-[A-Za-z0-9_-]{1,240}$'
    or p_role_arn is null or length(p_role_arn) > 550
    or p_role_arn !~ '^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9_+=,.@/-]+$'
    or split_part(p_topic_arn, ':', 5) <> split_part(p_role_arn, ':', 5) then
    raise exception 'INVALID_INPUT';
  end if;
  job := caseflow.lock_processing_job(p_job);
  if job.status in ('ready', 'failed', 'cancelled') then
    return caseflow.processing_claim_payload(p_job, 'terminal');
  end if;
  if job.stage <> 'extracting' or job.lease_token is distinct from p_token
    or job.lease_expires_at <= clock_timestamp() then
    return caseflow.processing_claim_payload(p_job, 'stale');
  end if;
  if p_pages <> 1 and exists (
    select 1 from caseflow.documents where id = job.document_id and content_type <> 'application/pdf'
  ) then raise exception 'INVALID_INPUT'; end if;

  request := jsonb_build_object('schemaVersion', 1, 'clientRequestToken', job.id::text,
    'jobTag', job.id::text, 'bucket', job.source_bucket, 'key', job.source_key,
    'versionId', job.source_version_id, 'topicArn', p_topic_arn, 'roleArn', p_role_arn,
    'pageCount', p_pages);
  if job.ocr_requested_at <= clock_timestamp() - interval '6 days' then
    perform caseflow.end_processing_job(p_job, 'failed', 'ocr_results_expired');
    return caseflow.processing_claim_payload(p_job, 'terminal');
  end if;
  if job.ocr_request is not null then
    if job.ocr_request <> request then raise exception 'PROCESSING_CONFLICT'; end if;
    return jsonb_build_object('outcome', 'prepared', 'request', job.ocr_request);
  end if;

  prepared_at := clock_timestamp();
  reservation_day := (prepared_at at time zone 'UTC')::date;
  insert into caseflow.processing_ocr_days(day) values (reservation_day) on conflict do nothing;
  update caseflow.processing_ocr_days set pages_reserved = pages_reserved + p_pages
    where day = reservation_day and pages_reserved + p_pages <= 100;
  if not found then
    perform caseflow.end_processing_job(p_job, 'failed', 'ocr_budget_exceeded');
    return caseflow.processing_claim_payload(p_job, 'terminal');
  end if;

  insert into caseflow.processing_ocr_reservations(job_id, day, page_count, reserved_at)
    values (p_job, reservation_day, p_pages, prepared_at);
  update caseflow.document_processing_jobs set ocr_request = request,
    ocr_requested_at = prepared_at, ocr_page_count = p_pages, updated_at = prepared_at
    where id = p_job;
  return jsonb_build_object('outcome', 'prepared', 'request', request);
end;
$$;

create function caseflow.bind_document_textract_job(p_job uuid, p_token uuid, p_textract_job text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare job caseflow.document_processing_jobs;
begin
  if p_token is null or p_textract_job is null or p_textract_job !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'INVALID_INPUT';
  end if;
  job := caseflow.lock_processing_job(p_job);
  if job.status <> 'processing' or job.stage <> 'extracting'
    or job.lease_token is distinct from p_token or job.lease_expires_at <= clock_timestamp() then
    return false;
  end if;
  if job.ocr_request is null then raise exception 'PROCESSING_CONFLICT'; end if;

  update caseflow.document_processing_jobs set textract_job_id = p_textract_job,
    textract_started_at = clock_timestamp(), stage = 'waiting_for_ocr',
    lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
    where id = p_job;
  return true;
end;
$$;

create function caseflow.claim_document_collection(p_job uuid, p_textract_job text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  job caseflow.document_processing_jobs;
  claimed_at timestamptz;
begin
  if p_textract_job is null or p_textract_job !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'INVALID_INPUT';
  end if;
  job := caseflow.lock_processing_job(p_job);
  claimed_at := clock_timestamp();
  if job.status in ('ready', 'failed', 'cancelled') then
    return caseflow.processing_claim_payload(p_job, 'terminal');
  end if;
  if job.textract_job_id is null then
    return caseflow.processing_claim_payload(p_job, 'awaiting_binding');
  end if;
  if job.textract_job_id <> p_textract_job then raise exception 'PROCESSING_CONFLICT'; end if;
  if job.lease_expires_at > claimed_at then
    return caseflow.processing_claim_payload(p_job, 'busy');
  end if;
  if job.ocr_requested_at <= claimed_at - interval '6 days' then
    perform caseflow.end_processing_job(p_job, 'failed', 'ocr_results_expired');
    return caseflow.processing_claim_payload(p_job, 'terminal');
  end if;
  if job.collection_attempt_count >= job.max_attempts then
    perform caseflow.end_processing_job(p_job, 'failed', 'attempts_exhausted');
    return caseflow.processing_claim_payload(p_job, 'terminal');
  end if;

  update caseflow.document_processing_jobs set stage = 'collecting',
    collection_attempt_count = collection_attempt_count + 1,
    lease_token = gen_random_uuid(), lease_expires_at = claimed_at + interval '180 seconds',
    updated_at = claimed_at where id = p_job;
  return caseflow.processing_claim_payload(p_job, 'claimed');
end;
$$;

create function caseflow.fail_document_processing(p_job uuid, p_token uuid, p_failure text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare job caseflow.document_processing_jobs;
begin
  if p_token is null or p_failure is null or p_failure not in (
    'invalid_document', 'limit_exceeded', 'storage_unavailable', 'ocr_unavailable',
    'internal_error', 'ocr_incomplete', 'ocr_results_expired'
  ) then raise exception 'INVALID_INPUT'; end if;

  job := caseflow.lock_processing_job(p_job);
  if job.status <> 'processing' or job.lease_token is distinct from p_token
    or job.lease_expires_at <= clock_timestamp() then return false; end if;
  perform caseflow.end_processing_job(p_job, 'failed', p_failure);
  return true;
end;
$$;

create function caseflow.complete_document_processing(
  p_job uuid, p_token uuid, p_method text, p_pages integer, p_artifact_set uuid, p_artifacts jsonb
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  job caseflow.document_processing_jobs;
  document caseflow.documents;
  artifact record;
  artifact_names text[];
  artifact_prefix text;
  saved_artifacts jsonb := '{}'::jsonb;
  total_bytes bigint := 0;
  finished timestamptz;
begin
  if p_token is null or p_method is null or p_method not in ('native', 'ocr')
    or p_pages is null or p_pages not between 1 and 20 or p_artifact_set is null
    or p_artifacts is null or jsonb_typeof(p_artifacts) <> 'object' then
    raise exception 'INVALID_INPUT';
  end if;
  job := caseflow.lock_processing_job(p_job);
  if job.status <> 'processing' or job.lease_token is distinct from p_token
    or job.lease_expires_at <= clock_timestamp() then return false; end if;

  select * into document from caseflow.documents where id = job.document_id;
  if (p_method = 'native' and (job.stage <> 'extracting' or job.ocr_request is not null
      or document.content_type <> 'application/pdf'))
    or (p_method = 'ocr' and (job.stage <> 'collecting' or p_pages <> job.ocr_page_count)) then
    raise exception 'PROCESSING_CONFLICT';
  end if;

  select array_agg(key order by key) into artifact_names from jsonb_object_keys(p_artifacts) key;
  if artifact_names is distinct from (case when p_method = 'ocr'
    then array['manifest', 'ocr', 'text'] else array['manifest', 'text'] end) then
    raise exception 'INVALID_INPUT';
  end if;
  artifact_prefix := document.storage_environment || '/cases/' || document.case_id::text ||
    '/documents/' || document.id::text || '/processed/' || job.id::text || '/' || p_artifact_set::text || '/';

  for artifact in select key, value from jsonb_each(p_artifacts) loop
    if jsonb_typeof(artifact.value) <> 'object' then raise exception 'INVALID_INPUT'; end if;
    if (select array_agg(key order by key) from jsonb_object_keys(artifact.value) key)
      is distinct from array['checksumSha256', 'sizeBytes', 'versionId'] then
      raise exception 'INVALID_INPUT';
    end if;
    if jsonb_typeof(artifact.value->'versionId') is distinct from 'string'
      or length(artifact.value->>'versionId') not between 1 and 1024
      or artifact.value->>'versionId' = 'null' or artifact.value->>'versionId' ~ '[[:cntrl:]]'
      or jsonb_typeof(artifact.value->'checksumSha256') is distinct from 'string'
      or artifact.value->>'checksumSha256' !~ '^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$'
      or jsonb_typeof(artifact.value->'sizeBytes') is distinct from 'number'
      or artifact.value->>'sizeBytes' !~ '^[1-9][0-9]{0,7}$' then
      raise exception 'INVALID_INPUT';
    end if;
    total_bytes := total_bytes + (artifact.value->>'sizeBytes')::bigint;
    saved_artifacts := saved_artifacts || jsonb_build_object(artifact.key,
      artifact.value || jsonb_build_object('key', artifact_prefix || artifact.key || '.json'));
  end loop;
  if total_bytes > 52428800 then raise exception 'INVALID_INPUT'; end if;

  finished := clock_timestamp();
  insert into caseflow.document_processing_results(job_id, pipeline_version, extraction_method,
    page_count, artifact_set_id, storage_bucket, artifacts, created_at)
  values (job.id, job.pipeline_version, p_method, p_pages, p_artifact_set,
    job.source_bucket, saved_artifacts, finished);

  update caseflow.document_processing_jobs set status = 'ready', stage = null,
    lease_token = null, lease_expires_at = null, updated_at = finished, finished_at = finished
    where id = job.id;
  insert into caseflow.audit_events(service_name, target_id, action, before_value, after_value)
  values ('document_processor', job.document_id, 'document.processing_completed',
    jsonb_build_object('jobId', job.id, 'status', job.status, 'stage', job.stage),
    jsonb_build_object('caseId', document.case_id, 'jobId', job.id, 'status', 'ready',
      'extractionMethod', p_method, 'pageCount', p_pages, 'pipelineVersion', job.pipeline_version));
  return true;
end;
$$;

-- Called only by administrative functions already holding the case and document locks.
create function caseflow.cancel_document_processing_jobs(p_document uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare job_id uuid;
begin
  for job_id in select id from caseflow.document_processing_jobs
    where document_id = p_document and status in ('queued', 'processing') order by id for update
  loop
    perform caseflow.end_processing_job(job_id, 'cancelled', null);
  end loop;
end;
$$;

revoke all on function caseflow.end_processing_job(uuid, text, text),
  caseflow.lock_processing_job(uuid), caseflow.processing_claim_payload(uuid, text),
  caseflow.claim_document_processing(uuid), caseflow.renew_document_processing_lease(uuid, uuid),
  caseflow.prepare_document_ocr(uuid, uuid, integer, text, text),
  caseflow.bind_document_textract_job(uuid, uuid, text), caseflow.claim_document_collection(uuid, text),
  caseflow.fail_document_processing(uuid, uuid, text),
  caseflow.complete_document_processing(uuid, uuid, text, integer, uuid, jsonb),
  caseflow.cancel_document_processing_jobs(uuid)
  from public, anon, authenticated, service_role, caseflow_runtime, caseflow_dispatcher, caseflow_processor;

grant execute on function caseflow.claim_document_processing(uuid),
  caseflow.renew_document_processing_lease(uuid, uuid),
  caseflow.prepare_document_ocr(uuid, uuid, integer, text, text),
  caseflow.bind_document_textract_job(uuid, uuid, text), caseflow.claim_document_collection(uuid, text),
  caseflow.fail_document_processing(uuid, uuid, text),
  caseflow.complete_document_processing(uuid, uuid, text, integer, uuid, jsonb)
  to caseflow_processor;


create or replace function caseflow.set_document_removed(
  p_case uuid, p_document uuid, p_expected_version integer, p_removed boolean
) returns caseflow.documents
language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  previous caseflow.documents;
  changed caseflow.documents;
  changed_at timestamptz;
begin
  perform pg_advisory_xact_lock(734921, 1);
  actor := caseflow.require_actor();
  if actor.role not in ('admin', 'super_admin') then
    raise exception 'FORBIDDEN';
  end if;
  if p_expected_version is null or p_expected_version < 1 or p_removed is null then
    raise exception 'INVALID_INPUT';
  end if;

  previous := caseflow.require_document(p_case, p_document);
  if exists(select 1 from caseflow.cases where id = p_case and archived_at is not null) then
    raise exception 'CASE_ARCHIVED';
  end if;
  if previous.version <> p_expected_version then
    raise exception 'DOCUMENT_CONFLICT';
  end if;
  if previous.status = 'pending_upload' then
    raise exception 'DOCUMENT_UNAVAILABLE';
  end if;
  if (previous.status = 'removed') = p_removed then
    return previous;
  end if;

  changed_at := clock_timestamp();
  update caseflow.documents set
    status = case when p_removed then 'removed' else 'available' end,
    removed_at = case when p_removed then changed_at else null end,
    removed_by = case when p_removed then actor.id else null end,
    version = previous.version + 1,
    updated_at = changed_at
  where id = previous.id returning * into changed;

  insert into caseflow.audit_events(actor_id, target_id, action, before_value, after_value)
  values (actor.id, changed.id, case when p_removed then 'document.removed' else 'document.restored' end,
    jsonb_build_object('caseId', previous.case_id, 'status', previous.status,
      'removedAt', previous.removed_at, 'removedBy', previous.removed_by, 'version', previous.version),
    jsonb_build_object('caseId', changed.case_id, 'status', changed.status,
      'removedAt', changed.removed_at, 'removedBy', changed.removed_by, 'version', changed.version));

  if p_removed then
    perform caseflow.cancel_document_processing_jobs(changed.id);
  end if;

  return changed;
end;
$$;


create or replace function caseflow.set_case_archived(p_id uuid, p_expected_version integer, p_archived boolean)
returns caseflow.cases
language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  previous caseflow.cases;
  changed caseflow.cases;
  document_id uuid;
begin
  perform pg_advisory_xact_lock(734921, 1);
  actor := caseflow.require_actor();
  if actor.role not in ('admin', 'super_admin') then
    raise exception 'FORBIDDEN';
  end if;
  if p_expected_version is null or p_expected_version < 1 or p_archived is null then
    raise exception 'INVALID_INPUT';
  end if;

  select * into previous from caseflow.cases where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;
  if previous.version <> p_expected_version then
    raise exception 'CASE_CONFLICT';
  end if;
  if (previous.archived_at is not null) = p_archived then
    return previous;
  end if;

  update caseflow.cases set
    archived_at = case when p_archived then clock_timestamp() else null end,
    archived_by = case when p_archived then actor.id else null end,
    version = previous.version + 1, updated_at = clock_timestamp()
    where id = p_id returning * into changed;
  insert into caseflow.audit_events(actor_id, target_id, action, before_value, after_value)
    values (actor.id, p_id, case when p_archived then 'case.archived' else 'case.restored' end,
      jsonb_build_object('archivedAt', previous.archived_at, 'archivedBy', previous.archived_by,
        'version', previous.version),
      jsonb_build_object('archivedAt', changed.archived_at, 'archivedBy', changed.archived_by,
        'version', changed.version));
  if p_archived then
    for document_id in select id from caseflow.documents
      where case_id = p_id order by id for update
    loop
      perform caseflow.cancel_document_processing_jobs(document_id);
    end loop;
  end if;

  return changed;
end;
$$;
