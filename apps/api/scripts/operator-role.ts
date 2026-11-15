import { ErrorCode, idSchema, roleSchema } from '@caseflow/schemas';
import { Pool } from 'pg';
import { parseDatabaseUrl } from '../src/database/connection-config.js';

const operatorErrorCodes: ReadonlySet<string> = new Set([
  ErrorCode.NotFound,
  ErrorCode.AccountDisabled,
  ErrorCode.LastSuperAdmin,
]);

const [id, role] = process.argv.slice(2);

idSchema.parse(id);

roleSchema.parse(role);

if (!process.env.OPERATOR_DATABASE_URL) {
  throw new Error(
    'Set OPERATOR_DATABASE_URL in .env.operator; never put it in the API environment.',
  );
}

const pool = new Pool({
  connectionString: parseDatabaseUrl(process.env.OPERATOR_DATABASE_URL, 'OPERATOR_DATABASE_URL')
    .href,
  max: 1,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});

try {
  await pool.query('select caseflow.operator_set_role($1,$2)', [id, role]);
  console.log(`Role set to ${role} for user ${id}.`);
} catch (error) {
  const message = (error as Error).message;

  console.error(
    operatorErrorCodes.has(message)
      ? message
      : 'Role update failed. Check the operator connection and user ID.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
