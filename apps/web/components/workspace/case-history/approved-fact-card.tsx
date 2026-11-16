import { FactCategory, FactReviewStatus, type ApprovedCaseFact } from '@caseflow/schemas';
import { formatFactDate } from '../../../lib/case-history/presentation';
import { FactEvidence } from '../fact-review/fact-evidence';
import { FactReviewBadge } from '../fact-review/fact-review-badge';
import { FactValuesDisplay } from '../fact-review/fact-values';
import styles from './case-history.module.css';

export function ApprovedFactCard({
  fact,
  busy,
  disabled,
  onDownload,
}: {
  fact: ApprovedCaseFact;
  busy: boolean;
  disabled: boolean;
  onDownload: () => void;
}) {
  return (
    <article className={styles.card}>
      <div className={styles.cardHeading}>
        {fact.category === FactCategory.Date && <h3>{formatFactDate(fact)}</h3>}
        <FactReviewBadge status={FactReviewStatus.Approved} />
      </div>
      <FactValuesDisplay values={fact} showDate={false} />
      <div className={styles.source}>
        <span className={styles.filename}>{fact.filename}</span>
        <span>Approved revision {fact.version}</span>
      </div>
      <details className={styles.evidence}>
        <summary>
          Source evidence ·{' '}
          {fact.evidence
            .map((source) => `Page ${source.page}`)
            .filter((value, index, pages) => pages.indexOf(value) === index)
            .join(', ')}
        </summary>
        <FactEvidence evidence={fact.evidence} />
      </details>
      <button
        type="button"
        className={styles.download}
        disabled={disabled}
        onClick={onDownload}
        aria-label={`Download source: ${fact.filename}`}
      >
        {busy ? 'Requesting download…' : 'Download source'}
      </button>
    </article>
  );
}
