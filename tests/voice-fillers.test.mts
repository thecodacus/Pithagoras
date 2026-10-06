import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
const dir = mkdtempSync(join(tmpdir(), 'pithagoras-fillers-'));
process.env.DATA_DIR = dir;
process.env.DOCKER_SOCKET = join(dir, 'no-docker.sock');
const { voiceRouter, pcmWav, fillers: shared } = await import('../server/src/api/voice.js');
const { FillerStore, FILLERS } = await import('../server/src/voice-fillers.js');
const { getDb } = await import('../server/src/db.js');
const { addVoice, deleteVoice } = await import('../server/src/voice-presets.js');
const seconds = (n: number) => Buffer.alloc(Math.round(n * 24000) * 2, 1);
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const KEY = 'a'.repeat(40);

test('the clips are made once, one after another, and kept: a later start finds them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fillers-'));
  const made: string[] = [];
  const render = async (text: string) => { made.push(text); return seconds(1); };
  const store = new FillerStore(() => root, { lazy: 0 });
  assert.deepEqual(await store.status(KEY, render), { clips: [], rendering: true });
  while ((await store.status(KEY, render)).rendering) await tick(5);
  // A portal that was restarted has only the disk to go by.
  const again = new FillerStore(() => root, { lazy: 0 });
  assert.deepEqual(await again.status(KEY, render), { clips: FILLERS.map((_, i) => i), rendering: false });
  assert.deepEqual(made, FILLERS.map(f => f.text));
  assert.equal((await again.read(KEY, 1))?.length, seconds(1).length);
  rmSync(root, { recursive: true, force: true });
});

test('a clip that comes out too long or empty is the runtime saying it twice or nothing: thrown away, and not tried again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fillers-'));
  let made = 0;
  const render = async (text: string) => { made++; return text === FILLERS[0].text ? seconds(FILLERS[0].longest * 2) : text === FILLERS[1].text ? Buffer.alloc(0) : seconds(1.2); };
  const store = new FillerStore(() => root, { lazy: 0 });
  await store.status(KEY, render);
  let status = await store.status(KEY, render);
  while (status.rendering) { await tick(5); status = await store.status(KEY, render); }
  assert.deepEqual(status.clips, FILLERS.map((_, i) => i).slice(2));
  assert.equal(await store.read(KEY, 0), undefined);
  await store.status(KEY, render);
  assert.equal(made, FILLERS.length);
  rmSync(root, { recursive: true, force: true });
});

test('a clip is only made when nothing live is being said, and not at once after it: the answer is not over between two phrases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fillers-'));
  const started: number[] = [];
  const store = new FillerStore(() => root, { lazy: 0, quiet: 60 });
  const render = async () => { started.push(Date.now()); return seconds(1); };
  const end = store.speaking();
  await store.status(KEY, render);
  await tick(100);
  assert.deepEqual(started, []);
  const ended = Date.now(); end(); end();
  // Another phrase of the answer comes before the quiet is over: still nothing.
  await tick(30); const again = store.speaking(); await tick(60);
  assert.deepEqual(started, []);
  again();
  while ((await store.status(KEY, render)).rendering) await tick(5);
  assert.equal(started.length, FILLERS.length);
  assert.ok(started[0] - ended >= 60 + 90 - 5, `started ${started[0] - ended} ms after`);
  rmSync(root, { recursive: true, force: true });
});

test('a clip under way when speech begins is let finish and is kept, as the runtime would finish it anyway; none starts until it is quiet', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fillers-'));
  const made: string[] = []; let cut = 0;
  const render = (text: string, signal: AbortSignal) => new Promise<Buffer>(resolve => {
    made.push(text);
    signal.addEventListener('abort', () => { cut++; });
    setTimeout(() => resolve(seconds(1)), 60);
  });
  const store = new FillerStore(() => root, { lazy: 0, quiet: 80 });
  await store.status(KEY, render);
  await tick(20);
  const end = store.speaking();
  await tick(120);
  // The clip under way was not given up on, and the next was not started while speech was being made.
  assert.equal(cut, 0); assert.deepEqual(made, [FILLERS[0].text]);
  assert.deepEqual((await store.status(KEY, render)).clips, [0]);
  const ended = Date.now(); end();
  await tick(40);
  assert.deepEqual(made, [FILLERS[0].text]);
  let status;
  while ((status = await store.status(KEY, render)).rendering) await tick(10);
  assert.deepEqual(made, FILLERS.map(f => f.text));
  assert.equal(status.clips.length, FILLERS.length); assert.equal(cut, 0);
  rmSync(root, { recursive: true, force: true });
});

test('while the page says the agent is at work no clip is started, and one is when it has stopped saying so', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fillers-'));
  const started: number[] = [];
  const render = async () => { started.push(Date.now()); return seconds(1); };
  const store = new FillerStore(() => root, { lazy: 0, quiet: 300 });
  store.busy();
  await store.status(KEY, render);
  // The page keeps saying so with every look, which is more often than the wait.
  for (let i = 0; i < 12; i++) { await tick(40); store.busy(); }
  assert.deepEqual(started, []);
  const last = Date.now();
  while ((await store.status(KEY, render)).rendering) await tick(10);
  assert.equal(started.length, FILLERS.length);
  assert.ok(started[0] - last >= 250, `started ${started[0] - last} ms after the last`);
  rmSync(root, { recursive: true, force: true });
});

test('the extra clips are made after the first set, in a lull: the first set is not held up by them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fillers-'));
  const made: { text: string; at: number }[] = [];
  // A first set that takes longer than the lull itself: the extras are not due from the start but from when the set is done.
  const render = async (text: string) => { made.push({ text, at: Date.now() }); await tick(60); return seconds(1); };
  const store = new FillerStore(() => root, { quiet: 0, lazy: 250 });
  const extras = FILLERS.map((f, i) => ({ ...f, i })).filter(f => f.extra), core = FILLERS.filter(f => !f.extra);
  assert.ok(extras.length >= 3, 'a few more than the first set, to vary a long wait');
  let status = await store.status(KEY, render);
  // The first set is there as it is made, and does not wait for the lull.
  while (status.clips.length < core.length) { await tick(10); status = await store.status(KEY, render); }
  assert.ok(status.rendering && status.clips.every(i => !FILLERS[i].extra));
  assert.deepEqual(made.map(m => m.text), core.map(f => f.text));
  while ((status = await store.status(KEY, render)).rendering) await tick(10);
  assert.deepEqual(made.map(m => m.text), FILLERS.map(f => f.text), 'the first set first, then the extras');
  assert.ok(made[core.length].at - made[core.length - 1].at >= 230, `the first extra came ${made[core.length].at - made[core.length - 1].at} ms after the first set`);
  assert.deepEqual(status.clips, FILLERS.map((_, i) => i));
  rmSync(root, { recursive: true, force: true });
});

test('an extra clip is not started while recognition or speech is being made, nor the agent at work, nor for the lull after it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fillers-'));
  const made: { text: string; at: number }[] = [];
  const render = async (text: string) => { made.push({ text, at: Date.now() }); return seconds(1); };
  const store = new FillerStore(() => root, { quiet: 0, lazy: 250 });
  const core = FILLERS.filter(f => !f.extra);
  let status = await store.status(KEY, render);
  while (status.clips.length < core.length) { await tick(10); status = await store.status(KEY, render); }
  // Speech made for the page, then the agent at work, for longer than the lull: no extra begins.
  const end = store.speaking();
  await tick(400); assert.equal(made.length, core.length);
  end();
  let last = Date.now();
  for (let i = 0; i < 20; i++) { await tick(30); store.busy(); last = Date.now(); }
  assert.equal(made.length, core.length);
  while ((status = await store.status(KEY, render)).rendering) await tick(10);
  assert.equal(made.length, FILLERS.length);
  assert.ok(made[core.length].at - last >= 230, `the first extra came ${made[core.length].at - last} ms after the last activity`);
  rmSync(root, { recursive: true, force: true });
});

test('a new voice stops the one being made: never two at once, and nothing of the old one is left', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fillers-'));
  let running = 0, peak = 0, first = 0;
  const render = async () => { peak = Math.max(peak, ++running); await tick(15); running--; return seconds(1); };
  const store = new FillerStore(() => root, { lazy: 0 });
  const other = 'b'.repeat(40), third = 'c'.repeat(40);
  await store.status(KEY, async (...args) => { first++; return render(...args); });
  await tick(40);
  // The voice is changed again and again while its clips are being made.
  await store.status(other, render);
  await tick(20);
  await store.status(third, render);
  while ((await store.status(third, render)).rendering) await tick(5);
  assert.equal(peak, 1);
  // The first voice was let go of after the clip it was on, not made to the end.
  assert.ok(first > 0 && first < FILLERS.length, `${first} clips of the first voice`);
  assert.deepEqual(readdirSync(root), [third]);
  assert.deepEqual((await store.status(third, render)).clips, FILLERS.map((_, i) => i));
  rmSync(root, { recursive: true, force: true });
});

test('clips are only made while a page asks: once nobody does, no request goes out, and the next question makes the rest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fillers-'));
  const made: string[] = [];
  const render = async (text: string) => { made.push(text); await tick(50); return seconds(1); };
  const store = new FillerStore(() => root, { lazy: 0, quiet: 0, patience: 120 });
  await store.status(KEY, render);
  // The page does not ask again, as when voice mode ended or fillers were switched off.
  await tick(500);
  const stopped = made.length;
  assert.ok(stopped > 0 && stopped < FILLERS.length, `${stopped} clips`);
  await tick(250);
  assert.equal(made.length, stopped);
  // Asked again, it makes what is missing and nothing twice.
  let status = await store.status(KEY, render);
  assert.equal(status.clips.length, stopped); assert.equal(status.rendering, true);
  while ((status = await store.status(KEY, render)).rendering) await tick(10);
  assert.deepEqual(made, FILLERS.map(f => f.text));
  assert.equal(status.clips.length, FILLERS.length);
  rmSync(root, { recursive: true, force: true });
});

test('stop drops the clip being made at the runtime, and no more are made until the next question', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fillers-'));
  const made: string[] = [], cut: string[] = [], warned: string[] = [];
  const render = (text: string, signal: AbortSignal) => new Promise<Buffer>((resolve, reject) => {
    made.push(text);
    const timer = setTimeout(() => resolve(seconds(1)), 80);
    signal.addEventListener('abort', () => { clearTimeout(timer); cut.push(text); reject(signal.reason); });
  });
  const store = new FillerStore(() => root, { lazy: 0, warn: message => warned.push(message) });
  await store.status(KEY, render);
  await tick(30);
  store.stop();
  await tick(250);
  assert.deepEqual(made, [FILLERS[0].text]); assert.deepEqual(cut, [FILLERS[0].text]);
  assert.deepEqual(warned, []);
  // Not asking is not a failure either: the next question carries on.
  let status = await store.status(KEY, render);
  assert.equal(status.rendering, true);
  while ((status = await store.status(KEY, render)).rendering) await tick(10);
  assert.equal(status.clips.length, FILLERS.length);
  rmSync(root, { recursive: true, force: true });
});

test('a voice changed and changed back loses none of the clips it was told were ready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fillers-'));
  const made: string[] = [];
  const renderFor = (voice: string) => async (text: string) => { made.push(`${voice}:${text}`); await tick(40); return seconds(1); };
  const store = new FillerStore(() => root, { lazy: 0 });
  const other = 'b'.repeat(40);
  await store.status(KEY, renderFor('a'));
  while (!(await store.status(KEY, renderFor('a'))).clips.length) await tick(5);
  await tick(60);
  const before = (await store.status(KEY, renderFor('a'))).clips;
  assert.ok(before.length > 0 && before.length < FILLERS.length, `${before.length} clips`);
  // Away and back at once, as with a setting moved and moved back.
  const away = store.status(other, renderFor('b'));
  const back = await store.status(KEY, renderFor('a'));
  await away;
  // What was listed is still there, whatever happens next.
  await tick(30);
  for (const n of back.clips) assert.ok(await store.read(KEY, n), `clip ${n} of the voice is gone`);
  while ((await store.status(KEY, renderFor('a'))).rendering) await tick(5);
  assert.deepEqual((await store.status(KEY, renderFor('a'))).clips, FILLERS.map((_, i) => i));
  // What the voice had was kept, not made again (only the clip under way when it was let go of is); the other voice was never begun.
  for (const n of before) assert.equal(made.filter(text => text === `a:${FILLERS[n].text}`).length, 1, `clip ${n} was made again`);
  assert.deepEqual(made.filter(text => text.startsWith('b:')), []);
  assert.deepEqual(readdirSync(root), [KEY]);
  rmSync(root, { recursive: true, force: true });
});

test('a runtime that does not say a text the same way each time gets it made again, and is given up on only for a while, not on disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fillers-'));
  const calls: string[] = [];
  let wrong = 2;
  const render = async (text: string) => { calls.push(text); return text === FILLERS[0].text && wrong-- > 0 ? seconds(FILLERS[0].longest * 2) : text === FILLERS[1].text ? seconds(FILLERS[1].longest * 2) : seconds(1); };
  const store = new FillerStore(() => root, { lazy: 0 });
  await store.status(KEY, render, false);
  while ((await store.status(KEY, render, false)).rendering) await tick(5);
  // The first came out right on the third try; the second never did.
  assert.equal(calls.filter(text => text === FILLERS[0].text).length, 3);
  assert.equal(calls.filter(text => text === FILLERS[1].text).length, 3);
  assert.deepEqual((await store.status(KEY, render, false)).clips, FILLERS.map((_, i) => i).filter(i => i !== 1));
  assert.deepEqual(readdirSync(join(root, KEY)).filter(name => name.endsWith('.skip')), []);
  // Not tried again in this run, but again after a restart.
  const before = calls.length;
  await store.status(KEY, render, false); await tick(20);
  assert.equal(calls.length, before);
  const restarted = new FillerStore(() => root, { lazy: 0 });
  await restarted.status(KEY, render, false);
  while ((await restarted.status(KEY, render, false)).rendering) await tick(5);
  assert.equal(calls.length, before + 3);
  rmSync(root, { recursive: true, force: true });
});

test('a failure is told once and not tried again at once; after a while it is', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fillers-'));
  let now = 0, calls = 0; const warned: string[] = [];
  const store = new FillerStore(() => root, { lazy: 0, warn: message => warned.push(message), clock: () => now });
  const render = async () => { calls++; throw new Error('runtime down'); };
  await store.status(KEY, render); await tick(10);
  assert.deepEqual(await store.status(KEY, render), { clips: [], rendering: false });
  assert.deepEqual(warned, ['runtime down']); assert.equal(calls, 1);
  now = 61_000;
  await store.status(KEY, render); await tick(10);
  assert.equal(calls, 2);
  rmSync(root, { recursive: true, force: true });
});

test('another voice drops the clips of the old one, and a key or number that is not one reads nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fillers-'));
  const store = new FillerStore(() => root, { lazy: 0 });
  const other = 'b'.repeat(40);
  for (const key of [KEY, other]) { while ((await store.status(key, async () => seconds(1))).rendering) await tick(5); }
  assert.deepEqual(readdirSync(root), [other]);
  assert.equal(await store.read('../../etc', 0), undefined);
  assert.equal(await store.read(other, -1), undefined);
  assert.equal(await store.read(other, FILLERS.length), undefined);
  assert.equal(await store.read(other, 0.5), undefined);
  await assert.rejects(store.status('../x', async () => seconds(1)));
  rmSync(root, { recursive: true, force: true });
});

// The same through the portal's own routes, against a Chatterbox that answers as it does.
const heard: { input: string; language: string }[] = [];
let slow: (() => void) | undefined; let hold = false; let long = '';
let stall = false; const stalled: (() => void)[] = []; let cut = 0;
const upstream = express();
upstream.post('/v1/audio/speech', express.json({ limit: '5mb' }), async (req, res) => {
  const wav = (n: number) => res.set({ 'Content-Type': 'audio/wav' }).send(pcmWav(seconds(n)));
  if (req.body.input === 'live speech') { hold = true; await new Promise<void>(resolve => { slow = resolve; }); hold = false; return wav(1); }
  heard.push({ input: req.body.input, language: req.body.language });
  // A runtime that is slow over this one until the page it is for hangs up.
  if (stall) { await new Promise<void>(resolve => { stalled.push(resolve); res.on('close', () => { cut++; resolve(); }); }); return; }
  wav(req.body.input === long ? 6 : 1.2);
});
let listening = false; let releaseWhisper: (() => void) | undefined;
upstream.post('/inference', async (_req, res) => { listening = true; await new Promise<void>(resolve => { releaseWhisper = resolve; }); listening = false; res.json({ text: 'hello' }); });
const backend = upstream.listen(0, '127.0.0.1'); await new Promise<void>(r => backend.once('listening', r));
const port = (backend.address() as { port: number }).port;
const app = express(); app.use(express.json()); app.use('/api', voiceRouter());
const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
shared.quiet = 30; shared.lazy = 30;
after(async () => {
  await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => backend.close(() => r()))]);
  getDb().close(); rmSync(dir, { recursive: true, force: true });
});
// A voice from the library, cloned from a one-second recording: what Chatterbox speaks with.
const recording = (() => { const wav = Buffer.concat([Buffer.alloc(44), Buffer.alloc(32000)]); wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40); return wav; })();
const voice = addVoice({ name: 'Test voice', kind: 'clone', instruction: 'A calm voice.', transcript: 'The reference words.', audio: recording.toString('base64') });
getDb().prepare("INSERT INTO sessions (id,title,workspace,executor,status,created_at,updated_at) VALUES ('s','Voice','/tmp','host','idle','now','now')").run();
const save = (extra: object = {}) => fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, whisperUrl: `http://127.0.0.1:${port}/inference`, breezeUrl: `http://127.0.0.1:${port}/v1/audio/speech`, instruction: 'A calm voice.', runtime: 'chatterbox', voice: voice.id, language: 'de', ...extra }) });
const fillers = async () => (await fetch(`${base}/sessions/s/voice/fillers`)).json() as Promise<{ key: string; clips: number[]; rendering: boolean }>;
const ready = async () => { let status = await fillers(); while (status.rendering) { await tick(10); status = await fillers(); } return status; };

test('the portal makes the fillers in the voice and language set, from the same text whatever the language, and serves them as PCM', async () => {
  assert.equal((await save({ language: 'de' })).status, 200);
  const german = await ready();
  assert.deepEqual(german.clips, FILLERS.map((_, i) => i));
  assert.deepEqual(heard.map(h => h.input), FILLERS.map(f => f.text));
  assert.ok(heard.every(h => h.language === 'de'));
  const clip = await fetch(`${base}/sessions/s/voice/fillers/${german.key}/2`);
  assert.equal(clip.headers.get('content-type'), 'audio/pcm'); assert.equal(clip.headers.get('x-sample-rate'), '24000');
  assert.equal((await clip.arrayBuffer()).byteLength, seconds(1.2).length);
  // Another language: another voice for the portal, said from the same words.
  heard.length = 0;
  assert.equal((await save({ language: 'ko' })).status, 200);
  const korean = await ready();
  assert.notEqual(korean.key, german.key);
  assert.deepEqual(heard.map(h => h.input), FILLERS.map(f => f.text));
  assert.ok(heard.every(h => h.language === 'ko'));
  // Asking again is not making again.
  heard.length = 0; await ready(); await fillers();
  assert.deepEqual(heard, []);
  assert.equal((await fetch(`${base}/sessions/s/voice/fillers/${german.key}/0`)).status, 404);
  assert.equal((await fetch(`${base}/sessions/s/voice/fillers/${korean.key}/99`)).status, 404);
  assert.equal((await fetch(`${base}/sessions/s/voice/fillers/..%2F..%2Fx/0`)).status, 404);
});

test('a render that comes out as a run-on is not offered', async () => {
  long = FILLERS[3].text;
  assert.equal((await save({ language: 'fr' })).status, 200);
  const status = await ready();
  assert.deepEqual(status.clips, FILLERS.map((_, i) => i).filter(i => i !== 3));
  long = '';
});

test('while live speech is being made, no filler is started; the answer comes first', async () => {
  assert.equal((await save({ language: 'it' })).status, 200);
  heard.length = 0;
  const speaking = fetch(`${base}/sessions/s/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"live speech"}' });
  while (!hold) await tick(5);
  try {
    await fillers(); await tick(600);
    assert.deepEqual(heard, []);
  } finally { slow!(); }
  assert.equal((await speaking).status, 200);
  const status = await ready();
  assert.equal(status.clips.length, FILLERS.length);
});

test('while recognition is being made no clip is started, nor soon after: the answer follows it', async () => {
  assert.equal((await save({ language: 'sv' })).status, 200);
  heard.length = 0;
  const recognising = fetch(`${base}/sessions/s/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: pcmWav(Buffer.alloc(3200)) });
  while (!listening) await tick(5);
  try {
    await fillers(); await tick(300);
    assert.deepEqual(heard, []);
  } finally { releaseWhisper!(); }
  assert.equal((await recognising).status, 200);
  assert.equal((await ready()).clips.length, FILLERS.length);
});

test('a page that says the agent is at work with its look has no clip started meanwhile', async () => {
  assert.equal((await save({ language: 'fi' })).status, 200);
  heard.length = 0; shared.quiet = 400;
  try {
    for (let i = 0; i < 15; i++) { await fetch(`${base}/sessions/s/voice/fillers?busy=1`); await tick(30); }
    assert.deepEqual(heard, []);
    assert.equal((await ready()).clips.length, FILLERS.length);
  } finally { shared.quiet = 30; shared.lazy = 30; }
});

/** Starts a render that the fake runtime holds, does `action`, and says how many requests the runtime saw hang up. */
async function cutBy(language: string, action: () => Promise<Response>) {
  assert.equal((await save({ language })).status, 200);
  heard.length = 0; stall = true; cut = 0;
  let response: Response | undefined;
  try {
    await fillers();
    while (!heard.length) await tick(5);
    response = await action();
    for (let i = 0; i < 100 && !cut; i++) await tick(10);
    return { cut, response };
  } finally { stall = false; stalled.splice(0).forEach(release => release()); }
}

test('a page that ends voice mode stops the clip being made, whether or not the portal manages the speech service', async () => {
  const { cut, response } = await cutBy('no', () => fetch(`${base}/sessions/s/voice/connection`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: 'c', active: false }) }));
  assert.equal(cut, 1, 'the runtime was not told to let go of the clip');
  assert.deepEqual(await response!.json(), { managed: false });
  // Not asked again, nothing is made; asked again, the rest is.
  const made = heard.length; await tick(100);
  assert.equal(heard.length, made);
  assert.equal((await ready()).clips.length, FILLERS.length);
});

test('a page that switches fillers off stops the clip being made', async () => {
  const { cut, response } = await cutBy('tr', () => fetch(`${base}/sessions/s/voice/fillers/stop`, { method: 'POST' }));
  assert.equal(cut, 1, 'the runtime was not told to let go of the clip');
  assert.equal(response!.status, 204);
  assert.equal((await ready()).clips.length, FILLERS.length);
});

test('a portal with status speech off, or with no speech synthesis, makes and offers nothing', async () => {
  heard.length = 0;
  process.env.VOICE_STATUS_SPEECH = 'false';
  try {
    assert.equal((await save({ language: 'es' })).status, 200);
    assert.deepEqual(await fillers(), { key: '', clips: [], rendering: false });
  } finally { delete process.env.VOICE_STATUS_SPEECH; }
  assert.equal((await save({ language: 'es', runtime: 'none', breezeUrl: '', voice: 'design' })).status, 200);
  assert.deepEqual(await fillers(), { key: '', clips: [], rendering: false });
  assert.deepEqual(heard, []);
});

test('a voice that cannot speak has no fillers, and says why', async () => {
  assert.equal((await save({ language: 'pl' })).status, 200);
  // The voice is deleted: the setting falls back to the designed one, which Chatterbox cannot speak.
  deleteVoice(voice.id);
  const status = await fillers() as { clips: number[]; error?: string };
  assert.deepEqual(status.clips, []); assert.match(status.error ?? '', /reference clone/);
});
