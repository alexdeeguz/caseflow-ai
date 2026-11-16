import type { PoolClient } from 'pg';
import {
  CaseArchiveFilter,
  ErrorCode,
  SearchLimits,
  SearchMatch,
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
// the fictional corpus with text-embedding-3-small: unrelated queries stay below 0.30; relevant
// passages score about 0.31-0.56, with question-style queries lowest; generic page headers and
// passages about a different incident of the same kind score about 0.30-0.36.
const MIN_SIMILARITY = 0.3;
// Short queries ("car accident") score same-kind documents higher (an unrelated slip-and-fall report
// reached 0.34), so they need a stricter floor. Longer queries keep the lower floor so questions such
// as "when did physical therapy start" (relevant passages ~0.31) still find their passages.
const SHORT_QUERY_WORDS = 3;
const SHORT_QUERY_MIN_SIMILARITY = 0.36;
const SIMILARITY_WINDOW = 0.1;
// Without any exact-word match, a best meaning-based match below this is flagged as loosely related.
const STRONG_SIMILARITY = 0.4;
// Private markers for ts_headline; converted to ranges so clients never render server markup.
const START = '\u0001';
const STOP = '\u0002';

interface SearchRow {
  total: number;
  indexing: number;
  visible: boolean;
  keywordMatches: number;
  bestSimilarity: number | null;
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

/** Minimum cosine similarity for a meaning-only match; short queries need a stricter floor. */
export function minimumSimilarity(query: string): number {
  const words = query.trim().split(/\s+/).filter(Boolean).length;
  return words <= SHORT_QUERY_WORDS ? SHORT_QUERY_MIN_SIMILARITY : MIN_SIMILARITY;
}

/**
 * Meaning-only snippets start at the passage start, which overlapping passages often place
 * mid-sentence. Start at the first full sentence instead, unless that would drop a highlight or
 * leave too little text.
 */
export function trimLeadingFragment(
  result: Pick<DocumentSearchResult, 'snippet' | 'highlights'>,
): Pick<DocumentSearchResult, 'snippet' | 'highlights'> {
  const { snippet, highlights } = result;
  if (!/^[a-z]/.test(snippet)) {
    return result;
  }
  const boundary = /[.!?]\s+(?=[A-Z0-9"“(])/.exec(snippet.slice(0, 160));
  const cut = boundary ? boundary.index + boundary[0].length : 0;
  if (!cut || snippet.length - cut < 60 || highlights.some((range) => range.start < cut)) {
    return result;
  }
  return {
    snippet: snippet.slice(cut),
    highlights: highlights.map(({ start, end }) => ({ start: start - cut, end: end - cut })),
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
      select id, distance, row_number() over (order by distance, id) as rank
      from semantic_candidates
      where distance <= 1 - $7::float8
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
      (select count(*)::int from keyword) as "keywordMatches",
      (select (1 - min(distance))::float8 from semantic) as "bestSimilarity",
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
            -- Meaning-only matches rarely contain the query words, so show a longer excerpt.
            || case when r.matched_by = 'semantic' then ', MaxFragments=2, MaxWords=45, MinWords=35'
              else ', MaxFragments=2, MaxWords=30, MinWords=12' end
            || ', FragmentDelimiter=" … "'))
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
      minimumSimilarity(String(input.q ?? '')),
    ],
  );
  const row = result.rows[0]!;

  if (!row.visible) {
    throw new AppError(ErrorCode.NotFound, 404, 'Case not found.');
  }

  return documentSearchPageSchema.parse({
    items: row.items.map(({ headline, ...item }) => {
      const snippet = parseHeadline(headline);
      return {
        ...item,
        ...(item.matchedBy === SearchMatch.Semantic ? trimLeadingFragment(snippet) : snippet),
      };
    }),
    total: row.total,
    page,
    pageSize,
    mode,
    semanticAvailable: mode === SearchMode.Hybrid && embedding !== null,
    looseMatches:
      row.total > 0 &&
      row.keywordMatches === 0 &&
      row.bestSimilarity !== null &&
      row.bestSimilarity < STRONG_SIMILARITY,
    indexingDocuments: row.indexing,
  });
}
