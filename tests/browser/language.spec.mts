import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/** The portal with no server: enough canned answers for Settings and the sidebar to draw. */
const portal = (page: Page) => mockPortal(page, ({ path }) => {
  if (path === '/api/models') return { models: [{ provider: 'llama-swap', id: 'model-a', name: 'Model A', contextWindow: 65536, reasoning: true }], providers: { 'llama-swap': 'llama-swap' } };
}, { settings: true });

const pickLanguage = async (page: Page, name: RegExp) => {
  await page.getByRole('combobox', { name: /^(Language|Sprache)$/ }).click();
  await page.getByRole('option', { name }).click();
};

test('the portal can be switched to German and back, and keeps the choice', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/browser');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Appearance', { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await pickLanguage(page, /^Deutsch/);
  // Drawn again at once, the page it was changed on included.
  await expect(dialog.getByText('Darstellung', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Einstellungen' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.getByRole('button', { name: 'Sitzungen' }).first()).toBeVisible();

  // Remembered in this browser.
  await page.reload();
  await expect(page.getByRole('dialog').getByText('Darstellung', { exact: true })).toBeVisible();

  await pickLanguage(page, /^English/);
  await expect(page.getByRole('dialog').getByText('Appearance', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('dialog').getByText('Appearance', { exact: true })).toBeVisible();
});

/** Which files of the portal's languages the page asked for. */
const askedForLanguages = (page: Page) => {
  const asked: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (/\/locales\/(?!index)[\w-]+(\.ts|-[\w-]+\.js)$/.test(path)) asked.push(path);
  });
  return asked;
};

test('an English page does not fetch the German text, and picking German fetches it then', async ({ page }) => {
  await portal(page);
  const asked = askedForLanguages(page);
  await page.goto('/settings/browser');
  await expect(page.getByRole('dialog').getByText('Appearance', { exact: true })).toBeVisible();
  expect(asked).toEqual([]);
  await pickLanguage(page, /^Deutsch/);
  await expect(page.getByRole('dialog').getByText('Darstellung', { exact: true })).toBeVisible();
  expect(asked).toHaveLength(1);
});

test.describe('in a browser set to German', () => {
  test.use({ locale: 'de-DE' });

  test('the portal speaks German until another language is chosen', async ({ page }) => {
    await portal(page);
    await page.goto('/settings/browser');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Darstellung', { exact: true })).toBeVisible();
    // The choice that follows the browser names what it comes to.
    await expect(page.getByRole('combobox', { name: 'Sprache' })).toContainText('Wie der Browser');

    await pickLanguage(page, /^English/);
    await expect(dialog.getByText('Appearance', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('dialog').getByText('Appearance', { exact: true })).toBeVisible();

    // Back to the browser's.
    await pickLanguage(page, /^Match the browser/);
    await expect(page.getByRole('dialog').getByText('Darstellung', { exact: true })).toBeVisible();
  });

  test('the German text is there before the first draw, not English for a moment first', async ({ page }) => {
    await portal(page);
    const asked = askedForLanguages(page);
    // The first words of the page, in whatever language they are drawn: seen as they are drawn.
    await page.addInitScript(() => {
      (window as any).words = [];
      new MutationObserver(() => {
        const text = document.body?.innerText ?? '';
        if (/Sitzungen|Sessions/.test(text) && !(window as any).words.length) (window as any).words.push(/Sitzungen/.test(text) ? 'de' : 'en');
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto('/sessions');
    await expect(page.getByRole('button', { name: 'Sitzungen' }).first()).toBeVisible();
    expect(asked).toHaveLength(1);
    expect(await page.evaluate(() => (window as any).words)).toEqual(['de']);
  });

  test('a setting is found by its German name and by its English one', async ({ page }) => {
    await portal(page);
    await page.goto('/settings/general');
    const search = page.getByRole('combobox', { name: 'Einstellungen durchsuchen' });
    await search.fill('Design');
    await expect(page.getByRole('option').first()).toContainText('Design');
    await search.fill('theme');
    await expect(page.getByRole('option').first()).toContainText('Design');
    await page.getByRole('option').first().click();
    await expect(page.getByRole('dialog').getByRole('radiogroup', { name: 'Design' })).toBeVisible();
  });
});
