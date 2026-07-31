// Mob base class: per-tick order, targeting, despawn, daylight burn,
// locomotion contract, path following, animation driver (05 §1–§7, §16).
import { LivingEntity, lerp, lerpAngle } from '../Entity.js';
import { BLOCKS, B, matOf } from '../../registry/blocks.js';
import { hasLineOfSight } from '../../world/raycast.js';
import { findPath, astarBudgetOk, MOVE, LOOK } from './ai.js';
import { emitSound, at } from '../../audio/engine.js';
import { EFFECT, tickEffects, effectLevel, serializeEffects, applyEffectsData } from '../../status/effects.js';
import { lootingLevelOf } from '../../items/effects.js';   // 08 §5.5 — Looting level of the killing blow

const TURN_RATE = 30 * Math.PI / 180;   // 30°/tick

// 09-POTIONS §3.9 — how visible a player is to hostile detection. Sneak ×0.8;
// Invisibility ×0.07 unarmored, else ×0.175 per worn armor piece.
export function visibilityFactor(player) {
  let f = player.sneaking ? 0.8 : 1.0;
  if (player.effects?.has(EFFECT.INVISIBILITY)) {
    const pieces = player.armor.filter(Boolean).length;
    f *= (pieces === 0) ? 0.07 : 0.175 * pieces;
  }
  return f;
}

export class Mob extends LivingEntity {
  constructor(world, x, y, z) {
    super(world, x, y, z);
    this.hostile = false;
    this.undead = false;
    // 08 §5.1 — the Smite / Bane of Arthropods target tags live on the mob
    // stat block: undead = {zombie, skeleton}, arthropod = {spider}.
    // 13-BOSSES may extend these sets.
    this.arthropod = false;
    this.fireImmune = false;      // 10-NETHER AMENDS 05 §2
    this.detectionRange = 16;
    // 05 §6 — generic give-up radius is detectionRange×1.5; a mob whose §8 rules
    // define their own disengage (enderman: 800-tick lost target + daylight roll)
    // sets this to opt out of the distance drop without widening acquisition.
    this.giveUpRange = null;
    this.despawns = false;      // 05 §4 — despawn eligibility, independent of the
                                // transient `hostile` flag (neutral Nether mobs)
    this.attackDamage = 0;
    this.attackReach = 2.0;
    this.walkSpeed = 0.09;      // b/t
    this.chaseSpeed = 0.09;
    this.xpValue = 5;
    this.deathAnimTicks = 20;
    this.deathTime = 0;

    this.goals = [];            // ascending priority
    this.target = null;
    this.losMemory = 0;
    this.idleTime = 0;          // hostile-despawn timer — NOT the idle-voice one
    // 16 §3.4 idle cadence: 80 + randInt(80) ticks (4-8 s). world.rng, not
    // Math.random: mobs are seeded-deterministic. 05 §61 permits sourceless
    // timers to reset on load, so this needs no serialize() entry.
    this.nextIdle = 80 + Math.floor(world.rng() * 80);
    this.stepAccum = 0;         // 16 §3.2 mob footstep accumulator
    this.hurtTimer = 0;
    this.attackCooldown = 0;
    this.moveIntent = null;
    this.moveSpeed = 0;
    this.wantJump = false;
    // 05 §8.4 — a goal that writes vel directly (spider leap) stamps the tick it
    // fired so applyLocomotion skips the ground-friction blend for that tick only.
    this.impulseTick = -1;

    this.path = null;
    this.pathIndex = 0;
    this.pathGoal = null;
    this.lastPathTick = -99;
    this.stallPos = null;
    this.stallTicks = 0;
    this.directSteerUntil = 0;

    this.headYawRel = 0;        // relative to body yaw, clamped ±75°
    this.headPitch = 0;
    this.lookPoint = null;
    this.walkCycle = 0;
    this.prevWalkCycle = 0;
    this.swingAmount = 0;
    this.attackAnim = 99;

    this.isBaby = false;
    this.ageTicks = 0;          // baby maturity countdown
    this.breedCooldown = 0;
    this.loveTicks = 0;
    this.mate = null;
    this.eating = false;
  }

  distTo(e) { return Math.hypot(e.pos.x - this.pos.x, e.pos.y - this.pos.y, e.pos.z - this.pos.z); }

  // 14-MULTIPLAYER AMENDS 05 §6 — every player-facing test resolves the NEAREST
  // player, never game.player (which is the host's own on a host session).
  nearestPlayer() {
    const g = this.world.game;
    return g?.nearestPlayerTo?.(this.pos.x, this.pos.y, this.pos.z) ?? g?.player ?? null;
  }

  // 14-MULTIPLAYER §4.4 — the live roster for per-player tests (enderman stare,
  // creeper swell). Falls back to the single local player when there is no list.
  playerRoster() {
    const g = this.world.game;
    if (g?.players?.length) return g.players;
    return g?.player ? [g.player] : [];
  }

  centerDistTo(e) {
    return Math.hypot(e.pos.x - this.pos.x,
      (e.pos.y + e.height / 2) - (this.pos.y + this.height / 2),
      e.pos.z - this.pos.z);
  }

  canSee(e) {
    return hasLineOfSight(this.world,
      this.pos.x, this.pos.y + this.height * 0.85, this.pos.z,
      e.pos.x, e.pos.y + e.height * 0.85, e.pos.z);
  }

  lookAt(x, y, z) { this.lookPoint = { x, y, z }; }

  // ------------------------------------------------------------ tick (05 §1)

  tick() {
    this.baseTick();
    this.prevWalkCycle = this.walkCycle;

    if (this.dead) { this.deathTime++; return; }

    // 1. timers
    this.tickTimers();
    if (this.attackCooldown > 0) this.attackCooldown--;
    if (this.hurtTimer > 0) this.hurtTimer--;
    if (this.breedCooldown > 0) this.breedCooldown--;
    if (this.loveTicks > 0) this.loveTicks--;
    if (this.attackAnim < 99) this.attackAnim++;

    // baby maturity (05 §10)
    if (this.isBaby) {
      if (--this.ageTicks <= 0) this.growUp();
      if (this.loveTicks > 0 && this.age % 10 === 0) {
        this.world.game?.particles?.hearts?.(this.pos.x, this.pos.y + this.height, this.pos.z);
      }
    }
    if (this.loveTicks > 0 && this.age % 10 === 0) {
      this.world.game?.particles?.hearts?.(this.pos.x, this.pos.y + this.height + 0.3, this.pos.z);
    }

    // 1.5 status effects (09-POTIONS AMENDS 05 §1) — after timers, before environment.
    tickEffects(this);
    if (this.dead) return;   // a Wither/Poison tick may have killed the mob

    // 2. environment
    this.updateMedium();
    this.tickEnvironment();
    if (this.dead) return;

    // 3. despawn (05 §4)
    if (this.tickDespawn()) return;

    // 4. AI (skipped beyond 64 blocks — 05 §1 sim range). 13-BOSSES AMENDS 05 §1:
    // bosses (isBoss) always run full AI regardless of distance.
    const player = this.nearestPlayer();
    const pd = player ? this.distTo(player) : 999;
    this.moveIntent = null;
    this.wantJump = false;
    if (this.isBoss || pd <= 64) {
      this.updateTarget(player);
      this.runGoals();
    }

    // 5. locomotion + physics
    this.applyLocomotion();

    // 6. subclass quirks (spider climb, creeper swell handled by goals)
    this.postMove?.();

    // body yaw toward movement; head toward look point
    this.updateYaw();

    // walk animation state (05 §16.3)
    const hSpeed = Math.hypot(this.pos.x - this.prevPos.x, this.pos.z - this.prevPos.z);
    this.walkCycle += hSpeed * 4;
    this.swingAmount = this.swingAmount * 0.9 + Math.min(1, hSpeed * 8) * 0.1;

    // --- 16-AUDIO §3.4 idle cadence ---
    if (--this.nextIdle <= 0) {
      this.nextIdle = 80 + Math.floor(this.world.rng() * 80);
      // Only within 16 blocks; creepers and spiders in stalk mode stay silent —
      // MC's silent-creeper dread is a feature. `target` is the only stalk state
      // this codebase has.
      const silent = this.type === 'creeper' || (this.type === 'spider' && this.target);
      if (pd <= 16 && !silent) {
        emitSound(`mob.${this.type}.idle`, at(this.pos.x, this.pos.y + this.height / 2, this.pos.z));
      }
    }

    // --- 16-AUDIO §3.2 mob footsteps: "zombie scraping toward you in the dark" ---
    if (this.onGround && !this.inWater) {
      this.stepAccum += hSpeed;
      const thr = (this.type === 'chicken' || this.type === 'spider') ? 1.0 : 1.5;
      if (this.stepAccum >= thr) {
        this.stepAccum -= thr;
        const id = this.world.getBlock(
          Math.floor(this.pos.x), Math.floor(this.pos.y - 0.5), Math.floor(this.pos.z));
        const cls = matOf(id);
        if (cls) emitSound(`mob.step.${cls}`, at(this.pos.x, this.pos.y, this.pos.z));
      }
    }
  }

  growUp() {
    this.isBaby = false;
    this.width = this.adultWidth ?? this.width * 2;
    this.height = this.adultHeight ?? this.height * 2;
    this.needsMeshRebuild = true;
  }

  tickEnvironment() {
    // 10-NETHER AMENDS 05 §2 — fire-immune mobs never take FIRE/LAVA/BURNING
    // damage and never ignite (the whole Nether roster).
    if (!this.fireImmune) {
      if (this.inLava) {
        if (this.age % 10 === 0) this.hurt(4, 'lava');
        this.fireTicks = 300;
      }
      if (this.fireTicks > 0) {
        this.fireTicks--;
        if (this.age % 20 === 0 && !this.inLava) this.hurt(1, 'burn');
        if (this.inWater) this.fireTicks = 0;
      }
    }
    // undead daylight burning (04 §10.2, 05 §5) — never with no sky light or when immune
    if (this.undead && !this.isBaby && !this.fireImmune && this.world.hasSkyLight && this.age % 4 === 0) {
      const w = this.world;
      const eyeY = Math.floor(this.pos.y + this.height);
      if (w.skyDarken < 4 &&
          w.canSeeSky(Math.floor(this.pos.x), eyeY, Math.floor(this.pos.z)) &&
          !this.inWater &&
          !w.isRainingAt(this.pos.x, eyeY, this.pos.z)) {
        this.fireTicks = Math.max(this.fireTicks, 160);
      }
    }
    if (this.pos.y < -64) { this.deathTime = this.deathAnimTicks; this.dead = true; }
  }

  tickDespawn() {
    // 05 §4 exempts only passives and `persistent` mobs. `hostile` is transient on
    // the neutral Nether roster (piglin / zombified piglin flip it per-tick), so
    // despawn eligibility rides on the stable `despawns` flag as well — otherwise
    // those two accumulate forever against 10 §7.2's shared Nether cap.
    if ((!this.hostile && !this.despawns) || this.persistent) return false;
    const player = this.nearestPlayer();
    if (!player) return false;
    const d = this.distTo(player);
    if (d > 128) { this.despawn(); return true; }
    if (d > 32) {
      this.idleTime++;
      if (this.idleTime > 600 && this.world.rng() < 1 / 800) { this.despawn(); return true; }
    }
    return false;
  }

  despawn() {
    this.dead = true;
    this.deathTime = this.deathAnimTicks;   // no drops, instant removal
    this.noDrops = true;
  }

  // ------------------------------------------------------------ targeting (05 §6)

  updateTarget(player) {
    // AMENDS 05 §5 (give-up rules) / 18 §7.1 — a hostile already chasing a
    // player drops the target the tick that player switches to creative. Must
    // sit in the give-up branch, not the acquire branch below: an existing
    // target short-circuits this method before acquisition is ever reconsidered.
    if (this.target && (this.target.dead || this.target.creative ||
        this.distTo(this.target) > (this.giveUpRange ?? this.detectionRange * 1.5))) {
      this.target = null;
      // 05 §5 — retaliation exemption is scoped to the aggro EPISODE, not the
      // mob's lifetime: releasing the target ends it (spider's light gate again).
      this.forcedAggro = false;
    }
    if (this.target) {
      if (this.age % 10 === 0) {
        if (this.canSee(this.target)) this.losMemory = 0;
        else if (++this.losMemory >= 10) { this.target = null; this.losMemory = 0; this.forcedAggro = false; }
      }
      return;
    }
    if (!this.hostile || !player || player.dead || player.creative) return;   // 18 §7.1
    if (this.age % 10 !== 0) return;
    // 09-POTIONS §3.9 / AMENDS 05 §6 — sneak ×0.8 AND Invisibility shrink detection.
    const range = Math.max(2, this.detectionRange * visibilityFactor(player));
    if (this.distTo(player) <= range && this.acquireGate(player) && this.canSee(player)) {
      this.target = player;
      this.idleTime = 0;
    }
  }

  acquireGate() { return true; }   // spider light gate, enderman stare override

  onHurtBy(source) {
    this.hurtTimer = 100;
    this.idleTime = 0;
  }

  onHurt(dmg, source, opts) {
    this.onHurtBy(source);
    // §3.4: post-armor, damage > 0. Covers all 9 types — only Enderman overrides
    // onHurt, and it calls super first.
    if (dmg > 0) {
      emitSound(`mob.${this.type}.hurt`, at(this.pos.x, this.pos.y + this.height / 2, this.pos.z));
    }
    // 18 §7.1 — retaliation is disabled against a creative attacker: 05 §5's
    // "damaged by the player always sets target" clause is skipped. The mob
    // still takes the damage and still dies; it just never fights back.
    if (opts?.attacker && this.retaliates !== false && !opts.attacker.creative) {
      this.target = opts.attacker;
      this.forcedAggro = true;
      this.losMemory = 0;
    }
  }

  onDeath(source, opts) {
    // 05 §15 step 1 — must precede the noDrops/game guards below, both of which
    // short-circuit out and would silence the death of any no-drop mob.
    emitSound(`mob.${this.type}.death`, at(this.pos.x, this.pos.y + this.height / 2, this.pos.z));
    if (this.noDrops) return;
    const game = this.world.game;
    if (!game) return;
    // 08 §5.5 / AMENDS 05 §15 — Looting applies when the KILLING BLOW is a
    // player melee hit (or sweep) with a Looting weapon. die() has always passed
    // (source, opts) through; this override simply dropped them until now. The
    // level is threaded into dropTable so each table can widen its own ranges —
    // the §2 tables are the L=0 column and stay correct when it is 0.
    const looting = lootingLevelOf(source, opts?.attacker);
    const byPlayer = game.isPlayer ? game.isPlayer(opts?.attacker) : (opts?.attacker === game.player);   // 09-POTIONS §11.4 — any player's kill drops
    if (!this.isBaby || this.type === 'zombie') {
      for (const d of this.dropTable?.(looting, byPlayer) ?? []) {
        if (d.count > 0) game.spawnItemByName(d.name, d.count,
          this.pos.x, this.pos.y + this.height / 2, this.pos.z);
      }
    }
    const xp = this.isBaby && !this.hostile ? 0 : this.xpValue;
    if (xp > 0) game.spawnXpOrb(this.pos.x, this.pos.y + this.height / 2, this.pos.z, xp);
  }

  // ------------------------------------------------------------ goal runner (05 §6)

  runGoals() {
    let claimed = 0;
    for (const goal of this.goals) {
      if (goal.active) {
        if ((goal.flags & claimed) === 0 && goal.shouldContinue()) {
          goal.tick();
          claimed |= goal.flags;
        } else {
          goal.stop();
          goal.active = false;
        }
      } else if ((goal.flags & claimed) === 0 && goal.canStart()) {
        goal.start();
        goal.active = true;
        goal.tick();
        claimed |= goal.flags;
      }
    }
  }

  // ------------------------------------------------------------ locomotion (05 §1)

  applyLocomotion() {
    // 09-POTIONS AMENDS 03 §5.3 (mobs) — Speed/Slowness scale locomotion.
    const effMove = Math.max(0, (1 + 0.2 * effectLevel(this, EFFECT.SPEED)) * (1 - 0.15 * effectLevel(this, EFFECT.SLOWNESS)));
    const dir = this.moveIntent, speed = this.moveSpeed * effMove;
    if (dir && speed > 0) {
      if (this.onGround) {
        this.vel.x = this.vel.x * 0.5 + dir.x * speed * 0.5;
        this.vel.z = this.vel.z * 0.5 + dir.z * speed * 0.5;
      } else {
        this.vel.x += dir.x * speed * 0.05;
        this.vel.z += dir.z * speed * 0.05;
      }
    } else if (this.onGround && this.impulseTick !== this.age) {
      // 05 §8.4 — MC applies ground friction AFTER move(); an impulse written this
      // tick (spider pounce) must not be halved before it has travelled at all.
      this.vel.x *= 0.5;
      this.vel.z *= 0.5;
    }
    if (this.inWater) {
      const headY = Math.floor(this.pos.y + this.height * 0.75);
      if (BLOCKS[this.world.getBlock(Math.floor(this.pos.x), headY, Math.floor(this.pos.z))].fluid === 'water') {
        this.vel.y += 0.04;
      }
      this.vel.x *= 0.8; this.vel.z *= 0.8;
    }
    if (this.wantJump && (this.onGround || this.inWater)) this.vel.y = this.inWater ? 0.2 : 0.42;

    const vy0 = this.vel.y;
    const y0 = this.pos.y;
    this.move(this.vel.x, this.vel.y, this.vel.z);
    this.trackFall(vy0, this.pos.y - y0);
    this.vel.y = (this.vel.y - 0.08) * 0.98;
    if (!this.onGround) { this.vel.x *= 0.91; this.vel.z *= 0.91; }
    if (Math.abs(this.vel.x) < 0.003) this.vel.x = 0;
    if (Math.abs(this.vel.z) < 0.003) this.vel.z = 0;
  }

  updateYaw() {
    const dx = this.pos.x - this.prevPos.x, dz = this.pos.z - this.prevPos.z;
    let targetYaw = this.yaw;
    if (this.target) {
      targetYaw = Math.atan2(-(this.target.pos.x - this.pos.x), -(this.target.pos.z - this.pos.z));
    } else if (dx * dx + dz * dz > 1e-6) {
      targetYaw = Math.atan2(-dx, -dz);
    }
    const d = lerpAngle(this.yaw, targetYaw, 1) - this.yaw;
    this.yaw += Math.min(TURN_RATE, Math.max(-TURN_RATE, d));

    // head tracking (05 §16.3)
    if (this.lookPoint) {
      const lx = this.lookPoint.x - this.pos.x, lz = this.lookPoint.z - this.pos.z;
      const ly = this.lookPoint.y - (this.pos.y + this.height * 0.85);
      const wantYaw = Math.atan2(-lx, -lz);
      let rel = lerpAngle(this.yaw, wantYaw, 1) - this.yaw;
      rel = Math.min(75 * Math.PI / 180, Math.max(-75 * Math.PI / 180, rel));
      const wantPitch = Math.min(40 * Math.PI / 180, Math.max(-40 * Math.PI / 180,
        Math.atan2(ly, Math.hypot(lx, lz))));
      this.headYawRel += (rel - this.headYawRel) * 0.3;
      this.headPitch += (wantPitch - this.headPitch) * 0.3;
      this.lookPoint = null;
    } else {
      this.headYawRel *= 0.7;
      this.headPitch *= 0.7;
    }
  }

  // ------------------------------------------------------------ pathing (05 §7)

  pathTo(x, y, z, speed) {
    const w = this.world;
    if (!astarBudgetOk(w.time)) { this.directSteerUntil = w.time + 10; return false; }
    const sx = Math.floor(this.pos.x), sy = Math.floor(this.pos.y), sz = Math.floor(this.pos.z);
    this.path = findPath(w, this, sx, sy, sz, x, y, z);
    this.pathIndex = 0;
    this.pathGoal = { x, y, z };
    this.pathSpeed = speed ?? this.walkSpeed;
    this.lastPathTick = w.time;
    return !!this.path;
  }

  clearPath() {
    this.path = null;
    this.pathGoal = null;
    this.moveIntent = null;
  }

  followPath(speed = this.pathSpeed ?? this.walkSpeed) {
    if (!this.path || this.pathIndex >= this.path.length) { this.path = null; return false; }
    const wp = this.path[this.pathIndex];
    const tx = wp.x + 0.5, tz = wp.z + 0.5;
    const dx = tx - this.pos.x, dz = tz - this.pos.z;
    const hd = Math.hypot(dx, dz);
    if (hd < 0.35 && Math.abs(wp.y - this.pos.y) < 1.2) {
      this.pathIndex++;
      return this.followPath(speed);
    }
    this.moveIntent = { x: dx / (hd || 1), z: dz / (hd || 1) };
    this.moveSpeed = speed;
    if (wp.y > this.pos.y + 0.5 && hd < 1.4) this.wantJump = true;
    if (this.hitWall && this.onGround) this.wantJump = true;

    // stall detection (05 §7)
    if (this.age % 20 === 0) {
      if (this.stallPos &&
          Math.hypot(this.pos.x - this.stallPos.x, this.pos.z - this.stallPos.z) < 0.5) {
        this.path = null;
      }
      this.stallPos = { x: this.pos.x, z: this.pos.z };
    }
    return true;
  }

  chaseTarget(t, speed = this.chaseSpeed) {
    const w = this.world;
    const gx = Math.floor(t.pos.x), gy = Math.floor(t.pos.y), gz = Math.floor(t.pos.z);
    const needRepath = !this.path
      || (this.pathGoal &&
          Math.hypot(gx - this.pathGoal.x, gz - this.pathGoal.z) >= 1 &&
          w.time - this.lastPathTick >= 10)
      || w.time - this.lastPathTick >= 40;
    if (needRepath && w.time >= this.directSteerUntil) {
      if (!this.pathTo(gx, gy, gz, speed)) {
        if (!this.path) this.directSteerUntil = Math.max(this.directSteerUntil, w.time + 60);
      }
    }
    if (this.path) {
      this.followPath(speed);
    } else {
      // direct steer fallback
      const dx = t.pos.x - this.pos.x, dz = t.pos.z - this.pos.z;
      const hd = Math.hypot(dx, dz) || 1;
      this.moveIntent = { x: dx / hd, z: dz / hd };
      this.moveSpeed = speed;
      if (this.hitWall && this.onGround) this.wantJump = true;
    }
  }

  doMeleeAttack(t) {
    const dx = t.pos.x - this.pos.x, dz = t.pos.z - this.pos.z;
    const h = Math.hypot(dx, dz) || 1;
    // 09-POTIONS AMENDS 05 §13.1 — Strength/Weakness apply to mob melee too.
    const dmg = Math.max(0, this.attackDamage
      + 3 * effectLevel(this, EFFECT.STRENGTH) - 4 * effectLevel(this, EFFECT.WEAKNESS));
    t.hurt(dmg, 'melee', {
      dirX: dx / h, dirZ: dz / h, knockback: 0.4, attacker: this,
    });
    this.attackAnim = 0;
  }

  // ------------------------------------------------------------ render (05 §16.3)

  buildMesh() {
    const built = this.buildModel?.();
    if (!built) return null;
    this.parts = built.parts;
    if (this.isBaby) {
      built.group.scale.setScalar(0.5);
      this.parts.head?.scale.setScalar(1.4);
    }
    return built.group;
  }

  updateRender(alpha) {
    if (!this.object3d) return;
    const a = this.isPuppet ? 1 : alpha;   // 14 §4.4 — puppet positions are already interpolated by NetClient.renderTick
    this.object3d.position.set(
      lerp(this.prevPos.x, this.pos.x, a),
      lerp(this.prevPos.y, this.pos.y, a),
      lerp(this.prevPos.z, this.pos.z, a));
    // model faces +Z; entity yaw 0 faces −Z
    this.object3d.rotation.y = lerpAngle(this.prevYaw, this.yaw, a) + Math.PI;

    // death fall-over (05 §16.3)
    if (this.dead) {
      const t = Math.min(1, Math.sqrt(Math.min(1, this.deathTime / 10)));
      this.object3d.rotation.z = t * Math.PI / 2;
      if (this.deathTime > 10) this.object3d.position.y -= 0.2 * (this.deathTime - 10) / 10;
      this.hurtTime = 5;   // hold the red tint
    }

    this.applyLightScalar();
    // 14 §4.4 — NetClient._applyPuppetState advances prevWalkCycle→walkCycle
    // once per FRAME as well, so the limb swing needs the same `a`.
    this.animate(a);
  }

  animate(alpha) {
    const p = this.parts;
    if (!p) return;
    const cyc = lerp(this.prevWalkCycle, this.walkCycle, alpha);
    const sw = this.swingAmount;
    const leg = (phase) => Math.cos(cyc * 0.6662 + phase) * 1.4 * sw;

    if (p.legFL) {          // quadruped: diagonal pairs in phase
      p.legFL.rotation.x = leg(0);
      p.legBR.rotation.x = leg(0);
      p.legFR.rotation.x = leg(Math.PI);
      p.legBL.rotation.x = leg(Math.PI);
    } else if (p.legL && p.legR) {
      p.legL.rotation.x = leg(0);
      p.legR.rotation.x = leg(Math.PI);
      if (p.legL2) { p.legL2.rotation.x = leg(Math.PI); p.legR2.rotation.x = leg(0); }
    }
    if (p.armL && !this.armsForward) {
      p.armL.rotation.x = leg(Math.PI) * 0.8;
      p.armR.rotation.x = leg(0) * 0.8;
    }
    if (p.legs) {           // spider splay wiggle
      for (let i = 0; i < p.legs.length; i++) {
        const l = p.legs[i];
        l.rotation.y = l.userData.baseRotY +
          Math.cos(cyc * 0.6662 + (i >> 1) * Math.PI / 2) * 0.4 * sw * l.userData.side;
      }
    }
    if (p.head) {
      p.head.rotation.y = this.headYawRel;
      p.head.rotation.x = this.eating
        ? 40 * Math.PI / 180 + Math.sin(this.age * 0.8) * 0.1
        : -this.headPitch;
    }
    this.animateExtra?.(alpha, cyc, sw);
  }

  // ------------------------------------------------------------ persistence (05 §1)

  serialize() {
    return {
      type: this.type,
      pos: [this.pos.x, this.pos.y, this.pos.z],
      vel: [this.vel.x, this.vel.y, this.vel.z],
      yaw: this.yaw,
      health: this.health,
      persistent: this.persistent,
      isBaby: this.isBaby, ageTicks: this.ageTicks,
      breedCooldown: this.breedCooldown, loveTicks: this.loveTicks,
      sheared: this.sheared, woolTint: this.woolTint,
      eggTimer: this.eggTimer, swell: this.swell, aggro: this.aggro,
      effects: serializeEffects(this), absorption: this.absorption,   // 09-POTIONS §16
    };
  }

  deserialize(rec) {
    super.deserialize(rec);
    this.health = rec.health ?? this.health;
    this.persistent = rec.persistent ?? this.persistent;
    // 05 §10 — baby state must survive a reload EXACTLY. The constructor may have
    // already applied a baby box (Zombie's own 5% roll, Villager's opts.isBaby), so
    // the halving is idempotent, and an adult record always beats a ctor-rolled
    // baby. `ageTicks` may come back as null (JSON drops the baby zombie's
    // Infinity), so the ctor's value is the fallback before the 6000 default.
    if (rec.isBaby) {
      if (!this.isBaby) {
        this.isBaby = true;
        this.adultWidth = this.width; this.adultHeight = this.height;
        this.width /= 2; this.height /= 2;
      }
      this.ageTicks = rec.ageTicks ?? this.ageTicks ?? 6000;
    } else if (this.isBaby) {
      this.isBaby = false;
      this.width = this.adultWidth ?? this.width * 2;
      this.height = this.adultHeight ?? this.height * 2;
    }
    this.breedCooldown = rec.breedCooldown ?? 0;
    this.loveTicks = rec.loveTicks ?? 0;
    applyEffectsData(this, rec.effects);          // 09-POTIONS §16
    this.absorption = rec.absorption ?? 0;
    if (rec.sheared !== undefined) this.sheared = rec.sheared;
    if (rec.woolTint !== undefined) this.woolTint = rec.woolTint;
    if (rec.eggTimer !== undefined) this.eggTimer = rec.eggTimer;
    if (rec.swell !== undefined) this.swell = rec.swell;
    if (rec.aggro !== undefined) this.aggro = rec.aggro;
  }
}
