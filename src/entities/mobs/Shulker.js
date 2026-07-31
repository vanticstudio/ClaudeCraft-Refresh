// 11-END §9 — Shulker + Shulker Bullet.
//
// Shulker (§9.1/§9.2): a STATIONARY end-city turret. It overrides tick()
// entirely (never calls applyLocomotion) — gravity-exempt, never pushed,
// persistent. It clamps to a full-solid neighbour face (order below, above,
// N, S, W, E), idles by peeking, opens fully at a player within 16 with LOS,
// and fires homing bullets while open. Natural armour 20 while sealed shut.
//
// ShulkerBullet (§9.3): a no-gravity homing projectile (05 §11 plumbing). Like
// GhastFireball it extends LivingEntity so a melee/arrow hit targets it — but
// its hurt() override just pops it harmlessly. On a living hit it deals 4 +
// Levitation I (200 t) via 09-POTIONS.
import * as THREE from 'three';
import { Mob } from './Mob.js';
import { LivingEntity } from '../Entity.js';
import { part } from './models.js';
import { makeAtlasMaterial } from '../ItemEntity.js';
import { BLOCKS } from '../../registry/blocks.js';
import { EFFECT, addEffect } from '../../status/effects.js';
import { emitSound, at } from '../../audio/engine.js';

// Neighbour cell offsets in vanilla attach order: below, above, N, S, W, E.
// The pairs (0,1)(2,3)(4,5) are opposites, so `face ^ 1` is the opening side.
const FACE_OFFSETS = [
  [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0],
];

function isFullSolid(b) { return !!b && b.opaque && b.shape === 'cube' && b.collidable; }

export class Shulker extends Mob {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z);
    this.type = 'shulker';
    this.hostile = true;
    this.fireImmune = true;                 // §9.1 immune to fire/lava
    this.persistent = true;                 // §9.1 only end-city spawns, never despawns
    this.width = 1.0; this.height = 1.0;    // grows with peek (§9.1)
    this.health = this.maxHealth = 30;
    this.detectionRange = 16;
    this.xpValue = 5;
    this.noGravity = true;                  // stationary — no gravity, never moves
    this.takesFallDamage = false;
    this.goals = [];                        // §9.2 state machine replaces goals

    this.attachFace = 0;                    // 0 below … 5 east (state nibble)
    this.peek = 0;                          // current opening 0 / 30 / 100
    this.targetPeek = 0;                    // desired opening
    this.peekHold = 0;                      // idle peek-30 hold countdown
    this.idleTimer = 20;                    // idle-roll cadence
    this.lostTicks = 0;                     // ticks since target LOS lost
    this.hasTarget = false;
    this.fireTimer = 20 + Math.floor(world.rng() * 40);
    this.bullet = null;                     // in-flight bullet (cleared on teleport)

    const f = this.findAttachFaceAt(Math.floor(x), Math.floor(y), Math.floor(z));
    if (f >= 0) this.attachFace = f;
  }

  // §9.1 — 20 armour only while fully sealed; 0 the instant the lid cracks.
  armorPoints() { return this.peek === 0 ? 20 : 0; }
  knockbackResistance() { return 1.0; }

  // ---------------------------------------------------------------- attachment
  findAttachFaceAt(x, y, z) {
    const w = this.world;
    for (let f = 0; f < 6; f++) {
      const o = FACE_OFFSETS[f];
      if (isFullSolid(BLOCKS[w.getBlock(x + o[0], y + o[1], z + o[2])])) return f;
    }
    return -1;
  }

  faceStillValid(x, y, z) {
    const o = FACE_OFFSETS[this.attachFace];
    return isFullSolid(BLOCKS[this.world.getBlock(x + o[0], y + o[1], z + o[2])]);
  }

  // §9.2 — 5 tries in the 17³ cube; cell must be air, non-liquid, ≥1 solid face.
  teleportAttempt() {
    const w = this.world;
    const ox = Math.floor(this.pos.x), oy = Math.floor(this.pos.y), oz = Math.floor(this.pos.z);
    for (let i = 0; i < 5; i++) {
      const tx = ox + Math.floor(w.rng() * 17) - 8;
      const ty = oy + Math.floor(w.rng() * 17) - 8;
      const tz = oz + Math.floor(w.rng() * 17) - 8;
      if (ty < 1 || ty > 126) continue;
      const b = BLOCKS[w.getBlock(tx, ty, tz)];
      if (b.collidable || b.fluid) continue;             // must be empty & non-liquid
      const face = this.findAttachFaceAt(tx, ty, tz);
      if (face < 0) continue;
      this.setPos(tx + 0.5, ty, tz + 0.5);
      this.prevPos.x = this.pos.x; this.prevPos.y = this.pos.y; this.prevPos.z = this.pos.z;
      this.attachFace = face;
      this.peek = this.targetPeek = 0;                   // relocate closed
      this.hasTarget = false; this.lostTicks = 0;
      this.clearBullet();
      emitSound('shulker.teleport', at(tx + 0.5, ty + 0.5, tz + 0.5));
      return true;
    }
    return false;
  }

  clearBullet() {
    if (this.bullet && !this.bullet.dead) this.bullet.pop?.();
    this.bullet = null;
  }

  // ------------------------------------------------------------------ tick
  tick() {
    this.baseTick();
    if (this.dead) { this.deathTime++; return; }
    this.tickTimers();
    if (this.hurtTimer > 0) this.hurtTimer--;
    this.tickEnvironment();                 // void-kill; fireImmune skips lava
    if (this.dead) return;

    const w = this.world;
    const cx = Math.floor(this.pos.x), cy = Math.floor(this.pos.y), cz = Math.floor(this.pos.z);

    // --- attachment maintenance (§9.2) — teleport until re-attached ---
    if (w.isLoaded?.(cx, cz)) {
      let needTP = BLOCKS[w.getBlock(cx, cy, cz)].collidable;   // own cell filled
      if (!needTP && !this.faceStillValid(cx, cy, cz)) {
        const face = this.findAttachFaceAt(cx, cy, cz);
        if (face >= 0) this.attachFace = face; else needTP = true;
      }
      // opening into a solid block is blocked
      if (!needTP && this.targetPeek > 0) {
        const of = FACE_OFFSETS[this.attachFace ^ 1];
        if (isFullSolid(BLOCKS[w.getBlock(cx + of[0], cy + of[1], cz + of[2])])) needTP = true;
      }
      if (needTP) { this.targetPeek = 0; this.teleportAttempt(); }
    }

    // --- target scan every 10 ticks (§9.2) ---
    const p = this.nearestPlayer();   // 14 AMENDS 05 §6 — nearest, not the host's own
    if (this.age % 10 === 0) {
      const seen = p && !p.dead && !p.creative &&
        this.distTo(p) <= this.detectionRange && this.canSee(p);
      if (seen) { this.hasTarget = true; this.lostTicks = 0; this.target = p; }
      else if (this.hasTarget) {
        this.lostTicks += 10;
        if (this.lostTicks >= 60) { this.hasTarget = false; this.target = null; }
      }
    }

    // --- peek state machine (§9.2) ---
    if (this.hasTarget) {
      this.targetPeek = 100;                 // open and hold
      this.peekHold = 0;
    } else if (this.peekHold > 0) {
      this.targetPeek = 30;
      if (--this.peekHold === 0) this.targetPeek = 0;
    } else if (--this.idleTimer <= 0) {
      this.idleTimer = 20;
      if (w.rng() < 0.1) { this.peekHold = 40 + Math.floor(w.rng() * 40); this.targetPeek = 30; }
      else this.targetPeek = 0;
    }

    // lid animation: 4 ticks 0↔100; armour flips exactly at peek 0
    if (this.peek < this.targetPeek) this.peek = Math.min(this.targetPeek, this.peek + 25);
    else if (this.peek > this.targetPeek) this.peek = Math.max(this.targetPeek, this.peek - 25);
    // hitbox height follows peek: 0→1.0, 30→1.2, 100→2.0
    const ext = this.peek <= 30 ? (this.peek / 30) * 0.2 : 0.2 + ((this.peek - 30) / 70) * 0.8;
    this.height = 1.0 + ext;

    // head look tracking while open (05 §16.3, LOOK-only)
    if (this.hasTarget && this.peek >= 100 && this.target) {
      this.lookAt(this.target.pos.x, this.target.pos.y + this.target.height * 0.5, this.target.pos.z);
    }

    // --- fire while fully open with a live target (§9.2/§9.3) ---
    if (this.hasTarget && this.peek >= 100 && this.target && !this.target.dead) {
      if (--this.fireTimer <= 0) {
        this.fireTimer = 20 + Math.floor(w.rng() * 40);
        this.shoot(this.target);
      }
    } else {
      this.fireTimer = 20 + Math.floor(w.rng() * 40);
    }
  }

  shoot(t) {
    const mx = this.pos.x, my = this.pos.y + this.height * 0.5, mz = this.pos.z;
    const b = new ShulkerBullet(this.world, mx, my, mz, this, t);
    this.world.game?.entities.add(b);
    this.bullet = b;
    emitSound('shulker.shoot', at(mx, my, mz));
  }

  // §9.2 — low-HP escape teleport + pack-wide aggro on the attacker.
  onHurt(dmg, source, opts) {
    super.onHurt(dmg, source, opts);
    const atk = opts?.attacker;
    if (atk && !atk.creative) {
      this.hasTarget = true; this.lostTicks = 0;
      for (const e of this.world.getEntitiesInBox(this.getAABB().expand(16, 10, 16),
        e => e.type === 'shulker' && !e.dead && e !== this)) {
        e.target = atk; e.hasTarget = true; e.lostTicks = 0;
      }
    }
    if (this.health < 15 && this.world.rng() < 0.25) this.teleportAttempt();
  }

  // §9.1 — 50% one shell, no Looting.
  dropTable() { return this.world.rng() < 0.5 ? [{ name: 'shulker_shell', count: 1 }] : []; }

  // §9.2 — box shell: fixed base + a lid that lifts and an inner body that peeks.
  buildModel() {
    const g = new THREE.Group();
    const parts = {};
    parts.base = part('shulker', 16, 8, 16, [0, 0, 0], [0, 4, 0]);
    parts.peek = part('shulker', 10, 10, 10, [0, 8, 0], [0, 1, 0]);
    parts.lid = part('shulker', 16, 8, 16, [0, 8, 0], [0, 4, 0]);
    g.add(parts.base, parts.peek, parts.lid);
    return { group: g, parts };
  }

  animateExtra() {
    if (!this.parts) return;
    const open = this.peek / 100;
    if (this.parts.lid) this.parts.lid.position.y = 0.5 + open * 0.5;
    if (this.parts.peek) this.parts.peek.position.y = 0.5 + open * 0.35;
  }

  serialize() {
    return { ...super.serialize(), attachFace: this.attachFace, peek: this.peek, hasTarget: this.hasTarget };
  }

  deserialize(rec) {
    super.deserialize(rec);
    this.attachFace = rec.attachFace ?? 0;
    this.peek = this.targetPeek = rec.peek ?? 0;
    this.hasTarget = !!rec.hasTarget;
  }
}

// ==========================================================================
// §9.3 — Shulker bullet: no-gravity axis-zigzag homing projectile.
// ==========================================================================
export class ShulkerBullet extends LivingEntity {
  constructor(world, x, y, z, owner, target) {
    super(world, x, y, z);
    this.type = 'shulker_bullet';
    this.width = this.height = 0.3125;
    this.health = this.maxHealth = 1;
    this.noGravity = true;
    this.takesFallDamage = false;
    this.owner = owner;
    this.target = target;
    this.life = 600;
    this.steerAxis = -1;                     // 0/1/2 = x/y/z
    this.steerSign = 1;
    this.steerTimer = 0;
  }

  // Punchable / shootable: any hit pops it harmlessly (never takes damage).
  hurt() { this.pop(); return false; }

  tick() {
    this.baseTick?.();
    if (this.dead) return;
    if (--this.life <= 0) { this.pop(); return; }

    const t = this.target;
    if (!t || t.dead) { this.pop(); return; }
    const dx = t.pos.x - this.pos.x;
    const dy = (t.pos.y + t.height * 0.5) - this.pos.y;
    const dz = t.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dy, dz) || 1e-4;
    if (dist > 48) { this.pop(); return; }   // §9.3 target lost > 48 blocks

    // choose the coordinate axis with the largest |delta| every 20 ticks, or
    // whenever the current axis' delta flips sign (§9.3 axis-zigzag).
    const delta = [dx, dy, dz];
    const flip = this.steerAxis >= 0 && Math.sign(delta[this.steerAxis]) !== this.steerSign;
    if (--this.steerTimer <= 0 || flip || this.steerAxis < 0) {
      this.steerTimer = 20;
      const a = [Math.abs(dx), Math.abs(dy), Math.abs(dz)];
      this.steerAxis = a[0] >= a[1] && a[0] >= a[2] ? 0 : (a[1] >= a[2] ? 1 : 2);
      this.steerSign = Math.sign(delta[this.steerAxis]) || 1;
    }

    // targetV = axisUnit·sign·0.15 on the chosen axis + 0.05·normalize(delta) elsewhere
    const tv = [dx / dist * 0.05, dy / dist * 0.05, dz / dist * 0.05];
    tv[this.steerAxis] = this.steerSign * 0.15;
    this.vel.x += (tv[0] - this.vel.x) * 0.2;
    this.vel.y += (tv[1] - this.vel.y) * 0.2;
    this.vel.z += (tv[2] - this.vel.z) * 0.2;

    // living-entity impact (skip owner / self / shulkers / other bullets)
    const box = this.getAABB();
    for (const e of this.world.getEntitiesInBox(box, e => e instanceof LivingEntity && !e.dead &&
      e !== this && e !== this.owner && e.type !== 'shulker' && e.type !== 'shulker_bullet')) {
      e.hurt(4, 'melee', { attacker: this.owner });
      addEffect(e, EFFECT.LEVITATION, 0, 200);      // §9.3 Levitation I, 10 s
      this.pop(); return;
    }

    // block / lava contact
    const nx = this.pos.x + this.vel.x, ny = this.pos.y + this.vel.y, nz = this.pos.z + this.vel.z;
    const nb = BLOCKS[this.world.getBlock(Math.floor(nx), Math.floor(ny), Math.floor(nz))];
    if (nb?.collidable || nb?.fluid === 'lava') { this.pop(); return; }
    this.pos.x = nx; this.pos.y = ny; this.pos.z = nz;

    // white end-rod trail, 1/tick
    const p = this.world.game?.particles;
    if (p) p.spawn(p.colored(0xffffff, 0.06), this.pos.x, this.pos.y, this.pos.z, 0, 0, 0, 8, 0);

    if (this.pos.y < -64 || this.pos.y > 135) this.pop();
  }

  pop() {
    if (this.dead) return;
    this.dead = true;
    emitSound('shulker_bullet.pop', at(this.pos.x, this.pos.y, this.pos.z));
    const p = this.world.game?.particles;
    if (p) for (let i = 0; i < 6; i++) {
      p.spawn(p.colored(0xffffff, 0.08), this.pos.x, this.pos.y, this.pos.z,
        (Math.random() - 0.5) * 0.06, Math.random() * 0.04, (Math.random() - 0.5) * 0.06,
        8 + (Math.random() * 4 | 0), 0.01);
    }
  }

  buildMesh() {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.3125, 0.3125, 0.3125), makeAtlasMaterial());
    m.material.userData?.baseColor?.setRGB(0.95, 0.95, 0.9);
    const g = new THREE.Group(); g.add(m); return g;
  }

  serialize() { return null; }
}
