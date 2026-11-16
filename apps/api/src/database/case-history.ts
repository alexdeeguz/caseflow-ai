import type { PoolClient } from 'pg';
import {
  ErrorCode,
  FactCategory,
  caseTimelineSchema,
  caseReviewedSummarySchema,
} from '@caseflow/schemas';
import { AppError } from '../errors.js';
import { factEvidenceProjection } from './fact-projections.js';

async function approvedCasePage(
  client: PoolClient,
  input: Record<string, unknown>,
  category: FactCategory,
) {
  const page = Number(input.page ?? 1);
  const pageSize = Number(input.pageSize ?? 25);
  const result = await client.query(
    `with visible_case as materialized (
      select id from caseflow.cases where id=$1
    ), approved as materialized (
      select f.id, f.version, f.values, d.id as document_id, d.filename,
        f.values->>'category' as category
      from visible_case c
      join caseflow.documents d on d.case_id=c.id and d.status='available'
      join caseflow.fact_extraction_jobs j on j.document_id=d.id and j.status='completed'
      join caseflow.approved_facts f on f.extraction_job_id=j.id
    ), matching as materialized (
      select *, case when category='date' then values->>'dateValue'
        else lower(values->>'value') end as sort_value
      from approved where category=$2
    ), paged as (
      select * from matching order by sort_value collate "C", id limit $3 offset $4
    ) select exists(select 1 from visible_case) as visible,
      (select count(*)::int from matching) as total,
      (select count(distinct document_id)::int from approved) as "sourceDocumentCount",
      (select jsonb_build_object(
        'date', count(*) filter(where category='date'),
        'provider', count(*) filter(where category='provider'),
        'treatment', count(*) filter(where category='treatment'),
        'finding', count(*) filter(where category='finding')
      ) from approved) as counts,
      coalesce((select jsonb_agg(f.values || jsonb_build_object(
        'id', f.id, 'version', f.version, 'documentId', f.document_id,
        'filename', f.filename, 'evidence', ${factEvidenceProjection}
      ) order by f.sort_value collate "C", f.id) from paged f), '[]'::jsonb) as items`,
    [input.caseId, category, pageSize, (page - 1) * pageSize],
  );
  const row = result.rows[0]!;
  if (!row.visible) {
    throw new AppError(ErrorCode.NotFound, 404, 'Case not found.');
  }

  return {
    items: row.items,
    total: row.total,
    page,
    pageSize,
    category,
    counts: row.counts,
    sourceDocumentCount: row.sourceDocumentCount,
  };
}

export async function getCaseTimeline(client: PoolClient, input: Record<string, unknown>) {
  const { items, total, page, pageSize } = await approvedCasePage(client, input, FactCategory.Date);
  return caseTimelineSchema.parse({ items, total, page, pageSize });
}

export async function getCaseReviewedSummary(client: PoolClient, input: Record<string, unknown>) {
  const category = caseReviewedSummarySchema.shape.category.parse(
    input.category ?? FactCategory.Date,
  );
  return caseReviewedSummarySchema.parse(await approvedCasePage(client, input, category));
}
