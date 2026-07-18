// 09-POTIONS §14.2 — the AreaEffectCloud entity (lingering potions + 13's dragon
// breath). Anchored where it spawns; no gravity/collision. Pure-particle render.
import * as THREE from 'three';
import { Entity, LivingEntity } from './Entity.js';
import { POTIONS, potionTint } from '../status/potions.js';
import { addEffect, applyInstant } from '../status/effects.js';

export class AreaEffectCloud extends Entity {
  // Lingering-potion constructor (§14.2 defaults). The factory below overrides
  // fields for 13's dragon clouds.
  constructor(world, x, y, z, potionId, owner, opts = {}) {
    super(world, x, y, z);
    this.type = 'area_effect_cloud';
    this.width = 0.1; this.height = 0.1;
    this.potionId = potionId ?? null;
    this.effectPayload = opts.effect ?? null;        // {id, amp} for dragon clouds
    this.owner = owner ?? null;
    this.radius = opts.radius ?? 3.0;
    this.radiusPerTick = opts.radiusPerTick ?? -this.radius / (opts.duration ?? 600);
    this.duration = opts.duration ?? 600;
    this.waitTime = opts.waitTime ?? 10;
    this.radiusOnUse = opts.radiusOnUse ?? -0.5;      // shave per application (0 for dragon)
    this.reapplicationDelay = opts.reapplyDelay ?? 20;
    this.victims = new Map();                          // entity → next-eligible age
    this.noGravity = true;
  }

  tick() {
    this.age++;
    this.radius += this.radiusPerTick;
    if (this.radius < 0.5 || this.age > this.waitTime + this.duration) { this.dead = true; return; }
    this.world.game?.particles?.effectCloud?.(this.pos.x, this.pos.y, this.pos.z, this.radius, this.cloudTint());
    if (this.age < this.waitTime || this.age % 5 !== 0) return;   // arm after waitTime; scan every 5 t

    const box = this.getAABB();
    box.min[0] = this.pos.x - this.radius; box.max[0] = this.pos.x + this.radius;
    box.min[1] = this.pos.y - 2; box.max[1] = this.pos.y + 2;
    box.min[2] = this.pos.z - this.radius; box.max[2] = this.pos.z + this.radius;
    const r2 = this.radius * this.radius;
    for (const e of this.world.getEntitiesInBox(box, e => e instanceof LivingEntity && !e.dead)) {
      const dx = e.pos.x - this.pos.x, dz = e.pos.z - this.pos.z;
      if (dx * dx + dz * dz > r2) continue;                       // horizontal disc
      if ((this.victims.get(e) ?? 0) > this.age) continue;
      this.victims.set(e, this.age + this.reapplicationDelay);
      this.applyTo(e);
      this.radius += this.radiusOnUse;
      if (this.radius < 0.5) { this.dead = true; return; }
    }
  }

  applyTo(e) {
    if (this.effectPayload) {                                     // 13's direct payload
      const p = this.effectPayload;
      // 13-BOSSES §6.5 — dragon-breath clouds deal direct magic damage (armor-ignoring),
      // not a status effect.
      if (p.damage) { if (e.hurt) e.hurt(p.damage, 'magic', {}); return; }
      if (p.instant) applyInstant(e, p.id, p.amp ?? 0, 0.5, this.owner);
      else addEffect(e, p.id, p.amp ?? 0, Math.floor((p.ticks ?? 0) / 4));
      return;
    }
    const P = POTIONS[this.potionId];
    if (!P || !P.effect) return;
    if (P.instant) applyInstant(e, P.effect, P.amp, 0.5, this.owner);          // instants at HALF potency
    else { const d = Math.floor(P.ticks / 4); if (d > 0) addEffect(e, P.effect, P.amp, d); }
  }

  cloudTint() { return this.potionId ? potionTint(this.potionId) : 0xCC44FF; }

  buildMesh() { return new THREE.Group(); }   // no mesh — the cloud is pure particles

  serialize() {
    return {
      type: 'area_effect_cloud', potionId: this.potionId,
      pos: [this.pos.x, this.pos.y, this.pos.z],
      radius: this.radius, age: this.age, waitTime: this.waitTime, duration: this.duration,
    };
  }
}

/**
 * §14.2 factory — the exported entry point 13-BOSSES injects dragon-breath params
 * through. Dragon clouds arm immediately (waitTime 0) and don't self-shrink per
 * hit (radiusOnUse 0); 13's values override the lingering-potion defaults.
 */
export function spawnEffectCloud(world, { pos, radius, radiusPerTick, durationTicks, effect, reapplyDelay }) {
  return new AreaEffectCloud(world, pos.x, pos.y, pos.z, null, null, {
    radius, radiusPerTick, duration: durationTicks, effect,
    reapplyDelay: reapplyDelay ?? 20, waitTime: 0, radiusOnUse: 0,
  });
}
