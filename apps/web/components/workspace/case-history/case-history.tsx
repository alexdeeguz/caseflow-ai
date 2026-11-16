'use client';

import { useEffect, useId } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FactCategory,
  factCategoryLabels,
  type CaseTimeline,
  type CaseReviewedSummary,
  type ApprovedCaseFact,
} from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import type { WorkspaceNavigate } from '../../../hooks/use-workspace-navigation';
import { useVerifiedConnection } from '../../../hooks/use-online';
import type { WorkspaceLocation } from '../../../lib/workspace-location';
import { CaseSection } from '../../../lib/constants/navigation';
import {
  caseTimelineResource,
  caseReviewedSummaryResource,
  isCaseHistoryResource,
} from '../../../lib/case-history/resources';
import { resourceOptions } from '../../../lib/resources';
import { documentLibraryState } from '../../../lib/processing/resources';
import { Button } from '../../ui/button';
import { SegmentedControl } from '../../ui/segmented-control';
import { CaseSectionLayout } from '../case-section-layout';
import { formatFactDate, groupTimelineByYear } from '../../../lib/case-history/presentation';
import { Pagination } from '../../ui/pagination';
import { StatusMessage } from '../../ui/status-message';
import { LoadingIndicator } from '../../ui/spinner';
import { ApprovedFactCard } from './approved-fact-card';
import { useSourceDownload } from './use-source-download';
import styles from './case-history.module.css';

type CaseHistoryPage = CaseTimeline | CaseReviewedSummary;

export function CaseHistory({
  caseId,
  location,
  navigate,
  request,
  onAccessRejected,
  navigating,
  caseError,
  refreshCase,
}: {
  caseId: string;
  location: WorkspaceLocation;
  navigate: WorkspaceNavigate;
  request: AuthRequest;
  onAccessRejected: (message: string) => void;
  navigating: boolean;
  caseError: string | null;
  refreshCase: () => Promise<unknown>;
}) {
  const timeline = location.section === CaseSection.Timeline;
  const page = timeline ? location.timelinePage : location.summaryPage;
  const resource = timeline
    ? caseTimelineResource(caseId, page)
    : caseReviewedSummaryResource(caseId, location.summaryCategory, page);
  const query = useQuery({
    ...resourceOptions<CaseHistoryPage>(request, resource),
    networkMode: 'online',
    refetchOnReconnect: 'always',
  });
  const client = useQueryClient();
  const { data, error, denied, stale } = documentLibraryState(query);
  const { online, verified } = useVerifiedConnection(query.dataUpdatedAt);
  const id = useId();
  const summary = data && 'counts' in data ? data : null;
  const title = timeline ? 'Timeline' : 'Reviewed summary';
  const approvedTotal = summary
    ? Object.values(summary.counts).reduce((total, count) => total + count, 0)
    : 0;
  const download = useSourceDownload({
    request,
    enabled: !!data && !error && !caseError && verified && !query.isFetching && !navigating,
    refresh: () =>
      client.invalidateQueries({
        predicate: ({ queryKey }) => isCaseHistoryResource(String(queryKey[0]), caseId),
      }),
    onAccessRejected,
  });

  useEffect(() => {
    if (denied && error) {
      onAccessRejected(error);
    }
  }, [denied, error, onAccessRejected]);

  const selectPage = (next: number) =>
    void navigate({
      ...location,
      ...(timeline ? { timelinePage: next } : { summaryPage: next }),
    });

  const factCard = (fact: ApprovedCaseFact) => (
    <ApprovedFactCard
      fact={fact}
      showDate={!timeline}
      busy={download.busy === fact.documentId}
      disabled={
        !verified ||
        !!error ||
        !!caseError ||
        query.isFetching ||
        navigating ||
        download.busy !== null
      }
      onDownload={() =>
        void download.download({
          caseId,
          id: fact.documentId,
          filename: fact.filename,
        })
      }
    />
  );

  const renderFacts = (items: ApprovedCaseFact[]) =>
    timeline ? (
      <div className={styles.timeline}>
        {groupTimelineByYear(items).map((group, index) => (
          <section key={`${group.year}-${index}`} aria-labelledby={`${id}-year-${index}`}>
            <h3 id={`${id}-year-${index}`} className={styles.year}>
              {group.year}
            </h3>
            <ol className={styles.entries} aria-label={`Approved dates in ${group.year}`}>
              {group.items.map((fact) => (
                <li key={fact.id} className={styles.entry}>
                  <span className={styles.entryDate}>{formatFactDate(fact)}</span>
                  {factCard(fact)}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    ) : (
      <ol className={styles.facts} aria-label={factCategoryLabels[location.summaryCategory]}>
        {items.map((fact) => (
          <li key={fact.id}>{factCard(fact)}</li>
        ))}
      </ol>
    );

  if (denied) {
    return <StatusMessage tone="error">{error}</StatusMessage>;
  }

  return (
    <CaseSectionLayout
      id={`${id}-title`}
      title={title}
      loading={navigating}
      summary={
        summary
          ? `${approvedTotal} approved ${approvedTotal === 1 ? 'fact' : 'facts'} from ${summary.sourceDocumentCount} ${summary.sourceDocumentCount === 1 ? 'document' : 'documents'}`
          : timeline
            ? 'Approved date facts · Oldest first · Partial dates keep their original precision'
            : null
      }
      actions={
        <>
          {!timeline && (
            <SegmentedControl
              label="Summary category"
              options={Object.values(FactCategory).map((category) => ({
                value: category,
                label: factCategoryLabels[category],
                count: summary?.counts[category],
              }))}
              value={location.summaryCategory}
              onChange={(category) =>
                void navigate({ ...location, summaryCategory: category, summaryPage: 1 })
              }
            />
          )}
          <Button
            variant="secondary"
            className={styles.refresh}
            disabled={!online || query.isFetching || navigating}
            onClick={() => void Promise.all([query.refetch(), refreshCase()])}
          >
            {query.isFetching && data ? 'Refreshing…' : 'Refresh'}
          </Button>
        </>
      }
    >
      {data && (stale || !verified || caseError) && (
        <StatusMessage>
          {!online ? 'You’re offline.' : (error ?? caseError ?? 'Verifying current access.')}{' '}
          Showing the last verified information. Refresh to confirm current approvals; downloads are
          paused.
        </StatusMessage>
      )}
      {download.error && <StatusMessage tone="error">{download.error}</StatusMessage>}
      {!data ? (
        error || !online ? (
          <div className={styles.empty} role={error ? 'alert' : 'status'}>
            {error ?? 'Reconnect to load approved information.'}
          </div>
        ) : (
          <LoadingIndicator label={`Loading ${title.toLowerCase()}…`} size="lg" />
        )
      ) : (
        <div aria-busy={query.isFetching || navigating}>
          {!data.items.length ? (
            <div className={styles.empty}>
              <h3>
                {page > 1
                  ? 'No facts on this page'
                  : timeline
                    ? 'No approved date facts yet'
                    : summary && Object.values(summary.counts).some(Boolean)
                      ? 'No approved facts in this category'
                      : 'No approved facts yet'}
              </h3>
              <p>
                {page > 1
                  ? 'The available facts may have changed. Return to the first page.'
                  : 'Only approved facts from available documents appear here. Review facts in Documents to include them.'}
              </p>
              {page > 1 && (
                <Button variant="secondary" onClick={() => selectPage(1)}>
                  First page
                </Button>
              )}
            </div>
          ) : (
            renderFacts(data.items)
          )}
          {(data.total > data.pageSize || page > 1) && <Pagination {...data} onPage={selectPage} />}
        </div>
      )}
    </CaseSectionLayout>
  );
}
