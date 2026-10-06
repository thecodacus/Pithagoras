import { type Page } from '@playwright/test';
import { test, expect } from './portal-mock';

/**
 * The avatar draws only what is seen: at the size it is shown at, not at a
 * fixed 1200 by 1200; not at all while it is out of view; and slowly where
 * nobody can tell the difference (a thumbnail, reduced motion).
 */
const frames = (page: Page) => page.evaluate(() => ({ ...(window as any).frames }) as Record<string, number>);

/** How often each was drawn in a second. */
async function perSecond(page: Page) {
  const before = await frames(page);
  await page.waitForTimeout(1000);
  const after = await frames(page);
  return Object.fromEntries(['big', 'thumb', 'away'].map((id) => [id, (after[id] ?? 0) - (before[id] ?? 0)]));
}

const pixels = (page: Page, id: string) => page.locator(`#${id} canvas`).evaluate((c: HTMLCanvasElement) => c.width);

test('an avatar is drawn at the size it is shown at, and only while it is in view', async ({ page }) => {
  await page.goto('/tests/orb.html');
  await expect(page.locator('#big canvas')).toBeVisible();
  await page.waitForTimeout(500);
  // Not 1200 pixels each, whatever it is shown as: its canvas is 43% wider than the 300 and 60 it is given.
  expect(await pixels(page, 'big')).toBeLessThan(600);
  expect(await pixels(page, 'thumb')).toBeLessThan(200);
  const rate = await perSecond(page);
  expect(rate.big).toBeGreaterThan(30);
  // A thumbnail is drawn a few times a second, not sixty.
  expect(rate.thumb).toBeGreaterThan(5);
  expect(rate.thumb).toBeLessThan(25);
  // Below the fold: not drawn at all.
  expect(rate.away).toBeLessThanOrEqual(2);

  await page.locator('#away').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  expect((await perSecond(page)).away).toBeGreaterThan(5);
  // And not again once it is out of view.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  expect((await perSecond(page)).away).toBeLessThanOrEqual(2);
});

test('with reduced motion even the large avatar is drawn slowly', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/tests/orb.html');
  await expect(page.locator('#big canvas')).toBeVisible();
  await page.waitForTimeout(500);
  expect((await perSecond(page)).big).toBeLessThan(25);
});
