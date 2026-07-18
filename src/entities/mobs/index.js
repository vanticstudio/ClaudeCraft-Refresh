// Mob factory + hostile runtime spawn cycle (05 §3).
import { BLOCKS, B } from '../../registry/blocks.js';
import { getDimension } from '../../world/dimensions.js';
import { Zombie } from './Zombie.js';
import { Skeleton } from './Skeleton.js';
import { Creeper } from './Creeper.js';
import { Spider } from './Spider.js';
import { Enderman } from './Enderman.js';
import { Cow, Pig, Sheep, Chicken } from './passive.js';
// 10-NETHER §7 — the six Nether mobs.
import { Ghast } from './nether/Ghast.js';
import { Blaze, ZombifiedPiglin, WitherSkeleton, MagmaCube, Piglin } from './nether/mobs.js';
import { Villager, IronGolem, ZombieVillager } from './villager.js';
import { Shulker } from './Shulker.js';   // 11-END §9
import { Wither } from './Wither.js';     // 13-BOSSES §8

export const HOSTILE_TYPES = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'enderman',
  'ghast', 'blaze', 'wither_skeleton', 'magma_cube', 'zombie_villager', 'shulker']);   // golem/villager/boss neutral

const CTORS = {
  zombie: Zombie, skeleton: Skeleton, creeper: Creeper, spider: Spider,
  enderman: Enderman, cow: Cow, pig: Pig, sheep: Sheep, chicken: Chicken,
  ghast: Ghast, blaze: Blaze, zombified_piglin: ZombifiedPiglin,
  wither_skeleton: WitherSkeleton, magma_cube: MagmaCube, piglin: Piglin,
  villager: Villager, iron_golem: IronGolem, zombie_villager: ZombieVillager,   // 12-VILLAGES
  shulker: Shulker,   // 11-END §9
  wither: Wither,     // 13-BOSSES §8 (restore path; summoned imperatively)
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

// spawn weights (05 §3.2, MC exact). Dimension-keyed per the descriptor's
// spawnTable (11-END AMENDS 05 §3.2 — dim 2 is enderman-only).
const SPAWN_TABLES = {
  overworld: [['zombie', 95], ['skeleton', 100], ['creeper', 100], ['spider', 100], ['enderman', 10]],
  end: [['enderman', 1]],   // §6.5 sole entry
};
function weightedPick(rng, table) {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [type, w] of table) { if (r < w) return type; r -= w; }
  return table[0][0];
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
    // resolve the per-dimension roster; a null spawnTable (overworld) uses the
    // overworld table. The Nether roster comes from fortress gen-spawners, not
    // the wave — so a nether table falls back to no wave spawns (skip).
    const dimTable = getDimension(w.activeDim)?.spawnTable;
    if (dimTable === 'nether') return;   // §7.2 — nether uses gen-spawners, not the wave
    const table = SPAWN_TABLES[dimTable === 'end' ? 'end' : 'overworld'];

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

      let species = weightedPick(rng, table);
      // 12-VILLAGES AMENDS 05 §3.2 — 5% of spawned zombies become zombie villagers.
      if (species === 'zombie' && rng() < 0.05) species = 'zombie_villager';
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
