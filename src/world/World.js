// World facade: world-coords block/light API + block update fan-out (01 §4.6).
import { BLOCKS, B, WATERLOGGED, isWaterCellAt, isWaterSourceAt } from '../registry/blocks.js';
import { chunkKey, blockIndex, MAX_Y, SIM_RADIUS } from '../constants.js';
import { ChunkState } from './Chunk.js';
import { LightEngine } from './LightEngine.js';
import { ScheduledTicks } from './scheduledTicks.js';
import { Fluids } from './fluids.js';
import { fireTick, canSurvive, lavaFireAttempt, forgetFire, removeFire } from './fire.js';
import { mulberry32, xmur3, hashString, mix32 } from '../math/rng.js';

const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export class World {
  constructor(seedString) {
    this.seedString = seedString;
    this.worldSeed = hashString(seedString);
    this.chunks = new Map();            // "cx,cz" → Chunk
    this.chunkVersion = 0;              // bumped on add/remove (cache invalidation)
    this.time = 0;                      // worldTime (persisted; DayNight advances)
    this.skyDarken = 0;                 // int 0–11, DayNight recomputes per tick
    this.playerChunk = null;            // {cx, cz}, Game sets each tick
    this.game = null;                   // back-ref, set by Game
    this.chunkManager = null;           // set by Game
    this.light = new LightEngine(this);
    this.scheduled = new ScheduledTicks(this);
    this.fluids = new Fluids(this);
    const raw = mulberry32(xmur3('world:' + seedString)());
    this.rng = () => raw();
  }

  // ---------------------------------------------------------------- reads
  // chunkVersion bumps on chunk add/remove so 1-entry caches can invalidate.

  getChunkAt(x, z) {
    const cx = x >> 4, cz = z >> 4;
    if (this._cc && this._ccx === cx && this._ccz === cz && this._ccv === this.chunkVersion) {
      return this._cc;
    }
    const c = this.chunks.get(chunkKey(cx, cz));
    const valid = c && c.state >= ChunkState.GENERATED ? c : null;
    this._cc = valid;
    this._ccx = cx; this._ccz = cz; this._ccv = this.chunkVersion;
    return valid;
  }

  isLoaded(x, z) { return this.getChunkAt(x, z) !== null; }

  getBlock(x, y, z) {
    if (y < 0) return B.BEDROCK;
    if (y > MAX_Y) return B.AIR;
    const c = this.getChunkAt(x, z);
    if (!c) return B.AIR;
    return c.blocks[(y << 8) | ((z & 15) << 4) | (x & 15)];
  }

  getState(x, y, z) {
    if (y < 0 || y > MAX_Y) return 0;
    const c = this.getChunkAt(x, z);
    if (!c) return 0;
    return c.states[(y << 8) | ((z & 15) << 4) | (x & 15)];
  }

  getSkyLight(x, y, z) {
    if (y > MAX_Y) return 15;
    if (y < 0) return 0;
    const c = this.getChunkAt(x, z);
    if (!c) return 0;
    return c.skyLight[(y << 8) | ((z & 15) << 4) | (x & 15)];
  }

  getBlockLight(x, y, z) {
    if (y < 0 || y > MAX_Y) return 0;
    const c = this.getChunkAt(x, z);
    if (!c) return 0;
    return c.blockLight[(y << 8) | ((z & 15) << 4) | (x & 15)];
  }

  // internal light level (04 §4)
  internalLight(x, y, z) {
    return Math.max(this.getBlockLight(x, y, z), this.getSkyLight(x, y, z) - this.skyDarken);
  }

  // heightmap top (y+1 of topmost sky-terminating block); 0 when unloaded
  heightTop(x, z) {
    const c = this.getChunkAt(x, z);
    if (!c) return 0;
    return c.heightMap[((z & 15) << 4) | (x & 15)];
  }

  canSeeSky(x, y, z) { return y >= this.heightTop(Math.floor(x), Math.floor(z)); }

  biomeAt(x, z) {
    const c = this.getChunkAt(x, z);
    if (!c || !c.biomes) return 3;      // plains fallback
    return c.biomes[((z & 15) << 4) | (x & 15)];
  }

  // ---------------------------------------------------------------- writes

  // 01 §4.6 pipeline
  setBlock(x, y, z, id, { state = 0, byPlayer = false, noUpdates = false } = {}) {
    if (y < 0 || y > MAX_Y) return false;
    const chunk = this.getChunkAt(x, z);
    if (!chunk) return false;
    const i = (y << 8) | ((z & 15) << 4) | (x & 15);
    const old = chunk.blocks[i];
    const oldState = chunk.states[i];
    // 15 §8 ENGINE INVARIANT: bit 7 is meaningful only on waterloggable blocks.
    // Clear it for every other id, so a stale bit can never survive a block swap
    // and make (say) a stone cell read as a water source to the fluid system.
    if (!BLOCKS[id]?.waterloggable) state &= ~WATERLOGGED;
    if (old === id && oldState === state) return false;
    const oldBlock = BLOCKS[old];
    const newBlock = BLOCKS[id];
    // A bit-7 flip changes the cell's effective opacity (15 §13.5), so it must
    // relight exactly like an id change would (AMENDS 01 §4.6/§4.2).
    const waterlogFlip = (oldState & WATERLOGGED) !== (state & WATERLOGGED);

    chunk.blocks[i] = id;
    chunk.states[i] = state;
    chunk.modified = true;

    // 15 §6.4 — "any fire removal (any path) deletes its entry". Fire is removed
    // by at least five routes that never touch the fire engine: water/lava
    // flowing in (fire is canReplace), punching it out, an explosion, a block
    // placed into the cell, and the engine's own removeFire. Hooking the single
    // chokepoint every write funnels through is the only way the origin map
    // cannot leak — and a leaked map silently starves MAX_ACTIVE until no fire
    // may spread at all.
    if (old === B.FIRE && id !== B.FIRE) forgetFire(x, y, z);

    // block-entity contents spill (chest/furnace)
    if (oldBlock.blockEntity && oldBlock.blockEntity !== newBlock.blockEntity) {
      const be = chunk.blockEntities.get(i);
      if (be) {
        this.game?.spillBlockEntity(be, x, y, z);
        chunk.blockEntities.delete(i);
      }
    }

    // synchronous relight; returns every chunk key any write touched.
    // `waterlogFlip` is why this is not just `old !== id`: waterlogging a fence
    // leaves the id alone but changes how the column filters sky light.
    const dirtied = (old !== id || waterlogFlip)
      ? this.light.onBlockChanged(x, y, z, old, id, oldState, state)
      : null;

    // remesh dirtying: own chunk + border/diagonal neighbors + light-touched
    const keys = this.collectDirtyKeys(chunk, x, z, dirtied);
    if (this.chunkManager) {
      for (const k of keys) this.chunkManager.markDirty(k);
      if (byPlayer) this.chunkManager.rebuildNow(keys);
    }

    if (!noUpdates) {
      if (old !== id) {
        oldBlock.onBroken?.(this, x, y, z, oldState);
        newBlock.onPlaced?.(this, x, y, z, state);
      }
      // placed fluids start flowing; placed gravity blocks may fall
      if (newBlock.fluid) this.fluids.schedule(x, y, z, newBlock.fluid);
      // 15 §11.1: a waterlogged cell is a source and must tick like one, even
      // though its id (fence/ladder/chest) has no `fluid`.
      if (state & WATERLOGGED) this.fluids.schedule(x, y, z, 'water');
      if (newBlock.gravity) this.checkFall(x, y, z);
      this.neighborUpdates(x, y, z);
      // AMENDS 01 §4.6 step 8 (07 §5) — redstone: pulse observers watching this
      // cell, re-solve adjacent dust networks, second-order component fan-out.
      if (old !== id) this.game?.redstone?.onCellChanged(x, y, z, old, id);
    }
    return true;
  }

  /**
   * 07 §6.4 — apply a state-dependent light emission change (the redstone torch
   * shares one id for lit/unlit, so setBlock's id-based relight never fires).
   * Delegates to the light engine, then remeshes the touched chunks.
   */
  updateEmission(x, y, z, oldEmit, newEmit) {
    if (oldEmit === newEmit) return;
    const dirtied = this.light.setBlockEmission(x, y, z, oldEmit, newEmit);
    const chunk = this.getChunkAt(x, z);
    if (chunk && this.chunkManager) {
      for (const k of this.collectDirtyKeys(chunk, x, z, dirtied)) this.chunkManager.markDirty(k);
    }
  }

  /** Is a scheduled tick already pending for this cell in any bucket? */
  hasScheduled(x, y, z) {
    const k = x + ',' + y + ',' + z;
    for (const b of this.scheduled.buckets.values()) if (b.keys.has(k)) return true;
    return false;
  }

  /**
   * @param opts.noRemesh  skip remesh dirtying. Only for state writes that
   *   provably cannot change the mesh — 15 §2.3's fire age is the case that
   *   matters: the fire tile is ageless, and a burning floor bumps ~25 ages
   *   several times a second, which would otherwise remesh its chunks
   *   continuously for no visual change.
   */
  setState(x, y, z, state, opts) {
    if (y < 0 || y > MAX_Y) return false;
    const chunk = this.getChunkAt(x, z);
    if (!chunk) return false;
    const i = (y << 8) | ((z & 15) << 4) | (x & 15);
    if (chunk.states[i] === state) return false;
    // AMENDS 01 §4.6: a bit-7 toggle must run step 4 (light) and step 7
    // (neighbor updates / fluid wake) even when the id is unchanged. Route it
    // through setWaterlogged rather than silently writing a half-applied state:
    // a bare nibble write here (fire age, crop stage) legitimately skips both.
    if (((chunk.states[i] ^ state) & WATERLOGGED) !== 0) {
      const id = chunk.blocks[i];
      return this.setBlock(x, y, z, id, { state, byPlayer: true });
    }
    chunk.states[i] = state;
    chunk.modified = true;
    if (this.chunkManager && !opts?.noRemesh) {
      for (const k of this.collectDirtyKeys(chunk, x, z, null)) this.chunkManager.markDirty(k);
    }
    // 07 §6.6 — a state-byte change is an observer trigger (dust power, repeater
    // delay, door open, crop stage). The single chokepoint for non-id changes.
    this.game?.redstone?.onStateChanged(x, y, z);
    return true;
  }

  // ---------------------------------------------------------------- 15 §8 bit-7 API

  /** 15 §11.1 — the cell contains water (real water, or a waterlogged block). */
  isWaterCell(x, y, z) {
    return isWaterCellAt(this.getBlock(x, y, z), this.getState(x, y, z));
  }

  /** 15 §11.1 — the cell is a water SOURCE. */
  isWaterSource(x, y, z) {
    return isWaterSourceAt(this.getBlock(x, y, z), this.getState(x, y, z));
  }

  /**
   * 15 §10.4/§10.5 — toggle bit 7. Runs the full 01 §4.6 pipeline (light edit +
   * neighbor updates + fluid wake) because setBlock's `waterlogFlip` path fires
   * even though the id is unchanged.
   */
  setWaterlogged(x, y, z, on) {
    const id = this.getBlock(x, y, z);
    if (!BLOCKS[id]?.waterloggable) return false;
    const state = this.getState(x, y, z);
    const next = on ? (state | WATERLOGGED) : (state & ~WATERLOGGED);
    if (next === state) return false;
    return this.setBlock(x, y, z, id, { state: next, byPlayer: true });
  }

  collectDirtyKeys(chunk, x, z, extra) {
    const keys = new Set();
    keys.add(chunk.key);
    const lx = x & 15, lz = z & 15;
    if (lx === 0) keys.add(chunkKey(chunk.cx - 1, chunk.cz));
    if (lx === 15) keys.add(chunkKey(chunk.cx + 1, chunk.cz));
    if (lz === 0) keys.add(chunkKey(chunk.cx, chunk.cz - 1));
    if (lz === 15) keys.add(chunkKey(chunk.cx, chunk.cz + 1));
    if (lx === 0 && lz === 0) keys.add(chunkKey(chunk.cx - 1, chunk.cz - 1));
    if (lx === 0 && lz === 15) keys.add(chunkKey(chunk.cx - 1, chunk.cz + 1));
    if (lx === 15 && lz === 0) keys.add(chunkKey(chunk.cx + 1, chunk.cz - 1));
    if (lx === 15 && lz === 15) keys.add(chunkKey(chunk.cx + 1, chunk.cz + 1));
    if (extra) for (const k of extra) keys.add(k);
    return keys;
  }

  neighborUpdates(x, y, z) {
    for (const [dx, dy, dz] of DIRS6) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (ny < 0 || ny > MAX_Y) continue;
      const nId = this.getBlock(nx, ny, nz);
      if (nId === B.AIR) continue;
      const nBlk = BLOCKS[nId];
      nBlk.neighborUpdate?.(this, nx, ny, nz, this.getState(nx, ny, nz));
      // 15 §11.1 — waterlogged cells "receive scheduled fluid ticks like water
      // cells (scheduled on waterlog, on neighbor wake)". Fluids.wake handles
      // both; the bare `nBlk.fluid` test misses a bit-7 fence entirely, so it
      // could never re-spread once an adjacent block opened up.
      if (nBlk.fluid || (this.getState(nx, ny, nz) & WATERLOGGED)) this.fluids.wake(nx, ny, nz);
      if (nBlk.gravity) this.checkFall(nx, ny, nz);
    }
  }

  // sand/gravel support check (01 §6.4, 06 §5.1)
  checkFall(x, y, z) {
    if (y <= 0) return;
    const below = BLOCKS[this.getBlock(x, y - 1, z)];
    if (below.collidable) return;
    const id = this.getBlock(x, y, z);
    if (!BLOCKS[id].gravity) return;
    this.setBlock(x, y, z, B.AIR);
    this.game?.spawnFallingBlock(id, x, y, z);
  }

  /**
   * 15 §10.6 — what a removed cell becomes. A waterlogged block leaves its water
   * behind as a SOURCE (id 63, state 0), never air. Every erase path must use
   * this or the bit-7 contract is only half-honored: breakBlock could do it
   * right while a support-pop silently drank the lake.
   */
  clearedCell(x, y, z) {
    return (this.getState(x, y, z) & WATERLOGGED)
      ? { id: B.WATER, state: 0 }
      : { id: B.AIR, state: 0 };
  }

  // Break with drops (loot ctx optional)
  popBlock(x, y, z, { toolClass = null, toolTier = null } = {}) {
    const id = this.getBlock(x, y, z);
    if (id === B.AIR) return false;
    const blk = BLOCKS[id];
    const state = this.getState(x, y, z);
    const drops = blk.drops
      ? blk.drops({ state, toolClass, toolTier, rng: this.rng })
      : [];
    const cleared = this.clearedCell(x, y, z);
    this.setBlock(x, y, z, cleared.id, { state: cleared.state });
    if (this.game) {
      for (const d of drops) this.game.spawnItemByName(d.name, d.count, x + 0.5, y + 0.5, z + 0.5);
    }
    return true;
  }

  removeBlock(x, y, z) {
    const cleared = this.clearedCell(x, y, z);
    return this.setBlock(x, y, z, cleared.id, { state: cleared.state });
  }

  // ---------------------------------------------------------------- ticking

  scheduleTick(x, y, z, delay) { this.scheduled.schedule(x, y, z, delay); }

  blockTick(x, y, z) {
    const id = this.getBlock(x, y, z);
    if (id === B.AIR) return;
    const blk = BLOCKS[id];
    const state = this.getState(x, y, z);
    // 15 §11.1 — a waterlogged cell runs the fluid spread branch on its
    // scheduled ticks. Its id has no `.fluid`, so without this gate the tick
    // would go to the fence's own scheduledTick (null) and the water would
    // never spread. A waterloggable block has no scheduledTick of its own, so
    // nothing is shadowed.
    if (blk.fluid || (state & WATERLOGGED)) this.fluids.step(x, y, z);
    else blk.scheduledTick?.(this, x, y, z, state);
  }

  // 24 random cells per SIM_RADIUS chunk per tick (01 §6.2)
  randomTicks() {
    const p = this.playerChunk;
    if (!p) return;
    for (let dcx = -SIM_RADIUS; dcx <= SIM_RADIUS; dcx++) {
      for (let dcz = -SIM_RADIUS; dcz <= SIM_RADIUS; dcz++) {
        const c = this.chunks.get(chunkKey(p.cx + dcx, p.cz + dcz));
        if (!c || c.state < ChunkState.GENERATED) continue;
        for (let n = 0; n < 24; n++) {
          const i = (this.rng() * 32768) | 0;
          const id = c.blocks[i];
          if (id === B.AIR) continue;
          const blk = BLOCKS[id];
          if (!blk.randomTick) continue;
          const x = c.cx * 16 + (i & 15), y = i >> 8, z = c.cz * 16 + ((i >> 4) & 15);
          blk.randomTick(this, x, y, z, c.states[i]);
        }
      }
    }
  }

  // ---------------------------------------------------------------- hooks

  // Sapling growth → 02's tree placer (features.js is pure & main-thread safe).
  // Wired lazily by Game once the features module is loaded.
  growTree(species, x, y, z) {
    this.game?.growTree(species, x, y, z);
  }

  igniteTnt(x, y, z, fuse) { this.game?.igniteTnt(x, y, z, fuse); }

  // ---------------------------------------------------------------- 15 fire hooks
  // The registry's fire block calls these; they live here so blocks.js (a pure,
  // worker-safe module) never imports the engine.

  fireTick(x, y, z, state) { fireTick(this, x, y, z, state); }

  /**
   * 15 §1.3 — any neighbor change re-checks canSurvive; failure removes the fire
   * immediately (no drop, extinguish sound §15).
   */
  fireNeighborUpdate(x, y, z) {
    if (!canSurvive(this, x, y, z)) removeFire(this, x, y, z, true);
  }

  /** 15 §4.2 — lava's random-tick fire-creation attempt. */
  lavaFireAttempt(x, y, z) { lavaFireAttempt(this, x, y, z); }

  spawnItem(name, count, x, y, z) { this.game?.spawnItemByName(name, count, x, y, z); }

  isRainingAt(x, y, z) { return this.game?.dayNight?.isRainingAt(x, y, z) ?? false; }

  getEntitiesInBox(box, filter) {
    return this.game ? this.game.entities.getEntitiesInBox(box, filter) : [];
  }

  detailSeed() { return mix32(this.worldSeed ^ hashString('sys:detail')); }
}
