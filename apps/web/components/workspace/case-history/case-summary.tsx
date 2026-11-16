import type { ApprovedCaseFact } from '@caseflow/schemas';
import {
  buildChronology,
  findingSections,
  providerSections,
  readableQuote,
  treatmentSections,
  type FactGroup,
  type SummarySection,
} from '../../../lib/case-history/presentation';
import type { ReviewTotals } from '../../../lib/documents/state';
import { ArrowRightIcon } from '../documents/document-icons';
import { FactSources, type SourceDownloads } from './fact-sources';
import { KeyDates } from './key-dates';
import styles from './case-history.module.css';

export interface SummaryCategoryData {
  items: ApprovedCaseFact[];
  total: number;
}

/**
 * Case brief from approved facts: key dates, findings by certainty, treatment received versus
 * recommended, and providers. Matching statements from different documents are merged.
 */
export function CaseSummary({
  dates,
  findings,
  treatments,
  providers,
  review,
  downloads,
  onReview,
  onTimeline,
}: {
  dates: SummaryCategoryData;
  findings: SummaryCategoryData;
  treatments: SummaryCategoryData;
  providers: SummaryCategoryData;
  review: ReviewTotals | null;
  downloads: SourceDownloads;
  onReview: () => void;
  onTimeline: () => void;
}) {
  const { insights } = buildChronology(dates.items);

  return (
    <div className={styles.history}>
      {review && review.unreviewed > 0 && (
        <div className={styles.pending} role="note">
          <p>
            <strong>
              {review.unreviewed}
              {review.partial ? '+' : ''} extracted{' '}
              {review.unreviewed === 1 ? 'fact is' : 'facts are'} waiting for review
            </strong>{' '}
            and not included below until approved.
          </p>
          <button type="button" className={styles.linkButton} onClick={onReview}>
            Review in Documents <ArrowRightIcon />
          </button>
        </div>
      )}
      <KeyDates
        insights={insights}
        partial={dates.total > dates.items.length}
        action={
          <button type="button" className={styles.linkButton} onClick={onTimeline}>
            Full timeline <ArrowRightIcon />
          </button>
        }
      />
      <div className={styles.summaryGrid}>
        <SummaryPanel
          className={styles.findingsPanel}
          title="Findings"
          description="Injuries, diagnoses, and observations"
          empty="No approved findings yet."
          data={findings}
          sections={findingSections(findings.items)}
          downloads={downloads}
        />
        <SummaryPanel
          title="Treatment"
          description="Care received and recommended"
          empty="No approved treatment yet."
          data={treatments}
          sections={treatmentSections(treatments.items)}
          downloads={downloads}
        />
        <SummaryPanel
          title="Providers"
          description="Facilities and clinicians in the records"
          empty="No approved providers yet."
          data={providers}
          sections={providerSections(providers.items)}
          downloads={downloads}
        />
      </div>
    </div>
  );
}

function SummaryPanel({
  title,
  description,
  empty,
  data,
  sections,
  downloads,
  className = '',
}: {
  title: string;
  description: string;
  empty: string;
  data: SummaryCategoryData;
  sections: SummarySection<ApprovedCaseFact>[];
  downloads: SourceDownloads;
  className?: string;
}) {
  return (
    <section className={`${styles.panel} ${className}`} aria-label={title}>
      <header className={styles.panelHeader}>
        <h3>
          {title} <span className={styles.panelCount}>{data.total}</span>
        </h3>
        <p>{description}</p>
      </header>
      {!sections.length ? (
        <p className={styles.panelEmpty}>{empty}</p>
      ) : (
        sections.map((section) => (
          <div key={section.id} className={styles.group} data-section={section.id}>
            <h4 className={styles.groupLabel}>
              {section.label}
              {section.hint && <span>{section.hint}</span>}
            </h4>
            <ul className={styles.items}>
              {section.groups.map((group) => (
                <SummaryItem key={group.key} group={group} downloads={downloads} />
              ))}
            </ul>
          </div>
        ))
      )}
      {data.total > data.items.length && (
        <p className={styles.panelNote}>
          Showing {data.items.length} of {data.total}.
        </p>
      )}
    </section>
  );
}

function SummaryItem({
  group,
  downloads,
}: {
  group: FactGroup<ApprovedCaseFact>;
  downloads: SourceDownloads;
}) {
  const quote = group.facts[0]?.evidence[0]?.quote;

  return (
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <p className={styles.itemValue}>{group.value}</p>
        {group.documentCount > 1 && (
          <span className={styles.corroborated}>In {group.documentCount} documents</span>
        )}
      </div>
      {!!group.qualifiers.length && (
        <p className={styles.itemQualifier}>{group.qualifiers.join(' · ')}</p>
      )}
      {quote && <blockquote className={styles.itemQuote}>{readableQuote(quote)}</blockquote>}
      <FactSources facts={group.facts} downloads={downloads} />
    </li>
  );
}
