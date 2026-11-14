import Fastify from 'fastify';

const server = Fastify({ logger: true });
const port = Number(process.env.API_PORT ?? 4000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close();
  });
}

try {
  await server.listen({ port, host: process.env.API_HOST ?? '127.0.0.1' });
} catch (error) {
  server.log.error(error);
  process.exitCode = 1;
}
