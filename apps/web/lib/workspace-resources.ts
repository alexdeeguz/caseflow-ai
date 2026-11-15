import {
  auditPageSchema,
  caseDetailSchema,
  casePageSchema,
  userPageSchema,
  type Role,
} from '@caseflow/schemas';

export const caseListResource = (page = 1) => ({
  path: `/cases?page=${page}`,
  schema: casePageSchema,
});

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
