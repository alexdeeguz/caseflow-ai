import type { ReactNode } from 'react';
import { AlertIcon, InfoIcon } from './icon';
import styles from './panel.module.css';

/** Bordered white card with a small heading row; the building block for side rails. */
export function Panel({
  title,
  label,
  badge,
  className = '',
  children,
}: {
  title: string;
  label?: string;
  badge?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`${styles.panel} ${className}`} aria-label={label ?? title}>
      <div className={styles.head}>
        <h3>{title}</h3>
        {badge}
      </div>
      {children}
    </section>
  );
}

export interface DetailItem {
  label: string;
  value: ReactNode;
  /** Long values (e.g. filenames) render below their label. */
  stacked?: boolean;
}

/** Label/value rows separated by hairlines. */
export function DetailList({ items }: { items: DetailItem[] }) {
  return (
    <dl className={styles.rows}>
      {items.map((item) => (
        <div key={item.label} className={item.stacked ? styles.stacked : undefined}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Inline note with an icon; `danger` for failures, `info` for guidance. */
export function Callout({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'danger';
  children: ReactNode;
}) {
  return (
    <div className={`${styles.callout} ${tone === 'danger' ? styles.danger : ''}`}>
      {tone === 'danger' ? <AlertIcon /> : <InfoIcon />}
      <p>{children}</p>
    </div>
  );
}
