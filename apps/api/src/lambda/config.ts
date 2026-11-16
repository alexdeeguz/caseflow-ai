import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readConfig } from '../config.js';

const secretSchema = z.strictObject({
  database_url: z.string(),
  demo_session_secret: z.string().min(32).max(512).optional(),
});

export function readLambdaConfig(secret: string, env: NodeJS.ProcessEnv) {
  try {
    if (
      env.AWS_PROFILE ||
      env.PROCESSING_DISPATCHER_ENABLED === 'true' ||
      env.FACT_EXTRACTION_DISPATCHER_ENABLED === 'true' ||
      env.SEARCH_INDEX_DISPATCHER_ENABLED === 'true'
    ) {
      throw new Error('Invalid Lambda environment.');
    }

    const { database_url: value, demo_session_secret: demoSecret } = secretSchema.parse(
      JSON.parse(secret),
    );
    const demoEnabled = z.enum(['true', 'false']).default('false').parse(env.DEMO_LOGIN_ENABLED);
    const database = new URL(value);
    const project = env.DATABASE_PROJECT_REF;

    if (
      !project ||
      !/^[a-z0-9]{20}$/.test(project) ||
      database.username !== `caseflow_runtime.${project}` ||
      database.hostname !== env.DATABASE_HOST ||
      !database.hostname.endsWith('.pooler.supabase.com') ||
      database.port !== '6543' ||
      database.pathname !== '/postgres' ||
      !database.password ||
      database.hash ||
      database.searchParams.get('sslmode') !== 'verify-full' ||
      database.searchParams.getAll('sslmode').length !== 1 ||
      [...database.searchParams.keys()].some((key) => key !== 'sslmode')
    ) {
      throw new Error('Invalid runtime connection.');
    }

    database.searchParams.set(
      'sslrootcert',
      fileURLToPath(new URL('./certs/supabase-ca.crt', import.meta.url)),
    );
    const config = readConfig({
      ...env,
      DATABASE_URL: database.href,
      DEMO_LOGIN_ENABLED: demoEnabled,
      DEMO_SESSION_SECRET: demoSecret,
    });

    if (!config.storage || !config.webOrigin.startsWith('https:')) {
      throw new Error('Missing production configuration.');
    }

    return config;
  } catch {
    throw new Error('Invalid API Lambda configuration.');
  }
}
