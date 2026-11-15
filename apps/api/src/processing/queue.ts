import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { fromIni } from '@aws-sdk/credential-providers';
import { processingMessageSchema, type ProcessingMessage } from '@caseflow/schemas';
import { z } from 'zod';
import type { DispatcherConfig } from './config.js';
import { DispatcherLimits } from './constants.js';

export interface ProcessingQueue {
  send(message: ProcessingMessage, signal: AbortSignal): Promise<string>;
  close(): void;
}

const messageIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) =>
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
  );
const clientOptions = {
  maxAttempts: 3,
  retryMode: 'standard',
  requestHandler: {
    connectionTimeout: 3000,
    requestTimeout: 5000,
    throwOnRequestTimeout: true,
    httpsAgent: { keepAlive: true, maxSockets: DispatcherLimits.ConcurrentSends },
  },
} as const;

export function createProcessingQueueClient(config: DispatcherConfig): SQSClient {
  return new SQSClient({
    ...clientOptions,
    region: config.region,
    // Bind sends to the configured regional endpoint, including when ambient SDK options exist.
    endpoint: `https://sqs.${config.region}.amazonaws.com`,
    useQueueUrlAsEndpoint: false,
    credentials: config.profile
      ? fromIni({
          profile: config.profile,
          clientConfig: { ...clientOptions, region: config.region },
        })
      : undefined,
  });
}

export function createProcessingQueue(config: DispatcherConfig): ProcessingQueue {
  return createQueueAdapter(createProcessingQueueClient(config), config.queueUrl);
}

export function createQueueAdapter(
  client: Pick<SQSClient, 'send' | 'destroy'>,
  queueUrl: string,
): ProcessingQueue {
  return {
    async send(message, signal) {
      signal.throwIfAborted();
      const body = processingMessageSchema.parse(message);
      const result = await client.send(
        new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(body) }),
        { abortSignal: signal },
      );

      return messageIdSchema.parse(result.MessageId);
    },

    close: () => client.destroy(),
  };
}
