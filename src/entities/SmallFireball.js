// 10-NETHER §7.4 — blaze small fireball: straight flight, 5 fire damage + ignite
// on hit, no explosion. Not deflectable (unlike the ghast fireball).
import * as THREE from 'three';
import { Entity, LivingEntity } from './Entity.js';
import { BLOCKS } from '../registry/blocks.js';
import { makeAtlasMaterial } from './ItemEntity.js';

export class SmallFireball extends Entity {
  constructor(world, x, y, z, dx, dy, dz, owner) {
    super(world, x, y, z);
    this.type = 'small_fireball';
    this.width = 0.3; this.height = 0.3;
    const len = Math.hypot(dx, dy, dz) || 1;
    const SP = 0.6;
    this.vel.x = dx / len * SP; this.vel.y = dy / len * SP; this.vel.z = dz / len * SP;
    this.owner = owner;
    this.life = 120;
  }

  tick() {
    this.baseTick?.();
    if (--this.life <= 0) { this.dead = true; return; }
    const v = this.vel;
    const box = this.getAABB();
    for (const e of this.world.getEntitiesInBox(box, e => e instanceof LivingEntity && !e.dead && e !== this.owner)) {
      e.hurt(5, 'fire', {});
      if (e.setOnFire) e.setOnFire(60); else e.fireTicks = Math.max(e.fireTicks || 0, 60);
      this.dead = true; return;
    }
    const nx = this.pos.x + v.x, ny = this.pos.y + v.y, nz = this.pos.z + v.z;
    if (BLOCKS[this.world.getBlock(Math.floor(nx), Math.floor(ny), Math.floor(nz))]?.collidable) { this.dead = true; return; }
    this.pos.x = nx; this.pos.y = ny; this.pos.z = nz;
    v.x *= 0.98; v.y *= 0.98; v.z *= 0.98;
    if (this.pos.y < -8 || this.pos.y > 135) this.dead = true;
  }

  buildMesh() {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), makeAtlasMaterial());
    m.material.userData?.baseColor?.setRGB(1.0, 0.7, 0.15);
    const g = new THREE.Group(); g.add(m); return g;
  }
  serialize() { return null; }
}
