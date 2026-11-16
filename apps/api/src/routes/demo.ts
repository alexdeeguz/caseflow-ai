import type { FastifyInstance } from 'fastify';
import { ErrorCode, demoSessionSchema } from '@caseflow/schemas';
import { DemoIdentity, createRateLimiter, type DemoSessions } from '../demo.js';
import type { WorkspaceStore } from '../database/index.js';
import { Operation } from '../database/operations.js';
import { AppError } from '../errors.js';

/** Public endpoint that starts a demo session; registered only when demo sign-in is enabled. */
export function registerDemoRoutes(
  app: FastifyInstance,
  sessions: DemoSessions,
  store: WorkspaceStore,
) {
  const allow = createRateLimiter(10, 60_000);

  app.post('/auth/demo-session', async (request, reply) => {
    if (!allow(request.ip)) {
      throw new AppError(
        ErrorCode.RateLimited,
        429,
        'Too many demo sign-ins. Try again in a minute.',
      );
    }
    try {
      // Creates Demo Admin on first use; fails if a Super Admin has disabled it.
      await store.execute(DemoIdentity, Operation.StartDemoSession, {});
    } catch (error) {
      if (error instanceof AppError && error.code === ErrorCode.AccountDisabled) {
        throw new AppError(ErrorCode.AccountDisabled, 403, 'Demo access is currently turned off.');
      }
      throw error;
    }
    return reply.code(201).send(demoSessionSchema.parse(await sessions.issue()));
  });
}
