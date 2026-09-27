// Canonical block registry (06 §2/§3 gameplay + light/render/physics tables,
// 01 §5 engine schema). Dense array indexed by block id 0–66.
//
// State-nibble conventions (documented here, consumed engine-wide):
//  - FACING (furnace bits0–1, door bits2–3, bed bits0–1):
//      0 = +Z (south), 1 = −X (west), 2 = −Z (north), 3 = +X (east)
//  - TORCH / LADDER wall states 1–4: value = direction the block FACES
//      (away from its support). Support cell = pos − WALL_DIR[state].
//      1 → faces +Z (support at z−1), 2 → faces −Z (support at z+1),
//      3 → faces +X (support at x−1), 4 → faces −X (support at x+1).
//      Torch state 0 = floor (support below).
//  - Door: bit0 = upper half, bit1 = open, bits2–3 = facing.
//  - Bed: bits0–1 = facing (head = foot + FACING_DIR), bit2 = part (1 = head).
//  - Crops: bits0–2 = stage 0–7. Farmland: bit3 = wet.
//  - Leaves: bit0 = persistent (player-placed). Cactus/cane: nibble = age 0–15.
//  - Fluids: bit3 = falling, bits0–2 = spread (source = state 0). (06 §6.1)
//  - Fire: nibble = age 0–15 (15 §1.1).
//
// ============================================================================
// THE BIT-7 CONTRACT — GLOBAL, FROZEN by 15-FIRE-WATERLOGGING §8. (AMENDS 06 §1)
// ============================================================================
//   bit 7 (0x80) of every voxel's `states` byte = WATERLOGGED. Owned by 15 for
//   every block in the game; NO other file may assign it.
//   Per-block nibble meanings occupy bits 0–3 ONLY. Bits 4–6 remain free.
//
//   Invariants every state consumer must honor:
//     * `states & 0x80` is meaningful only where BLOCKS[id].waterloggable.
//       setBlock CLEARS bit 7 whenever the new id is not waterloggable (§8).
//     * A bit-7 cell IS a water source for EVERY system: fluid spread, buckets,
//       swimming/drowning, light filtering, hydration, lava interaction,
//       infinite-source formation. Use isWaterCell/isWaterSource — never a bare
//       `id === B.WATER`.
//     * Nibble reads must mask: `state & 0x0F`. A bare `state === 0` test for
//       "fluid source" is WRONG on a waterlogged cell.
//     * Toggling bit 7 must run the light edit AND neighbor updates even though
//       the id is unchanged (AMENDS 01 §4.6/§4.2).
// ============================================================================
// 08 §5.6.3 — Fortune's drop math. fortune.js is a dependency-free LEAF on
// purpose: importing items/effects.js here would cycle back through
// enchants.js → items.js → blocks.js, and items.js builds block-items by
// walking BLOCKS at module-eval time — it would see an empty array.
import { fortuneM, fortuneChance } from '../items/fortune.js';

export const WATERLOGGED = 0x80;
export const STATE_NIBBLE = 0x0F;

/** 15 §11.1 — the cell contains water (real water, or a waterlogged block). */
export const isWaterCellAt = (id, state) => id === B.WATER || (state & WATERLOGGED) !== 0;

/** 15 §11.1 — the cell is a water SOURCE (nibble 0 water, or any bit-7 cell). */
export const isWaterSourceAt = (id, state) =>
  (id === B.WATER && (state & STATE_NIBBLE) === 0) || (state & WATERLOGGED) !== 0;

/** 15 §13.3 — a soaked block is inert fuel: enc/burn read 0 regardless of table. */
export const effFireEnc = (id, state) => ((state & WATERLOGGED) ? 0 : (BLOCKS[id]?.fireEnc ?? 0));
export const effFireBurn = (id, state) => ((state & WATERLOGGED) ? 0 : (BLOCKS[id]?.fireBurn ?? 0));

export const FACING_DIR = [[0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 0]];
export const WALL_DIR = { 1: [0, 0, 1], 2: [0, 0, -1], 3: [1, 0, 0], 4: [-1, 0, 0] };
const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export const BLOCKS = [];
export const B = {};

// --- tile helpers: face order [+X, −X, +Y(top), −Y(bottom), +Z, −Z] ---
const all = t => [t, t, t, t, t, t];
const column = (top, side, bottom = top) => [side, side, top, bottom, side, side];

// --- drop helpers ---
const ri = (rng, a, b) => a + Math.floor(rng() * (b - a + 1));
const dropSelf = name => () => [{ name, count: 1 }];
const noDrop = () => [];

// Harvest gate per 06 §1: tier null → always; 'class' → correct class, any
// tier; number → correct class AND tier ≥ requirement.
export function harvestOK(block, toolClass, toolTier) {
  if (block.tier == null) return true;
  if (block.tier === 'class') return toolClass === block.tool;
  return toolClass === block.tool && (toolTier ?? -1) >= block.tier;
}
// Tagged so defBlock can tell an already-gated closure from a raw one and never
// double-wrap (the wrapper forwards `this` and the whole ctx, so wrapping is
// transparent to dropSelf / arrow closures alike).
const gated = fn => {
  const w = function (ctx) {
    return harvestOK(this, ctx.toolClass, ctx.toolTier) ? fn.call(this, ctx) : [];
  };
  w.__gated = true;
  return w;
};

// Leaves drop table A (06 §2)
// 08 §5.6.3 — Fortune raises the sapling / stick / apple rolls. (Silk Touch
// drops the leaf block itself and never reaches here — breakBlock overrides it.)
const leafDrops = (sapling, withApple) => function (ctx) {
  if (ctx.toolClass === 'shears') return [{ name: this.name, count: 1 }];
  const f = ctx.fortune ?? 0;
  const out = [];
  if (ctx.rng() < fortuneChance('sapling', f)) out.push({ name: sapling, count: 1 });
  if (ctx.rng() < fortuneChance('stick', f)) out.push({ name: 'stick', count: ri(ctx.rng, 1, 2) });
  if (withApple && ctx.rng() < fortuneChance('apple', f)) out.push({ name: 'apple', count: 1 });
  return out;
};

export function isSolidSupport(id) {          // solid top face (or glass) per 06 §5.2
  const b = BLOCKS[id];
  return !!b && (b.opaque || b.name === 'glass');
}

// --- shared behaviors ---

function leafDecayTick(world, x, y, z, state) {
  if (state & 1) return;                       // persistent (player-placed)
  const isLeaf = id => id >= B.OAK_LEAVES && id <= B.SPRUCE_LEAVES;
  const isLog = id => id >= B.OAK_LOG && id <= B.SPRUCE_LOG;
  const seen = new Set([x + ',' + y + ',' + z]);
  let frontier = [[x, y, z]];
  for (let d = 0; d < 4; d++) {                // BFS ≤ taxicab distance 4 (06 §5.12)
    const next = [];
    for (const [fx, fy, fz] of frontier) {
      for (const [dx, dy, dz] of DIRS6) {
        const nx = fx + dx, ny = fy + dy, nz = fz + dz;
        const key = nx + ',' + ny + ',' + nz;
        if (seen.has(key)) continue;
        seen.add(key);
        const id = world.getBlock(nx, ny, nz);
        if (isLog(id)) return;
        if (isLeaf(id)) next.push([nx, ny, nz]);
      }
    }
    frontier = next;
  }
  world.popBlock(x, y, z);
}

function saplingTick(world, x, y, z) {
  const lightAbove = Math.max(world.getSkyLight(x, y + 1, z), world.getBlockLight(x, y + 1, z));
  if (lightAbove >= 9 && world.rng() < 0.10)
    world.growTree(BLOCKS[world.getBlock(x, y, z)].species, x, y, z);
}

function cropTick(world, x, y, z, state) {
  const light = Math.max(world.getSkyLight(x, y, z), world.getBlockLight(x, y, z));
  if (light <= 7) { world.popBlock(x, y, z); return; }     // uproot (04 §10.3)
  const stage = state & 7;
  if (stage >= 7 || light < 9) return;
  const wet = (world.getState(x, y - 1, z) & 8) !== 0;
  if (world.rng() < (wet ? 1 / 5 : 1 / 9)) world.setState(x, y, z, stage + 1);
}

function cropNeighbor(world, x, y, z) {
  if (world.getBlock(x, y - 1, z) !== B.FARMLAND) world.popBlock(x, y, z);
}

function validCactus(world, x, y, z) {
  const below = world.getBlock(x, y - 1, z);
  if (below !== B.SAND && below !== B.CACTUS) return false;
  for (const [dx, , dz] of FACING_DIR)
    if (BLOCKS[world.getBlock(x + dx, y, z + dz)].collidable) return false;
  return true;
}

function validCane(world, x, y, z) {
  const below = world.getBlock(x, y - 1, z);
  if (below === B.SUGAR_CANE_BLOCK) return true;
  if (below !== B.GRASS_BLOCK && below !== B.DIRT && below !== B.SAND) return false;
  // AMENDS 06 §5.9 / 15 §13.4 — the same isWaterCell predicate as farmland: a
  // waterlogged fence beside the support block sustains cane.
  for (const [dx, , dz] of FACING_DIR)                     // water beside the SUPPORT block
    if (isWaterCellAt(world.getBlock(x + dx, y - 1, z + dz),
                      world.getState(x + dx, y - 1, z + dz))) return true;
  return false;
}

function columnGrowTick(world, x, y, z, state, valid, blockId) {
  if (!valid(world, x, y, z)) { world.popBlock(x, y, z); return; }
  if (state < 15) { world.setState(x, y, z, state + 1); return; }
  let h = 1;
  while (world.getBlock(x, y - h, z) === blockId) h++;
  if (h < 3 && world.getBlock(x, y + 1, z) === B.AIR)
    world.setBlock(x, y + 1, z, blockId, { state: 0 });
  world.setState(x, y, z, 0);
}

function farmlandTick(world, x, y, z, state) {
  let wet = false;
  outer:
  for (let dy = 0; dy <= 1 && !wet; dy++)
    for (let dx = -4; dx <= 4; dx++)
      for (let dz = -4; dz <= 4; dz++)
        // AMENDS 06 §5.11 / 15 §13.4 — the Chebyshev-4 moisture test uses
        // isWaterCell: a waterlogged fence irrigates crops just like water.
        if (isWaterCellAt(world.getBlock(x + dx, y + dy, z + dz),
                          world.getState(x + dx, y + dy, z + dz))) { wet = true; break outer; }
  const above = world.getBlock(x, y + 1, z);
  const hasCrop = above >= B.WHEAT_CROP && above <= B.POTATO_CROP;
  if (!wet && !hasCrop) { world.setBlock(x, y, z, B.DIRT); return; }
  // Preserve bit 7 (farmland is not waterloggable, so it is always clear here —
  // but masking the nibble keeps the write honest if that ever changes).
  const newState = (state & ~0x0F) | (state & 7) | (wet ? 8 : 0);
  if (newState !== state) world.setState(x, y, z, newState);
}

function grassTick(world, x, y, z) {
  const above = world.getBlock(x, y + 1, z);
  if (world.internalLight(x, y + 1, z) < 4 && BLOCKS[above].opacity > 0) {
    world.setBlock(x, y, z, B.DIRT);
    return;
  }
  const r = world.rng;
  const tx = x + ri(r, -1, 1), ty = y + ri(r, -1, 1), tz = z + ri(r, -1, 1);
  if (world.getBlock(tx, ty, tz) === B.DIRT
      && BLOCKS[world.getBlock(tx, ty + 1, tz)].opacity === 0
      && world.internalLight(tx, ty + 1, tz) >= 9)
    world.setBlock(tx, ty, tz, B.GRASS_BLOCK);
}

// Support-pop neighbor updates
const needsBelow = allowed => function (world, x, y, z) {
  if (!allowed.includes(world.getBlock(x, y - 1, z))) world.popBlock(x, y, z);
};

function torchNeighbor(world, x, y, z, state) {
  let sx = x, sy = y - 1, sz = z;
  if (state >= 1 && state <= 4) {
    const d = WALL_DIR[state & STATE_NIBBLE];
    sx = x - d[0]; sy = y; sz = z - d[2];
  }
  if (!isSolidSupport(world.getBlock(sx, sy, sz))) world.popBlock(x, y, z);
}

function ladderNeighbor(world, x, y, z, state) {
  // 15 §8: MASK the nibble. A waterlogged ladder is 0x81..0x84; WALL_DIR has
  // keys 1-4 only, so a raw lookup returns undefined and the ?? fallback
  // silently probes the WRONG wall — the ladder then pops itself.
  const d = WALL_DIR[state & STATE_NIBBLE] ?? WALL_DIR[1];
  if (!isSolidSupport(world.getBlock(x - d[0], y, z - d[2]))) world.popBlock(x, y, z);
}

// (15 AMENDS 06 §5.6 deleted the "adjacent fire primes TNT" handler that used to
// live here. TNT now primes only from flint & steel, an explosion, redstone, and
// fire's burn-out check consuming it — world/fire.js's tryBurn, burn odds 100.)

// Closed/open door collision panel (3/16 thick), shared by physics + mesher.
// Closed: panel sits on the cell edge OPPOSITE the facing direction (the edge
// the player stood on when placing). Open: rotated 90° CW onto the hinge side.
const T3 = 3 / 16;
export function doorBox(state) {
  const facing = (state >> 2) & 3, open = (state & 2) !== 0;
  const f = open ? (facing + 1) & 3 : facing;
  switch (f) {
    case 0: return [0, 0, 0, 1, 1, T3];        // faces +Z → panel at −Z edge
    case 1: return [1 - T3, 0, 0, 1, 1, 1];    // faces −X → panel at +X edge
    case 2: return [0, 0, 1 - T3, 1, 1, 1];    // faces −Z → panel at +Z edge
    default: return [0, 0, 0, T3, 1, 1];       // faces +X → panel at −X edge
  }
}

// --- definition helper ---
function defBlock(id, name, opts = {}) {
  const displayName = opts.displayName
    ?? name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const block = {
    id, name, displayName,
    shape: 'cube',
    bucket: 'opaque',
    opaque: true,
    collidable: true,
    targetable: true,
    renderSameIdFaces: false,
    emission: 0,
    opacity: 15,
    hardness: 0,
    blast: 0,
    tool: null,
    tier: null,
    gravity: false,
    climbable: false,
    slipperiness: 0.6,
    replaceable: false,
    fluid: null,
    fluidAlpha: 1.0,
    blockEntity: null,
    interactable: null,
    needsSupport: null,
    collisionBox: null,
    tiles: all(name),
    tilesFor: null,
    drops: dropSelf(name),
    xpForMine: null,
    randomTick: null,
    scheduledTick: null,
    neighborUpdate: null,
    onPlaced: null,
    onBroken: null,
    canPlaceAt: null,
    species: null,
    mat: 'none',                 // material class (16 §3.1); assigned below
    // --- 07-REDSTONE (AMENDS 01 §5) ---
    conductive: null,            // §3.2 — conducts power; null → default opaque&&cube (resolved below)
    occludes: null,              // AMENDS 01 §8.1 — seals a neighbour's flush face; null → resolved below
    onUse: null,                 // §6-§12 right-click handler (world,x,y,z,state,player,hit)
    onMoved: null,               // §6.6/§9 — fired when a piston moves this block
    emissionFor: null,           // state-dependent light (redstone_torch): (state) → 0..15
    // --- 15-FIRE-WATERLOGGING (AMENDS 01 §5) ---
    fireEnc: 0,                  // encouragement / ignite odds (15 §3, feeds §2.6)
    fireBurn: 0,                 // flammability / burn odds   (15 §3, feeds §2.5)
    lavaIgnite: false,           // participates in lava's fire-creation check (15 §4.2)
    waterloggable: false,        // may carry bit 7 (15 §9)
    infiniteBurn: false,         // eternal fire below (declared by 10, consumed 15 §2)
    ...opts,
  };
  // 07 §3.2 — default conductivity: a full opaque cube conducts unless the row
  // overrides. (Pistons/observer/redstone_block/hopper/glass/leaves opt out;
  // dispenser/dropper/note_block/lamp keep the default true.)
  if (block.conductive === null) block.conductive = block.opaque && block.shape === 'cube';
  // AMENDS 01 §8.1 — occlusion is a RENDER property, not a light one: only a
  // full-cube render seals a neighbour's flush face. farmland (15/16) and
  // soul_sand (14/16) keep Opac = O (06 §3 row 55 / 10 §1.1 row 119) but are
  // SHORT boxes, so ChunkMesher must not cull against them.
  if (block.occludes === null)
    block.occludes = block.opaque && block.shape !== 'farmland' && block.shape !== 'soul_sand';
  // 06 §1 — the harvest gate is a registry INVARIANT, not a per-row opt-in:
  // "Wrong/no tool → break at hand speed and (if a tier is required) drop
  // nothing." breakBlock/popBlock call drops() unconditionally, so the ONLY
  // place that can guarantee the rule for every row is here. Idempotent: rows
  // that already wrote `drops: gated(...)` carry the __gated tag.
  if (block.tier != null && !block.drops.__gated) block.drops = gated(block.drops);
  BLOCKS[id] = block;
  B[name.toUpperCase()] = id;
  return block;
}

// Non-solid cross-sprite defaults
const CROSS = {
  shape: 'cross', bucket: 'cutout', opaque: false, collidable: false,
  opacity: 0, hardness: 0, blast: 0,
};

// ============================== THE TABLE ==============================

defBlock(0, 'air', {
  shape: 'none', bucket: null, opaque: false, collidable: false,
  targetable: false, opacity: 0, hardness: -1, tiles: null, drops: noDrop,
  // 03 §16.2's replaceable set is {air, water, lava, fire, short_grass,
  // dandelion, poppy, dead_bush}. Without this, tryPlace's
  // `if (!BLOCKS[targetId].replaceable) return false` rejects EVERY placement
  // into empty space — RMB could only ever replace a flower.
  replaceable: true,
});

defBlock(1, 'stone', {
  hardness: 1.5, blast: 6.0, tool: 'pickaxe', tier: 0,
  drops: gated(() => [{ name: 'cobblestone', count: 1 }]),
});

defBlock(2, 'grass_block', {
  hardness: 0.6, blast: 0.6, tool: 'shovel',
  tiles: [ 'grass_side', 'grass_side', 'grass_top', 'dirt', 'grass_side', 'grass_side' ],
  tint: 'grass_top',      // OVERHAUL §B — +Y face carries the biome grass color
  drops: () => [{ name: 'dirt', count: 1 }],
  randomTick: grassTick,
});

defBlock(3, 'dirt', { hardness: 0.5, blast: 0.5, tool: 'shovel' });
defBlock(4, 'cobblestone', { hardness: 2.0, blast: 6.0, tool: 'pickaxe', tier: 0, drops: gated(dropSelf('cobblestone')) });
// B5 — dungeons stamp mossy cobble as their floor/wall blend; drops itself
defBlock(144, 'mossy_cobblestone', { hardness: 2.0, blast: 6.0, tool: 'pickaxe', tier: 0, drops: gated(dropSelf('mossy_cobblestone')) });
defBlock(5, 'oak_planks', { hardness: 2.0, blast: 3.0, tool: 'axe' });
defBlock(6, 'birch_planks', { hardness: 2.0, blast: 3.0, tool: 'axe' });
defBlock(7, 'spruce_planks', { hardness: 2.0, blast: 3.0, tool: 'axe' });

for (const [id, wood] of [[8, 'oak'], [9, 'birch'], [10, 'spruce']])
  defBlock(id, `${wood}_log`, {
    hardness: 2.0, blast: 2.0, tool: 'axe', species: wood,
    tiles: column(`${wood}_log_top`, `${wood}_log_side`),
  });

for (const [id, wood, apple] of [[11, 'oak', true], [12, 'birch', false], [13, 'spruce', false]])
  defBlock(id, `${wood}_leaves`, {
    hardness: 0.2, blast: 0.2, tool: 'shears', species: wood,
    opaque: false, opacity: 1, bucket: 'cutout', renderSameIdFaces: true,
    tint: 'foliage',        // OVERHAUL §B — every face carries the biome foliage color
    drops: leafDrops(`${wood}_sapling`, apple),
    randomTick: leafDecayTick,
  });

for (const [id, wood] of [[14, 'oak'], [15, 'birch'], [16, 'spruce']])
  defBlock(id, `${wood}_sapling`, {
    ...CROSS, species: wood, needsSupport: 'below',
    randomTick: saplingTick,
    neighborUpdate: needsBelow([2, 3]),
    canPlaceAt: (world, x, y, z) => [B.GRASS_BLOCK, B.DIRT].includes(world.getBlock(x, y - 1, z)),
  });

defBlock(17, 'bedrock', { hardness: -1, blast: 3600000, drops: noDrop });

defBlock(18, 'sand', { hardness: 0.5, blast: 0.5, tool: 'shovel', gravity: true });

defBlock(19, 'gravel', {
  hardness: 0.6, blast: 0.6, tool: 'shovel', gravity: true,
  // 08 §5.6.3 — flint chance 10% → 14.29% (I) / 25% (II) / 100% (III).
  drops: ctx => (ctx.rng() < fortuneChance('flint', ctx.fortune ?? 0)
    ? [{ name: 'flint', count: 1 }] : [{ name: 'gravel', count: 1 }]),
});

defBlock(20, 'sandstone', {
  hardness: 0.8, blast: 0.8, tool: 'pickaxe', tier: 0,
  tiles: ['sandstone_side', 'sandstone_side', 'sandstone_top', 'sandstone_bottom', 'sandstone_side', 'sandstone_side'],
  drops: gated(dropSelf('sandstone')),
});

const ore = (id, name, tier, dropFn, xpFn) => defBlock(id, name, {
  hardness: 3.0, blast: 3.0, tool: 'pickaxe', tier,
  drops: gated(dropFn), xpForMine: xpFn,
});
// 08 §5.6.3 — coal/diamond/iron/gold take the M multiplier; lapis takes M on
// its 4–9 roll; redstone takes a uniform +randInt(0,L) bonus instead of M.
ore(21, 'coal_ore', 0, ctx => [{ name: 'coal', count: fortuneM(ctx.fortune ?? 0, ctx.rng) }],
  function (ctx) { return harvestOK(this, ctx.toolClass, ctx.toolTier) ? ri(ctx.rng, 0, 2) : 0; });
ore(22, 'iron_ore', 1, ctx => [{ name: 'raw_iron', count: fortuneM(ctx.fortune ?? 0, ctx.rng) }], null);
ore(23, 'gold_ore', 2, ctx => [{ name: 'raw_gold', count: fortuneM(ctx.fortune ?? 0, ctx.rng) }], null);
ore(24, 'diamond_ore', 2, ctx => [{ name: 'diamond', count: fortuneM(ctx.fortune ?? 0, ctx.rng) }],
  function (ctx) { return harvestOK(this, ctx.toolClass, ctx.toolTier) ? ri(ctx.rng, 3, 7) : 0; });
ore(25, 'redstone_ore', 2, ctx => [{ name: 'redstone', count: ri(ctx.rng, 4, 5) + ri(ctx.rng, 0, ctx.fortune ?? 0) }],
  function (ctx) { return harvestOK(this, ctx.toolClass, ctx.toolTier) ? ri(ctx.rng, 1, 5) : 0; });
ore(26, 'lapis_ore', 1, ctx => [{ name: 'lapis_lazuli', count: ri(ctx.rng, 4, 9) * fortuneM(ctx.fortune ?? 0, ctx.rng) }],
  function (ctx) { return harvestOK(this, ctx.toolClass, ctx.toolTier) ? ri(ctx.rng, 2, 5) : 0; });

defBlock(27, 'coal_block', { hardness: 5.0, blast: 6.0, tool: 'pickaxe', tier: 0, drops: gated(dropSelf('coal_block')) });
defBlock(28, 'iron_block', { hardness: 5.0, blast: 6.0, tool: 'pickaxe', tier: 1, drops: gated(dropSelf('iron_block')) });
defBlock(29, 'gold_block', { hardness: 3.0, blast: 6.0, tool: 'pickaxe', tier: 2, drops: gated(dropSelf('gold_block')) });
defBlock(30, 'diamond_block', { hardness: 5.0, blast: 6.0, tool: 'pickaxe', tier: 2, drops: gated(dropSelf('diamond_block')) });

defBlock(31, 'glass', {
  hardness: 0.3, blast: 0.3, opaque: false, opacity: 0, bucket: 'cutout',
  drops: noDrop,
});

// 10 §4.6 / §8.5 realizes 09 AMENDS 06 §2: glowstone drops 2–4 glowstone_dust,
// not itself — this is item 395's only survival source. Silk Touch still drops
// the block (effects.js SILK_SELF). Fortune takes redstone_ore's uniform-bonus
// form (08 §5.6.3) capped at 4 — 08's "Fortune never affects glowstone" row is
// scoped to the self-drop that 09/10 replaced.
defBlock(32, 'glowstone', {
  hardness: 0.3, blast: 0.3, emission: 15,
  drops: ctx => [{
    name: 'glowstone_dust',
    count: Math.min(4, ri(ctx.rng, 2, 4) + ri(ctx.rng, 0, ctx.fortune ?? 0)),
  }],
});

defBlock(33, 'obsidian', { hardness: 50, blast: 1200, tool: 'pickaxe', tier: 3, drops: gated(dropSelf('obsidian')) });

defBlock(34, 'crafting_table', {
  hardness: 2.5, blast: 2.5, tool: 'axe', interactable: 'crafting',
  tiles: ['crafting_table_side', 'crafting_table_side', 'crafting_table_top', 'oak_planks', 'crafting_table_side', 'crafting_table_side'],
});

// Furnace front by facing: face order [+X,−X,+Y,−Y,+Z,−Z]; facing f → face index
const FACING_FACE = [4, 1, 5, 0];
// 12 §12.1 — the top/side pair is a parameter: the blast furnace and the smoker
// have their own painted top/side tiles and must not borrow the furnace's.
const furnaceTiles = (front, top = 'furnace_top', side = 'furnace_side') => (state, face) => {
  if (face === 2 || face === 3) return top;
  return face === FACING_FACE[state & 3] ? front : side;
};
defBlock(35, 'furnace', {
  hardness: 3.5, blast: 3.5, tool: 'pickaxe', tier: 0,
  blockEntity: 'furnace', interactable: 'furnace',
  tiles: column('furnace_top', 'furnace_side'),
  tilesFor: furnaceTiles('furnace_front'),
  drops: gated(dropSelf('furnace')),
});
defBlock(36, 'furnace_lit', {
  displayName: 'Furnace',
  hardness: 3.5, blast: 3.5, tool: 'pickaxe', tier: 0, emission: 13,
  blockEntity: 'furnace', interactable: 'furnace',
  tiles: column('furnace_top', 'furnace_side'),
  tilesFor: furnaceTiles('furnace_front_lit'),
  drops: gated(() => [{ name: 'furnace', count: 1 }]),
});

defBlock(37, 'chest', {
  hardness: 2.5, blast: 2.5, tool: 'axe',
  opaque: false, opacity: 0,                    // 06 §3: Opac T, pass op
  blockEntity: 'chest', interactable: 'chest',
  tiles: ['chest_side', 'chest_side', 'chest_top', 'chest_top', 'chest_front', 'chest_side'],
  tilesFor: (state, face) => {
    if (face === 2 || face === 3) return 'chest_top';
    return face === FACING_FACE[state & 3] ? 'chest_front' : 'chest_side';
  },
});

defBlock(38, 'torch', {
  ...CROSS, shape: 'torch', emission: 14, needsSupport: 'attach',
  neighborUpdate: torchNeighbor,
  canPlaceAt: (world, x, y, z, state = 0) => {
    if (state >= 1 && state <= 4) {
      const d = WALL_DIR[state & STATE_NIBBLE];
      return isSolidSupport(world.getBlock(x - d[0], y, z - d[2]));
    }
    return isSolidSupport(world.getBlock(x, y - 1, z));
  },
});

defBlock(39, 'ladder', {
  ...CROSS, shape: 'ladder', hardness: 0.4, blast: 0.4, tool: 'axe',
  climbable: true, needsSupport: 'attach',
  neighborUpdate: ladderNeighbor,
  canPlaceAt: (world, x, y, z, state = 1) => {
    // 15 §8: MASK the nibble. A waterlogged ladder is 0x81..0x84; WALL_DIR has
  // keys 1-4 only, so a raw lookup returns undefined and the ?? fallback
  // silently probes the WRONG wall — the ladder then pops itself.
  const d = WALL_DIR[state & STATE_NIBBLE] ?? WALL_DIR[1];
    return isSolidSupport(world.getBlock(x - d[0], y, z - d[2]));
  },
});

defBlock(40, 'snow_layer', {
  shape: 'snow_layer', bucket: 'opaque', opaque: false, opacity: 0,
  collidable: false, hardness: 0.1, blast: 0.1, tool: 'shovel', tier: 'class',
  needsSupport: 'below', tiles: all('snow'),
  drops: gated(() => [{ name: 'snowball', count: 1 }]),
  randomTick: (world, x, y, z) => {
    if (world.getBlockLight(x, y, z) >= 12) world.removeBlock(x, y, z);
  },
  neighborUpdate: (world, x, y, z) => {
    if (!isSolidSupport(world.getBlock(x, y - 1, z))) world.popBlock(x, y, z);
  },
  canPlaceAt: (world, x, y, z) => isSolidSupport(world.getBlock(x, y - 1, z)),
});

defBlock(41, 'snow_block', {
  hardness: 0.2, blast: 0.2, tool: 'shovel', tier: 'class', tiles: all('snow'),
  drops: gated(() => [{ name: 'snowball', count: 4 }]),
});

defBlock(42, 'ice', {
  hardness: 0.5, blast: 0.5, tool: 'pickaxe',
  opaque: false, opacity: 1, bucket: 'water', slipperiness: 0.98,
  drops: noDrop,
  randomTick: (world, x, y, z) => {
    if (world.getBlockLight(x, y, z) >= 12) {
      const below = world.getBlock(x, y - 1, z);
      world.setBlock(x, y, z, BLOCKS[below].opaque ? B.WATER : B.AIR, { state: 0 });
    }
  },
  onBroken: (world, x, y, z) => {
    if (BLOCKS[world.getBlock(x, y - 1, z)].opaque)
      world.setBlock(x, y, z, B.WATER, { state: 0 });
  },
});

defBlock(43, 'cactus', {
  shape: 'cactus', bucket: 'cutout', opaque: false, opacity: 0,
  hardness: 0.4, blast: 0.4, collidable: true,
  collisionBox: [1 / 16, 0, 1 / 16, 15 / 16, 1, 15 / 16],
  tiles: column('cactus_top', 'cactus_side'),
  randomTick: (world, x, y, z, state) => columnGrowTick(world, x, y, z, state, validCactus, B.CACTUS),
  neighborUpdate: (world, x, y, z) => { if (!validCactus(world, x, y, z)) world.popBlock(x, y, z); },
  canPlaceAt: validCactus,
});

defBlock(44, 'pumpkin', {
  hardness: 1.0, blast: 1.0, tool: 'axe',
  tiles: column('pumpkin_top', 'pumpkin_side'),
});

defBlock(45, 'jack_o_lantern', {
  displayName: "Jack o'Lantern",
  hardness: 1.0, blast: 1.0, tool: 'axe', emission: 15,
  // Simplification: glowing face shown on all 4 sides (no facing state)
  tiles: ['jack_o_lantern_front', 'jack_o_lantern_front', 'pumpkin_top', 'pumpkin_top', 'jack_o_lantern_front', 'jack_o_lantern_front'],
});

for (const [id, color] of [[46, 'white'], [47, 'red'], [48, 'blue'], [49, 'black']])
  defBlock(id, `wool_${color}`, {
    displayName: `${color[0].toUpperCase() + color.slice(1)} Wool`,
    hardness: 0.8, blast: 0.8, tool: 'shears',
  });

defBlock(50, 'bookshelf', {
  hardness: 1.5, blast: 1.5, tool: 'axe',
  tiles: column('oak_planks', 'bookshelf'),
  drops: () => [{ name: 'book', count: 3 }],
});

defBlock(51, 'tnt', {
  displayName: 'TNT',
  hardness: 0, blast: 0,
  // 15 AMENDS 06 §5.6 — NO neighborUpdate handler: an adjacent fire block must
  // not prime TNT. redstone/components.js composes its own hook on with
  // `prev?.(...)`, so a null base handler here is expected and safe.
  tiles: ['tnt_side', 'tnt_side', 'tnt_top', 'tnt_bottom', 'tnt_side', 'tnt_side'],
});

defBlock(52, 'oak_fence', {
  shape: 'fence', bucket: 'opaque', opaque: false, opacity: 0,
  hardness: 2.0, blast: 3.0, tool: 'axe',
  collisionBox: [0, 0, 0, 1, 1.5, 1],
  tiles: all('oak_planks'),
});

defBlock(53, 'oak_door', {
  shape: 'door', bucket: 'cutout', opaque: false, opacity: 0,
  hardness: 3.0, blast: 3.0, tool: 'axe',
  collisionBox: 'door', interactable: 'door',
  tiles: all('oak_door_lower'),
  tilesFor: state => ((state & 1) ? 'oak_door_upper' : 'oak_door_lower'),
  drops(ctx) { return (ctx.state & 1) ? [] : [{ name: 'oak_door', count: 1 }]; },
  neighborUpdate: (world, x, y, z, state) => {
    if (!(state & 1) && !isSolidSupport(world.getBlock(x, y - 1, z)))
      world.popBlock(x, y, z);
  },
  onBroken: (world, x, y, z, state) => {
    if (state & 1) {                            // upper broken → pop lower (drops the item)
      if (world.getBlock(x, y - 1, z) === B.OAK_DOOR) world.popBlock(x, y - 1, z);
    } else if (world.getBlock(x, y + 1, z) === B.OAK_DOOR) {
      world.removeBlock(x, y + 1, z);           // lower drops; upper removed silently
    }
  },
});

defBlock(54, 'bed_block', {
  displayName: 'Bed',
  shape: 'bed', bucket: 'opaque', opaque: false, opacity: 0,
  hardness: 0.2, blast: 0.2,
  collisionBox: [0, 0, 0, 1, 0.5625, 1], interactable: 'bed',
  tiles: ['bed_side', 'bed_side', 'bed_foot_top', 'oak_planks', 'bed_side', 'bed_side'],
  tilesFor: (state, face) => {
    if (face === 2) return (state & 4) ? 'bed_head_top' : 'bed_foot_top';
    if (face === 3) return 'oak_planks';
    return 'bed_side';
  },
  drops(ctx) { return (ctx.state & 4) ? [] : [{ name: 'bed', count: 1 }]; },
  neighborUpdate: (world, x, y, z) => {
    if (!isSolidSupport(world.getBlock(x, y - 1, z))) world.popBlock(x, y, z);
  },
  onBroken: (world, x, y, z, state) => {
    const d = FACING_DIR[state & 3];
    if (state & 4) {                            // head broken → pop foot (drops the item)
      const fx = x - d[0], fz = z - d[2];
      if (world.getBlock(fx, y, fz) === B.BED_BLOCK) world.popBlock(fx, y, fz);
    } else {                                    // foot drops; head removed silently
      const hx = x + d[0], hz = z + d[2];
      if (world.getBlock(hx, y, hz) === B.BED_BLOCK) world.removeBlock(hx, y, hz);
    }
  },
});

defBlock(55, 'farmland', {
  shape: 'farmland', hardness: 0.6, blast: 0.6, tool: 'shovel',
  collisionBox: [0, 0, 0, 1, 15 / 16, 1],
  tiles: ['dirt', 'dirt', 'farmland_dry', 'dirt', 'dirt', 'dirt'],
  tilesFor: (state, face) => (face === 2 ? ((state & 8) ? 'farmland_wet' : 'farmland_dry') : 'dirt'),
  drops: () => [{ name: 'dirt', count: 1 }],
  randomTick: farmlandTick,
});

const cropDef = (id, name, tiles, dropsFn) => defBlock(id, name, {
  ...CROSS, shape: 'hash', needsSupport: 'below',
  tiles: all(`${tiles}_0`),
  tilesFor: state => {
    const stage = state & 7;
    return tiles === 'wheat' ? `wheat_${stage}` : `${tiles}_${stage >> 1}`;
  },
  drops: dropsFn,
  randomTick: cropTick,
  neighborUpdate: cropNeighbor,
  canPlaceAt: (world, x, y, z) => world.getBlock(x, y - 1, z) === B.FARMLAND,
});
// 08 §5.6.3 — mature wheat: seeds 0–(3+L) (approx of Java's binomial n=3+L,
// p=0.57); the wheat count itself is unaffected by Fortune.
cropDef(56, 'wheat_crop', 'wheat', ctx =>
  (ctx.state & 7) >= 7
    ? [{ name: 'wheat', count: 1 },
       { name: 'wheat_seeds', count: ri(ctx.rng, 0, 3 + (ctx.fortune ?? 0)) }]
    : [{ name: 'wheat_seeds', count: 1 }]);
// 08 §5.6.3 — mature carrot/potato: 2–(5+L) (approx).
cropDef(57, 'carrot_crop', 'carrot', ctx =>
  [{ name: 'carrot', count: (ctx.state & 7) >= 7 ? ri(ctx.rng, 2, 5 + (ctx.fortune ?? 0)) : 1 }]);
cropDef(58, 'potato_crop', 'potato', ctx =>
  [{ name: 'potato', count: (ctx.state & 7) >= 7 ? ri(ctx.rng, 2, 5 + (ctx.fortune ?? 0)) : 1 }]);

defBlock(59, 'sugar_cane_block', {
  ...CROSS, displayName: 'Sugar Cane', tiles: all('sugar_cane'), needsSupport: 'below',
  drops: () => [{ name: 'sugar_cane', count: 1 }],
  randomTick: (world, x, y, z, state) => columnGrowTick(world, x, y, z, state, validCane, B.SUGAR_CANE_BLOCK),
  neighborUpdate: (world, x, y, z) => { if (!validCane(world, x, y, z)) world.popBlock(x, y, z); },
  canPlaceAt: validCane,
});

defBlock(60, 'short_grass', {
  ...CROSS, tool: 'shears', replaceable: true, needsSupport: 'below',
  // 08 §5.6.3 — seeds 12.5% → 14.29% / 16.67% / 25%.
  drops: ctx => (ctx.toolClass === 'shears'
    ? [{ name: 'short_grass', count: 1 }]
    : (ctx.rng() < fortuneChance('seeds', ctx.fortune ?? 0)
      ? [{ name: 'wheat_seeds', count: 1 }] : [])),
  neighborUpdate: needsBelow([2, 3]),
  canPlaceAt: (world, x, y, z) => [B.GRASS_BLOCK, B.DIRT].includes(world.getBlock(x, y - 1, z)),
});

for (const [id, name] of [[61, 'dandelion'], [62, 'poppy']])
  defBlock(id, name, {
    ...CROSS, replaceable: true, needsSupport: 'below',
    neighborUpdate: needsBelow([2, 3]),
    canPlaceAt: (world, x, y, z) => [B.GRASS_BLOCK, B.DIRT].includes(world.getBlock(x, y - 1, z)),
  });

defBlock(63, 'water', {
  shape: 'liquid', bucket: 'water', opaque: false, opacity: 1,
  collidable: false, targetable: false, hardness: -1, blast: 100,
  fluid: 'water', fluidAlpha: 0.7, drops: noDrop,
  replaceable: true,            // 03 §16.2 replaceable set
});

defBlock(64, 'lava', {
  shape: 'liquid', bucket: 'water', opaque: false, opacity: 15,
  collidable: false, targetable: false, hardness: -1, blast: 100,
  emission: 15, fluid: 'lava', fluidAlpha: 1.0, drops: noDrop,
  replaceable: true,            // 03 §16.2 replaceable set
  // AMENDS 06 §17: lava gets a random tick — the fire-creation attempt (15 §4.2).
  // Both source and flowing cells (01 §6.2 dispatches randomTick by id).
  randomTick: (world, x, y, z) => world.lavaFireAttempt?.(x, y, z),
});

// Fire — superseded by 15 §1–§7. (AMENDS 06 §5.14: the whole "Fire (minimal)"
// subsection and its "fire never spreads" adaptation are deleted.)
// State nibble = age 0–15 (15 §1.1). Bit 7 is NEVER set on fire: water destroys
// it, so it can never be waterlogged.
defBlock(65, 'fire', {
  ...CROSS, emission: 15, replaceable: true, drops: noDrop,
  // AMENDS 06 §5.6: fire no longer primes adjacent TNT on placement. TNT is
  // primed only when fire's burn-out check CONSUMES it (15 §2.5, burn odds 100).
  onPlaced: (world, x, y, z) => {
    world.scheduleTick(x, y, z, 30 + Math.floor(Math.random() * 10));   // 15 §2
  },
  scheduledTick: (world, x, y, z, state) => world.fireTick?.(x, y, z, state),
  // 15 §1.3 — any neighbor change re-checks canSurvive; failure removes the fire
  // immediately (no drop). canSurvive is solidTopBelow OR anyFlammableNeighbor,
  // so fire can legitimately float against a flammable wall — the old
  // isSolidSupport-only test killed exactly that case.
  neighborUpdate: (world, x, y, z) => world.fireNeighborUpdate?.(x, y, z),
});

defBlock(66, 'dead_bush', {
  ...CROSS, tool: 'shears', replaceable: true, needsSupport: 'below',
  drops: ctx => (ctx.toolClass === 'shears'
    ? [{ name: 'dead_bush', count: 1 }]
    : (() => { const n = ri(ctx.rng, 0, 2); return n ? [{ name: 'stick', count: n }] : []; })()),
  neighborUpdate: needsBelow([18, 3]),
  canPlaceAt: (world, x, y, z) => [B.SAND, B.DIRT].includes(world.getBlock(x, y - 1, z)),
});

// =========================================================================
// 07-REDSTONE §13 — blocks 70–89. (90–104 reserved, unused.)
//
// Logic handlers (neighborUpdate / scheduledTick / onUse / onPlaced / onBroken /
// onMoved) are attached at runtime by src/redstone/components.js via
// installComponentHooks(), so this file stays a leaf. Here we declare only the
// static shape/render/physics/registry data (§13.1/§13.2) and the `conductive`
// overrides (§3.2). Non-cube shapes join the mesher's custom-shape list.
// =========================================================================

// A supported, non-collidable, cutout component (torch/lever/button/plate/wire).
const RS_ATTACH = { bucket: 'cutout', opaque: false, opacity: 0, collidable: false, hardness: 0, blast: 0 };

defBlock(70, 'redstone_wire', {
  ...RS_ATTACH, shape: 'wire', needsSupport: 'below',
  drops: () => [{ name: 'redstone', count: 1 }],
  // §4.5/§14 — 16 power-tinted variants of each dust tile live in the atlas as
  // dust_dot_<p> / dust_line_<p>; `tiles` names the unlit (p = 0) line as the
  // static fallback every non-state consumer (icons, item entities) reads.
  // tileIndexFor's cache key is ((state & 15) << 3) | face — the power nibble
  // exactly — so one cached entry per power is correct and complete. The mesher
  // does NOT go through here: a dust cell needs BOTH families on one face, so
  // emitDust reads the atlas tables directly (§4.5 quad composition).
  tiles: all('dust_line_0'),
  tilesFor: st => 'dust_line_' + (st & 0x0f),
  // §4.5 — lit dust has a 1/8 chance per random-cosmetic frame of one red
  // particle. 01 §6.2's random tick is the engine's only per-block random
  // cosmetic pass, so it is the frame this rolls on. Math.random() per 15 §1
  // (cosmetic RNG must never draw from the seeded world.rng stream).
  randomTick: (world, x, y, z, state) => {
    if ((state & 0x0f) === 0 || Math.random() >= 0.125) return;
    world.game?.particles?.redstoneSpark?.(
      x + 0.25 + Math.random() * 0.5, y + 1 / 16, z + 0.25 + Math.random() * 0.5);
  },
});

defBlock(71, 'redstone_torch', {
  ...RS_ATTACH, shape: 'torch', needsSupport: 'attach',
  emissionFor: st => ((st & 0x08) ? 7 : 0),      // §6.4 light 7 while lit
  tiles: all('redstone_torch'),
  tilesFor: st => ((st & 0x08) ? 'redstone_torch' : 'redstone_torch_off'),
});

defBlock(72, 'lever', {
  ...RS_ATTACH, hardness: 0.5, blast: 0.5, shape: 'lever', needsSupport: 'attach',
  interactable: 'redstone', tiles: all('lever'),
});

defBlock(73, 'stone_button', {
  ...RS_ATTACH, hardness: 0.5, blast: 0.5, shape: 'button', needsSupport: 'attach',
  interactable: 'redstone', tiles: all('stone_button'),
});
defBlock(74, 'wooden_button', {
  ...RS_ATTACH, hardness: 0.5, blast: 0.5, tool: 'axe', shape: 'button', needsSupport: 'attach',
  interactable: 'redstone', tiles: all('wooden_button'),
});

defBlock(75, 'stone_pressure_plate', {
  ...RS_ATTACH, hardness: 0.5, blast: 0.5, tool: 'pickaxe', tier: 0,
  shape: 'plate', needsSupport: 'below', tiles: all('stone'),
});
defBlock(76, 'wooden_pressure_plate', {
  ...RS_ATTACH, hardness: 0.5, blast: 0.5, tool: 'axe',
  shape: 'plate', needsSupport: 'below', tiles: all('oak_planks'),
});

defBlock(77, 'repeater', {
  ...RS_ATTACH, shape: 'repeater', needsSupport: 'below',
  collidable: true, collisionBox: [0, 0, 0, 1, 2 / 16, 1],
  interactable: 'redstone',
  tiles: all('repeater_top'),
  tilesFor: (st, face) => (face === 2 ? 'repeater_top' : face === 3 ? 'smooth_stone_bottom' : 'smooth_stone_side'),
});
defBlock(78, 'comparator', {
  ...RS_ATTACH, shape: 'comparator', needsSupport: 'below',
  collidable: true, collisionBox: [0, 0, 0, 1, 2 / 16, 1],
  interactable: 'redstone',
  tiles: all('comparator_top'),
  tilesFor: (st, face) => (face === 2 ? 'comparator_top' : face === 3 ? 'smooth_stone_bottom' : 'smooth_stone_side'),
});

// Pistons (79/80): full-cube render, NOT conductive (§3.2). Face set by state.
const PISTON_TILES = (front) => (st, face) => {
  const f = st & 0x07;                                   // FACE6 head direction
  const FACE_TO_IDX = [3, 2, 5, 4, 1, 0];                // FACE6 → tile-array face index
  if (face === FACE_TO_IDX[f]) return (st & 0x08) ? 'piston_inner' : front;
  return 'piston_side';
};
defBlock(79, 'piston', {
  hardness: 1.5, blast: 1.5, tool: 'pickaxe', conductive: false,
  tiles: all('piston_side'), tilesFor: PISTON_TILES('piston_face'),
});
defBlock(80, 'sticky_piston', {
  hardness: 1.5, blast: 1.5, tool: 'pickaxe', conductive: false,
  tiles: all('piston_side'), tilesFor: PISTON_TILES('piston_face_sticky'),
});
defBlock(81, 'piston_head', {
  hardness: 1.5, blast: 1.5, tool: 'pickaxe', conductive: false,
  shape: 'piston_head', opaque: false, opacity: 0,
  drops: noDrop,                                          // §9.1 — breaking drops the base's item
  tiles: all('piston_face'),
  tilesFor: st => ((st & 0x08) ? 'piston_face_sticky' : 'piston_face'),
});

defBlock(82, 'observer', {
  hardness: 3.0, blast: 3.0, tool: 'pickaxe', tier: 0, conductive: false,
  tiles: all('observer_side'),
  tilesFor: (st, face) => {
    const f = st & 0x07;                                  // watched face
    const FACE_TO_IDX = [3, 2, 5, 4, 1, 0];
    if (face === FACE_TO_IDX[f]) return 'observer_face';
    if (face === FACE_TO_IDX[f ^ 1]) return 'observer_back';
    return 'observer_side';
  },
});

const CONTAINER_FACE = [3, 2, 5, 4, 1, 0];               // FACE6 → tile face index
defBlock(83, 'dispenser', {
  hardness: 3.5, blast: 3.5, tool: 'pickaxe', tier: 0,
  blockEntity: 'dispenser', interactable: 'container',
  tiles: all('dispenser_side'),
  tilesFor: (st, face) => (face === CONTAINER_FACE[st & 0x07] ? 'dispenser_front' : (face === 2 || face === 3 ? 'furnace_top' : 'dispenser_side')),
});
defBlock(84, 'dropper', {
  hardness: 3.5, blast: 3.5, tool: 'pickaxe', tier: 0,
  blockEntity: 'dropper', interactable: 'container',
  tiles: all('dispenser_side'),
  tilesFor: (st, face) => (face === CONTAINER_FACE[st & 0x07] ? 'dropper_front' : (face === 2 || face === 3 ? 'furnace_top' : 'dispenser_side')),
});

defBlock(85, 'hopper', {
  hardness: 3.0, blast: 4.8, tool: 'pickaxe', tier: 0, conductive: false,
  shape: 'hopper', opaque: false, opacity: 0,
  blockEntity: 'hopper', interactable: 'container',
  tiles: column('hopper_top', 'hopper_side', 'hopper_side'),
});

defBlock(86, 'redstone_lamp', {
  hardness: 0.3, blast: 0.3, tiles: all('redstone_lamp'),
});
defBlock(87, 'redstone_lamp_lit', {
  displayName: 'Redstone Lamp', hardness: 0.3, blast: 0.3, emission: 15,
  drops: () => [{ name: 'redstone_lamp', count: 1 }],
  tiles: all('redstone_lamp_lit'),
});

defBlock(88, 'note_block', {
  hardness: 0.8, blast: 0.8, tool: 'axe', interactable: 'redstone',
  tiles: all('note_block'),
});

defBlock(89, 'redstone_block', {
  hardness: 5.0, blast: 6.0, tool: 'pickaxe', tier: 0, conductive: false,
  tiles: all('redstone_block'),
});

// =======================================================================
// 08-ENCHANTING §2.2 — blocks 105–107. (108/109 reserved, unused by 08.)
//
// All three carry `interactable` (03 §16.1 step 2 opens their UI unless
// sneaking). Enchanting table and grindstone use state 0. The anvil's nibble is
// bits0–1 facing (visual only, set toward the player on place) + bits2–3 damage
// stage 0 pristine / 1 chipped / 2 damaged (stage 3 = destroyed, never stored).
// Bits 4–6 stay free; bit 7 remains 15's waterlogged flag — none of these three
// is waterloggable, so setBlock clears it for them (the bit-7 contract above).
// =======================================================================

defBlock(105, 'enchanting_table', {
  hardness: 5.0, blast: 1200, tool: 'pickaxe', tier: 0,
  interactable: 'enchanting',
  // §2.2: 12/16-height box + floating book. opaque F / opacity 0 so it neither
  // culls its neighbours' faces nor blocks light.
  shape: 'enchanting_table', bucket: 'cutout', opaque: false, opacity: 0,
  collisionBox: [0, 0, 0, 1, 12 / 16, 1],
  tiles: ['enchanting_table_side', 'enchanting_table_side', 'enchanting_table_top',
    'obsidian', 'enchanting_table_side', 'enchanting_table_side'],
});

defBlock(106, 'anvil', {
  hardness: 5.0, blast: 1200, tool: 'pickaxe', tier: 0,
  interactable: 'anvil',
  gravity: true,                                  // §8.6 falling anvil
  shape: 'anvil', bucket: 'cutout', opaque: false, opacity: 0,
  collisionBox: [0, 0, 0, 1, 1, 1],               // full cube (approx) per §2.2
  tiles: ['anvil_side', 'anvil_side', 'anvil_top_0', 'anvil_side', 'anvil_side', 'anvil_side'],
  // §2.2: the damage stage (bits2–3) only changes the top-face crack texture.
  // Stage 3 is "destroyed" and is never stored, so only 0–2 have tiles; clamp
  // rather than resolve a missing tile if a malformed state ever reaches here.
  tilesFor: (state, face) =>
    (face === 2 ? `anvil_top_${Math.min((state >> 2) & 3, 2)}` : 'anvil_side'),
  // §2.2: "self (damage stage NOT preserved — one anvil item; stage resets on
  // re-place)". dropSelf ignores state, so this IS the default — spelled out so
  // nobody later "fixes" it into a stage-preserving drop.
  drops: gated(dropSelf('anvil')),
});

defBlock(107, 'grindstone', {
  hardness: 2.0, blast: 6.0, tool: 'pickaxe', tier: 0,
  interactable: 'grindstone',
  shape: 'grindstone', bucket: 'cutout', opaque: false, opacity: 0,
  collisionBox: [0, 0, 0, 1, 1, 1],               // full cube (approx) per §2.2
  tiles: ['grindstone_side', 'grindstone_side', 'grindstone_tread', 'grindstone_tread',
    'grindstone_side', 'grindstone_side'],
});

// ===================== 09-POTIONS §7 — mushrooms + brewing stand =====================
// Mushrooms: CROSS plants that live on solid blocks in dark cave air (internalLight
// < 13), pop in bright light, and spread ~1/25 random tick under a 5-in-9×9×3 cap.
const mushroomSupport = (world, x, y, z) => isSolidSupport(world.getBlock(x, y - 1, z));
const mushroomCanPlace = (world, x, y, z) =>
  mushroomSupport(world, x, y, z) && world.internalLight(x, y, z) < 13;
const mushroomNeighbor = id => (world, x, y, z) => {
  if (!mushroomSupport(world, x, y, z) || world.internalLight(x, y, z) >= 13) world.popBlock(x, y, z);
};
// §7.1 — NO light test here: "vanilla checks light only on update, not random
// tick — a lit mushroom survives until something updates it; keep this quirk".
// The pop lives in mushroomNeighbor; mushroomCanPlace gates the spread target.
const mushroomTick = id => (world, x, y, z) => {
  if (world.rng() >= 1 / 25) return;                       // §7.4 slow spread
  let count = 0;                                            // 5-in-9×9×3 cap
  for (let dx = -4; dx <= 4; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -4; dz <= 4; dz++)
    if (world.getBlock(x + dx, y + dy, z + dz) === id && ++count >= 5) return;
  const tx = x + (world.rng() * 3 | 0) - 1, ty = y + (world.rng() * 3 | 0) - 1, tz = z + (world.rng() * 3 | 0) - 1;
  if (world.getBlock(tx, ty, tz) === B.AIR && mushroomCanPlace(world, tx, ty, tz)) world.setBlock(tx, ty, tz, id);
};
for (const [id, name, emission] of [[110, 'brown_mushroom', 1], [111, 'red_mushroom', 0]]) {
  defBlock(id, name, {
    ...CROSS, emission, needsSupport: 'below',
    drops: () => [{ name, count: 1 }],
    canPlaceAt: (world, x, y, z) => mushroomCanPlace(world, x, y, z),
    neighborUpdate: mushroomNeighbor(id),
    randomTick: mushroomTick(id),
    tiles: all(name),
  });
}
defBlock(112, 'brewing_stand', {
  hardness: 0.5, blast: 0.5, tool: 'pickaxe', tier: 0, emission: 1,
  shape: 'brewing_stand', bucket: 'cutout', opaque: false, opacity: 0,
  // §7.2: "No collision box (like torch)" — with stepHeight 0 a 2/16 kerb is
  // pure annoyance. `targetable` stays true, so the raycast + RMB path is intact.
  collidable: false,
  blockEntity: 'brewing', interactable: 'brewing',
  drops: gated(dropSelf('brewing_stand')),
  tiles: all('brewing_stand'),
});

// 10-NETHER §1.1 — blocks 115–143 (144–149 reserved). Behaviors (portal, crop,
// spawner, magma damage) are attached at runtime by world/nether.js so this
// file stays a leaf; here we declare static registry/render/physics data.
// =========================================================================

defBlock(115, 'netherrack', {
  hardness: 0.4, blast: 0.4, tool: 'pickaxe', tier: 0,
  infiniteBurn: true,                         // §10.4 — fire on netherrack burns forever
  tiles: all('netherrack'),
});
defBlock(116, 'nether_bricks', { hardness: 2.0, blast: 6.0, tool: 'pickaxe', tier: 0, tiles: all('nether_bricks') });
defBlock(117, 'nether_brick_fence', {
  hardness: 2.0, blast: 6.0, tool: 'pickaxe', tier: 0,
  shape: 'fence', opaque: false, opacity: 0, collisionBox: [0, 0, 0, 1, 1.5, 1],
  tiles: all('nether_bricks'),
});
defBlock(118, 'nether_brick_stairs', {
  hardness: 2.0, blast: 6.0, tool: 'pickaxe', tier: 0,
  shape: 'stairs', opaque: false, opacity: 0, collisionBox: [0, 0, 0, 1, 1, 1],
  tiles: all('nether_bricks'),
});
defBlock(119, 'soul_sand', {
  hardness: 0.5, blast: 0.5, tool: 'shovel',
  shape: 'soul_sand', collisionBox: [0, 0, 0, 1, 14 / 16, 1],   // §10.3 entities sink 2/16 + slow
  tiles: all('soul_sand'),
});
defBlock(120, 'soul_soil', { hardness: 0.5, blast: 0.5, tool: 'shovel', tiles: all('soul_soil') });
defBlock(121, 'magma_block', {
  hardness: 0.5, blast: 0.5, tool: 'pickaxe', tier: 0, emission: 3,
  infiniteBurn: true,                         // 15 §4.5 — fire above magma burns forever
  tiles: all('magma_block'),
});
ore(122, 'nether_quartz_ore', 0, () => [{ name: 'nether_quartz', count: 1 }],
  function (ctx) { return harvestOK(this, ctx.toolClass, ctx.toolTier) ? ri(ctx.rng, 2, 5) : 0; });
ore(123, 'nether_gold_ore', 0, ctx => [{ name: 'gold_nugget', count: ri(ctx.rng, 2, 6) }],
  function (ctx) { return harvestOK(this, ctx.toolClass, ctx.toolTier) ? ri(ctx.rng, 0, 1) : 0; });
defBlock(124, 'ancient_debris', {
  hardness: 30, blast: 1200, tool: 'pickaxe', tier: 3,   // diamond-tier to drop (§9)
  drops: gated(dropSelf('ancient_debris')), tiles: column('ancient_debris_top', 'ancient_debris_side'),
});
// nylium: drops netherrack (like grass→dirt); self only with Silk Touch (08)
const nylium = (id, name) => defBlock(id, name, {
  hardness: 0.4, blast: 0.4, tool: 'pickaxe', tier: 0,
  drops: ctx => [{ name: 'netherrack', count: 1 }],
  tiles: column(name, 'netherrack', 'netherrack'),   // §1.1: top/side/bottom=netherrack
});
nylium(125, 'crimson_nylium');
nylium(126, 'warped_nylium');
defBlock(127, 'crimson_stem', { hardness: 2.0, blast: 2.0, tool: 'axe', tiles: column('crimson_stem_top', 'crimson_stem') });
defBlock(128, 'warped_stem', { hardness: 2.0, blast: 2.0, tool: 'axe', tiles: column('warped_stem_top', 'warped_stem') });
defBlock(129, 'crimson_planks', { hardness: 2.0, blast: 3.0, tool: 'axe', tiles: all('crimson_planks') });
defBlock(130, 'warped_planks', { hardness: 2.0, blast: 3.0, tool: 'axe', tiles: all('warped_planks') });
defBlock(131, 'nether_wart_block', { hardness: 1.0, blast: 1.0, tool: 'hoe', tiles: all('nether_wart_block') });
defBlock(132, 'warped_wart_block', { hardness: 1.0, blast: 1.0, tool: 'hoe', tiles: all('warped_wart_block') });
defBlock(133, 'shroomlight', { hardness: 1.0, blast: 1.0, tool: 'hoe', emission: 15, tiles: all('shroomlight') });
defBlock(134, 'crimson_fungus', { ...CROSS, needsSupport: 'below', tiles: all('crimson_fungus') });
defBlock(135, 'warped_fungus', { ...CROSS, needsSupport: 'below', tiles: all('warped_fungus') });
defBlock(136, 'crimson_roots', { ...CROSS, needsSupport: 'below', tiles: all('crimson_roots') });
defBlock(137, 'warped_roots', { ...CROSS, needsSupport: 'below', tiles: all('warped_roots') });
// §8.1 nether_wart crop (no block-item; planted by item 390 on soul_sand). 4
// stages in bits0-1, rendered in 3 art stages.
defBlock(138, 'nether_wart', {
  ...CROSS, shape: 'hash', needsSupport: 'below',
  tiles: all('nether_wart_0'),
  // 4 growth stages (bits0-1) → 3 art stages: 0 → 0, 1-2 → 1, 3 → 2.
  tilesFor: state => { const s = state & 3; return `nether_wart_${s === 0 ? 0 : s === 3 ? 2 : 1}`; },
  drops: ctx => [{ name: 'nether_wart', count: (ctx.state & 3) >= 3 ? ri(ctx.rng, 2, 4) : 1 }],
  canPlaceAt: (world, x, y, z) => world.getBlock(x, y - 1, z) === B.SOUL_SAND,
});
defBlock(139, 'bone_block', { hardness: 2.0, blast: 2.0, tool: 'pickaxe', tier: 0, tiles: column('bone_block_top', 'bone_block_side') });
defBlock(140, 'nether_portal', {
  hardness: -1, blast: 0, emission: 11,
  shape: 'portal', bucket: 'translucent', opaque: false, opacity: 0, collidable: false, targetable: false,
  drops: noDrop, tiles: all('nether_portal'),
});
defBlock(141, 'spawner', {
  hardness: 5.0, blast: 5.0, tool: 'pickaxe', tier: 0, emission: 1,
  opaque: false, opacity: 0, shape: 'spawner', bucket: 'cutout',
  blockEntity: 'spawner', drops: noDrop,
  xpForMine: function (ctx) { return harvestOK(this, ctx.toolClass, ctx.toolTier) ? ri(ctx.rng, 15, 43) : 0; },
  tiles: all('spawner'),
});
defBlock(142, 'netherite_block', {
  hardness: 50, blast: 1200, tool: 'pickaxe', tier: 3, drops: gated(dropSelf('netherite_block')),
  tiles: all('netherite_block'),
});
defBlock(143, 'smithing_table', {
  hardness: 2.5, blast: 2.5, tool: 'axe', interactable: 'smithing',
  tiles: column('smithing_table_top', 'smithing_table_side'),
});

// ===================== 12-VILLAGES §7/§12 — village blocks (170–182) =====================
defBlock(170, 'dirt_path', {                       // §7.1 shovel-made; drops dirt; no block-item
  // §12.1 Opac column is `O` for every village block except composter/bell/
  // lectern/fletching_table, and §1.1 reuses the farmland shape — so dirt_path
  // matches farmland (55) exactly: opaque, opacity 15. Safe only because
  // defBlock now derives `occludes` from the SHAPE (AMENDS 01 §8.1), so a
  // 15/16 box never culls its neighbour's flush face.
  hardness: 0.6, blast: 0.6, tool: 'shovel', shape: 'farmland', opaque: true, opacity: 15,
  collisionBox: [0, 0, 0, 1, 15 / 16, 1],
  drops: () => [{ name: 'dirt', count: 1 }],
  tiles: column('dirt_path_top', 'dirt'),
  // §7.1 reversion — "on a neighbor/support update, if a solid or fluid occupies
  // the cell above -> revert to dirt (MC-exact 'path trampled')". The same
  // handler covers §7.1's second clause: a landing gravity block writes through
  // setBlock, which fans out neighbor updates into this cell.
  neighborUpdate: (world, x, y, z) => {
    const b = BLOCKS[world.getBlock(x, y + 1, z)];
    if (b && (b.collidable || b.fluid)) world.setBlock(x, y, z, B.DIRT, { state: 0 });
  },
});
defBlock(171, 'bell', {                            // §7.2 interactable; rings
  hardness: 5.0, blast: 5.0, tool: 'pickaxe', tier: 0, interactable: 'bell',
  shape: 'brewing_stand', opaque: false, opacity: 0, collisionBox: [4 / 16, 0, 4 / 16, 12 / 16, 1, 12 / 16],
  drops: gated(dropSelf('bell')), tiles: all('bell'),
});
defBlock(172, 'composter', {                       // §7.3 fill 0–8 in state nibble
  hardness: 0.6, blast: 0.6, tool: 'axe', fuel: 300, interactable: 'composter',
  // §12.1 render: Opac `T`, shape "14/16 hollow box" (floor + four walls; the
  // mesher owns the boxes). Pass stays `op`, exactly like the sibling bell row.
  // Knock-on per 07 §3.2: defBlock resolves conductive from opaque && cube, so
  // a hollow composter correctly stops conducting redstone.
  shape: 'composter', opaque: false, opacity: 0,
  drops: dropSelf('composter'), tiles: column('composter_top_0', 'composter_side_0'),
  // §7.3/§12.2 — the fill level 0–8 lives in the state nibble and MUST be
  // visible: without this the player gets no feedback between "just started"
  // and "one more item to READY". Face order is column()'s: 2 = top, 3 = bottom.
  tilesFor: (state, face) => {
    const lvl = Math.min(8, state & 15);
    return face === 2 ? 'composter_top_' + lvl
      : face === 3 ? 'composter_top_0'
        : 'composter_side_' + lvl;
  },
});
defBlock(173, 'barrel', {                          // §7.4 27-slot container
  hardness: 2.5, blast: 2.5, tool: 'axe', fuel: 300, blockEntity: 'chest', interactable: 'barrel',
  drops: dropSelf('barrel'), tiles: column('barrel_top', 'barrel_side'),
});
defBlock(174, 'lectern', {                         // §7.5 librarian workstation (no UI)
  hardness: 2.5, blast: 2.5, tool: 'axe', fuel: 300,
  // §12.1 render: Opac `T`, shape "12/16 slant desk" (base + desk box). The
  // book screen is out of scope (DEVIATIONS) — this is geometry/light only.
  shape: 'lectern', opaque: false, opacity: 0,
  drops: dropSelf('lectern'), tiles: column('lectern_top', 'lectern_side'),
});
defBlock(175, 'blast_furnace', {                   // §7.6 ore smelting 2×
  hardness: 3.5, blast: 3.5, tool: 'pickaxe', tier: 0, blockEntity: 'blast_furnace', interactable: 'furnace',
  drops: gated(() => [{ name: 'blast_furnace', count: 1 }]), tiles: column('blast_furnace_top', 'blast_furnace_side'),
  tilesFor: furnaceTiles('blast_furnace_front', 'blast_furnace_top', 'blast_furnace_side'),
});
defBlock(176, 'blast_furnace_lit', {
  displayName: 'Blast Furnace', hardness: 3.5, blast: 3.5, tool: 'pickaxe', tier: 0, emission: 13,
  blockEntity: 'blast_furnace', interactable: 'furnace',
  drops: gated(() => [{ name: 'blast_furnace', count: 1 }]), tiles: column('blast_furnace_top', 'blast_furnace_side'),
  tilesFor: furnaceTiles('blast_furnace_front_lit', 'blast_furnace_top', 'blast_furnace_side'),
});
defBlock(177, 'smoker', {                          // §7.7 food smelting 2×
  hardness: 3.5, blast: 3.5, tool: 'pickaxe', tier: 0, blockEntity: 'smoker', interactable: 'furnace',
  drops: gated(() => [{ name: 'smoker', count: 1 }]), tiles: column('smoker_top', 'smoker_side'),
  tilesFor: furnaceTiles('smoker_front', 'smoker_top', 'smoker_side'),
});
defBlock(178, 'smoker_lit', {
  displayName: 'Smoker', hardness: 3.5, blast: 3.5, tool: 'pickaxe', tier: 0, emission: 13,
  blockEntity: 'smoker', interactable: 'furnace',
  drops: gated(() => [{ name: 'smoker', count: 1 }]), tiles: column('smoker_top', 'smoker_side'),
  tilesFor: furnaceTiles('smoker_front_lit', 'smoker_top', 'smoker_side'),
});
defBlock(179, 'fletching_table', {                 // §7.8 fletcher workstation (no UI)
  hardness: 2.5, blast: 2.5, tool: 'axe', fuel: 300,
  drops: dropSelf('fletching_table'), tiles: column('fletching_table_top', 'fletching_table_side'),
});
defBlock(180, 'hay_bale', {                         // §7.9 fall ×0.2
  // §12.1 row 180 gives Tool `—`: no class matches, so it always breaks at hand
  // speed (a hoe must NOT get the ×8 multiplier).
  hardness: 0.5, blast: 0.5, drops: dropSelf('hay_bale'),
  tiles: column('hay_bale_top', 'hay_bale_side'),
});
ore(181, 'emerald_ore', 2,                          // §6.2 mountains worldgen; iron+ to drop
  ctx => [{ name: 'emerald', count: fortuneM(ctx.fortune ?? 0, ctx.rng) }],
  function (ctx) { return harvestOK(this, ctx.toolClass, ctx.toolTier) ? ri(ctx.rng, 3, 7) : 0; });
defBlock(182, 'emerald_block', {                   // §6.2 storage
  hardness: 5.0, blast: 6.0, tool: 'pickaxe', tier: 2, drops: gated(dropSelf('emerald_block')),
  tiles: all('emerald_block'),
});

// 11-END §8.4 — chorus flower growth (random tick, wiki-exact odds). age bits0-2.
function chorusGrow(world, x, y, z, state) {
  const age = state & 7;
  if (age >= 5 || world.getBlock(x, y + 1, z) !== 0) return;   // dead / capped never age
  let stem = 0;
  while (stem < 5 && world.getBlock(x, y - 1 - stem, z) === 159) stem++;
  const belowStem = world.getBlock(x, y - 1 - stem, z);
  const onEndStone = belowStem === 154;
  const branched = belowStem === 0;   // §8.4 — the stem hangs off a side arm
  const pUp = stem <= 1 ? 1.0 : stem === 2 ? (onEndStone ? 0.6 : 0.5)
    : stem === 3 ? (onEndStone ? 0.4 : 0.25) : (stem === 4 && onEndStone ? 0.2 : 0.0);
  const H4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const clearAbove = world.getBlock(x, y + 2, z) === 0 && H4.every(([dx, dz]) => world.getBlock(x + dx, y + 1, z + dz) === 0);
  if (world.rng() < pUp && clearAbove) {
    world.setBlock(x, y, z, 159);                        // this → plant
    world.setBlock(x, y + 1, z, 160, { state: age });    // above → flower (same age)
    return;
  }
  if (age < 4) {
    let grew = false;
    const tries = 1 + ((world.rng() * 4) | 0) - (branched ? 1 : 0);   // §8.4: 1-4 unbranched, 0-3 branched
    for (let t = 0; t < tries; t++) {
      const [dx, dz] = H4[(world.rng() * 4) | 0];
      const cx = x + dx, cz = z + dz;
      if (world.getBlock(cx, y, cz) === 0 && world.getBlock(cx, y - 1, cz) === 0 &&
          H4.filter(([ex, ez]) => !(ex === -dx && ez === -dz)).every(([ex, ez]) => world.getBlock(cx + ex, y, cz + ez) === 0)) {
        world.setBlock(cx, y, cz, 160, { state: age + 1 }); grew = true;
      }
    }
    if (grew) { world.setBlock(x, y, z, 159); return; }
  }
  world.setBlock(x, y, z, 160, { state: 5 });            // no growth → dead
}

// 11-END §8.5 — chorus support: a plant/flower survives iff the block below is
// end_stone or chorus_plant, OR a horizontal neighbor is chorus_plant. Otherwise
// it breaks (plant → 50% fruit, flower → nothing) and cascades via neighbor updates.
function chorusSupport(world, x, y, z) {
  const below = world.getBlock(x, y - 1, z);
  let ok = below === 154 || below === 159;   // end_stone / chorus_plant
  if (!ok) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (world.getBlock(x + dx, y, z + dz) === 159) { ok = true; break; }
  if (ok) return;
  const id = world.getBlock(x, y, z);
  world.setBlock(x, y, z, 0);   // AIR — issues neighbor updates so the tree collapses top-down
  if (id === 159 && world.rng() < 0.5) world.game?.spawnItemByName?.('chorus_fruit', 1, x + 0.5, y + 0.5, z + 0.5);
}

// ===================== 11-END §2 — End blocks (150–164) =====================
// stone-brick family (150–152) — stronghold masonry, all plain cubes.
defBlock(150, 'stone_bricks', { hardness: 1.5, blast: 6.0, tool: 'pickaxe', tier: 0, drops: gated(dropSelf('stone_bricks')), tiles: all('stone_bricks') });
defBlock(151, 'mossy_stone_bricks', { hardness: 1.5, blast: 6.0, tool: 'pickaxe', tier: 0, drops: gated(dropSelf('mossy_stone_bricks')), tiles: all('mossy_stone_bricks') });
defBlock(152, 'cracked_stone_bricks', { hardness: 1.5, blast: 6.0, tool: 'pickaxe', tier: 0, drops: gated(dropSelf('cracked_stone_bricks')), tiles: all('cracked_stone_bricks') });
// iron_bars (153) — pane lattice, connects like fence to solids/panes (§2.2).
defBlock(153, 'iron_bars', {
  shape: 'iron_bars', bucket: 'cutout', opaque: false, opacity: 0,
  hardness: 5.0, blast: 6.0, tool: 'pickaxe', tier: 0,
  collisionBox: [0, 0, 0, 1, 1, 1],   // §2.2 full-height 1.0 collision (approx)
  drops: gated(dropSelf('iron_bars')), tiles: all('iron_bars'),
});
defBlock(154, 'end_stone', { hardness: 3.0, blast: 9.0, tool: 'pickaxe', tier: 0, drops: gated(dropSelf('end_stone')), tiles: all('end_stone') });
defBlock(155, 'end_stone_bricks', { hardness: 3.0, blast: 9.0, tool: 'pickaxe', tier: 0, drops: gated(dropSelf('end_stone_bricks')), tiles: all('end_stone_bricks') });
defBlock(156, 'purpur_block', { hardness: 1.5, blast: 6.0, tool: 'pickaxe', tier: 0, drops: gated(dropSelf('purpur_block')), tiles: all('purpur_block') });
defBlock(157, 'purpur_pillar', { hardness: 1.5, blast: 6.0, tool: 'pickaxe', tier: 0, drops: gated(dropSelf('purpur_pillar')), tiles: column('purpur_pillar_top', 'purpur_pillar_side') });
// end_rod (158) — emissive rod, placeable on any solid face, pops on support loss (§2.2).
// §2.2 facing nibble: bits0-2, 0 up, 1 down, 2-5 = N/E/S/W wall. The support cell
// is the neighbor OPPOSITE the facing, indexed here (a floor rod faces up and is
// held from below; a ceiling rod faces down and hangs from above). `needsSupport`
// itself is read only by the piston mover and the creative tabs — the world
// enforces support through neighborUpdate/canPlaceAt, exactly as torch does.
const ROD_SUPPORT = [[0, -1, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 0]];
const rodSupportDir = state => ROD_SUPPORT[(state & 7) % 6];   // 6/7 are unreachable; clamp anyway
defBlock(158, 'end_rod', {
  shape: 'end_rod', bucket: 'cutout', opaque: false, opacity: 0, collidable: false,
  hardness: 0, blast: 0, emission: 14, needsSupport: 'attach',
  drops: dropSelf('end_rod'), tiles: all('end_rod'),
  neighborUpdate: (world, x, y, z, state) => {
    const d = rodSupportDir(state);
    if (!isSolidSupport(world.getBlock(x + d[0], y + d[1], z + d[2]))) world.popBlock(x, y, z);
  },
  canPlaceAt: (world, x, y, z, state = 0) => {
    const d = rodSupportDir(state);
    return isSolidSupport(world.getBlock(x + d[0], y + d[1], z + d[2]));
  },
});
// chorus_plant (159) / chorus_flower (160) — §8 outer-island vegetation.
defBlock(159, 'chorus_plant', {
  shape: 'chorus_plant', bucket: 'cutout', opaque: false, opacity: 0,
  hardness: 0.4, blast: 0.4, tool: 'axe',
  collisionBox: [2 / 16, 0, 2 / 16, 14 / 16, 1, 14 / 16],
  drops: ctx => (ctx.rng() < 0.5 ? [{ name: 'chorus_fruit', count: 1 }] : []),
  neighborUpdate: chorusSupport, tiles: all('chorus_plant'),
});
defBlock(160, 'chorus_flower', {
  shape: 'chorus_flower', bucket: 'cutout', opaque: false, opacity: 0,
  hardness: 0.4, blast: 0.4, tool: 'axe', randomTick: chorusGrow,
  collisionBox: [1 / 16, 0, 1 / 16, 15 / 16, 14 / 16, 15 / 16],
  drops: dropSelf('chorus_flower'),   // player-mined drops self; support-loss pop drops nothing
  neighborUpdate: chorusSupport, tiles: all('chorus_flower'),
});
// end_portal_frame (161) — unbreakable; eye bit2 in state; cube with eye overlay (§5.2).
defBlock(161, 'end_portal_frame', {
  hardness: -1, blast: 3600000, opaque: true,
  drops: noDrop,
  tiles: all('end_stone'),
  tilesFor: (state, face) => (face === 2
    ? ((state & 4) ? 'end_portal_frame_top_eye' : 'end_portal_frame_top')
    : (face === 3 ? 'end_stone' : 'end_portal_frame_side')),
});
// end_portal (162) — horizontal starfield quad, no collision, no block-item (§2.2/§5.4).
defBlock(162, 'end_portal', {
  hardness: -1, blast: 3600000, emission: 15,
  shape: 'end_portal', bucket: 'water', opaque: false, opacity: 0, collidable: false, targetable: false,
  drops: noDrop, tiles: all('end_portal'),
});
// end_gateway (163) — like end_portal but full dark core (§11).
defBlock(163, 'end_gateway', {
  hardness: -1, blast: 3600000, emission: 15,
  shape: 'end_gateway', bucket: 'water', opaque: false, opacity: 0, collidable: false, targetable: false,
  blockEntity: 'end_gateway', drops: noDrop, tiles: all('end_gateway'),
});
// shulker_box (164) — 27-slot container, contents retained on break (§9.4).
defBlock(164, 'shulker_box', {
  hardness: 2.0, blast: 2.0, tool: 'pickaxe',
  // §2.2 row 164: Opac T (06 §3 legend: transparent = opacity 0), Pass op.
  opaque: false, opacity: 0, bucket: 'opaque', blockEntity: 'shulker_box', interactable: 'shulker',
  drops: noDrop,   // break routes through spillBlockEntity → item with tags.containerItems
  tiles: column('shulker_box_top', 'shulker_box_side', 'shulker_box_bottom'),
});

// ===================== 13-BOSSES §2 — boss blocks (185–187) =====================
// dragon_egg (185) — trophy; falls like sand; clicks teleport it; can't be mined.
defBlock(185, 'dragon_egg', {
  hardness: 3.0, blast: 9.0, emission: 1, gravity: true,
  shape: 'dragon_egg', bucket: 'cutout', opaque: false, opacity: 0,
  interactable: 'dragon_egg',   // RMB → onUse teleport (installed by bosses hooks)
  drops: noDrop,                // §4 — mining yields nothing; obtained via fall/piston tricks
  tiles: all('dragon_egg'),
});
// wither_skeleton_skull (186) — floor skull; placing runs the wither summon detector.
defBlock(186, 'wither_skeleton_skull', {
  hardness: 1.0, blast: 1.0, opaque: false, opacity: 0, collidable: false,
  shape: 'wither_skull_block', bucket: 'cutout', needsSupport: 'below',
  drops: dropSelf('wither_skeleton_skull'), tiles: all('wither_skeleton_skull'),
  // §5 — "floor-only, on the top face of any solid block … support removed →
  // pops as item (torch rule)". needsSupport is only read by the piston mover
  // and the creative tabs; the world enforces support via these two hooks.
  neighborUpdate: (world, x, y, z) => {
    if (!isSolidSupport(world.getBlock(x, y - 1, z))) world.popBlock(x, y, z);
  },
  canPlaceAt: (world, x, y, z) => isSolidSupport(world.getBlock(x, y - 1, z)),
});
// beacon (187) — pyramid GUI + buffs + beam; always emits light 15.
defBlock(187, 'beacon', {
  hardness: 3.0, blast: 3.0, emission: 15,
  shape: 'beacon', bucket: 'cutout', opaque: false, opacity: 0,
  blockEntity: 'beacon', interactable: 'beacon',
  drops: dropSelf('beacon'),
  tilesFor: (state, face) => (face === 2 ? 'beacon_core' : face === 3 ? 'beacon_base' : 'beacon_shell'),
  tiles: all('beacon_shell'),
});

// =======================================================================
// B12 — "The Hollow" (19-BUILDOUT-v1.3 §B12). Blocks 145/146/147.
//
// Id allocation: 145–147 are the orchestrator's B12 slots (144 is B5's
// mossy_cobblestone). They numerically sit inside 10-NETHER's 115–149 range
// exactly as B5's 144 already does — the registry is dense-array-indexed, not
// range-policed, and U5 only checks 0..255 uniqueness.
//
// Hollow stone is the biome's substrate: the generator swaps plain stone for it
// in masked columns' y<24 band (features.js stampHollow). Blast 9 gives the
// wither-resistant feel §B12 asks for ("blast-resistant 9 — wither-resistant
// feel") without hardness getting in the way of digging (§: "hardness ~2").
//
// ECHO DROP DEVIATION (19-BUILDOUT §B12 + phase brief): echo_ore is specced to
// drop an `echo_shard` ITEM, but item registry ids are OUTSIDE this phase's
// file list and `echo_shard` does not resolve (idOf throws) — verified at
// build time. Until the orchestrator registers it, the drop resolves to
// `emerald` (the item §B12's Sentinel loot falls back to as well). Swap the
// constant below to 'echo_shard' when the item lands; nothing else references
// the name.
const ECHO_DROP = 'emerald';

defBlock(145, 'hollow_stone', {
  hardness: 2.0, blast: 9.0, tool: 'pickaxe', tier: 0,
  drops: gated(dropSelf('hollow_stone')),
});
// §B12 §2 — rare band ore; iron-pick tier (1) to drop; Fortune multiplies the
// shard count exactly like coal_ore's coal (the ore() gate wraps the closure).
ore(146, 'echo_ore', 1,
  ctx => [{ name: ECHO_DROP, count: fortuneM(ctx.fortune ?? 0, ctx.rng) }],
  function (ctx) { return harvestOK(this, ctx.toolClass, ctx.toolTier) ? ri(ctx.rng, 2, 5) : 0; });
// §B12 §2 — the biome's glow source: cross-shape, emission 4 so the cave band
// is navigable without torches but stays moody (spec's own words). Lives on the
// band's stone floors; support loss pops it like any below-supported plant.
defBlock(147, 'hollow_growth', {
  ...CROSS, emission: 4, needsSupport: 'below',
  neighborUpdate: needsBelow([B.STONE, B.HOLLOW_STONE]),
  canPlaceAt: (world, x, y, z) => [B.STONE, B.HOLLOW_STONE].includes(world.getBlock(x, y - 1, z)),
});

// =======================================================================
// Material classes — the `Mat` column (16-AUDIO AMENDS 06 §2, table 16 §3.1).
//
// Transcribed verbatim from 16 §3.1 rather than threaded through each defBlock
// call, because 24 of the 67 blocks are loop-generated and would otherwise get
// the class in a place a reader can't check against the spec. `mat` selects the
// step/dig/break/place voice family (16 §3.2). Later expansions default to
// 'nether' (10) / 'end' (11) per §3.1; blocks with no verb ('none', 'fluid')
// are skipped silently by the emit sites.
//
// Counter-intuitive but correct per §3.1 — do not "fix" these: tnt→grass,
// cactus→wool, glowstone→glass, ice→glass, coal_block→stone (unlike the other
// metal blocks), dirt/farmland→gravel, sandstone→stone, dead_bush→grass.
const MAT = {
  // 08 §2.2: enchanting_table + grindstone → 'stone' (anvil is 'metal').
  // 07-REDSTONE §13: stone-material components + metal-ish machines.
  stone: ['stone', 'cobblestone', 'mossy_cobblestone', 'sandstone', 'bedrock', 'obsidian', 'furnace', 'furnace_lit', 'coal_block',
    'enchanting_table', 'grindstone', 'brewing_stand',
    'blast_furnace', 'blast_furnace_lit', 'smoker', 'smoker_lit', 'emerald_ore',   // 12-VILLAGES
    'hollow_stone',   // B12 — substrate stone class
    'redstone_wire', 'redstone_torch', 'lever', 'stone_button', 'stone_pressure_plate',
    'repeater', 'comparator', 'piston', 'sticky_piston', 'piston_head', 'observer',
    'dispenser', 'dropper', 'hopper', 'redstone_lamp', 'redstone_lamp_lit', 'redstone_block'],
  ore: ['coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'redstone_ore', 'lapis_ore',
    'echo_ore'],   // B12
  metal: ['iron_block', 'gold_block', 'diamond_block', 'anvil',
    'bell', 'emerald_block'],   // 12-VILLAGES
  wood: ['oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'birch_log', 'spruce_log',
    'crafting_table', 'chest', 'bookshelf', 'ladder', 'oak_fence', 'oak_door', 'bed_block',
    'torch', 'pumpkin', 'jack_o_lantern',
    'wooden_button', 'wooden_pressure_plate', 'note_block',
    'composter', 'barrel', 'lectern', 'fletching_table'],   // 12-VILLAGES
  gravel: ['gravel', 'dirt', 'farmland', 'dirt_path'],       // 12-VILLAGES
  sand: ['sand'],
  grass: ['grass_block', 'oak_leaves', 'birch_leaves', 'spruce_leaves', 'oak_sapling',
    'birch_sapling', 'spruce_sapling', 'wheat_crop', 'carrot_crop', 'potato_crop',
    'sugar_cane_block', 'short_grass', 'dandelion', 'poppy', 'dead_bush', 'tnt',
    'brown_mushroom', 'red_mushroom',   // 09-POTIONS §7.1
    'hay_bale',   // 12-VILLAGES
    'chorus_plant', 'chorus_flower',   // 11-END (plant-like → grass voice)
    'hollow_growth',   // B12 — plant-like → grass voice
  ],
  glass: ['glass', 'ice', 'glowstone',
    'beacon'],   // 13-BOSSES — glassy shell voice
  // 16 §3.1 — the two reserved dimension classes. Their rows carry no block list
  // in the spec, only a recipe and the rule "10's blocks default here" / "11's
  // blocks default here" (restated by §3.1's AMENDS 06 §2 line: "nether-family
  // blocks default `nether`, end-family `end`"). So the whole 115–143 range goes
  // to 'nether' — including the crimson/warped stems and planks, which the End
  // side already treats the same way (iron_bars and the stone-brick family sit in
  // 'end', not 'stone'). Splitting them across stone/grass/wood by look left
  // block.step/dig/break/place.nether and mob.step.nether generated but dead.
  nether: ['netherrack', 'nether_bricks', 'nether_brick_fence', 'nether_brick_stairs',
    'soul_sand', 'soul_soil', 'magma_block', 'nether_quartz_ore', 'nether_gold_ore',
    'ancient_debris', 'crimson_nylium', 'warped_nylium', 'crimson_stem', 'warped_stem',
    'crimson_planks', 'warped_planks', 'nether_wart_block', 'warped_wart_block',
    'shroomlight', 'crimson_fungus', 'warped_fungus', 'crimson_roots', 'warped_roots',
    'nether_wart', 'bone_block', 'nether_portal', 'spawner', 'netherite_block',
    'smithing_table'],
  // 11-END §3.1 — the End family (stone-brick/end-stone/purpur/rods/portals default to 'end').
  end: ['stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'iron_bars',
    'end_stone', 'end_stone_bricks', 'purpur_block', 'purpur_pillar', 'end_rod',
    'end_portal_frame', 'end_portal', 'end_gateway', 'shulker_box',
    'dragon_egg', 'wither_skeleton_skull'],   // 13-BOSSES
  wool: ['wool_white', 'wool_red', 'wool_blue', 'wool_black', 'cactus'],
  snow: ['snow_layer', 'snow_block'],
  fluid: ['water', 'lava'],
  none: ['air', 'fire'],
};

for (const cls of Object.keys(MAT)) {
  for (const name of MAT[cls]) {
    const id = B[name.toUpperCase()];
    if (id === undefined) { console.warn(`[registry] mat: unknown block '${name}'`); continue; }
    BLOCKS[id].mat = cls;
  }
}
// Fail loud in dev if a block was added without a class (16 §3.2 needs one).
for (const b of BLOCKS) {
  if (b && b.mat === 'none' && b.name !== 'air' && b.name !== 'fire') {
    console.warn(`[registry] block '${b.name}' has no material class (16 §3.1)`);
  }
}

// =======================================================================
// Flammability registry — 15 §3's core table, whole game. (AMENDS 01 §5)
// Enc = encouragement/ignite odds (feeds 15 §2.6 + anyFlammableNeighbor)
// Burn = flammability/burn odds (feeds 15 §2.5 tryBurn)
// lava = lavaIgnite: participates in lava's fire-creation check (15 §4.2) even
//        when Enc/Burn are 0. Anything not listed is 0 / 0 / no.
// All values are exact Java 1.20. Transcribed verbatim rather than threaded
// through each defBlock call so a reader can diff it against the spec table.
const FIRE = {
  //                              Enc  Burn  lavaIgnite
  oak_planks:        [5, 20, true], birch_planks: [5, 20, true], spruce_planks: [5, 20, true],
  oak_log:           [5, 5, true],  birch_log:    [5, 5, true],  spruce_log:    [5, 5, true],
  // leaves burn away dropping nothing (vanilla) — handled by tryBurn setting AIR
  oak_leaves:        [30, 60, true], birch_leaves: [30, 60, true], spruce_leaves: [30, 60, true],
  coal_block:        [5, 5, true],
  crafting_table:    [0, 0, true],   // vanilla: wooden but fireproof; lava still ignites beside it
  chest:             [0, 0, true],   // fireproof (vanilla)
  bookshelf:         [30, 20, true],
  tnt:               [15, 100, true], // consumed by tryBurn -> primed TNT, fuse 80 (15 §2.5)
  oak_fence:         [5, 20, true],
  oak_door:          [0, 0, true],   // vanilla doors are non-flammable
  bed_block:         [0, 0, true],   // vanilla JE: lava-ignitable, never burns away
  wool_white:        [30, 60, true], wool_red: [30, 60, true],
  wool_blue:         [30, 60, true], wool_black: [30, 60, true],
  short_grass:       [60, 100, true],
  dandelion:         [60, 100, false], poppy: [60, 100, false],  // 1-block flowers: JE lava-ignite No
  dead_bush:         [60, 100, true],
  hay_bale:          [60, 20, false], // 15 §3 (12) — catches instantly, burns slowly
  // saplings, crops, farmland, sugar_cane, cactus, pumpkin, jack_o_lantern,
  // torch, ladder, snow, ice, glass, stone/ores/minerals, fluids: all 0/0/no.
};

for (const name of Object.keys(FIRE)) {
  const id = B[name.toUpperCase()];
  if (id === undefined) { console.warn(`[registry] fire: unknown block '${name}'`); continue; }
  const [enc, burn, lava] = FIRE[name];
  BLOCKS[id].fireEnc = enc;
  BLOCKS[id].fireBurn = burn;
  BLOCKS[id].lavaIgnite = lava;
}

// 15 §9 — the complete waterloggable list. Verified against Java 1.20.
// Everything else is a dam or pops (base 06 §6.1). Leaves are a documented
// deviation (our leaves are full cubes carrying persistence bits) — see DEVIATIONS.
for (const name of ['oak_fence', 'ladder', 'chest']) {
  const id = B[name.toUpperCase()];
  if (id === undefined) { console.warn(`[registry] waterloggable: unknown block '${name}'`); continue; }
  BLOCKS[id].waterloggable = true;
}

// Material class of a block id — the lookup every 16 §3.2 emit site uses.
// Returns null for classes with no step/dig/break/place verb (§3.1).
export function matOf(id) {
  const m = BLOCKS[id]?.mat;
  return m === 'none' || m === 'fluid' || !m ? null : m;
}

// Zero consumers in this build (Game.js imported it and never called it). Kept
// as registry surface only — do NOT add a second name→block lookup beside it.
export function blockByName(name) {
  const id = B[name.toUpperCase()];
  return id === undefined ? undefined : BLOCKS[id];
}

// Resolve tile names → atlas indices once at startup (main thread only).
export function finalizeBlockTiles(TILE) {
  const lookup = name => {
    const t = TILE[name];
    if (t === undefined) { console.warn(`[registry] unknown tile '${name}'`); return 0; }
    return t;
  };
  for (const block of BLOCKS) {
    if (!block || !block.tiles) continue;
    block.tileIndex = Uint16Array.from(block.tiles.map(lookup));
    if (block.tilesFor) {
      const cache = [];
      const fn = block.tilesFor;
      block.tileIndexFor = (state, face) => {
        const key = ((state & 15) << 3) | face;
        let v = cache[key];
        if (v === undefined) v = cache[key] = lookup(fn(state, face));
        return v;
      };
    }
  }
}
