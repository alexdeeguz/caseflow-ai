import type { ReactNode } from 'react';
import type { Document, Role } from '@caseflow/schemas';
import { DocumentAction, documentActions } from '../../../lib/documents/actions';
import { DownloadIcon, RestoreIcon, TrashIcon } from './document-icons';
import styles from './documents.module.css';

const labels: Record<DocumentAction, string> = {
  download: 'Download',
  remove: 'Remove',
  restore: 'Restore',
};

const icons: Record<DocumentAction, ReactNode> = {
  download: <DownloadIcon />,
  remove: <TrashIcon />,
  restore: <RestoreIcon />,
};

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
  return (
    <div className={styles.documentActions}>
      {Object.values(DocumentAction)
        .filter((action) => allowed[action])
        .map((action) => (
          <button
            key={action}
            type="button"
            className={`${styles.actionButton} ${action === DocumentAction.Remove ? styles.destructive : ''}`}
            disabled={disabled || busy !== null}
            aria-busy={busy?.id === document.id && busy.action === action}
            title={labels[action]}
            onClick={() => onAction(document, action)}
          >
            {icons[action]}
            <span>
              {busy?.id === document.id && busy.action === action ? 'Working…' : labels[action]}
            </span>
            <span className="sr-only"> {document.filename}</span>
          </button>
        ))}
    </div>
  );
}
