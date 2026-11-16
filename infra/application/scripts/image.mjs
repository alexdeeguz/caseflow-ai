import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchGetImageCommand, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';

export function readImageRepository(value) {
  const match = /^(\d{12}\.dkr\.ecr\.us-east-2\.amazonaws\.com)\/(caseflow-[a-z0-9-]+-api)$/.exec(
    value ?? '',
  );

  if (!match) {
    throw new Error('Expected the API image repository in the selected Region.');
  }

  return { uri: value, registry: match[1] };
}

export function validateImageMetadata(metadata, expectedId) {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(expectedId ?? '') ||
    metadata.Id !== expectedId ||
    metadata.Os !== 'linux' ||
    metadata.Architecture !== 'amd64' ||
    JSON.stringify(metadata.Config?.Cmd) !== JSON.stringify(['index.handler'])
  ) {
    throw new Error('Container does not match the tested Lambda image.');
  }
}

export function resolvedImageUri(digests, repository) {
  const matches = digests.filter((value) => value.startsWith(`${repository}@sha256:`));

  if (matches.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(matches[0].split('@')[1])) {
    throw new Error('Registry did not return an immutable image digest.');
  }

  return matches[0];
}

export async function publishImage(config, manifest, client, run = execFileSync) {
  const repository = readImageRepository(config.imageRepository);
  const dockerConfig = await mkdtemp(join(tmpdir(), 'caseflow-docker-auth-'));
  const docker = (args, input) =>
    run('docker', ['--config', dockerConfig, ...args], {
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 1024 * 1024,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

  try {
    docker(['load', '--input', join(config.directory, 'api-image.tar')]);
    const [metadata] = JSON.parse(docker(['image', 'inspect', manifest.imageId]));
    validateImageMetadata(metadata, manifest.imageId);

    const tagName = `git-${config.commit}-${manifest.imageId.slice(7, 23)}`;
    const existing = await client.send(
      new BatchGetImageCommand({
        repositoryName: repository.uri.split('/')[1],
        imageIds: [{ imageTag: tagName }],
        acceptedMediaTypes: [
          'application/vnd.docker.distribution.manifest.v2+json',
          'application/vnd.oci.image.manifest.v1+json',
        ],
      }),
    );
    const image = existing.images?.[0];

    if (image) {
      if (JSON.parse(image.imageManifest ?? '{}').config?.digest !== manifest.imageId) {
        throw new Error('Existing registry tag does not match the tested image.');
      }
      return resolvedImageUri([`${repository.uri}@${image.imageId?.imageDigest}`], repository.uri);
    }

    if (existing.failures?.some((failure) => failure.failureCode !== 'ImageNotFound')) {
      throw new Error('Could not verify the existing registry tag.');
    }

    const response = await client.send(new GetAuthorizationTokenCommand({}));
    const authorization = response.authorizationData?.find(
      (item) => item.proxyEndpoint === `https://${repository.registry}`,
    );

    if (!authorization?.authorizationToken) {
      throw new Error('Image registry authentication unavailable.');
    }

    const token = Buffer.from(authorization.authorizationToken, 'base64').toString();

    if (!token.startsWith('AWS:')) {
      throw new Error('Invalid image registry authorization.');
    }

    docker(['login', '--username', 'AWS', '--password-stdin', repository.registry], token.slice(4));
    const tag = `${repository.uri}:${tagName}`;
    docker(['tag', manifest.imageId, tag]);
    docker(['push', tag]);
    const [published] = JSON.parse(docker(['image', 'inspect', tag]));
    return resolvedImageUri(published.RepoDigests ?? [], repository.uri);
  } catch {
    // Docker errors can include authentication output; expose only a safe failure.
    throw new Error('Could not publish the tested API image. Live aliases have not changed.');
  } finally {
    await rm(dockerConfig, { recursive: true, force: true });
  }
}
