import { DispatchTarget } from '@caseflow/dispatch';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SQSClient } from '@aws-sdk/client-sqs';
import { createProcessingQueueClient, createQueueAdapter } from '@caseflow/dispatch';

const config = {
  databaseUrl: '',
  region: 'us-east-2',
  profile: 'caseflow-api-dev',
  queueUrl: 'https://sqs.us-east-2.amazonaws.com/123456789012/caseflow-document-processing',
};

test('SQS signs with the restricted profile and region; sends only the validated job message', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'caseflow-sqs-test-'));
  const credentials = join(directory, 'credentials');
  const awsConfig = join(directory, 'config');
  await writeFile(
    credentials,
    '[caseflow-api-dev]\naws_access_key_id = TEST_RESTRICTED\naws_secret_access_key = test-only-secret\n',
    { mode: 0o600 },
  );
  await writeFile(awsConfig, '', { mode: 0o600 });
  const environment = {
    AWS_SHARED_CREDENTIALS_FILE: credentials,
    AWS_CONFIG_FILE: awsConfig,
    AWS_ACCESS_KEY_ID: 'TEST_ADMIN',
    AWS_SECRET_ACCESS_KEY: 'ambient-test-only-secret',
    AWS_ENDPOINT_URL: 'https://unexpected.example.com',
    AWS_ENDPOINT_URL_SQS: 'https://unexpected.example.com',
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  Object.assign(process.env, environment);

  const client = createProcessingQueueClient(config);
  const queue = createQueueAdapter(client, config.queueUrl);
  const message = { schemaVersion: 1 as const, jobId: randomUUID() };
  let requested = false;
  client.middlewareStack.add(
    () => async (args) => {
      const request = args.request as {
        hostname: string;
        headers: Record<string, string>;
        body: Uint8Array;
      };
      assert.equal(request.hostname, 'sqs.us-east-2.amazonaws.com');
      assert.match(request.headers.authorization ?? '', /Credential=TEST_RESTRICTED\//);
      assert.match(request.headers.authorization ?? '', /us-east-2\/sqs\/aws4_request/);
      const body = JSON.parse(new TextDecoder().decode(request.body));
      assert.equal(body.QueueUrl, config.queueUrl);
      assert.deepEqual(JSON.parse(body.MessageBody), message);
      assert.equal(body.MessageDeduplicationId, undefined);
      requested = true;
      return {
        response: {},
        output: {
          $metadata: {},
          MessageId: 'sqs-message-id',
          MD5OfMessageBody: createHash('md5').update(body.MessageBody).digest('hex'),
        },
      };
    },
    { step: 'finalizeRequest', name: 'captureSignedSend', priority: 'low' },
  );
  try {
    assert.equal(await queue.send(message, new AbortController().signal), 'sqs-message-id');
    assert.ok(requested);
  } finally {
    queue.close();
  }
});

test('queue adapter rejects forged message fields and missing or invalid SQS acknowledgements', async () => {
  const client = new SQSClient({
    region: 'us-east-2',
    credentials: { accessKeyId: 'TEST', secretAccessKey: 'test' },
  });
  const queue = createQueueAdapter(client, config.queueUrl);
  let messageId: string | undefined;
  let sends = 0;
  client.middlewareStack.add(
    () => async () => {
      sends++;
      return {
        response: {},
        output: {
          $metadata: {},
          MessageId: messageId,
          MD5OfMessageBody: createHash('md5').update(JSON.stringify(message)).digest('hex'),
        },
      };
    },
    { step: 'finalizeRequest', name: 'fakeSqs', priority: 'low' },
  );
  const message = { schemaVersion: 1 as const, jobId: randomUUID() };
  const signal = new AbortController().signal;
  try {
    await assert.rejects(queue.send({ ...message, ...{ objectKey: 'forged' } }, signal));
    await assert.rejects(queue.send({ ...message, jobId: 'invalid' }, signal));
    await assert.rejects(queue.send(message, AbortSignal.abort()));
    assert.equal(sends, 0);
    for (messageId of [undefined, '', 'x'.repeat(129), 'invalid\nmessage']) {
      await assert.rejects(queue.send(message, signal));
    }
  } finally {
    queue.close();
  }
});

test('fact queue receives only a task reference rather than an OCR job payload', async () => {
  const client = new SQSClient({
    region: 'us-east-2',
    credentials: { accessKeyId: 'TEST', secretAccessKey: 'test' },
  });
  const queueUrl = 'https://sqs.us-east-2.amazonaws.com/123456789012/caseflow-fact-extraction';
  const queue = createQueueAdapter(client, queueUrl, DispatchTarget.FactExtraction);
  const taskId = randomUUID();
  client.middlewareStack.add(
    () => async (args) => {
      const input = args.input as { QueueUrl: string; MessageBody: string };
      assert.equal(input.QueueUrl, queueUrl);
      assert.deepEqual(JSON.parse(input.MessageBody), { schemaVersion: 1, taskId });
      return {
        response: {},
        output: {
          $metadata: {},
          MessageId: 'fact-message',
          MD5OfMessageBody: createHash('md5').update(input.MessageBody).digest('hex'),
        },
      };
    },
    { step: 'finalizeRequest', name: 'fakeFactQueue', priority: 'low' },
  );
  try {
    assert.equal(
      await queue.send({ schemaVersion: 1, jobId: taskId }, new AbortController().signal),
      'fact-message',
    );
  } finally {
    queue.close();
  }
});
