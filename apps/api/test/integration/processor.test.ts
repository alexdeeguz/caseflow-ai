import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { auditPageSchema, caseSchema, Role, userSchema } from '@caseflow/schemas';
import { parseUploadRecord } from '../../src/database/documents.js';
import { Operation } from '../../src/database/operations.js';
import { createTestDatabase } from './database-fixture.js';

const checksum = createHash('sha256').update('fictional processor fixture').digest('base64');
const topicArn = 'arn:aws:sns:us-east-2:123456789012:AmazonTextract-caseflow-completion';
const roleArn = 'arn:aws:iam::123456789012:role/CaseFlowTextractNotifications';

test('processor database: restricted leases, OCR reservations, results and cancellation', async (t) => {
  const db = await createTestDatabase();
  const login = `processor_test_${randomUUID().replaceAll('-', '')}`;
  const password = randomBytes(24).toString('hex');
  await db.owner.query(`create role ${login} login inherit nosuperuser nocreatedb nocreaterole
    noreplication nobypassrls password '${password}'`);
  await db.owner.query(`grant caseflow_processor to ${login} with inherit true, set false`);
  const processorUrl = new URL(db.runtimeUrl);
  processorUrl.username = login;
  processorUrl.password = password;
  const processor = new Pool({ connectionString: processorUrl.href, max: 8 });
  const tenantId = randomUUID();
  const execute = (subject: string, operation: Operation, input: Record<string, unknown> = {}) =>
    db.store.execute({ tenantId, subject, name: subject }, operation, input);
  const call = async (sql: string, values: unknown[] = []) =>
    (await processor.query(sql, values)).rows[0].result;
  const claim = (id: string) => call('select caseflow.claim_document_processing($1) result', [id]);
  const collect = (id: string, provider: string) =>
    call('select caseflow.claim_document_collection($1,$2) result', [id, provider]);
  const prepare = (id: string, token: string, pages = 2) =>
    call('select caseflow.prepare_document_ocr($1,$2,$3,$4,$5) result', [
      id,
      token,
      pages,
      topicArn,
      roleArn,
    ]);
  const bind = (id: string, token: string, provider: string) =>
    call('select caseflow.bind_document_textract_job($1,$2,$3) result', [id, token, provider]);
  const renew = (id: string, token: string) =>
    call('select caseflow.renew_document_processing_lease($1,$2) result', [id, token]);
  const fail = (id: string, token: string, reason = 'invalid_document') =>
    call('select caseflow.fail_document_processing($1,$2,$3) result', [id, token, reason]);
  const artifact = {
    versionId: 'saved-artifact-version',
    checksumSha256: checksum,
    sizeBytes: 100,
  };
  const artifacts = (method: 'native' | 'ocr') => ({
    manifest: artifact,
    text: artifact,
    ...(method === 'ocr' ? { ocr: artifact } : {}),
  });
  const complete = (
    id: string,
    token: string,
    method: 'native' | 'ocr' = 'native',
    pages = 2,
    references: unknown = artifacts(method),
    artifactSet = randomUUID(),
  ) =>
    call('select caseflow.complete_document_processing($1,$2,$3,$4,$5,$6) result', [
      id,
      token,
      method,
      pages,
      artifactSet,
      references,
    ]);
  const savedJob = async (id: string) =>
    (await db.owner.query('select * from caseflow.document_processing_jobs where id=$1', [id]))
      .rows[0];
  const expire = (id: string) =>
    db.owner.query(
      "update caseflow.document_processing_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [id],
    );

  async function newJob(contentType = 'application/pdf') {
    const record = caseSchema.parse(
      await execute('admin', Operation.CreateCase, {
        title: 'Processor fixture',
        clientName: 'Fictional Client',
      }),
    );
    const upload = parseUploadRecord(
      await execute('admin', Operation.StartDocumentUpload, {
        caseId: record.id,
        requestId: randomUUID(),
        filename: contentType === 'application/pdf' ? 'fixture.pdf' : 'fixture.png',
        contentType,
        sizeBytes: 28,
        checksumSha256: checksum,
        bucket: 'caseflow-test-documents',
        environment: 'dev',
      }),
    );
    const client = await db.runtime.connect();
    try {
      await client.query('begin');
      await client.query(
        "select set_config('caseflow.tenant_id',$1,true), set_config('caseflow.subject','admin',true)",
        [tenantId],
      );
      await client.query('select caseflow.complete_document_upload($1,$2,$3)', [
        record.id,
        upload.session.id,
        'original-version',
      ]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    const job = (
      await db.owner.query(
        'select id from caseflow.document_processing_jobs where document_id=$1',
        [upload.document.id],
      )
    ).rows[0];
    return {
      id: job.id as string,
      documentId: upload.document.id,
      caseId: record.id,
      sessionId: upload.session.id,
    };
  }

  try {
    const admin = userSchema.parse(await execute('admin', Operation.GetProfile));
    const superAdmin = userSchema.parse(await execute('super', Operation.GetProfile));
    const staff = userSchema.parse(await execute('staff', Operation.GetProfile));
    await db.owner.query('select caseflow.operator_set_role($1,$2)', [
      superAdmin.id,
      Role.SuperAdmin,
    ]);
    await db.owner.query('select caseflow.operator_set_role($1,$2)', [admin.id, Role.Admin]);
    assert.equal((await processor.query('select current_user')).rows[0].current_user, login);

    await t.test(
      'claims serialize and fence stale leases without trusting application identity',
      async () => {
        const job = await newJob();
        const claims = await Promise.all([claim(job.id), claim(job.id)]);
        const first = claims.find((row) => row.outcome === 'claimed');
        assert.deepEqual(claims.map((row) => row.outcome).sort(), ['busy', 'claimed']);
        assert.equal(first.attemptCount, 1);
        assert.equal(first.sourceVersionId, 'original-version');
        assert.equal(first.sourceChecksumSha256, checksum);
        assert.match(first.artifactPrefix, new RegExp(`/processed/${job.id}/$`));
        assert.ok(Date.parse(first.leaseExpiresAt) > Date.now() + 170_000);
        assert.equal(await renew(job.id, randomUUID()), false);
        assert.equal(await renew(job.id, first.leaseToken), true);
        await expire(job.id);
        assert.equal(await complete(job.id, first.leaseToken), false);
        assert.equal(await renew(job.id, first.leaseToken), false);
        const second = await claim(job.id);
        assert.notEqual(second.leaseToken, first.leaseToken);
        assert.equal(second.attemptCount, 2);
        assert.equal(await fail(job.id, first.leaseToken), false);
        assert.equal(await complete(job.id, second.leaseToken), true);
        assert.equal(await complete(job.id, second.leaseToken), false);
        assert.equal((await claim(job.id)).outcome, 'terminal');
        const result = (
          await db.owner.query(
            'select * from caseflow.document_processing_results where job_id=$1',
            [job.id],
          )
        ).rows[0];
        assert.equal(result.extraction_method, 'native');
        assert.equal(result.artifacts.text.versionId, artifact.versionId);
        assert.equal(
          result.artifacts.text.key,
          `${first.artifactPrefix}${result.artifact_set_id}/text.json`,
        );
        assert.equal(
          (await db.owner.query('select count(*)::int n from caseflow.processing_ocr_reservations'))
            .rows[0].n,
          0,
        );
      },
    );

    await t.test(
      'OCR intent is immutable, collection is separately leased, and early notifications retry',
      async () => {
        const job = await newJob();
        const first = await claim(job.id);
        await assert.rejects(collect(job.id, 'provider-one'), /PROCESSING_CONFLICT/);
        await assert.rejects(bind(job.id, first.leaseToken, 'provider-one'), /PROCESSING_CONFLICT/);
        const prepared = await prepare(job.id, first.leaseToken);
        assert.equal((await collect(job.id, 'provider-one')).outcome, 'awaiting_binding');
        assert.equal(prepared.request.clientRequestToken, job.id);
        assert.equal(prepared.request.versionId, 'original-version');
        assert.deepEqual(await prepare(job.id, first.leaseToken), prepared);
        await assert.rejects(prepare(job.id, first.leaseToken, 3), /PROCESSING_CONFLICT/);
        await assert.rejects(complete(job.id, first.leaseToken), /PROCESSING_CONFLICT/);
        await expire(job.id);
        const retry = await claim(job.id);
        assert.deepEqual(retry.ocrRequest, prepared.request);
        assert.deepEqual(await prepare(job.id, retry.leaseToken), prepared);
        assert.equal(await bind(job.id, first.leaseToken, 'provider-one'), false);
        assert.equal(await bind(job.id, retry.leaseToken, 'provider-one'), true);
        assert.equal((await claim(job.id)).outcome, 'waiting');
        await assert.rejects(collect(job.id, 'wrong-provider'), /PROCESSING_CONFLICT/);
        const collections = await Promise.all([
          collect(job.id, 'provider-one'),
          collect(job.id, 'provider-one'),
        ]);
        const collector = collections.find((row) => row.outcome === 'claimed');
        assert.deepEqual(collections.map((row) => row.outcome).sort(), ['busy', 'claimed']);
        assert.equal(collector.collectionAttemptCount, 1);
        assert.equal(collector.attemptCount, 2);
        await expire(job.id);
        const next = await collect(job.id, 'provider-one');
        assert.equal(next.collectionAttemptCount, 2);
        assert.equal(await complete(job.id, collector.leaseToken, 'ocr'), false);
        await assert.rejects(complete(job.id, next.leaseToken, 'ocr', 3), /PROCESSING_CONFLICT/);
        assert.equal(await complete(job.id, next.leaseToken, 'ocr'), true);
        assert.equal((await collect(job.id, 'provider-one')).outcome, 'terminal');
        await assert.rejects(collect(job.id, 'wrong-provider'), /PROCESSING_CONFLICT/);
        const reservations = await db.owner.query(
          'select * from caseflow.processing_ocr_reservations where job_id=$1',
          [job.id],
        );
        assert.equal(reservations.rowCount, 1);
        assert.equal(reservations.rows[0].page_count, 2);
      },
    );

    await t.test(
      'both phases exhaust five claims and OCR intent cannot be restarted after its deadline',
      async () => {
        for (const phase of ['extracting', 'collecting']) {
          const job = await newJob();
          let current = await claim(job.id);
          if (phase === 'collecting') {
            await prepare(job.id, current.leaseToken);
            await bind(job.id, current.leaseToken, job.id);
            current = await collect(job.id, job.id);
          }
          for (let count = 1; count <= 5; count++) {
            assert.equal(
              current[phase === 'extracting' ? 'attemptCount' : 'collectionAttemptCount'],
              count,
            );
            await expire(job.id);
            current = phase === 'extracting' ? await claim(job.id) : await collect(job.id, job.id);
          }
          assert.equal(current.status, 'failed');
          assert.equal(current.failureCode, 'attempts_exhausted');
          assert.equal((await savedJob(job.id)).lease_token, null);
        }
        const job = await newJob();
        const current = await claim(job.id);
        await prepare(job.id, current.leaseToken);
        await db.owner.query(
          "update caseflow.document_processing_jobs set ocr_requested_at=now()-interval '6 days',lease_expires_at=now()-interval '1 second' where id=$1",
          [job.id],
        );
        assert.equal((await claim(job.id)).failureCode, 'ocr_results_expired');
      },
    );

    await t.test(
      'invalid parameters and forged artifact metadata cannot change a job',
      async () => {
        const job = await newJob();
        const current = await claim(job.id);
        await assert.rejects(claim(randomUUID()), /NOT_FOUND/);
        for (const pages of [0, 21, null]) {
          await assert.rejects(
            call('select caseflow.prepare_document_ocr($1,$2,$3,$4,$5) result', [
              job.id,
              current.leaseToken,
              pages,
              topicArn,
              roleArn,
            ]),
            /INVALID_INPUT/,
          );
        }
        await assert.rejects(
          call('select caseflow.prepare_document_ocr($1,$2,$3,$4,$5) result', [
            job.id,
            current.leaseToken,
            2,
            topicArn,
            roleArn.replace('123456789012', '999999999999'),
          ]),
          /INVALID_INPUT/,
        );
        for (const value of [
          {},
          [],
          { ...artifacts('native'), extra: artifact },
          { manifest: artifact, text: { ...artifact, key: 'forged' } },
          { manifest: artifact, text: { ...artifact, versionId: null } },
          { manifest: artifact, text: { ...artifact, versionId: 'null' } },
          { manifest: artifact, text: { ...artifact, versionId: 'header\r\ninjection' } },
          { manifest: artifact, text: { ...artifact, checksumSha256: 'invalid' } },
          { manifest: artifact, text: { ...artifact, sizeBytes: -1 } },
          { manifest: artifact, text: { ...artifact, sizeBytes: 1.5 } },
          { manifest: artifact, text: { ...artifact, sizeBytes: 52428800 } },
        ]) {
          await assert.rejects(
            complete(job.id, current.leaseToken, 'native', 2, value),
            /INVALID_INPUT/,
          );
        }
        await assert.rejects(
          fail(job.id, current.leaseToken, 'private provider details'),
          /INVALID_INPUT/,
        );
        assert.equal((await savedJob(job.id)).status, 'processing');
        const image = await newJob('image/png');
        const imageClaim = await claim(image.id);
        await assert.rejects(prepare(image.id, imageClaim.leaseToken, 2), /INVALID_INPUT/);
        await assert.rejects(
          complete(image.id, imageClaim.leaseToken, 'native', 1),
          /PROCESSING_CONFLICT/,
        );
        await prepare(image.id, imageClaim.leaseToken, 1);
      },
    );

    await t.test(
      'removal and archival cancel jobs atomically, preserve results, and restoration never revives work',
      async () => {
        for (const action of ['remove', 'archive']) {
          const job = await newJob();
          const current = await claim(job.id);
          if (action === 'remove') {
            await execute('admin', Operation.RemoveDocument, {
              caseId: job.caseId,
              documentId: job.documentId,
              expectedVersion: 2,
            });
            await execute('admin', Operation.RestoreDocument, {
              caseId: job.caseId,
              documentId: job.documentId,
              expectedVersion: 3,
            });
          } else {
            await execute('admin', Operation.ArchiveCase, { id: job.caseId, expectedVersion: 1 });
            await execute('admin', Operation.RestoreCase, { id: job.caseId, expectedVersion: 2 });
          }
          assert.equal((await savedJob(job.id)).status, 'cancelled');
          assert.equal(await complete(job.id, current.leaseToken), false);
          assert.equal(await fail(job.id, current.leaseToken), false);
          assert.equal((await claim(job.id)).status, 'cancelled');
          const document = (
            await db.owner.query('select * from caseflow.documents where id=$1', [job.documentId])
          ).rows[0];
          assert.equal(document.status, 'available');
          assert.equal(document.object_version_id, 'original-version');
          assert.equal(
            (
              await db.owner.query(
                'select status from caseflow.document_upload_sessions where id=$1',
                [job.sessionId],
              )
            ).rows[0].status,
            'completed',
          );
        }
        const ready = await newJob();
        const readyClaim = await claim(ready.id);
        await complete(ready.id, readyClaim.leaseToken);
        await execute('admin', Operation.ArchiveCase, { id: ready.caseId, expectedVersion: 1 });
        assert.equal((await savedJob(ready.id)).status, 'ready');
        assert.equal(
          (
            await db.owner.query(
              'select count(*)::int n from caseflow.document_processing_results where job_id=$1',
              [ready.id],
            )
          ).rows[0].n,
          1,
        );
        const waiting = await newJob();
        const waitingClaim = await claim(waiting.id);
        await prepare(waiting.id, waitingClaim.leaseToken);
        await bind(waiting.id, waitingClaim.leaseToken, waiting.id);
        await execute('admin', Operation.RemoveDocument, {
          caseId: waiting.caseId,
          documentId: waiting.documentId,
          expectedVersion: 2,
        });
        assert.equal((await collect(waiting.id, waiting.id)).status, 'cancelled');
      },
    );

    await t.test(
      'an administrative change winning the permission lock fences a waiting worker',
      async () => {
        const job = await newJob();
        const current = await claim(job.id);
        const blocker = await db.owner.connect();
        try {
          await blocker.query('begin');
          await blocker.query(
            "select pg_advisory_xact_lock(734921,1),set_config('caseflow.tenant_id',$1,true),set_config('caseflow.subject','admin',true)",
            [tenantId],
          );
          const pending = complete(job.id, current.leaseToken);
          const deadline = Date.now() + 3000;
          while (
            !(
              await db.owner.query(
                "select 1 from pg_stat_activity where datname=current_database() and usename=$1 and wait_event='advisory'",
                [login],
              )
            ).rowCount
          ) {
            assert.ok(Date.now() < deadline, 'Worker did not wait for the permission lock');
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          await blocker.query('select caseflow.set_document_removed($1,$2,2,true)', [
            job.caseId,
            job.documentId,
          ]);
          await blocker.query('select caseflow.set_document_removed($1,$2,3,false)', [
            job.caseId,
            job.documentId,
          ]);
          await blocker.query('commit');
          assert.equal(await pending, false);
          assert.equal((await savedJob(job.id)).status, 'cancelled');
        } finally {
          await blocker.query('rollback');
          blocker.release();
        }
      },
    );

    await t.test(
      'accepted jobs survive requester disablement and do not impersonate the requester',
      async () => {
        const job = await newJob();
        await execute('super', Operation.UpdateAccess, { id: admin.id, active: false });
        try {
          const current = await claim(job.id);
          assert.equal(await complete(job.id, current.leaseToken), true);
          await assert.rejects(execute('admin', Operation.ListAudit), /disabled/);
        } finally {
          await execute('super', Operation.UpdateAccess, { id: admin.id, active: true });
        }
        const audit = auditPageSchema.parse(
          await execute('admin', Operation.ListAudit, { page: 1, pageSize: 100 }),
        );
        const event = audit.items.find(
          (row) =>
            row.targetId === job.documentId && row.action === 'document.processing_completed',
        );
        assert.ok(event);
        assert.equal(event.serviceName, 'document_processor');
        assert.equal(event.actorId, null);
        assert.equal(event.operatorName, null);
        const encoded = JSON.stringify(audit);
        for (const secret of [
          'original-version',
          artifact.versionId,
          topicArn,
          roleArn,
          'sourceKey',
          'leaseToken',
        ]) {
          assert.ok(!encoded.includes(secret));
        }
        await assert.rejects(execute('staff', Operation.ListAudit), /permission/);
        await execute('admin', Operation.AssignCase, { id: job.caseId, userId: staff.id });
      },
    );

    await t.test(
      'audit failure rolls back successful completion, failure and administrative cancellation',
      async () => {
        const job = await newJob();
        const current = await claim(job.id);
        await db.owner
          .query(`create function caseflow.reject_processor_audit() returns trigger language plpgsql as $$
        begin if new.service_name is not null then raise exception 'audit rollback fixture'; end if; return new; end $$;
        create trigger reject_processor_audit before insert on caseflow.audit_events
        for each row execute function caseflow.reject_processor_audit()`);
        try {
          await assert.rejects(complete(job.id, current.leaseToken), /audit rollback fixture/);
          await assert.rejects(fail(job.id, current.leaseToken), /audit rollback fixture/);
          await assert.rejects(
            execute('admin', Operation.RemoveDocument, {
              caseId: job.caseId,
              documentId: job.documentId,
              expectedVersion: 2,
            }),
          );
          await assert.rejects(
            execute('admin', Operation.ArchiveCase, { id: job.caseId, expectedVersion: 1 }),
          );
          assert.equal((await savedJob(job.id)).status, 'processing');
          assert.equal(
            (
              await db.owner.query(
                'select count(*)::int n from caseflow.document_processing_results where job_id=$1',
                [job.id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await db.owner.query('select version from caseflow.documents where id=$1', [
                job.documentId,
              ])
            ).rows[0].version,
            2,
          );
          assert.equal(
            (
              await db.owner.query('select archived_at from caseflow.cases where id=$1', [
                job.caseId,
              ])
            ).rows[0].archived_at,
            null,
          );
        } finally {
          await db.owner.query(
            'drop trigger reject_processor_audit on caseflow.audit_events; drop function caseflow.reject_processor_audit()',
          );
        }
        assert.equal(await fail(job.id, current.leaseToken), true);
        assert.equal(await fail(job.id, current.leaseToken), false);
      },
    );

    await t.test(
      'a source snapshot mismatch fails closed without accepting replacement bytes',
      async () => {
        const job = await newJob();
        await db.owner.query(
          "update caseflow.documents set object_version_id='replacement-version' where id=$1",
          [job.documentId],
        );
        assert.equal((await claim(job.id)).failureCode, 'invalid_document');
      },
    );

    await t.test(
      'concurrent OCR reservations never exceed 100 UTC pages; duplicates and day rollover are safe',
      async () => {
        const used = (
          await db.owner.query(
            'select coalesce(sum(page_count),0)::int n from caseflow.processing_ocr_reservations',
          )
        ).rows[0].n;
        const jobs = await Promise.all(Array.from({ length: 6 }, () => newJob()));
        const claims = await Promise.all(jobs.map((job) => claim(job.id)));
        const requests = await Promise.all(
          jobs.map((job, index) => prepare(job.id, claims[index].leaseToken, 20)),
        );
        assert.equal(
          requests.filter((row) => row.outcome === 'prepared').length,
          Math.floor((100 - used) / 20),
        );
        assert.ok(requests.some((row) => row.failureCode === 'ocr_budget_exceeded'));
        const remaining = (100 - used) % 20;
        if (remaining) {
          const job = await newJob();
          const current = await claim(job.id);
          assert.equal((await prepare(job.id, current.leaseToken, remaining)).outcome, 'prepared');
        }
        assert.equal(
          (
            await db.owner.query(
              'select sum(page_count)::int n from caseflow.processing_ocr_reservations',
            )
          ).rows[0].n,
          100,
        );
        assert.equal(
          (
            await db.owner.query(
              "select pages_reserved from caseflow.processing_ocr_days where day=(clock_timestamp() at time zone 'UTC')::date",
            )
          ).rows[0].pages_reserved,
          100,
        );
        const preparedIndex = requests.findIndex((row) => row.outcome === 'prepared');
        const preparedJob = jobs[preparedIndex];
        assert.ok(preparedJob);
        assert.deepEqual(
          await prepare(preparedJob.id, claims[preparedIndex].leaseToken, 20),
          requests[preparedIndex],
        );
        // Seed yesterday's reservations to exercise rollover without changing the database clock.
        await db.owner.query(`insert into caseflow.processing_ocr_days(day,pages_reserved)
        select day-1,pages_reserved from caseflow.processing_ocr_days;
        update caseflow.processing_ocr_reservations set day=day-1,reserved_at=reserved_at-interval '1 day';
        delete from caseflow.processing_ocr_days where day=(clock_timestamp() at time zone 'UTC')::date`);
        assert.equal(
          (await prepare(preparedJob.id, claims[preparedIndex].leaseToken, 20)).outcome,
          'prepared',
        );
        const next = await newJob();
        const nextClaim = await claim(next.id);
        const client = await processor.connect();
        try {
          await client.query('begin');
          await client.query("set local time zone 'Pacific/Kiritimati'");
          await client.query('select caseflow.prepare_document_ocr($1,$2,1,$3,$4)', [
            next.id,
            nextClaim.leaseToken,
            topicArn,
            roleArn,
          ]);
          await client.query('commit');
        } finally {
          await client.query('rollback');
          client.release();
        }
        assert.equal(
          (
            await db.owner.query(
              "select pages_reserved from caseflow.processing_ocr_days where day=(clock_timestamp() at time zone 'UTC')::date",
            )
          ).rows[0].pages_reserved,
          1,
        );
      },
    );

    await t.test(
      'database grants deny arbitrary reads/writes, helper calls and role escalation',
      async () => {
        for (const sql of [
          'select * from caseflow.documents',
          'select * from caseflow.users',
          'select * from caseflow.document_processing_jobs',
          'select * from caseflow.document_processing_results',
          'select * from caseflow.processing_ocr_days',
          'select * from caseflow.processing_ocr_reservations',
          'select * from caseflow.processing_dispatches',
          'update caseflow.document_processing_jobs set attempt_count=0',
          'select caseflow.lock_processing_job(null)',
          'select caseflow.end_processing_job(null,null,null)',
          'select caseflow.cancel_document_processing_jobs(null)',
          'select caseflow.processing_claim_payload(null,null)',
          'select caseflow.claim_processing_dispatches(1)',
          'select caseflow.request_document_processing(null,null,null)',
          'set role caseflow_runtime',
        ]) {
          await assert.rejects(processor.query(sql), /permission denied/);
        }
        for (const sql of [
          'select caseflow.claim_document_processing(null)',
          'select caseflow.prepare_document_ocr(null,null,1,null,null)',
          'select * from caseflow.document_processing_results',
          'select ocr_request from caseflow.document_processing_jobs',
        ]) {
          await assert.rejects(db.runtime.query(sql), /permission denied/);
        }
        const exposed = await db.owner
          .query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        cross join pg_roles r where n.nspname='caseflow'
        and r.rolname in ('anon','authenticated','service_role','caseflow_dispatcher')
        and p.proname in ('claim_document_processing','renew_document_processing_lease','prepare_document_ocr',
          'bind_document_textract_job','claim_document_collection','fail_document_processing','complete_document_processing')
        and has_function_privilege(r.oid,p.oid,'execute')`);
        assert.equal(exposed.rowCount, 0);
        const unsafe = await db.owner
          .query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='caseflow' and has_function_privilege('caseflow_processor',p.oid,'execute')
        and (not prosecdef or proconfig is distinct from array['search_path=""'])`);
        assert.equal(unsafe.rowCount, 0);
        assert.equal(
          (
            await db.owner.query(`select count(*)::int n from pg_class where oid in
        ('caseflow.processing_ocr_days'::regclass,'caseflow.processing_ocr_reservations'::regclass,
          'caseflow.document_processing_results'::regclass) and relrowsecurity`)
          ).rows[0].n,
          3,
        );
        await assert.rejects(
          db.owner.query("insert into caseflow.audit_events(target_id,action) values($1,'test')", [
            randomUUID(),
          ]),
          { code: '23514' },
        );
      },
    );
  } finally {
    await processor.end();
    await db.owner.query(`drop role ${login}`);
    await db.close();
  }
});
