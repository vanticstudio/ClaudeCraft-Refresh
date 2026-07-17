// Water/lava cellular automaton on scheduled ticks (06 §6, 01 §6.3).
// State nibble: bit3 = falling, bits0–2 = spread; source = state 0.
// Effective strength S = 8 − spread (source/falling = 8).
import { BLOCKS, B, WATERLOGGED, STATE_NIBBLE, isWaterCellAt, isWaterSourceAt } from '../registry/blocks.js';
import { emitSound, at } from '../audio/engine.js';

// 01 §6.3 fluid mix: hiss + the stone-family place, per 16 §5.2.
function emitQuench(x, y, z) {
  emitSound('block.extinguish', at(x + 0.5, y + 0.5, z + 0.5));
  emitSound('block.place.stone', at(x + 0.5, y + 0.5, z + 0.5));
}

export const FLUID_INTERVAL = { water: 5, lava: 30 };
const FLUID_DROP = { water: 1, lava: 2 };

const H4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const FALLING = 8;

// 15 §8: mask the nibble. A bare `state === 0` reads FALSE on a waterlogged cell
// (state 0x80) — which is exactly how a soaked fence used to fall through to the
// re-derive branch and get deleted by the `best <= 0` path below.
function isSource(state) { return (state & STATE_NIBBLE) === 0; }

export class Fluids {
  constructor(world) {
    this.world = world;
  }

  /** 15 §11.1 — S(cell) = 8 if bit 7, else base 06 §6.2 rules. */
  strength(id, state, fluid) {
    // A waterlogged cell is a full-strength WATER source whatever its id is.
    if (fluid === 'water' && (state & WATERLOGGED)) return 8;
    const blk = BLOCKS[id];
    if (!blk || blk.fluid !== fluid) return 0;
    if (isSource(state)) return 8;           // source
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
    if (blk && blk.fluid) { this.schedule(x, y, z, blk.fluid); return; }
    // 15 §11.1: waterlogged cells receive scheduled fluid ticks like water cells.
    // Without this a bit-7 fence is invisible to wakeNeighbors (no `.fluid`) and
    // could never re-spread after a neighbor opened up.
    if (this.world.getState(x, y, z) & WATERLOGGED) this.schedule(x, y, z, 'water');
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
      emitQuench(x, y, z);
      return true;
    }
    if (BLOCKS[existingId].fluid === 'water' && BLOCKS[incomingId].fluid === 'lava') {
      world.setBlock(x, y, z, B.STONE);   // lava flowing onto water → stone
      emitQuench(x, y, z);
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
    // water above/beside lava → lava converts.
    // 15 §11.3: a bit-7 neighbor counts as "touched by water", so a waterlogged
    // fence turns adjacent flowing lava to cobblestone / a lava source to
    // obsidian. The conversion happens in the LAVA cell and reads the LAVA
    // cell's own state, so the source/flowing split below is already correct —
    // and the waterlogged block itself is never touched (§11.3's "never
    // converted to stone"), because this only ever writes at (x,y,z).
    for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      const nId = world.getBlock(nx, ny, nz);
      const nBlk = BLOCKS[nId];
      const nWater = isWaterCellAt(nId, world.getState(nx, ny, nz));
      if (!nWater && (!nBlk.fluid || nBlk.fluid === blk.fluid)) continue;
      if (blk.fluid === 'lava' && nWater) {
        // The path that fires for the common player action (pouring water beside
        // or above lava) — hooking interact() alone misses it silently.
        world.setBlock(x, y, z, isSource(state) ? B.OBSIDIAN : B.COBBLESTONE);
        emitQuench(x, y, z);
        return;
      }
    }
  }

  // Per scheduled fluid tick at pos (06 §6.2)
  step(x, y, z) {
    const world = this.world;
    const id = world.getBlock(x, y, z);
    const blk = BLOCKS[id];
    let state = world.getState(x, y, z);
    // 15 §11.1 — a waterlogged cell is forced onto the water track: its id
    // (fence/ladder/chest) has no `.fluid`, so the base guard would drop it here
    // and its water would never spread.
    const logged = (state & WATERLOGGED) !== 0;
    if (!logged && (!blk || !blk.fluid)) return;
    const fluid = logged ? 'water' : blk.fluid;
    const drop = FLUID_DROP[fluid];
    let cur = this.strength(id, state, fluid);
    // The id used for anything this cell POURS OUT. A bit-7 fence must spread
    // WATER, not replicate fences — the base code spreads `id` verbatim.
    const outId = logged ? B.WATER : id;

    // 15 §11.1: waterlogged cells NEVER run the re-derive branch — they are
    // unconditionally sources and can only change via §10.5/§10.6. Letting one
    // in here is fatal: the `best <= 0` path calls setBlock(AIR) and deletes the
    // block itself.
    if (!logged && !isSource(state)) {
      // re-derive my level from feeders.
      // 15 §11.1: a bit-7 cell above IS a full-strength water source, so it must
      // count as a feeder. A bare `.fluid` test misses it (a fence has no
      // `.fluid`), and the cell below then finds no feeder, hits `best <= 0` and
      // deletes itself — the column under any waterlogged block would blink out
      // every 5 ticks instead of falling.
      const upId = world.getBlock(x, y + 1, z);
      const fromAbove = fluid === 'water'
        ? isWaterCellAt(upId, world.getState(x, y + 1, z))
        : BLOCKS[upId].fluid === fluid;
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
      // infinite water: ≥ 2 adjacent sources over solid/source (06 §6.2).
      // 15 §11.2 — adjacentSources counts bit-7 neighbors and solidOrSource
      // accepts a bit-7 cell below, so two waterlogged fences flanking a water
      // cell over solid ground mint a source between them (vanilla parity).
      if (fluid === 'water') {
        let sources = 0;
        for (const [dx, dz] of H4) {
          if (isWaterSourceAt(world.getBlock(x + dx, y, z + dz),
                              world.getState(x + dx, y, z + dz))) sources++;
        }
        const belowId = world.getBlock(x, y - 1, z);
        const belowSolid = BLOCKS[belowId].opaque ||
          isWaterSourceAt(belowId, world.getState(x, y - 1, z));
        if (sources >= 2 && belowSolid) {
          world.setState(x, y, z, 0);
          state = 0;
          cur = 8;
        }
      }
    }

    // spread — 15 §11.1: a waterlogged cell runs ONLY this branch. Flow down
    // into canReplace cells (falling, full strength) else spread S-1 = 7 sideways.
    const belowId = world.getBlock(x, y - 1, z);
    const belowBlk = BLOCKS[belowId];
    if (y > 0 && (this.canReplace(belowId) ||
        (belowBlk.fluid && belowBlk.fluid !== fluid))) {
      // can flow down → do NOT also spread sideways (06 §6.2)
      this.setFluid(x, y - 1, z, outId, FALLING);
    } else if (belowBlk.collidable || belowBlk.opaque || belowBlk.fluid === fluid ||
               (world.getState(x, y - 1, z) & WATERLOGGED) || y === 0) {
      const out = this.strength(id, world.getState(x, y, z), fluid) - drop;
      if (out > 0) {
        for (const [dx, dz] of H4) {
          const nx = x + dx, nz = z + dz;
          const nId = world.getBlock(nx, y, nz);
          const nBlk = BLOCKS[nId];
          if (nBlk.fluid && nBlk.fluid !== fluid) {
            this.setFluid(nx, y, nz, outId, 8 - out);   // triggers interaction
            continue;
          }
          const nS = this.strength(nId, world.getState(nx, y, nz), fluid);
          if ((this.canReplace(nId) || nBlk.fluid === fluid) && nS < out) {
            this.setFluid(nx, y, nz, outId, 8 - out);
          }
        }
      }
    }
    this.checkInteractions(x, y, z);
  }
}
