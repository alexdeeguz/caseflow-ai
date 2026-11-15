import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { dropTestDatabase } from './database-fixture.js';
import { createDatabase } from '../../src/database/index.js';
import { Operation } from '../../src/database/operations.js';
import { buildApp } from '../../src/app.js';
import { userSchema, auditActionSchema, auditPageSchema, type User } from '@caseflow/schemas';

// Always create a disposable database. Never reset the developer database.
test('PostgreSQL permission boundaries and API integration', async (t) => {
  const adminUrl = new URL(process.env.OPERATOR_DATABASE_URL ?? '');
  const runtimeUrl = new URL(process.env.DATABASE_URL ?? '');

  assert.ok(
    ['localhost', '127.0.0.1'].includes(adminUrl.hostname),
    'Integration tests require a local operator connection.',
  );
  assert.equal(runtimeUrl.username, 'caseflow_runtime');
  assert.equal(
    runtimeUrl.hostname,
    adminUrl.hostname,
    'Test connections must use the same local host.',
  );
  assert.equal(runtimeUrl.port, adminUrl.port, 'Test connections must use the same local port.');

  const name = `caseflow_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: adminUrl.href, max: 2 });

  await admin.query(`create database "${name}"`);
  adminUrl.pathname = '/' + name;
  runtimeUrl.pathname = '/' + name;

  const owner = new Pool({ connectionString: adminUrl.href, max: 3 });
  const store = createDatabase(runtimeUrl.href);
  const raw = new Pool({ connectionString: runtimeUrl.href, max: 1 });
  const tenant = '20000000-0000-4000-8000-000000000001';

  const identity = (subject: string) => ({ tenantId: tenant, subject, name: subject });

  const execute = (
    subject: string,
    op: Parameters<typeof store.execute>[1],
    input: Record<string, unknown> = {},
  ) => store.execute(identity(subject), op, input);

  const provision = async (subject: string) =>
    userSchema.parse(await execute(subject, Operation.GetProfile));

  async function waitForPermissionLock() {
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

    throw new Error('The concurrent request did not reach the permission lock.');
  }

  let superUser: User;
  let staff: User;
  let other: User;
  let manager: User;
  const caseId = '10000000-0000-4000-8000-000000000001';

  const denied = (
    subject: string,
    op: Parameters<typeof store.execute>[1],
    input: Record<string, unknown> = {},
    code = 'FORBIDDEN',
  ) => assert.rejects(execute(subject, op, input), (e: { code?: string }) => e.code === code);

  try {
    const directory = new URL('../../../../supabase/migrations/', import.meta.url);

    for (const file of (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort()) {
      await owner.query(await readFile(new URL(file, directory), 'utf8'));
    }

    await owner.query(
      await readFile(new URL('../../../../supabase/seed.sql', import.meta.url), 'utf8'),
    );
    await t.test('provisioning is concurrent, idempotent, and preserves profile', async () => {
      const users = await Promise.all(Array.from({ length: 5 }, () => provision('staff')));

      assert.equal(new Set(users.map((u) => u.id)).size, 1);
      staff = users[0]!;
      superUser = await provision('super');
      other = await provision('other');
      manager = await provision('manager');
      await owner.query('select caseflow.operator_set_role($1,$2)', [superUser.id, 'super_admin']);
      await execute('staff', Operation.UpdateProfile, { displayName: 'Updated name' });
      assert.equal((await provision('staff')).displayName, 'Updated name');
      assert.equal((await provision('staff')).role, 'staff');
    });
    await t.test(
      'runtime is restricted and context cannot leak through pooled connections',
      async () => {
        const role = (
          await raw.query(
            'select rolsuper,rolbypassrls,rolcreaterole from pg_roles where rolname=current_user',
          )
        ).rows[0];

        assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolcreaterole: false });
        assert.equal((await raw.query('select * from caseflow.users')).rowCount, 0);
        await assert.rejects(
          raw.query("update caseflow.users set role='super_admin'"),
          /permission denied/,
        );
        await assert.rejects(raw.query('delete from caseflow.audit_events'), /permission denied/);
        await assert.rejects(
          raw.query('select caseflow.operator_set_role($1,$2)', [staff.id, 'super_admin']),
          /permission denied/,
        );
        await assert.rejects(raw.query("select caseflow.provision('intruder')"), /UNAUTHENTICATED/);

        for (let i = 0; i < 8; i++) {
          assert.equal((await provision('super')).role, 'super_admin');
          await denied('staff', Operation.ListUsers);
        }

        assert.equal((await raw.query('select * from caseflow.cases')).rowCount, 0);
      },
    );
    await t.test(
      'Staff sees only assigned cases; assignment operations are idempotent',
      async () => {
        await denied('staff', Operation.GetCase, { id: caseId }, 'NOT_FOUND');
        await execute('super', Operation.AssignCase, { id: caseId, userId: staff.id });
        await execute('super', Operation.AssignCase, { id: caseId, userId: staff.id });
        assert.equal(
          (await owner.query('select * from caseflow.assignments where user_id=$1', [staff.id]))
            .rowCount,
          1,
        );
        assert.ok(await execute('staff', Operation.GetCase, { id: caseId }));
        await denied('other', Operation.GetCase, { id: caseId }, 'NOT_FOUND');
        await denied('staff', Operation.AssignCase, { id: caseId, userId: other.id });
        await execute('super', Operation.UnassignCase, { id: caseId, userId: staff.id });
        await denied('staff', Operation.GetCase, { id: caseId }, 'NOT_FOUND');
        await execute('super', Operation.AssignCase, { id: caseId, userId: staff.id });
      },
    );
    await t.test('role transitions preserve assignments and restrict peer management', async () => {
      await execute('super', Operation.UpdateRole, { id: manager.id, role: 'admin' });
      await execute('super', Operation.UpdateRole, { id: staff.id, role: 'admin' });
      await denied('manager', Operation.UpdateAccess, { id: staff.id, active: false });
      await denied('manager', Operation.UpdateRole, { id: other.id, role: 'admin' });
      await denied('manager', Operation.UpdateAccess, { id: superUser.id, active: false });
      await denied('super', Operation.UpdateRole, { id: superUser.id, role: 'staff' });
      await execute('super', Operation.UpdateRole, { id: staff.id, role: 'staff' });
      assert.ok(await execute('staff', Operation.GetCase, { id: caseId }));
      await denied(
        'staff',
        Operation.GetCase,
        { id: '10000000-0000-4000-8000-000000000002' },
        'NOT_FOUND',
      );
      await execute('manager', Operation.UpdateAccess, { id: staff.id, active: false });
      await denied('staff', Operation.GetProfile, {}, 'ACCOUNT_DISABLED');
      await denied(
        'staff',
        Operation.UpdateProfile,
        { displayName: 'blocked' },
        'ACCOUNT_DISABLED',
      );
      await execute('manager', Operation.UpdateAccess, { id: staff.id, active: true });
      assert.ok(await execute('staff', Operation.GetCase, { id: caseId }));
    });
    await t.test('audit failure rolls back the mutation', async () => {
      await owner.query(
        "create function caseflow.reject_audit() returns trigger language plpgsql as $$ begin raise exception 'test rollback'; end $$; create trigger reject_audit before insert on caseflow.audit_events for each row execute function caseflow.reject_audit()",
      );
      await assert.rejects(
        execute('super', Operation.UpdateAccess, { id: other.id, active: false }),
      );
      assert.equal(
        (await owner.query('select active from caseflow.users where id=$1', [other.id])).rows[0]
          .active,
        true,
      );
      await owner.query(
        'drop trigger reject_audit on caseflow.audit_events; drop function caseflow.reject_audit()',
      );
    });
    await t.test(
      'demotion and disabling win against permission writes waiting on the same lock',
      async () => {
        const blocker = await owner.connect();

        try {
          await blocker.query('begin');
          await blocker.query('select pg_advisory_xact_lock(734921,1)');

          const pending = execute('manager', Operation.UpdateAccess, {
            id: other.id,
            active: false,
          });

          await waitForPermissionLock();
          await blocker.query('select caseflow.operator_set_role($1,$2)', [manager.id, 'staff']);
          await blocker.query('commit');
          await assert.rejects(pending, (e: { code?: string }) => e.code === 'FORBIDDEN');
          await owner.query('select caseflow.operator_set_role($1,$2)', [manager.id, 'admin']);
          await blocker.query('begin');
          await blocker.query('select pg_advisory_xact_lock(734921,1)');

          const disabling = execute('manager', Operation.UpdateAccess, {
            id: other.id,
            active: false,
          });

          await waitForPermissionLock();
          await blocker.query('update caseflow.users set active=false where id=$1', [manager.id]);
          await blocker.query('commit');
          await assert.rejects(disabling, (e: { code?: string }) => e.code === 'ACCOUNT_DISABLED');
          await owner.query('update caseflow.users set active=true where id=$1', [manager.id]);
        } finally {
          await blocker.query('rollback');
          blocker.release();
        }
      },
    );
    await t.test('identity is tenant scoped and does not reset elevated roles', async () => {
      const sameSubject = await store.execute(
        { ...identity('staff'), tenantId: '30000000-0000-4000-8000-000000000001' },
        Operation.GetProfile,
        {},
      );

      assert.notEqual(userSchema.parse(sameSubject).id, staff.id);
      assert.equal((await provision('super')).role, 'super_admin');

      const privileges = (
        await owner.query(
          "select has_schema_privilege('anon','caseflow','USAGE') as anon,has_schema_privilege('authenticated','caseflow','USAGE') as authenticated,has_schema_privilege('service_role','caseflow','USAGE') as service",
        )
      ).rows[0];

      assert.deepEqual(privileges, { anon: false, authenticated: false, service: false });
    });
    await t.test('database connection failures fail closed', async () => {
      const unavailable = new URL(runtimeUrl);

      unavailable.port = '1';

      const offline = createDatabase(unavailable.href);

      try {
        await assert.rejects(
          offline.execute(identity('super'), Operation.GetProfile, {}),
          (error: { code?: string }) => error.code === 'SERVICE_UNAVAILABLE',
        );
      } finally {
        await offline.close();
      }
    });
    await t.test('operator cannot remove the last active Super Admin', async () => {
      await assert.rejects(
        owner.query('select caseflow.operator_set_role($1,$2)', [superUser.id, 'staff']),
        /LAST_SUPER_ADMIN/,
      );
      await owner.query('select caseflow.operator_set_role($1,$2)', [other.id, 'super_admin']);
      await owner.query('select caseflow.operator_set_role($1,$2)', [other.id, 'staff']);
    });
    await t.test(
      'HTTP rejects forged fields, blocks direct calls, and validates CORS',
      async () => {
        const app = await buildApp(
          {
            clientId: tenant,
            webClientId: tenant,
            webOrigin: 'http://localhost:3000',
            databaseUrl: runtimeUrl.href,
          },
          async (token) => identity(token),
          false,
          { execute: store.execute, close: async () => {} },
        );

        try {
          const call = (
            method: 'GET' | 'PATCH' | 'PUT',
            url: string,
            token: string,
            payload?: object,
          ) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

          assert.equal(
            (await call('PATCH', '/me', 'staff', { displayName: 'Test', role: 'super_admin' }))
              .statusCode,
            400,
          );
          assert.equal((await call('GET', '/admin/users', 'staff')).statusCode, 403);
          assert.equal(
            (await call('GET', '/cases/10000000-0000-4000-8000-000000000002', 'staff')).statusCode,
            404,
          );
          assert.equal(
            (await call('PATCH', `/admin/users/${staff.id}/role`, 'super', { role: 'super_admin' }))
              .statusCode,
            400,
          );
          assert.equal((await call('GET', '/admin/users?pageSize=10000', 'super')).statusCode, 400);
          assert.equal((await app.inject('/me')).statusCode, 401);

          const response = await call('GET', '/admin/audit', 'super');

          assert.equal(response.statusCode, 200);
          assert.ok(response.json().items.length);
          const auditPage = auditPageSchema.parse(response.json());

          for (const event of auditPage.items) {
            auditActionSchema.parse(event.action);
            assert.equal(event.createdAt, new Date(event.createdAt).toISOString());
          }
          assert.equal(response.headers['cache-control'], 'no-store');

          const cors = await app.inject({
            method: 'OPTIONS',
            url: '/me',
            headers: {
              origin: 'http://localhost:3000',
              'access-control-request-method': 'PATCH',
              'access-control-request-headers': 'authorization,content-type',
            },
          });

          assert.equal(cors.statusCode, 204);
          assert.ok(String(cors.headers['access-control-allow-methods']).includes('PATCH'));
        } finally {
          await app.close();
        }
      },
    );
  } finally {
    await store.close();
    await raw.end();
    await owner.end();
    await dropTestDatabase(admin, name);
    await admin.end();
  }
});
