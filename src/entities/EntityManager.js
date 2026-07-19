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
    entity.id = this.nextId++;
    this.entities.set(entity.id, entity);
    this.register(entity);
    return entity;
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
    const p = this.world.playerChunk;
    if (player) this.register(player);   // player ticks separately but must stay indexed
    for (const entity of this.entities.values()) {
      if (entity === player) continue;
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
        // freeze outside SIM_RADIUS or in ungenerated chunks (01 §12/§13.2)
        if (p && Math.max(Math.abs(ecx - p.cx), Math.abs(ecz - p.cz)) > SIM_RADIUS) continue;
        const chunk = this.world.chunks.get(chunkKey(ecx, ecz));
        if (!chunk || chunk.state < ChunkState.GENERATED) continue;
      }
      entity.tick();
      this.register(entity);
    }
    // reap after the entity pass
    for (const entity of this.entities.values()) {
      if (!entity.dead) continue;
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
    for (const e of [...chunk.entities]) {
      if (e === player) continue;
      e.deathTime = 0;
      e.dead = true;
      this.remove(e);
    }
  }
}
