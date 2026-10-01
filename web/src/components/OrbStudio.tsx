import { useEffect, useRef, useState } from "react";
import { LuCheck, LuRefreshCw, LuRotateCcw } from "react-icons/lu";
import { api } from "../api";
import { msg, t } from "../i18n";
import { DEFAULT_ORB, ORB_PALETTES, type OrbEyes, type OrbPersonality, type OrbProp, type OrbState, type OrbStyle } from "../../../server/src/orb-style";
import { ORB_STYLE_EVENT, VoiceOrb, type VoiceLevels } from "./VoiceOrb";

const PERSONALITIES: [OrbPersonality, string, string][] = [
  ["balanced", msg("Balanced"), msg("The orb as it has always been")],
  ["calm", msg("Calm"), msg("Slow breathing, soft edges, gentle answers")],
  ["lively", msg("Lively"), msg("Quick to react, busy edges, an extra ring")],
  ["playful", msg("Playful"), msg("Bouncy, tilting rings, big reactions")],
  ["focused", msg("Focused"), msg("Still and precise, fine ripples, one ring")],
];

const PALETTE_NAMES: Record<string, string> = {
  aurora: msg("Aurora"), ember: msg("Ember"), forest: msg("Forest"), rose: msg("Rose"), mono: msg("Mono"),
};

const EYES: [OrbEyes, string][] = [
  ["none", msg("None")], ["dots", msg("Dots")], ["round", msg("Round")], ["happy", msg("Happy")], ["sleepy", msg("Sleepy")], ["visor", msg("Visor")],
];

const PROPS: [OrbProp, string][] = [
  ["none", msg("None")], ["headphones", msg("Headphones")], ["antenna", msg("Antenna")], ["crown", msg("Crown")],
  ["halo", msg("Halo")], ["party", msg("Party hat")], ["glasses", msg("Glasses")], ["bow", msg("Bow")],
];

const STATES: [OrbState, string][] = [
  ["idle", msg("Idle")], ["input", msg("Listening")], ["output", msg("Speaking")], ["muted", msg("Muted")],
];

const SLIDERS: ["speed" | "reactivity" | "glow", string, number, number, string][] = [
  ["speed", msg("Motion speed"), 0.25, 2.5, msg("How fast it drifts when nothing is said")],
  ["reactivity", msg("Reactivity"), 0, 2.5, msg("How strongly it answers your voice and its own")],
  ["glow", msg("Glow"), 0, 2, msg("The halo and light around it")],
];

/**
 * The voice-mode orb's personality and look, with a live preview.
 *
 * The preview speaks with a made-up voice level so the motion can be judged
 * without starting voice mode; saved, the style reaches every open voice stage.
 */
export function OrbStudio() {
  const [saved, setSaved] = useState<OrbStyle | null>(null);
  const [draft, setDraft] = useState<OrbStyle>(DEFAULT_ORB);
  const [state, setState] = useState<OrbState>("output");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const levels = useRef<VoiceLevels>({ input: 0, output: 0 });

  useEffect(() => {
    api.agentOrb().then((s) => { setSaved(s); setDraft(s); }).catch((e) => setError((e as Error).message));
  }, []);

  // Syllables rising and falling inside slower phrases, like the meter during speech.
  useEffect(() => {
    let frame = 0;
    const tick = (ms: number) => {
      const syllable = Math.max(0, Math.sin(ms * 0.012));
      const phrase = 0.55 + 0.45 * Math.sin(ms * 0.0019);
      const value = Math.min(1, syllable * phrase * 0.85 + Math.random() * 0.08);
      levels.current = { input: state === "input" ? value : 0, output: state === "output" ? value : 0 };
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state]);

  const change = (patch: Partial<OrbStyle>) => { setDraft((d) => ({ ...d, ...patch })); setDone(false); };
  const dirty = saved !== null && JSON.stringify(draft) !== JSON.stringify(saved);

  const save = async () => {
    setBusy(true); setError("");
    try {
      const next = await api.setAgentOrb(draft);
      setSaved(next); setDraft(next); setDone(true);
      window.dispatchEvent(new CustomEvent(ORB_STYLE_EVENT, { detail: next }));
      setTimeout(() => setDone(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 rounded-xl border border-line bg-surface/50 p-4">
      <div>
        <h3 className="text-sm font-medium">{t("Voice orb")}</h3>
        <p className="mt-1 text-xs text-fg-muted">{t("How the agent looks and moves in voice mode.")}</p>
      </div>

      <div className="mt-4 grid gap-5 sm:grid-cols-[220px_1fr]">
        <div>
          <div className="flex aspect-square items-center justify-center overflow-hidden rounded-xl bg-[#0b1220]">
            <div className="voice-avatar w-[58%]">
              <VoiceOrb mode={state} levels={levels} look={draft} />
            </div>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-1" role="group" aria-label={t("Preview state")}>
            {STATES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={state === value}
                onClick={() => setState(value)}
                className={`rounded-md px-1 py-1 text-[11px] transition ${state === value ? "bg-accent/12 text-accent" : "text-fg-muted hover:bg-fg/5"}`}
              >
                {t(label)}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <p className="text-xs text-fg-muted">{t("Personality")}</p>
            <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
              {PERSONALITIES.map(([value, label, hint]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={draft.personality === value}
                  onClick={() => change({ personality: value })}
                  className={`rounded-lg border px-3 py-2 text-left transition ${
                    draft.personality === value ? "border-accent/50 bg-accent/10" : "border-line hover:bg-fg/5"
                  }`}
                >
                  <span className="block text-xs font-medium text-fg">{t(label)}</span>
                  <span className="mt-0.5 block text-[11px] text-fg-faint">{t(hint)}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs text-fg-muted">{t("Colours")}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {Object.entries(ORB_PALETTES).map(([name, colors]) => (
                <button
                  key={name}
                  type="button"
                  aria-pressed={draft.palette === name}
                  onClick={() => change({ palette: name, colors: { ...colors } })}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition ${
                    draft.palette === name ? "border-accent/50 bg-accent/10 text-fg" : "border-line text-fg-muted hover:bg-fg/5"
                  }`}
                >
                  <span className="flex">
                    {(["idle", "input", "output"] as const).map((s) => (
                      <span key={s} className="-ml-0.5 h-3 w-3 rounded-full ring-1 ring-black/30 first:ml-0" style={{ background: colors[s] }} />
                    ))}
                  </span>
                  {t(PALETTE_NAMES[name] ?? name)}
                </button>
              ))}
              {draft.palette === "custom" && (
                <span className="inline-flex items-center rounded-lg border border-accent/50 bg-accent/10 px-2 py-1 text-[11px] text-fg">{t("Custom")}</span>
              )}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {STATES.map(([s, label]) => (
                <label key={s} className="flex items-center gap-2 text-[11px] text-fg-muted">
                  <input
                    type="color"
                    value={draft.colors[s]}
                    onChange={(e) => change({ palette: "custom", colors: { ...draft.colors, [s]: e.target.value } })}
                    className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent"
                  />
                  {t(label)}
                </label>
              ))}
            </div>
          </div>

          {([["eyes", "eyeColor", msg("Eyes"), EYES], ["prop", "propColor", msg("Props"), PROPS]] as const).map(([key, colorKey, title, options]) => (
            <div key={key}>
              <p className="text-xs text-fg-muted">{t(title)}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {options.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={draft[key] === value}
                    onClick={() => change({ [key]: value } as Partial<OrbStyle>)}
                    className={`rounded-lg border px-2.5 py-1 text-[11px] transition ${
                      draft[key] === value ? "border-accent/50 bg-accent/10 text-fg" : "border-line text-fg-muted hover:bg-fg/5"
                    }`}
                  >
                    {t(label)}
                  </button>
                ))}
                {draft[key] !== "none" && (
                  <label className="ml-1 flex items-center gap-1.5 text-[11px] text-fg-muted">
                    <input
                      type="color"
                      aria-label={t("Colour")}
                      value={draft[colorKey]}
                      onChange={(e) => change({ [colorKey]: e.target.value } as Partial<OrbStyle>)}
                      className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent"
                    />
                  </label>
                )}
              </div>
            </div>
          ))}

          {SLIDERS.map(([key, label, min, max, help]) => (
            <label key={key} className="block text-xs text-fg-muted">
              <span className="flex justify-between gap-3">
                <span>{t(label)}</span>
                <span className="tabular-nums text-accent">{draft[key].toFixed(2)}×</span>
              </span>
              <input
                type="range"
                className="mt-1.5 w-full accent-current"
                min={min}
                max={max}
                step={0.05}
                value={draft[key]}
                onChange={(e) => change({ [key]: Number(e.target.value) } as Partial<OrbStyle>)}
              />
              <span className="mt-0.5 block text-[11px] text-fg-faint">{t(help)}</span>
            </label>
          ))}

          <label className="flex items-center gap-2 text-xs text-fg-muted">
            <input type="checkbox" checked={draft.ribbons} onChange={(e) => change({ ribbons: e.target.checked })} />
            {t("Ribbons of light inside the orb")}
          </label>
        </div>
      </div>

      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => change({ ...DEFAULT_ORB, colors: { ...DEFAULT_ORB.colors } })}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-fg-muted transition hover:bg-fg/5"
        >
          <LuRotateCcw className="h-3.5 w-3.5" />
          {t("Reset to default")}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-black transition disabled:opacity-40"
        >
          {busy ? <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> : done ? <LuCheck className="h-3.5 w-3.5" /> : null}
          {done ? t("Saved") : t("Save orb")}
        </button>
      </div>
    </section>
  );
}
