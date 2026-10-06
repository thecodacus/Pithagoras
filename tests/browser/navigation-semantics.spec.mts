import { test, expect, mockPortal } from './portal-mock';

/** What a screen reader is told about where it is: the page the sidebar is on, and what a terminal says. */

test('the expanded sidebar names its navigation and says which page is open', async ({ page }) => {
  await mockPortal(page, ({ path: p }) => {
    if (p === '/api/projects') return { root: '/w', home: '/h', projects: [] };
    if (p === '/api/sessions') return { sessions: [], executor: 'host' };
  });
  await page.goto('/sessions');
  const nav = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('navigation', { name: 'Destinations' });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Sessions' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('button', { name: 'Projects' })).not.toHaveAttribute('aria-current', /.+/);
  await nav.getByRole('button', { name: 'Projects' }).click();
  await expect(nav.getByRole('button', { name: 'Projects' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('button', { name: 'Sessions' })).not.toHaveAttribute('aria-current', /.+/);
});

test('the terminal is readable by a screen reader, and its input is named', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=tools');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('tab', { name: 'Your shell' }).click();
  // xterm draws its screen in a canvas; in screen reader mode it adds the rows and the live region.
  await expect(page.locator('.xterm-accessibility')).toBeAttached();
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeAttached();
});
