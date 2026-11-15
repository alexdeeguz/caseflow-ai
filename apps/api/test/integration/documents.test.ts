import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Role, userSchema } from '@caseflow/schemas';
import { Operation } from '../../src/database/operations.js';
import { createTestDatabase } from './database-fixture.js';

test('document foundation: migration, constraints and runtime isolation', async (t) => {
  let previousCases: unknown;
  let previousUsers: unknown;
  const db = await createTestDatabase(async (owner) => {
    const tenant = randomUUID();
    const user = randomUUID();
    const caseId = randomUUID();

    await owner.query(
      "insert into caseflow.users(id,tenant_id,subject,display_name) values ($1,$2,'legacy','Legacy')",
      [user, tenant],
    );
    await owner.query(
      "insert into caseflow.cases(id,title,client_name,created_by) values ($1,'Preserved case','Fictional Client',$2)",
      [caseId, user],
    );
    await owner.query('insert into caseflow.assignments values ($1,$2)', [caseId, user]);
    await owner.query(
      "insert into caseflow.audit_events(actor_id,target_id,action) values ($1,$2,'case.created')",
      [user, caseId],
    );
    previousCases = (await owner.query('select * from caseflow.cases')).rows;
    previousUsers = (await owner.query('select * from caseflow.users')).rows;
  }, 'edit_archive_cases.sql');
  const tenantId = randomUUID();
  const identity = (subject: string) => ({ tenantId, subject, name: subject });

  async function asRuntime(subject: string | undefined, query: string, parameters: unknown[] = []) {
    const client = await db.runtime.connect();

    try {
      await client.query('begin');
      if (subject) {
        await client.query(
          "select set_config('caseflow.tenant_id',$1,true),set_config('caseflow.subject',$2,true)",
          [tenantId, subject],
        );
      }

      return await client.query(query, parameters);
    } finally {
      await client.query('rollback');
      client.release();
    }
  }

  async function createDocument(caseId: string, uploader: string, status = 'pending_upload') {
    const uploaded = status !== 'pending_upload';
    const removed = status === 'removed';
    const result = await db.owner.query(
      `insert into caseflow.documents(case_id,uploaded_by,filename,content_type,size_bytes,storage_bucket,storage_environment,status,uploaded_at,object_version_id,removed_at,removed_by)
       values ($1,$2,'Fictional record.PDF','application/pdf',100,'caseflow-test-documents','dev',$3,
         case when $4 then now() end,case when $4 then 'test-version' end,case when $5 then now() end,case when $5 then $2::uuid end) returning *`,
      [caseId, uploader, status, uploaded, removed],
    );

    return result.rows[0];
  }

  try {
    const staff = userSchema.parse(
      await db.store.execute(identity('staff'), Operation.GetProfile, {}),
    );
    const other = userSchema.parse(
      await db.store.execute(identity('other'), Operation.GetProfile, {}),
    );
    const admin = userSchema.parse(
      await db.store.execute(identity('admin'), Operation.GetProfile, {}),
    );
    const superAdmin = userSchema.parse(
      await db.store.execute(identity('super'), Operation.GetProfile, {}),
    );

    await t.test(
      'additive migration and repeated seeds preserve cases, profiles, assignments and audit history',
      async () => {
        assert.deepEqual(
          (await db.owner.query("select * from caseflow.cases where title='Preserved case'")).rows,
          previousCases,
        );
        assert.deepEqual(
          (await db.owner.query("select * from caseflow.users where subject='legacy'")).rows,
          previousUsers,
        );
        assert.equal(
          (await db.owner.query('select count(*)::int n from caseflow.assignments')).rows[0].n,
          1,
        );
        assert.equal(
          (await db.owner.query('select count(*)::int n from caseflow.audit_events')).rows[0].n,
          1,
        );
        const before = (await db.owner.query('select * from caseflow.cases order by id')).rows;
        await db.owner.query(db.seed);
        await db.owner.query(db.seed);
        assert.deepEqual(
          (await db.owner.query('select * from caseflow.cases order by id')).rows,
          before,
        );
        assert.equal(
          (await db.owner.query('select count(*)::int n from caseflow.documents')).rows[0].n,
          0,
        );
      },
    );

    await db.owner.query('select caseflow.operator_set_role($1,$2)', [admin.id, Role.Admin]);
    await db.owner.query('select caseflow.operator_set_role($1,$2)', [
      superAdmin.id,
      Role.SuperAdmin,
    ]);
    const cases = (await db.owner.query('select id from caseflow.cases order by id')).rows;
    const caseId = cases[0].id as string;
    const hiddenCaseId = cases[1].id as string;
    await db.owner.query('insert into caseflow.assignments values ($1,$2)', [caseId, staff.id]);
    await db.owner.query('insert into caseflow.assignments values ($1,$2)', [caseId, other.id]);
    const pending = await createDocument(caseId, staff.id);
    const available = await createDocument(caseId, staff.id, 'available');
    const removed = await createDocument(caseId, staff.id, 'removed');
    const hidden = await createDocument(hiddenCaseId, staff.id, 'available');
    const session = (
      await db.owner.query(
        "insert into caseflow.document_upload_sessions(document_id,expires_at) values ($1,now()+interval '5 minutes') returning *",
        [pending.id],
      )
    ).rows[0];

    await t.test(
      'keys follow the environment/case/document/original structure and cannot be supplied',
      async () => {
        assert.equal(
          pending.object_key,
          `dev/cases/${caseId}/documents/${pending.id}/original/Fictional record.PDF`,
        );
        await assert.rejects(
          db.owner.query("update caseflow.documents set object_key='forged' where id=$1", [
            pending.id,
          ]),
          { code: '428C9' },
        );
      },
    );

    await t.test(
      'file, lifecycle, foreign key and session constraints reject invalid persisted metadata',
      async () => {
        for (const [column, value] of [
          ['size_bytes', 0],
          ['size_bytes', 26214401],
          ['filename', '../record.pdf'],
          ['filename', 'C:\\record.pdf'],
          ['filename', 'line\nrecord.pdf'],
          ['filename', 'record.png'],
          ['filename', 'a'.repeat(252) + '.pdf'],
          ['content_type', 'text/html'],
          ['storage_environment', '../prod'],
          ['storage_bucket', 'invalid/bucket'],
          ['status', 'available'],
          ['status', 'removed'],
          ['status', 'invalid'],
          ['object_version_id', 'test-version'],
          ['removed_by', staff.id],
          ['version', 0],
        ] as const) {
          await assert.rejects(
            db.owner.query(`update caseflow.documents set ${column}=$1 where id=$2`, [
              value,
              pending.id,
            ]),
            { code: '23514' },
            column,
          );
        }

        for (const value of [null, '', 'null']) {
          await assert.rejects(
            db.owner.query('update caseflow.documents set object_version_id=$1 where id=$2', [
              value,
              available.id,
            ]),
            { code: '23514' },
          );
        }

        await assert.rejects(
          db.owner.query('update caseflow.documents set case_id=$1 where id=$2', [
            randomUUID(),
            pending.id,
          ]),
          { code: '23503' },
        );
        await assert.rejects(
          db.owner.query('delete from caseflow.documents where id=$1', [pending.id]),
          { code: '23503' },
        );
        await assert.rejects(
          db.owner.query(
            "insert into caseflow.document_upload_sessions(document_id,expires_at) values ($1,now()+interval '5 minutes')",
            [pending.id],
          ),
          { code: '23505' },
        );
        await assert.rejects(
          db.owner.query(
            "insert into caseflow.document_upload_sessions(document_id,expires_at) values ($1,now()+interval '5 minutes')",
            [randomUUID()],
          ),
          { code: '23503' },
        );

        for (const [column, value] of [
          ['status', 'completed'],
          ['status', 'failed'],
          ['status', 'expired'],
          ['status', 'cancelled'],
          ['status', 'unknown'],
          ['failure_code', 'verification_failed'],
          ['finished_at', new Date()],
          ['expires_at', session.created_at],
          ['expires_at', new Date(session.created_at.getTime() + 300001)],
        ] as const) {
          await assert.rejects(
            db.owner.query(
              `update caseflow.document_upload_sessions set ${column}=$1 where id=$2`,
              [value, session.id],
            ),
            { code: '23514' },
            column,
          );
        }
      },
    );

    await t.test(
      'RLS restricts documents and sessions by current case access, role, lifecycle and uploader',
      async () => {
        const documentsFor = async (subject?: string) =>
          (await asRuntime(subject, 'select id from caseflow.documents')).rows
            .map((row) => row.id)
            .sort();
        assert.deepEqual(await documentsFor('staff'), [pending.id, available.id].sort());
        assert.deepEqual(await documentsFor('other'), [available.id]);
        for (const subject of ['admin', 'super']) {
          assert.deepEqual(
            await documentsFor(subject),
            [pending.id, available.id, removed.id, hidden.id].sort(),
          );
          assert.equal(
            (await asRuntime(subject, 'select * from caseflow.document_upload_sessions')).rowCount,
            1,
          );
        }
        assert.equal(
          (await asRuntime('staff', 'select * from caseflow.document_upload_sessions')).rowCount,
          1,
        );
        assert.equal(
          (await asRuntime('other', 'select * from caseflow.document_upload_sessions')).rowCount,
          0,
        );
        assert.deepEqual(await documentsFor(), []);
        assert.deepEqual(await documentsFor('unknown'), []);

        await db.owner.query(
          'update caseflow.cases set archived_at=now(),archived_by=$1 where id=$2',
          [admin.id, caseId],
        );
        assert.deepEqual(await documentsFor('staff'), [pending.id, available.id].sort());
        await db.owner.query('delete from caseflow.assignments where case_id=$1 and user_id=$2', [
          caseId,
          staff.id,
        ]);
        assert.deepEqual(await documentsFor('staff'), []);
        assert.equal(
          (await asRuntime('staff', 'select * from caseflow.document_upload_sessions')).rowCount,
          0,
        );

        await db.owner.query('select caseflow.operator_set_role($1,$2)', [admin.id, Role.Staff]);
        assert.deepEqual(await documentsFor('admin'), []);
        await db.owner.query('update caseflow.users set active=false where id=$1', [superAdmin.id]);
        assert.deepEqual(await documentsFor('super'), []);
        assert.equal(
          (await asRuntime('super', 'select * from caseflow.document_upload_sessions')).rowCount,
          0,
        );
      },
    );

    await t.test(
      'runtime cannot write documents/sessions; Supabase API roles receive no table access',
      async () => {
        for (const table of ['documents', 'document_upload_sessions']) {
          for (const query of [
            `insert into caseflow.${table} default values`,
            `update caseflow.${table} set id=id`,
            `delete from caseflow.${table}`,
            `truncate caseflow.${table}`,
          ]) {
            await assert.rejects(asRuntime('staff', query), { code: '42501' });
          }
          for (const role of ['anon', 'authenticated', 'service_role']) {
            const result = await db.owner.query(
              "select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') allowed",
              [role, `caseflow.${table}`],
            );
            assert.equal(result.rows[0].allowed, false);
          }
        }
      },
    );
  } finally {
    await db.close();
  }
});
