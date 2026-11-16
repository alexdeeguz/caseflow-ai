import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaseArchiveFilter, Role, SearchMode } from '@caseflow/schemas';
import { parseWorkspaceLocation, workspaceHref } from '../lib/workspace-location';
import { CaseSection, WorkspaceTab } from '../lib/constants/navigation';
import { locationResources } from '../components/workspace/navigation';
import { highlightSegments } from '../lib/search/highlight';
import { documentSearchResource, isSearchable } from '../lib/search/resources';
import { createResourceClient, withResourceInvalidation } from '../lib/resources';

const caseId = '10000000-0000-4000-8000-000000000001';
const documentId = '10000000-0000-4000-8000-000000000002';

const parse = (query: string) => parseWorkspaceLocation(new URLSearchParams(query));

test('global search state round-trips through the URL and stays on the Search tab', () => {
  const location = parse(
    `tab=search&q=lumbar+MRI&searchMode=keyword&searchCase=${caseId}&searchArchive=all&searchPage=2`,
  );
  assert.equal(location.tab, WorkspaceTab.Search);
  assert.equal(location.query, 'lumbar MRI');
  assert.equal(location.searchMode, SearchMode.Keyword);
  assert.equal(location.searchCase, caseId);
  assert.equal(location.searchArchive, CaseArchiveFilter.All);
  assert.equal(location.searchPage, 2);
  assert.deepEqual(parse(workspaceHref(location).slice(2)), location);

  // Search parameters are ignored outside the Search tab, and invalid values fall back.
  const elsewhere = parse('tab=cases&q=lumbar&searchMode=keyword&searchPage=3');
  assert.equal(elsewhere.query, '');
  assert.equal(elsewhere.searchMode, SearchMode.Hybrid);
  assert.equal(elsewhere.searchPage, 1);
  const invalid = parse(`tab=search&q=${'x'.repeat(500)}&searchCase=nope&searchMode=bad`);
  assert.equal(invalid.query.length, 200);
  assert.equal(invalid.searchCase, null);
  assert.equal(invalid.searchMode, SearchMode.Hybrid);
});

test('case document search and drawer links round-trip only within a case', () => {
  const location = parse(
    `tab=cases&case=${caseId}&section=documents&documentQuery=therapy&documentQueryPage=2&document=${documentId}`,
  );
  assert.equal(location.section, CaseSection.Documents);
  assert.equal(location.documentQuery, 'therapy');
  assert.equal(location.documentQueryPage, 2);
  assert.equal(location.document, documentId);
  assert.deepEqual(parse(workspaceHref(location).slice(2)), location);
  const listing = parse(`tab=cases&documentQuery=therapy&document=${documentId}`);
  assert.equal(listing.documentQuery, '');
  assert.equal(listing.document, null);
  assert.equal(parse(`tab=cases&case=${caseId}&document=not-an-id`).document, null);
});

test('navigation preloads search only for searchable queries', () => {
  assert.deepEqual(locationResources(parse('tab=search'), Role.Staff), []);
  assert.deepEqual(locationResources(parse('tab=search&q=a'), Role.Staff), []);
  assert.deepEqual(
    locationResources(parse('tab=search&q=lumbar'), Role.Staff).map((resource) => resource.path),
    ['/search?q=lumbar&mode=hybrid&page=1'],
  );
  const scoped = locationResources(
    parse(`tab=cases&case=${caseId}&section=documents&documentQuery=therapy`),
    Role.Admin,
  ).map((resource) => resource.path);
  assert.ok(scoped.includes(`/search?q=therapy&mode=hybrid&page=1&caseId=${caseId}`));
});

test('search requests trim queries and scope archive filters', () => {
  assert.equal(isSearchable(' a '), false);
  assert.equal(isSearchable('mri'), true);
  assert.equal(
    documentSearchResource({
      query: '  disc bulge ',
      mode: SearchMode.Keyword,
      caseId: null,
      archive: CaseArchiveFilter.Archived,
      page: 3,
    }).path,
    '/search?q=disc+bulge&mode=keyword&page=3&archive=archived',
  );
  // A specific case is searched regardless of the archive filter.
  assert.equal(
    documentSearchResource({
      query: 'mri',
      mode: SearchMode.Hybrid,
      caseId,
      archive: CaseArchiveFilter.Archived,
      page: 1,
    }).path,
    `/search?q=mri&mode=hybrid&page=1&caseId=${caseId}`,
  );
});

test('highlight segments tolerate unordered, overlapping and out-of-range ranges', () => {
  assert.deepEqual(highlightSegments('MRI of the lumbar spine', [{ start: 11, end: 17 }]), [
    { text: 'MRI of the ', highlighted: false },
    { text: 'lumbar', highlighted: true },
    { text: ' spine', highlighted: false },
  ]);
  assert.deepEqual(
    highlightSegments('abcdef', [
      { start: 4, end: 99 },
      { start: 0, end: 2 },
      { start: 1, end: 3 },
      { start: 3, end: 3 },
    ]),
    [
      { text: 'ab', highlighted: true },
      { text: 'c', highlighted: true },
      { text: 'd', highlighted: false },
      { text: 'ef', highlighted: true },
    ],
  );
  assert.deepEqual(highlightSegments('plain', []), [{ text: 'plain', highlighted: false }]);
});

test('removing or restoring a document refreshes search results', async () => {
  for (const action of ['remove', 'restore']) {
    const client = createResourceClient();
    try {
      const keys = ['/search?q=mri&mode=hybrid&page=1', '/cases?page=1'];
      keys.forEach((key) => client.setQueryData([key], {}));
      const request = withResourceInvalidation(client, async (_path, parser) => parser.parse({}));
      await request(
        `/cases/${caseId}/documents/${documentId}/${action}`,
        { parse: () => ({}) },
        {
          method: 'POST',
        },
      );
      assert.deepEqual(
        keys.map((key) => client.getQueryState([key])?.isInvalidated),
        [true, false],
        action,
      );
    } finally {
      client.clear();
    }
  }
});
