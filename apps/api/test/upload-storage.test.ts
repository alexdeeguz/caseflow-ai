import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { DocumentContentType, ErrorCode, documentUploadRequestSchema } from '@caseflow/schemas';
import type { UploadRecord } from '../src/database/documents.js';
import { createUploadStorage, UploadVerificationError } from '../src/storage/uploads.js';

const pdf = Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5N8AAAAASUVORK5CYII=',
  'base64',
);
const jpeg = Buffer.from([
  0xff,
  0xd8,
  0xff,
  0xe0,
  0x00,
  0x10,
  ...Buffer.from('JFIF\0'),
  0xff,
  0xd9,
]);

function record(
  bytes = pdf,
  contentType: UploadRecord['document']['contentType'] = DocumentContentType.Pdf,
): UploadRecord {
  const createdAt = new Date().toISOString();
  const id = randomUUID();
  return {
    document: {
      id,
      caseId: randomUUID(),
      uploadedBy: randomUUID(),
      filename: 'test.pdf',
      contentType,
      sizeBytes: bytes.length,
      status: 'pending_upload',
      version: 1,
      createdAt,
      updatedAt: createdAt,
      uploadedAt: null,
      removedAt: null,
      removedBy: null,
    },
    session: {
      id: randomUUID(),
      documentId: id,
      status: 'pending',
      createdAt,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      finishedAt: null,
      failureCode: null,
    },
    storage: {
      bucket: 'caseflow-test-documents',
      key: `dev/cases/test/documents/${id}/original/test.pdf`,
      checksumSha256: createHash('sha256').update(bytes).digest('base64'),
    },
  };
}

function client() {
  return new S3Client({
    region: 'us-east-2',
    credentials: { accessKeyId: 'TEST_ONLY', secretAccessKey: 'test-only' },
  });
}

function gateway(s3: S3Client) {
  return createUploadStorage({ client: s3, bucket: 'caseflow-test-documents', environment: 'dev' });
}

test('upload requests require a canonical SHA-256 checksum and retry request ID', () => {
  const valid = {
    filename: 'a.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1,
    requestId: randomUUID(),
    checksumSha256: createHash('sha256').update('a').digest('base64'),
  };
  assert.equal(documentUploadRequestSchema.safeParse(valid).success, true);
  for (const patch of [
    { checksumSha256: 'bad' },
    { checksumSha256: 'A'.repeat(42) + 'B=' },
    { requestId: undefined },
    { checksumSha256: undefined },
    { requestId: 'bad' },
  ]) {
    assert.equal(documentUploadRequestSchema.safeParse({ ...valid, ...patch }).success, false);
  }
});

test('presigning binds the key, checksum, exact size, MIME type and no-overwrite condition without extending expiry', async (t) => {
  const s3 = client();
  t.after(() => s3.destroy());
  const upload = record();
  upload.session.expiresAt = new Date(Date.now() + 60000).toISOString();
  const authorization = await gateway(s3).authorize(upload);
  const url = new URL(authorization.url);
  const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders')!.split(';');
  for (const header of [
    'content-type',
    'content-length',
    'if-none-match',
    'x-amz-checksum-sha256',
  ]) {
    assert.ok(signedHeaders.includes(header), header);
  }
  assert.equal(decodeURIComponent(url.pathname), '/' + upload.storage.key);
  assert.equal(authorization.headers['If-None-Match'], '*');
  assert.equal(authorization.headers['x-amz-checksum-sha256'], upload.storage.checksumSha256);
  assert.ok(Number(url.searchParams.get('X-Amz-Expires')) <= 60);
  assert.ok(Date.parse(authorization.expiresAt) <= Date.parse(upload.session.expiresAt));
  upload.session.expiresAt = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(gateway(s3).authorize(upload), { code: ErrorCode.UploadExpired });
});

test('S3 verification pins the HEAD version and validates all bytes for supported types', async (t) => {
  for (const [bytes, type] of [
    [pdf, DocumentContentType.Pdf],
    [png, DocumentContentType.Png],
    [jpeg, DocumentContentType.Jpeg],
  ] as const) {
    await t.test(type, async () => {
      const s3 = client();
      const upload = record(bytes, type);
      const body = Readable.from([bytes.subarray(0, 8), bytes.subarray(8)]);
      s3.middlewareStack.add(
        (_next, context) => async (args) => {
          if (context.commandName === 'GetObjectCommand') {
            assert.equal((args.input as { VersionId?: string }).VersionId, 'pinned-version');
          }
          return {
            response: {},
            output: {
              $metadata: {},
              VersionId: 'pinned-version',
              ContentType: type,
              ContentLength: bytes.length,
              ...(context.commandName === 'GetObjectCommand' ? { Body: body } : {}),
            },
          };
        },
        { step: 'initialize', name: 'storedObject' },
      );
      try {
        assert.equal(await gateway(s3).verify(upload), 'pinned-version');
        assert.equal(body.destroyed, true);
      } finally {
        s3.destroy();
      }
    });
  }
});

test('verification rejects mismatched metadata, signatures, checksums, oversized/truncated streams and unversioned storage', async (t) => {
  const scenarios = [
    { name: 'metadata size', head: { ContentLength: pdf.length + 1 } },
    { name: 'metadata type', head: { ContentType: 'text/html' } },
    { name: 'checksum', bytes: Buffer.from(pdf.toString().replace('Catalog', 'Invalid')) },
    { name: 'oversize', bytes: Buffer.concat([pdf, Buffer.from('extra')]) },
    { name: 'truncated', bytes: pdf.subarray(0, 8) },
    { name: 'wrong binary type', bytes: Buffer.from('a'.repeat(pdf.length)), matchChecksum: true },
    { name: 'version changed', get: { VersionId: 'unexpected-version' } },
    { name: 'versioning disabled', head: { VersionId: 'null' }, unavailable: true },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const s3 = client();
      const upload = record();
      const bytes = scenario.bytes ?? pdf;
      if (scenario.matchChecksum) {
        upload.storage.checksumSha256 = createHash('sha256').update(bytes).digest('base64');
      }
      const body = Readable.from([bytes]);
      let fetched = false;
      s3.middlewareStack.add(
        (_next, context) => async () => {
          fetched ||= context.commandName === 'GetObjectCommand';
          return {
            response: {},
            output: {
              $metadata: {},
              VersionId: 'v1',
              ContentType: 'application/pdf',
              ContentLength: pdf.length,
              ...(context.commandName === 'HeadObjectCommand'
                ? scenario.head
                : { Body: body, ...scenario.get }),
            },
          };
        },
        { step: 'initialize', name: 'invalidObject' },
      );
      try {
        await assert.rejects(
          gateway(s3).verify(upload),
          scenario.unavailable ? { code: ErrorCode.ServiceUnavailable } : UploadVerificationError,
        );
        if (fetched) {
          assert.equal(body.destroyed, true);
        }
      } finally {
        body.destroy();
        s3.destroy();
      }
    });
  }
});

test('verification bounds concurrent streams and releases capacity after storage failures', async (t) => {
  const s3 = client();
  t.after(() => s3.destroy());
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  s3.middlewareStack.add(
    () => async () => {
      await wait;
      throw new Error('Storage offline');
    },
    { step: 'initialize', name: 'blockedStorage' },
  );
  const storage = gateway(s3);
  const pending = Array.from({ length: 4 }, () => storage.verify(record()));
  const settled = Promise.allSettled(pending);
  await assert.rejects(storage.verify(record()), { code: ErrorCode.ServiceUnavailable });
  release();
  assert.ok((await settled).every((result) => result.status === 'rejected'));
  await assert.rejects(storage.verify(record()), /Storage offline/);
});
