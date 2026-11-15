import { Pool, type PoolClient } from 'pg';
import { userSchema } from '@caseflow/schemas';
import type { Identity } from '../auth.js';
import { databaseError } from './errors.js';
import { Operation } from './operations.js';
import { executeOperation, userColumns } from './queries.js';

export interface WorkspaceStore {
  execute(
    identity: Identity,
    operation: Operation,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export function createDatabase(connectionString: string): WorkspaceStore {
  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 8000,
    idle_in_transaction_session_timeout: 10000,
  });

  // Never include connection credentials or query parameters in idle-client errors.
  pool.on('error', () => console.error('CaseFlow database connection unavailable.'));

  return {
    async execute(identity, operation, input) {
      let client: PoolClient | undefined;

      try {
        client = await pool.connect();
        await client.query('begin');
        await client.query(
          `select set_config('caseflow.tenant_id', $1, true),
                  set_config('caseflow.subject', $2, true)`,
          [identity.tenantId, identity.subject],
        );

        // Only /me provisions users; other endpoints require an existing active profile.
        const current = await client.query(
          `select ${userColumns}
           from caseflow.${operation === Operation.GetProfile ? 'provision($1)' : 'require_actor()'}`,
          operation === Operation.GetProfile ? [identity.name] : [],
        );
        const actor = userSchema.parse(current.rows[0]);
        const result = await executeOperation(client, actor, operation, input);

        await client.query('commit');

        return result;
      } catch (error) {
        if (client) {
          try {
            await client.query('rollback');
          } catch {
            client.release(true);
            client = undefined;
          }
        }

        throw databaseError(error);
      } finally {
        client?.release();
      }
    },

    close: () => pool.end(),
  };
}
