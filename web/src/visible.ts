/**
 * Text as an owner may safely read it before they answer for it: a command or a path that comes from the model, through a device.
 * Written the way the Sync client writes it in its own prompt (`visible` in its `approve.rs`), because the reason is the same: a
 * line break, a tab or a run of spaces that is folded away, and a control that reorders or hides characters (right-to-left
 * override, zero-width or tag characters), would make the owner approve something other than what they read.
 */

/**
 * The code points that are written out: C0 and C1 controls with DEL, the Arabic letter mark, zero-width characters and the
 * left-to-right and right-to-left marks, line and paragraph separators and the bidirectional embeddings and overrides, the word
 * joiner and invisible operators, the isolates, the byte order mark, and the tag characters (which are never drawn).
 */
const HIDDEN: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

const NAMED: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

export interface VisiblePart {
  text: string;
  /** An escape that stands for a character that is not shown as itself. */
  escaped: boolean;
}

/**
 * `s` in pieces: the text as it is, and an escape (`\n`, `\u{202e}`) for each character `HIDDEN` names. With `lines`, a line
 * feed stays one, for text that is shown with its line breaks (white-space: pre-wrap); every other control is written out.
 */
export function visibleParts(s: string, lines = false): VisiblePart[] {
  const parts: VisiblePart[] = [];
  let plain = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if ((lines && ch === "\n") || !HIDDEN.some(([from, to]) => cp >= from && cp <= to)) {
      plain += ch;
      continue;
    }
    if (plain) parts.push({ text: plain, escaped: false });
    plain = "";
    parts.push({ text: NAMED[ch] ?? `\\u{${cp.toString(16)}}`, escaped: true });
  }
  if (plain) parts.push({ text: plain, escaped: false });
  return parts;
}

/** `s` as one piece of plain text, with every escape written out. */
export const visible = (s: string, lines = false): string => visibleParts(s, lines).map((p) => p.text).join("");
