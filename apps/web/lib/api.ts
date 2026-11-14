import { getPublicConfig } from './config';

export interface DemoIdentity {
  subject: string;
  tenantId: string;
  name: string | null;
  access: 'demo';
}

export async function fetchIdentity(accessToken: string): Promise<DemoIdentity> {
  const { apiOrigin } = getPublicConfig();
  let response: Response;
  try {
    response = await fetch(`${apiOrigin}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error('The server took too long to respond. Please try again.');
    }
    throw new Error('Unable to reach CaseFlow. Please try again shortly.');
  }
  if (!response.ok) {
    const messages: Record<number, string> = {
      401: 'The API could not verify your sign-in. Sign out and try again.',
      403: 'Your account does not have the required permission. Please contact the demo owner.',
      503: 'Microsoft verification is temporarily unavailable. Try again shortly.',
    };
    throw new Error(messages[response.status] ?? 'The API request failed. Please try again.');
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error('The API returned an unexpected response.');
  }
  if (
    typeof data !== 'object' ||
    data === null ||
    !('subject' in data) ||
    typeof data.subject !== 'string' ||
    !('tenantId' in data) ||
    typeof data.tenantId !== 'string' ||
    !('name' in data) ||
    (data.name !== null && typeof data.name !== 'string') ||
    !('access' in data) ||
    data.access !== 'demo'
  ) {
    throw new Error('The API returned an unexpected response.');
  }
  return { subject: data.subject, tenantId: data.tenantId, name: data.name, access: data.access };
}
