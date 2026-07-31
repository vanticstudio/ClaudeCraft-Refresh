// Spider (05 §2, §8.4): light-gated hostility, wall climb, leap attack.
import { Mob } from './Mob.js';
import { Goal, SwimGoal, WanderGoal, LookAtPlayerGoal, IdleLookGoal, MeleeAttackGoal } from './ai.js';
import { spiderModel } from './models.js';
import { lootedRange } from '../../items/effects.js';

class LeapAtTargetGoal extends Goal {
  canStart() {
    const m = this.mob, t = m.target;
    if (!t || !m.onGround) return false;
    const d = Math.hypot(t.pos.x - m.pos.x, t.pos.z - m.pos.z);
    return d >= 2 && d <= 4 && m.world.rng() < 0.2;
  }
  shouldContinue() { return false; }   // single impulse
  start() {
    const m = this.mob, t = m.target;
    const dx = t.pos.x - m.pos.x, dz = t.pos.z - m.pos.z;
    const h = Math.hypot(dx, dz) || 1;
    m.vel.x = (dx / h) * 0.4 + m.vel.x * 0.2;
    m.vel.z = (dz / h) * 0.4 + m.vel.z * 0.2;
    m.vel.y = 0.4;
    m.impulseTick = m.age;   // 05 §8.4 — don't let this tick's ground friction halve it
  }
}

// 05 §5 — "on aggro loss a spider keeps walking straight ahead for 40 ticks (this
// makes it climb walls in its path)". Driven from the goal phase so the intent
// lands BEFORE applyLocomotion and claims MOVE (postMove() ran after locomotion,
// and Mob.tick clears moveIntent next tick, so the write was never consumed).
class PostAggroWalkGoal extends Goal {
  canStart() { return this.mob.postAggroWalk > 0; }
  shouldContinue() { return this.mob.postAggroWalk > 0; }
  tick() {
    const m = this.mob;
    m.postAggroWalk--;
    m.moveIntent = m.walkDir;
    m.moveSpeed = m.walkSpeed;
  }
}

export class Spider extends Mob {
  constructor(world, x, y, z) {
    super(world, x, y, z);
    this.type = 'spider';
    this.hostile = true;
    this.arthropod = true;       // 08 §5.1 — Bane of Arthropods target
    this.poisonImmune = true;    // 09-POTIONS §4.3 — spiders resist Poison (Java parity)
    this.width = 1.4; this.height = 0.9;
    this.wide3 = true;
    this.health = this.maxHealth = 16;
    this.detectionRange = 16;
    this.attackDamage = 2;
    this.attackReach = 2.0;
    this.walkSpeed = 0.17; this.chaseSpeed = 0.17;
    this.xpValue = 5;
    this.forcedAggro = false;      // retaliation ignores the light gate
    this.postAggroWalk = 0;        // 40-tick forward walk on light-loss (05 §5)
    this.goals = [
      new SwimGoal(this),
      new LeapAtTargetGoal(this),
      new PostAggroWalkGoal(this),
      new MeleeAttackGoal(this),
      new WanderGoal(this),
      new LookAtPlayerGoal(this, 8),
      new IdleLookGoal(this),
    ];
  }

  lightHere() {
    return this.world.internalLight(
      Math.floor(this.pos.x), Math.floor(this.pos.y), Math.floor(this.pos.z));
  }

  acquireGate() { return this.lightHere() <= 11; }   // 05 §5

  updateTarget(player) {
    // chasing spider drops target in light > 11 unless retaliating
    if (this.target && !this.forcedAggro && this.lightHere() > 11) {
      this.target = null;
      this.postAggroWalk = 40;
      this.walkDir = { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
    }
    super.updateTarget(player);
  }

  postMove() {
    // wall climb: exactly MC's climb velocity while pressing into a wall (05 §7)
    if ((this.target || this.postAggroWalk > 0) && this.hitWall) {
      this.vel.y = 0.2;
    }
  }

  // 05 §16.3 melee swing — the spider head-butts. 40° rather than the spec's 120°:
  // the head pivot sits at y=9 px, so a 120° dip buries the face in the floor.
  animateExtra() {
    if (this.attackAnim < 6 && this.parts?.head) {
      this.parts.head.rotation.x -= Math.sin(this.attackAnim / 6 * Math.PI) * (40 * Math.PI / 180);
    }
  }

  // 08 §5.5 — string 0–(2+L). 09-POTIONS §11.4 — 1/3 chance of a spider_eye on a
  // player-caused death.
  dropTable(looting = 0, byPlayer = false) {
    const out = [{ name: 'string', count: lootedRange(this.world.rng, 0, 2, looting) }];
    if (byPlayer && this.world.rng() < 1 / 3) out.push({ name: 'spider_eye', count: 1 });
    return out;
  }

  buildModel() { return spiderModel(); }
}
