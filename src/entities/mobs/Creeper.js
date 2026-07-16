// Creeper (05 §2, §8.3): silent approach, swell fuse, power-3 explosion.
import { Mob } from './Mob.js';
import { Goal, SwimGoal, WanderGoal, LookAtPlayerGoal, IdleLookGoal, MeleeAttackGoal } from './ai.js';
import { creeperModel } from './models.js';

class SwellGoal extends Goal {
  canStart() {
    const m = this.mob;
    return m.target && m.distTo(m.target) < 3 && m.canSee(m.target);
  }
  shouldContinue() { return this.mob.swell > 0 || this.canStart(); }
  tick() {
    const m = this.mob, t = m.target;
    const pressure = t && m.distTo(t) <= 7 && m.canSee(t);
    m.swell = Math.min(30, Math.max(0, m.swell + (pressure ? 1 : -1)));
    m.moveIntent = null;
    m.clearPath();
    if (t) m.lookAt(t.pos.x, t.pos.y + t.height * 0.85, t.pos.z);
    if (m.swell >= 30) {
      m.noDrops = true;
      m.dead = true;
      m.deathTime = m.deathAnimTicks;   // removed before damage — never hurts itself
      m.world.game?.explode(m.pos.x, m.pos.y + m.height / 2, m.pos.z, 3);
    }
  }
}

// chase like a melee mob but never lands a hit
class ChaseGoal extends MeleeAttackGoal {
  tick() {
    const m = this.mob, t = m.target;
    if (!t) return;
    m.lookAt(t.pos.x, t.pos.y + t.height * 0.85, t.pos.z);
    m.chaseTarget(t);
  }
}

export class Creeper extends Mob {
  constructor(world, x, y, z) {
    super(world, x, y, z);
    this.type = 'creeper';
    this.hostile = true;
    this.width = 0.6; this.height = 1.7;
    this.health = this.maxHealth = 20;
    this.detectionRange = 16;
    this.walkSpeed = 0.13; this.chaseSpeed = 0.13;
    this.xpValue = 5;
    this.swell = 0;
    this.goals = [
      new SwimGoal(this),
      new SwellGoal(this),
      new ChaseGoal(this),
      new WanderGoal(this),
      new LookAtPlayerGoal(this, 8),
      new IdleLookGoal(this),
    ];
  }

  dropTable() {
    return [{ name: 'gunpowder', count: Math.floor(this.world.rng() * 3) }];
  }

  buildModel() { return creeperModel(); }

  animateExtra() {
    if (!this.object3d) return;
    const s = this.swell / 30;
    const scale = (this.isBaby ? 0.5 : 1) * (1 + 0.3 * s);
    this.object3d.scale.setScalar(scale);
    // flash: emissive white toggle, faster near detonation (05 §16.3)
    const period = s >= 0.5 ? 2 : 5;
    const flash = s > 0 && (this.age % (period * 2)) < period;
    this.object3d.traverse(o => {
      if (o.isMesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of mats) {
          if (!mat.userData) continue;
          if (flash) mat.color.setRGB(2.2, 2.2, 2.2);
        }
      }
    });
  }
}
