// Nether generation (10 §4). Pure and worker-safe: imported ONLY by the gen
// worker via gen/dimGen.js. Deterministic per (seed, dim, cx, cz) per 10 §2.2.
//
// SCOPE (E7a): §4.1 vertical structure, §4.3 cavern carving, §4.4 lava sea.
// §4.2 biomes, §4.5 ores, §4.6 glowstone, §4.7 decoration and §5 fortress are
// E7b — biomes[] is filled with nether_wastes (0) meanwhile, which is §4.2's
// own default and needs no rework when the climate select lands.
//
// The Nether is NATIVE Y 0-127 — no remap (10 §4). 1.16's Nether already spans
// 0-127 with lava at 31 and a bedrock roof at 127, so wiki Y values are verbatim.
//
// Seed streams are disjoint from 02's overworld names (10 §2.2), so the two
// dimensions never share RNG and the same seed yields a byte-identical Overworld.
// Sub-seed derivation is string-keyed (`mix32(worldSeed ^ hashString('sys:'+s))`),
// so adding these names does NOT perturb 02's seven existing streams.
import { createNoise3D } from 'simplex-noise';
import alea from 'alea';
import { hashString, mix32, posHash } from '../../math/rng.js';
import { B } from '../../registry/blocks.js';
import { terminatesSky } from '../LightEngine.js';

const LAVA_LEVEL = 31;          // §4.4 — wiki-exact 1.16 Nether lava sea surface
const CARVE_THRESHOLD = 0.30;   // §4.3 — |density| < 0.30 carves to air

// Same lattice key as 02's cheese field: ix,iz ∈ ±262144, 33 Y-planes at stride 4
// (y 0..128). The Nether's native 0-127 uses the identical plane count.
const key3 = (ix, iy, iz) => ((ix + 262144) * 33 + iy) * 524288 + (iz + 262144);

export function createNetherGenerator(worldSeed) {
  const seeds = {};
  for (const s of ['nether_bedrock', 'nether_cavern', 'nether_biome',
                   'nether_ore', 'nether_decor', 'fortress']) {
    seeds[s] = mix32(worldSeed ^ hashString('sys:' + s));
  }

  const nCavern = createNoise3D(alea(`${worldSeed}:nether:cavern`));
  const nCavern2 = createNoise3D(alea(`${worldSeed}:nether:cavern2`));
  const cavernMemo = new Map();

  /** §4.3 — the Swiss-cheese field. Big rooms + detail; y stretched → wide caverns. */
  function netherDensity(x, y, z) {
    const n1 = nCavern(x / 48, y / 40, z / 48);
    const n2 = 0.5 * nCavern2(x / 22, y / 18, z / 22);
    return (n1 + n2) / 1.5;
  }

  // 02 §4.4's stride-4 lattice, reused verbatim so batch and single-cell queries
  // return bit-identical numbers.
  function cavernLatticePoint(ix, iy, iz) {
    const k = key3(ix, iy, iz);
    let v = cavernMemo.get(k);
    if (v === undefined) {
      v = netherDensity(ix * 4, iy * 4, iz * 4);
      if (cavernMemo.size > 200000) cavernMemo.clear();
      cavernMemo.set(k, v);
    }
    return v;
  }

  function cavernAt(x, y, z) {
    const ix = Math.floor(x / 4), iy = Math.floor(y / 4), iz = Math.floor(z / 4);
    const fx = x / 4 - ix, fy = y / 4 - iy, fz = z / 4 - iz;
    const c000 = cavernLatticePoint(ix, iy, iz), c100 = cavernLatticePoint(ix + 1, iy, iz);
    const c010 = cavernLatticePoint(ix, iy + 1, iz), c110 = cavernLatticePoint(ix + 1, iy + 1, iz);
    const c001 = cavernLatticePoint(ix, iy, iz + 1), c101 = cavernLatticePoint(ix + 1, iy, iz + 1);
    const c011 = cavernLatticePoint(ix, iy + 1, iz + 1), c111 = cavernLatticePoint(ix + 1, iy + 1, iz + 1);
    const x00 = c000 + (c100 - c000) * fx, x10 = c010 + (c110 - c010) * fx;
    const x01 = c001 + (c101 - c001) * fx, x11 = c011 + (c111 - c011) * fx;
    const y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy;
    return y0 + (y1 - y0) * fz;
  }

  /**
   * §4.3 tapering: "near the roof (y>112) and floor (y<10) raise the solid
   * threshold so roof/floor stay mostly closed." Raising the SOLID threshold ==
   * lowering the CARVE threshold, ramped linearly to 0 at the bedrock guards, so
   * no cavern ever touches y<=0 or y>=127 and the sealed shell is structural
   * rather than a post-pass patch.
   */
  function carveThresholdAt(y) {
    let t = CARVE_THRESHOLD;
    if (y < 10) t *= Math.max(0, (y - 4) / 6);        // 0 at y=4 → full at y=10
    else if (y > 112) t *= Math.max(0, (123 - y) / 11); // full at y=112 → 0 at y=123
    return t;
  }

  /** §4.1 — jagged bedrock floor (1..4) and roof (123..126). */
  function isJaggedBedrock(x, y, z) {
    if (y >= 1 && y <= 4) return posHash(seeds.nether_bedrock, x, y, z) < (5 - y) / 4;
    if (y >= 123 && y <= 126) return posHash(seeds.nether_bedrock, x, y, z) < (y - 122) / 4;
    return false;
  }

  function generateChunk(cx, cz) {
    const blocks = new Uint8Array(32768);

    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const x = cx * 16 + lx, z = cz * 16 + lz;
        for (let y = 0; y <= 127; y++) {
          const i = (y << 8) | (lz << 4) | lx;
          // §4.1 vertical structure
          if (y === 0 || y === 127) { blocks[i] = B.BEDROCK; continue; }
          if (isJaggedBedrock(x, y, z)) { blocks[i] = B.BEDROCK; continue; }
          if (y < 5 || y > 122) { blocks[i] = B.NETHERRACK; continue; }

          // §4.3 carve
          const t = carveThresholdAt(y);
          const carved = Math.abs(cavernAt(x, y, z)) < t;
          if (!carved) { blocks[i] = B.NETHERRACK; continue; }

          // §4.4 lava sea — every carved-air cell at or below Y31 is a lava
          // SOURCE (state 0, settled; 06 owns flow).
          blocks[i] = y <= LAVA_LEVEL ? B.LAVA : B.AIR;
        }
      }
    }

    // §4.7.5 heightmap. Uses the SAME predicate the reload path uses
    // (ChunkManager.hydrate → terminatesSky), rather than a gen-side copy: 02's
    // HM_SKIP and terminatesSky agree only by coincidence today, and a
    // divergence silently desyncs generated vs. reloaded chunks. Importing the
    // one predicate makes that class of bug structurally impossible here.
    const heightMap = new Uint8Array(256);
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        for (let y = 127; y >= 0; y--) {
          if (terminatesSky(blocks[(y << 8) | (lz << 4) | lx], 0)) {
            heightMap[(lz << 4) | lx] = y + 1;
            break;
          }
        }
      }
    }

    // §4.2 — dim 1 stores NETHER biome ids. E7a: nether_wastes (0) everywhere.
    const biomes = new Uint8Array(256);   // 0 = nether_wastes
    return { blocks, heightMap, biomes, spawns: [] };
  }

  return { generateChunk, seeds, cavernAt };
}
