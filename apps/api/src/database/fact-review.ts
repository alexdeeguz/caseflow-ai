import type { PoolClient } from 'pg';
import {
  ErrorCode,
  reviewedFactSchema,
  reviewedFactPageSchema,
  factReviewHistorySchema,
  type FactReviewAction,
} from '@caseflow/schemas';
import { AppError } from '../errors.js';
import { factEvidenceProjection } from './fact-projections.js';

const factProjection = `r.values || jsonb_build_object(
  'id', f.id, 'extractionJobId', f.extraction_job_id,
  'original', caseflow.fact_original_values(f),
  'reviewStatus', r.status, 'version', r.version,
  'corrected', r.values <> caseflow.fact_original_values(f),
  'reviewedBy', r.reviewed_by,
  'reviewedAt', to_char(r.reviewed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'evidence', ${factEvidenceProjection}
)`;

export async function getReviewedFact(client: PoolClient, input: Record<string, unknown>) {
  const result = await client.query(
    `select ${factProjection} as fact from caseflow.extracted_facts f
     join caseflow.fact_reviews r on r.fact_id=f.id
     join caseflow.fact_extraction_jobs j on j.id=f.extraction_job_id
     join caseflow.documents d on d.id=j.document_id
     where d.case_id=$1 and d.id=$2 and f.id=$3`,
    [input.caseId, input.documentId, input.factId],
  );
  if (!result.rows[0]) {
    throw new AppError(ErrorCode.NotFound, 404, 'Fact not found.');
  }

  return reviewedFactSchema.parse(result.rows[0].fact);
}

export async function listReviewedFacts(client: PoolClient, input: Record<string, unknown>) {
  const page = Number(input.page ?? 1);
  const pageSize = Number(input.pageSize ?? 25);
  const result = await client.query(
    `with document as materialized (
      select id,status from caseflow.documents where case_id=$1 and id=$2
    ), visible as materialized (
      select f.id, r.status, r.values->>'category' as category from caseflow.extracted_facts f
      join caseflow.fact_reviews r on r.fact_id=f.id
      join caseflow.fact_extraction_jobs j on j.id=f.extraction_job_id
      join document d on d.id=j.document_id
      where d.status='available' and j.status='completed'
        and ($3::text is null or r.values->>'category'=$3)
    ), matching as materialized (
      select * from visible where $4::text is null or status=$4
    ), paged as (
      select * from matching order by category,id limit $5 offset $6
    ) select (select status from document) as status,
      (select count(*)::int from matching) as total,
      (select jsonb_build_object(
        'unreviewed', count(*) filter(where status='unreviewed'),
        'approved', count(*) filter(where status='approved'),
        'rejected', count(*) filter(where status='rejected')) from visible) as counts,
      coalesce((select jsonb_agg(${factProjection} order by p.category,p.id)
        from paged p join caseflow.extracted_facts f on f.id=p.id
        join caseflow.fact_reviews r on r.fact_id=f.id), '[]'::jsonb) as items`,
    [
      input.caseId,
      input.documentId,
      input.category ?? null,
      input.reviewStatus ?? null,
      pageSize,
      (page - 1) * pageSize,
    ],
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

  return reviewedFactPageSchema.parse({
    items: row.items,
    total: row.total,
    counts: row.counts,
    page,
    pageSize,
  });
}

export async function reviewFact(
  client: PoolClient,
  input: Record<string, unknown>,
  action: FactReviewAction,
) {
  await client.query('select caseflow.review_fact($1,$2,$3,$4,$5,$6,$7)', [
    input.caseId,
    input.documentId,
    input.factId,
    action,
    input.expectedVersion,
    input.values ? JSON.stringify(input.values) : null,
    input.reason ?? null,
  ]);

  return getReviewedFact(client, input);
}

export async function listFactReviewHistory(client: PoolClient, input: Record<string, unknown>) {
  const page = Number(input.page ?? 1);
  const pageSize = Number(input.pageSize ?? 25);
  const result = await client.query(
    `with fact as materialized (
      select f.id from caseflow.extracted_facts f
      join caseflow.fact_extraction_jobs j on j.id=f.extraction_job_id
      join caseflow.documents d on d.id=j.document_id
      where f.id=$3 and d.case_id=$1 and d.id=$2
    ), revisions as materialized (
      select h.* from caseflow.fact_review_revisions h join fact f on f.id=h.fact_id
    ), paged as (select * from revisions order by version desc limit $4 offset $5)
    select exists(select 1 from fact) as visible,
      (select count(*)::int from revisions) as total,
      coalesce((select jsonb_agg(jsonb_build_object(
        'version', version, 'action', action, 'status', status, 'values', values,
        'reason', reason, 'actorId', actor_id,
        'createdAt', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by version desc) from paged), '[]'::jsonb) as items`,
    [input.caseId, input.documentId, input.factId, pageSize, (page - 1) * pageSize],
  );
  const row = result.rows[0]!;
  if (!row.visible) {
    throw new AppError(ErrorCode.NotFound, 404, 'Fact not found.');
  }

  return factReviewHistorySchema.parse({ items: row.items, total: row.total, page, pageSize });
}
