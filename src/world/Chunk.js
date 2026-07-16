// Chunk: 16×128×16 column of voxels (01 §4.2).
import { CHUNK_CELLS } from '../constants.js';

// REQUESTED → GENERATED → LIT → MESHED (01 §4.4). FAILED = worker error twice.
export const ChunkState = {
  REQUESTED: 0,
  GENERATED: 1,
  LIT: 2,
  MESHED: 3,
  FAILED: -1,
};

export class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.key = cx + ',' + cz;
    this.blocks = null;                  // Uint8Array(32768), installed at GENERATED
    this.states = null;                  // Uint8Array(32768) per-voxel state nibble
    this.skyLight = null;                // Uint8Array(32768) 0–15
    this.blockLight = null;              // Uint8Array(32768) 0–15
    this.heightMap = null;               // Uint8Array(256): (z<<4)|x → y+1 of top sky-terminating block
    this.biomes = null;                  // Uint8Array(256) biome ids (02 §6.1)
    this.state = ChunkState.REQUESTED;
    this.dirty = false;                  // needs remesh
    this.modified = false;               // differs from generator output → must save
    this.blockEntities = new Map();      // blockIndex → {type:'furnace'|'chest', data}
    this.entities = new Set();           // entities whose feet are in this chunk
    this.group = null;                   // THREE.Group at (cx*16, 0, cz*16)
    this.meshes = { opaque: null, cutout: null, water: null };
    this.minY = 0;                       // tight Y bounds from last mesh build
    this.maxY = 127;
    this.pendingSpawns = null;           // worldgen herd records, consumed on load (02 §11)
    this.spawnsDone = false;
  }

  install(blocks, heightMap, biomes, states = null) {
    this.blocks = blocks;
    this.states = states || new Uint8Array(CHUNK_CELLS);
    this.skyLight = new Uint8Array(CHUNK_CELLS);
    this.blockLight = new Uint8Array(CHUNK_CELLS);
    this.heightMap = heightMap;
    this.biomes = biomes;
    this.state = ChunkState.GENERATED;
  }
}
