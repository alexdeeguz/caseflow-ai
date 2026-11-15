alter table caseflow.document_processing_jobs
  add column recovery_count integer not null default 0 check (recovery_count between 0 and 3),
  add column recovery_check_count integer not null default 0 check (recovery_check_count >= 0),
  add column recovery_next_check_at timestamptz not null default (clock_timestamp() + interval '15 minutes');

create index processing_recovery_due on caseflow.document_processing_jobs(recovery_next_check_at, id)
  where status in ('queued', 'processing');
create index processing_ocr_expiry on caseflow.document_processing_jobs(ocr_requested_at, id)
  where status = 'processing' and ocr_requested_at is not null;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'caseflow_recovery') then
    create role caseflow_recovery nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end $$;
grant usage on schema caseflow to caseflow_recovery;
revoke all on all tables in schema caseflow from caseflow_recovery;
revoke all on all sequences in schema caseflow from caseflow_recovery;

-- Internal, operator-only entry point. Both scheduled and targeted recovery share these checks.
create function caseflow.recover_processing_job(p_job uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  job caseflow.document_processing_jobs;
  dispatch caseflow.processing_dispatches;
  checked_at timestamptz;
begin
  job := caseflow.lock_processing_job(p_job);
  checked_at := clock_timestamp();
  update caseflow.document_processing_jobs set recovery_check_count = recovery_check_count + 1,
    recovery_next_check_at = checked_at + interval '15 minutes' where id = job.id;
  if job.status in ('ready', 'failed', 'cancelled') then
    return jsonb_build_object('outcome', 'terminal', 'jobId', job.id);
  end if;
  if job.ocr_requested_at <= checked_at - interval '6 days' then
    perform caseflow.end_processing_job(job.id, 'failed', 'ocr_results_expired');
    return jsonb_build_object('outcome', 'terminal', 'jobId', job.id);
  end if;
  if job.lease_expires_at > checked_at then
    return jsonb_build_object('outcome', 'deferred', 'jobId', job.id);
  end if;

  if job.textract_job_id is not null then
    if job.collection_attempt_count >= job.max_attempts then
      perform caseflow.end_processing_job(job.id, 'failed', 'attempts_exhausted');
      return jsonb_build_object('outcome', 'terminal', 'jobId', job.id);
    end if;
    if job.updated_at > checked_at - interval '15 minutes' then
      return jsonb_build_object('outcome', 'deferred', 'jobId', job.id);
    end if;
    return jsonb_build_object('outcome', 'inspect', 'jobId', job.id,
      'providerId', job.textract_job_id);
  end if;

  select * into dispatch from caseflow.processing_dispatches where job_id = job.id for update;
  -- Pending sends belong to the dispatcher. Never race an active send or erase its token.
  if dispatch.status <> 'sent' or dispatch.sent_at > checked_at - interval '15 minutes' then
    return jsonb_build_object('outcome', 'deferred', 'jobId', job.id);
  end if;
  if job.recovery_count >= 3 or job.attempt_count >= job.max_attempts then
    perform caseflow.end_processing_job(job.id, 'failed', 'attempts_exhausted');
    return jsonb_build_object('outcome', 'terminal', 'jobId', job.id);
  end if;

  update caseflow.document_processing_jobs set status = 'queued', stage = null,
    lease_token = null, lease_expires_at = null, recovery_count = recovery_count + 1,
    updated_at = checked_at where id = job.id;
  update caseflow.processing_dispatches set status = 'pending', available_at = checked_at,
    sent_at = null, message_id = null, last_failure_code = null where id = dispatch.id;
  insert into caseflow.audit_events(service_name, target_id, action, before_value, after_value)
  select 'document_processor', job.document_id, 'document.processing_recovered',
    jsonb_build_object('jobId', job.id, 'status', job.status, 'stage', job.stage,
      'recoveryCount', job.recovery_count),
    jsonb_build_object('caseId', d.case_id, 'jobId', job.id, 'status', 'queued',
      'recoveryCount', job.recovery_count + 1)
    from caseflow.documents d where d.id = job.document_id;
  return jsonb_build_object('outcome', 'redispatched', 'jobId', job.id);
end;
$$;

-- One candidate per transaction bounds lock duration; collection has its own fenced lease.
create function caseflow.reconcile_document_processing(p_bucket text, p_environment text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare candidate uuid;
begin
  if p_bucket is null or length(p_bucket) not between 3 and 63
    or p_environment is null or p_environment !~ '^[a-z][a-z0-9-]{0,31}$' then
    raise exception 'INVALID_INPUT';
  end if;
  perform pg_advisory_xact_lock(734921, 1);
  select j.id into candidate from caseflow.document_processing_jobs j
    join caseflow.documents d on d.id = j.document_id
    where j.status in ('queued', 'processing')
      and j.source_bucket = p_bucket and d.storage_environment = p_environment
      and (j.recovery_next_check_at <= clock_timestamp()
        or j.ocr_requested_at <= clock_timestamp() - interval '6 days')
    order by j.recovery_next_check_at, j.id limit 1;
  if candidate is null then return null; end if;
  return caseflow.recover_processing_job(candidate);
end;
$$;

-- Check current source/case state immediately before a provider status request.
create function caseflow.check_processing_recovery(p_job uuid, p_provider text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare job caseflow.document_processing_jobs;
begin
  if p_provider is null then raise exception 'INVALID_INPUT'; end if;
  job := caseflow.lock_processing_job(p_job);
  if job.status <> 'processing' or job.textract_job_id is distinct from p_provider then return false; end if;
  if job.ocr_requested_at <= clock_timestamp() - interval '6 days' then
    perform caseflow.end_processing_job(job.id, 'failed', 'ocr_results_expired');
    return false;
  end if;
  return job.lease_expires_at is null or job.lease_expires_at <= clock_timestamp();
end;
$$;

create function caseflow.processing_health(p_bucket text, p_environment text)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with jobs as (
    select j.* from caseflow.document_processing_jobs j
      join caseflow.documents d on d.id = j.document_id
      where j.source_bucket = p_bucket and d.storage_environment = p_environment
  ), job_metrics as (
    select count(*) filter (where status = 'ready' and finished_at >= now() - interval '24 hours') as ready,
      count(*) filter (where status = 'failed' and finished_at >= now() - interval '24 hours') as failed,
      count(*) filter (where lease_expires_at <= now() and status = 'processing') as expired,
      coalesce(avg(extract(epoch from (finished_at - created_at))) filter (
        where status = 'ready' and finished_at >= now() - interval '24 hours'), 0) as latency,
      coalesce(sum(attempt_count + collection_attempt_count) filter (
        where created_at >= now() - interval '24 hours'), 0) as attempts,
      count(*) filter (where failure_code = 'attempts_exhausted' and not exists (
        select 1 from caseflow.document_processing_jobs newer where newer.previous_job_id = j.id
      )) as intervention
    from jobs j
  ), dispatch_metrics as (
    select count(*) as backlog,
      coalesce(max(extract(epoch from (now() - d.created_at))), 0) as oldest
    from caseflow.processing_dispatches d join jobs j on j.id = d.job_id
    where d.status <> 'sent' and j.status in ('queued', 'processing')
  )
  select jsonb_build_object('ReadyLast24Hours', j.ready, 'FailedLast24Hours', j.failed,
    'ExpiredLeases', j.expired, 'MeanLatencySeconds', j.latency, 'AttemptsLast24Hours', j.attempts,
    'OperatorIntervention', j.intervention, 'DispatchBacklog', d.backlog,
    'DispatchOldestSeconds', greatest(d.oldest, 0),
    'OcrPagesReserved', coalesce((select pages_reserved from caseflow.processing_ocr_days
      where day = (now() at time zone 'UTC')::date), 0), 'OcrPageAllowance', 100)
  from job_metrics j cross join dispatch_metrics d;
$$;

revoke all on function caseflow.reconcile_document_processing(text, text),
  caseflow.check_processing_recovery(uuid, text), caseflow.processing_health(text, text)
  from public, anon, authenticated, service_role, caseflow_runtime, caseflow_dispatcher, caseflow_processor;
grant execute on function caseflow.reconcile_document_processing(text, text),
  caseflow.check_processing_recovery(uuid, text), caseflow.processing_health(text, text),
  caseflow.claim_document_collection(uuid, text),
  caseflow.renew_document_processing_lease(uuid, uuid),
  caseflow.fail_document_processing(uuid, uuid, text),
  caseflow.complete_document_processing(uuid, uuid, text, integer, uuid, jsonb)
  to caseflow_recovery;

revoke all on function caseflow.recover_processing_job(uuid)
  from public, anon, authenticated, service_role, caseflow_runtime,
    caseflow_dispatcher, caseflow_processor, caseflow_recovery;
