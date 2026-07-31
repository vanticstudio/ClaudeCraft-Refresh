// IndexedDB persistence (01 §16): meta + modified chunks only.
import { DB_NAME, DB_VERSION, SAVE_VERSION, AUTOSAVE_INTERVAL } from '../constants.js';

export class SaveManager {
  constructor() {
    this.db = null;
    this.meta = null;
    this.savedChunkKeys = new Set();
    // 17-SHIP §1.6 — set when IndexedDB is unavailable (private mode, blocked
    // storage). main.js toasts it; the session runs, it just never persists.
    this.unavailable = false;
    this.autosaveCounter = 0;
    this.saving = false;
    // 10-NETHER §2.4 — the dimension whose chunks are currently resident. Game
    // updates this on changeDimension so hasChunk/loadChunk prefix correctly.
    this.activeDim = 0;
  }

  /** 10-NETHER §2.4 — the dim-prefixed store key for a chunk. */
  keyFor(bareKey, dim) { return dim + ':' + bareKey; }

  open() {
    return new Promise(resolve => {
      // 17-SHIP §1.6 — blocked storage must DEGRADE, not abort the boot: a
      // rejection here left `await save.open()` unhandled in main.js and the
      // player looking at a blank page. Resolve with an unusable-but-valid
      // manager instead; every write path already guards on `this.db`.
      const bail = err => {
        console.warn('[save] storage unavailable — this session will not persist', err);
        this.db = null; this.meta = null; this.unavailable = true;
        this.savedChunkKeys.clear();
        resolve(this);
      };
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { bail(err); return; }
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
        tx.onerror = () => bail(tx.error);
      };
      req.onerror = () => bail(req.error);
    });
  }

  hasWorld() { return this.meta !== null; }
  hasChunk(key) { return this.savedChunkKeys.has(this.keyFor(key, this.activeDim)); }

  // 01 §16.2 — contract is "resolve(null) on failure, never reject". db.transaction()
  // throws synchronously (InvalidStateError) if the connection was closed under us —
  // a UA storage eviction or tab discard — which rejected the promise straight past
  // the null path every other error here takes. Catch it and honour the contract.
  loadChunk(key) {
    if (!this.db) return Promise.resolve(null);
    return new Promise(resolve => {
      try {
        const tx = this.db.transaction('chunks', 'readonly');
        const req = tx.objectStore('chunks').get(this.keyFor(key, this.activeDim));
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
        tx.onerror = tx.onabort = () => resolve(null);
      } catch { resolve(null); }
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
      // 09-POTIONS §16 / DEVIATIONS §09.3 — in-flight thrown potions AND their lingering
      // clouds are deliberately dropped on save. area_effect_cloud was persisted
      // anyway but has no restore branch (Game.restoreEntity fell through to
      // createMob → "unknown type" warn every reload), and its serialize() omits
      // effectPayload/radiusOnUse/radiusPerTick so a rehydrated cloud would come back
      // inert and shrink at the wrong rate. Skip the write to match the decision.
      if (rec && rec.type && rec.type !== 'player' && rec.type !== 'arrow' &&
          rec.type !== 'area_effect_cloud' && !rec.type.startsWith('thrown')) {
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
    const game = this.game ?? (typeof window !== 'undefined' ? window.game : null);
    if (!game) return;
    if (game.net?.isClient) return;   // 14 §9.1 — see saveAll: clients persist no world data

    try {
      const record = this.serializeChunk(chunk, game);
      const key = this.keyFor(chunk.key, chunk.dim);
      const tx = this.db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').put(record, key);
      this.savedChunkKeys.add(key);
      // AMENDS 01 §16.2 ("clears only on oncomplete") — put() takes the structured
      // clone SYNCHRONOUSLY, so an edit landing before the commit would be cleared
      // by oncomplete yet absent from the record on disk, and never rewritten.
      // Clear at clone time; restore the flag only if the write fails to land.
      chunk.modified = false;
      tx.onerror = tx.onabort = () => { chunk.modified = true; };
    } catch (err) {
      console.warn('[save] chunk write failed', err);
    }
  }

  // meta + all modified chunks in one transaction (01 §16.2).
  // Resolves true on commit, false on a failed/aborted transaction, undefined when
  // there was nothing to do (client / no db / overlapping save). 17-SHIP §1.4 — the
  // old `{ sync }` option was dead (IndexedDB has no synchronous API; see
  // DEVIATIONS L-6) and has been deleted rather than left advertising a quit-path
  // flush that never existed.
  saveAll(game) {
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
      // `saving` must be releasable on EVERY exit. It used to be cleared after
      // `this.meta = this.buildMeta(game)` in oncomplete, so a Save & Quit that
      // disposed the world while the transaction was in flight made buildMeta throw
      // on `game.world.seedString` and latched the flag true for the page session —
      // every later autosave/quit/portal checkpoint then wrote nothing.
      let settled = false;
      const fail = err => {
        if (settled) return;
        settled = true;
        console.warn('[save] transaction failed', err);
        for (const chunk of dirty) chunk.modified = true;   // rewrite them next pass
        this.saving = false;
        resolve(false);
      };
      try {
        const tx = this.db.transaction(['meta', 'chunks'], 'readwrite');
        tx.objectStore('meta').put(this.buildMeta(game), 'world');
        const store = tx.objectStore('chunks');
        for (const chunk of dirty) {
          const key = this.keyFor(chunk.key, chunk.dim);
          store.put(this.serializeChunk(chunk, game), key);
          this.savedChunkKeys.add(key);
          chunk.modified = false;   // at clone time — see saveChunkNow
        }
        tx.oncomplete = () => {
          settled = true;
          // the world may already be disposed (quit racing the commit)
          try {
            if (game.world && game.player) this.meta = this.buildMeta(game);
          } catch (err) { console.warn('[save] meta refresh failed', err); }
          this.saving = false;
          resolve(true);
        };
        tx.onerror = () => fail(tx.error);
        tx.onabort = () => fail(tx.error);
      } catch (err) {
        // db.transaction() after a versionchange close, or a throwing serialize()
        fail(err);
      }
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
      this.saving = false;   // a save in flight against the closed db can never settle
      this.savedChunkKeys.clear();
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }
}
