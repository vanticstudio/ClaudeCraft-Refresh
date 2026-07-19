// 11-END §5.5/§5.6 + §6.6 — main-thread End helpers: the fixed obsidian arrival
// platform and the arena export consumed by 13-BOSSES. The dragon fight itself
// (crystals, AI, egg, gateways activation) is 13's; this file owns the statics.
import { BLOCKS, B } from '../registry/blocks.js';
import { endPillars, endGatewayPositions } from './gen/endShared.js';
import { endSurfaceAt } from './gen/endSurface.js';
import { hashString, mix32 } from '../math/rng.js';

// §6.4 — the exit portal ("end fountain"), centered (0,0), rim + column at Y 63.
export const EXIT_Y = 63;
export const EXIT_PORTAL = {
  center: { x: 0, z: 0 }, topY: EXIT_Y,
  // §7.11 — the 4 cardinal bedrock rim cells where the respawn-ritual crystals sit
  // (crystal spawns on top, at Y 64).
  rimCells: [{ x: 2, z: 0 }, { x: -2, z: 0 }, { x: 0, z: 2 }, { x: 0, z: -2 }],
};
// §7.9 — the dragon-egg pedestal: atop the central bedrock column (0, 63..66).
export const EGG_CELL = { x: 0, y: EXIT_Y + 4, z: 0 };

// §6.3/§6.6 — the 10 obsidian pillars for this seed as {x,z,topY,caged,crystal}.
export function pillarPositions(worldSeed) {
  return endPillars(worldSeed).map(p => ({ x: p.x, z: p.z, topY: p.capY, caged: p.caged, crystal: p.crystal }));
}

// §7.9 — fill the 8 portal-bed cells at Y 63 with end_portal (idempotent).
export function activateExitPortal(game) {
  const w = game.world;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (dx === 0 && dz === 0) continue;   // center is the bedrock column
    w.setBlock(dx, EXIT_Y, dz, B.END_PORTAL, { byPlayer: true });
  }
}

// §11.2 — place the n-th seeded gateway (radius-96 circle, Y 75): the end_gateway
// block + its 12-bedrock bipyramid shell (y=0 sides left open — the pearl gap).
export function spawnGateway(game, worldSeed, n) {
  const positions = endGatewayPositions(worldSeed);
  if (n < 0 || n >= positions.length) return null;
  const { x: gx, z: gz } = positions[n];
  placeGatewayShell(game.world, gx, 75, gz);
  return { x: gx, y: 75, z: gz };
}

// §11.2 — the same 12-bedrock structure is reused for the far-side return gateway.
function placeGatewayShell(w, gx, gy, gz) {
  // bedrock bipyramid: tips (0,±2,0) + plus-rings at y ±1 (10 cells; y=0 stays open)
  const shell = [[0, 2, 0], [0, -2, 0],
    [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
    [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]];
  for (const [dx, dy, dz] of shell) w.setBlock(gx + dx, gy + dy, gz + dz, B.BEDROCK, { byPlayer: true });
  w.setBlock(gx, gy, gz, B.END_GATEWAY, { byPlayer: true });
}

// §7.11 — rebuild pillar k (obsidian cylinder + bedrock cap + air clearance + cage).
// Main-thread mirror of the worker's buildSpike (idempotent).
export function regenerateSpike(game, worldSeed, k) {
  const p = endPillars(worldSeed)[k];
  if (!p) return;
  const w = game.world, R = p.r, H = p.capY;
  for (let dx = -R - 1; dx <= R + 1; dx++) for (let dz = -R - 1; dz <= R + 1; dz++) {
    if (dx * dx + dz * dz > R * R + 1) continue;
    for (let y = 0; y < H; y++) w.setBlock(p.x + dx, y, p.z + dz, B.OBSIDIAN, { byPlayer: true });
    for (let y = H + 1; y <= H + 10; y++) w.setBlock(p.x + dx, y, p.z + dz, B.AIR, { byPlayer: true });
  }
  w.setBlock(p.x, H, p.z, B.BEDROCK, { byPlayer: true });
  if (p.caged) {
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let y = H; y <= H + 3; y++) {
      const wall = (Math.abs(dx) === 2 || Math.abs(dz) === 2) && y < H + 3;
      if (wall || y === H + 3) w.setBlock(p.x + dx, y, p.z + dz, B.IRON_BARS, { byPlayer: true });
    }
  }
}

// §5.5 — the fixed arrival platform: 5×5 obsidian, top Y=48, centered (100,0).
export const PLATFORM = { cx: 100, cz: 0, y: 48 };
// §5.5 — player spawns feet at (100.5, 49, 0.5) facing −X (toward the island).
export const END_SPAWN = { x: PLATFORM.cx + 0.5, y: PLATFORM.y + 1, z: PLATFORM.cz + 0.5, yaw: Math.PI / 2 };

// §5.6 onArrive hook. The descriptor calls this the moment the player is retagged
// into dim 2 — but that is BEFORE any chunk streams (world.chunks is empty), so we
// only raise a flag; Game's loading gate builds the platform once the ring exists.
export function regenObsidianPlatform(player) {
  const game = player.world?.game;
  if (game) game.pendingEndArrival = true;
}

// Build/refresh the platform + clear the 3 cell-layers above (popping any block
// there as its item drop). Called from Game's loading gate after chunks stream.
export function buildObsidianPlatform(game) {
  const w = game.world;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const x = PLATFORM.cx + dx, z = PLATFORM.cz + dz;
      w.setBlock(x, PLATFORM.y, z, B.OBSIDIAN, { byPlayer: true });
      for (let dy = 1; dy <= 3; dy++) {
        const y = PLATFORM.y + dy;
        const id = w.getBlock(x, y, z);
        if (id !== 0) {
          const blk = BLOCKS[id];
          const drops = blk.drops ? blk.drops.call(blk, { toolClass: null, toolTier: null, rng: () => 0.5, fortune: 0, state: 0 }) : [];
          for (const d of drops) game.spawnItemByName?.(d.name, d.count, x + 0.5, y + 0.5, z + 0.5);
          w.setBlock(x, y, z, B.AIR, { byPlayer: true });
        }
      }
    }
  }
}

// ==========================================================================
// §11.2 — end gateway teleport. Driven from EndFight.tick (dim 2 only, every
// tick). The link table lives in dimMeta[2].gateways so it persists and so the
// far end can be recorded while its chunks are still 1000+ blocks away.
// ==========================================================================

// §8.1's outer-island surface is a pure function of the seed, so a gateway's far
// side is resolvable BEFORE the destination chunks stream. Same substreams as
// the End generator (gen/end.js) so both agree on where land is.
const endSub = (ws, name) => mix32(ws ^ hashString('end:' + name));
function outerSeeds(worldSeed) {
  const ws = typeof worldSeed === 'number' ? (worldSeed >>> 0) : hashString(String(worldSeed ?? ''));
  return { outer: endSub(ws, 'outer'), outerT: endSub(ws, 'outer_t') };
}

const CHUNK_SAMPLES = [[4, 4], [4, 12], [12, 4], [12, 12]];

export function tickGateways(game, worldSeed) {
  const w = game.world;
  if (w.activeDim !== 2) return;
  game.dimMeta = game.dimMeta ?? {};
  const meta = (game.dimMeta[2] = game.dimMeta[2] ?? {});
  const store = (meta.gateways = meta.gateways ?? { links: [], pending: null });
  const p = game.player;
  if (p && p.gatewayCooldown > 0) p.gatewayCooldown--;

  if (store.pending) { resolveArrival(game, store, p); return; }
  if (!p || p.dead || p.gatewayCooldown > 0) return;

  // A thrown pearl entering the cell is cancelled (no self-damage, no pearl
  // teleport) and the THROWER travels instead.
  for (const e of game.entities.entities.values()) {
    if (e.dead || e.type !== 'thrown_ender_pearl') continue;
    const cell = gatewayCellAt(w, e);
    if (!cell) continue;
    e.dead = true;
    if (e.owner === p) { enterGateway(game, worldSeed, store, p, cell); return; }
  }
  const cell = gatewayCellAt(w, p);
  if (cell) enterGateway(game, worldSeed, store, p, cell);
}

/** The gateway cell an entity's AABB overlaps, or null. */
function gatewayCellAt(w, e) {
  const box = e.getAABB();
  const x0 = Math.floor(box.min[0]), x1 = Math.floor(box.max[0]);
  const y0 = Math.floor(box.min[1]), y1 = Math.floor(box.max[1]);
  const z0 = Math.floor(box.min[2]), z1 = Math.floor(box.max[2]);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
    if (w.getBlock(x, y, z) === B.END_GATEWAY) return { x, y, z };
  }
  return null;
}

function findPartner(store, cell) {
  for (const l of store.links) {
    if (l.a.x === cell.x && l.a.y === cell.y && l.a.z === cell.z) return l.b;
    if (l.b.x === cell.x && l.b.y === cell.y && l.b.z === cell.z) return l.a;
  }
  return null;
}

function enterGateway(game, worldSeed, store, traveler, cell) {
  let partner = findPartner(store, cell);
  const pending = { build: null, platform: null, land: null };
  if (!partner) {
    // First use: resolve the far side, then link both ends.
    let exit = gatewayExit(worldSeed, cell.x, cell.z);
    if (!exit) {
      // An all-void ray forces a 5×5 end_stone platform at 1024·u, Y 60.
      const len = Math.hypot(cell.x, cell.z) || 1;
      const px = Math.round(cell.x / len * 1024), pz = Math.round(cell.z / len * 1024);
      exit = { x: px, y: 61, z: pz };
      pending.platform = { x: px, y: 60, z: pz };
    }
    partner = { x: exit.x + 4, y: exit.y + 8, z: exit.z };
    store.links.push({ a: { x: cell.x, y: cell.y, z: cell.z }, b: partner });
    pending.build = partner;
    const be = game.getBlockEntity?.(cell.x, cell.y, cell.z);
    if (be?.data) be.data.partner = partner;
  }
  pending.land = partner;
  // Provisional drop = §11.2's fallback landing (2 above the partner gateway).
  // resolveArrival snaps onto the real landing point once the far chunks exist.
  pending.hold = { x: partner.x + 0.5, y: partner.y + 2, z: partner.z + 0.5 };
  store.pending = pending;
  placeTraveler(traveler, pending.hold.x, pending.hold.y, pending.hold.z);
}

function resolveArrival(game, store, traveler) {
  const w = game.world;
  const g = store.pending.land;
  if (!traveler || !w.isLoaded(g.x, g.z)) {
    // Hold the traveler in place until the far side streams — otherwise they
    // drift down through the not-yet-generated column into the void.
    const h = store.pending.hold;
    if (traveler && h) placeTraveler(traveler, h.x, h.y, h.z);
    return;
  }
  const pf = store.pending.platform;
  if (pf) {
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++)
      w.setBlock(pf.x + dx, pf.y, pf.z + dz, B.END_STONE, { byPlayer: true });
  }
  if (store.pending.build) {
    placeGatewayShell(w, g.x, g.y, g.z);
    const be = game.getBlockEntity?.(g.x, g.y, g.z);
    if (be?.data) be.data.partner = findPartner(store, g);
  }
  const land = gatewayLanding(w, g);
  placeTraveler(traveler, land.x, land.y, land.z);
  store.pending = null;
}

function placeTraveler(t, x, y, z) {
  t.setPos(x, y, z);
  t.prevPos.x = t.pos.x; t.prevPos.y = t.pos.y; t.prevPos.z = t.pos.z;
  t.vel.x = t.vel.y = t.vel.z = 0;
  t.fallDistance = 0;
  t.gatewayCooldown = 40;   // §11.2 — no instant re-trigger on arrival
}

/**
 * §11.2 — the vanilla landing search: the 11×11 columns within radius 5 of the
 * partner gateway (NW corner first, +Z then +X), each scanned from the world top
 * down, skipping every cell adjacent (incl. diagonals/above/below) to the gateway
 * block. Feet go on top of the first non-bedrock full block. Fallback: 2 blocks
 * above the gateway itself.
 */
function gatewayLanding(w, g) {
  for (let dx = -5; dx <= 5; dx++) {
    for (let dz = -5; dz <= 5; dz++) {
      const x = g.x + dx, z = g.z + dz;
      for (let y = 127; y >= 0; y--) {
        if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && Math.abs(y - g.y) <= 1) continue;
        const id = w.getBlock(x, y, z);
        if (id === B.AIR) continue;
        const blk = BLOCKS[id];
        if (id !== B.BEDROCK && blk?.collidable && blk?.opaque) return { x: x + 0.5, y: y + 1, z: z + 0.5 };
        break;   // first non-air column hit is unusable — try the next column
      }
    }
  }
  return { x: g.x + 0.5, y: g.y + 2, z: g.z + 0.5 };
}

/**
 * §11.2 — direction u = normalize(gx,gz); scan d 1024→768 in 16-block steps, then
 * 1040→1400, for a chunk with any end-stone column (§8.1 test at its 4 sample
 * columns). Returns the column nearest d·u with land, feet-Y = surface+1, or null.
 */
function gatewayExit(worldSeed, gx, gz) {
  const s = outerSeeds(worldSeed);
  const len = Math.hypot(gx, gz) || 1;
  const ux = gx / len, uz = gz / len;
  const dists = [];
  for (let d = 1024; d >= 768; d -= 16) dists.push(d);
  for (let d = 1040; d <= 1400; d += 16) dists.push(d);
  for (const d of dists) {
    const tx = ux * d, tz = uz * d;
    const cx = Math.floor(tx) >> 4, cz = Math.floor(tz) >> 4;
    let hasLand = false;
    for (const [sx, sz] of CHUNK_SAMPLES) {
      if (endSurfaceAt(s, cx * 16 + sx, cz * 16 + sz) != null) { hasLand = true; break; }
    }
    if (!hasLand) continue;
    let best = null, bd = Infinity;
    for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
      const wx = cx * 16 + lx, wz = cz * 16 + lz;
      const surf = endSurfaceAt(s, wx, wz);
      if (surf == null) continue;
      const dd = (wx + 0.5 - tx) ** 2 + (wz + 0.5 - tz) ** 2;
      if (dd < bd) { bd = dd; best = { x: wx, y: surf + 1, z: wz }; }
    }
    if (best) return best;
  }
  return null;
}
