export const ErrorCode = {
  Unauthenticated: 'UNAUTHENTICATED',
  AccountDisabled: 'ACCOUNT_DISABLED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  InvalidInput: 'INVALID_INPUT',
  InsufficientScope: 'INSUFFICIENT_SCOPE',
  ServiceUnavailable: 'SERVICE_UNAVAILABLE',
  InternalError: 'INTERNAL_ERROR',
  LastSuperAdmin: 'LAST_SUPER_ADMIN',
  RequestFailed: 'REQUEST_FAILED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
