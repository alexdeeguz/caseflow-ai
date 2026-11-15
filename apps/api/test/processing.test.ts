import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  processingJobSchema,
  processingMessageSchema,
  processingRequestSchema,
} from '@caseflow/schemas';

test('processing contracts reject forged queue inputs and inconsistent lifecycle metadata', () => {
  const message = { schemaVersion: 1, jobId: randomUUID() };
  assert.deepEqual(processingMessageSchema.parse(message), message);
  for (const extra of [{ bucket: 'forged' }, { role: 'admin' }, { objectKey: 'forged' }]) {
    assert.equal(processingMessageSchema.safeParse({ ...message, ...extra }).success, false);
  }
  assert.equal(processingMessageSchema.safeParse({ ...message, schemaVersion: 2 }).success, false);
  assert.equal(processingRequestSchema.safeParse({ expectedJobId: null }).success, true);
  assert.equal(processingRequestSchema.safeParse({}).success, false);
  assert.equal(
    processingRequestSchema.safeParse({ expectedJobId: null, status: 'ready' }).success,
    false,
  );
  const job = {
    id: randomUUID(),
    documentId: randomUUID(),
    requestedBy: randomUUID(),
    status: 'queued',
    stage: null,
    attemptCount: 0,
    maxAttempts: 5,
    failureCode: null,
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
    finishedAt: null,
  };
  processingJobSchema.parse(job);
  for (const extra of [
    { status: 'not_processed' },
    { attemptCount: 6 },
    { sourceKey: 'private' },
    { status: 'failed' },
    { stage: 'extracting' },
    { failureCode: 'provider secret' },
  ]) {
    assert.equal(processingJobSchema.safeParse({ ...job, ...extra }).success, false);
  }
});
