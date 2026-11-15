import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { readStorageConfig } from '../src/storage/config.js';
import { createDocumentStorage } from '../src/storage/s3.js';

const env = {
  S3_BUCKET: 'caseflow-test-documents',
  AWS_REGION: 'us-east-2',
  S3_ENVIRONMENT: 'dev',
  AWS_PROFILE: 'caseflow-api-dev',
};

test('S3 configuration is opt-in, complete, and server-only', () => {
  assert.equal(readStorageConfig({}), undefined);
  assert.equal(readStorageConfig({ AWS_REGION: 'us-east-2', AWS_PROFILE: 'personal' }), undefined);
  assert.deepEqual(readStorageConfig(env), {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    environment: env.S3_ENVIRONMENT,
    profile: env.AWS_PROFILE,
  });

  const config = readConfig({
    ...env,
    ENTRA_API_CLIENT_ID: '10000000-0000-4000-8000-000000000001',
    ENTRA_WEB_CLIENT_ID: '10000000-0000-4000-8000-000000000002',
    DATABASE_URL: 'postgresql://caseflow_runtime:test@localhost/postgres',
  });

  assert.deepEqual(config.storage, readStorageConfig(env));
  assert.equal(readStorageConfig({ ...env, AWS_PROFILE: undefined })?.profile, undefined);
});

test('partial or unsafe S3 settings fail without revealing their values', () => {
  for (const patch of [
    { S3_BUCKET: undefined },
    { S3_BUCKET: '' },
    { S3_BUCKET: 's3://private-bucket/secret' },
    { S3_BUCKET: 'UPPERCASE' },
    { S3_BUCKET: '127.0.0.1' },
    { S3_BUCKET: 'test..bucket' },
    { S3_BUCKET: 'test--x-s3' },
    { AWS_REGION: undefined },
    { AWS_REGION: 'https://not-a-region/secret' },
    { S3_ENVIRONMENT: undefined },
    { S3_ENVIRONMENT: '../prod' },
    { S3_ENVIRONMENT: 'dev/secret' },
    { AWS_PROFILE: '' },
    { AWS_PROFILE: '../secret' },
  ]) {
    assert.throws(
      () => readStorageConfig({ ...env, ...patch }),
      (error: Error) => !error.message.includes('secret'),
    );
  }
});

test('S3 uses the explicit profile instead of ambient credentials and signs for the configured region', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'caseflow-aws-test-'));
  const credentials = join(directory, 'credentials');
  const config = join(directory, 'config');
  await writeFile(
    credentials,
    '[caseflow-api-dev]\naws_access_key_id = TEST_RESTRICTED\naws_secret_access_key = test-only-secret\n',
    { mode: 0o600 },
  );
  await writeFile(config, '', { mode: 0o600 });

  const environment = {
    AWS_SHARED_CREDENTIALS_FILE: credentials,
    AWS_CONFIG_FILE: config,
    AWS_ACCESS_KEY_ID: 'TEST_ADMIN',
    AWS_SECRET_ACCESS_KEY: 'ambient-test-only-secret',
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));

  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await rm(directory, { recursive: true, force: true });
  });
  Object.assign(process.env, environment);

  const storage = createDocumentStorage(readStorageConfig(env)!);
  let requested = false;

  storage.client.middlewareStack.add(
    () => async (args) => {
      const request = args.request as { hostname: string; headers: Record<string, string> };
      assert.equal(request.hostname, 'caseflow-test-documents.s3.us-east-2.amazonaws.com');
      assert.match(request.headers.authorization ?? '', /Credential=TEST_RESTRICTED\//);
      assert.match(request.headers.authorization ?? '', /us-east-2\/s3\/aws4_request/);
      requested = true;

      return { response: {}, output: { $metadata: {}, ContentLength: 100 } };
    },
    { step: 'finalizeRequest', name: 'captureSignedRequest', priority: 'low' },
  );

  try {
    await storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: 'test.pdf' }));
    assert.equal(requested, true);
  } finally {
    storage.client.destroy();
  }
});

test('Fastify owns the S3 client lifecycle without requesting credentials on startup', async (t) => {
  const app = await buildApp(
    {
      clientId: '10000000-0000-4000-8000-000000000001',
      webClientId: '10000000-0000-4000-8000-000000000002',
      databaseUrl: '',
      webOrigin: 'http://localhost:3000',
      storage: readStorageConfig(env),
    },
    async () => {
      throw new Error('Unexpected authentication');
    },
    false,
    {
      execute: async () => {
        throw new Error('Unexpected database request');
      },
      close: async () => {},
    },
  );
  assert.ok(app.documentStorage);
  const destroy = t.mock.method(app.documentStorage.client, 'destroy');

  await app.ready();
  await app.close();
  assert.equal(destroy.mock.callCount(), 1);
});
