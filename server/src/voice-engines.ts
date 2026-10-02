/**
 * The speech engines the managed Voice service can run, in one place.
 *
 * The container spec, the setup script's environment, the health checks, the
 * settings the portal saves after an install and the choices the add-on page
 * offers all read this table, so an engine or a model size is added here once.
 * It has no node imports: the page uses it too.
 *
 * Speech synthesis needs a GPU. Speech recognition does not: Whisper always runs
 * on the CPU, and Qwen3-ASR runs on either, in an audio.cpp process of its own on
 * the CPU or next to the speech engine on the GPU. A host without a GPU can
 * therefore install recognition alone (`tts: "none"`), which is dictation but
 * no spoken replies. A model of another kind, such as an LLM that runs in the
 * same container later, is one more entry in `serverConfig` and one more
 * `vramMiB` in the sum; `reserveMiB` below keeps room for it in the meantime.
 */
export type TtsEngine = "breeze" | "chatterbox" | "kokoro";
/** `none`: no speech synthesis, only recognition. */
export type TtsChoice = TtsEngine | "none";
export type AsrEngine = "whisper" | "qwen3-asr";
export type AsrDevice = "cpu" | "gpu";
/**
 * What the managed container is built for: one speech engine and one recognition model.
 * `asrDevice` is only ever `cpu`, and only where the other device is possible (Qwen3-ASR
 * next to a speech engine on the GPU): everything else has one device, and a choice made
 * before the device could be chosen has none written.
 */
export interface VoiceChoice { tts: TtsChoice; asr: AsrEngine; asrModel: string; asrDevice?: AsrDevice }

/**
 * GPU memory in MiB, with the CUDA context included. These are estimates: Breeze is
 * the 4414 MiB measured for the audio.cpp process in the voice guide, the others
 * come from the size of their Q8_0 files plus the same kind of overhead, and
 * Chatterbox with Qwen3-ASR 1.7B was seen at about 5.5 GB together. Kokoro is an 82M
 * model of 181 MiB at Q8_0, so nearly all of its figure is the CUDA context.
 *
 * `cpuSecondsPerSecond` is what the engine costs on a CPU, measured on 8 threads of a
 * desktop CPU with the model already loaded: seconds of computing for each second of
 * speech. Far above 1 is no conversation, which is why speech synthesis is a GPU matter.
 * Kokoro is the exception, measured at about a quarter of a second, on audio.cpp v0.9.0.
 */
export const TTS_ENGINES: Record<TtsEngine, { label: string; vramMiB: number; cpuSecondsPerSecond: number }> = {
  breeze: { label: "Breeze", vramMiB: 4600, cpuSecondsPerSecond: 3.5 },
  chatterbox: { label: "Chatterbox", vramMiB: 3000, cpuSecondsPerSecond: 7 },
  kokoro: { label: "Kokoro", vramMiB: 1000, cpuSecondsPerSecond: 0.24 },
};

/**
 * Cheapest and weakest first: the last `recommended` one that fits is the one a suggestion picks.
 * `vramMiB` is the memory on a GPU (Whisper has none to give: it is CPU only) and `ramMiB` on the CPU,
 * where Whisper's are the figures whisper.cpp gives for its models. `cpuRealtime` is how many times
 * faster than the audio the model recognises on 8 threads of a desktop CPU (measured on 14 s of speech);
 * Whisper's is not measured, and a model without one is never called slow.
 */
export const ASR_MODELS: readonly { asr: AsrEngine; model: string; label: string; vramMiB: number; ramMiB: number; cpuRealtime?: number; recommended: boolean }[] = [
  { asr: "whisper", model: "base", label: "Whisper base", vramMiB: 0, ramMiB: 400, recommended: true },
  { asr: "whisper", model: "small", label: "Whisper small", vramMiB: 0, ramMiB: 900, recommended: false },
  { asr: "qwen3-asr", model: "0.6b", label: "Qwen3-ASR 0.6B", vramMiB: 1400, ramMiB: 1600, cpuRealtime: 5.4, recommended: true },
  { asr: "qwen3-asr", model: "1.7b", label: "Qwen3-ASR 1.7B", vramMiB: 2600, ramMiB: 3000, cpuRealtime: 2.6, recommended: true },
];
/** Threads the CPU figures above were measured on. */
export const MEASURED_THREADS = 8;
/** How many times faster than the audio recognition should be before a suggestion picks it for a CPU. */
const COMFORTABLE = 4;

/** The combination the installer has always made. A container without a recipe label is this one. */
export const DEFAULT_CHOICE: VoiceChoice = { tts: "breeze", asr: "whisper", asrModel: "base" };

export const SPEECH_PORT = 7862;
export const WHISPER_PORT = 8188;
/** Qwen3-ASR on the CPU is an audio.cpp process of its own, so that the GPU one stays the speech engine's. */
export const ASR_CPU_PORT = 7863;
export const speechUrl = `http://127.0.0.1:${SPEECH_PORT}/v1/audio/speech`;
export const whisperUrl = `http://127.0.0.1:${WHISPER_PORT}/inference`;

export const asrOption = (choice: Pick<VoiceChoice, "asr" | "asrModel">) =>
  ASR_MODELS.find((o) => o.asr === choice.asr && o.model === choice.asrModel);

/** Does the choice need a GPU: a speech engine, or recognition that is put on it. */
export const usesGpu = (c: VoiceChoice) => c.tts !== "none" || asrDevice(c) === "gpu";
/**
 * Where recognition runs. Whisper and anything without a GPU runs on the CPU; Qwen3-ASR
 * next to a speech engine runs on the GPU unless the choice says it is put on the CPU.
 */
export function asrDevice(c: VoiceChoice): AsrDevice {
  return c.asr === "whisper" || c.tts === "none" || c.asrDevice === "cpu" ? "cpu" : "gpu";
}
/** The devices the page may offer for the recognition of a choice. */
export const asrDevices = (c: Pick<VoiceChoice, "tts" | "asr">): readonly AsrDevice[] => c.asr === "qwen3-asr" && c.tts !== "none" ? ["cpu", "gpu"] : ["cpu"];

/** The canonical form of a choice: `asrDevice` written only where it says something. */
export function canonicalChoice(c: VoiceChoice): VoiceChoice {
  const out: VoiceChoice = { tts: c.tts, asr: c.asr, asrModel: c.asrModel };
  if (asrDevices(c).length > 1 && asrDevice(c) === "cpu") out.asrDevice = "cpu";
  return out;
}

/** Throws what the person should read when the value is not a combination the installer can make. */
export function parseChoice(value: unknown): VoiceChoice {
  const v = value as Partial<VoiceChoice> | null;
  if (!v || typeof v !== "object") throw new Error("Choose a speech synthesis and a speech recognition engine");
  if (typeof v.tts !== "string" || (v.tts !== "none" && !Object.hasOwn(TTS_ENGINES, v.tts))) throw new Error("Choose a supported speech synthesis engine");
  if (typeof v.asr !== "string" || typeof v.asrModel !== "string" || !asrOption(v as VoiceChoice))
    throw new Error("Choose a supported speech recognition model");
  if (v.asrDevice !== undefined && v.asrDevice !== "cpu" && v.asrDevice !== "gpu") throw new Error("Choose the CPU or the GPU for speech recognition");
  if (v.asrDevice === "gpu" && !asrDevices(v as VoiceChoice).includes("gpu"))
    throw new Error(v.asr === "whisper" ? "Whisper runs on the CPU" : "Speech recognition without speech synthesis runs on the CPU");
  return canonicalChoice(v as VoiceChoice);
}

/** The choice as a container label carries it, e.g. `breeze+whisper:base`, or `breeze+qwen3-asr:0.6b@cpu`. */
export const choiceKey = (c: VoiceChoice) => `${c.tts}+${c.asr}:${c.asrModel}${c.asrDevice === "cpu" ? "@cpu" : ""}`;
export const sameChoice = (a: VoiceChoice, b: VoiceChoice) => choiceKey(canonicalChoice(a)) === choiceKey(canonicalChoice(b));
/** The choice a label names; one that is missing or is not a combination known now reads as the original one. */
export function choiceFromKey(key: string | undefined): VoiceChoice {
  const m = /^(\w+)\+([\w-]+):([\w.]+?)(?:@(cpu|gpu))?$/.exec(key ?? "");
  try { return m ? parseChoice({ tts: m[1], asr: m[2], asrModel: m[3], asrDevice: m[4] }) : DEFAULT_CHOICE; } catch { return DEFAULT_CHOICE; }
}

export function choiceLabel(c: VoiceChoice): string {
  const asr = asrOption(c)?.label ?? c.asr;
  if (c.tts === "none") return `${asr} (speech recognition only)`;
  return `${TTS_ENGINES[c.tts].label} speech with ${asr}${c.asr === "qwen3-asr" && asrDevice(c) === "cpu" ? " on the CPU" : ""}`;
}

/** GPU memory the choice holds while it is in use. */
export const vramNeeded = (c: VoiceChoice) => (c.tts === "none" ? 0 : TTS_ENGINES[c.tts].vramMiB) + (asrDevice(c) === "gpu" ? asrOption(c)?.vramMiB ?? 0 : 0);
/** Memory of the host the choice holds while it is in use: what recognition takes on the CPU. */
export const ramNeeded = (c: VoiceChoice) => (asrDevice(c) === "cpu" ? asrOption(c)?.ramMiB ?? 0 : 0);

/** `uuid` names the card for good: the index is the driver's order, which a reboot or a card added beside it changes. A reading without one has the index only. */
export interface Gpu { index: number; uuid?: string; name: string; totalMiB: number | null; freeMiB: number | null }
/** What there is to run on: memory of the host, and how many CPU threads it has. */
export interface Host { totalMiB: number | null; freeMiB: number | null; threads: number }
/** `fits`: there is room now. `tight`: the card is big enough, but other programs hold part of it now. */
export type Fit = "fits" | "tight" | "too-large" | "unknown";

/**
 * Does the choice fit the GPU? `reserveMiB` is memory to keep free for something
 * else on the same card, such as a model that runs in the container later.
 */
export function fitOn(c: VoiceChoice, gpu: Gpu | undefined, reserveMiB = 0): Fit {
  if (!usesGpu(c)) return "fits";
  if (!gpu || gpu.totalMiB === null) return "unknown";
  const need = vramNeeded(c) + reserveMiB;
  if (need > gpu.totalMiB) return "too-large";
  return gpu.freeMiB !== null && need > gpu.freeMiB ? "tight" : "fits";
}

/** Does what the choice runs on the CPU fit the memory of the host? The same verdicts as for a GPU. */
export function fitRam(c: VoiceChoice, host: Host | undefined): Fit {
  const need = ramNeeded(c);
  if (!need) return "fits";
  if (!host || host.totalMiB === null) return "unknown";
  if (need > host.totalMiB) return "too-large";
  return host.freeMiB !== null && need > host.freeMiB ? "tight" : "fits";
}

/** How many times faster than the audio recognition on the CPU is expected to be on this many threads; undefined where it is not known. */
export function cpuRealtime(c: VoiceChoice, threads: number): number | undefined {
  const measured = asrDevice(c) === "cpu" ? asrOption(c)?.cpuRealtime : undefined;
  // Scaled by the threads against the ones it was measured on. An estimate from one measurement, not a promise.
  return measured === undefined ? undefined : measured * Math.min(Math.max(threads, 1), MEASURED_THREADS) / MEASURED_THREADS;
}
/** Recognition on the CPU that is expected to fall behind the speaker. */
export const cpuSlow = (c: VoiceChoice, threads: number) => (cpuRealtime(c, threads) ?? Infinity) < 1;

/** The GPU the container will use: the one asked for, else the one with the most memory free. */
export function pickGpu(gpus: readonly Gpu[], preferred?: number): Gpu | undefined {
  const asked = preferred === undefined ? undefined : gpus.find((g) => g.index === preferred);
  return asked ?? [...gpus].sort((a, b) => (b.freeMiB ?? b.totalMiB ?? -1) - (a.freeMiB ?? a.totalMiB ?? -1))[0];
}

/** The combination that needs the least GPU memory of those with speech synthesis: Kokoro, with Whisper on the CPU. */
export const LEAN_CHOICE: VoiceChoice = { tts: "kokoro", asr: "whisper", asrModel: "base" };

/**
 * The best combination that fits with room to spare right now. Breeze stays the
 * speech engine as long as it fits, since it streams, then Chatterbox, which clones
 * a voice; recognition then gets the largest recommended model that still fits
 * next to it. Kokoro, which has only voices of its own, is suggested only for a
 * card too small for the other two, not for one that is busy now. When nothing fits right
 * now it is the original combination if the card can hold it at all, else the
 * leanest one; without a GPU reading it is the original combination.
 */
export function suggestChoice(gpu: Gpu | undefined, reserveMiB = 0): VoiceChoice {
  if (!gpu || gpu.totalMiB === null) return DEFAULT_CHOICE;
  const cloning = (["breeze", "chatterbox"] as const).some((tts) => fitOn({ tts, asr: "whisper", asrModel: "base" }, gpu, reserveMiB) !== "too-large");
  for (const tts of Object.keys(TTS_ENGINES) as TtsEngine[]) {
    if (tts === "kokoro" && cloning) continue;
    const best = ASR_MODELS.filter((o) => o.recommended && fitOn({ tts, asr: o.asr, asrModel: o.model }, gpu, reserveMiB) === "fits").at(-1);
    if (best) return { tts, asr: best.asr, asrModel: best.model };
  }
  return [DEFAULT_CHOICE, LEAN_CHOICE].find((c) => fitOn(c, gpu, reserveMiB) !== "too-large") ?? DEFAULT_CHOICE;
}

/**
 * For a host without a GPU: recognition alone, on the CPU. The largest recommended model that fits the memory
 * with room to spare and keeps well ahead of the speaker on this many threads, else Whisper base.
 */
export function suggestCpuChoice(host: Host | undefined): VoiceChoice {
  const best = ASR_MODELS.filter((o) => {
    const c: VoiceChoice = { tts: "none", asr: o.asr, asrModel: o.model };
    return o.recommended && fitRam(c, host) === "fits" && (cpuRealtime(c, host?.threads ?? MEASURED_THREADS) ?? Infinity) >= COMFORTABLE;
  }).at(-1) ?? ASR_MODELS[0];
  return { tts: "none", asr: best.asr, asrModel: best.model };
}

const MODELS = {
  breeze: () => ({ id: "breeze", family: "breeze_tts", path: "/voice/models/breeze-q8_0.gguf", task: "tts", mode: "streaming", session_options: { "breeze_tts.reference_cache_slots": "1" } }),
  // "clon" is audio.cpp's own name for voice cloning, not a truncated "clone".
  chatterbox: () => ({ id: "chatterbox", family: "chatterbox", path: "/voice/models/chatterbox-q8_0.gguf", task: "clon", mode: "offline", session_options: { "chatterbox.multilingual_t3": "v3", "chatterbox.conditionals_cache_slots": "2" } }),
  kokoro: () => ({ id: "kokoro", family: "kokoro_tts", path: "/voice/models/kokoro-82m-q8_0.gguf", task: "tts", mode: "offline" }),
};
/** The speech model as audio.cpp loads it, in the server config and in a load request alike. */
export const ttsModel = (engine: TtsEngine) => MODELS[engine]();
const asrModel = (model: string) => ({ id: "qwen3-asr", family: "qwen3_asr", path: `/voice/models/qwen3-asr-${model}-q8_0.gguf`, task: "asr", mode: "offline" });

/**
 * The audio.cpp server config of the GPU process for the choice: the speech engine, and Qwen3-ASR
 * where it is put on the GPU. Whisper is a process of its own and is not in it. None where nothing of
 * the choice runs on the GPU.
 */
export function serverConfig(c: VoiceChoice) {
  if (!usesGpu(c)) return undefined;
  const models = [...(c.tts === "none" ? [] : [ttsModel(c.tts)]), ...(c.asr === "qwen3-asr" && asrDevice(c) === "gpu" ? [asrModel(c.asrModel)] : [])];
  // Speech and recognition are loaded together, or each request would swap the other out.
  return { host: "127.0.0.1", port: SPEECH_PORT, backend: "cuda", device: 0, threads: 4, lazy_load: true, idle_unload_ms: 90000, ui_management: true, max_loaded_models: models.length, models };
}

/** The config of the audio.cpp process that runs Qwen3-ASR on the CPU. None where recognition is somewhere else. */
export function cpuServerConfig(c: VoiceChoice, threads = 4) {
  if (c.asr !== "qwen3-asr" || asrDevice(c) !== "cpu") return undefined;
  return { host: "127.0.0.1", port: ASR_CPU_PORT, backend: "cpu", device: 0, threads, lazy_load: true, idle_unload_ms: 90000, max_loaded_models: 1, models: [asrModel(c.asrModel)] };
}
/** Threads for what runs on the CPU: all the host has, up to the ones the speeds above were measured on, and not fewer than two. */
export const cpuThreads = (cores: number) => Math.min(Math.max(Math.floor(cores) || 1, 2), MEASURED_THREADS);

/** The settings that point the portal at the managed services of the choice. */
export function endpoints(c: VoiceChoice) {
  const whisper = c.asr === "whisper";
  return {
    runtime: c.tts === "none" ? "none" as const : c.tts === "breeze" ? "audio-cpp" as const : c.tts,
    // Without speech synthesis there is no address to speak to.
    breezeUrl: c.tts === "none" ? "" : speechUrl,
    whisperUrl: whisper ? whisperUrl : `http://127.0.0.1:${asrDevice(c) === "cpu" ? ASR_CPU_PORT : SPEECH_PORT}/v1/audio/transcriptions`,
    // Whisper.cpp serves one model and is sent no model field; audio.cpp names the one it loaded.
    sttModel: whisper ? "" : "qwen3-asr",
  };
}

/** What has to answer before the service counts as ready. */
export const healthUrls = (c: VoiceChoice) => [
  ...(c.asr === "whisper" ? [`http://127.0.0.1:${WHISPER_PORT}/health`] : []),
  ...(usesGpu(c) ? [`http://127.0.0.1:${SPEECH_PORT}/health`] : []),
  ...(cpuServerConfig(c) ? [`http://127.0.0.1:${ASR_CPU_PORT}/health`] : []),
];
