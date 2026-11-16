'use client';

import type { Document, DocumentListItem, Role } from '@caseflow/schemas';
import type { DocumentAction } from '../../../lib/documents/actions';
import { DocumentCard } from './document-card';
import styles from './documents.module.css';

export function DocumentList({
  items,
  role,
  archived,
  busy,
  disabled,
  selectedId,
  onOpenDetails,
  onAction,
}: {
  items: DocumentListItem[];
  role: Role;
  archived: boolean;
  busy: { id: string; action: DocumentAction } | null;
  disabled: boolean;
  /** Document currently shown in the details drawer. */
  selectedId: string | null;
  onOpenDetails: (id: string) => void;
  onAction: (document: Document, action: DocumentAction) => void;
}) {
  return (
    <div className={styles.table}>
      <div className={styles.columns} aria-hidden="true">
        <span>Document</span>
        <span>Status</span>
        <span>Uploaded</span>
      </div>
      <ul className={styles.list} aria-label="Case documents, newest first">
        {items.map((document) => (
          <DocumentCard
            key={document.id}
            document={document}
            role={role}
            archived={archived}
            busy={busy}
            disabled={disabled}
            selected={selectedId === document.id}
            onOpenDetails={() => onOpenDetails(document.id)}
            onAction={onAction}
          />
        ))}
      </ul>
    </div>
  );
}
