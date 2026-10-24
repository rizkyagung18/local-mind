import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/index.js';

export class StorageError extends Error {
  constructor(public readonly code: 'STORAGE_UNAVAILABLE' | 'DATA_DIRECTORY_LOCKED' = 'STORAGE_UNAVAILABLE') {
    super(code === 'DATA_DIRECTORY_LOCKED' ? 'The data directory is already in use.' : 'Private storage is unavailable.');
    this.name = 'StorageError';
  }
}

function exists(path: string) {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function preparePrivateDirectory(dataDir: string) {
  // Keep the mask restrictive for SQLite-created journals and all later app files.
  process.umask(0o077);
  const uid = process.getuid?.();
  if (uid === undefined) throw new StorageError();
  const repositoryDir = fileURLToPath(new URL('../../../../', import.meta.url));
  const validated = loadConfig({ LOCALMIND_DATA_DIR: dataDir }, { homeDir: homedir(), repositoryDir }).dataDir;
  // Default macOS volumes ignore case. Check forbidden roots with the same semantics.
  if (process.platform === 'darwin') {
    loadConfig({ LOCALMIND_DATA_DIR: validated.toLowerCase() }, { homeDir: homedir().toLowerCase(), repositoryDir: repositoryDir.toLowerCase() });
  }
  let current = parse(validated).root;
  for (const part of validated.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    if (!exists(current)) mkdirSync(current, { mode: 0o700 });
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory() || ![0, uid].includes(info.uid)) throw new StorageError();
    const sharedStickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
    if ((info.mode & 0o022) !== 0 && !sharedStickyRoot) throw new StorageError();
    if (current === validated && (info.uid !== uid || (info.mode & 0o777) !== 0o700)) throw new StorageError();
    // Fail closed on network/FUSE/unknown filesystems. These are native local types.
    const localTypes = process.platform === 'darwin' ? [17, 26] : [0xef53, 0x58465342, 0x9123683e, 0x01021994];
    if (!localTypes.includes(statfsSync(current).type)) throw new StorageError();
  }
  if (resolve(realpathSync(validated)) !== resolve(validated)) throw new StorageError();
  return validated;
}

export function assertPrivateFile(path: string, required = false) {
  const info = exists(path);
  if (!info && !required) return;
  if (!info || !info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()
    || (info.mode & 0o777) !== 0o600 || info.nlink !== 1) throw new StorageError();
}

export function createPrivateFile(path: string) {
  assertPrivateFile(path);
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1) throw new StorageError();
  } finally { closeSync(fd); }
  // Parent is checked before opening; never create implicit public directories here.
  if ((lstatSync(dirname(path)).mode & 0o777) !== 0o700) throw new StorageError();
}

export function assertDatabaseFiles(path: string) {
  assertPrivateFile(path, true);
  for (const suffix of ['-wal', '-shm', '-journal']) assertPrivateFile(path + suffix);
}
