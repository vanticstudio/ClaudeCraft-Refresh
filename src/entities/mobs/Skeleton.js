// Skeleton (05 §2, §8.2): strafing archer, flees sun while burning.
import { Mob } from './Mob.js';
import { Goal, SwimGoal, WanderGoal, LookAtPlayerGoal, IdleLookGoal, FleeSunGoal } from './ai.js';
import { humanoidModel, skeletonBow } from './models.js';
import { Arrow } from '../Arrow.js';
import { emitSound, at } from '../../audio/engine.js';
import { lootedRange } from '../../items/effects.js';

class BowAttackGoal extends Goal {
  constructor(mob) {
    super(mob);
    this.seeTime = 0;
    this.strafeTimer = 0;
    this.strafeDir = 1;
    this.attackTimer = 20;
    this.drawTicks = 0;
  }
  canStart() { return !!this.mob.target; }
  tick() {
    const m = this.mob, t = m.target;
    if (!t) return;
    const d = m.distTo(t);
    const sees = m.canSee(t);
    this.seeTime = sees ? this.seeTime + 1 : 0;
    m.lookAt(t.pos.x, t.pos.y + t.height * 0.85, t.pos.z);

    if (d > 15 || this.seeTime < 5) {
      m.chaseTarget(t);
      m.drawing = false;
    } else {
      m.clearPath();
      if (++this.strafeTimer >= 20 && m.world.rng() < 0.3) {
        this.strafeDir *= -1;
        this.strafeTimer = 0;
      }
      const dx = t.pos.x - m.pos.x, dz = t.pos.z - m.pos.z;
      const h = Math.hypot(dx, dz) || 1;
      const fx = dx / h, fz = dz / h;
      const back = d < 11.25 ? -0.5 : 0;
      // lateral = rotate dirToTarget 90° × strafeDir
      let mx = -fz * this.strafeDir * 0.5 + fx * back;
      let mz = fx * this.strafeDir * 0.5 + fz * back;
      const mh = Math.hypot(mx, mz);
      if (mh > 1e-4) {
        m.moveIntent = { x: mx / mh, z: mz / mh };
        m.moveSpeed = m.chaseSpeed * 0.6;
      }
    }
    if (--this.attackTimer <= 0 && sees && d <= 15) {
      this.drawTicks++;
      m.drawing = true;
      if (this.drawTicks >= 20) {
        this.shoot(t);
        this.drawTicks = 0;
        this.attackTimer = 60;   // Normal: 3 s
        m.drawing = false;
      }
    } else if (this.attackTimer > 0) {
      m.drawing = false;
    }
  }
  shoot(t) {
    const m = this.mob, w = m.world;
    const speed = 1.6;
    const ex = m.pos.x, ey = m.pos.y + m.height * 0.85, ez = m.pos.z;
    let ax = t.pos.x - ex, ay = (t.pos.y + t.height / 2) - ey, az = t.pos.z - ez;
    ay += Math.hypot(ax, az) * 0.2;   // gravity compensation
    const len = Math.hypot(ax, ay, az) || 1;
    const gauss = () => {
      let u = 0, v = 0;
      while (u === 0) u = w.rng();
      while (v === 0) v = w.rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const inacc = 0.0172275 * 6;      // Normal difficulty
    const vx = (ax / len + gauss() * inacc) * speed;
    const vy = (ay / len + gauss() * inacc) * speed;
    const vz = (az / len + gauss() * inacc) * speed;
    w.game?.entities.add(new Arrow(w, ex, ey, ez, vx, vy, vz, m, { fromPlayer: false }));
    emitSound('item.bow.shoot', at(ex, ey, ez));   // §3.3: skeletons reuse, positional
    m.attackAnim = 0;
  }
  stop() { this.mob.clearPath(); this.mob.drawing = false; }
}

export class Skeleton extends Mob {
  constructor(world, x, y, z) {
    super(world, x, y, z);
    this.type = 'skeleton';
    this.hostile = true;
    this.undead = true;
    this.width = 0.6; this.height = 1.99;
    this.health = this.maxHealth = 20;
    this.detectionRange = 16;
    this.walkSpeed = 0.13; this.chaseSpeed = 0.13;
    this.xpValue = 5;
    this.goals = [
      new SwimGoal(this),
      new FleeSunGoal(this),
      new BowAttackGoal(this),
      new WanderGoal(this),
      new LookAtPlayerGoal(this, 8),
      new IdleLookGoal(this),
    ];
  }

  // 08 §5.5 — bones/arrows 0–(2+L).
  dropTable(looting = 0) {
    const r = this.world.rng;
    return [
      { name: 'bone', count: lootedRange(r, 0, 2, looting) },
      { name: 'arrow', count: lootedRange(r, 0, 2, looting) },
    ];
  }

  buildModel() {
    const m = humanoidModel('skeleton_bone', 'skeleton_face', { slimArms: true });
    const bow = skeletonBow();
    bow.position.set(-2 / 16, -8 / 16, 2 / 16);
    bow.rotation.x = 30 * Math.PI / 180;
    m.parts.armR.add(bow);
    return m;
  }

  animateExtra() {
    if (this.drawing || this.attackAnim < 3) {
      this.parts.armR.rotation.x = -Math.PI / 2 - this.headPitch;
      this.parts.armL.rotation.x = -Math.PI / 2 + 0.3;
      this.parts.armL.rotation.y = 0.4;
    } else {
      this.parts.armL.rotation.y = 0;
    }
  }
}
