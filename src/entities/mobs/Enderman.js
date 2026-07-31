// Enderman (05 §2, §8.5): neutral giant, stare provocation, teleports.
import { Mob } from './Mob.js';
import { Goal, SwimGoal, WanderGoal, LookAtPlayerGoal, IdleLookGoal, MeleeAttackGoal, standable } from './ai.js';
import { endermanModel, mobTexture } from './models.js';
import { hasLineOfSight } from '../../world/raycast.js';
import { BLOCKS } from '../../registry/blocks.js';
import { emitSound, at } from '../../audio/engine.js';
import { lootedRange } from '../../items/effects.js';

class StareDownGoal extends Goal {
  get flags() { return 3; }   // MOVE + LOOK
  canStart() {
    const m = this.mob;
    return (m.stareTicks > 0 && !m.aggro) || m.screamTicks > 0;
  }
  tick() {
    const m = this.mob;
    if (m.screamTicks > 0) m.screamTicks--;
    m.moveIntent = null;
    m.clearPath();
    const p = m.starePlayer ?? m.nearestPlayer();
    if (p) m.lookAt(p.pos.x, p.pos.y + p.eyeHeight, p.pos.z);
  }
}

export class Enderman extends Mob {
  constructor(world, x, y, z) {
    super(world, x, y, z);
    this.type = 'enderman';
    this.hostile = true;
    this.width = 0.6; this.height = 2.9;
    this.tall3 = true;
    this.health = this.maxHealth = 40;
    this.detectionRange = 16;      // post-aggro reacquire
    // 05 §8.5 — a stare provokes out to 64, but §6's generic
    // dist > detectionRange×1.5 give-up would drop that target on the same tick.
    // The enderman's disengage rules are its own: 100-tick LOS memory, the
    // 800-tick lost-target timer and the 1/500 daylight roll below.
    this.giveUpRange = Infinity;
    this.attackDamage = 7;
    this.attackReach = 2.5;
    this.walkSpeed = 0.14; this.chaseSpeed = 0.30;
    this.xpValue = 5;
    this.aggro = false;
    this.stareTicks = 0;           // max over the roster (drives the shake + goal)
    this.stareBy = new Map();      // 14 line 31 — per-player stare counters
    this.starePlayer = null;       // whoever is currently staring hardest
    this.screamTicks = 0;
    this.noLosTicks = 0;
    this.outOfReachTicks = 0;
    this.aggroLostTicks = 0;
    this.goals = [
      new SwimGoal(this),
      new StareDownGoal(this),
      new MeleeAttackGoal(this),
      new WanderGoal(this),
      new LookAtPlayerGoal(this, 8),
      new IdleLookGoal(this),
    ];
  }

  acquireGate() { return this.aggro; }

  tick() {
    if (!this.dead) this.tickEnderman();
    super.tick();
  }

  tickEnderman() {
    const w = this.world;

    // stare detection (05 §8.5) — run every tick within 64. 14-MULTIPLAYER line 31
    // (AMENDS 05 §6): "Enderman stare-trigger ... test each player independently",
    // so the 5-tick counter is per player and the first to reach 5 provokes.
    const ex = this.pos.x, ey = this.pos.y + this.height * 0.9, ez = this.pos.z;
    let topTicks = 0, topPlayer = null;
    const roster = this.playerRoster();
    for (const p of roster) {
      if (!p || p.dead || p.creative) { this.stareBy.delete(p); continue; }   // 18 §7.1 — no stare-aggro in creative
      const px = p.pos.x, py = p.pos.y + p.eyeHeight, pz = p.pos.z;
      const dx = ex - px, dy = ey - py, dz = ez - pz;
      const d = Math.hypot(dx, dy, dz);
      let staring = false;
      if (d <= 64 && d > 1e-4) {
        const cp = Math.cos(p.pitch);
        const vx = -Math.sin(p.yaw) * cp, vy = Math.sin(p.pitch), vz = -Math.cos(p.yaw) * cp;
        const dot = (vx * dx + vy * dy + vz * dz) / d;
        staring = dot > 1 - 0.025 / d && hasLineOfSight(w, px, py, pz, ex, ey, ez);
      }
      const n = staring ? (this.stareBy.get(p) ?? 0) + 1 : 0;
      if (n > 0) this.stareBy.set(p, n); else this.stareBy.delete(p);
      if (n > topTicks) { topTicks = n; topPlayer = p; }
      if (n >= 5 && !this.aggro) {
        this.aggro = true;
        this.screamTicks = 10;
        this.target = p;
        // provocation 1 of 2 (05 §8.5 stare); the !aggro guard above already
        // makes this fire exactly once per provocation
        emitSound('mob.enderman.scream', at(this.pos.x, this.pos.y + this.height / 2, this.pos.z));
      }
    }
    // Prune players that left the roster so the Map cannot pin dead references.
    // UNCONDITIONAL: the old `size > roster.length` guard could not fire in the
    // common case — one departed starer out of two players leaves size 1 against
    // roster 1 — so the removed Player (and, through Player.world, the entire
    // World it belonged to) stayed reachable from this enderman for its whole
    // life. The map holds at most one entry per player, so the walk is trivial.
    if (this.stareBy.size) {
      for (const p of [...this.stareBy.keys()]) if (!roster.includes(p)) this.stareBy.delete(p);
    }
    this.stareTicks = topTicks;
    this.starePlayer = topPlayer;

    // water / rain hurt + teleport (05 §5)
    const inRain = w.isRainingAt(this.pos.x, Math.floor(this.pos.y + this.height), this.pos.z);
    if (this.inWater || inRain) {
      if (this.age % 20 === 0) {
        this.hurt(1, 'water');
        this.teleportRandom();
      }
    }

    // daylight idle teleport (05 §5)
    if (!this.aggro && w.skyDarken < 4 &&
        w.canSeeSky(this.pos.x, Math.floor(this.pos.y + this.height), this.pos.z) &&
        w.rng() < 1 / 100) {
      if (this.teleportRandom()) this.target = null;
    }

    // aggro maintenance (05 §8.5)
    if (this.aggro && this.target) {
      this.noLosTicks = this.canSee(this.target) ? 0 : this.noLosTicks + 1;
      this.outOfReachTicks = this.centerDistTo(this.target) > this.attackReach
        ? this.outOfReachTicks + 1 : 0;
      if (this.noLosTicks >= 40 || this.outOfReachTicks >= 60) {
        this.teleportNear(this.target);
        this.noLosTicks = 0;
        this.outOfReachTicks = 0;
      }
      if (w.skyDarken < 4 && w.rng() < 1 / 500) {
        this.teleportRandom();
        this.target = null;
        this.aggro = false;
      }
    }
    if (this.aggro && !this.target) {
      if (++this.aggroLostTicks > 800) { this.aggro = false; this.aggroLostTicks = 0; }
    } else {
      this.aggroLostTicks = 0;
    }
  }

  // arrows are dodged: teleport before impact, arrow keeps flying (05 §8.5/§11)
  tryDodgeProjectile() {
    return this.teleportRandom();
  }

  seekDownStandable(x, y, z, depth) {
    for (let d = 0; d <= depth; d++) {
      const ty = y - d;
      if (ty < 1 || ty > 125) continue;
      if (standable(this.world, x, ty, z, this) &&
          !BLOCKS[this.world.getBlock(x, ty, z)].fluid) {
        return { x: x + 0.5, y: ty, z: z + 0.5 };
      }
    }
    return null;
  }

  teleportTo(c) {
    const g = this.world.game;
    g?.particles?.teleport?.(this.pos.x, this.pos.y, this.pos.z, this.height);
    // §3.4 dual emit — origin first, while pos is still the origin
    emitSound('mob.enderman.teleport', at(this.pos.x, this.pos.y + this.height / 2, this.pos.z));
    this.setPos(c.x, c.y, c.z);
    this.prevPos.x = c.x; this.prevPos.y = c.y; this.prevPos.z = c.z;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.fallDistance = 0;
    this.clearPath();
    g?.particles?.teleport?.(c.x, c.y, c.z, this.height);
    emitSound('mob.enderman.teleport', at(c.x, c.y + this.height / 2, c.z));   // destination
    return true;
  }

  teleportRandom() {
    const w = this.world;
    for (let i = 0; i < 16; i++) {
      const tx = Math.floor(this.pos.x + (w.rng() - 0.5) * 64);
      const ty = Math.min(126, Math.max(1, Math.floor(this.pos.y + (w.rng() - 0.5) * 32)));
      const tz = Math.floor(this.pos.z + (w.rng() - 0.5) * 64);
      const c = this.seekDownStandable(tx, ty, tz, 16);
      if (c) return this.teleportTo(c);
    }
    return false;
  }

  teleportNear(t) {
    const w = this.world;
    for (let i = 0; i < 16; i++) {
      const tx = Math.floor(t.pos.x + (w.rng() - 0.5) * 16);
      const ty = Math.min(126, Math.max(1, Math.floor(t.pos.y + (w.rng() - 0.5) * 8)));
      const tz = Math.floor(t.pos.z + (w.rng() - 0.5) * 16);
      const c = this.seekDownStandable(tx, ty, tz, 8);
      if (c) return this.teleportTo(c);
    }
    return false;
  }

  onHurt(dmg, source, opts) {
    super.onHurt(dmg, source, opts);
    // 18 §7.1 — "enderman retaliation likewise does not latch onto a creative
    // attacker". super.onHurt already refuses the target; without this the mob
    // would still flip aggro and scream, then sit in aggro-with-no-target for
    // the full 800-tick timeout — provoked in every way except the useful one.
    if (opts?.attacker?.creative) return;
    // provocation 2 of 2 (05 §8.5 damaged). Unlike the stare path this has no
    // !aggro guard — aggro is set on EVERY hit — so without the edge check it
    // would scream on every hit rather than on provocation.
    const wasAggro = this.aggro;
    this.aggro = true;
    this.screamTicks = 10;
    if (!wasAggro) {
      emitSound('mob.enderman.scream', at(this.pos.x, this.pos.y + this.height / 2, this.pos.z));
    }
    if (!this.dead) this.teleportRandom();
  }

  // 08 §5.5 — ender pearl 0–(1+L). The base 50/50 IS a uniform 0–1 roll, so
  // expressing it as a range keeps L=0 identical and lets Looting widen it.
  dropTable(looting = 0) {
    const n = lootedRange(this.world.rng, 0, 1, looting);
    return n > 0 ? [{ name: 'ender_pearl', count: n }] : [];
  }

  buildModel() {
    const m = endermanModel();
    this.headMesh = m.parts.head.children[0];
    return m;
  }

  animateExtra() {
    // 05 §16.3 melee swing: active arm rotX −120° → 0 over 6 ticks. Applied here
    // (after animate()) so it overrides the walk-cycle arm pose.
    if (this.attackAnim < 6 && this.parts?.armR) {
      this.parts.armR.rotation.x -= Math.sin(this.attackAnim / 6 * Math.PI) * (120 * Math.PI / 180);
    }
    // shake while stared-at / screaming; jaw texture while aggro (05 §16.3)
    if (this.object3d && (this.stareTicks > 0 || this.screamTicks > 0)) {
      this.object3d.position.x += (Math.random() - 0.5) * 0.06;
      this.object3d.position.z += (Math.random() - 0.5) * 0.06;
    }
    if (this.headMesh && Array.isArray(this.headMesh.material)) {
      const want = this.aggro ? 'enderman_face_jaw' : 'enderman_face';
      const cur = this.headMesh.userData.faceTex;
      if (cur !== want) {
        this.headMesh.userData.faceTex = want;
        this.headMesh.material[4].map = mobTexture(want);
        this.headMesh.material[4].needsUpdate = true;
      }
    }
  }
}
