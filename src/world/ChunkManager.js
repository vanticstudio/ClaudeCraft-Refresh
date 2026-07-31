// Chunk streaming: worker dispatch, state promotion, remesh queue (01 §4, §9).
import * as THREE from 'three';
import { Chunk, ChunkState } from './Chunk.js';
import { terminatesSky } from './LightEngine.js';
import { fireTickDelay } from './fire.js';
import { B, BLOCKS, STATE_NIBBLE } from '../registry/blocks.js';
import { ChunkMesher, setChunkBoundingSphere } from '../mesh/ChunkMesher.js';
import {
  chunkKey, GENERATE_RADIUS, RENDER_RADIUS, UNLOAD_RADIUS,
  MAX_JOBS_IN_FLIGHT, WORKER_COUNT, REMESH_FRAME_BUDGET_MS, REMESH_FRAME_MAX,
  INITIAL_MESH_PER_TICK, MAX_Y, CHUNK_CELLS, WORKER_READY_TIMEOUT_MS,
} from '../constants.js';

export class ChunkManager {
  constructor(world, scene, materials, tileUV) {
    this.world = world;
    this.scene = scene;
    this.materials = materials;
    this.mesher = new ChunkMesher(tileUV);
    this.save = null;                  // saveManager, wired by Game
    this.game = null;
    this.workers = [];
    this.nextWorker = 0;
    this.pending = new Map();          // jobId → chunk key
    this.jobWorker = new Map();        // jobId → worker index (onerror recovery)
    this.nextJobId = 1;
    this.requestList = [];             // [key, cx, cz] tuples, nearest first
    // 14 AMENDS 01 §4.3 — membership index for requestList. ensureLoadedAround is
    // called once per PLAYER per pass and walks (2r+1)^2 = 289 cells at r=8; a
    // linear `.some()` over a backlog that rebuildRequestList refills to 289+ on
    // every chunk-border crossing made each pass O(289 x n). The Set keeps the
    // dedup O(1). INVARIANT: it holds exactly the keys present in requestList.
    this.requestQueued = new Set();
    this.lastPlayerChunk = null;
    this.remeshQueue = new Set();      // chunk keys needing (re)mesh
    this.worldSpawn = null;
    this.onReady = null;
    // 01 §9/§16 — a world that can never boot must FAIL, not hang on "Building
    // terrain…". Game.startWorld wires onFatal to the ready promise's reject and
    // main.js returns to TITLE.
    this.onFatal = null;
    this._readyTimer = null;
    this.retries = new Map();
    this.loading = true;               // relaxes budgets during LOADING screen
  }

  initWorkers(seedString) {
    for (let w = 0; w < WORKER_COUNT; w++) {
      const wi = w;
      // A browser that refuses module workers (or a blocked blob: URL) threw
      // synchronously out of startWorld and left the loading veil up forever.
      let worker;
      try {
        worker = new Worker(new URL('../workers/terrainWorker.js', import.meta.url), { type: 'module' });
      } catch (err) { console.error('[terrainWorker] spawn failed', err); continue; }
      worker.onmessage = e => this.onWorkerMessage(e.data);
      // 01 §9 — "Worker errors (onerror): log, re-queue the job once, then mark
      // the chunk FAILED". Logging alone leaked every in-flight jobId of a dead
      // worker: `pending` is only ever drained by the three message handlers, so
      // MAX_JOBS_IN_FLIGHT (16) leaks would stall chunk dispatch for the session.
      worker.onerror = err => this.onWorkerError(wi, err);
      // A structured-clone failure on the way IN never reaches the worker's own
      // try/catch, so it too must drain that worker's job slots (01 §9).
      worker.onmessageerror = err => this.onWorkerError(wi, err);
      worker.postMessage({ type: 'init', seed: seedString });
      this.workers.push(worker);
    }
    if (!this.workers.length) { this.onFatal?.(new Error('no terrain workers')); return; }
    // …and a worker that boots but never answers `ready` (a throw inside the
    // generator ctors is reported as `fatal`, but a hang is not).
    this._readyTimer = setTimeout(() => {
      if (!this.worldSpawn) this.onFatal?.(new Error('terrain workers never reported ready'));
    }, WORKER_READY_TIMEOUT_MS);
  }

  onWorkerError(wi, err) {
    console.error('[terrainWorker]', err?.message ?? err);
    for (const [jobId, owner] of [...this.jobWorker]) {
      if (owner !== wi) continue;
      const key = this.pending.get(jobId);
      this.pending.delete(jobId);
      this.jobWorker.delete(jobId);
      if (key) this.failChunk(key, err?.message ?? 'worker error');
    }
    // Before `ready` there is no world at all — a module-resolution failure here
    // is fatal, not a per-chunk retry.
    if (!this.worldSpawn) this.onFatal?.(new Error('terrain worker error: ' + (err?.message ?? err)));
  }

  /** 01 §9 recovery, shared by the worker's own `error` message and onerror. */
  failChunk(key, message) {
    const n = (this.retries.get(key) ?? 0) + 1;
    this.retries.set(key, n);
    const chunk = this.world.chunks.get(key);
    if (!chunk) return;
    if (n <= 1) { this.requestGenerate(chunk); return; }
    this.markChunkFailed(chunk);
    console.error(`[terrainWorker] chunk ${key} failed twice: ${message}`);
  }

  /**
   * A FAILED chunk gets empty arrays so it is a MESHABLE hole (01 §9's intended
   * 1×1 "visible hole = loud bug signal") rather than a wall: hoodAtLeast()
   * exempts FAILED but ChunkMesher.captureHood does not, so a bare FAILED chunk
   * un-meshes all 8 of its neighbours too.
   */
  markChunkFailed(chunk) {
    if (!chunk.blocks) chunk.install(new Uint8Array(CHUNK_CELLS), new Uint8Array(256), new Uint8Array(256));
    chunk.state = ChunkState.FAILED;   // install() resets to GENERATED — must follow it
  }

  /**
   * 01 §9/§15.2 watchdog, driven by Game.tick's LOADING branch after 400 ticks
   * of ZERO new meshed chunks. Every cell of the 7×7 that is neither MESHED nor
   * already FAILED is force-resolved into 01 §9's "visible hole" so the gate can
   * finish; a missing cell is created first (an aborted request list leaves the
   * ring with holes that loadingProgress counts but nothing ever dispatches).
   */
  forceResolveSpawnRing(pcx, pcz) {
    console.error('[chunks] loading stalled — spawn ring force-resolved');
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        const cx = pcx + dx, cz = pcz + dz, key = chunkKey(cx, cz);
        let c = this.world.chunks.get(key);
        if (!c) {
          c = new Chunk(cx, cz, this.world.activeDim);
          this.world.chunks.set(key, c);
          this.world.chunkVersion++;
        }
        if (c.state === ChunkState.MESHED || c.state === ChunkState.FAILED) continue;
        this.markChunkFailed(c);
      }
    }
  }

  dispose() {
    if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
  }

  onWorkerMessage(msg) {
    if (msg.type === 'ready') {
      if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
      if (!this.worldSpawn) {
        this.worldSpawn = msg.worldSpawn;
        this.onReady?.(msg.worldSpawn);
      }
      return;
    }
    // 01 §9 — a throw inside the worker's own `init` branch (generator ctors,
    // findWorldSpawn). Unobservable before terrainWorker.js grew its try/catch.
    if (msg.type === 'fatal') {
      if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
      console.error('[terrainWorker] init failed:', msg.message);
      this.onFatal?.(new Error('terrain worker init failed: ' + msg.message));
      return;
    }
    if (msg.type === 'error') {
      const key = this.pending.get(msg.jobId);
      this.pending.delete(msg.jobId);
      this.jobWorker.delete(msg.jobId);
      if (!key) return;
      this.failChunk(key, msg.message);   // visible hole = loud bug signal (01 §9)
      return;
    }
    if (msg.type === 'chunk') {
      const key = this.pending.get(msg.jobId);
      this.pending.delete(msg.jobId);
      this.jobWorker.delete(msg.jobId);
      const chunk = this.world.chunks.get(chunkKey(msg.cx, msg.cz));
      if (!chunk || chunk.state !== ChunkState.REQUESTED || key !== chunk.key) return;   // stale
      // transferred views are used as-is (zero-copy, 01 §9)
      chunk.install(msg.blocks, msg.heightMap, msg.biomes, msg.states ?? null);   // 11-END: stronghold frame states
      chunk.pendingSpawns = msg.spawns?.length ? msg.spawns : null;
      if (msg.villageMeta) chunk.villageMeta = msg.villageMeta;   // 12-VILLAGES §2.7
      this.game?.onChunkGenerated?.(chunk);
    }
  }

  requestGenerate(chunk) {
    // With zero workers `this.nextWorker` is NaN and the postMessage below threw
    // every tick; onFatal has already been raised by initWorkers.
    const worker = this.workers[this.nextWorker];
    if (!worker) return;
    const jobId = this.nextJobId++;
    this.pending.set(jobId, chunk.key);
    this.jobWorker.set(jobId, this.nextWorker);
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    // 10-NETHER §2.2 — the worker dispatches gen by dimension.
    worker.postMessage({ type: 'generate', cx: chunk.cx, cz: chunk.cz, jobId, dim: chunk.dim });
  }

  /**
   * 10-NETHER §2.3/§2.5 — flush every resident chunk to disk (dim-prefixed) and
   * unload it, then reset streaming so a new dimension re-streams from scratch.
   */
  flushAllChunks() {
    for (const chunk of this.world.chunks.values()) {
      if (chunk.modified && chunk.blocks && this.save) this.save.saveChunkNow(chunk);
      this.game?.onChunkUnloading?.(chunk);
      this.disposeChunkMeshes(chunk);
    }
    this.world.chunks.clear();
    this.world.chunkVersion++;
    this.remeshQueue.clear();
    this.pending.clear();
    this.jobWorker.clear();
    this.requestList.length = 0;
    this.requestQueued.clear();        // the index tracks the list exactly
    this.lastPlayerChunk = null;
  }

  async hydrate(chunk, record) {
    if (!this.world.chunks.has(chunk.key) || chunk.state !== ChunkState.REQUESTED) return;
    // 01 §16 — validate at the boundary. `new Uint8Array(undefined)` yields a
    // ZERO-LENGTH array rather than throwing, so a truncated record used to
    // install silently and every read past index 0 returned undefined.
    if (record.blocks?.byteLength !== CHUNK_CELLS || record.states?.byteLength !== CHUNK_CELLS ||
        record.biomes?.byteLength !== 256) throw new Error('corrupt chunk record ' + chunk.key);
    const blocks = new Uint8Array(record.blocks);
    const states = new Uint8Array(record.states);
    const biomes = new Uint8Array(record.biomes);
    // heightMap recomputed by top-down column scan (01 §9)
    const heightMap = new Uint8Array(256);
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        for (let y = MAX_Y; y >= 0; y--) {
          const i = (y << 8) | (z << 4) | x;
          // 15 §13.5 — the heightmap terminates at a waterlogged block, so the
          // state MUST be passed: hydrate is the other heightmap producer
          // besides onBlockChanged, and it loads player-authored bit-7 cells.
          // Omitting it silently un-shades every waterlogged column on reload
          // and flips isRainingAt below it from false to true.
          if (terminatesSky(blocks[i], states[i])) {
            heightMap[(z << 4) | x] = y + 1;
            break;
          }
        }
      }
    }
    chunk.install(blocks, heightMap, biomes, states);
    chunk.modified = false;
    chunk.spawnsDone = record.spawnsDone ?? true;
    if (record.blockEntities) {
      for (const be of record.blockEntities) chunk.blockEntities.set(be.i, { type: be.type, data: be.data });
    }
    this.resumeTicks(chunk);
    this.game?.onChunkHydrated?.(chunk, record);
  }

  /**
   * 15 §6.5 — fire age rides `chunk.states`, but the scheduled-tick bucket is
   * runtime-only (01 §6.1), so a fire loaded from a save has no pending tick and
   * would neither spread nor burn out. Re-queue one per fire cell. The origin
   * map is deliberately NOT restored: §6.5 has each hydrated fire self-register
   * at its load position on that first tick, re-anchoring the 24-block leash.
   *
   * 06 §6.2 — FLOWING FLUIDS need the identical treatment, and the two must ship
   * together with ScheduledTicks' drop-on-unload: the level nibble IS persisted
   * (saveManager writes `chunk.states` verbatim), so a non-source fluid cell
   * comes back byte-exact with no pending tick and freezes mid-flow — forever,
   * until an unrelated setBlock happens to wake it. Sources are skipped: they
   * are stable by definition and `Fluids.wake` covers them. Bit-7 cells are
   * skipped for the same reason — 15 §11.1 makes a waterlogged block a water
   * SOURCE, so an underwater fence run would enqueue hundreds of no-op ticks.
   */
  resumeTicks(chunk) {
    const blocks = chunk.blocks, states = chunk.states;
    if (!blocks) return;
    const ox = chunk.cx << 4, oz = chunk.cz << 4;
    for (let i = 0; i < blocks.length; i++) {
      const id = blocks[i];
      // Cheap pre-filter over 32 768 cells: a non-source fluid always carries a
      // non-zero nibble (bits 0–2 = spread level, bit 3 = falling, 06 §6.2), and
      // fire is matched by id because its age may legitimately be 0.
      if (id !== B.FIRE && (states[i] & STATE_NIBBLE) === 0) continue;
      const fluid = id === B.FIRE ? null : BLOCKS[id]?.fluid;
      if (id !== B.FIRE && !fluid) continue;      // crop stage / door / repeater delay
      const fx = ox + (i & 15), fy = i >> 8, fz = oz + ((i >> 4) & 15);
      if (fluid) { this.world.scheduleTick(fx, fy, fz, this.world.fluids.interval(fluid)); continue; }
      // 01 §6.1 — ScheduledTicks dedups inside ONE bucket only, so a fire whose
      // tick outlived a previous residency would get a SECOND, parallel chain
      // here (fireTick re-schedules itself first thing), doubling its spread
      // rate on every round trip. Same cross-bucket guard components.js
      // hand-rolls. Fluid ticks need no such guard: a fluid cell only ever
      // re-schedules itself when something WRITES to it, so duplicates converge
      // and die instead of self-sustaining.
      if (!this.world.hasScheduled(fx, fy, fz)) this.world.scheduleTick(fx, fy, fz, fireTickDelay());
    }
  }

  // 14 §2.3 — install a chunk streamed from the host (CLIENT). Mirrors hydrate:
  // recompute heightMap, install to GENERATED; promote() lights + meshes it later.
  installNetChunk(cx, cz, blocks, states, biomes, dim) {
    const key = chunkKey(cx, cz);
    let chunk = this.world.chunks.get(key);
    if (!chunk) { chunk = new Chunk(cx, cz, dim ?? this.world.activeDim); this.world.chunks.set(key, chunk); this.world.chunkVersion++; }
    else if (chunk.state >= ChunkState.GENERATED) {
      // Re-sent on re-approach (coherence). This MUST go through install(), not a
      // hand-assignment: initialLight only ever RAISES light (step 1 writes 15
      // above H, step 3 writes emissions, the BFS tests `newL > current`) and
      // nothing else zeroes the arrays, so keeping the old skyLight/blockLight
      // here left a removed glowstone's halo and daylight under a new roof
      // forever. install() reallocates both zeroed and resets state to GENERATED,
      // so promote() relights from scratch; its enqueue path covers the remesh.
      chunk.install(blocks, this._recomputeHeightMap(null, blocks, states), biomes, states);
      chunk.modified = false;
      return;
    }
    const heightMap = new Uint8Array(256);
    this._recomputeHeightMap({ heightMap }, blocks, states, heightMap);
    chunk.install(blocks, heightMap, biomes, states);
    chunk.modified = false;
    chunk.spawnsDone = true;
  }

  _recomputeHeightMap(target, blocks, states, hmOut) {
    const hm = hmOut || new Uint8Array(256);
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      for (let y = MAX_Y; y >= 0; y--) {
        const i = (y << 8) | (z << 4) | x;
        if (terminatesSky(blocks[i], states[i])) { hm[(z << 4) | x] = y + 1; break; }
      }
    }
    if (target && target.heightMap && target.heightMap !== hm) target.heightMap = hm;
    return hm;
  }

  // 14 AMENDS 01 §4.3 — the host loads chunks around EVERY player (union keep-alive)
  // so a client far from the host still has its terrain to stream.
  ensureLoadedAround(pcx, pcz, radius) {
    if (this.netClient) return;
    for (let dcx = -radius; dcx <= radius; dcx++) for (let dcz = -radius; dcz <= radius; dcz++) {
      const cx = pcx + dcx, cz = pcz + dcz, key = chunkKey(cx, cz);
      if (this.world.chunks.has(key)) continue;
      if (this.requestQueued.has(key)) continue;
      this.requestQueued.add(key);
      this.requestList.push([key, cx, cz, dcx * dcx + dcz * dcz]);
    }
  }

  // ------------------------------------------------------------- tick

  tick(playerX, playerZ) {
    const pcx = Math.floor(playerX) >> 4;
    const pcz = Math.floor(playerZ) >> 4;
    this.world.playerChunk = { cx: pcx, cz: pcz };

    // 14 §1.1 — a CLIENT never generates terrain (no workers); chunks arrive via
    // installNetChunk. It still promotes/lights/meshes/unloads locally.
    if (this.netClient) { this.promote(pcx, pcz); if (this.world.time % 20 === 0) this.unloadPass(pcx, pcz); return; }

    if (!this.lastPlayerChunk || this.lastPlayerChunk.cx !== pcx || this.lastPlayerChunk.cz !== pcz) {
      this.lastPlayerChunk = { cx: pcx, cz: pcz };
      this.rebuildRequestList(pcx, pcz);
    }

    // dispatch generate/hydrate jobs
    while (this.pending.size < MAX_JOBS_IN_FLIGHT && this.requestList.length > 0) {
      const [key, cx, cz] = this.requestList.shift();
      this.requestQueued.delete(key);   // leaves the list — drop it from the index
      if (this.world.chunks.has(key)) continue;
      const chunk = new Chunk(cx, cz, this.world.activeDim);   // 10-NETHER §2.4
      this.world.chunks.set(key, chunk);
      this.world.chunkVersion++;
      if (this.save?.hasChunk(key)) {
        // saved chunks skip the worker entirely (01 §9)
        const jobId = this.nextJobId++;
        this.pending.set(jobId, key);
        this.save.loadChunk(key).then(rec => {
          this.pending.delete(jobId);
          // RETURN the hydrate promise: it is async, so a discarded one put every
          // throw inside hydrate beyond the reach of the catch below.
          if (rec) return this.hydrate(chunk, rec);
          throw new Error('missing chunk record');
        }).catch(err => {
          // No .catch leaked the pending slot permanently (loadChunk builds its
          // IndexedDB transaction inside the executor, so a closing connection
          // rejects) and stranded the chunk at REQUESTED — solid-but-air terrain.
          this.pending.delete(jobId);
          this.markChunkFailed(chunk);
          // Drop the key so the next visit regenerates from the seed instead of
          // re-reading the same unusable record forever.
          this.save?.savedChunkKeys?.delete(this.save.keyFor(key, chunk.dim));
          console.error(`[save] hydrate failed ${key}`, err);
        });
      } else {
        this.requestGenerate(chunk);
      }
    }

    this.promote(pcx, pcz);

    if (this.world.time % 20 === 0) this.unloadPass(pcx, pcz);
  }

  rebuildRequestList(pcx, pcz) {
    const list = [];
    // This REPLACES the whole list, so the membership index is rebuilt with it —
    // clearing first is what keeps `requestQueued` from accumulating keys for
    // entries that no longer exist (which would make ensureLoadedAround refuse
    // to re-queue a chunk that had dropped out of the local player's radius).
    this.requestQueued.clear();
    for (let dcx = -GENERATE_RADIUS; dcx <= GENERATE_RADIUS; dcx++) {
      for (let dcz = -GENERATE_RADIUS; dcz <= GENERATE_RADIUS; dcz++) {
        const cx = pcx + dcx, cz = pcz + dcz;
        const key = chunkKey(cx, cz);
        if (this.world.chunks.has(key)) continue;
        list.push([key, cx, cz, dcx * dcx + dcz * dcz]);
        this.requestQueued.add(key);
      }
    }
    list.sort((a, b) => a[3] - b[3]);
    this.requestList = list;
  }

  promote(pcx, pcz) {
    // LIT promotion: 3×3 GENERATED required (01 §4.4)
    const budget = this.loading ? INITIAL_MESH_PER_TICK : 2;
    const candidates = [];
    for (const chunk of this.world.chunks.values()) {
      // 01 §4.4 — "scan chunks in ascending distance; promote every chunk whose
      // precondition is met". LIT is exactly "lit but never meshed" (buildChunk
      // promotes LIT→MESHED), so the mesh-ready sweep belongs here. Queueing only
      // the 3×3 around a chunk promoted THIS tick stranded every chunk that
      // reached LIT while outside RENDER_RADIUS — the client streams to the
      // host's STREAM_RADIUS 8 regardless of its own render distance, and the
      // host keeps a union block alive around every player. Result: solid,
      // invisible terrain that nothing ever re-queues.
      if (chunk.state === ChunkState.LIT && !this.remeshQueue.has(chunk.key) &&
          Math.max(Math.abs(chunk.cx - pcx), Math.abs(chunk.cz - pcz)) <= RENDER_RADIUS &&
          this.hoodAtLeast(chunk, ChunkState.LIT)) this.remeshQueue.add(chunk.key);
      if (chunk.state !== ChunkState.GENERATED) continue;
      if (!this.hoodAtLeast(chunk, ChunkState.GENERATED)) continue;
      const dx = chunk.cx - pcx, dz = chunk.cz - pcz;
      candidates.push([dx * dx + dz * dz, chunk]);
    }
    candidates.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < Math.min(budget, candidates.length); i++) {
      const chunk = candidates[i][1];
      const dirtied = this.world.light.initialLight(chunk);   // sets state LIT
      for (const k of dirtied) {
        const c = this.world.chunks.get(k);
        if (c && c.state === ChunkState.MESHED) this.remeshQueue.add(k);
      }
      // this chunk (and neighbors) may now be mesh-ready — same tick, so the
      // loading screen does not lose a frame waiting for the sweep above.
      for (let ddx = -1; ddx <= 1; ddx++) {
        for (let ddz = -1; ddz <= 1; ddz++) {
          const c = this.world.chunks.get(chunkKey(chunk.cx + ddx, chunk.cz + ddz));
          if (c && c.state === ChunkState.LIT && this.hoodAtLeast(c, ChunkState.LIT)) {
            const d2x = c.cx - pcx, d2z = c.cz - pcz;
            if (Math.max(Math.abs(d2x), Math.abs(d2z)) <= RENDER_RADIUS) this.remeshQueue.add(c.key);
          }
        }
      }
    }
  }

  hoodAtLeast(chunk, state) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const c = this.world.chunks.get(chunkKey(chunk.cx + dx, chunk.cz + dz));
        if (!c || c.state < state) {
          if (!(c && c.state === ChunkState.FAILED)) return false;
        }
      }
    }
    return true;
  }

  unloadPass(pcx, pcz) {
    // 14 AMENDS 01 §6.2 — UNLOAD_RADIUS measures to the NEAREST player (union),
    // so a chunk stays resident while any connected player needs it.
    const centers = (!this.netClient && this.game?.net?.isHost) ? this.game.playerChunkCenters() : null;
    const dead = [];
    for (const chunk of this.world.chunks.values()) {
      let d = Math.max(Math.abs(chunk.cx - pcx), Math.abs(chunk.cz - pcz));
      if (centers) for (const c of centers) { const dd = Math.max(Math.abs(chunk.cx - c.cx), Math.abs(chunk.cz - c.cz)); if (dd < d) d = dd; }
      if (d > UNLOAD_RADIUS) dead.push(chunk);
    }
    for (const chunk of dead) {
      if (chunk.modified && this.save) this.save.saveChunkNow(chunk);
      this.game?.onChunkUnloading?.(chunk);       // discard its entities
      this.disposeChunkMeshes(chunk);
      this.world.chunks.delete(chunk.key);
      this.world.chunkVersion++;
      this.remeshQueue.delete(chunk.key);
      // 01 §9 grants every chunk ONE re-queue. The counter was never cleared, so
      // a chunk that errored once and then unloaded went straight to FAILED on
      // re-approach — and the map grew for the whole session.
      this.retries.delete(chunk.key);
    }
  }

  disposeChunkMeshes(chunk) {
    if (!chunk.group) return;
    for (const bucket of ['opaque', 'cutout', 'water']) {
      const mesh = chunk.meshes[bucket];
      if (mesh) {
        mesh.geometry.dispose();
        chunk.group.remove(mesh);
        chunk.meshes[bucket] = null;
      }
    }
    this.scene.remove(chunk.group);
    chunk.group = null;
  }

  // ------------------------------------------------------------- meshing

  // 01 §4.5 — "sets chunk.dirty = true and pushes its key into remeshQueue".
  // The flag half was missing, leaving Chunk.dirty permanently false for every
  // queued chunk; buildChunk already clears it, closing the loop.
  markDirty(key) {
    const chunk = this.world.chunks.get(key);
    if (chunk && chunk.state >= ChunkState.LIT) { chunk.dirty = true; this.remeshQueue.add(key); }
  }

  // Synchronous rebuild for player edits (01 §4.5)
  rebuildNow(keys) {
    for (const key of keys) {
      const chunk = this.world.chunks.get(key);
      // Dequeue only on SUCCESS: buildChunk returns false when the mesher's
      // captureHood rejects the 3×3 (a FAILED neighbour), and dropping the key
      // then un-meshed that chunk permanently.
      if (chunk && chunk.state === ChunkState.MESHED && this.buildChunk(chunk)) this.remeshQueue.delete(key);
    }
  }

  // Render-side drain: nearest-first within budget (01 §3, §4.5)
  drainRemesh(playerX, playerZ, budgetMs = REMESH_FRAME_BUDGET_MS, maxCount = REMESH_FRAME_MAX) {
    if (this.remeshQueue.size === 0) return 0;
    const pcx = Math.floor(playerX) >> 4, pcz = Math.floor(playerZ) >> 4;
    const entries = [];
    for (const key of this.remeshQueue) {
      const chunk = this.world.chunks.get(key);
      if (!chunk || chunk.state < ChunkState.LIT) { this.remeshQueue.delete(key); continue; }
      const dx = chunk.cx - pcx, dz = chunk.cz - pcz;
      entries.push([dx * dx + dz * dz, chunk]);
    }
    entries.sort((a, b) => a[0] - b[0]);
    const t0 = performance.now();
    let built = 0;
    for (const [, chunk] of entries) {
      if (built >= maxCount || performance.now() - t0 > budgetMs) break;
      if (!this.hoodAtLeast(chunk, ChunkState.LIT)) continue;   // retried later
      // hoodAtLeast exempts FAILED neighbours, ChunkMesher.captureHood does not,
      // so this pre-check passes exactly where the build is guaranteed to fail.
      // Keep the key queued on failure or the chunk never meshes again.
      if (!this.buildChunk(chunk)) continue;
      this.remeshQueue.delete(chunk.key);
      built++;
    }
    return built;
  }

  buildChunk(chunk) {
    const geos = this.mesher.build(this.world, chunk);
    if (!geos) return false;
    if (!chunk.group) {
      chunk.group = new THREE.Group();
      chunk.group.position.set(chunk.cx * 16, 0, chunk.cz * 16);
      chunk.group.matrixAutoUpdate = false;
      chunk.group.updateMatrix();
      this.scene.add(chunk.group);
    }
    for (const bucket of ['opaque', 'cutout', 'water']) {
      const old = chunk.meshes[bucket];
      const geo = geos[bucket];
      if (old) {
        old.geometry.dispose();
        if (geo) {
          old.geometry = geo;
          setChunkBoundingSphere(geo, chunk.minY, chunk.maxY);
        } else {
          chunk.group.remove(old);
          chunk.meshes[bucket] = null;
        }
      } else if (geo) {
        const mesh = new THREE.Mesh(geo, this.materials[bucket]);
        mesh.matrixAutoUpdate = false;
        mesh.renderOrder = bucket === 'water' ? 10 : 0;
        setChunkBoundingSphere(geo, chunk.minY, chunk.maxY);
        chunk.meshes[bucket] = mesh;
        chunk.group.add(mesh);
      }
    }
    chunk.dirty = false;
    if (chunk.state === ChunkState.LIT) chunk.state = ChunkState.MESHED;
    return true;
  }

  // Loading progress: meshed fraction of the 7×7 around spawn (01 §15.2)
  loadingProgress(pcx, pcz) {
    let meshed = 0, needed = 0;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        needed++;
        const c = this.world.chunks.get(chunkKey(pcx + dx, pcz + dz));
        // FAILED is terminal — nothing re-requests it — so it must count as
        // RESOLVED or one unrecoverable spawn chunk hangs the loading veil at
        // 48/49 forever (Game's gate is `meshed >= needed` with no timeout).
        if (c && (c.state === ChunkState.MESHED || c.state === ChunkState.FAILED)) meshed++;
      }
    }
    return { meshed, needed };
  }

  countByState() {
    const counts = { requested: 0, generated: 0, lit: 0, meshed: 0, failed: 0 };
    for (const c of this.world.chunks.values()) {
      if (c.state === ChunkState.REQUESTED) counts.requested++;
      else if (c.state === ChunkState.GENERATED) counts.generated++;
      else if (c.state === ChunkState.LIT) counts.lit++;
      else if (c.state === ChunkState.MESHED) counts.meshed++;
      else counts.failed++;
    }
    return counts;
  }
}
