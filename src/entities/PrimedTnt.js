// Ignited TNT entity (06 §5.6): fuse 80t, pulse render, power-4 explosion.
import * as THREE from 'three';
import { Entity } from './Entity.js';
import { B } from '../registry/blocks.js';
import { blockCubeGeometry, makeAtlasMaterial } from './ItemEntity.js';

export class PrimedTnt extends Entity {
  constructor(world, x, y, z, fuse = 80) {
    super(world, x, y, z);
    this.type = 'primed_tnt';
    this.width = 0.98; this.height = 0.98;
    this.fuse = fuse;
    this.vel.y = 0.2;   // initial hop
  }

  tick() {
    this.baseTick();
    this.vel.y -= 0.04;
    this.move(this.vel.x, this.vel.y, this.vel.z);
    this.vel.x *= 0.98; this.vel.y *= 0.98; this.vel.z *= 0.98;
    if (this.onGround) { this.vel.x *= 0.7; this.vel.z *= 0.7; }
    if (--this.fuse <= 0) {
      this.dead = true;
      this.world.game?.explode(
        this.pos.x, this.pos.y + this.height / 2, this.pos.z, 4, { fire: false });
    }
  }

  buildMesh() {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(blockCubeGeometry(B.TNT, 1), makeAtlasMaterial());
    group.add(mesh);
    return group;
  }

  updateRender(alpha) {
    super.updateRender(alpha);
    if (!this.object3d) return;
    const t = this.age + alpha;
    const s = 1 + 0.05 * Math.abs(Math.sin(t * Math.PI / 10));   // pulse 1.0→1.05
    this.object3d.scale.set(s, s, s);
    // white flash every 10 ticks
    const flash = (this.age % 10) < 2;
    this.object3d.traverse(o => {
      if (o.isMesh && o.material) {
        const v = flash ? 2.5 : this.lightScalar;
        o.material.color.setRGB(v, v, v);
      }
    });
  }

  applyLightScalar() { /* handled in updateRender */ }

  serialize() {
    return {
      type: 'primed_tnt',
      pos: [this.pos.x, this.pos.y, this.pos.z],
      vel: [this.vel.x, this.vel.y, this.vel.z],
      fuseRemaining: this.fuse,
    };
  }

  static deserialize(world, rec) {
    const e = new PrimedTnt(world, rec.pos[0], rec.pos[1], rec.pos[2], rec.fuseRemaining ?? 80);
    e.vel.x = rec.vel[0]; e.vel.y = rec.vel[1]; e.vel.z = rec.vel[2];
    e.vel.y = rec.vel[1];   // no extra hop on restore
    return e;
  }
}
