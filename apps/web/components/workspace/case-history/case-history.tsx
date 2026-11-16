'use client';

import { useEffect, useId } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import type {
  ApprovedCaseFact,
  CaseReviewedSummary,
  CaseTimeline as Timeline,
} from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import type { WorkspaceNavigate } from '../../../hooks/use-workspace-navigation';
import { useVerifiedConnection } from '../../../hooks/use-online';
import type { WorkspaceLocation } from '../../../lib/workspace-location';
import { CaseSection } from '../../../lib/constants/navigation';
import {
  caseSummaryResources,
  caseTimelineResource,
  isCaseHistoryResource,
} from '../../../lib/case-history/resources';
import { resourceOptions, type Resource } from '../../../lib/resources';
import { documentLibraryState } from '../../../lib/processing/resources';
import { Button } from '../../ui/button';
import { CaseSectionLayout } from '../case-section-layout';
import { Pagination } from '../../ui/pagination';
import { StatusMessage } from '../../ui/status-message';
import { LoadingIndicator } from '../../ui/spinner';
import { useReviewTotals } from '../documents/use-review-totals';
import { CaseSummary } from './case-summary';
import { CaseTimeline } from './case-timeline';
import type { SourceDownloads } from './fact-sources';
import { useSourceDownload } from './use-source-download';
import styles from './case-history.module.css';

type HistoryPage = Timeline | CaseReviewedSummary;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Timeline and Reviewed summary tabs: read-only views of a case's approved facts. */
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
  const page = timeline ? location.timelinePage : 1;
  const summaryResources = caseSummaryResources(caseId);
  const resources: Resource<HistoryPage>[] = timeline
    ? [caseTimelineResource(caseId, page)]
    : [summaryResources.dates, ...summaryResources.categories];
  const queries = useQueries({
    queries: resources.map((resource) => ({
      ...resourceOptions<HistoryPage>(request, resource),
      networkMode: 'online' as const,
      refetchOnReconnect: 'always' as const,
    })),
  });
  const client = useQueryClient();
  const review = useReviewTotals(request, caseId);
  const states = queries.map(documentLibraryState);
  const pages = states.map((state) => state.data);
  const ready = pages.every((data) => data !== null);
  const error = states.find((state) => state.error)?.error ?? null;
  const denied = states.some((state) => state.denied);
  const stale = states.some((state) => state.stale);
  const fetching = queries.some((query) => query.isFetching);
  const { online, verified } = useVerifiedConnection(
    Math.min(...queries.map((query) => query.dataUpdatedAt)),
  );
  const id = useId();
  const title = timeline ? 'Timeline' : 'Reviewed summary';
  const download = useSourceDownload({
    request,
    enabled: ready && !error && !caseError && verified && !fetching && !navigating,
    refresh: () =>
      client.invalidateQueries({
        predicate: ({ queryKey }) => isCaseHistoryResource(String(queryKey[0]), caseId),
      }),
    onAccessRejected,
  });
  const downloads: SourceDownloads = {
    busy: download.busy,
    disabled:
      !verified || !!error || !!caseError || fetching || navigating || download.busy !== null,
    onDownload: (fact: ApprovedCaseFact) =>
      void download.download({ caseId, id: fact.documentId, filename: fact.filename }),
  };

  useEffect(() => {
    if (denied && error) {
      onAccessRejected(error);
    }
  }, [denied, error, onAccessRejected]);

  if (denied) {
    return <StatusMessage tone="error">{error}</StatusMessage>;
  }

  const [first, ...categories] = pages;
  const counts = categories[0] && 'counts' in categories[0] ? categories[0] : null;
  const approved = counts
    ? Object.values(counts.counts).reduce((total, count) => total + count, 0)
    : 0;
  const timelineDocuments = first ? new Set(first.items.map((fact) => fact.documentId)).size : 0;
  const summary = !ready
    ? null
    : timeline
      ? first!.total
        ? `${plural(first!.total, 'approved date')} from ${plural(timelineDocuments, 'document')}${first!.total > first!.items.length ? ' on this page' : ''} · oldest first`
        : null
      : counts &&
        `${plural(approved, 'approved fact')} from ${plural(counts.sourceDocumentCount, 'document')}`;

  return (
    <CaseSectionLayout
      id={`${id}-title`}
      title={title}
      loading={navigating}
      summary={summary}
      actions={
        <Button
          variant="secondary"
          className={styles.refresh}
          disabled={!online || fetching || navigating}
          onClick={() =>
            void Promise.all([...queries.map((query) => query.refetch()), refreshCase()])
          }
        >
          {fetching && ready ? 'Refreshing…' : 'Refresh'}
        </Button>
      }
    >
      {ready && (stale || !verified || caseError) && (
        <StatusMessage>
          {!online ? 'You’re offline.' : (error ?? caseError ?? 'Verifying current access.')}{' '}
          Showing the last verified information. Refresh to confirm current approvals; downloads are
          paused.
        </StatusMessage>
      )}
      {download.error && <StatusMessage tone="error">{download.error}</StatusMessage>}
      {!ready ? (
        error || !online ? (
          <div className={styles.empty} role={error ? 'alert' : 'status'}>
            {error ?? 'Reconnect to load approved information.'}
          </div>
        ) : (
          <LoadingIndicator label={`Loading ${title.toLowerCase()}…`} size="lg" />
        )
      ) : (
        <div aria-busy={fetching || navigating}>
          {timeline ? (
            first!.items.length ? (
              <CaseTimeline
                items={first!.items}
                partial={first!.total > first!.items.length}
                downloads={downloads}
              />
            ) : (
              <EmptyHistory
                title={page > 1 ? 'No dates on this page' : 'No approved dates yet'}
                firstPage={page > 1 ? () => navigate({ ...location, timelinePage: 1 }) : undefined}
              />
            )
          ) : approved || first!.total ? (
            <CaseSummary
              dates={first!}
              findings={categories[0]!}
              treatments={categories[1]!}
              providers={categories[2]!}
              review={review}
              downloads={downloads}
              onReview={() => void navigate({ ...location, section: CaseSection.Documents })}
              onTimeline={() => void navigate({ ...location, section: CaseSection.Timeline })}
            />
          ) : (
            <EmptyHistory title="No approved facts yet" />
          )}
          {timeline && (first!.total > first!.pageSize || page > 1) && (
            <Pagination
              {...first!}
              onPage={(timelinePage) => void navigate({ ...location, timelinePage })}
            />
          )}
        </div>
      )}
    </CaseSectionLayout>
  );
}

function EmptyHistory({ title, firstPage }: { title: string; firstPage?: () => void }) {
  return (
    <div className={styles.empty}>
      <h3>{title}</h3>
      <p>
        {firstPage
          ? 'The available facts may have changed. Return to the first page.'
          : 'Only approved facts from available documents appear here. Review facts in Documents to include them.'}
      </p>
      {firstPage && (
        <Button variant="secondary" onClick={firstPage}>
          First page
        </Button>
      )}
    </div>
  );
}
