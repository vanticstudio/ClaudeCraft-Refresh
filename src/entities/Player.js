// Survival player: movement state machine, health, hunger, XP, inventory
// (03 full spec; hunger/XP per 06 §12–13; combat charge per 05 §13).
import { LivingEntity } from './Entity.js';
import { BLOCKS, B, matOf } from '../registry/blocks.js';
import { ITEMS } from '../registry/items.js';
import { collidesAny, overlapsBlockId } from '../physics/collision.js';
import { AABB } from '../math/aabb.js';
import { emitSound, audio } from '../audio/engine.js';

const DEG = Math.PI / 180;

export class Player extends LivingEntity {
  constructor(world) {
    super(world, 0, 80, 0);
    this.type = 'player';
    this.width = 0.6; this.height = 1.8;
    this.takesFallDamage = true;
    this.blockAgainstUnloaded = true;   // hard-blocks vs unloaded chunks (01 §12)
    this.persistent = true;

    // camera
    this.eyeHeight = 1.62;
    this.prevEyeHeight = 1.62;
    this.fovScale = 1.0;
    this.bobPhase = 0;
    this.prevBobPhase = 0;
    this.bobIntensity = 0;
    this.prevBobIntensity = 0;

    // state machines
    this.sneaking = false;
    this.sprinting = false;
    this.flying = false;
    this.gameMode = 'survival';        // 'survival' | 'debugCreative'
    this.jumpCooldown = 0;
    this.ticksSinceForward = 99;
    this.ticksSinceSpace = 99;
    this.eyeSubmerged = false;

    // survival stats
    this.air = 300;
    this.foodLevel = 20;
    this.saturation = 5.0;
    this.exhaustion = 0;
    this.foodTickTimer = 0;
    this.foodPoisonTicks = 0;

    // XP (06 §13)
    this.xpTotal = 0;
    this.xpLevel = 0;
    this.xpPoints = 0;
    this.xpPickupCooldown = 0;

    // inventory: hotbar 0–8, main 9–35, armor [helmet,chest,legs,boots],
    // offhand = slot 45 (UPDATE-08 §7.1)
    this.inventory = new Array(36).fill(null);
    this.armor = new Array(4).fill(null);
    this.offhand = null;
    this.selectedSlot = 0;

    // combat charge (05 §13.1)
    this.ticksSinceAttack = 100;
    this.lastHeldId = null;

    // use-item channel (eating / bow)
    this.usingItem = null;             // {kind:'eat'|'bow', ticks}
    this.spawnPoint = null;
    this.hurtTilt = 0;                 // camera roll on damage
    this.hurtTiltDir = 1;

    // distances for exhaustion, updated in movement
    this._moveDist = 0;

    // --- 16-AUDIO state (§3.2 / §3.3) ---
    this.stepAccum = 0;                // horizontal distance since the last step
    this.swimAccum = 0;                // ditto for swim-splashes
    this.burpTimer = 0;                // set to 10 on swallow, counts down here
    this.orbStreak = 0;                // rising XP run; resets after 40 quiet ticks
    this.orbStreakTimer = 0;
  }

  // -------------------------------------------------- inventory helpers

  get heldStack() { return this.inventory[this.selectedSlot]; }
  set heldStack(v) { this.inventory[this.selectedSlot] = v; }

  heldItem() {
    const s = this.heldStack;
    return s ? ITEMS.get(s.id) : null;
  }

  // merge into inventory; returns leftover count
  give(stack) {
    const item = ITEMS.get(stack.id);
    const max = item?.stack ?? 64;
    let remaining = stack.count;
    const stackable = max > 1 && stack.damage === undefined;
    const order = [...Array(9).keys(), ...Array.from({ length: 27 }, (_, i) => i + 9)];
    if (stackable) {
      for (const i of order) {
        const s = this.inventory[i];
        if (s && s.id === stack.id && (s.damage ?? 0) === (stack.damage ?? 0) && s.count < max) {
          const add = Math.min(max - s.count, remaining);
          s.count += add; remaining -= add;
          if (remaining === 0) return 0;
        }
      }
    }
    for (const i of order) {
      if (!this.inventory[i]) {
        const put = Math.min(max, remaining);
        this.inventory[i] = { id: stack.id, count: put };
        if (stack.damage !== undefined) this.inventory[i].damage = stack.damage;
        remaining -= put;
        if (remaining === 0) return 0;
      }
    }
    return remaining;
  }

  consumeHeld(n = 1) {
    const s = this.heldStack;
    if (!s) return;
    s.count -= n;
    if (s.count <= 0) this.heldStack = null;
  }

  // durability spend (06 §7.1); returns true if the tool broke
  damageHeld(n = 1) {
    if (this.gameMode === 'debugCreative') return false;
    const s = this.heldStack;
    if (!s) return false;
    const item = ITEMS.get(s.id);
    if (!item?.durability) return false;
    s.damage = (s.damage ?? 0) + n;
    if (s.damage >= item.durability) {
      this.heldStack = null;
      // Most callers ignore this return value, so the emit lives here rather
      // than at the six call sites.
      emitSound('player.item_break', null);
      return true;
    }
    return false;
  }

  armorPoints() {
    let p = 0;
    for (const s of this.armor) if (s) p += ITEMS.get(s.id)?.armorPoints ?? 0;
    return p;
  }

  armorToughness() {
    let t = 0;
    for (const s of this.armor) if (s) t += ITEMS.get(s.id)?.toughness ?? 0;
    return t;
  }

  damageArmor(dmg) {
    if (dmg < 1) return;
    const loss = Math.max(1, Math.floor(dmg / 4));
    for (let i = 0; i < 4; i++) {
      const s = this.armor[i];
      if (!s) continue;
      const item = ITEMS.get(s.id);
      s.damage = (s.damage ?? 0) + loss;
      if (s.damage >= (item?.durability ?? 1)) {
        this.armor[i] = null;
        emitSound('player.item_break', null);   // §3.3 covers armor, not just tools
      }
    }
  }

  // -------------------------------------------------- XP (06 §13)

  xpToNext(L) {
    if (L <= 15) return 2 * L + 7;
    if (L <= 30) return 5 * L - 38;
    return 9 * L - 158;
  }

  addXp(n) {
    const before = this.xpLevel;
    this.xpTotal += n;
    this.xpPoints += n;
    while (this.xpPoints >= this.xpToNext(this.xpLevel)) {
      this.xpPoints -= this.xpToNext(this.xpLevel);
      this.xpLevel++;
    }
    // One chime per grant, not one per level: deserialize() replays the whole
    // ladder through here on every world load, and a big orb can cross two levels.
    if (this.xpLevel > before && !this._silentXp) emitSound('player.levelup', null);
  }

  // -------------------------------------------------- exhaustion / hunger (06 §12)

  addExhaustion(v) {
    if (this.gameMode === 'debugCreative') return;
    this.exhaustion += v;
  }

  tickHunger() {
    if (this.gameMode === 'debugCreative') return;
    if (this.foodPoisonTicks > 0) {
      this.foodPoisonTicks--;
      this.exhaustion += 0.005;
    }
    while (this.exhaustion >= 4.0) {
      this.exhaustion -= 4.0;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1.0);
      else if (this.foodLevel > 0) this.foodLevel--;
    }
    this.foodTickTimer++;
    if (this.foodLevel >= 20 && this.saturation > 0 && this.health < 20) {
      if (this.foodTickTimer >= 10) {
        const heal = Math.min(1.0, this.saturation / 6.0);
        this.health = Math.min(20, this.health + heal);
        this.exhaustion += 6.0 * heal;
        this.foodTickTimer = 0;
      }
    } else if (this.foodLevel >= 18 && this.health < 20) {
      if (this.foodTickTimer >= 80) {
        this.health = Math.min(20, this.health + 1);
        this.exhaustion += 6.0;
        this.foodTickTimer = 0;
      }
    } else if (this.foodLevel <= 0) {
      if (this.foodTickTimer >= 80) {
        if (this.health > 1) this.hurt(1, 'starve');   // Normal floor 1 HP
        this.foodTickTimer = 0;
      }
    } else {
      this.foodTickTimer = 0;
    }
  }

  eat(item) {
    this.foodLevel = Math.min(20, this.foodLevel + item.hunger);
    this.saturation = Math.min(this.foodLevel, this.saturation + item.saturation);
    if (item.poisonChance && this.world.rng() < item.poisonChance) {
      this.foodPoisonTicks = 600;
    }
  }

  // -------------------------------------------------- tick (03 §4 order)

  // §3.2: the under-feet cell, skipped silently for the classes with no verb.
  emitStep(gainMult) {
    const id = this.world.getBlock(
      Math.floor(this.pos.x), Math.floor(this.pos.y - 0.5), Math.floor(this.pos.z));
    const cls = matOf(id);
    if (!cls) return;
    emitSound(`block.step.${cls}`, null, 1, gainMult);
  }

  tick(input) {
    this.baseTick();
    this.prevEyeHeight = this.eyeHeight;
    this.prevBobPhase = this.bobPhase;
    this.prevBobIntensity = this.bobIntensity;

    // 1. timers
    this.tickTimers();
    if (this.jumpCooldown > 0) this.jumpCooldown--;
    if (this.xpPickupCooldown > 0) this.xpPickupCooldown--;
    // §3.3: burp fires 10 ticks after the swallow, always.
    if (this.burpTimer > 0 && --this.burpTimer === 0) emitSound('player.eat.burp', null);
    // §3.3: orbStreak resets after 40 ticks without a pickup.
    if (this.orbStreakTimer > 0 && --this.orbStreakTimer === 0) this.orbStreak = 0;
    if (this.hurtTilt > 0) this.hurtTilt = Math.max(0, this.hurtTilt - 0.8);
    this.ticksSinceForward++;
    this.ticksSinceSpace++;
    this.ticksSinceAttack++;
    if ((this.heldStack?.id ?? null) !== this.lastHeldId) {
      this.lastHeldId = this.heldStack?.id ?? null;
      this.ticksSinceAttack = 0;                        // item switch resets charge
    }

    // 2. dead?
    if (this.dead) return;

    // 3–4. sneak + sprint state
    this.updateSneak(input);
    this.updateSprint(input);

    // 5. medium
    // inWater still holds last tick's value until updateMedium() overwrites it —
    // the only previous-medium state there is, and vel.y is still the pre-move
    // velocity, which is exactly §3.3's `vy` for the entry test.
    const wasInWater = this.inWater;
    this.updateMedium();
    if (this.inWater && !wasInWater && this.vel.y < -0.3) {
      // gain scales 0.3-0.8 with entry speed (§3.3)
      const g = Math.min(0.8, 0.3 + Math.abs(this.vel.y) * 0.5);
      emitSound('player.splash', null, 1, g);
    }
    const eye = { x: this.pos.x, y: this.pos.y + this.eyeHeight, z: this.pos.z };
    const eyeBlock = this.world.getBlock(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z));
    this.eyeSubmerged = eyeBlock === B.WATER;

    // 6. movement branch
    const velYBefore = this.vel.y;
    const y0 = this.pos.y;
    if (this.flying) this.flightMove(input);
    else if (this.inLava) this.lavaMove(input);
    else if (this.inWater) this.waterMove(input);
    else this.landMove(input);

    // 7. fall damage
    // trackFall() zeroes fallDistance unconditionally on the landing tick, so the
    // landing sound has to read it first.
    const fdBefore = this.fallDistance;
    if (!this.flying) {
      this.trackFall(velYBefore, this.pos.y - y0);
    } else {
      this.fallDistance = 0;
    }
    // Landing (§3.3 / §3.2). The medium guards matter: trackFall also zeroes on
    // ladder/water and halves in lava, any of which can leave onGround true with
    // a stale fdBefore and fake a landing on a submerged floor.
    if (!this.flying && this.onGround && fdBefore > 0 &&
        !this.inWater && !this.inLava && !this.onLadder) {
      const dmg = Math.ceil(fdBefore - 3);
      if (dmg > 0) {
        // player.hurt suppresses source 'fall' so this doesn't double up
        emitSound('player.fall.big', null, 1, (0.6 + 0.1 * Math.min(dmg, 10)) / 0.6);
      } else if (fdBefore >= 0.5) {
        emitSound('player.fall.small', null);
      }
      // §3.2: landing from a fall > 0.5 also emits one step at gain x1.5
      if (fdBefore > 0.5) this.emitStep(1.5);
    }

    // 8. environmental damage
    this.tickEnvironment();

    // 11. hunger drain/regen
    this.tickHunger();

    // 18.4 view bobbing
    const hSpeed = Math.hypot(this.pos.x - this.prevPos.x, this.pos.z - this.prevPos.z);
    if (this.onGround && !this.flying) {
      const target = Math.min(1, hSpeed / 0.2806);
      this.bobIntensity += (target - this.bobIntensity) * 0.4;
      this.bobPhase += hSpeed * 1.5;
    } else {
      this.bobIntensity *= 0.8;
    }

    // Footsteps (16 §3.2). Cadence is emergent from 03 §5's speeds rather than a
    // timer: walk 4.317 m/s -> 2.9 steps/s, sprint -> 3.7/s, sneak -> 0.86/s.
    if (this.onGround && !this.inWater && !this.flying) {
      this.stepAccum += hSpeed;
      if (this.stepAccum >= 1.5) {
        this.stepAccum -= 1.5;
        this.emitStep(this.sneaking ? 0.5 : 1);     // sneaking: -6 dB
      }
    } else if (this.inWater) {
      this.stepAccum = 0;
      this.swimAccum += hSpeed;
      if (this.swimAccum >= 1.8) {                  // §3.2 swim-step
        this.swimAccum -= 1.8;
        emitSound('player.splash', null, 1, 0.35);
      }
    }

    // eye height lerp (03 §2.2)
    const targetEye = this.sneaking ? 1.27 : 1.62;
    this.eyeHeight += (targetEye - this.eyeHeight) * 0.5;

    // FOV effect (03 §18.3)
    const targetFov = (this.sprinting || (this.flying && this.sprinting)) ? 1.10 : 1.0;
    this.fovScale += (targetFov - this.fovScale) * 0.5;
  }

  // -------------------------------------------------- movement branches

  facingXZ() {
    return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
  }

  inputAccel(strafe, forward, speed) {
    const d2 = strafe * strafe + forward * forward;
    if (d2 < 1e-7) return { ax: 0, az: 0 };
    const scale = speed / Math.max(Math.sqrt(d2), 1.0);
    const fwd = this.facingXZ();
    const rightX = -fwd.z, rightZ = fwd.x;
    return {
      ax: (rightX * strafe + fwd.x * forward) * scale,
      az: (rightZ * strafe + fwd.z * forward) * scale,
    };
  }

  moveInputs(input) {
    let strafe = input.strafe * 0.98;
    let forward = input.forward * 0.98;
    if (this.sneaking) { strafe *= 0.3; forward *= 0.3; }
    return { strafe, forward };
  }

  groundSlip() {
    const x = Math.floor(this.pos.x), z = Math.floor(this.pos.z);
    const y = Math.floor(this.pos.y - 0.5);
    return BLOCKS[this.world.getBlock(x, y, z)].slipperiness ?? 0.6;
  }

  landMove(input) {
    const { strafe, forward } = this.moveInputs(input);
    const slip = this.groundSlip();
    const mult = this.sprinting ? 1.3 : 1.0;
    const speed = this.onGround
      ? 0.1 * mult * Math.pow(0.6 / slip, 3)
      : 0.02 * mult;

    // jump BEFORE the move (03 §6.2)
    if (input.jump && this.onGround && this.jumpCooldown === 0) {
      this.vel.y = 0.42;
      if (this.sprinting) {
        const fwd = this.facingXZ();
        this.vel.x += 0.2 * fwd.x;
        this.vel.z += 0.2 * fwd.z;
        this.addExhaustion(0.2);
      } else {
        this.addExhaustion(0.05);
      }
      this.jumpCooldown = 10;
    }

    const { ax, az } = this.inputAccel(strafe, forward, speed);
    this.vel.x += ax; this.vel.z += az;

    // ladders (03 §9)
    if (this.onLadder) {
      this.vel.x = Math.min(0.15, Math.max(-0.15, this.vel.x));
      this.vel.z = Math.min(0.15, Math.max(-0.15, this.vel.z));
      if (input.strafe !== 0 || input.forward !== 0 || input.jump) {
        this.vel.y = Math.max(this.vel.y, 0.2);
      }
      if (this.sneaking) this.vel.y = Math.max(this.vel.y, 0);
      this.vel.y = Math.max(this.vel.y, -0.15);
      this.fallDistance = 0;
    }

    const [dx, dz] = this.sneakEdgeClamp(this.vel.x, this.vel.z);
    this.move(dx, this.vel.y, dz);

    const friction = this.onGround ? slip * 0.91 : 0.91;
    this.vel.x *= friction; this.vel.z *= friction;
    this.vel.y = (this.vel.y - 0.08) * 0.98;
    this.snapTinyVel();
  }

  waterMove(input) {
    if (input.jump) this.vel.y += 0.04;
    const { strafe, forward } = this.moveInputs(input);
    const { ax, az } = this.inputAccel(strafe, forward, 0.02);
    this.vel.x += ax; this.vel.z += az;
    const px = this.pos.x, pz = this.pos.z;
    this.move(this.vel.x, this.vel.y, this.vel.z);
    this.addExhaustion(0.01 * Math.hypot(this.pos.x - px, this.pos.z - pz));
    this.vel.x *= 0.8; this.vel.y *= 0.8; this.vel.z *= 0.8;
    this.vel.y -= 0.005;
    if (this.hitWall && this.isClearForHop()) this.vel.y = 0.3;   // shore hop
    this.fallDistance = 0;
    this.snapTinyVel();
  }

  lavaMove(input) {
    if (input.jump) this.vel.y += 0.04;
    const { strafe, forward } = this.moveInputs(input);
    const { ax, az } = this.inputAccel(strafe, forward, 0.02);
    this.vel.x += ax; this.vel.z += az;
    this.move(this.vel.x, this.vel.y, this.vel.z);
    this.vel.x *= 0.5; this.vel.y *= 0.5; this.vel.z *= 0.5;
    this.vel.y -= 0.02;
    if (this.hitWall && this.isClearForHop()) this.vel.y = 0.3;
    this.fallDistance *= 0.5;
    this.snapTinyVel();
  }

  flightMove(input) {
    const speed = 0.049 * (this.sprinting ? 2.0 : 1.0);
    const { strafe, forward } = this.moveInputs(input);
    const { ax, az } = this.inputAccel(strafe, forward, speed);
    this.vel.x += ax; this.vel.z += az;
    if (input.jump) this.vel.y += 0.15;
    if (input.sneak) this.vel.y -= 0.15;
    this.move(this.vel.x, this.vel.y, this.vel.z);
    this.vel.x *= 0.91; this.vel.z *= 0.91;
    this.vel.y *= (input.jump || input.sneak) ? 0.91 : 0.6;
    this.vel.y = Math.min(0.375, Math.max(-0.375, this.vel.y));
    this.fallDistance = 0;
    this.snapTinyVel();
  }

  snapTinyVel() {
    if (Math.abs(this.vel.x) < 0.003) this.vel.x = 0;
    if (Math.abs(this.vel.y) < 0.003) this.vel.y = 0;
    if (Math.abs(this.vel.z) < 0.003) this.vel.z = 0;
  }

  isClearForHop() {
    const box = this.getAABB().translate(this.vel.x, 0.6, this.vel.z);
    return !collidesAny(this.world, box);
  }

  // 03 §8.2 edge guard
  sneakEdgeClamp(dx, dz) {
    if (!this.sneaking || this.vel.y > 0 || this.flying) return [dx, dz];
    const box = this.getAABB();
    const hasSupport = b => collidesAny(this.world, b.offset(0, -0.6, 0));
    if (!hasSupport(box)) return [dx, dz];
    const STEP = 0.05;
    const shrink = v => (Math.abs(v) <= STEP ? 0 : v - Math.sign(v) * STEP);
    while (dx !== 0 && !hasSupport(box.offset(dx, 0, 0))) dx = shrink(dx);
    while (dz !== 0 && !hasSupport(box.offset(0, 0, dz))) dz = shrink(dz);
    while (dx !== 0 && dz !== 0 && !hasSupport(box.offset(dx, 0, dz))) {
      dx = shrink(dx); dz = shrink(dz);
    }
    return [dx, dz];
  }

  // -------------------------------------------------- state machines

  updateSneak(input) {
    this.sneaking = !!input.sneak && !this.flying;
  }

  canSprint(input) {
    return input.forward * 0.98 >= 0.8
      && this.foodLevel > 6
      && !this.sneaking
      && !this.usingItem
      && !this.inWater && !this.inLava;
  }

  updateSprint(input) {
    if (input.pressed.has('KeyW')) {
      // double-tap start (03 §7.1)
      if (this.ticksSinceForward <= 7 && this.onGround && this.canSprint(input)) {
        this.sprinting = true;
      }
      this.ticksSinceForward = 0;
    }
    if (input.pressed.has('Space') && this.gameMode === 'debugCreative') {
      if (this.ticksSinceSpace <= 7) {
        this.flying = !this.flying;
        this.vel.y = 0;
      }
      this.ticksSinceSpace = 0;
    }
    if (input.sprintKey && this.canSprint(input)) this.sprinting = true;
    if (this.sprinting) {
      const stop = input.forward * 0.98 < 0.8
        || this.hitWall
        || this.foodLevel <= 6
        || this.inWater || this.inLava
        || this.usingItem;
      if (stop) this.sprinting = false;
    }
    if (this.sprinting && this.onGround) {
      const d = Math.hypot(this.pos.x - this.prevPos.x, this.pos.z - this.prevPos.z);
      this.addExhaustion(0.1 * d);
    }
  }

  stopSprint() { this.sprinting = false; }

  // -------------------------------------------------- environment (03 §10–13)

  tickEnvironment() {
    if (this.gameMode === 'debugCreative') { this.air = 300; this.fireTicks = 0; return; }
    const t = this.age;

    // drowning (03 §10.2)
    if (this.eyeSubmerged) {
      this.air -= 1;
      if (this.air <= -20) {
        this.air = 0;
        this.hurt(2, 'drown');
      }
    } else {
      this.air = Math.min(300, this.air + 7.5);
    }

    // lava / fire contact (03 §11.2)
    if (this.inLava) {
      if (t % 10 === 0) this.hurt(4, 'lava');
      this.fireTicks = 300;
    } else if (overlapsBlockId(this.world, this.getAABB(), B.FIRE)) {
      if (t % 10 === 0) this.hurt(1, 'fire');
      this.fireTicks = Math.max(this.fireTicks, 160);
    }

    // burning (03 §11.3)
    if (this.fireTicks > 0) {
      this.fireTicks--;
      if (t % 20 === 0 && !this.inLava) this.hurt(1, 'burn');
      if (this.inWater || this.world.isRainingAt(this.pos.x, this.pos.y, this.pos.z)) {
        this.fireTicks = 0;
      }
    }

    // suffocation (03 §13.1)
    const ex = Math.floor(this.pos.x), ey = Math.floor(this.pos.y + this.eyeHeight),
          ez = Math.floor(this.pos.z);
    if (BLOCKS[this.world.getBlock(ex, ey, ez)].opaque) {
      if (t % 10 === 0) this.hurt(1, 'suffocate');
    }

    // void (03 §13.2)
    if (this.pos.y < -64) { this.die('void'); return; }
    if (this.pos.y < -8 && t % 10 === 0) this.hurt(4, 'void');
  }

  // -------------------------------------------------- damage / death (03 §20)

  beforeHurt(amount, source) {
    if (this.gameMode === 'debugCreative' && source !== 'void') return false;
    return true;
  }

  onHurt(dmg, source, opts) {
    this.hurtTilt = 8;
    this.hurtTiltDir = this.world.rng() < 0.5 ? -1 : 1;
    if (LivingEntity.ARMOR_SOURCES.has(source)) this.addExhaustion(0.1);
    // §3.3 — post-i-frame, post-armor. 'fall' is excluded: the landing already
    // emits player.fall.big for exactly this hit.
    if (dmg > 0 && source !== 'fall') {
      if (source === 'fire' || source === 'burn' || source === 'lava') emitSound('player.hurt.fire', null);
      else if (source === 'drown') emitSound('player.hurt.drown', null);
      else emitSound('player.hurt', null);
    }
    audio.duck();                    // §4.3: music steps aside while you panic
    this.world.game?.onPlayerHurt?.(dmg, source);
  }

  onDeath() {
    const game = this.world.game;
    emitSound('player.death', null);
    // drop everything (03 §20.5)
    for (let i = 0; i < 36; i++) {
      if (this.inventory[i]) { game?.dropStackAt(this.inventory[i], this.pos.x, this.pos.y + 0.6, this.pos.z); this.inventory[i] = null; }
    }
    for (let i = 0; i < 4; i++) {
      if (this.armor[i]) { game?.dropStackAt(this.armor[i], this.pos.x, this.pos.y + 0.6, this.pos.z); this.armor[i] = null; }
    }
    if (this.offhand) { game?.dropStackAt(this.offhand, this.pos.x, this.pos.y + 0.6, this.pos.z); this.offhand = null; }
    const orbXp = Math.min(7 * this.xpLevel, 100);
    if (orbXp > 0) game?.spawnXpOrb(this.pos.x, this.pos.y + 0.6, this.pos.z, orbXp);
    this.xpLevel = 0; this.xpPoints = 0;
    this.fireTicks = 0; this.air = 300; this.fallDistance = 0;
    this.vel.x = this.vel.y = this.vel.z = 0;
    game?.onPlayerDeath?.();
  }

  respawn(worldSpawn) {
    let pos = null;
    if (this.spawnPoint) {
      pos = this.world.game?.validateBedSpawn?.(this.spawnPoint) ?? null;
      if (!pos) this.world.game?.toast?.('You have no home bed, or it was obstructed');
    }
    if (!pos) pos = worldSpawn;
    this.setPos(pos.x, pos.y, pos.z);
    this.prevPos.x = pos.x; this.prevPos.y = pos.y; this.prevPos.z = pos.z;
    this.health = 20;
    this.foodLevel = 20; this.saturation = 5.0; this.exhaustion = 0;
    this.foodTickTimer = 0; this.foodPoisonTicks = 0;
    this.air = 300;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.fireTicks = 0; this.fallDistance = 0; this.invulnTicks = 0;
    this.sprinting = false; this.sneaking = false; this.flying = false;
    this.usingItem = null;
    this.dead = false;
    this.yaw = 0; this.pitch = 0;   // facing −Z
  }

  // -------------------------------------------------- persistence (01 §16)

  serialize() {
    const packStacks = arr => arr.map(s => s ? { id: s.id, count: s.count, damage: s.damage } : null);
    return {
      pos: [this.pos.x, this.pos.y, this.pos.z],
      vel: [this.vel.x, this.vel.y, this.vel.z],
      yaw: this.yaw, pitch: this.pitch,
      health: this.health,
      hunger: this.foodLevel, saturation: this.saturation, exhaustion: this.exhaustion,
      foodPoisonTicks: this.foodPoisonTicks,
      xp: this.xpTotal,
      air: this.air, fireTicks: this.fireTicks, fallDistance: this.fallDistance,
      gameMode: this.gameMode,
      inventory: packStacks(this.inventory),
      armor: packStacks(this.armor),
      offhand: this.offhand ? { id: this.offhand.id, count: this.offhand.count, damage: this.offhand.damage } : null,
      selectedSlot: this.selectedSlot,
      spawnPoint: this.spawnPoint,
    };
  }

  deserialize(rec) {
    super.deserialize(rec);
    this.pitch = rec.pitch ?? 0;
    this.health = rec.health ?? 20;
    this.foodLevel = rec.hunger ?? 20;
    this.saturation = rec.saturation ?? 5;
    this.exhaustion = rec.exhaustion ?? 0;
    this.foodPoisonTicks = rec.foodPoisonTicks ?? 0;
    this.air = rec.air ?? 300;
    this.fireTicks = rec.fireTicks ?? 0;
    this.fallDistance = rec.fallDistance ?? 0;
    this.gameMode = rec.gameMode ?? 'survival';
    this.selectedSlot = rec.selectedSlot ?? 0;
    this.spawnPoint = rec.spawnPoint ?? null;
    if (rec.inventory) rec.inventory.forEach((s, i) => { this.inventory[i] = s || null; });
    this.offhand = rec.offhand || null;
    if (rec.armor) rec.armor.forEach((s, i) => { this.armor[i] = s || null; });
    this.xpTotal = 0; this.xpLevel = 0; this.xpPoints = 0;
    // Replays the whole level ladder — silence it, or every world load chimes.
    this._silentXp = true;
    if (rec.xp) this.addXp(rec.xp);
    this._silentXp = false;
    this.prevPos.x = this.pos.x; this.prevPos.y = this.pos.y; this.prevPos.z = this.pos.z;
  }
}
