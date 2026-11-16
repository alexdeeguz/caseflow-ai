'use client';

import { useQuery } from '@tanstack/react-query';
import { DocumentFilter } from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import { documentListResource } from '../../../lib/documents/resources';
import { documentLibraryOptions } from '../../../lib/processing/resources';
import { reviewTotals, type ReviewTotals } from '../../../lib/documents/state';

/**
 * Facts awaiting review across the case's current documents. Shares the Documents tab's default
 * query (same cache key), so it costs nothing extra there. Totals are a lower bound when the case
 * has more than one page of documents; swap in a case-level count here once the API provides one.
 */
export function useReviewTotals(request: AuthRequest, caseId: string): ReviewTotals | null {
  const query = useQuery(
    documentLibraryOptions(
      request,
      documentListResource(caseId, { filter: DocumentFilter.Current, page: 1 }),
    ),
  );
  return query.data && !query.error ? reviewTotals(query.data) : null;
}
