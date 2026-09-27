# 19 — BUILD-OUT v1.3+ (GLM 5.3 flash build-out master doc)

**Status:** READY TO BUILD · **Owner:** assigned per session · **Last updated:** 2026-09-27
**Baseline:** v1.2.7 (`ee7c5ae`) — greedy-mesh fix + staged-animation fix + mob material/light fix + mob texture overhaul + smoke U9/U10.

> **HOW TO USE THIS DOC (for any session, especially GLM 5.3 flash):**
> Work ONE phase at a time, top to bottom. A phase is not done until its
> acceptance criteria AND its new smoke check both pass. Tick the checkbox,
> update the tracking table, update `BUILD-STATE.md`, and STOP — do not roll
> into the next phase without an explicit handoff.
>
> **THE IRON RULES** — v1.2.6 ("the invisible world") shipped because runtime
> behavior was never executed, only statically reviewed. Every rule below
> exists because a past session violated it:
>
> 1. **Every phase adds a runtime smoke check (U11+).** Static analysis alone
>    is NOT verification. The smoke harness (`scripts/smoke.mjs`) can execute
>    pure-logic modules in Node — use it.
> 2. **The chunk is 16×128×16, never 16³.** Any loop that indexes cells must
>    use `(y << 8) | (z << 4) | x` with y ∈ 0..127. The v1.2.6 greedy pass
>    scanned only the bottom 16³ and meshed every chunk above y=15 as EMPTY.
> 3. **Registry render fields are resolved by `finalizeBlockTiles(TILE)`** —
>    `tileIndex`/`tileIndexFor` DO NOT EXIST until it runs. Main thread: it
>    runs in `main.js boot()`. Any new worker that touches `BLOCKS` render
>    fields MUST call it itself (see `meshWorker.js init` for the pattern:
>    `finalizeBlockTiles(Object.fromEntries(TILE_NAMES.map((n, i) => [n, i])))`).
>    Gen workers never touch render fields — do not add any.
> 4. **Workers must stay DOM-free.** `document`, `window`, `canvas` are
>    illegal anywhere in a worker import graph (U12 checks this). Canvas-based
>    work belongs on the main thread.
> 5. **Entities are UNLIT.** Mob/Player materials are `MeshBasicMaterial` +
>    `applyLightScalar()` (world light at position, `brightness(level)` from
>    `Entity.js`). Never add a scene-lit material for entities — double
>    darkening was v1.2.6's mob bug. Bosses included (EnderDragon).
> 6. **Animated atlas tiles: the staging texture needs `needsUpdate = true`**
>    after every repaint, or three r185 keeps the boot-time (blank) GPU copy
>    — that is how water went invisible. Any new animated-tile work rides
>    `atlas.js paintFrames`, which now handles this; do not fork it.
> 7. **Biome tints are neutralized** (`biomeTints.js` returns white) because
>    tiles are painted in FINAL color. Do not re-enable a tint multiply
>    unless the tile painter ships a grayscale variant AND untinted UI
>    consumers (icons) are re-tinted in the same phase.
> 8. **Lighting is single-source.** Terrain brightness = chunk shader
>    (`brightness` curve + `uBright` option, `AMBIENT_FLOOR` 0.04). Entities
>    = `brightness(level)` JS mirror. Anything new that glows must go through
>    one of those two, not a third path.
> 9. **Never regress the loading gate.** `Game.js` LOADING branch + 7×7
>    `loadingProgress` + 400-tick watchdog is the contract. Any change to
>    gen/mesh/light must keep `meshed >= needed` reachable on a fresh world.
> 10. **Commit after every green phase.** One phase = one commit = one
>     deployable state. Never push red.

---

## Global verification gates (run after EVERY phase)

| Gate | Command | Must be |
|---|---|---|
| Smoke | `npm run smoke` | ALL checks green (U1–U10 + the phase's new ones) |
| Build | `npx vite build` | clean, no new warnings vs baseline |
| Runtime sanity | `npm run dev` → load a NEW world + the test save | loading counts 0→49 fast; terrain, water, fire, mobs all render |
| Regression | phases touching gen/mesh/light | U9 runtime grid (3 dims) still green with the phase's changes |

---

## Tracking table

| Phase | Title | Size | Status | Depends on |
|---|---|---|---|---|
| B0 | Harness hardening + worker purity check | S | ☑ DONE (U11+U12, `npm run verify`) | — |
| B1 | Worker-side lighting | L | ☑ DONE (U14 parity byte-identical + fallback gate 49/49) | B0 |
| B2 | Chunk shader GLSL3 + textureGrad (seam fix) | M | ☑ DONE (U13) | — |
| B3 | Feel & combat polish | M | ☐ not started | — |
| B4 | New items & systems (fishing, shield, totem, clock/compass) | L | ☐ not started | B0 |
| B5 | Dungeons & structures | L | ☑ DONE (U16: 4 dungeons/21×21, integrity+loot+seed variation) | B0 |
| B6 | Raids & village life | L | ☐ not started | B5, B7 (AI base) |
| B7 | Mob AI pathfinding (A*) | L | ☑ DONE — audit: A* was already fully built (budget/repath/stall/fallback); U15 pins the contract | B0 |
| B8 | Weather expansion (thunder, snow, fog) | M | ☐ not started | B0 |
| B9 | Occlusion culling | L | ☐ not started | B1 |
| B10 | Post-processing "Fancy" pass | M | ☐ not started | B2 |
| B11 | Platform: PWA + touch + gamepad + world export/import | XL | ☐ not started | B0 |
| B12 | "The Hollow" underground biome + miniboss | L | ☐ not started | B4 |

Suggested ship order: **B0 → B2 → B1 → B7 → B5 → B4 → B3 → B8 → B6 → B12 → B9 → B10 → B11**.
(Engine fixes first; content on top of stable foundations; platform last.)

---

# B0 — Harness hardening + worker purity check

**Goal:** close the two gaps that let v1.2.6 ship: runtime coverage for worker
graphs, and a registry-contract tripwire.

**Files:** `scripts/smoke.mjs` only.

**Spec:**

1. **U11 — registry render-field contract.** For every module that reads
   `blk.tileIndex`, `blk.tileIndexFor`, `blk.tiles`, `blk.tilesFor`,
   `blk.bucket`, `blk.occludes`, `blk.renderSameIdFaces`, `blk.tint`:
   statically resolve the consumer list (the U2 import-graph machinery
   already builds one), then for each consumer assert either
   (a) it is on the main-thread-only path (imported transitively by
   `main.js` AFTER `finalizeBlockTiles` runs in `boot()`), or
   (b) it is a worker entry (`meshWorker.js`, `terrainWorker.js`) — assert by
   READING the file text that the worker calls `finalizeBlockTiles` in its
   init branch before any mesher construction (the meshWorker pattern).
   New workers added in B1/B9 must extend this list — the check must FAIL a
   worker that reads render fields without the init call.

2. **U12 — worker graph purity.** Replicate the terrainWorker and meshWorker
   import graphs (U2's graph walker), then for every module in either graph:
   `import()` it in Node and assert it loads (same class of check as U9's
   imports), and text-scan it for module-scope `document.` / `window.` /
   `new Worker` references. A `document` hit inside a function body is fine
   (that's `canvasTex` in models.js — only flag MODULE-scope usage: a top-level
   statement, not one behind `function`/arrow indentation). Keep the heuristic
   simple and documented in the check's comment.

3. **`npm run verify`** script in `package.json`: `node scripts/smoke.mjs && vite build`.
   All future phases and the README say "run `npm run verify`".

**Acceptance:** smoke = 12/12 green; `npm run verify` green; deliberately
breaking one rule in a scratch branch flips the right check (test by
reverting; don't commit the break).

**Out of scope:** CI (GitHub Actions) — B11's PWA phase can add it if wanted.

---

# B2 — Chunk shader GLSL3 + textureGrad (seam fix)

**Goal:** kill the fract()-tiling mip seam (per-cell grid lines on merged
quads) properly, and unlock derivative-correct sampling for B10.

**Files:** `src/mesh/materials.js`, possibly `src/render/renderer.js` (assert
WebGL2), `scripts/smoke.mjs` (shader-source check U13).

**Spec:**

1. `createChunkMaterials` gains `glslVersion: THREE.GLSL3`. Convert the shader:
   - `attribute` → `in`, `varying` → `out` (VERT) / `in` (FRAG),
     `gl_FragColor` → `out vec4 fragColor`, `texture2D` → `texture`.
2. Fragment main: replace the merged-path sample with an explicit-derivative
   sample so the GPU never sees the fract() discontinuity in its LOD math:
   ```glsl
   float merged = step(2.01, vSpan.x + vSpan.y);
   vec2 f = fract(vUv);
   vec2 auv = mix(vUv, vTileUV + f * TILE_INNER, merged);
   // gradient of the folded coord = gradient of vUv, scaled into tile space.
   // texelGrad has NO discontinuity, so mip selection stays smooth.
   vec2 du = dFdx(vUv) * TILE_INNER, dv = dFdy(vUv) * TILE_INNER;
   vec4 tex = (merged > 0.5)
     ? textureGrad(uAtlas, auv, du, dv)
     : texture(uAtlas, auv);
   ```
   The static path keeps plain `texture()` (absolute UVs, no fold → no seam).
3. GLSL3 note: `dFdx/dFdy/textureGrad` are core in ES 3.0. three r185 is
   WebGL2-only — no fallback branch needed, but assert once at renderer
   creation (`renderer.capabilities.isWebGL2`) with a console.error if false.
4. **U13 — shader-source check:** assert `materials.js` FRAG contains
   `textureGrad` on the merged branch AND the vertex/frag attribute pairs all
   declare matching `in`s (spot-check `aSpan`, `aTileUV`, `tint`), so a future
   GLSL1-style revert fails loudly.

**Acceptance:** flat-terrain close-up shows NO per-cell seam lines (manual
screenshot vs baseline); U9 parity green (mesher untouched — UV data identical,
this is shader-only); `npm run verify` green.

**Out of scope:** water reflections, shadow receiving (B10/B9 territory).

---

# B1 — Worker-side lighting

**Goal:** remove the last main-thread streaming hitch: `LightEngine.initialLight`
runs unbudgeted per chunk on the render thread. Move it into a worker pool,
mirroring the mesh pool's architecture — WITHOUT regressing the loading gate.

**Files:** `src/world/LightEngine.js` (add a pure snapshot core), NEW
`src/workers/lightWorker.js`, `src/world/ChunkManager.js` (pool + dispatch +
fallback), `src/constants.js` (`LIGHT_WORKER_COUNT`, reuse `MESH_WORKER_COUNT`
sizing heuristic), `scripts/smoke.mjs` (U14).

**Spec:**

1. **Refactor, don't fork.** Extract LightEngine's core into pure functions
   over plain typed arrays with NO world object:
   ```js
   // LightEngine.js exports:
   computeChunkLight(center, hood, opts)
   //   center/hood: plain { blocks, states, heightMap } snapshots (3×3 layout,
   //   same (dx+1)*3+(dz+1) indexing as ChunkMesher.loadSnapshot)
   //   opts: { hasSkyLight, activeDim, emitTable }  emitTable = Uint8Array(256)
   //         of block emission, PRE-RESOLVED on the main thread — workers never
   //         import the registry (Iron Rule 3)
   // returns { skyLight, blockLight, borderOut, dirtied } typed arrays where
   //   borderOut = per-side light values crossing each border (the border-import
   //   contract of current initialLight step 4, inverted), and
   //   dirtied = the same keys onBlockChanged-style dirtying produces for
   //   already-MESHED neighbors (re-mesh hints, serialized as [dx,dz] pairs)
   ```
   The existing main-thread `initialLight(chunk)` becomes a thin wrapper:
   build snapshots from live chunks → `computeChunkLight` → install. The
   worker path uses the identical function — ONE algorithm, two drivers.
2. **LightWorker protocol** (mirror meshWorker exactly):
   - main → `{ type:'init' }` → worker replies `{ type:'lightReady' }`.
   - main → `{ type:'light', id, cx, cz, epoch, snap }` with 3×3 snapshots
     TRANSFERRED (9 × {blocks, states, heightMap}; light arrays are outputs,
     never inputs — border import comes from the neighbor snapshots).
   - worker → `{ type:'lit', id, cx, cz, epoch, skyLight, blockLight, dirtied }`.
   - worker → `{ type:'lightError', id, message }`; init failure → pool dead
     → permanent main-thread fallback (`lightBroken`, exactly `meshBroken`).
3. **ChunkManager integration:**
   - `promote()` keeps its budget logic, but the GENERATED→LIT promotion
     dispatches to the pool when available (`lightJobs` map keyed by chunk
     key, epoch stale-guard identical to mesh jobs). `ChunkState.LIT` is set
     by the RESULT handler, not at dispatch.
   - The LOADING gate path (`Game.js` tick LOADING branch) must still pass:
     the loading budget now bounds DISPATCH work; results land via the worker.
     If `lightReady` has not arrived yet, fall back to sync lighting for that
     tick (the fallback makes the gate un-regressable by construction).
   - `drainRemesh` must not dispatch mesh jobs for chunks whose neighbors are
     dispatched-but-not-yet-LIT: add a `pendingLight` set checked alongside
     `hoodAtLeast`.
4. **Emission table:** build `emitTable` in ChunkManager from BLOCKS once
   (respecting `emissionFor(state)` — pre-evaluate per state nibble 0..15 per
   block id into `Uint16Array(256 * 16)`; the worker indexes it).
5. **U14 — light parity:** extend the U9 grid: after generating + meshing the
   3 dims, run `computeChunkLight` (sync) against the worker shim (call the
   same exported function through a snapshot round-trip — simulating the
   worker boundary) and assert byte-identical `skyLight`/`blockLight` for all
   9 chunks per dim.

**Acceptance:** fresh world loading completes as fast or faster than v1.2.7;
F3 gains a `lightMs` line showing ≈0 during streaming while chunks still light
(correctness proof); U9 + U14 green; `npm run verify` green.

**Out of scope:** incremental relight on block edits (stays main-thread,
budgeted as today); Nether/End dim-specific floors (pass through `opts`).

---

# B7 — Mob AI pathfinding (A*)

**Goal:** mobs navigate around obstacles instead of walking into walls. The
single biggest "feels like Minecraft" AI upgrade.

**Files:** NEW `src/entities/mobs/pathfind.js`, `src/entities/mobs/ai.js`
(goal integration), `src/entities/mobs/Mob.js` (move/steer plumbing),
`src/world/Chunk.js` or ChunkManager (walkability cache), `scripts/smoke.mjs` (U15).

**Spec:**

1. **Walkability grid:** per chunk, a Uint8Array(16×128×16) where cell = 1 if
   a mob with the chunk's tallest common footprint can STAND there: block below
   collidable + 2 air (or passable: non-collidable) above. Compute lazily per
   chunk on first path query, cache on the chunk object, invalidate on
   `markDirty` (meshEpoch bump hook) and on `onBlockChanged` (bump a version
   counter; pathfinder re-checks its cached grid's version).
2. **A* core (pure, node-testable):**
   ```js
   // pathfind.js
   findPath(world, startX, startY, startZ, endX, endY, endZ, opts)
   //   opts: { maxNodes = 800, maxDrop = 3, maxJump = 1, width = 0.6, height = 1.8 }
   //   neighbors: 8-walk (4 + diagonals requiring both adjacent cells walkable),
   //   step-up ≤ 1 (classic MC), drop ≤ 3, water cells cost 4 for land mobs,
   //   door width: diagonal move requires BOTH orthogonal cells walkable.
   //   returns [{x,y,z}...] world cells or null; deterministic (binary heap,
   //   tie-break on insertion order — no Math.random anywhere).
   ```
3. **Goal integration (ai.js):** `ChaseGoal`/`MeleeAttackGoal` request a path
   when `dist > 2` and the straight line is blocked (raycast); repath at most
   every 20 ticks per mob, or when the target moves > 3 blocks. Steering:
   follow the next waypoint; drop the path if `findPath` returns null →
   existing straight-line behavior (graceful degradation). WanderGoal may
   optionally path to its picked destination (cheap, maxNodes 300).
4. **Budget:** global per-tick repath cap (3 mobs/tick, round-robin) stored on
   EntityManager; a mob whose repath is deferred keeps steering on its last
   path. Never allocate the grid more than once per chunk per version.
5. **U15 — pure-logic test in Node:** synthetic world fixture (flat floor, a
   3-wide wall with a 1-wide gap, a 2-block step) → assert: path exists through
   the gap, path goes around a full wall (returns null → fallback documented),
   path uses the step, no diagonal corner clipping, node budget respected.

**Acceptance:** zombies/cave mobs visibly route through doorways and around
trees in-game; F3 shows repath count and node stats; U15 green; mob tick cost
does not regress (F3 redstoneMs-style line gains `pathMs`, stays < 1.5ms avg).

**Out of scope:** flying/swimming pathing (Ghast/Blaze keep hover), villager
job-site routing (villagers keep their wander), leashed-path sharing.

---

# B5 — Dungeons & structures

**Goal:** exploration reward. Reuses the village stamper architecture (deterministic,
seed-driven, chunk-stamped) and existing blocks (spawner, chests, TNT, mossy
cobble — mossy exists? verify; if not, add ONE tile + painter).

**Files:** NEW `src/world/gen/dungeons.js`, `src/world/gen/terrain.js` (hook),
`src/registry/blocks.js` (+ `mossy_cobblestone` tile if missing),
`src/assets/tilePainters.js` (+painter), `scripts/smoke.mjs` (U16).

**Spec:**

1. **Generation contract (same as villages):** per-chunk deterministic stamp —
   `dungeonPlan(seed, cx, cz)` decides via hash whether a structure anchors in
   this chunk; structures that span chunk borders write their blocks through a
   border-safe stamper (copy the village.js approach — do NOT invent a second
   mechanism).
2. **Dungeon rooms:** 7×7×4 to 9×9×4 hollow cobble/mossy rooms at y 8..40,
   spawner at center (mob weight by depth: zombie/skeleton/spider; Nether: blaze),
   1–2 chests with loot tables (data-driven: `DUNGEON_LOOT = [{item, weight,
   min, max}]` — iron/gold ingots, bread, saddle?, enchanting-relevant loot).
   Chests populate their blockEntity inventory AT GEN (deterministic seed →
   same loot for every player of the seed — 14 §determinism friendly).
3. **Surface ruins:** small desert ruins (sandstone, 5×5, one loot chest +
   occasional TNT trap under the floor — TNT is in-registry, wired via
   PrimedTnt on neighbor update? verify the TNT ignition path exists in
   redstone/fire and use it) and surface wells.
4. **Spawn protection:** structures never float: the stamper must anchor to the
   heightmap (computeHeightMap) or carve into solid ground only.
5. **U16 — determinism + integrity:** fixed seed → generate a 7×7 grid →
   assert: any dungeon found (search seed list in the check to guarantee ≥1
   spawns near origin) has: solid floor under the spawner, enclosed room (no
   air-side walls at generation time — cheap flood check from a wall cell),
   chest with a loot inventory, and TWO different seeds produce DIFFERENT
   layouts (anti-constant guard).

**Acceptance:** fresh world spawn within ~150 blocks of a reachable dungeon;
smoke U16 green; `npm run verify` green.

**Out of scope:** mineshafts (rail system dependency — defer), ocean monuments,
woodland mansions.

---

# B4 — New items & systems (fishing, shield, totem, clock, compass)

**Goal:** content depth using systems that already exist: offhand
(`interaction.js` hand rerun), throwables (projectile entities), status effects,
durability, recipes, and the icon pipeline.

**Files:** `src/registry/items.js` (+ids, tags, recipes), `src/registry/blocks.js`
(none), NEW `src/entities/FishingBobber.js`, `src/player/interaction.js`
(fishing use-item state machine), `src/entities/Player.js` (totem hook, shield
damage hook), `src/items/durability.js`, `src/ui/hud.js` (cooldown/charge UI),
`src/assets/tilePainters.js` (+ item tiles), `scripts/smoke.mjs` (U17).

**Spec:**

1. **Fishing rod** (durability 64): use → cast bobber (a projectile-family
   entity with its own float physics: buoyancy via the existing `inWater`
   medium system). Bobber state machine: `cast → float → bite (random tick,
   weighted by open-water bonus: 5×13×5 water check) → reel`. Reel during
   `bite` window (5 ticks) → catch roll: fish 85% / treasure 10% / junk 5%
   (open-water bonus shifts weights). Fish items: raw_cod, raw_salmon,
   tropical_fish, pufferfish (food values + poison effect on pufferfish via
   status/effects). Rod durability only on catch/miss-reel.
2. **Shield** (offhand, durability 336): holding use → blocking; melee damage
   while blocking reduced 100% front-arc (attacker dot-product check), arrows
   blocked entirely; blocking costs 1 durability per blocked hit; axe hits
   disable blocking for 100 ticks (MC parity). Offhand equip path already
   exists (interaction.js reruns the hand step) — the shield USE hook goes
   where the offhand item's use handler runs.
3. **Totem of undying** (offhand): on lethal damage, if offhand holds a totem →
   consume, restore 1 HP + absorption II + regen II (status/effects system),
   fire the totem-pop particles (Particles.color burst — gold), play the sound
   event. Hook: the damage pipeline's death branch in Player.js BEFORE death
   finalizes.
4. **Clock** (item, no durability): HUD-side dial — renders day/night phase
   (icon tile frames in the atlas; ANIMATED entry if the dial animates — ride
   `paintFrames` per Iron Rule 6). **Compass:** points to world spawn
   (HUD-side needle icon rotated by yaw — a CSS-rotated icon in hud.js).
   Neither opens a UI; both are passive HUD items when held/in inventory hotbar
   (MC parity).
5. **Recipes:** rod (3 sticks + 2 string), shield (6 planks + 1 iron), totem
   (NOT craftable — dungeon loot only, ties B5), clock (4 gold + redstone),
   compass (4 iron + redstone).
6. **U17 — pure-logic:** fishing roll distribution test (fixed rng, assert
   category weights + open-water bonus shifts within tolerance) + totem
   consume-before-death unit test against a stubbed damage pipeline + item
   registry integrity (U5 pattern: ids, recipe ingredient validity).

**Acceptance:** in-game: cast/reel works in any water; shield blocks a zombie
hit with visible durability loss; totem saves a lethal creeper blast; U17
green; `npm run verify` green.

**Out of scope:** fishing enchantments (Lure/Luck of the Sea — enchanting
system supports it later), rain-fishing bonus (B8 can add it).

---

# B3 — Feel & combat polish

**Goal:** the game reads "juicy" without new systems. Pure polish, mostly HUD
+ Particles + camera.

**Files:** `src/ui/hud.js` (+ cooldown/charge bars), `src/render/Particles.js`
(emitters), `src/Game.js` / `src/player/interaction.js` (attack feel hooks),
`src/audio/events.js` (new recipes only, no engine changes), `src/ui/options.js`
(toggles), `scripts/smoke.mjs` (U18 — options surface).

**Spec:**

1. **Attack cooldown indicator:** thin bar above the hotbar, fills at
   `(1 - cooldown/20)`, flashes on ready. Data already exists
   (attack damage scales with cooldown — reuse the same timer).
2. **Bow charge indicator:** same bar component, charge = draw progress
   (bow use state in interaction.js).
3. **Hit feedback:** crits spawn a gold particle burst (Particles.color) +
   a dedicated sound event; melee hits apply 2-tick hit-pause on the TARGET
   entity's walk-cycle only (visual, not physics — a Mob.animate(a) gate).
4. **Screen shake** (option, default OFF, accessibility): 1-tick 0.15-block
   camera offset on player damage/explosion — implemented as a render-side
   camera offset (Game.render), never touching `player.pos` (collision purity).
5. **Footstep surface variants:** audio events keyed by the block UNDER the
   player (grass/sand/stone/wood/water-splash) — the events table gets
   per-surface recipes; Player.js footstep timer picks by block id. Cheap,
   high-feel.
6. **Block-place/break particles:** break = 8-14 debris with the block's atlas
   rects (debris pool exists), place = 4 with a small upward bias.
7. **U18:** options surface test (each new toggle persists + applies via the
   onOptions path) + sound-event id resolution for new recipes (U6 machinery).

**Acceptance:** U18 green; `npm run verify` green; manual feel pass.

**Out of scope:** controller rumble (B11 pairs it with gamepad), camera FOV
kick (exists via sprint fovScale).

---

# B8 — Weather expansion (thunder, snow, fog)

**Goal:** atmosphere with existing hooks: `DayNight.rainLevel`, `ScheduledTicks`,
`fire.js`, and the audio engine.

**Files:** `src/env/DayNight.js` (thunder scheduling), NEW
`src/world/thunder.js`, `src/world/snow.js`, `src/mesh/biomeTints.js` NO — fog
table goes NEW `src/env/fogTable.js` + `src/mesh/materials.js` (uniform
writes), `scripts/smoke.mjs` (U19).

**Spec:**

1. **Thunder:** during rain (rainLevel > 0.6), per-tick chance ~1/20000 per
   loaded region near the player: strike at a random surface cell within 64
   blocks (heightTop). Effects: white flash (DayNight ambient spike, 2 ticks),
   bolt visual (a thin bright column of Particles or a 1-tick emissive box),
   fire ignite at the strike cell (reuse `fire.js igniteAt` with `canSurvive`
   check), BOOM sound delayed by distance/343 m/s using the existing audio
   scheduling (at() helper). Mobs within 3 blocks take 5 damage (fire damage
   type). Charged-creeper: skip.
2. **Snow accumulation:** during rain AND biomeAt(cell) == SNOWY: scheduled
   tick (existing ScheduledTicks system) adds/stacks `snow_layer` on solid
   ground (state nibble = height 1..8 — verify snow_layer's state contract in
   blocks.js and honor it). Melting: warm biomes + clear sky melt one layer
   per random tick. Player-path: snow layers are non-collidable (existing
   collision box already reflects this — verify).
3. **Per-biome fog:** a fog table keyed by biome id (mirror biomeTints.js
   structure — a pure table, node-testable): OCEAN/RIVER higher density +
   bluer tint; DESERT warmer + far; SNOWY pale; TAIGA cool. DayNight writes
   the shared uniforms `uFogColor/uFogNear/uFogFar` per tick from a blend of
   (biome at player, time of day, rainLevel) — smooth lerp over 2s to avoid
   pops when crossing biome borders.
4. **U19:** snow accumulate/melt state machine unit test (synthetic chunk,
   scheduled ticks advanced manually); fog table coverage (every BIOMES enum
   value has an entry — fail on undefined); thunder strike roll determinism
   (fixed rng).

**Acceptance:** rain in a snowy biome visibly accumulates snow over minutes;
thunder is rare and loud-but-delayed; fog blends smoothly; U19 green.

**Out of scope:** lightning rods, skeleton horse traps, weather-command
(interface stays console-free).

---

# B6 — Raids & village life

**Goal:** villages become a game loop. Depends on B5 (loot/chests exist) and
B7 (mobs navigate the village properly).

**Files:** NEW `src/world/Raid.js`, `src/entities/mobs/villager.js` (hero/
discount hooks), `src/entities/mobs/Mob.js` or NEW raid mob class, `src/ui/hud.js`
(+ BossBar reuse for the raid wave bar), `src/registry/items.js` (omen/hero
effects are status effects — `src/status/effects.js`).

**Spec:**

1. **Bad Omen:** killing a **Marauder captain** (new hostile humanoid mob,
   villager-model with a dark robe variant — reuse villager_robe painter with
   a dark palette entry) grants `BAD_OMEN` effect (30 min). Entering a village
   (bell within 32 blocks — bell is in-registry) with omen → Raid starts.
2. **Raid structure:** waves scale by village size (villager count): wave
   count 2/3/4; per wave spawn Marauders + existing hostiles (zombies/
   skeletons/spiders) around the bell perimeter on walkable cells (B7 grid).
   Wave completes when all raiders dead. Raid wins if all villagers die or
   the bell is broken mid-raid → villagers lost. Hero: last wave → `HERO`
   effect (trades discount in villager.js trading hooks + XP burst).
3. **Raid bar:** BossBar (exists) shows wave X/Y + remaining count, purple.
4. **Persistence:** raid state in the save (world-level record like
   scheduledTicks' persistence contract — check SaveManager's world-meta
   pattern; raids must survive reload mid-wave).
5. Acceptance + smoke (U20): raid wave state machine unit test (synthetic
   village fixture: start, wave spawn, clear, next wave, win/lose paths, omen
   gating) + persistence round-trip of raid state.

**Out of scope:** pillager outposts, ravagers/beasts (new boss-tier models —
v1.4), raid farms mechanics.

---

# B12 — "The Hollow" underground biome + miniboss

**Goal:** the first NEW content dimension-flavor: a below-y-20 cave biome with
its own blocks, ambience, loot, and a miniboss — sized for one phase. (A full
new DIMENSION — floating islands — is v1.4 and listed at the end.)

**Files:** `src/world/gen/biomes.js` (HOLLOW biome + depth/noise selector),
`src/registry/blocks.js` (+3 blocks: hollow_stone, echo_shard_ore → drops
echo_shard ITEM, hollow_growth light-4 plant), `src/assets/tilePainters.js`
(+3 painters — atlas has room: 404/1024), `src/world/gen/features.js`
(decoration), `src/entities/mobs/` NEW `Sentinel.js` (miniboss), `src/audio/`
(new ambient recipe — existing generative engine), `scripts/smoke.mjs` (U21).

**Spec:**

1. **Biome selection:** underground-only: `biomeAt` for a column returns
   HOLLOW when `y < 24 && caveNoise(seed, x, z) > threshold` — read biomes.js
   for the existing underground-biome handling pattern and extend, don't fork.
   Ocean floor/bedrock layers excluded.
2. **Blocks:** hollow_stone (dark teal-gray, hardness ~2, blast-resistant 9 —
   wither-resistant feel), echo_shard_ore (rare, drops echo_shard, needs iron
   pick), hollow_growth (cross-shape, light 4, decorative — the biome's glow
   source so it's navigable without torches but stays moody).
3. **The Sentinel (miniboss):** spawns 1 per ~40×40 HOLLOW region (deterministic
   spawn point like villages' herds — seeded), a 2.9-tall armored humanoid
   (iron_golem-model scale variant + own palette), 100 HP, slow, ranged
   sonic attack (new projectile? simplest: a straight-line area attack with
   2-tick windup + knockback + brief darkness effect — reuse the existing
   area-damage patterns from bossHooks). Drops echo_shards (3-6) + a totem
   chance (ties B4). NO boss bar (miniboss scale).
4. **Ambience:** HOLLOW biome ambience cue (low drone) via the existing
   ambience.js table; blind-dark feel comes from the light engine (no sky
   contribution below heightTop — already true in caves).
5. **U21:** biome selection determinism + exclusion (no HOLLOW at y≥24 or in
   oceans), ore drops resolve (U5 machinery), Sentinel stat/drop integrity,
   growth light value present in the registry (light table sanity).

**Acceptance:** dig down to y<20 in a Hollow region → teal stone, glowing
growth, one Sentinel; U21 green; `npm run verify` green.

**Out of scope:** sculk sensors/velocity mechanics, warden darkness effect
(new screen effect — v1.4), echo-location UI.

---

# B9 — Occlusion culling

**Goal:** stop drawing buried geometry. Largest perf lever remaining; depends
on B1 (light workers keep the pipeline smooth while culling changes land).

**Files:** `src/mesh/ChunkMesher.js` (worker emits a visibility summary),
`src/mesh/meshWorker.js` (transfer it), `src/world/ChunkManager.js` (renderer
gate), `src/render/renderer.js` or Game.render (skip logic), `scripts/smoke.mjs` (U22).

**Spec:**

1. **Per-chunk visibility summary computed at mesh time** (worker already has
   the data): a Uint8Array(16×16) of per-column `exposedTop` (does any cell in
   the column have a face visible from above/at the heightmap?) + a 6-bit
   per-face-direction mask `hasView[dx,dz]`: does ANY visible face of this
   chunk touch a border column/row whose neighbor (in that direction) contains
   air at the touching height? Compute from the existing face-visibility data
   during the greedy/scan pass — NO second pass over cells.
2. **Renderer gate:** when frustum-culling chunk groups, additionally skip a
   chunk whose 3×3 neighborhood summary proves no visible face can face the
   camera: cheap conservative test using the per-direction masks of the
   chunk and its neighbors (a chunk fully enclosed by solid neighbors with no
   border views is skipped). Conservative = never hides a visible face; when
   in doubt, DRAW.
3. **Mesh-work reduction (the real win):** cave cells enclosed in solid get
   skipped by the EXISTING face-visibility culling already — the win here is
   DRAW-CALL + fill-rate reduction. Track with F3: `drawn chunks / resident`.
4. **U22:** summary correctness on the U9 grids: every chunk with ≥1 visible
   face reports a non-zero mask; synthetic fully-buried chunk reports all-zero
   → the renderer gate test (pure function: given masks + camera dir, expected
   skip) unit-tested in node.

**Acceptance:** cave-heavy seed shows ≥30% drawn-chunk reduction at fixed
position; ZERO visible holes (manual sweep over the U9 world seed flying the
camera); U22 green.

**Out of scope:** portal/room-based culling, frustum-aligned chunk
subdivision, software visibility solver.

---

# B10 — Post-processing "Fancy" pass

**Goal:** optional single-pass post: bloom (lava/glowstone/portal pop),
vignette, subtle color grade. Off by default; a "Fancy graphics" option.

**Files:** NEW `src/render/post.js`, `src/Game.js` (render path swap),
`src/ui/options.js` + menus (toggle), `scripts/smoke.mjs` (U23).

**Spec:**

1. **Pipeline:** render scene → WebGLRenderTarget (half-res for bloom only —
   main pass full-res) → bright-pass threshold shader (luminance > 0.85, from
   the unlit pipeline's flat colors this is reliable) → separable blur (2 taps
   passes at half-res) → composite fullscreen quad (scene + bloom × intensity
   + vignette mask + saturation). ONE render target chain, allocated once,
   resized with the renderer.
2. **Game.render integration:** when `options.fancy` is on, the main scene
   renders to the target, then the composite quad renders to screen; the
   VIEWMODEL pass ordering (manual depth clear) must be preserved — the
   viewmodel renders AFTER composite into the default framebuffer (check
   Game.render's two-pass structure and keep both passes' clear behavior
   identical).
3. **Budget:** half-res bloom chain + fullscreen composite ≤ ~2ms at 1080p on
   integrated GPUs; the toggle drops all passes (no swapchain churn).
4. **U23:** option persists + live-applies; render-target resize handler
   unit-testable (pure sizing math); no-render-when-off asserted (state
   machine test with a stubbed renderer).

**Acceptance:** toggle on → lava/glowstone/portal visibly bloom, vignette
subtle; toggle off → pixel-identical to baseline (screenshot diff); F3 frame
time delta documented.

**Out of scope:** SSAO (greedy AO already baked), motion blur, TAA.

---

# B11 — Platform: PWA + touch + gamepad + world export/import

**Goal:** "a website" → "a game you keep". Ship as the LAST engine phase.

**Files:** `vite.config.js` (PWA build hooks), NEW `public/sw.js` + NEW
`scripts/gen-pwa-manifest.mjs` (mirror gen-theme-manifest.mjs pattern),
`public/manifest.webmanifest`, `src/player/input.js` (touch + gamepad layers),
`src/ui/menus.js` (+touch hints), NEW `src/world/exportWorld.js`,
`src/save/saveManager.js` (export/import hooks + thumbnail), `scripts/smoke.mjs` (U24).

**Spec:**

1. **PWA:** service worker precaches the build's asset list (generated at
   buildStart like the theme manifest) + a runtime cache-first strategy for
   `assets/`; version-bumped stale cleanup. `manifest.webmanifest`: name,
   icons (generate 192/512 from `public/menu/logo-primary.png` at build),
   `display: fullscreen`, orientation landscape. Install prompt surfaced
   quietly on the title screen (a small "Install" text button, dismissible).
   Offline play works for single-player (IndexedDB already local); the
   multiplayer button shows a graceful "needs connection" toast when offline
   (navigator.onLine).
2. **World export/import:** `exportWorld()` serializes the save's records
   (world meta + edited chunks + player) into a single `.ccworld` binary
   (magic header + version + the SAME record format the save uses — do NOT
   invent a second serialization; reuse saveManager's encode/decode for a
   byte-exact round-trip). Import validates the header + schema version and
   installs as a NEW world slot. Title screen: Export/Import buttons on the
   world list. **Thumbnail:** at world save time, render one 128×72 frame
   offscreen (renderer.setRenderTarget tiny RT, or draw the current frame
   downscaled from a captured frame) → dataURL → stored in world meta →
   title-screen world cards show it.
3. **Touch:** coarse-pointer detection (`matchMedia('(pointer: coarse)')`) →
   virtual joystick (left, move) + drag-look zone (right) + buttons: jump,
   sneak, place-mode toggle, hotbar strip tappable, inventory button. All
   input funnels through Input.js's existing action surface (pointer-lock
   bypassed; canvas touch handlers registered only in touch mode). Menus get
   a touch-friendly hint line. BLOCK touch handling entirely when a real
   mouse/keyboard event fires last (hybrid devices).
4. **Gamepad:** Gamepad API polled per frame in Input.js: left stick move,
   right stick look (with curve + deadzone), A jump, RT attack/use, LT
   sneak, dpad/hotbar, Y inventory, B drop. Button hints line on the pause
   screen. Rumble: 80ms on hurt (if `gamepad.vibrationActuator` exists).
5. **U24:** `.ccworld` round-trip unit test (encode → decode → record-level
   equality on a synthetic save fixture); manifest generation script output
   sanity (icons exist, sizes valid); input mapping table completeness (every
   action in Input.js's action set has a gamepad binding or an explicit
   `null`).

**Acceptance:** Lighthouse PWA installable; plays offline after first load;
touch device fully playable start-to-death; `.ccworld` export→import→load
produces an identical world (seed + edits + player position).

**Out of scope:** cloud sync, cross-device play, multiple pads, remappable
touch layouts.

---

# v1.4 candidates (parked, NOT in this build-out)

- **Skyshelf dimension** — floating-island sky realm via the endArena
  architecture + a buildable portal frame; own ambient layer + 2 mobs.
- **Slabs/stairs** — blocked today by the collision solver's no-slab branch
  (03 §10 adaptation note). Requires: collision stepHeight 0.6 path, mesher
  shapes, placement states. Large; schedule alone.
- **Echo-location / darkness mechanic** for the Hollow's expansion.
- **Tridents, rain-fishing bonus, enchanting for fishing rod** (hooks noted
  in B4/B8).
- **Raid beast (Ravager-class)** new model tier.
- **GitHub Actions CI** running `npm run verify` + deploy preview.

---

## Session log (append per phase — keep this doc as the single tracking truth)

| Date | Phase | Session | Commit | Result |
|---|---|---|---|---|
| 2026-09-27 | — | GLM 5.3 flash | `7234d22` | ⚠ shipped broken (invisible world); fixed in `ee7c5ae` |
| 2026-09-27 | — | GLM 5.3 flash (recovery) | `ee7c5ae` | greedy extents + worker tileIndex + staging needsUpdate + mob materials + texture overhaul + U9/U10 |
| 2026-09-27 | B0 | Claude (build-out) | B0 commit | U11 registry-field contract + U12 worker purity + `npm run verify`; 12/12 |
| 2026-09-27 | B2 | Claude (build-out) | B2 commit + fixup | GLSL3 textureGrad seam fix; U13 initially read MASKED (template literals are blanked) — fixed to inspect raw source; NOTE: renderer.js WebGL2 assert skipped (three r185 hardcodes isWebGL2=true); U13 was briefly committed red by a chained command — fixed forward next commit |
| 2026-09-27 | B1 | Claude (build-out) | B1 commit | LightBFS grid refactor (WorldGrid/HoodGrid), lightWorker pool, promote dispatch + sync fallback; U14 parity byte-identical (228k/83k delta writes) + no-Worker fallback gate 49/49; DEVIATIONS from spec: emitTable dropped (workers import pure blocks.js legally — U12-guarded), pendingLight set dropped (hoodAtLeast already gates it), light pool init moved to CONSTRUCTOR (initWorkers-time init left pre-startWorld ticks with undefined pools — the fallback check caught it) |
| 2026-09-27 | B7 | Claude (build-out) | B7 commit | AUDIT result: A* pathfinding was already fully implemented in ai.js (standable/MinHeap/findPath + Mob.pathTo/followPath/chaseTarget with budget, repath cadence, stall detection, direct-steer fallback) — no engine changes needed; U15 pins gap/step/water/budget/determinism. Harness note: astar budget is consumed by findPath calls, not astarBudgetOk probes |
| — | NEXT | | | Next phase per ship order: **B4 items & systems** (then B3, B8, B6, B12, B9, B10, B11). Harness now at 16 checks (U1–U16) |
| 2026-09-27 | B5 | Claude (build-out) | B5 commit | dungeons.js stamper (village-architecture clone: origin-derived plan, ±1 chunk reach, per-cell fixed draw order); mossy_cobblestone (id 144 + tile + painter + stone material class — the registry warning caught the missing mat); dungeon/desert_ruin loot pools in endLoot.js; spawn records ride the existing be:'spawner'/be:'chest' pipeline; U16 pins integrity/loot/seed-variation; NOTE: dungeon loot applies only to NEWLY generated chunks (existing explored chunks keep their state) |