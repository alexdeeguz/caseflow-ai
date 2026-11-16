'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { User } from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import type { WorkspaceNavigate } from '../../../hooks/use-workspace-navigation';
import type { WorkspaceLocation } from '../../../lib/workspace-location';
import { resourceOptions } from '../../../lib/resources';
import { documentLibraryState } from '../../../lib/processing/resources';
import { caseDetailResource } from '../../../lib/workspace-resources';
import { CaseSection, caseSectionLabels } from '../../../lib/constants/navigation';
import { ArrowLeftIcon } from '../workspace-icons';
import { StatusMessage } from '../../ui/status-message';
import { LoadState } from '../../ui/load-state';
import { DocumentLibrary } from '../documents/document-library';
import { useReviewTotals } from '../documents/use-review-totals';
import { CaseHistory } from '../case-history/case-history';
import { CaseOverview } from './case-overview';
import { CaseStatusBadge } from './case-status-badge';
import styles from './cases.module.css';

export function CaseDetail({
  id,
  user,
  request,
  onBack,
  onEdit,
  location,
  navigate,
  pendingLocation,
}: {
  id: string;
  user: User;
  request: AuthRequest;
  onBack: () => void;
  onEdit: () => void;
  location: WorkspaceLocation;
  navigate: WorkspaceNavigate;
  pendingLocation: WorkspaceLocation | null;
}) {
  const query = useQuery(resourceOptions(request, caseDetailResource(id)));
  const state = documentLibraryState(query);
  const historySection =
    location.section === CaseSection.Timeline || location.section === CaseSection.ReviewedSummary;
  const { error } = state;
  const data = error && !historySection ? null : state.data;
  const [accessError, setAccessError] = useState<string | null>(null);
  const review = useReviewTotals(request, id);

  return (
    <section className={styles.detail}>
      <div className={styles.crumbs}>
        <button type="button" className={styles.backLink} onClick={onBack}>
          <ArrowLeftIcon />
          Back to cases
        </button>
        {data && !accessError && (
          <>
            <span className={styles.crumbSeparator} aria-hidden="true">
              /
            </span>
            <span className={styles.caseChip}>{data.case.caseNumber}</span>
          </>
        )}
      </div>
      {!data || accessError ? (
        <LoadState error={accessError ?? error} />
      ) : (
        <>
          <header className={styles.detailHeader}>
            <div className={styles.titleRow}>
              <h1>{data.case.title}</h1>
              <CaseStatusBadge status={data.case.status} />
            </div>
          </header>
          {data.case.archivedAt && (
            <StatusMessage>
              Archived on{' '}
              <time dateTime={data.case.archivedAt}>
                {new Date(data.case.archivedAt).toLocaleString()}
              </time>
              . Case details are read-only until restored. Data and assignments are retained.
            </StatusMessage>
          )}
          <nav aria-label="Case sections" className={styles.sections}>
            {Object.values(CaseSection).map((section) => (
              <button
                key={section}
                type="button"
                aria-current={location.section === section ? 'page' : undefined}
                aria-busy={pendingLocation?.section === section && location.section !== section}
                onClick={() => void navigate({ ...location, section })}
              >
                {caseSectionLabels[section]}
                {section === CaseSection.Documents && review && review.unreviewed > 0 && (
                  <span className={styles.tabBadge}>
                    {review.unreviewed}
                    {review.partial ? '+' : ''}
                    <span className="sr-only">
                      {' '}
                      {review.unreviewed === 1 ? 'fact' : 'facts'} to review
                    </span>
                  </span>
                )}
              </button>
            ))}
          </nav>
          {location.section === CaseSection.Documents ? (
            <DocumentLibrary
              key={id}
              caseId={id}
              caseLabel={data.case.caseNumber}
              archived={data.case.archivedAt !== null}
              role={user.role}
              request={request}
              location={location}
              navigate={navigate}
              pendingLocation={pendingLocation}
              onAccessRejected={setAccessError}
            />
          ) : historySection ? (
            <CaseHistory
              key={`${id}-${location.section}`}
              caseId={id}
              location={location}
              navigate={navigate}
              request={request}
              onAccessRejected={setAccessError}
              navigating={pendingLocation !== null}
              caseError={error}
              refreshCase={() => query.refetch()}
            />
          ) : (
            <CaseOverview
              data={data}
              user={user}
              request={request}
              onEdit={onEdit}
              navigating={pendingLocation !== null}
            />
          )}
        </>
      )}
    </section>
  );
}
