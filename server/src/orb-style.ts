/**
 * How the voice-mode orb looks and moves: one setting for the whole portal,
 * kept by the server so every device shows the same orb.
 *
 * Shared by the server, which checks what it is given, and by the page, which
 * draws it — so a personality means the same thing in both places.
 */

export type OrbState = "idle" | "input" | "output" | "muted";
export type OrbPersonality = "balanced" | "calm" | "lively" | "playful" | "focused";

/** How a personality moves. Multipliers are against the balanced orb. */
export interface OrbMotion {
  /** Lobes of the two waves around the edge: the first always moves, the second only with sound. */
  lobes: [number, number];
  /** How far the edge moves. */
  wave: number;
  /** How quickly the level rises to meet a sound, and falls after it (0–1 per frame). */
  attack: number;
  release: number;
  /** Rings drawn around the sphere. */
  rings: number;
  /** A gentle swell of the whole orb, as a share of its size. */
  bounce: number;
  /** How far the rings tilt as they drift. */
  wobble: number;
  /** Speed of the slow drift. */
  drift: number;
  /** How often the eyes blink, against the balanced orb. */
  blink: number;
}

export const ORB_PERSONALITIES: Record<OrbPersonality, OrbMotion> = {
  balanced: { lobes: [3, 5], wave: 1, attack: 0.3, release: 0.09, rings: 2, bounce: 0, wobble: 0.12, drift: 1, blink: 1 },
  calm: { lobes: [2, 3], wave: 0.6, attack: 0.16, release: 0.05, rings: 2, bounce: 0.012, wobble: 0.06, drift: 0.55, blink: 0.6 },
  lively: { lobes: [4, 7], wave: 1.35, attack: 0.45, release: 0.14, rings: 3, bounce: 0, wobble: 0.18, drift: 1.5, blink: 1.4 },
  playful: { lobes: [3, 6], wave: 1.25, attack: 0.4, release: 0.12, rings: 3, bounce: 0.03, wobble: 0.3, drift: 1.3, blink: 1.6 },
  focused: { lobes: [6, 9], wave: 0.5, attack: 0.35, release: 0.12, rings: 1, bounce: 0, wobble: 0.03, drift: 0.8, blink: 0.7 },
};

/** Eyes on the face of the orb. "none" is the plain orb. */
export const ORB_EYES = ["none", "dots", "round", "happy", "sleepy", "visor"] as const;
export type OrbEyes = (typeof ORB_EYES)[number];

/** Something the orb wears. */
export const ORB_PROPS = ["none", "headphones", "antenna", "crown", "halo", "party", "glasses", "bow"] as const;
export type OrbProp = (typeof ORB_PROPS)[number];

export type OrbColors = Record<OrbState, string>;

/** Aurora is the orb as it always was. */
export const ORB_PALETTES: Record<string, OrbColors> = {
  aurora: { idle: "#82bcff", input: "#53f7d7", output: "#be9fff", muted: "#a1b3cc" },
  ember: { idle: "#ffb27a", input: "#ffd166", output: "#ff7a7a", muted: "#c9b2a6" },
  forest: { idle: "#7fd8a4", input: "#c6f36b", output: "#4fc3a1", muted: "#a7bfae" },
  rose: { idle: "#f7a1c4", input: "#ffd1e8", output: "#ff7eb6", muted: "#c7aebb" },
  mono: { idle: "#c9d3e0", input: "#ffffff", output: "#aab8cc", muted: "#7f8a99" },
};

export interface OrbStyle {
  personality: OrbPersonality;
  /** The palette the colors came from, or "custom" once one was changed by hand. */
  palette: string;
  colors: OrbColors;
  /** Multipliers on the personality: how fast it drifts, how strongly it answers sound, how much it glows. */
  speed: number;
  reactivity: number;
  glow: number;
  /** The translucent ribbons inside the sphere. */
  ribbons: boolean;
  eyes: OrbEyes;
  eyeColor: string;
  prop: OrbProp;
  propColor: string;
}

export const DEFAULT_ORB: OrbStyle = {
  personality: "balanced",
  palette: "aurora",
  colors: { ...ORB_PALETTES.aurora },
  speed: 1,
  reactivity: 1,
  glow: 1,
  ribbons: true,
  eyes: "none",
  eyeColor: "#111111",
  prop: "none",
  propColor: "#a1a1aa",
};

const HEX = /^#[0-9a-f]{6}$/i;
const STATES: OrbState[] = ["idle", "input", "output", "muted"];

/** A #rrggbb colour, lower-cased; anything else is the default. */
function hex(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX.test(value) ? value.toLowerCase() : fallback;
}

/** Within bounds, rounded to two places; anything else is the default. */
function between(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value)) * 100) / 100 : fallback;
}

/**
 * A style made safe to draw: unknown personalities, palettes and colors fall
 * back to the default, and numbers are held within what the orb can show.
 * What was stored before a field existed reads as that field's default.
 */
export function normalizeOrb(value: unknown): OrbStyle {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const personality = typeof v.personality === "string" && v.personality in ORB_PERSONALITIES ? (v.personality as OrbPersonality) : DEFAULT_ORB.personality;
  const given = (v.colors && typeof v.colors === "object" ? v.colors : {}) as Record<string, unknown>;
  const colors = Object.fromEntries(STATES.map((s) => [s, hex(given[s], DEFAULT_ORB.colors[s])])) as OrbColors;
  const palette = typeof v.palette === "string" && (v.palette in ORB_PALETTES || v.palette === "custom") ? v.palette : DEFAULT_ORB.palette;
  return {
    personality,
    palette,
    colors,
    speed: between(v.speed, 0.25, 2.5, DEFAULT_ORB.speed),
    reactivity: between(v.reactivity, 0, 2.5, DEFAULT_ORB.reactivity),
    glow: between(v.glow, 0, 2, DEFAULT_ORB.glow),
    ribbons: typeof v.ribbons === "boolean" ? v.ribbons : DEFAULT_ORB.ribbons,
    eyes: (ORB_EYES as readonly unknown[]).includes(v.eyes) ? (v.eyes as OrbEyes) : DEFAULT_ORB.eyes,
    eyeColor: hex(v.eyeColor, DEFAULT_ORB.eyeColor),
    prop: (ORB_PROPS as readonly unknown[]).includes(v.prop) ? (v.prop as OrbProp) : DEFAULT_ORB.prop,
    propColor: hex(v.propColor, DEFAULT_ORB.propColor),
  };
}

/** "#82bcff" → [130, 188, 255]. */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
