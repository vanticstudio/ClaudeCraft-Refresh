# 10 — The Nether & the Multi-Dimension Engine

EXPANSION file. Owns the **multi-dimension engine** (dimension registry, per-dimension worldgen / sky / save namespacing, the active-dimension rule, and the portal/teleport API — **11-END plugs into this surface**), **Nether portals**, deterministic **Nether worldgen** (4 biomes, ores, ancient debris), the **Nether fortress** structure, the **generic monster-spawner block**, **6 Nether mobs** in 05's stat-block format, the **brewing ingredient chain** that **09-POTIONS** depends on (nether wart, blaze powder, magma cream, ghast tear, glowstone dust, gold nugget), the **netherite tier** (scrap → ingot → smithing upgrade, full tool + armor stat rows), and the Nether's environmental hazards (water evaporation, exploding beds, fast lava, eternal netherrack fire, magma blocks). Baseline: Minecraft Java Edition ~1.20 (specifically the 1.16–1.19 Nether, with 1.20 numbers where they differ), Normal difficulty, exact wiki values unless marked `(approx)`. 20 ticks/s; 1 block = 1 m.

**Cross-file ownership boundaries.** The **status-effect engine** (`addEffect`, the WITHER effect, immunity flags) is **09**'s — this file *calls* it (wither skeleton on-hit). The item-stack `tags` object (enchantments, serialization, merge rules) is **08**'s — netherite smithing *preserves* it, never redefines it. **13-BOSSES** owns `nether_star` (item 450) and `wither_skeleton_skull` (block 186); this file's wither skeleton *drops block-item 186*, and 13 reads this file's `soul_sand`/`soul_soil` ids + `ghast_tear`. **11-END** owns the End dimension (dim id 2) — it registers into *this* file's dimension registry and calls *this* file's teleport routine. **14** replicates all of this generically (dimension is part of entity/chunk state); no netcode here. Sound-event **names** in §14 are registered for **16-AUDIO** (16 owns synthesis).

---

## Amendments to base files

These are change instructions applied to the **codebase** (not to the base spec files). They override the corresponding base-spec text per CLAUDE.md §2 precedence.

- **AMENDS CLAUDE.md §7 (Out of scope v2):** ensure "the Nether" is absent from the out-of-scope list; E7/E8 are unblocked by this file. (11-END separately handles "the End".)
- **AMENDS 01 §2 (module map):** add modules `world/dimensions.js` (the dimension registry + active-dimension swap, §2), `world/gen/nether.js` (`generateNetherChunk`, pure, imported only by the worker, §4), `world/gen/fortress.js` (deterministic piece grammar, §5), `world/Portal.js` (frame validation + teleport API, §3), `world/Spawner.js` (generic spawner block entity, §6). New mob files under `entities/mobs/nether/`: `Ghast.js`, `Blaze.js`, `ZombifiedPiglin.js`, `MagmaCube.js`, `WitherSkeleton.js`, `Piglin.js`, plus projectile `entities/GhastFireball.js` and `entities/SmallFireball.js` (§7).
- **AMENDS 01 §4.2 (Chunk):** add field `dim` (dimension id, uint8, default 0). Chunk keys are namespaced by dimension everywhere (§2.4).
- **AMENDS 01 §9 (worker protocol):** the `generate` message gains `dim: int`; the worker dispatches to the dimension's `gen` function (§2.2). The `ready` handshake is unchanged (world spawn is overworld-only). Nether generation is deterministic per `(seed, dim, cx, cz)` and uses **native Y 0–127 with no remap** (§4.1).
- **AMENDS 01 §13.1 (Entity):** add fields `dim` (dimension id), `portalTimer` (int, 0), `portalCooldown` (int, 0). Only entities whose `dim === world.activeDim` tick or render (§2.3).
- **AMENDS 01 §16 (save schema):** chunk-store keys become `"<dim>:<cx>,<cz>"` (e.g. `"1:5,-3"`); `savedChunkKeys` includes the dim prefix. `meta.player` gains `dimension: int`. `meta` gains `dimensions: { [dimId]: { data } }` — a per-dimension metadata blob (portal-link cache §3.6, fortress registry §5, and **11's `endFight` record** live here). Entity/block-entity records inherit their chunk's dim. Overworld chunk keys migrate from `"cx,cz"` to `"0:cx,cz"` on first load (one-time key rewrite; if absent, treat legacy `"cx,cz"` as dim 0).
- **AMENDS 02 §13 (worker pipeline):** `generateChunk` branches on `dim`: dim 0 → 02's overworld pipeline; dim 1 → §4's Nether pipeline; dim 2 → 11's End pipeline. All three share 02 §2's seed-stream discipline and §2.4's lattice/`posHash` helpers.
- **AMENDS 04 §5–§7 (sky & fog):** sky rendering is per-dimension (§13). The Nether disables the sky dome gradient, sun, moon, stars, sunrise band, clouds, weather, and day/night `skyDarken`; it renders a flat fog-colored void and dense red fog. Add a per-dimension `sky` descriptor to the environment feed.
- **AMENDS 04 §8 / §11.2 (light & shader):** add per-dimension flags `hasSkyLight` and `ambientLight`. When `hasSkyLight === false` (Nether, End), the lighting engine seeds **no** column sky light — `skyLight` stays 0 everywhere and only block light propagates (§13.2). Add shader uniform `uDimAmbient` (float, per-frame from the active dimension's `ambientLight`); after computing `light` in 04 §11.2, apply `light = max(light, vec3(uDimAmbient))`. Nether `ambientLight = 0.10` (wiki: Nether dimension ambient_light 0.1) so unlit caverns are dim-but-readable, not pitch black. No remesh, no relight — identical hook pattern to `uSkyDarken`.
- **AMENDS 04 §10.1 (hostile spawn light check):** in dimensions with `hasSkyLight === false`, the sky term is 0, so `canSpawnHostileAt` reduces to `blockLight(pos) == 0 && 0 <= rng.nextInt(8)` → block light must be 0 (§7.2's Nether spawn override refines this per-mob).
- **AMENDS 05 §1 (mob base):** persisted mob fields gain `dim`. Simulation range and despawn operate within the active dimension only.
- **AMENDS 05 §3.2 (spawn cycle):** the hostile spawn wave is dimension-aware. In dim 1 (Nether) the weight table, spawnable substrate, and light rule come from §7.2; the global hostile cap **40** is **shared across dimensions** (only the active dimension ticks, so it is effectively per-active-dim). Undead daylight burning (05 §5) never fires in the Nether (no sky light, `isDay` undefined → treated false).
- **AMENDS 05 §2 (rosters):** register the 6 Nether mobs (§7). Flag `wither_skeleton` and `zombified_piglin` as `undead` (09's undead inversion + Poison/Regen immunity apply); flag `zombified_piglin`, `piglin`, `blaze`, `magma_cube` as `fireImmune` (never take FIRE/LAVA/BURNING damage, never ignite).
- **AMENDS 06 §1 (registry conventions):** block ids extend to **115–149**, item ids to **390–419** (§1 of this file). The harvest **tier ladder gains `netherite(4)`**: `wood(0) < stone(1) < iron(2) < diamond(3) < netherite(4)`; add speed multiplier **`netherite ×9`** (diamond ×8). Netherite tools harvest everything a diamond tool can. `spawner`, `nether_portal`, `nether_wart` (crop block) have **no block-item** (spawner is gen-only/debug; portal placed by ignition; nether_wart planted by item 390).
- **AMENDS 06 §2/§3 (block tables):** add the block rows in §1.1 (gameplay + light/render/physics).
- **AMENDS 06 §5 (special block behaviors):** add nether portal block (§3.3), generic spawner (§6), nether_wart crop (§8.1), magma_block contact damage + exploding beds in non-overworld dims (§10.2), and the netherrack "eternal fire" flag (§10.4).
- **AMENDS 06 §6.1 (fluids):** fluid constants become **per-dimension**. In dim 1, **lava** uses water-like spread: max horizontal spread **7** cells, update interval **10 t**, level-drop 1/step (Overworld lava unchanged: 3 / 30 t / 2). Placing a **water source** (bucket or dispenser) in a dimension flagged `evaporatesWater` (Nether) places nothing: emit the evaporation poof + hiss and consume nothing extra (§10.1).
- **AMENDS 06 §7 (item registry):** add the item rows in §1.2 (brewing ingredients + netherite tier). **Netherite items are fire/lava-immune as item entities and float on lava** (§9.4) — AMENDS 06 §16 "Destroyed by: lava, fire" gains the exception "except items flagged `lavaImmune` (netherite)".
- **AMENDS 06 §10/§11 (recipes & smelting):** add the crafting recipes in §1.3 and the smelting recipes in §1.4 (ancient debris → netherite scrap, netherrack → nether brick). Add the **smithing-table upgrade** operation (§9.3).
- **AMENDS 08 (sibling):** netherite is a fully enchantable tier (enchantability 15, §9.2); the smithing upgrade (§9.3) copies the source item's `tags` (enchantments) and remaining durability onto the netherite result. 08's anvil/enchanting-table recipes treat netherite tools/armor exactly like diamond.
- **AMENDS 09 (sibling):** confirm the ingredient item ids this file owns match 09's references — `nether_wart 390`, `blaze_rod 391`, `blaze_powder 392`, `magma_cream 393`, `ghast_tear 394`, `glowstone_dust 395`, `gold_nugget 396`. The wither skeleton applies WITHER via `addEffect(target, 20 /*wither*/, 0, 200)` (Wither I, 0:10) using 09's engine.
- **AMENDS 11 (sibling):** the End (dim id **2**) registers into §2.1's dimension registry with its own `gen`/`sky`/`ambientLight`/`hasSkyLight=false`; 11's `regenObsidianPlatform()` is invoked by §3.5's teleport routine on arrival in dim 2; the End's `endFight` record (13) lives in this file's per-dimension `meta.dimensions[2].data`.
- **AMENDS 13 (sibling):** the wither skeleton (this file) drops **block-item 186** (`wither_skeleton_skull`, 13's block) at 2.5%; this file exports the predicate `isSoulBlock(id)` covering `soul_sand (119)` + `soul_soil (120)` for 13's wither-summon detector; `ghast_tear (394)` feeds 13's end-crystal recipe.

## Contents

1. [ID assignments (final)](#1-id-assignments-final)
2. [Multi-dimension engine](#2-multi-dimension-engine)
3. [Nether portals](#3-nether-portals)
4. [Nether generation](#4-nether-generation)
5. [Nether fortress](#5-nether-fortress)
6. [Generic monster-spawner block](#6-generic-monster-spawner-block)
7. [Nether mobs — stat blocks](#7-nether-mobs--stat-blocks)
8. [Brewing ingredients](#8-brewing-ingredients)
9. [Netherite tier](#9-netherite-tier)
10. [Hazards & environment](#10-hazards--environment)
11. [Block texture recipes](#11-block-texture-recipes)
12. [Item texture recipes](#12-item-texture-recipes)
13. [Per-dimension rendering & F3](#13-per-dimension-rendering--f3)
14. [Sound events](#14-sound-events)
15. [Acceptance checklist](#15-acceptance-checklist)

---

## 1. ID assignments (final)

### 1.1 Blocks (allotted range 115–149)

06 §2 gameplay columns: **Hard** hardness, **Blast** blast resistance, **Tool** effective class, **Tier** minimum harvest tier for drops (`—` any, `tool!` correct class any tier). All blocks stack 64 as items unless "no block-item".

| ID | Name | Hard | Blast | Tool | Tier | Drops | XP |
|---:|------|-----:|------:|------|------|-------|---:|
| 115 | netherrack | 0.4 | 0.4 | pickaxe | wood | self | 0 |
| 116 | nether_bricks | 2.0 | 6.0 | pickaxe | wood | self | 0 |
| 117 | nether_brick_fence | 2.0 | 6.0 | pickaxe | wood | self | 0 |
| 118 | nether_brick_stairs | 2.0 | 6.0 | pickaxe | wood | self | 0 |
| 119 | soul_sand | 0.5 | 0.5 | shovel | — | self | 0 |
| 120 | soul_soil | 0.5 | 0.5 | shovel | — | self | 0 |
| 121 | magma_block | 0.5 | 0.5 | pickaxe | wood | self | 0 |
| 122 | nether_quartz_ore | 3.0 | 3.0 | pickaxe | wood | 1 nether_quartz | 2–5 |
| 123 | nether_gold_ore | 3.0 | 3.0 | pickaxe | wood | 2–6 gold_nugget | 0–1 |
| 124 | ancient_debris | 30 | 1200 | pickaxe | **diamond** | self | 0 |
| 125 | crimson_nylium | 0.4 | 0.4 | pickaxe | wood | 1 netherrack (self only with Silk Touch, 08) | 0 |
| 126 | warped_nylium | 0.4 | 0.4 | pickaxe | wood | 1 netherrack (self only with Silk Touch, 08) | 0 |
| 127 | crimson_stem | 2.0 | 2.0 | axe | — | self | 0 |
| 128 | warped_stem | 2.0 | 2.0 | axe | — | self | 0 |
| 129 | crimson_planks | 2.0 | 3.0 | axe | — | self | 0 |
| 130 | warped_planks | 2.0 | 3.0 | axe | — | self | 0 |
| 131 | nether_wart_block | 1.0 | 1.0 | hoe | — | self | 0 |
| 132 | warped_wart_block | 1.0 | 1.0 | hoe | — | self | 0 |
| 133 | shroomlight | 1.0 | 1.0 | hoe | — | self | 0 |
| 134 | crimson_fungus | 0 | 0 | — | — | self | 0 |
| 135 | warped_fungus | 0 | 0 | — | — | self | 0 |
| 136 | crimson_roots | 0 | 0 | — | — | self | 0 |
| 137 | warped_roots | 0 | 0 | — | — | self | 0 |
| 138 | nether_wart | 0 | 0 | — | — | stage 3: 2–4 nether_wart (390); stages 0–2: 1 nether_wart | 0 |
| 139 | bone_block | 2.0 | 2.0 | pickaxe | wood | self | 0 |
| 140 | nether_portal | −1 | 0 | — | — | — (no block-item) | — |
| 141 | spawner | 5.0 | 5.0 | pickaxe | wood | nothing (drops none; no block-item) | 15–43 |
| 142 | netherite_block | 50 | 1200 | pickaxe | **diamond** | self | 0 |
| 143 | smithing_table | 2.5 | 2.5 | axe | — | self | 0 |
| 144–149 | **reserved, unused by 10** | — | — | — | — | — | — |

Notes: `nether_wart` (138) is the planted **crop** block (no block-item; planted with item 390) — parallels 06's `wheat_crop`. `nether_portal` (140) and `spawner` (141) have no survival block-item. `nether_gold_ore`/`nether_quartz_ore` Fortune/Silk behavior is 08's (base: gold ore → 2–6 nuggets, quartz ore → 1 quartz). `ancient_debris` and `netherite_block` need a **diamond-tier or better** pickaxe to drop and are blast-resistant (§9). `crimson_nylium`/`warped_nylium` drop netherrack like grass_block drops dirt.

06 §3 light / render / physics columns: **Emit** 0–15, **Opac** `O`/`T`/`F`, **Pass** `op`/`co`/`tr`, **Shape**, **Grav**, **Solid**.

| ID | Name | Emit | Opac | Pass | Shape | Grav | Solid |
|---:|------|-----:|:---:|:---:|-------|:---:|-------|
| 115 | netherrack | 0 | O | op | cube | — | yes |
| 116 | nether_bricks | 0 | O | op | cube | — | yes |
| 117 | nether_brick_fence | 0 | T | op | custom: post+rails (as 06 oak_fence) | — | yes (1.5 h box) |
| 118 | nether_brick_stairs | 0 | O | op | custom: stair (2-box L profile) | — | yes (stair box) |
| 119 | soul_sand | 0 | O | op | custom: 14/16 top box (sinks entities) | — | yes |
| 120 | soul_soil | 0 | O | op | cube | — | yes |
| 121 | magma_block | **3** | O | op | cube (emissive noise) | — | yes |
| 122 | nether_quartz_ore | 0 | O | op | cube | — | yes |
| 123 | nether_gold_ore | 0 | O | op | cube | — | yes |
| 124 | ancient_debris | 0 | O | op | cube | — | yes |
| 125 | crimson_nylium | 0 | O | op | cube (top/side/bottom=netherrack) | — | yes |
| 126 | warped_nylium | 0 | O | op | cube (top/side/bottom=netherrack) | — | yes |
| 127 | crimson_stem | 0 | O | op | cube (top/side) | — | yes |
| 128 | warped_stem | 0 | O | op | cube (top/side) | — | yes |
| 129 | crimson_planks | 0 | O | op | cube | — | yes |
| 130 | warped_planks | 0 | O | op | cube | — | yes |
| 131 | nether_wart_block | 0 | O | op | cube | — | yes |
| 132 | warped_wart_block | 0 | O | op | cube | — | yes |
| 133 | shroomlight | **15** | O | op | cube | — | yes |
| 134 | crimson_fungus | 0 | T | co | cross | — | no |
| 135 | warped_fungus | 0 | T | co | cross | — | no |
| 136 | crimson_roots | 0 | T | co | cross | — | no |
| 137 | warped_roots | 0 | T | co | cross | — | no |
| 138 | nether_wart | 0 | T | co | hash (3 render stages, §8.1) | — | no |
| 139 | bone_block | 0 | O | op | cube (top/side) | — | yes |
| 140 | nether_portal | **11** | T | tr | custom: 2/16 plane, animated (§3.3) | — | no |
| 141 | spawner | **1** | T | co | cube-wire cage + spinning mini-mob (§6) | — | yes |
| 142 | netherite_block | 0 | O | op | cube | — | yes |
| 143 | smithing_table | 0 | O | op | cube (top/side/front) | — | yes |

`nether_portal` emits light 11 (wiki-exact). `magma_block` emits 3, `shroomlight` 15, `spawner` 1 (the caged flame). `soul_sand` uses a 14/16-height top collision box (entities sink 2/16 and move slowed, §10.3). Waterlogging is impossible in the Nether (§10.1); none of these blocks use state **bit7**.

### 1.2 Items (allotted range 390–419)

06 §7 format. Block-items for blocks 115–143 auto-generate at their **block id** (06 §1 convention) and do **not** consume this range — this range is non-block items only.

| ID | Name | Stack | Dur | Dmg | Notes |
|---:|------|------:|----:|----:|-------|
| 390 | nether_wart | 64 | — | — | brewing base (09); plants crop block 138 on soul_sand |
| 391 | blaze_rod | 64 | — | — | blaze drop; → brewing stand (09 §7.2); → 2 blaze_powder |
| 392 | blaze_powder | 64 | — | — | brewing stand **fuel** + Strength ingredient (09); eye of ender (11) |
| 393 | magma_cream | 64 | — | — | magma cube drop; Fire Resistance ingredient (09) |
| 394 | ghast_tear | 64 | — | — | ghast drop; Regeneration ingredient (09); end crystal (13) |
| 395 | glowstone_dust | 64 | — | — | glowstone (block 32) drop; potion amplifier (09) |
| 396 | gold_nugget | 64 | — | — | ↔ gold_ingot (base 324); golden carrot (09); zombified-piglin/nether-gold-ore drop |
| 397 | nether_quartz | 64 | — | — | nether_quartz_ore drop; collectible/crafting (available to 07-REDSTONE) |
| 398 | netherite_scrap | 64 | — | — | smelt ancient_debris; 4+4 gold → 1 ingot |
| 399 | netherite_ingot | 64 | — | — | smithing upgrade material; netherite_block; beacon-payable |
| 400 | netherite_sword | 1 | 2031 | 8 | §9.1 |
| 401 | netherite_pickaxe | 1 | 2031 | 6 | §9.1; speed ×9, tier netherite |
| 402 | netherite_axe | 1 | 2031 | 10 | §9.1 |
| 403 | netherite_shovel | 1 | 2031 | 6.5 | §9.1 |
| 404 | netherite_hoe | 1 | 2031 | 1 | §9.1 |
| 405 | netherite_helmet | 1 | 407 | — | 3 armor / 3 tough / 0.1 kbRes; §9.2 |
| 406 | netherite_chestplate | 1 | 592 | — | 8 / 3 / 0.1; §9.2 |
| 407 | netherite_leggings | 1 | 555 | — | 6 / 3 / 0.1; §9.2 |
| 408 | netherite_boots | 1 | 481 | — | 3 / 3 / 0.1; §9.2 |
| 409 | nether_brick | 64 | — | — | smelt netherrack; crafts nether_bricks/fence/stairs |
| 410–419 | **reserved, unused by 10** | — | — | — | — |

### 1.3 Crafting recipes (AMENDS 06 §10)

Notation per 06 §10 (rows `/`-separated; `.` empty; letters keyed below). All fit the stated grid.

| Output ×qty | Type | Pattern / ingredients | Key | 2×2 |
|---|---|---|---|:--:|
| blaze_powder ×2 | shapeless | 1 blaze_rod | — | ✔ |
| glowstone ×1 (block 32) | shaped | `DD/DD` | D glowstone_dust | ✔ |
| gold_nugget ×9 | shapeless | 1 gold_ingot | — | ✔ |
| gold_ingot ×1 | shaped | `NNN/NNN/NNN` | N gold_nugget | |
| nether_bricks ×1 | shaped | `RR/RR` | R nether_brick (item) | ✔ |
| nether_brick_fence ×6 | shaped | `BRB/BRB` | B nether_bricks, R nether_brick | |
| nether_brick_stairs ×4 | shaped | `B../BB./BBB` | B nether_bricks | |
| crimson_planks ×4 | shapeless | 1 crimson_stem | — | ✔ |
| warped_planks ×4 | shapeless | 1 warped_stem | — | ✔ |
| smithing_table ×1 | shaped | `II/PP/PP` | I iron_ingot, P any planks (incl. crimson/warped) | |
| netherite_ingot ×1 | shapeless | 4 netherite_scrap + 4 gold_ingot | — | |
| netherite_block ×1 | shaped | `III/III/III` | I netherite_ingot | |
| netherite_ingot ×9 | shapeless | 1 netherite_block | — | ✔ |

Netherite **tools/armor are NOT crafted** — they come only from the smithing-table upgrade (§9.3). **Magma cream has no crafting recipe** (see §8.3). Golden apple (`GGG/GAG/GGG`, gold_ingot) and golden carrot (`NNN/NCN/NNN`, gold_nugget) are **09's** recipes consuming this file's gold_nugget/base gold_ingot; eye of ender (`ender_pearl + blaze_powder`) is **11's**.

### 1.4 Smelting recipes (AMENDS 06 §11.2)

| Input | Output | XP | Note |
|---|---|---:|---|
| ancient_debris | netherite_scrap | 2.0 | furnace (base) 200 t; blast furnace (12) 100 t when available |
| netherrack | nether_brick (item) | 0.1 | |
| nether_gold_ore | gold_ingot | 1.0 | smelting the raw ore block (Silk-Touched); dropped nuggets don't smelt |
| nether_quartz_ore | nether_quartz | 0.2 | Silk-Touched ore; dropped quartz doesn't smelt |

> Adaptation: netherite scrap smelts in the base **furnace** (200 t). Minecraft 1.20's faster blast-furnace path is 12-VILLAGES' block; when 12 ships, the blast furnace halves this to 100 t. Nothing here blocks on 12.

### 1.5 Dimension ids (this file owns the enum)

| id | key | gen owner | hasSkyLight | ambientLight | scale (÷overworld) |
|---:|---|---|:---:|---:|---:|
| 0 | `overworld` | 02 | true | 0.00 | 1 |
| 1 | `nether` | 10 (§4) | false | 0.10 | 8 |
| 2 | `end` | 11 | false | 0.00 | 1 |

Dim 2 is **reserved for 11** — this file registers the slot and its coordinate rule (1:1, no portal scaling; End travel is 11's end-portal, not distance-scaled). Adding a dimension is a single `registerDimension(id, descriptor)` call (§2.1); ids never overlap.

---

## 2. Multi-dimension engine

The engine turns the single-world v1 (one `World`, one `ChunkManager`, one save namespace) into an **N-dimension host** where exactly one dimension is *active* (ticked, streamed, rendered) at a time, and inactive dimensions are frozen on disk. 11-END builds on this exact surface.

### 2.1 Dimension registry (`world/dimensions.js`)

```js
// A dimension descriptor is pure data + one gen function reference.
const DIMENSIONS = new Map();   // id → descriptor
function registerDimension(id, d) { DIMENSIONS.set(id, d); }

registerDimension(0, {
  id: 0, key: 'overworld',
  gen: generateOverworldChunk,          // 02
  minY: 0, maxY: 127, bedrockRoof: false, ceilingY: 127,
  hasSkyLight: true, ambientLight: 0.00,
  sky: OVERWORLD_SKY,                    // 04's full sky model
  scale: 1, evaporatesWater: false, explodesBeds: false, lavaFast: false,
  spawnTable: null,                      // 05 default overworld table
});
registerDimension(1, {
  id: 1, key: 'nether',
  gen: generateNetherChunk,             // §4
  minY: 0, maxY: 127, bedrockRoof: true, ceilingY: 127,
  hasSkyLight: false, ambientLight: 0.10,
  sky: NETHER_SKY,                       // §13 (flat red void, dense fog)
  scale: 8, evaporatesWater: true, explodesBeds: true, lavaFast: true,
  spawnTable: NETHER_SPAWNS,             // §7.2
});
// dim 2 registered by 11-END with hasSkyLight:false, ambientLight:0.00, scale:1.
```

Every descriptor field is read by an existing system: `gen` by the worker (§2.2), `hasSkyLight`/`ambientLight` by the light engine + shader (04 amendment), `sky` by the renderer (§13), `scale` by the portal router (§3.4), `bedrockRoof`/`ceilingY` by gen + the mesher's above-world rule, `evaporatesWater`/`explodesBeds`/`lavaFast` by 06's block behaviors (§10), `spawnTable` by 05's spawn cycle (§7.2).

### 2.2 Per-dimension worldgen

The gen worker (01 §9) is stateless except its noise instances; it now keys memoization by `(dim, cx, cz)`. On a `generate` message it calls `DIMENSIONS.get(dim).gen(seed, cx, cz)`. Each gen function is a **pure function of `(seed, dim, cx, cz)`** honoring 02 §2's seed streams (`subSeed`, `chunkSeed`, `splitmix32`, `posHash`, `tsin`/`tcos`). The Nether stream namespace (§4) is disjoint from 02's overworld names, so the two dimensions never share RNG. The payload shape (01 §13.2) is unchanged plus a `dim` echo; `biomes` carries **Nether biome ids** (§4.2) for dim 1.

### 2.3 The active-dimension rule

Only one dimension ticks at a time — the one the **local player** is in (14 keeps remote players host-simulated; a host in dim A does not tick dim B even if a remote player is there — `> Adaptation:` multiplayer cross-dimension simultaneity is out of scope, matching CLAUDE.md's host-authoritative single-active-world simplification; 14 owns the reconciliation).

`World` becomes a thin façade over a `Map<dimId, DimensionState>` where `DimensionState = { chunkManager, entityManager, scheduledTicks, lightEngine, fluidState }`. `world.activeDim` names the live one. 01's tick order (§3) runs the **active** DimensionState's `chunkManager.tick / entityManager.tick / scheduledTicks.run / world.randomTicks`. Inactive DimensionStates:

- do **not** tick, stream, mesh, or spawn;
- keep their modified chunks resident until memory pressure or a save flush unloads them (a returning player finds them instantly if still resident, else they hydrate from disk);
- freeze their entities in place (serialized into their chunks; unfrozen on reactivation).

`dayNight` (04) still advances `worldTime` globally (the day cycle is world-wide), but its **visual** output (skyDarken, sky colors) is gated by the active dimension's `sky` — the Nether ignores it (§13).

### 2.4 Save namespacing

Chunk-store keys become `"<dim>:<cx>,<cz>"`. `saveManager` writes/reads with the dim prefix; `savedChunkKeys` (01 §16.3) stores prefixed keys. Block-entity and entity records live inside their chunk record and inherit its dim. `meta.player.dimension` restores the active dim on load; `meta.dimensions[dimId].data` is the per-dimension blob (portal-link cache §3.6, fortress registry §5, End fight §13-of-11). Light and heightmaps are still never saved (recomputed; the Nether recompute skips sky light per §13.2).

### 2.5 Teleport / dimension-change API

The single entry point every portal (Nether §3, End §11) calls:

```js
// world/dimensions.js
function changeDimension(entity, targetDim, targetPos /*optional*/, opts = {}) {
  // 1. save + (optionally) unload the source dimension chunks around entity if it is the player
  // 2. if entity is the local player: world.activeDim = targetDim; construct/resume DimensionState;
  //    stream a 3×3 GENERATED ring around targetPos synchronously (loading veil, 01 §15.2) before unfreezing.
  // 3. place entity: entity.dim = targetDim; entity.setPos(targetPos); entity.vel = 0; entity.fallDistance = 0;
  //    entity.portalCooldown = 300;                 // §3.6, prevents immediate bounce
  // 4. dimension-arrival hook: DIMENSIONS.get(targetDim).onArrive?.(entity, targetPos);
  //    (dim 2 sets onArrive = regenObsidianPlatform — 11)
  // 5. re-register entity in the target EntityManager's spatial index; emit 'block.portal.travel' (§14).
}
```

`targetPos` is supplied by the caller (Nether portals compute + build it, §3.4/§3.5; End portal uses the fixed obsidian platform, 11). Non-player entities that change dimension (items, mobs riding portals — rare) are moved without swapping `activeDim`; they simply serialize into the target dimension and freeze until it activates.

### 2.6 What stays global vs per-dimension

| Global (one instance) | Per-dimension |
|---|---|
| `worldTime`/`dayCount` (04); weather **timers** (but Nether shows none, §13) | chunk map, entity manager, scheduled/fluid/light state |
| Player inventory, XP, health, hunger, effects (travel with the player) | block edits, mobs, item entities, spawner state |
| Atlas, materials, mesher, RNG seed | portal-link cache, fortress registry, ambient/sky/fog params |
| Hostile cap (40, shared) | active spawn table + spawnable substrate |

---

## 3. Nether portals

### 3.1 Frame geometry & validation

A portal frame is a **vertical rectangle of `obsidian` (id 33)** enclosing an air interior. Wiki-exact bounds (verified against minecraft.wiki/Nether_Portal):

- **Interior** width **2–21**, height **3–21** (i.e. exterior 4×5 minimum, 23×23 maximum including the 2-block-thick-less frame). Corner obsidian blocks are **optional** (not required to be obsidian).
- The frame must be axis-aligned to **X** or **Z** (a vertical plane); the interior must be entirely air (or already-`nether_portal`); the two vertical sides and the top & bottom rows must be obsidian for the interior's full span.

> Adaptation: the prompt's "max 21×23" is corrected to the wiki value **21×21 interior** (23×23 exterior). Sizes above that fail validation.

```js
// world/Portal.js — called from flint_and_steel use on an obsidian inner face
function validateAndFillFrame(world, hit /*block+face*/) {
  // From the ignited air/obsidian cell, flood the interior air region bounded by obsidian,
  // in the plane perpendicular to the frame's short axis. Determine axis by scanning which of
  // {X,Z} gives a bounded obsidian rectangle. Reject if the flood escapes (open frame) or exceeds
  // 21×21 interior, or is < 2×3.
  // On success: set every interior cell to nether_portal (140) with state axis-bit; recompute light.
  return { ok, axis /*0=X-plane,1=Z-plane*/, cells };
}
```

### 3.2 Ignition

`flint_and_steel` (base item 284) RMB on the **top face of the frame's bottom obsidian** or the **inner face of any frame obsidian**: run `validateAndFillFrame`. Success fills the interior with `nether_portal` and consumes 1 durability (06 rule). Failure lights a normal `fire` block (06 §5.14) as usual. Fire spreading onto a valid frame also ignites it (15-FIRE integration; note it, defer the spread to 15). Obsidian for the frame comes from base survival (water-on-lava, 06 §6.3), so portals are reachable pre-Nether without diamonds — build 10 obsidian minimum (4×5 frame minus optional corners).

### 3.3 Portal block (id 140)

- **State**: bit0 = axis (0 = frame plane spans X, portal faces ±Z; 1 = spans Z, faces ±X). No other state; **bit7 untouched**.
- **Physics**: `shape: 'custom'` — a 2/16-thick vertical translucent quad centered in the cell, non-solid, non-collidable, targetable only in debug. Emits light **11**.
- **Render**: purple starfield shader (base `#280b3b`, drifting magenta `#b061e0`/`#e0a0ff` motes, 2-frame UV scroll 0.3 px/t) — same pattern family as 11's end_portal but vertical and purple; `tr` bucket, `depthWrite:false`.
- **Support / integrity**: on neighbor update, a `nether_portal` cell with no `obsidian` and no same-axis `nether_portal` on **either** in-plane neighbor → the whole connected portal region is removed (air) — breaking one frame obsidian collapses the portal.
- **Unbreakable** by hand/tools (hardness −1); removed only by frame destruction, explosions of power ≥ its 0 blast resistance (any explosion), or the collapse rule.
- **Standing in it** drives the transfer timer (§3.4). Mobs that path into a portal also accumulate the timer (zombified piglins occasionally wander through — faithful, and how they leak to the Overworld; kept simple: only the local player actually changes the active dimension, §2.3; a non-player entity teleports and freezes in the target dim).

### 3.4 Coordinate scaling & the transfer timer

Overworld↔Nether horizontal scale is **8:1** (Nether `scale` 8): 1 block in the Nether = 8 blocks in the Overworld. **Y is preserved** (no vertical scaling). Standing (AABB overlapping any `nether_portal` cell) accumulates `portalTimer`; leaving resets it to 0; `portalCooldown > 0` suppresses accumulation (§3.6).

```
transferAt = 80 ticks (4.0 s)              // survival; debug-creative would be 0 (no creative-instant in this build → always 80)
each tick the player's AABB overlaps a nether_portal cell and portalCooldown == 0:
  portalTimer = min(portalTimer + 1, transferAt)
  if portalTimer == transferAt: initiatePortalTravel(player)   // §3.5
else if not overlapping: portalTimer = 0
```

`initiatePortalTravel` picks the target dimension: from Overworld (dim 0) → Nether (dim 1) with `dstXZ = floor(srcXZ / 8)`, `dstY = srcY`; from Nether → Overworld with `dstXZ = srcXZ * 8`, `dstY = srcY`. (Both clamped to the world border, 01 §4.1.)

### 3.5 Destination search-then-create

At the scaled destination, run the vanilla **find-or-build** in the target dimension (blocks stream synchronously in a 128-block-radius column set around `dstXZ` via the loading veil, §2.5):

```
findOrCreatePortal(dim, dstXZ, dstY):
  1. SEARCH: among loaded chunks within a 128-block horizontal radius of dstXZ (dim's chunks),
     find the nearest existing nether_portal cell (Euclidean, y weighted normally). If found →
     return a safe stand cell adjacent to that portal (feet on the frame bottom, facing into it).
  2. CREATE: no portal found → scan the same radius for the best build spot:
     prefer a location near dstY with a 4-wide × 5-tall × 1-deep pocket of non-bedrock, replaceable
     space on solid ground; score by |y − dstY| then distance to dstXZ.
     Build a **default portal**: a full 4×5 obsidian frame (WITH corners) at the chosen cell,
     axis chosen toward the arrival facing; carve a 3×4 air platform in front (both sides) and a
     3-block obsidian floor pad so the player never spawns in lava/void; fill the 2×3 interior
     with nether_portal (140); recompute light.
     > Adaptation: vanilla's full "platform obsidian shell + air cavity" (the 3×4×5 clearing padded
       with obsidian in the Nether) is reproduced only enough to guarantee a safe stand cell; the
       full cosmetic shell is trimmed. If even the fallback spot is inside bedrock roof/floor,
       clamp dstY into [5, 118] first.
  3. record the (srcPortalKey → dstPortalKey) link in meta.dimensions[dim].data.portalLinks (§3.6).
```

`changeDimension(player, dim, standCell)` (§2.5) then moves the player, sets `portalCooldown = 300`, zeroes velocity/fall distance, and emits spawn-in **purple portal particles** at both endpoints (a 1-second burst of `#e0a0ff` motes drifting from the player, 05 §16.3's Particles helper).

### 3.6 Portal cooldown & link cache

- `portalCooldown` (per entity) is set to **300 ticks** on any dimension change; it decrements each tick and, while > 0, blocks `portalTimer` accumulation. This prevents the instant bounce-back that would otherwise occur because the player materializes standing inside the destination portal. (Vanilla gates re-teleport on "must step out"; the 300-tick timer is the faithful, simpler equivalent — the default entity portal cooldown value.)
- The **portal-link cache** (`meta.dimensions[dim].data.portalLinks: Map<string,string>`) remembers which destination portal a given source portal built, so a round trip reuses the same pair instead of building a new portal each way (vanilla's practical behavior when portals are within search range). Cache misses fall back to §3.5's search.

---

## 4. Nether generation

`world/gen/nether.js` exports `generateNetherChunk(seed, cx, cz) → { blocks, heightMap, biomes, spawns }`, pure and deterministic per 02 §2. **The Nether is native 128-tall (Y 0–127) — no Y remap** (unlike 02's overworld, which compresses −64..320). The 1.16 Nether already spans Y 0–127 with lava at 31 and a bedrock roof at 127, so wiki Y values are used verbatim.

### 4.1 Vertical structure

```
y = 0        : bedrock (solid floor)
y = 1..4     : bedrock if posHash(subSeed("nether_bedrock"), x,y,z) < (5−y)/4, else netherrack   // jagged floor
y = 5..122   : NETHERRACK, then carved by the cavern field (§4.3); lava fill ≤ 31 (§4.4)
y = 123..126 : bedrock if posHash(subSeed("nether_bedrock"), x,y,z) < (y−122)/4, else netherrack  // jagged roof
y = 127      : bedrock (solid roof)
```

Seed streams (disjoint from 02): `subSeed("nether_bedrock" | "nether_cavern" | "nether_biome" | "nether_ore" | "nether_decor" | "fortress")`. Noise layers (02 §4.1 pattern, `alea` seeded `${seed}:nether:<name>`): `nCavern` (3D), `nCavern2` (3D detail), `nBiomeT`/`nBiomeH` (2D climate), `nGlow` (3D), `nSoul` (2D), `nDelta` (2D magma-patch mask).

### 4.2 Biomes (id enum owned by this file; stored in the chunk `biomes` array for dim 1)

| id | Nether biome | Fog color | Surface (top netherrack →) | Filler/notes |
|---:|---|---|---|---|
| 0 | `nether_wastes` | `#330808` | netherrack | plain; most common |
| 1 | `crimson_forest` | `#330303` | crimson_nylium | crimson stems/fungi/roots, nether_wart_block, shroomlight |
| 2 | `warped_forest` | `#1a051a` | warped_nylium | warped stems/fungi/roots, warped_wart_block, shroomlight |
| 3 | `soul_sand_valley` | `#1b4745` | soul_soil / soul_sand patches | bone_block fossils; sparse |

Selection (per column, canonical): with `t = fbm2(nBiomeT, x, z, {oct:3, freq:1/280})`, `h = fbm2(nBiomeH, x, z, {oct:3, freq:1/240})`:

```
if t < -0.35: return SOUL_SAND_VALLEY
if h >  0.33: return WARPED_FOREST
if h < -0.33: return CRIMSON_FOREST
return NETHER_WASTES
```

Large low-frequency noise → biome patches ~200–500 blocks across (Nether biomes are big). Biome only chooses **surface palette + decoration**; the cavern field and ores are biome-independent, so borders are seamless (02 §5.5 principle). `basalt_deltas` is **cut** (`> Adaptation:` fifth Nether biome; needs basalt/blackstone block budget and a bespoke terrain shape — dropped for scope; the `nDelta` mask instead seeds magma-block patches globally, §4.5).

### 4.3 Cavern carving (the "Swiss-cheese" Nether)

The Nether interior is ~40–55% open. For every solid netherrack cell with `5 ≤ y ≤ 122` (evaluated on the 02 §4.4 stride-4 trilinear lattice):

```js
function netherDensity(x, y, z) {
  const n1 = nCavern(x/48, y/40, z/48);        // big rooms (y stretched → wide caverns)
  const n2 = 0.5 * nCavern2(x/22, y/18, z/22);  // detail
  return (n1 + n2) / 1.5;                        // [-1,1]
}
// carve to air where |netherDensity| < 0.30  → interconnected caverns + pillars (positive/negative both solid)
// tapering: near the roof (y>112) and floor (y<10) raise the solid threshold so roof/floor stay mostly closed.
```

This yields the classic stacked caverns with netherrack ceilings, pillars, and open lava seas. No cavern touches y ≤ 0 or y ≥ 127 (bedrock guard). Determinism: pure noise, reach radius 0 (like 02's cheese).

### 4.4 Lava sea

After carving, every **carved-air** cell with `y ≤ 31` becomes `lava` (id 64) with state 0 (source; settled, 06 owns flow). This forms the continuous lava ocean whose surface sits at Y 31, with lavafalls where caverns open above it. (Wiki-exact: 1.16 Nether lava level Y 31.) `magma_block` patches (§4.5) generate at the lava shoreline.

### 4.5 Ores, blobs & springs (per chunk, stream `"nether_ore"`; vein algorithm = 02 §9.2)

All counts are **native 1.20 values** (no compression — the Nether wasn't remapped). Attempts draw from `splitmix32(chunkSeed(subSeed("nether_ore"), cx, cz))`, radius-1 origin re-simulation like 02 §9.1. Veins replace `netherrack` (and `nylium` surfaces) only.

| # | Feature | Block | Attempts /chunk | Size | Y distribution | Air discard |
|---:|---|---|---:|---:|---|---:|
| 1 | nether quartz | `nether_quartz_ore` | 16 | 14 | uniform 10–117 | 0 |
| 2 | nether gold | `nether_gold_ore` | 10 | 13 | uniform 10–117 | 0 |
| 3 | magma blocks | `magma_block` | 4 | 16 | uniform 27–36 (lava shoreline) | 0 |
| 4 | ancient debris large | `ancient_debris` | 1 | 2 (0–3 blocks) | **tri(8, 16, 24)** | 1.0 (fully buried) |
| 5 | ancient debris small | `ancient_debris` | 1 | 1 (0–2 blocks) | uniform 8–119 | 1.0 (fully buried) |
| 6 | soul sand patch | `soul_sand` | 12 (SSV only) | 20 | at surface of soul_sand_valley columns | 0 |
| 7 | glowstone ceiling blob | `glowstone` (id 32) | 10 | 12 | on cavern ceilings, `nGlow` gated (§4.6) | 0 |
| 8 | lava spring | `lava` source | 16 | 1 | uniform 5–120, only if enclosed by netherrack | 0 |

Ancient debris matches wiki: one triangle cluster (0–3, peak Y 16) + one uniform cluster (0–3, Y 8–119) → ~**1.65 debris/chunk**, blast-resistant, buried (air-exposure discard 1.0 so it never lines cavern walls — you must strip-mine/TNT for it). It is the **only** ore requiring a diamond-tier pickaxe (§9). Nether gold ore drops **2–6 gold_nugget** (base; Fortune/Silk 08). Nether quartz ore drops **1 nether_quartz**, XP 2–5.

### 4.6 Glowstone blobs (ceiling-hung)

Glowstone generates as clusters hanging from cavern **ceilings** (undersides of solid netherrack). Per attempt: pick a random `(x,z)`; scan down for the first air cell whose block above is solid netherrack (a ceiling); require `nGlow(x/40, y/40, z/40) > 0.2`; grow a downward blob (2–4 cells tall, tapering) of `glowstone` replacing air. Glowstone (id 32) drops **2–4 glowstone_dust** (item 395) when broken (per 09's AMENDS 06 §2 — now realized). Light 15 lights the surrounding caverns (§13's ambient floor keeps the rest visible).

### 4.7 Surface decoration (stream `"nether_decor"`, fixed order, local unless noted)

Runs after carving/ores. For each column, `topY` = highest solid netherrack below open air (the cavern floor / walkable surface). Per biome:

1. **crimson_forest** (nylium surface): replace top netherrack with `crimson_nylium`; then attempt: crimson_roots (density 8/chunk on nylium), crimson_fungus (2/chunk), **huge fungus** (1 in 1/12 chunks → a `crimson_stem` column 4–8 tall capped with a `nether_wart_block` blob + 1–2 `shroomlight`, §4.8), `nether_wart_block`/`shroomlight` scatter (3/chunk).
2. **warped_forest**: `warped_nylium` surface; warped_roots (8), warped_fungus (2), huge warped fungus (1 in 1/12 → `warped_stem` + `warped_wart_block` cap + shroomlight), warped_wart_block scatter (3). Warped forest is the safe biome (no natural piglin/zombified-piglin spawns, §7.2).
3. **soul_sand_valley**: replace surface with `soul_sand` where `nSoul(x/30,z/30) > 0` else `soul_soil`; scatter `bone_block` fossil arcs (1 in 1/20 chunks → a 3–6-block curved rib of bone_block, deterministic from `posHash`); sparse — the openest, most dangerous biome (ghasts + skeletons, §7.2).
4. **nether_wastes**: bare netherrack; occasional `magma_block` at the lava shore (already from §4.5); no vegetation.
5. **heightmap**: recompute per 01 §4.2 (topmost `skyOpacity>0`); with no sky light this only feeds the (empty) rain/lightning systems, which the Nether disables (§13). Cross-shape plants excluded as usual.

### 4.8 Huge fungi shapes

Simplified deterministic shapes (`> Adaptation:` vanilla's randomized huge fungus is replaced with a fixed silhouette, like 02's spruce cone):

```
crimson: stem crimson_stem y=0..H-1 (H = 4 + rngInt(5) → 4–8); cap = nether_wart_block
         3×3 at y=H, plus a +shape at y=H-1; embed 1–2 shroomlight in the cap (posHash<0.25).
warped:  identical with warped_stem + warped_wart_block.
```

Vines (weeping/twisting) are **cut** (climbable-block budget; no §5.13-style rope mechanic added).

### 4.9 Nether fortress trigger

Fortresses (§5) are placed on a deterministic region grid and generated **inside** `generateNetherChunk` via origin-chunk re-simulation (like 02's trees), writing only cells that land in the current chunk. Fortress cells override carving/ores/decoration for their footprint. Their spawn records (blaze spawner mob type + garden mobs) are emitted like herd records (02 §11).

---

## 5. Nether fortress

A deterministic piece-grammar structure of `nether_bricks`, spanning many chunks, hovering over the lava sea on bridges, with corridors, blaze-spawner rooms, nether-wart gardens, and loot chests. Follows 02's structure discipline (pure function of seed + structure origin, no cross-chunk mutable state) and mirrors 11's stronghold approach.

### 5.1 Placement (region grid)

> Adaptation: **one fortress per region**, region = **27×27 chunks** (432×432 blocks) — Minecraft's average fortress spacing. Deterministic:

```
regionX = floor(cx / 27), regionZ = floor(cz / 27)
rng = splitmix32(hash(subSeed("fortress"), regionX, regionZ))
originChunk = (regionX*27 + rngInt(rng,20), regionZ*27 + rngInt(rng,20))   // jitter within a 20-chunk sub-box
originY = 48 + rngInt(rng, 24)     // 48..71 — above the lava sea, in open cavern space where possible
// A chunk C generates fortress cells for every region whose fortress bounding box (≤ ±48 blocks
// from origin, so Chebyshev radius 3 chunks) overlaps C.
```

The fortress registry (`meta.dimensions[1].data.fortresses`) records generated origins (for the fortress-local spawn override, §7.2) but is **not** authoritative for gen — gen re-derives from seed (the registry is a spawn-time convenience, rebuilt on demand).

### 5.2 Piece grammar

Deterministic BFS expansion from a **start** piece, capped, all draws from the fortress region stream (order-stable, so every overlapping chunk replays identically):

| Piece | Footprint (w×h×d) | Sockets | Notes |
|---|---|---|---|
| Start (bridge crossing) | 7×9×7 | 4 (N/E/S/W) | central pillar down into lava |
| Bridge (straight) | 5×?×7 (len 5–19) | 2 (ends) | open-sided nether-brick bridge with fence rails; lava below |
| Bridge stairs | 7×11×7 | 2 (offset ±6 y) | connects levels |
| Corridor (enclosed) | 5×5×5 | up to 3 | roofed nether-brick hall |
| Corridor T / cross | 5×5×5 | 3–4 | branching |
| Wart garden | 9×7×9 | 1–2 | soul_sand floor + `nether_wart` (stage 3) rows + **1 loot chest**; the only nether-wart survival source |
| Blaze room | 7×7×7 | 1–2 | central 2-block pillar topped with a `spawner` (blaze) + fence cage |
| Balcony / lookout | 5×5×5 | 1 | dead-end with a fence railing, occasional loot chest |

Grammar rules: expand up to **`pieceTarget = 18 + rngInt(rng, 10)`** pieces within a Chebyshev **48-block** radius of origin; a socket spawns a weighted child (bridges 40 / corridors 30 / T-cross 12 / wart garden 8 / blaze room 6 / balcony 4), collision-tested against placed pieces (overlap → try next weighted pick, else seal the socket with a nether-brick wall). Guarantee ≥ 1 blaze room and ≥ 1 wart garden by forcing them if absent by the time the queue drains (place at the deepest open socket, like 11's portal-room guarantee).

### 5.3 Construction blocks

`nether_bricks` (walls/floors/roofs), `nether_brick_fence` (bridge rails, cage bars, garden trims), `nether_brick_stairs` (stair pieces), `soul_sand` + `nether_wart` (gardens), `spawner` (blaze rooms), `chest` (base id 37, loot), `lava` (below bridges — reuse the §4.4 sea). No lighting blocks inside (fortresses are dark → mobs spawn, §7.2). Cells are written only where they fall inside the current chunk (02 §10.1 overlap discipline).

### 5.4 Blaze spawner placement

Each blaze room places a `spawner` (id 141) on top of its central 2-block nether-brick pillar, block-entity `{ mobType: 'blaze', ...§6 defaults }`, wrapped in a `nether_brick_fence` cage (visual). It is the primary blaze source (open-biome blazes don't spawn). Breaking the spawner (needs a pickaxe, drops nothing, XP 15–43) is the vanilla "disable the farm" play.

### 5.5 Loot chests

Every wart garden (always) and ~40% of balconies place one `chest` with a rolled loot table. Rolls: **5–8 stacks** drawn with weights (draw from the region stream so the same chest is identical from every overlapping chunk):

| Item (in scope) | Weight | Count |
|---|---:|---|
| nether_wart (390) | 10 | 3–7 |
| gold_nugget (396) | 10 | 4–24 |
| iron_ingot (322) | 10 | 1–5 |
| gold_ingot (324) | 8 | 1–3 |
| obsidian (33 block-item) | 6 | 2–4 |
| flint_and_steel (284) | 6 | 1 |
| golden_sword (271) | 5 | 1 (05 durability roll) |
| golden_chestplate (293) | 5 | 1 |
| diamond (325) | 3 | 1–3 |
| netherite_scrap (398) | 1 | 1 (rare — the "jackpot") |

`> Adaptation:` saddles, horse armor, and music-disc fortress loot are cut (out of scope items). The netherite_scrap rare roll gives a below-mining path to the netherite tier, matching vanilla loot-chest debris.

---

## 6. Generic monster-spawner block

`spawner` (block id 141) + block entity — a reusable spawner defined cleanly so 11 (or anything) could instantiate it with a different `mobType`. (11's End portal room deliberately does **not** use it, §11-END; it exists for fortresses and debug.)

### 6.1 Block entity fields

```js
{ mobType: 'blaze',            // any registered mob id/name
  delay: 20,                   // ticks until next spawn attempt (init randomized)
  minDelay: 200, maxDelay: 800,
  spawnCount: 4,               // mobs attempted per activation
  maxNearby: 6,                // skip if ≥ this many mobType within the check box
  activationRange: 16,         // player within this (Euclidean) → active
  spawnRange: 4 }              // horizontal ± range for spawn attempts
```

### 6.2 Tick (only while a player is within `activationRange`, in the active dimension)

```
each tick with a player in range:
  spawn spin/flame particles (render);
  if (delay > 0) { delay--; break; }
  nearby = count entities of mobType within box [±(2*spawnRange+1)/2 xz, ±2 y] of the spawner
  if (nearby >= maxNearby) { delay = randInt(minDelay, maxDelay); break; }
  spawnedAny = false
  for k in 0..spawnCount-1:
    tx = x + (rand()*2-1)*spawnRange;  ty = y + randInt(3)-1;  tz = z + (rand()*2-1)*spawnRange
    if validSpawnPos(floor(tx), floor(ty), floor(tz), mobType)   // 05 §3.2 clearance; Nether light rule (§7.2)
       and count(mobType nearby) < maxNearby:
       spawnMob(mobType, tx, ty, tz); spawnMobParticles(); spawnedAny = true
  if (spawnedAny) delay = randInt(minDelay, maxDelay)
```

Matches vanilla: activates within 16 blocks, 200–800-tick delay, up to 4 spawns per cycle, capped at 6 nearby, spawn range 4. Not obtainable in survival (no Silk-Touch pickup — vanilla), drops nothing, gives 15–43 XP when mined. Render: a wireframe nether-brick cage (custom cube outline) with a **spinning miniature `mobType` model** at half-scale inside + a small caged flame (light 1).

---

## 7. Nether mobs — stat blocks

Six mobs in 05 §2's exact stat-block format. All extend `Mob` (05), use the 05 goal/AI framework, `dim` field (§2), and — except ghast/magma cube which fly/hop — 05's A* pathfinding. Fire-immune mobs never take FIRE/LAVA/BURNING damage and never ignite (05 amendment). None burn in daylight (no Nether sky light). RNG per 05 §1.

### 7.1 Roster table

| Stat | Ghast | Blaze | Zombified Piglin | Magma Cube (big) | Wither Skeleton | Piglin |
|---|---|---|---|---|---|---|
| HP | 10 | 20 | 20 | 16 (size²) | 20 | 16 |
| AABB (w×h, m) | 4.0×4.0 | 0.6×1.8 | 0.6×1.95 | 2.04×2.04 (size×0.51) | 0.7×**2.4** | 0.6×1.95 |
| Natural armor pts | 0 | 0 | 2 | 0 | 0 | 0 |
| MC speed attr | flies | flies | 0.23 | hops | 0.25 | 0.35 |
| Walk/chase b/s (approx) | fly 0.6/0.9 (0.03/0.045 b/t) | fly 0.4 hover | 2.3 / 2.3 (0.115) | hop (size-scaled, §7.5) | 2.5 / 2.5 (0.125) | 3.0 / 4.0 aggro (0.15/0.20) |
| Attack dmg (Normal) | fireball: explosion power 1 (§7.2) | fireball 5 (3-burst) / touch 6 | melee **8** (golden sword) | 3/4/**6** by size (size+2) | melee **8** (stone sword) + Wither I 0:10 | melee **8** (golden sword) |
| Attack reach | ranged ≤64 | ranged ≤48 | 2.0 | contact (size box) | 2.0 | 2.0 |
| Melee cooldown | — | — | 20 t | contact | 20 t | 20 t |
| Detection range | 64 (shoot) | 48 | neutral → 35 when angered | 16 | 16 | neutral → 16 when provoked |
| XP on death | 5 | 10 | 5 | 4/2/1 by size `(approx)` | 5 | 5 |
| Fire immune | yes | yes | yes | yes | yes | yes |
| Undead | no | no | **yes** | no | **yes** | no |

Drops (player-caused death; Looting is 08's):

| Mob | Drops |
|---|---|
| Ghast | 0–1 `ghast_tear` (394), 0–2 `gunpowder` (base 329) |
| Blaze | 0–1 `blaze_rod` (391) — 50% base rate |
| Zombified Piglin | 0–1 `rotten_flesh` (314), 0–1 `gold_nugget` (396); rare (2.5%): `gold_ingot` or `golden_sword` |
| Magma Cube | big/medium: 0–1 `magma_cream` (393); small: nothing |
| Wither Skeleton | 0–2 `bone` (331), 0–1 `coal` (319); **2.5%: 1 `wither_skeleton_skull` (block-item 186, 13)** |
| Piglin | 0–1 `gold_nugget` (396) rarely; primarily give bartered goods when alive (§7.6), not death drops |

### 7.2 Spawning (AMENDS 05 §3.2 for dim 1)

Spawnable substrate `NETHER_SPAWNABLE = { netherrack, nether_bricks, soul_sand, soul_soil, crimson_nylium, warped_nylium, magma_block, ...any opaque full cube }`. Nether light rule: sky light is always 0, so `canSpawnHostileAt` reduces to **`blockLight(pos) == 0` for most Nether mobs**, but ghasts and magma cubes ignore the light check entirely (they spawn in any light — faithful), and blazes/wither skeletons use the fortress override below. The shared hostile cap **40** applies (§2.3).

Per-biome spawn weights (open-biome natural spawns):

| Biome | Weights |
|---|---|
| nether_wastes | zombified_piglin 100, ghast 50, magma_cube 15, piglin 15, enderman 1 (05's) |
| crimson_forest | piglin 100, zombified_piglin 15, magma_cube 2 |
| warped_forest | enderman 100 (05's) — the "empty/safe" biome; almost nothing else |
| soul_sand_valley | ghast 50, skeleton 20 (05's overworld skeleton, non-burning here), enderman 5, magma_cube 2 |

Fortress-local override (inside a fortress bounding box, §5.1): `{ wither_skeleton 40, zombified_piglin 4, magma_cube 4, blaze 4 }` — plus the blaze **spawner** (§5.4) supplies most blazes. Fortresses spawn these at block light ≤ 11 (vanilla fortress rule — they need the darkness the roofless bridges rarely provide, so fortress mobs cluster in the enclosed corridors).

Pack sizes: ghast 1, blaze 2–3, zombified_piglin 4 (herd-like), magma_cube 1–4, wither_skeleton 1–2, piglin 2–4. Zombified piglins spawn in groups and are the Nether's ambient crowd.

### 7.3 Ghast (`entities/mobs/nether/Ghast.js` + `entities/GhastFireball.js`)

Giant floating jellyfish, 4×4 hitbox. **Flight AI** (no A*): drifts with a random-walk `moveIntent` in 3D at 0.03 b/t, gently avoiding solid blocks (steer away when a short forward raycast hits within 4 m). Buoyancy replaces gravity (no gravity while alive).

`ShootFireball` goal (priority 1): canStart — player within **64**, LOS (opaque-only raycast). tick: face the target; charge for **20 ticks** (mouth-open "charging" texture + `entity.ghast.warn` sound), then fire one `GhastFireball` from the mouth aimed at the target's current position; then `attackCooldown = 60` (3 s, wiki-approx). Detection to *see* the player is 100 blocks; it only *shoots* within 64.

`GhastFireball` entity: gravity 0 (flies straight, drag ×0.95), speed ~0.95 b/t along the launch dir, lifetime 200 t.

- **On block/entity impact:** explosion **power 1** (05 §12 formula; ignites a `fire` at impact — the fireball's signature). Direct entity hit sets the target on fire (03).
- **Deflection (detailed):** each tick, test the fireball's swept segment against melee/projectile hits: (a) a **player melee swing** (05 §13.3) whose reach segment intersects the fireball's AABB (inflated 0.3), or (b) an **arrow/thrown projectile** whose path intersects it. On a hit: **reverse and redirect** — set `vel = deflectorLookDir × currentSpeed` (for a melee deflect, the player's look direction; for a projectile, the projectile's velocity direction), and set `owner = deflector`. No damage to the fireball itself; play `entity.ghast.fireball` reflect variant. A fireball whose `owner` is now the player and which strikes the **ghast** deals its power-1 explosion to the ghast — a direct deflected hit does ≥ 10 in-box explosion damage and **one-shots** the 10-HP ghast (wiki: "hit back to kill on direct impact"). This is the intended kill method.

Drops 0–1 ghast_tear + 0–2 gunpowder, XP 5. Render: 05 §16-style box — 8×8×8 px body + 9 dangling 2×2×N px tentacles; mouth-open texture while charging.

### 7.4 Blaze (`Blaze.js` + `entities/SmallFireball.js`)

Floating column of rods, on fire (emissive). **Hover AI:** stays airborne near its target, bobbing; `Swim`-equivalent not needed. Fire immune. **Water-vulnerable: `hurtByWater = true`** — takes **1 damage** per tick of contact with a water/flowing-water cell, a splash-water bottle (09 §13.3), or rain exposure (15's rain-exposure test); the sole water weakness in the Nether roster (consumed by 09 §13.3 and 15's fire/water systems). Detection 48.

`BurstFireball` goal (priority 1): canStart — target within 48, LOS. tick: rise slightly, `blaze.on-fire` glow ramps for ~30 ticks (charge), then fire a **3-shot burst**: three `SmallFireball` projectiles at ~4-tick spacing aimed at the target, then `attackCooldown = 100` (5 s). Each `SmallFireball`: straight flight (gravity 0, drag ×0.98), speed ~0.6 b/t, on hit deals **5** fire damage + ignites the target (3 s of fire); no explosion. Melee touch (any entity contacting the blaze's box) takes **6** and catches fire.

Blaze is the sole `blaze_rod` source (50% drop, 0–1), XP 10 (double normal). Render: 8×8×8 px head + 12 rotating 2×2×8 px rods in 3 rings spinning at 6°/tick; whole model emissive orange, particle embers.

### 7.5 Magma Cube (`MagmaCube.js`)

Slime-like bouncer, sizes **1 / 2 / 4** (small/medium/big; NBT-equivalent 0/1/3). Derived stats: **HP = size²** (1 / 4 / 16), **attack = size + 2** (3 / 4 / 6, wiki-verified), **AABB = (size×0.51)²×(size×0.51)** (0.51 / 1.02 / 2.04 per side), XP 1/2/4 `(approx)`. Fire immune. Bigger cubes **jump higher and less often** and move faster (vanilla quirk).

- **Hop locomotion:** replaces walk. Every `40 + rngInt(60)` ticks while `onGround`, if it has a target hop toward it (else random yaw): `vy = 0.42 + size*0.1`, horizontal `= facing × (0.10 + 0.02*size)` b/t. Contact damage on any tick its box overlaps the player: `size+2` (20-tick i-frames via 05 §14).
- **Splitting on death:** medium/big split into **2–4** cubes of the next size down, spawned around the death point with outward velocity; **small cubes disappear** (no split, no item). Splits happen for any death (including lava — but it's immune, so mostly player kills). Each spawned child counts against the hostile cap.
- Drops: big/medium 0–1 `magma_cream`; small nothing. Render: nested cube (inner core 8×8×8 + outer translucent shell, emissive seams that widen mid-hop) scaled by size.

### 7.6 Zombified Piglin (`ZombifiedPiglin.js`)

Neutral undead, 20 HP, golden sword. **Neutral until provoked; anger propagates through the pack** — the signature.

- **Provocation:** the player attacks any zombified piglin. That instant, the struck mob and **every zombified piglin within a spreading radius** become angry at that player. Anger propagation (vanilla): on being hit, set `angerTarget = player`, `angerTime = randInt(400, 800)` ticks (20–40 s); each angry mob, once per few ticks, alerts **all zombified piglins within a 20-block radius** to the same target with a similar anger timer (chain reaction across the crowd). Angry mobs use 05's `MeleeAttack` goal (reach 2.0, cooldown 20, **8** damage), detection 35 while angry; neutral mobs ignore the player entirely (wander only).
- **Anger decay:** `angerTime` counts down; at 0 the mob reverts to neutral **unless** it still has LOS to its target. A player who flees far/long enough is forgiven.
- Undead (09 inversions + Poison/Regen immunity), fire immune, does **not** burn (no sky light, and immune anyway). Drops 0–1 rotten_flesh, 0–1 gold_nugget; rare gold_ingot/golden_sword. XP 5. Render: humanoid (05 §16) with green-pink zombified-piglin skin, held golden sword; angry pose (arms raised) when aggro.

### 7.7 Wither Skeleton (`WitherSkeleton.js`)

Tall (2.4 m) black skeleton with a stone sword; inflicts **Wither**. HP 20, undead, fire immune.

- **AI:** 05 skeleton-frame goals but **melee, not ranged** — `MeleeAttack` (reach 2.0, cooldown 20). On a landed hit: deal **8** damage, then `addEffect(target, 20 /*wither*/, 0, 200)` — **Wither I for 10 s** (09's engine; hearts turn black, drains, can kill). Detection 16.
- Height 2.4 means it does **not** fit through a 2-block-tall gap — a faithful defensive quirk (players can shelter under 2-high overhangs). Its A* node clearance requires 3 cells tall (like enderman, 05 §7).
- **Skull drop: 2.5%** → 1 `wither_skeleton_skull` (block-item 186, 13's block) on player kill. Also 0–2 bone, 0–1 coal. XP 5. Fortress-only spawns (§7.2). Render: 05 skeleton box scaled to 2.4 m, charcoal `#2b2b28` bone texture, stone sword.

### 7.8 Piglin (`Piglin.js`)

Neutral humanoid gold-hunter, 16 HP, golden sword. **Bartering** + **zombification** are the features.

- **Hostility:** a piglin is hostile to a player **not wearing at least one piece of gold armor** and within 16 blocks (attacks with the golden sword, 8 dmg, reach 2.0), OR to any player who: mines a `gold_ore`/`nether_gold_ore`/`gold_block` nearby, opens a `chest` near it, or attacks it. A player in gold armor is ignored unless they provoke it. `> Adaptation:` piglin crossbow ranged attack is cut — melee only.
- **Bartering (simplified):** give a piglin a `gold_ingot` — either **RMB a piglin with a gold_ingot in hand** (consumes 1) or **drop a gold_ingot item** within ~1 block of an idle, non-hostile piglin (it picks it up). The piglin then **examines for 6 s** (120 ticks; "admiring" pose), then throws **one reward** from the barter table at the player:

| Reward (in scope) | Weight | Count |
|---|---:|---|
| `ender_pearl` (334) | 10 | 2–4 |
| `string` (327) | 8 | 3–9 |
| `nether_quartz` (397) | 8 | 5–12 |
| `gold_nugget` (396) | 8 | 10–36 |
| `gravel` (19 block-item) | 8 | 8–16 |
| `iron_nugget`→ **substitute `iron_ingot` (322)** | 6 | 1 `(approx)` |
| `obsidian` (33) | 5 | 1 |
| `fire_charge`→ **substitute `gunpowder` (329)** | 4 | 1–5 `(approx)` |
| `soul_sand` (119) | 4 | 2–8 |
| `magma_cream` (393) | 3 | 2–6 |
| `glowstone_dust` (395) | 3 | 5–12 |
| `crying_obsidian`→ **substitute `obsidian` (33)** | 2 | 1–3 `(approx)` |

> Adaptation: barter items not in any spec (iron nugget, fire charge, crying obsidian, potions, splash fire res, spectral arrows, leather, books, water bottle, soul speed boots, nether brick, string→already) are substituted with the nearest in-scope item and marked `(approx)`; the ender-pearl reward is the important one (feeds 11's eye of ender chain). One barter per gold ingot.

- **Zombification:** a piglin in a dimension where `hasSkyLight !== false`... actually the rule is dimension-keyed: any piglin **not in the Nether** (dim ≠ 1) starts a **15-second (300-tick, approx)** conversion — shaking animation ramps over the last 5 s — then transforms into a **zombified_piglin** (§7.6) at the same position, preserving anger state. This is why piglins dragged to the Overworld/End rot. XP 5. Render: humanoid with piglin snout/ears texture, golden sword; admiring pose while bartering; shaking/greening while converting.

---

## 8. Brewing ingredients

09-POTIONS depends on these by **name and id** (§1.2). This section owns their sourcing and non-brewing recipes; 09 owns their brewing edges.

### 8.1 Nether wart (crop block 138 / item 390)

The brewing base crop (water + nether_wart → awkward, 09 §12.2). Planted like a seed.

- **Item 390 `nether_wart`:** RMB on `soul_sand` (119) with air above → place crop block 138 at stage 0. Only soul sand is valid substrate (no light requirement — grows in the dark Nether). Also the harvest yield and brewing ingredient.
- **Crop block 138:** state bits 0–1 = stage **0–3** (4 stages; render as `hash` with 3 distinct textures — stages 0, 1–2, 3). Random tick (06 §17): if support is `soul_sand`, `stage < 3` → `stage + 1` with probability **1/10** `(approx — vanilla ~10% per random tick, no light gate)`. Breaking at stage 3 drops **2–4** nether_wart; stages 0–2 drop 1. Removing the soul sand pops the crop.
- **Worldgen source:** fortress wart gardens (§5.2) generate stage-3 nether_wart on soul sand — the bootstrap before you can farm it. Bone meal does **not** affect nether wart (vanilla).

### 8.2 Blaze rod → blaze powder (items 391 → 392)

- `blaze_rod` (391): blaze drop only (50%, §7.4). Crafts the **brewing stand** (09 §7.2: `.B./CCC`) and **end rods** (11) and **eyes of ender** need blaze *powder*.
- `blaze_powder` (392): crafted **1 blaze_rod → 2 blaze_powder** (§1.3). Used as brewing-stand **fuel** (09 §10.1: 1 powder = 20 brews) **and** the Strength brewing ingredient (09 §12.2) **and** eye-of-ender crafting (11). Both fuel and ingredient — 09 handles which slot.

### 8.3 Magma cream (item 393)

Fire-Resistance ingredient (09 §12.2). **Source: magma cube drop only** (big/medium, 0–1).

> Adaptation: Minecraft crafts magma cream from **blaze powder + slimeball**, but this project has no slimes/slimeball (05 excludes slimes). Magma cream is therefore obtained **only** as a magma-cube drop — there is no crafting recipe. This keeps Fire Resistance gated behind Nether combat, which is thematically apt.

### 8.4 Ghast tear (item 394)

Regeneration ingredient (09 §12.2) and end-crystal material (13). **Source: ghast drop only** (0–1, §7.3). No recipe. The deflect-kill mechanic (§7.3) is the intended acquisition — a satisfying skill gate.

### 8.5 Glowstone dust (item 395)

Potion-amplifier modifier (09 §12.2: base → strong). **Source:** breaking `glowstone` (block 32) drops **2–4 glowstone_dust** (realizes 09's AMENDS 06 §2). Reverse recipe: **4 glowstone_dust → 1 glowstone** block (§1.3). Glowstone generates in Nether ceiling blobs (§4.6) and occasionally in overworld caves (02's note).

### 8.6 Gold nugget (item 396)

Golden-carrot material (09 §9.2). Conversions (§1.3): **9 gold_nugget ↔ 1 gold_ingot** (base 324). Sources: `nether_gold_ore` drop (2–6), zombified-piglin drop (0–1), piglin barter (10–36), fortress loot (4–24). Also the crafting bridge for **any** gold-nugget recipe (golden carrot 09, and available to 07/12).

### 8.7 Nether quartz (item 397)

Not a brewing ingredient — noted here for completeness. `nether_quartz_ore` (122) drops 1 quartz (Fortune multiplies, 08), XP 2–5. A collectible/crafting material available to **07-REDSTONE** (comparators/observers/daylight sensors use quartz in vanilla) — this file simply provides the item and its ore; 07 defines any consumers.

---

## 9. Netherite tier (AMENDS 06)

The endgame gear tier. Progression: `ancient_debris` (mine with diamond+ pick, §4.5) → smelt → `netherite_scrap` (398) → 4 scrap + 4 gold_ingot → `netherite_ingot` (399) → **smithing-table upgrade** of diamond gear → netherite gear (keeps enchantments + durability).

### 9.1 Netherite tools (item rows for 06 §7.1)

Durability **2031** (all). Mining speed multiplier **×9** (06 tier ladder amendment; diamond ×8). Mining tier **netherite (4)** — harvests everything diamond can, at ×9 speed. **Enchantability 15** (08). Attack speed identical to the diamond counterpart (05 §13.2).

| ID | Name | Dur | Speed× | Dmg | Attack speed (05) |
|---:|------|----:|-------:|----:|---|
| 400 | netherite_sword | 2031 | — | 8 | 1.6 (T=12.5) |
| 401 | netherite_pickaxe | 2031 | 9 | 6 | 1.2 (T=16.67) |
| 402 | netherite_axe | 2031 | 9 | 10 | 1.0 (T=20) |
| 403 | netherite_shovel | 2031 | 9 | 6.5 | 1.0 (T=20) |
| 404 | netherite_hoe | 2031 | 9 | 1 | 4.0 (T=5) |

Each is diamond **+1** attack damage (sword 7→8, axe 9→10, pickaxe 5→6, shovel 5.5→6.5, hoe 1→1), matching 05 §13.2's table extended one column. Durability spend + tool/sword rules identical to 06 §7.1.

### 9.2 Netherite armor (item rows for 06 §7.2)

Armor points **identical to diamond** (total 20); **toughness 3/piece** (12 total, diamond is 2/8); **knockback resistance 0.1/piece** (0.4 total — new stat, see below); **enchantability 15**.

| ID | Name | Dur | Armor pts | Toughness | KB resist |
|---:|------|----:|----------:|----------:|----------:|
| 405 | netherite_helmet | 407 | 3 | 3 | 0.1 |
| 406 | netherite_chestplate | 592 | 8 | 3 | 0.1 |
| 407 | netherite_leggings | 555 | 6 | 3 | 0.1 |
| 408 | netherite_boots | 481 | 3 | 3 | 0.1 |
| — | **set total** | — | **20** | **12** | **0.4** |

**Knockback resistance** (new — AMENDS 05 §14.3): each worn piece's `kbResist` sums into `entity.knockbackResistance` (0–1). In `applyKnockback` (05 §14.3), multiply the applied strength by `(1 − knockbackResistance)` and, per vanilla, treat it as a probabilistic/scaled reduction: `strength *= (1 − clamp(knockbackResistance, 0, 1))`. Full netherite (0.4) → melee knockback reduced 40%. (05's roster all have 0; only netherite armor grants it in this build.) Armor durability loss identical to 06 §7.2.

The armor-reduction formula (05 §14.2) is unchanged — netherite's higher **toughness** (3/piece) is what makes it tank big hits better than diamond at the same 20 armor points; plug the 12 total toughness into 05 §14.2's `toughness` term.

### 9.3 Smithing-table upgrade (AMENDS 06 §5 / §14)

The smithing table (block 143) opens a 3-slot UI: **[base gear] + [material] → [result]** (a container screen in 06 §15.3's family; shift-click routes gear→base, ingots→material).

```
upgrade(base, material):
  if material.id == netherite_ingot (399) and base is a DIAMOND tool/armor:
     result = the netherite counterpart of base (diamond_pickaxe→netherite_pickaxe, etc.)
     result.tags = base.tags                     // 08's enchantments/rename carried over verbatim
     usedDurability = base.maxDur - base.durability          // absolute durability already spent
     result.durability = max(1, result.maxDur - usedDurability)   // carry the damage over onto the new (higher) max
     consume 1 base + 1 netherite_ingot; award nothing (no XP — smithing is free)
```

> Adaptation (pre-1.20 smithing — DECIDED): Minecraft 1.20 requires a **Netherite Upgrade smithing template** as a third ingredient. This build uses the **1.16–1.19 recipe: diamond gear + netherite ingot, no template.** No smithing templates are added (they'd need a bastion structure + a whole template item family, all out of scope). Enchantments and the exact used-durability transfer to the result (vanilla-faithful for both eras).

### 9.4 Item properties: fire/lava immunity

All 9 netherite items (399–408) plus the `netherite_block` **item** (block-item 142) are flagged `lavaImmune`: as dropped item entities they are **not destroyed by lava, fire, or cactus contact** and **float on the surface of lava** (buoyancy like water, 06 §16 — a floating item, not sinking). This lets a player recover netherite gear from a lava death (the signature netherite perk). All other item entities burn per base 06 §16.

`ancient_debris` (124) and `netherite_block` (142) are **blast-resistant** (blast 1200) — TNT/creeper/ghast explosions never destroy them, so blowing up netherrack to expose debris leaves the debris intact (the standard TNT-mining strategy). Both require a **diamond-tier** pickaxe to drop (netherite mines them faster).

---

## 10. Hazards & environment

### 10.1 Water evaporates in the Nether

In any dimension flagged `evaporatesWater` (Nether), placing a **water source** (water_bucket, dispenser) does nothing but a poof: the target cell stays as-is, the bucket empties (or the dispenser consumes the water_bucket → empty bucket), and a smoke/steam particle burst + `block.extinguish` hiss plays (§14). Flowing water can never exist. **Ice/snow** placed in the Nether behaves the same (evaporates on melt attempts). Consequence: no water-on-lava obsidian farming in the Nether (bring obsidian). Waterlogging (15) is impossible in the Nether (the water half evaporates) — the `evaporatesWater` flag short-circuits 15's waterlog placement in dim 1.

### 10.2 Beds explode (AMENDS 06 §5.7)

In any dimension flagged `explodesBeds` (Nether only — the End is **denial-only**, 11 §7's dim-2 descriptor does not set `explodesBeds`), **RMB on a `bed_block` triggers an explosion instead of sleeping**: remove the bed, spawn a **power-5** explosion (05 §12 formula) centered on the used bed half, **with fire** (ignite surviving flammable/`fire`-placeable cells). This deals up to ~40 damage point-blank (lethal without armor — the classic Nether death). Spawn-point setting still occurs *before* the explosion check only in the Overworld; in exploding-bed dimensions the RMB goes straight to detonation (no spawn set, no sleep). `> Adaptation:` respawn anchors (the Nether's intended respawn block) are **out of scope** — no anchor block, no charge mechanic; the Nether simply has no safe respawn, matching early-game vanilla.

### 10.3 Soul sand & magma block

- **Soul sand (119):** 14/16-height top collision box — entities stand 2/16 lower and are **slowed** (horizontal velocity ×0.4 while standing on it, `(approx)` of vanilla's speed factor). Nether wart plants only on soul sand (§8.1). Soul soil (120) is a full cube with no slow (its only mechanical role here is the wither-summon `isSoulBlock` predicate for 13 and SSV terrain).
- **Magma block (121):** any entity standing on top with its feet in the cell above takes **1 fire-type damage per 10 ticks** (`(approx)` of vanilla's continuous 1/tick gated by i-frames), unless fire-resistant (09) or sneaking (sneaking on magma blocks negates the damage, vanilla). Emits light 3. Item entities on magma blocks are **not** destroyed (unlike lava). Magma blocks generate at the lava shore (§4.5) — a hidden Nether hazard.

### 10.4 Lava behavior

Per §AMENDS 06 §6.1, dim-1 lava is **fast**: spreads **7** cells horizontally, updates every **10 ticks**, drops 1 level/step (Overworld lava stays 3/30/2). Lavafalls off the §4.4 sea and cavern lava move quickly — the Nether feels fluid and dangerous. Water×lava interactions (06 §6.3) can't occur in the Nether (no water). **Fire on netherrack burns forever** (`> Adaptation:` note only — full fire spread + the flammability tables are **15-FIRE-WATERLOGGING**'s job; this file registers netherrack's `eternalFire` flag so 15's fire-burnout scheduled tick skips fire whose support is netherrack, and magma/lava/glowstone light the Nether even before 15 ships). Soul fire, soul torches, soul campfires are **cut** (no soul-fire block family added; soul sand's only role is nether wart + the wither predicate).

### 10.5 Compass/clock, and other cut environment

Compasses and clocks spin uselessly in the Nether in vanilla — **out of scope** (neither item exists in the base registry). No lodestone, no respawn anchor, no basalt/blackstone, no bastions, no hoglins/striders/piglin brutes (the roster is exactly §7's six). Endermen (05) may spawn in warped forest / soul sand valley per §7.2 and behave normally (they don't take water damage in the Nether — no water — but rain/water contact rules simply never trigger).

---

## 11. Block texture recipes

06 §4 vocabulary (`noise`, `speckle`, `blotch`, `bark`, `rings`, `planks`, `ore`, `leaf`, `cross_sprite`, `glassy`, `fluid`). All 16×16, seeded `hash(blockId, face)`.

| Block | Recipe |
|---|---|
| netherrack | `speckle(#6e2727, #571d1d, 12)` + faint 1px `#7a3030` veins |
| nether_bricks | `blotch(#2e1416, #241012, 6)` + 1px `#4a2226` mortar grid (2×1 brick offset) |
| nether_brick_fence | nether_bricks palette on the post+rails mesh |
| nether_brick_stairs | nether_bricks palette on the stair mesh |
| soul_sand | `blotch(#463430, #34251f, 8)` + 2 sunken `#241a15` face-hollows (the "souls") |
| soul_soil | `noise(#4a3a33, 8)` + fibrous `#33251f` streaks |
| magma_block | `blotch(#8a2b12, #d45a12, 10)` emissive; 2-frame glow pulse on the crack pixels |
| nether_quartz_ore | `ore(#e8e0d8)` on a netherrack base (`speckle(#6e2727,#571d1d,10)`) — white quartz nuggets |
| nether_gold_ore | `ore(#fcee4b)` on netherrack base — gold flecks, +20% highlight |
| ancient_debris | side `bark`-like `noise(#4a3a34,8)` + a `#c08a5a` inlaid ring motif; top concentric `rings(#5a463c, #c08a5a)` |
| crimson_nylium | top `noise(#7a1030, 10)` + `#a51843` speckle; side = netherrack with a 3-row crimson lip; bottom netherrack |
| warped_nylium | top `noise(#167a6e, 10)` + `#1aa58f` speckle; side netherrack + teal lip; bottom netherrack |
| crimson_stem | side `bark(#6a2033, #4a1626)`; top `rings(#8a2942, #6a2033)` |
| warped_stem | side `bark(#2b6d63, #1e4d46)` + black warts; top `rings(#37867a, #2b6d63)` |
| crimson_planks | `planks(#7a3a4a)` | 
| warped_planks | `planks(#3a6b64)` |
| nether_wart_block | `noise(#7a0a15, 10)` + dense `#a01824` warty bumps |
| warped_wart_block | `noise(#167a6e, 8)` + `#0e8a4a` speckle warts |
| shroomlight | `blotch(#f5a83c, #d47a1a, 8)` emissive; concentric pore rings |
| crimson_fungus | `cross_sprite`: 3px red `#c42d2d` domed cap on a 2px `#7a5b3a` stalk |
| warped_fungus | `cross_sprite`: 3px teal `#3aa58f` cap w/ warts on a 2px `#5a6b3a` stalk |
| crimson_roots | `cross_sprite`: 5 magenta `#8a1030` tendrils |
| warped_roots | `cross_sprite`: 5 teal `#1aa58f` tendrils |
| nether_wart (crop) | `hash`: 3 stages — sparse red sprigs → bushy `#7a0a15` → tall with `#a01824` berries |
| bone_block | side vertical `#e0dccb` ribs on `#c9c4ad`; top `rings(#d8d3bd, #b8b19a)` marrow |
| nether_portal | shader: base `#280b3b`; drifting magenta starfield (`#b061e0`/`#e0a0ff`, 60 motes), 2-frame UV scroll 0.3 px/t; vertical plane |
| spawner | `glassy(#1f2a1f)` cage bars on a `noise(#2a2a30,8)` frame; caged flame emissive |
| netherite_block | `noise(#443f42, 4)` + 1px `#2a2528` border + 4 corner rivets `#6a5f5a` |
| smithing_table | top `noise(#3a3336,8)` with a `#8a8a8a` anvil-face motif; side `planks(#5a4436)` + `#2a2528` metal band; front tool-rack pixels |

---

## 12. Item texture recipes

06 §8.1 pixel-map legend (16×16, palettes canonical; implementer draws the maps).

| Item | Sprite |
|---|---|
| nether_wart (390) | small `#a01824` warty clump, 6×6, `#7a0a15` shading, 2 `#d84a4a` highlight pixels |
| blaze_rod (391) | vertical `#f8b613` rod, 3×12, `#d47a1a` shade, emissive glint tip |
| blaze_powder (392) | scattered `#f8b613`/`#ffd23c` dust grains on transparent, faint glow |
| magma_cream (393) | `#d45a12` orb, 8×8, molten `#f8b613` core, `#8a2b12` outer, emissive core pixel |
| ghast_tear (394) | teal-white teardrop, 7×11, `#9fe8e0` body, `#ffffff` highlight, `#5aa8a0` outline |
| glowstone_dust (395) | pale `#f9d49c` grains, emissive, on transparent |
| gold_nugget (396) | small `#fcee4b` nugget, 6×6, `#d4b82a` shade, 3D bevel |
| nether_quartz (397) | angular `#e8e0d8` crystal shard, 8×10, `#b8b0a8` facets, white glint |
| netherite_scrap (398) | irregular `#5a4a44` chunk with `#c08a5a` inlay flecks, jagged outline |
| netherite_ingot (399) | 06-style ingot parallelogram in `#443f42` with `#6a5f5a` top face + `#8a7f7a` highlight |
| netherite tools (400–404) | 06 tool pixel-maps, head palette `#443f42` (dark) / `#6a5f5a` highlight; handle = normal stick |
| netherite armor (405–408) | 06 armor pixel-maps recolored `#443f42`/`#6a5f5a` |
| nether_brick (409) | `#2e1416` brick block, 10×8, `#4a2226` mortar line, `#241012` shade |

Cube blocks render isometric inventory icons via 06 §8.2's pipeline; cross/hash/custom blocks and all items render flat. Zero downloaded assets (base rule).

---

## 13. Per-dimension rendering & F3

The renderer reads the active dimension's `sky` descriptor and `hasSkyLight`/`ambientLight`.

### 13.1 Nether sky & fog (`NETHER_SKY`, AMENDS 04 §5–§7)

- **No sky dome gradient, no sun, no moon, no stars, no sunrise band, no clouds.** The `skyGroup` (01 §14 / 04 §5) is emptied for dim 1; `renderer.setClearColor` is set to the biome fog color so the void behind terrain reads as thick fog, not black.
- **Dense red fog:** `scene.fog` and the chunk-shader fog uniforms use the **per-biome fog color** at the camera position (§4.2: nether_wastes `#330808`, crimson `#330303`, warped `#1a051a`, soul_sand_valley `#1b4745`), blended smoothly when crossing biome borders (sample the camera column's biome, lerp over ~1 s toward the new color). Fog is **near = 0**, **far ≈ 0.55·R** (much closer than the Overworld's 0.75·R–R) — the Nether is claustrophobic and you can't see far. Underwater/lava fog overrides (04 §7) still apply when the camera is inside lava (`#991900`, near 0.25 far 1.0).
- **No day/night:** `uSkyDarken` is forced to 0 (no time darkening — the Nether's brightness is entirely block-light + the `uDimAmbient` floor of 0.10). `uSkyTint` = white. Weather (rain/thunder/lightning) does not render or tick in dim 1.
- **Ambient floor:** with `hasSkyLight=false`, `skyLight` is 0 everywhere, so terrain brightness = `max(blockBrightness, uDimAmbient=0.10)`. Glowstone (15), lava (15), shroomlight (15), magma (3), portal (11), and any player torches light the caverns above the 0.10 floor; the floor guarantees no cell renders below ~0.10 (dim but navigable), matching the Nether's murky look.
- **Entity lighting** (01 §13.1): `lightScalar = max(brightness(blockLight), uDimAmbient)` — mobs are visible in dim caverns.

### 13.2 Light engine in no-sky dimensions (AMENDS 04 §8/§9)

`LightEngine.initialLight` skips the column sky-light seed (steps 1–2 of 04 §9.1) when `!dim.hasSkyLight`: `skyLight` stays 0, only emitters (`propQ_block`) and border block-light import run. `getSkyLight` above y=127 returns 0 (not 15) in these dimensions. Everything else (block-light BFS, removal, cross-chunk) is identical. This makes the Nether's darkness a pure block-light problem, which is exactly why the ambient floor (§13.1) exists.

### 13.3 F3 / debug overlay additions (AMENDS 01 §15.3)

The F3 overlay gains:
- **Dimension:** the active dim's `key` (`overworld` / `nether` / `end`) + numeric id.
- **Nether coords hint:** when in the Overworld, show the 8:1-scaled Nether target `(⌊x/8⌋, y, ⌊z/8⌋)`; when in the Nether, the ×8 Overworld target — a portal-alignment aid.
- **ambientLight** floor value and **hasSkyLight** flag for the current dimension.
- **Biome:** already shown (01 §15.3) but now resolves Nether biome names for dim 1.
- **Portal timer / cooldown:** when the player overlaps a portal or `portalCooldown > 0`, show `portalTimer/80` and `portalCooldown`.

---

## 14. Sound events

Event **names** only — 16-AUDIO owns synthesis (100% procedural, zero samples/C418). Registered in the shared namespace.

| Event | Trigger |
|---|---|
| `block.portal.ambient` | looped hum while the player is within ~8 blocks of a `nether_portal` |
| `block.portal.trigger` | portal ignited / a mob enters it (rising warble) |
| `block.portal.travel` | dimension-change teleport whoosh (both endpoints) |
| `block.extinguish` | water evaporates in the Nether (§10.1); lava/water hiss (canonical douse key — 16 §3.3) |
| `entity.ghast.warn` | ghast begins charging a fireball |
| `entity.ghast.shoot` | ghast fires |
| `entity.ghast.fireball` | fireball explosion / deflection impact |
| `entity.ghast.scream` | ghast idle (occasional, distance-attenuated) |
| `entity.ghast.hurt` / `entity.ghast.death` | ghast damaged / dies |
| `entity.blaze.ambient` | blaze idle |
| `entity.blaze.burn` | looped crackle while a blaze is alive |
| `entity.blaze.shoot` | blaze fires a burst |
| `entity.blaze.hurt` / `entity.blaze.death` | blaze damaged / dies |
| `entity.zombified_piglin.ambient` | neutral idle grunt |
| `entity.zombified_piglin.angry` | pack-anger triggered (rises with the crowd) |
| `entity.zombified_piglin.hurt` / `.death` | damaged / dies |
| `entity.magma_cube.squish` | magma cube lands a hop / takes damage |
| `entity.magma_cube.jump` | magma cube hops |
| `entity.magma_cube.death` | dies (plays per split) |
| `entity.wither_skeleton.ambient` / `.hurt` / `.death` / `.step` | wither skeleton lifecycle |
| `entity.piglin.ambient` | piglin idle |
| `entity.piglin.angry` | piglin provoked / hostile |
| `entity.piglin.admiring` | examining a bartered gold ingot |
| `entity.piglin.retreat` / `entity.piglin.converted` | fleeing / finishing zombification |
| `entity.piglin.hurt` / `.death` / `.step` | piglin lifecycle |
| `block.spawner.ambient` | active spawner (looped low whoosh + flame) |
| `block.smithing_table.use` | netherite upgrade completes |
| `ambient.nether_wastes.loop` / `ambient.crimson_forest.loop` / `ambient.warped_forest.loop` / `ambient.soul_sand_valley.loop` | per-biome Nether ambience while the camera is in that biome |
| `ambient.nether.mood` | occasional cave-mood sting in the dark (block light 0) |

(Bed explosion reuses 05/13's `entity.generic.explode`; blaze rod / gold nugget item pickups reuse base item-pickup events.)

---

## 15. Acceptance checklist

Browser-testable gates, consistent with CLAUDE.md's E7 (Nether) and E8 (netherite) gates.

**Multi-dimension engine**
- [ ] `registerDimension` holds 0/1/2; `world.activeDim` swaps on portal use; only the active dimension ticks, streams, meshes, and spawns (F3 confirms the inactive dim's entity count is frozen).
- [ ] Save keys are `"<dim>:cx,cz"`; a Nether edit and an Overworld edit at the same `cx,cz` coexist as separate records; reload restores the player into the saved `dimension`.
- [ ] The Nether generates deterministically (byte-identical `blocks` for a chunk generated fresh vs. after neighbors); its RNG streams never touch 02's overworld streams (same seed ⇒ identical Overworld as base).
- [ ] 11-END registers dim 2 into the same registry and its end portal calls `changeDimension`/`regenObsidianPlatform` without any change to this file.

**Portals (E7)**
- [ ] A 4×5 obsidian frame (corners optional) lit with flint & steel fills with `nether_portal` (light 11, purple animated); a 3×2 interior and a 22×22 interior both fail validation; breaking one frame obsidian collapses the portal.
- [ ] Standing in the portal 80 ticks (4 s) teleports; Overworld→Nether lands at `⌊xz/8⌋, y`; Nether→Overworld at `xz*8, y`; round-trip reuses the same portal pair (link cache), and `portalCooldown` 300 prevents an instant bounce.
- [ ] Arriving with no destination portal builds a safe default 4×5 portal on solid ground (never in bedrock roof/floor or mid-lava); purple spawn-in particles fire at both ends.

**Nether gen**
- [ ] Native Y 0–127: bedrock floor Y0 + jagged 1–4, bedrock roof Y127 + jagged 123–126, lava sea surface at Y31; caverns fill ~40–55% of the interior with pillars and lavafalls.
- [ ] All 4 biomes occur within ~1024 blocks: nether_wastes (bare), crimson_forest (crimson nylium + huge fungi + shroomlight), warped_forest (warped, mob-sparse), soul_sand_valley (soul sand/soil + bone fossils).
- [ ] Ores match §4.5: quartz very common (16/chunk), nether gold common (drops 2–6 nuggets), magma blocks at the lava shore, glowstone blobs hang from ceilings (drop 2–4 dust); ancient debris ~1.65/chunk, buried (never on cavern walls), needs a diamond pick, survives TNT.

**Fortress**
- [ ] A fortress generates across chunk borders deterministically (one per 27×27-chunk region, seed-jittered), built of nether bricks over lava with fence-railed bridges, ≥ 1 blaze-spawner room, ≥ 1 nether-wart garden with a loot chest.
- [ ] The blaze spawner activates within 16 blocks, spawns ≤ 4 blazes per cycle on a 200–800-tick delay, caps at 6 nearby; mining it drops nothing + 15–43 XP.
- [ ] Fortress loot chests roll §5.5's table (nether wart always findable; rare netherite scrap possible), identical from every overlapping chunk.

**Nether mobs**
- [ ] Ghast (10 HP, 4×4) drifts, charges, and shoots power-1 fireballs; a melee/arrow hit **deflects** the fireball (redirected, owner reassigned); a deflected direct hit one-shots the ghast; drops 0–1 ghast tear.
- [ ] Blaze (20 HP, fire-immune, flies) fires 3-shot fireball bursts (5 dmg each, ignites), melees for 6 on contact, drops blaze rods (~50%), gives 10 XP.
- [ ] Zombified piglin is neutral, turns hostile when hit and **propagates anger to the pack within 20 blocks** for 20–40 s, melees for 8; is undead (Instant Damage heals it) and never burns.
- [ ] Magma cube spawns sizes 1/2/4 (HP 1/4/16, attack 3/4/6), splits into 2–4 smaller cubes on death (small vanishes), drops magma cream from big/medium, fire-immune, hops.
- [ ] Wither skeleton (2.4 m tall — can't fit a 2-high gap) melees for 8 + Wither I 10 s (hearts blacken, can kill), drops a skull 2.5% of the time (block-item 186).
- [ ] Piglin is hostile to non-gold-armored players; bartering a gold ingot (right-click or drop) yields a §7.8 reward after ~6 s (ender pearls possible); a piglin taken out of the Nether zombifies in ~15 s.

**Brewing chain & netherite (E8)**
- [ ] Nether wart plants on soul sand (no light needed), grows through 4 stages, harvests 2–4; blaze rod → 2 blaze powder; magma cream only from magma cubes; ghast tear only from ghasts; glowstone → 2–4 dust; 9 gold nuggets ↔ 1 gold ingot — all match 09's ingredient ids (390–396).
- [ ] Debris → smelt → netherite scrap (2 XP); 4 scrap + 4 gold → 1 netherite ingot; diamond gear + netherite ingot on the smithing table → netherite gear **keeping enchantments and used durability** (no template, per the Adaptation).
- [ ] Netherite tools: 2031 durability, mining ×9, +1 damage over diamond; netherite armor: 20 pts / 12 toughness / 0.4 knockback resistance / 481–592 durability; netherite items float in lava and survive fire/explosions.

**Hazards & rendering**
- [ ] Placing water in the Nether poofs (nothing placed, hiss); a bed right-clicked in the Nether explodes with power 5 + fire; Nether lava spreads 7 blocks fast (10-tick interval); standing on a magma block chips 1 HP/0.5 s unless sneaking/fire-resistant.
- [ ] The Nether renders with no sun/moon/stars/clouds, dense per-biome red fog, `uSkyDarken` forced 0, and an ambient floor of 0.10 so unlit caverns are dim but not black; F3 shows the dimension, the 8:1 coord hint, ambient floor, and Nether biome name.
