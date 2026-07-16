// Passive mobs: cow, pig, sheep, chicken (05 §2, §9–§10).
import { Mob } from './Mob.js';
import {
  SwimGoal, WanderGoal, LookAtPlayerGoal, IdleLookGoal,
  PanicGoal, TemptGoal, FollowParentGoal, BreedGoal, EatGrassGoal,
} from './ai.js';
import { cowModel, pigModel, sheepModel, chickenModel } from './models.js';
import { idOf } from '../../registry/items.js';

class Passive extends Mob {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z);
    this.hostile = false;
    this.persistent = true;            // passives never despawn (05 §3.1)
    this.walkSpeed = 0.09;
    this.retaliates = false;
    if (opts.isBaby) {
      this.isBaby = true;
      this.ageTicks = 6000;            // 5 min maturity (05 §10 adaptation)
    }
  }

  // right-click hook: breeding food / feeding babies (05 §10)
  interact(player, held) {
    if (!held || held.id !== this.breedFoodId) return false;
    if (this.isBaby) {
      this.ageTicks = Math.max(0, this.ageTicks - Math.floor(this.ageTicks * 0.1));
      player.consumeHeld(1);
      return true;
    }
    if (this.breedCooldown > 0 || this.loveTicks > 0) return false;
    this.loveTicks = 600;
    player.consumeHeld(1);
    return true;
  }

  setupGoals(panicMult, extras = []) {
    this.goals = [
      new SwimGoal(this),
      new PanicGoal(this, panicMult),
      new BreedGoal(this),
      new TemptGoal(this, [this.breedFoodId]),
      new FollowParentGoal(this),
      ...extras,
      new WanderGoal(this),
      new LookAtPlayerGoal(this, 6),
      new IdleLookGoal(this),
    ];
  }

  applyBabyBox(w, h) {
    this.adultWidth = w; this.adultHeight = h;
    if (this.isBaby) { this.width = w / 2; this.height = h / 2; }
    else { this.width = w; this.height = h; }
  }
}

export class Cow extends Passive {
  constructor(world, x, y, z, opts) {
    super(world, x, y, z, opts);
    this.type = 'cow';
    this.applyBabyBox(0.9, 1.4);
    this.health = this.maxHealth = 10;
    this.xpValue = 1 + Math.floor(world.rng() * 3);
    this.breedFoodId = idOf('wheat');
    this.setupGoals(2.0);
  }
  dropTable() {
    const r = this.world.rng;
    return [
      { name: 'beef', count: 1 + Math.floor(r() * 3) },
      { name: 'leather', count: Math.floor(r() * 3) },
    ];
  }
  buildModel() { return cowModel(); }
}

export class Pig extends Passive {
  constructor(world, x, y, z, opts) {
    super(world, x, y, z, opts);
    this.type = 'pig';
    this.applyBabyBox(0.9, 0.9);
    this.health = this.maxHealth = 10;
    this.xpValue = 1 + Math.floor(world.rng() * 3);
    this.breedFoodId = idOf('carrot');
    this.setupGoals(1.25);
  }
  dropTable() {
    return [{ name: 'porkchop', count: 1 + Math.floor(this.world.rng() * 3) }];
  }
  buildModel() { return pigModel(); }
}

// spawn tint distribution (05 §9.3); item drop is always wool_white
const SHEEP_TINTS = [
  [0.81836, 0xe9e9e9], [0.05, 0x1f1f23], [0.05, 0x6e6e6e],
  [0.05, 0xa8a8a8], [0.03, 0x5d4033], [0.00164, 0xe8a5a5],
];

export class Sheep extends Passive {
  constructor(world, x, y, z, opts) {
    super(world, x, y, z, opts);
    this.type = 'sheep';
    this.applyBabyBox(0.9, 1.3);
    this.health = this.maxHealth = 8;
    this.xpValue = 1 + Math.floor(world.rng() * 3);
    this.breedFoodId = idOf('wheat');
    this.sheared = false;
    let roll = world.rng(), tint = 0xe9e9e9;
    for (const [p, c] of SHEEP_TINTS) { if (roll < p) { tint = c; break; } roll -= p; }
    this.woolTint = opts?.woolTint ?? tint;
    this.setupGoals(1.25, [new EatGrassGoal(this)]);
  }

  onAteGrass() {
    this.sheared = false;
    if (this.isBaby) this.ageTicks = Math.max(0, this.ageTicks - 1200);
    this.updateWoolVisibility();
  }

  shear(player) {
    if (this.sheared || this.isBaby) return false;
    this.sheared = true;
    const n = 1 + Math.floor(this.world.rng() * 3);
    this.world.game?.spawnItemByName('wool_white', n, this.pos.x, this.pos.y + 1, this.pos.z);
    this.updateWoolVisibility();
    return true;
  }

  interact(player, held) {
    if (held && held.id === idOf('shears')) {
      if (this.shear(player)) { player.damageHeld(1); return true; }
      return false;
    }
    return super.interact(player, held);
  }

  updateWoolVisibility() {
    if (!this.parts) return;
    if (this.parts.wool) this.parts.wool.visible = !this.sheared;
    if (this.parts.headWool) this.parts.headWool.visible = !this.sheared;
  }

  dropTable() {
    const out = [{ name: 'mutton', count: 1 + Math.floor(this.world.rng() * 2) }];
    if (!this.sheared) out.push({ name: 'wool_white', count: 1 });
    return out;
  }

  buildModel() {
    const m = sheepModel();
    const t = ((this.woolTint >> 16) & 255) / 255;
    const g = ((this.woolTint >> 8) & 255) / 255;
    const b = (this.woolTint & 255) / 255;
    for (const key of ['wool', 'headWool']) {
      m.parts[key]?.traverse(o => {
        if (o.isMesh) {
          o.material = o.material.clone();
          o.material.userData.baseColor = { r: t, g, b };
        }
      });
    }
    setTimeout(() => this.updateWoolVisibility(), 0);
    return m;
  }
}

export class Chicken extends Passive {
  constructor(world, x, y, z, opts) {
    super(world, x, y, z, opts);
    this.type = 'chicken';
    this.applyBabyBox(0.4, 0.7);
    this.health = this.maxHealth = 4;
    this.xpValue = 1 + Math.floor(world.rng() * 3);
    this.breedFoodId = idOf('wheat_seeds');
    this.takesFallDamage = false;      // 05 §9.4
    this.eggTimer = 6000 + Math.floor(world.rng() * 6001);
    this.setupGoals(1.4);
  }

  tick() {
    super.tick();
    if (this.dead) return;
    // slow fall (05 §9.4)
    if (this.vel.y < 0) this.vel.y *= 0.6;
    // egg laying
    if (!this.isBaby && --this.eggTimer <= 0) {
      this.world.game?.spawnItemByName('egg', 1, this.pos.x, this.pos.y, this.pos.z);
      this.eggTimer = 6000 + Math.floor(this.world.rng() * 6001);
    }
  }

  dropTable() {
    return [
      { name: 'chicken', count: 1 },
      { name: 'feather', count: Math.floor(this.world.rng() * 3) },
    ];
  }

  buildModel() { return chickenModel(); }

  animateExtra(alpha, cyc, sw) {
    const flap = !this.onGround && this.vel.y < 0;
    const a = flap ? 0.6 + Math.sin(this.age * 1.2) * 0.5 : 0;
    this.parts.wingL.rotation.z = a;
    this.parts.wingR.rotation.z = -a;
  }
}
