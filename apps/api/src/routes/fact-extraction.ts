import {
  factExtractionQuerySchema,
  factExtractionRequestSchema,
  factExtractionSummarySchema,
  reviewedFactQuerySchema,
  reviewedFactPageSchema,
} from '@caseflow/schemas';
import { Operation } from '../database/operations.js';
import type { RegisterProtectedRoute } from './protected-route.js';

export function registerFactExtractionRoutes(route: RegisterProtectedRoute) {
  route({
    method: 'GET',
    url: '/cases/:caseId/documents/:documentId/fact-extraction',
    query: factExtractionQuerySchema,
    output: factExtractionSummarySchema,
    operation: Operation.GetFactExtraction,
  });
  route({
    method: 'POST',
    url: '/cases/:caseId/documents/:documentId/fact-extraction',
    query: factExtractionQuerySchema,
    body: factExtractionRequestSchema,
    output: factExtractionSummarySchema,
    operation: Operation.RequestFactExtraction,
  });
  route({
    method: 'GET',
    url: '/cases/:caseId/documents/:documentId/facts',
    query: reviewedFactQuerySchema,
    output: reviewedFactPageSchema,
    operation: Operation.ListFacts,
  });
}
