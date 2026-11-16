import type { Role } from '@caseflow/schemas';
import {
  caseTimelineResource,
  caseReviewedSummaryResource,
} from '../../lib/case-history/resources';
import {
  auditListResource,
  caseDetailResource,
  caseListResource,
  userListResource,
} from '../../lib/workspace-resources';
import type { Resource } from '../../lib/resources';
import type { WorkspaceLocation } from '../../lib/workspace-location';
import { CaseSection, CaseView, WorkspaceTab } from '../../lib/constants/navigation';

import { documentLibraryQuery, documentListResource } from '../../lib/documents/resources';

export { WorkspaceTab, tabLabels } from '../../lib/constants/navigation';

export function locationResources(location: WorkspaceLocation, role: Role): Resource<unknown>[] {
  switch (location.tab) {
    case WorkspaceTab.Cases:
      if (location.case === CaseView.New) {
        return [];
      }
      if (!location.case) {
        return [caseListResource(location)];
      }
      return [
        caseDetailResource(location.case),
        ...(location.section === CaseSection.Timeline && !location.mode
          ? [caseTimelineResource(location.case, location.timelinePage)]
          : []),
        ...(location.section === CaseSection.ReviewedSummary && !location.mode
          ? [
              caseReviewedSummaryResource(
                location.case,
                location.summaryCategory,
                location.summaryPage,
              ),
            ]
          : []),
        ...(location.section === CaseSection.Documents && !location.mode
          ? [documentListResource(location.case, documentLibraryQuery(location, role))]
          : []),
      ];
    case WorkspaceTab.Users:
      return [userListResource()];
    case WorkspaceTab.Audit:
      return [auditListResource()];
    case WorkspaceTab.Profile:
      return [];
  }
}
