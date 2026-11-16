import { demoSessionSchema, type DemoSession } from '@caseflow/schemas';
import { getPublicConfig } from './config';

const storageKey = 'caseflow:demo-session';
/** Treat a session as ended slightly early so requests never race its expiry. */
const expiryMarginMs = 30_000;

export function isDemoSessionUsable(session: DemoSession, now = Date.now()): boolean {
  return Date.parse(session.expiresAt) - expiryMarginMs > now;
}

/** The demo session for this browser tab, if one is still usable. */
export function readDemoSession(now = Date.now()): DemoSession | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    const session = raw ? demoSessionSchema.parse(JSON.parse(raw)) : null;
    if (session && isDemoSessionUsable(session, now)) {
      return session;
    }
  } catch {
    // Unreadable or tampered storage is treated as signed out.
  }
  clearDemoSession();
  return null;
}

export function saveDemoSession(session: DemoSession) {
  window.sessionStorage.setItem(storageKey, JSON.stringify(session));
}

export function clearDemoSession() {
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // Storage may be unavailable (e.g. blocked); there is nothing to clear.
  }
}

/** Asks the API for a shared demo Admin session; fails when demo sign-in is not enabled. */
export async function startDemoSession(): Promise<DemoSession> {
  let response: Response;
  try {
    response = await fetch(`${getPublicConfig().apiOrigin}/auth/demo-session`, {
      method: 'POST',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('Unable to reach CaseFlow. Please try again shortly.');
  }
  if (response.status === 404) {
    throw new Error('The demo isn’t available right now.');
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : 'The demo could not start. Please try again.';
    throw new Error(message);
  }
  return demoSessionSchema.parse(await response.json());
}
