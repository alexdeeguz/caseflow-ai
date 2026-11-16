import { FactExtractionStatus, type FactExtractionSummary } from '@caseflow/schemas';
import {
  factStatusLabels,
  isFactExtractionActive,
} from '../../../lib/fact-extraction/presentation';
import styles from './processing.module.css';

export function FactExtractionBadge({ summary }: { summary: FactExtractionSummary }) {
  const tone = isFactExtractionActive(summary)
    ? styles.active
    : summary.status === FactExtractionStatus.Completed
      ? styles.ready
      : summary.status === FactExtractionStatus.Failed
        ? styles.failed
        : styles.neutral;
  return (
    <span className={`${styles.badge} ${tone}`}>
      <span className={styles.dot} aria-hidden="true" />
      {factStatusLabels[summary.status]}
    </span>
  );
}
