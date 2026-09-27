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
import { Sentinel } from './Sentinel.js'; // B12 §3 — "The Hollow" miniboss

export const HOSTILE_TYPES = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'enderman',
  'ghast', 'blaze', 'wither_skeleton', 'magma_cube', 'zombie_villager', 'shulker',
  'sentinel']);   // golem/villager/boss neutral

const CTORS = {
  zombie: Zombie, skeleton: Skeleton, creeper: Creeper, spider: Spider,
  enderman: Enderman, cow: Cow, pig: Pig, sheep: Sheep, chicken: Chicken,
  ghast: Ghast, blaze: Blaze, zombified_piglin: ZombifiedPiglin,
  wither_skeleton: WitherSkeleton, magma_cube: MagmaCube, piglin: Piglin,
  villager: Villager, iron_golem: IronGolem, zombie_villager: ZombieVillager,   // 12-VILLAGES
  shulker: Shulker,   // 11-END §9
  wither: Wither,     // 13-BOSSES §8 (restore path; summoned imperatively)
  sentinel: Sentinel, // B12 §3 — gen-spawned Hollow miniboss
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

// 10-NETHER §7.2 AMENDS 05 §3.2 — per-biome open-biome weights, keyed by the
// dim-1 biome ids written by world/gen/nether.js §4.2 (wastes/crimson/warped/ssv).
const NETHER_SPAWNS = {
  0: [['zombified_piglin', 100], ['ghast', 50], ['magma_cube', 15], ['piglin', 15], ['enderman', 1]],
  1: [['piglin', 100], ['zombified_piglin', 15], ['magma_cube', 2]],
  2: [['enderman', 100]],   // warped forest — the "empty/safe" biome
  3: [['ghast', 50], ['skeleton', 20], ['enderman', 5], ['magma_cube', 2]],
};
// §7.2 fortress-local override (blazes mostly come from the §5.4 spawner).
const NETHER_FORTRESS_SPAWNS = [['wither_skeleton', 40], ['zombified_piglin', 4],
  ['magma_cube', 4], ['blaze', 4]];
// §7.2 pack sizes, inclusive [lo, hi]; 05's mobs keep their overworld sizes.
const NETHER_PACK = {
  ghast: [1, 1], blaze: [2, 3], zombified_piglin: [4, 4], magma_cube: [1, 4],
  wither_skeleton: [1, 2], piglin: [2, 4], enderman: [1, 2],
};
// §7.2 — the shared cap counts the Nether's natural roster including the
// neutral piglins that are its ambient crowd. HOSTILE_TYPES stays the
// sleep-blocking set (05) and is deliberately not widened.
const NETHER_CAPPED = new Set([...HOSTILE_TYPES, 'piglin', 'zombified_piglin']);
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

// 10 §7.2 NETHER_SPAWNABLE — "...any opaque full cube", plus soul_sand, whose
// 14/16 collision box puts it outside the generic 'cube' shape test above.
function netherSpawnableBelow(id) {
  const b = BLOCKS[id];
  return b.opaque && b.opacity === 15 && (b.shape === 'cube' || b.name === 'soul_sand');
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
    // 14 AMENDS 05 §3.2 — cap scales with connected players; wave centre round-robins.
    const cap = game.currentHostileCap ? game.currentHostileCap() : 40;
    if (this.hostileCount() >= cap) return;
    const w = game.world;
    const rng = w.rng;
    // round-robin: wave w → players[w mod count] (14 AMENDS 05 §3.2)
    const roster = (game.players && game.players.length) ? game.players.filter(pl => pl && !pl.dead) : [game.player];
    const wave = Math.floor(w.time / 20);
    const p = roster[wave % roster.length] || game.player;
    // resolve the per-dimension roster; a null spawnTable (overworld) uses the
    // overworld table. 10 §7.2 gives dim 1 its own biome-keyed wave (the
    // fortress gen-spawners supply blazes on top of it, they don't replace it).
    const dimTable = getDimension(w.activeDim)?.spawnTable;
    if (dimTable === 'nether') { this.netherTick(p, cap, rng); return; }
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
      for (let k = 0; k < packSize * 2 && spawned < packSize && this.hostileCount() < cap; k++) {
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

  // 10 §7.2 AMENDS 05 §3.2 — the dim-1 wave. Same geometry as the overworld
  // pass; the substrate, light rule, weights and pack sizes come from §7.2.
  netherTick(p, cap, rng) {
    const w = this.game.world;
    for (let i = 0; i < 8; i++) {
      const ang = rng() * 2 * Math.PI;
      const dist = 24 + rng() * 72;
      const x = Math.floor(p.pos.x + Math.cos(ang) * dist);
      const z = Math.floor(p.pos.z + Math.sin(ang) * dist);
      if (!w.isLoaded(x, z)) continue;
      const top = w.heightTop(x, z);
      if (top <= 1) continue;
      const y = 1 + Math.floor(rng() * Math.min(top, 126));
      // §5.3 puts nether_bricks only inside fortresses, so the ground block is
      // the local test for §7.2's fortress-local override (roster + light ≤ 11).
      const fortress = BLOCKS[w.getBlock(x, y - 1, z)]?.name === 'nether_bricks';
      const table = fortress ? NETHER_FORTRESS_SPAWNS
        : (NETHER_SPAWNS[w.biomeAt(x, z)] ?? NETHER_SPAWNS[0]);
      const rule = { substrate: netherSpawnableBelow, maxLight: fortress ? 11 : 0 };

      const species = weightedPick(rng, table);
      if (!this.validSpawnPos(x, y, z, species, rule)) continue;
      const [lo, hi] = NETHER_PACK[species] ?? [1, 4];
      const packSize = lo + Math.floor(rng() * (hi - lo + 1));
      let spawned = 0, px = x, pz = z;
      for (let k = 0; k < packSize * 2 && spawned < packSize && this.netherCount() < cap; k++) {
        px += Math.floor(rng() * 6) - Math.floor(rng() * 6);
        pz += Math.floor(rng() * 6) - Math.floor(rng() * 6);
        if (this.validSpawnPos(px, y, pz, species, rule)) {
          this.game.spawnMobAt(species, px + 0.5, y, pz + 0.5);
          spawned++;
        }
      }
      if (spawned > 0) return;   // max one successful pack per wave
    }
  }

  netherCount() {
    return this.game.entities.count(e => NETHER_CAPPED.has(e.type));
  }

  // §7.2 — dim 1 has no sky light, so 04 §10.1 reduces to a block-light test:
  // ghasts and magma cubes ignore it entirely, fortress mobs allow ≤ 11.
  canSpawnNetherAt(x, y, z, species, maxLight) {
    if (species === 'ghast' || species === 'magma_cube') return true;
    return this.game.world.getBlockLight(x, y, z) <= maxLight;
  }

  validSpawnPos(x, y, z, species, rule = null) {
    const w = this.game.world;
    if (y < 1 || y > 126) return false;
    const below = w.getBlock(x, y - 1, z);
    if (!(rule ? rule.substrate(below) : spawnableBelow(below))) return false;
    const solidOrLiquid = (bx, by, bz) => {
      const b = BLOCKS[w.getBlock(bx, by, bz)];
      return b.collidable || !!b.fluid;
    };
    if (solidOrLiquid(x, y, z) || solidOrLiquid(x, y + 1, z)) return false;
    // 10 §7.7 — the 2.4 m wither skeleton needs the enderman's 3-cell clearance.
    if ((species === 'enderman' || species === 'wither_skeleton')
      && BLOCKS[w.getBlock(x, y + 2, z)].collidable) return false;
    // 10 §7.1 — the ghast's 4×4 box needs an open pocket or it spawns wedged.
    if (species === 'ghast') {
      for (let dy = 0; dy < 4; dy++)
        for (let dx = -2; dx <= 2; dx++)
          for (let dz = -2; dz <= 2; dz++)
            if (BLOCKS[w.getBlock(x + dx, y + dy, z + dz)].collidable) return false;
    }
    if (species === 'spider') {
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++)
          if (solidOrLiquid(x + dx, y, z + dz)) return false;
    }
    if (!(rule ? this.canSpawnNetherAt(x, y, z, species, rule.maxLight)
      : this.canSpawnHostileAt(x, y, z))) return false;
    // 14 AMENDS 05 §3.2 — ≥24 from EVERY player (nearest), not just the wave centre.
    const near = this.game.nearestPlayerTo?.(x + 0.5, y, z + 0.5) ?? this.game.player;
    if (near) {
      const d = Math.hypot(x + 0.5 - near.pos.x, y - near.pos.y, z + 0.5 - near.pos.z);
      if (d < 24) return false;
    }
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
