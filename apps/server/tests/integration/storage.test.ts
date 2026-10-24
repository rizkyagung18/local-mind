import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import Database from 'better-sqlite3';

vi.mock('@localmind/contracts', () => import('../../../../packages/contracts/src/index.js'));
import { openStorage, type Storage } from '../../src/db/index.js';
import { createRepository } from '../../src/db/repository.js';
import { chats, messages, modelProfiles, runs } from '../../src/db/schema.js';
import { preparePrivateDirectory } from '../../src/storage/private-directory.js';

let root: string;
let stores: Storage[];
let children: ChildProcess[];
let oldMask: number;
const metrics = { promptTokens: null, generatedTokens: null, loadMs: null, totalMs: null, evalMs: null };
const completed = (content = 'Synthetic answer') => ({ status: 'completed' as const, content, finishReason: 'stop' as const, errorCode: null, terminationReason: null, metrics });

beforeEach(() => {
  oldMask = process.umask(0o077);
  root = mkdtempSync(join(realpathSync(tmpdir()), 'localmind-t03-'));
  stores = []; children = [];
});
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }
  for (const storage of stores) storage.close();
  rmSync(root, { recursive: true, force: true });
  process.umask(oldMask);
});
function open(name = 'data') {
  const store = openStorage(join(root, name)); stores.push(store); return store;
}
function setup(clock: () => number = Date.now) {
  const store = open();
  store.db.update(modelProfiles).set({ boundDigest: 'a'.repeat(64) }).where(eq(modelProfiles.id, 'general')).run();
  const repo = createRepository(store, clock);
  const chat = repo.createChat();
  const input = {
    chatId: chat.id, idempotencyKey: randomUUID(), content: 'Synthetic prompt', expectedVersion: 1,
    profileId: 'general' as const, profileVersion: 1, modelName: 'qwen3.5:2b-q4_K_M', modelDigest: 'a'.repeat(64),
    options: { numCtx: 4096 as const, numPredict: 512 as const, temperature: 0.7 as const, think: false as const },
    inputEstimate: 200, omittedMessageCount: 0, includedMessageIds: [],
  };
  return { store, repo, chat, input };
}
function child(directory: string, mode: 'hold' | 'probe') {
  const process = fork(fileURLToPath(new URL('./storage-child.mjs', import.meta.url)), [directory, mode], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.push(process);
  let stderr = '';
  process.stderr?.on('data', chunk => { stderr += String(chunk); });
  const ready = new Promise<{ code: string }>((resolve, reject) => {
    process.once('message', message => resolve(message as { code: string }));
    process.once('error', reject);
    process.once('exit', () => reject(new Error('Child exited before message: ' + stderr)));
  });
  return { process, ready };
}

describe('T03 private storage and lifecycle', () => {
  it('migrates and seeds only two permanent profiles with private WAL/SHM and required pragmas', () => {
    const store = open();
    expect(store.db.select().from(modelProfiles).all().map(row => row.id).sort()).toEqual(['abliterated', 'general']);
    expect(store.db.select().from(modelProfiles).all().every(row => row.boundDigest === null)).toBe(true);
    expect(store.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(store.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(store.sqlite.pragma('synchronous', { simple: true })).toBe(2);
    expect(store.sqlite.pragma('busy_timeout', { simple: true })).toBe(1000);
    expect(lstatSync(join(root, 'data')).mode & 0o777).toBe(0o700);
    for (const path of [store.path, store.path + '-wal', store.path + '-shm', join(root, 'data/localmind.lock.sqlite')]) expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(() => store.sqlite.exec("DELETE FROM model_profiles WHERE id='general'")).toThrow();
    expect(() => store.sqlite.exec("UPDATE model_profiles SET id='other' WHERE id='general'")).toThrow();
    store.close();
    const reopened = open();
    expect(reopened.db.select().from(modelProfiles).all()).toHaveLength(2);
    expect(reopened.sqlite.prepare('SELECT * FROM __drizzle_migrations').all()).toHaveLength(1);
  });
  it('rejects a second process while the first holds the directory lock', async () => {
    open();
    expect(await child(join(root, 'data'), 'probe').ready).toEqual({ code: 'DATA_DIRECTORY_LOCKED' });
  }, 10_000);
  it('recovers lock ownership after the owner is killed without deleting lock state', async () => {
    const holder = child(join(root, 'data'), 'hold');
    expect(await holder.ready).toEqual({ code: 'OPEN' });
    const exited = once(holder.process, 'exit'); holder.process.kill('SIGKILL'); await exited;
    expect(await child(join(root, 'data'), 'probe').ready).toEqual({ code: 'OPEN' });
  }, 10_000);
  it('rejects symlink ancestors and unsafe directory modes', () => {
    mkdirSync(join(root, 'target'), { mode: 0o700 });
    symlinkSync(join(root, 'target'), join(root, 'alias'));
    expect(() => openStorage(join(root, 'alias/data'))).toThrow();
    chmodSync(join(root, 'target'), 0o755);
    expect(() => openStorage(join(root, 'target'))).toThrow();
    chmodSync(join(root, 'target'), 0o777);
    expect(() => openStorage(join(root, 'target/data'))).toThrow();
  });
  it.each(['symlink', 'hardlink', 'public', 'sidecar'] as const)('rejects unsafe existing database %s without changing the target', kind => {
    const dir = preparePrivateDirectory(join(root, 'data'));
    const target = join(root, 'original'); writeFileSync(target, 'preserve', { mode: 0o600 });
    const path = join(dir, 'localmind.sqlite');
    if (kind === 'symlink') symlinkSync(target, path);
    if (kind === 'hardlink') linkSync(target, path);
    if (kind === 'public') { writeFileSync(path, 'preserve'); chmodSync(path, 0o644); }
    if (kind === 'sidecar') symlinkSync(target, path + '-wal');
    expect(() => openStorage(dir)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('preserve');
  });
  it('rejects known repository, synced, network, and traversal paths before creating files', () => {
    for (const path of [fileURLToPath(new URL('../../src/data', import.meta.url)), '/Volumes/share/LocalMind', '/Network/share/LocalMind', join(root, '..', 'unused') + '/../bad']) expect(() => preparePrivateDirectory(path)).toThrow();
    const home = process.env.HOME!;
    for (const suffix of ['Dropbox/LocalMind', 'Library/CloudStorage/provider/LocalMind', 'Library/Mobile Documents/LocalMind']) expect(() => preparePrivateDirectory(join(home, suffix))).toThrow();
  });
  it('preserves corrupt databases and releases the lock on open failure', () => {
    const dir = preparePrivateDirectory(join(root, 'data'));
    const path = join(dir, 'localmind.sqlite'); writeFileSync(path, 'synthetic corrupt bytes', { mode: 0o600 });
    expect(() => openStorage(dir)).toThrow(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }));
    expect(readFileSync(path, 'utf8')).toBe('synthetic corrupt bytes');
    rmSync(path); expect(open().db.select().from(modelProfiles).all()).toHaveLength(2);
  });
  it('refuses unknown migration history while preserving existing user rows', () => {
    const { store, chat } = setup();
    store.sqlite.prepare('UPDATE __drizzle_migrations SET hash=?').run('unknown');
    store.close();
    expect(() => open()).toThrow(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }));
    const inspection = new Database(store.path, { readonly: true });
    try { expect(inspection.prepare('SELECT id FROM chats').get()).toEqual({ id: chat.id }); } finally { inspection.close(); }
  });
  it('rolls back a failed migration and preserves preexisting tables', () => {
    const dir = preparePrivateDirectory(join(root, 'data'));
    const raw = new Database(join(dir, 'localmind.sqlite'));
    raw.exec("CREATE TABLE messages (id TEXT); INSERT INTO messages VALUES ('preserve');"); raw.close();
    expect(() => openStorage(dir)).toThrow();
    const inspection = new Database(join(dir, 'localmind.sqlite'));
    try {
      expect(inspection.prepare('SELECT * FROM messages').get()).toEqual({ id: 'preserve' });
      expect(inspection.prepare("SELECT name FROM sqlite_master WHERE name='model_profiles'").get()).toBeUndefined();
    } finally { inspection.close(); }
  });
});

describe('T03 transactional repositories', () => {
  it('atomically accepts a turn, preserves exact text, derives title and stores immutable snapshots', async () => {
    const { store, repo, input } = setup();
    const accepted = await repo.acceptTurn({ ...input, content: '\n  First synthetic line  \nrest' });
    const savedChat = store.db.select().from(chats).get()!;
    expect(savedChat).toMatchObject({ version: 2, nextMessageSeq: 3, title: 'First synthetic line', titleSource: 'derived' });
    expect(store.db.select().from(messages).all().map(m => [m.seq, m.role, m.status])).toEqual([[1, 'user', 'completed'], [2, 'assistant', 'pending']]);
    expect(store.db.select().from(messages).all()[0]?.content).toBe('\n  First synthetic line  \nrest');
    expect(store.db.select().from(runs).get()).toMatchObject({ id: accepted.run.id, modelDigest: input.modelDigest, options: input.options });
    expect(() => store.sqlite.exec("UPDATE runs SET model_name='changed'")).toThrow();
    expect(() => store.sqlite.exec("UPDATE messages SET content='changed' WHERE role='user'")).toThrow();
  });
  it('preserves manually entered titles and rolls back all writes when acceptance fails', async () => {
    const { store, repo, input } = setup();
    const manual = repo.createChat({ title: 'Manual title' });
    store.sqlite.exec("CREATE TRIGGER fail_accept BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
    await expect(repo.acceptTurn({ ...input, chatId: manual.id })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(store.db.select().from(messages).all()).toHaveLength(0);
    expect(store.db.select().from(chats).where(eq(chats.id, manual.id)).get()).toMatchObject({ version: 1, nextMessageSeq: 1 });
    store.sqlite.exec('DROP TRIGGER fail_accept');
    await repo.acceptTurn({ ...input, chatId: manual.id });
    expect(store.db.select().from(chats).where(eq(chats.id, manual.id)).get()?.title).toBe('Manual title');
  });
  it('detects duplicate keys before stale version or busy checks and keeps a single accepted turn', async () => {
    const { store, repo, input } = setup();
    const accepted = await repo.acceptTurn(input);
    await expect(repo.acceptTurn(input)).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST', existing: { runId: accepted.run.id } });
    await expect(repo.acceptTurn({ ...input, content: 'changed' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(store.db.select().from(messages).all()).toHaveLength(2);
  });
  it('rejects stale versions, changed bindings and a second globally active run', async () => {
    const { repo, input } = setup();
    await expect(repo.acceptTurn({ ...input, expectedVersion: 2 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(repo.acceptTurn({ ...input, modelDigest: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'MODEL_CHANGED' });
    await repo.acceptTurn(input);
    const other = repo.createChat();
    await expect(repo.acceptTurn({ ...input, chatId: other.id, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'GENERATION_BUSY' });
  });
  it('enforces FK, sequence, role/chat pairing, idempotency, and global-active constraints in real SQLite', async () => {
    const { store, repo, input } = setup();
    await repo.acceptTurn(input);
    const run = store.db.select().from(runs).get()!;
    const user = store.db.select().from(messages).where(eq(messages.id, run.userMessageId)).get()!;
    expect(() => store.db.insert(messages).values({ ...user, id: randomUUID(), chatId: randomUUID() }).run()).toThrow();
    expect(() => store.db.insert(messages).values({ ...user, id: randomUUID() }).run()).toThrow();
    const other = repo.createChat();
    const otherUser = randomUUID(), otherAssistant = randomUUID();
    store.db.insert(messages).values([
      { ...user, id: otherUser, chatId: other.id, seq: 1 },
      { ...user, id: otherAssistant, chatId: other.id, seq: 2, role: 'assistant', status: 'pending', content: '' },
    ]).run();
    const second = { ...run, id: randomUUID(), chatId: other.id, userMessageId: otherUser, assistantMessageId: otherAssistant, idempotencyKey: randomUUID() };
    expect(() => store.db.insert(runs).values(second).run()).toThrow(/one_active_run/);
    repo.finish(run.id, 'preparing', completed());
    expect(() => store.db.insert(runs).values({ ...second, chatId: input.chatId }).run()).toThrow(/message pair/);
    expect(() => store.db.insert(runs).values({ ...second, userMessageId: otherAssistant, assistantMessageId: otherUser }).run()).toThrow(/message pair/);
    store.db.insert(runs).values(second).run();
    expect(() => store.sqlite.prepare('UPDATE runs SET status=? WHERE id=?').run('unknown', second.id)).toThrow();
    expect(() => store.db.insert(runs).values({ ...second, id: randomUUID() }).run()).toThrow();
  });
  it('checkpoints on time or byte threshold, bounds UTF-8 text and cannot rewind persisted output', async () => {
    let now = 1000;
    const { store, repo, input } = setup(() => now);
    const { run } = await repo.acceptTurn(input);
    now = 1100; expect(repo.checkpoint(run.id, 'a')).toBe(false);
    expect(store.db.select().from(runs).get()).toMatchObject({ status: 'streaming', firstContentAt: 1100 });
    now = 1499; expect(repo.checkpoint(run.id, 'abc')).toBe(false);
    now = 1500; expect(repo.checkpoint(run.id, 'abc')).toBe(true);
    now = 1501; expect(repo.checkpoint(run.id, 'abc' + '🌿'.repeat(1024))).toBe(true);
    expect(() => repo.checkpoint(run.id, 'rewind')).toThrow();
    expect(() => repo.checkpoint(run.id, '🌿'.repeat(16385))).toThrow(expect.objectContaining({ code: 'OUTPUT_TOO_LARGE' }));
    expect(store.db.select().from(chats).get()?.version).toBe(2);
  });
  it.each(['\ud800', '\udc00'])('rejects malformed UTF-16 output without changing the run (%j)', async content => {
    const { store, repo, input } = setup();
    const { run } = await repo.acceptTurn(input);
    expect(() => repo.checkpoint(run.id, content)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => repo.finish(run.id, 'preparing', completed(content))).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(store.db.select().from(runs).get()).toMatchObject({ status: 'preparing', firstContentAt: null });
  });
  it('commits terminal state and partial answer atomically, with compare-and-set protection', async () => {
    const { store, repo, input } = setup();
    const { run } = await repo.acceptTurn(input);
    expect(repo.finish(run.id, 'streaming', completed())).toBe(false);
    expect(repo.finish(run.id, 'preparing', { ...completed('partial'), status: 'cancelled', finishReason: null, terminationReason: 'user_stop' })).toBe(true);
    expect(repo.finish(run.id, 'preparing', completed('different'))).toBe(false);
    expect(repo.checkpoint(run.id, 'late delta')).toBe(false);
    expect(store.db.select().from(messages).where(eq(messages.id, run.assistantMessageId)).get()).toMatchObject({ content: 'partial', status: 'cancelled' });
    expect(() => store.sqlite.exec("UPDATE runs SET status='streaming',ended_at=NULL")).toThrow();
    await expect(repo.acceptTurn(input)).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST' });
  });
  it('rolls back the terminal update when saving the assistant fails', async () => {
    const { store, repo, input } = setup();
    const { run } = await repo.acceptTurn(input);
    store.sqlite.exec("CREATE TRIGGER fail_final BEFORE UPDATE ON messages WHEN NEW.status='completed' AND NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'synthetic full disk'); END;");
    expect(() => repo.finish(run.id, 'preparing', completed())).toThrow(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }));
    expect(store.db.select().from(runs).get()).toMatchObject({ status: 'preparing', endedAt: null });
    expect(store.db.select().from(messages).where(eq(messages.id, run.assistantMessageId)).get()).toMatchObject({ status: 'pending', content: '' });
  });
  it('rejects writes to read-only storage without discarding saved content', async () => {
    const { store, repo, input } = setup();
    const { run } = await repo.acceptTurn(input);
    store.sqlite.pragma('query_only = ON');
    expect(() => repo.finish(run.id, 'preparing', completed())).toThrow(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }));
    expect(store.db.select().from(runs).get()?.id).toBe(run.id);
    store.sqlite.pragma('query_only = OFF');
  });
  it('guards active chats and cascades idle deletion while keeping permanent profiles', async () => {
    const { store, repo, input } = setup();
    const { run } = await repo.acceptTurn(input);
    expect(() => repo.deleteChat(input.chatId, 1)).toThrow(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(() => repo.deleteChat(input.chatId, 2)).toThrow(expect.objectContaining({ code: 'CHAT_ACTIVE' }));
    repo.finish(run.id, 'preparing', completed());
    repo.deleteChat(input.chatId, 2);
    expect(store.db.select().from(chats).all()).toHaveLength(0);
    expect(store.db.select().from(messages).all()).toHaveLength(0);
    expect(store.db.select().from(runs).all()).toHaveLength(0);
    expect(store.db.select().from(modelProfiles).all()).toHaveLength(2);
  });
});
