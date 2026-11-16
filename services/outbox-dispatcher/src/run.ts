import { dispatchPending, type DispatcherDependencies } from '@caseflow/dispatch';

export const InvocationLimits = {
  MaximumBatchesPerTarget: 10,
  MinimumBatchTimeMs: 35000,
  ShutdownMarginMs: 8000,
} as const;

export interface InvocationContext {
  getRemainingTimeInMillis(): number;
}

export async function runScheduledDispatch(
  targets: DispatcherDependencies[],
  context: InvocationContext,
): Promise<void> {
  const signal = AbortSignal.timeout(
    Math.max(1, context.getRemainingTimeInMillis() - InvocationLimits.ShutdownMarginMs),
  );

  try {
    const results = await Promise.allSettled(
      targets.map(async (target) => {
        for (let batch = 0; batch < InvocationLimits.MaximumBatchesPerTarget; batch += 1) {
          if (
            signal.aborted ||
            context.getRemainingTimeInMillis() < InvocationLimits.MinimumBatchTimeMs
          ) {
            return;
          }
          const claimed = await dispatchPending(target, signal);
          if (claimed === null) {
            throw new Error('Dispatcher database unavailable.');
          }
          if (claimed === 0) {
            return;
          }
        }
      }),
    );

    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('Scheduled dispatch failed.');
    }
  } finally {
    await Promise.allSettled(
      targets.map(async (target) => {
        target.queue.close();
        await target.store.close();
      }),
    );
  }
}
