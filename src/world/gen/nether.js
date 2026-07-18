// 10-NETHER §4-§5 — the Nether generator. Pure, deterministic per (seed, cx, cz),
// worker-importable (no registry/DOM). Native Y 0-127, no remap: bedrock floor/
// roof, netherrack carved into the "swiss-cheese" cavern field, a lava sea at
// Y≤31, ores, biome surface palettes, and deterministic fortresses.
//
// Block ids are hardcoded (the worker doesn't import the registry):
//   air 0, bedrock 17, glowstone 32, chest 37, lava 64, netherrack 115,
//   nether_bricks 116, nether_brick_fence 117, soul_sand 119, magma_block 121,
//   nether_quartz_ore 122, nether_gold_ore 123, ancient_debris 124,
//   crimson_nylium 125, warped_nylium 126, nether_wart 138, spawner 141.

import { hashString, splitmix32, chunkSeed, posHash, mix32 } from '../../math/rng.js';

const AIR = 0, BEDROCK = 17, GLOWSTONE = 32, CHEST = 37, LAVA = 64;
const NETHERRACK = 115, NETHER_BRICKS = 116, FENCE = 117, SOUL_SAND = 119;
const MAGMA = 121, QUARTZ_ORE = 122, GOLD_ORE = 123, DEBRIS = 124;
const CRIMSON_NYLIUM = 125, WARPED_NYLIUM = 126, NETHER_WART = 138, SPAWNER = 141;
const SHROOMLIGHT = 133, CRIMSON_FUNGUS = 134, WARPED_FUNGUS = 135;
const CRIMSON_ROOTS = 136, WARPED_ROOTS = 137, BONE = 139;

const LAVA_LEVEL = 31;
const idx = (x, y, z) => (y << 8) | ((z & 15) << 4) | (x & 15);
const smooth = t => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

/** subSeed for a named Nether stream (disjoint from 02's overworld names). */
const sub = (worldSeed, name) => mix32(worldSeed ^ hashString('nether:' + name));

/** Smooth 3D value noise in [-1,1] from a posHash lattice. */
function noise3(seed, x, y, z) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = smooth(x - x0), fy = smooth(y - y0), fz = smooth(z - z0);
  const h = (xi, yi, zi) => posHash(seed, xi, yi, zi) * 2 - 1;
  const c00 = lerp(h(x0, y0, z0), h(x0 + 1, y0, z0), fx);
  const c10 = lerp(h(x0, y0 + 1, z0), h(x0 + 1, y0 + 1, z0), fx);
  const c01 = lerp(h(x0, y0, z0 + 1), h(x0 + 1, y0, z0 + 1), fx);
  const c11 = lerp(h(x0, y0 + 1, z0 + 1), h(x0 + 1, y0 + 1, z0 + 1), fx);
  return lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz);
}
/** Smooth 2D value noise in [-1,1]. */
function noise2(seed, x, z) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = smooth(x - x0), fz = smooth(z - z0);
  const h = (xi, zi) => posHash(seed, xi, 0, zi) * 2 - 1;
  return lerp(lerp(h(x0, z0), h(x0 + 1, z0), fx), lerp(h(x0, z0 + 1), h(x0 + 1, z0 + 1), fx), fz);
}

// §4.2 biome ids
const WASTES = 0, CRIMSON = 1, WARPED = 2, SSV = 3;
function biomeAt(s, x, z) {
  const t = noise2(s.biomeT, x / 280, z / 280);
  const h = noise2(s.biomeH, x / 240, z / 240);
  if (t < -0.35) return SSV;
  if (h > 0.33) return WARPED;
  if (h < -0.33) return CRIMSON;
  return WASTES;
}

// §4.3 cavern density
function netherDensity(s, x, y, z) {
  const n1 = noise3(s.cavern, x / 48, y / 40, z / 48);
  const n2 = 0.5 * noise3(s.cavern2, x / 22, y / 18, z / 22);
  return (n1 + n2) / 1.5;
}

const rngInt = (rng, n) => Math.floor(rng() * n);

/**
 * Build a generator bound to a worldSeed. Returns { generateChunk(cx,cz) } whose
 * output matches the overworld generator's shape (blocks/heightMap/biomes/spawns).
 */
export function createNetherGenerator(seed) {
  const worldSeed = typeof seed === 'number' ? (seed >>> 0) : hashString(String(seed ?? ''));
  const s = {
    bedrock: sub(worldSeed, 'bedrock'), cavern: sub(worldSeed, 'cavern'),
    cavern2: sub(worldSeed, 'cavern2'), biomeT: sub(worldSeed, 'biomeT'),
    biomeH: sub(worldSeed, 'biomeH'), ore: sub(worldSeed, 'ore'),
    decor: sub(worldSeed, 'decor'), glow: sub(worldSeed, 'glow'),
    fortress: sub(worldSeed, 'fortress'),
  };

  function generateChunk(cx, cz) {
    const blocks = new Uint8Array(32768);
    const biomes = new Uint8Array(256);
    const heightMap = new Uint8Array(256);   // match overworld/Chunk (values ≤ 127)
    const spawns = [];
    const set = (x, y, z, id) => { blocks[idx(x, y, z)] = id; };
    const get = (x, y, z) => blocks[idx(x, y, z)];

    // 1. vertical structure + cavern carve + lava sea
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const wx = cx * 16 + lx, wz = cz * 16 + lz;
        biomes[(lz << 4) | lx] = biomeAt(s, wx, wz);
        for (let y = 0; y <= 127; y++) {
          let id = NETHERRACK;
          if (y === 0 || y === 127) id = BEDROCK;
          else if (y <= 4) id = posHash(s.bedrock, wx, y, wz) < (5 - y) / 4 ? BEDROCK : NETHERRACK;
          else if (y >= 123) id = posHash(s.bedrock, wx, y, wz) < (y - 122) / 4 ? BEDROCK : NETHERRACK;
          else {
            // cavern carve; taper near roof/floor so they stay mostly closed
            let thr = 0.30;
            if (y > 112) thr += (y - 112) * 0.05;
            if (y < 10) thr += (10 - y) * 0.05;
            if (Math.abs(netherDensity(s, wx, y, wz)) < thr) id = AIR;
          }
          set(lx, y, lz, id);
        }
        // lava sea: carved-air at y<=31 → lava source
        for (let y = 5; y <= LAVA_LEVEL; y++) if (get(lx, y, lz) === AIR) set(lx, y, lz, LAVA);
      }
    }

    // 2. ores + glowstone ceilings (per-chunk stream; origin-local, no cross-chunk)
    generateOres(s, blocks, cx, cz);

    // 3. surface decoration (biome palette)
    decorate(s, blocks, biomes, cx, cz, spawns);

    // 4. fortress (deterministic; may write spawner + wart + chests + a spawn record)
    generateFortress(s, blocks, cx, cz, spawns);

    // 5. heightmap: topmost solid (feeds nothing with sky off, but kept consistent)
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        let h = 0;
        for (let y = 127; y >= 0; y--) { if (get(lx, y, lz) !== AIR) { h = y + 1; break; } }
        heightMap[(lz << 4) | lx] = h;
      }
    }
    return { blocks, heightMap, biomes, spawns };
  }

  return { generateChunk };
}

function generateOres(s, blocks, cx, cz) {
  const rng = splitmix32(chunkSeed(s.ore, cx, cz));
  const set = (x, y, z, id) => { if (x >= 0 && x < 16 && z >= 0 && z < 16 && y > 0 && y < 127) blocks[idx(x, y, z)] = id; };
  const get = (x, y, z) => (x >= 0 && x < 16 && z >= 0 && z < 16 ? blocks[idx(x, y, z)] : -1);
  // §4.5 air-discard: a cell touching carved air is "exposed"; out-of-chunk and
  // out-of-range neighbors count as solid (chunk-local ⇒ still deterministic).
  const exposedToAir = (x, y, z) =>
    get(x + 1, y, z) === AIR || get(x - 1, y, z) === AIR ||
    get(x, y + 1, z) === AIR || get(x, y - 1, z) === AIR ||
    get(x, y, z + 1) === AIR || get(x, y, z - 1) === AIR;
  const vein = (id, cxCount, size, ylo, yhi, buriedOnly) => {
    for (let a = 0; a < cxCount; a++) {
      const ox = rngInt(rng, 16), oz = rngInt(rng, 16), oy = ylo + rngInt(rng, yhi - ylo + 1);
      for (let b = 0; b < size; b++) {
        const x = ox + rngInt(rng, 3) - 1, y = oy + rngInt(rng, 3) - 1, z = oz + rngInt(rng, 3) - 1;
        if (get(x, y, z) !== NETHERRACK) continue;
        // §4.5 debris air-discard 1.0: never lines cavern walls — strip-mine only.
        if (buriedOnly && exposedToAir(x, y, z)) continue;
        set(x, y, z, id);
      }
    }
  };
  vein(QUARTZ_ORE, 16, 14, 10, 117);
  vein(GOLD_ORE, 10, 13, 10, 117);
  vein(MAGMA, 4, 16, 27, 36);
  vein(DEBRIS, 1, 3, 8, 24, true);    // large-ish cluster, fully buried
  vein(DEBRIS, 1, 2, 8, 119, true);
  // glowstone ceiling blobs
  for (let a = 0; a < 10; a++) {
    const ox = rngInt(rng, 16), oz = rngInt(rng, 16);
    for (let y = 120; y >= 34; y--) {
      if (get(ox, y, oz) === AIR && get(ox, y + 1, oz) === NETHERRACK && noise3(s.glow, (cx * 16 + ox) / 40, y / 40, (cz * 16 + oz) / 40) > 0.2) {
        const tall = 2 + rngInt(rng, 3);
        for (let d = 0; d < tall; d++) if (get(ox, y - d, oz) === AIR) set(ox, y - d, oz, GLOWSTONE);
        break;
      }
    }
  }
}

function decorate(s, blocks, biomes, cx, cz, spawns) {
  const set = (x, y, z, id) => { blocks[idx(x, y, z)] = id; };
  const get = (x, y, z) => (y >= 0 && y <= 127 ? blocks[idx(x, y, z)] : -1);
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const biome = biomes[(lz << 4) | lx];
      // topY = highest solid netherrack below open air (walkable surface)
      let topY = -1;
      for (let y = 122; y >= 5; y--) {
        if (get(lx, y, lz) === NETHERRACK && get(lx, y + 1, lz) === AIR) { topY = y; break; }
      }
      if (topY < 0) continue;
      const wx = cx * 16 + lx, wz = cz * 16 + lz;
      const roll = posHash(s.decor, wx, topY, wz);   // [0,1) column-local ⇒ deterministic
      const above = get(lx, topY + 1, lz) === AIR;
      // Surface scatter (§4.7) — small plants + shroomlight accents. Multi-block
      // huge fungi are deferred (see DEVIATIONS); these give each forest identity.
      if (biome === CRIMSON) {
        set(lx, topY, lz, CRIMSON_NYLIUM);
        if (above) {
          if (roll < 0.03) set(lx, topY + 1, lz, SHROOMLIGHT);
          else if (roll < 0.12) set(lx, topY + 1, lz, CRIMSON_FUNGUS);
          else if (roll < 0.32) set(lx, topY + 1, lz, CRIMSON_ROOTS);
        }
      } else if (biome === WARPED) {
        set(lx, topY, lz, WARPED_NYLIUM);
        if (above) {
          if (roll < 0.02) set(lx, topY + 1, lz, SHROOMLIGHT);
          else if (roll < 0.09) set(lx, topY + 1, lz, WARPED_FUNGUS);
          else if (roll < 0.24) set(lx, topY + 1, lz, WARPED_ROOTS);
        }
      } else if (biome === SSV) {
        set(lx, topY, lz, SOUL_SAND);
        if (roll < 0.012) {                          // sparse bone fossil pillar (§4.8)
          const h = 2 + Math.floor(posHash(s.decor, wx, topY + 7, wz) * 3);
          for (let d = 0; d < h; d++) if (get(lx, topY + 1 + d, lz) === AIR) set(lx, topY + 1 + d, lz, BONE);
        }
      }
    }
  }
}

// ------------------------------------------------------------ §5 fortress
// SIMPLIFIED (see DEVIATIONS): rather than the full BFS piece grammar, each
// 27×27-chunk region deterministically places ONE compact fortress core — a
// nether-brick bridge platform with a blaze room (spawner + fence cage) and a
// wart garden (soul_sand + stage-3 nether_wart + a loot chest). This guarantees
// the gate item (a fortress with a blaze spawner) deterministically, replayed
// identically from every overlapping chunk.
const REGION = 27;

function fortressOrigin(s, regionX, regionZ) {
  const rng = splitmix32(mix32(s.fortress ^ mix32(regionX * 341873128 + regionZ * 132897987)));
  return {
    ocx: regionX * REGION + rngInt(rng, 20),
    ocz: regionZ * REGION + rngInt(rng, 20),
    oy: 48 + rngInt(rng, 24),
  };
}

function generateFortress(s, blocks, cx, cz, spawns) {
  const set = (lx, y, lz, id) => { if (lx >= 0 && lx < 16 && lz >= 0 && lz < 16 && y >= 0 && y <= 127) blocks[idx(lx, y, lz)] = id; };
  // any fortress within Chebyshev 2 regions could overlap this chunk
  for (let dRegX = -1; dRegX <= 1; dRegX++) {
    for (let dRegZ = -1; dRegZ <= 1; dRegZ++) {
      const regionX = Math.floor(cx / REGION) + dRegX;
      const regionZ = Math.floor(cz / REGION) + dRegZ;
      const { ocx, ocz, oy } = fortressOrigin(s, regionX, regionZ);
      // fortress footprint: a 16×16-block core centred on the origin chunk's SW
      const baseX = ocx * 16, baseZ = ocz * 16;
      // write only cells that fall in the CURRENT chunk
      const writeCell = (wx, y, wz, id) => {
        if ((wx >> 4) === cx && (wz >> 4) === cz) set(wx & 15, y, wz & 15, id);
      };
      const bx = baseX, bz = baseZ, y0 = oy;
      // main platform 13×13 nether-brick floor
      for (let x = 0; x < 13; x++) for (let z = 0; z < 13; z++) writeCell(bx + x, y0, bz + z, NETHER_BRICKS);
      // perimeter fence rail
      for (let x = 0; x < 13; x++) { writeCell(bx + x, y0 + 1, bz, FENCE); writeCell(bx + x, y0 + 1, bz + 12, FENCE); }
      for (let z = 0; z < 13; z++) { writeCell(bx, y0 + 1, bz + z, FENCE); writeCell(bx + 12, y0 + 1, bz + z, FENCE); }
      // blaze room: a 2-block pillar topped with a spawner, fence-caged
      const px = bx + 6, pz = bz + 3;
      writeCell(px, y0 + 1, pz, NETHER_BRICKS);
      writeCell(px, y0 + 2, pz, NETHER_BRICKS);
      writeCell(px, y0 + 3, pz, SPAWNER);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        writeCell(px + dx, y0 + 3, pz + dz, FENCE);
        writeCell(px + dx, y0 + 4, pz + dz, FENCE);
      }
      // the blaze spawner block-entity record (configured on the main thread)
      if ((px >> 4) === cx && (pz >> 4) === cz) {
        spawns.push({ be: 'spawner', x: px, y: y0 + 3, z: pz, mobType: 'blaze' });
      }
      // wart garden: soul_sand row with stage-3 nether_wart + a loot chest
      for (let x = 0; x < 5; x++) {
        writeCell(bx + 2 + x, y0, bz + 9, SOUL_SAND);
        writeCell(bx + 2 + x, y0 + 1, bz + 9, NETHER_WART);   // stage 0 in block; grows, but garden = stage 3
      }
      writeCell(bx + 8, y0 + 1, bz + 9, CHEST);
    }
  }
}
