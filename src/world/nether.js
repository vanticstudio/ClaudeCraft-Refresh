// 10-NETHER — runtime block behaviors (portal collapse §3.3, nether_wart crop
// §8.1, spawner tick §6) attached to block defs at boot so registry/blocks.js
// stays a leaf. Mirrors the redstone/enchanting install pattern.

import { BLOCKS, B } from '../registry/blocks.js';
import { portalNeighborUpdate } from './Portal.js';
import { AABB } from '../math/aabb.js';

let _installed = false;
export function installNetherBehaviors() {
  if (_installed) return;
  _installed = true;

  // §3.3 — portal integrity: a portal cell lacking obsidian/portal support on
  // either in-plane axis collapses the connected region.
  BLOCKS[B.NETHER_PORTAL].neighborUpdate = (w, x, y, z, st) => portalNeighborUpdate(w, x, y, z, st);

  // §8.1 — nether_wart crop: grows 0→3 at 1/10 per random tick while on soul
  // sand (no light gate); pops if the soul sand is removed.
  BLOCKS[B.NETHER_WART].randomTick = (w, x, y, z, st) => {
    if (w.getBlock(x, y - 1, z) !== B.SOUL_SAND) { w.popBlock(x, y, z); return; }
    const stage = st & 3;
    if (stage < 3 && w.rng() < 0.1) w.setState(x, y, z, (st & ~3) | (stage + 1));
  };
  BLOCKS[B.NETHER_WART].neighborUpdate = (w, x, y, z) => {
    if (w.getBlock(x, y - 1, z) !== B.SOUL_SAND) w.popBlock(x, y, z);
  };
}

/**
 * §6.2 — tick a spawner block-entity (called from Game.tickBlockEntities). Only
 * active while a player is within activationRange in the active dimension.
 */
export function tickSpawner(game, be, x, y, z) {
  const d = be.data;
  const p = game.player;
  const dist = Math.hypot(p.pos.x - x - 0.5, p.pos.y - y, p.pos.z - z - 0.5);
  if (dist > d.activationRange) return;
  game.particles?.spawnerFlame?.(x + 0.5, y + 0.5, z + 0.5);
  if (d.delay > 0) { d.delay--; return; }

  const box = new AABB(x - d.spawnRange, y - 1, z - d.spawnRange,
    x + d.spawnRange + 1, y + 2, z + d.spawnRange + 1);
  const nearby = game.world.getEntitiesInBox(box, e => e.type === d.mobType && !e.dead).length;
  if (nearby >= d.maxNearby) { d.delay = randInt(game, d.minDelay, d.maxDelay); return; }

  let spawnedAny = false;
  for (let k = 0; k < d.spawnCount; k++) {
    const tx = x + (game.world.rng() * 2 - 1) * d.spawnRange;
    const ty = y + (Math.floor(game.world.rng() * 3) - 1);
    const tz = z + (game.world.rng() * 2 - 1) * d.spawnRange;
    if (validSpawnCell(game, Math.floor(tx), Math.floor(ty), Math.floor(tz))) {
      game.spawnMobAt(d.mobType, tx + 0.5, ty, tz + 0.5, {});
      spawnedAny = true;
    }
  }
  if (spawnedAny) d.delay = randInt(game, d.minDelay, d.maxDelay);
  else d.delay = 20;
}

function validSpawnCell(game, x, y, z) {
  const w = game.world;
  const feet = w.getBlock(x, y, z), head = w.getBlock(x, y + 1, z), below = w.getBlock(x, y - 1, z);
  return !BLOCKS[feet].collidable && !BLOCKS[head].collidable && BLOCKS[below].collidable;
}
const randInt = (game, lo, hi) => lo + Math.floor(game.world.rng() * (hi - lo + 1));
