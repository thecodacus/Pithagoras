import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * The picture tools in the tool lists. The portal registers show_image,
 * generate_image and edit_image from three extensions of its own, so three
 * labels reach the page; every list with groups shows them in one box, called
 * Images. An extension's tool of one of those names stays with its extension.
 */
const pictures = [
  { name: 'show_image', source: 'pictures', inline: true },
  { name: 'generate_image', source: 'image-generation', inline: true },
  { name: 'edit_image', source: 'image-editing', inline: true },
];
const others = [{ name: 'web_search', source: 'pi-web-access' }, { name: 'todo', source: 'pi-todo' }];

/** The portal with no server: Settings → Tools and a project's Tools, over canned answers. */
async function portal(page: Page, { extension = false, path = '/settings/tools' } = {}) {
  const puts: string[][] = [];
  const seen = [...pictures.filter((tool) => !(extension && tool.name === 'generate_image')), ...(extension ? [{ name: 'generate_image', source: 'my-images' }] : []), ...others];
  await mockPortal(page, async ({ path: p, method, json }) => {
    if (p === '/api/projects') return { root: '/w', home: '/h', projects: [{ name: 'demo', path: '/w/demo', isGit: false, hasInstructions: false, hasTools: false, sessions: 0, lastActive: null }] };
    if (p === '/api/tools' && method === 'GET') return { tools: seen.map((tool) => ({ ...tool, defaultOn: true })), off: [], names: {} };
    if (p === '/api/tools' && method === 'PUT') {
      const { off } = json();
      puts.push(off);
      return { off, applied: 0 };
    }
    if (p === '/api/projects/demo/tools' && method === 'PUT') {
      const { off } = json();
      puts.push(off);
      return { off, applied: 0 };
    }
    if (p === '/api/projects/demo/tools') return { live: false, off: [], names: {}, tools: seen.map((tool) => ({ ...tool, enabled: true, defaultOn: true })) };
  }, { settings: true });
  await page.addInitScript(() => localStorage.removeItem('toolGroupsOpen'));
  await page.goto(path);
  return { puts };
}

/** Every box of the list, by its heading, and what a box holds once opened. */
const box = (page: Page, name: RegExp) => page.getByRole('button', { name, expanded: false }).or(page.getByRole('button', { name, expanded: true }));

test('Settings → Tools shows the three picture tools in one box called Images', async ({ page }) => {
  const { puts } = await portal(page);
  await expect(page.getByRole('button', { name: /^pi-web-access/ })).toBeVisible();
  const images = box(page, /^Images/);
  await expect(images).toHaveCount(1);
  await expect(images).toContainText('3 on');
  // Not a box of their own, whichever extension registered each.
  for (const label of ['pictures', 'image-generation', 'image-editing']) await expect(page.getByText(label, { exact: true })).toHaveCount(0);
  await images.click();
  for (const name of ['show_image', 'generate_image', 'edit_image']) await expect(page.getByRole('checkbox', { name })).toBeVisible();
  // The box's switch takes all three along.
  await images.locator('xpath=..').getByRole('button', { name: 'all off' }).click();
  await expect.poll(() => puts.at(-1)?.length).toBeGreaterThan(0);
  expect([...puts.at(-1)!].sort()).toEqual(['edit_image', 'generate_image', 'show_image']);
});

test("an extension's generate_image stays in its own box, and Images keeps the portal's other two", async ({ page }) => {
  await portal(page, { extension: true });
  const images = box(page, /^Images/);
  await expect(images).toContainText('2 on');
  await expect(box(page, /^my-images/)).toContainText('1 on');
  await images.click();
  await expect(page.getByRole('checkbox', { name: 'show_image' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'edit_image' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'generate_image' })).toBeHidden();
  await box(page, /^my-images/).click();
  await expect(page.getByRole('checkbox', { name: 'generate_image' })).toBeVisible();
});

test("Projects → Tools shows them in the same one box", async ({ page }) => {
  const { puts } = await portal(page, { path: '/projects' });
  await page.getByRole('button', { name: 'Tools for demo' }).click();
  const dialog = page.getByRole('dialog');
  const images = dialog.getByRole('button', { name: /^Images/ });
  await expect(images).toHaveCount(1);
  await expect(images).toContainText('3 on');
  for (const label of ['pictures', 'image-generation', 'image-editing']) await expect(dialog.getByText(label, { exact: true })).toHaveCount(0);
  await images.click();
  await dialog.getByRole('checkbox', { name: 'show_image' }).uncheck();
  await expect.poll(() => puts).toEqual([['show_image']]);
  await expect(images).toContainText('1 of 3 off');
});

test("a chat's tools control shows them in the same one box", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=git');
  await page.getByRole('button', { name: 'Which tools this conversation may use' }).click();
  const menu = page.locator('.composer-menu');
  const images = menu.getByRole('button', { name: /^Images/ });
  await expect(images).toHaveCount(1);
  await expect(images).toContainText('3 on');
  for (const label of ['pictures', 'image-generation', 'image-editing']) await expect(menu.getByText(label, { exact: true })).toHaveCount(0);
  await images.click();
  for (const name of ['show_image', 'generate_image', 'edit_image']) await expect(menu.getByRole('checkbox', { name })).toBeVisible();
  await menu.getByRole('checkbox', { name: 'show_image' }).uncheck();
  await expect.poll(() => page.evaluate(() => (window as any).sentTools)).toEqual([['show_image']]);
  await expect(images).toContainText('1 of 3 off');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the Images box fits a phone, ${scheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await portal(page);
    const images = box(page, /^Images/);
    await images.click();
    await expect(page.getByRole('checkbox', { name: 'edit_image' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
}

test('Escape in the name field of a tool group cancels the rename, and does not close Settings', async ({ page }) => {
  await portal(page);
  await page.getByRole('button', { name: /^Rename pi-web-access/ }).click();
  const field = page.getByRole('textbox', { name: /^Name for pi-web-access/ });
  await field.fill('Search');
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  // Nothing was renamed, and the next Escape is the dialog's own.
  await expect(page.getByRole('button', { name: /^pi-web-access/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
});
