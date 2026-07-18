// 11-END §5.5/§5.6 + §6.6 — main-thread End helpers: the fixed obsidian arrival
// platform and the arena export consumed by 13-BOSSES. The dragon fight itself
// (crystals, AI, egg, gateways activation) is 13's; this file owns the statics.
import { BLOCKS, B } from '../registry/blocks.js';
import { endPillars, endGatewayPositions } from './gen/endShared.js';

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
  const gy = 75, w = game.world;
  // bedrock bipyramid: tips (0,±2,0) + plus-rings at y ±1 (10 cells; y=0 stays open)
  const shell = [[0, 2, 0], [0, -2, 0],
    [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
    [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]];
  for (const [dx, dy, dz] of shell) w.setBlock(gx + dx, gy + dy, gz + dz, B.BEDROCK, { byPlayer: true });
  w.setBlock(gx, gy, gz, B.END_GATEWAY, { byPlayer: true });
  return { x: gx, y: gy, z: gz };
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
