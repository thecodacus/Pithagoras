import { type Page } from '@playwright/test';
import { test, expect } from './portal-mock';

const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Where each word of the preview is, from the bottom of its box, and how high the box is. */
const look = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector('.chat-thinking-stream')!.getBoundingClientRect();
    const node = document.querySelector('.chat-thinking-stream > div')!.firstChild!;
    const text = node.textContent!;
    const range = document.createRange();
    const at: Record<string, [number, number]> = {};
    // The last words: all of them each time would take the test too long.
    for (const m of [...text.matchAll(/w\d+x*/g)].slice(-30)) {
      range.setStart(node, m.index!);
      range.setEnd(node, m.index! + m[0].length);
      const r = range.getClientRects()[0];
      at[m[0]] = [Math.round(r.left * 10) / 10, Math.round((box.bottom - r.top) * 10) / 10];
    }
    return { height: box.height, at };
  });

// Words that differ in length, so the lines break unevenly. All one paragraph: a line break of the model's own
// ends a reflow, and a long paragraph is what shows it.
const word = (i: number) => ` w${i}${'x'.repeat(i % 7)}`;

for (const [name, size] of [['a desktop', { width: 1000, height: 700 }], ['a phone', { width: 390, height: 760 }]] as const) {
  test(`the reasoning preview on ${name} keeps its size, and what it shows does not reflow, as more arrives`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/tests/chat.html?phase=reasoning');
    await expect(page.getByText('And the last one?')).toBeVisible();
    await frames(page);
    // It grows with the first lines, up to three, over a moment.
    for (let i = 0; i < 60; i++) await page.evaluate((w) => (window as any).think(w), word(i));
    await page.waitForTimeout(500);
    let before = await look(page);
    const full = before.height;
    expect(full).toBeGreaterThan(50);
    let seen = 0;
    // Far past what the preview kept of the end before: it moved on with every word then.
    for (let i = 60; i < 260; i++) {
      await page.evaluate((w) => (window as any).think(w), word(i));
      await frames(page);
      const now = await look(page);
      expect(now.height, `height after word ${i}`).toBe(full);
      // Words already shown stay where they were across, and only go up when a line begins below them.
      for (const [w, [x, y]] of Object.entries(now.at)) {
        const was = before.at[w];
        if (!was) continue;
        seen++;
        expect(x, `${w} after word ${i}`).toBe(was[0]);
        expect(y, `${w} after word ${i}`).toBeGreaterThanOrEqual(was[1] - 0.5);
      }
      before = now;
    }
    expect(seen).toBeGreaterThan(3000);
  });
}
