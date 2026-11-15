export const ProcessingStatus = {
  NotProcessed: 'not_processed',
  Queued: 'queued',
  Processing: 'processing',
  Ready: 'ready',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

export type ProcessingStatus = (typeof ProcessingStatus)[keyof typeof ProcessingStatus];

export const ProcessingStage = {
  Extracting: 'extracting',
  WaitingForOcr: 'waiting_for_ocr',
  Collecting: 'collecting',
} as const;

export const ProcessingFailureCode = {
  InvalidDocument: 'invalid_document',
  LimitExceeded: 'limit_exceeded',
  StorageUnavailable: 'storage_unavailable',
  OcrUnavailable: 'ocr_unavailable',
  AttemptsExhausted: 'attempts_exhausted',
  InternalError: 'internal_error',
  OcrBudgetExceeded: 'ocr_budget_exceeded',
  OcrIncomplete: 'ocr_incomplete',
  OcrResultsExpired: 'ocr_results_expired',
} as const;

export const DispatchStatus = {
  Pending: 'pending',
  Leased: 'leased',
  Sent: 'sent',
} as const;

export const ProcessingLimits = {
  MaxAttempts: 5,
  MaxPdfPages: 20,
  DailyOcrPages: 100,
  DispatchBatchSize: 25,
  DispatchLeaseSeconds: 60,
  DispatchRetrySeconds: 30,
  MessageSchemaVersion: 1,
} as const;
