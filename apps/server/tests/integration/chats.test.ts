import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
vi.mock('@localmind/contracts', () => import('../../../../packages/contracts/src/index.js'));
import { ChatResponseSchema, ChatsResponseSchema, MessagesResponseSchema, ErrorResponseSchema, parseContract } from '../../../../packages/contracts/src/index.js';
import { openStorage, type Storage } from '../../src/db/index.js';
import { createRepository } from '../../src/db/repository.js';
import { chats, messages, modelProfiles, runs } from '../../src/db/schema.js';
import { createChatService, type ChatRuntime } from '../../src/services/chats.js';
import { createModelRegistry } from '../../src/services/models.js';
import { createApp } from '../../src/app.js';

let root: string, mask: number, stores: Storage[], apps: FastifyInstance[];
const token = 't'.repeat(43);
const headers = { host: '127.0.0.1:3210', origin: 'http://127.0.0.1:3210', 'sec-fetch-site': 'same-origin', 'x-localmind-token': token };
const names = ['qwen3.5:2b-q4_K_M', 'huihui_ai/qwen3.5-abliterated:2B'];
const metrics = { promptTokens: null, generatedTokens: null, loadMs: null, totalMs: null, evalMs: null };
beforeEach(() => { mask = process.umask(0o077); root = mkdtempSync(join(realpathSync(tmpdir()), 'localmind-t07-')); stores = []; apps = []; });
afterEach(async () => { for (const app of apps) await app.close(); for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); process.umask(mask); vi.restoreAllMocks(); });
async function setup() {
  const store = openStorage(join(root, 'data')); stores.push(store);
  const inventory = { version: '0.40.3', resident: [], installed: names.map((name, i) => ({ name, digest: (i ? 'b' : 'a').repeat(64), sizeBytes: 1000, quantization: 'Q4_K_M', capabilities: ['completion'], eligible: true, reasonCode: null })) };
  const discover = vi.fn(async () => structuredClone(inventory));
  const registry = createModelRegistry(store, { discover }); await registry.refresh(); discover.mockClear();
  let owned: ReturnType<ChatRuntime> = null;
  const runtime: ChatRuntime = () => owned;
  const service = createChatService(store, registry, { clock: () => 1000, runtime });
  const app = await createApp({ serveWeb: false, storage: store, models: registry, chatRuntime: runtime, sessionToken: token }); apps.push(app);
  return { store, registry, service, app, discover, inventory, runtime, own: (value: typeof owned) => { owned = value; } };
}
async function turn(store: Storage, id: string, content = 'Synthetic prompt', finish = true) {
  const chat = store.db.select().from(chats).where(eq(chats.id, id)).get()!;
  const profile = store.db.select().from(modelProfiles).where(eq(modelProfiles.id, chat.profileId as 'general' | 'abliterated')).get()!;
  const repo = createRepository(store, () => 1000);
  const accepted = await repo.acceptTurn({ chatId: id, expectedVersion: chat.version, idempotencyKey: randomUUID(), content,
    profileId: profile.id, profileVersion: profile.version, modelName: profile.modelName!, modelDigest: profile.boundDigest!,
    options: { numCtx: 4096, numPredict: 512, temperature: 0.7, think: false }, inputEstimate: 10, omittedMessageCount: 0, includedMessageIds: [] });
  if (finish) repo.finish(accepted.run.id, 'preparing', { status: 'completed', content: 'Synthetic answer', finishReason: 'stop', errorCode: null, terminationReason: null, metrics });
  return accepted;
}
function request(app: FastifyInstance, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object) {
  return app.inject({ method, url: '/api/v1' + path, headers, ...(payload === undefined ? {} : { payload }) });
}
function error(response: Awaited<ReturnType<typeof request>>, status: number, code: string) {
  expect(response.statusCode).toBe(status); expect(parseContract(ErrorResponseSchema, response.json()).error.code).toBe(code);
}

describe('T07 persistence and pagination', () => {
  it('creates, renames, reopens and deletes through authenticated contracts', async () => {
    const s = await setup();
    const created = await request(s.app, 'POST', '/chats', {}); expect(created.statusCode).toBe(201);
    const chat = parseContract(ChatResponseSchema, created.json()).data;
    expect(chat).toMatchObject({ profileId: 'general', title: 'New chat', version: 1, activeRunId: null });
    const updated = await request(s.app, 'PATCH', '/chats/' + chat.id, { expectedVersion: 1, title: 'Manual title' });
    expect(parseContract(ChatResponseSchema, updated.json()).data).toMatchObject({ title: 'Manual title', version: 2 });
    expect(parseContract(ChatResponseSchema, (await request(s.app, 'GET', '/chats/' + chat.id)).json()).data.title).toBe('Manual title');
    error(await request(s.app, 'DELETE', '/chats/' + chat.id, { expectedVersion: 1 }), 409, 'VERSION_CONFLICT');
    const deleted = await request(s.app, 'DELETE', '/chats/' + chat.id, { expectedVersion: 2 }); expect(deleted.statusCode).toBe(204); expect(deleted.body).toBe('');
    error(await request(s.app, 'GET', '/chats/' + chat.id), 404, 'NOT_FOUND');
    expect(s.discover).not.toHaveBeenCalled();
  });
  it('persists completed messages and selected profile after server/storage restart', async () => {
    const s = await setup(); const chat = s.service.create({});
    await s.service.update(chat.id, { expectedVersion: 1, profileId: 'abliterated' }); await turn(s.store, chat.id);
    await s.app.close(); s.store.close();
    const reopened = openStorage(join(root, 'data')); stores.push(reopened);
    const app = await createApp({ storage: reopened, serveWeb: false, sessionToken: token }); apps.push(app);
    const saved = parseContract(ChatResponseSchema, (await request(app, 'GET', '/chats/' + chat.id)).json()).data;
    expect(saved.profileId).toBe('abliterated');
    const history = parseContract(MessagesResponseSchema, (await request(app, 'GET', '/chats/' + chat.id + '/messages')).json()).data.items;
    expect(history.map(m => m.content)).toEqual(['Synthetic prompt', 'Synthetic answer']); expect(history[1]?.modelName).toBe(names[1]);
  });
  it('uses a stable ID tie-break across bounded chat pages', async () => {
    const s = await setup(); const ids = Array.from({ length: 5 }, () => s.service.create({}).id).sort().reverse();
    let cursor: string | undefined; const found: string[] = [];
    do {
      const page = parseContract(ChatsResponseSchema, (await request(s.app, 'GET', '/chats?limit=2' + (cursor ? '&cursor=' + cursor : ''))).json()).data;
      expect(page.items.length).toBeLessThanOrEqual(2); found.push(...page.items.map(c => c.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toEqual(ids);
    expect(s.service.list({ limit: 100 }).nextCursor).toBeNull();
  });
  it('loads latest and older messages by sequence, preserving run snapshots', async () => {
    const s = await setup(); const chat = s.service.create({}); for (let i = 0; i < 3; i++) await turn(s.store, chat.id, 'Prompt ' + i);
    const latest = parseContract(MessagesResponseSchema, (await request(s.app, 'GET', `/chats/${chat.id}/messages?limit=3`)).json()).data;
    expect(latest.items.map(m => m.seq)).toEqual([4, 5, 6]); expect(latest.nextBeforeSeq).toBe(4);
    const older = s.service.messages(chat.id, { limit: 3, beforeSeq: 4 }); expect(older.items.map(m => m.seq)).toEqual([1, 2, 3]); expect(older.nextBeforeSeq).toBeNull();
    s.store.db.update(modelProfiles).set({ boundDigest: 'c'.repeat(64) }).where(eq(modelProfiles.id, 'general')).run();
    expect(s.service.messages(chat.id).items[1]).toMatchObject({ modelDigest: 'a'.repeat(64), profileId: 'general' });
    expect(s.service.messages(chat.id, { beforeSeq: 1 }).items).toEqual([]);
    error(await request(s.app, 'GET', `/chats/${randomUUID()}/messages`), 404, 'NOT_FOUND');
  });
  it('derives a Unicode title once, preserves manual titles, and makes no title model call', async () => {
    const s = await setup(); const chat = s.service.create({});
    await turn(s.store, chat.id, '\n\t\n' + '🌿'.repeat(65) + '\nSecond line');
    expect(s.service.get(chat.id).title).toBe('🌿'.repeat(60));
    await s.service.update(chat.id, { expectedVersion: 2, title: 'My title' }); await turn(s.store, chat.id, 'Replacement');
    expect(s.service.get(chat.id).title).toBe('My title');
    const manual = s.service.create({ title: 'Created title' }); await turn(s.store, manual.id); expect(s.service.get(manual.id).title).toBe('Created title');
    expect(s.discover).not.toHaveBeenCalled();
  });
  it('cascades only the deleted chat and retains profiles', async () => {
    const s = await setup(); const first = s.service.create({}), second = s.service.create({}); await turn(s.store, first.id); await turn(s.store, second.id);
    s.service.remove(first.id, { expectedVersion: 2 });
    expect(s.store.db.select().from(messages).all().map(m => m.chatId)).toEqual([second.id, second.id]);
    expect(s.store.db.select().from(runs).all()).toHaveLength(1); expect(s.store.db.select().from(modelProfiles).all()).toHaveLength(2);
    expect(s.store.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('T07 mutation guards and errors', () => {
  it.each(['persisted', 'draining', 'blocked'] as const)('protects chats with %s ownership, including terminal runs', async state => {
    const s = await setup(); const chat = s.service.create({}); const accepted = await turn(s.store, chat.id, 'Prompt', state !== 'persisted');
    if (state !== 'persisted') s.own({ chatId: chat.id, runId: accepted.run.id, state });
    expect(s.service.get(chat.id).activeRunId).toBe(accepted.run.id);
    for (const body of [{ expectedVersion: 2, title: 'No' }, { expectedVersion: 2, profileId: 'abliterated' }]) error(await request(s.app, 'PATCH', '/chats/' + chat.id, body), 409, 'CHAT_ACTIVE');
    error(await request(s.app, 'DELETE', '/chats/' + chat.id, { expectedVersion: 2 }), 409, 'CHAT_ACTIVE');
    const other = s.service.create({}); expect((await s.service.update(other.id, { expectedVersion: 1, title: 'Allowed' })).version).toBe(2);
    expect(s.discover).not.toHaveBeenCalled();
  });
  it('permits creation during provider outages but requires a ready profile to switch', async () => {
    const s = await setup(); s.discover.mockRejectedValueOnce(Error('private-provider'));
    const chat = s.service.create({});
    error(await request(s.app, 'PATCH', '/chats/' + chat.id, { expectedVersion: 1, profileId: 'abliterated' }), 503, 'OLLAMA_UNAVAILABLE');
    s.inventory.installed.pop(); error(await request(s.app, 'PATCH', '/chats/' + chat.id, { expectedVersion: 1, profileId: 'abliterated' }), 422, 'MODEL_MISSING');
    expect(s.service.get(chat.id).version).toBe(1);
  });
  it.each(['version', 'binding', 'activity'] as const)('rechecks %s after asynchronous profile discovery', async race => {
    const s = await setup(); const chat = s.service.create({}); const refresh = s.registry.refresh;
    vi.spyOn(s.registry, 'refresh').mockImplementationOnce(async pin => {
      const inventory = await refresh(pin);
      if (race === 'version') await s.service.update(chat.id, { expectedVersion: 1, title: 'Another tab' });
      if (race === 'binding') s.store.db.update(modelProfiles).set({ version: 99 }).where(eq(modelProfiles.id, 'abliterated')).run();
      if (race === 'activity') s.own({ state: 'draining', chatId: chat.id, runId: randomUUID() });
      return inventory;
    });
    error(await request(s.app, 'PATCH', '/chats/' + chat.id, { expectedVersion: 1, profileId: 'abliterated' }), 409, race === 'version' ? 'VERSION_CONFLICT' : race === 'binding' ? 'MODEL_CHANGED' : 'CHAT_ACTIVE');
    expect(s.service.get(chat.id).profileId).toBe('general');
  });
  it('rejects hostile paths, duplicate/invalid queries and malformed mutation bodies', async () => {
    const s = await setup(); const chat = s.service.create({});
    for (const query of ['limit=0', 'limit=101', 'limit=1&limit=2', 'limit=1.0', 'limit=1e2', 'limit=9007199254740992', 'extra=1', 'cursor=bad', 'cursor=x&cursor=y']) error(await request(s.app, 'GET', '/chats?' + query), 400, 'VALIDATION_ERROR');
    for (const query of ['beforeSeq=0', 'beforeSeq=1&beforeSeq=2', 'beforeSeq=-1']) error(await request(s.app, 'GET', `/chats/${chat.id}/messages?${query}`), 400, 'VALIDATION_ERROR');
    for (const cursor of [Buffer.from('[1000,"invalid-id"]').toString('base64url'), Buffer.from('[1000,"' + chat.id + '",1]').toString('base64url')]) error(await request(s.app, 'GET', '/chats?cursor=' + cursor), 400, 'VALIDATION_ERROR');
    for (const body of [{ expectedVersion: 1 }, { expectedVersion: '1', title: 'x' }, { expectedVersion: 1, title: ' ' }, { expectedVersion: 1, title: 'x', role: 'system' }]) error(await request(s.app, 'PATCH', '/chats/' + chat.id, body), 400, 'VALIDATION_ERROR');
    error(await request(s.app, 'GET', '/chats/not-a-uuid'), 400, 'VALIDATION_ERROR');
  });
  it('requires authentication for every chat route and hides storage failures', async () => {
    const s = await setup(); const chat = s.service.create({});
    for (const [method, path] of [['POST', '/chats'], ['GET', '/chats'], ['GET', '/chats/' + chat.id], ['PATCH', '/chats/' + chat.id], ['DELETE', '/chats/' + chat.id], ['GET', `/chats/${chat.id}/messages`]] as const) {
      const response = await s.app.inject({ method, url: '/api/v1' + path, headers: { host: headers.host } }); error(response, 401, 'SESSION_REQUIRED');
    }
    s.store.close(); const response = await request(s.app, 'GET', '/chats'); error(response, 503, 'STORAGE_UNAVAILABLE'); expect(response.body).not.toContain(root);
  });
});
