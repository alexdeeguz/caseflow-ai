import {
  caseTimelineQuerySchema,
  caseTimelineSchema,
  caseReviewedSummaryQuerySchema,
  caseReviewedSummarySchema,
} from '@caseflow/schemas';
import { Operation } from '../database/operations.js';
import type { RegisterProtectedRoute } from './protected-route.js';

export function registerCaseHistoryRoutes(route: RegisterProtectedRoute) {
  route({
    method: 'GET',
    url: '/cases/:caseId/timeline',
    query: caseTimelineQuerySchema,
    output: caseTimelineSchema,
    operation: Operation.GetCaseTimeline,
  });
  route({
    method: 'GET',
    url: '/cases/:caseId/reviewed-summary',
    query: caseReviewedSummaryQuerySchema,
    output: caseReviewedSummarySchema,
    operation: Operation.GetCaseReviewedSummary,
  });
}
