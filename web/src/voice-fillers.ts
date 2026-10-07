/** What the page has of the portal's fillers: the clips that are ready, and a name for them that changes with the voice. */
export interface FillerSource {
  /** `busy`: the agent is at work, so an answer is on its way, and the portal starts no clip for now. */
  list(busy?: boolean): Promise<{ key: string; clips: number[]; rendering: boolean }>;
  clip(key: string, n: number): Promise<Float32Array>;
  /** Tells the portal that nobody is waiting for the clips any more, so that it stops making them. */
  release?(): Promise<void>;
}

/**
 * How the silence after a turn is filled, in seconds. All four are the user's, set
 * in the voice settings: the timeline reads them and has no cadence of its own.
 */
export interface FillerPacing {
  /** Silence after the turn is taken before the first filler; 0 is at once. */
  first: number;
  /** After a filler has ended, how long before the next: the base that `randomness` varies. */
  every: number;
  /** How far each gap strays from `every`, as a fraction of it: 0 is exactly `every`, 1 is anything from none to twice as long. */
  randomness: number;
  /** At most this many fillers in one wait: a wait longer than that is a long task, and an endless "mhm" is worse than the quiet. */
  max: number;
}
/** What the voice settings offer, per value. */
export const FILLER_LIMITS = {
  first: { min: 0, max: 10, step: 0.5 },
  every: { min: 1, max: 30, step: 0.5 },
  randomness: { min: 0, max: 1, step: 0.05 },
  max: { min: 1, max: 20, step: 1 },
} as const;
/** At once, then every five seconds give or take a fifth, eight at most: about as many fillers over about as long a wait as before, with the same early density. */
export const FILLER_PACING: FillerPacing = { first: 0, every: 5, randomness: 0.2, max: 8 };

/** Settings as they were kept, in any shape: a number within the limits, on its step, for each, and the default for anything that is not a number. */
export function fillerPacing(raw: { [K in keyof FillerPacing]?: unknown }): FillerPacing {
  const pick = (key: keyof FillerPacing) => {
    const value = raw[key], { min, max, step } = FILLER_LIMITS[key];
    const n = typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : NaN;
    if (!Number.isFinite(n)) return FILLER_PACING[key];
    return Number((Math.round(Math.min(max, Math.max(min, n)) / step) * step).toFixed(2));
  };
  return { first: pick("first"), every: pick("every"), randomness: pick("randomness"), max: pick("max") };
}

/**
 * One gap in seconds, from `random` in [0, 1): the base, spread by the randomness
 * evenly to either side of it. Never under the shortest base there is, so a wide
 * spread cannot put two fillers on top of each other: a spread that would go
 * lower is narrowed to end there, which keeps it even and centred on the base
 * (and at the shortest base there is none).
 */
export function fillerGap(pacing: FillerPacing, random = Math.random()): number {
  const every = Math.max(FILLER_LIMITS.every.min, pacing.every);
  const spread = Math.min(pacing.randomness, 1 - FILLER_LIMITS.every.min / every);
  return every * (1 + spread * (2 * random - 1));
}

/** How often to look again while the portal is still making clips, and how many times at most: twenty minutes, as the extra clips are made in a lull and may take a while to come. */
const POLL_MS = 3000;
const POLLS = 400;

/**
 * The fillers, downloaded and held as samples so that one starts the moment it
 * is asked for, with nothing left to fetch or make. Best effort throughout:
 * a clip that is not there yet, or cannot be had, is a filler that is not
 * played, never an error shown.
 */
export class FillerClips {
  private clips = new Map<number, Float32Array>();
  private key = "";
  private run = 0;
  private timer?: ReturnType<typeof setTimeout>;
  /** The clips played since every one of them was, so that none comes round twice before the others have. */
  private heard = new Set<number>();
  /** The last ones played, newest last: not heard again for a while, so that it does not feel like a loop. */
  private recent: number[] = [];
  /** The wait the last filler was for, and the clips it has had: one wait is not given a clip twice while there are others. */
  private wait?: object;
  private inWait = new Set<number>();
  constructor(
    private source: FillerSource,
    private random: () => number = Math.random,
    private pollMs = POLL_MS,
    /** Whether the agent is at work: said with every look, as the portal then holds its clips back. */
    private busy: () => boolean = () => false,
  ) {}
  /** How many clips are held. */
  get ready() { return this.clips.size; }

  /** Looks for the clips, and again while the portal is still making them. Asking again is for a voice that was changed. */
  load() {
    const run = ++this.run;
    clearTimeout(this.timer);
    void this.fetch(run);
  }
  /** Voice mode ended, or fillers are off: no more looking, and the portal is told, which would otherwise make the rest of the clips for nobody. */
  stop() {
    this.run++; clearTimeout(this.timer); this.clips.clear(); this.heard.clear(); this.recent = []; this.inWait.clear();
    void this.source.release?.().catch(() => {});
  }

  private async fetch(run: number, polls = 0) {
    try {
      const { key, clips, rendering } = await this.source.list(this.busy());
      if (run !== this.run) return;
      // Another voice: what was held is not it.
      if (key !== this.key) { this.key = key; this.clips.clear(); this.heard.clear(); this.recent = []; this.inWait.clear(); }
      await Promise.all(clips.filter(n => !this.clips.has(n)).map(async n => {
        try {
          const samples = await this.source.clip(key, n);
          if (run === this.run && samples.length) this.clips.set(n, samples);
        } catch { /* one clip fewer */ }
      }));
      if (run !== this.run || !rendering || polls >= POLLS) return;
    } catch {
      return;
    }
    this.timer = setTimeout(() => { void this.fetch(run, polls + 1); }, this.pollMs);
  }

  /**
   * The next filler, or none. Never the one played last, nor (with enough to
   * choose from) the one before it, and none again until all the others have
   * been: a filler does not come back to back, nor twice while another is still
   * unheard. Within one wait (`wait` is anything that names it) not one the wait
   * has had already, as long as there are others: a round of all the clips that
   * ends in the middle of a long wait does not bring the first ones back. With
   * only the one just played, silence is better than saying it again.
   */
  next(wait?: object): Float32Array | undefined {
    // Without a wait to tell it by there is no memory of one.
    if (wait !== this.wait || !wait) { this.wait = wait; this.inWait.clear(); }
    const all = [...this.clips.keys()];
    const window = all.length > 3 ? 2 : 1;
    const away = this.recent.slice(-window);
    const fresh = (n: number) => !away.includes(n) && !this.inWait.has(n);
    let pool = all.filter(n => !this.heard.has(n) && fresh(n));
    if (!pool.length) { this.heard.clear(); pool = all.filter(fresh); }
    // Every clip has been heard in this wait: one that was not the last two is better than none.
    if (!pool.length) pool = all.filter(n => !away.includes(n));
    if (!pool.length) return undefined;
    const n = pool[Math.floor(this.random() * pool.length)];
    this.heard.add(n); this.inWait.add(n); this.recent.push(n); if (this.recent.length > 2) this.recent.shift();
    return this.clips.get(n);
  }
}

/** The portal's side of it, as HTTP: `fetch` is injectable for tests. */
export function fillerSource(sessionId: string, request: typeof fetch = (...args) => fetch(...args)): FillerSource {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/voice/fillers`;
  return {
    async list(busy = false) {
      const response = await request(busy ? `${base}?busy=1` : base);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    },
    async release() {
      // Kept going if the page is being left, which is when voice mode ends with it.
      await request(`${base}/stop`, { method: "POST", keepalive: true });
    },
    async clip(key, n) {
      const response = await request(`${base}/${key}/${n}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const samples = new Float32Array(bytes.length >> 1), view = new DataView(bytes.buffer);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      return samples;
    },
  };
}
