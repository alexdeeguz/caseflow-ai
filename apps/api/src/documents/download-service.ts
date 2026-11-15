import { downloadAuthorizationSchema, ErrorCode } from '@caseflow/schemas';
import type { Identity } from '../auth.js';
import type { WorkspaceStore } from '../database/index.js';
import { parseDownloadRecord } from '../database/documents.js';
import { Operation } from '../database/operations.js';
import { AppError } from '../errors.js';
import type { DownloadStorage } from '../storage/downloads.js';

export function createDocumentDownloadService(
  store: WorkspaceStore,
  storage: DownloadStorage | null,
) {
  return async function download(identity: Identity, input: Record<string, unknown>) {
    const record = parseDownloadRecord(
      await store.execute(identity, Operation.GetDocumentDownload, input),
    );

    if (!storage) {
      throw new AppError(
        ErrorCode.ServiceUnavailable,
        503,
        'Document storage is unavailable. Please try again.',
      );
    }

    let authorization;

    try {
      authorization = downloadAuthorizationSchema.parse(await storage.authorize(record));
    } catch {
      throw new AppError(
        ErrorCode.ServiceUnavailable,
        503,
        'The download could not be prepared. Please try again.',
      );
    }

    // Signing may resolve credentials remotely; recheck access before releasing the URL.
    await store.execute(identity, Operation.AuthorizeDocumentDownload, {
      caseId: record.document.caseId,
      documentId: record.document.id,
      expectedVersion: record.document.version,
      expiresAt: authorization.expiresAt,
    });

    return authorization;
  };
}
