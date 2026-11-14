import { useId, type ReactNode } from 'react';
import styles from './auth-panel.module.css';

export function AuthPanel({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <div className={styles.icon} aria-hidden="true">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <rect x="5" y="10" width="14" height="11" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
        </svg>
      </div>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h2 id={titleId}>{title}</h2>
      <p className={styles.description}>{description}</p>
      <div className={styles.content}>{children}</div>
      <div className={styles.footnote}>For demonstration purposes. Please use fictional data.</div>
    </section>
  );
}
