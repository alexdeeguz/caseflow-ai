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
  reviewedFactSchema,
  factValuesSchema,
  caseTimelineSchema,
  caseReviewedSummarySchema,
  type FactValues,
} from '@caseflow/schemas';
import { buildApp } from '../../src/app.js';
import { createTokenVerifier } from '../../src/auth.js';
import { getCaseTimeline, getCaseReviewedSummary } from '../../src/database/case-history.js';
import { Operation } from '../../src/database/operations.js';
import { createTestDatabase } from './database-fixture.js';

test('approved case timeline and summary through signed API requests', async (t) => {
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
  const newCase = async () =>
    caseSchema.parse(
      await execute('admin', Operation.CreateCase, {
        title: 'Fact fixture',
        clientName: 'Fictional Client',
        incidentDate: '1999-01-01',
        summary: 'Manual summary remains separate.',
      }),
    );
  const record = await newCase();
  const document = async (caseId = record.id) => {
    await execute('admin', Operation.AssignCase, { id: caseId, userId: users.get('staff') });
    const id = (
      await db.owner.query(
        `insert into caseflow.documents(case_id,uploaded_by,filename,content_type,size_bytes,status,storage_bucket,storage_environment,object_version_id,uploaded_at,checksum_sha256,upload_request_id)
      values($1,$2,'fixture.pdf','application/pdf',14,'available','fixture-bucket','dev','saved-original',now(),$3,gen_random_uuid()) returning id`,
        [caseId, users.get('admin'), checksum],
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
      caseId: caseId,
      path: `/cases/${caseId}/documents/${id}/fact-extraction`,
      facts: `/cases/${caseId}/documents/${id}/facts`,
    };
  };
  const base: FactValues = {
    category: 'provider',
    value: 'Fictional Clinic',
    qualifier: null,
    dateValue: null,
    datePrecision: null,
    dateMeaning: null,
    treatmentStatus: null,
    findingStatus: null,
    negated: false,
  };
  const addFacts = async (d: Awaited<ReturnType<typeof document>>, values: FactValues[]) => {
    const processing = (
      await db.owner.query(
        "select id from caseflow.document_processing_jobs where document_id=$1 and status='ready'",
        [d.id],
      )
    ).rows[0].id;
    const job = (
      await db.owner.query(
        `update caseflow.fact_extraction_jobs
         set status='completed',chunk_count=1,completed_chunks=1,fact_count=$2,finished_at=now()
         where document_id=$1 returning id`,
        [d.id, values.length],
      )
    ).rows[0].id;
    const ids: string[] = [];
    for (const value of values) {
      const v = factValuesSchema.parse(value);
      const id = randomUUID();
      await db.owner.query(
        `insert into caseflow.extracted_facts(id,extraction_job_id,category,value,qualifier,date_value,date_precision,date_meaning,treatment_status,finding_status,negated)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          job,
          v.category,
          v.value,
          v.qualifier,
          v.dateValue,
          v.datePrecision,
          v.dateMeaning,
          v.treatmentStatus,
          v.findingStatus,
          v.negated,
        ],
      );
      const quote = 'Fictional source — café 🩺.';
      await db.owner.query(
        `insert into caseflow.fact_evidence(fact_id,document_id,processing_result_id,page,quote,start_offset,end_offset)
         values($1,$2,$3,1,$4,12,$5)`,
        [id, d.id, processing, quote, 12 + [...quote].length],
      );
      ids.push(id);
    }
    return ids;
  };
  const review = async (
    d: Awaited<ReturnType<typeof document>>,
    id: string,
    action = 'approve',
    version = 1,
  ) => {
    const response = await call('POST', `${d.facts}/${id}/${action}`, 'admin', {
      expectedVersion: version,
      ...(action === 'approve' ? {} : { reason: 'Fictional review reason' }),
    });
    assert.equal(response.statusCode, 200, response.body);
    return reviewedFactSchema.parse(response.json());
  };
  const timeline = `/cases/${record.id}/timeline`;
  const summary = `/cases/${record.id}/reviewed-summary`;
  try {
    const d = await document();
    const dates = ['2024', '2024-02', '2024-02-29', '2024-02-29', '2026-12-03'];
    const dateIds = await addFacts(
      d,
      dates.map((dateValue, i) => ({
        ...base,
        category: 'date',
        value: `Documented date ${i}`,
        dateValue,
        datePrecision: dateValue.length === 4 ? 'year' : dateValue.length === 7 ? 'month' : 'day',
        dateMeaning: 'Treatment date',
        negated: i === 4,
        qualifier: i === 4 ? 'Explicitly denied' : null,
      })),
    );
    const other = await document();
    const ids = await addFacts(other, [
      { ...base, value: 'Zulu clinic' },
      { ...base, value: 'alpha clinic' },
      { ...base, value: 'Alpha clinic' },
      { ...base, value: 'Not yet approved' },
      { ...base, value: 'Rejected source' },
      { ...base, category: 'treatment', value: 'Physical therapy', treatmentStatus: 'recommended' },
      {
        ...base,
        category: 'finding',
        value: 'Fracture',
        findingStatus: 'suspected',
        negated: true,
      },
      { ...base, category: 'finding', value: 'Original finding', findingStatus: 'confirmed' },
    ]);
    for (const id of dateIds) {
      await review(d, id);
    }
    for (const i of [0, 1, 2, 5, 6]) {
      await review(other, ids[i]!);
    }
    await review(other, ids[4]!, 'reject');
    const corrected = await call('PATCH', `${other.facts}/${ids[7]}`, 'staff', {
      expectedVersion: 1,
      values: { ...base, value: 'Corrected provider' },
      reason: 'Corrected category and value',
    });
    assert.equal(corrected.statusCode, 200, corrected.body);
    await review(other, ids[7]!, 'approve', 2);

    await t.test(
      'current approved values, chronological partial dates, stable pages and exact Unicode evidence',
      async () => {
        const response = await call('GET', timeline, 'staff');
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.headers['cache-control'], 'no-store');
        const result = caseTimelineSchema.parse(response.json());
        assert.equal(result.total, 5);
        assert.deepEqual(
          result.items.map((f) => f.dateValue),
          dates,
        );
        assert.deepEqual(
          result.items.slice(2, 4).map((f) => f.id),
          dateIds.slice(2, 4).sort(),
        );
        assert.equal(result.items[4]?.negated, true);
        assert.equal(result.items[4]?.qualifier, 'Explicitly denied');
        assert.equal(result.items[0]?.evidence[0]?.quote, 'Fictional source — café 🩺.');
        assert.equal(result.items[0]?.evidence[0]?.start, 12);
        const all: string[] = [];
        for (const page of [1, 2, 3]) {
          const part = caseTimelineSchema.parse(
            (await call('GET', `${timeline}?page=${page}&pageSize=2`)).json(),
          );
          assert.equal(part.total, 5);
          all.push(...part.items.map((f) => f.id));
        }
        assert.deepEqual(
          all,
          result.items.map((f) => f.id),
        );
        assert.equal((await call('GET', `${timeline}?page=99`)).json().items.length, 0);
      },
    );

    await t.test(
      'category counts span the case and selected items use corrected values',
      async () => {
        for (const actor of ['admin', 'super', 'staff']) {
          const result = caseReviewedSummarySchema.parse(
            (await call('GET', `${summary}?category=provider`, actor)).json(),
          );
          assert.deepEqual(result.counts, { date: 5, provider: 4, treatment: 1, finding: 1 });
          assert.equal(result.sourceDocumentCount, 2);
          assert.deepEqual(
            result.items.map((f) => f.value.toLowerCase()),
            ['alpha clinic', 'alpha clinic', 'corrected provider', 'zulu clinic'],
          );
          assert.deepEqual(
            result.items.slice(0, 2).map((f) => f.id),
            ids.slice(1, 3).sort(),
          );
          assert.equal(result.items[2]?.version, 3);
          assert.equal('original' in result.items[2]!, false);
          for (const hidden of [
            'leaseToken',
            'storageBucket',
            'providerJobId',
            'reviewedBy',
            'reason',
            'objectKey',
          ]) {
            assert.equal(JSON.stringify(result).includes(hidden), false);
          }
        }
        const initial = (await call('GET', summary)).json();
        assert.equal(initial.category, 'date');
        assert.equal(initial.total, 5);
        assert.equal(
          (await call('GET', summary + '?category=treatment')).json().items[0].treatmentStatus,
          'recommended',
        );
        assert.equal(
          (await call('GET', summary + '?category=finding')).json().items[0].findingStatus,
          'suspected',
        );
        assert.equal(
          (await call('GET', summary + '?category=provider&pageSize=1')).json().counts.provider,
          4,
        );
      },
    );

    await t.test(
      'set-based queries use one snapshot and existing indexes for a larger case',
      async () => {
        const larger = await newCase();
        const source = await document(larger.id);
        const fixtureIds = await addFacts(
          source,
          Array.from({ length: 500 }, (_, index) =>
            index % 5 === 0
              ? {
                  ...base,
                  category: 'date',
                  value: 'Documented visit',
                  dateValue: '2024-02-29',
                  datePrecision: 'day',
                  dateMeaning: 'Visit',
                }
              : { ...base, value: `Fictional provider ${String(index).padStart(4, '0')}` },
          ),
        );
        await db.owner.query(
          "update caseflow.fact_reviews set status='approved',version=2,reviewed_by=$1,reviewed_at=now() where fact_id=any($2::uuid[])",
          [users.get('admin'), fixtureIds],
        );
        await db.owner.query('analyze');
        const client = await db.runtime.connect();
        try {
          await client.query('begin');
          await client.query(
            "select set_config('caseflow.tenant_id',$1,true),set_config('caseflow.subject',$2,true)",
            [tenantId, 'staff'],
          );
          const statements: { text: string; values: unknown[] }[] = [];
          const observed = new Proxy(client, {
            get(target, property, receiver) {
              if (property === 'query') {
                return (text: string, values: unknown[]) => {
                  statements.push({ text, values });
                  return target.query(text, values);
                };
              }
              return Reflect.get(target, property, receiver);
            },
          });
          const dates = await getCaseTimeline(observed, { caseId: larger.id, pageSize: 25 });
          const providers = await getCaseReviewedSummary(observed, {
            caseId: larger.id,
            category: 'provider',
            pageSize: 25,
          });
          assert.equal(statements.length, 2, 'Each endpoint must perform exactly one data query.');
          assert.equal(dates.total, 100);
          assert.equal(providers.total, 400);
          assert.equal(providers.items.length, 25);
          assert.equal(providers.sourceDocumentCount, 1);
          for (const statement of statements) {
            const explained = await client.query(
              `explain (analyze, buffers, format json) ${statement.text}`,
              statement.values,
            );
            const plan = explained.rows[0]['QUERY PLAN'][0];
            const indexes = new Set<string>();
            const inspect = (node: { 'Index Name'?: string; Plans?: (typeof node)[] }) => {
              if (node['Index Name']) {
                indexes.add(node['Index Name']);
              }
              node.Plans?.forEach(inspect);
            };
            inspect(plan.Plan);
            t.diagnostic(
              `500-fact query: ${plan['Execution Time']} ms; indexes: ${[...indexes].join(', ')}`,
            );
          }
        } finally {
          await client.query('rollback');
          client.release();
        }
      },
    );

    await t.test(
      'approval revocation and document removal immediately affect facts and counts; archives remain readable',
      async () => {
        const reopened = await review(d, dateIds[0]!, 'reopen', 2);
        assert.equal((await call('GET', timeline)).json().total, 4);
        await review(d, dateIds[0]!, 'approve', reopened.version);
        assert.equal((await call('GET', timeline)).json().total, 5);
        await execute('admin', Operation.RemoveDocument, {
          caseId: record.id,
          documentId: other.id,
          expectedVersion: 1,
        });
        for (const actor of ['admin', 'super', 'staff']) {
          const result = (await call('GET', summary + '?category=provider', actor)).json();
          assert.equal(result.total, 0);
          assert.equal(result.sourceDocumentCount, 1);
          assert.deepEqual(result.counts, { date: 5, provider: 0, treatment: 0, finding: 0 });
        }
        await execute('admin', Operation.RestoreDocument, {
          caseId: record.id,
          documentId: other.id,
          expectedVersion: 2,
        });
        assert.equal((await call('GET', summary + '?category=provider')).json().total, 4);
        await execute('admin', Operation.ArchiveCase, { id: record.id, expectedVersion: 1 });
        assert.equal((await call('GET', timeline, 'staff')).json().total, 5);
        assert.equal((await call('GET', summary, 'staff')).json().sourceDocumentCount, 2);
      },
    );

    await t.test(
      'case visibility, disabled users, forged query fields and empty cases',
      async () => {
        const empty = await newCase();
        for (const path of [timeline, summary]) {
          assert.equal((await call('GET', path, 'missing')).statusCode, 401);
          assert.equal((await call('GET', path, 'outsider')).statusCode, 404);
          assert.equal((await call('GET', path.replace(record.id, randomUUID()))).statusCode, 404);
          for (const query of [
            'role=admin',
            'page=0',
            'pageSize=101',
            'documentId=' + d.id,
            'reviewStatus=unreviewed',
          ]) {
            assert.equal((await call('GET', path + '?' + query)).statusCode, 400);
          }
          const emptyPath = path.replace(record.id, empty.id);
          assert.equal((await call('GET', emptyPath, 'staff')).statusCode, 404);
          assert.equal((await call('GET', emptyPath)).json().total, 0);
        }
        assert.equal((await call('GET', summary + '?category=invalid')).statusCode, 400);
        assert.equal((await call('GET', timeline + '?category=provider')).statusCode, 400);
        await db.owner.query('update caseflow.users set active=false where id=$1', [
          users.get('staff'),
        ]);
        assert.equal((await call('GET', timeline, 'staff')).json().code, 'ACCOUNT_DISABLED');
        await db.owner.query('update caseflow.users set active=true where id=$1', [
          users.get('staff'),
        ]);
        await execute('admin', Operation.UnassignCase, {
          id: record.id,
          userId: users.get('staff'),
        });
        assert.equal((await call('GET', summary, 'staff')).statusCode, 404);
        await db.owner.query("update caseflow.users set role='staff' where id=$1", [
          users.get('admin'),
        ]);
        assert.equal((await call('GET', timeline)).statusCode, 404);
        assert.equal((await call('GET', timeline, 'super')).statusCode, 200);
      },
    );
  } finally {
    await app.close();
    await db.close();
  }
});
