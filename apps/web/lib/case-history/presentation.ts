import type { FactValues } from '@caseflow/schemas';

const monthFormatter = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' });
const dayFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

export function formatFactDate(fact: Pick<FactValues, 'dateValue' | 'datePrecision'>): string {
  const { dateValue, datePrecision } = fact;
  if (!dateValue || !datePrecision) {
    return 'Date not specified';
  }
  if (datePrecision === 'year') {
    return `${dateValue} — month and day unspecified`;
  }

  const calendar = new Date(`${dateValue.length === 7 ? `${dateValue}-01` : dateValue}T00:00:00Z`);
  if (datePrecision === 'month') {
    return `${monthFormatter.format(calendar)} ${dateValue.slice(0, 4)} — day unspecified`;
  }
  return dayFormatter.format(calendar);
}

export interface TimelineGroup<T> {
  year: string;
  items: T[];
}

/** Groups consecutive timeline entries by year, preserving their order; undated entries are labelled. */
export function groupTimelineByYear<T extends Pick<FactValues, 'dateValue'>>(
  items: readonly T[],
): TimelineGroup<T>[] {
  const groups: TimelineGroup<T>[] = [];
  for (const item of items) {
    const year = /^\d{4}/.exec(item.dateValue ?? '')?.[0] ?? 'Undated';
    const current = groups.at(-1);
    if (current?.year === year) {
      current.items.push(item);
    } else {
      groups.push({ year, items: [item] });
    }
  }
  return groups;
}

/* ── Chronology ─────────────────────────────────────────────────────────────── */

export const EventKind = {
  Incident: 'incident',
  Care: 'care',
  Record: 'record',
} as const;
export type EventKind = (typeof EventKind)[keyof typeof EventKind];

export const eventKindLabels: Readonly<Record<EventKind, string>> = {
  [EventKind.Incident]: 'Incident',
  [EventKind.Care]: 'Care',
  [EventKind.Record]: 'Record',
};

/** Days without a recorded care date after which the timeline flags a gap. */
export const CARE_GAP_DAYS = 30;

const incidentWords =
  /\b(incident|accident|injur|collision|crash|fall|fell|slip|trip|bite|assault)/i;
const careWords =
  /\b(service|visit|treat|admi|discharg|surg|exam|appoint|therap|rehab|imaging|x-?ray|mri|ct\b|scan|evaluat|consult|procedure|encounter|follow|inject|emergency|er\b|session|operat|clinic)/i;

type DateFact = Pick<FactValues, 'dateValue' | 'datePrecision' | 'dateMeaning' | 'qualifier'>;
type QuotedFact = { evidence: readonly { quote: string }[] };

/** Classifies a date by what it marks, so the incident and care stand out from paperwork dates. */
export function eventKind(fact: DateFact): EventKind {
  const text = `${fact.dateMeaning ?? ''} ${fact.qualifier ?? ''}`;
  if (incidentWords.test(text)) {
    return EventKind.Incident;
  }
  return careWords.test(text) ? EventKind.Care : EventKind.Record;
}

/** Capitalizes the first letter only, keeping the rest of the source wording. */
export function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const monthNames = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';
const dateOnlyLine = new RegExp(
  `^(?:[\\d\\s/.,:-]+|(?:${monthNames})[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{2,4}|\\d{1,2}\\s+(?:${monthNames})[a-z]*\\.?\\s+\\d{2,4})$`,
  'i',
);
const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Source quotation on one line: line breaks from the document become separators. */
export function readableQuote(quote: string): string {
  return quote
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' — ');
}

/**
 * What happened on a date, in the record's own words: the quotation without lines that only
 * repeat the date or its label (e.g. "02/20/2025" / "STATEMENT DATE"). Null when nothing is left.
 */
export function eventDescription(fact: DateFact & QuotedFact): string | null {
  const meaning = normalize(fact.dateMeaning ?? '');
  const lines = (fact.evidence[0]?.quote ?? '')
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !dateOnlyLine.test(line) && normalize(line) !== meaning);
  return lines.length ? lines.join(' — ') : null;
}

/** Calendar day number for a full date; null for partial dates, which have no exact interval. */
export function dayNumber(fact: Pick<FactValues, 'dateValue' | 'datePrecision'>): number | null {
  if (fact.datePrecision !== 'day' || !fact.dateValue) {
    return null;
  }
  const [year, month, day] = fact.dateValue.split('-').map(Number);
  return Date.UTC(year!, month! - 1, day!) / 86_400_000;
}

export interface ChronologyEntry<T> {
  key: string;
  dateValue: string | null;
  datePrecision: FactValues['datePrecision'];
  kind: EventKind;
  facts: T[];
  /** Days after (positive) or before (negative) the incident, when both dates are exact. */
  dayOffset: number | null;
  /** Days since the previous dated entry, when both dates are exact. */
  sincePrevious: number | null;
  /** Set on a care entry that follows the previous care date by at least CARE_GAP_DAYS. */
  careGap: number | null;
}

export interface ChronologyInsights<T> {
  incident: ChronologyEntry<T> | null;
  firstCare: ChronologyEntry<T> | null;
  lastCare: ChronologyEntry<T> | null;
  careDates: number;
  /** Days from the incident to the first care date. */
  daysToFirstCare: number | null;
  /** Days from the first to the latest care date. */
  careSpan: number | null;
  longestCareGap: { days: number; from: ChronologyEntry<T>; to: ChronologyEntry<T> } | null;
}

const kindRank: Record<EventKind, number> = { incident: 0, care: 1, record: 2 };

/**
 * Turns ordered date facts into one entry per date with intervals: days from the incident, days
 * since the previous entry, and gaps between care dates. Only exact dates produce intervals.
 */
export function buildChronology<T extends DateFact & QuotedFact>(
  items: readonly T[],
): { entries: ChronologyEntry<T>[]; insights: ChronologyInsights<T> } {
  const entries: ChronologyEntry<T>[] = [];
  for (const fact of items) {
    const current = entries.at(-1);
    const kind = eventKind(fact);
    if (
      current &&
      current.dateValue === fact.dateValue &&
      current.datePrecision === fact.datePrecision
    ) {
      current.facts.push(fact);
      if (kindRank[kind] < kindRank[current.kind]) {
        current.kind = kind;
      }
    } else {
      entries.push({
        key: `${fact.dateValue ?? 'undated'}-${entries.length}`,
        dateValue: fact.dateValue,
        datePrecision: fact.datePrecision,
        kind,
        facts: [fact],
        dayOffset: null,
        sincePrevious: null,
        careGap: null,
      });
    }
  }

  const incident = entries.find((entry) => entry.kind === EventKind.Incident) ?? null;
  const incidentDay = incident ? dayNumber(incident) : null;
  const care = entries.filter((entry) => entry.kind === EventKind.Care);
  let previous: number | null = null;
  let previousCare: ChronologyEntry<T> | null = null;
  let longestCareGap: ChronologyInsights<T>['longestCareGap'] = null;

  for (const entry of entries) {
    const day = dayNumber(entry);
    entry.dayOffset = day !== null && incidentDay !== null ? day - incidentDay : null;
    entry.sincePrevious = day !== null && previous !== null ? day - previous : null;
    if (entry.kind === EventKind.Care) {
      const lastCareDay = previousCare ? dayNumber(previousCare) : null;
      const gap = day !== null && lastCareDay !== null ? day - lastCareDay : null;
      if (gap !== null && gap >= CARE_GAP_DAYS) {
        entry.careGap = gap;
      }
      if (gap !== null && previousCare && (!longestCareGap || gap > longestCareGap.days)) {
        longestCareGap = { days: gap, from: previousCare, to: entry };
      }
      previousCare = entry;
    }
    previous = day ?? previous;
  }

  const firstCare = care[0] ?? null;
  const lastCare = care.at(-1) ?? null;
  const firstCareDay = firstCare ? dayNumber(firstCare) : null;
  const lastCareDay = lastCare ? dayNumber(lastCare) : null;

  return {
    entries,
    insights: {
      incident,
      firstCare,
      lastCare,
      careDates: care.length,
      daysToFirstCare:
        incidentDay !== null && firstCareDay !== null ? firstCareDay - incidentDay : null,
      careSpan: firstCareDay !== null && lastCareDay !== null ? lastCareDay - firstCareDay : null,
      longestCareGap,
    },
  };
}

/** "1 day", "17 days". */
export function formatDays(days: number): string {
  const count = Math.abs(days);
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'day' : 'days'}`;
}

/** Position relative to the incident: "Day 0", "Day 17", "3 days before". */
export function formatDayOffset(offset: number): string {
  return offset < 0 ? `${formatDays(offset)} before` : `Day ${offset.toLocaleString('en-US')}`;
}

const shortDayFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const shortMonthFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });

/** Compact date for the timeline column; the year is shown by the group heading. */
export function formatShortFactDate(fact: Pick<FactValues, 'dateValue' | 'datePrecision'>): {
  primary: string;
  secondary: string | null;
} {
  const { dateValue, datePrecision } = fact;
  if (!dateValue || !datePrecision) {
    return { primary: 'Undated', secondary: null };
  }
  if (datePrecision === 'year') {
    return { primary: dateValue, secondary: 'Month unspecified' };
  }
  const calendar = new Date(`${dateValue.length === 7 ? `${dateValue}-01` : dateValue}T00:00:00Z`);
  return datePrecision === 'month'
    ? { primary: shortMonthFormatter.format(calendar), secondary: 'Day unspecified' }
    : { primary: shortDayFormatter.format(calendar), secondary: null };
}

/* ── Reviewed summary ───────────────────────────────────────────────────────── */

type SummaryFact = Pick<
  FactValues,
  'value' | 'qualifier' | 'negated' | 'treatmentStatus' | 'findingStatus'
> & { documentId: string };

export interface FactGroup<T> {
  key: string;
  value: string;
  qualifiers: string[];
  facts: T[];
  documentCount: number;
}

export interface SummarySection<T> {
  id: string;
  label: string;
  hint?: string;
  groups: FactGroup<T>[];
}

/** Merges approved facts that state the same thing, so corroborating sources appear together. */
export function groupMatchingFacts<T extends SummaryFact>(items: readonly T[]): FactGroup<T>[] {
  const groups = new Map<string, FactGroup<T>>();
  for (const fact of items) {
    const key = [
      normalize(fact.value),
      fact.negated,
      fact.treatmentStatus ?? '',
      fact.findingStatus ?? '',
    ].join('|');
    const group = groups.get(key) ?? {
      key,
      value: sentenceCase(fact.value),
      qualifiers: [],
      facts: [],
      documentCount: 0,
    };
    group.facts.push(fact);
    if (fact.qualifier && !group.qualifiers.includes(fact.qualifier)) {
      group.qualifiers.push(fact.qualifier);
    }
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    documentCount: new Set(group.facts.map((fact) => fact.documentId)).size,
  }));
}

function sections<T extends SummaryFact>(
  items: readonly T[],
  definitions: { id: string; label: string; hint?: string; match: (fact: T) => boolean }[],
): SummarySection<T>[] {
  return definitions
    .map(({ match, ...section }) => ({
      ...section,
      groups: groupMatchingFacts(items.filter(match)),
    }))
    .filter((section) => section.groups.length > 0);
}

/** Findings by certainty, with explicit negatives kept apart so they are never read as present. */
export function findingSections<T extends SummaryFact>(items: readonly T[]) {
  return sections(items, [
    {
      id: 'confirmed',
      label: 'Confirmed',
      match: (f) => !f.negated && f.findingStatus === 'confirmed',
    },
    {
      id: 'suspected',
      label: 'Suspected',
      match: (f) => !f.negated && f.findingStatus === 'suspected',
    },
    {
      id: 'noted',
      label: 'Noted',
      hint: 'Certainty not stated',
      match: (f) =>
        !f.negated && f.findingStatus !== 'confirmed' && f.findingStatus !== 'suspected',
    },
    {
      id: 'negative',
      label: 'Negative findings',
      hint: 'Stated as absent',
      match: (f) => f.negated,
    },
  ]);
}

/** Treatment received versus recommended (future care), with explicit negatives kept apart. */
export function treatmentSections<T extends SummaryFact>(items: readonly T[]) {
  return sections(items, [
    {
      id: 'performed',
      label: 'Received',
      match: (f) => !f.negated && f.treatmentStatus === 'performed',
    },
    {
      id: 'recommended',
      label: 'Recommended',
      hint: 'Future care',
      match: (f) => !f.negated && f.treatmentStatus === 'recommended',
    },
    {
      id: 'mentioned',
      label: 'Mentioned',
      hint: 'Not stated as received or recommended',
      match: (f) =>
        !f.negated && f.treatmentStatus !== 'performed' && f.treatmentStatus !== 'recommended',
    },
    { id: 'negative', label: 'Not received or not recommended', match: (f) => f.negated },
  ]);
}

export function providerSections<T extends SummaryFact>(items: readonly T[]) {
  return sections(items, [
    { id: 'providers', label: 'Providers', match: (f) => !f.negated },
    { id: 'negative', label: 'Stated as not involved', match: (f) => f.negated },
  ]);
}
