// Survival player: movement state machine, health, hunger, XP, inventory
// (03 full spec; hunger/XP per 06 §12–13; combat charge per 05 §13).
import { LivingEntity, lerp, lerpAngle } from './Entity.js';
import { buildHumanoid, animateHumanoid } from './RemotePlayer.js';   // 14 §8.4 — shared model
import { BLOCKS, B, matOf, isWaterCellAt } from '../registry/blocks.js';
import { ITEMS, idOf } from '../registry/items.js';
import { collidesAny, overlapsBlockId } from '../physics/collision.js';
import { AABB } from '../math/aabb.js';
import { emitSound, at, audio } from '../audio/engine.js';
import { GameMode, normalizeGameMode, KEYBINDS } from '../constants.js';
import { tagsEqual, cloneStack, getEnchantLvl } from '../items/tags.js';
import { ENCH } from '../items/enchants.js';
import {
  unbreakingToolPoints, unbreakingArmorPoints, damageOf, remaining, setRemaining,
} from '../items/durability.js';
import {
  currentXp, splitmix32, subtractLevels, xpToNext as xpToNextPoints,
} from '../items/xp.js';
import { epfMultiplier, rollThorns, fireTicksAfterProtection } from '../items/effects.js';
import { tickPortal } from '../world/Portal.js';
import { EFFECT, tickEffects, effectLevel, addEffect, applyInstant, clearEffects, serializeEffects, applyEffectsData } from '../status/effects.js';
import { POTIONS } from '../status/potions.js';
import { totemSave, isTotem, setTotemId } from '../items/totem.js';   // B4 — totem
setTotemId(idOf('totem_of_undying'));   // B4 — bind the totem id once

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
    this.gliding = false;               // 11-END §10 — elytra glide (transient, never persisted)
    this.glideTicks = 0;
    this.gameMode = GameMode.SURVIVAL;  // 18 §1.1 enum: 0 survival | 1 creative
    this.pendingGameMode = null;        // set by F4; applied in tick() (§1.4)
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
    // (09-POTIONS AMENDS 06 §12.4 — foodPoisonTicks removed; food poisoning is now
    // the Hunger effect. effects Map + absorption live on LivingEntity.)

    // XP (06 §13). xpTotal is the LIFETIME counter (08 §3.2's xpEarnedTotal):
    // increment-only, never touched by spending, and what Score renders.
    this.xpTotal = 0;
    this.xpLevel = 0;
    this.xpPoints = 0;
    this.xpPickupCooldown = 0;

    // 08 §3.3 — enchantment seed. Rerolled ONLY when an enchant is purchased.
    // deserialize() overwrites this from the save when the field is present.
    this.enchantSeed = this.defaultEnchantSeed();

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
    // 14-MULTIPLAYER — humanoid render state (only used when OTHERS render this
    // player; the local first-person player is never drawn).
    this.hue = 0;
    this.swingTime = 0;                // >0 → SWINGING snapshot flag + arm anim
    this._walkPhase = 0;
    this._punchPhase = 0;

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
        // AMENDS 06 §14.2 (08 §1): tags must deep-equal to merge.
        if (s && s.id === stack.id && (s.damage ?? 0) === (stack.damage ?? 0) &&
            tagsEqual(s, stack) && s.count < max) {
          const add = Math.min(max - s.count, remaining);
          s.count += add; remaining -= add;
          if (remaining === 0) return 0;
        }
      }
    }
    for (const i of order) {
      if (!this.inventory[i]) {
        const put = Math.min(max, remaining);
        // cloneStack, not a spread: each slot needs its own tags object (08 §1
        // invariant 4) or two slots alias one enchant list.
        const dst = cloneStack(stack);
        dst.count = put;
        this.inventory[i] = dst;
        remaining -= put;
        if (remaining === 0) return 0;
      }
    }
    return remaining;
  }

  get creative() { return this.gameMode === GameMode.CREATIVE; }

  // 18 §5.3 — the single choke point for "creative never depletes a stack".
  // Every place/use path in interaction.js funnels through here, so the rule is
  // stated once instead of at seven call sites (any of which a later phase
  // could add to and forget).
  consumeHeld(n = 1) { this.consumeIn('main', n); }

  // -------------------------------------------------- 08 §7 hand accessors
  // 'main' = selected hotbar slot, 'off' = slot 45. The un-suffixed helpers
  // above (heldStack/heldItem/consumeHeld/damageHeld) stay MAIN-hand only:
  // mining and attacking are main-hand by definition (§7.1), and routing them
  // through a hand parameter would put a branch in two hot paths to no end.
  // Only the RMB pipeline (§7.3) and the bow's ammo search (§7.4) are
  // hand-aware, and they call these explicitly.

  stackIn(hand) { return hand === 'off' ? this.offhand : this.heldStack; }
  setStackIn(hand, v) { if (hand === 'off') this.offhand = v; else this.heldStack = v; }
  itemIn(hand) { const s = this.stackIn(hand); return s ? ITEMS.get(s.id) : null; }

  consumeIn(hand, n = 1) {
    if (this.creative) return;
    const s = this.stackIn(hand);
    if (!s) return;
    s.count -= n;
    if (s.count <= 0) this.setStackIn(hand, null);
  }

  // 18 §1.3/§1.4 — the consolidated toggle. Runs inside tick() before the
  // movement branch so the new mode's physics take effect the same tick.
  setGameMode(mode) {
    if (this.gameMode === mode) return;
    this.gameMode = mode;
    this._selfSound('ui.gamemode.switch', mode === GameMode.CREATIVE ? 1 : 0.5);
    if (mode === GameMode.CREATIVE) {
      this.health = 20;
      this.foodLevel = 20; this.saturation = 20; this.exhaustion = 0;
      this.fireTicks = 0;
      this.fallDistance = 0;
      this.air = 300;
      // flying stays false — the player may double-tap Space to enable it.
      // inventory/hotbar untouched; the stacks simply stop depleting (§5.3).
    } else {
      this.flying = false;
      this.fallDistance = 0;
      // health/hunger keep their current (max) values and resume draining;
      // stack counts become finite again — both are emergent, not assignments.
    }
    // §7.1: a hostile already chasing this player drops the target the tick the
    // switch lands, rather than waiting out its own give-up rules.
    if (mode === GameMode.CREATIVE) this.world.game?.onPlayerEnteredCreative?.(this);
    this.world.game?.onGameModeChanged?.(mode);
  }

  // durability spend (06 §7.1); returns true if the tool broke
  damageHeld(n = 1) { return this.damageIn('main', n); }

  damageIn(hand, n = 1) {
    if (this.creative) return false;
    const s = this.stackIn(hand);
    if (!s) return false;
    const item = ITEMS.get(s.id);
    if (!item?.durability) return false;
    // 08 §5.7 / AMENDS 06 §7.1 — Unbreaking gates every durability point at
    // every decrement site. Gating here (and in damageArmor) rather than at the
    // eight call sites is the same reasoning as the break-sound emit below: a
    // caller that forgets the roll would silently un-enchant the item.
    // A −2 spend rolls twice, per the AMENDS.
    n = unbreakingToolPoints(n, getEnchantLvl(s, ENCH.UNBREAKING), this.world?.rng ?? Math.random);
    if (n <= 0) return false;
    s.damage = (s.damage ?? 0) + n;
    if (s.damage >= item.durability) {
      this.setStackIn(hand, null);
      // Most callers ignore this return value, so the emit lives here rather
      // than at the six call sites.
      this._selfSound('player.item_break');
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

  // 10-NETHER §9.2 — sum of worn pieces' kbResist (full netherite = 0.4).
  knockbackResistance() {
    let r = 0;
    for (const s of this.armor) if (s) r += ITEMS.get(s.id)?.knockbackResistance ?? 0;
    return Math.min(1, r);
  }

  damageArmor(dmg) {
    if (dmg < 1) return;
    const loss = Math.max(1, Math.floor(dmg / 4));
    for (let i = 0; i < 4; i++) {
      // 08 §8.6 — a falling anvil costs the HELMET double durability; every
      // other piece takes the normal loss. FallingBlock sets the flag around
      // its hurt() call.
      this.damageArmorSlot(i, i === 0 && this.anvilHit ? loss * 2 : loss);
    }
  }

  /**
   * 08 §5.7 / AMENDS 05 §14.2 — spend `n` durability on one armor piece, gated
   * per point by Unbreaking's ARMOR formula (a different curve from tools).
   * Split out of damageArmor because §5.2.4's Thorns proc charges 2 extra points
   * to one specific piece and must be gated the same way.
   */
  damageArmorSlot(i, n) {
    if (this.creative) return;
    const s = this.armor[i];
    if (!s) return;
    const item = ITEMS.get(s.id);
    n = unbreakingArmorPoints(n, getEnchantLvl(s, ENCH.UNBREAKING), this.world?.rng ?? Math.random);
    if (n <= 0) return;
    s.damage = (s.damage ?? 0) + n;
    if (s.damage >= (item?.durability ?? 1)) {
      this.armor[i] = null;
      this._selfSound('player.item_break');   // §3.3 covers armor, not just tools
    }
  }

  // -------------------------------------------------- 08 §3.3 enchantment seed

  /** §3.3 — (worldSeed ^ 0x9E3779B9) >>> 0 at first spawn. */
  defaultEnchantSeed() {
    return ((this.world?.worldSeed ?? 0) ^ 0x9e3779b9) >>> 0;
  }

  /** §4.5 step 3 — rerolled ONLY when an enchantment is purchased at the table. */
  rerollEnchantSeed() {
    this.enchantSeed = splitmix32(this.enchantSeed);
    return this.enchantSeed;
  }

  // -------------------------------------------------- XP (06 §13)

  // 08 §3.1's closed forms are the running sum of exactly this ladder, so the
  // two must never drift — items/xp.js owns it now and this delegates.
  xpToNext(L) { return xpToNextPoints(L); }

  /** 08 §3.2 — spend n levels, preserving progress into the level. */
  subtractLevels(n) { subtractLevels(this, n); }

  /**
   * 08 §5.8 / AMENDS 05 §15 — XP-orb pickup runs the Mending repair step BEFORE
   * adding points. 2 durability per 1 XP, on ONE random damaged Mending item
   * among armor + both hands; the leftover value continues to the bar. No
   * chaining to a second item (Java exact).
   *
   * §5.8 is written in remaining-durability terms; mapped here per
   * durability.js's header (`s.durability < maxDur(s)` ⇔ damageOf(s) > 0, and
   * `maxDur(item) − item.durability` ⇔ damageOf(item)).
   *
   * Every orb source routes through here — mob/mining/breeding orbs, the player
   * death orb, and §9.2's grindstone refund (deliberate: it lets worn Mending
   * gear intercept the refund). Furnace XP is awarded directly, not via an orb,
   * so it bypasses Mending — §5.8 states that consequence and keeps it.
   */
  onOrbPickup(value) {
    const candidates = [...this.armor, this.heldStack, this.offhand]
      .filter(s => s && getEnchantLvl(s, ENCH.MENDING) > 0 && damageOf(s) > 0);
    if (candidates.length > 0) {
      const item = candidates[Math.floor(this.world.rng() * candidates.length)];
      const repair = Math.min(value * 2, damageOf(item));
      setRemaining(item, remaining(item) + repair);
      value -= Math.ceil(repair / 2);
      this._selfSound('mending.repair');
    }
    this.addXp(value);
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
    if (this.xpLevel > before && !this._silentXp) this._selfSound('player.levelup');
  }

  // -------------------------------------------------- exhaustion / hunger (06 §12)

  addExhaustion(v) {
    if (this.creative) return;
    this.exhaustion += v;
  }

  tickHunger() {
    if (this.creative) return;
    // (09-POTIONS AMENDS 06 §12.4 — food poisoning is now the Hunger effect; its
    // 0.005·L/tick exhaustion is applied by tickEffects' periodicAction.)
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
    // AMENDS 06 §12.4 — rotten flesh / raw chicken poison chance → Hunger I 0:30.
    if (item.poisonChance && this.world.rng() < item.poisonChance) {
      addEffect(this, EFFECT.HUNGER, 0, 600);
    }
    // 09-POTIONS §8/§9 — food-borne effects.
    if (item.name === 'spider_eye') addEffect(this, EFFECT.POISON, 0, 100);        // Poison I 0:05
    else if (item.name === 'golden_apple') {
      addEffect(this, EFFECT.ABSORPTION, 0, 2400);                                 // Absorption I 2:00
      addEffect(this, EFFECT.REGENERATION, 1, 100);                               // Regeneration II 0:05
    }
    // 11-END §8.6 — chorus fruit teleports the eater up to 8 blocks.
    else if (item.teleportOnEat) this.chorusTeleport();
  }

  // 11-END §8.6 — enderman-style teleport: 16 tries in a ±8 box, seek down to a
  // standable cell (solid below + 2 air, non-fluid). Zeroes velocity/fallDistance.
  chorusTeleport() {
    const w = this.world, rng = w.rng;
    const ox = this.pos.x, oy = this.pos.y, oz = this.pos.z;
    for (let a = 0; a < 16; a++) {
      const tx = Math.floor(ox + (rng() - 0.5) * 16);
      const ty = Math.max(1, Math.min(126, Math.floor(oy) + ((rng() * 16) | 0) - 8));
      const tz = Math.floor(oz + (rng() - 0.5) * 16);
      for (let d = 0; d <= 8; d++) {
        const y = ty - d;
        if (y < 1) break;
        const below = BLOCKS[w.getBlock(tx, y - 1, tz)];
        if (below.collidable && !below.fluid &&
            !BLOCKS[w.getBlock(tx, y, tz)].collidable && !BLOCKS[w.getBlock(tx, y + 1, tz)].collidable) {
          emitSound('chorus.teleport', at(ox, oy, oz));
          this.setPos(tx + 0.5, y, tz + 0.5);
          this.prevPos.x = this.pos.x; this.prevPos.y = this.pos.y; this.prevPos.z = this.pos.z;
          this.vel.x = this.vel.y = this.vel.z = 0; this.fallDistance = 0;
          emitSound('chorus.teleport', at(this.pos.x, this.pos.y, this.pos.z));
          return;
        }
      }
    }
  }

  // -------------------------------------------------- tick (03 §4 order)

  // 14 AMENDS 03 §2.3 — humanoid model so OTHER players can see this one. The
  // local (first-person) player is skipped by EntityManager.updateRender, so this
  // only ever renders a REMOTE player entity on the host (or nothing).
  buildMesh() {
    const g = buildHumanoid(this.hue ?? 0);
    g.userData._baseY = 0;
    return g;
  }

  updateRender(alpha) {
    if (!this.object3d) return;
    const x = lerp(this.prevPos.x, this.pos.x, alpha);
    const y = lerp(this.prevPos.y, this.pos.y, alpha);
    const z = lerp(this.prevPos.z, this.pos.z, alpha);
    this.object3d.position.set(x, y, z);
    this.object3d.rotation.y = lerpAngle(this.prevYaw, this.yaw, alpha);
    const hSpeed = Math.hypot(this.pos.x - this.prevPos.x, this.pos.z - this.prevPos.z);
    this._walkPhase += hSpeed * 14;
    if (this.swingTime > 0) this._punchPhase += 0.9; else this._punchPhase = 0;
    animateHumanoid(this.object3d, {
      walkPhase: this._walkPhase, hSpeed, swinging: this.swingTime > 0,
      punchPhase: this._punchPhase, sneaking: this.sneaking, pitch: this.pitch,
    });
    this.applyLightScalar();
  }

  /**
   * 14 §12 — personal sounds ("play locally, never wired"). They are emitted
   * with a null position, which engine.js treats as unpanned, un-culled and
   * priority PLAYER — correct for your own player, catastrophic for the host's
   * proxies of every connected client (their footsteps/hurt/death would play
   * full volume inside the host's head). isNetPlayer is set only on those
   * host-side proxies (Game.createNetPlayer). Deliberately NOT converted to a
   * positional emit: block.step.* carries replicate:true and would be
   * re-broadcast to every client, including the owner who already plays it.
   */
  _selfSound(id, pitch = 1, gain = 1) {
    if (this.isNetPlayer) return;
    emitSound(id, null, pitch, gain);
  }

  // §3.2: the under-feet cell, skipped silently for the classes with no verb.
  emitStep(gainMult) {
    const id = this.world.getBlock(
      Math.floor(this.pos.x), Math.floor(this.pos.y - 0.5), Math.floor(this.pos.z));
    const cls = matOf(id);
    if (!cls) return;
    this._selfSound(`block.step.${cls}`, 1, gainMult);
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
    if (this.burpTimer > 0 && --this.burpTimer === 0) this._selfSound('player.eat.burp');
    // §3.3: orbStreak resets after 40 ticks without a pickup.
    if (this.orbStreakTimer > 0 && --this.orbStreakTimer === 0) this.orbStreak = 0;
    if (this.hurtTilt > 0) this.hurtTilt = Math.max(0, this.hurtTilt - 0.8);
    this.ticksSinceForward++;
    this.ticksSinceSpace++;
    this.ticksSinceAttack++;
    if (this.swingTime > 0) this.swingTime--;
    if ((this.heldStack?.id ?? null) !== this.lastHeldId) {
      this.lastHeldId = this.heldStack?.id ?? null;
      this.ticksSinceAttack = 0;                        // item switch resets charge
    }

    // 2. dead?
    if (this.dead) return;

    // 2.5 game-mode toggle (18 §1.3/§1.4) — applied atomically here, BEFORE the
    // movement branch, so the new mode's physics take effect this same tick.
    // The F4 edge is read off the snapshot rather than a keydown listener: the
    // listener fires mid-frame and would flip `flying` and the damage guard in
    // the middle of a tick's own movement/damage pass. `pressed` is the per-tick
    // down-edge set (01 §15.1), so this cannot auto-repeat.
    if (input.pressed.has(KEYBINDS.gameMode)) {
      this.pendingGameMode = this.creative ? GameMode.SURVIVAL : GameMode.CREATIVE;
    }
    if (this.pendingGameMode !== null) {
      // 14 §4.2 — game mode is HOST-assigned. NetHost._frameFromInput refuses to
      // map the F4 bit for exactly this reason, but the local key edge (and 18's
      // settings checkbox, which sets the same field) bypassed that guard and
      // self-granted Creative on a client: creative instant-break sends block
      // edits the host applies unvalidated. The host corrects via playerState
      // every 5 ticks, which is far too late. Host-side proxies never see the
      // edge, so gating the single application point covers both entry paths.
      if (!this.world.game?.net?.isClient) this.setGameMode(this.pendingGameMode);
      this.pendingGameMode = null;
    }

    // 1.5 status effects (09-POTIONS §2.4 / AMENDS 03 §4) — MUST run before the
    // movement branch so Speed/Slowness/Jump apply the same tick.
    tickEffects(this);

    // 3–4. sneak + sprint state
    this.updateSneak(input);
    this.updateSprint(input);

    // 5. medium — the PRE-move sample (still needed after a respawn/portal
    // teleport, and read by the movement branch itself). tick() re-samples again
    // after the move; §3.3's splash test lives there, on the post-move flags.
    this.updateMedium();
    const eye = { x: this.pos.x, y: this.pos.y + this.eyeHeight, z: this.pos.z };
    const eyeBlock = this.world.getBlock(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z));
    // AMENDS 03 §10 / 15 §13.2 — eyes inside a waterlogged cell submerge too
    // (mining speed /5, the underwater overlay, the swim-branch's eye test).
    this.eyeSubmerged = isWaterCellAt(eyeBlock,
      this.world.getState(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z)));

    // 11-END §10.2 — elytra deploy/stop, evaluated before the movement branch.
    this.tickElytra(input);

    // 6. movement branch
    const velYBefore = this.vel.y;
    const y0 = this.pos.y;
    if (this.flying) this.flightMove(input);
    else if (this.gliding) this.elytraMove(input);   // §10.3 — precedes fluids
    else if (this.inLava) this.lavaMove(input);
    else if (this.inWater) this.waterMove(input);
    else this.landMove(input);

    // 06 §12.1 — sprinting costs 0.1 exhaustion per metre travelled on the
    // ground. Charged here because prevPos is this tick's start position and
    // move() is the only writer of pos in the tick; the water/lava branches
    // already clear `sprinting`, so waterMove's 0.01/m cannot double-count.
    if (this.sprinting && this.onGround && !this.flying) {
      this.addExhaustion(0.1 * Math.hypot(this.pos.x - this.prevPos.x, this.pos.z - this.prevPos.z));
    }

    // 6b. flight ground-cancel (18 §2.4, Java behavior). Gated on a DOWNWARD
    // move, per §2.4's own wording ("onGround on a downward move"): the tick a
    // double-tap ENABLES flight from a standing start, onGround is still true,
    // and an ungated test would cancel flight before it ever began.
    if (this.flying && this.onGround && this.pos.y < y0) this.flying = false;

    // 6c. AMENDS 03 §12.1/§12.2 — re-sample the medium on the POST-move box, so
    // the fall-damage and contact tests below see where the player actually
    // ended up: §12.2's "any water contact (AABB overlap) → fallDistance = 0"
    // has to hold for a fast fall that crosses the surface and hits the floor
    // inside one tick (vel.y ≤ −1 skips the water cell entirely otherwise), and
    // lava/fire contact damage would lag a tick on entry.
    // §3.3's splash rides along here: velYBefore is the entry speed (this.vel.y
    // has been zeroed by the landing collision), and wasInWater is the pre-move
    // sample taken at step 5.
    const wasInWater = this.inWater;
    this.updateMedium();
    if (this.inWater && !wasInWater && velYBefore < -0.3) {
      // gain scales 0.3-0.8 with entry speed (§3.3)
      const g = Math.min(0.8, 0.3 + Math.abs(velYBefore) * 0.5);
      this._selfSound('player.splash', 1, g);
    }

    // 7. fall damage
    // trackFall() zeroes fallDistance unconditionally on the landing tick, so the
    // landing sound has to read it first.
    const fdBefore = this.fallDistance;
    if (this.gliding && this.vel.y > -0.5) {
      // 11-END §10.5 (AMENDS 03 §12.2) — a shallow glide pins fallDistance at 1.0
      // (ceil(1−3)≤0, no damage) but keeps it above the 0.5 landing-sound floor;
      // steep dives (vel.y ≤ −0.5) resume normal accumulation via trackFall next.
      this.fallDistance = 1.0;
    } else if (!this.flying) {
      this.trackFall(velYBefore, this.pos.y - y0);
    } else {
      this.fallDistance = 0;
    }
    // Landing (§3.3 / §3.2). The medium guards matter: trackFall also zeroes on
    // ladder/water and halves in lava, any of which can leave onGround true with
    // a stale fdBefore and fake a landing on a submerged floor.
    if (!this.flying && this.onGround && fdBefore > 0 &&
        !this.inWater && !this.inLava && !this.onLadder) {
      const dmg = Math.ceil(fdBefore - 3 - effectLevel(this, EFFECT.JUMP_BOOST));
      if (dmg > 0) {
        // player.hurt suppresses source 'fall' so this doesn't double up
        this._selfSound('player.fall.big', 1, (0.6 + 0.1 * Math.min(dmg, 10)) / 0.6);
      } else if (fdBefore >= 0.5) {
        this._selfSound('player.fall.small');
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
        this._selfSound('player.splash', 1, 0.35);
      }
    }

    // eye height lerp (03 §2.2)
    const targetEye = this.sneaking ? 1.27 : 1.62;
    this.eyeHeight += (targetEye - this.eyeHeight) * 0.5;

    // FOV effect (03 §18.3 sprint; 18 §2.3 flight). Flying is +10% on its own
    // and "increased further when holding sprint" — the old expression made
    // flight FOV identical to walking, since both its arms reduced to `sprinting`.
    // 09-POTIONS AMENDS 03 §18.3 — Speed/Slowness shift FOV ±0.05·L, clamped.
    const fovFx = 0.05 * effectLevel(this, EFFECT.SPEED) - 0.05 * effectLevel(this, EFFECT.SLOWNESS);
    const glideFast = this.gliding && Math.hypot(this.vel.x, this.vel.z) > 1.0;   // §10.6
    const targetFov = this.flying
      ? (this.sprinting ? 1.21 : 1.10)          // 1.10² for sprint-fly (approx)
      : glideFast ? 1.10
      : Math.max(0.85, Math.min(1.30, (this.sprinting ? 1.10 : 1.0) + fovFx));
    this.fovScale += (targetFov - this.fovScale) * 0.5;

    // 10-NETHER §3.4 — the portal transfer timer (standing in a portal for 80 t
    // changes dimension). Only runs in PLAYING (skipped mid-load) and only from
    // the LOCAL player's tick: tickPortal is a per-GAME pass over game.player,
    // but on a host every connected client's proxy Player ticks through here too
    // (NetHost.tickRemotePlayers), so an ungated call ran it N+1 times per tick —
    // §3.4's 80-tick timer (and portalCooldown) drained N+1× too fast.
    const game = this.world.game;
    if (game?.state === 'PLAYING' && game.player === this) tickPortal(game);
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
    // 03 §1 — friction uses the PRE-move onGround flag: Java's travel() computes
    // f1 = onGround ? friction×0.91 : 0.91 BEFORE move() overwrites the flag.
    // Reading it after the move gives air friction on the takeoff tick and ground
    // friction on the landing tick, which inflates §1's emergent sprint-jump
    // average (0.356 b/t) by 23%. Flat ground is unaffected either way.
    const grounded = this.onGround;
    const mult = this.sprinting ? 1.3 : 1.0;
    // 09-POTIONS AMENDS 03 §5.3 — Speed/Slowness scale ground move only; air accel
    // is Java-unaffected. effMove = (1+0.2·L_speed)(1−0.15·L_slowness), floor 0.
    const L = id => effectLevel(this, id);
    const effMove = Math.max(0, (1 + 0.2 * L(EFFECT.SPEED)) * (1 - 0.15 * L(EFFECT.SLOWNESS)));
    const speed = this.onGround
      ? 0.1 * mult * effMove * Math.pow(0.6 / slip, 3)
      : 0.02 * mult;

    // jump BEFORE the move (03 §6.2); Jump Boost adds 0.1 per level (09 AMENDS 03 §6.2)
    if (input.jump && this.onGround && this.jumpCooldown === 0) {
      this.vel.y = 0.42 + 0.1 * L(EFFECT.JUMP_BOOST);
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
      if (this.sneaking) this.vel.y = Math.max(this.vel.y, 0);
      this.vel.y = Math.max(this.vel.y, -0.15);
      this.fallDistance = 0;
    }

    const [dx, dz] = this.sneakEdgeClamp(this.vel.x, this.vel.z);
    this.move(dx, this.vel.y, dz);

    // 03 §1/§24 — the climb impulse is a plain assignment on the POST-move
    // velocity (Java parity: move() then `vec3 = new Vec3(x, 0.2, z)`), so the
    // 0.2 is never itself a displacement: gravity+drag below turn it into the
    // 0.1176 b/t = 2.35 m/s that becomes next tick's displacement. Applied
    // pre-move it climbed at a flat 0.2 b/t = 4.0 m/s. §9's other four ladder
    // rules stay pre-move, exactly as written.
    if (this.onLadder && (input.strafe !== 0 || input.forward !== 0 || input.jump)) this.vel.y = 0.2;

    const friction = grounded ? slip * 0.91 : 0.91;
    this.vel.x *= friction; this.vel.z *= friction;
    // 09-POTIONS §3.8 Levitation replaces gravity; §3.6/AMENDS 03 §6.1 Slow Falling
    // softens it to 0.01 while descending. Drag ×0.98 unchanged.
    const lev = L(EFFECT.LEVITATION);
    if (lev > 0) {
      this.vel.y += (0.05 * lev - this.vel.y) * 0.2;
      if (this.vel.y >= 0) this.fallDistance = 0;
      this.vel.y *= 0.98;
    } else {
      const g = (L(EFFECT.SLOW_FALLING) > 0 && this.vel.y <= 0) ? 0.01 : 0.08;
      this.vel.y = (this.vel.y - g) * 0.98;
    }
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

  // 11-END §10.2 — evaluate elytra deploy (jump-key edge) and auto-stop.
  tickElytra(input) {
    if (this.gliding) {
      if (this.onGround || this.inWater || this.inLava || this.flying) this.gliding = false;
      return;
    }
    const chest = this.armor[1];
    const def = chest && ITEMS.get(chest.id);
    const working = !!def?.elytra && (def.durability - (chest.damage ?? 0)) > 1;   // §10.1 flightEnabled
    const edge = input.pressed && input.pressed.has && input.pressed.has(KEYBINDS.jump);
    if (edge && working && !this.onGround && !this.inWater && !this.inLava &&
        !this.onLadder && !this.flying && this.vel.y < 0.1 &&
        effectLevel(this, EFFECT.LEVITATION) === 0) {   // §10.2 Levitation blocks deploy
      this.gliding = true;
      this.glideTicks = 0;
      this.sprinting = false;                            // §7.2 deploy clears sprint
      this._selfSound('elytra.deploy');
    }
  }

  // 11-END §10.4 — per-tick glide physics, transcribed from the decompiled Java
  // LivingEntity.travel() fall-flying branch (our pitch is +up; our look vector is
  // unit-length so vanilla's min(1,|look|/0.4) factor is identically 1).
  elytraMove(input) {
    const th = this.pitch;                               // radians, + up
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const look = { x: -Math.sin(this.yaw) * cp, y: sp, z: -Math.cos(this.yaw) * cp };
    const hLook = Math.hypot(look.x, look.z);
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);   // sampled BEFORE the update
    const cos2 = cp * cp;
    const v = this.vel;

    v.y += 0.08 * (-1 + cos2 * 0.75);                    // gravity −0.08, lift up to +0.06

    if (v.y < 0 && hLook > 0) {                          // falling → forward speed
      const d = v.y * -0.1 * cos2;
      v.x += look.x * d / hLook; v.y += d; v.z += look.z * d / hLook;
    }
    if (th > 0 && hLook > 0) {                           // pitched up → altitude
      const g = hSpeed * Math.sin(th) * 0.04;
      v.x -= look.x * g / hLook; v.y += g * 3.2; v.z -= look.z * g / hLook;
    }
    if (hLook > 0) {                                     // align velocity to look
      v.x += (look.x / hLook * hSpeed - v.x) * 0.1;
      v.z += (look.z / hLook * hSpeed - v.z) * 0.1;
    }
    v.x *= 0.99; v.y *= 0.98; v.z *= 0.99;               // drag

    this.move(v.x, v.y, v.z);                            // sets hitWall/onGround, zeroes clipped axes

    if (this.hitWall) {                                  // §10.4 kinetic wall crash
      const hAfter = Math.hypot(v.x, v.z);
      const dmg = (hSpeed - hAfter) * 10 - 3;
      if (dmg > 0) this.hurt(Math.ceil(dmg), 'fly_into_wall');   // armor-bypassing (05 §14.2)
    }
    if (this.onGround) this.gliding = false;             // landing ends the glide

    this.glideTicks++;                                   // §10.1 durability: 1 per second
    if (this.glideTicks % 20 === 0) {
      const chest = this.armor[1], def = chest && ITEMS.get(chest.id);
      if (def?.elytra && !this.creative) {
        // 08 §5.7 — "gate every single durability point at every decrement site".
        // This is the one site that does not route through damageIn/
        // damageArmorSlot (§10.1's "stops but never breaks" forbids the latter,
        // which nulls the slot), so the Unbreaking roll is applied inline.
        const spend = unbreakingArmorPoints(1, getEnchantLvl(chest, ENCH.UNBREAKING),
          this.world?.rng ?? Math.random);
        chest.damage = (chest.damage ?? 0) + spend;
        if (chest.damage >= def.durability - 1) { chest.damage = def.durability - 1; this.gliding = false; }  // tattered at 1 (never breaks)
      }
    }
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
      // 18 §2.3/§9 — "a creative player flying in water or lava neither sinks
      // nor slows": flightMove's speed is ×2 while sprinting, so the fluid clause
      // must not reach a flying player (updateMedium has no flight exemption).
      && (this.flying || (!this.inWater && !this.inLava));
  }

  updateSprint(input) {
    if (input.pressed.has('KeyW')) {
      // double-tap start (03 §7.1). 18 §2.2 lists "double-tap W" as a sprint-FLY
      // trigger too, so the ground test has to admit a flying player.
      if (this.ticksSinceForward <= 7 && (this.onGround || this.flying) && this.canSprint(input)) {
        this.sprinting = true;
      }
      this.ticksSinceForward = 0;
    }
    if (input.pressed.has('Space') && this.creative) {
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
        || (!this.flying && (this.inWater || this.inLava))   // 18 §2.3 — see canSprint
        || this.usingItem;
      if (stop) this.sprinting = false;
    }
    // (06 §12.1's 0.1/m sprint drain is charged in tick(), AFTER the movement
    // branch: updateSprint runs before the move, where pos still equals prevPos
    // — the distance measured here was always exactly 0.)
  }

  stopSprint() { this.sprinting = false; }

  // -------------------------------------------------- environment (03 §10–13)

  tickEnvironment() {
    // 18 §4.3 — air and fire are frozen in creative. The early-out still runs the
    // void check: 18 §4.1/§1.5 make the void the ONE source creative does not
    // nullify (beforeHurt lets source 'void' through for exactly this reason).
    if (this.creative) { this.air = 300; this.fireTicks = 0; this.tickVoid(); return; }
    const t = this.age;

    // drowning (03 §10.2)
    if (this.eyeSubmerged) {
      // 08 §5.3 — Respiration L: decrement air only when randInt(L+1) === 0,
      // so average breath time is ×(L+1) (Respiration III ≈ 60 s).
      //
      // Only the BREATH decrement is gated. Below zero this same counter is the
      // drowning-damage cadence (air runs 0 → −20, then resets to 0 and deals
      // 2 HP), and §5.3 says that cadence is unchanged — gating the whole
      // decrement would have slowed drowning damage by ×(L+1) too.
      const resp = getEnchantLvl(this.armor[0], ENCH.RESPIRATION);
      // 09-POTIONS AMENDS 03 §10.2 — Water Breathing skips the breath decrement.
      if (this.effects.has(EFFECT.WATER_BREATHING)) {
        // air never depletes; drowning-damage cadence below never triggers.
      } else if (this.air > 0 && resp > 0) {
        if (Math.floor(this.world.rng() * (resp + 1)) === 0) this.air -= 1;
      } else {
        this.air -= 1;
      }
      if (this.air <= -20) {
        this.air = 0;
        this.hurt(2, 'drown');
      }
    } else {
      this.air = Math.min(300, this.air + 7.5);
    }

    // lava / fire contact (03 §11.2). setOnFire applies 08 §5.2.1's Fire
    // Protection tick reduction; lava's 300 is an assignment in 03 §11.2 (it
    // re-arms every tick you stand in it) but max() is equivalent there.
    if (this.inLava) {
      if (t % 10 === 0) this.hurt(4, 'lava');
      this.setOnFire(300);
    } else if (overlapsBlockId(this.world, this.getAABB(), B.FIRE)) {
      if (t % 10 === 0) this.hurt(1, 'fire');
      this.setOnFire(160);
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

    this.tickVoid();
  }

  /** 03 §13.2 void plane. Split out because creative reaches it too (18 §4.1). */
  tickVoid() {
    if (this.pos.y < -64) { this.die('void'); return; }
    if (this.pos.y < -8 && this.age % 10 === 0) this.hurt(4, 'void');
  }

  // -------------------------------------------------- damage / death (03 §20)

  beforeHurt(amount, source, opts = {}) {
    // 14 §4.2 — on a CLIENT, health is host-authoritative (never predicted); the
    // local player takes no local damage (playerState overwrites it).
    if (this.world.game?.net?.isClient) return false;
    // 18 §4.1 — void is the ONE source creative does not nullify.
    if (this.creative && source !== 'void') return false;
    // B4 — shield block (19-BUILDOUT §B4): `blocking` (set in Interaction.tick:
    // shield in either hand + RMB held) negates front-arc melee/projectile
    // damage entirely. Axe hits disable the shield for 100 ticks (MC parity);
    // blocking costs 1 durability on the shielding stack (damageIn's path).
    if (this.blocking && LivingEntity.ARMOR_SOURCES.has(source) &&
        this.world.time >= (this.shieldDisabledUntil ?? 0)) {
      const dx = opts.dirX, dz = opts.dirZ;
      if (dx != null && dz != null) {
        const lookX = -Math.sin(this.yaw), lookZ = -Math.cos(this.yaw);
        const facing = lookX * -dx + lookZ * -dz;        // >0 = attacker in front
        if (facing > 0.1) {
          const shieldHand = ITEMS.get(this.stackIn('off')?.id)?.kind === 'shield' ? 'off'
            : ITEMS.get(this.heldStack?.id)?.kind === 'shield' ? 'main' : null;
          if (shieldHand) this.damageIn(shieldHand, 1);
          const axe = ITEMS.get(opts.attacker?.heldItem?.().id);
          if (axe?.toolClass === 'axe') this.shieldDisabledUntil = this.world.time + 100;
          return false;                                    // blocked — no damage, no knockback
        }
      }
    }
    return true;
  }

  // 18 §4.4 — a creative player is immovable by mob melee, projectiles and
  // explosions. beforeHurt already stops the hurt() path from ever reaching
  // applyKnockback, but Game.explode pushes entities directly, outside hurt().
  applyKnockback(strength, dirX, dirZ) {
    if (this.creative) return;
    super.applyKnockback(strength, dirX, dirZ);
  }

  /** 08 §5.2.1 — the armor EPF reduction, called from LivingEntity.applyDamage. */
  reduceByEnchants(dmg, source) {
    return dmg * epfMultiplier(this.armor, source);
  }

  /**
   * 08 §5.2.1 — Fire Protection cuts applied fire ticks by floor(ticks×0.15×L),
   * computed from the HIGHEST single level among worn pieces (Java exact).
   * Checklist: "Fire Protection IV halves-and-more burn time (−60%)".
   */
  setOnFire(ticks) {
    super.setOnFire(fireTicksAfterProtection(ticks, this.armor));
  }

  /**
   * 08 §5.2.4 — Thorns. Each worn piece with Thorns L independently rolls
   * 0.15 × L; every proc deals 1 + randInt(4) to the attacker and costs that
   * piece 2 extra durability (Unbreaking-gated via damageArmorSlot).
   *
   * Only melee and arrow damage with a live attacker procs. The attacker is hurt
   * with source 'thorns', which §5.2.1's table marks Protection-applicable — so
   * it is deliberately in ARMOR_SOURCES and IS armor-reduced here (this diverges
   * from vanilla, where Thorns bypasses armor; the spec is explicit). Direction
   * is victim→attacker per §5.2.4.
   */
  procThorns(source, opts) {
    const attacker = opts?.attacker;
    if (!attacker || attacker === this || attacker.dead) return;
    if (source !== 'melee' && source !== 'arrow') return;
    const procs = rollThorns(this.armor, this.world.rng);
    for (const { slot, damage } of procs) {
      const dx = attacker.pos.x - this.pos.x, dz = attacker.pos.z - this.pos.z;
      const h = Math.hypot(dx, dz) || 1;
      attacker.hurt(damage, 'thorns', { dirX: dx / h, dirZ: dz / h, knockback: 0, attacker: this });
      this.damageArmorSlot(slot, 2);
    }
  }

  onHurt(dmg, source, opts) {
    this.procThorns(source, opts);
    this.hurtTilt = 8;
    this.hurtTiltDir = this.world.rng() < 0.5 ? -1 : 1;
    if (LivingEntity.ARMOR_SOURCES.has(source)) this.addExhaustion(0.1);
    // §3.3 — post-i-frame, post-armor. 'fall' is excluded: the landing already
    // emits player.fall.big for exactly this hit.
    if (dmg > 0 && source !== 'fall') {
      if (source === 'fire' || source === 'burn' || source === 'lava') this._selfSound('player.hurt.fire');
      else if (source === 'drown') this._selfSound('player.hurt.drown');
      else this._selfSound('player.hurt');
    }
    if (!this.isNetPlayer) audio.duck();   // §4.3: music steps aside while YOU panic
    this.world.game?.onPlayerHurt?.(dmg, source);
  }

  // B4 — Totem of Undying: die() is the last exit before death is final; a
  // totem in the OFFHAND consumes itself and undoes it (1 HP + Absorption II
  // + Regeneration II + fire out). totemSave is pure (U17 pins the contract).
  die(source, opts) {
    if (totemSave(this, this.world)) {
      // totem-pop feedback: gold particle burst + the levelup chime reused
      const p = this.world.game?.particles;
      if (p?.spawn && p?.colored) {
        for (let i = 0; i < 24; i++) {
          p.spawn(p.colored(0xffd54a, 0.1), this.pos.x, this.pos.y + 1, this.pos.z,
            (Math.random() - 0.5) * 0.4, Math.random() * 0.3, (Math.random() - 0.5) * 0.4, 16, 0);
        }
      }
      this._selfSound('player.levelup');     // reuse the existing levelup chime
      return;                                // NOT dead — skip onDeath entirely
    }
    super.die(source, opts);
  }

  onDeath() {
    const game = this.world.game;
    this._selfSound('player.death');
    // 06 §14.1 — the craft grid / transient enchant-anvil-grindstone inputs /
    // cursor return to the inventory FIRST, so §13's drop loop below covers them
    // too. Closing on state change instead spilled them back into an inventory
    // that had already been emptied — a keep-inventory bypass. Local player only:
    // a remote player's death must not close the HOST's own screen. close(true)
    // is silent and re-entrant (it early-returns once kind is null).
    if (game?.player === this) game.ui?.containers?.close?.(true);
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
    game?.onPlayerDeath?.(this);
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
    this.foodTickTimer = 0; clearEffects(this);   // §4.3 — respawn full effect + absorption wipe
    this.air = 300;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.fireTicks = 0; this.fallDistance = 0; this.invulnTicks = 0;
    this.sprinting = false; this.sneaking = false; this.flying = false;
    this.gliding = false;   // 11-END §10 — transient
    this.usingItem = null;
    this.dead = false;
    this.yaw = 0; this.pitch = 0;   // facing −Z
  }

  // -------------------------------------------------- persistence (01 §16)

  serialize() {
    // 08 §13 / AMENDS 06 §18: every serialized stack is {id, count, damage?,
    // tags?}. cloneStack deep-copies tags and preserves unknown keys, so a 09+
    // key survives a round-trip through a build that predates its owner.
    const packStacks = arr => arr.map(s => cloneStack(s));
    // 01 §16 — the WRITE side of the non-finite quarantine. A NaN player position
    // was written into meta.players, after which Continue is a black screen
    // forever with no way back short of clearing site data.
    const fin = (v, d) => (Number.isFinite(v) ? v : d);
    return {
      pos: [fin(this.pos.x, 0), fin(this.pos.y, 80), fin(this.pos.z, 0)],
      vel: [fin(this.vel.x, 0), fin(this.vel.y, 0), fin(this.vel.z, 0)],
      yaw: fin(this.yaw, 0), pitch: fin(this.pitch, 0),
      dimension: this.dim,        // 10-NETHER §2.4 — restore the active dim on load
      health: fin(this.health, 20),
      // 01 §16 — `dead` must round-trip: Game's LOADING gate branches on it, but
      // without persistence a death-screen save reloaded as health-0-but-alive.
      dead: this.dead,
      hunger: fin(this.foodLevel, 20), saturation: this.saturation, exhaustion: this.exhaustion,
      effects: serializeEffects(this), absorption: this.absorption,   // 09-POTIONS §16
      // 08 §13 — `xp` is CURRENT total points (spend-sensitive); `xpEarnedTotal`
      // is the lifetime Score counter (§3.2). Before E4 this field wrote
      // xpTotal (lifetime) and deserialize replayed it as current — harmless
      // only because nothing could spend XP. The enchanting table spends, so a
      // reload would have handed every spent level straight back. See
      // DEVIATIONS.md; the read side stays backward-compatible.
      xp: currentXp(this),
      xpEarnedTotal: this.xpTotal,
      enchantSeed: this.enchantSeed,
      air: fin(this.air, 300), fireTicks: this.fireTicks, fallDistance: this.fallDistance,
      gameMode: this.gameMode,
      inventory: packStacks(this.inventory),
      armor: packStacks(this.armor),
      offhand: cloneStack(this.offhand),
      selectedSlot: this.selectedSlot,
      spawnPoint: this.spawnPoint,
    };
  }

  deserialize(rec) {
    super.deserialize(rec);
    this.dim = rec.dimension ?? 0;        // 10-NETHER §2.4 — Game.startWorld reads this
    this.pitch = rec.pitch ?? 0;
    this.health = rec.health ?? 20;
    // The `?? (health <= 0)` fallback repairs already-written 0-HP saves;
    // respawn() clears the flag.
    this.dead = rec.dead ?? (this.health <= 0);
    this.foodLevel = rec.hunger ?? 20;
    this.saturation = rec.saturation ?? 5;
    this.exhaustion = rec.exhaustion ?? 0;
    // 09-POTIONS §16 — restore effects + absorption; migrate a legacy
    // foodPoisonTicks timer into a Hunger effect entry (AMENDS 06 §12.4).
    applyEffectsData(this, rec.effects);
    if (rec.foodPoisonTicks > 0 && !this.effects.has(EFFECT.HUNGER)) {
      this.effects.set(EFFECT.HUNGER, { amplifier: 0, duration: rec.foodPoisonTicks, ambient: false });
    }
    this.absorption = rec.absorption ?? 0;
    this.air = rec.air ?? 300;
    this.fireTicks = rec.fireTicks ?? 0;
    this.fallDistance = rec.fallDistance ?? 0;
    // AMENDS 01 §16.1 / 18 §1.2 — pre-EC saves stored the string form.
    this.gameMode = normalizeGameMode(rec.gameMode);
    this.flying = false;                  // AMENDS 03 §2.4: transient, never persisted
    this.gliding = false;                 // 11-END §10 — transient, never persisted
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
    // 08 §13 — restore the lifetime counter AFTER addXp (which drives xpTotal
    // up as a side effect of rebuilding the ladder). Pre-E4 saves have no
    // xpEarnedTotal; their `xp` was the lifetime total and nothing could spend,
    // so lifetime == current and falling back to it is exactly right.
    // §13: "absent fields default (no migration)" — SAVE_VERSION stays 1.
    this.xpTotal = rec.xpEarnedTotal ?? rec.xp ?? 0;
    // §3.3 — missing enchantSeed derives from the world seed.
    this.enchantSeed = (rec.enchantSeed ?? this.defaultEnchantSeed()) >>> 0;
    this.prevPos.x = this.pos.x; this.prevPos.y = this.pos.y; this.prevPos.z = this.pos.z;
  }
}
