import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDatabaseSecret, readScheduledConfig } from '../src/config.js';

const env = {
  AWS_REGION: 'us-east-2',
  AWS_PROJECT_ID: '123456789012',
  DATABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
  DATABASE_HOST: 'aws-0-us-east-2.pooler.supabase.com',
  DISPATCHER_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:123456789012:secret:dispatch-abcdef',
  PROCESSING_QUEUE_URL: 'https://sqs.us-east-2.amazonaws.com/123456789012/processing',
  FACT_EXTRACTION_QUEUE_URL: 'https://sqs.us-east-2.amazonaws.com/123456789012/facts',
  SEARCH_INDEX_QUEUE_URL: 'https://sqs.us-east-2.amazonaws.com/123456789012/search',
};
const config = readScheduledConfig(env);
const connection = (role: string) =>
  `postgresql://${role}.abcdefghijklmnopqrst:private-password@${env.DATABASE_HOST}:6543/postgres?sslmode=verify-full`;
const secret = {
  processing_database_url: connection('caseflow_dispatcher_login'),
  fact_database_url: connection('caseflow_fact_dispatcher_login'),
  search_database_url: connection('caseflow_search_dispatcher_login'),
};

test('accepts separate restricted logins and injects the packaged certificate', () => {
  const result = parseDatabaseSecret(JSON.stringify(secret), config, '/var/task/supabase-ca.crt');
  assert.equal(
    new URL(result.processing).searchParams.get('sslrootcert'),
    '/var/task/supabase-ca.crt',
  );
  assert.equal(
    new URL(result.facts).username,
    'caseflow_fact_dispatcher_login.abcdefghijklmnopqrst',
  );
});

test('rejects wrong queues, projects, regions, and secret destinations', () => {
  for (const update of [
    { FACT_EXTRACTION_QUEUE_URL: env.PROCESSING_QUEUE_URL },
    { SEARCH_INDEX_QUEUE_URL: env.FACT_EXTRACTION_QUEUE_URL },
    { SEARCH_INDEX_QUEUE_URL: env.SEARCH_INDEX_QUEUE_URL.replace('123456789012', '999999999999') },
    { PROCESSING_QUEUE_URL: env.PROCESSING_QUEUE_URL.replace('123456789012', '999999999999') },
    { PROCESSING_QUEUE_URL: `${env.PROCESSING_QUEUE_URL}?endpoint=other` },
    { PROCESSING_QUEUE_URL: `${env.PROCESSING_QUEUE_URL}.fifo` },
    { AWS_REGION: 'us-west-2' },
    { DISPATCHER_SECRET_ARN: env.DISPATCHER_SECRET_ARN.replace('123456789012', '999999999999') },
  ]) {
    assert.throws(() => readScheduledConfig({ ...env, ...update }));
  }
});

test('rejects privileged users, session poolers, weakened TLS, and URL overrides without leaking secrets', () => {
  for (const processing_database_url of [
    connection('postgres'),
    secret.processing_database_url.replace(':6543/', ':5432/'),
    secret.processing_database_url.replace('verify-full', 'require'),
    `${secret.processing_database_url}&sslmode=disable`,
    `${secret.processing_database_url}&user=postgres`,
    `${secret.processing_database_url}&sslrootcert=/tmp/untrusted.crt`,
    secret.processing_database_url.replace('abcdefghijklmnopqrst', 'zzzzzzzzzzzzzzzzzzzz'),
    secret.processing_database_url.replace(env.DATABASE_HOST, 'attacker.example'),
  ]) {
    assert.throws(
      () =>
        parseDatabaseSecret(
          JSON.stringify({ ...secret, processing_database_url }),
          config,
          '/ca.crt',
        ),
      (error: unknown) =>
        error instanceof Error && error.message === 'Invalid dispatcher database secret.',
    );
  }
});

test('search dispatch requires its own restricted credential', () => {
  const parsed = parseDatabaseSecret(JSON.stringify(secret), config, '/var/task/ca.crt');
  assert.equal(
    new URL(parsed.search).username,
    'caseflow_search_dispatcher_login.abcdefghijklmnopqrst',
  );
  for (const search_database_url of [
    undefined,
    secret.processing_database_url,
    connection('postgres'),
  ]) {
    assert.throws(() =>
      parseDatabaseSecret(JSON.stringify({ ...secret, search_database_url }), config, '/ca.crt'),
    );
  }
});
