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

  const tags = [showDate ? values.dateValue : null, ...qualifiers].filter(Boolean);

  return (
    <div className={styles.values}>
      <span className={styles.category}>{factCategoryLabels[values.category]}</span>
      <p className={styles.value}>{values.value}</p>
      {!!tags.length && (
        <ul className={styles.tags} aria-label="Fact details">
          {tags.map((tag, index) => (
            <li key={`${tag}-${index}`}>{tag}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
