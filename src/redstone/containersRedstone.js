// 07-REDSTONE §8 (comparator signal), §10 (dispenser/dropper), §11 (hopper).
// Block-entity logic for the machines. The power-latch handlers live in
// components.js; this file owns what happens WHEN they fire, plus the per-tick
// hopper transfer loop and the comparator's container fullness reading.

import { BLOCKS, B } from '../registry/blocks.js';
import { ITEMS, idOf } from '../registry/items.js';
import { cloneStack, tagsEqual, getEnchantLvl } from '../items/tags.js';
import { unbreakingToolPoints } from '../items/durability.js';
import { ENCH } from '../items/enchants.js';
import { FACE6_DIR, FACE6_OPP } from './dirs.js';
import { emitSound, at } from '../audio/engine.js';
import { AABB } from '../math/aabb.js';

const maxStack = id => ITEMS.get(id)?.stack ?? 64;

// 06 §11.1 / 07 §11.3 — the whole furnace family shares the 3-slot furnace block
// entity (input, fuel, output), so every slot rule below must cover all six ids.
// Missing 175-178 made hoppers drain a blast furnace's raw input and let
// `insert` write past the end of a 3-element slot array.
const FURNACE_IDS = new Set([
  B.FURNACE, B.FURNACE_LIT, B.BLAST_FURNACE, B.BLAST_FURNACE_LIT, B.SMOKER, B.SMOKER_LIT,
]);

const slotCountFor = id =>
  (id === B.HOPPER ? 5 : (id === B.CHEST || id === B.BARREL || id === B.SHULKER_BOX ? 27
    : (FURNACE_IDS.has(id) ? 3
      : (id === B.BREWING_STAND ? 5 : 9))));   // 11-END §9.4 — shulker 27; 09 §10 — brewing 5

/**
 * The block entity at this cell IFF it actually carries an inventory. Several
 * registered kinds have no `slots` at all (spawner 141, end_gateway 163,
 * beacon 187); dereferencing `data.slots` on those threw out of the tick loop.
 */
const inventoryOf = (game, x, y, z) => {
  const be = game.getBlockEntity(x, y, z);
  return Array.isArray(be?.data?.slots) ? be : null;
};

/**
 * §8 — the comparator fullness signal for a container at (x,y,z).
 *   fullness = Σ (count_i / maxStack_i) / slotCount ;  signal = empty ? 0 : floor(1 + 14·fullness)
 */
export function containerSignal(game, x, y, z) {
  const id = game.world.getBlock(x, y, z);
  if (!BLOCKS[id]?.blockEntity) return 0;
  const be = game.getBlockEntity(x, y, z);
  const slots = be?.data?.slots;
  if (!slots) return 0;
  const n = slotCountFor(id);
  let sum = 0, any = false;
  for (let i = 0; i < n; i++) {
    const s = slots[i];
    if (s && s.count > 0) { any = true; sum += s.count / maxStack(s.id); }
  }
  if (!any) return 0;
  return Math.floor(1 + 14 * (sum / n));
}

export class RedstoneContainers {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.sameTick = new Set();      // §10.1 determinism guard: cells that got an item this tick
  }

  clearTickGuards() { this.sameTick.clear(); }
  markInserted(x, y, z) { this.sameTick.add(x + ',' + y + ',' + z); }

  /**
   * 01 §16.2 — every mutation in this file is a pure block-entity write with no
   * setBlock behind it, so nothing else marks the chunk dirty and `saveAll`
   * (which only queues `chunk.modified`) would drop the transfer on reload.
   */
  dirty(x, y, z) { const c = this.world.getChunkAt(x, z); if (c) c.modified = true; }

  // ---------------------------------------------------- §10 dispenser / dropper
  fire(x, y, z, id) {
    const be = this.game.getBlockEntity(x, y, z);
    const slots = be?.data?.slots;
    if (!slots) return;
    // §10.1 guard: an item inserted here this same tick cannot be fired now.
    const justGot = this.sameTick.has(x + ',' + y + ',' + z);
    const choices = [];
    for (let i = 0; i < 9; i++) if (slots[i] && slots[i].count > 0) choices.push(i);
    if (choices.length === 0 || justGot) {
      emitSound('block.dispenser.fail', at(x + 0.5, y + 0.5, z + 0.5));
      return;
    }
    const slot = choices[Math.floor(this.world.rng() * choices.length)];
    if (id === B.DROPPER) this.dropperFire(x, y, z, slots, slot);
    else this.dispenserFire(x, y, z, slots, slot);
    this.dirty(x, y, z);
    this.game.redstone.containerChanged(x, y, z);
  }

  frontCell(x, y, z) {
    const f = this.world.getState(x, y, z) & 0x07;
    const d = FACE6_DIR[f];
    return [x + d[0], y + d[1], z + d[2], d];
  }

  consume(slots, slot, n = 1) {
    slots[slot].count -= n;
    if (slots[slot].count <= 0) slots[slot] = null;
  }

  /**
   * §10.2 "slot item becomes the filled/empty bucket" — singular. Replacing the
   * whole slot carried the source count over, so a stack of 16 empty buckets
   * became 16 water_buckets (maxStack 1) from ONE source block, and firing it
   * back re-inflated the stack forever. Consume one, re-insert one, overflow to
   * the world if the 9 slots are full.
   */
  swapBucket(slots, slot, outId, cx, cy, cz) {
    this.consume(slots, slot);
    if (!this.insert(slots, 9, { id: outId, count: 1 }, B.DISPENSER, 'any')) {
      this.game.spawnItemById(outId, 1, cx, cy, cz);
    }
  }

  dispenserFire(x, y, z, slots, slot) {
    const s = slots[slot];
    const [fx, fy, fz, d] = this.frontCell(x, y, z);
    const g = this.game;
    const cx = fx + 0.5, cy = fy + 0.5, cz = fz + 0.5;
    const name = ITEMS.get(s.id)?.name ?? '';
    const speed = 1.1;
    switch (s.id) {
      case 282: {                                   // arrow
        g.spawnArrow(cx, cy, cz, d[0] * speed, d[1] * speed, d[2] * speed, null, { fromPlayer: false });
        this.consume(slots, slot); emitSound('block.dispenser.fire', at(cx, cy, cz)); return;
      }
      case 333: case 335: {                         // egg / snowball
        const kind = s.id === 333 ? 'egg' : 'snowball';
        g.spawnThrown(kind, cx, cy, cz, d[0] * speed, d[1] * speed, d[2] * speed, null);
        this.consume(slots, slot); emitSound('block.dispenser.fire', at(cx, cy, cz)); return;
      }
      case 286: case 287: {                         // water/lava bucket → place source
        const fluid = s.id === 286 ? B.WATER : B.LAVA;
        if (BLOCKS[this.world.getBlock(fx, fy, fz)]?.replaceable || this.world.getBlock(fx, fy, fz) === B.AIR) {
          this.world.setBlock(fx, fy, fz, fluid);
          this.swapBucket(slots, slot, 285, cx, cy, cz);        // §10.2 — ONE bucket empties
          emitSound('block.dispenser.fire', at(cx, cy, cz)); return;
        }
        break;
      }
      case 285: {                                   // empty bucket → pick up a source
        const fid = this.world.getBlock(fx, fy, fz);
        const fst = this.world.getState(fx, fy, fz);
        const filled = fid === B.WATER ? 286 : (fid === B.LAVA ? 287 : 0);
        if (filled && (fst & 0x0f) === 0) {
          this.world.setBlock(fx, fy, fz, B.AIR);
          this.swapBucket(slots, slot, filled, cx, cy, cz);     // §10.2 — ONE bucket fills
          emitSound('block.dispenser.fire', at(cx, cy, cz)); return;
        }
        break;
      }
      case 51: {                                    // TNT → primed entity in the front cell
        this.consume(slots, slot);
        g.igniteTnt(fx, fy, fz, 80); emitSound('block.dispenser.fire', at(cx, cy, cz)); return;
      }
      case 284: {                                   // flint_and_steel → fire
        if (this.world.getBlock(fx, fy, fz) === B.AIR) {
          this.world.setBlock(fx, fy, fz, B.FIRE);
          // 08 §5.7 — gate EVERY decrement site, flint_and_steel included; a
          // dispensed one keeps its tags, so Unbreaking must apply here too.
          // When the roll skips, `damage` is unchanged and the item survives.
          s.damage = (s.damage ?? 0) +
            unbreakingToolPoints(1, getEnchantLvl(s, ENCH.UNBREAKING), this.world?.rng ?? Math.random);
          if (s.damage >= (ITEMS.get(284)?.durability ?? 64)) slots[slot] = null;
          emitSound('block.dispenser.fire', at(cx, cy, cz)); return;
        }
        break;
      }
      case 332: {                                   // bone_meal → fertilize
        if (g.tryBonemeal?.(fx, fy, fz)) { this.consume(slots, slot); emitSound('block.dispenser.fire', at(cx, cy, cz)); return; }
        break;
      }
      default: break;
    }
    this.defaultDrop(x, y, z, slots, slot, d);      // anything else / failed special
  }

  dropperFire(x, y, z, slots, slot) {
    const [fx, fy, fz, d] = this.frontCell(x, y, z);
    const tid = this.world.getBlock(fx, fy, fz);
    // §10.3 transfer 1 item into the container. Only a real inventory qualifies:
    // a spawner/beacon/end_gateway is a block entity with no slots, and is not a
    // container, so it falls through to the default-drop below.
    const tbe = BLOCKS[tid]?.blockEntity ? inventoryOf(this.game, fx, fy, fz) : null;
    if (tbe) {
      // §10.3 "furnace with its slot rules per §11.3" — never the output slot.
      const rule = this.pushRule(tid, this.world.getState(x, y, z) & 0x07);
      if (rule && this.insert(tbe.data.slots, slotCountFor(tid), slots[slot], tid, rule)) {
        this.consume(slots, slot);
        this.markInserted(fx, fy, fz);
        this.dirty(fx, fy, fz);
        this.game.redstone.containerChanged(fx, fy, fz);
        emitSound('block.dropper.drop', at(x + 0.5, y + 0.5, z + 0.5));
        return;
      }
      emitSound('block.dispenser.fail', at(x + 0.5, y + 0.5, z + 0.5));   // full/refused: item stays
      return;
    }
    this.defaultDrop(x, y, z, slots, slot, d, 'block.dropper.drop');
  }

  defaultDrop(x, y, z, slots, slot, d, sound = 'block.dispenser.fire') {
    const s = slots[slot];
    const fx = x + 0.5 + d[0] * 0.7, fy = y + 0.5 + d[1] * 0.7, fz = z + 0.5 + d[2] * 0.7;
    const vel = { x: d[0] * 0.11, y: d[1] * 0.11, z: d[2] * 0.11 };
    this.game.spawnItemById(s.id, 1, fx, fy, fz, vel);
    this.consume(slots, slot);
    emitSound(sound, at(x + 0.5, y + 0.5, z + 0.5));
  }

  // ---------------------------------------------------- §11 hopper transfer loop
  tickHopper(be, x, y, z) {
    const w = this.world;
    const st = w.getState(x, y, z);
    if (st & 0x08) return;                          // §11.2 locked
    const data = be.data;
    if (data.cooldown > 0) { data.cooldown--; return; }
    let acted = false;

    // 1. PUSH into the facing cell (before pull)
    const f = st & 0x07;
    const d = FACE6_DIR[f];
    const tx = x + d[0], ty = y + d[1], tz = z + d[2];
    const tid = w.getBlock(tx, ty, tz);
    if (BLOCKS[tid]?.blockEntity) {
      const src = this.firstNonEmpty(data.slots, 5);
      // only a slots-carrying block entity is a container (§11.3); a spawner /
      // beacon / end_gateway has none and must not be dereferenced.
      const tbe = src >= 0 ? inventoryOf(this.game, tx, ty, tz) : null;
      if (tbe) {
        const rule = this.pushRule(tid, f);
        if (rule && this.insert(tbe.data.slots, slotCountFor(tid), data.slots[src], tid, rule)) {
          this.consume(data.slots, src);
          this.markInserted(tx, ty, tz);
          this.dirty(tx, ty, tz);
          this.game.redstone.containerChanged(tx, ty, tz);
          acted = true;
        }
      }
    }

    // 2. PULL from the container above, else COLLECT item entities
    const aid = w.getBlock(x, y + 1, z);
    const abe = BLOCKS[aid]?.blockEntity ? inventoryOf(this.game, x, y + 1, z) : null;
    if (abe) {
      const src = this.firstPullable(abe.data.slots, slotCountFor(aid), aid);
      if (src >= 0 && this.insert(data.slots, 5, abe.data.slots[src], B.HOPPER, 'any')) {
        this.consume(abe.data.slots, src);
        this.dirty(x, y + 1, z);
        this.game.redstone.containerChanged(x, y + 1, z);
        acted = true;
      }
    } else if (!(BLOCKS[aid]?.opaque && BLOCKS[aid]?.collidable)) {
      acted = this.collectItems(data, x, y, z) || acted;
    }

    // §11.3 wants 8 gt between transfers (2.5 items/s). The guard above returns
    // (without decrementing) on the acting tick, so resetting to 7 — not the
    // spec pseudocode's 8, which yields 9 — gives the stated interval.
    if (acted) { data.cooldown = 7; this.dirty(x, y, z); this.game.redstone.containerChanged(x, y, z); }
  }

  pushRule(tid, hopperFace) {
    if (FURNACE_IDS.has(tid)) {
      // §11.3: hopper ABOVE (faces DOWN, FACE6 0) → input; hopper into the SIDE
      // (horizontal FACE6) → fuel; never the output. (A hopper can never face up.)
      return hopperFace === 0 ? 'furnaceInput' : 'furnaceFuel';
    }
    return 'any';
  }

  firstNonEmpty(slots, n) { for (let i = 0; i < n; i++) if (slots[i] && slots[i].count > 0) return i; return -1; }
  firstPullable(slots, n, srcId) {
    // furnace as source: output slot (2) only, plus an empty bucket left in fuel (1)
    if (FURNACE_IDS.has(srcId)) {
      if (slots[2] && slots[2].count > 0) return 2;
      if (slots[1] && slots[1].id === 285) return 1;
      return -1;
    }
    for (let i = 0; i < n; i++) if (slots[i] && slots[i].count > 0) return i;
    return -1;
  }

  /** Insert 1 of `stack` into `dst` (first-fit) honouring the slot rule. Returns true if it landed. */
  insert(dst, n, stack, dstId, rule) {
    const allowed = i => {
      if (rule === 'furnaceInput') return i === 0;
      if (rule === 'furnaceFuel') return i === 1;
      return true;
    };
    // merge into an existing matching stack first (11-END §9.4 — must match tags
    // too, or a hopper would merge two differently-tagged items, e.g. two shulker
    // boxes with different contents)
    for (let i = 0; i < n; i++) {
      if (!allowed(i)) continue;
      const s = dst[i];
      if (s && s.id === stack.id && (s.damage ?? 0) === (stack.damage ?? 0) && tagsEqual(s, stack) && s.count < maxStack(s.id)) {
        s.count++; return true;
      }
    }
    for (let i = 0; i < n; i++) {
      if (!allowed(i)) continue;
      // carry tags (a moved shulker box keeps tags.containerItems) via cloneStack
      if (!dst[i]) { dst[i] = { ...cloneStack(stack), count: 1 }; return true; }
    }
    return false;
  }

  collectItems(data, x, y, z) {
    // absorb the oldest ItemEntity overlapping this cell or the cell above (whole
    // stack), §11.3. Oldest = lowest entity id.
    const box = new AABB(x, y, z, x + 1, y + 2, z + 1);
    const list = this.world.getEntitiesInBox(box, e => e.type === 'item' && !e.dead)
      .sort((a, b) => a.id - b.id);
    let acted = false;
    for (const e of list) {
      const stack = e.stack;
      if (!stack) continue;
      while (stack.count > 0 && this.insert(data.slots, 5, stack, B.HOPPER, 'any')) { stack.count--; acted = true; }
      if (stack.count <= 0) e.dead = true;
      if (acted) { this.dirty(x, y, z); break; }    // one entity per action
    }
    return acted;
  }
}
