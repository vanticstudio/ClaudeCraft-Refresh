// 11-END §12 — end cities & the end ship (dim 2, outer islands). Region-seeded
// (8×8 chunks), rasterized per-chunk like the nether fortress. Pushes shulker
// spawn records + `{be:'chest', loot}` records consumed on the main thread.
//
// Block ids hardcoded: end_stone_bricks 155, purpur_block 156, purpur_pillar 157,
// end_rod 158, chest 37, shulker_box 164.
import { splitmix32, chunkSeed } from '../../math/rng.js';
import { endColumnAt } from './endSurface.js';

const END_STONE_BRICKS = 155, PURPUR = 156, PURPUR_PILLAR = 157, END_ROD = 158, CHEST = 37;

const REGION = 8;   // 8×8 chunks = 128×128 blocks (§12.1)

/**
 * Rasterize any end city overlapping chunk (cx,cz). Writes purpur/end-stone-brick
 * pieces + end_rods, pushes shulker spawn records and chest-loot records.
 */
export function generateEndCity(s, blocks, cx, cz, spawns) {
  const set = (wx, y, wz, id) => {
    if ((wx >> 4) === cx && (wz >> 4) === cz && y >= 0 && y <= 127) blocks[(y << 8) | ((wz & 15) << 4) | (wx & 15)] = id;
  };
  // Scan the regions that can hold a city touching THIS chunk. The old ±6-chunk
  // window cited a "≤ ±80 block" footprint; that bound was stale — buildCityPlan's
  // real bounds are ox±8 / oz±8 and its widest op is the 12×12 foundation, i.e. a
  // 17-block footprint that spans at most the origin chunk and one neighbour. So
  // only origins with |ocx − cx| <= 1 can write here, and ±2 chunks keeps a full
  // chunk of slack over that. Output-identical for every seed (the regions dropped
  // could never have contributed an op) — pure dead-work removal, and it pays for
  // the raised spawn roll below. ±2 also keeps this at ≤2 regions per axis even if
  // REGION is later shrunk.
  const rgx0 = Math.floor((cx - 2) / REGION), rgx1 = Math.floor((cx + 2) / REGION);
  const rgz0 = Math.floor((cz - 2) / REGION), rgz1 = Math.floor((cz + 2) / REGION);
  for (let rgx = rgx0; rgx <= rgx1; rgx++) {
    for (let rgz = rgz0; rgz <= rgz1; rgz++) {
      const city = cityForRegion(s, rgx, rgz);
      if (!city) continue;
      stampCity(city, set, cx, cz, spawns);
    }
  }
}

// A city is a pure function of its region seed (§12.1): spawn roll, then a
// column pick + island/height gate. Memoized within a generator instance.
const cityCache = new Map();
function cityForRegion(s, rgx, rgz) {
  const key = s.city + ':' + rgx + ',' + rgz;   // seed-scoped (no cross-world leak)
  if (cityCache.has(key)) return cityCache.get(key);
  let city = null;
  const rng = splitmix32(chunkSeed(s.city, rgx, rgz));
  // UPDATE-structure-density DEVIATES from 11-END §12.1's 25% spawn roll: measured
  // 0.0383 cities/region over 3 seeds × 18,984 outer-belt regions = 1 per ~654
  // blocks. 0.45 measures 0.0698/region = 1 per ~484 blocks (1.35× closer, 1.8×
  // more cities) on the same sample. The roll is the
  // only real knob: raising TRIES below buys almost nothing, because the 16
  // candidate columns are spatially correlated inside one 128-block region (which
  // is smaller than the island/void feature scale), so the ~18% acceptance across
  // 16 tries is essentially P(this region has an island at all). The draw is
  // consumed unconditionally and the region stream feeds nothing outside this
  // function, so only the threshold moves.
  if (rng() < 0.45) {
    // §12.1 — "beyond d 1024 … require §8.1 island mass m ≥ 0.35 there and surface
    // Y ≥ 50". The mass gate matters structurally: at m < 0.35 the rim is only
    // 3 + 24m ≈ 3-11 blocks thick and the city's own 3-deep foundation (below)
    // punches straight through it. A single column draw clears m ≥ 0.35 only ~1
    // time in 8, which would gut §12.1's "≈1 city per 5-8 regions of island belt",
    // so draw up to TRIES columns off the same region stream and take the first
    // that passes (still a pure function of the region seed). Measured on seed
    // 'audit' over 41×41 regions: 1 draw + no mass gate = 52 cities (the old
    // behaviour), 16 draws + the gate = 55 — density held, thin rims dropped.
    const TRIES = 16;
    for (let t = 0; t < TRIES && !city; t++) {
      const ox = rgx * REGION * 16 + Math.floor(rng() * REGION * 16);
      const oz = rgz * REGION * 16 + Math.floor(rng() * REGION * 16);
      const col = endColumnAt(s, ox, oz);
      if (col && col.surfY >= 50 && col.m >= 0.35 && Math.hypot(ox, oz) > 1024) {
        city = buildCityPlan(s, ox, oz, col.surfY, rng);
      }
    }
  }
  cityCache.set(key, city);
  return city;
}

// §12.2 — a compact tower-grammar city plan (ordered op list, phase-sorted so
// overlapping chunks replay the identical global write order).
function buildCityPlan(s, ox, oz, surfY, rng) {
  const ops = [];
  const spawns = [];
  const base = surfY + 1;
  const P = (x, y, z, id) => ops.push({ x, y, z, id });
  // base platform 12×3 foundation into the terrain
  for (let dx = -6; dx <= 5; dx++) for (let dz = -6; dz <= 5; dz++) for (let dy = -2; dy <= 0; dy++) P(ox + dx, base + dy, oz + dz, END_STONE_BRICKS);
  // base tower: 3 floors, 10×10, purpur walls + pillar corners + rod lights + spiral
  const nFloors = 3;
  for (let f = 0; f < nFloors; f++) {
    const y0 = base + f * 5;
    for (let dx = -4; dx <= 5; dx++) for (let dz = -4; dz <= 5; dz++) {
      const edge = dx === -4 || dx === 5 || dz === -4 || dz === 5;
      const corner = (dx === -4 || dx === 5) && (dz === -4 || dz === 5);
      // §18 "tower spiral climbable" — punch a stairwell through every floor ABOVE
      // the first, over the top of the floor below's spiral (steps sit at dz = -3,
      // dx = -3..0, y0-4..y0-1). A 1-block hop needs the cell TWO above the feet
      // free in the source column as well, so the hole runs dx -2..0: -2 clears
      // the hop off step 1, -1 the head over step 2, 0 the feet+head on step 3 —
      // which then leaves one hop up onto this floor's slab at dx 1. Without the
      // hole the slab seals the spiral into the ceiling.
      const stair = f > 0 && dz === -3 && dx >= -2 && dx <= 0;
      if (!stair) P(ox + dx, y0, oz + dz, END_STONE_BRICKS);   // floor ring
      if (edge) for (let dy = 1; dy <= 4; dy++) {
        // ground-floor doorway (3 wide × 3 high, -X wall): floor 0 is otherwise a
        // sealed void and its §12.4 shulker record is entombed.
        if (f === 0 && dx === -4 && dz >= -1 && dz <= 1 && dy <= 3) continue;
        P(ox + dx, y0 + dy, oz + dz, corner ? PURPUR_PILLAR : PURPUR);
      }
    }
    // spiral parkour steps (full purpur blocks — §12.2 adaptation)
    for (let step = 0; step < 4; step++) P(ox - 3 + step, y0 + 1 + step, oz - 3, PURPUR);
    // 4 end_rods per floor. The -X/-Z rod sits at dz = -2, NOT on the spiral's
    // (-3,-3) column: ops are y-sorted stably and the rod is pushed last, so it
    // would replace step 0 with a non-collidable end_rod and break the climb.
    for (const [rx, rz] of [[-3, -2], [4, -3], [-3, 4], [4, 4]]) P(ox + rx, y0 + 1, oz + rz, END_ROD);
  }
  const topY = base + nFloors * 5;
  const cy = topY - 4;   // top-floor chest level (sits on the base+10 floor ring)
  // treasure: an elytra chest (§12.5 — the ship's guaranteed elytra, simplified to a
  // city treasure chest) + a standard loot chest, then a decorative shulker box. Each
  // loot RECORD position MUST match its CHEST block cell so rollGenChest finds it.
  P(ox + 2, cy, oz + 2, CHEST);
  spawns.push({ be: 'chest', loot: 'end_ship', x: ox + 2, y: cy, z: oz + 2 });   // guaranteed elytra
  P(ox - 2, cy, oz - 2, CHEST);
  spawns.push({ be: 'chest', loot: 'end_city', x: ox - 2, y: cy, z: oz - 2 });
  P(ox, cy, oz, 164);     // shulker_box decorative (own cell, off the chests)
  // 2 shulker spawn records (deck/stern analog — base tower carries a few). The
  // ground-floor one is only spawnable because of the §12.2 doorway punched above.
  spawns.push({ type: 'shulker', x: ox + 0.5, y: topY - 3, z: oz + 0.5 });
  spawns.push({ type: 'shulker', x: ox + 3.5, y: base + 1, z: oz + 3.5 });
  ops.sort((a, b) => a.y - b.y);   // stable within y → deterministic replay order
  return { ox, oz, ops, spawns, bounds: { minX: ox - 8, maxX: ox + 8, minZ: oz - 8, maxZ: oz + 8 } };
}

function stampCity(city, set, cx, cz, spawns) {
  const wx0 = cx * 16, wz0 = cz * 16;
  for (const op of city.ops) {
    if (op.x < wx0 || op.x > wx0 + 15 || op.z < wz0 || op.z > wz0 + 15) continue;
    set(op.x, op.y, op.z, op.id);
  }
  // Emit each record ONCE, on the chunk that owns ITS cell (stronghold.js:348
  // pattern). The chests sit at ox±2/oz±2, so they cross the origin chunk's border
  // for ~23% of cities — records emitted from the origin chunk then reference a
  // cell whose CHEST block is not installed yet, and Game.rollGenChest bails while
  // spawnsDone latches, losing the loot permanently.
  for (const r of city.spawns) {
    if ((Math.floor(r.x) >> 4) === cx && (Math.floor(r.z) >> 4) === cz) spawns.push(r);
  }
}
