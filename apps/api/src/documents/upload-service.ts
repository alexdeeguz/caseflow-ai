import { ErrorCode, UploadSessionStatus } from '@caseflow/schemas';
import type { Identity } from '../auth.js';
import type { WorkspaceStore } from '../database/index.js';
import { parseUploadRecord, type UploadRecord } from '../database/documents.js';
import { Operation } from '../database/operations.js';
import { AppError } from '../errors.js';
import { UploadVerificationError, type UploadStorage } from '../storage/uploads.js';

function publicResult(record: UploadRecord) {
  return { document: record.document, session: record.session };
}

function requireUsableSession(record: UploadRecord) {
  switch (record.session.status) {
    case UploadSessionStatus.Pending:
    case UploadSessionStatus.Completed:
      return;
    case UploadSessionStatus.Expired:
      throw new AppError(ErrorCode.UploadExpired, 409, 'This upload expired. Start a new upload.');
    case UploadSessionStatus.Failed:
      throw new AppError(
        ErrorCode.UploadVerificationFailed,
        422,
        'The file did not match its declared size, checksum, or type. Start a new upload.',
      );
    default:
      throw new AppError(
        ErrorCode.UploadConflict,
        409,
        'This upload cannot be reused. Start a new upload.',
      );
  }
}

export function createDocumentUploadService(store: WorkspaceStore, storage: UploadStorage | null) {
  async function requireStorage(identity: Identity, caseId: unknown) {
    if (!storage) {
      await store.execute(identity, Operation.GetCase, { id: caseId });
      throw new AppError(
        ErrorCode.ServiceUnavailable,
        503,
        'Document storage is unavailable. Please try again.',
      );
    }
    return storage;
  }

  async function execute(identity: Identity, operation: Operation, input: Record<string, unknown>) {
    const record = parseUploadRecord(await store.execute(identity, operation, input));
    requireUsableSession(record);
    return record;
  }

  return {
    async start(identity: Identity, input: Record<string, unknown>) {
      const gateway = await requireStorage(identity, input.caseId);
      const record = await execute(identity, Operation.StartDocumentUpload, {
        ...input,
        bucket: gateway.bucket,
        environment: gateway.environment,
      });
      if (record.session.status === UploadSessionStatus.Completed) {
        return { ...publicResult(record), upload: null };
      }

      let upload;
      try {
        upload = await gateway.authorize(record);
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.ServiceUnavailable,
          503,
          'Upload authorization is unavailable. Retry with the same request ID.',
        );
      }

      // Credential resolution can take time; recheck access and expiry before returning the URL.
      const current = await execute(identity, Operation.CheckDocumentUpload, {
        caseId: input.caseId,
        sessionId: record.session.id,
      });
      return {
        ...publicResult(current),
        upload: current.session.status === UploadSessionStatus.Completed ? null : upload,
      };
    },

    async complete(identity: Identity, input: Record<string, unknown>) {
      const gateway = await requireStorage(identity, input.caseId);
      const record = await execute(identity, Operation.CheckDocumentUpload, input);
      if (record.session.status === UploadSessionStatus.Completed) {
        return publicResult(record);
      }

      let objectVersionId: string;
      try {
        objectVersionId = await gateway.verify(record);
      } catch (error) {
        if (error instanceof UploadVerificationError) {
          const failed = await execute(identity, Operation.FailDocumentUpload, input);
          // A concurrent verified completion wins over a later failure report.
          return publicResult(failed);
        }
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.ServiceUnavailable,
          503,
          'The uploaded file could not be verified yet. Please retry.',
        );
      }

      const completed = await execute(identity, Operation.CompleteDocumentUpload, {
        ...input,
        objectVersionId,
      });
      return publicResult(completed);
    },
  };
}
