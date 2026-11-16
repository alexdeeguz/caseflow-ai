import type { ExtractedFact } from '@caseflow/schemas';
import styles from './review.module.css';

export function FactEvidence({ evidence }: { evidence: ExtractedFact['evidence'] }) {
  return evidence.map((source) => (
    <figure key={source.id} className={styles.evidence}>
      <figcaption>
        Source <span className={styles.page}>Page {source.page}</span>
      </figcaption>
      <blockquote>{source.quote}</blockquote>
    </figure>
  ));
}
