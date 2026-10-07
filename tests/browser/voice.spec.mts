import { test, expect } from './portal-mock';
import { settled } from './settled';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const sample = readFileSync(new URL('../fixtures/jfk.wav', import.meta.url));
test.beforeEach(async ({ page }) => {
  await page.route('**/api/browser', route => route.fulfill({ json: { running: false, sessions: [], install: { container: 'stopped' } } }));
  await page.route('**/api/sessions/test/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/sessions/test/config', route => route.fulfill({ status: 503, json: {} }));
});
test('real browser VAD submits turns, supports barge-in, and releases the mic', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', e => failures.push(e.message));
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.route('**/voice/transcribe', route => {
    expect(route.request().postDataBuffer()?.subarray(0, 4).toString()).toBe('RIFF');
    return route.fulfill({ json: { text: 'A test voice turn.' } });
  });
  let speechRequests = 0;
  await page.route('**/voice/speech', route => ++speechRequests === 1
    ? route.fulfill({ status: 502, json: { error: 'Breeze returned HTTP 409 (voice service is busy; try again)' } })
    : route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.goto('/tests/voice.html');
  await page.getByRole('textbox', { name: 'Message' }).fill('Keep this draft');
  await page.getByRole('button', { name: 'Profile voice latency' }).click();
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible({ timeout: 25000 });
  await expect(page.getByRole('status')).toContainText('Listening');
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeHidden();
  await expect(page.getByText('We can work through it together.')).toBeHidden();
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.getByRole('status')).toContainText('Hearing you');
  await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 12000 });
  await expect(page.getByTestId('voice-send')).toHaveText('true');
  await expect(page.getByRole('status')).toContainText('Speaking');
  await expect(page.getByLabel('Voice latency profiler')).toContainText('from last detected speech to reply audio');
  await expect(page.getByLabel('Voice latency profiler')).toContainText('Turn detection');
  const timingDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download timing report'}).click();
  expect((await timingDownload).suggestedFilename()).toBe('voice-latency.json');
  await page.getByRole('button',{name:'Close voice profiler'}).click();
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.getByRole('status')).toContainText('Hearing you');
  await expect(page.getByTestId('aborted')).toHaveText('1');
  await expect(page.getByTestId('sent')).toHaveText('2', { timeout: 12000 });
  await page.getByRole('button', { name: 'End voice mode' }).click();
  await page.getByRole('button', { name: 'Check mic tracks' }).click();
  await expect(page.getByTestId('tracks')).toHaveText('ended:true');
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this draft');
  await expect(page.getByText('We can work through it together.')).toBeVisible();
  expect(failures).toEqual([]);
});

test('cancelling while the VAD model loads releases the microphone without sending', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/silero_vad_v5.onnx', async route => { await gate; await route.continue(); });
  await page.goto('/tests/voice.html');
  const request = page.waitForRequest('**/silero_vad_v5.onnx');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await request;
  await page.getByRole('button', { name: 'End voice mode' }).click();
  release();
  await page.getByRole('button', { name: 'Check mic tracks' }).click();
  await expect(page.getByTestId('tracks')).toHaveText('ended:true');
  await expect(page.getByTestId('sent')).toHaveText('0');
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toBeVisible();
});

test('mute keeps playback and option prompts available; end restores the chat', async ({ page }) => {
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.route('**/voice/transcribe', route => route.fulfill({ json: { text: 'A test voice turn.' } }));
  await page.route('**/voice/speech', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  let chosen: unknown;
  await page.route('**/ui-response', route => { chosen = route.request().postDataJSON(); return route.fulfill({ json: { ok: true } }); });
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.locator('.voice-orb')).toHaveAttribute('data-mode', 'input');
  await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 12000 });
  await expect(page.locator('.voice-orb')).toHaveAttribute('data-mode', 'output');
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await page.getByRole('button', { name: 'Check mic tracks' }).click();
  await expect(page.getByTestId('tracks')).toHaveText('live:false');
  await expect(page.locator('.voice-orb')).toHaveAttribute('data-mode', 'output');
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await page.waitForTimeout(4200); // Longer than the injected speech plus turn-end silence.
  await expect(page.getByTestId('sent')).toHaveText('1');
  await expect(page.getByTestId('aborted')).toHaveText('0');
  await page.getByRole('button', { name: 'Show options' }).click();
  await page.getByRole('button', { name: 'Run tests', exact: true }).click();
  await expect(page.getByTestId('selected')).toHaveText('1');
  expect(chosen).toMatchObject({ id: 'choice', value: 'Run tests' });
  await page.getByRole('button', { name: 'Unmute microphone' }).click();
  await page.getByRole('button', { name: 'Check mic tracks' }).click();
  await expect(page.getByTestId('tracks')).toHaveText('live:true');
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.getByTestId('sent')).toHaveText('2', { timeout: 12000 });
  await page.getByRole('button', { name: 'End voice mode' }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
});

test('composer and voice controls fit a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  const end = await page.getByRole('button', { name: 'End voice mode' }).boundingBox();
  expect(end!.y + end!.height).toBeLessThan(844);
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(horizontalOverflow).toBe(false);
  await page.getByRole('button', { name: 'End voice mode' }).click();
});


test('voice pipelines next-sentence synthesis during PCM playback and cancels on End', async ({ page }) => {
  const failures: string[] = []; page.on('pageerror', e => failures.push(e.message));
  const pcm = Buffer.alloc(24000 * 2 * 5);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / 24000) * 5000), i * 2);
  const texts: string[] = [];
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/voice/speech', route => {
    expect(route.request().headers().accept).toBe('audio/pcm');
    texts.push(route.request().postDataJSON().text);
    return route.fulfill({ body: pcm, headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000' } });
  });
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  await page.getByRole('button', { name: 'Stream reply', exact: true }).click();
  await expect(page.locator('.voice-orb')).toHaveAttribute('data-mode', 'output');
  expect(texts).toEqual(['Here is the first sentence.']);
  await page.getByRole('button', { name: 'Finish reply', exact: true }).click();
  // The first phrase is five seconds long: request two must start while it plays.
  await expect.poll(() => texts.length, { timeout: 1500 }).toBe(2);
  await expect(page.locator('.voice-orb')).toHaveAttribute('data-mode', 'output');
  expect(texts).toEqual(['Here is the first sentence.', 'More text follows.']);
  await page.getByRole('button', { name: 'End voice mode' }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  expect(failures).toEqual([]);
});

test('slow PCM chunks become one uninterrupted buffer, including split samples', async ({ page }) => {
  await page.goto('/tests/voice.html');
  const result = await page.evaluate(async () => {
    const { readPcmStream, playAudioBuffer } = await import('/src/pcm-stream.ts');
    // One phrase, buffered whole and then played: what a consumer without a pipeline does.
    const playPcmStream = async (body: ReadableStream<Uint8Array>, audio: AudioContext, destination: AudioNode, signal: AbortSignal, onStarted: () => void) =>
      playAudioBuffer(await readPcmStream(body, audio, signal), audio, destination, signal, onStarted);
    const audio = new AudioContext(); await audio.resume();
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    let started = false, sourceCount = 0;
    const original = audio.createBufferSource.bind(audio);
    audio.createBufferSource = () => { sourceCount++; return original(); };
    const body = new ReadableStream<Uint8Array>({ start(c) { writer = c; } });
    const pending = playPcmStream(body, audio, audio.destination, new AbortController().signal, () => { started = true; });
    writer.enqueue(new Uint8Array([0]));
    writer.enqueue(new Uint8Array(4801));
    await new Promise(resolve => setTimeout(resolve, 300)); // Producer slower than the 100 ms of available audio.
    const startedTooEarly = started;
    writer.enqueue(new Uint8Array(4800)); writer.close();
    await pending; await audio.close();
    return { startedTooEarly, started, sourceCount };
  });
  expect(result).toEqual({ startedTooEarly: false, started: true, sourceCount: 1 });
});

test('End cancels PCM buffering before any audio can start', async ({ page }) => {
  await page.goto('/tests/voice.html');
  const result = await page.evaluate(async () => {
    const { readPcmStream, playAudioBuffer } = await import('/src/pcm-stream.ts');
    // One phrase, buffered whole and then played: what a consumer without a pipeline does.
    const playPcmStream = async (body: ReadableStream<Uint8Array>, audio: AudioContext, destination: AudioNode, signal: AbortSignal, onStarted: () => void) =>
      playAudioBuffer(await readPcmStream(body, audio, signal), audio, destination, signal, onStarted);
    const audio = new AudioContext(); await audio.resume();
    let cancelled = false, started = false;
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4800)); }, cancel() { cancelled = true; } });
    const abort = new AbortController();
    const pending = playPcmStream(body, audio, audio.destination, abort.signal, () => { started = true; }).then(() => 'finished', () => 'aborted');
    await new Promise(resolve => setTimeout(resolve, 50)); abort.abort();
    const outcome = await pending; await audio.close();
    return { started, cancelled, outcome };
  });
  expect(result).toEqual({ started: false, cancelled: true, outcome: 'aborted' });
});

test('live transcription begins before turn completion and previews recognized words', async ({ page }) => {
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.route('**/voice/transcribe', route => route.fulfill({ json: { text: 'Recognized while you speak.' } }));
  await page.route('**/voice/speech', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  const request = page.waitForRequest('**/voice/transcribe');
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await request;
  await expect(page.getByTestId('sent')).toHaveText('0');
  await expect(page.getByLabel('Live transcription')).toHaveText('Recognized while you speak.');
  await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 12000 });
  await page.getByRole('button', { name: 'End voice mode' }).click();
});


test('voice panels animate into browser, terminal and simultaneous layouts', async ({ page }) => {
  await page.addInitScript(() => {
    // The terminal's stream, which has no server behind it here.
    (window as any).EventSource=class { onmessage:any; onopen:any; close(){} };
  });
  const failures: string[] = []; page.on('pageerror', e => failures.push(e.message));
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/browser', route => route.fulfill({ json: { install: { container: 'running' } } }));
  await page.route('**/browser-ui/', route => route.fulfill({ contentType: 'text/html', body: '<body style="margin:0;background:#171a20;color:#d1d8e3;font:15px system-ui;padding:36px"><small style="color:#778294">EXAMPLE.COM</small><h1 style="font-weight:500">A browser, in view.</h1><p>The live page stays visible while you keep talking.</p></body>' }));
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  await page.getByRole('button', { name: 'Voice settings' }).click();
  await page.getByRole('group', { name: 'Sound effects' }).getByRole('button', { name: 'Off' }).click();
  expect(await page.evaluate(() => localStorage.getItem('voiceSounds'))).toBe('off');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Use browser', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Live browser', exact: true })).toBeVisible();
  await expect(page.locator('.voice-stage')).toHaveClass(/is-browsing/);
  await settled(page);
  await page.getByRole('button', { name: 'Use terminal', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Live terminal', exact: true })).toBeVisible();
  await expect(page.getByLabel('Agent terminal output')).toContainText('42 modules transformed');
  await expect(page.getByLabel('Tool activity')).toContainText('Running a command');
  await settled(page);
  const browser = await page.locator('.voice-browser-window').boundingBox();
  const terminal = await page.locator('.voice-terminal-window').boundingBox();
  expect(browser!.width).toBeGreaterThan(terminal!.width * 1.8);
  expect(browser!.x + browser!.width).toBeLessThan(terminal!.x);
  await page.evaluate(() => (window as any).canvasFeed.message({type:'update',canvas:{id:'doc',title:'A shared draft',content:'# Live canvas\n\nWriting alongside the terminal.',revision:1,status:'writing',active_call:'draft',updated_at:''}}));
  await expect(page.locator('.voice-stage')).toHaveAttribute('data-panels','2');
  await expect(page.locator('.voice-stage')).not.toHaveClass(/is-browsing/);
  await expect(page.getByLabel('Session canvas workspace')).toBeVisible();
  await settled(page);
  const canvasBox=await page.getByLabel('Session canvas workspace').boundingBox();
  const terminalBox=await page.locator('.voice-terminal-window').boundingBox();
  expect(canvasBox!.width).toBeGreaterThan(terminalBox!.width);
  expect(terminalBox!.x+terminalBox!.width).toBeLessThan(canvasBox!.x);
  await expect(page.locator('.voice-presence')).toHaveCSS('height','80px');
  await page.getByLabel('Show browser').click();
  await settled(page);
  const sideBrowser=await page.getByLabel('Live browser',{exact:true}).boundingBox();
  const sideCanvas=await page.getByLabel('Session canvas workspace').boundingBox();
  expect(sideBrowser!.x).toBeGreaterThanOrEqual(0);
  expect(sideCanvas!.x-sideBrowser!.x-sideBrowser!.width).toBeGreaterThan(0);
  expect(sideCanvas!.x-sideBrowser!.x-sideBrowser!.width).toBeLessThanOrEqual(20);
  await page.getByLabel('Minimize browser').click();
  await page.getByLabel('Show terminal').click();
  await page.getByLabel('Close canvas').click();
  await page.getByLabel('Show browser').click();

  await page.getByRole('button', { name: 'Minimize browser' }).click();
  await settled(page);
  const orb = await page.locator('.voice-presence').boundingBox();
  const right = await page.locator('.voice-terminal-window').boundingBox();
  const stage = await page.locator(".voice-stage").boundingBox();
  expect(orb!.x + orb!.width).toBeLessThan(right!.x);
  expect(orb!.height).toBeGreaterThan(150);
  await page.getByRole('button', { name: 'Finish terminal', exact: true }).click();
  await expect(page.getByLabel('Agent terminal output')).toContainText('Build completed successfully');
  await page.getByRole('button', { name: 'Show browser', exact: true }).click();
  await page.getByRole('button', { name: 'Stream thinking', exact: true }).click();
  await expect(page.getByLabel('Live model thinking')).toContainText('verify the page layout');
  await expect(page.locator('.voice-presence')).toHaveCSS('height', '80px');
  await page.setViewportSize({ width: 390, height: 844 });
  await settled(page);
  const mobileBrowser = await page.locator('.voice-browser-window').boundingBox();
  const mobileTerminal = await page.locator('.voice-terminal-window').boundingBox();
  expect(mobileBrowser!.y + mobileBrowser!.height).toBeLessThan(mobileTerminal!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.getByRole('button', { name: 'End voice mode' }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  expect(failures).toEqual([]);
});

test('managed voice connects before listening and releases its lease on End',async({page})=>{
 const leases:boolean[]=[];
 await page.route('**/api/voice',r=>r.fulfill({json:{enabled:true,managed:true,lazyLoad:true}}));
 await page.route('**/api/sessions/test/voice/connection',r=>{leases.push(r.request().postDataJSON().active);return r.fulfill({json:{managed:true}});});
 await page.goto('/tests/voice.html');
 await page.getByRole('button',{name:'Turn on hands-free voice'}).click();
 await expect(page.getByRole('status')).toHaveText('Listening',{timeout:25000});
 expect(leases).toEqual([true]);
 await page.getByRole('button',{name:'End voice mode'}).click();
 await expect.poll(()=>leases).toEqual([true,false]);
});

test('ending while the managed model loads releases the connection and never starts listening',async({page})=>{
 let finishLoad!:()=>Promise<void>; const leases:boolean[]=[];
 await page.route('**/api/voice',r=>r.fulfill({json:{enabled:true,managed:true}}));
 await page.route('**/api/sessions/test/voice/connection',async r=>{
  const active=r.request().postDataJSON().active;leases.push(active);
  if(active){finishLoad=()=>r.fulfill({json:{managed:true}});return;}
  await r.fulfill({json:{managed:true}});
 });
 await page.goto('/tests/voice.html');await page.getByRole('button',{name:'Turn on hands-free voice'}).click();
 await expect.poll(()=>leases).toEqual([true]);
 await page.getByRole('button',{name:'End voice mode'}).click();
 await expect.poll(()=>leases).toEqual([true,false]);await finishLoad();
 await expect(page.getByRole('button',{name:'Turn on hands-free voice'})).toBeVisible();
 await expect(page.getByLabel('Voice conversation')).toHaveCount(0);
});


test('prompt and compaction progress remain visible in chat and voice',async({page})=>{
 await page.route('**/api/voice',r=>r.fulfill({json:{enabled:true}}));
 await page.route('**/voice/speech',r=>r.fulfill({body:sample,contentType:'audio/wav'}));
 await page.goto('/tests/voice.html');
 await page.getByRole('button',{name:'Show prefill',exact:true}).click();
 // In the chat it is the status pill, there at once like the other phases rather than after two seconds.
 await expect(page.getByRole('progressbar',{name:'Prompt processing'})).toHaveAttribute('aria-valuenow','40');
 await expect(page.getByRole('progressbar',{name:'Prompt processing'})).toHaveAttribute('aria-valuetext','40% — 16,000 / 40,000 tokens · 8,000 from cache');
 await page.getByRole('button',{name:'Turn on hands-free voice'}).click();
 await expect(page.locator('.voice-stage').getByRole('progressbar',{name:'Prompt processing'})).toBeVisible({timeout:25000});
 await page.getByRole('button',{name:'Start compaction',exact:true}).click();
 const bar=page.locator('.voice-stage').getByRole('progressbar',{name:'Conversation compaction'});
 await expect(bar).toBeVisible();await expect(bar).not.toHaveAttribute('aria-valuenow');
 await page.getByRole('button',{name:'End compaction',exact:true}).click();
 await expect(bar).toHaveCount(0);
 await page.getByRole('button',{name:'End voice mode'}).click();
});

test('composer offers send beside stop for a follow-up and canvas lives in the header',async({page})=>{
 await page.goto('/tests/voice.html');
 const input=page.locator('textarea').first();
 await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Stream reply',exact:true}).click();
 await expect(page.getByRole('button',{name:'Stop generation',exact:true})).toBeVisible();
 await input.fill('Change direction');
 // Stop stays while a follow-up is written: steering and stopping are both still open.
 await expect(page.getByRole('button',{name:'Stop generation',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect(page.getByTestId('sent')).toHaveText('1');
 await expect(page.getByRole('button',{name:'Stop generation',exact:true})).toBeVisible();
 await input.fill('   ');
 await page.getByRole('button',{name:'Stop generation',exact:true}).click();
 await expect(page.getByTestId('aborted')).toHaveText('1');
 await expect(page.locator('.session-workspace > header').getByRole('button',{name:'Session canvases',exact:true})).toBeVisible();
});

test('without speech synthesis voice mode is not offered, because it speaks its replies, and dictation, which only listens, is', async ({ page }) => {
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true, speech: false } }));
  await page.goto('/tests/voice.html');
  await expect(page.getByRole('button', { name: 'Dictate a message' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  // With speech both are there.
  await page.unroute('**/api/voice');
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true, speech: true } }));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Dictate a message' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toBeVisible();
});

test('a filler plays right after the turn, is not the same one twice running, and gives way to the answer without overlap', async ({ page }) => {
  const failures: string[] = []; page.on('pageerror', e => failures.push(e.message));
  const tone = (seconds: number) => {
    const bytes = Buffer.alloc(Math.round(24000 * seconds) * 2);
    for (let i = 0; i < bytes.length / 2; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 330 / 24000) * 3000), i * 2);
    return bytes;
  };
  // Told apart by length: two fillers and a reply.
  const clips = [tone(0.7), tone(0.9)];
  let answerAfter = 1500;
  await page.addInitScript(() => {
    const log: { e: string; duration?: number; at: number }[] = []; (window as any).audioLog = log;
    const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (...args) { log.push({ e: 'start', duration: this.buffer?.duration, at: performance.now() }); return start.apply(this, args); };
    // When it ends, not when it was told to: a stop is scheduled on the audio clock.
    AudioBufferSourceNode.prototype.stop = function (when?: number) { log.push({ e: 'stop', duration: this.buffer?.duration, at: performance.now() + Math.max(0, ((when ?? 0) - this.context.currentTime) * 1000) }); return stop.call(this, when); };
  });
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.route('**/voice/transcribe', route => route.fulfill({ json: { text: 'A test voice turn.' } }));
  await page.route(/\/voice\/fillers(\?.*)?$/, route => route.fulfill({ json: { key: 'k', clips: [0, 1], rendering: false } }));
  await page.route('**/voice/fillers/k/*', route => route.fulfill({ body: clips[Number(new URL(route.request().url()).pathname.split('/').pop())], headers: { 'content-type': 'audio/pcm' } }));
  await page.route('**/voice/speech', async route => {
    await new Promise(resolve => setTimeout(resolve, answerAfter));
    await route.fulfill({ body: tone(3), headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000' } });
  });
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  const sounds = () => page.evaluate(() => ((window as any).audioLog as { e: string; duration?: number; at: number }[]).filter(x => x.e === 'send' || [0.7, 0.9, 3].includes(Math.round((x.duration ?? 0) * 10) / 10)));
  type Entry = { e: string; duration?: number; at: number };
  const starts = async () => (await sounds()).filter(x => x.e === 'start');
  // Turn one: the answer takes a while, and the filler plays out in front of it.
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 12000 });
  await expect.poll(async () => (await starts()).length, { timeout: 8000 }).toBe(2);
  let log = await sounds() as Entry[];
  const [first, answer] = log.filter(x => x.e === 'start');
  assert(first.duration! < 1 && answer.duration === 3);
  // Played the moment the turn is taken, with the send not yet through and the answer some time off.
  const sent = log.find(x => x.e === 'send')!;
  expect(Math.abs(first.at - sent.at)).toBeLessThan(250);
  expect(answer.at - first.at).toBeGreaterThan(first.duration! * 1000);
  expect(log.some(x => x.e === 'stop' && x.duration === first.duration)).toBe(false);
  // Turn two: said over the answer, which is ready almost at once, while the next filler is still playing.
  answerAfter = 100;
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.getByTestId('sent')).toHaveText('2', { timeout: 12000 });
  await expect.poll(async () => (await starts()).length, { timeout: 8000 }).toBe(4);
  log = await sounds() as Entry[];
  const [, , second, answerTwo] = log.filter(x => x.e === 'start');
  expect(second.duration).not.toBe(first.duration);
  const cut = log.find(x => x.e === 'stop' && x.duration === second.duration);
  expect(cut, 'the filler was cut when the answer came').toBeTruthy();
  // The answer starts once the filler has faded out, never over it.
  expect(cut!.at).toBeLessThan(second.at + second.duration! * 1000);
  expect(answerTwo.at).toBeGreaterThanOrEqual(cut!.at - 15);
  await page.getByRole('button', { name: 'End voice mode' }).click();
  expect(failures).toEqual([]);
});

test('a long wait is filled again, with a different filler after a pause, and stops once the answer is audible', async ({ page }) => {
  test.setTimeout(60000);
  const failures: string[] = []; page.on('pageerror', e => failures.push(e.message));
  const tone = (seconds: number) => {
    const bytes = Buffer.alloc(Math.round(24000 * seconds) * 2);
    for (let i = 0; i < bytes.length / 2; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 330 / 24000) * 3000), i * 2);
    return bytes;
  };
  // Told apart by length: three fillers and a reply.
  const clips = [tone(0.7), tone(0.9), tone(1.1)];
  await page.addInitScript(() => {
    const log: { e: string; duration?: number; at: number }[] = []; (window as any).audioLog = log;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) { log.push({ e: 'start', duration: this.buffer?.duration, at: performance.now() }); return start.apply(this, args); };
  });
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.route('**/voice/transcribe', route => route.fulfill({ json: { text: 'A test voice turn.' } }));
  await page.route(/\/voice\/fillers(\?.*)?$/, route => route.fulfill({ json: { key: 'k', clips: [0, 1, 2], rendering: false } }));
  await page.route('**/voice/fillers/k/*', route => route.fulfill({ body: clips[Number(new URL(route.request().url()).pathname.split('/').pop())], headers: { 'content-type': 'audio/pcm' } }));
  // The answer takes long: the first filler, a pause of about five seconds (the default), a second, and then the answer comes before a third is due.
  await page.route('**/voice/speech', async route => {
    await new Promise(resolve => setTimeout(resolve, 9000));
    await route.fulfill({ body: tone(3), headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000' } });
  });
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  type Entry = { e: string; duration?: number; at: number };
  const starts = async () => (await page.evaluate(() => (window as any).audioLog as Entry[])).filter(x => x.e === 'start' && [0.7, 0.9, 1.1, 3].includes(Math.round((x.duration ?? 0) * 10) / 10));
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 12000 });
  await expect.poll(async () => (await starts()).length, { timeout: 15000 }).toBe(3);
  const [first, second, answer] = await starts();
  expect(first.duration).not.toBe(second.duration);
  // After the first has ended, a pause of five seconds, give or take a fifth: not a second on top of it, not silence for good.
  const pause = second.at - (first.at + first.duration! * 1000);
  expect(pause).toBeGreaterThan(3500); expect(pause).toBeLessThan(6500);
  expect(answer.duration).toBe(3);
  // The answer does not start over a filler, and no filler follows it, although the next would be due while it plays.
  expect(answer.at).toBeGreaterThanOrEqual(second.at + second.duration! * 1000 - 15);
  await page.waitForTimeout(4000);
  expect((await starts()).length).toBe(3);
  await page.getByRole('button', { name: 'End voice mode' }).click();
  expect(failures).toEqual([]);
});

test('fillers are switched off in the voice settings or with Shift+F, and are not offered where the portal has none', async ({ page }) => {
  let listed = 0; let config: object = { enabled: true };
  await page.route('**/api/voice', route => route.fulfill({ json: config }));
  await page.route(/\/voice\/fillers(\?.*)?$/, route => { listed++; return route.fulfill({ json: { key: '', clips: [], rendering: false } }); });
  const open = async () => {
    await page.goto('/tests/voice.html');
    await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
    await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
    await page.getByRole('button', { name: 'Voice settings' }).click();
    return page.getByRole('dialog', { name: 'Voice settings' });
  };
  // Voice mode is left on a page that is reloaded, and would come back by itself.
  const close = async () => { await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'End voice mode' }).click(); };
  let card = await open();
  const fillers = card.getByRole('group', { name: 'Fillers' });
  await expect(fillers.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
  expect(listed).toBe(1);
  await fillers.getByRole('button', { name: 'Off' }).click();
  expect(await page.evaluate(() => localStorage.getItem('voiceFillers'))).toBe('off');
  await expect(card.getByText('Nothing is said until the answer starts.')).toBeVisible();
  await page.keyboard.press('Escape');
  // On again, from the keyboard: the portal is asked for them again.
  await page.keyboard.press('Shift+F');
  await expect.poll(() => listed).toBe(2);
  expect(await page.evaluate(() => localStorage.getItem('voiceFillers'))).toBe('on');
  await page.getByRole('button', { name: 'End voice mode' }).click();
  // Kept off, nothing is asked for at all.
  await page.evaluate(() => localStorage.setItem('voiceFillers', 'off'));
  listed = 0;
  card = await open();
  await expect(card.getByRole('group', { name: 'Fillers' }).getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
  expect(listed).toBe(0);
  await close();
  await page.evaluate(() => localStorage.removeItem('voiceFillers'));
  // Status speech off on the portal, or the sequential baseline: no such setting, and nothing asked for.
  for (const off of [{ statusSpeech: false }, { pipelineMode: 'sequential' }]) {
    config = { enabled: true, ...off }; listed = 0;
    card = await open();
    await expect(card.getByRole('group', { name: 'Sound effects' })).toBeVisible();
    await expect(card.getByRole('group', { name: 'Fillers' })).toHaveCount(0);
    expect(listed, JSON.stringify(off)).toBe(0);
    await close();
  }
});

test('the filler timing is set in the voice settings, kept in this browser, and read back as numbers within their limits', async ({ page }) => {
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route(/\/voice\/fillers(\?.*)?$/, route => route.fulfill({ json: { key: '', clips: [], rendering: false } }));
  const open = async () => {
    await page.goto('/tests/voice.html');
    await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
    await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
    await page.getByRole('button', { name: 'Voice settings' }).click();
    return page.getByRole('dialog', { name: 'Voice settings' }).getByRole('group', { name: 'Filler timing' });
  };
  const close = async () => { await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'End voice mode' }).click(); };
  const shown = (timing: ReturnType<typeof page.locator>) => Promise.all(['First filler after', 'Time between fillers', 'Randomness', 'Most per wait'].map(name => timing.getByRole('slider', { name }).getAttribute('aria-valuetext')));
  let timing = await open();
  // What it was before there was a setting: the first filler at once, and a long wait filled for a good while.
  expect(await shown(timing)).toEqual(['At once', '5 s', '20 %', '8']);
  await timing.getByRole('slider', { name: 'First filler after' }).fill('2');
  await timing.getByRole('slider', { name: 'Time between fillers' }).fill('3.5');
  await timing.getByRole('slider', { name: 'Randomness' }).fill('0');
  await timing.getByRole('slider', { name: 'Most per wait' }).fill('3');
  expect(await shown(timing)).toEqual(['2 s', '3.5 s', '0 %', '3']);
  expect(await page.evaluate(() => ['voiceFillerFirst', 'voiceFillerEvery', 'voiceFillerRandomness', 'voiceFillerMax'].map(key => localStorage.getItem(key)))).toEqual(['2', '3.5', '0', '3']);
  await close();
  // Kept: it is what the next call opens with.
  timing = await open();
  expect(await shown(timing)).toEqual(['2 s', '3.5 s', '0 %', '3']);
  await close();
  // What is in storage is anyone's to change: a number out of range is brought into it, what is not a number is the default.
  await page.evaluate(() => { localStorage.setItem('voiceFillerFirst', '-3'); localStorage.setItem('voiceFillerEvery', 'abc'); localStorage.setItem('voiceFillerRandomness', '7'); localStorage.setItem('voiceFillerMax', '99.4'); });
  timing = await open();
  expect(await shown(timing)).toEqual(['At once', '5 s', '100 %', '20']);
  // Off takes them away with the rest.
  await page.getByRole('dialog', { name: 'Voice settings' }).getByRole('group', { name: 'Fillers' }).getByRole('button', { name: 'Off' }).click();
  await expect(page.getByRole('group', { name: 'Filler timing' })).toHaveCount(0);
  await page.evaluate(() => { for (const key of ['voiceFillers', 'voiceFillerFirst', 'voiceFillerEvery', 'voiceFillerRandomness', 'voiceFillerMax']) localStorage.removeItem(key); });
  await close();
});

test('the filler timing that was set is the one the call keeps: the first filler after its time, then the set gap, no more than the most', async ({ page }) => {
  test.setTimeout(60000);
  const failures: string[] = []; page.on('pageerror', e => failures.push(e.message));
  const tone = (seconds: number) => {
    const bytes = Buffer.alloc(Math.round(24000 * seconds) * 2);
    for (let i = 0; i < bytes.length / 2; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 330 / 24000) * 3000), i * 2);
    return bytes;
  };
  const clips = [tone(0.7), tone(0.9), tone(1.1)];
  await page.addInitScript(() => {
    const log: { e: string; duration?: number; at: number }[] = []; (window as any).audioLog = log;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) { log.push({ e: 'start', duration: this.buffer?.duration, at: performance.now() }); return start.apply(this, args); };
  });
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.route('**/voice/transcribe', route => route.fulfill({ json: { text: 'A test voice turn.' } }));
  await page.route(/\/voice\/fillers(\?.*)?$/, route => route.fulfill({ json: { key: 'k', clips: [0, 1, 2], rendering: false } }));
  await page.route('**/voice/fillers/k/*', route => route.fulfill({ body: clips[Number(new URL(route.request().url()).pathname.split('/').pop())], headers: { 'content-type': 'audio/pcm' } }));
  await page.route('**/voice/speech', async route => {
    await new Promise(resolve => setTimeout(resolve, 12000));
    await route.fulfill({ body: tone(3), headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000' } });
  });
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  // Set in the card of the running call: two seconds to the first, three between, no randomness, two at most.
  await page.getByRole('button', { name: 'Voice settings' }).click();
  const timing = page.getByRole('dialog', { name: 'Voice settings' }).getByRole('group', { name: 'Filler timing' });
  await timing.getByRole('slider', { name: 'First filler after' }).fill('2');
  await timing.getByRole('slider', { name: 'Time between fillers' }).fill('3');
  await timing.getByRole('slider', { name: 'Randomness' }).fill('0');
  await timing.getByRole('slider', { name: 'Most per wait' }).fill('2');
  await page.keyboard.press('Escape');
  type Entry = { e: string; duration?: number; at: number };
  const sounds = async () => (await page.evaluate(() => (window as any).audioLog as Entry[])).filter(x => x.e === 'send' || (x.e === 'start' && [0.7, 0.9, 1.1, 3].includes(Math.round((x.duration ?? 0) * 10) / 10)));
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 12000 });
  await expect.poll(async () => (await sounds()).filter(x => x.e === 'start').length, { timeout: 25000 }).toBe(3);
  const log = await sounds();
  const sent = log.find(x => x.e === 'send')!;
  const [first, second, answer] = log.filter(x => x.e === 'start');
  // Not at once: after the two seconds.
  expect(first.at - sent.at).toBeGreaterThan(1700); expect(first.at - sent.at).toBeLessThan(3000);
  // Then the set three seconds after the first has ended, exactly, as there is no randomness.
  const gap = second.at - (first.at + first.duration! * 1000);
  expect(gap).toBeGreaterThan(2800); expect(gap).toBeLessThan(3400);
  expect(first.duration).not.toBe(second.duration);
  // The most is two, and the third that would have been due before the answer never comes.
  expect(answer.duration).toBe(3);
  await page.waitForTimeout(1500);
  expect((await sounds()).filter(x => x.e === 'start').length).toBe(3);
  await page.getByRole('button', { name: 'End voice mode' }).click();
  await page.evaluate(() => { for (const key of ['voiceFillerFirst', 'voiceFillerEvery', 'voiceFillerRandomness', 'voiceFillerMax']) localStorage.removeItem(key); });
  expect(failures).toEqual([]);
});

test('a time between fillers changed during a wait applies to the gap that is running, and not only to the ones after it', async ({ page }) => {
  test.setTimeout(60000);
  const tone = (seconds: number) => {
    const bytes = Buffer.alloc(Math.round(24000 * seconds) * 2);
    for (let i = 0; i < bytes.length / 2; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 330 / 24000) * 3000), i * 2);
    return bytes;
  };
  const clips = [tone(0.7), tone(0.9), tone(1.1)];
  await page.addInitScript(() => {
    const log: { e: string; duration?: number; at: number }[] = []; (window as any).audioLog = log;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) { log.push({ e: 'start', duration: this.buffer?.duration, at: performance.now() }); return start.apply(this, args); };
    // Thirty seconds between fillers, and no randomness: the second would come half a minute after the first.
    localStorage.setItem('voiceFillerEvery', '30'); localStorage.setItem('voiceFillerRandomness', '0');
  });
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.route('**/voice/transcribe', route => route.fulfill({ json: { text: 'A test voice turn.' } }));
  await page.route(/\/voice\/fillers(\?.*)?$/, route => route.fulfill({ json: { key: 'k', clips: [0, 1, 2], rendering: false } }));
  await page.route('**/voice/fillers/k/*', route => route.fulfill({ body: clips[Number(new URL(route.request().url()).pathname.split('/').pop())], headers: { 'content-type': 'audio/pcm' } }));
  await page.route('**/voice/speech', async route => {
    await new Promise(resolve => setTimeout(resolve, 20000));
    await route.fulfill({ body: tone(3), headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000' } });
  });
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  type Entry = { e: string; duration?: number; at: number };
  const fillers = async () => (await page.evaluate(() => (window as any).audioLog as Entry[])).filter(x => x.e === 'start' && [0.7, 0.9, 1.1].includes(Math.round((x.duration ?? 0) * 10) / 10));
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect.poll(async () => (await fillers()).length, { timeout: 15000 }).toBe(1);
  await page.waitForTimeout(1500);
  // The long gap is running. Changed to two seconds, the filler that was due in half a minute is due by the new time.
  await page.getByRole('button', { name: 'Voice settings' }).click();
  await page.getByRole('dialog', { name: 'Voice settings' }).getByRole('group', { name: 'Filler timing' }).getByRole('slider', { name: 'Time between fillers' }).fill('2');
  const changed = await page.evaluate(() => performance.now());
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await fillers()).length, { timeout: 8000 }).toBe(2);
  const [first, second] = await fillers();
  expect(second.at - changed).toBeLessThan(3500);
  expect(second.at).toBeGreaterThan(first.at + first.duration! * 1000);
  await page.getByRole('button', { name: 'End voice mode' }).click();
  await page.evaluate(() => { localStorage.removeItem('voiceFillerEvery'); localStorage.removeItem('voiceFillerRandomness'); });
});

test('switching fillers off stops asking the portal for them, which is what has it stop making them', async ({ page }) => {
  let listed = 0, released = 0; const looks: string[] = [];
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/voice/fillers/stop', route => { released++; return route.fulfill({ status: 204 }); });
  // The portal is still making them: the page looks again every few seconds.
  await page.route(/\/voice\/fillers(\?.*)?$/, route => { listed++; looks.push(route.request().url()); return route.fulfill({ json: { key: 'a'.repeat(40), clips: [], rendering: true } }); });
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  await expect.poll(() => listed, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
  expect(looks.some(url => url.includes('busy'))).toBe(false);
  // With the agent at work, every look says so: the portal starts no clip while an answer is on its way.
  await page.getByRole('button', { name: 'Stream reply' }).click();
  await expect.poll(() => looks.at(-1), { timeout: 8000 }).toContain('busy=1');
  await page.getByRole('button', { name: 'Voice settings' }).click();
  await page.getByRole('dialog', { name: 'Voice settings' }).getByRole('group', { name: 'Fillers' }).getByRole('button', { name: 'Off' }).click();
  // Off tells the portal, which would otherwise go on making them for a while, and the page stops asking.
  await expect.poll(() => released).toBe(1);
  const asked = listed;
  await page.waitForTimeout(3800);
  expect(listed).toBe(asked);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'End voice mode' }).click();
});

test('ending voice mode tells the portal that nobody is waiting for the fillers', async ({ page }) => {
  let released = 0;
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/voice/fillers/stop', route => { released++; return route.fulfill({ status: 204 }); });
  await page.route(/\/voice\/fillers(\?.*)?$/, route => route.fulfill({ json: { key: 'a'.repeat(40), clips: [], rendering: true } }));
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  expect(released).toBe(0);
  await page.getByRole('button', { name: 'End voice mode' }).click();
  await expect.poll(() => released).toBe(1);
});

test('dictation in send mode sends what was said to the chat it was started in', async ({ page }) => {
  const asked: string[] = [];
  await page.addInitScript(() => localStorage.setItem('dictationMode', 'send'));
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.route('**/voice/transcribe', route => { asked.push(new URL(route.request().url()).pathname); return route.fulfill({ json: { text: 'A dictated sentence.' } }); });
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Dictate a message' }).click();
  await expect(page.getByRole('button', { name: 'Stop dictating' })).toBeVisible({ timeout: 25000 });
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 15000 });
  await expect(page.getByTestId('last-send')).toContainText('A dictated sentence.');
  expect(asked.at(-1)).toBe('/api/sessions/test/voice/transcribe');
});

test('a sentence being dictated when another chat is opened is not sent to that chat', async ({ page }) => {
  const asked: string[] = [];
  await page.addInitScript(() => localStorage.setItem('dictationMode', 'send'));
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.route('**/voice/transcribe', route => { asked.push(new URL(route.request().url()).pathname); return route.fulfill({ json: { text: 'A dictated sentence.' } }); });
  // The chat switched to answers as the one the page starts in does.
  await page.route('**/api/sessions/other/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/sessions/other/canvases', route => route.fulfill({ json: [] }));
  await page.route('**/api/sessions/other/config', route => route.fulfill({ status: 503, json: {} }));
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Dictate a message' }).click();
  await expect(page.getByRole('button', { name: 'Stop dictating' })).toBeVisible({ timeout: 25000 });
  await page.getByRole('button', { name: 'Inject speech' }).click();
  // Mid-sentence: heard, not yet ended by a pause.
  await expect(page.getByText('Hearing you')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Switch chat' }).click();
  // The sentence is not to be sent to the chat it was not started in, which only waiting for as long as a send takes shows.
  await page.waitForTimeout(2500);
  await expect(page.getByTestId('sent')).toHaveText('0');
  expect(asked.filter(path => path.includes('/other/'))).toEqual([]);
});

test('a refused microphone says how to allow it, in dictation and in voice mode, not the browser\'s "Permission denied"', async ({ page }) => {
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.goto('/tests/voice.html');
  await page.evaluate(() => { (window as any).micFails = 'NotAllowedError'; });
  await page.getByRole('button', { name: 'Dictate a message' }).click();
  await expect(page.getByRole('alert')).toContainText('The microphone is blocked for this site');
  await expect(page.getByRole('alert')).not.toContainText('Permission denied');
  await page.reload();
  await page.evaluate(() => { (window as any).micFails = 'NotFoundError'; });
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('alert')).toContainText('No microphone was found');
});
