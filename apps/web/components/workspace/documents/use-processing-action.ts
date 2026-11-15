'use client';

import { useEffect, useRef, useState } from 'react';
import { type DocumentListItem, type Role } from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import { ApiError } from '../../../lib/api';
import { processingAction, processingRequestFeedback } from '../../../lib/processing/presentation';
import { accessRejected, processingResource } from '../../../lib/processing/resources';
import { useToast } from '../../ui/toast-provider';

export function useProcessingAction({
  request,
  role,
  archived,
  enabled,
  refresh,
  onAccessRejected,
}: {
  request: AuthRequest;
  role: Role;
  archived: boolean;
  enabled: boolean;
  refresh: () => Promise<unknown>;
  onAccessRejected: (message: string) => void;
}) {
  const toast = useToast();
  const controller = useRef<AbortController | null>(null);
  const [selected, setSelected] = useState<DocumentListItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [completedAction, setCompletedAction] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  async function confirm() {
    if (
      !enabled ||
      !selected ||
      controller.current ||
      !processingAction(selected, role, archived)
    ) {
      return;
    }

    const operation = new AbortController();
    controller.current = operation;
    setBusy(true);
    setError(null);
    const resource = processingResource(selected.caseId, selected.id);

    try {
      const summary = await request(resource.path, resource.schema, {
        method: 'POST',
        body: JSON.stringify({ expectedJobId: selected.processing.job?.id ?? null }),
        signal: operation.signal,
      });
      operation.signal.throwIfAborted();
      setSelected(null);
      toast(processingRequestFeedback(summary));
      setCompletedAction((value) => value + 1);
    } catch (issue) {
      if (operation.signal.aborted) {
        return;
      }
      const message = issue instanceof Error ? issue.message : 'Unable to request processing.';
      if (accessRejected(issue)) {
        setSelected(null);
        onAccessRejected(message);
      } else {
        setError(message);
        if (issue instanceof ApiError && issue.status === 409) {
          setSelected(null);
        }
        // Reconcile an uncertain response without replacing its idempotency expectation.
        await refresh();
      }
    } finally {
      if (!operation.signal.aborted) {
        setBusy(false);
      }
      controller.current = null;
    }
  }

  return {
    selected,
    busy,
    completedAction,
    error,
    dismissError: () => setError(null),
    confirm: () => void confirm(),
    open(document: DocumentListItem) {
      if (enabled && !controller.current && processingAction(document, role, archived)) {
        setError(null);
        setSelected(document);
      }
    },
    cancel() {
      if (!controller.current) {
        setSelected(null);
        setError(null);
      }
    },
  };
}
