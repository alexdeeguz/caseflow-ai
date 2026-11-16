'use client';

import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DocumentFilter, Role, type DocumentListItem } from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import { useVerifiedConnection } from '../../../hooks/use-online';
import { documentListResource } from '../../../lib/documents/resources';
import { documentLibraryOptions, documentLibraryState } from '../../../lib/processing/resources';
import { LoadingIndicator } from '../../ui/spinner';
import { StatusMessage } from '../../ui/status-message';
import { DocumentDrawer } from './document-drawer';
import { FactExtractionActionButton } from './fact-extraction-action-button';
import { FactExtractionConfirmation } from './fact-extraction-confirmation';
import { FactsPanel } from './facts-panel';
import { ProcessingConfirmation } from './processing-confirmation';
import { RemoveDocumentConfirmation } from './remove-document-confirmation';
import { useDocumentActions } from './use-document-actions';
import { useFactExtractionAction } from './use-fact-extraction-action';
import { useProcessingAction } from './use-processing-action';

/**
 * The Documents tab's details drawer for use outside the library (e.g. search results): loads the
 * document and its actions itself, so file details, processing, and fact review work the same.
 */
export function StandaloneDocumentDrawer({
  caseId,
  documentId,
  filename,
  archived,
  role,
  request,
  open,
  lead,
  onClose,
  onExited,
  onAccessRejected,
}: {
  caseId: string;
  documentId: string;
  /** Title while the document loads. */
  filename: string;
  archived: boolean;
  role: Role;
  request: AuthRequest;
  open: boolean;
  lead?: ReactNode;
  onClose: () => void;
  onExited: () => void;
  onAccessRejected: (message: string) => void;
}) {
  // Same lookup the library uses for documents outside its current page.
  const query = useQuery(
    documentLibraryOptions(
      request,
      documentListResource(caseId, {
        filter: role === Role.Staff ? DocumentFilter.Current : DocumentFilter.All,
        page: 1,
        pageSize: 100,
      }),
    ),
  );
  const { data, error } = documentLibraryState(query);
  const { verified } = useVerifiedConnection(query.dataUpdatedAt);
  const canAct = !!data && !error && verified;
  const refresh = () => query.refetch();
  const processing = useProcessingAction({
    request,
    role,
    archived,
    enabled: canAct,
    refresh,
    onAccessRejected,
  });
  const facts = useFactExtractionAction({
    request,
    role,
    archived,
    enabled: canAct,
    refresh,
    onAccessRejected,
  });
  const actions = useDocumentActions(
    request,
    refresh,
    onAccessRejected,
    canAct && !processing.busy && !facts.busy,
  );
  const disabled = !canAct || actions.busy !== null || processing.busy || facts.busy;
  const actionError = actions.error ?? processing.error ?? facts.error;
  const confirming =
    actions.removing !== null || processing.selected !== null || facts.selected !== null;
  const document = data?.items.find((item) => item.id === documentId) ?? null;

  const renderFacts = (target: DocumentListItem) => (
    <FactsPanel
      key={target.id}
      document={target}
      role={role}
      archived={archived}
      request={request}
      onAccessRejected={onAccessRejected}
      disabled={!canAct}
      action={
        <FactExtractionActionButton
          document={target}
          role={role}
          archived={archived}
          disabled={disabled}
          onExtract={(next) => {
            actions.dismissError();
            processing.dismissError();
            facts.open(next);
          }}
        />
      }
    />
  );

  return (
    <>
      <DocumentDrawer
        document={document}
        title={filename}
        placeholder={
          !data && !error ? (
            <LoadingIndicator label="Loading document…" size="lg" />
          ) : (
            <StatusMessage tone={error ? 'error' : undefined}>
              {error ?? 'This document is no longer available in its case.'}
            </StatusMessage>
          )
        }
        open={open}
        role={role}
        archived={archived}
        busy={actions.busy}
        disabled={disabled}
        processingBusy={processing.busy && processing.selected?.id === documentId}
        onAction={(target, action) => {
          processing.dismissError();
          actions.act(target, action);
        }}
        onProcess={(target) => {
          actions.dismissError();
          processing.open(target);
        }}
        renderFacts={renderFacts}
        onClose={onClose}
        onExited={onExited}
        request={request}
        lead={
          <>
            {actionError && !confirming && (
              <StatusMessage tone="error">{actionError}</StatusMessage>
            )}
            {lead}
          </>
        }
      />
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
    </>
  );
}
