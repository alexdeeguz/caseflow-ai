import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaseArchiveFilter, CaseStatus, DocumentFilter, Role } from '@caseflow/schemas';
import {
  parseWorkspaceLocation,
  workspaceHref,
  type WorkspaceLocation,
} from '../lib/workspace-location';
import { CaseSection, WorkspaceTab } from '../lib/constants/navigation';
import { documentLibraryQuery, documentListResource } from '../lib/documents/resources';
import { documentEmptyState, formatFileSize } from '../lib/documents/presentation';
import { locationResources } from '../components/workspace/navigation';

const caseId = '10000000-0000-4000-8000-000000000001';
const otherCaseId = '10000000-0000-4000-8000-000000000002';

test('document bookmarks preserve independent document and case-list state', () => {
  const location = {
    ...parseWorkspaceLocation(new URLSearchParams()),
    case: caseId,
    section: CaseSection.Documents,
    documentFilter: DocumentFilter.Removed,
    documentPage: 4,
    search: 'A & B',
    status: CaseStatus.Active,
    archive: CaseArchiveFilter.Archived,
    page: 2,
  };
  const roundTrip = (value: WorkspaceLocation) =>
    parseWorkspaceLocation(new URL(workspaceHref(value), 'http://localhost').searchParams);
  assert.deepEqual(roundTrip(location), location);
  assert.deepEqual(roundTrip({ ...location, section: CaseSection.Overview }), {
    ...location,
    section: CaseSection.Overview,
  });
  const list = parseWorkspaceLocation(
    new URL(workspaceHref({ ...location, case: null }), 'http://localhost').searchParams,
  );
  assert.equal(list.page, 2);
  assert.equal(list.search, 'A & B');
  assert.equal(list.archive, CaseArchiveFilter.Archived);
  assert.equal(list.section, CaseSection.Overview);
  assert.equal(list.documentPage, 1);
  assert.equal(list.documentFilter, DocumentFilter.Current);
});

test('invalid sections, filters and document page values use safe defaults', () => {
  for (const page of ['0', '-1', '1.5', 'Infinity', 'NaN', '100001']) {
    const location = parseWorkspaceLocation(
      new URLSearchParams(
        `case=${caseId}&section=invalid&documentFilter=hidden&documentPage=${page}`,
      ),
    );
    assert.equal(location.section, CaseSection.Overview);
    assert.equal(location.documentFilter, DocumentFilter.Current);
    assert.equal(location.documentPage, 1);
  }
});

test('document context is ignored outside an existing case', () => {
  for (const prefix of ['case=new', 'case=invalid', `tab=profile&case=${caseId}`, '']) {
    const location = parseWorkspaceLocation(
      new URLSearchParams(`${prefix}&section=documents&documentFilter=removed&documentPage=3`),
    );
    assert.equal(location.section, CaseSection.Overview);
    assert.equal(location.documentFilter, DocumentFilter.Current);
    assert.equal(location.documentPage, 1);
    const params = new URL(workspaceHref(location), 'http://localhost').searchParams;
    assert.equal(params.has('section'), false);
    assert.equal(params.has('documentFilter'), false);
    assert.equal(params.has('documentPage'), false);
  }
});

test('Staff never request removed metadata through a forged or old admin bookmark', () => {
  const location = parseWorkspaceLocation(
    new URLSearchParams(`case=${caseId}&section=documents&documentFilter=removed&documentPage=3`),
  );
  for (const filter of Object.values(DocumentFilter)) {
    assert.deepEqual(documentLibraryQuery({ ...location, documentFilter: filter }, Role.Staff), {
      filter: DocumentFilter.Current,
      page: filter === DocumentFilter.Current ? 3 : 1,
    });
  }
  for (const role of [Role.Admin, Role.SuperAdmin]) {
    assert.deepEqual(documentLibraryQuery(location, role), {
      filter: DocumentFilter.Removed,
      page: 3,
    });
  }
});

test('library cache keys isolate cases, visibility filters, and pages', () => {
  const base = documentListResource(caseId, { filter: DocumentFilter.Current, page: 1 });
  const variants = [
    documentListResource(otherCaseId, { filter: DocumentFilter.Current, page: 1 }),
    documentListResource(caseId, { filter: DocumentFilter.Removed, page: 1 }),
    documentListResource(caseId, { filter: DocumentFilter.All, page: 1 }),
    documentListResource(caseId, { filter: DocumentFilter.Current, page: 2 }),
  ];
  assert.equal(new Set([base, ...variants].map((resource) => resource.path)).size, 5);
  const query = new URL(base.path, 'http://localhost').searchParams;
  assert.deepEqual([...query.keys()].sort(), ['filter', 'page']);
});

test('document navigation preloads the case and library using current role visibility', () => {
  const location = parseWorkspaceLocation(
    new URLSearchParams(`case=${caseId}&section=documents&documentFilter=removed`),
  );
  const admin = locationResources(location, Role.Admin);
  assert.equal(admin.length, 2);
  assert.equal(admin[0]?.path, `/cases/${caseId}`);
  assert.equal(admin[1]?.path, `/cases/${caseId}/documents?page=1&filter=removed`);
  assert.equal(
    locationResources(location, Role.Staff)[1]?.path,
    `/cases/${caseId}/documents?page=1&filter=current`,
  );
  assert.equal(
    locationResources({ ...location, section: CaseSection.Overview }, Role.Admin).length,
    1,
  );
  assert.equal(locationResources({ ...location, mode: 'edit' }, Role.Admin).length, 1);
  assert.equal(locationResources({ ...location, tab: WorkspaceTab.Profile }, Role.Admin).length, 0);
});

test('file sizes use accurate binary units and handle byte boundaries', () => {
  assert.equal(formatFileSize(1), '1 byte');
  assert.equal(formatFileSize(1023), '1023 bytes');
  assert.equal(formatFileSize(1024), '1 KiB');
  assert.equal(formatFileSize(1536), '1.5 KiB');
  assert.equal(formatFileSize(1024 * 1024), '1 MiB');
  assert.equal(formatFileSize(25 * 1024 * 1024), '25 MiB');
});

test('empty visibility filters and out-of-range pages have distinct guidance', () => {
  assert.equal(documentEmptyState(DocumentFilter.Current, 1).title, 'No current documents');
  assert.equal(documentEmptyState(DocumentFilter.Removed, 1).title, 'No removed documents');
  assert.equal(documentEmptyState(DocumentFilter.All, 1).title, 'No documents yet');
  for (const filter of Object.values(DocumentFilter)) {
    assert.equal(documentEmptyState(filter, 9).title, 'No documents on this page');
  }
});
