import { SearchMatch, type DocumentSearchResult } from '@caseflow/schemas';
import { highlightSegments } from '../../../lib/search/highlight';
import { DocumentIcon } from '../documents/document-icon';
import { ChevronRightIcon } from '../documents/document-icons';
import styles from './search.module.css';

export const matchLabels: Record<SearchMatch, string> = {
  [SearchMatch.Keyword]: 'Exact words',
  [SearchMatch.Semantic]: 'Similar meaning',
  [SearchMatch.Both]: 'Exact + meaning',
};

/** Passage text with the server's highlight ranges rendered as <mark>. */
export function Snippet({
  result,
  className = styles.snippet,
}: {
  result: DocumentSearchResult;
  className?: string;
}) {
  return (
    <p className={className}>
      {highlightSegments(result.snippet, result.highlights).map((segment, index) =>
        segment.highlighted ? <mark key={index}>{segment.text}</mark> : segment.text,
      )}
    </p>
  );
}

/** Ranked search hits. Each row opens its document; the filename button spans the row. */
export function SearchResults({
  items,
  showCase,
  onOpen,
}: {
  items: DocumentSearchResult[];
  showCase: boolean;
  onOpen: (result: DocumentSearchResult) => void;
}) {
  return (
    <ol className={styles.results} aria-label="Search results">
      {items.map((result) => (
        <li key={result.chunkId} className={styles.result}>
          <span className={styles.resultIcon}>
            <DocumentIcon contentType={result.contentType} />
          </span>
          <div className={styles.resultBody}>
            {showCase && (
              <p className={styles.resultCase}>
                <span className={styles.caseNumber}>{result.caseNumber}</span>
                <span className={styles.caseTitle}>{result.caseTitle}</span>
                {result.caseArchived && <span className={styles.archived}>Archived</span>}
              </p>
            )}
            <button
              type="button"
              className={styles.resultTitle}
              aria-haspopup="dialog"
              onClick={() => onOpen(result)}
            >
              <span className={styles.filename}>{result.filename}</span>
              <span className={styles.pageTag}>p. {result.page}</span>
              <span className="sr-only">, open document</span>
            </button>
            <Snippet result={result} />
          </div>
          <div className={styles.resultEnd}>
            <span className={styles.match} data-match={result.matchedBy}>
              {matchLabels[result.matchedBy]}
            </span>
            <span className={styles.chevron} aria-hidden="true">
              <ChevronRightIcon />
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}
