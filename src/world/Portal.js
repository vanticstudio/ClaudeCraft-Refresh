// 10-NETHER §3 — Nether portals: frame validation + ignition, the transfer
// timer, 8:1 coordinate scaling, and destination find-or-build.

import { BLOCKS, B } from '../registry/blocks.js';
import { getDimension, changeDimension } from './dimensions.js';
import { END_SPAWN } from './endArena.js';
import { emitSound, at } from '../audio/engine.js';

const OBSIDIAN = B.OBSIDIAN;          // 33
const PORTAL = B.NETHER_PORTAL;       // 140
const MAX_W = 21, MAX_H = 21, MIN_W = 2, MIN_H = 3;
const SEARCH_RADIUS = 128;            // §3.5 destination search radius (horizontal)

// §3.6 per-dimension portal-link cache. Lives in game.dimMeta[dim].data so it
// round-trips through the save. A forward fast-path keyed by the source portal
// cell; the 128-block search below is the pairing backstop for return trips.
function dimPortalLinks(game, dim) {
  game.dimMeta = game.dimMeta ?? {};
  const d = (game.dimMeta[dim] = game.dimMeta[dim] ?? {});
  d.data = d.data ?? {};
  return (d.data.portalLinks = d.data.portalLinks ?? {});
}
const linkKey = (x, y, z) => x + ',' + y + ',' + z;

/**
 * §3.1 — validate a portal frame containing the air cell (sx,sy,sz), trying both
 * the X-plane (frame spans X, faces ±Z) and Z-plane. Returns { ok, axis, cells }
 * where axis 0 = spans X (state bit0 = 0), 1 = spans Z (bit0 = 1).
 */
export function validateFrame(world, sx, sy, sz) {
  for (const axis of [0, 1]) {
    // in-plane horizontal step: axis 0 → ±X, axis 1 → ±Z. Vertical is always ±Y.
    const stepH = axis === 0 ? [1, 0, 0] : [0, 0, 1];
    const r = floodInterior(world, sx, sy, sz, stepH);
    if (r) return { ok: true, axis, cells: r };
  }
  return { ok: false };
}

function isFrame(world, x, y, z) {
  const id = world.getBlock(x, y, z);
  return id === OBSIDIAN;
}
function isInterior(world, x, y, z) {
  const id = world.getBlock(x, y, z);
  return id === B.AIR || id === PORTAL;
}

/**
 * BFS the interior air region in a vertical plane (horizontal axis = stepH,
 * vertical = Y). Escapes (a non-obsidian, non-interior neighbour) → fail.
 * Returns the interior cell list on success, else null.
 */
function floodInterior(world, sx, sy, sz, stepH) {
  const seen = new Set();
  const cells = [];
  const stack = [[sx, sy, sz]];
  let minX = sx, maxX = sx, minY = sy, maxY = sy, minZ = sz, maxZ = sz;
  const key = (x, y, z) => x + ',' + y + ',' + z;
  seen.add(key(sx, sy, sz));
  const neighbours = [
    [stepH[0], stepH[1], stepH[2]], [-stepH[0], -stepH[1], -stepH[2]],
    [0, 1, 0], [0, -1, 0],
  ];
  while (stack.length) {
    const [x, y, z] = stack.pop();
    if (!isInterior(world, x, y, z)) return null;   // interior must be air/portal
    cells.push([x, y, z]);
    if (cells.length > MAX_W * MAX_H) return null;   // way too big → not a frame
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    for (const [dx, dy, dz] of neighbours) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (isFrame(world, nx, ny, nz)) continue;      // bounded by obsidian → good edge
      const k = key(nx, ny, nz);
      if (seen.has(k)) continue;
      if (!isInterior(world, nx, ny, nz)) return null; // escaped (open frame)
      seen.add(k); stack.push([nx, ny, nz]);
    }
  }
  const w = (stepH[0] ? maxX - minX : maxZ - minZ) + 1;
  const h = maxY - minY + 1;
  // §3.1 wants "a vertical RECTANGLE of obsidian enclosing an air interior", with
  // the sides and the top & bottom rows obsidian "for the interior's full span".
  // The bounding-box test alone accepted any obsidian-bounded cavity whose bbox
  // fits, so an L-shaped pocket (one corner plugged) ignited as a portal.
  if (cells.length !== w * h) return null;
  if (w < MIN_W || w > MAX_W || h < MIN_H || h > MAX_H) return null;
  return cells;
}

/**
 * §3.1/§3.3 — write every interior cell with neighbour updates SUPPRESSED, then
 * notify once over the finished region.
 *
 * A per-cell setBlock fans out World.neighborUpdates, which runs §3.3's collapse
 * check against a half-built portal: mid-fill a cell legitimately has air on both
 * in-plane sides, so every frame with interior width ≥ 4 wiped itself during its
 * own ignition (4×3 → 3 of 12 cells survived, 10×10 → 15 of 100) and could never
 * be repaired — nether_portal is hardness −1, unmineable and explosion-proof.
 * setBlock's `noUpdates` branch starts AFTER the light edit and the remesh
 * dirtying, so emission 11 and the mesh are unaffected; only onPlaced, fluid /
 * gravity scheduling, neighbour updates and the redstone fan-out are skipped,
 * none of which a portal cell needs.
 */
function fillPortal(world, cells, axis) {
  for (const [x, y, z] of cells) {
    world.setBlock(x, y, z, PORTAL, { state: axis, byPlayer: true, noUpdates: true });
  }
  for (const [x, y, z] of cells) world.neighborUpdates(x, y, z);
}

/**
 * §3.2 — try to ignite a portal from a flint_and_steel RMB against obsidian.
 * `hit` = { x,y,z (the clicked obsidian), face:[fx,fy,fz] }. The candidate air
 * cell is the clicked face's outward cell. Returns true if a portal was lit.
 */
export function tryIgnitePortal(game, hit) {
  const world = game.world;
  if (world.getBlock(hit.x, hit.y, hit.z) !== OBSIDIAN) return false;
  const ax = hit.x + hit.face[0], ay = hit.y + hit.face[1], az = hit.z + hit.face[2];
  if (!isInterior(world, ax, ay, az)) return false;
  const res = validateFrame(world, ax, ay, az);
  if (!res.ok) return false;
  fillPortal(world, res.cells, res.axis);
  emitSound('block.portal.trigger', at(ax + 0.5, ay + 0.5, az + 0.5));
  return true;
}

/**
 * §3.3 collapse rule — a portal cell with no obsidian and no same-axis portal on
 * either in-plane neighbour collapses the whole connected portal region to air.
 */
export function portalNeighborUpdate(world, x, y, z, state) {
  const axis = state & 1;
  const stepH = axis === 0 ? [1, 0, 0] : [0, 0, 1];
  const supported = cell => {
    const in1 = world.getBlock(cell[0] + stepH[0], cell[1], cell[2] + stepH[2]);
    const in2 = world.getBlock(cell[0] - stepH[0], cell[1], cell[2] - stepH[2]);
    const up = world.getBlock(cell[0], cell[1] + 1, cell[2]);
    const dn = world.getBlock(cell[0], cell[1] - 1, cell[2]);
    const ok = id => id === OBSIDIAN || id === PORTAL;
    // §3.3 / §15 gate E7 — "breaking one frame obsidian collapses the portal".
    // The old `(in1 || in2) && (up || dn)` can never fail on an INTACT portal:
    // every cell always keeps a portal or obsidian on one in-plane side and one
    // vertical side, so a lit portal was permanently indestructible (hardness −1,
    // targetable:false, skipped by Game.explode). All four sides are required.
    // Corner obsidian stays optional — corners are diagonal from every portal
    // cell and never fire a neighbour update.
    return ok(in1) && ok(in2) && ok(up) && ok(dn);
  };
  if (supported([x, y, z])) return;
  // collapse the connected portal region
  const seen = new Set([x + ',' + y + ',' + z]);
  const stack = [[x, y, z]];
  while (stack.length) {
    const [cx, cy, cz] = stack.pop();
    if (world.getBlock(cx, cy, cz) !== PORTAL) continue;
    world.setBlock(cx, cy, cz, B.AIR, { byPlayer: true });
    for (const [dx, dy, dz] of [[stepH[0], 0, stepH[2]], [-stepH[0], 0, -stepH[2]], [0, 1, 0], [0, -1, 0]]) {
      const k = (cx + dx) + ',' + (cy + dy) + ',' + (cz + dz);
      if (!seen.has(k)) { seen.add(k); stack.push([cx + dx, cy + dy, cz + dz]); }
    }
  }
}

/**
 * §3.4 — the transfer timer, driven from Player.tick. Accumulates while the
 * player's feet cell (or head) overlaps a portal and portalCooldown is 0; fires
 * at 80 ticks.
 */
const TRANSFER_AT = 80;
const END_PORTAL = B.END_PORTAL;   // 162
export function tickPortal(game) {
  // §2.3 — dimension change is HOST-AUTHORITATIVE. A client runs its own
  // Player.tick inside the predictor AND once per unacked input in the reconcile
  // replay, so the timer raced ahead and the client drove a local
  // changeActiveDimension the host never saw: flushAllChunks with no terrain
  // workers, then STATE.LOADING with no host-driven exit — a permanent veil.
  if (game.net?.isClient) return;
  const p = game.player;
  if (p.portalCooldown > 0) { p.portalCooldown--; p.portalTimer = 0; return; }
  // 11-END §5.4 — the end portal is INSTANT (no stand-in delay).
  if (playerInEndPortal(game, p)) { initiateEndTravel(game); return; }
  const inPortal = playerInPortal(game, p);
  if (inPortal) {
    p.portalTimer = Math.min((p.portalTimer || 0) + 1, TRANSFER_AT);
    if (p.portalTimer >= TRANSFER_AT) { p.portalTimer = 0; initiatePortalTravel(game); }
  } else {
    p.portalTimer = 0;
  }
}

function playerInPortal(game, p) {
  const world = game.world;
  const x = Math.floor(p.pos.x), z = Math.floor(p.pos.z);
  for (let dy = 0; dy <= 1; dy++) {
    if (world.getBlock(x, Math.floor(p.pos.y) + dy, z) === PORTAL) return true;
  }
  return false;
}

function playerInEndPortal(game, p) {
  const world = game.world;
  const x = Math.floor(p.pos.x), z = Math.floor(p.pos.z);
  for (let dy = 0; dy <= 1; dy++) {
    if (world.getBlock(x, Math.floor(p.pos.y) + dy, z) === END_PORTAL) return true;
  }
  return false;
}

/**
 * 11-END §5.4 — end-portal travel. Overworld→End lands on the fixed obsidian
 * platform (onArrive rebuilds it); End→Overworld returns to the player's bed
 * spawn else world spawn. changeDimension applies its own re-entry cooldown.
 */
export function initiateEndTravel(game) {
  const p = game.player;
  if (game.world.activeDim === 2) {
    const rp = p.spawnPoint ?? game.worldSpawn ?? { x: 0, y: 64, z: 0 };
    changeDimension(p, 0, { x: rp.x + 0.5, y: rp.y, z: rp.z + 0.5 });
  } else {
    changeDimension(p, 2, { x: END_SPAWN.x, y: END_SPAWN.y, z: END_SPAWN.z });
  }
}

/**
 * §3.6 — normalise a portal cell to its region's minimum corner (walk −Y, then
 * the negative in-plane direction). The link cache is specified as "which
 * destination portal a given SOURCE PORTAL built"; keying it on the player's
 * floored position meant even a minimum 4×5 frame had 6 distinct keys and one
 * more per feet-Y, so a round trip essentially never hit the cache.
 */
function portalAnchor(world, x, y, z) {
  if (world.getBlock(x, y, z) !== PORTAL) return null;
  const axis = world.getState(x, y, z) & 1;             // 0 = spans X, 1 = spans Z
  const sx = axis === 0 ? 1 : 0, sz = axis === 0 ? 0 : 1;
  let ay = y;
  while (world.getBlock(x, ay - 1, z) === PORTAL) ay--;
  let ax = x, az = z;
  while (world.getBlock(ax - sx, ay, az - sz) === PORTAL) { ax -= sx; az -= sz; }
  return [ax, ay, az];
}

// §3.5 — the 1-second #e0a0ff spawn-in burst at the SOURCE endpoint (the arrival
// endpoint fires from Game's dimension-change completion).
function portalBurst(game, x, y, z) {
  const ps = game.particles;
  if (!ps?.spawn || !ps.colored) return;
  for (let i = 0; i < 20; i++) {
    ps.spawn(ps.colored(0xe0a0ff, 0.08), x + (Math.random() - 0.5), y + Math.random() * 1.8,
      z + (Math.random() - 0.5), 0, 0.02, 0, 20, 0);
  }
}

/** §3.4/§3.5 — compute the scaled destination and change dimension. */
export function initiatePortalTravel(game) {
  const p = game.player;
  const from = game.world.activeDim;
  const targetDim = from === 1 ? 0 : 1;                 // Nether ↔ Overworld
  const srcX = Math.floor(p.pos.x), srcY = Math.floor(p.pos.y), srcZ = Math.floor(p.pos.z);
  const anchor = portalAnchor(game.world, srcX, srcY, srcZ)
    ?? portalAnchor(game.world, srcX, srcY + 1, srcZ)
    ?? [srcX, srcY, srcZ];
  const srcKey = linkKey(anchor[0], anchor[1], anchor[2]);
  let dstX, dstZ, dstY;
  const cached = dimPortalLinks(game, from)[srcKey];    // §3.6 reuse the paired portal
  if (cached) {
    dstX = cached.x; dstY = cached.y; dstZ = cached.z;
  } else {
    if (targetDim === 1) { dstX = Math.floor(srcX / 8); dstZ = Math.floor(srcZ / 8); }
    else { dstX = srcX * 8; dstZ = srcZ * 8; }
    dstY = Math.max(5, Math.min(118, srcY));
  }
  // stash the target (+ the source link) so the loading-gate build can pair them
  game.pendingPortalBuild = { dim: targetDim, x: dstX, y: dstY, z: dstZ, axis: 0, fromDim: from, srcKey };
  portalBurst(game, p.pos.x, p.pos.y, p.pos.z);         // §3.5 source-side motes
  changeDimension(p, targetDim, { x: dstX + 0.5, y: dstY, z: dstZ + 0.5 });
}

/**
 * §3.5 — find-or-create a portal near (dstX,dstY,dstZ) in the now-active dim,
 * returning a safe stand cell. Called AFTER the ring has streamed (from the
 * loading-gate completion), so blocks are present.
 */
export function findOrCreatePortal(game, dstX, dstY, dstZ, link = null) {
  const world = game.world;
  // 1. SEARCH loaded chunks within a 128-block horizontal radius (§3.5) for the
  //    nearest existing portal. Scans block arrays directly — runs once per
  //    travel behind the loading veil, so the full sweep is cheap.
  let best = null, bestD = Infinity;
  for (const c of world.chunks.values()) {
    if (!c.blocks) continue;
    const baseX = c.cx << 4, baseZ = c.cz << 4;
    if (baseX - dstX > SEARCH_RADIUS || dstX - (baseX + 15) > SEARCH_RADIUS) continue;
    if (baseZ - dstZ > SEARCH_RADIUS || dstZ - (baseZ + 15) > SEARCH_RADIUS) continue;
    const blocks = c.blocks;
    for (let i = 0; i < 32768; i++) {
      if (blocks[i] !== PORTAL) continue;
      const x = baseX + (i & 15), z = baseZ + ((i >> 4) & 15), y = i >> 8;
      const ddx = x - dstX, ddz = z - dstZ;
      if (Math.abs(ddx) > SEARCH_RADIUS || Math.abs(ddz) > SEARCH_RADIUS) continue;
      const ddy = y - dstY;
      const d = ddx * ddx + ddy * ddy + ddz * ddz;
      if (d < bestD) { bestD = d; best = [x, y, z]; }
    }
  }
  let stand, portal;
  if (best) { stand = standCellFor(world, best); portal = best; }
  // 2. CREATE a default 4×5 frame (spans X, faces ±Z) at a safe spot near dstY
  else { const r = buildDefaultPortal(game, dstX, dstY, dstZ); stand = r.stand; portal = r.portal; }
  // §3.6 — record the forward link so a repeat trip from the same source portal
  // reuses this exact destination (return trips fall back to the search above).
  if (link) {
    const a = portalAnchor(world, portal[0], portal[1], portal[2]) ?? portal;
    dimPortalLinks(game, link.fromDim)[link.srcKey] = { x: a[0], y: a[1], z: a[2] };
  }
  return stand;
}

function standCellFor(world, [x, y, z]) {
  // find the portal-column bottom
  let by = y;
  while (world.getBlock(x, by - 1, z) === PORTAL) by--;
  // §3.5 step 1 — "a safe stand cell ADJACENT to that portal (feet on the frame
  // bottom, facing into it)". Returning the portal cell itself means an arrival
  // who stands still is still inside it when portalCooldown 300 drains, so the
  // timer re-arms and bounces him back 19 s later. Step one cell out along the
  // portal's facing normal (axis 0 spans X and faces ±Z, axis 1 the reverse).
  const axis = world.getState(x, by, z) & 1;
  const nx = axis === 0 ? 0 : 1, nz = axis === 0 ? 1 : 0;
  const free = id => !BLOCKS[id]?.collidable;
  for (const s of [1, -1]) {
    const sx = x + nx * s, sz = z + nz * s;
    if (free(world.getBlock(sx, by, sz)) && free(world.getBlock(sx, by + 1, sz)) &&
        BLOCKS[world.getBlock(sx, by - 1, sz)]?.collidable) {
      return { x: sx + 0.5, y: by, z: sz + 0.5 };
    }
  }
  return { x: x + 0.5, y: by, z: z + 0.5 };   // nothing safe on either side
}

/**
 * §3.5 CREATE — build a default portal (interior 2×3, spans X) on a solid
 * obsidian pad near dstY, with a clear standing platform in front so the player
 * never lands in lava/void. Returns the stand cell.
 */
// §3.5 step 2 — candidate build columns, nearest first ("score by |y − dstY|
// then distance to dstXZ"), sweeping outward to the same 128-block radius the
// search uses. Module scope: no per-travel allocation.
const BUILD_OFFSETS = (() => {
  const o = [[0, 0]];
  for (const r of [4, 8, 12, 16, 24, 32, 48, 64, 96, 128]) {
    o.push([r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]);
  }
  return o;
})();

/**
 * The volume buildDefaultPortal writes (pad + 4×5 frame + 4×2×3 platform),
 * padded by one cell so lava ADJACENT to the carved pocket cannot flow back in.
 * Bedrock only disqualifies where we actually write — the shell may legally sit
 * inside the floor/roof slab.
 */
function siteClear(world, ax, ay, az) {
  for (let dx = -2; dx <= 3; dx++) {
    for (let dz = -2; dz <= 3; dz++) {
      for (let dy = -2; dy <= 4; dy++) {
        const id = world.getBlock(ax + dx, ay + dy, az + dz);
        if (id === B.LAVA) return false;
        if (id === B.BEDROCK && dx >= -1 && dx <= 2 && dz >= -1 && dz <= 2 && dy >= -1 && dy <= 3) return false;
      }
    }
  }
  return true;
}

/** Best y in one column: the first hit walking outward from y0 is the min |Δy|. */
function columnSite(world, ax, az, y0) {
  for (let d = 0; d <= 112; d++) {
    if (y0 + d <= 118 && siteClear(world, ax, y0 + d, az)) return y0 + d;
    if (d > 0 && y0 - d >= 6 && siteClear(world, ax, y0 - d, az)) return y0 - d;
  }
  return -1;
}

function findBuildSite(world, dstX, dstY, dstZ) {
  const y0 = Math.max(6, Math.min(118, dstY));
  let best = null;
  for (const [ox, oz] of BUILD_OFFSETS) {
    const ax = dstX + ox, az = dstZ + oz;
    if (!world.isLoaded(ax - 2, az - 2) || !world.isLoaded(ax + 3, az + 3)) continue;
    const ay = columnSite(world, ax, az, y0);
    if (ay < 0) continue;
    const score = Math.abs(ay - y0), dist = Math.abs(ox) + Math.abs(oz);
    if (!best || score < best.score || (score === best.score && dist < best.dist)) {
      best = { x: ax, y: ay, z: az, score, dist };
    }
    if (best.score <= 2) break;                    // near enough to dstY; stop
  }
  return best;
}

function buildDefaultPortal(game, dstX, dstY, dstZ) {
  const world = game.world;
  // §3.5 step 2 requires the site scan; stamping at the raw scaled coordinate
  // dropped the arrival into the lava sea (Nether y 15–20 is ~90% lava), inside
  // a 4×2×3 air pocket that dim-1 FAST_LAVA refilled in about a second while
  // portalCooldown 300 blocked the way back.
  const site = findBuildSite(world, dstX, dstY, dstZ);
  const x0 = site ? site.x : dstX, z0 = site ? site.z : dstZ;
  const y = site ? site.y : Math.max(6, Math.min(118, dstY));
  const set = (x, yy, z, id, st = 0) => world.setBlock(x, yy, z, id, { state: st, byPlayer: true });
  // Nothing qualified anywhere in range: keep the placement but wall the whole
  // footprint AND its one-block shell in obsidian first, so fluids.wake has no
  // lava source left to re-flow from (§15 "never in bedrock roof/floor or
  // mid-lava").
  if (!site) {
    for (let dx = -2; dx <= 3; dx++) for (let dz = -2; dz <= 3; dz++) for (let dy = -2; dy <= 4; dy++) {
      if (world.getBlock(x0 + dx, y + dy, z0 + dz) === B.LAVA) set(x0 + dx, y + dy, z0 + dz, OBSIDIAN);
    }
  }
  // obsidian floor pad under the whole footprint (frame + platform)
  for (let dx = -1; dx <= 2; dx++) for (let dz = -1; dz <= 2; dz++) set(x0 + dx, y - 1, z0 + dz, OBSIDIAN);
  // frame: top & bottom rows + left & right columns (interior x = x0..x0+1, y..y+2)
  for (let dx = -1; dx <= 2; dx++) { set(x0 + dx, y - 1, z0, OBSIDIAN); set(x0 + dx, y + 3, z0, OBSIDIAN); }
  for (let dy = -1; dy <= 3; dy++) { set(x0 - 1, y + dy, z0, OBSIDIAN); set(x0 + 2, y + dy, z0, OBSIDIAN); }
  // interior → portal blocks (axis 0 = spans X). Deferred notify (fillPortal):
  // with §3.3's strict four-sided support rule a per-cell fan-out would collapse
  // the region before the second column is written.
  const cells = [];
  for (let dx = 0; dx <= 1; dx++) for (let dy = 0; dy <= 2; dy++) cells.push([x0 + dx, y + dy, z0]);
  fillPortal(world, cells, 0);
  // clear a 2-deep standing platform in front (+Z), floored with obsidian
  for (let dx = -1; dx <= 2; dx++) for (let dz = 1; dz <= 2; dz++) {
    set(x0 + dx, y - 1, z0 + dz, OBSIDIAN);
    for (let dy = 0; dy <= 2; dy++) set(x0 + dx, y + dy, z0 + dz, B.AIR);
  }
  return { stand: { x: x0 + 0.5, y, z: z0 + 1.5 }, portal: [x0, y, z0] };
}
