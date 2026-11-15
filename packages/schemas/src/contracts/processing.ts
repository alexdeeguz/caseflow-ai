import { z } from 'zod';
import {
  DispatchStatus,
  ExtractionMethod,
  ProcessingFailureCode,
  ProcessingLimits,
  ProcessingStage,
  ProcessingStatus,
} from '../constants/processing.js';
import { idSchema } from './common.js';

export const processingStatusSchema = z.enum(ProcessingStatus);
export const dispatchStatusSchema = z.enum(DispatchStatus);

export const processingJobSchema = z
  .strictObject({
    id: idSchema,
    documentId: idSchema,
    requestedBy: idSchema,
    status: z.enum([
      ProcessingStatus.Queued,
      ProcessingStatus.Processing,
      ProcessingStatus.Ready,
      ProcessingStatus.Failed,
      ProcessingStatus.Cancelled,
    ]),
    stage: z.enum(ProcessingStage).nullable(),
    attemptCount: z.number().int().min(0).max(ProcessingLimits.MaxAttempts),
    maxAttempts: z.literal(ProcessingLimits.MaxAttempts),
    failureCode: z.enum(ProcessingFailureCode).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .refine(
    (job) =>
      (job.status === ProcessingStatus.Processing) === (job.stage !== null) &&
      (job.status === ProcessingStatus.Failed) === (job.failureCode !== null) &&
      (
        [
          ProcessingStatus.Ready,
          ProcessingStatus.Failed,
          ProcessingStatus.Cancelled,
        ] as ProcessingStatus[]
      ).includes(job.status) ===
        (job.finishedAt !== null) &&
      Date.parse(job.updatedAt) >= Date.parse(job.createdAt) &&
      (job.finishedAt === null || Date.parse(job.finishedAt) >= Date.parse(job.createdAt)),
    { message: 'Processing job lifecycle metadata is inconsistent.' },
  );

export type ProcessingJob = z.infer<typeof processingJobSchema>;

// A null expected job starts processing; a failed/cancelled job ID requests a retry.
export const processingRequestSchema = z.strictObject({ expectedJobId: idSchema.nullable() });

// Resolve storage locations from the database, never from untrusted queue fields.
export const processingMessageSchema = z.strictObject({
  schemaVersion: z.literal(ProcessingLimits.MessageSchemaVersion),
  jobId: idSchema,
});

export type ProcessingMessage = z.infer<typeof processingMessageSchema>;

export const processingResultSummarySchema = z.strictObject({
  extractionMethod: z.enum(ExtractionMethod),
  pageCount: z.number().int().min(1).max(ProcessingLimits.MaxPdfPages),
  pipelineVersion: z.string().min(1).max(32),
});

export type ProcessingResultSummary = z.infer<typeof processingResultSummarySchema>;

export const processingSummarySchema = z
  .strictObject({
    status: processingStatusSchema,
    job: processingJobSchema.nullable(),
    result: processingResultSummarySchema.nullable(),
  })
  .refine(
    (summary) =>
      (summary.job === null
        ? summary.status === ProcessingStatus.NotProcessed
        : summary.status === summary.job.status) &&
      (summary.status === ProcessingStatus.Ready) === (summary.result !== null),
    { message: 'Processing summary is inconsistent with its job and result.' },
  );

export type ProcessingSummary = z.infer<typeof processingSummarySchema>;
export const processingQuerySchema = z.strictObject({});
