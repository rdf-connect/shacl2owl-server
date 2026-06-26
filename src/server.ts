/**
 * Fastify app factory. Exposes POST /reason (RDF in, closure out) and GET /health.
 * Kept separate from index.ts so tests can drive it via `.inject()` without a port.
 */
import Fastify, {type FastifyError, type FastifyInstance} from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type {Config} from './config.js';
import {ReasoningInputError, ReasoningTimeoutError, runReasoning} from './reasoner.js';
import {$INLINE_FILE} from '@ajuvercr/ts-transformer-inline-file';

const INDEX_HTML: string = $INLINE_FILE('./index.html');

/** RDF media types we accept as a raw-text request body. */
const RDF_CONTENT_TYPES = [
   'text/turtle',
   'text/n3',
   'application/x-turtle',
   'application/n-triples',
   'text/plain',
];

export async function buildServer(rulesN3: string, config: Config): Promise<FastifyInstance> {
   const app = Fastify({
      bodyLimit: config.maxBodyBytes,
      // Don't advertise the framework; keep responses lean.
      disableRequestLogging: true,
   });

   await app.register(rateLimit, {
      max: config.rateLimitMax,
      timeWindow: config.rateLimitWindow,
   });

   // This endpoint only speaks RDF text: drop the default JSON/text parsers so any
   // unexpected content type is rejected with 415 instead of being silently accepted.
   app.removeAllContentTypeParsers();
   app.addContentTypeParser(
      RDF_CONTENT_TYPES,
      {parseAs: 'string', bodyLimit: config.maxBodyBytes},
      (_req, body, done) => done(null, body),
   );

   app.get('/', async (_request, reply) => reply.type('text/html').send(INDEX_HTML));

   app.get('/health', async () => ({status: 'ok'}));

   app.post('/reason', async (request, reply) => {
      const rdf = typeof request.body === 'string' ? request.body : '';
      if (rdf.trim() === '') {
         return reply.code(400).send({error: 'request body must contain non-empty RDF'});
      }
      const query = (request.query as { includeInputFacts?: string });
      const includeInputFactsInClosure = query.includeInputFacts === 'true' || query.includeInputFacts === "1";
      const closureN3 = await runReasoning(rdf, rulesN3, includeInputFactsInClosure, config.reasoningTimeoutMs);
      return reply.type('text/turtle').send(closureN3);
   });

   // Centralised, non-revealing error mapping.
   app.setErrorHandler((error: FastifyError, _request, reply) => {
      if (error instanceof ReasoningInputError || error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
         return reply.code(400).send({
            error: 'could not parse or reason over the supplied RDF',
            message: error.message
         });
      }
      if (error instanceof ReasoningTimeoutError) {
         return reply.code(503).send({error: 'reasoning time limit exceeded'});
      }
      if (error.statusCode === 413 || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
         return reply.code(413).send({error: 'request body too large'});
      }
      if (error.statusCode === 415 || error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
         return reply.code(415).send({error: 'unsupported content type'});
      }
      if (error.statusCode === 429) {
         return reply.code(429).send({error: 'rate limit exceeded'});
      }
      app.log.error(error);
      return reply.code(500).send({error: 'internal server error'});
   });

   return app;
}
