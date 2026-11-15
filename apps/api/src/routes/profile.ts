import { profilePatchSchema, userSchema } from '@caseflow/schemas';

import { Operation } from '../database/operations.js';
import type { RegisterProtectedRoute } from './protected-route.js';

export function registerProfileRoutes(route: RegisterProtectedRoute) {
  route({
    method: 'GET',
    url: '/me',
    operation: Operation.GetProfile,
    output: userSchema,
  });

  route({
    method: 'PATCH',
    url: '/me',
    operation: Operation.UpdateProfile,
    output: userSchema,
    body: profilePatchSchema,
  });
}
