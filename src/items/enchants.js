// 08 §5.1/§5.2 — the enchantment catalog: ids, weights, level caps, conflict
// groups, cost thresholds, and target applicability.
//
// The numeric `id` is the SERIALIZATION id written into tags.enchants (08 §1)
// and is frozen by that contract — never renumber. Level values are stored as
// integers 1..max; §5.1's roman numerals are display only.
//
// Curses are out of scope for this whole build (08 header): the only treasure
// enchantment is Mending, and no curse id exists anywhere.

import { ITEMS } from '../registry/items.js';

export const ENCH = {
  PROTECTION: 0,
  FIRE_PROTECTION: 1,
  BLAST_PROTECTION: 2,
  PROJECTILE_PROTECTION: 3,
  FEATHER_FALLING: 4,
  RESPIRATION: 5,
  AQUA_AFFINITY: 6,
  THORNS: 7,
  SHARPNESS: 8,
  SMITE: 9,
  BANE_OF_ARTHROPODS: 10,
  KNOCKBACK: 11,
  FIRE_ASPECT: 12,
  LOOTING: 13,
  SWEEPING_EDGE: 14,
  EFFICIENCY: 15,
  SILK_TOUCH: 16,
  FORTUNE: 17,
  UNBREAKING: 18,
  MENDING: 19,
  POWER: 20,
  PUNCH: 21,
  FLAME: 22,
  INFINITY: 23,
};

export const BOOK_ID = 341;
export const ENCHANTED_BOOK_ID = 346;
export const LAPIS_ID = 343;

// -------------------------------------------------- target predicates (§5.1)
//
// Tokens name the "Table" / "Anvil+" column entries. `book` is handled by the
// callers (§4.3 step 2 treats a book as applicable to everything), not here.

const isArmor = it => it?.kind === 'armor';
const TARGETS = {
  armor: it => isArmor(it),
  helmet: it => isArmor(it) && it.armorSlot === 0,
  chestplate: it => isArmor(it) && it.armorSlot === 1,
  boots: it => isArmor(it) && it.armorSlot === 3,
  // §5.1 Thorns Anvil+ = "other armor" — every armor piece that is not the
  // chestplate (the chestplate is already its Table target).
  armor_other: it => isArmor(it) && it.armorSlot !== 1,
  sword: it => it?.toolClass === 'sword',
  axe: it => it?.toolClass === 'axe',
  digger: it => ['pickaxe', 'axe', 'shovel', 'hoe'].includes(it?.toolClass),
  bow: it => it?.kind === 'bow',
  shears: it => it?.kind === 'shears',
  // §5.1 Unbreaking "every durability item" / Mending "everything with durability".
  durable: it => (it?.durability ?? 0) > 0,
};

const match = (tokens, it) => tokens.some(t => TARGETS[t](it));

// -------------------------------------------------- conflict groups (§5.1)

export const CONFLICT_GROUPS = [
  [ENCH.PROTECTION, ENCH.FIRE_PROTECTION, ENCH.BLAST_PROTECTION, ENCH.PROJECTILE_PROTECTION], // PROT
  [ENCH.SHARPNESS, ENCH.SMITE, ENCH.BANE_OF_ARTHROPODS],                                      // DMG
  [ENCH.SILK_TOUCH, ENCH.FORTUNE],                                                            // SILK
  [ENCH.MENDING, ENCH.INFINITY],                                                              // BOW1
];

/** §5.1 — do two DIFFERENT enchant ids conflict? An id never conflicts with itself here. */
export function conflicts(a, b) {
  if (a === b) return false;
  return CONFLICT_GROUPS.some(g => g.includes(a) && g.includes(b));
}

// -------------------------------------------------- the master table (§5.1 + §5.2)
//
// minCost(p) / span per §5.2; maxCost(p) = minCost(p) + span.

const E = (id, key, name, max, weight, table, anvil, minCost, span, treasure = false) =>
  ({ id, key, name, max, weight, table, anvil, minCost, span, treasure });

export const CATALOG = [
  E(ENCH.PROTECTION, 'protection', 'Protection', 4, 10, ['armor'], [], p => 1 + 11 * (p - 1), 11),
  E(ENCH.FIRE_PROTECTION, 'fire_protection', 'Fire Protection', 4, 5, ['armor'], [], p => 10 + 8 * (p - 1), 8),
  E(ENCH.BLAST_PROTECTION, 'blast_protection', 'Blast Protection', 4, 2, ['armor'], [], p => 5 + 8 * (p - 1), 8),
  E(ENCH.PROJECTILE_PROTECTION, 'projectile_protection', 'Projectile Protection', 4, 5, ['armor'], [], p => 3 + 6 * (p - 1), 6),
  E(ENCH.FEATHER_FALLING, 'feather_falling', 'Feather Falling', 4, 5, ['boots'], [], p => 5 + 6 * (p - 1), 6),
  E(ENCH.RESPIRATION, 'respiration', 'Respiration', 3, 2, ['helmet'], [], p => 10 * p, 30),
  E(ENCH.AQUA_AFFINITY, 'aqua_affinity', 'Aqua Affinity', 1, 2, ['helmet'], [], () => 1, 40),
  E(ENCH.THORNS, 'thorns', 'Thorns', 3, 1, ['chestplate'], ['armor_other'], p => 10 + 20 * (p - 1), 50),
  E(ENCH.SHARPNESS, 'sharpness', 'Sharpness', 5, 10, ['sword'], ['axe'], p => 1 + 11 * (p - 1), 20),
  E(ENCH.SMITE, 'smite', 'Smite', 5, 5, ['sword'], ['axe'], p => 5 + 8 * (p - 1), 20),
  E(ENCH.BANE_OF_ARTHROPODS, 'bane_of_arthropods', 'Bane of Arthropods', 5, 5, ['sword'], ['axe'], p => 5 + 8 * (p - 1), 20),
  E(ENCH.KNOCKBACK, 'knockback', 'Knockback', 2, 5, ['sword'], [], p => 5 + 20 * (p - 1), 50),
  E(ENCH.FIRE_ASPECT, 'fire_aspect', 'Fire Aspect', 2, 2, ['sword'], [], p => 10 + 20 * (p - 1), 50),
  E(ENCH.LOOTING, 'looting', 'Looting', 3, 2, ['sword'], [], p => 15 + 9 * (p - 1), 50),
  E(ENCH.SWEEPING_EDGE, 'sweeping_edge', 'Sweeping Edge', 3, 2, ['sword'], [], p => 5 + 9 * (p - 1), 15),
  // §5.1 lists shears in Efficiency's Anvil+ column, but §4.4's adaptation
  // ("shears table-enchantable — we allow Efficiency/Unbreaking rolls") requires
  // Efficiency to be reachable from the TABLE on shears. Moving the token from
  // anvil→table satisfies §4.4 and leaves anvilApplicable identical, since that
  // is the union of both columns. See DEVIATIONS.md.
  E(ENCH.EFFICIENCY, 'efficiency', 'Efficiency', 5, 10, ['digger', 'shears'], [], p => 1 + 10 * (p - 1), 50),
  E(ENCH.SILK_TOUCH, 'silk_touch', 'Silk Touch', 1, 1, ['digger'], [], () => 15, 50),
  E(ENCH.FORTUNE, 'fortune', 'Fortune', 3, 2, ['digger'], [], p => 15 + 9 * (p - 1), 50),
  E(ENCH.UNBREAKING, 'unbreaking', 'Unbreaking', 3, 5, ['durable'], [], p => 5 + 8 * (p - 1), 50),
  // §5.1: Mending is treasure — "never at table". The `treasure` flag is what
  // enforces that (§4.3 step 2 skips it unless treasureAllowed), so its table
  // column is ['durable'] to make it reachable via §10's treasure book path.
  E(ENCH.MENDING, 'mending', 'Mending', 1, 2, ['durable'], [], p => 25 * p, 50, true),
  E(ENCH.POWER, 'power', 'Power', 5, 10, ['bow'], [], p => 1 + 10 * (p - 1), 15),
  E(ENCH.PUNCH, 'punch', 'Punch', 2, 2, ['bow'], [], p => 12 + 20 * (p - 1), 25),
  E(ENCH.FLAME, 'flame', 'Flame', 1, 2, ['bow'], [], () => 20, 30),
  E(ENCH.INFINITY, 'infinity', 'Infinity', 1, 1, ['bow'], [], () => 20, 30),
];

export const BY_ID = new Map(CATALOG.map(e => [e.id, e]));

export const getEnch = id => BY_ID.get(id) ?? null;
export const maxLvl = id => BY_ID.get(id)?.max ?? 0;
export const minCostOf = (id, p) => BY_ID.get(id)?.minCost(p) ?? 0;
export const maxCostOf = (id, p) => {
  const e = BY_ID.get(id);
  return e ? e.minCost(p) + e.span : 0;
};

// -------------------------------------------------- applicability

const itemOf = stack => (typeof stack === 'number' ? ITEMS.get(stack) : ITEMS.get(stack?.id));

/**
 * §4.3 step 2 — is `e` offerable for this item AT THE TABLE?
 * Books are applicable to everything ("books: all"); the treasure flag, not
 * this predicate, is what keeps Mending off the table for ordinary items.
 */
export function tableApplicable(e, stack) {
  const it = itemOf(stack);
  if (!it) return false;
  if (it.id === BOOK_ID) return true;
  return match(e.table, it);
}

/**
 * §8.3 — anvil target set = union of the Table and Anvil+ columns.
 *
 * Only `enchanted_book` (346) is a universal target: §10's "book+book combining"
 * means enchanted_book + enchanted_book, which §8.3's branch (b) already handles.
 * A PLAIN book (341) is deliberately NOT included — admitting it let the anvil
 * write `tags.enchants` onto a stack-64 item, which §1 forbids outright
 * ("Enchanted items are all max-stack 1 except enchanted_book"). Such a stack
 * glints and merges with copies of itself up to 64. A plain book only ever
 * becomes enchanted at the TABLE, via §4.5's book → 346 rewrite.
 */
export function anvilApplicable(enchId, stack) {
  const e = BY_ID.get(enchId);
  const it = itemOf(stack);
  if (!e || !it) return false;
  if (it.id === ENCHANTED_BOOK_ID) return true;   // §10 book+book combines
  return match(e.table, it) || match(e.anvil, it);
}

// -------------------------------------------------- rarity → anvil multiplier (§8.3)
//
// §5.1: "Weight ⇒ rarity ⇒ anvil multiplier: 10 = common (×1 item / ×1 book),
// 5 = uncommon (×2/×1), 2 = rare (×4/×2), 1 = very rare (×8/×4)."

const MULT = { 10: [1, 1], 5: [2, 1], 2: [4, 2], 1: [8, 4] };

export function anvilMult(enchId, book) {
  const e = BY_ID.get(enchId);
  if (!e) return 0;
  const m = MULT[e.weight];
  return m ? m[book ? 1 : 0] : 1;
}

// -------------------------------------------------- §4.4 enchantability
//
// Material is not a registry field — it is the item-name prefix (`wooden_sword`,
// `leather_helmet`). Names are canonical and generated from these same tables in
// registry/items.js, so the split is stable.

const TOOL_E = { wooden: 15, stone: 5, iron: 14, golden: 22, diamond: 10, netherite: 15 };
const ARMOR_E = { leather: 15, golden: 25, iron: 9, diamond: 10, netherite: 15 };

/** §4.4 — enchantability E by material. */
export function enchantability(stack) {
  const it = itemOf(stack);
  if (!it) return 1;
  if (it.id === BOOK_ID) return 1;
  if (it.kind === 'bow') return 1;
  if (it.kind === 'shears') return 1;         // (approx — vanilla has no value)
  const mat = it.name.split('_')[0];
  const table = it.kind === 'armor' ? ARMOR_E : TOOL_E;
  return table[mat] ?? 1;
}

/**
 * §4.4 — may this stack go in the table's item slot?
 *
 * §4.4 opens with a derived rule ("iff it appears in §5.1's Table column for at
 * least one enchantment") and then gives an explicit enumeration. The two do not
 * agree: Unbreaking's Table column is "every durability item", which would admit
 * `flint_and_steel` — but the enumeration lists it under "Never". The explicit
 * list is the more specific statement of intent, so it is what is implemented
 * here. Logged in DEVIATIONS.md.
 *
 * Eligible: the 25 sword/pickaxe/axe/shovel/hoe tools, bow, shears, the 16 armor
 * pieces, and `book`. Never: flint_and_steel, bucket, enchanted_book, block-items,
 * food. Damaged items ARE allowed; already-enchanted ones are not (vanilla
 * rejects re-enchanting).
 */
export function tableEligible(stack) {
  const it = itemOf(stack);
  if (!it) return false;
  if (stack?.tags?.enchants?.length) return false;
  if (it.id === BOOK_ID) return true;
  if (it.kind === 'armor' || it.kind === 'bow' || it.kind === 'shears') return true;
  return ['sword', 'pickaxe', 'axe', 'shovel', 'hoe'].includes(it.toolClass);
}

// -------------------------------------------------- display (§4.2, AMENDS 06 §15.2)

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
export const roman = n => ROMAN[n] ?? String(n);

/** "Sharpness V" / "Aqua Affinity" (level omitted for max-1 enchants, Java style). */
export function enchantLabel(id, lvl) {
  const e = BY_ID.get(id);
  if (!e) return `Enchant ${id} ${roman(lvl)}`;
  return e.max === 1 ? e.name : `${e.name} ${roman(lvl)}`;
}
