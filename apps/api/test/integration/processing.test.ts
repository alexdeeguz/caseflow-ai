import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Role, userSchema, caseSchema } from '@caseflow/schemas';
import { parseUploadRecord } from '../../src/database/documents.js';
import { Operation } from '../../src/database/operations.js';
import { createTestDatabase, waitForPermissionLock } from './database-fixture.js';

const checksum = createHash('sha256').update('fixture').digest('base64');

test('processing foundation: atomic uploads, permissions, retries and dispatch leases', async (t) => {
  const db = await createTestDatabase();
  await db.owner.query('grant caseflow_dispatcher to current_user with inherit false, set true');
  const tenantId = randomUUID();
  const runtime = new Pool({ connectionString: db.runtimeUrl, max: 4 });
  const execute = (subject: string, operation: Operation, input: Record<string, unknown> = {}) =>
    db.store.execute({ tenantId, subject, name: subject }, operation, input);

  async function asUser(subject: string, sql: string, values: unknown[] = []) {
    const client = await runtime.connect();
    try {
      await client.query('begin');
      await client.query(
        "select set_config('caseflow.tenant_id',$1,true), set_config('caseflow.subject',$2,true)",
        [tenantId, subject],
      );
      const result = await client.query(sql, values);
      await client.query('commit');
      return result.rows;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function dispatch(sql: string, values: unknown[] = []) {
    const client = await db.owner.connect();
    try {
      await client.query('begin');
      await client.query('set local role caseflow_dispatcher');
      assert.equal(
        (await client.query('select current_user')).rows[0].current_user,
        'caseflow_dispatcher',
      );
      const result = await client.query(sql, values);
      await client.query('commit');
      return result.rows;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  try {
    const staff = userSchema.parse(await execute('staff', Operation.GetProfile));
    const admin = userSchema.parse(await execute('admin', Operation.GetProfile));
    const superAdmin = userSchema.parse(await execute('super', Operation.GetProfile));
    await execute('other', Operation.GetProfile);
    await db.owner.query('select caseflow.operator_set_role($1,$2)', [
      superAdmin.id,
      Role.SuperAdmin,
    ]);
    await db.owner.query('select caseflow.operator_set_role($1,$2)', [admin.id, Role.Admin]);
    const record = caseSchema.parse(
      await execute('admin', Operation.CreateCase, {
        title: 'Processing fixture',
        clientName: 'Fictional Client',
      }),
    );
    await execute('admin', Operation.AssignCase, { id: record.id, userId: staff.id });
    async function start() {
      return parseUploadRecord(
        await execute('staff', Operation.StartDocumentUpload, {
          caseId: record.id,
          requestId: randomUUID(),
          filename: 'fixture.pdf',
          contentType: 'application/pdf',
          sizeBytes: 7,
          checksumSha256: checksum,
          bucket: 'caseflow-test-documents',
          environment: 'dev',
        }),
      );
    }
    const complete = (session: string, subject = 'staff') =>
      asUser(subject, 'select * from caseflow.complete_document_upload($1,$2,$3)', [
        record.id,
        session,
        'saved-version',
      ]);
    const request = (document: string, expected: string | null = null, subject = 'admin') =>
      asUser(subject, 'select caseflow.request_document_processing($1,$2,$3) id', [
        record.id,
        document,
        expected,
      ]);
    const jobs = async (document: string) =>
      (
        await db.owner.query(
          'select * from caseflow.document_processing_jobs where document_id=$1 order by created_at',
          [document],
        )
      ).rows;
    const upload = await start();

    await t.test(
      'concurrent completion creates exactly one immutable source snapshot, dispatch and audit',
      async () => {
        await Promise.all([complete(upload.session.id), complete(upload.session.id)]);
        const [job] = await jobs(upload.document.id);
        assert.equal((await jobs(upload.document.id)).length, 1);
        assert.equal(job.source_version_id, 'saved-version');
        assert.equal(job.source_checksum_sha256, checksum);
        assert.equal(job.status, 'queued');
        assert.equal(job.attempt_count, 0);
        assert.equal(
          (
            await db.owner.query(
              'select count(*)::int n from caseflow.processing_dispatches where job_id=$1',
              [job.id],
            )
          ).rows[0].n,
          1,
        );
        const events = (
          await db.owner.query(
            'select action,after_value from caseflow.audit_events where target_id=$1 order by id',
            [upload.document.id],
          )
        ).rows;
        assert.deepEqual(
          events.map((e) => e.action),
          ['document.upload_started', 'document.uploaded', 'document.processing_queued'],
        );
        assert.ok(!JSON.stringify(events).includes('saved-version'));
        assert.equal((await request(upload.document.id))[0].id, job.id);
      },
    );

    await t.test(
      'audit or outbox failure rolls back upload, session, job and audit together',
      async () => {
        for (const table of ['audit_events', 'processing_dispatches']) {
          const pending = await start();
          await db.owner
            .query(`create function caseflow.reject_processing() returns trigger language plpgsql as $$ begin
          if TG_TABLE_NAME = 'processing_dispatches' then raise exception 'test rollback'; end if;
          if new.action = 'document.processing_queued' then raise exception 'test rollback'; end if;
          return new; end $$;
          create trigger reject_processing before insert on caseflow.${table} for each row execute function caseflow.reject_processing()`);
          try {
            await assert.rejects(complete(pending.session.id), /test rollback/);
            assert.equal((await jobs(pending.document.id)).length, 0);
            assert.equal(
              (
                await db.owner.query('select status from caseflow.documents where id=$1', [
                  pending.document.id,
                ])
              ).rows[0].status,
              'pending_upload',
            );
            assert.equal(
              (
                await db.owner.query(
                  'select status from caseflow.document_upload_sessions where id=$1',
                  [pending.session.id],
                )
              ).rows[0].status,
              'pending',
            );
            assert.equal(
              (
                await db.owner.query(
                  'select count(*)::int n from caseflow.audit_events where target_id=$1',
                  [pending.document.id],
                )
              ).rows[0].n,
              1,
            );
          } finally {
            await db.owner.query(
              `drop trigger reject_processing on caseflow.${table}; drop function caseflow.reject_processing()`,
            );
          }
        }
      },
    );

    await t.test(
      'manual retries are admin-only, compare expected job and coalesce concurrent retries',
      async () => {
        const [original] = await jobs(upload.document.id);
        await assert.rejects(request(upload.document.id, null, 'staff'), /FORBIDDEN/);
        await assert.rejects(request(upload.document.id, null, 'missing'), /UNAUTHENTICATED/);
        await assert.rejects(request(upload.document.id, randomUUID()), /PROCESSING_CONFLICT/);
        await assert.rejects(request(upload.document.id, original.id), /PROCESSING_CONFLICT/);
        await db.owner.query(
          "update caseflow.document_processing_jobs set status='failed', failure_code='internal_error', finished_at=clock_timestamp() where id=$1",
          [original.id],
        );
        const [a, b] = await Promise.all([
          request(upload.document.id, original.id),
          request(upload.document.id, original.id, 'super'),
        ]);
        assert.equal(a[0].id, b[0].id);
        assert.equal((await jobs(upload.document.id)).length, 2);
        assert.equal((await jobs(upload.document.id))[1].previous_job_id, original.id);
        await assert.rejects(request(upload.document.id), /PROCESSING_CONFLICT/);
        const pending = await start();
        await assert.rejects(request(pending.document.id), /DOCUMENT_UNAVAILABLE/);
        await execute('super', Operation.UpdateAccess, { id: admin.id, active: false });
        await assert.rejects(request(upload.document.id), /ACCOUNT_DISABLED/);
        await execute('super', Operation.UpdateAccess, { id: admin.id, active: true });
      },
    );

    await t.test(
      'RLS hides unassigned/removed jobs and internal storage fields; upload retries never recreate jobs',
      async () => {
        assert.equal(
          (await asUser('other', 'select id from caseflow.document_processing_jobs')).length,
          0,
        );
        assert.equal(
          (await asUser('staff', 'select id from caseflow.document_processing_jobs')).length,
          2,
        );
        await assert.rejects(
          asUser('admin', 'select source_key from caseflow.document_processing_jobs'),
          /permission denied/,
        );
        await execute('admin', Operation.RemoveDocument, {
          caseId: record.id,
          documentId: upload.document.id,
          expectedVersion: 2,
        });
        assert.equal(
          (await asUser('staff', 'select id from caseflow.document_processing_jobs')).length,
          0,
        );
        await assert.rejects(request(upload.document.id), /DOCUMENT_UNAVAILABLE/);
        await complete(upload.session.id, 'admin');
        assert.equal((await jobs(upload.document.id)).length, 2);
        await execute('admin', Operation.RestoreDocument, {
          caseId: record.id,
          documentId: upload.document.id,
          expectedVersion: 3,
        });
        await complete(upload.session.id);
        assert.equal((await jobs(upload.document.id)).length, 2);
        await execute('admin', Operation.ArchiveCase, { id: record.id, expectedVersion: 1 });
        await assert.rejects(request(upload.document.id), /CASE_ARCHIVED/);
        assert.equal(
          (await asUser('staff', 'select id from caseflow.document_processing_jobs')).length,
          2,
        );
        await execute('admin', Operation.RestoreCase, { id: record.id, expectedVersion: 2 });
      },
    );

    await t.test(
      'failed and expired uploads never queue jobs; job constraints reject invalid state',
      async () => {
        const failed = await start();
        await asUser('staff', 'select caseflow.fail_document_upload($1,$2)', [
          record.id,
          failed.session.id,
        ]);
        await complete(failed.session.id);
        assert.equal((await jobs(failed.document.id)).length, 0);
        const expired = await start();
        await db.owner.query(
          "update caseflow.document_upload_sessions set created_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' where id=$1",
          [expired.session.id],
        );
        await complete(expired.session.id);
        assert.equal((await jobs(expired.document.id)).length, 0);
        const [job] = await jobs(upload.document.id);
        for (const patch of [
          'attempt_count=-1',
          'attempt_count=6',
          "status='invented'",
          "stage='extracting'",
          "failure_code='private provider details'",
          "source_version_id='null'",
          "source_checksum_sha256='invalid'",
        ]) {
          await assert.rejects(
            db.owner.query(`update caseflow.document_processing_jobs set ${patch} where id=$1`, [
              job.id,
            ]),
            { code: '23514' },
          );
        }
      },
    );

    await t.test('role changes are rechecked after acquiring the permission lock', async () => {
      const blocker = await db.owner.connect();
      try {
        await blocker.query('begin');
        await blocker.query('select pg_advisory_xact_lock(734921,1)');
        const waiting = assert.rejects(request(upload.document.id), /FORBIDDEN/);
        await waitForPermissionLock(db.owner);
        await blocker.query("update caseflow.users set role='staff' where id=$1", [admin.id]);
        await blocker.query('commit');
        await waiting;
      } finally {
        await blocker.query('rollback');
        blocker.release();
      }
      await db.owner.query('select caseflow.operator_set_role($1,$2)', [admin.id, Role.Admin]);
    });

    await t.test(
      'concurrent dispatch claims are disjoint; crashed/expired claims are fenced and retryable',
      async () => {
        const [a, b] = await Promise.all([
          dispatch('select * from caseflow.claim_processing_dispatches(1)'),
          dispatch('select * from caseflow.claim_processing_dispatches(1)'),
        ]);
        const first = a[0];
        const second = b[0];
        assert.notEqual(first.dispatch_id, second.dispatch_id);
        assert.equal(
          (await dispatch('select * from caseflow.claim_processing_dispatches(1)')).length,
          0,
        );
        await db.owner.query(
          "update caseflow.processing_dispatches set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
          [first.dispatch_id],
        );
        assert.equal(
          (
            await dispatch('select caseflow.finish_processing_dispatch($1,$2,$3) ok', [
              first.dispatch_id,
              first.lease_token,
              'message-id',
            ])
          )[0].ok,
          false,
        );
        const [reclaimed] = await dispatch('select * from caseflow.claim_processing_dispatches(1)');
        assert.equal(reclaimed.dispatch_id, first.dispatch_id);
        assert.notEqual(reclaimed.lease_token, first.lease_token);
        assert.equal(reclaimed.attempt_count, 2);
        assert.equal(
          (
            await dispatch('select caseflow.retry_processing_dispatch($1,$2) ok', [
              first.dispatch_id,
              first.lease_token,
            ])
          )[0].ok,
          false,
        );
        assert.equal(
          (
            await dispatch('select caseflow.finish_processing_dispatch($1,$2,$3) ok', [
              reclaimed.dispatch_id,
              reclaimed.lease_token,
              'message-id',
            ])
          )[0].ok,
          true,
        );
        assert.equal(
          (
            await dispatch('select caseflow.retry_processing_dispatch($1,$2) ok', [
              second.dispatch_id,
              second.lease_token,
            ])
          )[0].ok,
          true,
        );
        assert.equal(
          (await dispatch('select * from caseflow.claim_processing_dispatches(1)')).length,
          0,
        );
        await db.owner.query(
          'update caseflow.processing_dispatches set available_at=clock_timestamp() where id=$1',
          [second.dispatch_id],
        );
        const [retry] = await dispatch('select * from caseflow.claim_processing_dispatches(1)');
        assert.equal(retry.attempt_count, 2);
        await dispatch('select caseflow.finish_processing_dispatch($1,$2,$3)', [
          retry.dispatch_id,
          retry.lease_token,
          'second-message',
        ]);
      },
    );

    await t.test(
      'restricted roles cannot write tables, invoke helpers, or cross the dispatcher boundary',
      async () => {
        for (const sql of [
          'update caseflow.document_processing_jobs set attempt_count=0',
          'delete from caseflow.processing_dispatches',
          'select * from caseflow.processing_dispatches',
          'select * from caseflow.claim_processing_dispatches(1)',
          'select caseflow.enqueue_document_processing(null,null,null)',
        ]) {
          await assert.rejects(asUser('admin', sql), /permission denied/);
        }
        for (const sql of [
          'select * from caseflow.documents',
          'select * from caseflow.document_processing_jobs',
          "update caseflow.processing_dispatches set status='sent'",
          'select caseflow.request_document_processing(null,null,null)',
        ]) {
          await assert.rejects(dispatch(sql), /permission denied/);
        }
        await assert.rejects(
          dispatch('select * from caseflow.claim_processing_dispatches(26)'),
          /INVALID_INPUT/,
        );
        const exposed = await db.owner
          .query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        cross join pg_roles r where n.nspname='caseflow' and p.proname like '%processing%'
        and r.rolname in ('anon','authenticated','service_role') and has_function_privilege(r.oid,p.oid,'execute')`);
        assert.equal(exposed.rowCount, 0);
        const unsafe = await db.owner
          .query(`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='caseflow' and proname like '%processing%' and (not prosecdef or proconfig is distinct from array['search_path=""'])`);
        assert.equal(unsafe.rowCount, 0);
      },
    );
  } finally {
    await runtime.end();
    await db.close();
  }
});

test('processing migration preserves existing data and does not queue historical uploads', async () => {
  let snapshot: unknown;
  const snapshotSql = `select jsonb_build_object(
    'documents', (select jsonb_agg(d order by id) from caseflow.documents d),
    'sessions', (select jsonb_agg(s order by id) from caseflow.document_upload_sessions s),
    'audit', (select jsonb_agg(to_jsonb(a) - 'service_name' order by id) from caseflow.audit_events a)
  ) snapshot`;
  const db = await createTestDatabase(async (owner) => {
    const user = randomUUID();
    const record = randomUUID();
    await owner.query(
      "insert into caseflow.users(id,tenant_id,subject,display_name) values($1,$2,'legacy','Legacy')",
      [user, randomUUID()],
    );
    await owner.query(
      "insert into caseflow.cases(id,title,client_name) values($1,'Legacy','Fictional Client')",
      [record],
    );
    const doc = (
      await owner.query(
        `insert into caseflow.documents(case_id,uploaded_by,filename,content_type,size_bytes,storage_bucket,storage_environment,status,uploaded_at,object_version_id)
      values($1,$2,'legacy.pdf','application/pdf',7,'caseflow-test-documents','dev','available',now(),'legacy-version') returning id`,
        [record, user],
      )
    ).rows[0];
    await owner.query(
      "insert into caseflow.document_upload_sessions(document_id,status,expires_at,finished_at) values($1,'completed',now()+interval '5 minutes',now())",
      [doc.id],
    );
    await owner.query(
      "insert into caseflow.audit_events(actor_id,target_id,action) values($1,$2,'document.uploaded')",
      [user, doc.id],
    );
    snapshot = (await owner.query(snapshotSql)).rows[0].snapshot;
  }, 'document_library.sql');
  try {
    await db.owner.query(db.seed);
    await db.owner.query(db.seed);
    assert.deepEqual((await db.owner.query(snapshotSql)).rows[0].snapshot, snapshot);
    assert.equal(
      (await db.owner.query('select count(*)::int n from caseflow.document_processing_jobs'))
        .rows[0].n,
      0,
    );
    assert.equal(
      (await db.owner.query('select count(*)::int n from caseflow.processing_dispatches')).rows[0]
        .n,
      0,
    );
    const tables = (
      await db.owner.query(`select relname,relrowsecurity from pg_class where oid in
      ('caseflow.document_processing_jobs'::regclass,'caseflow.processing_dispatches'::regclass)`)
    ).rows;
    assert.equal(tables.length, 2);
    assert.ok(tables.every((table) => table.relrowsecurity));
  } finally {
    await db.close();
  }
});
