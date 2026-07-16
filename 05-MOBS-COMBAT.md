# 05 — Mobs & Combat

Full specification for all mob entities (5 hostile, 4 passive), the runtime spawning/despawning system, mob AI (goal system + A* pathfinding), mob-specific behaviors, breeding, the arrow projectile, creeper explosions, the complete player-side combat math (1.9 attack-cooldown system, damage tables, crits, knockback, i-frames, armor reduction), death/drops/XP orbs, and procedural box-model rendering + animation for every mob. Baseline: Java Edition ~1.20, difficulty **Normal** (hard-coded). Cross-refs: entity base class, physics integration, voxel raycast utility, and entity-entity pushing live in **01-ARCHITECTURE**; worldgen passive herds in **02-WORLD-GENERATION**; player physics constants (gravity 0.08/0.98, jump 0.42, fire damage) in **03-PLAYER**; light values, sky-light logic and day/night state in **04-TIME-LIGHT-WEATHER**; item registry, tool/armor tiers + durability, food, and block blast-resistance values in **06-ITEMS-CRAFTING-SURVIVAL**. All audio is **out of scope** for the whole project — no mob idle/hurt/step sounds anywhere in this file.

## Contents

1. [Conventions & shared mob constants](#1-conventions--shared-mob-constants)
2. [Mob roster — stat blocks](#2-mob-roster--stat-blocks)
3. [Spawning](#3-spawning)
4. [Despawning](#4-despawning)
5. [Daylight burning & light-driven hostility](#5-daylight-burning--light-driven-hostility)
6. [AI architecture — goal system](#6-ai-architecture--goal-system)
7. [Pathfinding — A* over the voxel grid](#7-pathfinding--a-over-the-voxel-grid)
8. [Hostile mob behaviors](#8-hostile-mob-behaviors)
9. [Passive mob behaviors](#9-passive-mob-behaviors)
10. [Breeding & babies](#10-breeding--babies)
11. [Arrow projectile](#11-arrow-projectile)
12. [Explosions (creeper)](#12-explosions-creeper)
13. [Player combat math](#13-player-combat-math)
14. [Damage pipeline, i-frames, knockback, armor](#14-damage-pipeline-i-frames-knockback-armor)
15. [Death, drops & XP orbs](#15-death-drops--xp-orbs)
16. [Mob rendering & animation](#16-mob-rendering--animation)
17. [Damage feedback](#17-damage-feedback)
18. [Acceptance checklist](#acceptance-checklist)

---

## 1. Conventions & shared mob constants

- 1 block = 1 m. 20 ticks/s. Damage in HP points (1 heart = 2 HP). All damage values below are **Normal** difficulty.
- Every mob extends the `Entity`/`LivingEntity` base from 01. Gravity identical to the player (03): `vy -= 0.08; vy *= 0.98` per tick. Jump: `vy = 0.42` (only when `onGround`).
- Mob locomotion contract (with 01's integrator):

```js
// Each tick the active goal writes mob.moveIntent = {dirX, dirZ} (unit) and mob.moveSpeed (b/t).
// Locomotion applied BEFORE 01's collision sweep:
if (onGround)  { vx = vx*0.5 + dir.x*speed*0.5;  vz = vz*0.5 + dir.z*speed*0.5; }
else           { vx += dir.x*speed*0.05;         vz += dir.z*speed*0.05; }        // weak air control
if (inWater)   { if (submergedBelowSurface) vy += 0.04;  vx*=0.8; vz*=0.8; }      // buoyant bobbing
```

> Adaptation: MC drives mobs through attribute-based acceleration + slipperiness; we use the direct velocity-blend above. Speeds in §2 are hand-tuned to match observed MC gameplay pacing and are marked `(approx)`; the raw MC `movement_speed` attribute is listed for reference.

- Body yaw turns toward movement direction at max 30°/tick (hostiles turn toward target at max 30°/tick while attacking). Head yaw is independent, clamped ±75° from body yaw (§16).
- Mobs push each other and get pushed by the player per 01's entity-overlap resolution.
- **Simulation range** `(approx)`: mobs farther than 64 blocks from the player skip AI (goals, pathfinding, target scan) but keep physics; ≤64 blocks: full AI. Perf guard consistent with despawn rules in §4.
- RNG: use the world-seeded PRNG from 01; `rand()` = float [0,1), `randInt(n)` = integer [0,n).

**Per-mob tick order** (inside 01's entity update, after the world tick):

```
1. timers: invulnTicks--, hurtTime--, attackCooldown--, idleTime++, eggTimer--, breedCooldown--, loveTicks--
2. environment: daylight-burn check (§5, every tick), fire tick (03), water contact (enderman §5)
3. despawn check (§4) — may remove the mob, stop here
4. AI: updateTarget() + goal selector (§6) → writes moveIntent/moveSpeed/jump/look
5. locomotion blend (§1) + gravity + 01 collision sweep (sets onGround/horizontalCollision/inWater)
6. spider climb override (§7), creeper swell counter (§8.3), enderman teleport reactions (§8.5)
7. death progression: if dead, deathTime++ → remove at 20
```

**Persisted fields** (mob save data, format per 01's save system): `type, pos, vel, yaw, health, persistent, isBaby, ageTicks (maturity countdown), breedCooldown, loveTicks, sheared, woolTint, eggTimer, swell (creeper), aggro (enderman), sourceless timers may reset on load (idleTime, attackCooldown)`.

## 2. Mob roster — stat blocks

Movement speeds: `walk` is used by wander/idle goals, `chase` by attack/panic-type goals (per-goal multipliers noted in behavior sections). Per-tick value = b/s ÷ 20.

### Hostile

| Stat | Zombie | Skeleton | Creeper | Spider | Enderman |
|---|---|---|---|---|---|
| HP | 20 | 20 | 20 | 16 | 40 |
| AABB (w×h, m) | 0.6×1.95 | 0.6×1.99 | 0.6×1.7 | 1.4×0.9 | 0.6×2.9 |
| Natural armor pts | 2 | 0 | 0 | 0 | 0 |
| MC speed attr | 0.23 | 0.25 | 0.25 | 0.30 | 0.30 |
| Walk/chase b/s (approx) | 2.4 / 2.4 (0.12 b/t) | 2.6 / 2.6 (0.13) | 2.6 / 2.6 (0.13) | 3.4 / 3.4 (0.17) | 2.8 / 6.0 aggro (0.14/0.30) |
| Attack dmg (Normal) | 3 | ranged 1–4 per arrow (§11) | explosion ≤43 (§12) | 2 | 7 |
| Attack reach (center-to-center) | 2.0 | — (bow 15) | — | 2.0 | 2.5 |
| Melee cooldown | 20 ticks | — | — | 20 ticks | 20 ticks |
| Detection range | **35** | 16 (shoots ≤15) | 16 | 16 | 64 (stare) / 16 (post-aggro reacquire) |
| XP on death | 5 (baby: 12) | 5 | 5 | 5 | 5 |
| Burns in daylight | yes (baby: no) | yes | no | no (goes neutral) | no (teleports away; hurt by water/rain) |

Drops (player-caused death, no Looting — Looting is **skipped**, state per §15):

| Mob | Drops |
|---|---|
| Zombie | 0–2 rotten flesh (uniform). 2.5% chance: 1 carrot or 1 potato (50/50, per 06 §7.3). Rare drop (iron ingot): **skipped**. |
| Skeleton | 0–2 bones, 0–2 arrows (independent uniform rolls). Bow/armor equipment drops: **skipped**. |
| Creeper | 0–2 gunpowder. Music discs: **skipped**. No drops if it explodes (it dies by removal, not kill). |
| Spider | 0–2 string. Spider eye: **skipped** (not in 06 registry). |
| Enderman | 0–1 ender pearl. |

Special traits: zombie — 5% spawn as **baby** (0.5× model scale, hitbox 0.3×0.975, speed ×1.5 = 3.6 b/s, immune to daylight burning, XP 12, drops unchanged). Skeleton — strafing archer, flees sunlight when burning. Creeper — silent approach, fuse/swell, no fire from its explosion. Spider — climbs walls, hostile only in low light, leap attack. Enderman — neutral until stared at/attacked, teleports, screams (visual shake only; audio out of scope).

### Passive

| Stat | Cow | Pig | Sheep | Chicken |
|---|---|---|---|---|
| HP | 10 | 10 | 8 | 4 |
| AABB (w×h, m) | 0.9×1.4 | 0.9×0.9 | 0.9×1.3 | 0.4×0.7 |
| Baby AABB | 0.45×0.7 | 0.45×0.45 | 0.45×0.65 | 0.2×0.35 |
| MC speed attr | 0.20 | 0.25 | 0.23 | 0.25 |
| Walk b/s (approx) | 1.8 (0.09 b/t) | 1.8 | 1.8 | 1.8 |
| Panic multiplier (MC exact) | ×2.0 | ×1.25 | ×1.25 | ×1.4 |
| Tempt/breed multiplier | ×1.1 (approx) | ×1.1 | ×1.1 | ×1.1 |
| Breeding food (06 items) | wheat | carrot | wheat | wheat seeds |
| XP on death | 1–3 | 1–3 | 1–3 | 1–3 |
| Drops | 1–3 beef, 0–2 leather | 1–3 porkchop | 1–2 mutton, 1 wool_white (0 if sheared) | 1 chicken, 0–2 feathers |

Baby animals drop nothing and give 0 XP. Fire-cooked drop variants (killed while burning): **skipped**. Passive mobs never despawn (§4) and never attack. Cow milking with bucket: right-click hook → 06 (implement only if 06 defines buckets).

## 3. Spawning

### 3.1 Passive mobs — worldgen only

Passive mobs spawn **exclusively** as worldgen herds when chunks generate (herd sizes/biomes per 02) and via breeding (§10) and chicken eggs (§9.4). They are created with `persistent = true` and are exempt from every despawn rule. There is **no** runtime passive spawn cycle and no passive mob cap.

### 3.2 Hostile runtime spawn cycle

MC attempts hostile spawns **every tick per eligible chunk** with a global monster cap of **70** (Java, single player).

> Adaptation: one spawn **wave every 20 ticks** (1/s), sampling random columns in an annulus around the player instead of iterating chunks. Hostile cap **40** (MC: 70) — hard cap on live hostiles, checked at wave start and per spawned mob.

```js
SPAWNABLE_BELOW = { grass_block, dirt, stone, sand, gravel, cobblestone, /* + any opaque
                    full-cube terrain block in 06's registry EXCEPT glass and leaves */ };

function hostileSpawnWave() {                       // every 20 ticks
  if (hostileCount >= 40) return;
  for (let i = 0; i < 8; i++) {                     // 8 column attempts per wave
    const ang = rand()*2*PI, d = 24 + rand()*72;    // annulus 24..96 blocks
    const x = floor(player.x + cos(ang)*d), z = floor(player.z + sin(ang)*d);
    if (!chunkLoaded(x, z)) continue;
    const y = 1 + randInt(heightmap(x, z));         // random Y up to highest solid → caves included
    if (!validSpawnPos(x, y, z, species=null)) continue;
    const species = weightedPick(SPAWN_WEIGHTS);
    let packSize = (species == 'enderman') ? 1 + randInt(2) : 1 + randInt(4);   // 1–2 / 1–4
    let spawned = 0, px = x, pz = z;
    for (let k = 0; k < packSize*2 && spawned < packSize && hostileCount < 40; k++) {
      px += randInt(6) - randInt(6);  pz += randInt(6) - randInt(6);            // ±5 random walk
      if (validSpawnPos(px, y, pz, species)) { spawnMob(species, px+0.5, y, pz+0.5); spawned++; }
    }
    if (spawned > 0) return;                        // max one successful pack per wave
  }
}

function validSpawnPos(x, y, z, species) {
  if (!(blockAt(x, y-1, z) in SPAWNABLE_BELOW)) return false;
  if (solidOrLiquid(x, y, z) || solidOrLiquid(x, y+1, z)) return false;   // 2-block clearance
  if (species == 'enderman' && solid(x, y+2, z)) return false;           // 3 tall
  if (species == 'spider')                                                // 1.4 wide → 3×1×3 area
    for (dx of [-1,0,1]) for (dz of [-1,0,1]) if (solidOrLiquid(x+dx, y, z+dz)) return false;
  if (!canSpawnHostileAt(x, y, z, rng)) return false;   // 04 §10.1 verbatim: blockLight==0, sky>rand(32) reject, max(blockLight, (thundering?min(sky,10):sky)−skyDarken) <= rand(0..7)
  if (distToPlayer(x+0.5, y, z+0.5) < 24) return false;                   // Euclidean, MC exact
  return true;
}
```

Spawn weights (MC exact, standard Overworld biome): **zombie 95, skeleton 100, creeper 100, spider 100, enderman 10** (total 405 → ≈23.5% / 24.7% / 24.7% / 24.7% / 2.5%). Pack members spawn at the **same Y** as the pack origin (MC behavior); the ±5 random walk mirrors MC's pack-position drift.

Notes:
- The 04 §10.1 predicate makes the surface-vs-cave distribution emerge naturally. No extra logic needed.
- Zombie baby roll (5%) happens inside `spawnMob`.
- Mobs spawn facing a random yaw; skeletons spawn holding a bow (visual only, not an inventory item).
- Spawn-cap bookkeeping: `hostileCount` increments on hostile spawn, decrements on any removal.

## 4. Despawning

Checked per hostile mob per tick (MC-exact rules; passive mobs and anything with `persistent = true` are exempt):

| Rule | Condition | Action |
|---|---|---|
| Instant | distance to player > 128 (Euclidean) | remove immediately |
| Random | distance > 32 AND `idleTime > 600` | 1/800 chance per tick to remove |
| Reset | mob takes damage or targets a player | `idleTime = 0` |

`idleTime` increments every tick the mob is >32 blocks from the player. Removal via despawn drops nothing and gives no XP.

## 5. Daylight burning & light-driven hostility

**Zombies and skeletons ignite at dawn.** Exact condition, evaluated once per tick per undead mob (04 §10.2), all terms per 04:

```
burnsNow(mob) per 04 §10.2 — isDay AND canSeeSky(mobEyePos) AND !mob.inWater AND !isRainingAt(mob.pos)
  → mob.setOnFire(8 seconds)   // 160 ticks of fire
```

Fire tick damage per 03's fire rules (1 HP per 20 ticks while burning; extinguished by water). Baby zombies do **not** burn. Helmet-blocks-burning: **skipped** (mobs wear no armor items in this build).

**Creepers and spiders do not burn.** **Endermen do not burn**; instead, in daylight (`isDay AND skyExposed`) a non-aggro enderman attempts a random teleport (§8.5) with probability 1/100 per tick, and any enderman touching water or standing in rain takes 1 HP per 20 ticks `(approx — MC hurts 1/tick gated by i-frames)` and immediately attempts a random teleport.

**Spider neutrality switch (MC exact):** a spider only *acquires* a player target when the combined light level at the spider's position is ≤ 11. If light > 11 it is neutral. If a chasing spider enters light > 11 it drops its target — *unless* the aggro came from retaliation (it was hit), in which case it stays hostile regardless of light. On aggro loss a spider keeps walking straight ahead for 40 ticks (this makes it climb walls in its path — faithful quirk, keep it).

## 6. AI architecture — goal system

Each mob owns a **priority-ordered goal list** (0 = highest). Two mutex flags: `MOVE` and `LOOK`. Every tick:

```js
mob.updateTarget();                       // target acquisition/give-up, below
for (goal of mob.goals) {                 // ascending priority number
  if (goal.active) {
    if (goal.shouldContinue()) { goal.tick(); claim(goal.flags); }
    else { goal.stop(); goal.active = false; }
  } else if (!claimed(goal.flags) && goal.canStart()) {
    goal.start(); goal.active = true; goal.tick(); claim(goal.flags);
  }
}
```

A goal only starts if no active/started goal this tick already claimed one of its flags. `LOOK`-only goals (look-at-player, idle-look) can run alongside `MOVE` goals. Re-evaluate `canStart` for inactive goals every tick (cheap checks only; expensive checks are throttled inside the goal).

**Target acquisition (hostiles).** Every 10 ticks: candidate = the player, if `dist ≤ detectionRange` (×0.8 if player sneaking `(approx)`) AND line-of-sight. LOS = voxel raycast (01's DDA) from mob eye to player eye, blocked by opaque blocks only (water/glass/leaves pass). Spider adds the light gate (§5); enderman uses its own trigger (§8.5); creeper requires LOS for its swell but targets normally.

**Give-up rules:** drop target when target is dead, `dist > detectionRange × 1.5` `(approx — MC uses follow-range check)`, or LOS lost for 100 consecutive ticks. Being damaged by the player always sets the player as target (all hostiles + retaliating spider/enderman) and resets the LOS-memory timer.

**Goal lists** (priority: goal — flags):

```
Zombie / baby zombie:
  0 Swim(MOVE)  2 MeleeAttack(MOVE)  5 Wander(MOVE)  7 LookAtPlayer(LOOK,8)  8 IdleLook(LOOK)
Skeleton:
  0 Swim  1 FleeSun(MOVE)  2 BowAttack(MOVE)  5 Wander  7 LookAtPlayer(8)  8 IdleLook
Creeper:
  0 Swim  1 Swell(MOVE)  2 Chase(MOVE)  5 Wander  7 LookAtPlayer(8)  8 IdleLook
Spider:
  0 Swim  2 LeapAtTarget(MOVE)  3 MeleeAttack(MOVE)  5 Wander  7 LookAtPlayer(8)  8 IdleLook
Enderman:
  0 Swim  1 StareDown(MOVE+LOOK)  2 MeleeAttack(MOVE)  5 Wander  7 LookAtPlayer(8)  8 IdleLook
  + event-driven teleports outside the goal system (§8.5)
Cow / Pig:
  0 Swim  1 Panic(MOVE)  2 Breed(MOVE)  3 Tempt(MOVE)  4 FollowParent(MOVE, baby only)
  5 Wander  6 LookAtPlayer(6)  7 IdleLook
Sheep: same as cow + `5 EatGrass(MOVE)` (wander shifts to 6, looks to 7/8)
Chicken: same as cow (egg laying is a timer, not a goal)
```

**Shared goal definitions:**

- `Swim` — canStart: `inWater`. tick: buoyancy is already in locomotion (§1); this goal only claims nothing and forces jump-hop at water surface each 10 ticks so mobs don't sink. Never blocks other goals (implement as a passive flag rather than a mutex claimer).
- `Wander` — canStart: 1/120 chance per tick. start: pick random reachable point within 10×7×10 (random offset, snapped down to standable); path to it at walk speed. shouldContinue: path unfinished and < 300 ticks elapsed.
- `LookAtPlayer(r)` — canStart: player within `r`, 1/50 chance per tick. tick: face head toward player eye. Duration 40–80 ticks.
- `IdleLook` — canStart: 1/50 chance per tick. Pick a random yaw; look at it for 20–40 ticks.
- `MeleeAttack` — canStart: has target. tick: repath to target per §7 cadence at chase speed; if `centerDist ≤ reach` AND `attackCooldown == 0` AND LOS: deal damage (§14, mob→player), apply knockback 0.4 to target, set `attackCooldown = 20`, swing arm (§16). Decrement cooldown every tick.
- `Panic` — canStart: `hurtTimer > 0` (set 100 ticks on damage). tick: run at panic speed to a random point 5–8 blocks away, re-picking on arrival; continue until timer expires.
- `Tempt` — canStart: player within **10** blocks holding this species' breeding food. tick: path to player at ×1.1 speed, stop at 2.5 blocks and stare. Give up if player > 12 away.
- `FollowParent` — baby only: canStart: nearest adult of species within 16 and baby > 3 away. tick: path to adult at ×1.1.
- `Breed`, `EatGrass`, `Swell`, `BowAttack`, `FleeSun`, `LeapAtTarget`, `StareDown`: §8–§10.

## 7. Pathfinding — A* over the voxel grid

A node is a **standable cell**: `solid(x, y-1, z) && !solidOrLiquid(x, y, z) && !solidOrLiquid(x, y+1, z)` (wide mobs — spider — additionally require their 3×1×3 footprint clear; 3-tall enderman requires y+2 clear).

```js
function findPath(start, goal, maxRange = 32, maxNodes = 512) {
  // start/goal: standable cells (snap entity feet to cell; snap goal down ≤4 to standable, else fail)
  open = minheap by f = g + h;  h = euclidean(node, goal);
  push(start, g=0);
  while (open not empty && expanded < maxNodes) {
    n = pop(open); expanded++;
    if (n == goal || euclidean(n, goal) < 0.8) return reconstruct(n);
    if (euclidean(n, start) > maxRange) continue;
    for (dir of [+X, -X, +Z, -Z]) {                    // 4-connected; diagonals: SKIPPED
      c = n + dir;
      if (standable(c))              relax(c, g + 1.0);            // walk
      else if (standable(c.up(1))    // step up 1: also need headroom above n
               && !solid(n.x, n.y+2, n.z))
                                     relax(c.up(1), g + 1.5);      // jump-up
      else {                                                        // fall 1..3
        for (drop = 1; drop <= 3; drop++)
          if (standable(c.down(drop))) { relax(c.down(drop), g + 1.0 + drop*0.5); break; }
          else if (solidOrLiquid(c.x, c.y-drop, c.z)) break;
      }
      // cost penalties: cell adjacent to lava/fire +16 (avoid); water cell +4 (swimmable but slow)
    }
  }
  return partialPathToClosest(h);   // best-effort path toward goal
}
```

**Repath cadence:** while chasing — repath if target moved ≥ 1 block from the path's goal cell AND ≥ 10 ticks since last A*; otherwise refresh every 40 ticks. Also repath on stall (< 0.5 blocks progress over 20 ticks). Global budget: max 2 full A* runs per tick, round-robin queue for the rest (mobs keep following their stale path meanwhile).

**Path following (steering):** current waypoint = next node center `(x+0.5, y, z+0.5)`. Set `moveIntent` toward it at goal speed. Waypoint reached when horizontal distance < 0.35 → advance. If waypoint is 1 higher and horizontal distance < 1.4 → jump (`vy = 0.42`). If `horizontalCollision && onGround` → jump (bump-jump insurance).

**Fallback direct steer:** if A* fails (no path / budget starved) and the mob has a target: steer straight at the target, bump-jumping obstacles, for up to 60 ticks before retrying A*. This is also the permanent mode for the spider when its target is above it (below).

> Adaptation: **Spider wall-climb.** No climb pathfinding. Rule: while a spider has a target (or its 40-tick post-aggro forward-walk is active) and it is `horizontalCollision`-ing against a block, set `vy = 0.2` that tick (exactly MC's climb velocity). Result: it slides up any wall it runs into while chasing. While climbing, gravity still applies (0.2 net wins); no fall damage for spiders climbing is NOT special-cased — spiders take normal fall damage. Spiders never climb ceilings.

## 8. Hostile mob behaviors

### 8.1 Zombie

Goals per §6. Chases anything it targets (players only in this build — villagers don't exist) across its 35-block detection. Melee: 3 dmg, reach 2.0, 20-tick cooldown. Door breaking: **skipped** (no doors interaction). Zombie reinforcements: **skipped**. Picks up items: **skipped**. Burns per §5.

### 8.2 Skeleton

`FleeSun` (priority 1): canStart — `onFire && isDay && skyExposed(pos)`. start: sample 10 random standable cells within 10×5×10; pick the first with `skyExposed == false` (or in water); path there at ×1.0. shouldContinue: still on fire and path unfinished.

`BowAttack` (priority 2), MC-verified parameters — chase range 16, **shoot range 15**, fire interval **60 ticks on Normal** (3 s; Hard would be 40 — unused), min draw before release 20 ticks:

```js
tick():
  d = dist(self, target); sees = LOS(target);
  seeTime = sees ? seeTime+1 : 0;
  if (d > 15 || seeTime < 5)      path to target at chase speed;      // approach until in range
  else {
    stopPath();
    // strafing: lateral direction flips randomly
    if (++strafeTimer >= 20 && rand() < 0.3) { strafeDir *= -1; strafeTimer = 0; }
    back = (d < 11.25) ? -0.5 : 0;                                    // 75% of range: back off
    moveIntent = rotate(dirToTarget, 90°*strafeDir)*0.5 + dirToTarget*back;  // normalized, speed ×0.6
    faceTarget();
  }
  if (--attackTimer <= 0 && sees && d <= 15) {
    drawTicks++;                                                       // bow-draw pose (§16)
    if (drawTicks >= 20) { shootArrow(); drawTicks = 0; attackTimer = 60; }
  }

shootArrow():                       // §11 for projectile physics
  speed = 1.6 b/t
  aim   = targetCenter - selfEye;  aim.y += horizontalDist(self,target) * 0.2;   // gravity compensation
  dir   = normalize(aim); each axis += gaussian() * 0.0172275 * 6;               // Normal inaccuracy = 6
  spawn Arrow(pos = selfEye, velocity = dir * speed, owner = skeleton)
```

Skeleton arrows cannot be picked up by the player. Skeletons flee-sun burns per §5; while burning they still shoot if the flee goal can't find shade.

### 8.3 Creeper

Chase goal approaches the target like a melee mob but never lands a melee hit. Detection 16 (14 vs sneaking player — covered by the ×0.8 sneak factor).

`Swell` (priority 1) — MC-verified: swell **starts** when target within **3** blocks with LOS; fuse charges toward 30; it **discharges** (counts back down, does not snap-reset — Java behavior) when target is farther than **7** blocks OR LOS is broken; **explodes at swell == 30**:

```js
canStart(): target != null && dist(target) < 3 && LOS(target)
shouldContinue(): swell > 0 || canStart()
tick():
  swellDir = (target && dist(target) <= 7 && LOS(target)) ? +1 : -1;
  swell = clamp(swell + swellDir, 0, 30);
  moveIntent = 0;  faceTarget();          // creeper stands still while swelling
  if (swell == 30) explode(power = 3);    // §12; creeper removed, NO drops, NO fire
```

Swell drives the inflate/flash animation (§16). Knocking the creeper back >7 blocks or breaking LOS aborts (fuse drains). If the creeper dies before swell 30, normal death + drops. Charged creepers: **skipped** (no lightning-charge variant).

Fall-swell quirk (`fallDistance × 1.5` added to swell on landing): **skipped**.

### 8.4 Spider

Hostility gate per §5 (light ≤ 11). Detection 16. Melee 2 dmg, reach 2.0 (wide body), cooldown 20.

`LeapAtTarget` (priority 2), MC-exact: canStart — has target, `onGround`, horizontal distance in [2, 4], 20% roll per tick. start (single impulse):

```js
v = normalize(horizontal(target.pos - self.pos)) * 0.4 + self.velocity * 0.2;
self.velocity = { x: v.x, y: 0.4, z: v.z };     // pounce
```

Wall-climb per §7 adaptation. Post-aggro 40-tick forward walk per §5. Spiders take no special fall handling.

### 8.5 Enderman

Neutral 40-HP giant. **Provocation** (either):
1. **Stare**: player within **64** blocks, for **5 consecutive ticks**: `dot(playerViewDir, normalize(endermanEye − playerEye)) > 1 − 0.025/dist` AND LOS (voxel raycast). (Carved-pumpkin exemption: **skipped** — no pumpkin wearing.)
2. Player damages it.

While being stared at but not yet provoked (`ticks 1–4`) and during the first 10 ticks of provocation, `StareDown` goal: freeze (`moveIntent = 0`), face the player, play the shake animation (§16). On provocation it "screams" (shake + jaw-open texture swap; audio out of scope) and becomes aggro: chase at **6.0 b/s** with MeleeAttack (7 dmg, reach 2.5, cooldown 20).

```js
// stare detection — run every tick for endermen within 64 blocks of the player
toEnd = endermanEyePos - playerEyePos;  d = len(toEnd);
staring = d <= 64
       && dot(playerViewDir, toEnd/d) > 1 - 0.025/d       // crosshair on the head
       && voxelRaycastClear(playerEye, endermanEye);       // opaque blocks break the stare
stareTicks = staring ? stareTicks + 1 : 0;
if (stareTicks >= 5 && !aggro) { aggro = true; screamTicks = 10; target = player; }
```

**Teleportation.** `tryTeleport(randomly)`:

```js
function teleportRandom(mob):            // up to 16 attempts
  for (i = 0; i < 16; i++) {
    tx = mob.x + (rand()-0.5)*64;  ty = mob.y + (rand()-0.5)*32;  tz = mob.z + (rand()-0.5)*64;
    // seek down ≤16 blocks for a standable 3-tall, non-liquid cell
    c = seekDownStandable(floor(tx), clamp(floor(ty),1,126), floor(tz), 16, height=3);
    if (c && !liquidAt(c)) { spawnTeleportParticles(both ends); mob.setPos(c center); return true; }
  }
  return false;
```

Teleport triggers (MC-faithful set):
- **On any damage taken** (after the damage applies): random teleport. If the damage source is a projectile, teleport **before** impact resolution — the arrow is treated as a miss (no damage, arrow keeps flying). Roll this dodge whenever an arrow's swept path would intersect the enderman's AABB.
- **Water/rain contact** damage tick (§5): random teleport.
- **Daylight** idle: 1/100 per tick when non-aggro (§5); on success also clears any target.
- **While aggro**: if no LOS to target for ≥ 40 ticks, or target beyond reach for ≥ 60 ticks: teleport **near the target** — same routine but centered on the target with ±8/±4/±8 spread `(approx of MC's 9×11×9 attack teleport)`.
- Give-up: aggro ends if the target is lost for 800 ticks or the enderman despawn-range rules remove it. In daylight, aggro endermen additionally have a 1/500 per-tick chance to disengage (teleport away + clear target) `(approx of MC's 20–30 s disengage attempts)`.

Block pickup/placement: **skipped** — state it, the spook is preserved via stare + teleports.

## 9. Passive mob behaviors

All passives: Panic on hurt (speed multipliers §2), Tempt toward held breeding food (10-block notice), Wander, no attacks, never despawn. Fall damage applies (chicken exempt, below).

### 9.1 Cow
Wanders, flees when hit (×2.0 speed — fastest panic). Milking hook per §2.

### 9.2 Pig
Wanders, panics ×1.25. Tempted by carrot. Saddle/riding: **skipped**.

### 9.3 Sheep
`EatGrass` goal (priority 5): canStart — random roll (MC: 1/500 per 2 ticks adult, 1/25 baby → build target: **1/1000 per tick adult, 1/50 per tick baby**, same rate) AND the block below is `grass_block` or the block at feet is `short_grass` (if 02 generates it). tick: 40-tick head-down eating animation (§16); at tick 40: eaten block → `grass_block` becomes `dirt` (regrows per 06 §5.15) or grass plant removed; then `sheared = false` (wool regrows) and babies reduce maturity timer by 1200 ticks.

**Shearing:** right-click with shears (if 06 defines shears): if `!sheared && adult` → drop 1–3 wool_white items, set `sheared = true`, shears lose 1 durability. If 06 omits shears, wool comes only from kills. Sheared sheep render without wool overlay (§16).

**Color:** spawn tint distribution (MC exact): white 81.836%, black 5%, gray 5%, light gray 5%, brown 3%, pink 0.164%.
> Adaptation: color is a **render tint only**; the dropped item is always `wool_white` (06 id 46; other wool colors are debug-palette only). Dyeing sheep: skipped.

### 9.4 Chicken
- **Slow fall**: every tick while `vy < 0`: `vy *= 0.6`; chickens take **no fall damage**.
- **Egg laying**: per adult chicken, `eggTimer = 6000 + randInt(6001)` ticks (5–10 min, MC exact); on expiry drop an `egg` item entity at its position and reset the timer.
- Panics ×1.4; tempted by wheat seeds. Egg-throw spawning chicks: hook for 06 (1/8 chance) — optional, not required here.

## 10. Breeding & babies

MC-verified flow:

1. Right-click an **adult** with its breeding food (consumes 1 item) → **love mode** for 600 ticks (30 s), unless `breedCooldown > 0`. Heart particles (small red quads floating up, 1 every 10 ticks) while in love.
2. A mob in love scans every 10 ticks for the nearest same-species adult in love within **8 blocks**; both set each other as mates and path together at ×1.1 speed.
3. When mates are within 1.5 blocks for **60 ticks** (≈ MC's ~2.5 s "kiss"): spawn a **baby** at the midpoint, drop an XP orb worth **1–7** (uniform), both parents: love off, `breedCooldown = 6000` ticks (5 min, MC exact).
4. Love mode expires after 600 ticks without breeding (can be re-fed immediately, MC exact).

```js
// Breed goal (priority 2) — runs on each parent while loveTicks > 0
canStart(): loveTicks > 0
tick():
  if (!mate || mate.loveTicks <= 0)
    mate = nearestSameSpecies(adult && inLove, range 8);         // rescan every 10 ticks
  if (!mate) { wanderInPlace(); return; }
  pathTo(mate, speed ×1.1);
  if (dist(mate) < 1.5 && ++kissTicks >= 60) {
    baby = spawnMob(species, midpoint(self, mate), { isBaby: true, ageTicks: 6000 });
    spawnXPOrb(midpoint, 1 + randInt(7));                        // 1–7 XP
    for (p of [self, mate]) { p.loveTicks = 0; p.breedCooldown = 6000; p.mate = null; }
  }
stop(): kissTicks = 0
```

**Babies:** 0.5× model scale (§16), half hitbox (§2), follow nearest adult (goal §6), can't be bred or sheared, drop nothing.
- Maturity: MC is 24000 ticks (20 min). > Adaptation: **6000 ticks (5 min)** build target.
- Feeding a baby its species food consumes the item and reduces remaining maturity by 10% (MC exact). Baby sheep grass-eating −1200 ticks (§9.3).

## 11. Arrow projectile

One arrow entity class serves player bows and skeletons. MC-verified physics:

| Property | Value |
|---|---|
| Entity size | 0.5×0.5 AABB (render: 1×5×1 px fletched stick, §16) |
| Gravity | −0.05 b/t² (applied to `vy` per tick) |
| Drag | ×0.99 per tick (×0.6 in water) |
| Initial speed | player bow: `3 × charge` b/t; skeleton: 1.6 b/t; max ~3.03 with jitter |
| Inaccuracy | dir += gaussian × 0.0172275 × inacc per axis; player = 1, skeleton (Normal) = 6 |
| Lifetime stuck in block | 1200 ticks, then remove |
| Lifetime in flight | 1200 ticks safety cap |

**Bow charge (player, MC exact):** while right-mouse held, `t` ticks: `f0 = t/20; charge = clamp((f0² + 2·f0)/3, 0, 1)`. Release fires if `charge ≥ 0.1`. `charge == 1` (≥ 20 ticks) → **critical arrow** (particle trail). Bow item/durability/arrows-as-ammo per 06.

**Per-tick integration & collision:**

```js
// order: collide → move → drag/gravity (MC order)
hitBlock  = raycastDDA(pos, pos + v);                       // 01's voxel raycast
hitEntity = closest entity whose AABB (inflated 0.3) intersects segment [pos, pos+v],
            excluding owner for first 5 ticks;
if (hitEntity before hitBlock):
    dmg = ceil(len(v) * 2);                                 // base damage 2 per b/t of speed
    if (critArrow) dmg += randInt(dmg/2 + 2);               // full-charge bonus → 6–11 total
    dealDamage(hitEntity, dmg, source=owner);  knockback 0.4 along v; remove arrow;
else if (hitBlock): pos = hitPoint; v = 0; stuck = true;    // sticks; keeps yaw/pitch
else: pos += v;  v *= 0.99;  v.y -= 0.05;
yaw/pitch from v (arrow renders along velocity)
```

**Pickup:** a stuck arrow fired by the **player** is collected on player-AABB contact (+1 `arrow` item, per 06 inventory). Skeleton arrows are never collectible (MC exact) — render them slightly darker. Damage numbers: full-charge player arrow 6–11 (avg ≈ 8); skeleton point-blank max 4, decaying with distance (drag). Endermen dodge arrows per §8.5.

## 12. Explosions (creeper)

Creeper explosion **power = 3**. No fire. Max entity damage range = 2×power = 6 blocks; max block-destruction reach ≈ 4/3×power ≈ 4 (up to ~5.1 with the random factor).

### 12.1 Real MC block-destruction algorithm (reference)

Rays from the explosion center toward the 1352 outer points of a 16×16×16 grid spanning the unit cube (i.e., directions `((j/15)·2−1, (k/15)·2−1, (l/15)·2−1)` for all boundary j,k,l, normalized). Per ray: `intensity = power × (0.7 + 0.6·rand())` (range 0.7–1.3 × power). Step 0.3 blocks along the ray; at each step: if the block isn't air, `intensity −= (blastResistance + 0.3) × 0.3`; if intensity still > 0, mark the block destroyed; then `intensity −= 0.22500001`; stop when ≤ 0.

### 12.2 Block destruction — build target

> Adaptation: **sphere-with-falloff** (no rays, no occlusion shadowing — accepted inaccuracy). For every block within Euclidean distance `r ≤ 1.3·power + 0.6` of the center: destroy it iff
> `power · (0.7 + 0.6·rand()) · (1 − r / (1.3·power))  >  (blastResistance(block) + 0.3) · 0.3`.
> Blast resistance values from 06 (stone 6, dirt 0.5, sand 0.5, logs/planks 3, obsidian 1200, water/lava 100 — water never breaks and, if the center block is water, skip block destruction entirely). Calibration: crater radius ≈ 1.5–2 in stone, ≈ 3.5–4 in dirt/sand — matches MC power-3 craters.

**Drops from destroyed blocks (MC exact):** each destroyed block drops its item **with probability 1/power = 1/3**, as if mined by a diamond tool (drop tables per 06). Spawn item entities at block centers with the §15 scatter velocity.

### 12.3 Entity damage & knockback (MC-exact formulas — build target as-is)

For every entity within distance `< 2·power` of center `E`:

```js
exposure = fraction of sample points on the entity AABB with an unobstructed voxel
           raycast to E.  > Adaptation: sample the 8 AABB corners + center (9 rays)
           instead of MC's 0.5-block grid.
impact   = (1 − distance/(2·power)) · exposure;                    // distance: E → entity center
damage   = floor((impact² + impact) / 2 · 7 · (2·power) + 1);      // Normal difficulty (no scaling)
knockbackVelocity += normalize(entityCenter − E) · impact;         // b/t, added to velocity
```

Point-blank fully-exposed cap at power 3: `(1+1)/2 · 7 · 6 + 1 = 43 HP` (**verified** — the prompt's ~49 is wrong for Normal; Easy 22.5 / Normal 43 / Hard 64.5). Armor reduces it per §14 and chews durability. The exploding creeper is removed before damage is dealt (never damages itself). i-frames apply normally to victims.

## 13. Player combat math

The player owns 1.9-style cooldown combat. Tool damage/attack-speed live **here**; tier progression + durability live in 06.

### 13.1 Attack cooldown (MC exact)

- `T = 20 / attackSpeed` ticks (full-charge time; keep fractional, don't round).
- `t` = ticks since last attack **or main-hand item switch** (block-breaking reset: **skipped** — item switch and attacking only).
- Charge `p = clamp((t + 0.5)/T, 0, 1)`. HUD indicator per 03 displays `clamp(t/T, 0, 1)`.
- **Damage dealt = baseDamage × (0.2 + 0.8·p²)**, then crit ×1.5 if applicable. Attacking is always allowed; low charge just scales damage down (min 20%).

### 13.2 Weapon tables (Java 1.20 exact)

Attack damage (HP):

| Item | Wood | Gold | Stone | Iron | Diamond |
|---|---|---|---|---|---|
| Sword | 4 | 4 | 5 | 6 | 7 |
| Axe | 7 | 7 | 9 | 9 | 9 |
| Pickaxe | 2 | 2 | 3 | 4 | 5 |
| Shovel | 2.5 | 2.5 | 3.5 | 4.5 | 5.5 |
| Hoe | 1 | 1 | 1 | 1 | 1 |
| Hand / any other item | 1 | | | | |

Attack speed (attacks/s) and `T`:

| Item | Speed | T (ticks) |
|---|---|---|
| Hand, any non-tool | 4.0 | 5 |
| Sword (all tiers) | 1.6 | 12.5 |
| Pickaxe (all) | 1.2 | 16.67 |
| Shovel (all) | 1.0 | 20 |
| Axe wood/stone | 0.8 | 25 |
| Axe iron | 0.9 | 22.2 |
| Axe gold/diamond | 1.0 | 20 |
| Hoe wood/gold | 1.0 | 20 |
| Hoe stone | 2.0 | 10 |
| Hoe iron | 3.0 | 6.67 |
| Hoe diamond | 4.0 | 5 |

(Netherite: not in this build — no Nether. Tiers present are exactly 06's five.)

Full-charge single-target DPS reference (damage × speed; i-frames cap real throughput at 1 hit/10 ticks vs one target, so hand/hoe spam never exceeds 2 hits/s):

| Weapon | DPS (theoretical) | Notes |
|---|---|---|
| Diamond sword | 7 × 1.6 = 11.2 | best sustained; 10.5/hit with crits |
| Diamond axe | 9 × 1.0 = 9.0 | biggest single hit (13.5 crit) |
| Iron sword | 6 × 1.6 = 9.6 | |
| Stone axe | 9 × 0.8 = 7.2 | early-game heavy hitter |
| Wood sword | 4 × 1.6 = 6.4 | |
| Hand | 1 × 4 = 4 → 2 effective | i-frame capped |

### 13.3 Attack execution

Reach **3.0 blocks** (survival, MC exact): segment from camera along view dir, length 3; hit = nearest entity whose AABB intersects the segment, provided no opaque block is hit first (reuse 01's combined ray). On hit: compute damage (13.1–13.2 + crit), call the §14 pipeline, apply knockback (§14.3, +sprint bonus), reset `t = 0`, swing animation per 03.

### 13.4 Critical hits (MC exact)

Condition: player is **falling** (`vy < 0` and `!onGround`), charge indicator ≥ **84.8%** (`p ≥ 0.848`), **not sprinting**, not in water, not on a climbable. Effect: damage ×1.5 (after the cooldown multiplier). Spawn 6–10 dark-star crit particles at the target. Sprint-hits can't crit (sprint-knockback takes priority, MC rule).

### 13.5 Sweep attack

**Skipped.** No sweeping edge, no sweep particles — every swing hits at most one entity. (State in HUD/UX nothing; it simply doesn't exist.)

## 14. Damage pipeline, i-frames, knockback, armor

Single shared pipeline for every `LivingEntity` (player and mobs):

```js
function hurt(entity, amount, source) {
  if (entity.dead) return;
  // 1 — invulnerability window (MC excess rule, 10 ticks)
  if (entity.invulnTicks > 0) {
    if (amount <= entity.lastHurtAmount) return;          // fully absorbed
    amount2 = amount - entity.lastHurtAmount;             // only the excess lands
    entity.lastHurtAmount = amount;  applyRest(amount2, noNewWindow=true);
    return;
  }
  entity.invulnTicks = 10;  entity.lastHurtAmount = amount;
  applyRest(amount);
}

function applyRest(dmg, noNewWindow=false) {
  if (armorApplies(source))                 // melee, arrows, explosions — NOT fall/drown/fire-tick/suffocation
    dmg = armorReduce(entity, dmg);         // §14.2; also -durability on pieces
  entity.health -= dmg;
  entity.hurtTime = 10;                     // red flash, §17
  if (!noNewWindow) applyKnockback(...);    // §14.3, from source direction
  if (entity.health <= 0) die(entity);      // §15
  if (entity.isMob) entity.onHurtBy(source);// aggro/panic/teleport hooks
}
```

`invulnTicks` decrements each tick. Mob→player and player→mob use the identical rules; a mob's 20-tick melee cooldown means the excess rule mostly matters for arrows + explosion combos. Environmental damage (fall, drowning, fire — 03) flows through the same `hurt()` so i-frames behave consistently.

### 14.2 Armor reduction (MC exact)

```
reduced = damage × (1 − min(20, max(armor/5, armor − damage/(2 + toughness/4))) / 25)
```

`armor` = total equipped defense points; `toughness` = total toughness. Per-piece values (stats also listed in 06 — the authoritative math lives here):

| Tier | Helmet | Chest | Legs | Boots | Total | Toughness |
|---|---|---|---|---|---|---|
| Leather | 1 | 3 | 2 | 1 | 7 | 0 |
| Gold | 2 | 5 | 3 | 1 | 11 | 0 |
| Chain (reference-only — not obtainable, no 06 items) | 2 | 5 | 4 | 1 | 12 | 0 |
| Iron | 2 | 6 | 5 | 2 | 15 | 0 |
| Diamond | 3 | 8 | 6 | 3 | 20 | 2/piece (8 total) |

Mobs use the same formula with their natural armor (zombie 2, toughness 0). **Armor durability**: on every armor-applicable hit with final pre-armor damage ≥ 1, each equipped piece loses `max(1, floor(damage/4))` durability (MC exact); at 0 the piece breaks (removal per 06).

Armor applicability by damage source:

| Source | Armor reduces? | Armor durability loss? |
|---|---|---|
| Mob melee, player melee | yes | yes |
| Arrow | yes | yes |
| Explosion | yes | yes |
| Fall, drowning, suffocation (03) | no | no |
| Fire tick / lava / starving (03/06) | no | no |

Worked examples (full diamond, 20 armor / 8 toughness): creeper point-blank 43 → `min(20, max(20/5, 20 − 43/(2+8/4))) = 9.25` → `43 × (1 − 9.25/25)` = **27.1** (still nearly lethal — run). Zombie 3 dmg → `min(20, max(4, 20 − 3/4)) = 19.25` → `3 × (1 − 19.25/25)` = **0.69**.

### 14.3 Knockback (MC-faithful)

```js
function applyKnockback(target, strength /* b/t */, dirX, dirZ) {   // dir = attacker→target, normalized
  target.vx = target.vx/2 + dirX * strength;
  target.vz = target.vz/2 + dirZ * strength;
  if (target.onGround) target.vy = min(0.4, target.vy/2 + strength);
}
```

- Base melee/arrow/mob-hit strength: **0.4**.
- **Sprint-knockback** (player sprinting when the hit lands): strength 0.4 + **0.5** = 0.9; the attacker's sprint ends and their horizontal velocity is multiplied by 0.6 (MC exact).
- Explosion knockback bypasses this function (adds `impact` directly, §12.3).
- Knockback resistance: all mobs in this roster have 0 — attribute omitted.
- Knockback Ⅰ/Ⅱ enchantments: out of scope (no enchanting).

## 15. Death, drops & XP orbs

**Death sequence** (any `LivingEntity` reaching HP ≤ 0):
1. `dead = true`; AI, collisions, and targeting off; the mob can no longer be hit.
2. Immediately spawn drop item entities and one XP orb (values §2). **Looting: skipped** (no enchantments).
3. Death animation for 20 ticks (§16): fall-over rotation + red tint; at `deathTime == 20` remove the entity.
4. Player death itself is handled in 03 (this pipeline just reports it).

**Item drop entities** (item entity physics per 01/06): spawn at mob center with velocity `vx = (rand()−0.5)·0.2, vy = 0.2, vz = (rand()−0.5)·0.2` b/t each.

**XP orb entity:**

| Property | Value |
|---|---|
| Size / render | 0.5×0.5 AABB; 4×4 px billboard quad, green-yellow pulsing (§16) |
| Physics | gravity −0.03 b/t², drag ×0.98, ground friction ×0.6 |
| Magnet | if player center within **7.25** blocks (MC exact): `v += normalize(playerMid − orb) · 0.1 · (1 − dist/7.25)²` per tick |
| Pickup | on AABB overlap with player, if `player.xpPickupCooldown == 0` → add value to player XP (03 HUD), set cooldown 2 ticks |
| Lifetime | 6000 ticks, then remove |

> Adaptation: one orb entity per drop event carrying the full value (MC splits into denominations — skipped). Breeding orbs (§10) and future furnace/mining orbs (06) reuse this entity.

## 16. Mob rendering & animation

All mobs are hierarchies of `THREE.BoxGeometry` parts. **1 px = 1/16 block.** Each part: `[w, h, d]` in px + pivot. Textures: per-face `CanvasTexture`s (8–16 px square canvases, `NearestFilter`, no mipmaps), generated once per mob type at startup from the recipes below; deterministic seeded noise.

### 16.1 Box models

```
HUMANOID (zombie, skeleton-frame, enderman-frame):
  head 8×8×8 (pivot at neck, y=24px)   body 8×12×4 (y12–24)
  armL/armR 4×12×4 (shoulder pivot y=22, x=±6)   legL/legR 4×12×4 (hip pivot y=12, x=±2)

Zombie:    humanoid; BOTH arms pitched −90° (held out forward, classic zombie pose).
           Baby zombie: same tree, group.scale = 0.5, head counter-scaled ×1.5 (big-head baby look).
Skeleton:  humanoid but arms/legs 2×12×2; holds a bow: 1×10×1 stick pair angled 30° in right hand;
           draw pose: both arms pitched −90° toward target while BowAttack draws.
Enderman:  head 8×8×8 at y=38; body 8×12×4 (y26–38); arms/legs 2×30×2 (long!);
           total ~46 px ≈ 2.9 m ✓. Jaw-open state = swap head texture (mouth row turns bright magenta).
Creeper:   head 8×8×8 (y18–26); body 8×12×4 (y6–18); 4 legs 4×6×4 at the body corners (y0–6).
Spider:    head 8×8×8 (front, y~9); thorax 6×6×6 (center); abdomen 10×8×12 (rear);
           8 legs 16×2×2, pivoted at thorax sides, splayed yaw ±(35°,55°,75°,95°) and pitched down 20°.
Cow:       body 12×18×10 lying horizontally (length along Z, y11–21); head 8×8×6 front (y16–24)
           + 2 horns 1×3×1; legs 4×12×4; udder 4×6×2 under rear belly.
Pig:       body 10×16×8 horizontal (y6–14); head 8×8×8 front + snout 4×3×1; legs 4×6×4.
Sheep:     body 8×16×6 horizontal (y9–15); head 6×6×8 (y13–19); legs 4×12×4.
           WOOL OVERLAY: duplicate body/head/leg-top boxes inflated +1.75 px, wool texture;
           hidden when sheared = true (skin texture beneath is light tan).
Chicken:   body 6×8×6 pitched −15° (y5–11); head 4×6×3 (y9–15) + beak 4×2×2 + wattle 2×2×2;
           wings 1×4×6 hinged at shoulders (x=±3.5); legs 3×5×3 yellow (approx px).
Arrow:     flat cross: two 5×1 px quads + 1×1 tip; aligned to velocity.
XP orb:    4×4 px camera-facing quad.
```

Baby animals: whole-group scale 0.5 (head counter-scale ×1.4 for charm). Hitboxes stay per §2 — never derive physics from render size.

### 16.2 Procedural texture recipes (one-liner each; all use seeded value-noise on the canvas)

- **Zombie**: skin base `#44aa44` with ±12% value noise; darker green tattered-shirt band on body top half `#2d6b2d`; black 2×2 eyes on face, dark pixel mouth; pants `#345d8a` noisy.
- **Skeleton**: bone `#d8d8c8` ±8% noise; darker `#9c9c8c` horizontal joint lines every 4 px on limbs; skull face: black 2×2 eye sockets, 1-px nasal slit, 4-px grim mouth row.
- **Creeper**: camo noise — random per-pixel pick from {`#0da70b`,`#3ecb3a`,`#7ee87b`,`#1b8a1a`} (classic creeper mottle); face: black sad eyes 2×2 and the iconic open Ⅱ-shaped mouth 4 px tall.
- **Spider**: charcoal `#1e1a17` ±10% noise; abdomen slightly lighter top stripe; head gets 8 red `#c33` 1-px eyes in two rows (render emissive).
- **Enderman**: near-black `#0d0d12` ±5% noise; eyes: 4×1 px bright magenta `#e079fa` strips with 1-px white core, emissive; jaw-open texture variant has a 8×2 magenta mouth row.
- **Cow**: base `#5d4033` brown ±10%, 4–6 random white blobs (random walk splat 3–6 px); white face blaze; pink `#e8a5a5` udder + muzzle; dark gray hooves row.
- **Pig**: pink `#f0a5a2` ±6% noise; darker `#d18784` snout with two nostril pixels; black 1×2 eyes; darker hoof rows.
- **Sheep wool**: white `#e6e6e6` with ±10% gray value noise (tint-multiplied by sheep color per §9.3); skin/face tan `#d1b28a` with pink inner-ear pixels; legs wool-topped.
- **Chicken**: white `#f4f4f4` ±8% noise; yellow `#e0b23c` beak + legs; red `#b02525` wattle; black 1×1 eyes; wing edges shaded 15% darker.
- **Arrow**: shaft `#6b4a2b`, head `#b0b0b0`, fletching white with gray stripes. **XP orb**: radial green→yellow, hue oscillates ±10° at 2 Hz.

### 16.3 Animations (all driven in the render loop from entity state; angles in radians)

- **Walk cycle**: per tick `walkCycle += horizontalSpeed(b/t) × 4`; `swingAmount = clamp(horizontalSpeed × 8, 0, 1)` (smoothed ×0.9 + new ×0.1).
  - Humanoid legs: `rotX = cos(walkCycle × 0.6662 + phase) × 1.4 × swingAmount`, phases 0/π; arms opposite phase ×0.8 amplitude (zombie arms stay forward, add ±0.1 bob; skeleton draw pose overrides arms).
  - Quadruped legs: same formula, diagonal pairs in phase (FL+BR = 0, FR+BL = π).
  - Spider legs: baseline splay pose + `rotZ ±= cos(walkCycle × 0.6662 + legIndex·π/2) × 0.4 × swingAmount`.
- **Head tracking**: head looks at look-target (player for LookAt goals, path direction otherwise): yaw clamped ±75° relative to body, pitch clamped ±40°, lerp 0.3/tick.
- **Creeper swell**: `s = swell/30`; uniform scale `1 + 0.3·s`; white overlay flash: toggle emissive white (α 0.6) every 5 ticks while `s < 0.5`, every 2 ticks while `s ≥ 0.5`.
- **Enderman shake** (stared-at or screaming): per-frame position jitter ±0.03 blocks on x/z; jaw-open texture while aggro.
- **Sheep eat**: head pitch down 40° for 40 ticks, two nibble dips (`pitch += sin(t·0.8)·0.1`).
- **Chicken flap**: while `!onGround && vy < 0`: wings `rotZ = ±(0.6 + sin(t·1.2)·0.5)`; folded otherwise.
- **Skeleton draw**: while drawing, right arm pitches to aim pitch, left arm slightly across; release snaps 0.15 rad recoil.
- **Melee swing** (zombie/spider/enderman attack tick): active arm/head-butt `rotX` −120°→0 over 6 ticks.
- **Hurt flash**: while `hurtTime > 0` multiply all part materials' color by `(1, 0.35, 0.35)` (§17).
- **Death**: over `deathTime 0–20`: `rotZ = min(1, sqrt(deathTime/10)) × 90°` (falls on its side), red tint held, sink 0.2 blocks after rotation completes; remove at 20. No despawn particles (particles budget: keep hearts, crit stars, teleport `#e079fa` motes, explosion flash+smoke per 01's Particles helper (render/Particles.js)).
- Idle sounds/step sounds: **out of scope (audio excluded project-wide)** — state it, never stub audio calls.

## 17. Damage feedback

- **Red flash**: `hurtTime = 10` on every damage instance; §16.3 tint. Applies to the player's first-person hands per 03 if visible.
- **Knockback**: §14.3 — visible displacement is the feedback; no extra screen shake.
- **Hurt-direction camera tilt** (MC's `hurtYaw` roll): **skipped** — state it. Player red vignette + heart shake on the HUD are 03's job (03 reads `player.hurtTime` from the shared pipeline).
- **Crit particles**: 6–10 dark 1-px star sprites burst 0.3–0.6 b/t upward-out from the target's upper AABB, 10–16 tick lifetime.

---

## Acceptance checklist

Spawning & population
- [ ] Standing in a dark plain at night: hostile mobs appear in packs of 1–4, never closer than 24 blocks, never in light > 0, only on valid ground blocks; live hostile count never exceeds 40.
- [ ] Species mix over ~5 min roughly 24/25/25/25% zombie/skeleton/creeper/spider with rare (~2.5%) endermen; ~5% of zombies are fast half-size babies.
- [ ] During the day, new hostiles appear only in caves (light 0); walking 130+ blocks away removes hostiles instantly; parked 40 blocks away, idle hostiles thin out over minutes (600-tick + 1/800 rule).
- [ ] Cows/pigs/sheep/chickens exist only from worldgen herds (02) + breeding, and never despawn.

Daylight & light behavior
- [ ] At dawn (04 day flag), sky-exposed zombies/skeletons ignite and die of fire unless in water/shade; baby zombies don't ignite; skeletons on fire run for shade.
- [ ] Spiders ignore the player in light ≥ 12, chase in ≤ 11, and stay angry if hit regardless of light.

AI & pathfinding
- [ ] A zombie 30 blocks away paths around walls, up 1-block steps, and drops ≤ 3 blocks to reach the player; loses interest per give-up rules.
- [ ] Pathfinding stays ≤ 2 A* runs/tick with 40 mobs active; blocked mobs bump-jump and re-path on stalls.
- [ ] Spider slides up a 2-block wall between it and the player (vy = 0.2 while colliding).

Mob specifics
- [ ] Skeleton: approaches to ≤ 15, strafes with random flips, backs off inside 11.25, fires every 3 s with a visible 1 s draw; arrows arc (0.05 gravity, 0.99 drag), stick in blocks, hit for ≤ 4 up close.
- [ ] Creeper: silent approach, hisses/swells at ≤ 3 blocks, explodes after 30 ticks of continuous ≤ 7-block LOS pressure; retreating > 7 or breaking LOS visibly deflates it; explosion cratering respects blast resistance, drops ~1/3 of destroyed blocks, deals ≤ 43 at point-blank (armor reduces), no fire.
- [ ] Enderman: neutral until crosshair-stared (≤ 64 blocks, 5 ticks) or hit; screams/shakes, chases at ~6 b/s, teleports on damage, dodges arrows, suffers in water/rain, teleports near a fleeing target; drops 0–1 ender pearl.
- [ ] Sheep eat grass (block → dirt) and regrow wool; sheared sheep render bare and drop no wool on death. Chicken lays an egg item every 5–10 min and never takes fall damage.

Breeding
- [ ] Feeding two cows wheat → hearts, they meet, baby spawns, 1–7 XP orb; parents refuse food for 5 min; baby is half-size, follows adults, matures in 5 min (−10% per extra feed).

Combat math (spot-check numbers)
- [ ] Spam-clicking with a diamond sword deals ~1.4 (7×0.2) per hit; waiting 13 ticks deals 7; falling non-sprint hit at full charge deals 10.5 with crit particles.
- [ ] Wood axe full-charge = 7 but only every 25 ticks; bare hand = 1 at 4/s.
- [ ] Full iron armor (15 pts) vs zombie (3 dmg): reduced to 3 × (1 − min(20, max(3, 15 − 1.5))/25) = 3 × 0.46 = 1.38; each piece loses 1 durability per hit.
- [ ] Two hits landing within 10 ticks: second applies only its excess over the first; a zombie can't damage the player faster than its 20-tick swing anyway.
- [ ] Sprint-hit knocks a mob ~2× farther (0.9 vs 0.4 strength) and cancels the player's sprint.
- [ ] Full-charge bow arrow deals 6–11; uncharged flick shots barely lob out (speed 3×charge, min charge 0.1).

Death, drops, rendering
- [ ] Killed mobs flash red, keel over 90° across ~10 ticks, vanish at 20; items scatter with a small pop of velocity; XP orb drifts to the player inside 7.25 blocks and collects on contact (2-tick throttle).
- [ ] Drop tables match §2 exactly (quantities + probabilities); looting/sweep/door-breaking/rare-drops/spider-eye/colored-wool-items confirmed absent.
- [ ] Every mob renders as its §16 box model with canvas textures, walk-swing limbs scaled by speed, ±75° head tracking, creeper swell-flash, enderman jitter, chicken flap; zero audio calls anywhere.
