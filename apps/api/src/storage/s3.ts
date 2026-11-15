import { S3Client } from '@aws-sdk/client-s3';
import { fromIni } from '@aws-sdk/credential-providers';
import type { StorageConfig } from './config.js';

const clientOptions = {
  maxAttempts: 3,
  retryMode: 'standard',
  requestHandler: {
    connectionTimeout: 3000,
    requestTimeout: 10000,
    throwOnRequestTimeout: true,
    httpsAgent: { keepAlive: true, maxSockets: 20 },
  },
} as const;

export function createDocumentStorage(config: StorageConfig) {
  const client = new S3Client({
    ...clientOptions,
    region: config.region,
    // An explicit profile must not fall back to unrelated environment credentials.
    credentials: config.profile
      ? fromIni({
          profile: config.profile,
          clientConfig: { ...clientOptions, region: config.region },
        })
      : undefined,
  });

  return { client, bucket: config.bucket, environment: config.environment };
}

export type DocumentStorage = ReturnType<typeof createDocumentStorage>;

declare module 'fastify' {
  interface FastifyInstance {
    documentStorage: DocumentStorage | null;
  }
}
