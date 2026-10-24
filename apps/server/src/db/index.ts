import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DEFAULT_MODEL_PROFILES } from '@localmind/contracts';
import { assertDatabaseFiles, createPrivateFile, preparePrivateDirectory, StorageError } from '../storage/private-directory.js';
import { acquireDirectoryLock } from '../storage/lock.js';
import * as schema from './schema.js';

export function openStorage(dataDirectory: string) {
  let release: (() => void) | undefined;
  let sqlite: Database.Database | undefined;
  try {
    const directory = preparePrivateDirectory(dataDirectory);
    release = acquireDirectoryLock(directory);
    const path = join(directory, 'localmind.sqlite');
    createPrivateFile(path);
    assertDatabaseFiles(path);
    sqlite = new Database(path, { timeout: 1000 });
    const version = sqlite.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    const [major = 0, minor = 0, patch = 0] = version.version.split('.').map(Number);
    if (major * 1_000_000 + minor * 1000 + patch < 3_051_003) throw new StorageError();
    if (sqlite.pragma('quick_check', { simple: true }) !== 'ok') throw new StorageError();
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = FULL');
    sqlite.pragma('busy_timeout = 1000');
    const db = drizzle(sqlite, { schema });
    const migrationConfig = { migrationsFolder: fileURLToPath(new URL('../../drizzle/', import.meta.url)) };
    const expected = readMigrationFiles(migrationConfig);
    const ledgerExists = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'").get();
    if (ledgerExists) {
      const applied = sqlite.prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at, id').all() as { hash: string; created_at: number }[];
      if (applied.some((entry, i) => entry.hash !== expected[i]?.hash || entry.created_at !== expected[i]?.folderMillis)) throw new StorageError();
    }
    migrate(db, migrationConfig);
    db.transaction(tx => {
      const now = Date.now();
      for (const profile of DEFAULT_MODEL_PROFILES) {
        tx.insert(schema.modelProfiles).values({ id: profile.id, label: profile.label, modelName: profile.modelName, createdAt: now, updatedAt: now }).onConflictDoNothing().run();
      }
      if (tx.select().from(schema.modelProfiles).all().length !== 2) throw new StorageError();
    });
    const foreignKeyErrors = sqlite.pragma('foreign_key_check');
    if (!Array.isArray(foreignKeyErrors) || foreignKeyErrors.length !== 0 || sqlite.pragma('quick_check', { simple: true }) !== 'ok') throw new StorageError();
    assertDatabaseFiles(path);
    const connection = sqlite;
    const unlock = release;
    let closed = false;
    return {
      db, sqlite: connection, path,
      close() {
        if (closed) return;
        closed = true;
        try { connection.close(); } finally { unlock(); }
      },
    };
  } catch (error) {
    try { sqlite?.close(); } finally { release?.(); }
    if (error instanceof StorageError) throw error;
    throw new StorageError();
  }
}

export type Storage = ReturnType<typeof openStorage>;
