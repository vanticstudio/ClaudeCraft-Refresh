// B4 — fishing bobber (19-BUILDOUT §B4). A lightweight projectile-family
// entity: flies out along the cast ray, floats in water, bites on a timer, and
// is reeled by the rod's second RMB (interaction.useRod). The CATCH ROLL is
// pure (items/fishing.js); this entity owns only geometry + timing.
// NOTE: singleplayer/host only — the RMB pipeline is host-authoritative, so a
// connected client casting is deferred (documented in the build-out).
import { Entity } from './Entity.js';
import { biteDelay } from '../items/fishing.js';
import { BLOCKS } from '../registry/blocks.js';
import * as THREE from 'three';
import { makeAtlasMaterial, tileSpriteGeometry, itemTileFor } from './ItemEntity.js';
import { idOf } from '../registry/items.js';

export class FishingBobber extends Entity {
  constructor(world, x, y, z, vx, vy, vz, owner, openWater) {
    super(world, x, y, z);
    this.type = 'fishing_bobber';
    this.width = 0.25; this.height = 0.25;
    this.vel.x = vx; this.vel.y = vy; this.vel.z = vz;
    this.owner = owner;
    this.state = 'fly';                 // fly → float → bite → (reel/flee)
    this.openWater = !!openWater;
    this.biteAt = 0;                    // world.time of the next bite
    this.biteUntil = 0;
    this.noGravity = false;
  }

  tick() {
    this.baseTick();
    const w = this.world;
    if (this.age > 1200) { this.dead = true; return; }   // 60 s cast timeout

    // flight: gravity + water entry switches to float
    if (this.state === 'fly') {
      if (w.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y), Math.floor(this.pos.z)) === 63 /* water */) {
        this.state = 'float';
        this.vel.x *= 0.2; this.vel.z *= 0.2; this.vel.y = 0;
        // open-water check at the hook: no solid/fluid in the 5×4×5 box around
        // and above the bobber (MC's bonus definition, simplified to the hook)
        this.openWater = this.isOpenWater();
        this.biteAt = w.time + biteDelay(w.rng, this.openWater);
        return;
      }
      // ground/blocked: snap to float on any solid contact (vel killed)
      if (this.hitWall || this.onGround) {
        this.state = 'float';
        this.openWater = this.isOpenWater();
        this.biteAt = w.time + biteDelay(w.rng, false);
      }
      return;
    }

    // float: gentle bob at the water surface; the hook drifts with the bob
    if (this.state === 'float') {
      this.vel.y = Math.sin(this.age * 0.3) * 0.008;
      if (w.time >= this.biteAt) {
        this.state = 'bite';
        this.biteUntil = w.time + 5;                    // 5-tick reel window
        // gold bite sparkle — the generic colored emitter (no new sound id)
        const p = w.game?.particles;
        if (p?.spawn && p?.colored) {
          for (let i = 0; i < 6; i++) {
            p.spawn(p.colored(0xffd54a, 0.07), this.pos.x, this.pos.y + 0.1, this.pos.z,
              (Math.random() - 0.5) * 0.1, 0.12, (Math.random() - 0.5) * 0.1, 8, 0);
          }
        }
      }
      return;
    }

    // bite: wait for the reel; past the window the fish is gone (flee → re-arm)
    if (this.state === 'bite') {
      this.vel.y = -0.02;                               // tug down
      if (w.time > this.biteUntil) {
        this.state = 'float';
        this.biteAt = w.time + biteDelay(w.rng, this.openWater);
      }
    }
  }

  isOpenWater() {
    const w = this.world;
    const bx = Math.floor(this.pos.x), by = Math.floor(this.pos.y), bz = Math.floor(this.pos.z);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = 0; dy <= 3; dy++) {
          const b = w.getBlock(bx + dx, by + dy, bz + dz);
          const blk = BLOCKS[b];
          if (blk.collidable || (blk.fluid && b !== 63)) return false;   // solid or non-water fluid
          if (b !== 0 && b !== 63 && blk.opacity > 0) return false;
        }
      }
    }
    return true;
  }

  /** Reel in. Returns 'bite' when a fish is on (caller rolls the catch), else the miss reason. */
  reel() {
    const s = this.state;
    this.dead = true;
    return s === 'bite' ? 'bite' : s;
  }

  // transient — never persisted (matches ThrownProjectile/RemotePlayer policy)
  serialize() { return null; }

  // small red float cube; baseColor rides applyLightScalar like every entity
  buildMesh() {
    const mat = new THREE.MeshBasicMaterial({ color: 0xd93a3a });
    mat.userData.baseColor = new THREE.Color(1, 1, 1);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), mat);
    const group = new THREE.Group();
    group.add(mesh);
    return group;
  }
}