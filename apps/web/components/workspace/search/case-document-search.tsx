'use client';

import { useQuery } from '@tanstack/react-query';
import { CaseArchiveFilter, SearchLimits, SearchMode } from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import type { WorkspaceNavigate } from '../../../hooks/use-workspace-navigation';
import type { WorkspaceLocation } from '../../../lib/workspace-location';
import { resourceOptions } from '../../../lib/resources';
import { documentLibraryState } from '../../../lib/processing/resources';
import { documentSearchResource } from '../../../lib/search/resources';
import { Callout } from '../../ui/panel';
import { LoadState } from '../../ui/load-state';
import { Pagination } from '../../ui/pagination';
import { StatusMessage } from '../../ui/status-message';
import { SearchResults } from './search-results';
import styles from './search.module.css';

/** Search results limited to one case, shown in place of its document list. */
export function CaseDocumentSearch({
  request,
  caseId,
  location,
  navigate,
  onOpen,
}: {
  request: AuthRequest;
  caseId: string;
  location: WorkspaceLocation;
  navigate: WorkspaceNavigate;
  onOpen: (documentId: string) => void;
}) {
  const query = useQuery({
    ...resourceOptions(
      request,
      documentSearchResource({
        query: location.documentQuery,
        mode: SearchMode.Hybrid,
        caseId,
        archive: CaseArchiveFilter.All,
        page: location.documentQueryPage,
      }),
    ),
    networkMode: 'online',
  });
  const { data, error } = documentLibraryState(query);
  const clear = () => void navigate({ ...location, documentQuery: '', documentQueryPage: 1 });

  if (!data) {
    return <LoadState error={error} label="Searching this case…" />;
  }

  return (
    <div className={styles.resultsArea}>
      <p className={styles.summary}>
        {data.total}
        {data.total >= SearchLimits.MaxResults ? '+' : ''} {data.total === 1 ? 'match' : 'matches'}{' '}
        in this case’s documents ·{' '}
        <button type="button" className={styles.inlineAction} onClick={clear}>
          Back to all documents
        </button>
      </p>
      {!data.semanticAvailable && (
        <Callout>Showing exact-word matches only. Meaning-based search is unavailable now.</Callout>
      )}
      {data.indexingDocuments > 0 && (
        <Callout>
          {data.indexingDocuments} {data.indexingDocuments === 1 ? 'document is' : 'documents are'}{' '}
          still being prepared for search.
        </Callout>
      )}
      {data.items.length ? (
        <SearchResults
          items={data.items}
          showCase={false}
          onOpen={(result) => onOpen(result.documentId)}
        />
      ) : (
        <StatusMessage>No matches in this case. Try different or fewer words.</StatusMessage>
      )}
      {(data.total > data.pageSize || location.documentQueryPage > 1) && (
        <Pagination
          {...data}
          onPage={(documentQueryPage) => void navigate({ ...location, documentQueryPage })}
        />
      )}
    </div>
  );
}
