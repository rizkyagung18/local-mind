import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalServer } from '../../apps/server/src/lifecycle.ts';

process.env.NODE_ENV = 'production';
process.umask(0o077);
const directory = mkdtempSync(join(realpathSync(tmpdir()), 'localmind-browser-'));
let app;
try {
  const runtime = await createLocalServer({ dataDir: join(directory, 'data'), modelProvider: {
    discover: async () => ({ version: '0.40.3', resident: [], installed: [
      { name: 'qwen3.5:2b-q4_K_M', digest: 'a'.repeat(64), sizeBytes: 1_900_000_000, quantization: 'Q4_K_M', capabilities: ['completion'], eligible: true, reasonCode: null },
      { name: 'huihui_ai/qwen3.5-abliterated:2B', digest: 'b'.repeat(64), sizeBytes: 1_900_000_000, quantization: 'Q4_K_M', capabilities: ['completion'], eligible: true, reasonCode: null },
    ] }),
  } });
  app = runtime.app;
  // Isolated browser-test origin; production config and authorization stay fixed.
  app.server.prependListener('request', request => {
    if (request.headers.host === '127.0.0.1:43210') request.headers.host = '127.0.0.1:3210';
    if (request.headers.origin === 'http://127.0.0.1:43210') request.headers.origin = 'http://127.0.0.1:3210';
  });
  await app.listen({ host: runtime.config.host, port: 43210 });
} catch (error) {
  await app?.close(); rmSync(directory, { recursive: true, force: true }); throw error;
}
let closing = false;
async function close() {
  if (closing) return; closing = true;
  try { await app.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
}
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
