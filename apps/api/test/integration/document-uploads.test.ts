import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  DocumentLimits,
  ErrorCode,
  Role,
  userSchema,
  caseSchema,
  documentUploadAuthorizationSchema,
  documentUploadResultSchema,
} from '@caseflow/schemas';
import { buildApp } from '../../src/app.js';
import { Operation } from '../../src/database/operations.js';
import { UploadVerificationError, type UploadStorage } from '../../src/storage/uploads.js';
import { createTestDatabase, waitForPermissionLock } from './database-fixture.js';

const checksum = createHash('sha256').update('fixture').digest('base64');

test('document uploads: API lifecycle, concurrency and database authorization', async (t) => {
  const db = await createTestDatabase();
  const tenantId = randomUUID();
  const identity = (subject: string) => ({ tenantId, subject, name: subject });
  const execute = (subject: string, operation: Operation, input: Record<string, unknown> = {}) =>
    db.store.execute(identity(subject), operation, input);
  let verifyCalls = 0;
  let authorizeHook: (() => Promise<void>) | undefined;
  let verifyHook: (() => Promise<string>) | undefined;
  const storage: UploadStorage = {
    bucket: 'caseflow-test-documents',
    environment: 'dev',
    authorize: async (record) => {
      await authorizeHook?.();
      return {
        method: 'PUT',
        url: 'https://example.invalid/upload',
        expiresAt: record.session.expiresAt,
        headers: {
          'Content-Type': record.document.contentType,
          'If-None-Match': '*',
          'x-amz-checksum-sha256': record.storage.checksumSha256,
        },
      };
    },
    verify: async () => {
      verifyCalls++;
      return verifyHook ? verifyHook() : 'verified-object-version';
    },
  };
  const app = await buildApp(
    {
      clientId: tenantId,
      webClientId: tenantId,
      webOrigin: 'http://localhost:3000',
      databaseUrl: db.runtimeUrl,
    },
    async (token) => identity(token),
    false,
    { execute: db.store.execute, close: async () => {} },
    storage,
  );
  const call = (url: string, token: string | undefined, payload: object = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload,
    });
  const startUrl = (caseId: string) => `/cases/${caseId}/document-uploads`;
  const completeUrl = (caseId: string, sessionId: string) =>
    `${startUrl(caseId)}/${sessionId}/complete`;
  const request = () => ({
    filename: 'Fictional record.pdf',
    contentType: 'application/pdf',
    sizeBytes: 8,
    checksumSha256: checksum,
    requestId: randomUUID(),
  });
  const newCase = async () =>
    caseSchema.parse(
      await execute('admin', Operation.CreateCase, {
        title: 'Fictional upload case',
        clientName: 'Fictional Client',
      }),
    );
  async function start(caseId: string, token = 'staff', payload = request()) {
    const response = await call(startUrl(caseId), token, payload);
    assert.equal(response.statusCode, 201, response.body);
    return documentUploadAuthorizationSchema.parse(response.json());
  }
  async function counts() {
    return (
      await db.owner.query(`select (select count(*)::int from caseflow.documents) documents,
      (select count(*)::int from caseflow.document_upload_sessions) sessions,
      (select count(*)::int from caseflow.audit_events) audits`)
    ).rows[0];
  }

  try {
    const staff = userSchema.parse(await execute('staff', Operation.GetProfile));
    const other = userSchema.parse(await execute('other', Operation.GetProfile));
    const admin = userSchema.parse(await execute('admin', Operation.GetProfile));
    const superAdmin = userSchema.parse(await execute('super', Operation.GetProfile));
    await db.owner.query('select caseflow.operator_set_role($1,$2)', [
      superAdmin.id,
      Role.SuperAdmin,
    ]);
    await db.owner.query('select caseflow.operator_set_role($1,$2)', [admin.id, Role.Admin]);
    const record = await newCase();
    await execute('admin', Operation.AssignCase, { id: record.id, userId: staff.id });

    await t.test(
      'assigned Staff and administrators can initiate; unknown fields and unauthorized requests fail',
      async () => {
        for (const token of ['staff', 'admin', 'super']) {
          await start(record.id, token);
        }
        assert.equal((await call(startUrl(record.id), undefined, request())).statusCode, 401);
        assert.equal((await call(startUrl(record.id), 'other', request())).statusCode, 404);
        assert.equal((await call(startUrl(record.id), 'new-profile', request())).statusCode, 401);
        for (const extra of [
          { uploadedBy: other.id },
          { storageBucket: 'forged' },
          { objectKey: 'forged' },
          { status: 'available' },
          { role: 'admin' },
        ]) {
          assert.equal(
            (await call(startUrl(record.id), 'staff', { ...request(), ...extra })).statusCode,
            400,
          );
        }
        await execute('admin', Operation.UpdateAccess, { id: staff.id, active: false });
        assert.equal((await call(startUrl(record.id), 'staff', request())).statusCode, 403);
        await execute('admin', Operation.UpdateAccess, { id: staff.id, active: true });
        const archived = await newCase();
        await execute('admin', Operation.ArchiveCase, {
          id: archived.id,
          expectedVersion: archived.version,
        });
        assert.equal(
          (await call(startUrl(archived.id), 'admin', request())).json().code,
          ErrorCode.CaseArchived,
        );
      },
    );

    await t.test(
      'concurrent initiation is idempotent and never changes the original expiry or metadata',
      async () => {
        const payload = request();
        const before = await counts();
        const [a, b] = await Promise.all([
          start(record.id, 'staff', payload),
          start(record.id, 'staff', payload),
        ]);
        assert.deepEqual(a.document, b.document);
        assert.equal(a.session.expiresAt, b.session.expiresAt);
        assert.deepEqual(await counts(), {
          documents: before.documents + 1,
          sessions: before.sessions + 1,
          audits: before.audits + 1,
        });
        assert.equal(
          (await call(startUrl(record.id), 'staff', { ...payload, filename: 'changed.pdf' })).json()
            .code,
          ErrorCode.UploadConflict,
        );
        assert.equal('storage' in a, false);
        assert.equal('objectKey' in a.document, false);
      },
    );

    await t.test(
      'concurrent completion pins one version and emits upload and processing audits; later retries skip storage',
      async () => {
        const payload = request();
        const upload = await start(record.id, 'staff', payload);
        const url = completeUrl(record.id, upload.session.id);
        const before = await counts();
        const responses = await Promise.all([call(url, 'staff'), call(url, 'staff')]);
        for (const response of responses) {
          assert.equal(response.statusCode, 200, response.body);
        }
        const result = documentUploadResultSchema.parse(responses[0]!.json());
        assert.equal(result.document.status, 'available');
        assert.equal(result.document.version, 2);
        assert.equal(result.session.status, 'completed');
        assert.equal((await counts()).audits, before.audits + 2);
        const stored = (
          await db.owner.query('select object_version_id from caseflow.documents where id=$1', [
            upload.document.id,
          ])
        ).rows[0];
        assert.equal(stored.object_version_id, 'verified-object-version');
        const verified = verifyCalls;
        assert.equal((await call(url, 'staff')).statusCode, 200);
        assert.equal(verifyCalls, verified);
        assert.equal((await start(record.id, 'staff', payload)).upload, null);
        assert.equal((await call(url, 'staff', { objectVersionId: 'forged' })).statusCode, 400);
        assert.equal(
          (await call(completeUrl(randomUUID(), upload.session.id), 'admin')).statusCode,
          404,
        );
        await execute('admin', Operation.AssignCase, { id: record.id, userId: other.id });
        assert.equal((await call(url, 'other')).statusCode, 404);
      },
    );

    await t.test(
      'transient failures keep uploads retryable; invalid files stay unavailable and retain quota',
      async () => {
        const payload = request();
        authorizeHook = async () => {
          throw new Error('private credential error');
        };
        const initial = await call(startUrl(record.id), 'staff', payload);
        assert.equal(initial.statusCode, 503);
        assert.ok(!initial.body.includes('credential'));
        authorizeHook = undefined;
        const upload = await start(record.id, 'staff', payload);
        const url = completeUrl(record.id, upload.session.id);
        verifyHook = async () => {
          throw new Error('private S3 error');
        };
        assert.equal((await call(url, 'staff')).statusCode, 503);
        assert.equal(
          (
            await db.owner.query(
              'select status from caseflow.document_upload_sessions where id=$1',
              [upload.session.id],
            )
          ).rows[0].status,
          'pending',
        );
        verifyHook = async () => {
          throw new UploadVerificationError();
        };
        assert.equal((await call(url, 'staff')).json().code, ErrorCode.UploadVerificationFailed);
        const failed = (
          await db.owner.query(
            `select d.status, s.status session_status, d.size_bytes from caseflow.documents d join caseflow.document_upload_sessions s on s.document_id=d.id where d.id=$1`,
            [upload.document.id],
          )
        ).rows[0];
        assert.equal(failed.status, 'pending_upload');
        assert.equal(failed.session_status, 'failed');
        assert.equal(Number(failed.size_bytes), payload.sizeBytes);
        verifyHook = undefined;
        assert.equal((await call(url, 'staff')).statusCode, 422);
      },
    );

    await t.test(
      'expired sessions persist their terminal state and cannot be reauthorized',
      async () => {
        const payload = request();
        const upload = await start(record.id, 'staff', payload);
        await db.owner.query(
          `update caseflow.document_upload_sessions set created_at=now()-interval '6 minutes', expires_at=now()-interval '1 minute' where id=$1`,
          [upload.session.id],
        );
        assert.equal(
          (await call(completeUrl(record.id, upload.session.id), 'staff')).json().code,
          ErrorCode.UploadExpired,
        );
        assert.equal(
          (
            await db.owner.query(
              'select status from caseflow.document_upload_sessions where id=$1',
              [upload.session.id],
            )
          ).rows[0].status,
          'expired',
        );
        assert.equal((await call(startUrl(record.id), 'staff', payload)).statusCode, 409);
      },
    );

    await t.test('access is rechecked after presigning and verification', async () => {
      authorizeHook = async () => {
        await execute('admin', Operation.UnassignCase, { id: record.id, userId: staff.id });
      };
      assert.equal((await call(startUrl(record.id), 'staff', request())).statusCode, 404);
      authorizeHook = undefined;
      await execute('admin', Operation.AssignCase, { id: record.id, userId: staff.id });
      const upload = await start(record.id);
      verifyHook = async () => {
        await execute('admin', Operation.UpdateAccess, { id: staff.id, active: false });
        return 'verified';
      };
      assert.equal(
        (await call(completeUrl(record.id, upload.session.id), 'staff')).statusCode,
        403,
      );
      assert.equal(
        (
          await db.owner.query('select status from caseflow.documents where id=$1', [
            upload.document.id,
          ])
        ).rows[0].status,
        'pending_upload',
      );
      verifyHook = undefined;
      await execute('admin', Operation.UpdateAccess, { id: staff.id, active: true });
      verifyHook = async () => {
        await execute('admin', Operation.ArchiveCase, { id: record.id, expectedVersion: 1 });
        return 'verified';
      };
      assert.equal(
        (await call(completeUrl(record.id, upload.session.id), 'staff')).json().code,
        ErrorCode.CaseArchived,
      );
      verifyHook = undefined;
      await execute('admin', Operation.RestoreCase, { id: record.id, expectedVersion: 2 });
    });

    await t.test(
      'initiation reloads permissions after waiting for the shared transaction lock',
      async () => {
        const blocker = await db.owner.connect();
        try {
          await blocker.query('begin');
          await blocker.query('select pg_advisory_xact_lock(734921,1)');
          const pending = call(startUrl(record.id), 'staff', request()).then(
            (response) => response,
          );
          await waitForPermissionLock(db.owner);
          await blocker.query('delete from caseflow.assignments where case_id=$1 and user_id=$2', [
            record.id,
            staff.id,
          ]);
          await blocker.query('commit');
          assert.equal((await pending).statusCode, 404);
        } finally {
          await blocker.query('rollback');
          blocker.release();
        }
        await execute('admin', Operation.AssignCase, { id: record.id, userId: staff.id });
      },
    );

    await t.test('audit failure rolls back initiation and completion atomically', async () => {
      const upload = await start(record.id);
      const before = await counts();
      await db.owner
        .query(`create function caseflow.reject_upload_audit() returns trigger language plpgsql as $$
        begin if new.action in ('document.upload_started','document.uploaded') then raise exception 'test audit failure'; end if; return new; end $$;
        create trigger reject_upload_audit before insert on caseflow.audit_events for each row execute function caseflow.reject_upload_audit()`);
      try {
        assert.equal((await call(startUrl(record.id), 'staff', request())).statusCode, 503);
        assert.equal(
          (await call(completeUrl(record.id, upload.session.id), 'staff')).statusCode,
          503,
        );
        assert.deepEqual(await counts(), before);
        assert.equal(
          (
            await db.owner.query(
              'select status from caseflow.document_upload_sessions where id=$1',
              [upload.session.id],
            )
          ).rows[0].status,
          'pending',
        );
        assert.equal(
          (
            await db.owner.query('select object_version_id from caseflow.documents where id=$1', [
              upload.document.id,
            ])
          ).rows[0].object_version_id,
          null,
        );
      } finally {
        await db.owner.query(
          'drop trigger reject_upload_audit on caseflow.audit_events; drop function caseflow.reject_upload_audit()',
        );
      }
      assert.equal(
        (await call(completeUrl(record.id, upload.session.id), 'staff')).statusCode,
        200,
      );
    });

    await t.test(
      'quota reservations serialize concurrent requests and include unavailable/removed documents',
      async () => {
        const used = Number(
          (await db.owner.query('select sum(size_bytes) bytes from caseflow.documents')).rows[0]
            .bytes,
        );
        let remaining = DocumentLimits.WorkspaceSizeBytes - used - 8;
        const inserted: string[] = [];
        try {
          while (remaining > 0) {
            const size = Math.min(DocumentLimits.FileSizeBytes, remaining);
            const result = await db.owner.query(
              `insert into caseflow.documents(case_id,uploaded_by,filename,content_type,size_bytes,storage_bucket,storage_environment)
            values ($1,$2,'quota.pdf','application/pdf',$3,'caseflow-test-documents','dev') returning id`,
              [record.id, admin.id, size],
            );
            inserted.push(result.rows[0].id);
            remaining -= size;
          }
          const responses = await Promise.all([
            call(startUrl(record.id), 'staff', request()),
            call(startUrl(record.id), 'admin', request()),
          ]);
          assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
          assert.equal(
            responses.find((response) => response.statusCode === 409)!.json().code,
            ErrorCode.StorageQuotaExceeded,
          );
          assert.equal(
            Number(
              (await db.owner.query('select sum(size_bytes) bytes from caseflow.documents')).rows[0]
                .bytes,
            ),
            DocumentLimits.WorkspaceSizeBytes,
          );
        } finally {
          await db.owner.query('delete from caseflow.documents where id=any($1::uuid[])', [
            inserted,
          ]);
        }
      },
    );

    await t.test(
      'completion reloads a demoted administrator after waiting for the permission lock',
      async () => {
        const upload = await start(record.id, 'admin');
        const blocker = await db.owner.connect();
        let entered!: () => void;
        const verification = new Promise<void>((resolve) => {
          entered = resolve;
        });
        verifyHook = async () => {
          await blocker.query('begin');
          await blocker.query('select pg_advisory_xact_lock(734921,1)');
          await blocker.query("update caseflow.users set role='staff' where id=$1", [admin.id]);
          entered();
          return 'verified-before-demotion';
        };
        try {
          const pending = call(completeUrl(record.id, upload.session.id), 'admin').then(
            (response) => response,
          );
          await verification;
          await waitForPermissionLock(db.owner);
          await blocker.query('commit');
          assert.equal((await pending).statusCode, 404);
          assert.equal(
            (
              await db.owner.query('select status from caseflow.documents where id=$1', [
                upload.document.id,
              ])
            ).rows[0].status,
            'pending_upload',
          );
        } finally {
          verifyHook = undefined;
          await blocker.query('rollback');
          blocker.release();
          await db.owner.query('select caseflow.operator_set_role($1,$2)', [admin.id, Role.Admin]);
        }
      },
    );

    await t.test(
      'runtime cannot write tables, bypass internal helpers or forge missing identity',
      async () => {
        const runtime = await db.runtime.connect();
        try {
          for (const sql of [
            "update caseflow.documents set status='available'",
            'delete from caseflow.document_upload_sessions',
            `select caseflow.require_upload_case('${record.id}')`,
            `select caseflow.start_document_upload('${record.id}','${randomUUID()}','a.pdf','application/pdf',8,'${checksum}','caseflow-test-documents','dev')`,
          ]) {
            await assert.rejects(runtime.query(sql));
          }
          await runtime.query('begin');
          await runtime.query(
            "select set_config('caseflow.tenant_id',$1,true),set_config('caseflow.subject','staff',true)",
            [tenantId],
          );
          await assert.rejects(
            runtime.query('select caseflow.start_document_upload($1,$2,$3,$4,$5,$6,$7,$8)', [
              record.id,
              randomUUID(),
              '../bad.pdf',
              'application/pdf',
              8,
              checksum,
              storage.bucket,
              'dev',
            ]),
            { code: '23514' },
          );
          await runtime.query('rollback');
        } finally {
          runtime.release();
        }
      },
    );

    await t.test('CORS and response caching retain the existing protected API policy', async () => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: startUrl(record.id),
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      assert.equal(response.statusCode, 204);
      const upload = await call(startUrl(record.id), 'staff', request());
      assert.equal(upload.headers['cache-control'], 'no-store');
    });
  } finally {
    await app.close();
    await db.close();
  }
});

test('upload workflow migration preserves legacy documents/sessions and restricts function execution', async () => {
  let document: Record<string, unknown>;
  let session: unknown;
  const db = await createTestDatabase(async (owner) => {
    const userId = randomUUID();
    const caseId = randomUUID();
    await owner.query(
      "insert into caseflow.users(id,tenant_id,subject,display_name) values($1,$2,'legacy','Legacy')",
      [userId, randomUUID()],
    );
    await owner.query(
      "insert into caseflow.cases(id,title,client_name) values($1,'Legacy case','Fictional Client')",
      [caseId],
    );
    document = (
      await owner.query(
        `insert into caseflow.documents(case_id,uploaded_by,filename,content_type,size_bytes,storage_bucket,storage_environment)
      values($1,$2,'legacy.pdf','application/pdf',100,'caseflow-test-documents','dev') returning *`,
        [caseId, userId],
      )
    ).rows[0];
    session = (
      await owner.query(
        `insert into caseflow.document_upload_sessions(document_id,expires_at) values($1,now()+interval '5 minutes') returning *`,
        [document!.id],
      )
    ).rows[0];
  }, 'document_foundation.sql');
  try {
    const row = (
      await db.owner.query('select * from caseflow.documents where id=$1', [document!.id])
    ).rows[0];
    assert.deepEqual(row, { ...document!, upload_request_id: null, checksum_sha256: null });
    assert.deepEqual(
      (
        await db.owner.query(
          'select * from caseflow.document_upload_sessions where document_id=$1',
          [document!.id],
        )
      ).rows[0],
      session,
    );
    const denied = await db.owner
      .query(`select p.proname, r.rolname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      cross join pg_roles r where n.nspname='caseflow' and p.proname like '%document_upload'
      and r.rolname in ('anon','authenticated','service_role') and has_function_privilege(r.oid,p.oid,'execute')`);
    assert.equal(denied.rowCount, 0);
    await db.owner.query(db.seed);
    assert.equal(
      (await db.owner.query('select count(*)::int n from caseflow.documents')).rows[0].n,
      1,
    );
  } finally {
    await db.close();
  }
});
