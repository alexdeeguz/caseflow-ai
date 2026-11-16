import { z } from 'zod';
import { FactCategory } from '../constants/fact-extraction.js';
import { idSchema } from './common.js';
import { factEvidenceSchema } from './fact-extraction.js';
import { factValueShape, validateFactValues } from './fact-values.js';
import { pageQuerySchema, pageSchema } from './pagination.js';

export const approvedCaseFactSchema = z
  .strictObject({
    ...factValueShape,
    id: idSchema,
    version: z.number().int().min(1).max(2147483647),
    documentId: idSchema,
    filename: z.string().min(1).max(255),
    evidence: z.array(factEvidenceSchema).min(1).max(8),
  })
  .superRefine(validateFactValues)
  .refine((fact) => fact.evidence.every((source) => source.documentId === fact.documentId), {
    message: 'Evidence must belong to the source document.',
  });

export const caseTimelineQuerySchema = pageQuerySchema;
export const caseTimelineSchema = pageSchema(
  approvedCaseFactSchema.refine((fact) => fact.category === FactCategory.Date, {
    message: 'Timeline entries must be date facts.',
  }),
);

export const caseReviewedSummaryQuerySchema = pageQuerySchema.extend({
  category: z.enum(FactCategory).default(FactCategory.Date),
});

export const caseFactCountsSchema = z.strictObject({
  date: z.number().int().nonnegative(),
  provider: z.number().int().nonnegative(),
  treatment: z.number().int().nonnegative(),
  finding: z.number().int().nonnegative(),
});

export const caseReviewedSummarySchema = pageSchema(approvedCaseFactSchema)
  .extend({
    category: z.enum(FactCategory),
    counts: caseFactCountsSchema,
    sourceDocumentCount: z.number().int().nonnegative(),
  })
  .refine(
    (summary) =>
      summary.total === summary.counts[summary.category] &&
      summary.items.every((fact) => fact.category === summary.category),
    { message: 'Summary items and counts must match the selected category.' },
  );

export type CaseTimeline = z.infer<typeof caseTimelineSchema>;
export type ApprovedCaseFact = z.infer<typeof approvedCaseFactSchema>;
export type CaseReviewedSummary = z.infer<typeof caseReviewedSummarySchema>;
