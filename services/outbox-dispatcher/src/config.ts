import { z } from 'zod';

const configSchema = z.strictObject({
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d+$/),
  projectId: z.string().regex(/^\d{12}$/),
  databaseProject: z.string().regex(/^[a-z0-9]{20}$/),
  databaseHost: z.string().regex(/^[a-z0-9-]+\.pooler\.supabase\.com$/),
  secretArn: z
    .string()
    .regex(/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/),
  processingQueueUrl: z.url(),
  factQueueUrl: z.url(),
  searchQueueUrl: z.url(),
});

export type ScheduledConfig = z.infer<typeof configSchema>;

export function readScheduledConfig(env: NodeJS.ProcessEnv): ScheduledConfig {
  const parsed = configSchema.safeParse({
    region: env.AWS_REGION,
    projectId: env.AWS_PROJECT_ID,
    databaseProject: env.DATABASE_PROJECT_REF,
    databaseHost: env.DATABASE_HOST,
    secretArn: env.DISPATCHER_SECRET_ARN,
    processingQueueUrl: env.PROCESSING_QUEUE_URL,
    factQueueUrl: env.FACT_EXTRACTION_QUEUE_URL,
    searchQueueUrl: env.SEARCH_INDEX_QUEUE_URL,
  });

  if (!parsed.success) {
    throw new Error('Invalid scheduled dispatcher configuration.');
  }

  const config = parsed.data;
  const secretPrefix = `arn:aws:secretsmanager:${config.region}:${config.projectId}:secret:`;

  const queues = [config.processingQueueUrl, config.factQueueUrl, config.searchQueueUrl];

  if (!config.secretArn.startsWith(secretPrefix) || new Set(queues).size !== queues.length) {
    throw new Error(
      'Dispatcher resources must belong to the selected project and use separate queues.',
    );
  }

  for (const value of queues) {
    const queue = new URL(value);
    if (
      queue.origin !== `https://sqs.${config.region}.amazonaws.com` ||
      queue.username ||
      queue.password ||
      queue.search ||
      queue.hash ||
      !new RegExp(`^/${config.projectId}/[A-Za-z0-9_-]{1,80}$`).test(queue.pathname)
    ) {
      throw new Error(
        'Dispatcher queues must be standard queues in the selected project and Region.',
      );
    }
  }

  return config;
}

const secretSchema = z.strictObject({
  processing_database_url: z.string(),
  fact_database_url: z.string(),
  search_database_url: z.string(),
});

export function parseDatabaseSecret(value: string, config: ScheduledConfig, certificate: string) {
  try {
    const secret = secretSchema.parse(JSON.parse(value));
    const connection = (value: string, role: string) => {
      const url = new URL(value);
      if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        url.username !== `${role}.${config.databaseProject}` ||
        !url.password ||
        url.hostname !== config.databaseHost ||
        url.port !== '6543' ||
        url.pathname !== '/postgres' ||
        url.hash ||
        url.searchParams.get('sslmode') !== 'verify-full' ||
        [...url.searchParams.keys()].some((key) => key !== 'sslmode') ||
        url.searchParams.getAll('sslmode').length !== 1
      ) {
        throw new Error('Invalid connection.');
      }
      url.searchParams.set('sslrootcert', certificate);
      return url.href;
    };

    return {
      processing: connection(secret.processing_database_url, 'caseflow_dispatcher_login'),
      facts: connection(secret.fact_database_url, 'caseflow_fact_dispatcher_login'),
      search: connection(secret.search_database_url, 'caseflow_search_dispatcher_login'),
    };
  } catch {
    throw new Error('Invalid dispatcher database secret.');
  }
}
