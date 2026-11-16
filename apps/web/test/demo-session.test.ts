import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  clearDemoSession,
  isDemoSessionUsable,
  readDemoSession,
  saveDemoSession,
  startDemoSession,
} from '../lib/demo-session';

process.env.NEXT_PUBLIC_ENTRA_WEB_CLIENT_ID = '21423ef9-28b7-4c69-a91c-221c1e2cd564';
process.env.NEXT_PUBLIC_ENTRA_API_SCOPE =
  'api://f0d8466d-2736-44d3-b22a-d581a7ac7acc/access_as_user';
process.env.NEXT_PUBLIC_API_ORIGIN = 'http://localhost:4000';

const store = new Map<string, string>();
Object.assign(globalThis, {
  window: {
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  },
});
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  store.clear();
});

const now = Date.UTC(2026, 10, 16, 12);
const session = {
  accessToken: 'header.payload.signature-long-enough',
  expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
};

test('demo sessions are usable until shortly before they expire', () => {
  assert.equal(isDemoSessionUsable(session, now), true);
  assert.equal(isDemoSessionUsable(session, now + 60 * 60 * 1000 - 10_000), false);
});

test('stored demo sessions survive navigation and are cleared when expired or tampered', () => {
  saveDemoSession(session);
  assert.deepEqual(readDemoSession(now), session);
  assert.equal(readDemoSession(now + 2 * 60 * 60 * 1000), null);
  assert.equal(store.size, 0, 'an expired session is removed');

  store.set('caseflow:demo-session', '{"accessToken":"x"}');
  assert.equal(readDemoSession(now), null);
  assert.equal(store.size, 0, 'an invalid session is removed');

  saveDemoSession(session);
  clearDemoSession();
  assert.equal(readDemoSession(now), null);
});

test('starting a demo posts to the API and explains unavailable or refused demos', async () => {
  const calls: [string, RequestInit | undefined][] = [];
  const respond = (status: number, body: unknown) =>
    (globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch);

  respond(201, session);
  assert.deepEqual(await startDemoSession(), session);
  assert.equal(calls[0]?.[0], 'http://localhost:4000/auth/demo-session');
  assert.equal(calls[0]?.[1]?.method, 'POST');
  assert.equal(new Headers(calls[0]?.[1]?.headers).has('authorization'), false);

  respond(404, { error: 'Not found' });
  await assert.rejects(startDemoSession(), /isn’t available/);
  respond(403, { code: 'ACCOUNT_DISABLED', error: 'Demo access is currently turned off.' });
  await assert.rejects(startDemoSession(), /turned off/);
  respond(201, { accessToken: 'short', expiresAt: 'soon' });
  await assert.rejects(startDemoSession());
});
