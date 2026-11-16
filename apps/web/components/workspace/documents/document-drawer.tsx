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
  lead,
  title,
  placeholder,
}: {
  /** Null while a standalone drawer loads its document; `placeholder` fills the body meanwhile. */
  document: DocumentListItem | null;
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
  /** Shown first in the side rail, e.g. the search passage that led here. */
  lead?: ReactNode;
  /** Title before the document has loaded. */
  title?: string;
  placeholder?: ReactNode;
}) {
  // One Drawer whether or not the document has loaded, so it opens and animates only once.
  return (
    <Drawer
      open={open}
      title={document?.filename ?? title ?? 'Document'}
      description={
        document
          ? `${documentTypeLabels[document.contentType]} · ${formatFileSize(document.sizeBytes)}`
          : undefined
      }
      actions={
        document && (
          <DocumentActions
            document={document}
            role={role}
            archived={archived}
            busy={busy}
            disabled={disabled}
            onAction={onAction}
          />
        )
      }
      onClose={onClose}
      onExited={onExited}
    >
      {!document ? (
        placeholder
      ) : (
        <DocumentInspector
          aside={
            <>
              {lead}
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
      )}
    </Drawer>
  );
}
