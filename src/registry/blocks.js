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
const gated = fn => function (ctx) {
  return harvestOK(this, ctx.toolClass, ctx.toolTier) ? fn.call(this, ctx) : [];
};

// Leaves drop table A (06 §2)
const leafDrops = (sapling, withApple) => function (ctx) {
  if (ctx.toolClass === 'shears') return [{ name: this.name, count: 1 }];
  const out = [];
  if (ctx.rng() < 0.05) out.push({ name: sapling, count: 1 });
  if (ctx.rng() < 0.02) out.push({ name: 'stick', count: ri(ctx.rng, 1, 2) });
  if (withApple && ctx.rng() < 0.005) out.push({ name: 'apple', count: 1 });
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
  for (const [dx, , dz] of FACING_DIR)                     // water beside the SUPPORT block
    if (world.getBlock(x + dx, y - 1, z + dz) === B.WATER) return true;
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
        if (world.getBlock(x + dx, y + dy, z + dz) === B.WATER) { wet = true; break outer; }
  const above = world.getBlock(x, y + 1, z);
  const hasCrop = above >= B.WHEAT_CROP && above <= B.POTATO_CROP;
  if (!wet && !hasCrop) { world.setBlock(x, y, z, B.DIRT); return; }
  const newState = (state & 7) | (wet ? 8 : 0);
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
    const d = WALL_DIR[state];
    sx = x - d[0]; sy = y; sz = z - d[2];
  }
  if (!isSolidSupport(world.getBlock(sx, sy, sz))) world.popBlock(x, y, z);
}

function ladderNeighbor(world, x, y, z, state) {
  const d = WALL_DIR[state] ?? WALL_DIR[1];
  if (!isSolidSupport(world.getBlock(x - d[0], y, z - d[2]))) world.popBlock(x, y, z);
}

function tntNeighbor(world, x, y, z) {
  for (const [dx, dy, dz] of DIRS6)
    if (world.getBlock(x + dx, y + dy, z + dz) === B.FIRE) {
      world.igniteTnt?.(x, y, z);
      return;
    }
}

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
    ...opts,
  };
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
});

defBlock(1, 'stone', {
  hardness: 1.5, blast: 6.0, tool: 'pickaxe', tier: 0,
  drops: gated(() => [{ name: 'cobblestone', count: 1 }]),
});

defBlock(2, 'grass_block', {
  hardness: 0.6, blast: 0.6, tool: 'shovel',
  tiles: [ 'grass_side', 'grass_side', 'grass_top', 'dirt', 'grass_side', 'grass_side' ],
  drops: () => [{ name: 'dirt', count: 1 }],
  randomTick: grassTick,
});

defBlock(3, 'dirt', { hardness: 0.5, blast: 0.5, tool: 'shovel' });
defBlock(4, 'cobblestone', { hardness: 2.0, blast: 6.0, tool: 'pickaxe', tier: 0, drops: gated(dropSelf('cobblestone')) });
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
  drops: ctx => (ctx.rng() < 0.10 ? [{ name: 'flint', count: 1 }] : [{ name: 'gravel', count: 1 }]),
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
ore(21, 'coal_ore', 0, ctx => [{ name: 'coal', count: 1 }],
  function (ctx) { return harvestOK(this, ctx.toolClass, ctx.toolTier) ? ri(ctx.rng, 0, 2) : 0; });
ore(22, 'iron_ore', 1, () => [{ name: 'raw_iron', count: 1 }], null);
ore(23, 'gold_ore', 2, () => [{ name: 'raw_gold', count: 1 }], null);
ore(24, 'diamond_ore', 2, () => [{ name: 'diamond', count: 1 }],
  function (ctx) { return harvestOK(this, ctx.toolClass, ctx.toolTier) ? ri(ctx.rng, 3, 7) : 0; });
ore(25, 'redstone_ore', 2, ctx => [{ name: 'redstone', count: ri(ctx.rng, 4, 5) }],
  function (ctx) { return harvestOK(this, ctx.toolClass, ctx.toolTier) ? ri(ctx.rng, 1, 5) : 0; });
ore(26, 'lapis_ore', 1, ctx => [{ name: 'lapis_lazuli', count: ri(ctx.rng, 4, 9) }],
  function (ctx) { return harvestOK(this, ctx.toolClass, ctx.toolTier) ? ri(ctx.rng, 2, 5) : 0; });

defBlock(27, 'coal_block', { hardness: 5.0, blast: 6.0, tool: 'pickaxe', tier: 0, drops: gated(dropSelf('coal_block')) });
defBlock(28, 'iron_block', { hardness: 5.0, blast: 6.0, tool: 'pickaxe', tier: 1, drops: gated(dropSelf('iron_block')) });
defBlock(29, 'gold_block', { hardness: 3.0, blast: 6.0, tool: 'pickaxe', tier: 2, drops: gated(dropSelf('gold_block')) });
defBlock(30, 'diamond_block', { hardness: 5.0, blast: 6.0, tool: 'pickaxe', tier: 2, drops: gated(dropSelf('diamond_block')) });

defBlock(31, 'glass', {
  hardness: 0.3, blast: 0.3, opaque: false, opacity: 0, bucket: 'cutout',
  drops: noDrop,
});

defBlock(32, 'glowstone', { hardness: 0.3, blast: 0.3, emission: 15 });

defBlock(33, 'obsidian', { hardness: 50, blast: 1200, tool: 'pickaxe', tier: 3, drops: gated(dropSelf('obsidian')) });

defBlock(34, 'crafting_table', {
  hardness: 2.5, blast: 2.5, tool: 'axe', interactable: 'crafting',
  tiles: ['crafting_table_side', 'crafting_table_side', 'crafting_table_top', 'oak_planks', 'crafting_table_side', 'crafting_table_side'],
});

// Furnace front by facing: face order [+X,−X,+Y,−Y,+Z,−Z]; facing f → face index
const FACING_FACE = [4, 1, 5, 0];
const furnaceTiles = front => (state, face) => {
  if (face === 2 || face === 3) return 'furnace_top';
  return face === FACING_FACE[state & 3] ? front : 'furnace_side';
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
      const d = WALL_DIR[state];
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
    const d = WALL_DIR[state] ?? WALL_DIR[1];
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
  tiles: ['tnt_side', 'tnt_side', 'tnt_top', 'tnt_bottom', 'tnt_side', 'tnt_side'],
  neighborUpdate: tntNeighbor,
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
cropDef(56, 'wheat_crop', 'wheat', ctx =>
  (ctx.state & 7) >= 7
    ? [{ name: 'wheat', count: 1 }, { name: 'wheat_seeds', count: ri(ctx.rng, 0, 3) }]
    : [{ name: 'wheat_seeds', count: 1 }]);
cropDef(57, 'carrot_crop', 'carrot', ctx =>
  [{ name: 'carrot', count: (ctx.state & 7) >= 7 ? ri(ctx.rng, 2, 5) : 1 }]);
cropDef(58, 'potato_crop', 'potato', ctx =>
  [{ name: 'potato', count: (ctx.state & 7) >= 7 ? ri(ctx.rng, 2, 5) : 1 }]);

defBlock(59, 'sugar_cane_block', {
  ...CROSS, displayName: 'Sugar Cane', tiles: all('sugar_cane'), needsSupport: 'below',
  drops: () => [{ name: 'sugar_cane', count: 1 }],
  randomTick: (world, x, y, z, state) => columnGrowTick(world, x, y, z, state, validCane, B.SUGAR_CANE_BLOCK),
  neighborUpdate: (world, x, y, z) => { if (!validCane(world, x, y, z)) world.popBlock(x, y, z); },
  canPlaceAt: validCane,
});

defBlock(60, 'short_grass', {
  ...CROSS, tool: 'shears', replaceable: true, needsSupport: 'below',
  drops: ctx => (ctx.toolClass === 'shears'
    ? [{ name: 'short_grass', count: 1 }]
    : (ctx.rng() < 0.125 ? [{ name: 'wheat_seeds', count: 1 }] : [])),
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
});

defBlock(64, 'lava', {
  shape: 'liquid', bucket: 'water', opaque: false, opacity: 15,
  collidable: false, targetable: false, hardness: -1, blast: 100,
  emission: 15, fluid: 'lava', fluidAlpha: 1.0, drops: noDrop,
});

defBlock(65, 'fire', {
  ...CROSS, emission: 15, replaceable: true, drops: noDrop,
  onPlaced: (world, x, y, z) => {
    world.scheduleTick(x, y, z, 100 + Math.floor(world.rng() * 101));
    for (const [dx, dy, dz] of DIRS6)
      if (world.getBlock(x + dx, y + dy, z + dz) === B.TNT)
        world.igniteTnt?.(x + dx, y + dy, z + dz);
  },
  scheduledTick: (world, x, y, z) => world.removeBlock(x, y, z),
  neighborUpdate: (world, x, y, z) => {
    if (!isSolidSupport(world.getBlock(x, y - 1, z))) world.removeBlock(x, y, z);
  },
});

defBlock(66, 'dead_bush', {
  ...CROSS, tool: 'shears', replaceable: true, needsSupport: 'below',
  drops: ctx => (ctx.toolClass === 'shears'
    ? [{ name: 'dead_bush', count: 1 }]
    : (() => { const n = ri(ctx.rng, 0, 2); return n ? [{ name: 'stick', count: n }] : []; })()),
  neighborUpdate: needsBelow([18, 3]),
  canPlaceAt: (world, x, y, z) => [B.SAND, B.DIRT].includes(world.getBlock(x, y - 1, z)),
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
  stone: ['stone', 'cobblestone', 'sandstone', 'bedrock', 'obsidian', 'furnace', 'furnace_lit', 'coal_block'],
  ore: ['coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'redstone_ore', 'lapis_ore'],
  metal: ['iron_block', 'gold_block', 'diamond_block'],
  wood: ['oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'birch_log', 'spruce_log',
    'crafting_table', 'chest', 'bookshelf', 'ladder', 'oak_fence', 'oak_door', 'bed_block',
    'torch', 'pumpkin', 'jack_o_lantern'],
  gravel: ['gravel', 'dirt', 'farmland'],
  sand: ['sand'],
  grass: ['grass_block', 'oak_leaves', 'birch_leaves', 'spruce_leaves', 'oak_sapling',
    'birch_sapling', 'spruce_sapling', 'wheat_crop', 'carrot_crop', 'potato_crop',
    'sugar_cane_block', 'short_grass', 'dandelion', 'poppy', 'dead_bush', 'tnt'],
  glass: ['glass', 'ice', 'glowstone'],
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

// Material class of a block id — the lookup every 16 §3.2 emit site uses.
// Returns null for classes with no step/dig/break/place verb (§3.1).
export function matOf(id) {
  const m = BLOCKS[id]?.mat;
  return m === 'none' || m === 'fluid' || !m ? null : m;
}

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
