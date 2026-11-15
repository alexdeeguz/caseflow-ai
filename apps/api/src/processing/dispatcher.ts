import { setTimeout as delay } from 'node:timers/promises';
import { ProcessingLimits } from '@caseflow/schemas';
import type { ProcessingDispatchClaim } from './contracts.js';
import { DispatchEvent, DispatcherLimits } from './constants.js';
import type { DispatchStore } from './store.js';
import type { ProcessingQueue } from './queue.js';

export interface DispatchLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface ProcessingDispatcher {
  start(): void;
  stop(): Promise<void>;
}

export interface DispatcherDependencies {
  store: DispatchStore;
  queue: ProcessingQueue;
  logger: DispatchLogger;
}

// Credential resolution can outlive the HTTP abort signal; stop waiting at the same deadline.
async function withAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};

  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation();
      }),
      aborted,
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function dispatchClaim(
  claim: ProcessingDispatchClaim,
  { store, queue, logger }: DispatcherDependencies,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }

  const fields = {
    dispatchId: claim.dispatchId,
    jobId: claim.jobId,
    attemptCount: claim.attemptCount,
  };
  const timeout = Math.min(
    DispatcherLimits.SendTimeoutMs,
    Date.parse(claim.leaseExpiresAt) - Date.now() - DispatcherLimits.LeaseSafetyMarginMs,
  );

  if (timeout <= 0) {
    logger.warn(
      { ...fields, event: DispatchEvent.LeaseLost },
      'Processing dispatch lease expired.',
    );
    return;
  }

  const sendSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  let messageId: string;

  try {
    messageId = await withAbort(
      () =>
        queue.send(
          {
            schemaVersion: ProcessingLimits.MessageSchemaVersion,
            jobId: claim.jobId,
          },
          sendSignal,
        ),
      sendSignal,
    );
  } catch {
    if (signal.aborted) {
      return;
    }
    logger.warn({ ...fields, event: DispatchEvent.SendFailed }, 'Processing dispatch send failed.');

    try {
      if (!(await store.retry(claim))) {
        logger.warn(
          { ...fields, event: DispatchEvent.LeaseLost },
          'Processing dispatch lease changed.',
        );
      }
    } catch {
      logger.warn(
        { ...fields, event: DispatchEvent.RetryFailed },
        'Processing dispatch retry could not be recorded.',
      );
    }
    return;
  }

  try {
    const applied = await store.finish(claim, messageId);

    if (applied) {
      logger.info({ ...fields, event: DispatchEvent.Sent }, 'Processing dispatch sent.');
    } else {
      logger.warn(
        { ...fields, event: DispatchEvent.LeaseLost },
        'Processing dispatch lease changed.',
      );
    }
  } catch {
    // SQS may already hold the message. Leave the lease for recovery without claiming delivery failed.
    logger.warn(
      { ...fields, event: DispatchEvent.AcknowledgeFailed },
      'Processing dispatch acknowledgement failed.',
    );
  }
}

export async function dispatchPending(
  dependencies: DispatcherDependencies,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }

  let claims: ProcessingDispatchClaim[];

  try {
    claims = await dependencies.store.claim(DispatcherLimits.ConcurrentSends);
  } catch {
    dependencies.logger.warn(
      { event: DispatchEvent.ClaimFailed },
      'Processing dispatch claim failed.',
    );
    return;
  }

  await Promise.all(claims.map((claim) => dispatchClaim(claim, dependencies, signal)));
}

export function createProcessingDispatcher(
  dependencies: DispatcherDependencies,
): ProcessingDispatcher {
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;

  async function run() {
    while (!controller.signal.aborted) {
      await dispatchPending(dependencies, controller.signal);

      try {
        await delay(DispatcherLimits.PollIntervalMs, undefined, { signal: controller.signal });
      } catch {
        if (!controller.signal.aborted) {
          throw new Error('Processing dispatcher delay failed.');
        }
      }
    }
  }

  return {
    start() {
      if (!running && !controller.signal.aborted) {
        running = run();
      }
    },

    stop() {
      stopping ??= (async () => {
        controller.abort();
        await running;

        try {
          dependencies.queue.close();
        } finally {
          await dependencies.store.close();
        }
      })();

      return stopping;
    },
  };
}
