import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { createDatabase } from '../../src/database/index.js';

export async function createTestDatabase(beforeUpgrade?: (owner: Pool) => Promise<void>) {
  const operatorUrl = new URL(process.env.OPERATOR_DATABASE_URL ?? '');
  const runtimeUrl = new URL(process.env.DATABASE_URL ?? '');

  assert.ok(['localhost', '127.0.0.1'].includes(operatorUrl.hostname));
  assert.equal(runtimeUrl.username, 'caseflow_runtime');
  assert.equal(runtimeUrl.host, operatorUrl.host);

  const name = `caseflow_test_${randomUUID().replaceAll('-', '')}`;
  const operator = new Pool({ connectionString: operatorUrl.href, max: 1 });
  await operator.query(`create database "${name}"`);
  operatorUrl.pathname = `/${name}`;
  runtimeUrl.pathname = `/${name}`;

  const owner = new Pool({ connectionString: operatorUrl.href, max: 3 });
  const runtime = new Pool({ connectionString: runtimeUrl.href, max: 1 });
  const store = createDatabase(runtimeUrl.href);
  const seed = await readFile(new URL('../../../../supabase/seed.sql', import.meta.url), 'utf8');

  async function close() {
    await store.close();
    await runtime.end();
    await owner.end();
    await operator.query(`drop database "${name}" with (force)`);
    await operator.end();
  }

  try {
    const directory = new URL('../../../../supabase/migrations/', import.meta.url);
    const migrations = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();

    for (const [index, file] of migrations.entries()) {
      await owner.query(await readFile(new URL(file, directory), 'utf8'));
      if (index === 0) {
        await beforeUpgrade?.(owner);
      }
    }
    await owner.query(seed);
  } catch (error) {
    await close();
    throw error;
  }

  return { owner, runtime, store, seed, runtimeUrl: runtimeUrl.href, close };
}

export async function waitForPermissionLock(owner: Pool) {
  const deadline = Date.now() + 3000;

  while (Date.now() < deadline) {
    const waiting = await owner.query(
      "select 1 from pg_stat_activity where datname=current_database() and usename='caseflow_runtime' and wait_event='advisory'",
    );
    if (waiting.rowCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('Request did not reach the permission lock.');
}
