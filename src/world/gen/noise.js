// 02 §4–§6 — noise stack, stride-4 lattice sampling, height composition,
// canonical heightAt/biomeAt/climate, cheese field, column LRU cache.
//
// Everything any consumer samples goes through the world-aligned lattice
// (02 §4.4): 2D layers are evaluated (full fbm) at coords divisible by 4 and
// bilinearly interpolated; the 3D cheese field uses stride 4 with trilinear
// interpolation. Lattice-point values are memoized per layer so the batch
// (per-chunk) path and any single-cell query return bit-identical numbers.

import { createNoise2D, createNoise3D } from 'simplex-noise';
import alea from 'alea';
import { hashString, mix32 } from '../../math/rng.js';
import { selectBiome, surfaceBlockFor } from './biomes.js';

export const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(a, b, v) {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

// 02 §4.2
function fbm2(noise, x, z, { oct, freq, lac = 2.0, pers = 0.5 }) {
  let amp = 1, f = freq, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * noise(x * f, z * f);
    norm += amp; amp *= pers; f *= lac;
  }
  return sum / norm;
}

function ridged2(noise, x, z, { oct, freq, lac = 2.0, pers = 0.5 }) {
  let amp = 1, f = freq, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(noise(x * f, z * f));
    n *= n;
    sum += amp * n; norm += amp; amp *= pers; f *= lac;
  }
  return sum / norm;
}

// 02 §4.3 — the complete layer table; no other noise exists.
const LAYER_DEFS = [
  ['continental', { oct: 4, freq: 1 / 1100 }, false],
  ['erosion',     { oct: 4, freq: 1 / 700 }, false],
  ['rough',       { oct: 5, freq: 1 / 140, pers: 0.55 }, false],
  ['mountain',    { oct: 4, freq: 1 / 380 }, true],
  ['river',       { oct: 3, freq: 1 / 850 }, false],
  ['temp',        { oct: 3, freq: 1 / 1600 }, false],
  ['humid',       { oct: 3, freq: 1 / 1300 }, false],
];

// 02 §5.1 — base height spline over continentalness
const SPLINE_C = [-1.00, -0.50, -0.20, -0.10, 0.00, 0.30, 0.60, 1.00];
const SPLINE_H = [46, 48, 54, 62, 66, 69, 72, 74];
function splineC(c) {
  if (c <= SPLINE_C[0]) return SPLINE_H[0];
  for (let i = 1; i < SPLINE_C.length; i++) {
    if (c <= SPLINE_C[i]) {
      const t = (c - SPLINE_C[i - 1]) / (SPLINE_C[i] - SPLINE_C[i - 1]);
      return lerp(SPLINE_H[i - 1], SPLINE_H[i], t);
    }
  }
  return SPLINE_H[SPLINE_H.length - 1];
}

// 02 §5.2 — height composition from lattice-interpolated inputs.
// Returns { height (int 40..124), riv (river mask 0..1) }.
export function composeColumn(c, e, r, m, rv) {
  const base = splineC(c);
  const flatness = clamp01(0.5 * (e + 1));
  const landMask = smoothstep(-0.10, 0.05, c);
  const hillAmp = lerp(16, 3, flatness);
  const hills = r * hillAmp * landMask;
  const seabed = r * 2.5 * (1 - landMask);
  const mtnMask = smoothstep(0.18, 0.55, c) * (1 - smoothstep(-0.35, 0.35, e));
  const mtn = m * 52 * mtnMask;
  let height = base + hills + seabed + mtn;
  const riv = 1 - smoothstep(0.025, 0.06, Math.abs(rv));
  if (riv > 0 && height > 56) {
    const bedTarget = 59 - 2 * riv;
    height = Math.min(height, lerp(height, bedTarget, Math.min(1, riv * 1.6)));
  }
  return { height: Math.max(40, Math.min(124, Math.round(height))), riv };
}

const bilerp = (v00, v10, v01, v11, fx, fz) =>
  lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fz);

const trilerp = (c000, c100, c010, c110, c001, c101, c011, c111, fx, fy, fz) =>
  lerp(
    lerp(lerp(c000, c100, fx), lerp(c010, c110, fx), fy),
    lerp(lerp(c001, c101, fx), lerp(c011, c111, fx), fy),
    fz);

function makeLRU(cap) {
  const m = new Map();
  return {
    get(k) {
      if (!m.has(k)) return undefined;
      const v = m.get(k);
      m.delete(k); m.set(k, v);
      return v;
    },
    set(k, v) {
      if (m.has(k)) m.delete(k);
      else if (m.size >= cap) m.delete(m.keys().next().value);
      m.set(k, v);
    },
  };
}

// Numeric keys: lattice ix,iz ∈ ±262144 covers |x|,|z| ≤ 1,048,575 (world border)
const key2 = (ix, iz) => (ix + 262144) * 524288 + (iz + 262144);
const key3 = (ix, iy, iz) => ((ix + 262144) * 33 + iy) * 524288 + (iz + 262144);
const chunkKeyN = (cx, cz) => cx * 131072 + cz;

export function createNoiseCtx(worldSeed) {
  // One sub-seed per system (02 §2.2)
  const seeds = {};
  // 12-VILLAGES AMENDS 02 §2.2 — 'village' appended; each stream is independent,
  // so adding it leaves every existing stream (and world) byte-identical.
  for (const s of ['terrain', 'carver', 'ore', 'tree', 'plant', 'herd', 'detail', 'village']) {
    seeds[s] = mix32(worldSeed ^ hashString('sys:' + s));
  }

  // Layer instances (02 §4.1)
  const layers = LAYER_DEFS.map(([name, params, ridged]) => ({
    name, params, ridged,
    fn: createNoise2D(alea(`${worldSeed}:${name}`)),
    memo: new Map(), // lattice-point fbm values
  }));
  const cheese3 = createNoise3D(alea(`${worldSeed}:cheese`));
  const cheeseMemo = new Map();

  // Full-fbm value of a layer at lattice point (ix*4, iz*4), memoized.
  function latticePoint(layer, ix, iz) {
    const k = key2(ix, iz);
    let v = layer.memo.get(k);
    if (v === undefined) {
      const x = ix * 4, z = iz * 4;
      v = layer.ridged ? ridged2(layer.fn, x, z, layer.params)
                       : fbm2(layer.fn, x, z, layer.params);
      if (layer.memo.size > 200000) layer.memo.clear();
      layer.memo.set(k, v);
    }
    return v;
  }

  // Anisotropic cheese composite (02 §4.3) at lattice point (ix*4, iy*4, iz*4)
  function cheeseLatticePoint(ix, iy, iz) {
    const k = key3(ix, iy, iz);
    let v = cheeseMemo.get(k);
    if (v === undefined) {
      const x = ix * 4, y = iy * 4, z = iz * 4;
      const n1 = cheese3(x / 56, y / 24, z / 56);
      const n2 = cheese3(x / 28, y / 12, z / 28);
      v = (n1 + 0.45 * n2) / 1.45;
      if (cheeseMemo.size > 200000) cheeseMemo.clear();
      cheeseMemo.set(k, v);
    }
    return v;
  }

  // --- Canonical per-chunk column data (LRU 128, 02 §4.4) ---
  const colCache = makeLRU(128);

  function columnData(cx, cz) {
    const k = chunkKeyN(cx, cz);
    let cd = colCache.get(k);
    if (cd) return cd;

    // 5×5 lattice per layer for this chunk (world-aligned: cx*4 + 0..4)
    const lat = layers.map(layer => {
      const a = new Float64Array(25);
      for (let gx = 0; gx <= 4; gx++)
        for (let gz = 0; gz <= 4; gz++)
          a[gx * 5 + gz] = latticePoint(layer, cx * 4 + gx, cz * 4 + gz);
      return a;
    });
    const [C, E, R, M, RV, T, H] = lat;

    const h = new Uint8Array(256);
    const biome = new Uint8Array(256);
    const t = new Float64Array(256);
    for (let x = 0; x < 16; x++) {
      const gx = x >> 2, fx = (x & 3) / 4;
      for (let z = 0; z < 16; z++) {
        const gz = z >> 2, fz = (z & 3) / 4;
        const i00 = gx * 5 + gz;
        const c  = bilerp(C[i00], C[i00 + 5], C[i00 + 1], C[i00 + 6], fx, fz);
        const e  = bilerp(E[i00], E[i00 + 5], E[i00 + 1], E[i00 + 6], fx, fz);
        const r  = bilerp(R[i00], R[i00 + 5], R[i00 + 1], R[i00 + 6], fx, fz);
        const m  = bilerp(M[i00], M[i00 + 5], M[i00 + 1], M[i00 + 6], fx, fz);
        const rv = bilerp(RV[i00], RV[i00 + 5], RV[i00 + 1], RV[i00 + 6], fx, fz);
        const tv = bilerp(T[i00], T[i00 + 5], T[i00 + 1], T[i00 + 6], fx, fz);
        const hv = bilerp(H[i00], H[i00 + 5], H[i00 + 1], H[i00 + 6], fx, fz);
        const { height, riv } = composeColumn(c, e, r, m, rv);
        const ci = (z << 4) | x;
        h[ci] = height;
        t[ci] = tv;
        biome[ci] = selectBiome(height, c, riv, tv, hv);
      }
    }
    cd = { h, biome, t };
    colCache.set(k, cd);
    return cd;
  }

  function heightAt(x, z) {
    x = Math.floor(x); z = Math.floor(z);
    return columnData(x >> 4, z >> 4).h[((z & 15) << 4) | (x & 15)];
  }
  function biomeAt(x, z) {
    x = Math.floor(x); z = Math.floor(z);
    return columnData(x >> 4, z >> 4).biome[((z & 15) << 4) | (x & 15)];
  }
  function tempAt(x, z) {
    x = Math.floor(x); z = Math.floor(z);
    return columnData(x >> 4, z >> 4).t[((z & 15) << 4) | (x & 15)];
  }
  function surfaceBlockOf(x, z) {
    x = Math.floor(x); z = Math.floor(z);
    const cd = columnData(x >> 4, z >> 4);
    const ci = ((z & 15) << 4) | (x & 15);
    return surfaceBlockFor(cd.biome[ci], cd.h[ci]);
  }

  // Gen-time water is a pure function (02 §8.4)
  const isGenWater = (x, y, z) => y <= 63 && y > heightAt(x, z);

  // --- Cheese sampling ---

  // Per-chunk lattice grid 5×33×5 (x, y, z), index (gy*5 + gz)*5 + gx
  function cheeseGrid(cx, cz) {
    const g = new Float64Array(5 * 33 * 5);
    for (let gy = 0; gy <= 32; gy++)
      for (let gz = 0; gz <= 4; gz++)
        for (let gx = 0; gx <= 4; gx++)
          g[(gy * 5 + gz) * 5 + gx] = cheeseLatticePoint(cx * 4 + gx, gy, cz * 4 + gz);
    return g;
  }

  // Trilinear from a chunk grid at LOCAL coords (lx,lz ∈ 0..15, y ∈ 0..127)
  function cheeseFromGrid(g, lx, y, lz) {
    const gx = lx >> 2, fx = (lx & 3) / 4;
    const gy = y >> 2, fy = (y & 3) / 4;
    const gz = lz >> 2, fz = (lz & 3) / 4;
    const b = (gy * 5 + gz) * 5 + gx;
    const b1 = ((gy + 1) * 5 + gz) * 5 + gx;
    return trilerp(
      g[b], g[b + 1], g[b1], g[b1 + 1],
      g[b + 5], g[b + 6], g[b1 + 5], g[b1 + 6],
      fx, fy, fz);
  }

  // Single-cell cheese at world coords — same memoized lattice values as the
  // grid path, so both agree exactly.
  function cheeseAt(x, y, z) {
    const ix = Math.floor(x / 4), iy = y >> 2, iz = Math.floor(z / 4);
    const fx = (x - ix * 4) / 4, fy = (y & 3) / 4, fz = (z - iz * 4) / 4;
    return trilerp(
      cheeseLatticePoint(ix, iy, iz),     cheeseLatticePoint(ix + 1, iy, iz),
      cheeseLatticePoint(ix, iy + 1, iz), cheeseLatticePoint(ix + 1, iy + 1, iz),
      cheeseLatticePoint(ix, iy, iz + 1),     cheeseLatticePoint(ix + 1, iy, iz + 1),
      cheeseLatticePoint(ix, iy + 1, iz + 1), cheeseLatticePoint(ix + 1, iy + 1, iz + 1),
      fx, fy, fz);
  }

  const cheeseThreshold = depth => 0.58 + 0.34 * clamp01(1 - depth / 24);

  // Would the cheese carver open this cell? (used for cross-chunk ore
  // air-exposure tests, 02 §9.1 — includes the water guard for parity with
  // the in-chunk carve.)
  function carvedByCheese(x, y, z) {
    if (y < 4) return false;
    const h = heightAt(x, z);
    if (y > h) return false;
    if (cheeseAt(x, y, z) <= cheeseThreshold(h - y)) return false;
    if (y <= 63) {
      if (y === h && y + 1 <= 63) return false; // +y neighbor is gen water
      if (isGenWater(x + 1, y, z) || isGenWater(x - 1, y, z) ||
          isGenWater(x, y, z + 1) || isGenWater(x, y, z - 1)) return false;
    }
    return true;
  }

  return {
    worldSeed, seeds,
    columnData, heightAt, biomeAt, tempAt, surfaceBlockOf, isGenWater,
    cheeseGrid, cheeseFromGrid, cheeseAt, cheeseThreshold, carvedByCheese,
  };
}
