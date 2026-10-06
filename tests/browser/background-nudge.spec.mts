import { test, expect } from './portal-mock';

test('a status that moves many times a second is shown from its events, without asking for the background list again', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=nudge');
  // Forty changes over two seconds. The portal's list says nothing of them: what shows came with the events.
  await expect(page.getByLabel('Running beside the conversation').getByText('working 40')).toBeVisible({ timeout: 5000 });
  const asked = await page.evaluate(() => (window as any).backgroundAsked);
  // Its first answer, and the poll every two seconds while the chat is working: none for the statuses.
  expect(asked).toBeLessThanOrEqual(3);
});

test('the list of what runs beside the chat is not asked for while the page is hidden, and at once when it is seen again', async ({ page }) => {
  await page.clock.install();
  await page.goto('/tests/chat.html?phase=nudge');
  await page.clock.runFor(3000);
  const asked = () => page.evaluate(() => (window as any).backgroundAsked as number);
  const hide = (hidden: boolean) => page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { value: h, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await hide(true);
  const before = await asked();
  // Half a minute of nobody looking: far more than the poll's period, and not one request.
  await page.clock.runFor(30_000);
  expect(await asked()).toBe(before);
  await hide(false);
  await expect.poll(asked).toBeGreaterThan(before);
});
