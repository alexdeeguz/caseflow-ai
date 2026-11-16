import {
  CaseArchiveFilter,
  SearchLimits,
  SearchMode,
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
  case: string | null;
  search: string;
  status?: CaseStatus;
  page: number;
  archive: CaseArchiveFilter;
  mode?: typeof CaseMode.Edit;
  /** Global document search (Search tab). */
  query: string;
  searchMode: SearchMode;
  searchCase: string | null;
  searchArchive: CaseArchiveFilter;
  searchPage: number;
  /** Search within the open case's Documents tab. */
  documentQuery: string;
  documentQueryPage: number;
  /** Document to show in the details drawer (e.g. opened from a search result). */
  document: string | null;
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
  const searching = tab === WorkspaceTab.Search;
  const searchCase = params.get(WorkspaceParam.SearchCase);
  const searchArchive = caseArchiveSchema.safeParse(params.get(WorkspaceParam.SearchArchive));
  const requestedDocument = params.get(WorkspaceParam.Document);

  return {
    tab,
    section: hasCase
      ? (Object.values(CaseSection).find((value) => value === section) ?? CaseSection.Overview)
      : CaseSection.Overview,
    timelinePage: hasCase ? parsePage(params.get(WorkspaceParam.TimelinePage)) : 1,
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
    query: searching ? searchText(params.get(WorkspaceParam.Query)) : '',
    searchMode:
      searching && params.get(WorkspaceParam.SearchMode) === SearchMode.Keyword
        ? SearchMode.Keyword
        : SearchMode.Hybrid,
    searchCase: searching && idSchema.safeParse(searchCase).success ? searchCase : null,
    searchArchive:
      searching && searchArchive.success ? searchArchive.data : CaseArchiveFilter.Current,
    searchPage: searching ? parsePage(params.get(WorkspaceParam.SearchPage)) : 1,
    documentQuery: hasCase ? searchText(params.get(WorkspaceParam.DocumentQuery)) : '',
    documentQueryPage: hasCase ? parsePage(params.get(WorkspaceParam.DocumentQueryPage)) : 1,
    document: hasCase && idSchema.safeParse(requestedDocument).success ? requestedDocument : null,
  };
}

function searchText(value: string | null): string {
  return (value ?? '').slice(0, SearchLimits.QueryMaxLength);
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
      if (location.documentPage > 1) {
        params.set(WorkspaceParam.DocumentPage, String(location.documentPage));
      }
      if (location.documentQuery) {
        params.set(WorkspaceParam.DocumentQuery, location.documentQuery);
        if (location.documentQueryPage > 1) {
          params.set(WorkspaceParam.DocumentQueryPage, String(location.documentQueryPage));
        }
      }
      if (location.document) {
        params.set(WorkspaceParam.Document, location.document);
      }
    }
    if (location.case !== CaseView.New && location.mode) {
      params.set(WorkspaceParam.Mode, location.mode);
    }
  }
  if (location.tab === WorkspaceTab.Search) {
    if (location.query) {
      params.set(WorkspaceParam.Query, location.query);
    }
    if (location.searchMode !== SearchMode.Hybrid) {
      params.set(WorkspaceParam.SearchMode, location.searchMode);
    }
    if (location.searchCase) {
      params.set(WorkspaceParam.SearchCase, location.searchCase);
    }
    if (location.searchArchive !== CaseArchiveFilter.Current) {
      params.set(WorkspaceParam.SearchArchive, location.searchArchive);
    }
    if (location.searchPage > 1) {
      params.set(WorkspaceParam.SearchPage, String(location.searchPage));
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
 * Opening or closing the create-case modal keeps the case list on screen, so it is in-place too.
 */
export function isPageNavigation(from: WorkspaceLocation, to: WorkspaceLocation): boolean {
  const listView = (location: WorkspaceLocation) =>
    location.tab === WorkspaceTab.Cases && (!location.case || location.case === CaseView.New);
  if (to.tab === from.tab && to.mode === from.mode && listView(from) && listView(to)) {
    return false;
  }
  return to.tab !== from.tab || to.case !== from.case || to.mode !== from.mode;
}
