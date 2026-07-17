// 08 §9 — the grindstone: disenchant, combine-repair, and the XP refund.
//
// The grindstone NEVER costs XP and never charges levels (§9.1).

import { ITEMS } from '../registry/items.js';
import { cloneStack, getEnchants, clearEnchants } from './tags.js';
import { BOOK_ID, ENCHANTED_BOOK_ID, minCostOf } from './enchants.js';
import { maxDur, remaining, setRemaining, isDamageable } from './durability.js';

const hasEnchants = s => (s?.tags?.enchants?.length ?? 0) > 0;

/**
 * §9.1 — strip every enchant and reset prior work. `tags.name` is kept (Java
 * exact); an enchanted_book degrades to a plain book.
 */
function disenchanted(stack) {
  const out = cloneStack(stack);
  clearEnchants(out);
  if (out.tags) delete out.tags.anvilUses;      // reset to 0 == absent (§1: absent, not a sentinel)
  if (out.tags && Object.keys(out.tags).length === 0) delete out.tags;
  if (out.id === ENCHANTED_BOOK_ID) out.id = BOOK_ID;
  return out;
}

/**
 * §9.2 — XP refund, Java exact.
 *   S  = Σ over all enchants on BOTH inputs of minCost(enchant, level)
 *   xp = S > 0 ? ceil(S/2) + randInt(0, ceil(S/2) − 1) : 0
 *
 * §9.2's example ("Sharpness V + Unbreaking III → S = 66 → 33–66 XP") is a
 * rounded statement of the band it labels "~[S/2, S]": the formula's true range
 * is 33–65, which is what Java yields (j + nextInt(j)) and what is implemented.
 * Every outcome still lies inside the quoted 33–66. See DEVIATIONS.md.
 */
export function refundXp(inputs, rng = Math.random) {
  let S = 0;
  for (const s of inputs) {
    for (const e of getEnchants(s)) S += minCostOf(e.id, e.lvl);
  }
  if (S <= 0) return 0;
  const j = Math.ceil(S / 2);
  return j + Math.floor(rng() * j);
}

/**
 * §9.1 — compute the grindstone output for two input slots.
 * Returns { result, xp } or null when the pair has no valid operation.
 * `xp` is spawned as ONE orb at the block (§9.2) so it feeds Mending first.
 */
export function grindstoneResult(a, b, rng = Math.random) {
  const inputs = [a, b].filter(Boolean);
  if (inputs.length === 0) return null;

  if (inputs.length === 1) {
    const s = inputs[0];
    // An enchanted_book always has an operation (→ plain book), even if somehow
    // enchant-less. Anything else must actually carry enchants to be worth doing.
    if (s.id !== ENCHANTED_BOOK_ID && !hasEnchants(s)) return null;
    return { result: disenchanted(s), xp: refundXp([s], rng) };
  }

  // Two inputs must be the same item type (§9.1).
  if (a.id !== b.id) return null;

  // §9.1 defines an output for two same-id inputs only via combine-repair, which
  // is specified for "two same-id DAMAGEABLE items". Two same-id non-damageable
  // stacks (e.g. two enchanted books) have no defined result, and inventing one
  // would silently destroy an item — rejected. See DEVIATIONS.md.
  if (!isDamageable(a)) return null;

  const out = disenchanted(a);
  const max = maxDur(a);
  // note 5% here, vs the anvil's 12%
  setRemaining(out, remaining(a) + remaining(b) + Math.floor(max * 5 / 100));
  out.count = 1;
  return { result: out, xp: refundXp([a, b], rng) };
}

/** §9.1 — will the grindstone accept this stack in an input slot at all? */
export function grindstoneAccepts(stack) {
  if (!stack) return false;
  if (stack.id === ENCHANTED_BOOK_ID) return true;
  return hasEnchants(stack) || isDamageable(stack);
}
