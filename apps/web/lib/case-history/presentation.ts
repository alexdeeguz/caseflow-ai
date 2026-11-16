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
