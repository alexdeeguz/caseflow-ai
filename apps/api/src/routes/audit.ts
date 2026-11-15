import { auditPageSchema, pageQuerySchema } from '@caseflow/schemas';

import { Operation } from '../database/operations.js';
import type { RegisterProtectedRoute } from './protected-route.js';

export function registerAuditRoutes(route: RegisterProtectedRoute) {
  route({
    method: 'GET',
    url: '/admin/audit',
    operation: Operation.ListAudit,
    output: auditPageSchema,
    query: pageQuerySchema,
  });
}
