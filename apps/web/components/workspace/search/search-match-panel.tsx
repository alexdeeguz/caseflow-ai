import type { DocumentSearchResult } from '@caseflow/schemas';
import { Panel } from '../../ui/panel';
import { ArrowRightIcon } from '../documents/document-icons';
import { Snippet, matchLabels } from './search-results';
import styles from './search.module.css';

/** The passage that led to a document, shown at the top of its details drawer. */
export function SearchMatchPanel({
  result,
  onOpenInCase,
}: {
  result: DocumentSearchResult;
  onOpenInCase: () => void;
}) {
  return (
    <Panel
      title="Search match"
      badge={
        <span className={styles.match} data-match={result.matchedBy}>
          {matchLabels[result.matchedBy]}
        </span>
      }
    >
      <p className={styles.matchCase}>
        <span className={styles.caseNumber}>{result.caseNumber}</span>
        <span>{result.caseTitle}</span>
        {result.caseArchived && <span className={styles.archived}>Archived</span>}
      </p>
      <p className={styles.matchPage}>Page {result.page}</p>
      <Snippet result={result} className={`${styles.snippet} ${styles.matchSnippet}`} />
      <button type="button" className={styles.openCase} onClick={onOpenInCase}>
        Open in case <ArrowRightIcon />
      </button>
    </Panel>
  );
}
