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
  SearchMatch,
  caseSchema,
  documentPageSchema,
  documentSearchPageSchema,
  searchIndexSummarySchema,
  userSchema,
} from '@caseflow/schemas';
import { buildApp } from '../../src/app.js';
import { createTokenVerifier } from '../../src/auth.js';
import { Operation } from '../../src/database/operations.js';
import type { QueryEmbedder } from '../../src/search/embeddings.js';
import { createTestDatabase } from './database-fixture.js';

const DIMENSIONS = 1536;
// Deterministic unit vectors: chunks on the same axis are semantically "identical".
const axis = (index: number) =>
  Array.from({ length: DIMENSIONS }, (_value, position) => (position === index ? 1 : 0));
// A unit query vector with the given cosine similarity to `index`; the rest lies on an unused axis.
const UNUSED_AXIS = 100;
const similarTo = (index: number, similarity: number) =>
  Array.from({ length: DIMENSIONS }, (_value, position) =>
    position === index ? similarity : position === UNUSED_AXIS ? Math.sqrt(1 - similarity ** 2) : 0,
  );

test('document search follows case access, visibility and hybrid ranking', async (t) => {
  const db = await createTestDatabase();
  t.after(() => db.close());
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
    kid: 'search',
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
  let queryVector: number[] | null = null;
  const embedded: string[] = [];
  const embedder: QueryEmbedder = {
    async embed(text) {
      embedded.push(text);
      return queryVector;
    },
  };
  const store = { execute: db.store.execute, close: async () => {} };
  const app = await buildApp(
    config,
    verify,
    false,
    store,
    undefined,
    undefined,
    undefined,
    embedder,
  );
  t.after(() => app.close());

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
        .setProtectedHeader({ alg: 'RS256', kid: 'search' })
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

  const call = (method: 'GET' | 'POST', url: string, subject = 'admin') =>
    app.inject({
      method,
      url,
      headers: {
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${tokens.get(subject)}`,
      },
      ...(method === 'POST' ? { payload: '{}' } : {}),
    });
  const search = async (params: Record<string, string>, subject = 'admin') => {
    const response = await call('GET', `/search?${new URLSearchParams(params)}`, subject);
    assert.equal(response.statusCode, 200, response.body);
    return documentSearchPageSchema.parse(response.json());
  };

  const checksum = createHash('sha256').update('fictional text').digest('base64');
  const newCase = async (title: string, assignStaff: boolean) => {
    const record = caseSchema.parse(
      await execute('admin', Operation.CreateCase, {
        title,
        clientName: 'Fictional Client',
        incidentDate: '1999-01-01',
        summary: '',
      }),
    );
    if (assignStaff) {
      await execute('admin', Operation.AssignCase, { id: record.id, userId: users.get('staff') });
    }
    return record;
  };
  // Inserts an available document and completes processing, which queues search indexing.
  const processedDocument = async (caseId: string, filename: string) => {
    const id = (
      await db.owner.query(
        `insert into caseflow.documents(case_id,uploaded_by,filename,content_type,size_bytes,status,storage_bucket,storage_environment,object_version_id,uploaded_at,checksum_sha256,upload_request_id)
         values($1,$2,$3,'application/pdf',14,'available','fixture-bucket','dev','saved-original',now(),$4,gen_random_uuid()) returning id`,
        [caseId, users.get('admin'), filename, checksum],
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
    await db.owner.query("select caseflow.complete_document_processing($1,$2,'native',2,$3,$4)", [
      job,
      claimed.leaseToken,
      randomUUID(),
      { manifest: artifact, text: artifact },
    ]);
    return id;
  };
  const searchJob = async (documentId: string) =>
    (
      await db.owner.query(
        `select id, status from caseflow.search_index_jobs where document_id = $1
         order by created_at desc, id desc limit 1`,
        [documentId],
      )
    ).rows[0] as { id: string; status: string };
  // Plays the indexer: claim, save chunks, then embed with the given axes (null = no embedding).
  const index = async (
    documentId: string,
    chunks: { page: number; text: string; axis: number | null }[],
  ) => {
    const job = await searchJob(documentId);
    const claim = (await db.owner.query('select caseflow.claim_search_job($1) value', [job.id]))
      .rows[0].value;
    assert.equal(claim.disposition, 'claimed');
    assert.equal(claim.source.versionId, 'saved-private-text');
    await db.owner.query('select caseflow.save_search_chunks($1,$2,$3)', [
      job.id,
      claim.leaseToken,
      JSON.stringify(chunks.map(({ page, text }) => ({ page, start: 0, text }))),
    ]);
    const pending = (
      await db.owner.query('select caseflow.pending_search_chunks($1,$2,100) value', [
        job.id,
        claim.leaseToken,
      ])
    ).rows[0].value as { id: string; text: string }[];
    assert.equal(pending.length, chunks.length);
    const vectors = pending
      .map((chunk, position) => ({ chunk, axis: chunks[position]!.axis }))
      .filter((entry) => entry.axis !== null)
      .map(({ chunk, axis: value }) => ({ id: chunk.id, embedding: axis(value!) }));
    if (vectors.length) {
      const reservation = (
        await db.owner.query('select caseflow.reserve_search_usage($1,$2,$3) value', [
          job.id,
          claim.leaseToken,
          100,
        ])
      ).rows[0].value;
      assert.equal(reservation.allowed, true);
      await db.owner.query('select caseflow.save_search_embeddings($1,$2,$3)', [
        job.id,
        claim.leaseToken,
        JSON.stringify(vectors),
      ]);
      await db.owner.query('select caseflow.settle_search_usage($1,$2)', [
        reservation.reservationId,
        40,
      ]);
    }
    return { job, claim };
  };

  const assigned = await newCase('Rear-end collision', true);
  const unassigned = await newCase('Grocery slip and fall', false);
  const archived = await newCase('Archived bicycle case', true);

  const mri = await processedDocument(assigned.id, '02-treatment-record.pdf');
  const bill = await processedDocument(assigned.id, '03-itemized-bill.pdf');
  const other = await processedDocument(unassigned.id, '01-incident-report.pdf');
  const old = await processedDocument(archived.id, '01-incident-report.pdf');

  await t.test(
    'processing completion queues one search job and dispatch per document',
    async () => {
      const job = await searchJob(mri);
      assert.equal(job.status, 'queued');
      const dispatch = await db.owner.query(
        'select status from caseflow.search_dispatches where job_id = $1',
        [job.id],
      );
      assert.equal(dispatch.rows[0].status, 'pending');
      const claimed = await db.owner.query('select * from caseflow.claim_search_dispatches(25)');
      assert.ok(claimed.rows.some((row) => row.job_id === job.id));
    },
  );

  await index(mri, [
    { page: 1, text: 'MRI of the lumbar spine showed a mild disc bulge at L4-5.', axis: 1 },
    { page: 2, text: 'Physical therapy twice weekly was recommended for six weeks.', axis: 2 },
  ]);
  await index(bill, [
    { page: 1, text: 'Itemized statement: emergency department visit charges.', axis: 3 },
  ]);
  await index(other, [
    { page: 1, text: 'Lumbar strain reported after the slip near aisle seven.', axis: 4 },
  ]);
  await index(old, [
    { page: 1, text: 'Cyclist reported lumbar pain after the door opened.', axis: 5 },
  ]);
  await execute('admin', Operation.ArchiveCase, {
    id: archived.id,
    expectedVersion: archived.version,
  });

  await t.test('indexing completes and the document list reports it', async () => {
    assert.equal((await searchJob(mri)).status, 'ready');
    const response = await call('GET', `/cases/${assigned.id}/documents`, 'staff');
    const page = documentPageSchema.parse(response.json());
    const item = page.items.find((document) => document.id === mri)!;
    assert.deepEqual(item.searchIndex, { status: 'ready', chunkCount: 2, embeddedCount: 2 });
  });

  await t.test(
    'keyword search returns only cases the user can access, with highlights',
    async () => {
      const admin = await search({ q: 'lumbar', mode: 'keyword' });
      assert.deepEqual(
        new Set(admin.items.map((item) => item.caseId)),
        new Set([assigned.id, unassigned.id]),
      );
      assert.equal(admin.semanticAvailable, false);
      const staff = await search({ q: 'lumbar', mode: 'keyword' }, 'staff');
      assert.deepEqual(
        staff.items.map((item) => [item.documentId, item.page, item.matchedBy]),
        [[mri, 1, SearchMatch.Keyword]],
      );
      const [hit] = staff.items;
      assert.ok(hit!.highlights.length > 0);
      for (const range of hit!.highlights) {
        assert.match(hit!.snippet.slice(range.start, range.end), /lumbar/i);
      }
      assert.equal(hit!.caseNumber, assigned.caseNumber);
      assert.equal(hit!.filename, '02-treatment-record.pdf');
      assert.equal((await search({ q: 'lumbar', mode: 'keyword' }, 'outsider')).total, 0);
      assert.equal(embedded.length, 0);
    },
  );

  await t.test('case filter scopes results and hides inaccessible cases', async () => {
    const scoped = await search({ q: 'lumbar', mode: 'keyword', caseId: assigned.id });
    assert.deepEqual(
      scoped.items.map((item) => item.documentId),
      [mri],
    );
    const forbidden = await call(
      'GET',
      `/search?${new URLSearchParams({ q: 'lumbar', caseId: unassigned.id })}`,
      'staff',
    );
    assert.equal(forbidden.statusCode, 404);
    const unknown = await call(
      'GET',
      `/search?${new URLSearchParams({ q: 'lumbar', caseId: randomUUID() })}`,
    );
    assert.equal(unknown.statusCode, 404);
  });

  await t.test(
    'archived cases are excluded by default but remain searchable on request',
    async () => {
      const current = await search({ q: 'lumbar', mode: 'keyword' }, 'staff');
      assert.ok(!current.items.some((item) => item.caseId === archived.id));
      const all = await search({ q: 'lumbar', mode: 'keyword', archive: 'all' }, 'staff');
      const archivedHit = all.items.find((item) => item.caseId === archived.id);
      assert.equal(archivedHit?.caseArchived, true);
      const direct = await search({ q: 'cyclist', mode: 'keyword', caseId: archived.id }, 'staff');
      assert.equal(direct.total, 1);
    },
  );

  await t.test('hybrid search fuses semantic matches without keyword overlap', async () => {
    queryVector = axis(2);
    const hybrid = await search({ q: 'rehabilitation plan' }, 'staff');
    assert.equal(hybrid.semanticAvailable, true);
    assert.equal(hybrid.items[0]?.documentId, mri);
    assert.equal(hybrid.items[0]?.page, 2);
    assert.equal(hybrid.items[0]?.matchedBy, SearchMatch.Semantic);
    assert.ok(!hybrid.items.some((item) => item.caseId === unassigned.id));

    queryVector = axis(1);
    const both = await search({ q: 'lumbar' }, 'staff');
    assert.equal(both.items[0]?.matchedBy, SearchMatch.Both);

    queryVector = null;
    const fallback = await search({ q: 'lumbar' }, 'staff');
    assert.equal(fallback.semanticAvailable, false);
    assert.ok(fallback.items.every((item) => item.matchedBy === SearchMatch.Keyword));
    assert.equal(fallback.looseMatches, false);
  });

  await t.test(
    'short queries need closer meaning matches and weak matches are flagged',
    async () => {
      // 0.34 is how close an unrelated incident report of the same kind scored for "car accident".
      queryVector = similarTo(2, 0.34);
      const short = await search({ q: 'zephyr quorum' }, 'staff');
      assert.equal(short.total, 0);
      assert.equal(short.looseMatches, false);

      const longer = await search({ q: 'zephyr quorum nimbus vortex' }, 'staff');
      assert.equal(longer.items[0]?.documentId, mri);
      assert.equal(longer.items[0]?.matchedBy, SearchMatch.Semantic);
      assert.equal(longer.looseMatches, true);

      queryVector = similarTo(2, 0.45);
      const strong = await search({ q: 'zephyr quorum' }, 'staff');
      assert.equal(strong.items[0]?.documentId, mri);
      assert.equal(strong.looseMatches, false);

      // An exact-word match means the results are not merely loosely related.
      queryVector = similarTo(2, 0.34);
      const withKeyword = await search({ q: 'physical therapy weekly recommended' }, 'staff');
      assert.equal(withKeyword.items[0]?.matchedBy, SearchMatch.Both);
      assert.equal(withKeyword.looseMatches, false);
      queryVector = null;
    },
  );

  await t.test('removed documents disappear from search for everyone', async () => {
    const listed = documentPageSchema.parse(
      (await call('GET', `/cases/${assigned.id}/documents`)).json(),
    );
    const version = listed.items.find((item) => item.id === bill)!.version;
    await execute('admin', Operation.RemoveDocument, {
      caseId: assigned.id,
      documentId: bill,
      expectedVersion: version,
    });
    for (const subject of ['admin', 'staff']) {
      const page = await search({ q: 'itemized', mode: 'keyword' }, subject);
      assert.equal(page.total, 0, subject);
    }
  });

  await t.test('validation rejects short queries and unknown fields', async () => {
    assert.equal((await call('GET', '/search?q=a')).statusCode, 400);
    assert.equal((await call('GET', '/search?q=lumbar&extra=1')).statusCode, 400);
    assert.equal((await call('GET', '/search?q=lumbar&pageSize=500')).statusCode, 400);
  });

  await t.test('administrators can re-index; Staff cannot', async () => {
    const path = `/cases/${assigned.id}/documents/${mri}/search-index`;
    assert.equal((await call('POST', path, 'staff')).statusCode, 403);
    const ready = await call('POST', path);
    assert.equal(ready.statusCode, 200, ready.body);
    assert.equal(searchIndexSummarySchema.parse(ready.json()).status, 'ready');

    // A failed embedding run leaves keyword search available (partial), then re-indexing queues anew.
    const partial = await processedDocument(assigned.id, '04-follow-up.pdf');
    const job = await searchJob(partial);
    const claim = (await db.owner.query('select caseflow.claim_search_job($1) value', [job.id]))
      .rows[0].value;
    await db.owner.query('select caseflow.save_search_chunks($1,$2,$3)', [
      job.id,
      claim.leaseToken,
      JSON.stringify([
        { page: 1, start: 0, text: 'Follow-up visit noted improved range of motion.' },
      ]),
    ]);
    await db.owner.query("select caseflow.fail_search_job($1,$2,'provider_unavailable')", [
      job.id,
      claim.leaseToken,
    ]);
    assert.equal((await searchJob(partial)).status, 'partial');
    assert.equal((await search({ q: 'range of motion', mode: 'keyword' }, 'staff')).total, 1);

    const requeued = await call('POST', `/cases/${assigned.id}/documents/${partial}/search-index`);
    assert.equal(searchIndexSummarySchema.parse(requeued.json()).status, 'queued');
    const audit = await db.owner.query(
      "select count(*)::int as count from caseflow.audit_events where action = 'document.search_index_queued' and target_id = $1",
      [partial],
    );
    assert.equal(audit.rows[0].count, 1);
  });

  await t.test(
    'worker functions reject stale leases and the runtime cannot call them',
    async () => {
      const job = await searchJob(mri);
      await assert.rejects(
        db.owner.query('select caseflow.save_search_chunks($1,$2,$3)', [
          job.id,
          randomUUID(),
          '[]',
        ]),
        /SEARCH_INDEX_CONFLICT/,
      );
      await assert.rejects(
        db.runtime.query('select caseflow.claim_search_job($1)', [job.id]),
        /permission denied/,
      );
      await assert.rejects(
        db.runtime.query('select caseflow.enqueue_search_backfill(10)'),
        /permission denied/,
      );
    },
  );
});
