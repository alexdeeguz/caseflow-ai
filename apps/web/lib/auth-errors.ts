import { ApiError } from './api';

export function isAccessRejected(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}
