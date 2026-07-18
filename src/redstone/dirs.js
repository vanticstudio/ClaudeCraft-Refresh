// 07-REDSTONE §2 — the shared direction enums, used by every component and the
// mesher. These are frozen: state bytes on disk encode them (§13.3), so the
// numeric values must never change.
//
//   FACE6  0 = -Y down, 1 = +Y up, 2 = -Z north, 3 = +Z south, 4 = -X west, 5 = +X east
//   ATTACH 0 = floor, 1 = wall N(-Z), 2 = wall E(+X), 3 = wall S(+Z), 4 = wall W(-X), 5 = ceiling
//   HFACE  0 = N(-Z), 1 = E(+X), 2 = S(+Z), 3 = W(-X)   (= direction of OUTPUT)

/** FACE6 → unit vector. */
export const FACE6_DIR = [
  [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0],
];

/** FACE6 → its opposite face (down↔up, N↔S, W↔E). */
export const FACE6_OPP = [1, 0, 3, 2, 5, 4];

/**
 * ATTACH → the vector from the component TO its support block.
 * A floor component's support is below; a ceiling component's is above; a wall
 * component's is the wall behind it.
 */
export const ATTACH_DIR = [
  [0, -1, 0], [0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 1, 0],
];

/** HFACE → unit vector (horizontal only). */
export const HFACE_DIR = [
  [0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0],
];

/** HFACE → its opposite (N↔S, E↔W). */
export const HFACE_OPP = [2, 3, 0, 1];

/** The 4 horizontal directions as vectors, in HFACE order (N,E,S,W). */
export const H4 = HFACE_DIR;

/** The 6 face directions, FACE6 order. */
export const DIRS6 = FACE6_DIR;

export const UP = [0, 1, 0];
export const DOWN = [0, -1, 0];

/** Same cell? */
export const eqCell = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** Manhattan-unit delta between two cells, or null if not face-adjacent. */
export function faceDelta(from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) !== 1) return null;
  return [dx, dy, dz];
}

/**
 * The support cell for a component with ATTACH `a` sitting at `(x,y,z)`.
 * = cell + ATTACH_DIR[a].
 */
export function supportCell(a, x, y, z) {
  const d = ATTACH_DIR[a] ?? ATTACH_DIR[0];
  return [x + d[0], y + d[1], z + d[2]];
}
