import { type Page } from '@playwright/test';
import { test, expect } from './portal-mock';

const box = (page: Page) => page.getByTestId('box');
const left = (page: Page) => box(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/follow.html');
  await expect(box(page)).toBeVisible();
  await expect.poll(() => left(page)).toBeLessThanOrEqual(1);
});

test('a box drawn again as another element is still kept at its end as it grows', async ({ page }) => {
  await page.evaluate(() => (window as any).redraw());
  await expect.poll(() => left(page)).toBeLessThanOrEqual(1);
  // Grown with no word from the component: only the watch on the box can follow it. It watched the first box, gone.
  await page.evaluate(() => (window as any).grow(200));
  await frames(page);
  expect(await left(page)).toBeLessThanOrEqual(1);
});

test('opening the first entry in a box whose entries are its own children keeps what was pressed in place', async ({ page }) => {
  const toggle = page.getByRole('button', { name: 'Entry 1' });
  await expect(toggle).toBeInViewport();
  const before = (await toggle.boundingBox())!.y;
  await toggle.click();
  await frames(page);
  // Measured as the entry's head, not the entry, it did not see the entry open, and followed the end up and away.
  expect(Math.abs((await toggle.boundingBox())!.y - before)).toBeLessThan(2);
});
