Verified the load-bearing claims (setBlock ordering, `tags` absent, `world.dimension` unassigned, `disposeWorld` null-deref, `saveChunkNow`'s `window.game` fallthrough). Merging now.

---

# ClaudeCraft — Integration Reference for Expansion Phases E3–E12, EC

Paths are `src/`-relative. Every citation verified against the tree at commit `b248d39` (v1.0.5).

---

## 1. Tick order & render order

Every new system inserts here. These are the only two ordered sequences in the engine.

### 1.1 `Game.frame(now)` — `Game.js:161-185`

```
161  frame(now) {
162    requestAnimationFrame(this.frame);            // re-armed FIRST, before any work
163    const frameDelta = Math.min(now - this.lastTime, 250);
164    this.lastTime = now;
167    if (state ∈ {PLAYING, PLAYING_UI, LOADING, DEAD}) {
         accumulator += frameDelta;
         while (accumulator >= MS_PER_TICK && ran < MAX_TICKS_PER_FRAME) { tick(); accumulator -= MS_PER_TICK; ran++; }
176      if (ran === MAX_TICKS_PER_FRAME) accumulator = 0;   // spiral-of-death bleed
       }
178    const alpha = Math.min(1, accumulator / MS_PER_TICK);
179    this.render(alpha);
181    this.debug.frameMs = performance.now() - t0;   // includes render
```
`MS_PER_TICK = 50`, `TPS = 20`, `MAX_TICKS_PER_FRAME = 5` — `constants.js:5-7`. **TITLE and PAUSED do not tick. DEAD does.**

### 1.2 `Game.tick()` — `Game.js:187-233`, verbatim

```js
187  tick() {
188    if (!this.world) return;                       // master gate
189    this.tickCount++;
190    const tickStart = performance.now();
192    const playing = this.state === STATE.PLAYING;
193    const frame = playing && !this.sleeping ? this.input.snapshot() : (this.input.snapshot(), NEUTRAL_FRAME);
195    if (this.state !== STATE.LOADING) {
196      this.player.tick(frame);
197      this.interaction.tick(frame);
198      this.entities.tick(this.player);
199      this.world.scheduled.run();
200      this.world.randomTicks();
201      this.dayNight.tick();
202      this.mobSpawner?.tick();
203    }
204    this.chunkManager.tick(this.player.pos.x, this.player.pos.z);
205    if (this.state !== STATE.LOADING) {
206      this.tickBlockEntities();
207      this.tickSleep();
208    }
209    this.save?.tick(this);
210    this.audio?.tick();                 // AMENDS 01 §3 tick step 10
211    this.atlas.animate?.(this.world.time);
212    this.ui?.containers?.tickOpen?.();
215    if (this.state === STATE.LOADING) { … drainRemesh(px,pz,40,12); loadingProgress; meshed>=needed → PLAYING }
229    const dt = performance.now() - tickStart;
230    if (dt > 40 && this.state !== STATE.LOADING) { if (++this.slowTicks >= 2) console.warn(`[game] slow tick: ${dt.toFixed(1)} ms`); }
232    else this.slowTicks = 0;
```

**Ordering facts every new tick system must respect:**
- `world.time++` happens at `env/DayNight.js:133`, i.e. **inside step 201, after `scheduled.run()` at 199.** A `schedule(delay=1)` issued from inside a tick lands on the *next* `run()`.
- `chunkManager.tick` (204) sets `world.playerChunk` — this gates `randomTicks` (`World.js:324`) and `ScheduledTicks.run`'s sim-radius test (`scheduledTicks.js:31`). It runs during LOADING; nothing else in 195-208 does.
- `save?.tick` (209) advances the autosave counter **during LOADING**.
- `tickBlockEntities` (206) runs *after* `scheduled.run()` and `entities.tick()`, not with them.

### 1.3 `Game.render(alpha)` — `Game.js:249-278`, verbatim

```js
250    this.renderer.clear(true, true, true);
251    if (!this.world || this.state === STATE.TITLE) { this.audio?.updateFrame(null); return; }
259    this.applyMouseLook();
260    this.debug.lastRemeshes = this.chunkManager.drainRemesh(this.player.pos.x, this.player.pos.z);
261    this.updateCamera(alpha);
262    this.audio?.updateFrame(this.camera);   // AMENDS 01 §3 render step 6
263    this.debug.audioMs = this.audio?.debug.budgetMs ?? 0;
264    this.dayNight.updateRender(alpha, this.camera);
265    this.entities.updateRender(alpha, this.player);
266    this.particles.update(alpha);
267    this.updateSelectionBox();
269    this.renderer.render(this.scene, this.camera);
271    if (this.state === STATE.PLAYING || this.state === STATE.PLAYING_UI) {
272      this.updateViewmodel(alpha); this.renderer.clearDepth(); this.renderer.render(this.viewmodelScene, this.viewmodelCamera);
274    }
276    this.ui?.hud?.update?.();
277    this.ui?.debug?.update?.();
```
`render` runs in **every** state except the TITLE/no-world early-out — including PAUSED and DEAD. Render order constants: `selectionBox.renderOrder = 11` (`Game.js:336`); chunk water bucket `10`, opaque/cutout `0` (`world/ChunkManager.js:315`); Sky `group` `-10`, sun `-9`, clouds `-8` (`render/Sky.js:22,68,167`).

**Hard rule (`audio/engine.js:2-3`, restated `ui/debug.js:35`):** `emitSound`/`startLoop` are tick-only. Render code must never emit.

### 1.4 States — `constants.js:71-78`

`STATE = { TITLE, LOADING, PLAYING, PLAYING_UI, PAUSED, DEAD }` — **six**, not four. `setState` (`Game.js:136-155`) saves only on `PLAYING → PAUSED` (`:139`); `ui.onStateChange(next, prev)` is always last (`:154`). There is **no Escape→PAUSED handler**; pausing is indirect via pointer-lock loss (`main.js:167-171`).

---

## 2. World & chunk data

### 2.1 Chunk arrays — `world/Chunk.js:13`

| Field | Type | Cite |
|---|---|---|
| `blocks` | `Uint8Array(32768)` | `Chunk.js:18` |
| `states` | `Uint8Array(32768)` | `Chunk.js:19` |
| `skyLight` / `blockLight` | `Uint8Array(32768)`, 0–15 | `Chunk.js:20-21` |
| `heightMap` | `Uint8Array(256)`, `(z<<4)|x` → y+1 of top sky-terminating block | `Chunk.js:22` |
| `biomes` | `Uint8Array(256)` | `Chunk.js:23` |
| `blockEntities` | `Map<blockIndex, {type,data}>` | `Chunk.js:27` |
| `entities` | `Set` (feet-in-chunk) | `Chunk.js:28` |
| `pendingSpawns` / `spawnsDone` | deferred-record channel | `Chunk.js:33-34` |
| `modified` | differs from generator output → must save | `Chunk.js:26` |
| `minY` / `maxY` | tight Y bounds from last mesh | `Chunk.js:31-32` |

Index is **Y-major**: `i = (y << 8) | (z << 4) | x` (`constants.js:18`). `blockIndex` does not mask x/z — every World/LightEngine accessor inlines the masked world-coord form `(y << 8) | ((z & 15) << 4) | (x & 15)` (`World.js:105` et al). Inverse: `x = i & 15`, `y = i >> 8`, `z = (i >> 4) & 15` (`World.js:336`).

`ChunkState = { REQUESTED:0, GENERATED:1, LIT:2, MESHED:3, FAILED:-1 }` (`Chunk.js:5`). Read gate: `World.getChunkAt` returns only at `state >= GENERATED` (`World.js:40`); `LightEngine.chunkAt` identical (`LightEngine.js:80`). Both hold an independent **1-entry cache** invalidated by `world.chunkVersion`, which bumps only on chunk add (`ChunkManager.js:141`) and remove (`:229`).

**`Chunk.install(blocks, heightMap, biomes, states = null)`** (`Chunk.js:37`) zero-fills `states`/`skyLight`/`blockLight` when omitted. The worker path omits `states` (`ChunkManager.js:77`) — **worldgen never emits a state byte and never bit 7.** The save path passes them (`ChunkManager.js:114`).

### 2.2 The frozen bit-7 waterlogged contract — `registry/blocks.js:19-39`, verbatim

```
//   bit 7 (0x80) of every voxel's `states` byte = WATERLOGGED. Owned by 15 for
//   every block in the game; NO other file may assign it.
//   Per-block nibble meanings occupy bits 0–3 ONLY. Bits 4–6 remain free.
//
//   Invariants every state consumer must honor:
//     * `states & 0x80` is meaningful only where BLOCKS[id].waterloggable.
//       setBlock CLEARS bit 7 whenever the new id is not waterloggable (§8).
//     * A bit-7 cell IS a water source for EVERY system: fluid spread, buckets,
//       swimming/drowning, light filtering, hydration, lava interaction,
//       infinite-source formation. Use isWaterCell/isWaterSource — never a bare
//       `id === B.WATER`.
//     * Nibble reads must mask: `state & 0x0F`. A bare `state === 0` test for
//       "fluid source" is WRONG on a waterlogged cell.
//     * Toggling bit 7 must run the light edit AND neighbor updates even though
//       the id is unchanged (AMENDS 01 §4.6/§4.2).
export const WATERLOGGED = 0x80;      // blocks.js:38
export const STATE_NIBBLE = 0x0F;     // blocks.js:39
```

**Bits 4–6 are the only unclaimed per-voxel storage in the game** (`blocks.js:24`). There is no per-cell extra-data map besides `chunk.blockEntities` (`Chunk.js:27`).

Waterloggable set is **exactly 3 blocks** — `chest` (37), `ladder` (39), `oak_fence` (52) — assigned post-hoc at `blocks.js:783-787`. Leaves are a documented deviation (`blocks.js:781-782`).

Predicates (`blocks.js:42-50`): `isWaterCellAt(id,state)`, `isWaterSourceAt(id,state)`, `effFireEnc(id,state)`, `effFireBurn(id,state)`. Facades: `World.isWaterCell` (`:204`), `isWaterSource` (`:209`), `setWaterlogged` (`:217`), `clearedCell` (`:276`).

Enforcement: `World.js:111` (clear), `:117` / `:188-191` (flip detect + `setState` reroute), `:164` (re-schedule), `LightEngine.js:116` / `:269-270` (opacity), `LightEngine.js:56` (`terminatesSky`), `fluids.js:32` (strength 8), `fire.js:65,80,166` (inert fuel), `Game.js:572` (blast-proof: `Math.max(blk.blast, 100)`).

**Masking hazard, called out twice in-code** (`blocks.js:217-220`, `:457-460`): a waterlogged ladder is `0x81..0x84`; `WALL_DIR[state]` without `& STATE_NIBBLE` returns `undefined`. Only `ChunkMesher.emitLadder` masks (`mesh/ChunkMesher.js:413`).

### 2.3 `setBlock` — the write chokepoint

```js
setBlock(x, y, z, id, { state = 0, byPlayer = false, noUpdates = false } = {})   // World.js:101
```
Exact order (verified `World.js:101-169`):

| # | Step | Cite |
|---|---|---|
| 1 | `y < 0 \|\| y > MAX_Y` → false; chunk gate | `:102-104` |
| 2 | read `old`, `oldState` | `:106-107` |
| 3 | **`if (!BLOCKS[id]?.waterloggable) state &= ~WATERLOGGED;`** | `:111` |
| 4 | no-op bail `old === id && oldState === state` | `:112` |
| 5 | `waterlogFlip = (oldState & WATERLOGGED) !== (state & WATERLOGGED)` | `:117` |
| 6 | write `blocks[i]`, `states[i]`, `chunk.modified = true` | `:119-121` |
| 7 | `if (old === B.FIRE && id !== B.FIRE) forgetFire(x,y,z)` | `:130` |
| 8 | block-entity spill when `oldBlock.blockEntity !== newBlock.blockEntity` | `:133-139` |
| 9 | **synchronous relight iff `old !== id \|\| waterlogFlip`** | `:144-146` |
| 10 | `collectDirtyKeys` → `markDirty(k)`; **`if (byPlayer) rebuildNow(keys)`** | `:149-153` |
| 11 | *(if `!noUpdates`)* `onBroken?` then `onPlaced?` — **only when `old !== id`** | `:156-159` |
| 12 | `if (newBlock.fluid) fluids.schedule(x,y,z,newBlock.fluid)` | `:161` |
| 13 | `if (state & WATERLOGGED) fluids.schedule(x,y,z,'water')` | `:164` |
| 14 | `if (newBlock.gravity) checkFall(x,y,z)` | `:165` |
| 15 | `neighborUpdates(x,y,z)` | `:166` |

- A pure nibble change through `setBlock` does **no light work** but still runs 10–15.
- A state-only `setBlock` fires **neither** `onBroken` nor `onPlaced` but **does** fire `neighborUpdates`.
- `noUpdates: true` skips 11–15 but **not** relight or remesh.
- **`setBlock` throws on an unregistered id**: `:111` optional-chains, `:114` does not, `:133` dereferences → TypeError.
- **Re-entrancy is safe by ordering, not by lock.** `light.dirtied` is one shared Set (`LightEngine.js:65`) cleared at the top of `initialLight` (`:193`) and `onBlockChanged` (`:266`). `setBlock` copies it at step 10 *before* any hook can re-enter.

`setState(x,y,z,state,opts)` (`World.js:178`) — bit-7 XOR reroutes to `setBlock` (`:188-191`); otherwise **never touches light and never fires neighbor updates**. `opts.noRemesh` skips remesh dirtying; sole caller is fire aging (`fire.js:227`).

### 2.4 Scheduled ticks & neighbor updates

`ScheduledTicks` — `world/scheduledTicks.js:5`. `buckets: Map<dueTick, {keys:Set<string>, arr:number[]}>` (`:8`).
- `due = world.time + Math.max(1, delayTicks | 0)` — **minimum delay 1; delay 0 becomes 1** (`:12`).
- Dedup by `"x,y,z"` **per bucket only** (`:15-17`) — one cell can hold many pending entries at different due ticks.
- `run()` drains only `buckets.get(world.time)` (`:23-25`). **A skipped due tick is never drained.**
- Sim-radius deferral: chebyshev > `SIM_RADIUS` (6) → **rescheduled +40, not run** (`:31-32`).
- `clear()` (`:42`) — **nothing is persisted across save/load.**
- Dispatch → `World.blockTick` (`:36`).

`blockTick(x,y,z)` (`World.js:308`):
```js
310  if (id === B.AIR) return;
318  if (blk.fluid || (state & WATERLOGGED)) this.fluids.step(x, y, z);
319  else blk.scheduledTick?.(this, x, y, z, state);
```
**The fluid branch shadows `scheduledTick` for any waterlogged cell.** `World.js:315-317` asserts this is safe because no waterloggable block declares one — true today.

`neighborUpdates(x,y,z)` (`World.js:242`) — `DIRS6` (`:11`), **6 face neighbors, no diagonals, never the source cell**. Per neighbor: skip out-of-Y (`:245`); **skip if `nId === B.AIR`** (`:247`) — air cells never receive `neighborUpdate`; `nBlk.neighborUpdate?.()` (`:249`); `fluids.wake` if fluid or bit-7 (`:254`); `checkFall` if gravity (`:255`). **Recursion is unbounded** — no depth counter, no deferred queue.

`randomTicks()` (`World.js:323`) — 13×13 = **169 chunks** (`SIM_RADIUS = 6`, `constants.js:24`), **24 cells/chunk/tick** (`:330`) → **4056 draws/tick from `world.rng`** (`:331`), taken whether or not the block has a `randomTick`.

`world.rng = mulberry32(xmur3('world:' + seedString))` (`World.js:27-28`) — seeded, shared with weather/worldgen/loot. **fire.js deliberately uses `Math.random()` everywhere** to avoid consuming it (`fire.js:4-7`).

### 2.5 Light budget

`LIGHT_NODE_BUDGET = 100_000` (`constants.js:39`). `propagate` guard 400,000 popped nodes (`LightEngine.js:154`); `removeLight` guard 100,000 (`:185-187`). **Both are per-call locals. There is no cross-call or per-tick light budget** — an N-block edit does N unbudgeted synchronous BFS floods, and N `rebuildNow` passes if `byPlayer: true`.

`markDirty` (`LightEngine.js:119-127`) uses `else if` → adds at most one X-neighbor and one Z-neighbor, **never a corner diagonal** — unlike `World.collectDirtyKeys` (`World.js:234-237`) which does add all 4.

### 2.6 The architectural rule for a new engine — `World.js:353-356`, `fire.js` is the worked example

1. New module at `src/world/<name>.js`, importing **only** `registry/blocks.js`, `constants.js`, and leaf helpers. `registry/blocks.js` is pure and worker-safe and **must never import the engine**.
2. `World` imports it (`World.js:8`) and exposes **thin facade methods** (`World.js:353-368`).
3. Block registry hooks call `world.<facade>?.(...)` with optional chaining (`blocks.js:663,677,682`).
4. Scheduling is re-armed **inside the tick handler itself** (`fire.js:193`) and seeded from `onPlaced` (`blocks.js:676`).
5. Any per-cell side-table must be torn down from **both** `setBlock`'s chokepoint (the `World.js:130` pattern) **and** `Game.onChunkUnloading` (`Game.js:739`). `World.js:124-129` enumerates the five removal routes that never touch the owning engine.

---

## 3. Registry

### 3.1 ID ranges occupied

| Range | Contents | Storage |
|---|---|---|
| **0–66** | Blocks. Dense array `BLOCKS[]` (`blocks.js:56`), 67 entries, no holes. `air`=0 (`:308`) … `dead_bush`=66 (`:685`) | `Uint8Array(32768)` → **hard ceiling id ≤ 255. Free: 67–255.** |
| 0–66 (subset) | Block-items sharing the block id (`items.js:64`); 11 excluded by `NO_BLOCK_ITEM` (`items.js:55-59`) → 56 block-items |
| **256–280** | Tools: 5 materials × 5 kinds, loop-assigned (`items.js:89-98`), per material order sword, pickaxe, axe, shovel, hoe |
| **281–287** | `bow, arrow, shears, flint_and_steel, bucket, water_bucket, lava_bucket` (`items.js:100-106`) |
| **288–303** | Armor: 4 materials × 4 slots, loop from 288 (`items.js:116-124`), order helmet, chestplate, leggings, boots |
| **304–317** | Food, hard-coded ids (`items.js:128-143`) |
| **318–345** | Materials & misc, hard-coded (`items.js:153-180`); last = `oak_door` 345 |

**Item ids 256–345 are contiguous with no gaps. First free item id: 346.** `ITEMS` is a `Map` (`items.js:7`) — no density requirement. **The tool and armor loops assign ids in iteration order — inserting a material into `TIERS` (`items.js:75-81`) or `ARMOR` shifts every later id. Append only.**

### 3.2 `defBlock(id, name, opts = {})` — `blocks.js:248`, every supported field

Not exported. `...opts` **spreads last** (`:293`) — opts can override anything. Side effects: `BLOCKS[id] = block` (`:295`), `B[name.toUpperCase()] = id` (`:296`).

| Field | Default | Consumed at |
|---|---|---|
| `shape` | `'cube'` | Mesher switch `mesh/ChunkMesher.js:147-161`. 11 values + `'none'` |
| `bucket` | `'opaque'` | `mesh/ChunkMesher.js:185` — **honored only for `shape:'cube'`** |
| `opaque` | `true` | culling; `isSolidSupport` (`:91`) |
| `collidable` | `true` | physics |
| `targetable` | `true` | raycast |
| `renderSameIdFaces` | `false` | true only on the 3 leaves (`:345`) |
| `emission` | `0` | `LightEngine.js:223`, `:290-298` |
| `opacity` | `15` | `LightEngine.js:115`, `terminatesSky :57` |
| `hardness` | `0` | `-1` = unbreakable |
| `blast` | `0` | `Game.explode :572` |
| `tool` | `null` | `'pickaxe'|'axe'|'shovel'|'shears'` — never `'sword'`/`'hoe'` |
| `tier` | `null` | `null` \| `'class'` \| `0..3` — see §3.4 |
| `gravity` | `false` | `setBlock :165`, `neighborUpdates :255`, `checkFall :263` |
| `climbable` | `false` | ladder only |
| `slipperiness` | `0.6` | ice `0.98` |
| `replaceable` | `false` | exactly 8 blocks (`:311-315`) |
| `fluid` | `null` | `blockTick :318`, `setBlock :161`, `fluids.strength :35` |
| `fluidAlpha` | `1.0` | water `0.7` |
| `blockEntity` | `null` | `'furnace'|'chest'` — `setBlock` spill `:133-139`, `Game.js:461` |
| `interactable` | `null` | dispatch `player/interaction.js:394, :457` |
| `needsSupport` | `null` | **ZERO consumers outside the registry** |
| `collisionBox` | `null` | `[x0,y0,z0,x1,y1,z1]` or the string `'door'` (`:551`) |
| `tiles` | `all(name)` | 6-array, face order **`[+X, −X, +Y, −Y, +Z, −Z]`** (`:59`) |
| `tilesFor` | `null` | `(state, face) => tileName`; called as a **plain function** (`:816`), `this` undefined |
| `drops` | `dropSelf(name)` | `({state, toolClass, toolTier, rng}) => [{name, count}]` |
| `xpForMine` | `null` | called **as a method** (`interaction.js:273`); ore fns use `this` |
| `randomTick` / `scheduledTick` / `neighborUpdate` / `onPlaced` / `onBroken` | `null` | see §2 |
| `canPlaceAt` | `null` | `(world,x,y,z,state?) => bool` |
| `species` | `null` | `'oak'|'birch'|'spruce'` |
| `mat` | `'none'` | overwritten by MAT loop `:726-732` |
| `fireEnc` / `fireBurn` / `lavaIgnite` | `0/0/false` | overwritten by FIRE loop `:771-778` |
| `infiniteBurn` | `false` | **never set true by any block; sole reader `fire.js:197` is unreachable** |
| `waterloggable` | `false` | overwritten by the list `:783-787` |

`CROSS` preset (`:301-304`) spread into 10 blocks. **`mat`, `fireEnc`/`fireBurn`/`lavaIgnite`, and `waterloggable` are assigned post-hoc from name-keyed tables outside `defBlock`** (`:707-732`, `:748-778`, `:783-787`) — deliberately (`:696-700`). All validation is `console.warn`-only (`:729, :736, :773, :785, :805`) — a typo'd name silently yields defaults.

`finalizeBlockTiles(TILE)` (`:802`) is called once, main thread only, from `main.js:27`. It builds `block.tileIndex = Uint16Array(6)` and memoizes `tileIndexFor(state, face)` with cache key `((state & 15) << 3) | face` (`:815`) — **the key masks to the nibble, so `tilesFor` may never read bits 4–7.**

### 3.3 `defItem(id, name, opts = {})` — `items.js:10`, every supported field

`...opts` spreads last (`:36`). `ITEMS.set(id, item)` (`:38`); `NAME_TO_ID.set(name, id)` **only if absent — first registration wins** (`:39`).

| Field | Default | Notes |
|---|---|---|
| `stack` | `64` | `1` on tools/armor/bow/shears/flint_and_steel/filled buckets/bed; `16` on `bucket` and the 3 throwables |
| `kind` | `'material'` | in use: `material, block, tool, sword, shears, bow, flint_and_steel, bucket, armor, food, throwable, seed, bed, door` |
| `toolClass` | `null` | `sword|pickaxe|axe|shovel|hoe|shears` |
| `tier` | `null` | `0..3`. **`shears` has `tier: null`** (`:102`) |
| `speedMult` | `1` | swords forced to 1 (`:93`); shears 15 |
| `attackDamage` | `1` | |
| `attackSpeed` | `4.0` | hand / any non-tool |
| `durability` | `0` | 0 = indestructible |
| `armorSlot` | `null` | `0..3`; guard is `!== undefined && !== null` (`ui/containers.js:554`) |
| `armorPoints` / `toughness` | `0` / `0` | toughness 2 only on diamond |
| `hunger` / `saturation` / `poisonChance` | `0` | |
| `fuel` | `0` | ticks; read only via `fuelValue()` (`:288`) |
| `place` | `null` | block id placed by RMB |
| `placesAs` | `null` | `'bed'|'door'`; dispatch `interaction.js:407, :576, :588` |
| `plantsCrop` | `null` | carrot/potato patched post-hoc (`:149-150`) |
| `bucketFluid` | `undefined` | **tri-state**: undefined / `null` (empty) / `'water'` / `'lava'` |
| `sprite` | `` `item_${name}` `` | block-items get `null` (`:69`); HUD falls back to `BLOCKS[item.place].tileIndex[4]` (`ui/hud.js:17`) |
| `debugOnly` | `false` | `DEBUG_ONLY` set (`:60`) — **ZERO consumers anywhere in `src/`** |

### 3.4 Tool tiers

```js
export function harvestOK(block, toolClass, toolTier) {   // blocks.js:70-74
  if (block.tier == null) return true;
  if (block.tier === 'class') return toolClass === block.tool;
  return toolClass === block.tool && (toolTier ?? -1) >= block.tier;
}
const gated = fn => function (ctx) {                       // blocks.js:75-77
  return harvestOK(this, ctx.toolClass, ctx.toolTier) ? fn.call(this, ctx) : [];
};
```
`gated` **relies on `this` being the block** — works only because call sites use method syntax (`interaction.js:271`, `World.js:288`, `Game.js:583`).

```js
const TIERS = {                                            // items.js:75-81
  wooden:  { tier: 0, speedMult: 2,  dur: 59 },
  stone:   { tier: 1, speedMult: 4,  dur: 131 },
  iron:    { tier: 2, speedMult: 6,  dur: 250 },
  golden:  { tier: 0, speedMult: 12, dur: 32 },
  diamond: { tier: 3, speedMult: 8,  dur: 1561 },
};
```
**Obsidian is the only `tier: 3` block** (`blocks.js:400`).

### 3.5 Item-stack shape today — **there is no `tags` field**

`grep -rn "tags" src/` returns **zero hits.** Verified.

Two distinct shapes, not interchangeable:
- **Inventory stack**: `{ id, count, damage? }`. `damage` added lazily, only when non-`undefined` (`entities/Player.js:112-114`); spend writes `s.damage = (s.damage ?? 0) + n` (`:134`). Merge rule (`:96-104`):
  ```js
  const stackable = max > 1 && stack.damage === undefined;
  … if (s && s.id === stack.id && (s.damage ?? 0) === (stack.damage ?? 0) && s.count < max)
  ```
  **Anything with `damage` defined is unstackable regardless of `item.stack`.** Save packs exactly `{id, count, damage}` (`Player.js:683, :696`) — **any new stack field is dropped on save/load unless added there.**
- **Drop descriptor** from `block.drops`: `{ name, count }` — a *name*, not an id (`blocks.js:65, :83-86`). Converted at spawn: `game.spawnItemByName(d.name, d.count, …)` (`interaction.js:281`, `World.js:294`, `Game.js:584`, `mobs/Mob.js:268`). **This channel cannot carry per-stack data.**

Third merge rule, in the GUI: `same = (a,b) => a && b && a.id === b.id && (a.damage ?? 0) === (b.damage ?? 0)` (`ui/containers.js:11`) — **ignores every other field.**

---

## 4. Worldgen

### 4.1 Seed-stream pattern

Four levels:
1. **World seed** — `terrain.js:15-17`: `typeof seed === 'number' ? (seed >>> 0) : hashString(String(seed ?? ''))`. Mirrored on the main thread at `World.worldSeed = hashString(seedString)` (`World.js:16`).
2. **System sub-seeds** — `noise.js:120-123`, exactly **seven**, no more:
   ```js
   for (const s of ['terrain','carver','ore','tree','plant','herd','detail'])
     seeds[s] = mix32(worldSeed ^ hashString('sys:' + s));
   ```
   Exposed as `ctx.seeds` (`noise.js:287`). **There is no `structure` stream.** Derivation is string-keyed → **inserting a name does not perturb existing streams.**
3. **Per-chunk** — `splitmix32(chunkSeed(ctx.seeds.<sys>, ocx, ocz))`: `caves.js:62-63`, `ores.js:33`, `features.js:103, :124, :270`.
4. **Stateless per-position** — `posHash(seed, x, y, z)`, always on `ctx.seeds.detail`: `terrain.js:46`, `ores.js:71`, `features.js:35, :198`. Main-thread mirror: `World.detailSeed()` (`World.js:378`) re-derives `mix32(worldSeed ^ hashString('sys:detail'))` byte-identically.

**`World.rng` (`World.js:27-28`) is a separate, non-deterministic-order stream** used for drops/loot/explosions/weather — it is *not* part of the worldgen family.

**Two invariants that make neighborhood re-simulation work:**
- **A — draws are always consumed in spec order, regardless of skip decisions.** `caves.js:64-78` draws all worm params before the reach test at `:79`. `features.js:111-112` (`// roll always drawn`). `ores.js:39-42` (`// clipped tail; draws consumed`).
- **B — skip decisions run on independent child streams.** Documented `caves.js:6-12`:
  ```js
  const tRng = splitmix32(mix32(originSeed ^ Math.imul(w + 1, 0x9E3779B9)));   // caves.js:80
  ```
  Ores/trees rely on A alone — sound only because their ±1 radius means every attempt is always fully drawn.

**Cross-chunk purity rule:** any predicate consulted during a neighborhood pass must be a pure function of the seed, never a block read — the neighbor's blocks don't exist. Hence `surfaceBlockFor` (`biomes.js:77-82`, rationale `:75-76`), `isGenWater` (`noise.js:228`), `carvedByCheese` (`noise.js:273-284`). The **whole pure surface** is `noise.js:286-290`.

**Path-walking must use `tsin`/`tcos`** (`math/rng.js:85-86`, 4096-entry `Float32Array`), not `Math.sin` — bit-identical across engines.

### 4.2 Pipeline — `terrain.js:62-75`

```js
62  function generateChunk(cx, cz) {
63    const blocks = new Uint8Array(32768);
64    const colD = ctx.columnData(cx, cz);
65    fillTerrain(blocks, cx, cz, colD);
66    carveCheese(ctx, blocks, cx, cz, colD);
67    carveWorms(ctx, blocks, cx, cz);
68    lavaFlood(blocks);
69    placeOresAndPockets(ctx, blocks, cx, cz);
70    decorate(ctx, blocks, cx, cz, colD);
71    const heightMap = computeHeightMap(blocks);
72    const biomes = Uint8Array.from(colD.biome);        // copy: cache stays live — load-bearing
73    const spawns = rollHerd(ctx, cx, cz);
74    return { blocks, heightMap, biomes, spawns };
75  }
```

Terrain surface is hard-bounded to **y ∈ [40, 124]** (`noise.js:85`). Sea level 63 is hard-coded at `terrain.js:57`, `noise.js:228`, `caves.js:150-154`, `features.js:214` — **`SEA_LEVEL` (`constants.js:12`) is unused by gen.**

### 4.3 Neighborhood radii

| Pass | Origin radius | Constant | Reach guard |
|---|---|---|---|
| `carveCheese` | 0 | — | per-column `caves.js:23-49` |
| `carveWorms` / ravines | **±7** Chebyshev | `CARVE_R = 7` `caves.js:17` | `TUNNEL_REACH = 115` `caves.js:20`, tested `:79, :93` |
| `placeOresAndPockets` | ±1 | inline `ores.js:31-32` | none |
| trees | ±1 | inline `features.js:101-102` | none |
| plants / snow / herd | 0 | | |

**The ±7 / 115 pair is the widest existing multi-chunk mechanism and the closest working precedent for a village/fortress/stronghold generator.** Its shape: iterate origin chunks in a square → `originSeed = chunkSeed(ctx.seeds.<sys>, ocx, ocz)` → draw **all** parameters unconditionally → test a conservative reach bound → simulate on a child stream → clip every write to the current chunk.

**It is also mutually inconsistent — see §11.1. Copying it copies the bug.**

### 4.4 Worker boundary — `workers/terrainWorker.js` (33 lines, the only file in `src/workers/`)

- **main → worker**: `{ type:'init', seed }` once (`ChunkManager.js:38`, seed is the raw **string**); `{ type:'generate', cx, cz, jobId }` (`:88`).
- **worker → main**: `{ type:'ready', worldSpawn }` (`terrainWorker.js:14`); `{ type:'chunk', cx, cz, jobId, blocks, heightMap, biomes, spawns }` with 3 buffers **transferred** (`:18-25`); `{ type:'error', jobId, cx, cz, message }` (`:26-32`).
- **No spatial partitioning.** `WORKER_COUNT = 2` (`constants.js:26`), plain round-robin (`ChunkManager.js:86-87`). Each worker holds its **own** `createGenerator` (`terrainWorker.js:13`) → own `colCache` (LRU 128, `noise.js:164`), own per-layer memos. Adjacent chunks on different workers duplicate all lattice work.
- Flow control `MAX_JOBS_IN_FLIGHT = 16` (`ChunkManager.js:136`). The same `pending` map and `jobId` counter serve **both** worker jobs and IndexedDB hydrate jobs (`:144-146`).
- **Saved chunks skip the worker entirely** (`ChunkManager.js:142-150`).
- One retry, then `ChunkState.FAILED` (`:60-68`) — "visible hole = loud bug signal". `retries` is never cleared on success.

### 4.5 Where a new dimension hooks in

- **`world.dimension` is read but never written.** Verified: the only reference in the tree is `audio/music.js:129` (`const dim = g.world.dimension;`). `World`'s constructor (`World.js:14-29`) never assigns it. The `'nether'`/`'end'` mood branches (`music.js:129-131`) are permanently dead.
- Pre-wired but unconnected scaffolding: `audio/events.js:40-41` ("reserved: 10's blocks default nether, 11's default end"); `blocks.js:701` (nether/end sound classes); `music.js:25` (a full `nether` mood — `phrygianFragment`, 40 BPM, `padLp: 600`, `gain: 0.22`); `MAT_CLASSES` already contains `'nether'` and `'end'` (`events.js:79-84`) → `block.{step,dig,break,place}.nether` **already generate**.
- **BLOCKER — chunk keys have no dimension component**: `chunkKey = (cx,cz) => cx + ',' + cz` (`constants.js:19`), `Chunk.key` (`Chunk.js:17`), `World.chunks: Map<"cx,cz", Chunk>` (`World.js:17`). The IndexedDB `chunks` store is keyed by that same string (`saveManager.js:98, :123`) — **two dimensions collide in one object store.**
- **BLOCKER — worker protocol has no dimension field**; one generator per worker, bound at init (`terrainWorker.js:13`).
- **Fixed vertical geometry**: `MAX_Y = 127` (`constants.js:11`), `Uint8Array(32768)` (`terrain.js:63`), the `* 33` in `key3` (`noise.js:115`, hard-codes the 33-plane Y lattice), `gy <= 32` (`noise.js:235`), the `(y << 8)` shift everywhere.
- `chunkKeyN = (cx,cz) => cx * 131072 + cz` (`noise.js:116`) is injective only while `|cz| < 65536`; `WORLD_BORDER = 1_000_000` caps `|cz|` at 62500 — safe *as configured*.

### 4.6 Where a multi-chunk structure hooks in

- **Pipeline slot**: a new call in `generateChunk` (`terrain.js:62-75`). Position relative to `carveWorms`/`placeOresAndPockets`/`decorate` determines whether carvers cut it and whether `ores.js:69`'s stone-only rule still fires inside it.
- **Seed stream**: add a name to `noise.js:121`.
- **Radius pattern**: copy `carveWorms` (`caves.js:59-101`); co-derive the origin loop and reach bound.
- **Write clipping**: reuse `makePut` (`features.js:76-88`) or the `put(wx,wy,wz,id,mode)` callback of `placeTreeH` (`features.js:24`) — **the established sink abstraction that lets one generator serve both worker and runtime** (`Game.js:750-756` drives it with `world.setBlock`).
- **BLOCKER — no metadata channel**: `generateChunk`'s return shape (`terrain.js:74`) has no field for bounding boxes, piece graphs, or loot seeds. The worker message (`terrainWorker.js:18-25`) and the save record (`saveManager.js:67-77`) would each need one. `chunk.blockEntities` (`Chunk.js:27`) is the only existing per-chunk metadata channel and is keyed by block index.
- **`chunk.pendingSpawns` / `spawnsDone` is the working template** for "generator emits deferred records, main thread consumes once": produced `terrain.js:73` → transported `ChunkManager.js:78` → consumed `Game.js:697-706` → persisted `saveManager.js:74-75` → restored `Game.js:708-715`.
- **`chunk.modified` interaction**: generator-written structures are *not* `modified`, so they are regenerated rather than saved (`saveManager.js:116`, `ChunkManager.js:225`) — **a structure's block layout must stay a pure seed function forever, or existing worlds mutate.** `SAVE_VERSION` does not gate this.

---

## 5. Player, break/place pipeline, inventory

### 5.1 Inventory shape

- `inventory = new Array(36).fill(null)` — hotbar 0–8, main 9–35 (`Player.js:56`)
- `armor = new Array(4).fill(null)` — `[helmet, chest, legs, boots]`, index = `item.armorSlot` (`:57`)
- **`offhand = null`** (`:58`) — a **standalone field, not an inventory index**, despite the comment claiming "slot 45"
- `selectedSlot = 0` (`:59`); `get heldStack()` → `inventory[selectedSlot]` (`:84`)

`give(stack)` (`:93-119`) fills `[0..8, 9..35]` — hotbar first. **Never touches `armor` or `offhand`.** `hasItem(name)` (`interaction.js:356`) and `takeItem(name)` (`:361`) scan `inventory[0..35]` only — **neither sees `offhand` or `armor`.**

### 5.2 Break pipeline — exact call chain

```
Game.tick :197 → Interaction.tick(frame) :65
  → this.currentHit = this.rayHit()                        interaction.js:87  (one raycast/tick)
  → if (input.mouseLeft && !attacked) this.updateMining()  interaction.js:111
      → mineDelay > 0 → swingLoop(); return                :207
      → CREATIVE BRANCH :212-222 — bypasses breakBlock entirely:
          if (block.hardness < 0) return;                  // bedrock immune
          const cleared = world.clearedCell(x,y,z);
          world.setBlock(x,y,z, cleared.id, { state: cleared.state, byPlayer: true });
          particles.blockBreak(); swing(); mineDelay = 4;
      → d = miningDamagePerTick(block)                     :229 → :185-203
      → progress += d; progress >= 1 → breakBlock(); resetMining(); mineDelay = 6;   :236-250
```
```
breakBlock(x, y, z)                                        interaction.js:262-297
  1 read id / block / state BEFORE the erase               :264-266
  2 drops = block.drops({state, toolClass, toolTier, rng: world.rng})   :271-272
  3 xp    = block.xpForMine({...})                         :273
  4 erase: (state & WATERLOGGED) ? setBlock(B.WATER,{state:0,byPlayer:true})
                                 : setBlock(B.AIR,{byPlayer:true})      :278-279
  5 for (d of drops) game.spawnItemByName(d.name, d.count, x+.5,y+.5,z+.5)  :280-282
  6 if (xp > 0) game.spawnXpOrb(...)                       :283
  7 if (block.hardness > 0 && item?.durability) p.damageHeld(toolClass==='sword'?2:1)  :284-286
  8 p.addExhaustion(0.005)                                 :287
  9 SFX: id===B.FIRE ? 'block.extinguish' : `block.break.${matOf(id)}`  :290-295
 10 game.particles?.blockBreak?.(x,y,z,id)                 :296
```
`miningDamagePerTick` (`:185-203`): `damage = speed / hardness`, then `/= harvestOK(...) ? 30 : 100`; `speed /= 5` if `eyeSubmerged`; `/= 5` if `!onGround` (**also while flying**).

### 5.3 Place pipeline — exact call chain

```
Interaction.tick :118-120 → if ((input.rightPressed || (input.mouseRight && useDelay===0)) && !p.usingItem) this.use(input)
use(input)                                                 interaction.js:376-453
  0 entity interact: pickEntityTarget() → entTarget.interact(p, p.heldStack)  :382-389
  1 block.interactable && !p.sneaking → interactWith()     :392-399   (sneak is the only bypass)
  2 if (!held) return                                      :401
  3 held.place != null && hit  → tryPlace(held, hit)       :404-406
    held.placesAs && hit       → tryPlaceSpecial(held,hit) :407-409
  4 kind switch: food / bow / throwable / armor / bucket / hoe / plantsCrop / bone_meal / flint_and_steel   :412-452
```
```
tryPlace(held, hit) -> bool                                interaction.js:511-560
  1 hit.t > reach()                    → false             :518
  2 y < 0 || y > 127                   → false             :519
  3 !BLOCKS[targetId].replaceable      → false             :521
  4 block.collidable && entityBlocksPlacement(x,y,z) → false  :522
  5 per-block state: TORCH / LADDER / FURNACE / CHEST / PUMPKIN   :526-540
  6 block.canPlaceAt && !canPlaceAt(...) → false           :542
  7 waterlog: block.waterloggable && targetId===B.WATER && (getState & STATE_NIBBLE)===0
              → state |= WATERLOGGED   (SOURCES ONLY)      :549-552
  8 w.setBlock(x,y,z, blockId, { state, byPlayer: true })  :554
    this.emitPlace(blockId, x, y, z)                       :556
    if (p.gameMode !== 'debugCreative') p.consumeHeld(1)   :557
    this.swing(); return true                              :558-559
```
`placePosFor(hit)` (`:500-503`): `REPLACEABLE_TARGET(hit.id)` → place **into** the hit cell; else offset by `hit.face`. `hit.face` is the **outward normal of the entered face** (`world/raycast.js:31-35`).

### 5.4 Combat — `attack(target)` `interaction.js:151-181`

```js
const base = item?.attackDamage ?? 1;           // ITEMS default 1
const speed = item?.attackSpeed ?? 4.0;         // ITEMS default 4.0
const T = 20 / speed;
const charge = Math.min(1, Math.max(0, (p.ticksSinceAttack + 0.5) / T));
let dmg = base * (0.2 + 0.8 * charge * charge);
const crit = p.vel.y < 0 && !p.onGround && charge >= 0.848 && !p.sprinting && !p.inWater && !p.onLadder;
if (crit) dmg *= 1.5;
let kb = 0.4; if (p.sprinting) { kb += 0.5; p.stopSprint(); p.vel.x *= 0.6; p.vel.z *= 0.6; }
target.hurt(dmg, 'melee', { dirX, dirZ, knockback: kb, attacker: p });
if (item?.toolClass) p.damageHeld(item.toolClass === 'sword' ? 1 : 2);
p.addExhaustion(0.1); p.ticksSinceAttack = 0; this.swing();
```
`pickEntityTarget()` (`:135-149`) — **single target**, range capped at `min(3.0, blockHit?.t ?? 3.0)`, filter `x instanceof LivingEntity && x !== this.player && !x.dead`, picks smallest `rayAABB` t. **No `gameMode` reach bonus.**

### 5.5 `Player.tick(input)` movement branch — `Player.js:306-309`, strict if/else

```js
if (this.flying) this.flightMove(input);
else if (this.inLava) this.lavaMove(input);
else if (this.inWater) this.waterMove(input);
else this.landMove(input);
```
`flying` wins over every medium. **`flightMove` (`:483`) applies no collision-mode change** — flight still uses `move()` → full solid collision.

### 5.6 `gameMode` — every existing site (it already exists)

`Player.gameMode` (`Player.js:34`), values `'survival' | 'debugCreative'`. Serialized (`:693`), deserialized `?? 'survival'` (`:713`). Toggled by **F4 in `main.js:144`**, not in Game.

| Site | Effect |
|---|---|
| `Player.js:130` `damageHeld` | no durability spend |
| `Player.js:197` `addExhaustion` | exhaustion ignored |
| `Player.js:202` `tickHunger` | no drain — **and no regen** |
| `Player.js:547` `updateSprint` | double-Space toggles `flying` |
| `Player.js:574` `tickEnvironment` | `air=300; fireTicks=0;` early return — skips drown/lava/fire/suffocate/**void** |
| `Player.js:621` `beforeHurt` | all damage blocked except `source === 'void'` |
| `interaction.js:45` `reach()` | 5.2 vs 4.5 — **block ray only; entity attack stays 3 m** |
| `interaction.js:93` | middle-click pick-block gate |
| `interaction.js:212` | insta-break branch |
| `interaction.js:557` | skip `consumeHeld(1)` |
| `main.js:121, 144-147` | F4 toggle; forces `flying=false` → survival; palette visibility |
| `ui/menus.js:392` | creative block palette guard |
| `ui/hud.js:205, 208` | hides fire overlay; shows mode badge |
| `mobs/Mob.js:229` | hostiles don't target a creative player |
| `mobs/Enderman.js:66` | enderman ignores a creative player |

`flying` (`Player.js:33`) — toggled inside `updateSprint` (`:547-553`), branch `:306`, suppresses sneak `:528` and `sneakEdgeClamp` `:511`, zeroes `fallDistance` `:315-319`, gates landing SFX `:323` / bob `:344` / footsteps `:354`, reset in `respawn` `:674`, forced false `main.js:145`. **Not serialized** (`:682-699`).

---

## 6. Entities & mob AI framework

### 6.1 Base classes

`Entity` — `entities/Entity.js:23`. `baseTick()` (`:64`) **"MUST be called first from every subclass tick()"** — copies pos→prevPos, yaw→prevYaw, `age++`, `sampleLight()` every 4 ticks. `buildMesh()` (`:101`) → `null`; **primary render extension point**.

`LivingEntity` — `Entity.js:147`. Adds `health/maxHealth/invulnTicks/lastHurtAmount/hurtTime/deathTime/fallDistance/fireTicks` (`:150-157`). `static ARMOR_SOURCES = new Set(['melee','arrow','explosion','cactus','thorns'])` (`:164`).

Damage pipeline, exact order:
```
hurt(amount, source='generic', opts={})                    Entity.js:167
  1 if (this.dead) return false
  2 beforeHurt(amount, source, opts) — returns exactly false → cancel        :169
  3 i-frames: invulnTicks > 0 && source ∉ {'void','starve'}
       amount <= lastHurtAmount → return false
       else applyDamage(amount - lastHurtAmount, …, noNewWindow = true)
  4 else invulnTicks = 10; lastHurtAmount = amount; applyDamage(amount, …, false)
applyDamage(dmg, source, opts, noNewWindow)                Entity.js:185
  1 if (ARMOR_SOURCES.has(source)) { dmg = armorReduce(dmg); this.damageArmor?.(dmg); }
  2 this.health -= dmg; this.hurtTime = 10;
  3 if (!noNewWindow && opts.dirX !== undefined) applyKnockback(opts.knockback ?? 0.4, dirX, dirZ)
  4 this.onHurt?.(dmg, source, opts)
  5 if (this.health <= 0) this.die(source, opts)
```
`die(source, opts)` (`:215`) → `onDeath?.()`. **`Entity.js:218` is the sole call site of `onDeath` in the tree.**

`opts` contract: `{ dirX, dirZ, knockback = 0.4, attacker }` (`Entity.js:166`).

### 6.2 `EntityManager` — `entities/EntityManager.js:5`

`entities = new Map()` — **id → Entity, insertion order = tick order.** `add(entity)` (`:13`) is the only registration path.

`tick(player)` (`:32`): registers the player; pass 1 skips the player, `continue`s on `entity.dead` (incrementing `deathTime`), freezes anything beyond `SIM_RADIUS` (6) chebyshev or in a chunk `< GENERATED`; pass 2 reaps at `deathTime >= (deathAnimTicks ?? 0)`.

Lifecycle hooks the manager honours:

| Hook / field | Read at | Semantics |
|---|---|---|
| `tick()` | `:47` | only when alive, in-sim, chunk GENERATED |
| `dead` | `:37, :52` | set directly for instant reap |
| `deathAnimTicks` / `deathTime` | `:39, :53` | manager auto-increments `deathTime` while dead |
| **`onRemoved?.()`** | `:73` | **called on every removal path** (reap and chunk unload) — the one reliable teardown hook |
| `buildMesh()` | `:85` | called every frame until non-null |
| `needsMeshRebuild` | `:79` | forces teardown + rebuild |
| `mat.userData.shared` | `:69` | opt out of material disposal |

### 6.3 `Mob` — `entities/mobs/Mob.js:11`

`Mob.tick()` canonical order (`:82-163`): `baseTick()` → dead check `:86` → `tickTimers()` + cooldowns → baby maturity `:97` → `updateMedium()` + **`tickEnvironment()`** `:109` → `tickDespawn()` → **AI gate `if (pd <= 64) { updateTarget(player); runGoals(); }`** `:120` → `applyLocomotion()` → **`postMove?.()`** `:129` → `updateYaw()` → anim state → idle voice `:140` → footsteps `:152`.

`runGoals()` (`:278-296`) — single pass, array order, `claimed` bitmask. **Earlier index wins.** `MOVE = 1, LOOK = 2` (`ai.js:118`). A goal with `flags === 0` never blocks and is never blocked (`SwimGoal`, `ai.js:130`). `start()` is always followed by `tick()` in the same pass. **A goal cannot be pre-empted mid-run unless a higher-priority goal claims its flags first in the same pass.**

Locomotion contract: goals write **`moveIntent = {x,z}` (normalized), `moveSpeed`, `wantJump`**; `applyLocomotion` (`:300`) consumes them, then applies gravity `vel.y = (vel.y - 0.08) * 0.98` **unconditionally**.

Pathing: `pathTo` (`:364`), `followPath` (`:382`), `chaseTarget` (`:408`). **`astarBudgetOk` caps A* at 2 full runs per world tick, globally, shared across all mobs** (`ai.js:26-31`). `standable` (`ai.js:14`) reads **`mob.tall3`** (also needs `y+2`) and **`mob.wide3`** (needs the full 3×3) — the two mob-shape extension points into pathing.

### 6.4 Declaring a new mob — the checklist the code enforces

1. Class extends `Mob`. Ctor in-tree is `(world,x,y,z,opts={})` (Zombie/Passive) or `(world,x,y,z)` (Creeper/Skeleton/Spider/Enderman — **these four silently drop `opts`**).
2. Set `this.type` **after** `super()`. It keys: sound ids `mob.<type>.{idle,hurt,death}` (`Mob.js:147, :250, :262`), silent-idle test (`:145`), footstep threshold (`:154`), `serialize().type` → `Game.restoreEntity` dispatch (`Game.js:718-728`), `HOSTILE_TYPES` (`index.js:10`), same-species matching in `FollowParentGoal`/`BreedGoal` (`ai.js:277, :299`).
3. Set `width/height`, `health = maxHealth`, `hostile`, `undead`, `detectionRange`, `attackDamage`, `attackReach`, `walkSpeed`, `chaseSpeed`, `xpValue`; flags `tall3`, `wide3`, `armsForward`, `retaliates`, `takesFallDamage`, `persistent`.
4. `this.goals = [...]` — array order = precedence.
5. Optional overrides: `acquireGate()`, `updateTarget()`, `postMove()`, `tickEnvironment()`, `onHurt()`, `onHurtBy()`, `onDeath()`, `onRemoved()`, `armorPoints()`, `armorToughness()`, `damageArmor()`, `beforeHurt()`, `dropTable()`, `buildModel()`, `animateExtra()`, `interact(player, held)`, `onAteGrass()`, `tryDodgeProjectile()`.
6. **Register in `CTORS`** (`index.js:12-15`) — the sole factory table. `createMob` warns `'[mobs] unknown type'` and returns `null` otherwise (`index.js:17-19`).
7. Add to `HOSTILE_TYPES` (`index.js:10`) if hostile — counts against `MobSpawner`'s cap of 40 (`index.js:53`).
8. Add to `SPAWN_WEIGHTS` (`index.js:28`) for natural spawning.
9. Audio: add `MOB_IDLE[type]` (`events.js:322`) → `.hurt`/`.death` **auto-derive** (`events.js:590-607`).

`createMob` (`index.js:17`) consumes **one `world.rng` draw per creation** for yaw — including on save restore.

### 6.5 Non-mob entities

| Class | type | Key facts |
|---|---|---|
| `ItemEntity` `ItemEntity.js:85` | `'item'` | despawn 6000; merges every 40 ticks; killed by lava / fire (65) / cactus (43) |
| `Arrow` `Arrow.js:11` | `'arrow'` | lifetime 1200; `dmg = ceil(speed*2)`; **calls `tryDodgeProjectile()` at `:69`** |
| `XpOrb` `XpOrb.js:26` | `'xp_orb'` | magnet radius 7.25; `applyLightScalar()` no-op (`:88`) |
| `PrimedTnt` `PrimedTnt.js:8` | `'primed_tnt'` | `onRemoved` stops `fuseVoice` (`:32`) |
| `ThrownProjectile` `ThrownProjectile.js:10` | `'thrown_'+kind` | kinds hard-coded `{'egg','snowball','ender_pearl'}` |
| `FallingBlock` `FallingBlock.js:8` | `'falling_block'` | moves on Y only; **not restorable — see §11.9** |

Owner-immunity window: `(this.age > 5 || e !== this.owner)` (`Arrow.js:62`, `ThrownProjectile.js:42-44`).

### 6.6 Status-effect surface — **there is none**

`grep -riE "statusEffect|effects\b|potion|addEffect|hasEffect" src/` → **zero hits.** No effect list, no tick-down, no attribute-modifier layer, no `LivingEntity.effects`. The only per-entity timed states are ad-hoc fields: `invulnTicks`, `hurtTime`, `fireTicks`, `fallDistance` (`Entity.js:150-157`); on `Mob`: `hurtTimer`, `attackCooldown`, `breedCooldown`, `loveTicks`, `ageTicks`, `nextIdle`, `idleTime`, `directSteerUntil` (`Mob.js:28-61`).

### 6.7 Boss-relevant scaffolding already in the tree

- `MOB_IDLE` already defines voices for **unimplemented** types: `villager`, `iron_golem`, `ghast` (`events.js:505`), `blaze` (`:526`), `magma_cube` (`:530`), `wither_skeleton` (`:534`), `shulker` (`:544`), `dragon` (`:548`), `wither` (`:575`). None appear in `CTORS` (`index.js:12`) or `HOSTILE_TYPES` (`:10`).
- `MOB_DIST` already gives `dragon`/`wither` `{maxDist:96, refDist:8}` and `ghast` `{maxDist:48, refDist:4}` (`events.js:584`); `NO_IDLE` already contains `'wither'` (`:582`).
- **`Music.selectMood` already reads `game.bossActive`** (`music.js:129`) and `MOODS.boss` exists (`:23-30`); `Music.tick()` interrupts only for boss (`:356-361`). **`bossActive` is never assigned anywhere.**
- **No boss-bar UI hook, no `Mob` field for one.**

---

## 7. Render, atlas, UI screens

### 7.1 Mesher buckets — `mesh/ChunkMesher.js:72`

```js
const builders = { opaque: new Builder(), cutout: new Builder(), water: new Builder() };
```
**Module singletons — `build()` is not reentrant and cannot be moved to a worker without refactor.** Named `water`, not `transparent`.

`blk.bucket` is honored in **exactly one place** — `emitCube` (`:185`). Every other emitter hardcodes: `emitLiquid`/`emitWaterlogged` → `builders.water` (`:269, :300`); `emitCross`/`emitHash`/`emitLadder` → `builders.cutout` (`:375, :386, :415`); `emitBox` → `builders.cutout` unconditionally (`:455`).

Bucket → material binding: `ChunkManager.js:300-318`, `renderOrder = bucket === 'water' ? 10 : 0` (`:315`). The same literal array `['opaque','cutout','water']` appears at `ChunkManager.js:236`. **A fourth bucket requires editing both arrays plus `builders` and `build()`'s return object.**

Vertex `color` attribute is **`Uint8Array`, itemSize 4, normalized — not a color** (`:59`): **r** = skylight ×17, **g** = blocklight ×17, **b** = `AO_CURVE[ao] * shade` baked together, **a** = per-vertex alpha (255 except liquids). Shader recovers `vCol.r * 15.0` (`materials.js:32`).

Shape dispatch — one `switch (blk.shape)` at `ChunkMesher.js:147-161`. **11 shape strings + `'none'`.** A new shape = one `case` + an emitter. The generic emitter is `emitBox(x, y, z, blk, st, box, cull, opts = {})` (`:452`) — flat own-cell lighting, no AO, UVs cropped to the box.

Waterlogging is free for any new non-cube shape: `build()` runs the shape switch then unconditionally `if (st & WATERLOGGED) this.emitWaterlogged(x, y, z, blk)` (`:165`), which early-returns for `shape === 'cube'` (`:298`).

### 7.2 Materials — `mesh/materials.js`

`sharedUniforms` (`:40`) = `{ uAtlas, uSkyDarken, uSkyTint, uFogColor, uFogNear, uFogFar }`. **Contract: mutate `.value` only, never replace the uniform objects** (`:39`) — `make()` spreads references into all three materials (`:56`), so one write hits all three. **`DayNight.updateRender` (`env/DayNight.js:332-336`) is the only writer outside `createChunkMaterials`.**

`AMBIENT_FLOOR` is inlined at shader-compile time from `constants.js` via `${AMBIENT_FLOOR.toFixed(3)}` (`materials.js:24`).

### 7.3 Atlas tile allocation — `assets/atlas.js`

**512×512 canvas, 32×32 grid of 16×16 tiles = 1024 slots.** `ATLAS_SIZE = 512`, `TILE_PX = 16`, `ATLAS_COLS = 32` (`constants.js:33-35`).

```js
export const TILE_NAMES = ['missing', ...BLOCK_TILES, ...DESTROY_TILES, ...ITEM_TILES];   // atlas.js:42
```
- **0** = `'missing'` (magenta checker) — also the fallback for any name with no painter (`:64`) and for any unknown tile name in `finalizeBlockTiles` (`blocks.js:805`, warn-only).
- **1–96** = `BLOCK_TILES` (manual/fixed order, `:9-38`)
- **97–106** = `DESTROY_TILES` = `destroy_0..9` (`:39`)
- **107+** = `ITEM_TILES` = `Object.keys(PAINTERS).filter(n => n.startsWith('item_')).sort()` (`:40`) — **49 item tiles, alphabetical**

**≈156 of 1024 occupied; ~868 free.** **Item tile indices are not stable** — adding one `item_*` painter re-sorts and shifts every later index. Nothing persists tile indices, so this is safe at runtime, but any hardcoded index breaks.

**A new item sprite = one `P.item_<name> = …` entry in `assets/tilePainters.js`** — auto-picked-up, no atlas edit. **A new block tile additionally requires an entry in `BLOCK_TILES`** — a `P.foo` with no `TILE_NAMES` entry is never painted and `TILE['foo']` is `undefined`.

Painter signature: **`(ctx, x0, y0, rng) => void`**, RNG seeded per tile name (`atlas.js:63`). `animate(tick)` (`:90-102`) — **2 frames only**, swapping every 5 ticks, repainting the slot in place → **zero remesh**. Members must be in `TILE_NAMES` or they're silently skipped (`:96`).

### 7.4 How a new container GUI is added — the complete site list

`this.kind` is one of **`'inventory' | 'crafting' | 'furnace' | 'chest'`**, hardcoded. Adding a fifth touches, in order:

1. **`blocks.js`** — `interactable` (string), `blockEntity` (string), `tiles`/`tilesFor`.
2. **`Game.getBlockEntity(x,y,z)`** (`Game.js:455-470`) — a **ternary over exactly two types**:
   ```js
   be = kind === 'chest'
     ? { type:'chest', data:{ slots: new Array(27).fill(null) } }
     : { type:'furnace', data:{ slots:new Array(3).fill(null), burn:0, fuelTotal:0, cook:0, xpBank:0 } };
   ```
   **Any `blockEntity` string other than `'chest'` falls into the furnace branch and silently gets furnace data.**
3. **`Game.tickBlockEntities`** (`:472-486`) — `if (be.type !== 'furnace') continue;` (`:480`). A new ticking container needs its own branch.
4. **`player/interaction.js:457-471`** — the `interactable` switch. Gated upstream by `if (block.interactable && !p.sneaking)` (`:394`).
5. **`ui/containers.js:168-172`** — `open()` craft-grid allocation, keyed on kind.
6. **`ui/containers.js:264`** — `build()` title map, an object literal with **no fallback**; an unknown kind renders the string `"undefined"`.
7. **`ui/containers.js:270-359`** — `build()` if/else chain, one branch per kind.
8. **`ui/containers.js:540-559`** — `shiftTargets()` routing.
9. **`ui/containers.js:673`** — `tickOpen()`'s `stillThere` test, with **magic numeric ids**:
   ```js
   const stillThere = this.kind === 'furnace' ? (id === 35 || id === 36) : this.kind === 'chest' ? id === 37 : true;
   ```
   **A new positional screen defaults to `true` — it will never auto-close on block removal.**
10. **`ui/containers.js:658-664`** — `refresh()` gauges.
11. **`style.css`** — any new gauge / placeholder.

**Slot def contract** — `addSlot(panel, def)` (`:366`), `this.slots.push({...def, el})` (`:374`):

| field | meaning |
|---|---|
| `x`, `y` | **absolute GUI-px, top-left INNER corner** on a 176×166 reference panel; rendered `left: calc(${def.x - 1} * var(--gpx))` |
| `get: () => stack\|null` | **required** — reads live, never cached (`:430`) |
| `set: v => void` | **required** unless `takeOnly` (`:459`) |
| `region` | drives `shiftTargets`. Live: `main, hotbar, armor, offhand, craft, result, container, furnaceIn, furnaceFuel, furnaceOut` |
| `takeOnly` | routes to `takeResult()`; excluded from shift targets / `collectAll` / `numberSwap` / `offhandSwap` / `dropFromSlot` |
| `canPut: stack => bool` | honored in place/shift/number/offhand paths — **not in `set()` directly** |
| `placeholder` | → `el.dataset.ph`; CSS at `style.css:269-289`. Existing: `helmet, chestplate, leggings, boots, shield` |
| `onCraft()` | `takeResult` for `region === 'result'` — consumes one from each non-empty grid cell |
| `onTakeOut()` | `takeResult` for non-result take-only slots — **the furnace XP-drain precedent** (`:348-351`) |

`playerStorageDefs()` (`:215`) returns the 27 main + 9 hotbar defs — **every kind calls it** (`:307, :321, :333, :358`). Mutations must call `this.markBeDirty()` (`:419`), which sets `chunk.modified = true`.

`resultDef(x, y)` (`:238`) closes over `this.craftGrid`/`this.craftW` and `findRecipe` — **a non-crafting output slot must supply its own `takeOnly` def with `onTakeOut`, not `resultDef`.**

Host hooks live in `main.js`: `game.onContainerOpened` → `exitPointerLock` + `setState(PLAYING_UI)` (`:126-129`); `game.onContainerClosed` → `PLAYING` + `requestLock()` (`:130-135`); `onStateChange` force-closes on any exit from `PLAYING_UI` (`:119`).

### 7.5 HUD / F3

`Hud` (`ui/hud.js:21`) — one `overlayEl.innerHTML` (`:25-47`), 9 hotbar slots (`:66-72`), 4 pip rows of 10 (`:73-76`). All status glyphs are **emoji/unicode text**, not atlas tiles; only hotbar icons use `iconCss` (`:6`). `setDirty(key, value)` (`:117`) is the dirty primitive. **No effect display, no boss bar.**

`DebugOverlay.update()` (`ui/debug.js:19`) — throttled to **250 ms**, writes **one `textContent` template literal** (`:39-48`). **Adding an F3 line = extending that one literal. There is no line registry, no `addLine` API.**

---

## 8. Save schema

`SAVE_VERSION = 1`, `DB_NAME = 'mc-world'`, `DB_VERSION = 1`, `AUTOSAVE_INTERVAL = 600` ticks (`constants.js:43-46`). Object stores `'meta'` and `'chunks'` (`save/saveManager.js:18-19`).

### 8.1 Meta record — `saveManager.js:80-89`, key `'world'`

```js
{ version: SAVE_VERSION, seed: game.world.seedString, worldTime: game.world.time,
  weather: game.dayNight?.serialize() ?? null, player: game.player.serialize(), lastSaved: Date.now() }
```
`weather` = `{raining, thundering, rainTimer, thunderTimer, rainLevel, thunderLevel}` (`DayNight.js:369-375`) — **no `time`; that lives on `world`.**

`player` = `Player.serialize()` (`Player.js:682-699`): `pos, vel, yaw, pitch, health, hunger, saturation, exhaustion, foodPoisonTicks, xp (=xpTotal), air, fireTicks, fallDistance, gameMode, inventory, armor, offhand, selectedSlot, spawnPoint`. **`gameMode`, `offhand` and `spawnPoint` all persist. `flying` does not.** XP is stored as a single `xpTotal` and replayed through `addXp` under `_silentXp` (`:719-723`).

### 8.2 Chunk record — `saveManager.js:67-77`, key `chunk.key = "cx,cz"`

```js
{ cx, cz, blocks: chunk.blocks.buffer, states: chunk.states.buffer,
  biomes: chunk.biomes ? chunk.biomes.buffer : new ArrayBuffer(256),
  blockEntities: [{ i, type, data }], spawnsDone, spawns: chunk.pendingSpawns ?? null, entities: [...] }
```
**Deliberately absent, recomputed on load:** `heightMap` (top-down scan, `ChunkManager.js:96-113`), `skyLight`/`blockLight` (`Chunk.install` zero-fills, `LightEngine.initialLight` refills). **Also absent: any per-record version field** — only meta carries `version`.

Entity filter (`:59-66`): skip `game.player`, `e.dead`, and types `'player'`, `'arrow'`, anything `startsWith('thrown')`.

**Only `chunk.modified` chunks are written** (`:116`, `ChunkManager.js:225`). **This makes the generator's output part of the save contract: any gen change silently rewrites all unmodified terrain in existing worlds, and `SAVE_VERSION` does not gate it.**

### 8.3 Migration pattern — there isn't one

`open()` (`:28-31`): strict `!==` version gate → `console.warn('[save] incompatible save version — offering new world only')`, `this.meta = null`. **No migration path. And the chunk store is not cleared** — `savedChunkKeys` is still populated at `:32`, so a new world on a rejected save version will hydrate stale chunk records via `ChunkManager.js:142`.

**Not persisted at all:** `ScheduledTicks.buckets` (`scheduledTicks.js:42` — `clear()`, nothing survives save/load); `fireOrigins` (module-level Map, `fire.js:20-22`; hydrated fires self-register on first tick, `:200-205`); `EntityManager.nextId`.

`saveAll` (`:107-135`) **resolves, never rejects** on `onerror`/`onabort` — the caller cannot detect failure. Its `sync` option is destructured and **never referenced** (`:107`).

---

## 9. Audio surface

```js
export const audio = new AudioEngine();                                    // engine.js:473
export const emitSound = (id, pos, pitch, gain) => audio.emitSound(...);   // engine.js:474
export const startLoop = (id, target) => audio.startLoop(id, target);      // engine.js:475
export function at(x, y, z) { _pos.x = x; … return _pos; }                 // engine.js:480
```
`emitSound(eventId, pos = null, pitchMult = 1, gainMult = 1)` (`:272`) → a **loop handle** if `def.loop`, else `null` (`:359`). **There is no param channel** — this is why `block.door` splits into `.open`/`.close` and `block.note` into one id per instrument.

`at()` returns a **shared module-scope object** — never hold the return value (`:477-479`).

`startLoop(eventId, target = null)` (`:363`) — `target` is `{x,y,z}` | entity (has `.pos`) | `null`. Handle: `{ voice, get alive, setParam(name, value, tau=0.05), setPosition, stop(fadeSec=0.4) }` (`:371-399`). Every method no-ops on a stale handle (generation guard, `:52-53`).

**Registering a new event** — `def(id, o)` in `audio/events.js:15` (module-local; new events must live in that file). Schema: `recipe(v,t0,pitch,gain) -> stopTime` (required; `Infinity` for loops), `bus` (`'sfx'`), `refDist` (1), `maxDist` (16), `cap` (2), `capKey` (null), `priority`, `jitter` (**only `jitter: 0` disables**), `loop`, `muffle`, `distanceOnly`, `replicate` (**never read by `engine.js` — declarative only, for a future net layer**).

**Auto-generating families:** add a class to `STEP_DUR`/`CORES`/`BREAK_LAYERS` → all five of `block.step/dig/break/place.<cls>` + `mob.step.<cls>` generate (`events.js:87-115`). `MAT_CLASSES` **already contains `'nether'` and `'end'`** (`:79-84`). Add `MOB_IDLE[type]` → `.idle/.hurt/.death` auto-derive (`:590-607`).

**Hard constraints:** tick-only (`:2-3`); nothing audible before `ctx.state === 'running'` — pre-gesture emits are **dropped, not queued** (`:273`); max **16** voice starts/tick (`:14`), **24** positional + **8** flat voices (`:12-13`); no allocation in the emit path; loops are never stolen by priority (`:232`).

`drone` (`primitives.js:396-437`) is exported, fully implemented, and **used by zero events** — a live extension point for pads / portals / beacons / boss beds.

---

## 10. Integration points per upcoming phase

### E3/E4 — enchanting (`tags` schema, sweep attack, offhand, table/anvil/grindstone GUIs)

**`tags` does not exist. Adding it touches every stack-identity site:**

| Site | Change | Hazard if missed |
|---|---|---|
| `Player.js:96-104` `give()` merge | `stackable = max > 1 && stack.damage === undefined` → also `&& stack.tags === undefined` | enchanted books merge into one stack |
| `Player.js:683, :696` `packStacks` | packs exactly `{id,count,damage}` | **enchantments silently vanish on save/load** |
| `ui/containers.js:11` `same` | `a.id === b.id && (a.damage??0) === (b.damage??0)` — **ignores every other field** | enchanted + plain merge in the GUI |
| `blocks.js:65` drop descriptor `{name,count}` | no channel for tags | enchanted drops impossible via `spawnItemByName` |
| `Game.js:641` `spawnItemByName` → `idOf(name)` | name→id only | same |
| `ItemEntity.js:210` static `deserialize(world, rec)` | | dropped enchanted items lose tags |

Bits 4–6 of `states` (`blocks.js:24`) are irrelevant here — `tags` is item-side, not voxel-side.

**Sweep attack**: `interaction.js:151-181` `attack(target)` is strictly single-target; the target comes from `pickEntityTarget()` (`:135-149`). A sweep needs `entities.getEntitiesInBox(box, filter)` (`EntityManager.js:96`) — which exists and already carries a **±1 chunk margin** (`:97`). No hook exists; add it inside `attack` after the primary `target.hurt`.

**Offhand — already fully wired:** `Player.offhand` (`:58`), serialized (`:695`), deserialized (`:717`), GUI slot at `(77,62)` with `placeholder: 'shield'` (`containers.js:293`), `region: 'offhand'`, keyboard `KeyF` → `offhandSwap(hovered)` (`:590`), dropped on death (`Player.js:640-657`).
**HAZARD:** `give()` (`Player.js:93`), `hasItem` (`interaction.js:356`) and `takeItem` (`:361`) iterate `inventory[0..35]` only — **an offhand item is invisible to every "do I have X" query**, including `releaseBow`'s `takeItem('arrow')` (`:340`).

**Three new GUIs**: follow the 11-site checklist in §7.4. Specific hazards:
- `Game.getBlockEntity`'s ternary (`Game.js:463-465`) → **anvil/grindstone/enchant table silently get furnace data** unless the ternary becomes a registry.
- `tickOpen()`'s `stillThere` (`containers.js:673`) returns `true` for unknown kinds → **the screen never auto-closes when the block is broken.**
- `build()`'s title map (`:264`) has no fallback → renders `"undefined"`.
- Anvil/enchant need XP: `Player.addXp` (`:181`), `xpToNext(L)` (`:175`). The furnace `xpBank` + `onTakeOut` pattern (`Game.js:465`, `containers.js:348-351`) is the precedent.
- Grindstone (disenchant) must return XP — same path.
- New item ids ≥ 346 (`items.js:180` is the last, 345). **Append; do not insert into `TIERS`.**
- Audio: `ui.click` fires **first, for every slot in every container** (`containers.js:434`), above the takeOnly branch — a new `block.enchant`/`block.anvil_use` event goes in `events.js` via `def()`.

### E5 — redstone (tick-scheduled power engine, pistons, hoppers, observers)

**Engine placement**: follow §2.6 verbatim — `src/world/redstone.js`, importing only `registry/blocks.js` + `constants.js`; `World` facade methods next to `fireTick`/`fireNeighborUpdate`/`lavaFireAttempt` (`World.js:357-368`); block hooks `world.<facade>?.()` (the `blocks.js:663,677,682` pattern).

| Hazard | Cite |
|---|---|
| **Air cells never receive `neighborUpdate`** (`if (nId === B.AIR) continue`) | `World.js:247` |
| **No diagonal neighbor updates** — `DIRS6` only, 6 faces | `World.js:11, :242` |
| **`neighborUpdates` recursion is unbounded and synchronous** — no depth cap, no work queue | `World.js:242-256` |
| **Min scheduled delay is 1** — same-tick scheduling impossible | `scheduledTicks.js:12` |
| **`world.time++` is at step 201, after `scheduled.run()` at 199** — `schedule(1)` from inside a tick lands on the next `run()` | `Game.js:199-201` → `DayNight.js:133` |
| **Dedup is per due-tick only** — one cell can hold many pending entries | `scheduledTicks.js:15-17` |
| **Outside `SIM_RADIUS`(6), ticks are deferred +40, not dropped** — long circuits stall, then fire late in a burst | `scheduledTicks.js:31-32` |
| **`ScheduledTicks` is not persisted** (`clear()`) — **a mid-propagation circuit is lost on save/load** | `scheduledTicks.js:42` |
| **`blockTick`'s fluid/bit-7 branch shadows `scheduledTick`** — a waterloggable repeater/observer would never tick while waterlogged | `World.js:318` |
| **Only bits 4–6 are free** — dust power 0–15 needs 4 bits; the nibble is already spoken for on any block with facing | `blocks.js:24` |
| **State-only `setBlock` fires neither `onPlaced` nor `onBroken`** but does fire `neighborUpdates` — an observer watching a state change gets the neighbor update, not the hook | `World.js:156-159, :166` |
| **`setBlock` throws on an unregistered id** | `World.js:111` vs `:114, :133` |

**Pistons**: each moved cell is one `setBlock` → one **unbudgeted synchronous light BFS** (no cross-call budget, §2.5) plus, with `byPlayer: true`, one synchronous `rebuildNow` pass (`World.js:152`). A 12-block push = 12 floods + 12 rebuilds. The piston head / moving-block needs a new `shape` case (`ChunkMesher.js:147-161`) + `collisionBox` (`blocks.js:281`, string `'door'` is the only non-array precedent, `:551`).

**Hoppers**: block entity → the `Game.getBlockEntity` ternary hazard and the `tickBlockEntities` furnace-only filter (`Game.js:480`). That scan already skips chunks with `blockEntities.size === 0` and anything `< GENERATED` within `SIM_RADIUS` — the right shape, wrong filter.

**Already free**: **all §3.6 redstone sounds exist** (`events.js:736-783` via `mech(id, recipe, extra)`, `capKey: id` so each mech gets its own cap-2 family). `block.note.<instrument>` exists for 10 instruments (`events.js:791-814`); note pitch is `2^((n-12)/12)` as `pitchMult`, `FSHARP4 = 369.994` (`:788-790`).

**RNG**: redstone is deterministic — draw nothing. Do **not** touch `world.rng` (it is already at 4056 draws/tick from `randomTicks`, `World.js:330-331`).

### E6 — villages (multi-chunk structures, villagers + trading GUI)

**Worldgen** — §4.6 applies in full. Additionally:
- **The `CARVE_R`/`TUNNEL_REACH` mismatch (§11.1) is in the exact code you'll copy.** Co-derive the origin radius from the reach bound, don't inherit 7/115.
- Biome for decoration is sampled at **chunk center**, not per column (`features.js:104, :125`) — a village straddling a biome edge must not use that shortcut.
- Six parallel per-biome tables are all length-11 and indexed by biome id (`biomes.js:49, :55, :86-98, :100, :101, :106-116`) — a village-biome gate must edit whichever it reads. `BIOME_TEMPS` is read defensively (`DayNight.js:158` `?? 0.8`); the others are not.
- Structures are **not `chunk.modified`** → regenerated from seed, never saved. **A village's block layout must stay a pure seed function forever.** Loot chests must go through `chunk.blockEntities` (the only per-chunk metadata channel), which *is* persisted (`saveManager.js:55-57`, `ChunkManager.js:117-119`) — but a chest written by the generator is not `modified`, so it must be marked explicitly (the `Game.onChunkGenerated` pattern does exactly this at `Game.js:705`).

**Villagers**: `MOB_IDLE['villager']` and `['iron_golem']` **already exist** → `.hurt`/`.death` auto-derive. Register in `CTORS` (`index.js:12-15`); **not** in `HOSTILE_TYPES`, **not** in `SPAWN_WEIGHTS` (village-spawned, not natural). Set `persistent = true` (the `Passive` precedent, `passive.js:19`) so `tickDespawn` returns false immediately (`Mob.js:197`).

**Spawn delivery**: `chunk.pendingSpawns` / `spawnsDone` is the working template (§4.6) — `terrain.js:73` produces `[{type,x,y,z}]`, `Game.js:697-706` drains it with `{persistent: true}`.

**Trading GUI hazards**:
- Trades live on the **entity**, not a block entity. `open(kind, x, y, z)` sets `be = this.pos ? getBlockEntity(x,y,z) : null` (`containers.js:167`) — an entity-backed container has `be = null`, and `tickOpen`'s `stillThere` returns `true` for unknown kinds (`:673`) → **the trade screen never closes when the villager dies or walks away.** Both the distance check (`d > 8` to `p.pos.y + 1`, `:671`) and the still-there test need entity variants.
- `markBeDirty()` (`:419`) sets `chunk.modified` — useless for an entity-backed container; villager trade state must ride `Mob.serialize()` (`Mob.js:515-547`), which is already a flat union of foreign fields.
- Right-click entry is `entTarget.interact(p, p.heldStack)` (`interaction.js:384`); a truthy return consumes the click. `Passive.interact` (`passive.js:25`) and `Sheep.interact` (`:131`) are the only implementers.

### E7/E8 — nether (multi-dimension engine; netherite tier)

**Three hard blockers, in dependency order:**

1. **Chunk keys have no dimension component** — `constants.js:19`, `Chunk.js:17`, `World.js:17`, and the IndexedDB store key (`saveManager.js:98, :123`). **Two dimensions collide in one object store.** Every consumer of `chunkKey` must change together: `ChunkManager.pending` (`:22`), `requestList` (`:24`), `remeshQueue` (`:26`), `retries` (`:29`), `savedChunkKeys` (`saveManager.js:9`), `Entity.chunkKey` (`Entity.js:45`), `EntityManager.register` (`:20`), `World.collectDirtyKeys` (`:226`), `LightEngine.markDirty` (`:119`), and `fire.js`'s `posKey` origin map (`fire.js:27-28` — **string keys, world coords, already deliberately not bit-packed because ±1e6 overflows `MAX_SAFE_INTEGER`**).
2. **Worker protocol has no dimension field** — `{type:'init', seed}` (`terrainWorker.js:12-14`), `{type:'generate', cx, cz, jobId}` (`ChunkManager.js:88`). One generator per worker, bound at init (`terrainWorker.js:13`). Needs either a dimension arg on `generate` plus a generator map, or a second worker pool. Note `findWorldSpawn()` runs on **every** worker at init (`terrainWorker.js:14`) and `ChunkManager.js:50-53` keeps the first.
3. **`world.dimension` is read but never assigned** (`music.js:129`). Assigning it is the cheapest possible first step — it immediately activates the pre-built `nether`/`end` music moods (`music.js:25`) and the `Music.selectMood` branches (`:129-131`).

**Already free**: `MAT_CLASSES` contains `'nether'`/`'end'` → `block.{step,dig,break,place}.nether` already generate (`events.js:79-115`); `blocks.js:701` documents nether/end as the extension default for `mat`; `events.js:40-41` reserves the id ranges.

**Fixed vertical geometry** (all must move together for a 128-high nether with a bedrock roof): `MAX_Y = 127` (`constants.js:11`), `Uint8Array(32768)` (`terrain.js:63`), the `* 33` in `key3` (`noise.js:115`), `gy <= 32` (`noise.js:235`), `(y << 8)` everywhere, hard-coded sea level 63 (`terrain.js:57`, `noise.js:228`, `caves.js:150-154`, `features.js:214`), `caves.js:145`, `features.js:261`, `ores.js:67`.

**Per-dim sky**: `DayNight.updateRender` (`env/DayNight.js:288-367`) is the **only writer** of `sharedUniforms` (`:332-336`). A nether sky = a `dimension` branch there, plus the `sky.update({...})` payload (`:350-365`). The underwater/lava fog override (`:318-329`) is the precedent for a fixed-fog dimension.

**Per-dim save**: the meta record has one `worldTime`, one `weather`, one `player` (`saveManager.js:80-89`). Per-dim time/weather needs a schema change → `SAVE_VERSION` bump → **and the version gate discards meta but not chunks (§11.4)**, so the bump must also clear the chunk store.

**Portals**: bulk `setBlock` → N unbudgeted light floods (§2.5). Teleport precedents: `Enderman.teleportRandom` (`Enderman.js:160`), `ThrownProjectile` ender_pearl (`:90`). Neither crosses a dimension.

**Netherite tier**: `harvestOK` (`blocks.js:70-74`) already does a numeric `>=` compare — tier 4 needs no gate change. Add to `TIERS` (`items.js:75-81`) **at the end** — the tool loop (`:89-98`) and armor loop (`:117-124`) assign ids in iteration order, so **inserting shifts every later item id.** Obsidian is currently the only `tier: 3` block (`blocks.js:400`). New blocks must be added to `MAT` (`blocks.js:707`) or the warn loop at `:734` fires; new tiles need `BLOCK_TILES` entries (`atlas.js:9-38`), which shifts destroy+item indices (harmless — nothing persists them).

### E9 — potions (status-effect engine, brewing stand GUI)

**There is no status-effect system** (§6.6). Building one:

**Where the tick lives**: `LivingEntity` has no `tick()`. `tickTimers()` (`Entity.js:221`) is called from `Player.tick` (`:262`) and `Mob.tick` (`:90`) — the natural insertion point, and the only one both share.
**HAZARD: `EntityManager.tick` `continue`s on `entity.dead` before calling `tick()`** (`EntityManager.js:37-40`) → **effects on a dying entity never tick down**, and `Mob.tick`'s own dead branch (`Mob.js:86`) is unreachable from the manager.

**Attachment points that already exist and are already used**:

| Point | Signature | Cite | Existing user |
|---|---|---|---|
| Damage veto | `beforeHurt(amount, source, opts) → false` | `Entity.js:169` | `Player.beforeHurt` (`:620`) |
| Post-damage | `onHurt(dmg, source, opts)` | `Entity.js:195` | `Mob` (`:245`), `Enderman` (`:184`), `Player` (`:625`) |
| Armor (→ Resistance) | `armorPoints()` / `armorToughness()` / `damageArmor(dmg)` | `Entity.js:160, :161, :188` | `Zombie.armorPoints` (`:39`), `Player` (`:146-158`) |
| Death | `onDeath(source, opts)` | `Entity.js:218` | `Mob` (`:259`), `Player` (`:640`) |
| **Teardown** | `onRemoved()` | `EntityManager.js:73` | `Creeper` (`:81`), `PrimedTnt` (`:32`) — **the only hook guaranteed on every removal path** |
| Environment | `tickEnvironment()` | `Mob.js:109`, `Player.js:337` | base only / Player |

**BLOCKER — there is no attribute layer.** Speed/Strength/Haste have nowhere to attach:
- `Player.landMove` computes `speed = onGround ? 0.1 * mult * Math.pow(0.6/slip, 3) : 0.02 * mult` inline (`Player.js:414`); `mult` is `sprinting ? 1.3 : 1.0`.
- `Mob.walkSpeed`/`chaseSpeed` are per-class literals (`Mob.js:20-21`).
- `attack()` reads `item?.attackDamage ?? 1` directly (`interaction.js:152`).
- `miningDamagePerTick` reads `item.speedMult` directly (`interaction.js:191`).
Each needs a multiplier hook that does not exist today.

**Persistence**: `Player.serialize()` (`:682-699`) and `Mob.serialize()` (`Mob.js:515-547`, already a flat union) both need an `effects` field. `packStacks` (`:683`) drops unknown stack fields — potion items with per-stack data hit the same wall as E3's `tags`.

**Brewing GUI**: the §7.4 checklist, plus a `tickBlockEntities` branch (`Game.js:480` is furnace-only). Potion items: `defItem` id ≥ 346, a new `kind`. **`use()`'s kind dispatch (`interaction.js:412-452`) and the use-channel (`:301-333`) hard-code exactly two kinds — `'eat'` and `'bow'`.** Drinking is a third. Splash potions ride `kind: 'throwable'` → `throwHeld` (`:755`) → `ThrownProjectile`, whose kinds are hard-coded `{'egg','snowball','ender_pearl'}` (`ThrownProjectile.js:10`).

**HUD**: no effect display. `#status-rows` is one `innerHTML` template (`hud.js:25-47`); `setDirty(key, value)` (`:117`) is the primitive.

**Audio**: `drone` (`primitives.js:396-437`) is the unused loop primitive for a brewing bubble loop.

### E10 — end (stronghold, end gen, elytra physics, shulker box)

- **Stronghold** = E6's multi-chunk problem + the §11.1 hazard.
- **End gen** = E7/E8's three blockers, in full.
- **Elytra**: `Player.tick`'s movement branch (`:306-309`) is a strict if/else — elytra needs a new branch, ordered against `flying`. `flightMove` (`:483`) is the precedent (`speed = 0.049 * (sprinting ? 2.0 : 1.0)`, clamp `vel.y` to ±0.375, no collision-mode change). **HAZARD: `flying` is not serialized** (`:682-699`) — glide state will be lost across save/load unless explicitly added. **HAZARD: `canSprint` (`:531-537`) does not check `flying`** — Ctrl already doubles flight speed; elytra will inherit that.
  Armor slot: `armorSlot` 0..3 (`items.js:22`), chestplate = 1; `Player.armor = new Array(4)` indexed by `item.armorSlot` (`:57`). Equip path (`interaction.js:432-440`) **only equips if the slot is `null`** — no swap. Fall damage: `takesFallDamage !== false` (`Entity.js:236`); `Chicken` (`passive.js:177`) is the opt-out precedent.
- **Shulker box**: **inverts the existing block-entity contract.** `setBlock` step 8 (`World.js:133-139`) **spills** block-entity contents via `game.spillBlockEntity` whenever `oldBlock.blockEntity !== newBlock.blockEntity`. A shulker box must instead capture contents into the dropped item — **which requires E3's `tags` first.** The `blockEntities` save round-trip (`saveManager.js:55-57`, `ChunkManager.js:117-119`) works as-is once placed.
- `MOB_IDLE['shulker']` (`events.js:544`) and `['dragon']` (`:548`) already exist.
- Chorus/end-stone blocks: new ids 67+ (free), `MAT` entry required (`blocks.js:707`, else warn at `:734`), `BLOCK_TILES` entry (`atlas.js:9-38`), `'end'` mat class already reserved (`blocks.js:701`, `events.js:79-84`).

### E11 — bosses (boss bar, dragon/wither state machines, beacon)

**Already scaffolded**: `MOB_IDLE['dragon']` (`events.js:548`), `['wither']` (`:575`); `NO_IDLE` contains `'wither'` (`:582`); `MOB_DIST` gives both `{maxDist:96, refDist:8}` (`:584`). **`Music.selectMood` already reads `game.bossActive`** (`music.js:129`), `MOODS.boss` exists (`:23-30`), and `Music.tick()` interrupts only for boss (`:356-361`) — **assign `game.bossActive` and boss music works with zero audio work.**

**Hard limits that break a boss fight:**

| Limit | Cite | Effect |
|---|---|---|
| `if (pd <= 64)` AI gate in `Mob.tick` | `Mob.js:120` | a boss further than 64 blocks runs no goals at all |
| `SIM_RADIUS = 6` entity freeze (~96 blocks) | `EntityManager.js:44`, `constants.js:24` | dragon leaves sim range mid-fight |
| **2 A\* runs per world tick, globally** | `ai.js:26-31` | a boss competes with every other mob for pathing |
| `detectionRange` default 16 | `Mob.js:17` | per-class, easily raised |
| `applyLocomotion` applies gravity unconditionally | `Mob.js:300` | a flying boss must **override `applyLocomotion`**, not use `postMove` (`:129`) |
| `deathAnimTicks = 20` | `Mob.js:24` | reaped at `deathTime >= deathAnimTicks` (`EntityManager.js:53`) |

**HAZARD — `Mob.onDeath`'s `noDrops` guard is unreachable** (§11.7): `noDrops = true` is set only in `Mob.despawn` (`:212`) and `Creeper`'s `SwellGoal` (`Creeper.js:37`), and **both set `dead = true` directly, never calling `die()`.** Since `onDeath` runs only from `LivingEntity.die` (`Entity.js:218`), a boss that ends itself the same way emits **no death sound and drops nothing**. Bosses must call `die()`.

**Boss bar**: no hook exists. `Hud` is one `innerHTML` template (`hud.js:25-47`) with `setDirty(key, value)` (`:117`) as the only primitive. `#status-rows` (`:31-36`) is the container to extend.

**Beacon**: block entity (→ the `getBlockEntity` ternary hazard) + a beam. No beam precedent — `Sky`'s `band` (`Sky.js:139`, `CircleGeometry` + radial-fade shader, additive) is the closest existing custom-shader mesh. Beacon effects depend on **E9**.

**Wither skulls**: `ThrownProjectile`'s kinds are hard-coded (`ThrownProjectile.js:10`); `Arrow` is the better template (real nearest-scan at `:61-65`, `tryDodgeProjectile` hook at `:69`).

### E12 — multiplayer (host-authoritative sync of all game state)

**Determinism audit — what is and isn't reproducible:**

| Stream | Seeded? | Cite |
|---|---|---|
| Worldgen (7 sub-streams) | **yes**, fully | `noise.js:120-123` |
| `world.rng` | seeded, but **order-dependent** — `mulberry32(xmur3('world:'+seed))` | `World.js:27-28` |
| — consumed by `randomTicks` | **4056 draws/tick** | `World.js:330-331` |
| — consumed by `popBlock` loot | `World.js:288-290` |
| — consumed by `Game.explode` | `Game.js:550` |
| — consumed by `DayNight` weather | `DayNight.js:113` |
| — consumed by `createMob` yaw | **one draw per creation, including on save restore** (`index.js`) |
| **`fire.js`** | **`Math.random()` everywhere, deliberately** | `fire.js:4-7, :44` |
| `ambience.js` | `Math.random()`, deliberately (client-only) | `ambience.js:71-72` |
| `Music` | `mulberry32(xmur3(seed+':music:'+pieceIndex))` (client-only) | `music.js:145` |

**→ Fire cannot be lockstepped.** It must be host-authoritative and replicated. Everything drawing from `world.rng` is reproducible *only if call order is identical* — any client-side divergence (a mob spawn, an explosion, a loot roll) desyncs the whole stream.

**State that must sync**, and what is missing:

| State | Where | Missing |
|---|---|---|
| `chunk.blocks` / `states` / `blockEntities` | `Chunk.js:18-27` | serializable today (`saveManager.js:67-77`) |
| `entities` Map | `EntityManager.js:6` | **`nextId` is a local counter** (`:11`) → id collisions across hosts |
| `Player` | `Player.serialize()` `:682-699` | one player per meta record (`saveManager.js:85`) |
| `world.time` / `skyDarken` | `World.js:19-20` | fine |
| weather | `DayNight.serialize()` `:369-375` | fine |
| **`ScheduledTicks.buckets`** | `scheduledTicks.js:8` | **`clear()` only — no serializer exists** (`:42`) |
| **`fireOrigins`** | `fire.js:27-28` | **module-level Map, never saved** (`:20-22`) |

**Input**: `Input.snapshot()` (`input.js:67-93`) already produces the right shape and drains its own edge buffers — but **`pressed` is a `Set`** (not JSON) and `NEUTRAL_FRAME` (`Game.js:34-38`) is a **shared mutable module-level object whose `pressed` Set is handed to `player.tick()` on every non-playing tick.** `releasedBuf` is maintained (`input.js:33`) and cleared (`:89`) but **never surfaced** — no consumer can see release edges.

**The lockstep boundary** is `Game.tick()` (`Game.js:187-232`) — steps 196–202 are the simulation; 204–212 are presentation + chunk streaming.

**`replicate` is already annotated per-event** in `events.js` and is **never read by `engine.js`** — the audio layer's net contract is pre-declared and waiting.

**HAZARD — `window.game` is DEV-only** (`Game.js:83`), and `saveManager.saveChunkNow` depends on it (§11.2). Any host/client split must not inherit that.

### EC — creative mode (gameMode save field, flight, instant-break/no-drops, creative inventory)

**Everything on the headline list already exists** (§5.6). The real work is fixing the inconsistencies the maps surfaced:

| # | Defect | Cite |
|---|---|---|
| 1 | **Creative consumption is inconsistent.** `tryPlace` guards (`:557`), but `tryPlaceSpecial` door/bed (`:584, :596`), `plantSeed` (`:611`), `useBoneMeal` (`:652`), `throwHeld` (`:765`), `dropHeld` (`:777`), eat (`:324`), `fillBucketStack` (`:716`), `useBucketFilled` (`:739, :751`) and `releaseBow`'s `takeItem('arrow')` (`:340`) all consume unconditionally | `interaction.js` |
| 2 | `damageArmor` has **no creative guard** while `damageHeld` does | `Player.js:158` vs `:130` |
| 3 | `onDeath` drops the full inventory/armor/offhand and wipes XP **regardless of `gameMode`** | `Player.js:640-657` |
| 4 | **Creative players cannot die at all.** `beforeHurt` (`:621`) blocks everything but `'void'`; `tickEnvironment` (`:574`) early-returns before the void checks ever run, so neither `hurt(4,'void')` (y<−8) nor `die('void')` (y<−64) is reachable | `Player.js:574, :621` |
| 5 | `tickHunger` creative early-out → **no drain, but also no regen** | `Player.js:202` |
| 6 | `canSprint` **does not check `flying`** — Ctrl while flying sets `sprinting`, doubling `flightMove` speed (`:484`) and triggering the 1.10 FOV | `Player.js:531-537` |
| 7 | Flight toggle lives **inside `updateSprint`**, not a flight state machine, and consumes `Space` (also the jump key) | `Player.js:547-553` |
| 8 | **`flying` is not serialized** — lost across save/load while `gameMode` survives | `Player.js:682-699` |
| 9 | Insta-break **bypasses `breakBlock` entirely** → no drops, no XP, no exhaustion, no tool damage, **and no `block.break.*` / `block.extinguish` SFX**. Bedrock still immune (`hardness < 0`). Rate = 1 block / 4 ticks | `interaction.js:212-222` |
| 10 | `reach()` is 5.2 vs 4.5 for **blocks only** — entity attack stays at 3 m (`pickEntityTarget` `:135-149`) | `interaction.js:45` |
| 11 | **`debugOnly` and its `DEBUG_ONLY` set have zero consumers** — the field exists for exactly this feature and is unused | `items.js:35, :60, :70` |
| 12 | F4 lives in `main.js`, **not gated on game state** — toggles during LOADING or DEAD (guarded only by `game.player` truthiness) | `main.js:143-147` |
| 13 | `setPaletteVisible` is called from **two sites with the same predicate** that must stay in sync manually | `main.js:120-121` and `:147` |
| 14 | Middle-click pick-block **overwrites the slot outright**, no `give()` | `interaction.js:93-97` |
| 15 | `entityBlocksPlacement` **does not exclude the player** — your own body blocks placement of any collidable block into a cell you overlap | `interaction.js:505-509` vs `:144` |
| 16 | `tryPlace` bounds `y > 127` (`:519`) vs `tryPlaceSpecial` `y > 126` (`:573`) — different ceilings for the same world height | `interaction.js` |
| 17 | `'KeyQ'` is hardcoded rather than `KEYBINDS.drop`; `Player.js:540/547` hardcode `'KeyW'`/`'Space'` — **rebinding in `constants.js` silently breaks double-tap sprint, flight toggle, and drop** | `interaction.js:90` |

**Creative inventory**: `#debug-palette` (`menus.js:373-399`) is inline-styled (`:124-130`), a 7×48px grid, built lazily once (`paletteBuilt`, `:375`), filtered by `item.name.includes(filter)`, LMB gives `item.stack ?? 64` / RMB gives 1 (`:393`), guarded to `gameMode === 'debugCreative'` (`:392`).

---

## 11. Known broken / suspicious code found while mapping

Ordered by blast radius for the phases above.

1. **`CARVE_R = 7` and `TUNNEL_REACH = 115` are mutually inconsistent** — `caves.js:17, :20, :60-61, :79`. Enumeration covers 112 blocks; the reach test admits 115. For `ocx = cx - 8`, starts land in `[cx*16 − 128, cx*16 − 112)`, so any start with `sx ∈ (cx*16 − 115, cx*16 − 112)` passes the reach bound yet is **never enumerated** — while chunk `(cx+1, cz)` *does* enumerate it. Result: a **hard-edged cave truncation exactly on the chunk border**, not a shortened tunnel. Rare (needs a near-maximal ~109-step tunnel), but a genuine radius/bound mismatch. The comment at `caves.js:18-19` derives 115 correctly; `CARVE_R = 7` covers only 112. **E6/E10 copy this code.**

2. **`saveManager.saveChunkNow` resolves `game` from a DEV-only global** — `saveManager.js:94`: `const game = chunk?.gameRef ?? window.game;`. **`gameRef` is never assigned anywhere in `src/`** (verified: that line is the only occurrence); `Chunk` has no such field (`Chunk.js:26-34`). `window.game` is assigned **only under `import.meta.env?.DEV`** (`Game.js:83`). **In a production Vite build, any chunk that has entities fails to persist on the unload path**: `serializeChunk(chunk, undefined)` throws at `if (e === game.player || e.dead)` (`:60`), swallowed by the try/catch (`:102-103`) as `[save] chunk write failed`. The throw precedes `savedChunkKeys.add` and `chunk.modified = false`, and `unloadPass` deletes the chunk immediately after (`ChunkManager.js:228`), so it is never retried. Chunks with zero entities serialize fine.

3. **A second `disposeWorld()` throws — Save & Quit → Continue is broken in-session.** `Game.js:122-134` guards on `this.chunkManager` (`:123`) but dereferences `this.world.chunks` (`:125`), and never nulls `chunkManager`. After `onQuit` (`main.js:85-89`) sets `world = null` while leaving `chunkManager` set, the next `startWorld` → `disposeWorld()` (`Game.js:89`) → **`TypeError: Cannot read properties of null (reading 'chunks')`** → caught at `main.js:54-58` → back to TITLE. **No world can be started again without a page reload.** The first-ever `startWorld` is unaffected (`chunkManager` is `null` from the ctor, `Game.js:66`). Verified.

4. **Version mismatch discards meta but not chunks** — `saveManager.js:28-31`. `savedChunkKeys` is still populated from the old store at `:32`, so a new world on a rejected save version **hydrates stale chunk records** via `ChunkManager.js:142`. Any `SAVE_VERSION` bump (E7/E8, E9, E12 all need one) must also clear the chunk store.

5. **`world.dimension` is read but never assigned** — `music.js:129` is the only reference in the tree; `World`'s ctor (`World.js:14-29`) never sets it. The nether/end mood branches are permanently dead. Verified.

6. **Restoring a saved adult zombie has a 5% chance of turning it into a baby.** `Game.restoreEntity` calls `createMob(world, rec.type, …, {})` (`Game.js:725`); `Zombie`'s ctor rolls `(!opts.noBabyRoll && world.rng() < 0.05)` (`Zombie.js:21`) **before** `deserialize(rec)` runs, and `Mob.deserialize` has only an `if (rec.isBaby)` branch (`Mob.js:534`) — no else to undo it. **If the roll also fires on a saved baby, the hitbox is double-halved** to 0.15 × 0.4875, and `growUp()` restores only to 0.3.

7. **`Mob.onDeath`'s `noDrops` guard is unreachable.** `noDrops = true` is set only at `Mob.js:212` (`despawn`) and `Creeper.js:37` (`SwellGoal`), and **both set `dead = true` directly, never calling `die()`.** `onDeath` runs only from `LivingEntity.die` (`Entity.js:218`, the sole call site), so `if (this.noDrops) return;` (`Mob.js:263`) can never execute — and a detonating creeper or despawning mob emits **no `mob.*.death` at all**. The comment at `Mob.js:260-261` justifying the sound ordering describes a path that cannot be taken. Same for the void kill at `Mob.js:193`. **Directly relevant to E11.**

8. **The player is silently removed from `EntityManager.entities` on first death.** `tick`'s first loop skips the player (`:36`) and `updateRender` skips it (`:78`), but the **reap loop does not** (`:51-55`). `Player` has no `deathAnimTicks` → `0 < (undefined ?? 0)` is false → `remove(player)` runs while `state === DEAD` (entities still tick, `Game.js:195-198`). `Player.respawn` sets `dead = false` (`Player.js:676`) but never re-adds. `register(player)` (`:34`) repairs `chunk.entities`, so `getEntitiesInBox` self-heals; the lasting effect is that **`entities.count(filter)` no longer sees the player.**

9. **Saved `FallingBlock`s are dropped on load with a console warning.** `FallingBlock.serialize` emits `type: 'falling_block'` (`:54`); `saveManager`'s filter excludes only `player`/`arrow`/`thrown*` (`:62-63`), so the record is written; `restoreEntity` (`Game.js:724`) falls through to `createMob(world, 'falling_block', …)` → `'[mobs] unknown type'` → `null` (`index.js:19`). The comment at `FallingBlock.js:55` claims saveManager handles this; **it does not.**

10. **`Spider.forcedAggro` is never reset.** `Mob.onHurt` sets it on **every** mob for any attacker-bearing hit (`Mob.js:254`); nothing clears it. `Spider.updateTarget` (`:58`) only drops the target when `!forcedAggro` → **a spider hit once has its light gate disabled permanently.**

11. **Snowball/egg knockback is applied twice.** `ThrownProjectile.impact` (`:75`) calls `hurt(0, 'melee', {dirX, dirZ, attacker})` — which applies knockback inside `applyDamage` (`Entity.js:192-194`) — then line `:76` calls `applyKnockback?.(0.4, …)` again, **unguarded**, so it also knocks back through i-frames and against already-dead targets.

12. **`ThrownProjectile` hits the first candidate, not the nearest** — `:45` is `candidates[0]`, and `getEntitiesInBox` returns chunk-iteration order. The comment at `:34` says "nearest". `Arrow.tick` (`:61-65`) does a real nearest-scan.

13. **`Creeper`, `Skeleton`, `Spider`, `Enderman` silently ignore `opts`** — their ctors are `(world, x, y, z)` while `createMob` passes `opts` as the 5th arg (`index.js:20`). `spawnMobAt('creeper', x, y, z, {isBaby: true})` is a no-op for the baby flag (`persistent` still works — applied externally at `index.js:21`).

14. **`Mob.updateRender` writes tick state from render code** — `this.hurtTime = 5` every frame while dead (`Mob.js:469`) to pin the red tint.

15. **`raycast.js:25` is the one file that violates the bit-7 masking rule.** `world.getState(x, y, z) === 0` is a bare, unmasked "fluid source" test — exactly what `blocks.js:33-34` names as WRONG. Currently safe only because water (63) is not waterloggable. Separately, `fluidMode` does not stop at waterlogged cells even though they *are* water sources per §11.1 of the spec.

16. **`Particles.update()` takes no parameters** but `Game.js:266` calls `particles.update(alpha)`. All velocities/lives are **per-frame, not per-tick** → particle behavior is framerate-dependent. Also: `obtain(mesh)` (`:17`) and `this.pool` (`:12`) are **dead** despite the file header claiming pooling — `colored()` allocates a fresh material per particle (`:31`).

17. **`updateViewmodel`'s switch-anim decrement is alpha-dependent** — `if (vm.switchAnim > 0) vm.switchAnim -= alpha < 0.01 ? 1 : 0;` (`Game.js:410`). Render code decrementing only on frames landing within 0.5 ms of a tick boundary: at high FPS the 3-count drains erratically; at low FPS the `drop = 0.3` offset sticks.

18. **`collidesAny` disagrees with the real collision solver.** It clamps `y0` to `>= 0` (`collision.js:127`) and **ignores `blockAgainstUnloaded` entirely**, while `collideAxis` synthesizes a solid floor at `y < 0` (`:31`) and treats unloaded chunks as solid (`:33`). So `sneakEdgeClamp` and `isClearForHop` disagree with actual collision near y=0 and at chunk borders. Similarly `forEachOverlappedCell` clamps to `[0,127]` (`:86-94`) → **no fluid/climbable/fire is detected below y=0.**

19. **`ThemeMusic.stop(0.8)` silently ignores its argument** — `ui/menus.js:232` passes a number, but the signature destructures `{ fade = HANDOFF_FADE } = {}` (`themeMusic.js:~`); `Number(0.8).fade` is `undefined` → falls back to 1.0. No throw.

20. **Bucket geometry lies about its bucket.** `snow_layer` (`blocks.js:466`), `fence` (`:542`) and `bed` (`:570`) declare `bucket: 'opaque'` but route through `emitBox`, which emits into `builders.cutout` unconditionally (`ChunkMesher.js:455`) — their geometry lands in the cutout material (`alphaTest 0.5`, `DoubleSide`).

21. **`saveAll`'s `sync` option is dead** — destructured at `saveManager.js:107`, never referenced, no call site passes it. The `pagehide` handler (`main.js:185-187`) therefore issues an ordinary async IDB transaction during page teardown with no synchronous fallback.

22. **`clearFireOrigins()` is exported (`fire.js:31`) with zero call sites.** `disposeWorld` does not call it; `forgetFireInChunk` only runs on chunk unload (`Game.js:739`). **Origins from a disposed world survive into the next `startWorld` and count against `MAX_ACTIVE (512)`.**

23. **Heightmap-predicate agreement is load-bearing and unenforced.** `HM_SKIP` (`features.js:248-256`) and `terminatesSky` (`LightEngine.js:55-58`) agree today only by coincidence of the `CROSS` `opacity: 0` default, with `snow_layer`/`cactus` special-cased. **Adding a gen-emitted block with `opacity: 0` that isn't snow/cactus, without adding it to `HM_SKIP`, silently desyncs generated vs. reloaded chunks.**

24. **`Mob.serialize` writes a union of foreign fields** — `sheared, woolTint, eggTimer, swell, aggro` (`Mob.js:526`) are written for every mob type. `Creeper.swell` round-trips but `swellDir` and `fuseVoice` do not.

25. **Two different `disposeWorld` leaks**: `crackMesh` is added to `this.scene` (`Game.js:366`) and never removed; `updateCrack` allocates a throwaway `BoxGeometry` per stage change and never disposes it (`Game.js:373`). `Sky.dispose()` (`Sky.js:288`) removes objects from parents but **disposes no geometries, materials, or textures**.

26. **Dead code inventory** (relevant when grepping for extension points): `blockIndex` imported unused (`World.js:3`); `waterFaceVisible` defined and never called (`ChunkMesher.js:207`); `needsSupport` — 9 blocks set it, **zero readers** (`blocks.js:281`); `infiniteBurn` — never set true (`blocks.js:292`); `debugOnly`/`DEBUG_ONLY` — zero consumers (`items.js:35, :60`); `itemById` and `NAME_TO_ID` exported, never imported (`items.js:8, :187`); `noise.js`'s `clamp01`/`lerp`/`smoothstep`/`composeColumn` — no importers; `ctx.tempAt` (`noise.js:216`) and `ctx.cheeseAt` (`:257`) — zero external callers; `createGenerator`'s returned `heightAt`/`biomeAt` (`terrain.js:103-104`) — unused; `drone` primitive — zero events (`primitives.js:396`); `PRIMS` — no importers (`primitives.js:552`); `interaction.js:452` — `if (held.name === 'shears' && hit) { }`, empty block; `interaction.js:127` — `this.crackPos` never assigned anywhere → the OR branch is permanently dead; `interaction.js:32, :121` — `prevMouseRight` written every tick, never read; `Player.js:72` — `_moveDist` never written or read; `Player.js:374` — `(this.sprinting || (this.flying && this.sprinting))`, second disjunct subsumed; `Entity.js:21` — `let SCRATCH = new AABB()` unused; `Mob.js:45` — `stallTicks` initialized, never read again; `Sky.js:266` — `const yaw = Math.atan2(camera.position.x - (camX + 1), 0)` computed, unused, and constant; `Game.js:75` — `debug.remeshCount` never written or read, `debug.lastRemeshes` written every frame (`:260`) never read, `debug.audioMs` written (`:263`) but the overlay reads `g.audio.debug.budgetMs` directly (`debug.js:48`).

27. **Registry predicates depend on id contiguity** and will silently mis-classify if ids are inserted between them: `leafDecayTick`'s `id >= B.OAK_LEAVES && id <= B.SPRUCE_LEAVES` (11–13) and `id >= B.OAK_LOG && id <= B.SPRUCE_LOG` (8–10) at `blocks.js:98-99`; `farmlandTick`'s `above >= B.WHEAT_CROP && above <= B.POTATO_CROP` (56–58) at `:180`. `ui/containers.js:673` hard-codes 35/36/37 as literals rather than using `B`.

28. **`validCactus` (`blocks.js:143`)** does `BLOCKS[world.getBlock(...)].collidable` with **no `?.`** — it assumes `getBlock` always returns a valid id, unlike every other site in the file.

29. **Altitude-cooling constant diverges**: `0.008` on column height (`biomes.js:63`, `features.js:209`) vs `0.00125` on entity `y` (`DayNight.js:158`).

30. **`WORLD_BORDER`'s documented "generator refusal" does not exist** — `constants.js:13` comments it; the sole usage is a position clamp in `Entity.js:76-79`. Nothing in `gen/` or `ChunkManager` consults it; chunk requests past the border generate normally.

31. **`terrain.js:13-14`'s comment is wrong**: "saves store the int; both routes yield the same worldSeed". `saveManager.js:83` stores `seed: game.world.seedString` (a **string**), and `main.js:71` passes `meta.seed` straight back. The number branch at `terrain.js:16` is never exercised by the save path.

32. **`slowTicks` never resets on the warn branch** (`Game.js:229-232`) — once it crosses 2, every subsequent slow tick warns.

33. **`ChunkManager.dispose()` (`:43-46`) only terminates workers.** It does not clear `remeshQueue`, `pending`, `requestList`, `retries`, or `worldSpawn`. `retries` is never cleared on success (`:56-69`) and grows for the session.

34. **`countByState()`'s `failed` is the else branch** (`ChunkManager.js:339-348`) — it counts any state that isn't REQUESTED/GENERATED/LIT/MESHED, not only `FAILED`.

35. **`fluids.js:79` passes a dead option**: `world.popBlock(x, y, z, { silent: false })`, but `popBlock` destructures only `{ toolClass = null, toolTier = null } = {}` (`World.js:283`) — **`silent` is silently ignored.** Also, `cur` is assigned at `fluids.js:149, :189, :208` and never read.

36. **`Sheep.buildModel` defers visibility via `setTimeout(…, 0)`** (`passive.js:164`) because `this.parts` is assigned by `Mob.buildMesh` only **after** `buildModel()` returns (`Mob.js:445-446`).

37. **`Game.js:583-584` (explosion drops) calls `blk.drops` but never `blk.xpForMine`** — ore XP is mining-only. It passes `toolClass: blk.tool ?? 'pickaxe', toolTier: 3`, so explosion drops always pass `harvestOK`.

38. **`trySleep` sets `p.spawnPoint` unconditionally on click** (`Game.js:765`), before any of the night/monster checks. Hostile check box is asymmetric: `new AABB(x-8, y-5, z-8, x+9, y+6, z+9)` (`:771`).

39. **`Player.respawn` resets `yaw`/`pitch` but not `prevYaw`/`prevPitch`** (`Player.js:659-678`) → the first post-respawn frame interpolates from the old angle.

40. **`per-layer memo flush is a hard clear, not eviction`** (`noise.js:142, :157`) — at >200000 entries the entire memo is dropped. Correctness holds (values are pure); it is a latency cliff, paid independently by each of the 2 workers.