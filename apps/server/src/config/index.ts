import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_HOST, APP_ORIGIN, APP_PORT, LIMITS, OLLAMA_BASE_URL } from '@localmind/contracts';

type Environment = Readonly<Record<string, string | undefined>>;
type Locations = { homeDir: string; repositoryDir: string };

function within(path: string, root: string): boolean {
  const remainder = relative(root, path);
  return remainder === '' || (!remainder.startsWith('..' + sep) && remainder !== '..' && !isAbsolute(remainder));
}

export function loadConfig(
  environment: Environment = process.env,
  locations: Locations = { homeDir: homedir(), repositoryDir: fileURLToPath(new URL('../../../../', import.meta.url)) },
) {
  for (const [name, expected] of Object.entries({ APP_HOST, APP_PORT: String(APP_PORT), OLLAMA_BASE_URL })) {
    if (environment[name] !== undefined && environment[name] !== expected) throw new Error('Unsafe fixed endpoint configuration: ' + name);
  }
  for (const name of Object.keys(environment)) {
    if (name.startsWith('LOCALMIND_') && !['LOCALMIND_NUM_CTX', 'LOCALMIND_DATA_DIR'].includes(name)) {
      throw new Error('Unsupported LocalMind configuration key: ' + name);
    }
  }
  const context = environment.LOCALMIND_NUM_CTX ?? String(LIMITS.numCtx);
  if (context !== '4096' && context !== '2048') throw new Error('LOCALMIND_NUM_CTX must be 4096 or 2048.');
  const raw = environment.LOCALMIND_DATA_DIR ?? resolve(locations.homeDir, 'Library/Application Support/LocalMind');
  const expanded = raw.startsWith('~/') ? resolve(locations.homeDir, raw.slice(2)) : raw;
  if (!isAbsolute(expanded) || raw.includes('\0') || raw.includes('\\') || raw.split('/').includes('..') || raw.split('/').includes('.')) {
    throw new Error('Data directory must be an absolute local path without traversal.');
  }
  const dataDir = resolve(expanded);
  const forbidden = [locations.repositoryDir, '/Volumes', '/Network',
    resolve(locations.homeDir, 'Library/CloudStorage'), resolve(locations.homeDir, 'Library/Mobile Documents'),
    resolve(locations.homeDir, 'Dropbox'), resolve(locations.homeDir, 'OneDrive')];
  if (dataDir === sep || dataDir === resolve(locations.homeDir) || forbidden.some(root => within(dataDir, resolve(root)))) {
    throw new Error('Data directory cannot be a repository, shared root, network mount, or known sync location.');
  }
  // Physical ancestry, ownership, filesystem type and creation belong to T03.
  return Object.freeze({
    host: APP_HOST, port: APP_PORT, origin: APP_ORIGIN, ollamaBaseUrl: OLLAMA_BASE_URL, dataDir,
    numCtx: Number(context) as 4096 | 2048, numPredict: LIMITS.numPredict,
    inputBudget: Number(context) - LIMITS.numPredict - LIMITS.contextReserve,
    limits: LIMITS,
  });
}
