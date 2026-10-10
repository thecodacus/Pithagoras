import test from 'node:test';
import assert from 'node:assert/strict';
import { visible, visibleParts } from '../web/src/visible.ts';

// Written as code points, so that no character that is not drawn sits in this file.
const ch = (...cp: number[]) => String.fromCodePoint(...cp);
const RLO = ch(0x202e);
const PDF = ch(0x202c);

test('ordinary text, with its spaces, quotes and backslashes, is shown as it is', () => {
  const s = 'git commit -m "a  b"   && echo \\n ünï 日本 😀';
  assert.equal(visible(s), s);
  assert.deepEqual(visibleParts(s), [{ text: s, escaped: false }]);
  assert.deepEqual(visibleParts(''), []);
});

test('a line break, a carriage return and a tab are written out, so a command cannot look like one line', () => {
  assert.equal(visible('echo "build ok"\nrm -rf ~/projects'), 'echo "build ok"\\nrm -rf ~/projects');
  assert.equal(visible('a\r\nb\tc'), 'a\\r\\nb\\tc');
  assert.deepEqual(visibleParts('a\nb'), [{ text: 'a', escaped: false }, { text: '\\n', escaped: true }, { text: 'b', escaped: false }]);
});

test('with lines, the line feeds stay for a text that is shown with its line breaks, and everything else is still written out', () => {
  assert.equal(visible('echo ok\nrm -rf ~\n', true), 'echo ok\nrm -rf ~\n');
  assert.equal(visible('a\r\nb\tc', true), 'a\\r\nb\\tc');
  assert.deepEqual(visibleParts('a\nb', true), [{ text: 'a\nb', escaped: false }]);
});

test('a right-to-left override and the other bidirectional controls are written out, not applied', () => {
  assert.equal(visible(`echo "${RLO}" ; rm -rf ~ ; echo "${PDF}" ok`), 'echo "\\u{202e}" ; rm -rf ~ ; echo "\\u{202c}" ok');
  for (const cp of [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x061c]) {
    assert.equal(visible(`a${ch(cp)}b`), `a\\u{${cp.toString(16)}}b`, cp.toString(16));
  }
});

test('other controls, characters with no width, separators and tag characters are written out', () => {
  assert.equal(visible(`a${ch(0)}b${ch(0x1b)}[2Jc${ch(0x7f)}d${ch(0x85)}e`), 'a\\u{0}b\\u{1b}[2Jc\\u{7f}d\\u{85}e');
  for (const cp of [0x200b, 0x200c, 0x200d, 0x2028, 0x2029, 0x2060, 0xfeff, 0xe0041, 0xe007f]) {
    assert.equal(visible(`a${ch(cp)}b`), `a\\u{${cp.toString(16)}}b`, cp.toString(16));
  }
  // The neighbours of the ranges are text.
  for (const cp of [0x20, 0x7e, 0xa0, 0x2010, 0x2065, 0x202f, 0xe007f + 1]) assert.equal(visible(`a${ch(cp)}b`), `a${ch(cp)}b`, cp.toString(16));
});

test('a long text is handled in one pass, and each escape is its own part', () => {
  const s = `${'x'.repeat(65536)}\n${RLO}`;
  const parts = visibleParts(s);
  assert.deepEqual(parts.map((p) => p.escaped), [false, true, true]);
  assert.equal(parts[0].text.length, 65536);
  assert.equal(parts[2].text, '\\u{202e}');
});
