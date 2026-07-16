# 06 — Items, Crafting & Survival Systems

Canonical data file for the whole project: the **block registry** and **item registry** defined here are the single source of truth for names, numeric IDs, hardness, blast resistance, tool/harvest rules, drops, light emission/opacity, render class, texture recipes, stack sizes, durability, food values, fuel values, and XP values. It also specs fluids, crafting, smelting, hunger, XP levels, inventory/UI, item entities, and special block behaviors. Baseline = Minecraft Java Edition ~1.20; exact wiki values unless marked `(approx)`.

Cross-refs: **01** owns chunk storage, save schema, block-update/scheduled-tick/random-tick dispatch. **02** owns terrain/ore/tree generation (sapling growth calls 02's tree placer). **03** owns the mining-time formula (consumes hardness + tool columns), movement (consumes `slipperiness`, `climbable`), fall/drowning/fire damage, reach distance. **04** owns the light engine (consumes emission + opacity columns), day cycle, sleep time-skip, weather, snow/ice formation. **05** owns combat math (consumes base damage + armor points), explosions (consumes blast resistance), mob drop tables, projectile engine (reused by egg/snowball/ender pearl), XP orb entities.

**Scope decisions (final):** INCLUDED — oak door, oak fence, bookshelf, paper/book chain, wheat + carrot + potato farming, throwable ender pearl (teleports), throwable egg/snowball, rotten-flesh food poisoning, jack o'lantern, minimal fire block, raw iron/raw gold (1.17-style ore drops), ice slipperiness, shears. EXCLUDED — redstone circuits (redstone dust is a collectible only), enchanting/anvil/fortune/silk touch (all drop tables are base rates), potions/status-effect framework (food poisoning is a hardcoded timer), offhand slot, shields, cake/milk, fishing, dye crafting (bone meal is fertilizer only; colored wool is debug-palette only), double chests, waterlogging, slabs/stairs, boats/minecarts, hoppers, item frames, signs, fire spread/block burning.

## Contents

1. [Registry conventions & shared enums](#1-registry-conventions--shared-enums)
2. [Block registry — gameplay table](#2-block-registry--gameplay-table)
3. [Block registry — light, render, physics table](#3-block-registry--light-render-physics-table)
4. [Block texture recipes](#4-block-texture-recipes)
5. [Special block behaviors](#5-special-block-behaviors)
6. [Fluids: water & lava](#6-fluids-water--lava)
7. [Item registry](#7-item-registry)
8. [Item texture recipes & icon pipeline](#8-item-texture-recipes--icon-pipeline)
9. [Crafting system](#9-crafting-system)
10. [Full crafting recipe list](#10-full-crafting-recipe-list)
11. [Smelting & fuel](#11-smelting--fuel)
12. [Hunger, saturation, exhaustion, eating](#12-hunger-saturation-exhaustion-eating)
13. [Experience & levels](#13-experience--levels)
14. [Inventory & click semantics](#14-inventory--click-semantics)
15. [HUD & UI](#15-hud--ui)
16. [Item entities (dropped items)](#16-item-entities-dropped-items)
17. [Random ticks & block updates owned by this file](#17-random-ticks--block-updates-owned-by-this-file)
18. [Persistence contract](#18-persistence-contract)
19. [Acceptance checklist](#19-acceptance-checklist)

---

## 1. Registry conventions & shared enums

- **Block IDs** are `uint8`, 0–66 used. **Item IDs** start at 256. Every block except the ones listed below has an auto-generated *block-item* with the same id and name, stack 64, placeable by right-click.
  - No block-item: `air`, `water`, `lava`, `fire`, `furnace_lit` (places as `furnace`), `wheat_crop`/`carrot_crop`/`potato_crop` (planted via seed items), `bed_block` (placed by `bed` item), `oak_door` block (placed by `oak_door` item), `farmland` (created by hoe only; debug palette gives dirt).
  - Debug-palette-only blocks (no survival source): `bedrock`, `glowstone` (02 may place glowstone in caves; if not, debug only), `wool_red/blue/black`.
- **Block state**: every voxel stores `id:uint8` + `state:uint8` (low nibble used; see 01's chunk arrays). State meanings per block are defined in §5/§6 (fluid level, crop stage, facing, open flag, moisture, age, part, persistent-leaf).
- **Tick rate** 20 tps. `s` in tables = seconds, `t` = game ticks.
- **Tool classes**: `pickaxe`, `axe`, `shovel`, `hoe`, `sword`, `shears`, `none`. **Tier ladder** (harvest ordering): `wood(0) < stone(1) < iron(2) < diamond(3)`; gold = tier 0 for harvesting but speed 12.
- **Harvest rule**: any block with hardness ≥ 0 can always be *broken*; it yields drops only if `tool tier required` is `—` (none) or the held tool's class matches and tier ≥ requirement. Wrong/no tool → break at hand speed and (if a tier is required) drop nothing. Mining time formula lives in 03; inputs come from §2.
- **Speed multipliers** (03 consumes): hand 1, wood 2, stone 4, iron 6, diamond 8, gold 12. Multiplier applies only when tool class matches the block's `tool` column. Special: shears ×15 on leaves, ×5 on wool; sword — no block role (no cobwebs in scope).
- **Hardness −1** = unbreakable (bedrock, water, lava). Fire breaks instantly on punch.
- **Drops with no silk touch / fortune**: base rates below are final.
- Random-number notation: `a–b` = uniform integer inclusive.

---

## 2. Block registry — gameplay table

Columns: **Hard** = hardness, **Blast** = blast resistance (05 explosions), **Tool** = effective tool class, **Tier** = minimum tier for drops (`—` = drops with anything incl. hand; `tool!` = correct class itself required for drops, any tier).

| ID | Name | Hard | Blast | Tool | Tier | Drops | XP on mine |
|---:|------|-----:|------:|------|------|-------|-----------|
| 0 | air | — | 0 | — | — | — | — |
| 1 | stone | 1.5 | 6.0 | pickaxe | wood | 1 cobblestone | 0 |
| 2 | grass_block | 0.6 | 0.6 | shovel | — | 1 dirt | 0 |
| 3 | dirt | 0.5 | 0.5 | shovel | — | self | 0 |
| 4 | cobblestone | 2.0 | 6.0 | pickaxe | wood | self | 0 |
| 5 | oak_planks | 2.0 | 3.0 | axe | — | self | 0 |
| 6 | birch_planks | 2.0 | 3.0 | axe | — | self | 0 |
| 7 | spruce_planks | 2.0 | 3.0 | axe | — | self | 0 |
| 8 | oak_log | 2.0 | 2.0 | axe | — | self | 0 |
| 9 | birch_log | 2.0 | 2.0 | axe | — | self | 0 |
| 10 | spruce_log | 2.0 | 2.0 | axe | — | self | 0 |
| 11 | oak_leaves | 0.2 | 0.2 | shears | — | table A below | 0 |
| 12 | birch_leaves | 0.2 | 0.2 | shears | — | table A (no apple) | 0 |
| 13 | spruce_leaves | 0.2 | 0.2 | shears | — | table A (no apple) | 0 |
| 14 | oak_sapling | 0 | 0 | — | — | self | 0 |
| 15 | birch_sapling | 0 | 0 | — | — | self | 0 |
| 16 | spruce_sapling | 0 | 0 | — | — | self | 0 |
| 17 | bedrock | −1 | 3600000 | — | — | — | — |
| 18 | sand | 0.5 | 0.5 | shovel | — | self | 0 |
| 19 | gravel | 0.6 | 0.6 | shovel | — | 90% self, 10% 1 flint | 0 |
| 20 | sandstone | 0.8 | 0.8 | pickaxe | wood | self | 0 |
| 21 | coal_ore | 3.0 | 3.0 | pickaxe | wood | 1 coal | 0–2 |
| 22 | iron_ore | 3.0 | 3.0 | pickaxe | stone | 1 raw_iron | 0 |
| 23 | gold_ore | 3.0 | 3.0 | pickaxe | iron | 1 raw_gold | 0 |
| 24 | diamond_ore | 3.0 | 3.0 | pickaxe | iron | 1 diamond | 3–7 |
| 25 | redstone_ore | 3.0 | 3.0 | pickaxe | iron | 4–5 redstone | 1–5 |
| 26 | lapis_ore | 3.0 | 3.0 | pickaxe | stone | 4–9 lapis_lazuli | 2–5 |
| 27 | coal_block | 5.0 | 6.0 | pickaxe | wood | self | 0 |
| 28 | iron_block | 5.0 | 6.0 | pickaxe | stone | self | 0 |
| 29 | gold_block | 3.0 | 6.0 | pickaxe | iron | self | 0 |
| 30 | diamond_block | 5.0 | 6.0 | pickaxe | iron | self | 0 |
| 31 | glass | 0.3 | 0.3 | — | — | nothing | 0 |
| 32 | glowstone | 0.3 | 0.3 | — | — | self `(approx: MC drops 2–4 dust; no dust item in scope)` | 0 |
| 33 | obsidian | 50 | 1200 | pickaxe | diamond | self | 0 |
| 34 | crafting_table | 2.5 | 2.5 | axe | — | self | 0 |
| 35 | furnace | 3.5 | 3.5 | pickaxe | wood | self + slot contents spill | 0 |
| 36 | furnace_lit | 3.5 | 3.5 | pickaxe | wood | 1 furnace + contents spill | 0 |
| 37 | chest | 2.5 | 2.5 | axe | — | self + 27-slot contents spill | 0 |
| 38 | torch | 0 | 0 | — | — | self | 0 |
| 39 | ladder | 0.4 | 0.4 | axe | — | self | 0 |
| 40 | snow_layer | 0.1 | 0.1 | shovel | shovel! | 1 snowball with shovel, else nothing | 0 |
| 41 | snow_block | 0.2 | 0.2 | shovel | shovel! | 4 snowballs with shovel, else nothing | 0 |
| 42 | ice | 0.5 | 0.5 | pickaxe | — | nothing (see §5.10: may revert to water) | 0 |
| 43 | cactus | 0.4 | 0.4 | — | — | self | 0 |
| 44 | pumpkin | 1.0 | 1.0 | axe | — | self | 0 |
| 45 | jack_o_lantern | 1.0 | 1.0 | axe | — | self | 0 |
| 46 | wool_white | 0.8 | 0.8 | shears | — | self | 0 |
| 47 | wool_red | 0.8 | 0.8 | shears | — | self | 0 |
| 48 | wool_blue | 0.8 | 0.8 | shears | — | self | 0 |
| 49 | wool_black | 0.8 | 0.8 | shears | — | self | 0 |
| 50 | bookshelf | 1.5 | 1.5 | axe | — | 3 books | 0 |
| 51 | tnt | 0 | 0 | — | — | self (breaking does not ignite) | 0 |
| 52 | oak_fence | 2.0 | 3.0 | axe | — | self | 0 |
| 53 | oak_door | 3.0 | 3.0 | axe | — | 1 oak_door item (from either half) | 0 |
| 54 | bed_block | 0.2 | 0.2 | — | — | 1 bed item (from either half) | 0 |
| 55 | farmland | 0.6 | 0.6 | shovel | — | 1 dirt | 0 |
| 56 | wheat_crop | 0 | 0 | — | — | stage 7: 1 wheat + 0–3 wheat_seeds; stages 0–6: 1 wheat_seeds | 0 |
| 57 | carrot_crop | 0 | 0 | — | — | stage 7: 2–5 carrots `(approx)`; else 1 carrot | 0 |
| 58 | potato_crop | 0 | 0 | — | — | stage 7: 2–5 potatoes `(approx)`; else 1 potato | 0 |
| 59 | sugar_cane_block | 0 | 0 | — | — | 1 sugar_cane item | 0 |
| 60 | short_grass | 0 | 0 | shears | — | shears: self; else 12.5% 1 wheat_seeds | 0 |
| 61 | dandelion | 0 | 0 | — | — | self | 0 |
| 62 | poppy | 0 | 0 | — | — | self | 0 |
| 63 | water | −1 | 100 | — | — | — (bucket only) | — |
| 64 | lava | −1 | 100 | — | — | — (bucket only) | — |
| 65 | fire | 0 | 0 | — | — | nothing (punch extinguishes instantly) | 0 |
| 66 | dead_bush | 0 | 0 | shears | — | shears: self; else 0–2 stick | 0 |

**Drop table A (leaves, broken without shears; shears → the leaf block itself):**

| Roll (independent) | Chance | Drop |
|---|---|---|
| Sapling (matching wood) | 5% | 1 sapling |
| Sticks | 2% | 1–2 stick |
| Apple (oak_leaves only) | 0.5% | 1 apple |

Mining XP: spawn XP orbs (05) at block center when the block is mined with a qualifying tool. Ores mined with a too-low tier drop nothing and give 0 XP.

---

## 3. Block registry — light, render, physics table

Columns: **Emit** = light emission 0–15 (feeds 04). **Opac** = light opacity class for 04's engine: `O` opaque (blocks light fully), `T` transparent (opacity 0), `F` filter (partial attenuation — leaves/water/ice; 04 defines the numeric attenuation). **Pass** = render pass: `op` opaque, `co` cutout (binary alpha), `tr` translucent (blended). **Shape** = mesh: `cube`, `cross` (2 crossed quads), `hash` (crops: 4 quads in # layout), or custom geometry named in §5. **Grav** = falling block. **Solid** = has collision (exceptions noted). All blocks stack 64 as items.

| ID | Name | Emit | Opac | Pass | Shape | Grav | Solid |
|---:|------|-----:|:---:|:---:|-------|:---:|-------|
| 0 | air | 0 | T | — | — | — | no |
| 1 | stone | 0 | O | op | cube | — | yes |
| 2 | grass_block | 0 | O | op | cube (3 face texs) | — | yes |
| 3 | dirt | 0 | O | op | cube | — | yes |
| 4 | cobblestone | 0 | O | op | cube | — | yes |
| 5–7 | *_planks | 0 | O | op | cube | — | yes |
| 8–10 | *_log | 0 | O | op | cube (top/side) | — | yes |
| 11–13 | *_leaves | 0 | F | co | cube | — | yes |
| 14–16 | *_sapling | 0 | T | co | cross | — | no |
| 17 | bedrock | 0 | O | op | cube | — | yes |
| 18 | sand | 0 | O | op | cube | yes | yes |
| 19 | gravel | 0 | O | op | cube | yes | yes |
| 20 | sandstone | 0 | O | op | cube (top/side/bot) | — | yes |
| 21–26 | ores | 0 | O | op | cube | — | yes |
| 27–30 | mineral blocks | 0 | O | op | cube | — | yes |
| 31 | glass | 0 | T | co | cube | — | yes |
| 32 | glowstone | 15 | O | op | cube | — | yes |
| 33 | obsidian | 0 | O | op | cube | — | yes |
| 34 | crafting_table | 0 | O | op | cube (top/side) | — | yes |
| 35 | furnace | 0 | O | op | cube (front/side/top) | — | yes |
| 36 | furnace_lit | 13 | O | op | cube (glowing front) | — | yes |
| 37 | chest | 0 | T | op | cube (front/side/top) | — | yes |
| 38 | torch | 14 | T | co | custom: torch | — | no |
| 39 | ladder | 0 | T | co | custom: wall quad | — | no (climbable → 03) |
| 40 | snow_layer | 0 | T | op | custom: 2/16 slab | — | no |
| 41 | snow_block | 0 | O | op | cube | — | yes |
| 42 | ice | 0 | F | tr | cube (α 0.8) | — | yes (`slipperiness 0.98`, default 0.6 → 03) |
| 43 | cactus | 0 | T | co | custom: 14/16 inset box | — | yes (14/16 box) |
| 44 | pumpkin | 0 | O | op | cube (top/side) | — | yes |
| 45 | jack_o_lantern | 15 | O | op | cube (face side) | — | yes |
| 46–49 | wool_* | 0 | O | op | cube | — | yes |
| 50 | bookshelf | 0 | O | op | cube (shelf sides, plank top/bot) | — | yes |
| 51 | tnt | 0 | O | op | cube (top/side/bot) | — | yes |
| 52 | oak_fence | 0 | T | op | custom: post+rails | — | yes (1.5 h collision box → 03) |
| 53 | oak_door | 0 | T | co | custom: 3/16 panel ×2 blocks | — | when closed |
| 54 | bed_block | 0 | T | op | custom: 9/16 box ×2 blocks | — | yes (9/16 h) |
| 55 | farmland | 0 | O | op | custom: 15/16 cube | — | yes |
| 56–58 | crops | 0 | T | co | hash | — | no |
| 59 | sugar_cane_block | 0 | T | co | cross | — | no |
| 60 | short_grass | 0 | T | co | cross | — | no |
| 61–62 | flowers | 0 | T | co | cross | — | no |
| 63 | water | 0 | F | tr | fluid (14/16 top, α 0.7) | — | no (fluid physics → 03) |
| 64 | lava | 15 | O | op (emissive) | fluid (14/16 top) | — | no |
| 65 | fire | 15 | T | co | cross + inner quads, 2-frame flicker | — | no |
| 66 | dead_bush | 0 | T | co | cross | — | no |

> Adaptation: flowing fluids render at a constant 14/16 height regardless of level (no per-level sloped surface). Both fluids animate by swapping between 2 procedurally generated noise frames at 4 Hz and scrolling UV at 0.5 px/tick on flowing cells.

---

## 4. Block texture recipes

All textures are 16×16 canvases generated once at startup with a fixed seed (`hash(blockId, face)`), nearest-neighbor sampling, then packed into one atlas. Pattern vocabulary (implement as small canvas-drawing functions):

| Pattern | Definition |
|---|---|
| `solid(c)` | fill color c |
| `noise(c, a)` | fill c; per-pixel value jitter ±a% brightness |
| `speckle(c, f, d)` | `noise(c,6)` + d% of pixels recolored f |
| `blotch(c1, c2, n)` | `noise(c1,5)` + n irregular 2–5 px blobs of c2 with darker 1px outline |
| `planks(c)` | 4 horizontal boards (4px), 1px seam at −30% brightness, staggered vertical joints, grain jitter ±8% |
| `bark(c1, c2)` | vertical strips alternating c1/c2 width 1–3 px, random 1px notches |
| `rings(c1, c2)` | concentric 1px square rings alternating c1/c2 |
| `ore(mineral)` | stone base `speckle(#7f7f7f,#6f6f6f,8)` + 4–6 blobs (2–3 px) of mineral color with +20% highlight pixel |
| `leaf(c1, c2)` | dense 50/50 noise of c1/c2; 12% of pixels fully transparent |
| `grass_side` | dirt recipe + top 3 rows grass green with jagged 1px boundary |
| `cross_sprite(...)` | hand-authored 16×16 pixel map (see §8 legend format) |
| `crop(stage, c_lo, c_hi)` | 4 vertical stem columns; height = 2+2·stage px (capped 14); color = lerp(c_lo→c_hi, stage/7); stage ≥ 5 adds head pixels |
| `glassy(c)` | transparent fill; 1px border c; 2 diagonal 3px shine strokes white 40% |
| `fluid(c)` | `noise(c,10)`, 2 frames with different seeds |

Per-block recipes (faces `top/side/bottom` where they differ; single entry = all faces):

| Block | Recipe |
|---|---|
| stone | `speckle(#7f7f7f, #6f6f6f, 10)` |
| grass_block | top `noise(#5d9b3e, 12)`; side `grass_side`; bottom = dirt |
| dirt | `blotch(#8a6142, #6b4a33, 8)` |
| cobblestone | `blotch(#7a7a7a, #565656, 9)` + 1px #4a4a4a mortar web |
| oak_planks / birch / spruce | `planks(#b8945f)` / `planks(#d7c185)` / `planks(#82603c)` |
| oak_log | side `bark(#745a36, #58432a)`; top `rings(#b8945f, #9a7a4a)` |
| birch_log | side `bark(#d7d3cb, #2e2e2e)` (black dashes); top `rings(#d7c185, #b8a068)` |
| spruce_log | side `bark(#4a3621, #382818)`; top `rings(#82603c, #6a4e30)` |
| oak/birch/spruce_leaves | `leaf(#4a7a28,#3a611e)` / `leaf(#6a9e47,#54803a)` / `leaf(#2e4e33,#243d29)` |
| saplings | `cross_sprite` tiny tree, foliage = matching leaf c1, trunk #6b4f2a |
| bedrock | `blotch(#565656, #2f2f2f, 12)` |
| sand | `speckle(#dbd3a0, #c9bd8b, 12)` |
| gravel | `blotch(#857b74, #675e57, 10)` + 8% #9c948c flecks |
| sandstone | top `speckle(#dbd3a0,…)`; side `noise(#d8cf9e,6)` + 2 horizontal 1px bands #b5a878; bottom `noise(#cfc593,8)` |
| coal/iron/gold/diamond/redstone/lapis ore | `ore(#2f2f2f)` / `ore(#d8af93)` / `ore(#fcee4b)` / `ore(#4aedd9)` / `ore(#d90000)` / `ore(#2a4bd5)` |
| coal_block | `noise(#1b1b1b, 8)` |
| iron_block | `noise(#d8d8d8, 4)` + 1px #b0b0b0 border |
| gold_block | `noise(#f9ec4e, 5)` + 1px #d4b82a border |
| diamond_block | `noise(#62e9d8, 5)` + 1px #3bbfb0 border |
| glass | `glassy(#c9dbdc)` |
| glowstone | `blotch(#f9d49c, #d2a04a, 10)` |
| obsidian | `blotch(#1b1029, #3b2754, 6)` |
| crafting_table | top `planks(#a76e35)` + 2px #6e4f24 grid border; sides `planks(#b8945f)` + 3×3 px tool motifs (#8a8a8a saw + hammer); bottom oak_planks |
| furnace | front `noise(#6f6f6f,8)` + 6×5 px black mouth (rows 8–13); side/top `noise(#7f7f7f,8)` + 1px #565656 frame |
| furnace_lit | as furnace; mouth filled #ff9a00/#ffd23c 2-frame flicker (emissive) |
| chest | `planks(#a0793c)` + 1px #6e4f24 frame; front adds 2×3 px #8a8a8a latch at center-top |
| torch | `cross_sprite`: 2px-wide #6b4f2a stick rows 6–15, tip rows 3–5 #ffd966 core + #ff9a00 rim (emissive) |
| ladder | transparent; 2 vertical 2px rails #a8834f at x=2,12 + 3 horizontal 2px rungs |
| snow_layer / snow_block | `noise(#f6fbfb, 3)` |
| ice | `noise(#9ecdfb, 5)` + 2 diagonal white cracks, α 0.8 |
| cactus | side `noise(#0f7a1f, 8)` + vertical 1px #0a5c16 ribs every 3px + white 1px spines; top `noise(#159a28,6)` + #0a5c16 border |
| pumpkin | side `noise(#d87f33, 7)` + vertical 2px ribs #b5661f; top #9c581e stem cross |
| jack_o_lantern | pumpkin + face side: triangle eyes + grin in #ffd23c (emissive when lit — always) |
| wool_white/red/blue/black | `noise(c, 6)` with faint 2px weave grid −8%; c = #e9e9e9 / #a12722 / #35399d / #1f1f23 |
| bookshelf | top/bottom oak_planks; sides: oak plank frame 2px + 2 shelf rows of 2×4 px book spines from palette {#7a2b20,#2b4b7a,#3f6b2a,#6b5a2a,#5a2a6b} |
| tnt | side `noise(#d0342c,6)` + middle 4px white band with #1f1f23 "TNT" pixels; top `noise(#d0342c,6)` + 3×3 grid of #8a5a3a circles; bottom plain red |
| oak_fence / oak_door | oak_planks color; door texture: 2 panels + 2×2 px window (upper half), `cross_sprite` style panel |
| bed_block | head-top: #a12722 blanket + #e9e9e9 pillow 4×6 px; foot-top: #a12722 + #7a1b18 stripe; sides oak planks |
| farmland | dirt + top: 1px dark furrows every 4 px (#4a2f1e); wet variant −20% brightness |
| wheat_crop | `crop(stage, #4aa03c, #d5b542)` |
| carrot_crop / potato_crop | `crop(stage, #4aa03c, #3f8f2f)`; stage 7 adds orange #e07b2a / tan #c9a86a root pixels at soil line |
| sugar_cane_block | `cross_sprite`: 3 vertical 2px stalks #7fbf5f with #5a9a3f joints |
| short_grass | `cross_sprite`: 7 blades #5d9b3e heights 6–13 px |
| dandelion / poppy | `cross_sprite`: 1px stem #3a611e + 3×3 head #ffe94d / #d0342c |
| water | `fluid(#3f76e4)`, α 0.7 |
| lava | `fluid(#d45a12)` + 30% blobs #f8b613, emissive |
| fire | 2-frame streaks #ff9a00/#ffd23c/#ffffff, 40% transparent |
| dead_bush | `cross_sprite`: bare gray-brown twigs #946428 |

---

## 5. Special block behaviors

State nibble layouts are given as `bits: meaning`.

### 5.1 Falling blocks (sand, gravel)
- On placement and on any neighbor update: if the block below is `air`, `water`, `lava`, `fire`, or a non-solid block, replace the block with a **falling-block entity** (AABB 0.98³, gravity 0.04, drag ×0.98 per tick — the falling-block/item-entity constant per §16, NOT 03's player 0.08).
- On landing (cell below solid): entity becomes the block again in the cell it occupies. If that cell contains a non-solid block (torch, crop, flower, snow_layer…), that block pops as its item drop first.
- If the entity lands such that its cell is occupied by a solid block (edge case), or it falls onto a non-full-height support it cannot rest on, it drops as an item entity instead.
- Chains: a landing/converting falling block issues neighbor updates, so columns fall sequentially top-down.

### 5.2 Torch
- State `0`=floor, `1–4`=wall N/E/S/W. Placeable on the top face of any solid or glass block, or on their side faces; never on ceilings, other torches, or non-solid blocks.
- Neighbor update: if the supporting block is gone → pop as item.
- Emits light 14 (04 recomputes on place/break).

### 5.3 Chest (block entity)
- 27 slots (9×3). Right-click opens chest UI (§14) unless an *opaque* block sits directly above.
- Single chests only; placing a chest adjacent to another is allowed but they stay independent. Breaking spills all contents as item entities plus the chest itself.
- Contents persist per 01's block-entity records (§18).

### 5.4 Crafting table
- Right-click opens the 3×3 crafting UI. No stored state. Grid contents return to the player inventory on close (overflow drops at player).

### 5.5 Furnace (block entity)
See §11 for full smelting logic. `furnace` ↔ `furnace_lit` block-id swap when burning starts/stops (drives light 13 and the glowing front texture). State nibble bits 0–1: facing (set on place, faces the player).

### 5.6 TNT
- **Ignition sources**: (a) right-click with flint_and_steel (−1 durability); (b) an adjacent `fire` block at the moment fire is placed/updated; (c) caught in any explosion → ignites with random fuse 10–30 t.
- Ignited TNT is removed from the grid and becomes a **primed-TNT entity**: AABB 0.98³, initial `vy = 0.2` hop, fuse 80 t, rendered as the TNT cube pulsing scale 1.0→1.05 and flashing a white overlay every 10 t.
- At fuse 0: explosion **power 4** centered on the entity — block destruction + entity damage per 05's explosion adaptation (uses `Blast` column from §2). Destroyed blocks drop items with 1/power probability per 05.
- Breaking the placed block normally just drops the item (no ignition; no redstone in scope).

### 5.7 Bed
- Item places two `bed_block` cells: foot at the clicked cell, head one cell in the player's facing direction. Requires both cells replaceable (air/short_grass/flowers) and solid support below both. State bits: 0–1 facing, 2 part (0 foot/1 head).
- Right-click either half: **always** sets the player's spawn point (03), then attempts sleep — allowed only at night/thunder per 04's sleep rules and with no hostile mob within 8 blocks horizontally / 5 vertically (05). Failure shows the standard chat message ("You can only sleep at night" per 04 §14.1, "You may not rest now; there are monsters nearby").
- Sleeping skips to dawn per 04. Breaking either half removes both and drops 1 bed item.

### 5.8 Cactus
- Placement: only on sand or cactus, and only if all 4 horizontal neighbors are non-solid. Neighbor update violating this → block breaks into its item.
- Contact: any entity whose AABB touches the cactus box takes 1 damage per 10 t of contact `(approx: MC ticks contact damage continuously)`. Item entities touching it are destroyed.
- Growth: state nibble = age 0–15. Random tick: age+1; at 15, if column height < 3 and above is air → place cactus above, reset age.

### 5.9 Sugar cane
- Placement: on grass/dirt/sand only, and only if at least one horizontal neighbor **of the supporting block** is water. Neighbor update: unsupported or water removed → break (whole column above breaks too, each drops its item).
- Growth: identical age-nibble scheme to cactus, max height 3.

### 5.10 Ice & snow
- Ice: when broken (any tool), becomes `water` source if the block below is solid/opaque, else `air`. Drops nothing. Random tick: if block-light ≥ 12 → melt to water (same support rule). Slipperiness 0.98 (03 movement).
- Snow_layer: single layer only, 2/16 high, no collision, placeable on solid top faces; pops if support removed. Random tick: block-light ≥ 12 → remove. Formation during snowfall is 04's job.
> Adaptation: no 2–8 layer stacking; a snow_layer cell is binary.

### 5.11 Farmland, hoe & crops (wheat, carrot, potato)
- **Tilling**: right-click hoe on grass_block/dirt with air above → farmland, hoe −1 durability.
- **Moisture**: state bit 3 = wet. Recomputed on random tick and on nearby water changes: wet if any water within Chebyshev distance 4 at the same Y or Y+1. Dry farmland with no crop above reverts to dirt on random tick.
- **Planting**: right-click wheat_seeds/carrot/potato on farmland → crop block stage 0 (state bits 0–2 = stage 0–7).
- **Growth** (random tick): requires light level ≥ 9 at the crop cell; then stage+1 with probability **1/5 if farmland is wet, 1/9 if dry**.
- **Uprooting**: if `max(skyLight, blockLight) <= 7` at the crop block on random tick → break the crop, dropping its current-stage drops (04 §10.3).
> Adaptation: replaces MC's 1/(⌊25/points⌋+1) neighbor-scoring formula; these constants approximate a typical hydrated farm.
- **Trampling**: an entity landing on farmland (or on the crop above it) with fall distance > 0.5 m reverts farmland to dirt; the crop pops with its current-stage drops.
- Breaking farmland or removing support under a crop pops the crop. Crops are destroyed by water flow (drop loot).
- **Bone meal**: advances a crop +2–5 stages `(approx)`, clamped at 7; consumes 1.
- Visuals: `crop(stage,…)` texture; render stages 0–7 (carrot/potato may map 8 logical stages onto 4 distinct textures).

### 5.12 Saplings & leaves
- Sapling random tick: if light ≥ 9 → 10% `(approx)` chance to attempt tree growth: call 02's tree placer for that species; if space check fails, nothing happens (sapling stays). Bone meal: 45% chance per use to attempt growth.
- Leaf decay: leaves carry a `persistent` state bit (bit0) set when player-placed. Non-persistent leaves, on random tick: BFS through leaf blocks up to distance 4 looking for any log; if none found → break with drop table A.
> Adaptation: decay via random-tick BFS instead of MC's cached distance field; whole trees dissolve over ~1–2 minutes after trunk removal.

### 5.13 Doors & fences
- Door item places lower+upper `oak_door` blocks (needs 2 air + solid below). State: bit0 upper, bit1 open, bits2–3 facing. Right-click toggles open on both halves (collision panel rotates 90°). Neighbor update: support gone → pop item (both halves). Mobs do not break doors on Normal.
- Fence: full block for placement; collision box 1.5 blocks tall (03). Mesh connects rails to adjacent fences and solid blocks (visual only).

### 5.14 Fire (minimal)
- Placed only by flint_and_steel (on top of any solid block) or TNT chain events. Damages entities per 03's fire rules; ignites adjacent TNT immediately.
- Burns out: scheduled tick 100–200 t after placement → becomes air. Punching extinguishes instantly.
> Adaptation: fire never spreads and never consumes blocks.

### 5.15 Grass & dirt ecology
- grass_block random tick: if internalLight < 4 at the block above AND the covering block has opacity > 0 (04 §10.3) → become dirt. Else, pick 1 random cell in the 3×3×3 neighborhood ±1Y `(approx: MC scans 3×5×3)`: if it is dirt with a transparent block above and internalLight ≥ 9 at the block above (04 §10.3) → convert to grass_block.
- Bone meal on grass_block: 8 attempts at random cells in the 7×7 area (same Y+1): on grass blocks with air above, place short_grass (90%) or a random flower (10%) `(approx)`.

---

## 6. Fluids: water & lava

### 6.1 Model
Cellular automaton over the block grid using scheduled ticks (01's scheduler). Constants:

| | water | lava |
|---|---|---|
| Update interval | 5 t | 30 t |
| Level drop per horizontal step | 1 | 2 |
| Max flat spread from source | 7 cells | 3 cells |
| Infinite-source rule | yes | no |
| Bucket pickup/place | yes | yes |
| Entity effects | swim physics, drowning (03) | fire damage + burning (03), destroys item entities |

State nibble: bit3 `falling`, bits0–2 `spread` 0–7. **Source** = spread 0, not falling. Effective strength `S = 8 − spread` (source S=8). `canReplace(cell)` = air, fire, or a fluid-destructible block (torch, saplings, flowers, short_grass, crops, sugar_cane, snow_layer — these pop with drops when flooded). Fluids never enter cells holding any other block (doors, ladders, chests, fences are dams; no waterlogging).

### 6.2 Update algorithm (per scheduled fluid tick at `pos`)

```
S(cell) = 0 if not same fluid; 8 if source; 8 if falling; else 8 - spread

update(pos):
  cur = S(pos)
  if not source(pos):                       # re-derive my level
    fromAbove = sameFluid(pos.up)
    best = fromAbove ? 8 (falling) : max(S(n) for n in 4 horiz neighbors) - drop
    if best <= 0: set(pos, air); wakeNeighbors(); return
    if best != cur: set(pos, best); wakeNeighbors()
    # water only: become source if >= 2 of 4 horiz neighbors are sources
    # and (below is solid or a water source)
    if fluid==water and adjacentSources(pos) >= 2 and solidOrSource(pos.down):
        set(pos, source)
  # spread
  if canReplace(pos.down):
      setFluid(pos.down, falling, spread=cur? keep 7? -> falling full); schedule(pos.down)
  elif solid(pos.down) or sameFluid(pos.down):
      out = S(pos) - drop
      if out > 0:
        for n in 4 horiz neighbors:
          if canReplace(n) and S(n) < out: setFluid(n, spread = 8 - out); schedule(n)
```

- Any `set`/`setFluid` pops fluid-destructible blocks (drop loot), schedules the cell and its 6 neighbors for the fluid's interval, and triggers a lava/water interaction check (§6.3).
- A block placed into or removed next to fluid wakes adjacent fluid cells (neighbor-update hook). Removing a source drains its downstream network over successive ticks via the re-derive step.
> Adaptation: no MC "nearest hole" pathfinding — spread is radial (all eligible neighbors), so water on a ledge fans out instead of beelining to the drop. Downward flow still fully suppresses nothing: cells that can flow down do not also spread sideways (the `elif`), matching MC's look.

### 6.3 Water × lava interactions
Checked whenever either fluid is set adjacent to the other:

| Situation | Result (in the lava/water cell) |
|---|---|
| Lava **source** touched by water (side or top) | → obsidian |
| Lava **flowing** touched by water | → cobblestone |
| Water cell with lava directly above flowing onto it | → stone |

Conversion plays a hiss (extinguish) sound event and emits smoke particles (01's Particles helper, render/Particles.js; optional).

### 6.4 Buckets
- Empty bucket right-click on a **source** cell (raycast hits fluid, reach per 03) → remove source, bucket becomes water_bucket/lava_bucket.
- Filled bucket right-click → place a source in the targeted adjacent cell if replaceable; bucket empties. Placing water in a cell adjacent to lava resolves §6.3 immediately.
- Flowing (non-source) cells cannot be picked up.

---

## 7. Item registry

Stack sizes: 64 unless listed. `Dmg` = base attack damage (05 owns the full combat math: attack speed, cooldown, crits). `Dur` = durability.

### 7.1 Tools & weapons

| ID | Name | Dur | Speed× | Dmg | Notes |
|---:|------|----:|------:|----:|------|
| 256 | wooden_sword | 59 | — | 4 | stack 1 (all tools) |
| 257 | wooden_pickaxe | 59 | 2 | 2 | |
| 258 | wooden_axe | 59 | 2 | 7 | |
| 259 | wooden_shovel | 59 | 2 | 2.5 | |
| 260 | wooden_hoe | 59 | 2 | 1 | tills farmland |
| 261 | stone_sword | 131 | — | 5 | crafted from cobblestone |
| 262 | stone_pickaxe | 131 | 4 | 3 | |
| 263 | stone_axe | 131 | 4 | 9 | |
| 264 | stone_shovel | 131 | 4 | 3.5 | |
| 265 | stone_hoe | 131 | 4 | 1 | |
| 266 | iron_sword | 250 | — | 6 | |
| 267 | iron_pickaxe | 250 | 6 | 4 | |
| 268 | iron_axe | 250 | 6 | 9 | |
| 269 | iron_shovel | 250 | 6 | 4.5 | |
| 270 | iron_hoe | 250 | 6 | 1 | |
| 271 | golden_sword | 32 | — | 4 | gold harvests as tier 0 |
| 272 | golden_pickaxe | 32 | 12 | 2 | |
| 273 | golden_axe | 32 | 12 | 7 | |
| 274 | golden_shovel | 32 | 12 | 2.5 | |
| 275 | golden_hoe | 32 | 12 | 1 | |
| 276 | diamond_sword | 1561 | — | 7 | |
| 277 | diamond_pickaxe | 1561 | 8 | 5 | |
| 278 | diamond_axe | 1561 | 8 | 9 | |
| 279 | diamond_shovel | 1561 | 8 | 5.5 | |
| 280 | diamond_hoe | 1561 | 8 | 1 | |
| 281 | bow | 384 | — | — | draw/shoot per 05; consumes 1 arrow |
| 282 | arrow | — | — | — | stack 64; ammo + skeleton drop |
| 283 | shears | 238 | 15 leaves / 5 wool | 1 | harvests leaf blocks & short_grass as items; shears sheep (05) |
| 284 | flint_and_steel | 64 | — | 1 | places fire / ignites TNT; stack 1 |
| 285 | bucket | — | — | — | stack 16 |
| 286 | water_bucket | — | — | — | stack 1 |
| 287 | lava_bucket | — | — | — | stack 1; also 20000 t fuel |

**Durability spend**: breaking a block with hardness > 0: tool −1, sword −2. Hitting an entity: sword −1, other tools −2. Bow −1 per shot; shears −1 per block/sheep; flint_and_steel −1 per use; hoe −1 per till. At 0 the item breaks (poof particle + break sound). Zero-hardness blocks cost no durability.

### 7.2 Armor

Armor points feed 05's damage reduction. Per-piece durability loss when the wearer takes armor-reducible damage: each worn piece loses `max(1, floor(damage/4))`.

| Material | Helmet (Dur/Pts) | Chestplate | Leggings | Boots | Set total pts |
|---|---|---|---|---|---:|
| leather (ID 288–291) | 55 / 1 | 80 / 3 | 75 / 2 | 65 / 1 | 7 |
| golden (292–295) | 77 / 2 | 112 / 5 | 105 / 3 | 91 / 1 | 11 |
| iron (296–299) | 165 / 2 | 240 / 6 | 225 / 5 | 195 / 2 | 15 |
| diamond (300–303) | 363 / 3 | 528 / 8 | 495 / 6 | 429 / 3 | 20 |

All armor stacks 1. Right-click with armor in hand auto-equips to its slot if empty.

### 7.3 Food

Eating: §12.4. `Effect` = food poisoning chance (30 s Hunger I timer).

| ID | Name | Hunger | Saturation | Effect / notes |
|---:|------|---:|---:|---|
| 304 | apple | 4 | 2.4 | from oak leaves 0.5% |
| 305 | bread | 5 | 6.0 | |
| 306 | porkchop | 3 | 1.8 | pig drop (05) |
| 307 | cooked_porkchop | 8 | 12.8 | |
| 308 | beef | 3 | 1.8 | cow drop (05) |
| 309 | cooked_beef | 8 | 12.8 | display name "Steak" |
| 310 | chicken | 2 | 1.2 | 30% food poisoning |
| 311 | cooked_chicken | 6 | 7.2 | |
| 312 | mutton | 2 | 1.2 | sheep drop (05) |
| 313 | cooked_mutton | 6 | 9.6 | |
| 314 | rotten_flesh | 4 | 0.8 | 80% food poisoning; zombie drop (05) |
| 315 | carrot | 3 | 3.6 | plantable |
| 316 | potato | 1 | 0.6 | plantable |
| 317 | baked_potato | 5 | 6.0 | |

Carrot/potato survival source: crops once obtained; bootstrap = zombie rare drop — **this file adds to 05's zombie table: 2.5% chance to drop 1 carrot or 1 potato (50/50) on player kill** (additive to 05's listed drops).

### 7.4 Materials & misc

| ID | Name | Stack | Notes |
|---:|------|---:|---|
| 318 | stick | 64 | |
| 319 | coal | 64 | |
| 320 | charcoal | 64 | torch/fuel-equivalent to coal; NOT valid for coal_block |
| 321 | raw_iron | 64 | iron_ore drop; smelt → iron_ingot |
| 322 | iron_ingot | 64 | |
| 323 | raw_gold | 64 | gold_ore drop; smelt → gold_ingot |
| 324 | gold_ingot | 64 | |
| 325 | diamond | 64 | |
| 326 | flint | 64 | gravel 10% |
| 327 | string | 64 | spider drop (05) |
| 328 | feather | 64 | chicken drop (05) |
| 329 | gunpowder | 64 | creeper drop (05) |
| 330 | leather | 64 | cow drop (05) |
| 331 | bone | 64 | skeleton drop (05) |
| 332 | bone_meal | 64 | fertilizer (§5.11/5.12/5.15) |
| 333 | egg | 16 | laid by chickens every 6000–12000 t (05); throwable: reuses 05's projectile engine, 0 damage, 1/8 chance to spawn a chicken at impact |
| 334 | ender_pearl | 16 | enderman drop (05); throwable: on impact teleport thrower to hit point, deal 5 damage to thrower, 20 t use cooldown |
| 335 | snowball | 16 | throwable, 0 damage + knockback (05) |
| 336 | wheat | 64 | |
| 337 | wheat_seeds | 64 | from short_grass 12.5% and wheat crops |
| 338 | sugar_cane | 64 | places sugar_cane_block |
| 339 | sugar | 64 | crafted from cane; reserved — no consumer in scope (cake/potions cut) |
| 340 | paper | 64 | |
| 341 | book | 64 | |
| 342 | redstone | 64 | collectible only (no circuits) |
| 343 | lapis_lazuli | 64 | collectible only (no enchanting/dyes) |
| 344 | bed | 1 | places bed_block pair |
| 345 | oak_door | 64 | places door pair |

---

## 8. Item texture recipes & icon pipeline

### 8.1 Sprite generation
Item sprites are 16×16 canvases from hand-authored **pixel maps**: strings of 16 rows × 16 chars, `.` = transparent, letters = palette slots. Canonical example (legend format the implementer must follow for all sprites):

```
iron_pickaxe  palette: H=#d8d8d8 head, h=#a8a8a8 head shade, S=#6b4f2a stick, s=#4a3620 stick shade
................
.....HHHHHH.....
....HhhhhhHH....
...Hh....hhHH...
..Hh......hHH...
..H........hH...
.........Ss.....
........Ss......
.......Ss.......
......Ss........
.....Ss.........
....Ss..........
...Ss...........
..Ss............
.Ss.............
................
```

- One pixel map per tool shape (sword, pickaxe, axe, shovel, hoe, shears, flint_and_steel, bow, arrow, bucket) and per armor shape (helmet, chestplate, leggings, boots); material tiers recolor via palette substitution — tier head colors: wood #8b6f47, stone #9a9a9a, iron #d8d8d8, gold #fdf55f, diamond #4aedd9; leather armor #a0522d.
- Bucket variants overlay a fluid surface: #3f76e4 (water) / #d45a12 (lava) in the mouth pixels.
- Food/material sprites: simple silhouettes (apple = red disc + stem; bread = tan loaf; meats = pink/brown chop shapes, cooked = browner palette; bone = white bar + knobs; ingots = 3D parallelogram in metal color; diamond = cyan gem; string/feather/gunpowder/etc. = 8–40 px silhouettes). Exact maps are implementer-drawn in the legend format above; palettes here are canonical.

### 8.2 Inventory icon pipeline
- **Cube-shaped blocks**: at startup, render each once to a 48×48 offscreen WebGL target with an orthographic camera, block rotated yaw 45°, pitch 30°; face lighting top 1.0 / left 0.8 / right 0.6 `(approx MC shading)`. Blit into an icon atlas canvas.
- **Cross/hash/custom blocks and all items**: use the flat 16×16 texture, nearest-neighbor upscaled into the same atlas.
- UI draws icons from this atlas only (no per-frame 3D). Rebuild is never needed (textures are static).

---

## 9. Crafting system

- **Grids**: player inventory has a 2×2 grid + 1 result slot; crafting table has 3×3 + result. A recipe whose pattern bounding box fits 2×2 works in both.
- **Shaped matching**: recipe = pattern rows (chars) + key (char → item id). To match: take the grid's minimal bounding box of non-empty slots, compare cell-by-cell against the pattern, and also against the pattern **mirrored horizontally** (needed for axe/hoe/bow). Position within the grid is irrelevant; orientation is not.
- **Shapeless matching**: multiset equality of grid contents vs ingredient list.
- **Result slot** is virtual: recomputed on any grid change; shows output preview. Taking the output consumes exactly 1 of each pattern cell / ingredient. No container-item returns needed (no recipes use buckets).
- **Shift-click on result**: crafts repeatedly until ingredients run out or inventory is full; crafted stacks route to inventory (hotbar first).
- "Any planks" (`P`) and "any log" recipes accept all three wood variants, mixed freely; planks recipes output the variant of the input log.
- No recipe book UI (stretch goal); the F4 debug palette (§15.4) lists all items.

---

## 10. Full crafting recipe list

Notation: pattern rows separated by `/`; `.` = empty. Key letters per row group. **2×2** = fits the inventory grid.

### 10.1 Blocks & utility

| Output ×qty | Type | Pattern / ingredients | Key | 2×2 |
|---|---|---|---|:--:|
| oak/birch/spruce_planks ×4 | shapeless | 1 matching log | — | ✔ |
| stick ×4 | shaped | `P/P` | P planks | ✔ |
| crafting_table ×1 | shaped | `PP/PP` | P planks | ✔ |
| furnace ×1 | shaped | `CCC/C.C/CCC` | C cobblestone | |
| chest ×1 | shaped | `PPP/P.P/PPP` | P planks | |
| torch ×4 | shaped | `C/S` | C coal **or** charcoal, S stick | ✔ |
| ladder ×3 | shaped | `S.S/SSS/S.S` | S stick | |
| oak_door ×3 | shaped | `PP/PP/PP` | P planks | |
| oak_fence ×3 | shaped | `PSP/PSP` | P planks, S stick | |
| bed ×1 | shaped | `WWW/PPP` | W any wool, P planks | |
| tnt ×1 | shaped | `GSG/SGS/GSG` | G gunpowder, S sand | |
| bookshelf ×1 | shaped | `PPP/BBB/PPP` | P planks, B book | |
| jack_o_lantern ×1 | shaped | `P/T` | P pumpkin, T torch | ✔ |
| sandstone ×1 | shaped | `SS/SS` | S sand | ✔ |
| snow_block ×1 | shaped | `SS/SS` | S snowball | ✔ |
| snow_layer ×6 | shaped | `SSS` | S snow_block | |
| wool_white ×1 | shaped | `SS/SS` | S string | ✔ |
| coal_block ×1 | shaped | `CCC/CCC/CCC` | C coal (not charcoal) | |
| iron_block ×1 | shaped | 3×3 iron_ingot | | |
| gold_block ×1 | shaped | 3×3 gold_ingot | | |
| diamond_block ×1 | shaped | 3×3 diamond | | |
| coal ×9 | shapeless | 1 coal_block | — | ✔ |
| iron_ingot ×9 | shapeless | 1 iron_block | — | ✔ |
| gold_ingot ×9 | shapeless | 1 gold_block | — | ✔ |
| diamond ×9 | shapeless | 1 diamond_block | — | ✔ |

### 10.2 Tools & weapons — material `M` ∈ {planks(wood), cobblestone(stone), iron_ingot(iron), gold_ingot(golden), diamond(diamond)}, `S` = stick

| Output | Pattern | Mirror |
|---|---|:--:|
| M_pickaxe | `MMM/.S./.S.` | — |
| M_axe | `MM./MS./.S.` | ✔ |
| M_shovel | `M/S/S` | — |
| M_sword | `M/M/S` | — |
| M_hoe | `MM./.S./.S.` | ✔ |

(25 recipes total. Stone tier consumes **cobblestone**, not stone.)

| Output | Type | Pattern | Key | 2×2 |
|---|---|---|---|:--:|
| bow | shaped, mirror | `.ST/S.T/.ST` | S stick, T string | |
| arrow ×4 | shaped | `F/S/E` | F flint, S stick, E feather | |
| shears | shaped, mirror | `.I/I.` | I iron_ingot | ✔ |
| flint_and_steel | shapeless | iron_ingot + flint | — | ✔ |
| bucket | shaped | `I.I/.I.` | I iron_ingot | |

### 10.3 Armor — material `A` ∈ {leather, gold_ingot, iron_ingot, diamond}

| Output | Pattern |
|---|---|
| A_helmet | `AAA/A.A` |
| A_chestplate | `A.A/AAA/AAA` |
| A_leggings | `AAA/A.A/A.A` |
| A_boots | `A.A/A.A` |

(16 recipes.)

### 10.4 Food & materials

| Output ×qty | Type | Pattern / ingredients | 2×2 |
|---|---|---|:--:|
| bread ×1 | shaped `WWW` | W wheat | |
| bone_meal ×3 | shapeless | 1 bone | ✔ |
| sugar ×1 | shapeless | 1 sugar_cane | ✔ |
| paper ×3 | shaped `CCC` | C sugar_cane | |
| book ×1 | shapeless | 3 paper + 1 leather | |

**Deliberately no recipes for**: golden apple, cake, cookies, shields, item frames, signs, slabs/stairs, dyes, colored wool (debug only), glass items. Glass comes only from smelting.

---

## 11. Smelting & fuel

### 11.1 Furnace block entity
- **3 slots**: input (top-left), fuel (bottom-left), output (right, take-only).
- **Smelt time: 200 t (10 s) per item**, all recipes.
- Fields: `burn` (t of fuel left), `fuelTotal` (t of the last fuel item, for the flame gauge), `cook` (0–200), `xpBank` (float).

```
each tick:
  if burn > 0: burn -= 1
  R = recipe(input); canSmelt = R && (output empty || (output.id == R.out && output.count + R.qty <= 64))
  if burn == 0 && canSmelt && fuel slot non-empty:
      burn = fuelTotal = fuelValue(fuel); fuel.count -= 1        # lava_bucket → leaves empty bucket in slot
      swap block to furnace_lit
  if burn > 0 && canSmelt:
      cook += 1
      if cook >= 200: cook = 0; output += R.out; input -= 1; xpBank += R.xp
  else:
      cook = max(0, cook - 2)                                    # rewinds when stalled
  if burn == 0 && block is furnace_lit: swap block to furnace
```

- UI: flame icon filled `burn/fuelTotal`; arrow filled `cook/200`.
- **XP**: when the player takes items from the output slot, award `floor(xpBank)` XP directly to the player and keep the fractional remainder.
> Adaptation: direct XP award (no orbs) and a float bank instead of MC's per-recipe used-count map — payout is identical in expectation.
- Shift-click routing: smeltable items → input; fuels → fuel; anything else → rejected.
- Breaking the furnace spills all 3 slots + banked XP as orbs (05) + the furnace block.

### 11.2 Smelting recipes

| Input | Output | XP |
|---|---|---:|
| raw_iron | iron_ingot | 0.7 |
| raw_gold | gold_ingot | 1.0 |
| sand | glass | 0.1 |
| cobblestone | stone | 0.1 |
| any log | charcoal | 0.15 |
| porkchop | cooked_porkchop | 0.35 |
| beef | cooked_beef | 0.35 |
| chicken | cooked_chicken | 0.35 |
| mutton | cooked_mutton | 0.35 |
| potato | baked_potato | 0.35 |

(Cactus → green dye cut with the dye system.)

### 11.3 Fuel values (ticks; 200 t = 1 item)

| Fuel | Ticks | Items |
|---|---:|---:|
| lava_bucket (leaves bucket) | 20000 | 100 |
| coal_block | 16000 | 80 |
| coal / charcoal | 1600 | 8 |
| any log / planks | 300 | 1.5 |
| crafting_table, chest, bookshelf, ladder, fence, bow | 300 | 1.5 |
| wooden tools & sword | 200 | 1 |
| stick, sapling, wool | 100 | 0.5 |

Everything else is not fuel.

---

## 12. Hunger, saturation, exhaustion, eating

Player fields (persisted): `foodLevel` int 0–20 (start/respawn 20), `saturation` float 0–foodLevel (start/respawn 5.0), `exhaustion` float ≥ 0 (start 0), `foodTickTimer` int, `foodPoisonTicks` int (0 = none).

### 12.1 Exhaustion sources (exact 1.20 values)

| Action | Exhaustion |
|---|---|
| Swimming (moving in water) | 0.01 / m |
| Breaking a block | 0.005 / block |
| Sprinting | 0.1 / m |
| Jumping | 0.05 / jump |
| Sprint-jumping | 0.2 / jump |
| Attacking an entity (hit lands) | 0.1 / attack |
| Taking damage (of armor-reducible type) | 0.1 / instance |
| Food poisoning (Hunger I) | 0.005 / t (= 0.1/s) while `foodPoisonTicks > 0` |
| Natural regeneration | 6.0 / 1 HP healed |
| Walking, sneaking, riding | 0 |

03 reports movement distances and jump/sprint flags; 05 reports attack/damage events.

### 12.2 Drain

```
while exhaustion >= 4.0:
    exhaustion -= 4.0
    if saturation > 0: saturation = max(0, saturation - 1.0)
    elif foodLevel > 0: foodLevel -= 1
```

### 12.3 Regeneration & starvation (per tick; Normal difficulty)

```
foodTickTimer += 1
if foodLevel >= 20 and saturation > 0:              # fast saturated regen (1.11+)
    if foodTickTimer >= 10:
        heal = min(1.0, saturation / 6.0)           # HP
        health = min(20, health + heal); exhaustion += 6.0 * heal
        foodTickTimer = 0
elif foodLevel >= 18:                                # slow regen
    if foodTickTimer >= 80:
        health = min(20, health + 1); exhaustion += 6.0; foodTickTimer = 0
elif foodLevel <= 0:                                 # starvation
    if foodTickTimer >= 80:
        if health > 1: damage(1, type=starve)        # Normal floor = 1 HP (Easy: 10, Hard: no floor)
        foodTickTimer = 0
else: foodTickTimer = 0
```

Regen requires `health < 20` to actually consume exhaustion (skip heal+cost when full). Starvation ignores armor. Sprinting is blocked while `foodLevel <= 6` (03 checks this flag).

### 12.4 Eating
- Hold right-click with edible item: 32 t (1.6 s) use animation (item bobs toward face, munch particles optional). Releasing early cancels. Cannot start eating at foodLevel 20.
- On completion: `count −1`; `foodLevel = min(20, foodLevel + hunger)`; `saturation = min(foodLevel, saturation + sat)`; roll food-poisoning chance → `foodPoisonTicks = 600` (30 s, timer refreshes, does not stack).
- Food poisoning: hunger bar renders green while active; adds exhaustion per §12.1.
> Adaptation: food poisoning is a single hardcoded timer, not a general status-effect system.

---

## 13. Experience & levels

- **Points sources**: ore mining (§2 XP column), smelting (§11.2), mob kills & orb entities (05). Orb pickup adds points directly.
- **Level curve** (XP to go from level L to L+1):

```
xpToNext(L) = 2L + 7          (0 <= L <= 15)
            = 5L - 38         (16 <= L <= 30)
            = 9L - 158        (L >= 31)
```

- XP bar fill = `pointsIntoLevel / xpToNext(level)`; level number rendered above the bar (green).
- **Death**: drop XP orbs worth `min(7 × level, 100)` at the death point; all remaining XP is lost; respawn at level 0. Inventory + armor also drop as item entities at death (03 triggers, this file defines the drop).
- **No sinks**: enchanting/anvils are out of scope (stretch goal) — XP is a progression score. State this in the pause/death screens ("Score: <total XP>").

---

## 14. Inventory & click semantics

### 14.1 Layout
- **Player**: hotbar slots 0–8, main 9–35 (3×9), armor 36–39 (helmet/chest/legs/boots), 2×2 craft grid 40–43 + result 44. **No offhand slot.**
- **Containers**: crafting table (3×3 = 9 + result), chest (27), furnace (3). Container screens also show the player's 27+9 slots.
- Armor slots accept only their piece type. Furnace output and craft results are take-only.
- Closing any screen: craft-grid items return to inventory (overflow drops); cursor stack returns likewise.

### 14.2 Click semantics

| Input | Context | Behavior |
|---|---|---|
| Left click | cursor empty | pick up whole stack |
| Left click | cursor holds same item | merge into slot up to 64; remainder stays on cursor |
| Left click | cursor holds different item | swap cursor ↔ slot |
| Right click | cursor empty | pick up `ceil(count/2)` |
| Right click | cursor holds item | place exactly 1 into empty/same-type slot (respect max stack) |
| Left/Right on result slot | — | craft once; result merges onto cursor if same type/fits |
| Shift + left click | any slot | move whole stack to the "other" region (see routing) |
| Double left click | cursor holds item | collect all matching stacks in the screen onto cursor up to 64 |
| 1–9 keys | hovering a slot | swap hovered slot ↔ hotbar slot n−1 |
| Q | hovering a slot | drop 1 from that slot (Shift+Q: whole stack) as thrown item |
| Q (no UI open) | in world | drop 1 from selected hotbar slot (Shift+Q: stack) |
| Click outside panel | cursor holds item | left: drop whole cursor stack; right: drop 1 |
| Esc / E | any screen | close (return rules above) |

> Adaptation: drag-painting (hold-drag to distribute a stack) is skipped; right-click-place-one covers the use case.

**Shift-click routing**: player screen — hotbar ↔ main; armor items go to their armor slot first (from either region); from armor slot → main. Chest screen — player ↔ chest. Furnace — from player: smeltables → input, fuels → fuel, else no-op; from furnace slots → player. Craft result — craft max, route to player inventory (hotbar first).

**Pick block (debug mode only, middle click)**: sets/gives a stack of the targeted block into the hotbar.

### 14.3 Hotbar
Mouse wheel and 1–9 select the active slot (selection frame). Selected item name flashes above the hotbar for 2 s on change. Held item renders in first person (03 view model, simple quad/cube).

---

## 15. HUD & UI

### 15.1 Survival HUD (bottom-center cluster, MC layout)
| Element | Spec |
|---|---|
| Hearts ×10 | above hotbar-left; 1 heart = 2 HP; half-heart support; damage → all hearts blink white 3× over 10 t; at health ≤ 4 hearts jitter ±1 px per tick |
| Hunger ×10 shanks | above hotbar-right, right-aligned, drains right-to-left; jitters when `saturation == 0`; green tint while food-poisoned |
| Armor ×10 icons | above hearts, shown only when armor points > 0; 1 icon = 2 points |
| Air bubbles ×10 | above hunger, shown while head submerged; 1 bubble = 30 air ticks (03 owns air/drowning) |
| XP bar | thin green bar between hotbar and hearts/hunger rows; level number centered above |
| Hotbar | 9 slots, 20×20 px icons, count bottom-right, durability bar (green→red hue lerp 120°→0°, width = remaining fraction) when damaged; white selection frame |
| Crosshair | 9×9 px plus at screen center |
| Break progress | crack overlay on the targeted block: 10 procedural crack stages (stage = floor(progress×10)), rendered as a decal pass |
| Damage vignette | red screen-edge flash 0.3 s on damage (03 triggers) |

### 15.2 Tooltips
Hovering any slot: dark panel with item display name; damaged tools append `dur/max`. 1-line only (no lore/enchants).

### 15.3 Screens
Inventory (E), crafting table, chest, furnace, pause, death screen (shows Score = total XP, Respawn button). All UI is a single HTML/canvas overlay at 2× GUI scale, textures from the icon atlas (§8.2).

### 15.4 Debug item palette (F4 mode, per 03)
Overlay grid of every registry entry (blocks by id, then items), 9 columns, scrollable, with a text filter box matching substring of name. Left-click an entry → give a full stack (respecting max stack) to cursor; right-click → give 1. Only available while F4 debug mode is active.

---

## 16. Item entities (dropped items)

| Property | Value |
|---|---|
| AABB | 0.25 × 0.25 × 0.25 |
| Physics | gravity −0.04/t, velocity ×0.98 air drag, ×0.6 ground friction `(approx)`; floats up in water (buoyancy +0.06/t, cap 0.06) `(approx)` |
| Spawn (block drop) | at block center; velocity: random horizontal ±0.1, vy 0.2 `(approx)` |
| Spawn (player throw / Q) | eye position; velocity = look dir × 0.3 + vy 0.1 + random ±0.02 `(approx)` |
| Pickup delay | 10 t (mined/mob drops), 40 t (player-thrown) |
| Pickup box | player AABB expanded +1.0 horizontally, +0.5 vertically; item flies to player over ~3 t then adds to inventory (partial pickup allowed if nearly full; leftover stays) |
| Merge | every 40 t and on spawn: combine with same id+state items whose AABB is within 0.5×0.25×0.5 expansion, if combined ≤ max stack; merged entity keeps the larger remaining despawn time |
| Despawn | 6000 t (5 min) age |
| Destroyed by | lava, fire, cactus contact, explosions |
| Visual | blocks: mini cube scale 0.25; items: vertical textured quad (double-sided); both spin yaw 0.03 rad/t and bob y = 0.1·sin(age/10) `(approx)`; render 1 sprite for count 1, 2 offset sprites for 2–16, 3 for 17–32, 4 for 33+ |

Death drops: full inventory + armor spawn as item entities with random scatter velocity; they follow normal 6000 t despawn.

---

## 17. Random ticks & block updates owned by this file

Random tick dispatch (01): each game tick, per loaded 16×16×16 section, pick 3 random cells; if the block has a handler, run it. Handlers defined here: crops ×3, sapling, sugar_cane, cactus, farmland, grass_block, snow_layer, ice, leaves (§5). Scheduled ticks: fluids (§6), fire burnout (§5.14). Neighbor-update reactions: sand/gravel fall, torch/ladder/door/bed/snow support pops, cactus & sugar cane validity, crop pops when farmland is lost, fluid wake-ups, TNT-adjacent fire ignition.

---

## 18. Persistence contract (feeds 01's save schema)

Must serialize:

| Data | Fields |
|---|---|
| Block grid | id + state nibble per voxel (chunks, 01) — covers fluid levels, crop stages, farmland moisture, facings, door open, leaf persistence, cactus/cane age |
| Chest | 27 × {itemId, count, damage} |
| Furnace | 3 slots, `burn`, `fuelTotal`, `cook`, `xpBank` |
| Item entities | per chunk: {itemId, count, damage, pos, vel, age, pickupDelay} |
| Primed TNT | {pos, vel, fuseRemaining} |
| Falling blocks | written back as solid blocks at their current cell on save `(approx simplification)` |
| Player | inventory[36] + armor[4] as {itemId, count, damage}, selected hotbar slot, foodLevel, saturation, exhaustion, foodPoisonTicks, XP total (+ derived level), spawn point (03), health (03) |

Item stacks serialize as `{id:uint16, count:uint8, damage:uint16?}`; `damage` only for tools/armor.

---

## 19. Acceptance checklist

- [ ] All 67 block IDs (0–66) and all item IDs 256–345 registered with the exact names above; every name referenced by files 01–05 resolves.
- [ ] Stone mined with wooden pickaxe drops cobblestone in 1.15 s (via 03's formula: 1.5×1.5/2); stone mined by hand (7.5 s) drops nothing; obsidian requires diamond pickaxe (9.4 s) and drops nothing with iron.
- [ ] Gravel drops flint 10% of breaks (±3% over 500 trials); oak leaves drop saplings ~5%, apples ~0.5%.
- [ ] Sand/gravel become falling entities when support is removed and re-solidify on landing; falling onto a torch pops the torch first.
- [ ] Torch emits light 14 and pops when its support block is broken; furnace swaps to furnace_lit (light 13) while burning.
- [ ] Water: source on flat ground spreads exactly 7 cells; removing the source drains everything within seconds; 2×2 source pool refills its center (infinite source); lava spreads 3 and updates every 30 t.
- [ ] Water touching a lava source creates obsidian; touching flowing lava creates cobblestone; lava flowing onto water creates stone; bucket can pick up and place only sources.
- [ ] Full tool matrix craftable (25 recipes) with correct durabilities 59/131/250/32/1561 and speed multipliers 2/4/6/12/8; gold pick cannot harvest iron ore; stone pick can.
- [ ] All 16 armor pieces craftable; full diamond = 20 armor points on the HUD (10 icons).
- [ ] Every recipe in §10 matches in the correct grid, including mirrored axe/hoe/bow; shift-click batch crafting works; recipes fitting 2×2 work in the player grid.
- [ ] Furnace smelts 1 item per 200 t; 1 coal smelts exactly 8 items; lava bucket 100 and leaves an empty bucket; flame/arrow gauges track `burn/fuelTotal` and `cook/200`; collecting 10 iron ingots grants 7 XP.
- [ ] Log → charcoal → torch chain works without coal.
- [ ] Hunger: sprint-jumping drains saturation measurably (0.2/jump); at hunger 20 + saturation, damage heals at 1 HP/0.5 s; at hunger 18–19 at 1 HP/4 s; at hunger ≤ 6 sprint is blocked; at hunger 0 health decays to exactly 1 HP and stops (Normal).
- [ ] Eating takes 32 t held; food values match §7.3; saturation never exceeds foodLevel; rotten flesh causes green hunger bar + faster drain 80% of the time.
- [ ] Wheat farm loop: till → plant seeds → 8 stages under light ≥ 9 (wet grows ~1.8× faster than dry) → harvest 1 wheat + seeds → 3 wheat craft bread; trampling reverts farmland; bone meal advances stages.
- [ ] Bed sets spawn on click, sleeps only at night with no monsters near, skips to dawn (04), drops itself when either half is broken.
- [ ] TNT ignited by flint & steel explodes after exactly 80 t with power 4, destroying dirt but not obsidian; explosion chains ignite adjacent TNT with 10–30 t fuses.
- [ ] Ender pearl throw teleports the player and deals 5 self-damage; egg spawns a chicken ~1/8 throws.
- [ ] XP: mining diamond ore grants 3–7 points; level curve matches formulas (level 16 boundary at 2L+7→5L−38); death drops min(7×level, 100) as orbs and zeroes XP.
- [ ] Inventory clicks behave per §14.2 table including right-click half/place-one, shift-routing per screen, number-key swaps, Q/Shift+Q drops, double-click collect.
- [ ] Dropped items merge within the 0.5×0.25×0.5 box, are picked up through the +1.0/+0.5 expanded player box after 10 t (40 t if thrown), and despawn at 6000 t; items burn in lava.
- [ ] Chest contents, furnace progress (including mid-smelt `cook` and `xpBank`), crop stages, fluid levels, and player hunger/XP all survive save + reload (01).
- [ ] Every block and item shows a correct procedural icon in inventory/debug palette; cube blocks render isometric, items render flat.
