// OVERHAUL §H — pixel-art HUD status icons. The emoji glyphs (❤ 🍗 🛡 🫧) are
// replaced by a procedurally painted 9×9 sprite sheet (2× = 18px cells), so
// hearts/hunger/armor/air match the atlas's art direction exactly and scale
// crisply on any DPR. Pure canvas-2d; the dataURL is built lazily on first
// use and cached. Tints (poison/wither/hunger effect) ride CSS filters.

const CELL = 18;               // 9×9 art at 2×
export const PIP_CELL = CELL;

// Frame order on the sheet (one row).
export const PIP = {
  HEART_FULL: 0, HEART_HALF: 1, HEART_EMPTY: 2,
  FOOD_FULL: 3, FOOD_HALF: 4, FOOD_EMPTY: 5,
  ARMOR_FULL: 6, ARMOR_HALF: 7, ARMOR_EMPTY: 8,
  BUBBLE: 9,
  ABSORB_FULL: 10, ABSORB_HALF: 11, ABSORB_EMPTY: 12,
};

// Heart silhouette (8 rows of 9) — W highlight, X body, D shadow.
const HEART = [
  '.XX...XX.',
  'XWXXXXXXX',
  'XXXXXXXDX',
  'XXXXXXXXX',
  '.XXXXXDX.',
  '..XXXXX..',
  '...XXX...',
  '....X....',
];
// Drumstick — M meat, S meat shadow, B bone.
const FOOD = [
  '.....SS..',
  '....SMMS.',
  '....MMMM.',
  '...MMMM..',
  '..MMMM...',
  '.BMMM....',
  'BBB......',
  '.B.......',
];
// Chestplate — M metal, S dark edge, W shine.
const ARMOR = [
  'XXX...XXX',
  'XWMXXXMXX',
  'XXXXMXXXX',
  '.XXXXXXX.',
  '.XXXXXXX.',
  '.SXXXXXS.',
  '..SSSSS..',
];
// Air bubble — B body, W shine.
const BUBBLE = [
  '..XXXXX..',
  '.XWWXXXX.',
  '.XWXXXXX.',
  '.XXXXXXX.',
  '.XXXXXXX.',
  '.XXXXXXX.',
  '..XXXXX..',
];

function paintMap(ctx, x0, y0, rows, pal, scale = 2) {
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < 9 && x < row.length; x++) {
      const c = pal[row[x]];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(x0 + x * scale, y0 + y * scale, scale, scale);
    }
  }
}

function heartPal(main, light, dark) {
  return { X: main, W: light, D: dark };
}

// Half variants: columns 0–4 from the full palette, 5–8 from the empty one.
function paintHalf(ctx, x0, y0, rows, fullPal, emptyPal, scale = 2) {
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < 9 && x < row.length; x++) {
      const pal = x <= 4 ? (fullPal ?? emptyPal) : (emptyPal ?? fullPal);
      const c = pal[row[x]];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(x0 + x * scale, y0 + y * scale, scale, scale);
    }
  }
}

let sheetUrl = null;

export function pipSheetUrl() {
  if (sheetUrl) return sheetUrl;
  const n = 13;
  const canvas = document.createElement('canvas');
  canvas.width = n * CELL;
  canvas.height = CELL;
  const ctx = canvas.getContext('2d');

  const red = heartPal('#e0241c', '#ff6a5e', '#8e130d');
  const redEmpty = heartPal('#3a0d0d', '#4d1a16', '#240705');
  const gold = heartPal('#f5c51e', '#ffe98a', '#9a7508');
  const goldEmpty = heartPal('#3a2d05', '#4d3d10', '#241c04');
  const meat = { M: '#c77e3e', S: '#8e5526', B: '#ececec' };
  const meatEmpty = { M: '#3c2a1c', S: '#2a1d13', B: '#555' };
  const metal = { X: '#c9cbd6', W: '#f2f3f8', S: '#6f7280', M: '#9fa3b2' };
  const metalEmpty = { X: '#3a3c46', W: '#4c4f5c', S: '#23252c', M: '#30323c' };
  const bubble = { X: '#9ad6f2', W: '#e8f9ff' };

  const at = i => i * CELL;
  paintMap(ctx, at(PIP.HEART_FULL), 0, HEART, red);
  paintHalf(ctx, at(PIP.HEART_HALF), 0, HEART, red, redEmpty);
  paintMap(ctx, at(PIP.HEART_EMPTY), 0, HEART, redEmpty);
  paintMap(ctx, at(PIP.FOOD_FULL), 0, FOOD, meat);
  paintHalf(ctx, at(PIP.FOOD_HALF), 0, FOOD, meat, meatEmpty);
  paintMap(ctx, at(PIP.FOOD_EMPTY), 0, FOOD, meatEmpty);
  paintMap(ctx, at(PIP.ARMOR_FULL), 0, ARMOR, metal);
  paintHalf(ctx, at(PIP.ARMOR_HALF), 0, ARMOR, metal, metalEmpty);
  paintMap(ctx, at(PIP.ARMOR_EMPTY), 0, ARMOR, metalEmpty);
  paintMap(ctx, at(PIP.BUBBLE), 0, BUBBLE, bubble);
  paintMap(ctx, at(PIP.ABSORB_FULL), 0, HEART, gold);
  paintHalf(ctx, at(PIP.ABSORB_HALF), 0, HEART, gold, goldEmpty);
  paintMap(ctx, at(PIP.ABSORB_EMPTY), 0, HEART, goldEmpty);

  sheetUrl = canvas.toDataURL('image/png');
  return sheetUrl;
}

/** One-time pip setup: the sheet as background, fixed cell box. */
export function stylePip(el) {
  el.style.backgroundImage = `url(${pipSheetUrl()})`;
  el.style.backgroundSize = `${13 * CELL}px ${CELL}px`;
  el.style.backgroundRepeat = 'no-repeat';
  el.style.imageRendering = 'pixelated';
}

/** Per-frame pip state: frame index or null to blank the pip. */
export function setPipFrame(el, frame) {
  if (frame == null) { el.style.backgroundImage = 'none'; return; }
  if (el.style.backgroundImage === 'none' || !el.style.backgroundImage) stylePip(el);
  el.style.backgroundPosition = `-${frame * CELL}px 0px`;
}
