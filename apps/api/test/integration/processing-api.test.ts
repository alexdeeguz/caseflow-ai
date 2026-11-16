import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createRemoteJWKSet,
  customFetch,
  jwksCache,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from 'jose';
import {
  ErrorCode,
  Role,
  caseSchema,
  userSchema,
  processingSummarySchema,
  documentPageSchema,
} from '@caseflow/schemas';
import { buildApp } from '../../src/app.js';
import { createTokenVerifier } from '../../src/auth.js';
import { Operation } from '../../src/database/operations.js';
import { createTestDatabase, waitForPermissionLock } from './database-fixture.js';

const checksum = createHash('sha256').update('fictional processing API fixture').digest('base64');
const privateFields =
  /sourceBucket|sourceKey|sourceVersion|checksum|artifactSet|artifacts|storageBucket|leaseToken|leaseExpires|textractJob|ocrRequest|saved-source|private-provider/;

test('processing API: signed requests, safe summaries and serialized start/retry actions', async (t) => {
  const db = await createTestDatabase();
  const tenantId = randomUUID();
  const config = {
    clientId: randomUUID(),
    webClientId: randomUUID(),
    webOrigin: 'http://localhost:3000',
    databaseUrl: db.runtimeUrl,
  };
  const keys = await generateKeyPair('RS256');
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: 'processing-test',
    alg: 'RS256',
    use: 'sig',
    issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
  };
  const verify = createTokenVerifier(
    config,
    createRemoteJWKSet(new URL('https://example.invalid/keys'), {
      [jwksCache]: { uat: Date.now(), jwks: { keys: [jwk] } },
      [customFetch]: async () => {
        throw new Error('Tests must not fetch real signing keys');
      },
    }),
  );
  const app = await buildApp(config, verify, false, {
    execute: db.store.execute,
    close: async () => {},
  });
  const execute = (subject: string, operation: Operation, input: Record<string, unknown> = {}) =>
    db.store.execute({ tenantId, subject, name: subject }, operation, input);
  const sign = (subject: string, overrides: JWTPayload = {}) =>
    new SignJWT({
      tid: tenantId,
      sub: subject,
      name: subject,
      ver: '2.0',
      scp: 'access_as_user',
      azp: config.webClientId,
      iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      aud: config.clientId,
      iat: Math.floor(Date.now() / 1000),
      nbf: Math.floor(Date.now() / 1000) - 5,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'processing-test' })
      .sign(keys.privateKey);
  const tokens = new Map<string, string>();
  const call = async (
    method: 'GET' | 'POST',
    url: string,
    subject = 'admin',
    payload: unknown = { expectedJobId: null },
  ) =>
    app.inject({
      method,
      url,
      headers: tokens.has(subject) ? { authorization: `Bearer ${tokens.get(subject)}` } : {},
      ...(method === 'POST'
        ? {
            payload: JSON.stringify(payload),
            headers: {
              ...(tokens.has(subject) ? { authorization: `Bearer ${tokens.get(subject)}` } : {}),
              'content-type': 'application/json',
            },
          }
        : {}),
    });
  const path = (fixture: { caseId: string; documentId: string }) =>
    `/cases/${fixture.caseId}/documents/${fixture.documentId}/processing`;
  const read = (fixture: { caseId: string; documentId: string }, subject = 'staff') =>
    call('GET', path(fixture), subject);
  const request = (
    fixture: { caseId: string; documentId: string },
    expectedJobId: string | null = null,
    subject = 'admin',
  ) => call('POST', path(fixture), subject, { expectedJobId });
  const asUser = async (subject: string, sql: string, params: unknown[] = []) => {
    const client = await db.runtime.connect();
    try {
      await client.query('begin');
      await client.query(
        "select set_config('caseflow.tenant_id',$1,true), set_config('caseflow.subject',$2,true)",
        [tenantId, subject],
      );
      return (await client.query(sql, params)).rows;
    } finally {
      await client.query('rollback');
      client.release();
    }
  };
  const staff = userSchema.parse(await execute('staff', Operation.GetProfile));
  const admin = userSchema.parse(await execute('admin', Operation.GetProfile));
  const superAdmin = userSchema.parse(await execute('super', Operation.GetProfile));
  await execute('outsider', Operation.GetProfile);
  await db.owner.query('select caseflow.operator_set_role($1,$2)', [
    superAdmin.id,
    Role.SuperAdmin,
  ]);
  await db.owner.query('select caseflow.operator_set_role($1,$2)', [admin.id, Role.Admin]);
  for (const subject of ['staff', 'admin', 'super', 'outsider', 'unprovisioned']) {
    tokens.set(subject, await sign(subject));
  }
  tokens.set('expired', await sign('admin', { exp: 1 }));
  tokens.set('wrong-audience', await sign('admin', { aud: randomUUID() }));
  tokens.set('no-scope', await sign('admin', { scp: 'unrelated' }));

  const newDocument = async (caseId?: string, pending = false) => {
    if (!caseId) {
      const record = caseSchema.parse(
        await execute('admin', Operation.CreateCase, {
          title: 'Processing API fixture',
          clientName: 'Fictional Client',
        }),
      );
      caseId = record.id;
      await execute('admin', Operation.AssignCase, { id: caseId, userId: staff.id });
    }
    // Existing uploads without a job are a supported upgrade path.
    const document = (
      await db.owner.query(
        `insert into caseflow.documents(case_id,uploaded_by,filename,content_type,size_bytes,
      storage_bucket,storage_environment,status,uploaded_at,object_version_id,checksum_sha256,upload_request_id)
      values($1,$2,'fictional.pdf','application/pdf',20,'caseflow-test-documents','dev',$3,
        case when $3='available' then now() end, case when $3='available' then 'saved-source' end,$4,gen_random_uuid()) returning id`,
        [caseId, staff.id, pending ? 'pending_upload' : 'available', checksum],
      )
    ).rows[0];
    return { caseId, documentId: document.id as string };
  };
  const start = async (fixture: { caseId: string; documentId: string }) => {
    const response = await request(fixture);
    assert.equal(response.statusCode, 200, response.body);
    return processingSummarySchema.parse(response.json()).job!.id;
  };
  const claim = async (jobId: string) =>
    (await db.owner.query('select caseflow.claim_document_processing($1) claim', [jobId])).rows[0]
      .claim;
  const fail = async (jobId: string) => {
    const claimed = await claim(jobId);
    await db.owner.query("select caseflow.fail_document_processing($1,$2,'invalid_document')", [
      jobId,
      claimed.leaseToken,
    ]);
  };
  const complete = async (jobId: string, method: 'native' | 'ocr') => {
    let claimed = await claim(jobId);
    if (method === 'ocr') {
      await db.owner.query('select caseflow.prepare_document_ocr($1,$2,2,$3,$4)', [
        jobId,
        claimed.leaseToken,
        'arn:aws:sns:us-east-2:123456789012:AmazonTextract-caseflow-completion',
        'arn:aws:iam::123456789012:role/CaseFlowTextractNotifications',
      ]);
      await db.owner.query('select caseflow.bind_document_textract_job($1,$2,$3)', [
        jobId,
        claimed.leaseToken,
        `private-provider-${jobId}`,
      ]);
      claimed = (
        await db.owner.query('select caseflow.claim_document_collection($1,$2) claim', [
          jobId,
          `private-provider-${jobId}`,
        ])
      ).rows[0].claim;
    }
    const artifact = { versionId: 'private-artifact', checksumSha256: checksum, sizeBytes: 100 };
    const artifacts = {
      manifest: artifact,
      text: artifact,
      ...(method === 'ocr' ? { ocr: artifact } : {}),
    };
    assert.equal(
      (
        await db.owner.query(
          'select caseflow.complete_document_processing($1,$2,$3,2,$4,$5) completed',
          [jobId, claimed.leaseToken, method, randomUUID(), artifacts],
        )
      ).rows[0].completed,
      true,
    );
  };
  const countJobs = async (documentId: string) =>
    (
      await db.owner.query(
        'select count(*)::int n from caseflow.document_processing_jobs where document_id=$1',
        [documentId],
      )
    ).rows[0].n;

  try {
    await t.test(
      'returns not_processed then queued; duplicate starts create one audited dispatch',
      async () => {
        const fixture = await newDocument();
        const before = await read(fixture);
        assert.equal(before.statusCode, 200, before.body);
        assert.deepEqual(before.json(), { status: 'not_processed', job: null, result: null });
        assert.equal(before.headers['cache-control'], 'no-store');
        const responses = await Promise.all([request(fixture), request(fixture, null, 'super')]);
        for (const response of responses) {
          assert.equal(response.statusCode, 200, response.body);
        }
        const first = processingSummarySchema.parse(responses[0]!.json());
        assert.equal(first.status, 'queued');
        assert.deepEqual(responses[1]!.json(), first);
        assert.equal(await countJobs(fixture.documentId), 1);
        assert.equal(
          (
            await db.owner.query(
              'select count(*)::int n from caseflow.processing_dispatches where job_id=$1',
              [first.job!.id],
            )
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await db.owner.query(
              "select count(*)::int n from caseflow.audit_events where target_id=$1 and action='document.processing_queued'",
              [fixture.documentId],
            )
          ).rows[0].n,
          1,
        );
        assert.deepEqual((await read(fixture)).json(), first);
        assert.doesNotMatch(responses[0]!.body, privateFields);
      },
    );

    await t.test(
      'native and OCR results expose only the safe summary; Ready cannot be reprocessed',
      async () => {
        for (const method of ['native', 'ocr'] as const) {
          const fixture = await newDocument();
          const jobId = await start(fixture);
          await complete(jobId, method);
          for (const subject of ['staff', 'admin', 'super']) {
            const response = await read(fixture, subject);
            assert.equal(response.statusCode, 200, response.body);
            const summary = processingSummarySchema.parse(response.json());
            assert.equal(summary.status, 'ready');
            assert.deepEqual(summary.result, {
              extractionMethod: method,
              pageCount: 2,
              pipelineVersion: '1',
            });
            assert.doesNotMatch(response.body, privateFields);
            const page = documentPageSchema.parse(
              (await call('GET', `/cases/${fixture.caseId}/documents`, subject)).json(),
            );
            assert.deepEqual(page.items[0]!.processing, summary);
          }
          assert.equal((await request(fixture, jobId)).json().code, ErrorCode.ProcessingConflict);
          assert.equal((await request(fixture)).json().job.id, jobId);
          assert.equal(await countJobs(fixture.documentId), 1);
        }
      },
    );

    await t.test(
      'concurrent retries coalesce, report the latest state, and reject stale expectations',
      async () => {
        const fixture = await newDocument();
        const firstId = await start(fixture);
        await fail(firstId);
        assert.equal((await read(fixture)).json().job.failureCode, 'invalid_document');
        const responses = await Promise.all([
          request(fixture, firstId),
          request(fixture, firstId, 'super'),
        ]);
        for (const response of responses) {
          assert.equal(response.statusCode, 200, response.body);
        }
        const nextId = responses[0]!.json().job.id;
        assert.notEqual(nextId, firstId);
        assert.equal(responses[1]!.json().job.id, nextId);
        assert.equal(await countJobs(fixture.documentId), 2);
        assert.equal((await read(fixture)).json().job.id, nextId);
        for (const stale of [null, randomUUID(), nextId]) {
          assert.equal((await request(fixture, stale)).json().code, ErrorCode.ProcessingConflict);
        }
        await execute('admin', Operation.RemoveDocument, { ...fixture, expectedVersion: 1 });
        assert.equal((await read(fixture, 'admin')).json().status, 'cancelled');
        await execute('admin', Operation.RestoreDocument, { ...fixture, expectedVersion: 2 });
        assert.equal((await request(fixture, nextId)).json().status, 'queued');
        assert.equal(await countJobs(fixture.documentId), 3);
      },
    );

    await t.test(
      'enforces signed tokens, strict inputs, case boundaries and disabled accounts',
      async () => {
        const fixture = await newDocument();
        const other = await newDocument();
        for (const method of ['GET', 'POST'] as const) {
          for (const subject of ['missing', 'expired', 'wrong-audience', 'unprovisioned']) {
            assert.equal((await call(method, path(fixture), subject)).statusCode, 401);
          }
          assert.equal((await call(method, path(fixture), 'no-scope')).statusCode, 403);
          assert.equal((await call(method, path(fixture) + '?role=admin')).statusCode, 400);
          assert.equal(
            (await call(method, path({ ...fixture, documentId: 'invalid' }))).statusCode,
            400,
          );
          assert.equal(
            (await call(method, path({ ...fixture, caseId: other.caseId }))).statusCode,
            404,
          );
          assert.equal(
            (await call(method, path({ ...fixture, documentId: randomUUID() }))).statusCode,
            404,
          );
        }
        assert.equal((await read(fixture, 'outsider')).statusCode, 404);
        assert.equal((await request(fixture, null, 'staff')).statusCode, 403);
        for (const payload of [
          {},
          null,
          [],
          { expectedJobId: 'invalid' },
          ...['caseId', 'documentId', 'role', 'sourceKey', 'status', 'requestedBy'].map((key) => ({
            expectedJobId: null,
            [key]: randomUUID(),
          })),
        ]) {
          assert.equal((await call('POST', path(fixture), 'admin', payload)).statusCode, 400);
        }
        await execute('super', Operation.UpdateAccess, { id: admin.id, active: false });
        for (const method of ['GET', 'POST'] as const) {
          assert.equal((await call(method, path(fixture))).json().code, ErrorCode.AccountDisabled);
        }
        await execute('super', Operation.UpdateAccess, { id: admin.id, active: true });
        await execute('admin', Operation.UnassignCase, { id: fixture.caseId, userId: staff.id });
        assert.equal((await read(fixture)).statusCode, 404);
        assert.equal(await countJobs(fixture.documentId), 0);
      },
    );

    await t.test(
      'archived cases remain readable; removed documents stay admin-only; neither can start',
      async () => {
        const fixture = await newDocument();
        const jobId = await start(fixture);
        await complete(jobId, 'native');
        await execute('admin', Operation.RemoveDocument, { ...fixture, expectedVersion: 1 });
        assert.equal((await read(fixture)).statusCode, 404);
        for (const subject of ['admin', 'super']) {
          assert.equal((await read(fixture, subject)).json().status, 'ready');
          assert.equal(
            (await request(fixture, jobId, subject)).json().code,
            ErrorCode.DocumentUnavailable,
          );
        }
        await execute('admin', Operation.RestoreDocument, { ...fixture, expectedVersion: 2 });
        await execute('admin', Operation.ArchiveCase, { id: fixture.caseId, expectedVersion: 1 });
        assert.equal((await read(fixture)).json().status, 'ready');
        assert.equal((await request(fixture)).json().code, ErrorCode.CaseArchived);
        const pending = await newDocument(undefined, true);
        assert.equal((await read(pending)).json().code, ErrorCode.DocumentUnavailable);
        assert.equal((await request(pending)).json().code, ErrorCode.DocumentUnavailable);
        assert.equal((await read(pending, 'outsider')).statusCode, 404);
      },
    );

    await t.test(
      'listing preserves filters, totals and stable pagination while enriching the page',
      async () => {
        const first = await newDocument();
        const second = await newDocument(first.caseId);
        const removed = await newDocument(first.caseId);
        const pending = await newDocument(first.caseId, true);
        await start(second);
        await start(removed);
        await execute('admin', Operation.RemoveDocument, { ...removed, expectedVersion: 1 });
        await db.owner.query(
          "update caseflow.documents set created_at='2026-01-01T00:00:00Z' where case_id=$1",
          [first.caseId],
        );
        const ids = [first.documentId, second.documentId].sort().reverse();
        for (const subject of ['staff', 'admin', 'super']) {
          for (const filter of ['current', 'removed', 'all']) {
            const response = await call(
              'GET',
              `/cases/${first.caseId}/documents?filter=${filter}&pageSize=1`,
              subject,
            );
            assert.equal(response.statusCode, 200, response.body);
            assert.doesNotMatch(response.body, privateFields);
            const page = documentPageSchema.parse(response.json());
            const visibleRemoved = subject !== 'staff';
            assert.equal(
              page.total,
              filter === 'current'
                ? 2
                : filter === 'removed'
                  ? Number(visibleRemoved)
                  : 2 + Number(visibleRemoved),
            );
            assert.ok(page.items.every((item) => item.id !== pending.documentId));
            if (filter === 'current') {
              assert.equal(page.items[0]!.id, ids[0]);
              const next = documentPageSchema.parse(
                (
                  await call('GET', `/cases/${first.caseId}/documents?page=2&pageSize=1`, subject)
                ).json(),
              );
              assert.equal(next.items[0]!.id, ids[1]);
              const unprocessed = [...page.items, ...next.items].find(
                (item) => item.id === first.documentId,
              )!;
              assert.deepEqual(unprocessed.processing, {
                status: 'not_processed',
                job: null,
                result: null,
              });
            }
          }
        }
        assert.equal(
          (await call('GET', `/cases/${first.caseId}/documents`, 'outsider')).statusCode,
          404,
        );
        const beyond = documentPageSchema.parse(
          (await call('GET', `/cases/${first.caseId}/documents?page=99`)).json(),
        );
        assert.equal(beyond.total, 2);
        assert.deepEqual(beyond.items, []);
      },
    );

    await t.test(
      'runtime can read only visible result summary columns and cannot write worker data',
      async () => {
        const fixture = await newDocument();
        const id = await start(fixture);
        await complete(id, 'native');
        const query =
          'select job_id, extraction_method, page_count, pipeline_version from caseflow.document_processing_results where job_id=$1';
        assert.equal((await asUser('staff', query, [id])).length, 1);
        assert.equal((await asUser('outsider', query, [id])).length, 0);
        for (const sql of [
          'select * from caseflow.document_processing_results',
          'select artifacts from caseflow.document_processing_results',
          'select storage_bucket from caseflow.document_processing_results',
          'select artifact_set_id from caseflow.document_processing_results',
          'select source_key from caseflow.document_processing_jobs',
          'select textract_job_id from caseflow.document_processing_jobs',
          'select lease_token from caseflow.document_processing_jobs',
          'update caseflow.document_processing_results set page_count=1',
          'delete from caseflow.document_processing_jobs',
        ]) {
          await assert.rejects(asUser('admin', sql), /permission denied/);
        }
        await execute('admin', Operation.RemoveDocument, { ...fixture, expectedVersion: 1 });
        assert.equal((await asUser('staff', query, [id])).length, 0);
        assert.equal((await asUser('admin', query, [id])).length, 1);
        await execute('super', Operation.UpdateAccess, { id: admin.id, active: false });
        assert.equal((await asUser('admin', query, [id])).length, 0);
        await execute('super', Operation.UpdateAccess, { id: admin.id, active: true });
        for (const role of [
          'anon',
          'authenticated',
          'service_role',
          'caseflow_dispatcher',
          'caseflow_processor',
        ]) {
          assert.equal(
            (
              await db.owner.query(
                "select has_any_column_privilege($1,'caseflow.document_processing_results','SELECT') allowed",
                [role],
              )
            ).rows[0].allowed,
            false,
          );
        }
      },
    );

    await t.test(
      'administrative writes recheck demotion, disabling and case archival under the lock',
      async () => {
        for (const change of ['demote', 'disable', 'archive'] as const) {
          const fixture = await newDocument();
          const blocker = await db.owner.connect();
          try {
            await blocker.query('begin');
            await blocker.query('select pg_advisory_xact_lock(734921,1)');
            const waiting = request(fixture);
            await waitForPermissionLock(db.owner);
            if (change === 'demote') {
              await blocker.query("update caseflow.users set role='staff' where id=$1", [admin.id]);
            }
            if (change === 'disable') {
              await blocker.query('update caseflow.users set active=false where id=$1', [admin.id]);
            }
            if (change === 'archive') {
              await blocker.query(
                'update caseflow.cases set archived_at=clock_timestamp(),archived_by=$2,version=version+1,updated_at=clock_timestamp() where id=$1',
                [fixture.caseId, admin.id],
              );
            }
            await blocker.query('commit');
            const response = await waiting;
            assert.equal(
              response.json().code,
              change === 'demote'
                ? ErrorCode.Forbidden
                : change === 'disable'
                  ? ErrorCode.AccountDisabled
                  : ErrorCode.CaseArchived,
              response.body,
            );
            assert.equal(await countJobs(fixture.documentId), 0);
          } finally {
            await blocker.query('rollback');
            blocker.release();
            await db.owner.query("update caseflow.users set role='admin',active=true where id=$1", [
              admin.id,
            ]);
          }
        }
      },
    );

    await t.test(
      'missing durable results fail closed instead of reporting an incomplete Ready result',
      async () => {
        const fixture = await newDocument();
        const id = await start(fixture);
        // Model corruption of a legacy result created before automatic extraction.
        // Legacy results predate automatic fact extraction and search indexing.
        const triggers = ['queue_facts_after_processing', 'queue_search_after_processing'];
        for (const trigger of triggers) {
          await db.owner.query(
            `alter table caseflow.document_processing_jobs disable trigger ${trigger}`,
          );
        }
        try {
          await complete(id, 'native');
        } finally {
          for (const trigger of triggers) {
            await db.owner.query(
              `alter table caseflow.document_processing_jobs enable trigger ${trigger}`,
            );
          }
        }
        await db.owner.query('delete from caseflow.document_processing_results where job_id=$1', [
          id,
        ]);
        for (const url of [path(fixture), `/cases/${fixture.caseId}/documents`]) {
          const response = await call('GET', url, 'staff');
          assert.equal(response.statusCode, 503, response.body);
          assert.equal(response.json().code, ErrorCode.ServiceUnavailable);
          assert.doesNotMatch(response.body, privateFields);
        }
      },
    );

    await t.test(
      'audit failures roll back job/dispatch creation and return a safe error',
      async () => {
        const fixture = await newDocument();
        await db.owner
          .query(`create function caseflow.reject_api_audit() returns trigger language plpgsql as $$ begin raise exception 'private-provider-error'; end $$;
        create trigger reject_api_audit before insert on caseflow.audit_events for each row execute function caseflow.reject_api_audit()`);
        try {
          const response = await request(fixture);
          assert.equal(response.statusCode, 503, response.body);
          assert.doesNotMatch(response.body, /private-provider-error/);
          assert.equal(await countJobs(fixture.documentId), 0);
        } finally {
          await db.owner.query(
            'drop trigger reject_api_audit on caseflow.audit_events; drop function caseflow.reject_api_audit()',
          );
        }
        assert.equal((await request(fixture)).statusCode, 200);
      },
    );
  } finally {
    await app.close();
    await db.close();
  }
});
