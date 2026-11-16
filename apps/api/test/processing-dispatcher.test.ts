import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProcessingDispatchClaim } from '../src/processing/contracts.js';
import Fastify from 'fastify';
import { readDispatcherConfig } from '../src/processing/config.js';
import { createProcessingDispatcher, dispatchPending } from '../src/processing/dispatcher.js';
import { DispatchEvent, DispatcherLimits } from '../src/processing/constants.js';
import { registerProcessingDispatcher } from '../src/processing/register.js';

const runtimeUrl = 'postgresql://caseflow_runtime:test@127.0.0.1:54322/postgres';
const env = {
  PROCESSING_DISPATCHER_ENABLED: 'true',
  PROCESSING_DISPATCHER_DATABASE_URL:
    'postgresql://caseflow_dispatcher_login:test@127.0.0.1:54322/postgres',
  PROCESSING_QUEUE_URL:
    'https://sqs.us-east-2.amazonaws.com/123456789012/caseflow-document-processing',
  AWS_REGION: 'us-east-2',
  AWS_PROFILE: 'caseflow-api-dev',
};

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const claim: ProcessingDispatchClaim = {
    dispatchId: randomUUID(),
    jobId: randomUUID(),
    leaseToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    attemptCount: 1,
  };
  const events: unknown[] = [];
  const completed: unknown[] = [];
  const retried: unknown[] = [];
  const messages: unknown[] = [];
  const closed: string[] = [];
  const logger = {
    info: (fields: unknown) => {
      events.push(fields);
    },
    warn: (fields: unknown) => {
      events.push(fields);
    },
  };
  const store = {
    claim: async (limit: number) => {
      assert.equal(limit, DispatcherLimits.ConcurrentSends);
      return [claim];
    },
    finish: async (value: ProcessingDispatchClaim, messageId: string) => {
      completed.push([value, messageId]);
      return true;
    },
    retry: async (value: ProcessingDispatchClaim) => {
      retried.push(value);
      return true;
    },
    close: async () => {
      closed.push('store');
    },
  };
  const queue = {
    send: async (value: unknown, signal: AbortSignal) => {
      signal.throwIfAborted();
      messages.push(value);
      return 'message-id';
    },
    close: () => {
      closed.push('queue');
    },
  };
  const controller = new AbortController();
  return { claim, events, completed, retried, messages, closed, store, queue, logger, controller };
}

test('dispatcher configuration is disabled by default and accepts restricted local and pooled logins', () => {
  assert.equal(readDispatcherConfig({}, runtimeUrl), undefined);
  assert.equal(
    readDispatcherConfig({ ...env, PROCESSING_DISPATCHER_ENABLED: 'false' }, runtimeUrl),
    undefined,
  );
  assert.equal(readDispatcherConfig(env, runtimeUrl)?.profile, 'caseflow-api-dev');
  const pooler = 'aws-0-us-east-2.pooler.supabase.com:5432/postgres?sslmode=verify-full';
  const project = 'abcdefghijklmnopqrst';
  assert.ok(
    readDispatcherConfig(
      {
        ...env,
        PROCESSING_DISPATCHER_DATABASE_URL: `postgresql://caseflow_dispatcher_login.${project}:test@${pooler}`,
      },
      `postgresql://caseflow_runtime.${project}:test@${pooler}`,
    ),
  );
});

test('dispatcher rejects privileged credentials, mismatched databases, insecure connections and unsafe queues without leaking values', () => {
  const invalid = [
    { PROCESSING_DISPATCHER_ENABLED: 'yes' },
    { PROCESSING_DISPATCHER_DATABASE_URL: undefined },
    { PROCESSING_DISPATCHER_DATABASE_URL: 'postgresql://postgres:secret@127.0.0.1:54322/postgres' },
    {
      PROCESSING_DISPATCHER_DATABASE_URL:
        'postgresql://caseflow_runtime:secret@127.0.0.1:54322/postgres',
    },
    {
      PROCESSING_DISPATCHER_DATABASE_URL:
        'postgresql://caseflow_dispatcher_login:secret@db.example.com/postgres',
    },
    {
      PROCESSING_DISPATCHER_DATABASE_URL:
        'postgresql://caseflow_dispatcher_login:secret@127.0.0.1:54322/other',
    },
    {
      PROCESSING_DISPATCHER_DATABASE_URL:
        env.PROCESSING_DISPATCHER_DATABASE_URL + '?user=postgres&password=secret',
    },
    { PROCESSING_QUEUE_URL: undefined },
    { PROCESSING_QUEUE_URL: 'http://sqs.us-east-2.amazonaws.com/123456789012/secret' },
    { PROCESSING_QUEUE_URL: 'https://sqs.us-east-2.amazonaws.com.evil.com/123456789012/secret' },
    { PROCESSING_QUEUE_URL: env.PROCESSING_QUEUE_URL + '.fifo' },
    { PROCESSING_QUEUE_URL: env.PROCESSING_QUEUE_URL + '?secret=value' },
    { PROCESSING_QUEUE_URL: env.PROCESSING_QUEUE_URL + '#secret' },
    { AWS_REGION: 'us-west-2' },
    { AWS_PROFILE: '../secret' },
  ];
  for (const patch of invalid) {
    assert.throws(
      () => readDispatcherConfig({ ...env, ...patch }, runtimeUrl),
      (error: Error) => !error.message.includes('secret'),
    );
  }
  const pooler = 'aws-0-us-east-2.pooler.supabase.com/postgres?sslmode=verify-full';
  assert.throws(() =>
    readDispatcherConfig(
      {
        ...env,
        PROCESSING_DISPATCHER_DATABASE_URL: `postgresql://caseflow_dispatcher_login.aaaaaaaaaaaaaaaaaaaa:test@${pooler}`,
      },
      `postgresql://caseflow_runtime.bbbbbbbbbbbbbbbbbbbb:test@${pooler}`,
    ),
  );
});

test('dispatch sends only the versioned job reference and acknowledges its lease', async () => {
  const f = fixture();
  await dispatchPending(f, f.controller.signal);
  assert.deepEqual(f.messages, [{ schemaVersion: 1, jobId: f.claim.jobId }]);
  assert.deepEqual(f.completed, [[f.claim, 'message-id']]);
  assert.equal(f.retried.length, 0);
  assert.ok(JSON.stringify(f.events).includes(DispatchEvent.Sent));
  assert.ok(!JSON.stringify(f.events).includes(f.claim.leaseToken));
});

test('failed and timed-out sends retry; acknowledgement failures leave the lease for recovery', async (t) => {
  for (const failure of ['send', 'retry', 'finish', 'lost-lease', 'claim']) {
    await t.test(failure, async () => {
      const f = fixture();
      const fail = async () => {
        throw new Error('secret provider URL and credentials');
      };
      if (failure === 'send' || failure === 'retry') {
        f.queue.send = fail;
      }
      if (failure === 'retry') {
        f.store.retry = fail;
      }
      if (failure === 'finish') {
        f.store.finish = fail;
      }
      if (failure === 'lost-lease') {
        f.store.finish = async () => false;
      }
      if (failure === 'claim') {
        f.store.claim = fail;
      }
      await dispatchPending(f, f.controller.signal);
      assert.ok(!JSON.stringify(f.events).includes('secret'));
      assert.equal(f.retried.length, failure === 'send' ? 1 : 0);
      assert.equal(f.completed.length, 0);
      assert.ok(f.events.length > 0);
    });
  }
  const f = fixture();
  f.claim.leaseExpiresAt = new Date(
    Date.now() + DispatcherLimits.LeaseSafetyMarginMs + 30,
  ).toISOString();
  f.queue.send = async () => new Promise<string>(() => {});
  const keepAlive = delay(80);
  await dispatchPending(f, f.controller.signal);
  await keepAlive;
  assert.equal(f.retried.length, 1);
});

test('expired leases and shutdown never start sends or record false delivery failures', async () => {
  const f = fixture();
  f.claim.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
  await dispatchPending(f, f.controller.signal);
  assert.equal(f.messages.length, 0);
  assert.equal(f.retried.length, 0);

  const blocked = fixture();
  blocked.queue.send = async () => {
    blocked.controller.abort();
    return new Promise<string>(() => {});
  };
  await dispatchPending(blocked, blocked.controller.signal);
  assert.equal(blocked.completed.length, 0);
  assert.equal(blocked.retried.length, 0);

  const claimed = fixture();
  claimed.store.claim = async () => {
    claimed.controller.abort();
    return [claimed.claim];
  };
  await dispatchPending(claimed, claimed.controller.signal);
  assert.equal(claimed.messages.length, 0);
});

test('dispatcher polls without overlapping and closes its resources once', async () => {
  const f = fixture();
  const entered = deferred();
  let claims = 0;
  f.store.claim = async () => {
    claims++;
    return [f.claim];
  };
  f.queue.send = async () => {
    entered.resolve();
    return new Promise<string>(() => {});
  };
  const dispatcher = createProcessingDispatcher(f);
  dispatcher.start();
  dispatcher.start();
  await entered.promise;
  await delay(DispatcherLimits.PollIntervalMs + 30);
  assert.equal(claims, 1);
  await Promise.all([dispatcher.stop(), dispatcher.stop()]);
  dispatcher.start();
  assert.deepEqual(f.closed, ['queue', 'store']);
  assert.equal(claims, 1);
});

test('a failed claim does not stop later polling', async () => {
  const f = fixture();
  const sent = deferred();
  let calls = 0;
  f.store.claim = async () => {
    if (++calls === 1) {
      throw new Error('database unavailable');
    }
    return [f.claim];
  };
  f.queue.send = async () => {
    sent.resolve();
    return 'message-id';
  };
  const dispatcher = createProcessingDispatcher(f);
  dispatcher.start();
  await sent.promise;
  await dispatcher.stop();
  assert.equal(calls, 2);
});

test('Fastify starts dispatching only when listening and stops before shutdown', async () => {
  const f = fixture();
  const dispatcher = createProcessingDispatcher(f);
  const app = Fastify();
  registerProcessingDispatcher(app, readDispatcherConfig(env, runtimeUrl), dispatcher);
  app.get('/health', async () => ({ ok: true }));
  await app.inject('/health');
  assert.equal(f.messages.length, 0);
  await app.listen({ port: 0, host: '127.0.0.1' });
  await app.close();
  assert.deepEqual(f.closed, ['queue', 'store']);

  const unstarted = fixture();
  const second = Fastify();
  registerProcessingDispatcher(
    second,
    readDispatcherConfig(env, runtimeUrl),
    createProcessingDispatcher(unstarted),
  );
  await second.close();
  assert.deepEqual(unstarted.closed, ['queue', 'store']);
  assert.equal(unstarted.messages.length, 0);
});

test('fact dispatch uses a separate login and queue and remains disabled by default', () => {
  const factEnv = {
    ...env,
    FACT_EXTRACTION_DISPATCHER_ENABLED: 'true',
    FACT_EXTRACTION_DISPATCHER_DATABASE_URL:
      'postgresql://caseflow_fact_dispatcher_login:test@127.0.0.1:54322/postgres',
    FACT_EXTRACTION_QUEUE_URL:
      'https://sqs.us-east-2.amazonaws.com/123456789012/caseflow-fact-extraction',
  };
  assert.equal(readDispatcherConfig(env, runtimeUrl, 'facts'), undefined);
  assert.equal(
    readDispatcherConfig(factEnv, runtimeUrl, 'facts')?.queueUrl,
    factEnv.FACT_EXTRACTION_QUEUE_URL,
  );
  assert.throws(() =>
    readDispatcherConfig(
      { ...factEnv, FACT_EXTRACTION_QUEUE_URL: env.PROCESSING_QUEUE_URL },
      runtimeUrl,
      'facts',
    ),
  );
  assert.throws(() =>
    readDispatcherConfig(
      {
        ...factEnv,
        FACT_EXTRACTION_DISPATCHER_DATABASE_URL: env.PROCESSING_DISPATCHER_DATABASE_URL,
      },
      runtimeUrl,
      'facts',
    ),
  );
});
