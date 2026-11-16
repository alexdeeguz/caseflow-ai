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
  reviewedFactPageSchema,
  reviewedFactSchema,
  factReviewHistorySchema,
  factValuesSchema,
} from '@caseflow/schemas';
import { buildApp } from '../../src/app.js';
import { createTokenVerifier } from '../../src/auth.js';
import { Operation } from '../../src/database/operations.js';
import { createTestDatabase, waitForPermissionLock } from './database-fixture.js';

test('human review signed API, immutable provenance and transactional permissions', async (t) => {
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
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    subject = 'admin',
    payload: unknown = { expectedJobId: null },
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}),
        ...(tokens.has(subject) ? { authorization: `Bearer ${tokens.get(subject)}` } : {}),
      },
      ...(method !== 'GET' ? { payload: JSON.stringify(payload) } : {}),
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
  const fixture = async () => {
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

    const fact = reviewedFactSchema.parse((await call('GET', d.facts)).json().items[0]);
    return { ...d, fact, url: `${d.facts}/${fact.id}` };
  };
  try {
    await t.test(
      'Staff correction/rejection, Admin approval/reopening, versioning and original evidence',
      async () => {
        const d = await fixture();
        const values = { ...d.fact.original, qualifier: 'Reviewed against the source' };
        const corrected = await call('PATCH', d.url, 'staff', {
          expectedVersion: 1,
          values,
          reason: 'Clarify the finding',
        });
        assert.equal(corrected.statusCode, 200, corrected.body);
        const fact = reviewedFactSchema.parse(corrected.json());
        assert.equal(fact.version, 2);
        assert.equal(fact.corrected, true);
        assert.equal(fact.reviewStatus, 'unreviewed');
        assert.deepEqual(fact.original, d.fact.original);
        assert.deepEqual(fact.evidence, d.fact.evidence);
        assert.equal(
          (await call('POST', `${d.url}/approve`, 'staff', { expectedVersion: 2 })).statusCode,
          403,
        );
        const approved = await call('POST', `${d.url}/approve`, 'admin', { expectedVersion: 2 });
        assert.equal(approved.statusCode, 200, approved.body);
        assert.equal(approved.json().version, 3);
        assert.equal(approved.json().reviewStatus, 'approved');
        assert.equal(
          (
            await call('PATCH', d.url, 'staff', { expectedVersion: 3, values, reason: 'Change' })
          ).json().code,
          'FACT_REVIEW_LOCKED',
        );
        assert.equal(
          (await call('POST', `${d.url}/reject`, 'admin', { expectedVersion: 3, reason: 'Change' }))
            .statusCode,
          409,
        );
        assert.equal(
          (await call('POST', `${d.url}/reopen`, 'staff', { expectedVersion: 3, reason: 'Change' }))
            .statusCode,
          403,
        );
        assert.equal(
          (
            await call('POST', `${d.url}/reopen`, 'super', {
              expectedVersion: 3,
              reason: 'Check again',
            })
          ).json().version,
          4,
        );
        assert.equal(
          (
            await call('POST', `${d.url}/reject`, 'staff', {
              expectedVersion: 4,
              reason: 'Evidence is insufficient',
            })
          ).json().reviewStatus,
          'rejected',
        );
        assert.equal(
          (await call('POST', `${d.url}/approve`, 'admin', { expectedVersion: 5 })).statusCode,
          409,
        );
        assert.equal(
          (
            await call('PATCH', d.url, 'staff', {
              expectedVersion: 5,
              values,
              reason: 'Reconsider source',
            })
          ).json().reviewStatus,
          'unreviewed',
        );
        const history = factReviewHistorySchema.parse(
          (await call('GET', `${d.url}/history?pageSize=2`)).json(),
        );
        assert.equal(history.total, 5);
        assert.deepEqual(
          history.items.map((item) => item.version),
          [6, 5],
        );
        assert.equal(history.items[1]!.reason, 'Evidence is insufficient');
        const page = reviewedFactPageSchema.parse(
          (await call('GET', d.facts + '?reviewStatus=rejected')).json(),
        );
        assert.equal(page.total, 0);
        assert.deepEqual(page.counts, { unreviewed: 1, approved: 0, rejected: 0 });
        const audit = await db.owner.query(
          'select before_value,after_value from caseflow.audit_events where target_id=$1',
          [d.fact.id],
        );
        assert.doesNotMatch(
          JSON.stringify(audit.rows),
          /Clarify|insufficient|fracture|quote|qualifier/,
        );
      },
    );
    await t.test(
      'strict contracts, category validation, immutable provenance and scope',
      async () => {
        const d = await fixture();
        const base = { expectedVersion: 1, values: d.fact.original, reason: 'Valid reason' };
        for (const payload of [
          { ...base, evidence: [] },
          { ...base, role: 'admin' },
          { ...base, values: { ...base.values, documentId: d.id } },
          { ...base, reason: '  ' },
          {
            ...base,
            values: {
              ...base.values,
              category: 'date',
              dateValue: '2026-02-30',
              datePrecision: 'day',
              dateMeaning: 'Incident',
            },
          },
          { ...base, values: { ...base.values, value: 'a'.repeat(1001) } },
        ]) {
          assert.equal((await call('PATCH', d.url, 'admin', payload)).statusCode, 400);
        }
        for (const path of [d.url, `${d.url}/history`]) {
          assert.equal((await call('GET', path, 'missing')).statusCode, 401);
          assert.equal((await call('GET', path, 'outsider')).statusCode, 404);
          assert.equal((await call('GET', path.replace(d.caseId, randomUUID()))).statusCode, 404);
          assert.equal((await call('GET', path + '?forged=true')).statusCode, 400);
        }
        assert.equal((await call('PATCH', d.url, 'outsider', base)).statusCode, 404);
        assert.equal(
          (await call('POST', `${d.url}/approve`, 'missing', { expectedVersion: 1 })).statusCode,
          401,
        );
        assert.equal((await call('GET', d.url)).headers['cache-control'], 'no-store');
        const date = {
          ...d.fact.original,
          category: 'date',
          value: 'Incident year',
          dateValue: '2026',
          datePrecision: 'year',
          dateMeaning: 'Incident',
          findingStatus: null,
        };
        assert.equal(factValuesSchema.safeParse(date).success, true);
        assert.equal(
          (await call('PATCH', d.url, 'staff', { ...base, values: date })).statusCode,
          200,
        );
        assert.equal((await call('GET', d.facts + '?category=date')).json().total, 1);
      },
    );
    await t.test('matching-version no-ops, stale retries and concurrent edits', async () => {
      const d = await fixture();
      const unchanged = { expectedVersion: 1, values: d.fact.original, reason: 'No change' };
      assert.equal((await call('PATCH', d.url, 'staff', unchanged)).json().version, 1);
      assert.equal((await call('GET', `${d.url}/history`)).json().total, 0);
      const responses = await Promise.all([
        call('PATCH', d.url, 'staff', {
          ...unchanged,
          values: { ...d.fact.original, value: 'Finding A' },
        }),
        call('POST', `${d.url}/approve`, 'admin', { expectedVersion: 1 }),
      ]);
      assert.deepEqual(responses.map((x) => x.statusCode).sort(), [200, 409]);
      const stale = await call('PATCH', d.url, 'staff', unchanged);
      assert.equal(stale.json().code, 'FACT_REVIEW_CONFLICT');
      assert.equal((await call('GET', `${d.url}/history`)).json().total, 1);
      const current = (await call('GET', d.url)).json();
      if (current.reviewStatus !== 'approved') {
        await call('POST', `${d.url}/approve`, 'admin', { expectedVersion: current.version });
      }
      const approved = (await call('GET', d.url)).json();
      assert.equal(
        (
          await call('POST', `${d.url}/approve`, 'admin', { expectedVersion: approved.version })
        ).json().version,
        approved.version,
      );
    });
    await t.test(
      'removed content/history hidden and archives read-only, including direct RLS reads',
      async () => {
        const d = await fixture();
        await call('POST', `${d.url}/approve`, 'super', { expectedVersion: 1 });
        await execute('admin', Operation.RemoveDocument, {
          caseId: d.caseId,
          documentId: d.id,
          expectedVersion: 1,
        });
        for (const user of ['staff', 'admin', 'super']) {
          for (const path of [d.url, `${d.url}/history`]) {
            assert.equal((await call('GET', path, user)).statusCode, 404);
          }
        }
        await db.runtime.query('begin');
        try {
          await db.runtime.query(
            "select set_config('caseflow.tenant_id',$1,true),set_config('caseflow.subject','admin',true)",
            [tenantId],
          );
          for (const table of ['fact_reviews', 'fact_review_revisions', 'approved_facts']) {
            assert.equal(
              (
                await db.runtime.query(
                  `select * from caseflow.${table} where ${table === 'approved_facts' ? 'id' : 'fact_id'}=$1`,
                  [d.fact.id],
                )
              ).rowCount,
              0,
            );
          }
        } finally {
          await db.runtime.query('rollback');
        }
        await execute('admin', Operation.RestoreDocument, {
          caseId: d.caseId,
          documentId: d.id,
          expectedVersion: 2,
        });
        await execute('admin', Operation.ArchiveCase, { id: d.caseId, expectedVersion: 1 });
        assert.equal((await call('GET', d.url, 'staff')).json().reviewStatus, 'approved');
        assert.equal(
          (
            await call('POST', `${d.url}/reopen`, 'admin', {
              expectedVersion: 2,
              reason: 'Recheck',
            })
          ).json().code,
          'CASE_ARCHIVED',
        );
      },
    );
    await t.test('only the current approved revision is eligible under caller RLS', async () => {
      const d = await fixture();
      async function eligible(subject: string) {
        await db.runtime.query('begin');
        try {
          await db.runtime.query(
            "select set_config('caseflow.tenant_id',$1,true),set_config('caseflow.subject',$2,true)",
            [tenantId, subject],
          );
          return (
            await db.runtime.query(
              'select version, values from caseflow.approved_facts where id=$1',
              [d.fact.id],
            )
          ).rows;
        } finally {
          await db.runtime.query('rollback');
        }
      }
      assert.deepEqual(await eligible('staff'), []);
      await call('POST', `${d.url}/approve`, 'admin', { expectedVersion: 1 });
      assert.deepEqual(await eligible('staff'), [{ version: 2, values: d.fact.original }]);
      assert.deepEqual(await eligible('outsider'), []);
      await call('POST', `${d.url}/reopen`, 'super', {
        expectedVersion: 2,
        reason: 'Recheck the source',
      });
      assert.deepEqual(await eligible('staff'), []);
      assert.equal((await call('GET', `${d.url}/history`)).json().total, 2);
    });
    await t.test(
      'direct restricted database calls validate correction fields and provenance',
      async () => {
        const d = await fixture();
        for (const values of [
          { ...d.fact.original, value: ' ' },
          { ...d.fact.original, evidence: [] },
          {
            ...d.fact.original,
            category: 'date',
            dateValue: '2026-02-30',
            datePrecision: 'day',
            dateMeaning: 'Incident',
            findingStatus: null,
          },
          { ...d.fact.original, negated: 'false' },
        ]) {
          await db.runtime.query('begin');
          try {
            await db.runtime.query(
              "select set_config('caseflow.tenant_id',$1,true),set_config('caseflow.subject','staff',true)",
              [tenantId],
            );
            await assert.rejects(
              db.runtime.query(
                "select caseflow.review_fact($1,$2,$3,'correct',1,$4,'Review reason')",
                [d.caseId, d.id, d.fact.id, values],
              ),
              /INVALID_INPUT/,
            );
          } finally {
            await db.runtime.query('rollback');
          }
        }
        assert.equal((await call('GET', d.url)).json().version, 1);
        assert.equal((await call('GET', `${d.url}/history`)).json().total, 0);
      },
    );
    await t.test('permissions are rechecked after waiting for the transaction lock', async () => {
      for (const change of ['disable', 'demote', 'unassign', 'remove', 'archive']) {
        const d = await fixture();
        const actor = change === 'unassign' ? 'staff' : 'admin';
        const blocker = await db.owner.connect();
        try {
          await blocker.query('begin');
          await blocker.query('select pg_advisory_xact_lock(734921,1)');
          const waiting =
            actor === 'staff'
              ? call('PATCH', d.url, actor, {
                  expectedVersion: 1,
                  values: { ...d.fact.original, value: 'Changed' },
                  reason: 'Correction',
                })
              : call('POST', `${d.url}/approve`, actor, { expectedVersion: 1 });
          await waitForPermissionLock(db.owner);
          if (change === 'disable') {
            await blocker.query('update caseflow.users set active=false where id=$1', [
              users.get(actor),
            ]);
          }
          if (change === 'demote') {
            await blocker.query("update caseflow.users set role='staff' where id=$1", [
              users.get(actor),
            ]);
          }
          if (change === 'unassign') {
            await blocker.query('delete from caseflow.assignments where case_id=$1', [d.caseId]);
          }
          if (change === 'remove') {
            await blocker.query(
              "update caseflow.documents set status='removed',removed_at=now(),removed_by=$2 where id=$1",
              [d.id, users.get('admin')],
            );
          }
          if (change === 'archive') {
            await blocker.query(
              'update caseflow.cases set archived_at=now(),archived_by=$2 where id=$1',
              [d.caseId, users.get('admin')],
            );
          }
          await blocker.query('commit');
          assert.notEqual((await waiting).statusCode, 200, change);
          assert.equal(
            (
              await db.owner.query('select version from caseflow.fact_reviews where fact_id=$1', [
                d.fact.id,
              ])
            ).rows[0].version,
            1,
          );
        } finally {
          await blocker.query('rollback');
          blocker.release();
          await db.owner.query("update caseflow.users set active=true,role='admin' where id=$1", [
            users.get('admin'),
          ]);
        }
      }
    });
    await t.test('audit rollback and restricted runtime writes/grants', async () => {
      const d = await fixture();
      await db.owner
        .query(`create function caseflow.reject_review_audit() returns trigger language plpgsql as $$ begin raise exception 'private'; end $$;
        create trigger reject_review_audit before insert on caseflow.audit_events for each row execute function caseflow.reject_review_audit()`);
      try {
        assert.equal(
          (await call('POST', `${d.url}/approve`, 'admin', { expectedVersion: 1 })).statusCode,
          503,
        );
        assert.equal((await call('GET', d.url)).json().version, 1);
        assert.equal((await call('GET', `${d.url}/history`)).json().total, 0);
      } finally {
        await db.owner.query(
          'drop trigger reject_review_audit on caseflow.audit_events; drop function caseflow.reject_review_audit()',
        );
      }
      for (const table of [
        'fact_reviews',
        'fact_review_revisions',
        'extracted_facts',
        'fact_evidence',
      ]) {
        await assert.rejects(db.runtime.query(`delete from caseflow.${table}`), { code: '42501' });
      }
      const grants = await db.owner
        .query(`select has_function_privilege('anon','caseflow.review_fact(uuid,uuid,uuid,text,integer,jsonb,text)','execute') as anon,
        has_function_privilege('caseflow_fact_extractor','caseflow.review_fact(uuid,uuid,uuid,text,integer,jsonb,text)','execute') as worker`);
      assert.deepEqual(grants.rows[0], { anon: false, worker: false });
      await db.runtime.query('begin');
      try {
        await db.runtime.query(
          "select set_config('caseflow.tenant_id',$1,true),set_config('caseflow.subject','staff',true)",
          [tenantId],
        );
        await assert.rejects(
          db.runtime.query("select caseflow.review_fact($1,$2,$3,'approve',1,null,null)", [
            d.caseId,
            d.id,
            d.fact.id,
          ]),
          /FORBIDDEN/,
        );
      } finally {
        await db.runtime.query('rollback');
      }
    });
  } finally {
    await app.close();
    await db.close();
  }
});

test('review migration preserves original rows and initializes only the review projection', async () => {
  const userId = randomUUID();
  const caseId = randomUUID();
  const factId = randomUUID();
  const legacyFactId = randomUUID();
  let baseline: unknown;
  const snapshot = `select jsonb_build_object(
    'facts',(select jsonb_agg(f order by id) from caseflow.extracted_facts f),
    'evidence',(select jsonb_agg(e order by id) from caseflow.fact_evidence e),
    'audit',(select jsonb_agg(a order by id) from caseflow.audit_events a),
    'assignments',(select jsonb_agg(a order by case_id,user_id) from caseflow.assignments a),
    'jobs',(select jsonb_agg(j order by id) from caseflow.fact_extraction_jobs j),
    'dispatches',(select jsonb_agg(d order by id) from caseflow.fact_dispatches d)
  ) value`;
  const db = await createTestDatabase(async (owner) => {
    await owner.query(
      "insert into caseflow.users(id,tenant_id,subject,display_name) values($1,$2,'review-legacy','Fictional reviewer')",
      [userId, randomUUID()],
    );
    await owner.query(
      "insert into caseflow.cases(id,title,client_name) values($1,'Review migration fixture','Fictional client')",
      [caseId],
    );
    await owner.query('insert into caseflow.assignments(case_id,user_id) values($1,$2)', [
      caseId,
      userId,
    ]);
    const checksum = createHash('sha256').update('fixture').digest('base64');
    const documentId = (
      await owner.query(
        `insert into caseflow.documents(case_id,uploaded_by,filename,content_type,size_bytes,status,storage_bucket,storage_environment,object_version_id,uploaded_at,checksum_sha256,upload_request_id)
      values($1,$2,'fixture.pdf','application/pdf',7,'available','fixture-bucket','dev','saved-version',now(),$3,gen_random_uuid()) returning id`,
        [caseId, userId, checksum],
      )
    ).rows[0].id;
    const processingId = (
      await owner.query('select caseflow.enqueue_document_processing($1,$2,null) id', [
        documentId,
        userId,
      ])
    ).rows[0].id;
    const claim = (
      await owner.query('select caseflow.claim_document_processing($1) value', [processingId])
    ).rows[0].value;
    const artifact = { versionId: 'saved-result', checksumSha256: checksum, sizeBytes: 7 };
    await owner.query("select caseflow.complete_document_processing($1,$2,'native',1,$3,$4)", [
      processingId,
      claim.leaseToken,
      randomUUID(),
      { manifest: artifact, text: artifact },
    ]);
    const jobId = (
      await owner.query(
        `insert into caseflow.fact_extraction_jobs(document_id,processing_result_id,requested_by,status,chunk_count,completed_chunks,fact_count,finished_at)
      values($1,$2,$3,'completed',1,1,1,now()) returning id`,
        [documentId, processingId, userId],
      )
    ).rows[0].id;
    await owner.query(
      "insert into caseflow.extracted_facts(id,extraction_job_id,category,value,negated) values($1,$2,'provider','Fictional Clinic',false)",
      [factId, jobId],
    );
    await owner.query(
      "insert into caseflow.fact_evidence(fact_id,document_id,processing_result_id,page,quote,start_offset,end_offset) values($1,$2,$3,1,'Fictional Clinic',0,16)",
      [factId, documentId, processingId],
    );
    // The old extraction contract permits whitespace values; backfill must preserve them.
    await owner.query(
      "insert into caseflow.extracted_facts(id,extraction_job_id,category,value,qualifier,negated) values($1,$2,'provider',' ',' ',false)",
      [legacyFactId, jobId],
    );
    baseline = (await owner.query(snapshot)).rows[0].value;
  }, 'fact_extraction.sql');
  try {
    assert.deepEqual((await db.owner.query(snapshot)).rows[0].value, baseline);
    await db.owner.query(db.seed);
    await db.owner.query(db.seed);
    assert.deepEqual((await db.owner.query(snapshot)).rows[0].value, baseline);
    const review = (
      await db.owner.query('select * from caseflow.fact_reviews where fact_id=$1', [factId])
    ).rows[0];
    assert.equal(review.version, 1);
    assert.equal(review.status, 'unreviewed');
    assert.equal(review.reviewed_by, null);
    assert.equal(review.values.value, 'Fictional Clinic');
    assert.equal(
      (await db.owner.query('select * from caseflow.fact_review_revisions')).rowCount,
      0,
    );
  } finally {
    await db.close();
  }
});
