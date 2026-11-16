import { fileURLToPath } from 'node:url';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  createDispatchStore,
  createProcessingQueue,
  DispatchTarget,
  type DispatchLogger,
} from '@caseflow/dispatch';
import { parseDatabaseSecret, readScheduledConfig } from './config.js';
import { runScheduledDispatch, type InvocationContext } from './run.js';

const config = readScheduledConfig(process.env);
const secrets = new SecretsManagerClient({
  region: config.region,
  maxAttempts: 3,
  retryMode: 'standard',
  requestHandler: { connectionTimeout: 3000, requestTimeout: 5000, throwOnRequestTimeout: true },
});

const logger: DispatchLogger = {
  info: (fields, message) => console.info(JSON.stringify({ ...fields, message })),
  warn: (fields, message) => console.warn(JSON.stringify({ ...fields, message })),
};

export async function handler(
  event: unknown,
  context: InvocationContext,
): Promise<void | { validated: true }> {
  try {
    const secret = await secrets.send(new GetSecretValueCommand({ SecretId: config.secretArn }));
    const connections = parseDatabaseSecret(
      secret.SecretString ?? '',
      config,
      fileURLToPath(new URL('./supabase-ca.crt', import.meta.url)),
    );

    if (event && typeof event === 'object' && 'action' in event && event.action === 'validate') {
      return { validated: true };
    }

    const targets = [
      {
        target: DispatchTarget.Processing,
        databaseUrl: connections.processing,
        queueUrl: config.processingQueueUrl,
      },
      {
        target: DispatchTarget.FactExtraction,
        databaseUrl: connections.facts,
        queueUrl: config.factQueueUrl,
      },
    ].map(({ target, databaseUrl, queueUrl }) => ({
      store: createDispatchStore(
        databaseUrl,
        () => logger.warn({ target }, 'Dispatch connection unavailable.'),
        target,
      ),
      queue: createProcessingQueue({ region: config.region, queueUrl }, target),
      logger,
    }));

    await runScheduledDispatch(targets, context);
  } catch {
    // Provider and database errors can contain credentials or connection details.
    throw new Error('Scheduled dispatcher unavailable.');
  }
}
