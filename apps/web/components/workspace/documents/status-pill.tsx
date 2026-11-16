import type { ReactNode } from 'react';
import type { StatusTone } from '../../../lib/documents/presentation';
import styles from './status-pill.module.css';

/** One pill style for availability, processing and fact-extraction states. */
export function StatusPill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className={`${styles.pill} ${styles[tone]}`}>
      <span className={styles.dot} aria-hidden="true" />
      {children}
    </span>
  );
}
