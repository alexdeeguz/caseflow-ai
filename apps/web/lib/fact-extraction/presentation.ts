import {
  DocumentStatus,
  FactExtractionStatus,
  ProcessingStatus,
  Role,
  type DocumentListItem,
  type FactExtractionSummary,
} from '@caseflow/schemas';

export const factStatusLabels: Record<FactExtractionStatus, string> = {
  not_extracted: 'Not extracted',
  queued: 'Queued',
  extracting: 'Extracting',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function isFactExtractionActive(summary: FactExtractionSummary): boolean {
  return (
    summary.status === FactExtractionStatus.Queued ||
    summary.status === FactExtractionStatus.Extracting
  );
}

export function factExtractionAction(document: DocumentListItem, role: Role, archived: boolean) {
  if (
    role === Role.Staff ||
    archived ||
    document.status !== DocumentStatus.Available ||
    document.processing.status !== ProcessingStatus.Ready
  ) {
    return null;
  }
  switch (document.factExtraction.status) {
    case FactExtractionStatus.NotExtracted:
      return 'Extract facts';
    case FactExtractionStatus.Failed:
    case FactExtractionStatus.Cancelled:
      return 'Retry extraction';
    default:
      return null;
  }
}

export function factRequestFeedback(summary: FactExtractionSummary) {
  return summary.status === FactExtractionStatus.Queued
    ? 'Fact extraction queued.'
    : `Latest fact extraction status: ${factStatusLabels[summary.status]}.`;
}
