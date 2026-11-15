import {
  ProcessingFailureCode,
  ProcessingLimits,
  ProcessingStatus,
  processingFailureMessages,
  type DocumentListItem,
} from '@caseflow/schemas';
import { extractionMethodLabels, isPdf } from '../../../lib/processing/presentation';
import { DocumentDate } from './document-details';
import { ProcessingStatusBadge } from './processing-status';
import styles from './processing.module.css';

export function ProcessingLimitsNote({ document }: { document: DocumentListItem }) {
  return (
    <p className={styles.hint}>
      {isPdf(document)
        ? `PDFs can contain up to ${ProcessingLimits.MaxPdfPages} pages. Scanned or mixed-content pages may need OCR.`
        : 'Images must be at most 10 MB, 10,000 pixels per side, and 40 megapixels.'}{' '}
      OCR shares a workspace allowance of {ProcessingLimits.DailyOcrPages} pages per UTC day.
    </p>
  );
}

export function ProcessingDetails({ document }: { document: DocumentListItem }) {
  const { processing } = document;
  const { job, result } = processing;

  return (
    <section className={styles.details} aria-label={`Processing details for ${document.filename}`}>
      <div className={styles.heading}>
        <h3>Text processing</h3>
        <ProcessingStatusBadge summary={processing} />
      </div>
      <dl className={styles.metadata}>
        <div>
          <dt>Extraction method</dt>
          <dd>{result ? extractionMethodLabels[result.extractionMethod] : 'Not available yet'}</dd>
        </div>
        <div>
          <dt>Pages processed</dt>
          <dd>{result ? result.pageCount : 'Not available yet'}</dd>
        </div>
        <div>
          <dt>Latest processing update</dt>
          <dd>{job ? <DocumentDate value={job.updatedAt} detailed /> : 'Not started'}</dd>
        </div>
      </dl>
      {job?.failureCode && (
        <p className={styles.failure}>{processingFailureMessages[job.failureCode]}</p>
      )}
      {processing.status === ProcessingStatus.Cancelled && (
        <p className={styles.hint}>
          This attempt was cancelled. An administrator can retry an available document in a current
          case.
        </p>
      )}
      {job?.failureCode === ProcessingFailureCode.OcrBudgetExceeded && (
        <p className={styles.hint}>
          Retry after the next UTC day begins. The allowance is shared across the workspace.
        </p>
      )}
      {(processing.status === ProcessingStatus.NotProcessed ||
        job?.failureCode === ProcessingFailureCode.LimitExceeded ||
        job?.failureCode === ProcessingFailureCode.InvalidDocument ||
        job?.failureCode === ProcessingFailureCode.OcrBudgetExceeded) && (
        <ProcessingLimitsNote document={document} />
      )}
    </section>
  );
}
