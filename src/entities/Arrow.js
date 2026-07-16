// Arrow projectile — player bows and skeletons (05 §11).
import * as THREE from 'three';
import { Entity, LivingEntity } from './Entity.js';
import { raycastBlocks } from '../world/raycast.js';
import { tileSpriteGeometry, makeAtlasMaterial, entityAtlas } from './ItemEntity.js';
import { idOf } from '../registry/items.js';

export class Arrow extends Entity {
  constructor(world, x, y, z, vx, vy, vz, owner, { crit = false, fromPlayer = false } = {}) {
    super(world, x, y, z);
    this.type = 'arrow';
    this.width = 0.5; this.height = 0.5;
    this.vel.x = vx; this.vel.y = vy; this.vel.z = vz;
    this.owner = owner;
    this.crit = crit;
    this.fromPlayer = fromPlayer;
    this.stuck = false;
    this.stuckAge = 0;
    this.aimFromVelocity();
  }

  aimFromVelocity() {
    const v = this.vel;
    const h = Math.hypot(v.x, v.z);
    if (h > 1e-6 || Math.abs(v.y) > 1e-6) {
      this.yaw = Math.atan2(-v.x, v.z);
      this.pitch = Math.atan2(v.y, h);
      this.prevYaw = this.yaw;
    }
  }

  tick() {
    this.baseTick();
    if (this.stuck) {
      if (++this.stuckAge > 1200) { this.dead = true; return; }
      if (this.fromPlayer) this.tryPickup();
      return;
    }
    if (this.age > 1200) { this.dead = true; return; }

    const v = this.vel;
    const speed = Math.hypot(v.x, v.y, v.z);

    // collide → move → drag/gravity (MC order, 05 §11)
    let blockHit = null;
    if (speed > 1e-6) {
      blockHit = raycastBlocks(this.world,
        this.pos.x, this.pos.y + 0.25, this.pos.z,
        v.x / speed, v.y / speed, v.z / speed, speed);
    }

    const sweep = this.getAABB();
    for (const a of [0, 1, 2]) {
      const d = a === 0 ? v.x : a === 1 ? v.y : v.z;
      if (d > 0) sweep.max[a] += d; else sweep.min[a] += d;
    }
    sweep.expand(0.3, 0.3, 0.3);
    let target = null, bestD = Infinity;
    for (const e of this.world.getEntitiesInBox(sweep, e =>
        e instanceof LivingEntity && !e.dead && (this.age > 5 || e !== this.owner))) {
      const d = Math.hypot(e.pos.x - this.pos.x, e.pos.y - this.pos.y, e.pos.z - this.pos.z);
      if (d < bestD) { bestD = d; target = e; }
    }

    if (target && (!blockHit || bestD < blockHit.t)) {
      // endermen dodge arrows (05 §8.5)
      if (target.tryDodgeProjectile?.()) {
        // treated as a miss; arrow keeps flying
      } else {
        let dmg = Math.ceil(speed * 2);
        if (this.crit) dmg += Math.floor(this.world.rng() * (Math.floor(dmg / 2) + 2));
        const h = Math.hypot(v.x, v.z) || 1;
        target.hurt(dmg, 'arrow', {
          dirX: v.x / h, dirZ: v.z / h, knockback: 0.4, attacker: this.owner,
        });
        this.dead = true;
        return;
      }
    }

    if (blockHit && blockHit.t <= speed) {
      this.pos.x = blockHit.px; this.pos.y = blockHit.py - 0.25; this.pos.z = blockHit.pz;
      this.stuck = true;
      this.vel.x = this.vel.y = this.vel.z = 0;
      return;
    }

    this.pos.x += v.x; this.pos.y += v.y; this.pos.z += v.z;
    this.updateMedium();
    const drag = this.inWater ? 0.6 : 0.99;
    v.x *= drag; v.y *= drag; v.z *= drag;
    v.y -= 0.05;
    this.aimFromVelocity();
    if (this.pos.y < -64) this.dead = true;
  }

  tryPickup() {
    const player = this.world.game?.player;
    if (!player || player.dead) return;
    if (player.getAABB().expand(0.5, 0.25, 0.5).intersects(this.getAABB())) {
      const leftover = player.give({ id: idOf('arrow'), count: 1 });
      if (leftover === 0) this.dead = true;
    }
  }

  buildMesh() {
    const group = new THREE.Group();
    const TILE = entityAtlas().TILE;
    const tile = TILE['item_arrow'] ?? 0;
    const mat = makeAtlasMaterial({ doubleSide: true });
    if (!this.fromPlayer) mat.userData.baseColor.setRGB(0.75, 0.75, 0.75);   // skeleton arrows darker
    // flat cross aligned to +Z, rotated to velocity in updateRender
    for (const rot of [0, Math.PI / 2]) {
      const quad = new THREE.Mesh(tileSpriteGeometry(tile, 0.5), mat);
      quad.position.y = -0.25;
      quad.rotation.z = rot;
      const holder = new THREE.Group();
      holder.add(quad);
      holder.rotation.x = Math.PI / 2;   // lay along Z
      group.add(holder);
    }
    return group;
  }

  updateRender(alpha) {
    super.updateRender(alpha);
    if (!this.object3d) return;
    this.object3d.rotation.order = 'YXZ';
    this.object3d.rotation.y = this.yaw;
    this.object3d.rotation.x = -this.pitch;
    this.object3d.position.y += 0.25;
  }

  serialize() {
    return {
      type: 'arrow', ...super.serialize(),
      crit: this.crit, fromPlayer: this.fromPlayer, stuck: this.stuck,
    };
  }
}
