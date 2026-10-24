import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  ContractError, CreateChatRequestSchema, GenerationOptionsSchema, IdempotencyKeySchema,
  LIMITS, RunSchema, UuidSchema, fingerprintTurnRequest, parseContract, parseTurnRequest, utf8Bytes,
  type ErrorCode, type ProfileId, type Run,
} from '@localmind/contracts';
import type { Storage } from './index.js';
import { chats, messages, modelProfiles, runs } from './schema.js';
import { StorageError } from '../storage/private-directory.js';

export class RepositoryError extends Error {
  constructor(public readonly code: ErrorCode, public readonly existing?: { runId: string; userMessageId: string; assistantMessageId: string }) {
    super(code);
    this.name = 'RepositoryError';
  }
}

type AcceptTurn = {
  chatId: string; idempotencyKey: string; content: string; expectedVersion: number;
  profileId: ProfileId; profileVersion: number; modelName: string; modelDigest: string;
  options: Run['options']; inputEstimate: number; omittedMessageCount: number; includedMessageIds: string[];
};
type Terminal = Pick<Run, 'finishReason' | 'errorCode' | 'terminationReason' | 'metrics'> & {
  status: 'completed' | 'cancelled' | 'failed' | 'interrupted'; content: string;
};

function boundedAnswer(content: string) {
  if (typeof content !== 'string' || !content.isWellFormed()) throw new RepositoryError('VALIDATION_ERROR');
  if (utf8Bytes(content) > LIMITS.assistantContentBytes) throw new RepositoryError('OUTPUT_TOO_LARGE');
}

export function createRepository(storage: Storage, clock: () => number = Date.now) {
  const db = storage.db;
  const active = ['preparing', 'streaming'] as const;
  const guarded = <T>(operation: () => T): T => {
    try { return operation(); } catch (error) {
      if (error instanceof RepositoryError || error instanceof ContractError) throw error;
      throw new StorageError();
    }
  };
  return {
    createChat(input: unknown = {}) {
      const body = parseContract(CreateChatRequestSchema, input);
      const now = clock();
      return guarded(() => db.insert(chats).values({
        id: randomUUID(), title: body.title ?? 'New chat', titleSource: body.title ? 'manual' : 'default',
        profileId: body.profileId ?? 'general', createdAt: now, updatedAt: now,
      }).returning().get());
    },

    async acceptTurn(input: AcceptTurn) {
      parseContract(UuidSchema, input.chatId);
      parseContract(IdempotencyKeySchema, input.idempotencyKey);
      const request = parseTurnRequest({ content: input.content, expectedVersion: input.expectedVersion });
      const requestHash = await fingerprintTurnRequest(request);
      parseContract(GenerationOptionsSchema, input.options);
      for (const id of input.includedMessageIds) parseContract(UuidSchema, id);
      if (new Set(input.includedMessageIds).size !== input.includedMessageIds.length) throw new RepositoryError('VALIDATION_ERROR');
      const now = clock();
      const snapshot = parseContract(RunSchema, {
        id: randomUUID(), chatId: input.chatId, userMessageId: randomUUID(), assistantMessageId: randomUUID(),
        status: 'preparing', profileId: input.profileId, modelName: input.modelName, modelDigest: input.modelDigest,
        options: input.options, inputEstimate: input.inputEstimate, omittedMessageCount: input.omittedMessageCount,
        finishReason: null, errorCode: null, terminationReason: null,
        createdAt: new Date(now).toISOString(), firstContentAt: null, endedAt: null,
        metrics: { promptTokens: null, generatedTokens: null, loadMs: null, totalMs: null, evalMs: null },
      });
      return guarded(() => db.transaction(tx => {
        const prior = tx.select().from(runs).where(and(eq(runs.chatId, input.chatId), eq(runs.idempotencyKey, input.idempotencyKey))).get();
        if (prior) throw new RepositoryError(prior.requestHash === requestHash ? 'DUPLICATE_REQUEST' : 'IDEMPOTENCY_CONFLICT', {
          runId: prior.id, userMessageId: prior.userMessageId, assistantMessageId: prior.assistantMessageId,
        });
        const chat = tx.select().from(chats).where(eq(chats.id, input.chatId)).get();
        if (!chat) throw new RepositoryError('NOT_FOUND');
        if (chat.version !== input.expectedVersion) throw new RepositoryError('VERSION_CONFLICT');
        if (tx.select({ id: runs.id }).from(runs).where(inArray(runs.status, [...active])).get()) throw new RepositoryError('GENERATION_BUSY');
        const profile = tx.select().from(modelProfiles).where(eq(modelProfiles.id, input.profileId)).get();
        if (chat.profileId !== input.profileId || !profile || profile.version !== input.profileVersion
          || profile.modelName !== input.modelName || profile.boundDigest !== input.modelDigest) throw new RepositoryError('MODEL_CHANGED');
        if (input.includedMessageIds.length) {
          const history = tx.select().from(messages).where(and(eq(messages.chatId, chat.id), inArray(messages.id, input.includedMessageIds), eq(messages.status, 'completed'))).all();
          if (history.length !== input.includedMessageIds.length) throw new RepositoryError('VALIDATION_ERROR');
        }
        tx.insert(messages).values([
          { id: snapshot.userMessageId, chatId: chat.id, seq: chat.nextMessageSeq, role: 'user', content: request.content, status: 'completed', createdAt: now, updatedAt: now },
          { id: snapshot.assistantMessageId, chatId: chat.id, seq: chat.nextMessageSeq + 1, role: 'assistant', content: '', status: 'pending', createdAt: now, updatedAt: now },
        ]).run();
        tx.insert(runs).values({
          id: snapshot.id, chatId: chat.id, userMessageId: snapshot.userMessageId, assistantMessageId: snapshot.assistantMessageId,
          idempotencyKey: input.idempotencyKey, requestHash, status: 'preparing', profileId: input.profileId,
          modelName: input.modelName, modelDigest: input.modelDigest, options: input.options,
          systemPromptVersion: 'localmind-system-v1', inputEstimate: input.inputEstimate, omittedMessageCount: input.omittedMessageCount,
          includedMessageIds: input.includedMessageIds, createdAt: now,
        }).run();
        const title = [...(request.content.split(/\r?\n/).find(line => line.trim().length > 0)?.trim() ?? 'New chat')].slice(0, LIMITS.derivedTitleCodePoints).join('');
        tx.update(chats).set({
          version: chat.version + 1, nextMessageSeq: chat.nextMessageSeq + 2, updatedAt: now,
          ...(chat.titleSource === 'default' ? { title, titleSource: 'derived' as const } : {}),
        }).where(eq(chats.id, chat.id)).run();
        return { run: snapshot, chatVersion: chat.version + 1 };
      }, { behavior: 'immediate' }));
    },

    // Call on deltas and a 500 ms dirty timer. Returns true only when text was saved.
    checkpoint(runId: string, content: string) {
      parseContract(UuidSchema, runId);
      boundedAnswer(content);
      return guarded(() => db.transaction(tx => {
        const run = tx.select().from(runs).where(eq(runs.id, runId)).get();
        if (!run || !active.includes(run.status as typeof active[number])) return false;
        const message = tx.select().from(messages).where(eq(messages.id, run.assistantMessageId)).get();
        if (!message) throw new StorageError();
        if (!content.startsWith(message.content)) throw new RepositoryError('VALIDATION_ERROR');
        if (content.length === 0 || content === message.content) return false;
        const now = clock();
        const due = now - message.updatedAt >= LIMITS.checkpointMs || utf8Bytes(content) - utf8Bytes(message.content) >= LIMITS.checkpointBytes;
        if (run.firstContentAt === null || due) {
          tx.update(runs).set({ status: 'streaming', firstContentAt: run.firstContentAt ?? now }).where(and(eq(runs.id, runId), inArray(runs.status, [...active]))).run();
          tx.update(messages).set({ status: 'streaming', ...(due ? { content, updatedAt: now } : {}) }).where(eq(messages.id, run.assistantMessageId)).run();
        }
        return due;
      }, { behavior: 'immediate' }));
    },

    finish(runId: string, expectedStatus: 'preparing' | 'streaming', result: Terminal) {
      parseContract(UuidSchema, runId);
      boundedAnswer(result.content);
      if (result.status === 'completed' && result.content.length === 0) throw new RepositoryError('PROVIDER_ERROR');
      return guarded(() => db.transaction(tx => {
        const run = tx.select().from(runs).where(eq(runs.id, runId)).get();
        if (!run || run.status !== expectedStatus || !active.includes(run.status as typeof active[number])) return false;
        const message = tx.select().from(messages).where(eq(messages.id, run.assistantMessageId)).get();
        if (!message || !result.content.startsWith(message.content)) throw new RepositoryError('VALIDATION_ERROR');
        const now = clock();
        parseContract(RunSchema, {
          id: run.id, chatId: run.chatId, userMessageId: run.userMessageId, assistantMessageId: run.assistantMessageId,
          status: result.status, profileId: run.profileId, modelName: run.modelName, modelDigest: run.modelDigest,
          options: run.options, inputEstimate: run.inputEstimate, omittedMessageCount: run.omittedMessageCount,
          finishReason: result.finishReason, errorCode: result.errorCode, terminationReason: result.terminationReason, metrics: result.metrics,
          createdAt: new Date(run.createdAt).toISOString(), firstContentAt: run.firstContentAt === null ? null : new Date(run.firstContentAt).toISOString(), endedAt: new Date(now).toISOString(),
        });
        const changed = tx.update(runs).set({
          status: result.status, endedAt: now, finishReason: result.finishReason, errorCode: result.errorCode, terminationReason: result.terminationReason,
          promptTokens: result.metrics.promptTokens, generatedTokens: result.metrics.generatedTokens,
          loadMs: result.metrics.loadMs, totalMs: result.metrics.totalMs, evalMs: result.metrics.evalMs,
          firstContentAt: run.firstContentAt ?? (result.content ? now : null),
        }).where(and(eq(runs.id, runId), eq(runs.status, expectedStatus))).run().changes;
        if (changed !== 1) return false;
        tx.update(messages).set({ content: result.content, status: result.status, updatedAt: now }).where(eq(messages.id, run.assistantMessageId)).run();
        tx.update(chats).set({ updatedAt: now }).where(eq(chats.id, run.chatId)).run();
        return true;
      }, { behavior: 'immediate' }));
    },

    deleteChat(chatId: string, expectedVersion: number) {
      parseContract(UuidSchema, chatId);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new RepositoryError('VALIDATION_ERROR');
      return guarded(() => db.transaction(tx => {
        const chat = tx.select().from(chats).where(eq(chats.id, chatId)).get();
        if (!chat) throw new RepositoryError('NOT_FOUND');
        if (chat.version !== expectedVersion) throw new RepositoryError('VERSION_CONFLICT');
        if (tx.select().from(runs).where(and(eq(runs.chatId, chatId), inArray(runs.status, [...active]))).get()) throw new RepositoryError('CHAT_ACTIVE');
        tx.delete(chats).where(eq(chats.id, chatId)).run();
      }, { behavior: 'immediate' }));
    },
  };
}
