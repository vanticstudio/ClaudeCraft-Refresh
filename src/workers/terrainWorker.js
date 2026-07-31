// Terrain generation worker (01 §9 protocol, 02 §13 pipeline).
// main → worker: { type:'init', seed } once, then { type:'generate', cx, cz, jobId }.
// worker → main: { type:'ready', worldSpawn } then { type:'chunk', ... } with
// blocks/heightMap/biomes buffers TRANSFERRED (zero-copy).

import { createGenerator } from '../world/gen/terrain.js';
import { createNetherGenerator } from '../world/gen/nether.js';
import { createEndGenerator } from '../world/gen/end.js';

let gen = null;          // overworld (dim 0)
let netherGen = null;    // 10-NETHER dim 1
let endGen = null;       // 11-END dim 2

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    // 01 §9 — this was the only code outside a try/catch: a throw in any of the
    // three generator ctors or findWorldSpawn was completely unobservable and
    // the main thread simply never saw `ready`. ChunkManager owns the 'fatal'
    // branch and turns it into a return to TITLE.
    try {
      gen = createGenerator(msg.seed);
      netherGen = createNetherGenerator(msg.seed);   // §2.2 — disjoint stream namespace
      endGen = createEndGenerator(msg.seed);         // 11-END §6 — 'end:' streams
      self.postMessage({ type: 'ready', worldSpawn: gen.findWorldSpawn() });
    } catch (err) {
      self.postMessage({ type: 'fatal', message: String((err && err.stack) || err) });
    }
  } else if (msg.type === 'generate') {
    try {
      // §2.2 — dispatch gen by dimension.
      const g = msg.dim === 2 ? endGen : msg.dim === 1 ? netherGen : gen;
      const r = g.generateChunk(msg.cx, msg.cz);
      // 11-END step 6.5 — the overworld gen returns `states` (stronghold frame
      // nibbles); nether/end don't, so guard + transfer only when present.
      const transfer = [r.blocks.buffer, r.heightMap.buffer, r.biomes.buffer];
      if (r.states) transfer.push(r.states.buffer);
      self.postMessage(
        {
          type: 'chunk', cx: msg.cx, cz: msg.cz, jobId: msg.jobId,
          blocks: r.blocks, heightMap: r.heightMap, biomes: r.biomes,
          states: r.states ?? null,
          spawns: r.spawns,
          villageMeta: r.villageMeta ?? null,   // 12-VILLAGES §2.7 (structured-clone, not transferred)
        },
        transfer,
      );
    } catch (err) {
      self.postMessage({
        type: 'error', jobId: msg.jobId, cx: msg.cx, cz: msg.cz,
        message: String((err && err.stack) || err),
      });
    }
  }
};
