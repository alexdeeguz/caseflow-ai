import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  CaseStatus,
  Role,
  caseSchema,
  casePageSchema,
  caseDetailSchema,
  userSchema,
} from '@caseflow/schemas';
import { buildApp } from '../../src/app.js';
import { Operation } from '../../src/database/operations.js';
import { createTestDatabase, waitForPermissionLock } from './database-fixture.js';

test('case creation, browsing, and database authorization', async (t) => {
  const legacyUser = randomUUID();
  const legacyCase = '10000000-0000-4000-8000-000000000001';
  const tenant = randomUUID();
  const db = await createTestDatabase(async (owner) => {
    await owner.query(
      `insert into caseflow.users(id, tenant_id, subject, display_name) values ($1, $2, 'legacy', 'Edited legacy name')`,
      [legacyUser, tenant],
    );
    await owner.query(
      `insert into caseflow.cases(id, title, summary) values ($1, 'Preserved title', 'Preserved summary')`,
      [legacyCase],
    );
    await owner.query('insert into caseflow.assignments values ($1, $2)', [legacyCase, legacyUser]);
    await owner.query(
      `insert into caseflow.audit_events(actor_id, target_id, action) values ($1, $2, 'case.assignment_changed')`,
      [legacyUser, legacyCase],
    );
  });
  const identity = (subject: string) => ({ subject, tenantId: tenant, name: subject });
  const execute = (subject: string, operation: Operation, input: Record<string, unknown> = {}) =>
    db.store.execute(identity(subject), operation, input);
  const app = await buildApp(
    {
      clientId: tenant,
      webClientId: tenant,
      webOrigin: 'http://localhost:3000',
      databaseUrl: db.runtimeUrl,
    },
    async (token) => identity(token),
    false,
    { execute: db.store.execute, close: async () => {} },
  );
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, token?: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload,
    });
  const payload = { title: 'Demo collision', clientName: 'Fictional Client' };

  try {
    const admin = userSchema.parse(await execute('admin', Operation.GetProfile));
    const superAdmin = userSchema.parse(await execute('super', Operation.GetProfile));
    const staff = userSchema.parse(await execute('staff', Operation.GetProfile));
    await execute('other', Operation.GetProfile);
    await db.owner.query('select caseflow.operator_set_role($1, $2)', [
      superAdmin.id,
      Role.SuperAdmin,
    ]);
    await db.owner.query('select caseflow.operator_set_role($1, $2)', [admin.id, Role.Admin]);

    await t.test(
      'upgrade preserves cases, assignments, profiles, and audit; seed is repeatable',
      async () => {
        const before = (await db.owner.query('select * from caseflow.cases order by id')).rows;
        await db.owner.query(db.seed);
        assert.deepEqual(
          (await db.owner.query('select * from caseflow.cases order by id')).rows,
          before,
        );
        const record = caseDetailSchema.parse(
          await execute('legacy', Operation.GetCase, { id: legacyCase }),
        ).case;
        assert.equal(record.title, 'Preserved title');
        assert.equal(record.summary, 'Preserved summary');
        assert.equal(record.clientName, 'Jordan Ellis');
        assert.equal(record.incidentDate, '2026-08-12');
        assert.equal(record.createdBy, null);
        assert.equal(
          userSchema.parse(await execute('legacy', Operation.GetProfile)).displayName,
          'Edited legacy name',
        );
        assert.equal(
          (
            await db.owner.query('select 1 from caseflow.audit_events where actor_id=$1', [
              legacyUser,
            ])
          ).rowCount,
          1,
        );
      },
    );

    await t.test(
      'Admin and Super Admin create cases with server-owned metadata and no assignments',
      async () => {
        for (const [subject, creator] of [
          ['admin', admin.id],
          ['super', superAdmin.id],
        ]) {
          const response = await call('POST', '/cases', subject, {
            ...payload,
            title: '  Demo collision  ',
            clientName: ' Fictional Client ',
            incidentDate: '2024-02-29',
          });
          assert.equal(response.statusCode, 201, response.body);
          assert.equal(response.headers['cache-control'], 'no-store');
          const created = caseSchema.parse(response.json());
          assert.equal(created.title, payload.title);
          assert.equal(created.clientName, payload.clientName);
          assert.equal(created.status, CaseStatus.Intake);
          assert.equal(created.summary, '');
          assert.equal(created.incidentDate, '2024-02-29');
          assert.equal(created.createdBy, creator);
          const detail = caseDetailSchema.parse(
            (await call('GET', `/cases/${created.id}`, subject)).json(),
          );
          assert.deepEqual(detail.case, created);
          assert.deepEqual(detail.assignedUsers, []);
          const event = (
            await db.owner.query(
              "select * from caseflow.audit_events where target_id=$1 and action='case.created'",
              [created.id],
            )
          ).rows[0];
          assert.equal(event.actor_id, creator);
          assert.equal(event.after_value.caseNumber, created.caseNumber);
        }
      },
    );

    await t.test('validation rejects invalid and forged inputs without creating rows', async () => {
      const before = (await db.owner.query('select count(*) from caseflow.cases')).rows[0].count;
      const invalid = [
        {},
        { ...payload, title: ' ' },
        { ...payload, clientName: ' ' },
        { ...payload, title: 'x'.repeat(201) },
        { ...payload, clientName: 'x'.repeat(101) },
        { ...payload, summary: 'x'.repeat(2001) },
        { ...payload, summary: null },
        { ...payload, incidentDate: '2025-02-29' },
        { ...payload, incidentDate: '2026-04-31' },
        { ...payload, incidentDate: '0000-01-01' },
        { ...payload, incidentDate: 'infinity' },
        { ...payload, status: 'administrator' },
        { ...payload, status: null },
        ...['id', 'caseNumber', 'createdAt', 'createdBy', 'assignments', 'role'].map((key) => ({
          ...payload,
          [key]: 'forged',
        })),
      ];
      for (const input of invalid) {
        assert.equal(
          (await call('POST', '/cases', 'admin', input)).statusCode,
          400,
          JSON.stringify(input),
        );
      }
      assert.equal(
        (await db.owner.query('select count(*) from caseflow.cases')).rows[0].count,
        before,
      );
      const boundary = await call('POST', '/cases', 'admin', {
        title: 'x'.repeat(200),
        clientName: 'x'.repeat(100),
        summary: 'x'.repeat(2000),
        status: CaseStatus.Closed,
      });
      assert.equal(boundary.statusCode, 201);
      assert.equal(caseSchema.parse(boundary.json()).incidentDate, null);
    });

    await t.test('direct unauthorized and disabled requests are rejected', async () => {
      assert.equal((await call('POST', '/cases', undefined, payload)).statusCode, 401);
      assert.equal((await call('POST', '/cases', 'new-user', payload)).statusCode, 401);
      assert.equal((await call('POST', '/cases', 'staff', payload)).statusCode, 403);
      await db.owner.query('update caseflow.users set active=false where id=$1', [admin.id]);
      const denied = await call('POST', '/cases', 'admin', payload);
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().code, 'ACCOUNT_DISABLED');
      await db.owner.query('update caseflow.users set active=true where id=$1', [admin.id]);
    });

    await t.test('search, filtering, pagination, and totals follow case access', async () => {
      const records = [];
      for (const status of [CaseStatus.Intake, CaseStatus.Active, CaseStatus.Closed]) {
        records.push(
          caseSchema.parse(
            (
              await call('POST', '/cases', 'admin', {
                title: `Search fixture ${status}`,
                clientName: `Client 100%_${status}`,
                status,
              })
            ).json(),
          ),
        );
      }
      await execute('admin', Operation.AssignCase, { id: records[1]!.id, userId: staff.id });
      const list = async (subject: string, query: string) =>
        casePageSchema.parse((await call('GET', `/cases?${query}`, subject)).json());
      assert.equal((await list('staff', 'search=SEARCH%20FIXTURE')).total, 1);
      assert.equal((await list('other', 'search=fixture')).total, 0);
      assert.equal((await list('staff', 'status=closed')).total, 0);
      assert.equal(
        (await list('admin', 'search=fixture&status=active')).items[0]!.id,
        records[1]!.id,
      );
      assert.equal((await list('admin', 'search=100%25_')).total, 3);
      assert.equal(
        (await list('admin', `search=${records[1]!.caseNumber.toLowerCase()}`)).total,
        1,
      );
      const first = await list('admin', 'search=fixture&pageSize=1');
      const second = await list('admin', 'search=fixture&pageSize=1&page=2');
      assert.equal(first.total, 3);
      assert.equal(first.items[0]!.id, records[2]!.id);
      assert.notEqual(first.items[0]!.id, second.items[0]!.id);
      assert.equal((await list('admin', 'search=fixture&page=4&pageSize=1')).items.length, 0);
      assert.equal((await call('GET', `/cases/${records[0]!.id}`, 'staff')).statusCode, 404);
      assert.equal((await call('GET', '/cases?status=invalid', 'admin')).statusCode, 400);
      assert.equal((await call('GET', '/cases?page=0', 'admin')).statusCode, 400);
      assert.equal((await call('GET', '/cases?unexpected=true', 'admin')).statusCode, 400);
    });

    await t.test('concurrent creation produces unique case numbers', async () => {
      const responses = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          call('POST', '/cases', i % 2 ? 'admin' : 'super', payload),
        ),
      );
      const cases = responses.map((response) => {
        assert.equal(response.statusCode, 201, response.body);
        return caseSchema.parse(response.json());
      });
      assert.equal(new Set(cases.map((record) => record.caseNumber)).size, cases.length);
      assert.equal(new Set(cases.map((record) => record.id)).size, cases.length);
    });

    await t.test('audit failure rolls back case creation', async () => {
      const count = (await db.owner.query('select count(*) from caseflow.cases')).rows[0].count;
      await db.owner.query(
        "create function caseflow.reject_case_audit() returns trigger language plpgsql as $$ begin raise exception 'rollback'; end $$; create trigger reject_case_audit before insert on caseflow.audit_events for each row execute function caseflow.reject_case_audit()",
      );
      try {
        assert.equal((await call('POST', '/cases', 'admin', payload)).statusCode, 503);
        assert.equal(
          (await db.owner.query('select count(*) from caseflow.cases')).rows[0].count,
          count,
        );
      } finally {
        await db.owner.query(
          'drop trigger reject_case_audit on caseflow.audit_events; drop function caseflow.reject_case_audit()',
        );
      }
    });

    await t.test(
      'creation rechecks role and disabled access after waiting on the permission lock',
      async () => {
        const connection = await db.owner.connect();
        try {
          for (const mode of ['demote', 'disable']) {
            await connection.query('begin');
            await connection.query('select pg_advisory_xact_lock(734921,1)');
            const pending = call('POST', '/cases', 'admin', payload);
            // Start injection before inspecting its database transaction.
            const response = Promise.resolve(pending);
            await waitForPermissionLock(db.owner);
            if (mode === 'demote') {
              await connection.query('select caseflow.operator_set_role($1,$2)', [
                admin.id,
                Role.Staff,
              ]);
            } else {
              await connection.query('update caseflow.users set active=false where id=$1', [
                admin.id,
              ]);
            }
            await connection.query('commit');
            const denied = await response;
            assert.equal(denied.statusCode, 403);
            assert.equal(denied.json().code, mode === 'demote' ? 'FORBIDDEN' : 'ACCOUNT_DISABLED');
            await db.owner.query('update caseflow.users set role=$1, active=true where id=$2', [
              Role.Admin,
              admin.id,
            ]);
          }
        } finally {
          await connection.query('rollback');
          connection.release();
        }
      },
    );

    await t.test('runtime cannot bypass the creation function or assign itself cases', async () => {
      await assert.rejects(
        db.runtime.query(
          `insert into caseflow.cases(title, client_name, summary) values ('Bypass', 'Client', '')`,
        ),
        /permission denied/,
      );
      await assert.rejects(
        db.runtime.query(`update caseflow.cases set title='Bypass'`),
        /permission denied/,
      );
      await assert.rejects(
        db.runtime.query(`select caseflow.create_case('Title', 'Client', null, 'intake', '')`),
        /UNAUTHENTICATED/,
      );
      await db.runtime.query('begin');
      try {
        await db.runtime.query(
          "select set_config('caseflow.tenant_id',$1,true), set_config('caseflow.subject','staff',true)",
          [tenant],
        );
        await assert.rejects(
          db.runtime.query(`select caseflow.create_case('Title', 'Client', null, 'intake', '')`),
          /FORBIDDEN/,
        );
      } finally {
        await db.runtime.query('rollback');
      }
      await assert.rejects(
        execute('admin', Operation.CreateCase, { title: '', clientName: 'Client' }),
        (error: { code?: string }) => error.code === 'INVALID_INPUT',
      );
      const privileges = (
        await db.owner.query(
          "select has_function_privilege('anon','caseflow.create_case(text,text,date,text,text)','execute') as anon, has_function_privilege('authenticated','caseflow.create_case(text,text,date,text,text)','execute') as authenticated",
        )
      ).rows[0];
      assert.deepEqual(privileges, { anon: false, authenticated: false });
    });

    await t.test('POST preflight allows bearer authentication and JSON', async () => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/cases',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      assert.equal(response.statusCode, 204);
      assert.ok(String(response.headers['access-control-allow-methods']).includes('POST'));
    });
  } finally {
    await app.close();
    await db.close();
  }
});
