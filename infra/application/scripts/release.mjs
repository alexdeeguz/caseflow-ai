import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LambdaClient,
  GetAliasCommand,
  GetFunctionConfigurationCommand,
  UpdateFunctionCodeCommand,
  PublishVersionCommand,
  ListVersionsByFunctionCommand,
  InvokeCommand,
  UpdateAliasCommand,
  waitUntilFunctionUpdated,
} from '@aws-sdk/client-lambda';
import { ECRClient } from '@aws-sdk/client-ecr';
import { verifyArtifacts } from './artifacts.mjs';
import { publishImage, readImageRepository } from './image.mjs';

export function readReleaseConfig(env) {
  const {
    RELEASE_DIRECTORY: directory,
    RELEASE_SHA: commit,
    API_FUNCTION_NAME: api,
    DISPATCHER_FUNCTION_NAME: dispatcher,
    GITHUB_REPOSITORY: repository,
    GITHUB_TOKEN: token,
    API_IMAGE_REPOSITORY: imageRepository,
  } = env;

  if (
    !directory ||
    !commit ||
    !/^[a-f0-9]{40}$/.test(commit) ||
    !api ||
    !dispatcher ||
    !/^caseflow-[A-Za-z0-9-]+-api$/.test(api) ||
    dispatcher !== api.replace(/-api$/, '-dispatcher') ||
    repository !== 'alexdeeguz/caseflow-ai' ||
    !token
  ) {
    throw new Error('Invalid release configuration.');
  }

  readImageRepository(imageRepository);

  if (imageRepository.split('/')[1] !== api) {
    throw new Error('Image repository must belong to the API function.');
  }

  return { directory, commit, api, dispatcher, repository, token, imageRepository };
}

export async function assertCurrentCommit(config, request = globalThis.fetch) {
  const response = await request(
    `https://api.github.com/repos/${config.repository}/git/ref/heads/main`,
    {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/vnd.github+json' },
      signal: globalThis.AbortSignal.timeout(10000),
      redirect: 'error',
    },
  );

  if (!response.ok || (await response.json()).object?.sha !== config.commit) {
    throw new Error('Release is not the current main commit.');
  }
}

export async function loadReleaseArtifacts(config) {
  const manifest = await verifyArtifacts(config.directory, config.commit);
  const zip = await readFile(join(config.directory, 'dispatcher.zip'));

  return { manifest, dispatcher: { name: config.dispatcher, kind: 'dispatcher', zip } };
}

export function waitForLambdaUpdate(client, name) {
  return waitUntilFunctionUpdated(
    { client, maxWaitTime: 120, minDelay: 1, maxDelay: 5 },
    { FunctionName: name },
  );
}

async function validateCandidate(client, target, version) {
  const payload =
    target.kind === 'api'
      ? {
          version: '2.0',
          routeKey: '$default',
          rawPath: '/me',
          rawQueryString: '',
          headers: {},
          requestContext: { http: { method: 'GET', path: '/me', sourceIp: '127.0.0.1' } },
          isBase64Encoded: false,
        }
      : { action: 'validate' };

  const response = await client.send(
    new InvokeCommand({
      FunctionName: target.name,
      Qualifier: version,
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  const value = JSON.parse(Buffer.from(response.Payload ?? []).toString());

  if (
    response.FunctionError ||
    (target.kind === 'api' ? value.statusCode !== 401 : value.validated !== true)
  ) {
    throw new Error('Candidate Lambda failed validation. Live aliases have not changed.');
  }
}

async function publishCandidate(client, name, commit, codeHash) {
  const current = await client.send(new GetFunctionConfigurationCommand({ FunctionName: name }));

  try {
    return await client.send(
      new PublishVersionCommand({
        FunctionName: name,
        CodeSha256: codeHash,
        RevisionId: current.RevisionId,
        Description: commit,
      }),
    );
  } catch (error) {
    if (
      error.name !== 'ResourceConflictException' ||
      !/no updates are to be published/i.test(error.message)
    ) {
      throw error;
    }

    // A retried release can contain the already-published code and configuration.
    let marker;
    let latest;
    for (let page = 0; page < 20; page++) {
      const response = await client.send(
        new ListVersionsByFunctionCommand({ FunctionName: name, Marker: marker, MaxItems: 50 }),
      );
      for (const version of response.Versions ?? []) {
        if (
          /^[1-9][0-9]*$/.test(version.Version ?? '') &&
          (!latest || BigInt(version.Version) > BigInt(latest.Version))
        ) {
          latest = version;
        }
      }
      marker = response.NextMarker;
      if (!marker) {
        if (latest?.CodeSha256 !== codeHash) {
          throw new Error('Published Lambda version does not match the tested code.');
        }
        return latest;
      }
    }
    throw new Error('Too many Lambda versions to verify a repeated release.');
  }
}

export async function releaseApplication(config, targets, dependencies) {
  const { client, waitForUpdate, assertCurrent } = dependencies;
  const apiTarget = targets.find((target) => target.kind === 'api');

  if (
    !apiTarget ||
    !apiTarget.imageUri?.startsWith(`${config.imageRepository}@sha256:`) ||
    !/^sha256:[a-f0-9]{64}$/.test(apiTarget.imageUri.split('@')[1])
  ) {
    throw new Error('Release requires an immutable image from the API repository.');
  }

  await assertCurrent();
  const prepared = [];

  for (const target of targets) {
    const previous = await client.send(
      new GetAliasCommand({ FunctionName: target.name, Name: 'live' }),
    );
    const current = await client.send(
      new GetFunctionConfigurationCommand({ FunctionName: target.name }),
    );

    if (current.PackageType !== (target.kind === 'api' ? 'Image' : 'Zip')) {
      throw new Error('Lambda packaging differs from the reviewed infrastructure.');
    }

    const updated = await client.send(
      new UpdateFunctionCodeCommand({
        FunctionName: target.name,
        ...(target.kind === 'api' ? { ImageUri: target.imageUri } : { ZipFile: target.zip }),
        RevisionId: current.RevisionId,
      }),
    );
    await waitForUpdate(target.name);

    const published = await publishCandidate(
      client,
      target.name,
      config.commit,
      updated.CodeSha256,
    );

    if (!published.Version || !previous.FunctionVersion || !previous.RevisionId) {
      throw new Error('Lambda did not return the expected version metadata.');
    }

    await validateCandidate(client, target, published.Version);
    prepared.push({ ...target, previous, version: published.Version });
  }

  // A newer push may have arrived while candidate versions were being prepared.
  await assertCurrent();
  const promoted = [];

  try {
    for (const target of prepared) {
      const result = await client.send(
        new UpdateAliasCommand({
          FunctionName: target.name,
          Name: 'live',
          FunctionVersion: target.version,
          RevisionId: target.previous.RevisionId,
          Description: config.commit,
        }),
      );
      promoted.push({ ...target, revision: result.RevisionId });
    }
  } catch (error) {
    const rollback = await Promise.allSettled(
      promoted.reverse().map((target) =>
        client.send(
          new UpdateAliasCommand({
            FunctionName: target.name,
            Name: 'live',
            FunctionVersion: target.previous.FunctionVersion,
            RevisionId: target.revision,
            Description: target.previous.Description,
          }),
        ),
      ),
    );

    if (rollback.some((result) => result.status === 'rejected')) {
      throw new Error('Release failed and automatic rollback needs operator attention.');
    }

    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = readReleaseConfig(process.env);
  const client = new LambdaClient({ region: 'us-east-2', maxAttempts: 3 });
  const registry = new ECRClient({ region: 'us-east-2', maxAttempts: 3 });

  try {
    await assertCurrentCommit(config);
    const { manifest, dispatcher } = await loadReleaseArtifacts(config);
    const imageUri = await publishImage(config, manifest, registry);
    const targets = [{ name: config.api, kind: 'api', imageUri }, dispatcher];
    await releaseApplication(config, targets, {
      client,
      waitForUpdate: (name) => waitForLambdaUpdate(client, name),
      assertCurrent: () => assertCurrentCommit(config),
    });
    console.info(`Released tested commit ${config.commit}.`);
  } finally {
    client.destroy();
    registry.destroy();
  }
}
