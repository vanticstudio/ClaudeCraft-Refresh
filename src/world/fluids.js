// Water/lava cellular automaton on scheduled ticks (06 §6, 01 §6.3).
// State nibble: bit3 = falling, bits0–2 = spread; source = state 0.
// Effective strength S = 8 − spread (source/falling = 8).
import { BLOCKS, B } from '../registry/blocks.js';

export const FLUID_INTERVAL = { water: 5, lava: 30 };
const FLUID_DROP = { water: 1, lava: 2 };

const H4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const FALLING = 8;

function isSource(state) { return state === 0; }

export class Fluids {
  constructor(world) {
    this.world = world;
  }

  strength(id, state, fluid) {
    const blk = BLOCKS[id];
    if (!blk || blk.fluid !== fluid) return 0;
    if (state === 0) return 8;               // source
    if (state & FALLING) return 8;           // falling column: full strength
    return 8 - (state & 7);
  }

  canReplace(id) {
    const blk = BLOCKS[id];
    if (!blk) return false;
    if (id === B.AIR || id === B.FIRE) return true;
    if (id === B.LADDER) return false;   // ladders dam fluids (06 §6.1)
    // fluid-destructible: pops with drops when flooded (06 §6.1)
    return !blk.collidable && !blk.fluid && blk.shape !== 'none';
  }

  schedule(x, y, z, fluid) {
    this.world.scheduleTick(x, y, z, FLUID_INTERVAL[fluid]);
  }

  wake(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    const blk = BLOCKS[id];
    if (blk && blk.fluid) this.schedule(x, y, z, blk.fluid);
  }

  wakeNeighbors(x, y, z) {
    this.wake(x + 1, y, z); this.wake(x - 1, y, z);
    this.wake(x, y + 1, z); this.wake(x, y - 1, z);
    this.wake(x, y, z + 1); this.wake(x, y, z - 1);
  }

  // Place fluid into a replaceable cell (pops destructibles with drops).
  setFluid(x, y, z, fluidId, state) {
    const world = this.world;
    const old = world.getBlock(x, y, z);
    if (old !== B.AIR && old !== fluidId) {
      if (BLOCKS[old].fluid) {
        // opposite fluid: interaction decides the block (§6.3)
        if (this.interact(x, y, z, fluidId, old)) return;
      } else if (this.canReplace(old)) {
        world.popBlock(x, y, z, { silent: false });
      } else {
        return;
      }
    }
    world.setBlock(x, y, z, fluidId, { state });
    const fluid = BLOCKS[fluidId].fluid;
    this.schedule(x, y, z, fluid);
  }

  // Water × lava (06 §6.3). Returns true when handled.
  interact(x, y, z, incomingId, existingId) {
    const world = this.world;
    const exState = world.getState(x, y, z);
    if (BLOCKS[existingId].fluid === 'lava' && BLOCKS[incomingId].fluid === 'water') {
      world.setBlock(x, y, z, isSource(exState) ? B.OBSIDIAN : B.COBBLESTONE);
      return true;
    }
    if (BLOCKS[existingId].fluid === 'water' && BLOCKS[incomingId].fluid === 'lava') {
      world.setBlock(x, y, z, B.STONE);   // lava flowing onto water → stone
      return true;
    }
    return false;
  }

  // Check all 6 neighbors of a just-set fluid cell for the opposite fluid.
  checkInteractions(x, y, z) {
    const world = this.world;
    const id = world.getBlock(x, y, z);
    const blk = BLOCKS[id];
    if (!blk.fluid) return;
    const state = world.getState(x, y, z);
    // water above/beside lava → lava converts
    for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const nId = world.getBlock(x + dx, y + dy, z + dz);
      const nBlk = BLOCKS[nId];
      if (!nBlk.fluid || nBlk.fluid === blk.fluid) continue;
      if (blk.fluid === 'lava' && nBlk.fluid === 'water') {
        world.setBlock(x, y, z, isSource(state) ? B.OBSIDIAN : B.COBBLESTONE);
        return;
      }
    }
  }

  // Per scheduled fluid tick at pos (06 §6.2)
  step(x, y, z) {
    const world = this.world;
    const id = world.getBlock(x, y, z);
    const blk = BLOCKS[id];
    if (!blk || !blk.fluid) return;
    const fluid = blk.fluid;
    const drop = FLUID_DROP[fluid];
    let state = world.getState(x, y, z);
    let cur = this.strength(id, state, fluid);

    if (!isSource(state)) {
      // re-derive my level from feeders
      const upId = world.getBlock(x, y + 1, z);
      const fromAbove = BLOCKS[upId].fluid === fluid;
      let best;
      if (fromAbove) {
        best = 8;
      } else {
        best = 0;
        for (const [dx, dz] of H4) {
          const nId = world.getBlock(x + dx, y, z + dz);
          const s = this.strength(nId, world.getState(x + dx, y, z + dz), fluid);
          if (s - drop > best) best = s - drop;
        }
      }
      if (best <= 0) {
        world.setBlock(x, y, z, B.AIR);
        this.wakeNeighbors(x, y, z);
        return;
      }
      const newState = fromAbove ? FALLING : (8 - best);
      if (newState !== state) {
        world.setState(x, y, z, newState);
        state = newState;
        cur = best;
        this.wakeNeighbors(x, y, z);
      }
      // infinite water: ≥ 2 adjacent sources over solid/source (06 §6.2)
      if (fluid === 'water') {
        let sources = 0;
        for (const [dx, dz] of H4) {
          if (world.getBlock(x + dx, y, z + dz) === B.WATER &&
              isSource(world.getState(x + dx, y, z + dz))) sources++;
        }
        const belowId = world.getBlock(x, y - 1, z);
        const belowSolid = BLOCKS[belowId].opaque ||
          (belowId === B.WATER && isSource(world.getState(x, y - 1, z)));
        if (sources >= 2 && belowSolid) {
          world.setState(x, y, z, 0);
          state = 0;
          cur = 8;
        }
      }
    }

    // spread
    const belowId = world.getBlock(x, y - 1, z);
    const belowBlk = BLOCKS[belowId];
    if (y > 0 && (this.canReplace(belowId) ||
        (belowBlk.fluid && belowBlk.fluid !== fluid))) {
      // can flow down → do NOT also spread sideways (06 §6.2)
      this.setFluid(x, y - 1, z, id, FALLING);
    } else if (belowBlk.collidable || belowBlk.opaque || belowBlk.fluid === fluid || y === 0) {
      const out = this.strength(id, world.getState(x, y, z), fluid) - drop;
      if (out > 0) {
        for (const [dx, dz] of H4) {
          const nx = x + dx, nz = z + dz;
          const nId = world.getBlock(nx, y, nz);
          const nBlk = BLOCKS[nId];
          if (nBlk.fluid && nBlk.fluid !== fluid) {
            this.setFluid(nx, y, nz, id, 8 - out);   // triggers interaction
            continue;
          }
          const nS = this.strength(nId, world.getState(nx, y, nz), fluid);
          if ((this.canReplace(nId) || nBlk.fluid === fluid) && nS < out) {
            this.setFluid(nx, y, nz, id, 8 - out);
          }
        }
      }
    }
    this.checkInteractions(x, y, z);
  }
}
