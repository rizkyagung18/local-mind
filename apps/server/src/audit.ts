import { appendFileSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_STATUS, type ErrorCode } from '@localmind/contracts';
import { assertPrivateFile, createPrivateFile } from './storage/private-directory.js';

export type AuditRecord = { requestId: string; statusCode: number; durationMs: number; errorCode?: ErrorCode };
export type AuditWriter = (record: AuditRecord) => void;
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

export function createAuditWriter(directory: string): AuditWriter {
  const files = ['localmind.log', 'localmind.log.1', 'localmind.log.2'].map(name => join(directory, name));
  const current = files[0]!;
  for (const file of files) assertPrivateFile(file);
  createPrivateFile(current);
  return record => {
    // Reconstruct the record; never serialize request objects, URLs, or arbitrary fields.
    const safe = {
      requestId: /^[a-f0-9-]{36}$/i.test(record.requestId) ? record.requestId : 'invalid',
      statusCode: Number.isInteger(record.statusCode) ? record.statusCode : 500,
      durationMs: Number.isFinite(record.durationMs) ? Math.max(0, Math.round(record.durationMs)) : 0,
      ...(record.errorCode && Object.hasOwn(ERROR_STATUS, record.errorCode) ? { errorCode: record.errorCode } : {}),
    };
    const line = JSON.stringify(safe) + '\n';
    for (const file of files) assertPrivateFile(file);
    if (lstatSync(current).size + Buffer.byteLength(line) > AUDIT_MAX_BYTES) {
      rmSync(files[2]!, { force: true });
      try { renameSync(files[1]!, files[2]!); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      renameSync(current, files[1]!);
      createPrivateFile(current);
    }
    appendFileSync(current, line, { mode: 0o600 });
  };
}
