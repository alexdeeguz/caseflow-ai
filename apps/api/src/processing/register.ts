import type { FastifyInstance } from 'fastify';
import type { DispatcherConfig } from './config.js';
import { DispatchEvent } from './constants.js';
import { createProcessingDispatcher, type ProcessingDispatcher } from './dispatcher.js';
import { createProcessingQueue } from './queue.js';
import { createDispatchStore, DispatchTarget } from './store.js';

export function registerProcessingDispatcher(
  app: FastifyInstance,
  config?: DispatcherConfig,
  injectedDispatcher?: ProcessingDispatcher,
  target: DispatchTarget = DispatchTarget.Processing,
) {
  if (!config) {
    return;
  }

  const dispatcher =
    injectedDispatcher ??
    createProcessingDispatcher({
      store: createDispatchStore(
        config.databaseUrl,
        () => {
          app.log.warn(
            { event: DispatchEvent.ConnectionFailed },
            'Processing dispatch connection unavailable.',
          );
        },
        target,
      ),
      queue: createProcessingQueue(config, target),
      logger: app.log,
    });

  app.addHook('onListen', async () => dispatcher.start());
  app.addHook('preClose', async () => dispatcher.stop());
  // Also release lazy clients when the application is closed before it starts listening.
  app.addHook('onClose', async () => dispatcher.stop());
}
