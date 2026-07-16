// IndexedDB persistence (01 §16): meta + modified chunks only.
import { DB_NAME, DB_VERSION, SAVE_VERSION, AUTOSAVE_INTERVAL } from '../constants.js';

export class SaveManager {
  constructor() {
    this.db = null;
    this.savedChunkKeys = new Set();
    this.meta = null;
    this.autosaveCounter = 0;
    this.saving = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
      };
      req.onsuccess = e => {
        this.db = e.target.result;
        const tx = this.db.transaction(['meta', 'chunks'], 'readonly');
        const metaReq = tx.objectStore('meta').get('world');
        const keysReq = tx.objectStore('chunks').getAllKeys();
        tx.oncomplete = () => {
          this.meta = metaReq.result ?? null;
          if (this.meta && this.meta.version !== SAVE_VERSION) {
            console.warn('[save] incompatible save version — offering new world only');
            this.meta = null;
          }
          this.savedChunkKeys = new Set(keysReq.result ?? []);
          resolve(this);
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  hasWorld() { return this.meta !== null; }
  hasChunk(key) { return this.savedChunkKeys.has(key); }

  loadChunk(key) {
    return new Promise(resolve => {
      const tx = this.db.transaction('chunks', 'readonly');
      const req = tx.objectStore('chunks').get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  }

  serializeChunk(chunk, game) {
    const blockEntities = [];
    for (const [i, be] of chunk.blockEntities) {
      blockEntities.push({ i, type: be.type, data: be.data });
    }
    const entities = [];
    for (const e of chunk.entities) {
      if (e === game.player || e.dead) continue;
      const rec = e.serialize?.();
      if (rec && rec.type && rec.type !== 'player' && rec.type !== 'arrow' &&
          !rec.type.startsWith('thrown')) {
        entities.push(rec);
      }
    }
    return {
      // buffers written as-is — the structured clone copies them (01 §16.2)
      cx: chunk.cx, cz: chunk.cz,
      blocks: chunk.blocks.buffer,
      states: chunk.states.buffer,
      biomes: chunk.biomes ? chunk.biomes.buffer : new ArrayBuffer(256),
      blockEntities,
      spawnsDone: chunk.spawnsDone,
      spawns: chunk.pendingSpawns ?? null,
      entities,
    };
  }

  buildMeta(game) {
    return {
      version: SAVE_VERSION,
      seed: game.world.seedString,
      worldTime: game.world.time,
      weather: game.dayNight?.serialize() ?? null,
      player: game.player.serialize(),
      lastSaved: Date.now(),
    };
  }

  // fire-and-forget single chunk write (unload path, 01 §16.2)
  saveChunkNow(chunk) {
    if (!this.db) return;
    const game = chunk?.gameRef ?? window.game;
    try {
      const record = this.serializeChunk(chunk, game);
      const tx = this.db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').put(record, chunk.key);
      this.savedChunkKeys.add(chunk.key);
      tx.oncomplete = () => { chunk.modified = false; };
    } catch (err) {
      console.warn('[save] chunk write failed', err);
    }
  }

  // meta + all modified chunks in one transaction (01 §16.2)
  saveAll(game, { sync = false } = {}) {
    if (!this.db || !game?.world || !game.player) return Promise.resolve();
    if (this.saving) {
      console.warn('[save] save overlapping previous — skipped');
      return Promise.resolve();
    }
    this.saving = true;
    const dirty = [];
    for (const chunk of game.world.chunks.values()) {
      if (chunk.modified && chunk.blocks) dirty.push(chunk);
    }
    return new Promise(resolve => {
      const tx = this.db.transaction(['meta', 'chunks'], 'readwrite');
      tx.objectStore('meta').put(this.buildMeta(game), 'world');
      const store = tx.objectStore('chunks');
      for (const chunk of dirty) {
        store.put(this.serializeChunk(chunk, game), chunk.key);
        this.savedChunkKeys.add(chunk.key);
      }
      tx.oncomplete = () => {
        for (const chunk of dirty) chunk.modified = false;
        this.meta = this.buildMeta(game);
        this.saving = false;
        resolve();
      };
      tx.onerror = () => { this.saving = false; resolve(); };
      tx.onabort = () => { this.saving = false; resolve(); };
    });
  }

  tick(game) {
    if (++this.autosaveCounter >= AUTOSAVE_INTERVAL) {
      this.autosaveCounter = 0;
      this.saveAll(game);   // fire-and-forget (never awaited in the loop)
    }
  }

  deleteWorld() {
    return new Promise(resolve => {
      this.db?.close();
      this.db = null;
      this.meta = null;
      this.savedChunkKeys.clear();
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }
}
