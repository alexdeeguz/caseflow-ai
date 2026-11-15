import type { DocumentFile, UploadAuthorization } from '@caseflow/schemas';

export const UploadPhase = {
  Queued: 'queued',
  Preparing: 'preparing',
  Uploading: 'uploading',
  Verifying: 'verifying',
  Uploaded: 'uploaded',
  Failed: 'failed',
  Stopped: 'stopped',
} as const;

export type UploadPhase = (typeof UploadPhase)[keyof typeof UploadPhase];

export const uploadPhaseLabels: Record<UploadPhase, string> = {
  queued: 'Queued',
  preparing: 'Preparing',
  uploading: 'Uploading',
  verifying: 'Verifying',
  uploaded: 'Uploaded',
  failed: 'Needs attention',
  stopped: 'Stopped',
};

export const UploadRetry = { SameAttempt: 'same', NewAttempt: 'new', None: 'none' } as const;
export type UploadRetry = (typeof UploadRetry)[keyof typeof UploadRetry];

export interface UploadCase {
  id: string;
  label: string;
}

export interface UploadItem extends DocumentFile {
  id: string;
  batchId: string;
  case: UploadCase;
  phase: UploadPhase;
  progress: number;
  error: string | null;
  retry: UploadRetry;
}

export interface UploadTransport {
  checksum(file: File): Promise<string>;
  put(
    file: File,
    authorization: UploadAuthorization,
    signal: AbortSignal,
    onProgress: (percent: number) => void,
  ): Promise<void>;
}

export function isUploadRunning(phase: UploadPhase) {
  return (
    phase === UploadPhase.Preparing ||
    phase === UploadPhase.Uploading ||
    phase === UploadPhase.Verifying
  );
}

export function isUploadUnfinished(item: UploadItem) {
  return item.phase !== UploadPhase.Uploaded && item.retry !== UploadRetry.None;
}
