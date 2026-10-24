import { eq, inArray } from 'drizzle-orm';
import {
  BindProfileRequestSchema, DEFAULT_MODEL_PROFILES, ModelsResponseSchema, ProfileIdSchema, parseContract,
  type BrokerState, type ModelProfile, type ModelsResponse, type ProfileId,
} from '@localmind/contracts';
import type { Storage } from '../db/index.js';
import { modelProfiles, runs } from '../db/schema.js';
import { ModelError, type Inventory, type MetadataProvider } from '../providers/ollama/metadata.js';

const CACHE_MS = 30_000;
export function createModelRegistry(storage: Storage, provider: MetadataProvider, options: { clock?: () => number; brokerState?: () => BrokerState } = {}) {
  const clock = options.clock ?? Date.now;
  let inventory: Inventory = { version: '', installed: [], resident: [] };
  let checkedAt: number | null = null, attemptedAt: number | null = null;
  let reachable = false;
  let pending: Promise<Inventory> | undefined;
  function database<T>(operation: () => T): T {
    try { return operation(); } catch (error) { if (error instanceof ModelError) throw error; throw new ModelError('STORAGE_UNAVAILABLE'); }
  }
  function brokerState(): BrokerState {
    return database(() => {
      const external = options.brokerState?.() ?? 'idle';
      if (external !== 'idle') return external;
      return storage.db.select({ id: runs.id }).from(runs).where(inArray(runs.status, ['preparing', 'streaming'])).get() ? 'blocked' : 'idle';
    });
  }
  function requireIdle() { if (brokerState() !== 'idle') throw new ModelError('RUNTIME_BLOCKED'); }
  function profile(row: typeof modelProfiles.$inferSelect): ModelProfile {
    const model = inventory.installed.find(item => item.name === row.modelName);
    let availability: ModelProfile['availability'];
    let reasonCode: ModelProfile['reasonCode'] = null;
    let reason: string | null = null;
    if (row.modelName === null) { availability = 'unconfigured'; reason = 'Choose an installed community model.'; }
    else if (!reachable) { availability = 'unreachable'; reasonCode = 'OLLAMA_UNAVAILABLE'; reason = 'Ollama is unavailable. Refresh to retry.'; }
    else if (!model) { availability = 'missing'; reasonCode = 'MODEL_MISSING'; reason = 'The configured model is not installed.'; }
    else if (!model.eligible) { availability = 'incompatible'; reasonCode = 'MODEL_INCOMPATIBLE'; reason = 'The model does not meet local compatibility requirements.'; }
    else if (row.boundDigest !== null && row.boundDigest !== model.digest) { availability = 'model_changed'; reasonCode = 'MODEL_CHANGED'; reason = 'Confirm the changed model before using it.'; }
    else { availability = 'ready'; }
    return { id: row.id, label: row.label, modelName: row.modelName, boundDigest: row.boundDigest, version: row.version, availability, reasonCode, reason };
  }
  function snapshot(): ModelsResponse {
    return database(() => {
      const rows = storage.db.select().from(modelProfiles).all();
      const general = rows.find(row => row.id === 'general'), community = rows.find(row => row.id === 'abliterated');
      if (!general || !community) throw new ModelError('STORAGE_UNAVAILABLE');
      return parseContract(ModelsResponseSchema, { data: {
        checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
        stale: !reachable || checkedAt === null || clock() - checkedAt >= CACHE_MS,
        ollamaVersion: inventory.version || null, installed: inventory.installed,
        profiles: [profile(general), profile(community)],
      } });
    });
  }
  async function refresh(pinSeeds = true) {
    if (!pending) {
      attemptedAt = clock();
      pending = provider.discover().finally(() => { pending = undefined; });
    }
    let next: Inventory;
    try { next = await pending; } catch { reachable = false; throw new ModelError('OLLAMA_UNAVAILABLE'); }
    inventory = next; checkedAt = clock(); reachable = true;
    if (pinSeeds) database(() => storage.db.transaction(tx => {
      if (brokerState() !== 'idle') return;
      for (const seed of DEFAULT_MODEL_PROFILES) {
        const row = tx.select().from(modelProfiles).where(eq(modelProfiles.id, seed.id)).get();
        const model = inventory.installed.find(item => item.name === seed.modelName && item.eligible);
        if (row?.modelName === seed.modelName && row.boundDigest === null && model) {
          tx.update(modelProfiles).set({ boundDigest: model.digest, version: row.version + 1, updatedAt: clock() }).where(eq(modelProfiles.id, row.id)).run();
        }
      }
    }, { behavior: 'immediate' }));
    return snapshot();
  }
  return {
    refresh, snapshot, brokerState,
    ollamaStatus: () => attemptedAt === null ? 'not_checked' as const : reachable ? 'reachable' as const : 'unavailable' as const,
    residency: () => inventory.resident.map(model => ({ ...model })),
    async get() {
      if (attemptedAt === null || clock() - attemptedAt >= CACHE_MS) {
        try { await refresh(); } catch (error) { if (!(error instanceof ModelError) || error.code !== 'OLLAMA_UNAVAILABLE') throw error; }
      }
      return snapshot();
    },
    async bind(id: ProfileId, value: unknown) {
      parseContract(ProfileIdSchema, id);
      const body = parseContract(BindProfileRequestSchema, value);
      requireIdle();
      if (id === 'general' && body.modelName !== DEFAULT_MODEL_PROFILES[0].modelName) throw new ModelError('MODEL_INCOMPATIBLE');
      const before = database(() => storage.db.select().from(modelProfiles).where(eq(modelProfiles.id, id)).get());
      if (!before) throw new ModelError('NOT_FOUND');
      if (before.version !== body.expectedVersion) throw new ModelError('VERSION_CONFLICT');
      // Clearing a community mapping is a local operation and works during outages.
      if (body.modelName !== null) await refresh(false);
      return database(() => storage.db.transaction(tx => {
        requireIdle();
        const row = tx.select().from(modelProfiles).where(eq(modelProfiles.id, id)).get();
        if (!row || row.version !== body.expectedVersion) throw new ModelError('VERSION_CONFLICT');
        if (body.modelName !== null) {
          const model = inventory.installed.find(item => item.name === body.modelName);
          if (!model) throw new ModelError('MODEL_MISSING');
          if (!model.eligible) throw new ModelError('MODEL_INCOMPATIBLE');
          if (model.digest !== body.expectedDigest) throw new ModelError('MODEL_CHANGED');
        }
        const updated = tx.update(modelProfiles).set({ modelName: body.modelName, boundDigest: body.expectedDigest,
          version: row.version + 1, updatedAt: clock() }).where(eq(modelProfiles.id, id)).returning().get();
        return profile(updated);
      }, { behavior: 'immediate' }));
    },
  };
}
export type ModelRegistry = ReturnType<typeof createModelRegistry>;
