import type { ReactNode } from 'react';
import { Brand } from '../brand';
import styles from './workspace.module.css';

export function WorkspaceFrame({
  headerActions,
  navigation,
  busy = false,
  children,
}: {
  headerActions?: ReactNode;
  navigation: ReactNode;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={styles.shell}>
      <a href="#workspace-main" className={styles.skip}>
        Skip to content
      </a>
      <header className={styles.header}>
        <Brand />
        <div className="flex flex-wrap items-center gap-4">{headerActions}</div>
      </header>
      <div className={styles.body}>
        {navigation}
        <main id="workspace-main" tabIndex={-1} className={styles.main} aria-busy={busy}>
          {children}
        </main>
      </div>
      <footer className={styles.footer}>
        Independent portfolio demo · Fictional case data only
      </footer>
    </div>
  );
}
