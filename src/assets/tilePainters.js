// Procedural 16×16 tile painters (01 §7, 06 §4/§8). Pure canvas-2d: no three.js,
// no DOM at module level. Every painter: (ctx, x0, y0, rng) painting one tile at
// (x0, y0); rng is pre-seeded per tile name so output is deterministic.
import { mulberry32 } from '../math/rng.js';

// ---------------------------------------------------------------- color utils
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function css(r, g, b, a = 1) {
  return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
}
function scaleHex(hex, f) {
  const [r, g, b] = hexToRgb(hex);
  return [Math.min(255, r * f), Math.min(255, g * f), Math.min(255, b * f)];
}
function shadeHex(hex, f) {
  const [r, g, b] = scaleHex(hex, f);
  return css(r, g, b);
}
function lerpHex(h1, h2, t) {
  const a = hexToRgb(h1), b = hexToRgb(h2);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
const clamp15 = v => Math.max(0, Math.min(15, v | 0));

// ------------------------------------------------------------- paint helpers
function px(ctx, x0, y0, x, y, style) {
  ctx.fillStyle = style;
  ctx.fillRect(x0 + clamp15(x), y0 + clamp15(y), 1, 1);
}
function rect(ctx, x0, y0, x, y, w, h, style) {
  ctx.fillStyle = style;
  ctx.fillRect(x0 + x, y0 + y, w, h);
}
function solid(ctx, x0, y0, c) {
  rect(ctx, x0, y0, 0, 0, 16, 16, c.startsWith('#') ? c : c);
}
// per-pixel value jitter ±a% brightness
function noise(ctx, x0, y0, rng, c, a) {
  const [r, g, b] = hexToRgb(c);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const f = 1 + (rng() * 2 - 1) * a / 100;
    px(ctx, x0, y0, x, y, css(r * f, g * f, b * f));
  }
}
function speckle(ctx, x0, y0, rng, c, f, d) {
  noise(ctx, x0, y0, rng, c, 6);
  const n = Math.round(256 * d / 100);
  for (let i = 0; i < n; i++) px(ctx, x0, y0, rng() * 16, rng() * 16, f);
}
function blotch(ctx, x0, y0, rng, c1, c2, n) {
  noise(ctx, x0, y0, rng, c1, 5);
  for (let i = 0; i < n; i++) {
    const size = 2 + Math.floor(rng() * 4);           // 2–5 px blobs
    let bx = 1 + Math.floor(rng() * 13), by = 1 + Math.floor(rng() * 13);
    const cells = new Set();
    for (let s = 0; s < size + 2; s++) {
      cells.add(clamp15(bx) * 16 + clamp15(by));
      bx += Math.floor(rng() * 3) - 1; by += Math.floor(rng() * 3) - 1;
      bx = Math.max(0, Math.min(15, bx)); by = Math.max(0, Math.min(15, by));
    }
    const outline = shadeHex(c2, 0.7);
    for (const cell of cells) {
      const cxx = (cell / 16) | 0, cyy = cell % 16;
      px(ctx, x0, y0, cxx, cyy, c2);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cxx + dx, ny = cyy + dy;
        if (nx < 0 || nx > 15 || ny < 0 || ny > 15) continue;
        if (!cells.has(nx * 16 + ny) && rng() < 0.5) px(ctx, x0, y0, nx, ny, outline);
      }
    }
  }
}
function planks(ctx, x0, y0, rng, c) {
  const [r, g, b] = hexToRgb(c);
  const joints = [];
  for (let board = 0; board < 4; board++) joints.push(Math.floor(rng() * 16));
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const board = y >> 2;
    let f = 1 + (rng() * 2 - 1) * 0.08;                     // grain jitter ±8%
    if ((y & 3) === 3) f *= 0.7;                            // seam row −30%
    if (x === joints[board]) f *= 0.7;                      // staggered joint
    px(ctx, x0, y0, x, y, css(r * f, g * f, b * f));
  }
}
function bark(ctx, x0, y0, rng, c1, c2) {
  let x = 0, which = rng() < 0.5;
  while (x < 16) {
    const w = 1 + Math.floor(rng() * 3);
    const c = which ? c1 : c2;
    const [r, g, b] = hexToRgb(c);
    for (let xx = x; xx < Math.min(16, x + w); xx++)
      for (let y = 0; y < 16; y++) {
        const f = 1 + (rng() * 2 - 1) * 0.08;
        px(ctx, x0, y0, xx, y, css(r * f, g * f, b * f));
      }
    x += w; which = !which;
  }
  for (let i = 0; i < 8; i++)                                // random notches
    px(ctx, x0, y0, rng() * 16, rng() * 16, rng() < 0.5 ? c1 : c2);
}
function birchBark(ctx, x0, y0, rng, c1, c2) {              // pale + black dashes
  noise(ctx, x0, y0, rng, c1, 6);
  for (let i = 0; i < 10; i++) {
    const dx = Math.floor(rng() * 13), dy = Math.floor(rng() * 16);
    const w = 2 + Math.floor(rng() * 3);
    rect(ctx, x0, y0, dx, dy, Math.min(w, 16 - dx), 1, c2);
  }
}
function rings(ctx, x0, y0, rng, c1, c2) {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const ring = Math.floor(Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5)));
    const c = (ring & 1) ? c2 : c1;
    const [r, g, b] = hexToRgb(c);
    const f = 1 + (rng() * 2 - 1) * 0.05;
    px(ctx, x0, y0, x, y, css(r * f, g * f, b * f));
  }
}
function oreTile(ctx, x0, y0, rng, mineral) {
  speckle(ctx, x0, y0, rng, '#7f7f7f', '#6f6f6f', 8);
  const blobs = 4 + Math.floor(rng() * 3);
  const hi = shadeHex(mineral, 1.2);
  for (let i = 0; i < blobs; i++) {
    const bx = 1 + Math.floor(rng() * 12), by = 1 + Math.floor(rng() * 12);
    px(ctx, x0, y0, bx, by, mineral);
    px(ctx, x0, y0, bx + 1, by, mineral);
    px(ctx, x0, y0, bx, by + 1, mineral);
    if (rng() < 0.6) px(ctx, x0, y0, bx + 1, by + 1, mineral);
    px(ctx, x0, y0, bx + (rng() < 0.5 ? 0 : 1), by + (rng() < 0.5 ? 0 : 1), hi);
  }
}
function leaf(ctx, x0, y0, rng, c1, c2) {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (rng() < 0.12) continue;                              // transparent holes
    px(ctx, x0, y0, x, y, rng() < 0.5 ? c1 : c2);
  }
}
function grassSide(ctx, x0, y0, rng) {
  blotch(ctx, x0, y0, rng, '#8a6142', '#6b4a33', 8);         // dirt base
  const [r, g, b] = hexToRgb('#5d9b3e');
  for (let y = 0; y < 4; y++) for (let x = 0; x < 16; x++) {
    const keep = y < 2 || (y === 2 && rng() < 0.6) || (y === 3 && rng() < 0.2);
    if (!keep) continue;
    const f = 1 + (rng() * 2 - 1) * 0.1;
    px(ctx, x0, y0, x, y, css(r * f, g * f, b * f));
  }
}
// pixel-map sprite: rows of chars, '.'=transparent, letters index palette
function crossSprite(ctx, x0, y0, map, palette) {
  for (let y = 0; y < Math.min(16, map.length); y++) {
    const row = map[y];
    for (let x = 0; x < Math.min(16, row.length); x++) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') continue;
      const c = palette[ch];
      if (c) px(ctx, x0, y0, x, y, c);
    }
  }
}
function cropTile(ctx, x0, y0, rng, stage, cLo, cHi) {
  const h = Math.min(14, 2 + 2 * stage);
  const [r, g, b] = lerpHex(cLo, cHi, stage / 7);
  for (const sx of [2, 6, 9, 13]) {
    for (let i = 0; i < h; i++) {
      const f = 1 + (rng() * 2 - 1) * 0.1;
      px(ctx, x0, y0, sx, 15 - i, css(r * f, g * f, b * f));
    }
    if (stage >= 5) {                                        // head pixels
      const ty = 15 - h;
      px(ctx, x0, y0, sx - 1, ty + 1, css(r * 1.15, g * 1.15, b * 1.15));
      px(ctx, x0, y0, sx + 1, ty, css(r * 1.15, g * 1.15, b * 1.15));
    }
  }
}
function glassy(ctx, x0, y0, c) {
  for (let i = 0; i < 16; i++) {
    px(ctx, x0, y0, i, 0, c); px(ctx, x0, y0, i, 15, c);
    px(ctx, x0, y0, 0, i, c); px(ctx, x0, y0, 15, i, c);
  }
  const shine = 'rgba(255,255,255,0.4)';
  for (let i = 0; i < 3; i++) {
    px(ctx, x0, y0, 3 + i, 6 - i, shine);
    px(ctx, x0, y0, 9 + i, 12 - i, shine);
  }
}
function fluid(ctx, x0, y0, rng, c) {
  noise(ctx, x0, y0, rng, c, 10);
}
function border(ctx, x0, y0, c) {
  for (let i = 0; i < 16; i++) {
    px(ctx, x0, y0, i, 0, c); px(ctx, x0, y0, i, 15, c);
    px(ctx, x0, y0, 0, i, c); px(ctx, x0, y0, 15, i, c);
  }
}
function disc(ctx, x0, y0, cx, cy, rad, c) {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++)
    if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) px(ctx, x0, y0, x, y, c);
}

// ------------------------------------------------------------------ PAINTERS
export const PAINTERS = {};
const P = PAINTERS;

// --- terrain cubes -----------------------------------------------------------
P.stone = (c, x, y, r) => speckle(c, x, y, r, '#7f7f7f', '#6f6f6f', 10);
P.grass_top = (c, x, y, r) => noise(c, x, y, r, '#5d9b3e', 12);
P.grass_side = (c, x, y, r) => grassSide(c, x, y, r);
P.dirt = (c, x, y, r) => blotch(c, x, y, r, '#8a6142', '#6b4a33', 8);
P.cobblestone = (c, x, y, r) => {
  blotch(c, x, y, r, '#7a7a7a', '#565656', 9);
  for (let i = 0; i < 4; i++) {                              // mortar web
    let wx = Math.floor(r() * 16), wy = (i * 4 + Math.floor(r() * 3)) % 16;
    for (let s = 0; s < 10; s++) {
      px(c, x, y, wx, wy, '#4a4a4a');
      wx = (wx + 1) & 15; wy = Math.max(0, Math.min(15, wy + Math.floor(r() * 3) - 1));
    }
  }
};
P.oak_planks = (c, x, y, r) => planks(c, x, y, r, '#b8945f');
P.birch_planks = (c, x, y, r) => planks(c, x, y, r, '#d7c185');
P.spruce_planks = (c, x, y, r) => planks(c, x, y, r, '#82603c');
P.oak_log_side = (c, x, y, r) => bark(c, x, y, r, '#745a36', '#58432a');
P.oak_log_top = (c, x, y, r) => rings(c, x, y, r, '#b8945f', '#9a7a4a');
P.birch_log_side = (c, x, y, r) => birchBark(c, x, y, r, '#d7d3cb', '#2e2e2e');
P.birch_log_top = (c, x, y, r) => rings(c, x, y, r, '#d7c185', '#b8a068');
P.spruce_log_side = (c, x, y, r) => bark(c, x, y, r, '#4a3621', '#382818');
P.spruce_log_top = (c, x, y, r) => rings(c, x, y, r, '#82603c', '#6a4e30');
P.oak_leaves = (c, x, y, r) => leaf(c, x, y, r, '#4a7a28', '#3a611e');
P.birch_leaves = (c, x, y, r) => leaf(c, x, y, r, '#6a9e47', '#54803a');
P.spruce_leaves = (c, x, y, r) => leaf(c, x, y, r, '#2e4e33', '#243d29');

const SAPLING_MAP = [
  '................',
  '................',
  '......FFF.......',
  '.....FFFFF......',
  '....FFFFFFF.....',
  '....FFFFFFF.....',
  '.....FFFFF......',
  '....FF.F.FF.....',
  '.......S........',
  '.......S........',
  '.......S........',
  '.......S........',
  '......SS........',
  '................',
  '................',
  '................',
];
function sapling(foliage) {
  return (c, x, y) => crossSprite(c, x, y, SAPLING_MAP, { F: foliage, S: '#6b4f2a' });
}
P.oak_sapling = sapling('#4a7a28');
P.birch_sapling = sapling('#6a9e47');
P.spruce_sapling = sapling('#2e4e33');

P.bedrock = (c, x, y, r) => blotch(c, x, y, r, '#565656', '#2f2f2f', 12);
P.sand = (c, x, y, r) => speckle(c, x, y, r, '#dbd3a0', '#c9bd8b', 12);
P.gravel = (c, x, y, r) => {
  blotch(c, x, y, r, '#857b74', '#675e57', 10);
  for (let i = 0; i < 20; i++) px(c, x, y, r() * 16, r() * 16, '#9c948c');
};
P.sandstone_top = (c, x, y, r) => speckle(c, x, y, r, '#dbd3a0', '#c9bd8b', 12);
P.sandstone_side = (c, x, y, r) => {
  noise(c, x, y, r, '#d8cf9e', 6);
  rect(c, x, y, 0, 5, 16, 1, '#b5a878');
  rect(c, x, y, 0, 10, 16, 1, '#b5a878');
};
P.sandstone_bottom = (c, x, y, r) => noise(c, x, y, r, '#cfc593', 8);

P.coal_ore = (c, x, y, r) => oreTile(c, x, y, r, '#2f2f2f');
P.iron_ore = (c, x, y, r) => oreTile(c, x, y, r, '#d8af93');
P.gold_ore = (c, x, y, r) => oreTile(c, x, y, r, '#fcee4b');
P.diamond_ore = (c, x, y, r) => oreTile(c, x, y, r, '#4aedd9');
P.redstone_ore = (c, x, y, r) => oreTile(c, x, y, r, '#d90000');
P.lapis_ore = (c, x, y, r) => oreTile(c, x, y, r, '#2a4bd5');

P.coal_block = (c, x, y, r) => noise(c, x, y, r, '#1b1b1b', 8);
P.iron_block = (c, x, y, r) => { noise(c, x, y, r, '#d8d8d8', 4); border(c, x, y, '#b0b0b0'); };
P.gold_block = (c, x, y, r) => { noise(c, x, y, r, '#f9ec4e', 5); border(c, x, y, '#d4b82a'); };
P.diamond_block = (c, x, y, r) => { noise(c, x, y, r, '#62e9d8', 5); border(c, x, y, '#3bbfb0'); };
P.glass = (c, x, y) => glassy(c, x, y, '#c9dbdc');
P.glowstone = (c, x, y, r) => blotch(c, x, y, r, '#f9d49c', '#d2a04a', 10);
P.obsidian = (c, x, y, r) => blotch(c, x, y, r, '#1b1029', '#3b2754', 6);

P.crafting_table_top = (c, x, y, r) => {
  planks(c, x, y, r, '#a76e35');
  for (let i = 0; i < 16; i++) {
    rect(c, x, y, i, 0, 1, 2, '#6e4f24'); rect(c, x, y, i, 14, 1, 2, '#6e4f24');
    rect(c, x, y, 0, i, 2, 1, '#6e4f24'); rect(c, x, y, 14, i, 2, 1, '#6e4f24');
  }
};
P.crafting_table_side = (c, x, y, r) => {
  planks(c, x, y, r, '#b8945f');
  // saw + hammer motifs
  rect(c, x, y, 3, 4, 3, 1, '#8a8a8a'); rect(c, x, y, 4, 5, 1, 3, '#8a8a8a');
  rect(c, x, y, 10, 4, 3, 2, '#8a8a8a'); rect(c, x, y, 11, 6, 1, 3, '#6e4f24');
};
P.furnace_front = (c, x, y, r) => {
  noise(c, x, y, r, '#6f6f6f', 8);
  border(c, x, y, '#565656');
  rect(c, x, y, 5, 9, 6, 5, '#1a1a1a');
};
P.furnace_side = (c, x, y, r) => { noise(c, x, y, r, '#7f7f7f', 8); border(c, x, y, '#565656'); };
P.furnace_top = (c, x, y, r) => { noise(c, x, y, r, '#7f7f7f', 8); border(c, x, y, '#565656'); };

// ============ 07-REDSTONE §14 textures ============
// Wire tile: a grayscale dust line (power-tint applied per-cell by the mesher via
// own-cell light in this build; §4.5's per-power atlas variants are simplified to
// one tinted tile — see DEVIATIONS).
P.dust_line_0 = (c, x, y, r) => { noise(c, x, y, r, '#b0b0b0', 12); rect(c, x, y, 0, 6, 16, 4, '#c02020'); };
P.redstone_torch = (c, x, y) => {
  rect(c, x, y, 7, 6, 2, 10, '#6b4f2a');            // stick
  rect(c, x, y, 6, 3, 4, 3, '#ff3b3b'); rect(c, x, y, 6, 5, 4, 1, '#7a1010');   // lit tip
};
P.redstone_torch_off = (c, x, y) => {
  rect(c, x, y, 7, 6, 2, 10, '#6b4f2a');
  rect(c, x, y, 6, 3, 4, 3, '#4a0d0d');
};
P.lever = (c, x, y) => {
  rect(c, x, y, 5, 10, 6, 3, '#7f7f7f');            // cobble base
  rect(c, x, y, 7, 3, 2, 8, '#6b4f2a'); px(c, x, y, 7, 2, '#d0d0d0');   // stick + tip
};
P.stone_button = (c, x, y, r) => { rect(c, x, y, 5, 6, 6, 4, '#7f7f7f'); border(c, x, y, '#565656'); };
P.wooden_button = (c, x, y, r) => { rect(c, x, y, 5, 6, 6, 4, '#b8945f'); };
P.smooth_stone_side = (c, x, y, r) => { noise(c, x, y, r, '#9a9a9a', 4); rect(c, x, y, 0, 0, 16, 2, '#8a8a8a'); };
P.smooth_stone_bottom = (c, x, y, r) => noise(c, x, y, r, '#9a9a9a', 4);
P.repeater_top = (c, x, y, r) => {
  noise(c, x, y, r, '#9a9a9a', 6);
  rect(c, x, y, 7, 3, 2, 10, '#3a3a3a');           // arrow shaft toward output
  rect(c, x, y, 5, 4, 6, 2, '#3a3a3a');
  rect(c, x, y, 6, 12, 2, 2, '#c02020'); rect(c, x, y, 8, 12, 2, 2, '#c02020');   // 2 torch dots
};
P.comparator_top = (c, x, y, r) => {
  noise(c, x, y, r, '#9a9a9a', 6);
  rect(c, x, y, 7, 2, 2, 2, '#c02020');            // 3 torch dots in a triangle
  rect(c, x, y, 4, 12, 2, 2, '#c02020'); rect(c, x, y, 10, 12, 2, 2, '#c02020');
};
P.piston_side = (c, x, y, r) => { rect(c, x, y, 0, 0, 16, 4, '#b8945f'); noise(c, x, y + 4, r, '#6f6f6f', 8); };
P.piston_face = (c, x, y, r) => { planks(c, x, y, r, '#b8945f'); border(c, x, y, '#6e4f24'); };
P.piston_face_sticky = (c, x, y, r) => { P.piston_face(c, x, y, r); rect(c, x, y, 4, 4, 8, 8, '#5a8f3c'); };
P.piston_inner = (c, x, y, r) => { noise(c, x, y, r, '#6f6f6f', 8); rect(c, x, y, 6, 6, 4, 4, '#4a4a4a'); };
P.observer_side = (c, x, y, r) => { noise(c, x, y, r, '#5f5f5f', 6); rect(c, x, y, 4, 7, 8, 2, '#8a8a8a'); };
P.observer_face = (c, x, y, r) => { noise(c, x, y, r, '#5f5f5f', 6); rect(c, x, y, 6, 6, 4, 4, '#d90000'); };
P.observer_back = (c, x, y, r) => { noise(c, x, y, r, '#5f5f5f', 6); rect(c, x, y, 6, 6, 4, 4, '#7a1010'); };
P.dispenser_side = (c, x, y, r) => { noise(c, x, y, r, '#7f7f7f', 8); border(c, x, y, '#565656'); };
P.dispenser_front = (c, x, y, r) => { noise(c, x, y, r, '#7f7f7f', 8); rect(c, x, y, 5, 5, 6, 6, '#000'); rect(c, x, y, 6, 4, 4, 1, '#2a2a2a'); };
P.dropper_front = (c, x, y, r) => { noise(c, x, y, r, '#7f7f7f', 8); rect(c, x, y, 5, 5, 6, 6, '#000'); };
P.hopper_side = (c, x, y, r) => { noise(c, x, y, r, '#3a3a3a', 5); border(c, x, y, '#565656'); };
P.hopper_top = (c, x, y, r) => { noise(c, x, y, r, '#3a3a3a', 5); rect(c, x, y, 2, 2, 12, 12, '#1a1a1a'); };
P.redstone_lamp = (c, x, y, r) => { blotch(c, x, y, r, '#5a2d0c', '#3a1c06', 8); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) rect(c, x, y, 3 + i * 5, 3 + j * 5, 2, 2, '#7a4a1a'); };
P.redstone_lamp_lit = (c, x, y, r) => { blotch(c, x, y, r, '#a86a2a', '#8a5620', 8); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) rect(c, x, y, 3 + i * 5, 3 + j * 5, 2, 2, '#ffd97a'); };
P.note_block = (c, x, y, r) => { planks(c, x, y, r, '#8a5f35'); rect(c, x, y, 6, 6, 4, 4, '#2a1a0e'); };
P.redstone_block = (c, x, y, r) => { noise(c, x, y, r, '#aa0f01', 7); border(c, x, y, '#7a0b01'); };
P.chest_front = (c, x, y, r) => {
  planks(c, x, y, r, '#a0793c'); border(c, x, y, '#6e4f24');
  rect(c, x, y, 7, 6, 2, 3, '#8a8a8a');
};
P.chest_side = (c, x, y, r) => { planks(c, x, y, r, '#a0793c'); border(c, x, y, '#6e4f24'); };
P.chest_top = (c, x, y, r) => { planks(c, x, y, r, '#a0793c'); border(c, x, y, '#6e4f24'); };

P.torch = (c, x, y) => {
  rect(c, x, y, 7, 6, 2, 10, '#6b4f2a');
  rect(c, x, y, 7, 6, 1, 10, '#7d5d33');
  rect(c, x, y, 6, 3, 4, 3, '#ff9a00');
  rect(c, x, y, 7, 3, 2, 2, '#ffd966');
};
P.ladder = (c, x, y) => {
  rect(c, x, y, 2, 0, 2, 16, '#a8834f');
  rect(c, x, y, 12, 0, 2, 16, '#a8834f');
  for (const ry of [2, 7, 12]) rect(c, x, y, 2, ry, 12, 2, '#96713e');
};
P.snow = (c, x, y, r) => noise(c, x, y, r, '#f6fbfb', 3);
P.ice = (c, x, y, r) => {
  c.save(); c.globalAlpha = 0.8;
  noise(c, x, y, r, '#9ecdfb', 5);
  for (let i = 0; i < 6; i++) {
    px(c, x, y, 3 + i, 9 - i, '#e8f4ff');
    px(c, x, y, 8 + i, 14 - i, '#e8f4ff');
  }
  c.restore();
};
P.cactus_side = (c, x, y, r) => {
  noise(c, x, y, r, '#0f7a1f', 8);
  for (let cx = 1; cx < 16; cx += 3) rect(c, x, y, cx, 0, 1, 16, '#0a5c16');
  for (let i = 0; i < 6; i++) px(c, x, y, 1 + Math.floor(r() * 5) * 3, r() * 16, '#e8f4e8');
};
P.cactus_top = (c, x, y, r) => { noise(c, x, y, r, '#159a28', 6); border(c, x, y, '#0a5c16'); };
P.pumpkin_side = (c, x, y, r) => {
  noise(c, x, y, r, '#d87f33', 7);
  for (const cx of [2, 6, 10, 14]) rect(c, x, y, cx, 0, 2, 16, '#b5661f');
};
P.pumpkin_top = (c, x, y, r) => {
  noise(c, x, y, r, '#c9752e', 7);
  rect(c, x, y, 6, 6, 4, 4, '#9c581e');
  rect(c, x, y, 7, 4, 2, 8, '#9c581e');
  rect(c, x, y, 4, 7, 8, 2, '#9c581e');
};
P.jack_o_lantern_front = (c, x, y, r) => {
  P.pumpkin_side(c, x, y, r);
  // triangle eyes
  px(c, x, y, 4, 6, '#ffd23c'); px(c, x, y, 5, 6, '#ffd23c'); px(c, x, y, 4, 5, '#ffd23c');
  px(c, x, y, 10, 6, '#ffd23c'); px(c, x, y, 11, 6, '#ffd23c'); px(c, x, y, 11, 5, '#ffd23c');
  // grin
  rect(c, x, y, 4, 10, 8, 1, '#ffd23c');
  px(c, x, y, 3, 9, '#ffd23c'); px(c, x, y, 12, 9, '#ffd23c');
  px(c, x, y, 6, 11, '#ffd23c'); px(c, x, y, 9, 11, '#ffd23c');
};
function wool(cHex) {
  return (c, x, y, r) => {
    noise(c, x, y, r, cHex, 6);
    const dark = shadeHex(cHex, 0.92);
    for (let i = 0; i < 16; i += 4) {
      rect(c, x, y, 0, i, 16, 1, dark);
      rect(c, x, y, i, 0, 1, 16, dark);
    }
  };
}
P.wool_white = wool('#e9e9e9');
P.wool_red = wool('#a12722');
P.wool_blue = wool('#35399d');
P.wool_black = wool('#1f1f23');
P.bookshelf = (c, x, y, r) => {
  planks(c, x, y, r, '#b8945f');
  const spines = ['#7a2b20', '#2b4b7a', '#3f6b2a', '#6b5a2a', '#5a2a6b'];
  for (const shelfY of [2, 9]) {
    rect(c, x, y, 2, shelfY, 12, 5, '#3a2a18');
    let sx = 2;
    while (sx < 13) {
      rect(c, x, y, sx, shelfY + 1, 2, 4, spines[Math.floor(r() * spines.length)]);
      sx += 2;
    }
  }
};
P.tnt_side = (c, x, y, r) => {
  noise(c, x, y, r, '#d0342c', 6);
  rect(c, x, y, 0, 6, 16, 4, '#e6e6e6');
  const k = '#1f1f23';
  // T N T at rows 6–9
  rect(c, x, y, 1, 6, 3, 1, k); rect(c, x, y, 2, 7, 1, 3, k);
  rect(c, x, y, 6, 6, 1, 4, k); rect(c, x, y, 9, 6, 1, 4, k);
  px(c, x, y, 7, 7, k); px(c, x, y, 8, 8, k);
  rect(c, x, y, 12, 6, 3, 1, k); rect(c, x, y, 13, 7, 1, 3, k);
};
P.tnt_top = (c, x, y, r) => {
  noise(c, x, y, r, '#d0342c', 6);
  for (const cx of [2, 7, 12]) for (const cy of [2, 7, 12])
    rect(c, x, y, cx, cy, 2, 2, '#8a5a3a');
};
P.tnt_bottom = (c, x, y, r) => noise(c, x, y, r, '#d0342c', 6);
P.oak_door_lower = (c, x, y, r) => {
  planks(c, x, y, r, '#b8945f');
  border(c, x, y, '#6e4f24');
  rect(c, x, y, 3, 2, 4, 12, '#8a6a3e'); rect(c, x, y, 9, 2, 4, 12, '#8a6a3e');
  rect(c, x, y, 4, 3, 2, 10, '#b8945f'); rect(c, x, y, 10, 3, 2, 10, '#b8945f');
};
P.oak_door_upper = (c, x, y, r) => {
  planks(c, x, y, r, '#b8945f');
  border(c, x, y, '#6e4f24');
  rect(c, x, y, 3, 8, 4, 6, '#8a6a3e'); rect(c, x, y, 9, 8, 4, 6, '#8a6a3e');
  rect(c, x, y, 4, 2, 2, 2, '#9ecdfb'); rect(c, x, y, 10, 2, 2, 2, '#9ecdfb');
  rect(c, x, y, 4, 4, 2, 2, '#7ea8d4'); rect(c, x, y, 10, 4, 2, 2, '#7ea8d4');
};
P.bed_head_top = (c, x, y, r) => {
  noise(c, x, y, r, '#a12722', 5);
  rect(c, x, y, 3, 1, 10, 5, '#e9e9e9');
  rect(c, x, y, 3, 5, 10, 1, '#c9c9c9');
  border(c, x, y, '#6e4f24');
};
P.bed_foot_top = (c, x, y, r) => {
  noise(c, x, y, r, '#a12722', 5);
  rect(c, x, y, 0, 6, 16, 2, '#7a1b18');
  border(c, x, y, '#6e4f24');
};
P.bed_side = (c, x, y, r) => {
  planks(c, x, y, r, '#b8945f');
  rect(c, x, y, 0, 2, 16, 5, '#a12722');
  rect(c, x, y, 0, 2, 4, 2, '#e9e9e9');
};
P.farmland_dry = (c, x, y, r) => {
  blotch(c, x, y, r, '#8a6142', '#6b4a33', 8);
  for (const fy of [1, 5, 9, 13]) rect(c, x, y, 0, fy, 16, 1, '#4a2f1e');
};
P.farmland_wet = (c, x, y, r) => {
  blotch(c, x, y, r, '#6e4e35', '#563b29', 8);
  for (const fy of [1, 5, 9, 13]) rect(c, x, y, 0, fy, 16, 1, '#3b2518');
};
for (let s = 0; s < 8; s++) {
  P['wheat_' + s] = ((st) => (c, x, y, r) => cropTile(c, x, y, r, st, '#4aa03c', '#d5b542'))(s);
}
for (let i = 0; i < 4; i++) {
  const st = i * 2 + 1;
  P['carrot_' + i] = ((stage, last) => (c, x, y, r) => {
    cropTile(c, x, y, r, stage, '#4aa03c', '#3f8f2f');
    if (last) for (const sx of [2, 6, 9, 13]) px(c, x, y, sx, 15, '#e07b2a');
  })(st, i === 3);
  P['potato_' + i] = ((stage, last) => (c, x, y, r) => {
    cropTile(c, x, y, r, stage, '#4aa03c', '#3f8f2f');
    if (last) for (const sx of [2, 6, 9, 13]) px(c, x, y, sx, 15, '#c9a86a');
  })(st, i === 3);
}
P.sugar_cane = (c, x, y, r) => {
  for (const sx of [2, 7, 12]) {
    rect(c, x, y, sx, 1, 2, 15, '#7fbf5f');
    for (let jy = 4; jy < 16; jy += 4 + Math.floor(r() * 2))
      rect(c, x, y, sx, jy, 2, 1, '#5a9a3f');
  }
};
P.short_grass = (c, x, y, r) => {
  for (let i = 0; i < 7; i++) {
    const bx = 1 + i * 2 + Math.floor(r() * 2);
    const h = 6 + Math.floor(r() * 8);
    const f = 1 + (r() * 2 - 1) * 0.1;
    const [rr, gg, bb] = scaleHex('#5d9b3e', f);
    for (let j = 0; j < h; j++)
      px(c, x, y, bx + (j > h - 3 && r() < 0.3 ? 1 : 0), 15 - j, css(rr, gg, bb));
  }
};
function flower(head, headShade) {
  return (c, x, y, r) => {
    rect(c, x, y, 8, 9, 1, 7, '#3a611e');
    px(c, x, y, 6, 12, '#3a611e'); px(c, x, y, 7, 11, '#3a611e');
    px(c, x, y, 10, 11, '#3a611e'); px(c, x, y, 9, 12, '#3a611e');
    rect(c, x, y, 7, 5, 3, 3, head);
    px(c, x, y, 8, 6, headShade);
  };
}
P.dandelion = flower('#ffe94d', '#d5b542');
P.poppy = flower('#d0342c', '#1f1f23');
P.dead_bush = (c, x, y) => {
  const t = '#946428';
  rect(c, x, y, 8, 9, 1, 7, t);
  for (let i = 0; i < 4; i++) {
    px(c, x, y, 8 - i, 9 - i, t); px(c, x, y, 9 + i, 10 - i, t);
  }
  px(c, x, y, 5, 4, t); px(c, x, y, 12, 5, t);
  px(c, x, y, 8, 5, t); px(c, x, y, 8, 6, t);
};

// --- animated tiles (2 frames each) -----------------------------------------
const waterFrame = (c, x, y, r) => fluid(c, x, y, r, '#3f76e4');
const lavaFrame = (c, x, y, r) => {
  fluid(c, x, y, r, '#d45a12');
  for (let i = 0; i < 76; i++) px(c, x, y, r() * 16, r() * 16, '#f8b613');
};
const fireFrame = (c, x, y, r) => {
  const cols = ['#ff9a00', '#ff9a00', '#ffd23c', '#ffffff'];
  for (let xx = 0; xx < 16; xx++) {
    const h = 8 + Math.floor(r() * 8);
    for (let yy = 15; yy > 15 - h; yy--) {
      if (r() < 0.4) continue;                               // 40% transparent
      px(c, x, y, xx, yy, cols[Math.floor(r() * cols.length)]);
    }
  }
};
const furnaceLitFrame = (flick) => (c, x, y, r) => {
  noise(c, x, y, r, '#6f6f6f', 8);
  border(c, x, y, '#565656');
  rect(c, x, y, 5, 9, 6, 5, flick ? '#ffd23c' : '#ff9a00');
  for (let i = 0; i < 8; i++)
    px(c, x, y, 5 + r() * 6, 9 + r() * 5, flick ? '#ff9a00' : '#ffd23c');
};
export const ANIMATED = {
  water: [waterFrame, (c, x, y, r) => { r(); waterFrame(c, x, y, r); }],
  lava: [lavaFrame, (c, x, y, r) => { r(); lavaFrame(c, x, y, r); }],
  fire: [fireFrame, (c, x, y, r) => { r(); fireFrame(c, x, y, r); }],
  furnace_front_lit: [furnaceLitFrame(false), furnaceLitFrame(true)],
};
P.water = ANIMATED.water[0];
P.lava = ANIMATED.lava[0];
P.fire = ANIMATED.fire[0];
P.furnace_front_lit = ANIMATED.furnace_front_lit[0];

// --- destroy stages ----------------------------------------------------------
// One deterministic crack pattern; stage i draws a prefix of it.
let CRACKS = null;
function crackPattern() {
  if (CRACKS) return CRACKS;
  const r = mulberry32(0xC0FFEE);
  const list = [];
  const walkers = [];
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2 + r() * 0.8;
    walkers.push({ x: 7.5, y: 7.5, dx: Math.cos(ang), dy: Math.sin(ang) });
  }
  for (let step = 0; step < 40; step++) {
    for (const w of walkers) {
      w.x += w.dx * (0.6 + r() * 0.8); w.y += w.dy * (0.6 + r() * 0.8);
      w.dx += (r() - 0.5) * 0.7; w.dy += (r() - 0.5) * 0.7;
      const n = Math.hypot(w.dx, w.dy) || 1; w.dx /= n; w.dy /= n;
      const ix = Math.max(0, Math.min(15, Math.round(w.x)));
      const iy = Math.max(0, Math.min(15, Math.round(w.y)));
      list.push([ix, iy, r() < 0.6 ? 0.55 : 0.35]);
      if (r() < 0.06) list.push([Math.max(0, Math.min(15, ix + 1)), iy, 0.35]);
    }
  }
  CRACKS = list;
  return list;
}
for (let s = 0; s < 10; s++) {
  P['destroy_' + s] = ((stage) => (c, x, y) => {
    const list = crackPattern();
    const n = Math.floor(list.length * (stage + 1) / 10);
    for (let i = 0; i < n; i++) {
      const [ix, iy, a] = list[i];
      px(c, x, y, ix, iy, `rgba(0,0,0,${a})`);
    }
  })(s);
}

// =============================================================== item sprites
// Shared pixel maps; tiers recolor via palette substitution (06 §8.1).
const TOOL_TIERS = {
  wooden: '#8b6f47', stone: '#9a9a9a', iron: '#d8d8d8',
  golden: '#fdf55f', diamond: '#4aedd9',
};
const ARMOR_TIERS = {
  leather: '#a0522d', golden: '#fdf55f', iron: '#d8d8d8', diamond: '#4aedd9',
};
const STICK = '#6b4f2a', STICK_S = '#4a3620';

const MAP_PICKAXE = [   // canonical map from 06 §8.1
  '................',
  '.....HHHHHH.....',
  '....HhhhhhHH....',
  '...Hh....hhHH...',
  '..Hh......hHH...',
  '..H........hH...',
  '.........Ss.....',
  '........Ss......',
  '.......Ss.......',
  '......Ss........',
  '.....Ss.........',
  '....Ss..........',
  '...Ss...........',
  '..Ss............',
  '.Ss.............',
  '................',
];
const MAP_SWORD = [
  '..........HH....',
  '.........HHh....',
  '........HHh.....',
  '.......HHh......',
  '......HHh.......',
  '.....HHh........',
  '....HHh.........',
  '...HHh..........',
  '..HHh...........',
  '.sSh............',
  'sSSs............',
  '.Ss.............',
  'Ss..............',
  's...............',
  '................',
  '................',
];
const MAP_AXE = [
  '.....HHHH.......',
  '....HHHHHH......',
  '....HHhhHHH.....',
  '....Hh..HHh.....',
  '.........Ss.....',
  '........Ss......',
  '........Ss......',
  '.......Ss.......',
  '.......Ss.......',
  '......Ss........',
  '......Ss........',
  '.....Ss.........',
  '.....Ss.........',
  '....Ss..........',
  '...Ss...........',
  '................',
];
const MAP_SHOVEL = [
  '........HHH.....',
  '.......HHHHH....',
  '.......HHhHH....',
  '.......HhhhH....',
  '........hhh.....',
  '........Ss......',
  '.......Ss.......',
  '.......Ss.......',
  '......Ss........',
  '......Ss........',
  '.....Ss.........',
  '.....Ss.........',
  '....Ss..........',
  '....Ss..........',
  '...Ss...........',
  '................',
];
const MAP_HOE = [
  '.....HHHHH......',
  '....HHhhhHh.....',
  '....Hh...Ss.....',
  '.........Ss.....',
  '........Ss......',
  '........Ss......',
  '.......Ss.......',
  '.......Ss.......',
  '......Ss........',
  '......Ss........',
  '.....Ss.........',
  '.....Ss.........',
  '....Ss..........',
  '...Ss...........',
  '................',
  '................',
];
const MAP_HELMET = [
  '................',
  '................',
  '................',
  '....AAAAAAAA....',
  '...AAaaaaaaAA...',
  '...Aa......aA...',
  '...Aa......aA...',
  '...Aa......aA...',
  '...Aa......aA...',
  '...A........A...',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
];
const MAP_CHESTPLATE = [
  '................',
  '................',
  '..AA........AA..',
  '..AAa......aAA..',
  '..AAAaaaaaaAAA..',
  '..AAAAAAAAAAAA..',
  '...AAAAAAAAAA...',
  '...AAAAAAAAAA...',
  '...AAAAAAAAAA...',
  '...AAAAAAAAAA...',
  '...AAaaaaaaAA...',
  '................',
  '................',
  '................',
  '................',
  '................',
];
const MAP_LEGGINGS = [
  '................',
  '................',
  '................',
  '...AAAAAAAAAA...',
  '...AAAAAAAAAA...',
  '...AAa....aAA...',
  '...AAa....aAA...',
  '...AAa....aAA...',
  '...AAa....aAA...',
  '...AAa....aAA...',
  '...AAa....aAA...',
  '...AAa....aAA...',
  '................',
  '................',
  '................',
  '................',
];
const MAP_BOOTS = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '...AAa....aAA...',
  '...AAa....aAA...',
  '...AAa....aAA...',
  '..AAAAa..aAAAa..',
  '..AAAAA..AAAAA..',
  '................',
  '................',
  '................',
  '................',
  '................',
];
const MAP_BOW = [
  '................',
  '......SSS..T....',
  '....SSsssS.T....',
  '...Ss......T....',
  '..Ss.......T....',
  '..Ss.......T....',
  '.Ss........T....',
  '.Ss........T....',
  '.Ss........T....',
  '..Ss.......T....',
  '..Ss.......T....',
  '...Ss......T....',
  '....SSsssS.T....',
  '......SSS..T....',
  '................',
  '................',
];
const MAP_ARROW = [
  '.............HH.',
  '............HHh.',
  '...........SHh..',
  '..........Ss....',
  '.........Ss.....',
  '........Ss......',
  '.......Ss.......',
  '......Ss........',
  '.....Ss.........',
  '....Ss..........',
  '..FSs...........',
  '..FFs...........',
  '.FFF............',
  '.FF.............',
  '................',
  '................',
];
const MAP_SHEARS = [
  '................',
  '................',
  '....H......H....',
  '....Hh....Hh....',
  '.....Hh..Hh.....',
  '......HhHh......',
  '.......HH.......',
  '......GhhG......',
  '.....Gg..gG.....',
  '....Gg....gG....',
  '.....G....G.....',
  '................',
  '................',
  '................',
  '................',
  '................',
];
const MAP_FLINT_AND_STEEL = [
  '................',
  '..FF............',
  '.FFFF...........',
  '.FFF............',
  '..F.............',
  '................',
  '........HHH.....',
  '.......Hh..H....',
  '......Hh........',
  '......Hh........',
  '.......Hh..H....',
  '........HHH.....',
  '................',
  '................',
  '................',
  '................',
];
const MAP_BUCKET = [
  '................',
  '................',
  '...HHHHHHHHHH...',
  '...HWWWWWWWWH...',
  '..Hh........Hh..',
  '..Hh........Hh..',
  '..Hh........Hh..',
  '...Hh......Hh...',
  '...Hh......Hh...',
  '....Hh....Hh....',
  '....HhhhhhHh....',
  '................',
  '................',
  '................',
  '................',
  '................',
];

function spriteFromMap(map, palette) {
  return (c, x, y) => crossSprite(c, x, y, map, palette);
}
function toolPalette(tierColor, extra = {}) {
  return {
    H: tierColor, h: shadeHex(tierColor, 0.72),
    S: STICK, s: STICK_S, ...extra,
  };
}
const TOOL_MAPS = {
  sword: MAP_SWORD, pickaxe: MAP_PICKAXE, axe: MAP_AXE,
  shovel: MAP_SHOVEL, hoe: MAP_HOE,
};
for (const [tier, color] of Object.entries(TOOL_TIERS))
  for (const [shape, map] of Object.entries(TOOL_MAPS))
    P[`item_${tier}_${shape}`] = spriteFromMap(map, toolPalette(color));

const ARMOR_MAPS = {
  helmet: MAP_HELMET, chestplate: MAP_CHESTPLATE,
  leggings: MAP_LEGGINGS, boots: MAP_BOOTS,
};
for (const [tier, color] of Object.entries(ARMOR_TIERS))
  for (const [shape, map] of Object.entries(ARMOR_MAPS))
    P[`item_${tier}_${shape}`] = spriteFromMap(map, { A: color, a: shadeHex(color, 0.72) });

P.item_bow = spriteFromMap(MAP_BOW, { S: STICK, s: STICK_S, T: '#e6e6e6' });
P.item_arrow = spriteFromMap(MAP_ARROW, {
  H: '#b0b0b0', h: '#8a8a8a', S: '#6b4a2b', s: '#523821', F: '#e6e6e6',
});
P.item_shears = spriteFromMap(MAP_SHEARS, {
  H: '#d8d8d8', h: '#a8a8a8', G: '#a12722', g: '#7a1b18',
});
P.item_flint_and_steel = spriteFromMap(MAP_FLINT_AND_STEEL, {
  F: '#565656', H: '#d8d8d8', h: '#a8a8a8',
});
P.item_bucket = spriteFromMap(MAP_BUCKET, { H: '#d8d8d8', h: '#a8a8a8', W: '#d8d8d8' });
P.item_water_bucket = spriteFromMap(MAP_BUCKET, { H: '#d8d8d8', h: '#a8a8a8', W: '#3f76e4' });
P.item_lava_bucket = spriteFromMap(MAP_BUCKET, { H: '#d8d8d8', h: '#a8a8a8', W: '#d45a12' });

// --- food & materials (programmatic silhouettes) ------------------------------
P.item_apple = (c, x, y) => {
  disc(c, x, y, 8, 9, 4, '#d0342c');
  px(c, x, y, 6, 7, '#e86a5a');
  rect(c, x, y, 8, 4, 1, 3, '#6b4f2a');
  px(c, x, y, 9, 4, '#3f8f2f'); px(c, x, y, 10, 4, '#3f8f2f');
};
P.item_bread = (c, x, y, r) => {
  rect(c, x, y, 2, 7, 12, 5, '#c98f4e');
  rect(c, x, y, 3, 6, 10, 1, '#e0b070');
  rect(c, x, y, 2, 11, 12, 1, '#a5723a');
  for (let i = 0; i < 4; i++) px(c, x, y, 4 + i * 3, 8, '#e0b070');
};
function chop(raw, cooked, bone) {
  return (c, x, y) => {
    disc(c, x, y, 9, 7, 4, raw);
    disc(c, x, y, 9, 7, 2, cooked);
    rect(c, x, y, 3, 10, 3, 2, bone);
    px(c, x, y, 5, 9, bone);
  };
}
P.item_porkchop = chop('#f0a5a2', '#e88a86', '#e6e6e6');
P.item_cooked_porkchop = chop('#c98f4e', '#a5723a', '#e6e6e6');
P.item_beef = chop('#a13d2d', '#c05a48', '#e8a5a5');
P.item_cooked_beef = chop('#6b3a24', '#8a5232', '#c98f4e');
function drumstick(meat, shade) {
  return (c, x, y) => {
    disc(c, x, y, 6, 6, 4, meat);
    px(c, x, y, 4, 4, shade);
    rect(c, x, y, 9, 9, 2, 2, meat);
    rect(c, x, y, 10, 10, 3, 2, '#e6e6e6');
    px(c, x, y, 13, 11, '#e6e6e6');
  };
}
P.item_chicken = drumstick('#f0cfc2', '#e0b5a2');
P.item_cooked_chicken = drumstick('#c98f4e', '#a5723a');
P.item_mutton = drumstick('#c94a4a', '#a13d2d');
P.item_cooked_mutton = drumstick('#8a4a2a', '#6b3a24');
P.item_rotten_flesh = (c, x, y, r) => {
  for (let i = 0; i < 26; i++) {
    const bx = 2 + r() * 12, by = 3 + r() * 10;
    px(c, x, y, bx, by, r() < 0.7 ? '#7a5a3a' : '#4aa03c');
    px(c, x, y, bx + 1, by, r() < 0.7 ? '#6b4a2e' : '#3f8f2f');
  }
  rect(c, x, y, 4, 6, 8, 4, '#7a5a3a');
  px(c, x, y, 6, 7, '#4aa03c'); px(c, x, y, 9, 8, '#4aa03c');
};
P.item_carrot = (c, x, y) => {
  for (let i = 0; i < 7; i++) {
    const w = Math.max(1, 3 - (i >> 1));
    rect(c, x, y, 5 + i, 6 + i, w, 1, '#e07b2a');
  }
  px(c, x, y, 4, 5, '#3f8f2f'); px(c, x, y, 5, 4, '#3f8f2f');
  px(c, x, y, 6, 5, '#4aa03c'); px(c, x, y, 5, 6, '#4aa03c');
};
P.item_potato = (c, x, y) => {
  disc(c, x, y, 8, 8, 4, '#c9a86a');
  px(c, x, y, 6, 6, '#b08e50'); px(c, x, y, 10, 9, '#b08e50');
};
P.item_baked_potato = (c, x, y) => {
  disc(c, x, y, 8, 8, 4, '#c98f4e');
  px(c, x, y, 6, 6, '#8a5a3a'); px(c, x, y, 10, 9, '#8a5a3a');
  px(c, x, y, 8, 7, '#e0b070');
};
P.item_stick = (c, x, y) => {
  for (let i = 0; i < 10; i++) {
    px(c, x, y, 3 + i, 13 - i, STICK);
    px(c, x, y, 4 + i, 13 - i, STICK_S);
  }
};
P.item_coal = (c, x, y, r) => {
  disc(c, x, y, 8, 8, 4, '#1b1b1b');
  px(c, x, y, 6, 6, '#3a3a3a'); px(c, x, y, 9, 7, '#3a3a3a');
};
P.item_charcoal = (c, x, y, r) => {
  disc(c, x, y, 8, 8, 4, '#2a2018');
  px(c, x, y, 6, 6, '#4a3a28'); px(c, x, y, 9, 9, '#4a3a28');
};
P.item_raw_iron = (c, x, y, r) => {
  disc(c, x, y, 8, 8, 4, '#d8af93');
  px(c, x, y, 6, 7, '#b08e70'); px(c, x, y, 9, 8, '#e8cfb3');
};
P.item_raw_gold = (c, x, y, r) => {
  disc(c, x, y, 8, 8, 4, '#e8c860');
  px(c, x, y, 6, 7, '#c0a040'); px(c, x, y, 9, 8, '#fcee4b');
};
function ingot(color, shade, hi) {
  return (c, x, y) => {
    for (let i = 0; i < 4; i++) rect(c, x, y, 3 + i, 10 - i, 9, 1, color);
    rect(c, x, y, 6, 6, 9, 1, hi);
    rect(c, x, y, 3, 11, 9, 1, shade);
    for (let i = 0; i < 4; i++) px(c, x, y, 12 + i, 10 - i, shade);
  };
}
P.item_iron_ingot = ingot('#d8d8d8', '#a8a8a8', '#f0f0f0');
P.item_gold_ingot = ingot('#f9ec4e', '#d4b82a', '#fdf7a0');
P.item_diamond = (c, x, y) => {
  const d = '#4aedd9', s = '#2bbfae', w = '#d8fff8';
  rect(c, x, y, 5, 4, 6, 2, d);
  rect(c, x, y, 4, 6, 8, 2, d);
  rect(c, x, y, 5, 8, 6, 1, s);
  rect(c, x, y, 6, 9, 4, 1, s);
  rect(c, x, y, 7, 10, 2, 1, s);
  px(c, x, y, 6, 5, w); px(c, x, y, 5, 6, w);
};
P.item_flint = (c, x, y) => {
  rect(c, x, y, 5, 5, 6, 2, '#565656');
  rect(c, x, y, 4, 7, 8, 2, '#464646');
  rect(c, x, y, 5, 9, 5, 2, '#565656');
  rect(c, x, y, 6, 11, 3, 1, '#3a3a3a');
  px(c, x, y, 6, 6, '#7a7a7a');
};
P.item_string = (c, x, y) => {
  const w = '#e6e6e6';
  for (let i = 0; i < 12; i++)
    px(c, x, y, 3 + i, 8 + Math.round(Math.sin(i * 0.9) * 2.5), w);
  px(c, x, y, 3, 7, w); px(c, x, y, 14, 9, w);
};
P.item_feather = (c, x, y) => {
  for (let i = 0; i < 8; i++) {
    rect(c, x, y, 4 + i, 10 - i, 3, 1, '#f4f4f4');
    px(c, x, y, 4 + i, 11 - i, '#c8c8c8');
  }
  px(c, x, y, 3, 12, '#e0b23c'); px(c, x, y, 2, 13, '#e0b23c');
};
P.item_gunpowder = (c, x, y, r) => {
  for (let i = 0; i < 30; i++) {
    const bx = 3 + r() * 10, by = 7 + r() * 6;
    px(c, x, y, bx, by, r() < 0.7 ? '#7a7a7a' : '#565656');
  }
  rect(c, x, y, 6, 10, 4, 2, '#6f6f6f');
};
P.item_leather = (c, x, y) => {
  rect(c, x, y, 3, 4, 10, 9, '#a0522d');
  px(c, x, y, 3, 4, 'rgba(0,0,0,0)');
  rect(c, x, y, 4, 3, 8, 1, '#a0522d');
  rect(c, x, y, 4, 13, 8, 1, '#8a4224');
  rect(c, x, y, 5, 6, 2, 1, '#8a4224'); rect(c, x, y, 9, 9, 2, 1, '#8a4224');
};
P.item_bone = (c, x, y) => {
  const w = '#f0f0e0', s = '#c8c8b8';
  for (let i = 0; i < 8; i++) rect(c, x, y, 4 + i, 11 - i, 2, 1, w);
  rect(c, x, y, 2, 11, 2, 2, w); rect(c, x, y, 4, 12, 2, 2, w);
  rect(c, x, y, 11, 2, 2, 2, w); rect(c, x, y, 12, 4, 2, 2, w);
  px(c, x, y, 5, 11, s); px(c, x, y, 10, 6, s);
};
P.item_bone_meal = (c, x, y, r) => {
  for (let i = 0; i < 28; i++)
    px(c, x, y, 3 + r() * 10, 7 + r() * 6, r() < 0.7 ? '#e6e6e6' : '#c8c8b8');
  rect(c, x, y, 6, 10, 4, 2, '#e6e6e6');
};
P.item_egg = (c, x, y) => {
  disc(c, x, y, 8, 9, 3, '#f0e8d0');
  rect(c, x, y, 6, 5, 4, 2, '#f0e8d0');
  px(c, x, y, 7, 6, '#fff8e8');
  px(c, x, y, 9, 10, '#d8ceb0');
};
P.item_ender_pearl = (c, x, y) => {
  disc(c, x, y, 8, 8, 4, '#0f6b5a');
  px(c, x, y, 7, 6, '#4aedd9'); px(c, x, y, 9, 8, '#4aedd9');
  px(c, x, y, 6, 9, '#2bbfae'); px(c, x, y, 10, 6, '#2bbfae');
};
P.item_snowball = (c, x, y) => {
  disc(c, x, y, 8, 8, 4, '#f6fbfb');
  px(c, x, y, 6, 6, '#ffffff'); px(c, x, y, 10, 10, '#d8e8e8');
};
P.item_wheat = (c, x, y) => {
  const g = '#d5b542', s = '#b09030';
  for (const bx of [4, 8, 12]) {
    rect(c, x, y, bx, 6, 1, 9, s);
    for (let i = 0; i < 4; i++) {
      px(c, x, y, bx - 1, 3 + i, g); px(c, x, y, bx, 2 + i, g); px(c, x, y, bx + 1, 3 + i, g);
    }
  }
};
P.item_wheat_seeds = (c, x, y, r) => {
  for (let i = 0; i < 9; i++)
    px(c, x, y, 3 + r() * 10, 5 + r() * 7, r() < 0.6 ? '#4aa03c' : '#3f8f2f');
};
P.item_sugar = (c, x, y, r) => {
  for (let i = 0; i < 26; i++)
    px(c, x, y, 3 + r() * 10, 7 + r() * 6, r() < 0.7 ? '#f4f4f4' : '#e0e0e0');
  rect(c, x, y, 6, 10, 4, 2, '#f4f4f4');
};
P.item_paper = (c, x, y) => {
  rect(c, x, y, 4, 2, 8, 12, '#f4f4f4');
  rect(c, x, y, 10, 2, 2, 2, '#d8d8d8');
  rect(c, x, y, 4, 13, 8, 1, '#d8d8d8');
};
P.item_book = (c, x, y) => {
  rect(c, x, y, 3, 3, 10, 10, '#6b4226');
  rect(c, x, y, 11, 4, 2, 9, '#f4f4f4');
  rect(c, x, y, 3, 3, 1, 10, '#4a2d18');
  rect(c, x, y, 5, 5, 4, 1, '#8a5a3a');
};
P.item_redstone = (c, x, y, r) => {
  for (let i = 0; i < 26; i++)
    px(c, x, y, 3 + r() * 10, 7 + r() * 6, r() < 0.7 ? '#d90000' : '#a50000');
  rect(c, x, y, 6, 10, 4, 2, '#d90000');
};
P.item_lapis_lazuli = (c, x, y) => {
  disc(c, x, y, 8, 8, 4, '#2a4bd5');
  px(c, x, y, 6, 6, '#4a6bf5'); px(c, x, y, 9, 9, '#1a3bb5');
};
P.item_bed = (c, x, y) => {
  rect(c, x, y, 1, 8, 14, 3, '#a12722');
  rect(c, x, y, 1, 7, 4, 2, '#e9e9e9');
  rect(c, x, y, 1, 11, 2, 3, '#6b4f2a');
  rect(c, x, y, 13, 11, 2, 3, '#6b4f2a');
};
P.item_oak_door = (c, x, y) => {
  rect(c, x, y, 4, 1, 8, 14, '#b8945f');
  rect(c, x, y, 4, 1, 8, 1, '#6e4f24'); rect(c, x, y, 4, 14, 8, 1, '#6e4f24');
  rect(c, x, y, 4, 1, 1, 14, '#6e4f24'); rect(c, x, y, 11, 1, 1, 14, '#6e4f24');
  rect(c, x, y, 6, 3, 2, 2, '#9ecdfb'); rect(c, x, y, 9, 3, 2, 2, '#9ecdfb');
};
P.item_sugar_cane = P.sugar_cane;
