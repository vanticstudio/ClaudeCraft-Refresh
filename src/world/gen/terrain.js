// 02 — deterministic chunk generator. generateChunk(cx, cz) is a pure
// function of (worldSeed, cx, cz): terrain fill → cheese → worms/ravines →
// lava flood → pockets/ores → decoration → heightmap → herd records.

import { hashString, posHash } from '../../math/rng.js';
import { createNoiseCtx } from './noise.js';
import { carveCheese, carveWorms, lavaFlood } from './caves.js';
import { placeOresAndPockets } from './ores.js';
import { decorate, computeHeightMap, rollHerd } from './features.js';
import { ID, BIOMES } from './biomes.js';
import { createStrongholdStamper } from './stronghold.js';

export function createGenerator(seed) {
  // Accept the raw user seed string or an already-hashed 32-bit int (saves
  // store the int; both routes yield the same worldSeed).
  const worldSeed = typeof seed === 'number'
    ? (seed >>> 0)
    : hashString(String(seed ?? ''));
  const ctx = createNoiseCtx(worldSeed);
  // 11-END AMENDS 02 §13.1 step 6.5 — the single overworld stronghold.
  const stronghold = createStrongholdStamper(worldSeed);

  // 02 §7 — column composition
  function fillTerrain(blocks, cx, cz, colD) {
    const wx0 = cx * 16, wz0 = cz * 16;
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const ci = (z << 4) | x;
        const h = colD.h[ci];
        const biome = colD.biome[ci];

        let surf, fill, fd, ss;
        if (h < 63) {                                   // §7.2 submerged override
          surf = fill = h >= 56 ? ID.sand : ID.gravel;
          fd = 3;
          ss = (surf === ID.sand &&
                (biome === BIOMES.DESERT || biome === BIOMES.BEACH)) ? 2 : 0;
        } else if (biome === BIOMES.DESERT || biome === BIOMES.BEACH) {
          surf = fill = ID.sand; fd = 3; ss = 2;
        } else if (biome === BIOMES.RIVER) {
          surf = fill = ID.sand; fd = 3; ss = 0;
        } else if (biome === BIOMES.MOUNTAINS && h >= 96) {
          surf = fill = ID.stone; fd = 0; ss = 0;
        } else {
          surf = ID.grass_block; fill = ID.dirt; fd = 3; ss = 0;
        }

        blocks[ci] = ID.bedrock;                        // y = 0
        blocks[256 | ci] = posHash(ctx.seeds.terrain, wx0 + x, 1, wz0 + z) < 0.5
          ? ID.bedrock : ID.stone;                      // y = 1 jagged
        const fillerBottom = h - fd, sandstoneBottom = h - fd - ss;
        for (let y = 2; y <= h; y++) {
          let id;
          if (y === h) id = surf;
          else if (y >= fillerBottom) id = fill;
          else if (y >= sandstoneBottom) id = ID.sandstone;
          else id = ID.stone;
          blocks[(y << 8) | ci] = id;
        }
        for (let y = h + 1; y <= 63; y++) blocks[(y << 8) | ci] = ID.water;
      }
    }
  }

  function generateChunk(cx, cz) {
    const blocks = new Uint8Array(32768);
    const colD = ctx.columnData(cx, cz);
    fillTerrain(blocks, cx, cz, colD);
    carveCheese(ctx, blocks, cx, cz, colD);
    carveWorms(ctx, blocks, cx, cz);
    lavaFlood(blocks);
    placeOresAndPockets(ctx, blocks, cx, cz);
    // 11-END step 6.5 — rasterize the stronghold (after ores, before decoration).
    // `states` carries end_portal_frame facing/eye nibbles into the chunk.
    const states = new Uint8Array(32768);
    const spawns = rollHerd(ctx, cx, cz);
    stronghold.stampChunk(blocks, cx, cz, spawns, states);
    const village = decorate(ctx, blocks, cx, cz, colD);   // 12-VILLAGES: stamps + meta
    const heightMap = computeHeightMap(blocks);
    const biomes = Uint8Array.from(colD.biome);         // copy: cache stays live
    if (village?.spawns?.length) for (const s of village.spawns) spawns.push(s);
    return { blocks, heightMap, biomes, states, spawns, villageMeta: village?.villageMeta ?? null };
  }

  // 02 §12 — world spawn: rings of 8-block steps out to radius 256
  function* ringPositions(R, step) {
    if (R === 0) { yield [0, 0]; return; }
    for (let z = -R; z < R; z += step) yield [R, z];    // start (R, −R), CCW
    for (let x = R; x > -R; x -= step) yield [x, R];
    for (let z = R; z > -R; z -= step) yield [-R, z];
    for (let x = -R; x < R; x += step) yield [x, -R];
  }

  function findWorldSpawn() {
    for (let ring = 0; ring <= 32; ring++) {
      for (const [x, z] of ringPositions(ring * 8, 8)) {
        const h = ctx.heightAt(x, z), b = ctx.biomeAt(x, z);
        if (h < 64 || h > 90) continue;
        if (b === BIOMES.OCEAN || b === BIOMES.RIVER || b === BIOMES.BEACH) continue;
        if (ctx.surfaceBlockOf(x, z) !== ID.grass_block) continue;
        return { x: x + 0.5, y: h + 1, z: z + 0.5 };
      }
    }
    return { x: 0.5, y: ctx.heightAt(0, 0) + 1, z: 0.5 };
  }

  return {
    worldSeed,
    generateChunk,
    findWorldSpawn,
    heightAt: ctx.heightAt,
    biomeAt: ctx.biomeAt,
  };
}
