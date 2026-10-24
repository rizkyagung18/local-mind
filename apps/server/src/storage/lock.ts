import Database from 'better-sqlite3';
import { join } from 'node:path';
import { assertDatabaseFiles, createPrivateFile, StorageError } from './private-directory.js';

// SQLite's kernel-backed exclusive transaction provides crash-safe ownership.
// Keep the lock file: unlinking it can create two independently locked inodes.
export function acquireDirectoryLock(privateDirectory: string) {
  const path = join(privateDirectory, 'localmind.lock.sqlite');
  createPrivateFile(path);
  assertDatabaseFiles(path);
  const lock = new Database(path, { timeout: 0 });
  try {
    lock.pragma('journal_mode = DELETE');
    lock.pragma('synchronous = FULL');
    lock.exec('BEGIN EXCLUSIVE');
    assertDatabaseFiles(path);
  } catch (error) {
    lock.close();
    throw new StorageError((error as { code?: string }).code === 'SQLITE_BUSY' ? 'DATA_DIRECTORY_LOCKED' : 'STORAGE_UNAVAILABLE');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { if (lock.inTransaction) lock.exec('ROLLBACK'); } finally { lock.close(); }
  };
}
