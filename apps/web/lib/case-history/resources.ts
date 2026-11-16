import {
  FactCategory,
  caseTimelineSchema,
  caseReviewedSummarySchema,
  type FactCategory as Category,
} from '@caseflow/schemas';

export function caseTimelineResource(caseId: string, page = 1) {
  const query = new URLSearchParams({ page: String(page) });
  return { path: `/cases/${caseId}/timeline?${query}`, schema: caseTimelineSchema };
}

export function caseReviewedSummaryResource(
  caseId: string,
  category: Category = FactCategory.Date,
  page = 1,
) {
  const query = new URLSearchParams({ category, page: String(page) });
  return { path: `/cases/${caseId}/reviewed-summary?${query}`, schema: caseReviewedSummarySchema };
}

export function isCaseHistoryResource(path: string, caseId: string) {
  return (
    path.startsWith(`/cases/${caseId}/timeline?`) ||
    path.startsWith(`/cases/${caseId}/reviewed-summary?`)
  );
}
