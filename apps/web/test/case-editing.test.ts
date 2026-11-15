import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CaseArchiveFilter,
  CaseStatus,
  caseUpdateSchema,
  caseVersionSchema,
  type Case,
} from '@caseflow/schemas';
import { ApiError } from '../lib/api';
import { caseFormValues, createCaseDraftStore, withDraftAccessChecks } from '../lib/case-drafts';
import { parseWorkspaceLocation, workspaceHref } from '../lib/workspace-location';
import { caseListResource } from '../lib/workspace-resources';
import { CaseMode, WorkspaceTab } from '../lib/constants/navigation';

const record: Case = {
  id: '10000000-0000-4000-8000-000000000001',
  caseNumber: 'CF-000001',
  title: 'Case title',
  clientName: 'Fictional Client',
  incidentDate: null,
  status: CaseStatus.Active,
  summary: 'Summary',
  createdAt: '2026-11-14T00:00:00.000Z',
  createdBy: null,
  version: 1,
  updatedAt: '2026-11-14T00:00:00.000Z',
  archivedAt: null,
  archivedBy: null,
};

test('partial contracts never apply creation defaults and require an explicit version', () => {
  assert.deepEqual(caseUpdateSchema.parse({ expectedVersion: 3, title: ' Changed ' }), {
    expectedVersion: 3,
    title: 'Changed',
  });
  assert.deepEqual(
    caseUpdateSchema.parse({ expectedVersion: 1, incidentDate: null, summary: '' }),
    { expectedVersion: 1, incidentDate: null, summary: '' },
  );
  for (const patch of [
    { title: 'Title' },
    { expectedVersion: 0 },
    { expectedVersion: 1, status: null },
    { expectedVersion: 1, id: record.id },
  ]) {
    assert.equal(caseUpdateSchema.safeParse(patch).success, false);
  }
  assert.equal(
    caseVersionSchema.safeParse({ expectedVersion: 1, archivedBy: record.id }).success,
    false,
  );
});

test('edit bookmarks and archive filters round-trip without putting drafts in the URL', () => {
  const location = {
    tab: WorkspaceTab.Cases,
    case: record.id,
    mode: CaseMode.Edit,
    search: 'A & B',
    status: CaseStatus.Active,
    archive: CaseArchiveFilter.Archived,
    page: 3,
  };
  const href = workspaceHref(location);
  assert.deepEqual(
    parseWorkspaceLocation(new URL(href, 'http://localhost').searchParams),
    location,
  );
  const defaults = parseWorkspaceLocation(
    new URLSearchParams('archive=deleted&mode=edit&case=new'),
  );
  assert.equal(defaults.archive, CaseArchiveFilter.Current);
  assert.equal(defaults.mode, undefined);
  assert.equal(
    new URL(
      workspaceHref({ ...location, tab: WorkspaceTab.Profile }),
      'http://localhost',
    ).searchParams.has('mode'),
    false,
  );
  assert.notEqual(
    caseListResource({ archive: CaseArchiveFilter.Archived }).path,
    caseListResource().path,
  );
});

test('drafts retain their original version and fields across navigation and background refresh', () => {
  const store = createCaseDraftStore();
  const values = { ...caseFormValues(record), title: 'Unsaved title' };
  store.update(record, values);
  store.update(
    { ...record, version: 2, summary: 'Remote change' },
    { ...values, clientName: 'New client' },
  );
  const draft = store.getSnapshot().get(record.id)!;
  assert.equal(draft.expectedVersion, 1);
  assert.equal(draft.values.summary, 'Summary');
  store.markConflict(record.id);
  assert.equal(store.getSnapshot().get(record.id)!.conflict, true);
  store.setSaving(record.id, true);
  assert.equal(store.getSnapshot().get(record.id)!.saving, true);
  assert.equal(createCaseDraftStore().getSnapshot().size, 0);
  store.remove(record.id);
  assert.equal(store.getSnapshot().size, 0);
});

test('returning fields to the original values removes dirty state and clear removes all drafts', () => {
  const store = createCaseDraftStore();
  store.update(record, { ...caseFormValues(record), summary: 'Draft' });
  store.update(record, caseFormValues(record));
  assert.equal(store.getSnapshot().size, 0);
  store.update(record, { ...caseFormValues(record), summary: 'Draft' });
  store.clear();
  assert.equal(store.getSnapshot().size, 0);
});

test('access rejection clears drafts while conflicts and service failures retain them', async () => {
  for (const status of [401, 403, 404, 409, 503]) {
    const store = createCaseDraftStore();
    store.update(record, { ...caseFormValues(record), summary: 'Draft' });
    const request = withDraftAccessChecks(async () => {
      throw new ApiError(status, 'TEST', 'Rejected');
    }, store);
    await assert.rejects(request(`/cases/${record.id}`, caseUpdateSchema));
    assert.equal(store.getSnapshot().size, [401, 403, 404].includes(status) ? 0 : 1);
  }
});
