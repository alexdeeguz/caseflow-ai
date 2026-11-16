import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DocumentStatus,
  FactExtractionStatus,
  ProcessingStatus,
  Role,
  type DocumentListItem,
} from '@caseflow/schemas';
import {
  factExtractionAction,
  factExtractionTone,
  factRequestFeedback,
} from '../lib/fact-extraction/presentation';
import { StatusTone } from '../lib/documents/presentation';
import { processingPollInterval, documentLibraryState } from '../lib/processing/resources';
import { processingChanges } from '../lib/processing/presentation';
import { createResourceClient, withResourceInvalidation } from '../lib/resources';
import { factExtractionSummarySchema } from '@caseflow/schemas';
import { ApiError } from '../lib/api';

function document(status: FactExtractionStatus): DocumentListItem {
  return {
    id: 'document',
    status: DocumentStatus.Available,
    processing: { status: ProcessingStatus.Ready },
    factExtraction: { status, job: null },
  } as DocumentListItem;
}

test('fact actions require an administrator, current available document, and Ready text', () => {
  for (const role of Object.values(Role)) {
    for (const status of Object.values(FactExtractionStatus)) {
      const item = document(status);
      const label =
        status === FactExtractionStatus.NotExtracted
          ? 'Extract facts'
          : [FactExtractionStatus.Failed, FactExtractionStatus.Cancelled].some(
                (value) => value === status,
              )
            ? 'Retry extraction'
            : null;
      assert.equal(factExtractionAction(item, role, false), role === Role.Staff ? null : label);
      assert.equal(factExtractionAction(item, role, true), null);
      assert.equal(
        factExtractionAction({ ...item, status: DocumentStatus.Removed }, role, false),
        null,
      );
      assert.equal(
        factExtractionAction(
          {
            ...item,
            processing: { status: ProcessingStatus.NotProcessed, job: null, result: null },
          },
          role,
          false,
        ),
        null,
      );
    }
  }
});

test('fact polling uses the shared five-second refresh and stops at terminal states', () => {
  for (const status of Object.values(FactExtractionStatus)) {
    const item = document(status);
    const active =
      status === FactExtractionStatus.Queued || status === FactExtractionStatus.Extracting;
    assert.equal(processingPollInterval({ items: [item] }, null), active ? 5000 : false);
    assert.equal(
      processingPollInterval({ items: [item] }, new ApiError(403, 'DENIED', 'Denied')),
      false,
    );
  }
  assert.equal(
    factRequestFeedback({ status: FactExtractionStatus.Queued, job: null }),
    'Fact extraction queued.',
  );
});

test('fact changes are announced once and authorization rejection clears cached content', () => {
  const previous = document(FactExtractionStatus.Extracting);
  const current = document(FactExtractionStatus.Completed);
  assert.deepEqual(processingChanges([previous], [current]), [current]);
  assert.deepEqual(processingChanges([current], [structuredClone(current)]), []);
  const data = { items: [current] };
  assert.equal(documentLibraryState({ data, error: new Error('Temporary') }).data, data);
  assert.equal(
    documentLibraryState({ data, error: new ApiError(401, 'DENIED', 'Denied') }).data,
    null,
  );
});

test('fact mutations invalidate only their document, facts, case library and audit', async () => {
  const client = createResourceClient();
  const paths = [
    '/cases/one/documents?page=1',
    '/cases/one/documents/document/fact-extraction',
    '/cases/one/documents/document/facts?page=1',
    '/cases/one/documents/other/facts?page=1',
    '/cases/two/documents?page=1',
    '/admin/audit?page=1',
  ];
  paths.forEach((path) => client.setQueryData([path], {}));
  const request = withResourceInvalidation(client, async (_path, schema) =>
    schema.parse({ status: 'not_extracted', job: null }),
  );
  try {
    await request(paths[1]!, factExtractionSummarySchema, { method: 'POST' });
    assert.deepEqual(
      paths.map((path) => client.getQueryState([path])?.isInvalidated),
      [true, true, true, false, false, true],
    );
  } finally {
    client.clear();
  }
});

test('fact extraction tone highlights active work and failures', () => {
  const expected: Record<FactExtractionStatus, StatusTone> = {
    [FactExtractionStatus.NotExtracted]: StatusTone.Idle,
    [FactExtractionStatus.Queued]: StatusTone.Active,
    [FactExtractionStatus.Extracting]: StatusTone.Active,
    [FactExtractionStatus.Completed]: StatusTone.Done,
    [FactExtractionStatus.Failed]: StatusTone.Failed,
    [FactExtractionStatus.Cancelled]: StatusTone.Idle,
  };
  for (const status of Object.values(FactExtractionStatus)) {
    assert.equal(factExtractionTone(document(status).factExtraction), expected[status]);
  }
});
