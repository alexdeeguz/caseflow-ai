'use client';

import type { ReactNode } from 'react';
import type { Document, DocumentListItem, Role } from '@caseflow/schemas';
import type { DocumentAction } from '../../../lib/documents/actions';
import { documentTypeLabels, formatFileSize } from '../../../lib/documents/presentation';
import { Drawer } from '../../ui/overlay-dialog';
import { DocumentActions } from './document-actions';
import { DocumentDetails } from './document-details';
import { DocumentInspector } from './document-inspector';
import { ProcessingActionButton } from './processing-action-button';
import { ProcessingDetails } from './processing-details';
import { SearchIndexAction } from './search-index-status';
import type { AuthRequest } from '../../../hooks/use-authentication';

/** Details for one document: file and processing info beside its extracted facts. */
export function DocumentDrawer({
  document,
  open,
  role,
  archived,
  busy,
  disabled,
  processingBusy,
  onAction,
  onProcess,
  renderFacts,
  onClose,
  onExited,
  request,
}: {
  document: DocumentListItem;
  open: boolean;
  role: Role;
  archived: boolean;
  busy: { id: string; action: DocumentAction } | null;
  disabled: boolean;
  processingBusy: boolean;
  onAction: (document: Document, action: DocumentAction) => void;
  onProcess: (document: DocumentListItem) => void;
  renderFacts: (document: DocumentListItem) => ReactNode;
  onClose: () => void;
  onExited: () => void;
  request: AuthRequest;
}) {
  return (
    <Drawer
      open={open}
      title={document.filename}
      description={`${documentTypeLabels[document.contentType]} · ${formatFileSize(document.sizeBytes)}`}
      actions={
        <DocumentActions
          document={document}
          role={role}
          archived={archived}
          busy={busy}
          disabled={disabled}
          onAction={onAction}
        />
      }
      onClose={onClose}
      onExited={onExited}
    >
      <DocumentInspector
        aside={
          <>
            <DocumentDetails document={document} />
            <ProcessingDetails
              document={document}
              action={
                <>
                  <ProcessingActionButton
                    document={document}
                    role={role}
                    archived={archived}
                    disabled={disabled}
                    busy={processingBusy}
                    onProcess={onProcess}
                  />
                  <SearchIndexAction
                    document={document}
                    role={role}
                    archived={archived}
                    disabled={disabled}
                    request={request}
                  />
                </>
              }
            />
          </>
        }
      >
        {renderFacts(document)}
      </DocumentInspector>
    </Drawer>
  );
}
