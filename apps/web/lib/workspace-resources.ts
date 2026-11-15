import {
  CaseArchiveFilter,
  auditPageSchema,
  caseDetailSchema,
  casePageSchema,
  userPageSchema,
  type Role,
  type CaseQuery,
} from '@caseflow/schemas';

export function caseListResource({
  page = 1,
  search = '',
  status,
  archive = CaseArchiveFilter.Current,
}: Partial<CaseQuery> = {}) {
  const query = new URLSearchParams({ page: String(page), search: search.trim(), archive });

  if (status) {
    query.set('status', status);
  }

  return { path: `/cases?${query}`, schema: casePageSchema };
}

export const caseDetailResource = (id: string) => ({
  path: `/cases/${id}`,
  schema: caseDetailSchema,
});

export function userListResource({
  page = 1,
  search = '',
  role,
}: { page?: number; search?: string; role?: Role } = {}) {
  const query = new URLSearchParams({ page: String(page), search });

  if (role) {
    query.set('role', role);
  }

  return { path: `/admin/users?${query}`, schema: userPageSchema };
}

export const auditListResource = (page = 1) => ({
  path: `/admin/audit?page=${page}`,
  schema: auditPageSchema,
});
