import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DocumentStatus,
  FactExtractionFailure,
  FactExtractionStatus,
  ProcessingFailureCode,
  ProcessingStatus,
  factExtractionFailureMessages,
  processingFailureMessages,
  type DocumentListItem,
} from '@caseflow/schemas';
import { DocumentStateKind, documentState, reviewTotals } from '../lib/documents/state';

function document({
  status = DocumentStatus.Available,
  processing = ProcessingStatus.Ready,
  processingFailure = null,
  extraction = FactExtractionStatus.Completed,
  extractionFailure = null,
  factCount = 10,
  chunks = [0, 0],
  unreviewed = 0,
}: {
  status?: DocumentStatus;
  processing?: ProcessingStatus;
  processingFailure?: ProcessingFailureCode | null;
  extraction?: FactExtractionStatus;
  extractionFailure?: FactExtractionFailure | null;
  factCount?: number;
  chunks?: [number, number];
  unreviewed?: number;
} = {}): DocumentListItem {
  return {
    status,
    processing: {
      status: processing,
      job:
        processing === ProcessingStatus.NotProcessed
          ? null
          : { status: processing, stage: null, failureCode: processingFailure },
      result: null,
    },
    factExtraction: {
      status: extraction,
      job:
        extraction === FactExtractionStatus.NotExtracted
          ? null
          : {
              status: extraction,
              failureCode: extractionFailure,
              factCount,
              completedChunks: chunks[0],
              chunkCount: chunks[1],
            },
    },
    unreviewedFactCount: unreviewed,
  } as unknown as DocumentListItem;
}

test('document state surfaces the one thing a reviewer needs next', () => {
  assert.deepEqual(documentState(document({ status: DocumentStatus.Removed })), {
    kind: DocumentStateKind.Removed,
    label: 'Removed',
  });
  assert.deepEqual(
    documentState(
      document({
        processing: ProcessingStatus.Failed,
        processingFailure: ProcessingFailureCode.InvalidDocument,
        extraction: FactExtractionStatus.NotExtracted,
      }),
    ),
    {
      kind: DocumentStateKind.Failed,
      label: 'Couldn’t process file',
      detail: processingFailureMessages[ProcessingFailureCode.InvalidDocument],
    },
  );
  const extractionFailure = Object.values(FactExtractionFailure)[0]!;
  assert.deepEqual(
    documentState(document({ extraction: FactExtractionStatus.Failed, extractionFailure })),
    {
      kind: DocumentStateKind.Failed,
      label: 'Couldn’t extract facts',
      detail: factExtractionFailureMessages[extractionFailure],
    },
  );
  assert.equal(
    documentState(document({ processing: ProcessingStatus.Queued })).kind,
    DocumentStateKind.Processing,
  );
  assert.deepEqual(
    documentState(document({ extraction: FactExtractionStatus.Extracting, chunks: [3, 8] })),
    { kind: DocumentStateKind.Processing, label: 'Finding facts', detail: '3 of 8 parts read' },
  );
  assert.deepEqual(
    documentState(
      document({
        processing: ProcessingStatus.NotProcessed,
        extraction: FactExtractionStatus.NotExtracted,
      }),
    ),
    { kind: DocumentStateKind.Waiting, label: 'Waiting to process' },
  );
  assert.deepEqual(documentState(document({ extraction: FactExtractionStatus.NotExtracted })), {
    kind: DocumentStateKind.Waiting,
    label: 'Waiting for fact extraction',
  });
  assert.deepEqual(documentState(document({ factCount: 0 })), {
    kind: DocumentStateKind.NoFacts,
    label: 'No facts found',
  });
  assert.deepEqual(documentState(document({ unreviewed: 7 })), {
    kind: DocumentStateKind.Review,
    label: '7 to review',
    detail: 'of 10 facts',
  });
  assert.deepEqual(documentState(document({ factCount: 1 })), {
    kind: DocumentStateKind.Reviewed,
    label: '1 fact reviewed',
  });
});

test('review totals sum the loaded page and flag when more documents exist', () => {
  const items = [
    document({ unreviewed: 7 }),
    document({ unreviewed: 5, factCount: 6 }),
    document({ status: DocumentStatus.Removed, factCount: 4 }),
  ];
  assert.deepEqual(reviewTotals({ items, total: 3 }), {
    unreviewed: 12,
    facts: 16,
    partial: false,
  });
  assert.equal(reviewTotals({ items, total: 30 }).partial, true);
});
