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

  reach() { return this.player.gameMode === 'debugCreative' ? 5.2 : 4.5; }

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
      this.game.hud?.onHotbarChange?.();
    }
    if (input.hotbar >= 0) this.game.hud?.onHotbarChange?.();
    // §3.3 is a selection *change*: pressing '1' on slot 1 must stay silent, and
    // a tick with both wheel and digit input must click once, not twice.
    if (p.selectedSlot !== prevSlot) emitSound('ui.hotbar', null);

    this.currentHit = this.rayHit();

    // drop (03 §17)
    if (input.pressed.has('KeyQ')) this.dropHeld(input.shift);

    // middle-click pick block (debug only)
    if (input.middlePressed && p.gameMode === 'debugCreative' && this.currentHit) {
      const id = this.currentHit.id;
      const item = ITEMS.get(id);
      if (item) p.inventory[p.selectedSlot] = { id, count: item.stack ?? 64 };
    }

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
    let dmg = base * (0.2 + 0.8 * charge * charge);

    const crit = p.vel.y < 0 && !p.onGround && charge >= 0.848 &&
                 !p.sprinting && !p.inWater && !p.onLadder;
    if (crit) dmg *= 1.5;

    let kb = 0.4;
    const wasSprinting = p.sprinting;
    if (wasSprinting) {
      kb += 0.5;
      p.stopSprint();
      p.vel.x *= 0.6; p.vel.z *= 0.6;
    }

    const dx = target.pos.x - p.pos.x, dz = target.pos.z - p.pos.z;
    const h = Math.hypot(dx, dz) || 1;
    target.hurt(dmg, 'melee', { dirX: dx / h, dirZ: dz / h, knockback: kb, attacker: p });

    if (crit) this.game.particles?.crit?.(target);
    if (item?.toolClass) p.damageHeld(item.toolClass === 'sword' ? 1 : 2);
    p.addExhaustion(0.1);
    p.ticksSinceAttack = 0;
    this.swing();
  }

  // ---------------------------------------------------------- mining (03 §15)

  miningDamagePerTick(block) {
    if (block.hardness < 0) return 0;
    if (block.hardness === 0) return 1;
    const p = this.player;
    const item = p.heldItem();
    const toolClass = item?.toolClass ?? null;
    let speed = 1.0;
    if (toolClass && toolClass === block.tool) {
      speed = item.speedMult ?? 1;
      if (toolClass === 'shears') {
        speed = block.name.startsWith('wool') ? 5 : 15;   // 06 §1 special
      }
    }
    if (p.eyeSubmerged) speed /= 5;
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

    if (p.gameMode === 'debugCreative') {
      if (block.hardness < 0) return;
      // 15 §10.6 applies here too: this path bypasses breakBlock entirely, so
      // without the same rule a creative-mode break would drink the lake.
      const cleared = this.world.clearedCell(hit.x, hit.y, hit.z);
      this.world.setBlock(hit.x, hit.y, hit.z, cleared.id, { state: cleared.state, byPlayer: true });
      this.game.particles?.blockBreak?.(hit.x, hit.y, hit.z, hit.id);
      this.swing();
      this.mineDelay = 4;
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

  breakBlock(x, y, z) {
    const p = this.player;
    const id = this.world.getBlock(x, y, z);
    const block = BLOCKS[id];
    const state = this.world.getState(x, y, z);
    const item = p.heldItem();
    const toolClass = item?.toolClass ?? null;
    const toolTier = item?.tier ?? null;

    const drops = block.drops
      ? block.drops({ state, toolClass, toolTier, rng: this.world.rng }) : [];
    const xp = block.xpForMine ? block.xpForMine({ state, toolClass, toolTier, rng: this.world.rng }) : 0;

    // 15 §10.6 — a waterlogged block breaks to a water SOURCE, not air; drops
    // then run unchanged. `state` was read above, before the erase, so bit 7 is
    // already in hand.
    if (state & WATERLOGGED) this.world.setBlock(x, y, z, B.WATER, { state: 0, byPlayer: true });
    else this.world.setBlock(x, y, z, B.AIR, { byPlayer: true });
    for (const d of drops) {
      if (d.count > 0) this.game.spawnItemByName(d.name, d.count, x + 0.5, y + 0.5, z + 0.5);
    }
    if (xp > 0) this.game.spawnXpOrb(x + 0.5, y + 0.5, z + 0.5, xp);
    if (block.hardness > 0 && item?.durability) {
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
      if (chan.kind === 'bow') this.releaseBow(chan.ticks);
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
      const item = p.heldItem();
      if (item?.kind === 'food') {
        p.eat(item);
        p.consumeHeld(1);
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

  releaseBow(ticks) {
    const p = this.player;
    const f0 = ticks / 20;
    const charge = Math.min(1, (f0 * f0 + 2 * f0) / 3);
    if (charge < 0.1) return;
    if (!this.takeItem('arrow')) return;
    p.damageHeld(1);
    const e = this.eyePos(), d = this.lookDir();
    const speed = 3 * charge;
    const rng = this.world.rng;
    const inacc = 0.0172275 * 1;
    const vx = d.x * speed + gaussian(rng) * inacc;
    const vy = d.y * speed + gaussian(rng) * inacc;
    const vz = d.z * speed + gaussian(rng) * inacc;
    this.game.spawnArrow(e.x, e.y - 0.1, e.z, vx, vy, vz, p, { crit: charge >= 1, fromPlayer: true });
    // Self event -> flat pool (§3.3). NOT inside Game.spawnArrow: skeletons share
    // that path and their shot must render positionally.
    emitSound('item.bow.shoot', null, 1, charge);
    this.swing();
  }

  hasItem(name) {
    const id = idOf(name);
    return this.player.inventory.some(s => s && s.id === id && s.count > 0);
  }

  takeItem(name) {
    const id = idOf(name);
    const inv = this.player.inventory;
    for (let i = 0; i < 36; i++) {
      if (inv[i] && inv[i].id === id) {
        inv[i].count--;
        if (inv[i].count <= 0) inv[i] = null;
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------- RMB (03 §16.1)

  use(input) {
    const p = this.player;
    const held = p.heldItem();
    const hit = this.currentHit;

    // 0: entity interaction (feeding, shearing) — nearest entity on the ray ≤ 3
    const entTarget = this.pickEntityTarget();
    if (entTarget && entTarget.interact) {
      if (entTarget.interact(p, p.heldStack)) {
        this.useDelay = 4;
        this.swing();
        return;
      }
    }

    // 1–2: interactables first (unless sneaking)
    if (hit) {
      const block = BLOCKS[hit.id];
      if (block.interactable && !p.sneaking) {
        this.useDelay = 4;
        this.interactWith(block, hit);
        return;
      }
    }

    if (!held) return;

    // 3: placeable block
    if (held.place != null && hit) {
      if (this.tryPlace(held, hit)) { this.useDelay = 4; return; }
    }
    if (held.placesAs && hit) {
      if (this.tryPlaceSpecial(held, hit)) { this.useDelay = 4; return; }
    }

    // 4: usable items
    if (held.kind === 'food') {
      if (p.foodLevel < 20 && !p.usingItem) {
        p.usingItem = { kind: 'eat', ticks: 0 };
      }
      return;
    }
    if (held.name === 'bow') {
      if (!p.usingItem && this.hasItem('arrow')) {
        p.usingItem = { kind: 'bow', ticks: 0 };
        this.bowLoop = startLoop('item.bow.draw', null);
      }
      return;
    }
    if (held.kind === 'throwable') {
      this.throwHeld(held);
      this.useDelay = 4;
      return;
    }
    if (held.kind === 'armor') {
      const slot = held.armorSlot;
      if (p.armor[slot] == null) {
        p.armor[slot] = p.heldStack;
        p.heldStack = null;
        // §3.3: metal chimes, leather rustles
        emitSound(held.name.startsWith('leather') ? 'player.armor_equip.leather' : 'player.armor_equip', null);
        this.swing();
      }
      this.useDelay = 4;
      return;
    }
    if (held.name === 'bucket') { this.useBucketEmpty(); this.useDelay = 4; return; }
    if (held.name === 'water_bucket' || held.name === 'lava_bucket') {
      this.useBucketFilled(held); this.useDelay = 4; return;
    }
    if (!hit) return;

    if (held.toolClass === 'hoe') { this.useHoe(hit); this.useDelay = 4; return; }
    if (held.plantsCrop != null) { this.plantSeed(held, hit); this.useDelay = 4; return; }
    if (held.name === 'bone_meal') { this.useBoneMeal(hit); this.useDelay = 4; return; }
    if (held.name === 'flint_and_steel') { this.useFlintSteel(hit); this.useDelay = 4; return; }
    if (held.name === 'shears' && hit) { /* sheep shearing handled via entity use */ }
  }

  interactWith(block, hit) {
    const g = this.game;
    switch (block.interactable) {
      case 'crafting': g.openContainer('crafting'); break;
      case 'furnace': g.openContainer('furnace', hit.x, hit.y, hit.z); break;
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

  tryPlace(held, hit) {
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
    } else if (blockId === B.FURNACE || blockId === B.CHEST) {
      // front toward the player
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
    if (p.gameMode !== 'debugCreative') p.consumeHeld(1);
    this.swing();
    return true;
  }

  // §3.2 place verb; shared by tryPlace and tryPlaceSpecial (door/bed).
  emitPlace(blockId, x, y, z) {
    const cls = matOf(blockId);
    if (cls) emitSound(`block.place.${cls}`, at(x + 0.5, y + 0.5, z + 0.5));
  }

  tryPlaceSpecial(held, hit) {
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
      p.consumeHeld(1);
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
      p.consumeHeld(1);
      this.swing();
      return true;
    }
    return false;
  }

  plantSeed(held, hit) {
    const w = this.world;
    if (hit.face[1] !== 1) return;
    if (w.getBlock(hit.x, hit.y, hit.z) !== B.FARMLAND) return;
    const y = hit.y + 1;
    if (w.getBlock(hit.x, y, hit.z) !== B.AIR) return;
    w.setBlock(hit.x, y, hit.z, held.plantsCrop, { state: 0, byPlayer: true });
    this.emitPlace(held.plantsCrop, hit.x, y, hit.z);
    this.player.consumeHeld(1);
    this.swing();
  }

  useHoe(hit) {
    const w = this.world;
    const id = w.getBlock(hit.x, hit.y, hit.z);
    if ((id === B.GRASS_BLOCK || id === B.DIRT) &&
        w.getBlock(hit.x, hit.y + 1, hit.z) === B.AIR) {
      w.setBlock(hit.x, hit.y, hit.z, B.FARMLAND, { byPlayer: true });
      this.player.damageHeld(1);
      this.swing();
    }
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
      return;
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
    }
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
      return;
    }
    // rule 3 — base fluidMode source scan (06 §6.4)
    const hit = this.rayHit(this.reach(), { fluidMode: true });
    if (!hit) return;
    const blk = BLOCKS[hit.id];
    if (blk.shape !== 'liquid') return;
    const filled = idOf(blk.fluid === 'water' ? 'water_bucket' : 'lava_bucket');
    this.world.setBlock(hit.x, hit.y, hit.z, B.AIR, { byPlayer: true });
    emitSound(blk.fluid === 'lava' ? 'item.bucket.fill.lava' : 'item.bucket.fill',
      at(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5));
    this.fillBucketStack(filled);
    this.swing();
  }

  /** Bucket -> filled bucket, honoring the bucket's stack size (16). */
  fillBucketStack(filledId) {
    const p = this.player;
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
    if (!hit) return;
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
      this.player.heldStack = { id: idOf('bucket'), count: 1 };
      this.swing();
      return;
    }
    const pos = this.placePosFor(hit);
    const targetId = w.getBlock(pos.x, pos.y, pos.z);
    if (!BLOCKS[targetId].replaceable) return;
    const fluidId = held.name === 'water_bucket' ? B.WATER : B.LAVA;
    w.setBlock(pos.x, pos.y, pos.z, fluidId, { state: 0, byPlayer: true });
    // before checkInteractions, which may itself fire block.extinguish (01 §6.3)
    emitSound('item.bucket.pour', at(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5));
    w.fluids.checkInteractions(pos.x, pos.y, pos.z);
    this.player.heldStack = { id: idOf('bucket'), count: 1 };
    this.swing();
  }

  throwHeld(held) {
    const p = this.player;
    if (held.name === 'ender_pearl') {
      if (this.pearlCooldown > 0) return;
      this.pearlCooldown = 20;
    }
    const e = this.eyePos(), d = this.lookDir();
    const speed = 1.5;
    this.game.spawnThrown(held.name, e.x, e.y - 0.1, e.z,
      d.x * speed, d.y * speed, d.z * speed, p);
    p.consumeHeld(1);
    this.swing();
  }

  dropHeld(wholeStack) {
    const p = this.player;
    const s = p.heldStack;
    if (!s) return;
    const n = wholeStack ? s.count : 1;
    const drop = { id: s.id, count: n };
    if (s.damage !== undefined) drop.damage = s.damage;
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
