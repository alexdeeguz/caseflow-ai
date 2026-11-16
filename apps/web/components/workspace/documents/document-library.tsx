'use client';

import { useEffect, useRef, useState } from 'react';
import { useFactExtractionAction } from './use-fact-extraction-action';
import { FactExtractionConfirmation } from './fact-extraction-confirmation';
import { FactsPanel } from './facts-panel';
import { useQuery } from '@tanstack/react-query';
import { DocumentFilter, Role, type DocumentListItem } from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import type { WorkspaceNavigate } from '../../../hooks/use-workspace-navigation';
import type { WorkspaceLocation } from '../../../lib/workspace-location';
import { useVerifiedConnection } from '../../../hooks/use-online';
import { documentLibraryOptions, documentLibraryState } from '../../../lib/processing/resources';
import { ProcessingConfirmation } from './processing-confirmation';
import { useProcessingAction } from './use-processing-action';
import { useProcessingUpdates } from './use-processing-updates';
import { documentLibraryQuery, documentListResource } from '../../../lib/documents/resources';
import { documentEmptyState, documentFilterLabels } from '../../../lib/documents/presentation';
import { Button } from '../../ui/button';
import { SegmentedControl } from '../../ui/segmented-control';
import { CaseSectionLayout } from '../case-section-layout';
import { Pagination } from '../../ui/pagination';
import { DocumentIcon } from './document-icon';
import { UploadIcon } from './document-icons';
import { RemoveDocumentConfirmation } from './remove-document-confirmation';
import { StatusMessage } from '../../ui/status-message';
import { UploadModal } from './upload-modal';
import { useDocumentActions } from './use-document-actions';
import { DocumentList } from './document-list';
import { DocumentDrawer } from './document-drawer';
import { SearchField } from '../search/search-field';
import { CaseDocumentSearch } from '../search/case-document-search';
import { isSearchable } from '../../../lib/search/resources';
import searchStyles from '../search/search.module.css';
import { FactExtractionActionButton } from './fact-extraction-action-button';
import { useReviewTotals } from './use-review-totals';
import { useUploads } from './upload-provider';
import { UploadPhase, isUploadRunning } from '../../../lib/documents/upload-types';
import type { ReviewTotals } from '../../../lib/documents/state';
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
  const review = useReviewTotals(request, caseId);
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
  const { items: uploadItems } = useUploads();
  const caseUploads = uploadItems.filter((item) => item.case.id === caseId);
  const uploadsActive = caseUploads.filter(
    (item) => isUploadRunning(item.phase) || item.phase === UploadPhase.Queued,
  ).length;
  const uploadsNeedAttention = caseUploads.some(
    (item) => item.phase === UploadPhase.Failed || item.phase === UploadPhase.Stopped,
  );
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
  // The drawer can be opened from a row, a search result, or a `document` link in the URL.
  const [selectedId, setSelectedId] = useState<string | null>(location.document);
  const [drawerOpen, setDrawerOpen] = useState(location.document !== null);
  const [requested, setRequested] = useState(location.document);
  if (location.document !== requested) {
    setRequested(location.document);
    if (location.document) {
      setSelectedId(location.document);
      setDrawerOpen(true);
    }
  }
  const openDocument = (id: string) => {
    setSelectedId(id);
    setDrawerOpen(true);
  };
  const closeDocument = () => {
    setDrawerOpen(false);
    if (location.document) {
      void navigate({ ...location, document: null }, { replace: true });
    }
  };
  const listed = data?.items.find((document) => document.id === selectedId) ?? null;
  const lookup = useQuery({
    ...documentLibraryOptions(
      request,
      documentListResource(caseId, {
        filter: role === Role.Staff ? DocumentFilter.Current : DocumentFilter.All,
        page: 1,
        pageSize: 100,
      }),
    ),
    enabled: selectedId !== null && !!data && !listed,
  });
  const selected =
    listed ?? lookup.data?.items.find((document) => document.id === selectedId) ?? null;
  const searchingCase = isSearchable(location.documentQuery);
  const renderFacts = (document: DocumentListItem) => (
    <FactsPanel
      key={document.id}
      document={document}
      role={role}
      archived={archived}
      request={request}
      onAccessRejected={onAccessRejected}
      disabled={!canAct}
      action={
        <FactExtractionActionButton
          document={document}
          role={role}
          archived={archived}
          disabled={actionsDisabled}
          onExtract={(target) => {
            actions.dismissError();
            processing.dismissError();
            facts.open(target);
          }}
        />
      }
    />
  );
  const empty = documentEmptyState(filter, page);
  const navigating = pendingLocation !== null;
  const selectPage = (documentPage: number) =>
    void navigate({ ...location, documentFilter: filter, documentPage });

  if (denied) {
    return <StatusMessage tone="error">{error}</StatusMessage>;
  }

  return (
    <CaseSectionLayout
      id="documents-heading"
      title="Documents"
      headingRef={heading}
      loading={navigating}
      summary={data && <DocumentsSummary total={data.total} review={review} />}
      actions={
        <>
          <div className={searchStyles.caseSearch}>
            <SearchField
              label="Search this case’s documents"
              value={location.documentQuery}
              placeholder="Search text in these documents"
              onSearch={(documentQuery) =>
                void navigate(
                  { ...location, documentQuery, documentQueryPage: 1 },
                  { replace: true },
                )
              }
            />
          </div>
          {role !== Role.Staff && !searchingCase && (
            <SegmentedControl
              label="Document visibility"
              options={Object.values(DocumentFilter).map((value) => ({
                value,
                label: documentFilterLabels[value],
              }))}
              value={filter}
              pendingValue={pendingLocation?.documentFilter}
              onChange={(value) =>
                void navigate({ ...location, documentFilter: value, documentPage: 1 })
              }
            />
          )}
          {!archived && (
            <Button
              ref={uploadButton}
              className={styles.uploadButton}
              disabled={actionsDisabled}
              aria-haspopup="dialog"
              onClick={() => setUploadOpen((value) => !value)}
            >
              <UploadIcon />
              {uploadsActive
                ? `Uploading ${uploadsActive}…`
                : uploadsNeedAttention
                  ? 'Uploads need attention'
                  : 'Upload files'}
            </Button>
          )}
        </>
      }
    >
      {archived && (
        <p className={styles.archiveHint}>
          Downloads remain available. Restore this case before uploading, processing, removing, or
          restoring documents.
        </p>
      )}
      {!archived && (
        <UploadModal
          key={caseId}
          open={uploadOpen && canAct}
          target={{ id: caseId, label: caseLabel }}
          onClose={closeUpload}
        />
      )}
      {actionError && !confirming && (
        <div ref={errorSummary} tabIndex={-1}>
          <StatusMessage tone="error">{actionError}</StatusMessage>
        </div>
      )}
      <RemoveDocumentConfirmation actions={actions} canAct={canAct} />
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
        <div className={styles.notice}>
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
      {searchingCase ? (
        <CaseDocumentSearch
          request={request}
          caseId={caseId}
          location={location}
          navigate={navigate}
          onOpen={openDocument}
        />
      ) : !data ? (
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
                <span className={styles.skeletonTrack} />
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
                disabled={actionsDisabled}
                selectedId={drawerOpen ? selectedId : null}
                onOpenDetails={openDocument}
                onAction={(document, action) => {
                  processing.dismissError();
                  actions.act(document, action);
                }}
              />
            )}
          </div>
          {(data.total > data.pageSize || page > 1) && <Pagination {...data} onPage={selectPage} />}
        </>
      )}
      {selected && (
        <DocumentDrawer
          key={selected.id}
          document={selected}
          open={drawerOpen}
          role={role}
          archived={archived}
          busy={actions.busy}
          disabled={actionsDisabled}
          processingBusy={processing.busy && processing.selected?.id === selected.id}
          onAction={(document, action) => {
            processing.dismissError();
            actions.act(document, action);
          }}
          onProcess={(document) => {
            actions.dismissError();
            processing.open(document);
          }}
          renderFacts={renderFacts}
          onClose={closeDocument}
          onExited={() => setSelectedId(null)}
          request={request}
        />
      )}
      <span ref={announcement} className="sr-only" role="status" aria-atomic="true" />
    </CaseSectionLayout>
  );
}

function DocumentsSummary({ total, review }: { total: number; review: ReviewTotals | null }) {
  return (
    <>
      {total} {total === 1 ? 'document' : 'documents'}
      {review && review.unreviewed > 0 ? (
        <>
          {' · '}
          <strong className={styles.reviewCount}>
            {review.unreviewed}
            {review.partial ? '+' : ''} {review.unreviewed === 1 ? 'fact' : 'facts'} to review
          </strong>
        </>
      ) : review && review.facts > 0 && !review.partial ? (
        ' · All facts reviewed'
      ) : null}
      {' · Newest first'}
    </>
  );
}
