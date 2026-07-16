// Spider (05 §2, §8.4): light-gated hostility, wall climb, leap attack.
import { Mob } from './Mob.js';
import { Goal, SwimGoal, WanderGoal, LookAtPlayerGoal, IdleLookGoal, MeleeAttackGoal } from './ai.js';
import { spiderModel } from './models.js';

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
  }
}

export class Spider extends Mob {
  constructor(world, x, y, z) {
    super(world, x, y, z);
    this.type = 'spider';
    this.hostile = true;
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
    if (this.postAggroWalk > 0) {
      this.postAggroWalk--;
      this.moveIntent = this.walkDir;
      this.moveSpeed = this.walkSpeed;
    }
  }

  dropTable() {
    return [{ name: 'string', count: Math.floor(this.world.rng() * 3) }];
  }

  buildModel() { return spiderModel(); }
}
