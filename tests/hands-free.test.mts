import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { HandsFreeVoice, type VoiceIO } from '../web/src/hands-free.js';
import { FILLER_PACING, FILLER_LIMITS, fillerGap, fillerPacing, type FillerPacing } from '../web/src/voice-fillers.js';
import { samplesWav } from '../web/src/voice.js';
import { notice } from '../web/src/voice-notices.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const reply = (id: string, done = true) => ({ kind: 'assistant' as const, id, text: 'A spoken answer.', thinking: '', done });
function setup(patch: Partial<VoiceIO> & { speak?: (text: string, signal: AbortSignal) => Promise<void> } = {}) {
  const sent: string[] = [], spoken: string[] = [], errors: string[] = [];
  const io: VoiceIO = {
    transcribe: async () => 'hello', send: async text => { sent.push(text); },
    abort: async () => {}, agentRunning: () => false,
    synthesize: async text => async signal => { if (patch.speak) await patch.speak(text, signal); else spoken.push(text); }, phase: () => {}, error: message => { errors.push(message); }, ...patch,
  };
  return { voice: new HandsFreeVoice(io, [reply('a10')]), sent, spoken, errors };
}
/** A filler that plays until it is cut, and what happened to it. */
function fillers() {
  const log: string[] = [];
  const filler = (signal: AbortSignal) => {
    log.push('filler:start');
    return new Promise<void>(resolve => signal.addEventListener('abort', () => { log.push('filler:cut'); resolve(); }, { once: true }));
  };
  return { filler, log };
}
test('successive automatic turns work without another mic toggle; history stays silent', async () => {
  const { voice, sent, spoken } = setup();
  voice.observe([reply('a1'), reply('a10')]);
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.deepEqual(sent, ['hello']);
  voice.observe([reply('a10'), reply('a20')]); await tick();
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  voice.observe([reply('a10'), reply('a20'), reply('a30')]); await tick();
  assert.equal(sent.length, 2); assert.equal(spoken.length, 2); voice.stop();
});
test('barge-in immediately cancels playback and ignores the interrupted reply remainder', async () => {
  let playbackSignal: AbortSignal | undefined;
  let aborted = 0;
  const { voice, sent } = setup({ agentRunning: () => true, abort: async () => { aborted++; }, speak: async (_text, signal) => {
    playbackSignal = signal; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  } });
  voice.observe([reply('a20'), reply('a21', false)]); await tick();
  voice.speechStart(); assert.equal(playbackSignal?.aborted, true); await tick();
  // Not stopped for a sound; stopped once it is words for the agent.
  assert.equal(aborted, 0);
  voice.heard('hello'); await tick();
  assert.equal(aborted, 1);
  voice.observe([reply('a20'), reply('a21')]);
  voice.speechEnd(new Float32Array(16000)); await tick();
  assert.deepEqual(sent, ['hello']); voice.stop();
});
test('speech resumed during transcription is combined, not dropped or sent halfway through', async () => {
  const first = deferred<string>(); let count = 0;
  const { voice, sent } = setup({ transcribe: () => ++count === 1 ? first.promise : Promise.resolve('and the second part') });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000));
  voice.speechStart(); first.resolve('the first part'); await tick();
  assert.equal(sent.length, 0);
  voice.speechEnd(new Float32Array(16000)); await tick();
  assert.deepEqual(sent, ['the first part and the second part']); voice.stop();
});
test('barge-in waits for an in-flight send before abort, then sends the next turn', async () => {
  const accepted = deferred<void>(); const calls: string[] = [];
  const { voice } = setup({ send: async () => { calls.push('send'); if (calls.length === 1) await accepted.promise; }, abort: async () => { calls.push('abort'); } });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  voice.speechStart(); voice.heard('hello'); voice.speechEnd(new Float32Array(16000));
  assert.deepEqual(calls, ['send']); accepted.resolve(); await tick(); await tick();
  assert.deepEqual(calls, ['send', 'abort', 'send']); voice.stop();
});
test('ending voice during transcription aborts the request and cannot send late text', async () => {
  const pending = deferred<string>(); let signal: AbortSignal | undefined;
  const { voice, sent } = setup({ transcribe: (_audio, input) => { signal = input; return pending.promise; } });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); voice.stop();
  assert.equal(signal?.aborted, true); pending.resolve('must not be sent'); await tick();
  assert.deepEqual(sent, []);
});
test('a failed interruption is reported and does not send into the old running turn', async () => {
  const { voice, sent, errors } = setup({ agentRunning: () => true, abort: async () => { throw new Error('offline'); } });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.equal(sent.length, 0); assert.ok(errors.some(e => e.includes('offline'))); voice.stop();
});
test('VAD samples produce a 16 kHz PCM WAV with clipped amplitudes', async () => {
  const wav = new DataView(await samplesWav(new Float32Array([-2, 0, 2])).arrayBuffer());
  assert.equal(wav.getUint32(24, true), 16000); assert.equal(wav.getUint32(40, true), 6);
  assert.equal(wav.getInt16(44, true), -32768); assert.equal(wav.getInt16(48, true), 32767);
});

test('mute discards pending microphone input but leaves agent and playback alone', async () => {
  const transcription = deferred<string>(); let signal: AbortSignal | undefined;
  let aborts = 0; let playback: AbortSignal | undefined;
  const { voice, sent } = setup({ transcribe: (_samples, s) => { signal = s; return transcription.promise; }, abort: async () => { aborts++; },
    speak: async (_text, s) => { playback = s; await new Promise<void>(resolve => s.addEventListener('abort', () => resolve(), { once: true })); },
  });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000));
  voice.setMuted(true); assert.equal(signal?.aborted, true);
  transcription.resolve('discard this partial turn'); await tick(); assert.deepEqual(sent, []);
  voice.observe([reply('a20')]); await tick();
  assert.equal(playback?.aborted, false);
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.equal(aborts, 0); assert.equal(playback?.aborted, false); assert.deepEqual(sent, []);
  voice.stop();
});

test('unmute accepts new turns in the same voice session', async () => {
  const { voice, sent } = setup();
  voice.setMuted(true); voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.deepEqual(sent, []);
  voice.setMuted(false); voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.deepEqual(sent, ['hello']); voice.stop();
});

test('speaks stable sentences before response completion without replaying deltas or the final event', async () => {
  const { voice, spoken } = setup();
  const part = (text: string, done = false) => ({ ...reply('a20', done), text });
  voice.observe([part('Here is the first sentence. Now')]); await tick();
  assert.deepEqual(spoken, ['Here is the first sentence.']);
  voice.observe([part('Here is the first sentence. Now the rest arrives.')]); await tick();
  assert.equal(spoken.length, 1);
  voice.observe([part('Here is the first sentence. Now the rest arrives.', true)]); await tick();
  voice.observe([part('Here is the first sentence. Now the rest arrives.', true)]); await tick();
  assert.deepEqual(spoken, ['Here is the first sentence.', 'Now the rest arrives.']); voice.stop();
});

test('streaming code and link fragments are not spoken, and a final unfinished sentence is flushed', async () => {
  const { voice, spoken } = setup();
  const part = (text: string, done = false) => ({ ...reply('a20', done), text });
  voice.observe([part('Here is an introduction. ```js\nsecret.call();\n')]); await tick();
  assert.deepEqual(spoken, ['Here is an introduction.']);
  voice.observe([part('Here is an introduction. ```js\nsecret.call();\n```\nSee [the docs](https://secret.')]); await tick();
  assert.ok(spoken.join(' ').includes('Code is shown in the transcript.'));
  voice.observe([part('Here is an introduction. ```js\nsecret.call();\n```\nSee [the docs](https://secret.example). Final words', true)]); await tick();
  assert.ok(spoken.join(' ').endsWith('See the docs. Final words'));
  assert.ok(!spoken.join(' ').includes('secret')); voice.stop();
});


test('multiple available sentences stay separate so playback buffers only one phrase at a time', async () => {
  const { voice, spoken } = setup();
  voice.observe([{ ...reply('a20'), text: 'This is the first sentence. This is the second sentence. This is the final sentence.' }]);
  await tick();
  assert.deepEqual(spoken, ['This is the first sentence.', 'This is the second sentence.', 'This is the final sentence.']);
  voice.stop();
});


test('tiny sentences join the next phrase, while a short final reply still flushes', async () => {
  const { voice, spoken } = setup();
  const part = (text: string, done = false) => ({ ...reply('a20', done), text });
  voice.observe([part('Yes. ')]); await tick(); assert.deepEqual(spoken, []);
  voice.observe([part('Yes. I can check that for you. Next')]); await tick();
  assert.deepEqual(spoken, ['Yes. I can check that for you.']);
  voice.observe([part('Yes. I can check that for you. Next', true)]); await tick();
  assert.deepEqual(spoken, ['Yes. I can check that for you.', 'Next']); voice.stop();
});

test('response audio plays while the send acknowledgement is still pending', async () => {
  const accepted = deferred<void>();
  const { voice, spoken } = setup({ send: () => accepted.promise });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  voice.observe([reply('a20')]); await tick();
  assert.deepEqual(spoken, ['A spoken answer.']);
  accepted.resolve(); await tick(); voice.stop();
});

test('compaction is announced once and again when it ends, and the phase follows it', async () => {
  const phases: string[] = [];
  const { voice, spoken } = setup({ agentRunning: () => true, phase: phase => phases.push(phase) });
  voice.observe([reply('a10')]);
  voice.setCompacting(true);
  voice.setCompacting(true);
  await tick();
  assert.equal(spoken.length, 1);
  assert.match(spoken[0], /context/i);
  assert.equal(phases.at(-1), 'Compacting context');
  voice.setCompacting(false);
  await tick();
  assert.ok(spoken.some(text => text.includes('compaction is done')));
  assert.equal(phases.at(-1), 'Thinking');
  voice.stop();
});

test('the compaction notices are in the language the voice speaks, whatever language the page is in', async () => {
  const say = async (speechLanguage?: string) => {
    const { voice, spoken } = setup({ agentRunning: () => true, speechLanguage: () => speechLanguage });
    voice.setCompacting(true); await tick(); voice.speechStart(); await tick(); voice.setCompacting(false); await tick(); voice.stop();
    return spoken;
  };
  const german = await say('de');
  assert.equal(german.length, 3);
  assert.ok(german.every(text => /komprimier|kontext/i.test(text)), german.join(' | '));
  assert.ok((await say('en')).every(text => /compact/i.test(text)));
  // The same with the page in another language: the voice's is what counts.
  assert.equal(notice('done', 'en', 'de'), "Context compaction is done. I'm ready to continue.");
  assert.match(notice('done', 'de-AT', 'en')!, /Komprimierung/);
});

test('a voice in a language the notices have no wording for says nothing about compaction, and the phase still follows it', async () => {
  const phases: string[] = [];
  const { voice, spoken } = setup({ agentRunning: () => true, speechLanguage: () => 'fr', phase: phase => phases.push(phase) });
  voice.setCompacting(true); await tick(); voice.speechStart(); await tick();
  assert.equal(phases.at(-1), 'Compacting context');
  voice.setCompacting(false); await tick(); voice.setCompacting(true, false); await tick(); voice.setCompacting(false, false); await tick();
  assert.deepEqual(spoken, []);
  voice.stop();
  // Detected language: the voice speaks what it is given, so the page's wording is used where there is one.
  assert.match(notice('compacting', 'auto', 'de')!, /Kontext/);
  assert.match(notice('compacting', undefined, 'en')!, /context/);
  assert.equal(notice('compacting', 'auto', 'fr'), undefined);
});

test('compaction ends a filler that is playing', async () => {
  const { filler, log } = fillers();
  const { voice } = setup({ agentRunning: () => true, filler });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.deepEqual(log, ['filler:start']);
  voice.setCompacting(true);
  assert.deepEqual(log, ['filler:start', 'filler:cut']);
  await tick();
  voice.stop();
});

test('speech during compaction does not abort or send, even if compaction ends mid-utterance', async () => {
 let aborts=0, transcriptions=0;
 const {voice,spoken,sent}=setup({agentRunning:()=>true,abort:async()=>{aborts++},transcribe:async()=>{transcriptions++;return 'interrupt'}});
 voice.setCompacting(true); await tick();
 voice.speechStart(); voice.speechStart(); await tick();
 assert.equal(aborts,0);
 assert.equal(spoken.filter(text=>text.includes('Please wait')).length,1);
 voice.setCompacting(false); await tick();
 voice.speechEnd(new Float32Array(16000)); await tick();
 assert.equal(transcriptions,0); assert.equal(sent.length,0);
 assert.ok(spoken.some(text=>text.includes('compaction is done')));
 voice.stop();
});
test('failed compaction is not announced as completed', async () => {
 const {voice,spoken}=setup();voice.setCompacting(true);await tick();voice.setCompacting(false,false);await tick();
 assert.ok(spoken.some(text=>text.includes('stopped before')));
 assert.ok(!spoken.some(text=>text.includes('compaction is done')));voice.stop();
});


test('short sentences wait regardless of character length', async () => {
  const { voice, spoken } = setup();
  const part = (text: string, done = false) => ({ ...reply('a20', done), text });
  voice.observe([part('Absolutely extraordinary. ')]); await tick(); assert.deepEqual(spoken, []);
  voice.observe([part('Absolutely extraordinary. I am here. Next')]); await tick();
  assert.deepEqual(spoken, ['Absolutely extraordinary. I am here.']);
  voice.observe([part('Absolutely extraordinary. I am here. Next', true)]); await tick();
  assert.equal(spoken.at(-1), 'Next'); voice.stop();
});

test('speech cues do not count as words and three-word phrases join the next sentence', async () => {
  const { voice, spoken } = setup();
  const part = (text: string, done = false) => ({ ...reply('a20', done), text });
  voice.observe([part('(clears throat) Hello. ')]); await tick(); assert.deepEqual(spoken, []);
  voice.observe([part('(clears throat) Hello. I am here. Go to it. Next')]); await tick();
  assert.deepEqual(spoken, ['(clears throat) Hello. I am here.']);
  voice.observe([part('(clears throat) Hello. I am here. Go to it. Now we can continue. Next')]); await tick();
  assert.deepEqual(spoken, ['(clears throat) Hello. I am here.', 'Go to it. Now we can continue.']); voice.stop();
});

test('sequential baseline waits for the complete agent turn before synthesizing',async()=>{
 let running=true;const generated:string[]=[];
 const {voice}=setup({sequential:true,agentRunning:()=>running,synthesize:async text=>{generated.push(text);return async()=>{};}});
 voice.observe([reply('a20'),reply('a21',false)]);await tick();assert.equal(generated.length,0);
 voice.observe([reply('a20'),reply('a21')]);await tick();assert.equal(generated.length,0);
 running=false;voice.observe([reply('a20'),reply('a21')]);await tick();assert.equal(generated.length,2);voice.stop();
});

test('sentence comparison submits a completed sentence before the agent turn ends',async()=>{
 const generated:string[]=[];const {voice}=setup({sequential:true,sentenceChunks:true,agentRunning:()=>true,synthesize:async text=>{generated.push(text);return async()=>{};}});
 voice.observe([{...reply('a20',false),text:'Here is the first complete sentence. More'}]);await tick();
 assert.deepEqual(generated,['Here is the first complete sentence.']);voice.stop();
});
test('what is for the page is handled there and never sent', async () => {
  const handled: string[] = [];
  const { voice, sent, spoken } = setup({ transcribe: async () => 'say that again', command: text => { handled.push(text); return true; } });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.deepEqual(handled, ['say that again']);
  assert.deepEqual(sent, []);
  // Replies after it are spoken as before.
  voice.observe([reply('a10'), reply('a20')]); await tick();
  assert.equal(spoken.length, 1); voice.stop();
});
test('a page command heard over an interrupted reply keeps its remainder spoken', async () => {
  const handled: string[] = [];
  const { voice, sent, spoken } = setup({ agentRunning: () => true, transcribe: async () => 'say that again', command: text => { handled.push(text); return true; } });
  voice.speechStart();
  // The reply it cut off is held back while what is said may still be for the page.
  voice.observe([reply('a10'), reply('a20')]); await tick();
  voice.speechEnd(new Float32Array(16000)); await tick();
  assert.deepEqual(handled, ['say that again']);
  assert.deepEqual(sent, []);
  // What the interruption cut off is spoken after all, not dropped with it.
  assert.deepEqual(spoken, ['A spoken answer.']); voice.stop();
});
test('when steering, speaking mid-run adds to the run instead of stopping it', async () => {
  let aborted = 0, steering = true;
  const { voice, sent } = setup({ agentRunning: () => true, abort: async () => { aborted++; }, steering: () => steering });
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.equal(aborted, 0); assert.deepEqual(sent, ['hello']);
  steering = false;
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.equal(aborted, 1); voice.stop();
});
test('speech taken back before it ends is not sent, and replies carry on', async () => {
  const phases: string[] = [];
  const { voice, sent, spoken } = setup({ phase: phase => { phases.push(phase); } });
  voice.speechStart(); voice.speechCancel(); await tick();
  assert.deepEqual(sent, []);
  assert.equal(phases.at(-1), 'Listening');
  voice.observe([reply('a10'), reply('a20')]); await tick();
  assert.equal(spoken.length, 1); voice.stop();
});
test('a noise that transcribes to nothing leaves the run going and its reply spoken', async () => {
  let aborted = 0;
  const { voice, sent, spoken } = setup({ agentRunning: () => true, transcribe: async () => '', abort: async () => { aborted++; } });
  voice.observe([reply('a10'), reply('a20', false)]); await tick();
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick();
  assert.equal(aborted, 0); assert.deepEqual(sent, []);
  // What the agent says after the cough is heard.
  voice.observe([reply('a10'), reply('a20', false), reply('a30')]); await tick();
  assert.deepEqual(spoken, ['A spoken answer.']); voice.stop();
});
test('a run is stopped as soon as what is being said is plainly for the agent, and only once', async () => {
  let aborted = 0;
  const pending = deferred<string>();
  const { voice, sent } = setup({ agentRunning: () => aborted === 0, abort: async () => { aborted++; }, transcribe: () => pending.promise,
    couldBeCommand: partial => /^(say|say that)$/i.test(partial.trim()) });
  voice.speechStart();
  voice.heard('Say'); await tick();
  assert.equal(aborted, 0);
  voice.heard("Stop, don't"); await tick();
  assert.equal(aborted, 1);
  voice.heard("Stop, don't touch that file"); await tick();
  voice.speechEnd(new Float32Array(16000)); pending.resolve("Stop, don't touch that file."); await tick(); await tick();
  assert.equal(aborted, 1); assert.deepEqual(sent, ["Stop, don't touch that file."]); voice.stop();
});
test('what is heard mid-run does not stop it when steering or while it could still be for the page', async () => {
  let aborted = 0;
  const { voice } = setup({ agentRunning: () => true, abort: async () => { aborted++; }, steering: () => true });
  voice.speechStart(); voice.heard('Also check the tests'); await tick();
  assert.equal(aborted, 0); voice.stop();
});
test('a cough mid-reply cuts it off, then the cut-off sentence and what came meanwhile are spoken', async () => {
  const started: string[] = [];
  let release: (() => void) | undefined;
  const { voice } = setup({ agentRunning: () => true, transcribe: async () => '', speak: async (text, signal) => {
    started.push(text);
    await new Promise<void>(resolve => { release = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); });
  } });
  voice.observe([reply('a10'), { ...reply('a20', false), text: 'First sentence here now. Second sentence here now. ' }]); await tick();
  assert.deepEqual(started, ['First sentence here now.']);
  voice.speechStart(); await tick();
  voice.observe([reply('a10'), { ...reply('a20', false), text: 'First sentence here now. Second sentence here now. Third sentence here now. ' }]); await tick();
  assert.deepEqual(started, ['First sentence here now.']);
  voice.speechEnd(new Float32Array(16000)); await tick(); await tick();
  for (let i = 0; i < 3; i++) { release?.(); await tick(); await tick(); }
  assert.deepEqual(started, ['First sentence here now.', 'First sentence here now.', 'Second sentence here now.', 'Third sentence here now.']);
  voice.stop();
});
test('a push-to-talk press taken back does not lose the reply it cut off', async () => {
  const started: string[] = [];
  const { voice } = setup({ agentRunning: () => true, speak: async (text, signal) => {
    started.push(text); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  } });
  voice.observe([reply('a10'), reply('a20')]); await tick();
  voice.speechStart(); voice.speechCancel(); await tick(); await tick();
  assert.deepEqual(started, ['A spoken answer.', 'A spoken answer.']); voice.stop();
});
test('what is sent drops the reply it cut off', async () => {
  const { voice, spoken, sent } = setup();
  voice.speechStart();
  voice.observe([reply('a10'), reply('a20')]); await tick();
  voice.speechEnd(new Float32Array(16000)); await tick(); await tick();
  assert.deepEqual(sent, ['hello']); assert.deepEqual(spoken, []); voice.stop();
});
test('a stop that failed while speaking is tried again before what was said is sent', async () => {
  const calls: string[] = []; const firstAbort = deferred<void>();
  const { voice, sent } = setup({ agentRunning: () => true, send: async text => { calls.push('send'); sent.push(text); },
    abort: async () => { calls.push('abort'); if (calls.filter(c => c === 'abort').length === 1) { await firstAbort.promise; throw new Error('offline'); } } });
  voice.speechStart(); voice.heard('stop'); await tick();
  voice.speechEnd(new Float32Array(16000)); await tick();
  assert.deepEqual(calls, ['abort']);
  firstAbort.resolve(); await tick(); await tick(); await tick();
  assert.deepEqual(calls, ['abort', 'abort', 'send']); assert.deepEqual(sent, ['hello']); voice.stop();
});

// Fillers: a short sound the moment a turn is taken, until the answer starts.
const turn = (voice: HandsFreeVoice) => { voice.speechStart(); voice.speechEnd(new Float32Array(16000)); };

test('a filler plays the moment the turn is taken, while the agent has not yet answered the send', async () => {
  const { filler, log } = fillers(); const accepted = deferred<void>();
  const { voice, sent } = setup({ filler, send: () => accepted.promise });
  turn(voice); await tick();
  // No timer in between: not after seconds of silence, but with the send still open.
  assert.deepEqual(log, ['filler:start']); assert.deepEqual(sent, []);
  accepted.resolve(); await tick(); voice.stop();
});

test('a filler waits for what was said to be known, and then comes with nothing in front of it', async () => {
  const { filler, log } = fillers(); const transcript = deferred<string>();
  const { voice } = setup({ filler, transcribe: () => transcript.promise });
  turn(voice); await tick();
  assert.deepEqual(log, []);
  transcript.resolve('hello'); await tick();
  assert.deepEqual(log, ['filler:start']); voice.stop();
});

test('no filler for a noise that is no words, for what is for the page, or for a send that is refused', async () => {
  const noise = fillers();
  const a = setup({ filler: noise.filler, transcribe: async () => '' });
  turn(a.voice); await tick(); a.voice.stop();
  const page = fillers();
  const b = setup({ filler: page.filler, command: () => true });
  turn(b.voice); await tick(); b.voice.stop();
  const refused = fillers();
  const c = setup({ filler: refused.filler, send: async () => { throw new Error('offline'); } });
  turn(c.voice); await tick();
  assert.deepEqual([noise.log, page.log], [[], []]);
  // Started with the send, and cut when it failed: the turn did not happen.
  assert.deepEqual(refused.log, ['filler:start', 'filler:cut']); c.voice.stop();
});

test('a turn said again after a send that was refused has its filler', async () => {
  const { filler, log } = fillers(); let calls = 0; const errors: string[] = [];
  const { voice, sent } = setup({ filler, error: message => errors.push(message), send: async text => { if (!calls++) throw new Error('offline'); sent.push(text); } });
  turn(voice); await tick();
  assert.deepEqual(log, ['filler:start', 'filler:cut']); assert.equal(errors.length, 1);
  // The user says it again: that turn is the one that happens, and the silence before its answer is filled.
  turn(voice); await tick();
  assert.deepEqual(log, ['filler:start', 'filler:cut', 'filler:start']);
  voice.stop();
});

test('a turn that interrupts a running agent has its filler at once, not when the run it stops has wound down', async () => {
  const { filler, log } = fillers(); const stopped = deferred<void>();
  const { voice, sent } = setup({ filler, agentRunning: () => true, abort: () => { log.push('abort:asked'); return stopped.promise; } });
  turn(voice); await tick();
  // The stop is still pending, as with a tool that is slow to give way: the silence is covered all the same.
  assert.deepEqual(log, ['filler:start', 'abort:asked']); assert.deepEqual(sent, []);
  stopped.resolve(); await tick();
  assert.deepEqual(sent, ['hello']); assert.deepEqual(log, ['filler:start', 'abort:asked']);
  voice.stop();
});

test('the filler of an interrupting turn is cut, and the next turn may have one, when the stop fails or the speaker goes on', async () => {
  const failing = fillers(); const errors: string[] = [];
  const a = setup({ filler: failing.filler, agentRunning: () => true, abort: async () => { throw new Error('stuck'); }, error: message => errors.push(message) });
  turn(a.voice); await tick();
  assert.deepEqual(failing.log, ['filler:start', 'filler:cut']); assert.equal(errors.length, 1);
  turn(a.voice); await tick();
  assert.deepEqual(failing.log, ['filler:start', 'filler:cut', 'filler:start', 'filler:cut']);
  a.voice.stop();
  // Talking on while the stop is pending: the filler is cut as it is for any speech.
  const going = fillers(); const stopped = deferred<void>();
  const b = setup({ filler: going.filler, agentRunning: () => true, abort: () => stopped.promise });
  turn(b.voice); await tick();
  b.voice.speechStart(); await tick();
  assert.deepEqual(going.log, ['filler:start', 'filler:cut']);
  stopped.resolve(); await tick();
  assert.deepEqual(b.sent, []);
  b.voice.stop();
});

test('a filler yields to the answer: it is cut before the answer is heard, and the two never play together', async () => {
  const { filler, log } = fillers();
  const { voice } = setup({ filler, speak: async text => { log.push('answer:' + text); } });
  turn(voice); await tick();
  voice.observe([reply('a20')]); await tick();
  assert.deepEqual(log, ['filler:start', 'filler:cut', 'answer:A spoken answer.']); voice.stop();
});

test('a filler plays on while the answer is made, and yields when the answer can be heard, not when its text arrives', async () => {
  const { filler, log } = fillers(); const made = deferred<void>();
  const { voice } = setup({ filler, synthesize: async () => { await made.promise; return async () => { log.push('answer'); }; } });
  turn(voice); await tick();
  voice.observe([reply('a20')]); await tick();
  assert.deepEqual(log, ['filler:start']);
  made.resolve(); await tick();
  assert.deepEqual(log, ['filler:start', 'filler:cut', 'answer']); voice.stop();
});

test('a filler whose player does not answer is not waited for', async () => {
  const log: string[] = [];
  const { voice } = setup({ filler: () => new Promise<void>(() => {}), speak: async () => { log.push('answer'); } });
  turn(voice); await tick();
  voice.observe([reply('a20')]); await tick();
  assert.deepEqual(log, []);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(log, ['answer']); voice.stop();
});

test('talking over a filler cuts it at once, and the turn that follows does not get one at the same moment', async () => {
  const { filler, log } = fillers();
  const { voice } = setup({ filler });
  turn(voice); await tick();
  voice.speechStart();
  assert.deepEqual(log, ['filler:start', 'filler:cut']);
  voice.speechEnd(new Float32Array(16000)); await tick();
  // The last thing heard was a filler: the next turn's first comes after a gap, not on top of it.
  assert.deepEqual(log, ['filler:start', 'filler:cut']); voice.stop();
});

test('the first filler of a turn that follows another is not at once, and is again once an answer has been heard', async () => {
  const { filler, log } = fillers(); const spoken: string[] = [];
  const { voice } = setup({ filler, speak: async text => { spoken.push(text); } });
  turn(voice); await tick();
  turn(voice); await tick();
  assert.equal(log.filter(entry => entry === 'filler:start').length, 1);
  voice.observe([reply('a20')]); await tick();
  assert.deepEqual(spoken, ['A spoken answer.']);
  turn(voice); await tick();
  assert.equal(log.filter(entry => entry === 'filler:start').length, 2); voice.stop();
});

test('there is no spoken "let me think" line any more, in any words: what fills a long silence is fillers', async () => {
  const { filler } = fillers();
  const { voice, spoken } = setup({ filler, agentRunning: () => true });
  turn(voice); await tick();
  voice.observe([reply('a10')]); await tick();
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.deepEqual(spoken, []); voice.stop();
});

test('with status speech off, or in the sequential baseline, there are no fillers', async () => {
  for (const patch of [{ statusSpeech: false }, { sequential: true }]) {
    const { filler, log } = fillers();
    const { voice, sent } = setup({ filler, ...patch });
    turn(voice); await tick();
    assert.deepEqual(sent, ['hello']); assert.deepEqual(log, [], JSON.stringify(patch)); voice.stop();
  }
});

test('nothing to play is not an error, and the next turn tries again; a filler that fails is not reported', async () => {
  let ready = false, asked = 0;
  const { voice, errors } = setup({ filler: () => { asked++; return ready ? Promise.reject(new Error('no audio')) : undefined; } });
  turn(voice); await tick();
  ready = true;
  turn(voice); await tick(); await tick();
  assert.equal(asked, 2); assert.deepEqual(errors, []); voice.stop();
});

test('ending voice cuts a filler, and the phase says speaking only while it plays', async () => {
  const { filler, log } = fillers(); const phases: string[] = [];
  const { voice } = setup({ filler, phase: phase => phases.push(phase), agentRunning: () => true });
  turn(voice); await tick();
  assert.equal(phases.at(-1), 'Speaking');
  voice.stop();
  assert.deepEqual(log, ['filler:start', 'filler:cut']);
});

// A long wait: the silence is filled again and again, on a clock that only moves when told to.
const pacing: FillerPacing = { first: 0, every: 1, randomness: 0, max: 4 };
/** Fillers that play for `length` ms of that clock, and what happened to them when. */
function timeline(t: TestContext, length = 500) {
  t.mock.timers.reset(); t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const log: { at: number; e: string }[] = []; const waits: object[] = []; let now = 0;
  const filler = (signal: AbortSignal, wait: object) => {
    log.push({ at: now, e: 'start' }); waits.push(wait);
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => { log.push({ at: now, e: 'end' }); resolve(); }, length);
      signal.addEventListener('abort', () => { clearTimeout(timer); log.push({ at: now, e: 'cut' }); resolve(); }, { once: true });
    });
  };
  const advance = async (ms: number) => { for (let done = 0; done < ms; done += 100) { now += 100; t.mock.timers.tick(100); await tick(); await tick(); } };
  const starts = () => log.filter(entry => entry.e === 'start').map(entry => entry.at);
  return { filler, log, waits, advance, starts };
}

test('a long wait is filled again and again, the set gap after each filler has ended, and no more after the most', async t => {
  const { filler, advance, starts } = timeline(t);
  const { voice } = setup({ filler, agentRunning: () => true, fillerPacing: pacing });
  turn(voice); await tick();
  await advance(60_000);
  // Each filler lasts 500 ms, and the gap after it is the one second that was set; four are the most.
  assert.deepEqual(starts(), [0, 1500, 3000, 4500]);
  voice.stop();
});

test('the fillers of a long wait stop when the answer is heard, whether one is playing or the wait is between two', async t => {
  // Heard while one is playing: it is cut, and no more come.
  const playing = timeline(t, 5000);
  const a = setup({ filler: playing.filler, agentRunning: () => true, fillerPacing: pacing });
  turn(a.voice); await tick();
  await playing.advance(1000);
  a.voice.observe([reply('a20')]); await tick(); await tick();
  assert.deepEqual(playing.log.map(entry => entry.e), ['start', 'cut']);
  assert.deepEqual(a.spoken, ['A spoken answer.']);
  await playing.advance(60_000);
  assert.deepEqual(playing.starts(), [0]);
  a.voice.stop();
  // Heard in the gap after the first: the second never comes.
  const gap = timeline(t, 500);
  const b = setup({ filler: gap.filler, agentRunning: () => true, fillerPacing: pacing });
  turn(b.voice); await tick();
  await gap.advance(800);
  b.voice.observe([reply('a20')]); await tick(); await tick();
  await gap.advance(60_000);
  assert.deepEqual(gap.starts(), [0]);
  assert.deepEqual(b.spoken, ['A spoken answer.']);
  b.voice.stop();
});

test('the answer is never heard over a filler of a long wait: it starts once the one playing has been cut', async t => {
  const { filler, log, advance } = timeline(t, 5000);
  const events: string[] = [];
  const { voice } = setup({ filler, agentRunning: () => true, fillerPacing: pacing, speak: async () => { events.push(`answer after ${log.map(entry => entry.e).join(',')}`); } });
  turn(voice); await tick();
  await advance(1000);
  voice.observe([reply('a20')]); await tick(); await tick();
  assert.deepEqual(events, ['answer after start,cut']);
  voice.stop();
});

test('speech, compaction, an agent that has finished, or the end of voice mode stop the fillers of a wait', async t => {
  for (const [name, end] of [
    ['speech', (voice: HandsFreeVoice) => voice.speechStart()],
    ['compaction', (voice: HandsFreeVoice) => voice.setCompacting(true)],
    ['stop', (voice: HandsFreeVoice) => voice.stop()],
  ] as const) {
    const line = timeline(t, 300);
    let running = true;
    const { voice } = setup({ filler: line.filler, agentRunning: () => running, fillerPacing: pacing });
    turn(voice); await tick();
    await line.advance(1500);
    assert.deepEqual(line.starts(), [0, 1300], name);
    end(voice); await tick();
    await line.advance(60_000);
    assert.deepEqual(line.starts(), [0, 1300], name);
    voice.stop();
  }
  // An agent that has finished without a word has nothing left to wait for.
  const line = timeline(t, 300); let running = true;
  const { voice } = setup({ filler: line.filler, agentRunning: () => running, fillerPacing: pacing });
  turn(voice); await tick();
  await line.advance(1500);
  running = false;
  await line.advance(60_000);
  assert.deepEqual(line.starts(), [0, 1300]);
  voice.stop();
});

test('a wait where no clip is ready yet tries again after a gap, and the tries count towards the most', async t => {
  t.mock.timers.reset(); t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let now = 0, asked: number[] = [];
  const advance = async (ms: number) => { for (let done = 0; done < ms; done += 100) { now += 100; t.mock.timers.tick(100); await tick(); await tick(); } };
  const { voice, errors } = setup({ agentRunning: () => true, fillerPacing: pacing, filler: () => { asked.push(now); return undefined; } });
  turn(voice); await tick();
  await advance(60_000);
  assert.deepEqual(asked, [0, 1000, 2000, 3000]); assert.deepEqual(errors, []);
  voice.stop();
});

test('the gap is what was set and nothing else: exactly so without randomness, spread evenly around it with', async t => {
  // Without randomness the random numbers do not matter.
  for (const random of [0, 0.3, 0.999]) {
    t.mock.method(Math, 'random', () => random);
    const { filler, advance, starts } = timeline(t, 100);
    const { voice } = setup({ filler, agentRunning: () => true, fillerPacing: { first: 0, every: 2.5, randomness: 0, max: 3 } });
    turn(voice); await tick();
    await advance(20_000);
    assert.deepEqual(starts(), [0, 2600, 5200], `random ${random}`);
    voice.stop(); t.mock.restoreAll();
  }
  // With it the gap strays by that fraction of the base to either side: the shortest and the longest.
  for (const [random, gap] of [[0, 1500], [0.5, 3000], [1, 4500]] as const) {
    t.mock.method(Math, 'random', () => random);
    const { filler, advance, starts } = timeline(t, 100);
    const { voice } = setup({ filler, agentRunning: () => true, fillerPacing: { first: 0, every: 3, randomness: 0.5, max: 2 } });
    turn(voice); await tick();
    await advance(10_000);
    assert.deepEqual(starts(), [0, 100 + gap], `random ${random}`);
    voice.stop(); t.mock.restoreAll();
  }
});

test('the gap has a floor, and the pacing it ships with is today\'s first filler at once and a long wait filled, then no more', async t => {
  assert.equal(fillerGap({ first: 0, every: 1, randomness: 1, max: 4 }, 0), FILLER_LIMITS.every.min);
  // A spread that would go under the floor is narrowed to end on it, not piled up there: 1 to 7 around 4, not 0 to 8.
  assert.equal(fillerGap({ first: 0, every: 4, randomness: 1, max: 4 }, 0), 1);
  assert.equal(fillerGap({ first: 0, every: 4, randomness: 1, max: 4 }, 1), 7);
  assert.equal(FILLER_PACING.first, 0, 'at once, as it always was');
  assert.ok(FILLER_PACING.max >= 6, 'at least as many as the growing gaps had');
  t.mock.method(Math, 'random', () => 0.5);
  const { filler, advance, starts } = timeline(t, 1500);
  const { voice } = setup({ filler, agentRunning: () => true });
  turn(voice); await tick();
  await advance(300_000);
  const at = starts();
  assert.equal(at.length, FILLER_PACING.max);
  assert.deepEqual(at.slice(1).map((time, i) => time - at[i]), at.slice(1).map(() => 1500 + FILLER_PACING.every * 1000));
  // About as long a wait as before (three quarters of a minute), and not much less.
  assert.ok(at.at(-1)! >= 30_000, `the last at ${at.at(-1)}`);
  voice.stop();
});

test('a time to the first filler holds it back, and an answer that comes first leaves none', async t => {
  const delayed = timeline(t, 300);
  const a = setup({ filler: delayed.filler, agentRunning: () => true, fillerPacing: { first: 2, every: 1, randomness: 0, max: 3 } });
  turn(a.voice); await tick();
  await delayed.advance(1900);
  assert.deepEqual(delayed.starts(), []);
  await delayed.advance(10_000);
  // Then the gaps as they are set.
  assert.deepEqual(delayed.starts(), [2000, 3300, 4600]);
  a.voice.stop();
  const answered = timeline(t, 300);
  const b = setup({ filler: answered.filler, agentRunning: () => true, fillerPacing: { first: 2, every: 1, randomness: 0, max: 3 }, speak: async () => {} });
  turn(b.voice); await tick();
  await answered.advance(1000);
  b.voice.observe([reply('a20')]); await tick(); await tick();
  assert.deepEqual(b.spoken, []);
  await answered.advance(60_000);
  assert.deepEqual(answered.starts(), []);
  b.voice.stop();
});

test('after a filler that nothing followed the next first filler waits what is left of a gap since it ended, or the time to the first if that is longer', async t => {
  const line = timeline(t, 300);
  const { voice } = setup({ filler: line.filler, agentRunning: () => true, fillerPacing: { first: 0.5, every: 2, randomness: 0, max: 5 } });
  turn(voice); await tick();
  await line.advance(300);
  assert.deepEqual(line.starts(), []);
  await line.advance(300);
  assert.deepEqual(line.starts(), [500]);
  await line.advance(1000);
  // The second turn, with the one before the last thing heard: it ended at 800, so the gap is over at 2800, and that is later than the half second.
  turn(voice); await tick();
  await line.advance(1100);
  assert.deepEqual(line.starts(), [500]);
  await line.advance(200);
  assert.deepEqual(line.starts(), [500, 2800]);
  voice.stop();
});

test('a turn more than a gap after the last filler has its first filler at once, or after the time set for it: the delay is for fillers on top of each other', async t => {
  // A wait filled up to the most, the agent going on in silence, and the user interrupting it much later.
  for (const [every, first, later] of [[1, 0, 10_000], [30, 0, 40_000], [1, 2, 10_000]] as const) {
    const line = timeline(t, 300);
    const pacing: FillerPacing = { first: 0, every, randomness: 0, max: 1 };
    const { voice } = setup({ filler: line.filler, agentRunning: () => true, fillerPacing: pacing });
    turn(voice); await tick();
    await line.advance(later);
    assert.deepEqual(line.starts(), [0], `every ${every}`);
    pacing.first = first;
    turn(voice); await tick();
    await line.advance(first * 1000 + 100);
    assert.deepEqual(line.starts(), [0, later + first * 1000], `every ${every}, first ${first}`);
    voice.stop();
  }
});

test('a setting changed while a gap is pending applies to it, counting what has passed, and a most that has been reached ends the wait', async t => {
  const start = (pacing: FillerPacing) => {
    const line = timeline(t, 300);
    const { voice } = setup({ filler: line.filler, agentRunning: () => true, fillerPacing: pacing });
    turn(voice); return { line, voice };
  };
  // Quicker: 3 seconds instead of 30, at 2 s, with the first filler having ended at 0.3 s.
  let pacing: FillerPacing = { first: 0, every: 30, randomness: 0, max: 8 };
  let run = start(pacing); await tick();
  await run.line.advance(2000);
  pacing.every = 3; run.voice.pacingChanged();
  await run.line.advance(1100);
  assert.deepEqual(run.line.starts(), [0]);
  await run.line.advance(300);
  assert.deepEqual(run.line.starts(), [0, 3300]);
  run.voice.stop();
  // Slower: the filler that was due is not.
  pacing = { first: 0, every: 3, randomness: 0, max: 8 };
  run = start(pacing); await tick();
  await run.line.advance(2000);
  pacing.every = 30; run.voice.pacingChanged();
  await run.line.advance(20_000);
  assert.deepEqual(run.line.starts(), [0]);
  await run.line.advance(10_000);
  assert.deepEqual(run.line.starts(), [0, 30_300]);
  run.voice.stop();
  // The time to the first filler, before it has played.
  pacing = { first: 10, every: 3, randomness: 0, max: 8 };
  run = start(pacing); await tick();
  await run.line.advance(1000);
  pacing.first = 2; run.voice.pacingChanged();
  await run.line.advance(900);
  assert.deepEqual(run.line.starts(), []);
  await run.line.advance(200);
  assert.deepEqual(run.line.starts(), [2000]);
  run.voice.stop();
  // A lower most than the fillers there have been: no more, whether or not the voice was told.
  for (const told of [true, false]) {
    pacing = { first: 0, every: 1, randomness: 0, max: 8 };
    run = start(pacing); await tick();
    await run.line.advance(3500);
    assert.deepEqual(run.line.starts(), [0, 1300, 2600]);
    pacing.max = 3; if (told) run.voice.pacingChanged();
    await run.line.advance(60_000);
    assert.deepEqual(run.line.starts(), [0, 1300, 2600], `told ${told}`);
    run.voice.stop();
  }
});

test('a spread that would go under the shortest gap is narrowed to end there: even, centred on the time set, and none at the shortest', () => {
  const draws = (every: number, randomness: number) => Array.from({ length: 1001 }, (_, i) => fillerGap({ first: 0, every, randomness, max: 4 }, i / 1000));
  for (const [every, randomness] of [[1.5, 1], [2, 1], [2, 0.5], [5, 1], [3, 0.5], [30, 1]] as const) {
    const gaps = draws(every, randomness);
    const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    assert.ok(Math.abs(mean - every) < every * 0.002, `${every} s at ${randomness}: mean ${mean}`);
    assert.ok(Math.min(...gaps) >= 1 - 1e-9, `${every} s at ${randomness}: shortest ${Math.min(...gaps)}`);
    // Not piled up on the shortest: at most the one draw that reaches it.
    assert.ok(gaps.filter(gap => gap < 1 + 1e-9).length <= 1, `${every} s at ${randomness}`);
  }
  // At the shortest time there is nothing under it to spread into, and it is not lengthened either.
  assert.ok(draws(1, 1).every(gap => gap === 1));
});

test('what is set applies to the next gap, also in the middle of a call, and anything that is not a number or is out of range is made one', async t => {
  const line = timeline(t, 300);
  const current: FillerPacing = { first: 0, every: 1, randomness: 0, max: 5 };
  const { voice } = setup({ filler: line.filler, agentRunning: () => true, fillerPacing: current });
  turn(voice); await tick();
  // Slowed down while the first filler is playing: its gap is the new one.
  await line.advance(100);
  current.every = 3;
  await line.advance(10_000);
  assert.deepEqual(line.starts().slice(0, 3), [0, 3300, 6600]);
  voice.stop();
  assert.deepEqual(fillerPacing({}), FILLER_PACING);
  assert.deepEqual(fillerPacing({ first: 'abc', every: null, randomness: undefined, max: NaN }), FILLER_PACING);
  assert.deepEqual(fillerPacing({ first: '', every: '  ', randomness: [], max: true }), FILLER_PACING);
  assert.deepEqual(fillerPacing({ first: {}, every: '', randomness: '\t', max: false }), FILLER_PACING);
  assert.deepEqual(fillerPacing({ first: -5, every: 0, randomness: -1, max: 0 }), { first: 0, every: 1, randomness: 0, max: 1 });
  assert.deepEqual(fillerPacing({ first: 1e9, every: 1e9, randomness: 7, max: 1e9 }), { first: 10, every: 30, randomness: 1, max: 20 });
  assert.deepEqual(fillerPacing({ first: '2.2', every: '4.3', randomness: '0.33', max: '5.6' }), { first: 2, every: 4.5, randomness: 0.35, max: 6 });
  assert.deepEqual(fillerPacing({ first: Infinity, every: -Infinity }), FILLER_PACING);
});

test('after a filler that nothing followed the next turn waits what is left of a gap for its own, and after an answer it does not', async t => {
  const first = timeline(t, 300);
  const a = setup({ filler: first.filler, agentRunning: () => true, fillerPacing: pacing });
  turn(a.voice); await tick();
  await first.advance(500);
  turn(a.voice); await tick();
  await first.advance(700);
  // Not at once, as the one before was the last thing heard: it ended at 300, and the gap is over at 1300.
  assert.deepEqual(first.starts(), [0]);
  await first.advance(200);
  assert.deepEqual(first.starts(), [0, 1300]);
  a.voice.stop();
  const second = timeline(t, 300);
  const b = setup({ filler: second.filler, agentRunning: () => true, fillerPacing: pacing });
  turn(b.voice); await tick();
  await second.advance(500);
  b.voice.observe([reply('a20')]); await tick(); await tick();
  assert.deepEqual(b.spoken, ['A spoken answer.']);
  turn(b.voice); await tick();
  assert.deepEqual(second.starts(), [0, 500]);
  b.voice.stop();
});

test('an answer that is being made into speech does not end the fillers: they go on until it is audible', async t => {
  const line = timeline(t, 300); const gate = deferred<void>(); const spoken: string[] = [];
  const { voice } = setup({ filler: line.filler, agentRunning: () => true, fillerPacing: pacing, synthesize: async text => { await gate.promise; return async () => { spoken.push(text); }; } });
  turn(voice); await tick();
  // The text of the answer is there, its audio is not: a long first sentence, or a speech runtime that is busy.
  voice.observe([reply('a20')]); await tick();
  await line.advance(2700);
  assert.deepEqual(line.starts(), [0, 1300, 2600]);
  gate.resolve(); await tick(); await tick();
  assert.deepEqual(spoken, ['A spoken answer.']);
  assert.equal(line.log.at(-1)?.e, 'cut');
  await line.advance(60_000);
  assert.deepEqual(line.starts(), [0, 1300, 2600]);
  voice.stop();
});

test('an answer that is still being made into speech is waited for after the agent has finished, and the fillers go on until it is audible', async t => {
  const line = timeline(t, 300); const gate = deferred<void>(); const spoken: string[] = [];
  let running = true;
  const { voice } = setup({ filler: line.filler, agentRunning: () => running, fillerPacing: pacing, synthesize: async text => { await gate.promise; return async () => { spoken.push(text); }; } });
  turn(voice); await tick();
  // A short answer: written in a moment, the run is over, and its first sentence takes the speech runtime seconds.
  voice.observe([reply('a20')]); running = false; await tick();
  await line.advance(2700);
  assert.deepEqual(line.starts(), [0, 1300, 2600]);
  gate.resolve(); await tick(); await tick();
  assert.deepEqual(spoken, ['A spoken answer.']);
  await line.advance(60_000);
  assert.deepEqual(line.starts(), [0, 1300, 2600]);
  voice.stop();
});

test('speech in a gap ends the wait for good, also once the transcript is being made and nobody is speaking any more', async t => {
  const line = timeline(t, 300); const transcript = deferred<string>(); let calls = 0;
  const { voice } = setup({ filler: line.filler, agentRunning: () => true, fillerPacing: pacing, transcribe: () => calls++ ? transcript.promise : Promise.resolve('hello') });
  turn(voice); await tick();
  await line.advance(500);
  // Said in the gap after the first filler, and over; the transcript is on its way and the next filler of that wait is not due yet.
  turn(voice); await tick();
  await line.advance(5000);
  assert.deepEqual(line.starts(), [0]);
  // What was said is the next turn, and its silence is filled on its own clock: the last filler ended long ago, so at once.
  transcript.resolve('hello again'); await tick(); await tick();
  await line.advance(200);
  assert.deepEqual(line.starts(), [0, 5500]);
  voice.stop();
});

test('a compaction in a gap ends the wait, even where nothing is said about it', async t => {
  const line = timeline(t, 300);
  // No wording in French: the compaction is silent, and the fillers must not come back after it.
  const { voice } = setup({ filler: line.filler, agentRunning: () => true, fillerPacing: pacing, speechLanguage: () => 'fr' });
  turn(voice); await tick();
  await line.advance(500);
  voice.setCompacting(true); await line.advance(200); voice.setCompacting(false);
  await line.advance(60_000);
  assert.deepEqual(line.starts(), [0]);
  voice.stop();
});

test('a turn whose stop of the running agent fails has no fillers after the first filler has ended either', async t => {
  const line = timeline(t, 300); let stops = 0;
  const { voice, sent, errors } = setup({ filler: line.filler, agentRunning: () => true, fillerPacing: pacing, abort: async () => { if (stops++) throw new Error('stuck'); } });
  turn(voice); await tick();
  await line.advance(500);
  // The turn says again while the agent is working, and the stop fails: that turn is not sent, and no filler is made for it.
  turn(voice); await tick(); await tick();
  assert.equal(errors.length, 1); assert.deepEqual(sent, ['hello']);
  await line.advance(60_000);
  assert.deepEqual(line.starts(), [0]);
  voice.stop();
});

test('one wait is told apart from the next, so that the clips of a wait can differ', async t => {
  const line = timeline(t, 300);
  const { voice } = setup({ filler: line.filler, agentRunning: () => true, fillerPacing: pacing, speak: async () => {} });
  turn(voice); await tick();
  await line.advance(5000);
  voice.observe([reply('a20')]); await tick(); await tick();
  turn(voice); await tick();
  await line.advance(500);
  const [first, second, third, fourth, next] = line.waits;
  assert.ok(first === second && second === third && third === fourth, 'the fillers of one wait are for the same one');
  assert.ok(next && next !== fourth, 'the next turn is another wait');
  voice.stop();
});

/** Random numbers that come as told, then `rest`. */
const draws = (t: TestContext, values: number[], rest = 0.5) => t.mock.method(Math, 'random', () => values.length ? values.shift()! : rest);

test('a gap is drawn once: a change to the most or to the first-filler time leaves it where it was, and a longer time does not bring it earlier', async t => {
  // A gap of 30 s at full randomness, drawn at 0.9: 53.2 s. A later draw would be a short one.
  draws(t, [0.5, 0.9], 0.1);
  const line = timeline(t, 300);
  const pacing: FillerPacing = { first: 0, every: 30, randomness: 1, max: 8 };
  const a = setup({ filler: line.filler, agentRunning: () => true, fillerPacing: pacing });
  turn(a.voice); await tick();
  await line.advance(10_000);
  pacing.max = 9; pacing.first = 3; a.voice.pacingChanged();
  await line.advance(40_000);
  assert.deepEqual(line.starts(), [0]);
  await line.advance(4000);
  assert.deepEqual(line.starts(), [0, 53_500]);
  a.voice.stop(); t.mock.restoreAll();
  // 5 s at full randomness, drawn at 0.5: 5 s. Raised to 10 s at 3 s: the filler is due at the new time, counting what has passed.
  draws(t, [0.5, 0.5], 0.1);
  const slower = timeline(t, 300);
  const slow: FillerPacing = { first: 0, every: 5, randomness: 1, max: 8 };
  const b = setup({ filler: slower.filler, agentRunning: () => true, fillerPacing: slow });
  turn(b.voice); await tick();
  await slower.advance(3000);
  slow.every = 10; b.voice.pacingChanged();
  await slower.advance(7000);
  assert.deepEqual(slower.starts(), [0]);
  await slower.advance(500);
  assert.deepEqual(slower.starts(), [0, 10_300]);
  b.voice.stop();
});

test('the first filler after a recent one is decided and waited by one draw, not two', async t => {
  // 1 to 9 s around 5; drawn at 0.9 it is 8.2 s, of which 3 s have gone since the last filler ended.
  draws(t, [0.5, 0.9], 0.1);
  const line = timeline(t, 300);
  const { voice } = setup({ filler: line.filler, agentRunning: () => true, fillerPacing: { first: 0, every: 5, randomness: 1, max: 1 } });
  turn(voice); await tick();
  await line.advance(3300);
  turn(voice); await tick();
  await line.advance(5000);
  assert.deepEqual(line.starts(), [0]);
  await line.advance(400);
  assert.deepEqual(line.starts(), [0, 8500]);
  voice.stop();
});

test('a setting changed while a filler plays moves nothing and ends nothing: the wait goes on', async t => {
  const line = timeline(t, 1000);
  const pacing: FillerPacing = { first: 0, every: 1, randomness: 0, max: 8 };
  const { voice } = setup({ filler: line.filler, agentRunning: () => true, fillerPacing: pacing });
  turn(voice); await tick();
  await line.advance(2500);
  // The second filler (2000 to 3000) is playing, and the gap before it has fired: slowed to two seconds.
  assert.deepEqual(line.starts(), [0, 2000]);
  pacing.every = 2; voice.pacingChanged();
  await line.advance(10_000);
  assert.deepEqual(line.starts().slice(0, 4), [0, 2000, 5000, 8000]);
  voice.stop();
});

test('speech that was no turn does not end a long wait: a noise, a press taken back or a page command, and the fillers go on after a gap', async t => {
  const waits: [string, (voice: HandsFreeVoice) => void | Promise<void>, Partial<VoiceIO>][] = [
    ['noise', voice => { voice.speechStart(); voice.speechEnd(new Float32Array(16000)); }, { transcribe: () => Promise.resolve('') }],
    ['press taken back', voice => { voice.speechStart(); voice.speechCancel(); }, {}],
    ['page command', voice => { voice.speechStart(); voice.speechEnd(new Float32Array(16000)); }, { transcribe: () => Promise.resolve('say that again'), command: text => text === 'say that again' }],
  ];
  for (const [name, speak, patch] of waits) {
    const line = timeline(t, 300); let calls = 0;
    const pacing: FillerPacing = { first: 0, every: 2, randomness: 0, max: 4 };
    const { voice } = setup({ filler: line.filler, agentRunning: () => true, fillerPacing: pacing, ...patch, transcribe: (...args) => calls++ ? (patch.transcribe ?? (async () => 'hello'))(...args) : Promise.resolve('hello') });
    turn(voice); await tick();
    await line.advance(3000);
    assert.deepEqual(line.starts(), [0, 2300], name);
    // The sound at 3 s, and then the wait goes on: a gap after it, not at once.
    speak(voice); await tick(); await tick();
    await line.advance(1800);
    assert.deepEqual(line.starts(), [0, 2300], name);
    await line.advance(300);
    assert.deepEqual(line.starts(), [0, 2300, 5000], name);
    // The tries before it count: four at most over the whole wait.
    await line.advance(60_000);
    assert.equal(line.starts().length, 4, name);
    voice.stop();
  }
});

test('a wait is not resumed after speech where there is nothing to wait for, where the speech was a turn, or once the answer is audible', async t => {
  // The agent has finished.
  let running = true;
  const a = timeline(t, 300);
  let calls = 0;
  const one = setup({ filler: a.filler, agentRunning: () => running, fillerPacing: { first: 0, every: 2, randomness: 0, max: 5 }, transcribe: () => calls++ ? Promise.resolve('') : Promise.resolve('hello') });
  turn(one.voice); await tick();
  await a.advance(1000);
  running = false;
  turn(one.voice); await tick(); await tick();
  await a.advance(60_000);
  assert.deepEqual(a.starts(), [0]);
  one.voice.stop();
  // A turn: the noise-free speech is sent, and the fillers are its own, not the old wait's.
  const b = timeline(t, 300);
  const two = setup({ filler: b.filler, agentRunning: () => true, fillerPacing: { first: 0, every: 2, randomness: 0, max: 3 } });
  turn(two.voice); await tick();
  await b.advance(3000);
  turn(two.voice); await tick(); await tick();
  assert.deepEqual(two.sent, ['hello', 'hello']);
  await b.advance(60_000);
  // The old wait had its two (0 and 2300), and the new turn's wait three of its own: three, not the one left of the old.
  assert.equal(b.starts().length, 2 + 3);
  two.voice.stop();
  // The answer is audible: the wait is over, and speech after it brings nothing back.
  const c = timeline(t, 300); calls = 0;
  const three = setup({ filler: c.filler, agentRunning: () => true, fillerPacing: { first: 0, every: 2, randomness: 0, max: 5 }, speak: async () => {}, transcribe: () => calls++ ? Promise.resolve('') : Promise.resolve('hello') });
  turn(three.voice); await tick();
  await c.advance(500);
  three.voice.observe([reply('a20')]); await tick(); await tick();
  assert.deepEqual(three.spoken, []);
  turn(three.voice); await tick(); await tick();
  await c.advance(60_000);
  assert.deepEqual(c.starts(), [0]);
  three.voice.stop();
});

test('a filler that comes due while something else plays on the page, a repeat of the last reply, waits another gap', async t => {
  const line = timeline(t, 300); let playing = false;
  const { voice } = setup({ filler: line.filler, agentRunning: () => true, fillerPacing: { first: 0, every: 2, randomness: 0, max: 8 }, playing: () => playing });
  turn(voice); await tick();
  playing = true;
  await line.advance(7000);
  assert.deepEqual(line.starts(), [0]);
  playing = false;
  await line.advance(2000);
  assert.deepEqual(line.starts().length, 2);
  voice.stop();
});

test('speech that became a turn leaves nothing of the wait it cut short to be brought back by a later noise', async t => {
  const line = timeline(t, 300); let running = true; let calls = 0;
  const { voice, sent } = setup({ filler: line.filler, agentRunning: () => running, fillerPacing: { first: 0, every: 2, randomness: 0, max: 8 }, transcribe: () => calls++ < 2 ? Promise.resolve('hello') : Promise.resolve('') });
  turn(voice); await tick();
  await line.advance(1000);
  turn(voice); await tick(); await tick();
  assert.deepEqual(sent, ['hello', 'hello']);
  // The agent finishes without a word, and the wait of the second turn is over; some other run then goes on, and a noise comes.
  running = false;
  await line.advance(10_000);
  const before = line.starts().length;
  running = true;
  voice.speechStart(); voice.speechEnd(new Float32Array(16000)); await tick(); await tick();
  await line.advance(60_000);
  assert.equal(line.starts().length, before);
  voice.stop();
});
