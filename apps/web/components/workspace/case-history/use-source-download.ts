'use client';

import { useEffect, useRef, useState } from 'react';
import type { AuthRequest } from '../../../hooks/use-authentication';
import { ApiError } from '../../../lib/api';
import { downloadDocument, type DocumentDownloadTarget } from '../../../lib/documents/download';
import { accessRejected } from '../../../lib/processing/resources';
import { useToast } from '../../ui/toast-provider';

export function useSourceDownload({
  request,
  enabled,
  refresh,
  onAccessRejected,
}: {
  request: AuthRequest;
  enabled: boolean;
  refresh: () => Promise<unknown>;
  onAccessRejected: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const toast = useToast();
  useEffect(() => () => controller.current?.abort(), []);

  async function download(target: DocumentDownloadTarget) {
    if (!enabled || controller.current) {
      return;
    }
    const operation = new AbortController();
    controller.current = operation;
    setBusy(target.id);
    setError(null);
    try {
      await downloadDocument(request, target, operation.signal);
      toast('Download requested. Check your browser’s downloads.');
    } catch (issue) {
      if (operation.signal.aborted) {
        return;
      }
      const message = issue instanceof Error ? issue.message : 'Unable to download this source.';
      if (accessRejected(issue)) {
        onAccessRejected(message);
      } else {
        setError(message);
        if (issue instanceof ApiError && issue.status === 409) {
          await refresh();
        }
      }
    } finally {
      controller.current = null;
      if (!operation.signal.aborted) {
        setBusy(null);
      }
    }
  }

  return { download, busy, error };
}
