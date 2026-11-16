import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const localImage = 'caseflow-api:tested';

export async function fileChecksum(path) {
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

export async function verifyArtifacts(directory, commit) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));

  if (manifest.commit !== commit || !/^sha256:[a-f0-9]{64}$/.test(manifest.imageId ?? '')) {
    throw new Error('Release artifact does not match the tested commit or image.');
  }

  for (const [name, limit] of [
    ['api-image.tar', 2 * 1024 * 1024 * 1024],
    ['dispatcher.zip', 50 * 1024 * 1024],
  ]) {
    const path = join(directory, name);
    const metadata = await stat(path);

    if (
      !metadata.isFile() ||
      metadata.size === 0 ||
      metadata.size > limit ||
      (await fileChecksum(path)) !== manifest.files?.[name]
    ) {
      throw new Error('Release artifact checksum or size is invalid.');
    }
  }

  return manifest;
}
