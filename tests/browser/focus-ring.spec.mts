import { type Locator, type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * Where the focus is, drawn so that it is found: the accent in full as an outline, on a field, a checkbox, a
 * dropdown and a button, in both themes.
 */

async function portal(page: Page, theme: 'light' | 'dark') {
  await mockPortal(page, ({ path: p }) => {
    if (p === '/api/projects') return { root: '/w', home: '/h', projects: [] };
    if (p === '/api/sessions') return { sessions: [], executor: 'host' };
  }, { settings: true });
  await page.addInitScript((value) => localStorage.setItem('pithagoras.theme', value), theme);
}

/** The outline the browser draws round `el` while it has the focus, and the accent it should be. */
async function ring(el: Locator) {
  await el.focus();
  await expect(el).toBeFocused();
  return el.evaluate((node) => {
    const style = getComputedStyle(node);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().split(/\s+/).map(Number);
    return { width: style.outlineWidth, style: style.outlineStyle, colour: style.outlineColor, accent: `rgb(${accent.join(', ')})` };
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: a field, a checkbox, a dropdown and a button show the focus as the accent in full`, async ({ page }) => {
    await portal(page, theme);
    await page.goto('/settings/general');
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // A checkbox of the page's own kind: none is on this page, and the rule is the page's, not the dialog's.
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<input id="probe" type="checkbox" aria-label="Probe" style="position:fixed;top:4px;left:4px">'));
    const checkbox = page.locator('#probe');
    const select = dialog.locator('.ui-select').first();
    const button = dialog.getByRole('button').first();
    // Whatever kind of control the page has, each is outlined in the full accent.
    for (const el of [checkbox, select, button]) {
      await expect(el).toBeVisible();
      const r = await ring(el);
      expect(r.style).toBe('solid');
      expect(r.width).toBe('2px');
      expect(r.colour).toBe(r.accent);
    }
    await page.goto('/sessions');
    const field = page.getByRole('textbox', { name: /Search by name/ });
    const r = await ring(field);
    expect(r.style).toBe('solid');
    expect(r.colour).toBe(r.accent);
    // Its border changes colour over a moment.
    await expect.poll(() => field.evaluate((el) => getComputedStyle(el).borderColor)).toBe(r.accent);
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: a slider with the focus is drawn differently, on its thumb, while its outline is off`, async ({ page }) => {
    await portal(page, theme);
    await page.goto('/sessions');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<input id="probe" type="range" aria-label="Probe" style="position:fixed;top:20px;left:20px;width:160px">'));
    const slider = page.locator('#probe');
    const box = (await slider.boundingBox())!;
    // The ring is on the thumb and reaches past the slider's own box, so a little more than it is taken.
    const clip = { x: box.x - 10, y: box.y - 10, width: box.width + 20, height: box.height + 20 };
    const before = await page.screenshot({ clip, animations: 'disabled' });
    await slider.focus();
    await expect(slider).toBeFocused();
    // The browser's own outline is off for a slider, so what changes in the picture is the ring the page draws on the thumb.
    expect(await slider.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe('none');
    const after = await page.screenshot({ clip, animations: 'disabled' });
    expect(after.equals(before), 'the focused slider looks like the one without').toBe(false);
  });
}
