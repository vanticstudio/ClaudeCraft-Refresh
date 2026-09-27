// OVERHAUL §B — per-biome color tints (01 §5 render schema extension).
// The mesher bakes a per-vertex `tint` attribute (Uint8×3 normalized) for the
// tintable surfaces — grass_block's +Y face, every face of the three leaf
// species, and every water surface — multiplying the tile texture by the
// biome color in the chunk shader. Pure module: importable from the mesh
// worker (only reads the BIOMES enum).
import { BIOMES } from '../world/gen/biomes.js';

// rgb arrays [r, g, b], values 0..255. Hue families follow the classic
// Minecraft biome palette so tinted grass/leaves/water read as familiar
// terrain variation; the END column is unused (no grass/water there) and
// stays neutral white.
const C = {
  OCEAN:    { grass: [125, 168, 103], foliage: [96, 150, 88],  water: [39, 82, 168] },
  BEACH:    { grass: [145, 189, 89],  foliage: [119, 171, 47], water: [47, 93, 179] },
  RIVER:    { grass: [125, 168, 103], foliage: [96, 150, 88],  water: [43, 88, 173] },
  PLAINS:   { grass: [145, 189, 89],  foliage: [119, 171, 47], water: [63, 118, 228] },
  FOREST:   { grass: [121, 192, 90],  foliage: [89, 174, 48],  water: [63, 118, 228] },
  BIRCH:    { grass: [136, 187, 103], foliage: [106, 156, 66], water: [63, 118, 228] },
  DESERT:   { grass: [191, 183, 85],  foliage: [174, 164, 42], water: [52, 108, 205] },
  SAVANNA:  { grass: [191, 183, 85],  foliage: [174, 164, 42], water: [63, 118, 228] },
  TAIGA:    { grass: [134, 183, 131], foliage: [104, 164, 100], water: [46, 98, 200] },
  SNOWY:    { grass: [128, 180, 151], foliage: [96, 161, 123], water: [57, 94, 180] },
  MOUNTAINS:{ grass: [138, 182, 137], foliage: [109, 163, 107], water: [50, 96, 195] },
  END:      { grass: [255, 255, 255], foliage: [255, 255, 255], water: [255, 255, 255] },
};

const B = BIOMES;
const TABLE = [
  C.OCEAN,      // OCEAN 0
  C.BEACH,      // BEACH 1
  C.RIVER,      // RIVER 2
  C.PLAINS,     // PLAINS 3
  C.FOREST,     // FOREST 4
  C.BIRCH,      // BIRCH_FOREST 5
  C.DESERT,     // DESERT 6
  C.SAVANNA,    // SAVANNA 7
  C.TAIGA,      // TAIGA 8
  C.SNOWY,      // SNOWY_TUNDRA 9
  C.MOUNTAINS,  // MOUNTAINS 10
  C.END,        // THE_END 11
];

/** Biome id → {grass, foliage, water} rgb triples. Unknown ids → neutral. */
export function biomeTint(biome) {
  // NEUTRALIZED — the tint pipeline multiplies the tile texture by the biome
  // color, which is only correct over GRAYSCALE tiles (MC's water_still etc).
  // These painters bake their FINAL colors (grass #4f8c34, water #3f76e4), so
  // the multiply squared them: grass went dark/muddy, water went near-black
  // navy, leaves over-saturated. Until the painters ship desaturated variants
  // (and untinted UI icons are re-tinted), every tintable surface rides the
  // neutral white below — byte-identical to the pre-§B look.
  return C.END;
}

export const NEUTRAL_TINT = C.END.grass;
