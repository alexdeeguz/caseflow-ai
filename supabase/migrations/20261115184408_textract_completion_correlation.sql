create or replace function caseflow.claim_document_collection(p_job uuid, p_textract_job text)
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
  -- A terminal status alone does not establish ownership of an incoming provider receipt.
  if job.textract_job_id is null then
    if job.ocr_request is null or job.status in ('ready', 'failed', 'cancelled') then
      raise exception 'PROCESSING_CONFLICT';
    end if;
    return caseflow.processing_claim_payload(p_job, 'awaiting_binding');
  end if;
  if job.textract_job_id <> p_textract_job then raise exception 'PROCESSING_CONFLICT'; end if;
  if job.status in ('ready', 'failed', 'cancelled') then
    return caseflow.processing_claim_payload(p_job, 'terminal');
  end if;
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

revoke all on function caseflow.claim_document_collection(uuid, text)
  from public, anon, authenticated, service_role, caseflow_runtime, caseflow_dispatcher;

grant execute on function caseflow.claim_document_collection(uuid, text) to caseflow_processor;
