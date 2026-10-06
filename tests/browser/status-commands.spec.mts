import { test, expect } from './portal-mock';

test('a status that names a command runs it when clicked, and one that does not stays text', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=agents');
  const tray = page.getByLabel('Running beside the conversation');
  const update = tray.getByRole('button', { name: /bg-update/ });
  await expect(update).toBeVisible();
  await expect(update).toHaveAttribute('title', 'bg-update — click to run /bg-update');
  // A path is not a command: it stays plain text.
  await expect(tray.getByText('logs in /tmp/bg')).toBeVisible();
  await expect(tray.getByRole('button', { name: /tmp/ })).toHaveCount(0);
  await update.click();
  await expect.poll(() => page.evaluate(() => (window as any).sent)).toEqual(['/bg-update']);
});

test('an extension fills the chat box, as pi names it outside the host too, and two fills at once both land', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=editor');
  await expect(page.getByRole('textbox').last()).toHaveValue('/deploy --prod');
});

test('opening another chat does not ask it for its commands because of the last chat\'s status', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=switch');
  // The first chat's status names a command, so it is asked for its list.
  await expect.poll(() => page.evaluate(() => (window as any).commandsAsked)).toContain('first');
  await page.getByRole('button', { name: 'Open the second chat' }).click();
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as any).commandsAsked)).not.toContain('second');
});

test('a status left by a pi that has gone stays text, and starts no pi to find out', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=gone');
  const tray = page.getByLabel('Running beside the conversation');
  await expect(tray.getByText('bg ⬆ v2.6.5 /bg-update')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).commandsAsked)).toEqual(['/commands?ifRunning=1']);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).commandsAsked)).toEqual(['/commands?ifRunning=1']);
  await expect(tray.getByRole('button', { name: /bg-update/ })).toHaveCount(0);
});

test('an extension pastes where the cursor is, and reads what was typed', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=paste');
  const box = page.getByRole('textbox').last();
  await box.fill('fix build');
  await expect.poll(() => page.evaluate(() => (window as any).drafts.at(-1)?.text)).toBe('fix build');
  await box.press('Home');
  for (let i = 0; i < 4; i++) await box.press('ArrowRight');
  // Where the cursor went is told too, for a paste the portal makes in its copy of the box.
  await expect.poll(() => page.evaluate(() => (window as any).drafts.at(-1))).toEqual({ text: 'fix build', caret: { start: 4, end: 4 } });
  await page.getByRole('button', { name: 'Paste from the extension' }).click();
  await expect(box).toHaveValue('fix the build');
  // Once, however often the chat draws again.
  await box.press('End');
  await box.pressSequentially('!');
  await expect(box).toHaveValue('fix the build!');
});

test('what is typed is told to the portal only while the chat\'s pi is up, and at once when it comes up', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=paste&pi=off');
  const box = page.getByRole('textbox').last();
  await box.fill('fix build');
  await box.press('Home');
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as any).drafts)).toEqual([]);
  // pi starts: the next look at the background list says so, and the box is told once.
  await page.evaluate(() => ((window as any).piUp = true));
  await expect.poll(() => page.evaluate(() => (window as any).drafts), { timeout: 10_000 }).toEqual([{ text: 'fix build', caret: { start: 0, end: 0 } }]);
});

test('an extension that fills the box with what is already there leaves the cursor where the person puts it', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=paste');
  const box = page.getByRole('textbox').last();
  await box.fill('/deploy');
  await page.evaluate(() => (window as any).fillBox('/deploy'));
  // The person puts the cursor after the slash, and types.
  await box.press('Home');
  await box.press('ArrowRight');
  // The cursor jumped after the first key, if it was left to be placed: the second landed elsewhere.
  await box.pressSequentially('xy');
  await expect(box).toHaveValue('/xydeploy');
});
