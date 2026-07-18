// 10-NETHER §7.4-§7.8 — Blaze, Zombified Piglin, Magma Cube, Wither Skeleton,
// Piglin. AI is simplified vs the spec's full behaviours (anger propagation,
// bartering, hop physics) — see DEVIATIONS; stats/flags/drops are exact. Meshes
// are tinted boxes/humanoids (no bespoke Nether skins painted).
import * as THREE from 'three';
import { Mob } from '../Mob.js';
import { SwimGoal, WanderGoal, LookAtPlayerGoal, IdleLookGoal, MeleeAttackGoal } from '../ai.js';
import { humanoidModel } from '../models.js';
import { SmallFireball } from '../../SmallFireball.js';
import { makeAtlasMaterial } from '../../ItemEntity.js';
import { emitSound, at } from '../../../audio/engine.js';

function tintBox(w, h, rgb) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), makeAtlasMaterial());
  m.material.userData?.baseColor?.setRGB(rgb[0], rgb[1], rgb[2]);
  m.position.y = h / 2;
  g.add(m); return g;
}

// ---------------------------------------------------------------- §7.4 Blaze
export class Blaze extends Mob {
  constructor(world, x, y, z) {
    super(world, x, y, z);
    this.type = 'blaze';
    this.hostile = true; this.fireImmune = true;
    this.hurtByWater = true;              // §7.4 sole water weakness
    this.width = 0.6; this.height = 1.8;
    this.health = this.maxHealth = 20;
    this.detectionRange = 48; this.xpValue = 10;
    this.noGravity = true;
    this.attackCooldown = 0; this.charge = 0;
  }
  tick() {
    this.baseTick(); if (this.dead) { this.deathTime++; return; }
    this.tickEnvironment(); if (this.dead) return;
    if (this.tickDespawn?.()) return;
    // §7.4 water contact hurts 1/tick
    if (this.inWater && this.age % 1 === 0) this.hurt(1, 'drown', {});
    if (this.attackCooldown > 0) this.attackCooldown--;
    const p = this.world.game?.player;
    const dist = p ? this.distTo(p) : 999;
    if (p && dist <= 48) {
      this.pos.y += Math.sin(this.age * 0.2) * 0.01;   // bob
      if (this.attackCooldown === 0) {
        this.charge++;
        if (this.charge >= 30) { this.burst(p); this.charge = 0; this.attackCooldown = 100; }
      }
    } else this.charge = 0;
    this.age++;
  }
  burst(p) {
    for (let k = 0; k < 3; k++) {
      const fb = new SmallFireball(this.world, this.pos.x, this.pos.y + 1, this.pos.z,
        p.pos.x - this.pos.x, p.pos.y - this.pos.y, p.pos.z - this.pos.z, this);
      this.world.game.entities.add(fb);
    }
    emitSound('entity.blaze.shoot', at(this.pos.x, this.pos.y, this.pos.z));
  }
  dropTable() { return this.world.rng() < 0.5 ? [{ name: 'blaze_rod', count: 1 }] : []; }
  buildMesh() { return tintBox(0.6, 1.8, [1.0, 0.75, 0.1]); }
}

// -------------------------------------------------- §7.6 Zombified Piglin
export class ZombifiedPiglin extends Mob {
  constructor(world, x, y, z) {
    super(world, x, y, z);
    this.type = 'zombified_piglin';
    this.hostile = false;                // neutral until provoked
    this.undead = true; this.fireImmune = true;
    this.width = 0.6; this.height = 1.95;
    this.health = this.maxHealth = 20; this.naturalArmor = 2;
    this.attackDamage = 8; this.attackReach = 2.0;
    this.walkSpeed = 0.115; this.chaseSpeed = 0.115;
    this.detectionRange = 0;             // only aggros when angry
    this.angerTime = 0; this.xpValue = 5;
    this.goals = [new SwimGoal(this), new MeleeAttackGoal(this), new WanderGoal(this),
      new LookAtPlayerGoal(this, 8), new IdleLookGoal(this)];
  }
  armorPoints() { return this.naturalArmor; }
  onHurt(amount, source, opts) {
    super.onHurt?.(amount, source, opts);
    // §7.6 provocation: anger self + the pack within 20 blocks
    if (opts?.attacker === this.world.game?.player) {
      this.provoke();
      for (const e of this.world.getEntitiesInBox(
        this._angerBox(), e => e.type === 'zombified_piglin' && !e.dead)) e.provoke?.();
    }
  }
  _angerBox() {
    const { AABB } = this.world.game;
    return { min: [this.pos.x - 20, this.pos.y - 10, this.pos.z - 20], max: [this.pos.x + 20, this.pos.y + 10, this.pos.z + 20], intersects: bb => Math.abs(bb.min[0] - this.pos.x) < 20 && Math.abs(bb.min[2] - this.pos.z) < 20 };
  }
  provoke() { this.hostile = true; this.detectionRange = 35; this.angerTime = 400 + Math.floor(this.world.rng() * 400); }
  tick() {
    if (this.angerTime > 0 && --this.angerTime === 0) { this.hostile = false; this.detectionRange = 0; }
    super.tick();
  }
  dropTable() {
    const r = this.world.rng, out = [];
    const f = Math.floor(r() * 2); if (f) out.push({ name: 'rotten_flesh', count: f });
    if (r() < 0.5) out.push({ name: 'gold_nugget', count: 1 });
    if (r() < 0.025) out.push(r() < 0.5 ? { name: 'gold_ingot', count: 1 } : { name: 'gold_nugget', count: 1 });
    return out;
  }
  buildMesh() { return humanoidModel('zombie_skin', 'zombie_face', {}); }
}

// -------------------------------------------------- §7.7 Wither Skeleton
export class WitherSkeleton extends Mob {
  constructor(world, x, y, z) {
    super(world, x, y, z);
    this.type = 'wither_skeleton';
    this.hostile = true; this.undead = true; this.fireImmune = true;
    this.width = 0.7; this.height = 2.4;
    this.health = this.maxHealth = 20;
    this.attackDamage = 8; this.attackReach = 2.0;
    this.walkSpeed = 0.125; this.chaseSpeed = 0.125;
    this.detectionRange = 16; this.xpValue = 5;
    this.goals = [new SwimGoal(this), new MeleeAttackGoal(this), new WanderGoal(this),
      new LookAtPlayerGoal(this, 8), new IdleLookGoal(this)];
  }
  onMeleeHit(target) {
    // §7.7 Wither I 0:10 — 09's effect engine (guarded: 09 not built yet)
    this.world.game?.addEffect?.(target, 20, 0, 200);
  }
  dropTable() {
    const r = this.world.rng, out = [];
    const bone = Math.floor(r() * 3); if (bone) out.push({ name: 'bone', count: bone });
    if (r() < 0.5) out.push({ name: 'coal', count: 1 });
    if (r() < 0.025) out.push({ name: 'wither_skeleton_skull', count: 1 });   // 13's block-item 186
    return out;
  }
  buildMesh() { return tintBox(0.7, 2.4, [0.17, 0.17, 0.16]); }
}

// -------------------------------------------------- §7.5 Magma Cube
export class MagmaCube extends Mob {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z);
    this.type = 'magma_cube';
    this.hostile = true; this.fireImmune = true;
    this.size = opts.size ?? (1 + Math.floor(world.rng() * 3) * 2 % 4 || 1);  // 1/2/4-ish
    if (![1, 2, 4].includes(this.size)) this.size = [1, 2, 4][Math.floor(world.rng() * 3)];
    const s = this.size * 0.51;
    this.width = s; this.height = s;
    this.health = this.maxHealth = this.size * this.size;
    this.attackDamage = this.size + 2;
    this.detectionRange = 16;
    this.xpValue = this.size === 4 ? 4 : this.size === 2 ? 2 : 1;
    this.hopTimer = 20 + Math.floor(world.rng() * 40);
  }
  tick() {
    this.baseTick(); if (this.dead) { this.deathTime++; return; }
    this.tickEnvironment(); if (this.dead) return;
    if (this.tickDespawn?.()) return;
    const p = this.world.game?.player;
    if (this.onGround && --this.hopTimer <= 0) {
      this.hopTimer = 40 + Math.floor(this.world.rng() * 60);
      let dx = this.world.rng() * 2 - 1, dz = this.world.rng() * 2 - 1;
      if (p && this.distTo(p) < 16) { dx = p.pos.x - this.pos.x; dz = p.pos.z - this.pos.z; }
      const len = Math.hypot(dx, dz) || 1;
      this.vel.y = 0.42 + this.size * 0.1;
      this.vel.x = dx / len * (0.10 + 0.02 * this.size);
      this.vel.z = dz / len * (0.10 + 0.02 * this.size);
    }
    // contact damage
    if (p && this.distTo(p) < this.width) p.hurt(this.size + 2, 'melee', { attacker: this });
    this.applyLocomotion?.();
    this.age++;
  }
  onDeath(source, opts) {
    // §7.5 split into 2-4 of the next size down
    if (this.size > 1) {
      const child = this.size === 4 ? 2 : 1;
      const n = 2 + Math.floor(this.world.rng() * 3);
      for (let k = 0; k < n; k++) {
        const c = new MagmaCube(this.world, this.pos.x + (this.world.rng() - 0.5), this.pos.y, this.pos.z + (this.world.rng() - 0.5), { size: child });
        c.vel.x = (this.world.rng() - 0.5) * 0.2; c.vel.z = (this.world.rng() - 0.5) * 0.2;
        this.world.game?.entities.add(c);
      }
    }
    super.onDeath?.(source, opts);
  }
  dropTable() { return this.size > 1 && this.world.rng() < 0.5 ? [{ name: 'magma_cream', count: 1 }] : []; }
  buildMesh() { const s = this.size * 0.51; return tintBox(s, s, [0.55, 0.15, 0.05]); }
}

// -------------------------------------------------- §7.8 Piglin
export class Piglin extends Mob {
  constructor(world, x, y, z) {
    super(world, x, y, z);
    this.type = 'piglin';
    this.hostile = false;                // hostile to gold-less players; simplified
    this.width = 0.6; this.height = 1.95;
    this.health = this.maxHealth = 16;
    this.attackDamage = 8; this.attackReach = 2.0;
    this.walkSpeed = 0.15; this.chaseSpeed = 0.2;
    this.detectionRange = 16; this.xpValue = 5;
    this.goals = [new SwimGoal(this), new MeleeAttackGoal(this), new WanderGoal(this),
      new LookAtPlayerGoal(this, 8), new IdleLookGoal(this)];
  }
  tick() {
    // §7.8 hostile to a player not wearing gold armour, within 16
    const p = this.world.game?.player;
    if (p && this.distTo(p) < 16) {
      const gold = p.armor?.some?.(a => a && /golden_/.test(this.world.game.ITEMS?.get?.(a.id)?.name ?? ''));
      this.hostile = !gold;
      this.detectionRange = gold ? 0 : 16;
    }
    // §7.8 zombification outside the Nether (dim != 1)
    if (this.world.activeDim !== 1) {
      this.convertTimer = (this.convertTimer ?? 0) + 1;
      if (this.convertTimer >= 300) {
        const zp = this.world.game.spawnMobAt('zombified_piglin', this.pos.x, this.pos.y, this.pos.z, {});
        this.dead = true; return;
      }
    } else this.convertTimer = 0;
    super.tick();
  }
  dropTable() { return this.world.rng() < 0.2 ? [{ name: 'gold_nugget', count: 1 }] : []; }
  buildMesh() { return humanoidModel('zombie_skin', 'zombie_face', {}); }
}
