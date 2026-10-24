import { expect, test, type Page } from '@playwright/test';

async function newChat(page: Page) {
  await page.goto('/');
  await expect(page.locator('.sidebar-section > button').filter({ hasText: /^New chat$/ })).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/api/v1/chats') && r.request().method() === 'POST'),
    page.locator('.sidebar-section > button').filter({ hasText: /^New chat$/ }).click(),
  ]);
  const { data } = await response.json() as { data: { id: string; version: number } };
  await expect(page.getByRole('heading', { name: 'New chat', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename chat', exact: true })).toBeEnabled();
  return data.id;
}
async function rename(page: Page, title: string) {
  await page.getByRole('button', { name: 'Rename chat', exact: true }).click();
  await page.getByLabel('Chat title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}
test('creates, renames, switches profile, reloads, reopens and confirms deletion', async ({ page }) => {
  await newChat(page); await rename(page, 'Persisted T07 chat');
  await page.getByRole('radio', { name: /Abliterated/ }).click();
  await expect(page.getByRole('radio', { name: /Abliterated/ })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Rename chat', exact: true })).toBeEnabled();
  await page.reload(); await expect(page.getByRole('heading', { name: 'Persisted T07 chat', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Abliterated/ })).toBeChecked();
  await page.locator('.sidebar-section > button').filter({ hasText: /^New chat$/ }).click();
  await expect(page.getByRole('heading', { name: 'New chat', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Saved chats' }).getByRole('button', { name: 'Persisted T07 chat', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Persisted T07 chat', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete chat', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this chat?' });
  await expect(dialog).toContainText('all its messages'); await expect(dialog).toContainText('does not guarantee physical erasure');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete chat', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Saved chats' }).getByRole('button', { name: 'Persisted T07 chat', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Message', { exact: true })).toBeDisabled();
});
test('refetches version conflicts and waits for an explicit retry', async ({ page }) => {
  const id = await newChat(page);
  await page.evaluate(async chatId => {
    const session = await fetch('/api/v1/session', { headers: { 'X-LocalMind-Bootstrap': '1' } }).then(r => r.json());
    const result = await fetch('/api/v1/chats/' + chatId, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-LocalMind-Token': session.data.token }, body: JSON.stringify({ expectedVersion: 1, title: 'Other tab title' }) });
    if (!result.ok) throw Error('Fixture update failed');
  }, id);
  let patches = 0; page.on('request', request => { if (request.method() === 'PATCH' && request.url().endsWith(id)) patches++; });
  await page.getByRole('button', { name: 'Rename chat', exact: true }).click();
  await page.getByLabel('Chat title', { exact: true }).fill('My retry title');
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename chat' });
  await expect(dialog.getByRole('alert')).toContainText('another tab');
  expect(patches).toBe(1);
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My retry title', exact: true })).toBeVisible(); expect(patches).toBe(2);
});
test('renders safe plain-text history, loads older pages, and stores no chat content in the browser', async ({ page }) => {
  const id = await newChat(page); await rename(page, 'History fixture');
  const date = '2026-10-24T00:00:00.000Z';
  const item = (seq: number) => ({ id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, chatId: id, seq, role: seq % 2 ? 'user' : 'assistant', content: seq === 3 ? '<img src="https://invalid.example/track">' : 'Saved text ' + seq, status: 'completed', createdAt: date, updatedAt: date,
    runId: '00000000-0000-4000-8000-000000000099', modelName: seq % 2 ? null : 'historical-model:2b', modelDigest: seq % 2 ? null : 'a'.repeat(64), profileId: seq % 2 ? null : 'general' });
  await page.route(`**/api/v1/chats/${id}/messages*`, route => {
    const older = new URL(route.request().url()).searchParams.has('beforeSeq');
    return route.fulfill({ json: { data: { items: (older ? [1, 2] : [3, 4]).map(item), nextBeforeSeq: older ? null : 3 } } });
  });
  await page.getByRole('navigation', { name: 'Saved chats' }).getByRole('button', { name: 'History fixture', exact: true }).click();
  const transcript = page.getByRole('region', { name: 'Conversation transcript' });
  await expect(transcript).toContainText('<img src="https://invalid.example/track">');
  await expect(transcript.locator('img')).toHaveCount(0); await expect(transcript).toContainText('historical-model:2b');
  await page.getByRole('button', { name: 'Load older', exact: true }).click();
  await expect(transcript.getByRole('article')).toHaveCount(4);
  expect(await transcript.getByRole('article').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(['You message 1', 'Assistant message 2', 'You message 3', 'Assistant message 4']);
  await expect(page.getByRole('button', { name: 'Load older', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key !== 'localmind-theme'))).toEqual([]);
});
test('disables active-chat changes and supports keyboard dialogs on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const id = await newChat(page);
  await page.getByRole('button', { name: 'Rename chat', exact: true }).click();
  await expect(page.getByLabel('Chat title', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Rename chat', exact: true })).toBeFocused();
  await page.route(`**/api/v1/chats/${id}`, async route => {
    const response = await route.fetch(); const json = await response.json(); json.data.activeRunId = '00000000-0000-4000-8000-000000000099';
    await route.fulfill({ response, json });
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Rename chat', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Delete chat', exact: true })).toBeDisabled();
  await expect(page.getByRole('radio', { name: /Abliterated/ })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
