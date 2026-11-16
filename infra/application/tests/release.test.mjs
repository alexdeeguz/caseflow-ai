import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readReleaseConfig,
  assertCurrentCommit,
  loadReleaseArtifacts,
  releaseApplication,
} from '../scripts/release.mjs';

const config = {
  commit: 'a'.repeat(40),
  api: 'caseflow-application-api',
  dispatcher: 'caseflow-application-dispatcher',
  repository: 'alexdeeguz/caseflow-ai',
  token: 'test-token',
  imageRepository: '123456789012.dkr.ecr.us-east-2.amazonaws.com/caseflow-application-api',
};
const targets = [
  { name: config.api, kind: 'api', imageUri: `${config.imageRepository}@sha256:${'b'.repeat(64)}` },
  { name: config.dispatcher, kind: 'dispatcher', zip: Buffer.from('dispatcher') },
];

function harness(options = {}) {
  const calls = [];
  let checks = 0;
  return {
    calls,
    dependencies: {
      assertCurrent: async () => {
        checks += 1;
        if (options.staleAt === checks) {
          throw new Error('stale');
        }
      },
      waitForUpdate: async () => {},
      client: {
        send: async (command) => {
          const operation = command.constructor.name;
          const input = command.input;
          calls.push({ operation, input });
          if (operation === 'GetAliasCommand') {
            return { FunctionVersion: '1', RevisionId: 'old-alias' };
          }
          if (operation === 'GetFunctionConfigurationCommand') {
            return {
              RevisionId: 'old-function',
              PackageType: input.FunctionName === config.api ? 'Image' : 'Zip',
            };
          }
          if (operation === 'UpdateFunctionCodeCommand') {
            return { CodeSha256: 'digest' };
          }
          if (operation === 'PublishVersionCommand') {
            if (options.alreadyPublished) {
              throw Object.assign(new Error('No updates are to be published.'), {
                name: 'ResourceConflictException',
              });
            }
            return { Version: '2' };
          }
          if (operation === 'ListVersionsByFunctionCommand') {
            return {
              Versions: [
                { Version: '$LATEST' },
                {
                  Version: '2',
                  CodeSha256: options.wrongPublishedCode ? 'other-digest' : 'digest',
                },
              ],
            };
          }
          if (operation === 'InvokeCommand') {
            const value =
              input.FunctionName === config.api
                ? { statusCode: 401 }
                : { validated: !options.invalidDispatcher };
            return { Payload: Buffer.from(JSON.stringify(value)) };
          }
          if (operation === 'UpdateAliasCommand') {
            if (options.failPromotion && input.FunctionName === config.dispatcher) {
              throw new Error('promotion failed');
            }
            return { RevisionId: 'new-alias' };
          }
          throw new Error(`Unexpected operation ${operation}`);
        },
      },
    },
  };
}

test('both candidates are validated before either live alias changes', async () => {
  const { calls, dependencies } = harness();
  await releaseApplication(config, targets, dependencies);
  const firstPromotion = calls.findIndex((call) => call.operation === 'UpdateAliasCommand');
  assert.equal(
    calls.slice(0, firstPromotion).filter((call) => call.operation === 'InvokeCommand').length,
    2,
  );
  assert.deepEqual(
    calls
      .filter((call) => call.operation === 'UpdateAliasCommand')
      .map((call) => call.input.FunctionVersion),
    ['2', '2'],
  );
  assert.ok(
    calls
      .filter((call) => call.operation === 'UpdateFunctionCodeCommand')
      .every((call) => call.input.RevisionId === 'old-function'),
  );
  const updates = calls.filter((call) => call.operation === 'UpdateFunctionCodeCommand');
  assert.equal(updates[0].input.ImageUri, targets[0].imageUri);
  assert.equal(updates[0].input.ZipFile, undefined);
  assert.equal(updates[1].input.ImageUri, undefined);
  assert.deepEqual(updates[1].input.ZipFile, targets[1].zip);
});

test('mutable image tags cannot reach Lambda', async () => {
  const { calls, dependencies } = harness();
  await assert.rejects(
    releaseApplication(
      config,
      [{ ...targets[0], imageUri: `${config.imageRepository}:latest` }, targets[1]],
      dependencies,
    ),
    /immutable image/,
  );
  assert.equal(calls.length, 0);
});

test('a repeated release validates and reuses the already-published version', async () => {
  const { calls, dependencies } = harness({ alreadyPublished: true });
  await releaseApplication(config, targets, dependencies);
  assert.equal(calls.filter((call) => call.operation === 'InvokeCommand').length, 2);
  assert.deepEqual(
    calls
      .filter((call) => call.operation === 'UpdateAliasCommand')
      .map((call) => call.input.FunctionVersion),
    ['2', '2'],
  );
});

test('a mismatched published version cannot be promoted', async () => {
  const { calls, dependencies } = harness({ alreadyPublished: true, wrongPublishedCode: true });
  await assert.rejects(releaseApplication(config, targets, dependencies), /does not match/);
  assert.equal(calls.filter((call) => call.operation === 'UpdateAliasCommand').length, 0);
});

test('a failed candidate leaves all live aliases unchanged', async () => {
  const { calls, dependencies } = harness({ invalidDispatcher: true });
  await assert.rejects(releaseApplication(config, targets, dependencies), /failed validation/);
  assert.equal(calls.filter((call) => call.operation === 'UpdateAliasCommand').length, 0);
});

test('failed second promotion rolls the first alias back with a revision check', async () => {
  const { calls, dependencies } = harness({ failPromotion: true });
  await assert.rejects(releaseApplication(config, targets, dependencies), /promotion failed/);
  const rollback = calls.at(-1);
  assert.equal(rollback.input.FunctionName, config.api);
  assert.equal(rollback.input.FunctionVersion, '1');
  assert.equal(rollback.input.RevisionId, 'new-alias');
});

for (const staleAt of [1, 2]) {
  test(`stale main check ${staleAt} prevents promotion`, async () => {
    const { calls, dependencies } = harness({ staleAt });
    await assert.rejects(releaseApplication(config, targets, dependencies), /stale/);
    assert.equal(calls.filter((call) => call.operation === 'UpdateAliasCommand').length, 0);
    if (staleAt === 1) {
      assert.equal(calls.length, 0);
    }
  });
}

test('GitHub failures and newer commits fail closed', async () => {
  await assertCurrentCommit(config, async () => ({
    ok: true,
    json: async () => ({ object: { sha: config.commit } }),
  }));
  for (const response of [
    { ok: false },
    { ok: true, json: async () => ({ object: { sha: 'b'.repeat(40) } }) },
  ]) {
    await assert.rejects(
      assertCurrentCommit(config, async () => response),
      /not the current/,
    );
  }
});

test('release bundles must match both the tested commit and recorded checksum', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caseflow-release-'));
  try {
    const files = {};
    for (const name of ['api-image.tar', 'dispatcher.zip']) {
      const content = Buffer.from(name);
      await writeFile(join(directory, name), content);
      files[name] = createHash('sha256').update(content).digest('hex');
    }
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({ commit: config.commit, imageId: `sha256:${'c'.repeat(64)}`, files }),
    );
    assert.equal(
      (await loadReleaseArtifacts({ ...config, directory })).dispatcher.kind,
      'dispatcher',
    );
    await assert.rejects(
      loadReleaseArtifacts({ ...config, directory, commit: 'b'.repeat(40) }),
      /tested commit/,
    );
    await writeFile(join(directory, 'dispatcher.zip'), 'tampered');
    await assert.rejects(loadReleaseArtifacts({ ...config, directory }), /checksum/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release configuration restricts repository and function targets', () => {
  const env = {
    RELEASE_DIRECTORY: 'release',
    RELEASE_SHA: config.commit,
    API_FUNCTION_NAME: config.api,
    DISPATCHER_FUNCTION_NAME: config.dispatcher,
    GITHUB_REPOSITORY: config.repository,
    GITHUB_TOKEN: config.token,
    API_IMAGE_REPOSITORY: config.imageRepository,
  };
  assert.equal(readReleaseConfig(env).api, config.api);
  assert.throws(() => readReleaseConfig({ ...env, GITHUB_REPOSITORY: 'other/repo' }));
  assert.throws(() => readReleaseConfig({ ...env, DISPATCHER_FUNCTION_NAME: 'unrelated' }));
});
