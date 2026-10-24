import { createApp } from './app.js';
import { createAuditWriter } from './audit.js';
import { loadConfig } from './config/index.js';
import { openStorage } from './db/index.js';
import { createMetadataProvider, ModelError, type MetadataProvider } from './providers/ollama/metadata.js';
import { createModelRegistry } from './services/models.js';

// Factory injection is for trusted callers/tests, never HTTP parameters.
export async function createLocalServer(options: { dataDir?: string; serveWeb?: boolean; webRoot?: string; modelProvider?: MetadataProvider } = {}) {
  const config = loadConfig({ ...process.env, ...(options.dataDir === undefined ? {} : { LOCALMIND_DATA_DIR: options.dataDir }) });
  const development = process.env.NODE_ENV === 'development';
  const storage = openStorage(config.dataDir);
  try {
    const models = createModelRegistry(storage, options.modelProvider ?? createMetadataProvider());
    try { await models.refresh(); } catch (error) {
      if (!(error instanceof ModelError) || error.code !== 'OLLAMA_UNAVAILABLE') throw error;
    }
    const app = await createApp({ development, serveWeb: options.serveWeb ?? !development,
      ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }), storage, audit: createAuditWriter(config.dataDir),
      onClose: () => storage.close(), models });
    return { app, config };
  } catch (error) { storage.close(); throw error; }
}
