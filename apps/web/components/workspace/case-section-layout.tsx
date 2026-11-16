import type { ReactNode, Ref } from 'react';
import { LoadingRegion } from '../ui/loading-region';
import styles from './case-section-layout.module.css';

/**
 * Layout for a case tab: a fixed toolbar (summary + actions) above a body that scrolls on its own.
 * The section heading stays available to assistive tech; the tab bar already shows it visually.
 */
export function CaseSectionLayout({
  id,
  title,
  headingRef,
  summary,
  actions,
  loading = false,
  children,
}: {
  id: string;
  title: string;
  headingRef?: Ref<HTMLHeadingElement>;
  summary?: ReactNode;
  actions?: ReactNode;
  /** Shows a centered spinner over the body while the section reloads in place. */
  loading?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h2 id={id} ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="sr-only">
        {title}
      </h2>
      {(summary || actions) && (
        <div className={styles.toolbar}>
          {summary && <p className={styles.summary}>{summary}</p>}
          {actions && <div className={styles.actions}>{actions}</div>}
        </div>
      )}
      <LoadingRegion loading={loading} className={styles.bodyFrame}>
        <div className={styles.body}>{children}</div>
      </LoadingRegion>
    </section>
  );
}
