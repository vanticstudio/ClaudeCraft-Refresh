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
  // B5 — dungeon/ruin stamps (must match the registry's canonical ids)
  cobblestone: 4,
  mossy_cobblestone: 144,
  chest: 37,
  spawner: 141,
  tnt: 51,
  // B12 §2 — "The Hollow" blocks (must match the registry's canonical ids).
  // Ids 145–147 are the orchestrator's B12 allocation (144 is B5's mossy
  // cobblestone); they sit inside 10-NETHER's numeric 115–149 range exactly the
  // way B5's 144 already does.
  hollow_stone: 145,
  echo_ore: 146,
  hollow_growth: 147,
};

// 02 §6.1 — biome enum (stored per column, saved with chunk)
export const BIOMES = {
  OCEAN: 0, BEACH: 1, RIVER: 2, PLAINS: 3, FOREST: 4,
  BIRCH_FOREST: 5, DESERT: 6, SAVANNA: 7, TAIGA: 8,
  SNOWY_TUNDRA: 9, MOUNTAINS: 10,
  THE_END: 11,   // 11-END AMENDS 02 §6.1 — dim-2 only; never selected by overworld biomeAt
  HOLLOW: 12,    // B12 §1 — overworld UNDERGROUND overlay: the y<24 cave band of a column
};

export const BIOME_NAMES = [
  'ocean', 'beach', 'river', 'plains', 'forest', 'birch_forest',
  'desert', 'savanna', 'taiga', 'snowy_tundra', 'mountains',
  'the_end',
  'hollow',   // B12 §1
];

// Base temperature per biome id (runtime rain-vs-snow, 04 §12.4)
// B12: index 12 mirrors PLAINS's 0.8 — the Hollow replaces plains columns, so
// weather above a hollow column must behave exactly as it did before masking.
export const BIOME_TEMPS = [0.5, 0.8, 0.5, 0.8, 0.7, 0.6, 2.0, 1.2, 0.25, 0.0, 0.18, 0.5, 0.8];

const { OCEAN, BEACH, RIVER, PLAINS, FOREST, BIRCH_FOREST, DESERT, SAVANNA,
        TAIGA, SNOWY_TUNDRA, MOUNTAINS } = BIOMES;

// ============================================================================
// B12 §1 — "The Hollow" selector (underground-only biome overlay).
//
// The chunk's biomes array is PER COLUMN (02 §6.1: z<<4|x) — there is no per-y
// storage — so the spec's `y < 24 && caveNoise > threshold` is encoded column-
// side: HOLLOW marks a column whose y<24 band is substantially cavernous (the
// cave-noise sample below averages the cheese field at y 8/14/20 — all inside
// the band), and `y < 24` itself is carried by the two gates around it:
//   * the column must be DRY LAND well above the band (height >= 64; oceans
//     are selectBiome's height <= 59, beaches/rivers the submerged 60–63 ring,
//     so "ocean floor excluded / only in stone" is exactly the 64 floor), and
//   * the noise is only ever SAMPLED inside y < 24, never above it.
// A column whose surface sat inside the band (height <= 24, i.e. a "y>=24"
// reading of the spec's exclusion) can never pass the 64 floor, so no column
// that is mostly-band is ever marked.
//
// STABILITY CONTRACT (why only PLAINS is maskable): the mask is applied by
// features.js:decorate on the LRU-cached colD AFTER terrain fill, so later
// readers (tree re-derivation from a neighbour chunk, herd/ore re-simulation on
// a chunk revisit) can see a masked column through ctx.biomeAt. Every per-biome
// gen table below therefore carries an index-12 entry byte-equal to PLAINS's,
// and the CHUNK-CENTRE column (z<<4|x = 136) is NEVER masked, because
// village.js's VILLAGE_BIOMES gate and the TREE_CFG/cane/pumpkin centre reads
// key on ctx.biomeAt of a chunk centre and cannot be mirrored here (village.js
// is outside B12's file list). With both halves of that contract held, a
// masked column is behaviourally indistinguishable from its original plains
// self at every gen read site — see stampHollow's header comment.
// ============================================================================
export const HOLLOW_SURFACE_MIN = 64;      // dry land only — oceans are height <= 59
export const HOLLOW_Y_MAX = 24;            // the biome describes the y<24 band only
// Cheese-band average above this = "substantially cavernous at depth". The
// carver opens a cell at cheese > ~0.58 near the band, so 0.30 on the 3-sample
// average marks columns whose band holds connected cave (measured ~7% of
// plains-land columns); below ~0.2 only isolated pockets pass.
export const HOLLOW_CAVE_THRESHOLD = 0.30;

// Pure selector — the ONLY place the HOLLOW formula lives. `caveNoise` is the
// caller's y<24 band sample (features.js: the cheese-field average at y 8/14/20).
export function hollowAt(height, caveNoise) {
  return height >= HOLLOW_SURFACE_MIN && caveNoise > HOLLOW_CAVE_THRESHOLD;
}

// 02 §6.2 — selection (canonical order). t0/h are raw lattice-interpolated
// fbm values; altitude cooling applied here.
export function selectBiome(height, c, riv, t0, h) {
  // COUPLED CONSTANT (0.008 × noise.js CLIMATE_GAIN 1.7 = 0.0136): t0 arrives
  // pre-scaled by the climate gain, so the altitude-cooling term must be scaled by
  // the same factor or high ground stops cooling. The identical literal lives in
  // features.js's §10.6 snow pass — THE TWO MUST NEVER DRIFT APART.
  const t = t0 - Math.max(0, height - 80) * 0.0136;
  // §6.2 DEVIATION — river tested BEFORE ocean. The spec's canonical order is
  // ocean-first, but the river carve (noise.js §5.2) targets a bed of 57–59, i.e.
  // every river's OWN CHANNEL fell into `height <= 59` and was typed OCEAN; only
  // the 60–62 shoulder could ever be RIVER (measured: 0.11% of columns). Rivers
  // therefore got ocean tint/surface rules and no river-biome sugar cane, and read
  // as ragged sea inlets. The `c > -0.05` guard keeps genuine ocean out of RIVER.
  // No downstream contract changes: RIVER's surface is already sand (below) and
  // river columns still obey §7.2's submerged override.
  if (riv > 0.5 && height <= 62 && c > -0.05) return RIVER;
  if (height <= 59) return OCEAN;
  // §6.2 DEVIATION (64/0.05 → 63/0.02): because coastal relief was zeroed, land
  // near the coast sat in the 60–64 band for hundreds of blocks and c < 0.05 spans
  // ~half the world, so beach measured 12.4% of ALL columns ≈ 24% of all LAND —
  // sand plains, not shores. §15's acceptance line "sand columns ring every
  // ocean/land boundary where height 60–64 and c < 0.05" must now be read as
  // 60–63 / c < 0.02; the ring itself survives because §7.2's submerged rule
  // already lays sand on every column with 56 <= height < 63.
  if (height <= 63 && c < 0.02) return BEACH;
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
  undefined,                                  // the_end (dim-2 only)
  // B12 STABILITY CONTRACT — index 12 byte-equals the plains entry so a masked
  // (HOLLOW) column re-derives the identical tree plan from a neighbour chunk.
  // Unreachable in practice (the chunk-centre column is never masked and only
  // centre reads consult TREE_CFG), kept equal for belt-and-braces.
  { count: 1, chance: 1 / 20, mix: 'oak' },   // hollow (mirrors plains, B12)
];

export const GRASS_COUNT  = [0, 0, 0, 40, 12, 12, 0, 50, 8, 0, 6, undefined, 40];   // B12: 12 mirrors plains
export const FLOWER_COUNT = [0, 0, 0, 6, 3, 3, 0, 2, 0, 0, 0, undefined, 6];        // B12: 12 mirrors plains
export const CANE_BIOMES = new Set([BEACH, RIVER, DESERT, PLAINS, FOREST, SAVANNA,
                                    BIOMES.HOLLOW]);   // B12: per-column gate reads masked ids on revisits
export const PUMPKIN_BIOMES = new Set([PLAINS, FOREST, BIOMES.HOLLOW]);   // B12: same reason

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
  undefined,                                                 // the_end
  // B12 STABILITY CONTRACT — index 12 byte-equals the plains table so a herd
  // re-rolled over an already-masked column picks the same species (rollHerd
  // re-simulates on chunk revisits, when the mask has long since been applied).
  [['cow', 4], ['sheep', 4], ['pig', 3], ['chicken', 3]],   // hollow (mirrors plains, B12)
];
