import assert from 'node:assert/strict';
import test from 'node:test';
import type { DispatcherDependencies } from '@caseflow/dispatch';
import { InvocationLimits, runScheduledDispatch } from '../src/run.js';

function target() {
  const state = { claims: 0, sends: 0, finishes: 0, closed: 0 };
  const dependencies: DispatcherDependencies = {
    store: {
      async claim() {
        state.claims += 1;
        return [];
      },
      async finish() {
        state.finishes += 1;
        return true;
      },
      async retry() {
        return true;
      },
      async close() {
        state.closed += 1;
      },
    },
    queue: {
      async send() {
        state.sends += 1;
        return 'message-id';
      },
      close() {
        state.closed += 1;
      },
    },
    logger: { info() {}, warn() {} },
  };
  return { state, dependencies };
}

test('checks both outboxes and closes every client when no work is pending', async () => {
  const targets = [target(), target()];
  await runScheduledDispatch(
    targets.map((item) => item.dependencies),
    { getRemainingTimeInMillis: () => 60000 },
  );
  for (const { state } of targets) {
    assert.deepEqual(state, { claims: 1, sends: 0, finishes: 0, closed: 2 });
  }
});

test('does not start a batch near the invocation deadline', async () => {
  const item = target();
  await runScheduledDispatch([item.dependencies], { getRemainingTimeInMillis: () => 10000 });
  assert.equal(item.state.claims, 0);
  assert.equal(item.state.closed, 2);
});

test('claim failures surface a safe invocation error after both outboxes finish', async () => {
  const failed = target();
  const healthy = target();
  failed.dependencies.store.claim = async () => {
    throw new Error('private database details');
  };
  await assert.rejects(
    runScheduledDispatch([failed.dependencies, healthy.dependencies], {
      getRemainingTimeInMillis: () => 60000,
    }),
    { message: 'Scheduled dispatch failed.' },
  );
  assert.equal(healthy.state.claims, 1);
  assert.equal(failed.state.closed, 2);
  assert.equal(healthy.state.closed, 2);
});

test('bounds the number of batches even when the outbox keeps returning work', async () => {
  const item = target();
  item.dependencies.store.claim = async () => {
    item.state.claims += 1;
    return [
      {
        dispatchId: '00000000-0000-4000-8000-000000000001',
        jobId: '00000000-0000-4000-8000-000000000002',
        leaseToken: '00000000-0000-4000-8000-000000000003',
        leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
        attemptCount: 1,
      },
    ];
  };
  await runScheduledDispatch([item.dependencies], { getRemainingTimeInMillis: () => 60000 });
  assert.equal(item.state.claims, InvocationLimits.MaximumBatchesPerTarget);
  assert.equal(item.state.sends, InvocationLimits.MaximumBatchesPerTarget);
  assert.equal(item.state.finishes, InvocationLimits.MaximumBatchesPerTarget);
});
