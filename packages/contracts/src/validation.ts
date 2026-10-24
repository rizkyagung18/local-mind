import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { LIMITS, type ErrorCode } from './constants.js';
import { StreamEventSchema, TurnRequestSchema } from './schemas.js';

export class ContractError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code === 'PAYLOAD_TOO_LARGE' ? 'The request exceeds the allowed size.' : 'The request does not match the contract.');
    this.name = 'ContractError';
  }
}

export function parseContract<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) throw new ContractError('VALIDATION_ERROR');
  return value;
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function parseTurnRequest(value: unknown) {
  // Check bytes before schema character limits to preserve the documented 413 error.
  if (value !== null && typeof value === 'object' && 'content' in value && typeof value.content === 'string') {
    if (utf8Bytes(value.content) > LIMITS.userContentBytes) throw new ContractError('PAYLOAD_TOO_LARGE');
  }
  const request = parseContract(TurnRequestSchema, value);
  // Lone surrogates have no unique UTF-8 representation; reject instead of rewriting.
  for (const character of request.content) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) throw new ContractError('VALIDATION_ERROR');
  }
  return { content: request.content, expectedVersion: request.expectedVersion };
}

export function parseTurnJson(raw: string) {
  if (utf8Bytes(raw) > LIMITS.jsonBodyBytes) throw new ContractError('PAYLOAD_TOO_LARGE');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ContractError('VALIDATION_ERROR'); }
  return parseTurnRequest(value);
}

export function canonicalTurnRequest(value: unknown): string {
  return JSON.stringify(parseTurnRequest(value));
}

export async function fingerprintTurnRequest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalTurnRequest(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function parseStreamEvent(value: unknown) {
  const event = parseContract(StreamEventSchema, value);
  if (event.event === 'delta' && utf8Bytes(event.data.text) > LIMITS.assistantContentBytes) {
    throw new ContractError('OUTPUT_TOO_LARGE');
  }
  return event;
}
