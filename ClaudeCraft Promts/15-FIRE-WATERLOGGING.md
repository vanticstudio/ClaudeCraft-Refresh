# 15 — Fire Spread & Waterlogging

This file upgrades two base systems without adding a single block id. **Part A** replaces 06 §5.14's "minimal fire" (id 65) with the full Java 1.20 fire-spread engine: age state, scheduled-tick algorithm, encouragement/flammability registry for the entire block set (base + all expansion files), ignition sources, eternal fire, and a film-safe spread cap. **Part B** introduces waterlogging: bit 7 of the per-voxel `states` byte — reserved globally since 01 §4.2 — marks a non-cube block cell that simultaneously contains a water source. This file owns bit 7 for every block in the game; no other file may assign it.

Fidelity baseline is Java 1.20 with Normal difficulty hard-coded (difficulty id = 2 wherever a formula consumes it). Out of scope, stated once: soul fire, fire charges, campfires, candles, sponges, powder snow, Fire Protection/Flame/Fire Aspect interplay (08's problem), and Bedrock layer semantics.

Dependencies: 10-NETHER declares the `infiniteBurn` registry flag (netherrack, magma block) and ghast fireballs — §4 consumes both. 04 §12 provides `isRainingAt` and lightning strikes. 07/11/12 blocks get fire and waterlogging verdicts here so their files don't have to re-derive them.

---

## Amendments to base files

- **AMENDS 06 §5.14:** Delete the entire "Fire (minimal)" subsection including its `> Adaptation: fire never spreads` note. Fire behavior is now §1–§7 of this file. The §5.14 heading should remain with one line: "Fire — superseded by 15 §1–§7."
- **AMENDS 06 §2 (row id 65):** unchanged drops ("nothing, punch extinguishes instantly"); append to the row's behavior cross-ref: "spread/age per 15".
- **AMENDS 06 §3 (row id 65):** replace "cross + inner quads, 2-frame flicker" with "cross + inner quads, 4-frame animated tile (15 §7)". Emit 15 unchanged.
- **AMENDS 06 §5.6 (TNT ignition source b):** replace "(b) an adjacent `fire` block at the moment fire is placed/updated" with "(b) consumed by fire's burn-out check (15 §2.4; TNT burn odds 100) → becomes primed-TNT entity with the standard 80 t fuse". Sources (a) flint & steel and (c) explosion (fuse 10–30 t) unchanged.
- **AMENDS 06 §1:** add to the block-state bullet: "Bit 7 of `states` is globally reserved: `1` = waterlogged (15 §8). Per-block nibble meanings occupy bits 0–3 only; bits 4–6 remain free."
- **AMENDS 06 §6.1:** replace the final sentence "(doors, ladders, chests, fences are dams; no waterlogging)" with: "Non-waterloggable blocks are dams. Waterloggable blocks (15 §9) are dams while dry, and behave as water **sources** while bit 7 is set (15 §11)."
- **AMENDS 06 §6.2:** extend the level function: `S(cell) = 8 if (states & 0x80) else <existing rules>`; extend `adjacentSources` and `solidOrSource` to count bit-7 cells as sources. Waterlogged cells never run the re-derive branch (they are unconditionally sources); they do run the spread branch on their scheduled ticks (15 §11).
- **AMENDS 06 §6.3:** add row: "Flowing lava touching a **waterlogged** cell → cobblestone in the lava cell; lava **source** adjacent → unchanged (conversion happens only in lava cells). The 'water cell with lava above → stone' row never applies to waterlogged cells (block is preserved; lava rests on top)."
- **AMENDS 06 §6.4 (buckets):** add: "Empty bucket on a targeted **waterlogged** block → clear bit 7, bucket → water_bucket. Water bucket on a targeted dry **waterloggable** block → set bit 7, consume water. Precedence per 15 §13.1."
- **AMENDS 06 §5.11 (farmland moisture):** the "any water within Chebyshev distance 4" test uses `isWaterCell(pos)` = `id == water || (states & 0x80)` (15 §13.4).
- **AMENDS 06 §5.9 (sugar cane):** the "horizontal neighbor of the supporting block is water" test uses the same `isWaterCell` predicate.
- **AMENDS 06 §17:** add to scheduled ticks: "fire (15 §2, every 30 + rand(10) t)". Add to random ticks: "lava — fire creation attempt (15 §4.2)". Add to neighbor-update reactions: "fire survival check (15 §1.3)".
- **AMENDS 01 §5 (registry schema):** the `flammable...` placeholder becomes three concrete fields consumed by 15 §3–§4: `fireEnc: 0` (encouragement / ignite odds), `fireBurn: 0` (flammability / burn odds), `lavaIgnite: false`. Add `waterloggable: false` (15 §9) and `infiniteBurn: false` (declared by 10, consumed by 15 §2).
- **AMENDS 01 §4.6 (setBlock) + §4.2 (heightMap):** effective sky opacity of a cell is `max(BLOCKS[id].skyOpacity, (states & 0x80) ? 1 : 0)` for heightmap maintenance, and a state write that toggles bit 7 must run step 4 (`LightEngine.onBlockChanged`) and step 7 (neighbor updates / fluid wake) even when the id is unchanged.
- **AMENDS 01 §7.1 (atlas):** add animated-tile support: a tile may register `frames: 4`; the painter is called 4 times with `rng = mulberry32(xmur3(tileName + '#' + frame)())` and the frames occupy **4 consecutive tile slots in the same atlas row**. `TILE[name]` = frame-0 index. Registered animated tiles: `water_still`, `lava_still`, `fire` (this file), `portal` (10, hook). Water/lava painters now produce 4 frames (supersedes 06 §3's "2 frames at 4 Hz" — rate preserved, see 15 §7.2).
- **AMENDS 01 §8.5 (geometry layout):** add attribute `anim`: Uint8, itemSize 1, value `0` (static) or `1` (4-frame animated). Set to 1 on every quad whose tile is animated (fire, water, lava, portal).
- **AMENDS 01 §8.7 (chunk shader):** vertex shader adds `attribute float anim;` and `uniform float uAnimFrame;` with `vUv.x += anim * uAnimFrame * (16.0 / 512.0);`. `uAnimFrame = (worldTime / 5 | 0) % 4`, written once per tick into the three shared bucket materials. Day/night still never remeshes; neither does animation.
- **AMENDS 01 §8.1/§8.4 (mesher, water bucket):** every same-fluid visibility test for water uses `isWaterCell` (id or bit 7). A bit-7 cell emits BOTH its block mesh (normal bucket) AND water geometry in the water bucket per 15 §12.
- **AMENDS 01 §11 (raycast):** unchanged traversal; note that a waterlogged cell is hit as its **block** (the contained water is never separately targetable). Bucket scoop of bit-7 cells rides the block hit, not fluidMode (15 §13.1).
- **AMENDS 03 §10 (water detection):** every "is water" test in §10.1/§10.2 (swim branch trigger, `eyeSubmerged`) uses `isWaterCell(pos)` = `id == water || (states & 0x80)`. Consequences: swimming/drowning inside waterlogged cells, mining speed ÷5 with eyes in one, burning extinguished (§11.3's `inWater`), fall damage cancelled on entry.
- **AMENDS 03 §16.2 (placement):** placing a **waterloggable** block into a cell containing a water **source** (id water, state 0) sets bit 7 instead of destroying the water; into flowing water → water removed, block placed dry, neighbors woken. Breaking a bit-7 block sets the cell to `water` source (state 0) instead of air, then normal drop logic.
- **AMENDS 04 §8 (opacity lookup):** light-BFS opacity of a cell is `max(opacity(id), (states & 0x80) ? 1 : 0)` — waterlogged cells filter like water (sky light −1 extra even straight down, rule 3).
- **AMENDS 04 §12.2:** the bullet "Fire blocks have a chance to extinguish; crops/farmland hydrate — rules in 06" now points to 15 §2.2 (fire) and 15 §13.4 (hydration).
- **AMENDS 04 §12.6 (lightning):** concretize "ignite fire at target block": place fire (age 0) at the strike cell if `canSurvive` (15 §1.2), then make **4** extra attempts at cells offset by `randInt(−1,1)` on each axis from the strike cell, each placed only if air + `canSurvive`. Each placement registers an ignition origin (15 §6).
- **AMENDS 05 §12 (explosions):** per-cell blast resistance becomes `states & 0x80 ? max(Blast, 100) : Blast` — waterlogged blocks are explosion-proof like water (vanilla). Explosions still never create fire (already base behavior — keep the checklist line "no fire").

---

## Contents

**Part A — Fire spread:** 1. Fire block, state & placement · 2. Scheduled-tick algorithm · 3. Flammability registry (core table) · 4. Ignition sources · 5. Entity fire hooks · 6. Safety valve · 7. Rendering & animated tiles
**Part B — Waterlogging:** 8. Concept & the bit-7 contract · 9. Waterloggable block table · 10. Interaction mechanics · 11. Fluid-system integration · 12. Meshing waterlogged cells · 13. Targeting, entities & gameplay predicates · 14. Persistence
**Shared:** 15. Sound events (contract for 16-AUDIO) · Acceptance checklist

---

# Part A — Fire spread

## 1. Fire block, state & placement

### 1.1 State

Fire (id 65) uses its state low nibble as **age 0–15** (bits 0–3). Newly ignited fire has age 0. Age only increases (§2.3). Bits 4–6 unused; bit 7 never set on fire (fire is destroyed by water, never waterlogged). Age is saved with the chunk like every other state nibble (01 §16).

### 1.2 Placement validity (`canSurvive`)

```
canSurvive(pos) =
     solidTopBelow(pos)                        # block below is a full solid cube top
                                               # (opaque:true or collidable full-cube; fences/chests: chest yes (full cube), fence no)
  or anyFlammableNeighbor(pos)                 # any of the 6 face neighbors has fireEnc > 0
                                               # (bit-7 neighbors count as fireEnc 0 — §13.3)
```

> Adaptation: vanilla renders side/ceiling flame overlays on flammable faces. VoxelCraft fire is **floor-only visually**: one cross-shape block occupying the cell, regardless of which neighbor keeps it alive. The survival rule above is vanilla-faithful (fire can float against a flammable wall); only the rendering is simplified. Eternal fire (§4.5) additionally requires `infiniteBurn` **below** — it cannot exist on the sides of netherrack, matching vanilla.

### 1.3 Neighbor updates & extinguish

- Any neighbor change re-checks `canSurvive`; failure removes the fire immediately (no drop, extinguish sound §15).
- **Punch extinguish:** fire hardness 0 → LMB breaks instantly (03 §15), drops nothing, plays `block.extinguish`, costs no tool durability (hardness-0 rule, 06 §7.1 — matches vanilla "hitting fire does not damage tools").
- Placing any block into a fire cell extinguishes it (fire is in 03 §16.2's replaceable set).
- Water or lava flowing into the cell replaces it (`canReplace` includes fire, 06 §6.1).
- Explosions destroy fire blocks (blast resistance 0).

## 2. Scheduled-tick algorithm (exact)

Every fire block holds a pending scheduled tick with delay **`30 + randInt(0,9)` game ticks** (1.5–1.95 s; vanilla `getFireTickDelay`). The tick is scheduled on placement and re-scheduled first thing on every run. Fire outside `SIM_RADIUS` is deferred +40 t by 01 §6.1 — the vanilla "fire only spreads near a player" rule falls out for free.

```
fireTick(pos):
  schedule(pos, 30 + randInt(0,9))
  age      = states[pos] & 0x0F
  below    = getBlock(pos.down)
  infinite = BLOCKS[below].infiniteBurn                     # netherrack/magma (10)

  # -- 2.1 survival ------------------------------------------------------
  if not canSurvive(pos): remove(pos); return

  # -- 2.2 rain (skipped on eternal fire — rain never kills it, vanilla) --
  if not infinite and isNearRain(pos) and rand() < 0.2 + age * 0.03:
      remove(pos); return                                   # 20% at age 0 … 65% at age 15
  # isNearRain(p) = isRainingAt(p) or isRainingAt any of p's 4 horizontal
  # neighbors (04 §12.4 — requires canSeeSky + temp > 0.15, so snowfall never douses)

  # -- 2.3 aging: +1 with chance 1/3 --------------------------------------
  newAge = min(15, age + (randInt(0,2) >> 1))
  if newAge != age: setState(pos, (states[pos] & 0xF0) | newAge)   # no remesh needed (texture ageless)

  if not infinite:
      # -- 2.4a barren burnout ------------------------------------------
      if not anyFlammableNeighbor(pos):
          if not solidTopBelow(pos) or age > 3: remove(pos)
          return                                            # no neighbors → never spreads (vanilla early-return)
      # -- 2.4b old-age burnout -----------------------------------------
      if age == 15 and randInt(0,3) == 0 and BLOCKS[below].fireBurn == 0:
          remove(pos); return                               # 1/4 per tick once fully aged on non-fuel floor

  humid = biomeAt(pos) in HUMID_BURNOUT_BIOMES              # §2.6
  k = humid ? -50 : 0

  # -- 2.5 consume the 6 neighbors (vanilla checkBurnOut, exact order) ---
  tryBurn(pos.east,  300+k, age); tryBurn(pos.west, 300+k, age)
  tryBurn(pos.down,  250+k, age); tryBurn(pos.up,   250+k, age)
  tryBurn(pos.north, 300+k, age); tryBurn(pos.south,300+k, age)

  # -- 2.6 propagate into air: 3×3 column, y−1 … y+4 ----------------------
  for dx in [-1..1], dz in [-1..1], dy in [-1..4]:
      if dx==0 and dy==0 and dz==0: continue
      t     = pos + (dx,dy,dz)
      bound = 100 + (dy > 1 ? (dy-1)*100 : 0)               # 100 / 100 / 100 / 200 / 300 / 400 by dy
      enc   = igniteOdds(t)                                 # 0 unless t is AIR; else max fireEnc
                                                            # of t's 6 neighbors (bit-7 cells → 0)
      if enc <= 0: continue
      odds = floor((enc + 54) / (age + 30))                 # vanilla (enc + 40 + 7·difficulty), Normal=2 → +54
      if humid: odds = floor(odds / 2)
      if odds > 0 and randInt(0, bound-1) <= odds and not isNearRain(t):
          placeFire(t, min(15, age + (randInt(0,4) >> 2)), origin(pos))   # child age: +1 with chance 1/5
```

```
tryBurn(t, bound, age):                                     # consume / ignite a flammable neighbor
  burn = effFireBurn(t)                                     # registry fireBurn; 0 if bit 7 set (§13.3)
  if burn <= 0 or randInt(0, bound-1) >= burn: return
  wasTNT = getBlock(t) == TNT
  if randInt(0, age+9) < 5 and not isRainingAt(t) and fireBudgetAllows(t, origin(pos)):   # §6
      placeFire(t, min(15, age + (randInt(0,4) >> 2)), origin(pos))       # block replaced by fire
  else:
      setBlock(t, AIR)                                      # block burns away, no fire left
  if wasTNT: primeTNT(t, fuse=80)                           # 06 §5.6 amended: fire-lit TNT, standard fuse
```

Notes, all vanilla-exact unless flagged:

- `randInt(a,b)` is uniform inclusive; `rand()` uniform float [0,1). All rolls use `Math.random()` (cosmetic-and-decision RNG is allowed outside worldgen, CLAUDE.md §4).
- `placeFire(t, age, origin)` sets id 65 + age, schedules its first tick at +30+rand(10), fires neighbor updates (TNT no longer instant — see amended 06 §5.6), and registers `origin` in the safety valve (§6). It does **not** pre-check `canSurvive` (vanilla: an invalid fire dies on its next tick or neighbor update).
- Per-position spread probability in 2.6 is `(odds+1)/bound` (the `<=` is vanilla's). Example: planks (enc 5) beside a fresh fire, same level: `floor(59/30)=1` → 2/100 per fire tick per air cell.
- The 3×3×6 volume is anchored on the **fire block**, not its fuel; interposed non-flammable blocks do NOT shield cells above (vanilla: cobble between fire and a wooden roof does not protect the roof).
- **2.6 humidity:** `HUMID_BURNOUT_BIOMES = { snowy_tundra, mountains }` from `chunk.biomes` at the fire's column. `> Adaptation:` maps vanilla's `increased_fire_burnout` tag (jungle/swamp/mushroom/snowy slopes/frozen+jagged peaks) onto the two base biomes that plausibly qualify; 02's biome set has no jungle/swamp. Effect (vanilla-exact mechanism): burn bounds −50, spread odds halved.

### 2.7 Derived lifetimes (test targets)

| Situation | Expected outcome |
|---|---|
| Fire on stone, nothing flammable near | dies when age exceeds 3: median ≈ 9 fire ticks ≈ 15 s (age +1 @ 1/3/tick) |
| Fire on oak planks floor | consumes the plank under/next to it within a few seconds (burn 20 → ~6.7%/tick/side, 8% below), leaves fire ~5/(age+10) of the time |
| Fire at age 15 on stone next to logs | keeps burning (flammable neighbor) but 2.4b never fires (below non-fuel → 1/4 removal each tick → gone in ~6 s) |
| Rain on age-0 fire | 20%/tick → median 3 ticks ≈ 5 s |
| Fire on netherrack | never removed by 2.2/2.4 — burns forever, still spreads |

## 3. Flammability registry — the core table

One table, whole game. Columns: **Enc** = encouragement/ignite odds (feeds 2.6 and `anyFlammableNeighbor`), **Burn** = flammability/burn odds (feeds 2.5), **Lava** = `lavaIgnite` (participates in lava's fire-creation check §4.2 even when Enc/Burn are 0). All values are exact Java 1.20 (`FireBlock` registrations / minecraft.wiki Fire tables). Any block not listed is `0 / 0 / no`.

| Block (ids) | Enc | Burn | Lava | Notes |
|---|---:|---:|:---:|---|
| oak/birch/spruce_planks (5–7) | 5 | 20 | yes | |
| oak/birch/spruce_log (8–10) | 5 | 5 | yes | slow, long-burning |
| oak/birch/spruce_leaves (11–13) | 30 | 60 | yes | burn drops nothing (block consumed, no loot — vanilla) |
| coal_block (27) | 5 | 5 | yes | |
| crafting_table (34) | 0 | 0 | yes | vanilla: wooden but fireproof; lava can still start fire beside it |
| chest (37) | 0 | 0 | yes | fireproof (vanilla) |
| bookshelf (50) | 30 | 20 | yes | |
| **tnt (51)** | 15 | 100 | yes | **special:** when consumed by `tryBurn` → primed-TNT entity, fuse 80 t (§2.5) |
| oak_fence (52) | 5 | 20 | yes | matches planks (vanilla fence values) |
| oak_door (53) | 0 | 0 | yes | vanilla doors are non-flammable |
| bed_block (54) | 0 | 0 | yes | vanilla JE: lava-ignitable, never burns away |
| wool_white/red/blue/black (46–49) | 30 | 60 | yes | |
| short_grass (60) | 60 | 100 | yes | |
| dandelion, poppy (61–62) | 60 | 100 | no | 1-block flowers: JE lava-ignite is No |
| dead_bush (66) | 60 | 100 | yes | |
| saplings (14–16) | 0 | 0 | no | vanilla saplings do not burn |
| crops/farmland/sugar_cane/cactus/pumpkin/jack_o_lantern (43–45, 55–59) | 0 | 0 | no | |
| torch, ladder, snow, ice, glass, stone/ores/minerals, fluids, everything else | 0 | 0 | no | |
| **Expansion blocks** | | | | |
| ~~trapped_chest (07)~~ | — | — | — | **N/A** — 07 cut trapped chests (§1 EXCLUDED); not in scope |
| ~~rails, all types (07)~~ | — | — | — | **N/A** — 07 cut rails + minecarts (§1 EXCLUDED); not in scope |
| hopper, piston, redstone components (07) | 0 | 0 | no | |
| enchanting_table, bookshelf-adjacent decor (08) | 0 | 0 | no | enchanting table is stone+diamond |
| netherrack, magma_block (10) | 0 | 0 | no | `infiniteBurn: true` — §4.5 |
| crimson/warped planks·logs·fences family (10) | 0 | 0 | no | vanilla JE: Nether wood is completely non-flammable |
| end_stone, end_rod, shulker_box, purpur (11) | 0 | 0 | no | |
| hay_bale (12) | 60 | 20 | no | catches instantly, burns slowly |
| bell (12) | 0 | 0 | no | |

Registry rule: a **waterlogged** cell reports `Enc = Burn = 0` regardless of the table (vanilla: "waterlogged blocks are non-flammable") — see §13.3.

## 4. Ignition sources

| # | Source | Rule |
|---|---|---|
| 4.1 | **Flint & steel** (item 284, durability 64) | RMB: if the targeted block is TNT → prime it (fuse 80 t, base 06 §5.6a). Else `t = hit.pos + faceNormal`; if `getBlock(t) == air` and `canSurvive(t)` → place fire age 0, −1 durability, `item.flintandsteel.use` sound. On failure: nothing consumed, no sound. New origin registered (§6). |
| 4.2 | **Lava** (random tick) | Lava cells get a `randomTick` handler (01 §6.2 dispatch; both source and flowing cells). Per random tick, vanilla-exact: roll `i = randInt(0,2)`. **If `i > 0`:** walk upward `i` steps; each step moves `(randInt(−1,1), +1, randInt(−1,1))` from the previous position. At each step: if the cell is air → if it has a `lavaIgnite` neighbor (any of 6 faces, bit-7 cells excluded), place fire there (age 0) and stop; if the cell blocks motion (collidable) → stop. **If `i == 0`:** 3 attempts at `(randInt(−1,1), 0, randInt(−1,1))`: if that block is `lavaIgnite` and the cell above it is air → place fire above it. Net effect (wiki phrasing): fire appears up to 1 above/1 around, or 2 above/2 around still lava. Expect natural forest fires where surface lava pools touch trees. |
| 4.3 | **Lightning** (04 §12.6, amended) | Fire age 0 at the strike cell + 4 extra ±1-offset attempts. Only during thunderstorms; Normal difficulty always ignites. |
| 4.4 | **Ghast fireball** (10) | 10's fireball explosion places fire per its own spec; each placement must call `placeFire` here so origins register. Hook only — no numbers owned here. |
| 4.5 | **Eternal fire** | Fire whose supporting block below has `infiniteBurn` (netherrack, magma — flag declared by 10) skips rain extinguish (2.2), barren burnout (2.4a) and old-age burnout (2.4b). It still ages to 15, still spreads and consumes neighbors, and is still removed by punching, block placement, water flow, and explosions. Eternal only when the infiniteBurn block is **below** (§1.2). |
| 4.6 | **Explosions do NOT ignite** | TNT and creeper explosions never create fire (vanilla; 05 §12 checklist already asserts "no fire"). Fire charge items are out of scope. |

## 5. Entity fire hooks (pointers — no duplication)

Entity burning is owned by 03 §11 (player) and 05's damage pipeline (mobs). This table is the contract; the numbers live there.

| Trigger | Effect | Owner |
|---|---|---|
| AABB overlaps a fire block | 1 dmg per 10 t + `fireTicks = max(fireTicks, 160)` (8 s afterburn) | 03 §11.2 (player), 05 damage pipeline (mobs) |
| Burning (`fireTicks > 0`) | 1 dmg per 20 t; cleared by water (incl. bit-7 cells, §13.2), rain | 03 §11.3 |
| Item entity touches fire | destroyed | 06 §16 |
| Mob dies while burning | `(approx)` no cooked-meat drop conversion — omitted, log in DEVIATIONS.md | — |
| Undead daylight burning | independent system, unchanged | 04 §10.2 / 05 |

## 6. Safety valve (film-safe spread cap)

> Adaptation: vanilla fire on a large enough fuel bed can burn arbitrarily far. To keep filming/base-building safe by default, VoxelCraft caps every fire **cascade** by distance from its ignition point and caps global concurrency. Defaults ON; disabling is a one-line config change.

```js
// world/fire.js
export const FIRE_SAFETY = { RADIUS_CAP: 24, MAX_ACTIVE: 512 };  // set both to Infinity to disable
const fireOrigins = new Map();   // packedPos(x,y,z) → packed origin (ox:int16, oz:int16). Runtime only, NOT saved.
```

Mechanism (decision — origin map, not age abuse):

1. Every direct ignition (§4.1–4.4) registers `origin = (x, z)` of the new fire.
2. Every fire created by spread (2.6) or burn-replacement (2.5) **inherits its parent's origin**.
3. `fireBudgetAllows(t, origin)` = `chebyshev((t.x,t.z), origin) <= RADIUS_CAP && fireOrigins.size < MAX_ACTIVE`. When it fails, the fire is simply not created — and in `tryBurn` the fuel block is **not** consumed either (the fire front stalls instead of silently deleting the world edge).
4. Any fire removal (any path in §1.3/§2) deletes its entry. Chunk unload deletes that chunk's entries.
5. Fires hydrated from a save have no entry; on their first tick they self-register with `origin = own position` — i.e., the 24-block leash re-anchors across reloads. Honest and cheap; documented in the acceptance list.

MAX_ACTIVE only gates **new spread fires**; direct player ignition always succeeds (and registers). Direct ignitions while ≥ 512 fires exist simply can't cascade further until the count drops.

## 7. Rendering: flame animation & the animated-tile pipeline

### 7.1 Shape & light

Unchanged from base 06 §3: cross (two diagonal quads, 0.15→0.85) **plus inner quads** — 4 upright quads inset 4/16 from each side face, giving the dense vanilla flame look. All quads: cutout bucket, AO 1.0, shade 1.0, light = own cell. Fire emits light 15 (04 recomputes on place/remove as with any emitter).

### 7.2 4-frame animated tiles

- `fire` registers as an animated tile (amended 01 §7.1): 4 frames in consecutive atlas slots. Painter: base recipe from 06 §4 ("2-frame streaks #ff9a00/#ffd23c/#ffffff, 40% transparent") upgraded — frame `k` re-seeds the streak rng AND shifts all streak pixels up `2k` px with vertical wraparound, so playback reads as rising flames `(approx)`.
- Frame clock: `uAnimFrame = (worldTime / 5 | 0) % 4` — one frame per **5 ticks** (250 ms), full cycle 1 s. Decision: 5 ticks (not 10) to preserve base 06 §3's established 4 Hz fluid flicker exactly; one shared uniform serves fire, water, lava, and (hook) 10's portal.
- Mechanism is the `anim` vertex attribute + `uAnimFrame` UV shift (amended 01 §8.5/§8.7). The half-texel inset of 01 §7.2 is frame-size-aligned (offset `k·16/512` lands on frame k's inset window exactly), so no bleeding.
- Water/lava painters emit 4 frames: their 2 existing noise seeds + a ±6%-brightness variant of each, ordered A B A′ B′. Flowing-cell UV scroll (0.5 px/t) is unchanged and stacks with the frame shift.
- DOM/UI icons keep using the static dataURL snapshot → item icons show frame 0. Fine.
- No geometry or light updates on frame change — pure shader.

---

# Part B — Waterlogging

## 8. Concept & the bit-7 contract

Waterlogging lets a non-cube block and a **water source** occupy one cell (vanilla 1.13 mechanic). Representation: **bit 7 of `chunk.states[i]`**, reserved game-wide by this file:

- `states & 0x80` is meaningful only on blocks with `waterloggable: true` (§9). Engine invariant: `setBlock` clears bit 7 whenever the new id is not waterloggable; fluid/crop/door/etc. nibble semantics (bits 0–3) are untouched.
- A bit-7 cell **is a water source** for every system: fluid spread (§11), buckets (§10), swimming/drowning (§13.2), light filtering (§13.5), hydration (§13.4), lava interactions (§11.3), infinite-source formation (§11.2).
- Vanilla properties adopted verbatim: waterlogged blocks are **non-flammable** and **explosion-proof** (resistance ≥ water's 100) even if the dry block burns; lava can produce cobblestone/obsidian against them but can **never** convert them to stone; they are immune to freezing (04 §12.5 targets id `water` only — no change needed); water **does flow out** of them like any source.
- There is no flowing-water-in-a-block state: bit 7 = source or nothing (vanilla is the same).

## 9. Waterloggable block table

Verdicts verified against Java 1.20 (`waterlogged` blockstate / minecraft.wiki Waterlogging behavior table). "Dam" = displaces/blocks water like any solid (base 06 §6.1). "Pops" = destroyed by water flowing into the cell (already in base `canReplace`).

| Block | Vanilla JE 1.20 | VoxelCraft verdict |
|---|---|---|
| oak_fence (52) | waterloggable | **YES** |
| ladder (39) | waterloggable | **YES** |
| chest (37) | waterloggable | **YES** (full-cube render caveat §12.2) |
| ~~trapped_chest (07)~~ | waterloggable | **N/A** — 07 cut trapped chests (not in scope) |
| ~~rails, all types (07)~~ | waterloggable (1.17+) | **N/A** — 07 cut rails (not in scope) |
| bell (12) | NOT waterloggable | **NO** — dam |
| hopper (07) | NOT waterloggable | **NO** — dam |
| end_rod (11) | not waterloggable (pops in water) | **NO** — pops when flooded (11 adds it to `canReplace`-style pop list) |
| shulker_box (11) | NOT waterloggable | **NO** — dam |
| oak_door (53) | NOT waterloggable (JE) | **NO** — dam; underwater door air pockets work, vanilla parity |
| torch (38) | pops in water | **NO** — pops (base behavior; torches cannot exist in water) |
| snow_layer (40) | NOT waterloggable, pops | **NO** — pops (base) |
| oak/birch/spruce_leaves (11–13) | waterloggable (1.19+), full block, no visible outflow | **NO** `> Adaptation:` our leaves are full opaque-ish cubes and their state bits carry persistence; water treats leaves as a dam. Cosmetic-only deviation. |
| signs | waterloggable | N/A — no signs in scope |
| slabs/stairs/glass panes/iron bars/walls/lanterns | waterloggable | N/A — not in any registry |
| glass (31), ice (42) | NOT waterloggable | **NO** — dam (vanilla) |
| everything else | — | **NO** — dam or pops per base 06 §6.1 |

Registry: `waterloggable: true` on fence, ladder, chest. That is the complete list — 07's trapped_chest and rails are cut (not in scope), so there are no additions.

## 10. Interaction mechanics

| # | Action | Result |
|---|---|---|
| 10.1 | Place waterloggable block into a water **source** cell | Block placed with bit 7 = 1. Water is not displaced, nothing is scheduled away; neighbors woken (they were fed before, still are). |
| 10.2 | Place waterloggable block into **flowing** water | Placed dry (bit 7 = 0), water removed, neighbor fluid cells woken (flow re-derives). Vanilla: only sources waterlog. |
| 10.3 | Place non-waterloggable block into any water | Base behavior: water destroyed, block placed (03 §16.2). |
| 10.4 | Water bucket used on a targeted **dry waterloggable** block | Set bit 7, bucket → empty, `item.bucket.pour` sound, schedule cell + 6 neighbors for fluid ticks, run §11.3 lava check. |
| 10.5 | Empty bucket used on a targeted **waterlogged** block | Clear bit 7, bucket → water_bucket, `item.bucket.fill` sound, wake neighbor fluid cells (downstream drains re-derive). |
| 10.6 | Break a waterlogged block | Cell becomes `water` **source** (id 63, state 0) instead of air; drops unchanged (chest additionally spills contents, which float per 06 §16 buoyancy). Fluid tick scheduled. |
| 10.7 | Fire vs waterlogged | A bit-7 block can never ignite or be consumed (§13.3). Fire adjacent to it is NOT specially extinguished (vanilla) — but the waterlogged cell spreads water (§11.1), and water flowing into a fire cell replaces it, so adjacent fires below/level typically drown within one fluid interval. Fire sitting on TOP of a waterlogged chest survives (water never flows up). |
| 10.8 | Waterlog state and block state coexist | Bits 0–3 keep their per-block meaning (chest none, ladder facing if any, fence none). Opening a waterlogged chest works normally — UI is "dry" (vanilla). |

## 11. Fluid-system integration (06 §6, amended)

### 11.1 Source semantics

```
isWaterCell(i)   = blocks[i] == WATER or (states[i] & 0x80)
isWaterSource(i) = (blocks[i] == WATER and (states[i] & 0x0F) == 0) or (states[i] & 0x80)
S(cell)          = 8 if (states & 0x80) else base 06 §6.2 rules
```

- Waterlogged cells receive scheduled fluid ticks like water cells (scheduled on waterlog, on neighbor wake). Their `update()` skips the re-derive branch entirely (a bit-7 cell can never recede — only 10.5/10.6 change it) and runs only the **spread** step: flow down into `canReplace` cells (falling, full strength) else spread S−1=7 to the 4 sides. Identical cadence: 5 t.
- Dry waterloggable blocks remain dams: `canReplace` is unchanged; flow never sets bit 7 (vanilla).

### 11.2 Infinite sources

`adjacentSources ≥ 2` (06 §6.2's water-source promotion) counts bit-7 neighbors, and `solidOrSource(down)` accepts a bit-7 cell below. Two waterlogged fences flanking a water cell over solid ground therefore mint a source between them — vanilla parity.

### 11.3 Lava interactions (06 §6.3, amended)

| Situation | Result |
|---|---|
| Flowing lava horizontally/vertically adjacent to a bit-7 cell | lava cell → **cobblestone** (bit-7 counts as "touched by water") |
| Lava **source** adjacent to a bit-7 cell | lava cell → **obsidian** |
| Lava flows on top of a bit-7 cell | **no conversion** — the waterlogged block is never turned to stone (vanilla); lava simply rests above (the bit-7 cell is not `canReplace`) |

Conversions play the fizz event (§15) as in base. Sponge: **out of scope** (stated; no sponge item exists).

## 12. Meshing waterlogged cells (01 §8, amended)

A bit-7 cell emits **two** mesh contributions in the same sweep:

1. **Block mesh** — exactly as dry, in its normal bucket (fence/ladder → their custom shapes, chest → cube). AO, light sampling, shading unchanged.
2. **Water geometry** — into the `water` bucket, following the base liquid rules with `isWaterCell` as the same-fluid test:

```
emitWaterlogged(c):                       # c has bit 7
  if BLOCKS[c.id].shape == 'cube': return        # 12.2 full-cube rule (chest)
  above = c.up
  if not isWaterCell(above):
      emit top face at y + 0.875                 # standard lowered source surface (01 §8.4)
  sideTop = isWaterCell(above) ? 1.0 : 0.875
  for n in [±X, ±Z]:
      if isWaterCell(n) or BLOCKS[n.id].opaque: continue
      emit side face from y+0 to y+sideTop       # at the exact cell boundary plane
  if not isWaterCell(c.down) and not BLOCKS[down.id].opaque:
      emit bottom face
```

- **12.1 No z-fighting, by construction:** water faces lie exactly on cell-boundary planes; every custom sub-shape quad is interior (fence post/rails, door panel) — EXCEPT wall-mounted quads. Rule: any custom-shape quad that would be coplanar with a cell boundary is inset **1/64** into the cell (this pins down the base ladder quad: 1/64 off its wall — previously unspecified). The water top at 0.875 never collides with fence rails (rails top out at 1.5 in the *neighbor-connect* mesh but rail geometry is interior to X/Z bounds; the post is 6/16 wide, non-coplanar).
- **12.2 Full-cube waterloggables (chest):** emit **no water geometry of their own** — the water is logically present but visually hidden inside the cube. Neighboring water cells cull their faces toward the chest via `isWaterCell` (same-fluid rule), so an ocean-floor chest sits flush with no phantom walls. `> Adaptation:` vanilla's chest is a 14/16 model with visible water around it; ours is a full cube, so the water sleeve is invisible anyway. A waterlogged chest left in open air renders dry — acceptable, self-corrects the moment anything queries or drains it.
- **12.3 Neighbor rule for plain water:** everywhere the base mesher/liquid path compares "same fluid" for water (01 §8.1 `renderSameIdFaces`, §8.4 top-surface drop), substitute `isWaterCell`. Lava is untouched.
- **12.4** AO/light: water quads sample per the base liquid path (own cell values); the block mesh samples as usual. `stateAt` is already available in the mesher hood (01 §8.6).

## 13. Targeting, entities & gameplay predicates

### 13.1 Raycast & bucket precedence

The DDA (01 §11) returns the **block** for a bit-7 cell (waterloggable blocks are all `targetable`); the contained water is never independently targetable. RMB resolution keeps 03 §16.1's order — interact-first, sneak bypasses:

```
empty bucket RMB → hit block:
  1. interactable (chest) and not sneaking      → open UI            (03 §16.1 rule 2)
  2. hit cell has bit 7                          → scoop (10.5)      # fence/ladder direct; chest requires sneak
  3. else                                        → base fluidMode source scan (06 §6.4)

water bucket RMB → hit block:
  1. interactable and not sneaking               → open UI
  2. hit block waterloggable and bit 7 clear     → waterlog (10.4)
  3. else                                        → place source at hit.pos + faceNormal (06 §6.4)
```

So scooping a waterlogged chest = sneak + RMB — vanilla-equivalent semantics.

### 13.2 Entities (03 §10 amended)

`isWaterCell` drives the swim-branch trigger and `eyeSubmerged`. Consequences: swimming physics inside waterlogged cells, drowning timeline (300 t air → 2 HP/s) while idling inside a waterlogged ladder/fence column, mining ÷5 with eyes in one, `fireTicks = 0` on contact, fall damage cancelled on entry. Waterlogged **ladder**: the water branch wins over climbing; jump-held ascent (≈2.7–3.5 m/s) substitutes for climb speed `(approx — vanilla lets you climb underwater at ladder speed; single branch keeps 03 §4's pipeline untouched)`.

### 13.3 Fire predicates

`effFireEnc(cell)` and `effFireBurn(cell)` return 0 when bit 7 is set (used by §2.5/2.6, `anyFlammableNeighbor`, `igniteOdds`, and lava's `lavaIgnite` neighbor check). A soaked fence is inert fuel.

### 13.4 Hydration & plants

Farmland moisture (06 §5.11: Chebyshev ≤ 4, same Y or Y+1) and sugar-cane support (06 §5.9) use `isWaterCell`. A waterlogged fence irrigates crops and supports cane.

### 13.5 Light, heightmap, rain

Light-BFS opacity: `max(opacity(id), bit7 ? 1 : 0)` — sky light loses 1/step through waterlogged cells including straight down (04 §8 rule 3), block light normal −1/step. Effective `skyOpacity ≥ 1` for bit-7 cells → the heightmap terminates at a waterlogged block, so rain streaks stop on it (04 §12.3) and `isRainingAt` below it is false. Toggling bit 7 runs the standard light-edit procedure (04 §9.4) and remesh dirtying — a bucket splash can visibly re-shade the water column below.

### 13.6 Explosions

Blast resistance of a bit-7 cell = `max(Blast, 100)` (05 §12 amendment). A creeper cannot crater a submerged fence line.

## 14. Persistence

Free. Bit 7 rides `chunk.states` which is already serialized verbatim (01 §16, 06 §18). Fire age is the state nibble — also free. The only non-persistent datum is the fire-origin map (§6.5, re-anchors on load — documented). No schema change, no migration.

---

## 15. Sound events (contract for 16-AUDIO)

Events this file emits; 16 owns synthesis, mixing, attenuation. Vanilla identifiers given as reference names.

| Event key (16 namespace) | Vanilla ref | Trigger (this file) | Params |
|---|---|---|---|
| `ambient.fire.loop` | `block.fire.ambient` | per loaded fire block within audio range: chance 1/24 per tick (client-side roll) — reads as a crackle loop over a burning area | vol 1.0–2.0, pitch 0.3–1.0, range 16 m |
| `block.extinguish` | `block.fire.extinguish` / `block.lava.extinguish` | fire punched out / fire flooded by water / rain douse (§13.3) `(approx — vanilla rain-out is silent; audible feedback kept)`; **also** all §11.3 / 06 §6.3 lava↔water conversions incl. against waterlogged cells; NOT on quiet age-out (2.4). The single canonical douse key (16 §3.3), shared with 09/10 | vol 0.5, pitch 1.8–3.4 |
| `item.flintandsteel.use` | `item.flintandsteel.use` | successful ignition or TNT prime via flint & steel | vol 1.0, pitch 0.8–1.2 |
| `item.bucket.fill` | `item.bucket.fill` | scooping a source **or a waterlogged cell** (10.5) — the "splash on waterlogged" | vol 1.0, pitch 0.9–1.1 |
| `item.bucket.pour` | `item.bucket.empty` | placing a source **or waterlogging a block** (10.4) | vol 1.0, pitch 0.9–1.1 |
| `world.tnt.fuse` | `entity.tnt.primed` | fire-consumed TNT ignition (2.5) — same event as base/07 TNT ignition paths | vol 1.0 |

---

## Acceptance checklist

**Fire**

- [ ] Flint & steel on stone: fire appears (age 0, light 15), never spreads, dies by itself in ~10–25 s (age > 3 barren rule); punching it out is instant, silent-drops, costs no durability, plays the hiss.
- [ ] Fire ticks arrive every 30–39 game ticks; age increments ~1/3 of ticks (inspect via F3 state readout).
- [ ] A 5×5 oak-planks floor ignited at one corner is fully consumed or burning within ~2 minutes; flames climb a plank wall and ignite a roof 4 blocks above the top flame despite an interposed cobblestone slab-course (3×3×(−1..+4) volume ignores blockers).
- [ ] Wool catches visibly faster than logs from an adjacent fire (enc 30 vs 5); leaves burn away without dropping loot; saplings, crops, doors, chests and crafting tables never ignite from spread.
- [ ] Rain: an age-0 fire under open sky dies with ~20%/tick (median < 6 s); the same fire under a roof keeps burning; snowfall (temp ≤ 0.15 columns) extinguishes nothing.
- [ ] TNT: one flint & steel spark beside a TNT cluster → fire consumes a TNT (burn odds 100), it primes with an 80 t fuse and the chain detonates; the explosions ignite no new fires and destroy any fire blocks in radius.
- [ ] Lava: a surface lava pool ringed with logs starts a fire within a few minutes of random ticks; fire can appear next to a crafting table (lavaIgnite) but the table never burns away.
- [ ] Lightning strike (thunderstorm) leaves up to 5 fire blocks around the strike column.
- [ ] Netherrack (with 10 installed): fire on top burns forever through rain, still spreads to nearby planks, and is removable only by punch/placement/water.
- [ ] Safety valve: igniting an "infinite" wool field produces no fire block farther than 24 blocks (Chebyshev, horizontal) from the spark, and the global active-fire count plateaus ≤ 512; setting both constants to `Infinity` restores unbounded vanilla behavior.
- [ ] Fire/water/lava render 4-frame animation at 4 Hz via `uAnimFrame`; no remesh occurs on frame swaps; item icons remain static frame 0.

**Waterlogging**

- [ ] Placing a fence line across a 2-deep lake floor waterlogs each fence on placement (source cells); the water surface reads continuous — no air pockets, no z-fighting on any face; placing the same fence into flowing water places it dry and interrupts the flow.
- [ ] An ocean-floor chest is waterlogged: opens underwater with a normal dry UI, neighboring water renders flush against it; breaking it spills floating items AND leaves a water source in the cell.
- [ ] Breaking a waterlogged ladder leaves a source block that immediately flows down the shaft.
- [ ] Buckets: empty bucket on a waterlogged fence fills the bucket and dries the fence; water bucket re-waterlogs it without spilling; a waterlogged chest requires sneak + RMB to scoop (plain RMB opens it).
- [ ] Waterlogged cells spread: removing a wall block beside a waterlogged fence floods the neighbor within 5 ticks (spread 7); two waterlogged fences flanking a water cell over solid ground promote it to a source (infinite-source parity).
- [ ] Fire on an adjacent wool block is drowned when the wool's cell floods from a neighboring waterlogged fence; the waterlogged fence itself never ignites and survives a point-blank creeper (resistance 100).
- [ ] Standing inside a waterlogged fence/ladder column drains air bubbles and drowns on the 03 §10.2 timeline; entering one cancels fall damage and extinguishes burning.
- [ ] Sky light drops by 1 per waterlogged cell straight down; rain streaks stop at a waterlogged fence's surface; crops within Chebyshev 4 of a waterlogged cell stay hydrated.
- [ ] Flowing lava against a waterlogged fence becomes cobblestone (lava source → obsidian); the fence is never converted to stone and never destroyed by the lava.
- [ ] Save/reload: fire ages and waterlogged bits persist bit-exactly (states array); fire-origin leashes re-anchor at load positions (documented behavior).
