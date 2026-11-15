import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  ErrorCode,
  Role,
  caseSchema,
  userSchema,
  documentSchema,
  documentPageSchema,
  documentUploadAuthorizationSchema,
  documentUploadResultSchema,
} from '@caseflow/schemas';
import { buildApp } from '../../src/app.js';
import { Operation } from '../../src/database/operations.js';
import { parseUploadRecord } from '../../src/database/documents.js';
import type { DownloadStorage } from '../../src/storage/downloads.js';
import type { UploadStorage } from '../../src/storage/uploads.js';
import { createTestDatabase, waitForPermissionLock } from './database-fixture.js';

const checksum = createHash('sha256').update('fixture').digest('base64');

test('document library: listing, downloads, removal and restoration', async (t) => {
  const db = await createTestDatabase();
  const tenantId = randomUUID();
  const identity = (subject: string) => ({ tenantId, subject, name: subject });
  const execute = (subject: string, operation: Operation, input: Record<string, unknown> = {}) =>
    db.store.execute(identity(subject), operation, input);
  let signingHook: (() => Promise<void>) | undefined;
  let signingCalls = 0;
  let expiryOffset = 59000;
  const downloads: DownloadStorage = {
    authorize: async () => {
      signingCalls++;
      await signingHook?.();
      return {
        method: 'GET',
        url: 'https://example.invalid/private-download?signature=secret',
        expiresAt: new Date(Date.now() + expiryOffset).toISOString(),
      };
    },
  };
  const uploads: UploadStorage = {
    bucket: 'caseflow-test-documents',
    environment: 'dev',
    authorize: async (record) => ({
      method: 'PUT',
      url: 'https://example.invalid/upload',
      expiresAt: record.session.expiresAt,
      headers: {
        'Content-Type': record.document.contentType,
        'If-None-Match': '*',
        'x-amz-checksum-sha256': record.storage.checksumSha256,
      },
    }),
    verify: async () => 'saved-object-version',
  };
  const config = {
    clientId: tenantId,
    webClientId: tenantId,
    webOrigin: 'http://localhost:3000',
    databaseUrl: db.runtimeUrl,
  };
  const store = { execute: db.store.execute, close: async () => {} };
  const app = await buildApp(
    config,
    async (token) => identity(token),
    false,
    store,
    uploads,
    downloads,
  );
  const withoutStorage = await buildApp(config, async (token) => identity(token), false, store);
  const call = (
    method: 'GET' | 'POST',
    url: string,
    token: string | undefined = 'admin',
    payload: object = {},
  ) =>
    app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(method === 'POST' ? { payload } : {}),
    });
  const library = (caseId: string) => `/cases/${caseId}/documents`;
  const actionUrl = (caseId: string, documentId: string, action: string) =>
    `${library(caseId)}/${documentId}/${action}`;
  const mutate = (
    caseId: string,
    documentId: string,
    action: 'remove' | 'restore',
    expectedVersion: number,
    token = 'admin',
  ) => call('POST', actionUrl(caseId, documentId, action), token, { expectedVersion });
  const download = (caseId: string, documentId: string, token = 'staff') =>
    call('POST', actionUrl(caseId, documentId, 'download'), token);
  const newCase = async () => {
    const record = caseSchema.parse(
      await execute('admin', Operation.CreateCase, {
        title: 'Fictional document case',
        clientName: 'Fictional Client',
      }),
    );
    await execute('admin', Operation.AssignCase, { id: record.id, userId: staff.id });
    await execute('admin', Operation.AssignCase, { id: record.id, userId: colleague.id });
    return record;
  };
  const start = async (caseId: string, subject = 'staff') =>
    parseUploadRecord(
      await execute(subject, Operation.StartDocumentUpload, {
        caseId,
        requestId: randomUUID(),
        filename: 'Fictional record.pdf',
        contentType: 'application/pdf',
        sizeBytes: 7,
        checksumSha256: checksum,
        bucket: uploads.bucket,
        environment: uploads.environment,
      }),
    );
  const upload = async (caseId: string) => {
    const started = await start(caseId);
    return parseUploadRecord(
      await execute('staff', Operation.CompleteDocumentUpload, {
        caseId,
        sessionId: started.session.id,
        objectVersionId: 'saved-object-version',
      }),
    );
  };
  const row = async (id: string) =>
    (await db.owner.query('select * from caseflow.documents where id=$1', [id])).rows[0];
  const audits = async (id: string) =>
    (
      await db.owner.query('select * from caseflow.audit_events where target_id=$1 order by id', [
        id,
      ])
    ).rows;
  const staff = userSchema.parse(await execute('staff', Operation.GetProfile));
  const colleague = userSchema.parse(await execute('colleague', Operation.GetProfile));
  const admin = userSchema.parse(await execute('admin', Operation.GetProfile));
  const superAdmin = userSchema.parse(await execute('super', Operation.GetProfile));
  await execute('stranger', Operation.GetProfile);
  await db.owner.query('select caseflow.operator_set_role($1,$2)', [admin.id, Role.Admin]);
  await db.owner.query('select caseflow.operator_set_role($1,$2)', [
    superAdmin.id,
    Role.SuperAdmin,
  ]);

  try {
    await t.test(
      'lists verified documents with consistent filters, totals, ordering and access',
      async () => {
        const record = await newCase();
        const first = await upload(record.id);
        const second = await upload(record.id);
        const removed = await upload(record.id);
        await mutate(record.id, removed.document.id, 'remove', 2);
        const pending = await start(record.id);
        await execute('staff', Operation.FailDocumentUpload, {
          caseId: record.id,
          sessionId: pending.session.id,
        });
        await start(record.id, 'colleague');
        await db.owner.query(
          'update caseflow.documents set created_at=$1 where id=any($2::uuid[])',
          [first.document.createdAt, [first.document.id, second.document.id]],
        );
        const expected = [first.document.id, second.document.id].sort().reverse();

        for (const token of ['staff', 'colleague', 'admin', 'super']) {
          const response = await call('GET', `${library(record.id)}?pageSize=1`, token);
          assert.equal(response.statusCode, 200, response.body);
          const page = documentPageSchema.parse(response.json());
          assert.equal(page.total, 2);
          assert.equal(page.page, 1);
          assert.deepEqual(
            page.items.map((item) => item.id),
            expected.slice(0, 1),
          );
          const next = documentPageSchema.parse(
            (await call('GET', `${library(record.id)}?page=2&pageSize=1`, token)).json(),
          );
          assert.deepEqual(
            next.items.map((item) => item.id),
            expected.slice(1),
          );
          const beyond = documentPageSchema.parse(
            (await call('GET', `${library(record.id)}?page=99`, token)).json(),
          );
          assert.equal(beyond.total, 2);
          assert.deepEqual(beyond.items, []);
          assert.doesNotMatch(
            response.body,
            /storage_bucket|objectVersionId|object_key|checksum|saved-object-version/,
          );
        }

        for (const token of ['staff', 'admin']) {
          const removedPage = documentPageSchema.parse(
            (await call('GET', `${library(record.id)}?filter=removed`, token)).json(),
          );
          const all = documentPageSchema.parse(
            (await call('GET', `${library(record.id)}?filter=all`, token)).json(),
          );
          assert.equal(removedPage.total, token === 'admin' ? 1 : 0);
          assert.equal(all.total, token === 'admin' ? 3 : 2);
        }

        const empty = await newCase();
        assert.equal((await call('GET', library(empty.id), 'staff')).json().total, 0);
        assert.equal((await call('GET', library(empty.id), 'stranger')).statusCode, 404);
        assert.equal((await call('GET', library(randomUUID()), 'admin')).statusCode, 404);
        await execute('admin', Operation.ArchiveCase, {
          id: record.id,
          expectedVersion: record.version,
        });
        assert.equal((await call('GET', library(record.id), 'staff')).json().total, 2);
      },
    );

    await t.test(
      'downloads require available, accessible documents and record authorization only',
      async () => {
        const record = await newCase();
        const uploaded = await upload(record.id);
        const pending = await start(record.id);

        for (const token of ['staff', 'colleague', 'admin', 'super']) {
          const response = await download(record.id, uploaded.document.id, token);
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.headers['cache-control'], 'no-store');
          assert.deepEqual(Object.keys(response.json()).sort(), ['expiresAt', 'method', 'url']);
        }
        const entries = (await audits(uploaded.document.id)).filter(
          (event) => event.action === 'document.download_authorized',
        );
        assert.equal(entries.length, 4);
        for (const event of entries) {
          assert.ok(event.actor_id);
          assert.equal(event.after_value.caseId, record.id);
          assert.equal(event.after_value.version, 2);
          assert.ok(event.after_value.expiresAt);
          assert.doesNotMatch(JSON.stringify(event), /signature|secret|https|saved-object-version/);
        }
        assert.equal((await download(record.id, uploaded.document.id, 'stranger')).statusCode, 404);
        assert.equal((await download(randomUUID(), uploaded.document.id, 'admin')).statusCode, 404);
        assert.equal((await download(record.id, randomUUID(), 'admin')).statusCode, 404);
        assert.equal(
          (await download(record.id, pending.document.id)).json().code,
          ErrorCode.DocumentUnavailable,
        );
        assert.equal((await download(record.id, pending.document.id, 'colleague')).statusCode, 404);
        await mutate(record.id, uploaded.document.id, 'remove', 2);
        assert.equal((await download(record.id, uploaded.document.id)).statusCode, 404);
        assert.equal(
          (await download(record.id, uploaded.document.id, 'admin')).json().code,
          ErrorCode.DocumentUnavailable,
        );
        await mutate(record.id, uploaded.document.id, 'restore', 3);
        await execute('admin', Operation.ArchiveCase, { id: record.id, expectedVersion: 1 });
        assert.equal((await download(record.id, uploaded.document.id)).statusCode, 200);
      },
    );

    await t.test(
      'remove/restore preserves metadata, sessions, quota and audit history; stale writes fail',
      async () => {
        const record = await newCase();
        const uploaded = await upload(record.id);
        const original = await row(uploaded.document.id);
        const originalSession = (
          await db.owner.query('select * from caseflow.document_upload_sessions where id=$1', [
            uploaded.session.id,
          ])
        ).rows[0];
        const quota = (
          await db.owner.query('select sum(size_bytes) as bytes from caseflow.documents')
        ).rows[0].bytes;
        assert.equal(
          (await mutate(record.id, uploaded.document.id, 'remove', 2, 'staff')).statusCode,
          403,
        );
        const removedResponse = await mutate(record.id, uploaded.document.id, 'remove', 2);
        assert.equal(removedResponse.statusCode, 200, removedResponse.body);
        const removed = documentSchema.parse(removedResponse.json());
        assert.equal(removed.version, 3);
        assert.equal(removed.removedBy, admin.id);
        assert.ok(removed.removedAt);
        const removedRow = await row(uploaded.document.id);
        const count = (await audits(uploaded.document.id)).length;
        assert.equal(
          (await mutate(record.id, uploaded.document.id, 'remove', 2)).json().code,
          ErrorCode.DocumentConflict,
        );
        assert.equal((await mutate(record.id, uploaded.document.id, 'remove', 3)).statusCode, 200);
        assert.deepEqual(await row(uploaded.document.id), removedRow);
        assert.equal((await audits(uploaded.document.id)).length, count);
        const restored = await mutate(record.id, uploaded.document.id, 'restore', 3, 'super');
        assert.equal(restored.statusCode, 200, restored.body);
        assert.equal(restored.json().version, 4);
        assert.equal(restored.json().removedAt, null);
        assert.equal(restored.json().removedBy, null);
        const restoredRow = await row(uploaded.document.id);
        assert.deepEqual(
          { ...restoredRow, version: original.version, updated_at: original.updated_at },
          original,
        );
        assert.equal((await mutate(record.id, uploaded.document.id, 'restore', 4)).statusCode, 200);
        assert.deepEqual(await row(uploaded.document.id), restoredRow);
        assert.deepEqual(
          (
            await db.owner.query('select * from caseflow.document_upload_sessions where id=$1', [
              uploaded.session.id,
            ])
          ).rows[0],
          originalSession,
        );
        assert.equal(
          (await db.owner.query('select sum(size_bytes) as bytes from caseflow.documents')).rows[0]
            .bytes,
          quota,
        );
        const changes = (await audits(uploaded.document.id)).filter((event) =>
          ['document.removed', 'document.restored'].includes(event.action),
        );
        assert.equal(changes.length, 2);
        assert.equal(changes[0].before_value.status, 'available');
        assert.equal(changes[1].after_value.status, 'available');
        assert.equal(changes[1].actor_id, superAdmin.id);
        const pending = await start(record.id);
        for (const action of ['remove', 'restore'] as const) {
          assert.equal(
            (await mutate(record.id, pending.document.id, action, 1)).json().code,
            ErrorCode.DocumentUnavailable,
          );
        }
        await execute('admin', Operation.ArchiveCase, { id: record.id, expectedVersion: 1 });
        for (const action of ['remove', 'restore'] as const) {
          assert.equal(
            (await mutate(record.id, uploaded.document.id, action, 4)).json().code,
            ErrorCode.CaseArchived,
          );
        }
      },
    );

    await t.test(
      'strict contracts reject forged fields, invalid pagination and malformed identifiers',
      async () => {
        const record = await newCase();
        const uploaded = await upload(record.id);
        for (const suffix of [
          '?page=0',
          '?pageSize=101',
          '?filter=pending_upload',
          '?role=admin',
          '?caseId=' + randomUUID(),
        ]) {
          assert.equal((await call('GET', library(record.id) + suffix)).statusCode, 400);
        }
        for (const action of ['download', 'remove', 'restore']) {
          const url = actionUrl(record.id, uploaded.document.id, action);
          const body = action === 'download' ? {} : { expectedVersion: 2 };
          for (const forged of [
            { role: 'super_admin' },
            { objectVersionId: 'forged' },
            { caseId: randomUUID() },
            { storageBucket: 'other' },
            { removedBy: staff.id },
          ]) {
            assert.equal(
              (await call('POST', url, 'admin', { ...body, ...forged })).statusCode,
              400,
            );
          }
          assert.equal((await call('POST', url + '?role=admin', 'admin', body)).statusCode, 400);
          const anonymous = await app.inject({ method: 'POST', url, payload: body });
          assert.equal(anonymous.statusCode, 401);
        }
        for (const version of [0, -1, 1.5, '2', null]) {
          assert.equal(
            (
              await call('POST', actionUrl(record.id, uploaded.document.id, 'remove'), 'admin', {
                expectedVersion: version,
              })
            ).statusCode,
            400,
          );
        }
        assert.equal(
          (await call('POST', actionUrl(record.id, uploaded.document.id, 'remove'))).statusCode,
          400,
        );
        assert.equal((await call('GET', library('bad-id'))).statusCode, 400);
        assert.equal((await download(record.id, 'bad-id')).statusCode, 400);
      },
    );

    await t.test(
      'storage and signing failures fail closed without auditing or leaking provider details',
      async () => {
        const record = await newCase();
        const uploaded = await upload(record.id);
        const count = (await audits(uploaded.document.id)).length;
        const url = actionUrl(record.id, uploaded.document.id, 'download');
        const response = await withoutStorage.inject({
          method: 'POST',
          url,
          headers: { authorization: 'Bearer staff' },
          payload: {},
        });
        assert.equal(response.statusCode, 503);
        signingHook = async () => {
          throw new Error('PRIVATE_PROVIDER_CREDENTIALS');
        };
        const failed = await download(record.id, uploaded.document.id);
        signingHook = undefined;
        assert.equal(failed.statusCode, 503);
        assert.doesNotMatch(failed.body, /PRIVATE|signature|secret|url/);
        for (const offset of [-1000, 120000]) {
          expiryOffset = offset;
          assert.notEqual((await download(record.id, uploaded.document.id)).statusCode, 200);
        }
        expiryOffset = 59000;
        assert.equal((await audits(uploaded.document.id)).length, count);
      },
    );

    await t.test('disabled accounts cannot list, download, remove or restore', async () => {
      const record = await newCase();
      const uploaded = await upload(record.id);
      await execute('super', Operation.UpdateAccess, { id: admin.id, active: false });
      try {
        for (const response of [
          await call('GET', library(record.id)),
          await download(record.id, uploaded.document.id, 'admin'),
          await mutate(record.id, uploaded.document.id, 'remove', 2),
          await mutate(record.id, uploaded.document.id, 'restore', 2),
        ]) {
          assert.equal(response.statusCode, 403);
          assert.equal(response.json().code, ErrorCode.AccountDisabled);
        }
      } finally {
        await execute('super', Operation.UpdateAccess, { id: admin.id, active: true });
      }
    });

    await t.test(
      'download authorization rechecks removal, restoration cycles and access changes after signing',
      async () => {
        for (const change of ['remove', 'cycle', 'unassign', 'disable', 'demote', 'archive']) {
          const record = await newCase();
          const uploaded = await upload(record.id);
          const token = change === 'demote' ? 'admin' : 'staff';
          const before = (await audits(uploaded.document.id)).filter(
            (event) => event.action === 'document.download_authorized',
          ).length;
          signingHook = async () => {
            if (change === 'remove' || change === 'cycle') {
              assert.equal(
                (await mutate(record.id, uploaded.document.id, 'remove', 2)).statusCode,
                200,
              );
              if (change === 'cycle') {
                assert.equal(
                  (await mutate(record.id, uploaded.document.id, 'restore', 3)).statusCode,
                  200,
                );
              }
            } else if (change === 'unassign') {
              await execute('admin', Operation.UnassignCase, { id: record.id, userId: staff.id });
            } else if (change === 'disable') {
              await execute('admin', Operation.UpdateAccess, { id: staff.id, active: false });
            } else if (change === 'demote') {
              await execute('super', Operation.UpdateRole, { id: admin.id, role: Role.Staff });
            } else {
              await execute('admin', Operation.ArchiveCase, { id: record.id, expectedVersion: 1 });
            }
          };
          try {
            const response = await download(record.id, uploaded.document.id, token);
            if (change === 'archive') {
              assert.equal(response.statusCode, 200, response.body);
            } else {
              assert.equal(
                response.statusCode,
                change === 'disable' ? 403 : change === 'cycle' ? 409 : 404,
                response.body,
              );
              assert.doesNotMatch(response.body, /signature|secret|https/);
            }
            assert.equal(
              (await audits(uploaded.document.id)).filter(
                (event) => event.action === 'document.download_authorized',
              ).length,
              before + (change === 'archive' ? 1 : 0),
            );
          } finally {
            signingHook = undefined;
            await db.owner.query('update caseflow.users set active=true where id=$1', [staff.id]);
            await db.owner.query('select caseflow.operator_set_role($1,$2)', [
              admin.id,
              Role.Admin,
            ]);
          }
        }
        assert.ok(signingCalls > 0);
      },
    );

    await t.test('concurrent remove and restore requests enforce document versions', async () => {
      const record = await newCase();
      const uploaded = await upload(record.id);
      for (const [action, version] of [
        ['remove', 2],
        ['restore', 3],
      ] as const) {
        const results = await Promise.all([
          mutate(record.id, uploaded.document.id, action, version),
          mutate(record.id, uploaded.document.id, action, version),
        ]);
        assert.deepEqual(results.map((response) => response.statusCode).sort(), [200, 409]);
      }
      assert.equal((await row(uploaded.document.id)).version, 4);
    });

    await t.test(
      'mutations recheck demotion, disablement and case archival after waiting on the permission lock',
      async () => {
        for (const action of ['remove', 'restore'] as const) {
          for (const change of ['demote', 'disable', 'archive']) {
            const record = await newCase();
            const uploaded = await upload(record.id);
            if (action === 'restore') {
              await mutate(record.id, uploaded.document.id, 'remove', 2);
            }
            const previous = await row(uploaded.document.id);
            const blocker = await db.owner.connect();
            let pending: ReturnType<typeof mutate> | undefined;
            try {
              await blocker.query('begin');
              await blocker.query('select pg_advisory_xact_lock(734921, 1)');
              pending = mutate(record.id, uploaded.document.id, action, previous.version);
              await waitForPermissionLock(db.owner);
              if (change === 'demote') {
                await blocker.query("update caseflow.users set role='staff' where id=$1", [
                  admin.id,
                ]);
              } else if (change === 'disable') {
                await blocker.query('update caseflow.users set active=false where id=$1', [
                  admin.id,
                ]);
              } else {
                await blocker.query(
                  'update caseflow.cases set archived_at=clock_timestamp(), archived_by=$2 where id=$1',
                  [record.id, superAdmin.id],
                );
              }
              await blocker.query('commit');
              const response = await pending;
              assert.equal(response.statusCode, change === 'archive' ? 409 : 403, response.body);
              assert.deepEqual(await row(uploaded.document.id), previous);
            } finally {
              await blocker.query('rollback');
              blocker.release();
              await pending;
              await db.owner.query(
                "update caseflow.users set role='admin', active=true where id=$1",
                [admin.id],
              );
            }
          }
        }
      },
    );

    await t.test(
      'audit failure rolls back mutations and prevents download links from escaping',
      async () => {
        const record = await newCase();
        const uploaded = await upload(record.id);
        const removed = await upload(record.id);
        await mutate(record.id, removed.document.id, 'remove', 2);
        const snapshots = [await row(uploaded.document.id), await row(removed.document.id)];
        const counts = [
          (await audits(uploaded.document.id)).length,
          (await audits(removed.document.id)).length,
        ];
        await db.owner
          .query(`create function caseflow.reject_document_library_audit() returns trigger language plpgsql as $$
        begin if new.action in ('document.removed','document.restored','document.download_authorized') then raise exception 'test audit failure'; end if; return new; end $$;
        create trigger reject_document_library_audit before insert on caseflow.audit_events for each row execute function caseflow.reject_document_library_audit()`);
        try {
          const responses = [
            await mutate(record.id, uploaded.document.id, 'remove', 2),
            await mutate(record.id, removed.document.id, 'restore', 3),
            await download(record.id, uploaded.document.id),
          ];
          for (const response of responses) {
            assert.equal(response.statusCode, 503, response.body);
            assert.doesNotMatch(response.body, /signature|secret|https/);
          }
          assert.deepEqual(
            [await row(uploaded.document.id), await row(removed.document.id)],
            snapshots,
          );
          assert.deepEqual(
            [
              (await audits(uploaded.document.id)).length,
              (await audits(removed.document.id)).length,
            ],
            counts,
          );
        } finally {
          await db.owner.query(
            'drop trigger reject_document_library_audit on caseflow.audit_events; drop function caseflow.reject_document_library_audit()',
          );
        }
      },
    );

    await t.test(
      'completed upload retries respect removal visibility and never restore the document',
      async () => {
        const record = await newCase();
        const request = {
          requestId: randomUUID(),
          filename: 'Retry.pdf',
          contentType: 'application/pdf',
          sizeBytes: 7,
          checksumSha256: checksum,
        };
        const startUrl = `/cases/${record.id}/document-uploads`;
        const started = documentUploadAuthorizationSchema.parse(
          (await call('POST', startUrl, 'staff', request)).json(),
        );
        const completeUrl = `${startUrl}/${started.session.id}/complete`;
        assert.equal((await call('POST', completeUrl, 'staff')).statusCode, 200);
        await mutate(record.id, started.document.id, 'remove', 2);
        assert.equal((await call('POST', startUrl, 'staff', request)).statusCode, 404);
        assert.equal((await call('POST', completeUrl, 'staff')).statusCode, 404);
        const adminRetry = await call('POST', completeUrl, 'admin');
        assert.equal(adminRetry.statusCode, 200, adminRetry.body);
        assert.equal(
          documentUploadResultSchema.parse(adminRetry.json()).document.status,
          'removed',
        );
        assert.equal((await row(started.document.id)).status, 'removed');
        await mutate(record.id, started.document.id, 'restore', 3);
        const count = (await audits(started.document.id)).length;
        const retry = await call('POST', completeUrl, 'staff');
        assert.equal(retry.statusCode, 200, retry.body);
        assert.equal(documentUploadResultSchema.parse(retry.json()).document.version, 4);
        assert.equal((await audits(started.document.id)).length, count);
      },
    );

    await t.test(
      'runtime credentials cannot bypass authorization or mutate document tables directly',
      async () => {
        const record = await newCase();
        const uploaded = await upload(record.id);
        const asRuntime = async (subject: string, sql: string, params: unknown[] = []) => {
          const client = await db.runtime.connect();
          try {
            await client.query('begin');
            await client.query(
              "select set_config('caseflow.tenant_id',$1,true), set_config('caseflow.subject',$2,true)",
              [tenantId, subject],
            );
            return await client.query(sql, params);
          } finally {
            await client.query('rollback');
            client.release();
          }
        };
        for (const sql of [
          "update caseflow.documents set status='removed'",
          'delete from caseflow.documents',
          'delete from caseflow.document_upload_sessions',
          `select caseflow.require_document('${record.id}','${uploaded.document.id}')`,
        ]) {
          await assert.rejects(asRuntime('admin', sql), { code: '42501' });
        }
        await assert.rejects(
          asRuntime('staff', 'select caseflow.set_document_removed($1,$2,2,true)', [
            record.id,
            uploaded.document.id,
          ]),
          /FORBIDDEN/,
        );
        await assert.rejects(
          asRuntime(
            'stranger',
            "select caseflow.authorize_document_download($1,$2,2,clock_timestamp()+interval '30 seconds')",
            [record.id, uploaded.document.id],
          ),
          /NOT_FOUND/,
        );
        await assert.rejects(
          asRuntime(
            'unknown',
            "select caseflow.authorize_document_download($1,$2,2,clock_timestamp()+interval '30 seconds')",
            [record.id, uploaded.document.id],
          ),
          /UNAUTHENTICATED/,
        );
        for (const params of [
          [null, true],
          [0, true],
          [2, null],
        ]) {
          await assert.rejects(
            asRuntime('admin', 'select caseflow.set_document_removed($1,$2,$3,$4)', [
              record.id,
              uploaded.document.id,
              ...params,
            ]),
            /INVALID_INPUT/,
          );
        }
        await mutate(record.id, uploaded.document.id, 'remove', 2);
        assert.equal(
          (
            await asRuntime('staff', 'select id from caseflow.documents where id=$1', [
              uploaded.document.id,
            ])
          ).rowCount,
          0,
        );
      },
    );
  } finally {
    await app.close();
    await withoutStorage.close();
    await db.close();
  }
});

test('document library migration preserves existing data, policies and indexes with explicit grants', async () => {
  const userId = randomUUID();
  const caseId = randomUUID();
  const documentId = randomUUID();
  let before: unknown;
  const snapshotSql = `select jsonb_build_object(
    'user', (select to_jsonb(u) from caseflow.users u where id=$1),
    'case', (select to_jsonb(c) from caseflow.cases c where id=$2),
    'document', (select to_jsonb(d) from caseflow.documents d where id=$3),
    'sessions', (select jsonb_agg(to_jsonb(s) order by id) from caseflow.document_upload_sessions s where document_id=$3),
    'assignments', (select jsonb_agg(to_jsonb(a) order by user_id) from caseflow.assignments a where case_id=$2),
    'audit', (select jsonb_agg(to_jsonb(e) - 'service_name' order by id) from caseflow.audit_events e where target_id=$3),
    'policies', (select jsonb_agg(to_jsonb(p) order by tablename,policyname) from pg_policies p where schemaname='caseflow' and tablename in ('users','cases','assignments','audit_events','documents','document_upload_sessions')),
    'indexes', (select jsonb_agg(to_jsonb(i) order by indexname) from pg_indexes i where schemaname='caseflow' and tablename in ('users','cases','assignments','audit_events','documents','document_upload_sessions'))
  ) as snapshot`;
  const db = await createTestDatabase(async (owner) => {
    await owner.query(
      "insert into caseflow.users(id,tenant_id,subject,display_name) values($1,$2,'legacy-library','Fictional User')",
      [userId, randomUUID()],
    );
    await owner.query(
      "insert into caseflow.cases(id,title,client_name) values($1,'Fictional legacy case','Fictional Client')",
      [caseId],
    );
    await owner.query('insert into caseflow.assignments(case_id,user_id) values($1,$2)', [
      caseId,
      userId,
    ]);
    await owner.query(
      `insert into caseflow.documents(id,case_id,uploaded_by,filename,content_type,size_bytes,storage_bucket,storage_environment,status,uploaded_at,object_version_id)
      values($1,$2,$3,'legacy.pdf','application/pdf',100,'caseflow-test-documents','dev','available',now(),'legacy-version')`,
      [documentId, caseId, userId],
    );
    await owner.query(
      "insert into caseflow.document_upload_sessions(document_id,status,expires_at,finished_at) values($1,'completed',now()+interval '5 minutes',now())",
      [documentId],
    );
    await owner.query(
      "insert into caseflow.audit_events(actor_id,target_id,action,after_value) values($1,$2,'document.uploaded','{}')",
      [userId, documentId],
    );
    before = (await owner.query(snapshotSql, [userId, caseId, documentId])).rows[0].snapshot;
  }, 'document_upload_workflow.sql');

  try {
    assert.deepEqual(
      (await db.owner.query(snapshotSql, [userId, caseId, documentId])).rows[0].snapshot,
      before,
    );
    await db.owner.query(db.seed);
    await db.owner.query(db.seed);
    assert.deepEqual(
      (await db.owner.query(snapshotSql, [userId, caseId, documentId])).rows[0].snapshot,
      before,
    );
    assert.equal(
      (await db.owner.query('select count(*)::int n from caseflow.documents')).rows[0].n,
      1,
    );
    const grants = await db.owner.query(`select p.proname, p.prosecdef, p.proconfig,
      has_function_privilege('caseflow_runtime', p.oid, 'execute') as runtime,
      exists(select 1 from pg_roles r where r.rolname in ('anon','authenticated','service_role') and has_function_privilege(r.oid,p.oid,'execute')) as exposed
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='caseflow'
      and p.proname in ('require_document','authorize_document_download','set_document_removed')`);
    assert.equal(grants.rows.length, 3);
    for (const fn of grants.rows) {
      assert.equal(fn.prosecdef, true);
      assert.deepEqual(fn.proconfig, ['search_path=""']);
      assert.equal(fn.runtime, fn.proname !== 'require_document');
      assert.equal(fn.exposed, false);
    }
  } finally {
    await db.close();
  }
});
