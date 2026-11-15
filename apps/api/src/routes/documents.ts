import {
  documentUploadRequestSchema,
  documentUploadAuthorizationSchema,
  documentUploadCompleteSchema,
  documentUploadResultSchema,
  documentQuerySchema,
  documentPageSchema,
  documentSchema,
  documentVersionSchema,
  documentDownloadRequestSchema,
  downloadAuthorizationSchema,
} from '@caseflow/schemas';
import type { WorkspaceStore } from '../database/index.js';
import { createDocumentUploadService } from '../documents/upload-service.js';
import type { UploadStorage } from '../storage/uploads.js';
import { createDocumentDownloadService } from '../documents/download-service.js';
import type { DownloadStorage } from '../storage/downloads.js';
import { Operation } from '../database/operations.js';
import type { RegisterProtectedRoute } from './protected-route.js';

export function registerDocumentRoutes(
  route: RegisterProtectedRoute,
  store: WorkspaceStore,
  storage: UploadStorage | null,
  downloads: DownloadStorage | null,
) {
  const uploads = createDocumentUploadService(store, storage);

  route({
    method: 'GET',
    url: '/cases/:caseId/documents',
    query: documentQuerySchema,
    output: documentPageSchema,
    operation: Operation.ListDocuments,
  });

  route({
    method: 'POST',
    url: '/cases/:caseId/documents/:documentId/download',
    body: documentDownloadRequestSchema,
    query: documentDownloadRequestSchema,
    output: downloadAuthorizationSchema,
    execute: createDocumentDownloadService(store, downloads),
  });

  for (const [action, operation] of [
    ['remove', Operation.RemoveDocument],
    ['restore', Operation.RestoreDocument],
  ] as const) {
    route({
      method: 'POST',
      url: `/cases/:caseId/documents/:documentId/${action}`,
      body: documentVersionSchema,
      query: documentDownloadRequestSchema,
      output: documentSchema,
      operation,
    });
  }

  route({
    method: 'POST',
    url: '/cases/:caseId/document-uploads',
    successStatus: 201,
    body: documentUploadRequestSchema,
    output: documentUploadAuthorizationSchema,
    execute: uploads.start,
  });

  route({
    method: 'POST',
    url: '/cases/:caseId/document-uploads/:sessionId/complete',
    body: documentUploadCompleteSchema,
    output: documentUploadResultSchema,
    execute: uploads.complete,
  });
}
