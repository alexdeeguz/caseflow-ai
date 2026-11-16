'use client';

import type { ReactNode } from 'react';
import type { Document, DocumentListItem, Role } from '@caseflow/schemas';
import { documentTypeLabels, formatFileSize } from '../../../lib/documents/presentation';
import { DocumentAction, documentActions } from '../../../lib/documents/actions';
import { Menu, type MenuItem } from '../../ui/menu';
import { DocumentIcon } from './document-icon';
import { ChevronRightIcon, DownloadIcon, RestoreIcon, TrashIcon } from './document-icons';
import { DocumentDate } from './document-details';
import { DocumentStatus } from './document-status';
import styles from './documents.module.css';

const actionLabels: Record<DocumentAction, string> = {
  download: 'Download',
  remove: 'Remove',
  restore: 'Restore',
};
const actionIcons: Record<DocumentAction, ReactNode> = {
  download: <DownloadIcon />,
  remove: <TrashIcon />,
  restore: <RestoreIcon />,
};

/** One document row. The filename button spans the row, so clicking anywhere opens details. */
export function DocumentCard({
  document,
  role,
  archived,
  busy,
  disabled,
  selected,
  onOpenDetails,
  onAction,
}: {
  document: DocumentListItem;
  role: Role;
  archived: boolean;
  busy: { id: string; action: DocumentAction } | null;
  disabled: boolean;
  /** True while this document is shown in the details drawer. */
  selected: boolean;
  onOpenDetails: () => void;
  onAction: (document: Document, action: DocumentAction) => void;
}) {
  const allowed = documentActions(document, role, archived);
  const menuItems: MenuItem[] = Object.values(DocumentAction)
    .filter((action) => allowed[action])
    .map((action) => ({
      id: action,
      label: busy?.id === document.id && busy.action === action ? 'Working…' : actionLabels[action],
      icon: actionIcons[action],
      destructive: action === DocumentAction.Remove,
      disabled: disabled || busy !== null,
      onSelect: () => onAction(document, action),
    }));

  return (
    <li className={styles.row} data-open={selected || undefined}>
      <div className={styles.file}>
        <span className={styles.fileIcon}>
          <DocumentIcon contentType={document.contentType} />
        </span>
        <div className={styles.fileText}>
          <button
            type="button"
            className={styles.filenameButton}
            aria-haspopup="dialog"
            onClick={onOpenDetails}
          >
            {document.filename}
            <span className="sr-only">, view details</span>
          </button>
          <span className={styles.fileType}>
            {documentTypeLabels[document.contentType]} · {formatFileSize(document.sizeBytes)}
          </span>
        </div>
      </div>
      <DocumentStatus document={document} />
      <span className={styles.uploaded}>
        <DocumentDate value={document.uploadedAt} />
      </span>
      <div className={styles.rowEnd}>
        {menuItems.length > 0 && (
          <Menu label={`Actions for ${document.filename}`} items={menuItems} />
        )}
        <span className={styles.chevron} aria-hidden="true">
          <ChevronRightIcon />
        </span>
      </div>
    </li>
  );
}
