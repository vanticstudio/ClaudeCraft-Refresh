// 13-BOSSES §8.7 — Wither skull projectile.
//
// Fired by the Wither. Two flavours: black (fast, default) and blue (slower,
// tougher blast that shatters obsidian via game.explodeBlast0). No gravity, no
// drag. On any living hit (not the owner, not another wither) it deals 8 melee-
// class damage plus Wither II for 10 s, then explodes. Any block impact or the
// 600-tick life timeout also explodes. Non-persistent (serialize -> null).
import * as THREE from 'three';
import { Entity, LivingEntity } from './Entity.js';
import { BLOCKS } from '../registry/blocks.js';
import { EFFECT, addEffect } from '../status/effects.js';
import { emitSound, at } from '../audio/engine.js';
import { makeAtlasMaterial } from './ItemEntity.js';

export class WitherSkull extends Entity {
  constructor(world, x, y, z, dx, dy, dz, owner, opts = {}) {
    super(world, x, y, z);
    this.type = 'wither_skull';
    this.blue = !!opts.blue;
    this.width = this.height = 0.3125;
    this.noGravity = true;
    this.takesFallDamage = false;
    this.owner = owner;
    this.life = 600;

    const len = Math.hypot(dx, dy, dz) || 1;
    let ux = dx / len, uy = dy / len, uz = dz / len;
    if (!this.blue) {
      // black skulls carry a small gaussian-ish inaccuracy (~0.017/axis)
      const g = () => ((world.rng() - 0.5) + (world.rng() - 0.5) + (world.rng() - 0.5)) * 0.0114;
      ux += g(); uy += g(); uz += g();
    }
    const SP = this.blue ? 0.5 : 0.9;
    this.vel.x = ux * SP; this.vel.y = uy * SP; this.vel.z = uz * SP;
  }

  tick() {
    this.baseTick?.();
    if (this.dead) return;
    if (--this.life <= 0) { this.explode(); return; }

    const box = this.getAABB();
    for (const e of this.world.getEntitiesInBox(box, e => e instanceof LivingEntity &&
      !e.dead && e !== this.owner && e.type !== 'wither')) {
      e.hurt(8, 'wither_skull', { attacker: this.owner });
      addEffect(e, EFFECT.WITHER, 1, 200);   // Wither II, 10 s
      this.explode(); return;
    }

    const v = this.vel;
    const nx = this.pos.x + v.x, ny = this.pos.y + v.y, nz = this.pos.z + v.z;
    if (BLOCKS[this.world.getBlock(Math.floor(nx), Math.floor(ny), Math.floor(nz))]?.collidable) {
      this.explode(); return;
    }
    this.pos.x = nx; this.pos.y = ny; this.pos.z = nz;
    if (this.pos.y < -64 || this.pos.y > 135) { this.explode(); return; }
  }

  explode() {
    if (this.dead) return;
    this.dead = true;
    const g = this.world.game;
    const { x, y, z } = this.pos;
    emitSound('mob.wither.shoot', at(x, y, z));
    if (this.blue) {
      // blast-0: shatters obsidian (orchestrator adds explodeBlast0)
      (g.explodeBlast0 ?? g.explode).call(g, x, y, z, 1);
    } else {
      g.explode(x, y, z, 1);
    }
  }

  buildMesh() {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.3125, 0.3125, 0.3125), makeAtlasMaterial());
    m.material.userData?.baseColor?.setRGB(
      this.blue ? 0.35 : 0.15, this.blue ? 0.55 : 0.12, this.blue ? 0.55 : 0.12);
    const grp = new THREE.Group(); grp.add(m); return grp;
  }

  serialize() { return null; }
}
