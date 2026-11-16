import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readLambdaConfig } from '../src/lambda/config.js';
import { createLambdaProxy } from '../src/lambda/adapter.js';
import { buildApp } from '../src/app.js';

const project = 'abcdefghijklmnopqrst';
const env = {
  ENTRA_API_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
  ENTRA_WEB_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
  WEB_ORIGIN: 'https://caseflow.example.com',
  DATABASE_HOST: 'aws-0-us-east-2.pooler.supabase.com',
  DATABASE_PROJECT_REF: project,
  S3_BUCKET: 'caseflow-documents',
  S3_ENVIRONMENT: 'dev',
  AWS_REGION: 'us-east-2',
};
const connection = `postgresql://caseflow_runtime.${project}:private-test-password@${env.DATABASE_HOST}:6543/postgres?sslmode=verify-full`;
const secret = JSON.stringify({ database_url: connection });

test('Lambda requires the restricted transaction pooler and its bundled certificate', () => {
  const config = readLambdaConfig(secret, env);
  assert.match(config.databaseUrl, /sslrootcert=/);
  assert.equal(config.dispatcher, undefined);
  assert.equal(config.factDispatcher, undefined);
  for (const value of [
    connection.replace('caseflow_runtime', 'postgres'),
    connection.replace('6543', '5432'),
    connection.replace('verify-full', 'require'),
    connection + '&host=evil.example',
  ]) {
    assert.throws(() => readLambdaConfig(JSON.stringify({ database_url: value }), env), {
      message: 'Invalid API Lambda configuration.',
    });
  }
  for (const overrides of [
    { AWS_PROFILE: 'personal' },
    { FACT_EXTRACTION_DISPATCHER_ENABLED: 'true' },
    { PROCESSING_DISPATCHER_ENABLED: 'true' },
    { SEARCH_INDEX_DISPATCHER_ENABLED: 'true' },
    { WEB_ORIGIN: 'http://localhost:3000' },
  ]) {
    assert.throws(() => readLambdaConfig(secret, { ...env, ...overrides }));
  }
  assert.throws(() =>
    readLambdaConfig(JSON.stringify({ database_url: connection, password: 'unknown' }), env),
  );
});

test('Lambda demo configuration uses only the stored secret and fails closed when incomplete', () => {
  const demoSecret = 'test-demo-signing-secret-with-at-least-32-characters';
  const configured = JSON.stringify({ database_url: connection, demo_session_secret: demoSecret });
  const enabled = { ...env, DEMO_LOGIN_ENABLED: 'true' };

  assert.equal(readLambdaConfig(configured, env).demo, undefined);
  assert.equal(readLambdaConfig(configured, enabled).demo?.secret, demoSecret);
  assert.equal(
    readLambdaConfig(configured, { ...enabled, DEMO_SESSION_SECRET: 'untrusted-environment-value' })
      .demo?.secret,
    demoSecret,
  );

  for (const [value, environment] of [
    [secret, enabled],
    [secret, { ...enabled, DEMO_SESSION_SECRET: demoSecret }],
    [JSON.stringify({ database_url: connection, demo_session_secret: 'short' }), enabled],
    [configured, { ...env, DEMO_LOGIN_ENABLED: 'unexpected' }],
  ] as const) {
    assert.throws(() => readLambdaConfig(value, environment), {
      message: 'Invalid API Lambda configuration.',
    });
  }
});

test('HTTP API proxy preserves authentication, CORS, no-store, and validation', async () => {
  const { AuthError } = await import('../src/auth.js');
  let calls = 0;
  const app = await buildApp(
    readLambdaConfig(secret, env),
    async () => {
      throw new AuthError(401);
    },
    false,
    {
      execute: async () => {
        calls++;
        return {};
      },
      close: async () => {},
    },
  );
  const proxy = createLambdaProxy(app);
  await app.ready();
  const request = (method: string, path: string, headers: Record<string, string> = {}) => ({
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers,
    requestContext: {
      accountId: '123456789012',
      apiId: 'test',
      domainName: 'test.execute-api.us-east-2.amazonaws.com',
      domainPrefix: 'test',
      requestId: 'test',
      routeKey: '$default',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
    },
    isBase64Encoded: false,
  });
  try {
    const unauthorized = await proxy(request('GET', '/me', { origin: env.WEB_ORIGIN }), {});
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unauthorized.headers['cache-control'], 'no-store');
    assert.equal(unauthorized.headers['access-control-allow-origin'], env.WEB_ORIGIN);
    assert.equal(calls, 0);
    const preflight = await proxy(
      request('OPTIONS', '/cases', {
        origin: env.WEB_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      }),
      {},
    );
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], env.WEB_ORIGIN);
  } finally {
    await app.close();
  }
});
