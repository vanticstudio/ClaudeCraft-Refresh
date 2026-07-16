// Egg / snowball / ender pearl projectile (06 §7.4, physics per 05 §11 family).
import * as THREE from 'three';
import { Entity, LivingEntity } from './Entity.js';
import { raycastBlocks } from '../world/raycast.js';
import { tileSpriteGeometry, itemTileFor, makeAtlasMaterial } from './ItemEntity.js';
import { idOf } from '../registry/items.js';

export class ThrownProjectile extends Entity {
  // kind: 'egg' | 'snowball' | 'ender_pearl'
  constructor(world, kind, x, y, z, vx, vy, vz, owner) {
    super(world, x, y, z);
    this.type = 'thrown_' + kind;
    this.kind = kind;
    this.width = 0.25; this.height = 0.25;
    this.vel.x = vx; this.vel.y = vy; this.vel.z = vz;
    this.owner = owner;
  }

  tick() {
    this.baseTick();
    if (this.age > 1200) { this.dead = true; return; }

    const v = this.vel;
    const speed = Math.hypot(v.x, v.y, v.z);

    // block hit along this tick's segment
    let blockHit = null;
    if (speed > 1e-6) {
      blockHit = raycastBlocks(this.world,
        this.pos.x, this.pos.y + 0.125, this.pos.z,
        v.x / speed, v.y / speed, v.z / speed, speed);
    }

    // entity hit: nearest living entity whose inflated AABB intersects the segment
    const sweep = this.getAABB();
    sweep.min[0] = Math.min(sweep.min[0], sweep.min[0] + v.x) - 0.3;
    sweep.min[1] = Math.min(sweep.min[1], sweep.min[1] + v.y) - 0.3;
    sweep.min[2] = Math.min(sweep.min[2], sweep.min[2] + v.z) - 0.3;
    sweep.max[0] = Math.max(sweep.max[0], sweep.max[0] + v.x) + 0.3;
    sweep.max[1] = Math.max(sweep.max[1], sweep.max[1] + v.y) + 0.3;
    sweep.max[2] = Math.max(sweep.max[2], sweep.max[2] + v.z) + 0.3;
    const candidates = this.world.getEntitiesInBox(sweep, e =>
      e instanceof LivingEntity && !e.dead &&
      (this.age > 5 || e !== this.owner));
    const entityHit = candidates.length ? candidates[0] : null;

    if (entityHit && (!blockHit || this.distTo(entityHit.pos) < blockHit.t)) {
      this.impact(null, entityHit);
      return;
    }
    if (blockHit && blockHit.t <= speed) {
      this.pos.x = blockHit.px; this.pos.y = blockHit.py; this.pos.z = blockHit.pz;
      this.impact(blockHit, null);
      return;
    }

    this.pos.x += v.x; this.pos.y += v.y; this.pos.z += v.z;
    const drag = this.inWater ? 0.6 : 0.99;
    v.x *= drag; v.y *= drag; v.z *= drag;
    v.y -= 0.03;
    if (this.pos.y < -64) this.dead = true;
    this.updateMedium();
  }

  distTo(p) {
    return Math.hypot(p.x - this.pos.x, p.y - this.pos.y, p.z - this.pos.z);
  }

  impact(blockHit, entityHit) {
    this.dead = true;
    const game = this.world.game;
    if (entityHit) {
      const d = Math.hypot(this.vel.x, this.vel.z) || 1;
      if (this.kind === 'snowball' || this.kind === 'egg') {
        entityHit.hurt(0, 'melee', { dirX: this.vel.x / d, dirZ: this.vel.z / d, attacker: this.owner });
        entityHit.applyKnockback?.(0.4, this.vel.x / d, this.vel.z / d);
      }
    }
    if (this.kind === 'egg') {
      if (this.world.rng() < 1 / 8) {
        game?.spawnMobAt?.('chicken', this.pos.x, this.pos.y, this.pos.z, { isBaby: true });
      }
    } else if (this.kind === 'ender_pearl') {
      const t = this.owner;
      if (t && !t.dead) {
        t.setPos(this.pos.x, Math.max(0, this.pos.y), this.pos.z);
        t.prevPos.x = t.pos.x; t.prevPos.y = t.pos.y; t.prevPos.z = t.pos.z;
        t.vel.x = t.vel.y = t.vel.z = 0;
        t.fallDistance = 0;
        t.hurt(5, 'pearl');   // 5 self-damage, not armor-reducible
      }
    }
  }

  buildMesh() {
    const group = new THREE.Group();
    const tile = itemTileFor(idOf(this.kind));
    const mesh = new THREE.Mesh(tileSpriteGeometry(tile, 0.3), makeAtlasMaterial({ doubleSide: true }));
    group.add(mesh);
    return group;
  }
}
