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
