import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Identity } from './auth.js';

/**
 * The shared demo account. The all-zero tenant never appears in a verified Microsoft token (the
 * Microsoft verifier also rejects it), so only API-issued demo sessions can act as this profile.
 * Its Admin role is seeded by migration; disabling the profile turns demo access off.
 */
export const DemoIdentity: Identity = {
  tenantId: '00000000-0000-0000-0000-000000000000',
  subject: 'caseflow-demo-admin',
  name: 'Demo Admin',
};

export const DEMO_ISSUER = 'caseflow-demo';
const DEMO_AUDIENCE = 'caseflow-api';
export const DEMO_SESSION_SECONDS = 60 * 60;

export interface DemoConfig {
  secret: string;
}

export interface DemoSessions {
  issue(): Promise<{ accessToken: string; expiresAt: string }>;
  verify(token: string): Promise<Identity>;
}

/** Demo sign-in is off unless explicitly enabled with a strong signing secret. */
export function readDemoConfig(env: NodeJS.ProcessEnv): DemoConfig | undefined {
  if (env.DEMO_LOGIN_ENABLED !== 'true') {
    return undefined;
  }
  const secret = env.DEMO_SESSION_SECRET ?? '';
  if (secret.length < 32) {
    throw new Error(
      'Set DEMO_SESSION_SECRET to at least 32 random characters to enable demo sign-in.',
    );
  }
  return { secret };
}

export function createDemoSessions(
  { secret }: DemoConfig,
  now: () => number = Date.now,
): DemoSessions {
  const key = new TextEncoder().encode(secret);

  return {
    async issue() {
      const issuedAt = Math.floor(now() / 1000);
      const expiresAt = issuedAt + DEMO_SESSION_SECONDS;
      const accessToken = await new SignJWT({ tid: DemoIdentity.tenantId })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(DEMO_ISSUER)
        .setAudience(DEMO_AUDIENCE)
        .setSubject(DemoIdentity.subject)
        .setJti(randomUUID())
        .setIssuedAt(issuedAt)
        .setNotBefore(issuedAt)
        .setExpirationTime(expiresAt)
        .sign(key);

      return { accessToken, expiresAt: new Date(expiresAt * 1000).toISOString() };
    },
    async verify(token) {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        issuer: DEMO_ISSUER,
        audience: DEMO_AUDIENCE,
        subject: DemoIdentity.subject,
        requiredClaims: ['exp', 'iat', 'nbf', 'jti', 'tid'],
        maxTokenAge: DEMO_SESSION_SECONDS + 60,
        clockTolerance: 5,
        currentDate: new Date(now()),
      });

      if (payload.tid !== DemoIdentity.tenantId) {
        throw new Error('Unexpected demo tenant.');
      }
      return { ...DemoIdentity };
    },
  };
}

/** Fixed-window limit per client address; bounds how fast demo sessions can be minted. */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();

  return (key: string) => {
    const time = now();
    const current = windows.get(key);

    if (!current || time - current.start >= windowMs) {
      windows.set(key, { start: time, count: 1 });
      // Bound memory: forget the oldest client once many have been seen.
      if (windows.size > 10_000) {
        windows.delete(windows.keys().next().value!);
      }
      return true;
    }
    current.count++;
    return current.count <= limit;
  };
}
