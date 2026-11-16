'use client';

import { useState } from 'react';
import {
  Role,
  SearchIndexStatus,
  searchIndexSummarySchema,
  type DocumentListItem,
} from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import { useToast } from '../../ui/toast-provider';
import styles from './documents.module.css';

export function searchIndexLabel(document: DocumentListItem): string {
  switch (document.searchIndex?.status) {
    case SearchIndexStatus.Ready:
      return 'Searchable';
    case SearchIndexStatus.Partial:
      return 'Exact words only';
    case SearchIndexStatus.Queued:
    case SearchIndexStatus.Indexing:
      return 'Preparing for search';
    case SearchIndexStatus.Failed:
      return 'Not searchable';
    default:
      return 'Not indexed yet';
  }
}

const retryable: ReadonlySet<string> = new Set([
  SearchIndexStatus.Partial,
  SearchIndexStatus.Failed,
  SearchIndexStatus.Cancelled,
]);

/** Administrators can re-index a document whose search indexing did not fully complete. */
export function SearchIndexAction({
  document,
  role,
  archived,
  disabled,
  request,
}: {
  document: DocumentListItem;
  role: Role;
  archived: boolean;
  disabled: boolean;
  request: AuthRequest;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (role === Role.Staff || archived || !retryable.has(document.searchIndex?.status ?? '')) {
    return null;
  }

  async function reindex() {
    setBusy(true);
    setError(null);
    try {
      await request(
        `/cases/${document.caseId}/documents/${document.id}/search-index`,
        searchIndexSummarySchema,
        { method: 'POST', body: '{}' },
      );
      toast('Search indexing queued.');
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Unable to queue search indexing.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={styles.nextAction}
        disabled={disabled || busy}
        onClick={() => void reindex()}
      >
        {busy ? 'Queuing…' : 'Re-index for search'}
        <span className="sr-only"> {document.filename}</span>
      </button>
      {error && (
        <span role="alert" className={styles.archiveHint}>
          {error}
        </span>
      )}
    </>
  );
}
