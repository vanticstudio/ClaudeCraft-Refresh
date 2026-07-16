// Deterministic RNG primitives (01 §2 module map; 02 §2 worldgen streams).
// Pure module: safe to import from both the main thread and workers.

// xmur3 string hash → seed-generator function (used by atlas tile painters)
export function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

// mulberry32: 32-bit seeded PRNG → float [0,1)
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a 32-bit string hash (02 §2.2)
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// murmur3-style finalizer (02 §2.2)
export function mix32(h) {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// splitmix32 stream: rng() → float [0,1)  (02 §2.3)
export function splitmix32(a) {
  return function () {
    a |= 0; a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16); t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);     t = Math.imul(t, 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

export function chunkSeed(sysSeed, cx, cz) {
  let h = sysSeed;
  h ^= Math.imul(cx, 0x27d4eb2f); h = mix32(h);
  h ^= Math.imul(cz, 0x165667b1); h = mix32(h);
  return h >>> 0;
}

// Stateless per-position hash → float [0,1)  (02 §2.4)
export function posHash(seed, x, y, z) {
  let h = seed ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(z, 0xc2b2ae3d);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// Asymmetric triangular sampler (02 §2.6)
export function triSample(rng, lo, peak, hi) {
  const u = rng(), c = (peak - lo) / (hi - lo);
  return u < c
    ? lo + Math.sqrt(u * (hi - lo) * (peak - lo))
    : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - peak));
}

export const rngInt = (rng, n) => Math.floor(rng() * n);
export const rngRange = (rng, a, b) => a + rng() * (b - a);

// Deterministic trigonometry: 4096-entry sine table (02 §2.5).
const SIN = new Float32Array(4096);
for (let i = 0; i < 4096; i++) SIN[i] = Math.sin(i * Math.PI * 2 / 4096);
export const tsin = a => SIN[((a * 651.8986469) | 0) & 4095];
export const tcos = a => SIN[(((a * 651.8986469) | 0) + 1024) & 4095];
