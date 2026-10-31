/** Fastify production transport; all route logic stays in HarnessService.handle. */
export async function createFastifyServer(service, { bodyLimit = 128_000 } = {}) {
  const imported = await import('fastify');
  const fastify = (imported.default ?? imported)({ logger: false, bodyLimit });
  const dispatch = async (request, reply) => {
    // The shared route handler consumes JSON itself for the SQLite test server.
    // Fastify has already parsed the body, so hand the same object across.
    request.raw.fastifyParsedBody = request.body;
    reply.hijack();
    await service.handle(request.raw, reply.raw);
  };
  fastify.all('/', dispatch);
  fastify.all('/*', dispatch);
  return fastify;
}
