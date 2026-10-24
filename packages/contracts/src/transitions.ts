import type { BrokerState, RunStatus } from './schemas.js';

export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = Object.freeze({
  preparing: ['streaming', 'completed', 'cancelled', 'failed', 'interrupted'],
  streaming: ['completed', 'cancelled', 'failed', 'interrupted'],
  completed: [], cancelled: [], failed: [], interrupted: [],
});

export function transitionRun(from: RunStatus, to: RunStatus): RunStatus {
  if (!RUN_TRANSITIONS[from].includes(to)) throw new Error('Invalid run transition.');
  return to;
}

export type AssistantStatus = 'pending' | Exclude<RunStatus, 'preparing'>;
export function assistantStatusForRun(status: RunStatus): AssistantStatus {
  return status === 'preparing' ? 'pending' : status;
}

export function transitionAssistant(from: AssistantStatus, to: AssistantStatus): AssistantStatus {
  transitionRun(from === 'pending' ? 'preparing' : from, to === 'pending' ? 'preparing' : to);
  return to;
}

// Events describe verified conditions, not merely HTTP callbacks.
export const BROKER_TRANSITIONS = {
  idle: { accept: 'running' },
  running: { preflight_rejected: 'idle', completed_committed: 'idle', cleanup_started: 'draining', storage_failed: 'blocked' },
  draining: { cleanup_confirmed: 'idle', cleanup_timeout: 'blocked', storage_failed: 'blocked' },
  blocked: { retry_cleanup: 'draining', recovery_confirmed: 'idle' },
} as const;
export type BrokerEvent = 'accept' | 'preflight_rejected' | 'completed_committed' | 'cleanup_started'
  | 'storage_failed' | 'cleanup_confirmed' | 'cleanup_timeout' | 'retry_cleanup' | 'recovery_confirmed';

export function transitionBroker(state: BrokerState, event: BrokerEvent): BrokerState {
  const transitions: Partial<Record<BrokerEvent, BrokerState>> = BROKER_TRANSITIONS[state];
  const next = transitions[event];
  if (next === undefined) throw new Error('Invalid broker transition.');
  return next;
}
