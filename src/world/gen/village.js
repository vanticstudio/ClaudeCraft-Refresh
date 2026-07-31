// 12-VILLAGES §2–§5 — deterministic multi-chunk village worldgen.
// UPDATE-village-gen-rework: layout content + terrain adaptation reworked; the
// stamp ARCHITECTURE below is unchanged and load-bearing:
//
// The whole layout is a PURE FUNCTION of its anchor chunk seed (§2.4). Every
// chunk that overlaps a village independently recomputes the layout and replays
// the SAME ordered op list, writing only cells inside itself — so the union is
// byte-identical to a single-pass stamp regardless of visit order. No chunk ever
// reads another chunk's blocks; terrain queries go through canonical heightAt.
// Worker-side (no registry import): block ids are hardcoded.
//
// Op phases fix the global replay order (§2.4): 1 CLEAR, 2 FOUNDATION, 3 PATH,
// 4 PIECES, 5 LAMP. Ops now carry an optional `state` nibble (door facing/half,
// bed facing/head, crop stage, farmland moisture) written alongside the id.

import { splitmix32, chunkSeed, rngInt, posHash } from '../../math/rng.js';
import { BIOMES } from './biomes.js';

// ---- block ids (registry-free, mirrors the registered ids) ----
const AIR = 0, GRASS = 2, DIRT = 3, COBBLE = 4, OAK_PLANKS = 5, SPRUCE_PLANKS = 7,
  SPRUCE_LOG = 10, OAK_LOG = 8, SANDSTONE = 20, BEDROCK = 17, GLASS = 31, CHEST = 37,
  TORCH = 38, BOOKSHELF = 50, OAK_FENCE = 52, OAK_DOOR = 53, BED_BLOCK = 54,
  FARMLAND = 55, WHEAT_CROP = 56, CARROT_CROP = 57, POTATO_CROP = 58,
  WATER = 63, LAVA = 64, GRINDSTONE = 107, BREWING_STAND = 112, SMITHING_TABLE = 143,
  DIRT_PATH = 170, BELL = 171, COMPOSTER = 172, BARREL = 173, LECTERN = 174,
  BLAST_FURNACE = 175, SMOKER = 177, FLETCHING_TABLE = 179, HAY_BALE = 180;

// door state: bit0 upper half, bit1 open, bits2–3 FACING; FACING_DIR order
// 0:+Z 1:−X 2:−Z 3:+X (registry/blocks.js). bed state: bits0–1 facing
// (foot→head), bit2 head. farmland: bit3 wet. crops: bits0–2 stage.
const FACING_OF = d => (d[0] === 0 ? (d[1] > 0 ? 0 : 2) : (d[0] > 0 ? 3 : 1));

const REGION = 32;
// UPDATE-village-density §2.1 — anchor sub-box. DEVIATES from §2.1's literal
// `Vx*32 + 4 + rngInt(rng, 24)`. REQUIRED COMPANION to the raised spawn rate
// below; the arithmetic, in full:
//   min separation between anchors in ADJACENT regions = REGION − SPREAD + 1
//     old: 32 − 24 + 1 =  9 chunks = 144 blocks
//     new: 32 − 20 + 1 = 13 chunks = 208 blocks
//   max village diameter = 2 × (within() reach 70 + butcher-pen pad 5) = 150 blocks
// 144 < 150, i.e. the SHIPPED constants already admitted an overlap; §2.1's own
// comment ("≥4-chunk margin → ≥8-chunk gap") is off by one against §2.2's ±72
// reach before any change of mine. At the old 0.103 villages/region an adjacent
// pair occurred ~1% of the time so it never bit; at the new rate adjacent pairs
// are ~40× likelier, and two overlapping villages interleave their phase-sorted
// op lists into duplicate bell plazas and cross-claimed beds. 208 > 150 makes it
// impossible. INVARIANT: OFF + SPREAD <= REGION (6 + 20 = 26 <= 32) — this is what
// keeps every anchor inside its own region, which is what makes the floor-based
// region scan in stampVillages sound. Cost: anchor jitter 384 → 320 blocks.
// The ±5-chunk reach window in stampVillages is UNCHANGED and still correct — see
// the arithmetic there; reach is a function of within()/centre only, not of these.
const ANCHOR_OFF = 6, ANCHOR_SPREAD = 20;
// §2.1 DEVIATION — biome gate widened from ids 3/6/7/8 to include FOREST(4) and
// BIRCH_FOREST(5). Measured gate rejections over 3318 rolled regions: ocean 1328,
// forest 478, beach 385, birch_forest 143 — forest+birch alone were 621 rejections
// against 876 passes, i.e. +71% density for one line. No other code change needed:
// paletteFor falls through to the plains palette for any unlisted biome, and tree
// felling is already sized for full spruce canopies (pathCell clears to
// max(y+4, ty+13), stampBuilding to gradeY + wallH + 12). SNOWY_TUNDRA stays out —
// §5 excludes it explicitly and it measured only 73/3318 (a 2% density gain).
const VILLAGE_BIOMES = new Set([BIOMES.PLAINS, BIOMES.DESERT, BIOMES.SAVANNA,
                                BIOMES.TAIGA, BIOMES.FOREST, BIOMES.BIRCH_FOREST]);
// §2.1 DEVIATION — spawn roll 0.40 → 0.55, and up to ANCHOR_TRIES anchor
// candidates instead of exactly one. §2.1 claims "≈1 village per ~1000×1000
// blocks", but its ~50% land estimate is wrong: the gate passed only 25.4% of
// rolled regions, so shipped density was 0.103/region = 1 per ~1594² blocks.
// 74.6% of rolled regions died on a SINGLE anchor sample even though the 320×320
// -block sub-box usually contains legal terrain, so retrying the gate is a
// better-quality lever than inflating the roll. Precedent in-tree: endCity.js
// draws up to TRIES columns off the same region stream for the same reason.
// Deliberately moderate (owner asked for "a little more often", not a suburb).
const VILLAGE_ROLL = 0.55, ANCHOR_TRIES = 3;

// §5 — per-biome palette. Desert is all sandstone (incl. paths); savanna keeps
// oak walls with spruce roofs (two-tone); taiga spruce + cobblestone roofs.
function paletteFor(biome) {
  if (biome === BIOMES.DESERT) return { floor: SANDSTONE, wall: SANDSTONE, roof: SANDSTONE, log: SANDSTONE, path: SANDSTONE };
  if (biome === BIOMES.TAIGA) return { floor: SPRUCE_PLANKS, wall: SPRUCE_PLANKS, roof: COBBLE, log: SPRUCE_LOG, path: DIRT_PATH };
  if (biome === BIOMES.SAVANNA) return { floor: OAK_PLANKS, wall: OAK_PLANKS, roof: SPRUCE_PLANKS, log: OAK_LOG, path: DIRT_PATH };
  return { floor: OAK_PLANKS, wall: OAK_PLANKS, roof: OAK_PLANKS, log: OAK_LOG, path: DIRT_PATH };   // plains
}

// ---- candidate grid (§2.1), memoized per region ----
const regionCache = new Map();
function villageForRegion(ctx, Vx, Vz) {
  // keyed by worldSeed too: the caches are module-level, and while production
  // spawns a fresh worker per world, anything that reuses the module across
  // worlds (tests, future same-thread gen) must never see a stale village.
  const key = ctx.worldSeed + '|' + Vx + ',' + Vz;
  if (regionCache.has(key)) return regionCache.get(key);
  const rng = splitmix32(chunkSeed(ctx.seeds.village, Vx, Vz));
  const acx = Vx * REGION + ANCHOR_OFF + rngInt(rng, ANCHOR_SPREAD);   // draw order is load-bearing:
  const acz = Vz * REGION + ANCHOR_OFF + rngInt(rng, ANCHOR_SPREAD);    // two int draws, THEN the roll
  let v = null;
  if (rng() < VILLAGE_ROLL) {
    // Every retry draw is taken strictly AFTER the roll, and always as a PAIR of
    // rngInt(rng, ANCHOR_SPREAD) — so the pinned "two int draws, THEN the roll"
    // prefix above is byte-identical to §2.1 and the stream stays a pure function
    // of the region seed. The region stream feeds nothing outside this function.
    v = anchorAt(ctx, acx, acz);
    for (let t = 1; t < ANCHOR_TRIES && !v; t++) {
      const bx = Vx * REGION + ANCHOR_OFF + rngInt(rng, ANCHOR_SPREAD);
      const bz = Vz * REGION + ANCHOR_OFF + rngInt(rng, ANCHOR_SPREAD);
      v = anchorAt(ctx, bx, bz);
    }
  }
  regionCache.set(key, v);
  return v;
}

// §2.1 gate for one anchor candidate: village biome + above sea level. Pure.
function anchorAt(ctx, acx, acz) {
  const center = { x: acx * 16 + 8, z: acz * 16 + 8 };
  const biome = ctx.biomeAt(center.x, center.z);
  if (!VILLAGE_BIOMES.has(biome) || ctx.heightAt(center.x, center.z) < 64) return null;
  return { acx, acz, center, biome };
}

// ---- layout (§3), LRU-8 cached by anchor ----
const layoutCache = new Map();
function layoutFor(ctx, v) {
  const key = ctx.worldSeed + '|' + v.acx + ',' + v.acz;
  const hit = layoutCache.get(key);
  if (hit) return hit;
  const L = buildLayout(ctx, v);
  layoutCache.set(key, L);
  if (layoutCache.size > 8) layoutCache.delete(layoutCache.keys().next().value);
  return L;
}

// ------------------------------------------------------------------ templates
// §4.3 pool, parametric: rect footprint (optional L-cut), procedural ring walls
// with corner logs + auto windows at wall-face midpoints, stepped pyramid roof.
// Fixtures sit ON the floor (y+1). Drawn at rot 0 (door on the −Z edge); the
// whole template rotates door-toward-path at layout time. All ≤ 9×9 (§4.1).
//   fix kinds: bed[dx,dz,hx,hz] | station(type,id) | chest | shelfK (bookshelf
//   column ×2) | barrel | torch | hay
const TEMPLATES = {
  small_house: {
    w: 5, d: 5, wallH: 3, door: [2, 0], floor: 'wood',
    fix: [{ k: 'bed', at: [3, 3], head: [-1, 0] }, { k: 'torch', at: [1, 1] }],
  },
  medium_house: {
    w: 7, d: 7, wallH: 3, door: [3, 0], floor: 'wood', cut: [5, 0, 6, 1],   // L: notch the +X/−Z corner
    fix: [{ k: 'bed', at: [1, 4], head: [1, 0] }, { k: 'bed', at: [1, 5], head: [1, 0] },
          { k: 'torch', at: [5, 5] }, { k: 'torch', at: [1, 2] }, { k: 'maybe_composter', at: [5, 3] }],
  },
  library: {
    w: 7, d: 7, wallH: 3, door: [3, 0], floor: 'wood',
    fix: [{ k: 'shelfK', at: [1, 3] }, { k: 'shelfK', at: [1, 4] }, { k: 'shelfK', at: [1, 5] },
          { k: 'station', type: 'lectern', id: LECTERN, at: [3, 3] },
          { k: 'bed', at: [5, 4], head: [0, 1] }, { k: 'chest', at: [5, 2] },
          { k: 'torch', at: [5, 1] }, { k: 'torch', at: [2, 5] }],
  },
  church: {
    w: 7, d: 9, wallH: 4, door: [3, 0], floor: 'cobble', tower: [2, 5, 4, 8, 3],   // tower box + extra height
    fix: [{ k: 'station', type: 'brewing_stand', id: BREWING_STAND, at: [3, 6] },
          { k: 'bed', at: [1, 7], head: [1, 0] },
          { k: 'torch', at: [1, 1] }, { k: 'torch', at: [5, 1] }, { k: 'torch', at: [5, 7] }],
  },
  smithy: {
    w: 7, d: 7, wallH: 3, door: [3, 0], floor: 'cobble',
    fix: [{ k: 'station', type: 'blast_furnace', id: BLAST_FURNACE, at: [1, 2] },
          { k: 'station', type: 'smithing_table', id: SMITHING_TABLE, at: [5, 2] },
          { k: 'station', type: 'grindstone', id: GRINDSTONE, at: [3, 4] },
          { k: 'forge', at: [5, 4] }, { k: 'chest', at: [4, 5] },
          { k: 'torch', at: [1, 5] }, { k: 'torch', at: [5, 1] }],
  },
  butcher: {
    w: 7, d: 7, wallH: 3, door: [3, 0], floor: 'wood',
    fix: [{ k: 'station', type: 'smoker', id: SMOKER, at: [1, 2] }, { k: 'chest', at: [3, 2] },
          { k: 'bed', at: [5, 4], head: [0, 1] }, { k: 'hay', at: [1, 5] },
          { k: 'torch', at: [5, 1] }, { k: 'torch', at: [1, 4] }],
    pen: true,                                        // small side pen with a herd record
  },
  fletcher: {
    w: 5, d: 6, wallH: 3, door: [2, 0], floor: 'wood',
    fix: [{ k: 'station', type: 'fletching_table', id: FLETCHING_TABLE, at: [1, 1] },
          { k: 'chest', at: [3, 1] }, { k: 'barrel', at: [1, 3] }, { k: 'barrel', at: [3, 3] },
          { k: 'bed', at: [3, 4], head: [-1, 0] }, { k: 'torch', at: [1, 4] }],
  },
  // open-air plots (no walls/roof); handled by dedicated builders below
  farm: { w: 7, d: 9, plot: 'farm' },
  animal_pen: { w: 6, d: 6, plot: 'pen' },
};

// §3.1 weighted pool: [name, weight, max]. farm counted (guarantee handles ≥1).
const POOL = [
  ['small_house', 5, 99], ['medium_house', 3, 3], ['farm', 4, 99],
  ['library', 1, 1], ['church', 1, 1], ['smithy', 1, 1],
  ['butcher', 1, 1], ['fletcher', 1, 1], ['animal_pen', 2, 2],
];

// rot k: template (tx,tz) → world offsets; door outward normal per k.
const rotXZ = (k, tx, tz, w, d) =>
  k === 0 ? [tx, tz] : k === 1 ? [d - 1 - tz, tx] : k === 2 ? [w - 1 - tx, d - 1 - tz] : [tz, w - 1 - tx];
const rotDims = (k, w, d) => (k & 1) ? [d, w] : [w, d];
const rotVec = (k, x, z) => k === 0 ? [x, z] : k === 1 ? [-z, x] : k === 2 ? [-x, -z] : [z, -x];
const DOOR_OUT = k => rotVec(k, 0, -1);            // rot0 door faces −Z

// ------------------------------------------------------------------ layout
function buildLayout(ctx, v) {
  const rng = splitmix32((chunkSeed(ctx.seeds.village, v.acx, v.acz) ^ 0x5eed) >>> 0);
  const pal = paletteFor(v.biome);
  const cx = v.center.x, cz = v.center.z;
  const centerY = ctx.heightAt(cx, cz);
  const ops = [];
  const meta = {
    anchor: [v.acx, v.acz], center: { x: cx, z: cz }, biome: v.biome,
    bounds: { minX: cx - 72, minZ: cz - 72, maxX: cx + 72, maxZ: cz + 72 },
    bellPos: [cx, centerY + 2, cz],
    beds: [], stations: [], indoorAnchors: [],
    golem: { alive: false, respawnTimer: 0 },
  };
  const spawns = [];
  const placed = [];   // AABBs of accepted pieces for overlap rejection

  const clear = (x, y, z) => ops.push({ phase: 1, x, y, z, id: AIR });
  const found = (x, y, z, id) => ops.push({ phase: 2, x, y, z, id });
  const path = (x, y, z, id = pal.path) => ops.push({ phase: 3, x, y, z, id });
  const piece = (x, y, z, id, state) => ops.push({ phase: 4, x, y, z, id, state });
  const lamp = (x, y, z, id) => ops.push({ phase: 5, x, y, z, id });
  const within = (x, z) => Math.abs(x - cx) <= 70 && Math.abs(z - cz) <= 70;

  // Level ground for a path/plaza cell: surface block at y, dirt filled down to
  // the local terrain so paths hug slopes instead of floating; head-room cleared.
  const pathCell = (x, y, z) => {
    path(x, y, z);
    const ty = ctx.heightAt(x, z);
    // §2.5 — ALWAYS emit at least the one block under the road. `heightAt >= y`
    // used to emit nothing (trusting untouched natural ground), but phase-1 CLEAR
    // ops from a neighbouring building platform run first and delete that ground,
    // leaving road cells floating over a hole.
    for (let fy = y - 1; fy >= Math.min(ty, y - 1) && fy > 1 && y - fy <= 4; fy--) found(x, fy, z, DIRT);
    // clear tall RELATIVE TO THE COLUMN'S OWN TERRAIN: a tree roots at ty (which
    // can sit above a downhill-clamped path), and spruce reaches ~12 above its
    // ground — clearing from the path y alone left floating treetops on slopes.
    const top = Math.max(y + 4, ty + 13);
    for (let yy = y + 1; yy <= top; yy++) clear(x, yy, z);
  };

  // §2.4 step 3 — the pre-existing surface is water: lay FLOOR material instead of
  // PATH (causeway/pier stub) with a pier of the same material down to the bed.
  const wetCell = (x, y, z) => {
    path(x, y, z, pal.floor);
    const ty = ctx.heightAt(x, z);
    for (let fy = y - 1; fy >= Math.min(ty, y - 1) && fy > 1 && y - fy <= 4; fy--) found(x, fy, z, pal.floor);
    for (let yy = y + 1; yy <= y + 4; yy++) clear(x, yy, z);
  };

  // --- WELL (fixed) 4×4 at center offset (−6, −6), own leveled base ---
  {
    const wx = cx - 6, wz = cz - 6;
    const yb = ctx.heightAt(wx + 1, wz + 1);
    for (let dx = 0; dx < 4; dx++) for (let dz = 0; dz < 4; dz++) {
      const x = wx + dx, z = wz + dz;
      for (let dy = 0; dy <= 13; dy++) clear(x, yb + dy, z);   // fells trees over the well
      const ty = ctx.heightAt(x, z);
      for (let fy = yb - 1; fy > ty - 2 && fy > 1 && yb - fy <= 6; fy--) found(x, fy, z, pal.floor);
      const rim = dx === 0 || dx === 3 || dz === 0 || dz === 3;
      piece(x, yb, z, rim ? pal.wall : WATER);
      if (rim) piece(x, yb + 1, z, pal.wall);
    }
    for (const [dx, dz] of [[0, 0], [3, 3]]) { piece(wx + dx, yb + 2, wz + dz, OAK_FENCE); piece(wx + dx, yb + 3, wz + dz, TORCH); }
    placed.push({ minX: wx - 1, minZ: wz - 1, maxX: wx + 4, maxZ: wz + 4 });
  }

  // --- MEETING POINT (fixed) 7×7 bell plaza with log benches + corner lamps ---
  {
    const mx = cx - 3, mz = cz - 3, yb = centerY;
    for (let dx = 0; dx < 7; dx++) for (let dz = 0; dz < 7; dz++) {
      const x = mx + dx, z = mz + dz;
      for (let dy = 1; dy <= 13; dy++) clear(x, yb + dy, z);   // fells trees over the plaza
      const ty = ctx.heightAt(x, z);
      for (let fy = yb - 1; fy > ty - 2 && fy > 1 && yb - fy <= 6; fy--) found(x, fy, z, DIRT);
      path(x, yb, z);
    }
    for (const [bx, bz] of [[2, 2], [4, 2], [2, 4], [4, 4]]) piece(mx + bx, yb + 1, mz + bz, pal.log);   // benches
    piece(cx, yb + 1, cz, OAK_FENCE);
    piece(cx, yb + 2, cz, BELL);            // bellPos = [cx, centerY+2, cz]
    for (const [dx, dz] of [[0, 0], [6, 0], [0, 6], [6, 6]]) { lamp(mx + dx, yb + 1, mz + dz, OAK_FENCE); lamp(mx + dx, yb + 2, mz + dz, OAK_FENCE); lamp(mx + dx, yb + 3, mz + dz, TORCH); }
    placed.push({ minX: mx - 1, minZ: mz - 1, maxX: mx + 7, maxZ: mz + 7 });
    // §2.7 — the plaza anchor / villager trio must stand on FREE plaza paving:
    // (cx,cz) is the bell's fence post and (cx±1,cz±1) are the log benches, so the
    // records go one row out at dz = +2, which carries nothing.
    meta.indoorAnchors.push([cx, centerY + 1, cz + 2]);
    for (let i = 0; i < 3; i++) spawns.push({ type: 'villager', x: cx + 0.5 + (i - 1), y: centerY + 1, z: cz + 2.5 });
  }

  // --- PATH ARMS (§3.2): 2–4 arms, 40–72 steps, ±1 smoothing, lamps every 12 ---
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const lampSpots = [];                      // [x, pathY, z], emitted after buildings
  // §3.2 step 3 — road columns already emitted by the arm walk. Arms are walked
  // BEFORE any slot is proposed and the AABB test only knows about accepted
  // pieces, so without this a house lands on top of a finished road.
  const pathCols = new Set();
  const roadKey = (x, z) => x * 100000 + z;   // village cells span ≤ 145 blocks → collision-free
  const nArms = 2 + rngInt(rng, 3);
  const usedDirs = [];
  const arms = [];
  for (let a = 0; a < nArms; a++) {
    let di = rngInt(rng, 4);
    for (let g = 0; g < 4 && usedDirs.includes(di); g++) di = (di + 1) % 4;
    if (usedDirs.includes(di)) break;
    usedDirs.push(di);
    let [hx, hz] = DIRS[di];
    let px = cx + hx * 4, pz = cz + hz * 4, y = centerY;
    const len = 40 + rngInt(rng, 33);
    let sinceTurn = 0, turnAt = 6 + rngInt(rng, 5), wetRun = 0;
    const armCells = [];
    for (let s = 0; s < len; s++) {
      px += hx; pz += hz;
      if (!within(px, pz)) { di = (di + 2) % 4; [hx, hz] = DIRS[di]; px += 2 * hx; pz += 2 * hz; }   // reflect at border
      const ty = ctx.heightAt(px, pz);
      if (ty <= 63) {                           // §3.2: >4 water steps → terminate
        if (++wetRun > 4) break;
        y = Math.max(y - 1, Math.min(y + 1, 64));   // ±1 smoothing toward sea level
        wetCell(px, y, pz);
        pathCols.add(roadKey(px, pz));
        const wlx = px - hz, wlz = pz + hx;
        if (within(wlx, wlz)) { wetCell(wlx, y, wlz); pathCols.add(roadKey(wlx, wlz)); }
        armCells.push([px, y, pz, hx, hz]);
        continue;
      }
      wetRun = 0;
      y = Math.max(y - 1, Math.min(y + 1, ty));
      pathCell(px, y, pz);
      pathCols.add(roadKey(px, pz));
      const lx = px - hz, lz = pz + hx;         // width-2, left of heading
      if (within(lx, lz)) { pathCell(lx, y, lz); pathCols.add(roadKey(lx, lz)); }
      armCells.push([px, y, pz, hx, hz]);
      if (s > 0 && s % 12 === 0) lampSpots.push([px + hz, y, pz - hx]);   // deferred (see below)
      if (++sinceTurn >= turnAt && rng() < 0.35) { const rot = rng() < 0.5 ? 1 : 3; di = (di + rot) % 4; [hx, hz] = DIRS[di]; sinceTurn = 0; turnAt = 6 + rngInt(rng, 5); }
    }
    arms.push(armCells);
  }

  // --- BUILDINGS along arms (§3.1 pool + §3.2 step 3) ---
  const sizeRoll = rng();
  const targetBuildings = sizeRoll < 0.6 ? 6 + rngInt(rng, 5) : 11 + rngInt(rng, 10);
  const drawn = {};                                     // name → count (maxima)
  const drawTemplate = () => {
    let total = 0;
    for (const [n, w, mx] of POOL) if ((drawn[n] ?? 0) < mx) total += w;
    if (total === 0) return 'small_house';
    let roll = rng() * total;
    for (const [n, w, mx] of POOL) {
      if ((drawn[n] ?? 0) >= mx) continue;
      roll -= w;
      if (roll < 0) return n;
    }
    return 'small_house';
  };
  const overlaps = aabb => placed.some(p => aabb.minX <= p.maxX && aabb.maxX >= p.minX && aabb.minZ <= p.maxZ && aabb.maxZ >= p.minZ);

  const emit = { clear, found, path, piece, lamp, pathCell };
  let built = 0;
  const accepted = [];                                  // for the ≥2-house / ≥1-farm guarantee

  // one slot proposal (redraw ≤2 templates, both sides) → true if a building landed
  const trySlot = (px, py, pz, hx, hz, baseSide, forceName = null) => {
    let name = null, t = null, rot = 0, bx0 = 0, bz0 = 0, W = 0, D = 0, gradeY = 0;
    let okSlot = false, sx = 0, sz = 0;
    for (let attempt = 0; attempt < 4 && !okSlot; attempt++) {
      const side = (attempt === 1 || attempt === 3) ? -baseSide : baseSide;
      sx = -hz * side; sz = hx * side;
      name = forceName ?? drawTemplate(); t = TEMPLATES[name];
      rot = 0;
      for (let k = 0; k < 4; k++) { const o = DOOR_OUT(k); if (o[0] === -sx && o[1] === -sz) { rot = k; break; } }
      [W, D] = rotDims(rot, t.w, t.d);
      // §3.2 step 3 — the setback runs along the DOOR NORMAL, and DOOR_OUT/rotDims
      // put the template's depth axis on that normal for all four rotations, so the
      // half-extent is always t.d (using the world-X extent made rot 0/2 sit 1 closer).
      const off = 3 + Math.floor(t.d / 2);
      const ox = px + sx * off, oz = pz + sz * off;
      bx0 = ox - Math.floor(W / 2); bz0 = oz - Math.floor(D / 2);
      let hmin = 999, hmax = -999, bad = false;
      const hs = [];
      for (let dx = 0; dx < W; dx++) for (let dz = 0; dz < D; dz++) {
        const h = ctx.heightAt(bx0 + dx, bz0 + dz);
        hs.push(h);
        if (h < hmin) hmin = h; if (h > hmax) hmax = h;
        if (!within(bx0 + dx, bz0 + dz) || h <= 63) bad = true;
        if (pathCols.has(roadKey(bx0 + dx, bz0 + dz))) bad = true;   // §3.2 step 3 — never build on a road
      }
      const penPad = t.pen ? 6 : 0;
      const aabb = { minX: bx0 - 2, minZ: bz0 - 2, maxX: bx0 + W + 1 + penPad, maxZ: bz0 + D + 1 };
      if (bad || hmax - hmin > 3 || overlaps(aabb)) continue;
      hs.sort((a, b) => a - b);
      const median = hs[Math.floor(hs.length / 2)];
      gradeY = Math.max(median - 2, Math.min(median + 2, py));
      placed.push(aabb);
      okSlot = true;
    }
    if (!okSlot) return false;
    drawn[name] = (drawn[name] ?? 0) + 1;
    stampBuilding(ctx, name, t, rot, bx0, gradeY, bz0, pal, emit, rng, meta, spawns, [px, py, pz], v);
    accepted.push(name);
    built++;
    return true;
  };

  for (const arm of arms) {
    // slots skip the first 10 steps (clears the well/plaza core) and space at
    // 10–14 so same-side neighbours (footprint+inflation ≤ 13 along the arm)
    // rarely collide — the spec's 7+rngInt(6) cadence rejected ~88% on overlap.
    let sinceSlot = -10, slotAt = 10 + rngInt(rng, 5);
    for (const [px, py, pz, hx, hz] of arm) {
      if (built >= targetBuildings) break;
      if (++sinceSlot < slotAt) continue;
      sinceSlot = 0; slotAt = 10 + rngInt(rng, 5);
      trySlot(px, py, pz, hx, hz, rng() < 0.5 ? 1 : -1);
    }
  }
  // BACKFILL: if under target, sweep the arms again at a finer stride — a slot
  // that failed once may succeed now on its other side or with a smaller draw.
  if (built < targetBuildings) {
    for (const arm of arms) {
      for (let ai = 10; ai < arm.length && built < targetBuildings; ai += 4) {
        const [px, py, pz, hx, hz] = arm[ai];
        trySlot(px, py, pz, hx, hz, rng() < 0.5 ? 1 : -1);
      }
    }
  }
  // §3.1 guarantees: ≥2 small_house, ≥1 farm — best-effort extra slots at arm ends.
  const need = [];
  if (accepted.filter(n => n === 'small_house').length < 2) need.push('small_house');
  if (!accepted.includes('farm')) need.push('farm');
  for (const name of need) {
    let done = false;
    for (const arm of arms) {
      if (done || arm.length < 6) continue;
      for (let ai = arm.length - 3; ai >= 2 && !done; ai -= 4) {
        const [px, py, pz, hx, hz] = arm[ai];
        if (trySlot(px, py, pz, hx, hz, 1, name) || trySlot(px, py, pz, hx, hz, -1, name)) done = true;
      }
    }
  }

  // lamp posts (§3.2 step 4) — emitted AFTER buildings so none lands inside a
  // building's inflated AABB (which covers every door approach).
  for (const [ox, oy, oz] of lampSpots) {
    if (placed.some(p => ox >= p.minX && ox <= p.maxX && oz >= p.minZ && oz <= p.maxZ)) continue;
    // §2.5 — the lamp sits one cell OFF the road, so its column keeps its own
    // (often lower) terrain: give the post a base or the fence hangs in the air.
    const lty = ctx.heightAt(ox, oz);
    for (let fy = oy; fy >= Math.min(lty, oy) && fy > 1 && oy - fy <= 4; fy--) found(ox, fy, oz, DIRT);
    lamp(ox, oy + 1, oz, OAK_FENCE); lamp(ox, oy + 2, oz, OAK_FENCE); lamp(ox, oy + 3, oz, TORCH);
  }

  ops.sort((a, b) => a.phase - b.phase);   // stable within phase (insertion order preserved)
  return { ops, meta, spawns };
}

// ------------------------------------------------------------------ builders

/**
 * Stamp one building (or open plot). Levels a platform at gradeY: clears the
 * hillside above, fills a pal.floor foundation DOWN to terrain on every column
 * (nothing floats, nothing clips), then raises walls/roof or the plot content.
 */
function stampBuilding(ctx, name, t, rot, bx0, gradeY, bz0, pal, emit, rng, meta, spawns, doorFrom, v) {
  const { clear, found, piece, pathCell } = emit;
  const [W, D] = rotDims(rot, t.w, t.d);
  const inCut = (tx, tz) => t.cut && tx >= t.cut[0] && tz >= t.cut[1] && tx <= t.cut[2] && tz <= t.cut[3];
  const mask = [];                          // world-space footprint mask [dx][dz]
  for (let tx = 0; tx < t.w; tx++) for (let tz = 0; tz < t.d; tz++) {
    if (inCut(tx, tz)) continue;
    const [rx, rz] = rotXZ(rot, tx, tz, t.w, t.d);
    (mask[rx] ??= [])[rz] = true;
  }
  const has = (dx, dz) => dx >= 0 && dz >= 0 && dx < W && dz < D && !!mask[dx]?.[dz];

  const wallH = t.wallH ?? 0;
  const clearTop = gradeY + (wallH ? wallH + 12 : 10);   // clears above roof/tower + fells full trees
  // platform: clear above grade (margin +1 ring), foundation fill down per column
  for (let dx = -1; dx <= W; dx++) for (let dz = -1; dz <= D; dz++) {
    const x = bx0 + dx, z = bz0 + dz;
    const inside = has(dx, dz);
    if (!inside && !(dx >= -1 && dz >= -1)) continue;
    for (let y = gradeY + 1; y <= clearTop; y++) clear(x, y, z);
    if (!inside) continue;
    const ty = ctx.heightAt(x, z);
    for (let fy = gradeY - 1; fy > ty - 2 && fy > 1 && gradeY - fy <= 8; fy--) found(x, fy, z, pal.floor);
  }

  // open-air plots
  if (t.plot === 'farm') return stampFarm(ctx, rot, bx0, gradeY, bz0, W, D, pal, emit, rng, meta, spawns, v);
  if (t.plot === 'pen') return stampPen(rot, bx0, gradeY, bz0, W, D, pal, emit, rng, spawns);

  const floorId = t.floor === 'cobble' ? COBBLE : pal.floor;
  const isEdge = (dx, dz) => !has(dx - 1, dz) || !has(dx + 1, dz) || !has(dx, dz - 1) || !has(dx, dz + 1);
  const isCorner = (dx, dz) => (!has(dx - 1, dz) || !has(dx + 1, dz)) && (!has(dx, dz - 1) || !has(dx, dz + 1));
  const [doorDx, doorDz] = rotXZ(rot, t.door[0], t.door[1], t.w, t.d);
  const out = DOOR_OUT(rot);
  const doorFacing = FACING_OF(out);

  // floor plane + walls with corner logs; windows at wall-face midpoints (y+2)
  for (let dx = 0; dx < W; dx++) for (let dz = 0; dz < D; dz++) {
    if (!has(dx, dz)) continue;
    const x = bx0 + dx, z = bz0 + dz;
    piece(x, gradeY, z, floorId);
    if (!isEdge(dx, dz)) continue;
    const corner = isCorner(dx, dz);
    const isDoorCol = dx === doorDx && dz === doorDz;
    for (let wy = 1; wy <= wallH; wy++) {
      if (isDoorCol && wy <= 2) continue;                       // door opening
      const mid = !corner && wy === 2 && (dx === Math.floor(W / 2) || dz === Math.floor(D / 2));
      piece(x, gradeY + wy, z, corner ? pal.log : (mid ? GLASS : pal.wall));
    }
  }
  // door (correct lower/upper halves + facing toward the path)
  piece(bx0 + doorDx, gradeY + 1, bz0 + doorDz, OAK_DOOR, doorFacing << 2);
  piece(bx0 + doorDx, gradeY + 2, bz0 + doorDz, OAK_DOOR, (doorFacing << 2) | 1);
  // door approach: path stub from the door front to the road (grade-following)
  {
    let ax = bx0 + doorDx + out[0], az = bz0 + doorDz + out[1];
    for (let s = 0; s < 12; s++) {
      if (Math.abs(ax - doorFrom[0]) + Math.abs(az - doorFrom[2]) <= 0) break;
      pathCell(ax, gradeY, az);                        // flush with the door threshold
      const stepX = Math.sign(doorFrom[0] - ax), stepZ = Math.sign(doorFrom[2] - az);
      if (stepX !== 0) ax += stepX; else if (stepZ !== 0) az += stepZ; else break;
    }
  }

  // stepped pyramid roof over the footprint mask (UPDATE §6: not a flat slab)
  let ring = [];
  for (let dx = 0; dx < W; dx++) for (let dz = 0; dz < D; dz++) if (has(dx, dz)) ring.push([dx, dz]);
  let level = 0;
  while (ring.length && level < 4) {
    for (const [dx, dz] of ring) piece(bx0 + dx, gradeY + wallH + 1 + level, bz0 + dz, pal.roof);
    const set = new Set(ring.map(([a, b]) => a * 32 + b));
    ring = ring.filter(([dx, dz]) =>
      set.has((dx - 1) * 32 + dz) && set.has((dx + 1) * 32 + dz) && set.has(dx * 32 + dz - 1) && set.has(dx * 32 + dz + 1));
    level++;
  }
  // church tower: raise the tower box above the main roof with its own cap
  if (t.tower) {
    const [tx0, tz0, tx1, tz1, extra] = t.tower;
    for (let tx = tx0; tx <= tx1; tx++) for (let tz = tz0; tz <= tz1; tz++) {
      const [rx, rz] = rotXZ(rot, tx, tz, t.w, t.d);
      const x = bx0 + rx, z = bz0 + rz;
      const edge = tx === tx0 || tx === tx1 || tz === tz0 || tz === tz1;
      for (let ey = 1; ey <= extra; ey++) {
        clear(x, gradeY + wallH + 1 + ey, z);
        if (edge) piece(x, gradeY + wallH + 1 + ey, z, ey === extra ? pal.roof : pal.wall);
        else if (ey === extra) piece(x, gradeY + wallH + 1 + ey, z, pal.roof);
      }
    }
    const [rx, rz] = rotXZ(rot, (tx0 + tx1) >> 1, (tz0 + tz1) >> 1, t.w, t.d);
    piece(bx0 + rx, gradeY + wallH + 1 + t.tower[4] + 1, bz0 + rz, TORCH);   // steeple light
  }

  // fixtures at floor+1. `used` collects every occupied interior cell so the §2.7
  // anchor / villager spawn below never lands inside one (the 7×7 library's
  // geometric centre IS its lectern, and stations are full collidable cubes).
  const used = new Set();
  for (const f of t.fix ?? []) {
    const [rx, rz] = rotXZ(rot, f.at[0], f.at[1], t.w, t.d);
    const x = bx0 + rx, y = gradeY + 1, z = bz0 + rz;
    used.add(rx * 32 + rz);
    if (f.k === 'bed') {
      const [hdx, hdz] = rotVec(rot, f.head[0], f.head[1]);
      const facing = FACING_OF([hdx, hdz]);
      piece(x, y, z, BED_BLOCK, facing);                       // foot
      piece(x + hdx, y, z + hdz, BED_BLOCK, facing | 4);       // head
      used.add((rx + hdx) * 32 + (rz + hdz));
      meta.beds.push({ pos: [x, y, z], claimedBy: null });
    } else if (f.k === 'station') {
      piece(x, y, z, f.id);
      meta.stations.push({ pos: [x, y, z], type: f.type, claimedBy: null });
    } else if (f.k === 'maybe_composter') {
      if (rng() < 0.4) { piece(x, y, z, COMPOSTER); meta.stations.push({ pos: [x, y, z], type: 'composter', claimedBy: null }); }
    } else if (f.k === 'chest') piece(x, y, z, CHEST);
    else if (f.k === 'barrel') piece(x, y, z, BARREL);
    else if (f.k === 'hay') piece(x, y, z, HAY_BALE);
    else if (f.k === 'torch') piece(x, y, z, TORCH);
    else if (f.k === 'shelfK') { piece(x, y, z, BOOKSHELF); piece(x, y + 1, z, BOOKSHELF); }
    else if (f.k === 'forge') {                                // smithy: walled lava flame
      piece(x, gradeY, z, LAVA);
      for (const [ddx, ddz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const wx = x + ddx, wz = z + ddz;
        piece(wx, y, wz, COBBLE);
        used.add((rx + ddx) * 32 + (rz + ddz));
      }
    }
  }
  // §2.7 anchor + §8.6 villager record: first FREE non-edge interior cell, scanned
  // from the geometric centre outward in the fixed dx→dz order (falls back to the
  // centre when the template leaves nothing free).
  let ax = Math.floor(W / 2), az = Math.floor(D / 2);
  if (!has(ax, az) || isEdge(ax, az) || used.has(ax * 32 + az)) {
    for (let dx = 0; dx < W; dx++) {
      let hit = false;
      for (let dz = 0; dz < D; dz++) {
        if (has(dx, dz) && !isEdge(dx, dz) && !used.has(dx * 32 + dz)) { ax = dx; az = dz; hit = true; break; }
      }
      if (hit) break;
    }
  }
  meta.indoorAnchors.push([bx0 + ax, gradeY + 1, bz0 + az]);
  spawns.push({ type: 'villager', x: bx0 + ax + 0.5, y: gradeY + 1, z: bz0 + az + 0.5 });
  if (t.pen) {                                                 // butcher's side pen (inside the reserved AABB)
    const px0 = bx0 + W + 1, pz0 = bz0 + 1;
    for (let dx = 0; dx < 4; dx++) for (let dz = 0; dz < 4; dz++) {
      const x = px0 + dx, z = pz0 + dz;
      for (let y = gradeY + 1; y <= gradeY + 4; y++) clear(x, y, z);
      const ty = ctx.heightAt(x, z);
      for (let fy = gradeY - 1; fy > ty - 2 && fy > 1 && gradeY - fy <= 6; fy--) found(x, fy, z, DIRT);
      piece(x, gradeY, z, GRASS);
      const edge = dx === 0 || dx === 3 || dz === 0 || dz === 3;
      if (edge && !(dx === 0 && dz === 1)) piece(x, gradeY + 1, z, OAK_FENCE);
    }
    spawns.push({ type: rng() < 0.5 ? 'cow' : 'pig', x: px0 + 1.5, y: gradeY + 1, z: pz0 + 1.5 });
  }
}

// §4.3 farm — at-grade bordered plot: fence ring, tilled crops in stages, water
// channel one block INTO the soil, composter + chest at the gate, corner torches.
function stampFarm(ctx, rot, bx0, gradeY, bz0, W, D, pal, emit, rng, meta, spawns, v) {
  const { piece } = emit;
  const midX = Math.floor(W / 2);
  for (let dx = 0; dx < W; dx++) for (let dz = 0; dz < D; dz++) {
    const x = bx0 + dx, z = bz0 + dz;
    const edge = dx === 0 || dx === W - 1 || dz === 0 || dz === D - 1;
    if (edge) {
      piece(x, gradeY, z, GRASS);
      const gate = dz === D - 1 && dx === midX;                // walk-in gap on the door side
      if (!gate) piece(x, gradeY + 1, z, OAK_FENCE);
      continue;
    }
    if (dx === midX) { piece(x, gradeY, z, WATER); continue; } // irrigation, recessed in soil
    piece(x, gradeY, z, FARMLAND, 8);                          // wet farmland
    const roll = posHash(ctx.seeds.detail, x, 0, z);
    const crop = roll < 0.5 ? WHEAT_CROP : roll < 0.8 ? CARROT_CROP : POTATO_CROP;
    piece(x, gradeY + 1, z, crop, 4 + rngInt(rng, 4));         // stage 4–7
  }
  // composter + chest flank the gate; torches on two corners (light — no dark pit)
  piece(bx0 + midX - 1, gradeY + 1, bz0 + D - 1, COMPOSTER);
  piece(bx0 + midX + 1, gradeY + 1, bz0 + D - 1, CHEST);
  meta.stations.push({ pos: [bx0 + midX - 1, gradeY + 1, bz0 + D - 1], type: 'composter', claimedBy: null });
  piece(bx0, gradeY + 2, bz0, TORCH);
  piece(bx0 + W - 1, gradeY + 2, bz0, TORCH);
}

// §4.3 animal_pen — fenced grass pen with a gate gap + one herd record.
function stampPen(rot, bx0, gradeY, bz0, W, D, pal, emit, rng, spawns) {
  const { piece } = emit;
  const midX = Math.floor(W / 2);
  for (let dx = 0; dx < W; dx++) for (let dz = 0; dz < D; dz++) {
    const x = bx0 + dx, z = bz0 + dz;
    piece(x, gradeY, z, GRASS);
    const edge = dx === 0 || dx === W - 1 || dz === 0 || dz === D - 1;
    const gate = dz === D - 1 && dx === midX;
    if (edge && !gate) piece(x, gradeY + 1, z, OAK_FENCE);
  }
  piece(bx0, gradeY + 2, bz0, TORCH);
  const species = ['cow', 'sheep', 'pig'][rngInt(rng, 3)];
  for (let i = 0; i < 2; i++) spawns.push({ type: species, x: bx0 + 2.5 + i, y: gradeY + 1, z: bz0 + 2.5 });
}

/**
 * Stamp any villages that overlap chunk (cx,cz) into `blocks` (+ `states`),
 * writing ONLY in-chunk cells in the fixed op order. Returns { villageMeta|null, spawns }.
 */
export function stampVillages(ctx, blocks, cx, cz, states = null) {
  const wx0 = cx * 16, wz0 = cz * 16;
  let villageMeta = null;
  const outSpawns = [];
  // §2.3 — the ±5-chunk reach window is UNCHANGED by the density tuning, and must
  // stay that way. Reach is a function of within() and the centre only, never of
  // REGION/ANCHOR_OFF/ANCHOR_SPREAD. Worst-case op extent from the anchor centre
  // (acx*16+8) is within()'s ±70 plus the butcher pen's +5 = ±75 blocks, so the
  // furthest written chunk is floor((acx*16 + 8 ± 75)/16) = acx ± 5. ±5 exactly
  // covers it. The scan below spans 11 chunks over 32-chunk regions, so it still
  // touches at most 2 regions per axis (32 > 2·5).
  const Vx0 = Math.floor((cx - 5) / REGION), Vx1 = Math.floor((cx + 5) / REGION);
  const Vz0 = Math.floor((cz - 5) / REGION), Vz1 = Math.floor((cz + 5) / REGION);
  for (let Vx = Vx0; Vx <= Vx1; Vx++) {
    for (let Vz = Vz0; Vz <= Vz1; Vz++) {
      const v = villageForRegion(ctx, Vx, Vz);
      if (!v) continue;
      if (Math.max(Math.abs(v.acx - cx), Math.abs(v.acz - cz)) > 5) continue;
      const L = layoutFor(ctx, v);
      for (const op of L.ops) {
        if (op.x < wx0 || op.x > wx0 + 15 || op.z < wz0 || op.z > wz0 + 15) continue;
        if (op.y < 1 || op.y > 127) continue;
        const idx = (op.y << 8) | ((op.z & 15) << 4) | (op.x & 15);
        if (blocks[idx] === BEDROCK) continue;                 // never overwrite bedrock (§2.6)
        blocks[idx] = op.id;
        if (states) states[idx] = op.state ?? 0;
      }
      if (cx === v.acx && cz === v.acz) {                       // emit meta once, on the anchor
        villageMeta = L.meta;
        const homeKey = v.acx + ',' + v.acz;                    // home gen villagers to this village (§11 golem count)
        for (const s of L.spawns) outSpawns.push({ ...s, homeVillage: homeKey });
      }
    }
  }
  return { villageMeta, spawns: outSpawns };
}
