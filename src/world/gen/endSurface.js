// 11-END — shared End noise + outer-island surface math, used by BOTH the End
// generator (end.js) and the end-city planner (endCity.js) so they agree on where
// land is. Pure, worker-safe.
import { posHash } from '../../math/rng.js';

const smooth = t => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

export function noise2(seed, x, z) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = smooth(x - x0), fz = smooth(z - z0);
  const h = (xi, zi) => posHash(seed, xi, 0, zi) * 2 - 1;
  return lerp(lerp(h(x0, z0), h(x0 + 1, z0), fx), lerp(h(x0, z0 + 1), h(x0 + 1, z0 + 1), fx), fz);
}
export function fbm2(seed, x, z, oct, freq) {
  let amp = 1, sum = 0, norm = 0, f = freq;
  for (let o = 0; o < oct; o++) { sum += amp * noise2(seed, x * f, z * f); norm += amp; amp *= 0.5; f *= 2; }
  return sum / norm;
}
export function smoothstep(a, b, v) { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); }

// §8.1 — outer-island column at (x,z) with distance d, or null (void/gap).
export function outerColumn(s, x, z, d) {
  const t = smoothstep(1000, 1040, d);
  const n = fbm2(s.outer, x, z, 4, 1 / 90);
  if (n * t <= 0.28) return null;
  const m = (n * t - 0.28) / 0.72;
  const surfY = Math.round(55 + 10 * fbm2(s.outerT, x, z, 3, 1 / 70));
  // `m` is carried out so §12.1's city gate reads the SAME island mass that sets
  // the column's thickness here (3 + 24m) instead of re-deriving the noise.
  return { surfY, botY: Math.max(0, surfY - Math.round(3 + 24 * m)), m };
}

// Outer-island column at (wx,wz) — { surfY, botY, m } — or null. §12.1's city
// gate needs surface AND mass, so both callers stay on one evaluation.
export function endColumnAt(s, wx, wz) {
  const d = Math.hypot(wx, wz);
  if (d < 1000) return null;
  return outerColumn(s, wx, wz, d);
}

// Outer-island surface Y at a column, or null. (End cities gate on land here.)
export function endSurfaceAt(s, wx, wz) {
  const col = endColumnAt(s, wx, wz);
  return col ? col.surfY : null;
}
