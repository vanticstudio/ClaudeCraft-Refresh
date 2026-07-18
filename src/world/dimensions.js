// 10-NETHER §2 — the multi-dimension engine (registry + teleport API).
//
// FROZEN CONTRACT — 11-END builds on exactly this surface:
//   registerDimension(id, descriptor)   — add a dimension (ids never overlap)
//   getDimension(id) → descriptor
//   changeDimension(entity, targetDim, targetPos, opts) — the single teleport door
//
// This build uses the SINGLE-ACTIVE-DIMENSION model (§2.3's endorsed
// simplification): one live World/ChunkManager/EntityManager set. Changing
// dimension flushes the active dim's chunks to disk (dim-prefixed keys), swaps
// `world.activeDim`, and re-streams the target through the loading veil.
// Inactive dimensions live on disk and hydrate on return (the spec explicitly
// allows this). A descriptor is pure data + flags every existing system reads.

import { regenObsidianPlatform } from './endArena.js';

const DIMENSIONS = new Map();

export function registerDimension(id, descriptor) { DIMENSIONS.set(id, descriptor); }
export function getDimension(id) { return DIMENSIONS.get(id); }
export function allDimensions() { return DIMENSIONS; }

// Sky descriptors (§13). The renderer reads `kind` + colors; the Nether has no
// dome/sun/moon/stars/clouds, a flat fog-colored void, and dense short fog.
export const OVERWORLD_SKY = { kind: 'overworld' };
export const NETHER_SKY = {
  kind: 'nether',
  fogColor: 0x330808,          // nether_wastes default; per-biome tint applied live
  fogNear: 0.0, fogFar: 0.55,  // §13.1 claustrophobic
  clearColor: 0x330808,
};
// 11-END §7 — static void-purple sky: gradient zenith #100A18 → horizon #1B1426,
// fog #14101E, faint grain. No sun/moon/stars/clouds/day-cycle.
export const END_SKY = {
  kind: 'end',
  fogColor: 0x14101E,
  fogNear: 0.0, fogFar: 1.0,   // ×128 render-distance far (§7)
  clearColor: 0x14101E,
  zenith: 0x100A18, horizon: 0x1B1426,
};

// dim 0 — Overworld (02 owns gen). Registered here so the registry is complete
// from boot; the worker keys gen by dim id, so `gen` is informational main-side.
registerDimension(0, {
  id: 0, key: 'overworld',
  minY: 0, maxY: 127, bedrockRoof: false, ceilingY: 127,
  hasSkyLight: true, ambientLight: 0.00,
  sky: OVERWORLD_SKY,
  scale: 1, evaporatesWater: false, explodesBeds: false, lavaFast: false,
  spawnTable: null,
});

// dim 1 — Nether (§4). 8:1 horizontal scale, no sky light, exploding beds, fast
// lava, water evaporates.
registerDimension(1, {
  id: 1, key: 'nether',
  minY: 0, maxY: 127, bedrockRoof: true, ceilingY: 127,
  hasSkyLight: false, ambientLight: 0.10,
  sky: NETHER_SKY,
  scale: 8, evaporatesWater: true, explodesBeds: true, lavaFast: true,
  spawnTable: 'nether',        // §7.2 — resolved by the spawner
});
// dim 2 — The End (11-END §7). No sky light, static purple sky, no bed sleep,
// enderman-only spawns; arrival rebuilds the fixed obsidian platform (§5.5/§5.6).
registerDimension(2, {
  id: 2, key: 'the_end',
  minY: 0, maxY: 127, bedrockRoof: false, ceilingY: 127,
  hasSkyLight: false, ambientLight: 0.10,   // §7 brightness floor ≈ light level 3
  sky: END_SKY,
  scale: 1, evaporatesWater: false, explodesBeds: false, lavaFast: false,
  noSleep: true,               // §7 — "You may not rest here" (no explosion)
  spawnTable: 'end',           // §6.5 enderman-only wave
  onArrive: regenObsidianPlatform,
});

/**
 * §2.5 — the single dimension-change entry point every portal calls.
 * `targetPos` is supplied by the caller (Nether §3.5 computes it; End uses a
 * fixed platform). Non-player entities move + freeze into the target dim; only
 * the local player swaps the active dimension.
 */
export function changeDimension(entity, targetDim, targetPos, opts = {}) {
  const game = entity.world?.game;
  if (!game) return;
  const isLocalPlayer = entity === game.player;

  if (!isLocalPlayer) {
    // A mob/item that walked into a portal: it serializes into the target dim and
    // freezes until that dim activates. We just retag + reposition it; since the
    // target dim isn't resident, remove it from the live world.
    entity.dim = targetDim;
    entity.portalCooldown = 300;
    entity.dead = true;   // frozen: it will re-hydrate from disk when the dim loads
    return;
  }

  game.changeActiveDimension(targetDim, targetPos, opts);
}
