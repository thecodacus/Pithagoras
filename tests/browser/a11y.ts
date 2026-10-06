import { type Locator, type Page } from '@playwright/test';

/**
 * The controls in `within` (the whole page by default) that a screen reader would announce with no name: a field, a
 * button, a slider, a switch, a tab that has neither an `aria-label`, nor a label that points to it or wraps it, nor
 * text of its own, nor a title. Described as `tag[type] "placeholder" .class` so that the one at fault can be found.
 * A placeholder is not a name: it goes when something is typed, and is not read by every screen reader.
 *
 * A simplification of how a browser computes names, which is enough to tell a control with a name from one without.
 */
export async function unnamed(page: Page, within?: Locator): Promise<string[]> {
  return (within ?? page.locator('body')).evaluate((root) => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden';
    };
    /** Text a name is made of: what is shown, and what describes a picture, but not what is hidden from assistive technology. */
    const textOf = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
      if (!(node instanceof Element) || node.getAttribute('aria-hidden') === 'true') return '';
      if (node instanceof HTMLImageElement) return node.alt;
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) return '';
      return [...node.childNodes].map(textOf).join(' ');
    };
    const nameOf = (el: Element): string => {
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const found = by.split(/\s+/).map((id) => document.getElementById(id)).map((e) => (e ? textOf(e) : '')).join(' ').trim();
        if (found) return found;
      }
      const aria = el.getAttribute('aria-label')?.trim();
      if (aria) return aria;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        const label = [...(el.labels ?? [])].map((l) => textOf(l)).join(' ').trim();
        if (label) return label;
      }
      if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type) && el.value.trim()) return el.value.trim();
      if (el instanceof HTMLButtonElement || ['button', 'tab', 'switch', 'checkbox', 'menuitem', 'option'].includes(el.getAttribute('role') ?? '')) {
        const text = textOf(el).trim();
        if (text) return text;
      }
      return el.getAttribute('title')?.trim() ?? '';
    };
    const found: string[] = [];
    const controls = root.querySelectorAll('input:not([type=hidden]), select, textarea, button, [role=slider], [role=switch], [role=tab], [role=checkbox], [role=combobox], [role=textbox]');
    for (const el of controls) {
      if (!visible(el) || el.closest('[aria-hidden=true]') || (el as HTMLInputElement).disabled) continue;
      // The textarea behind a code editor, or a hidden file picker: not what a person reads or operates.
      if (el instanceof HTMLInputElement && el.type === 'file') continue;
      if (nameOf(el)) continue;
      const placeholder = el.getAttribute('placeholder');
      const type = el.getAttribute('type');
      found.push(`${el.tagName.toLowerCase()}${type ? `[${type}]` : ''}${placeholder ? ` "${placeholder}"` : ''}${el.className && typeof el.className === 'string' ? ` .${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : ''}`);
    }
    return found;
  });
}
