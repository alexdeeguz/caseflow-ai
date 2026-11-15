import { QueryClient, queryOptions } from '@tanstack/react-query';
import type { AuthRequest } from '../hooks/use-authentication';
import type { Parser } from './api';

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
  return async <T>(path: string, schema: Parser<T>, options: RequestInit = {}) => {
    const result = await request(path, schema, options);
    const method = (options.method ?? 'GET').toUpperCase();

    if (method !== 'GET' && method !== 'HEAD') {
      await client.invalidateQueries();
    }

    return result;
  };
}
