import { FactCategory, type ApprovedCaseFact } from '@caseflow/schemas';
import { formatFactDate } from '../../../lib/case-history/presentation';
import { DocumentIcon } from '../documents/document-icon';
import { DownloadIcon } from '../documents/document-icons';
import { FactEvidence } from '../fact-review/fact-evidence';
import { FactValuesDisplay } from '../fact-review/fact-values';
import styles from './case-history.module.css';

export function ApprovedFactCard({
  fact,
  busy,
  disabled,
  showDate = true,
  onDownload,
}: {
  fact: ApprovedCaseFact;
  busy: boolean;
  disabled: boolean;
  /** The timeline shows the date in its own column, so the card can omit it. */
  showDate?: boolean;
  onDownload: () => void;
}) {
  const pages = fact.evidence
    .map((source) => source.page)
    .filter((page, index, all) => all.indexOf(page) === index);

  return (
    <article className={styles.card}>
      {showDate && fact.category === FactCategory.Date && (
        <h3 className={styles.factDate}>{formatFactDate(fact)}</h3>
      )}
      <FactValuesDisplay values={fact} showDate={false} />
      <div className={styles.cardFooter}>
        <span className={styles.source}>
          <DocumentIcon />
          <span className={styles.filename}>{fact.filename}</span>
          <span aria-hidden="true">·</span>
          <span>Approved revision {fact.version}</span>
        </span>
        <button
          type="button"
          className={styles.download}
          disabled={disabled}
          onClick={onDownload}
          aria-label={`Download source: ${fact.filename}`}
        >
          <DownloadIcon />
          {busy ? 'Requesting download…' : 'Download source'}
        </button>
      </div>
      <details className={styles.evidence}>
        <summary>
          Source evidence · {pages.length === 1 ? 'Page' : 'Pages'} {pages.join(', ')}
        </summary>
        <FactEvidence evidence={fact.evidence} />
      </details>
    </article>
  );
}
