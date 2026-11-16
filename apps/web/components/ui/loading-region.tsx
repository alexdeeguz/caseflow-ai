import type { ReactNode } from 'react';
import { Spinner } from './spinner';
import styles from './loading-region.module.css';

/**
 * Wraps content that can reload in place. While `loading`, a soft overlay with a centered spinner
 * covers just this region (after a short delay, so quick loads don't flash).
 */
export function LoadingRegion({
  loading,
  label = 'Loading…',
  className = '',
  children,
}: {
  loading: boolean;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`${styles.region} ${className}`} aria-busy={loading}>
      {children}
      {loading && (
        // Visual cue only; navigation is announced by the workspace's live region.
        <div className={styles.overlay} aria-hidden="true">
          <div className={styles.indicator}>
            <Spinner size={28} />
            <span>{label}</span>
          </div>
        </div>
      )}
    </div>
  );
}
