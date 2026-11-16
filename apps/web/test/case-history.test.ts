import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FactCategory,
  Role,
  approvedCaseFactSchema,
  caseTimelineQuerySchema,
  caseReviewedSummaryQuerySchema,
} from '@caseflow/schemas';
import { parseWorkspaceLocation, workspaceHref } from '../lib/workspace-location';
import { CaseSection } from '../lib/constants/navigation';
import { locationResources } from '../components/workspace/navigation';
import { formatFactDate } from '../lib/case-history/presentation';
import { caseTimelineResource, caseReviewedSummaryResource } from '../lib/case-history/resources';
import { createResourceClient, withResourceInvalidation } from '../lib/resources';
import { documentLibraryState } from '../lib/processing/resources';
import { ApiError } from '../lib/api';
import { downloadDocument } from '../lib/documents/download';

const caseId = '10000000-0000-4000-8000-000000000001';

test('history URLs round-trip independent pages and category without losing document/list context', () => {
  for (const section of [CaseSection.Timeline, CaseSection.ReviewedSummary]) {
    const location = parseWorkspaceLocation(
      new URLSearchParams(
        `case=${caseId}&section=${section}&timelinePage=2&summaryCategory=finding&summaryPage=3&documentPage=4&documentFilter=removed&archive=all&search=A%26B&page=5`,
      ),
    );
    assert.equal(location.section, section);
    assert.equal(location.timelinePage, 2);
    assert.equal(location.summaryPage, 3);
    assert.equal(location.summaryCategory, FactCategory.Finding);
    assert.deepEqual(
      parseWorkspaceLocation(new URL(workspaceHref(location), 'http://localhost').searchParams),
      location,
    );
    const resources = locationResources(location, Role.Staff);
    assert.equal(resources.length, 2);
    assert.equal(
      resources[1]?.path,
      section === CaseSection.Timeline
        ? caseTimelineResource(caseId, 2).path
        : caseReviewedSummaryResource(caseId, FactCategory.Finding, 3).path,
    );
    assert.equal(locationResources({ ...location, mode: 'edit' }, Role.Admin).length, 1);
  }
  for (const page of ['0', '-1', '1.5', 'NaN', 'Infinity', '100001']) {
    const location = parseWorkspaceLocation(
      new URLSearchParams(
        `case=${caseId}&timelinePage=${page}&summaryPage=${page}&summaryCategory=bad`,
      ),
    );
    assert.equal(location.timelinePage, 1);
    assert.equal(location.summaryPage, 1);
    assert.equal(location.summaryCategory, FactCategory.Date);
  }
  for (const prefix of ['case=new', 'case=bad', `tab=profile&case=${caseId}`]) {
    const location = parseWorkspaceLocation(
      new URLSearchParams(
        `${prefix}&section=timeline&timelinePage=3&summaryPage=4&summaryCategory=provider`,
      ),
    );
    assert.equal(location.section, CaseSection.Overview);
    assert.equal(location.timelinePage, 1);
    assert.equal(location.summaryPage, 1);
    assert.equal(location.summaryCategory, FactCategory.Date);
  }
});

test('partial dates remain explicit and exact dates do not shift between time zones', () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
      process.env.TZ = zone;
      assert.equal(
        formatFactDate({ dateValue: '2026', datePrecision: 'year' }),
        '2026 — month and day unspecified',
      );
      assert.equal(
        formatFactDate({ dateValue: '2026-11', datePrecision: 'month' }),
        'November 2026 — day unspecified',
      );
      assert.equal(
        formatFactDate({ dateValue: '2024-02-29', datePrecision: 'day' }),
        'February 29, 2024',
      );
      assert.equal(formatFactDate({ dateValue: null, datePrecision: null }), 'Date not specified');
    }
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
});

test('strict contracts reject forged review/query data and cross-document evidence', () => {
  assert.deepEqual(caseReviewedSummaryQuerySchema.parse({}), {
    page: 1,
    pageSize: 25,
    category: 'date',
  });
  assert.equal(caseTimelineQuerySchema.safeParse({ category: 'date' }).success, false);
  assert.equal(
    caseReviewedSummaryQuerySchema.safeParse({ reviewStatus: 'unreviewed' }).success,
    false,
  );
  const fact = {
    id: caseId,
    version: 2,
    documentId: caseId,
    filename: 'fixture.pdf',
    category: 'date',
    value: 'Documented date',
    qualifier: null,
    dateValue: '2024-02-29',
    datePrecision: 'day',
    dateMeaning: 'Visit',
    treatmentStatus: null,
    findingStatus: null,
    negated: false,
    evidence: [
      {
        id: caseId,
        documentId: caseId,
        processingResultId: caseId,
        page: 1,
        quote: '🩺 café',
        start: 10,
        end: 16,
      },
    ],
  };
  assert.equal(approvedCaseFactSchema.safeParse(fact).success, true);
  assert.equal(
    approvedCaseFactSchema.safeParse({ ...fact, dateValue: '2023-02-29' }).success,
    false,
  );
  assert.equal(
    approvedCaseFactSchema.safeParse({ ...fact, reason: 'Private review reason' }).success,
    false,
  );
  assert.equal(
    approvedCaseFactSchema.safeParse({
      ...fact,
      evidence: [{ ...fact.evidence[0], documentId: '20000000-0000-4000-8000-000000000002' }],
    }).success,
    false,
  );
});

test('all review decisions and document visibility changes invalidate only the affected case history', async () => {
  const paths = [
    '/cases/c/timeline?page=1',
    '/cases/c/reviewed-summary?category=date&page=1',
    '/cases/c/reviewed-summary?category=provider&page=2',
    '/cases/other/timeline?page=1',
    '/cases/other/reviewed-summary?category=date&page=1',
  ];
  const mutations = [
    ['/cases/c/documents/d/facts/f', 'PATCH'],
    ...['approve', 'reject', 'reopen'].map((action) => [
      `/cases/c/documents/d/facts/f/${action}`,
      'POST',
    ]),
    ...['remove', 'restore'].map((action) => [`/cases/c/documents/d/${action}`, 'POST']),
  ];
  for (const [path, method] of mutations) {
    const client = createResourceClient();
    try {
      paths.forEach((key) => client.setQueryData([key], {}));
      const request = withResourceInvalidation(client, async (_path, parser) => parser.parse({}));
      await request(path!, { parse: () => ({}) }, { method });
      assert.deepEqual(
        paths.map((key) => client.getQueryState([key])?.isInvalidated),
        [true, true, true, false, false],
        path,
      );
    } finally {
      client.clear();
    }
  }
});

test('transient failures retain data while authorization rejection clears it', () => {
  const data = { items: [], total: 0 };
  assert.equal(
    documentLibraryState({ data, error: new ApiError(503, 'SERVICE_UNAVAILABLE', 'Unavailable') })
      .stale,
    true,
  );
  for (const code of [401, 403, 404]) {
    const state = documentLibraryState({
      data,
      error: new ApiError(code, 'FORBIDDEN', 'No access'),
    });
    assert.equal(state.data, null);
    assert.equal(state.denied, true);
  }
});

test('shared downloads reauthorize with empty JSON and never click after cancellation', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const events: string[] = [];
  const link = {
    href: '',
    download: '',
    referrerPolicy: '',
    rel: '',
    click: () => events.push('click'),
    remove: () => events.push('remove'),
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => link, body: { append: () => events.push('append') } },
  });
  try {
    const controller = new AbortController();
    const target = { caseId, id: caseId, filename: 'Fictional café.pdf' };
    await downloadDocument(
      async (path, parser, options) => {
        assert.equal(path, `/cases/${caseId}/documents/${caseId}/download`);
        assert.equal(options?.method, 'POST');
        assert.equal(options?.body, '{}');
        return parser.parse({
          method: 'GET',
          url: 'https://example.com/fictional',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        });
      },
      target,
      controller.signal,
    );
    assert.deepEqual(events, ['append', 'click', 'remove']);
    assert.equal(link.download, target.filename);
    assert.equal(link.referrerPolicy, 'no-referrer');
    controller.abort();
    await assert.rejects(
      downloadDocument(
        async (_path, parser) =>
          parser.parse({
            method: 'GET',
            url: 'https://example.com/fictional',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          }),
        target,
        controller.signal,
      ),
    );
    assert.equal(events.filter((event) => event === 'click').length, 1);
  } finally {
    if (original) {
      Object.defineProperty(globalThis, 'document', original);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
  }
});
