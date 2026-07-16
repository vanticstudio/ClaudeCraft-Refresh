# AUDIT — Round 2 Expansion Spec Set (files 07–17)

Audit agent pass over the Round-2 expansion specs against the CLAUDE.md §3 governance contract.
Method: full read of 07–17 + CLAUDE.md; targeted verification of AMENDS targets and base IDs in
frozen base specs 01–06. **No spec file was edited.** All recommended fixes land in EXPANSION files
(07–16) or the CLAUDE.md governance doc — base 01–06 are frozen; where the "right" fix would be in a
base file, the fix is expressed as an adjustment to the amending expansion instead.

Counts: **4 CRITICAL, 18 MINOR.** Headline: the `dragon_breath` item is orphaned (09 needs it, 13
declines to build it → lingering potions/tipped-arrow chain broken); three End↔dimension handoff
function names don't match across 10/11/13; every `AMENDS CLAUDE.md §5/§6/§1` instruction targets the
wrong section of the current CLAUDE.md v2; sibling sound-event keys don't match 16's namespace.

---

## Master ID allocation table

Block ids and item ids extracted from every file. Range = the CLAUDE.md §3 grant. **Status: no
collisions, no range violations, no intra-file gaps/typos. CLEAN** — with one caveat (dragon_breath,
C1, which is *referenced but never allocated an id by any file*).

### Blocks

| File | Range | Used | Reserved | In range? |
|---|---|---|---|:--:|
| base | 0–66 | 0–66 | — | ✓ |
| 07 | 70–104 | 70–89 (redstone_wire … redstone_block) | 90–104 | ✓ |
| 08 | 105–109 | 105 enchanting_table, 106 anvil, 107 grindstone | 108–109 | ✓ |
| 09 | 110–114 | 110 brown_mushroom, 111 red_mushroom, 112 brewing_stand | 113–114 | ✓ |
| 10 | 115–149 | 115–143 (netherrack … smithing_table, 29 blocks continuous) | 144–149 | ✓ |
| 11 | 150–169 | 150–164 (stone_bricks … shulker_box) | 165–169 | ✓ |
| 12 | 170–184 | 170–182 (dirt_path … emerald_block) | 183–184 | ✓ |
| 13 | 185–189 | 185 dragon_egg, 186 wither_skeleton_skull, 187 beacon | 188–189 | ✓ |

### Items

| File | Range | Used | Reserved | In range? |
|---|---|---|---|:--:|
| base | 256–345 | 256–345 | — | ✓ |
| 07 | 460–469 | none (components place from block-id stacks; dust from base 342) | 460–469 | ✓ |
| 08 | 346–369 | 346 enchanted_book | 347–369 | ✓ |
| 09 | 370–389 | 370–378 (glass_bottle, potion, splash_potion, lingering_potion, spider_eye, fermented_spider_eye, golden_apple, golden_carrot, tipped_arrow) | 379–389 | ✓ |
| 10 | 390–419 | 390–409 (nether_wart … nether_brick, 20 items continuous incl. netherite tier 400–408) | 410–419 | ✓ |
| 11 | 420–434 | 420 eye_of_ender, 421 chorus_fruit, 422 popped_chorus_fruit, 423 shulker_shell, 424 elytra | 425–434 | ✓ |
| 12 | 435–449 | 435 emerald | 436–449 | ✓ |
| 13 | 450–459 | 450 nether_star, 451 end_crystal | 452–459 | ✓ |

**Effect ids** (09-owned, vanilla numeric): 1,2,3,4,5,6,7,8,10,11,12,13,14,16,17,18,19,20,22,25,28 —
referenced by 08/10/11/13 by number/name only; no redefinition. CLEAN.
**Dimension ids** (10-owned): 0 overworld, 1 nether, 2 end (2 registered by 11). No overlap. CLEAN.
**states bit7** (15-owned = waterlogged): no other file assigns bit7; 07/09/10/11/12/13 all confine
their state nibbles to bits 0–6 (07 wire uses bits0–3 for power, comparator bits0–6; 12 composter
fill 0–8 fits bits0–3; 09/10 explicitly note bit7 untouched). CLEAN.

**Caveat flagged in C1:** `dragon_breath` (a potion-brewing modifier item) is referenced by 09 as
"registered by 13" but no file allocates it an id — the only *missing* allocation in the set.

---

## CRITICAL findings (break a specced feature / genuine cross-file contradiction)

### C1 — `dragon_breath` item is orphaned: 09 requires it, 13 declines to build it
- **Where:** 09 §5 ("dragon_breath is registered by 13-BOSSES"), 09 §12.2 (lingering modifier row
  `dragon_breath (13) | item 372→373`), 09 §14.5 ("13-BOSSES … registers the dragon_breath item");
  vs **13 §6.5** ("Bottling dragon's breath: **skipped** (no glass bottles in scope …)") and 13's
  item registry (§2.3 / §12) which allocates only 450 nether_star + 451 end_crystal.
- **What's wrong:** No file registers a `dragon_breath` item. 09's entire lingering-potion path
  depends on it: `splash_potion (372) + dragon_breath → lingering_potion (373)` is the ONLY brew edge
  producing lingering potions, and lingering potions are the only crafting input to tipped arrows
  (`8 arrow + 1 lingering_potion → 8 tipped_arrow`, 09 §15.1) and to player-thrown AreaEffectClouds.
  So lingering potions, player lingering clouds, and the tipped-arrow crafting chain are all
  unobtainable in survival. This directly undercuts CLAUDE.md E9's gate "splash + **lingering clouds
  work**." Worse, 13's stated reason for skipping ("no glass bottles in scope") is **factually wrong**
  — 09 §11.1 registers `glass_bottle` (item 370).
- **Fix (expansion files):** 13 is the declared owner, so **13 registers `dragon_breath` at reserved
  item id 452** and implements the collect hook it already sketches ("right-click a glass_bottle
  inside a dragon breath cloud → dragon_breath, shrink cloud radius 0.5"), using 09's `glass_bottle`
  (370) and 13's own breath-cloud entity (§6.5). Delete 13 §6.5's false "no glass bottles in scope"
  clause. (Alternative if 13 must stay minimal: move ownership to 09 — assign `dragon_breath` a 09
  reserved id 379 and have 09 implement bottle-in-cloud collection against 13's cloud entity — but 09
  §5/§14.5 explicitly assign ownership to 13, so 13 is the cleaner target.)
- **Note (phase ordering):** even once built, dragon_breath is an End-game drop (E11), so the E9 gate
  clause "lingering clouds work" is only survival-testable after E11; 09's own acceptance checklist
  can still test lingering via the debug palette. Recommend the fixer annotate the E9 gate accordingly.

### C2 — End teleport API name mismatch: 11 calls `Dimensions.teleport`, 10 defines `changeDimension`
- **Where:** 10 §2.5 defines the single dimension-change entry point as
  `changeDimension(entity, targetDim, targetPos, opts)` in `world/dimensions.js`. 11 §1 and §5.4 call
  it `Dimensions.teleport(entity, dimId, pos)` (e.g. `Dimensions.teleport(e, 2, obsidianPlatformSpawn)`).
  13 §Amendments-11 refers to "10's teleport routine."
- **What's wrong:** 11 (the End) is specced to plug into 10's dimension engine "exactly as 10 defines
  it," but the function name it invokes does not exist in 10's API. Implemented verbatim this is an
  undefined-function call on the main progression path (Overworld↔End travel).
- **Fix:** Reconcile to one name. Recommended: 11 uses 10's `changeDimension(...)` verbatim (10 owns
  the engine, per §1), OR 10 exports a `Dimensions.teleport` alias. Edit 11 §1/§5.4 (or add the alias
  note to 10 §2.5). This is a "must fix before implementation" contradiction, hence CRITICAL.

### C3 — End gateway spawn function name mismatch: 11 exports `spawnGateway(k)`, 13 calls `spawnEndGateway(n)`
- **Where:** 11 §11.1 and §6.6 export `spawnGateway(k)`. 13 §Amendments-11(c) and §7.9(tick-200) call
  `spawnEndGateway(gatewaysSpawned)` / `spawnEndGateway(n)`.
- **What's wrong:** The dragon-death → gateway handoff (E11) invokes a function name 11 never defines.
- **Fix:** Unify the name across the handoff. Recommended: rename 13's calls to `spawnGateway(...)` to
  match 11's export (11 owns the block + positions + teleport). Edit 13 §Amendments-11(c) and §7.9.

### C4 — `regenerateSpike(k)` is consumed by 13 but never exported by 11
- **Where:** 13 §Amendments-11(d) and §7.11 (respawn ritual) call `regenerateSpike(k)` "per pillar —
  11 rebuilds each pillar top including the two iron-bar cages." 11 §6.6's `EndArena` export block
  lists only `regenObsidianPlatform` and `spawnGateway(k)` — there is **no** `regenerateSpike` export
  (grep-confirmed absent from 11). 11 §6.3 has the pillar geometry but exposes no per-pillar rebuild.
- **What's wrong:** The dragon-respawn ritual (E11) depends on an 11 helper that 11 does not provide,
  so the ritual's pillar/cage/crystal regeneration cannot be driven.
- **Fix:** 11 adds `regenerateSpike(k)` to its `EndArena` export (§6.6), implemented from the §6.3
  pillar+bedrock-cap+iron-bar-cage construction, taking pillar index k. Edit 11 §6.6 (and §6.3 to
  factor the builder). Base-frozen-safe: pure 11 addition.

---

## MINOR findings (clarity / naming / approx / low-impact contradiction)

### M1 — Sibling sound-event keys don't match 16's master namespace; several events lack recipes
- **Where:** 16 §3 is the authoritative registry using `block.*` / `entity.*` / `world.*` / `player.*`
  / `ui.*`. Sibling tables diverge: **07** prefixes everything `sfx.*` (`sfx.lever.click`,
  `sfx.piston.extend`, `sfx.noteblock.*`, `sfx.tnt.primed`); **09** uses bare underscores
  (`brew_complete`, `drink_gulp`, `splash_break`); **15** likewise (`fire_extinguish`, `bucket_fill`,
  `tnt_primed`); **11** partial (`elytra.glide_loop` vs 16's `item.elytra.loop`); **12**
  (`villager.ambient` vs 16's `mob.villager.*` idle convention).
- **What's wrong:** 16 §5.2 says siblings own the event *ids* and 16 owns the *recipes* for "their
  listed event ids." When keys don't match, `emitSound(key)` finds no recipe → 16 §5.1 warns once and
  drops the sound. 16 §3 does not enumerate recipes for 07's redstone components (lever/button/plate/
  repeater/comparator/piston/dispenser/dropper) at all, nor for many 09/11/12/15 underscore keys.
- **Fix:** One reconciliation pass — pick 16's namespaced convention as canonical and rewrite the
  sibling tables' keys to match (07 drops the `sfx.` prefix; 09/15 adopt dotted namespaced keys), and
  add the missing recipes to 16 §3 (or confirm §3-default coverage). Cosmetic to the game logic but
  functionally silences a swath of SFX until reconciled.

### M2 — 16's note-block instrument map covers only 5 of 07's 10 instruments
- **Where:** 07 §12.2/§16 emits `sfx.noteblock.<harp|bass|snare|hat|basedrum|bell|guitar|
  iron_xylophone|pling|didgeridoo>` (10 instruments). 16 §3.5's note-block instrument map defines
  only harp, bass, snare, hat, bell.
- **What's wrong:** basedrum, guitar, iron_xylophone, pling, didgeridoo have no synthesis recipe;
  those note-block instruments would be silent.
- **Fix:** 16 §3.5 adds recipes for the 5 missing instruments (07's instrument-by-block-below table
  drives selection), or 07 reduces its instrument set to the 5 that 16 synthesizes. Recommend 16 adds
  them (07's block-below→instrument map is complete and vanilla-faithful).

### M3 — All `AMENDS CLAUDE.md §5/§6/§1` instructions target the wrong section of current CLAUDE.md v2
- **Where:** 07 ("AMENDS CLAUDE.md §5: delete from out-of-scope list", "AMENDS §6: delete stretch
  goal"), 08/09/10/11/12/13 ("AMENDS CLAUDE.md §5: remove from the out-of-scope list"), 16 ("AMENDS
  CLAUDE.md §1 (Assets bullet): delete 'No audio.'", "AMENDS §5: remove 'audio' from out-of-scope",
  "AMENDS §6: delete stretch goal (4)").
- **What's wrong:** These were authored against a v1 CLAUDE.md layout (§1 = assets/no-audio, §5 =
  out-of-scope, §6 = stretch goals). **Current CLAUDE.md v2** has: §1 "How to treat the files", §5
  "Known gaps", §6 "Working practices", **§7 "Out of scope v2"**, and no "stretch goals" section. So
  every "remove from out-of-scope" amendment points at §5 (Known gaps) when it means §7; the "delete
  stretch goal" amendments (07, 16) target content that no longer exists; 16's "§1 Assets bullet /
  No audio" is now in §6/§7, not §1.
- **Fix:** Repoint all these amendments to CLAUDE.md **§7** (out-of-scope) and drop the stretch-goal
  deletions (v2 has none); repoint 16's "No audio" amendment to §6/§7. (CLAUDE.md is the governance
  doc, not a frozen 01–06 base spec, so it can be edited by the fixer.)

### M4 — CLAUDE.md §5 "Known gaps" is stale (10 & 12 now delivered) and no AMENDS corrects it
- **Where:** CLAUDE.md §5 still says "10-NETHER.md is not yet delivered" and "12-VILLAGES.md is
  truncated." Both files now exist and are complete. 10's `AMENDS CLAUDE.md §5` addresses only the
  out-of-scope *line* (mis-numbered per M3), not the Known-gaps staleness.
- **Fix:** Update CLAUDE.md §5 to record 10 and 12 as delivered (unblocking E6–E11 downstream notes).
  No expansion file currently does this; the fixer/coordinator should.

### M5 — 10 claims beds explode in the End; 11 (dim-2 owner) says denial-only, no explosion
- **Where:** 10 §10.2 "In any dimension flagged `explodesBeds` (Nether, **and End via 11's
  descriptor**), RMB on a bed → explosion." 11 §7 (dim-2 environment profile) "sleeping is always
  denied in dim 2 with a toast … the explosion gag is cut — denial only."
- **What's wrong:** Direct contradiction on End bed behavior. Per CLAUDE.md §2 precedence, 11 owns the
  End dimension descriptor, so 11 wins (denial only). 11's descriptor does not set `explodesBeds`.
- **Fix:** Correct 10 §10.2's parenthetical — drop "and End via 11's descriptor"; the End is denial-
  only. (Low impact; cosmetic behavior.)

### M6 — 13 beacon mineral list leaves `netherite_block` (10) conditional though 10 registers it
- **Where:** 13 §9.2 `MINERALS = {iron_block 28, gold_block 29, diamond_block 30, emerald_block(12)}`
  with the note "netherite blocks: only if 10 registers one — then add its id here; otherwise 4
  minerals total." 10 §1.1 registers `netherite_block` 142.
- **What's wrong:** 10 *does* register a netherite block, and vanilla 1.16+ beacon pyramids accept it,
  but 13's hardcoded check still lists only 4 minerals.
- **Fix:** 13 §9.2 adds `netherite_block 142` to `MINERALS` (now that 10 is delivered).

### M7 — Elytra anvil-repair (leather) is stated in 11 prose but not wired as an AMENDS to 08's anvil
- **Where:** 11 §10.1 "the anvil (08-ENCHANTING) accepts leather, 108 durability per leather, up to
  4." 08 §8.3/§8.4 anvil `isRepairMaterial(sac.id, target)` + unit-repair table has no elytra row
  (elytra is item 424, not "leather armor"). 11 §Amendments has no `AMENDS 08` entry for this.
- **What's wrong:** 08's anvil won't recognize elytra+leather without being told. (The 108/unit and
  max-4 numbers fall out of 08's generic `floor(maxDur/4)` unit repair — 432/4 = 108 — so only the
  material-eligibility wiring is missing.)
- **Fix:** 11 adds `AMENDS 08 §8.4`: register `elytra (424) → leather` in the repair-material table so
  08's existing unit-repair path applies.

### M8 — 09 expects 10's blaze to carry a `hurtByWater` flag; 10's blaze stat block doesn't define it
- **Where:** 09 §13.3 (splash water) "The blaze (10) takes 1 too — 10's stat block hooks the same
  `hurtByWater` flag." 10 §7.4 blaze stat block marks it `fireImmune` but specifies no water
  vulnerability / `hurtByWater`.
- **What's wrong:** Splash-water-hurts-blaze depends on a 10 flag 10 never defines (vanilla blazes do
  take water damage).
- **Fix:** 10 §7.4 adds a `hurtByWater` flag (1 damage from water/splash-water/rain contact) to the
  blaze stat block, consumed by 09 §13.3 and 15's fire/water systems.

### M9 — 15's fire + waterlogging tables reference 07 blocks that 07 explicitly cut
- **Where:** 15 §3 flammability lists `trapped_chest (07)` and `rails, all types (07)`; 15 §9
  waterloggable table lists `trapped_chest (07)` ("YES") and `rails … "YES if 07 ships rails"`. 07 §1
  EXCLUDED (final): "trapped chest, rails + all minecarts."
- **What's wrong:** Dead rows referencing nonexistent blocks (rails is hedged; trapped_chest is not).
- **Fix:** 15 marks trapped_chest / rails rows as N/A (not in scope) for clarity. Harmless dead rows.

### M10 — `00-EXPANSION-PLAN` referenced by 07 and 09; no such file exists
- **Where:** 07 §15 ("00-EXPANSION-PLAN arbitrates if 10 wants to restore vanilla recipes"); 09
  §Amendments ("coordinated globally by 00-EXPANSION-PLAN").
- **What's wrong:** There is no `00-EXPANSION-PLAN` file; the governance/coordination doc is CLAUDE.md.
- **Fix:** Repoint both references to CLAUDE.md (or to `DEVIATIONS.md` for the recipe-substitution log).

### M11 — RMB-interaction pipeline (03 §16.1) is amended by 08/09/12 with divergent step numbering
- **Where:** 08 §Amendments-03 restructures 03 §16.1 into a two-hand loop ("run steps 1–5 for main
  hand; rerun 3–4 for offhand"), and 08 §7.3's pseudocode shows a 3-step form. 09 amends "step 4
  (usable items now include potions)"; 12 inserts "step 2b (shovel → dirt_path)". These reference the
  original base step numbers.
- **What's wrong:** After 08's restructure, "step 4" (09) and "step 2b" (12) may not map cleanly to
  08's rewritten steps; 08's own amendment text ("steps 1–5") and its §7.3 pseudocode (3 steps) also
  disagree on the step count.
- **Fix:** Reconcile 08 §7.3 into a single canonical step list and re-express 09's potion-use and
  12's shovel-path insertions against that final ordering (both are additive and non-conflicting once
  the ordering is pinned). Low risk; clarity fix.

### M12 — Function name `randomEnchantedBook` arg name drift (11 uses `levelRange`, 08/12 use `level`)
- **Where:** 08 §10 defines `randomEnchantedBook(rng, level, treasureAllowed)`. 12 §9.3 calls
  `randomEnchantedBook(rng, level, treasureAllowed=true)` (consistent). 11 §8/registry text refers to
  it as `randomEnchantedBook(rng, levelRange, treasureAllowed=true)`.
- **What's wrong:** Cosmetic parameter-name inconsistency (`level` vs `levelRange`) in 11's reference.
- **Fix:** 11 use `level` to match 08's signature. Trivial.

### M13 — 12 librarian trade says "one random enchant"; 08's `randomEnchantedBook` can return multi-enchant books
- **Where:** 12 §9.3 "each `enchanted_book` trade rolls **one** random enchant"; 08 §10's helper runs
  `selectEnchants` which may pick several then drop one (books can end multi-enchant).
- **What's wrong:** Minor wording mismatch; 08's helper (the owner) determines the count.
- **Fix:** 12 soften wording to "rolls a random enchanted book via 08 §10" (drop "one"). Cosmetic.

### M14 — 09 sound `fire_extinguish` / 15 `fire_extinguish` / 16 `block.extinguish` / 10 `block.fire.extinguish` — 4 keys, 1 sound
- **Where:** 09 §17 `fire_extinguish`; 15 §15 `fire_extinguish`; 10 §14 `block.fire.extinguish`
  (water evaporation); 16 §3.3 `block.extinguish`.
- **What's wrong:** The same "hiss/douse" sound is named four different ways across files (a subset of
  M1). Not a collision (no two files claim different synthesis for one key), but the fixer should
  collapse to a single canonical key so 16 has one recipe. Cosmetic; folds into M1's reconciliation.

### M15 — 09 & 10 both AMEND 06 §2 (glowstone id 32) drop; identical change, two files
- **Where:** 09 §Amendments ("id 32 glowstone: drop becomes 2–4 glowstone_dust once 10 lands") and 10
  §4.6/§8.5 (glowstone drops 2–4 glowstone_dust 395).
- **What's wrong:** Duplicate amendment of the same base row (not conflicting — identical intent).
  Confirmed coherent with 12's cleric selling the glowstone *block* (32) and 08's Silk-Touch glowstone
  → self override; nothing expects glowstone *dust* from a villager.
- **Fix:** None required; note it's a single realized change owned by 10 (09's is the pre-10 placeholder).

### M16 — 12 cleric Master tier collapses to zero offers if 10 unbuilt (E6 precedes E7)
- **Where:** 12 §9.4 cleric Master has a single row ("22 nether_wart (10) → 1 emerald"); 12 says drop
  it if 10 unbuilt, "cleric still reaches Master via the remaining rows." But that was the only Master
  row.
- **What's wrong:** With 10 unbuilt at E6, the cleric can level to Master (XP-based) but the Master
  offer pool is empty. Cosmetic edge (badge shows Master, no Master trade).
- **Fix:** 12 add a fallback Master row not gated on 10 (e.g., a bottle/emerald exchange) or state the
  empty-Master-tier behavior explicitly. Low impact.

### M17 — 13's `spawnEffectCloud` cloud params vs 09's AreaEffectCloud entity (owner precedence stated but verify)
- **Where:** 13 §Amendments-09(b) "Expose `spawnEffectCloud(...)` … if 09's lingering-cloud entity
  differs, this file's cloud params win for dragon clouds." 09 §14.2 owns `AreaEffectCloud` with its
  own field set (radius, radiusPerTick, waitTime, reapplicationDelay, etc.).
- **What's wrong:** 13 calls a factory `spawnEffectCloud({pos, radius, radiusPerTick, durationTicks,
  effect, reapplyDelay})` whose arg names don't line up 1:1 with 09's AreaEffectCloud fields (e.g. 09
  uses `duration`/`waitTime`/`reapplicationDelay`/`radiusOnUse`; 13 uses `durationTicks`/`reapplyDelay`
  and omits waitTime/radiusOnUse). Precedence is stated (13 wins for dragon clouds) but the parameter
  mapping is unspecified.
- **Fix:** 09 §14.2 add the `spawnEffectCloud(params)` factory signature 13 calls and map its args to
  AreaEffectCloud fields (13's values override for dragon clouds). Clarity; both files already agree
  on ownership.

### M18 — 15 fire-spread humidity biomes reference base biomes that may not carry the assumed names
- **Where:** 15 §2.6 `HUMID_BURNOUT_BIOMES = { snowy_tundra, mountains }` read from `chunk.biomes`.
  12 §6.1 gates emerald on `biomeAt == mountains (id 10)`; 11 §Amendments adds biome id 11 `the_end`.
- **What's wrong:** 15 assumes base biome keys `snowy_tundra` and `mountains` exist by those names.
  This is a base-02 dependency (frozen) — verify 02 §6.1 actually defines those two names; if the base
  set names them differently, 15's humidity table silently never triggers.
- **Fix:** Confirm against 02 §6.1's biome id/name table; if names differ, 15 updates its
  `HUMID_BURNOUT_BIOMES` set to the actual base names. (Could not verify biome names in this pass;
  flagged for the fixer to check against frozen 02.)

---

## Seams checked and found CLEAN (coverage map for the fixer)

- **ID ranges & collisions (all of 07–13):** every block/item id sits inside its granted range; no id
  claimed twice; no intra-file gaps/typos. (Master table above.) The only allocation anomaly is the
  *unregistered* dragon_breath (C1).
- **09 ↔ 10 brewing ingredients:** `nether_wart 390, blaze_rod 391, blaze_powder 392, magma_cream 393,
  ghast_tear 394, glowstone_dust 395, gold_nugget 396` — 09 references match 10's definitions by id
  AND name (10 §Amendments-09 explicitly confirms). 10's drop/crop chain produces **every** ingredient
  09's recipe graph consumes (nether_wart←fortress garden/farm, blaze_powder←blaze_rod, ghast_tear←
  ghast, magma_cream←magma cube, glowstone_dust←mining glowstone, gold_nugget←multiple, + sugar/
  spider_eye/golden_carrot/golden_apple/redstone/gunpowder from 09/06). CLEAN.
- **12 ↔ 08 librarian books:** uses `enchanted_book` 346, 08's `randomEnchantedBook(rng, level,
  treasureAllowed=true)`, level `5+rngInt(15)`, and emits `{id:346, tags:{enchants:[{id,lvl}]}}` per
  08 §1's tags schema; treasure=true → Mending (id 19) obtainable. CLEAN (minor wording M13).
- **12 ↔ 09/10/06 trade items:** glass_bottle 370, redstone 342, lapis_lazuli 343, ender_pearl 334,
  golden_carrot 377, golden_apple 376, tipped_arrow 378, nether_wart 390, weakness splash (372,
  potionId "weakness") — all ids/names match owners. CLEAN.
- **12 glowstone trade:** cleric sells glowstone **block 32** (base) for emeralds — coherent: mining
  glowstone drops dust (09/10 amendment), block re-craftable from 4 dust (10 §1.3), Silk-Touch drops
  the block (08). Nothing expects glowstone *dust* from a villager. CLEAN.
- **12 zombie-villager curing:** splash Weakness (09 item 372) + regular golden_apple (09 item 376,
  enchanted apple confirmed OUT in both 09 §9.1 and 12 §11.5). CLEAN.
- **13 ↔ 10 wither summon:** wither_skeleton_skull (block 186, 13-owned, dropped by 10's mob at 2.5%),
  soul_sand 119 / soul_soil 120 via 10's exported `isSoulBlock(id)`, nether_star 450, ghast_tear 394
  (→ 13 end-crystal recipe). All references correct. CLEAN.
- **13 ↔ 11 arena / crystals:** PILLAR_POSITIONS/EXIT_PORTAL/eggPos (0,67,0 = 1 above portal-column
  top)/2 caged pillars — all consistent between 11 §6 and 13 §3/§7. (Only the handoff *function names*
  break — C3/C4.)
- **11 ↔ 10 dimension engine:** 11 registers dim 2 with hasSkyLight=false/ambientLight=0.00/scale=1
  into 10's registry, uses per-dim gen/sky/save keying, 10's onArrive=regenObsidianPlatform for dim 2.
  Engine consumption correct. (Only the teleport *function name* breaks — C2.)
- **08 ↔ 05 sweep/offhand:** 08 §6 sweep implements 05 §13.5 (confirmed "Skipped" at 05:578);
  thresholds (p≥0.848), weaponBase (05 §13.2), knockback (05 §14.3) all exist. Offhand slot 45 clean.
- **10 knockback-resistance ↔ 08 enchant math (task-flagged):** CLEAN. 10 §9.2 introduces
  `knockbackResistance` as a new stat + the multiplier `strength *= (1 − kbResist)` inside 05 §14.3's
  `applyKnockback`. 08 §5.4.2 Knockback sets the *input strength* (`0.4 + 0.5×(kbLvl + sprint)`) at
  the call site. These compose — 08 sets strength, 10 scales it — with **no duplication**. 05 §14.3
  base has "knockback resistance: all mobs 0 — attribute omitted," which 10 fills in; 12 (golem=1.0)
  and 13 (dragon=1.0 skip) set values via the same stat. Four files amend 05 §14.3, all compatibly.
- **05 §13.1 damage formula (08 + 09):** 09 modifies the base term (`weapon + 3·Str − 4·Weak`), 08
  adds the enchant term (`+ enchBonus × p` after crit). Complementary; the fixer merges into one
  formula: `(weapon + 3·Str − 4·Weak) × (0.2+0.8p²) × crit + enchBonus·p`. No conflict.
- **`tags` schema (08-owned):** enchants (08/12), name/anvilUses (08), potionId (09 — pre-declared in
  08 §1), containerItems (11 — new key, allowed by 08 §1's "future keys preserved" rule), netherite
  smithing copies base.tags verbatim (10 §9.3). All consistent. CLEAN.
- **15 waterlogging bit7 vs waterloggable set:** waterloggable = fence 52 / ladder 39 / chest 37 (+
  trapped_chest/rails when shipped — see M9). No base or expansion block that *should* waterlog is in
  conflict; bit7 usage exclusive to 15. CLEAN.
- **Sound-event tables present:** 07 §16, 08 §12, 09 §17, 10 §14, 11 §16, 12 §12.3, 13 §11, 15 §15 all
  ship one; 16 §3 is the master. No two files claim *different* synthesis for the same key (no true
  collision) — the issue is naming *divergence* + missing recipes (M1/M2/M14), not collision.
- **Dimension-engine ownership:** exactly one owner (10); 11 extends (registers dim 2) without
  redefining the registry/portal API. No duplication. CLEAN.
- **AMENDS targets in base 01–06:** spot-verified present — 05 §13.5 (sweep "Skipped"), §14.2/§14.3
  (armor/knockback), §13.1 (damage); 06 §5.6 (TNT), §5.7 (bed), §5.11 (farmland), §5.13 (doors),
  §5.14 (fire), §6.1 (fluids/dams), §12.4 (eating), block ids 28/29/30/31/32/33/37/50/51/52/53/54/63/
  64/65 and item ids 329/334/339/340/341/342/343/284/324; 04 §11.2 (shader), §12.6 (lightning). All
  exist with the names the amendments assume. (Base 01–06 remain frozen — no edits proposed to them;
  any base-side "right fix" is redirected into the amending expansion, as in M7/M8.)
- **Phase-gate dependencies (CLAUDE.md §4):** E9←E7 ingredients ✓, E10 eyes←E7 blaze powder ✓, E11←
  E10 arena + E7 skulls ✓, E6 trades←08/09 (with fallbacks) ✓ — all delivered by the owning files.
  The one gate a file fails to deliver is E9's "lingering clouds work" (blocked by C1).

---

## Summary for the fixer

4 CRITICAL: **C1** dragon_breath orphan (register it in 13, id 452, + correct the false "no bottles"
note) — unblocks lingering potions/tipped arrows/E9. **C2/C3/C4** three End-handoff function-name
gaps (`changeDimension`↔`Dimensions.teleport`; `spawnGateway`↔`spawnEndGateway`; missing
`regenerateSpike` export) — unify names / add the missing 11 export.

18 MINOR: dominated by two systemic items — **M1/M2/M14** sound-event key naming + missing recipes
(one reconciliation pass over 07/09/11/12/15 keys vs 16 §3), and **M3/M4** CLAUDE.md section-number
drift (all `AMENDS CLAUDE.md §5/§6/§1` really mean §7/§6/§7; §5 Known-gaps is stale). The rest are
low-impact contradictions/clarity fixes (M5 End beds, M6 netherite beacon block, M7 elytra repair
wiring, M8 blaze water flag, M9 cut-block references, M10 00-EXPANSION-PLAN, M11 RMB step numbering,
M12/M13/M16/M17/M18).

ID governance table is **clean** apart from the single *unallocated* dragon_breath (C1). No collisions,
no range violations, bit7 exclusive to 15, effect/dimension ids single-owned.

---

## Round-2 fixes applied

Applied by the FIX agent. Base specs 01–06 were **not edited** (zero edits). Post-fix greps for
`Dimensions.teleport`, `spawnEndGateway`, `sfx.`, `00-EXPANSION-PLAN`, `<!--CONT-->`, and the old
bare/underscore sound keys all return **clean**; `dragon_breath`/`452` present in 13; `regenerateSpike`
exported in 11; no id allocated outside its granted range.

**CRITICAL**
- **C1** — `13-BOSSES.md`: registered `dragon_breath` as **item 452** (§2.3 table, §12 table, AMENDS 06 §7.4); rewrote §6.5 into the real bottle-collect hook (RMB glass_bottle 370 in a breath cloud → dragon_breath, shrink radius 0.5) and deleted the false "no glass bottles in scope" clause; added the E9-phase note. `CLAUDE.md` §4 also annotated (lingering testable via debug palette pre-E11).
- **C2** — `11-END.md` §1 + §5.4 (+ §5.6): `Dimensions.teleport(...)` → 10's `changeDimension(entity, targetDim, targetPos, opts)`.
- **C3** — `13-BOSSES.md` §Amendments-11(c) + §7.9: `spawnEndGateway(...)` → `spawnGateway(...)` (also aligned `regenerateSpike(i)`→`(k)`).
- **C4** — `11-END.md` §6.6: added `regenerateSpike(k)` to the `EndArena` export, implemented from a `buildSpike(k)` builder factored in §6.3.

**MINOR**
- **M1** — Sound-key reconciliation to 16's namespaces: `07` dropped all `sfx.` prefixes → `block.*`/`world.*` (table + inline); `09`/`15` bare-underscore → dotted (`block.extinguish`, `item.bucket.fill`, `world.tnt.fuse`, `player.drink.gulp`, `block.brewing.done`, `entity.splash_potion.*`, …) in tables + inline; `11` `elytra.glide_loop`→`item.elytra.loop`; `12` `villager.*`/`iron_golem.*`→`mob.villager.*`/`mob.iron_golem.*`, workstations→`block.*`. `16` §3.6 added with recipes for all 07 redstone components + `item.flintandsteel.use`; §3-default note covers the remaining reconciled one-shots.
- **M2** — `16-AUDIO.md` §3.5: added basedrum/guitar/iron_xylophone/pling/didgeridoo voices + a class-collision note (07 §12.2 selects by specific block).
- **M3** — `07/08/09/10/11/12/16`: repointed `AMENDS CLAUDE.md §5/§6/§1` → **§7** (out-of-scope) / §6 (16's assets bullet); dropped the non-existent stretch-goal deletions.
- **M4** — `CLAUDE.md` §2 (10/12 status PENDING/PARTIAL → Ready) and §5 (Known gaps rewritten: 10 & 12 delivered, downstream unblocked, Round-2 audit applied).
- **M5** — `10-NETHER.md` §10.2: dropped "and End via 11's descriptor" — End is denial-only.
- **M6** — `13-BOSSES.md` §9.2: added `netherite_block 142` to beacon `MINERALS`.
- **M7** — `11-END.md` §Amendments: added `AMENDS 08 §8.4` registering `elytra (424) → leather`.
- **M8** — `10-NETHER.md` §7.4: added `hurtByWater` to the blaze stat block (consumed by 09 §13.3).
- **M9** — `15-FIRE-WATERLOGGING.md` §3 + §9: marked `trapped_chest`/`rails` rows **N/A** (07 cut them); fixed the §9 registry line.
- **M10** — `07-REDSTONE.md` §15 (→ CLAUDE.md arbitration + DEVIATIONS.md log) and `09-POTIONS.md` §Amendments (→ CLAUDE.md): repointed `00-EXPANSION-PLAN`.
- **M11** — `08-ENCHANTING.md` §7.3: pinned one canonical 5-step RMB list (2b = shovel-path, 4 = self-use) matching the header amendment; 09/12 step-number references verified + pointed at it.
- **M12** — the `levelRange` drift was actually in **`08-ENCHANTING.md`** §10 line 675 (audit misattributed to 11 — grep confirmed 08 is the only occurrence); changed → `level` to match 08's own signature.
- **M13** — `12-VILLAGES.md` §9.3 (+ acceptance): "one random enchant" → "a random enchanted book via 08 §10" (count owned by 08's helper).
- **M14** — folded into M1: collapsed the 4 fire/lava-douse variants to the single canonical `block.extinguish` across 09/10/15.
- **M15** — none required (skipped, per report).
- **M16** — `12-VILLAGES.md` §9.4: added an ungated **Master** cleric row (1 emerald → 4 redstone) so the Master tier isn't empty when E6 precedes E7; updated the trailing note.
- **M17** — `09-POTIONS.md` §14.2: added the `spawnEffectCloud(params)` factory signature 13 calls, mapping its args to AreaEffectCloud fields (13 overrides for dragon clouds).
- **M18** — verified against **frozen** `02-WORLD-GENERATION.md` §6.1: biome names `snowy_tundra` (id 9) and `mountains` (id 10) exist exactly; `15` §2.6 and `12` §6.1's `mountains (id 10)` gate both match — **no edit needed**.

**Nothing left unresolved.** Note: `14-MULTIPLAYER.md` also carries an `AMENDS CLAUDE.md §5` line, but 14 was outside both M3's named file set and this task's editable-file list, so it was intentionally left untouched.
