import {
  ProcessingFailureCode,
  ProcessingLimits,
  ProcessingStatus,
  processingFailureMessages,
  type DocumentListItem,
} from '@caseflow/schemas';
import type { ReactNode } from 'react';
import { extractionMethodLabels, isPdf } from '../../../lib/processing/presentation';
import { Callout, DetailList, Panel } from '../../ui/panel';
import { DocumentDate } from './document-details';
import { ProcessingStatusBadge } from './processing-status';
import styles from './document-inspector.module.css';

export function ProcessingLimitsNote({ document }: { document: DocumentListItem }) {
  return (
    <Callout>
      {isPdf(document)
        ? `PDFs can contain up to ${ProcessingLimits.MaxPdfPages} pages. Scanned or mixed-content pages may need OCR.`
        : 'Images must be at most 10 MB, 10,000 pixels per side, and 40 megapixels.'}{' '}
      OCR shares a workspace allowance of {ProcessingLimits.DailyOcrPages} pages per UTC day.
    </Callout>
  );
}

export function ProcessingDetails({
  document,
  action,
}: {
  document: DocumentListItem;
  /** Manual start/retry control, shown while processing is not automatic. */
  action?: ReactNode;
}) {
  const { processing } = document;
  const { job, result } = processing;

  return (
    <Panel
      title="Text processing"
      label={`Processing details for ${document.filename}`}
      badge={<ProcessingStatusBadge summary={processing} />}
    >
      <DetailList
        items={[
          {
            label: 'Extraction method',
            value: result ? extractionMethodLabels[result.extractionMethod] : 'Not available yet',
          },
          { label: 'Pages processed', value: result ? result.pageCount : 'Not available yet' },
          {
            label: 'Latest update',
            value: job ? <DocumentDate value={job.updatedAt} detailed /> : 'Not started',
          },
        ]}
      />
      {action && <div className={styles.action}>{action}</div>}
      {job?.failureCode && (
        <Callout tone="danger">{processingFailureMessages[job.failureCode]}</Callout>
      )}
      {processing.status === ProcessingStatus.Cancelled && (
        <Callout>
          This attempt was cancelled. An administrator can retry an available document in a current
          case.
        </Callout>
      )}
      {job?.failureCode === ProcessingFailureCode.OcrBudgetExceeded && (
        <Callout>
          Retry after the next UTC day begins. The allowance is shared across the workspace.
        </Callout>
      )}
      {(processing.status === ProcessingStatus.NotProcessed ||
        job?.failureCode === ProcessingFailureCode.LimitExceeded ||
        job?.failureCode === ProcessingFailureCode.InvalidDocument ||
        job?.failureCode === ProcessingFailureCode.OcrBudgetExceeded) && (
        <ProcessingLimitsNote document={document} />
      )}
    </Panel>
  );
}
