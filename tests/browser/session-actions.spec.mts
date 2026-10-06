import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/**
 * Pin, rename and delete on a chat, in the sidebar and on the Sessions page: what a refusal says, and what a keyboard
 * can do with the row.
 */

const at = '2026-01-01T00:00:00.000Z';
const chat = (id: string, title: string) => ({ id, title, workspace: `/w/${id}`, status: 'idle', kind: 'task', pinned: false, updated_at: at, created_at: at, provider: null, model: null, thinking_level: null });

/** Two chats; with `refuse`, every change to one is answered with a failure. */
async function portal(page: Page, refuse = false) {
  await mockPortal(page, ({ path, method }) => {
    if (path === '/api/sessions' && method === 'GET') return { sessions: [chat('a', 'First chat'), chat('b', 'Second chat')], executor: 'host' };
    if (path === '/api/projects') return { root: '/w', home: '/h', projects: [] };
    if (refuse && method !== 'GET' && /^\/api\/sessions\/[ab]$/.test(path)) return reply(500, { error: 'The disk is full' });
  });
}

test('the sidebar says why a chat could not be pinned, renamed or deleted, and names its buttons', async ({ page }) => {
  await portal(page, true);
  await page.goto('/sessions');
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  // By its id: while it is renamed the name is in a field, and not the row's text.
  const row = sidebar.locator('[data-flip="a"]');
  await row.hover();
  await row.getByRole('button', { name: 'Pin First chat' }).click();
  await expect(sidebar.getByRole('alert')).toHaveText('Could not pin "First chat": The disk is full');
  await row.getByRole('button', { name: 'Rename First chat' }).click();
  await row.getByRole('textbox', { name: 'Session name' }).fill('Renamed');
  await row.getByRole('textbox', { name: 'Session name' }).press('Enter');
  await expect(sidebar.getByRole('alert')).toHaveText('Could not rename "First chat": The disk is full');
  await row.hover();
  await row.getByRole('button', { name: 'Delete First chat' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(sidebar.getByRole('alert')).toHaveText('Could not delete "First chat": The disk is full');
  // The row is still there: nothing was deleted.
  await expect(row).toBeVisible();
});

test('the Sessions page says why a chat could not be deleted', async ({ page }) => {
  await portal(page, true);
  await page.goto('/sessions');
  const main = page.locator('.sessions-list');
  const row = main.getByRole('listitem').filter({ hasText: 'Second chat' });
  await row.hover();
  await row.getByRole('button', { name: 'Delete Second chat' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(main.getByRole('alert')).toContainText('Could not delete "Second chat": The disk is full');
  await main.getByRole('button', { name: 'Dismiss' }).click();
  await expect(main.getByRole('alert')).toHaveCount(0);
});

test('a row on the Sessions page is reached with Tab and opened with Enter, and its buttons show while one has the focus', async ({ page }) => {
  await portal(page);
  await page.goto('/sessions');
  const row = page.locator('.sessions-list').getByRole('listitem').filter({ hasText: 'First chat' });
  const actions = row.getByRole('button', { name: 'Pin First chat' }).locator('..');
  await expect(actions).toHaveCSS('opacity', '0');
  await row.focus();
  await expect(row).toBeFocused();
  // The next Tab is the row's first button, which has to be seen to be used.
  await page.keyboard.press('Tab');
  await expect(row.getByRole('button', { name: 'Pin First chat' })).toBeFocused();
  await expect(actions).toHaveCSS('opacity', '1');
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/s\/a$/);
});
