import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { ErrorCode, idSchema } from '@caseflow/schemas';

import { AuthError, type createTokenVerifier } from '../auth.js';
import type { WorkspaceStore } from '../database/index.js';
import type { Operation } from '../database/operations.js';
import { AppError } from '../errors.js';

interface ProtectedRouteDefinition {
  method: 'GET' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  operation: Operation;
  output: z.ZodType;
  body?: z.ZodType;
  query?: z.ZodType;
}

export function createProtectedRouteRegistrar(
  app: FastifyInstance,
  verify: ReturnType<typeof createTokenVerifier>,
  store: WorkspaceStore,
) {
  return function registerProtectedRoute({
    method,
    url,
    operation,
    output,
    body,
    query,
  }: ProtectedRouteDefinition) {
    app.route({
      method,
      url,
      handler: async (request, reply) => {
        const match = request.headers.authorization?.match(/^Bearer ([^\s]+)$/i);

        if (!match?.[1] || match[1].length > 16384) {
          throw new AuthError(401);
        }

        const identity = await verify(match[1]);
        const params = request.params as Record<string, string>;

        for (const value of Object.values(params)) {
          idSchema.parse(value);
        }

        // Parse the original body strictly: Fastify's default Ajv strips unknown keys.
        const input = {
          ...params,
          ...(body ? (body.parse(request.body) as object) : {}),
          ...(query ? (query.parse(request.query) as object) : {}),
        };
        const result = await store.execute(identity, operation, input);
        const parsed = output.safeParse(result);

        if (!parsed.success) {
          throw new AppError(
            ErrorCode.InternalError,
            500,
            'The API returned an unexpected response.',
          );
        }

        return reply.send(parsed.data);
      },
    });
  };
}

export type RegisterProtectedRoute = ReturnType<typeof createProtectedRouteRegistrar>;
