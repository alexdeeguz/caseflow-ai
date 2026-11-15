import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DocumentContentType,
  DocumentLimits,
  DocumentStatus,
  UploadSessionStatus,
  documentSchema,
  documentUploadRequestSchema,
  documentQuerySchema,
  documentVersionSchema,
  uploadSessionSchema,
} from '@caseflow/schemas';

const file = {
  filename: 'Medical record.PDF',
  contentType: DocumentContentType.Pdf,
  sizeBytes: 100,
};
const id = '10000000-0000-4000-8000-000000000001';
const uploadFields = { requestId: id, checksumSha256: 'A'.repeat(43) + '=' };
const timestamp = '2026-11-14T20:00:00Z';
const document = {
  ...file,
  id,
  caseId: id,
  uploadedBy: id,
  status: DocumentStatus.PendingUpload,
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  uploadedAt: null,
  removedAt: null,
  removedBy: null,
};

test('document contracts accept supported files and exact size limits', () => {
  for (const [filename, contentType] of [
    [' record.pdf ', DocumentContentType.Pdf],
    ['photo.JPEG', DocumentContentType.Jpeg],
    ['photo.jpg', DocumentContentType.Jpeg],
    ['写真.png', DocumentContentType.Png],
  ]) {
    const parsed = documentUploadRequestSchema.parse({
      ...uploadFields,
      filename,
      contentType,
      sizeBytes: DocumentLimits.FileSizeBytes,
    });

    assert.equal(parsed.filename, filename?.trim());
  }
});

test('upload contracts reject paths, control characters, wrong types, sizes and forged fields', () => {
  for (const patch of [
    { filename: '' },
    { filename: 'a'.repeat(DocumentLimits.Filename - 3) + '.pdf' },
    { filename: '../record.pdf' },
    { filename: 'C:\\record.pdf' },
    { filename: 'line\nrecord.pdf' },
    { filename: 'nul\u0000record.pdf' },
    { filename: 'record.docx' },
    { filename: 'record.pdf.exe' },
    { filename: 'record.png' },
    { contentType: 'application/octet-stream' },
    { sizeBytes: 0 },
    { sizeBytes: -1 },
    { sizeBytes: 1.5 },
    { sizeBytes: '100' },
    { sizeBytes: DocumentLimits.FileSizeBytes + 1 },
    { caseId: id },
    { uploadedBy: id },
    { status: DocumentStatus.Available },
    { storageBucket: 'other-bucket' },
    { objectKey: 'other-key' },
    { objectVersionId: 'forged' },
  ]) {
    assert.equal(
      documentUploadRequestSchema.safeParse({ ...file, ...uploadFields, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
  }
});

test('document responses enforce lifecycle metadata and exclude storage identifiers', () => {
  documentSchema.parse(document);
  documentSchema.parse({ ...document, status: DocumentStatus.Available, uploadedAt: timestamp });
  documentSchema.parse({
    ...document,
    status: DocumentStatus.Removed,
    uploadedAt: timestamp,
    removedAt: timestamp,
    removedBy: id,
  });

  for (const patch of [
    { status: DocumentStatus.Available },
    { status: DocumentStatus.Removed, uploadedAt: timestamp },
    { removedBy: id },
    { objectKey: 'private-key' },
    { objectVersionId: 'private-version' },
    { storageBucket: 'private-bucket' },
  ]) {
    assert.equal(documentSchema.safeParse({ ...document, ...patch }).success, false);
  }
});

test('upload session responses distinguish pending, completed, failed and expired attempts', () => {
  const session = {
    id,
    documentId: id,
    status: UploadSessionStatus.Pending,
    createdAt: timestamp,
    expiresAt: '2026-11-14T20:05:00Z',
    finishedAt: null,
    failureCode: null,
  };

  uploadSessionSchema.parse(session);
  uploadSessionSchema.parse({
    ...session,
    status: UploadSessionStatus.Completed,
    finishedAt: timestamp,
  });
  uploadSessionSchema.parse({
    ...session,
    status: UploadSessionStatus.Failed,
    finishedAt: timestamp,
    failureCode: 'verification_failed',
  });
  uploadSessionSchema.parse({
    ...session,
    status: UploadSessionStatus.Expired,
    finishedAt: session.expiresAt,
  });

  for (const patch of [
    { expiresAt: timestamp },
    { expiresAt: '2026-11-14T20:05:01Z' },
    { finishedAt: timestamp },
    { status: UploadSessionStatus.Completed },
    { status: UploadSessionStatus.Completed, finishedAt: '2026-11-14T19:59:59Z' },
    { status: UploadSessionStatus.Failed, finishedAt: timestamp },
    { status: UploadSessionStatus.Expired, finishedAt: timestamp },
    { failureCode: 'raw provider error' },
  ]) {
    assert.equal(
      uploadSessionSchema.safeParse({ ...session, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
  }
});

test('document queries and versioned mutations reject unexpected fields', () => {
  assert.deepEqual(documentQuerySchema.parse({}), { page: 1, pageSize: 25, filter: 'current' });
  assert.equal(documentQuerySchema.safeParse({ filter: 'deleted' }).success, false);
  assert.equal(documentQuerySchema.safeParse({ caseId: id }).success, false);
  assert.equal(documentVersionSchema.safeParse({ expectedVersion: 0 }).success, false);
  assert.equal(
    documentVersionSchema.safeParse({ expectedVersion: 1, removedBy: id }).success,
    false,
  );
});
