import type { ReactNode } from 'react';
import styles from './document-inspector.module.css';

/** Expanded document view: reference info in a side rail, primary content in the main column. */
export function DocumentInspector({ aside, children }: { aside: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.inspector}>
      <div className={styles.aside}>{aside}</div>
      <div className={styles.content}>{children}</div>
    </div>
  );
}
