// 02 §6 — Biome selection & per-biome surface rules.
// Leaf module: no local imports, so features.js/noise.js can import it freely.

// Block ids used by the generator — MUST match 06's canonical registry.
export const ID = {
  air: 0,
  stone: 1,
  grass_block: 2,
  dirt: 3,
  oak_log: 8,
  birch_log: 9,
  spruce_log: 10,
  oak_leaves: 11,
  birch_leaves: 12,
  spruce_leaves: 13,
  oak_sapling: 14,
  birch_sapling: 15,
  spruce_sapling: 16,
  bedrock: 17,
  sand: 18,
  gravel: 19,
  sandstone: 20,
  coal_ore: 21,
  iron_ore: 22,
  gold_ore: 23,
  diamond_ore: 24,
  redstone_ore: 25,
  lapis_ore: 26,
  emerald_ore: 181,   // 12-VILLAGES §6.2
  snow_layer: 40,
  ice: 42,
  cactus: 43,
  pumpkin: 44,
  sugar_cane_block: 59,
  short_grass: 60,
  dandelion: 61,
  poppy: 62,
  water: 63,
  lava: 64,
  dead_bush: 66,
};

// 02 §6.1 — biome enum (stored per column, saved with chunk)
export const BIOMES = {
  OCEAN: 0, BEACH: 1, RIVER: 2, PLAINS: 3, FOREST: 4,
  BIRCH_FOREST: 5, DESERT: 6, SAVANNA: 7, TAIGA: 8,
  SNOWY_TUNDRA: 9, MOUNTAINS: 10,
};

export const BIOME_NAMES = [
  'ocean', 'beach', 'river', 'plains', 'forest', 'birch_forest',
  'desert', 'savanna', 'taiga', 'snowy_tundra', 'mountains',
];

// Base temperature per biome id (runtime rain-vs-snow, 04 §12.4)
export const BIOME_TEMPS = [0.5, 0.8, 0.5, 0.8, 0.7, 0.6, 2.0, 1.2, 0.25, 0.0, 0.18];

const { OCEAN, BEACH, RIVER, PLAINS, FOREST, BIRCH_FOREST, DESERT, SAVANNA,
        TAIGA, SNOWY_TUNDRA, MOUNTAINS } = BIOMES;

// 02 §6.2 — selection (canonical order). t0/h are raw lattice-interpolated
// fbm values; altitude cooling applied here.
export function selectBiome(height, c, riv, t0, h) {
  const t = t0 - Math.max(0, height - 80) * 0.008;
  if (height <= 59) return OCEAN;
  if (riv > 0.5 && height <= 62) return RIVER;
  if (height <= 64 && c < 0.05) return BEACH;
  if (height >= 92) return MOUNTAINS;
  const col = h < -0.2 ? 0 : h <= 0.3 ? 1 : 2; // dry | mid | wet
  if (t < -0.45) return col === 2 ? TAIGA : SNOWY_TUNDRA;
  if (t < -0.10) return col === 0 ? PLAINS : TAIGA;
  if (t < 0.40) return [PLAINS, FOREST, BIRCH_FOREST][col];
  return [DESERT, SAVANNA, PLAINS][col];
}

// Surface block derived from biome + height rules only (never block reads) —
// used by tree/herd/spawn checks so cross-chunk re-simulation stays pure.
export function surfaceBlockFor(biome, height) {
  if (height < 63) return height >= 56 ? ID.sand : ID.gravel; // §7.2 submerged
  if (biome === DESERT || biome === BEACH || biome === RIVER) return ID.sand;
  if (biome === MOUNTAINS && height >= 96) return ID.stone;
  return ID.grass_block;
}

// §6.3 — decoration config per biome id.
// trees: {count, chance?, mix: 'oak'|'birch'|'spruce'|'forest'} (forest = 75% oak / 25% birch)
export const TREE_CFG = [
  null,                                    // ocean
  null,                                    // beach
  null,                                    // river
  { count: 1, chance: 1 / 20, mix: 'oak' },   // plains
  { count: 8, mix: 'forest' },                // forest
  { count: 8, mix: 'birch' },                 // birch_forest
  null,                                    // desert
  { count: 1, mix: 'oak' },                   // savanna
  { count: 7, mix: 'spruce' },                // taiga
  { count: 1, chance: 1 / 10, mix: 'spruce' },// snowy_tundra
  { count: 1, mix: 'spruce' },                // mountains
];

export const GRASS_COUNT  = [0, 0, 0, 40, 12, 12, 0, 50, 8, 0, 6];
export const FLOWER_COUNT = [0, 0, 0, 6, 3, 3, 0, 2, 0, 0, 0];
export const CANE_BIOMES = new Set([BEACH, RIVER, DESERT, PLAINS, FOREST, SAVANNA]);
export const PUMPKIN_BIOMES = new Set([PLAINS, FOREST]);

// §11 — herd species weights per biome (null = no herds)
export const HERD_WEIGHTS = [
  null, null, null,
  [['cow', 4], ['sheep', 4], ['pig', 3], ['chicken', 3]],   // plains
  [['pig', 3], ['chicken', 3], ['cow', 2], ['sheep', 2]],   // forest
  [['pig', 3], ['chicken', 3], ['cow', 2], ['sheep', 2]],   // birch_forest
  null,                                                      // desert
  [['cow', 4], ['sheep', 4], ['pig', 3], ['chicken', 3]],   // savanna
  [['cow', 1], ['pig', 1], ['sheep', 1], ['chicken', 1]],   // taiga
  null,                                                      // snowy_tundra
  [['sheep', 3], ['chicken', 1]],                            // mountains
];
