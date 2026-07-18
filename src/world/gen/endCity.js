// 11-END §12 — end cities & the end ship (dim 2, outer islands). Region-seeded
// (8×8 chunks), rasterized per-chunk like the nether fortress. Pushes shulker
// spawn records + `{be:'chest', loot}` records consumed on the main thread.
//
// Block ids hardcoded: end_stone_bricks 155, purpur_block 156, purpur_pillar 157,
// end_rod 158, chest 37, shulker_box 164.
import { splitmix32, chunkSeed } from '../../math/rng.js';
import { endSurfaceAt } from './endSurface.js';

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
  // scan the 3×3 region block around this chunk (a city footprint ≤ ±80 blocks
  // spans several chunks; regions are 8 chunks, so ±1 region covers it).
  const rgx0 = Math.floor((cx - 6) / REGION), rgx1 = Math.floor((cx + 6) / REGION);
  const rgz0 = Math.floor((cz - 6) / REGION), rgz1 = Math.floor((cz + 6) / REGION);
  for (let rgx = rgx0; rgx <= rgx1; rgx++) {
    for (let rgz = rgz0; rgz <= rgz1; rgz++) {
      const city = cityForRegion(s, rgx, rgz);
      if (!city) continue;
      stampCity(city, set, cx, cz, spawns);
    }
  }
}

// A city is a pure function of its region seed (§12.1): 25% spawn roll, then a
// column pick + island/height gate. Memoized within a generator instance.
const cityCache = new Map();
function cityForRegion(s, rgx, rgz) {
  const key = s.city + ':' + rgx + ',' + rgz;   // seed-scoped (no cross-world leak)
  if (cityCache.has(key)) return cityCache.get(key);
  let city = null;
  const rng = splitmix32(chunkSeed(s.city, rgx, rgz));
  if (rng() < 0.25) {
    const ox = rgx * REGION * 16 + Math.floor(rng() * REGION * 16);
    const oz = rgz * REGION * 16 + Math.floor(rng() * REGION * 16);
    const surfY = surfaceAt(s, ox, oz);
    if (surfY != null && surfY >= 50) {
      city = buildCityPlan(s, ox, oz, surfY, rng);
    }
  }
  cityCache.set(key, city);
  return city;
}

function surfaceAt(s, wx, wz) { return endSurfaceAt(s, wx, wz); }

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
      P(ox + dx, y0, oz + dz, END_STONE_BRICKS);   // floor ring
      if (edge) for (let dy = 1; dy <= 4; dy++) P(ox + dx, y0 + dy, oz + dz, corner ? PURPUR_PILLAR : PURPUR);
    }
    // spiral parkour steps (full purpur blocks — §12.2 adaptation)
    for (let step = 0; step < 4; step++) P(ox - 3 + step, y0 + 1 + step, oz - 3, PURPUR);
    // 4 end_rods per floor
    for (const [rx, rz] of [[-3, -3], [4, -3], [-3, 4], [4, 4]]) P(ox + rx, y0 + 1, oz + rz, END_ROD);
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
  // 3 shulker spawn records (deck/stern/room analog — base tower carries a few)
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
  // emit spawn/loot records once, on the chunk holding the city origin
  if ((city.ox >> 4) === cx && (city.oz >> 4) === cz) for (const r of city.spawns) spawns.push(r);
}
