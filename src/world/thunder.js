// Thunder (B8 §1, 19-BUILDOUT-v1.3.md).
//
// Replaces DayNight's 04 §12.6 lightning loop: one 1/20000 roll per tick while
// rainLevel > 0.6 (B8's gate — heavy rain, not merely the thundering flag),
// strike at a random surface cell within 64 blocks of the player (heightTop).
// Effects per spec: 2-tick white flash on DayNight's existing flash/ambient
// path, a thin particle column as the bolt, fire at the strike cell through
// fire.js's igniteAt (canSurvive-checked), and 5 damage (fire type) to living
// entities within 3 blocks of the strike column.
//
// RNG discipline: the roll and target offsets draw from world.rng — the seeded
// stream the weather machine already owns (04 §12.1's randInt/snowIceLoop/
// lightningLoop all draw from it). fire.js's ban on world.rng applies to FIRE
// spread, which must not perturb weather/worldgen streams; thunder IS weather.
// Cosmetic scatter (particle velocities) uses Math.random, allowed outside
// worldgen (CLAUDE.md §4 precedent in fire.js's header).
//
// Boom delay: emitSound has no caller-side delay parameter (audio/engine.js
// starts every voice at t0 + 5 ms), but the EXISTING 'weather.thunder' recipe
// (audio/events.js, 16 §3.5) schedules its rumble at t0 + dist·0.06 from the
// engine-measured strike distance (`distanceOnly`) — the delayed boom is the
// recipe's own job, so thunder reuses the event unchanged (deviation note: the
// recipe's scaled 0.06 s/m delay law stands in for the raw distance/343).
import { AABB } from '../math/aabb.js';
import { LivingEntity } from '../entities/Entity.js';
import { igniteAt } from './fire.js';
import { emitSound, at } from '../audio/engine.js';

// B8 §1 — per-tick strike chance and strike radius.
export const STRIKE_CHANCE = 1 / 20000;
export const STRIKE_RANGE = 64;
// Entity burn duration after a strike — 04 §12.6's 160 t (8 s) carries over.
const BURN_TICKS = 160;

// Pure: does this tick's roll produce a strike? (U19 determinism entry.)
export function rollStrike(rng) { return rng() < STRIKE_CHANCE; }

/**
 * Pure: pick the strike target. Chebyshev square ±STRIKE_RANGE around (px, pz),
 * y from the column's heightTop (first cell that sees sky — the strike lands
 * on the surface, exactly where 04 §12.6 struck). Returns null for an
 * unloaded/out-of-range column (heightTop reads 0 there) — the roll is spent,
 * like the old loop's `continue`.
 * `heightTopAt` is injected so U19 can drive it with a fixed stub world.
 */
export function pickStrikeCell(rng, heightTopAt, px, pz) {
  const span = STRIKE_RANGE * 2 + 1;
  const x = px + Math.floor(rng() * span) - STRIKE_RANGE;
  const z = pz + Math.floor(rng() * span) - STRIKE_RANGE;
  const y = heightTopAt(x, z);
  if (!(y > 0) || y > 127) return null;
  return { x, y, z };
}

/**
 * Scheduling entry — DayNight.tick (host/singleplayer sim; Game.tick §4.1
 * clients never run dayNight) when rainLevel > 0.6 and the dimension has sky.
 */
export function weatherTick(dn) {
  const w = dn.world;
  if (!rollStrike(w.rng)) return;
  const p = w.playerChunk;
  if (!p) return;
  const pp = dn.game?.player?.pos;
  if (!pp) return;
  const cell = pickStrikeCell(w.rng, (x, z) => w.heightTop(x, z),
    Math.floor(pp.x), Math.floor(pp.z));
  if (!cell) return;
  strike(dn, cell.x, cell.y, cell.z);
}

/**
 * The strike bundle (B8 §1). `dn` is the DayNight instance: flash() rides its
 * existing flashTicks → updateRender white-out + ambient spike.
 */
export function strike(dn, x, y, z) {
  dn.flash(2);                       // B8: 2 ticks (04 §12.6's strike used 3)
  // delayed boom: distanceOnly recipe measures the distance to this position
  // and schedules crack + rumble off it (16 §3.5)
  emitSound('weather.thunder', at(x + 0.5, y + 0.5, z + 0.5));
  boltParticles(dn.game?.particles, x, y, z);
  // 15 §4.1 — direct ignition; igniteAt's own AIR + canSurvive gate decides
  // (ocean strikes rightly fizzle). Single cell per B8 (04's 5-attempt
  // lightningIgnite spread is not used by this path).
  igniteAt(dn.world, x, y, z);
  // B8 §1 — 5 damage, fire type, within 3 blocks of the strike column
  // (04 §12.6's 10-damage 'lightning' box replaced by this spec line).
  const box = new AABB(x - 3, y - 3, z - 3, x + 3, y + 3, z + 3);
  for (const e of dn.world.getEntitiesInBox(box, ent => ent instanceof LivingEntity && !ent.dead)) {
    e.hurt(5, 'fire');
    e.setOnFire(BURN_TICKS);         // 05 §14 ignition path (Player: Fire Protection cut)
  }
}

// Thin bright column + base burst (B8 §1 bolt visual). Spawn signature mirrors
// entities/mobs/Shulker.js:308 — spawn(handle, x, y, z, vx, vy, vz, life, grav).
function boltParticles(particles, x, y, z) {
  const p = particles;
  if (!p) return;
  for (let k = 0; k < 10; k++) {
    p.spawn(p.colored(0xf4f8ff, 0.08), x + 0.5, y + 1 + k * 1.8, z + 0.5,
      (Math.random() - 0.5) * 0.02, 0, (Math.random() - 0.5) * 0.02,
      6 + ((Math.random() * 4) | 0), 0);
  }
  for (let i = 0; i < 6; i++) {
    p.spawn(p.colored(0xf4f8ff, 0.1), x + 0.5, y + 0.2, z + 0.5,
      (Math.random() - 0.5) * 0.14, Math.random() * 0.1, (Math.random() - 0.5) * 0.14,
      8, 0.02);
  }
}