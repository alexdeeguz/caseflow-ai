import { QueryClient, queryOptions } from '@tanstack/react-query';
import type { AuthRequest } from '../hooks/use-authentication';
import { isCaseHistoryResource } from './case-history/resources';
import { ApiError, type Parser, type ApiRequestOptions } from './api';

export interface Resource<T> {
  path: string;
  schema: Parser<T>;
}

export function createResourceClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000,
        gcTime: 5 * 60 * 1000,
        retry: false,
        retryOnMount: false,
        refetchOnWindowFocus: 'always',
        networkMode: 'always',
      },
    },
  });
}

export function resourceOptions<T>(request: AuthRequest, resource: Resource<T>) {
  return queryOptions({
    queryKey: [resource.path],
    queryFn: ({ signal }) => request(resource.path, resource.schema, { signal }),
  });
}

export function preloadResource<T>(
  client: QueryClient,
  request: AuthRequest,
  resource: Resource<T>,
): Promise<void> {
  // Navigation always revalidates, even if the section has recently been visited.
  return client.prefetchQuery({ ...resourceOptions(request, resource), staleTime: 0 });
}

export function resourceState<T>({ data, error }: { data: T | undefined; error: Error | null }) {
  return {
    data: error ? null : (data ?? null),
    error: error?.message ?? null,
  };
}

export function withResourceInvalidation(client: QueryClient, request: AuthRequest): AuthRequest {
  return async <T>(path: string, schema: Parser<T>, options: ApiRequestOptions = {}) => {
    const method = (options.method ?? 'GET').toUpperCase();
    const mutation = method !== 'GET' && method !== 'HEAD';
    try {
      const result = await request(path, schema, options);
      if (mutation) {
        const documents = /^\/cases\/([^/]+)\/(documents|document-uploads)(?:\/|$)/.exec(path);
        if (documents) {
          const review =
            /^(\/cases\/[^/]+\/documents\/[^/]+\/facts)\/[^/]+(?:\/(approve|reject|reopen))?$/.exec(
              path,
            );
          if (review) {
            void client.invalidateQueries({
              predicate: ({ queryKey }) => {
                const key = String(queryKey[0]);
                // Review decisions change the per-document "to review" counts in the library too.
                return (
                  isCaseHistoryResource(key, documents[1]!) ||
                  key.startsWith(`/cases/${documents[1]}/documents?`) ||
                  key.startsWith(`${review[1]}?`) ||
                  key.startsWith(`${review[1]}/`) ||
                  key.startsWith('/admin/audit')
                );
              },
            });
            return result;
          }
          // Starting uploads and authorizing downloads do not change the library.
          const libraryChanged = /\/(complete|remove|restore|processing|fact-extraction)$/.test(
            path,
          );
          const processingPath = /^\/cases\/[^/]+\/documents\/[^/]+\/processing$/;
          const documentPath = path.replace(/\/(remove|restore|processing)$/, '/processing');
          void client.invalidateQueries({
            predicate: ({ queryKey }) => {
              const key = String(queryKey[0]);
              return (
                key.startsWith('/admin/audit') ||
                (/\/(remove|restore)$/.test(path) && isCaseHistoryResource(key, documents[1]!)) ||
                (libraryChanged && key.startsWith(`/cases/${documents[1]}/documents?`)) ||
                (libraryChanged &&
                  key.startsWith(
                    path.replace(/\/(remove|restore|processing|fact-extraction)$/, '/'),
                  ) &&
                  /\/(facts\?|fact-extraction)/.test(key)) ||
                (libraryChanged &&
                  processingPath.test(key) &&
                  (key === documentPath ||
                    (documents[2] === 'document-uploads' &&
                      key.startsWith(`/cases/${documents[1]}/documents/`))))
              );
            },
          });
        } else {
          await client.invalidateQueries();
        }
      }
      return result;
    } catch (error) {
      if (mutation && error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        await client.invalidateQueries();
      }
      throw error;
    }
  };
}
