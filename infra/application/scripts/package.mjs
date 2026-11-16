import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileChecksum, localImage } from './artifacts.mjs';
import { validateImageMetadata } from './image.mjs';

const commit = process.env.GITHUB_SHA;
if (!commit || !/^[a-f0-9]{40}$/.test(commit)) {
  throw new Error('Expected the tested GitHub commit.');
}
const directory = resolve('release');
await mkdir(directory, { recursive: true });
const files = {};
const [metadata] = JSON.parse(
  execFileSync('docker', ['image', 'inspect', localImage], { encoding: 'utf8' }),
);
validateImageMetadata(metadata, metadata.Id);
execFileSync('docker', ['save', '--output', join(directory, 'api-image.tar'), localImage]);
const destination = join(directory, 'dispatcher.zip');
await rm(destination, { force: true });
execFileSync('zip', ['-q', '-r', destination, '.'], {
  cwd: resolve('services/outbox-dispatcher/dist'),
});

for (const name of ['api-image.tar', 'dispatcher.zip']) {
  files[name] = await fileChecksum(join(directory, name));
}
await writeFile(
  join(directory, 'manifest.json'),
  JSON.stringify({ commit, imageId: metadata.Id, files }, null, 2) + '\n',
);
