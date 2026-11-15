import {
  CaseArchiveFilter,
  caseArchiveSchema,
  CaseLimits,
  caseStatusSchema,
  idSchema,
  type CaseStatus,
} from '@caseflow/schemas';
import { CaseMode, CaseView, WorkspaceParam, WorkspaceTab } from './constants/navigation';

export interface WorkspaceLocation {
  tab: WorkspaceTab;
  case: string | null;
  search: string;
  status?: CaseStatus;
  page: number;
  archive: CaseArchiveFilter;
  mode?: typeof CaseMode.Edit;
}

export function parseWorkspaceLocation(params: URLSearchParams): WorkspaceLocation {
  const requestedTab = params.get(WorkspaceParam.Tab);
  const tab =
    Object.values(WorkspaceTab).find((value) => value === requestedTab) ?? WorkspaceTab.Cases;
  const selected = params.get(WorkspaceParam.Case);
  const status = caseStatusSchema.safeParse(params.get(WorkspaceParam.Status));
  const archive = caseArchiveSchema.safeParse(params.get(WorkspaceParam.Archive));
  const mode = params.get(WorkspaceParam.Mode);
  const page = Number(params.get(WorkspaceParam.Page) ?? 1);

  return {
    tab,
    archive: archive.success ? archive.data : CaseArchiveFilter.Current,
    mode:
      tab === WorkspaceTab.Cases && idSchema.safeParse(selected).success && mode === CaseMode.Edit
        ? CaseMode.Edit
        : undefined,
    case: selected === CaseView.New || idSchema.safeParse(selected).success ? selected : null,
    search: (params.get(WorkspaceParam.Search) ?? '').slice(0, CaseLimits.Search),
    status: status.success ? status.data : undefined,
    page: Number.isInteger(page) && page >= 1 && page <= 100000 ? page : 1,
  };
}

export function workspaceHref(location: WorkspaceLocation): string {
  const params = new URLSearchParams({ [WorkspaceParam.Tab]: location.tab });

  if (location.tab === WorkspaceTab.Cases && location.case) {
    params.set(WorkspaceParam.Case, location.case);
    if (location.case !== CaseView.New && location.mode) {
      params.set(WorkspaceParam.Mode, location.mode);
    }
  }
  if (location.archive !== CaseArchiveFilter.Current) {
    params.set(WorkspaceParam.Archive, location.archive);
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
