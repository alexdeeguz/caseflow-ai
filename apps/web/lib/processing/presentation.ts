import { factStatusLabels } from '../fact-extraction/presentation';
import {
  DocumentContentType,
  DocumentStatus,
  ExtractionMethod,
  ProcessingStage,
  ProcessingStatus,
  Role,
  type DocumentListItem,
  type ProcessingSummary,
  type ProcessingJob,
} from '@caseflow/schemas';

const statusLabels: Record<ProcessingStatus, string> = {
  [ProcessingStatus.NotProcessed]: 'Not processed',
  [ProcessingStatus.Queued]: 'Queued',
  [ProcessingStatus.Processing]: 'Extracting text',
  [ProcessingStatus.Ready]: 'Ready',
  [ProcessingStatus.Failed]: 'Failed',
  [ProcessingStatus.Cancelled]: 'Cancelled',
};

const stageLabels: Record<NonNullable<ProcessingJob['stage']>, string> = {
  [ProcessingStage.Extracting]: 'Extracting text',
  [ProcessingStage.WaitingForOcr]: 'Waiting for OCR',
  [ProcessingStage.Collecting]: 'Collecting results',
};

export const extractionMethodLabels: Record<ExtractionMethod, string> = {
  [ExtractionMethod.Native]: 'Native PDF text',
  [ExtractionMethod.Ocr]: 'OCR (text recognition)',
};

export function processingLabel(summary: ProcessingSummary): string {
  return summary.job?.stage ? stageLabels[summary.job.stage] : statusLabels[summary.status];
}

export function isProcessingActive(summary: ProcessingSummary): boolean {
  return (
    summary.status === ProcessingStatus.Queued || summary.status === ProcessingStatus.Processing
  );
}

export const ProcessingAction = { Process: 'process', Retry: 'retry' } as const;
export type ProcessingAction = (typeof ProcessingAction)[keyof typeof ProcessingAction];

export const processingActionLabels: Record<ProcessingAction, string> = {
  [ProcessingAction.Process]: 'Process',
  [ProcessingAction.Retry]: 'Retry',
};

export function processingAction(
  document: DocumentListItem,
  role: Role,
  archived: boolean,
): ProcessingAction | null {
  if (role === Role.Staff || archived || document.status !== DocumentStatus.Available) {
    return null;
  }

  switch (document.processing.status) {
    case ProcessingStatus.NotProcessed:
      return ProcessingAction.Process;
    case ProcessingStatus.Failed:
    case ProcessingStatus.Cancelled:
      return ProcessingAction.Retry;
    default:
      return null;
  }
}

export function processingRequestFeedback(summary: ProcessingSummary): string {
  if (summary.status === ProcessingStatus.Queued) {
    return 'Document queued for processing.';
  }
  if (summary.status === ProcessingStatus.Processing) {
    return 'This document is already processing.';
  }
  // An idempotent retry may return a job that has already finished.
  return `Latest processing status: ${processingLabel(summary)}.`;
}

export function processingChanges(previous: DocumentListItem[], current: DocumentListItem[]) {
  const prior = new Map(previous.map((document) => [document.id, document]));
  return current.filter((document) => {
    const before = prior.get(document.id);
    return (
      before &&
      (before.processing.job?.id !== document.processing.job?.id ||
        before.processing.status !== document.processing.status ||
        before.processing.job?.stage !== document.processing.job?.stage ||
        before.factExtraction.status !== document.factExtraction.status ||
        before.factExtraction.job?.id !== document.factExtraction.job?.id)
    );
  });
}

export function processingAnnouncement(changed: DocumentListItem[]): string {
  const messages = changed
    .slice(0, 2)
    .map(
      (document) =>
        `${document.filename}: text ${processingLabel(document.processing)}; facts ${factStatusLabels[document.factExtraction.status]}.`,
    );
  if (changed.length > 2) {
    messages.push(`${changed.length - 2} more documents updated.`);
  }
  return messages.join(' ');
}

export function isPdf(document: Pick<DocumentListItem, 'contentType'>): boolean {
  return document.contentType === DocumentContentType.Pdf;
}
