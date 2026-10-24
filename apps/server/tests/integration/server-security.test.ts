import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
vi.mock('@localmind/contracts', () => import('../../../../packages/contracts/src/index.js'));
import { ErrorResponseSchema, HealthResponseSchema, TurnRequestSchema, parseContract } from '../../../../packages/contracts/src/index.js';
import { createApp } from '../../src/app.js';
import { createLocalServer } from '../../src/lifecycle.js';
import { ModelError, type MetadataProvider } from '../../src/providers/ollama/metadata.js';
import { AUDIT_MAX_BYTES, createAuditWriter } from '../../src/audit.js';
import { openStorage, type Storage } from '../../src/db/index.js';

let root: string;
let apps: FastifyInstance[];
let stores: Storage[];
let oldMask: number;
const token = 't'.repeat(43);
const modelProvider: MetadataProvider = {
  discover: async () => ({ version: '0.40.3', installed: [], resident: [] }),
};
const auth = { 'x-localmind-token': token, origin: 'http://127.0.0.1:3210', 'sec-fetch-site': 'same-origin' };
beforeEach(() => {
  oldMask = process.umask(0o077);
  root = mkdtempSync(join(realpathSync(tmpdir()), 'localmind-t04-'));
  apps = []; stores = [];
});
afterEach(async () => {
  for (const app of apps) await app.close();
  for (const store of stores) store.close();
  rmSync(root, { recursive: true, force: true });
  process.umask(oldMask);
  vi.unstubAllEnvs();
});
async function listen(app: FastifyInstance) {
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  expect(address.address).toBe('127.0.0.1');
  return address.port;
}
async function server(options: Parameters<typeof createApp>[0] = {}) {
  return listen(await createApp({ serveWeb: false, sessionToken: token, ...options }));
}
function http(port: number, path = '/api/v1/health', headers: Record<string, string> = {}, method = 'GET', body?: string) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, agent: false,
      headers: { host: '127.0.0.1:3210', ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', chunk => { text += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function bootstrap(port: number) {
  const response = await http(port, '/api/v1/session', { 'x-localmind-bootstrap': '1', 'sec-fetch-site': 'same-origin' });
  expect(response.status).toBe(200);
  return JSON.parse(response.text).data.token as string;
}
function errorIs(response: Awaited<ReturnType<typeof http>>, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(() => parseContract(ErrorResponseSchema, JSON.parse(response.text))).not.toThrow();
  expect(JSON.parse(response.text).error.code).toBe(code);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['access-control-allow-origin']).toBeUndefined();
}

describe('T04 real HTTP security boundary', () => {
  it('bootstraps only same-origin GET and keeps the token in memory', async () => {
    const port = await server();
    expect(await bootstrap(port)).toBe(token);
    const response = await http(port, '/api/v1/session', { 'x-localmind-bootstrap': '1', 'sec-fetch-site': 'same-origin' });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    for (const headers of [{}, { 'x-localmind-bootstrap': '1' }, { 'sec-fetch-site': 'same-origin' }]) errorIs(await http(port, '/api/v1/session', headers), 403, 'LOCAL_ACCESS_DENIED');
    errorIs(await http(port, '/api/v1/session?callback=steal', { 'x-localmind-bootstrap': '1', 'sec-fetch-site': 'same-origin' }), 403, 'LOCAL_ACCESS_DENIED');
    expect((await http(port, '/api/v1/session', {}, 'HEAD')).status).toBe(401);
  });
  it.each(['evil.example', 'localhost:3210', '127.0.0.1:3210.evil', '127.0.0.1:5173', '[::1]:3210'])('rejects forged Host %s including forwarded authorization claims', async host => {
    const port = await server();
    errorIs(await http(port, '/api/v1/health', { ...auth, host, 'x-forwarded-host': '127.0.0.1:3210', 'x-forwarded-for': '127.0.0.1' }), 403, 'LOCAL_ACCESS_DENIED');
  });
  it.each(['null', 'https://evil.example', 'http://127.0.0.1:5173', 'http://127.0.0.1:3210/'])('rejects Origin %s', async origin => {
    const port = await server();
    errorIs(await http(port, '/api/v1/health', { ...auth, origin }), 403, 'LOCAL_ACCESS_DENIED');
    errorIs(await http(port, '/api/v1/session', { origin, 'sec-fetch-site': 'same-origin', 'x-localmind-bootstrap': '1' }), 403, 'LOCAL_ACCESS_DENIED');
  });
  it.each(['cross-site', 'same-site', 'none'])('rejects fetch metadata %s', async site => {
    const port = await server();
    errorIs(await http(port, '/api/v1/health', { ...auth, 'sec-fetch-site': site }), 403, 'LOCAL_ACCESS_DENIED');
  });
  it('requires tokens for reads, mutations and unknown API endpoints', async () => {
    const port = await server();
    for (const [path, method] of [['/api/v1/health', 'GET'], ['/api/v1/chats', 'POST'], ['/api/v1/unknown', 'GET']]) {
      errorIs(await http(port, path!, {}, method), 401, 'SESSION_REQUIRED');
      errorIs(await http(port, path!, { 'x-localmind-token': 'wrong' }, method), 401, 'SESSION_REQUIRED');
    }
    errorIs(await http(port, '/api/v1/health?token=' + token), 401, 'SESSION_REQUIRED');
    errorIs(await http(port, '/api/v1/unknown', auth), 404, 'NOT_FOUND');
  });
  it('rejects forms and preflight before a route runs', async () => {
    const port = await server();
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=test']) errorIs(await http(port, '/api/v1/chats', { ...auth, 'content-type': contentType }, 'POST', 'synthetic=secret'), 400, 'VALIDATION_ERROR');
    errorIs(await http(port, '/api/v1/session', { origin: 'https://evil.example', 'access-control-request-method': 'GET' }, 'OPTIONS'), 403, 'LOCAL_ACCESS_DENIED');
    errorIs(await http(port, '/api/v1/health', auth, 'OPTIONS'), 403, 'LOCAL_ACCESS_DENIED');
  });
  it('rejects encoded API aliases and traversal', async () => {
    const port = await server();
    for (const path of ['/%61pi/v1/session', '/api%2fv1/session', '/api/../api/v1/session', '/api%5cv1/session']) errorIs(await http(port, path, { 'x-localmind-bootstrap': '1', 'sec-fetch-site': 'same-origin' }), 403, 'LOCAL_ACCESS_DENIED');
  });
  it('keeps development access explicit and prevents enabling it under production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const port = await server({ development: true });
    expect((await http(port, '/api/v1/health', { ...auth, host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' })).status).toBe(200);
    errorIs(await http(port, '/api/v1/health', auth), 403, 'LOCAL_ACCESS_DENIED');
    vi.stubEnv('NODE_ENV', 'production');
    await expect(createApp({ development: true, serveWeb: false })).rejects.toThrow('disabled in production');
  });
  it('rotates random session tokens across application instances', async () => {
    const first = await listen(await createApp({ serveWeb: false }));
    const second = await listen(await createApp({ serveWeb: false }));
    const old = await bootstrap(first), next = await bootstrap(second);
    expect(old).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(next).not.toBe(old);
    errorIs(await http(second, '/api/v1/health', { 'x-localmind-token': old }), 401, 'SESSION_REQUIRED');
  });
});

describe('T04 limits, health, lifecycle and logs', () => {
  it('rejects unknown fields, coercion, malformed JSON and oversized bodies before business logic', async () => {
    let calls = 0;
    const port = await server({ routes: async app => {
      app.post('/api/v1/test-only', { schema: { body: TurnRequestSchema } }, async () => { calls++; return { ok: true }; });
      app.get('/api/v1/test-failure', async () => { throw new Error('synthetic-secret /private/hidden'); });
    } });
    const headers = { ...auth, 'content-type': 'application/json' };
    for (const body of ['{', JSON.stringify({ content: 'test', expectedVersion: '1' }), JSON.stringify({ content: 'test', expectedVersion: 1, role: 'system' })]) errorIs(await http(port, '/api/v1/test-only', headers, 'POST', body), 400, 'VALIDATION_ERROR');
    errorIs(await http(port, '/api/v1/test-only', headers, 'POST', JSON.stringify({ content: 'x'.repeat(33 * 1024), expectedVersion: 1 })), 413, 'PAYLOAD_TOO_LARGE');
    expect(calls).toBe(0);
    expect((await http(port, '/api/v1/test-only', headers, 'POST', JSON.stringify({ content: 'test', expectedVersion: 1 }))).status).toBe(200);
    expect(calls).toBe(1);
    const failure = await http(port, '/api/v1/test-failure', { ...auth, 'x-request-id': 'synthetic-secret' });
    errorIs(failure, 500, 'INTERNAL_ERROR'); expect(failure.text).not.toContain('synthetic-secret'); expect(failure.text).not.toContain('/private');
  });
  it('serves production files with CSP and security headers and denies invalid static hosts', async () => {
    const webRoot = join(root, 'web'); mkdirSync(webRoot); writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Synthetic</title>');
    writeFileSync(join(webRoot, '.secret'), 'synthetic-secret');
    const port = await server({ serveWeb: true, webRoot });
    const response = await http(port, '/');
    expect(response.status).toBe(200); expect(response.text).toContain('Synthetic');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    expect(response.headers['content-security-policy']).not.toContain('ws:');
    expect(response.headers['x-content-type-options']).toBe('nosniff'); expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect((await http(port, '/.secret')).text).not.toContain('synthetic-secret');
    errorIs(await http(port, '/', { host: 'evil.example' }), 403, 'LOCAL_ACCESS_DENIED');
  });
  it('opens private storage for real health checks and releases the lock on close', async () => {
    const dataDir = join(root, 'data');
    const runtime = await createLocalServer({ dataDir, serveWeb: false, modelProvider });
    expect(runtime.config.host).toBe('127.0.0.1'); expect(runtime.config.port).toBe(3210);
    const port = await listen(runtime.app);
    const session = await bootstrap(port);
    const response = await http(port, '/api/v1/health', { 'x-localmind-token': session });
    expect(response.status).toBe(200); expect(() => parseContract(HealthResponseSchema, JSON.parse(response.text))).not.toThrow();
    expect(JSON.parse(response.text).data).toMatchObject({ appStatus: 'setup', databaseStatus: 'ready', ollamaStatus: 'reachable', brokerState: 'idle' });
    expect(() => openStorage(dataDir)).toThrow();
    await runtime.app.close(); const reopened = openStorage(dataDir); stores.push(reopened);
    const logs = readFileSync(join(dataDir, 'localmind.log'), 'utf8');
    expect(logs).not.toContain(session); expect(logs).not.toContain('/api');
    expect(lstatSync(join(dataDir, 'localmind.log')).mode & 0o777).toBe(0o600);
  });
  it('cleans up storage after app initialization fails', async () => {
    const dataDir = join(root, 'data');
    await expect(createLocalServer({ dataDir, serveWeb: true, webRoot: 'relative-path', modelProvider })).rejects.toThrow();
    stores.push(openStorage(dataDir));
  });
  it('starts degraded when the provider is unavailable and releases storage on close', async () => {
    const dataDir = join(root, 'data');
    const discover = vi.fn(async () => { throw new ModelError('OLLAMA_UNAVAILABLE'); });
    const runtime = await createLocalServer({ dataDir, serveWeb: false, modelProvider: { discover } });
    expect(discover).toHaveBeenCalledTimes(1);
    const port = await listen(runtime.app);
    const session = await bootstrap(port);
    const response = await http(port, '/api/v1/health', { 'x-localmind-token': session });
    expect(response.status).toBe(200);
    const health = parseContract(HealthResponseSchema, JSON.parse(response.text));
    expect(health.data).toMatchObject({ appStatus: 'degraded', databaseStatus: 'ready', ollamaStatus: 'unavailable', brokerState: 'idle' });
    expect(() => openStorage(dataDir)).toThrow();
    await runtime.app.close();
    stores.push(openStorage(dataDir));
  });
  it('returns a safe 503 when the database becomes unavailable', async () => {
    const storage = openStorage(join(root, 'data')); stores.push(storage);
    const port = await server({ storage }); storage.close();
    errorIs(await http(port, '/api/v1/health', auth), 503, 'STORAGE_UNAVAILABLE');
  });
  it('does not dump request content when audit storage fails', async () => {
    const port = await server({ audit: () => { throw new Error('synthetic-path-secret'); } });
    await http(port, '/api/v1/health', auth);
    const response = await http(port, '/api/v1/health', auth);
    errorIs(response, 503, 'STORAGE_UNAVAILABLE'); expect(response.text).not.toContain('synthetic-path-secret');
  });
  it('rotates at 5 MiB with three private files and strips arbitrary logging fields', () => {
    const directory = join(root, 'logs'); mkdirSync(directory, { mode: 0o700 });
    const audit = createAuditWriter(directory);
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(directory, 'localmind.log'), 'x'.repeat(AUDIT_MAX_BYTES), { mode: 0o600 });
      audit({ requestId: randomUUID(), statusCode: 200, durationMs: 1, secret: token } as Parameters<typeof audit>[0]);
    }
    for (const suffix of ['', '.1', '.2']) {
      const path = join(directory, 'localmind.log' + suffix);
      expect(lstatSync(path).size).toBeLessThanOrEqual(AUDIT_MAX_BYTES);
      expect(lstatSync(path).mode & 0o777).toBe(0o600); expect(readFileSync(path, 'utf8')).not.toContain(token);
    }
    expect(() => lstatSync(join(directory, 'localmind.log.3'))).toThrow();
  });
});
