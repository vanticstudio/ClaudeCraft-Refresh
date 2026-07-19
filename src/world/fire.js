// Fire spread engine (15 §1–§6). Replaces 06 §5.14's "minimal fire".
//
// Vanilla Java 1.20, Normal difficulty hard-coded (difficulty id = 2 wherever a
// formula consumes it). Every roll uses Math.random(): decision-and-cosmetic RNG
// is allowed outside worldgen (CLAUDE.md §4), and fire MUST NOT draw from
// world.rng — that stream is seeded and shared with weather/worldgen, so
// consuming from it here would desync the simulation.
import { BLOCKS, B, WATERLOGGED, STATE_NIBBLE, effFireEnc, effFireBurn } from '../registry/blocks.js';
import { BIOMES } from './gen/biomes.js';
import { emitSound, at } from '../audio/engine.js';

const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// §6 Safety valve (film-safe spread cap). Set both to Infinity for unbounded
// vanilla behavior — that is the one-line disable the spec promises.
export const FIRE_SAFETY = { RADIUS_CAP: 24, MAX_ACTIVE: 512 };

// posKey -> { ox, oz }. Runtime only, NEVER saved (§6.5): fires hydrated from a
// save have no entry and self-register at their own position on first tick, so
// the 24-block leash re-anchors across reloads.
//
// String keys, not bit-packed ints: world coords span +/-1e6 (01 §4), so packing
// x, y and z into one JS number overflows Number.MAX_SAFE_INTEGER and silently
// aliases distant fires onto each other. The map holds <= MAX_ACTIVE (512)
// entries and is touched once per fire tick (every 30-39 t) — the allocation is
// far below noise, and correctness is not negotiable in a safety valve.
const fireOrigins = new Map();
const posKey = (x, y, z) => `${x},${y},${z}`;

export const fireCount = () => fireOrigins.size;
export function clearFireOrigins() { fireOrigins.clear(); }

/** §6.4 — any fire removal drops its entry. */
export function forgetFire(x, y, z) { fireOrigins.delete(posKey(x, y, z)); }

/** §6.4 — chunk unload drops that chunk's entries. */
export function forgetFireInChunk(cx, cz) {
  for (const key of fireOrigins.keys()) {
    const c = key.split(',');
    if ((+c[0] >> 4) === cx && (+c[2] >> 4) === cz) fireOrigins.delete(key);
  }
}

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

/**
 * §2 — the canonical fire tick delay, 30 + randInt(0,9). Exported because the
 * scheduled-tick bucket is runtime-only (01 §6.1): a chunk hydrated from a save
 * carries the fire id + age but no pending tick, so ChunkManager re-queues one
 * per fire cell with this same delay.
 */
export function fireTickDelay() { return 30 + randInt(0, 9); }

// §2.6 — maps vanilla's increased_fire_burnout tag (jungle/swamp/mushroom/snowy
// slopes/frozen+jagged peaks) onto the two base biomes that plausibly qualify;
// 02's biome set has no jungle or swamp.
const HUMID_BURNOUT_BIOMES = new Set([BIOMES.SNOWY_TUNDRA, BIOMES.MOUNTAINS]);

// ---------------------------------------------------------------- predicates

/** §1.2 — block below is a full solid cube top (chest yes; fence no). */
export function solidTopBelow(world, x, y, z) {
  const id = world.getBlock(x, y - 1, z);
  const b = BLOCKS[id];
  if (!b) return false;
  return b.opaque === true || (b.collidable === true && b.shape === 'cube');
}

/** §1.2 — any of the 6 face neighbors has fireEnc > 0 (bit-7 cells count 0). */
export function anyFlammableNeighbor(world, x, y, z) {
  for (const [dx, dy, dz] of DIRS6) {
    const nx = x + dx, ny = y + dy, nz = z + dz;
    if (effFireEnc(world.getBlock(nx, ny, nz), world.getState(nx, ny, nz)) > 0) return true;
  }
  return false;
}

/** §1.2 canSurvive — solid top below OR any flammable neighbor. */
export function canSurvive(world, x, y, z) {
  return solidTopBelow(world, x, y, z) || anyFlammableNeighbor(world, x, y, z);
}

/** §2.6 — 0 unless the cell is AIR; else the max fireEnc of its 6 neighbors. */
function igniteOdds(world, x, y, z) {
  if (world.getBlock(x, y, z) !== B.AIR) return 0;
  let max = 0;
  for (const [dx, dy, dz] of DIRS6) {
    const e = effFireEnc(world.getBlock(x + dx, y + dy, z + dz), world.getState(x + dx, y + dy, z + dz));
    if (e > max) max = e;
  }
  return max;
}

/**
 * §2.2 — isRainingAt(p) OR isRainingAt any of p's 4 horizontal neighbors.
 * 04 §12.4's predicate already requires canSeeSky + temp > 0.15, so snowfall
 * never douses.
 */
export function isNearRain(world, x, y, z) {
  if (world.isRainingAt(x, y, z)) return true;
  return world.isRainingAt(x + 1, y, z) || world.isRainingAt(x - 1, y, z) ||
         world.isRainingAt(x, y, z + 1) || world.isRainingAt(x, y, z - 1);
}

// ---------------------------------------------------------------- §6 budget

/**
 * §6.3's leash: chebyshev((x,z), origin) <= RADIUS_CAP.
 *
 * Split from the concurrency cap deliberately. §6.3 folds both into one
 * predicate and says a failure must not consume the fuel — but §6 also promises
 * direct ignitions "can't cascade further UNTIL THE COUNT DROPS", and with fuel
 * never consumed at the cap the count cannot drop: on a wool field §2.4a returns
 * early (flammable neighbor) and §2.4b never fires (the floor is fuel), so 512
 * fires would burn eternally and no fire could ever spread again. That is a
 * deadlock, not a plateau.
 *
 * Resolution: the "don't consume" rule is scoped to the RADIUS cap, whose stated
 * rationale is spatial — "the fire front stalls instead of silently deleting the
 * world edge". The concurrency cap gates only the new FIRE (§6: "MAX_ACTIVE only
 * gates new spread fires"), letting fuel burn away so the count drains and §6's
 * own sentence comes true.
 */
function withinLeash(x, z, origin) {
  if (!origin) return true;
  return Math.max(Math.abs(x - origin.ox), Math.abs(z - origin.oz)) <= FIRE_SAFETY.RADIUS_CAP;
}

/** §6 — MAX_ACTIVE gates NEW SPREAD fires only; igniteAt bypasses it entirely. */
function underActiveCap() { return fireOrigins.size < FIRE_SAFETY.MAX_ACTIVE; }

/** The origin this fire cascade is leashed to; undefined if unregistered. */
function originOf(x, y, z) { return fireOrigins.get(posKey(x, y, z)); }

/**
 * §2 placeFire — id 65 + age, schedules the first tick, fires neighbor updates,
 * registers `origin` in the safety valve. Deliberately does NOT pre-check
 * canSurvive: vanilla lets an invalid fire die on its next tick.
 * @param origin packed origin to inherit; omit for a NEW cascade (§6.1) — the
 *               fire then anchors on itself.
 */
export function placeFire(world, x, y, z, age = 0, origin) {
  if (y < 0 || y > 127) return false;
  world.setBlock(x, y, z, B.FIRE, { state: Math.min(15, age) & STATE_NIBBLE });
  fireOrigins.set(posKey(x, y, z), origin ?? { ox: x, oz: z });
  return true;
}

/**
 * §4.1–§4.4 — a DIRECT ignition (flint & steel, lava, lightning, ghast fireball).
 * Always registers a NEW origin at its own cell, and always succeeds regardless
 * of MAX_ACTIVE (§6: "direct player ignition always succeeds").
 */
export function igniteAt(world, x, y, z) {
  if (world.getBlock(x, y, z) !== B.AIR || !canSurvive(world, x, y, z)) return false;
  return placeFire(world, x, y, z, 0);
}

/**
 * §15 — `douse` plays the canonical block.extinguish. The quiet age-out of §2.4
 * is the ONLY silent removal ("NOT on quiet age-out"); §1.3's neighbor-update
 * failure and §2.2's rain douse are both audible.
 */
export function removeFire(world, x, y, z, douse = false) {
  forgetFire(x, y, z);
  world.setBlock(x, y, z, B.AIR);
  if (douse) emitSound('block.extinguish', at(x + 0.5, y + 0.5, z + 0.5));
}

// ---------------------------------------------------------------- §2.5 tryBurn

function tryBurn(world, x, y, z, bound, age, origin) {
  const id = world.getBlock(x, y, z);
  const burn = effFireBurn(id, world.getState(x, y, z));
  if (burn <= 0 || randInt(0, bound - 1) >= burn) return;

  // §6.3: outside the leash the fire is not created AND the fuel is NOT consumed
  // — the front stalls rather than silently deleting the world edge. This gate
  // precedes the burn/replace branch: leaving it inside the placeFire condition
  // would burn an out-of-leash block away anyway.
  if (!withinLeash(x, z, origin)) return;

  const wasTNT = id === B.TNT;
  // At MAX_ACTIVE the fuel still burns (see withinLeash's note) — only the new
  // fire is withheld, so the cascade drains instead of deadlocking.
  if (randInt(0, age + 9) < 5 && !world.isRainingAt(x, y, z) && underActiveCap()) {
    placeFire(world, x, y, z, Math.min(15, age + (randInt(0, 4) >> 2)), origin);  // replaced by fire
  } else {
    // Burns away, no fire left. setBlock to AIR bypasses the loot table, which
    // is exactly vanilla for every fuel here (notably: leaves drop nothing).
    world.setBlock(x, y, z, B.AIR);
  }
  if (wasTNT) world.igniteTnt?.(x, y, z, 80);   // AMENDS 06 §5.6: fire-lit TNT, standard fuse
}

// ---------------------------------------------------------------- §2 fireTick

/** The scheduled-tick handler for id 65. Wired from the registry. */
export function fireTick(world, x, y, z, state) {
  // re-schedule first thing on every run (§2)
  world.scheduleTick(x, y, z, fireTickDelay());

  const age = state & STATE_NIBBLE;
  const below = world.getBlock(x, y - 1, z);
  const infinite = BLOCKS[below]?.infiniteBurn === true;

  // §6.5 — a fire hydrated from a save has no entry; self-register so the leash
  // re-anchors at the load position.
  let origin = originOf(x, y, z);
  if (origin === undefined) {
    origin = { ox: x, oz: z };
    fireOrigins.set(posKey(x, y, z), origin);
  }

  // -- 2.1 survival --
  if (!canSurvive(world, x, y, z)) { removeFire(world, x, y, z); return; }

  // -- 2.2 rain (skipped on eternal fire — rain never kills it, vanilla) --
  // 20% at age 0 ... 65% at age 15
  if (!infinite && isNearRain(world, x, y, z) && Math.random() < 0.2 + age * 0.03) {
    removeFire(world, x, y, z, true);      // §15: audible douse (approx — vanilla rain-out is silent)
    return;
  }

  // -- 2.3 aging: +1 with chance 1/3 --
  // `newAge` is written to state and NOTHING ELSE. Every decision below reads
  // the PRE-tick `age` — that is deliberate in §2 and it is vanilla:
  // FireBlock#tick stores j but passes i to checkBurnOut and to the spread odds.
  // Driving §2.4/§2.5/§2.6 off newAge instead shifts every probability on the
  // ~1/3 of ticks that bump the age.
  const newAge = Math.min(15, age + (randInt(0, 2) >> 1));
  if (newAge !== age) {
    // §2.3: "no remesh needed (texture ageless)" — the fire tile is
    // age-independent, so skip the remesh dirtying a normal state write does.
    world.setState(x, y, z, (state & 0xF0) | newAge, { noRemesh: true });
  }

  if (!infinite) {
    // -- 2.4a barren burnout --
    if (!anyFlammableNeighbor(world, x, y, z)) {
      if (!solidTopBelow(world, x, y, z) || age > 3) removeFire(world, x, y, z);
      return;                          // no neighbors -> never spreads (vanilla early-return)
    }
    // -- 2.4b old-age burnout --
    if (age === 15 && randInt(0, 3) === 0 && (BLOCKS[below]?.fireBurn ?? 0) === 0) {
      removeFire(world, x, y, z);
      return;
    }
  }

  const humid = HUMID_BURNOUT_BIOMES.has(world.biomeAt(x, z));
  const k = humid ? -50 : 0;

  // -- 2.5 consume the 6 neighbors (vanilla checkBurnOut, exact order) --
  tryBurn(world, x + 1, y, z, 300 + k, age, origin);
  tryBurn(world, x - 1, y, z, 300 + k, age, origin);
  tryBurn(world, x, y - 1, z, 250 + k, age, origin);
  tryBurn(world, x, y + 1, z, 250 + k, age, origin);
  tryBurn(world, x, y, z + 1, 300 + k, age, origin);
  tryBurn(world, x, y, z - 1, 300 + k, age, origin);

  // -- 2.6 propagate into air: 3x3 column, y-1 .. y+4 --
  // The volume is anchored on the FIRE block, not its fuel: interposed
  // non-flammable blocks do NOT shield cells above (vanilla).
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 4; dy++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const tx = x + dx, ty = y + dy, tz = z + dz;
        if (ty < 0 || ty > 127) continue;
        const bound = 100 + (dy > 1 ? (dy - 1) * 100 : 0);
        const enc = igniteOdds(world, tx, ty, tz);
        if (enc <= 0) continue;
        let odds = Math.floor((enc + 54) / (age + 30));   // Normal difficulty: +40+7*2 = +54
        if (humid) odds = Math.floor(odds / 2);
        if (odds > 0 && randInt(0, bound - 1) <= odds && !isNearRain(world, tx, ty, tz) &&
            withinLeash(tx, tz, origin) && underActiveCap()) {
          placeFire(world, tx, ty, tz, Math.min(15, age + (randInt(0, 4) >> 2)), origin);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- §4.2 lava

/**
 * Lava's randomTick fire-creation attempt. Vanilla-exact (§4.2): both source and
 * flowing cells get this.
 */
export function lavaFireAttempt(world, x, y, z) {
  const i = randInt(0, 2);
  if (i > 0) {
    // walk upward i steps; each step moves (randInt(-1,1), +1, randInt(-1,1))
    let cx = x, cy = y, cz = z;
    for (let step = 0; step < i; step++) {
      cx += randInt(-1, 1); cy += 1; cz += randInt(-1, 1);
      if (cy < 0 || cy > 127) return;
      const id = world.getBlock(cx, cy, cz);
      if (id === B.AIR) {
        if (hasLavaIgniteNeighbor(world, cx, cy, cz)) {
          if (canSurvive(world, cx, cy, cz)) igniteAt(world, cx, cy, cz);
          return;
        }
      } else if (BLOCKS[id]?.collidable) {
        return;                        // the cell blocks motion -> stop
      }
    }
  } else {
    // 3 attempts at (randInt(-1,1), 0, randInt(-1,1)): if that block is
    // lavaIgnite and the cell above it is air -> place fire above it
    for (let n = 0; n < 3; n++) {
      const tx = x + randInt(-1, 1), tz = z + randInt(-1, 1);
      const id = world.getBlock(tx, y, tz);
      if ((world.getState(tx, y, tz) & WATERLOGGED) === 0 && BLOCKS[id]?.lavaIgnite &&
          world.getBlock(tx, y + 1, tz) === B.AIR) {
        igniteAt(world, tx, y + 1, tz);
      }
    }
  }
}

/** §4.2 — any of 6 faces is lavaIgnite; bit-7 cells excluded (§13.3). */
function hasLavaIgniteNeighbor(world, x, y, z) {
  for (const [dx, dy, dz] of DIRS6) {
    const nx = x + dx, ny = y + dy, nz = z + dz;
    if ((world.getState(nx, ny, nz) & WATERLOGGED) !== 0) continue;
    if (BLOCKS[world.getBlock(nx, ny, nz)]?.lavaIgnite) return true;
  }
  return false;
}

// ---------------------------------------------------------------- §4.3 lightning

/**
 * AMENDS 04 §12.6 — fire at the strike cell if canSurvive, then 4 extra attempts
 * at randInt(-1,1) per axis, each placed only if air + canSurvive. Each
 * registers a new ignition origin (§6).
 */
export function lightningIgnite(world, x, y, z) {
  igniteAt(world, x, y, z);
  for (let n = 0; n < 4; n++) {
    igniteAt(world, x + randInt(-1, 1), y + randInt(-1, 1), z + randInt(-1, 1));
  }
}
