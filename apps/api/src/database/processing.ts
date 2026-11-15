import type { PoolClient } from 'pg';
import {
  DocumentStatus,
  ErrorCode,
  ProcessingStatus,
  processingSummarySchema,
  type ProcessingJob,
  type ProcessingResultSummary,
  type ProcessingSummary,
} from '@caseflow/schemas';
import { AppError } from '../errors.js';

export type ProcessingRecord = {
  job: ProcessingJob | null;
  result: ProcessingResultSummary | null;
};

// Join against a visible document aliased as d. Only public columns are selectable by runtime.
export const processingSummaryJoin = `left join lateral (
  select jsonb_build_object(
    'id', j.id, 'documentId', j.document_id, 'requestedBy', j.requested_by,
    'status', j.status, 'stage', j.stage, 'attemptCount', j.attempt_count,
    'maxAttempts', j.max_attempts, 'failureCode', j.failure_code,
    'createdAt', j.created_at, 'updatedAt', j.updated_at, 'finishedAt', j.finished_at
  ) as job,
  case when r.job_id is not null then jsonb_build_object(
    'extractionMethod', r.extraction_method, 'pageCount', r.page_count,
    'pipelineVersion', r.pipeline_version
  ) end as result
  from (
    select id, document_id, requested_by, status, stage, attempt_count, max_attempts,
      failure_code, created_at, updated_at, finished_at
    from caseflow.document_processing_jobs where document_id = d.id
    order by created_at desc, id desc limit 1
  ) j
  left join caseflow.document_processing_results r on r.job_id = j.id and j.status = 'ready'
) processing on true`;

export function serializeProcessing(record: ProcessingRecord): ProcessingSummary {
  const job = record.job ? { ...record.job } : null;

  if (job) {
    for (const field of ['createdAt', 'updatedAt', 'finishedAt'] as const) {
      const value = job[field];

      if (value !== null) {
        job[field] = new Date(value).toISOString();
      }
    }
  }

  return processingSummarySchema.parse({
    status: job?.status ?? ProcessingStatus.NotProcessed,
    job,
    result: record.result,
  });
}

export async function getDocumentProcessing(client: PoolClient, input: Record<string, unknown>) {
  const result = await client.query<ProcessingRecord & { documentStatus: DocumentStatus }>(
    `select d.status as "documentStatus", processing.job, processing.result
     from caseflow.documents d ${processingSummaryJoin}
     where d.case_id = $1 and d.id = $2`,
    [input.caseId, input.documentId],
  );
  const record = result.rows[0];

  if (!record) {
    throw new AppError(ErrorCode.NotFound, 404, 'Document not found.');
  }

  if (record.documentStatus === DocumentStatus.PendingUpload) {
    throw new AppError(
      ErrorCode.DocumentUnavailable,
      409,
      'This document is not available for processing.',
    );
  }

  return serializeProcessing(record);
}

export async function requestDocumentProcessing(
  client: PoolClient,
  input: Record<string, unknown>,
) {
  // The function retains the permission and document locks through the response query.
  await client.query('select caseflow.request_document_processing($1, $2, $3)', [
    input.caseId,
    input.documentId,
    input.expectedJobId,
  ]);

  return getDocumentProcessing(client, input);
}
