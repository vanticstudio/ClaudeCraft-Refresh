// Mob factory + hostile runtime spawn cycle (05 §3).
import { BLOCKS, B } from '../../registry/blocks.js';
import { Zombie } from './Zombie.js';
import { Skeleton } from './Skeleton.js';
import { Creeper } from './Creeper.js';
import { Spider } from './Spider.js';
import { Enderman } from './Enderman.js';
import { Cow, Pig, Sheep, Chicken } from './passive.js';

export const HOSTILE_TYPES = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'enderman']);

const CTORS = {
  zombie: Zombie, skeleton: Skeleton, creeper: Creeper, spider: Spider,
  enderman: Enderman, cow: Cow, pig: Pig, sheep: Sheep, chicken: Chicken,
};

export function createMob(world, type, x, y, z, opts = {}) {
  const Ctor = CTORS[type];
  if (!Ctor) { console.warn('[mobs] unknown type', type); return null; }
  const mob = new Ctor(world, x, y, z, opts);
  if (opts.persistent) mob.persistent = true;
  mob.yaw = world.rng() * Math.PI * 2;
  mob.prevYaw = mob.yaw;
  return mob;
}

// spawn weights (05 §3.2, MC exact)
const SPAWN_WEIGHTS = [
  ['zombie', 95], ['skeleton', 100], ['creeper', 100], ['spider', 100], ['enderman', 10],
];
const WEIGHT_TOTAL = SPAWN_WEIGHTS.reduce((s, [, w]) => s + w, 0);

function weightedPick(rng) {
  let r = rng() * WEIGHT_TOTAL;
  for (const [type, w] of SPAWN_WEIGHTS) {
    if (r < w) return type;
    r -= w;
  }
  return 'zombie';
}

// spawnable ground: any opaque full-cube terrain block EXCEPT glass/leaves
function spawnableBelow(id) {
  const b = BLOCKS[id];
  return b.opaque && b.shape === 'cube' && b.opacity === 15;
}

export class MobSpawner {
  constructor(game) {
    this.game = game;
  }

  hostileCount() {
    return this.game.entities.count(e => HOSTILE_TYPES.has(e.type));
  }

  tick() {
    const game = this.game;
    if (game.world.time % 20 !== 0) return;   // one wave per second (adaptation)
    if (this.hostileCount() >= 40) return;
    const w = game.world;
    const rng = w.rng;
    const p = game.player;

    for (let i = 0; i < 8; i++) {
      const ang = rng() * 2 * Math.PI;
      const dist = 24 + rng() * 72;
      const x = Math.floor(p.pos.x + Math.cos(ang) * dist);
      const z = Math.floor(p.pos.z + Math.sin(ang) * dist);
      if (!w.isLoaded(x, z)) continue;
      const top = w.heightTop(x, z);
      if (top <= 1) continue;
      const y = 1 + Math.floor(rng() * top);
      if (!this.validSpawnPos(x, y, z, null)) continue;

      const species = weightedPick(rng);
      const packSize = species === 'enderman' ? 1 + Math.floor(rng() * 2) : 1 + Math.floor(rng() * 4);
      let spawned = 0;
      let px = x, pz = z;
      for (let k = 0; k < packSize * 2 && spawned < packSize && this.hostileCount() < 40; k++) {
        px += Math.floor(rng() * 6) - Math.floor(rng() * 6);
        pz += Math.floor(rng() * 6) - Math.floor(rng() * 6);
        if (this.validSpawnPos(px, y, pz, species)) {
          game.spawnMobAt(species, px + 0.5, y, pz + 0.5);
          spawned++;
        }
      }
      if (spawned > 0) return;   // max one successful pack per wave
    }
  }

  validSpawnPos(x, y, z, species) {
    const w = this.game.world;
    if (y < 1 || y > 126) return false;
    if (!spawnableBelow(w.getBlock(x, y - 1, z))) return false;
    const solidOrLiquid = (bx, by, bz) => {
      const b = BLOCKS[w.getBlock(bx, by, bz)];
      return b.collidable || !!b.fluid;
    };
    if (solidOrLiquid(x, y, z) || solidOrLiquid(x, y + 1, z)) return false;
    if (species === 'enderman' && BLOCKS[w.getBlock(x, y + 2, z)].collidable) return false;
    if (species === 'spider') {
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++)
          if (solidOrLiquid(x + dx, y, z + dz)) return false;
    }
    if (!this.canSpawnHostileAt(x, y, z)) return false;
    const p = this.game.player;
    const d = Math.hypot(x + 0.5 - p.pos.x, y - p.pos.y, z + 0.5 - p.pos.z);
    if (d < 24) return false;
    return true;
  }

  // 04 §10.1 verbatim
  canSpawnHostileAt(x, y, z) {
    const w = this.game.world;
    const rng = w.rng;
    const sky = w.getSkyLight(x, y, z);
    if (sky > Math.floor(rng() * 32)) return false;
    if (w.getBlockLight(x, y, z) !== 0) return false;
    const thundering = this.game.dayNight?.isThunderstorm;
    const skyCapped = thundering ? Math.min(sky, 10) : sky;
    const spawnLight = Math.max(w.getBlockLight(x, y, z), skyCapped - w.skyDarken);
    return spawnLight <= Math.floor(rng() * 8);
  }
}
