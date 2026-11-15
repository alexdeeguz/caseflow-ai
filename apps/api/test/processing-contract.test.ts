import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { processingMessageSchema } from '@caseflow/schemas';

const fixtures: { name: string; valid: boolean; message: unknown }[] = JSON.parse(
  await readFile(
    new URL('../../../packages/schemas/fixtures/processing-messages.json', import.meta.url),
    'utf8',
  ),
);

for (const fixture of fixtures) {
  test(`shared Python/TypeScript queue contract: ${fixture.name}`, () => {
    assert.equal(processingMessageSchema.safeParse(fixture.message).success, fixture.valid);
  });
}
