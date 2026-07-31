// Bucket queue for fluid/block scheduled updates (01 §6.1).
import { BLOCKS } from '../registry/blocks.js';
import { SIM_RADIUS, chunkKey } from '../constants.js';

export class ScheduledTicks {
  constructor(world) {
    this.world = world;
    this.buckets = new Map();   // dueTick → { keys: Set<string>, arr: number[] }
  }

  schedule(x, y, z, delayTicks) {
    const due = this.world.time + Math.max(1, delayTicks | 0);
    let b = this.buckets.get(due);
    if (!b) { b = { keys: new Set(), arr: [] }; this.buckets.set(due, b); }
    const key = x + ',' + y + ',' + z;
    if (b.keys.has(key)) return;
    b.keys.add(key);
    b.arr.push(x, y, z);
  }

  run() {
    const world = this.world;
    const b = this.buckets.get(world.time);
    if (!b) return;
    this.buckets.delete(world.time);
    const p = world.playerChunk;   // {cx, cz} set by Game each tick
    for (let i = 0; i < b.arr.length; i += 3) {
      const x = b.arr[i], y = b.arr[i + 1], z = b.arr[i + 2];
      // 01 §6.1 — a tick whose chunk unloaded has no block to run. UNLOAD_RADIUS
      // is always > SIM_RADIUS, so the deferral below would re-queue it every
      // 40 t forever (allocating a fresh key each hop and slowing hasScheduled).
      // Dropping is safe: fire re-seeds on hydrate, fluids on wake.
      // `chunks.has` rather than getChunkAt — a resident REQUESTED chunk is
      // mid-rehydrate and its ticks are still worth deferring.
      if (!world.chunks.has(chunkKey(x >> 4, z >> 4))) continue;
      if (p) {
        const dcx = Math.abs((x >> 4) - p.cx), dcz = Math.abs((z >> 4) - p.cz);
        if (Math.max(dcx, dcz) > SIM_RADIUS) {   // outside sim: defer, don't run
          this.schedule(x, y, z, 40);
          continue;
        }
      }
      world.blockTick(x, y, z);
    }
  }

  // Restore-on-load helper: nothing persisted (fluids re-woken by edits);
  // kept for interface completeness.
  clear() { this.buckets.clear(); }
}
