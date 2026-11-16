-- Internal helper; callers hold the shared permission lock and authorize the source.
create function caseflow.enqueue_fact_extraction(
  p_document uuid, p_processing_result uuid, p_requester uuid, p_previous uuid, p_automatic boolean
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
  task uuid;
  target_case uuid;
begin
  select d.case_id into target_case from caseflow.documents d
    join caseflow.document_processing_jobs j on j.document_id = d.id
    join caseflow.document_processing_results r on r.job_id = j.id
    where d.id = p_document and j.id = p_processing_result and j.status = 'ready';
  if target_case is null or p_automatic is null then raise exception 'INVALID_INPUT'; end if;

  insert into caseflow.fact_extraction_jobs(document_id, processing_result_id, requested_by, previous_job_id)
    values(p_document, p_processing_result, p_requester, p_previous) returning id into new_id;
  insert into caseflow.fact_extraction_tasks(job_id, ordinal) values(new_id, 0) returning id into task;
  insert into caseflow.fact_dispatches(task_id) values(task);
  insert into caseflow.audit_events(actor_id, service_name, target_id, action, after_value)
    values(case when p_automatic then null else p_requester end,
      case when p_automatic then 'document_processor' else null end,
      p_document, 'document.facts_queued', jsonb_build_object(
        'caseId', target_case, 'jobId', new_id, 'processingResultId', p_processing_result,
        'trigger', case when p_automatic then 'processing_ready' else 'manual' end));
  return new_id;
end;
$$;

create or replace function caseflow.request_fact_extraction(p_case uuid, p_document uuid, p_expected uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  document caseflow.documents;
  latest caseflow.fact_extraction_jobs;
  processing_id uuid;
begin
  perform pg_advisory_xact_lock(734921, 1);
  actor := caseflow.require_actor();
  if actor.role not in ('admin', 'super_admin') then raise exception 'FORBIDDEN'; end if;
  perform caseflow.require_upload_case(p_case);
  document := caseflow.require_document(p_case, p_document);
  if document.status <> 'available' then raise exception 'DOCUMENT_UNAVAILABLE'; end if;
  select * into latest from caseflow.fact_extraction_jobs where document_id = p_document
    order by created_at desc, id desc limit 1 for update;
  if latest.id is not null then
    if latest.previous_job_id is not distinct from p_expected then return latest.id; end if;
    if latest.id is distinct from p_expected or latest.status not in ('failed', 'cancelled') then
      raise exception 'FACT_EXTRACTION_CONFLICT';
    end if;
  elsif p_expected is not null then raise exception 'FACT_EXTRACTION_CONFLICT';
  end if;
  select r.job_id into processing_id from caseflow.document_processing_results r
    join caseflow.document_processing_jobs j on j.id = r.job_id
    where j.document_id = p_document and j.status = 'ready'
    order by j.created_at desc, j.id desc limit 1;
  if processing_id is null then raise exception 'DOCUMENT_UNAVAILABLE'; end if;
  return caseflow.enqueue_fact_extraction(p_document, processing_id, actor.id, p_expected, false);
end;
$$;

-- Completion, its first extraction task, and both audit records commit together.
create function caseflow.queue_facts_after_processing()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(734921, 1);

  if not exists(select 1 from caseflow.documents d join caseflow.cases c on c.id = d.case_id
      where d.id = new.document_id and d.status = 'available' and c.archived_at is null)
    or exists(select 1 from caseflow.fact_extraction_jobs where document_id = new.document_id) then
    return new;
  end if;

  perform caseflow.enqueue_fact_extraction(new.document_id, new.id, new.requested_by, null, true);
  return new;
end;
$$;

create trigger queue_facts_after_processing
  after update of status on caseflow.document_processing_jobs
  for each row when (new.status = 'ready' and old.status is distinct from new.status)
  execute function caseflow.queue_facts_after_processing();

revoke all on function caseflow.enqueue_fact_extraction(uuid, uuid, uuid, uuid, boolean),
  caseflow.queue_facts_after_processing()
  from public, anon, authenticated, service_role, caseflow_runtime, caseflow_processor,
    caseflow_dispatcher, caseflow_fact_extractor, caseflow_fact_dispatcher, caseflow_recovery;
