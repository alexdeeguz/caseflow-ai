import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  processingJobSchema,
  processingSummarySchema,
  processingResultSummarySchema,
  processingFailureMessages,
  ProcessingFailureCode,
  documentListItemSchema,
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

test('public summaries enforce job/result consistency and reject private fields', () => {
  const empty = { status: 'not_processed', job: null, result: null };
  assert.deepEqual(processingSummarySchema.parse(empty), empty);
  const job = {
    id: randomUUID(),
    documentId: randomUUID(),
    requestedBy: randomUUID(),
    status: 'queued',
    stage: null,
    attemptCount: 0,
    maxAttempts: 5,
    failureCode: null,
    createdAt: '2026-11-15T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
    finishedAt: null,
  };
  const result = { extractionMethod: 'native', pageCount: 2, pipelineVersion: '1' };
  const queued = { status: 'queued', job, result: null };
  processingSummarySchema.parse(queued);
  const ready = {
    status: 'ready',
    result,
    job: { ...job, status: 'ready', finishedAt: job.updatedAt },
  };
  processingSummarySchema.parse(ready);
  for (const invalid of [
    { ...empty, status: 'queued' },
    { ...queued, status: 'ready' },
    { ...queued, result },
    { ...ready, result: null },
    { ...empty, result },
    { ...queued, leaseToken: randomUUID() },
    { ...queued, job: { ...job, sourceKey: 'private' } },
    { ...ready, result: { ...result, artifacts: {} } },
  ]) {
    assert.equal(processingSummarySchema.safeParse(invalid).success, false);
  }
  for (const invalid of [
    { ...result, pageCount: 0 },
    { ...result, pageCount: 21 },
    { ...result, extractionMethod: 'unknown' },
    { ...result, storageBucket: 'private' },
  ]) {
    assert.equal(processingResultSummarySchema.safeParse(invalid).success, false);
  }
  for (const code of Object.values(ProcessingFailureCode)) {
    assert.ok(processingFailureMessages[code]);
  }
  const document = {
    id: job.documentId,
    caseId: randomUUID(),
    uploadedBy: job.requestedBy,
    filename: 'fictional.pdf',
    contentType: 'application/pdf',
    sizeBytes: 20,
    status: 'available',
    version: 1,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    uploadedAt: job.createdAt,
    removedAt: null,
    removedBy: null,
    processing: queued,
    factExtraction: { status: 'not_extracted', job: null },
  };
  documentListItemSchema.parse(document);
  assert.equal(documentListItemSchema.safeParse({ ...document, id: randomUUID() }).success, false);
});
