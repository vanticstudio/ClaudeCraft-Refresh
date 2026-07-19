// 13-BOSSES §6.5 — Ender Dragon fireball ("dragon breath" delivery).
//
// A large no-gravity projectile. The direct impact deals NO damage and NO
// knockback — its whole purpose is to burst on first contact (any block, any
// non-owner entity) or on timeout and leave a lingering acid cloud where it
// lands. The cloud carries a custom {damage:6} payload (orchestrator extends
// AreaEffectCloud.applyTo to hurt(6,'magic',{}) — armour-ignoring). Non-
// persistent (serialize -> null).
import * as THREE from 'three';
import { Entity, LivingEntity } from './Entity.js';
import { BLOCKS } from '../registry/blocks.js';
import { emitSound, at } from '../audio/engine.js';
import { makeAtlasMaterial } from './ItemEntity.js';

export class DragonFireball extends Entity {
  constructor(world, x, y, z, dx, dy, dz, owner) {
    super(world, x, y, z);
    this.type = 'dragon_fireball';
    this.width = this.height = 1.0;
    this.noGravity = true;
    this.takesFallDamage = false;
    this.owner = owner;
    this.life = 600;

    const len = Math.hypot(dx, dy, dz) || 1;
    const SP = 0.65;
    this.vel.x = dx / len * SP; this.vel.y = dy / len * SP; this.vel.z = dz / len * SP;
  }

  tick() {
    this.baseTick?.();
    if (this.dead) return;
    if (--this.life <= 0) { this.burst(); return; }

    // direct contact does nothing but detonate the cloud. Skip the owner AND the
    // dragon's own part hitboxes, or the fireball bursts on the head on tick 1.
    const box = this.getAABB();
    for (const e of this.world.getEntitiesInBox(box, e => e instanceof LivingEntity &&
      !e.dead && e !== this.owner && !e.isDragonPart)) {
      this.burst(); return;
    }

    const v = this.vel;
    const nx = this.pos.x + v.x, ny = this.pos.y + v.y, nz = this.pos.z + v.z;
    if (BLOCKS[this.world.getBlock(Math.floor(nx), Math.floor(ny), Math.floor(nz))]?.collidable) {
      this.burst(); return;
    }
    this.pos.x = nx; this.pos.y = ny; this.pos.z = nz;
    if (this.pos.y < -64 || this.pos.y > 135) { this.burst(); return; }
  }

  burst() {
    if (this.dead) return;
    this.dead = true;
    const { x, y, z } = this.pos;
    emitSound('entity.dragon_fireball.explode', at(x, y, z));
    this.world.game.spawnAreaEffectCloud({
      pos: { x, y, z },
      radius: 3.0,
      radiusPerTick: 4 / 600,
      durationTicks: 600,
      reapplyDelay: 20,
      effect: { damage: 6 },   // custom payload: 6 HP magic, armour-ignoring
    });
  }

  buildMesh() {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, 1.0), makeAtlasMaterial());
    m.material.userData?.baseColor?.setRGB(0.6, 0.25, 0.75);
    const grp = new THREE.Group(); grp.add(m); return grp;
  }

  serialize() { return null; }
}

export default DragonFireball;
