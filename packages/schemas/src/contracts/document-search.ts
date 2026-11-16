import { z } from 'zod';
import { CaseArchiveFilter } from '../constants/case-archive.js';
import { SearchLimits, SearchMatch, SearchMode } from '../constants/search.js';
import { idSchema } from './common.js';
import { documentContentTypeSchema } from './documents.js';
import { pageQuerySchema } from './pagination.js';

/** SQS message for the search indexer; the job ID is resolved against PostgreSQL. */
export const searchIndexMessageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: idSchema,
});
export type SearchIndexMessage = z.infer<typeof searchIndexMessageSchema>;

export const documentSearchQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().min(SearchLimits.QueryMinLength).max(SearchLimits.QueryMaxLength),
  mode: z.enum(SearchMode).default(SearchMode.Hybrid),
  caseId: idSchema.optional(),
  archive: z.enum(CaseArchiveFilter).default(CaseArchiveFilter.Current),
  pageSize: z.coerce.number().int().min(1).max(SearchLimits.PageSizeMax).default(20),
});
export type DocumentSearchQuery = z.infer<typeof documentSearchQuerySchema>;

/** Highlights are character ranges into the snippet, so clients never render server markup. */
export const searchHighlightSchema = z
  .strictObject({
    start: z.number().int().min(0),
    end: z.number().int().min(1),
  })
  .refine((range) => range.end > range.start, { message: 'Empty highlight.' });

export const documentSearchResultSchema = z
  .strictObject({
    chunkId: idSchema,
    caseId: idSchema,
    caseNumber: z.string().regex(/^CF-\d{6,}$/),
    caseTitle: z.string().min(1).max(200),
    caseArchived: z.boolean(),
    documentId: idSchema,
    filename: z.string().min(1).max(255),
    contentType: documentContentTypeSchema,
    page: z.number().int().min(1).max(20),
    snippet: z.string().min(1).max(SearchLimits.SnippetMaxLength),
    highlights: z.array(searchHighlightSchema).max(SearchLimits.MaxHighlights),
    matchedBy: z.enum(SearchMatch),
  })
  .refine(
    (result) =>
      result.highlights.every(
        (range, index) =>
          range.end <= result.snippet.length &&
          (index === 0 || range.start >= result.highlights[index - 1]!.end),
      ),
    { message: 'Highlights must be ordered ranges within the snippet.' },
  );
export type DocumentSearchResult = z.infer<typeof documentSearchResultSchema>;

export const documentSearchPageSchema = z.strictObject({
  items: z.array(documentSearchResultSchema).max(SearchLimits.PageSizeMax),
  total: z.number().int().min(0).max(SearchLimits.MaxResults),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(SearchLimits.PageSizeMax),
  mode: z.enum(SearchMode),
  /** False when meaning-based matching was unavailable and results are keyword-only. */
  semanticAvailable: z.boolean(),
  /** Accessible documents in scope that are not yet fully searchable. */
  indexingDocuments: z.number().int().min(0),
});
export type DocumentSearchPage = z.infer<typeof documentSearchPageSchema>;
