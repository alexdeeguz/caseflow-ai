import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createTestDatabase } from './database-fixture.js';

const snapshotSql = `select jsonb_build_object(
  'users', (select jsonb_agg(u order by id) from caseflow.users u),
  'documents', (select jsonb_agg(d order by id) from caseflow.documents d),
  'jobs', (select jsonb_agg(j order by id) from caseflow.document_processing_jobs j),
  'results', (select jsonb_agg(r order by job_id) from caseflow.document_processing_results r),
  'dispatches', (select jsonb_agg(d order by id) from caseflow.processing_dispatches d),
  'audit', (select jsonb_agg(a order by id) from caseflow.audit_events a)
) snapshot`;

test('processing API migration preserves persisted results, jobs and audit history', async () => {
  let snapshot: unknown;
  const checksum = createHash('sha256').update('fictional upgrade fixture').digest('base64');
  const db = await createTestDatabase(async (owner) => {
    const user = randomUUID();
    const caseId = randomUUID();
    await owner.query(
      "insert into caseflow.users(id,tenant_id,subject,display_name) values($1,$2,'upgrade','Fictional User')",
      [user, randomUUID()],
    );
    await owner.query(
      "insert into caseflow.cases(id,title,client_name) values($1,'Processing summary upgrade','Fictional Client')",
      [caseId],
    );
    const document = (
      await owner.query(
        `insert into caseflow.documents(case_id,uploaded_by,filename,content_type,size_bytes,
      storage_bucket,storage_environment,status,uploaded_at,object_version_id,checksum_sha256,upload_request_id)
      values($1,$2,'upgrade.pdf','application/pdf',20,'caseflow-test-documents','dev','available',now(),'saved-source',$3,gen_random_uuid()) returning id`,
        [caseId, user, checksum],
      )
    ).rows[0];
    const job = (
      await owner.query('select caseflow.enqueue_document_processing($1,$2,null) id', [
        document.id,
        user,
      ])
    ).rows[0];
    const claim = (
      await owner.query('select caseflow.claim_document_processing($1) claim', [job.id])
    ).rows[0].claim;
    const artifact = { versionId: 'saved-artifact', checksumSha256: checksum, sizeBytes: 100 };
    await owner.query("select caseflow.complete_document_processing($1,$2,'native',1,$3,$4)", [
      job.id,
      claim.leaseToken,
      randomUUID(),
      { manifest: artifact, text: artifact },
    ]);
    snapshot = (await owner.query(snapshotSql)).rows[0].snapshot;
    assert.equal(
      (
        await owner.query(
          "select has_any_column_privilege('caseflow_runtime','caseflow.document_processing_results','SELECT') allowed",
        )
      ).rows[0].allowed,
      false,
    );
  }, 'textract_completion_correlation.sql');

  try {
    await db.owner.query(db.seed);
    await db.owner.query(db.seed);
    assert.deepEqual((await db.owner.query(snapshotSql)).rows[0].snapshot, snapshot);
    const columns = (
      await db.owner.query(`select attname from pg_attribute
      where attrelid='caseflow.document_processing_results'::regclass and attnum>0 and not attisdropped
        and has_column_privilege('caseflow_runtime',attrelid,attnum,'SELECT') order by attname`)
    ).rows.map((row) => row.attname);
    assert.deepEqual(columns, ['extraction_method', 'job_id', 'page_count', 'pipeline_version']);
    const policy = (
      await db.owner.query(`select roles,cmd from pg_policies
      where schemaname='caseflow' and tablename='document_processing_results'`)
    ).rows;
    assert.deepEqual(policy, [{ roles: '{caseflow_runtime}', cmd: 'SELECT' }]);
    assert.equal(
      (
        await db.owner.query(
          "select relrowsecurity from pg_class where oid='caseflow.document_processing_results'::regclass",
        )
      ).rows[0].relrowsecurity,
      true,
    );
  } finally {
    await db.close();
  }
});
