// 08 §4.1/§4.3/§4.5 + §10 — bookshelf power, the offer algorithm, and the
// shared random-enchanted-book helper.
//
// The offer algorithm is Java-exact and PURE: offers are a function of
// (enchantSeed, item type+material, shelfPower) only. Re-inserting the same item
// at a table with the same shelf count reproduces the same three offers, across
// UI reopen and across save/reload (§4.3, §13).

import { B } from '../registry/blocks.js';
import { cloneStack, setEnchant } from './tags.js';
import { rng32 } from './xp.js';
import {
  CATALOG, BOOK_ID, ENCHANTED_BOOK_ID,
  tableApplicable, enchantability, conflicts, maxCostOf,
} from './enchants.js';

// -------------------------------------------------- §4.1 bookshelf power

/**
 * §4.1 — a bookshelf counts iff it sits in the 5×5 ring at lateral distance
 * exactly 2, at the table's Y or Y+1 (32 positions), AND its gap cell is
 * strictly air. The gap cell for (dx, dz) is at (trunc(dx/2), 0, trunc(dz/2))
 * relative to the table — always at TABLE height for both shelf rows, so one
 * torch in a gap disables both shelves of that column.
 */
export function activeShelves(world, tx, ty, tz) {
  const out = [];
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue;
      // (dx / 2 | 0) truncates toward zero: ±2 → ±1, ±1 → 0. The gap cell is at
      // TABLE height for both shelf rows, so one torch kills both of a column.
      if (world.getBlock(tx + ((dx / 2) | 0), ty, tz + ((dz / 2) | 0)) !== B.AIR) continue;
      for (let dy = 0; dy <= 1; dy++)
        if (world.getBlock(tx + dx, ty + dy, tz + dz) === B.BOOKSHELF)
          out.push({ x: tx + dx, y: ty + dy, z: tz + dz });
    }
  }
  return out;
}

/** §4.1 — the power itself: the count of qualifying shelves, capped at 15. */
export function shelfPower(world, tx, ty, tz) {
  return Math.min(activeShelves(world, tx, ty, tz).length, 15);
}

// -------------------------------------------------- §4.3 selection

/** §4.3 — total = Σ weights; w = int(0, total−1); walk subtracting until w < 0. */
function weightedTake(rng, pool) {
  const total = pool.reduce((s, x) => s + x.e.weight, 0);
  if (total <= 0) return pool.splice(0, 1)[0];
  let w = rng.int(0, total - 1);
  for (let i = 0; i < pool.length; i++) {
    w -= pool[i].e.weight;
    if (w < 0) return pool.splice(i, 1)[0];
  }
  return pool.splice(pool.length - 1, 1)[0];   // unreachable: Σ weights > w always
}

/** §4.3 step 3 — drop everything conflicting with `e`, plus `e` itself. */
function removeConflicting(pool, e) {
  for (let i = pool.length - 1; i >= 0; i--)
    if (pool[i].e.id === e.id || conflicts(pool[i].e.id, e.id)) pool.splice(i, 1);
}

/**
 * §4.3 — the exact three-step Java algorithm.
 * `item` is a stack ({id, ...}); `cost` is the slot's level requirement.
 * Returns [{e, p}] in pick order (applied in list order by §4.5).
 */
export function selectEnchants(rng, item, cost, treasureAllowed) {
  const E = enchantability(item);

  // STEP 1 — modified level
  let lvl = cost + 1 + rng.int(0, (E / 4) | 0) + rng.int(0, (E / 4) | 0);
  const bonus = 1 + (rng.float() + rng.float() - 1) * 0.15;   // triangular 0.85–1.15
  lvl = Math.max(1, Math.round(lvl * bonus));

  // STEP 2 — pool of possible {ench, power}: highest power whose cost band
  // contains lvl, at most one entry per enchantment.
  const pool = [];
  for (const e of CATALOG) {
    if (!tableApplicable(e, item)) continue;
    if (e.treasure && !treasureAllowed) continue;
    for (let p = e.max; p >= 1; p--) {
      if (lvl >= e.minCost(p) && lvl <= maxCostOf(e.id, p)) { pool.push({ e, p }); break; }
    }
  }
  if (pool.length === 0) return [];

  // STEP 3 — weighted picks with halving level; P(extra) = (lvl+1)/50
  const picked = [weightedTake(rng, pool)];
  while (rng.int(0, 49) <= lvl) {
    removeConflicting(pool, picked[picked.length - 1].e);
    if (pool.length === 0) break;
    picked.push(weightedTake(rng, pool));
    lvl = (lvl / 2) | 0;
  }

  // Books lose one roll at random when multiple were generated (Java exact).
  if (item?.id === BOOK_ID && picked.length > 1)
    picked.splice(rng.int(0, picked.length - 1), 1);

  return picked;
}

/**
 * §4.3 — the three offers for (item, shelfPower b, seed).
 * NOTE: `base` is rerolled per slot (Java exact), and each slot's enchant
 * selection uses its OWN generator seeded (seed + slot) — not the shared `rng`.
 */
export function computeOffers(item, b, seed) {
  const rng = rng32(seed);
  const req = [], offer = [];
  for (let slot = 0; slot < 3; slot++) {
    const base = rng.int(1, 8) + Math.floor(b / 2) + rng.int(0, b);
    req[slot] = slot === 0 ? Math.max((base / 3) | 0, 1)
      : slot === 1 ? ((base * 2 / 3) | 0) + 1
        : Math.max(base, b * 2);
  }
  for (let slot = 0; slot < 3; slot++) {
    offer[slot] = selectEnchants(rng32((seed + slot) >>> 0), item, req[slot], /*treasure*/ false);
    if (offer[slot].length === 0) req[slot] = 0;   // slot disabled
  }
  return { req, offer };
}

// -------------------------------------------------- §4.5 purchase

/**
 * §4.5 step 2 — apply every {e, p} to the stack's tags.enchants, returning the
 * resulting stack. A `book` becomes an `enchanted_book` (346) carrying the
 * enchants; everything else keeps its id, damage and other tags.
 *
 * Never mutates the input (tags.js invariant 4: never share a tags reference).
 */
export function applyOffer(stack, list) {
  let out = cloneStack(stack);
  if (out.id === BOOK_ID) { out.id = ENCHANTED_BOOK_ID; out.count = 1; }
  for (const { e, p } of list) out = setEnchant(out, e.id, p);
  return out;
}

// -------------------------------------------------- §10 enchanted book

/**
 * §10 — the shared helper. 12-VILLAGES' librarian trades and 10/11's loot chests
 * call this; it is the ONLY survival source of Mending (treasureAllowed paths).
 * Returns a 346 stack, or null if the roll produced no enchants.
 */
export function randomEnchantedBook(rng, level, treasureAllowed = true) {
  const book = { id: BOOK_ID, count: 1 };
  const picked = selectEnchants(rng, book, level, treasureAllowed);
  if (picked.length === 0) return null;
  return applyOffer(book, picked);
}
