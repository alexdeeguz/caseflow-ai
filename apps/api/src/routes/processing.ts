import {
  processingQuerySchema,
  processingRequestSchema,
  processingSummarySchema,
} from '@caseflow/schemas';
import { Operation } from '../database/operations.js';
import type { RegisterProtectedRoute } from './protected-route.js';

export function registerProcessingRoutes(route: RegisterProtectedRoute) {
  route({
    method: 'GET',
    url: '/cases/:caseId/documents/:documentId/processing',
    query: processingQuerySchema,
    output: processingSummarySchema,
    operation: Operation.GetDocumentProcessing,
  });

  route({
    method: 'POST',
    url: '/cases/:caseId/documents/:documentId/processing',
    body: processingRequestSchema,
    query: processingQuerySchema,
    output: processingSummarySchema,
    operation: Operation.RequestDocumentProcessing,
  });
}
