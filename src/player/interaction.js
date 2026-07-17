// Mining / placing / using / attacking (03 §14–17, 05 §13.3, 06 item uses).
import {
  BLOCKS, B, harvestOK, isSolidSupport, FACING_DIR, WALL_DIR, matOf,
  WATERLOGGED, STATE_NIBBLE,
} from '../registry/blocks.js';
import { igniteAt } from '../world/fire.js';
import { ITEMS, idOf } from '../registry/items.js';
import { raycastBlocks } from '../world/raycast.js';
import { LivingEntity } from '../entities/Entity.js';
import { emitSound, startLoop, at } from '../audio/engine.js';
import { AABB } from '../math/aabb.js';
import { KEYBINDS } from '../constants.js';
import { cloneStack, tagsEqual, getEnchantLvl } from '../items/tags.js';
import { ENCH } from '../items/enchants.js';
import {
  meleeEnchBonus, silkDrop, silkSuppressesXp, silkSuppressesOnBroken,
} from '../items/effects.js';

const REPLACEABLE_TARGET = id => BLOCKS[id]?.replaceable;

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
    this.prevMouseRight = false;
    this.pearlCooldown = 0;
    this.bowLoop = null;        // §3.3 item.bow.draw handle
  }

  stopBowLoop() {
    this.bowLoop?.stop(0.05);
    this.bowLoop = null;
  }

  get player() { return this.game.player; }
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

  swing() { this.swingTicks = 0; }

  tick(input) {
    const p = this.player;
    if (this.mineDelay > 0) this.mineDelay--;
    if (this.useDelay > 0) this.useDelay--;
    if (this.pearlCooldown > 0) this.pearlCooldown--;
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

    // attack on press (entity priority, 03 §14/§15.3)
    let attacked = false;
    if (input.leftPressed) {
      const target = this.pickEntityTarget();
      if (target) {
        this.attack(target);
        attacked = true;
        this.resetMining();
      }
    }

    // mining while held (skipped the tick an attack fired)
    if (input.mouseLeft && !attacked) this.updateMining();
    else this.resetMining();

    // use-item channel: eating / bow draw
    this.updateUseChannel(input);

    // RMB: on press and every 4 ticks while held (03 §16.1)
    if ((input.rightPressed || (input.mouseRight && this.useDelay === 0)) && !p.usingItem) {
      this.use(input);
    }
    this.prevMouseRight = input.mouseRight;

    // crack overlay stage
    const stage = this.targetPos && this.progress > 0
      ? Math.min(9, Math.floor(this.progress * 10)) : -1;
    if (stage !== this.crackStage ||
        (this.targetPos && this.crackPos !== undefined)) {
      this.crackStage = stage;
      this.game.updateCrack?.(this.targetPos, stage);
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
    // A lit furnace has no block-item of its own (06 §1) — pick the plain one.
    const id = hit.id === B.FURNACE_LIT ? B.FURNACE : hit.id;
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
   * 18 §5.4's Ctrl-modifier hook. Returns `undefined` today for every block:
   * the `tags` object schema is 08-ENCHANTING's to define and CLAUDE.md §8.2
   * freezes it BEFORE consumers build against it — so 18, which "only reads"
   * tags (§0), cannot invent the shape here. Wire the read when 08 lands.
   */
  pickTags(_hit) { return undefined; }

  // ---------------------------------------------------------- attacking

  pickEntityTarget() {
    const e = this.eyePos(), d = this.lookDir();
    const blockHit = this.currentHit;
    const maxT = Math.min(3.0, blockHit ? blockHit.t : 3.0);
    const box = new AABB(
      Math.min(e.x, e.x + d.x * 3) - 1, Math.min(e.y, e.y + d.y * 3) - 1, Math.min(e.z, e.z + d.z * 3) - 1,
      Math.max(e.x, e.x + d.x * 3) + 1, Math.max(e.y, e.y + d.y * 3) + 1, Math.max(e.z, e.z + d.z * 3) + 1);
    let best = null, bestT = maxT;
    for (const ent of this.world.getEntitiesInBox(box,
        x => x instanceof LivingEntity && x !== this.player && !x.dead)) {
      const t = rayAABB(e, d, ent.getAABB());
      if (t !== null && t < bestT) { bestT = t; best = ent; }
    }
    return best;
  }

  attack(target) {
    const p = this.player;
    const item = p.heldItem();
    const base = item?.attackDamage ?? 1;
    const speed = item?.attackSpeed ?? 4.0;
    const T = 20 / speed;
    const charge = Math.min(1, Math.max(0, (p.ticksSinceAttack + 0.5) / T));
    // AMENDS 05 §13.1: damage = base × (0.2+0.8p²) × (crit?1.5:1) + enchBonus×p.
    // The enchBonus term lands with the catalog in E4 (08 §5.4) and is added
    // AFTER the crit multiply — it scales linearly with p and is never crit-
    // multiplied (Java exact).
    let dmg = base * (0.2 + 0.8 * charge * charge);

    const crit = p.vel.y < 0 && !p.onGround && charge >= 0.848 &&
                 !p.sprinting && !p.inWater && !p.onLadder;
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
    const fireAspect = getEnchantLvl(p.heldStack, ENCH.FIRE_ASPECT);
    if (fireAspect > 0 && !target.dead) target.setOnFire(80 * fireAspect);

    if (crit) this.game.particles?.crit?.(target);
    if (sweeps) this.doSweep(victims, base, charge);
    if (item?.toolClass) p.damageHeld(item.toolClass === 'sword' ? 1 : 2);
    p.addExhaustion(0.1);
    p.ticksSinceAttack = 0;
    this.swing();
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
      }
      p.usingItem = null;
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

    // §5.9 Infinity: fire without consuming, but still require ≥ 1 arrow (search
    // order §7.4). "No arrow anywhere → cannot draw (unchanged)."
    if (infinite ? !this.hasAmmo('arrow') : !this.takeItem('arrow')) return;

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
      noPickup: infinite,
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

  hasItem(name) {
    const id = idOf(name);
    return this.player.inventory.some(s => s && s.id === id && s.count > 0);
  }

  // 08 §7.4 — ammo search order: offhand → main hand → inventory 0–35 ascending.
  findAmmo(name) {
    const id = idOf(name);
    const p = this.player;
    if (p.offhand && p.offhand.id === id && p.offhand.count > 0) return 'off';
    if (p.heldStack && p.heldStack.id === id && p.heldStack.count > 0) return 'main';
    for (let i = 0; i < 36; i++) {
      if (p.inventory[i] && p.inventory[i].id === id && p.inventory[i].count > 0) return i;
    }
    return null;
  }

  hasAmmo(name) { return this.findAmmo(name) !== null; }

  takeItem(name) {
    // 18 §5.3 — "using any item in creative leaves the source stack untouched".
    // The arrow must still be PRESENT (creative removes depletion, not the
    // requirement); only the decrement is skipped.
    const where = this.findAmmo(name);
    if (where === null) return false;
    if (this.player.creative) return true;
    const p = this.player;
    if (where === 'off' || where === 'main') {
      p.consumeIn(where, 1);
    } else {
      const s = p.inventory[where];
      s.count--;
      if (s.count <= 0) p.inventory[where] = null;
    }
    return true;
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
    // 2b: 12 §7.1's shovel → dirt_path inserts here.
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
      if (p.foodLevel < 20 && !p.usingItem) {
        p.usingItem = { kind: 'eat', ticks: 0, hand };
      }
      return true;
    }
    if (held.name === 'bow') {
      // §7.4: offhand → main → inventory. An arrow anywhere permits the draw.
      if (!p.usingItem && this.hasAmmo('arrow')) {
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
    }
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
    } else if (blockId === B.FURNACE || blockId === B.CHEST || blockId === B.ANVIL) {
      // front toward the player. 08 §2.2: the anvil's bits0–1 facing is visual
      // only; its bits2–3 damage stage starts at 0 on a fresh place ("stage
      // resets on re-place").
      state = (this.playerFacing() + 2) % 4;
    } else if (BLOCKS[blockId].tilesFor && (blockId === B.PUMPKIN || blockId === B.JACK_O_LANTERN)) {
      state = (this.playerFacing() + 2) % 4;
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
    if (w.getBlock(hit.x, hit.y, hit.z) !== B.FARMLAND) return false;
    const y = hit.y + 1;
    if (w.getBlock(hit.x, y, hit.z) !== B.AIR) return false;
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

  useBoneMeal(hit) {
    const w = this.world;
    const id = w.getBlock(hit.x, hit.y, hit.z);
    const blk = BLOCKS[id];
    const rng = w.rng;
    let used = false;
    if (id >= B.WHEAT_CROP && id <= B.POTATO_CROP) {
      const st = w.getState(hit.x, hit.y, hit.z);
      const stage = Math.min(7, (st & 7) + 2 + Math.floor(rng() * 4));
      w.setState(hit.x, hit.y, hit.z, (st & 8) | stage);
      used = true;
    } else if (blk.species && blk.shape === 'cross') {           // sapling
      if (rng() < 0.45) w.growTree(blk.species, hit.x, hit.y, hit.z);
      used = true;
    } else if (id === B.GRASS_BLOCK) {
      for (let i = 0; i < 8; i++) {
        const dx = Math.floor(rng() * 7) - 3, dz = Math.floor(rng() * 7) - 3;
        const x = hit.x + dx, z = hit.z + dz;
        if (w.getBlock(x, hit.y, z) === B.GRASS_BLOCK && w.getBlock(x, hit.y + 1, z) === B.AIR) {
          const plant = rng() < 0.9 ? B.SHORT_GRASS : (rng() < 0.5 ? B.DANDELION : B.POPPY);
          w.setBlock(x, hit.y + 1, z, plant, { byPlayer: true });
        }
      }
      used = true;
    }
    if (used) {
      this.player.consumeHeld(1);
      this.swing();
    }
    return used;
  }

  useFlintSteel(hit) {
    const w = this.world;
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
    this.game.throwStack(drop);
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
