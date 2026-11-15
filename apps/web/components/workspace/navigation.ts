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
