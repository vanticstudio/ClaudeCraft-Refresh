# 12 — Villages, Villagers, Trading & Iron Golems

EXPANSION spec. Adds naturally generating villages (plains/desert/savanna/taiga), the villager mob with professions/schedules/levels, the full 1.20 trading system (trimmed to in-scope items), villager breeding, iron golems, zombie villagers + curing, the bell, and 11 new blocks (dirt path, bell, composter, barrel, lectern, blast furnace, smoker, fletching table, hay bale, emerald ore/block) + the emerald item. Baseline Java 1.20 Normal, exact wiki values unless `(approx)` / `> Adaptation:`.

Cross-file contracts: **02** decoration pipeline (villages generate through §10's deterministic-overlap approach — solved explicitly in §2 below); **05** mob format/AI/pathfinding (villager, zombie villager, iron golem are new roster entries); **06** registries/UI conventions; **08** grindstone block (weaponsmith workstation — owned by 08, referenced here) + enchanted-book/loot-enchant procedures; **09** brewing stand (cleric workstation — owned by 09), weakness splash potion, golden apple, golden carrot, tipped arrows; **10** smithing table (toolsmith workstation — owned by 10). **14**: the villager/village simulation is host-only; clients receive entity/block state only (one line, that is all 14 needs). Sound events for **16** in §12.3.

Explicitly OUT (state, do not build): cartography table, loom, stonecutter, cauldron (and their professions: cartographer, shepherd, mason, leatherworker, fisherman), wandering trader, cats, raids/pillagers/patrols/outposts, gossip system, demand-based repricing, hero of the village, zombie sieges, night-spawned zombie villagers at village outskirts (zombie villagers exist ONLY via natural 5% zombie spawns and villager conversion), snowy villages (snowy_tundra not a village biome here), abandoned/zombie villages, villager item pickup & food sharing, farmer crop tending, golem poppy-offering idle, golem player-aggro (neutral to player always), job-site jump-scanning particles beyond the claim flash, target block, netherite/chainmail trades.

## Amendments to base files

- **AMENDS CLAUDE.md §7 (Out of scope v2):** ensure "villages & villagers" is absent from the out-of-scope list (implemented by this file).
- **AMENDS 02 §1.2:** delete the "Emerald ore — SKIP" row and the "Structures (villages …) — SKIP" row's village mention; both are implemented per this file (dungeons/mineshafts/strongholds remain skipped).
- **AMENDS 02 §1.3:** add to the gen-worker registry dependency list: `dirt_path`, `bell`, `composter`, `barrel`, `lectern`, `blast_furnace`, `smoker`, `fletching_table`, `hay_bale`, `emerald_ore`, `oak_fence`, `torch`, `chest`, `crafting_table`, `farmland`, `wheat_crop`, `carrot_crop`, `potato_crop`, `bed_block`, `oak_door`, `glass`, `bookshelf`, `cobblestone`, `oak_planks`, `spruce_planks`, plus (if 08/09/10 are built) `grindstone`, `brewing_stand`, `smithing_table`.
- **AMENDS 02 §2.2:** add `"village"` to the fixed system-name list.
- **AMENDS 02 §9.3:** append ore feature row **#15 emerald** exactly as given in §6.1 of this file (mountains-gated, runs last, after diamond large). Delete the emerald sentence from §9.4.
- **AMENDS 02 §10.1:** add a feature-class row to the reach-radius table: `Villages | 5 | layout clamped to ±72 blocks of anchor center (§2.3 of 12-VILLAGES)`.
- **AMENDS 02 §10.2:** decoration order becomes: `1. trees → 2. cactus/dead bush/cane/pumpkins → 3. grass+flowers → 4. VILLAGE stamp (origin anchors ±5 chunks, stream "village"; clears vegetation in its volumes) → 5. snow/ice → 6. heightmap recompute; herds`. Herd placement additionally rejects positions inside a village's bounds AABB (§2.2).
- **AMENDS 02 §13.1:** insert pipeline step 7b "stamp village intersections (12-VILLAGES §2)" and extend the §13.2 payload with the optional `villageMeta` field (§2.7 of this file). Worker keeps an 8-entry LRU cache of computed village layouts keyed by anchor.
- **AMENDS 02 §14:** add budget row: village stamping ≤ 2 ms amortized per chunk (layout compute ≤ 8 ms, cached across the ≤ 121 chunks that read it).
- **AMENDS 03 §16.1:** insert a new step between 2 and 3: `2b. if heldItem is a shovel and hit.block ∈ {grass_block, dirt} and blockAt(hit.pos + up) == air and hit.face != bottom: → convert to dirt_path (12-VILLAGES §7.1), shovel −1 durability, swing; done`. Add to the interactables note: bell, barrel, composter, blast_furnace, smoker are interactable blocks; right-clicking a **villager entity** opens trading (§9) and a **baby villager / golem / zombie villager** does nothing (except golden-apple feeding, §11).
- **AMENDS 03 §12.2:** add rule: landing on `hay_bale` multiplies computed fall damage by **0.2** (round down; MC exact).
- **AMENDS 05 §2:** roster grows by villager, zombie_villager, iron_golem (stat blocks §8/§10/§11 of this file). Iron golem overrides the "knockback resistance 0" note: golem kb resistance = 1.0 (immune).
- **AMENDS 05 §3.2:** inside `spawnMob`, 5% of runtime-spawned zombies become `zombie_villager` (MC exact; independent of the 5% baby roll, both can apply).
- **AMENDS 05 §6:** zombie target acquisition becomes: nearest of {player, villager, iron_golem} within detection 35 with LOS (was players-only). 05 §8.1's "villagers don't exist" sentence is void.
- **AMENDS 06 §1:** block IDs extend to 170–184, item IDs to 435–449, per the assignment table below. `dirt_path` joins the no-block-item exception list (created by shovel only; debug palette gives dirt). New interactable flags per this file. Registry acceptance count updates accordingly.
- **AMENDS 06 §5.7 (bed):** beds gain an `occupant` runtime field. RMB on a bed claimed-and-occupied by a sleeping villager → message "This bed is occupied" (no sleep, spawn still set). Breaking a bed releases any villager claim (§8.5).
- **AMENDS 06 §11.3:** add fuels: `barrel, lectern, fletching_table, composter` = 300 t.
- **AMENDS 01 §16 (save schema):** add object store `villages` (§2.7 records + runtime claim state), and persist the new entity types' fields (§8.7, §10, §11).

## Contents

1. [ID assignments](#1-id-assignments)
2. [Worldgen: deterministic multi-chunk villages](#2-worldgen)
3. [Layout algorithm](#3-layout-algorithm)
4. [Building templates](#4-building-templates)
5. [Biome palette](#5-biome-palette)
6. [Emerald ore & new-block worldgen data](#6-emerald)
7. [New block behaviors](#7-new-block-behaviors)
8. [Villagers: entity, professions, schedule, claims](#8-villagers)
9. [Trading](#9-trading)
10. [Breeding & babies](#10-breeding)
11. [Iron golem & zombie villager (curing)](#11-golem-and-zombie-villager)
12. [Registry/texture/sound tables](#12-registry-texture-sound)
13. [Acceptance checklist](#13-acceptance-checklist)

---

## 1. ID assignments

### 1.1 Blocks (170–184)

| ID | Name | Notes |
|---:|---|---|
| 170 | dirt_path | shovel-created, 15/16 height (reuses farmland shape) |
| 171 | bell | interactable; rings |
| 172 | composter | interactable; fill 0–8 in state nibble |
| 173 | barrel | interactable; 27-slot container |
| 174 | lectern | librarian workstation; no UI |
| 175 | blast_furnace | interactable; ore smelting 2× |
| 176 | blast_furnace_lit | id-swap pair per 06 §5.5 convention |
| 177 | smoker | interactable; food smelting 2× |
| 178 | smoker_lit | id-swap pair |
| 179 | fletching_table | fletcher workstation; no UI (MC parity) |
| 180 | hay_bale | 9 wheat; fall damage ×0.2 |
| 181 | emerald_ore | mountains worldgen |
| 182 | emerald_block | storage block |
| 183–184 | *reserved* | unused, do not assign elsewhere |

### 1.2 Items (435–449)

| ID | Name | Stack | Notes |
|---:|---|---:|---|
| 435 | emerald | 64 | currency; drops from emerald_ore; trade medium |
| 436–449 | *reserved* | — | unused, do not assign elsewhere |

All new blocks get auto block-items per 06 §1 except `dirt_path` (no block-item). Foreign items referenced by trades and NOT defined here: `enchanted_book` (08), `golden_apple`/`golden_carrot`/`weakness splash potion`/`tipped arrows` (09). Foreign workstation blocks referenced: `grindstone` (08), `brewing_stand` (09), `smithing_table` (10). **Fallback rule:** wherever a template or trade references a block/item owned by an unbuilt expansion file, substitute `crafting_table` (blocks) or skip the trade row (items). State the substitution in DEVIATIONS.md.

---

## 2. Worldgen: deterministic multi-chunk villages {#2-worldgen}

This is the canonical solution for structures that span chunks, aligned with 02 §10.1's option (B): **the entire village layout is a pure function of its anchor chunk's seed**, and every generating chunk independently recomputes any nearby anchor's layout and stamps only the blocks that fall inside itself. No chunk ever reads another chunk's block data; all terrain queries go through 02's canonical `heightAt`/`biomeAt`.

### 2.1 Candidate grid & spawn roll

The world is partitioned into **regions of 32×32 chunks** (512×512 blocks). Each region proposes at most one village:

```js
const VIL = subSeed("village");                       // 02 §2.2
function villageForRegion(Vx, Vz) {                   // Vx = floor(cx/32), Vz = floor(cz/32)
  const rng = splitmix32(chunkSeed(VIL, Vx, Vz));     // region-scoped stream (02 §2.3)
  const acx = Vx*32 + 4 + rngInt(rng, 24);            // anchor chunk, ≥4-chunk margin
  const acz = Vz*32 + 4 + rngInt(rng, 24);            //   → ≥8-chunk gap between neighbors' villages
  if (rng() >= 0.40) return null;                     // 40% spawn roll
  const center = { x: acx*16 + 8, z: acz*16 + 8 };
  const biome = biomeAt(center.x, center.z);          // canonical, lattice-interpolated
  if (!(biome in {plains, desert, savanna, taiga})) return null;   // biome gate (02 §6.1 ids 3/6/7/8)
  if (heightAt(center.x, center.z) < 64) return null; // never submerged/beach-level
  return { acx, acz, center, biome };
}
```

Density: 40% × biome gate (~50% of land) ≈ 1 village per ~2 regions ≈ **1 per ~1000×1000 blocks over village-legal terrain** (MC 1.20: spacing 34 / separation 8 chunks ≈ comparable). The margin construction guarantees two villages are never closer than 8 chunks (128 blocks) — anchors sit ≥4 chunks inside their region on each side.

### 2.2 Reach radius & bounds

The layout generator (§3) clamps every block a village writes (pieces, paths, lamp posts, foundations) to the AABB `|x − center.x| ≤ 72, |z − center.z| ≤ 72` (full Y). With ≤72-block reach, **reach radius = 5 chunks** Chebyshev (80 blocks ≥ 72 + 8-block anchor-to-chunk-edge slack) — the row added to 02 §10.1's table. `villageBounds = center ± 72 horizontally` is also the runtime "village bounds" AABB used by AI leashes, golem/bed scans, and herd suppression.

### 2.3 Per-chunk stamping protocol

When generating chunk C = (cx, cz), during decoration step 4 (amended 02 §10.2):

```
for each region R overlapping the chunk window [cx−5 .. cx+5] × [cz−5 .. cz+5]:   // ≤ 4 regions (32 > 2·5)
  v = villageForRegion(R)                       // memoized; cheap
  if v == null or Chebyshev((v.acx,v.acz),(cx,cz)) > 5: continue
  L = layoutFor(v)                              // §3; pure function of anchor; LRU-cached (8 entries)
  stamp(L, C)                                   // §2.4 — writes only cells inside C
```

### 2.4 Stamp operation order (the determinism invariant)

`layoutFor` returns an **ordered operation list**. Every chunk that overlaps the village replays the *same* list in the *same* order, applying each block write only if the cell lies inside itself. Because each cell's final content is "last write in list order", the union of all chunks' stamps is byte-identical to a single-pass reference stamp — the same argument 02 uses for trees/veins. Fixed global order:

```
1. CLEAR volumes    — per path cell and per piece: see heights below; any non-air → air
                      (removes trees/cactus/plants that earlier decoration steps placed)
2. FOUNDATIONS      — per piece footprint column: fill FLOOR material from yBase−1 down to
                      max(heightAt(x,z), yBase−3); if heightAt > yBase−1 the terrain is CUT
                      (already air from step 1's clear, which spans terrain over-height too)
3. PATHS            — per path cell {x,y,z}: set (x,y,z) = PATH block, clear (x,y+1..y+3,z);
                      if the pre-existing surface at (x,y,z) was water/air → place FLOOR
                      material instead of PATH (bridge/causeway stub)
4. PIECES           — in layout list order, layer by layer bottom-up, each cell per template map
5. LAMP POSTS       — fence, fence, torch columns at recorded cells
```

Clear volume per piece: footprint (rotated template AABB) from `yBase` up to `yBase + templateHeight + 2`, plus terrain columns inside the footprint above `yBase` (the "cut above" rule). Clear volume per path cell: `y+1..y+3`.

### 2.5 Terrain rules

- Every piece stores `yBase` computed in §3 from canonical `heightAt` (never block reads).
- Foundations fill at most 3 down (`yBase−1 .. yBase−3`); §3 rejects placements needing more.
- Paths follow terrain with ±1 smoothing computed inside the layout walk (§3.2), so stairs-free slopes read as gentle steps.
- Caves that undercut a foundation deeper than 3 stay open (accepted cosmetic, same class as 02 §10.1's tree-over-cave-mouth tradeoff).
- Snow/ice (02 §10.6) runs after stamping → taiga roofs get snow caps automatically.

### 2.6 What villages never do

Never modify blocks outside `villageBounds`; never read chunk block arrays during layout; never use `Math.random`; never place fluids except the well's and farm's water source cells (settled sources, 02 §7.3 contract); never overwrite `bedrock`.

### 2.7 `villageMeta` payload (worker → main thread)

Emitted **once**, attached to the anchor chunk's ChunkPayload only (the anchor chunk is generated exactly once; saved chunks are never regenerated per 02 §13.1, so the meta is persisted with the save — amended 01 §16):

```js
villageMeta: {
  anchor: [acx, acz], center: {x, z}, biome,
  bounds: {minX, minZ, maxX, maxZ},                    // center ± 72
  bellPos: [x, y, z],
  beds:      [ {pos:[x,y,z], claimedBy:null}, ... ],   // one per bed FOOT block stamped
  stations:  [ {pos, type:"composter"|"lectern"|"brewing_stand"|"blast_furnace"|"grindstone"|"smithing_table"|"smoker"|"fletching_table", claimedBy:null}, ... ],
  indoorAnchors: [ [x,y,z], ... ],                     // 1 interior cell per roofed building
  golem: { alive:false, respawnTimer:0 }
}
```

Runtime mutations (claims, golem state) are saved back into this record. Breaking a bed/workstation block inside `bounds` removes its entry (setBlock hook on those ids); placing one inside bounds appends an entry — player-built expansion works. Villager spawn records ride the normal `spawns` array (§8.6) of whichever chunk contains each spawn position.

---

## 3. Layout algorithm {#3-layout-algorithm}

Pure function of the anchor. One RNG stream: `rng = splitmix32(chunkSeed(subSeed("village"), acx, acz) ^ 0x5eed)` (offset so it never collides with the region stream). All terrain queries via canonical `heightAt` (02 §4.4). Budget ≤ 8 ms; cached.

### 3.1 Size & template pool

```
sizeRoll = rng()
buildings = sizeRoll < 0.6 ? 6 + rngInt(rng,5)        // small: 6–10
                           : 11 + rngInt(rng,10)      // medium: 11–20
```

Weighted pool (drawn per slot; farm & lamp posts are fillers outside this count):

| Template | Weight | Max per village | Guarantee |
|---|---:|---:|---|
| small_house | 5 | — | ≥ 2 |
| medium_house_L | 3 | 3 | — |
| farm | 4 | — | ≥ 1 |
| library | 1 | 1 | — |
| church | 1 | 1 | — |
| smithy | 1 | 1 | — |
| butcher_shop | 1 | 1 | — |
| fletcher_hut | 1 | 1 | — |

Guarantees: after the weighted draw, if <2 small_houses or 0 farms were drawn, overwrite the last slots. well + meeting_point always exist (not in the count).

### 3.2 Algorithm

```
1. centerY = heightAt(center);  place WELL at center offset (−6, −6)...(well is 4×4, its own yBase)
   place MEETING_POINT (7×7, contains the bell) centered on `center`; yBase = centerY
2. PATH ARMS: nArms = 2 + rngInt(rng, 3)                        // 2–4
   for each arm: heading = one of N/E/S/W (no repeats; order rolled), pos = meeting-point edge,
   y = centerY, length = 40 + rngInt(rng, 33):                  // 40–72 steps
     per step: pos += heading; every 6–10 steps heading rotates ±90° with p=0.35 (never doubles back);
       ty = heightAt(pos); y = clamp(ty, y−1, y+1)              // ±1 terrain smoothing
       if ty ≤ 63 (water) for >4 consecutive steps → terminate arm
       emit path cell {x, y, z}; width 2: also emit the cell to the heading's left
       clamp |pos−center| ≤ 70 (reflect heading at the border)
3. BUILDING SLOTS: walk each arm; every 7 + rngInt(rng,6) steps propose a slot on a rolled side
   (perpendicular offset 2): candidate origin = path cell + side·(2 + templateHalfWidth)
     - rotation: door face toward the path (0–3)
     - yBase = heightAt at footprint center
     - REJECT if: footprint AABB inflated by 2 intersects any accepted piece/well/meeting AABB;
       or max−min of heightAt over footprint corners+center > 3;                 // ≤3 relief
       or any footprint corner |Δ| > 70 from center; or footprint touches water (heightAt ≤ 63)
     - template drawn from §3.1 pool (respect maxima/guarantees); on reject, redraw ≤ 2 times
   stop when the building count is met or all arms exhausted (village may under-fill; fine)
4. FILLERS: each accepted building emits a 1-wide path stub from its door to the nearest arm cell.
   LAMP POSTS: along arms every 12th step, offset 1 to the right, if cell not inside any AABB.
5. Record ordered op list (§2.4), bell pos, beds, stations, indoor anchors, chest loot seeds
   (lootSeed = splitmix32 draw per chest), villager/golem spawn records (§8.6).
```

Chest loot (rolled at stamp time from the recorded per-chest seed): house/fletcher/library chest = 1–3 bread, 0–2 oak_sapling, 0–2 string, 10%: 1–3 iron_ingot; smithy chest = 1–4 iron_ingot (75%), 1–2 gold_ingot (30%), 1 diamond (15%), 1–3 bread, 0–2 obsidian (25%) `(approx of 1.20 weaponsmith loot)`.

---

## 4. Building templates {#4-building-templates}

### 4.1 Template format

Each template is a stack of **plan-view layers** (top-down, +X right, +Z down) plus a fixtures list. A template declares:

```js
{ name, w, d, height,           // footprint (blocks), wall height (roof adds on top)
  door:[dx,dz], yBaseRule,      // door cell = path attachment; slope rule handled by §3.2 rejection
  layers:{ f:[...], w1:[...], w2:[...], roof:[...] },   // strings, one char per cell
  fixtures:[ {kind, at:[dx,dy,dz], data} ... ],         // beds, workstations, chests, torches, crops
  beds:n, station:type|null }                            // record-emitting counts (§2.7)
```

**Symbol legend** (resolved to concrete block ids per biome in §5; `.` = leave existing/air):

| Sym | Meaning | Sym | Meaning | Sym | Meaning |
|:--:|---|:--:|---|:--:|---|
| `=` | FLOOR block | `#` | WALL block | `X` | LOG/corner post |
| `^` | ROOF block | `o` | window = `glass` (31) | `D` | `oak_door` (53), faces path |
| `T` | `torch` (38) | `n` | `oak_fence` (52) | `P` | path = `dirt_path` (170) |
| `b` | bed FOOT / `h` bed HEAD (`bed_block` 54) | `C` | `chest` (37) | `~` | `water` source (63) |
| `f` | `farmland` (55)+crop | `H` | `hay_bale` (180) | `K` | `bookshelf` (50) |
| `L` | `lava` source (64) | `B` | `bell` (171) | `l` | lamp post (fence stack + torch) |
| `W` | workstation (per building; see its `station`) | | | | |

Rotation (0–3, door-toward-path) is applied to the whole char-grid at stamp time (§3.2). All diagrams are drawn at **rotation 0** (door on the −Z / top edge). Wall height default 2 (`w1`,`w2`); roof is one layer at `yBase+height`. Where a template needs a taller feature (church tower) it lists extra layers.

> Adaptation: MC's village pieces are hand-built `.nbt` structures with jigsaw connectors. VoxelCraft replaces them with these compact parametric templates — smaller and blockier than vanilla, same silhouettes and identical fixtures (bed/workstation/door/torch), placed by the deterministic road-growth walker (§3) instead of jigsaw assembly. All footprints are ≤ 9×9 to keep `relief ≤ 3` rejection (§3.2) satisfiable on normal terrain.

### 4.2 Fixed structures (always present, not in the weighted count)

**well** — 4×4, `yBase = centerY`. Frame of WALL, water core, a fence-and-`torch` corner post pair.

```
f (yBase, floor ring + water):     w1 (yBase+1, rim):     w2 (yBase+2, posts):
  # # # #                            n . . n                 T . . T
  # ~ ~ #                            . . . .                 . . . .
  # ~ ~ #                            . . . .                 . . . .
  # # # #                            n . . n                 T . . T
```
Water cells are settled sources (§2.6). Fixtures: none (no beds/stations). The well is the village origin marker; `bellPos` is NOT here — it is at the meeting point.

**meeting_point (bell plaza)** — 7×7, centered on `center`, `yBase = centerY`. A paved plaza with the bell on a 2-high post at the middle and log "benches."

```
f (yBase, plaza):        w1 (yBase+1):         w2 (yBase+2):
  P P P P P P P            l . . . . . l         . . . . . . .
  P = = = = = P            . . . . . . .         . . . . . . .
  P = X . X = P            . . . n . . .   →     . . . B . . .   (bell atop the post)
  P = . n . = P            . . . . . . .         . . . . . . .
  P = X . X = P            . . . . . . .         . . . . . . .
  P = = = = = P            . . . . . . .         . . . . . . .
  P P P P P P P            l . . . . . l         . . . . . . .
```
`n` at plaza center is an `oak_fence` post; `B` (bell) sits at `yBase+2` on it → `bellPos = [center.x, centerY+2, center.z]`. The 4 `l` are lamp posts (fence,fence,torch → light the plaza at night). `X` = log benches (visual). Path arms (§3.2) attach to the four `P` edges. This is the village's social anchor (§8.4 gather target).

### 4.3 Weighted building templates

**small_house** — 5×5, height 3, 1 bed, no station. Guarantee ≥ 2 per village (§3.1).

```
f (floor):        w1:               w2:               roof (yBase+3):
  X # D # X         X o . o X         X # # # X         ^ ^ ^ ^ ^
  # = = = #         # . . . #         # . . . #         ^ ^ ^ ^ ^
  # = = = #         # . . . #         o . . . o         ^ ^ ^ ^ ^
  # = = h #         # . . . #         # . . . #         ^ ^ ^ ^ ^
  X # # # X         X # o # X         X # # # X         ^ ^ ^ ^ ^
```
Fixtures: bed `b/h` along +X interior wall (`h` shown at floor `(3,3)`, foot `b` at `(2,3)`); `torch` on the +Z inner wall at `w2`; door `D` on −Z edge. Beds emit §2.7 records.

**medium_house_L** — 7×7 L-shape (a 3-wide wing), height 3, 2 beds, optional station slot. Max 3, drawn by weight.

```
f (floor):          w2 (walls + windows):     roof:
  X # D # X . .        X # . # X . .            ^ ^ ^ ^ ^ . .
  # = = = # . .        o . . . o . .            ^ ^ ^ ^ ^ . .
  # = = = # X X        # . . . # # X            ^ ^ ^ ^ ^ ^ ^
  # = h b = = #        o . . . . . o            ^ ^ ^ ^ ^ ^ ^
  X # = = = = #        X # . . . . o            ^ ^ ^ ^ ^ ^ ^
  . . # = h b #        . . # . . . #            . . ^ ^ ^ ^ ^
  . . X # # # X        . . X # o # X            . . ^ ^ ^ ^ ^
```
Fixtures: 2 beds (rows 3 and 5). `W` station slot at `(5,y,3)` interior corner: 40% chance the template carries a `composter` (172) there → becomes a farmer-capable house (else empty). `torch`es two interior walls. This is the primary breeding-bed supplier.

**farm** — 7×9, height 1 (fenced field, no roof), station = `composter`. Guarantee ≥ 1.

```
f (fenced field, yBase):       fixtures plane (crops/water):
  n n n n n n n                  . . . . . . .
  n f f ~ f f n                  crops on every `f`; `~` = irrigation source
  n f f ~ f f n                  (water hydrates farmland within 4, 06 §5.11)
  n f f ~ f f n                  W (composter) placed at the gap in the fence,
  n f f ~ f f n                  row 9 center; a `chest` beside it.
  n f f ~ f f n
  n f f ~ f f n
  n f f ~ f f n
  n W n D n C n                  D = fence gate gap (walk-in); no door block
```
Crops: per column pick `wheat_crop`(56)/`carrot_crop`(57)/`potato_crop`(58) by `posHash(subSeed("detail"),x,0,z) → [0,.5)=wheat, [.5,.8)=carrot, [.8,1)=potato`, stage `4 + rngInt(4)` (partly grown). `~` cells are `water` sources. `composter` (`W`) is the farmer job site. `chest` holds farm loot (§3.5). Farm is a filler (not in the building count) but a job site.

**animal_pen** — 6×6, height 1, no station, no bed. Optional filler (added when an arm has room; not guaranteed).

```
f:                 fixtures:
  n n n D n n        interior floor stays `grass_block`; `D` = gate gap
  n = = = = n        emits ONE herd spawn record (§2.7 → rides chunk `spawns`):
  n = = = = n          {type: rngPick(cow,sheep,pig), x,y,z at pen center},
  n = = = = n          size 2 (adults). Fence is 1.5-tall collision (06) → holds them.
  n = = = = n        A `torch` on one corner post.
  n n n n n n
```
> Adaptation: the pen re-uses 05's passive-mob spawn record, so village animals are ordinary breedable livestock — no new entity.

**library** — 7×7, height 3, 1 bed, station = `lectern` (→ librarian).

```
f:                  w2:                 roof:
  X # D # X . .        X # . # X . .       ^ ^ ^ ^ ^ ^ ^
  # = = = # . .        o . . . o . .       ^ ^ ^ ^ ^ ^ ^
  # K = = # X X        # . . . # # X       ^ ^ ^ ^ ^ ^ ^
  # K = W = = #        # . . . . . o       ^ ^ ^ ^ ^ ^ ^
  # K = = = h #        o . . . . . #       ^ ^ ^ ^ ^ ^ ^
  X # = = = b #        X # . . . . o       ^ ^ ^ ^ ^ ^ ^
  . . X # # # X        . . X # o # X       . . ^ ^ ^ ^ ^
```
Fixtures: `K` = wall of `bookshelf`(50) (also supplies the fantasy of a study); `W` = `lectern` at `(3,y,3)`; bed at row 4–5 +X wall; 2 `torch`es. A `chest` (§3.5 loot) tucked at `(5,y,2)`.

**smithy** — 7×7, height 3, no bed, stations = `blast_furnace` + `smithing_table` + `grindstone` (hosts armorer, toolsmith, weaponsmith). Max 1.

```
f (stone/cobble floor):    w2:                 fixtures:
  X # # # X . .              X o . o X . .        W1 = blast_furnace (175) at (1,y,2)
  # = = = # . .              # . . . # . .        W2 = smithing_table (10) at (5,y,2)
  # W1 = W2# X X             # . . . # # X        W3 = grindstone   (08) at (3,y,4)
  # = = = = = #              o . . . . . o        the forge: a 1-deep pit at (5,y-1,4)
  # = = W3 L = #             # . . . . . #        holds `L` lava (open flame); ring it
  X # = = C = #              X # . . . o X        with WALL so nothing walks in.
  . . X # D # X              . . X # . # X        C = chest (smithy loot §3.5). 2 torches.
```
If 08/10 are not yet built, substitute `crafting_table` for `smithing_table`/`grindstone` per §1.2 fallback and log it; the blast_furnace (this file) always stands so an armorer can still employ.

**butcher_shop** — 7×7, height 3, 1 bed, station = `smoker` (→ butcher); an attached fenced pen.

```
f:                    fixtures:
  X # D # X n n         W = smoker (177) at (1,y,2); C = chest at (3,y,2)
  # W = C # = n         bed at row 4 (+X wall); `n` cells (cols 5–6, rows 0–4)
  # = = = # = n         are a small fenced meat pen → emits 1 herd record
  # = = h b = n           (cow OR pig), size 2, like animal_pen.
  X # = = # = n         2 torches; door on −Z.
  . . X # # X n
  . . . n n n n
```

**church (temple)** — 7×9 footprint, height 5 (a squat tower), 1 bed, station = `brewing_stand` (→ cleric). Max 1.

```
f:                     w4 (upper tower, +Z half only):    roof (yBase+5):
  . X # # # X .           . X # # # X .                     . ^ ^ ^ ^ ^ .
  . # = = = # .           . # o . o # .                     . ^ ^ ^ ^ ^ .
  . # = W = # .           . # . . . # .                     . ^ ^ ^ ^ ^ .
  X # = = = # X           . X # # # X .                     . . ^ ^ ^ . .
  # = = = = = #           . . . . . . .                     . . . . . . .
  # = = = h b #           (lower storey only rows 4–8)      (lower roof at yBase+3
  # = o . o = #                                              over rows 4–8)
  X # = = = # X
  . . # D # . .
```
Fixtures: `W` = `brewing_stand` (09) on the raised altar at `(3,y,2)`; bed row 5 (+X); 3 `torch`es incl. one at the tower top; the tower gives the church its recognizable steeple. `brewing_stand` (09) substitutes `crafting_table` if 09 unbuilt (§1.2).

**fletcher_hut** — 5×6, height 2, 1 bed, station = `fletching_table` (→ fletcher); 2 `barrel`s (storage) + 1 chest.

```
f:                 w2:               fixtures:
  X # D # X          X o . o X         W = fletching_table (179) at (1,y,1)
  # W = C #          # . . . #         C = chest (fletcher loot §3.5) at (3,y,1)
  # = = = #          o . . . o         barrels (173) at (1,y,3) and (3,y,3)
  # r = r #          # . . . #         bed at row 4; 1 torch.
  # = = h b          # . . o .
  X # # # X          X # o # X
```
(`r` = barrel.) Barrels are decorative storage here (no fisherman profession, §OUT); they hold nothing at gen.

### 4.4 Path stubs, lamp posts, roofs

- Every building emits a 1-wide `dirt_path` stub from the cell in front of its `D` to the nearest road cell (§3.2 step 4). Desert villages pave stubs in the desert path variant (§5).
- Lamp posts (`l`): `oak_fence` at `y..y+1`, `torch` at `y+2` — placed along arms every 12th step and at the four plaza corners. They are the village's night lighting; with them, hostile spawns inside `villageBounds` are suppressed by light exactly as anywhere else (05 §3.2 predicate; no special village spawn rule).
- Roofs are flat single-layer `^` slabs of the biome roof block (no stairs/slabs in registry → flat roofs, a deliberate blocky look). Taiga/mountain-adjacent roofs receive snow caps automatically (02 §10.6 runs after stamping, §2.5).

---

## 5. Biome palette {#5-biome-palette}

Village biome ∈ {plains, savanna, desert, taiga} (§2.1 gate). Symbols → concrete block ids (all ids exist in 06 or this file; no new wood sets — savanna/taiga adapt with existing woods):

| Sym | plains | savanna | desert | taiga |
|:--:|---|---|---|---|
| `=` FLOOR | `oak_planks` 5 | `oak_planks` 5 | `sandstone` 20 | `spruce_planks` 7 |
| `#` WALL | `oak_planks` 5 | `oak_planks` 5 | `sandstone` 20 | `spruce_planks` 7 |
| `X` LOG post | `oak_log` 8 | `oak_log` 8 | `sandstone` 20 | `spruce_log` 10 |
| `^` ROOF | `oak_planks` 5 | `spruce_planks` 7 | `sandstone` 20 | `cobblestone` 4 |
| `o` window | `glass` 31 | `glass` 31 | `glass` 31 | `glass` 31 |
| `P` path | `dirt_path` 170 | `dirt_path` 170 | `sandstone` 20 | `dirt_path` 170 |
| `n` fence | `oak_fence` 52 | `oak_fence` 52 | `oak_fence` 52 | `oak_fence` 52 |

> Adaptation: (1) savanna villages use **oak** in place of MC acacia (no acacia set — matches 02 §6.3's savanna-tree adaptation), with spruce-plank roofs for a two-tone look. (2) taiga uses spruce walls + cobblestone roofs (MC taiga uses spruce + cobblestone, faithful). (3) desert is all-`sandstone` with flat roofs and **sandstone paths** (dirt_path looks wrong on sand); desert buildings omit `hay_bale` decor. (4) All biomes share one `oak_fence`, `glass`, and `dirt_path` (no per-wood fences in registry). Snowy/tundra is **not** a village biome (§OUT).

Workstation/bed/door/chest blocks are biome-invariant (a lectern is a lectern everywhere). Only the six structural symbols above recolor.

---

## 6. Emerald ore & new-block worldgen data {#6-emerald}

### 6.1 Emerald ore feature (append to 02 §9.3 as row #15 — AMENDS 02 §9.3)

Emerald generates like other ores (§9.2 vein algorithm, `"ore"` stream, radius-1 re-simulation) but with a **biome gate** and it runs **last**, after row #14 (diamond large):

| # | Feature | Block | Attempts /chunk | Size | Y distribution (ours) | (MC 1.20 original) | Air discard | Gate |
|---|---|---|---|---|---|---|---|---|
| 15 | emerald | `emerald_ore` (181) | 11 | 3 | tri(56, 96, 127) clipped | (100 @ tri −16–480 peak 232, size 1, mountains) | 0.5 | `biomeAt(x,z)==mountains` (id 10) only |

Placement change vs a normal ore: inside `placeVein`, for the emerald feature each candidate cell additionally requires `biomeAt(bx,bz)==mountains`; non-mountain cells are skipped **without consuming extra draws** (same clip-after-draw rule as §9.2). Net effect: emerald appears only in the exposed stone bands of mountain biomes (our Y ≥ 92 terrain), as single blocks/tiny clusters — MC's signature "one emerald in a mountainside." Delete the emerald sentence from 02 §9.4 (AMENDS already in header).

Density note: 11 attempts × mountains-fraction (~5–10% of land) × size 3 × 0.5 air discard ≈ **rare** — a player prospecting a mountain finds a handful per hundred blocks of tunnel, matching MC scarcity.

### 6.2 Emerald ore block & emerald item (registry rows)

Gameplay row (06 §2 format):

| ID | Name | Hard | Blast | Tool | Tier | Drops | XP on mine |
|---:|---|---:|---:|---|---|---|---|
| 181 | emerald_ore | 3.0 | 3.0 | pickaxe | iron | 1 emerald (435) | 3–7 |
| 182 | emerald_block | 5.0 | 6.0 | pickaxe | iron | self | 0 |

Light/render/physics (06 §3 format): both `Emit 0 | Opac O | Pass op | Shape cube | Grav — | Solid yes`. `emerald_ore` uses the ore-cube texture family (stone base + green speckle); `emerald_block` a full mineral block (06 §4 `blotch`/`solid` vocabulary). No silk-touch/fortune interaction beyond 08's generic hooks (fortune multiplies the single-emerald drop per 08 §5.6.3 when that enchant exists).

### 6.3 Emerald crafting (extend 06 §10)

| Output ×qty | Type | Pattern / shapeless | Notes |
|---|---|---|---|
| emerald_block ×1 | shaped 3×3 | 9× emerald (435) | storage compaction |
| emerald ×9 | shapeless | 1× emerald_block (182) | reverse |

Emerald has **no tool/armor recipe** (MC-exact — it is currency only). Its sole sinks are the block recipe and the beacon payment tier (13-BOSSES, which accepts emerald as a valid beacon-activation mineral — 13 owns that check; this file only guarantees the item exists).

---

## 7. New block behaviors {#7-new-block-behaviors}

Registry rows for blocks 170–180 (06 §2 + §3 format) are compiled in §12.1. Behaviors:

### 7.1 dirt_path (170)
- **Creation only** (no block-item, no recipe): shovel RMB on `grass_block`/`dirt` with air above (step 2b of the canonical RMB list, 08 §7.3; AMENDS 03 §16.1 in header). Shape = `farmland`'s 15/16 box; top texture = packed-dirt path.
- **Reversion**: on a neighbor/support update, if a solid or fluid occupies the cell above → revert to `dirt` (MC-exact "path trampled"). Falling `gravity` block landing on it → dirt then the block rests.
- Not farmland: crops can't be planted on it; walking speed normal.

### 7.2 bell (171)
- Interactable (03 §16.1). RMB → swing animation (pivot rock ±0.5 rad, 40-tick decay) + `village.bell` sound (§12.3) + emit a "bell ring" village event.
- On ring, all villagers bound to this village that are within 32 blocks and in the GATHER window flash their trade-refresh (cosmetic); no raid/horn behavior (§OUT). Placement state: bits0–1 attachment (floor/wall/two-wall), bits2–3 facing — visual only; the meeting-point bell is placed floor-standing atop its fence post.
- Not flammable, blast-resistant like iron_block class (`Blast 5.0`).

### 7.3 composter (172)
- Interactable. State nibble = **fill level 0–8**. RMB with a compostable item: with the item's compost chance, level += 1 and consume 1 item; at level 7 a success sets level 8 (**ready**); RMB an 8-level composter (empty hand or any) → dispense **1 `bone_meal` (332)**, reset to 0, play `composter.ready`.
- Compost chances (trimmed to owned items; MC-exact where the item exists):

| Chance | Items |
|---|---|
| 30% | `wheat_seeds` 337, `oak/birch/spruce_sapling` 14–16, `oak/birch/spruce_leaves` 11–13, `short_grass` 60, `dead_bush` 66 |
| 50% | `sugar_cane` 338, `cactus` (43 block-item), `melon`—n/a |
| 65% | `apple` 304, `carrot` 315, `potato` 316, `wheat` 336, `pumpkin` (44), `dandelion` 61, `poppy` 62, `red/brown_mushroom` (09, if built) |
| 85% | `bread` 305, `baked_potato` 317, `hay_bale` (180), `cookie`—n/a |

Farmer job site: villagers do **not** operate the composter (farmer crop-tending & food pickup are §OUT); it is a claimable POI and a player convenience only. Fuel 300 t (AMENDS 06 §11.3).

### 7.4 barrel (173)
- Interactable 27-slot container (identical inventory to `chest`, 06 §14/§15) — a `blockEntity:'barrel'` per 01 §4.2. **Difference from chest**: opens even with a solid block directly above (no air-gap requirement). Storage furniture; not a workstation in this build (fisherman §OUT). Fuel 300 t.

### 7.5 lectern (174)
- Librarian job site. **No functional UI** (written books are §OUT) — RMB does nothing but the claim/ownership glow. Fuel 300 t. Custom shape: 12/16 slanted-top desk box (render only).

### 7.6 blast_furnace (175) / blast_furnace_lit (176)
- Furnace variant (reuse 06 §11's furnace block-entity, UI, and fuel). Two changes: (a) **cook time ×0.5** (100 t vs 200 t; same fuel value consumed per item, so fuel burns through items twice as fast); (b) **input filter** = the "ore/metal" smelt class only: `raw_iron`(321)→`iron_ingot`, `raw_gold`(323)→`gold_ingot`, `iron_ore`(22)→`iron_ingot`, `gold_ore`(23)→`gold_ingot`, plus (10 tier) `ancient_debris`→`netherite_scrap` when 10 lands, and iron/gold/chain tools & armor → nuggets when 10's nugget lands. Rejects food/sand/cobblestone/wood. `_lit` id-swap per 06 §5.5, `Emit 13`. Armorer job site.

### 7.7 smoker (177) / smoker_lit (178)
- Furnace variant: **cook time ×0.5** (as above); **input filter** = food-smelt class only: `porkchop`307-source `porkchop`(306)→`cooked_porkchop`(307), `beef`(308)→`cooked_beef`(309), `chicken`(310)→`cooked_chicken`(311), `mutton`(312)→`cooked_mutton`(313), `potato`(316)→`baked_potato`(317). Rejects ores/blocks. `_lit` id-swap, `Emit 13`. Butcher job site.

### 7.8 fletching_table (179)
- Fletcher job site. **No functional UI** (MC parity). Fuel 300 t. Cube with a fletching-diagram top texture.

### 7.9 hay_bale (180)
- Storage block: crafts from 9 `wheat` (336); 1 hay_bale → 9 wheat (reverse). Column-textured (bound-straw sides, cut-ends top/bottom).
- **Fall-damage dampen**: landing on it multiplies computed fall damage ×0.2 (AMENDS 03 §12.2). Flammable — 15-FIRE registers it in the flammability table (this file only sets the `flammable` flag; spread behavior is 15's). Decorative in villages (farm/plaza stacks).

---

## 8. Villagers: entity, professions, schedule, claims {#8-villagers}

### 8.1 Stat block (05 §2 format)

| Stat | villager |
|---|---|
| HP | 20 |
| AABB (w×h) | 0.6 × 1.95 (baby 0.3 × 0.975) |
| Natural armor | 0 |
| MC speed attr | 0.5 |
| Walk / flee b/s (approx) | 2.4 (0.12 b/t) / 4.0 flee-from-hostile (0.20) |
| Attack | none (villagers never attack) |
| Detection (flee) | hostiles within 8 (zombie/zombie_villager/spider/skeleton/creeper) |
| XP on death | 0 |
| Drops | none |
| Burns in daylight | no |
| Persistent | yes (never despawns; exempt from 05 §4) |

Persisted fields (extend 05's mob save; AMENDS 01 §16 in header): `profession, level(1–5), villagerXP, trades[](§9), workstation:[x,y,z]|null, bed:[x,y,z]|null, homeVillage:anchorKey, foodPoints, willing, restocksToday, lastRestockDay, curedDiscount:int, isBaby, ageTicks`.

### 8.2 Professions & workstation blocks

Employed profession ⇔ its job-site block. A village's stampable job sites (from §4 templates): composter, lectern, blast_furnace, smoker, fletching_table, plus (foreign, if built) grindstone/smithing_table/brewing_stand:

| Profession | Workstation block | Trades §9 | Robe tint (render) |
|---|---|---|---|
| farmer | `composter` (172) | §9.2 | brown |
| librarian | `lectern` (174) | §9.3 | white/cream |
| cleric | `brewing_stand` (09) | §9.4 | purple |
| armorer | `blast_furnace` (175) | §9.5 | black/dark |
| toolsmith | `smithing_table` (10) | §9.6 | dark |
| weaponsmith | `grindstone` (08) | §9.7 | dark |
| butcher | `smoker` (177) | §9.8 | white apron |
| fletcher | `fletching_table` (179) | §9.9 | tan |
| **unemployed** | none | none | green nomad |
| **nitwit** | none — never employs | none | green + purple sash |

> Adaptation / §OUT: fisherman(barrel), shepherd(loom), mason(stonecutter), cartographer(cartography table), leatherworker(cauldron) are **not** implemented (their workstations aren't in the registry). Barrels remain storage-only. Nitwits are ~1 in 20 of gen villager records (§8.6); they wander and sleep but never claim a job site.

### 8.3 Workstation claim & loss

- An **unemployed** adult, during the WORK window (§8.4), pathfinds to the nearest **unclaimed** job-site POI inside its `homeVillage.bounds` (from `villageMeta.stations`), and on reaching it (≤1.5 blocks) **claims** it: `station=pos`, `stations[i].claimedBy=id`, profession = the block's profession, level 1, generate 2 novice trades (§9.1). A green-swirl claim flash (particles, cosmetic) plays.
- **Loss**: if the claimed block is broken/removed (setBlock hook on those ids inside bounds, §2.7): if the villager has **never traded** → revert to unemployed (profession cleared, can re-employ). If it **has traded** (locked) → keep profession + trades but stop restocking/leveling until it reclaims a matching job site (MC-exact "job locked after first trade").
- Player-placed job sites inside `bounds` append a `stations` entry (§2.7) → an unemployed villager can take the new job. This is the standard "trap a villager with a lectern" workflow.

### 8.4 Daily schedule (3 phases + wake) — tied to 04's `worldTime`

Let `T = worldTime mod 24000` (04 owns the counter; dawn `T=0`, noon 6000, dusk 12000, midnight 18000). Each tick the active-goal selector (05 §6) picks the schedule goal for the current window:

| Window | `T` range | Goal (adult, employed) | Nitwit / unemployed |
|---|---|---|---|
| WAKE | 0 – 2000 | leave bed, wander near home | wander |
| WORK | 2000 – 9000 | go to `workstation`, loiter ≤2 blocks, restock (§9.10) | wander village |
| GATHER | 9000 – 12000 | go to `bellPos` (meeting point), socialize (mill within 6 blocks) | gather too |
| SLEEP | 12000 – 24000 | go to claimed `bed`, occupy it (sleep) | sleep in a bed |

- **Sleep**: on reaching its bed foot, the villager sets `bed_block.occupant=id` (AMENDS 06 §5.7), stops moving, plays the lying pose (render), and its effect/AI ticks idle until WAKE. A villager with no claimed bed tries to claim an **unclaimed** bed in `bounds` at first SLEEP (this is also the breeding population check, §10).
- If the phase target is unreachable (path fail) the villager falls back to Wander within `bounds` (leashed — never leaves `villageBounds`; §2.2).
- Babies have no work/sleep obligations beyond following adults; they wander/play and sleep opportunistically.

### 8.5 Wander & flee AI (05 goal list)

```
Villager goals (priority: goal — flags):
  0 Swim(MOVE)
  1 FleeHostile(MOVE)        // nearest zombie/zombie_villager/spider/skeleton/creeper ≤ 8 → run to bellPos/indoorAnchor at flee speed
  2 Panic(MOVE)              // on hurt (hurtTimer>0): run away at flee speed 100 ticks
  3 ScheduleGoal(MOVE)       // §8.4 window target (workstation / bellPos / bed)
  4 Breed(MOVE)              // §10, love mode
  5 Wander(MOVE)             // leashed to villageBounds
  6 LookAtTrader(LOOK)       // face the player currently trading with it
  7 LookAtPlayer(LOOK,8)  8 IdleLook(LOOK)
```
Villagers never target or attack. Iron golems and player defense handle hostiles. Fleeing villagers head for the nearest `villageMeta.indoorAnchor` (a roofed interior cell) or `bellPos` if none reachable — the classic "villagers pile into a house at night" behavior emerges from this + SLEEP.

### 8.6 Spawn records (gen → runtime)

`layoutFor` (§3.5) emits villager spawn records into the chunk `spawns` array (02 §13.2; type extended to `"villager"`). Count = `min( bedsInVillage − 1, jobSitesInVillage + 2 )` (≥1 fewer than beds so breeding has headroom, §10). Placement: standable cells within 6 blocks of `bellPos`. Each record: `{ type:"villager", x, y, z, profession:"unemployed", nitwit:(posHash(subSeed("detail"),x,y,z) < 0.05) }`. Villagers claim jobs/beds at runtime (§8.3/§8.4) — gen never pre-assigns, so a village fills in correctly regardless of load order. Iron golems are **not** gen-spawned (runtime threshold, §11).

---

## 9. Trading {#9-trading}

### 9.1 Trade model

- RMB a non-baby, non-fleeing villager → open the **trade screen** (a 06 §15.3-family container UI: left = offer list with cost slot(s) + result, right = the player inventory; 03 §16.1 routes the interact). Baby/golem/zombie_villager RMB does nothing tradewise.
- A **trade** = `{ buyA:{id,count}, buyB:{id,count}|null, sell:{id,count,tags?}, maxUses, uses, xp, priceMult, demand, specialPrice }`. `buyA/buyB` are what the villager **wants** (player pays); `sell` is what the **player receives**. Enchanted results carry `tags` from 08.
- **Levels & thresholds** (Java-exact): Novice 0 XP, Apprentice 10, Journeyman 70, Expert 150, Master 250. On each trade the villager gains that trade's `xp`; crossing a threshold **levels up** (badge changes, +2 new trades unlock from the next tier, restock, a level-up particle burst + `villager.trade` up-chime). A village generates each tier's trades by picking (per MC) **2 of that tier's pool** when the tier unlocks (deterministic from the villager's own seed).
- `maxUses` per trade (from tables, default 12–16); a trade **locks** (greyed, red slot) once `uses==maxUses`, until the next restock (§9.10).

### 9.2 Farmer (composter) — Java 1.20, trimmed

| Lvl | Villager wants | Player receives | maxUses | XP | mult |
|---|---|---|---|---:|---:|
| Novice | 20 `wheat`(336) | 1 emerald | 16 | 2 | .05 |
| Novice | 26 `potato`(316) | 1 emerald | 16 | 2 | .05 |
| Novice | 22 `carrot`(315) | 1 emerald | 16 | 2 | .05 |
| Novice | 1 emerald | 6 `bread`(305) | 16 | 1 | .05 |
| Apprentice | 6 `pumpkin`(44) | 1 emerald | 12 | 10 | .05 |
| Apprentice | 1 emerald | 4 `apple`(304) | 16 | 5 | .05 |
| Journeyman | 1 emerald | 3 `baked_potato`(317) `(approx sub for cookie/melon)` | 12 | 20 | .05 |
| Expert | 3 emerald | 3 `golden_carrot`(377, 09) | 12 | 15 | .05 |
| Master | 3 emerald | 3 `golden_carrot`(377) `(approx — MC master also sells glistering melon; cut)` | 12 | 30 | .05 |

Trims: beetroot, pumpkin_pie, cookie, melon, suspicious_stew, cake, glistering_melon — all CUT (no such items). If 09 unbuilt, drop the golden_carrot rows (Expert/Master then fall back to the pumpkin/apple pool).

### 9.3 Librarian (lectern) — the enchanted-book source

| Lvl | Villager wants | Player receives | maxUses | XP | mult |
|---|---|---|---|---:|---:|
| Novice | 24 `paper`(340) | 1 emerald | 16 | 2 | .05 |
| Novice | 9 emerald | 1 `bookshelf`(50) | 12 | 1 | .05 |
| **Novice** | **5–64 emerald + 1 `book`(341)** | **1 `enchanted_book`(346)** | 12 | 1 | .2 |
| Apprentice | 4 `book`(341) | 1 emerald | 12 | 10 | .05 |
| **Apprentice** | **5–64 emerald + 1 `book`** | **1 `enchanted_book`** | 12 | 5 | .2 |
| Journeyman | 1 emerald | 4 `glass`(31) | 12 | 10 | .05 |
| **Journeyman** | **5–64 emerald + 1 `book`** | **1 `enchanted_book`** | 12 | 10 | .2 |
| Expert | 5 emerald | (no compass/clock — see trim) | — | 15 | .05 |
| **Master** | **5–64 emerald + 1 `book`** | **1 `enchanted_book`** | 12 | 30 | .2 |

**Enchanted-book generation (contract with 08):** each `enchanted_book` trade rolls **a random enchanted book** via 08 §10's `randomEnchantedBook(rng, level, treasureAllowed=true)` (08's helper owns the enchant count — a book may end up with more than one enchant) where `level` = `5 + rngInt(15)` (5–19 base, per wiki) and `rng = splitmix32(villagerSeed ^ tradeSlot)`. Treasure IS allowed → **librarians are a survival source of Mending** (08 §5.1 id 19). Emerald cost = `2 + 3·enchLevel`, doubled for treasure enchants, clamped **5–64** (Java-exact). The book carries `tags.enchants` exactly as 08 defines (§1); the result stack is `{id:346, count:1, tags:{enchants:[{id,lvl}]}}`.

Trims: `lantern`, `compass`, `clock`, `name_tag`, `book_and_quill`(written book), `ink_sac` — CUT (not in registry). Expert's non-book trade is dropped (its only value was a compass/clock); the tier still offers its enchanted-book slot.

### 9.4 Cleric (brewing_stand) — potion/redstone economy

| Lvl | Villager wants | Player receives | maxUses | XP | mult |
|---|---|---|---|---:|---:|
| Novice | 32 `rotten_flesh`(314) | 1 emerald | 16 | 2 | .05 |
| Novice | 1 emerald | 2 `redstone`(342) | 12 | 1 | .05 |
| Apprentice | 3 `gold_ingot`(324) | 1 emerald | 12 | 10 | .05 |
| Apprentice | 1 emerald | 1 `lapis_lazuli`(343) | 12 | 5 | .05 |
| Journeyman | 4 emerald | 1 `glowstone`(32) | 12 | 10 | .05 |
| Expert | 9 `glass_bottle`(370, 09) | 1 emerald | 12 | 30 | .05 |
| **Expert** | **5 emerald** | **1 `ender_pearl`(334)** | 12 | 15 | .05 |
| **Master** | **1 emerald** | **4 `redstone`(342)** | 12 | 30 | .05 |
| Master | 22 `nether_wart`(10) | 1 emerald | 12 | 30 | .05 |

The bold Master row (bulk redstone sell) is base-only and **not gated on 10**, so the Master tier is never empty when E6 runs before E7 (the nether_wart buy is the 10-gated bonus, dropped if 10 is unbuilt). This is the file's economy anchor: cleric **sells redstone, lapis, glowstone, and ender pearls** for emeralds (all four the task requires; glowstone is the base-game **block** 32, which MC's cleric trades — not "glowstone dust," an item owned by 10). Ender pearls from the cleric are the pre-Naturally-farmable route to Eyes of Ender (11 needs them). Trims: `rabbit's_foot`, `turtle_scute`, `bottle_o'_enchanting` (no XP-bottle item) — CUT. If 09 unbuilt, drop the glass_bottle buy row; if 10 unbuilt, drop the nether_wart row (the cleric still has a populated Master tier via the ungated bulk-redstone sell above).

### 9.5 Armorer (blast_furnace)

| Lvl | Villager wants | Player receives | maxUses | XP |
|---|---|---|---|---:|
| Novice | 15 `coal`(319) | 1 emerald | 16 | 2 |
| Novice | 5 emerald | 1 `iron_helmet`(296) | 12 | 1 |
| Novice | 9 emerald | 1 `iron_chestplate`(297) | 12 | 1 |
| Novice | 7 emerald | 1 `iron_leggings`(298) | 12 | 1 |
| Novice | 4 emerald | 1 `iron_boots`(299) | 12 | 1 |
| Apprentice | 4 `iron_ingot`(322) | 1 emerald | 12 | 10 |
| Apprentice | 36 emerald | 1 `bell`(171) | 12 | 5 |
| Journeyman | 1 `lava_bucket`(287) | 1 emerald | 12 | 20 |
| Journeyman | 1 `diamond`(325) | 1 emerald | 12 | 20 |
| Expert | 19–33 emerald | 1 enchanted `diamond_leggings`(302) | 3 | 15 |
| Master | 13–27 emerald | 1 enchanted `diamond_boots`(303) | 3 | 30 |
| Master | 21–35 emerald | 1 enchanted `diamond_helmet`(300) | 3 | 30 |

Trims: chainmail armor + shield — CUT (no items). Enchanted diamond armor uses 08's `selectEnchants(rng, ARMOR, 5–19, treasure=false)`; if 08 unbuilt, sell plain diamond armor at the same cost (state in DEVIATIONS).

### 9.6 Toolsmith (smithing_table)

| Lvl | Villager wants | Player receives | maxUses | XP |
|---|---|---|---|---:|
| Novice | 15 `coal`(319) | 1 emerald | 16 | 2 |
| Novice | 1 emerald | 1 `stone_axe`/`stone_shovel`/`stone_pickaxe`/`stone_hoe`(262–265) | 12 | 1 |
| Apprentice | 4 `iron_ingot`(322) | 1 emerald | 12 | 10 |
| Apprentice | 36 emerald | 1 `bell`(171) | 12 | 5 |
| Journeyman | 30 `flint`(326) | 1 emerald | 12 | 20 |
| Journeyman | 6–20 emerald | 1 enchanted `iron_pickaxe`(267) | 3 | 10 |
| Journeyman | 4 emerald | 1 `diamond_hoe`(280) | 3 | 10 |
| Expert | 1 `diamond`(325) | 1 emerald | 12 | 30 |
| Expert | 17–31 emerald | 1 enchanted `diamond_axe`(278) | 3 | 15 |
| Master | 18–32 emerald | 1 enchanted `diamond_pickaxe`(277) | 3 | 30 |

Enchanted tools via 08 `selectEnchants(rng, tool, 5–19, treasure=false)`. Fallback: plain tools if 08 unbuilt.

### 9.7 Weaponsmith (grindstone)

| Lvl | Villager wants | Player receives | maxUses | XP |
|---|---|---|---|---:|
| Novice | 15 `coal`(319) | 1 emerald | 16 | 2 |
| Novice | 3 emerald | 1 `iron_axe`(268) | 12 | 1 |
| Novice | 7–21 emerald | 1 enchanted `iron_sword`(266) | 3 | 1 |
| Apprentice | 4 `iron_ingot`(322) | 1 emerald | 12 | 10 |
| Apprentice | 36 emerald | 1 `bell`(171) | 12 | 5 |
| Journeyman | 24 `flint`(326) | 1 emerald | 12 | 20 |
| Expert | 1 `diamond`(325) | 1 emerald | 12 | 30 |
| Expert | 17–31 emerald | 1 enchanted `diamond_axe`(278) | 3 | 15 |
| Master | 13–27 emerald | 1 enchanted `diamond_sword`(276) | 3 | 30 |

### 9.8 Butcher (smoker)

| Lvl | Villager wants | Player receives | maxUses | XP |
|---|---|---|---|---:|
| Novice | 14 `chicken`(310, raw) | 1 emerald | 16 | 2 |
| Novice | 7 `porkchop`(306, raw) | 1 emerald | 16 | 2 |
| Apprentice | 15 `coal`(319) | 1 emerald | 16 | 2 |
| Apprentice | 1 emerald | 8 `cooked_chicken`(311) | 16 | 5 |
| Apprentice | 1 emerald | 5 `cooked_porkchop`(307) | 16 | 5 |
| Journeyman | 10 `beef`(308, raw) | 1 emerald | 16 | 20 |
| Journeyman | 7 `mutton`(312, raw) | 1 emerald | 16 | 20 |
| Expert | 1 emerald | 4 `cooked_beef`(309) `(approx sub for dried-kelp buy)` | 12 | 15 |
| Master | 1 emerald | 4 `cooked_mutton`(313) `(approx sub for sweet-berries buy)` | 12 | 30 |

Trims: raw_rabbit, rabbit_stew, dried_kelp_block, sweet_berries — CUT; Expert/Master substitute cooked-meat sells so the butcher can still reach Master.

### 9.9 Fletcher (fletching_table)

| Lvl | Villager wants | Player receives | maxUses | XP |
|---|---|---|---|---:|
| Novice | 32 `stick`(318) | 1 emerald | 16 | 2 |
| Novice | 1 emerald | 16 `arrow`(282) | 12 | 1 |
| Novice | 10 `gravel`(19) + 1 emerald | 10 `flint`(326) | 12 | 1 |
| Apprentice | 26 `flint`(326) | 1 emerald | 12 | 10 |
| Apprentice | 2 emerald | 1 `bow`(281) | 12 | 5 |
| Journeyman | 14 `string`(327) | 1 emerald | 16 | 20 |
| Expert | 24 `feather`(328) | 1 emerald | 16 | 30 |
| Expert | 7–21 emerald | 1 enchanted `bow`(281) | 3 | 15 |
| Master | 2 emerald + 5 `arrow`(282) | 5 `tipped_arrow`(378, 09) | 12 | 30 |

Trims: crossbow, tripwire_hook — CUT. Enchanted bow via 08; tipped arrows via 09 (random brewable effect, 09 §15); drop those rows if 08/09 unbuilt.

### 9.10 Pricing: demand, reputation, restock

- **Base price** is the table value. **Effective cost** = `clamp( base + demandSurcharge + reputationAdj, 1, 64 )` per emerald cost slot (never below 1, never above the stack, MC-exact clamps).
- **Demand** (per trade): `demand` rises when the trade is used a lot, decays otherwise. On restock: `demand = demand + (uses − maxUses/2)` clamped `≥ 0`; `demandSurcharge = round( base · priceMult · demand )`. Popular trades creep up in price; unused ones settle back to base. (`priceMult` = the table's 0.05/0.2.)
- **Reputation** (per player, per `homeVillage`, one signed int, simplified gossip): trading nudges it **+1** (min-major on first trade of a session), **cured a villager here → +20** (major positive, §11.5), **hit a villager → −25**, **hit/killed an iron golem → −25**, **killed a villager → −? (large negative)**. `reputationAdj = −round( base · priceMult · reputation )` for **sell** (player-receives) trades and the mirror for buy trades: positive reputation **lowers** what the player pays. Clamp reputation `[−30, +30]`.

> Adaptation / §OUT: this is a **two-number** stand-in (per-trade demand + per-village reputation) for MC's full gossip graph (major/minor positive/negative/trading/golem gossips with per-tick decay). Hero of the Village is **not** modeled — the only positive-reputation source strong enough to slash prices is **curing a zombie villager** (§11.5), which is the intended, faithful discount path.

- **Restock**: up to **2× per day**. A villager restocks when, during the WORK window, it reaches its workstation and `restocksToday < 2` and `worldDay > lastRestockDay || restocksToday==0`: reset every trade's `uses=0`, recompute demand/price, `restocksToday++`, `lastRestockDay=worldDay`. A jobless-but-locked villager (lost its station) cannot restock until it reclaims one.

---

## 10. Breeding & babies {#10-breeding-and-babies}

Reconciles with 05 §10's breeding scaffold (love mode, kiss timer, baby entity) with villager-specific gates:

1. **Willingness.** A villager becomes `willing` when **either** (a) it holds `foodPoints ≥ 12`, or (b) it completes a trade that unlocks a **new** trade tier (MC-exact "trade willingness"). `foodPoints` accrue via a **narrow food-pickup exception** (general villager item pickup is §OUT): a villager within 3 blocks of a dropped `bread`/`carrot`/`potato`/`wheat` item entity collects it during WAKE/GATHER — `bread +3`, `carrot/potato +1`, `wheat +1` (`(approx)` — MC villagers don't eat wheat, but with farmer crop-tending cut, wheat is the player's easy willingness feed). This is the intended "throw bread at villagers to breed them" loop.
2. **Population cap = valid beds.** Two willing adults may breed only if `livingVillagers(homeVillage) < validBeds(homeVillage)` **and** an unclaimed bed exists in `bounds`. This is checked at love-mode start; if the village is full, feeding does nothing (hearts don't appear).
3. **Pairing & kiss** (05 §10 flow): willing adults within 8 blocks path together at ×1.1; within 1.5 blocks for **60 ticks** → spawn a **baby villager** at the midpoint, drop **1–7 XP** orb, both parents `willing=false`, consume `foodPoints −= 12` (or clear the trade-willing flag), `breedCooldown = 6000` ticks.
4. **Baby growth.** `ageTicks` counts down from **6000** (5 min, matching 05's baby-maturity adaptation; MC 20 min). Feeding a baby its food −10% remaining (05 §10). On maturity → unemployed adult that will claim a job site (§8.3) next WORK window. Babies follow adults (05 FollowParent), never trade, never claim.

The E6 gate "zombie villager cured, golem defends, village breeds" is satisfied by (1)+(2): a walled village with spare beds and a handful of thrown bread grows its population until beds are full.

---

## 11. Iron golem & zombie villager (curing) {#11-golem-and-zombie-villager}

### 11.1 Iron golem stat block (05 §2 format)

| Stat | iron_golem |
|---|---|
| HP | 100 |
| AABB (w×h) | 1.4 × 2.7 |
| MC speed attr | 0.25 → walk 2.5 b/s (0.125 b/t) |
| Attack dmg (Normal) | 7 + randInt(15) → **7–21** `(approx of MC 7.5–21.5)` |
| Attack reach | 2.4 (center-to-center) |
| Attack cooldown | 10 ticks |
| Knockback on hit | strong toss: target `vy += 0.4`, horizontal push ×2 the base 0.4 |
| Knockback resistance | **1.0** (immune — AMENDS 05 §2) |
| Fall damage | **immune** (MC-exact) |
| Detection | hostiles within 16 of the golem or any villager in `homeVillage` |
| XP on death | 0 |
| Drops | 3–5 `iron_ingot`(322) + 0–2 `poppy`(62) |
| Burns in daylight | no |
| Persistent | yes (never despawns) |

Render: a large 2-armed box golem (humanoid frame scaled up, vine-streak texture), per 05 §16's box-model conventions — this file only registers dimensions; 05/16 own the mesh/anim/sound.

### 11.2 Spawn (simplified vs MC gossip/panic)

Per `homeVillage`, checked every 200 ticks during daytime:

```
if !villageMeta.golem.alive and golem.respawnTimer <= 0
   and population(adults with a claimed bed) >= 5:
     find a standable cell within 16 blocks of bellPos (05 §7 standable test)
     spawn iron_golem there;  villageMeta.golem.alive = true
```
On golem death: `alive=false`, `respawnTimer = 6000` (5 min), drop table above. **One golem per village.** 

> Adaptation / §OUT: MC spawns golems from villager **gossip + panic** (5 villagers within a box, ≥20 s since last, each villager rolling) and additionally on player-built T-shape + pumpkin. VoxelCraft uses the flat **population ≥ 5 → 1 golem** rule and **no** player-built (pumpkin-golem) construction. State this in DEVIATIONS if the pumpkin-build is later requested.

### 11.3 Golem defense AI (05 goal list)

```
Iron golem goals:
  0 Swim(MOVE)
  1 DefendVillage(MOVE)   // target = nearest hostile ∈ {zombie, zombie_villager, spider, skeleton}
                          //   within 16 of golem OR any homeVillage villager; NOT creeper (avoid boom)
  2 MeleeAttack(MOVE)     // reach 2.4, dmg 7–21, cooldown 10; on hit apply the toss knockback
  3 ReturnToVillage(MOVE) // if > bounds+16 from center, path back (leashed)
  5 Wander(MOVE)          // slow patrol within bounds
  7 LookAtVillager(LOOK) 8 IdleLook(LOOK)
```
- **Neutral to the player always** (§OUT: no player-aggro/reputation retaliation). Attacking the golem does not make it fight back at the player; it only lowers village reputation (§9.10).
- Does **not** target creepers (MC-exact — prevents self-destructive village explosions).
- Poppy-offering idle animation: **§OUT** (drops still include poppy for flavor).

### 11.4 Zombie villager (mob variant)

Stat block = zombie (05 §2: HP 20, AABB 0.6×1.95, dmg 3, reach 2.0, cd 20, detection 35, burns in daylight, baby 5%) **plus** a `profession` field and a green-tinged villager-zombie texture (05 §16 registers the variant). Goals identical to zombie (targets player/villager/golem per AMENDS 05 §6). Two sources:
1. **Natural**: 5% of runtime-spawned zombies (AMENDS 05 §3.2, already in header) → `zombie_villager`, random profession (or unemployed).
2. **Conversion**: when a zombie kills a villager, **Normal difficulty = 50% chance** the villager is replaced by a `zombie_villager` carrying its profession, level, and trades (MC-exact; Easy 0%, Hard 100% — we are hard-coded Normal). Otherwise the villager dies normally.

Zombie villagers drop 0–2 `rotten_flesh` (like zombies); they do not drop their trades.

### 11.5 Curing procedure (uses 09 + 06/09 items)

1. **Weaken**: a **Splash Potion of Weakness** (09 item 372, `tags.potionId="weakness"`) applied to the zombie villager (thrown/AoE, 09 §13) → gives it Weakness (09 §3.4 effect) and sets it `weakened=true` while the effect lasts.
2. **Feed**: RMB the weakened zombie villager with a **`golden_apple`** (09 item 376; regular, **not** enchanted — enchanted golden apple is §OUT of 09) → consume 1 apple, begin conversion: `converting=true`, `convertTimer = 3600 + rngInt(2401)` (**3600–6000 ticks = 3–5 min**, MC-exact), spawn red-swirl particles and a low shudder (`zombie_villager.converting` sound), and it **shakes** (05 §16 render). If not weakened, the golden apple does nothing.
3. **Convert**: while `converting`, the mob keeps zombie AI (still burns in sun, still attackable — protect it) and decrements `convertTimer`. At 0 → replace with a **villager**: same `profession`, `level`, `villagerXP`, `trades` (or unemployed if the zombie had none), `curedDiscount += 1`, play `zombie_villager.cure` (a bright confirmation chime, §12.3) + a green particle burst.
4. **Discount**: a cured villager permanently **reduces every trade's emerald cost** by a large per-cure amount: `specialPrice = − max(1, round(base · min(0.30·curedDiscount, 0.85)))` applied on top of §9.10 pricing (floored so costs never drop below 1). Curing here also grants **+20 village reputation** for the curing player (§9.10). Successive cures deepen the discount (up to the 85% cap). This is VoxelCraft's only "trades get dramatically cheaper" mechanic (Hero of the Village §OUT).

> Adaptation: MC accelerates curing when the zombie villager is near a bed + iron bars and stacks the discount via the gossip system. We keep a flat 3–5 min timer and a simple `curedDiscount` counter — the outcome (cheap trades from a cured trader) is identical in feel.

---

## 12. Registry / texture / sound tables {#12-registry-texture-sound}

### 12.1 Block registry rows (extend 06 §2 + §3)

Gameplay (06 §2): all new blocks `Tool` and `Tier` as noted; **Drops = self** unless stated.

| ID | Name | Hard | Blast | Tool | Tier | Drops | Notes |
|---:|---|---:|---:|---|---|---|---|
| 170 | dirt_path | 0.6 | 0.6 | shovel | — | 1 dirt | shovel-made; no block-item |
| 171 | bell | 5.0 | 5.0 | pickaxe | wood | self | interactable |
| 172 | composter | 0.6 | 0.6 | axe | — | self | fill 0–8; fuel 300 t |
| 173 | barrel | 2.5 | 2.5 | axe | — | self + contents spill | 27-slot; fuel 300 t |
| 174 | lectern | 2.5 | 2.5 | axe | — | self | librarian site; fuel 300 t |
| 175 | blast_furnace | 3.5 | 3.5 | pickaxe | wood | self + contents | armorer site |
| 176 | blast_furnace_lit | 3.5 | 3.5 | pickaxe | wood | 1 blast_furnace + contents | id-swap |
| 177 | smoker | 3.5 | 3.5 | pickaxe | wood | self + contents | butcher site |
| 178 | smoker_lit | 3.5 | 3.5 | pickaxe | wood | 1 smoker + contents | id-swap |
| 179 | fletching_table | 2.5 | 2.5 | axe | — | self | fletcher site; fuel 300 t |
| 180 | hay_bale | 0.5 | 0.5 | — | — | self | fall-dmg ×0.2; flammable (15) |
| 181 | emerald_ore | 3.0 | 3.0 | pickaxe | iron | 1 emerald | §6.2 |
| 182 | emerald_block | 5.0 | 6.0 | pickaxe | iron | self | §6.2 |

Light/render/physics (06 §3): all `Solid yes` except `dirt_path` (custom 15/16 box, `Solid yes`, full collision). Emissions: all 0 except `blast_furnace_lit`/`smoker_lit` = **13**. Opac `O` (opaque) for all except `composter` (custom box, `T`), `bell` (`T`, custom), `lectern`/`fletching_table` (custom, `T`). Pass `op` (cube/custom-op) for all. Shapes: `dirt_path` 15/16 slab; `bell` custom bell+bar; `composter` 14/16 hollow box; `barrel`/`blast_furnace`/`smoker` cube (top/side/front textures); `lectern` 12/16 slant desk; `fletching_table`/`hay_bale`/`emerald_ore`/`emerald_block` cube. `interactable` flag on bell, composter, barrel, blast_furnace(+lit), smoker(+lit) (03 §16.1). Grav — for all.

### 12.2 Texture recipes (06 §4 vocabulary — one line each)

| Surface | Recipe |
|---|---|
| dirt_path top | `noise(#8a7b52, 8)` packed dirt + 1px `#6f6238` worn ring inset |
| dirt_path side | dirt (06) top 1px `grass_block`-edge `#6a8a3f` overhang |
| bell | `rings(#d9b53a gold, #a8842a)` bell body + `#5a4020` wood beam cap; small `#3a2c14` mount pegs |
| composter side | `oak_planks`(06) frame + inner `#5a4a2a` compost, level-tinted greener as fill rises |
| composter top | open rim `oak_planks` + `#3f5a20` compost fill square sized to level 0–8 |
| barrel top | `rings(#8a6a3a, #6f5330)` barrel lid + 2px `#3a2c18` iron band; side = vertical `oak` staves + 2 bands |
| lectern | `spruce`/`oak_planks` slanted top + `#e9e9e9` page pixels + `#6b2f7a` book spine |
| blast_furnace front | `furnace`(06) recipe darker `#3a3a3a` + `#c85a1a` lit maw (lit variant emissive) + top vent rows |
| smoker front | `spruce_log`(06) sides + `#2a1c10` scorched front + `#c85a1a` lit vents (lit emissive) |
| fletching_table top | `oak_planks` + `#3a2c18` fletching saw-tooth diagram + 2px flint `#4a4a4a` |
| hay_bale | `noise(#c8a83a, 10)` straw side with vertical `#8a6a20` binding lines; top = cut-straw swirl |
| emerald_ore | `stone`(06) base + `speckle(#3a3a3a, 6)` + 5–7 `#17c96a`/`#0f8a48` emerald facets |
| emerald_block | `blotch(#20c070, #17a058, 8)` faceted green mineral + 1px `#e9fff2` highlights |

### 12.3 Sound events (registry for 16-AUDIO — names final; 16 owns synthesis)

16 already anticipates villager / iron golem / bell (16 §"Villager (12)", "Iron golem (12)", `village.bell` (12)); this table pins the event keys 12 emits. 16 owns all synthesis; villages play **no** audio beyond emitting these through 16's dispatcher.

| Event key (16 namespace) | Vanilla analogue | Trigger |
|---|---|---|
| `mob.villager.idle` | entity.villager.ambient | idle "hrmm", 1/(300–500 ticks) per villager (16 §3.4's villager idle timbre) |
| `mob.villager.yes` | entity.villager.yes | trade completed / level-up (rising chime — 16 §3.4 "trade-yes") |
| `mob.villager.no` | entity.villager.no | trade rejected / locked slot clicked (16 §3.4 "trade-no") |
| `mob.villager.trade` | entity.villager.trade | trade screen opened |
| `mob.villager.hurt` | entity.villager.hurt | villager damaged |
| `mob.villager.death` | entity.villager.death | villager dies |
| `mob.iron_golem.step` | entity.iron_golem.step | per footfall (accumulator, 16 owns) |
| `mob.iron_golem.attack` | entity.iron_golem.attack | melee swing connects |
| `mob.iron_golem.hurt` | entity.iron_golem.hurt | golem damaged |
| `mob.iron_golem.death` | entity.iron_golem.death | golem dies |
| `village.bell` | block.bell.use | bell rung (already in 16 §3.5 `village.bell`) |
| `block.composter.fill` | block.composter.fill | successful compost (+layer) |
| `block.composter.ready` | block.composter.ready | reached level 8 / harvested bone_meal |
| `block.barrel.open` / `block.barrel.close` | block.barrel.open/close | barrel UI open/close |
| `block.workstation.claim` | block.*.use (generic) | villager claims a job site (§8.3) |
| `entity.zombie_villager.converting` | entity.zombie_villager.converting | during cure (low shudder loop) |
| `entity.zombie_villager.cure` | entity.zombie_villager.cured | cure completes (bright confirm) |

---

## 13. Acceptance checklist {#13-acceptance-checklist}

Deterministic worldgen (E6 gate core)
- [ ] A village generates identically whether its anchor chunk is visited first or last: stamp the same 11×11 chunk region in two visit orders → byte-identical `blocks`/`states` inside `villageBounds` (§2.4 invariant).
- [ ] A village straddling ≥ 4 chunk borders assembles seamlessly (roads/buildings continuous, no half-buildings, no double-stamps).
- [ ] Two villages are never closer than 8 chunks; every village sits in plains/savanna/desert/taiga only; none spawn below Y 64 or in water (§2.1).
- [ ] Emerald ore appears **only** in mountain biomes, Y ≥ ~92 stone, as rare single blocks; drops 1 emerald with an iron pickaxe; absent everywhere else (§6.1).

Buildings & blocks
- [ ] Every village has a well, a bell at the meeting point, ≥ 2 small houses, ≥ 1 farm; biome palette matches §5 (desert = sandstone/flat/sandstone-paths; taiga = spruce+cobble+snow caps).
- [ ] Buildings carry their fixtures: beds occupy-able, doors open, torches lit, workstations placed; a smithy has grindstone+smithing_table+blast_furnace+chest+lava; a library has a lectern; a church has a brewing stand (or `crafting_table` fallback if 08/09/10 unbuilt, logged in DEVIATIONS).
- [ ] New blocks behave: shovel makes dirt_path (reverts under a placed block); composter fills 0→8 and yields bone_meal; blast_furnace smelts iron 2× (rejects food); smoker cooks food 2× (rejects ore); barrel opens under a block; hay_bale cuts fall damage to 20%.

Villagers, schedule, trading
- [ ] Gen villagers spawn unemployed near the bell; an unemployed adult claims an unclaimed job site during the WORK window and gains 2 novice trades; ~1/20 are nitwits that never employ.
- [ ] Schedule tracks 04's `worldTime`: villagers work at stations (≈T 2000–9000), gather at the bell (≈9000–12000), and sleep in claimed beds at night (occupant set), fleeing indoors from hostiles.
- [ ] **A librarian sells enchanted books**: 5–64 emeralds + 1 book → a random enchanted book via 08 §10 (enchant count owned by 08's helper; treasure allowed → Mending obtainable); the emitted stack is `{id:346, tags:{enchants:[…]}}` per 08 §1.
- [ ] Cleric sells redstone, lapis, glowstone (block 32) and ender pearls for emeralds; farmer buys wheat/potato/carrot and sells golden carrots at master; smiths sell (enchanted) iron/diamond gear; butcher/fletcher tables match §9 quantities.
- [ ] Trades level Novice→Master at 0/10/70/150/250 XP; locked trades reopen on restock (≤2×/day at the workstation); heavily-used trades cost more (demand); trading nudges reputation, lowering prices.

Breeding, golem, curing (E6 gate)
- [ ] Feeding villagers bread/carrots (≥12 food points) with a spare bed → hearts, pairing, a baby, 1–7 XP; village won't breed past its bed count; baby matures in 5 min.
- [ ] With ≥ 5 bed-claiming adults, exactly one iron golem spawns near the bell; it targets zombies/spiders/skeletons near villagers (not creepers, not the player), tosses them with heavy knockback, is knockback/fall immune, and drops 3–5 iron + 0–2 poppy; respawns 5 min after death.
- [ ] **A zombie villager is cured**: splash Weakness (09) + a golden apple (09) starts a 3–5 min shaking conversion; it returns as a villager with its profession and a permanent trade discount, granting the curing player +20 village reputation. Natural zombie-kills-villager convert ~50% of the time on Normal.

