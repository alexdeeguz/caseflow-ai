import { reviewedFactSchema, factReviewHistorySchema } from '@caseflow/schemas';

export function reviewedFactResource(caseId: string, documentId: string, factId: string) {
  return {
    path: `/cases/${caseId}/documents/${documentId}/facts/${factId}`,
    schema: reviewedFactSchema,
  };
}

export function factReviewHistoryResource(
  caseId: string,
  documentId: string,
  factId: string,
  page: number,
) {
  return {
    path: `${reviewedFactResource(caseId, documentId, factId).path}/history?page=${page}`,
    schema: factReviewHistorySchema,
  };
}
