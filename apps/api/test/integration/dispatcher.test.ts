import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Role, caseSchema, userSchema, type ProcessingMessage } from '@caseflow/schemas';
import { Operation } from '../../src/database/operations.js';
import { createDispatchStore } from '@caseflow/dispatch';
import { dispatchPending, type DispatcherDependencies } from '@caseflow/dispatch';
import { createTestDatabase } from './database-fixture.js';

const silentLogger = { info: () => {}, warn: () => {} };

test('API dispatcher uses restricted credentials and committed, recoverable dispatch leases', async (t) => {
  const db = await createTestDatabase();
  const login = `dispatch_test_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  await db.owner.query(`create role "${login}" login inherit password '${password}'`);
  await db.owner.query(`grant caseflow_dispatcher to "${login}" with inherit true, set false`);
  const dispatcherUrl = new URL(db.runtimeUrl);
  dispatcherUrl.username = login;
  dispatcherUrl.password = password;
  const store = createDispatchStore(dispatcherUrl.href, () => {});
  const otherStore = createDispatchStore(dispatcherUrl.href, () => {});
  const restricted = new Pool({ connectionString: dispatcherUrl.href, max: 1 });
  const messages: ProcessingMessage[] = [];
  const queue = {
    send: async (message: ProcessingMessage) => {
      messages.push(message);
      return randomUUID();
    },
    close: () => {},
  };
  const dependencies: DispatcherDependencies = { store, queue, logger: silentLogger };
  const signal = new AbortController().signal;

  try {
    const identity = {
      tenantId: randomUUID(),
      subject: 'dispatcher-test',
      name: 'Dispatcher Test',
    };
    const admin = userSchema.parse(await db.store.execute(identity, Operation.GetProfile, {}));
    await db.owner.query('select caseflow.operator_set_role($1,$2)', [admin.id, Role.SuperAdmin]);
    const record = caseSchema.parse(
      await db.store.execute(identity, Operation.CreateCase, {
        title: 'Dispatcher fixture',
        clientName: 'Fictional Client',
      }),
    );

    async function enqueue() {
      const document = (
        await db.owner.query(
          `insert into caseflow.documents(
        case_id,uploaded_by,filename,content_type,size_bytes,storage_bucket,storage_environment,
        status,uploaded_at,object_version_id,checksum_sha256,upload_request_id)
        values($1,$2,'fictional.pdf','application/pdf',7,'caseflow-test-documents','dev',
        'available',now(),'saved-version',$3,gen_random_uuid()) returning id`,
          [record.id, admin.id, Buffer.alloc(32).toString('base64')],
        )
      ).rows[0];
      const client = await db.owner.connect();
      try {
        await client.query('begin');
        await client.query(
          "select set_config('caseflow.tenant_id',$1,true), set_config('caseflow.subject',$2,true)",
          [identity.tenantId, identity.subject],
        );
        const result = await client.query(
          'select caseflow.request_document_processing($1,$2,null) id',
          [record.id, document.id],
        );
        await client.query('commit');
        return result.rows[0].id as string;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    }

    async function row(job: string) {
      return (
        await db.owner.query('select * from caseflow.processing_dispatches where job_id=$1', [job])
      ).rows[0];
    }

    await t.test(
      'parallel API instances claim disjoint work and commit before network I/O',
      async () => {
        const jobs = await Promise.all(Array.from({ length: 8 }, () => enqueue()));
        const observed: string[] = [];
        const committedQueue = {
          ...queue,
          send: async (message: ProcessingMessage) => {
            const state = await row(message.jobId);
            assert.equal(state.status, 'leased');
            assert.equal(state.attempt_count, 1);
            observed.push(message.jobId);
            // Updating the claimed row would block if a claim transaction still held its row lock.
            await db.owner.query(
              'update caseflow.processing_dispatches set available_at=available_at where job_id=$1',
              [message.jobId],
            );
            return queue.send(message);
          },
        };
        await Promise.all([
          dispatchPending({ ...dependencies, queue: committedQueue }, signal),
          dispatchPending({ ...dependencies, store: otherStore, queue: committedQueue }, signal),
        ]);
        assert.deepEqual([...observed].sort(), [...jobs].sort());
        assert.equal(new Set(observed).size, 8);
        for (const job of jobs) {
          const state = await row(job);
          assert.equal(state.status, 'sent');
          assert.ok(state.message_id);
          assert.equal(state.lease_token, null);
        }
      },
    );

    await t.test(
      'SQS failures release claims with the database retry delay without failing jobs',
      async () => {
        const job = await enqueue();
        await dispatchPending(
          {
            ...dependencies,
            queue: {
              ...queue,
              send: async () => {
                throw new Error('provider detail');
              },
            },
          },
          signal,
        );
        const state = await row(job);
        assert.equal(state.status, 'pending');
        assert.equal(state.last_failure_code, 'dispatch_unavailable');
        assert.ok(state.available_at.getTime() > Date.now() + 25000);
        assert.equal(
          (
            await db.owner.query(
              'select status,attempt_count from caseflow.document_processing_jobs where id=$1',
              [job],
            )
          ).rows[0].status,
          'queued',
        );
        assert.equal((await store.claim(5)).length, 0);
        await db.owner.query(
          'update caseflow.processing_dispatches set available_at=now() where job_id=$1',
          [job],
        );
        await dispatchPending(dependencies, signal);
        assert.equal((await row(job)).status, 'sent');
      },
    );

    await t.test(
      'lost acknowledgement resends the same job after lease expiry and fences the stale token',
      async () => {
        const job = await enqueue();
        const priorCount = messages.length;
        await dispatchPending(
          {
            ...dependencies,
            store: {
              ...store,
              finish: async () => {
                throw new Error('connection lost');
              },
            },
          },
          signal,
        );
        const old = await row(job);
        assert.equal(old.status, 'leased');
        assert.equal((await store.claim(5)).length, 0);
        await db.owner.query(
          "update caseflow.processing_dispatches set lease_expires_at=now()-interval '1 second' where job_id=$1",
          [job],
        );
        await dispatchPending(dependencies, signal);
        assert.deepEqual(messages.slice(priorCount), [
          { schemaVersion: 1, jobId: job },
          { schemaVersion: 1, jobId: job },
        ]);
        const state = await row(job);
        assert.equal(state.status, 'sent');
        assert.equal(state.attempt_count, 2);
        assert.equal(
          await store.finish(
            {
              dispatchId: old.id,
              jobId: job,
              leaseToken: old.lease_token,
              leaseExpiresAt: old.lease_expires_at.toISOString(),
              attemptCount: 1,
            },
            'stale-message',
          ),
          false,
        );
      },
    );

    await t.test(
      'restricted dispatcher cannot read tables, alter users, or cross runtime boundaries',
      async () => {
        for (const sql of [
          'select * from caseflow.documents',
          'select * from caseflow.processing_dispatches',
          "update caseflow.users set role='super_admin'",
          'select caseflow.request_document_processing(null,null,null)',
          'select caseflow.operator_set_role(null,null)',
        ]) {
          await assert.rejects(restricted.query(sql), /permission denied/);
        }
        await assert.rejects(
          db.runtime.query('select * from caseflow.claim_processing_dispatches(1)'),
          /permission denied/,
        );
        assert.equal((await restricted.query('select current_user')).rows[0].current_user, login);
      },
    );
  } finally {
    await restricted.end();
    await store.close();
    await otherStore.close();
    await db.owner.query(`drop role "${login}"`);
    await db.close();
  }
});
