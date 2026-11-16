import {
  factCorrectionSchema,
  factApprovalSchema,
  factReviewDecisionSchema,
  reviewedFactSchema,
  factReviewHistorySchema,
  pageQuerySchema,
  factExtractionQuerySchema,
} from '@caseflow/schemas';
import { Operation } from '../database/operations.js';
import type { RegisterProtectedRoute } from './protected-route.js';

export function registerFactReviewRoutes(route: RegisterProtectedRoute) {
  const url = '/cases/:caseId/documents/:documentId/facts/:factId';
  route({
    method: 'GET',
    url,
    query: factExtractionQuerySchema,
    output: reviewedFactSchema,
    operation: Operation.GetFact,
  });
  route({
    method: 'PATCH',
    url,
    query: factExtractionQuerySchema,
    body: factCorrectionSchema,
    output: reviewedFactSchema,
    operation: Operation.CorrectFact,
  });
  route({
    method: 'POST',
    url: `${url}/approve`,
    query: factExtractionQuerySchema,
    body: factApprovalSchema,
    output: reviewedFactSchema,
    operation: Operation.ApproveFact,
  });
  route({
    method: 'POST',
    url: `${url}/reject`,
    query: factExtractionQuerySchema,
    body: factReviewDecisionSchema,
    output: reviewedFactSchema,
    operation: Operation.RejectFact,
  });
  route({
    method: 'POST',
    url: `${url}/reopen`,
    query: factExtractionQuerySchema,
    body: factReviewDecisionSchema,
    output: reviewedFactSchema,
    operation: Operation.ReopenFact,
  });
  route({
    method: 'GET',
    url: `${url}/history`,
    query: pageQuerySchema,
    output: factReviewHistorySchema,
    operation: Operation.ListFactReviewHistory,
  });
}
