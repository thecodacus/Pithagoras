import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

const SHA = 'a'.repeat(40);

interface Portal {
  /** What an import answers with besides what it imported. */
  skipped?: { name: string; reason: string }[];
  /** What the look found that cannot be imported. */
  lookSkipped?: { name: string; reason: string }[];
}

/** Settings → Skills over canned answers, with what the page sent to look and to import. */
async function portal(page: Page, { skipped = [], lookSkipped = [] }: Portal = {}) {
  const looks: unknown[] = [];
  const imports: any[] = [];
  let loads = 0;
  await mockPortal(page, ({ path: p, json }) => {
    if (p === '/api/skills') { loads++; return { root: '/agent/skills', skills: [], diagnostics: [] }; }
    if (p === '/api/skills/preview-import') {
      const sent = json();
      looks.push(sent);
      return {
        spec: sent.spec,
        sha: SHA,
        found: [{ name: 'pdf', description: 'Read a PDF', installed: false, from: 'skills/pdf' }],
        skipped: lookSkipped,
      };
    }
    if (p === '/api/skills/import') {
      imports.push(json());
      return { ok: true, imported: ['pdf'], skipped };
    }
  }, { settings: true });
  return { looks, imports, loads: () => loads };
}

async function look(page: Page, spec: string) {
  await page.goto('/settings/skills');
  await page.getByRole('button', { name: 'Import from GitHub' }).click();
  await page.getByPlaceholder('anthropics/skills').fill(spec);
  await page.getByRole('button', { name: 'Look' }).click();
  await expect(page.getByText('1 skill found')).toBeVisible();
}

test('an import asks for what was looked at: the spec and the commit the look saw', async ({ page }) => {
  const calls = await portal(page);
  await look(page, ' team/skills#dev ');
  expect(calls.looks).toEqual([{ spec: 'team/skills#dev' }]);

  await page.getByRole('button', { name: /^Import/ }).click();
  await expect.poll(() => calls.imports.length).toBe(1);
  expect(calls.imports[0]).toEqual({ spec: 'team/skills#dev', only: ['pdf'], overwrite: true, sha: SHA });
  // Nothing was left out, so the form closes and the list is read again.
  await expect(page.getByPlaceholder('anthropics/skills')).toHaveCount(0);
});

test('the list of what was found is dropped when the address is changed, so it cannot be imported from another one', async ({ page }) => {
  const calls = await portal(page);
  await look(page, 'team/skills');
  await page.getByPlaceholder('anthropics/skills').fill('someone-else/skills');
  await expect(page.getByText('1 skill found')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Import \d/ })).toHaveCount(0);
  expect(calls.imports).toEqual([]);
});

test('what an import did not take is said, with the reason, and the form stays open', async ({ page }) => {
  const calls = await portal(page, { skipped: [{ name: 'gone', reason: 'not in the repository any more' }] });
  await look(page, 'team/skills');
  const before = calls.loads();
  await page.getByRole('button', { name: /^Import/ }).click();
  await expect(page.getByText('Not imported:')).toBeVisible();
  await expect(page.getByText('gone', { exact: true })).toBeVisible();
  await expect(page.getByText(/not in the repository any more/)).toBeVisible();
  await expect(page.getByPlaceholder('anthropics/skills')).toBeVisible();
  // What was imported is in the list behind it.
  await expect.poll(() => calls.loads()).toBeGreaterThan(before);
});

test('what the look found and cannot import is said before anything is ticked', async ({ page }) => {
  await portal(page, { lookSkipped: [{ name: '..', reason: 'unusable name' }] });
  await look(page, 'team/skills');
  await expect(page.getByText('Not imported:')).toBeVisible();
  await expect(page.getByText(/unusable name/)).toBeVisible();
});

test('the form says a private repository goes through the server\'s git login', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/skills');
  await page.getByRole('button', { name: 'Import from GitHub' }).click();
  await expect(page.getByText(/Do not put a token in the address/)).toBeVisible();
});
