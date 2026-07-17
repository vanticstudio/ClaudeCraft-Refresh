// 08 §5.2 / §5.2.4 / §5.5 / §5.6 — enchantment effects that are shared across
// call sites: the armor EPF system, Thorns, Looting, and the Silk Touch /
// Fortune drop rules.
//
// Per §1: "Every enchant lookup in this file goes through getEnchantLvl; it
// returns 0 for null stacks — call sites never null-check." That is honored
// throughout: every function here is safe on null/absent gear.

import { getEnchantLvl } from './tags.js';
// §5.6.3's math lives in the leaf module fortune.js (registry/blocks.js needs it
// and must not import this file) — re-exported so call sites have one door in.
export { fortuneM, fortuneChance } from './fortune.js';
import { ENCH } from './enchants.js';

// -------------------------------------------------- §5.2.1 armor EPF
//
// EPF(damageType) = Σ over 4 worn pieces of Σ applicable enchant EPF per §5.1
// damage ×= 1 − min(EPF, 20) / 25         (hard cap 20 ⇒ max 80% reduction)
//
// The map below is §5.2.1's applicability table, keyed by this codebase's damage
// source strings (Entity.js). Per-level EPF values come from §5.1: protection 1,
// fire/blast/projectile protection 2, feather falling 3.

const PROT = [ENCH.PROTECTION, 1];
const EPF_GROUPS = {
  melee: [PROT],
  cactus: [PROT],
  thorns: [PROT],
  arrow: [PROT, [ENCH.PROJECTILE_PROTECTION, 2]],
  explosion: [PROT, [ENCH.BLAST_PROTECTION, 2]],
  // §5.2.1 note *: the falling anvil is folded into blast for simplicity.
  anvil: [PROT, [ENCH.BLAST_PROTECTION, 2]],
  fire: [PROT, [ENCH.FIRE_PROTECTION, 2]],
  burn: [PROT, [ENCH.FIRE_PROTECTION, 2]],
  lava: [PROT, [ENCH.FIRE_PROTECTION, 2]],
  fall: [PROT, [ENCH.FEATHER_FALLING, 3]],
  drown: [PROT],
  suffocate: [PROT],
  // §5.2.1: starvation and void take "— none —".  'starve' and 'void' are
  // deliberately absent. 'generic' is not in §5.2.1's table at all; it is the
  // unused default arg of hurt(). It is mapped to protection on the strength of
  // §5.1's "protection: vs nearly all damage" — starve/void are the only stated
  // exclusions. Logged in DEVIATIONS.md.
  generic: [PROT],
};

/** §5.2.1 — total EPF of the worn set against `source`, capped at 20. */
export function epfFor(armorPieces, source) {
  const groups = EPF_GROUPS[source];
  if (!groups) return 0;
  let epf = 0;
  for (const s of armorPieces) {
    if (!s) continue;
    for (const [id, per] of groups) epf += per * getEnchantLvl(s, id);
  }
  return Math.min(epf, 20);
}

/** §5.2.1 — the damage multiplier for `source`. 1.0 when nothing applies. */
export function epfMultiplier(armorPieces, source) {
  return 1 - epfFor(armorPieces, source) / 25;
}

/** §5.2.1 — highest single level of `enchId` among worn pieces (secondary effects). */
export function highestArmorLvl(armorPieces, enchId) {
  let best = 0;
  for (const s of armorPieces) best = Math.max(best, getEnchantLvl(s, enchId));
  return best;
}

/** §5.2.1 — Fire Protection cuts applied fire ticks by floor(ticks × 0.15 × L). */
export function fireTicksAfterProtection(ticks, armorPieces) {
  const lvl = highestArmorLvl(armorPieces, ENCH.FIRE_PROTECTION);
  if (lvl <= 0) return ticks;
  return Math.max(0, ticks - Math.floor(ticks * 0.15 * lvl));
}

/** §5.2.1 — Blast Protection scales explosion knockback by (1 − 0.15 × L). */
export function explosionKnockbackScale(armorPieces) {
  const lvl = highestArmorLvl(armorPieces, ENCH.BLAST_PROTECTION);
  return lvl <= 0 ? 1 : Math.max(0, 1 - 0.15 * lvl);
}

// -------------------------------------------------- §5.2.4 Thorns

/**
 * §5.2.4 — roll Thorns for a hit that just landed on `armorPieces`.
 * Each worn piece with Thorns L rolls rand() < 0.15 × L independently; every
 * success contributes 1 + randInt(4) HP and costs that piece 2 extra durability.
 *
 * Returns [{ slot, damage }] — one entry per proc. The caller applies the damage
 * (source 'thorns') and the durability (Unbreaking-gated), because only it knows
 * the attacker and the armor array's identity.
 */
export function rollThorns(armorPieces, rng = Math.random) {
  const procs = [];
  for (let i = 0; i < armorPieces.length; i++) {
    const lvl = getEnchantLvl(armorPieces[i], ENCH.THORNS);
    if (lvl <= 0) continue;
    if (rng() < 0.15 * lvl) procs.push({ slot: i, damage: 1 + Math.floor(rng() * 4) });
  }
  return procs;
}

// -------------------------------------------------- §5.4 melee weapon enchants

/**
 * §5.4.1 — the `enchBonus` term of AMENDS 05 §13.1's damage formula.
 *   Sharpness  0.5L + 0.5  vs everything (the Java 1.20 value)
 *   Smite      2.5L        vs undead     ({zombie, skeleton} — §5.1)
 *   Bane       2.5L        vs arthropod  ({spider} — §5.1)
 *
 * Only the held weapon's own enchant applies. The three are mutually exclusive
 * (conflict group DMG), so at most one term is ever non-zero — they are summed
 * rather than branched so an anvil-forced overlap could not silently drop one.
 *
 * The caller scales this by charge and adds it AFTER the crit multiply (§5.4.1:
 * "bonus scales ×p (linear), never ×1.5 crit").
 *
 * NOT applied to sweep secondaries: §6 is Java-1.20-exact and explicitly does
 * not adopt 1.21's Sharpness-boosts-sweep change.
 */
export function meleeEnchBonus(weapon, target) {
  let bonus = 0;
  const sharp = getEnchantLvl(weapon, ENCH.SHARPNESS);
  if (sharp > 0) bonus += 0.5 * sharp + 0.5;
  if (target?.undead) bonus += 2.5 * getEnchantLvl(weapon, ENCH.SMITE);
  if (target?.arthropod) bonus += 2.5 * getEnchantLvl(weapon, ENCH.BANE_OF_ARTHROPODS);
  return bonus;
}

// -------------------------------------------------- §5.5 Looting

/**
 * §5.5 — every uniform drop roll a–b becomes a–(b+L).
 * The base tables are the L=0 column, so callers express their roll as
 * lootedRange(rng, a, b, L).
 */
export function lootedRange(rng, a, b, lvl) {
  const hi = b + Math.max(0, lvl);
  return a + Math.floor(rng() * (hi - a + 1));
}

/** §5.5 — zombie rare drop (carrot/potato): 2.5% + 1%×L. */
export const lootedRareChance = (base, lvl) => base + 0.01 * Math.max(0, lvl);

/** §5.5 — Looting applies only to a player MELEE/sweep killing blow. */
export function lootingLevelOf(source, attacker) {
  if (source !== 'melee') return 0;                      // (approx) bow kills never loot
  return getEnchantLvl(attacker?.heldStack, ENCH.LOOTING);
}

// -------------------------------------------------- §5.6.2 Silk Touch
//
// Drop OVERRIDES for our registry. The harvest-tier rule still applies (a silk
// stone pick on diamond ore drops nothing) — the caller checks harvestOK.
// Mining XP for silk-touched ores is 0 (§5.6.2), which the caller enforces.
//
// Blocks absent from this table take their base drop ("Everything else: base
// drop"), and Silk has no effect on crops, short_grass/dead_bush, fire or mobs.

const SILK_SELF = [
  'glass', 'oak_leaves', 'birch_leaves', 'spruce_leaves',
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'redstone_ore', 'lapis_ore',
  'ice', 'snow_block', 'gravel', 'bookshelf', 'glowstone', 'grass_block',
];

const SILK_OVERRIDES = new Map([
  // stone → stone (not cobblestone) is the one renamed row; the rest drop self.
  ['stone', [{ name: 'stone', count: 1 }]],
  ['snow_layer', [{ name: 'snow_layer', count: 1 }]],
]);
for (const n of SILK_SELF) SILK_OVERRIDES.set(n, [{ name: n, count: 1 }]);

/**
 * §5.6.2 — the Silk Touch drop for a block, or null if Silk does not override it.
 * Returns fresh arrays; never a shared reference.
 */
export function silkDrop(block) {
  const o = SILK_OVERRIDES.get(block?.name);
  return o ? o.map(d => ({ ...d })) : null;
}

/** §5.6.2 — silk-touched ores award 0 mining XP. */
export const silkSuppressesXp = block => SILK_OVERRIDES.has(block?.name);

/**
 * §5.6.2 — "ice → 1 ice; breaking leaves air (suppresses 06 §5.10's water-revert)".
 * The ice block's onBroken refills water; Silk must suppress that. Matched by
 * name, not id, so this module needs no registry import (see fortune.js).
 */
export const silkSuppressesOnBroken = block => block?.name === 'ice';
