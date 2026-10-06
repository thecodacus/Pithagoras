import { test, expect } from './portal-mock';

/** A chat's devices: the chip beside the browser's globe, and the card of a call made on a device. Over `?phase=devices` of the chat fixture. */

test('a chat is granted a paired device from the chip, in a folder there, and gives it back', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=devices');
  const chip = page.getByRole('button', { name: 'Devices', exact: true });
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  await chip.click();
  const list = page.getByRole('dialog', { name: 'Devices for this chat' });
  // One that is not connected cannot be granted, and says why.
  const desk = list.getByRole('listitem', { name: 'desk' });
  await expect(desk.getByText('desk is not connected')).toBeVisible();
  await expect(desk.getByRole('switch', { name: 'Let this chat use desk' })).toBeDisabled();

  const laptop = list.getByRole('listitem', { name: 'laptop' });
  await laptop.getByRole('switch', { name: 'Let this chat use laptop' }).click();
  await expect(laptop.getByRole('switch', { name: 'Let this chat use laptop' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('granted-devices')).toHaveText('1');
  // A path of its own, or one the device offers (a list under the field).
  const folder = laptop.getByRole('combobox', { name: 'Folder on laptop' });
  await expect(folder).toHaveValue('/home/alice');
  await folder.fill('/home/alice/src');
  await folder.press('Enter');
  await expect(list.getByRole('status')).toHaveText('The chat takes this up once its current run is over.');
  await expect(folder).toHaveValue('/home/alice/src');

  await laptop.getByRole('switch', { name: 'Let this chat use laptop' }).click();
  await expect(laptop.getByRole('combobox', { name: 'Folder on laptop' })).toHaveCount(0);
  await expect(page.getByTestId('granted-devices')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).sentDevices)).toEqual([
    { method: 'PUT', id: 'd1', body: {} },
    { method: 'PUT', id: 'd1', body: { cwd: '/home/alice/src' } },
    { method: 'DELETE', id: 'd1', body: null },
  ]);
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(chip).toBeFocused();
});

test('a device the chat has, in a chat whose tools another extension owns, says why it will not work', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=devices-blocked');
  await page.getByRole('button', { name: 'Devices', exact: true }).click();
  const tower = page.getByRole('dialog', { name: 'Devices for this chat' }).getByRole('listitem', { name: 'tower' });
  await expect(tower.getByRole('switch', { name: 'Let this chat use tower' })).toHaveAttribute('aria-checked', 'true');
  await expect(tower.getByText('Another extension owns bash in this chat, so they cannot take a device')).toBeVisible();
});

test('a call made on a device names it on its card', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=devices');
  const card = page.locator('.chat-tool').filter({ hasText: 'cargo test' });
  const badge = card.locator('.chat-tool-badge.is-device');
  await expect(badge).toHaveText('laptop');
  await expect(badge).toHaveAttribute('title', 'On the device laptop');
  // A call on the server has none.
  await expect(page.locator('.chat-tool').filter({ hasText: 'npm run build' }).locator('.is-device')).toHaveCount(0);
  // Nor has another tool's parameter that happens to be called device.
  await expect(page.locator('.chat-tool').filter({ hasText: 'lights_set' })).toHaveCount(1);
  await expect(page.locator('.chat-tool').filter({ hasText: 'lights_set' }).locator('.is-device')).toHaveCount(0);
});

test('without the Devices add-on there is no chip', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=tools');
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Devices', exact: true })).toHaveCount(0);
});

test('the list fits a phone, opened from a chip near the left of the header', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/tests/chat.html?phase=devices');
  await page.getByRole('button', { name: 'Devices', exact: true }).click();
  const box = (await page.getByRole('dialog', { name: 'Devices for this chat' }).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(16);
  expect(box.x + box.width).toBeLessThanOrEqual(375 - 16);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

/**
 * What the chat's devices hold for it, served as the portal does: it outlives a reload, and the test changes it as the device or the Devices page would.
 * Also what makes a look-up go wrong or late: `fail` answers 502 that many times, `off` answers as a portal without the add-on, `hold` keeps a look-up
 * on its way until the test lets it go (what it answers is what was pending when it was asked), and `latency` slows an answer to a card.
 */
async function asking(page: import('@playwright/test').Page) {
  const approval = (id: number, over: Record<string, unknown> = {}) => ({
    device: { id: 'd1', name: 'laptop' },
    approval: { id, call: 4, chat: 'preview', tool: 'bash', target: 'make deploy-to-production-with-a-very-long-target-name-that-must-wrap', reasons: ['Ask mode: every call asks'], preview: null, choices: ['once', 'chat', 'time', 'deny'], max_minutes: 60, created_ms: 0, expires_ms: 0, cut: false, ...over },
  });
  const state = { pending: [approval(7)], answers: [] as { path: string; body: any }[], asked: 0, held: 0, fail: 0, off: false, hold: null as Promise<void> | null, latency: 0 };
  await page.route('**/api/sessions/preview/devices/approvals', async (route) => {
    state.asked++;
    if (state.off) return route.fulfill({ status: 404, json: { error: 'Devices are switched off in this portal' } });
    if (state.fail > 0) {
      state.fail--;
      return route.fulfill({ status: 502, json: { error: 'Bad gateway' } });
    }
    const approvals = state.pending;
    if (state.hold) {
      state.held++;
      await state.hold;
    }
    return route.fulfill({ json: { approvals } });
  });
  await page.route('**/api/devices/d1/approvals/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    state.answers.push({ path, body: route.request().postDataJSON() });
    if (state.latency) await new Promise((r) => setTimeout(r, state.latency));
    state.pending = state.pending.filter((a) => !path.endsWith(`/${a.approval.id}`));
    return route.fulfill({ json: { ok: true } });
  });
  return { state, approval };
}

test('a question a device asks for the chat is a card in the chat, answered there', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const { state } = await asking(page);
  await page.goto('/tests/chat.html?phase=devices');
  const card = page.getByTestId('device-approval');
  await expect(card.getByText('laptop asks: bash')).toBeVisible();
  await expect(card.getByText(/^make deploy-to-production/)).toBeVisible();
  await expect(card.getByText('Ask mode: every call asks')).toBeVisible();
  // It is the chat's own: no link back to it. And it sits above the composer, not in a dialog.
  await expect(card.getByRole('link', { name: 'from this chat' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const above = (await card.boundingBox())!.y + (await card.boundingBox())!.height;
  expect(above).toBeLessThanOrEqual((await page.getByRole('textbox', { name: 'Message' }).boundingBox())!.y);
  // Only what the device offers, for as long as it allows.
  await expect(card.getByRole('combobox', { name: 'Minutes' }).locator('option')).toHaveText(['15 minutes', '30 minutes', '60 minutes']);
  await card.getByRole('combobox', { name: 'Minutes' }).selectOption('60');
  await card.getByRole('button', { name: 'Allow for', exact: true }).click();
  await expect(page.getByTestId('device-approval')).toHaveCount(0);
  expect(state.answers).toEqual([{ path: '/api/devices/d1/approvals/7', body: { answer: 'time', minutes: 60, created_ms: 0 } }]);
});

test('Allow once and Deny in the chat answer the device with that choice', async ({ page }) => {
  const { state, approval } = await asking(page);
  await page.goto('/tests/chat.html?phase=devices');
  await page.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByTestId('device-approval')).toHaveCount(0);
  state.pending = [approval(8)];
  await page.getByRole('button', { name: 'Deny' }).click({ timeout: 8000 });
  await expect(page.getByTestId('device-approval')).toHaveCount(0);
  expect(state.answers).toEqual([
    { path: '/api/devices/d1/approvals/7', body: { answer: 'once', created_ms: 0 } },
    { path: '/api/devices/d1/approvals/8', body: { answer: 'deny', created_ms: 0 } },
  ]);
});

test('a question answered somewhere else goes from the chat, and a refused answer says so', async ({ page }) => {
  const { state, approval } = await asking(page);
  await page.goto('/tests/chat.html?phase=devices');
  await expect(page.getByTestId('device-approval')).toBeVisible();
  // On the device, on the Devices page, run out, or its call ended: the portal no longer lists it.
  state.pending = [];
  await expect(page.getByTestId('device-approval')).toHaveCount(0, { timeout: 8000 });

  // An answer the portal refuses (the chat lost the device meanwhile) is said, and the card stays until the portal drops it.
  state.pending = [approval(9)];
  await page.route('**/api/devices/d1/approvals/9', (route) => route.fulfill({ status: 409, json: { error: 'That chat no longer has this device, so the question is denied' } }));
  await page.getByRole('button', { name: 'Allow once' }).click({ timeout: 8000 });
  await expect(page.getByRole('alert').filter({ hasText: 'no longer has this device' })).toBeVisible();
  await expect(page.getByTestId('device-approval')).toBeVisible();
});

test('a chat opened or reloaded while a question waits shows it', async ({ page }) => {
  await asking(page);
  await page.goto('/tests/chat.html?phase=devices');
  await expect(page.getByTestId('device-approval')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('device-approval')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible();
});

test('the question is looked up when its call says it waits, not only at the next turn of the poll', async ({ page }) => {
  const { state } = await asking(page);
  const waiting = state.pending;
  state.pending = [];
  await page.goto('/tests/chat.html?phase=devices');
  await expect.poll(() => state.asked).toBeGreaterThan(0);
  await expect(page.getByTestId('device-approval')).toHaveCount(0);
  state.pending = waiting;
  await page.evaluate(() => (window as any).emit('tool_execution_update', { toolCallId: 'd1', partialResult: { content: [{ type: 'text', text: 'Waiting for approval on laptop…' }] } }));
  await expect(page.getByTestId('device-approval')).toBeVisible({ timeout: 2000 });
});

test('a chat that is not running holds no question to ask for', async ({ page }) => {
  const { state } = await asking(page);
  await page.goto('/tests/chat.html?phase=interrupted');
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(state.asked).toBe(0);
  await expect(page.getByTestId('device-approval')).toHaveCount(0);
});

test('the card fits a phone, with every choice reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await asking(page);
  await page.goto('/tests/chat.html?phase=devices');
  const card = page.getByTestId('device-approval');
  await expect(card).toBeVisible();
  const box = (await card.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  for (const name of ['Allow once', 'Allow for this chat', 'Allow for', 'Deny']) {
    const b = (await card.getByRole('button', { name, exact: true }).boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(390);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

/** Three questions, listed newest first as a portal need not list them: what the chat shows is decided by when each was asked. */
function threeAsked(approval: (id: number, over?: Record<string, unknown>) => any) {
  return [
    approval(9, { created_ms: 3000, tool: 'write', target: 'third-target' }),
    approval(7, { created_ms: 1000, tool: 'bash', target: 'first-target' }),
    approval(8, { created_ms: 2000, tool: 'edit', target: 'second-target' }),
  ];
}

test('several questions show one card, the oldest, with the others counted', async ({ page }) => {
  const { state, approval } = await asking(page);
  state.pending = threeAsked(approval);
  await page.goto('/tests/chat.html?phase=devices');
  const card = page.getByTestId('device-approval');
  await expect(card).toHaveCount(1);
  await expect(card.getByText('laptop asks: bash')).toBeVisible();
  await expect(card.getByText('first-target')).toBeVisible();
  const count = page.getByTestId('device-approval-count');
  await expect(count).toHaveText('Approval 1 of 3');
  await expect(count).toHaveAttribute('aria-live', 'polite');
  // The others are a short list, collapsed, and never a second card or an allow-all.
  const next = page.getByTestId('device-approval-next');
  await expect(next.getByText('second-target')).toBeHidden();
  await next.getByText('Waiting next').click();
  await expect(next.getByRole('listitem')).toHaveText(['laptop: edit · second-target', 'laptop: write · third-target']);
  await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /\ball\b|every/i })).toHaveCount(0);
});

test('answering a question moves the next one up, each decided on its own', async ({ page }) => {
  const { state, approval } = await asking(page);
  state.pending = threeAsked(approval);
  await page.goto('/tests/chat.html?phase=devices');
  const card = page.getByTestId('device-approval');
  await expect(card.getByText('first-target')).toBeVisible();
  await card.getByRole('button', { name: 'Deny' }).click();
  await expect(card.getByText('second-target')).toBeVisible();
  await expect(page.getByTestId('device-approval-count')).toHaveText('Approval 1 of 2');
  await card.getByRole('button', { name: 'Allow once' }).click();
  await expect(card.getByText('third-target')).toBeVisible();
  // The last one stands alone: no counter, no list.
  await expect(page.getByTestId('device-approval-count')).toBeHidden();
  await expect(page.getByTestId('device-approval-next')).toHaveCount(0);
  await card.getByRole('button', { name: 'Allow for this chat' }).click();
  await expect(card).toHaveCount(0);
  expect(state.answers).toEqual([
    { path: '/api/devices/d1/approvals/7', body: { answer: 'deny', created_ms: 1000 } },
    { path: '/api/devices/d1/approvals/8', body: { answer: 'once', created_ms: 2000 } },
    { path: '/api/devices/d1/approvals/9', body: { answer: 'chat', created_ms: 3000 } },
  ]);
});

test('the order is by when each was asked and does not move across polls; one answered elsewhere moves the next up', async ({ page }) => {
  const { state, approval } = await asking(page);
  state.pending = threeAsked(approval);
  await page.goto('/tests/chat.html?phase=devices');
  const card = page.getByTestId('device-approval');
  await expect(card.getByText('first-target')).toBeVisible();
  // Two more turns of the poll, the list coming in another order each time: the same card stays in front.
  const asked = state.asked;
  state.pending = [state.pending[1], state.pending[2], state.pending[0]];
  await expect.poll(() => state.asked, { timeout: 10000 }).toBeGreaterThanOrEqual(asked + 2);
  await expect(card.getByText('first-target')).toBeVisible();
  await expect(page.getByTestId('device-approval-count')).toHaveText('Approval 1 of 3');
  // A newer one joining does not take the place of the one in front.
  state.pending = [...state.pending, approval(10, { created_ms: 4000, target: 'fourth-target' })];
  await expect(page.getByTestId('device-approval-count')).toHaveText('Approval 1 of 4', { timeout: 8000 });
  await expect(card.getByText('first-target')).toBeVisible();
  // The one in front answered on the device: the next moves up.
  state.pending = state.pending.filter((a) => a.approval.id !== 7);
  await expect(card.getByText('second-target')).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('device-approval-count')).toHaveText('Approval 1 of 3');
});

test('with several questions the card and its list fit a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const { state, approval } = await asking(page);
  state.pending = threeAsked(approval);
  await page.goto('/tests/chat.html?phase=devices');
  const card = page.getByTestId('device-approval');
  await expect(card).toHaveCount(1);
  await page.getByTestId('device-approval-next').getByText('Waiting next').click();
  for (const el of [card, page.getByTestId('device-approval-count'), page.getByTestId('device-approval-next')]) {
    const box = (await el.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

// Characters that reorder or hide text, written as code points so that none sits in this file.
const RLO = String.fromCodePoint(0x202e);
const PDF = String.fromCodePoint(0x202c);
const ZWSP = String.fromCodePoint(0x200b);

test('a command is shown with its line breaks, and what would reorder or hide it is written out', async ({ page }) => {
  const { state, approval } = await asking(page);
  state.pending = [
    approval(7, { target: 'echo "build ok"\nrm -rf ~/projects', reasons: [`matches a${RLO}rule`], preview: `a\tb${RLO}c\nsecond line` }),
    approval(8, { created_ms: 1, target: `echo "${RLO}" ; rm -rf ~ ; echo "${PDF}" ok` }),
    approval(9, { created_ms: 2, target: `ls\nrm${ZWSP} -rf ~` }),
  ];
  await page.goto('/tests/chat.html?phase=devices');
  const card = page.getByTestId('device-approval');
  const target = card.getByTestId('device-approval-target');
  // Two lines, not one that reads as an echo: the break is there, and so is its shape on the page.
  await expect(target).toHaveCSS('white-space', 'pre-wrap');
  expect(await target.evaluate((el) => (el as HTMLElement).innerText)).toBe('echo "build ok"\nrm -rf ~/projects');
  const line = await target.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  expect((await target.boundingBox())!.height).toBeGreaterThan(line * 1.5);
  // Everything else the device or the model wrote: a control is its escape, shown as one.
  await expect(card.getByText('matches a\\u{202e}rule')).toBeVisible();
  await expect(card.locator('pre')).toHaveText('a\\tb\\u{202e}c\nsecond line');
  const text = await card.evaluate((el) => el.textContent ?? '');
  expect(text).not.toContain(RLO);

  // The next ones, in the list of what waits: on one line each, with the break and the controls written out.
  await page.getByTestId('device-approval-next').getByText('Waiting next').click();
  const next = page.getByTestId('device-approval-next').getByRole('listitem');
  await expect(next).toHaveText(['laptop: bash · echo "\\u{202e}" ; rm -rf ~ ; echo "\\u{202c}" ok', 'laptop: bash · ls\\nrm\\u{200b} -rf ~']);
  await expect(next.first().locator('[data-escape]')).toHaveCount(2);
  expect(await page.getByTestId('device-approval-next').evaluate((el) => el.textContent ?? '')).not.toMatch(new RegExp(`[${RLO}${PDF}${ZWSP}]`));
});

test('a command that is cut can only be denied, and says so', async ({ page }) => {
  const { state, approval } = await asking(page);
  // The portal lists it with Deny only; the card does not take Allow from what else it was told.
  state.pending = [approval(7, { target: `echo ${'a'.repeat(100)}…`, cut: true, choices: ['once', 'chat', 'time', 'deny'] })];
  await page.goto('/tests/chat.html?phase=devices');
  const card = page.getByTestId('device-approval');
  await expect(card.getByTestId('device-approval-cut')).toHaveText('Too long to read whole, so it can only be denied.');
  await expect(card.getByRole('button')).toHaveText(['Deny']);
  await expect(card.getByRole('combobox', { name: 'Minutes' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Deny' }).click();
  await expect(card).toHaveCount(0);
  expect(state.answers).toEqual([{ path: '/api/devices/d1/approvals/7', body: { answer: 'deny', created_ms: 0 } }]);
});

test('a long command scrolls in its own box, so the buttons stay in reach', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  const { state, approval } = await asking(page);
  state.pending = [approval(7, { target: Array.from({ length: 400 }, (_, i) => `echo line ${i}`).join('\n') })];
  await page.goto('/tests/chat.html?phase=devices');
  const card = page.getByTestId('device-approval');
  await expect(card.getByRole('button', { name: 'Deny' })).toBeInViewport();
  const target = card.getByTestId('device-approval-target');
  expect(await target.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect((await target.boundingBox())!.height).toBeLessThan(250);
});

test('a second click on the same spot soon after an answer does not answer the next question', async ({ page }) => {
  const { state, approval } = await asking(page);
  state.pending = threeAsked(approval);
  state.latency = 30;
  await page.goto('/tests/chat.html?phase=devices');
  const card = page.getByTestId('device-approval');
  const once = card.getByRole('button', { name: 'Allow once' });
  await expect(card.getByText('first-target')).toBeVisible();
  // A card holds its buttons back for a moment when it appears.
  await expect(once).toBeDisabled();
  await expect(once).toBeEnabled();
  const box = (await once.boundingBox())!;
  const spot = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(spot.x, spot.y);
  // A double click's second half, and an impatient third: the next card is there by then, with its button where the first one was.
  await page.waitForTimeout(120);
  await page.mouse.click(spot.x, spot.y);
  await page.waitForTimeout(130);
  await page.mouse.click(spot.x, spot.y);
  await expect(card.getByText('second-target')).toBeVisible();
  expect(state.answers).toEqual([{ path: '/api/devices/d1/approvals/7', body: { answer: 'once', created_ms: 1000 } }]);
  // Read, and then answered: the next card works once its moment is over.
  await expect(once).toBeEnabled();
  await once.click();
  await expect(card.getByText('third-target')).toBeVisible();
  expect(state.answers.map((a) => a.path)).toEqual(['/api/devices/d1/approvals/7', '/api/devices/d1/approvals/8']);
});

test('one look-up that fails does not stop the chat from asking: the poll goes on and shows the question', async ({ page }) => {
  const { state } = await asking(page);
  state.fail = 1;
  await page.goto('/tests/chat.html?phase=devices');
  await expect.poll(() => state.asked).toBeGreaterThan(0);
  // The first one was a 502: the next turn of the poll (a little later, not at once) finds the question.
  await expect(page.getByTestId('device-approval')).toBeVisible({ timeout: 9000 });
  expect(state.asked).toBeGreaterThanOrEqual(2);
});

test('a call that says it waits is looked up again after a failed look-up', async ({ page }) => {
  const { state } = await asking(page);
  const waiting = state.pending;
  state.pending = [];
  state.fail = 1;
  await page.goto('/tests/chat.html?phase=devices');
  await expect.poll(() => state.asked).toBeGreaterThan(0);
  await expect(page.getByTestId('device-approval')).toHaveCount(0);
  state.pending = waiting;
  await page.evaluate(() => (window as any).emit('tool_execution_update', { toolCallId: 'd1', partialResult: { content: [{ type: 'text', text: 'Waiting for approval on laptop…' }] } }));
  await expect(page.getByTestId('device-approval')).toBeVisible({ timeout: 2000 });
});

test('a portal without the add-on is not asked again, until a call says it waits', async ({ page }) => {
  const { state } = await asking(page);
  state.off = true;
  await page.goto('/tests/chat.html?phase=devices');
  await expect.poll(() => state.asked).toBe(1);
  // More than a turn of the poll: nothing more is asked of a portal that answered it has no such thing.
  await page.waitForTimeout(3600);
  expect(state.asked).toBe(1);
  await expect(page.getByTestId('device-approval')).toHaveCount(0);
  state.off = false;
  await page.evaluate(() => (window as any).emit('tool_execution_update', { toolCallId: 'd1', partialResult: { content: [{ type: 'text', text: 'Waiting for approval on laptop…' }] } }));
  await expect(page.getByTestId('device-approval')).toBeVisible({ timeout: 2000 });
});

/** Lets a look-up that is on its way go, for the test to end with. */
function holding(state: { hold: Promise<void> | null }) {
  let release = () => {};
  state.hold = new Promise<void>((r) => (release = r));
  return () => {
    state.hold = null;
    release();
  };
}

test('a look-up still on its way when another chat is opened does not put its questions in that chat', async ({ page }) => {
  const { state } = await asking(page);
  await page.goto('/tests/chat.html?phase=devices');
  await expect(page.getByTestId('device-approval')).toBeVisible();
  const release = holding(state);
  try {
    // The next turn of the poll is on its way (and will answer with this chat's question) when the other chat is opened.
    await expect.poll(() => state.held, { timeout: 8000 }).toBeGreaterThan(0);
    await page.evaluate(() => (window as any).openChat('other'));
    await expect(page.getByText('Second chat').first()).toBeVisible();
    await expect(page.getByTestId('device-approval')).toHaveCount(0);
  } finally {
    release();
  }
  await page.waitForTimeout(500);
  await expect(page.getByTestId('device-approval')).toHaveCount(0);
  const asked = state.asked;
  await page.waitForTimeout(3600);
  expect(state.asked, 'the other chat is not running: nothing is asked for it').toBe(asked);
});

test('a look-up still on its way when the run ends does not leave the question of a call that is over', async ({ page }) => {
  const { state } = await asking(page);
  await page.goto('/tests/chat.html?phase=devices');
  await expect(page.getByTestId('device-approval')).toBeVisible();
  const release = holding(state);
  try {
    await expect.poll(() => state.held, { timeout: 8000 }).toBeGreaterThan(0);
    await page.evaluate(() => (window as any).endRun());
    await expect(page.getByTestId('device-approval')).toHaveCount(0);
  } finally {
    release();
  }
  await page.waitForTimeout(500);
  await expect(page.getByTestId('device-approval')).toHaveCount(0);
});
