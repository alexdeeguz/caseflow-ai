'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CaseArchiveFilter,
  DocumentFilter,
  SearchLimits,
  SearchMode,
  caseArchiveLabels,
  type DocumentSearchResult,
  type Role,
} from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import type { WorkspaceNavigate } from '../../../hooks/use-workspace-navigation';
import type { WorkspaceLocation } from '../../../lib/workspace-location';
import { CaseSection, WorkspaceTab } from '../../../lib/constants/navigation';
import { resourceOptions } from '../../../lib/resources';
import { documentLibraryState } from '../../../lib/processing/resources';
import {
  documentSearchResource,
  isSearchable,
  searchCaseOptionsResource,
} from '../../../lib/search/resources';
import { Callout } from '../../ui/panel';
import { LoadState } from '../../ui/load-state';
import { LoadingRegion } from '../../ui/loading-region';
import { Pagination } from '../../ui/pagination';
import { SegmentedControl } from '../../ui/segmented-control';
import { StatusMessage } from '../../ui/status-message';
import { StandaloneDocumentDrawer } from '../documents/standalone-document-drawer';
import { SearchField } from './search-field';
import { SearchMatchPanel } from './search-match-panel';
import { SearchResults } from './search-results';
import styles from './search.module.css';

export const searchModeOptions = [
  { value: SearchMode.Hybrid, label: 'Smart' },
  { value: SearchMode.Keyword, label: 'Exact words' },
];

/** Opens a search hit in its case's Documents tab, with the document drawer open. */
export function documentLocation(
  location: WorkspaceLocation,
  result: DocumentSearchResult,
): WorkspaceLocation {
  return {
    ...location,
    tab: WorkspaceTab.Cases,
    case: result.caseId,
    mode: undefined,
    section: CaseSection.Documents,
    documentFilter: DocumentFilter.Current,
    documentPage: 1,
    documentQuery: '',
    documentQueryPage: 1,
    document: result.documentId,
  };
}

export function SearchPage({
  request,
  location,
  navigate,
  pendingLocation,
  role,
}: {
  request: AuthRequest;
  role: Role;
  location: WorkspaceLocation;
  navigate: WorkspaceNavigate;
  pendingLocation: WorkspaceLocation | null;
}) {
  const searchable = isSearchable(location.query);
  const query = useQuery({
    ...resourceOptions(
      request,
      documentSearchResource({
        query: location.query,
        mode: location.searchMode,
        caseId: location.searchCase,
        archive: location.searchArchive,
        page: location.searchPage,
      }),
    ),
    enabled: searchable,
    networkMode: 'online',
  });
  const cases = useQuery(
    resourceOptions(request, searchCaseOptionsResource(CaseArchiveFilter.All)),
  );
  const { data, error } = documentLibraryState(query);
  const apply = (changes: Partial<WorkspaceLocation>) =>
    void navigate({ ...location, ...changes, searchPage: 1 }, { replace: true });
  // The drawer keeps showing its result while it animates closed.
  const [selected, setSelected] = useState<DocumentSearchResult | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const openResult = (result: DocumentSearchResult) => {
    setSelected(result);
    setAccessError(null);
    setDrawerOpen(true);
  };

  return (
    <section className={styles.page} aria-labelledby="search-heading">
      <header className={styles.hero}>
        <h1 id="search-heading">Search documents</h1>
        <p className={styles.lede}>
          Find text across the cases you can access. Smart search also finds passages with a similar
          meaning.
        </p>
        <SearchField
          size="lg"
          label="Search documents"
          value={location.query}
          placeholder="e.g. lumbar MRI, or “when did physical therapy start”"
          busy={pendingLocation !== null}
          onSearch={(query) => apply({ query })}
        />
        <div className={styles.controls}>
          <SegmentedControl
            label="Search mode"
            options={searchModeOptions}
            value={location.searchMode}
            pendingValue={pendingLocation?.searchMode}
            onChange={(searchMode) => apply({ searchMode })}
          />
          <label className={styles.select}>
            <span className="sr-only">Case</span>
            <select
              value={location.searchCase ?? ''}
              onChange={(event) => apply({ searchCase: event.target.value || null })}
            >
              <option value="">All accessible cases</option>
              {cases.data?.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.caseNumber} · {item.title}
                  {item.archivedAt ? ' (archived)' : ''}
                </option>
              ))}
            </select>
          </label>
          {!location.searchCase && (
            <label className={styles.select}>
              <span className="sr-only">Cases to include</span>
              <select
                value={location.searchArchive}
                onChange={(event) =>
                  apply({ searchArchive: event.target.value as CaseArchiveFilter })
                }
              >
                {Object.values(CaseArchiveFilter).map((value) => (
                  <option key={value} value={value}>
                    {caseArchiveLabels[value]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </header>

      {accessError && <StatusMessage tone="error">{accessError}</StatusMessage>}
      {!searchable ? (
        // A first search runs before the URL changes; show progress instead of the tips meanwhile.
        pendingLocation && isSearchable(pendingLocation.query) ? (
          <LoadState error={null} label="Searching documents…" />
        ) : (
          <SearchTips />
        )
      ) : !data ? (
        <LoadState error={error} label="Searching documents…" />
      ) : (
        <LoadingRegion loading={pendingLocation !== null} label="Searching…">
          <div className={styles.resultsArea}>
            <p className={styles.summary}>
              {data.total}
              {data.total >= SearchLimits.MaxResults ? '+' : ''}{' '}
              {data.total === 1 ? 'result' : 'results'} · ranked by relevance
            </p>
            {data.mode === SearchMode.Hybrid && !data.semanticAvailable && (
              <Callout>
                Showing exact-word matches only. Meaning-based search is unavailable right now.
              </Callout>
            )}
            {data.looseMatches && (
              <Callout>No exact matches. These passages may only be loosely related.</Callout>
            )}
            {data.indexingDocuments > 0 && (
              <Callout>
                {data.indexingDocuments}{' '}
                {data.indexingDocuments === 1 ? 'document is' : 'documents are'} still being
                prepared for search and may not appear yet.
              </Callout>
            )}
            {data.items.length ? (
              <SearchResults items={data.items} showCase onOpen={openResult} />
            ) : (
              <StatusMessage>
                No matches.{' '}
                {location.searchMode === SearchMode.Keyword
                  ? 'Try Smart search to find passages with a similar meaning.'
                  : location.searchArchive === CaseArchiveFilter.Current && !location.searchCase
                    ? 'Try different words, or include archived cases.'
                    : 'Try different words.'}
              </StatusMessage>
            )}
            {(data.total > data.pageSize || location.searchPage > 1) && (
              <Pagination
                {...data}
                onPage={(searchPage) => void navigate({ ...location, searchPage })}
              />
            )}
          </div>
        </LoadingRegion>
      )}
      {selected && (
        <StandaloneDocumentDrawer
          key={selected.documentId}
          caseId={selected.caseId}
          documentId={selected.documentId}
          filename={selected.filename}
          archived={selected.caseArchived}
          role={role}
          request={request}
          open={drawerOpen}
          lead={
            <SearchMatchPanel
              result={selected}
              onOpenInCase={() => void navigate(documentLocation(location, selected))}
            />
          }
          onClose={() => setDrawerOpen(false)}
          onExited={() => setSelected(null)}
          onAccessRejected={(message) => {
            setAccessError(message);
            setDrawerOpen(false);
            void query.refetch();
          }}
        />
      )}
    </section>
  );
}

function SearchTips() {
  return (
    <div className={styles.tips}>
      <h2>Ways to search</h2>
      <ul>
        <li>
          <strong>Describe what you need.</strong> “Treatment after the accident” finds therapy
          notes even when they use different words.
        </li>
        <li>
          <strong>Use exact words</strong> for names, claim numbers, or codes. Put phrases in
          quotes, and use a minus sign to exclude a word:{' '}
          <code>&quot;disc bulge&quot; -cervical</code>.
        </li>
        <li>
          <strong>Results come from extracted document text,</strong> including scanned pages. Only
          cases you can access are searched.
        </li>
      </ul>
    </div>
  );
}
