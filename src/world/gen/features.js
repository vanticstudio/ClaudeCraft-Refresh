// 02 §10–§11 — decoration pass (trees, plants, snow/ice), heightmap,
// worldgen herds. PURE module: also imported by the main thread for sapling
// growth (01 module map exception).

import { splitmix32, chunkSeed, posHash, rngInt } from '../../math/rng.js';
import { ID, BIOMES, TREE_CFG, GRASS_COUNT, FLOWER_COUNT, CANE_BIOMES,
         PUMPKIN_BIOMES, HERD_WEIGHTS } from './biomes.js';

const LOGS = { oak: ID.oak_log, birch: ID.birch_log, spruce: ID.spruce_log };
const LEAVES = { oak: ID.oak_leaves, birch: ID.birch_leaves, spruce: ID.spruce_leaves };
const isLeafId = id => id === ID.oak_leaves || id === ID.birch_leaves || id === ID.spruce_leaves;

// Trunk height roll — one rng draw per species (02 §10.4)
export function rollTreeHeight(species, rng) {
  if (species === 'oak') return 4 + rngInt(rng, 3);      // 4–6
  if (species === 'birch') return 5 + rngInt(rng, 3);    // 5–7
  return 7 + rngInt(rng, 4);                             // spruce 7–10
}

// Place a tree with known height. put(wx, wy, wz, id, mode) clips/filters:
// 'leaf' writes over air only, 'log' over air/leaves, 'dirt' replaces ground.
// canPlaceTrunk (optional, runtime sapling growth): checked for every trunk
// cell before any write; returns false ⇒ nothing placed.
export function placeTreeH(species, H, x, groundY, z, detailSeed, put, canPlaceTrunk) {
  const log = LOGS[species], leaf = LEAVES[species];
  const O = groundY + 1;
  if (canPlaceTrunk) {
    for (let ly = 0; ly < H; ly++) {
      if (!canPlaceTrunk(x, O + ly, z)) return false;
    }
  }
  put(x, groundY, z, ID.dirt, 'dirt');
  for (let ly = 0; ly < H; ly++) put(x, O + ly, z, log, 'log');

  const corner = (wx, wy, wz) => posHash(detailSeed, wx, wy, wz) < 0.5;
  const ring = (wy, r, cornerMode) => {
    // cornerMode: 'roll' = posHash leaf, 'trim' = never, 'keep' = always
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (dx === 0 && dz === 0) continue;             // trunk column
        if (Math.abs(dx) === r && Math.abs(dz) === r) {
          if (cornerMode === 'trim') continue;
          if (cornerMode === 'roll' && !corner(x + dx, wy, z + dz)) continue;
        }
        put(x + dx, wy, z + dz, leaf, 'leaf');
      }
    }
  };

  if (species === 'spruce') {
    put(x, O + H, z, leaf, 'leaf');                     // tip
    ring(O + H - 1, 1, 'trim');                         // plus (3×3 minus corners)
    ring(O + H - 2, 1, 'keep');                         // full 3×3
    ring(O + H - 3, 2, 'trim');                         // 5×5 minus corners
    ring(O + H - 4, 1, 'keep');
    ring(O + H - 5, 2, 'trim');
  } else {                                              // oak / birch
    ring(O + H - 3, 2, 'roll');
    ring(O + H - 2, 2, 'roll');
    ring(O + H - 1, 1, 'roll');
    put(x, O + H, z, leaf, 'leaf');                     // top plus
    put(x + 1, O + H, z, leaf, 'leaf');
    put(x - 1, O + H, z, leaf, 'leaf');
    put(x, O + H, z + 1, leaf, 'leaf');
    put(x, O + H, z - 1, leaf, 'leaf');
  }
  return true;
}

// Convenience wrapper drawing H itself (runtime sapling growth, 06 §5.12)
export function placeTree(species, x, groundY, z, rng, detailSeed, put, canPlaceTrunk) {
  return placeTreeH(species, rollTreeHeight(species, rng), x, groundY, z,
                    detailSeed, put, canPlaceTrunk);
}

function makePut(blocks, cx, cz) {
  const x0 = cx * 16, z0 = cz * 16;
  return (wx, wy, wz, id, mode) => {
    if (wy < 0 || wy > 127) return;
    const lx = wx - x0, lz = wz - z0;
    if (lx < 0 || lx > 15 || lz < 0 || lz > 15) return;
    const i = (wy << 8) | (lz << 4) | lx;
    const cur = blocks[i];
    if (mode === 'leaf') { if (cur === ID.air) blocks[i] = id; }
    else if (mode === 'log') { if (cur === ID.air || isLeafId(cur)) blocks[i] = id; }
    else { if (cur !== ID.air) blocks[i] = id; }        // dirt under trunk
  };
}

function pickSpecies(mix, roll) {
  if (mix === 'forest') return roll < 0.75 ? 'oak' : 'birch';
  return mix;
}

// 02 §10.2 — full decoration pass for one chunk (fixed order)
export function decorate(ctx, blocks, cx, cz, colD) {
  const put = makePut(blocks, cx, cz);
  const wx0 = cx * 16, wz0 = cz * 16;

  // 1. Trees — origin chunks ±1, stream "tree" (02 §10.3)
  for (let ocx = cx - 1; ocx <= cx + 1; ocx++) {
    for (let ocz = cz - 1; ocz <= cz + 1; ocz++) {
      const rng = splitmix32(chunkSeed(ctx.seeds.tree, ocx, ocz));
      const cfg = TREE_CFG[ctx.biomeAt(ocx * 16 + 8, ocz * 16 + 8)];
      if (!cfg) continue;
      let attempts = cfg.count;
      if (cfg.chance !== undefined && rng() >= cfg.chance) attempts = 0;
      for (let a = 0; a < attempts; a++) {
        const x = ocx * 16 + rngInt(rng, 16);
        const z = ocz * 16 + rngInt(rng, 16);
        const species = pickSpecies(cfg.mix, rng());    // roll always drawn
        const H = rollTreeHeight(species, rng);         // draw kept aligned
        const ground = ctx.heightAt(x, z);
        if (ground < 63) continue;                      // not submerged
        const surf = ctx.surfaceBlockOf(x, z);
        if (surf !== ID.grass_block && surf !== ID.dirt) continue;
        if (ground + H + 1 > 127) continue;             // trunk clearance
        placeTreeH(species, H, x, ground, z, ctx.seeds.detail, put);
      }
    }
  }

  // 2–3. Plants — local, stream "plant", fixed order (02 §10.5)
  const rng = splitmix32(chunkSeed(ctx.seeds.plant, cx, cz));
  const biome = ctx.biomeAt(wx0 + 8, wz0 + 8);
  const at = (x, y, z) => blocks[(y << 8) | (z << 4) | x];
  const set = (x, y, z, id) => { blocks[(y << 8) | (z << 4) | x] = id; };

  if (biome === BIOMES.DESERT) {
    // cactus ×3: 1–3 tall, all 4 horizontal neighbors of every cell air
    for (let a = 0; a < 3; a++) {
      const x = rngInt(rng, 16), z = rngInt(rng, 16);
      const h = colD.h[(z << 4) | x];
      const height = 1 + rngInt(rng, 3);
      if (h >= 127 || at(x, h, z) !== ID.sand || at(x, h + 1, z) !== ID.air) continue;
      for (let k = 0; k < height && h + 1 + k <= 127; k++) {
        const y = h + 1 + k;
        if (!horizNeighborsClear(ctx, blocks, wx0, wz0, x, y, z)) break;
        set(x, y, z, ID.cactus);
      }
    }
    // dead bush ×2
    for (let a = 0; a < 2; a++) {
      const x = rngInt(rng, 16), z = rngInt(rng, 16);
      const h = colD.h[(z << 4) | x];
      if (h < 127 && at(x, h, z) === ID.sand && at(x, h + 1, z) === ID.air) {
        set(x, h + 1, z, ID.dead_bush);
      }
    }
  }

  if (CANE_BIOMES.has(biome)) {
    // sugar cane ×6: on grass/sand at y 62–64, water-source horizontal
    // neighbor of the SUPPORT block (pure gen-water test), height 2–4
    for (let a = 0; a < 6; a++) {
      const x = rngInt(rng, 16), z = rngInt(rng, 16);
      const height = 2 + rngInt(rng, 3);
      const h = colD.h[(z << 4) | x];
      if (h < 62 || h > 64) continue;
      const surf = at(x, h, z);
      if (surf !== ID.grass_block && surf !== ID.sand) continue;
      if (at(x, h + 1, z) !== ID.air) continue;
      const wx = wx0 + x, wz = wz0 + z;
      if (!(ctx.isGenWater(wx + 1, h, wz) || ctx.isGenWater(wx - 1, h, wz) ||
            ctx.isGenWater(wx, h, wz + 1) || ctx.isGenWater(wx, h, wz - 1))) continue;
      for (let k = 0; k < height && h + 1 + k <= 127; k++) {
        if (at(x, h + 1 + k, z) !== ID.air) break;
        set(x, h + 1 + k, z, ID.sugar_cane_block);
      }
    }
  }

  if (PUMPKIN_BIOMES.has(biome) && rng() < 1 / 64) {
    // pumpkin patch: 6 tries in ±3 around a random column, each 50%
    const bx = rngInt(rng, 16), bz = rngInt(rng, 16);
    for (let t = 0; t < 6; t++) {
      const x = bx + rngInt(rng, 7) - 3, z = bz + rngInt(rng, 7) - 3;
      const roll = rng() < 0.5;
      if (!roll || x < 0 || x > 15 || z < 0 || z > 15) continue;
      const h = colD.h[(z << 4) | x];
      if (h < 127 && at(x, h, z) === ID.grass_block && at(x, h + 1, z) === ID.air) {
        set(x, h + 1, z, ID.pumpkin);
      }
    }
  }

  for (let a = 0; a < GRASS_COUNT[biome]; a++) {
    const x = rngInt(rng, 16), z = rngInt(rng, 16);
    const h = colD.h[(z << 4) | x];
    if (h < 127 && at(x, h, z) === ID.grass_block && at(x, h + 1, z) === ID.air) {
      set(x, h + 1, z, ID.short_grass);
    }
  }
  for (let a = 0; a < FLOWER_COUNT[biome]; a++) {
    const x = rngInt(rng, 16), z = rngInt(rng, 16);
    const h = colD.h[(z << 4) | x];
    if (h < 127 && at(x, h, z) === ID.grass_block && at(x, h + 1, z) === ID.air) {
      const flower = posHash(ctx.seeds.detail, wx0 + x, h + 1, wz0 + z) < 0.5
        ? ID.dandelion : ID.poppy;
      set(x, h + 1, z, flower);
    }
  }

  // 4. Snow & ice — climate rule (02 §10.6)
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const ci = (z << 4) | x;
      const h = colD.h[ci];
      const tEff = colD.t[ci] - Math.max(0, h - 80) * 0.008;
      if (!(tEff < -0.45 || h >= 104)) continue;
      let top = 127;
      while (top > 0 && at(x, top, z) === ID.air) top--;
      const id = at(x, top, z);
      if (id === ID.water && top === 63) set(x, top, z, ID.ice);
      else if (SOLID_TOP[id] && top < 127) set(x, top + 1, z, ID.snow_layer);
    }
  }
}

// Cells whose 4 horizontal neighbors must be air for cactus growth;
// out-of-chunk neighbors use the pure heightmap test.
function horizNeighborsClear(ctx, blocks, wx0, wz0, x, y, z) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, nz = z + dz;
    if (nx >= 0 && nx <= 15 && nz >= 0 && nz <= 15) {
      if (blocks[(y << 8) | (nz << 4) | nx] !== ID.air) return false;
    } else if (y <= ctx.heightAt(wx0 + nx, wz0 + nz)) {
      return false;
    }
  }
  return true;
}

// Solid full-height gen-time blocks that carry a snow layer (not ice)
const SOLID_TOP = (() => {
  const a = new Uint8Array(256);
  for (const id of [ID.stone, ID.grass_block, ID.dirt, ID.sand, ID.gravel,
                    ID.sandstone, ID.bedrock, ID.oak_log, ID.birch_log,
                    ID.spruce_log, ID.oak_leaves, ID.birch_leaves,
                    ID.spruce_leaves, ID.pumpkin, ID.coal_ore, ID.iron_ore,
                    ID.gold_ore, ID.diamond_ore, ID.redstone_ore, ID.lapis_ore]) {
    a[id] = 1;
  }
  return a;
})();

// Blocks that do NOT terminate the sky heightmap (01 §4.2: cross plants)
const HM_SKIP = (() => {
  const a = new Uint8Array(256);
  for (const id of [ID.air, ID.short_grass, ID.dandelion, ID.poppy,
                    ID.dead_bush, ID.sugar_cane_block, ID.oak_sapling,
                    ID.birch_sapling, ID.spruce_sapling]) {
    a[id] = 1;
  }
  return a;
})();

export function computeHeightMap(blocks) {
  const hm = new Uint8Array(256);
  for (let ci = 0; ci < 256; ci++) {
    for (let y = 127; y >= 0; y--) {
      if (!HM_SKIP[blocks[(y << 8) | ci]]) { hm[ci] = y + 1; break; }
    }
  }
  return hm;
}

// 02 §11 — worldgen animal herds (spawn records, consumed on first load)
export function rollHerd(ctx, cx, cz) {
  const rng = splitmix32(chunkSeed(ctx.seeds.herd, cx, cz));
  if (rng() >= 0.10) return [];
  const size = 2 + rngInt(rng, 3);
  const hx = cx * 16 + rngInt(rng, 16), hz = cz * 16 + rngInt(rng, 16);
  const table = HERD_WEIGHTS[ctx.biomeAt(hx, hz)];
  if (!table) return [];
  let total = 0;
  for (const [, w] of table) total += w;
  let roll = rng() * total, type = table[table.length - 1][0];
  for (const [t, w] of table) {
    if (roll < w) { type = t; break; }
    roll -= w;
  }
  const out = [];
  for (let m = 0; m < size; m++) {
    for (let t = 0; t < 4; t++) {
      const bx = hx + rngInt(rng, 9) - 4, bz = hz + rngInt(rng, 9) - 4;
      const h = ctx.heightAt(bx, bz);
      if (h < 63) continue;
      if (ctx.surfaceBlockOf(bx, bz) !== ID.grass_block) continue;
      out.push({ type, x: bx + 0.5, y: h + 1, z: bz + 0.5 });
      break;
    }
  }
  return out;
}
