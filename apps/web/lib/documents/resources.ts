import { DocumentFilter, Role, documentPageSchema } from '@caseflow/schemas';
import type { WorkspaceLocation } from '../workspace-location';

export function documentLibraryQuery(location: WorkspaceLocation, role: Role) {
  return {
    filter: role === Role.Staff ? DocumentFilter.Current : location.documentFilter,
    page:
      role === Role.Staff && location.documentFilter !== DocumentFilter.Current
        ? 1
        : location.documentPage,
  };
}

export function documentListResource(
  caseId: string,
  query: { filter: DocumentFilter; page: number },
) {
  const params = new URLSearchParams({ page: String(query.page), filter: query.filter });
  return { path: `/cases/${caseId}/documents?${params}`, schema: documentPageSchema };
}
