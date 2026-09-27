// OVERHAUL §W — chunk meshing worker. The mesher's per-vertex AO + smooth
// light + greedy pass is the heaviest CPU work in the engine; running it here
// takes the 6ms/frame main-thread ceiling and the LOADING-screen mesh burst
// fully off the render thread. Protocol:
//   main → { type:'init', tileUV }                          once, on spawn
//   main → { type:'mesh', id, cx, cz, epoch, snap }         snapshot = 9 ×
//          { blocks, states, skyLight, blockLight, biomes } typed arrays,
//          all TRANSFERRED (zero-copy); the worker owns them.
//   worker → { type:'meshReady' }                           after init
//   worker → { type:'meshed', id, cx, cz, epoch, raw }      raw = per-bucket
//          { pos, nrm, uv, span, tileUV, col, tint, idx } + minY/maxY, all
//          transferred back; main thread wraps them into BufferAttributes.
//   worker → { type:'meshError', id, message }
// The mesher is pure over the snapshot — no world, no three.js — so results
// are deterministic and identical to the main-thread path.
import { ChunkMesher } from '../mesh/ChunkMesher.js';
import { TILE_NAMES } from '../assets/atlas.js';
import { finalizeBlockTiles } from '../registry/blocks.js';

let mesher = null;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      // This module copy of blocks.js never ran main.js's boot(), so
      // finalizeBlockTiles(atlas.TILE) never resolved tile names → indices
      // here. Without this, tileFor() throws on the FIRST visible cube face
      // and every chunk fails into the quiet give-up (0/49 loading stall,
      // empty world). TILE is pure name→index order (TILE_NAMES), no canvas.
      finalizeBlockTiles(Object.fromEntries(TILE_NAMES.map((n, i) => [n, i])));
      mesher = new ChunkMesher(msg.tileUV);
      self.postMessage({ type: 'meshReady' });
    } catch (err) {
      self.postMessage({ type: 'meshError', id: -1, message: String(err?.message ?? err) });
    }
    return;
  }
  if (msg.type !== 'mesh') return;
  // a mesh job that arrives before init would be silently dropped — surface it
  // so the main thread re-queues instead of leaking a permanent in-flight slot.
  if (!mesher) {
    self.postMessage({ type: 'meshError', id: msg.id, message: 'worker not initialized' });
    return;
  }
  try {
    const raw = mesher.buildFromSnapshot(msg.snap);
    const transfer = [];
    for (const bucket of ['opaque', 'cutout', 'water']) {
      const r = raw[bucket];
      if (r) for (const k of ['pos', 'nrm', 'uv', 'span', 'tileUV', 'col', 'tint', 'idx']) {
        transfer.push(r[k].buffer);
      }
    }
    self.postMessage({
      type: 'meshed', id: msg.id, cx: msg.cx, cz: msg.cz, epoch: msg.epoch, raw,
    }, transfer);
  } catch (err) {
    self.postMessage({ type: 'meshError', id: msg.id, message: String(err?.stack ?? err) });
  }
};
