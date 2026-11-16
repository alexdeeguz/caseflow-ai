import { z } from 'zod';
import { SearchIndexStatus, SearchLimits } from '../constants/search.js';

/** Latest search indexing state for a document, shown alongside processing status. */
export const searchIndexSummarySchema = z
  .strictObject({
    status: z.enum(SearchIndexStatus),
    chunkCount: z.number().int().min(0).max(SearchLimits.MaxChunksPerDocument),
    embeddedCount: z.number().int().min(0).max(SearchLimits.MaxChunksPerDocument),
  })
  .refine((value) => value.embeddedCount <= value.chunkCount, {
    message: 'Embedded chunks cannot exceed saved chunks.',
  });

export type SearchIndexSummary = z.infer<typeof searchIndexSummarySchema>;

/** The re-index request has no fields; the document comes from the path. */
export const searchIndexRequestSchema = z.strictObject({});
