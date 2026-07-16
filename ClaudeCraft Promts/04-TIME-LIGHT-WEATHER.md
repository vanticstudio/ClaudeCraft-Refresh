# 04 — Time, Light & Weather

This file specifies the day/night cycle, the sky and fog renderer, the voxel light engine (sky light + block light, propagation and removal), the mapping from light values to on-screen brightness, the weather state machine (clear/rain/thunder) with its rendering, clouds, and the bed time-skip rules. Baseline is Minecraft Java Edition ~1.20; exact values are taken from minecraft.wiki, approximations are marked `(approx)`. Storage of light arrays, chunk pipeline stages, mesh attribute packing, and the remesh dirty-queue are owned by 01-ARCHITECTURE.md — this file defines the algorithms that fill those arrays and the shader math that consumes them. Per-block `emission` and `opacity` columns live in 06-ITEMS-CRAFTING-SURVIVAL.md's block registry. 05-MOBS-COMBAT.md consumes the spawn-light and daylight-burn predicates defined here (§10). 03-PLAYER.md consumes the respawn-point side effect of sleeping (§14). 02-WORLD-GENERATION.md supplies biome temperature for rain-vs-snow (§12.5).

## Contents

1. Time system
2. Daylight cycle phase table
3. Celestial angle
4. Sky darken (internal light)
5. Sky rendering (dome, sun, moon, stars, sunrise band)
6. Sky color keyframes
7. Fog
8. Light engine: data model and rules
9. Light engine: algorithms (seed, propagate, remove, edit, cross-chunk)
10. Gameplay light predicates (consumed by 05/06)
11. Rendered brightness and smooth lighting
12. Weather system
13. Clouds
14. Bed and sleep time skip
15. Performance budgets
16. Acceptance checklist

---

## 1. Time system

| Constant | Value |
|---|---|
| Ticks per second | 20 (per CLAUDE.md/01) |
| Ticks per game day | 24000 |
| Real length of a day | 20 min 00 s |
| 1 game hour | 1000 ticks (50 s real) |
| dayTime 0 | 06:00 game clock (start of daytime) |

State (persisted in the save per 01):

```js
worldTime;              // u53 integer, total ticks elapsed since world creation, monotonic
dayTime  = worldTime % 24000;          // 0..23999, wraps
dayCount = Math.floor(worldTime / 24000);
moonPhase = dayCount % 8;              // 0 = full moon on day 0 (§5.3)
```

- `worldTime` increments by exactly 1 per game tick, in the fixed 20 Hz simulation loop (01).
- Game clock for the UI/debug: `hours = (dayTime / 1000 + 6) % 24`.
- For smooth rendering between ticks, all sky math below accepts `t = worldTime + partialTick` where `partialTick ∈ [0,1)` is the render-frame interpolation factor from 01's loop.
- New world starts at `worldTime = 0` (i.e., 06:00, day 0, full moon).

## 2. Daylight cycle phase table

Exact Java tick boundaries (source: minecraft.wiki Daylight cycle / Light §Internal sky light). "Internal sky" below means internal sky light at a fully sky-exposed block (sky light 15), see §4.

| dayTime | Event |
|---|---|
| 0 | Day begins, sun center exactly on eastern horizon. Undead have been burning since 23460. |
| 1000 | Reference "day" point (vanilla `/time set day`). |
| 6000 | Noon. Sun at zenith. Internal sky = 15 (clear). |
| 12000 | Sunset begins (18:00). Sun starts visibly dropping. |
| 12010 | **Rain:** beds become usable (rain internal sky ≤ 11). |
| 12041 | **Clear:** first darkening step — internal sky drops to 14. |
| 12542 | **Clear:** beds become usable; undead stop burning (skyDarken reaches 4). |
| 12786 | Sun center crosses below horizon (derived from §3 formula). |
| 12969 | **Rain:** hostile surface spawning becomes possible (rain internal sky ≤ 7). |
| 13000 | Reference "night" point (vanilla `/time set night`). |
| 13188 | **Clear:** hostile surface spawning becomes possible (internal sky ≤ 7). |
| 13670 | Full darkness: internal sky bottoms out at 4. Holds until 22330. |
| 18000 | Midnight. Moon at zenith. |
| 22331 | Sky begins to brighten (internal sky 5). |
| 22812 | **Clear:** last tick hostile surface spawning is possible (internal sky ≥ 8 at 22813). |
| 23031 | **Rain:** hostile surface spawn window ends. |
| 23215 | Sun center crosses above eastern horizon (derived). |
| 23459 | **Clear:** last tick beds are usable. |
| 23460 | **Clear:** undead begin to burn (skyDarken < 4 again). |
| 23961 | Internal sky back to 15 (clear). |
| 23991 | **Rain:** last tick beds are usable. |
| 23999 → 0 | Day wraps; `dayCount++`; moon phase advances. |

All of the clear/rain boundary ticks in this table are emergent from the two formulas in §3–§4 — do not hard-code them except in tests.

## 3. Celestial angle

Vanilla's exact time → sun-position mapping, including its nonlinear easing (nights feel slightly longer near the horizon):

```js
// Returns angle in [0,1): 0 = noon, 0.25 = sun at western horizon,
// 0.5 = midnight, 0.75 = sun at eastern horizon.
function celestialAngle(t /* worldTime + partialTick */) {
  const f = frac(t / 24000 - 0.25);          // frac(x) = x - Math.floor(x)
  const g = 0.5 - Math.cos(f * Math.PI) / 2; // cosine ease
  return (f * 2 + g) / 3;
}
```

Verification anchors: `celestialAngle(6000) = 0`, `celestialAngle(18000) = 0.5`, angle = 0.25 at dayTime ≈ 12786, angle = 0.75 at ≈ 23215.

Sun/moon direction in world space (+X = east, −X = west, +Y = up; sun path passes through the zenith, no seasonal tilt — vanilla behavior):

```js
const a = celestialAngle(t) * 2 * Math.PI;
sunDir  = normalize(-Math.sin(a), Math.cos(a), 0);  // rises +X, sets -X
moonDir = -sunDir;                                   // moon is always opposite
```

## 4. Sky darken (internal light)

`skyDarken` is an integer 0–11 recomputed once per tick (float version `skyDarkenF` kept for shading, same formula without `floor`):

```js
function computeSkyDarken(t, rainLevel, thunderLevel) {
  const a = celestialAngle(t);
  const day     = 0.5 + 2 * clamp(Math.cos(a * 2 * Math.PI), -0.25, 0.25); // 1 day, 0 night
  const rainMul    = 1 - (rainLevel    * 5) / 16;
  const thunderMul = 1 - (thunderLevel * 5) / 16;
  return Math.floor((1 - day * rainMul * thunderMul) * 11);   // 0..11
}
```

Derived quantities (these exact names are used by 05/06):

```js
internalSky(pos)   = skyLight(pos) - skyDarken;                 // may be negative
internalLight(pos) = max(blockLight(pos), internalSky(pos));    // "internal light level"
isDay              = skyDarken < 4;
```

Checkpoint values (must hold — all from minecraft.wiki/w/Light):

| Situation | skyDarken | Internal sky at sky-exposed block |
|---|---|---|
| Noon, clear | 0 | 15 |
| Noon, rain/snowfall (rainLevel 1) | 3 | 12 |
| Noon, thunderstorm (rain+thunder 1) | 5 | 10 |
| Midnight, any weather | 11 | 4 |

Sky light values stored in chunks (§8) are **never** modified by time of day — only `skyDarken` changes. That is what makes dusk/dawn free of relighting work.

## 5. Sky rendering (Three.js)

All sky objects live in a `skyGroup` that is repositioned to `camera.position` every frame, rendered first (`renderOrder` ≤ −1), with `depthWrite: false` and `fog: false` on every material. Sky radius `R_SKY = 400` (camera far plane ≥ 600 per 01).

### 5.1 Sky dome gradient

- Geometry: icosphere (detail 2) radius `R_SKY`, `THREE.BackSide`.
- `ShaderMaterial` uniforms: `uZenith` (color), `uHorizon` (color), from §6.
- Fragment: `mix(uHorizon, uZenith, clamp(dir.y * 1.4, 0.0, 1.0))` where `dir` = normalized vertex direction; below horizon (`dir.y < 0`) hold `uHorizon` darkened ×0.8.
- `renderer.setClearColor` is unused; the dome covers everything.

### 5.2 Sun

- `PlaneGeometry`, half-size `0.3 * R_SKY` = 120 (vanilla proportion: quad ±30 at distance 100).
- Position `sunDir * R_SKY`, oriented to face the camera (`lookAt(0,0,0)` in group space).
- Material: `MeshBasicMaterial`, additive blending, transparent, texture = 32×32 procedural: white-yellow `#FFFFE5` rounded square with soft 4-px falloff (vanilla sun is a square, not a disc).
- Visible whenever above `dir.y > -0.3`; alpha fades ×`(1 - rainLevel)`.

### 5.3 Moon with 8 phases

- Same construction, half-size `0.2 * R_SKY` = 80, position `moonDir * R_SKY`, normal (not additive) blending.
- Texture: 4×2 sprite sheet (procedural canvas, 128×64): cell 0 = full moon, then in order **full, waning gibbous, last quarter, waning crescent, new, waxing crescent, first quarter, waxing gibbous** — phase advances by 1 each time `dayCount` increments (i.e., at dayTime wrap; vanilla changes phase at the end of sunrise, same day boundary).
- Paint each cell: light-gray `#C3C3C3` square moon; overlay the shadowed lune using a black offset square/ellipse; cell 4 (new moon) is fully dark `#1A1A2A` at 25% alpha.
- UV select: `offset = ((phase % 4) / 4, phase < 4 ? 0.5 : 0)`, repeat `(0.25, 0.5)`.
- Moon brightness factor exposed for 05 (spawn-rate/slime hooks) and used to scale star/moon alpha slightly:

```js
MOON_BRIGHTNESS = [1.0, 0.75, 0.5, 0.25, 0.0, 0.25, 0.5, 0.75][moonPhase];
```

### 5.4 Stars

- 1500 stars (vanilla count). `THREE.Points`, positions uniformly random on sphere radius `0.9 * R_SKY`, seeded RNG (same seed → same sky).
- `PointsMaterial`: size 1.8 `(approx — vanilla quads 0.15–0.25 at distance 100)`, `sizeAttenuation: true`, additive blending, white.
- Alpha per frame, vanilla formula:

```js
function starBrightness(t) {
  let f = 1 - (Math.cos(celestialAngle(t) * 2 * Math.PI) * 2 + 0.25);
  f = clamp(f, 0, 1);
  return f * f * 0.5;                    // 0.0 all day, 0.5 at midnight
}
material.opacity = starBrightness(t) * (1 - rainLevel);
```

- The star field (and sun/moon) rotates as one rigid unit: parent them under a pivot with `pivot.rotation.z = celestialAngle(t) * 2π` and place sun at local `(0, R_SKY, 0)`, moon at `(0, -R_SKY, 0)`, stars randomly — this makes stars wheel around the same axis the sun travels. (Equivalent to the `sunDir` formula in §3: `Rz(2πa)·(0,1,0) = (−sin 2πa, cos 2πa, 0)`.)

### 5.5 Sunrise/sunset horizon band

Vanilla's exact color/alpha formula; the band exists only while `cos(angle·2π) ∈ [−0.4, 0.4]` (≈ dayTime 11270–14220 and 21804–732, i.e., around both horizon crossings):

```js
function sunriseColor(t) {              // returns null or {r,g,b,a} in 0..1
  const c = Math.cos(celestialAngle(t) * 2 * Math.PI);
  if (c < -0.4 || c > 0.4) return null;
  const s = c / 0.4 * 0.5 + 0.5;        // 0..1 across the window
  let a = 1 - (1 - Math.sin(s * Math.PI)) * 0.99;
  a *= a;
  return { r: s * 0.3 + 0.7, g: s * s * 0.7 + 0.2, b: 0.2, a };
}
```

Rendering: a half-disc triangle fan (12 segments, radius `0.35 * R_SKY`) lying on the horizon plane, centered on the sun's azimuth (+X side when rising, −X when setting), center vertex at full `a`, rim vertices alpha 0; additive blending. Rebuild colors per frame from the formula.

### 5.6 Scene lights (entities only)

Terrain gets zero scene lighting (its brightness is baked, §11). For entities/dropped items/clouds:

- `THREE.DirectionalLight`, direction `-sunDir` (or `-moonDir` at night, intensity ×0.25), intensity = `sunIntensity` from §6 table. No shadow maps.
- `THREE.AmbientLight`, intensity = `ambient` from §6 table.
- Entity brightness must additionally be multiplied by the local voxel light of the block the entity stands in (05 samples `internalLight` and applies §11's curve as a material color multiplier).

## 6. Sky color keyframes

Linear interpolation between keyframes on `dayTime` (wrap 23215 → 24000/0). Colors are hex sRGB.

> Adaptation: vanilla computes sky/fog procedurally per biome (`0x78A7FF` plains sky base × time factor, fog `#C0D8FF` base). We bake one global keyframe table tuned to match plains visuals `(approx)`; biome tinting of sky is out of scope.

| dayTime | Zenith | Horizon | Fog | sunIntensity | ambient |
|---|---|---|---|---|---|
| 0 | `#4A73C4` | `#FFB877` | `#C7A177` | 0.45 | 0.45 |
| 1000 | `#78A7FF` | `#C6DBFF` | `#C0D8FF` | 1.00 | 0.90 |
| 6000 | `#78A7FF` | `#C6DBFF` | `#C0D8FF` | 1.00 | 0.90 |
| 11000 | `#78A7FF` | `#C6DBFF` | `#C0D8FF` | 0.95 | 0.85 |
| 12000 | `#6E9BF2` | `#E8C79E` | `#D6B489` | 0.75 | 0.65 |
| 12786 | `#2E3D74` | `#FF9040` | `#9E7052` | 0.35 | 0.35 |
| 13670 | `#050815` | `#131A33` | `#0C101F` | 0.08 | 0.14 |
| 18000 | `#000208` | `#0A0F22` | `#060912` | 0.06 | 0.12 |
| 22331 | `#0A1030` | `#1B2447` | `#121830` | 0.10 | 0.16 |
| 23215 | `#274073` | `#E2894C` | `#8F6E51` | 0.30 | 0.32 |

Weather modulation, applied after interpolation to zenith/horizon/fog (vanilla-style desaturate-and-darken) `(approx)`:

```js
function weatherTint(color, rainLevel, thunderLevel) {
  let gray = luminance(color) * 0.6;                    // 0.3r + 0.59g + 0.11b
  color = lerp(color, [gray, gray, gray], rainLevel * 0.75);
  gray = luminance(color) * 0.2;
  color = lerp(color, [gray, gray, gray], thunderLevel * 0.75);
  return color;
}
sunIntensity *= (1 - 0.65 * rainLevel) * (1 - 0.5 * thunderLevel);  // (approx)
```

## 7. Fog

`scene.fog = new THREE.Fog(color, near, far)`, updated every frame. `R = renderDistanceChunks * 16` (default render distance per 01; e.g., 8 chunks → 128 m).

| Medium (camera position) | Color | near | far |
|---|---|---|---|
| Air | fog color from §6 (+ weather tint) | `0.75 * R_eff` | `R_eff` |
| Water (camera in water block) | `#050533` (vanilla water fog color) | 0 | 32 `(approx — vanilla ramps 24→96 with time submerged; fixed value chosen)` |
| Lava | `#991900` | 0.25 | 1.0 (vanilla lava fog distances) |

```js
R_eff = R * lerp(1.0, 0.85, rainLevel) * lerp(1.0, 0.75, thunderLevel);  // (approx)
```

- Terrain/entity/rain materials respect fog; all sky-group materials and clouds set `fog: false`.
- When the camera is underwater, the sky dome uniforms are overridden to the water fog color so the horizon doesn't show through (`uZenith = uHorizon = #050533`).
- Night fog uses the §6 table color — do not force black; the brightness floor in §11 keeps terrain readable.

## 8. Light engine: data model and rules

Two independent channels, each 0–15, stored per block position in per-chunk arrays (allocation, packing, and accessors `getSkyLight/setSkyLight/getBlockLight/setBlockLight` per 01; world Y range 0–127):

- **skyLight** — access to the sky. Time-invariant (see §4).
- **blockLight** — from emissive blocks.

Registry inputs (06's block registry columns; the engine reads only these two numbers per block state):

| Column | Meaning | Canonical values |
|---|---|---|
| `opacity` | Light attenuation of the block | 0 = fully transparent (air, glass, torch, flowers, rails); 1 = light-filtering (water, leaves, ice, cobweb, slime); 15 = opaque (stone, dirt, planks, ores…) |
| `emission` | Emitted block light | torch 14, glowstone 15, lava 15, jack o'lantern 15, sea lantern 15, lantern 15, campfire 15, furnace/smoker/blast furnace **lit** 13, soul torch 10, redstone torch 7, enchanting table 7, magma block 3, brewing stand 1 — full list in 06 |

Propagation rules (Java-accurate):

1. Cost to enter a block from any direction = `max(1, opacity)`. A block with `opacity 15` stores light 0 (its faces are shaded by the *neighbor's* stored light, §11).
2. **Sky light special case:** sky light of exactly 15 traveling straight **down** into an `opacity 0` block stays 15 (no attenuation). All other movement — horizontal, upward, level < 15, or entering `opacity ≥ 1` — pays rule 1. This is what carves bright shafts under open sky and dimming halos under overhangs.
3. Filtering blocks (opacity 1) reduce **sky light by 1 extra** even straight down (rule 2 doesn't apply since opacity ≠ 0): a water column attenuates sky light 15 → 14 → 13 → … 0 over 15 blocks. In Java, filtering blocks do **not** specially attenuate block light beyond the normal −1/step; we match that.
4. Block light: an emitter stores `emission` at its own cell and spreads by rule 1 (−1 per step through air). Taxicab distance: torch (14) lights floor 13 adjacent, 12 diagonal, etc.

> Adaptation: vanilla 1.14+ has *directional opacity* for slabs, stairs, dirt paths, pistons, etc. We treat all non-full-cube blocks as `opacity 0` for light. Visual difference is minor; mob-spawn correctness is preserved because spawning also requires full-block top surfaces (05).

Heightmap (also stored per chunk column, per 01): `H[x][z]` = Y of the lowest cell **above** the highest `opacity > 0` block in the column (i.e., every cell with `y ≥ H` sees direct sky). Maintained incrementally on every block edit. Consumed by: sky-light seeding (§9.1), `canSeeSky` (§10.2), rain/snow placement and lightning targeting (§12).

## 9. Light engine: algorithms

Two global queues **per channel**: `propQ` (propagation: entries are positions) and `unlightQ` (removal: entries are `{pos, oldLevel}`). All positions are world coordinates; the queues freely cross chunk borders. Ring buffers of packed int32 per 01's memory rules.

### 9.1 Initial chunk lighting pass

Runs in the chunk pipeline (01) at stage **LIGHT**, after the chunk *and its 8 horizontal neighbors* have block data (stage GEN done). Order:

```
lightChunk(c):
  1. Column seed: for each (x,z) in c: compute H[x][z] by scanning down from y=127
     for the first opacity>0 block; set skyLight=15 for all y >= H (air above terrain).
  2. Sky frontier: for each column (x,z), let Hmax = max H of the 4 horizontal
     neighbor columns (including columns in adjacent chunks);
     for y in [H, Hmax-1]: propQ_sky.push(x,y,z).
     // only cells that can bleed sideways into somewhere darker
  3. Emitters: for each block with emission e > 0:
     setBlockLight = e; propQ_block.push(pos).
  4. Border import: for each cell on c's 4 vertical border planes whose neighbor
     (in an already-LIT chunk) has light L >= 2 in either channel:
     propQ.push(that neighbor cell).
  5. propagate(SKY); propagate(BLOCK).      // §9.2, runs to exhaustion for initial pass
  6. Mark c dirty for MESH stage (01).
```

Propagation during step 5 may raise light inside already-lit neighbor chunks (light flowing back in); any write into another chunk marks that chunk remesh-dirty. Chunks are meshed only after they and their neighbors are LIT (01 pipeline gate) — this eliminates vanilla-style "black patch" seams.

### 9.2 Propagation (BFS flood fill)

```
propagate(channel):
  while propQ not empty:
    p = propQ.pop()
    L = light(channel, p)
    if L <= 1 and channel == BLOCK: continue
    for dir in [±X, ±Y, ±Z]:
      n = p + dir
      if n outside world (y<0 or y>127): continue
      o = opacity(n)
      if o >= 15: continue
      if channel == SKY and dir == DOWN and L == 15 and o == 0:
        newL = 15                                  // rule 2 (§8)
      else:
        newL = L - max(1, o)
      if newL > light(channel, n):
        setLight(channel, n, newL)
        markDirtyForRemesh(n)                      // chunk of n, + border neighbors (§11.4)
        propQ.push(n)
```

### 9.3 Removal (two-queue unlight, Seed-of-Andromeda style)

Used when a source is removed or an opaque block interrupts light. Pass 1 zeroes every cell whose light *descended from* the removed value, collecting the frontier of cells lit by other sources; pass 2 re-floods from that frontier.

```
removeLight(channel, p):
  old = light(channel, p)
  setLight(channel, p, 0)
  unlightQ.push({p, old})
  while unlightQ not empty:
    {q, L} = unlightQ.pop()
    for dir in [±X, ±Y, ±Z]:
      n = q + dir
      nL = light(channel, n)
      if nL == 0: continue
      descended = nL < L
                  or (channel == SKY and dir == DOWN and L == 15 and nL == 15)
                  // a 15-column below a removed 15 was fed by it: tear it down too
      if descended:
        setLight(channel, n, 0)
        markDirtyForRemesh(n)
        unlightQ.push({n, nL})
      else:                       // nL >= L: independent light, becomes re-seed frontier
        propQ.push(n)
  propagate(channel)              // refill the hole from surviving light
```

The `nL < L` comparison (strictly less) is the load-bearing detail: equal-or-brighter neighbors are *not* descendants and must survive as the refill frontier.

### 9.4 Block edit procedures

Called synchronously in the tick that applies the edit (03 block place/break):

**placeBlock(p, B)** — B has `opacity o`, `emission e`; old block had `oldEmission`:

```
1. if oldEmission > 0 or (o > 0):  removeLight(BLOCK, p)     // kills passing/old light
2. if e > 0: setBlockLight(p, e); propQ_block.push(p); propagate(BLOCK)
3. if o > 0:
     removeLight(SKY, p)          // §9.3's downward rule tears down the shadowed
                                  // 15-column beneath p automatically; side light
                                  // re-floods the shadow to 14,13,…
     if p.y >= H[p.x][p.z]: H[p.x][p.z] = p.y + 1            // heightmap raise
4. else (o == 0, e == 0, replacing air-equivalent): no light work.
```

**breakBlock(p)** — old block had `opacity o`, `emission e`:

```
1. if e > 0: removeLight(BLOCK, p)
2. if o > 0:
     recompute H for column (scan down from old H)
     if p.y == oldTopOpaqueY:                    // column opened to the sky
       for y in [newH, oldH-1]: setSkyLight(x,y,z, 15); propQ_sky.push(x,y,z)
     else:
       for the 6 neighbors n of p: if light(SKY,n) > 0: propQ_sky.push(n)
     propagate(SKY)
3. for the 6 neighbors n of p: if light(BLOCK,n) > 1: propQ_block.push(n)
   propagate(BLOCK)                              // fills p from surroundings
```

### 9.5 Cross-chunk rules

- Queues operate in world coordinates; `light()`/`setLight()` route to the owning chunk. If a propagation step reaches a chunk that is not yet at stage LIGHT, the write is dropped and the cell is recorded in that chunk's `pendingBorderLight` list (per 01's chunk struct); step 4 of §9.1 replays it on load.
- Any `setLight` in chunk k marks k remesh-dirty; if the cell is within 1 block of a chunk border, the adjacent chunk(s) are also marked (their smooth-lighting vertex samples read across the border, §11.3).
- Unloading a chunk mid-propagation: allowed; pending entries pointing into it are discarded (relight happens via §9.1 step 4 on reload).

## 10. Gameplay light predicates

These are the authoritative definitions; 05 and 06 reference them by name.

### 10.1 Hostile spawn light check (Java 1.18+ rule) — consumed by 05

```
canSpawnHostileAt(pos, rng):
  sky = skyLight(pos)
  if sky > rng.nextInt(32): return false                 // bright-sky early reject
  if blockLight(pos) != 0:  return false                 // hard requirement since 1.18
  skyCapped = thundering ? min(sky, 10) : sky            // storms darken the surface
  spawnLight = max(blockLight(pos), skyCapped - skyDarken)
  return spawnLight <= rng.nextInt(8)                    // uniform 0..7
```

Consequences (match §2's table): surface spawning is possible in clear weather only during dayTime 13188–22812; during a thunderstorm the surface reaches effective light 5, so spawning succeeds with probability 3/8 per light check even at noon. Caves with blockLight 0 and skyLight 0 spawn at any time.

### 10.2 Undead daylight burning — consumed by 05

Checked once per tick per undead mob (zombie, skeleton, drowned, phantom, zombie villager — list in 05):

```
burnsNow(mob):
  return isDay                                   // skyDarken < 4  (§4)
     and canSeeSky(mob.eyePos)                   // eyeY >= H[x][z] (§8 heightmap)
     and not mob.inWater
     and not isRainingAt(mob.pos)                // §12.4
  // helmet exemption + 8s fire duration handled in 05
```

Burn window in clear weather is exactly dayTime 23460 → 12541 (from §2). Rain (skyDarken becomes ≥ 3 but < 4 at rainLevel 1 — still "day") does **not** stop burning via skyDarken; it stops it via `isRainingAt`.

### 10.3 Plant/growth light thresholds — consumed by 06

| Rule | Predicate |
|---|---|
| Crops (wheat/carrot/potato/beetroot) grow | `max(skyLight, blockLight) >= 9` at crop block (raw sky, NOT internal — crops grow at night under open sky, Java 1.13+) |
| Crops uproot (break) on random tick | `max(skyLight, blockLight) <= 7` |
| Saplings/bamboo/stems grow | `light >= 9` at block above (same client-light formula) |
| Grass/mycelium spreads | `internalLight >= 9` at block above target |
| Grass dies to dirt | `internalLight < 4` at block above AND covering block `opacity > 0` |
| Snow layer melts | `blockLight >= 12` |
| Ice melts | `blockLight >= 12` |

## 11. Rendered brightness

### 11.1 Brightness curve

Vanilla Overworld curve `b(l) = x / (4 − 3x)`, `x = l/15` (each top-end step ≈ ×0.8), remapped onto a minimum ambient floor so night/caves are never pure black:

```js
AMBIENT_FLOOR = 0.04;   // > Adaptation: vanilla reaches ~0 and relies on the user
                        // "Brightness/gamma" setting; we fix Moody-equivalent + floor.
function brightness(l /* float 0..15 */) {
  const x = clamp(l, 0, 15) / 15;
  return AMBIENT_FLOOR + (1 - AMBIENT_FLOOR) * (x / (4 - 3 * x));
}
```

Reference table (precompute `BRIGHTNESS[16]`, and use the formula for floats in-shader):

| l | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| b(l) | .040 | .057 | .076 | .096 | .120 | .147 | .177 | .212 | .253 | .302 | .360 | .431 | .520 | .634 | .787 | 1.000 |

### 11.2 Combining channels (terrain shader)

Terrain vertices carry `aSkyLight`, `aBlockLight` (0–15 normalized /15, smooth-averaged §11.3) and `aAO` (per 01). The chunk material is a custom/patched shader with global uniforms — **time of day never triggers remeshing**; only `uSkyDarken` changes:

```glsl
uniform float uSkyDarken;      // skyDarkenF, float 0..11, updated per frame
uniform vec3  uSkyTint;        // lerp(#A6B8FF-blue-night, #FFFFFF, dayFactor) per frame
const  vec3  BLOCK_TINT = vec3(1.00, 0.89, 0.69);   // warm torchlight (approx)

float effSky  = max(vSkyLight * 15.0 - uSkyDarken, 0.0);
float bSky    = brightness(effSky);
float bBlock  = brightness(vBlockLight * 15.0);
vec3 light    = max(bBlock * BLOCK_TINT, bSky * uSkyTint);  // per-channel max
vec3 rgb      = texColor.rgb * light * vAO;
```

`uSkyTint` night factor: `dayFactor = (15 - uSkyDarken) / 15` eased; night tint `(0.65, 0.72, 1.0)` `(approx — reproduces vanilla's blue-shaded ~17%-luma nights)`. The per-channel `max` keeps torch pools warm inside blue moonlight, matching vanilla's 2-D lightmap feel. During a lightning flash (§12.6) `uSkyDarken` is forced to 0 for 3 ticks.

### 11.3 Smooth lighting (per-vertex sampling)

For a face with outward normal `n`, every vertex `v` samples the 2×2 group of cells that touch `v` inside the neighbor layer `face cell + n` (the same four cells AO uses, per 01):

```
vertexLight(channel, faceCell, n, v):
  cells = the 4 cells adjacent to v in the plane (faceCell + n)
          = { base, base+t1, base+t2, base+t1+t2 }   // t1,t2 = face tangent axes toward v
  for each cell that is opaque (opacity 15): substitute light(faceCell + n)
          // avoids black seams bleeding from inside walls
  return average of the 4 values / 15
```

Both channels are averaged independently. Flat-lighting fallback (debug toggle): both attributes = `light(faceCell + n)`. AO darkening multiplies **after** the light lookup (§11.2) so occluded corners stay dark even next to torches, matching vanilla's look.

### 11.4 Remesh coupling

`markDirtyForRemesh(cell)` → push owning chunk (and border-adjacent chunks within 1 block) into 01's dirty queue, deduplicated. Light edits therefore batch naturally with geometry edits; 01 rate-limits actual remeshing.

## 12. Weather system

### 12.1 State machine

Two independent toggles, exactly vanilla's structure and uniform ranges (ticks):

| Variable | Meaning | Duration when ON | Delay when OFF |
|---|---|---|---|
| `raining` + `rainTimer` | Rain (or snow per biome) | 12000–24000 | 12000–180000 |
| `thundering` + `thunderTimer` | Thunder flag | 3600–15600 | 12000–180000 |

```js
tickWeather() {
  if (--rainTimer <= 0) {
    raining = !raining;
    rainTimer = raining ? randInt(12000, 24000) : randInt(12000, 180000);
  }
  if (--thunderTimer <= 0) {
    thundering = !thundering;
    thunderTimer = thundering ? randInt(3600, 15600) : randInt(12000, 180000);
  }
  rainLevel    = clamp(rainLevel    + (raining    ? 0.01 : -0.01), 0, 1); // 5 s fade
  thunderLevel = clamp(thunderLevel + (thundering ? 0.01 : -0.01), 0, 1);
  isThunderstorm = raining && thundering;   // thunder without rain has no effect
}
```

New world: `raining = thundering = false`, both timers rolled from the OFF column. All five scalars persist in the save (01).

### 12.2 Global effects while raining

- `skyDarken` rises via §4's `rainMul/thunderMul` (noon internal sky: 12 rain / 10 thunder).
- Sky/fog colors desaturate+darken via §6 `weatherTint`; fog distance shrinks via §7 `R_eff`.
- Sun, moon, stars fade out ×`(1 - rainLevel)`.
- Undead stop burning (via §10.2 `isRainingAt`).
- Beds usable earlier (§14, emergent from skyDarken ≥ 4).
- Fire blocks have a chance to extinguish; crops/farmland hydrate — rules in 06 (cross-ref).

### 12.3 Rain rendering

**Decision: instanced streak quads** (not scrolling texture cylinders).

- `THREE.InstancedMesh` of 750 quads, each 0.04 m × 0.6 m, textured with a 2-px vertical white-blue streak `#9FB8D0` at 35% alpha, `depthWrite: false`, fog on.
- Instances live in a box 24×16×24 m centered on the camera. Each instance: column `(x,z)` random in box, `y` cycling downward at **14 m/s** `(approx)`; on `y < groundY(x,z)` or leaving the box, respawn at top with new random column.
- `groundY(x,z) = H[x][z]` (heightmap) — rain never renders under roofs/trees, matching vanilla's per-column rain curtains.
- Quads yaw-billboard to the camera (rotate about Y only).
- Instance count scales with `rainLevel`: `visible = floor(750 * rainLevel)` (write unused instances to scale 0).
- Splash particles: skipped (decision) — the streak reset at ground level reads as impact.

**Snow variant** (per-column choice, §12.5): flake quads 0.08×0.08 m, white, fall 2 m/s with ±0.5 m/s sinusoidal X-drift, same instancing scheme, 500 instances.

### 12.4 Where does it rain? (`isRainingAt`)

```js
isRainingAt(pos):        // rain reaches this exact block
  return raining
     and canSeeSky(pos)                    // pos.y >= H[x][z]
     and biomeTemperatureAt(pos) > 0.15    // else it's snow, not rain (02)
```

`biomeTemperatureAt` = biome base temperature − `max(0, y - 80) * 0.00125` altitude falloff (base temperatures per biome id: table in 02 §6.1; biome id from the chunk's biomes array). Temperature > 0.15 → rain; ≤ 0.15 → snowfall at that position. `(approx)` cold-wet taiga that received gen-snow via t_eff < −0.45 will rain at runtime (biome id doesn't carry sub-biome temp).

### 12.5 Snow accumulation and ice (trigger loop — block rules in 06)

Each tick, for each loaded chunk, while `raining`: with probability 1/16 pick one random column (x,z) in the chunk; let `top = H[x][z]`:

- If snowing at `top` (§12.4 temperature test fails) and the block below is solid-topped and `blockLight(top) < 10`: place one `snow_layer` (no stacking beyond 1 layer — decision).
- If the block at `top-1` is still water, freezing biome, and `blockLight < 10`: convert to ice (edge-adjacent-to-solid rule in 06).
- If raining at `top`: nothing placed (fire-douse handled by fire's own tick, 06).

### 12.6 Lightning (included — decision)

Only while `isThunderstorm`. Per loaded chunk per tick: `if (rng() < 1/100000)` → strike attempt (vanilla probability):

- Target: random (x,z) in chunk, `y = H[x][z]` (top of column). `(approx: vanilla nudges toward nearby entities within 3×3 chunks; skipped)`
- Visual: white emissive column mesh 0.3×0.3 m from target y to y+64 with 3 random 2-m horizontal jogs, additive, lifetime 6 ticks, plus **global flash**: for 3 ticks force `uSkyDarken = 0` and lerp sky dome colors 50% toward white.
- Gameplay event emitted to 05/06: ignite fire at target block (Normal difficulty rule), 5♥ (10 dmg) to entities within 3 m, mob transformations (creeper→charged etc.) — numbers owned by 05.

## 13. Clouds

- Single flat translucent plane, world `y = 110` `(approx — vanilla 1.20 uses Y=192, above our 0–127 world; 110 keeps clouds above all terrain)`.
- Geometry: `PlaneGeometry(3072, 3072)` rotated horizontal, following the camera snapped to the 12-m cloud grid: `plane.x = floor(cam.x / 12) * 12` (same for z) — texture stays world-anchored.
- Texture: 256×256 canvas, seeded value noise thresholded at 30% coverage (cell cloudy if `vnoise(cx, cz) > 0.58`), 1 texel = 12×12 m, `NearestFilter`, `RepeatWrapping` — blocky vanilla look. `uv = (worldX + drift) / 3072`.
- Drift: `+0.02` blocks/tick toward −X (0.4 m/s) `(approx)`, implemented as a texture-offset accumulator.
- Material: `MeshBasicMaterial`-equivalent unlit, white, `opacity 0.75`, `transparent`, `depthWrite: false`, `fog: false`, double-sided.
- Tint per frame: `cloudRGB = 0.16 + 0.84 * sunIntensity` (from §6), further ×`(1 - 0.3 * rainLevel)` `(approx)`.
- Render after sky group, before terrain.

## 14. Bed and sleep time skip

Bed placement/crafting/interaction ranges are 06; respawn-point storage is 03. The **time rules** are:

### 14.1 Can the player sleep now?

```js
canSleepNow():
  if (isThunderstorm) return true;         // any time of day during a thunderstorm
  return skyDarken >= 4;
  // emergent windows: clear 12542–23459, rain 12010–23991 (must match §2 exactly)
```

Failure messages: "You can only sleep at night" (time), "You may not rest now; there are monsters nearby" (§14.2).

### 14.2 Monster proximity check

Sleep is denied if any hostile mob (05's hostile list, excluding those ignoring players — 05 flag) is within **8 blocks horizontally (both |dx| ≤ 8 and |dz| ≤ 8) and 5 blocks vertically** of the bed block.

### 14.3 Sleep sequence

1. Player enters bed (03 locks movement/camera, black fade overlay ramps in).
2. After **100 ticks** (5 s, vanilla 101) still in bed → skip fires:
   - `worldTime = (Math.floor(worldTime / 24000) + 1) * 24000` → `dayTime = 0` (next sunrise). `dayCount` thus advances; moon phase advances.
   - If `raining`: set `raining = false`, `thundering = false`, reroll both timers from the OFF/delay column (vanilla: sleeping resets the weather cycle only when it is raining/snowing). `rainLevel/thunderLevel` drain naturally at 0.01/tick.
   - Set player spawn point to bed position (03).
   - Phantom insomnia counter resets (05, if phantoms implemented).
3. Leaving the bed before 100 ticks cancels the skip but **keeps** the respawn point (vanilla: spawn is set on entering the bed).
4. Sleeping does not fast-forward furnaces, crops, or any other tick logic — `worldTime` jumps, block ticks are not replayed (vanilla behavior).

## 15. Performance budgets

| System | Budget / policy |
|---|---|
| Light queue processing | ≤ 10,000 queue nodes per game tick across all queues; relighting drains synchronously with 01 §10.3's 100k safety valve; only remesh is deferred. A torch place/remove (~2,000 nodes) completes same-tick; a large cave breach amortizes over 2–3 ticks. |
| Initial chunk lighting | Whole-chunk, run at pipeline stage LIGHT off the main thread if 01 workers allow (arrays are transferable); target < 4 ms per chunk. |
| Time-of-day visuals | O(1) per frame: uniforms (`uSkyDarken`, `uSkyTint`, fog, sky colors), sun/moon/star transforms. **Never** remesh or relight on time change. |
| Weather visuals | Rain instancing update ≤ 0.3 ms/frame (single loop over ≤ 750 instances); cloud update O(1). |
| Remesh from light edits | Only via 01's dirty queue (deduped); §11.4. No synchronous meshing inside light code. |
| skyDarken recompute | Once per tick (integer) + per frame (float uniform). |
| Heightmap maintenance | O(column height) worst case on edit; amortized O(1). |

Determinism: all weather/lightning RNG draws come from the world-seeded PRNG stream (01) so saves replay consistently; star positions and cloud noise use fixed sub-seeds.

## 16. Acceptance checklist

- [ ] `worldTime` advances 24000 ticks per 20 real minutes; debug clock shows 06:00 at dayTime 0, 12:00 at 6000, 00:00 at 18000.
- [ ] `celestialAngle` hits 0 / 0.25 / 0.5 / 0.75 at ticks 6000 / ≈12786 / 18000 / ≈23215; sun rises +X, sets −X; moon is always opposite the sun.
- [ ] `skyDarken` = 0 at clear noon, 3 at rainy noon, 5 at thundery noon, 11 at midnight; internal sky at an exposed block reads 15/12/10/4 respectively.
- [ ] Emergent windows match §2 exactly: beds usable 12542–23459 (clear) and 12010–23991 (rain); hostile surface window 13188–22812 (clear); undead burn 23460–12541.
- [ ] Moon cycles 8 phases (full on day 0, new on day 4); phase texture cell changes exactly at dayTime wrap; `MOON_BRIGHTNESS` array exposed to 05.
- [ ] Stars invisible at noon, alpha 0.5 at midnight, fade with the vanilla `starBrightness` formula, and rotate with the celestial pivot.
- [ ] Sunrise/sunset band appears only while `cos(2πa) ∈ [−0.4, 0.4]`, orange (r→1.0, g≈0.2–0.9, b=0.2), on the correct horizon side.
- [ ] Sky/fog colors interpolate through all 10 keyframes without popping; rain desaturates and darkens them; underwater fog is `#050533` near 0 / far 32; lava fog 0.25/1.0.
- [ ] Column of glass under open sky reads skyLight 15 all the way down; 3 blocks of water reads 12 beneath; a 1-block overhang cell reads 14 via lateral spread; sealed cave reads 0.
- [ ] Torch: 14 at its cell, 13 on adjacent floor, 12 diagonal; removing it restores all affected cells to their pre-place values (two-queue removal leaves zero residue — verify with checksum of light arrays).
- [ ] Placing an opaque block in a sunlit shaft zeroes the direct-sky column below it and re-floods 14,13,… from the sides; breaking the top block restores the 15 column.
- [ ] Light propagates seamlessly across chunk borders (torch at x=15 lights cells in the next chunk; no seams after neighbor loads later).
- [ ] Brightness table matches §11.1 (±0.001); light 0 renders at 0.04 floor, never pure black; each step near the top is ≈ ×0.8.
- [ ] Dusk→night in-game causes zero chunk remeshes (verify counter) — only `uSkyDarken`/`uSkyTint` change.
- [ ] Smooth lighting: torch behind a corner produces a gradient across faces; AO corners remain darker than their neighbors even when lit.
- [ ] Hostile spawn predicate: blocks with blockLight ≥ 1 never spawn; sunlit ground never spawns in clear daytime; thunderstorm noon allows spawns at reduced rate (§10.1).
- [ ] Undead burn at dawn tick 23460 under open sky, stop in water, under roofs, and while raining on them.
- [ ] Weather: durations sampled from §12.1's exact ranges; rainLevel fades over 5 s; thunder-only (no rain) shows nothing; thunderstorm = rain + thunder.
- [ ] Rain streaks never render below overhangs/roofs (heightmap test) and switch to slow flakes in cold biomes/altitudes; snow layers/ice appear per §12.5 loop.
- [ ] Lightning strikes average ≈ 1 per 100,000 chunk-ticks during storms, flash forces full sky brightness for 3 ticks, and emit the 05/06 event.
- [ ] Clouds: flat plane at Y=110, blocky 12-m cells, drift −X, world-anchored while the player moves, dimmed at night and during rain.
- [ ] Bed: denied at clear-noon with the "only at night" message; denied with a zombie 6 blocks away; sleeping sets dayTime to 0, clears active rain, sets respawn, and advances the moon phase.
- [ ] Light engine sustains 10k nodes/tick without frame drops; breaking into a mega-cave completes relight within 3 ticks.
