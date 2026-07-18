// 11-END §4 + §5.1 — the overworld stronghold generator. PURE, deterministic,
// worker-importable (imports only rng.js + endShared.js — no registry/DOM).
//
// Exactly ONE stronghold per world at strongholdXZ(worldSeed) = {SX,SZ,rot}. The
// plan (a socket/frontier grammar, §4.4) is a pure function of the layout seed and
// is built once + cached; every chunk that intersects it independently re-rasters
// the SAME plan clipped to itself, so the union is byte-identical regardless of
// visit order (the village/fortress determinism contract). The stronghold ignores
// surface terrain: it sits in a fixed underground Y band (14–46), start-floor Y40.
//
// Block ids are hardcoded (workers don't import the registry):
//   air 0, bedrock 17, chest 37, torch 38, bookshelf 50, water 63, lava 64,
//   stone_bricks 150, mossy_stone_bricks 151, cracked_stone_bricks 152,
//   iron_bars 153, end_portal_frame 161.

import { splitmix32, mix32, hashString, posHash, rngInt } from '../../math/rng.js';
import { strongholdXZ, strongholdSeed } from './endShared.js';
export { strongholdXZ } from './endShared.js';

const AIR = 0, BEDROCK = 17, CHEST = 37, TORCH = 38, BOOKSHELF = 50, WATER = 63, LAVA = 64;
const STONE_BRICKS = 150, MOSSY = 151, CRACKED = 152, IRON_BARS = 153, PORTAL_FRAME = 161;

// Facing lattice — IDENTICAL to the registry's FACING_DIR (block state bits 0-1),
// so end_portal_frame facing bits are engine-correct. Index = facing value.
const DIRS = [[0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 0]];

const SY = 40;                 // start-piece floor (the eye-of-ender target Y, §4.2)
const FLOOR = 34;              // working corridor floor-air level (feet); start descends 6 → 34
const Y_MIN = 14, Y_MAX = 46;  // §4.2 clamp band
const RADIUS = 96;             // §4.4 expansion radius from (SX,SZ)
const MAX_PIECES = 50, MAX_ATTEMPTS = 500;

// §4.6 stone-brick family mix, keyed by the shared 'sys:detail' pos-hash stream
// (== World.detailSeed / noise 'sys:detail'): <0.70 plain, <0.90 mossy, else cracked.
const detailSub = ws => mix32((ws >>> 0) ^ hashString('sys:detail'));
function brickAt(ds, x, y, z) {
  const r = posHash(ds, x, y, z);
  return r < 0.70 ? STONE_BRICKS : (r < 0.90 ? MOSSY : CRACKED);
}

// World-space AABB of an along/across/height box anchored at socket S facing d.
function boxAABB(S, d, a0, a1, c0, c1, y0, y1) {
  const [ax, , az] = DIRS[d], [px, , pz] = DIRS[(d + 1) & 3];
  const xs = [], zs = [];
  for (const a of [a0, a1]) for (const c of [c0, c1]) { xs.push(S.x + a * ax + c * px); zs.push(S.z + a * az + c * pz); }
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0, y1, z0: Math.min(...zs), z1: Math.max(...zs) };
}

// ------------------------------------------------------------------ sockets
// A socket = {x,y,z,dir,depth}: the doorway cell where the NEXT piece attaches.
// A far-wall exit (ahead) at across-offset dc; a side-wall exit (turn/branch).
function farExit(S, d, L, dc) {
  const [ax, , az] = DIRS[d], [px, , pz] = DIRS[(d + 1) & 3];
  return { x: S.x + (L + 1) * ax + dc * px, y: S.y, z: S.z + (L + 1) * az + dc * pz, dir: d, depth: S.depth + 1 };
}
function sideExit(S, d, a0, side, hw) {
  const [ax, , az] = DIRS[d], [px, , pz] = DIRS[(d + 1) & 3];
  const c = side * (hw + 1), nd = side > 0 ? (d + 1) & 3 : (d + 3) & 3;
  return { x: S.x + a0 * ax + c * px, y: S.y, z: S.z + a0 * az + c * pz, dir: nd, depth: S.depth + 1 };
}

// ------------------------------------------------------------------ raster
// Generic shell: brick walls/floor/ceiling, carved interior air, and the ENTRY
// door carved to air. A piece always carves its OWN entry (shared with the parent
// wall); exit/side walls stay solid until a CHILD carves them — sealed sockets
// therefore remain stone-brick walls (§4.4). Children are committed after parents,
// so their carves win on replay (§4.7 plan-order rasterization).
function drawBoxRaw(S, d, L, hw, IH, put, ds) {
  const [ax, , az] = DIRS[d], [px, , pz] = DIRS[(d + 1) & 3];
  for (let a = 0; a <= L + 1; a++)
    for (let c = -(hw + 1); c <= hw + 1; c++)
      for (let yy = S.y - 1; yy <= S.y + IH; yy++) {
        const wx = S.x + a * ax + c * px, wz = S.z + a * az + c * pz;
        const entryWall = a === 0, farWall = a === L + 1, sideWall = Math.abs(c) === hw + 1;
        const shell = entryWall || farWall || sideWall || yy === S.y - 1 || yy === S.y + IH;
        if (!shell) { put(wx, yy, wz, AIR); continue; }
        if (entryWall && Math.abs(c) <= 1 && yy >= S.y && yy <= S.y + 2) put(wx, yy, wz, AIR);   // entry door
        else put(wx, yy, wz, brickAt(ds, wx, yy, wz));
      }
}

function rasterPiece(p, put, ds) {
  if (p.custom) { p.custom(put, ds); return; }
  drawBoxRaw(p.S, p.d, p.box.L, p.box.hw, p.box.IH, put, ds);
  if (p.content) p.content(put, ds);
}

// A box-piece descriptor (inner AABB = collision volume; outer = raster/bounds).
function mkBox(type, S, d, L, hw, IH, opts = {}) {
  return {
    type, S: { x: S.x, y: S.y, z: S.z }, d, box: { L, hw, IH }, custom: null,
    content: opts.content || null,
    inner: boxAABB(S, d, 1, L, -hw, hw, S.y, S.y + IH - 1),
    outer: boxAABB(S, d, 0, L + 1, -(hw + 1), hw + 1, S.y - 1, S.y + IH),
    exits: opts.exits || [], chests: opts.chests || [],
  };
}

// ------------------------------------------------------------------ pieces
// Start staircase (spiral simplified to a straight descent): floor Y40 → Y34 over
// 6 steps, one exit at the bottom into the five-way crossing. Includes a short
// vertical access shaft at (SX,SZ) so a downward dig at the eye target lands in it.
function makeStart(SX, SZ, rot) {
  const d = rot & 3, S = { x: SX, y: SY, z: SZ, dir: d, depth: 0 };
  const custom = (put, ds) => {
    const [ax, , az] = DIRS[d], [px, , pz] = DIRS[(d + 1) & 3];
    for (let a = 0; a <= 8; a++) {
      const fy = SY - Math.min(a, 6);
      for (let c = -2; c <= 2; c++) {
        const wx = S.x + a * ax + c * px, wz = S.z + a * az + c * pz;
        put(wx, fy - 1, wz, brickAt(ds, wx, fy - 1, wz));   // step/floor
        put(wx, fy + 3, wz, brickAt(ds, wx, fy + 3, wz));   // ceiling
        const wall = Math.abs(c) === 2 || a === 8;
        for (let yy = fy; yy <= fy + 2; yy++) put(wx, yy, wz, wall ? brickAt(ds, wx, yy, wz) : AIR);
      }
    }
    for (let yy = SY; yy <= SY + 5; yy++) put(S.x, yy, S.z, AIR);   // dig-shaft marker
  };
  return {
    type: 'start', S, d, box: null, custom, content: null,
    inner: boxAABB(S, d, 0, 7, -1, 1, FLOOR, SY + 3),
    outer: boxAABB(S, d, -1, 8, -2, 2, FLOOR - 1, SY + 4),
    exits: [{ x: SX + 8 * DIRS[d][0], y: FLOOR, z: SZ + 8 * DIRS[d][2], dir: d, depth: 1 }], chests: [],
  };
}

// Five-way crossing (§4.3): a wide atrium with 4 out-sockets (two ahead + L + R).
function makeCrossing(S) {
  const d = S.dir, L = 8, hw = 3, IH = 4;
  const [ax, , az] = DIRS[d];
  const exits = [farExit(S, d, L, 2), farExit(S, d, L, -2), sideExit(S, d, 4, 1, hw), sideExit(S, d, 4, -1, hw)];
  const content = (put, ds) => put(S.x + 4 * ax, S.y, S.z + 4 * az, TORCH);
  return mkBox('crossing', S, d, L, hw, IH, { exits, content });
}

// Straight corridor (§4.3): 1 ahead socket + up to 2 branch sockets, 0–2 torches.
function makeCorridor(S, rng, ds0) {
  const d = S.dir, L = 3 + rngInt(rng, 3), hw = 1, IH = 3;
  const rL = rng(), rR = rng();                      // drawn regardless (byte-stable)
  const exits = [farExit(S, d, L, 0)];
  if (rL < 0.30) exits.push(sideExit(S, d, 2, 1, hw));
  if (rR < 0.30) exits.push(sideExit(S, d, 2, -1, hw));
  const content = (put, ds) => {
    const [ax, , az] = DIRS[d];
    for (let a = 1; a <= L; a++) {
      const wx = S.x + a * ax, wz = S.z + a * az;
      if (posHash(ds, wx, S.y + 9, wz) < 0.14) put(wx, S.y, wz, TORCH);
    }
  };
  return mkBox('corridor', S, d, L, hw, IH, { exits, content });
}

// Corridor turn (§4.3): a short run with a single perpendicular exit.
function makeTurn(S, rng) {
  const d = S.dir, L = 3, hw = 1, IH = 3;
  const side = rng() < 0.5 ? 1 : -1;
  return mkBox('turn', S, d, L, hw, IH, { exits: [sideExit(S, d, 2, side, hw)] });
}

// Chest "altar" corridor (§4.3): dead-end with a raised stone-brick altar + chest.
function makeAltar(S) {
  const d = S.dir, L = 5, hw = 1, IH = 5;
  const [ax, , az] = DIRS[d];
  const acx = S.x + 3 * ax, acz = S.z + 3 * az;
  const chest = { x: acx, y: S.y + 1, z: acz, loot: 'stronghold' };
  const content = (put, ds) => {
    put(acx, S.y, acz, brickAt(ds, acx, S.y, acz));    // altar block
    put(acx, S.y + 1, acz, CHEST);                     // chest atop
    put(S.x + 2 * ax, S.y, S.z + 2 * az, TORCH);
    put(S.x + 4 * ax, S.y, S.z + 4 * az, TORCH);
  };
  return mkBox('altar', S, d, L, hw, IH, { content, chests: [chest] });
}

// Fountain room (§4.3): dead-end with a 3×3 stone-brick basin + 1 water source.
function makeFountain(S) {
  const d = S.dir, L = 7, hw = 3, IH = 5;
  const content = (put, ds) => {
    const [ax, , az] = DIRS[d], [px, , pz] = DIRS[(d + 1) & 3];
    for (let da = -1; da <= 1; da++) for (let dc = -1; dc <= 1; dc++) {
      const wx = S.x + (4 + da) * ax + dc * px, wz = S.z + (4 + da) * az + dc * pz;
      put(wx, S.y, wz, da === 0 && dc === 0 ? WATER : brickAt(ds, wx, S.y, wz));
    }
    for (const [a0, c0] of [[1, hw - 1], [1, -(hw - 1)], [L, hw - 1], [L, -(hw - 1)]])
      put(S.x + a0 * ax + c0 * px, S.y, S.z + a0 * az + c0 * pz, TORCH);
  };
  return mkBox('fountain', S, d, L, hw, IH, { content });
}

// Library (§4.5, duplex simplified): dead-end, bookshelf-lined walls, 2 chests each
// carrying a guaranteed enchanted book (rolled main-thread from 'stronghold_library').
function makeLibrary(S) {
  const d = S.dir, L = 13, hw = 5, IH = 7;
  const [ax, , az] = DIRS[d], [px, , pz] = DIRS[(d + 1) & 3];
  const c1 = { x: S.x + 3 * ax, y: S.y, z: S.z + 3 * az, loot: 'stronghold_library' };
  const c2 = { x: S.x + (L - 2) * ax, y: S.y, z: S.z + (L - 2) * az, loot: 'stronghold_library' };
  const bands = [[S.y, S.y + 2], [S.y + 4, S.y + 6]];   // two "floors" of shelves
  const content = (put, ds) => {
    for (let a = 2; a <= L; a++) for (const c of [-hw, hw])
      for (const [y0, y1] of bands) for (let yy = y0; yy <= y1; yy++)
        put(S.x + a * ax + c * px, yy, S.z + a * az + c * pz, BOOKSHELF);
    for (let c = -(hw - 1); c <= hw - 1; c++)
      for (const [y0, y1] of bands) for (let yy = y0; yy <= y1; yy++)
        put(S.x + L * ax + c * px, yy, S.z + L * az + c * pz, BOOKSHELF);
    put(c1.x, c1.y, c1.z, CHEST); put(c2.x, c2.y, c2.z, CHEST);
    for (const [a0, c0] of [[2, 0], [7, hw - 1], [7, -(hw - 1)], [L - 1, 0]])
      put(S.x + a0 * ax + c0 * px, S.y, S.z + a0 * az + c0 * pz, TORCH);
  };
  return mkBox('library', S, d, L, hw, IH, { content, chests: [c1, c2] });
}

// Portal room (§5.1) — EXACT. 11×8×16 shell, iron-bars entry grate, lava pool,
// 12 end_portal_frame ring (5×5 minus corners) each facing inward, 10%/frame eye
// pre-fill, stone under each frame. NO spawner. Solid floor at yb=S.y-1 (flush with
// the corridor floor); frames/portal plane at feet level S.y; lava at yb below.
function makePortal(S) {
  const d = S.dir, L = 14, hw = 4, IH = 6;
  const custom = (put, ds) => {
    drawBoxRaw(S, d, L, hw, IH, put, ds);
    const [ax, , az] = DIRS[d], [px, , pz] = DIRS[(d + 1) & 3];
    const cell = (a, c) => ({ x: S.x + a * ax + c * px, z: S.z + a * az + c * pz });
    const fy = S.y, yb = S.y - 1;
    // entry grate (2 columns + top row iron-bars; middle-bottom open — §4.3/§5.1)
    for (let c = -1; c <= 1; c++) for (let yy = S.y; yy <= S.y + 2; yy++) {
      const p = cell(0, c);
      put(p.x, yy, p.z, (Math.abs(c) === 1 || yy === S.y + 2) ? IRON_BARS : AIR);
    }
    for (let c = -1; c <= 1; c++) { const p = cell(7, c); put(p.x, fy, p.z, brickAt(ds, p.x, fy, p.z)); }   // step
    for (let a = 9; a <= 11; a++) for (let c = -1; c <= 1; c++) {   // lava pool under the portal plane
      const p = cell(a, c); put(p.x, yb, p.z, LAVA); put(p.x, fy, p.z, AIR);   // portal cells stay air until activation
    }
    for (let da = -2; da <= 2; da++) for (let dc = -2; dc <= 2; dc++) {
      if (Math.max(Math.abs(da), Math.abs(dc)) !== 2) continue;          // perimeter of the 5×5
      if (Math.abs(da) === 2 && Math.abs(dc) === 2) continue;           // minus corners → 12
      const p = cell(10 + da, dc);
      put(p.x, yb, p.z, brickAt(ds, p.x, yb, p.z));                     // stone under each frame
      let wdx, wdz;                                                     // inward-facing unit
      if (Math.abs(da) === 2) { const s = -Math.sign(da); wdx = s * ax; wdz = s * az; }
      else { const s = -Math.sign(dc); wdx = s * px; wdz = s * pz; }
      let facing = 0;
      for (let f = 0; f < 4; f++) if (DIRS[f][0] === wdx && DIRS[f][2] === wdz) { facing = f; break; }
      const eye = posHash(ds, p.x, fy, p.z) < 0.10;                     // 10% pre-filled (§5.1)
      put(p.x, fy, p.z, PORTAL_FRAME, facing | (eye ? 4 : 0));          // state bits0-1 facing, bit2 eye
    }
    for (const c of [-2, 2]) { const p = cell(1, c); put(p.x, S.y, p.z, TORCH); }   // entry torches
  };
  return {
    type: 'portal', S: { x: S.x, y: S.y, z: S.z }, d, box: null, custom, content: null,
    inner: boxAABB(S, d, 1, L, -hw, hw, S.y, S.y + IH - 1),
    outer: boxAABB(S, d, 0, L + 1, -(hw + 1), hw + 1, S.y - 1, S.y + IH), exits: [], chests: [],
  };
}

// ------------------------------------------------------------------ plan (§4.4)
function pickType(rng, S, counts) {
  const opts = [];
  const add = (t, w) => { for (let i = 0; i < w; i++) opts.push(t); };
  add('corridor', 40); add('turn', 18);
  if (counts.altar < 4) add('altar', 12);
  if (counts.fountain < 2) add('fountain', 6);
  if (counts.library < 2 && S.depth >= 4) add('library', 6);   // §4.3 min socket depth 4
  return opts[rngInt(rng, opts.length)];
}
function makePiece(type, S, rng, ds) {
  switch (type) {
    case 'corridor': return makeCorridor(S, rng, ds);
    case 'turn': return makeTurn(S, rng);
    case 'altar': return makeAltar(S);
    case 'fountain': return makeFountain(S);
    case 'library': return makeLibrary(S);
  }
  return null;
}

function buildPlan(ws) {
  const { SX, SZ, rot } = strongholdXZ(ws);
  const detailSeed = detailSub(ws);
  const rng = splitmix32(strongholdSeed(ws));
  rng(); rng(); rng();                       // mirror §4.2's 3 draws; the plan continues the stream

  const pieces = [], placed = [], chests = [], allSockets = [];
  const counts = { corridor: 0, turn: 0, altar: 0, fountain: 0, library: 0, crossing: 0, portal: 0, start: 0 };
  const hit = (a, b) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.z0 <= b.z1 && a.z1 >= b.z0 && a.y0 <= b.y1 && a.y1 >= b.y0;
  const fits = p => !placed.some(q => hit(p.inner, q)) &&
    p.outer.y0 >= Y_MIN && p.outer.y1 <= Y_MAX &&
    Math.hypot((p.outer.x0 + p.outer.x1) / 2 - SX, (p.outer.z0 + p.outer.z1) / 2 - SZ) <= RADIUS;
  const commit = p => { pieces.push(p); placed.push(p.inner); counts[p.type] = (counts[p.type] || 0) + 1; if (p.chests) for (const c of p.chests) chests.push(c); };

  const start = makeStart(SX, SZ, rot); commit(start);
  const cross = makeCrossing(start.exits[0]); commit(cross);        // start always exits into a crossing
  let frontier = cross.exits.slice();
  for (const e of frontier) allSockets.push(e);

  const target = 18 + rngInt(rng, 7);        // 18–24 pieces
  let attempts = 0, portalPlaced = false;
  while (frontier.length && pieces.length < MAX_PIECES && attempts < MAX_ATTEMPTS && !portalPlaced) {
    attempts++;
    const S = frontier.splice(rngInt(rng, frontier.length), 1)[0];
    if (pieces.length >= target && S.depth >= 5) {                  // portal once expanded + deep enough
      const p = makePortal(S);
      if (fits(p)) { commit(p); portalPlaced = true; break; }
    }
    let type = pickType(rng, S, counts);
    if (counts.corridor < 10) type = 'corridor';                   // guarantee ≥10 corridors (gate)
    else if (counts.altar === 0 && S.depth >= 3) type = 'altar';   // guarantee ≥1 altar chest (gate)
    const p = makePiece(type, S, rng, detailSeed);
    if (p && fits(p)) { commit(p); for (const e of p.exits) { frontier.push(e); allSockets.push(e); } }
    // else: seal — the socket's wall stays a solid stone-brick face (§4.4)
  }

  // Guarantee ≥1 altar even if the loop terminated without one.
  if (counts.altar === 0) for (const s of allSockets) { const p = makeAltar(s); if (fits(p)) { commit(p); break; } }

  // Guarantee exactly one portal room: force it at the deepest socket, overlap allowed
  // (portal appended last → wins on plan-order raster, mirroring vanilla's restart rule).
  if (!portalPlaced) {
    let best = allSockets[0] || start.exits[0];
    for (const s of allSockets) if (s.depth > best.depth) best = s;
    commit(makePortal(best));
  }

  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const p of pieces) { const o = p.outer; if (o.x0 < minX) minX = o.x0; if (o.x1 > maxX) maxX = o.x1; if (o.z0 < minZ) minZ = o.z0; if (o.z1 > maxZ) maxZ = o.z1; }
  return { SX, SZ, rot, pieces, chests, detailSeed, bounds: { minX, maxX, minZ, maxZ } };
}

// ------------------------------------------------------------------ rasterize (§4.7)
function stampChunk(plan, blocks, cx, cz, spawns, states) {
  const { pieces, chests, detailSeed, bounds } = plan;
  const wx0 = cx << 4, wz0 = cz << 4, wx1 = wx0 + 15, wz1 = wz0 + 15;
  if (wx1 < bounds.minX || wx0 > bounds.maxX || wz1 < bounds.minZ || wz0 > bounds.maxZ) return;
  const put = (x, y, z, id, st) => {
    if ((x >> 4) !== cx || (z >> 4) !== cz || y < 0 || y > 127) return;
    const i = (y << 8) | ((z & 15) << 4) | (x & 15);
    if (blocks[i] === BEDROCK) return;                 // never overwrite bedrock (§4.7)
    blocks[i] = id;
    if (states) states[i] = st | 0;                    // frame facing/eye nibble (0 for the rest)
  };
  for (const p of pieces) {
    const o = p.outer;
    if (wx1 < o.x0 || wx0 > o.x1 || wz1 < o.z0 || wz0 > o.z1) continue;
    rasterPiece(p, put, detailSeed);
  }
  // Chest block-entities: emit each record ONCE, on the chunk that owns the chest
  // cell (the CHEST block lands in the same chunk, so main-thread §15 loot resolves
  // locally). Main thread rolls loot from the tag.
  if (spawns) for (const c of chests)
    if ((c.x >> 4) === cx && (c.z >> 4) === cz) spawns.push({ be: 'chest', loot: c.loot, x: c.x, y: c.y, z: c.z });
}

// ------------------------------------------------------------------ public API
const cache = new Map();   // worldSeed → stamper (LRU-2)

/**
 * Build a stamper bound to worldSeed. The plan is built lazily + cached, so create
 * ONE per generator and reuse it for every chunk.
 *   stampChunk(blocks, cx, cz, spawns, states?) — mutates blocks (+ optional states
 *   for the 12 portal-frame nibbles), pushing {be:'chest',loot,x,y,z} records into
 *   spawns. bounds/plan expose the plan for main-thread portal lookup.
 */
export function createStrongholdStamper(worldSeed) {
  const ws = typeof worldSeed === 'number' ? (worldSeed >>> 0) : hashString(String(worldSeed ?? ''));
  let plan = null;
  const getPlan = () => (plan || (plan = buildPlan(ws)));
  const { SX, SZ, rot } = strongholdXZ(ws);
  return {
    SX, SZ, rot,
    get bounds() { return getPlan().bounds; },
    get plan() { return getPlan(); },
    stampChunk(blocks, cx, cz, spawns, states) { stampChunk(getPlan(), blocks, cx, cz, spawns, states); },
  };
}

/** Convenience free-function wrapper (caches the stamper per worldSeed). */
export function stampStronghold(worldSeed, blocks, cx, cz, spawns, states) {
  const ws = typeof worldSeed === 'number' ? (worldSeed >>> 0) : hashString(String(worldSeed ?? ''));
  let st = cache.get(ws);
  if (!st) { st = createStrongholdStamper(ws); cache.set(ws, st); if (cache.size > 2) cache.delete(cache.keys().next().value); }
  st.stampChunk(blocks, cx, cz, spawns, states);
}
