// 02 §7.4 + §9 — dirt/gravel pockets and ore veins. Enumerated per origin
// chunk (±1) from the "ore" stream; only cells inside the current chunk are
// written. Veins replace STONE only, so pockets/ores never overwrite each
// other. Air-exposure discard uses posHash so both sides of a border agree.

import { splitmix32, chunkSeed, posHash, triSample, rngInt, rngRange, tsin, tcos } from '../../math/rng.js';
import { ID, BIOMES } from './biomes.js';

// [block, attempts, size, sampler-kind, p0, p1, p2, discard, gateBiome?]
// kind 'u' = uniform(p0, p1); kind 't' = tri(p0, p1, p2) clipped to 0..127.
// gateBiome (12-VILLAGES §6.1): if set, a cell only places when biomeAt == it.
const FEATURES = [
  [ID.dirt,          3, 18, 'u', 34, 88, 0, 0],
  [ID.gravel,        2, 18, 'u', 0, 88, 0, 0],
  [ID.coal_ore,      7, 17, 'u', 82, 127, 0, 0],
  [ID.coal_ore,      7, 17, 't', 32, 72, 96, 0.5],
  [ID.iron_ore,     17, 9,  't', 68, 106, 127, 0],
  [ID.iron_ore,      5, 9,  't', 20, 40, 60, 0],
  [ID.iron_ore,      5, 4,  'u', 0, 66, 0, 0],
  [ID.gold_ore,      2, 9,  't', 0, 24, 48, 0.5],
  [ID.gold_ore,   -0.25, 9, 'u', 0, 8, 0, 0.5],    // 1 attempt in 25% of chunks
  [ID.redstone_ore,  2, 8,  'u', 0, 39, 0, 0],
  [ID.redstone_ore,  4, 8,  't', -16, 0, 16, 0],
  [ID.lapis_ore,     1, 7,  't', 16, 32, 48, 0],
  [ID.lapis_ore,     2, 7,  'u', 0, 64, 0, 1.0],
  [ID.diamond_ore,   4, 4,  't', -40, 0, 40, 0.5],
  [ID.diamond_ore,   2, 8,  't', -40, 0, 40, 1.0],
  [ID.diamond_ore, -1 / 9, 12, 't', -40, 0, 40, 0.7], // 1 in 1/9 chunks
  // 12-VILLAGES §6.1 row #15 — emerald: runs LAST, mountains-only, single blocks.
  [ID.emerald_ore, 11, 3, 't', 56, 96, 127, 0.5, BIOMES.MOUNTAINS],
];

export function placeOresAndPockets(ctx, blocks, cx, cz) {
  for (let ocx = cx - 1; ocx <= cx + 1; ocx++) {
    for (let ocz = cz - 1; ocz <= cz + 1; ocz++) {
      const rng = splitmix32(chunkSeed(ctx.seeds.ore, ocx, ocz));
      for (const [block, attempts, size, kind, p0, p1, p2, discard, gateBiome] of FEATURES) {
        let n;
        if (attempts < 0) n = rng() < -attempts ? 1 : 0; // fractional-chance row
        else n = attempts;
        for (let a = 0; a < n; a++) {
          const ox = ocx * 16 + rngInt(rng, 16);
          const oz = ocz * 16 + rngInt(rng, 16);
          const oy = kind === 'u' ? rngRange(rng, p0, p1) : triSample(rng, p0, p1, p2);
          if (oy < 0 || oy > 127) continue;          // clipped tail; draws consumed
          placeVein(ctx, blocks, cx, cz, rng, ox, oy, oz, size, block, discard, gateBiome);
        }
      }
    }
  }
}

// 02 §9.2 — line of overlapping spheres with sinusoidal radius
function placeVein(ctx, blocks, cx, cz, rng, ox, oy, oz, size, blockId, discard, gateBiome) {
  let x = ox, y = oy, z = oz;
  let yaw = rng() * Math.PI * 2;
  let pitch = (rng() - 0.5) * 0.9;
  const wx0 = cx * 16, wz0 = cz * 16;
  for (let i = 0; i < size; i++) {
    const t = size <= 1 ? 0.5 : i / (size - 1);
    const r = 0.6 + tsin(t * Math.PI) * (0.4 + size / 16);
    const r2 = r * r;
    // fixed iteration order: x → y → z ascending
    for (let bx = Math.floor(x - r); bx <= Math.floor(x + r); bx++) {
      for (let by = Math.floor(y - r); by <= Math.floor(y + r); by++) {
        for (let bz = Math.floor(z - r); bz <= Math.floor(z + r); bz++) {
          const dx = bx + 0.5 - x, dy = by + 0.5 - y, dz = bz + 0.5 - z;
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          if (bx < wx0 || bx > wx0 + 15 || bz < wz0 || bz > wz0 + 15 ||
              by < 0 || by > 127) continue;          // clip (no rng consumed)
          const idx = (by << 8) | ((bz & 15) << 4) | (bx & 15);
          if (blocks[idx] !== ID.stone) continue;
          // 12-VILLAGES §6.1 — biome gate (mountains); skip without consuming draws.
          if (gateBiome !== undefined && ctx.biomeAt(bx, bz) !== gateBiome) continue;
          if (discard > 0 && touchesAir(ctx, blocks, wx0, wz0, bx, by, bz) &&
              posHash(ctx.seeds.detail, bx, by, bz) < discard) continue;
          blocks[idx] = blockId;
        }
      }
    }
    x += tcos(yaw) * tcos(pitch) * 0.7;
    y += tsin(pitch) * 0.7;
    z += tsin(yaw) * tcos(pitch) * 0.7;
    yaw += (rng() - 0.5) * 0.6;
    pitch = Math.max(-1.2, Math.min(1.2, pitch + (rng() - 0.5) * 0.4));
  }
}

// 6-neighbor air test: in-chunk reads the real (carved) block state; the
// out-of-chunk fallback uses the pure cheese test only (02 §9.1).
function touchesAir(ctx, blocks, wx0, wz0, x, y, z) {
  for (const [dx, dy, dz] of NEIGHBORS) {
    const nx = x + dx, ny = y + dy, nz = z + dz;
    if (ny < 0 || ny > 127) continue;
    if (nx >= wx0 && nx <= wx0 + 15 && nz >= wz0 && nz <= wz0 + 15) {
      if (blocks[(ny << 8) | ((nz & 15) << 4) | (nx & 15)] === ID.air) return true;
    } else if (ctx.carvedByCheese(nx, ny, nz)) {
      return true;
    }
  }
  return false;
}

const NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
