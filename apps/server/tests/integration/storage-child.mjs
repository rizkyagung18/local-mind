import { registerHooks } from 'node:module';

// Exercise source modules without rebuilding package output for these tests.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@localmind/contracts') return { url: new URL('../../../../packages/contracts/src/index.ts', import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { openStorage } = await import('../../src/db/index.ts');
try {
  const storage = openStorage(process.argv[2]);
  process.send?.({ code: 'OPEN' });
  if (process.argv[3] === 'hold') setInterval(() => {}, 1000);
  else { storage.close(); process.disconnect?.(); }
} catch (error) {
  process.send?.({ code: error.code ?? 'UNKNOWN' });
  process.disconnect?.();
}
