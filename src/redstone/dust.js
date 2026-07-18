// 07-REDSTONE §4 — redstone dust: the connection graph (§4.2), which drives
// both the network solver (§5.2) and the mesher, and the "what does a dust cell
// power" question (§3.3 / §4.4). Connection shape is NOT stored — always
// recomputed from neighbours.

import { BLOCKS, B } from '../registry/blocks.js';
import { H4 } from './dirs.js';

const isWire = (world, x, y, z) => world.getBlock(x, y, z) === B.REDSTONE_WIRE;
const isConductive = (world, x, y, z) => !!BLOCKS[world.getBlock(x, y, z)]?.conductive;

/**
 * §4.2 `attracts` — does dust visually + electrically hook to the block at the
 * neighbour cell in horizontal direction [dx,dz]? Redstone torch, lever,
 * buttons, plates, redstone block, observer (back face only), and
 * repeater/comparator (along their axis only). Dust NEVER attracts to
 * pistons/lamps/note blocks/containers — you must point a real connection at
 * those or run the dust over an adjacent conductive block.
 */
function attracts(world, nx, ny, nz, dx, dz) {
  const id = world.getBlock(nx, ny, nz);
  const st = world.getState(nx, ny, nz);
  switch (id) {
    case B.REDSTONE_TORCH:
    case B.LEVER:
    case B.STONE_BUTTON:
    case B.WOODEN_BUTTON:
    case B.STONE_PRESSURE_PLATE:
    case B.WOODEN_PRESSURE_PLATE:
    case B.REDSTONE_BLOCK:
      return true;
    case B.OBSERVER: {
      // back face only: the output side (opposite the watched dir). Watched dir
      // is FACE6 in bits0-2; the back points opposite. Dust attaches only when
      // it approaches the back face — i.e. the vector from the observer to the
      // dust equals the back direction. From the dust's frame, the observer is
      // at [nx], so the connection dir toward it is [dx,dz]; the observer's back
      // faces [-dx,-dz]... we hook if the observer's OUTPUT points at us.
      const face = st & 0x07;
      const backX = [0, 0, 0, 0, 1, -1][face] ?? 0;   // FACE6_OPP dir X (2/3 N/S have 0)
      const backZ = [0, 0, 1, -1, 0, 0][face] ?? 0;   // back Z for N/S faces
      // observer back cell = observer + back; dust connects if it sits in that cell,
      // i.e. dust = observer + back  ⇔  [-dx,-dz] === back
      return backX === -dx && backZ === -dz;
    }
    case B.REPEATER:
    case B.COMPARATOR: {
      // front or back along the HFACE axis only (never the sides).
      const hf = st & 0x03;
      const axisX = [0, 1, 0, -1][hf];
      const axisZ = [-1, 0, 1, 0][hf];
      // dust connects if it lies on the diode's axis (either the faced or rear cell)
      return (dx === axisX && dz === axisZ) || (dx === -axisX && dz === -axisZ);
    }
    default:
      return false;
  }
}

export const CONN = { NONE: 0, LEVEL: 1, UP_SLOPE: 2, DOWN_SLOPE: 3 };

/**
 * §4.2 connects(p, d) for one horizontal direction. Returns a CONN kind.
 * A conductive block sitting on top of the dust blocks UP_SLOPE through this cell.
 */
export function connects(world, x, y, z, dx, dz) {
  const nx = x + dx, nz = z + dz;
  if (isWire(world, nx, y, nz)) return CONN.LEVEL;
  // UP_SLOPE: wire one up on the neighbour column, provided the cell above US is
  // not conductive (it would cap the slope).
  if (isWire(world, nx, y + 1, nz) && !isConductive(world, x, y + 1, z)) return CONN.UP_SLOPE;
  // DOWN_SLOPE: wire one down, provided the neighbour cell itself is not
  // conductive (dust drops over the edge, not through a block).
  if (isWire(world, nx, y - 1, nz) && !isConductive(world, nx, y, nz)) return CONN.DOWN_SLOPE;
  if (attracts(world, nx, y, nz, dx, dz)) return CONN.LEVEL;
  return CONN.NONE;
}

/**
 * The 4 connection results for a dust cell, in HFACE order (N,E,S,W).
 * Used by both the mesher (shape) and the solver (graph edges).
 */
export function dustConnections(world, x, y, z) {
  const out = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) out[i] = connects(world, x, y, z, H4[i][0], H4[i][2]);
  return out;
}

/**
 * §3.3 / §4.4 — the horizontal cells a dust cell powers ("points into").
 * A dust with zero real connections renders and BEHAVES as a cross (§4.2), so it
 * points into all 4; otherwise it points into exactly its connected directions.
 * Returns an array of [dx, 0, dz] vectors.
 */
export function dustOutputDirs(world, x, y, z) {
  const conns = dustConnections(world, x, y, z);
  const on = [conns[0] !== CONN.NONE, conns[1] !== CONN.NONE, conns[2] !== CONN.NONE, conns[3] !== CONN.NONE];
  const count = on[0] + on[1] + on[2] + on[3];
  // §4.2 rendered ARMS = power-output directions. A single connection renders as
  // a straight LINE along that axis (§4.2), so it powers BOTH ends — this is how
  // a dust line pointing at a solid block weakly powers it. 0 connections → cross
  // → all 4. Otherwise the connected arms.
  if (count === 0) return H4.map(d => [d[0], 0, d[2]]);
  if (count === 1) {
    const i = on[0] ? 0 : on[1] ? 1 : on[2] ? 2 : 3;
    const opp = (i + 2) & 3;                       // the same axis, other way
    return [[H4[i][0], 0, H4[i][2]], [H4[opp][0], 0, H4[opp][2]]];
  }
  const dirs = [];
  for (let i = 0; i < 4; i++) if (on[i]) dirs.push([H4[i][0], 0, H4[i][2]]);
  return dirs;
}

/**
 * §5.2 — the graph neighbours of a dust cell: for each connected direction,
 * the wire cell it links to (level / up-slope / down-slope), for BFS.
 * Returns array of [wx, wy, wz].
 */
export function dustGraphNeighbors(world, x, y, z) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const dx = H4[i][0], dz = H4[i][2];
    const k = connects(world, x, y, z, dx, dz);
    if (k === CONN.LEVEL) {
      if (isWire(world, x + dx, y, z + dz)) out.push([x + dx, y, z + dz]);
    } else if (k === CONN.UP_SLOPE) {
      out.push([x + dx, y + 1, z + dz]);
    } else if (k === CONN.DOWN_SLOPE) {
      out.push([x + dx, y - 1, z + dz]);
    }
  }
  return out;
}
