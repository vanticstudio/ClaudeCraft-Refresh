# 11 — THE END (Expansion)

This file owns the **road to and the geography of the End**: the eye of ender item, the overworld **stronghold** structure and its **end portal**, End-dimension terrain (main island, void, outer islands), the static dragon **arena** (obsidian pillars, crystal placement list, exit-portal frame, dragon-egg pedestal position), **end gateways**, **end cities** (+ ship + elytra), **chorus** plants, the **shulker** mob (+ bullet + shulker box), and **elytra** flight physics. Baseline: Java Edition ~1.20 exact values unless marked `(approx)` / `> Adaptation:`.

**Cross-file contract.** The multi-dimension engine — dimension registry, per-dim chunk stores & save keying, per-dim gen-worker dispatch, per-dim environment profiles, the `changeDimension(entity, targetDim, targetPos, opts)` API (10 §2.5), the spawner block, and the items `blaze_rod` / `blaze_powder` — is owned by **10-NETHER**; this file builds on it and registers **dim 2 = `the_end`**. The dragon FIGHT (dragon entity + AI, end-crystal *entities*, boss bar, egg item/behavior, death sequence, gateway *trigger*) is owned by **13-BOSSES**; this file hands 13 a static placement list (§6.6) and owns everything that exists before and after the fight. Status effects (Levitation) are owned by **09-POTIONS**. Enchanted loot items and the anvil/Mending used by elytra repair are owned by **08-ENCHANTING**. Hopper interaction with shulker boxes is **07-REDSTONE**. Emeralds in city loot cross **12-VILLAGES**. All sound-event names in §16 are implemented by **16-AUDIO**. No netcode (14).

## Amendments to base files

- `AMENDS CLAUDE.md §7 (Out of scope v2)`: ensure "the End" is absent from the out-of-scope list (10-NETHER handles "the Nether"). The End is in scope per this file.
- `AMENDS 02 §1.2`: in the "Structures" skip row, remove "strongholds" from the parenthetical. Strongholds generate per §4 of this file (villages/dungeons/mineshafts stay skipped).
- `AMENDS 02 §2.2`: add to the fixed system-name list: `"stronghold"`, `"strongholdLoot"`, `"endchorus"`, `"endcity"`, `"endcityLoot"`.
- `AMENDS 02 §6.1`: append biome id **11 `the_end`** (base temperature 0.5; used only by dim-2 chunks; never selected by the overworld `biomeAt`).
- `AMENDS 02 §13.1`: insert step **6.5 "stronghold rasterization (§4.7 of 11-END): if the chunk intersects the stronghold bounding box, write piece blocks + chest block-entities (after ores, before decoration)"**.
- `AMENDS 03 §4` step 6: insert a new branch **before** the lava/water branches: `if p.gliding: elytraMove(p, input)` (§10.4 of this file). Water/lava overlap forcibly clears `gliding` first (§10.3).
- `AMENDS 03 §12.2`: add row — "Gliding (elytra) | while `v.y > −0.5`: `fallDistance = 1.0` each tick (§10.5 of 11-END)".
- `AMENDS 03 §7.2`: add stop condition row — "Started gliding | elytra deploy clears sprint".
- `AMENDS 05 §2`: the mob roster gains **shulker** (stat block §9.1 of this file; hostile count 6). Shulkers never enter the overworld spawn-weight table.
- `AMENDS 05 §3.2`: the hostile spawn wave becomes dimension-aware: in dim 2 the weight table is **enderman 100** (sole entry); pack size 1–2 for enderman as in base; same cap 40 shared across dimensions (only the active dimension ticks — 10's engine).
- `AMENDS 06 §1`: block ids extend to **150–164** and item ids to **420–424** per §2 of this file (165–169 / 425–434 reserved to this file). `end_portal`, `end_gateway` have **no block-item**; `end_portal_frame` is **debug-palette-only**.
- `AMENDS 06 §7.2`: armor table gains the **elytra** row (§10.1): occupies the **chestplate slot**, 0 armor points, 0 toughness, durability 432, stack 1.
- `AMENDS 06 §14.1`: armor slot 37 (chest) accepts *chestplates or elytra*.
- `AMENDS 08 §8.4` (anvil repair-material table): add row **`elytra (424) → leather`** so 08's `isRepairMaterial` recognizes the pairing; 08's generic unit-repair then applies unchanged — `floor(432/4) = 108` durability per leather, max 4 leather per operation (matching §10.1's stated repair).
- `AMENDS 06 §10 / §11.2`: recipes and the smelting row of §12 of this file are appended to the base lists.
- `AMENDS 06 §12.4`: exception — **chorus fruit can be eaten at foodLevel 20** (vanilla rule); all other foods keep the base restriction.
- `AMENDS 06 §17`: random-tick handler list gains `chorus_flower` (§8.4); neighbor-update reactions gain chorus support pops (§8.5), end-rod support pop, frame/portal rules (§5).
- `AMENDS 06 §18`: block-entity types gain `shulker_box` (27 slots + retained-contents rule §9.4) and `end_gateway` (`{partner:{x,y,z}|null}`); item-stack serialization gains the optional `tags` object introduced by 08-ENCHANTING — this file adds `tags.containerItems` (§9.4).
- `AMENDS 01 §13.2`: EntityManager reaps any non-player entity with `pos.y < −64` (void floor; players die via 03 §13.2 unchanged).

## Contents

1. Scope & handoffs
2. Registry additions (blocks 150–164, items 420–424)
3. Eye of ender
4. Stronghold (overworld structure)
5. End portal (frame, activation, teleport, obsidian platform)
6. End main island generation & arena statics (dim 2)
7. End environment profile (sky/fog/light)
8. Outer islands & chorus plants
9. Shulker, shulker bullet, shulker box
10. Elytra
11. End gateways
12. End cities & the end ship
13. Crafting & smelting additions
14. Texture recipes
15. Loot tables
16. Sound events (for 16-AUDIO)
17. ID assignment summary
18. Acceptance checklist

---

## 1. Scope & handoffs

Progression: enderman pearls (05) + blaze powder (10) → eyes of ender → locate stronghold → fill 12 frames → End (dim 2) → dragon fight (13) → gateways → outer islands → end city → shulker shells + elytra. This file is complete without 13 up to "portal filled"; the arena generates dormant (crystal *positions* only, no entities) until 13 ships.

**Handoff to 13-BOSSES** (data this file computes and exposes, §6.6): pillar list with crystal positions and cage flags, exit-portal cell lists + activation fill set, dragon-egg pedestal position, `spawnGateway(k)` API (§11.2), obsidian-platform regeneration function (§5.6). **Handoff from 13:** 13 calls `spawnGateway`, fills the exit portal, and places the egg. Dragon's-breath bottling is 13/09 scope — this file only notes that `end_gateway`/`end_portal` blocks never interact with bottles.

## 2. Registry additions

### 2.1 Blocks — gameplay table (06 §2 columns)

| ID | Name | Hard | Blast | Tool | Tier | Drops | XP |
|---:|------|-----:|------:|------|------|-------|----|
| 150 | stone_bricks | 1.5 | 6.0 | pickaxe | wood | self | 0 |
| 151 | mossy_stone_bricks | 1.5 | 6.0 | pickaxe | wood | self | 0 |
| 152 | cracked_stone_bricks | 1.5 | 6.0 | pickaxe | wood | self | 0 |
| 153 | iron_bars | 5.0 | 6.0 | pickaxe | wood | self | 0 |
| 154 | end_stone | 3.0 | 9.0 | pickaxe | wood | self | 0 |
| 155 | end_stone_bricks | 3.0 | 9.0 | pickaxe | wood | self | 0 |
| 156 | purpur_block | 1.5 | 6.0 | pickaxe | wood | self | 0 |
| 157 | purpur_pillar | 1.5 | 6.0 | pickaxe | wood | self | 0 |
| 158 | end_rod | 0 | 0 | — | — | self | 0 |
| 159 | chorus_plant | 0.4 | 0.4 | axe | — | 50%: 1 chorus_fruit, else nothing | 0 |
| 160 | chorus_flower | 0.4 | 0.4 | axe | — | self if player-mined; nothing on support-loss pop (§8.5) | 0 |
| 161 | end_portal_frame | −1 | 3600000 | — | — | — | — |
| 162 | end_portal | −1 | 3600000 | — | — | — | — |
| 163 | end_gateway | −1 | 3600000 | — | — | — | — |
| 164 | shulker_box | 2.0 | 2.0 | pickaxe | — | self **with contents retained** (§9.4) | 0 |

### 2.2 Blocks — light / render / physics table (06 §3 columns)

| ID | Name | Emit | Opac | Pass | Shape | Grav | Solid |
|---:|------|-----:|:---:|:---:|-------|:---:|-------|
| 150–152 | stone brick family | 0 | O | op | cube | — | yes |
| 153 | iron_bars | 0 | T | co | custom: pane lattice (2/16 thick, connects like fence rails to solid/pane neighbors) | — | yes (collision: connecting 2/16 panes, height 1.0 — fences stay 1.5) |
| 154 | end_stone | 0 | O | op | cube | — | yes |
| 155 | end_stone_bricks | 0 | O | op | cube | — | yes |
| 156 | purpur_block | 0 | O | op | cube | — | yes |
| 157 | purpur_pillar | 0 | O | op | cube (top/side; always vertical — no axis states `(approx)`) | — | yes |
| 158 | end_rod | **14** | T | co | custom: 4/16 rod along its facing axis + 6/16 base knob | — | no |
| 159 | chorus_plant | 0 | T | co | custom: 10/16 core box + 6/16 arms toward chorus/end-stone neighbors | — | yes (collision: centered 12/16 box, full height `(approx)`) |
| 160 | chorus_flower | 0 | T | co | custom: 14/16 box, open (age<5) vs closed/dead (age 5) texture | — | yes (14/16 box) |
| 161 | end_portal_frame | 0 | O | op | cube (top has socket motif; eye bump overlay when filled) | — | yes `> Adaptation: full 1.0 cube collision (vanilla 13/16)` |
| 162 | end_portal | **15** | T | tr | custom: horizontal quad at 12/16 height, animated starfield (§14) | — | no |
| 163 | end_gateway | **15** | T | tr | custom: same as end_portal but full-cube dark core | — | no |
| 164 | shulker_box | 0 | T | op | cube (purpur-toned lid seam) | — | yes |

State nibbles: `end_rod` bits0–2 facing (0 up, 1 down, 2–5 N/E/S/W wall); placeable on any solid face (floor, ceiling **and** walls — unlike torch), pops if support removed. `chorus_flower` bits0–2 = age 0–5. `end_portal_frame` bits0–1 facing, **bit2 = eye**. `shulker_box` bits0–2 attach face (visual only; always placed upright, 0). `iron_bars`, others: state 0.

### 2.3 Items

| ID | Name | Stack | Notes |
|---:|------|---:|------|
| 420 | eye_of_ender | 64 | §3; also fills frames |
| 421 | chorus_fruit | 64 | food 4 hunger / 2.4 sat + teleport (§8.6) |
| 422 | popped_chorus_fruit | 64 | smelted; crafting material |
| 423 | shulker_shell | 64 | shulker drop |
| 424 | elytra | 1 | durability 432; chest slot; §10 |

## 3. Eye of ender

**Recipe (exact):** shapeless — 1 `ender_pearl` (06 id 334) + 1 `blaze_powder` (10-NETHER) → 1 `eye_of_ender`. Fits 2×2.

**Use (RMB, overworld only).** In dim ≠ 0 the use is a no-op (item kept). In dim 0 the eye launches as a short-lived entity and the stack loses 1.

Target (vanilla: the NW corner of the chunk holding the stronghold's starter staircase; ours: the start-piece center — `> Adaptation:` byte-equivalent for navigation, §4.2 computes `(SX, SZ)` from the first three RNG draws without building the plan):

```
(SX, SZ) = strongholdXZ(worldSeed)          // §4.2
dx = SX − eye.x; dz = SZ − eye.z; f = sqrt(dx² + dz²)
if f > 12:  tx = x + dx/f*12; tz = z + dz/f*12; ty = eyeY + 8     // rise & point (wiki: eye travels up while > 12 blocks away)
else:       tx = SX; tz = SZ; ty = SY (start-piece floor Y)        // within 12 blocks: eye dives — dig here
```

**Entity** (reuses 05 §11's projectile plumbing, no collision, flies through blocks):

| Property | Value |
|---|---|
| Spawn | eye position + look·0.5, AABB 0.25³ |
| Motion | per tick, ease toward target: `v = lerp(v, normalize(target − pos) × 0.35, 0.25)`; no gravity `(approx of vanilla easing)` |
| Trail | 2 portal particles/tick, magenta `#e079fa` (enderman palette, 05 §16.3) |
| Lifetime | **80 ticks** (2–3 s of travel + brief hover: v ×0.5 for the last 20 ticks) |
| Death roll | rolled at launch, vanilla exact: `survives = randInt(5) > 0` → **80% drop / 20% shatter** |
| Drop | becomes an `eye_of_ender` item entity at its position (pickupDelay 10) |
| Shatter | 12 crit-style purple particles + `eye_of_ender.shatter` sound event; nothing drops |

Three consecutive throws shatter at least one eye with p = 1 − 0.8³ = 48.8% — matches wiki. The eye is **not** required to reach the stronghold; it only points.

## 4. Stronghold (overworld structure)

### 4.1 Vanilla placement (reference)

Java 1.20 generates 128 strongholds in 8 rings; the **first ring holds 3 strongholds at 1,280–2,816 blocks** from the origin (then 6 @ 4,352–5,888, 10 @ 7,424–8,960, … 9 @ 22,784–24,320). Generation starts with a spiral-staircase start room into a five-way crossing, expands up to 50 rooms within a 112-block radius, and restarts if no portal room generated.

> Adaptation: **exactly ONE stronghold per world.** Angle and distance are seed-hashed: distance **1200–2000** blocks (compresses ring 1 to a findable range at our travel speeds), expansion capped at ~24 pieces within a 96-block radius, portal room guaranteed by construction (§4.4). No other rings exist; the eye always points at this one.

### 4.2 Deterministic position

```js
function strongholdXZ(worldSeed) {                 // 3 draws — cheap, main-thread safe
  const rng = splitmix32(subSeed("stronghold"));   // 02 §2.2 machinery
  const ang  = rng() * 2 * Math.PI;
  const dist = 1200 + rng() * 800;                 // 1200–2000
  const rot  = rng();                              // start-piece rotation draw (consumed here to pin the stream)
  return { SX: Math.round(Math.cos(ang) * dist), SZ: Math.round(Math.sin(ang) * dist), rot: (rot*4)|0 };
}
```

Start-piece floor `SY = 40`; pieces slope downward, all boxes clamped to **Y 14–46** (prompt band "underground 20–40" holds for room interiors; staircases reach the clamp edges). The stronghold ignores surface terrain entirely (it may sit under an ocean; vanilla-authentic).

### 4.3 Piece palette

All pieces are axis-aligned boxes in one of 4 rotations. "Footprint" = outer box (walls included). Interior air is carved; walls/floors/ceilings are stone-brick family via the mix rule §4.6. Doorways are 3w×3h openings in piece walls: 60% open arch, 20% `oak_door`, 20% `iron_bars` grate (2 columns + top row) — rolled per door from the plan stream.

| Piece | Footprint (w×h×l) | Sockets out | Limit | Weight | Contents |
|---|---|---|---|---:|---|
| Start staircase (spiral) | 5×11×5 | 1 (bottom level) | exactly 1 | — | 5-flight spiral of full blocks descending 6; entry shaft open to nothing (buried) |
| Spiral staircase | 5×11×5 | 1 | 5 | 8 | as start; descends 6 |
| Corridor straight | 5×5×5 | 1 ahead (+ 50% left, 50% right side-sockets) | ∞ | 40 | 0–4 wall torches, 10% each |
| Corridor turn (L/R) | 5×5×5 | 1 | ∞ | 40 | 50/50 left/right |
| Five-way crossing | 10×9×11 | up to 5 (ahead always; each other exit 50%, +x/+z upper exit 2⁄3 — vanilla odds) | 4 | 12 | atrium, 1 torch |
| Chest corridor ("altar") | 5×7×7 | 1 | 4 | 12 | raised 1-block stone-brick altar + **chest** (loot §15.1) |
| Fountain room (large room) | 10×7×10 | up to 3 | 2 | 6 | center 3×3 stone-brick basin, 1 `water` source, 4 torches. `> Adaptation:` only the fountain variant of vanilla's 4 large-room variants ships; empty/pillar/store are cut |
| Library | 13×9×15 (duplex) or 13×5×15 (single) | 0 (dead end) | 2 | 6 | §4.5; duplex preferred, single only if the tall box doesn't fit; **min socket depth 4** (vanilla: never within 4 rooms of start) |
| Prison hall | — | — | — | — | **CUT** (state: iron doors/cells add nothing without captive mobs) |
| Portal room | 11×8×16 | 0 | exactly 1 | forced | §4.4/§5.1; entry door always an iron-bars grate (vanilla) |

### 4.4 Plan algorithm (pure function of seed; cached in worker & main thread)

```
plan = [StartStaircase at (SX, 40, SZ), rot]           // stream continues from §4.2's rng
append FiveWayCrossing at its bottom socket            // vanilla: start stair always exits into a crossing
frontier = crossing's sockets (depth 1)
target = 18 + rngInt(rng, 7)                           // 18–24 pieces
while frontier not empty:
  s = frontier.removeAt(rngInt(len))                   // random socket
  if pieces >= target and !portalPlaced and s.depth >= 5:
      if PortalRoom fits at s (collision test): place; portalPlaced = true; continue
  choose type by weight (skip types at limit; library also requires depth >= 4)
  try 4 candidates (type roll + rotation roll each): place the first whose box
      (a) intersects no existing box, (b) stays in Y 14–46, (c) center within 96 of (SX,SZ)
  placed → push its out-sockets (depth+1); none fit → seal socket with a stone-brick wall
if !portalPlaced: place PortalRoom at the deepest sealed socket, allowing overlap
      (overlapping cells resolve portal-room-wins)      // guarantee, mirrors vanilla's restart rule
```

Every draw happens in the order shown regardless of fit outcomes (draw candidates before testing) so the plan is byte-stable. Expected plan: 20–30 boxes, < 0.2 ms.

### 4.5 Library (cross 08)

Duplex: two 4-high floors; walls lined with `bookshelf` (06 id 50) except door faces — ~180 shelves duplex / ~90 single (vanilla 233/161 with our smaller box `(approx)`); oak-fence railing ring on the upper gallery + 2 ladders; 10 torches. Chests: duplex **2**, single **1**, loot §15.2 — the guaranteed **enchanted book** per chest is the designed bridge into 08's enchanting economy.

### 4.6 Stone-brick family mix

Every wall/floor/ceiling cell of every piece rolls `posHash(subSeed("detail"), x,y,z)`: **< 0.70 → stone_bricks, < 0.90 → mossy_stone_bricks, else cracked_stone_bricks** `(approx of the vanilla ~70/20/10 weathered mix; infested silverfish variants are CUT — no silverfish mob)`.

### 4.7 Rasterization & determinism (02 §13.1 step 6.5)

A chunk intersecting the plan's bounding box iterates intersecting pieces (plan order) and writes each piece's cells clipped to the chunk — structure blocks overwrite terrain, carves and ores; interior cells write `air` (and are never re-filled by later steps). Chest cells append a chest block-entity whose 27 slots are rolled from `splitmix32(mix32(subSeed("strongholdLoot") ^ hash(x,y,z)))` at generation (§15). Torch/water cells participate in lighting normally (04). Chunk regeneration determinism (02 §13.1) holds because the plan and all loot are seed-pure.

## 5. End portal

### 5.1 Portal room layout (local coords: x −5..+5, z 0..15, floor y = yb)

| Feature | Cells |
|---|---|
| Shell | full outer wall/floor/ceiling, stone-brick mix; interior 9×6×14 air |
| Entry | z=0 wall: 3×3 iron-bars grate door (always grated — vanilla) |
| Step | z=7, x −1..+1, y yb+1: stone_bricks (jump-up step; `> Adaptation:` full blocks replace vanilla's 8 stone-brick stairs — no stairs in registry) |
| Lava pool | y yb, x −1..+1, z 9..11: 9 × `lava` source (vanilla 15 in a wider trench `(approx)`) |
| Frame ring | y yb+1, centered (0, z=10): the 5×5 ring **minus 4 corners** = **12 `end_portal_frame`**, each facing inward; stone_bricks fill under each frame at yb |
| Pre-filled eyes | each frame independently rolls `posHash(subSeed("detail"), x,y,z) < 0.10` → eye bit set (**10% per frame, avg 1.2 pre-filled; all-12 chance 10⁻¹²** — vanilla) |
| Spawner | **NONE.** Vanilla places a silverfish spawner atop the step; silverfish are out of scope — the room generates spawner-less. (10-NETHER's spawner block is NOT used here; state explicitly.) |
| Torches | 2 wall torches flanking the entry grate |

### 5.2 Frame block

Unbreakable (hardness −1), explosion-immune. **RMB with `eye_of_ender` on a frame whose eye bit is 0:** consume 1 eye, set bit2, play `portal.frame_fill`, then run §5.3 from this frame. Eyes are never retrievable. RMB with anything else / filled frame: no-op (not `interactable`; placement against it follows base 03 §16 rules).

### 5.3 Activation detection (runs on every eye insertion, incl. debug placement)

```
for cx in fx−2..fx+2:  for cz in fz−2..fz+2:            // candidate 3×3 interior centers
  ring = cells (cx+i, fy, cz+j) where (|i|==2) XOR (|j|==2), |i|,|j| ≤ 2   // 12 cells
  if all 12 are end_portal_frame with eye bit 1:
     set the 9 interior cells (|i|≤1, |j|≤1) at fy to end_portal            // vanilla: overwrites anything, even bedrock
     play portal.activate (global, full volume regardless of distance — vanilla)
     recompute light (end_portal emits 15); return
```

Orientation of frames is NOT checked `(approx — vanilla requires inward facing; gen always faces inward, and survival players cannot obtain frames)`.

### 5.4 End portal block

No collision; renders per §14. Any **living entity or player** whose AABB overlaps an `end_portal` cell teleports instantly (no stand-in delay, vanilla): in dim 0 → `changeDimension(e, 2, obsidianPlatformSpawn)` (10 §2.5; §5.6); in dim 2 (the exit portal, post-13) → `changeDimension(e, 0, respawnPos)` where `respawnPos` = player's bed spawn else world spawn (03 §20.6 rules; no "end poem" — cut). 10's `changeDimension` applies its own re-entry cooldown (≥ 20 ticks). Item entities that touch a portal are teleported too `(approx: dropped at the destination point)`.

### 5.5 Fixed End arrival: the obsidian platform (vanilla exact)

5×5 `obsidian`, top surface **Y = 48**, centered **(100, 0)** — i.e. obsidian fills x 98–102, z −2..2 at y 48 — with the 3 cell-layers above (y 49–51) forced to `air`. Player spawns feet at **(100.5, 49, 0.5), yaw facing west (−X, toward the island), pitch 0**. With our island radius 60–100 (§6.1) the platform usually floats just off the island edge — vanilla-authentic; pearls or bridging cross the gap.

### 5.6 Platform regeneration

`regenObsidianPlatform()` runs **every time** any entity arrives in dim 2 via an end portal: re-set the 25 obsidian, and for each of the 75 cells above, pop any non-air block as its item drop (base break rules, no tool gate) then set air. Exposed by this file; called by 10's `changeDimension` routine (10 §2.5, as its dim-2 `onArrive` hook) and by 13 (respawned-dragon edge cases).

## 6. End main island generation (dim 2 worker)

Registered with 10's engine as dim 2's generator. Reuses 02's noise/RNG machinery with End-scoped layers: `end_shape`, `end_top`, `end_bot`, `end_outer`, `end_outer_t` = `layer2D('end:<name>')`. **No bedrock, no water, no lava (outside stronghold — n/a here), no weather, no biome variety:** `biomes[]` filled with id 11. skyLight arrays are all 0 (profile `hasSkylight: false`, §7).

### 6.1 Main island (columns with `d = sqrt(x²+z²) ≤ 130`)

```
shape   = fbm2(N.end_shape, x, z, {oct:4, freq:1/170})              // [−1,1]
falloff = 1 − smoothstep(60, 100, d + shape*18)                     // 1 at core → 0 at edge (radius 60–100 blob)
if falloff <= 0: column is pure air (void below — §6.5)
surfY = round(60 + 5*falloff + 4*fbm2(N.end_top, x, z, {oct:3, freq:1/55}))    // ≈ 44–69: "Y ~40–70" ✓
botY  = round(surfY − (5 + 34*falloff + 8*(0.5 + 0.5*fbm2(N.end_bot, x, z, {oct:3, freq:1/40}))))
fill end_stone from max(0, botY) .. surfY                            // asteroid: thick center, tapered rim
```

Center columns: surface ≈ 62–69, bottom ≈ Y 15–25. Exit-portal terrain override: within `d ≤ 4`, force `surfY = 62` (end_stone to 62) and clear air y 63–70 except §6.4's cells, so the fountain always sits proud of the terrain.

### 6.2 Void

Below/outside the islands there is **nothing** — no floor at Y 0. Falling entities pass Y 0 into the void; base 03 §13.2 applies verbatim (4 HP/10 ticks below Y −8, ignores i-frames; kill plane −64) and the §Amendments rule reaps non-player entities at −64. Items knocked off the island are gone (vanilla).

### 6.3 Obsidian pillars (End spikes) — vanilla exact, fits Y 0–127

10 pillars on a **radius-43 circle** around (0,0): pillar *i* at `(round(43·cos(2πi/10)), round(43·sin(2πi/10)))`, i = 0..9 (i=0 at +X, CCW). Heights are the vanilla set assigned to the 10 positions by a seeded shuffle (`splitmix32(subSeed("stronghold") ^ 0x51ab)` Fisher–Yates — "random order", wiki):

| Cap Y (H) | 76 | 79 | 82 | 85 | 88 | 91 | 94 | 97 | 100 | 103 |
|---|---|---|---|---|---|---|---|---|---|---|
| Radius r | 3 | 3 | 3 | 4 | 4 | 4 | 5 | 5 | 5 | 6 |
| Caged | no | **yes** | **yes** | no | no | no | no | no | no | no |

Max cap 103 + cage roof 106 + crystal fire — comfortably inside Y 0–127 ✓ (verified; no remap needed). Per pillar: **obsidian** fills every cell with `(x−px)² + (z−pz)² ≤ r² + 1` for `0 ≤ y < H` (columns punch through the island to Y 0, vanilla); one **bedrock** cap at `(px, H, pz)`; crystal position `(px+0.5, H+1, pz+0.5)` (entity — 13's). Cells above the cylinder up to H+10 are forced air (pillar pokes cleanly out of terrain). This per-pillar construction (cylinder + bedrock cap + air clearance + cage below) is factored into a reusable `buildSpike(k)` helper: worldgen calls it for all 10 pillars, and `regenerateSpike(k)` (§6.6) re-invokes it during 13's respawn ritual.

**Cage** (second- and third-shortest pillars — vanilla pre1 rule; wiki: 73 iron bars): for k,l ∈ −2..2, y ∈ H..H+3: place `iron_bars` where (|k|==2 or |l|==2) and y < H+3 (perimeter walls, 16×3) or y == H+3 (full 5×5 roof, 25) → 48+25 = **73** ✓.

> Adaptation (cage material — DECIDED): a real **`iron_bars` block (id 153)** is added rather than reusing oak fence: the pane mesh reuses the fence's neighbor-connect code with a metal texture, and the stronghold portal-room grate (§5.1) and prison-hall aesthetics want it anyway. Fence stays wood-only.

### 6.4 Exit portal ("end fountain") — static, generated dormant

Centered (0, 63, 0), `EXIT_Y = 63`:

| Part | Cells |
|---|---|
| Bedrock rim | y 63: the 5×5 ring minus corners around (0,0) — 12 bedrock |
| Portal bed | y 63: the 8 cells `max(|x|,|z|) ≤ 1` excluding (0,0) — **air until dragon death; 13 sets them to `end_portal`** |
| Column | bedrock at (0, y, 0) for y 63–66 (4 tall) |
| Torches (13 places on activation) | 4 wall torches on column sides at y 65 |
| Egg pedestal (handoff) | dragon egg position = **(0, 67, 0)** — 13 places the egg block/item |

### 6.5 Enderman spawning

05's wave (amended) spawns only endermen in dim 2, on end_stone/obsidian/purpur (all pass `SPAWNABLE_BELOW`'s opaque-full-cube rule), light check trivially passes (all-dark). Endermen here behave per 05 §8.5 unchanged; no water/rain exists to hurt them.

### 6.6 Arena placement export (consumed by 13-BOSSES)

```js
EndArena = {
  pillars: [ { x, z, r, capY, crystal: {x:+.5, y:capY+1, z:+.5}, caged } × 10 ],   // §6.3
  exitPortal: { rim: [12 cells], portalCells: [8 cells], column: [4 cells], torchCells: [4], eggPos: {0,67,0} },
  gatewayPositions: [ 20 positions, §11.1 ],
  regenObsidianPlatform, spawnGateway(k), regenerateSpike(k)
}
```

**`regenerateSpike(k)`** (consumed by 13's respawn ritual, §7.11) rebuilds pillar *k* from the §6.3 `buildSpike(k)` construction: re-fill the obsidian cylinder (`(x−px)²+(z−pz)² ≤ r²+1`, `0 ≤ y < H`), re-place the single **bedrock** cap at `(px, H, pz)`, force air from `H+1` to `H+10`, and — if `PILLAR_POSITIONS[k].caged` — rebuild the 73-`iron_bars` cage (16×3 perimeter + 25 roof, §6.3). It does **not** spawn the crystal entity (13 owns crystals; 13 spawns a fresh invulnerable crystal on the rebuilt cap). Idempotent — safe to call on an already-intact pillar.

## 7. End environment profile (registered with 10's per-dim environment table)

| Field | Value |
|---|---|
| hasSkylight | false — chunk skyLight arrays all 0; 04's initial pass skips sky seeding; `skyDarken` irrelevant |
| Day cycle / celestial | none: no sun, moon, stars, sunrise band, clouds, or weather; worldTime still advances globally (beds: see below) |
| Sky dome | static gradient, zenith `#100A18`, horizon `#1B1426`; below-horizon hold ×0.8 as base. Shader note: add `uStatic: 1` → fragment adds `(hash(dir.xy*613.7) − 0.5) * 0.035` grain — the End's void-purple "static" `(approx)` |
| Fog | color `#14101E`, near `0.5·R`, far `R` (R per 04 §7); no weather modulation |
| Scene lights (entities) | DirectionalLight intensity 0.12 (direction (0.3,−1,0.2) fixed), AmbientLight 0.25 — constant |
| Brightness floor | rendered brightness uses 04 §11's curve with a dim-2 ambient floor: `level' = max(level, 3)` before the curve `(approx of vanilla's flat End lighting — keeps end stone readable while torches still matter)` |
| Beds | sleeping is always denied in dim 2 with the toast "You may not rest here". `> Adaptation:` vanilla beds explode (power 5 + fire) in the End; the explosion gag is cut — denial only. Bed spawn-point setting is also denied |
| Respawn | dying in the End respawns in the overworld per 03 §20.6 (dim-0 bed/world spawn — 10's engine owns cross-dim respawn routing) |

## 8. Outer islands & chorus plants

### 8.1 Void gap and island belt

Columns with `130 < d < 1000` generate **empty chunks** (pure air — the vanilla ~1000-block gulf). For `d ≥ 1000`:

```
t = smoothstep(1000, 1040, d)                                    // belt fade-in
n = fbm2(N.end_outer, x, z, {oct:4, freq:1/90})                  // [−1,1]
if n*t <= 0.28: air column
else:
  m     = (n*t − 0.28) / 0.72                                    // 0..1 island mass
  surfY = round(55 + 10*fbm2(N.end_outer_t, x, z, {oct:3, freq:1/70}))   // 45–65
  fill end_stone from surfY − round(3 + 24*m) .. surfY
```

Yields islands tens-to-hundreds of blocks wide with thin rims and chunky cores, separated by pearl-able gaps; extends infinitely.

### 8.2 Chorus worldgen ("chorus trees")

Decoration stream `"endchorus"`, origin-chunk re-simulation radius 1 (02 §10.1 pattern). Per chunk fully beyond d 1008: **2 attempts**: pick (x,z); require `end_stone` surface with 2 air above; place `chorus_plant` at surfY+1 and a `chorus_flower` age 0 at surfY+2, then run **16 iterations** of the §8.4 growth step against the chunk stream (writes clipped to the generating chunk); finally set every surviving flower to **age 5** (worldgen chorus is fully grown — wiki). Plant heights emerge 5–22, mode 13–16 — matches wiki's measured distribution.

### 8.3 Chorus blocks

- **chorus_plant** (stem): drops 0–1 chorus fruit (50/50). Placeable only on end_stone or chorus_plant (item exists via auto block-item; survival source = mining stems).
- **chorus_flower**: plantable on **end_stone** only (any dimension, light-independent — vanilla). Drops itself only when broken directly by the player or a projectile hit; support-loss pops drop nothing.

### 8.4 Chorus flower growth (random tick; wiki-exact odds)

```
if age == 5 or block above not air: return                 // dead flowers & capped columns never age
stem  = count of consecutive chorus_plant directly below (0..4+)
onEndStone = block below the stem's lowest plant is end_stone (stem==0: block below flower)
branched   = the cell below the lowest stem block is air   // "branch" = stem hangs off a side arm
pUp = stem <= 1 ? 1.00
    : stem == 2 ? (onEndStone ? 0.60 : 0.50)
    : stem == 3 ? (onEndStone ? 0.40 : 0.25)
    : stem == 4 && onEndStone ? 0.20 : 0.00
if rand() < pUp AND above is air AND its 4 horizontal neighbors are air AND 2-above is air:
    this cell → chorus_plant; cell above → chorus_flower (same age); play chorus.grow; return
if age < 4:                                                 // try branching
    tries = 1 + randInt(4) − (branched ? 1 : 0)             // 1–4 unbranched, 0–3 branched (wiki)
    grew = false
    repeat tries: dir = random horizontal; c = flower + dir
        if c is air AND c.below is air AND c's other 3 horizontal neighbors are air:
            c → chorus_flower (age + 1); grew = true
    if grew: this cell → chorus_plant; play chorus.grow; return
age → 5 (dead: white→purple-closed texture); no further ticks    // "no growth ⇒ age 5" (wiki)
```

Bone meal has **no effect** on chorus (vanilla).

### 8.5 Chorus support rule (neighbor update)

A `chorus_plant`/`chorus_flower` survives iff the block below is `end_stone` or `chorus_plant`, **or** at least one horizontal neighbor is a `chorus_plant`. Otherwise it breaks (plant: 50% fruit; flower: nothing), issuing neighbor updates — chopping the base dissolves the whole tree top-down over successive updates, cactus-style. `> Adaptation:` vanilla's extra "a horizontal neighbor only supports if it itself is supported below and the plant lacks both vertical contacts" refinement is dropped; cascades still collapse felled trees within a few ticks.

### 8.6 Chorus fruit & popped chorus fruit

**chorus_fruit** — food: hunger **4**, saturation **2.4** (06 §7.3 format), edible even at foodLevel 20, 20-tick item cooldown after eating. On successful consumption, attempt the enderman-style teleport (vanilla: up to 8 blocks):

```
16 attempts: tx = x + (rand()−0.5)*16; ty = clamp(y + randInt(16) − 8, 1, 126); tz = z + (rand()−0.5)*16
  c = seekDownStandable(floor(tx), floor(ty), floor(tz), 8, height=2)     // 05 §8.5 helper, non-liquid
  success → teleport player (velocity zeroed, fallDistance 0), play chorus.teleport at both ends, stop
all fail → no teleport (food still consumed)
```

**popped_chorus_fruit** — furnace: `chorus_fruit → popped_chorus_fruit`, **XP 0.1**, standard 200 t. Not edible; pure material (§13).

## 9. Shulker, shulker bullet, shulker box

### 9.1 Shulker stat block (05 §2 format)

| Stat | Shulker |
|---|---|
| HP | **30** |
| AABB (w×h) | 1.0×1.0 closed / 1.0×1.2 peeking / 1.0×2.0 open (hitbox height follows peek state) |
| Natural armor pts | **20 while fully closed (peek 0), 0 otherwise** — through 05 §14.2's formula, toughness 0 |
| Movement | none — stationary, gravity-exempt, never pushed (excluded from 01's entity-overlap resolution) |
| Attack | shulker bullet: 4 damage + Levitation I 10 s (§9.3) |
| Fire interval | 20 + randInt(40) ticks while open with target `(approx of vanilla's randomized 1–3 s bursts)` |
| Detection range | 16, requires LOS (05 §6 raycast) |
| XP on death | 5 |
| Burns in daylight | no; immune to fire/lava damage (vanilla); drowns in water per base rules |
| Drops | **50%: 1 shulker_shell** (vanilla Java, no Looting) |
| Spawning | never from the wave — only end-city spawn records (§12.4), `persistent = true`, never despawns |

### 9.2 Behavior state machine (replaces the goal list; LOOK-only head tracking still applies)

- **Attachment.** State nibble stores the attached face. Spawn/teleport attaches to the first valid full solid face in the order **below, above, N, S, W, E** (vanilla order). Each tick: if its own cell is non-air-other-than-itself, its attach face is gone, or (opening) the space is blocked → **teleport attempt every tick** until success or re-attachment.
- **Peek levels**: 0% (closed), 30% (peeking), 100% (open). Idle: every 20 ticks, 10% → peek 30 for 40+randInt(40) ticks, else close. Target acquired (player ≤ 16 + LOS, scan every 10 ticks): open 100 and hold; target lost 60 ticks → close. Lid animation: 4 ticks per level change; armor flips exactly when peek leaves/reaches 0.
- **Fire**: while open with LOS ≤ 16: on timer expiry spawn a bullet at the shell mouth, play `shulker.shoot`, reset timer.
- **Hurt**: while closed, arrows **deflect** (reflect arrow velocity ×−0.3, no damage, metallic `shulker.hurt_closed`); melee/explosions apply vs 20 armor. Any damage taken while `health < 15` → **25% chance** to teleport (vanilla `nextInt(4)==0`). When one shulker is hurt, all shulkers within a 32×20×32 box also target the attacker (vanilla).
- **Teleport**: 5 attempts, each a uniform cell in the **17×17×17 cube** centered on itself; cell must be air, non-liquid, with ≥ 1 adjacent full solid face. Success: relocate (no particles trail — play `shulker.teleport`), close, clear bullet in flight. **Shulker duplication (bullet-on-shulker cloning) is CUT** — no shulker farms; state it.
- Body yaw fixed by attach face; head (when open) tracks per 05 §16.3.

### 9.3 Shulker bullet (projectile; 05 §11 plumbing)

| Property | Value |
|---|---|
| Entity | 0.3125³ AABB, no gravity, emits small end-rod-white particles 1/tick |
| Steering | axis-zigzag homing `(approx of vanilla's axis-picking)`: every 20 ticks (or when the current axis' delta flips sign) pick the coordinate axis with the largest \|target − pos\| component; `targetV = axisUnit·sign · 0.15` plus `0.05·normalize(delta)` on the other axes; per tick `v += (targetV − v) × 0.2` → cruise ≈ 3 m/s with staircase wobble |
| On entity hit | 4 damage (armor-reducible, source = shulker) + apply **LEVITATION I, 200 ticks** via 09-POTIONS; bullet pops |
| On block/lava contact | pops (puff of 6 white particles + `shulker_bullet.pop`) |
| Shootable | player melee (hitbox inflated +0.5 for attacks) or arrow destroys it — pops harmlessly |
| Lifetime | 600 ticks or target dead/lost > 48 blocks → pops |

Levitation is the shulker's signature: 10 s of drifting upward (09 owns the effect math), then the fall — in end cities that fall can be lethal; that is vanilla's design and stays.

### 9.4 Shulker box (block 164; one color — purpur-toned "shulker purple")

- **Container**: 27 slots, chest UI reused (06 §14; title "Shulker Box"). Opens regardless of blocks above `(approx — vanilla needs lid room)`. Hoppers (07-REDSTONE) interact exactly as with chests.
- **Retention (the whole point)**: breaking a shulker box always drops **one `shulker_box` item whose `tags.containerItems` array holds the 27 serialized stacks** (extends 08's item-`tags` mechanism; slots `{slot, id, count, damage?, tags?}` — nesting is legal but a shulker box item may NOT be placed inside a shulker box (vanilla); the UI rejects the insert). Placing the item restores the block entity contents; the block-item tooltip lists the first 5 stacks + "and n more..." `(approx of vanilla tooltip)`.
- Explosion-destroyed shulker boxes drop the same retained item (blast 2.0 but the *drop* always survives, vanilla).
- Not a fuel; piston/comparator interactions n/a.
- **Recipe** (vanilla shape): `S/C/S` column — shulker_shell / chest / shulker_shell → 1 shulker_box.

## 10. Elytra

### 10.1 Item

Durability **432**; loses **1 per second (every 20 full ticks) of gliding**; total ≈ 7 min 12 s of air time. At **durability 1 the elytra stops functioning but does not break**: it stays equipped in a "tattered" state (sprite variant §14) and cannot deploy (`flightEnabled = durability > 1`, vanilla). Occupies the **chestplate slot** (0 armor — wearing it is a defensive sacrifice); RMB with it in hand auto-equips (06 §7.2 rule).

**Repair** `> Adaptation (DECIDED):` vanilla repairs with phantom membranes (108 durability each = 25%); there are no phantoms, so the anvil (08-ENCHANTING) accepts **leather, 108 durability per leather, up to 4** — which is literally the pre-1.13 vanilla behavior. **Mending (08) works** (1 durability per XP). Firework rocket boosting **does not exist** (no fireworks — glide only, state in UI nothing). No fire immunity of any kind.

**Source:** end-ship treasure chest only (§12.5). No recipe.

### 10.2 Activation / deactivation

Deploy: **jump key press (edge)** while `!onGround && !gliding && !inWater && !inLava && !onLadder && !flying(debug) && v.y < 0.1` and a working elytra (durability > 1) is in the chest slot. (Levitation blocks deployment — 09 hook.) Deploy clears sprint and plays `elytra.deploy`.
End glide when: `onGround` (landing), water/lava overlap, elytra removed/reaches durability 1, or death. **No manual mid-air cancel** (Java parity; Bedrock's jump-to-stop is not implemented).

### 10.3 Tick integration

Per the 03 §4 amendment, `elytraMove` replaces the land/fluid branch. WASD input is **ignored entirely while gliding** (vanilla): steering is look-direction only; sprint key does nothing. Mining/using items while gliding is allowed (base rules; the ÷5 airborne mining penalty applies).

### 10.4 Per-tick glide physics — transcribed from the decompiled Java `LivingEntity.travel()` fall-flying branch (exact)

Convention: base 03 pitch is **positive looking up** (MC's xRot is the negation; cos is even, so only the lift-branch sign changes). `look` = unit camera vector; our look vector has length exactly 1, so vanilla's `min(1, |look|/0.4)` factor is identically 1 (noted, dropped).

```
function elytraMove(p, input):
  θ      = p.pitch (radians, + up)
  look   = unit look vector;  hLook = sqrt(look.x² + look.z²)
  hSpeed = sqrt(v.x² + v.z²)                       // sampled BEFORE the update
  cos2   = cos(θ)²                                  // pitch-based lift coefficient

  v.y += 0.08 * (−1 + cos2 * 0.75)                  // gravity −0.08, lift up to +0.06 level

  if v.y < 0 and hLook > 0:                         // falling: convert sink into forward speed
      d = v.y * −0.1 * cos2
      v.x += look.x * d / hLook;  v.y += d;  v.z += look.z * d / hLook

  if θ > 0 and hLook > 0:                           // pitched up: trade speed for altitude
      g = hSpeed * sin(θ) * 0.04
      v.x −= look.x * g / hLook;  v.y += g * 3.2;  v.z −= look.z * g / hLook

  if hLook > 0:                                     // align velocity to look direction (turning drains speed)
      v.x += (look.x / hLook * hSpeed − v.x) * 0.1
      v.z += (look.z / hLook * hSpeed − v.z) * 0.1

  v.x *= 0.99;  v.y *= 0.98;  v.z *= 0.99           // drag
  moveAndCollide(p, v.x, v.y, v.z)                  // 01 primitive

  if horizontalCollision:                           // kinetic-energy wall crash (vanilla exact)
      hAfter = sqrt(v.x² + v.z²)                    // post-collision (clipped axes are zeroed)
      dmg = (hSpeed − hAfter) * 10 − 3
      if dmg > 0: damage(p, ceil(dmg), FLY_INTO_WALL)   // armor does NOT reduce (fall-class source, 05 §14.2 table)

  if onGround: p.gliding = false                    // landing ends the glide
  glideTicks++; every 20: elytra.durability −= 1; at 1 → p.gliding = false (tattered)
```

**Emergent numbers (test targets, all wiki-verified):** level glide (θ=0): equilibrium ≈ 1.62 b/t horizontal ≈ **30–33 m/s**, sink ≈ 3.2–3.4 m/s, glide ratio ≈ **9.5 : 1**; minimum airspeed ≈ **7.2 m/s** at θ = +30° (higher pitch = stall); lowest sink rate ≈ **1.5 m/s** at θ ≈ +12–15°; steep dives peak ≈ **67 m/s** (approaching −78.4 terminal at −90°); sharp turns bleed speed via the ×0.1 alignment term.

### 10.5 Fall damage while gliding (vanilla rule)

Each glide tick with `v.y > −0.5`: `fallDistance = 1.0` (03 §12.2 amendment). Hence shallow landings (sink < 10 m/s) are free — ceil(1−3) ≤ 0 — while stalls and dives (v.y ≤ −0.5 sustained) accumulate distance normally and hurt on impact. Wall crashes use §10.4's kinetic formula instead ("<player> experienced kinetic energy" as the death-screen flavor line `(approx)`).

### 10.6 Camera, viewmodel, audio

First-person only (base has no player model, so wings never render on the player — the equipped item + HUD armor slot communicate state). Held item viewmodel stays visible (vanilla). FOV: `targetFovScale = 1.1` while gliding and `hSpeed > 1.0 b/t` `(approx)`. Sound: `item.elytra.loop` (16 §3.5) while gliding, volume/pitch scaled by `clamp(hSpeed/1.6, 0, 1.3)` (16-AUDIO implements; this file emits state). No third-person mode (03 decision stands).

## 11. End gateways

### 11.1 Spawning (13 triggers; this file owns block + positions + teleport)

After each dragon death, 13 calls `spawnGateway(k)` (k = 1-based kill count, **max 20** — later kills spawn none). Position = the k-th entry of a seeded permutation (`splitmix32(subSeed("stronghold") ^ 0x9e77)`) of the 20 vanilla positions — **radius-96 circle at Y 75**, 18° apart (exact vanilla table): (96,0), (91,29), (77,56), (56,77), (29,91), (−1,96), (−30,91), (−57,77), (−78,56), (−92,29), (−96,−1), (−92,−30), (−78,−57), (−57,−78), (−30,−92), (0,−96), (29,−92), (56,−78), (77,−57), (91,−30).

**Structure** (13 places via this file's helper): gateway block G at (gx, 75, gz); **12 bedrock** in the vanilla bipyramid: tips (0,±2,0) relative to G, plus the 4-cell plus-rings {(±1,±1·0),(0,±1,±1)} at y ±1 — the y = 0 sides stay **open** (the 1-block gap you throw a pearl through). On spawn: vertical magenta beam (top+bottom) for **200 ticks**; on every use, beam for **40 ticks** (render: 2-block-wide additive quad column, `#D67FFF`, full world height `(approx)`; `gateway.beam` sound event).

### 11.2 Teleport behavior (block 163)

Trigger: any entity's AABB overlaps the gateway cell. The practical entries: a **thrown ender pearl** entering the cell — the pearl entity is cancelled (no 5 self-damage, no pearl teleport) and the **thrower** travels — or an **elytra flight** into the gap `> Adaptation: the pearl-relay (vanilla teleports the pearl entity itself) is collapsed into directly sending the thrower; net effect identical`.

- **Main-island gateway, first use:** compute the destination and generate the far side, then link both ends.
  - Direction `u = normalize(gx, gz)`. Scan `d` from **1024 down to 768** in 16-block steps `(vanilla order — take the furthest-in valid chunk)`, then upward 1040→1400 if none valid: a candidate is valid if the chunk containing `d·u` has any end-stone column (§8.1 test at its 4 sample columns). In the found chunk take the column nearest `d·u` with end stone; `exit = (cx, topEndStoneY + 1, cz)`. If genuinely nothing (all-void ray): force a **5×5 end_stone platform** at (1024·u, Y 60) and exit there (vanilla generates a platform too).
  - Spawn the **return gateway**: same 12-bedrock structure centered `(exit.x + 4, exit.y + 8, exit.z)`; link `partner` fields both ways (block-entity data, persisted).
- **Any linked gateway:** teleport the traveler to the **landing point near its partner**, per the vanilla search: scan the 11×11 columns within radius 5 of the partner gateway (NW corner first, +Z then +X), from the top of the world downward, skipping all cells adjacent (incl. diagonals/above/below) to the gateway block; land on the first non-bedrock full block found (feet on top). If the whole scan fails: land exactly **2 blocks above the partner gateway block**.
- Cooldown: an entity that just arrived cannot re-trigger any gateway for 40 ticks.
- Return gateways bring you back to the main-island gateway's landing point (near the island edge; vanilla's "back to the platform" variant is not used — the pairing is symmetric, simpler, and marked `(approx)`).

## 12. End cities & the end ship

### 12.1 Placement

Region = 8×8 chunks (128×128 blocks) in dim 2. Per region beyond d 1024: `rng = splitmix32(chunkSeed(subSeed("endcity"), rgx, rgz))`; **attempt iff `rng() < 0.25`**. Pick a column in the region (2 draws); require §8.1 island mass `m ≥ 0.35` there and surface Y ≥ 50 → city origin (base platform top = surfY + 1). Net density ≈ 1 city per 5–8 regions of island belt `(approx — vanilla spacing 20 / separation 11 chunks)`. The city plan (like §4.4: a socket/frontier grammar off the region stream) is a pure function of the region seed; chunks rasterize their slice (stronghold pattern, radius: plans are capped to ±80 blocks of origin → re-sim radius covers 6 chunk rings).

### 12.2 Piece grammar

| Piece | Size | Rule | Contents |
|---|---|---|---|
| Base platform | 12×3×12 | always, at origin | end_stone_bricks slab-block foundation into the terrain |
| Base tower (3 floors) | 10×15×10 | always, on platform | purpur walls, purpur_pillar corner columns, floor rings; interior spiral of full purpur blocks (parkour steps — `> Adaptation:` replaces vanilla's purpur-slab stair spiral; no slabs); 4 end_rods per floor |
| Tower section | 8×8×8 | stack 1–3 (rng) atop base/other towers | continues the spiral; 30% one shulker record each |
| Bridge | 3 wide × 12+rngInt(9) long | from each tower-top cardinal: **50%** | purpur deck, end-rod posts every 4; leads to: 60% new tower (one section shorter), 25% loot room, 15% open balcony dead-end |
| Loot room | 9×7×9 | via bridges | purpur shell, end-stone-brick floor, **2 chests** (§15.3), 2 shulker records, 2 end_rods |
| Ship | see §12.5 | per bridge **12.5%**, **max 1 per city** (vanilla) | the elytra |

Banners: **CUT** (no banner block; state). Shulker records: spawn-record format of 02 §11, consumed once (`persistent: true`).

### 12.3 Materials

`purpur_block`, `purpur_pillar`, `end_stone_bricks`, `end_rod` (light 14 — cities glow at night-less End), `chest`, `shulker_box` (1 per city, decorative bonus containing 1 §15.3 roll `(approx flourish)`).

### 12.4 Shulker population

Base tower 1 record + per §12.2 rows; a typical city carries 4–8 shulkers, a ship exactly 3 (deck, stern, treasure room — vanilla).

### 12.5 End ship

Floating hull ~9×12×24 (purpur + end_stone_bricks), stern facing the city, moored 6 blocks off the bridge's arch end (gap requires pearl/bridge/glide — vanilla). Mast (purpur_pillar column ~12) with empty crow's nest; below-deck **treasure room**:

- **Elytra chest** (center, where vanilla hangs the item-frame): contains **1 elytra (guaranteed)** + 3 rolls of §15.3. `> Adaptation:` item frames don't exist; the frame becomes a chest — stated.
- 1 standard loot chest (§15.3, full 2–6 rolls).
- Dragon head at the bow: **CUT** (no head block; state). Brewing stand + 2 Healing potions: **CUT from the ship** (09's brewing gear is obtained in 09/10's own progression; state).
- 3 shulker spawn records (§12.4).

## 13. Crafting & smelting additions (append to 06 §10/§11.2)

| Output ×qty | Type | Pattern / ingredients | Key | 2×2 |
|---|---|---|---|:--:|
| eye_of_ender ×1 | shapeless | ender_pearl + blaze_powder (10) | — | ✔ |
| end_stone_bricks ×4 | shaped | `EE/EE` | E end_stone | ✔ |
| purpur_block ×4 | shaped | `PP/PP` | P popped_chorus_fruit | ✔ |
| purpur_pillar ×2 | shaped | `B/B` | B purpur_block — `> Adaptation:` vanilla uses purpur slabs (cut) | ✔ |
| end_rod ×4 | shaped | `R/P` | R blaze_rod (10), P popped_chorus_fruit | ✔ |
| shulker_box ×1 | shaped | `S/C/S` | S shulker_shell, C chest | |
| stone_bricks ×4 | shaped | `SS/SS` | S stone (smelted, 06 §11.2) | ✔ |

Smelting: `chorus_fruit → popped_chorus_fruit`, XP **0.1**. Mossy/cracked stone bricks have **no recipe** (stronghold-mined only; cracked via smelting stone_bricks → cracked_stone_bricks, XP 0.1 — vanilla). None of the new items are furnace fuel.

## 14. Texture recipes (06 §4/§8 vocabulary)

| Block | Recipe |
|---|---|
| stone_bricks | `noise(#7f7f7f, 8)` + 1px #565656 mortar grid of 4×4 brick cells |
| mossy_stone_bricks | stone_bricks + 25% of pixels recolored `#5d7a4a` in 2–3 px blobs |
| cracked_stone_bricks | stone_bricks + 2 jagged 1px #3f3f3f crack polylines |
| iron_bars | transparent; vertical 1px `#a8a8a8` bars at x = 1,5,9,13 + 1px top/bottom rails, ±8% value noise |
| end_stone | `blotch(#dbe2a4, #c8cf8e, 10)` + 6% `#eef2c0` flecks (pale curdled yellow) |
| end_stone_bricks | end_stone base + 1px #b5bc7f mortar, 4×4 cells |
| purpur_block | `noise(#a878a8, 6)` + 2–4 px `#c39cc3` rounded blobs with 1px #8a5f8a outline |
| purpur_pillar | side: purpur + 2px vertical #8a5f8a channels at x=3,12; top: `rings(#c39cc3, #a878a8)` |
| end_rod | `cross_sprite`: 2px white `#f6f0fa` rod rows 2–13 with #d67fff 1px tip glow (emissive), 6×2 purpur base knob |
| chorus_plant | `noise(#5c4a72, 8)` + 1px darker #46375a rim, 10% #7a6396 warts |
| chorus_flower | age<5: `noise(#f4eef8, 6)` white bud + #5c4a72 frame; age 5: `noise(#8a63a8, 6)` closed + darker frame |
| end_portal_frame | top: end_stone base + centered 8×8 #3a5f4a socket ring; eye overlay: 6×6 `#7fe3c8` iris + #143028 slit (emissive); sides: end_stone + #46375a band |
| end_portal / end_gateway | shader block: base `#0a0714`; 2-frame drifting 1px starfield (60 random pixels `#8fd8c8`/`#d67fff`/`#ffffff` at 30–80% alpha), UV scroll 0.25 px/t; gateway adds a solid black core |
| shulker_box | `noise(#976b97, 6)` + 1px lid seam #6e4a6e at row 8 + 4 corner rivets #c39cc3 |

Items: `eye_of_ender` = ender-pearl sprite recolored `#7fe3c8` with #143028 pupil slit; `chorus_fruit` = 10×10 lumpy `#5c4a72` cluster with #7a6396 highlights; `popped_chorus_fruit` = same silhouette recolored `#c39cc3`/#f4eef8; `shulker_shell` = 12×8 dome `#976b97` with rim shading; `elytra` = two swept 6×12 wings `#4a4a52` with 1px #8a8a96 ribs (tattered variant: 3 notches punched per wing, used at durability 1). Icon pipeline per 06 §8.2 unchanged.

## 15. Loot tables (rolled at generation from `"strongholdLoot"` / `"endcityLoot"` streams; weights sum per pool)

### 15.1 Stronghold altar chest `(approx of 1.20 stronghold_corridor — saddle/horse armor/discs/golden apple cut)`

Pool A ×2–3 rolls: ender_pearl w10 ×1 · diamond w3 ×1–3 · iron_ingot w10 ×1–5 · gold_ingot w5 ×1–3 · redstone w8 ×4–9 · bread w15 ×1–3 · apple w15 ×1–3 · iron_pickaxe w5 ×1. Pool B ×1 roll: **enchanted book** (08's loot-enchant rule, levels 20–30) — 100%.

### 15.2 Stronghold library chest `(approx of stronghold_library — maps/compasses cut)`

Pool A ×2–10 rolls: book w20 ×1–3 · paper w20 ×2–7. Pool B ×1 roll: **enchanted book** (08, levels 20–30) — 100%.

### 15.3 End city chest `(approx of end_city_treasure — beetroot seeds/saddle/horse armor cut; emerald crosses 12)`

Pool ×2–6 rolls: gold_ingot w15 ×2–7 · iron_ingot w10 ×4–8 · diamond w5 ×2–7 · emerald w2 ×2–6 (12-VILLAGES item; if 12 is not built, substitute diamond ×1–2 — state in DEVIATIONS) · **enchanted diamond** sword/pickaxe/shovel/helmet/chestplate/leggings/boots w3 each ×1 (08 loot-enchant, levels 20–39) · **enchanted iron** same 7 pieces w3 each ×1 (levels 20–39).

### 15.4 Ship elytra chest

1 × elytra (guaranteed, full durability) + 3 rolls of §15.3.

## 16. Sound events (implemented by 16-AUDIO; this file emits the triggers)

| Event | Trigger | Character hint |
|---|---|---|
| `eye_of_ender.launch` | eye thrown | airy whoosh + chime |
| `eye_of_ender.drop` | 80% survival drop | soft pop |
| `eye_of_ender.shatter` | 20% break | glass crack |
| `portal.frame_fill` | eye seated in frame | stone clunk + hum tick |
| `portal.activate` | 12th eye (GLOBAL, distance-independent) | deep roar swell |
| `portal.travel` | any end-portal/exit-portal teleport | reversed suck + shimmer |
| `gateway.beam` | gateway spawn (200 t) / use (40 t) | rising drone |
| `gateway.travel` | gateway teleport | as portal.travel, higher pitch |
| `chorus.grow` | successful flower growth | low wooden bloop (wiki: enderman-like, low pitch) |
| `chorus.teleport` | chorus fruit teleport (both ends) | enderman-teleport variant |
| `chorus.break` | chorus block pop | wet snap |
| `shulker.open` / `shulker.close` | peek transitions | creaky shell hinge |
| `shulker.shoot` | bullet fired | percussive spit |
| `shulker.teleport` | shulker relocates | short warp |
| `shulker.hurt_closed` | deflected/armored hit | metallic tink |
| `shulker_bullet.pop` | bullet destroyed/hits | small firework pop |
| `elytra.deploy` | wings open | canvas snap |
| `item.elytra.loop` | while gliding (speed-scaled) | wind rush loop |

## 17. ID assignment summary

| Range | Assigned | Free |
|---|---|---|
| Blocks 150–169 | 150 stone_bricks · 151 mossy_stone_bricks · 152 cracked_stone_bricks · 153 iron_bars · 154 end_stone · 155 end_stone_bricks · 156 purpur_block · 157 purpur_pillar · 158 end_rod · 159 chorus_plant · 160 chorus_flower · 161 end_portal_frame · 162 end_portal · 163 end_gateway · 164 shulker_box | 165–169 |
| Items 420–434 | 420 eye_of_ender · 421 chorus_fruit · 422 popped_chorus_fruit · 423 shulker_shell · 424 elytra | 425–434 |

External references: `blaze_powder`/`blaze_rod`/spawner/dim engine (10-NETHER), enchanted book + `tags` + anvil + Mending (08), Levitation (09), emerald (12), hoppers (07), all audio (16), dragon/crystal entities/egg/boss bar (13).

## 18. Acceptance checklist

Eye of ender & stronghold
- [ ] Pearl + blaze powder crafts an eye; RMB launches it: it climbs ~8 blocks while > 12 blocks from the stronghold and flies ~12 blocks toward `strongholdXZ(seed)` with a purple trail; over the start piece (< 12 blocks) it dives instead.
- [ ] Over 100 throws: 80% ±5 pp drop a collectable eye after ~4 s; the rest shatter with particles; the eye item count decrements exactly 1 per throw.
- [ ] `strongholdXZ` for a fixed seed is identical on main thread and worker; distance from origin ∈ [1200, 2000]; two worlds, same seed → same stronghold, byte-identical chunks (02's determinism tests extended over the stronghold box).
- [ ] The stronghold contains: ≥ 10 corridors, ≥ 1 five-way crossing, 1–4 altar chests, ≤ 2 libraries (never < depth 4, bookshelf-lined, ≥ 1 chest each with a guaranteed enchanted book), exactly **one** portal room; all pieces within Y 14–46 and 96 blocks of the start; stone-brick cells mix ≈ 70/20/10 plain/mossy/cracked.
- [ ] Portal room: 12 inward-facing frames on the 5×5-minus-corners ring over a 3×3 lava pool, iron-bars entry grate, NO spawner; ~1.2 frames pre-filled on average (10% each, posHash-stable across regen).

End portal & arrival
- [ ] Filling the last empty frame flips the 3×3 interior to `end_portal` (light 15) and fires the global activation sound; frames/eyes are unbreakable and eyes non-retrievable.
- [ ] Stepping into the portal teleports instantly to dim 2 at feet (100.5, 49, 0.5) facing −X on a fresh 5×5 obsidian platform at Y 48; re-entering later regenerates the platform and pops any player blocks in the 5×5×3 space above as items.

End main island & arena
- [ ] Main island: end-stone blob, edge radius 60–100, surface Y 44–69, no bedrock/water/lava anywhere in dim 2; skyLight = 0 everywhere; walking off the edge → void damage below Y −8, death by −64; dropped items vanish at −64.
- [ ] Exactly 10 obsidian pillars on the radius-43 circle with cap Ys {76…103}, radii {3,3,3,4,4,4,5,5,5,6}, seeded shuffle stable per seed; each has 1 bedrock cap; crystal positions exported at cap+1; the 79 and 82 pillars carry 73-iron-bar cages (16×3 perimeter + 25 roof).
- [ ] Exit portal at (0,63,0): 12-bedrock rim, 4-tall bedrock column, 8 portal-bed cells AIR until 13 activates them; egg position (0,67,0) exported; hostile waves in dim 2 spawn only endermen.
- [ ] End sky: static #100A18→#1B1426 gradient with grain, no sun/moon/stars/clouds/weather/day-cycle; fog #14101E; brightness floor ≈ level 3; beds refuse with a toast and set no spawn.

Outer islands, chorus, gateway
- [ ] Chunks in 130 < d < 1000 are pure void; islands appear past 1000 with end-stone tops Y 45–65 and chorus trees (heights 5–22, mode 13–16, flowers age 5).
- [ ] Live chorus growth matches §8.4: planted flower on end stone grows/branches with the listed odds, dies to age 5 when blocked, bone meal inert; chopping a stem collapses everything above within ticks; stems drop fruit 50%.
- [ ] Chorus fruit eats even at full hunger (4 / 2.4), then teleports ≤ 8 blocks to a standable cell (or not at all), 1 s cooldown; smelts to popped (0.1 XP); 4 popped → 4 purpur; blaze rod + popped → 4 end rods (light 14, attach to all 6 face types, pop on support loss).
- [ ] `spawnGateway(k)` places the k-th of the 20 seeded positions (radius 96, Y 75, 12-bedrock bipyramid with open sides) and never a 21st; pearl thrown into the gap teleports the thrower (no self-damage) to the outer belt via the 1024→768 inward scan, spawns a linked return gateway, and the landing search follows the 11×11 top-down NW scan with the 2-above fallback; return trip works; links survive save/reload.

End city, shulker, elytra
- [ ] Cities generate only on outer islands (≈ 1 per 5–8 regions), purpur/end-stone-brick palette, tower spiral climbable by jumping, bridges 50%/direction, ≤ 1 ship per city at 12.5%/bridge; loot chests match §15.3 with enchanted iron/diamond gear (08 levels 20–39).
- [ ] Ship treasure room holds exactly 1 guaranteed elytra chest (+3 rolls) and 1 standard chest; dragon head, banners, item frames, brewing stand confirmed absent (stated cuts).
- [ ] Shulker: 30 HP, stationary, attaches below>above>N>S>W>E; closed = 20 armor pts through 05 §14.2 and deflects arrows; open = 0 armor, fires a ~3 m/s zigzag bullet every 1–3 s that deals 4 + Levitation I 10 s (09), pops on block contact or when punched/shot; hurt below 15 HP → 25% teleport (5 tries, 17³ cube, needs an attachable face); duplication absent; 50% shell drop.
- [ ] Shulker box: 27 slots, breaks into an item retaining all contents in `tags.containerItems`, placing restores them, box-in-box rejected, hopper I/O (07) works, recipe shell/chest/shell.
- [ ] Elytra: chest slot, 0 armor; jump-tap mid-fall deploys; WASD dead while gliding; measured level-glide ≈ 30–33 m/s at ~9.5:1, stall floor ≈ 7.2 m/s at +30°, min sink ≈ 1.5 m/s at +12–15°, dive > 60 m/s; wall crash deals (Δh·10 − 3) armor-bypassing damage; shallow landings free (fallDistance pinned at 1.0 while v.y > −0.5), steep dives hurt; 1 durability/s, stops (not breaks) at 1 leaving a tattered non-functional item; anvil+leather repairs 108/leather and Mending (08) works; no firework boost, no manual cancel.
- [ ] All §16 sound-event triggers fire (verifiable via 16's debug log) and every new block/item shows a correct icon; IDs match §17 exactly with 165–169/425–434 unused.
