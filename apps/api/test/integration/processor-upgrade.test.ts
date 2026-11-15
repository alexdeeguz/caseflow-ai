import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { auditPageSchema, Role } from '@caseflow/schemas';
import { executeOperation } from '../../src/database/queries.js';
import { Operation } from '../../src/database/operations.js';
import { createTestDatabase } from './database-fixture.js';

test('processor migration preserves existing jobs, dispatches, documents and audit history', async () => {
  const addedJobColumns = [
    'pipeline_version',
    'collection_attempt_count',
    'ocr_request',
    'ocr_requested_at',
    'ocr_page_count',
    'textract_job_id',
    'textract_started_at',
  ];
  const snapshotSql = `select jsonb_build_object(
    'users', (select jsonb_agg(u order by id) from caseflow.users u),
    'cases', (select jsonb_agg(c order by id) from caseflow.cases c where title='Processor upgrade fixture'),
    'assignments', (select jsonb_agg(a order by case_id,user_id) from caseflow.assignments a),
    'documents', (select jsonb_agg(d order by id) from caseflow.documents d),
    'sessions', (select jsonb_agg(s order by id) from caseflow.document_upload_sessions s),
    'jobs', (select jsonb_agg(to_jsonb(j)-$1::text[] order by id) from caseflow.document_processing_jobs j),
    'dispatches', (select jsonb_agg(d order by id) from caseflow.processing_dispatches d),
    'audit', (select jsonb_agg(to_jsonb(a)-'service_name' order by id) from caseflow.audit_events a)
  ) snapshot`;
  let snapshot: unknown;
  const db = await createTestDatabase(async (owner) => {
    const user = randomUUID();
    const record = randomUUID();
    await owner.query(
      "insert into caseflow.users(id,tenant_id,subject,display_name) values($1,$2,'upgrade','Fictional User')",
      [user, randomUUID()],
    );
    await owner.query(
      "insert into caseflow.cases(id,title,client_name) values($1,'Processor upgrade fixture','Fictional Client')",
      [record],
    );
    await owner.query('insert into caseflow.assignments(case_id,user_id) values($1,$2)', [
      record,
      user,
    ]);
    const document = (
      await owner.query(
        `insert into caseflow.documents(case_id,uploaded_by,filename,content_type,
      size_bytes,storage_bucket,storage_environment,status,uploaded_at,object_version_id,checksum_sha256,upload_request_id)
      values($1,$2,'upgrade.pdf','application/pdf',20,'caseflow-test-documents','dev','available',now(),'saved-source',$3,gen_random_uuid())
      returning id`,
        [record, user, createHash('sha256').update('upgrade').digest('base64')],
      )
    ).rows[0];
    await owner.query(
      "insert into caseflow.document_upload_sessions(document_id,status,expires_at,finished_at) values($1,'completed',now()+interval '5 minutes',now())",
      [document.id],
    );
    const initial = (
      await owner.query('select caseflow.enqueue_document_processing($1,$2,null) id', [
        document.id,
        user,
      ])
    ).rows[0];
    await owner.query(
      "update caseflow.document_processing_jobs set status='failed',failure_code='internal_error',finished_at=clock_timestamp(),updated_at=clock_timestamp() where id=$1",
      [initial.id],
    );
    await owner.query('select caseflow.enqueue_document_processing($1,$2,$3)', [
      document.id,
      user,
      initial.id,
    ]);
    const client = await owner.connect();
    try {
      const page = auditPageSchema.parse(
        await executeOperation(
          client,
          { id: user, displayName: 'Fictional User', role: Role.Admin, active: true },
          Operation.ListAudit,
          { page: 1, pageSize: 25 },
        ),
      );
      assert.ok(page.items.length > 0);
      assert.ok(page.items.every((event) => event.serviceName === null));
    } finally {
      client.release();
    }
    snapshot = (await owner.query(snapshotSql, [addedJobColumns])).rows[0].snapshot;
  }, 'document_processing_foundation.sql');

  try {
    await db.owner.query(db.seed);
    await db.owner.query(db.seed);
    assert.deepEqual(
      (await db.owner.query(snapshotSql, [addedJobColumns])).rows[0].snapshot,
      snapshot,
    );
    const jobs = (await db.owner.query('select * from caseflow.document_processing_jobs')).rows;
    assert.equal(jobs.length, 2);
    assert.ok(
      jobs.every(
        (job) =>
          job.pipeline_version === '1' &&
          job.collection_attempt_count === 0 &&
          job.ocr_request === null,
      ),
    );
    for (const table of [
      'processing_ocr_days',
      'processing_ocr_reservations',
      'document_processing_results',
    ]) {
      assert.equal(
        (await db.owner.query(`select count(*)::int n from caseflow.${table}`)).rows[0].n,
        0,
      );
    }
    const processor = (
      await db.owner.query(
        "select rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls from pg_roles where rolname='caseflow_processor'",
      )
    ).rows[0];
    assert.ok(Object.values(processor).every((flag) => flag === false));
  } finally {
    await db.close();
  }
});
