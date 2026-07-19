// 13-BOSSES — runtime block-behavior installers (registry blocks are leaves and
// can't reference entity/game logic, so we attach the hooks here, mirroring the
// redstone components.installComponentHooks pattern). Called once at Game init.
import { BLOCKS, B } from '../registry/blocks.js';
import { witherSummonDetector } from '../entities/mobs/Wither.js';

let installed = false;

export function installBossHooks() {
  if (installed) return;
  installed = true;

  // §5/§8.2 — placing a wither_skeleton_skull runs the summon detector.
  BLOCKS[B.WITHER_SKELETON_SKULL].onPlaced = (world, x, y, z) => { witherSummonDetector(world, x, y, z); };

  // §9.1 — a placed beacon must have its block-entity created so it ticks unattended.
  BLOCKS[B.BEACON].onPlaced = (world, x, y, z) => { world.game?.getBlockEntity(x, y, z); };

  // §4 — RMB the dragon egg teleports it (it cannot be mined).
  BLOCKS[B.DRAGON_EGG].onUse = (world, x, y, z) => { teleportEgg(world, x, y, z); return true; };
}

// §4 — reuse the enderman-style seek: up to 16 tries at ±8 x/z, ±4 y; target cell
// must be air (support not required — it falls afterward). Motes at both ends.
export function teleportEgg(world, x, y, z) {
  const rng = world.rng;
  for (let a = 0; a < 16; a++) {
    const tx = x + ((rng() * 17) | 0) - 8;
    const ty = Math.max(1, Math.min(126, y + ((rng() * 9) | 0) - 4));
    const tz = z + ((rng() * 17) | 0) - 8;
    if (world.getBlock(tx, ty, tz) === B.AIR) {
      world.setBlock(x, y, z, B.AIR, { byPlayer: true });
      world.setBlock(tx, ty, tz, B.DRAGON_EGG, { byPlayer: true });
      const g = world.game;
      g?.particles?.effectCloud?.(x + 0.5, y + 0.5, z + 0.5, 0.6, 0xe079fa);
      g?.particles?.effectCloud?.(tx + 0.5, ty + 0.5, tz + 0.5, 0.6, 0xe079fa);
      return true;
    }
  }
  return false;   // §4 — 16 failures: nothing happens
}
