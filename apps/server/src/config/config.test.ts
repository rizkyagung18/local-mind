import { describe, expect, it, vi } from 'vitest';

// Test source contracts directly; do not build or modify dist during this focused run.
vi.mock('@localmind/contracts', () => import('../../../../packages/contracts/src/index.js'));
import { loadConfig } from './index.js';

const locations = { homeDir: '/Users/localmind-test', repositoryDir: '/Users/localmind-test/project' };

describe('T02 trusted configuration', () => {
  it('keeps defaults local and computes both supported prompt budgets', () => {
    const config = loadConfig({}, locations);
    expect(config.dataDir).toBe('/Users/localmind-test/Library/Application Support/LocalMind');
    expect(config.inputBudget).toBe(3072);
    expect(loadConfig({ LOCALMIND_NUM_CTX: '2048' }, locations).inputBudget).toBe(1024);
    expect(config.numPredict).toBe(512);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.limits)).toBe(true);
  });
  it.each([
    { APP_HOST: '0.0.0.0' }, { APP_HOST: '::' }, { APP_HOST: 'localhost' },
    { APP_PORT: '5173' }, { OLLAMA_BASE_URL: 'https://example.com' },
    { OLLAMA_BASE_URL: 'http://127.0.0.1:11434/redirect' },
    { LOCALMIND_NUM_CTX: '8192' }, { LOCALMIND_NUM_CTX: '4096.0' },
    { LOCALMIND_NUM_PREDICT: '1024' }, { LOCALMIND_CLOUD: 'true' },
  ])('rejects unsafe endpoints or unsupported options: %j', environment => {
    expect(() => loadConfig(environment, locations)).toThrow();
  });
  it.each(['relative', '', '/', '/Users/localmind-test', '/Users/localmind-test/project/data',
    '/Users/localmind-test/Dropbox/LocalMind', '/Users/localmind-test/Library/CloudStorage/provider/data',
    '/Users/localmind-test/Library/Mobile Documents/data', '/Volumes/share/data', '/Network/share/data',
    '~/safe/../project', '/private/./data', '/private/bad\0path',
  ])('rejects unsafe data directory %s without filesystem writes', path => {
    expect(() => loadConfig({ LOCALMIND_DATA_DIR: path }, locations)).toThrow();
  });
  it('accepts an explicit private path without false-positive prefix matching', () => {
    expect(loadConfig({ LOCALMIND_DATA_DIR: '~/private-localmind' }, locations).dataDir).toBe('/Users/localmind-test/private-localmind');
    expect(loadConfig({ LOCALMIND_DATA_DIR: '/Users/localmind-test/project-backups' }, locations).dataDir).toBe('/Users/localmind-test/project-backups');
  });
});
