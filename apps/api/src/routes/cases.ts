import { z } from 'zod';
import {
  caseDetailSchema,
  casePageSchema,
  caseCreateSchema,
  caseQuerySchema,
  caseSchema,
  successSchema,
} from '@caseflow/schemas';

import { Operation } from '../database/operations.js';
import type { RegisterProtectedRoute } from './protected-route.js';

export function registerCaseRoutes(route: RegisterProtectedRoute) {
  route({
    method: 'POST',
    url: '/cases',
    operation: Operation.CreateCase,
    successStatus: 201,
    body: caseCreateSchema,
    output: caseSchema,
  });

  route({
    method: 'GET',
    url: '/cases',
    operation: Operation.ListCases,
    output: casePageSchema,
    query: caseQuerySchema,
  });

  route({
    method: 'GET',
    url: '/cases/:id',
    operation: Operation.GetCase,
    output: caseDetailSchema,
  });

  route({
    method: 'PUT',
    url: '/admin/cases/:id/assignments/:userId',
    operation: Operation.AssignCase,
    output: successSchema,
    body: z.undefined(),
  });

  route({
    method: 'DELETE',
    url: '/admin/cases/:id/assignments/:userId',
    operation: Operation.UnassignCase,
    output: successSchema,
    body: z.undefined(),
  });
}
