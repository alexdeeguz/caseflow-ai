import {
  DocumentStatus,
  FactExtractionStatus,
  ProcessingStatus,
  factExtractionFailureMessages,
  processingFailureMessages,
  type DocumentListItem,
} from '@caseflow/schemas';
import { isProcessingActive, processingLabel } from '../processing/presentation';
import { isFactExtractionActive } from '../fact-extraction/presentation';

export const DocumentStateKind = {
  Removed: 'removed',
  Failed: 'failed',
  Processing: 'processing',
  Waiting: 'waiting',
  NoFacts: 'noFacts',
  Review: 'review',
  Reviewed: 'reviewed',
} as const;
export type DocumentStateKind = (typeof DocumentStateKind)[keyof typeof DocumentStateKind];

export interface DocumentState {
  kind: DocumentStateKind;
  label: string;
  detail?: string;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One user-facing status per document, folding the processing pipeline into what matters next. */
export function documentState(document: DocumentListItem): DocumentState {
  const { processing, factExtraction: extraction } = document;

  if (document.status === DocumentStatus.Removed) {
    return { kind: DocumentStateKind.Removed, label: 'Removed' };
  }
  if (processing.job?.failureCode) {
    return {
      kind: DocumentStateKind.Failed,
      label: 'Couldn’t process file',
      detail: processingFailureMessages[processing.job.failureCode],
    };
  }
  if (extraction.job?.failureCode) {
    return {
      kind: DocumentStateKind.Failed,
      label: 'Couldn’t extract facts',
      detail: factExtractionFailureMessages[extraction.job.failureCode],
    };
  }
  if (isProcessingActive(processing)) {
    return {
      kind: DocumentStateKind.Processing,
      label: 'Processing',
      detail: processingLabel(processing),
    };
  }
  if (isFactExtractionActive(extraction)) {
    const job = extraction.job;
    return {
      kind: DocumentStateKind.Processing,
      label: 'Finding facts',
      detail: job?.chunkCount
        ? `${job.completedChunks} of ${job.chunkCount} parts read`
        : undefined,
    };
  }
  if (processing.status !== ProcessingStatus.Ready) {
    return {
      kind: DocumentStateKind.Waiting,
      label:
        processing.status === ProcessingStatus.Cancelled
          ? 'Processing cancelled'
          : 'Waiting to process',
    };
  }
  if (extraction.status !== FactExtractionStatus.Completed) {
    return {
      kind: DocumentStateKind.Waiting,
      label:
        extraction.status === FactExtractionStatus.Cancelled
          ? 'Fact extraction cancelled'
          : 'Waiting for fact extraction',
    };
  }

  const facts = extraction.job?.factCount ?? 0;
  if (facts === 0) {
    return { kind: DocumentStateKind.NoFacts, label: 'No facts found' };
  }
  if (document.unreviewedFactCount > 0) {
    return {
      kind: DocumentStateKind.Review,
      label: `${document.unreviewedFactCount} to review`,
      detail: `of ${plural(facts, 'fact')}`,
    };
  }
  return { kind: DocumentStateKind.Reviewed, label: `${plural(facts, 'fact')} reviewed` };
}

export interface ReviewTotals {
  unreviewed: number;
  facts: number;
  /** True when the case has more documents than the loaded page, so totals are a lower bound. */
  partial: boolean;
}

export function reviewTotals(page: { items: DocumentListItem[]; total: number }): ReviewTotals {
  return {
    unreviewed: page.items.reduce((sum, item) => sum + item.unreviewedFactCount, 0),
    facts: page.items.reduce(
      (sum, item) =>
        sum +
        (item.status === DocumentStatus.Available ? (item.factExtraction.job?.factCount ?? 0) : 0),
      0,
    ),
    partial: page.total > page.items.length,
  };
}
