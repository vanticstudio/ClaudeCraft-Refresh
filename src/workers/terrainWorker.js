// Terrain generation worker (01 §9 protocol, 02 §13 pipeline).
// main → worker: { type:'init', seed } once, then { type:'generate', cx, cz, jobId }.
// worker → main: { type:'ready', worldSpawn } then { type:'chunk', ... } with
// blocks/heightMap/biomes buffers TRANSFERRED (zero-copy).

import { createGenerator } from '../world/gen/terrain.js';
import { createNetherGenerator } from '../world/gen/nether.js';

let gen = null;          // overworld (dim 0)
let netherGen = null;    // 10-NETHER dim 1

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    gen = createGenerator(msg.seed);
    netherGen = createNetherGenerator(msg.seed);   // §2.2 — disjoint stream namespace
    self.postMessage({ type: 'ready', worldSpawn: gen.findWorldSpawn() });
  } else if (msg.type === 'generate') {
    try {
      // §2.2 — dispatch gen by dimension. (dim 2 / End is 11's.)
      const g = msg.dim === 1 ? netherGen : gen;
      const r = g.generateChunk(msg.cx, msg.cz);
      self.postMessage(
        {
          type: 'chunk', cx: msg.cx, cz: msg.cz, jobId: msg.jobId,
          blocks: r.blocks, heightMap: r.heightMap, biomes: r.biomes,
          spawns: r.spawns,
          villageMeta: r.villageMeta ?? null,   // 12-VILLAGES §2.7 (structured-clone, not transferred)
        },
        [r.blocks.buffer, r.heightMap.buffer, r.biomes.buffer],
      );
    } catch (err) {
      self.postMessage({
        type: 'error', jobId: msg.jobId, cx: msg.cx, cz: msg.cz,
        message: String((err && err.stack) || err),
      });
    }
  }
};
