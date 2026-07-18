// 12-VILLAGES §2–§5 — deterministic multi-chunk village worldgen.
//
// The whole layout is a PURE FUNCTION of its anchor chunk seed (§2.4). Every
// chunk that overlaps a village independently recomputes the layout and replays
// the SAME ordered op list, writing only cells inside itself — so the union is
// byte-identical to a single-pass stamp regardless of visit order. No chunk ever
// reads another chunk's blocks; terrain queries go through canonical heightAt.
// Worker-side (no registry import): block ids are hardcoded.

import { splitmix32, chunkSeed, rngInt } from '../../math/rng.js';
import { BIOMES } from './biomes.js';

// ---- block ids (registry-free, mirrors the registered ids) ----
const AIR = 0, GRASS = 2, DIRT = 3, COBBLE = 4, OAK_PLANKS = 5, SPRUCE_PLANKS = 7,
  SPRUCE_LOG = 10, OAK_LOG = 8, SANDSTONE = 20, BEDROCK = 17, GLASS = 31, CHEST = 37,
  TORCH = 38, OAK_FENCE = 52, OAK_DOOR = 53, BED_BLOCK = 54, FARMLAND = 55, WHEAT_CROP = 56,
  WATER = 63, DIRT_PATH = 170, BELL = 171, COMPOSTER = 172, LECTERN = 174, BLAST_FURNACE = 175,
  SMOKER = 177, FLETCHING_TABLE = 179, HAY_BALE = 180, GRINDSTONE = 107, SMITHING_TABLE = 143,
  BREWING_STAND = 112, BOOKSHELF = 50;

const REGION = 32;
const VILLAGE_BIOMES = new Set([BIOMES.PLAINS, BIOMES.DESERT, BIOMES.SAVANNA, BIOMES.TAIGA]);

// §5 — per-biome palette (floor / wall / roof / log). Desert is all sandstone.
function paletteFor(biome) {
  if (biome === BIOMES.DESERT) return { floor: SANDSTONE, wall: SANDSTONE, roof: SANDSTONE, log: SANDSTONE, path: SANDSTONE };
  if (biome === BIOMES.TAIGA) return { floor: COBBLE, wall: SPRUCE_PLANKS, roof: SPRUCE_PLANKS, log: SPRUCE_LOG, path: DIRT_PATH };
  return { floor: COBBLE, wall: OAK_PLANKS, roof: OAK_PLANKS, log: OAK_LOG, path: DIRT_PATH };   // plains / savanna
}

// ---- candidate grid (§2.1), memoized per region ----
const regionCache = new Map();
function villageForRegion(ctx, Vx, Vz) {
  const key = Vx + ',' + Vz;
  if (regionCache.has(key)) return regionCache.get(key);
  const rng = splitmix32(chunkSeed(ctx.seeds.village, Vx, Vz));
  const acx = Vx * REGION + 4 + rngInt(rng, 24);   // draw order is load-bearing:
  const acz = Vz * REGION + 4 + rngInt(rng, 24);    // two int draws, THEN the roll
  let v = null;
  if (rng() < 0.40) {
    const center = { x: acx * 16 + 8, z: acz * 16 + 8 };
    const biome = ctx.biomeAt(center.x, center.z);
    if (VILLAGE_BIOMES.has(biome) && ctx.heightAt(center.x, center.z) >= 64) {
      v = { acx, acz, center, biome };
    }
  }
  regionCache.set(key, v);
  return v;
}

// ---- layout (§3), LRU-8 cached by anchor ----
const layoutCache = new Map();
function layoutFor(ctx, v) {
  const key = v.acx + ',' + v.acz;
  const hit = layoutCache.get(key);
  if (hit) return hit;
  const L = buildLayout(ctx, v);
  layoutCache.set(key, L);
  if (layoutCache.size > 8) layoutCache.delete(layoutCache.keys().next().value);
  return L;
}

// A stamp op: {phase, x, y, z, id}. Phases fix the global replay order (§2.4):
// 1 CLEAR, 2 FOUNDATION, 3 PATH, 4 PIECES, 5 LAMP. Sorted stable by phase.
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
  const path = (x, y, z) => ops.push({ phase: 3, x, y, z, id: pal.path });
  const piece = (x, y, z, id) => ops.push({ phase: 4, x, y, z, id });
  const lamp = (x, y, z, id) => ops.push({ phase: 5, x, y, z, id });
  const within = (x, z) => Math.abs(x - cx) <= 72 && Math.abs(z - cz) <= 72;

  // --- WELL (fixed) at center offset (-8,-8), 4×4 ---
  {
    const wx = cx - 8, wz = cz - 8, yb = ctx.heightAt(wx + 1, wz + 1);
    for (let dx = 0; dx < 4; dx++) for (let dz = 0; dz < 4; dz++) {
      for (let dy = 0; dy <= 4; dy++) clear(wx + dx, yb + dy, wz + dz);
      const rim = dx === 0 || dx === 3 || dz === 0 || dz === 3;
      found(wx + dx, yb - 1, wz + dz, pal.floor);
      piece(wx + dx, yb, wz + dz, rim ? pal.wall : WATER);
      if (rim) piece(wx + dx, yb + 1, wz + dz, pal.wall);
    }
    for (const [dx, dz] of [[0, 0], [3, 0], [0, 3], [3, 3]]) { piece(wx + dx, yb + 2, wz + dz, OAK_FENCE); piece(wx + dx, yb + 3, wz + dz, TORCH); }
  }

  // --- MEETING POINT (fixed) 7×7 plaza with bell ---
  {
    const mx = cx - 3, mz = cz - 3, yb = centerY;
    for (let dx = 0; dx < 7; dx++) for (let dz = 0; dz < 7; dz++) {
      for (let dy = 1; dy <= 4; dy++) clear(mx + dx, yb + dy, mz + dz);
      found(mx + dx, yb - 1, mz + dz, pal.floor);
      path(mx + dx, yb, mz + dz);
    }
    piece(cx, yb + 1, cz, OAK_FENCE);
    piece(cx, yb + 2, cz, BELL);            // bellPos = [cx, centerY+2, cz]
    for (const [dx, dz] of [[0, 0], [6, 0], [0, 6], [6, 6]]) { lamp(mx + dx, yb + 1, mz + dz, OAK_FENCE); lamp(mx + dx, yb + 2, mz + dz, OAK_FENCE); lamp(mx + dx, yb + 3, mz + dz, TORCH); }
    placed.push({ minX: mx - 1, minZ: mz - 1, maxX: mx + 7, maxZ: mz + 7 });
    meta.indoorAnchors.push([cx, centerY + 1, cz]);
    for (let i = 0; i < 3; i++) spawns.push({ type: 'villager', x: cx + 0.5 + (i - 1), y: centerY + 1, z: cz + 0.5 });   // gen villagers near the bell
  }

  // --- PATH ARMS (§3.2) ---
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
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
    const len = 20 + rngInt(rng, 18);          // shorter than spec for compactness
    let sinceTurn = 0, turnAt = 6 + rngInt(rng, 5);
    const armCells = [];
    for (let s = 0; s < len; s++) {
      px += hx; pz += hz;
      if (!within(px, pz)) break;
      const ty = ctx.heightAt(px, pz);
      if (ty <= 63) break;
      y = Math.max(y - 1, Math.min(y + 1, ty));
      path(px, y, pz);
      for (let dy = 1; dy <= 3; dy++) clear(px, y + dy, pz);
      const lx = px - hz, lz = pz + hx;         // width-2, left of heading
      if (within(lx, lz)) { path(lx, y, lz); for (let dy = 1; dy <= 3; dy++) clear(lx, y + dy, lz); }
      armCells.push([px, y, pz, hx, hz]);
      if (++sinceTurn >= turnAt && rng() < 0.35) { const rot = rng() < 0.5 ? 1 : 3; di = (di + rot) % 4;[hx, hz] = DIRS[di]; sinceTurn = 0; turnAt = 6 + rngInt(rng, 5); }
    }
    arms.push(armCells);
  }

  // --- BUILDINGS along arms (§3.2 step 3) ---
  const targetBuildings = rng() < 0.6 ? 6 + rngInt(rng, 5) : 11 + rngInt(rng, 6);
  // Guarantee the gate stations: library (lectern) first, then a variety pool.
  const POOL = ['library', 'small_house', 'small_house', 'farm', 'church', 'smithy', 'butcher', 'fletcher',
    'small_house', 'small_house', 'farm', 'small_house'];
  let poolIdx = 0, built = 0;
  const overlaps = (aabb) => placed.some(p => aabb.minX <= p.maxX && aabb.maxX >= p.minX && aabb.minZ <= p.maxZ && aabb.maxZ >= p.minZ);

  for (const arm of arms) {
    let sinceSlot = 0, slotAt = 5 + rngInt(rng, 5);
    for (const [px, py, pz, hx, hz] of arm) {
      if (built >= targetBuildings) break;
      if (++sinceSlot < slotAt) continue;
      sinceSlot = 0; slotAt = 5 + rngInt(rng, 5);
      const side = rng() < 0.5 ? 1 : -1;
      const sx = -hz * side, sz = hx * side;          // perpendicular
      const bw = 5, bd = 5;
      const ox = px + sx * (2 + 2), oz = pz + sz * (2 + 2);   // building origin (footprint min corner-ish)
      const bx0 = ox - 2, bz0 = oz - 2;
      const yb = ctx.heightAt(ox, oz);
      // reject: overlap, relief > 3, out of bounds, water
      const corners = [[bx0, bz0], [bx0 + bw - 1, bz0], [bx0, bz0 + bd - 1], [bx0 + bw - 1, bz0 + bd - 1], [ox, oz]];
      let hmin = 999, hmax = -999, bad = false;
      for (const [qx, qz] of corners) { const h = ctx.heightAt(qx, qz); hmin = Math.min(hmin, h); hmax = Math.max(hmax, h); if (!within(qx, qz) || h <= 63) bad = true; }
      const aabb = { minX: bx0 - 1, minZ: bz0 - 1, maxX: bx0 + bw, maxZ: bz0 + bd };
      if (bad || hmax - hmin > 3 || overlaps(aabb)) continue;
      const type = POOL[poolIdx % POOL.length]; poolIdx++;
      buildHouse(type, bx0, yb, bz0, bw, bd, pal, { clear, found, piece, path }, meta, spawns, [px, py, pz], rng, ctx);
      placed.push(aabb);
      built++;
    }
  }

  ops.sort((a, b) => a.phase - b.phase);   // stable within phase (insertion order preserved)
  const L = { ops, meta, spawns };
  return L;
}

// A compact box building. type decides the workstation/fixtures. Emits ops + meta.
function buildHouse(type, x0, yb, z0, w, d, pal, ops, meta, spawns, doorFrom, rng) {
  const { clear, found, piece } = ops;
  const H = type === 'farm' ? 1 : 3;
  // clear volume + foundation
  for (let dx = -1; dx <= w; dx++) for (let dz = -1; dz <= d; dz++) {
    for (let dy = 0; dy <= H + 2; dy++) clear(x0 + dx, yb + dy, z0 + dz);
  }
  for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < d; dz++) found(x0 + dx, yb - 1, z0 + dz, pal.floor);

  if (type === 'farm') {
    // farmland + wheat + a water channel + a composter
    for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < d; dz++) {
      if (dz === Math.floor(d / 2)) { piece(x0 + dx, yb, z0 + dz, WATER); }
      else { piece(x0 + dx, yb, z0 + dz, FARMLAND); piece(x0 + dx, yb + 1, z0 + dz, WHEAT_CROP); }
    }
    meta.stations.push({ pos: [x0, yb + 1, z0 - 1], type: 'composter', claimedBy: null });
    piece(x0, yb + 1, z0 - 1, COMPOSTER);
    return;
  }

  // walls (perimeter, height 2), corner logs, roof, door, torch
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < d; dz++) {
    const edge = dx === 0 || dx === w - 1 || dz === 0 || dz === d - 1;
    if (!edge) continue;
    const corner = (dx === 0 || dx === w - 1) && (dz === 0 || dz === d - 1);
    piece(x0 + dx, yb + dy, z0 + dz, corner ? pal.log : (dy === 1 && (dx === Math.floor(w / 2) || dz === Math.floor(d / 2)) ? GLASS : pal.wall));
  }
  for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < d; dz++) piece(x0 + dx, yb + 2, z0 + dz, pal.roof);   // flat roof
  // door on the -Z edge center
  const dxDoor = Math.floor(w / 2);
  piece(x0 + dxDoor, yb, z0, OAK_DOOR); piece(x0 + dxDoor, yb + 1, z0, OAK_DOOR + 0);   // (lower+upper share id; state simplified)
  piece(x0 + 1, yb + 1, z0 + 1, TORCH);

  // interior fixtures: a bed + optional workstation
  const inx = x0 + 1, inz = z0 + d - 2;
  piece(inx, yb, inz, BED_BLOCK);            // bed foot
  piece(inx + 1, yb, inz, BED_BLOCK);        // bed head
  meta.beds.push({ pos: [inx, yb, inz], claimedBy: null });
  meta.indoorAnchors.push([x0 + Math.floor(w / 2), yb, z0 + Math.floor(d / 2)]);

  const STATION = { library: [LECTERN, 'lectern'], church: [BREWING_STAND, 'brewing_stand'], butcher: [SMOKER, 'smoker'], fletcher: [FLETCHING_TABLE, 'fletching_table'], smithy: [SMITHING_TABLE, 'smithing_table'] }[type];
  if (STATION) {
    const wx = x0 + w - 2, wz = z0 + 1;
    piece(wx, yb, wz, STATION[0]);
    meta.stations.push({ pos: [wx, yb, wz], type: STATION[1], claimedBy: null });
    if (type === 'smithy') { piece(x0 + w - 2, yb, z0 + d - 2, GRINDSTONE); piece(x0 + 1, yb, z0 + 1, CHEST); piece(x0 + w - 2, yb, z0 + d - 3, BLAST_FURNACE); }
    if (type === 'library') piece(x0 + 1, yb, z0 + 1, BOOKSHELF);
  }
  // one villager spawn per building interior
  spawns.push({ type: 'villager', x: x0 + Math.floor(w / 2) + 0.5, y: yb + 1, z: z0 + Math.floor(d / 2) + 0.5 });
}

/**
 * Stamp any villages that overlap chunk (cx,cz) into `blocks`, writing ONLY
 * in-chunk cells in the fixed op order. Returns { villageMeta|null, spawns }.
 */
export function stampVillages(ctx, blocks, cx, cz) {
  const wx0 = cx * 16, wz0 = cz * 16;
  let villageMeta = null;
  const outSpawns = [];
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
