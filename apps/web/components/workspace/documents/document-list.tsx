'use client';

import { useState, type ReactNode } from 'react';
import type { Document, DocumentListItem, Role } from '@caseflow/schemas';
import type { DocumentAction } from '../../../lib/documents/actions';
import { documentTypeLabels, formatFileSize } from '../../../lib/documents/presentation';
import { Drawer } from '../../ui/overlay-dialog';
import { DocumentActions } from './document-actions';
import { DocumentDetails } from './document-details';
import { ProcessingDetails } from './processing-details';
import { ProcessingActionButton } from './processing-action-button';
import { DocumentInspector } from './document-inspector';
import { DocumentCard } from './document-card';
import styles from './documents.module.css';

export function DocumentList({
  items,
  role,
  archived,
  busy,
  onAction,
  disabled,
  processingId,
  onProcess,
  renderFacts,
}: {
  items: DocumentListItem[];
  role: Role;
  archived: boolean;
  busy: { id: string; action: DocumentAction } | null;
  onAction: (document: Document, action: DocumentAction) => void;
  disabled: boolean;
  processingId: string | null;
  onProcess: (document: DocumentListItem) => void;
  renderFacts: (document: DocumentListItem) => ReactNode;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Read from the latest items so the drawer reflects live processing and review updates.
  const selected = items.find((document) => document.id === selectedId) ?? null;

  return (
    <>
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
              selected={drawerOpen && selectedId === document.id}
              onOpenDetails={() => {
                setSelectedId(document.id);
                setDrawerOpen(true);
              }}
              onAction={onAction}
            />
          ))}
        </ul>
      </div>
      {selected && (
        <Drawer
          open={drawerOpen}
          title={selected.filename}
          description={`${documentTypeLabels[selected.contentType]} · ${formatFileSize(selected.sizeBytes)}`}
          actions={
            <DocumentActions
              document={selected}
              role={role}
              archived={archived}
              busy={busy}
              disabled={disabled}
              onAction={onAction}
            />
          }
          onClose={() => setDrawerOpen(false)}
          onExited={() => setSelectedId(null)}
        >
          <DocumentInspector
            aside={
              <>
                <DocumentDetails document={selected} />
                <ProcessingDetails
                  document={selected}
                  action={
                    <ProcessingActionButton
                      document={selected}
                      role={role}
                      archived={archived}
                      disabled={disabled}
                      busy={processingId === selected.id}
                      onProcess={onProcess}
                    />
                  }
                />
              </>
            }
          >
            {renderFacts(selected)}
          </DocumentInspector>
        </Drawer>
      )}
    </>
  );
}
