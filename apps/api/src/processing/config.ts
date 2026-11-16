import { z } from 'zod';
import { parseDatabaseUrl } from '../database/connection-config.js';

const configSchema = z.strictObject({
  databaseUrl: z.string().min(1),
  queueUrl: z.url(),
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d+$/),
  profile: z
    .string()
    .regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/)
    .optional(),
});

export type DispatcherConfig = z.infer<typeof configSchema>;

export function readDispatcherConfig(
  env: NodeJS.ProcessEnv,
  runtimeUrl: string,
  purpose: 'processing' | 'facts' = 'processing',
): DispatcherConfig | undefined {
  const prefix = purpose === 'facts' ? 'FACT_EXTRACTION' : 'PROCESSING';
  const login =
    purpose === 'facts' ? 'caseflow_fact_dispatcher_login' : 'caseflow_dispatcher_login';
  const enabled = env[`${prefix}_DISPATCHER_ENABLED`] ?? 'false';

  if (!['true', 'false'].includes(enabled)) {
    throw new Error(`${prefix}_DISPATCHER_ENABLED must be true or false.`);
  }

  if (enabled === 'false') {
    return undefined;
  }

  const parsed = configSchema.safeParse({
    databaseUrl: env[`${prefix}_DISPATCHER_DATABASE_URL`],
    queueUrl: env[`${prefix}_QUEUE_URL`],
    region: env.AWS_REGION,
    profile: env.AWS_PROFILE,
  });

  if (!parsed.success) {
    throw new Error(
      `Set valid ${prefix}_DISPATCHER_DATABASE_URL, ${prefix}_QUEUE_URL, AWS_REGION, and an optional named AWS_PROFILE.`,
    );
  }

  const config = parsed.data;
  const queue = new URL(config.queueUrl);

  if (
    queue.protocol !== 'https:' ||
    queue.hostname !== `sqs.${config.region}.amazonaws.com` ||
    queue.port ||
    queue.username ||
    queue.password ||
    queue.search ||
    queue.hash ||
    !/^\/\d{12}\/[A-Za-z0-9_-]{1,80}$/.test(queue.pathname)
  ) {
    throw new Error(`${prefix}_QUEUE_URL must identify a standard SQS queue in AWS_REGION.`);
  }

  if (purpose === 'facts' && config.queueUrl === env.PROCESSING_QUEUE_URL) {
    throw new Error('Fact extraction must use its own queue.');
  }

  const database = parseDatabaseUrl(config.databaseUrl, `${prefix}_DISPATCHER_DATABASE_URL`);
  const runtime = parseDatabaseUrl(runtimeUrl);
  const pooled = database.hostname.endsWith('.pooler.supabase.com');
  const expectedUser = pooled ? `${login}.${runtime.username.split('.')[1]}` : login;

  if (database.username !== expectedUser) {
    throw new Error(
      `${prefix}_DISPATCHER_DATABASE_URL must use the ${login} role and the same project as DATABASE_URL.`,
    );
  }

  if (
    database.hostname !== runtime.hostname ||
    (database.port || '5432') !== (runtime.port || '5432') ||
    database.pathname !== runtime.pathname
  ) {
    throw new Error(
      'The dispatcher and runtime connections must use the same database host, port, and database.',
    );
  }

  return config;
}
