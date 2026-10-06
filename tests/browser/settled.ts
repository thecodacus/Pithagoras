import { type Page } from '@playwright/test';

/**
 * Waits until nothing on the page is still moving: every CSS transition and animation that has an end has ended, and
 * the frames after it have started no new one. A box is where it stays only after the transitions that bring it there
 * have run, so a test that measures one waits for this and not for a time that is about as long as they take: under
 * load that time is too short, and on a quiet machine it is too long. Animations that never end (a pulse) do not
 * count. After ten seconds it gives up, and the test goes on to fail on what it measures.
 */
export async function settled(page: Page) {
  await page.evaluate(async () => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const giveUp = performance.now() + 10_000;
    for (let quiet = 0; quiet < 3 && performance.now() < giveUp; ) {
      await frame();
      const moving = document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity);
      if (moving.length) {
        await Promise.race([Promise.allSettled(moving.map((a) => a.finished)), new Promise((resolve) => setTimeout(resolve, 5000))]);
        quiet = 0;
      } else quiet++;
    }
  });
}
