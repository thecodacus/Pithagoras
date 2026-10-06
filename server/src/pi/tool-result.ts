/**
 * How the portal's inline tools answer pi.
 *
 * pi builds what the model reads from `content`, and marks a result as an error
 * only when `execute` throws; anything else it is handed is taken as a success.
 * A tool that returns its own `{ output, isError }` therefore tells the model
 * nothing, and every failure looks like it worked.
 */

/** A result: text the model reads. */
export const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/** A failure, which pi shows the model as an error with this text. */
export function fail(text: string): never {
  throw new Error(text);
}
