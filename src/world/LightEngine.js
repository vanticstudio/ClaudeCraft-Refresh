// Sky + block light: BFS flood / two-queue removal (01 §10 structures,
// 04 §8–9 algorithms). All positions are world coordinates; queues cross
// chunk borders freely. Light writes only into chunks ≥ GENERATED.
import { BLOCKS, B, WATERLOGGED } from '../registry/blocks.js';
import { MAX_Y, chunkKey, LIGHT_NODE_BUDGET } from '../constants.js';
import { ChunkState } from './Chunk.js';

const SKY = 0, BLOCK = 1;
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const DOWN = 3;   // index into DIRS
// 01 §17 "GC hitches" — module-scope constant, never an inline literal inside the
// 16×16 column loop below (that allocated 5 arrays per column, 1280 per chunk).
const H4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

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
    // 01 §10.3 safety valve — ONE shared budget per edit. `guard` used to be a
    // local of each loop, so a single onBlockChanged could legally drain
    // removeLight(100k) + 3× propagate(400k) + removeLight(100k) = 1.4M nodes,
    // 14× the spec's abort threshold.
    this.budgetOn = false;
    this.nodeBudget = 0;
    this.panicked = false;
    this._panic = [0, 0, 0];                        // cell that blew the budget
  }

  // 01 §10.3 — "abort, zero both light arrays of the 3×3 neighborhood, and
  // re-run initialLight on them spread over the next 9 ticks (one chunk per
  // tick)". Dropping the 3×3 back to GENERATED IS that re-run request:
  // ChunkManager.promote() already budgets 2 chunks/tick and gates on a
  // GENERATED 3×3. Bug-net, not a feature — logged when hit.
  lightPanic() {
    this.panicked = true;
    console.warn('[light] node budget exhausted at', this._panic.join(','), '— relighting 3x3');
    this.propQ[SKY].clear(); this.propQ[BLOCK].clear();
    this.unlightQ[SKY].clear(); this.unlightQ[BLOCK].clear();
    const cx = this._panic[0] >> 4, cz = this._panic[2] >> 4;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const c = this.world.chunks.get(chunkKey(cx + dx, cz + dz));
        if (!c || c.state < ChunkState.GENERATED || !c.skyLight) continue;
        c.skyLight.fill(0); c.blockLight.fill(0);
        c.state = ChunkState.GENERATED;
        this.dirtied.add(c.key);
      }
    }
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
    // 10-NETHER §13.2 — above the ceiling, sky light is 15 only in sky dimensions.
    if (y > MAX_Y) return channel === SKY ? (this.world.hasSkyLight ? 15 : 0) : 0;
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
    // 01 §4.5 — border cells dirty the face-adjacent chunk, and a CORNER cell
    // dirties the DIAGONAL too: the mesher's -X face at local (0,y,0) tangent-
    // samples bz-1, i.e. cell (15,y,15) of chunk (cx-1,cz-1), so that chunk's
    // border vertex is stale without this.
    const lx = x & 15, lz = z & 15;
    const ox = lx === 0 ? -1 : (lx === 15 ? 1 : 0);
    const oz = lz === 0 ? -1 : (lz === 15 ? 1 : 0);
    if (ox) this.dirtied.add(chunkKey(c.cx + ox, c.cz));
    if (oz) this.dirtied.add(chunkKey(c.cx, c.cz + oz));
    if (ox && oz) this.dirtied.add(chunkKey(c.cx + ox, c.cz + oz));
  }

  // ---- propagation (04 §9.2) ----

  propagate(channel) {
    if (this.panicked) return;                      // 01 §10.3 — edit abandoned
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
      // Budgeted (a block edit): one shared allowance per edit, §10.3's repair on
      // exhaustion. Unbudgeted (initialLight): the original per-call guard, which
      // must stay generous — a fresh cave chunk legitimately drains six figures.
      if (this.budgetOn) {
        if (--this.nodeBudget <= 0) { this._panic[0] = x; this._panic[1] = y; this._panic[2] = z; this.lightPanic(); break; }
      } else if (++guard > LIGHT_NODE_BUDGET * 4) {
        console.warn('[light] propagate guard hit'); q.clear(); break;
      }
    }
  }

  // ---- removal (04 §9.3, two-queue unlight) ----

  removeLight(channel, x, y, z) {
    if (this.panicked) return;                      // 01 §10.3 — edit abandoned
    const old = this.light(channel, x, y, z);
    this.setLight(channel, x, y, z, 0);
    const uq = this.unlightQ[channel];
    const pq = this.propQ[channel];
    uq.push(x, y, z, old);
    const n = this.node;
    // 04 §16 — stored light carries no provenance, so an EMITTER cell holding a
    // value below the removed source's is indistinguishable from descended light
    // and gets zeroed here (a lit furnace beside a broken torch went permanently
    // dark). Collect them and re-seed after the tear-down, so the `nL < L`
    // cascade itself is unaffected.
    const relight = [];
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
          if (this.setLight(channel, nx, ny, nz, 0)) {
            uq.push(nx, ny, nz, nL);
            if (channel === BLOCK) {
              const c = this.chunkAt(nx, nz);
              if (c) {
                const i = (ny << 8) | ((nz & 15) << 4) | (nx & 15);
                const b = BLOCKS[c.blocks[i]];
                // 07 §6.4 — a redstone torch's emission rides its state bit.
                const em = b.emissionFor ? b.emissionFor(c.states[i]) : b.emission;
                if (em > 0) relight.push(nx, ny, nz, em);
              }
            }
          }
        } else {
          pq.push(nx, ny, nz, nL);   // independent light: refill frontier
        }
      }
      if (this.budgetOn) {
        if (--this.nodeBudget <= 0) { this._panic[0] = qx; this._panic[1] = qy; this._panic[2] = qz; this.lightPanic(); break; }
      } else if (++guard > LIGHT_NODE_BUDGET) {
        console.warn('[light] remove guard hit'); uq.clear(); break;
      }
    }
    if (!this.panicked) {
      for (let k = 0; k < relight.length; k += 4) {
        if (this.setLight(BLOCK, relight[k], relight[k + 1], relight[k + 2], relight[k + 3])) {
          pq.push(relight[k], relight[k + 1], relight[k + 2], relight[k + 3]);
        }
      }
    }
    this.propagate(channel);
  }

  // ---- initial chunk lighting (04 §9.1) ----

  initialLight(chunk) {
    this.dirtied.clear();
    // Unbudgeted: §10.3's 100k valve is scoped to "a single onBlockChanged".
    // A fresh cave chunk legitimately drains six figures, and demoting its own
    // 3×3 back to GENERATED here would loop promote() forever.
    this.budgetOn = false; this.panicked = false;
    const { cx, cz } = chunk;
    const baseX = cx * 16, baseZ = cz * 16;
    const sky = chunk.skyLight, blocks = chunk.blocks, hm = chunk.heightMap;
    const pqSky = this.propQ[SKY], pqBlock = this.propQ[BLOCK];

    // 10-NETHER §13.2 — in a no-sky dimension, skyLight stays 0 everywhere; only
    // emitters + block-light border import run. The Nether's darkness is a pure
    // block-light problem (the shader's ambient floor keeps it navigable).
    if (this.world.hasSkyLight) {
      // 1. column seed: skyLight 15 from the top down to the heightmap top
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const H = hm[(z << 4) | x];
          for (let y = MAX_Y; y >= H; y--) sky[(y << 8) | (z << 4) | x] = 15;
        }
      }
      // 2. sky frontier: cells that can bleed sideways into somewhere darker AND
      //    the column's own lowest sky-15 cell.
      //    The own-cell seed is not optional (04 §16's "3 blocks of water reads 12
      //    beneath" acceptance case): step 1 only WRITES 15, it enqueues nothing,
      //    and propagate() expands popped nodes only. Water terminates the
      //    heightmap on both sides, so an open ocean column has hMax === H, the
      //    old `y < hMax` loop pushed nothing, and rule 2/3's DOWN step never
      //    fired — every generated or reloaded body of water read skyLight 0.
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const H = hm[(z << 4) | x];
          const wx = baseX + x, wz = baseZ + z;
          let hMax = H;
          for (const [dx, dz] of H4) {
            const nH = this.world.heightTop(wx + dx, wz + dz);
            if (nH > hMax) hMax = nH;
          }
          const yTop = hMax > H ? hMax : H + 1;
          for (let y = H; y < yTop; y++) pqSky.push(wx, y, wz, 15);
        }
      }
    }

    // 3. emitters
    for (let i = 0; i < 32768; i++) {
      const b = BLOCKS[blocks[i]];
      // 07 §6.4 — a redstone torch's emission depends on its lit bit (one id).
      const em = b.emissionFor ? b.emissionFor(chunk.states[i]) : b.emission;
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
    // 01 §10.3 — one 100k-node allowance for the WHOLE edit (both channels).
    this.budgetOn = true; this.nodeBudget = LIGHT_NODE_BUDGET; this.panicked = false;
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
    // 07 §6.4 — a redstone torch's emission is state-dependent (one id), so read
    // it through emissionFor when present.
    const oldEmit = oldB.emissionFor ? oldB.emissionFor(oldState) : oldB.emission;
    const newEmit = newB.emissionFor ? newB.emissionFor(newState) : newB.emission;
    if (oldEmit > 0 || (newO > 0 && this.light(BLOCK, x, y, z) > 0)) {
      this.removeLight(BLOCK, x, y, z);
    }
    if (newEmit > 0) {
      if (newEmit > this.light(BLOCK, x, y, z)) {
        this.setLight(BLOCK, x, y, z, newEmit);
        this.propQ[BLOCK].push(x, y, z, newEmit);
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

    this.budgetOn = false; this.panicked = false;
    return this.dirtied;
  }

  /**
   * 07 §6.4 — apply a state-driven emission change at a single cell (no id
   * change). Mirrors onBlockChanged's BLOCK channel: tear down the old emitter,
   * seed the new one, propagate. Returns the set of dirtied chunk keys.
   */
  setBlockEmission(x, y, z, oldEmit, newEmit) {
    this.dirtied.clear();
    // 01 §10.3 — same shared per-edit allowance as onBlockChanged.
    this.budgetOn = true; this.nodeBudget = LIGHT_NODE_BUDGET; this.panicked = false;
    if (oldEmit > 0 || (this.opacity(x, y, z) > 0 && this.light(BLOCK, x, y, z) > 0)) {
      this.removeLight(BLOCK, x, y, z);
    }
    if (newEmit > 0 && newEmit > this.light(BLOCK, x, y, z)) {
      this.setLight(BLOCK, x, y, z, newEmit);
      this.propQ[BLOCK].push(x, y, z, newEmit);
    }
    this.propagate(BLOCK);
    this.budgetOn = false; this.panicked = false;
    return this.dirtied;
  }
}

export { SKY, BLOCK };
