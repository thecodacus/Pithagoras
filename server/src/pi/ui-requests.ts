/**
 * The two kinds of UI request an extension sends.
 *
 * pi has the one event for both. A dialog stops the extension until somebody
 * answers; everything else (a status line, a widget, a title, a notice) is
 * news that nobody waits on, and an extension sends it on its own clock: one
 * refreshes its status every second whether or not anything is going on.
 */
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

/** Whether this UI request waits for an answer. What is not known is one-way. */
export function isDialog(method: unknown): boolean {
  return typeof method === "string" && DIALOGS.has(method);
}
