// Entity bookkeeping: ids, per-chunk spatial index, tick/render dispatch (01 §13.2).
import { chunkKey, SIM_RADIUS } from '../constants.js';
import { ChunkState } from '../world/Chunk.js';

export class EntityManager {
  constructor(world, scene) {
    this.world = world;
    this.scene = scene;
    this.entities = new Map();     // id → Entity, insertion order = tick order
    this.nextId = 1;
  }

  add(entity) {
    entity.id = this._allocId();
    this.entities.set(entity.id, entity);
    this.register(entity);
    return entity;
  }

  // 14 AMENDS 01 §13.2 — ids allocate from a wrapping u16 counter skipping live
  // ids (host-authoritative). Clients add puppets under their own local ids but
  // track the host id separately (entity.netId).
  _allocId() {
    for (let i = 0; i < 65535; i++) {
      this.nextId = (this.nextId % 65535) + 1;   // 1..65535, never 0
      if (!this.entities.has(this.nextId)) return this.nextId;
    }
    return this.nextId;
  }

  register(entity) {
    const key = chunkKey(Math.floor(entity.pos.x) >> 4, Math.floor(entity.pos.z) >> 4);
    if (key === entity.chunkKey) return;
    if (entity.chunkKey) {
      const old = this.world.chunks.get(entity.chunkKey);
      old?.entities.delete(entity);
    }
    entity.chunkKey = key;
    const chunk = this.world.chunks.get(key);
    chunk?.entities.add(entity);
  }

  tick(player) {
    const game = this.world.game;
    // 14 AMENDS 01 §13.2 — every player entity ticks separately (local in Game.tick,
    // remotes in NetHost.tickRemotePlayers) but must stay spatially indexed.
    if (game?.eachPlayer) game.eachPlayer(pl => this.register(pl));
    else if (player) this.register(player);
    // 14 AMENDS 01 §6.2 — sim range is the UNION of every player's SIM_RADIUS.
    const centers = game?.playerChunkCenters ? game.playerChunkCenters() : (this.world.playerChunk ? [this.world.playerChunk] : []);
    const isPlayer = e => game ? game.isPlayer(e) : e === player;
    for (const entity of this.entities.values()) {
      if (isPlayer(entity)) continue;
      if (entity.dead) {
        // death animation still advances (mobs keel over 20 ticks, 05 §16.3)
        if (entity.deathAnimTicks) entity.deathTime++;
        continue;
      }
      // 11-END AMENDS 01 §13.2 — reap any non-player entity that falls into the
      // void floor (below Y −64). Covers items/mobs/projectiles knocked off End
      // islands regardless of their own per-class kill plane.
      if (entity.pos.y < -64 && !entity.isBoss) { entity.dead = true; entity.deathTime = entity.deathAnimTicks ?? 0; continue; }
      // 13-BOSSES AMENDS 05 §1 — bosses always run full AI (never frozen by range/
      // chunk-gen), so a wither ticks even when the player is off in the arena.
      const ecx = Math.floor(entity.pos.x) >> 4, ecz = Math.floor(entity.pos.z) >> 4;
      if (!entity.isBoss) {
        // freeze outside every player's SIM_RADIUS or in ungenerated chunks (01 §12/§13.2)
        let near = false;
        for (const c of centers) { if (Math.max(Math.abs(ecx - c.cx), Math.abs(ecz - c.cz)) <= SIM_RADIUS) { near = true; break; } }
        if (!near) continue;
        const chunk = this.world.chunks.get(chunkKey(ecx, ecz));
        if (!chunk || chunk.state < ChunkState.GENERATED) continue;
      }
      entity.tick();
      this.register(entity);
    }
    // reap after the entity pass
    for (const entity of this.entities.values()) {
      if (!entity.dead) continue;
      // 14 — a dead PLAYER is never auto-reaped: it stays in the manager (frozen,
      // out of the snapshot interest set) so it can respawn in place. It is removed
      // only explicitly on disconnect (removeNetPlayer). Otherwise a respawn would
      // find no host entity for that player.
      if (isPlayer(entity)) continue;
      if (entity.deathTime < (entity.deathAnimTicks ?? 0)) continue;
      this.remove(entity);
    }
  }

  remove(entity) {
    this.entities.delete(entity.id);
    if (entity.chunkKey) {
      this.world.chunks.get(entity.chunkKey)?.entities.delete(entity);
      entity.chunkKey = null;
    }
    if (entity.object3d) {
      this.scene.remove(entity.object3d);
      entity.object3d.traverse(o => {
        if (!o.isMesh || !o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (!m.userData?.shared) m.dispose();
      });
      entity.object3d = null;
    }
    entity.onRemoved?.();
  }

  updateRender(alpha, player) {
    for (const entity of this.entities.values()) {
      if (entity === player) continue;
      if (entity.needsMeshRebuild && entity.object3d) {
        this.scene.remove(entity.object3d);
        entity.object3d = null;
        entity.needsMeshRebuild = false;
      }
      if (!entity.object3d) {
        const mesh = entity.buildMesh();
        if (mesh) {
          entity.object3d = mesh;
          this.scene.add(mesh);
        }
      }
      entity.updateRender(alpha);
    }
  }

  // Chunks overlapped by the box ± 1 chunk margin (01 §13.2)
  getEntitiesInBox(box, filter) {
    const out = [];
    const cx0 = (Math.floor(box.min[0]) >> 4) - 1, cx1 = (Math.floor(box.max[0]) >> 4) + 1;
    const cz0 = (Math.floor(box.min[2]) >> 4) - 1, cz1 = (Math.floor(box.max[2]) >> 4) + 1;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const chunk = this.world.chunks.get(chunkKey(cx, cz));
        if (!chunk) continue;
        for (const e of chunk.entities) {
          if (e.dead) continue;
          if (filter && !filter(e)) continue;
          if (box.intersects(e.getAABB())) out.push(e);
        }
      }
    }
    return out;
  }

  count(filter) {
    let n = 0;
    for (const e of this.entities.values()) if (!e.dead && (!filter || filter(e))) n++;
    return n;
  }

  // Unloading a chunk discards its entities (01 §13.2); caller excludes player.
  // 13-BOSSES — a chunk-resident boss (the wither) is SAVED with its chunk first
  // (ChunkManager flushes before this) and then removed like any entity, so it
  // re-hydrates on reload (§10.2 "freezes while unloaded") instead of duplicating.
  // The ender dragon is NOT a chunk entity (it lives in endFight); its transient
  // DragonParts (isDragonPart) are re-created by the dragon each tick, so reaping
  // them here is harmless.
  onChunkUnloading(chunk, player) {
    const game = this.world.game;
    for (const e of [...chunk.entities]) {
      // 14 AMENDS 01 §13.2 — chunk-unload discard never applies to any player.
      if (game ? game.isPlayer(e) : e === player) continue;
      e.deathTime = 0;
      e.dead = true;
      this.remove(e);
    }
  }
}
