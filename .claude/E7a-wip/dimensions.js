// Multi-dimension engine: registry, per-dim state, the active-dimension rule,
// and the teleport API (10 §2). 11-END plugs into this exact surface.
//
// ============================================================================
// THE DIMENSION CONTRACT — FROZEN by 10-NETHER §2. (AMENDS 01 §4.2/§13.1/§16)
// ============================================================================
//   * Exactly ONE dimension is active (ticked, streamed, meshed, spawned) at a
//     time: `world.activeDim`. Inactive DimensionStates stay resident but are
//     never ticked (§2.3).
//   * IN-MEMORY chunk keys are NOT dim-prefixed: each DimensionState owns its
//     own `chunks` Map, so the map itself is the namespace. Only the shared
//     IndexedDB store is prefixed — `saveKey(dim, "cx,cz") -> "1:5,-3"` (§2.4).
//     Every chunk still carries `chunk.dim` so a cross-dim mixup is detectable.
//   * Every entity carries `dim`. Only entities whose `dim === world.activeDim`
//     tick or render (§2.3).
//   * `changeDimension(entity, targetDim, targetPos, opts)` (§2.5) is the ONE
//     entry point every portal calls. Nether portals (§3) and 11's end portal
//     both route through it; neither may swap `activeDim` itself.
//   * A descriptor field is only legal here if some existing system reads it
//     (§2.1). Adding a dimension is one `registerDimension(id, descriptor)`.
// ============================================================================

import { LightEngine } from './LightEngine.js';
import { ScheduledTicks } from './scheduledTicks.js';
import { Fluids } from './fluids.js';
import { EntityManager } from '../entities/EntityManager.js';
import { forgetFireInDim } from './fire.js';

/** @type {Map<number, object>} id -> descriptor */
export const DIMENSIONS = new Map();

export const DIM_OVERWORLD = 0;
export const DIM_NETHER = 1;
export const DIM_END = 2;

export function registerDimension(id, d) {
  if (DIMENSIONS.has(id)) console.warn('[dim] re-registering dimension', id);
  DIMENSIONS.set(id, { id, ...d });
}

export function getDimension(id) {
  return DIMENSIONS.get(id) ?? DIMENSIONS.get(DIM_OVERWORLD);
}

/** 10 §2.4 — the shared IndexedDB chunk store is the only dim-prefixed keyspace. */
export const saveKey = (dim, key) => dim + ':' + key;

/**
 * 10 §2.4 — legacy overworld records were written as bare "cx,cz" before this
 * file existed. `parseSaveKey` treats an unprefixed key as dim 0 so a v1 world
 * keeps its terrain (AMENDS 01 §16: "if absent, treat legacy `cx,cz` as dim 0").
 */
export function parseSaveKey(k) {
  const i = k.indexOf(':');
  if (i < 0) return { dim: DIM_OVERWORLD, key: k };
  return { dim: +k.slice(0, i), key: k.slice(i + 1) };
}

/**
 * Per-dimension simulation state. Everything in 10 §2.6's "per-dimension"
 * column lives here; the "global" column stays on World/Game.
 */
export class DimensionState {
  constructor(world, scene, id) {
    this.id = id;
    this.desc = getDimension(id);
    this.chunks = new Map();           // "cx,cz" -> Chunk (NOT dim-prefixed — see contract)
    this.light = new LightEngine(world);
    this.scheduled = new ScheduledTicks(world);
    this.fluids = new Fluids(world);
    this.entities = new EntityManager(world, scene);
    this.playerChunk = null;
    this.chunkVersion = 0;
  }
}

/**
 * 10 §2.5 — the single entry point every portal calls.
 *
 * @param entity     the traveller. Only the LOCAL PLAYER swaps `activeDim`
 *                   (§2.3); any other entity is moved into the target
 *                   dimension and frozen there until it activates.
 * @param targetDim  destination dimension id.
 * @param targetPos  {x,y,z} feet position, supplied by the caller (§3.4/§3.5
 *                   for nether portals; 11's fixed platform for the End).
 * @param opts.cooldown  override the §3.6 re-entry cooldown (default 300).
 * @param opts.yaw       facing on arrival.
 */
export async function changeDimension(game, entity, targetDim, targetPos, opts = {}) {
  const world = game.world;
  if (!DIMENSIONS.has(targetDim)) {
    console.warn('[dim] unknown target dimension', targetDim);
    return false;
  }
  const isPlayer = entity === game.player;
  const srcDim = entity.dim ?? DIM_OVERWORLD;

  // --- non-player: move it across and freeze. No activeDim swap (§2.5). ------
  if (!isPlayer) {
    const src = world.dims.get(srcDim);
    const dst = world.ensureDim(targetDim);
    src?.entities.detach(entity);
    entity.dim = targetDim;
    entity.setPos(targetPos.x, targetPos.y, targetPos.z);
    entity.prevPos.x = targetPos.x; entity.prevPos.y = targetPos.y; entity.prevPos.z = targetPos.z;
    entity.vel.x = entity.vel.y = entity.vel.z = 0;
    entity.fallDistance = 0;
    entity.portalCooldown = opts.cooldown ?? 300;
    dst.entities.adopt(entity);
    return true;
  }

  // --- local player: the full swap ------------------------------------------
  // 1. flush the source dimension (§2.5 step 1). Chunks stay RESIDENT (§2.3) —
  //    only their meshes and the streaming queues are torn down.
  game.save?.saveAll(game);
  game.chunkManager.detachDimension(srcDim);
  world.dims.get(srcDim)?.entities.detachAllMeshes();

  // 2. swap. The DimensionState is constructed on first visit and resumed after.
  world.ensureDim(targetDim);
  world.activeDim = targetDim;
  world.dimension = getDimension(targetDim).key;   // music.js:129 reads this
  world.chunkVersion++;                            // invalidate the 1-entry caches

  // 3. place the entity (§2.5 step 3).
  entity.dim = targetDim;
  entity.setPos(targetPos.x, targetPos.y, targetPos.z);
  entity.prevPos.x = targetPos.x; entity.prevPos.y = targetPos.y; entity.prevPos.z = targetPos.z;
  entity.vel.x = entity.vel.y = entity.vel.z = 0;
  entity.fallDistance = 0;
  entity.portalTimer = 0;
  entity.portalCooldown = opts.cooldown ?? 300;
  if (opts.yaw !== undefined) { entity.yaw = opts.yaw; entity.prevYaw = opts.yaw; }

  // 5. re-register in the target EntityManager's spatial index (§2.5 step 5).
  //    `chunkKey` is stale from the source dimension's map — clear it first or
  //    register() early-outs on the unchanged key and never indexes the player.
  entity.chunkKey = null;
  world.dims.get(targetDim).entities.adopt(entity);

  // 2b. stream a GENERATED ring around targetPos behind the loading veil
  //     (§2.5 step 2) before unfreezing.
  await game.streamAround(targetPos.x, targetPos.z);

  // 4. dimension-arrival hook (§2.5 step 4). dim 2 sets onArrive =
  //    regenObsidianPlatform (11).
  getDimension(targetDim).onArrive?.(game, entity, targetPos);

  return true;
}

/** Chunk unload / world dispose must drop that dimension's fire origins (15 §6.4). */
export function onDimensionDisposed(dim) {
  forgetFireInDim(dim);
}
