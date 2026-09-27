// B5 — dungeons, desert ruins and desert wells (19-BUILDOUT §B5).
// Architecture copied from the village stamper (12-VILLAGES §2): a structure is
// anchored to an ORIGIN chunk, its full layout is derived ONCE from that
// origin's dedicated seed stream, and every chunk the layout touches
// re-derives the identical plan and writes ONLY its own cells — so dungeons
// spanning chunk borders stamp deterministically from either side. Spawn
// records (spawner mob type + chest loot-table keys) attach to the chunk that
// physically contains the block, and Game.onChunkGenerated resolves them
// through configureSpawner/rollGenChest, exactly like village chests.
import { ID, BIOMES } from './biomes.js';
import { splitmix32, chunkSeed } from '../../math/rng.js';

// Per-origin structure chance. ~1 dungeon per 107 chunks (0.6 × 1/64), one
// desert ruin per ~256 desert chunks, one well per ~427.
const STRUCTURE_CHANCE = 1 / 64;

// Derive the plan for an origin chunk. Every rng draw happens HERE, in a fixed
// order, so re-deriving from a neighbouring chunk is byte-identical.
function planFor(ctx, ocx, ocz) {
  const rng = splitmix32(chunkSeed(ctx.seeds.dungeon, ocx, ocz));
  if (rng() >= STRUCTURE_CHANCE) return null;
  const kindRoll = rng();
  const kind = kindRoll < 0.60 ? 'dungeon' : kindRoll < 0.85 ? 'ruin' : 'well';

  if (kind === 'dungeon') {
    const w = 7 + 2 * Math.floor(rng() * 2);            // 7 or 9
    const d = 7 + 2 * Math.floor(rng() * 2);
    const ax = ocx * 16 + Math.floor(rng() * 16);
    const az = ocz * 16 + Math.floor(rng() * 16);
    const floorY = 8 + Math.floor(rng() * 30);          // floor blocks 8..37
    // interior air rows floorY+1..floorY+3, ceiling floorY+4; the spawner and
    // chests STAND ON the floor (at floorY+1) like vanilla dungeon rooms
    const top = floorY + 4;
    // must sit ≥ 5 blocks under the surface — never breaches into a cave roof
    // gap or daylight
    const surface = Math.max(
      ctx.heightAt(ax + (w >> 1), az + (d >> 1)),
      ctx.heightAt(ax, az), ctx.heightAt(ax + w - 1, az + d - 1));
    if (top >= surface - 5) return null;
    // depth bands pick the spawner's mob (with a coin-flip for variety)
    const band = floorY < 18 ? ['zombie', 'spider'] : floorY < 28 ? ['skeleton', 'zombie'] : ['spider', 'skeleton'];
    const mobType = band[Math.floor(rng() * 2)];
    const chestCount = 1 + (rng() < 0.5 ? 1 : 0);
    const mossyBias = 0.25 + rng() * 0.35;               // wall moss fraction
    const chests = [];
    for (let i = 0; i < chestCount; i++) {
      // against an interior wall row, never on the spawner column
      const cx2 = ax + 1 + Math.floor(rng() * (w - 2));
      const cz2 = (rng() < 0.5) ? az + 1 : az + d - 2;
      if (cx2 !== ax + (w >> 1) || cz2 !== az + (d >> 1)) chests.push([cx2, cz2]);
    }
    return { kind, w, d, ax, az, floorY, mobType, chests, mossyBias };
  }

  // surface structures are desert-only, on actual sand
  const ax = ocx * 16 + Math.floor(rng() * 16);
  const az = ocz * 16 + Math.floor(rng() * 16);
  const cx0 = ax + 2, cz0 = az + 2;                      // structure centre column
  if (ctx.biomeAt(cx0, cz0) !== BIOMES.DESERT) return null;
  const surface = ctx.heightAt(cx0, cz0);
  if (surface < 63 || ctx.surfaceBlockOf(cx0, cz0) !== ID.sand) return null;

  if (kind === 'ruin') {
    const crumble = 0.25 + rng() * 0.2;                  // fraction of missing wall cells
    const wallH = 2 + (rng() < 0.5 ? 1 : 0);
    const tnt = rng() < 0.25;                            // buried hazard under the chest
    return { kind, ax, az, surface, crumble, wallH, tnt };
  }
  return { kind, ax, az, surface };                      // well
}

export function stampDungeons(ctx, blocks, cx, cz) {
  const wx0 = cx * 16, wz0 = cz * 16;
  const spawns = [];
  // a 9×9 room / 5×5 ruin reaches at most 1 chunk past its origin — the ±1
  // scan mirrors the tree stream's reach discipline (02 §10.3)
  for (let ocx = cx - 1; ocx <= cx + 1; ocx++) {
    for (let ocz = cz - 1; ocz <= cz + 1; ocz++) {
      const plan = planFor(ctx, ocx, ocz);
      if (!plan) continue;
      if (plan.kind === 'dungeon') stampDungeonRoom(ctx, blocks, cx, cz, plan, spawns);
      else stampDesertStructure(ctx, blocks, cx, cz, plan, spawns);
    }
  }
  return { spawns };
}

// NOTE: the stamp functions below write directly with an explicit chunk-bounds
// test (the target chunk (cx,cz) is fixed per call).
function stampDungeonRoom(ctx, blocks, cx, cz, plan, spawns) {
  const wx0 = cx * 16, wz0 = cz * 16;
  const { w, d, ax, az, floorY, mobType, chests, mossyBias } = plan;
  const inChunk = (wx, wz) => wx >= wx0 && wx <= wx0 + 15 && wz >= wz0 && wz <= wz0 + 15;
  const idx = (wx, wy, wz) => (wy << 8) | ((wz & 15) << 4) | (wx & 15);
  const set = (wx, wy, wz, id) => {
    if (wy < 1 || wy > 127) return;
    const i = idx(wx, wy, wz);
    if (blocks[i] === ID.bedrock) return;              // never carve/stamp bedrock
    blocks[i] = id;
  };
  // wall/floor moss mix rides the DETAIL stream at the room's block anchor —
  // a distinct draw sequence from the plan stream (same seed would correlate
  // the moss with the room's dimensions), and deterministic from every
  // stamping chunk because the per-cell draw order is fixed.
  const mrng = splitmix32(chunkSeed(ctx.seeds.detail, ax, az));

  // the floor is the room's bottom layer; interior air sits ABOVE it
  for (let y = floorY; y <= floorY + 4; y++) {
    for (let x = ax; x < ax + w; x++) {
      for (let z = az; z < az + d; z++) {
        if (!inChunk(x, z)) continue;
        const onFloor = y === floorY;
        const isCeil = y === floorY + 4;
        const interior = y >= floorY + 1 && y <= floorY + 3;
        const onWall = (x === ax || x === ax + w - 1 || z === az || z === az + d - 1);
        if (onFloor || isCeil || onWall) {
          // structure shell: cobble blended with mossy by the plan's bias
          mrng();                                       // draw order fixed per cell
          const moss = mrng() < mossyBias;
          set(x, y, z, moss ? ID.mossy_cobblestone : ID.cobblestone);
        } else if (interior) {
          set(x, y, z, ID.air);                         // carve the interior
        }
      }
    }
  }
  // spawner stands on the floor at the room centre
  const scx = ax + (w >> 1), scz = az + (d >> 1);
  if (inChunk(scx, scz)) {
    set(scx, floorY + 1, scz, ID.spawner);
    spawns.push({ be: 'spawner', x: scx, y: floorY + 1, z: scz, mobType });
  }
  // chests stand on the floor against a wall row
  for (const [chx, chz] of chests) {
    if (!inChunk(chx, chz)) continue;
    set(chx, floorY + 1, chz, ID.chest);
    spawns.push({ be: 'chest', x: chx, y: floorY + 1, z: chz, loot: 'dungeon' });
  }
}

function stampDesertStructure(ctx, blocks, cx, cz, plan, spawns) {
  const wx0 = cx * 16, wz0 = cz * 16;
  const inChunk = (wx, wz) => wx >= wx0 && wx <= wx0 + 15 && wz >= wz0 && wz <= wz0 + 15;
  const set = (wx, wy, wz, id) => {
    if (wy < 1 || wy > 127) return;
    const i = (wy << 8) | ((wz & 15) << 4) | (wx & 15);
    if (blocks[i] === ID.bedrock) return;
    blocks[i] = id;
  };
  const mrng = splitmix32(chunkSeed(ctx.seeds.dungeon, plan.ax, plan.az, plan.kind));
  const S = ID.sandstone;

  if (plan.kind === 'ruin') {
    const { ax, az, surface, crumble, wallH, tnt } = plan;
    // floor slab + crumbling walls on the surface
    for (let x = ax; x < ax + 5; x++) {
      for (let z = az; z < az + 5; z++) {
        const edge = x === ax || x === ax + 4 || z === az || z === az + 4;
        if (inChunk(x, z)) set(x, surface, z, S);
        if (!edge) continue;
        for (let h = 1; h <= wallH; h++) {
          mrng();
          if (mrng() < crumble) continue;                // crumbled away
          if (inChunk(x, z)) set(x, surface + h, z, S);
        }
      }
    }
    const ccx = ax + 2, ccz = az + 2;
    if (inChunk(ccx, ccz)) {
      set(ccx, surface + 1, ccz, ID.chest);
      spawns.push({ be: 'chest', x: ccx, y: surface + 1, z: ccz, loot: 'desert_ruin' });
    }
    if (tnt && inChunk(ccx, ccz)) set(ccx, surface - 1, ccz, ID.tnt);   // buried hazard
    return;
  }

  // well: sandstone rim, 3×3 water pool one deep
  const { ax, az, surface } = plan;
  for (let x = ax; x < ax + 5; x++) {
    for (let z = az; z < az + 5; z++) {
      const edge = x === ax || x === ax + 4 || z === az || z === az + 4;
      if (!inChunk(x, z)) continue;
      if (edge) set(x, surface, z, S);
      else set(x, surface, z, ID.water);
    }
  }
}