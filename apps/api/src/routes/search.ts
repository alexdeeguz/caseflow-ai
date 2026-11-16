import {
  SearchMode,
  documentSearchPageSchema,
  documentSearchQuerySchema,
  searchIndexRequestSchema,
  searchIndexSummarySchema,
} from '@caseflow/schemas';
import type { WorkspaceStore } from '../database/index.js';
import { Operation } from '../database/operations.js';
import type { QueryEmbedder } from '../search/embeddings.js';
import type { RegisterProtectedRoute } from './protected-route.js';

export function registerSearchRoutes(
  route: RegisterProtectedRoute,
  store: WorkspaceStore,
  embedder: QueryEmbedder | null,
) {
  route({
    method: 'GET',
    url: '/search',
    query: documentSearchQuerySchema,
    output: documentSearchPageSchema,
    // Embed before opening the database transaction so no pooled connection waits on the provider.
    execute: async (identity, input) => {
      const embedding =
        input.mode === SearchMode.Hybrid && embedder
          ? await embedder.embed(String(input.q), identity.subject)
          : null;
      return store.execute(identity, Operation.SearchDocuments, { ...input, embedding });
    },
  });

  route({
    method: 'POST',
    url: '/cases/:caseId/documents/:documentId/search-index',
    body: searchIndexRequestSchema,
    query: searchIndexRequestSchema,
    output: searchIndexSummarySchema,
    operation: Operation.RequestSearchIndex,
  });
}
