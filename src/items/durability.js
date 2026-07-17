// 08 §5.7 — Unbreaking, plus the durability-model adapter every 08 formula needs.
//
// ---------------------------------------------------------------------------
// MAPPING NOTE — 08's `durability` is REMAINING; this codebase's is DAMAGE
// ---------------------------------------------------------------------------
// §5.8 and §8.3 are written against a stack whose `durability` field counts
// *remaining* uses and rises as an item is repaired:
//
//     result.durability = min(maxDur(result), result.durability + max/4)   // §8.3
//     repair = min(value*2, maxDur(item) - item.durability)                // §5.8
//
// This codebase is the mirror image (Player.damageIn, ItemEntity, hud.js):
//
//     stack.damage      — DAMAGE taken, absent/0 when fresh, counts UP
//     ITEMS.get(id).durability — the MAXIMUM (a constant on the item def)
//     broken when  stack.damage >= item.durability
//
// So `stack.durability` does not exist, and `item.durability` means the exact
// opposite of what §8.3's `result.durability` means. Transcribing either formula
// literally would silently repair in the wrong direction. Every 08 durability
// formula therefore goes through the four adapters below — maxDur / damageOf /
// remaining / setRemaining — and no 08 code touches `.damage` directly.
// See DEVIATIONS.md.
// ---------------------------------------------------------------------------

import { ITEMS } from '../registry/items.js';

/** 08's `maxDur(stack)` — the item type's maximum. 0 for non-damageable items. */
export const maxDur = stack => ITEMS.get(stack?.id)?.durability ?? 0;

/** 08's `damage(stack)` — points of damage taken. */
export const damageOf = stack => stack?.damage ?? 0;

/** 08's `remaining(stack)` / its `stack.durability` — uses left. */
export const remaining = stack => maxDur(stack) - damageOf(stack);

/** True iff this stack has a durability bar at all (§8.3 `isDamageable`). */
export const isDamageable = stack => maxDur(stack) > 0;

/**
 * Assign 08's `result.durability = v` (v = REMAINING), clamped to [0, max].
 * Mutates and returns the stack. `damage` is dropped entirely at full health so
 * a fully-repaired stack is byte-identical to a fresh one (tags.js invariant 1's
 * spirit: absent, not a zero sentinel — it keeps stack-merging working).
 */
export function setRemaining(stack, v) {
  const max = maxDur(stack);
  const rem = Math.max(0, Math.min(max, Math.floor(v)));
  const dmg = max - rem;
  if (dmg <= 0) delete stack.damage;
  else stack.damage = dmg;
  return stack;
}

// -------------------------------------------------- §5.7 Unbreaking
//
// §5.7's `randInt(n)` is Java's nextInt(n): uniform over 0..n−1. (Checked
// against its own stated outcomes: L=0 ⇒ randInt(1)===0 always ⇒ every point
// consumed; L=3 ⇒ 1/4 consumed ⇒ tool lifetime ×4 = ×(L+1).) Note this is a
// DIFFERENT convention from §5.6.3's `randInt(0, L+1)`, which is inclusive on
// both ends — the spec uses both spellings; each is read in its own section.

/**
 * §5.7 — how many of `n` durability points actually land on a tool/weapon/bow.
 * Skip chance per point = L/(L+1); expected lifetime ×(L+1).
 */
export function unbreakingToolPoints(n, lvl, rng = Math.random) {
  if (lvl <= 0) return n;
  let spent = 0;
  for (let i = 0; i < n; i++) if (Math.floor(rng() * (lvl + 1)) === 0) spent++;
  return spent;
}

/**
 * §5.7 — how many of `n` durability points actually land on an ARMOR piece.
 * Consume iff rand() < 0.6 + 0.4/(L+1); expected lifetime ×1/(0.6+0.4/(L+1)).
 */
export function unbreakingArmorPoints(n, lvl, rng = Math.random) {
  if (lvl <= 0) return n;
  const p = 0.6 + 0.4 / (lvl + 1);
  let spent = 0;
  for (let i = 0; i < n; i++) if (rng() < p) spent++;
  return spent;
}
