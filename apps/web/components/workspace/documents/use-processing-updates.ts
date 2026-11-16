'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DocumentListItem } from '@caseflow/schemas';
import { processingAnnouncement, processingChanges } from '../../../lib/processing/presentation';
import { processingResource } from '../../../lib/processing/resources';

export function useProcessingUpdates(
  key: string,
  data: { items: DocumentListItem[]; total: number } | null,
  stale: boolean,
) {
  const client = useQueryClient();
  const region = useRef<HTMLSpanElement>(null);
  const paused = useRef(false);
  const previous = useRef<{ key: string; items: DocumentListItem[] } | null>(null);

  useEffect(() => {
    if (!data) {
      return;
    }
    if (stale) {
      if (!paused.current && region.current) {
        region.current.textContent =
          'Document updates are paused. Showing the last verified information; actions are unavailable.';
      }
      paused.current = true;
      return;
    }
    const resumed = paused.current;
    paused.current = false;
    const before = previous.current;
    previous.current = { key, items: data.items };
    if (!before || before.key !== key) {
      if (region.current) {
        region.current.textContent = `${data.total} ${data.total === 1 ? 'document' : 'documents'} in this view.`;
      }
      return;
    }

    const changed = processingChanges(before.items, data.items);
    if (!changed.length) {
      if (resumed && region.current) {
        region.current.textContent = 'Document updates resumed. Access verified.';
      }
      return;
    }
    if (region.current) {
      region.current.textContent = processingAnnouncement(changed);
    }
    const paths = new Set(
      changed.map((document) => processingResource(document.caseId, document.id).path),
    );
    void client.invalidateQueries({
      predicate: ({ queryKey }) =>
        String(queryKey[0]).startsWith('/admin/audit') ||
        paths.has(String(queryKey[0])) ||
        changed.some(
          (document) =>
            String(queryKey[0]).startsWith(
              `/cases/${document.caseId}/documents/${document.id}/facts?`,
            ) ||
            String(queryKey[0]) ===
              `/cases/${document.caseId}/documents/${document.id}/fact-extraction`,
        ),
    });
  }, [key, data, stale, client]);

  return region;
}
