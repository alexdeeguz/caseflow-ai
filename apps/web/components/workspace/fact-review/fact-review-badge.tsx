import { factReviewStatusLabels, type FactReviewStatus } from '@caseflow/schemas';
import styles from './review.module.css';

export function FactReviewBadge({ status }: { status: FactReviewStatus }) {
  return (
    <span className={`${styles.badge} ${styles[status]}`}>{factReviewStatusLabels[status]}</span>
  );
}
