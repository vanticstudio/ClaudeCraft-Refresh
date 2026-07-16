# 03-PLAYER.md — Player Entity, Physics, Interaction, Health

Defines the survival player: entity dimensions, the complete per-tick movement model (ground/air/water/lava/ladder), sprinting, sneaking, jumping, fall damage, drowning, fire, block targeting/breaking/placing, camera, held-item viewmodel, health/death/respawn, and the F4 debug-flight mode. Collision resolution and voxel raycast **primitives** are defined in 01-ARCHITECTURE.md (this file owns their constants and behavior rules). Block hardness, tool tiers, `canHarvest` tables, durability values, hunger/exhaustion, food, beds, and item entities live in 06-ITEMS-CRAFTING-SURVIVAL.md. Damage dealt BY the player and mob combat live in 05-MOBS-COMBAT.md. Day cycle and rain (fire extinguish) live in 04-TIME-LIGHT-WEATHER.md. World spawn selection lives in 02-WORLD-GENERATION.md. Baseline: Minecraft Java Edition ~1.20. All game logic runs at 20 ticks/s (1 tick = 50 ms); 1 block = 1 m.

## Contents

1. Master constants table
2. Player entity definition
3. Input map
4. Player tick pipeline (order of operations)
5. Horizontal movement — ground and air
6. Vertical movement — gravity, drag, jumping
7. Sprinting
8. Sneaking and the edge guard
9. Climbing (ladders)
10. Water movement, drowning, air supply
11. Lava movement, fire, burning
12. Fall damage
13. Suffocation and void
14. Block targeting and reach
15. Breaking blocks
16. Placing and using blocks
17. Dropping items
18. Camera and first-person view
19. Held-item viewmodel
20. Health, damage intake, death, respawn
21. Debug creative flight (F4)
22. Spawn and respawn logic
23. Player-owned HUD elements
24. Acceptance checklist

---

## 1. Master constants table

Units: `b/t` = blocks per tick, `b/t²` = blocks per tick². Per-second value = per-tick × 20 (velocities) or × 400 (accelerations).

| Constant | Per-tick | Per-second | Notes |
|---|---|---|---|
| Gravity | 0.08 b/t² | 32 m/s² | Applied after position update |
| Vertical drag | ×0.98 /tick | ×0.668 /s | Applied after gravity |
| Terminal fall velocity | 3.92 b/t | 78.4 m/s | = 0.08×0.98/0.02; wiki-measured 77.71 m/s |
| Jump initial velocity | 0.42 b/t | 8.4 m/s | Jump apex 1.2522 blocks (model yields ≈1.251) |
| Sprint-jump horizontal boost | +0.2 b/t | +4 m/s impulse | One-shot, in facing (yaw) direction |
| Jump re-trigger cooldown | 10 ticks | 0.5 s | When jump key held (approx) |
| Walk accel (ground) | 0.098 b/t² | — | = 0.1 speed attr × 0.98 keyboard input |
| Ground friction | ×0.546 /tick | — | = slipperiness 0.6 × 0.91 |
| Air friction (horizontal) | ×0.91 /tick | — | |
| Air accel | 0.0196 b/t² (0.02 base) | — | ×1.3 = 0.02548 while sprinting |
| Walk speed (equilibrium) | 0.21586 b/t | 4.317 m/s | = accel / (1 − friction) |
| Sprint speed | 0.28062 b/t | 5.612 m/s | accel ×1.3 |
| Sneak speed | 0.06476 b/t | 1.295 m/s | accel ×0.3 |
| Sprint-jump average speed | ≈0.356 b/t | ≈7.127 m/s | Emergent, do not hard-code |
| Water drag (all axes) | ×0.8 /tick | — | |
| Water accel (horizontal) | 0.0196 b/t² (0.02 base) | — | |
| Water gravity | 0.005 b/t² | 2 m/s² | Applied after drag |
| Water swim-up impulse (jump held) | +0.04 b/t /tick | — | |
| Water speed (equilibrium) | 0.098 b/t | 1.96 m/s | Wiki-measured 1.81–2.20 m/s |
| Water sink speed | 0.025 b/t | 0.5 m/s | |
| Lava drag (all axes) | ×0.5 /tick | — | |
| Lava accel (horizontal) | 0.0196 b/t² (0.02 base) | — | |
| Lava gravity | 0.02 b/t² | 8 m/s² | Applied after drag |
| Lava speed (equilibrium) | 0.0392 b/t | 0.78 m/s | |
| Ladder climb up | 0.1176 b/t | 2.35 m/s | Emergent from v_y=0.2 clamp + gravity |
| Ladder max descent | 0.15 b/t | 3.0 m/s | |
| Step-up height | 0 | — | Disabled — see §5.5 |
| Block reach (survival) | 4.5 blocks | | From eye position |
| Block reach (debug creative) | 5.2 blocks | | |
| Entity attack reach | 3.0 blocks | | Targeting rule here; damage in 05 |
| Max air supply | 300 ticks | 15 s | 10 bubbles × 30 |
| Drowning damage | 2 HP / 20 ticks | 2 HP/s | First hit 20 ticks after air empties |
| Air regeneration | +7.5 /tick | full in 2 s | 1 bubble per 4 ticks |
| Fire block contact damage | 1 HP / 10 ticks | 2 HP/s | Plus ignites 8 s |
| Lava contact damage | 4 HP / 10 ticks | 8 HP/s | Plus ignites 15 s |
| Burning damage | 1 HP / 20 ticks | 1 HP/s | |
| Suffocation damage | 1 HP / 10 ticks | 2 HP/s | Eye inside solid block |
| Void damage | 4 HP / 10 ticks | 8 HP/s | Below Y = −8 — see §13 |
| Fall damage | ceil(fallDistance − 3) HP | | 23.5-block fall is lethal from 20 HP |
| Hurt invulnerability | 10 ticks | 0.5 s | |
| Max health | 20 HP | 10 hearts | |
| Inter-block mining delay | 6 ticks | 0.3 s | Skipped on instant break |
| Place/use repeat delay | 4 ticks | 0.2 s | While RMB held |
| Sprint double-tap window | 7 ticks | 0.35 s | |
| Swing animation | 6 ticks | 0.3 s | |
| Flight speed (debug) | 0.5444 b/t | 10.89 m/s | accel 0.049, friction 0.91 |
| Sprint-flight speed (debug) | 1.089 b/t | 21.78 m/s | accel ×2; wiki lists 21.58 (approx) |
| Flight vertical speed (debug) | 0.375 b/t | 7.5 m/s | (approx) |

---

## 2. Player entity definition

### 2.1 Hitbox (AABB)

| Pose | Width (X,Z) | Height (Y) | Eye height |
|---|---|---|---|
| Standing / walking / sprinting / airborne / swimming | 0.6 | 1.8 | 1.62 |
| Sneaking | 0.6 | 1.8 (collision) | 1.27 (camera only) |

- The AABB is centered on the player position `(x, y, z)` horizontally; `y` is the **bottom** of the box (feet). Box = `[x−0.3, y, z−0.3] → [x+0.3, y+1.8, z+0.3]`.
- Eye position = `(x, y + eyeHeight, z)`.

> Adaptation: MC 1.20 shrinks the collision box to 1.5 (sneak) and 0.6 (swim/crawl/glide) and moves the sneak eye to 1.27. This clone keeps the collision box fixed at 0.6×1.8×0.6 in all poses and applies only the **camera** change (eye lerps 1.62 ↔ 1.27). With no sub-1.8 crawl spaces in scope, pose-dependent collision boxes are dead complexity. Crawling and prone sprint-swimming are cut entirely.

### 2.2 Pose transitions (camera only)

```
targetEye = sneaking ? 1.27 : 1.62
eyeHeight += (targetEye - eyeHeight) * 0.5   // per tick; ~3 ticks to settle (approx)
```

### 2.3 Model

- First person: the player body is **not rendered**. Only the held-item viewmodel (§19) is drawn.
- No third-person mode (decision — §18). No player-body mesh asset is required at all.

### 2.4 Persistent player state

Serialized with the save (persistence mechanism in 01-ARCHITECTURE.md):

```
position (f64×3), velocity (f32×3), yaw, pitch,
health (0–20), hunger+saturation (owned by 06), air (−20..300),
fireTicks, fallDistance, onGround,
inventory (36 slots, layout in 06), selectedHotbarSlot (0–8),
spawnPoint {x,y,z} | null   // set by bed (06); null → world spawn (02)
gameMode: "survival" | "debugCreative"
```

---

## 3. Input map

Must match the keybind registry in 01-ARCHITECTURE.md. All handlers call `preventDefault()`.

| Input | Action |
|---|---|
| `W A S D` | Move forward / strafe left / back / strafe right |
| `W` double-tap (≤ 7 ticks apart) | Start sprinting (on ground only) |
| `Left Ctrl` (hold, while W) | Sprint |
| `Space` | Jump / swim up / (flight: ascend); double-tap in debug creative toggles flight |
| `Left Shift` | Sneak (hold) / (flight: descend) |
| `E` | Toggle inventory UI (06); releases pointer lock |
| `Q` | Drop 1 item from held stack |
| `Shift+Q` | Drop entire held stack |
| `1`–`9` | Select hotbar slot 1–9 |
| Mouse wheel | Cycle hotbar slot (down = next, up = previous, wraps) |
| `LMB` (hold) | Break block / attack entity (attack on press, not hold) |
| `RMB` (hold) | Place block / use item / interact (repeats every 4 ticks) |
| Middle click | Pick block (debug creative only, 06 §14.2) |
| `F3` | Toggle debug overlay (rendered per 01) |
| `F4` | Toggle debug creative mode (§21) |
| `F5` | Reserved, no-op (no third person) |
| `Esc` | Release pointer lock → pause menu |

> Adaptation: Browsers reserve `Ctrl+W` (close tab) — it cannot be intercepted while W is held with Ctrl. Double-tap-W is therefore the **primary** sprint activation; Ctrl remains mapped for parity but the pause menu shows the double-tap hint. `Ctrl+Q` (MC's drop-stack) is replaced by `Shift+Q` for the same reason.

Input sampling: keyboard/mouse events set flags in an input-state object; the 20 Hz tick reads a snapshot at tick start. Mouse-look is applied per **frame** (§18); the tick reads the latest yaw/pitch.

---

## 4. Player tick pipeline (order of operations)

Executed once per game tick (50 ms), in exactly this order. Deviating from this order changes the equilibrium speeds.

```
function tickPlayer(p, input):
  1.  decrement timers: invulnTicks, mineDelay, useDelay, jumpCooldown, fireTicks
  2.  if p.dead: return (death screen handles respawn)
  3.  updateSneak(p, input)                  // §8 — sets speed multiplier + eye lerp
  4.  updateSprint(p, input)                 // §7 — state machine
  5.  medium = sample(world, p):             // which physics branch
        inWater  = any water block overlaps AABB
        inLava   = any lava block overlaps AABB
        onLadder = ladder block overlaps AABB (§9)
  6.  if p.flying: flightMove(p, input)                          // §21
      else if inLava:  lavaMove(p, input)                        // §11
      else if inWater: waterMove(p, input)                       // §10
      else:            landMove(p, input)                        // §5–6 (handles ladder clamps §9)
      // each *Move: accel → edge-guard clamp → move+collide (01 primitive) → drag/gravity
  7.  updateFallDistance(p)  + apply landing damage              // §12
  8.  environmental damage:  fire/lava/burn (§11), drowning (§10),
      suffocation, void (§13)     // each via damage(p, amount, source) §20
  9.  updateMining(p, input)                                     // §15
  10. updateUse(p, input)                                        // §16 (place/interact/eat-hook)
  11. exhaustion triggers → notify hunger system (values in 06):
      sprint (per m sprinted), jump, sprint-jump, swim (per m), block broken, damage taken
  12. update HUD state (hearts flash, bubbles, crack overlay stage)
```

`move+collide` is 01's swept-AABB collide-and-slide. It must return: resolved position, `onGround` (blocked moving down), `horizontalCollision` (X or Z clipped), and zero the velocity component on each blocked axis.

---

## 5. Horizontal movement — ground and air

### 5.1 Input vector

```
strafe  = (D ? 1 : 0) - (A ? 1 : 0)      // right positive
forward = (W ? 1 : 0) - (S ? 1 : 0)
strafe  *= 0.98; forward *= 0.98         // keyboard input factor (MC parity)
if sneaking: strafe *= 0.3; forward *= 0.3
```

The `0.98` and the ordering matter: they produce the exact 4.317 / 5.612 / 1.295 m/s speeds and MC's diagonal quirks.

### 5.2 Acceleration from input (`moveRelative`)

```
function inputAccel(strafe, forward, speed, yaw):
  d2 = strafe*strafe + forward*forward
  if d2 < 1e-7: return (0, 0)
  scale = speed / max(sqrt(d2), 1.0)     // normalize ONLY if |input| > 1
  // camera basis on the XZ plane:
  fwd   = normalize(lookDir.xz)          // unit forward
  right = (-fwd.z, fwd.x)                // unit right
  ax = (right.x * strafe + fwd.x * forward) * scale
  az = (right.y * strafe + fwd.y * forward) * scale
  return (ax, az)
```

Consequences to preserve (do not "fix"): straight walk accel = 0.98×speed; diagonal walk input has magnitude 1.386 → normalized → accel = 1.0×speed, so diagonal walking is ~2% faster (4.40 m/s); diagonal sneak input magnitude 0.416 < 1 → NOT normalized → diagonal sneaking is ×1.414 faster (1.83 m/s). These match MC measurements.

### 5.3 Speed parameter

```
mult  = sprinting ? 1.3 : 1.0            // sneak already folded into input (§5.1)
slip  = slipperiness of block under feet (block at (x, y−0.5, z)); default 0.6
        // registry field in 06; only ice-type blocks differ (0.98)
speedGround = 0.1 * mult * (0.6 / slip)^3     // = 0.1 or 0.13 on normal ground
speedAir    = 0.02 * mult                     // = 0.02 or 0.026
```

### 5.4 Per-tick horizontal update (land branch)

```
(ax, az) = inputAccel(strafe, forward, onGround ? speedGround : speedAir, yaw)
v.x += ax; v.z += az
// (jump handled in §6 before the move)
(dx, dz) = sneakEdgeClamp(p, v.x, v.z)        // §8.2; identity when not sneaking
moveAndCollide(p, dx, v.y, dz)                // 01 primitive; updates onGround etc.
friction = onGround ? slip * 0.91 : 0.91      // 0.546 on normal ground
v.x *= friction; v.z *= friction
```

Equilibrium check (must hold in tests): `speed = accel / (1 − friction)` → walk 0.098/0.454 = 0.21586 b/t = **4.317 m/s**; sprint **5.612 m/s**; sneak **1.295 m/s**.

If `|v.x| < 0.003` set 0 (same for z, and for y in §6) — MC's velocity epsilon, prevents endless micro-sliding.

### 5.5 Step-up

`stepHeight = 0`. Colliding with any block edge stops horizontal motion; 1-block ledges require jumping.

> Adaptation: MC uses stepHeight 0.6, which only matters for slabs, stairs, and similar sub-block shapes — all out of scope (no slabs/stairs in scope, §16.4). Dropping it removes an entire branch from the collision solver in 01. If slabs are ever added, implement MC's 0.6.

---

## 6. Vertical movement — gravity, drag, jumping

### 6.1 Gravity and drag (land branch, after the move)

```
v.y = (v.y - 0.08) * 0.98
```

Terminal velocity −3.92 b/t (−78.4 m/s); reached asymptotically, no clamp needed (float-stable).

### 6.2 Jumping

```
if input.jump and onGround and jumpCooldown == 0:
    v.y = 0.42
    if sprinting:
        v.x += 0.2 * fwd.x                 // fwd = unit facing on XZ (yaw), NOT input dir
        v.z += 0.2 * fwd.y
    jumpCooldown = 10                      // only throttles held-key auto-rejump (approx)
    // exhaustion trigger: jump / sprint-jump (values in 06)
```

- Jump apex: 1.2522 blocks (Java-measured). The recurrence above yields ≈1.251 — acceptable float variance.
- The sprint-jump boost applies toward **facing**, even when strafing (MC behavior; makes sprint-jumping the fastest travel, avg ≈7.127 m/s).
- Jump is evaluated **before** `moveAndCollide` in the same tick (rises 0.42 on the jump tick).
- Sneaking does not reduce jump height (horizontal input is reduced, vertical is not).
- No auto-jump.

---

## 7. Sprinting

State machine evaluated each tick before movement.

### 7.1 Start conditions (ALL required)

```
canSprint =
    forwardInput >= 0.8          // after ×0.98, before sneak: W held and not sneaking
    and hunger > 6               // hunger value from 06; at 6 or below sprint is denied
    and not sneaking
    and not usingItem            // eating/drinking (06 use-item channel)
    and not inWater and not inLava
    and not flying-descend-only cases (flight sprint allowed, §21)
```

Started by, when `canSprint`:
- Sprint key held (any time, ground or air), or
- Forward key pressed twice within **7 ticks** while `onGround` (double-tap). Track `ticksSinceForwardPressed`; on W keydown: `if ticksSinceForwardPressed <= 7 and onGround and canSprint: sprinting = true`.

### 7.2 Stop conditions (ANY, checked every tick)

| Trigger | Note |
|---|---|
| `forwardInput < 0.8` | Released W, or started sneaking (0.294 < 0.8) |
| `horizontalCollision` this tick | Java stops immediately on wall hit |
| `hunger <= 6` | |
| Entered water or lava | Adaptation — MC 1.13+ has sprint-swimming; cut with prone mode (§2.1) |
| Started using an item (eating) | Resumes only via re-activation |
| Landed a melee attack | Sprint-knockback attack, handled in 05 — 05 calls `player.stopSprint()` |
| Toggled flight off/on | Reset state |

### 7.3 Effects of sprinting

- Ground accel ×1.3, air accel ×1.3 (§5.3).
- +0.2 facing boost on jump (§6.2).
- FOV ×1.10, lerped (§18.3).
- Exhaustion per meter sprinted (rate in 06).
- Sprint particles at feet: optional polish, skip by default.

---

## 8. Sneaking and the edge guard

Active while Sneak key held (hold-mode only; no toggle).

### 8.1 Effects

| Effect | Spec |
|---|---|
| Movement input ×0.3 | → 1.295 m/s walk-equivalent (§5.1) |
| Eye height → 1.27 | Camera lerp (§2.2); collision box unchanged (Adaptation §2.1) |
| Cannot start/continue sprint | Via the forward ≥ 0.8 check |
| Edge guard | §8.2 — cannot fall off edges taller than 0.6 |
| Place-on-interactable | RMB places instead of opening UI (§16.3) |
| On ladder: hold position | `v.y = max(v.y, 0)` while on ladder and sneaking (§9) |
| Mining speed | Unchanged by sneaking itself |

### 8.2 Edge guard algorithm

Rule (MC 1.20): while sneaking within 0.6 of the ground and not moving upward, horizontal movement is clamped so the player cannot move to where a drop **greater than 0.6 blocks** would occur. Jumping still dismounts (v.y > 0 disables the guard).

```
function sneakEdgeClamp(p, dx, dz):
  if not p.sneaking or p.v.y > 0: return (dx, dz)
  if not hasSupport(p.aabb): return (dx, dz)        // already airborne > 0.6: no guard
  STEP = 0.05
  // shrink dx toward 0 until the destination still has support
  while dx != 0 and not hasSupport(p.aabb.offset(dx, 0, 0)):
      dx = shrinkTowardZero(dx, STEP)
  while dz != 0 and not hasSupport(p.aabb.offset(0, 0, dz)):
      dz = shrinkTowardZero(dz, STEP)
  while dx != 0 and dz != 0 and not hasSupport(p.aabb.offset(dx, 0, dz)):
      dx = shrinkTowardZero(dx, STEP)
      dz = shrinkTowardZero(dz, STEP)
  return (dx, dz)

function hasSupport(aabb):                   // is there ground within 0.6 below?
  return world.collidesAny(aabb.offset(0, -0.6, 0))    // 01 collision query

function shrinkTowardZero(v, step):
  return (abs(v) <= step) ? 0 : v - sign(v)*step
```

This clamps only the attempted displacement for this tick; velocity is preserved (matches MC: you slide along the edge). Result: the player's AABB can overhang an edge by up to 0.6 − ε but never fully leave support.

---

## 9. Climbing (ladders)

Applies when a ladder block's cell overlaps the player AABB (`onLadder`). If 06's registry ships no ladder, this section is dormant — keep the code path.

Rules, applied inside the land branch (§5.4/§6.1), after acceleration, before the move:

```
if onLadder:
    v.x = clamp(v.x, -0.15, 0.15); v.z = clamp(v.z, -0.15, 0.15)
    if horizontal input pressed (any) or input.jump:   // pushing = climbing
        v.y = max(v.y, 0.2)          // gravity+drag same tick → net 0.1176 b/t = 2.35 m/s up
    if sneaking: v.y = max(v.y, 0)   // cling
    v.y = max(v.y, -0.15)            // descent cap 3 m/s
    fallDistance = 0                 // continuously
```

Landing on top of a ladder block's cell counts as normal ground (no fall reset beyond the rules above). Being on a ladder counts as "not on ground" for mining (÷5, §15.2) only if `onGround` is false.

---

## 10. Water movement, drowning, air supply

Water/lava as **blocks** (states, flow, source cells) are specced in 06; this section defines how the player moves and survives in them. For physics, treat any water block (source or flowing) as a full-cell fluid (approx — flow push forces are cut).

> Adaptation: MC 1.13+ prone sprint-swimming (0.6 hitbox, 3.9 m/s) is cut along with crawling. Water movement is the classic upright model with exact 1.20 constants; resulting speeds (1.96 m/s horizontal) sit inside the wiki's measured 1.81–2.20 m/s band.

### 10.1 Per-tick water movement

```
function waterMove(p, input):
    if input.jump: v.y += 0.04                       // swim up
    (ax, az) = inputAccel(strafe, forward, 0.02, yaw) // same input pipeline as land
    v.x += ax; v.z += az
    moveAndCollide(p, v.x, v.y, v.z)
    v.x *= 0.8; v.y *= 0.8; v.z *= 0.8               // water drag, all axes
    v.y -= 0.005                                     // water gravity
    // climb-out assist (MC): hop onto shore
    if horizontalCollision and isClear(p.aabb.offset(v.x, 0.6, v.z)):
        v.y = 0.3
    fallDistance = 0
```

Derived behavior (test targets): horizontal ≈1.96 m/s; idle sink 0.5 m/s; jump-held ascent ≈2.7–3.5 m/s; entering water instantly cancels accumulated fall distance and thus fall damage (any depth — contact is enough); sprint state is cancelled on entry (§7.2). Jumping from the bottom in 1-deep water still uses the land branch when the AABB no longer overlaps water.

### 10.2 Air supply and drowning

`air` ∈ [−20, 300], starts and respawns at 300.

```
eyeSubmerged = blockAt(eyePos) is water            // full-cube check (approx)
if eyeSubmerged:
    air -= 1
    if air <= -20:
        air = 0
        damage(p, 2, DROWNING)                     // bypasses armor concept; plain 2 HP
else:
    air = min(300, air + 7.5)                      // 1 bubble (30) per 4 ticks
```

Timeline from full air: 300 ticks (15 s) of bubbles, then first 2 HP at 16 s, then 2 HP every second. Death from full HP after ~25 s submerged.

### 10.3 Air bubble HUD

- 10 bubble icons, right-aligned above the hunger bar (mirror of hearts row; layout anchor in 06's HUD grid).
- Visible bubbles = `ceil(air / 30)`, hidden entirely when `air == 300`.
- A bubble "pops" (brief 2-frame pop sprite, optional) each time `air` crosses a multiple of 30 downward.

---

## 11. Lava movement, fire, burning

### 11.1 Per-tick lava movement

```
function lavaMove(p, input):
    if input.jump: v.y += 0.04
    (ax, az) = inputAccel(strafe, forward, 0.02, yaw)
    v.x += ax; v.z += az
    moveAndCollide(p, v.x, v.y, v.z)
    v.x *= 0.5; v.y *= 0.5; v.z *= 0.5               // lava drag
    v.y -= 0.02                                      // lava gravity
    if horizontalCollision and isClear(p.aabb.offset(v.x, 0.6, v.z)):
        v.y = 0.3                                    // climb-out assist
    fallDistance *= 0.5                              // per tick in lava
```

Derived: horizontal ≈0.78 m/s (crawling pace — lava is a trap); jump-held ascent ≈ neutral hover (equilibrium 0), so escaping requires the climb-out assist at an edge. Authentic to MC.

### 11.2 Contact damage and ignition

```
if inLava (AABB overlap):
    every 10 ticks: damage(p, 4, LAVA)
    fireTicks = 300                                  // 15 s burn
else if standing in a fire block (AABB overlap):
    every 10 ticks: damage(p, 1, FIRE)
    fireTicks = max(fireTicks, 160)                  // 8 s burn
```

Fire blocks (placement, spread, burning of flammable blocks) are 06/04 scope; the player only needs `fire` as an overlappable damaging block.

### 11.3 Burning (on-fire state)

```
if fireTicks > 0:
    fireTicks -= 1
    every 20 ticks (while not currently in lava/fire source): damage(p, 1, BURNING)
    if inWater or standingInRain (04): fireTicks = 0
```

Visuals: orange flame overlay across the bottom third of the screen while `fireTicks > 0` (two alternating flame frames, 4 ticks each, 60% opacity) (approx).

---

## 12. Fall damage

### 12.1 Tracking

```
// after moveAndCollide each tick:
if p.v.y < 0 and not onGround:
    fallDistance += -(actualDy)          // actualDy = resolved Y displacement (negative)
if onGround:
    if fallDistance > 0:
        dmg = ceil(fallDistance - 3)
        if dmg > 0: damage(p, dmg, FALL)
    fallDistance = 0
```

### 12.2 Reset/cancel rules

| Condition | Effect |
|---|---|
| Any water contact (AABB overlap) | `fallDistance = 0` — landing in water of any depth cancels all fall damage |
| On ladder | `fallDistance = 0` continuously (§9) |
| In lava | `fallDistance *= 0.5` per tick (§11.1) |
| Flying (debug) | `fallDistance = 0` continuously (§21) |
| Moving upward | Not accumulated (only `v.y < 0` accumulates) |
| Death/respawn | Reset to 0 |

### 12.3 Reference values (test targets)

| Fall height | Damage |
|---|---|
| ≤ 3.0 blocks | 0 |
| 3.5 blocks | 1 HP (ceil(0.5)) |
| 4 blocks | 1 HP |
| 10 blocks | 7 HP |
| 23 blocks | 20 HP — lethal from full health (23.5 in practice due to tick sampling; either is acceptable) |

No Jump Boost / Feather Falling modifiers (no status effects/enchantments in scope).

---

## 13. Suffocation and void

### 13.1 Suffocation

```
if blockAt(eyePos).isSolidOpaqueCube:      // registry flag from 06
    every 10 ticks: damage(p, 1, SUFFOCATION)
```

Since placement into the player is blocked (§16.2), the practical source is sand/gravel falling onto the player's head (gravity blocks in 06). Render: full-screen darkened block texture of the suffocating block (zoomed 4×, 85% opacity).

### 13.2 Void and world bounds

World is Y 0–127 (bedrock floor at Y 0 per 02).

> Adaptation: MC's void starts 64 blocks below the world floor. With a Y0 floor, that dead zone is pointless. Chosen behavior below.

- `feetY < −8`: `damage(p, 4, VOID)` every 10 ticks. Void damage ignores invulnerability frames (MC parity) and cannot be prevented.
- `feetY < −64`: instant death (safety kill plane).
- Reaching below Y 0 is only possible via bugs or debug flight through broken bedrock; the rule exists so falls never hang the game.
- Above the world: no ceiling for movement/flight; block **placement** is denied for `y > 127` or `y < 0` (§16.2).

---

## 14. Block targeting and reach

- Ray origin: eye position (§2.1). Direction: camera look vector. Sampled per tick for game logic; per frame for the highlight outline.
- Traversal: voxel DDA (primitive in 01-ARCHITECTURE.md, "raycastVoxels"), returning first block whose registry entry is `targetable` (solid cubes + torches; water/lava/air are skipped), the hit face normal, and hit distance.
- Max distance: **4.5** (survival), **5.2** (debug creative).
- Highlight: 0.002-inflated black wireframe box (line width 1, 40% alpha) around the targeted block, per frame.
- Entity targeting (for LMB attack): intersect the same ray with all mob AABBs within 3.0 m of the eye; if the nearest entity hit is closer than the block hit and ≤ 3.0 away, the target is the entity. Attack execution/damage: 05-MOBS-COMBAT.md.

---

## 15. Breaking blocks

### 15.1 Ownership

This file owns the breaking-time **formula** and mining loop. Per-block `hardness`, per-block best-tool class, per-tool `speedMultiplier` tier and `canHarvest` tier rules, and drops are the registry tables in 06-ITEMS-CRAFTING-SURVIVAL.md.

Tool tier speed multipliers (mirrored here for the formula; authoritative copy in 06): none 1, wood 2, stone 4, iron 6, diamond 8, gold 12 (shears ×15 on leaves, ×5 on wool; swords have no block-breaking role). No enchantments, Haste, or Mining Fatigue in scope — their hooks are noted below and omitted.

### 15.2 Damage-per-tick formula (Java 1.20, exact)

```
function miningDamagePerTick(block, tool, player):
    if block.hardness < 0: return 0                      // bedrock: unbreakable
    isBestTool = tool.class == block.bestToolClass       // e.g. pickaxe vs stone
    speed = isBestTool ? tool.speedMultiplier : 1.0
    // (hook: + efficiency^2+1, ×(0.2·haste+1), ×0.3^fatigue — all out of scope)
    if player.eyeSubmerged: speed /= 5                   // no Aqua Affinity in scope
    if not player.onGround: speed /= 5                   // stacks: floating in water = ÷25
    damage = speed / block.hardness
    damage /= canHarvest(block, tool) ? 30 : 100         // canHarvest from 06 tier table
    return damage
```

```
if block.hardness == 0: instant break (1 damage regardless)  // torch, flowers…
if damage >= 1 (per tick): instant break, no crack animation, NO inter-block delay
else: ticks = ceil(1 / damage); seconds = ticks / 20
```

Note on under-tier tools (Java behavior, keep it): `isBestTool` is true whenever the tool **class** matches, even if the tier is too low to harvest — the speed multiplier still applies; only the ÷100 divisor and the no-drop rule punish the low tier.

Reference outcomes (validate against 06's table): stone + bare hand = 7.5 s (no drop); stone + wooden pick = 1.15 s (drops); dirt + hand = 0.75 s; oak log + hand = 3.0 s; oak log + iron axe = 0.5 s; obsidian (hardness 50) + iron pick = 1/(6/50/100) = 834 ticks = 41.7 s (no drop); obsidian + diamond pick = 1/(8/50/30) = 188 ticks = 9.4 s (drops).

### 15.3 Mining loop (continuous while LMB held)

```
state: {targetPos: null, progress: 0.0, mineDelay: 0}

each tick while LMB held:
    if mineDelay > 0: mineDelay -= 1; playSwing(); return
    hit = raycastVoxels(eye, look, reach)
    if no block hit: reset(); return
    if hit.pos != targetPos: targetPos = hit.pos; progress = 0
    d = miningDamagePerTick(...)
    if d >= 1: breakBlock(targetPos); reset(); return       // instant: no delay
    progress += d
    playSwing()                                             // §19, loops every 6 ticks
    if progress >= 1:
        breakBlock(targetPos)
        reset(); mineDelay = 6                              // 0.3 s before next block

on LMB release: reset()   // progress lost entirely (MC parity — no decay, hard reset)

function breakBlock(pos):
    spawn drop item entity per 06 loot rules (only if canHarvest)
    if heldTool and block.hardness > 0: durability -= 1 (values in 06)
    world.setBlock(pos, AIR) → mesh/light updates (01/04)
    play break particles: 4×4×4 cube of 0.1-size textured particles, velocity
      radially outward 0–2 m/s + gravity, lifetime 10–20 ticks (approx)
    exhaustion trigger: block broken (value in 06)
```

Switching tools mid-break keeps `progress` (fraction) and changes only `d` from the next tick. Mining works while jumping, falling, swimming (with the ÷5 penalties baked into the formula). Attacks (entity target, §14) fire on LMB **press** only; block mining engages on hold — if the press tick targets an entity, that click is an attack and mining does not start until re-press.

### 15.4 Crack overlay

- 10 textures `destroy_stage_0..9`.
- `stage = floor(progress * 10)`, clamped 0–9; render as an overlay quad set on the target block faces (slight 0.001 offset, alpha-tested).
- Removed instantly on reset/target change.

---

## 16. Placing and using blocks

### 16.1 RMB priority (evaluated on press, and every 4 ticks while held)

```
1. hit = raycastVoxels(eye, look, 4.5); if none → try use-item-in-air (food: 06); done
2. if hit.block.interactable and not sneaking:
       open its UI (crafting table / furnace / chest / bed action — 06)   // interact-first
3. else if heldItem is a placeable block: try place (§16.2)
4. else if heldItem is usable (food, bucket, flint&steel — 06): use on target per 06
5. else: nothing (no swing — the arm swings only on success or attack)
```

Sneaking + RMB on an interactable always attempts placement (MC parity — lets you place blocks against chests).

### 16.2 Placement rules

```
placePos = hit.pos + hit.faceNormal
valid =
    hit.distance <= 4.5
    and 0 <= placePos.y <= 127
    and blockAt(placePos) is in the replaceable set: {air, water, lava, fire, short_grass, dandelion, poppy, dead_bush} (06 §5.7)
    and not aabbOf(placePos).intersects(player.AABB or any mob AABB)   // ε = 1e-7
    and heldStack.count > 0
on success:
    world.setBlock(placePos, blockState)
    heldStack.count -= 1 (survival; not in debug creative §21)
    playSwing(); useDelay = 4
```

Item entities do NOT block placement; the player and mobs do (living entities only).

### 16.3 Interactables

`interactable` is a registry flag in 06 (crafting table, furnace, chest, bed). Opening a UI releases pointer lock and pauses player input (world keeps ticking — single player, no pause during UI other than Esc menu; decision).

### 16.4 Orientation

All placeable blocks are orientation-agnostic cubes **except the torch**: face == top face → floor torch; face == side → wall torch with that facing (4 wall states); face == bottom → placement denied. No other rotated/directional block states (no logs-axis, no stairs, no furnace-facing — furnace renders its face toward the player's horizontal facing at place time if 06 provides the state, else uniform (approx)).

> Adaptation: MC's full blockstate system (axis, facing, half, waterlogged…) is cut to: uniform cubes + 5 torch states. 06's registry defines the two torch state families.

---

## 17. Dropping items

- `Q`: drop 1 from the held hotbar stack. `Shift+Q`: drop the whole stack.
- Spawn an item entity (06 owns item-entity physics/pickup) at the eye position minus 0.3 Y, with velocity:

```
v = look dir × 0.3 + vy 0.1 + random ±0.02 per axis   // gentle toss forward (matches 06 §16 verbatim)
pickupDelay = 40 ticks                            // can't instantly re-collect
```

- Dropping from open inventory UI (drag-out) follows the same spawn rule (UI in 06).

---

## 18. Camera and first-person view

### 18.1 Pointer lock

- Click on canvas → `requestPointerLock()`. `pointerlockchange` loss (Esc) → open pause menu, freeze look input; movement keys clear.
- While locked, accumulate `movementX/Y` per frame:

```
yaw   -= movementX * 0.15° * sensitivity      // sensitivity default 1.0, range 0.1–3.0 (settings)
pitch -= movementY * 0.15° * sensitivity
pitch = clamp(pitch, -90°, +90°)
yaw wraps mod 360°
```

(0.15°/count equals MC's default-sensitivity rate.)

### 18.2 Projection

- FOV: **70°** vertical base (MC default). Aspect from canvas. Near 0.05, far per 01's render distance.
- First person only. No F5 third person (decision: saves a player model, animation rig, and camera-collision code; F5 reserved as stretch).

### 18.3 FOV effects

```
targetFovScale = 1.0
if sprinting or sprintFlying: targetFovScale = 1.10          // +10% (decision; MC scales by speed attr)
fovScale += (targetFovScale - fovScale) * 0.5                // per tick, ~3 ticks to settle
fov = 70° * fovScale
```

### 18.4 View bobbing (included; Settings toggle default ON)

Per tick, when on ground and not flying:

```
hSpeed = length(v.xz)                       // b/t
bobIntensity = clamp(hSpeed / 0.2806, 0, 1) // 1.0 at sprint speed
bobPhase += hSpeed * 1.5                    // radians
camOffsetY     = |cos(bobPhase)| * 0.05 * bobIntensity
camOffsetRight = sin(bobPhase)  * 0.025 * bobIntensity
```

Interpolate offsets per frame between ticks (all values approx; tune by eye against MC footage).

### 18.5 Screen overlays owned by camera

| Overlay | Trigger | Spec |
|---|---|---|
| Damage flash | on `damage()` | Full-screen red, 30% alpha, linear fade over 10 ticks |
| Hurt tilt | on `damage()` | Camera roll 8° toward damage side, decay to 0 over 10 ticks (approx) |
| Underwater tint | eye submerged | Blue-gray tint, 25% alpha + fog handled by 04 |
| Fire overlay | `fireTicks > 0` | §11.3 |
| Suffocation | §13.1 | Darkened block texture |
| Vignette on death | `dead` | §20.4 |

---

## 19. Held-item viewmodel

- Rendered in a separate scene/camera pass (FOV fixed 70°, ignores world FOV changes; cleared depth) so it never clips world geometry.
- Blocks: 0.4-scale cube with the block's textures, positioned bottom-right: translate `(+0.56, −0.52, −0.72)` in camera space, rotated 45° around Y (approx MC transform). Items (tools): flat textured quad (the item sprite extruded 1px, or a simple quad), translate `(+0.56, −0.52, −0.72)`, rotate `(0°, −90°, 25°)` (approx).
- Hotbar switch: current item slides down 0.3 over 3 ticks, new item slides up over 3 ticks.

### 19.1 Swing animation

Duration 6 ticks (0.3 s), progress `s = tick/6`, curve `k = sin(s·π)`:

```
translate.y -= 0.25 * k
translate.x -= 0.10 * k
rotate.x    -= 75° * k
rotate.y    -= 25° * k
```

Triggered by: attack press, successful place/use, each mining tick (retrigger when previous swing ends → continuous chopping loop while mining). Interpolate per frame.

---

## 20. Health, damage intake, death, respawn

### 20.1 Health

- `health` ∈ [0, 20] HP (10 hearts, 1 heart = 2 HP). Start/respawn: 20.
- Regeneration from hunger: rules and rates in 06 (health regen when hunger ≥ 18, plus starvation damage floor — 06 calls `damage(p, 1, STARVATION)`).

### 20.2 Damage intake pipeline

```
function damage(p, amount, source):
    if p.dead: return
    if p.gameMode == debugCreative and source not in {VOID}: return   // debug mode: immune (§21)
    if invulnTicks > 0 and source not in {VOID, STARVATION}: apply only the excess over lastHurtAmount (05 §14 rule); return if none
    p.health -= amount
    invulnTicks = 10; lastHurtAmount = amount               // 0.5 s window (excess rule, 05 §14)
    trigger: red flash + hurt tilt (§18.5), hearts-blink HUD, hurt sound
    exhaustion trigger: damage taken — armor-reducible types only (06 §12.1)
    if source is mob melee: applyKnockback(p, 0.4, dirFromAttacker)   // 05 supplies dir
    if p.health <= 0: die(p)
```

> i-frame semantics owned by 05 §14 (MC excess rule, 10 ticks).

### 20.3 Knockback received

```
function applyKnockback(p, strength=0.4, push):   // push = unit XZ vector away from attacker
    p.v.x = p.v.x/2 + strength * push.x
    p.v.z = p.v.z/2 + strength * push.z
    if p.onGround: p.v.y = min(0.4, p.v.y/2 + 0.4)
```

### 20.4 Damage sources summary (player-received)

| Source | Amount | Cadence | Spec section |
|---|---|---|---|
| Fall | ceil(dist − 3) | on landing | §12 |
| Drowning | 2 | per 20 ticks | §10.2 |
| Fire block contact | 1 | per 10 ticks | §11.2 |
| Burning | 1 | per 20 ticks | §11.3 |
| Lava | 4 | per 10 ticks | §11.2 |
| Suffocation | 1 | per 10 ticks | §13.1 |
| Void | 4 | per 10 ticks, ignores invuln | §13.2 |
| Starvation | 1 | per 06 rules | 06 |
| Mob attacks | per mob | on hit | 05 |

Difficulty is hard-coded Normal; armor reduction per 05 §14.2 using 06 §7.2's points, applied inside `damage()` for armor-applicable sources.

### 20.5 Death

```
function die(p):
    p.dead = true; p.health = 0
    drop ALL inventory slots as item entities at p.position + (0, 0.6, 0),
        each with velocity: vx,vz ∈ ±0.2 random, vy = 0.2, pickupDelay 40 (06 item entities)
    spawn one XP orb worth min(7 × level, 100) (06 §13)
    clear inventory; clear fireTicks, air=300, fallDistance=0, velocity=0
    show death screen
```

Death screen: full red vignette (40%), centered "You Died!", buttons `Respawn` and `Title Screen`. World keeps rendering behind (camera frozen at death position); mobs keep ticking. XP: on death also drop XP orbs worth min(7 × level, 100) at the death point and reset to level 0 (formula owned by 06 §13; orb entity/magnet per 05 §15). Death screen shows "Score: <total XP>" per 06 §15.3.

### 20.6 Respawn

```
pos = p.spawnPoint (bed, validated per 06 — bed present & unobstructed) else worldSpawn (02)
if bed invalid: chat/toast "You have no home bed, or it was obstructed" and use worldSpawn
reset: health 20, hunger/saturation per 06 defaults, air 300, velocity 0,
       fireTicks 0, fallDistance 0, invulnTicks 0, sprint/sneak off, dead=false
position at pos (feet on the spawn block's top), yaw = 0 (facing −Z per 01's
       axis convention), pitch = 0
```

No respawn invulnerability window (MC Java parity).

---

## 21. Debug creative flight (F4)

A **debug mode for development and the video demo** — not a survival feature. `F4` toggles `gameMode` between `survival` and `debugCreative`. State changes on toggle-ON: nothing else; toggle-OFF: `flying = false`.

While in `debugCreative`:

| Rule | Spec |
|---|---|
| Double-tap Space (≤ 7 ticks) | Toggle `flying` |
| All damage ignored except VOID kill plane | `damage()` early-outs (§20.2) |
| Instant break | Every targetable block breaks on first mining tick, no cracks, no inter-block delay; no drops spawned (keeps demo inventory clean) |
| Placement | Does not consume items; stack of ≥1 places infinitely |
| Reach | 5.2 |
| Landing on ground while flying | Flying persists until double-Space or F4 (decision — simpler than MC's touch-ground auto-cancel) |

Flight movement (replaces the land/fluid branch while `flying`):

```
function flightMove(p, input):
    speed = 0.049 * (sprinting ? 2.0 : 1.0)         // sprint-fly = double
    (ax, az) = inputAccel(strafe, forward, speed, yaw)
    v.x += ax; v.z += az
    if input.jump:  v.y += 0.15
    if input.sneak: v.y -= 0.15
    moveAndCollide(p, v.x, v.y, v.z)
    v.x *= 0.91; v.z *= 0.91
    v.y *= input.jump or input.sneak ? 0.91 : 0.6    // quick vertical stop (approx)
    v.y = clamp(v.y, -0.375, 0.375)                  // ±7.5 m/s vertical (approx)
    fallDistance = 0
```

Equilibrium horizontal: 0.049×0.98/(0.09) ≈ 0.533 b/t ≈ **10.7–10.9 m/s** (wiki: 10.89); sprint-fly ≈ **21.6–21.8 m/s**. Gravity is not applied while flying. Sneak while flying descends (does NOT sneak); jump+sneak together hover.

---

## 22. Spawn and respawn logic

- World spawn: provided by 02-WORLD-GENERATION.md (surface column near origin). Player spawns with feet on top of the highest solid block there, `yaw = 0, pitch = 0`, full stats, empty inventory (or 02-defined bonus items — none by default).
- First spawn = respawn path with `spawnPoint = null` (§20.6).
- Bed sets `spawnPoint` on use (bed block behavior, sleep mechanics, and validity checks in 06; coordinate: 06's bed entry writes `player.spawnPoint`, this file consumes it on respawn).
- Out-of-bounds: §13.2. Horizontal bounds: none (chunks stream, 01/02).
- Save/load restores the full §2.4 state (persistence in 01).

---

## 23. Player-owned HUD elements

Layout grid and hotbar/hunger rendering are 06's (inventory file); this file owns:

| Element | Spec |
|---|---|
| Crosshair | 9×9 px plus-shape, center screen, white with `difference` blend (or 60% gray) |
| Hearts row | 10 hearts, left-aligned above hotbar; full/half/empty states; on damage: row shakes ±1 px for 10 ticks; at health ≤ 4: idle jitter 1 px (approx) |
| Air bubbles | §10.3 |
| XP bar | rendering per 06 §15.1; player.xpPickupCooldown per 05 §15 |
| Crack overlay | §15.4 (world-space) |
| Block highlight | §14 (world-space) |
| Damage/fire/water/suffocation overlays | §18.5 |
| Death screen | §20.5 |
| Debug-mode badge | While `debugCreative`: small "DEBUG CREATIVE (F4)" text, top-right, 50% alpha |

---

## 24. Acceptance checklist

Movement (measure over ≥100 ticks on flat ground, report m/s):
- [ ] Walk speed 4.317 m/s ±1%; sprint 5.612 m/s ±1%; sneak 1.295 m/s ±1%.
- [ ] Diagonal walk ≈4.40 m/s (faster than straight); diagonal sneak ≈1.83 m/s.
- [ ] Jump apex 1.25 ±0.01 blocks; cannot jump onto a 2-block ledge; can jump onto 1-block.
- [ ] Sprint-jumping covers a 4-block gap (takeoff and landing on same Y); walking-jump covers 2 but not 4.
- [ ] Airborne strafe control is weak (0.02 accel) but real: mid-jump steering visibly works.
- [ ] Falling reaches ≥ 70 m/s after ~10 s of free fall; never exceeds 78.4 m/s.
- [ ] No step-up: walking into any 1-block ledge stops the player dead.
- [ ] Velocity components < 0.003 b/t snap to zero (no drift when idle).

Sprint/sneak:
- [ ] Double-tap W within 0.35 s starts sprint (on ground); Ctrl+W also works; FOV eases to 77° and back.
- [ ] Sprint ends on: W release, wall hit, hunger ≤ 6, sneak, water entry.
- [ ] Sneaking at an edge: player can overhang but never falls; jumping dismounts; works on diagonals.
- [ ] Sneak lowers camera to 1.27 smoothly; collision box unchanged.

Fluids/ladders:
- [ ] Water: ~2 m/s horizontal, sinks 0.5 m/s idle, Space ascends, fall damage cancelled by any water contact.
- [ ] Air HUD: bubbles appear on submerge, 15 s to empty, then 2 HP/s; refills fully in 2 s out of water.
- [ ] Lava: ~0.8 m/s movement, 4 HP per half-second + burning 15 s after exit; water extinguishes fire.
- [ ] Ladder: up 2.35 m/s while pushing into it, descent capped 3 m/s, sneak clings, fall distance resets.

Fall damage:
- [ ] 3-block fall: 0 damage. 4-block: 1 HP. 10-block: 7 HP. 23.5-block: death from full HP.

Breaking/placing:
- [ ] Stone barehand 7.5 s (no drop); stone with wooden pick 1.15 s (drop); dirt barehand 0.75 s; times always whole ticks (ceil).
- [ ] Mining while airborne or with eye submerged is 5× slower (25× combined).
- [ ] Crack overlay steps through 10 stages; resets on target change or LMB release.
- [ ] Holding LMB across a row of dirt: exactly 6 idle ticks between consecutive blocks.
- [ ] Torch: floor + 4 wall orientations; denied on ceilings. All other blocks orientation-free.
- [ ] Cannot place a block intersecting the player or a mob; can place against a chest while sneaking; RMB on crafting table opens UI when not sneaking.
- [ ] Reach exactly 4.5: block at 4.4 breaks, at 4.6 is not even highlighted.

Health/death:
- [ ] Damage: red flash + tilt + 0.5 s invulnerability (a second, equal-or-weaker hit inside the window does nothing; a stronger hit applies only its excess — 05 §14).
- [ ] Mob hit knocks the player back ~0.4-impulse with 0.4 vertical pop.
- [ ] Death drops the entire inventory as collectible item entities; respawn at bed if valid, else world spawn, 20 HP.

Debug/camera:
- [ ] F4 + double-Space flies at ~10.9 m/s (21.7 sprinting), immune to damage, instant-breaks blocks, no item consumption; F4 again returns to survival cleanly.
- [ ] Pointer lock on click; Esc opens pause menu; pitch clamps at exactly ±90°; view-bob toggle works.
- [ ] Held item renders bottom-right, swings on every mining tick / attack / place; hotbar switch animates.
