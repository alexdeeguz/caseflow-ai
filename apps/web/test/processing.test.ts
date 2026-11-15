import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryObserver } from '@tanstack/react-query';
import {
  DocumentContentType,
  DocumentStatus,
  ExtractionMethod,
  ProcessingFailureCode,
  ProcessingStage,
  ProcessingStatus,
  Role,
  documentListItemSchema,
  processingSummarySchema,
  type DocumentListItem,
  type ProcessingSummary,
  type ProcessingJob,
} from '@caseflow/schemas';
import type { AuthRequest } from '../hooks/use-authentication';
import { ApiError } from '../lib/api';
import { createResourceClient, withResourceInvalidation } from '../lib/resources';
import { documentListResource } from '../lib/documents/resources';
import {
  ProcessingAction,
  processingAction,
  processingAnnouncement,
  processingChanges,
  processingLabel,
  processingRequestFeedback,
} from '../lib/processing/presentation';
import {
  documentLibraryOptions,
  documentLibraryState,
  processingPollInterval,
  processingResource,
} from '../lib/processing/resources';

const id = '10000000-0000-4000-8000-000000000001';
const date = '2026-11-15T12:00:00Z';

function summary(
  status: ProcessingStatus,
  stage: NonNullable<ProcessingJob['stage']> = ProcessingStage.Extracting,
): ProcessingSummary {
  const terminal = [
    ProcessingStatus.Ready,
    ProcessingStatus.Failed,
    ProcessingStatus.Cancelled,
  ].some((value) => value === status);
  return processingSummarySchema.parse({
    status,
    job:
      status === ProcessingStatus.NotProcessed
        ? null
        : {
            id,
            documentId: id,
            requestedBy: id,
            status,
            stage: status === ProcessingStatus.Processing ? stage : null,
            attemptCount: 1,
            maxAttempts: 5,
            failureCode:
              status === ProcessingStatus.Failed ? ProcessingFailureCode.OcrIncomplete : null,
            createdAt: date,
            updatedAt: date,
            finishedAt: terminal ? date : null,
          },
    result:
      status === ProcessingStatus.Ready
        ? { extractionMethod: ExtractionMethod.Ocr, pageCount: 2, pipelineVersion: '1' }
        : null,
  });
}

function document(status: ProcessingStatus = ProcessingStatus.NotProcessed): DocumentListItem {
  return documentListItemSchema.parse({
    id,
    caseId: id,
    uploadedBy: id,
    filename: 'Fictional report.pdf',
    contentType: DocumentContentType.Pdf,
    sizeBytes: 1024,
    status: DocumentStatus.Available,
    version: 1,
    createdAt: date,
    updatedAt: date,
    uploadedAt: date,
    removedAt: null,
    removedBy: null,
    processing: summary(status),
  });
}

test('processing labels distinguish lifecycle and OCR stages without estimates', () => {
  const labels = ['Not processed', 'Queued', 'Extracting text', 'Ready', 'Failed', 'Cancelled'];
  Object.values(ProcessingStatus).forEach((status, index) =>
    assert.equal(processingLabel(summary(status)), labels[index]),
  );
  assert.equal(
    processingLabel(summary(ProcessingStatus.Processing, ProcessingStage.WaitingForOcr)),
    'Waiting for OCR',
  );
  assert.equal(
    processingLabel(summary(ProcessingStatus.Processing, ProcessingStage.Collecting)),
    'Collecting results',
  );
});

test('only administrators can process or retry available documents in current cases', () => {
  for (const role of Object.values(Role)) {
    for (const archived of [true, false]) {
      for (const availability of [DocumentStatus.Available, DocumentStatus.Removed]) {
        for (const status of Object.values(ProcessingStatus)) {
          const item = { ...document(status), status: availability };
          const expected =
            role === Role.Staff || archived || availability === DocumentStatus.Removed
              ? null
              : status === ProcessingStatus.NotProcessed
                ? ProcessingAction.Process
                : [ProcessingStatus.Failed, ProcessingStatus.Cancelled].some(
                      (value) => value === status,
                    )
                  ? ProcessingAction.Retry
                  : null;
          assert.equal(processingAction(item, role, archived), expected);
        }
      }
    }
  }
});

test('request feedback describes idempotent results honestly', () => {
  assert.equal(
    processingRequestFeedback(summary(ProcessingStatus.Queued)),
    'Document queued for processing.',
  );
  assert.match(
    processingRequestFeedback(summary(ProcessingStatus.Processing)),
    /already processing/,
  );
  for (const status of [
    ProcessingStatus.Ready,
    ProcessingStatus.Failed,
    ProcessingStatus.Cancelled,
  ]) {
    assert.equal(
      processingRequestFeedback(summary(status)),
      `Latest processing status: ${processingLabel(summary(status))}.`,
    );
  }
});

test('polling runs every five seconds only for displayed active jobs, and stops on access rejection', () => {
  assert.equal(processingPollInterval(undefined, null), false);
  assert.equal(processingPollInterval({ items: [] }, null), false);
  for (const status of Object.values(ProcessingStatus)) {
    const active = status === ProcessingStatus.Queued || status === ProcessingStatus.Processing;
    const data = { items: [document(status)] };
    assert.equal(processingPollInterval(data, null), active ? 5000 : false);
    assert.equal(
      processingPollInterval(data, new ApiError(503, 'UNAVAILABLE', 'Temporary')),
      active ? 5000 : false,
    );
    for (const code of [401, 403, 404]) {
      assert.equal(processingPollInterval(data, new ApiError(code, 'DENIED', 'Denied')), false);
    }
  }
});

test('temporary failures retain existing rows but access rejection clears protected content', () => {
  const data = { items: [document(ProcessingStatus.Processing)] };
  for (const error of [new Error('Offline'), new ApiError(503, 'UNAVAILABLE', 'Temporary')]) {
    assert.deepEqual(documentLibraryState({ data, error }), {
      data,
      error: error.message,
      denied: false,
      stale: true,
    });
  }
  for (const status of [401, 403, 404]) {
    assert.deepEqual(
      documentLibraryState({ data, error: new ApiError(status, 'DENIED', 'Denied') }),
      {
        data: null,
        error: 'Denied',
        denied: true,
        stale: false,
      },
    );
  }
});

test('announcements describe meaningful changes and ignore repeated snapshots or timestamps', () => {
  const before = document(ProcessingStatus.Queued);
  assert.deepEqual(processingChanges([before], [structuredClone(before)]), []);
  const timestampOnly = structuredClone(before);
  timestampOnly.processing.job!.updatedAt = '2026-11-15T13:00:00Z';
  assert.deepEqual(processingChanges([before], [timestampOnly]), []);
  const after = document(ProcessingStatus.Processing);
  assert.deepEqual(processingChanges([before], [after]), [after]);
  assert.equal(processingAnnouncement([after]), 'Fictional report.pdf: Extracting text.');
  assert.equal(processingChanges([], [after]).length, 0);
  assert.match(processingAnnouncement([after, after, after]), /1 more documents updated/);
});

test('library observers share one in-flight request and preserve cached rows through refresh', async () => {
  const client = createResourceClient();
  client.setDefaultOptions({
    queries: { ...client.getDefaultOptions().queries, gcTime: Infinity },
  });
  let resolve!: (value: unknown) => void;
  let calls = 0;
  const request: AuthRequest = async (_path, schema) => {
    calls++;
    return schema.parse(
      await new Promise((done) => {
        resolve = done;
      }),
    );
  };
  const resource = documentListResource(id, { page: 1, filter: 'current' });
  const options = documentLibraryOptions(request, resource);
  assert.equal(options.networkMode, 'online');
  assert.equal(options.refetchIntervalInBackground, false);
  const first = new QueryObserver(client, options);
  const second = new QueryObserver(client, options);
  const unsubscribe = [first.subscribe(() => {}), second.subscribe(() => {})];
  try {
    assert.equal(calls, 1);
    const page = { items: [document(ProcessingStatus.Ready)], total: 1, page: 1, pageSize: 25 };
    const pending = first.refetch({ cancelRefetch: false });
    resolve(page);
    await pending;
    assert.equal(second.getCurrentResult().data?.total, 1);
    const refreshing = first.refetch();
    assert.equal(documentLibraryState(first.getCurrentResult()).data?.total, 1);
    resolve(page);
    await refreshing;
    assert.equal(calls, 2);
  } finally {
    unsubscribe.forEach((stop) => stop());
    first.destroy();
    second.destroy();
    client.clear();
  }
});

test('processing and document state mutations invalidate the affected summaries, library, and audit only', async () => {
  for (const action of ['processing', 'remove', 'restore']) {
    const client = createResourceClient();
    const paths = [
      '/cases/one/documents?page=1',
      processingResource('one', 'document').path,
      processingResource('one', 'other').path,
      processingResource('two', 'document').path,
      '/admin/audit?page=1',
      '/cases?page=1',
    ];
    paths.forEach((path) => client.setQueryData([path], []));
    const request = withResourceInvalidation(client, async (_path, schema) =>
      schema.parse(summary(ProcessingStatus.Queued)),
    );
    try {
      await request(`/cases/one/documents/document/${action}`, processingSummarySchema, {
        method: 'POST',
      });
      assert.deepEqual(
        paths.map((path) => client.getQueryState([path])?.isInvalidated),
        [true, true, false, false, true, false],
      );
    } finally {
      client.clear();
    }
  }
});
