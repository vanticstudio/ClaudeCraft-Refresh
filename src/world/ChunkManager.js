// Chunk streaming: worker dispatch, state promotion, remesh queue (01 §4, §9).
import * as THREE from 'three';
import { Chunk, ChunkState } from './Chunk.js';
import { terminatesSky } from './LightEngine.js';
import { ChunkMesher, setChunkBoundingSphere } from '../mesh/ChunkMesher.js';
import {
  chunkKey, GENERATE_RADIUS, RENDER_RADIUS, UNLOAD_RADIUS,
  MAX_JOBS_IN_FLIGHT, WORKER_COUNT, REMESH_FRAME_BUDGET_MS, REMESH_FRAME_MAX,
  INITIAL_MESH_PER_TICK, MAX_Y,
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
    this.nextJobId = 1;
    this.requestList = [];             // [key, cx, cz] tuples, nearest first
    this.lastPlayerChunk = null;
    this.remeshQueue = new Set();      // chunk keys needing (re)mesh
    this.worldSpawn = null;
    this.onReady = null;
    this.retries = new Map();
    this.loading = true;               // relaxes budgets during LOADING screen
  }

  initWorkers(seedString) {
    for (let w = 0; w < WORKER_COUNT; w++) {
      const worker = new Worker(new URL('../workers/terrainWorker.js', import.meta.url), { type: 'module' });
      worker.onmessage = e => this.onWorkerMessage(e.data);
      worker.onerror = err => console.error('[terrainWorker]', err.message ?? err);
      worker.postMessage({ type: 'init', seed: seedString });
      this.workers.push(worker);
    }
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
  }

  onWorkerMessage(msg) {
    if (msg.type === 'ready') {
      if (!this.worldSpawn) {
        this.worldSpawn = msg.worldSpawn;
        this.onReady?.(msg.worldSpawn);
      }
      return;
    }
    if (msg.type === 'error') {
      const key = this.pending.get(msg.jobId);
      this.pending.delete(msg.jobId);
      if (!key) return;
      const n = (this.retries.get(key) ?? 0) + 1;
      this.retries.set(key, n);
      const chunk = this.world.chunks.get(key);
      if (!chunk) return;
      if (n <= 1) this.requestGenerate(chunk);
      else {
        chunk.state = ChunkState.FAILED;   // visible hole = loud bug signal (01 §9)
        console.error(`[terrainWorker] chunk ${key} failed twice: ${msg.message}`);
      }
      return;
    }
    if (msg.type === 'chunk') {
      const key = this.pending.get(msg.jobId);
      this.pending.delete(msg.jobId);
      const chunk = this.world.chunks.get(chunkKey(msg.cx, msg.cz));
      if (!chunk || chunk.state !== ChunkState.REQUESTED || key !== chunk.key) return;   // stale
      // transferred views are used as-is (zero-copy, 01 §9)
      chunk.install(msg.blocks, msg.heightMap, msg.biomes);
      chunk.pendingSpawns = msg.spawns?.length ? msg.spawns : null;
      this.game?.onChunkGenerated?.(chunk);
    }
  }

  requestGenerate(chunk) {
    const jobId = this.nextJobId++;
    this.pending.set(jobId, chunk.key);
    const worker = this.workers[this.nextWorker];
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    worker.postMessage({ type: 'generate', cx: chunk.cx, cz: chunk.cz, jobId });
  }

  async hydrate(chunk, record) {
    if (!this.world.chunks.has(chunk.key) || chunk.state !== ChunkState.REQUESTED) return;
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
    this.game?.onChunkHydrated?.(chunk, record);
  }

  // ------------------------------------------------------------- tick

  tick(playerX, playerZ) {
    const pcx = Math.floor(playerX) >> 4;
    const pcz = Math.floor(playerZ) >> 4;
    this.world.playerChunk = { cx: pcx, cz: pcz };

    if (!this.lastPlayerChunk || this.lastPlayerChunk.cx !== pcx || this.lastPlayerChunk.cz !== pcz) {
      this.lastPlayerChunk = { cx: pcx, cz: pcz };
      this.rebuildRequestList(pcx, pcz);
    }

    // dispatch generate/hydrate jobs
    while (this.pending.size < MAX_JOBS_IN_FLIGHT && this.requestList.length > 0) {
      const [key, cx, cz] = this.requestList.shift();
      if (this.world.chunks.has(key)) continue;
      const chunk = new Chunk(cx, cz);
      this.world.chunks.set(key, chunk);
      this.world.chunkVersion++;
      if (this.save?.hasChunk(key)) {
        // saved chunks skip the worker entirely (01 §9)
        const jobId = this.nextJobId++;
        this.pending.set(jobId, key);
        this.save.loadChunk(key).then(rec => {
          this.pending.delete(jobId);
          if (rec) this.hydrate(chunk, rec);
          else { chunk.state = ChunkState.FAILED; console.error(`[save] missing chunk ${key}`); }
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
    for (let dcx = -GENERATE_RADIUS; dcx <= GENERATE_RADIUS; dcx++) {
      for (let dcz = -GENERATE_RADIUS; dcz <= GENERATE_RADIUS; dcz++) {
        const cx = pcx + dcx, cz = pcz + dcz;
        const key = chunkKey(cx, cz);
        if (this.world.chunks.has(key)) continue;
        list.push([key, cx, cz, dcx * dcx + dcz * dcz]);
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
      // this chunk (and neighbors) may now be mesh-ready
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
    const dead = [];
    for (const chunk of this.world.chunks.values()) {
      const d = Math.max(Math.abs(chunk.cx - pcx), Math.abs(chunk.cz - pcz));
      if (d > UNLOAD_RADIUS) dead.push(chunk);
    }
    for (const chunk of dead) {
      if (chunk.modified && this.save) this.save.saveChunkNow(chunk);
      this.game?.onChunkUnloading?.(chunk);       // discard its entities
      this.disposeChunkMeshes(chunk);
      this.world.chunks.delete(chunk.key);
      this.world.chunkVersion++;
      this.remeshQueue.delete(chunk.key);
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

  markDirty(key) {
    const chunk = this.world.chunks.get(key);
    if (chunk && chunk.state >= ChunkState.LIT) this.remeshQueue.add(key);
  }

  // Synchronous rebuild for player edits (01 §4.5)
  rebuildNow(keys) {
    for (const key of keys) {
      const chunk = this.world.chunks.get(key);
      if (chunk && chunk.state === ChunkState.MESHED) {
        this.buildChunk(chunk);
        this.remeshQueue.delete(key);
      }
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
      this.buildChunk(chunk);
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
        if (c && c.state === ChunkState.MESHED) meshed++;
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
