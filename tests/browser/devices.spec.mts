import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/** The Devices add-on with no server: its switch in Settings → Add-ons, and its page, over canned answers. */

const info = (mode: 'ask' | 'folders' | 'full') => ({
  name: 'laptop', os: 'linux', arch: 'x86_64', os_release: 'Debian 13', hostname: 'laptop', user: 'alice', uid: 1000, home: '/home/alice', shell: 'bash',
  session: 'headless', mode, mode_expires_ms: null, folders: [{ path: '/home/alice/src', access: 'rw', execute: true }], folders_shell: 'landlock',
  tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'], client_version: '0.1.0',
});

const approval = {
  id: 12, call: 4, chat: 'chat-1', tool: 'exec', target: 'make deploy', reasons: ['Ask mode: every call asks'], preview: null,
  choices: ['once', 'chat', 'time', 'deny'], max_minutes: 60, created_ms: 0, expires_ms: 0,
};

function device(over: Record<string, unknown> = {}) {
  return {
    id: 'd0123456789abcdef', name: 'laptop', os: 'linux', arch: 'x86_64', created_at: '2026-10-05 08:00:00', last_seen: '2026-10-05 08:00:00',
    online: true, connectedAt: '2026-10-05T08:00:00Z', remote: { address: '192.0.2.10', userAgent: 'pithagoras-sync/0.1.0' }, hello: { clientVersion: '0.1.0', user: 'alice', shell: 'bash', capabilities: ['fs', 'exec', 'probe', 'approvals', 'policy'] },
    info: info('ask'), sameMachine: false, approvals: [approval],
    policy: { portal_policy: 'read', version: 'v1', settings: { policy: { mode: 'ask', tools: { bash: true } }, exec: {} }, device_only: ['exec.shell'] },
    alert: null, ...over,
  };
}

async function portal(page: Page, { enabled = true, switchedOn = enabled, refused = null as string | null, devices = [device()] as any[], listError = null as string | null } = {}) {
  const sent: { method: string; path: string; body: any }[] = [];
  const state = { enabled, switchedOn, devices, pairing: null as null | { expires: string }, listError };
  await mockPortal(page, ({ path, method, json }) => {
    if (method !== 'GET') sent.push({ method, path, body: method === 'DELETE' ? null : json() });
    if (path === '/api/features/flags') return { subagent: { enabled: false }, understory: { enabled: false }, images: { enabled: false }, devices: { enabled: state.enabled } };
    if (path === '/api/features/devices' && method === 'GET') return { enabled: state.enabled, switchedOn: state.switchedOn, refused };
    if (path === '/api/features/devices' && method === 'PUT') {
      state.enabled = json().enabled;
      state.switchedOn = state.enabled;
      return { enabled: state.enabled, switchedOn: state.switchedOn, refused, reloaded: 0, waiting: 0 };
    }
    if (path === '/api/devices' && method === 'GET') {
      if (state.listError) return reply(404, { error: state.listError });
      return { devices: state.devices, pairing: state.pairing, spki: 'pin-of-the-portal' };
    }
    if (path === '/api/devices/pair' && method === 'POST') {
      state.pairing = { expires: new Date(Date.now() + 600_000).toISOString() };
      return { code: 'K7Q2M9XZ', expires: state.pairing.expires, attempts: 10, spki: 'pin-of-the-portal' };
    }
    if (path === '/api/devices/pair' && method === 'DELETE') {
      state.pairing = null;
      return { ok: true };
    }
    const one = /^\/api\/devices\/([^/]+)(\/.*)?$/.exec(path);
    if (one && !one[2] && method === 'PUT') {
      state.devices = state.devices.map((d) => (d.id === one[1] ? { ...d, name: json().name } : d));
      return { device: state.devices[0] };
    }
    if (one && !one[2] && method === 'DELETE') {
      state.devices = state.devices.filter((d) => d.id !== one[1]);
      return { ok: true };
    }
    if (one && one[2]?.startsWith('/approvals/')) {
      state.devices = state.devices.map((d) => ({ ...d, approvals: [] }));
      return { ok: true };
    }
    if (one && one[2] === '/policy' && method === 'PUT') {
      if (json().ifVersion !== 'v1') return reply(409, { error: 'The settings changed on the device meanwhile' });
      return { policy: { ...state.devices[0].policy, version: 'v2', settings: json().settings } };
    }
    return undefined;
  });
  return { sent, state };
}

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

test('the add-on is off at first; switched on, the Devices page is in the sidebar', async ({ page }) => {
  const { sent } = await portal(page, { enabled: false, devices: [] });
  await page.goto('/settings/add-ons');
  await settings(page).getByRole('tab', { name: 'Devices' }).click();
  const toggle = settings(page).getByRole('switch', { name: 'Devices' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('navigation', { name: 'Destinations' }).last().getByRole('button', { name: 'Devices' })).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(sent).toEqual([{ method: 'PUT', path: '/api/features/devices', body: { enabled: true } }]);
  await expect(settings(page).getByRole('link', { name: 'Pair and manage devices' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation', { name: 'Destinations' }).last().getByRole('button', { name: 'Devices' })).toBeVisible();
});

test('a portal without a password cannot switch devices on, and says why', async ({ page }) => {
  await portal(page, { enabled: false, refused: 'no password', devices: [] });
  await page.goto('/settings/add-ons');
  await settings(page).getByRole('tab', { name: 'Devices' }).click();
  await expect(settings(page).getByRole('switch', { name: 'Devices' })).toBeDisabled();
  await expect(settings(page).getByText(/Set PORTAL_PASSWORD first/)).toBeVisible();
});

test('a switch left on in a portal that lost its password says nothing answers, and can still be switched off', async ({ page }) => {
  const { sent } = await portal(page, { enabled: false, switchedOn: true, refused: 'no password', devices: [] });
  await page.goto('/settings/add-ons');
  await settings(page).getByRole('tab', { name: 'Devices' }).click();
  const toggle = settings(page).getByRole('switch', { name: 'Devices' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(settings(page).getByText('Switched on, but nothing answers while the portal runs without a password.')).toBeVisible();
  await expect(settings(page).getByText(/Set PORTAL_PASSWORD first/)).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(sent).toEqual([{ method: 'PUT', path: '/api/features/devices', body: { enabled: false } }]);
});

test('the page says why when the add-on does not answer', async ({ page }) => {
  await portal(page, { listError: 'Devices are switched on, but this portal runs without a password, so nothing about them answers. Set PORTAL_PASSWORD, or switch them off in Settings → Add-ons.' });
  await page.goto('/devices');
  await expect(page.getByRole('alert')).toContainText('this portal runs without a password');
});

test('a refresh that fails after the list was shown says that what is shown may be out of date, and goes when it works again', async ({ page }) => {
  const { state } = await portal(page);
  await page.goto('/devices');
  await expect(page.getByRole('listitem', { name: 'laptop' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  // Switched off in another tab: the next poll is refused.
  state.listError = 'Devices are switched off. Switch them on in Settings → Add-ons.';
  const stale = page.getByRole('alert').filter({ hasText: 'Could not refresh the list' });
  await expect(stale).toContainText('Devices are switched off', { timeout: 10_000 });
  await expect(stale).toContainText('may be out of date');
  // What was there stays on the page, and it comes back by itself.
  await expect(page.getByRole('listitem', { name: 'laptop' })).toBeVisible();
  state.listError = null;
  await expect(stale).toHaveCount(0, { timeout: 10_000 });
});

test('the page links to the newest client release, one program per system', async ({ page }) => {
  await portal(page, { devices: [] });
  await page.goto('/devices');
  const box = page.getByTestId('client-downloads');
  const base = 'https://github.com/Piggidragon/Pithagoras-Sync/releases/latest';
  await expect(box.getByRole('link', { name: 'Linux (x86-64)' })).toHaveAttribute('href', `${base}/download/pithagoras-sync-x86_64-linux`);
  await expect(box.getByRole('link', { name: 'Linux (ARM64)' })).toHaveAttribute('href', `${base}/download/pithagoras-sync-aarch64-linux`);
  await expect(box.getByRole('link', { name: 'Windows (x86-64)' })).toHaveAttribute('href', `${base}/download/pithagoras-sync-x86_64-windows.exe`);
  await expect(box.getByRole('link', { name: 'All downloads and the install guide' })).toHaveAttribute('href', base);
});

test('pairing shows the code once, with the command that carries the portal address; no pin over plain HTTP', async ({ page }) => {
  const { sent } = await portal(page, { devices: [] });
  await page.goto('/devices');
  await expect(page.getByText('No device is paired yet.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Pair a device' }).click();
  await expect(page.getByTestId('pairing-code')).toHaveText('K7Q2M9XZ');
  await expect(page.getByRole('timer')).toHaveText(/Runs out in (9:5\d|10:00)/);
  const origin = new URL(page.url()).origin;
  const uri = `pithagoras-sync://pair?portal=${encodeURIComponent(origin)}&code=K7Q2M9XZ`;
  await expect(page.getByText(`pithagoras-sync pair '${uri}'`)).toBeVisible();
  await expect(page.getByText(uri, { exact: true })).toBeVisible();
  await expect(page.getByText(/spki=/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel the code' }).click();
  await expect(page.getByTestId('pairing-code')).toHaveCount(0);
  expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(['POST /api/devices/pair', 'DELETE /api/devices/pair']);
});

test('a device shows its state; an approval is answered from the page, for a time the device allows', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/devices');
  const card = page.getByRole('listitem', { name: 'laptop' });
  await expect(card.getByText('connected', { exact: true })).toBeVisible();
  await expect(card.getByText('Ask: every call asks you first')).toBeVisible();
  await expect(card.getByText('alice@laptop', { exact: false })).toBeVisible();
  const asks = card.getByTestId('device-approval');
  await expect(asks.getByText('make deploy')).toBeVisible();
  await expect(asks.getByRole('link', { name: 'from this chat' })).toHaveAttribute('href', '/s/chat-1');
  // Longer than the device's max_minutes is not offered.
  await expect(asks.getByRole('combobox', { name: 'Minutes' }).locator('option')).toHaveText(['15 minutes', '30 minutes', '60 minutes']);
  await asks.getByRole('combobox', { name: 'Minutes' }).selectOption('60');
  await asks.getByRole('button', { name: 'Allow for', exact: true }).click();
  await expect(card.getByTestId('device-approval')).toHaveCount(0);
  expect(sent).toEqual([{ method: 'POST', path: '/api/devices/d0123456789abcdef/approvals/12', body: { answer: 'time', minutes: 60 } }]);
});

/** What a device shares: every setting with its value, and a key and a section a newer client might add. */
const shared = () => ({
  policy: {
    mode: 'ask', folders: [{ path: '/home/alice/src', access: 'rw', execute: true }], folders_shell: 'landlock',
    full: { expiry_hours: 8, until_ms: null, pattern_prompts: true, protected_paths: true, taint_prompts: true },
    protected: { extra: ['~/secrets'], allow: [], tool_config: ['.git'] },
    tools: { read: true, write: true, edit: true, bash: true, grep: true, find: true, ls: true },
    deny: [{ path: '~/private', rights: 'rwx' }], allow_globs: [],
    commands: { allow: [], deny: [{ prefix: 'rm -rf' }], always_ask: [], never_ask: [] }, hours: null,
    approvals: { timeout_secs: 120, on_timeout: 'deny', remember_minutes: 60, max_minutes: 480, desktop_notifications: false },
    privilege: { allow_root: false, elevation: 'off', sudo_path: '/usr/bin/sudo', secret_storage: 'memory' },
    newer_policy_key: { keep: true },
  },
  exec: { env_passthrough: [], max_timeout_secs: 14400, output_cap_bytes: 16777216, max_running: 16, shell: null },
  newer_section: { a: 1 },
});
const deviceOnly = ['exec.shell', 'policy.privilege.sudo_path', 'policy.privilege.secret_storage'];
const withPolicy = (portal_policy: 'read' | 'write') => [device({ policy: { portal_policy, version: 'v1', settings: shared(), device_only: deviceOnly } })];

async function openSettings(page: Page, portal_policy: 'read' | 'write') {
  const ctx = await portal(page, { devices: withPolicy(portal_policy) });
  await page.goto('/devices');
  const card = page.getByRole('listitem', { name: 'laptop' });
  await card.getByText('Settings (', { exact: false }).click();
  return { ...ctx, card, form: card.getByRole('group', { name: 'Device settings form' }), json: card.getByRole('textbox', { name: 'Device settings' }) };
}

test('settings the device keeps to itself are only shown, in the form and in the JSON', async ({ page }) => {
  const { card, form, json } = await openSettings(page, 'read');
  await expect(card.getByText('Settings (shown only', { exact: false })).toBeVisible();
  await expect(form.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio', { name: 'Ask', exact: true })).toHaveAttribute('aria-checked', 'true');
  // Every control of the form is off, whatever its kind.
  const controls = form.locator('input, select, button');
  expect(await controls.count()).toBeGreaterThan(40);
  for (const c of await controls.all()) await expect(c).toBeDisabled();
  await card.getByText('Advanced (JSON)').click();
  await expect(json).toHaveAttribute('readonly', '');
  await expect(card.getByRole('button', { name: 'Save on the device' })).toHaveCount(0);
});

test('where the device allows it, a value set in the form is saved with the version the draft is based on, and nothing else is lost', async ({ page }) => {
  const { sent, card, form, json } = await openSettings(page, 'write');
  await form.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio', { name: 'Full' }).click();
  await form.getByRole('checkbox', { name: 'bash' }).uncheck();
  await form.getByRole('spinbutton', { name: 'Seconds a call waits for an answer' }).fill('300');
  await form.getByRole('radiogroup', { name: 'An approval nobody answers is' }).getByRole('radio', { name: 'Allow it once' }).click();
  await form.getByRole('checkbox', { name: 'Risky commands still ask' }).uncheck();
  await form.getByRole('spinbutton', { name: 'Hours until Full falls back to Ask' }).fill('0');
  await expect(card.getByText('Only the device changes: exec.shell, policy.privilege.sudo_path, policy.privilege.secret_storage')).toBeVisible();

  // The JSON is the same draft.
  await card.getByText('Advanced (JSON)').click();
  const draft = JSON.parse(await json.inputValue());
  expect(draft.policy.mode).toBe('full');
  expect(draft.policy.approvals.timeout_secs).toBe(300);

  await card.getByRole('button', { name: 'Save on the device' }).click();
  await expect(card.getByRole('button', { name: 'Save on the device' })).toHaveCount(0);
  const put = sent.find((x) => x.method === 'PUT')!;
  const want = shared();
  Object.assign(want.policy, { mode: 'full' });
  want.policy.tools.bash = false;
  want.policy.approvals = { ...want.policy.approvals, timeout_secs: 300, on_timeout: 'allow' };
  want.policy.full = { ...want.policy.full, pattern_prompts: false, expiry_hours: 0 };
  expect(put).toEqual({ method: 'PUT', path: '/api/devices/d0123456789abcdef/policy', body: { settings: want, ifVersion: 'v1' } });
  // The keys the form has no control for are in it, as they came.
  expect(put.body.settings.newer_section).toEqual({ a: 1 });
  expect(put.body.settings.policy.newer_policy_key).toEqual({ keep: true });
});

test('a change made in the JSON shows in the form, and an edit of the form keeps what the JSON added', async ({ page }) => {
  const { sent, card, form, json } = await openSettings(page, 'write');
  await card.getByText('Advanced (JSON)').click();
  const doc = shared();
  Object.assign(doc.policy, { mode: 'folders' });
  (doc as any).brand_new = [1, 2];
  await json.fill(JSON.stringify(doc));
  await expect(form.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio', { name: 'Folders' })).toHaveAttribute('aria-checked', 'true');
  await form.getByRole('checkbox', { name: 'grep' }).uncheck();
  await card.getByRole('button', { name: 'Save on the device' }).click();
  await expect(card.getByRole('button', { name: 'Save on the device' })).toHaveCount(0);
  const body = sent.find((x) => x.method === 'PUT')!.body;
  expect(body.settings.brand_new).toEqual([1, 2]);
  expect(body.settings.policy.mode).toBe('folders');
  expect(body.settings.policy.tools.grep).toBe(false);
});

test('a setting only the device changes is shown and cannot be edited, the rest can', async ({ page }) => {
  const { form } = await openSettings(page, 'write');
  await expect(form.getByRole('textbox', { name: 'Shell' })).toBeDisabled();
  await expect(form.getByRole('textbox', { name: 'The sudo the client runs' })).toBeDisabled();
  await expect(form.getByRole('textbox', { name: 'The sudo the client runs' })).toHaveValue('/usr/bin/sudo');
  await expect(form.getByRole('radiogroup', { name: 'Where the elevation password is kept' }).getByRole('radio', { name: 'Only in memory' })).toBeDisabled();
  await expect(form.getByText('only the device changes this')).toHaveCount(3);
  await expect(form.getByRole('spinbutton', { name: 'Most commands running at once' })).toBeEnabled();
  await expect(form.getByRole('checkbox', { name: 'bash' })).toBeEnabled();
});

test('invalid JSON turns the form and Save off, and says why, until it is valid again', async ({ page }) => {
  const { card, form, json } = await openSettings(page, 'write');
  await form.getByRole('checkbox', { name: 'ls', exact: true }).uncheck();
  await card.getByText('Advanced (JSON)').click();
  const good = await json.inputValue();
  await json.fill(good.slice(0, -3));
  await expect(card.getByText('The settings below are not valid JSON.', { exact: false })).toBeVisible();
  for (const c of await form.locator('input, select, button').all()) await expect(c).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Save on the device' })).toBeDisabled();
  await json.fill(good);
  await expect(form.getByRole('checkbox', { name: 'ls', exact: true })).toBeEnabled();
  await expect(form.getByRole('checkbox', { name: 'ls', exact: true })).not.toBeChecked();
  await expect(card.getByRole('button', { name: 'Save on the device' })).toBeEnabled();
});

test('the lists, rules, folders and hours are edited in the form', async ({ page }) => {
  const { sent, card, form } = await openSettings(page, 'write');
  await form.getByRole('button', { name: 'Add a folder: Folders' }).click();
  const second = form.getByRole('group', { name: 'Folders 2' });
  await second.getByRole('textbox', { name: 'Path' }).fill('/srv/data');
  await second.getByRole('radio', { name: 'Read and write' }).click();
  await second.getByRole('checkbox', { name: 'Commands may run here' }).check();
  await form.getByRole('button', { name: 'Remove More protected paths 1' }).click();
  await form.getByRole('button', { name: 'Add a path: More protected paths' }).click();
  await form.getByRole('textbox', { name: 'More protected paths 1' }).fill('~/work/keys');
  await form.getByRole('button', { name: 'Add a rule: Always ask' }).click();
  await form.getByRole('group', { name: 'Always ask 1' }).getByRole('combobox').selectOption('regex');
  await form.getByRole('group', { name: 'Always ask 1' }).getByRole('textbox').fill('^deploy');
  await form.getByRole('group', { name: 'Paths and patterns 1' }).getByRole('checkbox', { name: 'write' }).uncheck();
  await form.getByRole('checkbox', { name: 'Serve calls only at certain hours' }).check();
  await form.getByRole('group', { name: 'Days' }).getByRole('checkbox', { name: 'Mon' }).check();
  await form.getByRole('textbox', { name: 'Until' }).fill('17:30');
  await form.getByRole('spinbutton', { name: 'Offset from UTC, in minutes' }).fill('-60');
  await card.getByRole('button', { name: 'Save on the device' }).click();
  await expect(card.getByRole('button', { name: 'Save on the device' })).toHaveCount(0);
  const { policy } = sent.find((x) => x.method === 'PUT')!.body.settings;
  expect(policy.folders).toEqual([{ path: '/home/alice/src', access: 'rw', execute: true }, { path: '/srv/data', access: 'rw', execute: true }]);
  expect(policy.protected.extra).toEqual(['~/work/keys']);
  expect(policy.commands.always_ask).toEqual([{ regex: '^deploy' }]);
  expect(policy.deny).toEqual([{ path: '~/private', rights: 'rx' }]);
  expect(policy.hours).toEqual({ days: ['mon'], from: '08:00', to: '17:30', utc_offset_minutes: -60 });
});

test('the settings form fits a phone without scrolling sideways, with a long path in it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const { form, card } = await openSettings(page, 'write');
  await form.getByRole('button', { name: 'Add a folder: Folders' }).click();
  await form.getByRole('textbox', { name: 'Path' }).nth(0).fill('/home/alice/' + 'a-very-long-folder-name/'.repeat(12));
  await form.getByRole('checkbox', { name: 'Serve calls only at certain hours' }).check();
  await card.getByText('Advanced (JSON)').click();
  const overflow = await page.evaluate(() => [...document.querySelectorAll('main *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).map((el) => el.outerHTML.slice(0, 80)));
  expect(overflow).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('rename, and removal after asking; a second connection with the token is said', async ({ page }) => {
  const alert = { at: Date.parse('2026-10-05T09:00:00Z'), message: 'x', existing: { address: '192.0.2.10', userAgent: 'pithagoras-sync/0.1.0' }, refused: { address: '198.51.100.7', userAgent: 'curl/8' } };
  const { sent } = await portal(page, { devices: [device({ alert, approvals: [] })] });
  await page.goto('/devices');
  await expect(page.getByRole('listitem', { name: 'laptop' }).getByText('192.0.2.10 (pithagoras-sync/0.1.0)').first()).toBeVisible();
  await expect(page.getByRole('alert')).toContainText("a connection from 198.51.100.7 (curl/8) tried to connect with this device's token while the device was connected from 192.0.2.10 (pithagoras-sync/0.1.0)");
  await page.getByRole('button', { name: 'Rename laptop' }).click();
  await page.getByRole('textbox', { name: 'Device name' }).fill('desk');
  await page.getByRole('textbox', { name: 'Device name' }).press('Enter');
  await expect(page.getByRole('listitem', { name: 'desk' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove desk' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('No device is paired yet.', { exact: false })).toBeVisible();
  expect(sent.map((s) => `${s.method} ${s.path} ${JSON.stringify(s.body)}`)).toEqual([
    'PUT /api/devices/d0123456789abcdef {"name":"desk"}',
    'DELETE /api/devices/d0123456789abcdef null',
  ]);
});

test('a connection that took the place of one that was just in touch is said as that, not as refused', async ({ page }) => {
  const alert = { at: Date.parse('2026-10-05T09:00:00Z'), message: 'x', replaced: true, existing: { address: '192.0.2.10', userAgent: 'pithagoras-sync/0.1.0' }, refused: { address: '198.51.100.7', userAgent: 'curl/8' } };
  await portal(page, { devices: [device({ alert, approvals: [] })] });
  await page.goto('/devices');
  await expect(page.getByRole('alert')).toContainText('a connection from 198.51.100.7 (curl/8) took the place of the one from 192.0.2.10 (pithagoras-sync/0.1.0), which had just been in touch');
  await expect(page.getByRole('alert')).not.toContainText('was refused');
});

test('the page fits a phone without scrolling sideways', async ({ page }) => {
  await portal(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/devices');
  await page.getByRole('button', { name: 'Pair a device' }).click();
  await expect(page.getByTestId('pairing-code')).toBeVisible();
  const overflow = await page.evaluate(() => [...document.querySelectorAll('main *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).map((el) => el.outerHTML.slice(0, 80)));
  expect(overflow).toEqual([]);
});
