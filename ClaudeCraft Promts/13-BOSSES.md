# 13 — Boss Mobs & Beacon

Expansion spec: the **boss bar** HUD system, the **end crystal** entity (natural + player-crafted), the **ender dragon** (full Java phase machine, multipart damage, fireball/breath clouds, death sequence, dragon egg, respawn ritual), the **wither** (summoning, invulnerable birth, three-headed skull combat, wither armor, block eating, nether star), and the **beacon** (pyramid tiers, GUI, effects, beam). Baseline = Minecraft Java Edition ~1.20, Normal difficulty (hard-coded), values verified against minecraft.wiki; deliberate deviations are marked `> Adaptation:` or `(approx)`.

Ownership boundaries (this file does NOT own): End arena terrain, obsidian pillar positions/heights, iron-bar cages, exit-portal structure, end gateway block, end stone, eye of ender item — **11-END**. Soul sand/soul soil blocks, wither skeleton mob + its 2.5% skull drop, ghast tear item, dimension engine + per-dimension saves — **10-NETHER**. Status-effect engine (Wither, Regeneration, Speed, etc.) and effect-cloud entities — **09-POTIONS**. Pistons — **07-REDSTONE**. Explosion engine, damage pipeline, XP orbs, box-model rendering conventions — base **05**. Registries, HUD shell, recipes — base **06**. This file owns: both boss entities and their full fight logic, the boss bar, end crystals, the dragon egg + wither skeleton skull + beacon blocks, the nether star + end crystal items, exit-portal **activation** and gateway/egg **triggers**, and the dragon respawn ritual.

Multiplayer (14): boss fights are host-simulated; only the boss bar state {name, fraction, color} is replicated to clients — one line, 14 owns the rest.

---

## Amendments to base files

- **AMENDS 05 §1**: Simulation-range rule ("mobs farther than 64 blocks skip AI") gets an exemption: entities with `isBoss = true` (ender dragon, wither) always run full AI regardless of distance, every tick, as long as their dimension is active.
- **AMENDS 05 §3.2**: `hostileCount` (cap 40) counts **only** cycle-spawned hostiles. Bosses set `isBoss = true`, are never counted against the cap, and are never produced by the spawn wave.
- **AMENDS 05 §4**: Despawning — add row: entities with `persistent = true` **or** `isBoss = true` are exempt from all three despawn rules. Both bosses spawn with `persistent = true`.
- **AMENDS 05 §13.4**: Critical hits never apply to the ender dragon's part hitboxes (vanilla: dragon parts are non-living entities). Crit condition check adds `target.isDragonPart == false`. Crits vs the wither work normally.
- **AMENDS 05 §14.2** (armor applicability table): add rows — `Dragon breath cloud (13 §6.5): armor reduces? NO, durability loss? NO (magic damage)` and `Wither skull direct hit + skull explosion: armor reduces? YES, durability loss? YES`.
- **AMENDS 05 §14.3**: Knockback — entities with `knockbackResistance = 1.0` (ender dragon, wither: **wither has 0 in vanilla** — dragon only) ignore `applyKnockback` entirely. Dragon: 1.0; wither: 0 (takes normal knockback but flight AI immediately counteracts it).
- **AMENDS 05 §15**: Death sequence — bosses override steps 2–3: the dragon uses the 200-tick death animation of §7.9 (no keel-over, custom XP schedule); the wither uses the standard 20-tick keel but drops its loot per §8.9 (nether star spawned with zero velocity). Neither uses the §2 XP column.
- **AMENDS 06 §2/§3**: Block registry gains ids **185 dragon_egg, 186 wither_skeleton_skull, 187 beacon** with the rows given in §2 of this file (188–189 reserved, unused).
- **AMENDS 06 §7.4**: Item registry gains ids **450 nether_star, 451 end_crystal, 452 dragon_breath** per §2.3 (453–459 reserved, unused).
- **AMENDS 06 §10.1**: Add recipes: `beacon`, `end_crystal` (§2.4).
- **AMENDS 06 §15.1**: HUD gains the **boss bar** row: top-center element per §1 of this file, rendered above everything except the pause/death screens.
- **AMENDS 06 §16**: Item entities — "Despawn" and "Destroyed by" rows gain the exception: a `nether_star` item entity never despawns and is immune to explosions (removed only by lava/fire/cactus/void per the base rules — vanilla: explosion-immune; despawn is 10 min in Java, `> Adaptation:` never).
- **AMENDS 01 §16.1**: `meta/'world'` record gains `endFight: {...}` (§10.1) . Chunk `entities` arrays additionally accept `wither` and `end_crystal` records (§10.2). The dragon is saved in `endFight`, never in a chunk record.
- **AMENDS 09** (sibling): (a) **Confirms wither-effect params consumed here**: Wither status effect, damage 1 HP every `40 >> amplifier` ticks (Wither I = 40 t, Wither II = 20 t), **can kill** (unlike Poison), black-tinted hearts on HUD; wither skulls apply **Wither II for 10 s** (200 t) on Normal (wiki-verified; 40 s is the Hard value — unused). (b) Expose `spawnEffectCloud({pos, radius, radiusPerTick, durationTicks, effect, reapplyDelay})` — used by §6.5/§7.6; if 09's lingering-cloud entity differs, this file's cloud params win for dragon clouds. (c) Register beacon effects in the engine: Speed I/II, Haste I/II (mining-speed ×1.2/×1.4 hook into 03's mining formula; attack-speed bonus skipped), Resistance I/II (damage ×0.8/×0.6 after armor), Jump Boost I/II (jump vy 0.42 → 0.52/0.62 (approx)), Strength I/II (+3/+6 melee damage), Regeneration I (1 HP per 50 t). All beacon applications use `ambient = true` (translucent HUD icon, sparse particles per 09's ambient rule).
- **AMENDS 10** (sibling): (a) The wither summon detector (§8.2) consumes 10's `soul_sand` and `soul_soil` block ids — export both under a shared predicate `isSoulBlock(id)`. (b) Wither skeletons' 2.5% skull drop references **block id 186** (block-item). (c) `ghast_tear` item consumed by the end-crystal recipe. (d) The End is a 10-engine dimension; this file's `endFight` record lives in 10's dimension meta for the End.
- **AMENDS 11** (sibling): (a) Export `PILLAR_POSITIONS: Array<{x, z, topY, caged: bool}>` (10 pillars) and `EXIT_PORTAL: {center: {x,z}, topY, rimCells: Array<pos>}` — consumed by §3 (crystal spawns), §7 (perch/death/respawn). (b) **Exit-portal activation**: on first dragon death this file calls `activateExitPortal()` — 11 fills its portal-block cells; spec the visual there. (c) **Gateway trigger**: on each dragon death (≤ 20 total) this file calls `spawnGateway(n)` — 11 places the structure 96 blocks from center at its chosen bearing, Y per 11 (vanilla Y=75 → 11 remaps). (d) **Respawn ritual** (§7.11) consumes the four player-placed crystals and calls `regenerateSpike(k)` per pillar — 11 rebuilds each pillar top **including the two iron-bar cages** (wiki-verified: the reset restores "obsidian pillars, iron bars, and End crystals"). (e) Egg spawn cell = 1 above the highest block at portal center column.
- **AMENDS 07** (sibling): A piston extending into `dragon_egg` (185) does not push it: the egg block breaks and drops **1 dragon_egg item** (vanilla-equivalent outcome of the push-drop rule). Pistons cannot push `beacon` (187) or `wither_skeleton_skull` (186) — both break-drop the same way. Piston edits under a beacon pyramid are caught by the 80-tick recheck (§9.3).
- **AMENDS 16** (sibling): Sound events table in §11 of this file — copy verbatim into 16's master event list.

---

## Contents

1. [Boss bar system](#1-boss-bar-system)
2. [Registry additions: blocks, items, textures, recipes](#2-registry-additions)
3. [End crystal entity](#3-end-crystal-entity)
4. [Dragon egg block (185)](#4-dragon-egg-block-185)
5. [Wither skeleton skull block (186)](#5-wither-skeleton-skull-block-186)
6. [Ender dragon — stats, model, projectiles](#6-ender-dragon--stats-model-projectiles)
7. [Ender dragon — state machine, death, respawn](#7-ender-dragon--state-machine-death-respawn)
8. [Wither](#8-wither)
9. [Beacon](#9-beacon)
10. [Persistence](#10-persistence)
11. [Sound events (for 16-AUDIO)](#11-sound-events-for-16-audio)
12. [ID assignment table](#12-id-assignment-table)
- [Acceptance checklist](#acceptance-checklist)

---

## 1. Boss bar system

A single HUD manager (`ui/BossBar.js`) owning up to **3** simultaneous bars, stacked top-center.

| Property | Value |
|---|---|
| Position | top-center; first bar 12 px from top edge (at 2× GUI scale), subsequent bars +18 px each |
| Size | 182×5 GUI px (MC-exact bar sprite size) → 364×10 CSS px at the 2× scale of 06 §15 |
| Parts | name label centered above the bar (white, drop shadow); dark gray track; colored fill = `displayFraction` |
| Style | `progress` only (clean bar). Vanilla's notched styles exist only for raids — **skipped** |
| Colors | ender dragon **pink** `#ec00d1`; wither **purple** `#7b2fbe` (Java "light purple"); API accepts any CSS color |
| Fill animation | `displayFraction += (actualFraction − displayFraction) × 0.1` per render frame (smooth catch-up, (approx) of MC's eased bar) |

API (consumed by both bosses; nothing else in scope creates bars):

```js
BossBar.add(id, { name, color })      // id = entity id; returns handle
BossBar.set(id, fraction)             // 0..1, clamped
BossBar.remove(id)                    // slides out over 10 ticks then unmounts
```

**Visibility rules** (evaluated per tick by each boss, calling add/remove):

| Boss | Vanilla rule | Build rule |
|---|---|---|
| Ender dragon | player within Euclidean 192 of the End's center column | `> Adaptation:` visible whenever the player is **in the End dimension** and the fight entity exists (our arena fits inside 192 anyway) |
| Wither | player loading the wither's chunk, within ~24 chunks | `> Adaptation:` wither within **128 blocks** (Euclidean) of the player, same dimension |

Bar text: "Ender Dragon" / "Wither" (no renaming in scope). During the wither's 220-tick birth (§8.3) the bar shows its **charging health** (starts ⅓, fills to full) — vanilla behavior, reads as a charge-up meter. During the dragon respawn ritual no bar shows until the dragon spawns.

---

## 2. Registry additions

### 2.1 Blocks — gameplay table (AMENDS 06 §2)

| ID | Name | Hard | Blast | Tool | Tier | Drops | XP on mine |
|---:|------|-----:|------:|------|------|-------|-----------|
| 185 | dragon_egg | 3.0 | 9.0 | — | — | nothing by mining (cannot be mined — clicks teleport it, §4; obtained only via fall-onto-nonsolid or piston) | 0 |
| 186 | wither_skeleton_skull | 1.0 | 1.0 | — | — | self | 0 |
| 187 | beacon | 3.0 | 3.0 | — | — | self | 0 |
| 188–189 | *reserved (unused)* | | | | | | |

### 2.2 Blocks — light, render, physics table (AMENDS 06 §3)

| ID | Name | Emit | Opac | Pass | Shape | Grav | Solid |
|---:|------|-----:|:---:|:---:|-------|:---:|-------|
| 185 | dragon_egg | 1 | T | co | custom: egg — stacked centered box tiers (px w×h): 2×1, 6×1, 10×2, 14×3, 16×4, 14×2, 10×2, 6×1 bottom→top | yes | yes (full-cube collision (approx)) |
| 186 | wither_skeleton_skull | 0 | T | co | custom: 8×8×8 px skull box centered on cell floor | — | no (support-pop like torch) |
| 187 | beacon | 15 | T | tr | custom: 2 px obsidian base slab + 16³ glass shell + floating 10×10×10 px core (emissive) | — | yes |

### 2.3 Items (AMENDS 06 §7.4)

| ID | Name | Stack | Notes |
|---:|------|---:|---|
| 450 | nether_star | 64 | wither drop; item entity never despawns + explosion-immune (AMENDS 06 §16); icon pulses brightness ±15% at 1 Hz |
| 451 | end_crystal | 64 | placeable **only** on obsidian (33) or bedrock (17), §3.4 |
| 452 | dragon_breath | 64 | collected by RMB-ing a `glass_bottle` (09 item 370) inside a dragon breath cloud (§6.5); consumed by 09 §12.2 as the splash→lingering brewing modifier |
| 453–459 | *reserved (unused)* | | |

Block-items for 185/186/187 exist automatically per 06 §1 (dragon_egg item obtainable only via §4 tricks; skulls only via 10's wither-skeleton drop; beacon via crafting).

### 2.4 Recipes (AMENDS 06 §10.1) — `G`=glass, `N`=nether_star, `O`=obsidian, `E`=eye_of_ender (11), `T`=ghast_tear (10)

```
beacon (1):        G G G        end_crystal (1):   G G G
                   G N G                           G E G
                   O O O                           G T G
```

### 2.5 Texture recipes (conventions per 06 §4/§8)

| Asset | Recipe |
|---|---|
| dragon_egg (block faces) | `noise(#0c0912, 8)` + 12% pixels `#3a2a55` speckle + 1-px `#1b1029` outline on the cutout tiers |
| wither_skeleton_skull (block faces) | bone recipe from 05 §16.2 skeleton shifted dark: `noise(#4a4a44, 8)`; face: 2×2 black eye sockets, 1-px nasal slit, 4-px grim mouth |
| beacon (block) | base `noise(#1b1029, 6)` (obsidian); shell `glassy(#c9dbdc)`; core `noise(#62e9d8, 5)` emissive |
| nether_star (item sprite) | 16×16 map: 4-point white `#ffffff` star, 8 px tall/wide arms, `#fff8c4` inner glow, `#8adfdf` 1-px tips |
| end_crystal (item sprite) | magenta `#e079fa` diamond rhombus 10 px tall over 2-px gray base bar, 1-px white core |
| Wither mob | body/heads `noise(#1c1c20, 8)` charcoal; eyes+mouths `#3a3a3a` sockets (birth/blue variant: recolor body `#3a5a8a` + emissive white eyes); armored overlay: +10% brightness scanline every 2 px |
| Ender dragon mob | body `noise(#101014, 6)`; wing membrane `#2a2033` α 0.85; eyes 2×1 px magenta `#e079fa` emissive; mouth row `#4a3a5a` |
| End crystal entity | outer cube faces `glassy(#e8d9f7)` with magenta 1-px frame; inner cube `noise(#e079fa, 10)` emissive; base plate uses bedrock texture (06) |

---

## 3. End crystal entity

Non-living entity (extends base `Entity`, not `LivingEntity`).

| Property | Value |
|---|---|
| AABB | 2.0 × 2.0 × 2.0, centered on its block cell, feet at cell bottom |
| Physics | none — fixed in place, no gravity, not pushable |
| Health model | none: **any** damage instance (melee at any charge, arrow, snowball/egg, explosion) destroys it in one hit |
| On destroy (non-explosion cause) | **explosion power 6** (05 §12 engine: block destruction + entity damage + knockback; no fire), centered at the crystal's **bottom-center** (so crystals on obsidian/bedrock never crater their own pillar top — vanilla) |
| On destroy (cause = another explosion) | removed silently, **no** secondary explosion (Java-verified) |
| If linked to the dragon when destroyed | dragon takes **10 HP** directly (bypasses the §6.2 body-damage formula; applied before the crystal's own explosion resolves) |
| Fields | `pos, hasBase (bedrock plate), beamTarget: pos|null` |

Damage numbers vs players: power-6 explosion per 05 §12.3 — point-blank fully-exposed cap `(1+1)/2·7·12+1 = 85 HP` pre-armor. Do not soften.

### 3.1 Natural spawns
One crystal on top of each of 11's **10 obsidian pillars**, standing on a bedrock block (11 places the bedrock; the crystal entity spawns with `hasBase = true`). Two of the pillars are caged in 11's iron bars (`caged = true` in 11's table) — those crystals can only be reached by breaking bars (careful melee); ranged shots hit the bars first.

Vanilla places a fire block at each natural crystal's cell. `> Adaptation:` fire block (06 id 65) is placed at the crystal cell on spawn, purely cosmetic (our fire never spreads); skipped for player-placed crystals.

### 3.2 Rendering & animation
Procedural, per 05 §16 conventions: outer cube 12×12×12 px and inner cube 6×6×6 px, both centered 1.0 m above the base cell floor, spinning opposite directions (`yaw ± 0.035 rad/t`), whole crystal bobbing `y += 0.1·sin(age/15)`; if `hasBase`, a 16×2×16 px bedrock-textured plate sits at the cell floor. Both cubes render in the cutout pass, inner cube emissive.

### 3.3 Healing beam (crystal → dragon)
Link selection is dragon-side (§6.3). A linked crystal sets `beamTarget = dragonHeadPos` each tick; unlinked → null. **Beam rendering**: a camera-facing quad strip (2 triangles per 2-m segment) from crystal center to `beamTarget`, width 0.25 m, white `#f7eaff` α 0.7, additive, UV scrolling 0.5 px/t (05's Particles helper may own the material). Beam is purely visual; it is not occluded by terrain and cannot be blocked (Java-verified).

### 3.4 Player placement (item 451)
Right-click with `end_crystal` on the **top face** of `obsidian` (33) or `bedrock` (17) only, and only if the two cells above the clicked block are air (or replaceable: short_grass/flowers) and no entity AABB intersects the 2×2×2 target volume. Consumes 1 item, spawns a crystal with `hasBase = false`. Any other target block: no-op. Used for Crystal-PvE tactics and the respawn ritual (§7.11).

---

## 4. Dragon egg block (185)

Trophy block, placed by the game once (§7.9). Falls like sand (06 §5.1 falling-block entity).

- **Click teleport**: left-click (starting to mine it) or right-click → the egg teleports: reuse 05 §8.5's `teleportRandom` seek loop — up to 16 attempts at `±8 x/z, ±4 y` (`> Adaptation:` of vanilla's ±15/±7 ×1000 attempts), target cell must be air (support NOT required — it falls afterward if unsupported). On success: remove from old cell, place at new cell, spawn 20 magenta `#e079fa` teleport motes at both ends (05's particle set). On 16 failures: nothing. The egg therefore **cannot be mined**.
- **Obtaining, route A (torch trick)**: break the block under the egg → egg becomes a falling-block entity → **override of 06 §5.1**: a falling `dragon_egg` that lands in a cell already occupied by a **non-solid block** (torch, ladder, snow_layer, crops…) drops as **1 dragon_egg item** instead of popping that block (vanilla-faithful; sand/gravel keep the base pop rule).
- **Obtaining, route B (piston)**: per AMENDS 07 — piston head entering the egg's cell breaks it into the item.
- Emits light 1. Once picked up it is a normal placeable block-item (re-placing re-arms the teleport behavior). If the player never collects it and starts the respawn ritual, the egg block at the portal is removed (§7.11, vanilla rule).

---

## 5. Wither skeleton skull block (186)

- **Placement**: floor-only, on the top face of any solid block (`> Adaptation:` vanilla also allows walls). State nibble bits 0–1: facing (set from player yaw on place, visual only). No collision; support removed → pops as item (torch rule).
- Obtained exclusively from 10's wither skeletons (2.5% drop). Stack 64.
- Placing a skull runs the **wither summon detector** (§8.2) before any other placement side effects.
- Render: 8×8×8 px box centered on the cell floor with the §2.5 texture; item form uses the block-icon pipeline (06 §8.2).

---

## 6. Ender dragon — stats, model, projectiles

### 6.1 Stat block

| Stat | Value |
|---|---|
| HP | **200** |
| Bounding volume | 16 × 8 × 16 (whole-entity; NOT the damage box — see §6.2) |
| Damageable parts | head + body (two-box adaptation of vanilla's 8 sub-hitboxes) |
| Contact damage | wings/body **5**, head **10** (Normal) + launch knockback (§6.4) |
| Flight speed | holding/perch-approach **0.6 b/t** (12 b/s), charging **1.0 b/t** (20 b/s), dying approach 0.6 (approx — vanilla speed is emergent) |
| Knockback taken | none (`knockbackResistance = 1.0`) |
| Fire/lava/drowning/fall/void | immune |
| Status effects (09) | immune to **all**, except Instant Damage from a player-thrown potion (09's splash harming, if built) |
| Crits | immune (AMENDS 05 §13.4) |
| Valid damage sources | player melee, player arrows (not while perched, §7.6), explosions, player-sourced instant damage. Everything else → 0 |
| XP | first kill **12,000**, repeat kills **500** (§7.9 schedule) |
| Boss bar | pink, per §1 |
| Despawn / mob cap | exempt (`isBoss`, AMENDS 05 §3/§4) |

### 6.2 Multipart hurtboxes & damage math

> Adaptation: vanilla tracks 8 part entities (head, neck, body, 2 wings, 3 tail). We track **two damage AABBs** that follow the model each tick:
> - `headBox`: 1.0 × 1.0 × 1.0 m centered on the head part's world position.
> - `bodyBox`: 4.0 × 3.0 × 4.0 m centered on the body part (covers body + wing roots + first tail segments).
>
> Attack/arrow entity-picking (05 §13.3 / §11) tests both boxes; nearest hit wins.

Damage application (Java formula, applied to the 200-HP pool):

```
hitHead:  applied = raw                                   // full damage
hitBody:  applied = raw / 4 + min(1, raw)                 // ≈ 75% reduction, verified formula
explosions: always the body formula (exposure per 05 §12.3 computed against bodyBox)
```

(Vanilla Java has a bug making the head reduce too; we implement the intended/Bedrock behavior — head hits matter. State in the F3 overlay which box was hit for tuning.) i-frames per 05 §14 apply to the shared pool (10 ticks, excess rule intact).

### 6.3 Crystal healing link

Every tick: `linked = nearest end crystal whose center is within the cuboid dragonCenter ± 32 blocks on every axis` (Euclidean not required — cuboid, Java-verified). If linked: **+1 HP per 10 ticks** (2 HP/s), capped at 200, and the crystal's `beamTarget` is set to the dragon's head. Blocks/entities never obstruct the link. Destroying the linked crystal → 10 HP to the dragon (§3) and triggers the Strafing phase (§7.4).

### 6.4 Contact damage & launch

Each tick (except during DYING, and **suppressed for 10 ticks after the dragon itself takes damage** — vanilla ½-s grace): for every living entity whose AABB intersects `bodyBox` → 5 dmg; intersecting `headBox` (only meaningful mid-charge) → 10 dmg. Then launch, bypassing 05 §14.3:

```js
dir = normalize(horizontal(entityCenter − dragonCenter));
entity.vx += dir.x * 2.0;  entity.vz += dir.z * 2.0;  entity.vy += 0.8;   // (approx — "thrown into the air")
```

Standard 10-tick i-frames prevent machine-gun contact damage.

### 6.5 Dragon fireball & breath clouds

**Dragon fireball** (projectile entity):

| Property | Value |
|---|---|
| AABB | 1.0 × 1.0 |
| Velocity | `normalize(targetEyes − headPos) × 0.65 b/t`, no gravity, no drag `(approx of MC's accelerating fireball, drag 0.95 + accel 0.1/t)` |
| Trail | 2 magenta `dragon_breath` motes per tick |
| Deflectable | no (cannot be hit; passes through attacks) |
| Direct hit | **0 damage, 0 knockback** — impact only spawns the cloud (Java-verified) |
| On impact (block or entity) or 600-tick timeout | spawn **fireball breath cloud** at impact point, remove |

**Breath clouds** (one entity class via 09's `spawnEffectCloud`, params owned here):

| Param | Fireball impact cloud | Perch breath cloud |
|---|---|---|
| Radius | 3.0, growing to 7.0 linearly over lifetime (Java: radiusPerTick = 4/600) | 3.0 fixed (visible particle disc renders out to 5–6 m diameter) |
| Duration | 600 ticks (30 s) | 200 ticks (10 s) (approx — wiki reports visible fade ~3 s; Java's cloud entity lives 200 t; we keep 200) |
| Damage | 6 HP **magic** per application — ignores armor (AMENDS 05 §14.2 row); Protection-style reductions out of scope | same |
| Reapply cadence | per-entity cooldown 20 ticks while inside (feet within radius, |dy| ≤ 1.5 from cloud plane) | same |
| Affects | all living entities except the dragon | same |
| Render | 30 magenta motes/s uniformly in the disc, drifting up 0.02 b/t | same |

**Bottling dragon's breath** (item 452, registered by this file per §2.3): RMB a `glass_bottle` (09 item 370) whose use-point lies inside a breath cloud (fireball impact cloud or perch cloud) → consume 1 glass_bottle, give 1 `dragon_breath`, and shrink that cloud's current `radius` by 0.5 m. 09 §12.2 consumes `dragon_breath` as its splash→lingering brewing modifier — the sole survival source of lingering potions. (Phase note: dragon_breath is an E11 drop, so CLAUDE.md's E9 gate clause "lingering clouds work" is survival-testable only after E11; 09's own E9 checklist exercises lingering via the debug palette until then.)

### 6.6 Box model & animation (05 §16 conventions, 1 px = 1/16 m)

```
DRAGON (all parts hang off a root at body center; +Z = forward/nose):
  body    48×40×64 px (3×2.5×4 m), pivot at center
  neck    3 segments, each 16×16×16 px, chained from body front, each yaw/pitch = 40% of head look delta
  head    24×16×16 px + snout 12×6×16 px front + 2 horns 2×6×2; total head part ~1.5×1×2 m
  jaw     12×4×14 px, hinged at snout rear; opens 35° during roar/breath
  wings   per side: inner panel 40×2×56 px + outer panel 44×2×56 px, hinged at body top edge (x=±24 px)
  tail    8 segments, each 12×12×16 px, chained rearward, tapering scale 1.0→0.55
  legs    4 stubs: thigh 8×14×8 + shin 6×12×6, tucked while flying, extended while perched
Wither skull projectile: 5×5×5 px box (black #1c1c20 / blue #3a5a8a variants, emissive eyes)
Dragon fireball: 10×10×10 px magenta noise cube, spins 0.1 rad/t
```

Animations (render loop, radians):

- **Flap**: `flapCycle += 0.05/t` flying (0.02 perched); `wingRotZ = ±(0.35 + sin(flapCycle) × 0.55)`; outer panel lags `sin(flapCycle − 0.6) × 0.35` extra. Flap sound event fires at each `sin` zero-crossing downward.
- **Tail sway**: segment i: `rotY = sin(flapCycle×0.7 − i×0.45) × 0.10`, `rotX = 0.05·i` droop; while turning add `rotY += clamp(turnRate, −0.3, 0.3) × (i/8)`.
- **Neck/head look**: pitch/yaw toward velocity (flying) or player (perched), each neck segment 40%, head 100%, clamps ±60°.
- **Perch pose**: legs extended, body pitched −10°, wings folded (`wingRotZ = 1.2`).
- **Hurt flash / death**: hurt tint per 05 §16.3; death per §7.9.

---

## 7. Ender dragon — state machine, death, respawn

### 7.1 Fight lifecycle
The fight exists per-End-dimension (10/11): when the End is first entered, 11 builds the arena and this file spawns the dragon at the arena center, `y = 100` (11's ceiling clamp), state HOLDING, and creates `endFight` (§10.1). Chunk-simulation exemption per AMENDS 05 §1 keeps it ticking while the player is anywhere in the End.

### 7.2 Flight node ring & steering
`> Adaptation:` vanilla's 24-node path graph becomes a **12-node ring**: nodes at angle `k·30°` for k = 0..11, radius `R`, height `nodeY = mean(PILLAR_POSITIONS.topY) + 6` (clamped ≤ 124). `R = pillarRingRadius + 12` while any crystal survives (**outside** the pillars), `pillarRingRadius − 12` once all are destroyed (**inside** — vanilla-verified switch). Steering everywhere: turn current heading toward the goal ≤ 4°/tick, pitch ≤ 3°/tick, move `speed` along heading; waypoint reached at distance < 6. No A* — the dragon flies through/destroys everything (§7.8).

### 7.3 Phase table (Java-faithful; weights/timers exact where wiki gives them)

| # | State | Does | Exits |
|---|---|---|---|
| 0 | HOLDING | circles the node ring counterclockwise at 0.6 b/t | crystal destroyed → STRAFING; at each node: roll `1/(3 + crystalsAlive)` → APPROACH_PERCH; fatal damage → DYING |
| 1 | STRAFING | targets the nearest player; flies a standoff arc: goal point = player + 48 m at (playerBearing + 90°); when head-to-player distance ≤ 64 AND LOS (01 DDA, opaque blocks) → fire **one** dragon fireball at the player's eyes | after firing → HOLDING; player > 150 away → HOLDING |
| 2 | APPROACH_PERCH | flies to a point 20 m above `EXIT_PORTAL.center`, then spirals down 0.15 b/t descent, approaching from the side opposite the nearest player when possible | within 1.5 m of the perch cell (highest dragon-immune block of the (0,0) column, i.e. the portal top) → PERCHED (snap position, zero velocity) |
| 3 | PERCHED | perch pose; `perchTicks++`; scans | at `perchTicks ≥ 25` (1.25 s): player within 20 of portal center → BREATH; no player within 150 → TAKEOFF; player exists but none has come within 20 for **100 ticks** (5 s) since landing → CHARGING; `perchDamage > 50` → TAKEOFF (reset accumulator); `breathCount == 4` → TAKEOFF; fatal → DYING |
| 4 | BREATH | roar 20 t (jaw open, `growl`), then 60-t flame stream from mouth to the ground point 5 m ahead of the head; at stream start spawn a **perch breath cloud** (§6.5) at that point; `breathCount++` | stream end → PERCHED |
| 5 | CHARGING | picks the nearest player within 150 (LOS not required — Java); flies straight at the player's continuously updated position at 1.0 b/t; head contact = 10 dmg + launch | passed within 10 of the target or 100 ticks elapsed → TAKEOFF |
| 6 | TAKEOFF | climbs toward the nearest ring node at 0.6 b/t | node reached → HOLDING |
| 7 | DYING | §7.9 | removal |

Perch damage accounting: all damage applied while in PERCHED/BREATH adds to `perchDamage`; crossing **50** ends the perch (wiki-verified; the accumulator persists between perches if not tripped). `breathCount` resets on every TAKEOFF. When damaged in HOLDING the dragon picks the next ring node **behind** its heading (vanilla "targets a point just behind itself" → visible flinch-turn).

### 7.4 Crystal-destruction reaction
Whenever any pillar crystal dies: dragon takes the 10-dmg link hit if linked (§3), and — from any state except PERCHED/BREATH/DYING — switches to STRAFING (fires one fireball per crystal destroyed, vanilla-verified).

### 7.5 Targeting
The dragon only ever targets **players** (Java-verified). With no player in the End, phases still run; STRAFING/CHARGING fall through to HOLDING.

### 7.6 Perch arrow rule
While state ∈ {PERCHED, BREATH}: any arrow whose swept path intersects either dragon box is **deflected** — it takes fire (renders burning), reflects `v = −v × 0.3` with random ±0.1 jitter, and deals **0 damage** (Java: "they catch fire and bounce off"). Melee works normally — full damage only on `headBox` (§6.2), which sits low and reachable while perched. This is the designed melee window.

### 7.7 Damage-source gate
`hurt()` on a dragon part first applies §6.2's box multiplier, then the standard 05 §14 pipeline **minus armor** (dragon wears none). Non-player, non-explosion sources are zeroed (§6.1).

### 7.8 Terrain destruction
Every tick, compute the set of grid cells intersecting `bodyBox` and `headBox`. For each cell whose block is destructible: set to air with **no drops** (Java-verified: "destroyed blocks are not dropped"), spawn 2 gray poof particles. Exception: a destroyed `chest` (37) spills its 27-slot contents as item entities (containers drop contents, not themselves).

`dragonImmune` (never destroyed, dragon passes through — Java `dragon_immune` tag mapped to our registry): `bedrock 17`, `obsidian 33`, `end_stone` (11), `end_portal_frame` (11), `end_portal` (11), `end_gateway` (11), `iron_bars` (11), `crying_obsidian` — not in scope. `fire 65`, `water 63`, `lava 64` are ignored (not destroyed, no interaction; vanilla `dragon_transparent`/fluids). **End stone is immune** — the dragon does not carve the island (wiki-verified; the prompt-level assumption "destroys all except obsidian/bedrock/frame" is wrong for Java).

### 7.9 Death sequence (10 s)

On fatal blow (HP ≤ 0 while not DYING): state = DYING, invulnerable, contact damage **stays live** (vanilla quirk — keep).

1. **Approach** (variable): fly toward the top of the (0,0) exit-portal column at 0.6 b/t. If the portal is > 150 away or unreachable, die in place.
2. **Ascension** (200 ticks, `deathTicks` 0–200): velocity = (0, +0.03, 0); wings limp (`wingRotZ` lerps to 0.1, no flap); **flicker**: every 2 ticks toggle all materials between normal and additive white (α 0.6) — the "tattering" adaptation; **light rays**: spawn up to 12 white billboard quads anchored at body center, random yaw/pitch, length growing `2 + deathTicks×0.15` m, width 0.5 m, additive α 0.5, slowly rotating — remove all at the end. Play `dragon_death` at tick 0.
3. **XP**: first kill — at each of ticks 155, 160, 165, … 200 (10 drops) spawn an XP orb (05 §15 entity) worth **960**; at tick 200 spawn one final orb worth **2400** — total **12,000** (Java-verified split). Repeat kills — single orb of **500** at tick 200.
4. **Tick 200**: remove entity + boss bar; then, in order:
   - `activateExitPortal()` (11 fills its portal blocks) — every kill (idempotent).
   - First kill only: place `dragon_egg` (185) at 11's egg cell (1 above the highest block at the portal's center column).
   - `spawnGateway(gatewaysSpawned)` if `gatewaysSpawned < 20`, then increment.
   - `endFight.dragonAlive = false`, `dragonKilledCount++` (§10.1).

### 7.10 Fight-active side effects
While the dragon exists and a player is in the End: boss bar per §1. Vanilla's darkened fog + boss music: fog is 04/11's End fog (no change); music/audio → 16.

### 7.11 Respawn ritual

Trigger check runs whenever a player-placed end crystal is created (§3.4): if there are player-placed crystals on **all 4 cardinal rim cells** of the exit portal (11's `EXIT_PORTAL.rimCells` marks the 4 valid spots — one per flat side, exact alignment not required in vanilla; our 4 cells are canonical) **and** `endFight.dragonAlive == false`:

```
t=0      lock: the 4 summoning crystals become invulnerable-to-players? NO — vanilla: damaging
         any of the 4 CANCELS the sequence (crystals explode normally, remaining 3 pop with no
         explosion, sequence aborts). Pillar crystals spawned during the sequence ARE invulnerable
         until t=604. Egg block at the portal (if never collected) is removed.
t=0      all 4 crystals point beams at pillar 0's top.
t=k·54   (k = 0..9) pillar k regenerates: explosion visual (power-0 flash, no block damage) at its top,
         then regenerateSpike(k) — 11 rebuilds pillar top, bedrock cap, AND iron-bar cage where
         caged (wiki-verified: cages ARE restored); a fresh invulnerable crystal spawns on it;
         the 4 summoning beams retarget pillar k+1.
t=540    all 10 pillar crystals alive; the 4 summoning beams point at the arena center (0, 100, 0).
t=604    dragon spawns at center, full 200 HP, state HOLDING; the 4 summoning crystals explode
         (power 6 each, simultaneous); endFight.dragonAlive = true; boss bar appears.
```

Total 604 ticks (wiki-exact "a bit over 30 seconds"). Sequence state persists in `endFight.respawnSequence` (§10.1); on load mid-sequence, resume at the saved tick.

---

## 8. Wither

### 8.1 Stat block

| Stat | Value |
|---|---|
| HP | **300** (Java: difficulty-independent) |
| AABB | 0.9 × 3.5 (Java hitbox) |
| Natural armor | 4 points (Java attribute) — feeds 05 §14.2 |
| Movement | flying, no gravity; steering §8.5; MC speed attr 0.6 (reference) |
| Attack | wither skulls (§8.6): 8 dmg + Wither II 10 s (Normal) + power-1 explosion |
| Detection/follow range | **40** blocks (Java follow-range attribute) |
| Regeneration | +1 HP per 20 ticks, always; +5 HP on landing a killing blow |
| Immunities | fire, lava, drowning, fall damage, freezing; **all status effects** (09); damage from undead mobs (zombie/skeleton incl. skeleton arrows) is ignored |
| XP on death | **50** (single orb) |
| Drops | 1 nether_star (450), always — spawned at death position with zero velocity |
| Boss bar | purple, per §1 |
| Despawn / cap | exempt (`isBoss`, persistent) |

### 8.2 Summoning — block-place listener

Structure: **T of 4 soul blocks + 3 skulls**: base column of 2 soul blocks (10's soul_sand or soul_soil, interchangeable), a 3-wide soul-block arm across the top, and a wither_skeleton_skull (186) on each of the 3 arm blocks. Skulls are on top; **the last block placed must be a skull** (detector runs only on skull placement — placing soul blocks never summons). Upright orientation only; vanilla's sideways/upside-down builds and the air-beside-base requirement: `> Adaptation:` skipped.

```js
// on place of block 186 at S — the placed skull may be the left, center, or right skull
for (axis of [X, Z]) for (offset of [-1, 0, +1]) {          // candidate center = S − offset·axis
  c = S.sub(axis.scale(offset));
  if (block(c−axis)==SKULL_186 && block(c)==SKULL_186 && block(c+axis)==SKULL_186   // top row (incl. S)
   && isSoulBlock(c−axis+DOWN) && isSoulBlock(c+DOWN) && isSoulBlock(c+axis+DOWN)   // arm
   && isSoulBlock(c+DOWN+DOWN)) {                                                    // base
    clear all 7 cells to air (no drops);
    spawnWither(base bottom cell center);      // feet at the lowest soul block's cell
    return;
  }
}
```

### 8.3 Birth phase (invulnerable growth)

On spawn: `invulnTicks = 220` (11 s), `health = 100` (⅓ of max, Java). While `invulnTicks > 0`:

- Immobile, no attacks, **immune to all damage**.
- Heals **+10 HP every 10 ticks** (reaches 300 by tick ~200); boss bar fills accordingly (the §1 charge-up read).
- Render: model scales `0.5 → 1.0` linearly over the 220 ticks; texture uses the blue birth variant, flashing to black every 5 ticks (§2.5).
- At `invulnTicks == 0`: **explosion power 7** centered on self (05 §12 engine; largest explosion in the game — breaks blocks with drops at 1/7, entity cap `(1+1)/2·7·14+1 = 99` pre-armor), wither takes no self-damage; play global `wither_spawn` (16: audible at full volume everywhere — the klaxon); begin normal AI.

### 8.4 Targeting

Re-evaluated every 20 ticks (main) / per §8.6 (side heads). Valid targets: **players first** (nearest within 40), else **any living non-undead mob** within 40 (cows, pigs, sheep, chickens, creepers, spiders, endermen — chaos included by design; zombies/skeletons are undead brethren, never targeted). No LOS requirement to hold a target; LOS gates firing only. Each side head keeps its **own** target: if it lacks one, it picks a random valid entity within 40 **with LOS** from that head.

### 8.5 Movement (hover pathing)

`> Adaptation:` no A*; direct steering (block-eating §8.8 clears obstacles emergently):

```js
goal = target ? { x: target.x + clamp(dx, -3, +3),        // hover within 3 horizontally
                  y: target.y + (armored ? 0 : 5),        // 5 above target; SAME height when armored (Java)
                  z: target.z + clamp(dz, -3, +3) }
              : idleHoverPoint;                            // no target: hold position, drift down 0.01 b/t,
                                                           //   cannot gain altitude (Java idle rule)
v += normalize(goal − pos) × 0.03;  v ×= 0.91;             // accel + hover drag → max ≈ 0.3 b/t (6 b/s)
```

Body yaw turns toward the primary target (≤ 10°/tick); side heads track their own targets with yaw clamp ±60°, pitch ±40° relative to body (independent tracking per head).

### 8.6 Skull firing (Java algorithm, verbatim adaptation)

**Main (center) head**: every **40 ticks**, if primary target exists AND LOS from head to target: fire a **black** skull at the target — **0.1% chance it is blue instead**. No LOS → hold fire, keep chasing. Spawn point: `feetY + 3.1`, body center horizontally.

**Side heads** (each independently, spawn point `feetY + 2.2`, `±1.3` m lateral):

```js
per tick, per side head i:
  if (--cooldown[i] > 0) continue;
  cooldown[i] = 10 + randInt(10);            // 10..19
  blueCounter[i]++;
  if (blueCounter[i] > 15) {                 // Normal difficulty branch (active)
    fire BLUE skull in a uniformly random direction; blueCounter[i] = 0;
  }
  if (head[i].target && LOS(head[i], target)) {
    fire BLACK skull at head[i].target;
    cooldown[i] = 40 + randInt(20);          // 40..59 → one aimed shot per 2–3 s
    blueCounter[i] = 0;
  } else acquireRandomTarget(head[i]);       // §8.4
on any damage event to the wither (even fully i-frame-absorbed): blueCounter[0] += 3; blueCounter[1] += 3;
```

Emergent Java behaviors this reproduces: targetless withers spray blue skulls every ~9.5–17 s per head; damaging the wither faster than ~12-tick intervals forces bonus blue skulls; aimed black volleys land every 2–3 s per side head plus every 2 s from the center.

### 8.7 Wither skull projectiles

| Property | Black skull | Blue ("dangerous") skull |
|---|---|---|
| AABB | 0.3125³ | 0.3125³ |
| Speed | 0.9 b/t straight-line, no gravity/drag `(approx of MC fireball accel 0.1/t, drag 0.95)` | 0.5 b/t (visibly slower, dodgeable) |
| Inaccuracy | dir += gaussian × 0.0172275 per axis | none (random direction shots already random) |
| Trail | 1 gray smoke mote/tick | 1 blue mote/tick |
| Lifetime | 600 ticks, then explode in air | same |
| Deflectable | no `(Bedrock-only mechanic — skipped)` | no (skipped) |
| Direct hit (living entity) | **8 dmg** (armor applies) + **Wither II, 200 ticks** via 09 (players and non-undead mobs) | same |
| Explosion | power **1**, no fire, normal blast resistance (05 §12 — power 1 cannot crack blocks with blast > ~4, emergent) | power **1**, no fire, but every destructible block is treated as **blast resistance 0** — breaks obsidian; only `witherImmune` (§8.8) survives; also removes water/lava source cells in radius (Java-verified) |

Both explode on any block or entity impact. The wither is immune to its own skulls' damage.

### 8.8 Block eating (damage-triggered break)

When the wither takes any damage event: `breakCounter = 20`. Every tick: `if (--breakCounter == 0)`: destroy every block in the **3×4×3** box `x ∈ [⌊px⌋−1, ⌊px⌋+1], y ∈ [⌊py⌋, ⌊py⌋+3], z ∈ [⌊pz⌋−1, ⌊pz⌋+1]` (lowest-center cell = the wither's block position, Java-exact), **dropping every block as its item** (100%, as-if-diamond-tool drop tables — Java: "dropping them as items if possible"; the wither is the only obsidian "miner" besides a diamond pick). Play `wither_break_block` once if ≥ 1 block broke. Repeated damage keeps re-arming the counter → one break volley per 20 ticks max (Java cadence).

`witherImmune` (mapped Java `wither_immune` tag): `bedrock 17`, `end_portal`, `end_portal_frame`, `end_gateway` (11's blocks), plus liquids `water 63` / `lava 64` (not broken by the *body* attack; blue skulls do remove liquids per §8.7). Note obsidian is NOT immune — suffocating a wither works only with bedrock/portal blocks.

### 8.9 Wither armor phase (≤ 150 HP)

`armored = (health < 150)`, re-evaluated every tick (regenerating back above 150 removes it — Java):

- **Immune to arrows**: any arrow whose sweep hits the wither's AABB deflects — 0 damage, `v = −v × 0.3` + jitter, no fire (unlike the dragon perch). Melee/explosions unaffected.
- Flies at the **target's height** (§8.5) — forces melee range warfare.
- Visual: armored texture overlay (§2.5) + white charge flicker every 10 ticks.

Bedrock's half-health crash/dash/wither-skeleton-summon behaviors: **skipped** (Java baseline).

### 8.10 Death & drops

Standard 05 §15 keel-over (20 ticks) with overrides: at death instant spawn **1 nether_star item entity exactly at the hitbox center with zero velocity** (never despawns, blast-immune — it must survive the battlefield) + one **50 XP** orb. Remove boss bar. `wither_death` sound. Wither roses: **skipped** (no block in scope).

### 8.11 Model (05 §16 conventions)

```
WITHER (56 px tall = 3.5 m):
  spine       6×30×6 px vertical column, y 10..40
  ribcage     18×14×10 px centered on spine, y 16..30; 3 rib bars 2×2×10 px flaring at x=±8
  tail stub   4×10×4 px below spine (y 0..10), sways ±0.15 rad
  shoulders   34×6×8 px bar at y 40..46
  center head 12×12×12 px on top (y 44..56)
  side heads  10×10×10 px at x = ±11 px, y 40..50, on 2×4×2 px neck stubs
Animation: whole body bobs y ±0.08 m at 0.5 Hz; heads track targets independently (±60° yaw,
±40° pitch, lerp 0.3/t); firing head recoils rotX −20°→0 over 4 ticks; birth phase scales the
whole group 0.5→1.0; hurt/death per 05 §16.3.
```

---

## 9. Beacon

### 9.1 Block & block entity

Block 187 (§2.1/§2.2): hardness 3, blast 3, any tool, drops itself, emits light 15 **always** (active or not). Block entity fields: `{ primaryEffect: id|null, secondary: null|'regen'|'primary2', levels: 0..4 (derived, recomputed — not trusted from save) }`.

### 9.2 Pyramid check (every 80 ticks + on GUI open)

```js
MINERALS = { iron_block 28, gold_block 29, diamond_block 30, emerald_block (12's id), netherite_block 142 };
// netherite_block (10 §1.1, id 142) counts as a pyramid mineral (vanilla 1.16+) — 5 mineral types total.
function pyramidLevels(bx, by, bz) {
  for (let L = 1; L <= 4; L++) {
    const y = by - L;
    for (let dx = -L; dx <= L; dx++) for (let dz = -L; dz <= L; dz++)
      if (!(blockAt(bx+dx, y, bz+dz) in MINERALS)) return L - 1;
  }
  return 4;
}
```

Block counts (wiki-exact): level 1 = 9 (3×3), 2 = 34 (+5×5), 3 = 83 (+7×7), 4 = 164 (+9×9). Mixed mineral types allowed anywhere. Sharing base blocks between adjacent beacons works automatically (each beacon checks its own centered squares).

### 9.3 Sky access & active state

`active = levels ≥ 1 && skyClear`, recomputed on the same 80-tick cadence (piston/explosion/build edits are caught within 4 s — acceptable lag, vanilla-equivalent).

`skyClear`: scan the column from `beaconY+1` to Y=127: **blocked** iff any block has opacity class `O` (06 §3). `T` and `F` blocks (glass, leaves, water, ice, snow_layer…) pass — beacons work underwater and under glass (Java 1.13+ verified). **Bedrock exception** (vanilla Nether-ceiling rule): treat `bedrock 17` as transparent for this scan only — kept, one line, so 10's Nether ceiling doesn't kill beacons.

Transitions fire sound events: inactive→active `beacon_activate`, active→inactive `beacon_deactivate`.

### 9.4 GUI & payment flow (exact)

Right-click an **active** beacon → beacon screen (06 §15.3 family). Layout: pyramid-level indicator (1–4 lit chevrons); **Primary Power** column of 5 effect buttons — Speed, Haste (enabled at L1+), Resistance, Jump Boost (L2+), Strength (L3+); **Secondary Power** column (enabled at L4): Regeneration I **or** "Primary II" (upgrade primary to level II); **payment slot** accepting exactly 1 of `iron_ingot 322, gold_ingot 324, diamond 325, emerald (12)`; **confirm button** (checkmark) enabled iff payment slot filled AND a primary is selected.

Flow (Java-verified): selecting buttons is free; pressing confirm **consumes the 1 payment item**, commits `{primaryEffect, secondary}`, closes the screen. Changing powers later costs another payment. Breaking/weakening the pyramid does **not** clear the stored selection — on repair, powers resume with no new payment. Upgrading pyramid size auto-upgrades range/duration but never auto-upgrades to level II (GUI + payment required). Inactive beacon right-click: no screen (vanilla opens it; `> Adaptation:` show it only when active — simpler and loses nothing).

### 9.5 Effect application

Every **80 ticks**, if `active && primaryEffect`:

```
range    = [_, 20, 30, 40, 50][levels]
duration = (9 + 2·levels) s = 11/13/15/17 s → 220/260/300/340 ticks
box      = { |x−bx| ≤ range, |z−bz| ≤ range, y from (by − range) to 127 }   // down `range`, up to sky
targets  = PLAYERS ONLY inside box (Java-verified — mobs never receive beacon effects)
apply (09 engine, ambient = true):
  primaryEffect at amplifier (levels == 4 && secondary == 'primary2') ? 1 : 0
  if (levels == 4 && secondary == 'regen') Regeneration amplifier 0
```

Re-application every 4 s against 11–17 s durations means effects persist 5–9 s (13 s at L4) after leaving range — vanilla feel, no extra code. Single-player: "all players" = the player.

### 9.6 Beam rendering

While `active`: a vertical beam from the beacon top to Y=127, two nested rotating square prisms (the shader adaptation of vanilla's two quad-strip cylinders):

| Layer | Width | Color/α | Rotation |
|---|---|---|---|
| Inner | 0.32 m (5 px) | `#ffffff`, α 0.9, emissive | yaw +0.9°/tick |
| Outer | 0.50 m (8 px) | `#dff3ff`, α 0.25 | yaw −0.45°/tick |

Rendered in the translucent pass, unlit, visible through fog to the render distance. UV scrolls upward 0.25 px/t (rising energy). Stained-glass beam tinting: **OUT** (no stained glass in any registry — state, no hook). If `skyClear` fails the beam and effects cut together (§9.3).

---

## 10. Persistence

### 10.1 End fight record (AMENDS 01 §16.1; stored in 10's End dimension meta)

```js
endFight: {
  dragonAlive: bool,
  dragonKilledCount: int,                 // 0 → next death is "first kill" (12000 XP + egg)
  dragon: null | { pos, vel, yaw, pitch, health, phase, phaseTicks, breathCount,
                   perchDamage, nodeIndex, deathTicks },   // null when !dragonAlive
  crystalsAlive: bool[10],                // index-matched to 11's PILLAR_POSITIONS
  gatewaysSpawned: int,                   // 0..20
  eggPlaced: bool, eggCollected: bool,
  exitPortalActive: bool,
  respawnSequence: null | { tick: int }   // §7.11 progress
}
```

Pillar crystals also exist as chunk-entity records (below) — `crystalsAlive` is the authority on load; missing/extra crystal entities are reconciled against it. On load with `dragonAlive`: respawn the dragon entity from `dragon`, re-add the boss bar when a player enters the End.

### 10.2 Chunk entity records (extend 01 §16.1 `entities`)

```js
{ type: 'end_crystal', pos, hasBase, playerPlaced }                    // beamTarget recomputed
{ type: 'wither', pos, vel, health, invulnTicks, blueCounter: [a,b],
  sideCooldown: [a,b], breakCounter, targetless-timers-reset-on-load } // armored derived from health
```

The wither is a normal chunk-resident entity (01 §16 rules): saved with its chunk, restored on chunk load, boss bar re-added when the §1 range check passes. It never despawns while unloaded (chunks freeze; acceptable — vanilla parity).

### 10.3 Block entities

`beacon` block entity saves `{primaryEffect, secondary}` only (levels/active recomputed). `dragon_egg` and `wither_skeleton_skull` are plain blocks (id + state nibble), no entity record.

---

## 11. Sound events (for 16-AUDIO)

Vanilla-named events emitted by this file's systems; 16 owns synthesis/mapping. Volume/pitch given where vanilla is distinctive.

| Event | Emitted when | Notes |
|---|---|---|
| `entity.ender_dragon.ambient` | HOLDING, every 200–400 t | roar, vol 2.5 |
| `entity.ender_dragon.flap` | wing-beat zero crossing (§6.6) | vol 5.0 |
| `entity.ender_dragon.growl` | perch roar (§7.3 BREATH), respawn-ritual beats | vol 2.5 |
| `entity.ender_dragon.shoot` | fireball fired | vol 10.0 |
| `entity.ender_dragon.hurt` | dragon damaged | |
| `entity.ender_dragon.death` | death tick 0 | vol 5.0, audible arena-wide |
| `entity.dragon_fireball.explode` | breath cloud spawned from fireball | |
| `entity.wither.ambient` | random idle | pitch 0.8–1.2 |
| `entity.wither.spawn` | birth explosion (§8.3) | **global** — full volume everywhere (Java) |
| `entity.wither.shoot` | any skull fired | vol 2.0 |
| `entity.wither.break_block` | block-eating volley (§8.8) | vol 2.0, the "klaxon" crunch |
| `entity.wither.hurt` / `entity.wither.death` | damaged / dies | |
| `entity.generic.explode` | crystal, skull, birth explosions (05 §12 reuse) | vol 4.0, pitch 0.56–0.84 |
| `block.beacon.activate` / `block.beacon.deactivate` | §9.3 transitions | |
| `block.beacon.ambient` | active beacon, looped hum | vol 0.8 |
| `block.beacon.power_select` | GUI confirm consumed payment | |
| `block.end_portal.spawn` | exit-portal activation (11 visual, our trigger) | global in the End |
| `entity.enderman.teleport` (reuse) | dragon egg teleports | |

---

## 12. ID assignment table (final)

| Kind | ID | Name |
|---|---:|---|
| Block | 185 | dragon_egg |
| Block | 186 | wither_skeleton_skull |
| Block | 187 | beacon |
| Block | 188–189 | reserved by 13, unused |
| Item | 450 | nether_star |
| Item | 451 | end_crystal |
| Item | 452 | dragon_breath |
| Item | 453–459 | reserved by 13, unused |
| Entity types | — | `ender_dragon` (+2 part boxes), `wither`, `wither_skull` (black/blue flag), `dragon_fireball`, `end_crystal`, breath cloud (09's entity, our params) |

External ids consumed: soul_sand/soul_soil, ghast_tear (10); end_stone, end_portal, end_portal_frame, end_gateway, iron_bars, eye_of_ender (11); emerald + emerald_block (12); iron/gold/diamond blocks 28/29/30, obsidian 33, bedrock 17, glass 31, chest 37, fire 65, water 63, lava 64 (06).

---

## Acceptance checklist

Boss bar
- [ ] Spawning a wither shows a purple top-center bar that fills during the 220-tick birth; the dragon shows a pink bar to any player in the End; two bosses at once stack two bars; bars remove on death and restore after save/load.
- [ ] Wither bar appears/disappears crossing the 128-block range; bar fill animates smoothly toward the true fraction.

End crystals
- [ ] 10 crystals spawn on 11's pillars with bedrock base plates and cosmetic fire; the two caged ones are shielded by iron bars.
- [ ] Any damage instance (including a 1-damage arrow) detonates a crystal at power 6 (~85 max pre-armor damage point-blank); a crystal killed by another explosion vanishes without exploding; pillar tops are never cratered (bottom-centered blast).
- [ ] While the dragon is within the ±32 cuboid of a crystal, a white beam links them and the dragon heals 2 HP/s; destroying that crystal deals 10 to the dragon and triggers a strafing fireball run.
- [ ] Crafted crystals (7 glass + eye of ender + ghast tear) place only on obsidian/bedrock with 2 air above, without a base plate.

Ender dragon
- [ ] Dragon circles a 12-node ring outside the pillars while crystals live, inside once they're gone; head hits deal full damage, body hits deal `raw/4 + min(1, raw)`; no knockback, no crits, no fire/status damage ever lands.
- [ ] Wing contact deals 5 and flings the player upward-outward; charge head contact deals 10; contact suspends for 0.5 s after the dragon is hurt.
- [ ] Strafing fires a purple 1×1 fireball inside 64 blocks; impact spawns a growing (3→7) purple cloud lasting 30 s dealing 6 armor-ignoring damage per second inside it.
- [ ] Perch odds are 1/(3+crystalsAlive) per completed node; dragon lands on the exit portal, breathes (roar + 3-s stream + radius-3 cloud) when a player is within 20, charges if nobody approaches for 5 s, and takes off after 4 breaths, 50+ accumulated damage, or no player within 150.
- [ ] While perched, arrows ignite and bounce for 0 damage; melee on the head hurts at full value.
- [ ] Flying through terrain deletes blocks with no drops (chests spill contents) but never end stone, obsidian, bedrock, iron bars, or any portal block.
- [ ] Death: dragon flies to the portal, ascends 10 s with white flicker + growing light rays; first kill drops 10×960 + 1×2400 = 12,000 XP, fills the exit portal, spawns the egg and 1 gateway; repeat kills drop 500 XP and gateways stop at 20.
- [ ] Egg teleports (≤8 blocks) on any click with magenta motes; falls like sand; drops as an item when it falls onto a torch or is pushed by a piston.
- [ ] Placing 4 crafted crystals on the portal's cardinal rim cells runs the 604-tick ritual: beams sweep pillar to pillar, all 10 crystals and both cages regenerate, the dragon respawns at full HP, and the 4 ritual crystals detonate; breaking a ritual crystal mid-sequence cancels it.

Wither
- [ ] The 4-soul-block T + 3 skulls (skull placed last, any of the 3 positions, X or Z alignment) consumes the structure and spawns a wither: 220 ticks blue/scaling/invulnerable, then a power-7 explosion and a global spawn sound.
- [ ] 300 HP, +1 HP/s regen, +5 on kills; targets the nearest player at 40, else farm animals/creepers/spiders/endermen — never zombies or skeletons; hovers 5 above its target, at eye level once armored.
- [ ] Center head fires at its target every 2 s (0.1% blue); side heads volley every 2–3 s at independent targets and spray random blue skulls when target-starved (~10–17 s) or when the wither is damaged rapidly (+3 counter per hit).
- [ ] Black skulls: 0.9 b/t, 8 dmg + Wither II 10 s (hearts turn black, health drains, can kill), power-1 explosion that can't break stone-grade blocks... blue skulls: slower (0.5 b/t) and crater anything including obsidian, but never bedrock/portal blocks.
- [ ] 20 ticks after any damage the wither eats a 3×4×3 hole around itself, dropping the blocks as items (obsidian farming works); suffocation traps only work with bedrock/portal blocks.
- [ ] Below 150 HP: arrows bounce off harmlessly, wither descends to target height, armored overlay shows; regenerating past 150 removes it.
- [ ] Death drops exactly 1 nether star (never despawns, survives explosions) + 50 XP; wither persists through save/load with counters intact and never despawns.

Beacon
- [ ] Recipe 5 glass + nether star + 3 obsidian; block emits light 15 and survives a creeper (blast 3... adjacent explosion breaks pyramid instead — recheck deactivates within 4 s).
- [ ] Pyramid detection: 9/34/83/164 mixed iron/gold/diamond/emerald blocks give levels 1–4; a single missing base block drops the level within 80 ticks.
- [ ] Activation requires a sky column with no opaque blocks (glass/water/leaves fine, bedrock exempted); beam renders as two counter-rotating prisms to Y=127 and cuts instantly when roofed over.
- [ ] GUI: primary powers gate by level (speed/haste → +resistance/jump → +strength), secondary at level 4 (regen or primary II); confirm consumes exactly 1 iron/gold/diamond/emerald payment; re-selection costs again; pyramid repair restores powers for free.
- [ ] Effects tick every 4 s to players only, in the box ±range horizontally, range below to sky above, lasting 11–17 s (ambient-flagged, subtle particles per 09); walking out of range fades the buff after the remaining duration.

Persistence
- [ ] Save/reload mid-dragon-fight restores dragon HP/phase, surviving crystals, boss bar, gateway count, and egg state; reload mid-ritual resumes the sequence; reload with a half-dead armored wither restores its armor state and skull cooldowns.
