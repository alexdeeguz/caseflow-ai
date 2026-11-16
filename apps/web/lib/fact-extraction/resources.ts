import {
  factExtractionSummarySchema,
  reviewedFactPageSchema,
  type FactReviewStatus,
  type FactCategory,
} from '@caseflow/schemas';

export function factExtractionResource(caseId: string, documentId: string) {
  return {
    path: `/cases/${caseId}/documents/${documentId}/fact-extraction`,
    schema: factExtractionSummarySchema,
  };
}

export function factsResource(
  caseId: string,
  documentId: string,
  page: number,
  category?: FactCategory,
  reviewStatus?: FactReviewStatus,
) {
  const params = new URLSearchParams({ page: String(page) });
  if (category) {
    params.set('category', category);
  }
  if (reviewStatus) {
    params.set('reviewStatus', reviewStatus);
  }
  return {
    path: `/cases/${caseId}/documents/${documentId}/facts?${params}`,
    schema: reviewedFactPageSchema,
  };
}
