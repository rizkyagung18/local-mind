import http from 'node:http';
import {
  DigestSchema, InstalledModelSchema, LIMITS, ModelNameSchema, parseContract,
  type ErrorCode, type ModelsResponse,
} from '@localmind/contracts';

export class ModelError extends Error {
  constructor(public readonly code: ErrorCode) { super('The model operation could not be completed.'); }
}
export type MetadataPath = '/api/version' | '/api/tags' | '/api/show' | '/api/ps';
export type MetadataReader = (path: MetadataPath, model?: string, signal?: AbortSignal) => Promise<unknown>;
export type InstalledModel = ModelsResponse['data']['installed'][number];
export type Inventory = { version: string; installed: InstalledModel[]; resident: { name: string; digest: string }[] };

// The injected request function is for trusted tests; target/path are never browser inputs.
export function createMetadataReader(send: typeof http.request = http.request): MetadataReader {
  const agent = new http.Agent({ keepAlive: false, proxyEnv: {} });
  return (path, model, signal) => new Promise((resolve, reject) => {
    if (!['/api/version', '/api/tags', '/api/show', '/api/ps'].includes(path)) { reject(new ModelError('VALIDATION_ERROR')); return; }
    if (path === '/api/show') {
      try { parseContract(ModelNameSchema, model); } catch { reject(new ModelError('VALIDATION_ERROR')); return; }
    } else if (model !== undefined) { reject(new ModelError('VALIDATION_ERROR')); return; }
    const body = path === '/api/show' ? JSON.stringify({ model }) : undefined;
    let settled = false;
    const finish = (error: boolean, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(new ModelError('OLLAMA_UNAVAILABLE')); else resolve(value);
    };
    const req = send({ hostname: '127.0.0.1', port: 11434, path, method: body ? 'POST' : 'GET', agent,
      ...(signal ? { signal } : {}), headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    }, response => {
      if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        response.destroy(); finish(true); return;
      }
      const length = Number(response.headers['content-length']);
      if (Number.isFinite(length) && length > LIMITS.metadataBytes) { response.destroy(); finish(true); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > LIMITS.metadataBytes) { response.destroy(); req.destroy(); finish(true); }
        else chunks.push(chunk);
      });
      response.on('error', () => finish(true));
      response.on('aborted', () => finish(true));
      response.on('end', () => {
        try {
          const json = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          finish(false, JSON.parse(json));
        } catch { finish(true); }
      });
    });
    const timer = setTimeout(() => { req.destroy(); finish(true); }, LIMITS.discoveryMs);
    req.on('error', () => finish(true));
    req.end(body);
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModelError('OLLAMA_UNAVAILABLE');
  return value as Record<string, unknown>;
}
function remote(value: Record<string, unknown>) {
  return ['remote_host', 'remote_model', 'remote', 'cloud'].some(key => value[key] !== undefined && value[key] !== null && value[key] !== '' && value[key] !== false);
}
function inspect(tag: Record<string, unknown>, raw: unknown): InstalledModel {
  const show = record(raw);
  const details = show.details && typeof show.details === 'object' ? record(show.details) : {};
  const info = show.model_info && typeof show.model_info === 'object' ? record(show.model_info) : {};
  const thinking = show.thinking && typeof show.thinking === 'object' ? record(show.thinking) : {};
  const capabilities = Array.isArray(show.capabilities) && show.capabilities.every(c => typeof c === 'string' && c.length > 0 && c.length <= 64)
    ? [...new Set(show.capabilities as string[])].slice(0, 32) : [];
  const tagDetails = tag.details && typeof tag.details === 'object' ? record(tag.details) : {};
  const local = ![tag, show, details, info, tagDetails].some(remote) && !/(?:^|[/:_-])cloud(?:$|[/:_-])/i.test(String(tag.name));
  const eligible = local && details.format === 'gguf' && typeof info['general.architecture'] === 'string'
    && String(info['general.architecture']).length > 0 && Number.isSafeInteger(info['general.file_type'])
    && Number(info['general.file_type']) >= 0 && capabilities.includes('completion')
    && Array.isArray(thinking.values) && thinking.values.includes(false)
    && Number(tag.size) > 0 && Number(tag.size) <= LIMITS.maxModelBytes;
  return parseContract(InstalledModelSchema, {
    name: tag.name, digest: tag.digest, sizeBytes: tag.size,
    quantization: typeof details.quantization_level === 'string' && details.quantization_level.length > 0 && details.quantization_level.length <= 64 ? details.quantization_level : null,
    capabilities, eligible, reasonCode: eligible ? null : 'MODEL_INCOMPATIBLE',
  });
}

export function createMetadataProvider(read: MetadataReader = createMetadataReader()) {
  return {
    async discover(): Promise<Inventory> {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), LIMITS.discoveryMs);
      const call = (path: MetadataPath, model?: string) => read(path, model, controller.signal);
      try {
        const [versionRaw, tagsRaw, psRaw] = await Promise.all([call('/api/version'), call('/api/tags'), call('/api/ps')]);
        const version = record(versionRaw).version;
        if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version) || version.length > 64) throw new ModelError('OLLAMA_UNAVAILABLE');
        const tags = record(tagsRaw).models, ps = record(psRaw).models;
        if (!Array.isArray(tags) || !Array.isArray(ps)) throw new ModelError('OLLAMA_UNAVAILABLE');
        const names = new Set<string>(); const installed: InstalledModel[] = [];
        // Sequential metadata reads bound concurrency/memory; one deadline bounds the pass.
        for (const raw of tags) {
          const tag = record(raw);
          const name = parseContract(ModelNameSchema, tag.name);
          parseContract(DigestSchema, tag.digest);
          if (names.has(name) || !Number.isSafeInteger(tag.size) || Number(tag.size) < 0) throw new ModelError('OLLAMA_UNAVAILABLE');
          names.add(name);
          installed.push(inspect(tag, await call('/api/show', name)));
        }
        const resident = ps.map(raw => { const row = record(raw); return { name: parseContract(ModelNameSchema, row.name), digest: parseContract(DigestSchema, row.digest) }; });
        return { version, installed, resident };
      } catch { throw new ModelError('OLLAMA_UNAVAILABLE'); }
      finally { clearTimeout(deadline); controller.abort(); }
    },
  };
}
export type MetadataProvider = ReturnType<typeof createMetadataProvider>;
