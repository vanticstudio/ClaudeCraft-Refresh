// IndexedDB persistence (01 §16): meta + modified chunks only.
import { DB_NAME, DB_VERSION, SAVE_VERSION, AUTOSAVE_INTERVAL } from '../constants.js';

export class SaveManager {
  constructor() {
    this.db = null;
    this.savedChunkKeys = new Set();
    this.meta = null;
    this.savedChunkKeys = new Set();
    this.autosaveCounter = 0;
    this.saving = false;
    // 10-NETHER §2.4 — the dimension whose chunks are currently resident. Game
    // updates this on changeDimension so hasChunk/loadChunk prefix correctly.
    this.activeDim = 0;
  }

  /** 10-NETHER §2.4 — the dim-prefixed store key for a chunk. */
  keyFor(bareKey, dim) { return dim + ':' + bareKey; }

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
          // Seed the key set FIRST so migrate()'s clear() isn't overwritten by the
          // stale pre-clear keys read above (order matters — see §8.5).
          this.savedChunkKeys = new Set(keysReq.result ?? []);
          // 10-NETHER §2.4 / CLAUDE.md §8.5 — MIGRATE forward instead of nulling
          // meta (which discarded the whole world and broke every future bump).
          if (this.meta && this.meta.version !== SAVE_VERSION) {
            this.migrate(this.meta);
          }
          resolve(this);
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  hasWorld() { return this.meta !== null; }
  hasChunk(key) { return this.savedChunkKeys.has(this.keyFor(key, this.activeDim)); }

  loadChunk(key) {
    return new Promise(resolve => {
      const tx = this.db.transaction('chunks', 'readonly');
      const req = tx.objectStore('chunks').get(this.keyFor(key, this.activeDim));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  }

  /**
   * CLAUDE.md §8.5 — the v1→v2 migration. v1 chunk keys were bare "cx,cz" (dim 0
   * implied) and meta had no dimension fields. Per the phase prompt we CLEAR the
   * chunk store (the overworld regenerates deterministically from the seed) and
   * up-convert meta so the player — inventory, position — survives the bump.
   * Runs synchronously against the already-open db.
   */
  migrate(meta) {
    if (meta.version < 2) {
      try {
        const tx = this.db.transaction('chunks', 'readwrite');
        tx.objectStore('chunks').clear();
      } catch (err) { console.warn('[save] migration chunk-clear failed', err); }
      this.savedChunkKeys.clear();
      if (meta.player) meta.player.dimension = 0;
      meta.dimensions = meta.dimensions ?? {};
      console.warn('[save] migrated v' + meta.version + ' → v2 (chunk store cleared; player preserved)');
    }
    // 14-MULTIPLAYER §2.4 — v2→v3 is NON-destructive: wrap the single `player` under
    // the host's own playerId in a `players` map (chunks untouched). Composes with
    // the v1 branch above (a v1 save runs both). This.hostId is set by main.js.
    if (meta.version < 3 && !meta.players) {
      const hostId = this.hostId || 'host';
      meta.players = {};
      if (meta.player) {
        meta.players[hostId] = { ...meta.player, name: meta.player.name || 'Player', lastSeen: 0 };
        delete meta.player;
      }
      console.warn('[save] migrated → v3 (player → players[' + hostId + '])');
    }
    meta.version = SAVE_VERSION;
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
      // 12-VILLAGES §2.7 — persist the village record (incl. golem timer) with the
      // anchor chunk. Deterministic gen would rebuild layout, but not runtime state.
      villageMeta: chunk.villageMeta ?? null,
      entities,
    };
  }

  buildMeta(game) {
    return {
      version: SAVE_VERSION,
      seed: game.world.seedString,
      worldTime: game.world.time,
      weather: game.dayNight?.serialize() ?? null,
      // 14-MULTIPLAYER AMENDS 01 §16 — per-player records keyed by playerId
      // (host + every known client, connected or last-seen). Replaces `player`.
      players: game.buildPlayerRecords(),
      // 10-NETHER §2.4 — per-dimension blob (portal links §3.6, fortress registry
      // §5, and 11's End-fight record live here).
      dimensions: game.dimMeta ?? {},
      lastSaved: Date.now(),
    };
  }

  // fire-and-forget single chunk write (unload path, 01 §16.2)
  saveChunkNow(chunk) {
    if (!this.db) return;
    // 17-SHIP §1.6 — `window.game` is set ONLY in DEV (Game.js:118), so a
    // production build reached serializeChunk(chunk, undefined) here and threw on
    // every chunk-unload / dimension-flush write → silent chunk loss. `this.game`
    // is wired in startWorld and is the authoritative source in every build.
    const game = chunk?.gameRef ?? this.game ?? (typeof window !== 'undefined' ? window.game : null);
    if (!game) return;
    if (game.net?.isClient) return;   // 14 §9.1 — see saveAll: clients persist no world data

    try {
      const record = this.serializeChunk(chunk, game);
      const key = this.keyFor(chunk.key, chunk.dim);
      const tx = this.db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').put(record, key);
      this.savedChunkKeys.add(key);
      tx.oncomplete = () => { chunk.modified = false; };
    } catch (err) {
      console.warn('[save] chunk write failed', err);
    }
  }

  // meta + all modified chunks in one transaction (01 §16.2)
  saveAll(game, { sync = false } = {}) {
    // 14 §9.1 — "Clients save nothing but localStorage identity/settings." A joined
    // client's world is the HOST's, replicated over the wire; writing its chunks and
    // meta into THIS browser's IndexedDB overwrites the player's own single-player
    // save with someone else's world. Per-player state is the host's responsibility
    // (§2.4 meta.players). Host and solo sessions have no net.isClient and save normally.
    if (game?.net?.isClient) return Promise.resolve();
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
        const key = this.keyFor(chunk.key, chunk.dim);
        store.put(this.serializeChunk(chunk, game), key);
        this.savedChunkKeys.add(key);
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
