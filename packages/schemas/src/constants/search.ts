export const SearchMode = {
  Hybrid: 'hybrid',
  Keyword: 'keyword',
} as const;
export type SearchMode = (typeof SearchMode)[keyof typeof SearchMode];

export const SearchMatch = {
  Keyword: 'keyword',
  Semantic: 'semantic',
  Both: 'both',
} as const;
export type SearchMatch = (typeof SearchMatch)[keyof typeof SearchMatch];

export const SearchIndexStatus = {
  Queued: 'queued',
  Indexing: 'indexing',
  Ready: 'ready',
  /** Keyword-searchable; embeddings could not be completed. */
  Partial: 'partial',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;
export type SearchIndexStatus = (typeof SearchIndexStatus)[keyof typeof SearchIndexStatus];

export const SearchIndexFailure = {
  SourceUnavailable: 'source_unavailable',
  LimitExceeded: 'limit_exceeded',
  ProviderUnavailable: 'provider_unavailable',
  BudgetExceeded: 'budget_exceeded',
  AttemptsExhausted: 'attempts_exhausted',
  InternalError: 'internal_error',
} as const;
export type SearchIndexFailure = (typeof SearchIndexFailure)[keyof typeof SearchIndexFailure];

export const SearchLimits = {
  QueryMinLength: 2,
  QueryMaxLength: 200,
  PageSizeMax: 50,
  /** Ranked results are capped; pagination covers at most this many. */
  MaxResults: 100,
  MaxChunksPerDocument: 500,
  SnippetMaxLength: 600,
  MaxHighlights: 20,
  EmbeddingDimensions: 1536,
} as const;

export const SearchEmbeddingModel = 'text-embedding-3-small';
