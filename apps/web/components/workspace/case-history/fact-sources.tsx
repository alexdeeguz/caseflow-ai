import type { ApprovedCaseFact } from '@caseflow/schemas';
import { DocumentIcon } from '../documents/document-icon';
import { DownloadIcon } from '../documents/document-icons';
import styles from './case-history.module.css';

/** Download state shared by every source link in a history view. */
export interface SourceDownloads {
  /** Document ID whose download is being requested. */
  busy: string | null;
  disabled: boolean;
  onDownload: (fact: ApprovedCaseFact) => void;
}

function pagesLabel(fact: ApprovedCaseFact) {
  const pages = [...new Set(fact.evidence.map((source) => source.page))];
  return `${pages.length === 1 ? 'p.' : 'pp.'} ${pages.join(', ')}`;
}

/** Citations for one or more approved facts: file, pages, and a download of the source. */
export function FactSources({
  facts,
  downloads,
}: {
  facts: readonly ApprovedCaseFact[];
  downloads: SourceDownloads;
}) {
  // One citation per document; facts from the same file merge their pages.
  const cited = [...new Map(facts.map((fact) => [fact.documentId, fact])).values()];

  return (
    <ul className={styles.sources} aria-label="Sources">
      {cited.map((fact) => (
        <li key={fact.documentId} className={styles.sourceItem}>
          <DocumentIcon />
          <span className={styles.sourceName}>{fact.filename}</span>
          <span className={styles.sourcePages}>
            {pagesLabel({
              ...fact,
              evidence: facts
                .filter((other) => other.documentId === fact.documentId)
                .flatMap((other) => other.evidence),
            })}
          </span>
          <button
            type="button"
            className={styles.sourceDownload}
            disabled={downloads.disabled}
            onClick={() => downloads.onDownload(fact)}
            aria-label={`Download source: ${fact.filename}`}
            title="Download source"
          >
            {downloads.busy === fact.documentId ? (
              <span className={styles.sourceBusy}>Requesting…</span>
            ) : (
              <DownloadIcon size={14} />
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
