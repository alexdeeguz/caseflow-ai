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
  type Case,
} from '@caseflow/schemas';
import { buildApp } from '../../src/app.js';
import { Operation } from '../../src/database/operations.js';
import { createTestDatabase, waitForPermissionLock } from './database-fixture.js';

test('case editing, archiving, restoration and optimistic concurrency', async (t) => {
  const tenant = randomUUID();
  const legacyUser = randomUUID();
  const legacyId = randomUUID();
  const db = await createTestDatabase(async (owner) => {
    await owner.query(
      "insert into caseflow.users(id, tenant_id, subject, display_name) values ($1,$2,'legacy','Legacy')",
      [legacyUser, tenant],
    );
    await owner.query(
      "insert into caseflow.cases(id,title,client_name,status,summary,created_by,created_at) values ($1,'Preserved','Fictional Client','closed','Keep this',$2,'2026-01-01')",
      [legacyId, legacyUser],
    );
    await owner.query('insert into caseflow.assignments values ($1,$2)', [legacyId, legacyUser]);
    await owner.query(
      "insert into caseflow.audit_events(actor_id,target_id,action) values ($1,$2,'case.created')",
      [legacyUser, legacyId],
    );
  }, 'create_cases.sql');
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
  const call = (
    method: 'GET' | 'PATCH' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    token?: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload,
    });
  const create = async (status: CaseStatus = CaseStatus.Intake) =>
    caseSchema.parse(
      (
        await call('POST', '/cases', 'admin', {
          title: 'Mutation fixture',
          clientName: 'Fictional Client',
          incidentDate: '2024-02-29',
          status,
          summary: 'Original summary',
        })
      ).json(),
    );
  const detail = async (id: string, token = 'admin') =>
    caseDetailSchema.parse((await call('GET', `/cases/${id}`, token)).json());
  const auditCount = async (id: string) =>
    (
      await db.owner.query(
        'select count(*)::int as count from caseflow.audit_events where target_id=$1',
        [id],
      )
    ).rows[0].count;
  const mutate = (
    record: Case,
    action: 'edit' | 'archive' | 'restore',
    subject = 'admin',
    patch = {},
  ) =>
    call(
      action === 'edit' ? 'PATCH' : 'POST',
      `/cases/${record.id}${action === 'edit' ? '' : `/${action}`}`,
      subject,
      {
        expectedVersion: record.version,
        ...(action === 'edit' ? { title: 'Edited title', ...patch } : {}),
      },
    );

  try {
    const admin = userSchema.parse(await execute('admin', Operation.GetProfile));
    const superAdmin = userSchema.parse(await execute('super', Operation.GetProfile));
    const staff = userSchema.parse(await execute('staff', Operation.GetProfile));
    const other = userSchema.parse(await execute('other', Operation.GetProfile));
    await db.owner.query('select caseflow.operator_set_role($1,$2)', [admin.id, Role.Admin]);
    await db.owner.query('select caseflow.operator_set_role($1,$2)', [
      superAdmin.id,
      Role.SuperAdmin,
    ]);

    await t.test(
      'migration preserves existing data, assignments and history; seeds remain repeatable',
      async () => {
        const record = (await detail(legacyId, 'legacy')).case;
        assert.equal(record.version, 1);
        assert.equal(record.updatedAt, record.createdAt);
        assert.equal(record.archivedAt, null);
        assert.equal(record.archivedBy, null);
        assert.equal(record.summary, 'Keep this');
        assert.equal(record.status, CaseStatus.Closed);
        assert.equal(record.createdBy, legacyUser);
        assert.equal(await auditCount(legacyId), 1);
        const before = (await db.owner.query('select * from caseflow.cases order by id')).rows;
        await db.owner.query(db.seed);
        await db.owner.query(db.seed);
        assert.deepEqual(
          (await db.owner.query('select * from caseflow.cases order by id')).rows,
          before,
        );
      },
    );

    await t.test(
      'partial updates preserve omitted fields and immutable metadata, and clear optional values',
      async () => {
        const original = await create();
        const response = await mutate(original, 'edit', 'super', { title: '  Changed  ' });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.headers['cache-control'], 'no-store');
        const changed = caseSchema.parse(response.json());
        assert.equal(changed.title, 'Changed');
        assert.equal(changed.version, 2);
        for (const field of [
          'id',
          'caseNumber',
          'createdAt',
          'createdBy',
          'summary',
          'clientName',
          'incidentDate',
          'status',
        ] as const) {
          assert.equal(changed[field], original[field]);
        }
        assert.ok(changed.updatedAt >= original.updatedAt);
        const cleared = await call('PATCH', `/cases/${changed.id}`, 'admin', {
          expectedVersion: 2,
          incidentDate: null,
          summary: '',
        });
        assert.equal(cleared.statusCode, 200);
        assert.equal(cleared.json().incidentDate, null);
        assert.equal(cleared.json().summary, '');
        assert.equal(cleared.json().title, 'Changed');
        const events = (
          await db.owner.query(
            "select * from caseflow.audit_events where target_id=$1 and action='case.updated' order by id",
            [original.id],
          )
        ).rows;
        assert.equal(events.length, 2);
        assert.equal(events[0].actor_id, superAdmin.id);
        assert.equal(events[0].before_value.title, original.title);
        assert.equal(events[0].after_value.title, 'Changed');
      },
    );

    await t.test(
      'all status transitions work; no-op edits and archive requests do not bump versions or audit',
      async () => {
        let record = await create();
        for (const status of [
          CaseStatus.Active,
          CaseStatus.Closed,
          CaseStatus.Intake,
          CaseStatus.Closed,
          CaseStatus.Active,
          CaseStatus.Intake,
        ]) {
          record = caseSchema.parse(
            (
              await call('PATCH', `/cases/${record.id}`, 'admin', {
                expectedVersion: record.version,
                status,
              })
            ).json(),
          );
          assert.equal(record.status, status);
        }
        const count = await auditCount(record.id);
        for (const input of [
          { expectedVersion: record.version },
          { expectedVersion: record.version, title: ` ${record.title} ` },
        ]) {
          const response = await call('PATCH', `/cases/${record.id}`, 'admin', input);
          assert.equal(response.statusCode, 200);
          assert.deepEqual(response.json(), record);
        }
        assert.deepEqual((await mutate(record, 'restore')).json(), record);
        assert.equal(await auditCount(record.id), count);
      },
    );

    await t.test(
      'validation rejects forged fields, invalid dates/statuses and field limits',
      async () => {
        const record = await create();
        const invalid = [
          {},
          { expectedVersion: 0 },
          { expectedVersion: 1.5 },
          { expectedVersion: '1' },
          ...[
            { title: '' },
            { title: ' ' },
            { clientName: '' },
            { title: 'x'.repeat(201) },
            { clientName: 'x'.repeat(101) },
            { summary: 'x'.repeat(2001) },
            { summary: null },
            { incidentDate: '2025-02-29' },
            { incidentDate: '0000-01-01' },
            { status: null },
            { status: 'archived' },
            { clientName: null },
            ...[
              'id',
              'caseNumber',
              'createdAt',
              'createdBy',
              'version',
              'updatedAt',
              'archivedAt',
              'archivedBy',
              'role',
              'assignments',
            ].map((field) => ({ [field]: 'forged' })),
          ].map((patch) => ({ expectedVersion: 1, ...patch })),
        ];
        for (const input of invalid) {
          assert.equal(
            (await call('PATCH', `/cases/${record.id}`, 'admin', input)).statusCode,
            400,
            JSON.stringify(input),
          );
        }
        for (const action of ['archive', 'restore']) {
          for (const input of [
            {},
            { expectedVersion: 1, title: 'forged' },
            { expectedVersion: -1 },
          ]) {
            assert.equal(
              (await call('POST', `/cases/${record.id}/${action}`, 'admin', input)).statusCode,
              400,
            );
          }
        }
        assert.deepEqual((await detail(record.id)).case, record);
        assert.equal(await auditCount(record.id), 1);
        const boundary = await mutate(record, 'edit', 'admin', {
          title: 'x'.repeat(200),
          clientName: 'x'.repeat(100),
          summary: 'x'.repeat(2000),
          incidentDate: '9999-12-31',
        });
        assert.equal(boundary.statusCode, 200, boundary.body);
      },
    );

    await t.test('direct requests enforce role and account status for every mutation', async () => {
      const record = await create();
      for (const action of ['edit', 'archive', 'restore'] as const) {
        const url = `/cases/${record.id}${action === 'edit' ? '' : `/${action}`}`;
        assert.equal(
          (await call(action === 'edit' ? 'PATCH' : 'POST', url, undefined, { expectedVersion: 1 }))
            .statusCode,
          401,
        );
        assert.equal((await mutate(record, action, 'staff')).statusCode, 403);
        await db.owner.query('update caseflow.users set active=false where id=$1', [admin.id]);
        const denied = await mutate(record, action);
        assert.equal(denied.statusCode, 403);
        assert.equal(denied.json().code, 'ACCOUNT_DISABLED');
        await db.owner.query('update caseflow.users set active=true where id=$1', [admin.id]);
      }
      assert.equal(
        (await call('PATCH', `/cases/${randomUUID()}`, 'admin', { expectedVersion: 1 })).statusCode,
        404,
      );
    });

    await t.test(
      'archive/restore preserve every status and assignments, and archived details reject edits',
      async () => {
        for (const status of Object.values(CaseStatus)) {
          const record = await create(status);
          await execute('admin', Operation.AssignCase, { id: record.id, userId: staff.id });
          const response = await mutate(record, 'archive', 'super');
          assert.equal(response.statusCode, 200, response.body);
          const archived = caseSchema.parse(response.json());
          assert.ok(archived.archivedAt);
          assert.equal(archived.archivedBy, superAdmin.id);
          assert.equal(archived.status, status);
          assert.equal((await detail(record.id, 'staff')).case.id, record.id);
          assert.equal((await call('GET', `/cases/${record.id}`, 'other')).statusCode, 404);
          const count = await auditCount(record.id);
          assert.deepEqual((await mutate(archived, 'archive')).json(), archived);
          assert.equal(await auditCount(record.id), count);
          const rejected = await mutate(archived, 'edit');
          assert.equal(rejected.statusCode, 409);
          assert.equal(rejected.json().code, 'CASE_ARCHIVED');
          await execute('admin', Operation.AssignCase, { id: record.id, userId: other.id });
          assert.equal((await detail(record.id, 'other')).case.id, record.id);
          await execute('admin', Operation.UnassignCase, { id: record.id, userId: other.id });
          assert.equal((await call('GET', `/cases/${record.id}`, 'other')).statusCode, 404);
          const restored = caseSchema.parse((await mutate(archived, 'restore')).json());
          assert.equal(restored.status, status);
          assert.equal(restored.archivedAt, null);
          assert.equal(restored.archivedBy, null);
          assert.equal(restored.version, 3);
          assert.deepEqual(
            (await detail(record.id)).assignedUsers.map((user) => user.id),
            [staff.id],
          );
        }
      },
    );

    await t.test(
      'archive filters combine with search, status and pagination without exposing inaccessible totals',
      async () => {
        const records = await Promise.all([
          create(CaseStatus.Active),
          create(CaseStatus.Active),
          create(CaseStatus.Closed),
        ]);
        for (const record of records.slice(0, 2)) {
          await mutate(record, 'archive');
          await execute('admin', Operation.AssignCase, { id: record.id, userId: staff.id });
        }
        const list = async (subject: string, query: string) =>
          casePageSchema.parse((await call('GET', `/cases?${query}`, subject)).json());
        const current = await list('staff', '');
        assert.ok(current.items.every((record) => record.archivedAt === null));
        const archived = await list(
          'staff',
          'archive=archived&status=active&search=MUTATION&pageSize=1',
        );
        assert.equal(archived.total, 2);
        assert.equal(archived.items.length, 1);
        assert.notEqual(
          archived.items[0]!.id,
          (await list('staff', 'archive=archived&status=active&search=mutation&pageSize=1&page=2'))
            .items[0]!.id,
        );
        assert.equal((await list('other', 'archive=all')).total, 0);
        assert.equal(
          (await list('staff', `archive=all&search=${records[0]!.caseNumber.toLowerCase()}`)).total,
          1,
        );
        assert.equal((await list('staff', `search=${records[0]!.caseNumber}`)).total, 0);
        assert.equal((await call('GET', '/cases?archive=deleted', 'admin')).statusCode, 400);
      },
    );

    await t.test('concurrent edits and edit-versus-archive accept one version only', async () => {
      for (const action of ['edit', 'archive'] as const) {
        const record = await create();
        const responses = await Promise.all([
          mutate(record, 'edit', 'admin', { summary: 'First draft' }),
          mutate(record, action, 'super', { summary: 'Second draft' }),
        ]);
        assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
        assert.equal(
          responses.find((response) => response.statusCode === 409)!.json().code,
          'CASE_CONFLICT',
        );
        assert.equal((await detail(record.id)).case.version, 2);
        assert.equal(await auditCount(record.id), 2);
      }
    });

    await t.test(
      'stale archive and restore requests fail even when the requested state already matches',
      async () => {
        const record = await create();
        const archived = caseSchema.parse((await mutate(record, 'archive')).json());
        for (const action of ['archive', 'restore'] as const) {
          const stale = await mutate(record, action);
          assert.equal(stale.statusCode, 409);
          assert.equal(stale.json().code, 'CASE_CONFLICT');
        }
        await mutate(archived, 'restore');
        assert.equal((await mutate(archived, 'restore')).statusCode, 409);
      },
    );

    await t.test('audit insert failure rolls back edits, archive and restore', async () => {
      for (const action of ['edit', 'archive', 'restore'] as const) {
        let record = await create();
        if (action === 'restore') {
          record = caseSchema.parse((await mutate(record, 'archive')).json());
        }
        const count = await auditCount(record.id);
        await db.owner.query(
          "create function caseflow.reject_mutation_audit() returns trigger language plpgsql as $$ begin raise exception 'rollback'; end $$; create trigger reject_mutation_audit before insert on caseflow.audit_events for each row execute function caseflow.reject_mutation_audit()",
        );
        try {
          assert.equal((await mutate(record, action)).statusCode, 503);
          assert.deepEqual((await detail(record.id)).case, record);
          assert.equal(await auditCount(record.id), count);
        } finally {
          await db.owner.query(
            'drop trigger reject_mutation_audit on caseflow.audit_events; drop function caseflow.reject_mutation_audit()',
          );
        }
      }
    });

    await t.test(
      'all mutations recheck demotion and disabling after the permission lock',
      async () => {
        const connection = await db.owner.connect();
        try {
          for (const action of ['edit', 'archive', 'restore'] as const) {
            for (const mode of ['demote', 'disable']) {
              let record = await create();
              if (action === 'restore') {
                record = caseSchema.parse((await mutate(record, 'archive')).json());
              }
              await connection.query('begin');
              await connection.query('select pg_advisory_xact_lock(734921,1)');
              const pending = Promise.resolve(mutate(record, action));
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
              const denied = await pending;
              assert.equal(denied.statusCode, 403);
              assert.equal(
                denied.json().code,
                mode === 'demote' ? 'FORBIDDEN' : 'ACCOUNT_DISABLED',
              );
              await db.owner.query('update caseflow.users set role=$1, active=true where id=$2', [
                Role.Admin,
                admin.id,
              ]);
              assert.deepEqual((await detail(record.id)).case, record);
            }
          }
        } finally {
          await connection.query('rollback');
          connection.release();
        }
      },
    );

    await t.test(
      'restricted runtime cannot bypass functions; functions validate identity and patch fields',
      async () => {
        const record = await create();
        await assert.rejects(
          db.runtime.query('update caseflow.cases set archived_at=now(), archived_by=$1', [
            admin.id,
          ]),
          /permission denied/,
        );
        for (const sql of [
          "select caseflow.update_case($1,1,'{}')",
          'select caseflow.set_case_archived($1,1,true)',
        ]) {
          await assert.rejects(db.runtime.query(sql, [record.id]), /UNAUTHENTICATED/);
          await db.runtime.query('begin');
          try {
            await db.runtime.query(
              "select set_config('caseflow.tenant_id',$1,true),set_config('caseflow.subject','staff',true)",
              [tenant],
            );
            await assert.rejects(db.runtime.query(sql, [record.id]), /FORBIDDEN/);
          } finally {
            await db.runtime.query('rollback');
          }
        }
        for (const patch of [
          { title: null },
          { status: [] },
          { incidentDate: '2025-02-29' },
          { version: 99 },
          { createdBy: staff.id },
        ]) {
          await assert.rejects(
            execute('admin', Operation.UpdateCase, { id: record.id, expectedVersion: 1, ...patch }),
            (error: { code?: string }) => error.code === 'INVALID_INPUT',
          );
        }
        for (const signature of [
          'caseflow.update_case(uuid,integer,jsonb)',
          'caseflow.set_case_archived(uuid,integer,boolean)',
        ]) {
          const privileges = (
            await db.owner.query(
              "select has_function_privilege('anon',$1,'execute') as anon,has_function_privilege('authenticated',$1,'execute') as authenticated,has_function_privilege('caseflow_runtime',$1,'execute') as runtime",
              [signature],
            )
          ).rows[0];
          assert.deepEqual(privileges, { anon: false, authenticated: false, runtime: true });
        }
      },
    );
  } finally {
    await app.close();
    await db.close();
  }
});
