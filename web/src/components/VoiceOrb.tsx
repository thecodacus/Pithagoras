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

type Rgb = [number, number, number];
const css = (c: Rgb, a = 1) => `rgba(${c.map(Math.round).join(",")},${a})`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Toward white for k > 0, toward black for k < 0. */
const shade = (c: Rgb, k: number): Rgb => mix(c, k > 0 ? [255, 255, 255] : [0, 0, 0], Math.abs(k));
/** The portal's neutral surfaces (zinc) and its accent, as the UI uses them. */
const ZINC: Rgb = [113, 113, 122];
const ACCENT: Rgb = [34, 211, 238];

/**
 * A prop's material: the chosen colour taken most of the way to the UI's
 * neutral grey, so it reads as a tinted surface rather than a saturated one,
 * lit from above.
 */
function material(ctx: Ctx, color: string, top: number, bottom: number): CanvasGradient {
  const base = mix(hexToRgb(color), ZINC, 0.55);
  const g = ctx.createLinearGradient(0, top, 0, bottom);
  g.addColorStop(0, css(shade(base, 0.5))); g.addColorStop(0.45, css(base)); g.addColorStop(1, css(shade(base, -0.55)));
  return g;
}

/** A small ball lit from the upper left. */
function ball(ctx: Ctx, x: number, y: number, radius: number, color: Rgb) {
  const g = ctx.createRadialGradient(x - radius * 0.35, y - radius * 0.4, radius * 0.1, x, y, radius);
  g.addColorStop(0, css(shade(color, 0.7))); g.addColorStop(0.5, css(color)); g.addColorStop(1, css(shade(color, -0.6)));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
}

/** A soft highlight where the light catches a surface. */
function gloss(ctx: Ctx, x: number, y: number, rx: number, ry: number, alpha = 0.4) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
  g.addColorStop(0, `rgba(255,255,255,${alpha})`); g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.save(); ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}

/** Lifts a prop off the orb with a soft shadow below it. */
function lift(ctx: Ctx, r: number) { ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = r * 0.08; ctx.shadowOffsetY = r * 0.03; }
function unlift(ctx: Ctx) { ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; }

/** Where the eyes sit and how big they are: widened and raised when listening, stretched by the voice when speaking. */
function faceOf(r: number, mode: OrbState, level: number) {
  return {
    ex: r * 0.36,
    ey: -r * 0.06 - (mode === "input" ? r * 0.04 : 0) - (mode === "output" ? level * r * 0.06 : 0),
    es: r * 0.22 * (mode === "input" ? 1.18 : 1),
    stretch: mode === "output" ? 1 + level * 0.32 : mode === "input" ? 1.08 : 1,
  };
}

/** Which way the face is turned, in radians: yaw to the side, pitch up or down. */
interface Turn { yaw: number; pitch: number }

/**
 * Where one eye lands on the sphere once the face turns: its centre, and how
 * much it narrows as it moves round toward the edge.
 */
function eyePlace(r: number, ex: number, ey: number, side: number, turn: Turn) {
  const rest = Math.asin(Math.min(0.95, ex / r));
  const a = side * rest + turn.yaw;
  return { x: Math.sin(a) * r, y: ey + Math.sin(turn.pitch) * r * 0.6, fx: Math.max(0.3, Math.cos(a) / Math.cos(rest)) };
}

/** A soft shadow under a shape, so it sits in the orb's surface rather than on it. */
function recess(ctx: Ctx, path: () => void, size: number) {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = size * 0.35; ctx.shadowOffsetY = size * 0.12;
  path(); ctx.fill();
  ctx.restore();
}

/** Light catching the top of a domed shape. */
function dome(ctx: Ctx, path: () => void, size: number) {
  ctx.save();
  path(); ctx.clip();
  const g = ctx.createRadialGradient(-size * 0.35, -size * 0.5, 0, -size * 0.35, -size * 0.5, size * 0.95);
  g.addColorStop(0, "rgba(255,255,255,0.34)"); g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g; ctx.fillRect(-size * 2, -size * 2, size * 4, size * 4);
  ctx.restore();
}

/**
 * Eyes on the face of the orb, in the orb's own units: centred on it, `r` its
 * radius. `open` is 0 shut to 1 open (blinks, muted); `gx`/`gy` are where they
 * look, -1 to 1, and `turn` is how far the face has turned to look there.
 * Cartoon proportions on purpose: big, and moving with the voice.
 */
function drawEyes(ctx: Ctx, look: OrbStyle, r: number, mode: OrbState, level: number, open: number, gx: number, gy: number, turn: Turn) {
  const { ex, ey, es, stretch } = faceOf(r, mode, level);
  const color = look.eyeColor;
  // The pupils and glints are white; dark eyes get a faint light rim to stand
  // off the orb instead of a glow of their own colour.
  const [cr, cg, cb] = hexToRgb(color);
  const dark = cr * 0.299 + cg * 0.587 + cb * 0.114 < 110;
  const rim = dark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.2)";
  const pupil = "#ffffff";
  // The head has turned part of the way; the eyes look the rest.
  const lx = gx * 0.6, ly = gy * 0.6;
  ctx.save();
  ctx.lineCap = "round";
  if (look.eyes === "visor") {
    ctx.translate(Math.sin(turn.yaw) * r * 0.75, ey + Math.sin(turn.pitch) * r * 0.6);
    ctx.scale(Math.cos(turn.yaw), 1);
    const band = () => { ctx.beginPath(); ctx.roundRect(-r * 0.62, -es * 0.7, r * 1.24, es * 1.4, es * 0.7); };
    recess(ctx, band, es);
    ctx.fillStyle = color; band(); ctx.fill();
    ctx.strokeStyle = rim; ctx.lineWidth = es * 0.06; band(); ctx.stroke();
    ctx.shadowColor = pupil; ctx.shadowBlur = 14; ctx.fillStyle = pupil;
    for (const side of [-1, 1]) {
      const h = Math.max(1, es * 0.42 * open * stretch);
      ctx.beginPath(); ctx.roundRect(side * ex - es * 0.55 + lx * es * 0.4, -h / 2, es * 1.1, h, h / 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    dome(ctx, band, es);
    ctx.restore();
    return;
  }
  for (const side of [-1, 1]) {
    const place = eyePlace(r, ex, ey, side, turn);
    ctx.save();
    ctx.translate(place.x, place.y); ctx.scale(place.fx, 1);
    ctx.fillStyle = color; ctx.strokeStyle = color;
    const line = (draw: () => void, width: number) => {
      ctx.save(); ctx.lineWidth = width;
      ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = es * 0.25; ctx.shadowOffsetY = es * 0.1;
      draw(); ctx.stroke(); ctx.restore();
    };
    if (look.eyes === "happy") {
      line(() => { ctx.beginPath(); ctx.arc(0, es * 0.45, es * 0.72 * stretch, Math.PI * 1.13, Math.PI * 1.87); }, es * 0.36);
    } else if (open < 0.15) {
      // Shut: a thick soft curve where the eye was.
      line(() => { ctx.beginPath(); ctx.arc(0, -es * 0.3, es * 0.7, Math.PI * 0.2, Math.PI * 0.8); }, es * 0.26);
    } else if (look.eyes === "dots") {
      const x = lx * es * 0.4, y = ly * es * 0.4;
      const eye = () => { ctx.beginPath(); ctx.ellipse(x, y, es * 0.58, es * 0.78 * open * stretch, 0, 0, Math.PI * 2); };
      recess(ctx, eye, es); eye(); ctx.fill();
      ctx.strokeStyle = rim; ctx.lineWidth = es * 0.06; eye(); ctx.stroke();
      dome(ctx, eye, es * 0.8);
      ctx.fillStyle = pupil;
      ctx.beginPath(); ctx.ellipse(x - es * 0.17, y - es * 0.26 * open, es * 0.2, es * 0.2 * open, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + es * 0.18, y + es * 0.22 * open, es * 0.07, 0, Math.PI * 2); ctx.fill();
    } else if (look.eyes === "round") {
      const eye = () => { ctx.beginPath(); ctx.ellipse(0, 0, es * 0.92, es * 1.12 * open * stretch, 0, 0, Math.PI * 2); };
      recess(ctx, eye, es); eye(); ctx.fill();
      ctx.save(); eye(); ctx.clip();
      ctx.fillStyle = pupil;
      ctx.beginPath(); ctx.arc(lx * es * 0.38, ly * es * 0.38 - es * 0.08, es * 0.44, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(-lx * es * 0.1 + es * 0.42, es * 0.5, es * 0.12, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = rim; ctx.lineWidth = es * 0.06; eye(); ctx.stroke();
      dome(ctx, eye, es);
    } else if (look.eyes === "sleepy") {
      const x = lx * es * 0.25;
      const lid = () => { ctx.beginPath(); ctx.ellipse(x, es * 0.25, es * 0.7, es * 0.42 * open * stretch, 0, 0, Math.PI); ctx.closePath(); };
      recess(ctx, lid, es); lid(); ctx.fill();
      dome(ctx, lid, es * 0.7);
      line(() => { ctx.beginPath(); ctx.moveTo(-es * 0.85, es * 0.16); ctx.quadraticCurveTo(0, es * 0.02, es * 0.85, es * 0.16); }, es * 0.22);
      ctx.fillStyle = pupil;
      ctx.beginPath(); ctx.arc(x - es * 0.15, es * 0.36, es * 0.12 * open, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
}

/**
 * Something the orb wears, in the same units as the eyes, drawn as a lit
 * object in the UI's own colours: neutral surfaces, with the accent only in
 * small lights.
 */
function drawProp(ctx: Ctx, look: OrbStyle, r: number, t: number, level: number, mode: OrbState, turn: Turn) {
  const color = look.propColor;
  const base = mix(hexToRgb(color), ZINC, 0.55);
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  // What sits on top rides round with the turn a little, less than the face does.
  if (!["headphones", "glasses"].includes(look.prop)) ctx.translate(Math.sin(turn.yaw) * r * 0.3, Math.sin(turn.pitch) * r * 0.12);
  switch (look.prop) {
    case "headphones": {
      const shift = Math.sin(turn.yaw) * r * 0.08;
      lift(ctx, r);
      ctx.strokeStyle = material(ctx, color, -r * 1.2, -r * 0.4); ctx.lineWidth = r * 0.11;
      ctx.beginPath(); ctx.arc(shift, 0, r * 1.1, Math.PI * 1.12, Math.PI * 1.88); ctx.stroke();
      unlift(ctx);
      ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = r * 0.02;
      ctx.beginPath(); ctx.arc(shift, -r * 0.02, r * 1.1, Math.PI * 1.2, Math.PI * 1.8); ctx.stroke();
      for (const side of [-1, 1]) {
        // The cup the face turns away from comes forward and grows; the other goes round behind.
        const near = Math.min(1.3, Math.max(0.45, 1 - side * Math.sin(turn.yaw) * 1.1));
        const w = r * 0.24 * near, h = r * 0.54 * (0.85 + near * 0.15);
        const x = side * r * 1.06 * Math.cos(turn.yaw * 0.5) + shift - w / 2, y = -h / 2;
        lift(ctx, r);
        ctx.fillStyle = material(ctx, color, y, y + h);
        ctx.beginPath(); ctx.roundRect(x, y, w, h, r * 0.1); ctx.fill();
        unlift(ctx);
        ctx.fillStyle = css(shade(base, -0.65));
        ctx.beginPath(); ctx.roundRect(x + (side < 0 ? w * 0.55 : 0), y + h * 0.12, w * 0.45, h * 0.76, r * 0.05); ctx.fill();
        gloss(ctx, x + w * 0.4, y + h * 0.2, w * 0.3, h * 0.12, 0.45);
        ctx.fillStyle = css(ACCENT, 0.5 + level * 0.5); ctx.shadowColor = css(ACCENT, 0.8); ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.arc(x + w * (side < 0 ? 0.28 : 0.72), y + h * 0.82, r * 0.02, 0, Math.PI * 2); ctx.fill();
        unlift(ctx);
      }
      break;
    }
    case "antenna": {
      const sway = Math.sin(t * 1.7) * r * 0.06;
      lift(ctx, r);
      ctx.strokeStyle = material(ctx, color, -r * 1.45, -r * 0.95); ctx.lineWidth = r * 0.04;
      ctx.beginPath(); ctx.moveTo(0, -r * 0.96); ctx.quadraticCurveTo(sway * 0.4, -r * 1.2, sway, -r * 1.42); ctx.stroke();
      ctx.fillStyle = material(ctx, color, -r * 1.02, -r * 0.92);
      ctx.beginPath(); ctx.ellipse(0, -r * 0.97, r * 0.09, r * 0.04, 0, 0, Math.PI * 2); ctx.fill();
      unlift(ctx);
      ball(ctx, sway, -r * 1.45, r * 0.085, base);
      ctx.fillStyle = css(ACCENT, 0.35 + level * 0.6); ctx.shadowColor = css(ACCENT, 0.9); ctx.shadowBlur = 8 + level * 16;
      ctx.beginPath(); ctx.arc(sway, -r * 1.45, r * 0.035, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "crown": {
      const y = -r * 0.84;
      const tips: [number, number][] = [[-r * 0.44, y - r * 0.34], [0, y - r * 0.44], [r * 0.44, y - r * 0.34]];
      lift(ctx, r);
      ctx.fillStyle = material(ctx, color, y - r * 0.44, y + r * 0.04);
      ctx.beginPath(); ctx.moveTo(-r * 0.44, y); ctx.lineTo(...tips[0]); ctx.lineTo(-r * 0.22, y - r * 0.15); ctx.lineTo(...tips[1]);
      ctx.lineTo(r * 0.22, y - r * 0.15); ctx.lineTo(...tips[2]); ctx.lineTo(r * 0.44, y); ctx.closePath(); ctx.fill();
      unlift(ctx);
      ctx.strokeStyle = "rgba(255,255,255,0.3)"; ctx.lineWidth = r * 0.015; ctx.stroke();
      ctx.fillStyle = css(shade(base, -0.35));
      ctx.beginPath(); ctx.roundRect(-r * 0.46, y - r * 0.05, r * 0.92, r * 0.09, r * 0.03); ctx.fill();
      gloss(ctx, -r * 0.15, y - r * 0.12, r * 0.2, r * 0.05, 0.35);
      for (const [x, ty] of tips) ball(ctx, x, ty, r * 0.045, mix(ACCENT, ZINC, 0.45));
      break;
    }
    case "halo": {
      const bob = Math.sin(t * 1.4) * r * 0.04;
      const y = -r * 1.22 + bob;
      ctx.shadowColor = css(shade(base, 0.4), 0.6); ctx.shadowBlur = 16;
      ctx.strokeStyle = css(shade(base, -0.4)); ctx.lineWidth = r * 0.075;
      ctx.beginPath(); ctx.ellipse(0, y + r * 0.012, r * 0.55, r * 0.13, 0, 0, Math.PI * 2); ctx.stroke();
      unlift(ctx);
      ctx.strokeStyle = css(shade(base, 0.35)); ctx.lineWidth = r * 0.04;
      ctx.beginPath(); ctx.ellipse(0, y - r * 0.008, r * 0.55, r * 0.13, 0, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.45)"; ctx.lineWidth = r * 0.012;
      ctx.beginPath(); ctx.ellipse(0, y - r * 0.02, r * 0.5, r * 0.1, 0, Math.PI * 1.3, Math.PI * 1.7); ctx.stroke();
      break;
    }
    case "party": {
      ctx.translate(r * 0.3, -r * 0.86); ctx.rotate(0.35 + Math.sin(t * 1.5) * 0.04);
      lift(ctx, r);
      const cone = ctx.createLinearGradient(-r * 0.3, 0, r * 0.3, 0);
      cone.addColorStop(0, css(shade(base, 0.45))); cone.addColorStop(0.45, css(base)); cone.addColorStop(1, css(shade(base, -0.6)));
      ctx.fillStyle = cone;
      ctx.beginPath(); ctx.moveTo(-r * 0.3, 0); ctx.lineTo(0, -r * 0.74); ctx.lineTo(r * 0.3, 0); ctx.closePath(); ctx.fill();
      unlift(ctx);
      ctx.save(); ctx.clip();
      ctx.strokeStyle = css(mix(ACCENT, ZINC, 0.5), 0.55); ctx.lineWidth = r * 0.05;
      for (let i = 1; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(-r * 0.35, -r * 0.18 * i); ctx.lineTo(r * 0.35, -r * 0.18 * i - r * 0.09); ctx.stroke(); }
      ctx.restore();
      ctx.fillStyle = css(shade(base, -0.4));
      ctx.beginPath(); ctx.ellipse(0, 0, r * 0.3, r * 0.05, 0, 0, Math.PI); ctx.fill();
      ball(ctx, 0, -r * 0.77, r * 0.08, shade(base, 0.3));
      break;
    }
    case "glasses": {
      const { ex, ey, es } = faceOf(r, mode, level);
      const h = es * 2;
      const lenses = [-1, 1].map((side) => { const p = eyePlace(r, ex, ey, side, turn); return { ...p, w: es * 2.4 * p.fx }; });
      const [left, right] = lenses;
      lift(ctx, r);
      ctx.strokeStyle = material(ctx, color, left.y - h / 2, left.y + h / 2); ctx.lineWidth = r * 0.045;
      for (const l of lenses) { ctx.beginPath(); ctx.roundRect(l.x - l.w / 2, l.y - h / 2, l.w, h, r * 0.09 * l.fx); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(left.x + left.w / 2, left.y - h * 0.12); ctx.quadraticCurveTo((left.x + right.x) / 2, left.y - h * 0.35, right.x - right.w / 2, right.y - h * 0.12); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(left.x - left.w / 2, left.y - h * 0.2); ctx.lineTo(-r * 0.95 * Math.cos(turn.yaw) + Math.sin(turn.yaw) * r * 0.2, left.y - h * 0.32);
      ctx.moveTo(right.x + right.w / 2, right.y - h * 0.2); ctx.lineTo(r * 0.95 * Math.cos(turn.yaw) + Math.sin(turn.yaw) * r * 0.2, right.y - h * 0.32);
      ctx.stroke();
      unlift(ctx);
      for (const l of lenses) {
        const lens = ctx.createLinearGradient(l.x - l.w / 2, l.y - h / 2, l.x + l.w / 2, l.y + h / 2);
        lens.addColorStop(0, "rgba(255,255,255,0.22)"); lens.addColorStop(0.5, "rgba(255,255,255,0.04)"); lens.addColorStop(1, "rgba(255,255,255,0.12)");
        ctx.fillStyle = lens; ctx.beginPath(); ctx.roundRect(l.x - l.w / 2, l.y - h / 2, l.w, h, r * 0.09 * l.fx); ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = r * 0.012;
        ctx.beginPath(); ctx.moveTo(l.x - l.w * 0.3, l.y - h * 0.28); ctx.lineTo(l.x - l.w * 0.05, l.y - h * 0.36); ctx.stroke();
      }
      break;
    }
    case "bow": {
      ctx.translate(r * 0.55, -r * 0.8); ctx.rotate(0.5);
      lift(ctx, r);
      for (const side of [-1, 1]) {
        const lobe = ctx.createRadialGradient(side * r * 0.14, -r * 0.08, r * 0.02, side * r * 0.18, 0, r * 0.3);
        lobe.addColorStop(0, css(shade(base, 0.5))); lobe.addColorStop(0.5, css(base)); lobe.addColorStop(1, css(shade(base, -0.55)));
        ctx.fillStyle = lobe;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(side * r * 0.28, -r * 0.3, side * r * 0.37, 0); ctx.quadraticCurveTo(side * r * 0.28, r * 0.3, 0, 0); ctx.fill();
      }
      unlift(ctx);
      ball(ctx, 0, 0, r * 0.085, shade(base, -0.1));
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
      // Where the face looks: about while idle, up toward you while listening.
      const gx = reduced ? 0 : Math.sin(t * 0.9) * (mode === "idle" ? 0.9 : 0.35);
      const gy = reduced ? 0 : mode === "input" ? -0.45 : Math.cos(t * 0.6) * 0.4;
      const turn = { yaw: gx * 0.32, pitch: gy * 0.18 };
      if (look.eyes !== "none") {
        if (!reduced && timestamp > nextBlink) { blinkAt = timestamp; nextBlink = timestamp + (2200 + Math.random() * 3200) / motion.blink; }
        const blinking = timestamp - blinkAt < 160;
        const open = mode === "muted" ? 0 : blinking ? Math.abs(Math.cos((timestamp - blinkAt) / 160 * Math.PI)) : 1;
        drawEyes(ctx, look, r, mode, level, open, gx, gy, turn);
      }
      if (look.prop !== "none") drawProp(ctx, look, r, t, level, mode, turn);
      ctx.restore();
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [levels]);
  return <canvas ref={canvas} aria-hidden="true" className="voice-orb" data-mode={mode} />;
}
