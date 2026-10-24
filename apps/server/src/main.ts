import { createLocalServer } from './lifecycle.js';

let runtime: Awaited<ReturnType<typeof createLocalServer>> | undefined;
try {
  runtime = await createLocalServer();
  await runtime.app.listen({ host: runtime.config.host, port: runtime.config.port });
  console.log('LocalMind server: http://127.0.0.1:3210');
} catch {
  console.error('LocalMind could not start. Check private storage and whether port 3210 is in use.');
  process.exitCode = 1;
  await runtime?.app.close();
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await runtime?.app.close();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
