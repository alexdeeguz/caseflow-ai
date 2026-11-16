import { z } from 'zod';
import { FactCategory } from '../constants/fact-extraction.js';
import { FactReviewAction, FactReviewLimits, FactReviewStatus } from '../constants/fact-review.js';
import { idSchema } from './common.js';
import { factEvidenceSchema } from './fact-extraction.js';
import { factValueShape, factValuesSchema, validateFactValues } from './fact-values.js';
import { pageQuerySchema, pageSchema } from './pagination.js';

const versionSchema = z.number().int().min(1).max(2147483647);

export const factReviewReasonSchema = z
  .string()
  .trim()
  .min(1, 'Enter a reason for this review.')
  .max(FactReviewLimits.ReasonLength, 'Keep the reason to 1,000 characters or fewer.');

export const factCorrectionSchema = z.strictObject({
  expectedVersion: versionSchema,
  values: factValuesSchema.superRefine((values, context) => {
    for (const key of ['value', 'qualifier', 'dateMeaning'] as const) {
      if (values[key] !== null && !values[key].trim()) {
        context.addIssue({ code: 'custom', path: [key], message: 'Enter a nonblank value.' });
      }
    }
  }),
  reason: factReviewReasonSchema,
});

export const factApprovalSchema = z.strictObject({ expectedVersion: versionSchema });

export const factReviewDecisionSchema = factApprovalSchema.extend({
  reason: factReviewReasonSchema,
});

export const reviewedFactQuerySchema = pageQuerySchema.extend({
  category: z.enum(FactCategory).optional(),
  reviewStatus: z.enum(FactReviewStatus).optional(),
});

export const reviewedFactSchema = z
  .strictObject({
    id: idSchema,
    extractionJobId: idSchema,
    ...factValueShape,
    original: factValuesSchema,
    evidence: z.array(factEvidenceSchema).min(1).max(8),
    reviewStatus: z.enum(FactReviewStatus),
    version: versionSchema,
    corrected: z.boolean(),
    reviewedBy: idSchema.nullable(),
    reviewedAt: z.iso.datetime().nullable(),
  })
  .superRefine(validateFactValues);

export const reviewCountsSchema = z.strictObject({
  unreviewed: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
});

export const reviewedFactPageSchema = pageSchema(reviewedFactSchema).extend({
  counts: reviewCountsSchema,
});

export const factReviewRevisionSchema = z.strictObject({
  version: versionSchema,
  action: z.enum(FactReviewAction),
  status: z.enum(FactReviewStatus),
  values: factValuesSchema,
  reason: factReviewReasonSchema.nullable(),
  actorId: idSchema,
  createdAt: z.iso.datetime(),
});

export const factReviewHistorySchema = pageSchema(factReviewRevisionSchema);

export type ReviewedFact = z.infer<typeof reviewedFactSchema>;

export type FactReviewRevision = z.infer<typeof factReviewRevisionSchema>;
