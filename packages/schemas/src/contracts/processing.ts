import { z } from 'zod';
import {
  DispatchStatus,
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

export const processingDispatchClaimSchema = z.strictObject({
  dispatchId: idSchema,
  jobId: idSchema,
  leaseToken: idSchema,
  leaseExpiresAt: z.iso.datetime(),
  attemptCount: z.number().int().positive(),
});
