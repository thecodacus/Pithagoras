import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FillerClips, fillerSource, type FillerSource } from '../web/src/voice-fillers.js';
import { playFading } from '../web/src/pcm-stream.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const clip = (n: number) => Float32Array.of(n, n);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
/** A portal that has made `ready` of its clips so far, a few more each time it is asked while it still makes them. */
function portal(steps: { key?: string; clips: number[]; rendering: boolean }[]) {
  let at = 0; const fetched: string[] = [];
  const source: FillerSource = {
    list: async () => steps[Math.min(at++, steps.length - 1)] as { key: string; clips: number[]; rendering: boolean },
    clip: async (key, n) => { fetched.push(`${key}/${n}`); return clip(n); },
  };
  return { source, fetched };
}
const take = (clips: FillerClips, times: number) => Array.from({ length: times }, () => clips.next()?.[0]);

test('clips are downloaded once, and more are fetched while the portal is still making them', async () => {
  const { source, fetched } = portal([
    { key: 'a', clips: [0], rendering: true },
    { key: 'a', clips: [0, 1, 2], rendering: false },
  ]);
  // The second look waits until the first has been seen, whatever the machine's speed.
  const second = deferred<void>(); const list = source.list; let looks = 0;
  source.list = async () => { if (looks++) await second.promise; return list(); };
  const clips = new FillerClips(source, Math.random, 5);
  clips.load(); await tick();
  assert.equal(clips.ready, 1);
  second.resolve();
  for (let i = 0; i < 200 && clips.ready < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(clips.ready, 3);
  assert.deepEqual(fetched, ['a/0', 'a/1', 'a/2']);
  clips.stop();
});

test('every look says whether the agent is at work, as the portal holds its clips back then', async () => {
  const asked: (boolean | undefined)[] = []; let working = false;
  const source: FillerSource = { list: async busy => { asked.push(busy); return { key: 'a', clips: [], rendering: true }; }, clip: async () => clip(0) };
  const clips = new FillerClips(source, Math.random, 5, () => working);
  clips.load(); await tick();
  working = true;
  for (let i = 0; i < 100 && asked.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
  clips.stop();
  assert.equal(asked[0], false); assert.equal(asked.at(-1), true);
});

test('a portal that has none, or cannot be reached, is a page with no fillers and no error', async () => {
  const none = new FillerClips({ list: async () => ({ key: '', clips: [], rendering: false }), clip: async () => clip(0) });
  none.load(); await tick();
  assert.equal(none.ready, 0); assert.equal(none.next(), undefined);
  const down = new FillerClips({ list: async () => { throw new Error('offline'); }, clip: async () => clip(0) });
  down.load(); await tick();
  assert.equal(down.next(), undefined);
  // One clip that cannot be had leaves the others.
  const flaky = new FillerClips({ list: async () => ({ key: 'a', clips: [0, 1], rendering: false }), clip: async (_key, n) => { if (n === 0) throw new Error('gone'); return clip(n); } });
  flaky.load(); await tick();
  assert.equal(flaky.ready, 1);
});

test('a filler is never the one played last, and none comes round twice before the others have', () => {
  for (let seed = 0; seed < 50; seed++) {
    let state = seed + 1;
    const random = () => (state = (state * 48271) % 2147483647) / 2147483647;
    const clips = new FillerClips({ list: async () => ({ key: 'a', clips: [], rendering: false }), clip: async () => clip(0) }, random);
    for (const n of [0, 1, 2, 3]) (clips as any).clips.set(n, clip(n));
    const played = take(clips, 12) as number[];
    for (let i = 1; i < played.length; i++) assert.notEqual(played[i], played[i - 1], `back to back: ${played}`);
    // Each round of four plays all four, in some order.
    for (const round of [played.slice(0, 4), played.slice(4, 8), played.slice(8, 12)]) assert.deepEqual([...round].sort(), [0, 1, 2, 3], `round: ${round}`);
  }
});

test('with enough clips none of the last two comes again, so that a long wait does not feel like a loop, and a clip that arrives later joins in', () => {
  for (const size of [4, 5, 8]) for (let seed = 0; seed < 50; seed++) {
    let state = seed + 1;
    const random = () => (state = (state * 48271) % 2147483647) / 2147483647;
    const clips = new FillerClips({ list: async () => ({ key: 'a', clips: [], rendering: false }), clip: async () => clip(0) }, random);
    const all = Array.from({ length: size }, (_, n) => n);
    for (const n of all) (clips as any).clips.set(n, clip(n));
    const played = take(clips, size * 3) as number[];
    for (let i = 0; i < played.length; i++) assert.ok(!played.slice(Math.max(0, i - 2), i).includes(played[i]), `repeated within two: ${played}`);
    for (let round = 0; round < 3; round++) assert.deepEqual(played.slice(round * size, (round + 1) * size).sort(), all, `round ${round}: ${played}`);
    // Two more clips made while the wait goes on: heard before any of the others come round again.
    (clips as any).clips.set(size, clip(size)); (clips as any).clips.set(size + 1, clip(size + 1));
    const more = take(clips, 2) as number[];
    assert.deepEqual([...more].sort(), [size, size + 1].sort(), `new ones first: ${more}`);
  }
});

test('one wait is not given a clip twice while there are others, wherever in a round of all the clips it falls', () => {
  for (const size of [5, 8]) for (let before = 0; before < size; before++) for (let seed = 0; seed < 100; seed++) {
    let state = seed + 1;
    const random = () => (state = (state * 48271) % 2147483647) / 2147483647;
    const clips = new FillerClips({ list: async () => ({ key: 'a', clips: [], rendering: false }), clip: async () => clip(0) }, random);
    for (let n = 0; n < size; n++) (clips as any).clips.set(n, clip(n));
    // Some turns in, so that the round is partly through.
    const turns = take(clips, before) as number[];
    const wait = {};
    const played = Array.from({ length: Math.min(6, size) }, () => clips.next(wait)?.[0]) as number[];
    assert.equal(new Set(played).size, played.length, `size ${size}, ${before} before, repeated in one wait: ${turns} | ${played}`);
    assert.ok(!played.slice(0, 2).some((n, i) => [...turns, ...played].slice(Math.max(0, turns.length + i - 2), turns.length + i).includes(n)), `within two of the last: ${turns} | ${played}`);
  }
  // Longer than there are clips: one has to come again, and not within two.
  const clips = new FillerClips({ list: async () => ({ key: 'a', clips: [], rendering: false }), clip: async () => clip(0) });
  for (let n = 0; n < 5; n++) (clips as any).clips.set(n, clip(n));
  const wait = {}; const played = Array.from({ length: 8 }, () => clips.next(wait)?.[0]) as number[];
  for (let i = 0; i < played.length; i++) assert.ok(!played.slice(Math.max(0, i - 2), i).includes(played[i]), `repeated within two: ${played}`);
  assert.equal(new Set(played.slice(0, 5)).size, 5);
});

test('with a single clip, it is played once and then silence beats saying it again', () => {
  const clips = new FillerClips({ list: async () => ({ key: 'a', clips: [], rendering: false }), clip: async () => clip(0) });
  (clips as any).clips.set(7, clip(7));
  assert.deepEqual(take(clips, 3), [7, undefined, undefined]);
  // A second clip arriving is a different one to play.
  (clips as any).clips.set(8, clip(8));
  assert.equal(clips.next()?.[0], 8);
});

test('another voice replaces the clips, and what was played of the old one is forgotten', async () => {
  const { source, fetched } = portal([{ key: 'a', clips: [0], rendering: false }, { key: 'b', clips: [1], rendering: false }]);
  const clips = new FillerClips(source);
  clips.load(); await tick();
  assert.equal(clips.next()?.[0], 0);
  clips.load(); await tick();
  assert.deepEqual(fetched, ['a/0', 'b/1']); assert.equal(clips.ready, 1);
  assert.equal(clips.next()?.[0], 1);
});

test('stopped, it holds nothing and a late answer from the portal is ignored', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const clips = new FillerClips({ list: async () => { await gate; return { key: 'a', clips: [0], rendering: false }; }, clip: async () => clip(0) });
  clips.load(); clips.stop(); release(); await tick(); await tick();
  assert.equal(clips.ready, 0);
});

test('stopped, the portal is told, so that it does not make the rest of the clips for nobody; a portal that cannot be told is no error', async () => {
  let told = 0;
  const clips = new FillerClips({ list: async () => ({ key: 'a', clips: [], rendering: true }), clip: async () => clip(0), release: async () => { told++; } });
  clips.load(); await tick(); clips.stop();
  assert.equal(told, 1);
  const unreachable = new FillerClips({ list: async () => ({ key: 'a', clips: [], rendering: true }), clip: async () => clip(0), release: async () => { throw new Error('offline'); } });
  unreachable.load(); await tick(); unreachable.stop(); await tick();
});

test('the clips are asked for by session and key, and read as 16-bit samples', async () => {
  const urls: string[] = [];
  const request = (async (url: string) => {
    urls.push(url);
    if (url.split('?')[0].endsWith('/fillers')) return new Response(JSON.stringify({ key: 'k', clips: [3], rendering: false }));
    return new Response(new Int16Array([16384, -32768]).buffer);
  }) as unknown as typeof fetch;
  const source = fillerSource('a b', request);
  assert.deepEqual(await source.list(), { key: 'k', clips: [3], rendering: false });
  assert.deepEqual([...await source.clip('k', 3)], [0.5, -1]);
  assert.deepEqual(urls, ['/api/sessions/a%20b/voice/fillers', '/api/sessions/a%20b/voice/fillers/k/3']);
  await source.list(true);
  assert.equal(urls.at(-1), '/api/sessions/a%20b/voice/fillers?busy=1');
  // Telling the portal that nobody waits for the clips: a POST that survives a page being left.
  const posts: { url: string; init?: RequestInit }[] = [];
  await fillerSource('a b', (async (url: string, init?: RequestInit) => { posts.push({ url, init }); return new Response(null, { status: 204 }); }) as unknown as typeof fetch).release!();
  assert.deepEqual(posts.map(p => [p.url, p.init?.method, p.init?.keepalive]), [['/api/sessions/a%20b/voice/fillers/stop', 'POST', true]]);
  await assert.rejects(fillerSource('x', (async () => new Response('', { status: 404 })) as unknown as typeof fetch).list());
});

/** An audio context whose clock only moves when told to. */
function audio() {
  const sources: any[] = [], gains: any[] = [];
  const context = {
    currentTime: 1,
    createBufferSource: () => { const source = { buffer: null, onended: null as any, started: false, stoppedAt: undefined as number | undefined, connect() {}, disconnect() {}, start() { this.started = true; }, stop(at: number) { this.stoppedAt = at; } }; sources.push(source); return source; },
    createGain: () => { const ramps: number[] = []; const gain = { value: 1, ramps, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime(to: number, at: number) { ramps.push(to, at); } }; const node = { gain, connect() {}, disconnect() {} }; gains.push(node); return node; },
  } as unknown as AudioContext;
  return { context, sources, gains };
}

test('a filler that is stopped fades out within a few milliseconds instead of being cut mid-wave, and being stopped is no failure', async () => {
  const { context, sources, gains } = audio(); const stop = new AbortController();
  let started = 0;
  const playing = playFading({} as AudioBuffer, context, {} as AudioNode, stop.signal, () => { started++; });
  assert.equal(started, 1); assert.equal(sources[0].started, true);
  stop.abort();
  // Faded to nothing over 40 ms from now, and stopped there: not at once.
  assert.deepEqual(gains[0].gain.ramps, [0, 1.04]); assert.equal(sources[0].stoppedAt, 1.04);
  sources[0].onended();
  await playing;
});

test('a filler on a clock that does not run still lets go, so that an answer is never held up by it', async () => {
  const { context } = audio(); const stop = new AbortController();
  const playing = playFading({} as AudioBuffer, context, {} as AudioNode, stop.signal, () => {});
  stop.abort();
  // The source never reports ending: the fade and a little more, then it resolves anyway.
  await playing;
});

test('a filler that plays to the end resolves when the source ends', async () => {
  const { context, sources } = audio();
  const playing = playFading({} as AudioBuffer, context, {} as AudioNode, new AbortController().signal, () => {});
  sources[0].onended(); await playing;
  assert.equal(sources[0].stoppedAt, undefined);
});
