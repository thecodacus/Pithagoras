import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** What every speech runtime here makes: mono, 16-bit, this many samples a second. */
const RATE = 24000;
/** Shorter than this is not a sound: the runtime made nothing. */
const SHORTEST = 0.25;
/** After a failed attempt, how long before the next voice start tries again. */
const RETRY_AFTER = 60_000;

/**
 * What the voice says to fill the silence after a turn. Not wording that would
 * have to be kept per language: the sounds a person makes while listening, which
 * every language has, and the one word every language has taken over ("okay").
 * Each is made with the voice's own language setting, so it is said as that
 * language says it, from the same text everywhere.
 *
 * Always two short sounds, never one: with Chatterbox a one-word "Okay." or a
 * wordless "Hmm." or "Mhm." is said twice, runs on for seconds, or comes out as
 * other words (Polish turned "Mhm." into a sentence). Two of them came out once
 * in every language of Chatterbox that was tried, at 0.9 to 2 seconds.
 *
 * `longest` is what a clip may come out at, a little over what the text takes: a
 * clip beyond that is the runtime saying it twice or running on, and is thrown
 * away instead of kept, whatever the runtime and language.
 */
export const FILLERS: readonly { text: string; longest: number; extra?: true }[] = [
  { text: "Ah, okay.", longest: 2.6 },
  { text: "Oh, okay.", longest: 2.6 },
  { text: "Okay, ah.", longest: 2.6 },
  { text: "Ah, mhm.", longest: 2.6 },
  { text: "Okay, mhm.", longest: 2.6 },
  // More of the same kind, for a long wait, where five would come round too soon. Made in a lull after the others: nothing waits for them.
  { text: "Mhm, okay.", longest: 2.6, extra: true },
  { text: "Oh, mhm.", longest: 2.6, extra: true },
  { text: "Okay, oh.", longest: 2.6, extra: true },
];

/** Makes one text as 24 kHz PCM. */
export type Render = (text: string, signal: AbortSignal) => Promise<Buffer>;

const KEY = /^[0-9a-f]{40}$/;
/** How often a clip that came out wrong is made again, for a runtime that does not say the same thing each time. */
const TRIES = 3;
/** After live speech, how long before a clip is started: a moment between two phrases of an answer is not the answer being over. */
const QUIET_MS = 8000;
/** The same for the extra clips, which nothing waits for: they are made in a lull, not at once. */
const LAZY_MS = 30_000;
/**
 * How long a page may go without asking before nobody is taken to be waiting for
 * the clips: the page asks every three seconds while they are being made. A page
 * that ends voice mode or switches fillers off says so (`stop()`); this is for one
 * that cannot, a tab that was closed, so that the speech runtime is not used, and a
 * model loaded back onto the GPU, for clips that nobody wants.
 */
const ASKED_MS = 10_000;

/**
 * The fillers of the voice that is set up, made once and kept on disk. They are
 * made here and downloaded by the page, not made at play time: a filler has to
 * start the moment a turn ends, with no synthesis in front of it.
 *
 * The speech runtime has one slot, and a request that has been started is not
 * given up by it: audio.cpp runs a model to the end whatever the client does, and
 * only notices a client that is gone when it writes the answer. So a clip cannot
 * be cut off for the answer, and one under way when the answer is asked for makes
 * the answer wait for it, by the time of one clip (about one to five seconds,
 * by the hardware). What can be done is to start clips when no answer is near:
 * not while recognition or speech is being made, nor for a while after it, nor
 * while the page says the agent is at work (`busy`), as an answer is on its way
 * then. A clip that is under way when that begins is let finish and kept, not
 * thrown away only to be made again.
 *
 * A voice is a `key`: whatever decides how it sounds. Only one voice is made at a
 * time, and only while a page asks for it: it ends when nobody has asked for a while,
 * and the next question starts it again. A new key stops the one being made, and the clips of the others are dropped
 * once the first clip of the new one is made, so changing the voice never leaves a
 * pile behind, nor loses what a voice changed back to had already.
 */
export class FillerStore {
  /** The voice being made, and what stops it. */
  private current?: { key: string; run: AbortController; done: Promise<void> };
  private asking: Promise<unknown> = Promise.resolve();
  private failed = new Map<string, number>();
  /** Clips of a runtime that does not say the same thing each time, which came out wrong too often: left alone until the portal is restarted. */
  private gaveUp = new Set<string>();
  private live = 0;
  private endedAt = -Infinity;
  private askedAt = -Infinity;
  private wake = new Set<() => void>();
  private warn: (message: string) => void;
  private clock: () => number;
  /** How long after live speech the clips wait. */
  public quiet: number;
  /** How long after live speech, and after the first set was made, the extra clips wait. */
  public lazy: number;
  /** How long without a question before nobody is taken to be waiting. */
  public patience: number;
  constructor(
    private root: () => string,
    options: { warn?: (message: string) => void; clock?: () => number; quiet?: number; lazy?: number; patience?: number } = {},
  ) {
    this.warn = options.warn ?? (message => console.error("[voice] fillers:", message));
    this.clock = options.clock ?? Date.now;
    this.quiet = options.quiet ?? QUIET_MS;
    this.lazy = options.lazy ?? LAZY_MS;
    this.patience = options.patience ?? ASKED_MS;
  }
  private dir(key: string) { return path.join(this.root(), key); }

  /**
   * Recognition or speech is being made for the page: from now, until the
   * returned function is called and a while after, no clip is started. One that is
   * under way is not cut off, as the runtime would finish it anyway.
   */
  speaking(): () => void {
    this.live++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true; this.live--; this.endedAt = Date.now();
      for (const wake of [...this.wake]) wake();
    };
  }

  /** The page says the agent is at work, so an answer is on its way: the wait before a clip starts begins anew. */
  busy() { this.endedAt = Date.now(); }

  /** Resolves when no live speech is being made nor was just now (nor since `since`, for as long as `quiet`), or when `signal` stops the wait. */
  private async idle(signal: AbortSignal, quiet = this.quiet, since = -Infinity) {
    while (!signal.aborted) {
      const wait = this.live ? undefined : Math.max(this.endedAt, since) + quiet - Date.now();
      if (wait !== undefined && wait <= 0) return;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.wake.delete(done); signal.removeEventListener("abort", done); resolve(); };
        const timer = wait === undefined ? undefined : setTimeout(done, wait);
        this.wake.add(done); signal.addEventListener("abort", done, { once: true });
      });
    }
  }

  /**
   * The clips there are for this voice, and whether more are on their way. Asking is what starts the making of the missing ones.
   * `steady` is whether the runtime says the same thing each time: what it got wrong once it gets wrong again, so that is not tried again.
   */
  status(key: string, render: Render, steady = true): Promise<{ clips: number[]; rendering: boolean }> {
    if (!KEY.test(key)) return Promise.reject(new Error("Not a voice key"));
    this.askedAt = Date.now();
    // One question at a time and in the order asked, so that the voice asked about last is the one that is made.
    const answer = this.asking.then(() => this.look(key, render, steady));
    this.asking = answer.catch(() => {});
    return answer;
  }
  private async look(key: string, render: Render, steady: boolean) {
    // Another voice than the one being made: that is not wanted any more. It is let go of before the disk is looked at, as it may be clearing what is there, and what is listed as ready has to stay.
    while (this.current && this.current.key !== key) { this.current.run.abort(); await this.current.done; }
    const { clips, todo } = await this.kept(key);
    if (this.current && this.current.key !== key) this.current.run.abort();
    let rendering = !!this.current && this.current.key === key && !this.current.run.signal.aborted;
    if (todo.length && !rendering && this.clock() - (this.failed.get(key) ?? -Infinity) >= RETRY_AFTER) {
      const run = new AbortController(), before = this.current?.done;
      // After the one before has let go, so that two never make clips at once, and the old one cannot write into what the new one has cleared.
      const done = (async () => { await before; await this.make(key, render, run.signal, steady); })()
        .finally(() => { if (this.current?.run === run) this.current = undefined; });
      this.current = { key, run, done };
      rendering = true;
    }
    return { clips, rendering };
  }

  /** Nobody is waiting for the clips any more, for instance as voice mode ended: the one being made is dropped, and the next question makes the rest. */
  stop() { this.current?.run.abort(); }

  /** What is on disk for this voice: the clips there are, and the ones still to make. */
  private async kept(key: string) {
    const files = await readdir(this.dir(key)).catch(() => [] as string[]);
    const clips = FILLERS.map((_, i) => i).filter(i => files.includes(`${i}.pcm`));
    const todo = FILLERS.map((_, i) => i).filter(i => !files.includes(`${i}.pcm`) && !files.includes(`${i}.skip`) && !this.gaveUp.has(`${key}/${i}`));
    return { clips, todo };
  }

  /** One clip as it was kept, or none for a key or a number that is not one. */
  async read(key: string, n: number): Promise<Buffer | undefined> {
    if (!KEY.test(key) || !Number.isInteger(n) || n < 0 || n >= FILLERS.length) return undefined;
    return readFile(path.join(this.dir(key), `${n}.pcm`)).catch(() => undefined);
  }

  /** One clip, made when no answer is near, an extra one when it has been quiet for long. Nothing once `run` is stopped. */
  private async render(text: string, render: Render, run: AbortSignal, calm?: number): Promise<Buffer | undefined> {
    await (calm === undefined ? this.idle(run) : this.idle(run, this.lazy, calm));
    // Not started for nobody: the page that asked has gone, and a request now would use the runtime, and load its model, for nothing.
    if (run.aborted || Date.now() - this.askedAt > this.patience) return undefined;
    try {
      const pcm = await render(text, AbortSignal.any([run, AbortSignal.timeout(60_000)]));
      return run.aborted ? undefined : pcm;
    } catch (e) {
      if (run.aborted) return undefined;
      throw e;
    }
  }

  /** Makes the clips one after the other. A failure is remembered and not retried for a while. */
  private async make(key: string, render: Render, run: AbortSignal, steady: boolean) {
    const dir = this.dir(key);
    try {
      // What is to be made is looked up now, not when it was asked for: the one before may have made some.
      const { todo } = await this.kept(key);
      let cleared = false;
      // Since when it has been calm: the first set is what is waited for, and the extras come after it, in a lull.
      let calm = Date.now();
      for (const i of todo) {
        for (let tries = 1; ; tries++) {
          const pcm = await this.render(FILLERS[i].text, render, run, FILLERS[i].extra ? calm : undefined);
          if (!pcm || run.aborted) return;
          const seconds = pcm.length / 2 / RATE;
          // The other voices are cleared away once there is something of this one to keep, not before: a voice changed back again while its first clip is being made has lost nothing.
          if (!cleared) {
            cleared = true;
            for (const name of await readdir(this.root()).catch(() => [] as string[]))
              if (name !== key) await rm(path.join(this.root(), name), { recursive: true, force: true });
          }
          await mkdir(dir, { recursive: true });
          if (seconds >= SHORTEST && seconds <= FILLERS[i].longest) {
            // Whole or not at all: a listing never sees half a clip.
            await writeFile(path.join(dir, `${i}.tmp`), pcm);
            await rename(path.join(dir, `${i}.tmp`), path.join(dir, `${i}.pcm`));
            if (!FILLERS[i].extra) calm = Date.now();
            break;
          }
          // A runtime that says it the same way each time would say this again: kept as nothing, so that voice start does not make it every time.
          if (steady) { await writeFile(path.join(dir, `${i}.skip`), ""); break; }
          // One that does not may get it right the next time; after a few it is let be, until the portal is started again.
          if (tries >= TRIES) { this.gaveUp.add(`${key}/${i}`); break; }
        }
      }
      this.failed.delete(key);
    } catch (e) {
      this.failed.set(key, this.clock());
      this.warn((e as Error).message);
    }
  }
}
