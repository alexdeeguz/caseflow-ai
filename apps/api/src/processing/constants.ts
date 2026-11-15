export const DispatcherLimits = {
  ConcurrentSends: 5,
  PollIntervalMs: 1000,
  SendTimeoutMs: 20000,
  LeaseSafetyMarginMs: 10000,
} as const;

export const DispatchEvent = {
  ClaimFailed: 'processing_dispatch_claim_failed',
  Sent: 'processing_dispatch_sent',
  SendFailed: 'processing_dispatch_send_failed',
  RetryFailed: 'processing_dispatch_retry_failed',
  AcknowledgeFailed: 'processing_dispatch_acknowledge_failed',
  LeaseLost: 'processing_dispatch_lease_lost',
  ConnectionFailed: 'processing_dispatch_connection_failed',
} as const;
