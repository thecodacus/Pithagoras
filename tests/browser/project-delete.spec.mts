import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

type Unsaved = { changed: number; unpushed: number; stashes: number; unknown?: true };

/**
 * A portal with one project, "demo". `unsaved` is what GET says it holds;
 * `found` is what DELETE finds without ?discard=1, which answers 409 when it holds any.
 */
async function portal(page: Page, opts: { unsaved?: Unsaved; found?: Unsaved; asks?: boolean } = {}) {
  const deletes: string[] = [];
  let gone = false;
  await mockPortal(page, async ({ path: p, method, url }) => {
    if (p === '/api/projects') {
      return { root: '/w', home: '/h', projects: gone ? [] : [{ name: 'demo', path: '/w/demo', isGit: true, hasInstructions: false, sessions: 0, lastActive: null }] };
    }
    if (p === '/api/projects/demo' && method === 'GET') {
      return { name: 'demo', path: '/w/demo', sessions: 0, routines: [], files: 3, bytes: 300, complete: true, ...(opts.unsaved ? { unsaved: opts.unsaved } : {}) };
    }
    if (p === '/api/projects/demo' && method === 'DELETE') {
      deletes.push(url.search);
      const found = opts.found ?? opts.unsaved;
      const held = found && (found.changed || found.unpushed || found.stashes || found.unknown);
      if (held && url.searchParams.get('discard') !== '1') {
        return reply(409, { error: 'This folder holds work that exists nowhere else. Delete it only when that is meant.', code: 'unsaved-work', unsaved: found });
      }
      gone = true;
      return { ok: true, sessionsDeleted: 0 };
    }
    if (p === '/api/models') return { models: [], providers: {} };
  }, { settings: true });
  await page.addInitScript((asks) => {
    if (!asks) localStorage.setItem('confirmDeletes', 'off');
  }, opts.asks ?? true);
  await page.goto('/projects');
  return deletes;
}

const dialog = (page: Page) => page.getByRole('alertdialog');

test('a clean repository is deleted with the plain question', async ({ page }) => {
  const deletes = await portal(page, { unsaved: { changed: 0, unpushed: 0, stashes: 0 } });
  await page.getByRole('button', { name: 'Delete demo' }).click();
  await expect(dialog(page)).toContainText('Delete the project "demo"?');
  await expect(dialog(page)).toContainText('Files git ignores, such as .env, are not looked at.');
  // What runs in the folder goes with it, and the question is where it is said.
  await expect(dialog(page)).toContainText('The background jobs running in its folder, a dev server for example, are stopped too.');
  await dialog(page).getByRole('button', { name: 'Delete project' }).click();
  await expect.poll(() => deletes).toEqual(['']);
});

test('unsaved work is named, asked about in its own words, and sent with ?discard=1', async ({ page }) => {
  const deletes = await portal(page, { unsaved: { changed: 2, unpushed: 1, stashes: 3 } });
  await page.getByRole('button', { name: 'Delete demo' }).click();
  await expect(dialog(page)).toContainText('Delete the project "demo" and its unsaved work?');
  await expect(dialog(page)).toContainText('This folder holds git work that exists nowhere else: 2 uncommitted changes, 1 commit that no remote has, 3 stashes.');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(deletes).toEqual([]);

  await page.getByRole('button', { name: 'Delete demo' }).click();
  await dialog(page).getByRole('button', { name: 'Delete anyway' }).click();
  await expect.poll(() => deletes).toEqual(['?discard=1']);
});

test('the question is asked even when Settings says not to ask before deleting', async ({ page }) => {
  const deletes = await portal(page, { unsaved: { changed: 1, unpushed: 0, stashes: 0 }, asks: false });
  await page.getByRole('button', { name: 'Delete demo' }).click();
  await expect(dialog(page)).toContainText('1 uncommitted change');
  expect(deletes).toEqual([]);
});

test('what could not be read is not said as a fact', async ({ page }) => {
  await portal(page, { unsaved: { changed: 0, unpushed: 0, stashes: 0, unknown: true } });
  await page.getByRole('button', { name: 'Delete demo' }).click();
  await expect(dialog(page)).toContainText('Whether the folder holds git work that exists nowhere else could not be told.');
  await expect(dialog(page)).not.toContainText('ignores');
  await expect(dialog(page).getByRole('button', { name: 'Delete anyway' })).toBeVisible();
});

test('work that turns up after the question is asked about, not shown as an error', async ({ page }) => {
  // Clean when asked, and "ask before deleting" off: no dialog, until the server finds work.
  const deletes = await portal(page, { unsaved: { changed: 0, unpushed: 0, stashes: 0 }, found: { changed: 0, unpushed: 4, stashes: 0 }, asks: false });
  await page.getByRole('button', { name: 'Delete demo' }).click();
  await expect(dialog(page)).toContainText('4 commits that no remote has');
  await expect(page.getByText('Delete it only when that is meant')).toHaveCount(0);
  await dialog(page).getByRole('button', { name: 'Delete anyway' }).click();
  await expect.poll(() => deletes).toEqual(['', '?discard=1']);
});
