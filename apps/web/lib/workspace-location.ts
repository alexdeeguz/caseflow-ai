import { CaseLimits, caseStatusSchema, idSchema, type CaseStatus } from '@caseflow/schemas';
import { CaseView, WorkspaceParam, WorkspaceTab } from './constants/navigation';

export interface WorkspaceLocation {
  tab: WorkspaceTab;
  case: string | null;
  search: string;
  status?: CaseStatus;
  page: number;
}

export function parseWorkspaceLocation(params: URLSearchParams): WorkspaceLocation {
  const requestedTab = params.get(WorkspaceParam.Tab);
  const tab =
    Object.values(WorkspaceTab).find((value) => value === requestedTab) ?? WorkspaceTab.Cases;
  const selected = params.get(WorkspaceParam.Case);
  const status = caseStatusSchema.safeParse(params.get(WorkspaceParam.Status));
  const page = Number(params.get(WorkspaceParam.Page) ?? 1);

  return {
    tab,
    case: selected === CaseView.New || idSchema.safeParse(selected).success ? selected : null,
    search: (params.get(WorkspaceParam.Search) ?? '').trim().slice(0, CaseLimits.Search),
    status: status.success ? status.data : undefined,
    page: Number.isInteger(page) && page >= 1 && page <= 100000 ? page : 1,
  };
}

export function workspaceHref(location: WorkspaceLocation): string {
  const params = new URLSearchParams({ [WorkspaceParam.Tab]: location.tab });

  if (location.tab === WorkspaceTab.Cases && location.case) {
    params.set(WorkspaceParam.Case, location.case);
  }
  if (location.search) {
    params.set(WorkspaceParam.Search, location.search);
  }
  if (location.status) {
    params.set(WorkspaceParam.Status, location.status);
  }
  if (location.page > 1) {
    params.set(WorkspaceParam.Page, String(location.page));
  }

  return `/?${params}`;
}
