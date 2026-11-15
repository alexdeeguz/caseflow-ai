import type { ErrorCode } from '@caseflow/schemas';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
