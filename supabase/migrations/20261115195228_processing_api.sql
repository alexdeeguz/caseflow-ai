-- Public summaries follow the job/document RLS chain; artifact locations remain private.
grant select (job_id, pipeline_version, extraction_method, page_count)
  on caseflow.document_processing_results to caseflow_runtime;

create policy read_processing_result_summaries
  on caseflow.document_processing_results for select to caseflow_runtime
  using (exists (
    select 1 from caseflow.document_processing_jobs j
    where j.id = document_processing_results.job_id and j.status = 'ready'
  ));
