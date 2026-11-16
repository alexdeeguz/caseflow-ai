import {
  FactCategory,
  CaseArchiveFilter,
  DocumentFilter,
  caseArchiveSchema,
  CaseLimits,
  caseStatusSchema,
  idSchema,
  type CaseStatus,
} from '@caseflow/schemas';
import {
  CaseMode,
  CaseSection,
  CaseView,
  WorkspaceParam,
  WorkspaceTab,
} from './constants/navigation';

export interface WorkspaceLocation {
  tab: WorkspaceTab;
  section: CaseSection;
  documentFilter: DocumentFilter;
  documentPage: number;
  timelinePage: number;
  summaryPage: number;
  summaryCategory: FactCategory;
  case: string | null;
  search: string;
  status?: CaseStatus;
  page: number;
  archive: CaseArchiveFilter;
  mode?: typeof CaseMode.Edit;
}

function parsePage(value: string | null): number {
  const page = Number(value ?? 1);
  return Number.isInteger(page) && page >= 1 && page <= 100000 ? page : 1;
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
  const documentPage = Number(params.get(WorkspaceParam.DocumentPage) ?? 1);
  const hasCase = tab === WorkspaceTab.Cases && idSchema.safeParse(selected).success;
  const section = params.get(WorkspaceParam.Section);
  const documentFilter = params.get(WorkspaceParam.DocumentFilter);

  return {
    tab,
    section: hasCase
      ? (Object.values(CaseSection).find((value) => value === section) ?? CaseSection.Overview)
      : CaseSection.Overview,
    timelinePage: hasCase ? parsePage(params.get(WorkspaceParam.TimelinePage)) : 1,
    summaryPage: hasCase ? parsePage(params.get(WorkspaceParam.SummaryPage)) : 1,
    summaryCategory: hasCase
      ? (Object.values(FactCategory).find(
          (value) => value === params.get(WorkspaceParam.SummaryCategory),
        ) ?? FactCategory.Date)
      : FactCategory.Date,
    documentFilter: hasCase
      ? (Object.values(DocumentFilter).find((value) => value === documentFilter) ??
        DocumentFilter.Current)
      : DocumentFilter.Current,
    documentPage:
      hasCase && Number.isInteger(documentPage) && documentPage >= 1 && documentPage <= 100000
        ? documentPage
        : 1,
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
    if (location.case !== CaseView.New) {
      if (location.section !== CaseSection.Overview) {
        params.set(WorkspaceParam.Section, location.section);
      }
      if (location.documentFilter !== DocumentFilter.Current) {
        params.set(WorkspaceParam.DocumentFilter, location.documentFilter);
      }
      if (location.timelinePage > 1) {
        params.set(WorkspaceParam.TimelinePage, String(location.timelinePage));
      }
      if (location.summaryPage > 1) {
        params.set(WorkspaceParam.SummaryPage, String(location.summaryPage));
      }
      if (location.summaryCategory !== FactCategory.Date) {
        params.set(WorkspaceParam.SummaryCategory, location.summaryCategory);
      }
      if (location.documentPage > 1) {
        params.set(WorkspaceParam.DocumentPage, String(location.documentPage));
      }
    }
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

/**
 * True when navigating replaces the whole page (another tab, case, or editor mode). Otherwise the
 * change is in-place (a case section, filter or page) and the affected region shows its own loading.
 */
export function isPageNavigation(from: WorkspaceLocation, to: WorkspaceLocation): boolean {
  return to.tab !== from.tab || to.case !== from.case || to.mode !== from.mode;
}
