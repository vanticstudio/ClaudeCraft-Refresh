// 13-BOSSES §9 — Beacon logic. The pyramid/sky/effect rules are pure functions
// the orchestrator calls from Game.tickBeacon and the beacon GUI. §9.6's beam
// mesh is owned here too: pyramidLevels is the one call the block-entity tick
// makes per beacon, so it (re)creates the beam, and each beam tears ITSELF down
// from its render callback — a broken beacon stops ticking entirely, so nothing
// else could ever retire its beam.
import * as THREE from 'three';
import { B, BLOCKS } from '../registry/blocks.js';
import { EFFECT, addEffect } from '../status/effects.js';

// §9.2 — a pyramid tier is built from any of these mineral blocks.
const MINERALS = new Set([
  B.IRON_BLOCK, B.GOLD_BLOCK, B.DIAMOND_BLOCK, B.EMERALD_BLOCK, B.NETHERITE_BLOCK,
]);

/**
 * §9.2 — highest complete pyramid tier under the beacon base at (bx,by,bz).
 * Tier L occupies the (2L+1)² square at y = by-L; the first incomplete tier
 * caps the count. Returns 0..4.
 */
export function pyramidLevels(world, bx, by, bz) {
  const levels = computeLevels(world, bx, by, bz);
  syncBeam(world, bx, by, bz, levels);   // §9.6 — see the beam block below
  return levels;
}

function computeLevels(world, bx, by, bz) {
  for (let L = 1; L <= 4; L++) {
    const y = by - L;
    for (let dx = -L; dx <= L; dx++) {
      for (let dz = -L; dz <= L; dz++) {
        if (!MINERALS.has(world.getBlock(bx + dx, y, bz + dz))) return L - 1;
      }
    }
  }
  return 4;
}

/**
 * §9.3 — the beacon sees the sky iff no opaque block sits in the column above
 * it (by+1 .. 127). Bedrock (17) is treated as transparent so a world ceiling
 * does not block the beam.
 */
export function skyClear(world, bx, by, bz) {
  for (let y = by + 1; y <= 127; y++) {
    const id = world.getBlock(bx, y, bz);
    if (id === 17) continue;                 // bedrock: transparent for the beam
    if (BLOCKS[id]?.opaque === true) return false;
  }
  return true;
}

// §9.4 — effect radius (blocks) and duration (ticks) by tier.
export function beaconRange(levels) { return [0, 20, 30, 40, 50][levels]; }
export function beaconDuration(levels) { return [0, 220, 260, 300, 340][levels]; }

/**
 * §9.5 — grant the beacon's selected effect to every player in range. Range is
 * a horizontal box of half-width `range` around (bx,bz); vertically from
 * by-range up to world top (127). Tier IV may boost the primary to level II
 * ('primary2') or add Regeneration I ('regen'). Effects are ambient.
 */
export function applyBeaconEffects(game, be, bx, by, bz, levels) {
  const primary = be.data.primaryEffect;
  if (!primary) return;
  const range = beaconRange(levels);
  const duration = beaconDuration(levels);
  const amp = (levels === 4 && be.data.secondary === 'primary2') ? 1 : 0;
  const players = game.players ?? [game.player];
  const yMin = by - range;
  for (const p of players) {
    if (!p) continue;
    if (Math.abs(p.pos.x - bx) > range || Math.abs(p.pos.z - bz) > range) continue;
    if (p.pos.y < yMin || p.pos.y > 127) continue;
    addEffect(p, primary, amp, duration, true);
    if (levels === 4 && be.data.secondary === 'regen') {
      addEffect(p, EFFECT.REGENERATION, 0, duration, true);
    }
  }
}

/** §9.5 — primary-effect menu; each option unlocks at its minimum tier. */
export function beaconPrimaryOptions() {
  return [
    { id: EFFECT.SPEED, name: 'Speed', minLevel: 1 },
    { id: EFFECT.HASTE, name: 'Haste', minLevel: 1 },
    { id: EFFECT.RESISTANCE, name: 'Resistance', minLevel: 2 },
    { id: EFFECT.JUMP_BOOST, name: 'Jump Boost', minLevel: 2 },
    { id: EFFECT.STRENGTH, name: 'Strength', minLevel: 3 },
  ];
}

/** §9 — combined status: tier + whether the beacon is projecting. */
export function beaconActive(world, bx, by, bz) {
  const levels = pyramidLevels(world, bx, by, bz);
  return { levels, active: levels >= 1 && skyClear(world, bx, by, bz) };
}

// ---------------------------------------------------------------- §9.6 beam
// Two nested rotating square prisms from the beacon top to Y=127, translucent
// and unlit. `spin` is deg/tick (inner +0.9, outer −0.45). Stained-glass tinting
// is explicitly OUT of scope in §9.6, so the colors are fixed.
export const BEAM = {
  inner: { width: 0.32, color: '#ffffff', alpha: 0.9, spin: 0.9 },
  outer: { width: 0.50, color: '#dff3ff', alpha: 0.25, spin: -0.45 },
};

const BEAM_TOP_Y = 127;
const DEG = Math.PI / 180;
const CHECK_EVERY = 10;                 // frames between self-verification passes
const BEAMS = new Map();                // "x,y,z" -> handle

/** Create/refresh/retire the beam for one beacon. Called from pyramidLevels. */
function syncBeam(world, bx, by, bz, levels) {
  const scene = world?.game?.scene;
  if (!scene) return;
  const key = bx + ',' + by + ',' + bz;
  const existing = BEAMS.get(key);
  const active = levels >= 1 && skyClear(world, bx, by, bz);
  if (!active) { if (existing) retireBeam(existing); return; }
  if (existing) { existing.world = world; return; }

  const height = BEAM_TOP_Y - by;
  const group = new THREE.Group();
  group.position.set(bx + 0.5, by + 1 + height / 2, bz + 0.5);
  for (const layer of [BEAM.outer, BEAM.inner]) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(layer.width, height, layer.width),
      new THREE.MeshBasicMaterial({
        color: layer.color, transparent: true, opacity: layer.alpha,
        depthWrite: false, side: THREE.DoubleSide, fog: false,
      }),
    );
    m.userData.spin = layer.spin;
    // Never culled: the self-verification below runs from onBeforeRender, so a
    // beam that is off-screen must still get its chance to retire.
    m.frustumCulled = false;
    group.add(m);
  }
  const handle = { key, world, bx, by, bz, group, frames: 0 };
  group.children[0].onBeforeRender = () => tickBeam(handle);
  scene.add(group);
  BEAMS.set(key, handle);
}

function tickBeam(handle) {
  // Spin off the wall clock (20 ticks/s) so the rate is frame-rate independent.
  const ticks = performance.now() / 50;
  for (const m of handle.group.children) m.rotation.y = m.userData.spin * DEG * ticks;
  if (++handle.frames % CHECK_EVERY) return;
  const { world, bx, by, bz } = handle;
  if (!handle.group.parent ||
      world.getBlock(bx, by, bz) !== B.BEACON ||
      computeLevels(world, bx, by, bz) < 1 ||
      !skyClear(world, bx, by, bz)) retireBeam(handle);
}

function retireBeam(handle) {
  BEAMS.delete(handle.key);
  handle.group.parent?.remove(handle.group);
  for (const m of handle.group.children) { m.geometry.dispose(); m.material.dispose(); }
}
