# 07 — REDSTONE: Power, Components & Automation

This expansion adds the full redstone circuit layer to VoxelCraft: the 0–15 power model with strong/weak block powering, redstone dust with vanilla connection shapes and falloff, and the component set — redstone torch (with burnout), lever, buttons, pressure plates, repeater (1–4 delay + locking), comparator (compare/subtract + container reading), piston & sticky piston (12-block push), observer, dispenser & dropper, hopper (superseding base 06's hopper exclusion), redstone lamp, note block, redstone block, plus redstone ignition for base TNT and redstone control of base doors. Baseline = Minecraft Java 1.20 exact values (all timings verified against minecraft.wiki, stated in game ticks; 1 redstone tick = 2 game ticks at our 20 TPS). Cross-refs: 01 (scheduled ticks §6, setBlock pipeline §4.6, save §16), 04 (light engine — lamp/torch emission), 05 (Arrow entity for dispensers, entity classes for plates), 06 (canonical registries this file extends), 08 (item `tags` object — referenced, not redefined), 09 (splash potions via dispenser), 10 (Nether quartz — recipe note), 14 (multiplayer), 15 (waterlogging bit7, fire), 16 (audio synthesis for the sound events named here). Deliberate exclusions in §1.

## Amendments to base files

- **AMENDS CLAUDE.md §7 (Out of scope v2):** ensure "Redstone circuitry" is absent from the out-of-scope list — redstone is in scope in v2, fully specified by this file.
- **AMENDS 06 preamble ("Scope decisions (final)"):** move "redstone circuits" and "hoppers" from EXCLUDED to INCLUDED (owned by 07-REDSTONE.md). This explicitly supersedes the base exclusion of hoppers.
- **AMENDS 06 §7.4:** item 342 `redstone` — replace note "collectible only (no circuits)" with "places block 70 `redstone_wire` on right-click against the top of a supporting block (07 §4.1); crafting ingredient per 07 §15." Item 343 `lapis_lazuli` — replace "collectible only" with "crafting ingredient for comparator/observer (07 §15, quartz substitute)".
- **AMENDS 06 §2 and §3:** append block registry rows for ids 70–89 exactly as given in 07 §13 (gameplay table and light/render/physics table).
- **AMENDS 06 §4:** append the texture recipes of 07 §14.
- **AMENDS 06 §10:** append the crafting recipes of 07 §15.
- **AMENDS 06 §5.6 (TNT):** add ignition source "(d) redstone activation: whenever the TNT block's `isActivated` predicate (07 §3.5) becomes true (on placement or on any block update), the block is removed and a primed-TNT entity spawns with the standard 80 t fuse."
- **AMENDS 06 §5.13 (doors):** add: "State bit4 = redstone latch. On every block update of either half, compute `p = isActivated(lower) || isActivated(upper)` (07 §3.5). If `p != bit4`: set bit4 = p on both halves and force `open = p` (both halves, collision panel + mesh update). Manual right-click toggling remains allowed at any time."
- **AMENDS 06 §6.1:** extend the fluid-destructible (`canReplace`) list with: redstone_wire, redstone_torch, lever, both buttons, both pressure plates, repeater, comparator — they pop with drops when flooded. (Waterlogging of these blocks stays impossible; bit7 is owned by 15-FIRE-WATERLOGGING.)
- **AMENDS 01 §2 (module map):** add directory `src/redstone/` with four files: `RedstoneEngine.js` (power predicates, dust network solver, update fan-out, per-tick budget — 07 §3/§5), `components.js` (torch/lever/button/plate/repeater/comparator/observer/lamp/noteblock handlers + TNT/door hooks — 07 §6–§8, §12), `PistonMover.js` (push-set computation + move transaction — 07 §9), `containersRedstone.js` (dispenser/dropper/hopper block-entity logic — 07 §10–§11). Also: `ui/containers.js` gains dispenser/dropper (3×3) and hopper (1×5) screens.
- **AMENDS 01 §5 (block registry schema):** add engine field `conductive: bool` — default `opaque && shape === 'cube'`; per-block overrides in 07 §13. Add optional callbacks `onUse`, `onNeighborChanged`, `onScheduledTick`, `onMoved` consumed by 07's dispatcher.
- **AMENDS 01 §4.6 (setBlock pipeline):** after step 7 (`neighborUpdates`) add step 8: `redstone.onCellChanged(x,y,z, old, id)` — (a) notifies any adjacent observer watching this cell (07 §6.6), (b) queues adjacent dust networks for re-solve (07 §5.2), (c) runs second-order updates: for each face-adjacent conductive block B, notify B's 6 face neighbors' redstone handlers (07 §5.3).
- **AMENDS 01 §6.1:** unchanged mechanics, new consumers — redstone component delays (torch 2 gt, repeater 2–8 gt, comparator 2 gt, piston 2 gt, dispenser/dropper 4 gt, lamp-off 4 gt, button 20/30 gt, plate 20 gt, observer 2+2 gt) all use this bucket queue. The existing "outside SIM_RADIUS → re-schedule +40" rule applies to them verbatim (circuits freeze, 07 §5.6).
- **AMENDS 01 §16.1 (chunk record):** `blockEntities` gains types `'dispenser' | 'dropper' | 'hopper'` with `data` shapes per 07 §17.
- **AMENDS 01 §15.3 (F3 overlay):** add one line: targeted cell's `strongPowerInto/weakPowerInto` values and, if dust, its stored power.
- **AMENDS 03 §16.3 (interactables):** add to the `interactable` list: lever, stone_button, wooden_button, repeater, comparator, note_block, dispenser, dropper, hopper (behaviors per 07; sneak-place rule of 03 §16 applies unchanged).
- **AMENDS 05 §11 (arrows):** allow `owner = null` arrows (dispenser-fired): skip the 5-tick owner exclusion; they are player-collectible. Add: when an arrow becomes `stuck` (or a stuck arrow despawns), notify the block it is stuck against via `onNeighborChanged` — wooden buttons and plates react (07 §6.3–6.4).

## Contents

1. [Scope decisions & exclusions](#1-scope-decisions--exclusions)
2. [ID allocation (final)](#2-id-allocation-final)
3. [Power model](#3-power-model)
4. [Redstone dust](#4-redstone-dust)
5. [Simulation architecture](#5-simulation-architecture)
6. [Input components & sources](#6-input-components--sources)
7. [Repeater](#7-repeater)
8. [Comparator](#8-comparator)
9. [Piston & sticky piston](#9-piston--sticky-piston)
10. [Dispenser & dropper](#10-dispenser--dropper)
11. [Hopper](#11-hopper)
12. [Lamp, note block, TNT, doors](#12-lamp-note-block-tnt-doors)
13. [Registry tables](#13-registry-tables)
14. [Texture recipes](#14-texture-recipes)
15. [Crafting recipes](#15-crafting-recipes)
16. [Sound events](#16-sound-events)
17. [Persistence](#17-persistence)
18. [Multiplayer note](#18-multiplayer-note)
19. [Acceptance checklist & test circuits](#19-acceptance-checklist--test-circuits)

---

## 1. Scope decisions & exclusions

**INCLUDED** — everything in the intro paragraph. **EXCLUDED (final):** tripwire + tripwire hooks, rails + all minecarts (incl. hopper minecarts), target block (needs projectile-to-center distance math for one niche block — cut), daylight sensor, trapped chest, weighted pressure plates, lectern/jukebox/bell, sculk sensors, slime/honey blocks, iron door/trapdoors (no block in base registry), redstone-ore glow-on-touch.

> Adaptation: **Quasi-connectivity is excluded.** Pistons, dispensers, and droppers check only their own cell's activation (07 §3.5), never the cell above. No BUD behavior exists; anything observable must use an observer. This trades vanilla-obscure mechanics for a deterministic, debuggable simulation.

> Adaptation: **No 1-gt (0-tick) tech.** Component reactions are scheduled at whole game-tick boundaries through 01 §6.1; sub-tick block-event ordering games (piston block-dropping, 0-tick pulses) are deliberately not reproducible.

## 2. ID allocation (final)

Hard ranges granted to this file: blocks 70–104, items 460–469.

| Block ID | Name | Block ID | Name |
|---:|---|---:|---|
| 70 | redstone_wire | 80 | sticky_piston |
| 71 | redstone_torch | 81 | piston_head |
| 72 | lever | 82 | observer |
| 73 | stone_button | 83 | dispenser |
| 74 | wooden_button | 84 | dropper |
| 75 | stone_pressure_plate | 85 | hopper |
| 76 | wooden_pressure_plate | 86 | redstone_lamp |
| 77 | repeater | 87 | redstone_lamp_lit |
| 78 | comparator | 88 | note_block |
| 79 | piston | 89 | redstone_block |

Blocks 90–104: **reserved, unused.** Items 460–469: **none used** — dust places from base item 342 `redstone`; every other component places from its block-id stack (base convention). `redstone_wire` has **no block-item** (add it to 06 §1's no-block-item list); `redstone_lamp_lit` places as `redstone_lamp` (like `furnace_lit`).

All state-byte layouts in this file use bits 0–6 only; **bit7 is globally reserved for waterlogging (owned by 15-FIRE-WATERLOGGING)**. Shared facing enum for 6-directional components:

```
FACE6: 0 = -Y down, 1 = +Y up, 2 = -Z north, 3 = +Z south, 4 = -X west, 5 = +X east
ATTACH: 0 = floor, 1 = wall N (-Z), 2 = wall E (+X), 3 = wall S (+Z), 4 = wall W (-X), 5 = ceiling
HFACE: 0 = N, 1 = E, 2 = S, 3 = W   (horizontal-only components; = direction of OUTPUT)
```

## 3. Power model

### 3.1 Signal

Power is an integer 0–15. 0 = off; any value ≥ 1 activates mechanisms. Only redstone dust attenuates (−1 per dust cell, §4); component outputs are always 15 except the comparator (its computed level).

### 3.2 Conductive blocks

A block **conducts** power iff registry `conductive` is true (default: full opaque cube). Per-block overrides in §13: pistons (any state), piston_head, observer, redstone_block, hopper, glass, leaves are NOT conductive; dispenser, dropper, note block, redstone lamp (both states), TNT, and every base opaque cube (incl. glowstone) ARE conductive.

> Adaptation: vanilla glowstone and redstone lamps are non-conducting "transparent" blocks; ours conduct because our registry derives conductivity from the opaque flag 06 already assigns them. Difference is only visible in exotic builds.

### 3.3 Strong vs weak power

Sources inject power into *cells* under two labels:

- `strongPowerInto(cell)` — makes a conductive block at `cell` **strongly powered**.
- `weakPowerInto(cell)` — makes a conductive block at `cell` **weakly powered**; also directly activates a mechanism occupying `cell`. Every strong target is also a weak target.

**Source emission table (authoritative):**

| Source (active) | Strong 15 into | Weak into (level) |
|---|---|---|
| Lever (on) | its attachment block | all 6 neighbors (15) |
| Button (pressed) | its attachment block | all 6 neighbors (15) |
| Pressure plate (pressed) | block directly below | all 6 neighbors (15) |
| Redstone torch (lit) | block directly above | all neighbors except attachment block (15) |
| Redstone block | — (never strong) | all 6 neighbors (15) |
| Repeater (output on) | block it faces | the cell it faces (15) |
| Comparator (output L > 0) | block it faces | the cell it faces (L) |
| Observer (pulsing) | block at its back | the cell at its back (15) |
| Redstone dust (power p) | — (never strong) | block below it (p); each cell it points into (p) |

Derived values for a conductive block B:

```
strong(B) = max(strongPowerInto(B) over all sources)          // 0..15
weak(B)   = max(strong(B), weakPowerInto(B) over all sources) // 0..15  ("B is powered" ⇔ weak(B) > 0)
```

### 3.4 Who reads what (the two load-bearing rules)

1. **Dust reads only STRONG.** A dust cell's injected level = max of (a) source weak-emissions into its cell from *non-dust* sources, (b) `strong(B)` of each of its 6 face-adjacent conductive blocks. A merely weakly powered block never feeds dust (prevents dust→block→dust conduction).
2. **Mechanisms read WEAK.** See §3.5.

### 3.5 Mechanism activation predicate

Mechanisms = piston, sticky piston, dispenser, dropper, redstone lamp, note block, TNT, door, hopper (inverted: power = locked).

```
isActivated(m) =
     weakPowerInto(m.cell) > 0                         // dust on top / pointing in, adjacent source,
                                                       // repeater/comparator/observer output into it, torch below, ...
  or any of m's 6 face neighbors is a conductive block B with weak(B) > 0
```

Dust that is merely beside a mechanism but pointing elsewhere does NOT activate it (its weak targets are only "below" and "pointed-into" cells).

### 3.6 Worked diagram

Side view, east →. `S*` = stone, `·p` = dust at power p, `[R>]` = repeater facing east, `(L)` = lamp.

```
Case A — weak power stops dust, still activates mechanisms:
  y+1:   (lever ON)                      ·9   ·8  →S2   ·0        (L)
  y  :      S1        ·15  ·14  … ·9        (dust points into S2)  ↑ adjacent to S2
  S1: strongly powered by lever → feeds dust at 15.
  S2: weakly powered by the ·8 dust pointing into it → weak(S2)=8.
      → dust east of S2 stays 0 (rule §3.4-1)  BUT lamp adjacent to S2 lights (rule §3.5).

Case B — strong power conducts through the block:
  y  :   ·15  [R>]  S3   ·15  ·14 …
  Repeater output strongly powers S3 → dust east of S3 re-reads 15.
```

The acceptance checklist tests exactly these two cases.

## 4. Redstone dust

### 4.1 Block, placement, state

Block 70 `redstone_wire`, placed by item 342 on the **top face** of a supporting block: any conductive block, plus glass (approx of vanilla's transparent-support subset). Hardness 0, drops 1 `redstone`. Pops as an item when support is removed, when flooded (06 §6.1 amendment), or when pushed by a piston. Not collidable, not conductive, shape `wire`.

**State byte:** bits 0–3 = power 0–15. Bits 4–6 unused. Connection shape is NOT stored — recomputed from neighbors by both the solver and the mesher.

### 4.2 Connections & shape

For each horizontal direction `d` from dust at `p`:

```
connects(p, d):
  n = p + d
  if wire(n)                                    → LEVEL
  if wire(n + UP)   and not conductive(p + UP)  → UP_SLOPE     // climbs the face of block at n
  if wire(n + DOWN) and not conductive(n)       → DOWN_SLOPE   // drops over the edge
  if attracts(block(n), d)                      → LEVEL        // visual + power hookup to components
  else                                          → NONE
```

`attracts`: redstone torch, lever, buttons, plates, redstone block, observer (back face only), repeater/comparator (front or back cell along their axis only), and dust never attracts to pistons/lamps/note blocks/containers (matching vanilla dust shapes; you must point dust *at* those with a real connection or run it on top of an adjacent conductive block).

Shape from the 4 results: 0 connections → **cross** (behaves and renders as connected on all 4 sides — vanilla 1.16+ default; the right-click dot toggle is cut); 1 connection → straight **line** along that axis; 2 opposite → line; 2 orthogonal → **bend**; 3 → **T**; 4 → **cross**. A conductive block sitting on top of dust does not remove the dust but blocks all UP_SLOPE connections through that cell.

### 4.3 Network power (falloff 1/block)

Dust network power is solved as a unit (§5.2): each dust cell's level = max over (its own injection per §3.4-1, best connected-neighbor level − 1), floored at 0. Slope connections count as ordinary graph edges (no extra cost). Signal therefore dies 15 cells from a full-strength source.

### 4.4 Dust as an output

Per §3.3: dust weakly powers the block beneath it and every cell it points into, at its own level. Dust powers/feeds adjacent dust only through the connection graph (−1), never through blocks.

### 4.5 Rendering

- Mesh (cutout bucket, unlit-by-AO: AO=1.0, shade 1.0, light = own cell): flat quads at `y + 1/64`. Compose from a center 6×6 px quad (`dust_dot` tile) plus one 5×6 px arm quad per connected direction (`dust_line` tile halves); UP_SLOPE adds a vertical 16×16 quad on the neighbor block's face.
- **Brightness ramp:** 16 pre-tinted variants of each dust tile are painted into the atlas at build time (32 tiles total). Tint for power p, `f = p/15`: `r = 0.4 + 0.6f`, `g = max(0, 0.7f² − 0.5)`, `b = max(0, 0.6f² − 0.7)` (vanilla ramp), multiplied over the grayscale dust texture. Mesher picks the variant by state power.
- Power changes mark the chunk dirty through the normal budgeted remesh queue (01 §4.5) — NOT the synchronous player-edit path. A 1 Hz clock remeshing its chunk every cycle is within budget; logic never waits on visuals.
- Particles: lit dust (p > 0) has a 1/8 chance per random-cosmetic frame to emit one red particle `(approx, cosmetic only)`.

## 5. Simulation architecture

### 5.1 Overview

Two layers:

1. **Instant layer (same game tick):** dust network re-solve + recomputation of `strong/weak/isActivated` for affected cells. Runs synchronously whenever an output changes, no matter which tick-phase caused it (player click in step 2, entity plate-press in step 3, scheduled tick in step 4 of 01 §3's tick order).
2. **Delayed layer:** every component reaction with a nonzero delay is a scheduled tick (01 §6.1) at `worldTime + delay`. Handlers re-verify their inputs at fire time (inputs may have changed during the delay).

There is no separate `redstone.tick()` phase; the engine is event-driven. Determinism: within one scheduled-tick bucket, entries run in insertion order (01 §6.1 behavior, unchanged); all redstone insertions happen at deterministic points of the fixed tick order.

### 5.2 Dust network re-solve

```
onOutputChanged(p):                        // any source output, block power, or dust support change at p
  for n in {p} ∪ 6 neighbors ∪ slope-relevant diagonals (n±d±UP/DOWN where wire present):
    if wire(n): pendingNetworks.add(networkSeed = n)
  solvePending()                           // synchronous, same tick

solveNetwork(seed):
  wires = BFS over connects() graph from seed, cap MAX_NET_CELLS = 1024   // truncate + console.warn beyond
  inject[w] = per §3.4-1 for each w in wires
  // multi-source BFS with decay 1:
  level = inject; queue = wires with level > 0, max-first (bucket by level 15..1)
  while queue: pop w; for each connected neighbor v: if level[w]-1 > level[v]: level[v] = level[w]-1; push v
  for each w whose stored state power != level[w]:
    chunk.states[w] = level[w]; markDirty(chunk of w)      // remesh via budgeted queue
    changed.add(w)
  for each w in changed: notifyTargets(w)   // block below, pointed cells, adjacent components → §5.3
```

Re-entrancy: `notifyTargets` may enqueue further networks (e.g. dust → block → second dust net via a repeater is delayed anyway, but dust → conductive-block-strong changes from levers cascade); `solvePending()` loops until empty under a per-tick budget: `MAX_NET_SOLVES_PER_TICK = 256` networks or `MAX_CELLS_PER_TICK = 16384` dust cells. Overflow → remaining seeds carry to next tick's start (processed before step 2 of the tick order). Pure dust graphs cannot oscillate within a tick (the solve is a fixpoint); any feedback loop necessarily passes through a delayed component (torch/repeater/comparator/observer ≥ 2 gt), so same-tick infinite loops are structurally impossible.

### 5.3 Update fan-out ("block updates")

`redstone.onCellChanged(p)` (01 §4.6 step 8) and `notifyTargets` deliver `onNeighborChanged` to component blocks:

- Direct: the 6 face neighbors of `p`.
- Second-order: for each face neighbor B of `p` that is conductive, also the 6 face neighbors of B (a powered block "reaches through" one block — replaces vanilla's update shape without QC).

Component handlers are cheap pure reads (`isActivated`, rear power, lock state); each compares against its latch bit(s) and schedules its delayed reaction only on a real change. Per-handler cost O(6–12 block reads).

### 5.4 Tick-phase ordering vs fluids & gravity

Redstone delayed reactions share the 01 §6.1 bucket queue with fluids; within a bucket, FIFO insertion order. Consequences (accepted, deterministic): a piston extending into a cell a fluid was scheduled to flow into resolves by whoever runs first in the bucket. Piston moves call `setBlock` for every moved cell, which fires the standard neighbor updates — falling blocks (01 §6.4) and fluid wake-ups behave exactly as for player edits. Pressure-plate presses happen inside entity ticks (01 §3 step 2/3), i.e. before this tick's scheduled bucket runs.

### 5.5 Budgets

| Metric | Budget |
|---|---|
| Dust solver | ≤ 1 ms/tick typical; hard caps per §5.2 |
| Component scheduled ticks | ≤ 500/tick before console warning |
| Hoppers + dispenser BEs ticked | only within SIM_RADIUS, via per-chunk blockEntities maps |
| Dust remesh | normal 01 §4.5 queue; never synchronous |

### 5.6 Chunk borders & unloaded chunks

- Networks may span loaded chunks freely (world-coord BFS like the light engine).
- A network edge into a **non-GENERATED** chunk is treated as air (wire ends there). When a chunk reaches GENERATED and enters SIM_RADIUS for the first time since load, every wire cell on its 4 border planes is enqueued as a network seed — heals cross-border seams exactly like 04 §9.1's border import.
- **Circuits in unloaded chunks freeze.** State bytes persist power/latches byte-exact; scheduled ticks outside SIM_RADIUS re-schedule +40 t (01 §6.1) so clocks stall rather than fast-forward. On reload, components re-evaluate on their next block update or deferred scheduled tick; no global re-simulation pass exists.

## 6. Input components & sources

All six blocks here: hardness/drops per §13, no collision, cutout bucket, not conductive, `needsSupport` (pop when attachment block removed). Placement writes the ATTACH/HFACE state from the clicked face / player facing.

### 6.1 Lever (72)

- State: bits0–2 ATTACH, bit3 on. Placeable on floor, walls, ceiling of any conductive block or glass.
- Right-click: toggle bit3, `block.lever.click` (pitch up on, down on off), `onOutputChanged` immediately. No delay, latching.
- Emission per §3.3 while on.

### 6.2 Stone button (73) / wooden button (74)

- State: bits0–2 ATTACH (floor/wall/ceiling), bit3 pressed.
- Right-click when unpressed: pressed = 1, `block.button.<mat>.on`, output per §3.3, schedule release: **stone +20 gt (1.0 s), wooden +30 gt (1.5 s)**. At due tick: pressed = 0, `block.button.<mat>.off`, `onOutputChanged`. Re-clicking while pressed does nothing (no timer refresh — vanilla).
- **Wooden button + arrows:** while an arrow entity is stuck in the button's cell, the button is pressed; the release tick re-checks and stays pressed until the arrow despawns/is collected (then releases immediately via the 05 §11 amendment notification). Stone buttons ignore arrows.

### 6.3 Pressure plates: stone (75) / wooden (76)

- State: bit0 pressed. Placeable only on the top face of a conductive block or fence `(approx: vanilla allows fences)`. Shape: 14×1×14 px plate (1/16 high when pressed — visual only), no collision.
- **Trigger classes:** wooden plate = ANY entity (Player, all Mobs, ItemEntity, Arrow, XpOrb, FallingBlock, PrimedTnt, ThrownProjectile). Stone plate = living entities only (Player + Mobs).
- Detection is event-driven: whenever a qualifying entity's tick ends with its AABB intersecting the plate's cell box (the 14×4-px-tall detection box `(approx: full cell footprint, height 0.25)`), an unpressed plate presses: bit0 = 1, `block.pressure_plate.<mat>.on`, output per §3.3, schedule re-check +20 gt.
- Re-check tick: scan entities in the cell (01 §13.2 spatial index). Occupied → re-schedule +20 gt. Empty → release: bit0 = 0, `block.pressure_plate.<mat>.off`, `onOutputChanged`. Net effect: **deactivates 20 gt (1.0 s) after the last entity leaves** (wiki-exact granularity: release lands on the 20-gt re-check grid `(approx: vanilla re-checks continuously)`).

### 6.4 Redstone torch (71)

- State: bits0–2 ATTACH (0 floor, 1–4 wall; no ceiling), bit3 lit. Placed lit. Light emission **7** while lit (04 §8 already lists this value); relight/unlight through the standard 04 §9.4 emission path on every lit-bit flip.
- **Inversion:** input = its attachment block: `on-condition = weak(attachBlock) == 0`. On any neighbor update where `lit != on-condition`, schedule a toggle **+2 gt** (1 redstone tick); at due tick re-verify, then flip bit3, fire `onOutputChanged`, update block light. Multiple updates during the 2 gt coalesce (one scheduled entry per cell — 01 §6.1 dedup).
- Emission while lit per §3.3: strong 15 up, weak 15 to all neighbors except the attachment block.
- **Burnout (vanilla-exact trigger):** keep a transient per-torch ring buffer of turn-OFF times (Map<cellKey, int[8]>, not persisted). If a toggle-to-off makes **more than 8 turn-offs within the last 60 gt**: the torch burns out — bit3 = 0, `block.redstone_torch.burnout` + smoke particles, and it **ignores all state changes** while burned out.
- **Relight:** on any subsequent block update, if the 60-gt window now holds < 8 turn-offs, the torch re-evaluates normally (schedules +2 gt toggle if it should be lit). Additionally a self-check is scheduled +160 gt after burnout `(approx: vanilla's 160 t self-relight is update-chain-dependent)`. No limit on repeat burnouts.

### 6.5 Redstone block (89)

Full cube, craftable/storable (§15), pushable by pistons, conductive **no**. Constant source: weak 15 to all 6 neighbors, never strong (§3.3). No state.

### 6.6 Observer (82)

- State: bits0–2 FACE6 = direction of the **watched face** (set opposite the player's look at placement, so the face looks at what the player was pointing away from — vanilla parity: observer face points toward the player's placement direction), bit3 = pulsing. Output = back cell (opposite the watched face).
- **Detection:** `redstone.onCellChanged` (01 §4.6 step 8) checks the 6 neighbors of every changed cell for observers whose watched cell is the changed cell. Watched triggers = any `blocks[]` id change or `states[]` byte change (block place/break, dust power change, crop stage, fluid level, repeater delay click, door open, piston head appearing …). Light changes and entity movement do NOT trigger.
- **Pulse (wiki-exact):** on trigger, if not already pulsing, schedule +2 gt: set bit3 = 1, emit strong+weak 15 at the back (§3.3), `onOutputChanged`, schedule +2 gt: bit3 = 0, `onOutputChanged`. Triggers arriving while pulsing or while the on-pulse is pending are dropped (vanilla re-arms after the pulse; the pulse-off edge itself is a state change and correctly chains observer-lines).
- Being **moved by a piston** counts as a trigger: pulse 2 gt after landing (`onMoved` hook).

## 7. Repeater (77)

- State: bits0–1 HFACE output direction (faces away from the player on placement), bits2–3 delay setting 0–3, bit4 output-on, bit5 locked. Shape: 2/16-high slab `(approx: torch nubs are texture-only)`, collidable 2/16 box, placeable only on a conductive block or glass; pops if support removed.
- Right-click: delay setting = (setting + 1) & 3, `block.repeater.click`. **Delay = (setting + 1) redstone ticks = 2/4/6/8 gt.**
- Input (rear cell only): dust (level > 0), a source emitting into the repeater's cell from the rear position, or a conductive rear block with `weak(B) > 0`. Binary — any input > 0 counts as on.
- On rear-input change while not locked and `input != output`: schedule state change at +delay. At due tick: re-read input `(vanilla nuance preserved: a pulse shorter than the delay still produces a full minimum-length output pulse — implement by latching the target state at schedule time and not cancelling on input flicker)`; set bit4, `onOutputChanged`. Output per §3.3: strong 15 into the faced block, weak 15 into the faced cell.
- **Locking:** on any update, `locked = any side neighbor is a powered repeater or comparator whose HFACE points into this repeater's side`. While bit5 = 1 the output is frozen (pending scheduled changes are ignored at fire time). Lock/unlock is instant. Render: bedrock-colored bar texture across the slab while locked.
- Diode: side and front inputs never affect output; dust does not connect to its sides (§4.2).

## 8. Comparator (78)

- State: bits0–1 HFACE output direction, bit2 mode (0 = compare, 1 = subtract), bits3–6 current output level 0–15. Same slab shape/support rules as the repeater.
- Right-click: toggle mode, `block.comparator.click` (front torch texture lifts in subtract mode).
- **Inputs.** Rear level `R`: dust level; repeater output (15); comparator output (level); redstone block (15); conductive rear block → `weak(B)` level; **container override** — if the rear block is a container (or a conductive block with a container directly behind it — one-block-through reading), `R = containerSignal` (below), ignoring the intervening block's power `(approx of the Java SS15 edge case: we always prefer the container)`. Side levels `A`,`C`: ONLY from dust (level), redstone block (15), and repeater/comparator outputs pointing into that side (their level). Everything else = 0.
- **Output** (recomputed 2 gt after any input/container change — schedule +2 gt, dedup):

```
compare mode :  out = (max(A, C) <= R) ? R : 0
subtract mode:  out = max(R − max(A, C), 0)
```

Store in bits3–6; if changed → `onOutputChanged`. Emission: strong+weak `out` into the faced block/cell (§3.3).

- **Container fullness signal** (wiki-exact):

```
fullness = Σ over slots (count_i / maxStack(item_i)) / slotCount
containerSignal = (all slots empty) ? 0 : floor(1 + 14 × fullness)
```

Readable containers and slot counts: chest 27, furnace/furnace_lit 3, hopper 5, dispenser 9, dropper 9. Container mutations (any UI click, hopper transfer, dispenser fire, furnace smelt consuming/producing) call `redstone.containerChanged(pos)`, which schedules re-evaluation of comparators reading `pos` (directly behind, or behind-through-one-conductive-block).

## 9. Piston & sticky piston

### 9.1 Blocks & state

- Piston 79 / sticky piston 80: bits0–2 FACE6 (head direction; set toward the player on placement so it faces you — vanilla), bit3 extended. Retracted = full cube (conductive **no**), collidable. Extended base: collision full cube `(approx: vanilla 12/16)`.
- Piston head 81: bits0–2 FACE6, bit3 sticky flag. Exists only while its base is extended; breaking either breaks both, dropping 1 piston/sticky_piston. Collision full cube `(approx: vanilla plate+arm)`. Not conductive, targetable.

### 9.2 Timing

Activation edge (via §3.5 `isActivated`, checked on every neighbor update against the extended bit):

- rising and retracted → schedule **extend at +2 gt**;
- falling and extended → schedule **retract at +2 gt**.

At the due tick the handler re-verifies the condition still holds, then performs the whole move **instantly in that tick** (wiki: extension and retraction each take 2 gt in Java, plus a 0–1 gt start delay we round to the fixed 2 gt schedule `(approx)`).

> Adaptation: **instant-move rendering.** No moving-block entity, no 36-block, no animation: blocks teleport one cell on the completion tick and the head block appears/disappears. At 100 ms end-to-end this reads as "fast piston"; the sound events carry the feel. Animated interpolation is explicitly rejected (would need a per-moving-block render object and mesher special cases).

### 9.3 Push rules

```
computePushSet(base, dir):
  set = []; cursor = base + dir
  loop:
    id = block(cursor)
    if id == air or fluid            → break            // fluid in the path cell is DELETED on move
    if breaksWhenPushed(id)          → break            // popped as drops when the row moves
    if immovable(id) or set.len == 12→ return FAIL      // 12-block push limit (wiki-exact)
    if cursor leaves y∈[0,127] or the world border → return FAIL
    set.push(cursor); cursor += dir
```

**Immovable (from OUR registry):** bedrock 17, obsidian 33, storage block entities — furnace 35/36, chest 37, dispenser 83, dropper 84, hopper 85 — plus extended piston bases (79/80 with bit3) and piston heads 81. Crafting table is movable (no stored data).

**breaksWhenPushed (pop as their normal drops):** every non-cube/`needsSupport` block — torches (38, 71), redstone_wire, lever, buttons, plates, repeater, comparator, ladder, all plants/crops/saplings/flowers, sugar cane, snow_layer, cactus (breaks), doors, beds, fire (deleted, no drop). Leaves also break (drop table A). Everything else full-cube is pushable, including TNT (not ignited by pushing), sand/gravel, redstone_block, observer, note block, lamps, glass, ice.

- Extend: if `computePushSet` ≠ FAIL — move blocks from the far end toward the piston (`setBlock(dest, id, {state})` preserving state bytes, then `setBlock(origin, air)`), place `piston_head` in `base + dir`, set bit3 = 1, `block.piston.extend`. Each `setBlock` runs the full 01 §4.6 pipeline (light, neighbor updates → falling blocks/fluids/observers react). Moved blocks with `onMoved` hooks fire them (observer pulse). Entities whose AABB intersects any destination cell or the head cell are pushed `1.0 × dir` via `moveEntity` (no damage `(approx: vanilla can suffocate)`).
- If FAIL → stay retracted; the attempt repeats on the next relevant block update (no re-poll loop).
- Retract: remove head; **sticky only:** the block at `head + dir` is pulled into the head's old cell iff it is movable and not in breaksWhenPushed (otherwise it stays — vanilla). Set bit3 = 0, `block.piston.retract`. Regular pistons never pull.
- A piston is never activated by its own moved blocks in the same tick (activation re-check happens on later updates only).

## 10. Dispenser & dropper

### 10.1 Common

- Dispenser 83 / dropper 84: bits0–2 FACE6 (any of 6 directions, set toward the player's look on placement — vanilla parity incl. up/down), bit3 = activation latch. Conductive yes. Block entity: 9 slots (3×3 UI via `ui/containers.js`; shift-click routing: player ↔ container).
- On every neighbor update: `act = isActivated()`; rising edge (`act && !bit3`) → bit3 = 1 and schedule **fire at +4 gt** (wiki: 2 redstone ticks); falling edge → bit3 = 0. One fire per rising edge — holding power does not repeat-fire.
- Fire: pick a uniformly random non-empty slot; execute the behavior below; if all slots empty → `block.dispenser.fail` (click) and nothing else. Front cell = the cell the face points into.
- Breaking spills all 9 slots + the block. Comparator-readable (§8).

> Adaptation (determinism guard): an item inserted into a dispenser/dropper by another dispenser/dropper/hopper **in the same game tick** is tagged and cannot be fired this tick (the fire fails instead). This makes dual-dropper flip-flops (§19 T2) order-independent, where vanilla relies on block-event ordering.

### 10.2 Dispenser behavior table (our registry)

| Slot item | Behavior on fire |
|---|---|
| arrow (282) | Spawn Arrow entity at front cell center, `owner = null`, speed **1.1 b/t** along facing, gaussian inaccuracy 6 (05 §11 constants) `(approx: vanilla dispense power)`; collectible; `block.dispenser.fire`; count −1 |
| egg (333) / snowball (335) | ThrownProjectile, same launch numbers; normal 06 §7.4 impact rules (egg 1/8 chick) |
| water_bucket / lava_bucket (286/287) | If front cell `canReplace` (06 §6.1): place source fluid there; slot item becomes empty `bucket`. Else default-drop |
| bucket (285) | If front cell is a fluid **source**: remove it, slot item becomes the filled bucket. Else default-drop |
| tnt (51) | Spawn primed-TNT entity centered in the front cell, fuse 80 t (06 §5.6); count −1 |
| flint_and_steel (284) | If front cell is air with solid support: place `fire` (06 §5.14); durability −1 (breaks at 0 with poof) |
| bone_meal (332) | Apply fertilize (06 §5.11/5.12/5.15) to the front block; if not fertilizable → default-drop |
| splash potion | Thrown per 09-POTIONS (only if 09 is built; else default-drop) |
| armor | default-drop `(Adaptation: vanilla auto-equips)` |
| anything else | **default-drop**: spawn ItemEntity (count 1) at the front face center, velocity = `facing × 0.11 + gaussian × 0.0075` per axis `(approx)`, standard 10 t pickup delay; `block.dispenser.fire` |

### 10.3 Dropper

Never applies special behaviors. If the front cell is a container (chest, furnace with its slot rules per §11.3, hopper, dispenser, dropper): transfer **1 item** from the chosen slot into it (first-fit; if the target cannot accept → fail click, item stays). Otherwise default-drop exactly as above with `block.dropper.drop`.

## 11. Hopper

### 11.1 Block

Hopper 85: bits0–2 FACE6 output direction — 0 (down) when placed on a floor/top face, 2–5 (horizontal) when placed against a block side; never up. Bit3 = locked latch. Block entity: **5 slots** + `cooldown` int. Not conductive; light opacity 0; collision: full cube `(approx: vanilla funnel shape)`. UI: 1×5 slot row + player inventory. Comparator-readable. Drops contents + itself when broken. Hopper minecarts do NOT exist (rails excluded, §1).

### 11.2 Locking

On neighbor update: `locked = isActivated(hopper)` → bit3. While locked, all three functions stop; unlocking does not reset `cooldown`.

### 11.3 Transfer loop (per game tick, hoppers within SIM_RADIUS)

```
if locked: return
if cooldown > 0: cooldown--; return
acted = false
// 1. PUSH (before pull — wiki-exact):
target = container in facing cell (chest / furnace / dispenser / dropper / hopper)
if target: move 1 item from my leftmost non-empty slot into target (first-fit, respecting
           target rules below and 64-stack limits); acted ||= moved
// 2. PULL from container above, else COLLECT:
above = block above
if above is container: pull 1 item from its leftmost pullable slot into my leftmost fitting slot; acted ||= moved
else if above is not a full solid block:
  collect: first ItemEntity (oldest by entity id) whose AABB intersects my cell or the cell above
           → absorb the whole stack (partial if slots nearly full, leftover stays); acted ||= any
if acted: cooldown = 8            // 8 gt = 0.4 s → 2.5 items/s (wiki-exact)
```

**Container slot rules:** chest — any slot. Furnace as push target: hopper above → input slot; hopper into its side → fuel slot; hoppers never push into output. Furnace as pull source (hopper below) — output slot only, plus an empty `bucket` sitting in the fuel slot (post-lava-bucket). Dispenser/dropper — any of the 9. Hopper — any of the 5. Item entity collection happens whole-stack at once (faster than container pulls — vanilla).

Priority when multiple movers compete: pushes land before pulls within one hopper's action; between different hoppers, per-tick processing order = block-entity iteration order per chunk, ascending blockIndex, chunks in key order — deterministic `(approx: vanilla uses block position tick order)`.

## 12. Lamp, note block, TNT, doors

### 12.1 Redstone lamp (86 off / 87 lit)

- On `isActivated` rising: swap 86 → 87 **instantly** (same tick). On falling: schedule +4 gt; at due tick, if still unpowered → swap 87 → 86 (wiki: off-delay 2 redstone ticks; the delay makes lamps hold through 1-tick gaps).
- Block swap uses the furnace/furnace_lit pattern: 87 has `lightEmission 15`, relight via 04 §9.4 on every swap. Both ids conductive, hardness 0.3, drop `redstone_lamp`.

### 12.2 Note block (88)

- State: bits0–4 note 0–24, bit5 powered latch. Conductive, movable, axe-mined, fuel 300 t (wood).
- Plays when: right-clicked (note = (note+1) mod 25 first, then plays), left-click punch starts (plays current note without incrementing), or `isActivated` rising edge (latch bit5, same pattern as §10.1, no delay).
- **Cannot play if the block above is not air** (use still increments the note silently).
- Sound: emits `block.note` with parameters `{instrument, pitch = 2^((note − 12) / 12)}` (wiki-exact; note 0 = F#3 for harp, note 24 = F#5). 16 §3.5's note-block instrument map selects the voice from `instrument`. Spawns one note particle above, hue = note/24 `(approx)`. 16-AUDIO owns all synthesis.
- **Instrument from the block directly below** (our registry ids):

| Instrument | Blocks below |
|---|---|
| bass | 5–10 (planks/logs), 34, 37, 50, 52, 88 |
| snare | 18 sand, 19 gravel |
| hat | 31 glass |
| basedrum | 1, 4, 17, 20, 21–27, 33, 35, 36, 82, 83, 84 (stone-material) |
| bell | 29 gold_block |
| guitar | 46–49 wool |
| iron_xylophone | 28 iron_block |
| pling | 32 glowstone |
| didgeridoo | 44 pumpkin, 45 jack_o_lantern |
| harp | everything else (dirt, grass, air, …) |

### 12.3 TNT ignition by signal

Per the 06 §5.6 amendment: TNT checks `isActivated` on placement and on every neighbor update; true → remove block, spawn primed TNT (fuse 80 t, `world.tnt.fuse`). Dispensed TNT (§10.2) is already primed. Pushing TNT with a piston does not ignite it.

### 12.4 Doors

Per the 06 §5.13 amendment: powered (either half) → open; unpowered → closed; manual toggling unaffected between edges. Door state bit4 = latch. Doors are NOT conductive and dust does not attract to them; power them via the block under/above or adjacent.

## 13. Registry tables

### 13.1 Gameplay (extends 06 §2)

| ID | Name | Hard | Blast | Tool | Tier | Drops | XP |
|---:|------|-----:|------:|------|------|-------|---|
| 70 | redstone_wire | 0 | 0 | — | — | 1 redstone (342) | 0 |
| 71 | redstone_torch | 0 | 0 | — | — | self | 0 |
| 72 | lever | 0.5 | 0.5 | — | — | self | 0 |
| 73 | stone_button | 0.5 | 0.5 | — | — | self | 0 |
| 74 | wooden_button | 0.5 | 0.5 | axe | — | self | 0 |
| 75 | stone_pressure_plate | 0.5 | 0.5 | pickaxe | wood | self | 0 |
| 76 | wooden_pressure_plate | 0.5 | 0.5 | axe | — | self | 0 |
| 77 | repeater | 0 | 0 | — | — | self | 0 |
| 78 | comparator | 0 | 0 | — | — | self | 0 |
| 79 | piston | 1.5 | 1.5 | pickaxe | — | self | 0 |
| 80 | sticky_piston | 1.5 | 1.5 | pickaxe | — | self | 0 |
| 81 | piston_head | 1.5 | 1.5 | pickaxe | — | 1 piston or sticky_piston (bit3) — breaks base too | 0 |
| 82 | observer | 3.0 | 3.0 | pickaxe | wood | self | 0 |
| 83 | dispenser | 3.5 | 3.5 | pickaxe | wood | self + 9-slot spill | 0 |
| 84 | dropper | 3.5 | 3.5 | pickaxe | wood | self + 9-slot spill | 0 |
| 85 | hopper | 3.0 | 4.8 | pickaxe | wood | self + 5-slot spill | 0 |
| 86 | redstone_lamp | 0.3 | 0.3 | — | — | self | 0 |
| 87 | redstone_lamp_lit | 0.3 | 0.3 | — | — | 1 redstone_lamp | 0 |
| 88 | note_block | 0.8 | 0.8 | axe | — | self | 0 |
| 89 | redstone_block | 5.0 | 6.0 | pickaxe | wood | self | 0 |

### 13.2 Light, render, physics (extends 06 §3; **Cond** = conductive override per §3.2)

| ID | Name | Emit | Opac | Pass | Shape | Solid | Cond |
|---:|------|-----:|:---:|:---:|-------|-------|:---:|
| 70 | redstone_wire | 0 | T | co | custom: wire (§4.5) | no | no |
| 71 | redstone_torch | 7 (lit) / 0 | T | co | custom: torch (reuse 06 torch shape, red tip) | no | no |
| 72 | lever | 0 | T | co | custom: 6/16 base + stick cross-quads | no | no |
| 73–74 | buttons | 0 | T | co | custom: 6×4×2 px box on attach face | no | no |
| 75–76 | pressure plates | 0 | T | co | custom: 14×1×14 px top plate | no | no |
| 77 | repeater | 0 | T | co | custom: 2/16 slab, arrow top texture | 2/16 box | no |
| 78 | comparator | 0 | T | co | custom: 2/16 slab | 2/16 box | no |
| 79–80 | pistons | 0 | T | op | cube (face set by state; extended base shows inner face) | yes | no |
| 81 | piston_head | 0 | T | op | custom: 4/16 plate + 4×4 px arm quads toward base | yes (approx full) | no |
| 82 | observer | 0 | O | op | cube (face/back/side tiles by facing) | yes | no |
| 83 | dispenser | 0 | O | op | cube (front hole; up/down variants) | yes | yes |
| 84 | dropper | 0 | O | op | cube | yes | yes |
| 85 | hopper | 0 | T | op | custom: 11/16 body box + 4/16 spout `(approx)` | yes (approx full) | no |
| 86 | redstone_lamp | 0 | O | op | cube | yes | yes |
| 87 | redstone_lamp_lit | 15 | O | op | cube (bright variant) | yes | yes |
| 88 | note_block | 0 | O | op | cube | yes | yes |
| 89 | redstone_block | 0 | O | op | cube | yes | no |

No gravity blocks. Non-cube shapes join the 01 §8.4 custom-shape list; all are emitted unculled with own-cell light like `cross`.

### 13.3 State-byte summary (bit7 reserved for 15's waterlogging — never used here)

| Block | bits0–2 | bit3 | bits4–6 |
|---|---|---|---|
| wire 70 | power (bits0–3!) | — power uses 0–3 | 4–6 unused |
| torch 71 | ATTACH 0–4 | lit | unused |
| lever 72 | ATTACH 0–5 | on | unused |
| buttons 73/74 | ATTACH 0–5 | pressed | unused |
| plates 75/76 | bit0 pressed | — | unused |
| repeater 77 | bits0–1 HFACE | bits2–3 delay | bit4 out, bit5 locked |
| comparator 78 | bits0–1 HFACE, bit2 mode | bits3–6 output 0–15 | — |
| pistons 79/80 | FACE6 | extended | unused |
| head 81 | FACE6 | sticky | unused |
| observer 82 | FACE6 (watched dir) | pulsing | unused |
| dispenser/dropper 83/84 | FACE6 | latch | unused |
| hopper 85 | FACE6 (0 or 2–5) | locked | unused |
| note_block 88 | bits0–4 note 0–24 | — | bit5 latch |

## 14. Texture recipes (extends 06 §4; pattern vocabulary from there)

| Tile(s) | Recipe |
|---|---|
| dust_dot, dust_line ×16 power variants | grayscale: `noise(#b0b0b0, 12)` dot 6×6 centered / line 4 px wide full-width; each of the 16 variants multiplied by the §4.5 ramp color at build time |
| redstone_torch (lit/off) | base torch sprite (06) with tip rows 3–5 = #ff3b3b core + #7a1010 rim; off variant tip #4a0d0d, no highlight |
| lever | cobblestone 6×3 px base plate + 2px stick #6b4f2a angled, tip #d0d0d0 |
| stone_button / wooden_button | 6×4 px `noise(#7f7f7f,8)` / `planks(#b8945f)` box, 1px darker border |
| plates | 14×14 top-face plate: stone noise / oak planks, 1px inset border −20% |
| repeater top | `noise(#9a9a9a, 6)` smooth-stone slab + 3px dark arrow toward output + 2 red 2×2 torch dots (power-red when on); locked variant: 2px bedrock-gray bar across |
| comparator top | as repeater but 3 torch dots in a triangle; subtract mode: front dot lit #ff3b3b |
| piston side/top/bottom/face | side: top 4 rows `planks(#b8945f)` over `noise(#6f6f6f,8)`; back: stone noise + 2px border; face (head): full planks with 1px #6e4f24 frame; inner face (extended): `noise(#6f6f6f,8)` + center 4×4 #4a4a4a |
| piston_head | planks face; sticky variant center 8×8 overlay `noise(#5a8f3c, 10)` (dried sugar-slime green) |
| observer | side: `noise(#5f5f5f,6)` + 6px lighter arrows pointing to face; face: 4×4 red "eye" #d90000 (bright #ff3b3b while pulsing); back: 4×4 red square output port |
| dispenser / dropper | furnace side recipe; face: 6×6 px black mouth with 1px #2a2a2a rim (dispenser adds 4 triangle notch pixels); vertical variants put the mouth on top/bottom tile |
| hopper | outside `noise(#3a3a3a, 5)` + 1px #565656 rim; top tile: 12×12 dark hole; spout tile plain #2f2f2f |
| redstone_lamp (off/lit) | `blotch(#5a2d0c, #3a1c06, 8)` + 3×3 grid of #7a4a1a nodes; lit: nodes → #ffd97a on #a86a2a `blotch`, +30% brightness |
| note_block | `planks(#8a5f35)` all faces + top center 4×4 #2a1a0e square with 2px #d8b45a note glyph |
| redstone_block | `noise(#aa0f01, 7)` + 1px #7a0b01 border + 4 darker 2×2 corner studs |

## 15. Crafting recipes (extends 06 §10; notation identical)

| Output ×qty | Type | Pattern | Key | 2×2 |
|---|---|---|---|:--:|
| redstone_torch ×1 | shaped | `R/S` | R redstone, S stick | ✔ |
| lever ×1 | shaped | `S/C` | S stick, C cobblestone | ✔ |
| stone_button ×1 | shapeless | 1 stone | — | ✔ |
| wooden_button ×1 | shapeless | 1 any planks | — | ✔ |
| stone_pressure_plate ×1 | shaped | `AA` | A stone | ✔ |
| wooden_pressure_plate ×1 | shaped | `PP` | P planks | ✔ |
| repeater ×1 | shaped | `TRT/AAA` | T redstone_torch, R redstone, A stone | |
| comparator ×1 | shaped | `.T./TLT/AAA` | T redstone_torch, L lapis_lazuli, A stone | |
| piston ×1 | shaped | `PPP/CIC/CRC` | P planks, C cobblestone, I iron_ingot, R redstone | |
| sticky_piston ×1 | shapeless | 1 piston + 1 sugar | — | ✔ |
| observer ×1 | shaped, mirror | `CCC/RRL/CCC` | C cobblestone, R redstone, L lapis_lazuli | |
| dispenser ×1 | shaped | `CCC/CBC/CRC` | C cobblestone, B bow (any durability), R redstone | |
| dropper ×1 | shaped | `CCC/C.C/CRC` | C cobblestone, R redstone | |
| hopper ×1 | shaped | `I.I/ICI/.I.` | I iron_ingot, C chest | |
| redstone_lamp ×1 | shaped | `.R./RGR/.R.` | R redstone, G glowstone | |
| note_block ×1 | shaped | `PPP/PRP/PPP` | P planks, R redstone | |
| redstone_block ×1 | shaped | 3×3 redstone | | |
| redstone ×9 | shapeless | 1 redstone_block | — | ✔ |

> Adaptation: vanilla's nether quartz (comparator, observer) is replaced by **lapis_lazuli** (base item 343, previously useless) and slimeball (sticky piston) by **sugar** (base item 339, previously unused) until 10-NETHER supplies the originals; CLAUDE.md's §2 precedence rules arbitrate if 10 wants to restore vanilla recipes (log any such recipe swap in DEVIATIONS.md). Glowstone for the lamp is debug-palette-only until 10-NETHER generates it — the lamp recipe still ships now.

## 16. Sound events

Named hooks only — 16-AUDIO owns synthesis. All take position; noteblock takes `{instrument, pitch}`.

| Event | Fired when |
|---|---|
| `block.lever.click` | lever toggled (param on/off) |
| `block.button.stone.on` / `.off`, `block.button.wood.on` / `.off` | press / release |
| `block.pressure_plate.stone.on` / `.off`, `block.pressure_plate.wood.on` / `.off` | press / release |
| `block.redstone_torch.burnout` | torch burns out (fizz) |
| `block.repeater.click` / `block.comparator.click` | delay / mode cycled |
| `block.piston.extend` / `block.piston.retract` | move completes |
| `block.dispenser.fire` / `block.dispenser.fail` / `block.dropper.drop` | fire / empty-click / dropper eject |
| `block.note` (param `instrument` ∈ harp\|bass\|snare\|hat\|basedrum\|bell\|guitar\|iron_xylophone\|pling\|didgeridoo) | note plays, `pitch = 2^((note−12)/12)`; 16 §3.5 maps `instrument` → voice |
| `world.tnt.fuse` | redstone/dispenser ignition (shared with base flint ignition + 15's TNT prime) |

Hoppers, lamps, and observers are silent (vanilla).

## 17. Persistence

- **All component logic state lives in `states[]`** (§13.3) — saved byte-exact with the chunk (01 §16.1), zero schema change.
- **Block entities** (01 §16.1 `blockEntities` amendment): dispenser/dropper `{ slots: 9 × {id, count, damage?} }`; hopper `{ slots: 5 × {id, count, damage?}, cooldown: 0–8 }`.
- **Not persisted (by design):** torch burnout ring buffers (a burned-out torch may relight one update after load — acceptable), pending scheduled ticks (component handlers re-verify inputs on their next block update; §5.6 border re-solve plus the §6–§12 latch bits reconstruct a consistent circuit), dust network caches (recomputed on demand).
- Piston mid-motion never persists: moves are atomic within one tick, so a save always sees fully retracted or fully extended pistons.

## 18. Multiplayer note

Redstone simulation is **host-only**; clients receive the resulting block/state/blockEntity changes through 14-MULTIPLAYER's generic replication. Sound events replicate as world events at their position. No other special-casing.

## 19. Acceptance checklist & test circuits

Coordinates below are relative (x east, z south, y up), `g` = a flat ground level; all support blocks are stone.

**T1 — torch clock blinks a lamp (1 Hz).** Block S at (0,g+1). Redstone torch on S's east face → torch at (1,g+1). Dust at (2,g+1) (on stone at (2,g)). Repeater at (3,g+1) facing east, delay 4. Redstone lamp at (4,g). Dust at (4,g+1) on top of the lamp. Dust at (4,g+2)? No — loop back at ground+1: dust (4,g+1) → (4,g+1+z? ) run dust (4,g+1)→(4,z=1)→(3,z=1)→(2,z=1)→(1,z=1)→(0,z=1), all on stone, ending pointed into S. Expected: torch off-delay 2 gt + repeater 8 gt per half-cycle → lamp toggles every 10 gt (0.5 s), period 1.0 s; only 3 torch turn-offs per 60 gt → **no burnout, runs forever**.

**T2 — dual-dropper T flip-flop.** Dropper A at (0,0,g) facing UP; dropper B at (0,0,g+1) facing DOWN; put exactly 1 stick in A. Solid block S at (0,1,g) with a stone button on its south face; dust on top of S at (0,1,g+1). Comparator at (1,0,g) facing east with its rear against A; redstone lamp at (2,0,g). Each button press: both droppers pulse once (S strongly powered activates A; the dust cross on S activates B); the holder fires the stick into the other (the §10.1 same-tick insert guard makes order irrelevant); comparator reads A (1 item / 9 slots → signal 1) → lamp toggles ON exactly when the stick is in A. Ten presses → lamp state alternates ten times, never double-fires.

**T3 — 2×2 sticky-piston door.** Doorway at x∈{2,3}, y∈{g,g+1}, z=0 in a stone wall. Sticky pistons facing east at (0,g,0) and (0,g+1,0) with planks at (1,g,0),(1,g+1,0); mirrored pistons facing west at (5,g,0),(5,g+1,0) with planks at (4,g,0),(4,g+1,0). Wiring: lever at (0,g,3); dust from it to (−1,0..2) and to (6,0..2) style runs ending in: stone block at (−1,g,0) with dust on top at (−1,g+1,0), and stone block at (6,g,0) with dust on top at (6,g+1,0). Each dusted block weakly powers → activates its lower piston; the dust cross on top activates the upper piston. Lever ON → all 4 extend within 2 gt, planks fill (2,3)×(g,g+1): door closed, walk-through blocked. Lever OFF → retract, sticky heads pull all 4 planks back: doorway clear. 20 toggles → zero lost/duplicated blocks.

**T4 — hopper chain into a chest.** Hoppers at (0,g+2)→facing down→(0,g+1)→facing down→ chest at (0,g). Throw a stack of 10 dirt onto the top hopper: all 10 arrive in the chest in ≈ 10 × 0.4 s + pipe latency (≤ 6 s), 1 item per 8 gt per hop, order preserved. Power the middle hopper with a lever-fed adjacent block → flow stops; unlock → resumes without item loss.

**T5 — comparator reads furnace fullness.** Furnace at (0,g) containing 32 cobblestone in the input slot, nothing else: fullness = (32/64)/3 → signal = floor(1 + 14 × 0.1667) = **3**. Comparator behind it facing east, then dust cells at (2..4,g+? on stone): dust reads 3 → 2 → 1 and a lamp under the third dust cell lights; a fourth dust cell reads 0. Add 32 more cobblestone (64 total) → signal becomes floor(1 + 14 × 0.3333) = **5** within 2 gt of the container change.

**Checklist:**

- [ ] §3.6 Case A: dust into a block lights an adjacent lamp but dust beyond the block reads 0; Case B: repeater into the same block feeds the far dust 15.
- [ ] Dust auto-shapes: isolated = cross; line/bend/T/cross forms match neighbors; climbs one block up a non-conductive-topped face and connects down over edges; a conductive block above the lower dust cuts the slope link.
- [ ] Dust power gradient renders visibly darker per step over a 15-dust run and drops to 0 at cell 16; F3 shows stored power.
- [ ] Levers latch; stone button releases after exactly 20 gt, wooden after 30 gt; a stuck arrow holds a wooden button pressed and releases it on pickup.
- [ ] Wooden plate triggers on a dropped item, an arrow, and a walking chicken; stone plate only on player/mobs; both release 20 gt after the cell empties.
- [ ] Redstone torch inverts with a 2 gt delay and emits light 7; a 5-dust loop from a torch into its own support block (no repeater) toggles at 4 gt period until it burns out with fizz + smoke within 3 s, then relights ~8 s later after a block update.
- [ ] Repeater delays measure 2/4/6/8 gt on an observer-timed pulse; a powered repeater into a side locks the target repeater (bar renders, output frozen) and unlocks cleanly.
- [ ] Comparator compare vs subtract matches `out = (max(A,C) <= R) ? R : 0` and `max(R − max(A,C), 0)` for the §8 worked examples (6,7,4 → 0; 5,2,9 → 4).
- [ ] Piston pushes ≤ 12 blocks and refuses 13; refuses obsidian/containers; pops torches/plants in the path as drops; deletes fluid in the destination; sand pushed over a ledge falls as an entity; sticky pulls exactly one block and leaves immovable/breakable blocks behind.
- [ ] Extending piston shoves the player 1 block; head is breakable and drops the piston item; extended base + head survive save/reload as a pair.
- [ ] Dispenser fires once per rising edge after 4 gt: arrow flies and is collectible, water/lava bucket places+refills sources round-trip, TNT primes at fuse 80, bone meal grows a crop, empty dispenser clicks `block.dispenser.fail`.
- [ ] Dropper facing a chest transfers 1 item per pulse; facing air it ejects the item as an entity.
- [ ] T1–T5 above all pass exactly as specified.
- [ ] Note block: 25 right-clicks return to pitch 0 (F#3), needs air above, instrument follows the block below per §12.2's table, emits `block.note` with `2^((n−12)/12)` pitch.
- [ ] Redstone lamp lights the 04 engine (level 15, caves illuminate) instantly and goes dark 4 gt after power loss; door opens on power and closes on loss while remaining hand-toggleable.
- [ ] A clock left running in a chunk beyond SIM_RADIUS freezes and resumes on approach; save/reload mid-clock restores all component states byte-exact (repeater delay, comparator level, hopper cooldown, dispenser contents).
- [ ] 20 independent 1 Hz clocks + a 24-hopper array running simultaneously keep tick time within 01 §17 budgets (redstone ≤ 1 ms typical).
