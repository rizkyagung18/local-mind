import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './api';
const token = 'a'.repeat(43), next = 'b'.repeat(43);
const health = { data: { apiVersion: 1, appStatus: 'setup', databaseStatus: 'ready', ollamaStatus: 'reachable', brokerState: 'idle', activeRunId: null } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('T06 local API client', () => {
  it('shares a bootstrap across concurrent reads and keeps secrets in headers only', async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('/session') ? json({ data: { token, apiVersion: 1 } }) : json(health));
    const client = createApiClient(send); await Promise.all([client.health(), client.health()]);
    expect(send.mock.calls.filter(([url]) => String(url).endsWith('/session'))).toHaveLength(1);
    for (const [url, options] of send.mock.calls) {
      expect(String(url)).toMatch(/^\/api\/v1\//); expect(String(url)).not.toContain(token);
      expect(options).toMatchObject({ mode: 'same-origin', cache: 'no-store', credentials: 'omit', redirect: 'error' });
    }
  });
  it('refreshes once after 401 and retries a read once with the new token', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ data: { token, apiVersion: 1 } }))
      .mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({ data: { token: next, apiVersion: 1 } })).mockResolvedValueOnce(json(health));
    expect(await createApiClient(send).health()).toEqual(health);
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[3]?.[1]?.headers).toEqual({ 'X-LocalMind-Token': next });
  });
  it('stops after a second 401 instead of looping', async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('/session') ? json({ data: { token, apiVersion: 1 } }) : json({}, 401));
    await expect(createApiClient(send).health()).rejects.toThrow(); expect(send).toHaveBeenCalledTimes(4);
  });
  it.each(['/models/refresh', '/model-profiles/abliterated', '/chats/test/turns'])('never replays mutation %s after refreshing the token', async path => {
    const send = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('/session') ? json({ data: { token, apiVersion: 1 } }) : json({}, 401));
    const client = createApiClient(send);
    await expect(client.request('POST', path, raw => raw, {})).rejects.toMatchObject({ code: 'SESSION_REFRESHED' });
    expect(send.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(3);
  });
  it('rejects invalid response contracts and arbitrary destinations', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(json({ data: { token: 'bad', apiVersion: 1 } }));
    const client = createApiClient(send);
    await expect(client.health()).rejects.toThrow();
    for (const path of ['https://example.com', '//example.com', '/../../secret', '/health?token=secret']) await expect(client.request('GET', path, raw => raw)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
