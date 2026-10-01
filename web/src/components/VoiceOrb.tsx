import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { api } from "../api";
import { DEFAULT_ORB, ORB_PERSONALITIES, hexToRgb, type OrbState, type OrbStyle } from "../../../server/src/orb-style";

type Ctx = CanvasRenderingContext2D;

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
 * Eyes on the face of the orb, in the orb's own units: centred on it, `r` its
 * radius. `open` is 0 shut to 1 open (blinks, muted); `gx`/`gy` are where they
 * look, -1 to 1.
 */
function drawEyes(ctx: Ctx, look: OrbStyle, r: number, mode: OrbState, level: number, open: number, gx: number, gy: number) {
  const es = r * 0.16 * (mode === "input" ? 1.12 : 1);
  const ey = -r * 0.08 - (mode === "output" ? level * r * 0.03 : 0);
  const ex = r * 0.32;
  const color = look.eyeColor;
  // The pupils and glints are white; dark eyes get a faint light edge to stand
  // off the orb instead of a glow of their own colour.
  const [cr, cg, cb] = hexToRgb(color);
  const dark = cr * 0.299 + cg * 0.587 + cb * 0.114 < 110;
  const pupil = "#ffffff";
  ctx.save();
  ctx.shadowColor = dark ? "rgba(255,255,255,0.35)" : color; ctx.shadowBlur = dark ? 4 : 10;
  ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineCap = "round";
  if (look.eyes === "visor") {
    ctx.beginPath(); ctx.roundRect(-r * 0.56, ey - es * 0.62, r * 1.12, es * 1.24, es * 0.62);
    ctx.fill();
    ctx.shadowColor = pupil; ctx.shadowBlur = 12; ctx.fillStyle = pupil;
    for (const side of [-1, 1]) {
      ctx.beginPath(); ctx.roundRect(side * ex - es * 0.45 + gx * es * 0.35, ey - es * 0.16 * open, es * 0.9, Math.max(1, es * 0.32 * open), es * 0.16);
      ctx.fill();
    }
    ctx.restore();
    return;
  }
  for (const side of [-1, 1]) {
    const cx = side * ex;
    if (look.eyes === "happy") {
      ctx.lineWidth = es * 0.28;
      ctx.beginPath(); ctx.arc(cx, ey + es * 0.35, es * 0.6, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
      continue;
    }
    if (open < 0.15) {
      // Shut: a soft curve where the eye was.
      ctx.lineWidth = es * 0.2;
      ctx.beginPath(); ctx.arc(cx, ey - es * 0.25, es * 0.55, Math.PI * 0.2, Math.PI * 0.8); ctx.stroke();
      continue;
    }
    if (look.eyes === "dots") {
      const x = cx + gx * es * 0.35, y = ey + gy * es * 0.35;
      ctx.beginPath(); ctx.ellipse(x, y, es * 0.5, es * 0.62 * open, 0, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = pupil;
      ctx.beginPath(); ctx.ellipse(x - es * 0.14, y - es * 0.2 * open, es * 0.15, es * 0.15 * open, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = color;
    } else if (look.eyes === "round") {
      ctx.beginPath(); ctx.ellipse(cx, ey, es * 0.85, es * open, 0, 0, Math.PI * 2); ctx.fill();
      ctx.save(); ctx.clip(); ctx.shadowBlur = 0;
      ctx.fillStyle = pupil;
      ctx.beginPath(); ctx.arc(cx + gx * es * 0.32, ey + gy * es * 0.32, es * 0.36, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    } else if (look.eyes === "sleepy") {
      ctx.beginPath(); ctx.ellipse(cx + gx * es * 0.2, ey + es * 0.22, es * 0.58, es * 0.34 * open, 0, 0, Math.PI); ctx.fill();
      ctx.lineWidth = es * 0.16;
      ctx.beginPath(); ctx.moveTo(cx - es * 0.7, ey + es * 0.12); ctx.quadraticCurveTo(cx, ey + es * 0.02, cx + es * 0.7, ey + es * 0.12); ctx.stroke();
      ctx.shadowBlur = 0; ctx.fillStyle = pupil;
      ctx.beginPath(); ctx.arc(cx + gx * es * 0.2 - es * 0.12, ey + es * 0.3, es * 0.09 * open, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = color;
    }
  }
  ctx.restore();
}

/** Something the orb wears, in the same units as the eyes. */
function drawProp(ctx: Ctx, look: OrbStyle, r: number, t: number, level: number) {
  const color = look.propColor;
  const edge = "rgba(0,0,0,0.35)";
  ctx.save();
  ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineCap = "round"; ctx.lineJoin = "round";
  switch (look.prop) {
    case "headphones": {
      ctx.lineWidth = r * 0.09;
      ctx.beginPath(); ctx.arc(0, 0, r * 1.1, Math.PI * 1.12, Math.PI * 1.88); ctx.stroke();
      for (const side of [-1, 1]) {
        ctx.beginPath(); ctx.roundRect(side * r * 1.06 - r * 0.1, -r * 0.24, r * 0.2, r * 0.48, r * 0.08);
        ctx.fill(); ctx.strokeStyle = edge; ctx.lineWidth = r * 0.02; ctx.stroke(); ctx.strokeStyle = color;
      }
      break;
    }
    case "antenna": {
      const sway = Math.sin(t * 1.7) * r * 0.06;
      ctx.lineWidth = r * 0.03;
      ctx.beginPath(); ctx.moveTo(0, -r * 0.97); ctx.quadraticCurveTo(sway * 0.4, -r * 1.2, sway, -r * 1.42); ctx.stroke();
      ctx.shadowColor = color; ctx.shadowBlur = 12 + level * 18;
      ctx.beginPath(); ctx.arc(sway, -r * 1.42, r * 0.08 * (1 + level * 0.4), 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "crown": {
      const y = -r * 0.86;
      const tips: [number, number][] = [[-r * 0.42, y - r * 0.32], [0, y - r * 0.4], [r * 0.42, y - r * 0.32]];
      ctx.beginPath(); ctx.moveTo(-r * 0.42, y); ctx.lineTo(...tips[0]); ctx.lineTo(-r * 0.21, y - r * 0.14); ctx.lineTo(...tips[1]);
      ctx.lineTo(r * 0.21, y - r * 0.14); ctx.lineTo(...tips[2]); ctx.lineTo(r * 0.42, y); ctx.closePath();
      ctx.fill(); ctx.strokeStyle = edge; ctx.lineWidth = r * 0.02; ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      for (const [x, ty] of tips) { ctx.beginPath(); ctx.arc(x, ty, r * 0.045, 0, Math.PI * 2); ctx.fill(); }
      break;
    }
    case "halo": {
      const bob = Math.sin(t * 1.4) * r * 0.04;
      ctx.shadowColor = color; ctx.shadowBlur = 18; ctx.lineWidth = r * 0.06;
      ctx.beginPath(); ctx.ellipse(0, -r * 1.22 + bob, r * 0.55, r * 0.13, 0, 0, Math.PI * 2); ctx.stroke();
      break;
    }
    case "party": {
      ctx.translate(r * 0.28, -r * 0.88); ctx.rotate(0.35 + Math.sin(t * 1.5) * 0.04);
      ctx.beginPath(); ctx.moveTo(-r * 0.3, 0); ctx.lineTo(0, -r * 0.74); ctx.lineTo(r * 0.3, 0); ctx.closePath();
      ctx.fill(); ctx.save(); ctx.clip();
      ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = r * 0.05;
      for (let i = 1; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(-r * 0.3, -r * 0.16 * i); ctx.lineTo(r * 0.3, -r * 0.16 * i - r * 0.08); ctx.stroke(); }
      ctx.restore();
      ctx.strokeStyle = edge; ctx.lineWidth = r * 0.02; ctx.stroke();
      ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(0, -r * 0.76, r * 0.08, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "glasses": {
      const ey = -r * 0.08, ex = r * 0.32, w = r * 0.36, h = r * 0.29;
      ctx.lineWidth = r * 0.035; ctx.fillStyle = "rgba(255,255,255,0.08)";
      for (const side of [-1, 1]) { ctx.beginPath(); ctx.roundRect(side * ex - w / 2, ey - h / 2, w, h, r * 0.07); ctx.fill(); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(-ex + w / 2, ey - h * 0.1); ctx.quadraticCurveTo(0, ey - h * 0.35, ex - w / 2, ey - h * 0.1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-ex - w / 2, ey - h * 0.2); ctx.lineTo(-r * 0.93, ey - h * 0.35); ctx.moveTo(ex + w / 2, ey - h * 0.2); ctx.lineTo(r * 0.93, ey - h * 0.35); ctx.stroke();
      break;
    }
    case "bow": {
      ctx.translate(r * 0.55, -r * 0.8); ctx.rotate(0.5);
      for (const side of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(side * r * 0.28, -r * 0.3, side * r * 0.37, 0); ctx.quadraticCurveTo(side * r * 0.28, r * 0.3, 0, 0);
        ctx.fill(); ctx.strokeStyle = edge; ctx.lineWidth = r * 0.02; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(0, 0, r * 0.085, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      break;
    }
  }
  ctx.restore();
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
    // Blinks come at uneven intervals, as they do; the personality sets how often.
    let nextBlink = performance.now() + 2500, blinkAt = -1e9;
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
      ctx.restore();
      if (look.eyes !== "none") {
        if (!reduced && timestamp > nextBlink) { blinkAt = timestamp; nextBlink = timestamp + (2200 + Math.random() * 3200) / motion.blink; }
        const blinking = timestamp - blinkAt < 160;
        const open = mode === "muted" ? 0 : blinking ? Math.abs(Math.cos((timestamp - blinkAt) / 160 * Math.PI)) : 1;
        const gx = reduced ? 0 : Math.sin(t * 0.9) * (mode === "idle" ? 0.9 : 0.35);
        const gy = reduced ? 0 : mode === "input" ? -0.45 : Math.cos(t * 0.6) * 0.4;
        drawEyes(ctx, look, r, mode, level, open, gx, gy);
      }
      if (look.prop !== "none") drawProp(ctx, look, r, t, level);
      ctx.restore();
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [levels]);
  return <canvas ref={canvas} aria-hidden="true" className="voice-orb" data-mode={mode} />;
}
