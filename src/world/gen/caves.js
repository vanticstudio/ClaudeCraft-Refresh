// 02 §8 — Caves & carvers: cheese (3D noise threshold), worm tunnels,
// ravines. Worms re-simulate origin chunks within Chebyshev radius 7 and
// write only cells inside the chunk being generated.
//
// Determinism design (02 §14 early-out, resolved stream-safe): every worm's
// PARAMETERS are drawn from the origin chunk's stream (always consumed, in
// spec order), but the tunnel STEPPING runs on a per-tunnel child stream
// derived from (originSeed, wormIndex). A whole tunnel can then be skipped
// when it cannot reach the current chunk without desynchronizing any other
// tunnel's draws — chunks at different distances make different skip
// decisions, which would corrupt a shared stream but is harmless for
// independent child streams.

import { splitmix32, chunkSeed, mix32, tsin, tcos } from '../../math/rng.js';
import { ID } from './biomes.js';

const CARVE_R = 7;
// 100-block displacement clamp + branch tail (~55) is bounded by ~109 + max
// radius ~5.5 → 115 covers every reachable cell.
const TUNNEL_REACH = 115;

// 02 §8.2 — cheese caves
export function carveCheese(ctx, blocks, cx, cz, colD) {
  const grid = ctx.cheeseGrid(cx, cz);
  const wx0 = cx * 16, wz0 = cz * 16;
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const ci = (z << 4) | x;
      const h = colD.h[ci];
      const top = Math.min(h, 127);
      if (top < 4) continue;
      const wx = wx0 + x, wz = wz0 + z;
      // Water-guard fast path: side-neighbor gen water exists only at
      // y ∈ (minNH, 63]; +y guard fires only at the column top when submerged.
      const minNH = Math.min(
        ctx.heightAt(wx + 1, wz), ctx.heightAt(wx - 1, wz),
        ctx.heightAt(wx, wz + 1), ctx.heightAt(wx, wz - 1));
      for (let y = 4; y <= top; y++) {
        const threshold = ctx.cheeseThreshold(h - y);
        if (ctx.cheeseFromGrid(grid, x, y, z) <= threshold) continue;
        if (y <= 63) {
          if (y > minNH) continue;                 // side neighbor is gen water
          if (y === h && y + 1 <= 63) continue;    // +y neighbor is gen water
        }
        blocks[(y << 8) | ci] = ID.air;
      }
    }
  }
}

// Euclidean distance from point to this chunk's XZ rectangle
function distToChunkXZ(px, pz, cx, cz) {
  const dx = Math.max(cx * 16 - px, 0, px - (cx * 16 + 16));
  const dz = Math.max(cz * 16 - pz, 0, pz - (cz * 16 + 16));
  return Math.sqrt(dx * dx + dz * dz);
}

// 02 §8.3 — worm tunnels & ravines
export function carveWorms(ctx, blocks, cx, cz) {
  for (let ocx = cx - CARVE_R; ocx <= cx + CARVE_R; ocx++) {
    for (let ocz = cz - CARVE_R; ocz <= cz + CARVE_R; ocz++) {
      const originSeed = chunkSeed(ctx.seeds.carver, ocx, ocz);
      const rng = splitmix32(originSeed);
      if (rng() < 1 / 7) {
        const wormCount = 1 + Math.floor(rng() * rng() * 3);
        for (let w = 0; w < wormCount; w++) {
          const sx = ocx * 16 + rng() * 16, sz = ocz * 16 + rng() * 16;
          let y, pitch;
          if (rng() < 0.12) {                       // surface-entrance worm
            y = ctx.heightAt(sx, sz) + 1;
            pitch = -(0.35 + rng() * 0.55);
          } else {
            y = 6 + rng() * rng() * 72;
            pitch = (rng() - 0.5) * 0.5;
          }
          const yaw = rng() * Math.PI * 2;
          const thick = 1.2 + rng() * rng() * 2.2;
          const length = 50 + Math.floor(rng() * 60);
          if (distToChunkXZ(sx, sz, cx, cz) <= TUNNEL_REACH) {
            const tRng = splitmix32(mix32(originSeed ^ Math.imul(w + 1, 0x9E3779B9)));
            carveTunnel(ctx, blocks, cx, cz, tRng, sx, y, sz, yaw, pitch,
                        thick, length, 0.72, true);
          }
        }
      }
      if (rng() < 0.02) {                           // ravine: 1 in 50 chunks
        const x = ocx * 16 + rng() * 16, z = ocz * 16 + rng() * 16;
        const y = 24 + rng() * 28;
        const yaw = rng() * Math.PI * 2;
        const pitch = (rng() - 0.5) * 0.1;
        const thick = 2.2 + rng() * 2.0;
        const length = 70 + Math.floor(rng() * 40);
        if (distToChunkXZ(x, z, cx, cz) <= TUNNEL_REACH) {
          const tRng = splitmix32(mix32(originSeed ^ 0x5bd1e995));
          carveTunnel(ctx, blocks, cx, cz, tRng, x, y, z, yaw, pitch,
                      thick, length, 3.0, false);
        }
      }
    }
  }
}

function carveTunnel(ctx, blocks, cx, cz, rng, x, y, z, yaw, pitch, thick,
                     length, vScale, canBranch) {
  let yawVel = 0, pitchVel = 0;
  const ox = x, oz = z;
  for (let i = 0; i < length; i++) {
    const rH = 1.3 + tsin(i * Math.PI / length) * thick;   // swells mid-tunnel
    const rV = Math.max(1.1, rH * vScale);

    x += tcos(yaw) * tcos(pitch);
    y += tsin(pitch);
    z += tsin(yaw) * tcos(pitch);

    pitch = pitch * 0.7 + pitchVel * 0.1;
    yaw += yawVel * 0.1;
    pitchVel = pitchVel * 0.8 + (rng() - rng()) * rng() * 2.0;
    yawVel = yawVel * 0.75 + (rng() - rng()) * rng() * 4.0;

    // branch at midpoint: thick tunnels split into two half-thickness arms
    if (canBranch && i === (length >> 1) && thick > 1.8 && rng() < 0.5) {
      carveTunnel(ctx, blocks, cx, cz, rng, x, y, z, yaw - Math.PI / 2,
                  pitch / 3, thick * 0.6, length - i, vScale, false);
      carveTunnel(ctx, blocks, cx, cz, rng, x, y, z, yaw + Math.PI / 2,
                  pitch / 3, thick * 0.6, length - i, vScale, false);
      return;
    }
    if (rng() < 0.20) continue;                     // rough walls
    if ((x - ox) ** 2 + (z - oz) ** 2 > 100 * 100) return; // displacement clamp

    carveEllipsoid(ctx, blocks, cx, cz, x, y, z, rH, rV);
  }
}

function carveEllipsoid(ctx, blocks, cx, cz, x, y, z, rH, rV) {
  const x0 = Math.floor(x - rH), x1 = Math.ceil(x + rH);
  const y0 = Math.floor(y - rV), y1 = Math.ceil(y + rV);
  const z0 = Math.floor(z - rH), z1 = Math.ceil(z + rH);

  // Clip to this chunk first — no writes possible ⇒ nothing to decide.
  const bx0 = Math.max(x0, cx * 16), bx1 = Math.min(x1, cx * 16 + 15);
  if (bx0 > bx1) return;
  const bz0 = Math.max(z0, cz * 16), bz1 = Math.min(z1, cz * 16 + 15);
  if (bz0 > bz1) return;
  const by0 = Math.max(y0, 2), by1 = Math.min(y1, 127); // never carve y ≤ 1
  if (by0 > by1) return;

  // Water guard (02 §8.4): scan the FULL bbox expanded by 1 using the pure
  // gen-water test so every simulating chunk reaches the same decision.
  if (y0 - 1 <= 63) {
    const yCap = Math.min(y1 + 1, 63);
    for (let gx = x0 - 1; gx <= x1 + 1; gx++)
      for (let gz = z0 - 1; gz <= z1 + 1; gz++)
        if (ctx.heightAt(gx, gz) < yCap) return;    // gen water inside the box
  }

  const invH = 1 / (rH * rH), invV = 1 / (rV * rV);
  for (let bx = bx0; bx <= bx1; bx++) {
    const dx2 = (bx + 0.5 - x) * (bx + 0.5 - x) * invH;
    if (dx2 >= 1) continue;
    for (let by = by0; by <= by1; by++) {
      const dy2 = (by + 0.5 - y) * (by + 0.5 - y) * invV;
      if (dx2 + dy2 >= 1) continue;
      for (let bz = bz0; bz <= bz1; bz++) {
        const dz2 = (bz + 0.5 - z) * (bz + 0.5 - z) * invH;
        if (dx2 + dy2 + dz2 < 1) {
          blocks[(by << 8) | ((bz & 15) << 4) | (bx & 15)] = ID.air;
        }
      }
    }
  }
}

// 02 §8.5 — flood carved air at y ≤ 9 with lava sources
export function lavaFlood(blocks) {
  for (let y = 2; y <= 9; y++) {
    const base = y << 8;
    for (let k = 0; k < 256; k++) {
      if (blocks[base + k] === ID.air) blocks[base + k] = ID.lava;
    }
  }
}
