'use client';

import { useEffect, useRef, useState } from 'react';
import { useFactExtractionAction } from './use-fact-extraction-action';
import { FactExtractionConfirmation } from './fact-extraction-confirmation';
import { FactsPanel } from './facts-panel';
import { DocumentAction } from '../../../lib/documents/actions';
import { useQuery } from '@tanstack/react-query';
import { DocumentFilter, Role } from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import type { WorkspaceNavigate } from '../../../hooks/use-workspace-navigation';
import type { WorkspaceLocation } from '../../../lib/workspace-location';
import { useVerifiedConnection } from '../../../hooks/use-online';
import { documentLibraryOptions, documentLibraryState } from '../../../lib/processing/resources';
import { ProcessingConfirmation } from './processing-confirmation';
import { useProcessingAction } from './use-processing-action';
import { useProcessingUpdates } from './use-processing-updates';
import processingStyles from './processing.module.css';
import { documentLibraryQuery, documentListResource } from '../../../lib/documents/resources';
import { documentEmptyState, documentFilterLabels } from '../../../lib/documents/presentation';
import { Button } from '../../ui/button';
import { Pagination } from '../../ui/pagination';
import { DocumentIcon } from './document-icon';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { StatusMessage } from '../../ui/status-message';
import { UploadPanel } from './upload-panel';
import { useDocumentActions } from './use-document-actions';
import { DocumentList } from './document-list';
import styles from './documents.module.css';

export function DocumentLibrary({
  caseId,
  caseLabel,
  archived,
  role,
  request,
  location,
  navigate,
  pendingLocation,
  onAccessRejected,
}: {
  caseId: string;
  caseLabel: string;
  archived: boolean;
  role: Role;
  request: AuthRequest;
  location: WorkspaceLocation;
  navigate: WorkspaceNavigate;
  pendingLocation: WorkspaceLocation | null;
  onAccessRejected: (message: string) => void;
}) {
  const { filter, page } = documentLibraryQuery(location, role);
  const resource = documentListResource(caseId, { filter, page });
  const query = useQuery(documentLibraryOptions(request, resource));
  const { data, error, denied, stale } = documentLibraryState(query);
  const { online, verified } = useVerifiedConnection(query.dataUpdatedAt);
  const canAct = !!data && !error && verified;
  const announcement = useProcessingUpdates(resource.path, data, stale || !verified);
  const processing = useProcessingAction({
    request,
    role,
    archived,
    enabled: canAct,
    refresh: () => query.refetch(),
    onAccessRejected,
  });

  const facts = useFactExtractionAction({
    request,
    role,
    archived,
    enabled: canAct,
    refresh: () => query.refetch(),
    onAccessRejected,
  });

  useEffect(() => {
    if (denied && error) {
      onAccessRejected(error);
    }
  }, [denied, error, onAccessRejected]);

  const [uploadOpen, setUploadOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const errorSummary = useRef<HTMLDivElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const actions = useDocumentActions(
    request,
    () => query.refetch(),
    onAccessRejected,
    canAct && !processing.busy && !facts.busy,
  );
  const actionsDisabled = !canAct || actions.busy !== null || processing.busy || facts.busy;
  const actionError = actions.error ?? processing.error ?? facts.error;
  const confirming =
    actions.removing !== null || processing.selected !== null || facts.selected !== null;
  useEffect(() => {
    if (actions.completedAction || processing.completedAction || facts.completedAction) {
      heading.current?.focus();
    }
  }, [actions.completedAction, processing.completedAction, facts.completedAction]);
  useEffect(() => {
    if (actionError && !confirming) {
      errorSummary.current?.focus();
    }
  }, [actionError, confirming]);
  const closeUpload = () => {
    setUploadOpen(false);
    uploadButton.current?.focus();
  };
  const empty = documentEmptyState(filter, page);
  const navigating = pendingLocation !== null;
  const selectPage = (documentPage: number) =>
    void navigate({ ...location, documentFilter: filter, documentPage });

  if (denied) {
    return <StatusMessage tone="error">{error}</StatusMessage>;
  }

  return (
    <section aria-labelledby="documents-heading" className={styles.library}>
      <header className={styles.header}>
        <div>
          <div className={styles.heading}>
            <h2 id="documents-heading" ref={heading} tabIndex={-1}>
              Documents
            </h2>
            {data && (
              <span
                className={styles.count}
                aria-label={`${data.total} ${data.total === 1 ? 'document' : 'documents'} in this view`}
              >
                {data.total}
              </span>
            )}
          </div>
          <p className={styles.subtitle}>Files and supporting records for this case.</p>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.order}>Newest first</span>
          {!archived && (
            <Button
              ref={uploadButton}
              disabled={actionsDisabled}
              aria-expanded={uploadOpen}
              onClick={() => setUploadOpen((value) => !value)}
            >
              Upload files
            </Button>
          )}
        </div>
      </header>
      {archived && (
        <p className={styles.archiveHint}>
          Downloads remain available. Restore this case before uploading, processing, removing, or
          restoring documents.
        </p>
      )}
      {!archived && uploadOpen && canAct && (
        <UploadPanel key={caseId} target={{ id: caseId, label: caseLabel }} onClose={closeUpload} />
      )}
      {actionError && !confirming && (
        <div ref={errorSummary} tabIndex={-1}>
          <StatusMessage tone="error">{actionError}</StatusMessage>
        </div>
      )}
      <ConfirmDialog
        open={actions.removing !== null}
        title="Remove document?"
        confirmLabel="Remove document"
        cancelLabel="Keep document"
        busy={actions.busy !== null}
        confirmDisabled={!canAct}
        onCancel={actions.cancel}
        onConfirm={actions.confirm}
      >
        <p>
          <strong className={styles.filename}>{actions.removing?.filename}</strong>
        </p>
        <p>
          The file and its history are retained. An administrator can restore it later. Previously
          issued download links may work for up to 60 seconds.
        </p>
        {!canAct && <p>Reconnect and refresh the documents before continuing.</p>}
        {actions.error && <StatusMessage tone="error">{actions.error}</StatusMessage>}
      </ConfirmDialog>
      <FactExtractionConfirmation
        action={facts}
        role={role}
        archived={archived}
        enabled={canAct && actions.busy === null && !processing.busy}
      />
      <ProcessingConfirmation
        processing={processing}
        role={role}
        archived={archived}
        enabled={canAct && actions.busy === null && !facts.busy}
      />
      {(stale || !verified) && data && (
        <div className={processingStyles.notice}>
          <p>
            {!online
              ? 'You’re offline.'
              : stale
                ? 'Document updates are temporarily unavailable.'
                : 'Verifying document access…'}{' '}
            Showing the last verified information. Actions are paused until access is verified
            again.
          </p>
          <button
            type="button"
            className={styles.actionButton}
            disabled={!online || query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? 'Refreshing…' : 'Refresh documents'}
          </button>
        </div>
      )}
      {role !== Role.Staff && (
        <div role="group" aria-label="Document visibility" className={styles.filters}>
          {Object.values(DocumentFilter).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              aria-busy={pendingLocation?.documentFilter === value && filter !== value}
              onClick={() => void navigate({ ...location, documentFilter: value, documentPage: 1 })}
            >
              {documentFilterLabels[value]}
            </button>
          ))}
        </div>
      )}
      {!data ? (
        !online ? (
          <div className={styles.empty}>
            <h3>You’re offline</h3>
            <p>Reconnect to load the documents for this case.</p>
          </div>
        ) : error ? (
          <div className={styles.empty} role="alert">
            <span className={styles.emptyIcon}>
              <DocumentIcon />
            </span>
            <h3>Unable to load documents</h3>
            <p>{error}</p>
            {!denied && (
              <Button
                variant="secondary"
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
              >
                {query.isFetching ? 'Trying again…' : 'Try again'}
              </Button>
            )}
          </div>
        ) : (
          <div className={styles.loading} role="status" aria-label="Loading documents">
            {[0, 1, 2].map((row) => (
              <div key={row} className={styles.skeletonRow} aria-hidden="true">
                <span className={styles.skeletonIcon} />
                <span className={styles.skeletonText} />
                <span className={styles.skeletonMeta} />
              </div>
            ))}
          </div>
        )
      ) : (
        <>
          <div aria-busy={navigating}>
            {!data.items.length ? (
              <div className={styles.empty}>
                <span className={styles.emptyIcon}>
                  <DocumentIcon />
                </span>
                <h3>{empty.title}</h3>
                <p>{empty.description}</p>
                {page > 1 && (
                  <Button variant="secondary" onClick={() => selectPage(1)}>
                    First page
                  </Button>
                )}
              </div>
            ) : (
              <DocumentList
                key={`${caseId}-${filter}-${page}`}
                items={data.items}
                role={role}
                archived={archived}
                busy={actions.busy}
                onAction={(document, action) => {
                  processing.dismissError();
                  actions.act(document, action);
                }}
                disabled={actionsDisabled}
                processingId={processing.busy ? (processing.selected?.id ?? null) : null}
                onExtract={(document) => {
                  actions.dismissError();
                  processing.dismissError();
                  facts.open(document);
                }}
                renderFacts={(document) => (
                  <FactsPanel
                    key={document.id}
                    document={document}
                    role={role}
                    archived={archived}
                    request={request}
                    onAccessRejected={onAccessRejected}
                    disabled={!canAct}
                    onDownload={() => actions.act(document, DocumentAction.Download)}
                  />
                )}
                onProcess={(document) => {
                  actions.dismissError();
                  processing.open(document);
                }}
              />
            )}
          </div>
          {(data.total > data.pageSize || page > 1) && <Pagination {...data} onPage={selectPage} />}
        </>
      )}
      <span ref={announcement} className="sr-only" role="status" aria-atomic="true" />
    </section>
  );
}
