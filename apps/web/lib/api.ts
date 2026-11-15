import { ErrorCode, userSchema } from '@caseflow/schemas';

import { getPublicConfig } from './config';

export type Parser<T> = { parse(value: unknown): T };

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function apiRequest<T>(
  accessToken: string,
  path: string,
  schema: Parser<T>,
  options: RequestInit = {},
): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Invalid API path.');
  }

  let response: Response;

  try {
    response = await fetch(`${getPublicConfig().apiOrigin}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      cache: 'no-store',
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw new DOMException('Request cancelled', 'AbortError');
    }

    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      throw new Error('The server took too long to respond. Please try again.');
    }

    throw new Error('Unable to reach CaseFlow. Please try again shortly.');
  }

  if (!response.ok) {
    let code: string = ErrorCode.RequestFailed;

    try {
      const body = await response.json();

      if (typeof body?.code === 'string') {
        code = body.code;
      }
    } catch {
      /* Non-JSON error responses use the generic status message. */
    }

    const messages: Record<number, string> = {
      400: 'Check the supplied values.',
      401: 'Your session could not be verified. Please sign in again.',
      403:
        code === ErrorCode.AccountDisabled
          ? 'Your account is disabled. Contact an administrator.'
          : 'You do not have permission for this action.',
      404: 'This item is unavailable or you no longer have access.',
      409:
        code === ErrorCode.CaseArchived
          ? 'Restore this archived case before editing it.'
          : 'This case changed. Reload the latest saved case before trying again.',
      503: 'CaseFlow is temporarily unavailable. Please try again.',
    };

    throw new ApiError(
      response.status,
      code,
      messages[response.status] ?? 'The API request failed. Please try again.',
    );
  }

  try {
    return schema.parse(await response.json());
  } catch {
    throw new Error('The API returned an unexpected response.');
  }
}

export const fetchIdentity = (token: string) => apiRequest(token, '/me', userSchema);
