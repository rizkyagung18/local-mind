import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController, type FastifyError, type FastifyPluginAsync, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { API_PREFIX, ContractError, ERROR_STATUS, ErrorResponseSchema, HealthResponseSchema, LIMITS, SessionResponseSchema, type ErrorCode, type HealthResponse } from '@localmind/contracts';
import { allowedApiSource, allowedHost, validToken } from './access.js';
import type { Storage } from './db/index.js';
import type { AuditWriter } from './audit.js';
import type { ModelRegistry } from './services/models.js';
import { ModelError } from './providers/ollama/metadata.js';
import { modelRoutes } from './routes/models.js';
import { chatRoutes } from './routes/chats.js';
import { createChatService, type ChatRuntime } from './services/chats.js';
import { RepositoryError } from './db/repository.js';
import { StorageError } from './storage/private-directory.js';

type AppOptions = {
  development?: boolean; serveWeb?: boolean; webRoot?: string;
  storage?: Storage; sessionToken?: string; audit?: AuditWriter; routes?: FastifyPluginAsync; onClose?: () => void;
  models?: ModelRegistry; chatRuntime?: ChatRuntime;
};
export async function createApp({ development = false, serveWeb = true, webRoot, storage, sessionToken, audit, routes, onClose, models, chatRuntime }: AppOptions = {}) {
  if (development && process.env.NODE_ENV === 'production') throw new Error('Development access is disabled in production.');
  if (sessionToken !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) throw new Error('Invalid session token configuration.');
  const app = Fastify({
    logger: false, logController: new LogController({ disableRequestLogging: true }), trustProxy: false, requestIdHeader: false,
    bodyLimit: LIMITS.jsonBodyBytes, requestTimeout: 60_000,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  const token = sessionToken ?? randomBytes(32).toString('base64url');
  const failures = new WeakMap<FastifyRequest, ErrorCode>();
  let auditFailed = false;
  function deny(request: FastifyRequest, reply: FastifyReply, code: ErrorCode) {
    failures.set(request, code);
    return reply.code(ERROR_STATUS[code]).send({ error: {
      code, message: code === 'SESSION_REQUIRED' ? 'Refresh LocalMind to establish a local session.' : 'The request could not be processed.',
      retryable: code === 'STORAGE_UNAVAILABLE' || code === 'OLLAMA_UNAVAILABLE', requestId: request.id,
    } });
  }
  if (onClose) app.addHook('onClose', async () => { onClose(); });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    reply.header('Cache-Control', 'no-store');
    if (!request.url.startsWith('/') || request.url.startsWith('//')) return deny(request, reply, 'LOCAL_ACCESS_DENIED');
    let hostCount = 0;
    for (let i = 0; i < request.raw.rawHeaders.length; i += 2) if (request.raw.rawHeaders[i]?.toLowerCase() === 'host') hostCount++;
    if (hostCount !== 1 || !allowedHost(request.headers.host, development)) return deny(request, reply, 'LOCAL_ACCESS_DENIED');
    const pathname = request.url.split('?')[0]!;
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { return deny(request, reply, 'VALIDATION_ERROR'); }
    if (decoded.includes('\\') || decoded.split('/').some(part => part === '.' || part === '..')) return deny(request, reply, 'LOCAL_ACCESS_DENIED');
    if (decoded !== '/api' && !decoded.startsWith('/api/')) return;
    if (decoded !== pathname || request.method === 'OPTIONS') return deny(request, reply, 'LOCAL_ACCESS_DENIED');
    const origin = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];
    if (Array.isArray(fetchSite) || !allowedApiSource({ host: request.headers.host,
      ...(origin === undefined ? {} : { origin }), ...(fetchSite === undefined ? {} : { fetchSite }),
    }, development)) return deny(request, reply, 'LOCAL_ACCESS_DENIED');
    if (pathname === API_PREFIX + '/session' && request.method === 'GET') {
      if (request.headers['x-localmind-bootstrap'] !== '1' || fetchSite !== 'same-origin' || request.url.includes('?')) return deny(request, reply, 'LOCAL_ACCESS_DENIED');
      return;
    }
    if (!validToken(request.headers['x-localmind-token'], token)) return deny(request, reply, 'SESSION_REQUIRED');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
      && !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) return deny(request, reply, 'VALIDATION_ERROR');
  });
  app.addHook('onResponse', async (request, reply) => {
    try {
      const code = failures.get(request);
      audit?.({ requestId: request.id, statusCode: reply.statusCode, durationMs: reply.elapsedTime, ...(code ? { errorCode: code } : {}) });
    } catch { auditFailed = true; }
  });
  const errors = { '4xx': ErrorResponseSchema, '5xx': ErrorResponseSchema };
  app.get(API_PREFIX + '/session', { schema: { response: { 200: SessionResponseSchema, ...errors } } }, async () => ({ data: { token, apiVersion: 1 as const } }));
  app.get(API_PREFIX + '/health', { schema: { response: { 200: HealthResponseSchema, ...errors } } }, async (request, reply) => {
    let activeRunId: string | null = null;
    try {
      if (auditFailed) throw new Error('Audit unavailable');
      if (storage) {
        storage.sqlite.prepare('SELECT 1').get();
        const active = storage.sqlite.prepare("SELECT id FROM runs WHERE status IN ('preparing','streaming') LIMIT 1").get() as { id: string } | undefined;
        activeRunId = active?.id ?? null;
      }
    } catch { return deny(request, reply, 'STORAGE_UNAVAILABLE'); }
    const brokerState = models?.brokerState() ?? (activeRunId ? 'blocked' : 'idle');
    const ollamaStatus = models?.ollamaStatus() ?? 'not_checked';
    const health: HealthResponse = { data: {
      apiVersion: 1, appStatus: brokerState !== 'idle' || ollamaStatus === 'unavailable' ? 'degraded' : 'setup', databaseStatus: storage ? 'ready' : 'not_initialized',
      ollamaStatus, brokerState, activeRunId,
    } };
    return health;
  });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const code: ErrorCode = error instanceof ModelError || error instanceof ContractError || error instanceof RepositoryError ? error.code : error instanceof StorageError ? 'STORAGE_UNAVAILABLE' : error.statusCode === 413 ? 'PAYLOAD_TOO_LARGE'
      : error.validation || (error.statusCode !== undefined && [400, 415].includes(error.statusCode)) ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
    void deny(request, reply, code);
  });
  app.setNotFoundHandler((request, reply) => deny(request, reply, 'NOT_FOUND'));
  if (models) app.register(modelRoutes(models));
  if (storage) app.register(chatRoutes(createChatService(storage, models, chatRuntime ? { runtime: chatRuntime } : {})));
  if (routes) await app.register(routes);
  if (serveWeb) await app.register(fastifyStatic, { root: webRoot ?? fileURLToPath(new URL('../../web/dist/', import.meta.url)), dotfiles: 'deny', cacheControl: false });
  return app;
}
