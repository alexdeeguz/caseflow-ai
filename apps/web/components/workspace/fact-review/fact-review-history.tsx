'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { factReviewActionLabels } from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import { factReviewHistoryResource } from '../../../lib/fact-review/resources';
import { resourceOptions } from '../../../lib/resources';
import { documentLibraryState } from '../../../lib/processing/resources';
import { Pagination } from '../../ui/pagination';
import { DocumentDate } from '../documents/document-details';
import { FactValuesDisplay } from './fact-values';
import { FactReviewBadge } from './fact-review-badge';
import styles from './review.module.css';

export function FactReviewHistory({
  caseId,
  documentId,
  factId,
  request,
  disabled,
  onAccessRejected,
}: {
  caseId: string;
  documentId: string;
  factId: string;
  request: AuthRequest;
  disabled: boolean;
  onAccessRejected: (message: string) => void;
}) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    ...resourceOptions(request, factReviewHistoryResource(caseId, documentId, factId, page)),
    enabled: !disabled,
  });
  const state = documentLibraryState(query);
  useEffect(() => {
    if (state.denied && state.error) {
      onAccessRejected(state.error);
    }
  }, [state.denied, state.error, onAccessRejected]);

  return (
    <section aria-label="Review history" className={styles.history}>
      <h5>Review history</h5>
      {state.error && <p role="alert">{state.error}</p>}
      {state.stale && <p>Showing the last verified history.</p>}
      {state.data ? (
        <>
          {state.data.items.length ? (
            <ol>
              {state.data.items.map((revision) => (
                <li key={revision.version}>
                  <div className={styles.actions}>
                    <strong>Revision {revision.version}</strong>
                    <FactReviewBadge status={revision.status} />
                  </div>
                  <p className={styles.muted}>
                    {factReviewActionLabels[revision.action]} ·{' '}
                    <DocumentDate value={revision.createdAt} detailed />
                  </p>
                  <p className={styles.muted}>Reviewer ID: {revision.actorId}</p>
                  <FactValuesDisplay values={revision.values} />
                  {revision.reason && (
                    <p className={styles.reason}>
                      <strong>Reason:</strong> {revision.reason}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p>No review changes yet. The original extraction is revision 1.</p>
          )}
          {(state.data.total > state.data.pageSize || page > 1) && (
            <Pagination {...state.data} onPage={setPage} />
          )}
        </>
      ) : (
        !state.error && <p role="status">Loading review history…</p>
      )}
    </section>
  );
}
