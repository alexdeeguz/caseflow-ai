import { factValueShape, validateFactValues } from './fact-values.js';
import { z } from 'zod';
import {
  FactCategory,
  FactExtractionFailure,
  FactExtractionLimits,
  FactExtractionStatus,
} from '../constants/fact-extraction.js';
import { idSchema } from './common.js';
import { pageQuerySchema, pageSchema } from './pagination.js';

export const factExtractionMessageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: idSchema,
});

export const factExtractionRequestSchema = z.strictObject({ expectedJobId: idSchema.nullable() });
export const factExtractionQuerySchema = z.strictObject({});
export const factQuerySchema = pageQuerySchema.extend({
  category: z.enum(FactCategory).optional(),
});

export const factExtractionJobSchema = z
  .strictObject({
    id: idSchema,
    documentId: idSchema,
    processingResultId: idSchema,
    status: z.enum(['queued', 'extracting', 'completed', 'failed', 'cancelled']),
    failureCode: z.enum(FactExtractionFailure).nullable(),
    chunkCount: z.number().int().min(0).max(FactExtractionLimits.MaxChunks),
    completedChunks: z.number().int().min(0).max(FactExtractionLimits.MaxChunks),
    factCount: z.number().int().min(0),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .refine(
    (job) =>
      job.completedChunks <= job.chunkCount &&
      (job.status === 'failed') === (job.failureCode !== null) &&
      ['completed', 'failed', 'cancelled'].includes(job.status) === (job.finishedAt !== null) &&
      (job.status !== 'completed' ||
        (job.chunkCount > 0 && job.completedChunks === job.chunkCount)),
    { message: 'Fact extraction lifecycle is inconsistent.' },
  );

export const factExtractionSummarySchema = z
  .strictObject({
    status: z.enum(FactExtractionStatus),
    job: factExtractionJobSchema.nullable(),
  })
  .refine(
    (summary) => summary.status === (summary.job?.status ?? FactExtractionStatus.NotExtracted),
    { message: 'Fact extraction summary is inconsistent.' },
  );

export type FactExtractionSummary = z.infer<typeof factExtractionSummarySchema>;

export const factEvidenceSchema = z
  .strictObject({
    id: idSchema,
    documentId: idSchema,
    processingResultId: idSchema,
    page: z.number().int().min(1).max(20),
    quote: z.string().min(1).max(4000),
    start: z.number().int().min(0),
    end: z.number().int().min(1),
  })
  .refine(
    (evidence) =>
      evidence.end > evidence.start && [...evidence.quote].length === evidence.end - evidence.start,
    { message: 'Evidence offsets use Unicode code points and must match the quotation.' },
  );

export const factSchema = z
  .strictObject({
    id: idSchema,
    extractionJobId: idSchema,
    ...factValueShape,
    reviewStatus: z.literal('unreviewed'),
    evidence: z.array(factEvidenceSchema).min(1).max(8),
  })
  .superRefine(validateFactValues);

export type ExtractedFact = z.infer<typeof factSchema>;
export const factPageSchema = pageSchema(factSchema);
