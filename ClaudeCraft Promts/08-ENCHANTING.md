# 08 — Enchanting & Combat Extensions

This file adds the full Java 1.20 enchanting stack to VoxelCraft: the enchanting table (bookshelf power, the exact offer algorithm, lapis + level costs, per-player enchantment seed), the complete enchantment catalog (24 enchantments with exact level thresholds, weights, conflicts, and per-level effect formulas), the anvil (combine/repair/rename with prior-work penalty, damage states, falling-anvil damage), the grindstone (disenchant + XP refund), the enchanted book item, the 1.9 **sweep attack** (previously skipped in 05 §13.5), and the **offhand slot** (previously excluded in 06 §14.1). It also owns the canonical **item-stack `tags` extension** used by every expansion file. Baseline: Java Edition ~1.20, exact wiki values unless marked `(approx)`. **Curses (Binding/Vanishing) are OUT of scope** — no curse exists anywhere in this build; the only treasure enchantment is Mending. Cross-refs: breaking formula 03 §15, combat math 05 §13–14, drops 05 §2/§15, arrows 05 §11, registries 06 §2/§7, XP 06 §13, inventory 06 §14, save schema 01 §16. Sound events here are **named hooks only** — 16-AUDIO implements them (§12).

## Amendments to base files

- AMENDS CLAUDE.md §7 (Out of scope v2): ensure the out-of-scope list excludes "enchanting", "offhand slot", "sweep attacks", "looting/fortune/silk touch" — all in scope, specified entirely by 08-ENCHANTING.md.
- AMENDS 01 §15.1: add keybind row: `Swap offhand | KeyF | swaps main-hand (selected hotbar) stack ↔ offhand slot (08 §7); in inventory screens, F swaps the hovered slot ↔ offhand`.
- AMENDS 01 §16.1: player record gains two fields: `enchantSeed: uint32` (08 §3.3) and `offhand: {id, count, durability?, tags?} | null`. Every serialized item stack — `player.inventory[]`, `armor[]`, `offhand`, chest slots, furnace slots, item entities — gains an optional `tags` object as defined in 08 §1 (absent for vanilla stacks; must round-trip through structured clone unchanged).
- AMENDS 03 §3: add input row: `F | Swap held item ↔ offhand (08 §7)`. Also add to the §3 table note: F is ignored while an item-use channel is active mid-bow-draw (draw cancels, no arrow fired).
- AMENDS 03 §12.3: replace "No Jump Boost / Feather Falling modifiers" with: "Feather Falling and Protection reduce fall damage via the EPF system in 08 §5.2, applied inside `damage()` after the (nonexistent) armor step."
- AMENDS 03 §15.2: replace the comment line `// (hook: + efficiency^2+1, ×(0.2·haste+1), ×0.3^fatigue — all out of scope)` with live code per 08 §5.6: after `speed` is set, `if (isBestTool && speed > 1 && efficiencyLvl > 0) speed += efficiencyLvl*efficiencyLvl + 1;`. Replace `if player.eyeSubmerged: speed /= 5 // no Aqua Affinity in scope` with `if (player.eyeSubmerged && helmetLacksAquaAffinity) speed /= 5;` (08 §5.3). The onGround ÷5 is unaffected by any enchant.
- AMENDS 03 §16.1: the RMB priority list becomes a two-hand loop per 08 §7.3 — run steps 1–5 for the **main hand**; if and only if the main-hand item has no action for this context (returns *pass*), rerun steps 3–4 for the **offhand**. Step 2's interactable set grows to include `enchanting_table`, `anvil`, `grindstone` (08 §2).
- AMENDS 03 §20.5: death drops include the offhand slot (it is cleared with the rest of the inventory).
- AMENDS 05 §13.1: the damage formula gains the melee enchantment bonus with vanilla scaling: `damage = base × (0.2 + 0.8p²) × (crit ? 1.5 : 1) + enchBonus × p`. `enchBonus` = Sharpness/Smite/Bane bonus vs the target (08 §5.4). Note: the bonus scales **linearly** with charge and is **not** multiplied by the crit ×1.5 (Java exact).
- AMENDS 05 §13.5: replace the section body ("Skipped…") with: "Implemented — full spec in 08 §6. Every sword swing that meets 08 §6.1's conditions damages all secondary targets in the sweep volume."
- AMENDS 05 §14.2: armor durability loss (`max(1, floor(damage/4))` per piece) is gated per point by Unbreaking (08 §5.7); Thorns adds +2 durability loss on proc (08 §5.2.4).
- AMENDS 05 §14.3: replace "Knockback Ⅰ/Ⅱ enchantments: out of scope" with: melee knockback strength = `0.4 + 0.5 × (knockbackLvl + (sprinting ? 1 : 0))` (08 §5.4.2).
- AMENDS 05 §15: (a) replace both "Looting: skipped" notes (death sequence step 2 and §2's drop-table header) with the Looting drop rules in 08 §5.5 — the §2 tables stay as the L=0 column; (b) XP-orb pickup: before adding points, run the Mending repair step in 08 §5.8 (repairs 2 durability per XP on one random damaged Mending item among armor + both hands; leftover value becomes points).
- AMENDS 05 §11: bow release applies Power/Punch/Flame/Infinity per 08 §5.9; ammo search order becomes offhand → main hand → inventory slots 0–35 (08 §7.4); arrows fired with Infinity set `noPickup = true` and are never collectible.
- AMENDS 06 scope paragraph ("Scope decisions (final)"): move "enchanting/anvil/fortune/silk touch" and "offhand slot" from EXCLUDED to INCLUDED-via-08.
- AMENDS 06 §1: replace "**Drops with no silk touch / fortune**: base rates below are final." with: "The §2 drop columns are the unenchanted base rates; Silk Touch overrides per 08 §5.6.2 and Fortune modifiers per 08 §5.6.3 apply on top."
- AMENDS 06 §7.1 (durability spend paragraph): every durability decrement listed there rolls Unbreaking per point per 08 §5.7 (a −2 spend rolls twice).
- AMENDS 06 §7.4: item 343 `lapis_lazuli` note becomes "enchanting currency (08 §4); still no dye use."
- AMENDS 06 §13: replace the "No sinks" bullet with: "XP sinks: enchanting table (1–3 levels, 08 §4.5), anvil (1–39 levels, 08 §8), partially refunded by the grindstone (08 §9). Pause/death screens keep showing Score = total XP earned (lifetime counter, unaffected by spending)." Spending uses `subtractLevels` from 08 §3.2.
- AMENDS 06 §14.1: replace "**No offhand slot.**" with: "Offhand slot = index **45** (08 §7). Player screen renders it left of the 2×2 craft grid with a pale shield-silhouette placeholder icon."
- AMENDS 06 §14.2: add row: `F | hovering a slot | swap hovered slot ↔ offhand (45)`.
- AMENDS 06 §15.2: tooltips become multi-line: line 1 name (italic if renamed via `tags.name`); one line per enchant "Name Roman-numeral" in light purple #a8a8ff; damaged tools still append `dur/max`.
- AMENDS 06 §16 (merge row): item entities merge only when `id`, `durability`, **and deep-equal `tags`** all match.
- AMENDS 06 §18: item-stack serialization becomes `{id:uint16, count:uint8, damage:uint16?, tags?:object}` everywhere (chest, item entities, player). Player row gains `offhand` and `enchantSeed`.

## Contents

1. [Canonical item-stack `tags` extension](#1-canonical-item-stack-tags-extension)
2. [Registry additions: blocks, items, recipes, textures](#2-registry-additions)
3. [XP plumbing: level math & enchantment seed](#3-xp-plumbing)
4. [Enchanting table](#4-enchanting-table)
5. [Enchantment catalog](#5-enchantment-catalog)
6. [Sweep attack](#6-sweep-attack)
7. [Offhand slot](#7-offhand-slot)
8. [Anvil](#8-anvil)
9. [Grindstone](#9-grindstone)
10. [Enchanted book](#10-enchanted-book)
11. [Glint rendering](#11-glint-rendering)
12. [Sound event hooks (for 16-AUDIO)](#12-sound-event-hooks)
13. [Persistence](#13-persistence)
14. [Acceptance checklist](#acceptance-checklist)

---

## 1. Canonical item-stack `tags` extension

**This section is the single definition used by all expansion files (07–16).** The base item stack `{slot, id, count, durability?}` (01 §16.1) gains one optional field:

```ts
tags?: {
  enchants?:   Array<{ id: uint8, lvl: uint8 }>,  // sorted ascending by id; never empty if present
  name?:       string,                            // anvil rename, ≤ 50 chars (08 §8.4)
  anvilUses?:  uint8,                             // prior-work counter n; penalty = 2^n − 1 (08 §8.2)
  potionId?:   uint8,                             // defined & owned by 09-POTIONS (potions/tipped arrows)
  // future keys may be added by other expansion files; unknown keys must be preserved on load/save
}
```

Rules:
- `tags` is **absent** (not `{}`) on vanilla stacks. Any code path that clones/splits/merges stacks copies `tags` by deep clone.
- Two stacks are **stack-compatible** (inventory merging 06 §14.2, item-entity merging 06 §16, shift-click routing) only if `id`, and `tags` deep-equal (order-normalized), match. Enchanted items are all max-stack 1 except `enchanted_book` inputs handled in §10, so this mostly affects renamed stackables.
- Helper API (single module `items/tags.js`): `getEnchantLvl(stack, enchId) → 0..5`, `setEnchant(stack, enchId, lvl)`, `hasTags(stack)`, `tagsEqual(a, b)`, `clearEnchants(stack)`. Every enchant lookup in this file goes through `getEnchantLvl`; it returns 0 for null stacks — call sites never null-check.
- Enchant ids are the numeric ids in §5.1's catalog table (stable, serialized as-is).

## 2. Registry additions

### 2.1 Final ID assignment (hard range: blocks 105–109, items 346–369)

| ID | Type | Name | Notes |
|---:|---|---|---|
| 105 | block | enchanting_table | §2.2 |
| 106 | block | anvil | §2.2, §8.1 |
| 107 | block | grindstone | §2.2 |
| 108 | block | — reserved (unused by 08) | do not assign in other files |
| 109 | block | — reserved (unused by 08) | do not assign in other files |
| 346 | item | enchanted_book | stack 1, §10 |
| 347–369 | item | — reserved (unused by 08) | do not assign in other files |

### 2.2 Block registry rows (extend 06 §2 and 06 §3 tables verbatim)

Gameplay columns (06 §2 format):

| ID | Name | Hard | Blast | Tool | Tier | Drops | XP on mine |
|---:|---|---:|---:|---|---|---|---|
| 105 | enchanting_table | 5.0 | 1200 | pickaxe | wood | self | 0 |
| 106 | anvil | 5.0 | 1200 | pickaxe | wood | self (damage stage NOT preserved — `> Adaptation:` one anvil item; stage resets on re-place) | 0 |
| 107 | grindstone | 2.0 | 6.0 | pickaxe | wood | self | 0 |

Light/render/physics columns (06 §3 format):

| ID | Name | Emit | Opac | Pass | Shape | Grav | Solid |
|---:|---|---:|:---:|:---:|---|:---:|---|
| 105 | enchanting_table | 0 | T | op | custom: 12/16-height box + floating book | — | yes (12/16 h collision box) |
| 106 | anvil | 0 | T | op | custom: 3 stacked boxes (base 12×4×12 px, waist 6×5×8, top 16×5×10) | **yes** (§8.6) | yes (full cube `(approx)`) |
| 107 | grindstone | 0 | T | op | custom: wheel 8×12×12 px + two 2×7×2 leg posts | — | yes (full cube `(approx)`) |

All three carry the `interactable` registry flag (03 §16.1 step 2 opens their UI on right-click unless sneaking). Anvil state nibble: bits 0–1 facing (set toward player on place, visual only), bits 2–3 **damage stage** 0 = pristine / 1 = chipped / 2 = damaged (stage 3 = destroyed → block removed, never stored). Enchanting table and grindstone use state 0.

Enchanting-table cosmetic: floating book = two 6×8 px canvas-textured quads hinged along a shared spine edge, hovering `y = 12/16 + 0.15 + 0.05·sin(worldTime/16)` above the block base, yaw-lerping (0.1/tick) to face the nearest player within 4 blocks; no page-flip animation. While the table UI is open, spawn 2 glyph particles/tick: white 1-px glyph sprites drifting from random active bookshelf positions toward the book, lifetime 20–30 ticks (cosmetic only, uses 01's Particles helper).

### 2.3 Crafting recipes (extend 06 §10.1; notation per 06 §10)

| Output ×qty | Type | Pattern | Key | 2×2 |
|---|---|---|---|:--:|
| enchanting_table ×1 | shaped | `.B./DOD/OOO` | B book, D diamond, O obsidian | |
| anvil ×1 | shaped | `III/.i./iii` | I iron_block, i iron_ingot (= 31 ingots total) | |
| grindstone ×1 | shaped | `SCS/P.P` | S stick, C stone, P any planks | |

> Adaptation: the grindstone's vanilla center ingredient is a stone **slab**; no slabs exist in this registry, so full `stone` (smelted from cobblestone, 06 §11.2) substitutes.

### 2.4 Texture recipes (06 §4 vocabulary)

| Surface | Recipe |
|---|---|
| enchanting_table top | `noise(#2a4746, 8)` teal cloth + 4 corner 3×3 px diamond glints #4aedd9 + center 4×4 px open-book pixels #e9e9e9/#d0342c ribbon |
| enchanting_table side | bottom 10 rows `blotch(#1b1029, #3b2754, 6)` (obsidian) + top 2 rows #d0342c cloth overhang + 2×2 px #4aedd9 gem set mid-face |
| enchanting_table bottom | obsidian recipe |
| anvil top | `noise(#3f3f3f, 6)` + 1px #2a2a2a rim; stage 1 adds 2 one-px zigzag cracks #1f1f1f; stage 2 adds 4 cracks + 2 chipped corner pixels transparent |
| anvil side/bottom | `noise(#464646, 8)` + darker #303030 underside rows |
| grindstone wheel side | `rings(#8a8a8a, #6f6f6f)` + 1px #565656 outer rim |
| grindstone wheel tread / legs | `noise(#7f7f7f, 8)` / oak_planks recipe |
| enchanted_book (item sprite, §10) | base book silhouette (06 §8 style): #7a2b20 cover → recolored #6b2f7a violet cover, #e9e9e9 page edge column, 2×2 px #4aedd9 clasp; glint applied dynamically per §11 |
| book floating on table | cover #6b2f7a, pages #e9e9e9, 1px rune pixels #a8a8ff on the open faces |

Icon pipeline: all three blocks render through the standard 48×48 isometric block-icon path (06 §8.2) using their custom meshes.

## 3. XP plumbing

### 3.1 Cumulative level formulas (closes the gap in 06 §13)

06 §13 defines `xpToNext(L)`. Total points at the **start** of level L (exact closed forms of the running sum):

```
totalXpAtLevel(L) = L² + 6L                      (0 ≤ L ≤ 16)
                  = 2.5L² − 40.5L + 360          (17 ≤ L ≤ 31)
                  = 4.5L² − 162.5L + 2220        (L ≥ 32)
```

Reference values (test targets): L15 → 315, L16 → 352, L30 → 1395, L31 → 1507, L39 → 3393. `level(xp)` = largest L with `totalXpAtLevel(L) ≤ xp` (closed-form inverse or binary search — either).

### 3.2 Spending levels

The player's stored scalar remains **total current XP points** (06 §13). Spending N levels preserves the fractional progress into the level (Java behavior):

```js
function subtractLevels(player, n) {
  const L = level(player.xp);
  const frac = (player.xp - totalXpAtLevel(L)) / xpToNext(L);
  const L2 = Math.max(0, L - n);
  player.xp = totalXpAtLevel(L2) + Math.floor(frac * xpToNext(L2));
}
```

`Score` on death/pause screens (06 §15.3) switches to a separate lifetime counter `xpEarnedTotal` (increment-only, persisted) so spending never lowers the score. Death still zeroes current XP per 06 §13.

### 3.3 Enchantment seed

`player.enchantSeed: uint32`. Initialized to `(worldSeed ^ 0x9E3779B9) >>> 0` at first spawn `(approx — MC initializes 0 then rerolls on load)`. **Rerolled only when an enchantment is purchased at the table** (§4.5): `enchantSeed = splitmix32(enchantSeed)`. Persisted (01 §16.1 amendment). All table-offer RNG derives from it via a tiny dedicated PRNG `rng32(seedUint32)` (mulberry32 or splitmix32 — pick one, use it for nothing else; world-gen RNG streams in 02 are untouched).

## 4. Enchanting table

### 4.1 Bookshelf power (exact Java 1.18.2+ rule)

A bookshelf (06 block 50) counts iff it sits in the **5×5 ring at lateral distance exactly 2** from the table, at the table's Y or Y+1 (32 possible positions), and its **gap cell is strictly air**. The gap cell for offset `(dx, dz)` is at `(trunc(dx/2), 0, trunc(dz/2))` relative to the table — truncation toward zero (±2→±1, ±1→0), always at **table height** for both shelf rows. A torch, snow_layer, or any non-air block in the gap disables both shelves of that column.

```js
function shelfPower(t) {                       // t = table block pos
  let n = 0;
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue;
    if (blockAt(t.x + (dx/2|0), t.y, t.z + (dz/2|0)) !== AIR) continue;
    for (let dy = 0; dy <= 1; dy++)
      if (blockAt(t.x + dx, t.y + dy, t.z + dz) === BOOKSHELF) n++;
  }
  return Math.min(n, 15);                      // cap 15
}
```

Recomputed every time the UI opens and on every block change within the 5×5×2 ring + gap cells while open (cheap: re-scan on any setBlock within Chebyshev distance ≤ 2 of the table).

### 4.2 UI

Right-click opens the enchanting screen (pointer-lock release per 03 §16.3): **item slot** (accepts one enchantable item, §4.4), **lapis slot** (accepts only `lapis_lazuli` 343, up to 64), and **three offer buttons** stacked vertically. Button i (i = 0,1,2) shows:

- Left: `i+1` lapis pip icons.
- Center: the revealed enchant — plain text `"<Name> <RomanLvl> …?"` (the `…?` is always appended; the buyer may receive more). `> Adaptation:` no Standard Galactic gibberish font; plain text replaces the vanilla tooltip reveal.
- Bottom-right: the **level requirement** `req[i]` in green, gray when locked.

Button enabled iff: an offer exists (list non-empty), `playerLevel ≥ req[i]`, `lapisCount ≥ i+1`, and the item is enchantable (§4.4). In F4 debug-creative: always enabled, nothing is consumed. Closing the screen returns slot contents to the inventory (craft-grid rule, 06 §14.1).

### 4.3 Offer algorithm (exact)

Offers are a pure function of `(enchantSeed, item type+material, shelfPower)` — re-inserting the same item, or using a different table with equal shelves, shows identical offers (Java parity). Recomputed when the item slot changes or shelf power changes:

```js
function computeOffers(item, b /* shelfPower */, seed) {
  const rng = rng32(seed);
  const req = [], offer = [];
  for (let slot = 0; slot < 3; slot++) {       // NOTE: base is REROLLED per slot (Java exact)
    const base = rng.int(1, 8) + Math.floor(b / 2) + rng.int(0, b);
    req[slot] = slot === 0 ? Math.max((base / 3) | 0, 1)
              : slot === 1 ? ((base * 2 / 3) | 0) + 1
              :              Math.max(base, b * 2);
  }
  for (let slot = 0; slot < 3; slot++) {
    offer[slot] = selectEnchants(rng32((seed + slot) >>> 0), item, req[slot], /*treasure*/ false);
    if (offer[slot].length === 0) req[slot] = 0;   // slot disabled
  }
  return { req, offer };                       // display offer[slot][0]; purchase applies ALL of offer[slot]
}
```

Ranges this produces (verify): 0 shelves → requirements 1–8; 15 shelves → top 2–10, middle 6–21, bottom exactly 30.

`selectEnchants` — the exact three-step Java algorithm:

```js
function selectEnchants(rng, item, cost, treasureAllowed) {
  const E = enchantability(item);              // §4.4 table
  // STEP 1 — modified level
  let lvl = cost + 1 + rng.int(0, (E / 4) | 0) + rng.int(0, (E / 4) | 0);
  const bonus = 1 + (rng.float() + rng.float() - 1) * 0.15;   // triangular 0.85–1.15
  lvl = Math.max(1, Math.round(lvl * bonus));
  // STEP 2 — pool of possible {ench, power}
  const pool = [];
  for (const e of CATALOG) {
    if (!tableApplicable(e, item)) continue;               // §5.1 "Table" column (books: all)
    if (e.treasure && !treasureAllowed) continue;          // Mending only via loot/trades
    for (let p = e.maxLvl; p >= 1; p--)
      if (lvl >= e.minCost(p) && lvl <= e.maxCost(p)) { pool.push({ e, p }); break; }
  }
  if (pool.length === 0) return [];
  // STEP 3 — weighted picks with halving level
  const picked = [weightedTake(rng, pool)];                // weight column §5.1; removes from pool
  while (rng.int(0, 49) <= lvl) {                          // P(extra) = (lvl+1)/50
    removeConflicting(pool, picked[picked.length - 1].e);  // §5.1 conflict groups + self
    if (pool.length === 0) break;
    picked.push(weightedTake(rng, pool));
    lvl = (lvl / 2) | 0;
  }
  if (item.id === BOOK && picked.length > 1)               // books lose one at random (Java exact)
    picked.splice(rng.int(0, picked.length - 1), 1);
  return picked;                                           // [{e, p}] — applied in list order
}
```

`weightedTake`: total = Σ weights; `w = rng.int(0, total−1)`; walk the list subtracting weights until `w < 0`; remove and return that entry.

### 4.4 Enchantability & eligible items

An item may be placed in the table slot iff it appears in §5.1's "Table" column for at least one enchantment **and has no existing enchants** (`tags.enchants` absent — vanilla rejects re-enchanting). Damaged items are allowed. Eligible: all 25 tools/weapons of classes sword/pickaxe/axe/shovel/hoe, bow, shears `(> Adaptation: shears table-enchantable — Java gates this by version; we allow Efficiency/Unbreaking rolls)`, all 16 armor pieces, and `book` (341). Never: flint_and_steel, bucket, enchanted_book, any block-item, food.

Enchantability E by material (wiki-exact; note armor differs from tools for iron and gold):

| Material | Tools/weapons E | Armor E |
|---|---:|---:|
| wood | 15 | — |
| stone | 5 | — |
| iron | 14 | **9** |
| gold | 22 | **25** |
| diamond | 10 | 10 |
| leather | — | 15 |
| netherite (cross-ref 10-NETHER, if/when added) | 15 | 15 |
| book, bow | 1 | — |
| shears | 1 `(approx — vanilla has no table value; treat as 1)` | — |

### 4.5 Costs & purchase

Clicking enabled button i:

1. Consume `i+1` lapis from the lapis slot and `subtractLevels(player, i+1)` — **the requirement `req[i]` is only a gate; only 1/2/3 levels are ever consumed** (Java exact — requirement ≠ cost).
2. Apply every `{e, p}` in `offer[i]` to the item's `tags.enchants`. If the item is a `book`, replace it with `enchanted_book` (346), same slot, carrying the enchants.
3. Reroll `enchantSeed` (§3.3), then recompute offers for the (now-enchanted, hence ineligible → slots blank) item.
4. Fire sound hook `enchant.apply` (§12) + a burst of 8–12 glyph particles at the item slot.

## 5. Enchantment catalog

### 5.1 Master table

Numeric `id` is the serialization id (§1). Weight ⇒ rarity ⇒ anvil multiplier (§8.3): 10 = common (×1 item / ×1 book), 5 = uncommon (×2/×1), 2 = rare (×4/×2), 1 = very rare (×8/×4). "Table" = enchanting-table targets; "Anvil+" = additional targets reachable only via book/anvil. Conflict groups: **PROT** = {0,1,2,3} mutually exclusive; **DMG** = {8,9,10}; **SILK** = {16,17}; **BOW1** = {19,23} (Mending↔Infinity). Feather Falling conflicts with nothing.

| id | Key | Max | Weight | Table | Anvil+ | Conflicts | Per-level effect (exact formulas in §5.2–5.9) |
|---:|---|:--:|---:|---|---|---|---|
| 0 | protection | IV | 10 | all armor | — | PROT | EPF = 1×lvl vs nearly all damage |
| 1 | fire_protection | IV | 5 | all armor | — | PROT | EPF = 2×lvl vs fire/lava/burn; burn time −15%/lvl |
| 2 | blast_protection | IV | 2 | all armor | — | PROT | EPF = 2×lvl vs explosions; expl. knockback −15%/lvl |
| 3 | projectile_protection | IV | 5 | all armor | — | PROT | EPF = 2×lvl vs arrows |
| 4 | feather_falling | IV | 5 | boots | — | — | EPF = 3×lvl vs fall damage |
| 5 | respiration | III | 2 | helmet | — | — | air tick skipped unless randInt(lvl+1)==0 |
| 6 | aqua_affinity | I | 2 | helmet | — | — | cancels submerged ÷5 mining penalty |
| 7 | thorns | III | 1 | chestplate | other armor | — | 15%×lvl per piece: attacker takes 1+randInt(4) |
| 8 | sharpness | V | 10 | sword | axe | DMG | +(0.5×lvl + 0.5) dmg (1.20 value) |
| 9 | smite | V | 5 | sword | axe | DMG | +2.5×lvl dmg vs undead (zombie, skeleton) |
| 10 | bane_of_arthropods | V | 5 | sword | axe | DMG | +2.5×lvl vs arthropods (spider); +Slowness IV (09 hook) |
| 11 | knockback | II | 5 | sword | — | — | +0.5×lvl knockback strength |
| 12 | fire_aspect | II | 2 | sword | — | — | target ignites 80×lvl ticks (4 s/lvl) |
| 13 | looting | III | 2 | sword | — | — | drop maxima +lvl; rare-drop chance +1%×lvl |
| 14 | sweeping_edge | III | 2 | sword | — | — | sweep dmg ratio lvl/(lvl+1) (§6.3) |
| 15 | efficiency | V | 10 | pick/axe/shovel/hoe | shears | — | mining speed += lvl²+1 |
| 16 | silk_touch | I | 1 | pick/axe/shovel/hoe | — | SILK | drop overrides table §5.6.2 |
| 17 | fortune | III | 2 | pick/axe/shovel/hoe | — | SILK | drop multipliers §5.6.3 |
| 18 | unbreaking | III | 5 | every durability item | (incl. shears, flint_and_steel, bow via book) | — | durability skip §5.7 |
| 19 | mending | I | 2 (treasure) | **never at table** | everything with durability | BOW1 | XP orbs repair 2 dur/XP (§5.8) |
| 20 | power | V | 10 | bow | — | — | arrow base dmg 2 → 2 + 0.5×lvl + 0.5 |
| 21 | punch | II | 2 | bow | — | — | +0.6×lvl horizontal arrow knockback |
| 22 | flame | I | 2 | bow | — | — | arrow ignites target 100 t; lights TNT |
| 23 | infinity | I | 1 | bow | — | BOW1 | arrows not consumed (need ≥ 1) |

Excluded from this build (state, do not implement): Depth Strider, Frost Walker, Soul Speed, Swift Sneak (movement systems out of scope), Curse of Binding, Curse of Vanishing, all trident/crossbow/mace/fishing-rod enchants. 13-BOSSES may extend the undead/arthropod tag sets; the tags live here: `undead = {zombie, skeleton}`, `arthropod = {spider}` (per-mob boolean in 05's stat blocks).

### 5.2 Cost thresholds (modified-level ranges per power; wiki/Java exact)

`minCost(p)` and `maxCost(p) = minCost(p) + span`. Used by §4.3 step 2 and the grindstone refund (§9.2).

| Enchant | minCost(p) | span |
|---|---|---:|
| protection | 1 + 11(p−1) | 11 |
| fire_protection | 10 + 8(p−1) | 8 |
| blast_protection | 5 + 8(p−1) | 8 |
| projectile_protection | 3 + 6(p−1) | 6 |
| feather_falling | 5 + 6(p−1) | 6 |
| respiration | 10p | 30 |
| aqua_affinity | 1 | 40 |
| thorns | 10 + 20(p−1) | 50 |
| sharpness | 1 + 11(p−1) | 20 |
| smite / bane_of_arthropods | 5 + 8(p−1) | 20 |
| knockback | 5 + 20(p−1) | 50 |
| fire_aspect | 10 + 20(p−1) | 50 |
| looting / fortune | 15 + 9(p−1) | 50 |
| sweeping_edge | 5 + 9(p−1) | 15 |
| efficiency | 1 + 10(p−1) | 50 |
| silk_touch | 15 | 50 |
| unbreaking | 5 + 8(p−1) | 50 |
| mending | 25p | 50 |
| power | 1 + 10(p−1) | 15 |
| punch | 12 + 20(p−1) | 25 |
| flame | 20 | 30 |
| infinity | 20 | 30 |

Spot checks: Sharpness I = 1–21, V = 45–65; Silk Touch = 15–65; Fortune III = 33–83; Sweeping III = 23–38; Power V = 41–56; Aqua Affinity = 1–41; Thorns III = 50–100 (needs the ×1.15 bonus roll to reach from 30-level offers — correct, Thorns III from a table is possible but rare).

### 5.2.1 Armor EPF system (Protection group + Feather Falling)

Applied inside the shared `hurt()` pipeline (05 §14) **after** the armor-points reduction (or directly on the raw amount for sources armor doesn't reduce):

```
EPF(damageType) = Σ over 4 worn pieces of Σ applicable enchant EPF per §5.1
damage ×= 1 − min(EPF, 20) / 25            // hard cap 20 ⇒ max 80% reduction
```

Type applicability (our damage sources):

| Source | protection | fire_prot | blast_prot | proj_prot | feather_falling |
|---|:--:|:--:|:--:|:--:|:--:|
| melee (mob/player), cactus, thorns | ✔ | | | | |
| arrow | ✔ | | | ✔ | |
| explosion (creeper/TNT), falling anvil | ✔ | | ✔* | | |
| fire tick / lava / burning | ✔ | ✔ | | | |
| fall | ✔ | | | | ✔ |
| drowning, suffocation | ✔ | | | | |
| starvation, void | — none — | | | | |

*Falling anvil counts blast_protection `(approx — Java classes it as its own type reduced by protection only; we fold it into blast for simplicity)`.

Worked example: full Protection IV set = EPF 16 → any hit ×0.36 after armor. Prot IV set + Feather Falling IV boots vs fall: EPF 16 + 12 = 28 → capped 20 → fall damage ×0.2 (a 23-block fall deals 4 HP).

Secondary effects, computed from the **highest single level** among worn pieces (Java exact): fire_protection reduces applied `fireTicks` by `floor(ticks × 0.15 × lvl)`; blast_protection multiplies explosion knockback impact (05 §12.3) by `1 − 0.15 × lvl`.

### 5.2.4 Thorns

When the wearer takes melee or arrow damage (attacker exists): each worn piece with Thorns L rolls `rand() < 0.15 × L`; on success the attacker is dealt `1 + randInt(4)` HP (thorns damage type — armor-applicable, goes through the normal `hurt()` with i-frames; no knockback direction, pass the victim→attacker direction) and that piece loses **2 extra** durability (Unbreaking-gated per point). For arrows, "attacker" = the shooting skeleton. Multiple procs in one hit each apply (i-frame excess rule absorbs overlaps naturally).

### 5.3 Respiration & Aqua Affinity (helmet)

- **Respiration L** (03 §10.2 integration): while `eyeSubmerged`, decrement `air` only when `randInt(L + 1) === 0` — average breath time ×(L+1) (Respiration III ≈ 60 s). Drowning damage cadence once air is empty is unchanged.
- **Aqua Affinity**: removes the `eyeSubmerged` ÷5 mining-speed penalty (03 §15.2 amendment). The `!onGround` ÷5 still applies (floating underwater with Aqua Affinity = ÷5, not ÷25).

### 5.4 Melee weapon enchantments

**5.4.1 Sharpness / Smite / Bane of Arthropods.** `enchBonus` for 05 §13.1's amended formula: Sharpness `0.5L + 0.5` vs everything (Java 1.20 value); Smite `2.5L` vs `undead`; Bane `2.5L` vs `arthropod`. Only the held weapon's own enchant applies; bonus scales ×p (linear), never ×1.5 crit. Bane additionally applies Slowness IV to the arthropod for `20 + randInt(10L)` ticks **iff 09-POTIONS' effect framework is present**; otherwise skip the slow (state in DEVIATIONS if 09 unbuilt). Axes can carry DMG enchants via anvil/books only.

**5.4.2 Knockback.** Melee knockback strength (05 §14.3) becomes `0.4 + 0.5 × (knockbackLvl + (sprinting ? 1 : 0))` — Knockback II sprint-hit = 1.9 strength. Does not affect sweep secondaries (§6.4).

**5.4.3 Fire Aspect.** On a landed melee hit (any charge): `target.setOnFire(80 × L ticks)` (4 s/lvl; fire damage per the mob/player fire rules, 03 §11.3 / 05 §5). Applies to sweep secondaries too (Java 1.20, MC-93669 fixed). No auto-cooked drops (base skip stands). Fire Aspect kills still credit Looting from the same sword.

### 5.5 Looting (replaces 05 §15's / §2's "Looting: skipped")

Applies when the **killing blow** is a player melee hit (or sweep) with a Looting-L weapon. `(approx — Java's projectile/main-hand edge case dropped: bow kills never get Looting here.)` Rules against 05 §2's tables:

- Every uniform drop roll `a–b` becomes `a–(b+L)`: rotten flesh/bones/arrows/gunpowder/string 0–(2+L); ender pearl 0–(1+L); beef/porkchop 1–(3+L); leather/feathers 0–(2+L); mutton 1–(2+L).
- Fixed drops unchanged: sheep wool 1, chicken meat 1.
- Zombie rare drop (carrot/potato, 06 §7.3): chance `2.5% + 1%×L` (Looting III = 5.5%).
- XP values unchanged. Baby animals still drop nothing.

### 5.6 Tool enchantments

**5.6.1 Efficiency.** 03 §15.2 amendment: when `isBestTool && speed > 1`, `speed += L² + 1` (E I…V: +2/+5/+10/+17/+26). Applies to shears on leaves/wool (their 15/5 multipliers count as `speed > 1`). Reference: Efficiency V diamond pick vs stone: speed 34 → dpt (34/1.5)/30 = 0.756 → **2 ticks** (0.1 s); vs obsidian: (34/50)/30 = 0.0227 → 45 ticks (2.25 s).

**5.6.2 Silk Touch — drop overrides for OUR registry (06 §2).** When the held tool has Silk Touch and the **harvest-tier rule still passes** (unchanged — silk stone pick on diamond ore drops nothing), the drop column is replaced as follows; mining XP for silk-touched ores is **0**:

| Block | Silk drop (replaces base) |
|---|---|
| stone | 1 stone (not cobblestone) |
| grass_block | 1 grass_block (not dirt) |
| glass | 1 glass (not nothing) |
| oak/birch/spruce_leaves | 1 matching leaf block (no table-A rolls) |
| coal_ore / iron_ore / gold_ore / diamond_ore / redstone_ore / lapis_ore | 1 matching **ore block**, 0 XP |
| ice | 1 ice; breaking leaves **air** (suppresses 06 §5.10's water-revert) |
| snow_layer / snow_block | 1 snow_layer / 1 snow_block (shovel still required per tier column) |
| gravel | 1 gravel guaranteed (flint roll suppressed; Silk beats Fortune if both — impossible in survival) |
| bookshelf | 1 bookshelf (not 3 books) |
| glowstone | 1 glowstone (unchanged — base already drops self) |

Everything else: base drop. No effect on: crops, short_grass/dead_bush (still shears-gated), fire, mob drops.

**5.6.3 Fortune.** Ore-style multiplier (Java exact): `M = max(1, randInt(0, L+1))` — i.e. draw uniform 0..L+1, clamp up to 1. Distributions: F I → ×1 ⅔, ×2 ⅓ (avg 1.33); F II → ×1 ½, ×2 ¼, ×3 ¼ (avg 1.75); F III → ×1 ⅖, ×2/×3/×4 ⅕ each (avg 2.2).

| Block | Fortune-L drop rule |
|---|---|
| coal_ore / diamond_ore | (1 coal / 1 diamond) × M |
| iron_ore / gold_ore | (1 raw_iron / 1 raw_gold) × M |
| lapis_ore | (4–9 lapis) × M (F III max 36) |
| redstone_ore | 4–5 **+ randInt(0, L)** redstone (F III: 4–8; uniform-bonus rule, not M) |
| gravel | flint chance 10% → 14.29% (I) / 25% (II) / 100% (III); self-drop otherwise |
| leaves: sapling roll | 5% → 6.25% / 8.33% / 10% |
| oak_leaves: apple roll | 0.5% → 0.556% / 0.625% / 0.833% |
| leaves: stick roll | 2% → 2.22% / 2.5% / 3.33% |
| short_grass seeds | 12.5% → 14.29% / 16.67% / 25% |
| wheat_crop stage 7 | seeds 0–(3+L) `(approx of Java's binomial n=3+L, p=0.57)`; wheat count unaffected |
| carrot_crop / potato_crop stage 7 | 2–(5+L) `(approx)` |

Fortune never affects: mining XP, stone→cobblestone, mob drops, glass, ice, obsidian, glowstone (self-drop). Silk Touch and Fortune cannot coexist (conflict) — no priority rule needed.

### 5.7 Unbreaking

Gate every single durability point at every decrement site (06 §7.1 tools, 06 §7.2/05 §14.2 armor, bow, shears, flint_and_steel, hoe tilling, thorns' +2):

```
Tools & weapons & bow (per point):  consume iff randInt(L + 1) === 0     // skip chance L/(L+1)
Armor (per point):                  consume iff rand() < 0.6 + 0.4/(L+1) // skip chance 0.4·L/(L+1)
```

Expected lifetime: tools ×(L+1) (Unbreaking III diamond pick ≈ 6244 uses); armor ×1/(0.6+0.4/(L+1)) (Unbreaking III ≈ ×1.43).

### 5.8 Mending (treasure — never from the table)

Hooks XP-orb pickup (05 §15 amendment). On orb contact, **before** adding points:

```js
function onOrbPickup(player, value) {
  const candidates = [...armor, mainHand, offhand].filter(s => s && getEnchantLvl(s, MENDING) > 0 && s.durability < maxDur(s));
  if (candidates.length > 0) {
    const item = candidates[randInt(candidates.length)];       // ONE random damaged Mending item
    const repair = Math.min(value * 2, maxDur(item) - item.durability);  // 2 durability per 1 XP
    item.durability += repair;
    value -= Math.ceil(repair / 2);                             // leftover continues to the bar
    soundHook('mending.repair');
  }
  player.xp += value; player.xpEarnedTotal += value;            // no chaining to a second item (Java exact)
}
```

Furnace XP (06 §11.1) is awarded directly, not via orbs → **bypasses Mending** `(> Adaptation: consequence of 06's direct-award furnace simplification — state it, keep it)`. Breeding/mob/mining orbs all feed Mending. Mending conflicts with Infinity on bows.

### 5.9 Bow enchantments (plug into 05 §11)

Applied at `shootArrow` from the bow's tags; the arrow entity carries `{powerLvl, punchLvl, flame, noPickup}`:

- **Power L**: arrow damage becomes `dmg = ceil(len(v) × (2 + 0.5L + 0.5))`; the crit bonus `+ randInt(dmg/2 + 2)` then applies on the boosted value (Java order). Full-charge Power V ≈ 15–22 HP.
- **Punch L**: after the normal 0.4 hit knockback, add velocity `(nx × 0.6L, 0.1, nz × 0.6L)` to the target, where `(nx, nz)` = normalized horizontal arrow velocity (Java exact push).
- **Flame**: arrow renders burning (flame particles every 2 ticks); on entity hit `target.setOnFire(100 ticks)` (5 s); on **block** hit against a `tnt` face → ignite the TNT (06 §5.6 ignition source (d): flame arrow). Extinguished (flag cleared) if the arrow enters water.
- **Infinity**: at release, if the player has ≥ 1 arrow (search order §7.4), fire without consuming; the arrow entity sets `noPickup = true` (renders normally, never collectible — like skeleton arrows). No arrow anywhere → cannot draw (unchanged).
- **Unbreaking** gates the bow's −1 per shot (§5.7). **Mending** repairs it via orbs (§5.8).

Skeleton bows are visual only (05 §3) — never enchanted.

## 6. Sweep attack

Implements 05 §13.5 (previously skipped). Java-1.20-exact; the 1.21 change that lets Sharpness boost sweeps is **not** adopted.

### 6.1 Trigger (all conditions, evaluated at attack execution 05 §13.3 when the primary hit LANDS on an entity)

1. Main-hand item is a **sword** (any tier).
2. Attack charge `p ≥ 0.848` (identical threshold to crits, 05 §13.4).
3. Player `onGround`.
4. **Not sprinting** (a sprint-knockback hit never sweeps — Java exact).
5. Horizontal speed this tick `len(v.xz) < 0.25 b/t` `(approx of Java's walkDist-delta < speed-attribute check; net effect: full sprint-speed movement cannot sweep, walking can)`.

Crits and sweeps are mutually exclusive by construction (crit requires falling, sweep requires onGround) — no extra guard needed. A swing that hits no entity does not sweep (1.20 behavior). Sweeping costs no extra durability or exhaustion beyond the normal attack.

### 6.2 Sweep volume & victim set

```
victims = all LivingEntities E such that:
  E ≠ player, E ≠ primaryTarget, E not dead
  AND E.AABB intersects primaryTarget.AABB inflated by (+1.0 X, +0.25 Y, +1.0 Z)   // 1×0.25×1 halo
  AND distSq(player.feet, E.feet) < 9.0                                            // within 3 blocks
```

(Java exact: the halo is centered on the **struck mob's** box, not the player.)

### 6.3 Sweep damage

```
ratio      = sweepingEdgeLvl / (sweepingEdgeLvl + 1)        // 0, 1/2, 2/3, 3/4 for L 0–III
sweepDmg   = 1 + ratio × (weaponBase × (0.2 + 0.8p²))       // weaponBase = 05 §13.2 sword damage
```

No Sharpness/Smite/Bane in the sweep at 1.20 baseline (they entered the sweep only in 1.21 — deliberately excluded; note it in a comment). No crit multiplier. Each victim takes `sweepDmg` through the normal `hurt()` pipeline — **i-frames respected** (a victim just hit by the primary swing's excess rule absorbs per 05 §14). Reference numbers (full charge): plain iron sword → 1 HP to victims; iron + Sweeping I → 4 HP; diamond + Sweeping III → 6.25 HP.

### 6.4 Sweep knockback & side effects

- Victims get knockback at strength `0.4 × 0.8 = 0.32` (**80% of base** — wiki exact), direction = the player's horizontal look direction (all victims pushed the same way, Java exact), applied via 05 §14.3's function in place of its normal knockback (not stacked). Knockback enchant does NOT boost this.
- Fire Aspect ignites victims (§5.4.3); Looting applies to victims killed by the sweep (§5.5).
- **Particle**: one flat white arc quad (24×6 px texture, 40% alpha) spawned 1.7 m in front of the player's eyes at hip height, oriented horizontally, scaling 0.8→1.6 m wide and fading over 6 ticks.
- **Sound hook**: `player.attack.sweep` (§12).

## 7. Offhand slot

### 7.1 Model & layout

New inventory index **45** (06 §14.1 amendment). Holds any stack. It is never selected by 1–9/wheel, never attacks, never mines. Death drops it (03 §20.5 amendment). Shift-click routing: offhand ↔ main region (hotbar first).

### 7.2 F-swap

- In world (pointer locked): `F` swaps the selected hotbar stack ↔ offhand instantly. Swapping counts as a main-hand item switch → resets the attack-charge timer `t` (05 §13.1) and cancels an in-progress bow draw or eat on either hand.
- In any inventory screen: `F` while hovering a slot swaps hovered ↔ offhand (mirrors the 1–9 semantics in 06 §14.2).

### 7.3 Use priority (RMB pipeline, replaces 03 §16.1 single-hand flow)

This is the single **canonical RMB step list** (it supersedes 03 §16.1's single-hand flow; the header's `AMENDS 03 §16.1` restructures 03 into exactly these steps). Sibling files insert against these numbers: **12 §7.1's shovel→dirt_path is step 2b**; **09's potion drink is step 4**.

```
on RMB (press, and every 4 ticks held): run steps 1–5 for the MAIN hand; if the main hand PASSES
(step 5), rerun steps 3–4 for the OFFHAND. Only one hand can be "using" at a time.

  1. raycast; if the target block is interactable (enchanting_table/anvil/grindstone/chest/furnace/
     brewing_stand/…) and !sneaking → open its UI; done. (Hand-independent — evaluated on the main press.)
  2. block-targeted item-on-block use against the hit block (MAIN hand only — vanilla): perform and done —
       2a  hoe → farmland
       2b  shovel → dirt_path (12 §7.1)
       2c  flint_and_steel → ignite fire / prime TNT
       2d  bucket → fill / empty
       2e  shears, bone_meal, …
  3. placeable block item → try place (03 §16.2); on success OR on FAILED-place: done.
  4. self-use item (not tied to a block): food (when hungry), potion / drinkable (09), bow draw,
     throwable (splash/lingering potion, ender_pearl, egg, snowball), armor-equip → start/perform; done.
  5. this hand has no action → PASS (main hand → offhand reruns steps 3–4; offhand pass → no swing).
```

Key consequences (vanilla-faithful): the offhand acts **only when the main hand passes** (reaches step 5) — a failed main-hand action (obstructed placement, food at hunger 20) still consumes the attempt and blocks the offhand that press; pickaxe (no use action) in main + torch in offhand → RMB places the torch via the offhand's step-3 rerun (the classic combo); food in offhand is eaten (offhand step 4) only when the main item has no use; sneak+RMB placement override (03 §16.1) applies per hand. The offhand reruns only steps 3–4 (place + self-use), never step 1 (UI) or step 2 (block-targeted uses) — matching the header amendment. The acting hand runs the use animation/eat channel; only one hand can be "using" at a time.

### 7.4 Offhand & the bow

Arrow consumption order (05 §11 amendment): **offhand stack → main-hand stack → inventory scan slots 0–35 (ascending)**. A bow held in the offhand is drawable via rule §7.3 (main hand must be use-less). Infinity per §5.9.

### 7.5 Rendering & HUD

- **Viewmodel**: offhand item renders mirrored on the left: translate `(−0.56, −0.52, −0.72)`, blocks rotated −45° yaw; items rotated `(0°, +90°, −25°)` (mirror of 03 §19). Offhand use (eating, placing) plays the swing/eat animation on the left model. F-swap plays both hotbar-switch slide animations.
- **HUD**: a single 22×22 slot frame immediately **left of the hotbar** with a 2 px gap, same style (icon, count, durability bar). Rendered **only when the offhand is non-empty** (vanilla). The player screen (06 §14.1) shows slot 45 left of the craft grid with a faint shield-silhouette placeholder when empty.

## 8. Anvil

### 8.1 Block & damage states

Block 106 per §2.2. State bits 2–3 = stage 0 chipped→1 damaged→2; **each successful anvil operation (taking the output) has a 12% chance** to advance one stage; advancing past stage 2 destroys the block (removal + `anvil.destroy` hook + 8 gray break particles; the open UI closes, slot contents return to the player). Average lifetime ≈ 25 uses. Stage only changes the top-face crack texture (§2.4).

### 8.2 Prior-work penalty

`pw(stack) = 2^(tags.anvilUses ?? 0) − 1` → 0, 1, 3, 7, 15, 31… Every successful anvil operation on a result sets `result.tags.anvilUses = max(target.uses, sacrifice?.uses ?? 0) + 1` (rename-only included). The grindstone resets it (§9).

### 8.3 UI & cost algorithm

Screen: **target slot** (left), **sacrifice slot** (right), take-only **output**, a text field (pre-filled with the current display name), and the green/red level cost line. Output recomputes on any change:

```js
function anvilResult(target, sac, newName) {
  if (!target) return null;
  let cost = pw(target) + (sac ? pw(sac) : 0), result = deepClone(target), did = false;

  if (sac && isRepairMaterial(sac.id, target)) {                    // (a) unit repair
    let units = 0;
    while (units < sac.count && units < 4 && damage(result) > 0) {
      result.durability = Math.min(maxDur(result), result.durability + Math.floor(maxDur(result) / 4));
      units++; cost += 1;                                           // 1 level per unit
    }
    if (units === 0) return null; did = true; consumed = units;
  } else if (sac && sac.id === ENCHANTED_BOOK) {                    // (b) book application
    did = mergeEnchants(result, sac.tags.enchants, /*book*/ true);  // adds to cost; false if nothing landed
  } else if (sac && sac.id === target.id) {                         // (c) combine same item
    if (isDamageable(target) && damage(target) > 0) {
      const rem = remaining(target) + remaining(sac) + Math.floor(maxDur(target) * 12 / 100);
      result.durability = Math.min(maxDur(target), rem); cost += 2; did = true;   // combine repair = 2 levels
    }
    if (mergeEnchants(result, sac.tags?.enchants ?? [], /*book*/ false)) did = true;
  } else if (sac) return null;                                      // incompatible pair

  if (newName !== displayName(target)) {                            // (d) rename (±clearing a name)
    result.tags = result.tags ?? {}; result.tags.name = newName || undefined; cost += 1; did = true;
  }
  if (!did) return null;
  result.tags = result.tags ?? {};
  result.tags.anvilUses = Math.max(uses(target), sac ? uses(sac) : 0) + 1;
  return { result, cost, tooExpensive: cost > 39 };                 // 39-level cap (survival)
}

function mergeEnchants(result, list, book) {          // returns true if it changed anything or charged
  let acted = false;
  for (const e of list) {
    if (!anvilApplicable(e.id, result) || conflictsWithExisting(e.id, result)) { cost += 1; acted = true; continue; }
    const cur = getEnchantLvl(result, e.id);
    const lvl = (cur === e.lvl) ? Math.min(cur + 1, maxLvl(e.id)) : Math.max(cur, e.lvl);
    if (lvl > cur || cur === 0) { setEnchant(result, e.id, lvl); acted = true; }
    cost += anvilMult(rarityOf(e.id), book) * lvl;    // charged even if lvl unchanged (Java parity)
  }
  return acted;
}
```

`anvilMult` from §5.1's weights: common ×1/×1(book), uncommon ×2/×1, rare ×4/×2, very rare ×8/×4. `anvilApplicable` = the union of "Table" + "Anvil+" columns. Same-level merge: `min(cur+1, max)`; different: `max`. Non-applicable/conflicting sacrifice enchants are dropped for +1 level each.

Taking the output: consume target + sacrifice (unit repair consumes only `units` materials, remainder stays), `subtractLevels(player, cost)`, roll the 12% degrade (§8.1), fire `anvil.use` hook. `tooExpensive` renders "Too Expensive!" in red and blocks the take (survival; F4 debug-creative ignores cost, pays nothing, still no degrade). Requirement: `playerLevel ≥ cost`.

Worked examples (verify): two fresh Sharpness I iron swords, undamaged → Sharpness II, cost 1×2 = 2. Silk Touch book onto a fresh pick → 4×1 = 4. Protection IV book onto used(1×) chest → pw 1 + 1×4 = 5. Third repair of a pick: pw = 3 both sides → 3+3+2+… escalating to the 39 wall around use 6.

### 8.4 Repair materials & renaming

| Target tier/material | Unit material |
|---|---|
| wooden tools | any planks (5–7) |
| stone tools | cobblestone |
| iron tools & armor | iron_ingot |
| golden tools & armor | gold_ingot |
| diamond tools & armor | diamond |
| leather armor | leather |
| bow, shears, flint_and_steel | no material — combine-only |

Each unit restores `floor(max/4)` durability, max 4 units per operation. Renaming: ≤ 50 chars, stored as `tags.name`, shown italic in tooltips; empty field clears the name (still a +1 rename op if a name existed). Renamed stackables stack only with identically-named stacks (§1).

### 8.5 Slot rules

Target slot accepts anything; sacrifice slot accepts anything (validity computed). Output take-only. Closing returns inputs. Shift-click from player: first empty of target→sacrifice.

### 8.6 Falling anvil

The anvil is a gravity block: reuse 06 §5.1's falling-block entity with three extra fields `{hurtEntities: true, perBlock: 2, maxDmg: 40}`:

- While falling, any LivingEntity whose AABB intersects the entity's takes `min(40, ceil((fallDistance − 1) × 2))` HP (armor-applicable; i-frames dedupe repeat overlaps). A 4-block fall = 6 HP. Helmets lose **double** durability from this damage source (other pieces normal).
- On landing: `5% × floor(blocksFallen)` chance to degrade one stage (if it passes stage 2 → the entity dies, drops nothing, `anvil.destroy`); otherwise re-solidifies with its stage, fires `anvil.land`.
- Landing in a cell it cannot occupy → drops as an anvil item (base rule). Falling ≥ 600 ticks → drops as item (base rule).

## 9. Grindstone

### 9.1 Operations

Screen: two input slots + take-only output. Valid inputs: one enchanted item alone (either slot), two items of the same id, or one `enchanted_book`. Output:

- **Disenchant**: result = the input item with `tags.enchants` removed entirely and `tags.anvilUses` reset to 0 (Java exact) (`tags.name` kept). `enchanted_book` → plain `book` (341).
- **Combine-repair** (two same-id damageable items): `result.durability = min(max, remaining(a) + remaining(b) + floor(max × 5/100))` — note **5%** here vs the anvil's 12%. Enchants from BOTH inputs are stripped; both refund XP. No level cost — the grindstone never costs XP.

Taking the output consumes inputs, spawns the refund orb (§9.2), fires `grindstone.use`.

### 9.2 XP refund (Java exact)

```
S  = Σ over all non-curse enchants on BOTH inputs of minCost(enchant, level)   // §5.2 table
xp = (S > 0) ? ceil(S/2) + randInt(0, ceil(S/2) − 1) : 0                       // uniform ~[S/2, S]
```

Spawned as one XP orb entity (05 §15) at the grindstone — so it feeds **Mending on worn gear** before the bar (deliberate, matches Java orb behavior). Example: disenchanting Sharpness V (minCost 45) + Unbreaking III (21) → S = 66 → 33–66 XP.

## 10. Enchanted book

Item **346**, stack 1, always renders with glint (§11). `tags.enchants` holds 1+ entries (multi-enchant books exist via table books that kept multiple rolls, loot, or book+book anvil combines). Not equippable, not usable, not fuel; its only consumers are the anvil (§8.3 case b — and book+book combining, which follows the same merge rules with book multipliers) and the grindstone (→ plain book).

Sources:
1. **Enchanting a `book`** at the table (§4.5) — Mending excluded (treasure).
2. **Librarian trades** — cross-ref 12-VILLAGES; 12 calls `randomEnchantedBook(rng, level, treasureAllowed=true)` (arg name `level` per §10's signature below).
3. **Loot chests** — cross-ref 10-NETHER (fortress) and 11-END (end city); same helper.

Shared helper (lives here): `randomEnchantedBook(rng, level, treasureAllowed) → stack` = run §4.3's `selectEnchants(rng, BOOK, level, treasureAllowed)` (book-removal rule included), wrap in a 346 stack. This is the **only** survival source of Mending (treasureAllowed=true paths).

## 11. Glint rendering

> Adaptation: chosen approach = **scrolling glint tile composited per surface** (no vanilla dual-UV shader). One 16×16 glint tile is generated at startup: transparent canvas + two 3-px-wide diagonal streaks (45°) colored #a56dff→#e2c7ff gradient with 1-px white cores, wrapping (drawn 3× at x-offsets −16/0/+16).
>
> - **UI icons** (hotbar, inventory, tooltips): enchanted stacks render into a per-slot 20×20 `<canvas>` instead of the atlas-background div: draw the item icon, then `globalCompositeOperation = 'source-atop'` draw the glint tile at 40% alpha with offset `((frame*2) % 16, (frame) % 16)` — source-atop clips the shimmer to the icon silhouette. Re-composited at 4 Hz, only for enchanted slots currently on screen (≤ a dozen canvases; zero cost otherwise).
> - **World surfaces** (dropped-item quads/mini-cubes, held viewmodel, floating table book need none): add a second mesh pass sharing the geometry: `MeshBasicMaterial` with the glint tile as a `CanvasTexture` (RepeatWrapping), `blending: AdditiveBlending`, `opacity 0.35`, `depthWrite false`, `polygonOffset −1` to kill z-fighting; animate `texture.offset.x += 0.008, .y += 0.004` per frame. One shared material instance for every glinted mesh (texture offset animates globally — acceptable).
> - Applies to any stack with `tags.enchants` (and always to item 346). No hue-shift variant — the scrolling streaks ARE the effect.

## 12. Sound event hooks

Named events only — 16-AUDIO owns synthesis/playback; every call site in this file emits `soundHook(name, pos?)` and nothing else (no-op until 16 exists):

| Hook name | Trigger (section) | Vanilla reference |
|---|---|---|
| `enchant.apply` | enchantment purchased at table (§4.5) | block.enchantment_table.use |
| `player.attack.sweep` | sweep executed (§6.4) | entity.player.attack.sweep |
| `anvil.use` | anvil output taken (§8.3) | block.anvil.use |
| `anvil.land` | falling anvil lands (§8.6) | block.anvil.land |
| `anvil.destroy` | anvil degrades past damaged / breaks on fall (§8.1/§8.6) | block.anvil.destroy |
| `grindstone.use` | grindstone output taken (§9.1) | block.grindstone.use |
| `mending.repair` | orb repaired an item (§5.8) | entity.experience_orb.pickup (variant) |
| `item.break` | any tool/armor reaches 0 durability (06 §7.1 — formalizes base's "break sound" note) | entity.item.break |

## 13. Persistence

- **Item stacks everywhere** serialize as `{id, count, damage?, tags?}` (§1; 01 §16.1 + 06 §18 amendments). `tags` is structured-clone-safe plain data; loaders must tolerate unknown `tags` keys (forward-compat with 09+).
- **Player**: + `enchantSeed` (uint32), + `offhand` stack-or-null, + `xpEarnedTotal` (§3.2). Same-seed guarantee: reloading and re-inserting the same item at the same shelf count reproduces identical offers.
- **Blocks**: enchanting table & grindstone are stateless (no block entity). Anvil persists via its state nibble (stage + facing) in the chunk state array — no block entity. The anvil UI's text field and slots are transient (slots return on close; nothing persists mid-edit).
- **Falling anvils**: saved like base falling blocks — written back as an anvil block (stage preserved in state) at their current cell (01 §16.1 rule).
- **Arrows**: stuck arrows already aren't persisted (base); no change from flame/punch flags.
- Save-format version stays 1; absent fields default (no migration): missing `enchantSeed` → derive per §3.3, missing `offhand` → null, missing `tags` → vanilla stack.

---

## Acceptance checklist

Enchanting table
- [ ] Table crafts from `.B./DOD/OOO`, mines with wooden pick (5.0 hardness → 1.9 s with diamond pick per 03 formula), survives a point-blank creeper blast (blast 1200).
- [ ] 0 shelves: all three requirements ∈ 1–8. Full 15-shelf ring with air gaps: bottom slot shows exactly 30; placing a torch in one gap cell drops the count by exactly the shelves behind it (verify via F3 + shelf debug count).
- [ ] Shelves at Y+2, distance 3, or with a blocked gap never count; the 16-shelf "library corner" arrangement still yields 15 (cap).
- [ ] Same item + same shelf count → identical three offers across UI reopen and across save/reload; enchanting anything rerolls all offers; adding shelves changes shown offers but the seed does not advance.
- [ ] Buying slot 3 at requirement 30: needs level ≥ 30 and 3 lapis, consumes exactly 3 levels (progress fraction preserved) and 3 lapis.
- [ ] A gold sword (E=22) rolls visibly stronger/multi enchants than a diamond sword (E=10) at the same displayed level over ~20 trials; multi-enchant frequency scales with level ((lvl+1)/50 halving loop).
- [ ] Enchanting a book can yield a multi-enchant book but drops one roll when multiple were generated; Mending never appears from the table.
- [ ] Already-enchanted items are rejected by the item slot; damaged items are accepted.

Catalog effects (spot checks)
- [ ] Sharpness V diamond sword full charge = 7 + 3 = 10; falling crit = 7×1.5 + 3 = 13.5 (bonus not crit-multiplied); spam clicks scale the bonus by p linearly.
- [ ] Smite V vs zombie = 6 + 12.5 = 18.5 with iron sword (2-hit kill); no bonus vs creeper.
- [ ] Efficiency V diamond pick: stone in 2 ticks, obsidian in 2.25 s; Aqua Affinity helmet mines underwater at land speed while on the bottom (÷5 only when additionally floating).
- [ ] Silk Touch: stone→stone, grass→grass_block, glass→glass, diamond_ore→diamond_ore block with 0 XP, ice→ice leaving air, bookshelf→bookshelf, gravel→always gravel.
- [ ] Fortune III on diamond ore over 500 breaks averages ≈2.2 drops with max 4; redstone yields 4–8; gravel with Fortune III always flints; Fortune and Silk never coexist.
- [ ] Looting III: zombie flesh 0–5, pearls 0–4, carrot/potato chance ≈5.5%; bow kills give base drops.
- [ ] Unbreaking III tool loses ~25% durability per 100 uses (χ² sanity over 400 uses); armor durability loss ≈70% of normal.
- [ ] Mending: holding a damaged Mending pick while collecting a 7-XP orb repairs 14 durability and adds 0 XP; undamaged gear → full 7 XP; furnace output XP never repairs.
- [ ] Full Protection IV armor: creeper 43 → 27.1 (armor) → ×0.36 ≈ 9.8; Feather Falling IV + Prot IV: 23-block fall deals 4 HP; Fire Protection IV halves-and-more burn time (−60%); Thorns III chest procs ≈45% reflecting 1–4 to zombies.
- [ ] Power V full-charge arrows one-shot (≥ 20 HP) most of the time; Punch II visibly shoves targets ~1.2 extra impulse; Flame arrow ignites a pig and TNT; Infinity fires with 1 arrow forever, arrows stuck in walls can't be picked up; Infinity+Mending cannot be combined on an anvil.

Sweep & offhand
- [ ] Standing full-charge sword hit on one zombie of a pack: all zombies overlapping the 1×0.25×1 halo within 3 blocks flash red for 1 HP (plain sword), get pushed along the look direction ~80% strength, sweep particle + hook fire; sprinting or falling or axe hits never sweep.
- [ ] Iron sword + Sweeping Edge I deals exactly 4 HP to secondaries at full charge; primary target takes normal damage only.
- [ ] F swaps held ↔ offhand instantly and resets attack charge; pickaxe main + torch off: RMB places torches; food offhand eats only when main has no use; offhand HUD slot appears left of the hotbar only when filled; offhand drops on death; F over a hovered slot in the inventory swaps with slot 45.
- [ ] Bow consumes offhand arrows before inventory arrows.

Anvil & grindstone
- [ ] Anvil crafts from 3 iron blocks + 4 ingots; falls when unsupported; a 4-block drop onto a cow deals 6 HP and can chip the anvil (5%×4); landing on a torch cell pops the torch per base falling rules.
- [ ] Two fresh Sharpness I iron swords → Sharpness II for 2 levels; Silk Touch book → pick costs 4; unit repair: 1 diamond restores 390 durability of a diamond pick for 1 level + prior work; rename costs 1 and italicizes.
- [ ] Prior work follows 0,1,3,7,15,31; a 6th combine on one item shows "Too Expensive!" (>39); output take has 12% degrade odds → texture stages → block destruction closes the UI.
- [ ] Book multipliers are half item multipliers (Protection IV via book = 4, via armor sacrifice = 8... wait — verify: book ×1 vs item ×1 for common; use Fortune III: book 2×3=6, item 4×3=12).
- [ ] Grindstone strips all enchants, resets prior work to 0, refunds 33–66 XP for Sharpness V + Unbreaking III as an orb (Mending gear intercepts it), combines two damaged pickaxes with +5% bonus, turns an enchanted book into a plain book.

Rendering, sounds, persistence
- [ ] Enchanted items shimmer in hotbar/inventory (silhouette-clipped, animated) and as dropped items/viewmodel (additive pass); plain items never glint.
- [ ] All eight §12 hooks fire at their trigger points (log-assert in debug; zero audio calls).
- [ ] Save/reload round-trips: enchants + names + anvilUses on all stacks (inventory, offhand, chests, dropped items), enchantSeed (same offers), anvil damage stage, lifetime Score unaffected by spending.
- [ ] Tooltips list enchant lines in purple; multi-line panel sizes correctly at 2× GUI scale.
