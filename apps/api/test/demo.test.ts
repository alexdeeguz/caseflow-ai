import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SignJWT,
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  exportJWK,
  generateKeyPair,
  jwksCache,
} from 'jose';
import { demoSessionSchema } from '@caseflow/schemas';
import { buildApp } from '../src/app.js';
import { createTokenVerifier } from '../src/auth.js';
import { readConfig } from '../src/config.js';
import {
  DEMO_SESSION_SECONDS,
  DemoIdentity,
  createDemoSessions,
  createRateLimiter,
  readDemoConfig,
} from '../src/demo.js';

const secret = 'a'.repeat(24) + 'b'.repeat(24);
const config = {
  clientId: 'f0d8466d-2736-44d3-b22a-d581a7ac7acc',
  webClientId: '21423ef9-28b7-4c69-a91c-221c1e2cd564',
  webOrigin: 'http://localhost:3000',
  databaseUrl: 'postgresql://caseflow_runtime:test@127.0.0.1:54322/postgres',
};
const profile = {
  id: '20000000-0000-4000-8000-000000000001',
  displayName: 'Demo Admin',
  role: 'admin',
  active: true,
};
const noKeys = createRemoteJWKSet(new URL('https://example.invalid/keys'), {
  [jwksCache]: { uat: Date.now(), jwks: { keys: [] } },
  [customFetch]: async () => {
    throw new Error('Tests must not fetch real signing keys');
  },
});

test('demo sign-in is off by default and requires a strong secret when enabled', () => {
  assert.equal(readDemoConfig({}), undefined);
  assert.equal(
    readDemoConfig({ DEMO_LOGIN_ENABLED: 'false', DEMO_SESSION_SECRET: secret }),
    undefined,
  );
  assert.throws(() => readDemoConfig({ DEMO_LOGIN_ENABLED: 'true' }), /DEMO_SESSION_SECRET/);
  assert.throws(
    () => readDemoConfig({ DEMO_LOGIN_ENABLED: 'true', DEMO_SESSION_SECRET: 'short' }),
    /DEMO_SESSION_SECRET/,
  );
  assert.deepEqual(readDemoConfig({ DEMO_LOGIN_ENABLED: 'true', DEMO_SESSION_SECRET: secret }), {
    secret,
  });
  const env = {
    ENTRA_API_CLIENT_ID: config.clientId,
    ENTRA_WEB_CLIENT_ID: config.webClientId,
    DATABASE_URL: config.databaseUrl,
  };
  assert.equal(readConfig(env).demo, undefined);
  assert.deepEqual(
    readConfig({ ...env, DEMO_LOGIN_ENABLED: 'true', DEMO_SESSION_SECRET: secret }).demo,
    { secret },
  );
});

test('demo sessions verify as the demo identity and expire after an hour', async () => {
  let now = Date.UTC(2026, 10, 16, 12);
  const sessions = createDemoSessions({ secret }, () => now);
  const session = demoSessionSchema.parse(await sessions.issue());

  assert.equal(Date.parse(session.expiresAt) - now, DEMO_SESSION_SECONDS * 1000);
  assert.deepEqual(await sessions.verify(session.accessToken), DemoIdentity);
  assert.notEqual(
    decodeJwt(session.accessToken).jti,
    decodeJwt((await sessions.issue()).accessToken).jti,
  );

  now += (DEMO_SESSION_SECONDS + 10) * 1000;
  await assert.rejects(sessions.verify(session.accessToken));
});

test('demo tokens signed with another secret, algorithm, or subject are rejected', async () => {
  const sessions = createDemoSessions({ secret });
  const other = createDemoSessions({ secret: 'c'.repeat(48) });
  const key = new TextEncoder().encode(secret);
  const now = Math.floor(Date.now() / 1000);
  const forge = (claims: Record<string, unknown>, alg = 'HS256') =>
    new SignJWT({ tid: DemoIdentity.tenantId, ...claims })
      .setProtectedHeader({ alg })
      .setIssuer('caseflow-demo')
      .setAudience('caseflow-api')
      .setSubject(String(claims.sub ?? DemoIdentity.subject))
      .setJti('forged')
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 60)
      .sign(alg === 'HS512' ? new TextEncoder().encode(secret + secret) : key);

  await assert.rejects(sessions.verify((await other.issue()).accessToken));
  await assert.rejects(sessions.verify(await forge({ sub: 'someone-else' })));
  await assert.rejects(
    sessions.verify(await forge({ tid: '11111111-2222-3333-4444-555555555555' })),
  );
  await assert.rejects(sessions.verify(await forge({}, 'HS512')));
  assert.deepEqual(await sessions.verify(await forge({})), DemoIdentity);
});

test('the API accepts demo sessions only when demo sign-in is enabled', async () => {
  const store = {
    execute: async (identity: { tenantId: string; subject: string }) => {
      assert.equal(identity.tenantId, DemoIdentity.tenantId);
      assert.equal(identity.subject, DemoIdentity.subject);
      return profile;
    },
    close: async () => {},
  };
  const enabled = { ...config, demo: { secret } };
  const app = await buildApp(enabled, createTokenVerifier(enabled, noKeys), false, store);
  const disabled = await buildApp(config, createTokenVerifier(config, noKeys), false, store);

  try {
    const created = await app.inject({ method: 'POST', url: '/auth/demo-session' });
    assert.equal(created.statusCode, 201);
    assert.equal(created.headers['cache-control'], 'no-store');
    const session = demoSessionSchema.parse(created.json());

    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().role, 'admin');

    assert.equal(
      (await disabled.inject({ method: 'POST', url: '/auth/demo-session' })).statusCode,
      404,
    );
    const rejected = await disabled.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    assert.equal(rejected.statusCode, 401);
    assert.equal(rejected.body.includes(session.accessToken), false);
  } finally {
    await app.close();
    await disabled.close();
  }
});

test('demo session creation is rate limited per client', async () => {
  let now = 0;
  const allow = createRateLimiter(2, 1000, () => now);
  assert.deepEqual([allow('a'), allow('a'), allow('a'), allow('b')], [true, true, false, true]);
  now = 1000;
  assert.equal(allow('a'), true);

  const app = await buildApp({ ...config, demo: { secret } }, undefined, false, {
    execute: async () => profile,
    close: async () => {},
  });
  try {
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await app.inject({ method: 'POST', url: '/auth/demo-session' })).statusCode);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(201));
    assert.equal(statuses[10], 429);
  } finally {
    await app.close();
  }
});

test('Microsoft tokens can never claim the demo tenant', async () => {
  const keyPair = await generateKeyPair('RS256');
  const publicKey = await exportJWK(keyPair.publicKey);
  const signingKey = {
    ...publicKey,
    kid: 'test-key',
    alg: 'RS256',
    use: 'sig',
    issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
  };
  const keys = createRemoteJWKSet(new URL('https://example.invalid/keys'), {
    [jwksCache]: { uat: Date.now(), jwks: { keys: [signingKey] } },
    [customFetch]: async () => {
      throw new Error('Tests must not fetch real signing keys');
    },
  });
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    iss: `https://login.microsoftonline.com/${DemoIdentity.tenantId}/v2.0`,
    aud: config.clientId,
    sub: DemoIdentity.subject,
    tid: DemoIdentity.tenantId,
    ver: '2.0',
    azp: config.webClientId,
    scp: 'access_as_user',
    iat: now,
    nbf: now - 5,
    exp: now + 3600,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(keyPair.privateKey);

  await assert.rejects(
    createTokenVerifier({ ...config, demo: { secret } }, keys)(token),
    (error: Error & { statusCode?: number }) => error.statusCode === 401,
  );
});
