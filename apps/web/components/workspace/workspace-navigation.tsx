import { Role } from '@caseflow/schemas';
import type { ComponentType } from 'react';

import { WorkspaceTab, tabLabels } from './navigation';
import { AuditIcon, CasesIcon, ProfileIcon, UsersIcon } from './workspace-icons';
import styles from './workspace.module.css';

const tabIcons: Readonly<Record<WorkspaceTab, ComponentType>> = {
  [WorkspaceTab.Cases]: CasesIcon,
  [WorkspaceTab.Profile]: ProfileIcon,
  [WorkspaceTab.Users]: UsersIcon,
  [WorkspaceTab.Audit]: AuditIcon,
};

interface WorkspaceNavigationProps {
  role: Role;
  currentTab: WorkspaceTab;
  pendingTab: WorkspaceTab | null;
  onSelect: (tab: WorkspaceTab) => void;
}

export function WorkspaceNavigation({
  role,
  currentTab,
  pendingTab,
  onSelect,
}: WorkspaceNavigationProps) {
  const tabs: WorkspaceTab[] =
    role === Role.Staff
      ? [WorkspaceTab.Cases, WorkspaceTab.Profile]
      : [WorkspaceTab.Cases, WorkspaceTab.Profile, WorkspaceTab.Users, WorkspaceTab.Audit];

  return (
    <nav aria-label="Workspace" className={styles.nav}>
      {tabs.map((tab) => {
        const TabIcon = tabIcons[tab];

        return (
          <button
            key={tab}
            type="button"
            aria-current={tab === currentTab ? 'page' : undefined}
            aria-busy={pendingTab === tab}
            onClick={() => onSelect(tab)}
          >
            <TabIcon />
            <span>{tabLabels[tab]}</span>
          </button>
        );
      })}
    </nav>
  );
}
