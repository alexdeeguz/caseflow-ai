import {
  DocumentLimits,
  DocumentStatus,
  ErrorCode,
  UploadSessionStatus,
  documentUploadAuthorizationSchema,
  documentUploadResultSchema,
} from '@caseflow/schemas';
import type { AuthRequest } from '../../hooks/use-authentication';
import { ApiError } from '../api';
import { validateFile } from './file-validation';
import {
  UploadPhase,
  UploadRetry,
  isUploadRunning,
  isUploadUnfinished,
  type UploadCase,
  type UploadItem,
  type UploadTransport,
} from './upload-types';

interface Attempt {
  file: File;
  requestId: string;
  checksum?: string;
  sessionId?: string;
  transferAttempted: boolean;
  controller?: AbortController;
}

export function createUploadQueue(initialRequest: AuthRequest, transport: UploadTransport) {
  let request = initialRequest;
  let snapshot: readonly UploadItem[] = [];
  let running = 0;
  const attempts = new Map<string, Attempt>();
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  const update = (id: string, patch: Partial<UploadItem>) => {
    snapshot = snapshot.map((item) => (item.id === id ? { ...item, ...patch } : item));
    publish();
  };
  const remove = (id: string) => {
    attempts.get(id)?.controller?.abort();
    attempts.delete(id);
    snapshot = snapshot.filter((item) => item.id !== id);
    publish();
  };
  const clear = (caseId?: string) => {
    for (const item of [...snapshot]) {
      if (!caseId || item.case.id === caseId) {
        remove(item.id);
      }
    }
  };

  async function run(item: UploadItem, attempt: Attempt) {
    const controller = new AbortController();
    attempt.controller = controller;
    const signal = controller.signal;
    const ensureCurrent = () => {
      signal.throwIfAborted();
      if (attempts.get(item.id) !== attempt) {
        throw new DOMException('Upload stopped', 'AbortError');
      }
    };
    const options = { method: 'POST', signal, timeoutMs: 60000 };
    const base = `/cases/${item.case.id}/document-uploads`;
    const completed = (status: string) => {
      if (status !== DocumentStatus.Available) {
        throw new ApiError(
          409,
          ErrorCode.DocumentUnavailable,
          'This document is no longer available.',
        );
      }
      update(item.id, {
        phase: UploadPhase.Uploaded,
        progress: 100,
        error: null,
        retry: UploadRetry.None,
      });
      attempts.delete(item.id);
    };
    const verify = async () => {
      update(item.id, { phase: UploadPhase.Verifying });
      const result = await request(
        `${base}/${attempt.sessionId}/complete`,
        documentUploadResultSchema,
        { ...options, body: '{}' },
      );
      ensureCurrent();
      if (result.session.status !== UploadSessionStatus.Completed) {
        throw new Error('Verification is not complete. Retry this upload.');
      }
      completed(result.document.status);
    };

    try {
      update(item.id, { phase: UploadPhase.Preparing, error: null });
      // Reconcile a lost transfer/completion response before sending any more bytes.
      if (attempt.transferAttempted && attempt.sessionId) {
        try {
          await verify();
          return;
        } catch (error) {
          ensureCurrent();
          if (error instanceof ApiError && error.status !== 503) {
            throw error;
          }
          update(item.id, { phase: UploadPhase.Preparing });
        }
      }
      attempt.checksum ??= await transport.checksum(attempt.file);
      ensureCurrent();
      const authorization = await request(base, documentUploadAuthorizationSchema, {
        ...options,
        body: JSON.stringify({
          requestId: attempt.requestId,
          filename: item.filename,
          contentType: item.contentType,
          sizeBytes: item.sizeBytes,
          checksumSha256: attempt.checksum,
        }),
      });
      ensureCurrent();
      attempt.sessionId = authorization.session.id;
      if (authorization.session.status === UploadSessionStatus.Completed) {
        completed(authorization.document.status);
        return;
      }
      if (!authorization.upload) {
        throw new Error('Upload authorization is unavailable. Retry this upload.');
      }
      update(item.id, { phase: UploadPhase.Uploading, progress: 0 });
      attempt.transferAttempted = true;
      try {
        await transport.put(attempt.file, authorization.upload, signal, (progress) => {
          if (!signal.aborted) {
            update(item.id, { progress });
          }
        });
      } catch {
        ensureCurrent();
        // An unsuccessful browser response can still mean S3 accepted the object.
      }
      ensureCurrent();
      await verify();
    } catch (error) {
      if (signal.aborted || attempts.get(item.id) !== attempt) {
        return;
      }
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        clear(
          error.status === 401 || error.code === ErrorCode.AccountDisabled
            ? undefined
            : item.case.id,
        );
        return;
      }
      const terminal =
        error instanceof ApiError &&
        [
          ErrorCode.UploadExpired,
          ErrorCode.UploadVerificationFailed,
          ErrorCode.UploadConflict,
        ].some((code) => code === error.code);
      const blocked =
        error instanceof ApiError &&
        [
          ErrorCode.CaseArchived,
          ErrorCode.StorageQuotaExceeded,
          ErrorCode.DocumentUnavailable,
        ].some((code) => code === error.code);
      update(item.id, {
        phase: UploadPhase.Failed,
        error: error instanceof Error ? error.message : 'Upload could not finish. Please retry.',
        retry: blocked
          ? UploadRetry.None
          : terminal
            ? UploadRetry.NewAttempt
            : UploadRetry.SameAttempt,
      });
      if (blocked) {
        attempts.delete(item.id);
      }
    } finally {
      if (attempt.controller === controller) {
        attempt.controller = undefined;
      }
      running--;
      pump();
    }
  }

  function pump() {
    for (const item of snapshot) {
      if (running >= DocumentLimits.ConcurrentUploads) {
        break;
      }
      const attempt = attempts.get(item.id);
      if (item.phase === UploadPhase.Queued && attempt && !attempt.controller) {
        running++;
        void run(item, attempt);
      }
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setRequest(next: AuthRequest) {
      request = next;
    },
    /** Queues a batch of files and returns its batch ID. */
    add(files: readonly File[], target: UploadCase): string {
      if (
        !files.length ||
        files.length > DocumentLimits.FilesPerBatch ||
        snapshot.filter(isUploadUnfinished).length + files.length > DocumentLimits.FilesPerBatch
      ) {
        throw new Error(
          'Keep at most 10 unfinished files in the upload queue. Finish or dismiss existing uploads first.',
        );
      }
      const selections = files.map((file) => ({ file, metadata: validateFile(file) }));
      const batchId = crypto.randomUUID();
      snapshot = snapshot.filter(isUploadUnfinished);
      selections.forEach(({ file, metadata }) => {
        const id = crypto.randomUUID();
        attempts.set(id, { file, requestId: crypto.randomUUID(), transferAttempted: false });
        snapshot = [
          ...snapshot,
          {
            ...metadata,
            id,
            batchId,
            case: target,
            phase: UploadPhase.Queued,
            progress: 0,
            error: null,
            retry: UploadRetry.SameAttempt,
          },
        ];
      });
      publish();
      queueMicrotask(pump);
      return batchId;
    },
    stop(id: string) {
      const item = snapshot.find((value) => value.id === id);
      if (!item || item.phase === UploadPhase.Verifying || !isUploadUnfinished(item)) {
        return;
      }
      attempts.get(id)?.controller?.abort();
      update(id, {
        phase: UploadPhase.Stopped,
        error: 'Stopped on this device. Any received bytes and reserved storage are retained.',
      });
    },
    retry(id: string) {
      const item = snapshot.find((value) => value.id === id);
      const attempt = attempts.get(id);
      if (
        !item ||
        !attempt ||
        attempt.controller ||
        isUploadRunning(item.phase) ||
        item.phase === UploadPhase.Queued ||
        item.retry === UploadRetry.None
      ) {
        return;
      }
      if (item.retry === UploadRetry.NewAttempt) {
        attempts.set(id, {
          file: attempt.file,
          checksum: attempt.checksum,
          requestId: crypto.randomUUID(),
          transferAttempted: false,
        });
      }
      update(id, { phase: UploadPhase.Queued, error: null, retry: UploadRetry.SameAttempt });
      pump();
    },
    dismiss(id: string) {
      const item = snapshot.find((value) => value.id === id);
      if (item && !isUploadRunning(item.phase)) {
        remove(id);
      }
    },
    clear,
  };
}

export type UploadQueue = ReturnType<typeof createUploadQueue>;

export function withUploadAccessChecks(request: AuthRequest, queue: UploadQueue): AuthRequest {
  return async (path, schema, options) => {
    try {
      return await request(path, schema, options);
    } catch (error) {
      if (error instanceof ApiError) {
        const caseId = /^\/cases\/([^/?]+)(?:\/|\?|$)/.exec(path)?.[1];
        if (
          error.status === 401 ||
          error.code === ErrorCode.AccountDisabled ||
          (error.status === 403 && !caseId)
        ) {
          queue.clear();
        } else if (caseId && [403, 404].includes(error.status)) {
          queue.clear(caseId);
        }
      }
      throw error;
    }
  };
}
