import {
  accessPatchSchema,
  rolePatchSchema,
  userPageSchema,
  userQuerySchema,
  userSchema,
} from '@caseflow/schemas';

import { Operation } from '../database/operations.js';
import type { RegisterProtectedRoute } from './protected-route.js';

export function registerUserRoutes(route: RegisterProtectedRoute) {
  route({
    method: 'GET',
    url: '/admin/users',
    operation: Operation.ListUsers,
    output: userPageSchema,
    query: userQuerySchema,
  });

  route({
    method: 'PATCH',
    url: '/admin/users/:id/role',
    operation: Operation.UpdateRole,
    output: userSchema,
    body: rolePatchSchema,
  });

  route({
    method: 'PATCH',
    url: '/admin/users/:id/access',
    operation: Operation.UpdateAccess,
    output: userSchema,
    body: accessPatchSchema,
  });
}
