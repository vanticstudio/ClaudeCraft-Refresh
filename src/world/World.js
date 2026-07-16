// World facade: world-coords block/light API + block update fan-out (01 §4.6).
import { BLOCKS, B } from '../registry/blocks.js';
import { chunkKey, blockIndex, MAX_Y, SIM_RADIUS } from '../constants.js';
import { ChunkState } from './Chunk.js';
import { LightEngine } from './LightEngine.js';
import { ScheduledTicks } from './scheduledTicks.js';
import { Fluids } from './fluids.js';
import { mulberry32, xmur3, hashString, mix32 } from '../math/rng.js';

const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export class World {
  constructor(seedString) {
    this.seedString = seedString;
    this.worldSeed = hashString(seedString);
    this.chunks = new Map();            // "cx,cz" → Chunk
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

  getChunkAt(x, z) {
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    return c && c.state >= ChunkState.GENERATED ? c : null;
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
    if (old === id && oldState === state) return false;
    const oldBlock = BLOCKS[old];
    const newBlock = BLOCKS[id];

    chunk.blocks[i] = id;
    chunk.states[i] = state;
    chunk.modified = true;

    // block-entity contents spill (chest/furnace)
    if (oldBlock.blockEntity && oldBlock.blockEntity !== newBlock.blockEntity) {
      const be = chunk.blockEntities.get(i);
      if (be) {
        this.game?.spillBlockEntity(be, x, y, z);
        chunk.blockEntities.delete(i);
      }
    }

    // synchronous relight; returns every chunk key any write touched
    const dirtied = old !== id
      ? this.light.onBlockChanged(x, y, z, old, id)
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
      if (newBlock.gravity) this.checkFall(x, y, z);
      this.neighborUpdates(x, y, z);
    }
    return true;
  }

  setState(x, y, z, state) {
    if (y < 0 || y > MAX_Y) return false;
    const chunk = this.getChunkAt(x, z);
    if (!chunk) return false;
    const i = (y << 8) | ((z & 15) << 4) | (x & 15);
    if (chunk.states[i] === state) return false;
    chunk.states[i] = state;
    chunk.modified = true;
    if (this.chunkManager) {
      for (const k of this.collectDirtyKeys(chunk, x, z, null)) this.chunkManager.markDirty(k);
    }
    return true;
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
      if (nBlk.fluid) this.fluids.schedule(nx, ny, nz, nBlk.fluid);
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

  // Break with drops (loot ctx optional)
  popBlock(x, y, z, { toolClass = null, toolTier = null } = {}) {
    const id = this.getBlock(x, y, z);
    if (id === B.AIR) return false;
    const blk = BLOCKS[id];
    const state = this.getState(x, y, z);
    const drops = blk.drops
      ? blk.drops({ state, toolClass, toolTier, rng: this.rng })
      : [];
    this.setBlock(x, y, z, B.AIR);
    if (this.game) {
      for (const d of drops) this.game.spawnItemByName(d.name, d.count, x + 0.5, y + 0.5, z + 0.5);
    }
    return true;
  }

  removeBlock(x, y, z) {
    return this.setBlock(x, y, z, B.AIR);
  }

  // ---------------------------------------------------------------- ticking

  scheduleTick(x, y, z, delay) { this.scheduled.schedule(x, y, z, delay); }

  blockTick(x, y, z) {
    const id = this.getBlock(x, y, z);
    if (id === B.AIR) return;
    const blk = BLOCKS[id];
    if (blk.fluid) this.fluids.step(x, y, z);
    else blk.scheduledTick?.(this, x, y, z, this.getState(x, y, z));
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

  spawnItem(name, count, x, y, z) { this.game?.spawnItemByName(name, count, x, y, z); }

  isRainingAt(x, y, z) { return this.game?.dayNight?.isRainingAt(x, y, z) ?? false; }

  getEntitiesInBox(box, filter) {
    return this.game ? this.game.entities.getEntitiesInBox(box, filter) : [];
  }

  detailSeed() { return mix32(this.worldSeed ^ hashString('sys:detail')); }
}
