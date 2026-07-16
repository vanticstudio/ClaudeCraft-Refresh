# 02 — WORLD GENERATION

This file specifies deterministic, infinite terrain generation for the survival world: seeding and RNG, the noise stack, height composition, biome selection, column composition (surface, filler, water, bedrock), caves and carvers, ore placement (Minecraft 1.20 data remapped to Y 0–127), surface decoration (trees, plants, snow), worldgen animal herds, world-spawn selection, and the generation worker's per-chunk output. Generation runs entirely inside the generation Web Worker per **01-ARCHITECTURE.md** (message protocol, chunk store, block-array indexing). Block ids and properties are owned by the registry in **06-ITEMS-CRAFTING-SURVIVAL.md** — this file references blocks by name only and places fluid **source** blocks only (flow mechanics live in 06). Runtime mob spawning is in **05-MOBS-COMBAT.md**; this file only emits worldgen herd data. The heightmaps and biome arrays produced here feed the lighting engine in **04-TIME-LIGHT-WEATHER.md** and the spawn point feeds **03-PLAYER.md**.

## Contents

1. [Scope decisions & registry dependencies](#1-scope-decisions--registry-dependencies)
2. [Determinism: seeds, hashing, RNG streams](#2-determinism-seeds-hashing-rng-streams)
3. [The Y remap (MC −64..320 → 0..127)](#3-the-y-remap-mc-64320--0127)
4. [Noise stack](#4-noise-stack)
5. [Height composition](#5-height-composition)
6. [Biome selection](#6-biome-selection)
7. [Column composition (terrain pass)](#7-column-composition-terrain-pass)
8. [Caves & carvers](#8-caves--carvers)
9. [Ores](#9-ores)
10. [Decoration pass (pipeline decision, trees, plants, snow)](#10-decoration-pass)
11. [Worldgen animal herds](#11-worldgen-animal-herds)
12. [World spawn point](#12-world-spawn-point)
13. [Worker pipeline & output format](#13-worker-pipeline--output-format)
14. [Performance budget](#14-performance-budget)
15. [Acceptance checklist](#15-acceptance-checklist)

---

## 1. Scope decisions & registry dependencies

### 1.1 What is generated

Infinite terrain in X/Z, columns 16×128×16 (per shared conventions: Y 0–127, sea level Y=63, bedrock floor at Y=0). Heightmap-based terrain + noise/worm cave carving + ores + decoration + herds. Every chunk is a **pure function of (worldSeed, cx, cz)** — no cross-chunk mutable state, no generation-order dependence (§10.1).

### 1.2 Explicit skip list (decided, do not implement)

| Feature | Decision | Rationale |
|---|---|---|
| Copper ore | **SKIP** | 1.20 copper's uses (spyglass, lightning rod, brush) are outside 06's survival core. Keeps registry small. Full 1.20 data noted in §9.4 for later enablement. |
| Emerald ore | **SKIP** | No villager trading in scope; emerald has no use. |
| Andesite / diorite / granite blobs | **SKIP** | Registry kept small per 06 contract. Underground texture variety comes from dirt + gravel pockets (§7.4). |
| Deepslate / tuff | **SKIP** | The compressed 128-block world has no room for a second stone band. Stone runs from filler to bedrock. |
| Structures (villages, dungeons, mineshafts, strongholds) | **SKIP** | Out of scope for this build. |
| Lake features (isolated water/lava ponds) | **SKIP** | MC 1.18+ itself removed random lake features. Rivers + oceans supply all surface water. |
| 3D density terrain (overhangs, floating islands) | **SKIP** | Terrain is heightmap-shaped; all interior voids come from carvers. See §5. |
| Acacia / jungle / dark-oak / mangrove wood sets | **SKIP** | Registry kept to oak/birch/spruce. Savanna uses sparse oak (`> Adaptation` in §6.3). |
| Clay, mossy variants, infested stone, amethyst, dripstone | **SKIP** | Registry size. |

### 1.3 Registry dependencies (blocks this file places, by 06 name)

`stone`, `dirt`, `grass_block`, `sand`, `sandstone`, `gravel`, `bedrock`, `water` (source = state 0), `lava` (source = state 0), `coal_ore`, `iron_ore`, `gold_ore`, `redstone_ore`, `lapis_ore`, `diamond_ore`, `oak_log`, `oak_leaves`, `birch_log`, `birch_leaves`, `spruce_log`, `spruce_leaves`, `cactus`, `dead_bush`, `sugar_cane_block`, `short_grass`, `dandelion`, `poppy`, `pumpkin`, `snow_layer`, `ice`, `air`.

All 31 names MUST exist in 06's registry. Generation writes raw block ids into the chunk array and **never triggers block updates** — no gravity for gen-placed sand (sandstone underlays prevent visible floaters), no fluid flow (all gen water/lava is placed as settled source blocks; 06's flow simulation activates only when a neighbor changes after gen).

---

## 2. Determinism: seeds, hashing, RNG streams

### 2.1 Requirements

1. Same seed ⇒ byte-identical chunks, regardless of the order chunks are generated, revisited, or regenerated.
2. Features that span chunk borders (trees, ore veins, cave worms) resolve identically from every chunk that overlaps them.
3. No `Math.random()` anywhere in the worker. No `Math.sin/cos` in generation code paths (engine-dependent precision) — use the sine table in §2.5.

### 2.2 World seed and sub-seeds

The user seed is a string (empty ⇒ stringified `Date.now()`). It is reduced to a 32-bit integer and each generation system derives an independent sub-seed so systems never share RNG streams:

```js
// FNV-1a 32-bit string hash
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const worldSeed = hashString(seedString);          // 32-bit uint

// One sub-seed per system. Fixed name list — adding a name never disturbs others.
export function subSeed(system) {                          // system: string
  return mix32(worldSeed ^ hashString("sys:" + system));
}
function mix32(h) {                                        // murmur3-style finalizer
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
```

System names used in this file: `"terrain"`, `"carver"`, `"ore"`, `"tree"`, `"plant"`, `"herd"`, `"detail"`.

### 2.3 Per-chunk RNG streams (sequential draws)

Where a system needs a *sequence* of random numbers scoped to one chunk (feature attempt counts, positions, vein shapes, worm paths), it uses a `splitmix32` stream seeded by (sub-seed, chunk coords). Streams are re-created from scratch every time that chunk's features are enumerated, so re-simulation from a neighboring chunk (§10.1) consumes draws in exactly the same order.

```js
export function splitmix32(a) {           // returns rng(): float in [0,1)
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
// usage: const rng = splitmix32(chunkSeed(subSeed("ore"), cx, cz));
```

Helpers used throughout: `rngInt(rng, n) = Math.floor(rng() * n)`, `rngRange(rng, a, b) = a + rng() * (b - a)`.

### 2.4 Position hash (order-free per-block randomness)

For randomness attached to a *block position* (jagged bedrock, leaf-corner trims, ore air-exposure discards, flower species), a stateless hash guarantees the same answer no matter which chunk's simulation asks:

```js
export function posHash(seed, x, y, z) {   // → float [0,1)
  let h = seed ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(z, 0xc2b2ae3d);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
```

### 2.5 Deterministic trigonometry

Carver math uses a lookup table, like Minecraft's own `MathHelper.sin` (65536-entry table). Ours is 4096 entries — ample for tunnel steering:

```js
const SIN = new Float32Array(4096);
for (let i = 0; i < 4096; i++) SIN[i] = Math.sin(i * Math.PI * 2 / 4096); // built once; table VALUES may use Math.sin because they are quantized identically everywhere
const tsin = a => SIN[((a * 651.8986469) | 0) & 4095];   // 4096 / 2π
const tcos = a => SIN[(((a * 651.8986469) | 0) + 1024) & 4095];
```

> Adaptation: JS `Math.sin` is not spec-pinned across engines; the quantized table makes worm paths reproducible on every browser, matching MC's own table-based approach.

### 2.6 Asymmetric triangular sampling

Ore Y-distributions after remapping are asymmetric triangles. Sampler:

```js
function triSample(rng, lo, peak, hi) {    // linear ramp up to peak, down to hi
  const u = rng(), c = (peak - lo) / (hi - lo);
  return u < c
    ? lo + Math.sqrt(u * (hi - lo) * (peak - lo))
    : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - peak));
}
```

---

## 3. The Y remap (MC −64..320 → 0..127)

Real 1.20 world height is 384 blocks (−64..320) with sea level 63. Our world is 128 blocks (0..127) with sea level 63. The remap is **piecewise linear anchored at sea level**, compressing the 128-block underground band (−64..64) by 2× and the 256-block sky band (64..320) by 4×:

```js
function remapY(mcY) {
  const y = mcY <= 64 ? (mcY + 64) / 2 : 64 + (mcY - 64) / 4;
  return Math.max(0, Math.min(127, Math.round(y)));
}
```

Anchor table (used throughout §8–§9; original MC value always shown in parentheses at point of use):

| MC Y | −64 | −59 | −32 | −16 | 0 | 15 | 16 | 32 | 48 | 63 | 64 | 80 | 96 | 136 | 192 | 232 | 320 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Our Y** | 0 | 3 | 16 | 24 | 32 | 40 | 40 | 48 | 56 | 63 | 64 | 68 | 72 | 82 | 96 | 106 | 127 |

Bands that extend below MC −64 (clamped triangle tails for redstone/diamond) keep their shape and are clipped at our Y=0, which reproduces MC's "densest at bedrock" behavior.

---

## 4. Noise stack

### 4.1 Library and instantiation

Use the `simplex-noise` npm package (v4) with `alea` as the seeded PRNG (its documented companion). One independently seeded noise instance per layer:

```js
import { createNoise2D, createNoise3D } from 'simplex-noise';
import alea from 'alea';

const layer2D = name => createNoise2D(alea(`${worldSeed}:${name}`));
const layer3D = name => createNoise3D(alea(`${worldSeed}:${name}`));

const N = {
  continental: layer2D('continental'),
  erosion:     layer2D('erosion'),
  rough:       layer2D('rough'),
  mountain:    layer2D('mountain'),
  river:       layer2D('river'),
  temp:        layer2D('temp'),
  humid:       layer2D('humid'),
  cheese:      layer3D('cheese'),
};
```

### 4.2 fbm helpers

```js
function fbm2(noise, x, z, { oct, freq, lac = 2.0, pers = 0.5 }) {
  let amp = 1, f = freq, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * noise(x * f, z * f);
    norm += amp; amp *= pers; f *= lac;
  }
  return sum / norm;                                  // [-1, 1]
}

function ridged2(noise, x, z, { oct, freq, lac = 2.0, pers = 0.5 }) {
  let amp = 1, f = freq, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(noise(x * f, z * f));        // ridge at zero-crossings
    n *= n;
    sum += amp * n; norm += amp; amp *= pers; f *= lac;
  }
  return sum / norm;                                  // [0, 1]
}
```

### 4.3 Layer definitions (complete — no other noise exists)

| Layer | Fn | Dim | Octaves | Base freq (1/blocks) | Lacunarity | Persistence | Output / role |
|---|---|---|---|---|---|---|---|
| `continental` | fbm2 | 2D | 4 | 1/1100 | 2.0 | 0.5 | `c` ∈ [−1,1] — ocean↔inland base height |
| `erosion` | fbm2 | 2D | 4 | 1/700 | 2.0 | 0.5 | `e` ∈ [−1,1] — high = flat, low = rugged |
| `rough` | fbm2 | 2D | 5 | 1/140 | 2.0 | 0.55 | `r` ∈ [−1,1] — local hills/roughness |
| `mountain` | ridged2 | 2D | 4 | 1/380 | 2.0 | 0.5 | `m` ∈ [0,1] — ridged peaks |
| `river` | fbm2 | 2D | 3 | 1/850 | 2.0 | 0.5 | `rv` ∈ [−1,1] — rivers at zero-crossings |
| `temp` | fbm2 | 2D | 3 | 1/1600 | 2.0 | 0.5 | `t` ∈ [−1,1] — biome temperature |
| `humid` | fbm2 | 2D | 3 | 1/1300 | 2.0 | 0.5 | `h` ∈ [−1,1] — biome humidity |
| `cheese` | fbm3 | 3D | 2 | x,z: 1/56 · y: 1/24 (oct 2: ×2) | 2.0 | 0.45 | `n` ∈ [−1,1] — cheese caves (§8.2) |

Cheese fbm3 is anisotropic (y sampled at 2.33× the horizontal frequency ⇒ caves wider than tall):

```js
function cheese(x, y, z) {
  const n1 = N.cheese(x / 56, y / 24, z / 56);
  const n2 = N.cheese(x / 28, y / 12, z / 28);
  return (n1 + 0.45 * n2) / 1.45;
}
```

### 4.4 Lattice sampling (canonical — affects determinism)

All seven 2D layers are evaluated on a **world-aligned lattice with stride 4** (points at coordinates divisible by 4) and bilinearly interpolated per column. The 3D cheese field uses stride 4 in x/y/z with trilinear interpolation. The lattice is anchored to world coordinates, not chunk-local ones, so interpolation is continuous and identical across chunk borders.

**`heightAt(x,z)`, `biomeAt(x,z)`, and all climate values are DEFINED as the lattice-interpolated versions.** Every consumer (terrain fill, carvers, features, spawn search, herd placement) must call these canonical functions; nothing may sample the raw noise directly. The worker memoizes per-chunk column data (height, biome, climate) in an LRU cache of 128 chunk-columns keyed by (cx, cz), because carver/feature overlap re-simulation (§10.1) queries neighbors heavily.

---

## 5. Height composition

Terrain is a heightmap: one surface height per column; all interior air comes from carvers. `clamp01(v) = min(1, max(0, v))`, `smoothstep(a, b, v) = { t = clamp01((v−a)/(b−a)); return t*t*(3−2t); }`, `lerp(a, b, t) = a + (b−a)*t`.

### 5.1 Base height spline (continentalness → base)

Piecewise-linear interpolation through:

| `c` | −1.00 | −0.50 | −0.20 | −0.10 | 0.00 | 0.30 | 0.60 | 1.00 |
|---|---|---|---|---|---|---|---|---|
| `base` | 46 | 48 | 54 | 62 | 66 | 69 | 72 | 74 |

### 5.2 Composition formula

```js
function heightAt(x, z) {                 // canonical; lattice-interpolated inputs (§4.4)
  const c  = fbm2(N.continental, x, z, { oct: 4, freq: 1/1100 });
  const e  = fbm2(N.erosion,     x, z, { oct: 4, freq: 1/700 });
  const r  = fbm2(N.rough,       x, z, { oct: 5, freq: 1/140, pers: 0.55 });
  const m  = ridged2(N.mountain, x, z, { oct: 4, freq: 1/380 });
  const rv = fbm2(N.river,       x, z, { oct: 3, freq: 1/850 });

  const base     = splineC(c);                          // §5.1
  const flatness = clamp01(0.5 * (e + 1));              // 1 = plains-flat
  const landMask = smoothstep(-0.10, 0.05, c);          // kill relief at coast/ocean

  const hillAmp  = lerp(16, 3, flatness);
  const hills    = r * hillAmp * landMask;

  const seabed   = r * 2.5 * (1 - landMask);            // gentle ocean-floor variation

  const mtnMask  = smoothstep(0.18, 0.55, c) * (1 - smoothstep(-0.35, 0.35, e));
  const mtn      = m * 52 * mtnMask;

  let height = base + hills + seabed + mtn;

  // River carve: ridged band around rv = 0 (§5.4)
  const riv = 1 - smoothstep(0.025, 0.06, Math.abs(rv));    // 1 at centerline
  if (riv > 0 && height > 56) {
    const bedTarget = 59 - 2 * riv;                          // 57..59 riverbed
    height = Math.min(height, lerp(height, bedTarget, Math.min(1, riv * 1.6)));
  }

  return Math.max(40, Math.min(124, Math.round(height)));
}
```

`riverMaskAt(x,z)` returns `riv` from the same computation (used by biome selection).

### 5.3 Expected output ranges (tuning targets — acceptance-tested)

| Terrain class | Conditions | Resulting height |
|---|---|---|
| Deep ocean | c < −0.45 | 43–50 |
| Ocean / shelf | −0.45 ≤ c < −0.11 | 48–61 |
| Coast / beach | c ≈ −0.11..0.05, flat | 60–65 |
| Plains | c > 0, flatness > 0.7 | 64–72 |
| Hills / rugged land | c > 0.05, flatness < 0.4 | 70–90 |
| Mountains | c > 0.4, e < 0, m > 0.6 | 95–124 (peaks 110–124) |
| Rivers | \|rv\| < 0.06 on land | bed 57–59, water to 63 |

### 5.4 Rivers

Rivers are the ridged band `|rv| < 0.06`: width ≈ 4–10 blocks depending on the local gradient of `rv`. The carve profile is the smooth `lerp` above — banks blend over the 0.025–0.06 mask falloff (≈3–6 blocks each side), bed reaches Y 57–59, and water fills to Y 63 in the terrain pass (§7.3), giving 4–6 deep channels. Rivers crossing hills cut valleys (mask beats hills via `Math.min`); rivers vanish into oceans automatically (ocean height already below the bed target).

### 5.5 Biome height blending

There is none to do: height derives from continuous noise fields shared by all biomes — biome selection (§6) is *diagnostic* (it picks surface materials and features from already-smooth height/climate values), so there are no seams by construction. Surface-block changes at biome borders are hard 1-block transitions, which is authentic MC behavior.

---

## 6. Biome selection

### 6.1 Biome ids (this file owns this enum; stored per column, saved with chunk)

| id | Biome | id | Biome |
|---|---|---|---|
| 0 | `ocean` | 6 | `desert` |
| 1 | `beach` | 7 | `savanna` |
| 2 | `river` | 8 | `taiga` |
| 3 | `plains` | 9 | `snowy_tundra` |
| 4 | `forest` | 10 | `mountains` |
| 5 | `birch_forest` | | |

Base temperature (runtime, 04 §12.4): ocean 0.5, beach 0.8, river 0.5, plains 0.8, forest 0.7, birch_forest 0.6, desert 2.0, savanna 1.2, taiga 0.25, snowy_tundra 0.0, mountains 0.18.

### 6.2 Selection algorithm (per column, canonical order)

```js
function biomeAt(x, z) {
  const height = heightAt(x, z), c = ..., riv = riverMaskAt(x, z);
  let t = fbm2(N.temp,  x, z, { oct: 3, freq: 1/1600 });
  const h = fbm2(N.humid, x, z, { oct: 3, freq: 1/1300 });
  t -= Math.max(0, height - 80) * 0.008;        // altitude cooling

  if (height <= 59) return OCEAN;
  if (riv > 0.5 && height <= 62) return RIVER;
  if (height <= 64 && c < 0.05) return BEACH;   // only near coast; inland lowlands stay grassy
  if (height >= 92) return MOUNTAINS;

  // temperature × humidity table:
  const col = h < -0.2 ? 0 : h <= 0.3 ? 1 : 2;  // dry | mid | wet
  if (t < -0.45) return [SNOWY_TUNDRA, SNOWY_TUNDRA, TAIGA][col];
  if (t < -0.10) return [PLAINS, TAIGA, TAIGA][col];
  if (t <  0.40) return [PLAINS, FOREST, BIRCH_FOREST][col];
  return            [DESERT, SAVANNA, PLAINS][col];
}
```

**Snow/ice are climate rules, not biome rules** (§10.6): any column with effective `t < −0.45` OR `height ≥ 104` gets snow cover and frozen water. This automatically yields snowy taiga, frozen oceans/rivers, and snow-capped mountains without extra biomes.

### 6.3 Per-biome data table

"Trees /chunk" = decoration attempts per chunk (§10.4); fractions mean 1 attempt in that share of chunks, rolled from the chunk's tree stream. "Grass/Flowers" = single-block placement attempts per chunk. Surface/filler columns: see §7.2 for submerged overrides.

| Biome | Surface | Filler (depth) | Trees /chunk | Grass | Flowers | Extra features |
|---|---|---|---|---|---|---|
| `ocean` | sand (height ≥ 56) else gravel | same ×3 | 0 | 0 | 0 | — |
| `beach` | sand | sand ×3, sandstone ×2 | 0 | 0 | 0 | sugar cane (§10.5) |
| `river` | sand | sand ×3 | 0 | 0 | 0 | sugar cane on banks |
| `plains` | grass_block | dirt ×3 | 1 in 1/20 chunks: oak (approx; MC ~1/20) | 40 | 6 | pumpkin patch 1/64 chunks |
| `forest` | grass_block | dirt ×3 | 8 (75% oak, 25% birch) (MC forest ≈10, 20% birch) | 12 | 3 | pumpkin 1/64 |
| `birch_forest` | grass_block | dirt ×3 | 8 (all birch) | 12 | 3 | — |
| `desert` | sand | sand ×3, sandstone ×2 | 0 | 0 | 0 | cactus 3, dead_bush 2, sugar cane |
| `savanna` | grass_block | dirt ×3 | 1 (oak) (MC savanna = 1 acacia) | 50 | 2 | — |
| `taiga` | grass_block | dirt ×3 | 7 (spruce) | 8 | 0 | — |
| `snowy_tundra` | grass_block | dirt ×3 | 1 in 1/10 chunks: spruce (approx) | 0 | 0 | snow/ice via climate rule |
| `mountains` | grass_block below 96, stone at ≥96 | dirt ×3 (none where stone) | 1 (spruce; succeeds only on grass) | 6 | 0 | snow ≥104 |

> Adaptation: savanna spawns sparse oaks instead of acacia (no acacia wood set in the registry). Snowy biomes get their look from the climate snow rule rather than dedicated frozen sub-biomes.

---

## 7. Column composition (terrain pass)

Runs first for each chunk. For every column (x,z) with `hgt = heightAt`, `biome = biomeAt`:

### 7.1 Vertical fill order

```
y = 0:            bedrock
y = 1:            bedrock if posHash(subSeed("terrain"), x, 1, z) < 0.5, else stone   // jagged 2nd layer (DECIDED: 1 solid + 1 jagged)
y = 2 .. hgt−(fillerDepth+1):  stone
next fillerDepth: filler per biome table  (dirt / sand / sand+sandstone)
y = hgt:          surface block per biome table
y = hgt+1 .. 63:  water (source, state 0)  (only if hgt < 63)
above:            air
```

### 7.2 Submerged override

Any column with `hgt < 63` (ocean, river, coastal shallows, regardless of biome) uses ocean surface rules: surface + filler = `sand` if `hgt ≥ 56`, else `gravel`. No grass ever generates underwater. Desert/beach sandstone underlay still applies beneath sand.

### 7.3 Water rule (contract with 06)

All water placed at generation is `water` with state 0 (source), settled (no scheduled flow ticks). This single rule fills oceans, rivers, and coastal shelves: **fill `hgt+1..63` with water in every column whose height is below sea level**. No other gen-time water exists (lakes skipped, §1.2). 06's flow logic wakes water only when a player edit changes its neighborhood.

### 7.4 Dirt and gravel pockets

Placed with the ore vein algorithm (§9.2), from the `"ore"` stream, before real ores, replacing stone only:

| Pocket | Attempts /chunk | Size param | Y distribution |
|---|---|---|---|
| dirt | 3 (approx; MC 7 @ size 33 over taller world) | 18 | uniform 34–88 (MC 0–160) |
| gravel | 2 (approx; MC 8 @ size 33) | 18 | uniform 0–88 (MC −64–160) |

---

## 8. Caves & carvers

Both carvers turn terrain blocks into `air`, then §8.5 floods the deepest air with lava. Carve order: cheese → worms/ravines. Neither carver may remove `bedrock` (y ≤ 1) or any block that fails the water guard (§8.4).

### 8.1 What exists

1. **Cheese caves** — 3D-noise voids: big rooms and pillared caverns (MC 1.18 "cheese").
2. **Worm tunnels** — random-walk carvers: winding 1–3-radius spaghetti tunnels with branching (classic MC carver).
3. **Ravines** — a worm variant with 3× vertical stretch (1 in 50 chunks).
4. **Surface entrances** — 12% of worms start at the surface and dig down (plus cheese openings on hillsides via threshold falloff).

### 8.2 Cheese caves (noise threshold)

For every block with `4 ≤ y ≤ surfaceY` (evaluated on the §4.4 trilinear lattice):

```
depth     = surfaceY(x,z) − y
threshold = 0.58 + 0.34 * clamp01(1 − depth / 24)     // 0.92 at surface → 0.58 at depth ≥ 24
carve if cheese(x, y, z) > threshold                   // and water guard §8.4 passes
```

Yields ≈5–8% void fraction below depth 24, tapering to rare hillside mouths near the surface. No cheese below y=4 (protects the bedrock/lava floor from mega-rooms).

### 8.3 Worm tunnels & ravines (random walk)

Worms travel far, so when generating chunk C the worker re-simulates carver origins for **all origin chunks within Chebyshev radius 7** (`CARVE_R = 7`; max reach 100 blocks + max radius < 7×16) and carves only blocks that land inside C. Everything below runs per origin chunk (ocx, ocz) off one stream: `rng = splitmix32(chunkSeed(subSeed("carver"), ocx, ocz))`.

```js
// ---- per origin chunk ----
if (rng() < 1/7) {                                    // ~1 chunk in 7 has worm systems (MC-like sparsity)
  const wormCount = 1 + Math.floor(rng() * rng() * 3);      // 1..3, skewed to 1
  for (let w = 0; w < wormCount; w++) {
    const sx = ocx * 16 + rng() * 16, sz = ocz * 16 + rng() * 16;
    let x, y, z, pitch;
    if (rng() < 0.12) {                               // SURFACE ENTRANCE worm
      y = heightAt(sx, sz) + 1;
      pitch = -(0.35 + rng() * 0.55);                 // steep dive: guaranteed cave mouths
    } else {
      y = 6 + rng() * rng() * 72;                     // 6..78, skewed deep
      pitch = (rng() - 0.5) * 0.5;
    }
    x = sx; z = sz;
    let yaw       = rng() * Math.PI * 2;
    const thick   = 1.2 + rng() * rng() * 2.2;        // base radius 1.2..3.4
    const length  = 50 + Math.floor(rng() * 60);      // 50..109 steps
    carveTunnel(rng, x, y, z, yaw, pitch, thick, length, /*vScale*/ 0.72, /*canBranch*/ true);
  }
}
if (rng() < 0.02) {                                   // RAVINE: 1 in 50 chunks
  const x = ocx * 16 + rng() * 16, z = ocz * 16 + rng() * 16;
  const y = 24 + rng() * 28;                          // 24..52
  carveTunnel(rng, x, y, z, rng() * Math.PI * 2, (rng() - 0.5) * 0.1,
              2.2 + rng() * 2.0, 70 + Math.floor(rng() * 40), /*vScale*/ 3.0, /*canBranch*/ false);
}
```

```js
function carveTunnel(rng, x, y, z, yaw, pitch, thick, length, vScale, canBranch) {
  let yawVel = 0, pitchVel = 0;
  const ox = x, oz = z;
  for (let i = 0; i < length; i++) {
    const rH = 1.3 + tsin(i * Math.PI / length) * thick;   // swells mid-tunnel (MC profile)
    const rV = Math.max(1.1, rH * vScale);

    x += tcos(yaw) * tcos(pitch);
    y += tsin(pitch);
    z += tsin(yaw) * tcos(pitch);

    pitch = pitch * 0.7 + pitchVel * 0.1;
    yaw  += yawVel * 0.1;
    pitchVel = pitchVel * 0.8  + (rng() - rng()) * rng() * 2.0;
    yawVel   = yawVel   * 0.75 + (rng() - rng()) * rng() * 4.0;

    // branch at midpoint: thick tunnels split into two half-thickness arms
    if (canBranch && i === (length >> 1) && thick > 1.8 && rng() < 0.5) {
      carveTunnel(rng, x, y, z, yaw - Math.PI / 2, pitch / 3, thick * 0.6, length - i, vScale, false);
      carveTunnel(rng, x, y, z, yaw + Math.PI / 2, pitch / 3, thick * 0.6, length - i, vScale, false);
      return;
    }
    if (rng() < 0.20) continue;                       // 1 in 5 steps: move without carving (rough walls)
    if ((x - ox) ** 2 + (z - oz) ** 2 > 100 * 100) return;   // hard displacement clamp → CARVE_R = 7 is safe

    carveEllipsoid(x, y, z, rH, rV);                  // clip to current chunk; skip y≤1; water guard §8.4
  }
}
```

`carveEllipsoid` iterates the bounding box, carves cells where `((dx/rH)² + (dy/rV)² + (dz/rH)²) < 1`, writing only cells inside the chunk being generated. All `rng()` draws happen unconditionally in the order shown, so re-simulation from any chunk consumes the identical stream.

### 8.4 Water guard (caves never breach oceans/rivers)

Gen-time water is a pure function: `isGenWater(x, y, z) = y <= 63 && y > heightAt(x, z)`. It is therefore checkable across chunk borders without neighbor block data.

- **Cheese:** skip carving a cell if any of its 5 neighbors (±x, ±z, +y) satisfies `isGenWater`.
- **Worms/ravines:** before carving an ellipsoid, scan its bounding box expanded by 1; if any cell satisfies `isGenWater`, skip the entire ellipsoid (classic MC behavior). This leaves a ≥1-block shell under oceans and rivers.

### 8.5 Lava level

After all carving: every carved-air cell with **y ≤ 9** becomes `lava` with state 0 (source; settled, 06 owns flow). References: classic 128-high MC used "lava below Y=11"; 1.18 floods aquifers below Y −54, which remaps to 5; chosen value 9 splits the difference (approx). Cheese + worm voids at the bottom of the world thus form lava caverns, and diamonds (peak Y 0–8) live next to lava, as in MC.

---

## 9. Ores

### 9.1 Placement rules

- Ores replace **`stone` only** (never dirt/gravel pockets, never filler, never each other). One ore feature list, executed in the fixed order of the §9.3 table, all drawing from the chunk's `"ore"` stream: `splitmix32(chunkSeed(subSeed("ore"), ocx, ocz))`.
- Veins can spill across borders (max spatial reach ≈ 14 blocks), so ore enumeration runs for origin chunks within **radius 1** (3×3), writing only blocks inside the current chunk (§10.1 pattern).
- **Air-exposure discard** (MC `discard_chance_on_air_exposure`): when a candidate ore block has any of its 6 neighbors already carved to air (in-chunk state; for out-of-chunk neighbors use the cheese test only), the block is skipped if `posHash(subSeed("detail"), x, y, z) < discard`. Buried ores (discard 1.0) never touch cave walls; gold/diamond partially hide from caves. Position-hash (not stream) keeps cross-chunk re-simulation in sync.

### 9.2 Vein placement algorithm (used by ores + dirt/gravel pockets)

> Adaptation: MC's blob feature is a line of overlapping ellipsoids with sinusoidal radius; this is the same idea with simpler bookkeeping. `size` matches MC's size parameter in spirit: size 4 → ≈3–8 blocks, size 9 → ≈6–14, size 17 → ≈12–26.

```js
function placeVein(rng, chunk, ox, oy, oz, size, blockId, discard) {
  let x = ox, y = oy, z = oz;
  let yaw = rng() * Math.PI * 2;
  let pitch = (rng() - 0.5) * 0.9;
  for (let i = 0; i < size; i++) {
    const t = size <= 1 ? 0.5 : i / (size - 1);
    const r = 0.6 + tsin(t * Math.PI) * (0.4 + size / 16);      // sphere radius 0.6..~1.7
    for (const [bx, by, bz] of blocksWithin(x, y, z, r)) {       // fixed iteration order: x→y→z ascending
      if (!inCurrentChunk(bx, by, bz)) continue;                 // clip (no rng consumed here)
      if (blockAt(bx, by, bz) !== STONE) continue;
      if (discard > 0 && touchesAir(bx, by, bz)
          && posHash(subSeed("detail"), bx, by, bz) < discard) continue;
      setBlock(bx, by, bz, blockId);
    }
    x += tcos(yaw) * tcos(pitch) * 0.7;
    y += tsin(pitch) * 0.7;
    z += tsin(yaw) * tcos(pitch) * 0.7;
    yaw   += (rng() - 0.5) * 0.6;
    pitch  = Math.max(-1.2, Math.min(1.2, pitch + (rng() - 0.5) * 0.4));
  }
}
```

Per attempt: `ox = ocx*16 + rngInt(rng,16)`, `oz = ocz*16 + rngInt(rng,16)`, `oy` from the distribution column below (uniform via `rngRange`, triangular via `triSample`). Attempts whose `oy` falls outside 0..127 are discarded **after** consuming their draws (clamped-triangle tails).

### 9.3 Ore table — 1.20 data remapped via §3

Attempts/chunk are scaled by the band-compression factor (`ourSpan / mcSpan`) so **ore density per block volume matches 1.20** at every remapped depth; original MC counts and Y-values in parentheses. Distribution "tri(lo, peak, hi)" = asymmetric triangle, clipped to 0..127.

| # | Feature | Block | Attempts /chunk | Size | Y distribution (ours) | (MC 1.20 original) | Air discard |
|---|---|---|---|---|---|---|---|
| 1 | coal upper | `coal_ore` | 7 | 17 | uniform 82–127 | (30 @ uniform 136–320) | 0 |
| 2 | coal lower | `coal_ore` | 7 | 17 | tri(32, 72, 96) | (20 @ tri 0–192, peak 96) | 0.5 |
| 3 | iron upper | `iron_ore` | 17 | 9 | tri(68, 106, 127) | (90 @ tri 80–384, peak 232) | 0 |
| 4 | iron middle | `iron_ore` | 5 | 9 | tri(20, 40, 60) | (10 @ tri −24–56, peak 16) | 0 |
| 5 | iron small | `iron_ore` | 5 | 4 | uniform 0–66 | (10 @ uniform −64–72) | 0 |
| 6 | gold | `gold_ore` | 2 | 9 | tri(0, 24, 48) | (4 @ tri −64–32, peak −16) | 0.5 |
| 7 | gold deep | `gold_ore` | 1 in 25% of chunks | 9 | uniform 0–8 | (avg 0.5 @ uniform −64–−48) | 0.5 |
| 8 | redstone | `redstone_ore` | 2 | 8 | uniform 0–39 | (4 @ uniform −64–15) | 0 |
| 9 | redstone deep | `redstone_ore` | 4 | 8 | tri(−16, 0, 16) clipped | (8 @ tri −96–−32, peak −64) | 0 |
| 10 | lapis | `lapis_ore` | 1 | 7 | tri(16, 32, 48) | (2 @ tri −32–32, peak 0) | 0 |
| 11 | lapis buried | `lapis_ore` | 2 | 7 | uniform 0–64 | (4 @ uniform −64–64) | 1.0 |
| 12 | diamond | `diamond_ore` | 4 | 4 | tri(−40, 0, 40) clipped | (7 @ tri −144–16, peak −64) | 0.5 |
| 13 | diamond buried | `diamond_ore` | 2 | 8 | tri(−40, 0, 40) clipped | (4 @ tri −144–16) | 1.0 |
| 14 | diamond large | `diamond_ore` | 1 in 1/9 chunks | 12 | tri(−40, 0, 40) clipped | (1/9 chunks, size 12) | 0.7 |

Resulting player-facing depth bands (must hold in acceptance tests): coal Y ≥ 32 peaking near the surface (72) and in mountains; iron everywhere with hotspots at Y 40 and mountain tops; gold Y ≤ 48 peaking at 24; redstone/diamond densest at Y 0–12 beside bedrock lava; lapis mid-depth around 32.

### 9.4 Skipped ores (reference data, do not implement)

Copper (MC: 16 @ tri −16–112 peak 48 → ours would be 6 @ tri(24, 56, 76), size 10) and emerald (MC: 100 @ tri −16–480 peak 232, mountains only, size 3) — both SKIP per §1.2.

---

## 10. Decoration pass

### 10.1 Pipeline decision: deterministic overlap generation (DECIDED)

Two candidate architectures were on the table:

- **(A) Two-phase**: generate bare terrain per chunk; run a later decoration phase once all neighbors exist. Requires cross-chunk scheduling state in the worker, chunks that change after first delivery (re-mesh churn), and save-file "decorated?" flags.
- **(B) Deterministic overlap**: every chunk is generated in one shot. Features that can cross borders are enumerated **per origin chunk** from that chunk's own RNG stream, and every generating chunk re-enumerates the origin chunks within the feature's reach radius, writing only the blocks that land inside itself.

**Decision: (B).** It keeps chunk generation a pure function of (seed, cx, cz), needs no inter-chunk coordination or second delivery, and both halves of a border-straddling tree/vein/tunnel come out identical because both simulations replay the same origin stream and read only canonical 2D functions (`heightAt`, `biomeAt`) — never another chunk's block data.

Reach radii (Chebyshev, in chunks):

| Feature class | Radius | Reason |
|---|---|---|
| Worm carvers / ravines | 7 | 100-block displacement clamp + max radius |
| Cheese caves | 0 | pure local noise |
| Ore / dirt / gravel veins | 1 | ≤14-block reach |
| Trees | 1 | canopy radius ≤ 3 |
| Plants, cactus, sugar cane, pumpkins, snow/ice | 0 | single-column |

Known cosmetic tradeoffs (accepted): a tree whose origin column got surface-carved by a neighbor-chunk cave mouth may overhang the hole; ore exposure checks against out-of-chunk neighbors test only the cheese field (a buried vein block on a border can rarely touch a worm tunnel). Neither affects determinism — each block is written by exactly one chunk's simulation.

### 10.2 Decoration order (fixed, per chunk)

```
1. trees        (origin chunks ±1, stream "tree")
2. cactus, dead bush, sugar cane, pumpkins   (local, stream "plant")
3. grass + flowers                            (local, stream "plant", same stream, after #2)
4. snow layers + ice                          (local, climate rule §10.6)
5. recompute heightmap; roll herds (§11, stream "herd")
```

### 10.3 Tree placement protocol

Per origin chunk: `rng = splitmix32(chunkSeed(subSeed("tree"), ocx, ocz))`. Attempts = biome table §6.3 evaluated at the origin chunk's center column (8, 8). Per attempt:

```
x = ocx*16 + rngInt(rng,16); z = ocz*16 + rngInt(rng,16)
species  = biome tree mix (draw rng() even if unused — keeps streams aligned)
H        = species height roll (below)
ground   = heightAt(x,z); require ground ≥ 63 (not submerged)
require surfaceBlockOf(x,z) ∈ {grass_block, dirt}     // derived from biome+height rules, not block reads
require trunk clearance: columns (x, ground+1 .. ground+H+1) inside terrain would be air (heightmap test)
place: ground block → dirt; trunk + canopy per §10.4, blocks outside current chunk skipped
```

Leaves never overwrite anything except `air`; logs overwrite leaves and air only. Leaf-corner randomness uses `posHash(subSeed("detail"), x, y, z) < 0.5` so both sides of a border agree.

### 10.4 Tree shapes (exact)

Local coordinates: origin O = first trunk block, at ground+1. Trunk logs occupy local y = 0..H−1.

**Oak** — `H = 4 + rngInt(rng, 3)` → 4–6 (MC oak trunk 4–6). Canopy (`X` leaf, `T` trunk, `C` leaf iff posHash < 0.5):

```
y = H−3 and y = H−2 (5×5):      y = H−1 (3×3):      y = H (top, plus-shape):
   C X X X C                        C X C                 . X .
   X X X X X                        X T X                 X X X
   X X T X X                        C X C                 . X .
   X X X X X
   C X X X C
```

**Birch** — identical layer shapes, `H = 5 + rngInt(rng, 3)` → 5–7, `birch_log`/`birch_leaves`.

**Spruce** — `H = 7 + rngInt(rng, 4)` → 7–10 (MC 6–10 approx). Conical, layers relative to H:

```
y = H   : single leaf (tip, above top log)
y = H−1 : plus (3×3 minus corners)
y = H−2 : full 3×3
y = H−3 : 5×5 minus 4 corners (always trimmed)
y = H−4 : full 3×3
y = H−5 : 5×5 minus 4 corners
below   : bare trunk
```

> Adaptation: fixed 6-layer spruce cone instead of MC's randomized ring cycle; silhouette matches the common in-game spruce.

### 10.5 Other features (all local, stream `"plant"`, fixed order)

| Feature | Where | Attempts /chunk | Rule |
|---|---|---|---|
| Cactus | desert | 3 | pick (x,z); surface must be `sand`, air above; height 1 + rngInt(3) → 1–3; each cactus cell requires all 4 horizontal neighbors air (else truncate); no cactus adjacent to cactus |
| Dead bush | desert | 2 | on sand, air above → `dead_bush` |
| Sugar cane | beach, river, desert, plains, forest, savanna | 6 | pick (x,z); surface ∈ {grass_block, sand} at y 62–64 with air above; at least one of the 4 horizontal neighbors of the *surface* block is a `water` source (state 0); column height 2 + rngInt(3) → 2–4 (approx; MC patches) |
| Pumpkin patch | plains, forest | 1 in 1/64 chunks (approx; MC rarity 1/300 with larger patches) | at random surface grass: 6 tries in ±3 blocks; place `pumpkin` on grass_block with air above, each try 50% |
| Grass | per §6.3 count | — | on `grass_block`, air above → `short_grass` |
| Flowers | per §6.3 count | — | on `grass_block`, air above; species: `posHash < 0.5 ? dandelion : poppy` |

### 10.6 Snow & ice (climate rule — final block pass)

For every column, with effective temperature `t_eff = t − max(0, height−80)·0.008` (same formula as §6.2):

```
if t_eff < −0.45 or heightAt(x,z) ≥ 104:
  top = highest non-air block (after trees)
  if top is a water source at y = 63     → replace with ice
  else if top is solid, full-height, and not ice → place snow_layer above it
```

Snow lands on tree canopies, mountain stone, tundra grass; frozen rivers/oceans get ice sheets. `snow_layer` is the 1/8-height layer block from 06's registry.

---

## 11. Worldgen animal herds

Generation does not instantiate entities; it emits **spawn records** the entity system (05) consumes when the chunk first loads. Records are produced only on first generation and persist in the save until consumed (01 owns persistence).

- Roll: `rng = splitmix32(chunkSeed(subSeed("herd"), cx, cz))`; a chunk contains a herd iff `rng() < 0.10` (MC: passive-mob populate chance 1/10 per chunk).
- Herd size: `2 + rngInt(rng, 3)` → **2–4**, all one species.
- Species by biome (weights; draw once per herd):

| Biome | Species (weight) |
|---|---|
| plains, savanna | cow 4, sheep 4, pig 3, chicken 3 |
| forest, birch_forest | pig 3, chicken 3, cow 2, sheep 2 |
| taiga | cow 1, pig 1, sheep 1, chicken 1 |
| mountains | sheep 3, chicken 1 (approx; MC goats skipped) |
| desert, snowy_tundra, ocean, river, beach | none |

- Placement: herd center `(hx, hz)` = random column in chunk; each member tries 4 positions within ±4 blocks of center; a position is valid iff the surface block is `grass_block` (per §6.3 rules), `y = height + 1`, and the column is not submerged. Invalid after 4 tries → that member is dropped.
- Record format (world coords, floats at block centers): `{ type: "cow"|"pig"|"sheep"|"chicken", x: bx + 0.5, y: height + 1, z: bz + 0.5 }`. Sheep wool color, baby chance, etc. are 05's concern.

---

## 12. World spawn point

Computed once at world creation inside the gen worker (it needs only the canonical 2D functions — no chunks), returned in the init handshake (01), and stored in the save file.

```js
function findWorldSpawn() {
  for (let ring = 0; ring <= 32; ring++) {              // rings of 8-block steps, radius up to 256
    for (const [x, z] of ringPositions(ring * 8, 8)) {  // deterministic counter-clockwise order from (r, −r)
      const h = heightAt(x, z), b = biomeAt(x, z);
      if (h < 64 || h > 90) continue;                   // above sea level, not a cliff top
      if (b === OCEAN || b === RIVER || b === BEACH) continue;
      if (surfaceBlockOf(x, z) !== GRASS_BLOCK) continue;
      return { x: x + 0.5, y: h + 1, z: z + 0.5 };      // feet position; 03 applies eye height
    }
  }
  return { x: 0.5, y: heightAt(0, 0) + 1, z: 0.5 };     // fallback: spawn anyway
}
```

`ringPositions(r, step)` yields the perimeter of the axis-aligned square of half-size `r` centered on (0,0), stepping `step` blocks, starting at (r, −r) going counter-clockwise; ring 0 yields (0,0). Respawn-after-death reuses this stored point unless 03's bed logic overrides it.

---

## 13. Worker pipeline & output format

### 13.1 Per-chunk pipeline (inside the gen worker)

```
generateChunk(cx, cz):
  1. columns: for all 256 (x,z): heightAt, biomeAt, climate (lattice-sampled §4.4; cached)
  2. terrain fill (§7): bedrock, stone, filler, surface, water sources
  3. carve cheese caves (§8.2)
  4. carve worms + ravines, origin chunks ±7 (§8.3)
  5. lava flood: carved air at y ≤ 9 → lava source (§8.5)
  6. dirt/gravel pockets, then ores, origin chunks ±1 (§7.4, §9)
  7. decoration (§10.2): trees (±1) → plants (local) → snow/ice (local)
  8. heightmap: per column, y+1 of topmost skyOpacity>0 block per 01 §4.2 (water counts, cross plants don't)
  9. herd records (§11)
  10. post ChunkPayload (transferables)
```

Saved chunks are never regenerated — the main thread only requests generation for chunks absent from the save (01 owns that routing). Regeneration of an unmodified chunk MUST byte-match the original (acceptance test).

### 13.2 Output payload (contract with 01)

```js
// worker → main thread, transferred (zero-copy) per 01-ARCHITECTURE.md's protocol
{
  type: "chunk",
  cx, cz,                              // chunk coords (int)
  blocks: Uint8Array(16 * 128 * 16),   // block ids from 06's registry
                                       // index = x + (z << 4) + (y << 8)  — 01 owns this formula;
                                       //         shown for concreteness, defer to 01 if it differs
  heightMap: Uint8Array(256),          // index = x + (z << 4); y+1 of topmost skyOpacity>0 block per 01 §4.2 (cross-shape plants excluded; water counts); 0 = empty
                                       // (04's lighting seeds sky light from this)
  biomes: Uint8Array(256),             // index = x + (z << 4); biome ids from §6.1
                                       // (renderer grass/foliage/water tint; 05 spawn rules)
  spawns: [ { type, x, y, z }, ... ]   // §11 herd records; [] if none (structured-clone, tiny)
}
```

`blocks`, `heightMap`, `biomes` are listed in the message's transfer list. The worker is stateless apart from its noise instances and the column LRU cache — it can be killed and respawned at any time with only (seedString) to re-init.

---

## 14. Performance budget

Target: **≤ 12 ms average per chunk** in the worker (measured over 100 consecutive chunks on a mid-range laptop), so a 12-chunk-radius world streams without hitching the 20 t/s main loop (01 owns scheduling).

| Stage | Approx cost driver | Budgeted |
|---|---|---|
| 2D noise (7 layers, 5×5 lattice ×4 oct) | ≈ 700 simplex2 calls | ≤ 1 ms |
| Terrain fill | 65,536 array writes (mostly memset-able runs) | ≤ 2 ms |
| Cheese (5×33×5 lattice ×2 oct + trilinear) | ≈ 1,650 simplex3 calls | ≤ 2 ms |
| Worm re-simulation (15×15 origins, ~1/7 active) | ≈ 30–40 tunnel sims, ~80 steps each | ≤ 3 ms |
| Ores + pockets (3×3 origins × ~60 attempts) | ≈ 540 vein rolls, ~55 placed | ≤ 1.5 ms |
| Decoration + snow + heightmap | ≈ 300 feature rolls | ≤ 1.5 ms |

Mandatory optimizations: column LRU cache (§4.4); early-out worm sims whose origin is farther than (remaining max reach) from the chunk AABB before stepping (still consume the origin's *count* draws — the per-tunnel draws may be skipped only via whole-tunnel AABB precheck computed from the displacement clamp: a tunnel is simulated iff `dist(origin, chunkAABB) ≤ 100 + 3.4·1.5`); typed-array fills for stone/water runs.

---

## 15. Acceptance checklist

Determinism
- [ ] Generating chunk (5, −3) fresh vs. after generating its 8 neighbors first produces byte-identical `blocks` arrays (test 20 random chunks, both orders).
- [ ] Two worlds from the same seed string produce identical `blocks`, `heightMap`, `biomes`, `spawns` for the 9×9 chunks around origin.
- [ ] A tree/vein/tunnel straddling a chunk border is seamless: union of the two chunks' blocks equals the feature generated in a single 32×32 reference pass.
- [ ] No calls to `Math.random`, and no `Math.sin/cos` in carver/vein paths (code audit + runtime assert hook).

Terrain & biomes
- [ ] Over a 64×64-chunk sample: land fraction 55–75%; heights observed in every class of §5.3's table; at least one column ≥ 110; ocean floor spans 43–58.
- [ ] Sea-level rule: every column with `height < 63` has `water` sources from height+1 up to exactly Y 63, and none above.
- [ ] All 11 biomes occur within a 2,048-block radius of origin (seed-averaged: ≥ 9 of 11 for any single seed).
- [ ] Beaches: sand columns ring every ocean/land boundary where height 60–64 and c < 0.05; no grass blocks underwater anywhere.
- [ ] Rivers: continuous carved bands ≥ 200 blocks long exist; bed Y 57–59; water to 63; banks blend (no 1-column cliffs > 3 blocks at the mask edge).
- [ ] Snow/ice: in `t_eff < −0.45` regions, exposed solid tops carry `snow_layer`, Y-63 water is `ice`; mountain tops ≥ 104 are snow-capped regardless of latitude noise.

Underground
- [ ] Y0 is 100% bedrock; Y1 is ≈50% bedrock; no carver or vein ever replaces bedrock.
- [ ] Dirt and gravel pockets occur underground (sample: ≥ 1 pocket of each per 4 chunks); no granite/diorite/andesite/deepslate/copper/emerald ids appear anywhere.
- [ ] Caves: cheese rooms and worm tunnels both present; ≥ 1 surface cave mouth within any 8-chunk radius (statistical over 5 seeds); ravines found (≈1/50 chunks).
- [ ] All carved air at y ≤ 9 is `lava` source; no lava above Y 9 at gen time.
- [ ] Water guard: zero water source blocks horizontally or vertically adjacent to carved air at gen time (full-region scan test).

Ores
- [ ] Per-ore Y histograms over 200 chunks match §9.3 distributions: coal absent below Y 32; diamond absent above Y 40 with mode in 0–8; gold absent above Y 48; iron trimodal (40 / mountain band / uniform floor); counts within ±30% of expected totals.
- [ ] Buried lapis/diamond (discard 1.0) never share a face with cave air (in-chunk scan).
- [ ] Veins replace only stone — never dirt pockets, filler, or each other; vein sizes fall in §9.2's ranges.

Decoration & spawns
- [ ] Forest chunks average 5–10 trees; deserts have cactus 1–3 tall obeying the no-horizontal-neighbor rule; sugar cane only adjacent to water; pumpkins rare but findable (≥ 1 within 40×40 chunks, 5-seed average).
- [ ] Tree shapes match §10.4 layer-for-layer (fixed-seed golden test for one oak, one birch, one spruce).
- [ ] Herd records: only in §11's listed biomes, size 2–4, every position on grass_block; ≈10% of chunks (±3 pp over 500 chunks).
- [ ] World spawn: on grass_block, height 64–90, not ocean/river/beach; identical across two runs of the same seed.

Contract & performance
- [ ] Payload matches §13.2 exactly; arrays arrive transferred (buffers detached in worker after post).
- [ ] Average generation ≤ 12 ms/chunk over 100 chunks; no single chunk > 40 ms (excluding first-call JIT warmup).
- [ ] Worker restart mid-session (kill + re-init with same seed) continues producing identical chunks.
