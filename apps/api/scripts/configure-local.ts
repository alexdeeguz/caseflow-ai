import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { parseDatabaseUrl } from '../src/database/connection-config.js';
import { writePrivateFile } from './lib/private-file.js';

const operator = parseDatabaseUrl(process.env.OPERATOR_DATABASE_URL ?? '', 'OPERATOR_DATABASE_URL');

if (!['localhost', '127.0.0.1'].includes(operator.hostname)) {
  throw new Error('This setup command is local only.');
}

const pool = new Pool({ connectionString: operator.href, max: 1, connectionTimeoutMillis: 5000 });

try {
  const password = randomBytes(24).toString('hex');

  // Hex is generated locally, never supplied by a request. PostgreSQL ALTER ROLE
  // does not accept a parameter placeholder for its password clause.
  await pool.query(`alter role caseflow_runtime password '${password}'`);

  const runtime = new URL(operator.href);

  runtime.username = 'caseflow_runtime';
  runtime.password = password;

  let env = '';

  try {
    env = await readFile('.env', 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  env = env
    .split('\n')
    .filter((line) => !line.startsWith('DATABASE_URL='))
    .join('\n');

  await writePrivateFile('.env', env.trimEnd() + `\nDATABASE_URL=${runtime.href}\n`);
  console.log('Local runtime password configured in apps/api/.env. Restart the API.');
} finally {
  await pool.end();
}
