import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
vi.mock('@localmind/contracts', () => import('../../../../packages/contracts/src/index.js'));
import { ErrorResponseSchema, LIMITS, ModelsResponseSchema, parseContract, type BrokerState } from '../../../../packages/contracts/src/index.js';
import { createMetadataReader, createMetadataProvider, type MetadataReader, type MetadataPath } from '../../src/providers/ollama/metadata.js';
import { createModelRegistry } from '../../src/services/models.js';
import { createApp } from '../../src/app.js';
import { createLocalServer } from '../../src/lifecycle.js';
import { openStorage, type Storage } from '../../src/db/index.js';
import { modelProfiles, runs } from '../../src/db/schema.js';
import { createRepository } from '../../src/db/repository.js';
import { metadataFixtures, names } from './models-fixtures.js';

let root: string, mask: number;
let stores: Storage[], apps: FastifyInstance[], servers: Server[];
beforeEach(() => { mask = process.umask(0o077); root = mkdtempSync(join(realpathSync(tmpdir()), 'localmind-t05-')); stores = []; apps = []; servers = []; });
afterEach(async () => {
  for (const app of apps) await app.close();
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const store of stores) store.close();
  rmSync(root, { recursive: true, force: true }); process.umask(mask); vi.restoreAllMocks(); vi.unstubAllEnvs();
});
function setup() {
  const store = openStorage(join(root, 'data')); stores.push(store);
  const fixtures = metadataFixtures(); let offline = false, now = 1000, state: BrokerState = 'idle';
  const calls: MetadataPath[] = [];
  const reader: MetadataReader = async path => {
    calls.push(path); if (offline) throw new Error('synthetic-private-provider-error');
    return structuredClone(path === '/api/version' ? fixtures.version : path === '/api/tags' ? fixtures.tags : path === '/api/ps' ? fixtures.ps : fixtures.show);
  };
  const provider = createMetadataProvider(reader);
  const registry = createModelRegistry(store, provider, { clock: () => now, brokerState: () => state });
  return { store, fixtures, provider, registry, calls, offline: (value: boolean) => { offline = value; }, time: (value: number) => { now = value; }, state: (value: BrokerState) => { state = value; } };
}
async function network(handler: http.RequestListener) {
  const server = http.createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('TCP expected');
  const requests: http.RequestOptions[] = [];
  const send = ((options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
    requests.push(options);
    expect(options.hostname).toBe('127.0.0.1'); expect(options.port).toBe(11434);
    return http.request({ ...options, port: address.port }, callback);
  }) as typeof http.request;
  return { read: createMetadataReader(send), requests };
}
async function listen(app: FastifyInstance) {
  apps.push(app); await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); if (!address || typeof address === 'string') throw Error('TCP expected');
  return address.port;
}
const token = 't'.repeat(43);
function api(port: number, path: string, method = 'GET', body?: unknown, authenticated = true) {
  return new Promise<{ status: number; data: Record<string, unknown>; text: string }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/v1' + path, method, agent: false,
      headers: { host: '127.0.0.1:3210', origin: 'http://127.0.0.1:3210', 'sec-fetch-site': 'same-origin',
        ...(authenticated ? { 'x-localmind-token': token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, res => {
      let text = ''; res.on('data', chunk => { text += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(text), text }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe('T05 metadata transport and admission', () => {
  it('uses only fixed local metadata endpoints, bypasses proxies and parses residency without loading models', async () => {
    vi.stubEnv('HTTP_PROXY', 'http://invalid.example:9999'); vi.stubEnv('NODE_USE_ENV_PROXY', '1');
    const f = metadataFixtures(); f.ps.models = [{ name: names[0], digest: 'a'.repeat(64) }];
    const seen: string[] = [];
    const { read, requests } = await network((req, res) => {
      seen.push(req.method + ' ' + req.url);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/version' ? f.version : req.url === '/api/tags' ? f.tags : req.url === '/api/ps' ? f.ps : f.show));
    });
    const inventory = await createMetadataProvider(read).discover();
    expect(inventory.installed.every(m => m.eligible)).toBe(true); expect(inventory.resident).toEqual(f.ps.models);
    expect(seen.sort()).toEqual(['GET /api/ps', 'GET /api/tags', 'GET /api/version', 'POST /api/show', 'POST /api/show'].sort());
    expect(requests.every(req => req.agent !== http.globalAgent)).toBe(true);
    await expect(read('/api/pull' as MetadataPath)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(read('/api/show', 'http://evil.example')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(seen).toHaveLength(5);
  });
  it('rejects redirects without following their Location', async () => {
    let count = 0;
    const { read } = await network((_req, res) => { count++; res.writeHead(302, { location: 'https://invalid.example/private' }); res.end(); });
    await expect(read('/api/tags')).rejects.toMatchObject({ code: 'OLLAMA_UNAVAILABLE' }); expect(count).toBe(1);
  });
  it.each(['declared', 'chunked', 'invalid-json'] as const)('bounds or rejects %s responses', async kind => {
    const { read } = await network((_req, res) => {
      if (kind === 'declared') { res.writeHead(200, { 'content-length': LIMITS.metadataBytes + 1 }); res.end(); }
      else if (kind === 'chunked') res.end('x'.repeat(LIMITS.metadataBytes + 1));
      else res.end('{');
    });
    await expect(read('/api/tags')).rejects.toMatchObject({ code: 'OLLAMA_UNAVAILABLE' });
  });
  it('times out a silent provider within the configured discovery deadline', async () => {
    const { read } = await network(() => {});
    const start = Date.now();
    await expect(read('/api/version')).rejects.toMatchObject({ code: 'OLLAMA_UNAVAILABLE' });
    expect(Date.now() - start).toBeLessThan(LIMITS.discoveryMs + 1500);
  }, 10_000);
  it.each(['thinking', 'completion', 'gguf', 'architecture', 'size', 'remote-tag', 'remote-show', 'cloud-name'] as const)('marks %s metadata incompatible', async kind => {
    const s = setup();
    if (kind === 'thinking') s.fixtures.show.thinking.values = [true];
    if (kind === 'completion') s.fixtures.show.capabilities = ['thinking'];
    if (kind === 'gguf') s.fixtures.show.details.format = 'remote';
    if (kind === 'architecture') s.fixtures.show.model_info['general.architecture'] = '';
    if (kind === 'size') s.fixtures.tags.models[0]!.size = LIMITS.maxModelBytes + 1;
    if (kind === 'remote-tag') Object.assign(s.fixtures.tags.models[0]!, { remote_host: 'https://invalid.example' });
    if (kind === 'remote-show') Object.assign(s.fixtures.show, { remote_model: 'remote-model' });
    if (kind === 'cloud-name') s.fixtures.tags.models[0]!.name = 'qwen-cloud:2b' as typeof names[0];
    const response = await s.registry.refresh();
    expect(response.data.installed[0]?.eligible).toBe(false);
    expect(response.data.installed[0]?.reasonCode).toBe('MODEL_INCOMPATIBLE');
    expect(response.data.profiles[0].boundDigest).toBeNull();
  });
  it('treats malformed digests and duplicate inventory names as an outage, never a missing model', async () => {
    const s = setup(); await s.registry.refresh();
    s.fixtures.tags.models[0]!.digest = 'malformed';
    await expect(s.registry.refresh()).rejects.toMatchObject({ code: 'OLLAMA_UNAVAILABLE' });
    expect(s.registry.snapshot().data.profiles[0].availability).toBe('unreachable');
    s.fixtures.tags.models[0]!.digest = 'a'.repeat(64); s.fixtures.tags.models.push({ ...s.fixtures.tags.models[0]! });
    await expect(s.registry.refresh()).rejects.toMatchObject({ code: 'OLLAMA_UNAVAILABLE' });
  });
});

describe('T05 cache and transactional binding', () => {
  it('pins eligible seeds once, preserves exact tag names, and expires the display cache at 30 seconds', async () => {
    const s = setup(); const first = await s.registry.get();
    expect(first.data.profiles.map(p => p.availability)).toEqual(['ready', 'ready']);
    expect(first.data.profiles.map(p => p.version)).toEqual([2, 2]);
    expect(first.data.profiles.map(p => p.modelName)).toEqual([...names]);
    expect(() => parseContract(ModelsResponseSchema, first)).not.toThrow();
    const calls = s.calls.length; s.time(30_999); await s.registry.get(); expect(s.calls).toHaveLength(calls);
    s.time(31_000); const next = await s.registry.get(); expect(s.calls.length).toBeGreaterThan(calls);
    expect(next.data.profiles.map(p => p.version)).toEqual([2, 2]);
  });
  it.each([0, 1])('reports missing profile %s independently and pins it when it appears', async index => {
    const s = setup(); const removed = s.fixtures.tags.models.splice(index, 1)[0]!;
    const response = await s.registry.refresh(); expect(response.data.profiles[index]?.availability).toBe('missing');
    expect(response.data.profiles[1 - index]?.availability).toBe('ready');
    s.fixtures.tags.models.push(removed); expect((await s.registry.refresh()).data.profiles[index]?.availability).toBe('ready');
  });
  it('retains cache and bindings on outages, including startup without Ollama', async () => {
    const s = setup(); s.offline(true);
    expect((await s.registry.get()).data).toMatchObject({ stale: true, checkedAt: null, installed: [] });
    expect(s.registry.snapshot().data.profiles[0].availability).toBe('unreachable');
    s.offline(false); const good = await s.registry.refresh(); s.offline(true);
    await expect(s.registry.refresh()).rejects.toMatchObject({ code: 'OLLAMA_UNAVAILABLE' });
    const stale = await s.registry.get(); expect(stale.data.stale).toBe(true);
    expect(stale.data.installed).toEqual(good.data.installed);
    expect(stale.data.profiles[0].boundDigest).toBe(good.data.profiles[0].boundDigest);
    expect(stale.data.profiles[0].version).toBe(2);
  });
  it('requires explicit changed-digest binding and rejects stale versions/digests', async () => {
    const s = setup(); await s.registry.refresh(); s.fixtures.tags.models[0]!.digest = 'c'.repeat(64);
    expect((await s.registry.refresh()).data.profiles[0].availability).toBe('model_changed');
    const body = { modelName: names[0], expectedDigest: 'c'.repeat(64), expectedVersion: 2 };
    await expect(s.registry.bind('general', { ...body, expectedVersion: 1 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(s.registry.bind('general', { ...body, expectedDigest: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'MODEL_CHANGED' });
    expect(await s.registry.bind('general', body)).toMatchObject({ version: 3, availability: 'ready', boundDigest: 'c'.repeat(64) });
  });
  it('clears only the community mapping, keeps it cleared across refreshes, and permits explicit custom binding', async () => {
    const s = setup(); await s.registry.refresh();
    const clear = { modelName: null, expectedDigest: null, expectedVersion: 2 };
    await expect(s.registry.bind('general', clear)).rejects.toMatchObject({ code: 'MODEL_INCOMPATIBLE' });
    s.offline(true); expect(await s.registry.bind('abliterated', clear)).toMatchObject({ availability: 'unconfigured', version: 3 });
    s.offline(false); expect((await s.registry.refresh()).data.profiles[1].modelName).toBeNull();
    s.fixtures.tags.models.push({ name: 'custom/local:2b' as typeof names[0], digest: 'd'.repeat(64), size: 1_000_000_000 });
    expect(await s.registry.bind('abliterated', { modelName: 'custom/local:2b', expectedDigest: 'd'.repeat(64), expectedVersion: 3 })).toMatchObject({ modelName: 'custom/local:2b', version: 4 });
  });
  it.each(['running', 'draining', 'blocked'] as const)('blocks binding while broker is %s and defers seed writes', async state => {
    const s = setup(); s.state(state); const response = await s.registry.refresh();
    expect(response.data.profiles[0].boundDigest).toBeNull();
    await expect(s.registry.bind('abliterated', { modelName: null, expectedDigest: null, expectedVersion: 1 })).rejects.toMatchObject({ code: 'RUNTIME_BLOCKED' });
  });
  it('rejects missing or incompatible bindings and cannot substitute the official tag', async () => {
    const s = setup(); await s.registry.refresh();
    const body = { modelName: 'missing/local:2b', expectedDigest: 'a'.repeat(64), expectedVersion: 2 };
    await expect(s.registry.bind('abliterated', body)).rejects.toMatchObject({ code: 'MODEL_MISSING' });
    await expect(s.registry.bind('general', { ...body, modelName: names[1] })).rejects.toMatchObject({ code: 'MODEL_INCOMPATIBLE' });
    s.fixtures.show.thinking.values = [true];
    await expect(s.registry.bind('abliterated', { ...body, modelName: names[1], expectedDigest: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'MODEL_INCOMPATIBLE' });
    expect(s.store.db.select().from(modelProfiles).where(eq(modelProfiles.id, 'abliterated')).get()?.version).toBe(2);
  });
  it('rechecks runtime and profile version after asynchronous discovery', async () => {
    const s = setup(); await s.registry.refresh();
    let busy = false;
    const registry = createModelRegistry(s.store, { discover: async () => {
      const result = await s.provider.discover(); busy = true; return result;
    } }, { brokerState: () => busy ? 'draining' : 'idle' });
    const body = { modelName: names[0], expectedDigest: 'a'.repeat(64), expectedVersion: 2 };
    await expect(registry.bind('general', body)).rejects.toMatchObject({ code: 'RUNTIME_BLOCKED' });
    const racing = createModelRegistry(s.store, { discover: async () => {
      const result = await s.provider.discover();
      s.store.db.update(modelProfiles).set({ version: 3 }).where(eq(modelProfiles.id, 'general')).run(); return result;
    } });
    await expect(racing.bind('general', body)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it('blocks persisted active runs and preserves completed run snapshots after rebinding', async () => {
    const s = setup(); await s.registry.refresh();
    const repo = createRepository(s.store); const chat = repo.createChat();
    const { run } = await repo.acceptTurn({ chatId: chat.id, idempotencyKey: randomUUID(), content: 'Synthetic', expectedVersion: 1,
      profileId: 'general', profileVersion: 2, modelName: names[0], modelDigest: 'a'.repeat(64),
      options: { numCtx: 4096, numPredict: 512, temperature: 0.7, think: false }, inputEstimate: 100, omittedMessageCount: 0, includedMessageIds: [] });
    await expect(s.registry.bind('abliterated', { modelName: null, expectedDigest: null, expectedVersion: 2 })).rejects.toMatchObject({ code: 'RUNTIME_BLOCKED' });
    repo.finish(run.id, 'preparing', { status: 'completed', content: 'Synthetic answer', finishReason: 'stop', errorCode: null, terminationReason: null, metrics: { promptTokens: null, generatedTokens: null, loadMs: null, totalMs: null, evalMs: null } });
    s.fixtures.tags.models[0]!.digest = 'c'.repeat(64);
    await s.registry.bind('general', { modelName: names[0], expectedDigest: 'c'.repeat(64), expectedVersion: 2 });
    expect(s.store.db.select().from(runs).get()?.modelDigest).toBe('a'.repeat(64));
  });
});

describe('T05 authenticated routes and logging regression', () => {
  it('serves contracts, rejects injected fields, maps safe errors, and reflects provider health', async () => {
    const s = setup(); await s.registry.refresh();
    const port = await listen(await createApp({ serveWeb: false, storage: s.store, models: s.registry, sessionToken: token }));
    for (const [path, method, body] of [['/models', 'GET', undefined], ['/models/refresh', 'POST', {}], ['/model-profiles/general', 'PATCH', {}]] as const) {
      expect((await api(port, path, method, body, false)).status).toBe(401);
    }
    const response = await api(port, '/models'); expect(response.status).toBe(200);
    expect(() => parseContract(ModelsResponseSchema, response.data)).not.toThrow();
    const refreshed = await api(port, '/models/refresh', 'POST', {});
    expect(refreshed.status).toBe(200);
    expect(() => parseContract(ModelsResponseSchema, refreshed.data)).not.toThrow();
    expect((await api(port, '/models/refresh', 'POST', { url: 'https://evil.example' })).status).toBe(400);
    expect((await api(port, '/model-profiles/general', 'PATCH', { modelName: names[0], expectedDigest: 'a'.repeat(64), expectedVersion: 2, tools: [] })).status).toBe(400);
    expect((await api(port, '/model-profiles/unknown', 'PATCH', {})).status).toBe(400);
    expect((await api(port, '/model-profiles/abliterated', 'PATCH', { modelName: null, expectedDigest: null, expectedVersion: 2 })).status).toBe(200);
    s.offline(true); const failure = await api(port, '/models/refresh', 'POST', {});
    expect(failure.status).toBe(503); expect(failure.text).not.toContain('synthetic-private');
    expect(() => parseContract(ErrorResponseSchema, failure.data)).not.toThrow();
    expect((await api(port, '/models')).status).toBe(200);
    expect((await api(port, '/health')).data).toMatchObject({ data: { ollamaStatus: 'unavailable', appStatus: 'degraded' } });
  });
  it.each(['/models', '/models/refresh'])('rejects invalid response data at serialization for %s', async path => {
    const s = setup();
    const invalid = await s.registry.refresh();
    invalid.data.installed[0]!.digest = 'synthetic-private-invalid-digest';
    vi.spyOn(s.registry, path === '/models' ? 'get' : 'refresh').mockResolvedValue(invalid);
    const port = await listen(await createApp({ serveWeb: false, storage: s.store, models: s.registry, sessionToken: token }));
    const response = await api(port, path, path === '/models' ? 'GET' : 'POST', path === '/models' ? undefined : {});
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(() => parseContract(ErrorResponseSchema, response.data)).not.toThrow();
    expect(response.text).not.toContain('synthetic-private-invalid-digest');
  });
  it('refreshes on startup, remains available during an outage, and emits no deprecated logging option warning', async () => {
    const warnings = vi.spyOn(process, 'emitWarning');
    const fixture = setup(); fixture.offline(true);
    const runtime = await createLocalServer({ dataDir: join(root, 'startup'), serveWeb: false, modelProvider: fixture.provider });
    await listen(runtime.app);
    expect(fixture.calls).toContain('/api/version');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(warnings.mock.calls.some(args => args.some(arg => typeof arg === 'string' && (arg.includes('FSTDEP023') || arg.includes('disableRequestLogging option is deprecated'))))).toBe(false);
  });
});
