import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/** Settings → Skills with one skill the user can edit, over canned answers. */
async function portal(page: Page, source: unknown = null) {
  const updates: string[] = [];
  const skill = { name: 'notes', description: 'Take notes', path: '/agent/skills/notes/SKILL.md', scope: 'user', editable: true, manualOnly: false, broken: false, enabled: true, source, content: '---\nname: notes\n---\nTake notes.' };
  await mockPortal(page, ({ path, method }) => {
    if (path === '/api/skills/notes/update') { updates.push(method); skill.content = '---\nname: notes\n---\nTake the upstream notes.'; return { ok: true, imported: ['notes'] }; }
    if (path === '/api/skills') return { root: '/agent/skills', skills: [skill], diagnostics: [] };
  }, { settings: true });
  return updates;
}

test('Escape in a skill that was rewritten asks before Settings closes; an unchanged skill closes at once', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/skills');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: /notes/ }).click();
  const editor = dialog.getByRole('textbox');
  await expect(editor).toHaveValue(/Take notes/);
  // Opened, not changed: nothing to lose.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.goto('/settings/skills');
  await dialog.getByRole('button', { name: /notes/ }).click();
  await editor.fill('Half a rewrite');
  await page.keyboard.press('Escape');
  const ask = page.getByRole('alertdialog', { name: 'Discard your changes?' });
  await expect(ask).toBeVisible();
  // One Escape for one question: the one that asks does not also answer it.
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeVisible();
  await expect(editor).toHaveValue('Half a rewrite');
  await page.keyboard.press('Escape');
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(dialog).toBeHidden();
});

test('Update on an imported skill asks before it replaces local edits, and leaves them alone when it is not confirmed', async ({ page }) => {
  const updates = await portal(page, { spec: 'team/skills', url: 'https://github.com/team/skills', importedAt: '2026-01-01T00:00:00Z' });
  await page.goto('/settings/skills');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: /notes/ }).click();
  const editor = dialog.getByRole('textbox');
  await editor.fill('My own version, not saved yet');
  await dialog.getByRole('button', { name: 'Update' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Replace your local edits?' });
  await expect(ask).toContainText('saved or not');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  expect(updates).toEqual([]);
  await expect(editor).toHaveValue('My own version, not saved yet');

  await dialog.getByRole('button', { name: 'Update' }).click();
  await ask.getByRole('button', { name: 'Update' }).click();
  await expect.poll(() => updates.length).toBe(1);
  await expect(editor).toHaveValue(/Take the upstream notes/);
});
