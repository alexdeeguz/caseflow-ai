'use client';

import { useEffect, useRef, useState } from 'react';
import { documentSchema, type Document } from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import { ApiError } from '../../../lib/api';
import { downloadDocument } from '../../../lib/documents/download';
import { DocumentAction } from '../../../lib/documents/actions';
import { useToast } from '../../ui/toast-provider';

export function useDocumentActions(
  request: AuthRequest,
  refresh: () => Promise<unknown>,
  onAccessRejected: (message: string) => void,
  enabled = true,
) {
  const toast = useToast();
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState<{ id: string; action: DocumentAction } | null>(null);
  const [removing, setRemoving] = useState<Document | null>(null);
  const [completedAction, setCompletedAction] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  async function perform(document: Document, action: DocumentAction) {
    if (!enabled || controller.current) {
      return;
    }
    const operation = new AbortController();
    controller.current = operation;
    setBusy({ id: document.id, action });
    setError(null);
    const path = `/cases/${document.caseId}/documents/${document.id}/${action}`;
    const options = { method: 'POST', signal: operation.signal, timeoutMs: 60000 };
    try {
      if (action === DocumentAction.Download) {
        await downloadDocument(request, document, operation.signal);
        toast('Download requested. Check your browser’s downloads.');
      } else {
        await request(path, documentSchema, {
          ...options,
          body: JSON.stringify({ expectedVersion: document.version }),
        });
        operation.signal.throwIfAborted();
        setRemoving(null);
        toast(action === DocumentAction.Remove ? 'Document removed.' : 'Document restored.');
        setCompletedAction((value) => value + 1);
      }
    } catch (issue) {
      if (operation.signal.aborted) {
        return;
      }
      const message = issue instanceof Error ? issue.message : 'Unable to complete this action.';
      if (issue instanceof ApiError && [401, 403, 404].includes(issue.status)) {
        onAccessRejected(message);
      } else {
        setError(message);
        if (issue instanceof ApiError && issue.status === 409) {
          setRemoving(null);
          await refresh();
        }
      }
    } finally {
      if (!operation.signal.aborted) {
        setBusy(null);
      }
      controller.current = null;
    }
  }

  return {
    busy,
    completedAction,
    removing,
    error,
    dismissError: () => setError(null),
    cancel: () => {
      if (!controller.current) {
        setRemoving(null);
        setError(null);
      }
    },
    confirm: () => {
      if (removing) {
        void perform(removing, DocumentAction.Remove);
      }
    },
    act(document: Document, action: DocumentAction) {
      if (!enabled || controller.current) {
        return;
      }
      if (action === DocumentAction.Remove) {
        setError(null);
        setRemoving(document);
      } else {
        void perform(document, action);
      }
    },
  };
}
