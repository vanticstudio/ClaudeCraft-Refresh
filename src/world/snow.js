// Snow accumulation + melt (B8 §2, 19-BUILDOUT-v1.3.md).
//
// Contract: during rain in snow-temperature cells a SCHEDULED tick places a
// snow_layer (depth 1) or stacks its state nibble 1→8; during clear weather in
// warm biomes a scheduled tick melts one layer (depth 0 → air). The state
// machine below is a pure function over the world interface so U19 can drive
// accumulate/melt against a mock world (fire.js's fireTick shape).
//
// Layer depth lives in the state nibble. VERIFIED registry contract (blocks.js
// id 40): snow_layer declares NO state semantics — defBlock gives it no
// scheduledTick, no tilesFor, and ChunkMesher renders shape 'snow_layer' as a
// fixed 2/16-high box regardless of state. The nibble is therefore free data:
// this module encodes depth 1..8 there and writes it with { noRemesh: true }
// (the mesher provably cannot change — same justification as fire age, §2.3).
//
// Why a module queue instead of world.scheduled: consumption of the shared
// ScheduledTicks queue goes through World.blockTick, which dispatches by
// REGISTRY id (blk.scheduledTick) — snow_layer's handler would have to be
// added in blocks.js, which this phase may not touch. So the queue below
// mirrors scheduledTicks.js's exact semantics (bucket by due tick, per-bucket
// dedupe, drop when the chunk unloaded, defer 40 t outside SIM_RADIUS) and is
// drained from DayNight.tick.
import { B, STATE_NIBBLE, isSolidSupport } from '../registry/blocks.js';
import { BIOME_TEMPS } from './gen/biomes.js';
import { SIM_RADIUS, chunkKey } from '../constants.js';

// B8 §2 — "state nibble = height 1..8". Gen-placed layers (features.js §10.6)
// carry state 0 (thin base layer); 0 melts in one tick like depth 1.
export const SNOW_MIN = 1;
export const SNOW_MAX = 8;
// 04 §12.4's rain-vs-snow threshold reused as the melt gate — warm side
// (DESERT 2.0 … TAIGA 0.25) melts; SNOWY 0.0 and altitude-cold MOUNTAINS hold.
export const MELT_TEMP = 0.15;

// 15 §2's 30+randInt(0,9) cadence, shortened for a weather-driven op: snow
// ticks re-seed from the per-tick weather roll (snowIceLoop), not from
// themselves, so 20–40 t (1–2 s) keeps layer growth visible over minutes.
export function snowTickDelay(rng) { return 20 + Math.floor(rng() * 21); }

// ---------------------------------------------------------------- state machine

/**
 * Consume one ACCUMULATE tick. `env.snowing` is re-checked at consume time —
 * weather may flip between schedule and due. Returns an outcome tag (U19).
 * 'hold' = clear sky reached a cold cell: snow persists (B8 melts only warm
 * biomes; melting here would erase SNOWY terrain every clear day).
 */
export function snowTick(world, x, y, z, state, env) {
  const id = world.getBlock(x, y, z);
  if (!env?.snowing) return id === B.SNOW_LAYER ? 'hold' : 'noop';
  if (id === B.SNOW_LAYER) {
    const depth = state & STATE_NIBBLE;
    if (depth >= SNOW_MAX) return 'full';
    world.setState(x, y, z, depth + 1, { noRemesh: true });   // mesher ignores depth (see header)
    return 'stack';
  }
  if (id !== B.AIR) return 'noop';            // cell changed since scheduling
  if (!world.canSeeSky(x, y, z)) return 'noop';
  // 04 §12.5's placement gates, re-validated at consume: solid support below,
  // not under strong block light (caves stay bare).
  if (!isSolidSupport(world.getBlock(x, y - 1, z))) return 'noop';
  if (world.getBlockLight(x, y, z) >= 10) return 'noop';
  return world.setBlock(x, y, z, B.SNOW_LAYER, { state: SNOW_MIN }) ? 'place' : 'noop';
}

/**
 * Consume one MELT tick: warm biome (BIOME_TEMPS > MELT_TEMP) + clear sky →
 * one layer off (B8 §2 "melt one layer per random tick"); depth 0/1 → air.
 */
export function snowMeltTick(world, x, y, z, state, env) {
  if (env?.snowing) return 'hold';            // snowing again: freeze the melt
  if (world.getBlock(x, y, z) !== B.SNOW_LAYER) return 'noop';
  if ((BIOME_TEMPS[world.biomeAt(x, z)] ?? 0.8) <= MELT_TEMP) return 'hold';
  const depth = state & STATE_NIBBLE;
  if (depth > SNOW_MIN) {
    world.setState(x, y, z, depth - 1, { noRemesh: true });
    return 'melt';
  }
  world.removeBlock(x, y, z);
  return 'clear';
}

// ---------------------------------------------------------------- queue

// dueTick → Map<key, entry>. Mirrors ScheduledTicks.buckets (01 §6.1).
const buckets = new Map();
// Single live world per page (World facade holds the active dim). A session
// switch (new World over the same module instance) must not replay stale
// ticks into the fresh world — the owner guard drops the whole queue.
let owner = null;

export function scheduleSnowTick(world, x, y, z, delay, mode = 'accumulate') {
  if (owner && owner !== world) { buckets.clear(); }
  owner = world;
  const due = world.time + Math.max(1, delay | 0);
  let b = buckets.get(due);
  if (!b) { b = new Map(); buckets.set(due, b); }
  // dedupe per (cell, mode): accumulate + melt may legally co-pend for one
  // cell when weather flips between schedule and due — each re-validates.
  b.set(x + ',' + y + ',' + z + ':' + mode, { x, y, z, mode });
}

/**
 * Drain every tick due at world.time. Mirrors ScheduledTicks.run()'s rules:
 * unloaded chunk → drop (a resident chunk re-seeds from the weather roll);
 * outside SIM_RADIUS of the player → defer 40 t; else consume the cell.
 * `env.snowing` is sampled once per drain from the live weather machine.
 */
export function tickSnow(world) {
  if (owner && owner !== world) { buckets.clear(); owner = null; }
  owner = world;
  const b = buckets.get(world.time);
  if (!b) return;
  buckets.delete(world.time);
  const env = { snowing: !!world.game?.dayNight?.raining };
  for (const { x, y, z, mode } of b.values()) {
    // 01 §6.1 — a tick whose chunk unloaded has no block to run (same rule,
    // same rationale as scheduledTicks.js:36).
    if (!world.chunks.has(chunkKey(x >> 4, z >> 4))) continue;
    const p = world.playerChunk;
    if (p) {
      const dcx = Math.abs((x >> 4) - p.cx), dcz = Math.abs((z >> 4) - p.cz);
      if (Math.max(dcx, dcz) > SIM_RADIUS) {   // outside sim: defer, don't run
        scheduleSnowTick(world, x, y, z, 40, mode);
        continue;
      }
    }
    if (mode === 'melt') snowMeltTick(world, x, y, z, world.getState(x, y, z), env);
    else snowTick(world, x, y, z, world.getState(x, y, z), env);
  }
}

/** Runtime-only queue (like fire's origin map): safe to drop wholesale. */
export function clearSnowTicks() { buckets.clear(); owner = null; }