import { WorkspaceFrame } from '../workspace/workspace-frame';
import styles from '../workspace/workspace.module.css';

export function SessionLoading() {
  return (
    <WorkspaceFrame
      headerActions={<div className={styles.loadingAccount} aria-hidden="true" />}
      navigation={
        <div className={styles.loadingNavigation} aria-hidden="true">
          <div className={styles.skeleton} />
          <div className={styles.skeleton} />
          <div className={styles.skeleton} />
        </div>
      }
    >
      <p role="status" className="text-muted">
        Opening your workspace…
      </p>
      <div className="mt-8 grid gap-5" aria-hidden="true">
        <div className={styles.skeleton} />
        <div className={styles.skeleton} />
        <div className={styles.skeleton} />
      </div>
    </WorkspaceFrame>
  );
}
