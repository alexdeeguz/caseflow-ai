'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DocumentFilter, Role } from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import type { WorkspaceNavigate } from '../../../hooks/use-workspace-navigation';
import type { WorkspaceLocation } from '../../../lib/workspace-location';
import { ApiError } from '../../../lib/api';
import { resourceOptions, resourceState } from '../../../lib/resources';
import { documentLibraryQuery, documentListResource } from '../../../lib/documents/resources';
import { documentEmptyState, documentFilterLabels } from '../../../lib/documents/presentation';
import { Button } from '../../ui/button';
import { Pagination } from '../../ui/pagination';
import { DocumentIcon } from './document-icon';
import { DocumentList } from './document-list';
import styles from './documents.module.css';

export function DocumentLibrary({
  caseId,
  role,
  request,
  location,
  navigate,
  pendingLocation,
  onAccessRejected,
}: {
  caseId: string;
  role: Role;
  request: AuthRequest;
  location: WorkspaceLocation;
  navigate: WorkspaceNavigate;
  pendingLocation: WorkspaceLocation | null;
  onAccessRejected: (message: string) => void;
}) {
  const { filter, page } = documentLibraryQuery(location, role);
  const query = useQuery(resourceOptions(request, documentListResource(caseId, { filter, page })));
  const { data, error } = resourceState(query);
  const denied = query.error instanceof ApiError && [401, 403, 404].includes(query.error.status);

  useEffect(() => {
    if (denied && error) {
      onAccessRejected(error);
    }
  }, [denied, error, onAccessRejected]);

  const empty = documentEmptyState(filter, page);
  const navigating = pendingLocation !== null;
  const selectPage = (documentPage: number) =>
    void navigate({ ...location, documentFilter: filter, documentPage });

  return (
    <section aria-labelledby="documents-heading" className={styles.library}>
      <header className={styles.header}>
        <div>
          <div className={styles.heading}>
            <h2 id="documents-heading">Documents</h2>
            {data && (
              <span
                className={styles.count}
                aria-label={`${data.total} ${data.total === 1 ? 'document' : 'documents'} in this view`}
              >
                {data.total}
              </span>
            )}
          </div>
          <p className={styles.subtitle}>Files and supporting records for this case.</p>
        </div>
        <span className={styles.order}>Newest first</span>
      </header>
      {role !== Role.Staff && (
        <div role="group" aria-label="Document visibility" className={styles.filters}>
          {Object.values(DocumentFilter).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              aria-busy={pendingLocation?.documentFilter === value && filter !== value}
              onClick={() => void navigate({ ...location, documentFilter: value, documentPage: 1 })}
            >
              {documentFilterLabels[value]}
            </button>
          ))}
        </div>
      )}
      {!data ? (
        error ? (
          <div className={styles.empty} role="alert">
            <span className={styles.emptyIcon}>
              <DocumentIcon />
            </span>
            <h3>{denied ? 'Documents unavailable' : 'Unable to load documents'}</h3>
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
                <span className={styles.skeletonMeta} />
              </div>
            ))}
          </div>
        )
      ) : (
        <>
          <div aria-busy={navigating || query.isFetching}>
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
              <DocumentList key={`${caseId}-${filter}-${page}`} items={data.items} />
            )}
          </div>
          {(data.total > data.pageSize || page > 1) && <Pagination {...data} onPage={selectPage} />}
          <span className="sr-only" role="status">
            {navigating
              ? 'Updating documents…'
              : `${data.total} ${data.total === 1 ? 'document' : 'documents'} in this view.`}
          </span>
        </>
      )}
    </section>
  );
}
