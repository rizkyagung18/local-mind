import type { Chat, Run } from './schemas.js';

// Synthetic contract examples only; never copy a real conversation into fixtures.
export const FIXTURE_ID = '00000000-0000-4000-8000-000000000001';
export const FIXTURE_DATE = '2026-10-23T00:00:00.000Z';
export const chatFixture = {
  id: FIXTURE_ID, title: 'Synthetic chat', profileId: 'general', version: 1,
  createdAt: FIXTURE_DATE, updatedAt: FIXTURE_DATE, activeRunId: null,
} satisfies Chat;
export const runFixture = {
  id: FIXTURE_ID, chatId: FIXTURE_ID,
  userMessageId: '00000000-0000-4000-8000-000000000002',
  assistantMessageId: '00000000-0000-4000-8000-000000000003',
  status: 'completed', profileId: 'general', modelName: 'qwen3.5:2b-q4_K_M', modelDigest: 'a'.repeat(64),
  options: { numCtx: 4096, numPredict: 512, temperature: 0.7, think: false },
  inputEstimate: 200, omittedMessageCount: 0, finishReason: 'stop', errorCode: null, terminationReason: null,
  createdAt: FIXTURE_DATE, firstContentAt: FIXTURE_DATE, endedAt: FIXTURE_DATE,
  metrics: { promptTokens: null, generatedTokens: null, loadMs: null, totalMs: null, evalMs: null },
} satisfies Run;
