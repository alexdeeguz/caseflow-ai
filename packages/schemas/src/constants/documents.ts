export const DocumentContentType = {
  Pdf: 'application/pdf',
  Jpeg: 'image/jpeg',
  Png: 'image/png',
} as const;

export type DocumentContentType = (typeof DocumentContentType)[keyof typeof DocumentContentType];

export const documentExtensions: Readonly<Record<DocumentContentType, readonly string[]>> = {
  [DocumentContentType.Pdf]: ['pdf'],
  [DocumentContentType.Jpeg]: ['jpg', 'jpeg'],
  [DocumentContentType.Png]: ['png'],
};

export const DocumentStatus = {
  PendingUpload: 'pending_upload',
  Available: 'available',
  Removed: 'removed',
} as const;

export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];

export const UploadSessionStatus = {
  Pending: 'pending',
  Completed: 'completed',
  Failed: 'failed',
  Expired: 'expired',
  Cancelled: 'cancelled',
} as const;

export type UploadSessionStatus = (typeof UploadSessionStatus)[keyof typeof UploadSessionStatus];

export const UploadFailureCode = {
  VerificationFailed: 'verification_failed',
  StorageUnavailable: 'storage_unavailable',
} as const;

export type UploadFailureCode = (typeof UploadFailureCode)[keyof typeof UploadFailureCode];

export const DocumentFilter = {
  Current: 'current',
  Removed: 'removed',
  All: 'all',
} as const;

export type DocumentFilter = (typeof DocumentFilter)[keyof typeof DocumentFilter];

export const DocumentLimits = {
  Filename: 255,
  FileSizeBytes: 25 * 1024 * 1024,
  FilesPerBatch: 10,
  ConcurrentUploads: 2,
  WorkspaceSizeBytes: 1024 * 1024 * 1024,
  UploadLifetimeSeconds: 300,
  DownloadLifetimeSeconds: 60,
} as const;
