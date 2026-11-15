import { ProcessingStatus, type ProcessingSummary } from '@caseflow/schemas';
import { isProcessingActive, processingLabel } from '../../../lib/processing/presentation';
import styles from './processing.module.css';

export function ProcessingStatusBadge({ summary }: { summary: ProcessingSummary }) {
  const tone =
    summary.status === ProcessingStatus.Ready
      ? styles.ready
      : summary.status === ProcessingStatus.Failed
        ? styles.failed
        : isProcessingActive(summary)
          ? styles.active
          : styles.neutral;

  return (
    <span className={`${styles.badge} ${tone}`}>
      <span className={styles.dot} aria-hidden="true" />
      {processingLabel(summary)}
    </span>
  );
}
