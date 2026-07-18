// 07-REDSTONE §6-§8, §12 — component handlers: torch, lever, buttons, plates,
// repeater, comparator, observer, lamp, note block, plus the TNT/door hooks.
// Piston moves live in PistonMover.js. Dispenser/dropper/hopper block-entity
// logic lives in containersRedstone.js; this file owns their power latching.
//
// Handlers are attached to the block defs at runtime by installComponentHooks()
// so registry/blocks.js stays a leaf. Every handler reaches the engine through
// world.game.redstone and this instance through world.game.redstoneComponents.
//
// Delays (all game ticks, §6.1): torch 2, repeater 2-8, comparator 2, piston 2,
// dispenser/dropper 4, lamp-off 4, button 20/30, plate 20, observer 2+2.

import { BLOCKS, B } from '../registry/blocks.js';
import { emitSound, at } from '../audio/engine.js';
import { AABB } from '../math/aabb.js';
import { LivingEntity } from '../entities/Entity.js';
import { FACE6_DIR, ATTACH_DIR, HFACE_DIR, HFACE_OPP, supportCell } from './dirs.js';
import {
  isActivated, weakPower, strongPower, directPowerInto, conductive, emitInto,
  attachOf, torchLit, leverOn, buttonPressed, platePressed,
  repHface, repDelay, repOn, repLocked, cmpHface, cmpSubtract, cmpOut,
  obsFace, obsPulsing, hopperLocked, noteLatched,
} from './power.js';
import { containerSignal } from './containersRedstone.js';
import { tryExtend, tryRetract } from './PistonMover.js';

const key = (x, y, z) => x + ',' + y + ',' + z;

export class RedstoneComponents {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.torchOff = new Map();     // cellKey → number[] of turn-OFF times (burnout window, §6.4)
    this.burnedOut = new Set();    // cellKey of torches currently burned out
    this.repPending = new Map();   // repeater cellKey → target bool (latched at schedule, §7)
    this.sameTickInsert = new Set(); // dispenser/dropper cells that received an item this tick (§10.1)
  }

  get eng() { return this.game.redstone; }

  // ---- shared: support check (pop when the attachment block is gone) ----
  /** Returns true if the block was popped (caller must stop). */
  checkSupport(x, y, z, st, kind) {
    const w = this.world;
    let sup;
    if (kind === 'attach') {
      const [sx, sy, sz] = supportCell(attachOf(st), x, y, z);
      sup = w.getBlock(sx, sy, sz);
    } else {                                   // 'below'
      sup = w.getBlock(x, y - 1, z);
    }
    // supports = any conductive block or glass (07 §4.1/§6)
    if (!BLOCKS[sup]?.conductive && sup !== B.GLASS) { w.popBlock(x, y, z); return true; }
    return false;
  }

  // =================================================== §6.4 redstone torch
  torchNeighbor(x, y, z, st) {
    if (this.checkSupport(x, y, z, st, 'attach')) return;
    const k = key(x, y, z);
    if (this.burnedOut.has(k)) {
      // §6.4 relight path: if the window has cleared, re-evaluate normally.
      if (this.countRecentOff(k) < 8) { this.burnedOut.delete(k); } else return;
    }
    const [sx, sy, sz] = supportCell(attachOf(st), x, y, z);
    const shouldLit = weakPower(this.world, sx, sy, sz) === 0;   // inversion
    if (shouldLit !== torchLit(st)) this.world.scheduleTick(x, y, z, 2);
  }
  torchTick(x, y, z, st) {
    const w = this.world;
    const k = key(x, y, z);
    if (this.burnedOut.has(k)) {
      if (this.countRecentOff(k) < 8) this.burnedOut.delete(k); else return;
    }
    const [sx, sy, sz] = supportCell(attachOf(st), x, y, z);
    const shouldLit = weakPower(w, sx, sy, sz) === 0;
    if (shouldLit === torchLit(st)) return;                     // input changed back during the 2 gt
    if (!shouldLit) {                                            // turning OFF → burnout accounting
      const times = this.torchOff.get(k) ?? [];
      times.push(w.time);
      this.torchOff.set(k, times.filter(t => t > w.time - 60));
      if (this.countRecentOff(k) > 8) {
        w.updateEmission(x, y, z, 7, 0);
        w.setState(x, y, z, st & ~0x08);
        this.burnedOut.add(k);
        emitSound('block.redstone_torch.burnout', at(x + 0.5, y + 0.5, z + 0.5));
        this.game.particles?.smoke?.(x + 0.5, y + 0.6, z + 0.5);
        w.scheduleTick(x, y, z, 160);                           // §6.4 self-relight attempt
        this.eng.onOutputChanged(x, y, z);
        return;
      }
    }
    const now = shouldLit ? (st | 0x08) : (st & ~0x08);
    w.updateEmission(x, y, z, torchLit(st) ? 7 : 0, shouldLit ? 7 : 0);
    w.setState(x, y, z, now);
    this.eng.onOutputChanged(x, y, z);
  }
  countRecentOff(k) {
    const times = this.torchOff.get(k);
    if (!times) return 0;
    return times.filter(t => t > this.world.time - 60).length;
  }

  // =================================================== §6.1 lever
  leverUse(x, y, z, st) {
    const on = !leverOn(st);
    this.world.setState(x, y, z, on ? (st | 0x08) : (st & ~0x08));
    emitSound(on ? 'block.lever.click.on' : 'block.lever.click.off', at(x + 0.5, y + 0.5, z + 0.5));
    this.eng.onOutputChanged(x, y, z);
  }
  leverNeighbor(x, y, z, st) { this.checkSupport(x, y, z, st, 'attach'); }

  // =================================================== §6.2 buttons
  buttonUse(x, y, z, st, id) {
    if (buttonPressed(st)) return;                              // no timer refresh (vanilla)
    this.world.setState(x, y, z, st | 0x08);
    const mat = id === B.WOODEN_BUTTON ? 'wood' : 'stone';
    emitSound(`block.button.${mat}.on`, at(x + 0.5, y + 0.5, z + 0.5));
    this.eng.onOutputChanged(x, y, z);
    this.world.scheduleTick(x, y, z, id === B.WOODEN_BUTTON ? 30 : 20);
  }
  buttonTick(x, y, z, st, id) {
    if (!buttonPressed(st)) return;
    // §6.2 wooden button + arrow: stay pressed while an arrow is stuck in the
    // cell; re-poll tightly so release lands within ~2 gt of the arrow leaving
    // (the 05 §11 pickup notification also pokes buttonNeighbor).
    if (id === B.WOODEN_BUTTON && this.arrowInCell(x, y, z)) {
      this.world.scheduleTick(x, y, z, 2);
      return;
    }
    this.world.setState(x, y, z, st & ~0x08);
    const mat = id === B.WOODEN_BUTTON ? 'wood' : 'stone';
    emitSound(`block.button.${mat}.off`, at(x + 0.5, y + 0.5, z + 0.5));
    this.eng.onOutputChanged(x, y, z);
  }
  buttonNeighbor(x, y, z, st, id) {
    if (this.checkSupport(x, y, z, st, 'attach')) return;
    // an arrow that just stuck fires a neighbor update; press if not already
    if (id === B.WOODEN_BUTTON && !buttonPressed(st) && this.arrowInCell(x, y, z)) {
      this.world.setState(x, y, z, st | 0x08);
      emitSound('block.button.wood.on', at(x + 0.5, y + 0.5, z + 0.5));
      this.eng.onOutputChanged(x, y, z);
      this.world.scheduleTick(x, y, z, 10);
    }
  }
  arrowInCell(x, y, z) {
    const box = new AABB(x, y, z, x + 1, y + 1, z + 1);
    return this.world.getEntitiesInBox(box, e => e.type === 'arrow' && e.stuck).length > 0;
  }

  // =================================================== §6.3 pressure plates
  /** Called each tick from Game with the live entity list; presses on contact. */
  tickPlates(entities) {
    const w = this.world;
    for (const e of entities) {
      if (e.dead) continue;
      const bb = e.getAABB();
      // the plate cell an entity presses = the cell its footprint sits in
      const y0 = Math.floor(bb.min[1] + 1e-4);
      for (let x = Math.floor(bb.min[0]); x <= Math.floor(bb.max[0] - 1e-4); x++) {
        for (let z = Math.floor(bb.min[2]); z <= Math.floor(bb.max[2] - 1e-4); z++) {
          const id = w.getBlock(x, y0, z);
          if (id !== B.STONE_PRESSURE_PLATE && id !== B.WOODEN_PRESSURE_PLATE) continue;
          if (!this.plateAccepts(id, e)) continue;
          const st = w.getState(x, y0, z);
          if (platePressed(st)) continue;
          w.setState(x, y0, z, st | 0x01);
          const mat = id === B.WOODEN_PRESSURE_PLATE ? 'wood' : 'stone';
          emitSound(`block.pressure_plate.${mat}.on`, at(x + 0.5, y0 + 0.5, z + 0.5));
          this.eng.onOutputChanged(x, y0, z);
          w.scheduleTick(x, y0, z, 20);
        }
      }
    }
  }
  plateAccepts(id, e) {
    if (id === B.WOODEN_PRESSURE_PLATE) return true;             // any entity
    return e instanceof LivingEntity;                            // stone: player + mobs
  }
  plateTick(x, y, z, st, id) {
    if (!platePressed(st)) return;
    if (this.plateOccupied(x, y, z, id)) { this.world.scheduleTick(x, y, z, 20); return; }
    this.world.setState(x, y, z, st & ~0x01);
    const mat = id === B.WOODEN_PRESSURE_PLATE ? 'wood' : 'stone';
    emitSound(`block.pressure_plate.${mat}.off`, at(x + 0.5, y + 0.5, z + 0.5));
    this.eng.onOutputChanged(x, y, z);
  }
  plateOccupied(x, y, z, id) {
    const box = new AABB(x, y, z, x + 1, y + 0.25, z + 1);       // §6.3 detection box
    return this.world.getEntitiesInBox(box, e => !e.dead && this.plateAccepts(id, e)).length > 0;
  }
  plateNeighbor(x, y, z, st) { this.checkSupport(x, y, z, st, 'below'); }

  // =================================================== §6.5 redstone block
  sourcePlaced(x, y, z) { this.eng.onOutputChanged(x, y, z); }

  // =================================================== §6.6 observer
  observerTrigger(x, y, z) {
    const st = this.world.getState(x, y, z);
    // §6.6 — triggers arriving while pulsing OR while the on-pulse is already
    // scheduled are dropped (dedup spans buckets, not just one).
    if (obsPulsing(st) || this.world.hasScheduled(x, y, z)) return;
    this.world.scheduleTick(x, y, z, 2);                        // → pulse on
  }
  observerTick(x, y, z, st) {
    const w = this.world;
    if (!obsPulsing(st)) {                                      // phase 1: turn on
      w.setState(x, y, z, st | 0x08);
      this.eng.onOutputChanged(x, y, z);
      w.scheduleTick(x, y, z, 2);                              // → phase 2
    } else {                                                    // phase 2: turn off
      w.setState(x, y, z, st & ~0x08);
      this.eng.onOutputChanged(x, y, z);
    }
  }
  observerMoved(x, y, z) { this.world.scheduleTick(x, y, z, 2); }   // §6.6 pulse after a piston move

  // =================================================== §7 repeater
  repeaterUse(x, y, z, st) {
    const nd = (repDelay(st) + 1) & 3;
    this.world.setState(x, y, z, (st & ~0x0c) | (nd << 2));
    emitSound('block.repeater.click', at(x + 0.5, y + 0.5, z + 0.5));
    this.eng.onOutputChanged(x, y, z);                          // delay change is an observable state change
  }
  repeaterInput(x, y, z, st) {
    // §7 — REAR cell only (opposite the output HFACE). A diode ignores its front
    // and sides entirely, so this reads exactly one neighbour.
    const w = this.world;
    const back = HFACE_DIR[HFACE_OPP[repHface(st)]];
    const bx = x + back[0], by = y, bz = z + back[2];
    // a source/diode/wire in the rear cell emitting weak into our cell
    if (emitInto(w, bx, by, bz, x, y, z).w > 0) return true;
    // a conductive rear block that is itself weakly powered
    if (conductive(w, bx, by, bz) && weakPower(w, bx, by, bz) > 0) return true;
    return false;
  }
  computeLocked(x, y, z, st) {
    // locked = any side neighbour is a powered repeater/comparator pointing into our side
    const hf = repHface(st);
    for (const side of [(hf + 1) & 3, (hf + 3) & 3]) {
      const d = HFACE_DIR[side];
      const nx = x + d[0], nz = z + d[2];
      const nid = this.world.getBlock(nx, y, nz);
      const nst = this.world.getState(nx, y, nz);
      if (nid === B.REPEATER && repOn(nst) && repHface(nst) === HFACE_OPP[side]) return true;
      if (nid === B.COMPARATOR && cmpOut(nst) > 0 && cmpHface(nst) === HFACE_OPP[side]) return true;
    }
    return false;
  }
  repeaterNeighbor(x, y, z, st) {
    if (this.checkSupport(x, y, z, st, 'below')) return;
    const w = this.world;
    const locked = this.computeLocked(x, y, z, st);
    if (locked !== repLocked(st)) w.setState(x, y, z, locked ? (st | 0x20) : (st & ~0x20));
    if (locked) return;
    const k = key(x, y, z);
    if (this.repPending.has(k)) return;                         // no cancel on input flicker (§7)
    const input = this.repeaterInput(x, y, z, st);
    if (input !== repOn(st)) {
      this.repPending.set(k, input);
      w.scheduleTick(x, y, z, (repDelay(st) + 1) * 2);
    }
  }
  repeaterTick(x, y, z, st) {
    const w = this.world;
    const k = key(x, y, z);
    const target = this.repPending.get(k);
    this.repPending.delete(k);
    if (repLocked(st)) return;                                  // frozen — drop the pending change
    if (target === undefined) return;
    if (target === repOn(st)) return;
    w.setState(x, y, z, target ? (st | 0x10) : (st & ~0x10));
    this.eng.onOutputChanged(x, y, z);
    // re-evaluate: if the input differs from the new output, schedule again
    const st2 = w.getState(x, y, z);
    const input = this.repeaterInput(x, y, z, st2);
    if (!repLocked(st2) && input !== repOn(st2) && !this.repPending.has(k)) {
      this.repPending.set(k, input);
      w.scheduleTick(x, y, z, (repDelay(st2) + 1) * 2);
    }
  }

  // =================================================== §8 comparator
  comparatorUse(x, y, z, st) {
    this.world.setState(x, y, z, st ^ 0x04);                    // toggle mode bit2
    emitSound('block.comparator.click', at(x + 0.5, y + 0.5, z + 0.5));
    this.world.scheduleTick(x, y, z, 2);                        // re-eval output
  }
  comparatorNeighbor(x, y, z, st) {
    if (this.checkSupport(x, y, z, st, 'below')) return;
    this.world.scheduleTick(x, y, z, 2);                        // deduped
  }
  comparatorTick(x, y, z, st) {
    const w = this.world;
    const hf = cmpHface(st);
    const back = HFACE_DIR[HFACE_OPP[hf]];
    const bx = x + back[0], bz = z + back[2];
    // rear level R: container override, else power
    let R = this.containerBehind(bx, y, bz, back);
    if (R < 0) {
      const bid = w.getBlock(bx, y, bz);
      if (bid === B.REDSTONE_WIRE) R = w.getState(bx, y, bz) & 0x0f;
      else if (bid === B.REPEATER && repOn(w.getState(bx, y, bz))) R = 15;
      else if (bid === B.COMPARATOR) R = cmpOut(w.getState(bx, y, bz));
      else if (bid === B.REDSTONE_BLOCK) R = 15;
      else if (conductive(w, bx, y, bz)) R = weakPower(w, bx, y, bz);
      else R = 0;
    }
    // side levels A, C: only dust / redstone block / diode outputs pointing in
    const A = this.comparatorSide(x, y, z, (hf + 1) & 3);
    const C = this.comparatorSide(x, y, z, (hf + 3) & 3);
    const side = Math.max(A, C);
    const out = cmpSubtract(st) ? Math.max(R - side, 0) : (side <= R ? R : 0);
    if (out !== cmpOut(st)) {
      w.setState(x, y, z, (st & ~0x78) | ((out & 0x0f) << 3));
      this.eng.onOutputChanged(x, y, z);
    }
  }
  containerBehind(bx, by, bz, back) {
    // direct container, or one conductive block through (§8 one-block reading)
    const bid = this.world.getBlock(bx, by, bz);
    if (BLOCKS[bid]?.blockEntity) return containerSignal(this.game, bx, by, bz);
    if (conductive(this.world, bx, by, bz)) {
      const cx = bx + back[0], cz = bz + back[2];
      if (BLOCKS[this.world.getBlock(cx, by, cz)]?.blockEntity) return containerSignal(this.game, cx, by, cz);
    }
    return -1;
  }
  comparatorSide(x, y, z, hf) {
    const d = HFACE_DIR[hf];
    const nx = x + d[0], nz = z + d[2];
    const nid = this.world.getBlock(nx, y, nz);
    const nst = this.world.getState(nx, y, nz);
    if (nid === B.REDSTONE_WIRE) return nst & 0x0f;
    if (nid === B.REDSTONE_BLOCK) return 15;
    if (nid === B.REPEATER && repOn(nst) && repHface(nst) === HFACE_OPP[hf]) return 15;
    if (nid === B.COMPARATOR && cmpOut(nst) > 0 && cmpHface(nst) === HFACE_OPP[hf]) return cmpOut(nst);
    return 0;
  }
  onContainerChanged(x, y, z) {
    // schedule re-eval for comparators reading this container (behind directly,
    // or through one conductive block).
    for (const [dx, dy, dz] of FACE6_DIR) {
      this.scheduleComparatorIfReading(x + dx, y + dy, z + dz, x, y, z);
      if (conductive(this.world, x + dx, y + dy, z + dz)) {
        for (const [ex, ey, ez] of FACE6_DIR)
          this.scheduleComparatorIfReading(x + dx + ex, y + dy + ey, z + dz + ez, x, y, z);
      }
    }
  }
  scheduleComparatorIfReading(cx, cy, cz, contX, contY, contZ) {
    if (this.world.getBlock(cx, cy, cz) !== B.COMPARATOR) return;
    const st = this.world.getState(cx, cy, cz);
    const back = HFACE_DIR[HFACE_OPP[cmpHface(st)]];
    // rear cell, or one through
    if (cx + back[0] === contX && cy === contY && cz + back[2] === contZ) { this.world.scheduleTick(cx, cy, cz, 2); return; }
    const midx = cx + back[0], midz = cz + back[2];
    if (conductive(this.world, midx, cy, midz) && midx + back[0] === contX && cy === contY && midz + back[2] === contZ)
      this.world.scheduleTick(cx, cy, cz, 2);
  }

  // =================================================== §12.1 redstone lamp
  lampNeighbor(x, y, z) {
    const w = this.world;
    if (isActivated(w, x, y, z)) w.setBlock(x, y, z, B.REDSTONE_LAMP_LIT, { byPlayer: true });  // instant
    else w.scheduleTick(x, y, z, 4);                                                            // off-delay
  }
  lampLitNeighbor(x, y, z) {
    const w = this.world;
    if (isActivated(w, x, y, z)) return;                        // still powered → stay lit
    w.scheduleTick(x, y, z, 4);
  }
  lampTick(x, y, z) {
    const w = this.world;
    if (!isActivated(w, x, y, z) && w.getBlock(x, y, z) === B.REDSTONE_LAMP_LIT)
      w.setBlock(x, y, z, B.REDSTONE_LAMP, { byPlayer: true });
  }

  // =================================================== §12.2 note block
  noteUse(x, y, z, st) {
    const note = ((st & 0x1f) + 1) % 25;
    this.world.setState(x, y, z, (st & ~0x1f) | note);
    this.playNote(x, y, z, note);
  }
  notePunch(x, y, z, st) { this.playNote(x, y, z, st & 0x1f); }
  noteNeighbor(x, y, z, st) {
    const act = isActivated(this.world, x, y, z);
    if (act && !noteLatched(st)) { this.world.setState(x, y, z, st | 0x20); this.playNote(x, y, z, st & 0x1f); }
    else if (!act && noteLatched(st)) this.world.setState(x, y, z, st & ~0x20);
  }
  playNote(x, y, z, note) {
    if (this.world.getBlock(x, y + 1, z) !== B.AIR) return;     // §12.2 needs air above
    const inst = this.noteInstrument(this.world.getBlock(x, y - 1, z));
    const pitch = Math.pow(2, (note - 12) / 12);
    emitSound(`block.note.${inst}`, at(x + 0.5, y + 0.5, z + 0.5), pitch);
    this.game.particles?.note?.(x + 0.5, y + 1.2, z + 0.5, note / 24);
  }
  noteInstrument(below) {
    if ([5, 6, 7, 8, 9, 10, 34, 37, 50, 52, 88].includes(below)) return 'bass';
    if (below === 18 || below === 19) return 'snare';
    if (below === 31) return 'hat';
    if ([1, 4, 17, 20, 21, 22, 23, 24, 25, 26, 27, 33, 35, 36, 82, 83, 84].includes(below)) return 'basedrum';
    if (below === 29) return 'bell';
    if (below >= 46 && below <= 49) return 'guitar';
    if (below === 28) return 'iron_xylophone';
    if (below === 32) return 'pling';
    if (below === 44 || below === 45) return 'didgeridoo';
    return 'harp';
  }

  // =================================================== §9 pistons
  pistonNeighbor(x, y, z, st, id) {
    const w = this.world;
    const extended = (st & 0x08) !== 0;
    const act = isActivated(w, x, y, z);
    if (act && !extended) w.scheduleTick(x, y, z, 2);
    else if (!act && extended) w.scheduleTick(x, y, z, 2);
  }
  pistonTick(x, y, z, st, id) {
    const w = this.world;
    const extended = (st & 0x08) !== 0;
    const act = isActivated(w, x, y, z);
    if (act && !extended) tryExtend(this.game, x, y, z, st, id);
    else if (!act && extended) tryRetract(this.game, x, y, z, st, id);
  }
  headBroken(x, y, z, oldState) {
    // §9.1 breaking the head breaks the base too, dropping one piston item.
    // Suppressed during a controlled retract (which removes the head itself).
    if (this.game.pistonMoving) return;
    const w = this.world;
    const f = oldState & 0x07;
    const d = FACE6_DIR[f];
    const bx = x - d[0], by = y - d[1], bz = z - d[2];         // base is opposite the head dir
    const bid = w.getBlock(bx, by, bz);
    if (bid === B.PISTON || bid === B.STICKY_PISTON) {
      this.game.spawnItemById(bid, 1, bx + 0.5, by + 0.5, bz + 0.5);
      this.game.pistonMoving = true;                          // don't re-enter via the base
      w.setBlock(bx, by, bz, B.AIR, { byPlayer: true });
      this.game.pistonMoving = false;
    }
  }

  /**
   * §9.1/§17 — breaking an EXTENDED piston base removes its orphaned head too, so
   * a save never sees a head without a base. The base already drops itself; the
   * head drops nothing. No-op during a controlled retract (setState, not break).
   */
  baseBroken(x, y, z, oldState) {
    if (this.game.pistonMoving) return;
    if (!(oldState & 0x08)) return;                            // wasn't extended → no head
    const w = this.world;
    const d = FACE6_DIR[oldState & 0x07];
    const hx = x + d[0], hy = y + d[1], hz = z + d[2];
    if (w.getBlock(hx, hy, hz) === B.PISTON_HEAD) {
      this.game.pistonMoving = true;
      w.setBlock(hx, hy, hz, B.AIR, { byPlayer: true });
      this.game.pistonMoving = false;
    }
  }

  // =================================================== §10-§11 machines (latch only)
  machineNeighbor(x, y, z, st, id) {
    // dispenser/dropper rising-edge fire latch
    const w = this.world;
    const act = isActivated(w, x, y, z);
    const latched = (st & 0x08) !== 0;
    if (act && !latched) { w.setState(x, y, z, st | 0x08); w.scheduleTick(x, y, z, 4); }
    else if (!act && latched) w.setState(x, y, z, st & ~0x08);
  }
  machineTick(x, y, z, st, id) {
    this.game.redstoneContainers.fire(x, y, z, id);
  }
  hopperNeighbor(x, y, z, st) {
    const w = this.world;
    const locked = isActivated(w, x, y, z);
    if (locked !== hopperLocked(st)) w.setState(x, y, z, locked ? (st | 0x08) : (st & ~0x08));
  }

  // Transient per-cell state must be discarded when a component is broken, or a
  // new component placed at the same cell inherits a stale latch (a stuck
  // repPending suppresses all future scheduling; a stale burnout window lies).
  repeaterBroken(x, y, z) { this.repPending.delete(key(x, y, z)); }
  torchBroken(x, y, z) { const k = key(x, y, z); this.torchOff.delete(k); this.burnedOut.delete(k); }

  // =================================================== §12.3 TNT ignition
  tntCheck(x, y, z) {
    if (isActivated(this.world, x, y, z)) this.world.igniteTnt?.(x, y, z, 80);
  }

  // =================================================== §12.4 doors
  // AMENDS 06 §5.13 — bit4 latch. On any update of either half, force open = the
  // OR of both halves' activation; manual toggling still allowed between edges.
  doorPower(x, y, z, st) {
    const w = this.world;
    const lowerY = (st & 0x01) ? y - 1 : y;          // bit0 = upper half
    if (w.getBlock(x, lowerY, z) !== B.OAK_DOOR) return;
    const ls = w.getState(x, lowerY, z);
    const p = isActivated(w, x, lowerY, z) || isActivated(w, x, lowerY + 1, z);
    if (p === ((ls & 0x10) !== 0)) return;            // latch bit4 unchanged → no edge
    const bits = p ? 0x12 : 0x00;                     // set open (bit1) and latch (bit4) together
    w.setState(x, lowerY, z, (ls & ~0x12) | bits);
    if (w.getBlock(x, lowerY + 1, z) === B.OAK_DOOR) {
      const us = w.getState(x, lowerY + 1, z);
      w.setState(x, lowerY + 1, z, (us & ~0x12) | bits);
    }
    emitSound(p ? 'block.door.open' : 'block.door.close', at(x + 0.5, lowerY + 0.5, z + 0.5));
  }
}

// ------------------------------------------------------------------------
// installComponentHooks — attach the handlers above to the block defs. Called
// once at engine construction. Closures reach the live instance through
// world.game.redstoneComponents; base TNT/door hooks are composed, not replaced.
// ------------------------------------------------------------------------
let _hooksInstalled = false;
export function installComponentHooks() {
  if (_hooksInstalled) return;                        // idempotent: compose() must wrap once
  _hooksInstalled = true;
  const rc = w => w.game.redstoneComponents;
  const set = (id, hooks) => Object.assign(BLOCKS[id], hooks);

  set(B.REDSTONE_WIRE, {
    onPlaced: (w, x, y, z) => rc(w).eng.onOutputChanged(x, y, z),
    onBroken: (w, x, y, z) => rc(w).eng.onOutputChanged(x, y, z),
    neighborUpdate: (w, x, y, z, st) => rc(w).checkSupport(x, y, z, st, 'below'),
  });
  set(B.REDSTONE_TORCH, {
    onPlaced: (w, x, y, z) => rc(w).eng.onOutputChanged(x, y, z),
    onBroken: (w, x, y, z) => { rc(w).torchBroken(x, y, z); rc(w).eng.onOutputChanged(x, y, z); },
    neighborUpdate: (w, x, y, z, st) => rc(w).torchNeighbor(x, y, z, st),
    scheduledTick: (w, x, y, z, st) => rc(w).torchTick(x, y, z, st),
  });
  set(B.LEVER, {
    onUse: (w, x, y, z, st) => rc(w).leverUse(x, y, z, st),
    neighborUpdate: (w, x, y, z, st) => rc(w).leverNeighbor(x, y, z, st),
  });
  for (const id of [B.STONE_BUTTON, B.WOODEN_BUTTON]) set(id, {
    onUse: (w, x, y, z, st) => rc(w).buttonUse(x, y, z, st, id),
    scheduledTick: (w, x, y, z, st) => rc(w).buttonTick(x, y, z, st, id),
    neighborUpdate: (w, x, y, z, st) => rc(w).buttonNeighbor(x, y, z, st, id),
  });
  for (const id of [B.STONE_PRESSURE_PLATE, B.WOODEN_PRESSURE_PLATE]) set(id, {
    scheduledTick: (w, x, y, z, st) => rc(w).plateTick(x, y, z, st, id),
    neighborUpdate: (w, x, y, z, st) => rc(w).plateNeighbor(x, y, z, st),
  });
  set(B.REDSTONE_BLOCK, { onPlaced: (w, x, y, z) => rc(w).sourcePlaced(x, y, z) });
  set(B.OBSERVER, {
    scheduledTick: (w, x, y, z, st) => rc(w).observerTick(x, y, z, st),
    onMoved: (w, x, y, z) => rc(w).observerMoved(x, y, z),
  });
  set(B.REPEATER, {
    onUse: (w, x, y, z, st) => rc(w).repeaterUse(x, y, z, st),
    onBroken: (w, x, y, z) => { rc(w).repeaterBroken(x, y, z); rc(w).eng.onOutputChanged(x, y, z); },
    neighborUpdate: (w, x, y, z, st) => rc(w).repeaterNeighbor(x, y, z, st),
    scheduledTick: (w, x, y, z, st) => rc(w).repeaterTick(x, y, z, st),
  });
  set(B.COMPARATOR, {
    onUse: (w, x, y, z, st) => rc(w).comparatorUse(x, y, z, st),
    neighborUpdate: (w, x, y, z, st) => rc(w).comparatorNeighbor(x, y, z, st),
    scheduledTick: (w, x, y, z, st) => rc(w).comparatorTick(x, y, z, st),
  });
  set(B.REDSTONE_LAMP, { neighborUpdate: (w, x, y, z) => rc(w).lampNeighbor(x, y, z) });
  set(B.REDSTONE_LAMP_LIT, {
    neighborUpdate: (w, x, y, z) => rc(w).lampLitNeighbor(x, y, z),
    scheduledTick: (w, x, y, z) => rc(w).lampTick(x, y, z),
  });
  set(B.NOTE_BLOCK, {
    onUse: (w, x, y, z, st) => rc(w).noteUse(x, y, z, st),
    neighborUpdate: (w, x, y, z, st) => rc(w).noteNeighbor(x, y, z, st),
  });
  for (const id of [B.PISTON, B.STICKY_PISTON]) set(id, {
    onPlaced: (w, x, y, z, st) => rc(w).pistonNeighbor(x, y, z, st, id),
    neighborUpdate: (w, x, y, z, st) => rc(w).pistonNeighbor(x, y, z, st, id),
    scheduledTick: (w, x, y, z, st) => rc(w).pistonTick(x, y, z, st, id),
    onBroken: (w, x, y, z, os) => rc(w).baseBroken(x, y, z, os),
  });
  set(B.PISTON_HEAD, { onBroken: (w, x, y, z, os) => rc(w).headBroken(x, y, z, os) });
  for (const id of [B.DISPENSER, B.DROPPER]) set(id, {
    onPlaced: (w, x, y, z, st) => rc(w).machineNeighbor(x, y, z, st, id),
    neighborUpdate: (w, x, y, z, st) => rc(w).machineNeighbor(x, y, z, st, id),
    scheduledTick: (w, x, y, z, st) => rc(w).machineTick(x, y, z, st, id),
  });
  set(B.HOPPER, {
    onPlaced: (w, x, y, z, st) => rc(w).hopperNeighbor(x, y, z, st),
    neighborUpdate: (w, x, y, z, st) => rc(w).hopperNeighbor(x, y, z, st),
  });

  // Compose onto the base TNT (51) and door (53) handlers — AMENDS 06 §5.6/§5.13.
  const compose = (id, hook, fn) => {
    const prev = BLOCKS[id][hook];
    BLOCKS[id][hook] = (w, x, y, z, st) => { prev?.(w, x, y, z, st); fn(w, x, y, z, st); };
  };
  compose(B.TNT, 'neighborUpdate', (w, x, y, z) => rc(w).tntCheck(x, y, z));
  compose(B.TNT, 'onPlaced', (w, x, y, z) => rc(w).tntCheck(x, y, z));
  compose(B.OAK_DOOR, 'neighborUpdate', (w, x, y, z, st) => rc(w).doorPower(x, y, z, st));
  compose(B.OAK_DOOR, 'onPlaced', (w, x, y, z, st) => rc(w).doorPower(x, y, z, st));
}
