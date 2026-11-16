import { factCategoryLabels, type FactValues } from '@caseflow/schemas';
import styles from './review.module.css';

export function FactValuesDisplay({ values }: { values: FactValues }) {
  const qualifiers = [
    values.negated ? 'Negated' : null,
    values.dateMeaning,
    values.datePrecision,
    values.treatmentStatus,
    values.findingStatus,
    values.qualifier,
  ].filter(Boolean);

  return (
    <div className={styles.values}>
      <span className={styles.category}>{factCategoryLabels[values.category]}</span>
      <p className={styles.value}>{values.value}</p>
      {values.dateValue && <p>{values.dateValue}</p>}
      {!!qualifiers.length && <p className={styles.qualifiers}>{qualifiers.join(' · ')}</p>}
    </div>
  );
}
