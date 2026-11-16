import { useId } from 'react';
import type { ApprovedCaseFact } from '@caseflow/schemas';
import {
  buildChronology,
  eventDescription,
  eventKind,
  eventKindLabels,
  formatDayOffset,
  formatDays,
  formatShortFactDate,
  groupTimelineByYear,
  sentenceCase,
  type ChronologyEntry,
} from '../../../lib/case-history/presentation';
import { FactSources, type SourceDownloads } from './fact-sources';
import { KeyDates } from './key-dates';
import styles from './case-history.module.css';

/** Chronology of approved dates: what happened, when, how far apart, and where it is recorded. */
export function CaseTimeline({
  items,
  partial,
  downloads,
}: {
  items: ApprovedCaseFact[];
  partial: boolean;
  downloads: SourceDownloads;
}) {
  const id = useId();
  const { entries, insights } = buildChronology(items);

  return (
    <div className={styles.history}>
      <KeyDates insights={insights} partial={partial} />
      <div className={styles.timeline}>
        {groupTimelineByYear(entries).map((group, index) => (
          <section key={`${group.year}-${index}`} aria-labelledby={`${id}-year-${index}`}>
            <h3 id={`${id}-year-${index}`} className={styles.year}>
              {group.year}
            </h3>
            <ol className={styles.entries} aria-label={`Dates in ${group.year}`}>
              {group.items.map((entry) => (
                <TimelineEntry key={entry.key} entry={entry} downloads={downloads} />
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

function TimelineEntry({
  entry,
  downloads,
}: {
  entry: ChronologyEntry<ApprovedCaseFact>;
  downloads: SourceDownloads;
}) {
  const date = formatShortFactDate(entry);

  return (
    <li className={styles.entry} data-kind={entry.kind}>
      {entry.careGap !== null ? (
        <p className={styles.interval} data-gap="true">
          {formatDays(entry.careGap)} without a recorded care date
        </p>
      ) : (
        !!entry.sincePrevious && (
          <p className={styles.interval}>{formatDays(entry.sincePrevious)} later</p>
        )
      )}
      <div className={styles.when}>
        <span className={styles.whenDate}>{date.primary}</span>
        {date.secondary && <span className={styles.whenNote}>{date.secondary}</span>}
        {entry.dayOffset !== null && (
          <span className={styles.offset}>{formatDayOffset(entry.dayOffset)}</span>
        )}
      </div>
      <div className={styles.events}>
        {entry.facts.map((fact) => (
          <TimelineEvent key={fact.id} fact={fact} downloads={downloads} />
        ))}
      </div>
    </li>
  );
}

function TimelineEvent({
  fact,
  downloads,
}: {
  fact: ApprovedCaseFact;
  downloads: SourceDownloads;
}) {
  const kind = eventKind(fact);
  const description = eventDescription(fact);
  const meaning = sentenceCase(fact.dateMeaning ?? 'Date');

  return (
    <article className={styles.event}>
      <p className={styles.eventMeta}>
        <span className={styles.kind} data-kind={kind}>
          {eventKindLabels[kind]}
        </span>
        {description && <span>{meaning}</span>}
        {fact.qualifier && <span className={styles.qualifier}>{fact.qualifier}</span>}
        {fact.negated && <span className={styles.negated}>Stated as not occurring</span>}
      </p>
      <h4 className={styles.eventTitle}>{description ?? meaning}</h4>
      <FactSources facts={[fact]} downloads={downloads} />
    </article>
  );
}
