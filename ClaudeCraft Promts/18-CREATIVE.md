# 18-CREATIVE.md — Creative Mode: Game-Mode Engine, Flight, Instant-Build & the Creative Inventory

This expansion promotes VoxelCraft's rudimentary **F4 debug-creative flag** (03 §21) into a first-class, persisted **game mode**: a survival ⇄ creative state machine with survival-immunity, hunger freeze, instant-break-with-no-drops, infinite placement, middle-click pick-block, double-tap-jump flight, and a full-screen tabbed **creative inventory** that enumerates every registered block and item across base + 07–13. Baseline: Minecraft Java Edition ~1.20 *creative behavior* — what a mode switch nullifies, how flight controls, how the item-selection screen is laid out. Exact wiki values unless marked `(approx)`.

**Registry footprint — read this first: Creative Mode allocates ZERO new block ids and ZERO new item ids.** It is a game-mode + player-behavior + UI feature. The creative inventory *palette* references EXISTING ids (base blocks 0–66, items 256–345; expansion ids 07 70–104/460–469, 08 105–109/346–369, 09 110–114/370–389, 10 115–149/390–419, 11 150–169/420–434, 12 170–184/435–449, 13 185–189/450–459) by enumerating the live registries at runtime. The "destroy item" slot, the tab strip, and the search box are UI chrome, **not** registry entries. No `states` bit is touched (bit7 remains 15's waterlogged). The item-stack shape `{slot,id,count,durability,tags?}` is unchanged — `tags` is owned by 08; this file only reads it (for pick-block copy). No effect ids, no dimension ids, no sound namespace of its own beyond the two `ui.*` events registered in §9.

---

## Amendments to base files

Apply these to the CODEBASE while building E-CREATIVE. They override the corresponding base-spec text (precedence per CLAUDE.md §2).

- **AMENDS 01 §16.1** (save schema — `meta/'world'.player`): the `gameMode` field (already listed in the player record) is formalized as an **integer enum** `0 = survival | 1 = creative` (§1). Legacy string values migrate on load: `"survival"→0`, `"debugCreative"|"creative"→1`; a missing field defaults to `0`. Under multiplayer (14), `gameMode` is **per-player** and lives in each per-player save record; 14 replicates it generically (no netcode in this file). Nothing else in the save schema changes — creative worlds and survival worlds share one format.
- **AMENDS 01 §15.1** (keybind map): relabel the `F4` row from "Debug creative toggle" to **"Toggle game mode (survival ⇄ creative)"** → 18 §1.3. The `Middle click` / pick-block binding (03 §3) is active in creative → §5.4. No new keys are added.
- **AMENDS 01 §15.3** (F3 debug overlay): add a line **`gameMode: survival|creative`** to `debug.js` (satisfies CLAUDE.md §6's "keep F3 current"). Add the creative-inventory screen to `containers.js`/`#screens` (§6); it is a `PLAYING_UI` screen exactly like the survival inventory (world keeps ticking, pointer released).
- **AMENDS 03 §2.4** (persistent player state): `gameMode` is the enum above. Add a transient (non-persisted, recomputed) note that `flying` is forced `false` on load and on any switch **to** survival.
- **AMENDS 03 §3** (input map): the `F4` row reads "Toggle game mode (§1.3)"; `Space` double-tap toggles flight **in creative** (not only "debug creative"). No other input change.
- **AMENDS 03 §20.2** (damage intake pipeline): replace the guard `if p.gameMode == debugCreative and source not in {VOID}: return` with `if p.gameMode == creative and source not in {VOID}: return` and cross-reference §4 for the authoritative immune-source enumeration. Creative players also receive **no knockback** (§4.4) — `applyKnockback` early-outs when `p.gameMode == creative`.
- **AMENDS 03 §21** (retitle "Debug creative flight (F4)" → **"Creative mode"**): this section is fully superseded by 18. Specifically: (a) instant-break gains a **6-tick hold cooldown** and the **hardness-`-1` unbreakable** carve-out (§5.1–5.2), replacing the "every targetable block breaks, no inter-block delay" line; (b) flight **auto-cancels on touching the ground** (§3.4), replacing the "flying persists until double-Space or F4" decision; (c) the on-switch state resets of §1.4 are added; (d) reach stays **5.2** (03 §1's "debug creative" reach value is retained under the new name).
- **AMENDS 03 §23** (player HUD): the badge text "DEBUG CREATIVE (F4)" becomes **"CREATIVE"** (top-right, 50% alpha). In creative, `hud.js` **hides** the hearts row, hunger row, air bubbles, and XP bar (they are meaningless — §4.3); the crosshair, hotbar, and selection/crack overlays stay. Restored on switch to survival.
- **AMENDS 05 §5** (target acquisition, the "Every 10 ticks: candidate = the player…" rule): the candidate is rejected when **`player.gameMode == creative`** — hostiles never acquire, chase, or melee a creative player, and the "being damaged by the player always sets the player as target" retaliation clause does **not** re-aggro onto a creative attacker (§7.1). A hostile already targeting a player **drops the target** the tick that player switches to creative (add to the §5 give-up rules). Passive-mob flee/panic on being hit is unchanged (creative players can still hit mobs — §7.2).
- **AMENDS 06 §14.2** (click semantics — the "Pick block (debug mode only, middle click)" row): pick-block is available **whenever `gameMode == creative`** and follows §5.4 (targets → hotbar even if absent, preserves block state/`tags`; Ctrl-modifier copies `tags` explicitly). Add a note that in creative, source stacks are **not decremented** on place/use (§5.3).
- **AMENDS 06 §15.4** (Debug item palette): replaced wholesale by the **Creative inventory** in §6 — a 13-ish-tab full-screen item-selection screen with search, a destroy-item slot, an embedded survival-inventory tab, and infinite source stacks. The old cursor-give palette is retired.
- **AMENDS 06 §15.1 / §12** (survival HUD & hunger): while `gameMode == creative`, hunger/saturation/exhaustion do **not** drain or accrue (§4.3); the survival-HUD cluster is hidden per the 03 §23 amendment; eating is a no-op that neither heals nor consumes the stack.
- **AMENDS 06 block-break/drop path** (the loot spawn in 03 §15.3 `breakBlock` + 06 §2 drop columns): when `gameMode == creative`, `breakBlock` spawns **no item drops and no XP orbs**, and the held tool loses **no durability**; block-entity containers (chest 37, furnace 35/36) still **spill their stored contents** so a full chest is never silently voided (§5.2).
- **AMENDS 16 §3** (sound event registry): register two `ui`-bus events, **`ui.gamemode.switch`** and **`ui.item.destroy`** (§9). No positional/world sounds are added; all other creative UI clicks reuse 16's existing `ui.click` / `ui.hotbar`.
- **Note on CLAUDE.md §7** (out of scope v2): creative mode is **not** in the current out-of-scope list, so no amendment is required. This one-line note exists only so the coordinator can confirm the master-plan integration (phase insertion, definition-of-done) is handled at their level, not here.

---

## Contents

1. [Game-mode model](#1-game-mode-model)
2. [Flight](#2-flight)
3. [Damage & survival immunity](#3-damage--survival-immunity)  *(see also §4)*
4. [Block interaction: instant break, no drops, infinite place, pick-block](#4-block-interaction)
5. [The creative inventory](#5-the-creative-inventory)
6. [Mobs & world interaction](#6-mobs--world-interaction)
7. [Debug overlay & multiplayer note](#7-debug-overlay--multiplayer-note)
8. [Sound event hooks](#8-sound-event-hooks)
9. [Acceptance checklist](#9-acceptance-checklist)

> Section-number note: §3 and §4 below cover flight/immunity and block interaction respectively; the Contents anchors are kept declarative. Ownership boundaries: 03 owns the movement/damage/mining *primitives* creative reconfigures; 06 owns the registries the palette enumerates and the inventory click table §6 reuses; 05 owns mob targeting §7 amends; 16 owns the synthesis behind §8's event names.

---

## 1. Game-mode model

### 1.1 The `gameMode` enum

```
GameMode = { SURVIVAL: 0, CREATIVE: 1 }
```

- **Only these two modes exist.** Adventure (MC 2) and **Spectator (MC 3) are OUT of scope** — no noclip, no scroll-speed flight, no entity-perspective camera. State this and do not build them; a future file may add spectator on top of this enum without renumbering (0/1 are stable).
- One value per player. Single-player: the one player's mode. Multiplayer (14): every player carries their own `gameMode`; one player being creative does not change the world for others (14 replicates the field; §7).
- The value is authoritative on the **host/local player object** (`03 Player`); rendering never mutates it, only `tick()` does (via the toggle §1.3).

### 1.2 Persistence

`gameMode` rides in the player record of `meta/'world'` (01 §16.1, amended). It is saved by every 01 §16.2 trigger (autosave 600 t, pause, `visibilitychange→hidden`, Save & Quit) and restored on load. A world created in either mode is byte-identical in format; the only difference is this one integer. No per-chunk data depends on mode (chunks that were creative-edited are just `modified` chunks like any other).

> Adaptation: MC Java disables achievements permanently once a world touches creative. VoxelCraft has no achievements, so there is **no** irreversible flag and **no** "cheats enabled" gate — F4 is always available (it is a single-player builder toy first, per the base plan's demo intent). Free toggling both directions is intended.

### 1.3 Toggle mechanism

Two entry points, both setting the same enum:

1. **`F4`** — the primary toggle (built out from 03 §21's existing binding). One press flips `SURVIVAL ⇄ CREATIVE`. Debounced to key-*down* edges (01 §15.1 `pressed` set), never auto-repeats. Emits `ui.gamemode.switch` (§8).
2. **Debug command (optional)** — if a chat/command input exists (14 adds one for multiplayer; base has none), `/gamemode <survival|creative>` and the numeric `/gamemode <0|1>` set the local player's mode. Until 14's chat lands, F4 is the sole mechanism; do **not** invent a bespoke console for this file.

> Adaptation: MC's `F3+F4` gamemode radial and the `/gamemode` operator command are collapsed to a single `F4` press. `F3+F4` is not implemented (F3 already toggles the debug overlay; combining them adds a modal wheel for no gain in a two-mode game).

### 1.4 What resets on switch

Applied atomically inside `player.tick()` on the tick the toggle fires, **before** the movement branch runs, so the new mode's physics take effect the same tick.

**→ CREATIVE (on switch to creative):**

| Field | Reset |
|---|---|
| `health` | → 20 (max) and frozen (§4.3) |
| `hunger`, `saturation` | → 20 / max and frozen; `exhaustion` → 0 and not accrued (§4.3) |
| `fireTicks` | → 0 (fire extinguished; overlay clears) |
| `fallDistance` | → 0 (no pending fall damage) |
| `air` | → 300 (full; bubbles hidden) |
| `invulnTicks` | unchanged (harmless; damage is nulled anyway) |
| `flying` | unchanged on switch-*in* (defaults false; player may double-jump to fly) |
| inventory / hotbar | **untouched** — the player keeps exactly what they held; creative just stops depleting it (§5.3) |

**→ SURVIVAL (on switch to survival):**

| Field | Reset |
|---|---|
| `flying` | → `false` immediately; the player begins to fall under normal gravity next tick |
| `fallDistance` | → 0 (the switch itself never deals fall damage; flight already zeroed it per 03 §12.2) |
| `health`, `hunger`, `saturation` | **retained at their current (max) values**, then resume normal draining/regen (06 §12) from full |
| stacks | become ordinary finite stacks again — whatever `count` each slot currently shows is now real and depletes normally (§5.3) |
| instant-break / immunity / pick-block | disabled; 4.5 reach, survival mining formula (03 §15.2), and the damage pipeline all resume |

Switching does **not** teleport, does **not** clear inventory (unlike MC's shift-click-destroy, which is a separate action §5.5), and does **not** reset spawn point.

Consolidated toggle (called on the `F4` down-edge, and by `/gamemode`; runs inside `player.tick()` before the movement branch):

```
function setGameMode(p, mode):
  if p.gameMode == mode: return
  prev = p.gameMode
  p.gameMode = mode
  soundHook('ui.gamemode.switch')
  if mode == CREATIVE:
    p.health = 20
    p.hunger = 20; p.saturation = maxSat; p.exhaustion = 0
    p.fireTicks = 0
    p.fallDistance = 0
    p.air = 300
    // flying stays false; player may double-jump to enable it
    // inventory/hotbar untouched; stacks simply stop depleting (§5.3)
  else: // SURVIVAL
    p.flying = false
    p.fallDistance = 0
    // health/hunger retained at current (max) values, resume draining (06 §12)
    // stack counts become finite/real again (§5.3)
  hud.rebuild()   // show/hide hearts/hunger/air/XP + CREATIVE badge (03 §23 amend)
```

`hud.rebuild()` toggles the survival-cluster visibility (03 §23 amend) rather than per-frame branching — the switch is rare.

### 1.5 Interaction with death

- In creative the player **cannot die** except by the **void kill** (03 §13.2: feetY < −8 → 4 HP/10 t ignoring i-frames; feetY < −64 → instant safety-kill). Void is the single lethal source (§4.1). This matches Java ("the void … are the only way to die in Creative").
- Because health is pinned at 20 and frozen (§4.3), the only path to `health ≤ 0` is void damage overwhelming the frozen value in a single application; the safety-kill plane guarantees termination.
- If a creative player does die in the void, the normal death path (03 §20.5) runs — but note: **creative drops the full inventory on death like survival** (03 §20.5 is unchanged; a void death is rare and dropping is acceptable). Respawn (03 §20.6) restores the player in creative mode (mode is a player attribute, not cleared by death).

> Adaptation: MC creative players who fall into the void die but keep their items (creative death doesn't drop). VoxelCraft keeps 03 §20.5's drop-on-death for simplicity and because void death is an edge case reachable only through broken bedrock or deliberate flight below Y −8; flagged as a minor divergence rather than special-casing the death path.

---

## 2. Flight

Flight reuses 03 §21's `flightMove` branch and its exact constants; this section fixes the trigger, controls, speeds, and cancel rules against verified 1.20 values.

### 2.1 Enabling & the double-tap

- Flight is available **only while `gameMode == creative`** (03 §4 pipeline: the `flightMove` branch is selected when `p.flying`, which can only become true in creative).
- **Toggle:** double-tap `Space` within **7 ticks (0.35 s)** `(approx)` flips `p.flying`. Track `ticksSinceJumpPressed`; on `Space` key-down while creative: `if ticksSinceJumpPressed <= 7: flying = !flying`. A second double-tap while airborne disables flight and the player falls.

> Adaptation: the wiki states flight "can be toggled by double-tapping the jump key" without publishing a frame window. VoxelCraft reuses 03's 7-tick sprint window for symmetry `(approx)`; MC's internal window is ~300 ms, so 350 ms is within tolerance.

Double-tap tracking (mirrors 03 §7.1's double-tap-W sprint logic; runs in `updateSprint`/flight pre-step each tick):

```
// per tick:
if ticksSinceJumpDown < 255: ticksSinceJumpDown += 1
on Space key-down edge:
  if p.gameMode == CREATIVE and ticksSinceJumpDown <= 7:
    p.flying = !p.flying           // toggle; a second double-tap while airborne disables & drops
  ticksSinceJumpDown = 0
```

The `flightMove` branch (03 §21) is then selected in the 03 §4 pipeline whenever `p.flying` — ahead of the water/lava/land branches, which is why fluids never grab a flying player (§2.3).

### 2.2 Controls while flying

| Input | Effect |
|---|---|
| `W A S D` | Horizontal movement in the camera's facing basis (03 §5.2 `inputAccel`) |
| `Space` (hold) | **Ascend** (`v.y += 0.15`) |
| `Left Shift` (hold) | **Descend** (`v.y −= 0.15`); does NOT sneak while flying |
| `Space` + `Shift` together | Net-zero vertical → **hover** |
| `Left Ctrl` (hold) / double-tap `W` | **Sprint-fly** (×2 horizontal, §2.3) |
| double-tap `Space` | Toggle flight off |

Sneaking-as-descend means the sneak edge-guard (03 §8.2) and eye-lower are **suppressed** while flying — Shift is purely a down thruster.

### 2.3 Speeds (verified 1.20)

| Quantity | VoxelCraft value | 1.20 reference |
|---|---|---|
| Walk-fly horizontal | 0.5444 b/t = **10.89 m/s** (accel 0.049, friction 0.91 — ice-equivalent) | 10.92 m/s (39.312 km/h), ≈250% of the 4.317 m/s walk |
| Sprint-fly horizontal | 1.089 b/t = **21.78 m/s** `(approx)` (accel ×2) | 21.6 m/s (77.76 km/h) |
| Vertical (ascend/descend) | 0.375 b/t = **7.5 m/s** `(approx)`, clamped `±0.375` | not published; tuned by feel |
| FOV | ×1.10 flying, further while sprint-flying (03 §18.3 already scales sprint) | "increases field of view by 10%; increased further when holding sprint" |

Gravity is not applied while flying; horizontal friction is 0.91 (ice-like, matching "friction is reduced to a level equivalent to when on ice"). A creative player flying in water or lava **neither sinks nor slows** — the `flightMove` branch is selected before the fluid branches (03 §4 order), so fluids do not touch a flying player. The Speed status effect (09) does **not** raise flying speed (parity — flight speed is a fixed attribute).

### 2.4 Cancel rules

- **Touching the ground cancels flight** (Java behavior): if `onGround` becomes true while `flying`, set `flying = false`. Implement in the tick after `moveAndCollide` reports `onGround` on a downward move. This **supersedes** 03 §21's "flight persists until double-Space/F4" decision (see the 03 §21 amendment).
- Double-tapping `Space` cancels flight mid-air (player then falls; no fall damage — §2.5).
- Switching to survival (§1.4) forces `flying = false`.
- Getting into a bed (06 §5.7 sleep) does **not** cancel flight `(approx — VoxelCraft has no minecarts/boats/rideable mobs, so the MC exceptions are moot)`.

### 2.5 No fall damage

`fallDistance = 0` is written every tick while flying (03 §12.2 already lists "Flying (debug) → fallDistance = 0 continuously"). Disabling flight mid-air, landing while flying, or dropping after a toggle-off therefore deals **no** fall damage in creative — and in any case fall damage is a nulled source (§4.1). "Players that stop flying drift a few blocks in the air" is reproduced by the residual horizontal velocity under 0.91 friction plus resumed gravity.

---

## 3. (reserved — see §2 flight and §4 immunity)

*Flight is fully specified in §2; damage immunity in §4. This heading is kept so the Contents anchors §2/§4 read cleanly against the required-coverage list.*

---

## 4. Damage & survival immunity

### 4.1 Source-by-source nullification

Every damage source enumerated in 03 §20.4 and 05, marked nullified-vs-applies in creative. The single early-out lives in 03 §20.2 (`if p.gameMode == creative and source not in {VOID}: return`).

| Source | In creative | Section |
|---|---|---|
| Fall | **Nullified** | 03 §12 |
| Drowning | **Nullified** (air still tracked but never hurts; bubbles hidden) | 03 §10.2 |
| Fire block contact | **Nullified** (and `fireTicks` never set — §4.2) | 03 §11.2 |
| Burning (on-fire) | **Nullified** | 03 §11.3 |
| Lava contact | **Nullified** | 03 §11.2 |
| Suffocation (block in eye) | **Nullified** | 03 §13.1 |
| Starvation | **Nullified** (hunger frozen full — §4.3) | 06 §12.3 |
| Mob melee | **Nullified** (and hostiles don't even target — §7.1) | 05 §14 |
| Arrow / projectile | **Nullified** | 05 §11 |
| Explosion (creeper/TNT/bed) damage | **Nullified** | 05 §12.3 |
| Cactus contact | **Nullified** | 06 §5.8 |
| **Void** | **STILL LETHAL** (feetY < −8: 4 HP/10 t ignoring i-frames; < −64: instant kill) | 03 §13.2 |

> Adaptation: matches Java's "unable to receive damage from the vast majority of sources … going too far into the void still kills the player." VoxelCraft's void plane sits at Y −8 (03 §13.2's tightened bound), not MC's "64 below the dimension floor," because the Overworld floor is Y 0; the Nether/End dimensions (10/11) reuse 03 §13.2's per-dimension void rule unchanged.

### 4.2 Fire & environment side effects

- Creative players are never set on fire: `fireTicks` is forced to 0 (§1.4 on switch, and any ignition attempt in 03 §11.2 early-outs when creative). No flame overlay.
- Explosions still push blocks/other entities normally; only the creative player's **damage and knockback** are cancelled (§4.4). A creeper can still be ignited by flint & steel by a creative player (parity) — it just cannot hurt them.
- The underwater tint / suffocation overlays (03 §18.5) still render if the eye is submerged/inside a block (cosmetic honesty), but deal no damage. Optional: suppress the suffocation overlay in creative for building comfort `(approx — decision: keep it, it signals the player is inside geometry)`.

### 4.3 Frozen survival stats

- **Health** pinned at 20; regen and the damage pipeline are both irrelevant (nothing subtracts). HUD hearts hidden (03 §23 amend).
- **Hunger** pinned at 20, saturation full; **no exhaustion accrues** — the 03 §4 pipeline step 11 (exhaustion triggers: sprint/jump/swim/break/damage) is **skipped** in creative, and 06 §12.2 drain does not run. Sprint is therefore never hunger-gated (03 §7.1's `hunger > 6` check passes trivially). HUD hunger row hidden.
- **Air** pinned at 300; bubble HUD hidden. Drowning timer does not advance.
- **XP** is not spent or earned by gameplay in creative (no mining XP, no mob-kill XP credited to the creative player — §5.2, §7.2); the XP bar is hidden. Any XP the player already had is retained across the switch and reappears in survival.

### 4.4 No knockback

`applyKnockback` (03 §20.3 / 05 §14.3) early-outs when the target `gameMode == creative` — a creative player is **immovable by mob melee, explosions, and projectile impacts**. (Parity: "Flying in creative mode now prevents knockback from explosions," generalized to all sources.) The player's own movement is unaffected.

---

## 5. Block interaction

### 5.1 Instant break

- While creative, mining ignores hardness: any block whose `hardness ≥ 0` breaks on the **first mining tick** (`miningDamagePerTick` short-circuits to a break; the crack overlay never advances past stage 0). This reuses 03 §15's loop with a creative branch at the top of `updateMining`.
- **Hold cooldown (1.20-exact):** while `LMB` is *held* continuously, successive blocks break with a **6-tick (0.3 s) inter-block delay** (`mineDelay = 6`, the value already in 03 §15.3). Rapidly *re-clicking* bypasses the cooldown (one block per click, down to 1/tick). This **refines** 03 §21's "no inter-block delay" note.

> Adaptation: the codebase's 03 §21 said instant-break had *no* inter-block delay; 1.20 actually applies a 6-tick cooldown to *held* creative breaking (distinct from survival instant-mining's 1-tick cadence). VoxelCraft adopts the 1.20 cooldown by simply not zeroing `mineDelay` in the creative branch — the survival mining loop's existing 6-tick delay is correct as-is.

Creative branch at the top of 03 §15.3's mining loop:

```
each tick while LMB held:
  if mineDelay > 0: mineDelay -= 1; playSwing(); return
  hit = raycastVoxels(eye, look, 5.2)
  if no block hit: reset(); return
  if BLOCKS[hit.id].hardness < 0: reset(); return    // bedrock/water/lava: unbreakable, no swing loop
  // creative: no progress accumulation, no crack overlay
  breakBlock(hit.pos, { drops:false, xp:false, durability:false })   // §5.2
  reset(); mineDelay = 6                              // 0.3 s hold cooldown; re-click bypasses
```

`breakBlock`'s creative flags suppress the loot spawn, XP orb, and tool-durability decrement of 03 §15.3, while still running the normal `setBlock(AIR)` → light/mesh/neighbor-update path and still spilling any block-entity container contents.

### 5.2 Unbreakable blocks, no drops, no XP, no durability

- **Hardness −1 blocks stay unbreakable in creative.** Bedrock (17), water (63), and lava (64) have `hardness = -1`; `miningDamagePerTick` already returns 0 for `hardness < 0` (03 §15.2), so instant-break **does not** apply to them. Verified: they remain unbreakable.

  > Adaptation: real MC 1.20 creative *can* instant-break bedrock and other −1 blocks (they just don't drop). VoxelCraft **keeps them unbreakable** in creative because (a) the world has a bedrock floor at Y 0 with a void kill-plane at Y −8 — letting players punch through the floor would drop them into the void; and (b) 03's mining formula already treats `hardness < 0` as unbreakable, so honoring it keeps one code path. This is a deliberate divergence, logged here rather than in DEVIATIONS.md since it is a spec decision, not a code/spec conflict.

- **No drops:** `breakBlock` (03 §15.3) spawns **no** item entities in creative (the block simply becomes air). Matches "if the game can determine a block was broken by the player, it does not drop."
- **No XP:** ore blocks (coal/diamond/redstone/lapis, 06 §2) that normally drop XP orbs on mine drop **none** in creative.
- **No durability loss:** the held tool loses no durability on a creative break (03 §15.3's `durability -= 1` is skipped) — creative tools are effectively unbreakable.
- **Containers still spill:** breaking a chest (37) or furnace (35/36) still ejects its stored contents as item entities (06 §5.3/§5.5), so a full container is never silently voided. (Matches "Containers also drop their contents when broken.")

### 5.3 Infinite placement & consumption

- **Placement does not deplete the stack.** 03 §16.2's `heldStack.count -= 1` is skipped when `gameMode == creative`. A stack of any size (even 1) places indefinitely.
- **Consumption does not deplete** either: buckets (06 §6.4), flint & steel, bone meal, throwables (egg/snowball/ender pearl) — using any item in creative leaves the source stack untouched. (Eating is a no-op that neither heals nor consumes — §4.3.)
- **Count display:** the hotbar/inventory shows the stack's **normal numeric count** (e.g. `64`), which simply **never decrements** in creative — no `∞` glyph. Decision: matches Java (creative shows the real count and holds it steady); adding an `∞` overlay is extra art for no clarity. On switch to survival the frozen count becomes the real, depleting count (§1.4).
- Placement still obeys **all** 03 §16.2 rules: reach ≤ 5.2, `0 ≤ y ≤ 127`, target must be in the replaceable set, must not intersect the player or any mob AABB, torch orientation (03 §16.4), and waterlogging (15's bit7) — creative changes *only* the count decrement, not the legality of a placement.

### 5.4 Middle-click pick-block

Reuses 03 §14 targeting + the `Middle click` binding; active in creative (06 §14.2 amend).

```
on middle-click while creative:
  hit = raycastVoxels(eye, look, 5.2)
  if no block hit: return
  id = block-item id for BLOCKS[hit.id]      // the placeable item that yields this block
  stack = { id, count: maxStack(id), tags?: pickTags(hit) }
  place stack into the hotbar:
    if an identical stack (id + equal tags) is already in a hotbar slot → select that slot
    else if the active hotbar slot is empty → put it there
    else if any hotbar slot is empty → put it in the first empty slot and select it
    else → replace the item in the active slot with `stack` (old item discarded — infinite source, no loss)
  emit ui.hotbar (§8)
```

- **State / tags:** the picked stack carries the targeted block's relevant state where a matching item exists — e.g. a wall/floor torch picks the `torch` item; a lit furnace (36) picks the `furnace` item (06 §1). `pickTags(hit)`: with the **Ctrl** modifier held, copy the block-entity/`tags` payload (08's `tags`, or chest/furnace contents references) so the placed copy is identical; without Ctrl, pick a clean default stack. (Matches "holding Ctrl … preserves the block's NBT tags.")
- Pick-block never consumes anything and works even when the block is not already in the inventory (creative gives it outright) — the defining creative-vs-survival difference for this control.

### 5.5 (destroy-item — see §6.4)

---

## 6. The creative inventory

A full-screen `PLAYING_UI` screen (01 §15.2) opened with `E` **while creative** (in survival, `E` still opens the survival inventory 06 §14). Rendered by `containers.js` at the base 2× GUI scale, icons from the atlas (01 §7.3). Replaces 06 §15.4's debug palette.

### 6.1 Layout & geometry (approx, for clean rendering)

```
┌──────────────────────────────────────────────┐
│ [tab][tab][tab][tab][tab][tab][tab]           │  ← top tab row (selected tab framed)
├──────────────────────────────────────────────┤
│  ┌──────────────────────────────────────┐     │
│  │  9 × 5  item grid (45 cells)          │     │  ← current tab's contents, scrollable
│  │  ... paged / scrolled ...             │[▓]  │  ← scrollbar (drag or wheel)
│  └──────────────────────────────────────┘     │
│  ┌ Search: [____________________]  (search tab)│
├──────────────────────────────────────────────┤
│  9 × 3  player main inventory (slots 9–35)     │  ← always shown below the palette
│  ─────────────────────────────────────────    │
│  9 × 1  hotbar (slots 0–8)     [🗑 destroy]     │  ← hotbar + destroy-item slot at far right
└──────────────────────────────────────────────┘
```

- **Item grid:** 9 columns × 5 rows visible = 45 cells per page; the current tab's full id list scrolls vertically (mouse wheel or scrollbar). Cell = 18×18 texture px (same as survival slots).
- **Personal inventory:** the player's real **27 main (9–35) + 9 hotbar (0–8)** slots render beneath the palette, exactly as in the survival inventory screen, so the player drags palette items down into them. The **offhand slot (45, from 08)** and **armor slots (36–39)** render on the survival-inventory tab (§6.2) — kept off the palette tabs to save width `(approx layout decision)`.
- **Destroy-item slot:** a single trash cell at the hotbar row's right end (§6.4).
- Tooltips (06 §15.2, multi-line per 08) show on hover over any palette or inventory slot.

### 6.2 Tab set (adapted to VoxelCraft's content)

VoxelCraft's registry has no spawn eggs, no "colored blocks" split, and folds several MC categories together. Adapted tabs (icon = a representative id):

| # | Tab | Contents (enumerated from the live registries by category) |
|---|---|---|
| 1 | **Building Blocks** | stone, cobblestone, planks (3), logs (3), sandstone, glass, bricks, obsidian, wool (4), coal/iron/gold/diamond blocks, redstone/lapis blocks, nether/end structural blocks (10/11), quartz-family, etc. |
| 2 | **Decoration** | dirt, grass, sand, gravel, leaves (3), saplings (3), flowers (dandelion/poppy), short_grass, torch, ladder, fence, door, bed, pumpkin, jack_o_lantern, bookshelf, glowstone, ores (as blocks), bell/composter/barrel (12), decorative nether/end blocks |
| 3 | **Redstone** (07) | redstone dust, redstone torch, repeater, comparator, piston + sticky piston, observer, dispenser, dropper, hopper, redstone lamp, note block, lever/button/pressure-plate — every id 07 registers |
| 4 | **Tools & Utilities** | pickaxes, axes, shovels, hoes, shears, flint & steel, buckets (+water/lava), crafting_table, furnace, chest, blast furnace/smoker (12), enchanting_table + anvil + grindstone (08), brewing_stand (09), smithing_table (10), beacon (13), lead-free utility blocks |
| 5 | **Combat** | swords, bow, arrow, tipped arrows (09), all armor pieces (leather/gold/iron/diamond/netherite 10), TNT, end crystal (13, if placeable) |
| 6 | **Food** | apple, bread, all raw/cooked meats, carrot, potato, baked_potato, rotten_flesh, golden apple (09), mushrooms/stew (09) |
| 7 | **Brewing** (09) | water/awkward/all potions, splash + lingering potions, brewing ingredients — nether wart, blaze powder, magma cream, glistering melon, fermented spider eye, etc. |
| 8 | **Ingredients / Misc** | sticks, coal/charcoal, ingots & raw ores, diamond, gems, flint, string, feather, gunpowder, leather, bone, bone_meal, redstone/lapis items, paper, book, sugar/wheat/seeds, ender pearl, gold nugget (10), netherite scrap/ingot (10), nether star (13), eyes of ender (11), chorus fruit (11), emeralds (12) |
| 9 | **Search** | a text box that filters **all** registered ids by substring of display name (case-insensitive), showing matches in the 9×5 grid; typing focuses the box. Selecting this tab auto-focuses the field. |
| 10 | **Survival Inventory** | the player's real screen: 27 main + 9 hotbar + 4 armor (36–39) + offhand (45) + 2×2 craft grid (40–44). Lets a creative player arrange gear exactly as in survival; crafting still works (creative doesn't remove crafting, it just also grants raw access). |

> Adaptation: MC Java has 13 tabs including "Colored Blocks," "Natural Blocks," "Functional Blocks," "Saved hotbars," "Spawn Eggs," and "Crafting." VoxelCraft has no spawn eggs (no creative mob-spawn items in scope) and far fewer blocks, so those are merged/dropped: colored+natural+functional fold into Building/Decoration, "Saved hotbars" is cut `(approx — a convenience feature, not core)`, "Crafting" is subsumed by the Survival-Inventory tab's craft grid, and "Spawn Eggs" is omitted entirely. Ten tabs cover the whole 0–66 + 07–13 id space.

**Classification (`creativeTab`)** — computed once at boot by iterating both registries; each id lands in **exactly one** tab. The ordered rules (first match wins):

```
function creativeTab(entry):                 // entry = BLOCKS[id] or ITEMS[id]
  if entry is an ITEM:
    if entry.toolClass or entry.id in {bucket…flint_and_steel, shears} : return TOOLS
    if entry.isWeapon or entry.isArmor or entry.id == arrow or tipped_arrow: return COMBAT
    if entry.isFood: return FOOD
    if entry.isPotion or entry.id in BREWING_INGREDIENTS(09): return BREWING
    // block-items are classified by their block below; everything else:
    return MISC                              // sticks, ingots, gems, nether star, pearls, emeralds…
  // entry is a BLOCK (or its block-item):
  if id in REDSTONE_BLOCKS(07): return REDSTONE
  if entry.blockEntity or id in UTILITY_BLOCKS(table,furnace,chest,enchant,anvil,brew,beacon…): return TOOLS
  if entry.shape == 'cross' or entry.needsSupport or id in DECOR_SET: return DECORATION
  return BUILDING                            // full opaque structural cubes
```

`BREWING_INGREDIENTS`, `REDSTONE_BLOCKS`, `UTILITY_BLOCKS`, and `DECOR_SET` are small static id-lists owned by their expansion files' registries; any id not otherwise matched falls into **Ingredients / Misc**, guaranteeing no id is unreachable. Search (tab 9) and Survival-Inventory (tab 10) are not populated by this function — search filters the union of all ids, and tab 10 shows the live player slots.

### 6.3 Click & drag semantics

Reuses 06 §14.2's click table for the personal-inventory and destroy interactions, with palette cells acting as **infinite sources**:

| Input on a **palette** cell | Behavior |
|---|---|
| Left click (cursor empty) | Put a **full stack** (max stack for that id) of the entry onto the cursor |
| Left click (cursor holds same id) | Top the cursor stack up to max (no-op if already full) |
| Left click (cursor holds different item) | Replace the cursor with a full stack of the entry (old cursor stack **discarded** — palette is a source/sink) |
| Right click (cursor empty) | Put **1** of the entry onto the cursor |
| Middle click | Put a full stack onto the cursor (same as left) |
| Shift + left click | Send a full stack **directly** to the personal inventory (hotbar first, then main), no cursor step |

Cells in the **personal inventory / hotbar** rows behave **exactly** per 06 §14.2 (pick up, merge, right-click half/place-one, number-key swaps, double-click collect, Q/Shift+Q drop). Dragging a stack from the personal inventory **back onto the palette** deletes it (the palette absorbs it — same as the destroy slot §6.4). Emits `ui.click` on cell clicks, `ui.hotbar` on hotbar selection change (§8).

### 6.4 Destroy-item slot

- A dedicated trash cell (bottom-right of the hotbar row). **Dropping any cursor stack onto it deletes the stack** (cursor cleared). Hovering shows a "Destroy Item" tooltip.
- **`Shift`+click on the destroy slot** clears the **entire** personal inventory: all 36 slots + armor (36–39) + offhand (45) (matches Java "clears the entire inventory, including the hotbar, off-hand slot, and armor slots"). The 2×2 craft grid is also cleared.
- Emits `ui.item.destroy` (§8).

### 6.5 Hotbar save/restore

The hotbar (slots 0–8) is the same 9-slot array used in survival and persists through 01 §16's player record — a creative session's chosen hotbar survives save/reload and survives a switch to survival (the stacks become finite; §1.4). Closing the creative inventory returns any cursor stack per 06 §14.1's close rule (overflow to inventory, else dropped — but a creative drop-out simply deletes it since the source is infinite; decision: **return to inventory if space, else delete** rather than spawn a world item, to avoid item clutter while building).

---

## 7. Mobs & world interaction

### 7.1 Hostiles ignore creative players

Per the 05 §5 amendment: the hostile target-acquisition scan rejects any candidate whose `gameMode == creative`. Consequences:

- Zombies, skeletons, creepers, spiders (when light-gated hostile), endermen (post-stare) **never** path to, melee, shoot, swell at, or teleport-aggro onto a creative player.
- **Retaliation is disabled:** hitting a hostile in creative does **not** set the creative player as its target (the 05 §5 "damaged by the player always sets target" clause is skipped for creative attackers). The mob still takes the damage and dies if HP ≤ 0 — it just won't fight back at a creative player. (Spider/enderman retaliation likewise does not latch onto a creative attacker.)
- A hostile already chasing a player **drops the target** the moment that player toggles to creative (05 §5 give-up amend), then resumes wander/idle goals.
- No knockback is dealt to creative players (§4.4), so even the summoned-reinforcement edge case (MC: backup zombies swing harmlessly) is naturally a no-op here.

> Adaptation: MC still lets a few scripted attackers (reinforcement zombies, the ender dragon) *swing* at creative players for a few seconds before giving up, dealing no damage. VoxelCraft simplifies to a clean "never target," which is visually indistinguishable in practice and removes a special case. The dragon (13) may keep its scripted perch/strafe animation but deals no damage to a creative player (already covered by §4.1's nullification).

### 7.2 Creative player can still fight

- The creative player attacks normally (03 §14 entity targeting on LMB press → 05 §13 combat math). Melee damage, sweep (08), critical hits, and bow shots all work; **there is no creative-mode instakill** — a diamond sword still does its listed damage and takes multiple hits to kill high-HP mobs.

  > Verified: MC Java creative has **no** one-hit-kill on mobs (that is Bedrock's creative behavior); Java creative uses the held weapon's normal damage. VoxelCraft follows Java — no instakill.

- **Mobs killed by the creative player still drop items and XP** (06/05 drop tables run normally), matching "Mobs killed by the player in Creative still drop items." The dropped XP orbs, however, are **not collected** by the creative player (XP is frozen/hidden — §4.3); they simply despawn. Passive mobs still panic/flee when hit (05 §9), and shears/buckets/breeding interactions all function (with no stack consumption, §5.3).

### 7.3 Spawning is NOT suppressed

Creative does **not** stop mob spawning. The 05 §3 natural spawn cycle runs unchanged around a creative player — hostiles still spawn in the dark, passives still spawn on grass. (Matches "Mobs still spawn as they do in other game modes … but all are passive toward the players.") A creative player standing in a dark cave will accumulate harmless, non-aggressive hostiles nearby. (If a builder wants them gone, they delete them via attack or fly away; no `doMobSpawning` gamerule is in scope.)

---

## 7b. (world edits) — no special rules

Block edits made in creative are ordinary `setBlock` calls (01 §4.6): they mark the chunk `modified`, trigger lighting/remesh, run neighbor updates (fluid wake-ups, falling blocks, support pops), and persist identically to survival edits. Redstone (07), fire spread (15), waterlogging (15), and fluid flow all behave the same regardless of the placer's game mode — creative changes the *player*, never the *world simulation*.

---

## 8. Sound event hooks

Creative introduces **almost no new audio** — the mode is silent except for two UI cues; every other creative interaction reuses base/16 events (block break → `block.break.<mat>`, place → `block.place.<mat>`, hotbar select → `ui.hotbar`, inventory clicks → `ui.click`, all owned by 16 §3). Named events only; call sites emit `soundHook(name)` and nothing else (no-op until 16 exists). All on the **`ui`** bus (non-positional, listener-relative).

| Hook name | Trigger (section) | Character (16 owns synthesis) | Vanilla reference |
|---|---|---|---|
| `ui.gamemode.switch` | F4 / `/gamemode` mode toggle (§1.3) | short two-note rising (creative) / falling (survival) blip, ui bus, gain ~0.3 | ui.toast / gamemode-switch chime `(no exact MC analog)` |
| `ui.item.destroy` | stack dropped into the destroy slot, or a stack absorbed by the palette (§6.3–6.4) | brief downward noise "poof," ui bus, gain ~0.25 | inventory delete `(no exact MC analog)` |
| `ui.click` (reuse) | any creative-inventory cell / tab click (§6.3) | existing 16 §3 event | ui.button.click |
| `ui.hotbar` (reuse) | pick-block or hotbar selection change (§5.4, §6.3) | existing 16 §3 event | (hotbar select) |

Flight toggle plays **no** dedicated sound (parity — MC has no fly-toggle SFX). These two new events are registered via the AMENDS 16 §3 line above; they use 16's `ui` bus defaults (refDist n/a, no positional cull, `replicate` per 16's UI policy — UI sounds are local-only, not relayed).

---

## 9. Acceptance checklist

Browser-testable gates. "Creative" = after one `F4` press from a fresh survival world.

**Mode toggle & persistence**
- [ ] `F4` flips survival→creative and back; F3 overlay shows `gameMode: creative` / `survival`; the "CREATIVE" badge appears top-right only in creative.
- [ ] Switching to creative sets health/hunger/air to full and freezes them; the hearts/hunger/air/XP HUD rows disappear; the crosshair and hotbar remain.
- [ ] Switching back to survival re-shows the survival HUD, unfreezes hunger (it begins draining from full), and forces `flying = false` (the player falls, taking **no** fall damage from the switch).
- [ ] Save & reload a creative world: player is still creative; hotbar contents identical; world edits byte-restored (01 §16 rule holds — creative worlds share the format).

**Flight**
- [ ] Double-tap `Space` toggles flight (only in creative); `Space` ascends, `Shift` descends, `Space`+`Shift` hovers.
- [ ] Walk-fly ≈ 10.9 m/s, sprint-fly (Ctrl or double-W) ≈ 21.7 m/s over ≥100 ticks; FOV eases +10% flying and further sprint-flying.
- [ ] Descending onto the ground auto-cancels flight (Java behavior); no fall damage on landing or on a mid-air toggle-off.
- [ ] Flying through water/lava neither sinks nor slows the player.

**Damage immunity**
- [ ] In creative, take **zero** damage from a 30-block fall, standing in lava, a point-blank creeper explosion, a skeleton's arrows, drowning, suffocation, and cactus — and receive **no knockback** from any of them.
- [ ] Void still kills: fly/fall below Y −8 → damage accrues; below Y −64 → instant death; respawn restores the player still in creative.
- [ ] No fire overlay ever appears; standing in fire/lava never sets `fireTicks`.

**Block interaction**
- [ ] Breaking stone (or any hardness ≥ 0 block) is instant with **no** dropped item and **no** XP; held tool loses no durability; crack overlay never advances past stage 0.
- [ ] Holding LMB across a row of blocks breaks one every 6 ticks (0.3 s); rapid clicking breaks faster (down to 1/tick).
- [ ] Bedrock, water, and lava (hardness −1) remain **unbreakable** in creative.
- [ ] Breaking a stocked chest still spills its contents.
- [ ] Placing blocks does **not** reduce the stack count (a stack of 1 places forever; the number stays put); placement still refuses to overlap the player/mobs, respects reach 5.2 and the replaceable set, and still waterlogs per 15.
- [ ] Middle-click pick-block puts the targeted block's item into the hotbar even when it wasn't in the inventory; Ctrl+pick copies the block's `tags`/state.

**Creative inventory**
- [ ] `E` in creative opens the tabbed full-screen palette (not the survival inventory); tabs switch content; scrolling works.
- [ ] Search tab: typing "diamond" filters to diamond-named entries; left-click grabs a full stack onto the cursor; it drops into a hotbar slot and can then be placed infinitely.
- [ ] Dragging any stack onto the destroy slot deletes it; `Shift`+click the destroy slot empties the whole inventory + armor + offhand.
- [ ] Every registered id (base 0–66/256–345 and expansion 07–13 ranges) appears in exactly one palette tab; none are unreachable.
- [ ] The Survival-Inventory tab shows the real 27+9 + armor + offhand + craft grid; crafting still functions.

**Mobs & world**
- [ ] A zombie in melee range of a creative player never attacks or paths toward them; hitting it does not make it retaliate; it still dies and drops loot (which the creative player does not collect as XP).
- [ ] Hostile mobs still spawn in darkness around a creative player (spawning is not suppressed); they wander harmlessly.
- [ ] A hostile actively chasing the player drops its target the instant the player toggles to creative.
- [ ] Redstone/fire/water simulation behaves identically for blocks placed in creative vs survival.

**Registry governance**
- [ ] A registry dump confirms Creative Mode added **zero** new block ids and **zero** new item ids; the destroy slot and tab chrome are UI only; no `states` bit and no effect/dimension/sound id was allocated beyond the two `ui.*` event names.
