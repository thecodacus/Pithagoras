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

/** What the chat's devices hold for it, served as the portal does: it outlives a reload, and the test changes it as the device or the Devices page would. */
async function asking(page: import('@playwright/test').Page) {
  const approval = (id: number, over: Record<string, unknown> = {}) => ({
    device: { id: 'd1', name: 'laptop' },
    approval: { id, call: 4, chat: 'preview', tool: 'bash', target: 'make deploy-to-production-with-a-very-long-target-name-that-must-wrap', reasons: ['Ask mode: every call asks'], preview: null, choices: ['once', 'chat', 'time', 'deny'], max_minutes: 60, created_ms: 0, expires_ms: 0, ...over },
  });
  const state = { pending: [approval(7)], answers: [] as { path: string; body: any }[], asked: 0 };
  await page.route('**/api/sessions/preview/devices/approvals', (route) => {
    state.asked++;
    return route.fulfill({ json: { approvals: state.pending } });
  });
  await page.route('**/api/devices/d1/approvals/*', (route) => {
    const path = new URL(route.request().url()).pathname;
    state.answers.push({ path, body: route.request().postDataJSON() });
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
  expect(state.answers).toEqual([{ path: '/api/devices/d1/approvals/7', body: { answer: 'time', minutes: 60 } }]);
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
    { path: '/api/devices/d1/approvals/7', body: { answer: 'once' } },
    { path: '/api/devices/d1/approvals/8', body: { answer: 'deny' } },
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
    { path: '/api/devices/d1/approvals/7', body: { answer: 'deny' } },
    { path: '/api/devices/d1/approvals/8', body: { answer: 'once' } },
    { path: '/api/devices/d1/approvals/9', body: { answer: 'chat' } },
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
