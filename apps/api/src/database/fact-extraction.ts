import type { PoolClient } from 'pg';
import {
  ErrorCode,
  factExtractionSummarySchema,
  type FactExtractionSummary,
} from '@caseflow/schemas';
import { AppError } from '../errors.js';

export const factExtractionJoin = `left join lateral (
  select jsonb_build_object('id', j.id, 'documentId', j.document_id,
    'processingResultId', j.processing_result_id, 'status', j.status,
    'failureCode', j.failure_code, 'chunkCount', j.chunk_count,
    'completedChunks', j.completed_chunks, 'factCount', j.fact_count,
    'createdAt', j.created_at, 'updatedAt', j.updated_at, 'finishedAt', j.finished_at) as job
  from caseflow.fact_extraction_jobs j where j.document_id = d.id
  order by j.created_at desc, j.id desc limit 1
) extraction on true`;

export function serializeFactExtraction(job: FactExtractionSummary['job']): FactExtractionSummary {
  if (job) {
    job = {
      ...job,
      createdAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    };
  }
  return factExtractionSummarySchema.parse({ status: job?.status ?? 'not_extracted', job });
}

export async function getFactExtraction(client: PoolClient, input: Record<string, unknown>) {
  const result = await client.query<{ job: FactExtractionSummary['job']; status: string }>(
    `select extraction.job, d.status from caseflow.documents d ${factExtractionJoin}
     where d.case_id=$1 and d.id=$2`,
    [input.caseId, input.documentId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError(ErrorCode.NotFound, 404, 'Document not found.');
  }
  if (row.status === 'pending_upload') {
    throw new AppError(ErrorCode.DocumentUnavailable, 409, 'Document is not available.');
  }
  return serializeFactExtraction(row.job);
}

export async function requestFactExtraction(client: PoolClient, input: Record<string, unknown>) {
  await client.query('select caseflow.request_fact_extraction($1,$2,$3)', [
    input.caseId,
    input.documentId,
    input.expectedJobId,
  ]);
  return getFactExtraction(client, input);
}
