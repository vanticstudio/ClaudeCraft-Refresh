// 08 §5.6.3 — Fortune's drop math.
//
// ---------------------------------------------------------------------------
// THIS MODULE MUST STAY A LEAF — it deliberately imports NOTHING.
// ---------------------------------------------------------------------------
// registry/blocks.js consumes these from inside its per-block `drops` closures,
// and blocks.js is itself a leaf that the whole registry bootstraps from. If
// this math lived in items/effects.js (its natural home), blocks.js would have
// to import it and close the cycle
//
//     blocks.js → effects.js → enchants.js → items.js → blocks.js
//
// which is not merely untidy: registry/items.js builds every block-item by
// iterating `BLOCKS` AT MODULE-EVALUATION TIME. Under that cycle items.js would
// observe a still-empty BLOCKS array and silently generate zero block-items —
// no error, just a game with no placeable blocks. Keep this file dependency-free.
// ---------------------------------------------------------------------------

/**
 * §5.6.3 — the ore multiplier M = max(1, randInt(0, L+1)).
 *
 * `randInt(0, L+1)` is inclusive on BOTH ends. That reading is forced by
 * §5.6.3's own stated distributions: at L=1 it must give ×1 ⅔ / ×2 ⅓ (avg 1.33),
 * at L=2 avg 1.75, at L=3 avg 2.2 — which only hold for a uniform draw over the
 * L+2 values {0…L+1}. (Note §5.7 spells `randInt(n)` the OTHER way, exclusive,
 * Java-style; the spec uses both conventions and each section is read on its own
 * terms.) L=0 collapses to exactly 1, so unenchanted tools take this path safely.
 */
export function fortuneM(lvl, rng = Math.random) {
  const L = Math.max(0, lvl);
  return Math.max(1, Math.floor(rng() * (L + 2)));
}

/**
 * §5.6.3 — probability-style Fortune, indexed by level 0..3.
 *
 * Every percentage §5.6.3 quotes is an exact unit fraction rendered to 3 s.f.
 * (they are Java's own tables): sapling 1/20→1/16→1/12→1/10 = 5/6.25/8.33/10%,
 * apple 1/200→1/180→1/160→1/120, stick 1/50→1/45→1/40→1/30, seeds 1/8→1/7→1/6→1/4,
 * flint 1/10→1/7→1/4→1/1. The fractions are used, not the rounded decimals.
 */
const FORTUNE_TABLES = {
  flint: [1 / 10, 1 / 7, 1 / 4, 1],                       // gravel → flint
  sapling: [1 / 20, 1 / 16, 1 / 12, 1 / 10],              // leaves → sapling
  apple: [1 / 200, 1 / 180, 1 / 160, 1 / 120],            // oak_leaves → apple
  stick: [1 / 50, 1 / 45, 1 / 40, 1 / 30],                // leaves → stick
  seeds: [1 / 8, 1 / 7, 1 / 6, 1 / 4],                    // short_grass → seeds
};

/** §5.6.3 — look up a tabulated Fortune chance. Levels above III clamp to III. */
export function fortuneChance(kind, lvl) {
  const t = FORTUNE_TABLES[kind];
  if (!t) return 0;
  return t[Math.min(Math.max(0, lvl | 0), t.length - 1)];
}
