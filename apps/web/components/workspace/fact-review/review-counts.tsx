import { FactReviewStatus, factReviewStatusLabels } from '@caseflow/schemas';
import styles from './review.module.css';

/** Review totals as a proportional bar (decorative) plus the accessible count list. */
export function ReviewCounts({ counts }: { counts: Record<FactReviewStatus, number> }) {
  const statuses = Object.values(FactReviewStatus);
  const total = statuses.reduce((sum, status) => sum + counts[status], 0);

  return (
    <div className={styles.countsSummary}>
      {total > 0 && (
        <div className={styles.countsBar} aria-hidden="true">
          {statuses.map(
            (status) =>
              counts[status] > 0 && (
                <span
                  key={status}
                  className={styles[status]}
                  style={{ flexGrow: counts[status] }}
                />
              ),
          )}
        </div>
      )}
      <dl className={styles.counts} aria-label="Review counts for this category">
        {statuses.map((status) => (
          <div key={status} className={styles[status]}>
            <dt>{factReviewStatusLabels[status]}</dt>
            <dd>{counts[status]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
