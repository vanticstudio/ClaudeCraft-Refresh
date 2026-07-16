# 01 — ARCHITECTURE: Engine & Technical Spec

This file specifies the complete technical engine for the Minecraft clone: project setup, game loop, chunk data model, meshing, texture atlas, workers, raycasting, physics, entities, lighting data flow, sky rendering, UI shell, save/load, and performance budgets. It defines HOW the engine works; sibling files define WHAT runs on it: CLAUDE.md (master plan and phase expansion), 02-WORLD-GENERATION.md (terrain/biome/cave/ore algorithms that run inside the worker defined here), 03-PLAYER.md (movement/mining constants consumed by the physics and raycast systems here), 04-TIME-LIGHT-WEATHER.md (light propagation rules and sky color tables plugged into the lighting engine and sky dome here), 05-MOBS-COMBAT.md (entity subclasses built on the Entity base class here), 06-ITEMS-CRAFTING-SURVIVAL.md (canonical block/item ID tables and UI screen contents rendered by the UI shell here). Baseline: Minecraft Java ~1.20 mechanics; 1 block = 1 m; 20 ticks/s; world Y 0–127, chunks 16×128×16. Redstone, pistons, villages, and non-Overworld dimensions are out of scope project-wide (see CLAUDE.md).

## Contents

1. [Stack, dependencies & project setup](#1-stack-dependencies--project-setup)
2. [Module map (every file, one-line responsibility)](#2-module-map)
3. [Core loop & scheduling](#3-core-loop--scheduling)
4. [Coordinates, chunk data model & streaming](#4-coordinates-chunk-data-model--streaming)
5. [Block registry (engine-facing schema)](#5-block-registry-engine-facing-schema)
6. [Block updates, scheduled ticks & fluids](#6-block-updates-scheduled-ticks--fluids)
7. [Texture atlas pipeline](#7-texture-atlas-pipeline)
8. [Chunk meshing: culled faces, AO, buffers, materials](#8-chunk-meshing)
9. [Terrain generation workers](#9-terrain-generation-workers)
10. [Lighting engine: data structures & scheduling](#10-lighting-engine-data-structures--scheduling)
11. [Voxel raycasting (Amanatides & Woo DDA)](#11-voxel-raycasting)
12. [Physics: AABB vs voxel grid](#12-physics-aabb-vs-voxel-grid)
13. [Entity system](#13-entity-system)
14. [Sky & environment rendering](#14-sky--environment-rendering)
15. [Input, pointer lock & UI shell](#15-input-pointer-lock--ui-shell)
16. [Save/load: IndexedDB](#16-saveload-indexeddb)
17. [Performance budget & known pitfalls](#17-performance-budget--known-pitfalls)
18. [Implementation order](#18-implementation-order)
19. [Acceptance checklist](#acceptance-checklist)

---

## 1. Stack, dependencies & project setup

Verified current versions (July 2026): three.js **r185** (npm `three@0.185.1`, released 2026-07-01), **Vite 8.1.x** (Rolldown-based bundler; requires Node 20.19+ or 22.12+).

```json
// package.json
{
  "name": "mc-clone",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "three": "0.185.1",
    "simplex-noise": "^4.0.3",
    "alea": "^1.0.1"
  },
  "devDependencies": {
    "vite": "^8.1.4"
  }
}
```

`three`, `simplex-noise`, and `alea` are the ONLY runtime dependencies. No physics library, noise via simplex-noise v4 + alea, worker-side only (02 §4.1), no UI framework, no state library, no IndexedDB wrapper library.

```js
// vite.config.js
export default {
  base: './',
  build: { target: 'es2022' },
  worker: { format: 'es' }   // terrain worker uses ES module imports
};
```

Renderer bootstrapping (src/render/renderer.js):

```js
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,               // pixel aesthetic; MSAA wasted on 16px texels
  powerPreference: 'high-performance',
  stencil: false
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // pass-through, see below
renderer.toneMapping = THREE.NoToneMapping;
renderer.sortObjects = true;       // needed for back-to-front transparent chunk order
```

**Color pipeline decision:** the whole game runs in gamma space. `renderer.outputColorSpace = LinearSRGBColorSpace` (disables three's output encode), every texture gets `colorSpace = THREE.NoColorSpace`, and all light/AO multiplications happen directly on sRGB texel values.

> Adaptation: Minecraft multiplies its light/AO brightness directly against sRGB texels (gamma-space shading). Reproducing that exactly requires bypassing three.js r152+'s linear-workflow defaults; a physically "correct" linear pipeline would make caves and dusk look noticeably different from MC. Pass-through is also simpler: no `#include <colorspace_fragment>` needed in the custom chunk shaders.

WebGL2 + `WebGLRenderer` is the baseline. `WebGPURenderer`/TSL is NOT used (custom GLSL shaders below assume WebGL2 GLSL ES 3.00 via three's shader system).

Camera: `THREE.PerspectiveCamera(70, aspect, 0.05, 1000)` — fov 70 = MC default, near 0.05 per 03 §18.2; far 1000 covers the sky dome (04 §5).

`index.html` contains: `<canvas id="game-canvas">`, `<div id="overlay">` (all DOM UI), `<div id="screens">`. CSS in a single `src/ui/style.css`, `image-rendering: pixelated` on every texture-derived element.

Dev affordance: `if (import.meta.env.DEV) window.game = game;` for console poking. No other environment branching.

---

## 2. Module map

Every file, one-line responsibility. Files marked with an owner file get their algorithms/values from that sibling spec; the skeleton and interfaces are still built as declared here.

```
mc-clone/
├── index.html                     Canvas + overlay DOM skeleton, loads /src/main.js as module
├── package.json                   Deps pinned per §1
├── vite.config.js                 Per §1
└── src/
    ├── main.js                    Entry: build atlas, construct Game, title screen wiring, rAF start
    ├── Game.js                    Owns loop (§3), system construction/wiring, pause & screen state machine
    ├── constants.js               Every engine tunable in this file (radii, budgets, tick ms, keybinds map)
    ├── math/
    │   ├── rng.js                 xmur3 string hash + mulberry32 PRNG (used by atlas, worldgen via 02, loot via 06)
    │   └── aabb.js                AABB class: min/max, overlap tests, expand, translate
    ├── assets/
    │   ├── atlas.js               Builds 512×512 canvas atlas + THREE.CanvasTexture + tile UV lookup (§7)
    │   └── tilePainters.js        One 16×16 painter function per tile name; deterministic via rng.js
    ├── registry/
    │   ├── blocks.js              Block registry: engine flags per §5; canonical ID/name/hardness table from 06
    │   └── items.js               Item registry, stack sizes, tool tiers            [owner: 06]
    ├── world/
    │   ├── World.js               Facade: getBlock/setBlock/getLight world-coords API, block update fan-out (§6)
    │   ├── Chunk.js               Chunk class: typed arrays, state enum, dirty flags, mesh handles (§4)
    │   ├── ChunkManager.js        Streaming, worker dispatch, state promotion, remesh queue (§4, §9)
    │   ├── LightEngine.js         Sky+block BFS flood/unflood queues, initial light, incremental relight (§10) [rules: 04]
    │   ├── raycast.js             Amanatides & Woo voxel DDA (§11)
    │   ├── scheduledTicks.js      Bucket queue for fluid/block scheduled updates + random tick dispatch (§6)
    │   ├── fluids.js              Water/lava spread rules on top of scheduledTicks (§6)
    │   └── gen/                   Pure generation code, imported ONLY by the worker (exception: features.js is pure and may be imported by the main thread for sapling growth, 06 §5.12)   [owner: 02]
    │       ├── noise.js           simplex-noise+alea layer instances + fbm/ridged octaves (02 §4) [owner: 02]
    │       ├── terrain.js         generateChunk(seed,cx,cz) → blocks+heightMap        [owner: 02]
    │       ├── biomes.js          Biome selection & per-biome surface rules           [owner: 02]
    │       ├── caves.js           Cave carving                                        [owner: 02]
    │       ├── ores.js            Ore vein placement                                  [owner: 02]
    │       └── features.js        Trees/plants/structures, deterministic cross-chunk  [owner: 02]
    ├── workers/
    │   └── terrainWorker.js       Worker entry: init(seed) / generate(cx,cz) protocol (§9)
    ├── mesh/
    │   ├── ChunkMesher.js         Culled-face mesher: AO, vertex light, 3 buckets, scratch buffers (§8)
    │   ├── faceTables.js          Per-face corner/uv/AO-neighbor constant tables (§8)
    │   └── materials.js           The 3 shared ShaderMaterials (opaque/cutout/water) + uniforms (§8)
    ├── render/
    │   ├── renderer.js            WebGLRenderer + camera + resize per §1
    │   ├── Sky.js                 Sky dome shader, sun/moon quads, stars, fog uniform sync (§14) [colors: 04]
    │   ├── EnvLights.js           DirectionalLight (sun) + AmbientLight for entities (§14)       [values: 04]
    │   └── Particles.js           Tiny pooled cube-sprite particle helper used by 03 §15.3, 05 §16.3, 06 §6.3
    ├── physics/
    │   └── collision.js           Axis-separated AABB-vs-voxel move-and-slide + fluid overlap queries (§12)
    ├── entities/
    │   ├── Entity.js              Base class: fixed-tick update, interpolation, AABB, light sampling (§13)
    │   ├── EntityManager.js       ID allocation, per-chunk spatial index, tick/render dispatch, removal (§13)
    │   ├── Player.js              Player entity: movement state machine, camera anchor   [owner: 03]
    │   ├── ItemEntity.js          Dropped item: physics, merge, pickup, despawn          [rules: 06]
    │   ├── Arrow.js               Projectile: ballistic flight, block/entity hit         [owner: 05]
    │   ├── FallingBlock.js        Sand/gravel falling entity (§6)
    │   ├── PrimedTnt.js           Ignited TNT entity: fuse, pulse render, power-4 explosion [owner: 06 §5.6]
    │   ├── XpOrb.js               XP orb entity: magnet, pickup, lifetime                [owner: 05 §15]
    │   ├── ThrownProjectile.js    Egg / snowball / ender pearl projectile                [owner: 06 §7.4]
    │   └── mobs/                  Mob.js base + Zombie/Skeleton/Creeper/Spider/Cow/Pig/Sheep/Chicken + ai/ [owner: 05]
    ├── player/
    │   ├── input.js               Keyboard/mouse capture, keybind map, pointer lock flow (§15)
    │   └── interaction.js         Hold-to-mine progress, place/use dispatch, reach raycast [constants: 03, 06]
    ├── ui/
    │   ├── style.css              All UI styling; pixelated rendering; UI scale var
    │   ├── hud.js                 Crosshair, hotbar, hearts, hunger, armor, air, XP bar   [layout: 06, values: 03]
    │   ├── debug.js               F3 overlay: fps, pos, chunk states, draw calls, light at feet
    │   ├── menus.js               Title / pause / death / loading screens + world create-delete
    │   └── containers.js          Inventory, crafting table, furnace, chest screens      [owner: 06]
    ├── env/
    │   └── DayNight.js            worldTime advance, sun angle, uSkyDarken/uSkyTint + env sunIntensity + sky/fog color feed [owner: 04]
    └── save/
        └── saveManager.js         IndexedDB open/schema, autosave, chunk hydrate, world delete (§16)
```

52 source files. Nothing else. New functionality goes into these files, not new files, unless CLAUDE.md's plan says otherwise.

---

## 3. Core loop & scheduling

Fixed-timestep logic at 20 TPS with an accumulator; rendering every animation frame with interpolation alpha.

```js
// Game.js
const MS_PER_TICK = 50;            // 20 TPS
const MAX_TICKS_PER_FRAME = 5;     // catch-up cap

let accumulator = 0;
let lastTime = performance.now();

frame(now) {
  requestAnimationFrame(this.frame);
  const frameDelta = Math.min(now - lastTime, 250);  // clamp tab-switch / GC stalls
  lastTime = now;

  if (this.state === 'PLAYING' || this.state === 'PLAYING_UI') {
    accumulator += frameDelta;
    let ran = 0;
    while (accumulator >= MS_PER_TICK && ran < MAX_TICKS_PER_FRAME) {
      this.tick();                 // exactly 50 ms of game logic
      accumulator -= MS_PER_TICK;
      ran++;
    }
    if (ran === MAX_TICKS_PER_FRAME) accumulator = 0;  // drop debt: slow-motion, never spiral
  }
  const alpha = accumulator / MS_PER_TICK;             // 0..1 interpolation factor
  this.render(alpha);
}
```

Rules:

- `tick()` is the ONLY place game state mutates (except player-edit remesh, which is render-side geometry only). Rendering never writes gameplay state.
- Pause (`PAUSED` state, §15) freezes the accumulator; on resume, `lastTime = performance.now()` and `accumulator = 0` so no catch-up burst fires.
- `PLAYING_UI` (inventory/chest open) keeps ticking — matches MC single-player behavior where the inventory screen does not pause the world; the Esc pause menu does.
- Every entity stores `prevPos`/`prevYaw` at the START of its tick; render interpolates `prev → current` by `alpha`. The camera uses the player's interpolated position (§13).

Tick order inside `Game.tick()` (deterministic, always this order):

| # | Step | Notes |
|---|------|-------|
| 1 | `input.snapshot()` | Latch pressed keys + mouse deltas + click edges into an immutable frame struct |
| 2 | `player.tick()` | Movement intent → physics → mining/placing via interaction.js (03) |
| 3 | `entityManager.tick()` | Mobs (AI+physics), items, arrows, falling blocks; despawn/removal (05/06) |
| 4 | `scheduledTicks.run()` | Fluids + queued block updates due this tick (§6) |
| 5 | `world.randomTicks()` | 24 random positions per sim-radius chunk (§6) |
| 6 | `dayNight.tick()` | `worldTime++`, mob-spawn light thresholds read this (04) |
| 7 | `mobSpawner.tick()` | Natural spawn/despawn cycle (05) |
| 8 | `chunkManager.tick()` | Stream requests, worker results intake, state promotion, unload (§4) |
| 9 | `saveManager.tick()` | Autosave counter (§16) |

Render order inside `render(alpha)`:

1. Drain remesh queue within budget: ≤ 6 ms or ≤ 4 chunks, nearest-first (§4).
2. Interpolate camera from player state; update sky dome position/colors, fog uniforms, `uSkyDarken`/`uSkyTint` (chunks) + `sunIntensity` (env lights, 04 §6), sun/moon pivot (04 values).
3. Update entity `Object3D` transforms with `alpha`; per-entity light scalar (§13).
4. `renderer.render(scene, camera)`.
5. `hud.update()` — dirty-checked DOM writes only; `debug.update()` at 4 Hz.

Budgets: tick ≤ 10 ms (typical < 3 ms), render CPU-side ≤ 8 ms, remesh ≤ 6 ms and only when the queue is non-empty. If a tick exceeds 40 ms twice in a row, log a console warning with per-step timings (dev builds time each tick step).

---

## 4. Coordinates, chunk data model & streaming

### 4.1 Coordinate conventions

- World block coords: integers `x, z ∈ [−1,000,000, 1,000,000]`, `y ∈ [0, 127]`. +X = east, +Z = south, −Z = north (sun rises +X, per 04).
- Chunk coords: `cx = Math.floor(x / 16)`, `cz = Math.floor(z / 16)`. For integer x: `cx = x >> 4` (correct for negatives).
- Local coords: `lx = x & 15`, `lz = z & 15` (correct for negatives), `ly = y`.
- Chunk key: `` const key = cx + ',' + cz `` — used for the chunk map and the IndexedDB chunk store.

> Adaptation: world border is ±1,000,000 blocks (MC: ±29,999,984). Physics clamps entity positions to the border; the generator refuses coordinates beyond it. Float precision is safe at this range because vertices are chunk-local and matrix composition happens in JS doubles (§17).

### 4.2 Chunk storage

One chunk = full column, 16×128×16 = 32,768 cells. All per-cell data is flat typed arrays with a single shared index formula:

```js
// x,z ∈ [0,15], y ∈ [0,127]  →  i ∈ [0, 32767]
const blockIndex = (x, y, z) => (y << 8) | (z << 4) | x;
// inverse: x = i & 15; z = (i >> 4) & 15; y = i >> 8;
```

(Y-major: one Y-layer = 256 contiguous bytes — cache-friendly for the lighting BFS and heightmap scans.)

```js
class Chunk {
  cx; cz;
  blocks     = new Uint8Array(32768);  // block ids, 0 = air (32 KB)
  states     = new Uint8Array(32768);  // per-voxel state nibble per 06 §1 (fluid level, crop stage, facing, open, part, moisture, age, persistent) (32 KB)
  skyLight   = new Uint8Array(32768);  // 0–15 (32 KB)
  blockLight = new Uint8Array(32768);  // 0–15 (32 KB)
  heightMap  = new Uint8Array(256);    // index (z<<4)|x → y+1 of topmost skyOpacity>0 block; 0 = empty column
  biomes     = new Uint8Array(256);    // index (z<<4)|x → biome id (02 §6.1); F3 readout + 04 §12.4 rain-vs-snow
  state      = 'REQUESTED';            // REQUESTED → GENERATED → LIT → MESHED
  dirty      = false;                  // needs remesh
  modified   = false;                  // differs from generator output → must be saved
  blockEntities = new Map();           // blockIndex → {type:'furnace'|'chest', data} (contents per 06)
  entities   = new Set();              // entities whose feet are in this chunk (§13)
  group      = null;                   // THREE.Group at (cx*16, 0, cz*16), matrixAutoUpdate=false
  meshes     = { opaque: null, cutout: null, water: null };  // THREE.Mesh handles
  minY = 0; maxY = 127;                // tight Y bounds from last mesh build (frustum culling)
}
```

Decision: sky/block light are two separate Uint8Arrays, not packed nibbles. Cost: +32 KB/chunk (~12 MB across the full load set); benefit: no shift/mask on every read in the two hottest loops (light BFS, mesher vertex sampling). Total per chunk: 128 KB CPU-side.

`World.getBlock(x,y,z)`: `y < 0 → BEDROCK`, `y > 127 → AIR`, unloaded chunk → `AIR` (callers in gameplay code must check `world.isLoaded(x,z)` before acting on it; the mesher never queries unloaded chunks by protocol §8.6). `World.getSkyLight` above y=127 returns 15.

### 4.3 Chunk map & streaming radii

```js
chunks = new Map();   // "cx,cz" → Chunk
```

| Constant | Value | Meaning |
|---|---|---|
| `GENERATE_RADIUS` | 9 | Chebyshev radius (chunks) around player chunk that must be at least GENERATED |
| `RENDER_RADIUS` | 8 | Radius that must reach MESHED (visible world = 17×17 chunks, 272 m across) |
| `SIM_RADIUS` | 6 | Entities ticked, random ticks, scheduled ticks run only within this radius |
| `UNLOAD_RADIUS` | 11 | Chunks beyond this are saved-if-modified, disposed, deleted (hysteresis ≥ 2 prevents thrash) |
| `WORKER_COUNT` | 2 | Terrain workers (§9) |
| `MAX_JOBS_IN_FLIGHT` | 16 | Outstanding generate requests across all workers |
| `REMESH_FRAME_BUDGET_MS` | 6 | Per-frame remesh time budget |
| `REMESH_FRAME_MAX` | 4 | Per-frame remesh count cap |

`chunkManager.tick()` each tick:

1. Compute player chunk `(pcx, pcz)`.
2. If moved chunk since last tick (or first tick): rebuild the request list — all missing chunks within `GENERATE_RADIUS`, sorted by squared distance to player chunk (spiral order equivalent).
3. Dispatch requests to workers up to `MAX_JOBS_IN_FLIGHT`; chunks present in the save registry hydrate from IndexedDB instead (§16).
4. Promote states (§4.4).
5. Unload pass (every 20 ticks): for each chunk with `chebyshev(c, player) > UNLOAD_RADIUS` → if `modified`, queue save write; dispose `geometry` of all three meshes, remove group from scene, delete from map. Shared materials/atlas are never disposed.

### 4.4 State machine & neighbor protocol

```
REQUESTED --worker result--> GENERATED --self+8 neighbors GENERATED--> LIT --self+8 neighbors LIT--> MESHED
```

- `GENERATED`: `blocks` + `heightMap` arrays installed (from worker transfer or save hydrate).
- `LIT`: `LightEngine.initialLight(chunk)` has run (§10). Requires the full 3×3 neighborhood GENERATED because BFS crosses borders immediately.
- `MESHED`: first mesh built and added to scene. Requires the 3×3 neighborhood LIT because face culling reads face-adjacent neighbor blocks, AO reads diagonal neighbor blocks (a corner vertex at local (0,y,0) samples the chunk at (cx−1, cz−1)), and vertex light averaging reads neighbor light values.

Promotion runs in `chunkManager.tick()`: scan chunks in ascending distance; promote every chunk whose precondition is met; cap initial meshing at 8 chunk builds per tick during world load (loading screen), 4 per frame during play (render-side queue).

### 4.5 Dirty flags & remesh queue

- `markDirty(chunk)`: sets `chunk.dirty = true` and pushes its key into `remeshQueue` (a Set — natural dedup) if state ≥ MESHED.
- A block edit at local `x ∈ {0,15}` or `z ∈ {0,15}` also dirties the face-adjacent neighbor chunk(s); a corner edit dirties the diagonal neighbor too (AO/light of their border vertices changed).
- The light engine dirties every chunk any BFS wrote into (§10).
- Drain (render-side, §3): pop nearest-to-player first; rebuild all three buckets; swap geometry (`old.dispose()`); clear `dirty`.
- Exception for responsiveness: the chunk (and dirtied neighbors) containing a PLAYER edit rebuild synchronously in the same frame as the edit, outside the budget. A block edit therefore always appears within one frame.

### 4.6 setBlock pipeline

```js
World.setBlock(x, y, z, id, { byPlayer = false, state = 0 } = {}) {
  1. chunk = chunks.get(key(x>>4, z>>4)); if (!chunk || y<0 || y>127) return false;
  2. i = blockIndex(x&15, y, z&15); old = chunk.blocks[i]; if (old === id && chunk.states[i] === state) return false;
     chunk.blocks[i] = id; chunk.states[i] = state; chunk.modified = true;   // parallel states write (06 §1)
     if (BLOCKS[old].blockEntity) chunk.blockEntities.delete(i);   // drop contents per 06
  3. heightMap update: if skyOpacity changed at/above current height → raise, or rescan column downward
  4. dirtied = LightEngine.onBlockChanged(x, y, z, old, id);        // synchronous BFS, §10
  5. markDirty(chunk) + border-adjacent neighbors (§4.5) + every chunk in `dirtied`
  6. if (byPlayer) rebuild dirty chunks synchronously this frame
  7. neighborUpdates(x,y,z): for the 6 face neighbors → support check (torch/flowers/crops pop
     as drops per 06), fluid wake-up (§6), falling-block trigger (§6)
  return true;
}
```

---

## 5. Block registry (engine-facing schema)

`registry/blocks.js` exports `BLOCKS`, a dense array indexed by block ID (Uint8 → max 256 blocks; ~60 used). The canonical ID assignment, display names, hardness, tool requirements, and drop tables live in 06-ITEMS-CRAFTING-SURVIVAL.md; 02 uses the same IDs in the generator. The ENGINE consumes exactly these fields:

```js
{
  id: 1, name: 'stone',
  shape: 'cube',          // 'cube' | 'cross' | 'liquid' | 'none' (air)
  bucket: 'opaque',       // 'opaque' | 'cutout' | 'water'  → which mesh bucket (§8.4)
  opaque: true,           // full opaque cube: culls neighbor faces, occludes AO, blocks light
  collidable: true,       // participates in AABB collision (§12)
  targetable: true,       // raycast hit candidate (§11); false for water unless fluidMode
  renderSameIdFaces: false, // leaves: true (MC fancy graphics); water/glass: false
  lightEmission: 0,       // 0–15 (torch 14, lava 15, glowstone 15 — table in 06, rules in 04)
  lightOpacity: 15,       // subtracted during light BFS: opaque 15, air/glass/cross 0,
                          // leaves 1, water 2 (approx; 04 owns the propagation rule)
  skyOpacity: 15,         // >0 terminates the heightmap column (water counts, glass doesn't)
  blockEntity: null,      // 'chest' | 'furnace' | 'crafting' (UI + persistence hooks, 06)
  needsSupport: false,    // torch, flowers, crops: popped when block below/behind removed
  gravity: false,         // sand, gravel → FallingBlock entity (§6)
  tiles: [e, w, up, down, s, n]  // 6 atlas tile indices; shorthand expanders: all(t), column(top,side,bottom)
  // + hardness, toolClass, drops, flammable... consumed by 03/06 systems
}
```

Engine-reserved facts: `id 0 = air` (`shape:'none'`, all flags false). Water and lava are single IDs (06: water=63, lava=64); fluid level lives in the per-voxel state byte per 06 §6.1 (bit3 falling, bits0–2 spread; source = state 0). The mesher and fluid stepper read S = 8 − spread from chunk.states; raycast's isSource test (§11) = same-fluid id && state == 0.

---

## 6. Block updates, scheduled ticks & fluids

Infrastructure lives here; consumers (crop growth 06, grass spread 02, fluid damage 03/05) plug in.

### 6.1 Scheduled ticks

`world/scheduledTicks.js` — bucket queue keyed by absolute tick:

```js
buckets = new Map();  // dueTick(int) → Array<packedPos>   packedPos = "x,y,z" string? NO:
// packed as 3 numbers pushed flat: [x0,y0,z0, x1,y1,z1, ...]
schedule(x, y, z, delayTicks)   // dedup via Set of "x,y,z" per bucket
run() { const b = buckets.get(worldTime); if (b) { buckets.delete(worldTime); for each pos → world.blockTick(x,y,z); } }
```

`world.blockTick` dispatches on block ID: fluids → `fluids.step`, others → registry callback. Positions outside `SIM_RADIUS` chunks are re-scheduled +40 ticks instead of run.

### 6.2 Random ticks

Per tick, for every chunk within `SIM_RADIUS`: pick 24 random cells (MC: randomTickSpeed 3 per 16³ section; 8 sections per column → 24) using the world RNG; if the block's registry entry has `randomTick`, invoke it (grass spread/decay per 06 §5.15, crop/sapling growth per 06 §5.11–5.12, leaf decay per 06 §5.12; light thresholds per 04 §10.3).

### 6.3 Fluids

Exact constants; stepped via scheduled ticks:

| Fluid | Step interval | Max horizontal spread | Levels |
|---|---|---|---|
| Water | 5 ticks (0.25 s) | 7 | source=8 internally, flow 7→1 |
| Lava | 30 ticks (1.5 s) | 3 | S=8, level drop 2/step per 06 §6 |

Rules (run on `fluids.step(x,y,z)`):

1. Compute incoming level: source blocks keep max; flow blocks = `max(neighbor levels) − 1` (down-flow from above = full flow level). If computed level ≤ 0 or no feeder → recede: replace with air, schedule 4 side neighbors + below.
2. If block below is air or a lower-level fluid → flow down (full-strength flow), do not spread sideways.
3. Else spread to each of the 4 sides that is air (or a weaker flow) with `level − 1`, if `level − 1 ≥ 1`.
4. Infinite water: a water cell with ≥ 2 horizontally-adjacent SOURCE neighbors and (solid or source) below becomes a SOURCE.
5. Water meets lava: lava source + water → obsidian; flowing lava + water → cobblestone; schedule neighbors.

> Adaptation: MC's flow direction weighting (4-block downhill search) is replaced by uniform spreading — visually near-identical in practice, far simpler.

### 6.4 Falling blocks

When a `gravity: true` block's support is removed (neighbor update from §4.6 step 7, or on placement over air): `setBlock(air)` + spawn `FallingBlock` entity (holds blockId) at cell center. It falls with entity gravity (0.04/0.98 per 06 §5.1); on landing (`onGround`) → `setBlock(blockId)` at the resting cell; if the resting cell is occupied by a non-replaceable block or a `cross`-shape block → drop as ItemEntity instead.

---

## 7. Texture atlas pipeline

### 7.1 Generation

- One 512×512 `<canvas>` = 32×32 grid of 16×16 tiles = 1024 tile slots. Tile index `t` → `col = t & 31`, `row = t >> 5`, pixel origin `(col*16, row*16)`.
- `assets/tilePainters.js`: `PAINTERS['grass_top'] = (ctx, x0, y0, rng) => { ... }` — pure 2D-canvas drawing (fillRect per pixel is the norm; 16×16 = 256 rects, trivial). Each painter receives `rng = mulberry32(xmur3(tileName)())` so every run of the game produces identical textures.
- `assets/atlas.js` iterates a declared tile-name list (order defines tile indices, exported as `TILE`), paints all tiles, then:

```js
const texture = new THREE.CanvasTexture(atlasCanvas);
texture.magFilter = THREE.NearestFilter;
texture.minFilter = THREE.NearestFilter;   // no mipmap variant
texture.generateMipmaps = false;
texture.colorSpace = THREE.NoColorSpace;   // gamma-space pipeline, §1
texture.flipY = false;                     // v measured from canvas top; uv math below assumes this
```

**Mipmap policy: disabled.** One-line justification: NearestFilter + no mipmaps completely eliminates cross-tile bleeding without gutter padding or per-level repacking; distant shimmer from 16px tiles is mild and further masked by fog (§14).

### 7.2 UV lookup

```js
// half-texel inset guards against float rounding sampling the neighbor tile's edge texel
function tileUV(t) {
  const col = t & 31, row = t >> 5;
  return {
    u0: (col * 16 + 0.5) / 512,  v0: (row * 16 + 0.5) / 512,   // top-left of tile
    u1: (col * 16 + 15.5) / 512, v1: (row * 16 + 15.5) / 512   // bottom-right
  };
}
```

Precomputed once into a `Float32Array(1024 * 4)` consulted by the mesher. Per-face tile selection comes from `BLOCKS[id].tiles[faceIndex]` with face order `[+X, −X, +Y, −Y, +Z, −Z]` (§8.2).

### 7.3 UI reuse

After painting, `atlas.js` exports `atlasDataURL = atlasCanvas.toDataURL('image/png')`. DOM item/block icons are divs with:

```css
.icon { width: calc(16 * var(--px)); height: calc(16 * var(--px));
        background-image: var(--atlas-url); image-rendering: pixelated;
        background-size: calc(512 * var(--px)); }
/* per icon: background-position: calc(-16 * COL * var(--px)) calc(-16 * ROW * var(--px)); */
```

`--px: 3px` is the global UI scale (1 texture pixel = 3 CSS px). Item-only sprites (tools, food) are painted into the same atlas; 06 assigns their tile indices. Zero image files are ever fetched.

---

## 8. Chunk meshing

Culled face meshing (quad per visible face). **Greedy meshing is rejected**: per-vertex AO + per-vertex smooth light means adjacent faces rarely share all four vertex values, collapsing most merge opportunities, and it complicates UVs (tiling a merged quad needs fract() atlas tricks). Culled meshing at these chunk sizes is fast (< 4 ms/chunk) and produces acceptable vertex counts (§17).

### 8.1 Visibility rule

Face of block `a` toward neighbor `b` is emitted iff:

```js
function faceVisible(a, b) {           // a = this block's registry entry, b = neighbor's
  if (b.id === AIR) return true;
  if (b.opaque) return false;
  if (a.id === b.id) return a.renderSameIdFaces;   // leaves true; water/glass false
  return true;                          // transparent neighbor of different type
}
```

Neighbor lookups outside y∈[0,127]: `y<0` → treated opaque (culls the unseeable bottom of the world), `y>127` → air.

### 8.2 Face tables (`mesh/faceTables.js`)

Face order and canonical corner windings (CCW viewed from outside; triangles `(0,1,2)`,`(0,2,3)`):

| # | Face | Normal | Corners v0..v3 (unit cube offsets) | UV per corner (u,v) |
|---|------|--------|-------------------------------------|----------------------|
| 0 | +X east | (1,0,0) | (1,0,0)(1,1,0)(1,1,1)(1,0,1) | (0,1)(0,0)(1,0)(1,1) |
| 1 | −X west | (−1,0,0) | (0,0,1)(0,1,1)(0,1,0)(0,0,0) | (0,1)(0,0)(1,0)(1,1) |
| 2 | +Y up | (0,1,0) | (0,1,1)(1,1,1)(1,1,0)(0,1,0) | (0,1)(1,1)(1,0)(0,0) |
| 3 | −Y down | (0,−1,0) | (0,0,0)(1,0,0)(1,0,1)(0,0,1) | (0,0)(1,0)(1,1)(0,1) |
| 4 | +Z south | (0,0,1) | (0,0,1)(1,0,1)(1,1,1)(0,1,1) | (0,1)(1,1)(1,0)(0,0) |
| 5 | −Z north | (0,0,−1) | (1,0,0)(0,0,0)(0,1,0)(1,1,0) | (0,1)(1,1)(1,0)(0,0) |

UV (0,0) = tile top-left (flipY=false, §7): side textures are upright; ±X and −Z faces are horizontally mirrored relative to +Z — invisible with the procedural tile set (noise/symmetric), matching MC's own don't-care approach. Final uv = `lerp(u0,u1,u), lerp(v0,v1,v)` from `tileUV`.

`FACE_SHADE = [0.6, 0.6, 1.0, 0.5, 0.8, 0.8]` — MC directional shade: top 1.0, bottom 0.5, ±Z 0.8, ±X 0.6.

### 8.3 Per-vertex AO + smooth light (the 0fps rule)

For a face with unit normal `n` and tangent axes `t1`, `t2` (the two non-normal axes), each corner has signs `s1, s2 ∈ {−1,+1}` on those axes (derived from the corner's 0/1 offsets). With `base = blockPos + n` (the cell the face opens into):

```js
const side1  = isOpaqueAt(base + s1*t1);
const side2  = isOpaqueAt(base + s2*t2);
const corner = isOpaqueAt(base + s1*t1 + s2*t2);
// canonical rule (0fps, "Ambient occlusion for Minecraft-like worlds"):
const ao = (side1 && side2) ? 0 : 3 - (side1 + side2 + corner);   // 0..3, 3 = fully open
```

`AO_CURVE = [0.4, 0.6, 0.8, 1.0]` (MC-style 0.2 steps) multiplies brightness.

Smooth light: the same 4 sample cells feed per-vertex light:

```js
cells = [base, base+s1*t1, base+s2*t2, base+s1*t1+s2*t2];
if (side1 && side2) cells.pop();           // light cannot leak through a sealed diagonal
usable = cells that are not opaque;         // opaque cells excluded from the average
if (usable.length === 0) usable = [base];
skyV   = avg(skyLight of usable);           // 0..15, NOT rounded (float)
blockV = avg(blockLight of usable);
```

Anisotropy fix (0fps quad-flip): with corner AO values `a0..a3` in the winding order above, the quad diagonal flips when

```js
if (ao0 + ao2 > ao1 + ao3) indices = [1,2,3, 1,3,0];   // flipped diagonal
else                        indices = [0,1,2, 0,2,3];   // normal
```

(`a0+a2` vs `a1+a3` are the two diagonals of our winding — same rule as the article's `a00+a11 > a01+a10`.)

### 8.4 Buckets & special shapes

Each chunk builds up to three geometries in one sweep over its 32,768 cells:

| Bucket | Blocks | Material behavior |
|---|---|---|
| `opaque` | all opaque cubes | depthWrite on, no blend, no alphaTest |
| `cutout` | leaves, glass, cross shapes (flowers, tall grass, saplings, wheat, torch), ladder-less extras | depthWrite on, `discard` at alpha < 0.5, `side: DoubleSide` |
| `water` | water + lava (lava is opaque-textured but shares the lowered-surface path) | blend normal, `depthWrite: false`, uniform alpha 0.7 for water (06 §3) / 1.0 lava, renderOrder 10 |

Shape handling:

- `cube`: 6-face culled quads as above.
- `cross`: two diagonal quads from (0.15, 0, 0.15) to (0.85, 1, 0.85) `(approx)`, never culled (emitted whenever the block exists), AO = 1.0, shade = 1.0, light = the cell's own sky/block values.
- Custom shapes per 06 §3's Shape column: hash (crops, 4 quads in # layout), torch (floor + 4 wall orientations from the state nibble), ladder wall quad, snow_layer 2/16 slab, cactus 14/16 inset box, fence post+rails, door 3/16 panel (rotates with open bit), bed 9/16 box, farmland 15/16. Emitted unculled like cross; AO/light = own cell.
- `liquid`: faces culled like cubes but `renderSameIdFaces:false` against any same-fluid neighbor (any level); the TOP surface drops to y+0.875 when the block above is not the same fluid; side faces of such a cell also top out at 0.875 `(approx of MC's per-corner flow heights — flow slope visuals omitted)`.

### 8.5 BufferGeometry layout

Indexed `THREE.BufferGeometry`, built from module-scope growable scratch arrays (never reallocated smaller; `subarray` views copied into right-sized attribute arrays at the end):

| Attribute | Type | Item size | Content |
|---|---|---|---|
| `position` | Float32 | 3 | Chunk-local coords, range [0,16]×[0,128]×[0,16] |
| `normal` | Float32 | 3 | Face normal (entity-consistent lighting not needed, kept for debugging/extensibility) |
| `uv` | Float32 | 2 | Atlas coords from §7.2 |
| `color` | Uint8 (normalized) | 3 | r = round(skyV × 17), g = round(blockV × 17), b = round(255 × AO_CURVE[ao] × FACE_SHADE[face]) |
| index | Uint32 | — | 6 per quad (flip rule §8.3) |

The mesh `Object3D` goes into `chunk.group` positioned at `(cx*16, 0, cz*16)` with `matrixAutoUpdate = false` + one `updateMatrix()`. `geometry.boundingSphere` is set manually from the mesher's tracked min/max Y: center `(8, (minY+maxY)/2, 8)`, radius `Math.hypot(8, (maxY-minY)/2 + 1, 8)` — no `computeBoundingSphere` scan.

### 8.6 Neighbor access protocol

The mesher runs on the MAIN THREAD (decision, §9) and receives a 3×3 chunk neighborhood captured once per build:

```js
const hood = [/* 9 Chunk refs, index (dcx+1)*3 + (dcz+1) */];
function blockAt(wx, wy, wz) {          // wx,wz ∈ [−16, 32) relative to center chunk origin
  if (wy < 0) return BEDROCK; if (wy > 127) return AIR;
  const c = hood[((wx >> 4) + 1) * 3 + ((wz >> 4) + 1)];
  return c.blocks[(wy << 8) | ((wz & 15) << 4) | (wx & 15)];
}
// stateAt(wx, wy, wz): identical routing, reads c.states (fluid spread/falling bits, crop stage, facing — 06 §1)
```

Meshing is only scheduled when all 9 chunks are ≥ LIT (§4.4), so `hood` never contains nulls and border faces/AO/light are always correct — this is the entire chunk-seam correctness story: **no chunk is ever meshed against assumed-air neighbors.**

### 8.7 Chunk shader (`mesh/materials.js`)

Three `THREE.ShaderMaterial` instances (one per bucket) shared by ALL chunks. Uniforms are shared objects so one write updates every chunk:

```glsl
// vertex
attribute vec3 color;                 // declared automatically via vertexColors? NO — custom name kept 'color', declared manually
varying vec2 vUv; varying vec3 vCol; varying float vDist;
void main() {
  vUv = uv; vCol = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = length(mv.xyz);             // radial fog: stable under camera rotation
  gl_Position = projectionMatrix * mv;
}
// fragment
uniform sampler2D uAtlas; uniform float uSkyDarken;          // skyDarkenF 0..11 from 04 §4
uniform vec3 uSkyTint;                                       // day/night sky tint from 04 §11.2
uniform vec3 uFogColor; uniform float uFogNear, uFogFar;
uniform float uAlphaTest, uAlpha;                            // cutout: 0.5,1.0  water: 0.0,0.7
varying vec2 vUv; varying vec3 vCol; varying float vDist;
const vec3 BLOCK_TINT = vec3(1.00, 0.89, 0.69);              // warm torchlight (04 §11.2)
const float AMBIENT_FLOOR = 0.04;                            // 04 §11.1
float brightness(float l) {                                  // 04 §11.1 curve
  float x = clamp(l, 0.0, 15.0) / 15.0;
  return AMBIENT_FLOOR + (1.0 - AMBIENT_FLOOR) * (x / (4.0 - 3.0 * x));
}
void main() {
  vec4 tex = texture2D(uAtlas, vUv);
  if (tex.a < uAlphaTest) discard;
  float effSky = max(vCol.r * 15.0 - uSkyDarken, 0.0);       // 04 §11.2
  vec3 light = max(brightness(vCol.g * 15.0) * BLOCK_TINT, brightness(effSky) * uSkyTint);
  vec3 rgb = tex.rgb * light * vCol.b;                       // vCol.b = AO × face shade
  float fog = smoothstep(uFogNear, uFogFar, vDist);
  gl_FragColor = vec4(mix(rgb, uFogColor, fog), tex.a * uAlpha);
}
```

`brightness()`, `BLOCK_TINT`, `AMBIENT_FLOOR`, and `uSkyTint` are 04 §11.1–11.2's canonical values. Key property: **day/night never remeshes anything** — sky and block light are stored raw per vertex; only the `uSkyDarken`/`uSkyTint` uniforms change per frame.

---

## 9. Terrain generation workers

Terrain generation (the only work that can take tens of ms per chunk) runs in Web Workers. **Meshing stays on the main thread** — decision: the mesher needs random access to 9 chunks of blocks + 2×9 light arrays; shipping snapshots to a worker costs copies and coherence bugs, while budgeted main-thread meshing (§4.5) holds 60 fps. Revisit only if profiling shows remesh starvation (CLAUDE.md lists this as a stretch task).

- Pool: `WORKER_COUNT = 2` workers, round-robin dispatch, created via the Vite-native pattern:

```js
new Worker(new URL('../workers/terrainWorker.js', import.meta.url), { type: 'module' });
```

- Protocol (postMessage shapes, exact):

```
main → worker : { type: 'init', seed: <32-bit int> }                       // once per worker
worker → main : { type: 'ready', worldSpawn: {x,y,z} }                     // once, after init (02 §12)
main → worker : { type: 'generate', cx: int, cz: int, jobId: int }
worker → main : { type: 'chunk', cx, cz, jobId,
                  blocks: ArrayBuffer(32768), heightMap: ArrayBuffer(256),
                  biomes: ArrayBuffer(256), spawns: Array<{type,x,y,z}> }   // 02 §13.2
                // postMessage(msg, [msg.blocks, msg.heightMap, msg.biomes])  ← TRANSFERRED, not cloned
```

- `terrainWorker.js` imports `world/gen/terrain.js` (02) and calls the pure function `generateChunk(seed, cx, cz) → { blocks: Uint8Array, heightMap: Uint8Array }`. Determinism contract (02 must honor it): output depends only on `(seed, cx, cz)` — cross-chunk features (trees near borders) are generated by re-deriving neighbor decisions, never by mutating neighbor chunks.
- Main thread bookkeeping: `pending = Map<jobId, key>`; a result whose chunk was unloaded meanwhile is discarded. On receipt: wrap buffers in Uint8Arrays, install into the Chunk, allocate zeroed light arrays, state → GENERATED.
- Chunks present in the save registry skip the worker entirely and hydrate from IndexedDB (§16); their `heightMap` is recomputed on the main thread by a top-down column scan (256 columns × ≤128 cells, < 1 ms).
- Worker errors (`onerror`): log, re-queue the job once, then mark the chunk FAILED and render nothing (visible hole = loud bug signal, intentional).

---

## 10. Lighting engine: data structures & scheduling

Propagation RULES (attenuation, sky column semantics, opacity per block) live in 04-TIME-LIGHT-WEATHER.md. This section fixes the data structures, API, and scheduling so 04's algorithm drops in.

### 10.1 Storage & queues

- Per chunk: `skyLight`, `blockLight` Uint8Arrays (§4.2). Values 0–15, stored RAW (no sun scaling — §8.7).
- BFS queues: module-scope flat `Int32Array`-backed ring buffers (grow-on-demand), 4 lanes per node: `x, y, z, level` in WORLD coords. Two queue pairs: `(addQueue, removeQueue)` × `(sky, block)`. Flat lanes → zero GC in the hot path.
- `dirtied: Set<string>` — chunk keys written during the current operation; returned to the caller for remesh scheduling (§4.5/§4.6).

### 10.2 API

```js
LightEngine.initialLight(chunk)
  // 1. column skylight: for each (x,z): light 15 from y=127 down to heightMap top,
  //    then seed the BFS with border-of-darkness cells (04 defines exact seeding)
  // 2. seed blockLight addQueue with every emitter cell in the chunk (registry lightEmission > 0)
  // 3. pull-in pass: enqueue all 4 border planes of already-LIT neighbors' edge cells with level > 1
  // 4. drain both add-BFS queues (cross-chunk allowed; only into GENERATED+ chunks)
LightEngine.onBlockChanged(x, y, z, oldId, newId) → Set<chunkKey>
  // placed opaque/attenuating block: remove-BFS from the cell (both channels), then re-add from
  //   the shrunk frontier; if the column heightMap rose/fell, re-run column skylight for that column
  // removed block: enqueue all 6 neighbors into add queues; if new emission > 0, enqueue the cell
  // drains synchronously; returns every chunk any write touched
LightEngine.getLight(x, y, z) → { sky, block }   // debug overlay + entity light sampling (§13)
```

### 10.3 Scheduling & bounds

- All relighting is SYNCHRONOUS inside `setBlock` (tick-side). Typical single-block edit touches < 500 cells (< 0.3 ms); worst realistic case (removing a block over a torch-lit cavern) ~30k cells, a few ms — acceptable at 20 TPS.
- Safety valve: if a single `onBlockChanged` drains more than 100,000 nodes, abort, zero both light arrays of the 3×3 neighborhood, and re-run `initialLight` on them spread over the next 9 ticks (one chunk per tick). This path is a bug-net, not a feature; log when hit.
- Remeshing is DECOUPLED: light writes only add chunk keys to `dirtied`; meshes rebuild through the normal budgeted queue (player edits synchronous, §4.5). Multiple edits per tick (explosions per 05) naturally coalesce through the Set.
- Unloaded neighbors: BFS never writes into chunks below GENERATED; `initialLight`'s pull-in pass (step 3) heals the seam when the neighbor later lights, and marks the earlier chunk dirty if its border values change.

---

## 11. Voxel raycasting

Block picking uses grid traversal (Amanatides & Woo, "A Fast Voxel Traversal Algorithm for Ray Tracing"), NOT `THREE.Raycaster` against meshes (which would cost O(triangles) and hit render geometry, not game state).

```js
// world/raycast.js — returns first targetable block along the ray, or null
function raycastBlocks(world, ox, oy, oz, dx, dy, dz, maxDist, fluidMode = false) {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const stepX = Math.sign(dx), stepY = Math.sign(dy), stepZ = Math.sign(dz);
  const tDeltaX = stepX ? Math.abs(1 / dx) : Infinity;   // param length to cross one cell in X
  const tDeltaY = stepY ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = stepZ ? Math.abs(1 / dz) : Infinity;
  let tMaxX = stepX > 0 ? (x + 1 - ox) / dx : stepX < 0 ? (x - ox) / dx : Infinity;
  let tMaxY = stepY > 0 ? (y + 1 - oy) / dy : stepY < 0 ? (y - oy) / dy : Infinity;
  let tMaxZ = stepZ > 0 ? (z + 1 - oz) / dz : stepZ < 0 ? (z - oz) / dz : Infinity;
  let t = 0, faceX = 0, faceY = 0, faceZ = 0;

  for (let i = 0; i < 256 && t <= maxDist; i++) {        // hard iteration cap
    const b = BLOCKS[world.getBlock(x, y, z)];
    if (b.targetable || (fluidMode && b.shape === 'liquid' && b.isSource))
      return { x, y, z, face: [faceX, faceY, faceZ], t,
               px: ox + dx * t, py: oy + dy * t, pz: oz + dz * t };
    if (tMaxX < tMaxY && tMaxX < tMaxZ) { x += stepX; t = tMaxX; tMaxX += tDeltaX; faceX = -stepX; faceY = 0; faceZ = 0; }
    else if (tMaxY < tMaxZ)             { y += stepY; t = tMaxY; tMaxY += tDeltaY; faceX = 0; faceY = -stepY; faceZ = 0; }
    else                                { z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; faceX = 0; faceY = 0; faceZ = -stepZ; }
  }
  return null;
}
```

- The origin cell is tested first (standing inside tall grass targets it).
- `face` is the unit normal of the entered face; block placement position = `hit + face`. Placement is refused when the placed block's AABB would overlap any entity's AABB (MC rule).
- Consumers: player interaction (reach from 03: block 4.5 m), mob line-of-sight (05; variant flag `opaqueOnly` that only stops at `opaque` blocks), arrow flight (per-tick segment rays, 05), bucket use (`fluidMode: true`, only source cells returned).
- The selection wireframe is a `THREE.LineSegments` box (`EdgesGeometry` of a unit cube, black, `depthTest true`) moved to the hit cell each frame; hidden when no hit.

---

## 12. Physics: AABB vs voxel grid

No physics library. Entities are axis-aligned boxes; the world is the voxel grid; movement is axis-separated move-and-slide. All speed/gravity/jump constants live in 03-PLAYER.md (player) and 05-MOBS-COMBAT.md (mobs); this section is the collision core they call.

Entity AABB from `pos` (feet-center), `width`, `height`:
`[pos.x − w/2, pos.y, pos.z − w/2] .. [pos.x + w/2, pos.y + h, pos.z + w/2]`.

```js
// physics/collision.js
const EPS = 1e-7;

function moveEntity(world, entity, dx, dy, dz) {
  const box = entity.getAABB();
  const cdy = collideAxis(world, box, 1, dy); box.translate(0, cdy, 0);
  const cdx = collideAxis(world, box, 0, dx); box.translate(cdx, 0, 0);
  const cdz = collideAxis(world, box, 2, dz); box.translate(0, 0, cdz);
  entity.setPosFromAABB(box);
  entity.onGround     = dy < 0 && cdy !== dy;
  entity.hitWall      = cdx !== dx || cdz !== dz;      // mob AI jump trigger (05)
  entity.hitCeiling   = dy > 0 && cdy !== dy;
  if (cdx !== dx) entity.vel.x = 0;
  if (cdy !== dy) entity.vel.y = 0;                    // fall-damage hook reads pre-zero vel (03/05)
  if (cdz !== dz) entity.vel.z = 0;
}

function collideAxis(world, box, axis, d) {
  if (d === 0) return 0;
  const swept = box.clone().expandByDisplacement(axis, d);
  const [x0, y0, z0] = swept.min.map(Math.floor);
  const [x1, y1, z1] = swept.max.map(v => Math.ceil(v) - 1);
  for (let y = Math.max(y0, 0); y <= Math.min(y1, 127); y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        if (!BLOCKS[world.getBlock(x, y, z)].collidable) continue;
        // cell box = BLOCKS[id].collisionBox ?? unit cube; non-full boxes (06 §3): fence 1×1.5×1, bed 1×0.5625×1, cactus 0.875 box, closed door 3/16 panel by facing
        if (!box.overlapsOnOtherAxes(axis, x, y, z)) continue;   // cell AABB = [x,x+1]×[y,y+1]×[z,z+1]
        d = d > 0 ? Math.min(d, (axis===0?x:axis===1?y:z)     - box.max[axis] - EPS)
                  : Math.max(d, (axis===0?x:axis===1?y:z) + 1 - box.min[axis] + EPS);
      }
  return d;
}
```

- Axis order fixed **Y → X → Z**.
  > Adaptation: MC reorders X/Z dynamically; with no partial-height blocks in scope the difference is unobservable.
- Per-axis displacement is capped at 0.5 m/tick before collision (10 m/s) except projectiles, which sub-step: split the move into `ceil(dist / 0.5)` equal segments and run `moveEntity` per segment. No tunneling is possible below 10 m/s because the swept region covers the full displacement.
- No auto-step (stepHeight = 0 per 03 §5.5); the few sub-cube collision boxes (06 §3) still block like walls.
- Fluid queries used by movement code (03/05): `overlappedFluid(box, 'water'|'lava')` — scans the box's cells; water counts as full cells `(approx: MC's 0.875 fluid height ignored for physics)`. Cross-shape blocks are non-collidable but `cobweb`-style slowdown is out of scope.
- Unloaded chunks: `getBlock` returns AIR there, so entities could fall into void; the EntityManager freezes any entity whose chunk is not ≥ GENERATED (skips its tick entirely) — the player can outrun generation only if workers stall > ~4 s; the player additionally hard-blocks against unloaded chunks (treated solid for the PLAYER only).

---

## 13. Entity system

### 13.1 Base class

```js
class Entity {
  id;                    // int, from EntityManager counter
  world;
  pos = {x,y,z};  prevPos = {x,y,z};      // feet center
  vel = {x,y,z};                           // m/tick
  yaw = 0; pitch = 0; prevYaw = 0;         // radians
  width; height;                           // AABB dims (per-type, 03/05)
  onGround = false; inWater = false; inLava = false;
  age = 0;                                 // ticks alive
  dead = false;                            // reaped at end of tick
  object3d = null;                         // THREE.Group of box parts, built lazily by buildMesh()
  lightScalar = 1;                         // brightness at eye cell, sampled every 4 ticks

  tick()            // override; MUST call super.baseTick() first (copies pos→prevPos, age++)
  buildMesh()       // override; returns THREE.Group (part specs in 05; player hand/held item in 03)
  updateRender(alpha) {
    object3d.position.set(lerp(prevPos.x,pos.x,alpha), lerp(prevPos.y,pos.y,alpha), lerp(prevPos.z,pos.z,alpha));
    object3d.rotation.y = lerpAngle(prevYaw, yaw, alpha);       // shortest-arc
    applyLightScalar();                                          // material color × lightScalar
  }
}
```

Hierarchy: `Entity` → `LivingEntity` (health, hurt/knockback/fall-damage hooks — combat math in 05) → `Player` (03) and `Mob` (05 subclasses). `Entity` → `ItemEntity`, `Arrow`, `FallingBlock`.

Entity lighting: every 4 ticks sample `LightEngine.getLight` at the eye cell → `level = max(block, sky − skyDarken)` (04 §4 internalLight) → `lightScalar = brightnessCurve(level)` (same curve as §8.7); applied by multiplying each part material's `color` (materials are cloned per entity instance). Combined with scene lights (§14), mobs go dark in caves like the terrain does.

ItemEntity visuals: block items = 0.25-size mini cube using the block's atlas tiles; non-block items = one double-sided 0.5×0.5 quad with the item tile. Both spin 3°/tick and bob ±0.07 m on a 3 s sine `(approx)`. Merge/pickup/despawn rules in 06.

### 13.2 EntityManager & spatial lookup

- `entities = Map<id, Entity>`; insertion order = tick order (player ticks first via §3 anyway).
- Spatial index: each entity registers into `chunk.entities` (the chunk under its feet); on crossing a chunk border during its tick it re-registers. Unloading a chunk removes (discards) its entities — except the player, which blocks unload of its own chunk by definition of the radii.
- `getEntitiesInBox(aabb, filter)` — iterate the chunks overlapped by the box (± 1 chunk margin to catch entities up to 1 m wide), test AABB overlap. Used by: melee sweep (05), arrow hit (05), item pickup radius (06), block-placement occupancy (§11), creeper trigger radius (05).
- Tick gating: entities in chunks outside `SIM_RADIUS` are frozen (no tick, mesh remains). Mob despawn distances in 05 operate within this.
- Removal: `dead` entities are reaped after the entity pass — `object3d` removed, per-entity cloned materials disposed, geometry NOT disposed when shared (mini-cube/quad geometries are shared; mob part geometries are per-type shared).
- Persistence: on save, each chunk serializes its entities set per 06 §18 / 05 §1; restored on hydrate (§16).

---

## 14. Sky & environment rendering

Decision: shader-gradient sky dome (not vertex colors — two uniform writes per frame beat re-uploading vertex colors).

All numeric sizes/radii/speeds in this section are superseded by 04 §5, §7, §13; the plumbing (pivot, materials, render order) below is authoritative.

- **Dome**: `SphereGeometry(300, 24, 12)`, `side: BackSide`, ShaderMaterial:
  `color = mix(uHorizonColor, uZenithColor, pow(clamp(dir.y, 0.0, 1.0), 0.7))` with `dir` = normalized local position. `depthWrite: false`, `renderOrder: -10`, `frustumCulled: false`, position copied from camera every frame. Sky is NOT fogged.
- **Sun**: 45×45 quad (`MeshBasicMaterial`, procedural 32×32 radial-square sun texture, `fog: false`, `depthTest: false`, additive blending) parented to a pivot at the camera, positioned +260 on the pivot's local X, pivot rotated about the Z axis by the day angle (04 supplies `sunAngle(worldTime)`). **Moon**: same pivot, opposite side, 38×38 `(approx sizes)`.
- **Stars**: `THREE.Points`, 600 points on a radius-290 sphere (seeded RNG), size 1.6, opacity uniform driven by 04 (0 by day). Same pivot as the sun so stars wheel overhead.
- **Fog**: radial, implemented inside the chunk shaders (§8.7). `uFogFar = RENDER_RADIUS × 16 = 128`, `uFogNear = 0.75·R_eff` (04 §7). `uFogColor` = horizon color, lerped by time of day (04's color table); underwater override: near 4, far 24, color from 04. Entities use three.js scene fog (`scene.fog = new THREE.Fog(...)`) kept in sync with the same values so built-in materials match.
- **Scene lights** (entities only — chunks ignore scene lights): one `THREE.DirectionalLight` (sun direction from the pivot angle) + one `THREE.AmbientLight`; both intensities scale with `sunIntensity` (exact values in 04 §6). No shadow maps — voxel light + AO carry the look.
- **Clouds**: one 512×512 plane at y=192? No — out of Y range; clouds render at y = 110 (above build limit, cosmetic only): a `PlaneGeometry` with a procedural 64×64 cloud alpha texture scrolling +X at 0.5 m/s `(approx)`, `transparent`, `depthWrite false`. Weather visuals (rain overlay) per 04.

Render order summary: dome (−10) → stars/sun/moon (−9) → opaque (0) → cutout (0, alphaTest) → entities (0) → water (10) → selection box (11).

---

## 15. Input, pointer lock & UI shell

### 15.1 Keybind map (constants.js; `e.code` values)

| Action | Binding | Notes |
|---|---|---|
| Move | `KeyW/KeyA/KeyS/KeyD` | Double-tap `KeyW` within 7 ticks → sprint (03) |
| Jump / swim up | `Space` | Held = auto-rejump |
| Sneak / swim down | `ShiftLeft` | Edge-guard semantics in 03 |
| Sprint | `ControlLeft` | Alternative to double-tap |
| Attack / mine | Mouse left (hold) | Mining progress in 03/06 |
| Use / place | Mouse right (hold) | Repeat every 4 ticks while held (MC) |
| Hotbar 1–9 | `Digit1..Digit9` | |
| Hotbar cycle | Wheel | deltaY > 0 → next slot (wraps) |
| Inventory | `KeyE` | Toggles; also closes chest/furnace/crafting screens |
| Drop item | `KeyQ` / `Shift+KeyQ` | One / whole stack (03 §3) |
| Debug overlay | `F3` | `preventDefault()` |
| Debug creative toggle | `F4` | 03 §21 |
| Reserved | `F5` | No-op (no third person) |
| Pause | `Escape` | Browser exits pointer lock on Esc automatically; see flow below |

`input.js` keeps `keysDown: Set<code>`, per-frame `pressed`/`released` edge sets, accumulated `mouseDX/DY` from `mousemove.movementX/Y` (consumed by the camera each tick; sensitivity in 03), and mouse button states. `contextmenu` is `preventDefault()`ed on the canvas. All game keys `preventDefault()` while pointer-locked.

### 15.2 Screen state machine & pointer lock flow

```
TITLE ──Play/Create──▶ LOADING ──spawn 7×7 meshed──▶ PLAYING (pointer locked)
PLAYING ──KeyE / open container──▶ PLAYING_UI (unlocked, world ticking)
PLAYING ──Esc / lock lost──▶ PAUSED (menu, ticking frozen, autosave fired)
PLAYING ──death (03)──▶ DEAD (respawn / title)
```

- Lock: `canvas.requestPointerLock({ unadjustedMovement: true })` inside the click handler; `.catch()` fallback to no-options call (Safari). ALL lock requests happen inside user-gesture handlers.
- `pointerlockchange` → lock lost while `PLAYING` ⇒ enter `PAUSED`. Chrome enforces a ~1.3 s cooldown after Esc-exit: the Resume button's request can reject — on rejection show "Click to resume" and retry on the next click instead of throwing.
- `visibilitychange → hidden`: enter `PAUSED` + autosave (§16).

### 15.3 HUD & screens (DOM/CSS, no framework)

- `#hud` (visible in PLAYING/PLAYING_UI): crosshair (center, `mix-blend-mode: difference`), 9-slot hotbar with selection frame + item icons (§7.3) + count badges, hearts row (10 × half-heart sprites), hunger row, armor row, air bubbles (submerged only), XP bar — layouts and values per 03/06.
- `#screens`: title (world exists? Continue / New World (+seed input) / Delete), loading (progress = meshed/needed), pause (Resume / Save & Quit), death (Respawn / Title), inventory/crafting/furnace/chest (structure owned by 06: 2D grid of slot divs; drag/click semantics in 06).
- Update policy: HUD JS never touches DOM unless the underlying value changed (per-element cached last value). Screens are `display:none` toggled. Icons via atlas background-position (§7.3). Fonts: system monospace stack; no webfonts.
- Debug overlay (F3): fps (1 s rolling), frame ms, pos/chunk/facing, biome (02), light sky/block at feet, loaded/meshed chunk counts, remesh queue length, `renderer.info.render.calls` + `triangles`, entity count, heap (`performance.memory` when available). Updates at 4 Hz.

---

## 16. Save/load: IndexedDB

Single world slot. Database `mc-world`, version 1, two object stores (out-of-line keys):

```js
req.onupgradeneeded = e => {
  const db = e.target.result;
  db.createObjectStore('meta');     // key 'world'
  db.createObjectStore('chunks');   // key 'cx,cz'
};
```

### 16.1 Records

```js
// meta / 'world'
{ version: 1, seed: int, worldTime: int,                  // time of day = worldTime % 24000 (04)
  weather: {...},                                          // 04 owns shape
  player: { pos, vel, yaw, pitch, health, hunger, saturation, exhaustion, foodPoisonTicks, xp, air, fireTicks, fallDistance, gameMode,
            inventory: Array<{slot, id, count, durability?}>, armor: Array<4>, selectedSlot,
            spawnPoint: {x,y,z} },                         // field semantics: 03/06
  lastSaved: epochMs }

// chunks / 'cx,cz'   — ONLY chunks with modified === true are ever written
{ cx, cz,
  blocks: ArrayBuffer,                                     // the full 32 KB Uint8Array buffer, structured-cloned
  blockEntities: Array<{ i: blockIndex, type, data }>,     // furnace/chest state, 06 owns `data`
  states: ArrayBuffer,                                     // 32 KB state array (06 §18)
  biomes: ArrayBuffer,                                     // 256 B biome ids (02 §13.2)
  spawnsDone: boolean,                                     // worldgen herd records consumed (02 §11)
  entities: Array<record> }                                // non-player entities in this chunk: mobs (fields per 05 §1), item entities + primed TNT (fields per 06 §18); falling blocks written back as blocks
```

Light arrays are NOT saved (recomputed deterministically by `initialLight` on load). `heightMap` is NOT saved (recomputed in < 1 ms, §9). Consuming a chunk's herd records sets `modified = true`. Unmodified chunks are NEVER saved — the generator is deterministic, so the seed IS the data; a long-played world stays a few MB.

### 16.2 Save triggers & procedure

| Trigger | What |
|---|---|
| Autosave every 600 ticks (30 s) | meta + all `modified` chunks |
| Enter PAUSED, `visibilitychange→hidden`, `pagehide` | same (pagehide is best-effort fire-and-forget) |
| "Save & Quit" | same, awaited, then → TITLE |
| Chunk unload (§4.3) | that chunk only, if `modified` |

One `readwrite` transaction spanning both stores per save; `chunk.modified` clears only on transaction `oncomplete`. Saves are fire-and-forget (never awaited inside the loop); a save overlapping the next autosave is skipped with a warning. Block-array buffers are written as-is (structured clone copies them; the live array stays usable).

### 16.3 Load procedure

1. Boot: open DB → `chunks.getAllKeys()` → `savedChunkKeys: Set<string>` (kept in sync on writes).
2. Title "Continue" → read meta → seed to workers, worldTime/weather/player restored.
3. Streaming: ChunkManager consults `savedChunkKeys` before dispatching a worker job; saved chunks are read (`chunks.get(key)`), hydrated (blocks + states + biomes installed, blockEntities + entities restored, heightMap recomputed), state → GENERATED, and flow through the normal LIT→MESHED pipeline.
4. "New World": `indexedDB.deleteDatabase('mc-world')` → recreate with fresh seed (from seed input, or `Date.now() >>> 0`).

Version migrations: `meta.version !== 1` → refuse load, offer New World. No migration code in v1.

---

## 17. Performance budget & known pitfalls

### 17.1 Budgets (target: 60 fps on a 2020 mid-range laptop, RENDER_RADIUS 8)

| Metric | Budget | Expected |
|---|---|---|
| Frame total | ≤ 16.6 ms | 6–10 ms |
| `tick()` (on tick frames) | ≤ 10 ms | 1–3 ms |
| Remesh drain | ≤ 6 ms/frame, ≤ 4 chunks | 1.5–4 ms/chunk build |
| Draw calls | ≤ 500 | 289 loaded × ≤3 buckets, frustum-culled → 150–350 |
| Triangles | ≤ 1.5 M | typ. 300–800 k (culled faces, tight bounding spheres) |
| CPU chunk memory | — | 128 KB × ~440 (r=11 worst set) ≈ 55 MB |
| GPU geometry | ≤ 300 MB | 0.2–0.8 MB per meshed chunk × 289 |
| Initial load (new world) | ≤ 6 s to PLAYING | 361 gens ÷ 2 workers @ ≤20 ms + meshing ramp |
| Single block edit → visible | same frame | sync remesh path (§4.5) |

### 17.2 Known pitfalls & mandated preventions

| Pitfall | Prevention (mandatory) |
|---|---|
| Atlas bleeding (neighbor tile edges) | NearestFilter min+mag, `generateMipmaps=false`, half-texel UV inset (§7) |
| AO/light seams at chunk borders | Mesh only with full 3×3 LIT neighborhood; never default missing neighbors to air/opaque (§8.6) |
| Light not updating across borders | BFS operates in world coords over the chunk map; `dirtied` set remeshes every touched chunk (§10) |
| Float jitter far from origin | Chunk-local vertex coords + group transforms; three.js composes matrices in f64 JS arrays so `modelView` translation stays small; world border ±1e6 (§4.1) |
| Transparent sorting artifacts | Water in separate pass, `depthWrite:false`, renderOrder 10, three sorts chunks back-to-front; intra-chunk artifacts accepted (rare: stacked water surfaces) |
| Spiral of death after tab stall | 250 ms frame clamp + 5-tick cap + accumulator drop (§3) |
| GC hitches | Flat scratch arrays for mesher & light queues; no per-block/per-node object allocation; module-scope temp vectors; transferables for worker buffers |
| Chunk memory leak | Unload disposes all 3 geometries; `renderer.info.memory.geometries` asserted in debug overlay; materials/texture are process-lifetime singletons |
| Mining feels laggy | Player-edit chunks rebuild synchronously same frame, bypassing the budget (§4.5) |
| Worker result races | jobId map; stale results for unloaded chunks dropped (§9) |
| Pointer-lock cooldown exception (Chrome) | Promise-based request with rejection → "click to resume" retry (§15.2) |
| Esc key eaten by browser | Never bind game logic to Esc keydown alone; react to `pointerlockchange` (§15.2) |
| Leaves z-fighting glass | Both are cutout bucket, depthWrite on — no coplanar faces exist between distinct blocks (culled faces are offset by definition) |
| sRGB double-encode washing colors | Whole pipeline gamma-space pass-through (§1); never mix `SRGBColorSpace` textures into it |

### 17.3 Fallbacks

`RENDER_RADIUS` is a constant, not a menu setting, but the debug overlay exposes `game.setRenderRadius(n)` (4–12) for testing; if median fps over 10 s < 45, log a suggestion to lower it (no auto-scaling in v1).

---

## 18. Implementation order

Phase list (CLAUDE.md expands each into tasks/acceptance):

1. Scaffold: Vite + three r185, renderer, fly-camera, one hardcoded stone chunk rendered with a debug material.
2. Atlas builder + tile painters for the starter block set; UV table; pixelated HUD proof (§7).
3. Chunk data model + mesher with culled faces, AO, buckets, face tables; single-chunk world (§4, §8).
4. Terrain worker + ChunkManager streaming with state machine and budgeted remesh queue (§9, §4).
5. Real worldgen in worker per 02 (biomes, caves, ores, trees).
6. Player physics + collision core + pointer lock + input map per 03 (§12, §15).
7. Raycast + break/place + selection box + synchronous edit remesh (§11).
8. Lighting engine (sky + block BFS) per 04; chunk shader light path; torch placement end-to-end (§10).
9. Day/night: worldTime, sky dome, sun/moon/stars, fog lerp, `uSkyDarken`/`uSkyTint` per 04 (§14).
10. Inventory/crafting/smelting data + all container screens per 06; HUD survival bars.
11. Entities: base class + manager + ItemEntity; block drops flowing into inventory (§13).
12. Mobs + AI + combat + spawning per 05; arrows; falling blocks; fluids (§6).
13. Survival loop closure per 03/06: hunger, regen, damage, death/respawn screens.
14. Save/load: IndexedDB schema, autosave, hydrate path, title-screen world lifecycle (§16).
15. Performance & polish pass: budgets verified against §17, debug overlay counters, acceptance sweeps of all six spec files.

---

## Acceptance checklist

Concrete, testable engine behaviors (gameplay-level acceptance lives in the owning files):

- [ ] `npm install && npm run dev` serves the game; `npm run build && npm run preview` serves an identical production build; the network tab shows zero image/audio/font requests.
- [ ] New world reaches PLAYING in ≤ 6 s; loading bar reflects meshed-chunk progress.
- [ ] Sustained 60 fps (F3 fps counter) while sprint-flying at y≈80 in a straight line for 60 s at RENDER_RADIUS 8; draw calls ≤ 500; no frame > 50 ms after the first 10 s.
- [ ] Main thread has no task > 20 ms attributable to terrain generation (Performance-panel check) — generation is worker-side.
- [ ] Walking every border of a 5×5 chunk area shows zero missing faces, zero AO discontinuities, zero light seams at chunk boundaries.
- [ ] Breaking/placing a block updates visible geometry in the SAME frame (record with the F3 remesh counter: sync path, not queue).
- [ ] AO present: corners/crevices show 4-level darkening; no diamond-shaped interpolation artifacts on stair-step terrain (quad-flip rule verified visually).
- [ ] Placing a torch in a sealed cave produces a 14→0 gradient across blocks; removing it restores prior darkness exactly (compare F3 light-at-feet values before/after).
- [ ] Sunset→night changes terrain brightness smoothly with the remesh counter at ZERO (uniform-driven sky light).
- [ ] A cave with no sky access reads sky=0 block=0 (F3) and renders at `uMinLight` floor brightness.
- [ ] Raycast targets the correct block and face at all angles; placement lands on the aimed face for all 6 faces; placement into the player's own AABB is refused.
- [ ] Player cannot clip into blocks at any speed ≤ 10 m/s (press into walls/corners/ceilings for 30 s); falling onto a chunk border corner never tunnels.
- [ ] Water renders translucent over opaque terrain and behind glass without disappearing chunks; leaves show transparent holes (cutout) with no halo.
- [ ] Reload after edits: seed, player position/look/inventory, worldTime, and all block edits restored byte-exact; unmodified chunks regenerate identically (visual diff at same coords).
- [ ] Kill the tab within 30 s of an edit → edit survives on next load (pagehide/autosave path).
- [ ] IndexedDB contains ONLY modified chunks (inspect store keys after editing 3 chunks: exactly 3 records + meta).
- [ ] Fly 500 blocks out and back: `renderer.info.memory.geometries` returns to within ±5 of baseline (no leak); JS heap stable ±15% over 10 min.
- [ ] At x = z = 500,000 (teleport via console), no visible vertex jitter while moving the camera slowly.
- [ ] Esc opens pause (ticking frozen — clouds/sun stop); Resume re-locks pointer; rapid Esc/Resume spam never throws (Chrome cooldown handled); E opens inventory with the world still ticking behind it.
- [ ] F3 overlay shows fps, pos, chunk, facing, light levels, chunk states, draw calls, triangles, entity count; updates without measurable frame cost.
- [ ] Water bucket flow: placed water spreads 7 blocks over flat ground in ~1.75 s, prefers flowing down, and two adjacent sources over solid create a new source between them.
- [ ] Sand placed over air falls as an entity and lands as a block; landing inside a flower drops sand as an item.
