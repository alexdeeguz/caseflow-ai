export const WorkspaceTab = {
  Cases: 'cases',
  Profile: 'profile',
  Users: 'users',
  Audit: 'audit',
} as const;

export type WorkspaceTab = (typeof WorkspaceTab)[keyof typeof WorkspaceTab];

export const tabLabels: Readonly<Record<WorkspaceTab, string>> = {
  [WorkspaceTab.Cases]: 'Cases',
  [WorkspaceTab.Profile]: 'Profile',
  [WorkspaceTab.Users]: 'Users',
  [WorkspaceTab.Audit]: 'Audit history',
};

export const CaseView = { New: 'new' } as const;
export const CaseMode = { Edit: 'edit' } as const;

export const WorkspaceParam = {
  Tab: 'tab',
  Case: 'case',
  Mode: 'mode',
  Archive: 'archive',
  Search: 'search',
  Status: 'status',
  Page: 'page',
} as const;
