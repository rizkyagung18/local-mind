import {
  API_PREFIX, ChatResponseSchema, ChatsResponseSchema, MessagesResponseSchema, HealthResponseSchema, ModelsResponseSchema, ProfileResponseSchema, SessionResponseSchema,
  parseContract, type BindProfileRequest, type ProfileId, type CreateChatRequest, type UpdateChatRequest,
} from '@localmind/contracts';

export class ApiError extends Error {
  constructor(public readonly code: string) {
    super(code === 'SESSION_REFRESHED' ? 'Session refreshed. Review the latest state and try again.'
      : code === 'VERSION_CONFLICT' ? 'This item changed in another tab. Review the latest state and try again.'
      : code === 'CHAT_ACTIVE' ? 'This chat is active. Wait until generation and cleanup finish.'
      : code === 'NOT_FOUND' ? 'This chat no longer exists.'
      : code === 'MODEL_CHANGED' ? 'The model changed. Refresh and review it before confirming.'
      : code === 'RUNTIME_BLOCKED' ? 'The local runtime is busy or needs recovery. Try again when it is idle.'
      : code === 'OLLAMA_UNAVAILABLE' ? 'Ollama is unavailable. Start it on this Mac, then refresh models.'
      : 'Could not complete the local request. Check the server and try again.');
  }
}
export function createApiClient(send: typeof fetch = fetch) {
  let token: string | undefined;
  let bootstrap: Promise<string> | undefined;
  async function session(): Promise<string> {
    if (token) return token;
    if (!bootstrap) bootstrap = (async () => {
      const response = await send(API_PREFIX + '/session', {
        headers: { 'X-LocalMind-Bootstrap': '1' }, mode: 'same-origin', credentials: 'omit',
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new ApiError('SESSION_REQUIRED');
      token = parseContract(SessionResponseSchema, await response.json()).data.token;
      return token;
    })().finally(() => { bootstrap = undefined; });
    return bootstrap;
  }
  async function refreshSession(used: string) {
    if (token === used) token = undefined;
    await session();
  }
  async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, decode: (raw: unknown) => T, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path) || path.startsWith('//')) throw new ApiError('VALIDATION_ERROR');
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) params.set(key, String(value));
    const suffix = params.size ? '?' + params.toString() : '';
    const perform = (value: string) => send(API_PREFIX + path + suffix, {
      method, headers: { 'X-LocalMind-Token': value, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      mode: 'same-origin', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    const used = await session();
    let response = await perform(used);
    if (response.status === 401) {
      await refreshSession(used);
      // A mutation may have side effects. Never replay it, including future generation requests.
      if (method !== 'GET') throw new ApiError('SESSION_REFRESHED');
      response = await perform(await session());
    }
    if (!response.ok) {
      let code = 'REQUEST_FAILED';
      try {
        const raw: unknown = await response.json();
        if (raw && typeof raw === 'object' && 'error' in raw && raw.error && typeof raw.error === 'object'
          && 'code' in raw.error && typeof raw.error.code === 'string') code = raw.error.code;
      } catch { /* Never display raw provider, HTML, or parser errors. */ }
      throw new ApiError(code);
    }
    return decode(response.status === 204 ? undefined : await response.json());
  }
  return {
    health: () => request('GET', '/health', raw => parseContract(HealthResponseSchema, raw)),
    models: () => request('GET', '/models', raw => parseContract(ModelsResponseSchema, raw)),
    refreshModels: () => request('POST', '/models/refresh', raw => parseContract(ModelsResponseSchema, raw), {}),
    bindProfile: (id: ProfileId, body: BindProfileRequest) => request('PATCH', '/model-profiles/' + id, raw => parseContract(ProfileResponseSchema, raw), body),
    chats: (query: { limit?: number; cursor?: string } = {}) => request('GET', '/chats', raw => parseContract(ChatsResponseSchema, raw), undefined, query),
    chat: (id: string) => request('GET', '/chats/' + id, raw => parseContract(ChatResponseSchema, raw)),
    createChat: (body: CreateChatRequest = {}) => request('POST', '/chats', raw => parseContract(ChatResponseSchema, raw), body),
    updateChat: (id: string, body: UpdateChatRequest) => request('PATCH', '/chats/' + id, raw => parseContract(ChatResponseSchema, raw), body),
    deleteChat: (id: string, expectedVersion: number) => request('DELETE', '/chats/' + id, raw => { if (raw !== undefined) throw new ApiError('REQUEST_FAILED'); }, { expectedVersion }),
    messages: (id: string, query: { limit?: number; beforeSeq?: number } = {}) => request('GET', '/chats/' + id + '/messages', raw => parseContract(MessagesResponseSchema, raw), undefined, query),
    request,
  };
}
const client = createApiClient();
export const checkLocalConnection = () => client.health();
