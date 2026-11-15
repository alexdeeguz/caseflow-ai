'use client';

import { Fragment, useId, useState } from 'react';
import { DocumentStatus, type Document, type DocumentListItem, type Role } from '@caseflow/schemas';
import { documentTypeLabels, formatFileSize } from '../../../lib/documents/presentation';
import { DocumentIcon } from './document-icon';
import { DocumentDate, DocumentDetails } from './document-details';
import { DocumentActions } from './document-actions';
import type { DocumentAction } from '../../../lib/documents/actions';
import { ProcessingStatusBadge } from './processing-status';
import { ProcessingDetails } from './processing-details';
import { ProcessingActionButton } from './processing-action-button';
import processingStyles from './processing.module.css';
import styles from './documents.module.css';

function DocumentStatusBadge({ status }: { status: DocumentStatus }) {
  const removed = status === DocumentStatus.Removed;
  return (
    <span className={`${styles.badge} ${removed ? styles.removed : styles.available}`}>
      <span className={styles.statusDot} aria-hidden="true" />
      {removed ? 'Removed' : 'Available'}
    </span>
  );
}

function DocumentName({ document }: { document: Document }) {
  return (
    <div className={styles.file}>
      <span className={styles.fileIcon}>
        <DocumentIcon contentType={document.contentType} />
      </span>
      <div className={styles.fileText}>
        <span className={styles.filename}>{document.filename}</span>
        <span className={styles.fileType}>
          {documentTypeLabels[document.contentType]} · {formatFileSize(document.sizeBytes)}
        </span>
      </div>
    </div>
  );
}

function DetailsToggle({
  document,
  open,
  controls,
  onToggle,
}: {
  document: Document;
  open: boolean;
  controls: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.detailsToggle}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      {open ? 'Hide details' : 'View details'}
      <span className="sr-only"> for {document.filename}</span>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
        className={open ? styles.expanded : ''}
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  );
}

export function DocumentList({
  items,
  role,
  archived,
  busy,
  onAction,
  disabled,
  processingId,
  onProcess,
}: {
  items: DocumentListItem[];
  role: Role;
  archived: boolean;
  busy: { id: string; action: DocumentAction } | null;
  onAction: (document: Document, action: DocumentAction) => void;
  disabled: boolean;
  processingId: string | null;
  onProcess: (document: DocumentListItem) => void;
}) {
  const prefix = useId();
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggle = (id: string) => setExpanded((current) => (current === id ? null : id));

  return (
    <>
      <div className={styles.desktopList}>
        <table className={styles.table}>
          <caption className="sr-only">Case documents, newest first</caption>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Uploaded</th>
              <th scope="col">Availability</th>
              <th scope="col">Processing</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((document) => {
              const open = expanded === document.id;
              const detailsId = `${prefix}-desktop-${document.id}`;
              return (
                <Fragment key={document.id}>
                  <tr className={open ? styles.openRow : undefined}>
                    <td>
                      <DocumentName document={document} />
                    </td>
                    <td>
                      <DocumentDate value={document.uploadedAt} />
                    </td>
                    <td>
                      <DocumentStatusBadge status={document.status} />
                    </td>
                    <td>
                      <div className={processingStyles.statusCell}>
                        <ProcessingStatusBadge summary={document.processing} />
                        <ProcessingActionButton
                          document={document}
                          role={role}
                          archived={archived}
                          disabled={disabled}
                          busy={processingId === document.id}
                          onProcess={onProcess}
                        />
                      </div>
                    </td>
                    <td>
                      <DocumentActions
                        document={document}
                        role={role}
                        archived={archived}
                        busy={busy}
                        disabled={disabled}
                        onAction={onAction}
                      />
                      <DetailsToggle
                        document={document}
                        open={open}
                        controls={detailsId}
                        onToggle={() => toggle(document.id)}
                      />
                    </td>
                  </tr>
                  <tr id={detailsId} hidden={!open}>
                    <td colSpan={5} className={styles.detailCell}>
                      {open && (
                        <>
                          <DocumentDetails document={document} />
                          <ProcessingDetails document={document} />
                        </>
                      )}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className={styles.mobileList} aria-label="Case documents, newest first">
        {items.map((document) => {
          const open = expanded === document.id;
          const detailsId = `${prefix}-mobile-${document.id}`;
          return (
            <li key={document.id} className={styles.card}>
              <DocumentName document={document} />
              <div className={styles.cardMetadata}>
                <span>
                  Uploaded <DocumentDate value={document.uploadedAt} />
                </span>
              </div>
              <div className={styles.cardActions}>
                <DocumentStatusBadge status={document.status} />
                <DetailsToggle
                  document={document}
                  open={open}
                  controls={detailsId}
                  onToggle={() => toggle(document.id)}
                />
              </div>
              <div className={processingStyles.cardStatus}>
                <span>Processing</span>
                <ProcessingStatusBadge summary={document.processing} />
              </div>
              <div className={styles.documentActions}>
                <ProcessingActionButton
                  document={document}
                  role={role}
                  archived={archived}
                  disabled={disabled}
                  busy={processingId === document.id}
                  onProcess={onProcess}
                />
                <DocumentActions
                  document={document}
                  role={role}
                  archived={archived}
                  busy={busy}
                  disabled={disabled}
                  onAction={onAction}
                />
              </div>
              <div id={detailsId} hidden={!open}>
                {open && (
                  <>
                    <DocumentDetails document={document} />
                    <ProcessingDetails document={document} />
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
