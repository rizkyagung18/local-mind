import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './api';

const id = '00000000-0000-4000-8000-000000000001';
const chat = { id, title: 'Synthetic', profileId: 'general', version: 1, activeRunId: null, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function setup(responses: Response[]) {
  const send = vi.fn<typeof fetch>(async () => { const response = responses.shift(); if (!response) throw Error('Unexpected request'); return response; });
  return { send, client: createApiClient(send) };
}
const session = () => json({ data: { token: 't'.repeat(43), apiVersion: 1 } });
describe('T07 chat client', () => {
  it('encodes bounded query inputs without allowing cursor content to become a path or second parameter', async () => {
    const { send, client } = setup([session(), json({ data: { items: [chat], nextCursor: null } }), json({ data: { items: [], nextBeforeSeq: null } })]);
    await client.chats({ limit: 2, cursor: 'abc&limit=100' });
    await client.messages(id, { limit: 3, beforeSeq: 9 });
    expect(send.mock.calls[1]![0]).toBe('/api/v1/chats?limit=2&cursor=abc%26limit%3D100');
    expect(send.mock.calls[2]![0]).toBe(`/api/v1/chats/${id}/messages?limit=3&beforeSeq=9`);
    expect(send.mock.calls[1]![1]).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { 'X-LocalMind-Token': 't'.repeat(43) } });
  });
  it('creates, reads, updates and deletes with an empty 204 response', async () => {
    const { send, client } = setup([session(), json({ data: chat }, 201), json({ data: chat }), json({ data: { ...chat, version: 2 } }), new Response(null, { status: 204 })]);
    expect((await client.createChat()).data.id).toBe(id);
    await client.chat(id); await client.updateChat(id, { expectedVersion: 1, title: 'Renamed' });
    expect(await client.deleteChat(id, 2)).toBeUndefined();
    expect(send.mock.calls[1]![1]?.body).toBe('{}');
    expect(send.mock.calls[4]![1]).toMatchObject({ method: 'DELETE', body: '{"expectedVersion":2}' });
  });
  it.each(['create', 'rename', 'delete'] as const)('does not replay an expired-session %s mutation', async action => {
    const { send, client } = setup([session(), json({}, 401), session()]);
    const result = action === 'create' ? client.createChat() : action === 'rename' ? client.updateChat(id, { expectedVersion: 1, title: 'Title' }) : client.deleteChat(id, 1);
    await expect(result).rejects.toMatchObject({ code: 'SESSION_REFRESHED' });
    expect(send).toHaveBeenCalledTimes(3);
  });
  it('refreshes an expired read once and rejects malformed chat/history responses', async () => {
    const { send, client } = setup([session(), json({}, 401), session(), json({ data: chat }), json({ data: { items: [{ secret: true }], nextBeforeSeq: null } }), new Response(null, { status: 204 })]);
    expect((await client.chat(id)).data.id).toBe(id); expect(send).toHaveBeenCalledTimes(4);
    await expect(client.messages(id)).rejects.toThrow();
    await expect(client.chat(id)).rejects.toThrow();
    await expect(client.chat('../secret')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
  it('reports conflicts safely without replaying them', async () => {
    const { send, client } = setup([session(), json({ error: { code: 'VERSION_CONFLICT', message: 'private provider details' } }, 409)]);
    await expect(client.updateChat(id, { expectedVersion: 1, title: 'Title' })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', message: 'This item changed in another tab. Review the latest state and try again.' });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
