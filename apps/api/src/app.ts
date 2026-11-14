import Fastify from 'fastify';
import cors from '@fastify/cors';
import { AuthError, createTokenVerifier } from './auth.js';
import type { ApiConfig } from './config.js';

const errorSchema = {
  type: 'object',
  required: ['error'],
  additionalProperties: false,
  properties: { error: { type: 'string' } },
};

export async function buildApp(
  config: ApiConfig,
  verify = createTokenVerifier(config),
  logger = true,
) {
  const app = Fastify({
    logger: logger ? { redact: ['req.headers.authorization', 'req.headers.cookie'] } : false,
  });
  await app.register(cors, {
    origin: config.webOrigin,
    methods: ['GET'],
    allowedHeaders: ['Authorization'],
    credentials: false,
  });
  app.get(
    '/me',
    {
      schema: {
        response: {
          401: errorSchema,
          403: errorSchema,
          503: errorSchema,
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['subject', 'tenantId', 'name', 'access'],
            properties: {
              subject: { type: 'string' },
              tenantId: { type: 'string' },
              name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              access: { const: 'demo', type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const authorization = request.headers.authorization;
      const match = authorization?.match(/^Bearer ([^\s]+)$/i);
      try {
        if (!match?.[1] || match[1].length > 16384) throw new AuthError(401);
        return await verify(match[1]);
      } catch (error) {
        if (!(error instanceof AuthError)) throw error;
        if (error.statusCode === 401) reply.header('WWW-Authenticate', 'Bearer realm="caseflow"');
        if (error.statusCode === 403)
          reply.header(
            'WWW-Authenticate',
            'Bearer error="insufficient_scope", scope="access_as_user"',
          );
        return reply.code(error.statusCode).send({ error: error.message });
      }
    },
  );
  return app;
}
