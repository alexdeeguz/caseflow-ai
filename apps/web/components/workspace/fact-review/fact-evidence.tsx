import type { ExtractedFact } from '@caseflow/schemas';
import styles from './review.module.css';

export function FactEvidence({ evidence }: { evidence: ExtractedFact['evidence'] }) {
  return evidence.map((source) => (
    <figure key={source.id} className={styles.evidence}>
      <figcaption>Source · Page {source.page}</figcaption>
      <blockquote>{source.quote}</blockquote>
    </figure>
  ));
}
