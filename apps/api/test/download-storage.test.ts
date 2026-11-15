import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { downloadAuthorizationSchema, documentDownloadRequestSchema } from '@caseflow/schemas';
import type { DownloadRecord } from '../src/database/documents.js';
import { createDownloadStorage } from '../src/storage/downloads.js';

function record(filename = 'Fictional record.pdf'): DownloadRecord {
  const timestamp = new Date().toISOString();

  return {
    document: {
      id: randomUUID(),
      caseId: randomUUID(),
      uploadedBy: randomUUID(),
      filename,
      contentType: 'application/pdf',
      sizeBytes: 100,
      status: 'available',
      version: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
      uploadedAt: timestamp,
      removedAt: null,
      removedBy: null,
    },
    storage: {
      bucket: 'caseflow-test-documents',
      key: 'dev/cases/test/documents/test/original/file.pdf',
      objectVersionId: 'saved-version+/=',
    },
  };
}

function storage(head: Record<string, unknown> = {}, fail = false) {
  let headCalls = 0;
  const client = new S3Client({
    region: 'us-east-2',
    credentials: { accessKeyId: 'TEST_ONLY', secretAccessKey: 'test-only' },
  });

  client.middlewareStack.add(
    (next, context) => async (args) => {
      if (context.commandName !== 'HeadObjectCommand') {
        return next(args);
      }

      headCalls++;
      assert.equal((args.input as { VersionId: string }).VersionId, 'saved-version+/=');

      if (fail) {
        throw new Error('Provider failure with private details');
      }

      return {
        response: {},
        output: {
          $metadata: {},
          VersionId: 'saved-version+/=',
          ContentLength: 100,
          ContentType: 'application/pdf',
          ...head,
        },
      };
    },
    { step: 'initialize', name: 'savedVersion' },
  );

  return {
    client,
    headCalls: () => headCalls,
    gateway: createDownloadStorage({
      client,
      bucket: 'caseflow-test-documents',
      environment: 'dev',
    }),
  };
}

test('download contracts reject client-selected storage locations and non-HTTPS URLs', () => {
  documentDownloadRequestSchema.parse({});

  for (const body of [
    { objectVersionId: 'forged' },
    { bucket: 'forged' },
    { role: 'admin' },
    { expectedVersion: 1 },
  ]) {
    assert.equal(documentDownloadRequestSchema.safeParse(body).success, false);
  }

  assert.equal(
    downloadAuthorizationSchema.safeParse({
      method: 'GET',
      url: 'http://example.invalid',
      expiresAt: new Date().toISOString(),
    }).success,
    false,
  );
});

test('download signing pins the saved version, safe attachment headers, and exact sixty-second expiry', async () => {
  const fixture = storage();

  try {
    for (const filename of [
      'Fictional record.pdf',
      '写真 (1).pdf',
      `quote" and apostrophe'.pdf`,
      'percent%20name.pdf',
    ]) {
      const authorization = downloadAuthorizationSchema.parse(
        await fixture.gateway.authorize(record(filename)),
      );
      const url = new URL(authorization.url);
      const disposition = url.searchParams.get('response-content-disposition')!;
      const encoded = disposition.split("filename*=UTF-8''")[1]!;
      const signedAt = url.searchParams.get('X-Amz-Date')!;
      const date = new Date(
        `${signedAt.slice(0, 4)}-${signedAt.slice(4, 6)}-${signedAt.slice(6, 8)}T${signedAt.slice(9, 11)}:${signedAt.slice(11, 13)}:${signedAt.slice(13, 15)}Z`,
      );

      assert.equal(authorization.method, 'GET');
      assert.equal(url.searchParams.get('versionId'), 'saved-version+/=');
      assert.equal(decodeURIComponent(url.pathname), '/' + record().storage.key);
      assert.equal(url.searchParams.get('response-content-type'), 'application/pdf');
      assert.equal(url.searchParams.get('response-cache-control'), 'private, no-store');
      assert.match(disposition, /^attachment; filename="[^"]+"; filename\*=UTF-8''/);
      assert.equal(decodeURIComponent(encoded), filename);
      assert.equal(url.searchParams.get('X-Amz-Expires'), '60');
      assert.equal(Date.parse(authorization.expiresAt) - date.getTime(), 60000);
      assert.ok(Date.parse(authorization.expiresAt) <= Date.now() + 60000);
    }
  } finally {
    fixture.client.destroy();
  }
});

test('download preparation rejects control characters and paths before contacting storage', async () => {
  const fixture = storage();

  try {
    for (const filename of [
      'bad\r\nInjected: value.pdf',
      'nul\u0000.pdf',
      '../file.pdf',
      'folder/file.pdf',
      'folder\\file.pdf',
    ]) {
      await assert.rejects(fixture.gateway.authorize(record(filename)));
    }
    assert.equal(fixture.headCalls(), 0);
  } finally {
    fixture.client.destroy();
  }
});

test('download preparation never falls back when the exact saved version is unavailable', async () => {
  for (const patch of [
    { VersionId: 'latest-version' },
    { VersionId: 'null' },
    { ContentLength: 99 },
    { ContentType: 'text/html' },
  ]) {
    const fixture = storage(patch);
    try {
      await assert.rejects(
        fixture.gateway.authorize(record()),
        /saved document version is unavailable/,
      );
      assert.equal(fixture.headCalls(), 1);
    } finally {
      fixture.client.destroy();
    }
  }

  const fixture = storage({}, true);
  try {
    await assert.rejects(fixture.gateway.authorize(record()), /Provider failure/);
  } finally {
    fixture.client.destroy();
  }
});
