import styles from './segmented-control.module.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/** Single-choice toggle group (aria-pressed buttons) with optional per-option counts. */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  pendingValue,
  onChange,
}: {
  label: string;
  options: SegmentedOption<T>[];
  value: T;
  pendingValue?: T | null;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className={styles.group}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          aria-busy={pendingValue === option.value && value !== option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined && <span className={styles.count}>{option.count}</span>}
        </button>
      ))}
    </div>
  );
}
