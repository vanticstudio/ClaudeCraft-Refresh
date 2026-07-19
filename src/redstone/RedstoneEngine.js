// 07-REDSTONE §5 — the simulation engine. Event-driven, no separate tick phase:
//
//   Instant layer  — dust network re-solve + strong/weak recomputation, run
//                    synchronously wherever an output changes.
//   Delayed layer  — every component reaction with a nonzero delay is a
//                    scheduled tick (01 §6.1); handlers re-verify at fire time.
//
// The instant layer is a fixpoint (a pure max-decay solve), so it cannot
// oscillate within a tick; any feedback loop must pass through a delayed
// component (torch/repeater/comparator/observer ≥ 2 gt), making same-tick
// infinite loops structurally impossible (§5.2).

import { BLOCKS, B } from '../registry/blocks.js';
import { FACE6_DIR, FACE6_OPP } from './dirs.js';
import { conductive, dustInjection, obsFace } from './power.js';
import { dustGraphNeighbors, dustOutputDirs } from './dust.js';

const MAX_NET_CELLS = 1024;             // per-network BFS cap (§5.2)
const MAX_NET_SOLVES_PER_TICK = 256;    // networks solved before carry-over (§5.2)
const MAX_CELLS_PER_TICK = 16384;       // dust cells touched before carry-over

const keyOf = (x, y, z) => x + ',' + y + ',' + z;

export class RedstoneEngine {
  constructor(world) {
    this.world = world;
    this.game = null;                   // set by Game after construction
    this.pending = new Map();           // key → [x,y,z]  (network seeds queued)
    this.carry = [];                    // seeds overflowed from a previous tick
    this._solving = false;              // re-entrancy guard for solvePending
    this._tickSolves = 0;               // §5.2 budget accumulates across the tick
    this._tickCells = 0;
    // 07 §5.5 / CLAUDE.md §6 — total solver time spent in the CURRENT tick, in
    // ms. Accumulated by solvePending (which runs from several entry points per
    // tick, not just drainAtTickStart) and published to the F3 overlay, where
    // the ≤ 1 ms/tick budget is finally observable.
    this.tickSolveMs = 0;
  }

  // ---- §5.2 overflow carry-over: processed before step 2 of the tick order ----
  drainAtTickStart() {
    this._tickSolves = 0;               // §5.2 caps are PER-TICK, reset here
    this._tickCells = 0;
    this.tickSolveMs = 0;
    if (this.carry.length) {
      for (const [x, y, z] of this.carry) this.queueNetwork(x, y, z);
      this.carry.length = 0;
    }
    this.solvePending();
  }

  /** Queue a wire cell as a network seed (deduped by cell). */
  queueNetwork(x, y, z) {
    if (this.world.getBlock(x, y, z) !== B.REDSTONE_WIRE) return;
    this.pending.set(keyOf(x, y, z), [x, y, z]);
  }

  /**
   * §5.2 onOutputChanged — any source output / block power / dust-support change
   * at (x,y,z). Re-solve adjacent dust, fan out to adjacent components (so a
   * lever→block→lamp chain reacts), then solve synchronously this tick.
   */
  onOutputChanged(x, y, z) {
    this.seedAround(x, y, z);
    this.fanOut(x, y, z);
    this.solvePending();
  }

  /**
   * §6.6 — a state byte changed at (x,y,z) (from World.setState: dust power,
   * repeater delay, door open, crop stage…). The single chokepoint for observer
   * detection of non-id changes. Cheap: 6 neighbour reads.
   */
  onStateChanged(x, y, z) {
    this.notifyObservers(x, y, z);
  }

  seedAround(x, y, z) {
    this.queueNetwork(x, y, z);
    for (const [dx, dy, dz] of FACE6_DIR) this.queueNetwork(x + dx, y + dy, z + dz);
    // slope diagonals: a wire one up/down and over is graph-adjacent
    for (const dy of [1, -1]) {
      for (const [dx, , dz] of FACE6_DIR) {
        if (dx === 0 && dz === 0) continue;
        this.queueNetwork(x + dx, y + dy, z + dz);
      }
    }
  }

  /**
   * 01 §4.6 step 8 — a block id changed at (x,y,z). (a) queue adjacent dust
   * networks, (b) pulse any observer watching this cell, (c) second-order
   * component fan-out. The base neighborUpdates already poked the direct 6.
   */
  onCellChanged(x, y, z, oldId, newId) {
    this.notifyObservers(x, y, z);
    this.seedAround(x, y, z);
    this.fanOut(x, y, z);
    this.solvePending();
  }

  /**
   * §5.3 fan-out — deliver a redstone re-poll to component blocks that may read
   * a change at (x,y,z): the 6 face neighbours, plus (second-order) the 6 face
   * neighbours of each conductive face-neighbour (a powered block "reaches
   * through" one block, replacing vanilla's update shape without QC).
   */
  fanOut(x, y, z) {
    for (const [dx, dy, dz] of FACE6_DIR) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      this.poke(nx, ny, nz);
      if (conductive(this.world, nx, ny, nz)) {
        for (const [ex, ey, ez] of FACE6_DIR) this.poke(nx + ex, ny + ey, nz + ez);
      }
    }
  }

  /**
   * Re-poll one cell reached by the fan-out. A wire cell is queued for network
   * re-solve (so a change to an adjacent conductive block's strong power
   * re-propagates the dust); any other block runs its neighborUpdate reaction.
   */
  poke(x, y, z) {
    if (y < 0 || y > 127) return;
    const id = this.world.getBlock(x, y, z);
    if (id === B.REDSTONE_WIRE) { this.queueNetwork(x, y, z); return; }
    BLOCKS[id]?.neighborUpdate?.(this.world, x, y, z, this.world.getState(x, y, z));
  }

  /**
   * §6.6 — pulse any observer whose watched cell is (x,y,z). The observer's
   * watched cell = observer + FACE6_DIR[watched]; so an observer at a face
   * neighbour N watches this cell iff N + watchedDir === (x,y,z).
   */
  notifyObservers(x, y, z) {
    for (const [dx, dy, dz] of FACE6_DIR) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (this.world.getBlock(nx, ny, nz) !== B.OBSERVER) continue;
      const wf = FACE6_DIR[obsFace(this.world.getState(nx, ny, nz))];
      if (nx + wf[0] === x && ny + wf[1] === y && nz + wf[2] === z) {
        this.game?.redstoneComponents?.observerTrigger(nx, ny, nz);
      }
    }
  }

  /** §8 — a container at (x,y,z) changed; re-evaluate comparators reading it. */
  containerChanged(x, y, z) {
    this.game?.redstoneComponents?.onContainerChanged(x, y, z);
  }

  // ---------------------------------------------------------------- solver

  solvePending() {
    if (this._solving) return;          // re-entrant calls just add to `pending`
    this._solving = true;
    const t0 = performance.now();
    try {
      while (this.pending.size) {
        // §5.2 caps are per-TICK (accumulated in _tickSolves/_tickCells), so a
        // tick with many entry points cannot together exceed the budget.
        if (this._tickSolves >= MAX_NET_SOLVES_PER_TICK || this._tickCells >= MAX_CELLS_PER_TICK) {
          for (const v of this.pending.values()) this.carry.push(v);
          this.pending.clear();
          break;
        }
        const it = this.pending.entries().next().value;
        const [k, seed] = it;
        this.pending.delete(k);
        // seed may have been consumed by an earlier network this pass
        if (this.world.getBlock(seed[0], seed[1], seed[2]) !== B.REDSTONE_WIRE) continue;
        this._tickCells += this.solveNetwork(seed[0], seed[1], seed[2]);
        this._tickSolves++;
      }
    } finally {
      this._solving = false;
      this.tickSolveMs += performance.now() - t0;
    }
  }

  /**
   * §5.2 solveNetwork — BFS the connects() graph from a seed, inject per §3.4-1,
   * run a multi-source max-decay BFS, write changed powers, notify targets.
   * Returns the cell count (for the per-tick budget).
   */
  solveNetwork(sx, sy, sz) {
    const world = this.world;
    // 1. gather the network
    const cells = [];
    const index = new Map();            // key → position in `cells`
    const stack = [[sx, sy, sz]];
    index.set(keyOf(sx, sy, sz), 0);
    cells.push([sx, sy, sz]);
    while (stack.length) {
      const [x, y, z] = stack.pop();
      for (const [nx, ny, nz] of dustGraphNeighbors(world, x, y, z)) {
        const k = keyOf(nx, ny, nz);
        if (index.has(k)) continue;
        if (world.getBlock(nx, ny, nz) !== B.REDSTONE_WIRE) continue;
        if (cells.length >= MAX_NET_CELLS) { console.warn('[redstone] network > 1024 cells; truncated'); break; }
        index.set(k, cells.length);
        cells.push([nx, ny, nz]);
        stack.push([nx, ny, nz]);
      }
    }

    // 2. injection per cell + 3. max-decay BFS (bucket 15..1)
    const n = cells.length;
    const level = new Int8Array(n);
    const buckets = Array.from({ length: 16 }, () => []);
    for (let i = 0; i < n; i++) {
      const inj = Math.min(15, dustInjection(world, cells[i][0], cells[i][1], cells[i][2]));
      level[i] = inj;
      if (inj > 0) buckets[inj].push(i);
    }
    for (let lv = 15; lv >= 1; lv--) {
      const q = buckets[lv];
      for (let qi = 0; qi < q.length; qi++) {
        const i = q[qi];
        if (level[i] !== lv) continue;                 // superseded by a stronger push
        const [x, y, z] = cells[i];
        for (const [nx, ny, nz] of dustGraphNeighbors(world, x, y, z)) {
          const j = index.get(keyOf(nx, ny, nz));
          if (j === undefined) continue;
          if (lv - 1 > level[j]) { level[j] = lv - 1; buckets[lv - 1].push(j); }
        }
      }
    }

    // 4. write changed powers, collect changed cells
    const changed = [];
    for (let i = 0; i < n; i++) {
      const [x, y, z] = cells[i];
      const st = world.getState(x, y, z);
      const cur = st & 0x0f;
      if (cur !== level[i]) {
        world.setState(x, y, z, (st & 0xf0) | level[i]);   // remesh via budgeted queue
        changed.push(i);
      }
    }

    // 5. notify targets of every changed dust cell (block below, pointed cells,
    // adjacent components). Observers are handled by World.setState → onStateChanged
    // above. May queue further networks → same pass.
    for (const i of changed) {
      const [x, y, z] = cells[i];
      this.fanOut(x, y, z);
      // the block directly below is a weak target of the dust
      this.poke(x, y - 1, z);
      // cells the dust points into
      for (const [dx, , dz] of dustOutputDirs(world, x, y, z)) this.poke(x + dx, y, z + dz);
    }
    return n;
  }
}
