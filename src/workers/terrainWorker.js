// Terrain generation worker (01 §9 protocol, 02 §13 pipeline).
// main → worker: { type:'init', seed } once, then { type:'generate', cx, cz, jobId }.
// worker → main: { type:'ready', worldSpawn } then { type:'chunk', ... } with
// blocks/heightMap/biomes buffers TRANSFERRED (zero-copy).

import { createGenerator } from '../world/gen/terrain.js';

let gen = null;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    gen = createGenerator(msg.seed);
    self.postMessage({ type: 'ready', worldSpawn: gen.findWorldSpawn() });
  } else if (msg.type === 'generate') {
    try {
      const r = gen.generateChunk(msg.cx, msg.cz);
      self.postMessage(
        {
          type: 'chunk', cx: msg.cx, cz: msg.cz, jobId: msg.jobId,
          blocks: r.blocks, heightMap: r.heightMap, biomes: r.biomes,
          spawns: r.spawns,
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
