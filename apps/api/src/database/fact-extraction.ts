import type { PoolClient } from 'pg';
import {
  ErrorCode,
  factExtractionSummarySchema,
  factPageSchema,
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

export async function listFacts(client: PoolClient, input: Record<string, unknown>) {
  const page = Number(input.page ?? 1);
  const pageSize = Number(input.pageSize ?? 25);
  const result = await client.query(
    `with document as materialized (
    select id,status from caseflow.documents where case_id=$1 and id=$2
  ), matching as materialized (
    select f.* from caseflow.extracted_facts f
    join caseflow.fact_extraction_jobs j on j.id=f.extraction_job_id
    join document d on d.id=j.document_id
    where d.status='available' and j.status='completed' and ($3::text is null or f.category=$3)
  ), paged as (
    select * from matching order by category,id limit $4 offset $5
  ) select (select status from document) as status,
    (select count(*)::int from matching) as total,
    coalesce((select jsonb_agg(jsonb_build_object(
      'id',f.id,'extractionJobId',f.extraction_job_id,'category',f.category,'value',f.value,
      'qualifier',f.qualifier,'dateValue',f.date_value,'datePrecision',f.date_precision,
      'dateMeaning',f.date_meaning,'treatmentStatus',f.treatment_status,
      'findingStatus',f.finding_status,'negated',f.negated,'reviewStatus',f.review_status,
      'evidence',(select jsonb_agg(jsonb_build_object('id',e.id,'documentId',e.document_id,
        'processingResultId',e.processing_result_id,'page',e.page,'quote',e.quote,
        'start',e.start_offset,'end',e.end_offset) order by e.page,e.start_offset,e.id)
        from caseflow.fact_evidence e where e.fact_id=f.id)
    ) order by f.category,f.id) from paged f),'[]'::jsonb) as items`,
    [input.caseId, input.documentId, input.category ?? null, pageSize, (page - 1) * pageSize],
  );
  const row = result.rows[0]!;
  if (!row.status) {
    throw new AppError(ErrorCode.NotFound, 404, 'Document not found.');
  }
  if (row.status !== 'available') {
    throw new AppError(
      ErrorCode.DocumentUnavailable,
      409,
      'Restore this document before viewing its facts.',
    );
  }
  return factPageSchema.parse({ items: row.items, total: row.total, page, pageSize });
}
