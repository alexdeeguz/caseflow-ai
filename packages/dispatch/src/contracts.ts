import { z } from 'zod';
import { idSchema } from '@caseflow/schemas';

export const processingDispatchClaimSchema = z.strictObject({
  dispatchId: idSchema,
  jobId: idSchema,
  leaseToken: idSchema,
  leaseExpiresAt: z.iso.datetime(),
  attemptCount: z.number().int().positive(),
});

export type ProcessingDispatchClaim = z.infer<typeof processingDispatchClaimSchema>;
