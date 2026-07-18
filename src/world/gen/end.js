// 11-END §6/§8 — the End generator (dim 2). Pure, deterministic per (seed,cx,cz),
// worker-importable (no registry/DOM). Native Y 0-127. No bedrock floor, no water,
// no lava, no weather; biomes[] = 11 (the_end); skyLight stays 0 (dim descriptor).
//
// Block ids hardcoded (worker can't import the registry):
//   air 0, bedrock 17, obsidian 33, end_stone 154, iron_bars 153,
//   chorus_plant 159, chorus_flower 160.

import { hashString, splitmix32, chunkSeed, mix32 } from '../../math/rng.js';
import { endPillars } from './endShared.js';
import { fbm2, smoothstep, outerColumn } from './endSurface.js';
import { generateEndCity } from './endCity.js';

const AIR = 0, BEDROCK = 17, OBSIDIAN = 33, IRON_BARS = 153;
const END_STONE = 154, CHORUS_PLANT = 159, CHORUS_FLOWER = 160;
const THE_END = 11;   // biome id

const idx = (x, y, z) => (y << 8) | ((z & 15) << 4) | (x & 15);
const sub = (ws, name) => mix32(ws ^ hashString('end:' + name));

export function createEndGenerator(seed) {
  const worldSeed = typeof seed === 'number' ? (seed >>> 0) : hashString(String(seed ?? ''));
  const s = {
    shape: sub(worldSeed, 'shape'), top: sub(worldSeed, 'top'), bot: sub(worldSeed, 'bot'),
    outer: sub(worldSeed, 'outer'), outerT: sub(worldSeed, 'outer_t'), chorus: sub(worldSeed, 'chorus'),
    city: sub(worldSeed, 'endcity'),
  };
  const pillars = endPillars(worldSeed);

  // §6.1 — a single main-island column: returns {surfY, botY} or null (void).
  function mainColumn(x, z) {
    const d = Math.hypot(x, z);
    if (d > 130) return null;
    const shape = fbm2(s.shape, x, z, 4, 1 / 170);
    const falloff = 1 - smoothstep(60, 100, d + shape * 18);
    if (falloff <= 0) return null;
    let surfY = Math.round(60 + 5 * falloff + 4 * fbm2(s.top, x, z, 3, 1 / 55));
    const botY = Math.round(surfY - (5 + 34 * falloff + 8 * (0.5 + 0.5 * fbm2(s.bot, x, z, 3, 1 / 40))));
    // exit-portal terrain override: force the fountain proud of the terrain (§6.1).
    if (d <= 4) surfY = 62;
    return { surfY, botY: Math.max(0, botY) };
  }

  function generateChunk(cx, cz) {
    const blocks = new Uint8Array(32768);
    const biomes = new Uint8Array(256);
    const heightMap = new Uint8Array(256);
    const spawns = [];
    const set = (x, y, z, id) => { if (x >= 0 && x < 16 && z >= 0 && z < 16 && y >= 0 && y <= 127) blocks[idx(x, y, z)] = id; };
    const get = (x, y, z) => (x >= 0 && x < 16 && z >= 0 && z < 16 && y >= 0 && y <= 127 ? blocks[idx(x, y, z)] : AIR);
    biomes.fill(THE_END);

    // 1. terrain columns (main island near origin, outer belt far out, void between)
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const wx = cx * 16 + lx, wz = cz * 16 + lz;
        const d = Math.hypot(wx, wz);
        let col = null;
        if (d <= 130) col = mainColumn(wx, wz);
        else if (d >= 1000) col = outerColumn(s, wx, wz, d);
        if (col) for (let y = col.botY; y <= col.surfY; y++) set(lx, y, lz, END_STONE);
      }
    }

    // 2. obsidian pillars (§6.3) — clip each to this chunk
    for (const p of pillars) buildSpike(p, blocks, cx, cz);

    // 3. exit portal statics, dormant (§6.4) — near origin only
    if (Math.abs(cx) <= 1 && Math.abs(cz) <= 1) buildExitPortal(blocks, cx, cz);

    // 4. chorus plants on outer islands (§8.2, simplified — see DEVIATIONS). `states`
    //    carries the flower age nibble so worldgen chorus is static age-5 (fully grown).
    const states = new Uint8Array(32768);
    if (Math.hypot(cx * 16 + 8, cz * 16 + 8) > 1008) growChorus(s, blocks, states, cx, cz);

    // 5. end city (§12) — outer islands, region-seeded
    generateEndCity(s, blocks, cx, cz, spawns);

    // 6. heightmap
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        let h = 0;
        for (let y = 127; y >= 0; y--) { if (get(lx, y, lz) !== AIR) { h = y + 1; break; } }
        heightMap[(lz << 4) | lx] = h;
      }
    }
    return { blocks, heightMap, biomes, states, spawns };
  }

  return { generateChunk };
}

// §6.3 — one pillar: obsidian cylinder 0..H, bedrock cap, air H+1..H+10, cage.
function buildSpike(p, blocks, cx, cz) {
  const wx0 = cx * 16, wz0 = cz * 16;
  const set = (wx, y, wz, id) => {
    if ((wx >> 4) === cx && (wz >> 4) === cz && y >= 0 && y <= 127) blocks[(y << 8) | ((wz & 15) << 4) | (wx & 15)] = id;
  };
  const R = p.r, H = p.capY;
  // quick reject: pillar footprint must touch this chunk
  if (p.x + R + 2 < wx0 || p.x - R - 2 > wx0 + 15 || p.z + R + 2 < wz0 || p.z - R - 2 > wz0 + 15) {
    if (!p.caged) return;   // cage extends ±2 further; keep going only if caged
  }
  for (let dx = -R - 1; dx <= R + 1; dx++) {
    for (let dz = -R - 1; dz <= R + 1; dz++) {
      const wx = p.x + dx, wz = p.z + dz;
      if (dx * dx + dz * dz <= R * R + 1) {
        for (let y = 0; y < H; y++) set(wx, y, wz, OBSIDIAN);
        for (let y = H + 1; y <= H + 10; y++) set(wx, y, wz, AIR);
      }
    }
  }
  set(p.x, H, p.z, BEDROCK);   // single bedrock cap
  // §6.3 cage: 73 iron_bars (16×3 perimeter + 25 roof) at H..H+3
  if (p.caged) {
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const wx = p.x + dx, wz = p.z + dz;
      for (let y = H; y <= H + 3; y++) {
        const wall = (Math.abs(dx) === 2 || Math.abs(dz) === 2) && y < H + 3;
        const roof = y === H + 3;
        if (wall || roof) set(wx, y, wz, IRON_BARS);
      }
    }
  }
}

// §6.4 — exit portal ("end fountain"), generated dormant (portal cells stay AIR
// until 13 activates them). 12-bedrock rim + 4-tall column at (0,63,0).
function buildExitPortal(blocks, cx, cz) {
  const set = (wx, y, wz, id) => {
    if ((wx >> 4) === cx && (wz >> 4) === cz && y >= 0 && y <= 127) blocks[(y << 8) | ((wz & 15) << 4) | (wx & 15)] = id;
  };
  const EXIT_Y = 63;
  // 5×5 rim minus corners = 12 bedrock at y=63
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;   // skip corners
    if (Math.max(Math.abs(dx), Math.abs(dz)) === 2) set(dx, EXIT_Y, dz, BEDROCK);
  }
  // clear the 8 portal-bed cells (max(|x|,|z|)<=1 except center) — AIR until 13
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (dx || dz) set(dx, EXIT_Y, dz, AIR);
  // central bedrock column y 63-66
  for (let y = EXIT_Y; y <= EXIT_Y + 3; y++) set(0, y, 0, BEDROCK);
}

// §8.2 — chorus plants, simplified: a stem column with a few side branches and
// age-5 flowers at every tip. Full 16-iteration growth sim is cut (see DEVIATIONS);
// heights land in the wiki 5–22 range. Two attempts per chunk.
function growChorus(s, blocks, states, cx, cz) {
  const rng = splitmix32(chunkSeed(s.chorus, cx, cz));
  const get = (x, y, z) => (x >= 0 && x < 16 && z >= 0 && z < 16 && y >= 0 && y <= 127 ? blocks[idx(x, y, z)] : AIR);
  const set = (x, y, z, id) => { if (x >= 0 && x < 16 && z >= 0 && z < 16 && y >= 0 && y <= 127) blocks[idx(x, y, z)] = id; };
  // flowers write state 5 (fully grown, static — never age further, §8.2 wiki)
  const flower = (x, y, z) => { if (x >= 0 && x < 16 && z >= 0 && z < 16 && y >= 0 && y <= 127) { blocks[idx(x, y, z)] = CHORUS_FLOWER; states[idx(x, y, z)] = 5; } };
  for (let a = 0; a < 2; a++) {
    const lx = Math.floor(rng() * 16), lz = Math.floor(rng() * 16);
    // find an end_stone surface with 2 air above
    let surf = -1;
    for (let y = 100; y >= 40; y--) { if (get(lx, y, lz) === END_STONE && get(lx, y + 1, lz) === AIR && get(lx, y + 2, lz) === AIR) { surf = y; break; } }
    if (surf < 0) continue;
    const height = 5 + Math.floor(rng() * 12);   // 5-16
    let y = surf + 1;
    for (let h = 0; h < height && y <= 120; h++, y++) {
      set(lx, y, lz, CHORUS_PLANT);
      // occasional side branch → flower
      if (h >= 2 && h < height - 1 && rng() < 0.35) {
        const dir = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(rng() * 4)];
        const bx = lx + dir[0], bz = lz + dir[1];
        if (get(bx, y, bz) === AIR) { set(bx, y, bz, CHORUS_PLANT); flower(bx, y + 1, bz); }
      }
    }
    flower(lx, y, lz);   // age-5 cap flower
  }
}
