// B12 §3 — The Sentinel, "The Hollow" miniboss (19-BUILDOUT §B12).
// An armored 2.9-tall humanoid built on the iron_golem model at a slightly
// smaller scale (the brief's sanctioned stand-in for the spec's "own palette" —
// models.js is outside this phase's file list). Miniboss scale: no boss bar
// (spec: "NO boss bar"), gen-spawned (features.js stampHollow) and therefore
// persistent (Game.onChunkGenerated spawns gen records with persistent: true).
//
// SOUND: the pulse fires the literal 'mob.sentinel.pulse' (head height, like
// every mob emit site). Its recipe lands with the v1.3.1 voice sweep
// (src/audio/voices-hostile.js) — until then U6 flags the literal; that is the
// expected mid-overhaul state. The base Mob's dynamic `mob.${type}.hurt/death/
// idle` emissions still resolve to null (warn-once, silent) until the
// mob.sentinel.* voice rows land there too.
import { Mob } from './Mob.js';
import { SwimGoal, WanderGoal, LookAtPlayerGoal, IdleLookGoal, MeleeAttackGoal, Goal } from './ai.js';
import { humanoidModel } from './models.js';
import { addEffect, EFFECT } from '../../status/effects.js';
import { lootedRange, lootedRareChance } from '../../items/effects.js';
import { emitSound, at } from '../../audio/engine.js';

// Same deviation as blocks.js ECHO_DROP: the spec's echo_shard item does not
// resolve yet (idOf throws; item registry is outside this phase's file list),
// so the loot table pays emeralds until the orchestrator lands the item.
const ECHO_DROP = 'emerald';

// §B12 §3 — the ranged alternative: every 60 ticks within 12 blocks, a
// straight-line sonic pulse. Flags 0 (like SwimGoal) so it never blocks the
// melee chase — both can run the same tick. 2-tick windup, then one area hit:
// everything in the pulse's corridor (a 1.8-wide band along the mob→target
// line) takes 4 and a brief Slowness I (3 s). Deliberately no knockback — the
// melee hit owns the knockback stat (0.9); the pulse's job is the slow.
class SonicPulseGoal extends Goal {
  get flags() { return 0; }
  canStart() {
    const m = this.mob;
    if (!m.target || m.target.dead || m.pulseCooldown > 0) return false;
    if (m.distTo(m.target) > 12) return false;
    return m.canSee(m.target);
  }
  start() { this.windup = 2; this.mob.attackAnim = 0; }
  shouldContinue() { return this.windup > 0; }
  tick() {
    if (--this.windup > 0) return;
    this.fire();
  }
  stop() { this.windup = 0; }

  fire() {
    const m = this.mob, t = m.target;
    m.pulseCooldown = 60;
    if (!t || t.dead) return;
    if (m.distTo(t) > 12) return;
    emitSound('mob.sentinel.pulse', at(m.pos.x, m.pos.y + m.height * 0.7, m.pos.z));
    const dx = t.pos.x - m.pos.x, dz = t.pos.z - m.pos.z;
    const h = Math.hypot(dx, dz) || 1;
    const nx = dx / h, nz = dz / h;
    const dist = h;
    const cy = m.pos.y + m.height * 0.6;
    for (const e of m.world.getEntitiesInBox(
      m.getAABB().expand(Math.ceil(dist) + 2, 4, Math.ceil(dist) + 2),
      e => e !== m && !e.dead && !!e.effects)) {          // LivingEntities only
      const ex = e.pos.x - m.pos.x, ez = e.pos.z - m.pos.z;
      const along = ex * nx + ez * nz;
      if (along < -0.5 || along > dist + 2) continue;    // behind / past the line
      const perp = Math.hypot(ex - nx * along, ez - nz * along);
      if (perp > 1.8) continue;                          // outside the corridor
      if (Math.abs(e.pos.y + e.height / 2 - cy) > 3) continue;
      e.hurt(4, 'melee', { dirX: nx, dirZ: nz, knockback: 0.2, attacker: m });
      addEffect(e, EFFECT.SLOWNESS, 0, 60);              // brief slow (spec's stand-in
    }                                                    // for §B12's darkness — v1.4)
  }
}

export class Sentinel extends Mob {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z);
    this.type = 'sentinel';
    this.hostile = true;
    this.width = 1.2; this.height = 2.9;
    this.tall3 = true;                          // 05 §7 — 3-cell pathfinding clearance
    this.health = this.maxHealth = 100;
    this.detectionRange = 24;
    this.attackDamage = 8;
    this.attackReach = 2.8;
    this.walkSpeed = 0.07; this.chaseSpeed = 0.08;   // slow, per spec
    this.xpValue = 20;
    this.pulseCooldown = 0;
    this.strikeTimer = 0;                       // 2-tick melee windup countdown
    this.goals = [
      new SwimGoal(this),
      new MeleeAttackGoal(this),
      new SonicPulseGoal(this),
      new WanderGoal(this),
      new LookAtPlayerGoal(this, 8),
      new IdleLookGoal(this),
    ];
  }

  tick() {
    super.tick();
    if (this.pulseCooldown > 0) this.pulseCooldown--;
  }

  // §B12 §3 — the melee hit winds up for 2 ticks before landing (the windup is
  // the tell: attackAnim is set here, the strike lands in postMove). MeleeAttack
  // Goal set attackCooldown = 20 around this call, so exactly one windup is in
  // flight at a time.
  doMeleeAttack(t) {
    this.strikeTarget = t;
    this.strikeTimer = 2;
    this.attackAnim = 0;
  }

  // 05 §1 step 6 — resolve the windup here, after locomotion, so the strike
  // lands on the tick it is due regardless of the chase's pathing that tick.
  postMove() {
    if (this.strikeTimer > 0 && --this.strikeTimer === 0) this.landStrike();
  }

  landStrike() {
    const t = this.strikeTarget;
    this.strikeTarget = null;
    if (!t || t.dead) return;
    if (this.distTo(t) > this.attackReach + 0.6) return;   // target dashed out of range
    const dx = t.pos.x - this.pos.x, dz = t.pos.z - this.pos.z;
    const h = Math.hypot(dx, dz) || 1;
    // Strong knockback 0.9 (05 §14's default is 0.4, the iron golem's toss 0.8).
    t.hurt(this.attackDamage, 'melee', { dirX: dx / h, dirZ: dz / h, knockback: 0.9, attacker: this });
  }

  // §B12 §3 — echo shards 3–6 (Looting widens per 08 §5.5) + a 25% totem of
  // undying (ties B4). Pays emeralds until echo_shard exists — see ECHO_DROP.
  dropTable(looting = 0) {
    const r = this.world.rng;
    const out = [{ name: ECHO_DROP, count: lootedRange(r, 3, 6, looting) }];
    if (r() < lootedRareChance(0.25, looting)) out.push({ name: 'totem_of_undying', count: 1 });
    return out;
  }

  // §B12 §3 — iron_golem model scaled (1.4, 1.3, 1.4): taller and broader than
  // the golem at eye level without needing a new skin painter.
  buildModel() {
    const m = humanoidModel('iron_golem', 'iron_golem', {});
    if (m.group) m.group.scale.set(1.4, 1.3, 1.4);
    return m;
  }

  animateExtra(alpha, cyc) {
    // follow-through on the 2-tick windup tell: both arms lift as attackAnim
    // runs 0→6, mirroring the zombie's swing window (05 §16.3)
    if (this.attackAnim < 6 && this.parts?.armL) {
      const k = Math.sin(this.attackAnim / 6 * Math.PI);
      this.parts.armL.rotation.x = -k * 1.2;
      this.parts.armR.rotation.x = -k * 1.2;
    }
  }
}
