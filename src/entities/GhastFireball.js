// 10-NETHER §7.3 — the ghast fireball: straight flight, power-1 explosion on
// impact, and DEFLECTION. It extends LivingEntity so a player's melee swing
// targets it (interaction.js picks LivingEntity); its hurt() override deflects
// instead of taking damage, reversing the fireball toward the attacker's look
// and reassigning ownership. A deflected fireball that strikes the ghast
// one-shots it — the intended kill.
import * as THREE from 'three';
import { LivingEntity } from './Entity.js';
import { BLOCKS } from '../registry/blocks.js';
import { makeAtlasMaterial } from './ItemEntity.js';
import { emitSound, at } from '../audio/engine.js';

const SPEED = 0.95;

export class GhastFireball extends LivingEntity {
  constructor(world, x, y, z, dx, dy, dz, owner) {
    super(world, x, y, z);
    this.type = 'ghast_fireball';
    this.width = 0.6; this.height = 0.6;
    this.health = 1; this.maxHealth = 1;
    const len = Math.hypot(dx, dy, dz) || 1;
    this.vel.x = dx / len * SPEED; this.vel.y = dy / len * SPEED; this.vel.z = dz / len * SPEED;
    this.owner = owner;              // the ghast, or the deflector after a deflect
    this.deflectedByPlayer = false;
    this.life = 200;
    this.takesFallDamage = false;
    this.noGravity = true;
  }

  /** §7.3 — a melee/projectile hit deflects rather than damages. */
  hurt(amount, source, opts = {}) {
    const deflector = opts.attacker;
    if (!deflector) return false;
    // reverse toward the deflector's look direction (melee) at current speed
    const look = deflector.lookDir ? deflector.lookDir()
      : { x: -Math.sin(deflector.yaw), y: 0, z: -Math.cos(deflector.yaw) };
    const len = Math.hypot(look.x, look.y, look.z) || 1;
    this.vel.x = look.x / len * SPEED; this.vel.y = look.y / len * SPEED; this.vel.z = look.z / len * SPEED;
    this.owner = deflector;
    this.deflectedByPlayer = deflector === this.world.game?.player;
    emitSound('entity.ghast.shoot', at(this.pos.x, this.pos.y, this.pos.z));
    return false;                    // fireball takes no damage
  }

  tick() {
    this.baseTick?.();
    if (--this.life <= 0) { this.dead = true; return; }
    const v = this.vel;
    const speed = Math.hypot(v.x, v.y, v.z);

    // entity impact (skip the owner)
    const box = this.getAABB();
    for (const e of this.world.getEntitiesInBox(box, e => e instanceof LivingEntity && !e.dead && e !== this && e !== this.owner)) {
      // a deflected fireball striking the ghast one-shots it
      this.explodeAt(this.pos.x, this.pos.y, this.pos.z, e);
      this.dead = true; return;
    }
    // block impact
    const nx = this.pos.x + v.x, ny = this.pos.y + v.y, nz = this.pos.z + v.z;
    if (BLOCKS[this.world.getBlock(Math.floor(nx), Math.floor(ny), Math.floor(nz))]?.collidable) {
      this.explodeAt(this.pos.x, this.pos.y, this.pos.z, null); this.dead = true; return;
    }

    this.pos.x = nx; this.pos.y = ny; this.pos.z = nz;
    v.x *= 0.95; v.y *= 0.95; v.z *= 0.95;    // §7.3 drag, no gravity
    if (this.pos.y < -8 || this.pos.y > 135) this.dead = true;
  }

  explodeAt(x, y, z, direct) {
    const g = this.world.game;
    g?.explode?.(x, y, z, 1);                  // §7.3 power-1 explosion
    if (direct?.setOnFire) direct.setOnFire(100);
    else if (direct) direct.fireTicks = Math.max(direct.fireTicks || 0, 100);
  }

  buildMesh() {
    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(0.6, 0.6, 0.6);
    const mat = makeAtlasMaterial();
    mat.userData?.baseColor?.setRGB(1.0, 0.5, 0.1);
    group.add(new THREE.Mesh(geo, mat));
    return group;
  }

  serialize() { return null; }                 // fireballs aren't persisted (like arrows)
}
