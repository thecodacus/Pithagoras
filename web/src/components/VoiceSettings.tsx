import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { language, t } from "../i18n";
import { FILLER_LIMITS, type FillerPacing } from "../voice-fillers";

/** The speeds offered. Faster than 1.75× stops being speech anyone follows. */
export const VOICE_RATES = [1, 1.25, 1.5, 1.75];

/**
 * How voice mode behaves, in a small card by its buttons: sound effects, fillers and
 * when they come, how fast the agent speaks, what talking mid-run does, and
 * push-to-talk. Each is remembered in this browser.
 *
 * Drawn over the whole page, not inside the voice stage: the stage is its own
 * layer, and the canvas panel beside it would otherwise cover the card. It is
 * placed above the button that opens it, and follows it when the window changes.
 */
export function VoiceSettings({ anchor, sounds, onSounds, rate, onRate, steer, onSteer, fillers, onFillers, pacing, onPacing, ptt, onPtt, onClose }: {
  sounds: boolean; onSounds: () => void;
  rate: number; onRate: (rate: number) => void;
  steer: boolean; onSteer: (steer: boolean) => void;
  /** Null where the portal does not offer them. */
  fillers: boolean | null; onFillers: (on: boolean) => void;
  /** When the fillers come: what the sliders show, and what they set. */
  pacing: FillerPacing; onPacing: (pacing: FillerPacing) => void;
  ptt: boolean; onPtt: (ptt: boolean) => void;
  onClose: () => void;
  anchor: RefObject<HTMLElement>;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ right: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const box = anchor.current?.getBoundingClientRect();
      if (box) setAt({ right: Math.max(8, window.innerWidth - box.right), bottom: window.innerHeight - box.top + 8 });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (card.current?.contains(target) || target?.closest?.('[data-voice-settings-toggle]')) return;
      close.current();
    };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close.current(); } };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape, true); };
  }, []);
  const choice = <T,>(value: T, current: T, label: string, pick: (value: T) => void) =>
    <button type="button" aria-pressed={value === current} onClick={() => pick(value)}>{label}</button>;
  const seconds = (n: number) => `${n.toLocaleString(language())} s`;
  const slider = (key: keyof FillerPacing, label: string, show: (value: number) => string, help?: string) => {
    const { min, max, step } = FILLER_LIMITS[key];
    return <div className="voice-slider" key={key}>
      <span aria-hidden="true">{label}</span>
      <output>{show(pacing[key])}</output>
      <input type="range" min={min} max={max} step={step} value={pacing[key]} aria-label={label} aria-valuetext={show(pacing[key])}
        onChange={e => onPacing({ ...pacing, [key]: Number(e.target.value) })} />
      {help && <p>{help}</p>}
    </div>;
  };
  return createPortal(<div ref={card} className="voice-settings" role="dialog" aria-label={t("Voice settings")} style={at ? { right: at.right, bottom: at.bottom, maxHeight: `calc(100dvh - ${at.bottom}px - 8px)` } : { visibility: "hidden" }}>
    <div className="voice-setting" role="group" aria-label={t("Speaking speed")}>
      <span aria-hidden="true">{t("Speaking speed")}</span>
      <div className="voice-segments">{VOICE_RATES.map(r => <Fragment key={r}>{choice(r, rate, `${r}×`, onRate)}</Fragment>)}</div>
    </div>
    <div className="voice-setting" role="group" aria-label={t("Talking while the agent works")}>
      <span aria-hidden="true">{t("Talking while the agent works")}</span>
      <div className="voice-segments">
        {choice(false, steer, t("Stops it"), onSteer)}
        {choice(true, steer, t("Adds to the task"), onSteer)}
      </div>
      <p>{steer ? t("What you say goes into the running task after its current step. The stop button still stops it.") : t("What you say stops the task and starts a new turn.")}</p>
    </div>
    <div className="voice-setting" role="group" aria-label={t("Push to talk")}>
      <span aria-hidden="true">{t("Push to talk")}</span>
      <div className="voice-segments">
        {choice(false, ptt, t("Off"), onPtt)}
        {choice(true, ptt, t("On"), onPtt)}
      </div>
      <p>{ptt ? t("Only heard while you hold the push-to-talk key (Space unless changed) or the microphone button.") : t("Heard whenever you speak.")}</p>
    </div>
    {fillers !== null && <div className="voice-setting" role="group" aria-label={t("Fillers")}>
      <span aria-hidden="true">{t("Fillers")}</span>
      <div className="voice-segments">
        {choice(false, fillers, t("Off"), onFillers)}
        {choice(true, fillers, t("On"), onFillers)}
      </div>
      <p>{fillers ? t("Short sounds such as “mhm” from the moment you have finished until the answer starts, again if the wait is long.") : t("Nothing is said until the answer starts.")}</p>
    </div>}
    {fillers && <div className="voice-setting" role="group" aria-label={t("Filler timing")}>
      <span aria-hidden="true">{t("Filler timing")}</span>
      {slider("first", t("First filler after"), n => n === 0 ? t("At once") : seconds(n))}
      {slider("every", t("Time between fillers"), seconds)}
      {slider("randomness", t("Randomness"), n => `${Math.round(n * 100)} %`, t("0 is exactly the time set. More makes each gap shorter or longer, by up to that share of it."))}
      {slider("max", t("Most per wait"), n => String(n), t("After that many the voice stays quiet until the answer, so a long task is not filled for ever."))}
    </div>}
    <div className="voice-setting" role="group" aria-label={t("Sound effects")}>
      <span aria-hidden="true">{t("Sound effects")}</span>
      <div className="voice-segments">
        {choice(false, sounds, t("Off"), () => sounds && onSounds())}
        {choice(true, sounds, t("On"), () => !sounds && onSounds())}
      </div>
    </div>
  </div>, document.body);
}
