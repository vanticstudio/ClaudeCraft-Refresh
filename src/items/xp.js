// 08 §3 — XP plumbing: cumulative level math, level spending, and the
// dedicated enchantment PRNG.
//
// ---------------------------------------------------------------------------
// MAPPING NOTE (08 §3.2 vs this codebase) — read before touching subtractLevels
// ---------------------------------------------------------------------------
// §3.2 is written against a hypothetical single scalar `player.xp` holding the
// player's *current total* points. This codebase does not have that field. It
// keeps three (Player.js §XP):
//
//   xpLevel   — current level L
//   xpPoints  — points earned *into* level L (i.e. xp − totalXpAtLevel(L))
//   xpTotal   — LIFETIME points, incremented in addXp and never decremented
//
// So the spec's scalar is a derived quantity: xp === totalXpAtLevel(xpLevel) +
// xpPoints  (that identity is `currentXp` below, and it is asserted in the E4
// suite). Transcribing §3.2 literally would require inventing `player.xp` and
// keeping it in sync with the ladder — two sources of truth for the same
// number. Instead subtractLevels() is *mapped* onto (xpLevel, xpPoints); the
// derivation of the equivalence is written out at that function.
//
// A second consequence: §3.2 asks for a new lifetime counter `xpEarnedTotal`
// so that spending never lowers the death/pause Score. `xpTotal` ALREADY has
// exactly that definition and is already what menus.js renders as Score, so
// xpEarnedTotal maps onto it and no field is added. See DEVIATIONS.md.
// ---------------------------------------------------------------------------

/** 06 §13 — points required to advance from level L to L+1. */
export function xpToNext(L) {
  if (L <= 15) return 2 * L + 7;
  if (L <= 30) return 5 * L - 38;
  return 9 * L - 158;
}

/**
 * 08 §3.1 — total points at the START of level L (closed form of Σ xpToNext).
 *
 * §3.1's stated test targets are L15→315, L16→352, L30→1395, L31→1507 and
 * L39→3393. The first four reproduce exactly. **L39 is a spec arithmetic
 * error**: 4.5(39²) − 162.5(39) + 2220 = 2727, which is also what Σ xpToNext
 * gives and what Java gives. The formula is normative and self-consistent, so
 * 2727 stands and the reference value is disregarded. Logged in DEVIATIONS.md.
 */
export function totalXpAtLevel(L) {
  if (L <= 16) return L * L + 6 * L;
  if (L <= 31) return 2.5 * L * L - 40.5 * L + 360;
  return 4.5 * L * L - 162.5 * L + 2220;
}

/** 08 §3.1 — largest L with totalXpAtLevel(L) <= xp. */
export function levelFromXp(xp) {
  if (xp <= 0) return 0;
  let L = 0;
  while (totalXpAtLevel(L + 1) <= xp) L++;
  return L;
}

/** The spec's scalar `player.xp`: current total points, spend-sensitive. */
export function currentXp(player) {
  return totalXpAtLevel(player.xpLevel) + player.xpPoints;
}

/**
 * 08 §3.2 — spend n levels, preserving the fractional progress into the level.
 *
 * §3.2, in its own scalar terms:
 *     L    = level(xp)
 *     frac = (xp − totalXpAtLevel(L)) / xpToNext(L)
 *     L2   = max(0, L − n)
 *     xp   = totalXpAtLevel(L2) + floor(frac × xpToNext(L2))
 *
 * Substituting this codebase's identity xp = totalXpAtLevel(xpLevel) + xpPoints:
 *   - `L` is xpLevel by definition.
 *   - `xp − totalXpAtLevel(L)` is exactly xpPoints — the subtraction is a no-op
 *     here, which is why no totalXpAtLevel call survives in the body.
 *   - the result's level component is L2 and its point component is
 *     floor(frac × xpToNext(L2)), i.e. assigning the two fields IS assigning
 *     the scalar.
 * So this is §3.2 exactly, not an approximation of it.
 *
 * xpTotal (lifetime / Score) is deliberately untouched — §3.2's whole point.
 */
export function subtractLevels(player, n) {
  const L = player.xpLevel;
  const frac = player.xpPoints / xpToNext(L);
  const L2 = Math.max(0, L - n);
  player.xpLevel = L2;
  player.xpPoints = Math.floor(frac * xpToNext(L2));
}

/** True iff the player can afford n levels (08 §4.5 / §8.3 gate). */
export function canAfford(player, n) {
  return player.gameMode === 'creative' || player.xpLevel >= n;
}

// -------------------------------------------------- 08 §3.3 enchantment PRNG
//
// splitmix32. §3.3: "pick one, use it for nothing else" — 02's worldgen seed
// streams are untouched by this module and nothing outside enchanting imports it.

/** Advance a uint32 seed one splitmix32 step. Used for the §4.5 seed reroll. */
export function splitmix32(seed) {
  let a = (seed + 0x9e3779b9) | 0;
  let t = a ^ (a >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t = t ^ (t >>> 15);
  t = Math.imul(t, 0x735a2d97);
  t = t ^ (t >>> 15);
  return t >>> 0;
}

/**
 * 08 §3.3 — a small deterministic PRNG over a uint32 seed.
 * `int(a, b)` is inclusive on BOTH ends: §4.3 calls rng.int(1, 8), rng.int(0, b),
 * rng.int(0, 49) and rng.int(0, total − 1) all expecting b to be reachable.
 */
export function rng32(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x9e3779b9) | 0;
    let t = s ^ (s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return t >>> 0;
  };
  return {
    next,
    float: () => next() / 4294967296,
    int: (a, b) => (b <= a ? a : a + (next() % (b - a + 1))),
  };
}
