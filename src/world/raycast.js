// Voxel raycast — Amanatides & Woo DDA (01 §11).
import { BLOCKS } from '../registry/blocks.js';

// Returns first targetable block along the ray, or null.
// opts.fluidMode: also stop at fluid SOURCE cells (bucket use).
// opts.opaqueOnly: only stop at opaque blocks (mob line-of-sight).
export function raycastBlocks(world, ox, oy, oz, dx, dy, dz, maxDist, opts = {}) {
  const fluidMode = !!opts.fluidMode;
  const opaqueOnly = !!opts.opaqueOnly;
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const stepX = Math.sign(dx), stepY = Math.sign(dy), stepZ = Math.sign(dz);
  const tDeltaX = stepX ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = stepZ ? Math.abs(1 / dz) : Infinity;
  let tMaxX = stepX > 0 ? (x + 1 - ox) / dx : stepX < 0 ? (x - ox) / dx : Infinity;
  let tMaxY = stepY > 0 ? (y + 1 - oy) / dy : stepY < 0 ? (y - oy) / dy : Infinity;
  let tMaxZ = stepZ > 0 ? (z + 1 - oz) / dz : stepZ < 0 ? (z - oz) / dz : Infinity;
  let t = 0, faceX = 0, faceY = 0, faceZ = 0;

  for (let i = 0; i < 256 && t <= maxDist; i++) {
    const id = world.getBlock(x, y, z);
    const b = BLOCKS[id];
    const hit = opaqueOnly
      ? b.opaque
      : (b.targetable || (fluidMode && b.shape === 'liquid' && world.getState(x, y, z) === 0));
    if (hit) {
      return { x, y, z, id, face: [faceX, faceY, faceZ], t,
               px: ox + dx * t, py: oy + dy * t, pz: oz + dz * t };
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX; t = tMaxX; tMaxX += tDeltaX; faceX = -stepX; faceY = 0; faceZ = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY; t = tMaxY; tMaxY += tDeltaY; faceX = 0; faceY = -stepY; faceZ = 0;
    } else {
      z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; faceX = 0; faceY = 0; faceZ = -stepZ;
    }
  }
  return null;
}

// Line-of-sight helper (05 §6): true when no opaque block sits between a and b.
export function hasLineOfSight(world, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return true;
  const hit = raycastBlocks(world, ax, ay, az, dx / dist, dy / dist, dz / dist, dist,
    { opaqueOnly: true });
  return hit === null;
}
