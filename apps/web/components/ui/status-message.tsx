import type { ReactNode } from 'react';
import styles from './controls.module.css';

export function StatusMessage({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'success' | 'error';
  children: ReactNode;
}) {
  return (
    <div
      className={`${styles.status} ${tone === 'info' ? '' : styles[tone]}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}
