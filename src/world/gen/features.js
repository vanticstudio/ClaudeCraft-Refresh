// 02 §10–§11 — decoration pass (trees, plants, snow/ice), heightmap,
// worldgen herds. PURE module: also imported by the main thread for sapling
// growth (01 module map exception).

import { splitmix32, chunkSeed, posHash, rngInt } from '../../math/rng.js';
import { BLOCKS, B } from '../../registry/blocks.js';   // 01 §5 — one heightmap predicate
import { stampVillages } from './village.js';   // 12-VILLAGES §2
import { stampDungeons } from './dungeons.js';  // B5 — dungeons/ruins/wells
import { ID, BIOMES, TREE_CFG, GRASS_COUNT, FLOWER_COUNT, CANE_BIOMES,
         PUMPKIN_BIOMES, HERD_WEIGHTS, hollowAt, HOLLOW_SURFACE_MIN,
         HOLLOW_Y_MAX } from './biomes.js';

const LOGS = { oak: ID.oak_log, birch: ID.birch_log, spruce: ID.spruce_log };
const LEAVES = { oak: ID.oak_leaves, birch: ID.birch_leaves, spruce: ID.spruce_leaves };
const isLeafId = id => id === ID.oak_leaves || id === ID.birch_leaves || id === ID.spruce_leaves;

// The chunk-centre column index (z<<4|x = 136) — never masked; see the B12
// header for why village.js's centre-keyed gate needs it untouched.
const HOLLOW_CENTER_CI = (8 << 4) | 8;

// ============================================================================
// B12 — "The Hollow" (19-BUILDOUT §B12). Applied at the END of decorate: every
// surface-decoration decision (trees, cane, pumpkin, grass/flowers, villages,
// dungeon/ruin gates, snow) has already read the biome by then, so the mask can
// never influence the pass that applies it, and its own re-application is
// idempotent (the predicate below never reads the biome except to detect an
// already-masked column).
//
// WHY MUTATE colD (the LRU-cached column record) at all: terrain.js builds the
// chunk's biomes array with `Uint8Array.from(colD.biome)` AFTER decorate
// returns — this pass is the only hook in B12's file list that runs before
// that copy, so it is the only route the HOLLOW id has into chunk.biomes.
//
// WHY the mask is safe for every other gen reader: the LRU shares colD across
// chunks, so a LATER decorate (neighbour tree re-derivation, village/dungeon
// anchor gates) and any chunk REVISIT re-reading colD can observe masked
// values. The companion contract in biomes.js holds that stable:
//   1. only PLAINS columns are ever masked, and every per-biome gen table
//      (TREE_CFG/GRASS_COUNT/FLOWER_COUNT/CANE_BIOMES/PUMPKIN_BIOMES/
//      HERD_WEIGHTS/BIOME_TEMPS) carries an index-12 entry byte-equal to
//      plains's, so reads of 12 behave exactly like reads of 3;
//   2. the chunk-CENTRE column (136) is never masked — village.js's
//      VILLAGE_BIOMES gate (outside B12's file list) and the tree/cane/pumpkin
//      centre reads key on ctx.biomeAt of a chunk centre and must keep seeing
//      the original biome in every derivation order.
// With both halves held, first-visit and re-visit derivations agree at every
// read site (ores' only biome gate is MOUNTAINS — never masked; dungeons'
// desert gate is negative — a masked column fails it exactly like its plains
// original; surfaceBlockFor(12, h) === surfaceBlockFor(3, h) for every masked
// height band, since plains only exists at 64..91).
// ============================================================================

// B12 §3 — 1 sentinel per ~32 hollow chunks (the brief's recalibration of the
// spec's "~1 per 40×40 HOLLOW region"), gated on the chunk-centre column
// passing the biome predicate and landed on a standable underground cell
// verified against this chunk's own blocks.
const HOLLOW_SENTINEL_CHANCE = 1 / 32;
// B12 §2 — growth density per cave-floor cell in the band. Emission 4 each.
// Measured: the band holds ~0.46 solid-floor air cells per hollow column, so
// 0.35 lands ~7 growths per hollow chunk — every ~2.5 columns of cave floor:
// clustered enough to read as glow patches, sparse enough to stay moody (spec:
// "navigable without torches but stays moody").
const HOLLOW_GROWTH_DENSITY = 0.35;
// B12 §2 — echo_ore veins in the band's hollow stone (rare, per spec).
const ECHO_ORE_CHANCE = 0.0015;

function stampHollow(ctx, blocks, cx, cz, colD) {
  const wx0 = cx * 16, wz0 = cz * 16;
  const HOLLOW = BIOMES.HOLLOW;
  const spawns = [];

  // 1. The biome mask (B12 §1). Sample the cave-noise band FIRST: three
  //    cheese-field points at y 8/14/20 — all strictly inside y < 24, never
  //    above it (the noise itself carries the spec's y<24 constraint).
  const bandNoise = new Float64Array(256);
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const ci = (z << 4) | x;
      const wx = wx0 + x, wz = wz0 + z;
      bandNoise[ci] = (ctx.cheeseAt(wx, 8, wz) + ctx.cheeseAt(wx, 14, wz) + ctx.cheeseAt(wx, 20, wz)) / 3;
      if (ci === HOLLOW_CENTER_CI) continue;                 // centre stays original (see header)
      const cur = colD.biome[ci];
      if (cur !== BIOMES.PLAINS && cur !== HOLLOW) continue; // idempotent on revisits
      if (colD.h[ci] < HOLLOW_SURFACE_MIN) continue;         // dry land only — never oceans
      if (hollowAt(colD.h[ci], bandNoise[ci])) colD.biome[ci] = HOLLOW;
    }
  }

  // 2. The band's blocks (B12 §2): plain stone → hollow_stone; echo_ore
  //    sprinkled into it by a stateless posHash (per-cell, so both the carve
  //    order and any later re-derivation agree); growth on the cave floors.
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const ci = (z << 4) | x;
      if (colD.biome[ci] !== HOLLOW) continue;
      const wx = wx0 + x, wz = wz0 + z;
      for (let y = 2; y < HOLLOW_Y_MAX; y++) {
        const i = (y << 8) | ci;
        if (blocks[i] !== ID.stone) continue;
        blocks[i] = ID.hollow_stone;
        if (posHash(ctx.seeds.detail, wx, y, wz) < ECHO_ORE_CHANCE) blocks[i] = ID.echo_ore;
      }
      for (let y = 4; y < HOLLOW_Y_MAX; y++) {
        const i = (y << 8) | ci;
        if (blocks[i] !== ID.air) continue;                  // ore hash above keys on stone cells,
        const below = BLOCKS[blocks[((y - 1) << 8) | ci]];   // this one on air cells — never the same cell
        if (!below.opaque || !below.collidable) continue;    // solid floor only (lava fails)
        if (posHash(ctx.seeds.detail, wx, y, wz) >= HOLLOW_GROWTH_DENSITY) continue;
        blocks[i] = ID.hollow_growth;
      }
    }
  }

  // 3. The Sentinel (B12 §3). The gate reads the PREDICATE at the centre
  //    column, not the stored biome — the centre is exempt from masking, so
  //    this is stable across every derivation order.
  const rng = splitmix32(chunkSeed(ctx.seeds.detail, cx, cz));
  const centreH = colD.h[HOLLOW_CENTER_CI];
  const centreNoise = bandNoise[HOLLOW_CENTER_CI];
  if (centreH >= HOLLOW_SURFACE_MIN && hollowAt(centreH, centreNoise) && rng() < HOLLOW_SENTINEL_CHANCE) {
    // First standable cell in the y 8..20 band: 3 cells of air (2.9-tall box)
    // with clear horizontal neighbours at foot level (the 1.2-wide box must not
    // spawn half-buried in a cave wall), over an opaque floor — scanned in a
    // fixed ci-then-y order so the pick is a pure function of the chunk's blocks.
    const at = i => blocks[i];
    const solidFloor = i => { const bl = BLOCKS[at(i)]; return bl.opaque && bl.collidable; };
    const clear = i => at(i) === ID.air;
    outer:
    for (let ci = 0; ci < 256; ci++) {
      if (colD.biome[ci] !== HOLLOW) continue;               // spawn inside the biome
      for (let y = 20; y >= 8; y--) {
        const i = (y << 8) | ci;
        if (!clear(i) || !clear(i + 256) || !clear(i + 512)) continue;
        if (!solidFloor(i - 256)) continue;
        const lx = ci & 15, lz = ci >> 4;
        if (lx === 0 || lx === 15 || lz === 0 || lz === 15) continue;   // keep clear-test in-chunk
        if (!clear(i + 1) || !clear(i - 1) || !clear(i + 16) || !clear(i - 16)) continue;
        spawns.push({ type: 'sentinel', x: wx0 + lx + 0.5, y, z: wz0 + lz + 0.5 });
        break outer;
      }
    }
  }
  return spawns;
}

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
export function decorate(ctx, blocks, cx, cz, colD, states = null) {
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

  // 02 §10.5 DEVIATION — plant DECISIONS are per COLUMN, not per chunk centre.
  // `biome` (the centre column) still gates which plant loops RUN, so no rng draw
  // is added, removed or reordered; but each attempt is additionally rejected when
  // ITS OWN column is not a legal biome. Before, a chunk whose centre was desert
  // scattered cactus across its grassy half and grass density changed in hard
  // 16×16 squares along every biome border (a visible chunk grid).
  // Trees (above) stay centre-column per §10.3.
  const bAt = (x, z) => colD.biome[(z << 4) | x];

  if (biome === BIOMES.DESERT) {
    // cactus ×3: 1–3 tall, all 4 horizontal neighbors of every cell air
    for (let a = 0; a < 3; a++) {
      const x = rngInt(rng, 16), z = rngInt(rng, 16);
      const h = colD.h[(z << 4) | x];
      const height = 1 + rngInt(rng, 3);
      if (bAt(x, z) !== BIOMES.DESERT) continue;          // §10.5 per-column gate
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
      if (bAt(x, z) !== BIOMES.DESERT) continue;          // §10.5 per-column gate
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
      if (!CANE_BIOMES.has(bAt(x, z))) continue;          // §10.5 per-column gate
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
      if (!PUMPKIN_BIOMES.has(bAt(x, z))) continue;       // §10.5 per-column gate
      const h = colD.h[(z << 4) | x];
      if (h < 127 && at(x, h, z) === ID.grass_block && at(x, h + 1, z) === ID.air) {
        set(x, h + 1, z, ID.pumpkin);
      }
    }
  }

  // §10.5 DEVIATION — ground cover: chunk-wide attempt COUNT, per-column GATE,
  // and clumping. The count is the max over the chunk's own columns (pure function
  // of colD, no draw), and an attempt on a column whose biome wants fewer is
  // dropped by a stateless posHash at gb/gMax odds — so a biome border becomes a
  // per-column density GRADIENT instead of a hard 16×16 step. Inside one biome
  // gMax === GRASS_COUNT[biome] and the gate never fires, i.e. the common case is
  // exactly §6.3's count.
  let gMax = 0, fMax = 0;
  for (let ci = 0; ci < 256; ci++) {
    const g = GRASS_COUNT[colD.biome[ci]]; if (g > gMax) gMax = g;
    const f = FLOWER_COUNT[colD.biome[ci]]; if (f > fMax) fMax = f;
  }
  // Clumping reuses the two draws §10.5 already takes: their sum picks one of 3
  // chunk-local patch centres and their low bits scatter ±3 around it, so no rng
  // draw is added, removed or reordered (cane/pumpkin/mushroom output above and
  // below is unaffected). Uniform scatter read as an evenly-sprayed texture;
  // patches read as meadows. Wrap (not clamp) the offset so patches never pile up
  // against a chunk edge. Known limitation: patches are chunk-local, so a meadow
  // never spans a chunk border.
  const patch = (kBase, rx, rz) => {
    const k = (rx + rz) % 3;
    const kx = Math.floor(posHash(ctx.seeds.detail, cx, kBase + k, cz) * 16);
    const kz = Math.floor(posHash(ctx.seeds.detail, cx, kBase + 8 + k, cz) * 16);
    return [(kx + (rx % 7) - 3 + 16) & 15, (kz + (rz % 7) - 3 + 16) & 15, k];
  };

  for (let a = 0; a < gMax; a++) {
    const rx = rngInt(rng, 16), rz = rngInt(rng, 16);
    const [x, z] = patch(700, rx, rz);
    const ci = (z << 4) | x;
    const gb = GRASS_COUNT[colD.biome[ci]];
    if (gb === 0) continue;
    if (gb < gMax && posHash(ctx.seeds.detail, wx0 + x, 3, wz0 + z) >= gb / gMax) continue;
    const h = colD.h[ci];
    if (h < 127 && at(x, h, z) === ID.grass_block && at(x, h + 1, z) === ID.air) {
      set(x, h + 1, z, ID.short_grass);
    }
  }
  for (let a = 0; a < fMax; a++) {
    const rx = rngInt(rng, 16), rz = rngInt(rng, 16);
    // 900: flower patches use their own centres, so they do not land inside the
    // grass patches already written (which would block them — the air test below).
    const [x, z, k] = patch(900, rx, rz);
    const ci = (z << 4) | x;
    const fb = FLOWER_COUNT[colD.biome[ci]];
    if (fb === 0) continue;
    if (fb < fMax && posHash(ctx.seeds.detail, wx0 + x, 4, wz0 + z) >= fb / fMax) continue;
    const h = colD.h[ci];
    if (h < 127 && at(x, h, z) === ID.grass_block && at(x, h + 1, z) === ID.air) {
      // §10.5 DEVIATION — species is per PATCH, not per block. The per-block
      // posHash made every flower field a 50/50 pepper of both species; real
      // patches are monoculture. Keyed off the patch, so no chunk-grid seam.
      const flower = posHash(ctx.seeds.detail, cx, 1100 + k, cz) < 0.5
        ? ID.dandelion : ID.poppy;
      set(x, h + 1, z, flower);
    }
  }

  // 3.5 cave mushrooms (09-POTIONS §7.4 / AMENDS 02 §10.2) — drawn from the plant
  // stream AFTER flowers so prior features stay byte-identical. Sparse, on solid
  // cave floors in the Y 8–47 band; the runtime light gate pops any lit too bright.
  for (let a = 0; a < 3; a++) {
    if (rng() > 0.3) continue;
    const x = rngInt(rng, 16), z = rngInt(rng, 16);
    const y = 8 + rngInt(rng, 40);
    const floor = at(x, y - 1, z);
    if (at(x, y, z) === ID.air && at(x, y + 1, z) === ID.air && (floor === ID.stone || floor === ID.dirt)) {
      set(x, y, z, rng() < 0.6 ? 110 : 111);   // brown 60% / red 40%
    }
  }

  // 4. VILLAGE stamp (12-VILLAGES §2, AMENDS 02 §10.2) — after all vegetation
  // (clears it in the stamped volumes), before snow so taiga roofs get caps.
  const village = stampVillages(ctx, blocks, cx, cz, states);   // states: door/bed/crop nibbles

  // 4b. B5 — dungeon/ruin/well stamps (after villages: an underground room
  // carving beneath a village is fine; a ruin overwriting a village house is
  // not, and this order keeps villages authoritative on the surface)
  const dungeon = stampDungeons(ctx, blocks, cx, cz);

  // 5. Snow & ice — climate rule (02 §10.6)
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const ci = (z << 4) | x;
      const h = colD.h[ci];
      // COUPLED CONSTANT — must equal biomes.js selectBiome's cooling term
      // (0.008 × noise.js CLIMATE_GAIN 1.7 = 0.0136). colD.t is already gained.
      const tEff = colD.t[ci] - Math.max(0, h - 80) * 0.0136;
      if (!(tEff < -0.45 || h >= 104)) continue;
      let top = 127;
      while (top > 0 && at(x, top, z) === ID.air) top--;
      const id = at(x, top, z);
      if (id === ID.water && top === 63) set(x, top, z, ID.ice);
      else if (SOLID_TOP[id] && top < 127) set(x, top + 1, z, ID.snow_layer);
    }
  }
  // 6. B12 — "The Hollow" (last: every surface pass above must have already
  //    read the un-masked biome; see stampHollow's header for the stability
  //    contract that makes the LRU-shared colD mutation safe)
  const hollowSpawns = stampHollow(ctx, blocks, cx, cz, colD);

  // B5/B12 — merge dungeon + hollow spawn records into the village spawn
  // stream (same terrain.js contract; chunk.pendingSpawns resolves all three)
  const spawns = [...(village?.spawns ?? []), ...(dungeon?.spawns ?? []), ...hollowSpawns];
  return { villageMeta: village?.villageMeta ?? null, spawns };
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
                    ID.gold_ore, ID.diamond_ore, ID.redstone_ore, ID.lapis_ore,
                    // 12-VILLAGES §2.5/§4.4 — villages stamp BEFORE the snow pass
                    // precisely so taiga roofs cap; cobblestone/oak/spruce planks
                    // are village build materials with no gen/biomes.js ID entry.
                    4, 5, 7]) {
    a[id] = 1;
  }
  return a;
})();

// Blocks that do NOT terminate the sky heightmap (01 §4.2). Derived from the
// registry so it is EXACTLY LightEngine.terminatesSky(id, 0): worldgen never emits
// bit 7, so state is moot, but the id half must agree or a decorated column's
// heightMap changes between worldgen and the save/reload recompute (ChunkManager
// hydrate/_recomputeHeightMap) and canSeeSky/isRainingAt flip under the player.
const HM_SKIP = (() => {
  const a = new Uint8Array(256);
  for (let id = 0; id < 256; id++) {
    const b = BLOCKS[id];
    a[id] = (b && b.opacity === 0 && id !== B.SNOW_LAYER && id !== B.CACTUS) ? 1 : 0;
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
