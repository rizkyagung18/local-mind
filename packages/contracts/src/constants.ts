export const APP_HOST = '127.0.0.1';
export const APP_PORT = 3210;
export const APP_ORIGIN = 'http://127.0.0.1:3210';
export const DEV_ORIGIN = 'http://127.0.0.1:5173';
export const API_PREFIX = '/api/v1';
export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const DEFAULT_MODEL_PROFILES = [
  { id: 'general', label: 'General', modelName: 'qwen3.5:2b-q4_K_M' },
  { id: 'abliterated', label: 'Abliterated', modelName: 'huihui_ai/qwen3.5-abliterated:2B' },
] as const;

export const LIMITS = Object.freeze({
  numCtx: 4096, lowMemoryNumCtx: 2048, numPredict: 512, contextReserve: 512,
  temperature: 0.7, keepAlive: '2m', unloadKeepAlive: 0, maxActiveGenerations: 1,
  maxModelBytes: 2_500_000_000, jsonBodyBytes: 32 * 1024, userContentBytes: 16 * 1024,
  assistantContentBytes: 64 * 1024, ndjsonLineBytes: 1024 * 1024, metadataBytes: 8 * 1024 * 1024,
  discoveryMs: 5000, firstObjectMs: 60_000, betweenObjectsMs: 30_000, totalRunMs: 180_000,
  cleanupMs: 5000, backpressureMs: 5000, heartbeatMs: 10_000,
  checkpointMs: 500, checkpointBytes: 4 * 1024, uiBatchMs: 50,
  titleCodePoints: 120, derivedTitleCodePoints: 60, pageSize: 50, maxPageSize: 100,
} as const);

export const PROFILE_IDS = ['general', 'abliterated'] as const;
export const RUN_STATUSES = ['preparing', 'streaming', 'completed', 'cancelled', 'failed', 'interrupted'] as const;
export const MESSAGE_STATUSES = ['pending', 'streaming', 'completed', 'cancelled', 'failed', 'interrupted'] as const;
export const BROKER_STATES = ['idle', 'running', 'draining', 'blocked'] as const;
export const AVAILABILITIES = ['ready', 'missing', 'unconfigured', 'incompatible', 'model_changed', 'unreachable'] as const;
export const TERMINATION_REASONS = ['user_stop', 'client_disconnect', 'timeout', 'provider_error', 'storage_error', 'server_shutdown', 'server_restart'] as const;
export const ERROR_STATUS = {
  VALIDATION_ERROR: 400, SESSION_REQUIRED: 401, LOCAL_ACCESS_DENIED: 403, NOT_FOUND: 404,
  VERSION_CONFLICT: 409, CHAT_ACTIVE: 409, GENERATION_BUSY: 409, DUPLICATE_REQUEST: 409,
  IDEMPOTENCY_CONFLICT: 409, MODEL_CHANGED: 409, OLLAMA_IN_USE: 409,
  PAYLOAD_TOO_LARGE: 413, CONTEXT_TOO_LARGE: 422, MODEL_MISSING: 422, MODEL_INCOMPATIBLE: 422,
  PROVIDER_ERROR: 502, INVALID_PROVIDER_STREAM: 502, UNSUPPORTED_MODEL_OUTPUT: 502, OUTPUT_TOO_LARGE: 502,
  OLLAMA_UNAVAILABLE: 503, RUNTIME_BLOCKED: 503, STORAGE_UNAVAILABLE: 503, GENERATION_INTERRUPTED: 503,
  GENERATION_TIMEOUT: 504,
  INTERNAL_ERROR: 500,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;
