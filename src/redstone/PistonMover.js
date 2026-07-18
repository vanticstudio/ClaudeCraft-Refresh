// 07-REDSTONE §9 — piston push-set computation and the move transaction.
// Instant-move rendering (§9.2 adaptation): no moving-block entity, blocks
// teleport one cell on the completion tick and the head appears/disappears.

import { BLOCKS, B } from '../registry/blocks.js';
import { FACE6_DIR } from './dirs.js';
import { AABB } from '../math/aabb.js';
import { emitSound, at } from '../audio/engine.js';

const MAX_PUSH = 12;
const LEAVES = new Set([11, 12, 13]);   // cube-shaped but break when pushed (drop table A)

const IMMOVABLE = new Set([
  B.BEDROCK, B.OBSIDIAN, B.FURNACE, B.FURNACE_LIT, B.CHEST,
  B.DISPENSER, B.DROPPER, B.HOPPER, B.PISTON_HEAD,
]);

/** §9.3 — an immovable block fails the whole push. */
function immovable(world, x, y, z) {
  const id = world.getBlock(x, y, z);
  if (IMMOVABLE.has(id)) return true;
  // an EXTENDED piston base is immovable (its head is anchored)
  if ((id === B.PISTON || id === B.STICKY_PISTON) && (world.getState(x, y, z) & 0x08)) return true;
  return false;
}

/** §9.3 — a non-cube / needsSupport / leaf block pops as drops when the row moves. */
function breaksWhenPushed(id) {
  const b = BLOCKS[id];
  if (!b) return false;
  if (b.shape !== 'cube') return true;      // wire/torch/lever/button/plate/repeater/comparator/fence/door/bed/…
  if (b.needsSupport) return true;
  if (LEAVES.has(id)) return true;
  return false;
}

const isFluid = (world, x, y, z) => !!BLOCKS[world.getBlock(x, y, z)]?.fluid;
const isAir = (world, x, y, z) => world.getBlock(x, y, z) === B.AIR;

/**
 * §9.3 computePushSet — the contiguous full-cube blocks to move, nearest-first.
 * Returns { set, endCell } on success, or null on FAIL (immovable, > 12, or the
 * world edge). The loop STOPS at air / fluid / a breaksWhenPushed block; that
 * end cell is cleared before the row advances.
 */
function computePushSet(world, bx, by, bz, dir) {
  const set = [];
  let cx = bx + dir[0], cy = by + dir[1], cz = bz + dir[2];
  for (;;) {
    if (cy < 0 || cy > 127) return null;
    if (isAir(world, cx, cy, cz) || isFluid(world, cx, cy, cz)) break;
    const id = world.getBlock(cx, cy, cz);
    if (breaksWhenPushed(id)) break;
    if (immovable(world, cx, cy, cz) || set.length >= MAX_PUSH) return null;
    set.push([cx, cy, cz]);
    cx += dir[0]; cy += dir[1]; cz += dir[2];
  }
  return { set, endCell: [cx, cy, cz] };
}

function headStateFor(baseState, id) {
  // piston_head: bits0-2 FACE6 (same as base), bit3 sticky flag
  return (baseState & 0x07) | (id === B.STICKY_PISTON ? 0x08 : 0);
}

/** §9.3 extend. */
export function tryExtend(game, x, y, z, st, id) {
  const world = game.world;
  const dir = FACE6_DIR[st & 0x07];
  const push = computePushSet(world, x, y, z, dir);
  if (!push) return false;                            // stay retracted; retry on next update
  const { set, endCell } = push;

  // clear the end cell: a breakable block pops (drops), a fluid is deleted
  const endId = world.getBlock(endCell[0], endCell[1], endCell[2]);
  if (endId !== B.AIR) {
    if (breaksWhenPushed(endId)) world.popBlock(endCell[0], endCell[1], endCell[2]);
    else world.setBlock(endCell[0], endCell[1], endCell[2], B.AIR, { byPlayer: true });
  }

  // snapshot, clear sources silently, then write destinations with full updates
  const snap = set.map(([cx, cy, cz]) => ({ cx, cy, cz, id: world.getBlock(cx, cy, cz), st: world.getState(cx, cy, cz) }));
  for (const s of snap) world.setBlock(s.cx, s.cy, s.cz, B.AIR, { byPlayer: true, noUpdates: true });
  for (const s of snap) {
    const dx = s.cx + dir[0], dy = s.cy + dir[1], dz = s.cz + dir[2];
    world.setBlock(dx, dy, dz, s.id, { state: s.st, byPlayer: true });
    BLOCKS[s.id]?.onMoved?.(world, dx, dy, dz, s.st);
  }

  // place the head and extend the base
  const hx = x + dir[0], hy = y + dir[1], hz = z + dir[2];
  world.setBlock(hx, hy, hz, B.PISTON_HEAD, { state: headStateFor(st, id), byPlayer: true });
  world.setState(x, y, z, st | 0x08);

  pushEntities(game, set, hx, hy, hz, dir);
  emitSound('block.piston.extend', at(x + 0.5, y + 0.5, z + 0.5));
  game.redstone.onCellChanged(x, y, z, id, id);
  return true;
}

/** §9.3 retract. Sticky pulls one movable block; regular pistons never pull. */
export function tryRetract(game, x, y, z, st, id) {
  const world = game.world;
  const dir = FACE6_DIR[st & 0x07];
  const hx = x + dir[0], hy = y + dir[1], hz = z + dir[2];
  // Removing the head fires its onBroken (headBroken), which would break the
  // base — so flag this as a controlled move; headBroken no-ops while set.
  game.pistonMoving = true;
  world.setBlock(hx, hy, hz, B.AIR, { byPlayer: true });        // remove head
  game.pistonMoving = false;

  if (id === B.STICKY_PISTON) {
    const px = hx + dir[0], py = hy + dir[1], pz = hz + dir[2];
    const pid = world.getBlock(px, py, pz);
    if (pid !== B.AIR && !isFluid(world, px, py, pz) &&
        !immovable(world, px, py, pz) && !breaksWhenPushed(pid)) {
      const pst = world.getState(px, py, pz);
      world.setBlock(px, py, pz, B.AIR, { byPlayer: true, noUpdates: true });
      world.setBlock(hx, hy, hz, pid, { state: pst, byPlayer: true });
      BLOCKS[pid]?.onMoved?.(world, hx, hy, hz, pst);
    }
  }

  world.setState(x, y, z, st & ~0x08);
  emitSound('block.piston.retract', at(x + 0.5, y + 0.5, z + 0.5));
  game.redstone.onCellChanged(x, y, z, id, id);
  return true;
}

/**
 * §9.3 — entities whose AABB intersects a destination cell or the head cell are
 * shoved 1.0 × dir (no damage). Push cells = the head + every moved block's new cell.
 */
function pushEntities(game, set, hx, hy, hz, dir) {
  const cells = [[hx, hy, hz], ...set.map(([cx, cy, cz]) => [cx + dir[0], cy + dir[1], cz + dir[2]])];
  for (const [cx, cy, cz] of cells) {
    const box = new AABB(cx, cy, cz, cx + 1, cy + 1, cz + 1);
    for (const e of game.world.getEntitiesInBox(box, e => !e.dead && e.type !== 'item')) {
      e.moveEntity?.(dir[0], dir[1], dir[2]) ?? shove(e, dir);
    }
  }
}
function shove(e, dir) {
  e.pos.x += dir[0]; e.pos.y += dir[1]; e.pos.z += dir[2];
}
