// B6 §1 — the Marauder, the raid's hostile humanoid (19-BUILDOUT §B6).
// Model: humanoidModel over the villager robe painter (the brief's sanctioned
// reuse). The captain variant darkens the robe by multiplying the parts'
// baseColor — the unlit material's userData.baseColor is the palette surface
// applyLightScalar reads (Entity.js §16), so tinting there survives the
// per-frame light bake without a new painter (models.js is outside this
// phase's file list).
// Ranged: the Skeleton's BowAttackGoal mechanics re-implemented locally as
// CrossbowAttackGoal — a crossbow fires a pre-loaded BOLT (no 20-tick draw,
// flat 1.5 s reload, flatter gravity comp, wider inaccuracy). Melee fallback
// via the shared MeleeAttackGoal so a cornered crossbowman still fights.
//
// Persistence: raidId + captain serialize on the mob record (B6 §4) so a
// reloaded raider still answers to its raid and still pays the omen.
//
// SOUND DEVIATION (same as Sentinel): events.js owns every recipe and is
// outside this phase's file list, so there is no mob.marauder.* voice row —
// the base Mob's dynamic `mob.${type}.hurt/death/idle` emissions resolve to
// null (warn-once, silent) until the orchestrator adds rows. The only literal
// id emitted here (`item.bow.shoot`) already exists (skeletons use it), so U6
// stays green.
import { Mob } from './Mob.js';
import { Goal, SwimGoal, WanderGoal, LookAtPlayerGoal, IdleLookGoal, MeleeAttackGoal } from './ai.js';
import { humanoidModel } from './models.js';
import { Arrow } from '../Arrow.js';
import { addEffect, EFFECT } from '../../status/effects.js';
import { emitSound, at } from '../../audio/engine.js';
import { lootedRange } from '../../items/effects.js';

// Drop-table names are STRINGS — Mob.onDeath routes them through
// game.spawnItemByName(name) (Zombie's 'rotten_flesh' pattern). idOf'ing at
// module load would ship numeric ids that the spawn path then throws on.
const EMERALD = 'emerald';
const IRON_INGOT = 'iron_ingot';
const ARROW_ITEM = 'arrow';

// 05 §8.2-style ranged goal (Skeleton's BowAttackGoal mechanics, crossbow
// tuned). Default MOVE flags — like the skeleton's bow goal, it OWNS movement
// while active (strafe/backpedal) and excludes the melee chase; the handoff to
// MeleeAttackGoal happens through shouldContinue() returning false inside
// melee reach, which lets the melee goal start the very same tick (runGoals).
class CrossbowAttackGoal extends Goal {
  constructor(mob) {
    super(mob);
    this.seeTime = 0;
    this.strafeTimer = 0;
    this.strafeDir = 1;
    this.attackTimer = 30;      // load the first bolt
  }
  canStart() { return !!this.mob.target; }
  shouldContinue() {
    // hand off to MeleeAttackGoal once the target is inside melee reach — a
    // raider backpedalling while a player shanks it reads badly.
    return !!this.mob.target && this.mob.distTo(this.mob.target) > this.mob.attackReach * 0.8;
  }
  tick() {
    const m = this.mob, t = m.target;
    if (!t) return;
    const d = m.distTo(t);
    const sees = m.canSee(t);
    this.seeTime = sees ? this.seeTime + 1 : 0;
    m.lookAt(t.pos.x, t.pos.y + t.height * 0.85, t.pos.z);

    if (d > 15 || this.seeTime < 5) {
      m.chaseTarget(t);
    } else {
      m.clearPath();
      if (++this.strafeTimer >= 20 && m.world.rng() < 0.3) {
        this.strafeDir *= -1;
        this.strafeTimer = 0;
      }
      const dx = t.pos.x - m.pos.x, dz = t.pos.z - m.pos.z;
      const h = Math.hypot(dx, dz) || 1;
      const fx = dx / h, fz = dz / h;
      const back = d < 9 ? -0.5 : 0;
      // lateral = rotate dirToTarget 90° × strafeDir (skeleton strafing, §8.2)
      let mx = -fz * this.strafeDir * 0.5 + fx * back;
      let mz = fx * this.strafeDir * 0.5 + fz * back;
      const mh = Math.hypot(mx, mz);
      if (mh > 1e-4) {
        m.moveIntent = { x: mx / mh, z: mz / mh };
        m.moveSpeed = m.chaseSpeed * 0.6;
      }
    }
    if (--this.attackTimer <= 0 && sees && d <= 15) {
      this.shoot(t);
      this.attackTimer = 30;    // flat 1.5 s reload — a crossbow is pre-loaded
      m.attackAnim = 0;
    }
  }
  shoot(t) {
    const m = this.mob, w = m.world;
    const speed = 1.9;
    const ex = m.pos.x, ey = m.pos.y + m.height * 0.85, ez = m.pos.z;
    let ax = t.pos.x - ex, ay = (t.pos.y + t.height / 2) - ey, az = t.pos.z - ez;
    ay += Math.hypot(ax, az) * 0.12;   // flatter than a bow — bolts arc less
    const len = Math.hypot(ax, ay, az) || 1;
    const gauss = () => {
      let u = 0, v = 0;
      while (u === 0) u = w.rng();
      while (v === 0) v = w.rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const inacc = 0.0172275 * 8;       // crossbows are less accurate than bows
    const vx = (ax / len + gauss() * inacc) * speed;
    const vy = (ay / len + gauss() * inacc) * speed;
    const vz = (az / len + gauss() * inacc) * speed;
    w.game?.entities.add(new Arrow(w, ex, ey, ez, vx, vy, vz, m, { fromPlayer: false }));
    emitSound('item.bow.shoot', at(ex, ey, ez));   // §3.3 crossbow reuses the bow voice
  }
  stop() { this.mob.clearPath(); }
}

export class Marauder extends Mob {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z);
    this.type = 'marauder';
    this.hostile = true;
    this.persistent = true;      // raiders must not despawn mid-raid (05 §4)
    this.width = 0.6; this.height = 1.95;
    this.health = this.maxHealth = 24;
    this.attackDamage = 3;
    this.attackReach = 2.0;
    this.detectionRange = 24;
    this.walkSpeed = 0.12; this.chaseSpeed = 0.12;
    this.xpValue = 5;
    this.raidId = opts.raidId ?? null;       // B6 §4 — which raid this raider owes
    // §1 — 1 in 3 Marauders is a captain: the kill grants BAD_OMEN. opts wins
    // (raid spawn paths pass the seeded roll); the world-rng fallback covers
    // direct spawns (the restore path threads opts through too).
    this.captain = opts.captain ?? (world.rng() < 1 / 3);
    this.goals = [
      new SwimGoal(this),
      new CrossbowAttackGoal(this),
      new MeleeAttackGoal(this),
      new WanderGoal(this),
      new LookAtPlayerGoal(this, 8),
      new IdleLookGoal(this),
    ];
  }

  // §1 — killing a captain grants BAD_OMEN (30 min) to the killer. Entity.die
  // hands (source, opts) through with opts.attacker = the credited killer —
  // the same path onDeath already reads for Looting. The death ALSO feeds the
  // raid's wave accounting (RaidManager.notifyRaiderDeath routes by raidId).
  onDeath(source, opts) {
    super.onDeath(source, opts);
    this.world.game?.raidManager?.notifyRaiderDeath(this);
    const killer = opts?.attacker;
    if (this.captain && killer?.effects) {
      addEffect(killer, EFFECT.BAD_OMEN, 0, 36000);   // 30 min §1
    }
  }

  // 08 §5.5 — emerald 0–1, iron 0–2; a captain always pays its emerald and
  // spills arrows for the crossbow it carried.
  dropTable(looting = 0) {
    const r = this.world.rng;
    const out = [
      { name: EMERALD, count: this.captain ? 1 : lootedRange(r, 0, 1, looting) },
      { name: IRON_INGOT, count: lootedRange(r, 0, 2, looting) },
    ];
    if (this.captain) out.push({ name: ARROW_ITEM, count: lootedRange(r, 1, 3, looting) });
    return out;
  }

  buildModel() {
    const m = humanoidModel('villager_skin', 'villager_face', { shirt: 'villager_robe', pants: 'villager_robe' });
    if (this.captain && m.group) {
      // §1 dark robe variant: multiply every part's baked baseColor toward a
      // dark slate. userData.baseColor is what applyLightScalar reads each
      // frame, so the tint survives the light bake (and is per-part-instance
      // material — part() builds fresh materials per mob, nothing shared).
      m.group.traverse(o => {
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const mat of mats) {
          const base = mat.userData?.baseColor;
          if (base) base.multiplyScalar(0.45);
        }
      });
    }
    return m;
  }

  serialize() { return { ...super.serialize(), raidId: this.raidId, captain: this.captain }; }
  deserialize(rec) {
    super.deserialize(rec);
    this.raidId = rec.raidId ?? null;
    if (rec.captain !== undefined) this.captain = !!rec.captain;
  }
}
