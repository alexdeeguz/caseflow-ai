import styles from './spinner.module.css';

/** Themed loading spinner. Decorative: pair it with visible or sr-only status text. */
export function Spinner({ size = 20 }: { size?: number }) {
  return (
    <svg
      className={styles.spinner}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle className={styles.track} cx="12" cy="12" r="9" strokeWidth="3" />
      <path className={styles.arc} d="M21 12a9 9 0 0 0-9-9" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Spinner with a label, announced politely to assistive tech. */
export function LoadingIndicator({
  label = 'Loading…',
  size = 'md',
}: {
  label?: string;
  /** `md` sits inline in a panel; `lg` centers in an empty area. */
  size?: 'md' | 'lg';
}) {
  return (
    <div className={`${styles.indicator} ${size === 'lg' ? styles.large : ''}`} role="status">
      <Spinner size={size === 'lg' ? 28 : 18} />
      <span>{label}</span>
    </div>
  );
}
