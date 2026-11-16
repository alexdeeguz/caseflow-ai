import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { factCorrectionSchema, reviewedFactSchema } from '@caseflow/schemas';
import {
  createFactDraftStore,
  isFactDraftDirty,
  withFactDraftAccessChecks,
} from '../lib/fact-review/drafts';
import { createResourceClient, withResourceInvalidation } from '../lib/resources';
import { ApiError } from '../lib/api';

const values = {
  category: 'finding',
  value: 'Fracture',
  qualifier: null,
  dateValue: null,
  datePrecision: null,
  dateMeaning: null,
  treatmentStatus: null,
  findingStatus: 'confirmed',
  negated: true,
};
function fact() {
  return reviewedFactSchema.parse({
    ...values,
    id: randomUUID(),
    extractionJobId: randomUUID(),
    original: values,
    evidence: [
      {
        id: randomUUID(),
        documentId: randomUUID(),
        processingResultId: randomUUID(),
        page: 1,
        quote: 'No fracture.',
        start: 0,
        end: 12,
      },
    ],
    reviewStatus: 'unreviewed',
    version: 1,
    corrected: false,
    reviewedBy: null,
    reviewedAt: null,
  });
}
test('drafts retain the original version and dirty values across navigation and background refresh', () => {
  const store = createFactDraftStore();
  const record = fact();
  store.begin(record, 'case', 'document');
  assert.equal(isFactDraftDirty(store.getSnapshot().get(record.id)!), false);
  store.update(record.id, {
    values: { ...record.original, value: 'Edited finding' },
    reason: 'Check source',
  });
  store.begin({ ...record, version: 2, value: 'Remote edit' }, 'case', 'document');
  const draft = store.getSnapshot().get(record.id)!;
  assert.equal(draft.expectedVersion, 1);
  assert.equal(draft.values.value, 'Edited finding');
  assert.equal(isFactDraftDirty(draft), true);
  store.update(record.id, { conflict: true });
  assert.equal(store.getSnapshot().get(record.id)!.conflict, true);
  store.remove(record.id);
  store.begin({ ...record, version: 2 }, 'case', 'document');
  assert.equal(store.getSnapshot().get(record.id)!.expectedVersion, 2);
  store.clear();
  assert.equal(store.getSnapshot().size, 0);
});
test('access rejection or removal clears protected correction drafts', async () => {
  const store = createFactDraftStore();
  const record = fact();
  for (const status of [401, 403, 404, 409]) {
    store.begin(record, 'case', 'document');
    const request = withFactDraftAccessChecks(async () => {
      throw new ApiError(status, 'DOCUMENT_UNAVAILABLE', 'Unavailable');
    }, store);
    await assert.rejects(request('/cases/case/documents/document/facts', reviewedFactSchema));
    assert.equal(store.getSnapshot().size, 0);
  }
  store.begin(record, 'case', 'document');
  const schema = { parse: () => ({ items: [{ id: 'document', status: 'removed' }] }) };
  const request = withFactDraftAccessChecks(async (_path, parser) => parser.parse(null), store);
  await request('/cases/case/documents?filter=all', schema);
  assert.equal(store.getSnapshot().size, 0);
});
test('review mutations invalidate document facts/history and audit without unrelated requests', async () => {
  const client = createResourceClient();
  const root = '/cases/c/documents/d/facts';
  const paths = [
    `${root}?page=1`,
    `${root}/f/history?page=1`,
    `${root}/f`,
    '/admin/audit?page=1',
    '/cases/c/documents/other/facts?page=1',
    '/cases/c/documents?page=1',
  ];
  paths.forEach((path) => client.setQueryData([path], {}));
  try {
    const request = withResourceInvalidation(client, async (_path, parser) => parser.parse(fact()));
    await request(`${root}/f/approve`, reviewedFactSchema, { method: 'POST' });
    assert.deepEqual(
      paths.map((path) => client.getQueryState([path])?.isInvalidated),
      [true, true, true, true, false, false],
    );
  } finally {
    client.clear();
  }
});
test('correction contracts reject invented evidence, category mismatches and blank reasons', () => {
  const record = fact();
  const body = { expectedVersion: 1, values: record.original, reason: 'Clarified the source' };
  assert.equal(factCorrectionSchema.safeParse(body).success, true);
  for (const input of [
    { ...body, evidence: [] },
    { ...body, reason: ' ' },
    { ...body, values: { ...body.values, value: ' ' } },
    { ...body, values: { ...body.values, dateValue: '2026' } },
    { ...body, values: { ...body.values, category: 'treatment' } },
  ]) {
    assert.equal(factCorrectionSchema.safeParse(input).success, false);
  }
});
