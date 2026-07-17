// Per-dimension generator table (10 §2.2). PURE and worker-safe.
//
// Why this is not on the dimension descriptor in world/dimensions.js, as 10 §2.1
// draws it: that module constructs a DimensionState, which owns an EntityManager
// and a Fluids — and `world/fluids.js` imports `audio/engine.js`, which builds an
// AudioContext at module scope. Importing the descriptor table into the worker
// would therefore construct an AudioContext off the main thread and throw. The
// descriptor keeps every field an existing system reads (§2.1); only `gen` moves
// here, where the worker can reach it without dragging the engine along.
//
// Logged in DEVIATIONS.md. The observable contract is unchanged: one dim id → one
// pure generator, resolved by the worker on each `generate` message.
import { createGenerator } from './terrain.js';
import { createNetherGenerator } from './nether.js';

export const DIM_OVERWORLD = 0;
export const DIM_NETHER = 1;
export const DIM_END = 2;

/**
 * Build the generator for one dimension. Each worker calls this lazily per dim
 * it is asked to generate, so a session that never enters the Nether never pays
 * for its noise instances.
 */
export function createGeneratorFor(dim, seed) {
  switch (dim) {
    case DIM_OVERWORLD: return createGenerator(seed);
    case DIM_NETHER: return createNetherGenerator(seed);
    // dim 2 (End) is registered by 11-END; it plugs its generator in here.
    default:
      console.warn('[dimGen] no generator for dimension', dim, '— falling back to overworld');
      return createGenerator(seed);
  }
}
