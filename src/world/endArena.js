// 11-END §5.5/§5.6 + §6.6 — main-thread End helpers: the fixed obsidian arrival
// platform and the arena export consumed by 13-BOSSES. The dragon fight itself
// (crystals, AI, egg, gateways activation) is 13's; this file owns the statics.
import { BLOCKS, B } from '../registry/blocks.js';

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
