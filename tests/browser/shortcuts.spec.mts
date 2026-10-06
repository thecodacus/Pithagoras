import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

const portal = (page: Page) => mockPortal(page, undefined, { settings: true });

test('Tab ends the listening for a new shortcut and moves on, instead of becoming the shortcut', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/shortcuts');
  const row = page.getByRole('listitem', { name: 'Mute or unmute the microphone' });
  await expect(row.locator('kbd')).toHaveText('M');
  await row.getByRole('button', { name: 'Change' }).click();
  await expect(row).toContainText('Press the new keys');
  await page.keyboard.press('Tab');
  await expect(row).not.toContainText('Press the new keys');
  await expect(page.getByRole('status').filter({ hasText: 'Tab moves between buttons' })).toBeVisible();
  // Still M, and nothing stored: Tab was not kept.
  await expect(row.locator('kbd')).toHaveText('M');
  expect(await page.evaluate(() => localStorage.getItem('keybindings'))).toBeNull();
  // The key did what it always does: the focus is on, not left on the button that was pressed.
  await expect(row.getByRole('button', { name: 'Change' })).not.toBeFocused();
  // Another key is still taken as before.
  await row.getByRole('button', { name: 'Change' }).click();
  await page.keyboard.press('k');
  await expect(row.locator('kbd')).toHaveText('K');
});
