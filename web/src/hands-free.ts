import { SpeechPipeline, type PreparedSpeech } from "./speech-pipeline";
import type { Item } from "./transcript";
import { StreamingSpeech } from "./voice";
import { language, t } from "./i18n";
import { notice, type Notice } from "./voice-notices";
import { FILLER_PACING, fillerGap, type FillerPacing } from "./voice-fillers";

/** The longest the answer waits for a filler to stop: a fade-out takes a few milliseconds, and this is for a player that never reports back. */
const FILLER_STOP_MS = 150;
/**
 * The silence after a turn, while it is being filled: how many fillers have been
 * tried, whether one was played, when the filler before it ended (if nothing else
 * was heard since), and the timer of the next with what it waits for, since when and
 * the random position of its gap (drawn once, so that a setting changed meanwhile
 * moves the gap and does not draw it again).
 */
interface Silence { tries: number; played: boolean; dropped?: boolean; after?: number; timer?: ReturnType<typeof setTimeout>; pending?: { first: boolean; since: number; random: number } }
export type VoicePhase = "Listening" | "Hearing you" | "Transcribing" | "Thinking" | "Compacting context" | "Speaking";
export interface VoiceIO {
  sequential?: boolean;
  sentenceChunks?: boolean;
  ttsPrefetch?: boolean;
  statusSpeech?: boolean;
  /** The language the voice speaks, as its setting names it ("de"), or "auto": what the spoken notices are in. */
  speechLanguage?: () => string | undefined;
  transcribe: (samples: Float32Array, signal: AbortSignal) => Promise<string>;
  send: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  /** Handles what was said on the page instead of sending it, when it is for the page ("say that again"). */
  command?: (text: string) => boolean;
  /** Whether what has been heard so far could still turn out to be for the page. */
  couldBeCommand?: (partial: string) => boolean;
  /** True when speaking mid-run should add to the run rather than stop it. */
  steering?: () => boolean;
  agentRunning: () => boolean;
  synthesize: (text: string, signal: AbortSignal, kind?:'reply'|'status') => Promise<PreparedSpeech>;
  /**
   * Plays a filler: a short sound for the silence after a turn is sent. Resolves
   * when it has ended or `signal` cut it off. Nothing to play (switched off, no
   * clip ready) is returning nothing; that is no error. `wait` names the silence
   * it is for, the same for every filler of one, so that a wait gets different ones.
   */
  filler?: (signal: AbortSignal, wait: object) => Promise<void> | undefined;
  /** Whether something else is being played on the page, outside the pipeline (a repeat of the last reply): a filler that comes due then waits another gap. */
  playing?: () => boolean;
  /** How the silence is filled, read each time it matters, so that a setting changed in the middle of a call applies at once (`pacingChanged` is for what is pending): `FILLER_PACING` unless set. */
  fillerPacing?: FillerPacing;
  trace?: (name:string)=>void;
  phase: (phase: VoicePhase) => void;
  error: (message: string) => void;
}

/** Coordinates microphone turns independently of React renders and network timing. */
export class HandsFreeVoice {
  private alive = true;
  private hearing = false;
  private muted = false;
  private inputGeneration = 0;
  private acceptingReplies = true;
  /**
   * While what is being said is not yet known to be for the agent: the reply
   * it cut off, and what the agent has written since. Spoken after all when
   * it turns out to be a cough, a press taken back, or a page command; dropped
   * only once it goes to the agent.
   */
  private held: string[] | null = null;
  private items: Item[] = [];
  private speech: StreamingSpeech;
  private recordings: Float32Array[] = [];
  private text: string[] = [];
  private processing = false;
  private output: string[] = [];
  private pipeline: SpeechPipeline;
  private compacting = false;
  private compactionSpeech = false;
  private lastCompactionWaitAt = -Infinity;
  private transcription = new AbortController();
  private operations: Promise<void> = Promise.resolve();
  private sending = false;
  /** The run going when this utterance began has already been told to stop. */
  private stopped = false;
  /** The filler being played, while it plays. */
  private filler?: { controller: AbortController; done: Promise<void> };
  /** When the last filler ended, as long as nothing else has been heard since: the next turn's first one is not on top of it. */
  private filledAt?: number;
  private silence?: Silence;
  /** The wait that speech cut short, until it turns out whether that speech was a turn: when it was not (noise, a press taken back, a page command) the wait goes on. */
  private interrupted?: Silence;

  constructor(private io: VoiceIO, initial: Item[]) {
    const afterSeq = initial.reduce((n, item) => Math.max(n, Number(item.id.slice(1)) || 0), 0);
    this.pipeline = new SpeechPipeline((text, signal, kind) => this.prepare(text, signal, kind), () => this.state(), error => this.report(error), io.sequential, io.sentenceChunks, io.ttsPrefetch);
    this.speech = new StreamingSpeech(afterSeq);
    this.items = initial;
    this.ignoreCurrent();
    io.phase("Listening");
  }
  private ignoreCurrent() {
    this.speech.ignore(this.items);
  }
  private report(error: unknown) {
    if (this.alive) this.io.error(error instanceof Error ? error.message : String(error));
  }
  private state() {
    if (!this.alive) return;
    const phase = this.hearing ? "Hearing you" : this.compacting ? "Compacting context" : this.processing && !this.sending ? "Transcribing" : this.pipeline.busy || this.filler ? "Speaking" : this.io.agentRunning() || this.sending ? "Thinking" : "Listening";
    this.io.phase(phase);
  }
  /**
   * Whatever is spoken next ends a filler first, and is what the next filler
   * waits for. The answer does not start until the filler has stopped, so the two
   * are never heard together, and it does not wait for it to finish either: a
   * filler stops within a few milliseconds of being told to.
   */
  private async prepare(text: string, signal: AbortSignal, kind?: 'reply' | 'status'): Promise<PreparedSpeech> {
    const prepared = await this.io.synthesize(text, signal, kind);
    return Object.assign(async (playback: AbortSignal) => {
      // Audible now: the silence is over, and no filler is to come after the answer has started.
      this.endSilence();
      await this.endFiller();
      playback.throwIfAborted();
      this.filledAt = undefined;
      await prepared(playback);
    }, { completed: prepared.completed });
  }
  /**
   * The turn has been taken, and until the agent has something to say there is
   * silence: this fills it, with a filler after the time the user set (at once
   * unless told otherwise), and then further ones, each a gap after the one before
   * has ended, until something else is heard (`FillerPacing`). Not while anything
   * else is going to be heard: the user is speaking, a notice is, or the answer
   * already is. Returns what was begun, for the turn to take back if it is not
   * sent after all.
   */
  private startFiller() {
    if (!this.alive || !this.io.filler || this.io.statusSpeech === false || this.io.sequential || this.filler) return;
    if (this.hearing || this.compacting || this.pipeline.busy || this.output.length) return;
    this.endSilence();
    const silence = this.silence = { tries: 0, played: false, after: this.filledAt };
    // One draw for the gap, decided on and waited by.
    const random = Math.random();
    if (this.due(silence, true, Date.now(), random) > 0) this.later(silence, true, random); else this.fill(silence);
    return silence;
  }
  /** One filler, now, or when there is none to play, the next try after a gap. */
  private fill(silence: Silence) {
    silence.tries++;
    const controller = new AbortController();
    let playing: Promise<void> | undefined;
    try { playing = this.io.filler!(controller.signal, silence); } catch { playing = undefined; }
    // Nothing to play yet (no clip is ready): clips may be, by the next try.
    if (!playing) return this.later(silence);
    silence.played = true;
    this.filledAt = Date.now();
    // A filler that fails is a filler not heard, not an error shown.
    const filler = { controller, done: playing.catch(() => {}).then(() => {
      if (this.filler === filler) { this.filler = undefined; this.state(); }
      // Not for a turn that was not sent after all: nothing was heard of it that the next turn must give way to.
      if (!silence.dropped) this.filledAt = Date.now();
      // Played to its end, not cut off by what ended the silence: the next comes after a gap.
      if (this.silence === silence && !controller.signal.aborted) this.later(silence);
    }) };
    this.filler = filler;
    this.state();
  }
  private pacing() { return this.io.fillerPacing ?? FILLER_PACING; }
  /**
   * Seconds from `since` until the next filler of this silence is due, by the
   * settings as they are now. The first of a turn comes after the time set for
   * it, and not on top of the one before it: when that ended less than a gap ago,
   * what is left of the gap is waited, and nothing when it was longer ago.
   */
  private due(silence: Silence, first: boolean, since: number, random: number) {
    const gap = fillerGap(this.pacing(), random);
    if (!first) return gap;
    const left = silence.after === undefined ? 0 : gap - (since - silence.after) / 1000;
    return Math.max(this.pacing().first, left);
  }
  /** The next try, a gap after the one before (`first`: the first of the turn, by its own time); none once there have been as many as a wait is to have. */
  private later(silence: Silence, first = false, random?: number) {
    if (silence.tries >= this.pacing().max) return this.endSilence(silence);
    silence.pending = { first, since: Date.now(), random: random ?? Math.random() };
    this.arm(silence);
  }
  private arm(silence: Silence) {
    const { first, since, random } = silence.pending!;
    clearTimeout(silence.timer);
    // What has passed since the wait began counts, for a timer that is set anew.
    const seconds = Math.max(0, this.due(silence, first, since, random) - (Date.now() - since) / 1000);
    silence.timer = setTimeout(() => {
      // Nothing is pending once it has fired: a setting changed while a filler plays has nothing to move.
      silence.timer = undefined; silence.pending = undefined;
      if (this.silence !== silence) return;
      // A lower most than when it was set: that many have been played.
      if (silence.tries >= this.pacing().max) return this.endSilence(silence);
      // There is nothing left to wait for: the user is speaking or a notice is being said, or the agent has finished without a word.
      // An answer that is being made into speech is not that, also when the run that wrote it has ended: until it is audible (see `prepare`) the silence goes on, and a first sentence can take seconds.
      if (!this.alive || this.hearing || this.compacting || this.filler || !this.io.filler || this.io.statusSpeech === false || !(this.io.agentRunning() || this.sending || this.pipeline.busy)) return this.endSilence(silence);
      // Something else is being played, a repeat of the last reply: not on top of it, but after another gap.
      if (this.io.playing?.()) return this.later(silence);
      this.fill(silence);
    }, seconds * 1000);
  }
  /**
   * The settings were changed: the filler that is due is due by the new ones, with
   * what has passed counted, and a most that has been reached ends the wait. What is
   * playing, or comes after it, reads them as it goes.
   */
  pacingChanged() {
    const silence = this.silence;
    if (!silence?.pending) return;
    if (silence.tries >= this.pacing().max) return this.endSilence(silence);
    this.arm(silence);
  }
  /**
   * Speech began a moment ago and was none for the agent: the wait it cut short
   * goes on, if the agent is still at work or its answer is on the way. Not at
   * once, as the user has just made a sound: after a gap. What was tried counts
   * towards the most, and the clips of the wait stay told apart.
   */
  private resumeSilence() {
    const silence = this.interrupted;
    this.interrupted = undefined;
    if (!silence || silence.dropped || !this.alive || this.hearing || this.compacting || this.silence || !this.io.filler || this.io.statusSpeech === false) return;
    if (!(this.io.agentRunning() || this.sending || this.pipeline.busy || this.output.length)) return;
    this.silence = silence;
    silence.timer = undefined; silence.after = this.filledAt;
    this.later(silence, silence.tries === 0);
  }
  /** The silence is over, or not to be filled any more: no filler is started for it again. */
  private endSilence(silence?: Silence | undefined) {
    if (silence && this.silence !== silence) return;
    clearTimeout(this.silence?.timer);
    this.silence = undefined;
  }
  /** The turn that began this is not going to be sent after all: its fillers are cut and not to come, and the next turn may have one at once. */
  private dropFiller(silence: Silence | undefined) {
    if (!silence) return;
    silence.dropped = true;
    this.endSilence(silence);
    this.filler?.controller.abort();
    if (silence.played) this.filledAt = undefined;
  }
  /** Tells the filler to stop, and returns once it has: a player that does not answer is not waited for, as the answer is worth more than a filler. */
  private async endFiller() {
    const filler = this.filler;
    if (!filler) return;
    filler.controller.abort();
    let timer!: ReturnType<typeof setTimeout>;
    await Promise.race([filler.done, new Promise<void>(resolve => { timer = setTimeout(resolve, FILLER_STOP_MS); })]);
    clearTimeout(timer);
  }
  /** A notice, in the language of the voice. */
  private say(kind: Notice) {
    const text = notice(kind, this.io.speechLanguage?.(), language());
    if (text) this.pipeline.enqueue([text], 'status');
  }
  setCompacting(active: boolean, completed = true) {
    if (!this.alive || active === this.compacting) return;
    this.compacting = active;
    this.endSilence();
    this.interrupted = undefined;
    this.filler?.controller.abort();
    if (this.io.statusSpeech === false || this.io.sequential) { this.state(); return; }
    if (active) {
      this.lastCompactionWaitAt = -Infinity;
      if (!this.hearing && this.acceptingReplies) this.say("compacting");
    } else this.say(completed ? "done" : "stopped");
    this.state();
  }
  observe(items: Item[]) {
    this.items = items;
    if (!this.alive) return;
    if (!this.acceptingReplies) { if (this.held) this.held.push(...this.speech.observe(items)); else this.ignoreCurrent(); }
    else if (!this.io.sequential || this.io.sentenceChunks || !this.io.agentRunning()) this.output.push(...this.speech.observe(items));
    this.state();
    void this.play();
  }
  /** Called after a sustained speech detection, not a single noise frame. */
  speechStart() {
    if (!this.alive || this.muted) return;
    if (this.compacting) {
      this.compactionSpeech = true;
      if (this.io.statusSpeech !== false && !this.io.sequential && Date.now() - this.lastCompactionWaitAt >= 8000) {
        this.lastCompactionWaitAt = Date.now();
        this.say("waiting");
      }
      return;
    }
    this.hearing = true;
    this.acceptingReplies = false;
    this.held = [...(this.held ?? []), ...this.pipeline.cancel(), ...this.output];
    this.output = [];
    // Talking over a filler is no turn for it to finish, nor for the ones after it. If the speech is none for the agent after all, the wait goes on (`resumeSilence`).
    if (this.silence) this.interrupted = this.silence;
    this.endSilence();
    this.filler?.controller.abort();
    // The run is stopped only once what was said turns out to be for the agent:
    // not a tap, not noise, not a command the page handles. See heard().
    this.state();
  }
  /**
   * What has been made out so far of what is being said. Once it is plainly
   * for the agent, a run it would stop is stopped now, not when the speaker is
   * done: "stop, don't touch that file" must not wait for the end of the sentence.
   */
  heard(partial: string) {
    if (!this.alive || this.muted || !this.hearing || this.stopped || this.compacting) return;
    if (!partial.trim() || this.io.couldBeCommand?.(partial) || this.io.steering?.() || !(this.io.agentRunning() || this.sending)) return;
    this.stopped = true;
    const generation = this.inputGeneration;
    // Serialized like the stop in process(), and a failed one is tried again there before anything is sent.
    this.operations = this.operations.then(async () => { if (this.alive && this.inputGeneration === generation) await this.io.abort(); })
      .catch(error => { this.stopped = false; this.report(error); });
  }
  /** Speech that began and is not going to be sent after all: a push-to-talk press too short to be words. */
  speechCancel() {
    if (!this.alive) return;
    // A press during compaction is over; the next thing said is heard again.
    this.compactionSpeech = false;
    if (!this.hearing) return;
    this.hearing = false;
    this.stopped = false;
    this.resumeReplies();
    this.state();
    void this.play();
    this.resumeSilence();
  }
  /** What was said is not going to the agent: the reply it held back is spoken after all. */
  private resumeReplies() {
    if (this.held) this.output = [...this.held, ...this.output];
    this.held = null;
    this.acceptingReplies = true;
  }
  speechEnd(samples: Float32Array) {
    if (!this.alive || this.muted) return;
    if (this.compacting || this.compactionSpeech) { this.compactionSpeech = false; return; }
    this.hearing = false;
    this.recordings.push(samples);
    void this.process();
  }
  private async process() {
    if (this.processing || !this.alive) return;
    const generation = this.inputGeneration;
    const valid = () => this.alive && this.inputGeneration === generation;
    this.processing = true;
    this.state();
    try {
      while (this.recordings.length && valid()) {
        const text = await this.io.transcribe(this.recordings.shift()!, this.transcription.signal);
        if (!valid()) return;
        if (text.trim()) this.text.push(text.trim());
      }
      // If speech resumes during transcription, retain the text and combine it
      // with the next segment instead of sending half a thought or losing it.
      if (this.hearing) return;
      if (!this.text.length) {
        // Nothing in it but noise: the run was not stopped, so what it says next is spoken.
        if (valid() && !this.recordings.length) { this.stopped = false; this.resumeReplies(); this.resumeSilence(); }
        return;
      }
      const text = this.text.join(" ");
      if (this.io.command?.(text)) {
        // For the page ("say that again") and handled there, not sent to the
        // agent. The interruption cut its reply off, so what was left unsaid is
        // spoken after all instead of dropped.
        this.text = [];
        this.stopped = false;
        this.resumeReplies();
        this.ignoreCurrent();
        this.resumeSilence();
        return;
      }
      // The turn is taken, and for the agent: from here on there is silence until
      // it speaks, and the filler is what fills it, from the clip already in hand.
      // Not after the run this turn interrupts has wound down: that is the gap it is for.
      this.interrupted = undefined;
      const silence = this.startFiller();
      // Serialize abort behind an in-flight send so it cannot miss that new run.
      // When steering, the run goes on and what is said is added to it. When it
      // was already stopped while this was being said, that is not done twice —
      // but whether it was is only known once that stop has settled.
      const busy = (this.io.agentRunning() || this.sending) && !this.io.steering?.();
      const send = this.operations.then(async () => {
        if (!valid() || this.hearing || this.recordings.length) return this.dropFiller(silence);
        if (busy && !this.stopped) {
          try { await this.io.abort(); } catch (error) { this.dropFiller(silence); throw error; }
          if (!valid() || this.hearing || this.recordings.length) return this.dropFiller(silence);
        }
        this.held = null;
        this.ignoreCurrent();
        this.acceptingReplies = true;
        this.sending = true;
        this.state();
        try {
          await this.io.send(text);
          if (valid()) { this.text = []; this.stopped = false; }
        } catch (error) {
          this.acceptingReplies = false;
          // The turn did not happen: the one said again may have a filler.
          this.filler?.controller.abort();
          this.dropFiller(silence);
          throw new Error(t("Could not send “{text}”: {error}", { text, error: error instanceof Error ? error.message : String(error) }));
        } finally { this.sending = false; }
      });
      this.operations = send;
      await send;
    } catch (error) {
      if (valid()) this.report(error);
      // A failed command is reported, but must not poison subsequent turns.
      this.operations = Promise.resolve();
    } finally {
      this.processing = false;
      this.state();
      if (this.alive && this.recordings.length) void this.process();
      else void this.play();
    }
  }
  private play() {
    if (!this.alive || this.hearing || !this.acceptingReplies || !this.output.length || (this.io.sequential && !this.io.sentenceChunks && this.io.agentRunning())) return;
    const text = this.output; this.output = [];
    this.io.trace?.('reply_chunk');
    this.pipeline.enqueue(text);
  }
  /** Mute is input-only: keep the agent and its spoken output running. */
  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) {
      this.inputGeneration++;
      this.hearing = false;
      this.recordings = [];
      this.text = [];
      this.stopped = false;
      this.transcription.abort();
      this.transcription = new AbortController();
      this.resumeReplies();
    }
    this.state();
    void this.play();
  }
  stop() {
    this.alive = false;
    this.endSilence();
    this.interrupted = undefined;
    this.filler?.controller.abort();
    this.pipeline.cancel();
    this.transcription.abort();
    this.output = [];
    this.held = null;
    this.recordings = [];
    this.text = [];
  }
}
