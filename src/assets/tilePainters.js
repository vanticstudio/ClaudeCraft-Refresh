// Procedural texture painters (01 §7, 06 §4/§8). Pure canvas-2d: no three.js,
// no DOM at module level. Every painter: (ctx, x0, y0, rng) painting one tile at
// (x0, y0); rng is pre-seeded per tile name so output is deterministic.
// Tiles are painted at TILE_PX² (currently 32) — all geometry below is authored
// in the classic 16-unit logical space and scaled onto the device tile by K, so
// a future TILE_PX bump re-scales every painter automatically.
import { mulberry32, xmur3 } from '../math/rng.js';
import { TILE_PX } from '../constants.js';

const S = TILE_PX;
const K = S / 16;                // logical (16-space) → device px scale

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
function rgbHex(r, g, b) {
  const h = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}
function lerpHex(h1, h2, t) {
  const a = hexToRgb(h1), b = hexToRgb(h2);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
const clamp15 = v => Math.max(0, Math.min(15, v | 0));

// ------------------------------------------------------------- paint helpers
// px/rect take LOGICAL 16-space coordinates and scale onto the S×S device tile;
// px1 is a 1-DEVICE-pixel dab used by the fine detail passes.
function px(ctx, x0, y0, x, y, style) {
  ctx.fillStyle = style;
  ctx.fillRect(x0 + clamp15(x) * K, y0 + clamp15(y) * K, K, K);
}
function px1(ctx, x0, y0, x, y, style) {
  ctx.fillStyle = style;
  ctx.fillRect(x0 + Math.max(0, Math.min(S - 1, x | 0)), y0 + Math.max(0, Math.min(S - 1, y | 0)), 1, 1);
}
function rect(ctx, x0, y0, x, y, w, h, style) {
  ctx.fillStyle = style;
  ctx.fillRect(x0 + x * K, y0 + y * K, w * K, h * K);
}
function solid(ctx, x0, y0, c) {
  rect(ctx, x0, y0, 0, 0, 16, 16, c.startsWith('#') ? c : c);
}
// §6 — base value fill: coherent grain (smoothed coarse lattice + a whisper of
// dither), now TWO octaves — a coarse material octave plus a fine sparkle
// octave — so at 2× resolution the surface reads as material, not static.
// Amplitude semantics preserved (a ≈ overall contrast %).
function noise(ctx, x0, y0, rng, c, a) {
  grain(ctx, x0, y0, rng, c, {
    amp: a, cellX: 3, cellY: 3, dither: Math.min(4, a / 2),
    oct2: { cellX: 1.5, cellY: 1.5, amp: a * 0.35 },
  });
}
function speckle(ctx, x0, y0, rng, c, f, d) {
  noise(ctx, x0, y0, rng, c, 6);
  const n = Math.round(S * S * d / 100);
  for (let i = 0; i < n; i++) px(ctx, x0, y0, rng() * 16, rng() * 16, f);
  edgeLight(ctx, x0, y0);                                   // §6 — full-cube users
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
      // interior shading: a light dab toward the top-left, a dark one low-right
      if (rng() < 0.4) px(ctx, x0, y0, cxx, cyy, shadeHex(c2, 1.18));
      if (rng() < 0.4) px(ctx, x0, y0, cxx, cyy, shadeHex(c2, 0.82));
    }
  }
  edgeLight(ctx, x0, y0);                                   // §6 — full-cube users
}
// §6 — planks: along-board coherent wood grain (wide lattice cells so streaks
// run WITH each board), staggered joints, a bevelled seam, and 1–2 subtle
// knots so long boards never read as printed stripes.
function planks(ctx, x0, y0, rng, c) {
  grain(ctx, x0, y0, rng, c, { amp: 8, cellX: 8, cellY: 2, dither: 4, oct2: { cellX: 1.5, cellY: 1, amp: 4 } });
  const [r, g, b] = hexToRgb(c);
  const joints = [];
  for (let board = 0; board < 4; board++) joints.push(Math.floor(rng() * 16));
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const board = y >> 2;
    let f = null;
    if ((y & 3) === 3) f = 0.68;                            // seam shadow
    else if ((y & 3) === 0 && y !== 0) f = 1.10;            // lit board top edge
    if (x === joints[board]) f = (f ?? 1) * 0.72;           // staggered joint
    if (f !== null) {
      const k = f * (1 + (rng() * 2 - 1) * 0.04);
      px(ctx, x0, y0, x, y, css(r * k, g * k, b * k));
    }
  }
  // 1–2 subtle knots: a dark 2×2 core with a lit upper shoulder
  const knots = rng() < 0.5 ? 1 : 2;
  for (let i = 0; i < knots; i++) {
    const kx = 2 + Math.floor(rng() * 11), ky = 2 + Math.floor(rng() * 2) * 4 + 4 + Math.floor(rng() * 2);
    px(ctx, x0, y0, kx, ky, shadeHex(c, 0.66));
    px(ctx, x0, y0, kx + 1, ky, shadeHex(c, 0.74));
    px(ctx, x0, y0, kx, ky + 1, shadeHex(c, 0.8));
    px(ctx, x0, y0, kx, ky - 1, shadeHex(c, 1.12));
  }
  edgeLight(ctx, x0, y0);
}
// Bark: vertical ridge stripes plus deeper notch lines and pale mossy flecks.
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
  // deep ridge lines: near-vertical dark wobbles breaking the stripe rhythm
  for (let i = 0; i < 3; i++) {
    let wx = 1 + Math.floor(rng() * 14), wy = 0;
    while (wy < 16) {
      px(ctx, x0, y0, wx, wy, shadeHex(c2, 0.72));
      wy += 1 + (rng() < 0.3 ? 1 : 0);
      wx = Math.max(0, Math.min(15, wx + (rng() < 0.4 ? (rng() < 0.5 ? 1 : -1) : 0)));
    }
  }
  for (let i = 0; i < 8; i++)                                // random notches
    px(ctx, x0, y0, rng() * 16, rng() * 16, rng() < 0.5 ? c1 : c2);
  for (let i = 0; i < 5; i++)                                // mossy flecks
    px(ctx, x0, y0, rng() * 16, rng() * 16, shadeHex(c1, 1.35));
  edgeLight(ctx, x0, y0);                                    // §6
}
function birchBark(ctx, x0, y0, rng, c1, c2) {              // pale + black dashes
  noise(ctx, x0, y0, rng, c1, 6);
  for (let i = 0; i < 13; i++) {
    const dx = Math.floor(rng() * 13), dy = Math.floor(rng() * 16);
    const w = 2 + Math.floor(rng() * 3);
    rect(ctx, x0, y0, dx, dy, Math.min(w, 16 - dx), 1, c2);
  }
  for (let i = 0; i < 6; i++) px(ctx, x0, y0, rng() * 16, rng() * 16, shadeHex(c1, 0.9));
  edgeLight(ctx, x0, y0);                                    // §6
}
// End-grain rings with a heartwood gradient: the centre reads denser/darker,
// brightening toward the bark edge, with per-px jitter for organic wobble.
function rings(ctx, x0, y0, rng, c1, c2) {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const ring = Math.floor(Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5)));
    const c = (ring & 1) ? c2 : c1;
    const [r, g, b] = hexToRgb(c);
    const heart = 0.85 + 0.15 * (ring / 7);                  // darker heartwood core
    const f = heart * (1 + (rng() * 2 - 1) * 0.05);
    px(ctx, x0, y0, x, y, css(r * f, g * f, b * f));
  }
  edgeLight(ctx, x0, y0);                                    // §6
}
// §6 — ore flecks: chunky irregular blobs, a dark rim on the shadow side and a
// 1–2px GLEAM at the top-left of each blob. Silhouette character varies with
// the mineral (hashed from its hex) so coal reads chunkier, redstone glintier,
// without changing any hue. Base-agnostic: stone AND netherrack ores share it.
function oreFlecks(ctx, x0, y0, rng, mineral, rimBase = '#7f7f7f') {
  const seed = (mineral.charCodeAt(1) + mineral.charCodeAt(3) + mineral.charCodeAt(5));
  const chunky = seed % 3;                                   // 0..2 silhouette variance
  const blobs = 4 + (seed % 2) + Math.floor(rng() * 2);
  const hi = shadeHex(mineral, 1.7), hi2 = shadeHex(mineral, 2.1);
  const lo = shadeHex(mineral, 0.78);
  const rim = shadeHex(rimBase, 0.55);
  for (let i = 0; i < blobs; i++) {
    const bx = 2 + Math.floor(rng() * 11), by = 2 + Math.floor(rng() * 11);
    const cells = [[bx, by], [bx + 1, by], [bx, by + 1]];
    if (rng() < 0.7 + chunky * 0.15) cells.push([bx + 1, by + 1]);
    if (rng() < 0.4 + chunky * 0.2) cells.push([bx + (rng() < 0.5 ? -1 : 2), by + (rng() < 0.5 ? 0 : 1)]);
    if (chunky === 2 && rng() < 0.5) cells.push([bx + 1 + (rng() < 0.5 ? -1 : 2), by + 1]);
    for (const [cx2, cy2] of cells) px(ctx, x0, y0, cx2, cy2, rng() < 0.3 ? lo : mineral);
    const maxX = Math.max(...cells.map(p => p[0])), maxY = Math.max(...cells.map(p => p[1]));
    px(ctx, x0, y0, maxX + 1, maxY, rim);                    // shadow rim right
    px(ctx, x0, y0, maxX, maxY + 1, rim);                    // …and under
    px(ctx, x0, y0, bx, by, hi);                             // gleam top-left
    if (rng() < 0.55) px(ctx, x0, y0, bx + 1, by, hi2);      // 2nd gleam px
  }
}
// §6 — overworld ore tile: stone strata base (2 octaves) + flecks + edge light.
function oreTile2(ctx, x0, y0, rng, mineral) {
  grain(ctx, x0, y0, rng, '#7f7f7f', { amp: 9, cellX: 6, cellY: 3, dither: 4, oct2: { cellX: 2, cellY: 1.5, amp: 5 } });
  oreFlecks(ctx, x0, y0, rng, mineral);
  edgeLight(ctx, x0, y0);
}
// §6 — leaf depth: coherent canopy CLUMPS driven by a value-noise mask over a
// dark underlayer, holes with shadowed rims, and sparse bright leaf highlights.
function leaf(ctx, x0, y0, rng, c1, c2) {
  const deep = shadeHex(c2, 0.72), lit = shadeHex(c1, 1.16), hi = shadeHex(c1, 1.35);
  const cw = 3, ch = 3, gw = Math.ceil(16 / cw) + 1, gh = Math.ceil(16 / ch) + 1;
  const lat = [];
  for (let i = 0; i < gw * gh; i++) lat.push(rng() * 2 - 1);
  const vnoise = (x, y) => {
    const gx = x / cw, gy = y / ch;
    const ix = Math.min(gw - 2, gx | 0), iy = Math.min(gh - 2, gy | 0);
    const fx = gx - ix, fy = gy - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (lat[iy * gw + ix] * (1 - sx) + lat[iy * gw + ix + 1] * sx) * (1 - sy)
         + (lat[(iy + 1) * gw + ix] * (1 - sx) + lat[(iy + 1) * gw + ix + 1] * sx) * sy;
  };
  const holes = [];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const v = vnoise(x, y);
    if (v < -0.62) { holes.push([x, y]); continue; }         // transparent holes in clump gaps
    const v2 = rng() < 0.5 ? v : vnoise(x + 7.3, y + 3.1);
    px(ctx, x0, y0, x, y,
       v2 > 0.42 ? (rng() < 0.22 ? hi : lit)                 // sunlit clump tops
     : v2 > 0.05 ? c1
     : v2 > -0.3 ? c2 : deep);                               // under-canopy dark
  }
  for (const [hx, hy] of holes) {                            // shadow rim under each hole
    if (hy < 15 && !holes.some(([a, b]) => a === hx && b === hy + 1) && rng() < 0.85) {
      px(ctx, x0, y0, hx, hy + 1, deep);
    }
    if (rng() < 0.3 && hx < 15) px(ctx, x0, y0, hx + 1, hy, shadeHex(c2, 0.85));
  }
}
function grassSide(ctx, x0, y0, rng) {
  // §6 — coherent two-octave dirt grain + rimmed pebbles + root speckles, then
  // a ragged turf lip (2–5 device px deep, irregular) whose top row is lit and
  // whose underside casts a 1-px shadow fringe into the dirt.
  grain(ctx, x0, y0, rng, '#8a6142', { amp: 10, cellX: 3, cellY: 3, oct2: { cellX: 1.5, cellY: 1.5, amp: 5 } });
  for (let i = 0; i < 5; i++) {                              // pebbles: lit + rim shadow
    const bx = Math.floor(rng() * 13), by = 5 + Math.floor(rng() * 10);
    px(ctx, x0, y0, bx, by, '#a58f6e');
    if (rng() < 0.6) px(ctx, x0, y0, bx + 1, by, '#97815f');
    px(ctx, x0, y0, bx, by + 1, shadeHex('#8a6142', 0.68));
  }
  for (let i = 0; i < 7; i++)                                // root speckles
    px(ctx, x0, y0, rng() * 16, 5 + rng() * 11, shadeHex('#6b4a33', 0.78));
  const [r, g, b] = hexToRgb('#5d9b3e');
  const [r2, g2, b2] = hexToRgb('#4a8232');
  for (let x = 0; x < 16; x++) {
    const depth = 1 + (rng() < 0.55 ? 1 : 0) + (rng() < 0.22 ? 1 : 0);   // 1–3 logical (2–6 device)
    let blade = false;
    for (let y = 0; y < depth; y++) {
      const dark = y >= depth - 1 && rng() < 0.5;            // shaded turf underside
      const f = 1 + (rng() * 2 - 1) * 0.09 + (y === 0 ? 0.12 : 0);
      const [ur, ug, ub] = dark ? [r2, g2, b2] : [r, g, b];
      px(ctx, x0, y0, x, y, css(ur * f, ug * f, ub * f));
    }
    if (rng() < 0.28) { px(ctx, x0, y0, x, depth, '#548a37'); blade = true; }   // hanging blade
    px(ctx, x0, y0, x, depth + (blade ? 1 : 0), shadeHex('#6b4a33', 0.62));     // shadow fringe
  }
  edgeLight(ctx, x0, y0, { top: 1.0 });   // lip already carries the top light
}
// pixel-map sprite: rows of chars, '.'=transparent, letters index palette.
// Rendered as (S/16)² blocks, then a fine detail pass: per-cell 1-device-px
// jitter (lighter/darker) plus occasional 1px organic nubs just outside the
// silhouette, so sprites read crisp and slightly richer, never blurry.
function crossSprite(ctx, x0, y0, map, palette, rng) {
  const filled = new Set(), cells = [];
  for (let y = 0; y < Math.min(16, map.length); y++) {
    const row = map[y];
    for (let x = 0; x < Math.min(16, row.length); x++) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') continue;
      const c = palette[ch];
      if (!c) continue;
      rect(ctx, x0, y0, x, y, 1, 1, c);
      filled.add(x * 16 + y);
      cells.push([x, y, c]);
    }
  }
  if (!rng) return;
  for (const [x, y, c] of cells) {
    if (rng() < 0.45) {
      const f = rng() < 0.5 ? 0.85 : 1.12;                   // 1px in-cell jitter
      const [r, g, b] = hexToRgb(c);
      ctx.fillStyle = css(r * f, g * f, b * f);
      ctx.fillRect(x0 + x * K + ((rng() * K) | 0), y0 + y * K + ((rng() * K) | 0), 1, 1);
    }
    if (rng() < 0.10) {                                      // organic edge nub
      const [dx, dy] = [[1, 0], [0, 1], [1, 1]][(rng() * 3) | 0];
      const nx = x + dx, ny = y + dy;
      if (nx < 16 && ny < 16 && !filled.has(nx * 16 + ny)) {
        ctx.fillStyle = shadeHex(c, 0.78);
        ctx.fillRect(x0 + nx * K + (dx ? K - 1 : 0), y0 + ny * K + (dy ? K - 1 : 0), 1, 1);
      }
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
      if (i > 1 && rng() < 0.25)                             // leaf nubs on mature stalks
        px(ctx, x0, y0, sx + (rng() < 0.5 ? -1 : 1), 15 - i, css(r * 0.88, g * 0.88, b * 0.88));
    }
    if (stage >= 5) {                                        // head pixels
      const ty = 15 - h;
      px(ctx, x0, y0, sx - 1, ty + 1, css(r * 1.15, g * 1.15, b * 1.15));
      px(ctx, x0, y0, sx + 1, ty, css(r * 1.15, g * 1.15, b * 1.15));
    }
  }
}
function glassy(ctx, x0, y0, c) {
  // faint interior sheen so panes don't read as empty frames
  rect(ctx, x0, y0, 1, 1, 14, 14, 'rgba(255,255,255,0.06)');
  border(ctx, x0, y0, c);
  const shine = 'rgba(255,255,255,0.45)';
  for (let i = 0; i < 4; i++) {
    px(ctx, x0, y0, 3 + i, 7 - i, shine);
    px(ctx, x0, y0, 4 + i, 8 - i, 'rgba(255,255,255,0.22)');
    px(ctx, x0, y0, 9 + i, 13 - i, 'rgba(255,255,255,0.3)');
  }
  rect(ctx, x0, y0, 1, 1, 3, 1, 'rgba(255,255,255,0.55)');   // corner shine
  rect(ctx, x0, y0, 1, 1, 1, 3, 'rgba(255,255,255,0.45)');
}
function fluid(ctx, x0, y0, rng, c) {
  grain(ctx, x0, y0, rng, c, { amp: 8, cellX: 6, cellY: 2, dither: 3 });
  for (let i = 0; i < 3; i++) {                              // drift streaks
    const yy = Math.floor(rng() * 16);
    for (let x = 0; x < 16; x++) if (rng() < 0.65) px(ctx, x0, y0, x, yy, shadeHex(c, 1.12));
  }
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

// --------------------------------------------- UPDATE-polish §6 primitives
// Three shared treatments give the whole set one look: coherent GRAIN instead
// of per-pixel static, a consistent top-left EDGE LIGHT on full tiles, and a
// lit-rim/shadow-outline BEVEL on item sprites. All pure canvas-2d, all driven
// by the same per-tile seeded rng, so builds stay deterministic.

/**
 * Coherent value-noise fill: a coarse random lattice, smoothstep-bilinearly
 * interpolated per pixel, plus a whisper of per-pixel dither — optionally a
 * SECOND fine octave (`oct2: { cellX, cellY, amp }`) for two-scale strata.
 * cellX/cellY stretch the lattice — wide cells → horizontal grain, tall cells
 * → vertical. Cells are given in the logical 16-space and shrink 2× on device
 * at S=32, so every caller's lattice reads ~2× finer than the old 16 px tiles.
 */
function grain(ctx, x0, y0, rng, c, { amp = 12, cellX = 4, cellY = 4, dither = 3, oct2 = null } = {}) {
  const [r, g, b] = hexToRgb(c);
  const vnoise = (lat, cw, ch, gw, gh, x, y) => {
    const gx = x / cw, gy = y / ch;
    const ix = Math.min(gw - 2, gx | 0), iy = Math.min(gh - 2, gy | 0);
    const fx = gx - ix, fy = gy - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (lat[iy * gw + ix] * (1 - sx) + lat[iy * gw + ix + 1] * sx) * (1 - sy)
         + (lat[(iy + 1) * gw + ix] * (1 - sx) + lat[(iy + 1) * gw + ix + 1] * sx) * sy;
  };
  const cw = Math.max(1, cellX * K / 2), ch = Math.max(1, cellY * K / 2);
  const gw = Math.ceil(S / cw) + 1, gh = Math.ceil(S / ch) + 1;
  const lat = [];
  for (let i = 0; i < gw * gh; i++) lat.push(rng() * 2 - 1);
  let lat2 = null, amp2 = 0, cw2 = 0, ch2 = 0, gw2 = 0, gh2 = 0;
  if (oct2) {
    const o = oct2;
    cw2 = Math.max(1, o.cellX * K / 2); ch2 = Math.max(1, oct2.cellY * K / 2);
    amp2 = oct2.amp ?? amp / 2;
    gw2 = Math.ceil(S / cw2) + 1; gh2 = Math.ceil(S / ch2) + 1;
    lat2 = [];
    for (let i = 0; i < gw2 * gh2; i++) lat2.push(rng() * 2 - 1);
  }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const v = vnoise(lat, cw, ch, gw, gh, x, y);
    const v2 = lat2 ? vnoise(lat2, cw2, ch2, gw2, gh2, x, y) : 0;
    const f = 1 + v * amp / 100 + v2 * amp2 / 100 + (rng() * 2 - 1) * dither / 100;
    ctx.fillStyle = css(r * f, g * f, b * f);
    ctx.fillRect(x0 + x, y0 + y, 1, 1);
  }
}

/**
 * Consistent edge lighting — light from the top-left, matching the world's
 * directional face shading and the §4 icon pass: the 1-px top/left border
 * brightens, bottom/right shades. Transparent pixels are skipped so cutout
 * tiles keep their silhouette. Subtle by design: it makes adjacent blocks read
 * as separate cells without turning into a drawn frame.
 */
function edgeLight(ctx, x0, y0, { top = 1.10, left = 1.04, bottom = 0.82, right = 0.91 } = {}) {
  const img = ctx.getImageData(x0, y0, S, S), d = img.data;
  const mul = (x, y, f) => {
    const i = (y * S + x) * 4;
    if (d[i + 3] === 0) return;
    d[i] = Math.min(255, d[i] * f);
    d[i + 1] = Math.min(255, d[i + 1] * f);
    d[i + 2] = Math.min(255, d[i + 2] * f);
  };
  for (let x = 0; x < S; x++) { mul(x, 0, top); mul(x, S - 1, bottom); }
  for (let y = 1; y < S - 1; y++) { mul(0, y, left); mul(S - 1, y, right); }
  ctx.putImageData(img, x0, y0);
}

/**
 * Item-sprite bevel: opaque pixels bordering transparency get a lit rim on the
 * top/left (×lite) and a shadow outline on the bottom/right (×dark). One pass
 * gives every tool/armor/item a cleaner silhouette + the same light direction
 * with zero pixel-map edits; 1-px-thin strokes (both-edged) take the mean so
 * they stay visible instead of vanishing into outline.
 */
function bevelSprite(ctx, x0, y0, { lite = 1.24, dark = 0.55 } = {}) {
  const img = ctx.getImageData(x0, y0, S, S), d = img.data;
  const A = (x, y) => (x < 0 || x > S - 1 || y < 0 || y > S - 1) ? 0 : d[(y * S + x) * 4 + 3];
  const f = new Float32Array(S * S).fill(1);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (A(x, y) === 0) continue;
    const litEdge = A(x, y - 1) === 0 || A(x - 1, y) === 0;
    const darkEdge = A(x, y + 1) === 0 || A(x + 1, y) === 0;
    if (darkEdge && !litEdge) f[y * S + x] = dark;
    else if (litEdge && !darkEdge) f[y * S + x] = lite;
    else if (litEdge && darkEdge) f[y * S + x] = (lite + dark) / 2;
  }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const k = f[y * S + x];
    if (k === 1) continue;
    const i = (y * S + x) * 4;
    d[i] = Math.min(255, d[i] * k);
    d[i + 1] = Math.min(255, d[i + 1] * k);
    d[i + 2] = Math.min(255, d[i + 2] * k);
  }
  ctx.putImageData(img, x0, y0);
}

/** Wrap a sprite painter with the §6 bevel. */
const beveled = paint => (c, x, y, r) => { paint(c, x, y, r); bevelSprite(c, x, y); };

// ------------------------------------------------------------------ PAINTERS
export const PAINTERS = {};
const P = PAINTERS;

// --- terrain cubes -----------------------------------------------------------
// --- terrain cubes -----------------------------------------------------------
// §6 — stone: two-octave horizontal strata grain, clustered fracture flecks
// (1px highlight + shadow pairs) and a couple of darker crack lines.
P.stone = (c, x, y, r) => {
  grain(c, x, y, r, '#7f7f7f', { amp: 8, cellX: 7, cellY: 4, dither: 3, oct2: { cellX: 2, cellY: 2, amp: 5 } });
  for (let i = 0; i < 7; i++) {                              // fracture fleck clusters
    const fx = r() * 15 | 0, fy = r() * 15 | 0;
    px(c, x, y, fx, fy, '#a8a8a8');                          // 1px highlight
    px(c, x, y, fx, fy + 1, '#5f5f5f');                      // …over a shadow
    if (r() < 0.6) { px(c, x, y, fx + 1, fy, '#8f8f8f'); px(c, x, y, fx + 1, fy + 1, '#666666'); }
    if (r() < 0.3) px(c, x, y, fx + 1, fy + 1, '#8a8a8a');
  }
  for (let i = 0; i < 2; i++) {                              // darker crack lines
    let wx = r() * 13 | 0, wy = r() * 13 | 0;
    for (let s = 0; s < 5; s++) {
      px(c, x, y, wx, wy, '#5d5d5d');
      wx += r() < 0.65 ? 1 : 0; wy += r() < 0.5 ? 1 : 0;
    }
  }
  edgeLight(c, x, y);
};
// §6 — grass top: 3-tone turf (dark clumps / mid grain / lit blades) with
// sunlit 2px blade highlights popping off the canopy.
P.grass_top = (c, x, y, r) => {
  grain(c, x, y, r, '#4f8c34', { amp: 9, cellX: 4, cellY: 4, dither: 4, oct2: { cellX: 2, cellY: 2, amp: 6 } });
  for (let i = 0; i < 12; i++) {                             // canopy clumps
    const cx = r() * 15 | 0, cy = r() * 15 | 0, dark = r() < 0.4;
    const col = dark ? '#3f7a26' : '#6aae48';
    px(c, x, y, cx, cy, col); px(c, x, y, cx + 1, cy, col);
    if (r() < 0.6) px(c, x, y, cx, cy + 1, col);
  }
  for (let i = 0; i < 7; i++) {                              // blade highlights
    const sx = r() * 16 | 0, sy = r() * 14 | 0;
    px(c, x, y, sx, sy, '#8ecf63');
    px(c, x, y, sx, sy + 1, '#79b951');
  }
  edgeLight(c, x, y);
};
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
  for (let i = 0; i < 8; i++) {                              // lit stone crowns
    const hx = Math.floor(r() * 14), hy = Math.floor(r() * 14);
    px(c, x, y, hx, hy, '#969696');
    if (r() < 0.5) px(c, x, y, hx + 1, hy, '#8a8a8a');
    if (r() < 0.5) px(c, x, y, hx, hy + 1, '#565656');
  }
};
// B5 — dungeon block: cobble with creeping moss blotches (same base as cobble,
// then green clusters in the mortar recesses)
P.mossy_cobblestone = (c, x, y, r) => {
  P.cobblestone(c, x, y, r);
  for (let i = 0; i < 7; i++) {
    const mx = Math.floor(r() * 15), my = Math.floor(r() * 15);
    px(c, x, y, mx, my, '#5a7a3a');
    if (r() < 0.7) px(c, x, y, mx + 1, my, '#4c6a30');
    if (r() < 0.5) px(c, x, y, mx, my + 1, '#6a8a46');
    if (r() < 0.3) px(c, x, y, mx + 1, my + 1, '#3e5a28');
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
  return (c, x, y, r) => crossSprite(c, x, y, SAPLING_MAP, { F: foliage, S: '#6b4f2a' }, r);
}
P.oak_sapling = sapling('#4a7a28');
P.birch_sapling = sapling('#6a9e47');
P.spruce_sapling = sapling('#2e4e33');

P.bedrock = (c, x, y, r) => blotch(c, x, y, r, '#565656', '#2f2f2f', 12);
P.sand = (c, x, y, r) => speckle(c, x, y, r, '#dbd3a0', '#c9bd8b', 12);
P.gravel = (c, x, y, r) => {
  blotch(c, x, y, r, '#857b74', '#675e57', 10);
  for (let i = 0; i < 14; i++) {                             // pebbles with rim shadow
    const bx = Math.floor(r() * 13), by = Math.floor(r() * 13);
    px(c, x, y, bx, by, '#b0a89f');                          // lit top-left
    px(c, x, y, bx + 1, by, '#9c948c');
    px(c, x, y, bx, by + 1, '#938b83');
    px(c, x, y, bx + 1, by + 1, '#5f574f');                  // rim shadow
  }
};
P.sandstone_top = (c, x, y, r) => speckle(c, x, y, r, '#dbd3a0', '#c9bd8b', 12);
P.sandstone_side = (c, x, y, r) => {
  noise(c, x, y, r, '#d8cf9e', 6);
  rect(c, x, y, 0, 5, 16, 1, '#b5a878');
  rect(c, x, y, 0, 10, 16, 1, '#b5a878');
};
P.sandstone_bottom = (c, x, y, r) => noise(c, x, y, r, '#cfc593', 8);

P.coal_ore = (c, x, y, r) => oreTile2(c, x, y, r, '#2f2f2f');
P.iron_ore = (c, x, y, r) => oreTile2(c, x, y, r, '#d8af93');   // §6 sample
P.gold_ore = (c, x, y, r) => oreTile2(c, x, y, r, '#fcee4b');
P.diamond_ore = (c, x, y, r) => oreTile2(c, x, y, r, '#4aedd9');
P.redstone_ore = (c, x, y, r) => oreTile2(c, x, y, r, '#d90000');
P.lapis_ore = (c, x, y, r) => oreTile2(c, x, y, r, '#2a4bd5');

P.coal_block = (c, x, y, r) => noise(c, x, y, r, '#1b1b1b', 8);
P.iron_block = (c, x, y, r) => { noise(c, x, y, r, '#d8d8d8', 4); border(c, x, y, '#b0b0b0'); };
P.gold_block = (c, x, y, r) => { noise(c, x, y, r, '#f9ec4e', 5); border(c, x, y, '#d4b82a'); };
P.diamond_block = (c, x, y, r) => { noise(c, x, y, r, '#62e9d8', 5); border(c, x, y, '#3bbfb0'); };
P.glass = (c, x, y) => glassy(c, x, y, '#c9dbdc');
P.glowstone = (c, x, y, r) => {
  blotch(c, x, y, r, '#f9d49c', '#d2a04a', 10);
  for (let i = 0; i < 4; i++) {                              // hot cores + bloom halo
    const hx = 1 + Math.floor(r() * 13), hy = 1 + Math.floor(r() * 13);
    px(c, x, y, hx, hy, '#fff3c4');
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1]])
      if (r() < 0.85) px(c, x, y, hx + dx, hy + dy, 'rgba(255,220,140,0.6)');
  }
};
P.obsidian = (c, x, y, r) => blotch(c, x, y, r, '#1b1029', '#3b2754', 6);

// ============ 08-ENCHANTING §2.4 ============
// The enchanting_table BOTTOM face reuses the obsidian recipe directly (§2.4),
// so it needs no painter of its own — the block's tile list names 'obsidian'.

P.enchanting_table_top = (c, x, y, r) => {
  noise(c, x, y, r, '#2a4746', 8);                        // teal cloth
  for (const [gx, gy] of [[1, 1], [12, 1], [1, 12], [12, 12]])   // 4 corner diamond glints
    rect(c, x, y, gx, gy, 3, 3, '#4aedd9');
  rect(c, x, y, 6, 6, 4, 4, '#e9e9e9');                   // open book, centre
  rect(c, x, y, 8, 6, 1, 4, '#d0342c');                   // ribbon
};

P.enchanting_table_side = (c, x, y, r) => {
  blotch(c, x, y, r, '#1b1029', '#3b2754', 6);            // obsidian body
  rect(c, x, y, 0, 0, 16, 2, '#d0342c');                  // top 2 rows: cloth overhang
  rect(c, x, y, 7, 7, 2, 2, '#4aedd9');                   // gem set mid-face
};

// §2.4: stage 1 adds 2 one-px zigzag cracks; stage 2 adds 4 cracks + 2 chipped
// (transparent) corner pixels. Stage is bits2–3 of the state nibble (§2.2).
const anvilTop = stage => (c, x, y, r) => {
  noise(c, x, y, r, '#3f3f3f', 6);
  rect(c, x, y, 0, 0, 16, 1, '#2a2a2a');                  // 1px rim
  rect(c, x, y, 0, 15, 16, 1, '#2a2a2a');
  rect(c, x, y, 0, 0, 1, 16, '#2a2a2a');
  rect(c, x, y, 15, 0, 1, 16, '#2a2a2a');
  const cracks = stage === 0 ? 0 : stage === 1 ? 2 : 4;
  for (let i = 0; i < cracks; i++) {
    let cx = 3 + Math.floor(r() * 10), cy = 3 + Math.floor(r() * 4) + i * 2;
    for (let s = 0; s < 6; s++) {                         // one-px zigzag
      px(c, x, y, cx, cy, '#1f1f1f');
      cx += r() < 0.5 ? 1 : 0;
      cy += r() < 0.5 ? 1 : 0;
    }
  }
  if (stage >= 2) {                                       // 2 chipped corner pixels
    c.clearRect(x + 0, y + 0, K, K);
    c.clearRect(x + 15 * K, y + 15 * K, K, K);
  }
};
P.anvil_top_0 = anvilTop(0);
P.anvil_top_1 = anvilTop(1);
P.anvil_top_2 = anvilTop(2);

P.anvil_side = (c, x, y, r) => {
  noise(c, x, y, r, '#464646', 8);
  rect(c, x, y, 0, 13, 16, 3, '#303030');                 // darker underside rows
};

P.grindstone_side = (c, x, y, r) => {                     // wheel side
  rings(c, x, y, r, '#8a8a8a', '#6f6f6f');
  rect(c, x, y, 0, 0, 16, 1, '#565656');                  // 1px outer rim
  rect(c, x, y, 0, 15, 16, 1, '#565656');
  rect(c, x, y, 0, 0, 1, 16, '#565656');
  rect(c, x, y, 15, 0, 1, 16, '#565656');
};

P.grindstone_tread = (c, x, y, r) => noise(c, x, y, r, '#7f7f7f', 8);

// ============ 10-NETHER §11 block textures ============
const netherrackBase = (c, x, y, r) => speckle(c, x, y, r, '#6e2727', '#571d1d', 12);
P.netherrack = netherrackBase;
P.nether_bricks = (c, x, y, r) => { blotch(c, x, y, r, '#2e1416', '#241012', 6); for (let yy = 0; yy < 16; yy += 4) rect(c, x, y, 0, yy, 16, 1, '#4a2226'); };
P.soul_sand = (c, x, y, r) => { blotch(c, x, y, r, '#463430', '#34251f', 8); rect(c, x, y, 4, 5, 3, 3, '#241a15'); rect(c, x, y, 9, 8, 3, 3, '#241a15'); };
P.soul_soil = (c, x, y, r) => { noise(c, x, y, r, '#4a3a33', 8); for (let i = 0; i < 6; i++) rect(c, x, y, r() * 14, r() * 14, 1, 2, '#33251f'); };
P.magma_block = (c, x, y, r) => blotch(c, x, y, r, '#8a2b12', '#d45a12', 10);
P.nether_quartz_ore = (c, x, y, r) => { netherrackBase(c, x, y, r); oreFlecks(c, x, y, r, '#e8e0d8', '#6e2727'); };
P.nether_gold_ore = (c, x, y, r) => { netherrackBase(c, x, y, r); oreFlecks(c, x, y, r, '#fcee4b', '#6e2727'); };
P.ancient_debris_top = (c, x, y, r) => { noise(c, x, y, r, '#4a3a34', 8); rings(c, x, y, r, '#5a463c', '#c08a5a'); };
P.ancient_debris_side = (c, x, y, r) => { noise(c, x, y, r, '#4a3a34', 8); rect(c, x, y, 4, 6, 8, 4, '#c08a5a'); };
P.crimson_nylium = (c, x, y, r) => { noise(c, x, y, r, '#7a1030', 10); speckle(c, x, y, r, '#7a1030', '#a51843', 6); };
P.warped_nylium = (c, x, y, r) => { noise(c, x, y, r, '#167a6e', 10); speckle(c, x, y, r, '#167a6e', '#1aa58f', 6); };
P.crimson_stem = (c, x, y, r) => bark(c, x, y, r, '#6a2033', '#4a1626');
P.crimson_stem_top = (c, x, y, r) => rings(c, x, y, r, '#8a2942', '#6a2033');
P.warped_stem = (c, x, y, r) => bark(c, x, y, r, '#2b6d63', '#1e4d46');
P.warped_stem_top = (c, x, y, r) => rings(c, x, y, r, '#37867a', '#2b6d63');
P.crimson_planks = (c, x, y, r) => planks(c, x, y, r, '#7a3a4a');
P.warped_planks = (c, x, y, r) => planks(c, x, y, r, '#3a6b64');
P.nether_wart_block = (c, x, y, r) => { noise(c, x, y, r, '#7a0a15', 10); for (let i = 0; i < 20; i++) rect(c, x, y, r() * 15, r() * 15, 1, 1, '#a01824'); };
P.warped_wart_block = (c, x, y, r) => { noise(c, x, y, r, '#167a6e', 8); speckle(c, x, y, r, '#167a6e', '#0e8a4a', 8); };
P.shroomlight = (c, x, y, r) => {
  blotch(c, x, y, r, '#f5a83c', '#d47a1a', 8);
  for (let i = 0; i < 4; i++) {                              // glowing pores + halo
    const hx = 2 + Math.floor(r() * 12), hy = 2 + Math.floor(r() * 12);
    px(c, x, y, hx, hy, '#ffdc9a');
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
      if (r() < 0.75) px(c, x, y, hx + dx, hy + dy, 'rgba(255,190,90,0.6)');
  }
};
P.crimson_fungus = (c, x, y) => { rect(c, x, y, 7, 8, 2, 6, '#7a5b3a'); rect(c, x, y, 5, 5, 6, 3, '#c42d2d'); };
P.warped_fungus = (c, x, y) => { rect(c, x, y, 7, 8, 2, 6, '#5a6b3a'); rect(c, x, y, 5, 5, 6, 3, '#3aa58f'); };
P.crimson_roots = (c, x, y) => { for (let i = 0; i < 5; i++) rect(c, x, y, 3 + i * 2, 8, 1, 5, '#8a1030'); };
P.warped_roots = (c, x, y) => { for (let i = 0; i < 5; i++) rect(c, x, y, 3 + i * 2, 8, 1, 5, '#1aa58f'); };
P.nether_wart_0 = (c, x, y) => { for (let i = 0; i < 3; i++) rect(c, x, y, 4 + i * 4, 11, 1, 3, '#7a0a15'); };
P.nether_wart_1 = (c, x, y) => { for (let i = 0; i < 4; i++) rect(c, x, y, 3 + i * 3, 8, 2, 6, '#7a0a15'); };
P.nether_wart_2 = (c, x, y) => { for (let i = 0; i < 4; i++) { rect(c, x, y, 3 + i * 3, 5, 2, 9, '#7a0a15'); rect(c, x, y, 3 + i * 3, 5, 2, 2, '#a01824'); } };
P.bone_block_top = (c, x, y, r) => rings(c, x, y, r, '#d8d3bd', '#b8b19a');
P.bone_block_side = (c, x, y) => { for (let xx = 0; xx < 16; xx += 3) rect(c, x, y, xx, 0, 2, 16, '#e0dccb'); };
P.nether_portal = (c, x, y, r) => { solid(c, x, y, '#280b3b'); for (let i = 0; i < 30; i++) rect(c, x, y, r() * 15, r() * 15, 1, 1, r() < 0.5 ? '#b061e0' : '#e0a0ff'); };
P.spawner = (c, x, y, r) => { noise(c, x, y, r, '#2a2a30', 8); for (let xx = 2; xx < 15; xx += 4) rect(c, x, y, xx, 0, 1, 16, '#1f2a1f'); for (let yy = 2; yy < 15; yy += 4) rect(c, x, y, 0, yy, 16, 1, '#1f2a1f'); rect(c, x, y, 6, 6, 4, 4, '#f5a83c'); };
P.netherite_block = (c, x, y, r) => { noise(c, x, y, r, '#443f42', 4); border(c, x, y, '#2a2528'); for (const [xx, yy] of [[2, 2], [13, 2], [2, 13], [13, 13]]) rect(c, x, y, xx, yy, 1, 1, '#6a5f5a'); };
P.smithing_table_top = (c, x, y, r) => { noise(c, x, y, r, '#3a3336', 8); rect(c, x, y, 5, 5, 6, 6, '#8a8a8a'); };
P.smithing_table_side = (c, x, y, r) => { planks(c, x, y, r, '#5a4436'); rect(c, x, y, 0, 6, 16, 3, '#2a2528'); };

// ============ 09-POTIONS §7 mushrooms + brewing stand ============
P.brown_mushroom = (c, x, y) => {
  rect(c, x, y, 7, 8, 2, 6, '#d8cdba');                   // stem
  rect(c, x, y, 4, 4, 8, 4, '#9a6a43'); rect(c, x, y, 5, 3, 6, 1, '#7a5233');  // cap
};
P.red_mushroom = (c, x, y) => {
  rect(c, x, y, 7, 8, 2, 6, '#e6ddc9');                   // stem
  rect(c, x, y, 4, 4, 8, 4, '#c8302a'); rect(c, x, y, 5, 3, 6, 1, '#a02420');  // cap
  px(c, x, y, 6, 5, '#f0f0f0'); px(c, x, y, 9, 6, '#f0f0f0'); px(c, x, y, 8, 4, '#f0f0f0');  // spots
};
P.brewing_stand = (c, x, y, r) => {
  noise(c, x, y, r, '#3a3336', 8);
  rect(c, x, y, 7, 2, 2, 12, '#8a8a8a');                  // central rod
  rect(c, x, y, 3, 13, 10, 2, '#5a5a5a');                 // base
  px(c, x, y, 8, 3, '#e0a040');                           // flame tip
};

// ============ 12-VILLAGES §7 village blocks ============
P.dirt_path_top = (c, x, y, r) => {
  noise(c, x, y, r, '#8f7d4e', 6);
  rect(c, x, y, 1, 1, 14, 14, '#9a8956'); noise(c, x, y, r, '#9a8956', 4);
  border(c, x, y, '#6b5c38');
};
P.emerald_ore = (c, x, y, r) => oreTile2(c, x, y, r, '#17dd62');
P.emerald_block = (c, x, y, r) => {
  noise(c, x, y, r, '#17c957', 10);
  rect(c, x, y, 2, 2, 5, 5, '#20e468'); rect(c, x, y, 9, 9, 5, 5, '#20e468');
  rect(c, x, y, 9, 2, 5, 5, '#12a848'); rect(c, x, y, 2, 9, 5, 5, '#12a848');
  border(c, x, y, '#0d8a3a');
};
P.bell = (c, x, y, r) => {
  noise(c, x, y, r, '#8a6a2a', 6);
  rect(c, x, y, 5, 3, 6, 7, '#f2c94c');                    // bell body
  rect(c, x, y, 4, 10, 8, 2, '#f2c94c'); rect(c, x, y, 6, 12, 4, 2, '#c99a2a');  // rim + clapper
  rect(c, x, y, 7, 1, 2, 2, '#7a5a20');                    // hanger
};
// 12-VILLAGES §12.2 — the composter's fill level 0–8 is VISIBLE, so both faces
// are baked once per level (blocks.js tilesFor picks the variant from the state
// nibble). Top: "open rim oak_planks + #3f5a20 compost fill square sized to
// level 0–8". Side: "oak_planks frame + inner #5a4a2a compost, level-tinted
// greener as fill rises". Level 8 (READY) is the greenest / fullest.
const COMPOST_EMPTY = '#5a4a2a', COMPOST_FULL = '#3f5a20';
// The noise() helper is a FULL-tile grain pass, so it has to run before the rim
// is drawn or it erases it (the pre-level painters ran it last and rendered as a
// flat dark square).
P.composter_top = (c, x, y, r) => { noise(c, x, y, r, '#3a2a15', 3); planks(c, x, y, r, '#8a6a3a'); rect(c, x, y, 3, 3, 10, 10, '#4a3320'); };
P.composter_side = (c, x, y, r) => { planks(c, x, y, r, '#8a6a3a'); rect(c, x, y, 0, 5, 16, 2, '#6b4f2a'); rect(c, x, y, 0, 11, 16, 2, '#6b4f2a'); };
for (let lvl = 0; lvl <= 8; lvl++) {
  const t = lvl / 8;
  const [cr, cg, cb] = lerpHex(COMPOST_EMPTY, COMPOST_FULL, t);
  const compost = rgbHex(cr, cg, cb), compostLo = shadeHex(compost, 0.82);
  P['composter_top_' + lvl] = (c, x, y, r) => {
    P.composter_top(c, x, y, r);
    if (!lvl) return;
    const s = 2 + Math.round(t * 8);              // 3..10 px square inside the 10px rim
    const o = 8 - (s >> 1);
    rect(c, x, y, o, o, s, s, compost);
    for (let i = 0; i < s; i++) px(c, x, y, o + r() * s, o + r() * s, compostLo);
  };
  P['composter_side_' + lvl] = (c, x, y, r) => {
    P.composter_side(c, x, y, r);
    if (!lvl) return;
    const h = Math.max(1, Math.round(t * 10));    // inner panel grows upward from the floor
    rect(c, x, y, 3, 14 - h, 10, h, compost);
    for (let i = 0; i < h; i++) px(c, x, y, 3 + r() * 10, 14 - h + r() * h, compostLo);
  };
}
P.barrel_top = (c, x, y, r) => { planks(c, x, y, r, '#9a7846'); border(c, x, y, '#5a5a5a'); rect(c, x, y, 6, 6, 4, 4, '#3a2a15'); };
P.barrel_side = (c, x, y, r) => { planks(c, x, y, r, '#8a6a3a'); rect(c, x, y, 0, 2, 16, 2, '#4a4a4a'); rect(c, x, y, 0, 12, 16, 2, '#4a4a4a'); };
P.lectern_top = (c, x, y, r) => { planks(c, x, y, r, '#a76e35'); rect(c, x, y, 3, 4, 5, 8, '#e8e0c8'); rect(c, x, y, 8, 4, 5, 8, '#d8d0b8'); px(c, x, y, 7, 4, '#6b4f2a'); };
P.lectern_side = (c, x, y, r) => { planks(c, x, y, r, '#8a5a2a'); rect(c, x, y, 5, 0, 6, 6, '#a76e35'); };
P.blast_furnace_top = (c, x, y, r) => { noise(c, x, y, r, '#6a6a6a', 8); border(c, x, y, '#4a4a4a'); };
P.blast_furnace_side = (c, x, y, r) => { noise(c, x, y, r, '#6a6a6a', 8); border(c, x, y, '#4a4a4a'); };
P.blast_furnace_front = (c, x, y, r) => {
  noise(c, x, y, r, '#5f5f5f', 8); border(c, x, y, '#3a3a3a');
  rect(c, x, y, 4, 8, 8, 5, '#1a1a1a');                    // hopper mouth
  rect(c, x, y, 5, 5, 2, 2, '#2a2a2a'); rect(c, x, y, 9, 5, 2, 2, '#2a2a2a');  // nozzles
};
P.blast_furnace_front_lit = (c, x, y, r) => {
  P.blast_furnace_front(c, x, y, r);
  for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < 6; xx++) {   // radial glow
    const d = Math.hypot(xx - 2.5, yy - 2.8);
    px(c, x, y, 5 + xx, 9 + yy, d < 1.4 ? '#ffd23c' : d < 2.2 ? '#ffa832' : '#ff6a00');
  }
  rect(c, x, y, 5, 8, 6, 1, 'rgba(255,138,26,0.4)');          // glow spill above mouth
};
P.smoker_top = (c, x, y, r) => { planks(c, x, y, r, '#7a5a34'); rect(c, x, y, 5, 5, 6, 6, '#2a2a2a'); border(c, x, y, '#4a3a22'); };
P.smoker_side = (c, x, y, r) => { planks(c, x, y, r, '#7a5a34'); rect(c, x, y, 0, 11, 16, 5, '#6a6a6a'); };
P.smoker_front = (c, x, y, r) => {
  planks(c, x, y, r, '#7a5a34');
  rect(c, x, y, 4, 7, 8, 6, '#1a1a1a');
  rect(c, x, y, 3, 2, 10, 2, '#4a3a22');
};
P.smoker_front_lit = (c, x, y, r) => {
  P.smoker_front(c, x, y, r);
  for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < 6; xx++) {
    const d = Math.hypot(xx - 3, yy - 3.2);
    px(c, x, y, 5 + xx, 9 + yy, d < 1.6 ? '#ffd23c' : d < 2.4 ? '#ffa832' : '#ff6a00');
  }
  for (let i = 0; i < 3; i++) px(c, x, y, 5 + r() * 6, 9 + r() * 3, '#ffe27a');   // embers
  rect(c, x, y, 5, 8, 6, 1, 'rgba(255,138,26,0.35)');
};
P.fletching_table_top = (c, x, y, r) => { planks(c, x, y, r, '#c8b070'); rect(c, x, y, 3, 3, 1, 10, '#3a3a3a'); rect(c, x, y, 3, 3, 8, 1, '#3a3a3a'); rect(c, x, y, 6, 6, 5, 5, '#5a5a5a'); };
P.fletching_table_side = (c, x, y, r) => { planks(c, x, y, r, '#b89a5a'); rect(c, x, y, 4, 2, 1, 12, '#3a3a3a'); rect(c, x, y, 8, 4, 1, 8, '#3a3a3a'); };
P.hay_bale_top = (c, x, y, r) => { noise(c, x, y, r, '#c8a828', 8); border(c, x, y, '#8a7018'); rect(c, x, y, 7, 0, 2, 16, '#8a7018'); rect(c, x, y, 0, 7, 16, 2, '#8a7018'); };
P.hay_bale_side = (c, x, y, r) => { noise(c, x, y, r, '#d4b432', 6); for (let i = 2; i < 16; i += 4) rect(c, x, y, 0, i, 16, 1, '#a88a20'); rect(c, x, y, 3, 0, 2, 16, '#7a6414'); rect(c, x, y, 11, 0, 2, 16, '#7a6414'); };

// ============ 11-END §14 — End blocks ============
// stone-brick 4×4 masonry grid.
function brickGrid(c, x, y, r, base) {
  noise(c, x, y, r, base, 8);
  for (let i = 0; i <= 16; i += 4) { rect(c, x, y, 0, i - (i === 16 ? 1 : 0), 16, 1, '#565656'); rect(c, x, y, i - (i === 16 ? 1 : 0), 0, 1, 16, '#565656'); }
}
P.stone_bricks = (c, x, y, r) => brickGrid(c, x, y, r, '#7f7f7f');
P.mossy_stone_bricks = (c, x, y, r) => { brickGrid(c, x, y, r, '#7f7f7f'); speckle(c, x, y, r, '#5d7a4a', 0.25); };
P.cracked_stone_bricks = (c, x, y, r) => { brickGrid(c, x, y, r, '#787878'); for (let i = 0; i < 6; i++) px(c, x, y, 2 + ((r() * 12) | 0), 2 + ((r() * 12) | 0), '#3f3f3f'); };
P.iron_bars = (c, x, y, r) => { for (const bx of [1, 5, 9, 13]) rect(c, x, y, bx, 0, 1, 16, '#a8a8a8'); rect(c, x, y, 0, 0, 16, 1, '#a8a8a8'); rect(c, x, y, 0, 15, 16, 1, '#a8a8a8'); noise(c, x, y, r, '#00000000', 2); };
P.end_stone = (c, x, y, r) => { blotch(c, x, y, r, '#dbe2a4', '#c8cf8e', 10); speckle(c, x, y, r, '#eef2c0', 0.06); };
P.end_stone_bricks = (c, x, y, r) => { blotch(c, x, y, r, '#dbe2a4', '#c8cf8e', 8); for (let i = 0; i <= 16; i += 4) { rect(c, x, y, 0, Math.min(i, 15), 16, 1, '#b5bc7f'); rect(c, x, y, Math.min(i, 15), 0, 1, 16, '#b5bc7f'); } };
P.purpur_block = (c, x, y, r) => { noise(c, x, y, r, '#a878a8', 6); for (let i = 0; i < 5; i++) { const bx = 2 + ((r() * 10) | 0), by = 2 + ((r() * 10) | 0); rect(c, x, y, bx, by, 3, 3, '#c39cc3'); px(c, x, y, bx, by, '#8a5f8a'); } };
P.purpur_pillar_side = (c, x, y, r) => { noise(c, x, y, r, '#a878a8', 6); rect(c, x, y, 3, 0, 2, 16, '#8a5f8a'); rect(c, x, y, 12, 0, 2, 16, '#8a5f8a'); };
P.purpur_pillar_top = (c, x, y, r) => rings(c, x, y, r, '#c39cc3', '#a878a8');
P.end_rod = (c, x, y, r) => { rect(c, x, y, 0, 0, 16, 16, '#00000000'); rect(c, x, y, 7, 2, 2, 12, '#f6f0fa'); rect(c, x, y, 7, 1, 2, 1, '#d67fff'); rect(c, x, y, 5, 12, 6, 3, '#a878a8'); };
P.chorus_plant = (c, x, y, r) => { noise(c, x, y, r, '#5c4a72', 8); border(c, x, y, '#46375a'); speckle(c, x, y, r, '#7a6396', 0.10); };
P.chorus_flower = (c, x, y, r) => { noise(c, x, y, r, '#f4eef8', 6); border(c, x, y, '#5c4a72'); rect(c, x, y, 6, 6, 4, 4, '#c39cc3'); };
P.end_portal_frame_top = (c, x, y, r) => { P.end_stone(c, x, y, r); rect(c, x, y, 4, 4, 8, 8, '#3a5f4a'); rect(c, x, y, 6, 6, 4, 4, '#2a4636'); };
P.end_portal_frame_top_eye = (c, x, y, r) => { P.end_portal_frame_top(c, x, y, r); rect(c, x, y, 5, 5, 6, 6, '#7fe3c8'); rect(c, x, y, 7, 6, 2, 4, '#143028'); };
P.end_portal_frame_side = (c, x, y, r) => { P.end_stone(c, x, y, r); rect(c, x, y, 0, 5, 16, 4, '#46375a'); };
P.shulker_box_side = (c, x, y, r) => { noise(c, x, y, r, '#976b97', 6); rect(c, x, y, 0, 8, 16, 1, '#6e4a6e'); for (const [px_, py_] of [[1, 1], [13, 1], [1, 13], [13, 13]]) rect(c, x, y, px_, py_, 2, 2, '#c39cc3'); };
P.shulker_box_top = (c, x, y, r) => { noise(c, x, y, r, '#a878a8', 6); rect(c, x, y, 3, 3, 10, 10, '#c39cc3'); border(c, x, y, '#6e4a6e'); };
P.shulker_box_bottom = (c, x, y, r) => { noise(c, x, y, r, '#7a5a7a', 6); border(c, x, y, '#5a3a5a'); };

// ============ 13-BOSSES §2.5 — boss block tiles ============
P.dragon_egg = (c, x, y, r) => { noise(c, x, y, r, '#0c0912', 8); speckle(c, x, y, r, '#3a2a55', 0.12); border(c, x, y, '#1b1029'); };
P.wither_skeleton_skull = (c, x, y, r) => {
  noise(c, x, y, r, '#4a4a44', 8);
  rect(c, x, y, 4, 5, 2, 2, '#000000'); rect(c, x, y, 10, 5, 2, 2, '#000000');   // eye sockets
  rect(c, x, y, 7, 8, 2, 2, '#111111');                                          // nasal slit
  rect(c, x, y, 5, 11, 6, 1, '#1a1a1a');                                         // grim mouth
};
P.beacon_base = (c, x, y, r) => noise(c, x, y, r, '#1b1029', 6);
P.beacon_shell = (c, x, y) => glassy(c, x, y, '#c9dbdc');
P.beacon_core = (c, x, y, r) => { noise(c, x, y, r, '#62e9d8', 5); rect(c, x, y, 5, 5, 6, 6, '#a6fff2'); };

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
// Dust: two shapes (dot 6×6 centred, line 4 px wide full-width) × 16 power
// variants, each the §14 grayscale `noise(#b0b0b0, 12)` multiplied by the §4.5
// brightness ramp at BUILD time — the mesher just picks the variant by state
// power (bits0–3), so a power change is a pure UV swap. Only the shape pixels
// are painted; the rest of the tile stays transparent so the cutout alpha test
// trims the mesher's sub-rect quads (an arm samples a 5×6 px window out of a
// 4 px band, the surround must vanish). The band is a constant 4 px centred on
// the tile's cross-axis with no directional motif, so any sub-window along its
// length reads the same way round.
const DUST_GRAY = '#b0b0b0';
// §4.5 ramp for power p (f = p/15) folded into the base grey; grain() then
// applies its per-pixel factor on top, which is the same as tinting afterwards.
function dustHex(p) {
  const f = p / 15;
  const [g0] = hexToRgb(DUST_GRAY);
  return rgbHex(g0 * (0.4 + 0.6 * f),
                g0 * Math.max(0, 0.7 * f * f - 0.5),
                g0 * Math.max(0, 0.6 * f * f - 0.7));
}
// §14 is ONE grayscale texture × 16 tints, so all 32 dust tiles must share a
// single grain field: the per-tile-name rng the atlas hands in is deliberately
// ignored (it would give every power its own noise, breaking the ramp's
// monotonicity and making the centre dot mismatch the arms it butts against).
const DUST_SEED = xmur3('dust')();
function dustShape(c, x, y, p, sx, sy, sw, sh) {
  c.save();
  c.beginPath(); c.rect(x + sx * K, y + sy * K, sw * K, sh * K); c.clip();
  noise(c, x, y, mulberry32(DUST_SEED), dustHex(p), 12);
  c.restore();
}
for (let p = 0; p < 16; p++) {
  P['dust_dot_' + p] = (c, x, y) => dustShape(c, x, y, p, 5, 5, 6, 6);
  P['dust_line_' + p] = (c, x, y) => dustShape(c, x, y, p, 0, 6, 16, 4);
}
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
// 06 §4 — ice. The 0.8 globalAlpha is load-bearing and deliberate: ice is the
// only translucent full cube, and the water/sea floor must read through it.
// Overdrawn texels composite to 0.96, which is exactly what makes a fissure
// read as denser, whiter ice rather than a painted line.
//
// The recipe used to be fine noise plus two straight 6-px anti-diagonal runs of
// #e8f4ff. Those put every tile's marks on the global anti-diagonals x+y ≡ 12
// and ≡ 6 (mod 16), so a frozen ocean grew endless dashed diagonal lines
// instead of cracks — the "a little off" look. Now: the same fine coherent
// grain (deliberately fine — wide grain cells give the tile a soft corner-to-
// corner gradient, which over a frozen ocean reads as a 1-block GRID), three
// short seeded random-walk fissures that never line up tile-to-tile, and two
// darker trapped bubbles for depth. Everything is inset 2 px so no mark touches
// a tile edge and chains into its neighbour. Low contrast throughout: the sheet
// should read as ice, not as a pattern.
//
// The three fissure seeds are STRATIFIED, not free: a frozen ocean is one 16×16
// tile repeated on a 1-block grid, so any clustering in the tile repeats as a
// conspicuous glyph. Free `3 + r()*10` starts put all three walks in one corner
// (rendered and rejected). One seed per quadrant of a 2×2 grid, with the unused
// quadrant chosen by the rng, spreads the marks and keeps the repeat reading as
// texture. QUAD origins are inset so a 4–6 step walk stays inside 2..13.
const ICE_QUAD = [[2, 2], [9, 2], [2, 9], [9, 9]];
P.ice = (c, x, y, r) => {
  c.save(); c.globalAlpha = 0.8;
  noise(c, x, y, r, '#9ecdfb', 4);
  // 8-neighbour walk that turns by ±45° and REFLECTS off the inset bounds —
  // clamping instead would let a walk slide along the bound and lay down a
  // straight axis-aligned run, i.e. the same chaining defect in a new direction.
  const D8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const skip = Math.floor(r() * 4);
  for (let i = 0, q = 0; i < 3; i++, q++) {
    if (q === skip) q++;
    const [qx, qz] = ICE_QUAD[q];
    let fx = qx + Math.floor(r() * 5), fy = qz + Math.floor(r() * 5);
    let d = Math.floor(r() * 8);
    const len = 4 + Math.floor(r() * 3);
    for (let s = 0; s < len; s++) {
      px(c, x, y, fx, fy, s === 0 ? '#dcedff' : '#cbe3fb');
      if (r() < 0.4) d = (d + (r() < 0.5 ? 1 : 7)) & 7;
      fx += D8[d][0]; fy += D8[d][1];
      if (fx < 2 || fx > 13) { fx = Math.max(2, Math.min(13, fx)); d = (d + 4) & 7; }
      if (fy < 2 || fy > 13) { fy = Math.max(2, Math.min(13, fy)); d = (d + 4) & 7; }
    }
  }
  px(c, x, y, 2 + r() * 12, 2 + r() * 12, '#82b5e7');
  px(c, x, y, 2 + r() * 12, 2 + r() * 12, '#82b5e7');
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
    noise(c, x, y, r, cHex, 5);
    const dark = shadeHex(cHex, 0.9), lite = shadeHex(cHex, 1.08);
    // soft fabric weave: column dashes alternate offset row-band by row-band
    for (let band = 0; band < 4; band++) {
      const y0b = band * 4;
      rect(c, x, y, 0, y0b + 3, 16, 1, dark);                // horizontal weave shadow
      const off = band & 1 ? 2 : 0;
      for (let bx = off; bx < 16; bx += 4) {
        rect(c, x, y, bx, y0b, 1, 3, dark);                  // vertical warp shadow
        px(c, x, y, bx + 1, y0b + 1, lite);                  // weft glint
      }
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

// --- animated tiles (4 frames each for water/lava/fire/furnace) --------------
// All four-frame loops advance phase by f/4 of a cycle, so frame 4 wraps
// seamlessly back onto frame 0.
const WATER_HI = '#7fb3ff';
const waterFrame = f => (c, x, y, r) => {
  const hue = [0, 0.05, 0, -0.05][f];                        // subtle hue shift per frame
  grain(c, x, y, r, '#3f76e4', { amp: 8, cellX: 5, cellY: 2, dither: 3 });
  const [br, bg, bb] = hexToRgb('#3f76e4');
  for (let yy = 0; yy < 16; yy++) {                          // gentle wave bands drifting
    const w = Math.sin((yy / 16) * Math.PI * 2 + (f / 4) * Math.PI * 2);
    if (w < 0.4) continue;
    const strength = (w - 0.4) / 0.6;
    for (let xx = 0; xx < 16; xx++) {
      if (r() < 0.75 - strength * 0.45) continue;
      const k = 1 + 0.18 * strength;
      px(c, x, y, xx, yy, css(br * k, bg * k, Math.min(255, bb * k + hue * 255)));
    }
  }
  for (let i = 0; i < 4; i++)                                // sparkles
    if (r() < 0.6) px(c, x, y, (r() * 16) | 0, (r() * 16) | 0, WATER_HI);
};
const lavaFrame = f => (c, x, y, r) => {
  fluid(c, x, y, r, '#d45a12');
  const drift = (f * 4) % 16;                                // crust drifts; frame 4 ≡ frame 0
  const crust = new Set();
  for (let i = 0; i < 5; i++) {                              // crust islands
    let bx = (r() * 16) | 0, by = (r() * 16) | 0;
    for (let s = 0; s < 6; s++) {
      const cx = ((bx + drift) & 15) | 0;
      crust.add(cx * 16 + (by & 15));
      px(c, x, y, cx, by & 15, r() < 0.3 ? '#5a2a0c' : '#7a3a10');
      bx += (r() * 3 | 0) - 1; by += (r() * 3 | 0) - 1;
    }
  }
  for (const key of crust) {                                 // glowing cracks between crusts
    const cx = (key / 16) | 0, cy = key % 16;
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const nx = (cx + dx) & 15, ny = cy + dy;
      if (crust.has(nx * 16 + ny) || r() < 0.55) continue;
      px(c, x, y, nx, ny, r() < 0.4 ? '#ffe27a' : '#f8b613');
    }
  }
  for (let i = 0; i < 20; i++)                               // drifting bright flecks
    px(c, x, y, ((r() * 16) + drift) & 15, (r() * 16) | 0, '#f8b613');
};
const fireFrame = f => (c, x, y, r) => {
  for (let xx = 0; xx < 16; xx++) {
    const base = r() * 8;                                    // per-column base height
    const h = 7 + Math.round((base + f * 2) % 9);            // advances per frame, wraps
    for (let yy = 15; yy > 15 - h; yy--) {
      if (r() < 0.35) continue;                              // flicker transparency
      const t = (15 - yy) / h;                               // 0 base → 1 tip
      const center = 1 - Math.abs(xx - 7.5) / 8;
      let col;
      if (t < 0.3 + center * 0.2) col = '#fff6d8';           // white-hot core near base
      else if (t < 0.55) col = '#ffd23c';                    // mid yellow
      else col = '#ff9a00';                                  // outer orange tongues
      px(c, x, y, xx, yy, col);
    }
  }
};
const furnaceLitFrame = f => (c, x, y, r) => {
  noise(c, x, y, r, '#6f6f6f', 8);
  border(c, x, y, '#565656');
  rect(c, x, y, 5, 9, 6, 5, '#5a1a08');                      // dark firebox
  const rr = 2.9 + [0, 0.35, 0.15, 0.45][f];                 // flicker radius per frame
  for (let yy = 0; yy < 5; yy++) for (let xx = 0; xx < 6; xx++) {
    const d = Math.hypot(xx - 2.5, (yy - 3.4) * 1.25);
    const t = 1 - d / rr;
    if (t <= 0) continue;
    px(c, x, y, 5 + xx, 9 + yy,
       t > 0.78 ? '#ffd23c' : t > 0.55 ? '#ffa832' : t > 0.32 ? '#ff8a1a' : '#e0520a');
  }
  rect(c, x, y, 5, 8, 6, 1, 'rgba(255,138,26,0.35)');        // heat shimmer above mouth
  for (let i = 0; i < 4 + f; i++)                            // rising embers, more each frame
    px(c, x, y, 5 + r() * 6, 9 + r() * 5, '#ffd23c');
};
// 11-END §14 — end_portal / end_gateway drifting starfield (2-frame twinkle).
const endStarFrame = (dark) => (c, x, y, r) => {
  rect(c, x, y, 0, 0, 16, 16, '#0a0714');
  const cols = ['#8fd8c8', '#d67fff', '#ffffff'];
  for (let i = 0; i < 60; i++) {
    const sx = (r() * 16) | 0, sy = (r() * 16) | 0;
    if (((sx + sy) & 1) === (dark ? 1 : 0)) continue;   // alternate visible set per frame
    px(c, x, y, sx, sy, cols[(r() * 3) | 0]);
  }
  if (dark) rect(c, x, y, 4, 4, 8, 8, '#000000');       // gateway dark core hint
};
export const ANIMATED = {
  water: [0, 1, 2, 3].map(waterFrame),
  lava: [0, 1, 2, 3].map(lavaFrame),
  fire: [0, 1, 2, 3].map(fireFrame),
  furnace_front_lit: [0, 1, 2, 3].map(furnaceLitFrame),
  end_portal: [endStarFrame(false), endStarFrame(true)],
  end_gateway: [(c, x, y, r) => { endStarFrame(false)(c, x, y, r); rect(c, x, y, 4, 4, 8, 8, '#000000'); },
                (c, x, y, r) => { endStarFrame(true)(c, x, y, r); rect(c, x, y, 3, 3, 10, 10, '#000000'); }],
};
P.water = ANIMATED.water[0];
P.lava = ANIMATED.lava[0];
P.fire = ANIMATED.fire[0];
P.furnace_front_lit = ANIMATED.furnace_front_lit[0];
P.end_portal = ANIMATED.end_portal[0];
P.end_gateway = ANIMATED.end_gateway[0];

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
  golden: '#fdf55f', diamond: '#4aedd9', netherite: '#6a6068',
};
const ARMOR_TIERS = {
  leather: '#a0522d', golden: '#fdf55f', iron: '#d8d8d8', diamond: '#4aedd9',
  netherite: '#6a6068',
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
  return (c, x, y, r) => crossSprite(c, x, y, map, palette, r);
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

// ---- 10-NETHER item sprites ----
P.item_nether_wart = (c, x, y) => {
  disc(c, x, y, 8, 9, 4, '#8a0a15');
  px(c, x, y, 6, 7, '#c0202c'); px(c, x, y, 10, 8, '#c0202c');
  px(c, x, y, 8, 4, '#5a0710'); px(c, x, y, 9, 5, '#5a0710');
};
P.item_blaze_rod = (c, x, y) => {
  for (let i = 0; i < 11; i++) { px(c, x, y, 4 + i, 12 - i, '#f5c518'); px(c, x, y, 5 + i, 12 - i, '#e88a10'); }
  px(c, x, y, 4, 12, '#fff2a0'); px(c, x, y, 14, 2, '#fff2a0');
};
P.item_blaze_powder = (c, x, y, r) => {
  for (let i = 0; i < 26; i++) px(c, x, y, 3 + (r() * 10 | 0), 3 + (r() * 10 | 0), r() < 0.5 ? '#f5a020' : '#f5d030');
};
P.item_magma_cream = (c, x, y) => {
  disc(c, x, y, 8, 8, 4, '#3a2a1a');
  px(c, x, y, 6, 6, '#f5a020'); px(c, x, y, 9, 7, '#f5c518'); px(c, x, y, 7, 9, '#e88a10');
};
P.item_ghast_tear = (c, x, y) => {
  disc(c, x, y, 8, 9, 3, '#cfeae0');
  px(c, x, y, 8, 4, '#eafaf4'); px(c, x, y, 8, 5, '#dff5ee');
  px(c, x, y, 7, 8, '#f4fefb');
};
P.item_glowstone_dust = (c, x, y, r) => {
  for (let i = 0; i < 24; i++) px(c, x, y, 3 + (r() * 10 | 0), 3 + (r() * 10 | 0), r() < 0.5 ? '#f5e07a' : '#e0b840');
};
P.item_gold_nugget = (c, x, y) => {
  disc(c, x, y, 8, 8, 3, '#f9ec4e');
  px(c, x, y, 7, 7, '#fdf7a0'); px(c, x, y, 9, 9, '#d4b82a');
};
P.item_nether_quartz = (c, x, y) => {
  disc(c, x, y, 8, 8, 4, '#e8e0d8');
  px(c, x, y, 6, 6, '#ffffff'); px(c, x, y, 9, 9, '#c8bcae'); px(c, x, y, 10, 6, '#f4efe8');
};
P.item_nether_brick = (c, x, y) => {
  rect(c, x, y, 4, 6, 8, 5, '#3a1a1c');
  rect(c, x, y, 4, 8, 8, 1, '#5a2a2e');
  px(c, x, y, 4, 6, '#5a2a2e'); px(c, x, y, 11, 10, '#241012');
};
// 10-NETHER §9 — netherite tier materials
P.item_netherite_scrap = (c, x, y) => {
  disc(c, x, y, 8, 8, 4, '#7a5a4e');
  px(c, x, y, 6, 6, '#a08070'); px(c, x, y, 10, 7, '#5a3f36');
  px(c, x, y, 5, 10, '#4a3028'); px(c, x, y, 11, 10, '#8a6a5c');
};
P.item_netherite_ingot = ingot('#5a545e', '#39343e', '#7c7482');

// ---- 09-POTIONS item sprites ----
// Bottle base shared by potion/splash/lingering; the per-potionId tint is applied
// by the runtime bottle-icon pipeline (§12.3) — the atlas holds a neutral bottle.
const bottleBase = (c, x, y, liquid) => {
  rect(c, x, y, 6, 2, 4, 2, '#caa06a');                  // cork
  rect(c, x, y, 6, 4, 4, 2, '#d8e6ee');                  // neck
  rect(c, x, y, 4, 6, 8, 8, '#c8dce6');                  // glass body
  rect(c, x, y, 5, 8, 6, 5, liquid);                     // liquid
  px(c, x, y, 4, 6, '#eef6fa'); px(c, x, y, 5, 7, '#eef6fa');
};
P.item_glass_bottle = (c, x, y) => {
  rect(c, x, y, 6, 2, 4, 2, '#caa06a');
  rect(c, x, y, 6, 4, 4, 2, '#d8e6ee');
  rect(c, x, y, 4, 6, 8, 8, '#c8dce6'); rect(c, x, y, 6, 8, 4, 5, '#aecad8');
};
P.item_potion = (c, x, y) => bottleBase(c, x, y, '#385DC6');
P.item_splash_potion = (c, x, y) => { bottleBase(c, x, y, '#385DC6'); rect(c, x, y, 5, 2, 6, 1, '#8A8A8A'); };
P.item_lingering_potion = (c, x, y) => { bottleBase(c, x, y, '#385DC6'); px(c, x, y, 6, 14, '#8A8A8A'); px(c, x, y, 8, 15, '#8A8A8A'); px(c, x, y, 10, 14, '#8A8A8A'); };

// 11-END §14 — item sprites (auto-collected via 'item_' prefix).
P.item_eye_of_ender = (c, x, y) => { disc(c, x, y, 8, 8, 6, '#7fe3c8'); rect(c, x, y, 7, 5, 2, 6, '#143028'); px(c, x, y, 6, 6, '#c8fff0'); px(c, x, y, 10, 6, '#c8fff0'); };
P.item_chorus_fruit = (c, x, y) => { for (const [cx, cy, rr] of [[6, 6, 3], [10, 7, 2], [7, 10, 2], [10, 10, 2]]) disc(c, x, y, cx, cy, rr, '#5c4a72'); px(c, x, y, 6, 6, '#7a6396'); px(c, x, y, 10, 10, '#7a6396'); };
P.item_popped_chorus_fruit = (c, x, y) => { for (const [cx, cy, rr] of [[6, 6, 3], [10, 7, 2], [7, 10, 2], [10, 10, 2]]) disc(c, x, y, cx, cy, rr, '#c39cc3'); px(c, x, y, 6, 6, '#f4eef8'); px(c, x, y, 10, 10, '#f4eef8'); };
P.item_shulker_shell = (c, x, y) => { rect(c, x, y, 2, 8, 12, 4, '#976b97'); for (let i = 0; i < 8; i++) rect(c, x, y, 2 + i * 12 / 8, 4, 2, 5, '#8a5f8a'); rect(c, x, y, 3, 3, 10, 3, '#a878a8'); px(c, x, y, 5, 4, '#c39cc3'); };
P.item_elytra = (c, x, y) => { for (const s of [-1, 1]) { const bx = 8 + s * 1; for (let i = 0; i < 12; i++) rect(c, x, y, bx + s * (i < 6 ? 0 : 1), 2 + i, s > 0 ? 5 : -5 + 5, 1, '#4a4a52'); } rect(c, x, y, 2, 3, 5, 11, '#4a4a52'); rect(c, x, y, 9, 3, 5, 11, '#4a4a52'); for (let i = 4; i < 14; i += 3) { rect(c, x, y, 2, i, 5, 1, '#8a8a96'); rect(c, x, y, 9, i, 5, 1, '#8a8a96'); } rect(c, x, y, 7, 2, 2, 6, '#2a2a30'); };
P.item_elytra_tattered = (c, x, y) => { P.item_elytra(c, x, y); for (const [px_, py_] of [[3, 6], [4, 10], [11, 5], [12, 9], [10, 12]]) rect(c, x, y, px_, py_, 2, 2, '#00000000'); };

// 13-BOSSES §2.5 — boss item sprites.
P.item_nether_star = (c, x, y) => {
  rect(c, x, y, 7, 2, 2, 12, '#ffffff'); rect(c, x, y, 2, 7, 12, 2, '#ffffff');   // 4-point star arms
  rect(c, x, y, 6, 6, 4, 4, '#fff8c4');                                            // inner glow
  px(c, x, y, 8, 2, '#8adfdf'); px(c, x, y, 8, 13, '#8adfdf'); px(c, x, y, 2, 8, '#8adfdf'); px(c, x, y, 13, 8, '#8adfdf');
};
P.item_end_crystal = (c, x, y) => {
  for (let i = 0; i < 5; i++) { rect(c, x, y, 8 - i, 3 + i, 2 * i + 1, 1, '#e079fa'); rect(c, x, y, 4 + i, 12 - i, 9 - 2 * i, 1, '#e079fa'); }
  rect(c, x, y, 7, 7, 2, 2, '#ffffff'); rect(c, x, y, 5, 13, 6, 2, '#8a8a8a');     // white core over gray base bar
};
P.item_dragon_breath = (c, x, y) => { disc(c, x, y, 8, 9, 5, '#c8dce6'); rect(c, x, y, 6, 2, 4, 4, '#caa06a'); disc(c, x, y, 8, 9, 3, '#e079fa'); };
P.item_spider_eye = (c, x, y) => { disc(c, x, y, 8, 8, 4, '#7a1f24'); disc(c, x, y, 8, 8, 2, '#c85a1a'); px(c, x, y, 8, 8, '#1a1a1a'); };
P.item_fermented_spider_eye = (c, x, y) => { disc(c, x, y, 8, 8, 4, '#3a5a34'); disc(c, x, y, 8, 8, 2, '#6a8a3a'); px(c, x, y, 8, 8, '#1a1a1a'); };
P.item_golden_apple = (c, x, y) => { disc(c, x, y, 8, 9, 4, '#fcd94a'); px(c, x, y, 8, 4, '#6a4a20'); rect(c, x, y, 6, 6, 2, 2, '#fff2a0'); };
P.item_golden_carrot = (c, x, y) => { for (let i = 0; i < 7; i++) px(c, x, y, 4 + i, 12 - i, '#f5c518'); for (let i = 0; i < 7; i++) px(c, x, y, 5 + i, 12 - i, '#d4a017'); rect(c, x, y, 10, 3, 3, 2, '#3aa53a'); };
P.item_tipped_arrow = (c, x, y) => {
  for (let i = 0; i < 12; i++) px(c, x, y, 2 + i, 13 - i, '#c8b088');   // shaft
  rect(c, x, y, 11, 1, 3, 3, '#88c0e0');                                 // tinted head
  px(c, x, y, 2, 13, '#e0e0e0'); px(c, x, y, 3, 12, '#e0e0e0');          // fletching
};
P.item_diamond = (c, x, y) => {
  const d = '#4aedd9', s = '#2bbfae', w = '#d8fff8';
  rect(c, x, y, 5, 4, 6, 2, d);
  rect(c, x, y, 4, 6, 8, 2, d);
  rect(c, x, y, 5, 8, 6, 1, s);
  rect(c, x, y, 6, 9, 4, 1, s);
  rect(c, x, y, 7, 10, 2, 1, s);
  px(c, x, y, 6, 5, w); px(c, x, y, 5, 6, w);
};
// 12-VILLAGES §7 — emerald gem (village trade currency).
P.item_emerald = (c, x, y) => {
  const d = '#17dd62', s = '#0f9b45', w = '#b6ffcf';
  rect(c, x, y, 6, 3, 4, 2, d);
  rect(c, x, y, 5, 5, 6, 3, d);
  rect(c, x, y, 4, 8, 8, 2, s);
  rect(c, x, y, 6, 10, 4, 2, s);
  px(c, x, y, 7, 4, w); px(c, x, y, 6, 6, w);
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
// 08 §2.4 — the base book silhouette recolored to a violet cover, keeping the
// page-edge column. The glint is NOT baked in: §11 composites it over the icon
// at runtime (source-atop), so this sprite must stay plain.
P.item_enchanted_book = (c, x, y) => {
  rect(c, x, y, 3, 3, 10, 10, '#6b2f7a');           // violet cover
  rect(c, x, y, 11, 4, 2, 9, '#e9e9e9');            // page edge column
  rect(c, x, y, 3, 3, 1, 10, '#4a1f55');            // spine
  rect(c, x, y, 6, 7, 2, 2, '#4aedd9');             // 2×2 clasp
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

// §6 — bevel sweep: every item sprite (tools, armor, food, materials) gets the
// lit-rim + shadow-outline silhouette treatment in one pass. Runs after all
// P.item_* assignments; edge factors only touch pixels bordering transparency.
for (const key of Object.keys(P)) {
  if (key.startsWith('item_')) P[key] = beveled(P[key]);
}
