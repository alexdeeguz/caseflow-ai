import { factCategoryLabels, type FactValues } from '@caseflow/schemas';
import styles from './review.module.css';

export function FactValuesDisplay({
  values,
  showDate = true,
}: {
  values: FactValues;
  showDate?: boolean;
}) {
  const qualifiers = [
    values.negated ? 'Negated' : null,
    values.dateMeaning,
    showDate ? values.datePrecision : null,
    values.treatmentStatus,
    values.findingStatus,
    values.qualifier,
  ].filter(Boolean);

  return (
    <div className={styles.values}>
      <span className={styles.category}>{factCategoryLabels[values.category]}</span>
      <p className={styles.value}>{values.value}</p>
      {showDate && values.dateValue && <p>{values.dateValue}</p>}
      {!!qualifiers.length && <p className={styles.qualifiers}>{qualifiers.join(' · ')}</p>}
    </div>
  );
}
