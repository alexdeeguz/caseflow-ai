import {
  documentUploadRequestSchema,
  documentUploadAuthorizationSchema,
  documentUploadCompleteSchema,
  documentUploadResultSchema,
} from '@caseflow/schemas';
import type { WorkspaceStore } from '../database/index.js';
import { createDocumentUploadService } from '../documents/upload-service.js';
import type { UploadStorage } from '../storage/uploads.js';
import type { RegisterProtectedRoute } from './protected-route.js';

export function registerDocumentRoutes(
  route: RegisterProtectedRoute,
  store: WorkspaceStore,
  storage: UploadStorage | null,
) {
  const uploads = createDocumentUploadService(store, storage);

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
