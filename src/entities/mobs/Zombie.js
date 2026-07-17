// Zombie (05 §2, §8.1): melee 3, detection 35, burns in daylight; 5% babies.
import { Mob } from './Mob.js';
import { SwimGoal, WanderGoal, LookAtPlayerGoal, IdleLookGoal, MeleeAttackGoal } from './ai.js';
import { humanoidModel } from './models.js';
import { lootedRange, lootedRareChance } from '../../items/effects.js';

export class Zombie extends Mob {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z);
    this.type = 'zombie';
    this.hostile = true;
    this.undead = true;
    this.width = 0.6; this.height = 1.95;
    this.health = this.maxHealth = 20;
    this.naturalArmor = 2;
    this.detectionRange = 35;
    this.attackDamage = 3;
    this.attackReach = 2.0;
    this.walkSpeed = 0.12; this.chaseSpeed = 0.12;
    this.xpValue = 5;
    this.armsForward = true;
    if (opts.isBaby || (!opts.noBabyRoll && world.rng() < 0.05)) {
      this.isBaby = true;
      this.adultWidth = 0.6; this.adultHeight = 1.95;
      this.width = 0.3; this.height = 0.975;
      this.walkSpeed = this.chaseSpeed = 0.18;   // ×1.5
      this.xpValue = 12;
      this.ageTicks = Infinity;                  // baby zombies never grow
      this.undead = true;                        // but immune to burn via isBaby check
    }
    this.goals = [
      new SwimGoal(this),
      new MeleeAttackGoal(this),
      new WanderGoal(this),
      new LookAtPlayerGoal(this, 8),
      new IdleLookGoal(this),
    ];
  }

  armorPoints() { return this.naturalArmor; }

  // 08 §5.5 — flesh 0–(2+L); rare carrot/potato 2.5% + 1%×L (Looting III = 5.5%).
  dropTable(looting = 0) {
    const r = this.world.rng;
    const out = [{ name: 'rotten_flesh', count: lootedRange(r, 0, 2, looting) }];
    if (r() < lootedRareChance(0.025, looting))
      out.push({ name: r() < 0.5 ? 'carrot' : 'potato', count: 1 });
    return out;
  }

  buildModel() {
    const m = humanoidModel('zombie_skin', 'zombie_face',
      { shirt: 'zombie_shirt', pants: 'zombie_pants' });
    m.parts.armL.rotation.x = -Math.PI / 2;
    m.parts.armR.rotation.x = -Math.PI / 2;
    return m;
  }

  animateExtra(alpha, cyc) {
    // arms stay forward with a slight bob (05 §16.3)
    const bob = Math.cos(cyc * 0.6662) * 0.1 * this.swingAmount;
    this.parts.armL.rotation.x = -Math.PI / 2 + bob;
    this.parts.armR.rotation.x = -Math.PI / 2 - bob;
    if (this.attackAnim < 6) {
      const k = Math.sin(this.attackAnim / 6 * Math.PI);
      this.parts.armR.rotation.x = -Math.PI / 2 - k * 0.8;
    }
  }
}
