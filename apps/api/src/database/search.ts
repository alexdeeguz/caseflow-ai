import type { PoolClient } from 'pg';
import {
  CaseArchiveFilter,
  ErrorCode,
  SearchLimits,
  SearchMode,
  documentSearchPageSchema,
  type DocumentSearchResult,
} from '@caseflow/schemas';
import { AppError } from '../errors.js';

// Candidate pool per ranking method before reciprocal-rank fusion.
const CANDIDATES = 50;
// Standard RRF damping constant: limits how much a single top rank dominates.
const RRF_K = 60;
// Meaning-only matches must be reasonably similar (cosine) and close to the best match. Measured on
// the fictional corpus: unrelated queries stay below 0.13, relevant passages score about 0.39-0.51,
// and generic page headers about 0.30.
const MIN_SIMILARITY = 0.3;
const SIMILARITY_WINDOW = 0.1;
// Private markers for ts_headline; converted to ranges so clients never render server markup.
const START = '\u0001';
const STOP = '\u0002';

interface SearchRow {
  total: number;
  indexing: number;
  visible: boolean;
  items: (Omit<DocumentSearchResult, 'snippet' | 'highlights'> & { headline: string })[];
}

/** Converts a marked headline into plain text plus ordered highlight ranges within the limit. */
export function parseHeadline(
  headline: string,
): Pick<DocumentSearchResult, 'snippet' | 'highlights'> {
  let snippet = '';
  const highlights: DocumentSearchResult['highlights'] = [];
  let open: number | null = null;

  for (const character of headline.replace(/\s+/g, ' ').trim()) {
    if (character === START) {
      open ??= snippet.length;
    } else if (character === STOP) {
      if (open !== null && snippet.length > open) {
        highlights.push({ start: open, end: snippet.length });
      }
      open = null;
    } else if (snippet.length < SearchLimits.SnippetMaxLength) {
      snippet += character;
    }
  }
  if (open !== null && snippet.length > open) {
    highlights.push({ start: open, end: snippet.length });
  }

  return {
    snippet: snippet || '…',
    highlights: highlights
      .filter((range) => range.end <= snippet.length)
      .slice(0, SearchLimits.MaxHighlights),
  };
}

/**
 * Hybrid document search inside the caller's RLS transaction. Cases come from the policy-filtered
 * `caseflow.cases`, and chunks are additionally policy-filtered to available documents, so
 * Staff only ever match text from assigned cases.
 */
export async function searchDocuments(client: PoolClient, input: Record<string, unknown>) {
  const page = Number(input.page ?? 1);
  const pageSize = Number(input.pageSize ?? 20);
  const mode = input.mode === SearchMode.Keyword ? SearchMode.Keyword : SearchMode.Hybrid;
  const embedding =
    mode === SearchMode.Hybrid && Array.isArray(input.embedding)
      ? `[${(input.embedding as number[]).join(',')}]`
      : null;

  if (embedding) {
    // Keep filtering by access from starving approximate nearest-neighbour results (pgvector 0.8+).
    await client.query(`select set_config('hnsw.iterative_scan', 'relaxed_order', true)`);
  }

  const result = await client.query<SearchRow>(
    `with accessible as materialized (
      select c.id, c.case_number, c.title, c.archived_at is not null as archived
      from caseflow.cases c
      -- A specific case is searched regardless of the archive filter (archived cases stay readable).
      where ($2::uuid is not null and c.id = $2::uuid)
        or ($2::uuid is null and ($3 = 'all' or ($3 = 'current' and c.archived_at is null)
          or ($3 = 'archived' and c.archived_at is not null)))
    ), search_query as (
      -- Keyword matching requires every term; snippets highlight any term so they centre on
      -- relevant text, including for meaning-only matches.
      select websearch_to_tsquery('english', $1) as tsq,
        replace(plainto_tsquery('english', $1)::text, '&', '|')::tsquery as snippet_tsq
    ), keyword_candidates as (
      select ch.id, ts_rank_cd(ch.search_vector, q.tsq) as score
      from caseflow.document_text_chunks ch
      join accessible a on a.id = ch.case_id
      cross join search_query q
      where ch.search_vector @@ q.tsq
      order by score desc, ch.id limit ${CANDIDATES}
    ), keyword as (
      select id, row_number() over (order by score desc, id) as rank from keyword_candidates
    ), semantic_candidates as (
      select ch.id, ch.embedding operator(extensions.<=>) $4::extensions.vector as distance
      from caseflow.document_text_chunks ch
      join accessible a on a.id = ch.case_id
      where $4::text is not null and ch.embedding is not null
      order by distance, ch.id limit ${CANDIDATES}
    ), semantic as (
      select id, row_number() over (order by distance, id) as rank from semantic_candidates
      where distance <= ${1 - MIN_SIMILARITY}
        and distance <= (select min(distance) from semantic_candidates) + ${SIMILARITY_WINDOW}
    ), fused as (
      select coalesce(k.id, s.id) as id,
        coalesce(1.0 / (${RRF_K} + k.rank), 0) + coalesce(1.0 / (${RRF_K} + s.rank), 0) as score,
        case when k.id is not null and s.id is not null then 'both'
          when k.id is not null then 'keyword' else 'semantic' end as matched_by
      from keyword k full join semantic s on s.id = k.id
    ), ranked as (
      select id, matched_by, row_number() over (order by score desc, id) as position
      from fused order by score desc, id limit ${SearchLimits.MaxResults}
    ), latest_search as (
      select distinct on (s.document_id) s.document_id, s.status
      from caseflow.search_index_jobs s
      join caseflow.documents d on d.id = s.document_id
      join accessible a on a.id = d.case_id
      order by s.document_id, s.created_at desc, s.id desc
    ), latest_processing as (
      select distinct on (j.document_id) j.document_id, j.status
      from caseflow.document_processing_jobs j
      join caseflow.documents d on d.id = j.document_id
      join accessible a on a.id = d.case_id
      order by j.document_id, j.created_at desc, j.id desc
    )
    select ($2::uuid is null or exists(select 1 from accessible)) as visible,
      (select count(*)::int from ranked) as total,
      (select count(*)::int from caseflow.documents d
        join accessible a on a.id = d.case_id
        left join latest_search s on s.document_id = d.id
        left join latest_processing p on p.document_id = d.id
        where d.status = 'available' and (s.status in ('queued', 'indexing')
          or (s.status is null and p.status in ('queued', 'processing')))) as indexing,
      coalesce((select jsonb_agg(jsonb_build_object(
        'chunkId', ch.id, 'caseId', a.id, 'caseNumber', a.case_number, 'caseTitle', a.title,
        'caseArchived', a.archived, 'documentId', d.id, 'filename', d.filename,
        'contentType', d.content_type, 'page', ch.page, 'matchedBy', r.matched_by,
        'headline', ts_headline('english', translate(ch.content, E'\\x01\\x02', '  '), q.snippet_tsq,
          'StartSel=' || E'\\x01' || ', StopSel=' || E'\\x02'
            || ', MaxFragments=2, MaxWords=30, MinWords=12, FragmentDelimiter=" … "'))
        order by r.position)
        from ranked r
        join caseflow.document_text_chunks ch on ch.id = r.id
        join caseflow.documents d on d.id = ch.document_id
        join accessible a on a.id = ch.case_id
        cross join search_query q
        where r.position > $5 and r.position <= $5 + $6), '[]'::jsonb) as items`,
    [
      input.q,
      input.caseId ?? null,
      input.archive ?? CaseArchiveFilter.Current,
      embedding,
      (page - 1) * pageSize,
      pageSize,
    ],
  );
  const row = result.rows[0]!;

  if (!row.visible) {
    throw new AppError(ErrorCode.NotFound, 404, 'Case not found.');
  }

  return documentSearchPageSchema.parse({
    items: row.items.map(({ headline, ...item }) => ({ ...item, ...parseHeadline(headline) })),
    total: row.total,
    page,
    pageSize,
    mode,
    semanticAvailable: mode === SearchMode.Hybrid && embedding !== null,
    indexingDocuments: row.indexing,
  });
}
