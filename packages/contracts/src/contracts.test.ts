import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { LIMITS, ERROR_STATUS } from './constants.js';
import * as schemas from './schemas.js';
import { canonicalTurnRequest, fingerprintTurnRequest, parseContract, parseStreamEvent, parseTurnJson, parseTurnRequest } from './validation.js';
import { assistantStatusForRun, transitionAssistant, transitionBroker, transitionRun } from './transitions.js';
import { chatFixture, FIXTURE_DATE, FIXTURE_ID, runFixture } from './fixtures.js';

describe('T02 request boundaries', () => {
  it.each(['model', 'modelName', 'url', 'providerUrl', 'tools', 'role', 'messages', 'options', 'attachments'])('rejects injected %s instead of stripping it', field => {
    expect(() => parseTurnRequest({ content: 'hello', expectedVersion: 1, [field]: 'untrusted' })).toThrow();
  });
  it.each([0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1])('rejects invalid expectedVersion %s', expectedVersion => {
    expect(() => parseTurnRequest({ content: 'hello', expectedVersion })).toThrow();
  });
  it.each(['', ' \n\t', '\ud800'])('rejects blank or unrepresentable content', content => {
    expect(() => parseTurnRequest({ content, expectedVersion: 1 })).toThrow();
  });
  it('enforces bytes for multilingual input without truncating', () => {
    const content = '🌿'.repeat(4096);
    expect(parseTurnRequest({ content, expectedVersion: 1 }).content).toBe(content);
    expect(() => parseTurnRequest({ content: content + 'a', expectedVersion: 1 })).toThrow(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }));
  });
  it('enforces raw JSON size and rejects malformed JSON', () => {
    expect(() => parseTurnJson(' '.repeat(LIMITS.jsonBodyBytes) + '{}')).toThrow(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }));
    expect(() => parseTurnJson('{')).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => parseTurnJson('{"content":"test","expectedVersion":1,"__proto__":{}}')).toThrow();
  });
  it('canonicalizes property order but preserves content and Unicode distinctions', async () => {
    const content = '  hello\r\n🌿 e\u0301  ';
    const first = { content, expectedVersion: 1 };
    const reordered = { expectedVersion: 1, content };
    const canonical = canonicalTurnRequest(first);
    expect(canonical).toBe(JSON.stringify({ content, expectedVersion: 1 }));
    expect(await fingerprintTurnRequest(reordered)).toBe(createHash('sha256').update(canonical).digest('hex'));
    expect(await fingerprintTurnRequest({ ...first, content: content.trim() })).not.toBe(await fingerprintTurnRequest(first));
    expect(await fingerprintTurnRequest({ ...first, content: content.normalize('NFC') })).not.toBe(await fingerprintTurnRequest(first));
    expect(await fingerprintTurnRequest({ ...first, expectedVersion: 2 })).not.toBe(await fingerprintTurnRequest(first));
  });
  it('requires UUIDv4 identifiers and idempotency keys', () => {
    for (const id of ['../secrets', 'x', FIXTURE_ID.replace('-4000-', '-1000-'), FIXTURE_ID.replace('-8000-', '-7000-')]) {
      expect(Value.Check(schemas.ResourceParamsSchema, { id })).toBe(false);
      expect(Value.Check(schemas.IdempotencyKeySchema, id)).toBe(false);
    }
    expect(Value.Check(schemas.ResourceParamsSchema, { id: FIXTURE_ID })).toBe(true);
  });
  it('requires a real chat change, valid pagination and bounded titles', () => {
    expect(Value.Check(schemas.UpdateChatRequestSchema, { expectedVersion: 1 })).toBe(false);
    expect(Value.Check(schemas.UpdateChatRequestSchema, { expectedVersion: 1, title: 'new', profileId: 'abliterated' })).toBe(true);
    expect(Value.Check(schemas.UpdateChatRequestSchema, { expectedVersion: 1, title: 'new', model: 'hidden' })).toBe(false);
    expect(Value.Check(schemas.CreateChatRequestSchema, { title: 'a'.repeat(121) })).toBe(false);
    expect(Value.Check(schemas.ChatsQuerySchema, { limit: 101 })).toBe(false);
    expect(Value.Check(schemas.ChatsQuerySchema, { cursor: '../../private' })).toBe(false);
    expect(Value.Check(schemas.MessagesQuerySchema, { beforeSeq: 0 })).toBe(false);
  });
  it('allows explicit installed-tag binding but rejects URLs and secret fields', () => {
    const body = { modelName: runFixture.modelName, expectedDigest: runFixture.modelDigest, expectedVersion: 1 };
    expect(Value.Check(schemas.BindProfileRequestSchema, body)).toBe(true);
    expect(Value.Check(schemas.BindProfileRequestSchema, { ...body, modelName: 'https://evil.example/model' })).toBe(false);
    expect(Value.Check(schemas.BindProfileRequestSchema, { ...body, apiKey: 'secret' })).toBe(false);
    expect(Value.Check(schemas.BindProfileRequestSchema, { ...body, expectedDigest: 'not-a-digest' })).toBe(false);
    expect(Value.Check(schemas.BindProfileRequestSchema, { ...body, expectedDigest: null })).toBe(false);
    expect(Value.Check(schemas.BindProfileRequestSchema, { modelName: null, expectedDigest: null, expectedVersion: 1 })).toBe(true);
  });
});

describe('T02 response and SSE contracts', () => {
  it('always exposes both distinct profiles and explicit unknown cache metadata', () => {
    const profile = { id: 'general', label: 'General', modelName: null, boundDigest: null, version: 1, availability: 'unreachable', reasonCode: 'OLLAMA_UNAVAILABLE', reason: 'Ollama is unavailable.' };
    const response = { data: { checkedAt: null, stale: true, ollamaVersion: null, installed: [], profiles: [profile, { ...profile, id: 'abliterated', label: 'Abliterated' }] } };
    expect(Value.Check(schemas.ModelsResponseSchema, response)).toBe(true);
    expect(Value.Check(schemas.ModelsResponseSchema, { data: { ...response.data, profiles: [profile, profile] } })).toBe(false);
  });
  it('accepts complete synthetic DTOs and nullable provider metrics', () => {
    expect(parseContract(schemas.ChatResponseSchema, { data: chatFixture }).data).toEqual(chatFixture);
    expect(parseContract(schemas.RunResponseSchema, { data: runFixture }).data.metrics.evalMs).toBeNull();
    const message = { id: FIXTURE_ID, chatId: FIXTURE_ID, seq: 1, role: 'user', content: 'Synthetic', status: 'completed', createdAt: FIXTURE_DATE, updatedAt: FIXTURE_DATE, runId: FIXTURE_ID, modelName: null, modelDigest: null, profileId: null };
    expect(Value.Check(schemas.MessageSchema, message)).toBe(true);
    expect(Value.Check(schemas.MessageSchema, { ...message, role: 'system' })).toBe(false);
    expect(Value.Check(schemas.MessageSchema, { ...message, status: 'streaming' })).toBe(false);
  });
  it('rejects nested extras, changed generation limits and malformed metrics', () => {
    expect(Value.Check(schemas.RunSchema, { ...runFixture, options: { ...runFixture.options, tools: [] } })).toBe(false);
    expect(Value.Check(schemas.RunSchema, { ...runFixture, options: { ...runFixture.options, numPredict: 1024 } })).toBe(false);
    expect(Value.Check(schemas.RunSchema, { ...runFixture, metrics: { ...runFixture.metrics, evalMs: -1 } })).toBe(false);
    expect(Value.Check(schemas.RunSchema, { ...runFixture, createdAt: '2026-15-50' })).toBe(false);
  });
  it('accepts each SSE event and keeps terminal success separate from failure', () => {
    const events = [
      { id: 1, event: 'accepted', data: { runId: FIXTURE_ID, userMessageId: runFixture.userMessageId, assistantMessageId: runFixture.assistantMessageId, chatVersion: 2, profileId: 'general', modelName: runFixture.modelName, modelDigest: runFixture.modelDigest, inputEstimate: 200, omittedMessageCount: 0 } },
      { id: 2, event: 'status', data: { phase: 'preparing_model' } },
      { id: 3, event: 'delta', data: { text: '🌿' } },
      { id: 4, event: 'done', data: { run: runFixture } },
      { id: 5, event: 'error', data: { runId: FIXTURE_ID, code: 'GENERATION_TIMEOUT', message: 'Generation timed out.', retryable: true } },
    ];
    for (const event of events) expect(parseStreamEvent(event)).toEqual(event);
    expect(() => parseStreamEvent({ id: 1, event: 'done', data: { run: { ...runFixture, status: 'streaming' } } })).toThrow();
    expect(() => parseStreamEvent({ id: 1, event: 'delta', data: { text: 'hi', thinking: 'hidden' } })).toThrow();
    expect(() => parseStreamEvent({ id: 1, event: 'delta', data: { text: '🌿'.repeat(16385) } })).toThrow();
    expect(() => parseStreamEvent({ id: 0, event: 'delta', data: { text: 'hi' } })).toThrow();
  });
  it('forbids arbitrary sensitive error details and recognizes all planned error codes', () => {
    const error = { code: 'MODEL_MISSING', message: 'Model unavailable.', retryable: false, requestId: FIXTURE_ID, details: { profileId: 'general' } };
    expect(Value.Check(schemas.ErrorResponseSchema, { error })).toBe(true);
    expect(Value.Check(schemas.ErrorResponseSchema, { error: { ...error, details: { path: '/private/secret' } } })).toBe(false);
    expect(Value.Check(schemas.ErrorResponseSchema, { error: { ...error, code: 'RAW_PROVIDER_ERROR' } })).toBe(false);
    const architecture = readFileSync(new URL('../../../ARCHITECTURE.md', import.meta.url), 'utf8');
    for (const code of Object.keys(ERROR_STATUS)) expect(architecture).toContain(code);
  });
});

describe('T02 state transitions', () => {
  it.each(['completed', 'cancelled', 'failed', 'interrupted'] as const)('cannot reopen terminal run %s', status => {
    for (const next of ['preparing', 'streaming', 'completed', 'cancelled', 'failed', 'interrupted'] as const) expect(() => transitionRun(status, next)).toThrow();
    expect(() => transitionAssistant(status, 'streaming')).toThrow();
  });
  it('keeps assistant states aligned with preparing, streaming and cancellation', () => {
    expect(assistantStatusForRun('preparing')).toBe('pending');
    expect(transitionRun('preparing', 'streaming')).toBe('streaming');
    expect(transitionAssistant('pending', 'streaming')).toBe('streaming');
    expect(transitionAssistant('streaming', 'cancelled')).toBe('cancelled');
    expect(() => transitionAssistant('streaming', 'pending')).toThrow();
    expect(() => transitionRun('streaming', 'preparing')).toThrow();
  });
  it('blocks new work throughout cancellation and unresolved cleanup', () => {
    let state = transitionBroker('idle', 'accept');
    expect(() => transitionBroker(state, 'accept')).toThrow();
    state = transitionBroker(state, 'cleanup_started');
    expect(() => transitionBroker(state, 'completed_committed')).toThrow();
    state = transitionBroker(state, 'cleanup_timeout');
    expect(() => transitionBroker(state, 'accept')).toThrow();
    expect(() => transitionBroker(state, 'cleanup_confirmed')).toThrow();
    state = transitionBroker(state, 'retry_cleanup');
    expect(transitionBroker(state, 'cleanup_confirmed')).toBe('idle');
  });
  it('distinguishes a cancellation request from terminal state and guarded release', () => {
    expect(Value.Check(schemas.CancelAcceptedResponseSchema, { data: { runId: FIXTURE_ID, cancelRequested: true } })).toBe(true);
    expect(Value.Check(schemas.RunStatusSchema, 'cancelling')).toBe(false);
    expect(transitionBroker('running', 'completed_committed')).toBe('idle');
    expect(transitionBroker('running', 'storage_failed')).toBe('blocked');
    expect(transitionBroker('blocked', 'recovery_confirmed')).toBe('idle');
  });
});
