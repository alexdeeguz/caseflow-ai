import type { PoolClient } from 'pg';
import { ErrorCode, searchIndexSummarySchema, type SearchIndexSummary } from '@caseflow/schemas';
import { AppError } from '../errors.js';

/** Latest search indexing job for document `d`, as a summary object (null before indexing). */
export const searchIndexJoin = `left join lateral (
  select jsonb_build_object('status', s.status, 'chunkCount', s.chunk_count,
    'embeddedCount', s.embedded_count) as summary
  from caseflow.search_index_jobs s where s.document_id = d.id
  order by s.created_at desc, s.id desc limit 1
) search_index on true`;

export function serializeSearchIndex(summary: unknown): SearchIndexSummary | null {
  return summary === null || summary === undefined ? null : searchIndexSummarySchema.parse(summary);
}

export async function requestSearchIndex(client: PoolClient, input: Record<string, unknown>) {
  await client.query('select caseflow.request_search_index($1,$2)', [
    input.caseId,
    input.documentId,
  ]);
  const result = await client.query<{ summary: unknown }>(
    `select search_index.summary from caseflow.documents d ${searchIndexJoin}
     where d.case_id = $1 and d.id = $2`,
    [input.caseId, input.documentId],
  );
  const summary = serializeSearchIndex(result.rows[0]?.summary);

  if (!summary) {
    throw new AppError(ErrorCode.NotFound, 404, 'Document not found.');
  }

  return summary;
}
