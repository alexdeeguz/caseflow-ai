import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaseStatus, caseCreateSchema, caseSchema } from '@caseflow/schemas';
import { parseWorkspaceLocation, workspaceHref } from '../lib/workspace-location';
import { WorkspaceTab, CaseView } from '../lib/constants/navigation';
import { caseListResource } from '../lib/workspace-resources';
import { formatIncidentDate } from '../lib/case-dates';

const caseId = '10000000-0000-4000-8000-000000000001';

test('case links preserve list context without accepting arbitrary destinations', () => {
  const location = {
    tab: WorkspaceTab.Cases,
    case: caseId,
    search: 'A & B / 100%',
    status: CaseStatus.Active,
    page: 3,
  };
  const href = workspaceHref(location);
  assert.ok(href.startsWith('/?'));
  assert.deepEqual(
    parseWorkspaceLocation(new URL(href, 'http://localhost').searchParams),
    location,
  );
  const outside = parseWorkspaceLocation(
    new URLSearchParams('tab=https://example.com&case=../../admin&page=-1&status=invalid'),
  );
  assert.equal(outside.tab, WorkspaceTab.Cases);
  assert.equal(outside.case, null);
  assert.equal(outside.page, 1);
  assert.equal(outside.status, undefined);
  assert.equal(parseWorkspaceLocation(new URLSearchParams('case=new')).case, CaseView.New);
});

test('leaving Cases clears the selected case but retains list filters', () => {
  const location = {
    tab: WorkspaceTab.Profile,
    case: caseId,
    search: 'client',
    status: CaseStatus.Closed,
    page: 2,
  };
  const params = new URL(workspaceHref(location), 'http://localhost').searchParams;
  assert.equal(params.get('case'), null);
  assert.equal(params.get('search'), 'client');
  assert.equal(params.get('page'), '2');
});

test('case resources encode search terms and isolate filtered cache keys', () => {
  const resource = caseListResource({ search: 'A&B', status: CaseStatus.Intake, page: 2 });
  const query = new URL(resource.path, 'http://localhost').searchParams;
  assert.equal(query.get('search'), 'A&B');
  assert.equal(query.get('status'), CaseStatus.Intake);
  assert.notEqual(resource.path, caseListResource().path);
});

test('calendar dates remain the same across local time zones', () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ['America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = zone;
      assert.equal(formatIncidentDate('2024-02-29'), 'Feb 29, 2024');
    }
    assert.equal(formatIncidentDate(null), 'Not provided');
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
});

test('shared case validation supplies defaults and rejects invalid calendar dates and forged fields', () => {
  const input = { title: ' Case ', clientName: ' Client ' };
  assert.deepEqual(caseCreateSchema.parse(input), {
    title: 'Case',
    clientName: 'Client',
    status: CaseStatus.Intake,
    incidentDate: null,
    summary: '',
  });
  for (const incidentDate of ['2025-02-29', '2026-04-31', '0000-01-01', '2026-01-01T00:00:00Z']) {
    assert.equal(caseCreateSchema.safeParse({ ...input, incidentDate }).success, false);
  }
  assert.equal(caseCreateSchema.safeParse({ ...input, role: 'admin' }).success, false);
  assert.equal(
    caseSchema.safeParse({
      ...input,
      id: caseId,
      caseNumber: 'CF-000001',
      createdAt: new Date().toISOString(),
      createdBy: null,
    }).success,
    false,
  );
});
