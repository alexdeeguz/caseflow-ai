import { ErrorCode, errorCodeSchema } from '@caseflow/schemas';
import { AppError } from '../errors.js';

const PostgresErrorCode = {
  RaiseException: 'P0001',
  ForeignKeyViolation: '23503',
  CheckViolation: '23514',
  InvalidTextRepresentation: '22P02',
} as const;

const inputErrorCodes: ReadonlySet<string> = new Set([
  PostgresErrorCode.ForeignKeyViolation,
  PostgresErrorCode.CheckViolation,
  PostgresErrorCode.InvalidTextRepresentation,
]);

const applicationErrors: Partial<Record<ErrorCode, { status: number; message: string }>> = {
  [ErrorCode.Unauthenticated]: { status: 401, message: 'Sign in to continue.' },
  [ErrorCode.AccountDisabled]: {
    status: 403,
    message: 'Your account is disabled. Contact an administrator.',
  },
  [ErrorCode.Forbidden]: { status: 403, message: 'You do not have permission for this action.' },
  [ErrorCode.NotFound]: { status: 404, message: 'Not found.' },
  [ErrorCode.InvalidInput]: { status: 400, message: 'Check the supplied values.' },
};

export function databaseError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (typeof error === 'object' && error !== null) {
    const code = 'code' in error ? error.code : undefined;
    const message = 'message' in error ? error.message : undefined;
    const parsed = errorCodeSchema.safeParse(message);

    if (code === PostgresErrorCode.RaiseException && parsed.success) {
      const known = applicationErrors[parsed.data];

      if (known) {
        return new AppError(parsed.data, known.status, known.message);
      }
    }

    if (typeof code === 'string' && inputErrorCodes.has(code)) {
      return new AppError(ErrorCode.InvalidInput, 400, 'Check the supplied values.');
    }
  }

  return new AppError(
    ErrorCode.ServiceUnavailable,
    503,
    'CaseFlow is temporarily unavailable. Please try again.',
  );
}
