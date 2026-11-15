import type { Document, Role } from '@caseflow/schemas';
import { DocumentAction, documentActions } from '../../../lib/documents/actions';
import styles from './documents.module.css';

export function DocumentActions({
  document,
  role,
  archived,
  busy,
  disabled = false,
  onAction,
}: {
  document: Document;
  role: Role;
  archived: boolean;
  busy: { id: string; action: DocumentAction } | null;
  disabled?: boolean;
  onAction: (document: Document, action: DocumentAction) => void;
}) {
  const allowed = documentActions(document, role, archived);
  const labels = { download: 'Download', remove: 'Remove', restore: 'Restore' };
  return (
    <div className={styles.documentActions}>
      {Object.values(DocumentAction)
        .filter((action) => allowed[action])
        .map((action) => (
          <button
            key={action}
            type="button"
            className={styles.actionButton}
            disabled={disabled || busy !== null}
            onClick={() => onAction(document, action)}
          >
            {busy?.id === document.id && busy.action === action ? 'Working…' : labels[action]}
            <span className="sr-only"> {document.filename}</span>
          </button>
        ))}
    </div>
  );
}
