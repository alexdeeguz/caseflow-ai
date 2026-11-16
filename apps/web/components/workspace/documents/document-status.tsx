import type { DocumentListItem } from '@caseflow/schemas';
import { DocumentStateKind, documentState } from '../../../lib/documents/state';
import styles from './document-status.module.css';

/** The single status shown on a document row. */
export function DocumentStatus({ document }: { document: DocumentListItem }) {
  const state = documentState(document);
  return (
    <div className={styles.status} data-kind={state.kind}>
      <span className={styles.label}>
        {state.kind === DocumentStateKind.Reviewed ? (
          <svg
            className={styles.check}
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
        ) : (
          <span className={styles.dot} aria-hidden="true" />
        )}
        {state.label}
      </span>
      {state.detail && <span className={styles.detail}>{state.detail}</span>}
    </div>
  );
}
