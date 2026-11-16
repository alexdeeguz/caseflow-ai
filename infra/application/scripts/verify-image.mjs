import { execFileSync } from 'node:child_process';
import { localImage } from './artifacts.mjs';
import { validateImageMetadata } from './image.mjs';

const [metadata] = JSON.parse(
  execFileSync('docker', ['image', 'inspect', localImage], { encoding: 'utf8' }),
);
validateImageMetadata(metadata, metadata.Id);

execFileSync(
  'docker',
  [
    'run',
    '--rm',
    '--platform',
    'linux/amd64',
    '--network',
    'none',
    '--read-only',
    '--user',
    '1000:1000',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--env',
    'AWS_EC2_METADATA_DISABLED=true',
    '--env',
    'AWS_REGION=us-east-2',
    '--entrypoint',
    '/var/lang/bin/node',
    localImage,
    '--input-type=module',
    '-e',
    `
      import assert from 'node:assert/strict';
      import { readFileSync, readdirSync } from 'node:fs';
      import { X509Certificate } from 'node:crypto';
      import { handler } from '/var/task/index.mjs';
      assert.deepEqual(readdirSync('/var/task').sort(), ['certs', 'index.mjs']);
      const certificate = new X509Certificate(readFileSync('/var/task/certs/supabase-ca.crt'));
      assert.equal(certificate.ca, true);
      assert.ok(Date.parse(certificate.validTo) > Date.now());
      const response = await handler({}, {});
      assert.equal(response.statusCode, 503);
      assert.equal(response.headers['Cache-Control'], 'no-store');
      assert.equal(JSON.parse(response.body).code, 'SERVICE_UNAVAILABLE');
      console.info('Lambda image loads under a non-root user and fails closed without credentials.');
    `,
  ],
  { stdio: 'inherit', timeout: 30000 },
);
