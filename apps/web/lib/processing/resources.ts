import { isFactExtractionActive } from '../fact-extraction/presentation';
import { queryOptions } from '@tanstack/react-query';
import { processingSummarySchema, type DocumentListItem } from '@caseflow/schemas';
import type { AuthRequest } from '../../hooks/use-authentication';
import { ApiError } from '../api';
import { resourceOptions } from '../resources';
import { documentListResource } from '../documents/resources';
import { isProcessingActive } from './presentation';

export const processingRefreshInterval = 5000;

export function processingResource(caseId: string, documentId: string) {
  return {
    path: `/cases/${caseId}/documents/${documentId}/processing`,
    schema: processingSummarySchema,
  };
}

export function accessRejected(error: unknown): error is ApiError {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

export function processingPollInterval(
  data: { items: DocumentListItem[] } | undefined,
  error: Error | null,
): number | false {
  if (
    accessRejected(error) ||
    !data?.items.some(
      (item) => isProcessingActive(item.processing) || isFactExtractionActive(item.factExtraction),
    )
  ) {
    return false;
  }
  return processingRefreshInterval;
}

export function documentLibraryOptions(
  request: AuthRequest,
  resource: ReturnType<typeof documentListResource>,
) {
  return queryOptions({
    ...resourceOptions(request, resource),
    networkMode: 'online',
    refetchOnReconnect: 'always',
    refetchIntervalInBackground: false,
    refetchInterval: (query) => processingPollInterval(query.state.data, query.state.error),
  });
}

export function documentLibraryState<T>({
  data,
  error,
}: {
  data: T | undefined;
  error: Error | null;
}) {
  const denied = accessRejected(error);
  return {
    data: denied ? null : (data ?? null),
    error: error?.message ?? null,
    denied,
    stale: !!data && !!error && !denied,
  };
}
