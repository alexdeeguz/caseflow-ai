import { Pool } from 'pg';
import { z } from 'zod';
import { processingDispatchClaimSchema, type ProcessingDispatchClaim } from './contracts.js';

export interface DispatchStore {
  claim(limit: number): Promise<ProcessingDispatchClaim[]>;
  finish(claim: ProcessingDispatchClaim, messageId: string): Promise<boolean>;
  retry(claim: ProcessingDispatchClaim): Promise<boolean>;
  close(): Promise<void>;
}

const claimRowsSchema = z.array(processingDispatchClaimSchema);
const resultSchema = z.tuple([z.strictObject({ applied: z.boolean() })]);

export const DispatchTarget = {
  Processing: 'processing',
  FactExtraction: 'fact_extraction',
} as const;
export type DispatchTarget = (typeof DispatchTarget)[keyof typeof DispatchTarget];

const dispatchFunctions = {
  processing: {
    claim: 'claim_processing_dispatches',
    finish: 'finish_processing_dispatch',
    retry: 'retry_processing_dispatch',
  },
  fact_extraction: {
    claim: 'claim_fact_dispatches',
    finish: 'finish_fact_dispatch',
    retry: 'retry_fact_dispatch',
  },
} as const;

export function createDispatchStore(
  connectionString: string,
  onConnectionError: () => void,
  target: DispatchTarget = DispatchTarget.Processing,
): DispatchStore {
  const functions = dispatchFunctions[target];
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 8000,
    query_timeout: 10000,
    idle_in_transaction_session_timeout: 10000,
    application_name: 'caseflow-dispatcher',
  });

  pool.on('error', onConnectionError);

  return {
    async claim(limit) {
      // Each function call commits before the caller makes any SQS request.
      const result = await pool.query(
        `select dispatch_id as "dispatchId", job_id as "jobId", lease_token as "leaseToken",
          lease_expires_at as "leaseExpiresAt", attempt_count as "attemptCount"
         from caseflow.${functions.claim}($1)`,
        [limit],
      );

      return claimRowsSchema.parse(
        result.rows.map((row) => ({
          ...row,
          leaseExpiresAt: row.leaseExpiresAt.toISOString(),
        })),
      );
    },

    async finish(claim, messageId) {
      const result = await pool.query(`select caseflow.${functions.finish}($1,$2,$3) as applied`, [
        claim.dispatchId,
        claim.leaseToken,
        messageId,
      ]);

      return resultSchema.parse(result.rows)[0].applied;
    },

    async retry(claim) {
      const result = await pool.query(`select caseflow.${functions.retry}($1,$2) as applied`, [
        claim.dispatchId,
        claim.leaseToken,
      ]);

      return resultSchema.parse(result.rows)[0].applied;
    },

    close: () => pool.end(),
  };
}
