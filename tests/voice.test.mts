import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { speechChunks, newSpeech } from '../web/src/voice.js';
const dir = mkdtempSync(join(tmpdir(), 'pithagoras-voice-'));
process.env.DATA_DIR = dir;
process.env.AGENT_HOME = join(dir, 'agent-home');
// No Docker here, whatever this machine has: the managed service is tested on its own.
process.env.DOCKER_SOCKET = join(dir, 'no-docker.sock');
const { voiceRouter, pcmWav, wavPcm, validateConfig, connectManagedVoice } = await import('../server/src/api/voice.js');
const { INPUT_LANGUAGES, CHATTERBOX_LANGUAGES } = await import('../server/src/voice-languages.js');
const { getDb, getVoiceInstructions } = await import('../server/src/db.js');
const { DEFAULT_VOICE_INSTRUCTIONS } = await import('../server/src/pi/voice-first.js');
const upstream = express();
let calls = 0;
let busyAttempts = 0;
let nativeRequest: any;
let speechBody = "";
let transcriptionBody = "";
let releaseStream: (() => void) | undefined;
let streamClosed: (() => void) | undefined;
upstream.post('/inference', express.raw({ type: () => true }), (req, res) => {
  transcriptionBody = req.body.toString();
  calls++; assert.match(transcriptionBody, /name="file"; filename="recording.wav"/);
  res.json({ text: ' Test the session. ' });
});
upstream.post('/v1/audio/speech', express.raw({ type: () => true }), (req, res) => {
  if (req.get('content-type') === 'application/json') {
    nativeRequest = JSON.parse(req.body.toString());
    // Chatterbox has no streaming mode: it answers with one complete WAV.
    if (nativeRequest.model === 'chatterbox')
      return res.set({ 'Content-Type': 'audio/wav' }).send(pcmWav(Buffer.from([0, 0, 255, 127])));
    return res.set({ 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '24000' }).send(Buffer.from([0, 0, 255, 127]));
  }
  if (req.body.toString().includes('stream-test')) {
    res.set({ 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '24000' });
    res.write(Buffer.from([0, 0]));
    releaseStream = () => res.end(Buffer.from([255, 127]));
    res.on('close', () => streamClosed?.());
    return;
  }
  if (req.body.toString().includes('busy-test') && ++busyAttempts <= 2) return res.status(409).json({ detail: 'busy' });
  speechBody = req.body.toString();
  calls++; assert.match(speechBody, /name="instruction"/);
  res.set({ 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '24000' }).send(Buffer.from([0, 0, 255, 127]));
});
const backend = upstream.listen(0, '127.0.0.1');
await new Promise<void>(r => backend.once('listening', r));
const port = (backend.address() as { port: number }).port;
const app = express(); app.use(express.json()); app.use('/api', voiceRouter());
const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
after(async () => {
  await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => backend.close(() => r()))]);
  getDb().close(); rmSync(dir, { recursive: true, force: true });
});
const settings = { enabled: true, whisperUrl: `http://127.0.0.1:${port}/inference`, breezeUrl: `http://127.0.0.1:${port}/v1/audio/speech`, instruction: 'A calm English voice.' };
test('voice is opt-in, checks session existence, and proxies actual multipart contracts', async () => {
  assert.equal((await (await fetch(`${base}/voice`)).json()).enabled, false);
  assert.equal((await fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"hello"}' })).status, 409);
  const saved = await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
  assert.equal(saved.status, 200);
  assert.equal((await fetch(`${base}/sessions/missing/voice/transcribe`, { method: 'POST' })).status, 404);
  getDb().prepare("INSERT INTO sessions (id,title,workspace,executor,status,created_at,updated_at) VALUES ('test','Voice','/tmp','host','idle','now','now')").run();
  assert.equal((await fetch(`${base}/sessions/test/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: 'invalid' })).status, 400);
  const transcribed = await fetch(`${base}/sessions/test/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: new Uint8Array(pcmWav(Buffer.alloc(32))) });
  assert.deepEqual(await transcribed.json(), { text: 'Test the session.' });
  const spoken = await fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"Hello"}' });
  assert.equal(spoken.headers.get('content-type')?.split(';')[0], 'audio/wav');
  const wav = Buffer.from(await spoken.arrayBuffer()); assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 24000); assert.equal(wav.readUInt32LE(40), 4);
  assert.equal(calls, 2);
  const busy = await fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"busy-test"}' });
  assert.equal(busy.status, 200);
  assert.equal(busyAttempts, 3);
  assert.equal(Buffer.from(await busy.arrayBuffer()).toString("ascii", 0, 4), "RIFF");
  assert.match(transcriptionBody, /name="language"\r\n\r\nauto\r\n/);
});
test('Aria sends the installed reference and transcript; missing references never fall back to a designed voice', async () => {
  const save = await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, voice: 'aria', cfgScale: 1 }) });
  assert.equal(save.status, 200);
  const speak = () => fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hello from Aria.' }) });
  const before = calls;
  assert.equal((await speak()).status, 502);
  assert.equal(calls, before);
  mkdirSync(join(dir, 'voices'));
  writeFileSync(join(dir, 'voices/aria.wav'), pcmWav(Buffer.alloc(32)));
  writeFileSync(join(dir, 'voices/aria.txt'), 'This is the exact reference transcript.');
  assert.equal((await speak()).status, 200);
  assert.match(speechBody, /name="ref_audio"; filename="aria.wav"/);
  assert.match(speechBody, /name="ref_text"/);
  assert.ok(speechBody.includes('name="cfg_scale"\r\n\r\n1\r\n'));
  assert.match(speechBody, /This is the exact reference transcript\./);
  assert.throws(() => validateConfig({ ...settings, voice: '../other' }));
});
test('selected input language is sent to Whisper and invalid languages are rejected', async () => {
  for (const language of ['en', 'hi', 'bn']) {
    const saved = await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, language }) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).language, language);
    const result = await fetch(`${base}/sessions/test/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: new Uint8Array(pcmWav(Buffer.alloc(32))) });
    assert.equal(result.status, 200);
    assert.ok(transcriptionBody.includes('name="language"\r\n\r\n' + language + '\r\n'));
  }
  assert.throws(() => validateConfig({ ...settings, language: 'invalid' }));
});
test('reject invalid service settings and malformed audio', () => {
  assert.throws(() => validateConfig({ ...settings, breezeUrl: 'file:///etc/passwd' }));
  assert.throws(() => validateConfig({ ...settings, enabled: 'true' }));
  assert.throws(() => pcmWav(Buffer.alloc(1)));
  assert.throws(() => validateConfig({ ...settings, cfgScale: 0 }));
});
test('spoken chunks omit code and preserve long prose without exceeding the API bound', () => {
  assert.deepEqual(speechChunks('Hello **there**. [Read this](https://example.com) ```js\nsecret()\n```'), ['Hello there. Read this Code is shown in the transcript.']);
  const text = 'word '.repeat(1000).trim(); const chunks = speechChunks(text);
  assert.ok(chunks.every(c => c.length <= 600)); assert.equal(chunks.join(' '), text);
  assert.equal(speechChunks('a'.repeat(1600)).join(''), 'a'.repeat(1600));
});

test('history loading, partial replies and reconnect replay never repeat speech', () => {
  const seen = new Set<string>();
  const reply = (id: string, done: boolean) => ({ kind: 'assistant' as const, id, done, text: 'Hello.', thinking: 'Private reasoning' });
  assert.deepEqual(newSpeech([reply('a1', true), reply('a30', false)], 20, seen), []);
  assert.deepEqual(newSpeech([reply('a1', true), reply('a30', true)], 20, seen), ['Hello.']);
  assert.deepEqual(newSpeech([reply('a5', true), reply('a30', true)], 20, seen), []);
  assert.deepEqual(newSpeech([reply('a40', true)], 20, seen), ['Hello.']);
});

test('PCM reaches the client before synthesis completes, and cancelling disconnects upstream', async () => {
  const request = (signal?: AbortSignal) => fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/pcm' }, body: JSON.stringify({ text: 'stream-test' }), signal });
  const response = await request();
  assert.equal(response.headers.get('content-type'), 'audio/pcm');
  const reader = response.body!.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([0, 0]));
  releaseStream!();
  assert.deepEqual((await reader.read()).value, new Uint8Array([255, 127]));
  assert.equal((await reader.read()).done, true);
  const abort = new AbortController();
  const next = await request(abort.signal);
  const nextReader = next.body!.getReader();
  await nextReader.read();
  const closed = new Promise<void>(resolve => { streamClosed = resolve; });
  abort.abort();
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Upstream did not cancel')), 2000).unref())]);
});

test('audio.cpp receives cloning context and exposes incremental playback', async () => {
  await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, runtime: 'audio-cpp', voice: 'aria', cfgScale: 1 }) });
  // The earlier missing-reference test removes its fixture.
  mkdirSync(join(dir, 'voices'), { recursive: true });
  writeFileSync(join(dir, 'voices/aria.wav'), pcmWav(Buffer.alloc(32)));
  writeFileSync(join(dir, 'voices/aria.txt'), 'Reference voice.');
  const response = await fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/pcm' }, body: JSON.stringify({ text: 'Speak while generating.' }) });
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-voice-streaming'), 'true');
  assert.equal(nativeRequest.reference_text, 'Reference voice.');
  assert.equal(nativeRequest.voice_ref.type, 'base64'); assert.equal(nativeRequest.stream_format, 'audio');
  assert.equal(nativeRequest.options.guidance_scale, '1'); await response.arrayBuffer();
});


test('voice mode speaks with the voice of the agent the chat is with', async () => {
  const { createAgent, setVoice } = await import('../server/src/agents.js');
  const { createSession } = await import('../server/src/db.js');
  const saved = await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, runtime: 'audio-cpp', voice: 'design' }) });
  assert.equal(saved.status, 200);
  const { addVoice } = await import('../server/src/voice-presets.js');
  const { samplesWav } = await import('../web/src/voice.js');
  const audio = Buffer.from(await samplesWav(new Float32Array(16000)).arrayBuffer()).toString('base64');
  const clone = addVoice({ name: 'Herald voice', kind: 'clone', instruction: 'Warm.', transcript: 'Herald reference.', audio });
  const agent = createAgent({ name: 'Herald' });
  setVoice(agent.id, clone.id);
  createSession({ id: 'herald-chat', title: 'Herald', workspace: agent.home, executor: 'host' });
  nativeRequest = undefined;
  const response = await fetch(`${base}/sessions/herald-chat/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hello.' }) });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(nativeRequest.reference_text, 'Herald reference.', "the agent's clone, not the designed voice in the settings");
});

test('custom clone sends its saved recording, transcript and description to audio.cpp', async () => {
  const { addVoice } = await import('../server/src/voice-presets.js');
  const { samplesWav } = await import('../web/src/voice.js');
  const audio = Buffer.from(await samplesWav(new Float32Array(16000)).arrayBuffer()).toString('base64');
  const preset = addVoice({ name: 'Custom narrator', kind: 'clone', instruction: 'Warm narrator.', transcript: 'My reference words.', audio });
  const saved = await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, runtime: 'audio-cpp', voice: preset.id }) });
  assert.equal(saved.status, 200);
  const response = await fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Custom voice response.' }) });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.deepEqual(nativeRequest.voice_ref, { type: 'base64', data: audio });
  assert.equal(nativeRequest.reference_text, 'My reference words.');
  assert.equal(nativeRequest.options.instruction, 'Warm narrator.');
});

test('a changed voice description reaches the next phrase on both Breeze runtimes, and the recording stays', async () => {
  const { addVoice } = await import('../server/src/voice-presets.js');
  const { samplesWav } = await import('../web/src/voice.js');
  const audio = Buffer.from(await samplesWav(new Float32Array(16000)).arrayBuffer()).toString('base64');
  const preset = addVoice({ name: 'Edited narrator', kind: 'clone', instruction: 'Warm narrator.', transcript: 'Words on the tape.', audio });
  const patch = (id: string, body: unknown) => fetch(`${base}/voice/presets/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const speak = async () => { const response = await fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Edited voice response.' }) }); assert.equal(response.status, 200); await response.arrayBuffer(); };
  const select = async (runtime: string) => assert.equal((await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, runtime, voice: preset.id }) })).status, 200);
  await select('audio-cpp');
  await speak();
  assert.equal(nativeRequest.options.instruction, 'Warm narrator.');
  const edited = await patch(preset.id, { instruction: '  A slow, low voice.  ' });
  assert.equal(edited.status, 200);
  assert.deepEqual(await edited.json(), { id: preset.id, name: 'Edited narrator', kind: 'clone', instruction: 'A slow, low voice.', transcript: 'Words on the tape.' });
  await speak();
  assert.equal(nativeRequest.options.instruction, 'A slow, low voice.');
  assert.deepEqual(nativeRequest.voice_ref, { type: 'base64', data: audio });
  assert.equal(nativeRequest.reference_text, 'Words on the tape.');
  // The Python runtime takes the same text as a form field.
  await select('breeze');
  await speak();
  assert.ok(speechBody.includes('name="instruction"\r\n\r\nA slow, low voice.\r\n'));
  assert.ok(!speechBody.includes('Warm narrator.'));
  assert.equal((await (await fetch(`${base}/voice/presets`)).json()).find((v: any) => v.id === preset.id).instruction, 'A slow, low voice.');
  // A description that cannot be used, or a voice that is not there, changes nothing.
  for (const instruction of ['', '   ', 'x'.repeat(1001), 7, undefined]) {
    const refused = await patch(preset.id, { instruction });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /1–1000 characters/);
  }
  assert.equal((await patch('voice-missing', { instruction: 'Clear.' })).status, 404);
  await speak();
  assert.ok(speechBody.includes('name="instruction"\r\n\r\nA slow, low voice.\r\n'));
});

test('Chatterbox clones a reference, writes numbers out and returns one buffered phrase', async () => {
  const chatterbox = { ...settings, runtime: 'chatterbox', voice: 'aria', language: 'de', exaggeration: 0.3, sttModel: 'qwen3-asr' };
  assert.equal((await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chatterbox) })).status, 200);
  const response = await fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/pcm' }, body: JSON.stringify({ text: 'Der Build nutzt 4070 Megabyte.' }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/pcm');
  assert.equal(response.headers.get('x-sample-rate'), '24000');
  // Without a stream there is nothing to announce as incremental playback.
  assert.equal(response.headers.get('x-voice-streaming'), null);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 0, 255, 127]));
  assert.equal(nativeRequest.model, 'chatterbox');
  assert.equal(nativeRequest.language, 'de');
  assert.equal(nativeRequest.input, 'Der Build nutzt viertausendsiebzig Megabyte.');
  assert.equal(nativeRequest.options.exaggeration, '0.3');
  assert.equal(nativeRequest.voice_ref.type, 'base64');
  // The recognition model reaches the OpenAI-compatible transcription endpoint.
  await fetch(`${base}/sessions/test/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: new Uint8Array(pcmWav(Buffer.alloc(32))) });
  assert.ok(transcriptionBody.includes('name="model"\r\n\r\nqwen3-asr\r\n'));
  // A designed voice has no recording to clone from: refused on save, not on
  // every phrase of a conversation.
  const refused = await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...chatterbox, voice: 'design' }) });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /reference clone/);
  assert.throws(() => validateConfig({ ...chatterbox, language: 'ru' }), /Chatterbox speaks/);
  // Chatterbox is told a language; auto-detect would silently mean English.
  assert.throws(() => validateConfig({ ...chatterbox, language: 'auto' }), /needs an input language/);
  assert.equal(validateConfig({ ...chatterbox, language: 'nl' }).language, 'nl');
  assert.throws(() => validateConfig({ ...settings, sttModel: 'a model' }));
  assert.throws(() => validateConfig({ ...settings, exaggeration: 5 }));
});

test('VAD settings preserve defaults, accept tuning and reject invalid thresholds', () => {
  assert.equal(validateConfig(settings).vad?.redemptionMs, 1000);
  assert.equal(validateConfig({...settings, vad:{redemptionMs:500}}).vad?.redemptionMs, 500);
  assert.equal(validateConfig({...settings, vad:{redemptionMs:500}}).vad?.positiveSpeechThreshold, 0.65);
  for (const vad of [{redemptionMs:0}, {minSpeechMs:NaN}, {preSpeechPadMs:1001}, {positiveSpeechThreshold:0.3,negativeSpeechThreshold:0.4}]) {
    assert.throws(() => validateConfig({...settings,vad}));
  }
});

test('every language a runtime accepts is one the add-on can offer', () => {
  for (const code of CHATTERBOX_LANGUAGES) assert.ok(INPUT_LANGUAGES.some(([value]) => value === code), `${code} is missing from the input languages`);
  assert.equal(validateConfig({ ...settings, language: 'sw' }).language, 'sw');
});

test('a WAV whose data chunk carries a placeholder size keeps its samples', () => {
  const wav = pcmWav(Buffer.from([0, 0, 255, 127]));
  assert.deepEqual(wavPcm(wav), Buffer.from([0, 0, 255, 127]));
  for (const size of [0, 0xffffffff]) {
    const placeholder = Buffer.from(wav);
    placeholder.writeUInt32LE(size, 40);
    assert.deepEqual(wavPcm(placeholder), Buffer.from([0, 0, 255, 127]));
  }
  // A truncated fmt chunk is reported as unsupported audio, not as a read past the end.
  const truncated = Buffer.concat([Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVE', 'ascii'), Buffer.alloc(40), Buffer.from('fmt ', 'ascii'), Buffer.alloc(8)]);
  assert.throws(() => wavPcm(truncated), /Expected mono 24 kHz 16-bit audio/);
  // Samples ahead of their fmt chunk, or in a non-PCM encoding, are refused.
  const dataFirst = Buffer.concat([wav.subarray(0, 12), wav.subarray(36), wav.subarray(12, 36)]);
  assert.throws(() => wavPcm(dataFirst), /Expected mono 24 kHz 16-bit audio/);
  const float = Buffer.from(wav);
  float.writeUInt16LE(3, 20);
  assert.throws(() => wavPcm(float), /Expected mono 24 kHz 16-bit audio/);
});

test('connecting the managed voice drops a recognition model from another runtime', async () => {
  const saved = await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, runtime: 'chatterbox', voice: 'aria', language: 'de', sttModel: 'qwen3-asr' }) });
  assert.equal(saved.status, 200);
  // Whisper.cpp is sent this field verbatim; another runtime's model id would
  // reach it in the multipart body of every transcription.
  assert.equal(connectManagedVoice().sttModel, '');
  assert.equal((await (await fetch(`${base}/voice`)).json()).sttModel, '');
});

test('connecting the managed voice points the settings at the engines it was built with', async () => {
  const put = (patch: object) => fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, voice: 'aria', ...patch }) });
  assert.equal((await put({ language: 'auto' })).status, 200);
  // Whisper: its own endpoint, and no model field in the request.
  const whisper = connectManagedVoice({ tts: 'breeze', asr: 'whisper', asrModel: 'small' });
  assert.deepEqual([whisper.runtime, whisper.whisperUrl, whisper.breezeUrl, whisper.sttModel], ['audio-cpp', 'http://127.0.0.1:8188/inference', 'http://127.0.0.1:7862/v1/audio/speech', '']);
  // Qwen3-ASR: audio.cpp's transcription endpoint, with the id of the model it loaded.
  const qwen = connectManagedVoice({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' });
  assert.deepEqual([qwen.runtime, qwen.whisperUrl, qwen.sttModel, qwen.language], ['audio-cpp', 'http://127.0.0.1:7862/v1/audio/transcriptions', 'qwen3-asr', 'auto']);
  assert.equal((await (await fetch(`${base}/voice`)).json()).managed, true);
  // Chatterbox refuses to guess a language: auto-detect becomes one it speaks, a chosen one stays.
  const chatterbox = connectManagedVoice({ tts: 'chatterbox', asr: 'qwen3-asr', asrModel: '1.7b' });
  assert.deepEqual([chatterbox.runtime, chatterbox.language, chatterbox.sttModel], ['chatterbox', 'en', 'qwen3-asr']);
  const shown = await (await fetch(`${base}/voice`)).json();
  assert.deepEqual([shown.runtime, shown.managed], ['chatterbox', true], 'the leases load the model the saved engine speaks with');
  await put({ language: 'de' });
  assert.equal(connectManagedVoice({ tts: 'chatterbox', asr: 'whisper', asrModel: 'base' }).language, 'de');
  // Back to Breeze keeps the language and drops Chatterbox's runtime.
  assert.deepEqual([connectManagedVoice().runtime, connectManagedVoice().language], ['audio-cpp', 'de']);
});

test('recognition alone: nothing is spoken, and dictation still has its transcription', async () => {
  const put = (patch: object) => fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, ...patch }) });
  // Connecting the managed services of a choice without speech synthesis saves no address to speak to.
  const whisper = connectManagedVoice({ tts: 'none', asr: 'whisper', asrModel: 'base' });
  assert.deepEqual([whisper.runtime, whisper.breezeUrl, whisper.whisperUrl, whisper.sttModel, whisper.enabled, whisper.managed], ['none', '', 'http://127.0.0.1:8188/inference', '', true, true]);
  const qwen = connectManagedVoice({ tts: 'none', asr: 'qwen3-asr', asrModel: '0.6b' });
  assert.deepEqual([qwen.runtime, qwen.breezeUrl, qwen.whisperUrl, qwen.sttModel], ['none', '', 'http://127.0.0.1:7863/v1/audio/transcriptions', 'qwen3-asr']);
  // Beside a speech engine, Qwen3-ASR is on the GPU server's port, or on the CPU server's by choice.
  assert.equal(connectManagedVoice({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' }).whisperUrl, 'http://127.0.0.1:7862/v1/audio/transcriptions');
  assert.equal(connectManagedVoice({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b', asrDevice: 'cpu' }).whisperUrl, 'http://127.0.0.1:7863/v1/audio/transcriptions');
  connectManagedVoice({ tts: 'none', asr: 'whisper', asrModel: 'base' });
  // The page is told there is nothing to speak with, so that voice mode is not offered; dictation is.
  const shown = await (await fetch(`${base}/voice`)).json();
  assert.deepEqual([shown.enabled, shown.speech, shown.runtime, shown.managed], [true, false, 'none', false]);
  // Replies are not synthesized, and the answer says why instead of failing on an address that is not there.
  const spoken = await fetch(`${base}/sessions/test/voice/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"Hello"}' });
  assert.equal(spoken.status, 409);
  assert.match((await spoken.json()).error, /Speech synthesis is not installed/);
  // What was heard is still transcribed: that is dictation. The tests' Whisper stands where the managed one would.
  assert.equal((await put({ runtime: 'none', breezeUrl: '' })).status, 200);
  const transcribed = await fetch(`${base}/sessions/test/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: new Uint8Array(pcmWav(Buffer.alloc(32))) });
  assert.deepEqual(await transcribed.json(), { text: 'Test the session.' });
  // The settings are saved with no speech address only when there is no speech synthesis.
  assert.equal((await put({ runtime: 'none', breezeUrl: '' })).status, 200);
  assert.equal((await put({ runtime: 'audio-cpp', breezeUrl: '' })).status, 400);
  assert.equal((await put({ runtime: 'none', breezeUrl: 'ftp://nowhere' })).status, 400);
  // Back to speech: spoken again, and the page is told so.
  assert.equal((await put({})).status, 200);
  assert.equal((await (await fetch(`${base}/voice`)).json()).speech, true);
});

test('without Docker the setup says only that Docker is needed: recognition alone needs no GPU, and the requirement of speech synthesis is said where it applies', async () => {
  // No Docker socket here, whatever this machine has.
  const state = await (await fetch(`${base}/voice/install`)).json();
  assert.deepEqual([state.available, state.state, state.busy], [false, 'unavailable', false]);
  assert.equal(state.error, 'Automatic voice setup requires access to Docker.');
  assert.doesNotMatch(state.error, /GPU|NVIDIA/);
});

test('install takes the engines to build, and refuses a choice the installer does not make', async () => {
  const post = (body: object) => fetch(`${base}/voice/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const body of [{ tts: 'kokoro', asr: 'whisper', asrModel: 'base' }, { tts: 'breeze', asr: 'whisper', asrModel: '1.7b' }, { tts: 'breeze' }, { asr: 'qwen3-asr', asrModel: '0.6b' }]) {
    const answer = await post(body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.match((await answer.json()).error, /Choose a supported speech/);
  }
  // Nothing was started, so there is no setup to wait for either.
  assert.equal((getDb().prepare("SELECT value FROM settings WHERE key='voice_setup_pending'").get() as any)?.value, undefined);
});

test('the hardware check reports the GPUs and what it would suggest, and degrades to the original combination without a tool', async () => {
  const smi = join(dir, 'nvidia-smi');
  writeFileSync(smi, '#!/bin/sh\nprintf "0, Test GPU A, 12288, 11000\\n1, Test GPU B, 24576, 24000\\n"\n');
  chmodSync(smi, 0o755);
  process.env.NVIDIA_SMI = smi;
  // What the host has is told, not read from the machine the tests run on.
  (await import('../server/src/extensions/voice-service.js')).hostReader.read = () => ({ totalMiB: 16384, freeMiB: 8192, threads: 8 });
  const found = await (await fetch(`${base}/voice/hardware`)).json();
  assert.deepEqual(found.gpus.map((g: any) => [g.index, g.name, g.totalMiB, g.freeMiB]), [[0, 'Test GPU A', 12288, 11000], [1, 'Test GPU B', 24576, 24000]]);
  assert.deepEqual([found.source, found.selected, found.reserveMiB], ['host', 1, 0]);
  assert.deepEqual(found.suggestion, { tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b' });
  process.env.NVIDIA_SMI = join(dir, 'missing-nvidia-smi');
  const none = await fetch(`${base}/voice/hardware`);
  assert.equal(none.status, 200);
  const empty = await none.json();
  // No tool and no Docker is no GPU, said plainly: what is suggested is recognition alone on the CPU, sized to the host.
  assert.deepEqual([empty.gpus, empty.source, empty.selected, empty.checked, empty.cpuOnly], [[], 'none', null, true, true]);
  assert.equal(empty.error, 'host: nvidia-smi was not found; docker: no GPU available');
  assert.deepEqual(empty.host, { totalMiB: 16384, freeMiB: 8192, threads: 8 });
  assert.deepEqual(empty.suggestion, { tts: 'none', asr: 'qwen3-asr', asrModel: '0.6b' });
  delete process.env.NVIDIA_SMI;
});

test('speaking instructions: the built-in text is offered, a custom one is saved, and blank or equal goes back to the built-in', async () => {
  const put = (responseInstructions: unknown) => fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, responseInstructions }) });
  const get = async () => (await fetch(`${base}/voice`)).json();
  // Nothing saved: the server's own text is what the page shows and resets to.
  await put(undefined);
  let shown = await get();
  assert.equal(shown.responseInstructions, DEFAULT_VOICE_INSTRUCTIONS);
  assert.equal(shown.defaultResponseInstructions, DEFAULT_VOICE_INSTRUCTIONS);
  assert.equal(shown.responseInstructionsOff, false);
  assert.equal(getVoiceInstructions(), '');
  // A custom text is saved trimmed, and is what every turn is then given.
  const saved = await put('  Answer in one word.\n');
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).responseInstructions, 'Answer in one word.');
  assert.equal(getVoiceInstructions(), 'Answer in one word.');
  shown = await get();
  assert.equal(shown.responseInstructions, 'Answer in one word.');
  assert.equal(shown.defaultResponseInstructions, DEFAULT_VOICE_INSTRUCTIONS, 'still there to go back to');
  // Empty text, or the built-in text sent back, is not saved as a custom one: the built-in instructions then follow the portal's updates.
  for (const back of ['', '   ', DEFAULT_VOICE_INSTRUCTIONS, `${DEFAULT_VOICE_INSTRUCTIONS}\n`]) {
    await put('Answer in one word.');
    assert.equal((await put(back)).status, 200);
    assert.equal(getVoiceInstructions(), '', JSON.stringify(back));
    assert.equal((await get()).responseInstructions, DEFAULT_VOICE_INSTRUCTIONS);
  }
  // Connecting the managed voice saves the settings again, and keeps it.
  await put('Answer in one word.');
  assert.equal(connectManagedVoice().responseInstructions, 'Answer in one word.');
  assert.equal(getVoiceInstructions(), 'Answer in one word.');
  // Text that cannot be, and a size that no turn should carry.
  assert.equal((await put(42)).status, 400);
  assert.equal((await put('x'.repeat(8001))).status, 400);
  assert.equal((await put('x'.repeat(8000))).status, 200);
  assert.equal(getVoiceInstructions(), 'x'.repeat(8000));
  await put('');
});
test('VOICE_RESPONSE_INSTRUCTIONS=false is shown to the page, and leaves a saved text alone', async () => {
  const previous = process.env.VOICE_RESPONSE_INSTRUCTIONS;
  try {
    await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, responseInstructions: 'Answer in one word.' }) });
    process.env.VOICE_RESPONSE_INSTRUCTIONS = 'false';
    const shown = await (await fetch(`${base}/voice`)).json();
    assert.equal(shown.responseInstructionsOff, true);
    assert.equal(shown.responseInstructions, 'Answer in one word.');
    process.env.VOICE_RESPONSE_INSTRUCTIONS = 'true';
    assert.equal((await (await fetch(`${base}/voice`)).json()).responseInstructionsOff, false);
  } finally {
    if (previous === undefined) delete process.env.VOICE_RESPONSE_INSTRUCTIONS;
    else process.env.VOICE_RESPONSE_INSTRUCTIONS = previous;
    await fetch(`${base}/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
  }
});
