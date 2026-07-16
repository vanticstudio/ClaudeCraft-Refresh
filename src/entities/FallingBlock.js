// Sand/gravel falling entity (01 §6.4, 06 §5.1).
import * as THREE from 'three';
import { Entity } from './Entity.js';
import { BLOCKS, B } from '../registry/blocks.js';
import { blockCubeGeometry, makeAtlasMaterial } from './ItemEntity.js';

export class FallingBlock extends Entity {
  constructor(world, blockId, x, y, z) {
    super(world, x, y, z);
    this.type = 'falling_block';
    this.blockId = blockId;
    this.width = 0.98; this.height = 0.98;
  }

  tick() {
    this.baseTick();
    this.vel.y -= 0.04;
    this.move(0, this.vel.y, 0);
    this.vel.y *= 0.98;
    if (this.onGround) {
      this.land();
    } else if (this.age > 600) {
      this.dead = true;   // safety: never fall forever
    }
  }

  land() {
    this.dead = true;
    const x = Math.floor(this.pos.x), z = Math.floor(this.pos.z);
    const y = Math.round(this.pos.y);
    const cy = Math.min(127, Math.max(0, y));
    const occupant = this.world.getBlock(x, cy, z);
    const occBlk = BLOCKS[occupant];
    if (occupant === B.AIR || occBlk.fluid) {
      this.world.setBlock(x, cy, z, this.blockId);
    } else if (!occBlk.collidable) {
      // pops the flower/torch/… first (06 §5.1)
      this.world.popBlock(x, cy, z);
      this.world.setBlock(x, cy, z, this.blockId);
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
    return { type: 'falling_block', blockId: this.blockId, ...super.serialize() };
  }
}
