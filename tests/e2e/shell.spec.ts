import { expect, test, type Page } from '@playwright/test';
const general = 'qwen3.5:2b-q4_K_M', community = 'huihui_ai/qwen3.5-abliterated:2B';
function inventory() {
  return { data: { checkedAt: '2026-10-24T00:00:00.000Z', stale: false, ollamaVersion: '0.40.3',
    installed: [general, community].map((name, i) => ({ name, digest: (i ? 'b' : 'a').repeat(64), sizeBytes: 1_900_000_000, quantization: 'Q4_K_M', capabilities: ['completion'], eligible: true, reasonCode: null })),
    profiles: ['general', 'abliterated'].map((id, i) => ({ id, label: i ? 'Abliterated' : 'General', modelName: i ? community : general,
      boundDigest: (i ? 'b' : 'a').repeat(64), version: 2, availability: 'ready', reasonCode: null as string | null, reason: null as string | null })) } };
}
async function mock(page: Page, data = inventory()) {
  await page.route('**/api/v1/models', route => route.fulfill({ json: data }));
  await page.route('**/api/v1/health', route => route.fulfill({ json: { data: { apiVersion: 1, appStatus: 'setup', databaseStatus: 'ready', ollamaStatus: 'reachable', brokerState: 'idle', activeRunId: null } } }));
  return data;
}
// Tests below use synthetic model metadata only.
for (const index of [0, 1]) test(`keeps both profiles visible when ${index === 0 ? 'official' : 'community'} model is missing`, async ({ page }) => {
  const data = inventory(); data.data.profiles[index]!.availability = 'missing'; data.data.profiles[index]!.reason = 'The configured model is not installed.';
  data.data.installed.splice(index, 1); await mock(page, data); await page.goto('/');
  const sidebar = page.getByRole('complementary');
  await expect(sidebar.getByText('Not installed', { exact: true })).toBeVisible();
  await expect(sidebar.getByRole('radio')).toHaveCount(2);
  await expect(sidebar.getByRole('radio').nth(index)).toBeDisabled();
  await sidebar.getByRole('radio').nth(1 - index).check();
  await expect(sidebar.getByRole('radio').nth(1 - index)).toBeChecked();
  await page.getByRole('button', { name: 'Model settings', exact: true }).click();
  await expect(page.getByText('Install the model in Ollama separately, then refresh. LocalMind does not download models.')).toBeVisible();
});
test('binds selected community model with explicit version/digest and confirms changed official model', async ({ page }) => {
  const data = await mock(page); data.data.profiles[0]!.availability = 'model_changed'; data.data.installed[0]!.digest = 'c'.repeat(64);
  const requests: { id: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/v1/model-profiles/*', async route => {
    const id = route.request().url().split('/').pop()!; const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push({ id, body }); const row = data.data.profiles.find(p => p.id === id)!;
    row.version++; row.availability = 'ready';
    await route.fulfill({ json: { data: row } });
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Model settings', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm updated General model' }).click();
  await expect(page.getByRole('button', { name: 'Bind selected model' })).toBeEnabled();
  await page.getByLabel('Installed model for Abliterated').selectOption(general);
  await page.getByRole('button', { name: 'Bind selected model' }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0]).toEqual({ id: 'general', body: { modelName: general, expectedDigest: 'c'.repeat(64), expectedVersion: 2 } });
  expect(requests[1]).toEqual({ id: 'abliterated', body: { modelName: general, expectedDigest: 'c'.repeat(64), expectedVersion: 2 } });
});
test('refresh failure preserves profiles and explains stale state', async ({ page }) => {
  const data = await mock(page);
  await page.route('**/api/v1/models/refresh', route => { data.data.stale = true; data.data.profiles.forEach(p => { p.availability = 'unreachable'; }); return route.fulfill({ status: 503, json: { error: { code: 'OLLAMA_UNAVAILABLE' } } }); });
  await page.goto('/'); await page.getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Ollama is unavailable');
  await expect(page.getByRole('complementary').getByRole('radio')).toHaveCount(2);
  await expect(page.getByText('Model information is out of date.', { exact: false })).toBeVisible();
});
test('theme is the only persisted preference and future media actions remain hidden', async ({ page }) => {
  await mock(page); await page.goto('/');
  await page.getByLabel('Appearance').selectOption('dark'); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload(); await expect(page.getByLabel('Appearance')).toHaveValue('dark');
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(['localmind-theme']);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  await expect(page.getByRole('button', { name: /upload|attach|voice|video|send/i })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/t06-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/t06-mobile.png', fullPage: true });
});
test('expired binding session refreshes state without submitting twice', async ({ page }) => {
  await mock(page); let patches = 0;
  await page.route('**/api/v1/model-profiles/*', route => { patches++; return route.fulfill({ status: 401, json: { error: { code: 'SESSION_REQUIRED' } } }); });
  await page.goto('/'); await page.getByRole('button', { name: 'Model settings', exact: true }).click();
  await page.getByRole('button', { name: 'Bind selected model' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Session refreshed'); expect(patches).toBe(1);
});
