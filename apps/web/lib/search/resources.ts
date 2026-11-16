import {
  CaseArchiveFilter,
  SearchLimits,
  SearchMode,
  casePageSchema,
  documentSearchPageSchema,
} from '@caseflow/schemas';

export interface DocumentSearchInput {
  query: string;
  mode: SearchMode;
  caseId: string | null;
  archive: CaseArchiveFilter;
  page: number;
}

/** True when a query is long enough to send (shorter input shows guidance instead). */
export function isSearchable(query: string): boolean {
  return query.trim().length >= SearchLimits.QueryMinLength;
}

export function documentSearchResource({
  query,
  mode,
  caseId,
  archive,
  page,
}: DocumentSearchInput) {
  const params = new URLSearchParams({ q: query.trim(), mode, page: String(page) });

  if (caseId) {
    params.set('caseId', caseId);
  } else if (archive !== CaseArchiveFilter.Current) {
    params.set('archive', archive);
  }
  return { path: `/search?${params}`, schema: documentSearchPageSchema };
}

export function isSearchResource(key: string): boolean {
  return key.startsWith('/search?');
}

/** Accessible cases for the search filter (first 100, newest first). */
export function searchCaseOptionsResource(archive: CaseArchiveFilter) {
  const params = new URLSearchParams({ page: '1', pageSize: '100', archive });
  return { path: `/cases?${params}`, schema: casePageSchema };
}
