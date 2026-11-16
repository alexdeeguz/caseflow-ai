import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FactCategory,
  Role,
  approvedCaseFactSchema,
  caseTimelineQuerySchema,
  caseReviewedSummaryQuerySchema,
} from '@caseflow/schemas';
import { isPageNavigation, parseWorkspaceLocation, workspaceHref } from '../lib/workspace-location';
import { CaseMode, CaseSection, CaseView, WorkspaceTab } from '../lib/constants/navigation';
import { locationResources } from '../components/workspace/navigation';
import {
  CARE_GAP_DAYS,
  EventKind,
  buildChronology,
  eventDescription,
  eventKind,
  findingSections,
  formatDayOffset,
  formatFactDate,
  groupMatchingFacts,
  groupTimelineByYear,
  readableQuote,
  treatmentSections,
} from '../lib/case-history/presentation';
import { caseSummaryResources, caseTimelineResource } from '../lib/case-history/resources';
import { createResourceClient, withResourceInvalidation } from '../lib/resources';
import { documentLibraryState } from '../lib/processing/resources';
import { ApiError } from '../lib/api';
import { downloadDocument } from '../lib/documents/download';

const caseId = '10000000-0000-4000-8000-000000000001';

test('history URLs round-trip the timeline page without losing document/list context', () => {
  for (const section of [CaseSection.Timeline, CaseSection.ReviewedSummary]) {
    const location = parseWorkspaceLocation(
      new URLSearchParams(
        `case=${caseId}&section=${section}&timelinePage=2&documentPage=4&documentFilter=removed&archive=all&search=A%26B&page=5`,
      ),
    );
    assert.equal(location.section, section);
    assert.equal(location.timelinePage, 2);
    assert.deepEqual(
      parseWorkspaceLocation(new URL(workspaceHref(location), 'http://localhost').searchParams),
      location,
    );
    const resources = locationResources(location, Role.Staff);
    const summary = caseSummaryResources(caseId);
    assert.deepEqual(
      resources.slice(1).map((resource) => resource.path),
      section === CaseSection.Timeline
        ? [caseTimelineResource(caseId, 2).path]
        : [summary.dates.path, ...summary.categories.map((resource) => resource.path)],
    );
    assert.equal(locationResources({ ...location, mode: 'edit' }, Role.Admin).length, 1);
  }
  // The summary reuses the timeline's first page for key dates, so both share one cached request.
  assert.equal(caseSummaryResources(caseId).dates.path, caseTimelineResource(caseId).path);
  assert.deepEqual(
    caseSummaryResources(caseId).categories.map((resource) =>
      new URL(resource.path, 'http://localhost').searchParams.get('category'),
    ),
    [FactCategory.Finding, FactCategory.Treatment, FactCategory.Provider],
  );
  for (const page of ['0', '-1', '1.5', 'NaN', 'Infinity', '100001']) {
    const location = parseWorkspaceLocation(
      new URLSearchParams(`case=${caseId}&timelinePage=${page}`),
    );
    assert.equal(location.timelinePage, 1);
  }
  for (const prefix of ['case=new', 'case=bad', `tab=profile&case=${caseId}`]) {
    const location = parseWorkspaceLocation(
      new URLSearchParams(`${prefix}&section=timeline&timelinePage=3`),
    );
    assert.equal(location.section, CaseSection.Overview);
    assert.equal(location.timelinePage, 1);
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

test('review decisions and document visibility changes refresh only the affected case history and document list', async () => {
  const paths = [
    '/cases/c/timeline?page=1',
    '/cases/c/reviewed-summary?category=date&page=1',
    '/cases/c/reviewed-summary?category=provider&page=2',
    '/cases/c/documents?page=1&filter=current',
    '/cases/other/timeline?page=1',
    '/cases/other/reviewed-summary?category=date&page=1',
    '/cases/other/documents?page=1&filter=current',
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
        [true, true, true, true, false, false, false],
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

test('timeline groups consecutive entries by year without reordering them', () => {
  const entries = [
    { id: 'a', dateValue: '2024' },
    { id: 'b', dateValue: '2024-03' },
    { id: 'c', dateValue: '2025-01-09' },
    { id: 'd', dateValue: null },
  ];
  assert.deepEqual(
    groupTimelineByYear(entries).map(({ year, items }) => [year, items.map((item) => item.id)]),
    [
      ['2024', ['a', 'b']],
      ['2025', ['c']],
      ['Undated', ['d']],
    ],
  );
  assert.deepEqual(groupTimelineByYear([]), []);
});

test('only tab, case or editor changes count as page navigation', () => {
  const base = parseWorkspaceLocation(new URLSearchParams(`tab=cases&case=${caseId}`));
  assert.equal(isPageNavigation(base, { ...base, section: CaseSection.Timeline }), false);
  assert.equal(isPageNavigation(base, { ...base, documentPage: 2 }), false);
  assert.equal(isPageNavigation(base, { ...base, case: null }), true);
  assert.equal(isPageNavigation(base, { ...base, mode: CaseMode.Edit }), true);
  assert.equal(isPageNavigation(base, { ...base, tab: WorkspaceTab.Profile }), true);
  // The create-case modal opens over the case list without a page change.
  const list = parseWorkspaceLocation(new URLSearchParams('tab=cases&search=avery'));
  assert.equal(isPageNavigation(list, { ...list, case: CaseView.New }), false);
  assert.equal(isPageNavigation({ ...list, case: CaseView.New }, list), false);
  assert.equal(isPageNavigation({ ...list, case: CaseView.New }, { ...list, case: caseId }), true);
});

const dated = (
  dateValue: string,
  dateMeaning: string,
  quote = dateValue,
  qualifier: string | null = null,
) => ({
  dateValue,
  datePrecision: (dateValue.length === 10 ? 'day' : dateValue.length === 7 ? 'month' : 'year') as
    'day' | 'month' | 'year',
  dateMeaning,
  qualifier,
  evidence: [{ quote }],
});

test('dates are classified as incident, care, or record from their meaning', () => {
  assert.equal(eventKind(dated('2025-02-03', 'incident date')), EventKind.Incident);
  assert.equal(
    eventKind(dated('2025-02-03', 'date', '', 'reported collision')),
    EventKind.Incident,
  );
  assert.equal(eventKind(dated('2025-02-20', 'service date')), EventKind.Care);
  assert.equal(eventKind(dated('2025-02-20', 'follow-up appointment')), EventKind.Care);
  assert.equal(eventKind(dated('2025-04-19', 'statement date')), EventKind.Record);
});

test('event descriptions keep the record wording but drop lines that only repeat the date', () => {
  assert.equal(
    eventDescription(dated('2025-02-20', 'service date', '02/20/2025\nRehabilitation visit')),
    'Rehabilitation visit',
  );
  assert.equal(
    eventDescription(dated('2025-04-19', 'statement date', 'STATEMENT DATE\n04/19/2025')),
    null,
  );
  assert.equal(
    eventDescription(
      dated('2025-02-03', 'incident date', 'Pain after the reported incident on 02/03/2025.'),
    ),
    'Pain after the reported incident on 02/03/2025.',
  );
  assert.equal(
    eventDescription(dated('2025-03-01', 'visit', 'March 1, 2025\nIntake exam')),
    'Intake exam',
  );
  assert.equal(
    readableQuote('Impression\n  No acute   abnormality.'),
    'Impression — No acute abnormality.',
  );
});

test('chronology merges same-day facts and measures intervals and care gaps from exact dates', () => {
  const { entries, insights } = buildChronology([
    dated('2025-01', 'billing period'),
    dated('2025-02-03', 'incident date'),
    dated('2025-02-20', 'service date'),
    dated('2025-02-20', 'statement date'),
    dated('2025-03-18', 'service date'),
    dated('2025-05-02', 'therapy visit'),
  ]);

  assert.deepEqual(
    entries.map((entry) => [entry.dateValue, entry.kind, entry.facts.length]),
    [
      ['2025-01', EventKind.Record, 1],
      ['2025-02-03', EventKind.Incident, 1],
      ['2025-02-20', EventKind.Care, 2],
      ['2025-03-18', EventKind.Care, 1],
      ['2025-05-02', EventKind.Care, 1],
    ],
  );
  assert.deepEqual(
    entries.map((entry) => [entry.dayOffset, entry.sincePrevious, entry.careGap]),
    [
      [null, null, null],
      [0, null, null],
      [17, 17, null],
      [43, 26, null],
      [88, 45, 45],
    ],
  );
  assert.ok(45 >= CARE_GAP_DAYS);
  assert.equal(insights.incident?.dateValue, '2025-02-03');
  assert.equal(insights.daysToFirstCare, 17);
  assert.equal(insights.careDates, 3);
  assert.equal(insights.careSpan, 71);
  assert.equal(insights.longestCareGap?.days, 45);
  assert.equal(insights.longestCareGap?.from.dateValue, '2025-03-18');
  assert.equal(formatDayOffset(-3), '3 days before');
  assert.equal(formatDayOffset(1), 'Day 1');

  const none = buildChronology([dated('2025-04-19', 'statement date')]).insights;
  assert.equal(none.incident, null);
  assert.equal(none.daysToFirstCare, null);
  assert.equal(none.longestCareGap, null);
});

test('summary groups merge corroborating statements and keep negatives apart', () => {
  const fact = (
    value: string,
    documentId: string,
    extra: Partial<{
      negated: boolean;
      findingStatus: 'confirmed' | 'suspected' | 'unspecified' | null;
      treatmentStatus: 'performed' | 'recommended' | 'unspecified' | null;
      qualifier: string | null;
    }> = {},
  ) => ({
    value,
    documentId,
    qualifier: null,
    negated: false,
    findingStatus: null,
    treatmentStatus: null,
    ...extra,
  });
  const groups = groupMatchingFacts([
    fact('acute osseous abnormality', 'a', {
      negated: true,
      findingStatus: 'confirmed',
      qualifier: 'right shoulder',
    }),
    fact('Acute osseous abnormality.', 'b', { negated: true, findingStatus: 'confirmed' }),
    fact('acute osseous abnormality', 'c', { findingStatus: 'confirmed' }),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.value, group.facts.length, group.documentCount, group.qualifiers]),
    [
      ['Acute osseous abnormality', 2, 2, ['right shoulder']],
      ['Acute osseous abnormality', 1, 1, []],
    ],
  );
  assert.deepEqual(
    findingSections([
      fact('lumbar strain', 'a', { findingStatus: 'confirmed' }),
      fact('disc bulge', 'a', { findingStatus: 'suspected' }),
      fact('fracture', 'a', { findingStatus: 'confirmed', negated: true }),
    ]).map((section) => [section.id, section.groups.map((group) => group.value)]),
    [
      ['confirmed', ['Lumbar strain']],
      ['suspected', ['Disc bulge']],
      ['negative', ['Fracture']],
    ],
  );
  assert.deepEqual(
    treatmentSections([
      fact('physical therapy', 'a', { treatmentStatus: 'performed' }),
      fact('MRI', 'a', { treatmentStatus: 'recommended' }),
    ]).map((section) => section.id),
    ['performed', 'recommended'],
  );
});
