import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * pi's own tools (read, write, edit, bash, grep, find, ls) with a device paired. A chat that is granted a device
 * registers them again with a `device` parameter, and the portal still lists them as built in: one box of seven
 * in every list of tools, none of them hidden, doubled or filed under the Devices add-on.
 */
const builtIn = ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'];
const tools = [...builtIn.map((name) => ({ name, source: 'built in', defaultOn: true })), { name: 'web_search', source: 'pi-web-access', defaultOn: true }];

const laptop = {
  id: 'd0123456789abcdef', name: 'laptop', os: 'linux', arch: 'x86_64', created_at: '2026-10-05 08:00:00', last_seen: '2026-10-05 08:00:00',
  online: true, connectedAt: '2026-10-05T08:00:00Z', remote: { address: '192.0.2.10', userAgent: 'pithagoras-sync/0.1.0' },
  hello: { clientVersion: '0.1.0', user: 'alice', shell: 'bash', capabilities: ['fs', 'exec', 'approvals', 'policy'] },
  info: { name: 'laptop', os: 'linux', arch: 'x86_64', home: '/home/alice', tools: builtIn, client_version: '0.1.0' }, sameMachine: false, approvals: [],
  policy: null, alert: null,
};

/** Settings → Tools of a portal whose Devices add-on is on and has a device paired. */
async function portal(page: Page) {
  const puts: string[][] = [];
  await mockPortal(page, async ({ path, method, json }) => {
    if (path === '/api/features/flags') return { subagent: { enabled: false }, understory: { enabled: false }, images: { enabled: false }, devices: { enabled: true } };
    if (path === '/api/devices' && method === 'GET') return { devices: [laptop], pairing: null, spki: 'pin-of-the-portal' };
    if (path === '/api/tools' && method === 'GET') return { tools, off: [], names: {} };
    if (path === '/api/tools' && method === 'PUT') {
      const { off } = json();
      puts.push(off);
      return { off, applied: 0 };
    }
  }, { settings: true });
  await page.addInitScript(() => localStorage.removeItem('toolGroupsOpen'));
  await page.goto('/settings/tools');
  return { puts };
}

const box = (page: Page, name: RegExp) => page.getByRole('button', { name, expanded: false }).or(page.getByRole('button', { name, expanded: true }));

test('Settings → Tools lists the seven built-in tools in one box with a device paired, none of them under Devices', async ({ page }) => {
  const { puts } = await portal(page);
  const built = box(page, /^built in/);
  await expect(built).toHaveCount(1);
  await expect(built).toContainText('7 on');
  // No box of the add-on's, and the other tools stay in theirs.
  await expect(box(page, /^devices/i)).toHaveCount(0);
  await expect(box(page, /^pi-web-access/)).toContainText('1 on');
  await built.click();
  for (const name of builtIn) await expect(page.getByRole('checkbox', { name, exact: true })).toHaveCount(1);
  // A switch for one of them, and for the box.
  await page.getByRole('checkbox', { name: 'bash', exact: true }).uncheck();
  await expect.poll(() => puts.at(-1)).toEqual(['bash']);
  await expect(built).toContainText('1 of 7 off');
  await built.locator('xpath=..').getByRole('button', { name: 'all off' }).click();
  await expect.poll(() => [...(puts.at(-1) ?? [])].sort()).toEqual(builtIn);
});

test("a chat's tools control lists the seven built-in tools in one box once a device is granted", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=devices');
  await page.getByRole('button', { name: 'Which tools this conversation may use' }).click();
  const menu = page.locator('.composer-menu');
  const built = menu.getByRole('button', { name: /^built in/ });
  await expect(built).toHaveCount(1);
  await expect(built).toContainText('7 on');
  await expect(menu.getByRole('button', { name: /^devices/i, expanded: false }).or(menu.getByRole('button', { name: /^devices/i, expanded: true }))).toHaveCount(0);
  await built.click();
  for (const name of builtIn) await expect(menu.getByRole('checkbox', { name, exact: true })).toHaveCount(1);
  await menu.getByRole('checkbox', { name: 'bash', exact: true }).uncheck();
  await expect.poll(() => page.evaluate(() => (window as any).sentTools)).toEqual([['bash']]);
  await expect(built).toContainText('1 of 7 off');
});
