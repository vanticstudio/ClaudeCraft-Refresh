// Mining / placing / using / attacking (03 §14–17, 05 §13.3, 06 item uses).
import {
  BLOCKS, B, harvestOK, isSolidSupport, FACING_DIR, WALL_DIR, matOf,
  WATERLOGGED, STATE_NIBBLE,
} from '../registry/blocks.js';
import { igniteAt } from '../world/fire.js';
import { ITEMS, idOf } from '../registry/items.js';
import { raycastBlocks } from '../world/raycast.js';
import { LivingEntity } from '../entities/Entity.js';
import { EyeOfEnder } from '../entities/EyeOfEnder.js';   // 11-END §3
import { EndCrystal } from '../entities/EndCrystal.js';   // 13-BOSSES §3
import { beaconActive } from '../world/Beacon.js';        // 13-BOSSES §9.2 — on-GUI-open recheck
import { emitSound, startLoop, at } from '../audio/engine.js';
import { AABB } from '../math/aabb.js';
import { KEYBINDS } from '../constants.js';
import { cloneStack, tagsEqual, getEnchantLvl, packContainer, unpackContainer } from '../items/tags.js';
import { supportCell } from '../redstone/dirs.js';   // 07 §2 — ATTACH → support cell
import { ENCH } from '../items/enchants.js';
import { EFFECT, effectLevel, addEffect, applyInstant } from '../status/effects.js';
import { POTIONS } from '../status/potions.js';
import {
  meleeEnchBonus, silkDrop, silkSuppressesXp, silkSuppressesOnBroken,
} from '../items/effects.js';
import { tryIgnitePortal } from '../world/Portal.js';
import { getDimension } from '../world/dimensions.js';
import { faceToIndex as faceIndex } from '../net/protocol.js';   // 14 — face byte for blockEdit/useBlock

const REPLACEABLE_TARGET = id => BLOCKS[id]?.replaceable;

/**
 * 18 §5.4 — "id = the placeable item that yields this block". Every id in
 * items.js's NO_BLOCK_ITEM set has no block-item of its own, so `ITEMS.get(id)`
 * on one of them is undefined and pick-block would silently no-op; the ones that
 * DO have a yielding item are mapped here. Deliberately unmapped: air/water/lava/
 * fire, nether_portal, spawner, end_portal and end_gateway — nothing places
 * those, so §5.4's rule does not reach them and the `if (!item) return` fallback
 * is the correct behaviour. Built lazily on first use so no module-evaluation
 * order can ever have idOf() read a half-populated NAME_TO_ID.
 */
let PICK_AS = null;
function pickAsId(hitId) {
  if (!PICK_AS) {
    PICK_AS = new Map([
      // lit variants place from their base block-item (06 §1, 12 §1.1)
      [B.FURNACE_LIT, B.FURNACE], [B.BLAST_FURNACE_LIT, B.BLAST_FURNACE],
      [B.SMOKER_LIT, B.SMOKER], [B.REDSTONE_LAMP_LIT, B.REDSTONE_LAMP],
      [B.PISTON_HEAD, B.PISTON],
      // 06 §1 — farmland/dirt_path's palette equivalent is dirt
      [B.FARMLAND, B.DIRT], [B.DIRT_PATH, B.DIRT],
      // blocks whose yielding item is a plain item, not a block-item
      [B.REDSTONE_WIRE, idOf('redstone')], [B.OAK_DOOR, idOf('oak_door')],
      [B.BED_BLOCK, idOf('bed')], [B.NETHER_WART, idOf('nether_wart')],
      [B.WHEAT_CROP, idOf('wheat_seeds')], [B.CARROT_CROP, idOf('carrot')],
      [B.POTATO_CROP, idOf('potato')],
    ]);
  }
  return PICK_AS.get(hitId) ?? hitId;
}
const FATIGUE_MULT = [0.3, 0.09, 0.0027, 0.00081];   // 09-POTIONS §3.3 (amp 0..3+)

/**
 * 12-VILLAGES §7.3 — the composter's compost-chance table, transcribed row for
 * row from the spec (30/50/65/85%). Item id → P(this item adds a layer). Built
 * lazily for the same reason as PICK_AS: idOf() must never read a half-populated
 * NAME_TO_ID at module-evaluation time. Block-items share their block's id, so
 * the B.* constants are the item ids for saplings/leaves/flowers/hay.
 */
let COMPOST_CHANCE = null;
function compostChance(itemId) {
  if (!COMPOST_CHANCE) {
    COMPOST_CHANCE = new Map();
    const row = (p, ids) => { for (const i of ids) COMPOST_CHANCE.set(i, p); };
    row(0.30, [idOf('wheat_seeds'), B.OAK_SAPLING, B.BIRCH_SAPLING, B.SPRUCE_SAPLING,
      B.OAK_LEAVES, B.BIRCH_LEAVES, B.SPRUCE_LEAVES, B.SHORT_GRASS, B.DEAD_BUSH]);
    row(0.50, [idOf('sugar_cane'), B.CACTUS]);
    row(0.65, [idOf('apple'), idOf('carrot'), idOf('potato'), idOf('wheat'),
      B.PUMPKIN, B.DANDELION, B.POPPY, B.BROWN_MUSHROOM, B.RED_MUSHROOM]);
    row(0.85, [idOf('bread'), idOf('baked_potato'), B.HAY_BALE]);
  }
  return COMPOST_CHANCE.get(itemId) ?? 0;
}

function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class Interaction {
  constructor(game) {
    this.game = game;
    this.targetPos = null;      // mining target
    this.progress = 0;
    this.mineDelay = 0;
    this.useDelay = 0;
    this.swingTicks = 99;       // viewmodel swing progress (6-tick anim)
    this.currentHit = null;     // per-tick raycast result for highlight
    this.crackStage = -1;
    this.crackPos = null;       // 03 §15.4 — overlay cell, so a target change moves it
    this.pearlCooldown = 0;
    // 03 §15.3 — "if the press tick targets an entity, that click is an attack and
    // mining does not start until re-press". Latched for the whole hold: leftPressed
    // is a one-tick edge, so without this the very next tick mines the wall behind
    // the mob.
    this.attackHold = false;
    // 11-END §8.6 — post-eat item cooldown (chorus fruit's 20 t). Same idiom as
    // pearlCooldown; every other food declares eatCooldown 0.
    this.eatCooldown = 0;
    this.bowLoop = null;        // §3.3 item.bow.draw handle
    // 14-MULTIPLAYER §5.6 — the host reuses break/place/attack for a REMOTE player
    // by temporarily swapping the active player (all logic reads this.player).
    this._activePlayer = null;
  }

  stopBowLoop() {
    this.bowLoop?.stop(0.05);
    this.bowLoop = null;
  }

  get player() { return this._activePlayer ?? this.game.player; }
  get world() { return this.game.world; }

  // 03 §1 / AMENDS 03 §21(d) — creative keeps the 5.2 reach the old debug mode had.
  reach() { return this.player.creative ? 5.2 : 4.5; }

  lookDir() {
    const p = this.player;
    const cp = Math.cos(p.pitch);
    return { x: -Math.sin(p.yaw) * cp, y: Math.sin(p.pitch), z: -Math.cos(p.yaw) * cp };
  }

  eyePos() {
    const p = this.player;
    return { x: p.pos.x, y: p.pos.y + p.eyeHeight, z: p.pos.z };
  }

  rayHit(dist = this.reach(), opts = {}) {
    const e = this.eyePos(), d = this.lookDir();
    return raycastBlocks(this.world, e.x, e.y, e.z, d.x, d.y, d.z, dist, opts);
  }

  swing() { this.swingTicks = 0; if (this.player) this.player.swingTime = 6; }   // 14 — SWINGING flag for others

  tick(input) {
    const p = this.player;
    if (this.mineDelay > 0) this.mineDelay--;
    if (this.useDelay > 0) this.useDelay--;
    if (this.pearlCooldown > 0) this.pearlCooldown--;
    if (this.eatCooldown > 0) this.eatCooldown--;
    if (this.swingTicks < 99) this.swingTicks++;
    // Dying returns before updateUseChannel ever runs, and usingItem is not
    // cleared until respawn() — without this the draw loop drones until then.
    if (p.dead) { this.resetMining(); this.stopBowLoop(); p.usingItem = null; return; }

    // hotbar selection
    const prevSlot = p.selectedSlot;
    if (input.hotbar >= 0) p.selectedSlot = input.hotbar;
    if (input.wheel) {
      p.selectedSlot = ((p.selectedSlot + input.wheel) % 9 + 9) % 9;
      this.game.ui?.hud?.onHotbarChange?.();
    }
    if (input.hotbar >= 0) this.game.ui?.hud?.onHotbarChange?.();
    // §3.3 is a selection *change*: pressing '1' on slot 1 must stay silent, and
    // a tick with both wheel and digit input must click once, not twice.
    if (p.selectedSlot !== prevSlot) emitSound('ui.hotbar', null);

    this.currentHit = this.rayHit();

    // drop (03 §17)
    if (input.pressed.has('KeyQ')) this.dropHeld(input.shift);

    // swap offhand (08 §7.2; AMENDS 01 §15.1 / 03 §3)
    if (input.pressed.has(KEYBINDS.swapOffhand)) this.swapOffhand();

    // middle-click pick block (18 §5.4; AMENDS 06 §14.2)
    if (input.middlePressed && p.creative && this.currentHit) {
      this.pickBlock(this.currentHit, input.ctrl);
    }

    // §5.1 — re-clicking bypasses the 6-tick hold cooldown (a HELD button does
    // not). Without this, creative breaking is capped at 1 block / 6 ticks even
    // when the player clicks faster.
    if (input.leftPressed && p.creative) this.mineDelay = 0;

    // §15.3 — the attack suppression lasts until the button is RELEASED, not just
    // for the press tick.
    if (!input.mouseLeft) this.attackHold = false;

    // attack on press (entity priority, 03 §14/§15.3)
    let attacked = false;
    if (input.leftPressed) {
      const target = this.pickEntityTarget();
      if (target) {
        this.attack(target);
        attacked = true;
        this.attackHold = true;
        this.resetMining();
      }
    }

    // Mining while held. §15.3's "mining does not start until re-press" is what
    // attackHold enforces — currentHit is a pure BLOCK ray, so without it the
    // second tick of a hold mines the wall straight through the mob just punched.
    // `leftPressed` is ORed in so a click whose down and up both land inside one
    // 50 ms tick still mines: the level flag alone silently dropped the whole
    // break (creative and hardness-0 blocks finish in a single tick) while the
    // same click still attacked — proof the input had registered.
    // 07-REDSTONE §12.2 — "plays when … left-click punch starts (plays the current
    // note without incrementing)". The RMB arm is registered as onUse on B.NOTE_BLOCK;
    // the punch arm had RedstoneComponents.notePunch defined with ZERO call sites,
    // so punching a note block was silent. Press edge only, and before mining (a
    // note block is hardness 0.8, so the punch never races its own break).
    if (input.leftPressed && !attacked && this.currentHit && this.currentHit.id === B.NOTE_BLOCK) {
      const h = this.currentHit;
      this.game.redstoneComponents?.notePunch(h.x, h.y, h.z, this.world.getState(h.x, h.y, h.z));
    }

    if ((input.mouseLeft || input.leftPressed) && !attacked && !this.attackHold) this.updateMining();
    else this.resetMining();

    // use-item channel: eating / bow draw
    this.updateUseChannel(input);

    // RMB: on press and every 4 ticks while held (03 §16.1)
    if ((input.rightPressed || (input.mouseRight && this.useDelay === 0)) && !p.usingItem) {
      this.use(input);
    }

    // crack overlay stage. 03 §15.4: "removed instantly on reset/target change" —
    // so the CELL is part of the guard, not just the stage index. The old
    // `crackPos !== undefined` clause was always false (crackPos was never
    // assigned), which left the overlay parked on the previous block whenever the
    // new target happened to land on the same stage (both in stage 0 after a
    // target change is the common case).
    const t = this.targetPos;
    const stage = t && this.progress > 0
      ? Math.min(9, Math.floor(this.progress * 10)) : -1;
    const moved = (!!t !== !!this.crackPos) ||
      (t && this.crackPos &&
       (t.x !== this.crackPos.x || t.y !== this.crackPos.y || t.z !== this.crackPos.z));
    if (stage !== this.crackStage || moved) {
      this.crackStage = stage;
      this.crackPos = t ? { x: t.x, y: t.y, z: t.z } : null;
      this.game.updateCrack?.(t, stage);
    }
  }

  // ---------------------------------------------------------- pick block (18 §5.4)

  /**
   * 18 §5.4 — "state" is expressed by picking the right ITEM for the block
   * (a wall torch picks `torch`; a lit furnace picks `furnace`), not by a new
   * field on the stack: placement re-derives state from the placement context
   * (03 §16.2/§16.4), and the item-stack shape `{id,count,damage,tags?}` is
   * 08's to extend, not ours (§0 registry footprint).
   */
  pickBlock(hit, ctrl) {
    const p = this.player;
    // 18 §5.4 — "the placeable item that yields this block". A lit furnace has no
    // block-item of its own (06 §1) and neither do 13 other ids; PICK_AS maps
    // each to the item that does yield it.
    const id = pickAsId(hit.id);
    const item = ITEMS.get(id);
    if (!item) return;                       // air/water/lava/fire/crops: nothing to pick
    const stack = { id, count: item.stack ?? 64 };
    const tags = ctrl ? this.pickTags(hit) : undefined;
    if (tags !== undefined) stack.tags = tags;

    const inv = p.inventory;
    // tagsEqual, not JSON.stringify: key order makes stringify compare unequal
    // objects equal-ish and equal objects unequal (08 §1 rule 5). Inert while
    // pickTags returns undefined, but it must not be the pattern E4 copies.
    const identical = i => inv[i] && inv[i].id === id && tagsEqual(inv[i], stack);
    for (let i = 0; i < 9; i++) {
      if (identical(i)) { p.selectedSlot = i; emitSound('ui.hotbar', null); return; }
    }
    let slot = inv[p.selectedSlot] ? -1 : p.selectedSlot;
    if (slot < 0) for (let i = 0; i < 9; i++) if (!inv[i]) { slot = i; break; }
    // Every hotbar slot full: replace the active one. The displaced stack is
    // discarded, not dropped — the palette is an infinite source, so there is
    // nothing to lose and item clutter while building is the bigger cost (§6.5).
    if (slot < 0) slot = p.selectedSlot;
    inv[slot] = stack;
    p.selectedSlot = slot;
    emitSound('ui.hotbar', null);
  }

  /**
   * 18 §5.4's Ctrl-modifier hook — "copy the block-entity/tags payload … so the
   * placed copy is identical". 08 has since frozen the `tags` shape and 11 §9.4
   * defined the one payload that exists in this build: a shulker box's 27 slots,
   * packed by Game's break path and already restored by tryPlace. Every other
   * block's block-entity content (chest/furnace/hopper) has no tags key to ride
   * on, so §5.4's copy does not reach them and the plain pick stands.
   */
  pickTags(hit) {
    if (hit.id !== B.SHULKER_BOX) return undefined;
    const slots = this.game.getBlockEntity(hit.x, hit.y, hit.z)?.data?.slots;
    if (!slots) return undefined;
    const containerItems = packContainer(slots);
    return containerItems.length ? { containerItems } : undefined;
  }

  // ---------------------------------------------------------- attacking

  pickEntityTarget() {
    const e = this.eyePos(), d = this.lookDir();
    const blockHit = this.currentHit;
    const maxT = Math.min(3.0, blockHit ? blockHit.t : 3.0);
    const box = new AABB(
      Math.min(e.x, e.x + d.x * 3) - 1, Math.min(e.y, e.y + d.y * 3) - 1, Math.min(e.z, e.z + d.z * 3) - 1,
      Math.max(e.x, e.x + d.x * 3) + 1, Math.max(e.y, e.y + d.y * 3) + 1, Math.max(e.z, e.z + d.z * 3) + 1);
    let best = null, bestT = maxT;
    // 13-BOSSES §3 — "ANY damage instance (melee at any charge, arrow, snowball/
    // egg, explosion) destroys it in one hit", and §3.1 makes melee the ONLY way
    // to clear the two caged pillars (ranged shots hit the bars first). The end
    // crystal is not a LivingEntity, so it advertises `damageable` instead —
    // the same predicate Arrow/ThrownProjectile already use.
    for (const ent of this.world.getEntitiesInBox(box,
        x => (x instanceof LivingEntity || x.damageable) && x !== this.player && !x.dead)) {
      const t = rayAABB(e, d, ent.getAABB());
      if (t !== null && t < bestT) { bestT = t; best = ent; }
    }
    return best;
  }

  attack(target) {
    const p = this.player;
    const item = p.heldItem();
    // 09-POTIONS §3.4 / AMENDS 05 §13.1 — Strength +3L, Weakness −4L, floored 0.
    const base = Math.max(0, (item?.attackDamage ?? 1)
      + 3 * effectLevel(p, EFFECT.STRENGTH) - 4 * effectLevel(p, EFFECT.WEAKNESS));
    // AMENDS 05 §13.2 — Haste speeds attack cooldown recovery ×(1+0.1L).
    const speed = (item?.attackSpeed ?? 4.0) * (1 + 0.1 * effectLevel(p, EFFECT.HASTE));
    const T = 20 / speed;
    const charge = Math.min(1, Math.max(0, (p.ticksSinceAttack + 0.5) / T));
    // AMENDS 05 §13.1: damage = base × (0.2+0.8p²) × (crit?1.5:1) + enchBonus×p.
    // The enchBonus term lands with the catalog in E4 (08 §5.4) and is added
    // AFTER the crit multiply — it scales linearly with p and is never crit-
    // multiplied (Java exact).
    let dmg = base * (0.2 + 0.8 * charge * charge);

    // 13-BOSSES AMENDS 05 §13.4 — crits never apply to the dragon's part hitboxes.
    const crit = p.vel.y < 0 && !p.onGround && charge >= 0.848 &&
                 !p.sprinting && !p.inWater && !p.onLadder && !target.isDragonPart;
    if (crit) dmg *= 1.5;
    // 08 §5.4.1 — the enchBonus term. Added AFTER the crit multiply and scaled
    // linearly by charge, so it is never ×1.5'd (Java exact). Checklist:
    // Sharpness V diamond sword full charge = 7 + 3 = 10; falling crit =
    // 7×1.5 + 3 = 13.5.
    dmg += meleeEnchBonus(p.heldStack, target) * charge;

    // ---- 08 §6.1 sweep trigger. Evaluated BEFORE the sprint block below, which
    // clears p.sprinting and scales p.vel — conditions 4 and 5 read pre-attack
    // state, so testing after it would make every sprint hit sweep.
    const wasSprinting = p.sprinting;
    const hSpeed = Math.hypot(p.vel.x, p.vel.z);
    const sweeps =
      item?.toolClass === 'sword' &&      // 1. sword, any tier
      charge >= 0.848 &&                  // 2. same threshold as crits (05 §13.4)
      p.onGround &&                       // 3.
      !wasSprinting &&                    // 4. a sprint-knockback hit never sweeps
      hSpeed < 0.25;                      // 5. walking can sweep, sprint-speed cannot

    // §6.2's halo is centred on the struck mob's box, so the victim set must be
    // gathered before the primary's hurt() knocks it backwards.
    const victims = sweeps ? this.sweepVictims(target) : null;

    // AMENDS 05 §14.3 / 08 §5.4.2 — knockback strength = 0.4 + 0.5 × (L + sprint).
    // Knockback II sprint-hit = 1.9. At L=0 this is the base 0.4 / 0.9 exactly.
    const kb = 0.4 + 0.5 * (getEnchantLvl(p.heldStack, ENCH.KNOCKBACK) + (wasSprinting ? 1 : 0));
    if (wasSprinting) {
      p.stopSprint();
      p.vel.x *= 0.6; p.vel.z *= 0.6;
    }

    const dx = target.pos.x - p.pos.x, dz = target.pos.z - p.pos.z;
    const h = Math.hypot(dx, dz) || 1;
    target.hurt(dmg, 'melee', { dirX: dx / h, dirZ: dz / h, knockback: kb, attacker: p });

    // 08 §5.4.3 — Fire Aspect ignites on ANY landed melee hit (any charge),
    // 80 ticks/level. Applied after hurt() so a killing blow does not waste it.
    // Optional-call: setOnFire lives on LivingEntity, and pickEntityTarget now
    // also returns `damageable` non-living targets (13-BOSSES §3's end crystal).
    // A ritual-invulnerable crystal returns false from hurt() and stays !dead,
    // so this is reachable — every other target dies before the line.
    const fireAspect = getEnchantLvl(p.heldStack, ENCH.FIRE_ASPECT);
    if (fireAspect > 0 && !target.dead) target.setOnFire?.(80 * fireAspect);

    if (crit) this.game.particles?.crit?.(target);
    if (sweeps) this.doSweep(victims, base, charge);
    if (item?.toolClass) p.damageHeld(item.toolClass === 'sword' ? 1 : 2);
    p.addExhaustion(0.1);
    p.ticksSinceAttack = 0;
    this.swing();
    // 14 §7.3 — the client claims the hit it SAW; the host validates against its
    // own positions and applies the authoritative damage (local damage is no-op'd
    // via the puppet's beforeHurt). Send the host entity id.
    if (this.game.net?.isClient) this.game.net.sendAttack(target.netId ?? target.id);
  }

  // 08 §6.2 — everything alive in the struck mob's halo, within 3 blocks of the
  // player's feet. Java exact: the halo tracks the victim, not the attacker.
  sweepVictims(target) {
    const p = this.player;
    // getEntitiesInBox already tests box.intersects(e.getAABB()), so the halo
    // membership test is the box argument itself; the filter adds only §6.2's
    // identity and 3-block range clauses.
    const halo = target.getAABB().expand(1.0, 0.25, 1.0);
    return this.world.getEntitiesInBox(halo,
      e => e instanceof LivingEntity && e !== p && e !== target && !e.dead &&
           ((e.pos.x - p.pos.x) ** 2 + (e.pos.y - p.pos.y) ** 2 +
            (e.pos.z - p.pos.z) ** 2) < 9.0);
  }

  // 08 §6.3 / §6.4 — flat damage to each victim, all pushed the same way (the
  // player's look direction), sound + arc once per swing.
  doSweep(victims, weaponBase, charge) {
    const p = this.player;
    // ratio = sweepingEdgeLvl/(sweepingEdgeLvl+1) → 0, 1/2, 2/3, 3/4 for L 0–III.
    // A plain sword is L0 → ratio 0 → sweepDmg exactly 1 ("plain iron sword →
    // 1 HP to victims"). Checklist: iron sword (base 6) + Sweeping Edge I at
    // full charge → 1 + ½×(6×1) = 4 HP to secondaries.
    const sweepLvl = getEnchantLvl(p.heldStack, ENCH.SWEEPING_EDGE);
    const ratio = sweepLvl / (sweepLvl + 1);
    // No Sharpness/Smite/Bane and no crit multiplier in the sweep at the 1.20
    // baseline — they entered the sweep only in 1.21, deliberately not adopted.
    const sweepDmg = 1 + ratio * (weaponBase * (0.2 + 0.8 * charge * charge));

    // §5.4.3 — Fire Aspect applies to sweep secondaries too (Java 1.20, MC-93669
    // fixed). §5.4.2's Knockback deliberately does NOT (§6.4).
    const fireAspect = getEnchantLvl(p.heldStack, ENCH.FIRE_ASPECT);

    // Direction is the player's horizontal look, identical for every victim.
    const lx = -Math.sin(p.yaw), lz = -Math.cos(p.yaw);
    for (const v of victims) {
      if (v.dead) continue;
      // 0.4 × 0.8 = 0.32 — 80% of base, replacing the normal knockback rather
      // than stacking with it. The Knockback enchant does not boost this.
      v.hurt(sweepDmg, 'melee', { dirX: lx, dirZ: lz, knockback: 0.32, attacker: p });
      if (fireAspect > 0 && !v.dead) v.setOnFire(80 * fireAspect);
    }
    this.game.particles?.sweep?.(p.pos.x, p.pos.y, p.pos.z, p.yaw);
    emitSound('player.attack.sweep', null);
  }

  // ---------------------------------------------------------- mining (03 §15)

  miningDamagePerTick(block) {
    if (block.hardness < 0) return 0;
    if (block.hardness === 0) return 1;
    const p = this.player;
    const item = p.heldItem();
    const toolClass = item?.toolClass ?? null;
    let speed = 1.0;
    const isBestTool = toolClass && toolClass === block.tool;
    if (isBestTool) {
      speed = item.speedMult ?? 1;
      if (toolClass === 'shears') {
        speed = block.name.startsWith('wool') ? 5 : 15;   // 06 §1 special
      }
    }
    // AMENDS 03 §15.2 / 08 §5.6.1 — Efficiency: when isBestTool && speed > 1,
    // speed += L² + 1 (E I…V: +2/+5/+10/+17/+26). Shears on leaves/wool qualify:
    // their 15/5 multipliers are > 1. Applied BEFORE the ÷5s (Java order).
    const eff = getEnchantLvl(p.heldStack, ENCH.EFFICIENCY);
    if (isBestTool && speed > 1 && eff > 0) speed += eff * eff + 1;
    // 09-POTIONS §3.3 / AMENDS 03 §15.2 — Haste ×(1+0.2L); Mining Fatigue ×FATIGUE_MULT.
    const lHaste = effectLevel(p, EFFECT.HASTE);
    if (lHaste > 0) speed *= 1 + 0.2 * lHaste;
    const lFatigue = effectLevel(p, EFFECT.MINING_FATIGUE);
    if (lFatigue > 0) speed *= FATIGUE_MULT[Math.min(lFatigue - 1, 3)];
    // AMENDS 03 §15.2 / 08 §5.3 — Aqua Affinity (helmet) cancels the submerged
    // ÷5. The !onGround ÷5 is unaffected by any enchant, so floating underwater
    // with Aqua Affinity is ÷5, not ÷25.
    if (p.eyeSubmerged && getEnchantLvl(p.armor[0], ENCH.AQUA_AFFINITY) === 0) speed /= 5;
    if (!p.onGround) speed /= 5;
    let damage = speed / block.hardness;
    damage /= harvestOK(block, toolClass, item?.tier ?? null) ? 30 : 100;
    return damage;
  }

  updateMining() {
    const p = this.player;
    if (this.mineDelay > 0) { this.swingLoop(); return; }
    const hit = this.currentHit;
    if (!hit) { this.resetMining(); return; }
    const block = BLOCKS[hit.id];

    // 18 §5.1 — instant break. Routed THROUGH breakBlock (rather than its own
    // setBlock, as the old debug path did) so it inherits the break sound, the
    // waterlog rule (15 §10.6) and the block-entity spill (§5.2) for free; the
    // flags suppress only the three things creative removes.
    if (p.creative) {
      // §5.2: hardness −1 (bedrock/water/lava) stays unbreakable in creative.
      if (block.hardness < 0) { this.resetMining(); return; }
      this.breakBlock(hit.x, hit.y, hit.z, { drops: false, xp: false, durability: false });
      this.resetMining();
      this.swing();
      this.mineDelay = 6;      // §5.1: 0.3 s hold cooldown; a re-click bypasses it
      return;
    }

    if (!this.targetPos || this.targetPos.x !== hit.x || this.targetPos.y !== hit.y || this.targetPos.z !== hit.z) {
      this.targetPos = { x: hit.x, y: hit.y, z: hit.z };
      this.progress = 0;
    }
    const d = this.miningDamagePerTick(block);
    if (d <= 0) { this.swingLoop(); return; }
    if (d >= 1) {
      this.breakBlock(hit.x, hit.y, hit.z);
      this.resetMining();          // instant: no inter-block delay
      this.swing();
      return;
    }
    this.progress += d;
    // §3.2: dig ticks every 6 ticks, aligned to the swing loop. Read the gate
    // BEFORE swingLoop() — swing() resets swingTicks to 0, so testing after it
    // would never fire. The d >= 1 instant path returned above, so instant
    // breaks are excluded for free.
    if (this.swingTicks >= 6) {
      const cls = matOf(hit.id);
      if (cls) emitSound(`block.dig.${cls}`, at(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5));
    }
    this.swingLoop();
    if (this.progress >= 1) {
      this.breakBlock(hit.x, hit.y, hit.z);
      this.resetMining();
      this.mineDelay = 6;          // 0.3 s between blocks
    }
  }

  swingLoop() {
    if (this.swingTicks >= 6) this.swing();
  }

  resetMining() {
    this.targetPos = null;
    this.progress = 0;
  }

  /**
   * AMENDS 06 block-break/drop path — `opts` lets 18 §5.2's creative break
   * suppress loot, XP and durability while keeping everything else identical.
   * Block-entity contents still spill: that happens inside World.setBlock
   * (World.js:133), so a full chest is never silently voided.
   */
  breakBlock(x, y, z, opts = {}) {
    const { drops: wantDrops = true, xp: wantXp = true, durability: wantDur = true } = opts;
    const p = this.player;
    const id = this.world.getBlock(x, y, z);
    const block = BLOCKS[id];
    const state = this.world.getState(x, y, z);
    const item = p.heldItem();
    const toolClass = item?.toolClass ?? null;
    const toolTier = item?.tier ?? null;

    // 08 §5.6.2/§5.6.3 — Silk Touch and Fortune. `fortune` rides in the drop ctx
    // so each block's own closure can apply its rule (§5.6.3 is a per-block
    // table, not one multiplier); the §2 columns are the L=0 case and are
    // unchanged when it is 0. World.popBlock and Game's explosion path build
    // their own ctx without these keys — neither has a player, and neither can
    // be enchanted, so they keep the base behavior untouched.
    const silk = getEnchantLvl(p.heldStack, ENCH.SILK_TOUCH) > 0;
    const fortune = getEnchantLvl(p.heldStack, ENCH.FORTUNE);
    const ctx = { state, toolClass, toolTier, rng: this.world.rng, fortune, silk };

    // §5.6.2: Silk replaces the drop table for listed blocks, but the harvest-
    // tier rule still applies — a silk stone pick on diamond ore drops nothing.
    const silked = silk ? silkDrop(block) : null;
    const drops = !wantDrops ? []
      : silked ? (harvestOK(block, toolClass, toolTier) ? silked : [])
        : (block.drops ? block.drops(ctx) : []);
    // §5.6.2: mining XP for silk-touched ores is 0.
    const xp = wantXp && block.xpForMine && !(silked && silkSuppressesXp(block))
      ? block.xpForMine(ctx) : 0;

    // 15 §10.6 — a waterlogged block breaks to a water SOURCE, not air; drops
    // then run unchanged. `state` was read above, before the erase, so bit 7 is
    // already in hand.
    if (state & WATERLOGGED) this.world.setBlock(x, y, z, B.WATER, { state: 0, byPlayer: true });
    // 08 §5.6.2 — a Silk Touch break of ice leaves AIR: suppress ice's onBroken,
    // which would otherwise revert the cell to water (06 §5.10).
    else this.world.setBlock(x, y, z, B.AIR,
      { byPlayer: true, skipOnBroken: silk && silkSuppressesOnBroken(block) });
    for (const d of drops) {
      if (d.count > 0) this.game.spawnItemByName(d.name, d.count, x + 0.5, y + 0.5, z + 0.5);
    }
    if (xp > 0) this.game.spawnXpOrb(x + 0.5, y + 0.5, z + 0.5, xp);
    if (wantDur && block.hardness > 0 && item?.durability) {
      p.damageHeld(toolClass === 'sword' ? 2 : 1);
    }
    p.addExhaustion(0.005);
    // Punching fire reaches here via the instant-break path (hardness 0), but
    // fire's class is 'none' and has no break verb — it extinguishes (§3.3).
    if (id === B.FIRE) {
      emitSound('block.extinguish', at(x + 0.5, y + 0.5, z + 0.5));
    } else {
      const cls = matOf(id);
      if (cls) emitSound(`block.break.${cls}`, at(x + 0.5, y + 0.5, z + 0.5));
    }
    this.game.particles?.blockBreak?.(x, y, z, id);
    // 14 §4.5 — the client predicts the removal (drops/xp are host-only, no-op'd on
    // the client) and tells the host, which authoritatively re-runs the break.
    if (this.game.net?.isClient) this.game.net.sendBlockEdit(0, x, y, z, 0, p.selectedSlot);
  }

  // ---------------------------------------------------------- use channel

  updateUseChannel(input) {
    const p = this.player;
    if (!p.usingItem) return;
    const chan = p.usingItem;
    if (!input.mouseRight) {
      // release
      if (chan.kind === 'bow') this.releaseBow(chan.ticks, chan.hand ?? 'main');
      this.stopBowLoop();
      p.usingItem = null;
      return;
    }
    // UPDATE-polish §1 — cancel a STALE use-channel. The channel is otherwise only
    // cleared on release/completion, so drawing a bow (which never self-completes
    // while held) or starting to eat and THEN switching hotbar slot / dropping the
    // item WITHOUT releasing RMB left `usingItem` truthy — and the tick RMB gate
    // (`!p.usingItem`) then swallowed every right-click, so "right-click places
    // nothing" until the button was released. If the acting hand no longer holds
    // the item that started this channel, cancel it here so placement/interaction
    // resume the same tick. (Normal eat/drink/bow are unaffected — the held item
    // still matches.)
    const handItem = p.itemIn(chan.hand ?? 'main');
    const sustains = !!handItem && (
      (chan.kind === 'eat' && handItem.kind === 'food') ||
      (chan.kind === 'drink' && handItem.kind === 'potion') ||
      (chan.kind === 'bow' && handItem.name === 'bow'));
    if (!sustains) { this.stopBowLoop(); p.usingItem = null; return; }

    chan.ticks++;
    // §3.3 / AMENDS 06 §12.4: chew at use-ticks 8/16/24, swallow at 32.
    if (chan.kind === 'eat' && (chan.ticks === 8 || chan.ticks === 16 || chan.ticks === 24)) {
      emitSound('player.eat.chew', null);
    }
    if (chan.kind === 'eat' && chan.ticks >= 32) {
      emitSound('player.eat.swallow', null);
      p.burpTimer = 10;               // §3.3: burp 10 ticks later, always
      // 08 §7.3: the acting hand owns the channel — offhand food is eaten out
      // of the offhand, not whatever the main hand happens to hold.
      const hand = chan.hand ?? 'main';
      const item = p.itemIn(hand);
      if (item?.kind === 'food') {
        p.eat(item);
        p.consumeIn(hand, 1);
        // 11-END §8.6 — chorus fruit's 20 t; every other food declares 0, so the
        // channel reopens on the next tick exactly as before.
        this.eatCooldown = item.eatCooldown ?? 0;
      }
      p.usingItem = null;
    }
    // 09-POTIONS §11.2 — potion drink: gulp every 4 t, apply + return bottle at 32.
    if (chan.kind === 'drink') {
      if (chan.ticks % 4 === 0) emitSound('player.drink.gulp', null);
      if (chan.ticks >= 32) {
        const hand = chan.hand ?? 'main';
        const stack = p.stackIn(hand);
        if (ITEMS.get(stack?.id)?.kind === 'potion') this.drinkPotion(stack, hand);
        p.usingItem = null;
      }
    }
    // §3.3: the draw ramp — density 0.6->1.8, BP 350->550 Hz over the 20-tick draw
    if (chan.kind === 'bow' && this.bowLoop) {
      const k = Math.min(1, chan.ticks / 20);
      this.bowLoop.setParam('crackleRate', 0.6 + 1.2 * k, 0.05);
      this.bowLoop.setParam('crackleFreq', 350 + 200 * k, 0.05);
    }
  }

  releaseBow(ticks, hand = 'main') {
    const p = this.player;
    const f0 = ticks / 20;
    const charge = Math.min(1, (f0 * f0 + 2 * f0) / 3);
    if (charge < 0.1) return;

    // AMENDS 05 §11 / 08 §5.9 — bow enchants come from the DRAWN bow (which may
    // be the offhand one, §7.4), not from whatever the main hand holds.
    const bow = p.stackIn(hand);
    const infinite = getEnchantLvl(bow, ENCH.INFINITY) > 0;

    // §5.9 / §15.3 — pick the first arrow-class stack (plain 282 or tipped 378)
    // in scan order. Infinity spares only PLAIN arrows; tipped always consume.
    const ammo = this.pickArrowStack();
    if (!ammo) return;                              // no arrow anywhere → cannot fire
    const tipped = ammo.potionId != null;
    if (!p.creative && !(infinite && !tipped)) {
      const s = ammo.stack;
      if (--s.count <= 0) { if (ammo.where === 'off') p.offhand = null; else p.inventory[ammo.where] = null; }
    }

    // §7.4: a bow drawn in the offhand spends the OFFHAND bow's durability.
    // §5.7 gates this per point inside damageIn; §5.8 Mending repairs it.
    p.damageIn(hand, 1);
    const e = this.eyePos(), d = this.lookDir();
    const speed = 3 * charge;
    const rng = this.world.rng;
    const inacc = 0.0172275 * 1;
    const vx = d.x * speed + gaussian(rng) * inacc;
    const vy = d.y * speed + gaussian(rng) * inacc;
    const vz = d.z * speed + gaussian(rng) * inacc;
    // §5.9 — the arrow entity carries {powerLvl, punchLvl, flame, noPickup}.
    // Infinity arrows set noPickup and are never collectible (like skeleton arrows).
    this.game.spawnArrow(e.x, e.y - 0.1, e.z, vx, vy, vz, p, {
      crit: charge >= 1,
      fromPlayer: true,
      powerLvl: getEnchantLvl(bow, ENCH.POWER),
      punchLvl: getEnchantLvl(bow, ENCH.PUNCH),
      flame: getEnchantLvl(bow, ENCH.FLAME) > 0,
      noPickup: infinite && !tipped,
      potionId: ammo.potionId,        // 09-POTIONS §15.2 — tipped shots carry the effect
    });
    // Self event -> flat pool (§3.3). NOT inside Game.spawnArrow: skeletons share
    // that path and their shot must render positionally.
    emitSound('item.bow.shoot', null, 1, charge);
    this.swing();
  }

  // 08 §7.2 — in-world F: swap the selected hotbar stack ↔ offhand (slot 45).
  swapOffhand() {
    const p = this.player;
    // AMENDS 03 §3 says "F is ignored while an item-use channel is active
    // mid-bow-draw (draw cancels, no arrow fired)", while §7.2 says the swap
    // itself cancels an in-progress draw or eat. The only reading that leaves
    // both sentences true: mid-draw F cancels and does NOT swap; mid-eat F
    // cancels AND swaps. The clauses conflict — see DEVIATIONS.md (E3).
    if (p.usingItem?.kind === 'bow') {
      this.stopBowLoop();
      p.usingItem = null;
      return;
    }
    p.usingItem = null;                       // eat channel: cancelled, swap proceeds
    const held = p.heldStack;
    p.heldStack = p.offhand;
    p.offhand = held;
    // §7.2: counts as a main-hand item switch → resets the attack-charge timer.
    // Player.tick's id-change check would miss a sword↔sword swap; this is the
    // spec's "swapping always resets", not "resets when the item differs".
    p.ticksSinceAttack = 0;
    this.game.ui?.hud?.onHotbarChange?.();
  }

  // 08 §7.4 / AMENDS 05 §11 — the first arrow-class stack (plain or tipped) in
  // scan order: offhand → MAIN HAND → inventory 0→35 ascending. The main-hand
  // tier is the AMENDS order and outranks 09 §15.3's older "hotbar 0→8" prose,
  // which premised itself on there being no offhand (CLAUDE.md §2). It only
  // matters when a lower hotbar slot also holds arrows — bow in the offhand,
  // plain arrows in slot 0, tipped in the selected slot: the tipped fire.
  // Returns { where, stack, potionId } or null; `where` is 'off' or a numeric
  // inventory slot, which is what releaseBow's decrement expects (main hand IS
  // inventory[selectedSlot]).
  pickArrowStack() {
    const p = this.player, ARROW = idOf('arrow'), TIPPED = idOf('tipped_arrow');
    const ok = s => s && (s.id === ARROW || s.id === TIPPED) && s.count > 0;
    const pid = s => (s.id === TIPPED ? (s.tags?.potionId ?? null) : null);
    if (ok(p.offhand)) return { where: 'off', stack: p.offhand, potionId: pid(p.offhand) };
    if (ok(p.heldStack)) return { where: p.selectedSlot, stack: p.heldStack, potionId: pid(p.heldStack) };
    for (let i = 0; i < 36; i++) if (ok(p.inventory[i])) return { where: i, stack: p.inventory[i], potionId: pid(p.inventory[i]) };
    return null;
  }

  // ------------------------------------------- RMB (08 §7.3; AMENDS 03 §16.1)
  //
  // The canonical step list. Steps 1–5 run for the MAIN hand; if the main hand
  // PASSES (step 5), steps 3–4 rerun for the OFFHAND. The offhand never reruns
  // step 1 (UI) or step 2 (block-targeted uses). Only one hand can be "using".
  //
  // Sibling files insert against these numbers: 12 §7.1's shovel→dirt_path is
  // step 2b (inside useOnBlock); 09's potion drink is step 4 (inside useSelf).

  use(input) {
    const p = this.player;
    const hit = this.currentHit;

    // 14 §4.5/§6 — a CLIENT does not run RMB logic locally (containers, beds,
    // buckets, placement are host-authoritative). It sends a useBlock request and
    // the host resolves priority; results arrive as blockSet/containerOpen/etc.
    // (Placement therefore feels RTT-delayed for clients — accepted, §7.)
    if (this.game.net?.isClient) {
      this.swing();
      this.useDelay = 4;
      if (hit) this.game.net.sendUseBlock(hit.x, hit.y, hit.z, faceIndex(hit.face), p.selectedSlot);
      else this.game.net.sendJson({ t: 'useBlock', self: true, hotbarSlot: p.selectedSlot });
      return;
    }

    // Step 0 (outside §7.3): entity interaction — feeding/shearing the nearest
    // entity on the ray. §7.3's list begins at the block raycast and never
    // mentions entities; this is pre-existing 03 §16.1 behavior, kept ahead of
    // step 1 and main-hand only. See DEVIATIONS.md (E3).
    const entTarget = this.pickEntityTarget();
    if (entTarget && entTarget.interact) {
      if (entTarget.interact(p, p.heldStack)) {
        this.useDelay = 4;
        this.swing();
        return;
      }
    }

    // 1: interactable block → open its UI. Hand-independent, evaluated once.
    if (hit) {
      const block = BLOCKS[hit.id];
      if (block.interactable && !p.sneaking) {
        this.useDelay = 4;
        this.interactWith(block, hit);
        return;
      }
    }

    // 2: block-targeted item-on-block use — MAIN hand only (vanilla).
    if (this.useOnBlock(hit)) { this.useDelay = 4; return; }

    // 3–4 for the main hand, then the offhand only if the main hand PASSED.
    if (this.useHand('main', hit)) { this.useDelay = 4; return; }
    if (this.useHand('off', hit)) { this.useDelay = 4; return; }
    // 5: both hands passed — no action, no swing.
  }

  // §7.3 step 2 — MAIN HAND ONLY, deliberately not hand-parameterised. Every
  // helper below spends the main hand via consumeHeld/damageHeld/heldStack, and
  // §7.3 says the offhand never reruns step 2, so a `hand` argument here would
  // advertise a capability that does not exist: passing 'off' would read the
  // offhand's item and then consume the MAIN hand's stack. §7.3 invites 12 to
  // insert shovel→dirt_path at 2b — whoever does must keep it main-hand only.
  // Returns true only when the use actually PERFORMED; a hoe on stone or a
  // carrot on gravel returns false so the pipeline continues to steps 3–4.
  useOnBlock(hit) {
    const held = this.player.heldItem();
    if (!held) return false;
    // 2d: buckets run their own fluid ray, so they act without a block hit.
    if (held.name === 'bucket') return this.useBucketEmpty();
    if (held.name === 'water_bucket' || held.name === 'lava_bucket') {
      return this.useBucketFilled(held);
    }
    if (!hit) return false;
    if (held.toolClass === 'hoe') return this.useHoe(hit);                    // 2a
    if (held.toolClass === 'shovel') return this.useDirtPath(hit);            // 2b (12-VILLAGES §7.1)
    if (held.name === 'flint_and_steel') return this.useFlintSteel(hit);      // 2c
    if (held.plantsCrop != null) return this.plantSeed(held, hit);            // 2e
    if (held.name === 'bone_meal') return this.useBoneMeal(hit);              // 2e
    // 2e: shears — sheep shearing runs through step 0's entity interact.
    return false;
  }

  // §7.3 steps 3–4 for one hand. Returns true = done, false = PASS.
  useHand(hand, hit) {
    const p = this.player;
    const held = p.itemIn(hand);
    if (!held) return false;

    // 11-END §3/§5.2 — eye of ender: fill a targeted empty frame, else launch it
    // (overworld only). Handled before placement since it uses the block hit.
    if (held.kind === 'eye_of_ender') return this.useEyeOfEnder(hand, hit);
    // 13-BOSSES §3.4 — end crystal places a crystal entity on obsidian/bedrock only.
    if (held.kind === 'end_crystal') return this.useEndCrystal(hand, hit);

    // 3: placeable block. Per §7.3 a place that FAILS still consumes the
    // attempt and blocks the offhand — only "no block to place against" passes.
    if (held.place != null && hit) { this.tryPlace(held, hit, hand); return true; }
    if (held.placesAs && hit) { this.tryPlaceSpecial(held, hit, hand); return true; }

    // 4: self-use.
    return this.useSelf(hand, held);
  }

  // §7.3 step 4 — self-use items, not tied to a block. 09's potion drink lands
  // here. Returns true = done (even when the action fails, per §7.3), false =
  // this hand has no self-use → PASS.
  useSelf(hand, held) {
    const p = this.player;
    if (held.kind === 'food') {
      // AMENDS 06 §15.1 / 18 §4.3 — in creative, eating is a no-op that neither
      // heals nor consumes. Stated explicitly rather than leaning on the frozen
      // `foodLevel === 20` to keep the eat channel shut: that invariant lives in
      // two other files and is not this branch's to assume.
      // Food at hunger 20 still returns DONE: §7.3 counts it as a failed action
      // that consumes the press, so the offhand does not act on it.
      if (p.creative) return true;
      // 09-POTIONS §9.1 — the golden apple is always edible (bypasses the
      // full-hunger gate) so its Absorption + Regeneration are reachable when fed.
      // 11-END §8.6 — the post-eat item cooldown gate. Gated HERE rather than on
      // the shared RMB gate in tick(): that one also throttles legitimate rapid
      // re-clicks for placing, which 03 §16.1 permits. Still returns true, so the
      // offhand does not act during the cooldown.
      if ((held.alwaysEdible || p.foodLevel < 20) && !p.usingItem && this.eatCooldown === 0) {
        p.usingItem = { kind: 'eat', ticks: 0, hand };
      }
      return true;
    }
    // 09-POTIONS §11.2 — drink a potion (32-tick channel, no hunger requirement).
    if (held.kind === 'potion') {
      if (!p.usingItem) p.usingItem = { kind: 'drink', ticks: 0, hand };
      return true;
    }
    // §13/§14 — throw a splash/lingering potion.
    if (held.kind === 'splash_potion' || held.kind === 'lingering_potion') {
      this.throwPotion(held, hand);
      return true;
    }
    // §11.1 — fill an empty glass bottle from a targeted water cell.
    if (held.kind === 'bottle') { this.fillBottle(hand); return true; }
    if (held.name === 'bow') {
      // §7.4/§15.3: any arrow-class stack (plain or tipped) permits the draw.
      if (!p.usingItem && this.pickArrowStack()) {
        p.usingItem = { kind: 'bow', ticks: 0, hand };
        this.bowLoop = startLoop('item.bow.draw', null);
      }
      return true;
    }
    // DONE even when the throw fails: an ender_pearl on cooldown is a failed
    // action, not "this hand has no action". Returning throwHeld's boolean
    // PASSED to the offhand, so holding RMB through a 20-tick pearl cooldown
    // placed ~5 offhand torches the player never asked for (§7.3).
    if (held.kind === 'throwable') { this.throwHeld(held, hand); return true; }
    if (held.kind === 'armor') {
      const slot = held.armorSlot;
      if (p.armor[slot] == null) {
        p.armor[slot] = p.stackIn(hand);
        p.setStackIn(hand, null);
        // §3.3: metal chimes, leather rustles
        emitSound(held.name.startsWith('leather') ? 'player.armor_equip.leather' : 'player.armor_equip', null);
        this.swing();
      }
      return true;
    }
    return false;                         // 5: PASS
  }

  interactWith(block, hit) {
    const g = this.game;
    switch (block.interactable) {
      case 'crafting': g.openContainer('crafting'); break;
      case 'smithing': g.openContainer('smithing', hit.x, hit.y, hit.z); break;   // 10-NETHER §9.3
      case 'brewing': g.openContainer('brewing', hit.x, hit.y, hit.z); break;     // 09-POTIONS §10.4
      case 'furnace': g.openContainer('furnace', hit.x, hit.y, hit.z); break;
      // AMENDS 03 §16.1 — 08 §2 grows step 2's interactable set by these three.
      // All need their position: the table reads shelf power around it (§4.1),
      // and the anvil writes its degrade stage back to its own cell (§8.1).
      case 'enchanting': g.openContainer('enchanting', hit.x, hit.y, hit.z); break;
      case 'anvil': g.openContainer('anvil', hit.x, hit.y, hit.z); break;
      case 'grindstone': g.openContainer('grindstone', hit.x, hit.y, hit.z); break;
      case 'chest': {
        // blocked when an opaque block sits above (06 §5.3)
        if (!BLOCKS[this.world.getBlock(hit.x, hit.y + 1, hit.z)].opaque) {
          g.openContainer('chest', hit.x, hit.y, hit.z);
          emitSound('block.chest.open', at(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5));
        }
        break;
      }
      case 'bed': g.trySleep(hit.x, hit.y, hit.z); break;
      case 'door': this.toggleDoor(hit.x, hit.y, hit.z); break;
      // 12-VILLAGES §7.2 — ringing the bell; §7.4 barrel is a 27-slot chest.
      case 'bell': emitSound('block.bell.use', at(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5)); this.swing(); break;
      case 'barrel':
        g.openContainer('chest', hit.x, hit.y, hit.z);
        emitSound('block.barrel.open', at(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5));
        break;
      // 11-END §9.4 — a shulker box opens its own 27-slot screen (no opaque-above
      // check — vanilla approximation) and plays the chest-open sound.
      case 'shulker':
        g.openContainer('shulker_box', hit.x, hit.y, hit.z);
        emitSound('block.chest.open', at(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5));
        break;
      // 12-VILLAGES §7.3 — the composter is a fill-in-place block, not a screen.
      case 'composter': this.useComposter(hit); break;
      // §7.5 — the lectern genuinely has no UI ("RMB does nothing"; written books
      // are §OUT). It stays a deliberate no-op.
      case 'lectern': break;
      // 07 §6-§12 — lever/button/repeater/comparator/note block: right-click is
      // the block's onUse (installed by redstone/components.js).
      case 'redstone': {
        const st = this.world.getState(hit.x, hit.y, hit.z);
        block.onUse?.(this.world, hit.x, hit.y, hit.z, st, this.player, hit);
        break;
      }
      // 07 §10-§11 — dispenser/dropper (3×3) and hopper (1×5) open a UI screen.
      case 'container': {
        const kind = block.id === B.HOPPER ? 'hopper' : block.id === B.DROPPER ? 'dropper' : 'dispenser';
        g.openContainer(kind, hit.x, hit.y, hit.z);
        break;
      }
      // 13-BOSSES §4 — RMB the dragon egg teleports it (installed onUse).
      case 'dragon_egg': block.onUse?.(this.world, hit.x, hit.y, hit.z); this.swing(); break;
      // 13-BOSSES §9.4 — an ACTIVE beacon opens its power screen. §9.2's heading
      // is "every 80 ticks + ON GUI OPEN": Game.tickBeacon only ever runs the
      // %80 pass, so a freshly placed beacon (onPlaced makes an empty block
      // entity) refused to open at all for up to 4 s, and finishing a pyramid
      // tier showed the stale tier — and with it the wrong enabled powers.
      case 'beacon': {
        const be = g.getBlockEntity(hit.x, hit.y, hit.z);
        if (!be?.data) break;
        const s = beaconActive(this.world, hit.x, hit.y, hit.z);
        const prev = be.data.active;
        be.data.levels = s.levels;
        be.data.active = s.active;
        // §9.3's transition would otherwise be SWALLOWED: Game.tickBeacon only
        // fires the verb when it observes the change itself, and we just wrote
        // the new value. Guarded on a boolean prior so a fresh (field-less)
        // block entity does not announce a deactivation it never had.
        if (typeof prev === 'boolean' && s.active !== prev) {
          emitSound(s.active ? 'block.beacon.activate' : 'block.beacon.deactivate',
            at(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5));
        }
        if (s.active) g.openContainer('beacon', hit.x, hit.y, hit.z);
        break;
      }
    }
  }

  /**
   * 12-VILLAGES §7.3 — the composter. State nibble = fill level 0–8. RMB with a
   * compostable item rolls its chance (§7.3's four-row table) and adds a layer;
   * a success at level 7 sets 8 = READY. RMB a ready composter with anything (or
   * an empty hand) dispenses 1 bone_meal and resets to 0. Villagers deliberately
   * never operate it (§7.3), so this is the block's only driver.
   */
  useComposter(hit) {
    const p = this.player, w = this.world;
    const { x, y, z } = hit;
    const st = w.getState(x, y, z);
    const lvl = st & STATE_NIBBLE;
    const keep = st & ~STATE_NIBBLE;          // bit7 stays waterlogging everywhere
    if (lvl >= 8) {
      w.setState(x, y, z, keep);
      this.game.spawnItemByName('bone_meal', 1, x + 0.5, y + 1, z + 0.5);
      emitSound('block.composter.ready', at(x + 0.5, y + 0.5, z + 0.5));
      this.swing();
      return;
    }
    const held = p.heldItem();
    const chance = held ? compostChance(held.id) : 0;
    if (chance === 0) return;                 // empty hand / non-compostable: no-op
    // 18 §5.3 — consumeHeld is the single choke point and no-ops in creative, so
    // a creative fill costs nothing while the world-side layer still lands (the
    // same all-or-nothing shape as fillBucketStack's scoop).
    p.consumeHeld(1);
    this.swing();
    // The world's seeded stream, not Math.random: this is gameplay, not cosmetic.
    if (w.rng() >= chance) return;            // failed roll: item spent, no layer
    const next = lvl + 1;
    w.setState(x, y, z, keep | next);
    // §12.3 — `block.composter.ready` covers "reached level 8" as well as the
    // harvest; every lower layer is `block.composter.fill`.
    emitSound(next >= 8 ? 'block.composter.ready' : 'block.composter.fill',
      at(x + 0.5, y + 0.5, z + 0.5));
  }

  toggleDoor(x, y, z) {
    const w = this.world;
    const state = w.getState(x, y, z);
    const lowerY = (state & 1) ? y - 1 : y;
    const ls = w.getState(x, lowerY, z);
    const us = w.getState(x, lowerY + 1, z);
    const nowOpen = ((ls ^ 2) & 2) !== 0;      // read before ls goes stale
    w.setBlock(x, lowerY, z, B.OAK_DOOR, { state: ls ^ 2, byPlayer: true });
    if (w.getBlock(x, lowerY + 1, z) === B.OAK_DOOR) {
      w.setBlock(x, lowerY + 1, z, B.OAK_DOOR, { state: us ^ 2, byPlayer: true });
    }
    emitSound(nowOpen ? 'block.door.open' : 'block.door.close',
      at(x + 0.5, lowerY + 0.5, z + 0.5));
    this.swing();
  }

  // player horizontal facing index (0=+Z,1=−X,2=−Z,3=+X)
  playerFacing() {
    const f = { x: -Math.sin(this.player.yaw), z: -Math.cos(this.player.yaw) };
    let best = 0, bestDot = -2;
    for (let i = 0; i < 4; i++) {
      const dot = FACING_DIR[i][0] * f.x + FACING_DIR[i][2] * f.z;
      if (dot > bestDot) { bestDot = dot; best = i; }
    }
    return best;
  }

  placePosFor(hit) {
    if (REPLACEABLE_TARGET(hit.id)) return { x: hit.x, y: hit.y, z: hit.z, replaced: true };
    return { x: hit.x + hit.face[0], y: hit.y + hit.face[1], z: hit.z + hit.face[2], replaced: false };
  }

  entityBlocksPlacement(x, y, z) {
    const box = new AABB(x, y, z, x + 1, y + 1, z + 1);
    const hits = this.world.getEntitiesInBox(box, e => e instanceof LivingEntity && !e.dead);
    return hits.length > 0;
  }

  // `hand` (08 §7.3): the offhand reruns step 3, so the block must come out of
  // the hand that placed it — not always the main one.
  /**
   * 07 §6-§11 — the state byte for a redstone block on placement. Returns -1 to
   * reject the placement (e.g. a redstone torch has no ceiling variant).
   */
  redstonePlaceState(blockId, hit) {
    // ATTACH from the clicked face: the support is opposite the face normal.
    // face → ATTACH: [0,1,0]→0 floor, [0,0,1]→1, [1,0,0]→2, [0,0,-1]→3, [-1,0,0]→4, [0,-1,0]→5 ceiling.
    // ATTACH = the enum whose ATTACH_DIR equals −faceNormal (the support is on
    // the far side of the clicked face). The two X faces were swapped: clicking
    // +X puts support at −X (ATTACH 4 west), clicking −X puts it at +X (ATTACH 2).
    const attachFromFace = f => (
      f[1] === 1 ? 0 : f[2] === 1 ? 1 : f[0] === 1 ? 4 : f[2] === -1 ? 3 : f[0] === -1 ? 2 : 5);
    // FACE6 of the player's dominant look axis.
    const d = this.lookDir();
    const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
    let look6;
    if (ay >= ax && ay >= az) look6 = d.y > 0 ? 1 : 0;
    else if (ax >= az) look6 = d.x > 0 ? 5 : 4;
    else look6 = d.z > 0 ? 3 : 2;
    const opp6 = [1, 0, 3, 2, 5, 4][look6];
    const FACING_TO_HFACE = [2, 3, 0, 1];             // FACING enum → HFACE (output = look dir)

    switch (blockId) {
      case B.REDSTONE_WIRE:
      case B.STONE_PRESSURE_PLATE:
      case B.WOODEN_PRESSURE_PLATE:
      case B.REDSTONE_LAMP:
      case B.NOTE_BLOCK:
      case B.REDSTONE_BLOCK:
        return 0;
      case B.REDSTONE_TORCH: {
        const a = attachFromFace(hit.face);
        return a === 5 ? -1 : (a | 0x08);             // no ceiling; placed lit
      }
      case B.LEVER:
      case B.STONE_BUTTON:
      case B.WOODEN_BUTTON:
        return attachFromFace(hit.face);              // ATTACH 0-5, off/unpressed
      case B.REPEATER:
      case B.COMPARATOR:
        return FACING_TO_HFACE[this.playerFacing()];  // output faces away from player
      case B.PISTON:
      case B.STICKY_PISTON:
      case B.DISPENSER:
      case B.DROPPER:
        return opp6;                                  // front faces the player (like furnace, 6-dir)
      case B.OBSERVER:
        return look6;                                 // face (eye) watches where you look
      case B.HOPPER: {
        // §11.1 — output points INTO the clicked block (= −face as FACE6); down
        // when placed on a top face; never up.
        const f = hit.face;
        const face6 = f[1] === 1 ? 0 : f[1] === -1 ? 1 : f[2] === 1 ? 2 : f[2] === -1 ? 3 : f[0] === 1 ? 4 : 5;
        return face6 === 1 ? 0 : face6;               // up → down
      }
      default:
        return 0;
    }
  }

  // 11-END §3/§5.2 — eye of ender RMB: fill a targeted empty frame (any dim), else
  // launch a navigation eye (overworld only; no-op elsewhere, item kept).
  useEyeOfEnder(hand, hit) {
    const p = this.player, w = this.world, g = this.game;
    if (hit && w.getBlock(hit.x, hit.y, hit.z) === B.END_PORTAL_FRAME) {
      const st = w.getState(hit.x, hit.y, hit.z);
      if (!(st & 4)) {   // §5.2 — fill only an empty frame (eye bit 2)
        w.setBlock(hit.x, hit.y, hit.z, B.END_PORTAL_FRAME, { state: st | 4, byPlayer: true });
        if (!p.creative) p.consumeIn(hand, 1);
        emitSound('block.portal.fill', at(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5));
        this.swing();
        this.checkEndPortalActivation(hit.x, hit.y, hit.z);   // §5.3
      }
      return true;
    }
    if (w.activeDim !== 0) return true;   // §3 — overworld only
    const eye = this.eyePos(), look = this.lookDir();
    g.entities.add(new EyeOfEnder(w, eye.x + look.x * 0.5, eye.y + look.y * 0.5, eye.z + look.z * 0.5, p));
    emitSound('eye_of_ender.launch', at(eye.x, eye.y, eye.z));
    if (!p.creative) p.consumeIn(hand, 1);
    this.swing();
    return true;
  }

  // 13-BOSSES §3.4 — place an end crystal on the top face of obsidian/bedrock, with
  // 2 air above and no entity in the 2x2x2 target; used for PvE + the respawn ritual.
  useEndCrystal(hand, hit) {
    const p = this.player, w = this.world, g = this.game;
    if (!hit || hit.face[1] !== 1) return true;                 // top face only
    const base = w.getBlock(hit.x, hit.y, hit.z);
    if (base !== B.OBSIDIAN && base !== B.BEDROCK) return true;
    const cx = hit.x, cy = hit.y + 1, cz = hit.z;
    const clear = id => id === B.AIR || BLOCKS[id]?.replaceable;
    if (!clear(w.getBlock(cx, cy, cz)) || !clear(w.getBlock(cx, cy + 1, cz))) return true;
    const box = new AABB(cx - 0.5, cy, cz - 0.5, cx + 1.5, cy + 2, cz + 1.5);
    if (g.entities.getEntitiesInBox(box, e => !e.dead && e !== p && e.type !== 'end_crystal').length) return true;
    g.entities.add(new EndCrystal(w, cx, cy, cz, { hasBase: false, playerPlaced: true }));
    if (!p.creative) p.consumeIn(hand, 1);
    this.swing();
    g.endFight?.checkRitual?.(w.seedString);   // §7.11 — may start the respawn ritual
    return true;
  }

  // §5.3 — on every eye insertion, scan candidate 3×3 interior centers for a
  // completed 12-frame ring (5×5 minus corners, all eyes seated); fill the 9
  // interior cells with end_portal and fire the global activation sound.
  checkEndPortalActivation(fx, fy, fz) {
    const w = this.world;
    const filled = (x, z) => w.getBlock(x, fy, z) === B.END_PORTAL_FRAME && (w.getState(x, fy, z) & 4);
    for (let cx = fx - 2; cx <= fx + 2; cx++) {
      for (let cz = fz - 2; cz <= fz + 2; cz++) {
        let ok = true;
        for (let i = -2; i <= 2 && ok; i++)
          for (let j = -2; j <= 2 && ok; j++)
            if ((Math.abs(i) === 2) !== (Math.abs(j) === 2)) {   // the 12 ring cells (XOR)
              if (!filled(cx + i, cz + j)) ok = false;
            }
        if (!ok) continue;
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++)   // §5.3 — 9 interior cells
          w.setBlock(cx + i, fy, cz + j, B.END_PORTAL, { byPlayer: true });
        emitSound('block.portal.activate', null);   // §16 — global, distance-independent
        return true;
      }
    }
    return false;
  }

  tryPlace(held, hit, hand = 'main') {
    const p = this.player;
    const w = this.world;
    const blockId = held.place;
    const block = BLOCKS[blockId];
    const pos = this.placePosFor(hit);
    const { x, y, z } = pos;
    if (hit.t > this.reach()) return false;
    if (y < 0 || y > 127) return false;
    const targetId = w.getBlock(x, y, z);
    if (!BLOCKS[targetId].replaceable) return false;
    if (block.collidable && this.entityBlocksPlacement(x, y, z)) return false;

    // per-block state on placement
    let state = 0;
    if (blockId === B.TORCH) {
      if (hit.face[1] === 1) state = 0;
      else if (hit.face[1] === -1) return false;   // no ceiling torches
      else if (!pos.replaced) {
        state = hit.face[2] === 1 ? 1 : hit.face[2] === -1 ? 2 : hit.face[0] === 1 ? 3 : 4;
      }
    } else if (blockId === B.LADDER) {
      if (hit.face[1] !== 0 || pos.replaced) return false;
      state = hit.face[2] === 1 ? 1 : hit.face[2] === -1 ? 2 : hit.face[0] === 1 ? 3 : 4;
    } else if (blockId === B.FURNACE || blockId === B.CHEST || blockId === B.ANVIL ||
               blockId === B.BLAST_FURNACE || blockId === B.SMOKER) {
      // 12-VILLAGES §7.6/§7.7 — both are furnace variants and share 06 §5.5's
      // "state bits 0–1: facing (set on place, faces the player)". Without them
      // here every player-placed unit kept state 0, so furnaceTiles put the maw
      // on +Z regardless of where the player stood. The _LIT ids are in
      // NO_BLOCK_ITEM and never place from an item, so they need no branch.
      // front toward the player. 08 §2.2: the anvil's bits0–1 facing is visual
      // only; its bits2–3 damage stage starts at 0 on a fresh place ("stage
      // resets on re-place").
      state = (this.playerFacing() + 2) % 4;
    } else if (BLOCKS[blockId].tilesFor && (blockId === B.PUMPKIN || blockId === B.JACK_O_LANTERN)) {
      state = (this.playerFacing() + 2) % 4;
    } else if (blockId >= B.REDSTONE_WIRE && blockId <= B.REDSTONE_BLOCK) {
      const rs = this.redstonePlaceState(blockId, hit);
      if (rs < 0) return false;                       // e.g. a torch on a ceiling
      state = rs;
      // 07-REDSTONE §4.1/§6/§7 — every needsSupport component sits on a
      // conductive block or glass (vanilla's transparent-support subset, approx).
      // Exactly the predicate components.js checkSupport uses, so placement and
      // the pop rule can never disagree — and run AFTER `rs`, so an ATTACH
      // component tests its real attach direction rather than the cell below.
      // Nothing else pops these: World.neighborUpdates notifies only the SIX
      // NEIGHBOURS of the changed cell, never the cell itself, so a lever stuck
      // on leaves stayed there forever. Only ids 70–78 declare needsSupport in
      // this range — pistons/observer/dispenser/dropper/hopper/lamp/note block
      // and the redstone block are untouched.
      const sup = block.needsSupport;
      if (sup) {
        // `rs & 7` is the ATTACH nibble (power.js attachOf); the torch's lit bit
        // is 0x08 and is masked off here.
        const [sx, sy, sz] = sup === 'attach' ? supportCell(rs & 7, x, y, z) : [x, y - 1, z];
        const sid = w.getBlock(sx, sy, sz);
        if (!BLOCKS[sid]?.conductive && sid !== B.GLASS) return false;
      }
    } else if (blockId === B.END_ROD) {
      // 11-END §2.2 — "bits0–2 facing (0 up, 1 down, 2–5 N/E/S/W wall); placeable
      // on any solid face (floor, ceiling AND walls — unlike torch)". The rod
      // points AWAY from the clicked face, i.e. along the face normal, matching
      // blocks.js's ROD_SUPPORT, which indexes the support cell OPPOSITE the
      // facing: 2 = N(-Z), 3 = E(+X), 4 = S(+Z), 5 = W(-X). Without this every
      // rod placed as state 0 and stood upright.
      const f = hit.face;
      state = f[1] === 1 ? 0 : f[1] === -1 ? 1
        : f[2] === -1 ? 2 : f[0] === 1 ? 3
        : f[2] === 1 ? 4 : 5;
    } else if (block.shape === 'stairs') {
      // 10-NETHER §1.1 — ChunkMesher.emitStairs reads bits0–1 facing + bit2 half
      // and nothing ever wrote them, so an ascending staircase was unbuildable.
      // The raised half sits on FACING_DIR[facing], and it must be AWAY from the
      // player so you step UP walking forward — hence playerFacing() unmodified
      // (NOT the +2 the furnace/chest branch uses, which points a FRONT at you).
      // Top half on a bottom-face click or an upper-half side hit, as vanilla.
      // `py` is the world-space impact point (raycast.js); 14 §4.5's host-apply
      // path synthesises a hit without it, and NaN > 0.5 is false, so a remote
      // side-face place lands bottom-half — the safe default, not a crash.
      const topHalf = hit.face[1] === -1 ||
        (hit.face[1] === 0 && (hit.py - hit.y) > 0.5);
      state = this.playerFacing() | (topHalf ? 4 : 0);
    }

    if (block.canPlaceAt && !block.canPlaceAt(w, x, y, z, state)) return false;

    // AMENDS 03 §16.2 / 15 §10.1-10.2 — placing a waterloggable block into a
    // water SOURCE sets bit 7 and preserves the water; into FLOWING water the
    // block goes in dry and the water is simply overwritten (only sources
    // waterlog, vanilla). OR into the same `state` the per-block chain built, so
    // one setBlock does the whole job and the light/neighbor pipeline runs once.
    if (block.waterloggable && targetId === B.WATER &&
        (w.getState(x, y, z) & STATE_NIBBLE) === 0) {
      state |= WATERLOGGED;
    }

    w.setBlock(x, y, z, blockId, { state, byPlayer: true });
    // 11-END §9.4 — restore a placed shulker box's retained contents.
    if (blockId === B.SHULKER_BOX) {
      const ci = p.stackIn(hand)?.tags?.containerItems;
      if (ci) {
        const be = this.game.getBlockEntity(x, y, z);
        if (be?.data) be.data.slots = unpackContainer(ci, 27);
      }
    }
    // Reaching here IS the success path — six guards above return false first.
    this.emitPlace(blockId, x, y, z);
    // No creative guard here: gameMode is the GameMode int enum now, so the old
    // `!== 'debugCreative'` string test was always true and did nothing.
    // consumeIn is 18 §5.3's single choke point and no-ops in creative itself.
    p.consumeIn(hand, 1);
    this.swing();
    return true;
  }

  // §3.2 place verb; shared by tryPlace and tryPlaceSpecial (door/bed).
  emitPlace(blockId, x, y, z) {
    const cls = matOf(blockId);
    if (cls) emitSound(`block.place.${cls}`, at(x + 0.5, y + 0.5, z + 0.5));
  }

  tryPlaceSpecial(held, hit, hand = 'main') {
    const p = this.player;
    const w = this.world;
    const pos = this.placePosFor(hit);
    const { x, y, z } = pos;
    if (y < 0 || y > 126) return false;
    if (!BLOCKS[w.getBlock(x, y, z)].replaceable) return false;

    if (held.placesAs === 'door') {
      if (!BLOCKS[w.getBlock(x, y + 1, z)].replaceable) return false;
      if (!isSolidSupport(w.getBlock(x, y - 1, z))) return false;
      if (this.entityBlocksPlacement(x, y, z)) return false;
      const f = this.playerFacing();
      w.setBlock(x, y, z, B.OAK_DOOR, { state: f << 2, byPlayer: true });
      w.setBlock(x, y + 1, z, B.OAK_DOOR, { state: (f << 2) | 1, byPlayer: true });
      this.emitPlace(B.OAK_DOOR, x, y, z);       // one door = two setBlocks, one sound
      p.consumeIn(hand, 1);
      this.swing();
      return true;
    }
    if (held.placesAs === 'bed') {
      const f = this.playerFacing();
      const hx = x + FACING_DIR[f][0], hz = z + FACING_DIR[f][2];
      if (!BLOCKS[w.getBlock(hx, y, hz)].replaceable) return false;
      if (!isSolidSupport(w.getBlock(x, y - 1, z)) || !isSolidSupport(w.getBlock(hx, y - 1, hz))) return false;
      // 03 §16.2 — "not aabbOf(placePos).intersects(player.AABB or any mob AABB)".
      // bed_block is collidable, and BOTH halves are placement cells, so both are
      // tested: looking straight down and right-clicking otherwise wrote a bed
      // through the player's own feet. (The door branch's single test above
      // already covers a standing player/mob.)
      if (this.entityBlocksPlacement(x, y, z) || this.entityBlocksPlacement(hx, y, hz)) return false;
      w.setBlock(x, y, z, B.BED_BLOCK, { state: f, byPlayer: true });
      w.setBlock(hx, y, hz, B.BED_BLOCK, { state: f | 4, byPlayer: true });
      this.emitPlace(B.BED_BLOCK, x, y, z);
      p.consumeIn(hand, 1);
      this.swing();
      return true;
    }
    return false;
  }

  // §7.3 step 2 helpers return whether the use actually PERFORMED. False means
  // "this item had no block-targeted action here" and the pipeline continues to
  // steps 3–4 — that is what makes a carrot plant on farmland but feed the
  // player anywhere else (Java's useOn → PASS → use()).
  plantSeed(held, hit) {
    const w = this.world;
    if (hit.face[1] !== 1) return false;
    const y = hit.y + 1;
    if (w.getBlock(hit.x, y, hit.z) !== B.AIR) return false;
    // 10-NETHER §8.1 — item 390 nether_wart routes here too, and its substrate is
    // soul_sand, not farmland. Ask the CROP for its own substrate rule instead of
    // hard-coding one: cropDef's canPlaceAt is exactly the old FARMLAND test, and
    // block 138's is `below === SOUL_SAND`. Hard-coding farmland made wart
    // unplantable (and, worse, plantable on farmland, where 138's neighborUpdate
    // popped it the same tick).
    const crop = BLOCKS[held.plantsCrop];
    if (crop.canPlaceAt && !crop.canPlaceAt(w, hit.x, y, hit.z, 0)) return false;
    w.setBlock(hit.x, y, hit.z, held.plantsCrop, { state: 0, byPlayer: true });
    this.emitPlace(held.plantsCrop, hit.x, y, hit.z);
    this.player.consumeHeld(1);
    this.swing();
    return true;
  }

  useHoe(hit) {
    const w = this.world;
    const id = w.getBlock(hit.x, hit.y, hit.z);
    if ((id === B.GRASS_BLOCK || id === B.DIRT) &&
        w.getBlock(hit.x, hit.y + 1, hit.z) === B.AIR) {
      w.setBlock(hit.x, hit.y, hit.z, B.FARMLAND, { byPlayer: true });
      this.player.damageHeld(1);
      this.swing();
      return true;
    }
    return false;
  }

  // 12-VILLAGES §7.1 — a shovel turns grass/dirt into a dirt_path (air above,
  // not the bottom face). The path has no block-item; it reverts to dirt under a
  // placed block via its neighborUpdate.
  useDirtPath(hit) {
    const w = this.world;
    const id = w.getBlock(hit.x, hit.y, hit.z);
    if ((id === B.GRASS_BLOCK || id === B.DIRT) &&
        w.getBlock(hit.x, hit.y + 1, hit.z) === B.AIR && hit.face[1] !== -1) {
      w.setBlock(hit.x, hit.y, hit.z, B.DIRT_PATH, { byPlayer: true });
      this.player.damageHeld(1);
      this.swing();
      return true;
    }
    return false;
  }

  /**
   * 06 §5.11/5.12/5.15 fertilize, on BARE CELL COORDINATES and with no held-item
   * side effects. Split out of useBoneMeal so 07-REDSTONE §11's dispenser table
   * row ("bone_meal → apply fertilize to the front block") has an entry point:
   * containersRedstone called game.tryBonemeal(fx, fy, fz), which existed
   * nowhere, so a dispenser always default-dropped the bone meal instead.
   * Returns true iff the target was fertilizable.
   */
  applyBoneMealAt(bx, by, bz) {
    const w = this.world;
    const id = w.getBlock(bx, by, bz);
    const blk = BLOCKS[id];
    const rng = w.rng;
    if (id >= B.WHEAT_CROP && id <= B.POTATO_CROP) {
      const st = w.getState(bx, by, bz);
      const stage = Math.min(7, (st & 7) + 2 + Math.floor(rng() * 4));
      w.setState(bx, by, bz, (st & 8) | stage);
      return true;
    }
    if (blk.species && blk.shape === 'cross') {                  // sapling
      if (rng() < 0.45) w.growTree(blk.species, bx, by, bz);
      return true;
    }
    if (id === B.GRASS_BLOCK) {
      for (let i = 0; i < 8; i++) {
        const dx = Math.floor(rng() * 7) - 3, dz = Math.floor(rng() * 7) - 3;
        const x = bx + dx, z = bz + dz;
        if (w.getBlock(x, by, z) === B.GRASS_BLOCK && w.getBlock(x, by + 1, z) === B.AIR) {
          const plant = rng() < 0.9 ? B.SHORT_GRASS : (rng() < 0.5 ? B.DANDELION : B.POPPY);
          w.setBlock(x, by + 1, z, plant, { byPlayer: true });
        }
      }
      return true;
    }
    return false;
  }

  useBoneMeal(hit) {
    const used = this.applyBoneMealAt(hit.x, hit.y, hit.z);
    if (used) {
      this.player.consumeHeld(1);
      this.swing();
    }
    return used;
  }

  useFlintSteel(hit) {
    const w = this.world;
    // 10-NETHER §3.2 — RMB on obsidian may ignite a Nether portal frame.
    if (w.getBlock(hit.x, hit.y, hit.z) === B.OBSIDIAN && tryIgnitePortal(this.game, hit)) {
      emitSound('item.flintandsteel.use', at(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5));
      this.player.damageHeld(1);
      this.swing();
      return true;
    }
    if (w.getBlock(hit.x, hit.y, hit.z) === B.TNT) {
      w.setBlock(hit.x, hit.y, hit.z, B.AIR, { byPlayer: true });
      // Only the snick belongs here — world.tnt.fuse is started inside
      // Game.igniteTnt, which every prime path funnels through.
      emitSound('item.flintandsteel.use', at(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5));
      w.igniteTnt(hit.x, hit.y, hit.z, 80);
      this.player.damageHeld(1);
      this.swing();
      return true;
    }
    // 15 §4.1 — t = hit.pos + faceNormal; place if air && canSurvive(t). ANY
    // face, not just the top: canSurvive is solidTopBelow OR anyFlammableNeighbor,
    // so a wooden wall lights from the side (the old face[1]===1 +
    // isSolidSupport pair forbade exactly that). igniteAt registers the §6
    // ignition origin. On failure nothing is consumed and no sound plays.
    const x = hit.x + hit.face[0], y = hit.y + hit.face[1], z = hit.z + hit.face[2];
    if (igniteAt(w, x, y, z)) {
      emitSound('item.flintandsteel.use', at(x + 0.5, y + 0.5, z + 0.5));
      this.player.damageHeld(1);
      this.swing();
      return true;
    }
    return false;
  }

  useBucketEmpty() {
    // 15 §13.1 rule 2 — a waterlogged cell is scooped off the BLOCK hit, not the
    // fluidMode ray (the contained water is never independently targetable).
    // Rule 1 (interactable && !sneaking -> open UI) is already enforced upstream
    // in use(), which is exactly why scooping a waterlogged chest needs sneak.
    const bh = this.currentHit;
    if (bh && (this.world.getState(bh.x, bh.y, bh.z) & WATERLOGGED)) {
      this.world.setWaterlogged(bh.x, bh.y, bh.z, false);
      emitSound('item.bucket.fill', at(bh.x + 0.5, bh.y + 0.5, bh.z + 0.5));
      this.world.fluids.wakeNeighbors(bh.x, bh.y, bh.z);   // downstream drains re-derive
      this.fillBucketStack(idOf('water_bucket'));
      this.swing();
      return true;
    }
    // rule 3 — base fluidMode source scan (06 §6.4)
    const hit = this.rayHit(this.reach(), { fluidMode: true });
    if (!hit) return false;
    const blk = BLOCKS[hit.id];
    if (blk.shape !== 'liquid') return false;
    const filled = idOf(blk.fluid === 'water' ? 'water_bucket' : 'lava_bucket');
    this.world.setBlock(hit.x, hit.y, hit.z, B.AIR, { byPlayer: true });
    emitSound(blk.fluid === 'lava' ? 'item.bucket.fill.lava' : 'item.bucket.fill',
      at(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5));
    this.fillBucketStack(filled);
    this.swing();
    return true;
  }

  /** Bucket -> filled bucket, honoring the bucket's stack size (16). */
  fillBucketStack(filledId) {
    const p = this.player;
    // 18 §5.3 — the source stack is untouched in creative. The fluid is still
    // scooped from the world (that setBlock already ran); the empty bucket just
    // does not become a filled one. Diverges from MC, where a creative scoop
    // does hand you the filled bucket — logged in DEVIATIONS.md.
    if (p.creative) return;
    if (p.heldStack.count === 1) {
      p.heldStack = { id: filledId, count: 1 };
    } else {
      p.consumeHeld(1);
      const leftover = p.give({ id: filledId, count: 1 });
      if (leftover > 0) this.game.dropStackAt({ id: filledId, count: 1 }, p.pos.x, p.pos.y + 1, p.pos.z);
    }
  }

  useBucketFilled(held) {
    const hit = this.currentHit;
    if (!hit) return false;
    const w = this.world;
    // 10-NETHER §10.1 — water evaporates: in an evaporatesWater dimension a
    // water bucket places nothing, empties to a bucket, and poofs. (Lava is fine.)
    if (held.name === 'water_bucket' && getDimension(w.activeDim)?.evaporatesWater) {
      if (!this.player.creative) this.player.heldStack = { id: idOf('bucket'), count: 1 };
      const c = hit;
      emitSound('block.extinguish', at(c.x + 0.5, c.y + 0.5, c.z + 0.5));
      this.game.particles?.smoke?.(c.x + 0.5, c.y + 1, c.z + 0.5);
      this.swing();
      return true;
    }
    // 15 §13.1 rule 2 / §10.4 — water bucket on a targeted DRY waterloggable
    // block sets bit 7 instead of placing a source beside it.
    // Gated on water_bucket: this same method serves lava_bucket, which must
    // never waterlog.
    if (held.name === 'water_bucket' && BLOCKS[hit.id].waterloggable &&
        (w.getState(hit.x, hit.y, hit.z) & WATERLOGGED) === 0) {
      w.setWaterlogged(hit.x, hit.y, hit.z, true);
      emitSound('item.bucket.pour', at(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5));
      // §10.4: schedule cell + 6 neighbors, then run the §11.3 lava check
      w.fluids.schedule(hit.x, hit.y, hit.z, 'water');
      w.fluids.wakeNeighbors(hit.x, hit.y, hit.z);
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        w.fluids.checkInteractions(hit.x + dx, hit.y + dy, hit.z + dz);
      }
      if (!this.player.creative) this.player.heldStack = { id: idOf('bucket'), count: 1 };   // 18 §5.3
      this.swing();
      return true;
    }
    const pos = this.placePosFor(hit);
    const targetId = w.getBlock(pos.x, pos.y, pos.z);
    if (!BLOCKS[targetId].replaceable) return false;
    const fluidId = held.name === 'water_bucket' ? B.WATER : B.LAVA;
    w.setBlock(pos.x, pos.y, pos.z, fluidId, { state: 0, byPlayer: true });
    // before checkInteractions, which may itself fire block.extinguish (01 §6.3)
    emitSound('item.bucket.pour', at(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5));
    w.fluids.checkInteractions(pos.x, pos.y, pos.z);
    if (!this.player.creative) this.player.heldStack = { id: idOf('bucket'), count: 1 };   // 18 §5.3
    this.swing();
    return true;
  }

  // §7.3 step 4 — self-use, so it runs for either hand.
  throwHeld(held, hand = 'main') {
    const p = this.player;
    if (held.name === 'ender_pearl') {
      if (this.pearlCooldown > 0) return false;
      this.pearlCooldown = 20;
    }
    const e = this.eyePos(), d = this.lookDir();
    const speed = 1.5;
    this.game.spawnThrown(held.name, e.x, e.y - 0.1, e.z,
      d.x * speed, d.y * speed, d.z * speed, p);
    p.consumeIn(hand, 1);
    this.swing();
    return true;
  }

  // 09-POTIONS §11.2 — apply a drunk potion, then return an empty glass bottle.
  drinkPotion(stack, hand) {
    const p = this.player;
    const P = POTIONS[stack.tags?.potionId ?? 'water'];
    if (P && P.effect) {
      if (P.instant) applyInstant(p, P.effect, P.amp, 1.0, null);
      else addEffect(p, P.effect, P.amp, P.ticks);
    }
    // 18 §5.3 / DEVIATIONS "creative item transactions are all-or-nothing" —
    // cited by name, not by number: the rulings list is a single running
    // sequence and "ruling 5" already belongs to the jack o'lantern entry.
    // consumeIn no-ops in creative but give() did not, so a creative drink kept
    // the potion AND minted a glass bottle every 32-tick channel. The effect
    // still applies (that is the world-side result, like fillBucketStack's scoop).
    if (!p.creative) {
      p.consumeIn(hand, 1);
      const bottle = { id: idOf('glass_bottle'), count: 1 };
      if (p.give(bottle) > 0) this.game.throwStack(bottle);
    }
  }

  // §13.1/§14.1 — throw a splash/lingering potion (speed 0.5, arc raised 20°,
  // gaussian inaccuracy). The bottle is lost.
  throwPotion(held, hand) {
    const p = this.player;
    // The variant lives on the STACK (brewing.js writes tags.potionId there);
    // `held` is the immutable ITEMS registry definition, which has no `tags`
    // field at all — reading it off `held` pinned every throw to 'water', and
    // ThrownPotion.impact short-circuits water into a plain splash, so 100% of
    // splash/lingering potions were inert while still spending the bottle.
    // `kind` on line below IS a genuine registry field, so it stays on `held`.
    // Read before consumeIn below, which empties the stack.
    const potionId = p.stackIn(hand)?.tags?.potionId ?? 'water';
    const form = held.kind === 'lingering_potion' ? 'lingering' : 'splash';
    const e = this.eyePos();
    const pitch = p.pitch + 20 * Math.PI / 180;         // raise the throw 20°
    const cp = Math.cos(pitch);
    const dx = -Math.sin(p.yaw) * cp, dy = Math.sin(pitch), dz = -Math.cos(p.yaw) * cp;
    const spd = 0.5, g = 0.0172275, rng = this.world.rng;
    this.game.spawnPotion(potionId, form, e.x, e.y, e.z,
      dx * spd + gaussian(rng) * g, dy * spd + gaussian(rng) * g, dz * spd + gaussian(rng) * g, p);
    emitSound('entity.splash_potion.throw', null);
    p.consumeIn(hand, 1);
    this.swing();
  }

  // §11.1 — RMB an empty bottle at water → a water bottle (source not consumed).
  // 13-BOSSES §6.5 — RMB inside a dragon breath cloud → bottle the dragon_breath.
  fillBottle(hand) {
    const p = this.player;
    const e = this.eyePos();
    const box = new AABB(e.x - 8, e.y - 8, e.z - 8, e.x + 8, e.y + 8, e.z + 8);
    const cloud = this.game.entities.getEntitiesInBox(box,
      x => x.type === 'area_effect_cloud' && !x.dead && x.effectPayload?.damage)   // dragon-breath clouds carry {damage}
      .find(c => { const dx = e.x - c.pos.x, dz = e.z - c.pos.z; return dx * dx + dz * dz <= c.radius * c.radius && Math.abs(e.y - c.pos.y) <= 2; });
    if (cloud) {
      // 18 §5.3 — all-or-nothing in creative (see fillBucketStack). The world-side
      // effect below stays outside the guard, matching the DEVIATIONS entry
      // "creative item transactions are all-or-nothing": the fluid is still
      // scooped; the empty bucket just does not become full.
      if (!p.creative) {
        p.consumeIn(hand, 1);
        const breath = { id: idOf('dragon_breath'), count: 1 };
        if (p.give(breath) > 0) this.game.throwStack(breath);
      }
      cloud.radius = Math.max(0, cloud.radius - 0.5);
      emitSound('item.bottle.fill', null);
      this.swing();
      return;
    }
    const hit = this.rayHit(this.reach(), { fluidMode: true });
    if (!hit || this.world.getBlock(hit.x, hit.y, hit.z) !== B.WATER) return;
    // 18 §5.3 — as above. Unguarded, this minted a water bottle every 4 ticks
    // (fillBottle opens no use-channel, so RMB-held re-fires at 5 Hz) and, once
    // all 36 slots were full, spat a live ItemEntity into the world five times a
    // second for as long as the button was down.
    if (!p.creative) {
      p.consumeIn(hand, 1);
      const water = { id: idOf('potion'), count: 1, tags: { potionId: 'water' } };
      if (p.give(water) > 0) this.game.throwStack(water);
    }
    emitSound('item.bottle.fill', null);
    this.swing();
  }

  dropHeld(wholeStack) {
    const p = this.player;
    const s = p.heldStack;
    if (!s) return;
    const n = wholeStack ? s.count : 1;
    // cloneStack, not a hand-rolled copy: {id, count, damage} silently dropped
    // `tags`, so Q on an enchanted sword returned a plain one (08 §1 rule 4).
    const drop = cloneStack(s);
    drop.count = n;
    s.count -= n;
    if (s.count <= 0) p.heldStack = null;
    // 14 — on the client the throwStack is no-op'd (host spawns the item); the
    // inventory decrement is optimistic and playerState reconciles it.
    this.game.throwStack(drop);
    if (this.game.net?.isClient) this.game.net.sendDropItem(wholeStack);
  }
}

// Ray vs AABB slab test → entry t or null
export function rayAABB(origin, dir, box) {
  let tmin = 0, tmax = Infinity;
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < box.min[a] || o[a] > box.max[a]) return null;
    } else {
      let t1 = (box.min[a] - o[a]) / d[a];
      let t2 = (box.max[a] - o[a]) / d[a];
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}
