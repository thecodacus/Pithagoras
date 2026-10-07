/** What the voice says about compaction. */
export type Notice = "compacting" | "waiting" | "done" | "stopped";

/**
 * The wording there is, per language. These are spoken by the voice and not drawn
 * on the page, so the language they come in is the voice's, never the page's: a
 * German page with an English voice must not send German text to an English
 * voice. Another language is another entry here.
 */
const WORDING: Record<string, Record<Notice, string>> = {
  en: {
    compacting: "My context is getting full. Let me quickly compact our conversation before I continue.",
    waiting: "I'm still compacting our conversation. Please wait a moment; I'll let you know when I'm ready.",
    done: "Context compaction is done. I'm ready to continue.",
    stopped: "Context compaction stopped before it finished.",
  },
  de: {
    compacting: "Mein Kontext wird voll. Ich komprimiere kurz unser Gespräch, bevor ich weitermache.",
    waiting: "Ich komprimiere unser Gespräch noch. Bitte warte einen Moment; ich sage dir, wenn ich bereit bin.",
    done: "Die Komprimierung ist fertig. Ich bin bereit weiterzumachen.",
    stopped: "Die Komprimierung wurde abgebrochen, bevor sie fertig war.",
  },
};

/**
 * A notice in the language the voice speaks (`voice` as its setting names it:
 * "de"), or in the page's where the voice has none ("auto": it speaks whatever
 * it is given). Nothing where there is no wording for that language: a voice
 * is not made to read another language's text, and the page shows compaction
 * as well.
 */
export function notice(kind: Notice, voice: string | undefined, page: string): string | undefined {
  const code = (!voice || voice === "auto" ? page : voice).split("-")[0];
  return WORDING[code]?.[kind];
}
