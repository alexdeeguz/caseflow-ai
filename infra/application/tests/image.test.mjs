import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import { access } from 'node:fs/promises';
import {
  publishImage,
  readImageRepository,
  resolvedImageUri,
  validateImageMetadata,
} from '../scripts/image.mjs';

const repository = '123456789012.dkr.ecr.us-east-2.amazonaws.com/caseflow-application-api';
const imageId = `sha256:${'a'.repeat(64)}`;
const digest = `sha256:${'b'.repeat(64)}`;
const metadata = {
  Id: imageId,
  Os: 'linux',
  Architecture: 'amd64',
  Config: { Cmd: ['index.handler'] },
};

test('rejects unrelated registries, mutable digests, and incompatible Lambda images', () => {
  assert.equal(readImageRepository(repository).uri, repository);
  for (const value of [repository.replace('us-east-2', 'us-west-2'), 'docker.io/api', undefined]) {
    assert.throws(() => readImageRepository(value));
  }
  validateImageMetadata(metadata, imageId);
  for (const value of [
    { ...metadata, Architecture: 'arm64' },
    { ...metadata, Id: digest },
    { ...metadata, Config: { Cmd: ['other.handler'] } },
  ]) {
    assert.throws(() => validateImageMetadata(value, imageId));
  }
  assert.throws(() => resolvedImageUri([`${repository}:latest`], repository));
  assert.throws(() => resolvedImageUri([`unrelated@${digest}`], repository));
});

test('publishes the verified archive without rebuilding and cleans registry credentials', async () => {
  const calls = [];
  const secret = 'fixture-password';
  const config = { directory: '/tmp/release', commit: 'c'.repeat(40), imageRepository: repository };
  const client = {
    send: async (command) =>
      command.constructor.name === 'BatchGetImageCommand'
        ? { images: [] }
        : {
            authorizationData: [
              {
                proxyEndpoint: `https://${repository.split('/')[0]}`,
                authorizationToken: Buffer.from(`AWS:${secret}`).toString('base64'),
              },
            ],
          },
  };
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('inspect')) {
      return JSON.stringify([{ ...metadata, RepoDigests: [`${repository}@${digest}`] }]);
    }
    return '';
  };
  assert.equal(await publishImage(config, { imageId }, client, run), `${repository}@${digest}`);
  assert.ok(calls.some(({ args }) => args.includes('load')));
  assert.ok(!calls.some(({ args }) => args.includes('build')));
  const login = calls.find(({ args }) => args.includes('login'));
  assert.equal(login.options.input, secret);
  assert.ok(!login.args.join(' ').includes(secret));
  await assert.rejects(access(login.args[1]));
});

test('a repeated image publication reuses only the matching immutable registry image', async () => {
  const config = { directory: '/tmp/release', commit: 'c'.repeat(40), imageRepository: repository };
  const calls = [];
  const client = (existingId) => ({
    send: async (command) => {
      assert.equal(command.constructor.name, 'BatchGetImageCommand');
      return {
        images: [
          {
            imageManifest: JSON.stringify({ config: { digest: existingId } }),
            imageId: { imageDigest: digest },
          },
        ],
      };
    },
  });
  const run = (_command, args) => {
    calls.push(args);
    return args.includes('inspect') ? JSON.stringify([metadata]) : '';
  };
  assert.equal(
    await publishImage(config, { imageId }, client(imageId), run),
    `${repository}@${digest}`,
  );
  assert.ok(!calls.some((args) => args.includes('push') || args.includes('login')));
  await assert.rejects(publishImage(config, { imageId }, client(digest), run), /Could not publish/);
});

test('Docker failures do not expose credentials and still clean authentication files', async () => {
  let directory;
  await assert.rejects(
    publishImage(
      { directory: '/tmp/release', imageRepository: repository },
      { imageId },
      {
        send: async () => {
          throw new Error('not expected');
        },
      },
      (_command, args) => {
        directory = args[1];
        throw new Error('private provider output');
      },
    ),
    { message: 'Could not publish the tested API image. Live aliases have not changed.' },
  );
  await assert.rejects(access(directory));
});
