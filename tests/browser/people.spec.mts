import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/** Settings → People over canned answers: what the page sends when somebody is forgotten, demoted or allowed something. */
async function portal(page: Page, people: any[]) {
  const sent: { method: string; url: string; body: any }[] = [];
  const rules: any[] = [];
  await mockPortal(page, ({ path: p, method, url, json }) => {
    if (p === '/api/people' && method === 'GET') return { people };
    if (p === '/api/tool-rules' && method === 'GET') return { rules };
    if (p === '/api/tool-rules' && method === 'POST') {
      const rule = json();
      sent.push({ method, url: p, body: rule });
      rules.push({ id: 'r1', role: rule.role, tool: rule.tool, pattern: rule.pattern, person_key: rule.personKey, note: '', created_at: '' });
      return { rules };
    }
    if (p.startsWith('/api/people/')) {
      sent.push({ method, url: p + url.search, body: method === 'PATCH' ? json() : undefined });
      // A save is stored as the server keeps the text: trimmed. The role stays as it was here.
      const patched = people.find((x) => x.key === decodeURIComponent(p.slice('/api/people/'.length)));
      if (method === 'PATCH' && patched) {
        const sentBody = json();
        Object.assign(patched, { name: sentBody.name.trim() || patched.name, notes: sentBody.notes.trim() });
      }
      return method === 'PATCH' ? { person: patched ?? people[0] } : { ok: true };
    }
  }, { settings: true });
  return sent;
}

const person = (key: string, name: string, role: string) => ({ key, name, role, notes: '', first_seen: '', last_seen: null, announced_at: null, renamed: 0 });

test('forgetting somebody asks first, and the only primary user is asked about as what it is', async ({ page }) => {
  const sent = await portal(page, [person('tg:owner', 'Sam', 'primary'), person('tg:kim', 'Kim', 'colleague')]);
  await page.goto('/settings/people');
  const dialog = page.getByRole('dialog', { name: 'Settings' });

  await dialog.getByRole('button', { name: /Kim/ }).click();
  await dialog.getByTitle(/^Forget/).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('Forget Kim?');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  expect(sent).toEqual([]);

  await dialog.getByTitle(/^Forget/).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Forget' }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].method).toBe('DELETE');
  expect(sent[0].url).toBe('/api/people/tg%3Akim');
});

test('the last primary user cannot be forgotten or demoted by one click, only after being told what follows', async ({ page }) => {
  const sent = await portal(page, [person('tg:owner', 'Sam', 'primary'), person('tg:kim', 'Kim', 'colleague')]);
  await page.goto('/settings/people');
  const dialog = page.getByRole('dialog', { name: 'Settings' });

  await dialog.getByRole('button', { name: /Sam/ }).click();
  await dialog.getByTitle(/^Forget/).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('Forget the only primary user?');
  await expect(ask).toContainText('every channel lets anybody in');
  await ask.getByRole('button', { name: 'Cancel' }).click();

  await dialog.getByRole('radio', { name: 'Colleague', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alertdialog')).toContainText("Take away the only primary user's role?");
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
  expect(sent).toEqual([]);

  await dialog.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].body).toMatchObject({ role: 'colleague', force: true });

  await dialog.getByTitle(/^Forget/).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Forget' }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].url).toBe('/api/people/tg%3Aowner?force=1');
});

test('a person\'s role is a radio group, so the one they have is said and not only coloured', async ({ page }) => {
  await portal(page, [person('tg:owner', 'Sam', 'primary'), person('tg:kim', 'Kim', 'colleague')]);
  await page.goto('/settings/people');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: /Kim/ }).click();
  const role = dialog.getByRole('radiogroup', { name: 'Role' });
  await expect(role.getByRole('radio', { name: 'Colleague' })).toHaveAttribute('aria-checked', 'true');
  await expect(role.getByRole('radio', { name: 'Blocked' })).toHaveAttribute('aria-checked', 'false');
  await role.getByRole('radio', { name: 'Blocked' }).click();
  await expect(role.getByRole('radio', { name: 'Blocked' })).toHaveAttribute('aria-checked', 'true');
  await expect(role.getByRole('radio', { name: 'Colleague' })).toHaveAttribute('aria-checked', 'false');
});

test('after a save the form is what is stored, so Save goes away even where the server trimmed the notes', async ({ page }) => {
  const sent = await portal(page, [person('tg:owner', 'Sam', 'primary'), person('tg:kim', 'Kim', 'colleague')]);
  await page.goto('/settings/people');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: /Kim/ }).click();
  const notes = dialog.getByPlaceholder(/Their role, what they work on/);
  await notes.fill('Reviews the pull requests.\n');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => sent.length).toBe(1);
  // The form shows what the server kept, and has nothing left to save.
  await expect(notes).toHaveValue('Reviews the pull requests.');
  await expect(dialog.getByRole('button', { name: 'Save' })).toHaveCount(0);
});

test('a save that the server trims back to what was stored leaves nothing to save either', async ({ page }) => {
  const sent = await portal(page, [person('tg:owner', 'Sam', 'primary'), { ...person('tg:kim', 'Kim', 'colleague'), notes: 'Reviews the pull requests.' }]);
  await page.goto('/settings/people');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: /Kim/ }).click();
  const notes = dialog.getByPlaceholder(/Their role, what they work on/);
  const name = dialog.getByRole('textbox', { name: 'Name', exact: true });
  // Only whitespace is added to the notes, and the name is emptied: the server keeps what it had.
  await notes.fill('Reviews the pull requests.\n');
  await name.fill('');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => sent.length).toBe(1);
  await expect(notes).toHaveValue('Reviews the pull requests.');
  await expect(name).toHaveValue('Kim');
  await expect(dialog.getByRole('button', { name: 'Save' })).toHaveCount(0);
});

test('with another primary user, demoting somebody asks nothing and sends no force', async ({ page }) => {
  const sent = await portal(page, [person('tg:owner', 'Sam', 'primary'), person('tg:deputy', 'Dee', 'primary')]);
  await page.goto('/settings/people');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: /Dee/ }).click();
  await dialog.getByRole('radio', { name: 'Guest', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].body.force).toBeUndefined();
});

test('an exception for one person is written for every role, so it follows them and can be given to anybody', async ({ page }) => {
  const sent = await portal(page, [person('tg:owner', 'Sam', 'primary'), person('tg:kim', 'Kim', 'guest')]);
  await page.goto('/settings/people');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: /Kim/ }).click();
  await dialog.getByPlaceholder('himalaya envelope list*').fill('git log*');
  await dialog.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].body).toEqual({ role: 'all', tool: 'bash', pattern: 'git log*', personKey: 'tg:kim' });
});
