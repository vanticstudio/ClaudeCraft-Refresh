// 08 §8.2/§8.3/§8.4 — the anvil: prior-work penalty, the cost algorithm,
// enchant merging, and repair materials.
//
// Every durability expression here goes through durability.js's adapters, NOT
// through `.damage` — see that module's header for why (08 writes `durability`
// meaning REMAINING; this codebase stores DAMAGE).
//
// anvilResult() is PURE: it never mutates its inputs and never touches the
// player. The UI calls it to preview, and again (via takeAnvilOutput) to commit.

import { ITEMS } from '../registry/items.js';
import { B } from '../registry/blocks.js';
import {
  cloneStack, getEnchantLvl, getEnchants, setEnchant, customName, NAME_MAX,
} from './tags.js';
import {
  ENCHANTED_BOOK_ID, anvilApplicable, anvilMult, conflicts, maxLvl,
} from './enchants.js';
import { maxDur, damageOf, remaining, setRemaining, isDamageable } from './durability.js';

/** §8.2 — prior-work counter n. */
export const uses = stack => stack?.tags?.anvilUses ?? 0;

/** §8.2 — prior-work penalty = 2^n − 1 → 0, 1, 3, 7, 15, 31… */
export const pw = stack => Math.pow(2, uses(stack)) - 1;

/** The name shown on the item now: an anvil rename if present, else the item's. */
export const displayName = stack =>
  customName(stack) ?? ITEMS.get(stack?.id)?.displayName ?? '';

// -------------------------------------------------- §8.4 repair materials

const REPAIR_BY_MATERIAL = {
  wooden: [B.OAK_PLANKS, B.BIRCH_PLANKS, B.SPRUCE_PLANKS],   // "any planks (5–7)"
  stone: [B.COBBLESTONE],
  iron: [322],        // iron_ingot
  golden: [324],      // gold_ingot
  diamond: [325],     // diamond
  // 10-NETHER AMENDS 08 §8.4 — "treat netherite tools/armor exactly like
  // diamond": the unit material is netherite_ingot. Without this row the
  // name-prefix lookup returns [] and the endgame tier is silently combine-only.
  netherite: [399],   // netherite_ingot
  leather: [330],     // leather
};

/** §8.4 — the unit repair material ids for a target, or [] for combine-only items. */
export function repairMaterials(target) {
  const it = ITEMS.get(target?.id);
  if (!it || !it.durability) return [];
  // §8.4: "bow, shears, flint_and_steel | no material — combine-only".
  if (it.kind === 'bow' || it.kind === 'shears' || it.kind === 'flint_and_steel') return [];
  // 11-END AMENDS 08 §8.4 — elytra repairs with leather (108 durability/leather,
  // max 4 = full 432); 08's generic unit-repair then applies unchanged.
  if (it.name === 'elytra') return [330];
  return REPAIR_BY_MATERIAL[it.name.split('_')[0]] ?? [];
}

export const isRepairMaterial = (sacId, target) => repairMaterials(target).includes(sacId);

// -------------------------------------------------- §8.3 enchant merging

/** Does `enchId` conflict with something already on `result`? (self never conflicts) */
const conflictsWithExisting = (enchId, result) =>
  getEnchants(result).some(e => conflicts(e.id, enchId));

/**
 * §8.3 — merge `list` into `result`, returning {acted, cost}.
 *
 * The spec writes this as a closure mutating the enclosing `cost`; it returns the
 * delta instead so anvilResult stays pure and the arithmetic is testable alone.
 * Semantics are unchanged:
 *  - non-applicable OR conflicting  → dropped, +1 level, still counts as "acted"
 *  - same level                     → min(cur+1, max)
 *  - different level                → max(cur, incoming)
 *  - charged even when the level does not move (Java parity)
 */
export function mergeEnchants(result, list, book) {
  let acted = false, cost = 0;
  for (const e of list ?? []) {
    if (!anvilApplicable(e.id, result) || conflictsWithExisting(e.id, result)) {
      cost += 1; acted = true; continue;
    }
    const cur = getEnchantLvl(result, e.id);
    const lvl = (cur === e.lvl) ? Math.min(cur + 1, maxLvl(e.id)) : Math.max(cur, e.lvl);
    if (lvl > cur || cur === 0) { setEnchant(result, e.id, lvl); acted = true; }
    cost += anvilMult(e.id, book) * lvl;
  }
  return { acted, cost };
}

// -------------------------------------------------- §8.3 the cost algorithm

/**
 * §8.3 — compute the anvil output for (target, sacrifice, newName).
 *
 * Returns null when there is no valid operation, else
 *   { result, cost, tooExpensive, consumed }
 * where `consumed` is how many sacrifice items a unit repair eats (§8.4: the
 * remainder stays in the slot); it is `sac.count` for every other operation.
 *
 * Worked examples from §8.3 (all asserted in the E4 suite):
 *   2 fresh Sharpness I iron swords      → Sharpness II, cost 2
 *   Silk Touch book onto a fresh pick    → cost 4
 *   Protection IV book onto used(1×) chest → cost 5  (pw 1 + 1×4)
 *   Fortune III: via book 2×3=6, via item 4×3=12
 */
export function anvilResult(target, sac, newName = null) {
  if (!target) return null;

  let cost = pw(target) + (sac ? pw(sac) : 0);
  const result = cloneStack(target);
  let did = false;
  let consumed = sac ? sac.count : 0;

  if (sac && isRepairMaterial(sac.id, target)) {
    // (a) unit repair — each unit restores floor(max/4), max 4 units, 1 level each
    let units = 0;
    while (units < sac.count && units < 4 && damageOf(result) > 0) {
      setRemaining(result, remaining(result) + Math.floor(maxDur(result) / 4));
      units++; cost += 1;
    }
    if (units === 0) return null;
    did = true; consumed = units;
  } else if (sac && sac.id === ENCHANTED_BOOK_ID) {
    // (b) book application (also book+book — §10 routes those here)
    const m = mergeEnchants(result, sac.tags?.enchants ?? [], /*book*/ true);
    cost += m.cost; did = m.acted;
  } else if (sac && sac.id === target.id && isDamageable(target)) {
    // (c) combine same item. DEVIATION from §8.3's pseudocode, which tests only
    // `sac.id === target.id`: with a NON-damageable pair the repair body below is
    // skipped and mergeEnchants can never act (only 346 carries enchants, and
    // that is branch (b)) — yet a rename alone sets `did`, and takeAnvilOutput
    // then eats the whole sacrifice stack for one renamed target. Same ruling as
    // DEVIATIONS.md 6 for the grindstone: reject the pair rather than invent an
    // output that destroys an item. The player clears the slot to rename.
    if (damageOf(target) > 0) {
      const rem = remaining(target) + remaining(sac) + Math.floor(maxDur(target) * 12 / 100);
      setRemaining(result, rem);
      cost += 2; did = true;                       // combine repair = 2 levels
    }
    const m = mergeEnchants(result, sac.tags?.enchants ?? [], /*book*/ false);
    cost += m.cost;
    if (m.acted) did = true;
  } else if (sac) {
    return null;                                   // incompatible pair
  }

  // (d) rename (or clearing a name). A null field means "not renaming".
  // §8.4: "empty field clears the name (still a +1 rename op **if a name
  // existed**)" — blanking the pre-filled field on a never-renamed item is a
  // no-op, not a chargeable operation (it must not bump anvilUses either).
  const nm = newName == null ? null : String(newName).slice(0, NAME_MAX);
  if (nm !== null && nm !== displayName(target) && !(nm === '' && customName(target) === null)) {
    result.tags = result.tags ?? {};
    if (nm) result.tags.name = nm; else delete result.tags.name;
    cost += 1; did = true;
  }

  if (!did) return null;

  result.tags = result.tags ?? {};
  result.tags.anvilUses = Math.max(uses(target), sac ? uses(sac) : 0) + 1;

  return { result, cost, tooExpensive: cost > 39, consumed };
}
