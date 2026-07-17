// Sky + block light: BFS flood / two-queue removal (01 §10 structures,
// 04 §8–9 algorithms). All positions are world coordinates; queues cross
// chunk borders freely. Light writes only into chunks ≥ GENERATED.
import { BLOCKS, B, WATERLOGGED } from '../registry/blocks.js';
import { MAX_Y, chunkKey, LIGHT_NODE_BUDGET } from '../constants.js';
import { ChunkState } from './Chunk.js';

const SKY = 0, BLOCK = 1;
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const DOWN = 3;   // index into DIRS

// Flat int32 ring queue, 4 lanes per node (x, y, z, level)
class Queue4 {
  constructor(cap = 1 << 14) {
    this.a = new Int32Array(cap * 4);
    this.head = 0;
    this.tail = 0;
  }
  get length() { return (this.tail - this.head) / 4; }
  push(x, y, z, l) {
    if (this.tail + 4 > this.a.length) {
      if (this.head >= this.a.length >> 1) {   // compact
        this.a.copyWithin(0, this.head, this.tail);
        this.tail -= this.head; this.head = 0;
      } else {                                  // grow
        const n = new Int32Array(this.a.length * 2);
        n.set(this.a.subarray(this.head, this.tail));
        this.tail -= this.head; this.head = 0;
        this.a = n;
      }
    }
    const t = this.tail;
    this.a[t] = x; this.a[t + 1] = y; this.a[t + 2] = z; this.a[t + 3] = l;
    this.tail = t + 4;
  }
  pop(out) {
    const h = this.head;
    out[0] = this.a[h]; out[1] = this.a[h + 1]; out[2] = this.a[h + 2]; out[3] = this.a[h + 3];
    this.head = h + 4;
    if (this.head === this.tail) { this.head = 0; this.tail = 0; }
  }
  clear() { this.head = 0; this.tail = 0; }
}

// Sky-terminating opacity for the heightmap: light opacity > 0, plus the two
// zero-opacity blocks the generator counts (snow layer, cactus) so gen and
// runtime heightmaps agree.
// AMENDS 01 §4.2/§4.6 + 15 §13.5: a waterlogged cell filters sky like water, so
// the heightmap must terminate on it (rain streaks stop there, isRainingAt below
// reads false). The spec names a `BLOCKS[id].skyOpacity` field — no such field
// exists in this codebase; `terminatesSky` IS the heightmap predicate, so the
// amendment lands here as a second arg. `state` is optional: worldgen never
// emits bit 7, so features.js's gen-side heightmap stays id-only and the two
// still agree.
export function terminatesSky(id, state = 0) {
  if ((state & WATERLOGGED) !== 0) return true;
  return BLOCKS[id].opacity > 0 || id === B.SNOW_LAYER || id === B.CACTUS;
}

export class LightEngine {
  constructor(world) {
    this.world = world;
    this.propQ = [new Queue4(), new Queue4()];      // [SKY, BLOCK]
    this.unlightQ = [new Queue4(), new Queue4()];
    this.dirtied = new Set();                       // chunk keys touched
    this.node = new Int32Array(4);                  // pop scratch
  }

  // ---- raw cell access (drops writes into missing / ungenerated chunks) ----
  // BFS locality is high, so a 1-entry chunk cache removes almost every
  // string-keyed Map lookup (the initialLight hot path).

  chunkAt(x, z) {
    const cx = x >> 4, cz = z >> 4;
    const w = this.world;
    if (this._cc && this._ccx === cx && this._ccz === cz && this._ccv === w.chunkVersion) {
      return this._cc;
    }
    const c = w.chunks.get(chunkKey(cx, cz));
    const valid = c && c.state >= ChunkState.GENERATED ? c : null;
    this._cc = valid;
    this._ccx = cx; this._ccz = cz; this._ccv = w.chunkVersion;
    return valid;
  }

  getLightArr(channel, c) { return channel === SKY ? c.skyLight : c.blockLight; }

  light(channel, x, y, z) {
    if (y > MAX_Y) return channel === SKY ? 15 : 0;
    if (y < 0) return 0;
    const c = this.chunkAt(x, z);
    if (!c) return 0;
    return this.getLightArr(channel, c)[(y << 8) | ((z & 15) << 4) | (x & 15)];
  }

  setLight(channel, x, y, z, v) {
    if (y < 0 || y > MAX_Y) return false;
    const c = this.chunkAt(x, z);
    if (!c) return false;
    this.getLightArr(channel, c)[(y << 8) | ((z & 15) << 4) | (x & 15)] = v;
    this.markDirty(c, x, z);
    return true;
  }

  // AMENDS 04 §8 + 15 §13.5: effective opacity = max(opacity(id), bit7 ? 1 : 0).
  // A waterlogged cell filters exactly like water. Rule 3 (the straight-down
  // sky-15 shortcut at `o === 0`) then fails for it automatically — no separate
  // edit — which is precisely how plain water (opacity 1) already behaves.
  opacity(x, y, z) {
    if (y < 0) return 15;
    if (y > MAX_Y) return 0;
    const c = this.chunkAt(x, z);
    if (!c) return 15;                              // unloaded: wall for BFS
    const i = (y << 8) | ((z & 15) << 4) | (x & 15);
    const o = BLOCKS[c.blocks[i]].opacity;
    return (c.states[i] & WATERLOGGED) ? Math.max(o, 1) : o;
  }

  markDirty(c, x, z) {
    this.dirtied.add(c.key);
    // border cells also dirty the adjacent chunk (mesh AO/light sampling)
    const lx = x & 15, lz = z & 15;
    if (lx === 0) this.dirtied.add(chunkKey(c.cx - 1, c.cz));
    else if (lx === 15) this.dirtied.add(chunkKey(c.cx + 1, c.cz));
    if (lz === 0) this.dirtied.add(chunkKey(c.cx, c.cz - 1));
    else if (lz === 15) this.dirtied.add(chunkKey(c.cx, c.cz + 1));
  }

  // ---- propagation (04 §9.2) ----

  propagate(channel) {
    const q = this.propQ[channel];
    const n = this.node;
    let guard = 0;
    while (q.length > 0) {
      q.pop(n);
      const x = n[0], y = n[1], z = n[2];
      const L = this.light(channel, x, y, z);
      if (L <= 1 && channel === BLOCK) continue;
      if (L <= 0) continue;
      for (let d = 0; d < 6; d++) {
        const dir = DIRS[d];
        const nx = x + dir[0], ny = y + dir[1], nz = z + dir[2];
        if (ny < 0 || ny > MAX_Y) continue;
        const o = this.opacity(nx, ny, nz);
        if (o >= 15) continue;
        let newL;
        if (channel === SKY && d === DOWN && L === 15 && o === 0) newL = 15;
        else newL = L - Math.max(1, o);
        if (newL > this.light(channel, nx, ny, nz)) {
          if (this.setLight(channel, nx, ny, nz, newL)) q.push(nx, ny, nz, newL);
        }
      }
      if (++guard > LIGHT_NODE_BUDGET * 4) { console.warn('[light] propagate guard hit'); q.clear(); break; }
    }
  }

  // ---- removal (04 §9.3, two-queue unlight) ----

  removeLight(channel, x, y, z) {
    const old = this.light(channel, x, y, z);
    this.setLight(channel, x, y, z, 0);
    const uq = this.unlightQ[channel];
    const pq = this.propQ[channel];
    uq.push(x, y, z, old);
    const n = this.node;
    let guard = 0;
    while (uq.length > 0) {
      uq.pop(n);
      const qx = n[0], qy = n[1], qz = n[2], L = n[3];
      for (let d = 0; d < 6; d++) {
        const dir = DIRS[d];
        const nx = qx + dir[0], ny = qy + dir[1], nz = qz + dir[2];
        if (ny < 0 || ny > MAX_Y) continue;
        const nL = this.light(channel, nx, ny, nz);
        if (nL === 0) continue;
        const descended = nL < L ||
          (channel === SKY && d === DOWN && L === 15 && nL === 15);
        if (descended) {
          if (this.setLight(channel, nx, ny, nz, 0)) uq.push(nx, ny, nz, nL);
        } else {
          pq.push(nx, ny, nz, nL);   // independent light: refill frontier
        }
      }
      if (++guard > LIGHT_NODE_BUDGET) { console.warn('[light] remove guard hit'); uq.clear(); break; }
    }
    this.propagate(channel);
  }

  // ---- initial chunk lighting (04 §9.1) ----

  initialLight(chunk) {
    this.dirtied.clear();
    const { cx, cz } = chunk;
    const baseX = cx * 16, baseZ = cz * 16;
    const sky = chunk.skyLight, blocks = chunk.blocks, hm = chunk.heightMap;
    const pqSky = this.propQ[SKY], pqBlock = this.propQ[BLOCK];

    // 1. column seed: skyLight 15 from the top down to the heightmap top
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const H = hm[(z << 4) | x];
        for (let y = MAX_Y; y >= H; y--) sky[(y << 8) | (z << 4) | x] = 15;
      }
    }

    // 2. sky frontier: cells that can bleed sideways into somewhere darker
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const H = hm[(z << 4) | x];
        const wx = baseX + x, wz = baseZ + z;
        let hMax = H;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nH = this.world.heightTop(wx + dx, wz + dz);
          if (nH > hMax) hMax = nH;
        }
        for (let y = H; y < hMax; y++) pqSky.push(wx, y, wz, 15);
      }
    }

    // 3. emitters
    for (let i = 0; i < 32768; i++) {
      const em = BLOCKS[blocks[i]].emission;
      if (em > 0) {
        chunk.blockLight[i] = em;
        pqBlock.push(baseX + (i & 15), i >> 8, baseZ + ((i >> 4) & 15), em);
      }
    }

    // 4. border import from already-LIT neighbors
    const importCol = (nx, nz) => {
      const nc = this.world.chunks.get(chunkKey(nx >> 4, nz >> 4));
      if (!nc || nc.state < ChunkState.LIT) return;
      const li = ((nz & 15) << 4) | (nx & 15);
      for (let y = 0; y <= MAX_Y; y++) {
        const idx = (y << 8) | li;
        if (nc.skyLight[idx] >= 2) pqSky.push(nx, y, nz, nc.skyLight[idx]);
        if (nc.blockLight[idx] >= 2) pqBlock.push(nx, y, nz, nc.blockLight[idx]);
      }
    };
    for (let i = 0; i < 16; i++) {
      importCol(baseX - 1, baseZ + i);
      importCol(baseX + 16, baseZ + i);
      importCol(baseX + i, baseZ - 1);
      importCol(baseX + i, baseZ + 16);
    }

    // 5. drain
    this.propagate(SKY);
    this.propagate(BLOCK);

    chunk.state = ChunkState.LIT;
    return this.dirtied;
  }

  // ---- block edits (04 §9.4 wrapped per 01 §10.2) ----

  /**
   * @param oldState/newState  AMENDS 01 §4.6 — REQUIRED for bit 7. This method
   *   used to derive everything from BLOCKS[oldId]/BLOCKS[newId], so a
   *   waterlog toggle (same id, state 0 -> 0x80) compared oldB === newB, every
   *   opacity test read false, and it silently did no light work at all.
   *   Effective opacity now folds bit 7 in, exactly as opacity() does.
   */
  onBlockChanged(x, y, z, oldId, newId, oldState = 0, newState = 0) {
    this.dirtied.clear();
    const oldB = BLOCKS[oldId], newB = BLOCKS[newId];
    // effective opacity (15 §13.5) — what the BFS will actually see
    const oldO = (oldState & WATERLOGGED) ? Math.max(oldB.opacity, 1) : oldB.opacity;
    const newO = (newState & WATERLOGGED) ? Math.max(newB.opacity, 1) : newB.opacity;
    const chunk = this.chunkAt(x, z);
    if (!chunk) return this.dirtied;
    const col = ((z & 15) << 4) | (x & 15);
    const oldH = chunk.heightMap[col];

    // heightmap maintenance (01 §4.6 step 3)
    let newH = oldH;
    if (terminatesSky(newId, newState)) {
      if (y + 1 > oldH) newH = y + 1;
    } else if (y + 1 === oldH) {
      newH = 0;
      for (let yy = y; yy >= 0; yy--) {
        const ii = (yy << 8) | col;
        if (terminatesSky(chunk.blocks[ii], chunk.states[ii])) { newH = yy + 1; break; }
      }
    }
    chunk.heightMap[col] = newH;

    // --- BLOCK channel ---
    if (oldB.emission > 0 || (newO > 0 && this.light(BLOCK, x, y, z) > 0)) {
      this.removeLight(BLOCK, x, y, z);
    }
    if (newB.emission > 0) {
      if (newB.emission > this.light(BLOCK, x, y, z)) {
        this.setLight(BLOCK, x, y, z, newB.emission);
        this.propQ[BLOCK].push(x, y, z, newB.emission);
      }
    }
    if (newO < oldO) {
      for (const [dx, dy, dz] of DIRS) {
        const l = this.light(BLOCK, x + dx, y + dy, z + dz);
        if (l > 1) this.propQ[BLOCK].push(x + dx, y + dy, z + dz, l);
      }
    }
    this.propagate(BLOCK);

    // --- SKY channel ---
    if (newO > oldO) {
      this.removeLight(SKY, x, y, z);              // downward rule tears the shaft
    } else if (newO < oldO) {
      if (newH < oldH && y + 1 === oldH) {
        // column opened to the sky: direct 15 down to the new top
        for (let yy = newH; yy <= oldH - 1; yy++) {
          this.setLight(SKY, x, yy, z, 15);
          this.propQ[SKY].push(x, yy, z, 15);
        }
      } else {
        for (const [dx, dy, dz] of DIRS) {
          const l = this.light(SKY, x + dx, y + dy, z + dz);
          if (l > 0) this.propQ[SKY].push(x + dx, y + dy, z + dz, l);
        }
      }
      this.propagate(SKY);
    }

    return this.dirtied;
  }

  getLight(x, y, z) {
    return { sky: this.light(SKY, x, y, z), block: this.light(BLOCK, x, y, z) };
  }
}

export { SKY, BLOCK };
