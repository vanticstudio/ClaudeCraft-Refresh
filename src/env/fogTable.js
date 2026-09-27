// Per-biome fog (B8 §3, 19-BUILDOUT-v1.3.md). Pure data + one pure blend
// helper, both node-testable (scripts/checks/u19-weather.mjs).
//
// Structure mirrors gen/biomes.js's BIOME_TEMPS: a dense array indexed by
// biome id 0..11, each row { near, far, tint }:
//   near/far — FRACTIONS of the fog span R = RENDER_RADIUS * 16. The render
//     radius is runtime-adjustable (slider 4..20, constants.js §Streaming), so
//     fog must scale with it: absolute block distances would either swallow the
//     loaded ring or float past it at other slider settings. PLAINS is
//     deliberately identical to the pre-B8 clear-sky fog (0.75·R .. R, neutral
//     tint) — the default biome is a zero-regression baseline.
//   tint — linear [r,g,b] 0..1 multiplier on the time-of-day fog color
//     (DayNight.kf.fog, already weather-desaturated): night darkens every biome
//     naturally and rain grays it; the tint only shifts hue per biome.
//   Spec targets: OCEAN/RIVER denser + bluer; DESERT warmer + further; SNOWY
//   pale; TAIGA cool.
export const FOG_BY_BIOME = [
  { near: 0.10, far: 0.60, tint: [0.55, 0.70, 1.00] },   // 0  OCEAN
  { near: 0.55, far: 1.00, tint: [0.88, 0.90, 0.98] },   // 1  BEACH
  { near: 0.12, far: 0.60, tint: [0.55, 0.72, 1.00] },   // 2  RIVER
  { near: 0.75, far: 1.00, tint: [1.00, 1.00, 1.00] },   // 3  PLAINS — pre-B8 baseline
  { near: 0.55, far: 0.95, tint: [0.82, 0.90, 0.86] },   // 4  FOREST
  { near: 0.55, far: 0.95, tint: [0.85, 0.91, 0.90] },   // 5  BIRCH_FOREST
  { near: 0.80, far: 1.00, tint: [1.00, 0.90, 0.72] },   // 6  DESERT
  { near: 0.65, far: 1.00, tint: [0.96, 0.90, 0.76] },   // 7  SAVANNA
  { near: 0.50, far: 0.90, tint: [0.76, 0.86, 0.98] },   // 8  TAIGA
  { near: 0.45, far: 0.88, tint: [0.94, 0.96, 1.00] },   // 9  SNOWY_TUNDRA
  { near: 0.60, far: 1.00, tint: [0.88, 0.92, 1.00] },   // 10 MOUNTAINS
  { near: 0.30, far: 0.80, tint: [0.35, 0.30, 0.48] },   // 11 THE_END (never rendered: DayNight skips the blend in no-sky dims)
  // B12 — the Hollow: dense, dark, teal — the growths' glow reads through it
  { near: 0.10, far: 0.45, tint: [0.30, 0.42, 0.44] },   // 12 HOLLOW
];

// B8 §3 — "smooth lerp over 2 s": exponential approach whose residual decays to
// 0.1 % after FOG_TAU seconds (rate = −ln(0.001)/τ). Exponential rather than
// fixed-speed: frame-rate independent, never overshoots, so biome-border
// crossings and rain ramping cannot pop the fog.
export const FOG_TAU = 2;
const FOG_RATE = -Math.log(0.001) / FOG_TAU;

// Advance `cur` toward `tgt` over dtSec seconds. Pure: mutates + returns cur.
// Shape of cur/tgt: { near, far, r, g, b }; tgt is read only, never retained.
export function blendFog(cur, tgt, dtSec) {
  if (!(dtSec > 0) || !tgt) return cur;
  const f = 1 - Math.exp(-dtSec * FOG_RATE);
  cur.near += (tgt.near - cur.near) * f;
  cur.far += (tgt.far - cur.far) * f;
  cur.r += (tgt.r - cur.r) * f;
  cur.g += (tgt.g - cur.g) * f;
  cur.b += (tgt.b - cur.b) * f;
  return cur;
}