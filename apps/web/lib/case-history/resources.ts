import {
  FactCategory,
  caseTimelineSchema,
  caseReviewedSummarySchema,
  type FactCategory as Category,
} from '@caseflow/schemas';

/** Large pages keep intervals and gaps meaningful; the API maximum is 100. */
export const HISTORY_PAGE_SIZE = 100;

export function caseTimelineResource(caseId: string, page = 1) {
  const query = new URLSearchParams({ page: String(page), pageSize: String(HISTORY_PAGE_SIZE) });
  return { path: `/cases/${caseId}/timeline?${query}`, schema: caseTimelineSchema };
}

export function caseReviewedSummaryResource(caseId: string, category: Category) {
  const query = new URLSearchParams({ category, page: '1', pageSize: String(HISTORY_PAGE_SIZE) });
  return { path: `/cases/${caseId}/reviewed-summary?${query}`, schema: caseReviewedSummarySchema };
}

/** Categories the reviewed summary lists; its key dates come from the timeline's first page. */
export const summaryCategories = [
  FactCategory.Finding,
  FactCategory.Treatment,
  FactCategory.Provider,
] as const;

export function caseSummaryResources(caseId: string) {
  return {
    dates: caseTimelineResource(caseId),
    categories: summaryCategories.map((category) => caseReviewedSummaryResource(caseId, category)),
  };
}

export function isCaseHistoryResource(path: string, caseId: string) {
  return (
    path.startsWith(`/cases/${caseId}/timeline?`) ||
    path.startsWith(`/cases/${caseId}/reviewed-summary?`)
  );
}
