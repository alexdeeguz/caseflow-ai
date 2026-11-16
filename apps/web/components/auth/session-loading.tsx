import { WorkspaceFrame } from '../workspace/workspace-frame';
import { LoadingIndicator } from '../ui/spinner';
import styles from '../workspace/workspace.module.css';

export function SessionLoading() {
  return (
    <WorkspaceFrame
      account={<div className={styles.loadingAccount} aria-hidden="true" />}
      navigation={() => (
        <div className={styles.loadingNavigation} aria-hidden="true">
          <div className={styles.skeleton} />
          <div className={styles.skeleton} />
          <div className={styles.skeleton} />
        </div>
      )}
    >
      <LoadingIndicator label="Opening your workspace…" />
      <div className="mt-8 grid gap-5" aria-hidden="true">
        <div className={styles.skeleton} />
        <div className={styles.skeleton} />
        <div className={styles.skeleton} />
      </div>
    </WorkspaceFrame>
  );
}
