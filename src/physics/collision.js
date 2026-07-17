// AABB vs voxel grid: axis-separated move-and-slide (01 §12).
// doorBox / FACING_DIR conventions are owned by the registry.
import { BLOCKS, B, doorBox, FACING_DIR, WATERLOGGED } from '../registry/blocks.js';
import { MAX_Y } from '../constants.js';

const EPS = 1e-7;

export { doorBox, FACING_DIR };

// Local collision box for a cell, or null when non-collidable.
export function getCellBox(id, state) {
  const b = BLOCKS[id];
  if (!b || !b.collidable) return null;
  if (b.collisionBox === 'door') return doorBox(state);
  return b.collisionBox || null;   // null = unit cube (UNIT_BOX semantics)
}

function axisCoord(axis, x, y, z) { return axis === 0 ? x : axis === 1 ? y : z; }

export function collideAxis(world, box, axis, d, blockUnloaded = false) {
  if (d === 0) return 0;
  const swept = box.clone().expandByDisplacement(axis, d);
  const x0 = Math.floor(swept.min[0]), y0 = Math.floor(swept.min[1]), z0 = Math.floor(swept.min[2]);
  const x1 = Math.ceil(swept.max[0]) - 1, y1 = Math.ceil(swept.max[1]) - 1, z1 = Math.ceil(swept.max[2]) - 1;
  // y0-1: catch boxes taller than their cell (fence is 1.5 high)
  for (let y = Math.max(y0 - 1, -1); y <= Math.min(y1, MAX_Y); y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        let cellBox;
        if (y < 0) {
          cellBox = [0, 0, 0, 1, 1, 1];              // below-world floor is solid
        } else if (blockUnloaded && !world.isLoaded(x, z)) {
          cellBox = [0, 0, 0, 1, 1, 1];              // player hard-blocks vs unloaded chunks
        } else {
          const id = world.getBlock(x, y, z);
          const blk = BLOCKS[id];
          if (!blk || !blk.collidable) continue;
          cellBox = blk.collisionBox === 'door' ? doorBox(world.getState(x, y, z))
                  : blk.collisionBox || [0, 0, 0, 1, 1, 1];
        }
        if (!box.overlapsOnOtherAxes(axis, x, y, z, cellBox)) continue;
        const lo = axisCoord(axis, x, y, z) + cellBox[axis];
        const hi = axisCoord(axis, x, y, z) + cellBox[axis + 3];
        // Only cells strictly ahead clamp; boxes already interpenetrating
        // never eject the entity backward (MC parity — you can walk out).
        if (d > 0) {
          if (lo >= box.max[axis] - EPS) d = Math.min(d, lo - box.max[axis] - EPS);
        } else {
          if (hi <= box.min[axis] + EPS) d = Math.max(d, hi - box.min[axis] + EPS);
        }
      }
    }
  }
  return d;
}

// Axis order fixed Y → X → Z (01 §12). Mutates entity pos/vel/flags.
export function moveEntity(world, entity, dx, dy, dz) {
  const blockUnloaded = !!entity.blockAgainstUnloaded;
  const box = entity.getAABB();
  const cdy = collideAxis(world, box, 1, dy, blockUnloaded); box.translate(0, cdy, 0);
  const cdx = collideAxis(world, box, 0, dx, blockUnloaded); box.translate(cdx, 0, 0);
  const cdz = collideAxis(world, box, 2, dz, blockUnloaded); box.translate(0, 0, cdz);
  entity.setPosFromAABB(box);
  entity.onGround = dy < 0 && cdy !== dy;
  entity.hitWall = cdx !== dx || cdz !== dz;
  entity.hitCeiling = dy > 0 && cdy !== dy;
  if (cdx !== dx) entity.vel.x = 0;
  if (cdy !== dy) entity.vel.y = 0;   // fall-damage hook reads pre-zero vel upstream
  if (cdz !== dz) entity.vel.z = 0;
  return { cdx, cdy, cdz };
}

// Sub-stepped move for fast entities (projectiles): ≤ 0.5 m per segment.
export function moveEntitySubstepped(world, entity, dx, dy, dz) {
  const dist = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  const steps = Math.max(1, Math.ceil(dist / 0.5));
  for (let i = 0; i < steps; i++) {
    moveEntity(world, entity, dx / steps, dy / steps, dz / steps);
    if (entity.hitWall || entity.onGround || entity.hitCeiling) break;
  }
}

// --- Cell queries used by movement code (03/05) ---

export function forEachOverlappedCell(box, cb) {
  const x0 = Math.floor(box.min[0]), y0 = Math.max(0, Math.floor(box.min[1])), z0 = Math.floor(box.min[2]);
  const x1 = Math.ceil(box.max[0]) - 1, y1 = Math.min(MAX_Y, Math.ceil(box.max[1]) - 1), z1 = Math.ceil(box.max[2]) - 1;
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++)
        if (cb(x, y, z)) return true;
  return false;
}

// Water counts as full cells for physics (01 §12 approx)
//
// AMENDS 03 §10 / 15 §13.2 — this is the ONLY writer of `inWater` (via
// Entity.updateMedium), for the player AND every mob, so the bit-7 rule belongs
// here rather than in Player: swimming/drowning inside a waterlogged
// fence/ladder column, fall damage cancelled on entry, and burning extinguished
// all fall out of this one test. Gated on 'water' — lava must never absorb it.
export function overlapsFluid(world, box, fluid) {
  const water = fluid === 'water';
  return forEachOverlappedCell(box, (x, y, z) => {
    const blk = BLOCKS[world.getBlock(x, y, z)];
    if (blk && blk.fluid === fluid) return true;
    return water && (world.getState(x, y, z) & WATERLOGGED) !== 0;
  });
}

export function overlapsBlockId(world, box, id) {
  return forEachOverlappedCell(box, (x, y, z) => world.getBlock(x, y, z) === id);
}

export function overlapsClimbable(world, box) {
  return forEachOverlappedCell(box, (x, y, z) => {
    const blk = BLOCKS[world.getBlock(x, y, z)];
    return blk && blk.climbable;
  });
}

// Any collidable block intersecting the box? (edge-guard support probe, spawn checks)
export function collidesAny(world, box) {
  const x0 = Math.floor(box.min[0]), z0 = Math.floor(box.min[2]);
  const x1 = Math.ceil(box.max[0]) - 1, z1 = Math.ceil(box.max[2]) - 1;
  const y0 = Math.max(0, Math.floor(box.min[1]) - 1);   // -1: tall boxes (fence)
  const y1 = Math.min(MAX_Y, Math.ceil(box.max[1]) - 1);
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const blk = BLOCKS[world.getBlock(x, y, z)];
        if (!blk || !blk.collidable) continue;
        const cb = blk.collisionBox === 'door' ? doorBox(world.getState(x, y, z))
                 : blk.collisionBox || [0, 0, 0, 1, 1, 1];
        if (box.min[0] < x + cb[3] && box.max[0] > x + cb[0] &&
            box.min[1] < y + cb[4] && box.max[1] > y + cb[1] &&
            box.min[2] < z + cb[5] && box.max[2] > z + cb[2]) return true;
      }
    }
  }
  return false;
}

export { B };
