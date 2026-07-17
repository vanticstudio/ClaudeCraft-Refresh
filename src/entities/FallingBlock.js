// Sand/gravel falling entity (01 §6.4, 06 §5.1) + the 08 §8.6 falling anvil.
import * as THREE from 'three';
import { Entity, LivingEntity } from './Entity.js';
import { BLOCKS, B } from '../registry/blocks.js';
import { blockCubeGeometry, makeAtlasMaterial } from './ItemEntity.js';
import { emitSound, at } from '../audio/engine.js';

export class FallingBlock extends Entity {
  constructor(world, blockId, x, y, z, state = 0) {
    super(world, x, y, z);
    this.type = 'falling_block';
    this.blockId = blockId;
    // 08 §8.6/§13 — carried so an anvil re-solidifies with its damage stage.
    // Every other gravity block is state 0 and unaffected.
    this.state = state;
    this.width = 0.98; this.height = 0.98;
    // 08 §8.6 — "reuse 06 §5.1's falling-block entity with three extra fields".
    // They are inert on sand/gravel: hurtEntities false means the damage pass
    // below never runs for them.
    this.hurtEntities = blockId === B.ANVIL;
    this.perBlock = 2;
    this.maxDmg = 40;
    this.startY = y;
    this.hurtDone = new Set();
  }

  tick() {
    this.baseTick();
    this.vel.y -= 0.04;
    this.move(0, this.vel.y, 0);
    this.vel.y *= 0.98;
    if (this.hurtEntities) this.hurtOverlapping();
    if (this.onGround) {
      this.land();
    } else if (this.age > 600) {
      this.dead = true;   // safety: never fall forever
    }
  }

  /** Blocks fallen so far — the anvil's damage and degrade rolls both key off this. */
  get fallDistance() { return Math.max(0, this.startY - this.pos.y); }

  /**
   * 08 §8.6 — while falling, any LivingEntity whose AABB intersects this one
   * takes min(40, ceil((fallDistance − 1) × 2)) HP. A 4-block fall = 6 HP.
   *
   * The damage is armor-applicable and goes through hurt(), whose i-frames
   * dedupe repeat overlaps on their own; `hurtDone` additionally guarantees one
   * hit per entity per fall, so a slow anvil cannot re-hit through the i-frame
   * excess rule. Source 'anvil' maps to Protection + Blast Protection (§5.2.1).
   */
  hurtOverlapping() {
    const dmg = Math.min(this.maxDmg, Math.ceil((this.fallDistance - 1) * this.perBlock));
    if (dmg <= 0) return;
    const box = this.getAABB();
    for (const e of this.world.getEntitiesInBox(box, e => e instanceof LivingEntity && !e.dead)) {
      if (this.hurtDone.has(e)) continue;
      this.hurtDone.add(e);
      e.anvilHit = true;               // §8.6: helmets lose DOUBLE durability here
      e.hurt(dmg, 'anvil', {});
      e.anvilHit = false;
    }
  }

  land() {
    this.dead = true;
    const x = Math.floor(this.pos.x), z = Math.floor(this.pos.z);
    const y = Math.round(this.pos.y);
    const cy = Math.min(127, Math.max(0, y));
    const occupant = this.world.getBlock(x, cy, z);
    const occBlk = BLOCKS[occupant];

    let state = this.state;
    if (this.blockId === B.ANVIL) {
      // §8.6 — on landing, 5% × floor(blocksFallen) chance to degrade one stage.
      // Past stage 2 the entity dies and drops NOTHING.
      const fallen = Math.floor(this.fallDistance);
      if (this.world.rng() < 0.05 * fallen) {
        const stage = ((state >> 2) & 3) + 1;
        if (stage > 2) {
          emitSound('anvil.destroy', at(x + 0.5, cy + 0.5, z + 0.5));
          this.world.game?.particles?.blockBreak?.(x, cy, z, B.ANVIL);
          return;                       // dies, drops nothing
        }
        state = (state & ~0x0c) | (stage << 2);
      }
      emitSound('anvil.land', at(x + 0.5, cy + 0.5, z + 0.5));
    }

    if (occupant === B.AIR || occBlk.fluid) {
      this.world.setBlock(x, cy, z, this.blockId, { state });
    } else if (!occBlk.collidable) {
      // pops the flower/torch/… first (06 §5.1)
      this.world.popBlock(x, cy, z);
      this.world.setBlock(x, cy, z, this.blockId, { state });
    } else {
      // resting cell blocked → drop as item
      this.world.game?.spawnItemById(this.blockId, 1, this.pos.x, this.pos.y + 0.5, this.pos.z);
    }
  }

  buildMesh() {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(blockCubeGeometry(this.blockId, 1), makeAtlasMaterial());
    mesh.position.set(0, 0, 0);
    group.add(mesh);
    return group;
  }

  serialize() {
    // written back as solid blocks on save (06 §18) — handled by saveManager;
    // record kept for in-session chunk moves
    return { type: 'falling_block', blockId: this.blockId, state: this.state, ...super.serialize() };
  }
}
