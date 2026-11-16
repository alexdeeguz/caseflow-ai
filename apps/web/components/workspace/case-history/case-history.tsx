'use client';

import { useEffect, useId } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FactCategory,
  factCategoryLabels,
  type CaseTimeline,
  type CaseReviewedSummary,
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
import { Pagination } from '../../ui/pagination';
import { StatusMessage } from '../../ui/status-message';
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

  if (denied) {
    return <StatusMessage tone="error">{error}</StatusMessage>;
  }

  return (
    <section className={styles.panel} aria-labelledby={`${id}-title`}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Approved information</p>
          <h2 id={`${id}-title`}>{title}</h2>
          <p className={styles.description}>
            {timeline
              ? 'Dates documented in approved facts, oldest first. Partial dates retain their original precision.'
              : 'Approved facts organized by category, with the original evidence alongside each statement.'}
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={!online || query.isFetching || navigating}
          onClick={() => void Promise.all([query.refetch(), refreshCase()])}
        >
          {query.isFetching && data ? 'Refreshing…' : 'Refresh'}
        </Button>
      </header>
      {!timeline && (
        <div className={styles.categories} role="group" aria-label="Summary category">
          {Object.values(FactCategory).map((category) => (
            <button
              key={category}
              type="button"
              aria-pressed={location.summaryCategory === category}
              onClick={() =>
                void navigate({ ...location, summaryCategory: category, summaryPage: 1 })
              }
            >
              <span>{factCategoryLabels[category]}</span>
              <strong>{summary?.counts[category] ?? '—'}</strong>
            </button>
          ))}
        </div>
      )}
      {summary && (
        <p className={styles.description}>
          {Object.values(summary.counts).reduce((total, count) => total + count, 0)} approved facts
          from {summary.sourceDocumentCount}{' '}
          {summary.sourceDocumentCount === 1 ? 'document' : 'documents'}.
        </p>
      )}
      {data && (stale || !verified || caseError) && (
        <StatusMessage>
          {!online ? 'You’re offline.' : (error ?? caseError ?? 'Verifying current access.')}{' '}
          Showing the last verified information. Refresh to confirm current approvals; downloads are
          paused.
        </StatusMessage>
      )}
      {download.error && <StatusMessage tone="error">{download.error}</StatusMessage>}
      {!data ? (
        <div className={styles.empty} role={error ? 'alert' : 'status'}>
          {error ??
            (!online
              ? 'Reconnect to load approved information.'
              : `Loading ${title.toLowerCase()}…`)}
        </div>
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
            <ol
              className={timeline ? styles.timeline : styles.facts}
              aria-label={
                timeline ? 'Approved dates' : factCategoryLabels[location.summaryCategory]
              }
            >
              {data.items.map((fact) => (
                <li key={fact.id}>
                  <ApprovedFactCard
                    fact={fact}
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
                </li>
              ))}
            </ol>
          )}
          {(data.total > data.pageSize || page > 1) && <Pagination {...data} onPage={selectPage} />}
        </div>
      )}
    </section>
  );
}
