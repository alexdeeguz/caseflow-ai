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
} from 'jose';
import {
  Role,
  userSchema,
  caseSchema,
  factExtractionSummarySchema,
  factPageSchema,
  documentPageSchema,
} from '@caseflow/schemas';
import { buildApp } from '../../src/app.js';
import { createTokenVerifier } from '../../src/auth.js';
import { Operation } from '../../src/database/operations.js';
import { createTestDatabase, waitForPermissionLock } from './database-fixture.js';

test('fact extraction API permissions, lifecycle, evidence, and atomic requests', async (t) => {
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
    kid: 'facts',
    alg: 'RS256',
    use: 'sig',
    issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
  };
  const verify = createTokenVerifier(
    config,
    createRemoteJWKSet(new URL('https://example.invalid/keys'), {
      [jwksCache]: { uat: Date.now(), jwks: { keys: [jwk] } },
      [customFetch]: async () => {
        throw new Error('No network in tests');
      },
    }),
  );
  const app = await buildApp(config, verify, false, {
    execute: db.store.execute,
    close: async () => {},
  });
  const execute = (subject: string, operation: Operation, input: Record<string, unknown> = {}) =>
    db.store.execute({ tenantId, subject, name: subject }, operation, input);
  const tokens = new Map<string, string>();
  const users = new Map<string, string>();
  for (const subject of ['super', 'admin', 'staff', 'outsider']) {
    users.set(subject, userSchema.parse(await execute(subject, Operation.GetProfile)).id);
    tokens.set(
      subject,
      await new SignJWT({
        tid: tenantId,
        sub: subject,
        name: subject,
        ver: '2.0',
        scp: 'access_as_user',
        azp: config.webClientId,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'facts' })
        .setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
        .setAudience(config.clientId)
        .setIssuedAt()
        .setNotBefore(0)
        .setExpirationTime('1h')
        .sign(keys.privateKey),
    );
  }
  await db.owner.query('select caseflow.operator_set_role($1,$2)', [
    users.get('super'),
    Role.SuperAdmin,
  ]);
  await db.owner.query('select caseflow.operator_set_role($1,$2)', [
    users.get('admin'),
    Role.Admin,
  ]);
  const call = (
    method: 'GET' | 'POST',
    url: string,
    subject = 'admin',
    payload: unknown = { expectedJobId: null },
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...(tokens.has(subject) ? { authorization: `Bearer ${tokens.get(subject)}` } : {}),
      },
      ...(method === 'POST' ? { payload: JSON.stringify(payload) } : {}),
    });
  const checksum = createHash('sha256').update('fictional text').digest('base64');
  const document = async () => {
    const record = caseSchema.parse(
      await execute('admin', Operation.CreateCase, {
        title: 'Fact fixture',
        clientName: 'Fictional Client',
      }),
    );
    await execute('admin', Operation.AssignCase, { id: record.id, userId: users.get('staff') });
    const id = (
      await db.owner.query(
        `insert into caseflow.documents(case_id,uploaded_by,filename,content_type,size_bytes,status,storage_bucket,storage_environment,object_version_id,uploaded_at,checksum_sha256,upload_request_id)
      values($1,$2,'fixture.pdf','application/pdf',14,'available','fixture-bucket','dev','saved-original',now(),$3,gen_random_uuid()) returning id`,
        [record.id, users.get('admin'), checksum],
      )
    ).rows[0].id as string;
    const job = (
      await db.owner.query('select caseflow.enqueue_document_processing($1,$2,null) id', [
        id,
        users.get('admin'),
      ])
    ).rows[0].id;
    const claimed = (
      await db.owner.query('select caseflow.claim_document_processing($1) value', [job])
    ).rows[0].value;
    const artifact = { versionId: 'saved-private-text', checksumSha256: checksum, sizeBytes: 14 };
    await db.owner.query("select caseflow.complete_document_processing($1,$2,'native',1,$3,$4)", [
      job,
      claimed.leaseToken,
      randomUUID(),
      { manifest: artifact, text: artifact },
    ]);
    return {
      id,
      caseId: record.id,
      path: `/cases/${record.id}/documents/${id}/fact-extraction`,
      facts: `/cases/${record.id}/documents/${id}/facts`,
    };
  };
  try {
    await t.test('strict signed routes and idempotent concurrent creation', async () => {
      const d = await document();
      for (const path of [d.path, d.facts]) {
        assert.equal((await call('GET', path, 'missing')).statusCode, 401);
        assert.equal((await call('GET', path, 'outsider')).statusCode, 404);
        assert.equal((await call('GET', path + '?sourceKey=forged')).statusCode, 400);
      }
      assert.equal((await call('POST', d.path, 'staff')).statusCode, 403);
      assert.equal(
        (await call('POST', d.path, 'admin', { expectedJobId: null, model: 'forged' })).statusCode,
        400,
      );
      assert.equal((await call('GET', d.path, 'staff')).json().status, 'not_extracted');
      const responses = await Promise.all([call('POST', d.path), call('POST', d.path, 'super')]);
      for (const response of responses) {
        assert.equal(response.statusCode, 200, response.body);
      }
      const summary = factExtractionSummarySchema.parse(responses[0]!.json());
      assert.equal(summary.job!.id, responses[1]!.json().job.id);
      assert.equal(
        (
          await db.owner.query(
            'select count(*)::int n from caseflow.fact_dispatches d join caseflow.fact_extraction_tasks t on t.id=d.task_id where t.job_id=$1',
            [summary.job!.id],
          )
        ).rows[0].n,
        1,
      );
      const page = documentPageSchema.parse(
        (await call('GET', `/cases/${d.caseId}/documents`)).json(),
      );
      assert.equal(page.items[0]!.factExtraction.job!.id, summary.job!.id);
      assert.doesNotMatch(
        responses[0]!.body,
        /sourceKey|leaseToken|pricingVersion|saved-private|model/,
      );
      assert.equal(responses[0]!.headers['cache-control'], 'no-store');
    });
    await t.test(
      'publishes complete cited facts; removed content is hidden even from admins',
      async () => {
        const d = await document();
        const job = (await call('POST', d.path)).json().job.id;
        const prep = (
          await db.owner.query(
            'select caseflow.claim_fact_task(id) value from caseflow.fact_extraction_tasks where job_id=$1 and ordinal=0',
            [job],
          )
        ).rows[0].value;
        const text = 'No fracture was found.';
        await db.owner.query('select caseflow.prepare_fact_chunks($1,$2,$3)', [
          prep.taskId,
          prep.leaseToken,
          JSON.stringify([[{ sourceId: 'p1:0:22', page: 1, start: 0, text }]]),
        ]);
        const chunk = (
          await db.owner.query(
            'select caseflow.claim_fact_task(id) value from caseflow.fact_extraction_tasks where job_id=$1 and ordinal=1',
            [job],
          )
        ).rows[0].value;
        await db.owner.query('select caseflow.reserve_fact_usage($1,$2,1000)', [
          chunk.taskId,
          chunk.leaseToken,
        ]);
        await db.owner.query('select caseflow.complete_fact_chunk($1,$2,$3)', [
          chunk.taskId,
          chunk.leaseToken,
          JSON.stringify([
            {
              category: 'finding',
              value: 'fracture',
              qualifier: null,
              dateValue: null,
              datePrecision: null,
              dateMeaning: null,
              treatmentStatus: null,
              findingStatus: 'confirmed',
              negated: true,
              evidence: [{ page: 1, quote: text, start: 0, end: 22 }],
            },
          ]),
        ]);
        for (const subject of ['staff', 'admin', 'super']) {
          const response = await call('GET', d.facts, subject);
          assert.equal(response.statusCode, 200, response.body);
          const page = factPageSchema.parse(response.json());
          assert.equal(page.total, 1);
          assert.equal(page.items[0]!.reviewStatus, 'unreviewed');
          assert.equal(page.items[0]!.evidence[0]!.documentId, d.id);
          assert.equal((await call('GET', d.facts + '?category=date', subject)).json().total, 0);
          assert.equal(
            (await call('GET', d.facts + '?page=2&pageSize=1', subject)).json().items.length,
            0,
          );
        }
        assert.equal((await call('POST', d.path, 'admin', { expectedJobId: job })).statusCode, 409);
        await execute('admin', Operation.RemoveDocument, {
          caseId: d.caseId,
          documentId: d.id,
          expectedVersion: 1,
        });
        assert.equal((await call('GET', d.facts, 'staff')).statusCode, 404);
        assert.equal((await call('GET', d.facts)).statusCode, 409);
        await execute('admin', Operation.RestoreDocument, {
          caseId: d.caseId,
          documentId: d.id,
          expectedVersion: 2,
        });
        await execute('admin', Operation.ArchiveCase, { id: d.caseId, expectedVersion: 1 });
        assert.equal((await call('GET', d.facts, 'staff')).json().total, 1);
        assert.equal((await call('POST', d.path)).statusCode, 409);
        assert.equal((await call('GET', d.path.replace(d.caseId, randomUUID()))).statusCode, 404);
      },
    );
    await t.test('rechecks disabled or demoted actors under the permission lock', async () => {
      for (const change of ['disable', 'demote']) {
        const d = await document();
        const blocker = await db.owner.connect();
        try {
          await blocker.query('begin');
          await blocker.query('select pg_advisory_xact_lock(734921,1)');
          const waiting = call('POST', d.path);
          await waitForPermissionLock(db.owner);
          await blocker.query(
            change === 'disable'
              ? 'update caseflow.users set active=false where id=$1'
              : "update caseflow.users set role='staff' where id=$1",
            [users.get('admin')],
          );
          await blocker.query('commit');
          assert.equal((await waiting).statusCode, 403);
        } finally {
          await blocker.query('rollback');
          blocker.release();
          await db.owner.query("update caseflow.users set role='admin',active=true where id=$1", [
            users.get('admin'),
          ]);
        }
      }
    });
    await t.test('audit rejection rolls back creation', async () => {
      const d = await document();
      await db.owner
        .query(`create function caseflow.reject_fact_audit() returns trigger language plpgsql as $$ begin raise exception 'private failure'; end $$;
        create trigger reject_fact_audit before insert on caseflow.audit_events for each row execute function caseflow.reject_fact_audit()`);
      try {
        const response = await call('POST', d.path);
        assert.equal(response.statusCode, 503);
        assert.doesNotMatch(response.body, /private failure/);
        assert.equal(
          (
            await db.owner.query(
              'select count(*)::int n from caseflow.fact_extraction_jobs where document_id=$1',
              [d.id],
            )
          ).rows[0].n,
          0,
        );
      } finally {
        await db.owner.query(
          'drop trigger reject_fact_audit on caseflow.audit_events; drop function caseflow.reject_fact_audit()',
        );
      }
    });
  } finally {
    await app.close();
    await db.close();
  }
});

test('fact migration preserves existing documents, assignments, processing and history without backfill', async () => {
  let before: unknown;
  const snapshotSql = `select jsonb_build_object(
    'users', (select jsonb_agg(x order by id) from caseflow.users x),
    'documents', (select jsonb_agg(x order by id) from caseflow.documents x),
    'assignments', (select jsonb_agg(x order by case_id,user_id) from caseflow.assignments x),
    'jobs', (select jsonb_agg(x order by id) from caseflow.document_processing_jobs x),
    'dispatches', (select jsonb_agg(x order by id) from caseflow.processing_dispatches x),
    'results', (select jsonb_agg(x order by job_id) from caseflow.document_processing_results x),
    'audit', (select jsonb_agg(x order by id) from caseflow.audit_events x)
  ) value`;
  const db = await createTestDatabase(async (owner) => {
    const user = randomUUID();
    const record = randomUUID();
    await owner.query(
      "insert into caseflow.users(id,tenant_id,subject,display_name) values($1,$2,'legacy-facts','Fictional Staff')",
      [user, randomUUID()],
    );
    await owner.query(
      "insert into caseflow.cases(id,title,client_name) values($1,'Legacy fact source','Fictional Client')",
      [record],
    );
    await owner.query('insert into caseflow.assignments(case_id,user_id) values($1,$2)', [
      record,
      user,
    ]);
    const id = (
      await owner.query(
        `insert into caseflow.documents(case_id,uploaded_by,filename,content_type,size_bytes,status,storage_bucket,storage_environment,object_version_id,uploaded_at,checksum_sha256,upload_request_id)
      values($1,$2,'legacy.pdf','application/pdf',14,'available','fixture-bucket','dev','saved-version',now(),$3,gen_random_uuid()) returning id`,
        [record, user, createHash('sha256').update('fictional text').digest('base64')],
      )
    ).rows[0].id;
    const job = (
      await owner.query('select caseflow.enqueue_document_processing($1,$2,null) id', [id, user])
    ).rows[0].id;
    const claim = (await owner.query('select caseflow.claim_document_processing($1) value', [job]))
      .rows[0].value;
    const artifact = {
      versionId: 'legacy-result',
      checksumSha256: createHash('sha256').update('fictional text').digest('base64'),
      sizeBytes: 14,
    };
    await owner.query("select caseflow.complete_document_processing($1,$2,'native',1,$3,$4)", [
      job,
      claim.leaseToken,
      randomUUID(),
      { manifest: artifact, text: artifact },
    ]);
    before = (await owner.query(snapshotSql)).rows[0].value;
  }, 'processing_recovery.sql');
  try {
    await db.owner.query(db.seed);
    await db.owner.query(db.seed);
    assert.deepEqual((await db.owner.query(snapshotSql)).rows[0].value, before);
    assert.equal(
      (await db.owner.query('select count(*)::int n from caseflow.fact_extraction_jobs')).rows[0].n,
      0,
    );
    assert.equal(
      (await db.owner.query('select count(*)::int n from caseflow.fact_dispatches')).rows[0].n,
      0,
    );
  } finally {
    await db.close();
  }
});
