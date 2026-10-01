import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { api } from "../api";
import { DEFAULT_ORB, ORB_PERSONALITIES, hexToRgb, type OrbState, type OrbStyle } from "../../../server/src/orb-style";

export interface VoiceLevels { input: number; output: number }

/** Sent with the new style when it is saved, so an open voice stage changes with it. */
export const ORB_STYLE_EVENT = "orb-style-changed";

/** The portal's orb style: the default until the server answers, then whatever is saved. */
export function useOrbStyle(): OrbStyle {
  const [style, setStyle] = useState<OrbStyle>(DEFAULT_ORB);
  useEffect(() => {
    let live = true;
    api.agentOrb().then((s) => { if (live) setStyle(s); }).catch(() => {});
    const changed = (e: Event) => setStyle((e as CustomEvent<OrbStyle>).detail);
    window.addEventListener(ORB_STYLE_EVENT, changed);
    return () => { live = false; window.removeEventListener(ORB_STYLE_EVENT, changed); };
  }, []);
  return style;
}

/**
 * The shape follows real RMS audio levels; the slow drift only gives idle depth.
 *
 * The style is read on every frame rather than restarting the animation, so a
 * change in the Agent page's preview shows at once. With the balanced
 * personality and the default multipliers this draws the orb as it always was.
 */
export function VoiceOrb({ mode, levels, look }: { mode: OrbState; levels: MutableRefObject<VoiceLevels>; look: OrbStyle }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const current = useRef(mode); current.current = mode;
  const style = useRef(look); style.current = look;
  useEffect(() => {
    const element = canvas.current!;
    const ctx = element.getContext("2d");
    if (!ctx) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const size = 600;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    element.width = size * ratio; element.height = size * ratio;
    ctx.scale(ratio, ratio);
    let frame = 0, level = 0;
    let color: number[] = hexToRgb(style.current.colors[current.current]);
    const render = (timestamp: number) => {
      const mode = current.current;
      const look = style.current;
      const motion = ORB_PERSONALITIES[look.personality];
      const value = (mode === "input" ? levels.current.input : mode === "output" ? levels.current.output : 0) * look.reactivity;
      level += (value - level) * (value > level ? motion.attack : motion.release);
      const target = hexToRgb(look.colors[mode]);
      color = color.map((v, i) => v + (target[i] - v) * 0.06);
      const rgb = color.map(Math.round).join(",");
      const t = reduced ? 0 : timestamp * 0.00055 * look.speed * motion.drift;
      const swell = 1 + motion.bounce * Math.sin(t * 3);
      const r = (132 + level * (reduced ? 5 : 28)) * swell;
      ctx.clearRect(0, 0, size, size);
      ctx.save(); ctx.translate(size / 2, size / 2);
      const halo = ctx.createRadialGradient(0, 0, r * 0.65, 0, 0, r * 1.7);
      halo.addColorStop(0, `rgba(${rgb},${Math.min(1, (0.3 + level * 0.18) * look.glow)})`); halo.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = halo; ctx.fillRect(-size / 2, -size / 2, size, size);
      for (let ring = 0; ring < motion.rings; ring++) {
        ctx.beginPath();
        ctx.ellipse(0, 0, r + 20 + ring * 16 + level * 7, r + 18 + ring * 16, Math.sin(t) * motion.wobble, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rgb},${Math.max(0.04, 0.2 + level * 0.15 - ring * 0.05)})`; ctx.lineWidth = 1.2; ctx.stroke();
      }
      ctx.beginPath();
      const [first, second] = motion.lobes;
      for (let i = 0; i <= 160; i++) {
        const a = i / 160 * Math.PI * 2;
        const wave = (Math.sin(a * first + t * 1.3) * (3 + level * 7) + Math.sin(a * second - t * 2) * level * 10) * motion.wave;
        const x = Math.cos(a) * (r + wave), y = Math.sin(a) * (r + wave);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const sphere = ctx.createRadialGradient(-r * 0.32, -r * 0.45, 1, r * 0.12, r * 0.1, r * 1.32);
      sphere.addColorStop(0, `rgba(${rgb},0.98)`); sphere.addColorStop(0.32, `rgba(${rgb},0.95)`);
      sphere.addColorStop(0.7, `rgb(${color.map(v => Math.round(v * 0.62)).join(",")})`); sphere.addColorStop(1, `rgb(${color.map(v => Math.round(v * 0.34)).join(",")})`);
      ctx.shadowColor = `rgba(${rgb},0.65)`; ctx.shadowBlur = 22 * look.glow;
      ctx.fillStyle = sphere; ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = `rgba(${rgb},0.8)`; ctx.lineWidth = 1.8; ctx.stroke(); ctx.save(); ctx.clip();
      // Translucent ribbons bend across the sphere rather than flat sine bars.
      if (look.ribbons) for (let band = 0; band < 15; band++) {
        const y = -r + band * r * 0.15;
        const bend = Math.sin(t + band * 0.27) * 35 + level * 22;
        ctx.beginPath(); ctx.moveTo(-r * 1.3, y);
        ctx.bezierCurveTo(-r * 0.45, y - 60 + bend, r * 0.35, y + 65 + bend, r * 1.3, y - 20);
        ctx.bezierCurveTo(r * 0.3, y + 85 + bend, -r * 0.4, y - 40 + bend, -r * 1.3, y + 9);
        const ribbon = ctx.createLinearGradient(-r, -r, r, r);
        ribbon.addColorStop(0, `rgba(231,255,255,${0.04 + band * 0.003})`);
        ribbon.addColorStop(0.45, `rgba(${rgb},${0.24 + level * 0.12})`);
        ribbon.addColorStop(1, "rgba(192,190,255,0.03)");
        ctx.fillStyle = ribbon; ctx.fill();
      }
      const shine = ctx.createRadialGradient(-r * 0.33, -r * 0.55, 0, -r * 0.33, -r * 0.55, r * 0.85);
      shine.addColorStop(0, "rgba(238,255,255,0.45)"); shine.addColorStop(0.35, "rgba(233,253,255,0.08)"); shine.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = shine; ctx.fillRect(-r, -r, 2 * r, 2 * r);
      ctx.restore(); ctx.restore();
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [levels]);
  return <canvas ref={canvas} aria-hidden="true" className="voice-orb" data-mode={mode} />;
}
