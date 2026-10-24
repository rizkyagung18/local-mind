import { expect, test } from '@playwright/test';

test('production shell connects locally without external requests or stored secrets', async ({ page, context }) => {
  const external: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== 'http://127.0.0.1:43210') { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const response = await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Conversation', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Model information is up to date.');
  await expect(page.getByRole('complementary', { name: 'Workspace sidebar' }).getByText('Ready', { exact: true })).toHaveCount(2);
  await expect(page.getByLabel('Message', { exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Conversation transcript' })).toBeVisible();
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  expect(response?.headers()['content-security-policy']).toContain("connect-src 'self'");
  expect(response?.headers()['content-security-policy']).not.toContain('ws:');
  expect(external).toEqual([]); expect(errors).toEqual([]);
});

test('shell fits a narrow screen with keyboard navigation and dialog focus return', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Skip to conversation' })).toBeFocused();
  await page.keyboard.press('Enter'); await expect(page.getByRole('main')).toBeFocused();
  await page.getByRole('button', { name: 'Model settings', exact: true }).focus();
  await page.keyboard.press('Enter'); await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Model settings', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
