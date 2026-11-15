import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRemoteJWKSet,
  customFetch,
  exportJWK,
  generateKeyPair,
  jwksCache,
  SignJWT,
  type JWTPayload,
} from 'jose';
import { createTokenVerifier } from '../src/auth.js';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

const config = {
  clientId: 'f0d8466d-2736-44d3-b22a-d581a7ac7acc',
  webClientId: '21423ef9-28b7-4c69-a91c-221c1e2cd564',
  webOrigin: 'http://localhost:3000',
  databaseUrl: 'postgresql://caseflow_runtime:test@127.0.0.1:54322/postgres',
};

const profile = {
  id: '20000000-0000-4000-8000-000000000001',
  displayName: 'Demo User',
  role: 'staff',
  active: true,
};

const store = { execute: async () => profile, close: async () => {} };
const tenant = '11111111-2222-3333-4444-555555555555';
const personalTenant = '9188040d-6c67-4c5b-b112-36a304b66dad';
const keyPair = await generateKeyPair('RS256');
const publicKey = await exportJWK(keyPair.publicKey);
const now = Math.floor(Date.now() / 1000);

const claims: JWTPayload = {
  iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
  aud: config.clientId,
  sub: 'test-subject',
  tid: tenant,
  ver: '2.0',
  azp: config.webClientId,
  scp: 'access_as_user',
  name: 'Demo User',
  iat: now,
  nbf: now - 5,
  exp: now + 3600,
};

function resolver(keyIssuer = 'https://login.microsoftonline.com/{tenantid}/v2.0') {
  const signingKey = { ...publicKey, kid: 'test-key', alg: 'RS256', use: 'sig', issuer: keyIssuer };

  return createRemoteJWKSet(new URL('https://example.invalid/keys'), {
    [jwksCache]: { uat: Date.now(), jwks: { keys: [signingKey] } },
    [customFetch]: async () => {
      throw new Error('Tests must not fetch real signing keys');
    },
  });
}

async function sign(overrides: JWTPayload = {}, omit: string[] = [], key = keyPair.privateKey) {
  const payload = { ...claims, ...overrides };

  for (const claim of omit) {
    delete payload[claim];
  }

  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(key);
}

async function request(token?: string, keyIssuer?: string) {
  const app = await buildApp(
    config,
    createTokenVerifier(config, resolver(keyIssuer)),
    false,
    store,
  );

  try {
    return await app.inject({
      method: 'GET',
      url: '/me',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  } finally {
    await app.close();
  }
}

test('accepts a signed organizational token and returns the persisted profile', async () => {
  const result = await request(await sign());

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.deepEqual(result.json(), profile);
});

test('accepts personal accounts with a matching consumer-scoped signing key', async () => {
  const issuer = `https://login.microsoftonline.com/${personalTenant}/v2.0`;
  const result = await request(await sign({ tid: personalTenant, iss: issuer }), issuer);

  assert.equal(result.statusCode, 200);
});

for (const [name, override] of Object.entries({
  'wrong audience': { aud: 'another-api' },
  'wrong issuer': { iss: 'https://attacker.example/v2.0' },
  'issuer/tenant mismatch': { tid: personalTenant },
  'invalid tenant ID': { tid: '../common' },
  'wrong calling app': { azp: 'another-client' },
  'expired token': { exp: now - 60 },
  'future not-before': { nbf: now + 600 },
  'v1 token': { ver: '1.0' },
  'empty subject': { sub: '' },
})) {
  test(`rejects ${name}`, async () =>
    assert.equal((await request(await sign(override))).statusCode, 401));
}

for (const claim of ['exp', 'iat', 'nbf', 'sub', 'tid', 'ver', 'azp']) {
  test(`rejects missing ${claim}`, async () =>
    assert.equal((await request(await sign({}, [claim]))).statusCode, 401));
}

test('rejects a signature from an untrusted key', async () => {
  const other = await generateKeyPair('RS256');

  assert.equal((await request(await sign({}, [], other.privateKey))).statusCode, 401);
});

test('rejects a tenant-scoped signing key for another tenant', async () => {
  assert.equal(
    (await request(await sign(), `https://login.microsoftonline.com/${personalTenant}/v2.0`))
      .statusCode,
    401,
  );
});

for (const scope of [undefined, 'access_as_user_extra', 'other_scope']) {
  test(`rejects missing or incorrect delegated scope: ${scope}`, async () => {
    assert.equal((await request(await sign({ scp: scope }))).statusCode, 403);
  });
}

test('allows multiple scopes when the required scope is present', async () => {
  assert.equal((await request(await sign({ scp: 'openid access_as_user' }))).statusCode, 200);
});

test('missing and malformed tokens return 401 without leaking credentials', async () => {
  assert.equal((await request()).statusCode, 401);

  const result = await request('not-a-token');

  assert.equal(result.statusCode, 401);
  assert.ok(result.headers['www-authenticate']);
  assert.ok(!result.body.includes('not-a-token'));
});

test('signing-key provider failure fails closed with 503', async () => {
  const keys = createRemoteJWKSet(new URL('https://example.invalid/keys'), {
    [customFetch]: async () => {
      throw new TypeError('network unavailable');
    },
  });
  const app = await buildApp(config, createTokenVerifier(config, keys), false, store);

  try {
    const result = await app.inject({
      url: '/me',
      headers: { authorization: `Bearer ${await sign()}` },
    });

    assert.equal(result.statusCode, 503);
    assert.ok(!result.body.includes('network unavailable'));
  } finally {
    await app.close();
  }
});

test('CORS allows only the configured frontend origin', async () => {
  const app = await buildApp(config, undefined, false, store);

  try {
    for (const origin of [config.webOrigin, 'https://attacker.example']) {
      const result = await app.inject({
        method: 'OPTIONS',
        url: '/me',
        headers: {
          origin,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      });

      assert.equal(result.headers['access-control-allow-origin'], config.webOrigin);
      assert.notEqual(result.headers['access-control-allow-origin'], '*');
    }
  } finally {
    await app.close();
  }
});

test('configuration fails early on missing IDs and unsafe origins', () => {
  assert.throws(() => readConfig({}));
  assert.throws(() =>
    readConfig({
      ENTRA_API_CLIENT_ID: config.clientId,
      ENTRA_WEB_CLIENT_ID: config.webClientId,
      WEB_ORIGIN: 'http://example.com',
    }),
  );
  assert.deepEqual(
    readConfig({
      ENTRA_API_CLIENT_ID: config.clientId,
      ENTRA_WEB_CLIENT_ID: config.webClientId,
      DATABASE_URL: config.databaseUrl,
    }),
    config,
  );
});

test('rejects privileged and unverified remote database connections', () => {
  const base = { ENTRA_API_CLIENT_ID: config.clientId, ENTRA_WEB_CLIENT_ID: config.webClientId };

  for (const url of [
    'postgresql://postgres:secret@localhost/postgres',
    'postgresql://caseflow_runtime:secret@db.example.com/postgres',
  ]) {
    assert.throws(() => readConfig({ ...base, DATABASE_URL: url }));
  }
});

test('invalid database URLs do not leak their contents in configuration errors', () => {
  assert.throws(
    () =>
      readConfig({
        ENTRA_API_CLIENT_ID: config.clientId,
        ENTRA_WEB_CLIENT_ID: config.webClientId,
        DATABASE_URL: 'secret-password-not-a-url',
      }),
    (error: Error) => !error.message.includes('secret-password'),
  );
});

test('database query parameters cannot override validated connection settings', () => {
  const base = {
    ENTRA_API_CLIENT_ID: config.clientId,
    ENTRA_WEB_CLIENT_ID: config.webClientId,
  };

  for (const query of [
    'user=postgres',
    'host=db.example.com',
    'port=5432',
    'password=other-password',
    'options=-c%20role%3Dpostgres',
    'statement_timeout=0',
    'sslmode=verify-full&sslmode=disable',
    'sslmode=verify-full&ssl=no-verify',
  ]) {
    assert.throws(() => readConfig({ ...base, DATABASE_URL: `${config.databaseUrl}?${query}` }));
  }

  const verified =
    'postgresql://caseflow_runtime:secret@db.example.com/postgres?sslmode=verify-full';

  assert.equal(readConfig({ ...base, DATABASE_URL: verified }).databaseUrl, verified);
});
