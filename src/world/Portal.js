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
  if (w < MIN_W || w > MAX_W || h < MIN_H || h > MAX_H) return null;
  return cells;
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
  for (const [x, y, z] of res.cells) world.setBlock(x, y, z, PORTAL, { state: res.axis, byPlayer: true });
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
    return (ok(in1) || ok(in2)) && (ok(up) || ok(dn));
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

/** §3.4/§3.5 — compute the scaled destination and change dimension. */
export function initiatePortalTravel(game) {
  const p = game.player;
  const from = game.world.activeDim;
  const targetDim = from === 1 ? 0 : 1;                 // Nether ↔ Overworld
  const srcX = Math.floor(p.pos.x), srcY = Math.floor(p.pos.y), srcZ = Math.floor(p.pos.z);
  const srcKey = linkKey(srcX, srcY, srcZ);
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
  if (link) dimPortalLinks(game, link.fromDim)[link.srcKey] = { x: portal[0], y: portal[1], z: portal[2] };
  return stand;
}

function standCellFor(world, [x, y, z]) {
  // find the portal-column bottom, stand on the obsidian sill in front
  let by = y;
  while (world.getBlock(x, by - 1, z) === PORTAL) by--;
  return { x: x + 0.5, y: by, z: z + 0.5 };
}

/**
 * §3.5 CREATE — build a default portal (interior 2×3, spans X) on a solid
 * obsidian pad near dstY, with a clear standing platform in front so the player
 * never lands in lava/void. Returns the stand cell.
 */
function buildDefaultPortal(game, dstX, dstY, dstZ) {
  const world = game.world;
  const y = Math.max(6, Math.min(118, dstY));
  const set = (x, yy, z, id, st = 0) => world.setBlock(x, yy, z, id, { state: st, byPlayer: true });
  // obsidian floor pad under the whole footprint (frame + platform)
  for (let dx = -1; dx <= 2; dx++) for (let dz = -1; dz <= 2; dz++) set(dstX + dx, y - 1, dstZ + dz, OBSIDIAN);
  // frame: top & bottom rows + left & right columns (interior x = dstX..dstX+1, y..y+2)
  for (let dx = -1; dx <= 2; dx++) { set(dstX + dx, y - 1, dstZ, OBSIDIAN); set(dstX + dx, y + 3, dstZ, OBSIDIAN); }
  for (let dy = -1; dy <= 3; dy++) { set(dstX - 1, y + dy, dstZ, OBSIDIAN); set(dstX + 2, y + dy, dstZ, OBSIDIAN); }
  // interior → portal blocks (axis 0 = spans X)
  for (let dx = 0; dx <= 1; dx++) for (let dy = 0; dy <= 2; dy++) set(dstX + dx, y + dy, dstZ, PORTAL, 0);
  // clear a 2-deep standing platform in front (+Z), floored with obsidian
  for (let dx = -1; dx <= 2; dx++) for (let dz = 1; dz <= 2; dz++) {
    set(dstX + dx, y - 1, dstZ + dz, OBSIDIAN);
    for (let dy = 0; dy <= 2; dy++) set(dstX + dx, y + dy, dstZ + dz, B.AIR);
  }
  return { stand: { x: dstX + 0.5, y, z: dstZ + 1.5 }, portal: [dstX, y, dstZ] };
}
