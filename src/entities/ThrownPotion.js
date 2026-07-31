// 09-POTIONS §13/§14 — thrown splash & lingering potions. Physics per §13.1
// (reuses 05 §11's collide→move→drag order); gravity 0.05, drag 0.99 (water 0.6).
import * as THREE from 'three';
import { Entity, LivingEntity } from './Entity.js';
import { raycastBlocks } from '../world/raycast.js';
import { POTIONS, potionTint } from '../status/potions.js';
import { addEffect, applyInstant, EFFECT } from '../status/effects.js';
import { AreaEffectCloud } from './AreaEffectCloud.js';
import { emitSound, at } from '../audio/engine.js';

const FIRE = 65;

export class ThrownPotion extends Entity {
  constructor(world, potionId, form /* 'splash' | 'lingering' */, x, y, z, vx, vy, vz, owner) {
    super(world, x, y, z);
    this.type = 'thrown_potion';
    this.potionId = potionId;
    this.form = form;
    this.width = 0.25; this.height = 0.25;
    this.vel.x = vx; this.vel.y = vy; this.vel.z = vz;
    this.owner = owner;
  }

  tick() {
    this.baseTick();
    if (this.age > 1200) { this.dead = true; return; }
    const v = this.vel;
    const speed = Math.hypot(v.x, v.y, v.z);

    let blockHit = null;
    if (speed > 1e-6) {
      blockHit = raycastBlocks(this.world, this.pos.x, this.pos.y + 0.125, this.pos.z,
        v.x / speed, v.y / speed, v.z / speed, speed);
    }
    const sweep = this.getAABB();
    for (const a of [0, 1, 2]) {
      sweep.min[a] = Math.min(sweep.min[a], sweep.min[a] + v[['x', 'y', 'z'][a]]) - 0.3;
      sweep.max[a] = Math.max(sweep.max[a], sweep.max[a] + v[['x', 'y', 'z'][a]]) + 0.3;
    }
    const cand = this.world.getEntitiesInBox(sweep, e =>
      e instanceof LivingEntity && !e.dead && (this.age > 2 || e !== this.owner));   // owner grace 2 t
    // §13.1 — impact is the FIRST entity AABB intersected, i.e. the nearest along
    // the path. getEntitiesInBox returns chunk-scan/spawn order, so take the
    // minimum explicitly (Arrow.tick does the same); `cand[0]` picked an
    // arbitrary one, which both mis-ordered the block/entity race and handed the
    // 100%-potency direct hit to the wrong mob.
    let entityHit = null, bestD = Infinity;
    for (const e of cand) {
      const d = Math.hypot(e.pos.x - this.pos.x, e.pos.y - this.pos.y, e.pos.z - this.pos.z);
      if (d < bestD) { bestD = d; entityHit = e; }
    }

    if (entityHit && (!blockHit || bestD < blockHit.t)) {
      this.impact(entityHit);
      return;
    }
    if (blockHit && blockHit.t <= speed) {
      this.pos.x = blockHit.px; this.pos.y = blockHit.py; this.pos.z = blockHit.pz;
      this.impact(null);
      return;
    }
    this.pos.x += v.x; this.pos.y += v.y; this.pos.z += v.z;
    const drag = this.inWater ? 0.6 : 0.99;
    v.x *= drag; v.y *= drag; v.z *= drag;
    v.y -= 0.05;
    if (this.pos.y < -64) this.dead = true;
    this.updateMedium();
  }

  impact(directHit) {
    this.dead = true;
    const game = this.world.game;
    const hit = { x: this.pos.x, y: this.pos.y, z: this.pos.z };
    const lingering = this.form === 'lingering';
    emitSound(lingering ? 'entity.lingering_potion.break' : 'entity.splash_potion.break', at(hit.x, hit.y, hit.z));
    game?.particles?.splashPotion?.(hit.x, hit.y, hit.z, potionTint(this.potionId), 30);

    if (this.potionId === 'water') { this.splashWater(hit); return; }   // §13.3 (no cloud even if lingering)

    if (lingering) {                                                     // §14.1 — spawn a cloud, no immediate effect
      game?.entities?.add(new AreaEffectCloud(this.world, hit.x, hit.y, hit.z, this.potionId, this.owner));
      return;
    }
    // §13.2 splash resolution
    const P = POTIONS[this.potionId];
    if (!P) return;
    const box = this.getAABB();
    box.min[0] = hit.x - 4.125; box.max[0] = hit.x + 4.125;
    box.min[1] = hit.y - 2.125; box.max[1] = hit.y + 2.125;
    box.min[2] = hit.z - 4.125; box.max[2] = hit.z + 4.125;
    for (const e of this.world.getEntitiesInBox(box, e => e instanceof LivingEntity && !e.dead)) {
      const d2 = distSqClosestPoint(e.getAABB(), hit);
      if (d2 >= 16) continue;                                           // 4-block euclidean gate
      const w = (e === directHit) ? 1.0 : 1.0 - Math.sqrt(d2) / 4;      // linear falloff
      if (P.instant) applyInstant(e, P.effect, P.amp, w, this.owner);
      else {
        const dur = Math.floor(w * P.ticks + 0.5);
        if (dur > 20) addEffect(e, P.effect, P.amp, dur);               // ≤1 s → not applied
      }
    }
  }

  // §13.3 — splash water: douse fire + extinguish burning entities + hurt endermen/blaze.
  splashWater(hit) {
    const w = this.world;
    const bx = Math.floor(hit.x), by = Math.floor(hit.y), bz = Math.floor(hit.z);
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (w.getBlock(bx + dx, by, bz + dz) !== FIRE) continue;
      w.setBlock(bx + dx, by, bz + dz, 0, { byPlayer: true });
      // §13.3 / 15 §13.3 — the douse has its own voice; the generic
      // entity.splash_potion.break above is the bottle, not the hiss.
      // (setBlock's FIRE→non-FIRE path already forgets the fire origin, and
      // `byPlayer` keeps World.setBlock's immediate remesh, so removeFire() is
      // deliberately not used here.)
      emitSound('block.extinguish', at(bx + dx + 0.5, by + 0.5, bz + dz + 0.5));
    }
    const box = this.getAABB();
    box.min[0] = hit.x - 4.125; box.max[0] = hit.x + 4.125;
    box.min[1] = hit.y - 2.125; box.max[1] = hit.y + 2.125;
    box.min[2] = hit.z - 4.125; box.max[2] = hit.z + 4.125;
    for (const e of w.getEntitiesInBox(box, e => e instanceof LivingEntity && !e.dead)) {
      e.fireTicks = 0;
      if (e.hurtByWater || e.type === 'enderman') e.hurt(1, 'magic', { attacker: this.owner });
    }
  }

  buildMesh() {
    const group = new THREE.Group();
    const mat = new THREE.SpriteMaterial({ color: potionTint(this.potionId) });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.35, 0.45, 0.35);
    group.add(sprite);
    return group;
  }

  serialize() {
    return {
      type: 'thrown_potion', potionId: this.potionId, form: this.form,
      pos: [this.pos.x, this.pos.y, this.pos.z], vel: [this.vel.x, this.vel.y, this.vel.z],
    };
  }
}

/** §13.2 — squared distance from a point to the closest point on an AABB. */
export function distSqClosestPoint(aabb, p) {
  const cx = Math.max(aabb.min[0], Math.min(p.x, aabb.max[0]));
  const cy = Math.max(aabb.min[1], Math.min(p.y, aabb.max[1]));
  const cz = Math.max(aabb.min[2], Math.min(p.z, aabb.max[2]));
  const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
  return dx * dx + dy * dy + dz * dz;
}
