// Entity base + LivingEntity (01 §13; damage pipeline 05 §14).
import { AABB } from '../math/aabb.js';
import { moveEntity, overlapsFluid, overlapsClimbable } from '../physics/collision.js';
import { AMBIENT_FLOOR, WORLD_BORDER } from '../constants.js';
import { EFFECT, clearEffects } from '../status/effects.js';   // 09-POTIONS §2

// 04 §11.1 brightness curve (JS mirror of the shader)
export function brightness(l) {
  const x = Math.min(15, Math.max(0, l)) / 15;
  return AMBIENT_FLOOR + (1 - AMBIENT_FLOOR) * (x / (4 - 3 * x));
}

export function lerp(a, b, t) { return a + (b - a) * t; }

export function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

let SCRATCH = new AABB();

export class Entity {
  constructor(world, x = 0, y = 0, z = 0) {
    this.world = world;
    this.id = 0;                              // set by EntityManager
    this.type = 'entity';
    this.pos = { x, y, z };                   // feet center
    this.prevPos = { x, y, z };
    this.vel = { x: 0, y: 0, z: 0 };          // m/tick
    this.yaw = 0; this.pitch = 0; this.prevYaw = 0;
    this.width = 0.5; this.height = 0.5;
    this.onGround = false;
    this.hitWall = false;
    this.hitCeiling = false;
    this.inWater = false;
    this.inLava = false;
    this.onLadder = false;
    this.age = 0;
    this.dead = false;
    // 10-NETHER §2/§3 — dimension membership + portal timers.
    this.dim = 0;
    this.portalTimer = 0;
    this.portalCooldown = 0;
    this.object3d = null;
    this.lightScalar = 1;
    this.chunkKey = null;                     // spatial index registration
    this.gravityBlocked = false;              // frozen outside SIM radius
    this.blockAgainstUnloaded = false;        // player only
    this.persistent = false;
  }

  getAABB() {
    return AABB.fromEntity(this.pos.x, this.pos.y, this.pos.z, this.width, this.height);
  }

  setPosFromAABB(box) {
    this.pos.x = (box.min[0] + box.max[0]) / 2;
    this.pos.y = box.min[1];
    this.pos.z = (box.min[2] + box.max[2]) / 2;
  }

  setPos(x, y, z) {
    this.pos.x = x; this.pos.y = y; this.pos.z = z;
  }

  // MUST be called first from every subclass tick()
  baseTick() {
    this.prevPos.x = this.pos.x; this.prevPos.y = this.pos.y; this.prevPos.z = this.pos.z;
    this.prevYaw = this.yaw;
    this.age++;
    if ((this.age & 3) === 0) this.sampleLight();
  }

  tick() { this.baseTick(); }

  move(dx, dy, dz) {
    moveEntity(this.world, this, dx, dy, dz);
    // world border clamp (01 §4.1)
    if (this.pos.x > WORLD_BORDER) this.pos.x = WORLD_BORDER;
    if (this.pos.x < -WORLD_BORDER) this.pos.x = -WORLD_BORDER;
    if (this.pos.z > WORLD_BORDER) this.pos.z = WORLD_BORDER;
    if (this.pos.z < -WORLD_BORDER) this.pos.z = -WORLD_BORDER;
  }

  updateMedium() {
    const box = this.getAABB();
    this.inWater = overlapsFluid(this.world, box, 'water');
    this.inLava = overlapsFluid(this.world, box, 'lava');
    this.onLadder = overlapsClimbable(this.world, box);
  }

  eyeY() { return this.pos.y + this.height * 0.85; }

  sampleLight() {
    const x = Math.floor(this.pos.x), z = Math.floor(this.pos.z);
    const y = Math.min(127, Math.max(0, Math.floor(this.eyeY())));
    const level = Math.max(
      this.world.getBlockLight(x, y, z),
      this.world.getSkyLight(x, y, z) - this.world.skyDarken,
    );
    this.lightScalar = brightness(level);
  }

  buildMesh() { return null; }   // override; THREE.Group of parts

  updateRender(alpha) {
    if (!this.object3d) return;
    this.object3d.position.set(
      lerp(this.prevPos.x, this.pos.x, alpha),
      lerp(this.prevPos.y, this.pos.y, alpha),
      lerp(this.prevPos.z, this.pos.z, alpha),
    );
    this.object3d.rotation.y = lerpAngle(this.prevYaw, this.yaw, alpha);
    this.applyLightScalar();
  }

  applyLightScalar() {
    if (!this.object3d) return;
    const s = this.lightScalar;
    const hurtMul = this.hurtTime > 0 ? 0.35 : 1;
    this.object3d.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) {
        const base = mat.userData?.baseColor;
        if (!base) continue;
        mat.color.setRGB(base.r * s, base.g * s * hurtMul, base.b * s * hurtMul);
      }
    });
  }

  serialize() {
    return {
      type: this.type,
      pos: [this.pos.x, this.pos.y, this.pos.z],
      vel: [this.vel.x, this.vel.y, this.vel.z],
      yaw: this.yaw,
    };
  }

  deserialize(rec) {
    if (rec.pos) this.setPos(rec.pos[0], rec.pos[1], rec.pos[2]);
    if (rec.vel) { this.vel.x = rec.vel[0]; this.vel.y = rec.vel[1]; this.vel.z = rec.vel[2]; }
    if (rec.yaw !== undefined) this.yaw = rec.yaw;
  }
}

// ---------------------------------------------------------------------------

export class LivingEntity extends Entity {
  constructor(world, x, y, z) {
    super(world, x, y, z);
    this.health = 20;
    this.maxHealth = 20;
    this.invulnTicks = 0;
    this.lastHurtAmount = 0;
    this.hurtTime = 0;
    this.deathTime = 0;
    this.fallDistance = 0;
    this.fireTicks = 0;
    // 09-POTIONS §2.1 — status effects + absorption pool (all living entities).
    this.effects = new Map();     // effectId → {amplifier, duration, ambient}
    this.absorption = 0;
    this.effectImmune = false;    // 13 sets this on the ender dragon (§4.3)
  }

  // 09-POTIONS §2.5 — float heal, no i-frames (used by applyInstant + Regeneration).
  heal(amount) {
    if (amount <= 0 || this.dead) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  /**
   * Ignite for `ticks` (never shortens an existing burn). 08 §5.4.3 / §5.9's
   * Flame call this; Player overrides it to apply §5.2.1's Fire Protection
   * reduction, so every ignition site routes through here rather than assigning
   * fireTicks directly.
   */
  setOnFire(ticks) {
    this.fireTicks = Math.max(this.fireTicks, Math.max(0, Math.floor(ticks)));
  }

  armorPoints() { return 0; }
  armorToughness() { return 0; }
  knockbackResistance() { return 0; }   // 10-NETHER §9.2 — netherite armor grants it (Player override)

  // Armor applicability by damage source (05 §14.2)
  // 08 §8.6 adds 'anvil': the falling anvil's damage is armor-applicable (and
  // 08 §5.2.1 folds it into blast_protection). 'thorns' was already here and
  // stays — 08 §5.2.4 explicitly makes Thorns armor-applicable too, which
  // diverges from vanilla on purpose.
  static ARMOR_SOURCES = new Set(['melee', 'arrow', 'explosion', 'cactus', 'thorns', 'anvil']);

  // Shared damage pipeline (05 §14). opts: {dirX, dirZ, knockback=0.4, attacker}
  hurt(amount, source = 'generic', opts = {}) {
    if (this.dead) return false;
    if (this.beforeHurt && this.beforeHurt(amount, source, opts) === false) return false;

    // i-frames: MC excess rule, 10 ticks
    if (this.invulnTicks > 0 && source !== 'void' && source !== 'starve') {
      if (amount <= this.lastHurtAmount) return false;
      const excess = amount - this.lastHurtAmount;
      this.lastHurtAmount = amount;
      this.applyDamage(excess, source, opts, true);
      return true;
    }
    this.invulnTicks = 10;
    this.lastHurtAmount = amount;
    this.applyDamage(amount, source, opts, false);
    return true;
  }

  applyDamage(dmg, source, opts, noNewWindow) {
    // 09-POTIONS §3 / AMENDS 03 §11 — Fire Resistance zeroes FIRE/LAVA/BURNING
    // damage (fireTicks + overlay are set elsewhere and stay).
    if ((source === 'fire' || source === 'lava' || source === 'burn') &&
        this.effects.has(EFFECT.FIRE_RESISTANCE)) dmg = 0;
    // STAGE 1 — armor (existing; magic/poison/wither are absent from ARMOR_SOURCES).
    if (LivingEntity.ARMOR_SOURCES.has(source)) {
      dmg = this.armorReduce(dmg);
      this.damageArmor?.(dmg);
    }
    // STAGE 2 (09 §4.2) — Resistance ×(1−0.2L) after armor; floored 0; L≥5 = immune.
    // Never reduces VOID or STARVATION.
    if (source !== 'void' && source !== 'starve') {
      const res = this.effects.get(EFFECT.RESISTANCE);
      if (res) dmg = Math.max(0, dmg * (1 - 0.2 * (res.amplifier + 1)));
    }
    // STAGE 3 — 08 §5.2.1 EPF (Protection) reduction. Runs AFTER armor points and
    // (for fall/fire/lava/drown) on the raw amount. Only Player implements it.
    dmg = this.reduceByEnchants?.(dmg, source, opts) ?? dmg;
    // STAGE 4 (09 §4.2) — Absorption pool eats damage before health.
    if (this.absorption > 0 && dmg > 0) {
      const absorbed = Math.min(this.absorption, dmg);
      this.absorption -= absorbed;
      dmg -= absorbed;
    }
    this.health -= dmg;
    this.hurtTime = 10;
    if (!noNewWindow && opts.dirX !== undefined) {
      this.applyKnockback(opts.knockback ?? 0.4, opts.dirX, opts.dirZ);
    }
    this.onHurt?.(dmg, source, opts);
    if (this.health <= 0) this.die(source, opts);
  }

  // MC armor formula (05 §14.2)
  armorReduce(damage) {
    const armor = this.armorPoints();
    if (armor <= 0) return damage;
    const toughness = this.armorToughness();
    const eff = Math.min(20, Math.max(armor / 5, armor - damage / (2 + toughness / 4)));
    return damage * (1 - eff / 25);
  }

  // 05 §14.3 (dir = attacker→target, normalized)
  applyKnockback(strength, dirX, dirZ) {
    // 10-NETHER §9.2 — worn kbResist scales the applied knockback (0.4 → −40%).
    strength *= 1 - Math.max(0, Math.min(1, this.knockbackResistance()));
    if (strength <= 0) return;
    this.vel.x = this.vel.x / 2 + dirX * strength;
    this.vel.z = this.vel.z / 2 + dirZ * strength;
    if (this.onGround) this.vel.y = Math.min(0.4, this.vel.y / 2 + strength);
  }

  die(source, opts) {
    this.health = 0;
    this.dead = true;
    clearEffects(this);           // 09-POTIONS §4.3 — full effect + absorption wipe on death
    this.onDeath?.(source, opts);
  }

  tickTimers() {
    if (this.invulnTicks > 0) this.invulnTicks--;
    if (this.hurtTime > 0) this.hurtTime--;
  }

  // Fall damage tracking (03 §12); call after move() with pre-move vel.y
  trackFall(velYBeforeMove, actualDy) {
    // 09-POTIONS §3.8/AMENDS 03 §12.1 — Slow Falling keeps fall distance at 0.
    if (this.effects.has(EFFECT.SLOW_FALLING)) { this.fallDistance = 0; return; }
    if (this.onLadder || this.inWater) { this.fallDistance = 0; return; }
    if (this.inLava) { this.fallDistance *= 0.5; return; }
    if (velYBeforeMove < 0 && !this.onGround && actualDy < 0) {
      this.fallDistance += -actualDy;
    }
    if (this.onGround) {
      if (this.fallDistance > 0) {
        // AMENDS 03 §12.1 — Jump Boost reduces fall damage 1 block per level.
        const jb = this.effects.get(EFFECT.JUMP_BOOST);
        let dmg = Math.ceil(this.fallDistance - 3 - (jb ? jb.amplifier + 1 : 0));
        // 12-VILLAGES AMENDS 03 §12.2 — landing on a hay bale cuts fall damage to 20%.
        if (dmg > 0 && this.world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y - 0.5), Math.floor(this.pos.z)) === 180) dmg = Math.floor(dmg * 0.2);
        if (dmg > 0 && this.takesFallDamage !== false) this.hurt(dmg, 'fall');
      }
      this.fallDistance = 0;
    }
  }
}
