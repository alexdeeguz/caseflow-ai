import {
  auditListResource,
  caseDetailResource,
  caseListResource,
  userListResource,
} from '../../lib/workspace-resources';
import type { Resource } from '../../lib/resources';
import type { WorkspaceLocation } from '../../lib/workspace-location';
import { CaseView, WorkspaceTab } from '../../lib/constants/navigation';

export { WorkspaceTab, tabLabels } from '../../lib/constants/navigation';

export function locationResource(location: WorkspaceLocation): Resource<unknown> | null {
  switch (location.tab) {
    case WorkspaceTab.Cases:
      if (location.case === CaseView.New) {
        return null;
      }
      return location.case ? caseDetailResource(location.case) : caseListResource(location);
    case WorkspaceTab.Users:
      return userListResource();
    case WorkspaceTab.Audit:
      return auditListResource();
    case WorkspaceTab.Profile:
      return null;
  }
}
