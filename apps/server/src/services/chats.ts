import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import {
  ChatSchema, ChatsQuerySchema, ContractError, CreateChatRequestSchema, DeleteChatRequestSchema,
  MessageSchema, MessagesQuerySchema, UpdateChatRequestSchema, UuidSchema, parseContract,
  type BrokerState, type Chat,
} from '@localmind/contracts';
import type { Storage } from '../db/index.js';
import { chats, messages, modelProfiles, runs } from '../db/schema.js';
import { createRepository, RepositoryError } from '../db/repository.js';
import { StorageError } from '../storage/private-directory.js';
import { ModelError } from '../providers/ollama/metadata.js';
import type { ModelRegistry } from './models.js';

export type ChatRuntime = () => { state: BrokerState; chatId: string; runId: string } | null;
export function createChatService(storage: Storage, models?: ModelRegistry, options: { clock?: () => number; runtime?: ChatRuntime } = {}) {
  const db = storage.db, clock = options.clock ?? Date.now;
  const repository = createRepository(storage, clock);
  function database<T>(work: () => T): T {
    try { return work(); } catch (error) {
      if (error instanceof ContractError || error instanceof RepositoryError || error instanceof ModelError) throw error;
      throw new StorageError();
    }
  }
  function activeRun(chatId: string) {
    const owned = options.runtime?.();
    if (owned && owned.state !== 'idle' && owned.chatId === chatId) return owned.runId;
    return db.select({ id: runs.id }).from(runs).where(and(eq(runs.chatId, chatId), inArray(runs.status, ['preparing', 'streaming']))).get()?.id ?? null;
  }
  function row(id: string) {
    parseContract(UuidSchema, id);
    const value = db.select().from(chats).where(eq(chats.id, id)).get();
    if (!value) throw new RepositoryError('NOT_FOUND');
    return value;
  }
  function dto(value: typeof chats.$inferSelect): Chat {
    return parseContract(ChatSchema, { id: value.id, title: value.title, profileId: value.profileId, version: value.version,
      createdAt: new Date(value.createdAt).toISOString(), updatedAt: new Date(value.updatedAt).toISOString(), activeRunId: activeRun(value.id) });
  }
  function editable(id: string, version: number) {
    const current = row(id);
    if (current.version !== version) throw new RepositoryError('VERSION_CONFLICT');
    if (activeRun(id)) throw new RepositoryError('CHAT_ACTIVE');
    return current;
  }
  function title(value: string | undefined) {
    if (value !== undefined && !value.isWellFormed()) throw new ContractError('VALIDATION_ERROR');
  }
  function decodeCursor(value: string): [number, string] {
    try {
      const decoded = Buffer.from(value, 'base64url');
      if (decoded.toString('base64url') !== value) throw Error();
      const pair: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
      if (!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0]) || pair[0] < 0 || pair[0] > 253402300799999) throw Error();
      return [pair[0] as number, parseContract(UuidSchema, pair[1])];
    } catch { throw new ContractError('VALIDATION_ERROR'); }
  }
  return {
    create(input: unknown) {
      const body = parseContract(CreateChatRequestSchema, input); title(body.title);
      return database(() => dto(repository.createChat(body)));
    },
    get(id: string) { return database(() => dto(row(id))); },
    list(input: unknown = {}) {
      const query = parseContract(ChatsQuerySchema, input), limit = query.limit ?? 50;
      const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      return database(() => {
        const found = db.select().from(chats).where(cursor ? or(lt(chats.updatedAt, cursor[0]), and(eq(chats.updatedAt, cursor[0]), lt(chats.id, cursor[1]))) : undefined)
          .orderBy(desc(chats.updatedAt), desc(chats.id)).limit(limit + 1).all();
        const page = found.slice(0, limit), last = page.at(-1);
        return { items: page.map(dto), nextCursor: found.length > limit && last ? Buffer.from(JSON.stringify([last.updatedAt, last.id])).toString('base64url') : null };
      });
    },
    messages(id: string, input: unknown = {}) {
      const query = parseContract(MessagesQuerySchema, input), limit = query.limit ?? 50;
      return database(() => {
        row(id);
        const found = db.select({ message: messages, run: runs }).from(messages)
          .innerJoin(runs, or(eq(messages.id, runs.userMessageId), eq(messages.id, runs.assistantMessageId)))
          .where(and(eq(messages.chatId, id), query.beforeSeq === undefined ? undefined : lt(messages.seq, query.beforeSeq)))
          .orderBy(desc(messages.seq)).limit(limit + 1).all();
        const page = found.slice(0, limit).reverse();
        return { items: page.map(({ message: m, run }) => parseContract(MessageSchema, {
          id: m.id, chatId: m.chatId, seq: m.seq, role: m.role, content: m.content, status: m.status,
          createdAt: new Date(m.createdAt).toISOString(), updatedAt: new Date(m.updatedAt).toISOString(), runId: run.id,
          modelName: m.role === 'assistant' ? run.modelName : null,
          modelDigest: m.role === 'assistant' ? run.modelDigest : null, profileId: m.role === 'assistant' ? run.profileId : null,
        })), nextBeforeSeq: found.length > limit ? page[0]!.message.seq : null };
      });
    },
    async update(id: string, input: unknown) {
      const body = parseContract(UpdateChatRequestSchema, input); title(body.title);
      database(() => editable(id, body.expectedVersion));
      const inventory = body.profileId === undefined ? undefined : await models?.refresh(false);
      if (body.profileId !== undefined && !inventory) throw new ModelError('OLLAMA_UNAVAILABLE');
      const target = inventory?.data.profiles.find(p => p.id === body.profileId);
      if (target && target.availability !== 'ready') throw new ModelError(target.reasonCode ?? 'MODEL_MISSING');
      return database(() => db.transaction(tx => {
        const current = editable(id, body.expectedVersion);
        if (target) {
          const bound = tx.select().from(modelProfiles).where(eq(modelProfiles.id, target.id)).get();
          if (!bound || bound.version !== target.version || bound.modelName !== target.modelName || bound.boundDigest !== target.boundDigest) throw new ModelError('MODEL_CHANGED');
          const latest = models!.snapshot().data.profiles.find(p => p.id === target.id)!;
          if (latest.availability !== 'ready' || models!.snapshot().data.stale) throw new ModelError(latest.reasonCode ?? 'OLLAMA_UNAVAILABLE');
        }
        const updated = tx.update(chats).set({ version: current.version + 1, updatedAt: clock(),
          ...(body.title === undefined ? {} : { title: body.title, titleSource: 'manual' as const }),
          ...(body.profileId === undefined ? {} : { profileId: body.profileId }),
        }).where(eq(chats.id, id)).returning().get();
        return dto(updated);
      }, { behavior: 'immediate' }));
    },
    remove(id: string, input: unknown) {
      const body = parseContract(DeleteChatRequestSchema, input);
      return database(() => db.transaction(tx => {
        editable(id, body.expectedVersion);
        tx.delete(chats).where(eq(chats.id, id)).run();
      }, { behavior: 'immediate' }));
    },
  };
}
export type ChatService = ReturnType<typeof createChatService>;
