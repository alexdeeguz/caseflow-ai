import type { ReactNode } from 'react';
import {
  CARE_GAP_DAYS,
  formatDays,
  formatFactDate,
  type ChronologyInsights,
} from '../../../lib/case-history/presentation';
import styles from './case-history.module.css';

interface Stat {
  label: string;
  value: string;
  detail?: string;
  tone?: 'key' | 'attention' | 'muted';
}

/** At-a-glance case dates derived from approved date facts: incident, care window, and gaps. */
export function KeyDates<T>({
  insights,
  partial,
  action,
}: {
  insights: ChronologyInsights<T>;
  /** True when only the first page of dates was used. */
  partial: boolean;
  /** Optional link shown beside the explanatory note. */
  action?: ReactNode;
}) {
  const { incident, firstCare, lastCare, careDates, daysToFirstCare, careSpan, longestCareGap } =
    insights;
  const gapFlagged = !!longestCareGap && longestCareGap.days >= CARE_GAP_DAYS;
  const stats: Stat[] = [
    incident
      ? { label: 'Incident', value: formatFactDate(incident), tone: 'key' }
      : { label: 'Incident', value: 'Not in approved dates', tone: 'muted' },
    firstCare
      ? {
          label: 'First care',
          value: formatFactDate(firstCare),
          detail:
            daysToFirstCare === null
              ? undefined
              : daysToFirstCare < 0
                ? `${formatDays(daysToFirstCare)} before the incident`
                : `${formatDays(daysToFirstCare)} after the incident`,
        }
      : { label: 'First care', value: 'No approved care dates', tone: 'muted' },
    lastCare && careDates > 1
      ? {
          label: 'Latest care',
          value: formatFactDate(lastCare),
          detail: `${careDates} care dates${careSpan === null ? '' : ` over ${formatDays(careSpan)}`}`,
        }
      : {
          label: 'Latest care',
          value: careDates === 1 ? 'Only one care date' : '—',
          tone: 'muted',
        },
    longestCareGap
      ? {
          label: 'Longest gap in care',
          value: formatDays(longestCareGap.days),
          detail: `${formatFactDate(longestCareGap.from)} → ${formatFactDate(longestCareGap.to)}`,
          tone: gapFlagged ? 'attention' : undefined,
        }
      : { label: 'Longest gap in care', value: '—', tone: 'muted' },
  ];

  return (
    <section className={styles.keyDates} aria-label="Key dates">
      <dl className={styles.stats}>
        {stats.map((stat) => (
          <div key={stat.label} className={styles.stat} data-tone={stat.tone}>
            <dt>{stat.label}</dt>
            <dd>
              <span className={styles.statValue}>{stat.value}</span>
              {stat.detail && <span className={styles.statDetail}>{stat.detail}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <div className={styles.keyDatesFooter}>
        <p className={styles.keyDatesNote}>
          Calculated from approved date facts{partial ? ' on the first page of dates' : ''}. Gaps of{' '}
          {CARE_GAP_DAYS}+ days between care dates are flagged.
        </p>
        {action}
      </div>
    </section>
  );
}
