import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { ErrorCode } from '@caseflow/schemas';

import { AuthError, createTokenVerifier } from './auth.js';
import type { ApiConfig } from './config.js';
import { AppError } from './errors.js';
import { registerProcessingDispatcher } from './processing/register.js';
import type { ProcessingDispatcher } from './processing/dispatcher.js';
import { createDatabase, type WorkspaceStore } from './database/index.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerCaseRoutes } from './routes/cases.js';
import { registerProfileRoutes } from './routes/profile.js';
import { createProtectedRouteRegistrar } from './routes/protected-route.js';
import { registerUserRoutes } from './routes/users.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerProcessingRoutes } from './routes/processing.js';
import { createUploadStorage, type UploadStorage } from './storage/uploads.js';
import { createDocumentStorage } from './storage/s3.js';
import { createDownloadStorage, type DownloadStorage } from './storage/downloads.js';

export async function buildApp(
  config: ApiConfig,
  verify = createTokenVerifier(config),
  logger = true,
  store: WorkspaceStore = createDatabase(config.databaseUrl),
  uploadStorage?: UploadStorage,
  downloadStorage?: DownloadStorage,
  dispatcher?: ProcessingDispatcher,
) {
  const app = Fastify({
    bodyLimit: 16384,
    logger: logger ? { redact: ['req.headers.authorization', 'req.headers.cookie'] } : false,
  });

  const storage = config.storage ? createDocumentStorage(config.storage) : null;

  app.decorate('documentStorage', storage);
  app.addHook('onClose', async () => storage?.client.destroy());

  await app.register(cors, {
    origin: config.webOrigin,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: false,
  });
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  app.addHook('onClose', async () => store.close());
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        code: ErrorCode.InvalidInput,
        error: 'Check the supplied values. Unknown fields are not allowed.',
      });
    }

    if (error instanceof AuthError) {
      if (error.statusCode === 401) {
        reply.header('WWW-Authenticate', 'Bearer realm="caseflow"');
      }

      if (error.statusCode === 403) {
        reply.header(
          'WWW-Authenticate',
          'Bearer error="insufficient_scope", scope="access_as_user"',
        );
      }

      return reply.code(error.statusCode).send({
        code:
          error.statusCode === 401
            ? ErrorCode.Unauthenticated
            : error.statusCode === 403
              ? ErrorCode.InsufficientScope
              : ErrorCode.ServiceUnavailable,
        error: error.message,
      });
    }

    if (error instanceof AppError) {
      return reply.code(error.status).send({ code: error.code, error: error.message });
    }

    const status = (error as { statusCode?: number }).statusCode;

    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ code: ErrorCode.InvalidInput, error: 'Invalid request.' });
    }

    request.log.error({ event: 'request_failed' }, 'Request could not complete');

    return reply
      .code(500)
      .send({ code: ErrorCode.InternalError, error: 'The request could not be completed.' });
  });

  const route = createProtectedRouteRegistrar(app, verify, store);

  registerProfileRoutes(route);
  registerUserRoutes(route);
  registerCaseRoutes(route);
  registerAuditRoutes(route);
  registerProcessingRoutes(route);
  registerDocumentRoutes(
    route,
    store,
    uploadStorage ?? (storage ? createUploadStorage(storage) : null),
    downloadStorage ?? (storage ? createDownloadStorage(storage) : null),
  );

  registerProcessingDispatcher(app, config.dispatcher, dispatcher);

  return app;
}
