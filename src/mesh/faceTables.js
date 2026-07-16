// Per-face constant tables (01 §8.2). Face order [+X, −X, +Y, −Y, +Z, −Z].
// Corner winding is CCW viewed from outside; triangles (0,1,2),(0,2,3).

export const FACE_NORMALS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

// Unit-cube corner offsets v0..v3 per face
export const FACE_CORNERS = [
  [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],   // +X east
  [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]],   // −X west
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],   // +Y up
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],   // −Y down
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],   // +Z south
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],   // −Z north
];

// UV (u,v) per corner; (0,0) = tile top-left (flipY=false, 01 §7)
export const FACE_UVS = [
  [[0, 1], [0, 0], [1, 0], [1, 1]],
  [[0, 1], [0, 0], [1, 0], [1, 1]],
  [[0, 1], [1, 1], [1, 0], [0, 0]],
  [[0, 0], [1, 0], [1, 1], [0, 1]],
  [[0, 1], [1, 1], [1, 0], [0, 0]],
  [[0, 1], [1, 1], [1, 0], [0, 0]],
];

// Tangent axes (the two non-normal axes) per face; axis ids 0=X,1=Y,2=Z
export const FACE_TANGENTS = [
  [1, 2], [1, 2],   // ±X → Y,Z
  [0, 2], [0, 2],   // ±Y → X,Z
  [0, 1], [0, 1],   // ±Z → X,Y
];

// MC directional shade: top 1.0, bottom 0.5, ±Z 0.8, ±X 0.6 (01 §8.2)
export const FACE_SHADE = [0.6, 0.6, 1.0, 0.5, 0.8, 0.8];

// AO brightness steps (01 §8.3)
export const AO_CURVE = [0.4, 0.6, 0.8, 1.0];
