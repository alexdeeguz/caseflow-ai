import {
  auditListResource,
  caseListResource,
  userListResource,
} from '../../lib/workspace-resources';
import type { Resource } from '../../lib/resources';

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

const tabResources: Readonly<Record<WorkspaceTab, Resource<unknown> | null>> = {
  [WorkspaceTab.Cases]: caseListResource(),
  [WorkspaceTab.Profile]: null,
  [WorkspaceTab.Users]: userListResource(),
  [WorkspaceTab.Audit]: auditListResource(),
};

export const tabResource = (tab: WorkspaceTab) => tabResources[tab];
