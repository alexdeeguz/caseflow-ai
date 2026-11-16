import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  factExtractionMessageSchema,
  factExtractionRequestSchema,
  factQuerySchema,
} from '@caseflow/schemas';

const fixtures = JSON.parse(
  readFileSync(
    new URL('../../../packages/schemas/fixtures/fact-messages.json', import.meta.url),
    'utf8',
  ),
);
for (const fixture of fixtures) {
  test(`fact queue compatibility: ${fixture.name}`, () => {
    assert.equal(factExtractionMessageSchema.safeParse(fixture.message).success, fixture.valid);
  });
}
test('fact requests reject forged state and strict queries reject internal fields', () => {
  assert.equal(factExtractionRequestSchema.safeParse({ expectedJobId: null }).success, true);
  for (const key of ['role', 'sourceKey', 'model', 'status', 'requestedBy']) {
    assert.equal(
      factExtractionRequestSchema.safeParse({ expectedJobId: null, [key]: 'forged' }).success,
      false,
    );
  }
  assert.equal(factQuerySchema.safeParse({ category: 'finding' }).success, true);
  assert.equal(factQuerySchema.safeParse({ sourceKey: 'private' }).success, false);
});
