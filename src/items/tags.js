// =============================================================================
// 08 §1 — Canonical item-stack `tags` extension.        *** FROZEN CONTRACT ***
// =============================================================================
//
// This module is the SINGLE definition of `tags` for all expansion files
// (07–16). 08 owns it; 09/10/11/12/13 consume it. Do not redefine the shape
// elsewhere, and do not widen it without re-freezing here.
//
// The base item stack (01 §16.1) is `{id, count, damage?}`. It gains ONE
// optional field:
//
//   tags?: {
//     enchants?:   Array<{ id: uint8, lvl: uint8 }>,  // sorted ascending by id
//     name?:       string,                            // anvil rename, <= 50 chars (§8.4)
//     anvilUses?:  uint8,                             // prior work n; penalty 2^n - 1 (§8.2)
//     potionId?:   string,                            // OWNED BY 09-POTIONS (§12.1 registry key, e.g. "speed")
//   }
//
// Reserved key, not defined by 08 §1:
//
//   containerItems? — CLAUDE.md §8.2 lists this as part of 08's schema, but 08
//     §1 does not define it; on the evidence it is 11-END's shulker box. It is
//     reserved here for 11 and arrives through §1's forward-compat clause
//     ("future keys may be added by other expansion files"). 08 defines no
//     shape and no behavior for it — 11 does. It is named in RESERVED_KEYS so
//     that a later file adding it is a deliberate act against this contract
//     rather than a silent collision. See DEVIATIONS.md (E3).
//
// Invariants every consumer may rely on:
//   1. `tags` is ABSENT (not `{}`) on vanilla stacks. `hasTags()` is the test.
//   2. `enchants`, when present, is non-empty and sorted ascending by id.
//   3. Unknown keys are PRESERVED across clone/merge/save/load (forward-compat
//      with 09+). Never rebuild a tags object field-by-field — clone it.
//   4. Any code path that clones/splits/merges stacks copies `tags` by DEEP
//      CLONE. Two stacks must never share a tags reference.
//   5. Stack-compatibility (06 §14.2 merge, 06 §16 item-entity merge,
//      shift-click routing) requires `id` AND order-normalized deep-equal
//      `tags`. Use `tagsEqual()`; never compare tags by identity or JSON.
//
// Enchant ids are the numeric ids from §5.1's catalog (stable, serialized
// as-is). 08's catalog (E4) owns those; this module is id-agnostic on purpose
// so E3 can freeze the container shape before the catalog exists.

/** Keys 08 §1 defines, plus keys reserved for a named owner. Documentation of
 *  intent — nothing enforces it at runtime (§1's rule 3 forbids stripping). */
export const TAG_KEYS = Object.freeze({
  enchants: '08 §5.1',
  name: '08 §8.4',
  anvilUses: '08 §8.2',
  potionId: '09-POTIONS',
});
export const RESERVED_KEYS = Object.freeze({
  containerItems: '11-END (shulker box) — see header',
});

/** Max length of `tags.name` (§8.4). */
export const NAME_MAX = 50;

// ------------------------------------------------------------------ internals

function deepClone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepClone);
  const out = {};
  for (const k of Object.keys(v)) {
    if (v[k] === undefined) continue;
    out[k] = deepClone(v[k]);
  }
  return out;
}

/** Order-normalized deep equality. Object key order is irrelevant; array order
 *  is significant (enchants are sorted by `normTags` before they get here). */
function deepEq(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;      // unequal primitives
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEq(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a).filter(k => a[k] !== undefined).sort();
  const kb = Object.keys(b).filter(k => b[k] !== undefined).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return false;
  for (const k of ka) if (!deepEq(a[k], b[k])) return false;
  return true;
}

/** Coerce either a STACK or a bare tags object to a tags object (or null).
 *
 *  §1's helper list names this one `tagsEqual(a, b)` while every sibling says
 *  `stack` — so a downstream author WILL call `tagsEqual(a.tags, b.tags)`.
 *  Without this, that call compares `undefined.tags` on both sides, collapses to
 *  null === null, and returns TRUE FOR EVERY PAIR: a Sharpness V sword would
 *  merge with a vanilla one and two different potions would stack. A frozen
 *  contract cannot answer wrongly in silence, so both call shapes are accepted.
 *  A stack always carries numeric `id` + `count`; a tags object never does. */
function asTags(v) {
  if (!v || typeof v !== 'object') return null;
  if (typeof v.id === 'number' && typeof v.count === 'number') return v.tags ?? null;
  return v;
}

/** Canonical form of a tags object for comparison: `enchants` sorted by id,
 *  empty/absent collapsed to null so `{}`, `{enchants:[]}` and `undefined` all
 *  compare equal to a vanilla stack. Unknown keys pass through untouched
 *  (invariant 3) so a 09/11 key still participates in equality. */
function normTags(tags) {
  if (!tags) return null;
  const out = {};
  for (const k of Object.keys(tags)) {
    const v = tags[k];
    if (v === undefined) continue;
    if (k === 'enchants') {
      if (!Array.isArray(v) || v.length === 0) continue;   // empty === absent
      out.enchants = v.map(e => ({ id: e.id, lvl: e.lvl })).sort((x, y) => x.id - y.id);
    } else {
      out[k] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Drop `tags` if it has decayed to empty — enforces invariant 1. */
function prune(stack) {
  if (stack.tags && Object.keys(stack.tags).length === 0) delete stack.tags;
  return stack;
}

// ---------------------------------------------------------------- public API

/** True when the stack carries any non-empty tags. */
export function hasTags(stack) {
  return !!(stack && stack.tags && Object.keys(stack.tags).length > 0);
}

/** Level of `enchId` on `stack`, or 0. Returns 0 for null/tagless stacks —
 *  §1: "call sites never null-check". */
export function getEnchantLvl(stack, enchId) {
  const list = stack && stack.tags && stack.tags.enchants;
  if (!list) return 0;
  for (let i = 0; i < list.length; i++) if (list[i].id === enchId) return list[i].lvl;
  return 0;
}

/** All enchants on the stack as a fresh sorted array (never the live one). */
export function getEnchants(stack) {
  const list = stack && stack.tags && stack.tags.enchants;
  if (!list || list.length === 0) return [];
  return list.map(e => ({ id: e.id, lvl: e.lvl })).sort((x, y) => x.id - y.id);
}

/** Set/replace/remove one enchant. `lvl <= 0` removes it. Keeps the list sorted
 *  ascending by id and never leaves an empty `enchants` array or empty `tags`
 *  behind (invariants 1 & 2). Mutates and returns `stack`. */
export function setEnchant(stack, enchId, lvl) {
  if (!stack) return stack;
  if (lvl > 0) {
    if (!stack.tags) stack.tags = {};
    if (!stack.tags.enchants) stack.tags.enchants = [];
    const list = stack.tags.enchants;
    const at = list.findIndex(e => e.id === enchId);
    if (at >= 0) list[at].lvl = lvl;
    else list.push({ id: enchId, lvl });
    list.sort((a, b) => a.id - b.id);
    return stack;
  }
  const list = stack.tags && stack.tags.enchants;
  if (!list) return prune(stack);        // prune, not bare return: clears a pre-existing {}
  const at = list.findIndex(e => e.id === enchId);
  if (at >= 0) list.splice(at, 1);
  if (list.length === 0) delete stack.tags.enchants;
  return prune(stack);
}

/** Strip every enchant, preserving all other tags (grindstone, §9.1). */
export function clearEnchants(stack) {
  if (!stack || !stack.tags) return stack;
  delete stack.tags.enchants;
  return prune(stack);
}

/** Order-normalized deep-equality for §1's stack-compatibility rule.
 *
 *  Accepts EITHER two stacks (`tagsEqual(stackA, stackB)`) or two bare tags
 *  objects (`tagsEqual(a.tags, b.tags)`) — see `asTags`. Nulls are fine. A
 *  tagless stack equals one whose tags are `{}` or `{enchants:[]}`. Unknown
 *  09+/11 keys participate, so a stack carrying one never silently merges with
 *  one that doesn't. */
export function tagsEqual(a, b) {
  return deepEq(normTags(asTags(a)), normTags(asTags(b)));
}

/** Deep clone of a tags object, or undefined when there is nothing to carry.
 *  Preserves unknown keys (invariant 3). */
export function cloneTags(tags) {
  if (!tags) return undefined;
  const out = deepClone(tags);
  // Heal invariant 2 at the choke point. A malformed `{enchants: []}` (a
  // hand-edited save, or a consumer that built tags directly instead of via
  // setEnchant) is otherwise INVISIBLE and permanent: hasTags() calls it
  // tagged, tagsEqual() calls it vanilla, and every clone carries it forward.
  if (Array.isArray(out.enchants) && out.enchants.length === 0) delete out.enchants;
  return Object.keys(out).length ? out : undefined;
}

/** Deep clone of a whole stack in the canonical `{id, count, damage?, tags?}`
 *  shape (§13). The one correct way to copy a stack for split/merge/save —
 *  never spread a stack, or the clones share a tags reference (invariant 4). */
export function cloneStack(s) {
  if (!s) return null;
  const out = { id: s.id, count: s.count };
  if (s.damage !== undefined) out.damage = s.damage;
  const t = cloneTags(s.tags);
  if (t) out.tags = t;
  return out;
}

/** The display name override (`tags.name`), or null. */
export function customName(stack) {
  const n = stack && stack.tags && stack.tags.name;
  return (typeof n === 'string' && n.length) ? n : null;
}

/** 11-END §9.4 — pack a 27-slot container into `tags.containerItems` (skips empty
 *  slots): Array<{slot,id,count,damage?,tags?}>. Returns [] for an empty box. */
export function packContainer(slots) {
  const out = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s) continue;
    const e = { slot: i, id: s.id, count: s.count };
    if (s.damage !== undefined) e.damage = s.damage;
    const t = cloneTags(s.tags);
    if (t) e.tags = t;
    out.push(e);
  }
  return out;
}

/** 11-END §9.4 — restore a slot array from `tags.containerItems`. */
export function unpackContainer(containerItems, n = 27) {
  const slots = new Array(n).fill(null);
  if (!Array.isArray(containerItems)) return slots;
  for (const e of containerItems) {
    if (e && e.slot >= 0 && e.slot < n) {
      const s = { id: e.id, count: e.count };
      if (e.damage !== undefined) s.damage = e.damage;
      const t = cloneTags(e.tags);
      if (t) s.tags = t;
      slots[e.slot] = s;
    }
  }
  return slots;
}
