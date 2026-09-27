// B1 — chunk lighting worker. initialLight's unbudgeted BFS was the last
// main-thread streaming hitch; this pool runs the SAME algorithm (LightBFS via
// computeChunkLight — no second implementation) over 3×3 plain-data snapshots.
// Protocol (mirrors meshWorker.js):
//   main → { type:'init' }                        once, on spawn
//   main → { type:'light', id, cx, cz, epoch,
//            hood }                               hood = 9 × { cx, cz, key,
//          state, blocks, states, heightMap, skyLight, blockLight }, all
//          TRANSFERRED (zero-copy); slots carry light arrays for every
//          GENERATED+ chunk (zeroed when not yet LIT — the BFS traverses
//          them exactly like the main-thread path does).
//   worker → { type:'lightReady' }                after init
//   worker → { type:'lit', id, cx, cz, epoch, skyLight, blockLight, deltas,
//              dirtied }                          deltas = flat [channel, x,
//          y, z, v, ...] NEIGHBOR-array writes to replay on the main thread;
//          dirtied = chunk keys whose meshes are stale (WorldGrid.markDirty's
//          border+corner rule, replayed verbatim).
//   worker → { type:'lightError', id, message }
// The registry import here is pure data (no DOM, no tile resolution — the
// light path reads only opacity/emission, never tileIndex — see U11/U12).
import { computeChunkLight } from '../world/LightEngine.js';

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      self.postMessage({ type: 'lightReady' });
    } catch (err) {
      self.postMessage({ type: 'lightError', id: -1, message: String(err?.message ?? err) });
    }
    return;
  }
  if (msg.type !== 'light') return;
  if (!msg.hood || msg.hood.length !== 9) {
    self.postMessage({ type: 'lightError', id: msg.id, message: 'bad hood snapshot' });
    return;
  }
  try {
    const center = msg.hood[4];
    const r = computeChunkLight(center, msg.hood, { hasSkyLight: msg.hasSkyLight });
    const transfer = [
      r.skyLight.buffer, r.blockLight.buffer, r.deltas.buffer,
    ];
    for (const slot of msg.hood) {
      transfer.push(slot.blocks.buffer, slot.states.buffer, slot.heightMap.buffer,
        slot.skyLight.buffer, slot.blockLight.buffer);
    }
    self.postMessage({
      type: 'lit', id: msg.id, cx: msg.cx, cz: msg.cz, epoch: msg.epoch,
      skyLight: r.skyLight, blockLight: r.blockLight,
      deltas: r.deltas, dirtied: r.dirtied,
    }, transfer);
  } catch (err) {
    self.postMessage({ type: 'lightError', id: msg.id, message: String(err?.stack ?? err) });
  }
};