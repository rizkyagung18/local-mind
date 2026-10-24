import { get } from 'node:http';
import Database from 'better-sqlite3';

function localJson(path) {
  return new Promise((resolve, reject) => {
    const request = get({ hostname: '127.0.0.1', port: 11434, path }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Unavailable')); return; }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) { response.destroy(new Error('Response too large')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid metadata')); }
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error('Unavailable')), 5000);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', reject);
  });
}

console.log('LocalMind environment check (read-only; no model loading)');
console.log('Node: ' + process.version + ' | Platform: ' + process.platform + ' ' + process.arch);
if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error('Use the Node 24 version pinned in .nvmrc.');
  process.exitCode = 1;
}
try {
  const database = new Database(':memory:');
  try {
    const { version } = database.prepare('select sqlite_version() as version').get();
    console.log('Embedded SQLite: ' + version);
    const [major, minor, patch] = version.split('.').map(Number);
    if (major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) {
      console.error('Upgrade to embedded SQLite 3.51.3 or later before using persistent WAL storage.');
      process.exitCode = 1;
    }
  } finally { database.close(); }
} catch {
  console.error('Native SQLite could not load. Reinstall dependencies for this Node version and architecture.');
  process.exitCode = 1;
}

const [version, tags] = await Promise.allSettled([localJson('/api/version'), localJson('/api/tags')]);
console.log('Ollama: ' + (version.status === 'fulfilled' && typeof version.value.version === 'string' ? version.value.version.replace(/[^0-9a-zA-Z.+-]/g, '').slice(0,40) : 'not reachable (workspace checks can still run)'));
const models = tags.status === 'fulfilled' && Array.isArray(tags.value.models) ? tags.value.models : [];
for (const name of ['qwen3.5:2b-q4_K_M', 'huihui_ai/qwen3.5-abliterated:2B']) {
  console.log(name + ': ' + (models.some(model => model.name === name) ? 'installed' : tags.status === 'fulfilled' ? 'not installed' : 'not checked'));
}
console.log('Application storage: not initialized; persistent storage is task T03.');
console.log('Cloud-disable settings and model eligibility are not verified by this setup check.');
