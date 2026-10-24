import { get } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { createApp } from '../../src/app.js';

// Use node:http so tests can explicitly send the canonical Host to an ephemeral port.
function localFetch(url: string, { headers }: { headers: Record<string, string> }): Promise<Response> {
  return new Promise((resolve, reject) => {
    get(url, { headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        resolve(new Response(Buffer.concat(chunks).toString('utf8'), { status: response.statusCode ?? 500, headers: responseHeaders }));
      });
    }).on('error', reject);
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe('workspace integration', () => {
  it('loads native SQLite through Drizzle and rolls back failed writes', () => {
    const native = new Database(':memory:');
    try {
      const db = drizzle(native);
      db.run(sql`create table fixture (id integer primary key, text text not null)`);
      const sample = 'Hello — selamat pagi 🌿';
      db.run(sql`insert into fixture values (1, ${sample})`);
      expect(db.get<{ text: string }>(sql`select text from fixture where id=1`)?.text).toBe(sample);
      expect(() => db.transaction(tx => { tx.run(sql`delete from fixture`); throw new Error('rollback'); })).toThrow('rollback');
      expect(db.get<{ count: number }>(sql`select count(*) as count from fixture`)?.count).toBe(1);
    } finally { native.close(); }
  });
  it('requires a same-origin bootstrap and session on real HTTP requests', async () => {
    const app = await createApp({ serveWeb: false });
    cleanups.push(() => app.close());
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const headers = { host: '127.0.0.1:3210' };
    expect((await localFetch(address + '/api/v1/health', { headers })).status).toBe(401);
    expect((await localFetch(address + '/api/v1/session', { headers })).status).toBe(403);
    const session = await localFetch(address + '/api/v1/session', { headers: { ...headers, 'sec-fetch-site': 'same-origin', 'x-localmind-bootstrap': '1' } });
    expect(session.status).toBe(200);
    const { data } = await session.json() as { data: { token: string } };
    const health = await localFetch(address + '/api/v1/health', { headers: { ...headers, 'x-localmind-token': data.token } });
    expect(health.status).toBe(200);
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(await health.json()).toMatchObject({ data: { appStatus: 'setup', databaseStatus: 'not_initialized' } });
    expect((await localFetch(address + '/api/v1/health', { headers: { ...headers, 'x-localmind-token': data.token, origin: 'https://evil.example' } })).status).toBe(403);
  });
});
