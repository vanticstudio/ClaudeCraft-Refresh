// 10-NETHER §7.3 — Ghast: giant floating jellyfish, flight AI, charges 20 t then
// fires a deflectable GhastFireball at the player within 64. Buoyant (no gravity).
import * as THREE from 'three';
import { Mob } from '../Mob.js';
import { GhastFireball } from '../../GhastFireball.js';
import { makeAtlasMaterial } from '../../ItemEntity.js';
import { emitSound, at } from '../../../audio/engine.js';

export class Ghast extends Mob {
  constructor(world, x, y, z) {
    super(world, x, y, z);
    this.type = 'ghast';
    this.hostile = true;
    this.fireImmune = true;
    this.width = 4.0; this.height = 4.0;
    this.health = 10; this.maxHealth = 10;
    this.detectionRange = 64;
    this.xpValue = 5;
    this.noGravity = true;
    this.charge = 0;                 // charge counter; -1 = idle
    this.attackCooldown = 0;
    this.driftTimer = 0;
    this.driftDir = { x: 0, y: 0, z: 0 };
  }

  tick() {
    this.baseTick();
    if (this.dead) { this.deathTime++; return; }
    this.tickEnvironment();
    if (this.dead) return;
    if (this.tickDespawn?.()) return;
    if (this.attackCooldown > 0) this.attackCooldown--;

    const p = this.world.game?.player;
    const dist = p ? this.distTo(p) : 999;

    // flight drift (buoyant random walk), gently avoiding solid ahead
    if (--this.driftTimer <= 0) {
      this.driftTimer = 40 + Math.floor(this.world.rng() * 40);
      this.driftDir = { x: (this.world.rng() * 2 - 1), y: (this.world.rng() * 2 - 1) * 0.5, z: (this.world.rng() * 2 - 1) };
    }
    const s = 0.03;
    this.pos.x += this.driftDir.x * s; this.pos.y += this.driftDir.y * s; this.pos.z += this.driftDir.z * s;

    // shoot goal
    if (p && dist <= 64 && this.attackCooldown === 0) {
      // face target
      this.yaw = Math.atan2(-(p.pos.x - this.pos.x), -(p.pos.z - this.pos.z));
      if (this.charge === 0) emitSound('entity.ghast.warn', at(this.pos.x, this.pos.y, this.pos.z));
      this.charge++;
      if (this.charge >= 20) {
        this.fireAt(p);
        this.charge = 0;
        this.attackCooldown = 60;
      }
    } else {
      this.charge = 0;
    }
    this.age++;
  }

  fireAt(p) {
    const ex = this.pos.x, ey = this.pos.y + 0.5, ez = this.pos.z;
    const dx = p.pos.x - ex, dy = (p.pos.y + p.eyeHeight * 0.5) - ey, dz = p.pos.z - ez;
    const fb = new GhastFireball(this.world, ex, ey, ez, dx, dy, dz, this);
    this.world.game.entities.add(fb);
    emitSound('entity.ghast.shoot', at(ex, ey, ez));
  }

  dropTable() {
    const r = this.world.rng;
    const out = [];
    if (r() < 0.5) out.push({ name: 'ghast_tear', count: 1 });
    const g = Math.floor(r() * 3); if (g) out.push({ name: 'gunpowder', count: g });
    return out;
  }

  buildMesh() {
    const group = new THREE.Group();
    const mat = makeAtlasMaterial();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6, 2.6), mat);
    body.position.y = 2.6;
    group.add(body);
    for (let i = 0; i < 9; i++) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.25, 1.4, 0.25), mat);
      t.position.set((i % 3 - 1) * 0.8, 0.7, (Math.floor(i / 3) - 1) * 0.8);
      group.add(t);
    }
    return group;
  }
}
