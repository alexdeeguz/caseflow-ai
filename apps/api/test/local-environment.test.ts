import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePrivateFile } from '../scripts/lib/private-file.js';

for (const existing of [false, true]) {
  test(`environment files are owner-only, including existing files: ${existing}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caseflow-env-test-'));
    const path = join(directory, '.env');

    try {
      if (existing) {
        await writeFile(path, 'OLD=value\n');
        await chmod(path, 0o644);
      }

      await writePrivateFile(path, 'SETTING=value\n');

      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal(await readFile(path, 'utf8'), 'SETTING=value\n');
      assert.deepEqual(await readdir(directory), ['.env']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
