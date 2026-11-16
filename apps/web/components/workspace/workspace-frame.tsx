'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Brand } from '../brand';
import { CloseIcon, MenuIcon } from './workspace-icons';
import { LoadingRegion } from '../ui/loading-region';
import styles from './workspace.module.css';

const workspaceMainId = 'workspace-main';

interface WorkspaceFrameProps {
  account?: ReactNode;
  navigation: (closeNavigation: () => void) => ReactNode;
  busy?: boolean;
  children: ReactNode;
}

export function WorkspaceFrame({
  account,
  navigation,
  busy = false,
  children,
}: WorkspaceFrameProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  function closeNavigation() {
    if (menuOpen) {
      setMenuOpen(false);
      document.getElementById(workspaceMainId)?.focus();
    }
  }

  return (
    <div className={styles.shell}>
      <a href={`#${workspaceMainId}`} className={styles.skip}>
        Skip to content
      </a>
      <aside
        className={styles.sidebar}
        aria-label="CaseFlow workspace"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && menuOpen) {
            event.preventDefault();
            setMenuOpen(false);
            menuButton.current?.focus();
          }
        }}
      >
        <div className={styles.sidebarHeader}>
          <Brand />
          <button
            ref={menuButton}
            type="button"
            className={styles.menuToggle}
            aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
            aria-controls="workspace-navigation"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>
        <div id="workspace-navigation" className={styles.sidebarContent} data-open={menuOpen}>
          <p className={styles.navigationLabel}>Workspace</p>
          {navigation(closeNavigation)}
          <div className={styles.account}>{account}</div>
        </div>
      </aside>
      <div className={styles.body}>
        <LoadingRegion loading={busy} className={styles.mainRegion}>
          <main id={workspaceMainId} tabIndex={-1} className={styles.main}>
            {children}
          </main>
        </LoadingRegion>
      </div>
    </div>
  );
}
