// Inventory / crafting / furnace / chest screens + click semantics
// (06 §9 crafting, §10 recipes, §14 layout+clicks, §15.3 screens;
//  UPDATE-08 §7 offhand slot 45 + F-swap).
// Geometry: absolute GUI-px on a 176×166 reference panel (Java 1.20 survival
// coordinates), scaled uniformly by --gpx. Slot (x,y) = top-left INNER corner.
import { ITEMS, RECIPES, SMELTING, fuelValue } from '../registry/items.js';
import { iconCss, tileForItemId } from './hud.js';
import { emitSound, at, audio } from '../audio/engine.js';
import { TAB, buildPalette, searchPalette, visibleTabs } from './creativeTabs.js';
import { tagsEqual, cloneStack } from '../items/tags.js';

// 18 §6.1 — creative screen geometry, GUI px on its own reference panel (the
// survival panel is 176×166 and cannot hold a 9×5 palette + tab strip + the
// full personal inventory + a destroy slot).
const CV = {
  W: 196, H: 218,
  TAB_Y: 2, TAB_W: 18, TAB_H: 18,
  GRID_X: 8, GRID_Y: 24, COLS: 9, ROWS: 5,     // 45 visible cells (§6.1)
  BAR_X: 174,
  SEARCH_Y: 118,
  MAIN_Y: 138,                                  // 9×3 personal inventory
  HOTBAR_Y: 198,
  DESTROY_X: 178,
  INV_DX: 10, INV_DY: 24,                       // survival-tab layout offset
};

const stackMax = id => ITEMS.get(id)?.stack ?? 64;
// AMENDS 06 §14.2 (08 §1): stack-compatibility now requires deep-equal tags —
// a renamed or enchanted stack never merges with a plain one.
const same = (a, b) => a && b && a.id === b.id && (a.damage ?? 0) === (b.damage ?? 0)
  && tagsEqual(a, b);
// Split/copy a stack at a new count. Deep-clones tags so the two halves never
// share one object (08 §1 invariant 4) — a spread did, silently.
const withCount = (s, n) => { const c = cloneStack(s); c.count = n; return c; };

// ------------------------------------------------------------------------
// Shared recipe resolver (06 §9) — the ONLY matcher; serves 2×2 AND 3×3.
// ------------------------------------------------------------------------

function gridBounds(grid, w) {
  let x0 = 9, y0 = 9, x1 = -1, y1 = -1;
  for (let i = 0; i < grid.length; i++) {
    if (!grid[i]) continue;
    const x = i % w, y = (i / w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Trimmed bounding box of the PATTERN's non-empty chars (§4.2 step 2 —
// axe/hoe patterns carry an empty third column that must not block a match).
function patternBounds(rows) {
  const h = rows.length;
  const w = Math.max(...rows.map(r => r.length));
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x] ?? '.';
      if (ch !== '.' && ch !== ' ') {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function matchShaped(recipe, grid, gw) {
  const b = gridBounds(grid, gw);
  if (!b) return false;
  const rows = recipe.pattern;
  const pb = (recipe._pb ??= patternBounds(rows));
  if (b.w !== pb.w || b.h !== pb.h) return false;
  const tryMirror = mirror => {
    for (let y = 0; y < pb.h; y++) {
      for (let x = 0; x < pb.w; x++) {
        const px = pb.x0 + (mirror ? pb.w - 1 - x : x);
        const ch = rows[pb.y0 + y][px] ?? '.';
        const cell = grid[(b.y0 + y) * gw + (b.x0 + x)];
        if (ch === '.' || ch === ' ') {
          if (cell) return false;          // filled cell where pattern is blank
        } else {
          const ids = recipe.key[ch];
          if (!cell || !ids || !ids.includes(cell.id)) return false;
        }
      }
    }
    return true;
  };
  return tryMirror(false) || tryMirror(true);
}

function matchShapeless(recipe, grid) {
  const items = grid.filter(Boolean);
  if (items.length !== recipe.ingredients.length) return false;
  const pool = [...items];
  for (const ids of recipe.ingredients) {
    const idx = pool.findIndex(s => ids.includes(s.id));
    if (idx < 0) return false;
    pool.splice(idx, 1);
  }
  return true;
}

// resolveCraft(gridItems, W[, H]) → matching recipe or null. Consumption is
// always "one from each non-empty cell" for the 06 §10 recipe set.
export function findRecipe(grid, gw) {
  for (const r of RECIPES) {
    if (r.shaped ? matchShaped(r, grid, gw) : matchShapeless(r, grid)) return r;
  }
  return null;
}
export const resolveCraft = findRecipe;

// ------------------------------------------------------------------------
// Screens (absolute GUI-px geometry per UPDATE §2.2/§3.1)
// ------------------------------------------------------------------------

export class Containers {
  constructor(game, screensEl) {
    this.game = game;
    this.root = document.createElement('div');
    this.root.id = 'container-root';
    screensEl.appendChild(this.root);
    this.cursorEl = document.createElement('div');
    this.cursorEl.id = 'cursor-stack';
    this.cursorEl.innerHTML = `<div></div><div class="slot-count"></div>`;
    document.body.appendChild(this.cursorEl);
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.id = 'tooltip';
    document.body.appendChild(this.tooltipEl);

    this.cursor = null;
    this.kind = null;
    this.pos = null;
    this.slots = [];
    this.craftGrid = null;
    this.craftW = 2;
    this.hovered = null;
    this.lastClick = { time: 0, index: -1 };
    // 18 §6 creative-screen state
    this.tab = TAB.BUILDING;
    this.scroll = 0;                 // first visible ROW of the current tab
    this.search = '';

    document.addEventListener('mousemove', e => {
      this.mouseX = e.clientX; this.mouseY = e.clientY;
      if (this.cursor) {
        this.cursorEl.style.left = e.clientX + 'px';
        this.cursorEl.style.top = e.clientY + 'px';
      }
      if (this.tooltipEl.style.display === 'block') {
        this.tooltipEl.style.left = (e.clientX + 14) + 'px';
        this.tooltipEl.style.top = (e.clientY - 22) + 'px';
      }
    });
    document.addEventListener('keydown', e => {
      if (!this.isOpen() || this.hovered == null) return;
      if (e.code.startsWith('Digit')) {
        const n = +e.code.slice(5) - 1;
        if (n >= 0 && n < 9) this.numberSwap(this.hovered, n);
      } else if (e.code === 'KeyF') {
        this.offhandSwap(this.hovered);            // UPDATE-08 §7
      } else if (e.code === 'KeyQ') {
        this.dropFromSlot(this.hovered, e.shiftKey);
      }
    });
    this.root.addEventListener('mousedown', e => {
      if (e.target === this.root && this.cursor) {
        emitSound('ui.click', null);   // inside the guard: slot clicks bubble here too
        if (e.button === 0) { this.game.throwStack(this.cursor); this.cursor = null; }
        else if (e.button === 2) {
          const one = withCount(this.cursor, 1);
          this.cursor.count--;
          if (this.cursor.count <= 0) this.cursor = null;
          this.game.throwStack(one);
        }
        this.renderCursor();
        e.preventDefault();
      }
    });
    this.root.addEventListener('contextmenu', e => e.preventDefault());
  }

  isOpen() { return this.kind !== null; }

  // ---------------------------------------------------- open/close

  open(kind, x, y, z) {
    this.close(true);
    this.kind = kind;
    this.pos = x !== undefined ? { x, y, z } : null;
    this.be = this.pos ? this.game.getBlockEntity(x, y, z) : null;
    // 'creative' carries the 2×2 grid too — §6.2's tab 10 shows the real
    // survival screen, and "crafting still works" there.
    if (kind === 'inventory' || kind === 'crafting' || kind === 'creative') {
      this.craftW = kind === 'crafting' ? 3 : 2;
      this.craftGrid = new Array(this.craftW * this.craftW).fill(null);
    } else {
      this.craftGrid = null;
    }
    if (kind === 'creative') { this.scroll = 0; this.search = ''; }
    this.build();
    this.root.classList.add('visible');
    this.game.onContainerOpened?.();
  }

  close(silent = false) {
    if (!this.kind) return;
    // Capture now: kind and pos are both nulled before the tail of this method.
    const wasChest = this.kind === 'chest';
    const wasCreative = this.kind === 'creative';
    const chestPos = this.pos;
    const p = this.game.player;
    if (this.craftGrid) {                        // grid returns to inventory (06 §5.4)
      for (let i = 0; i < this.craftGrid.length; i++) {
        const s = this.craftGrid[i];
        if (!s) continue;
        const leftover = p.give(s);
        if (leftover > 0) this.game.throwStack(withCount(s, leftover));
        this.craftGrid[i] = null;
      }
    }
    if (this.cursor) {
      const leftover = p.give(this.cursor);
      // 18 §6.5 — closing the CREATIVE screen with a full inventory deletes the
      // overflow rather than spawning a world item: the source is infinite, so
      // there is nothing to preserve and item clutter while building is the
      // real cost. Every other screen keeps 06 §14.1's drop rule.
      if (leftover > 0 && !wasCreative) this.game.throwStack(withCount(this.cursor, leftover));
      this.cursor = null;
    }
    this.kind = null;
    this.pos = null;
    this.be = null;
    this.root.classList.remove('visible');
    this.renderCursor();
    this.tooltipEl.style.display = 'none';
    // `silent` marks the open()-time teardown of a previous screen, so a
    // chest→chest hand-off correctly stays quiet.
    if (wasChest && chestPos && !silent) {
      emitSound('block.chest.close', at(chestPos.x + 0.5, chestPos.y + 0.5, chestPos.z + 0.5));
    }
    if (!silent) this.game.onContainerClosed?.();
  }

  // ---------------------------------------------------- slot defs

  playerStorageDefs() {
    const p = this.game.player;
    const defs = [];
    // main 9–35 at y 84/102/120; hotbar 0–8 at y 142 (06 §14.1)
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 9; col++) {
        const i = 9 + row * 9 + col;
        defs.push({
          x: 8 + col * 18, y: 84 + row * 18, region: 'main', slotIndex: i,
          get: () => p.inventory[i], set: v => { p.inventory[i] = v; },
        });
      }
    }
    for (let col = 0; col < 9; col++) {
      const i = col;
      defs.push({
        x: 8 + col * 18, y: 142, region: 'hotbar', slotIndex: i, hotbarIndex: i,
        get: () => p.inventory[i], set: v => { p.inventory[i] = v; },
      });
    }
    return defs;
  }

  resultDef(x, y) {
    return {
      x, y, region: 'result', takeOnly: true,
      get: () => {
        const r = findRecipe(this.craftGrid, this.craftW);
        return r ? { id: r.output.id, count: r.output.count } : null;
      },
      onCraft: () => {
        for (let i = 0; i < this.craftGrid.length; i++) {
          const s = this.craftGrid[i];
          if (!s) continue;
          s.count--;
          if (s.count <= 0) this.craftGrid[i] = null;
        }
      },
    };
  }

  // ---------------------------------------------------- DOM build

  build() {
    if (this.kind === 'creative') { this.buildCreative(); return; }
    this.root.innerHTML = '';
    this.slots = [];
    const p = this.game.player;
    const panel = document.createElement('div');
    panel.className = 'panel-abs';
    const title = { inventory: 'Inventory', crafting: 'Crafting', furnace: 'Furnace', chest: 'Chest' }[this.kind];
    panel.innerHTML = `<div class="panel-title">${title}</div>`;
    this.panel = panel;

    const defs = [];

    if (this.kind === 'inventory') {
      // armor 39/38/37/36 at x=8, y=8/26/44/62 (06 §14.1 + UPDATE §2.2)
      const armorY = [8, 26, 44, 62];
      for (let i = 0; i < 4; i++) {
        const slot = i;   // 0 helmet … 3 boots
        defs.push({
          x: 8, y: armorY[i], region: 'armor', armorIndex: slot,
          placeholder: ['helmet', 'chestplate', 'leggings', 'boots'][i],
          get: () => p.armor[slot],
          // §3.3 / 06 §14.2: "armor slot content changes". This setter is the
          // funnel for every drag, shift-click and number-swap into the slot.
          set: v => {
            if (v && !p.armor[slot]) {
              const name = ITEMS.get(v.id)?.name ?? '';
              emitSound(name.startsWith('leather') ? 'player.armor_equip.leather' : 'player.armor_equip', null);
            }
            p.armor[slot] = v;
          },
          canPut: s => ITEMS.get(s.id)?.armorSlot === slot,
        });
      }
      // offhand slot 45 at (77,62) with shield placeholder (UPDATE-08 §7.1)
      defs.push({
        x: 77, y: 62, region: 'offhand', slotIndex: 45, placeholder: 'shield',
        get: () => p.offhand, set: v => { p.offhand = v; },
      });
      // 2×2 craft grid 40–43 at (98/116, 18/36) + result 44 at (154,28)
      const gxy = [[98, 18], [116, 18], [98, 36], [116, 36]];
      for (let i = 0; i < 4; i++) {
        defs.push({
          x: gxy[i][0], y: gxy[i][1], region: 'craft', slotIndex: 40 + i,
          get: () => this.craftGrid[i], set: v => { this.craftGrid[i] = v; },
        });
      }
      defs.push(this.resultDef(154, 28));
      this.addArrow(panel, 130, 27);
      this.addPlayerPreview(panel, 26, 8, 50, 70);
      defs.push(...this.playerStorageDefs());
    } else if (this.kind === 'crafting') {
      // 3×3 at cols 30/48/66, rows 17/35/53; result (124,35) (UPDATE §3.1)
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const i = row * 3 + col;
          defs.push({
            x: 30 + col * 18, y: 17 + row * 18, region: 'craft',
            get: () => this.craftGrid[i], set: v => { this.craftGrid[i] = v; },
          });
        }
      }
      defs.push(this.resultDef(124, 35));
      this.addArrow(panel, 94, 34);
      defs.push(...this.playerStorageDefs());
    } else if (this.kind === 'chest') {
      const be = this.be.data;
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 9; col++) {
          const i = row * 9 + col;
          defs.push({
            x: 8 + col * 18, y: 18 + row * 18, region: 'container',
            get: () => be.slots[i], set: v => { be.slots[i] = v; this.markBeDirty(); },
          });
        }
      }
      defs.push(...this.playerStorageDefs());
    } else if (this.kind === 'furnace') {
      const f = this.be.data;
      defs.push({
        x: 56, y: 17, region: 'furnaceIn',
        get: () => f.slots[0], set: v => { f.slots[0] = v; this.markBeDirty(); },
      });
      defs.push({
        x: 56, y: 53, region: 'furnaceFuel',
        get: () => f.slots[1], set: v => { f.slots[1] = v; this.markBeDirty(); },
        canPut: s => fuelValue(s.id) > 0,
      });
      defs.push({
        x: 116, y: 35, region: 'furnaceOut', takeOnly: true,
        get: () => f.slots[2], set: v => { f.slots[2] = v; this.markBeDirty(); },
        onTakeOut: () => {
          const xp = Math.floor(f.xpBank);
          if (xp > 0) { this.game.player.addXp(xp); f.xpBank -= xp; }
        },
      });
      this.addArrow(panel, 80, 34, 'g-arrow');
      const flame = document.createElement('div');
      flame.className = 'gauge-flame-abs';
      flame.innerHTML = '<div id="g-flame"></div>';
      panel.appendChild(flame);
      defs.push(...this.playerStorageDefs());
    }

    for (const def of defs) this.addSlot(panel, def);
    this.root.appendChild(panel);
    this.refresh();
  }

  // ---------------------------------------------------- creative screen (18 §6)

  /** The current tab's full id list (§6.2); the Search tab filters all ids. */
  paletteList() {
    if (this.tab === TAB.SEARCH) return searchPalette(this.search);
    return buildPalette().byTab.get(this.tab) ?? [];
  }

  maxScroll() {
    return Math.max(0, Math.ceil(this.paletteList().length / CV.COLS) - CV.ROWS);
  }

  buildCreative() {
    this.root.innerHTML = '';
    this.slots = [];
    const p = this.game.player;
    const panel = document.createElement('div');
    panel.className = 'panel-abs panel-creative';
    panel.style.width = `calc(${CV.W} * var(--gpx))`;
    panel.style.height = `calc(${CV.H} * var(--gpx))`;
    this.panel = panel;

    const tabs = visibleTabs();
    const label = tabs.find(t => t.id === this.tab)?.label ?? '';
    panel.innerHTML = `<div class="panel-title">${label}</div>`;
    this.addTabStrip(panel, tabs);

    const defs = [];
    if (this.tab === TAB.INVENTORY) {
      // §6.2 tab 10 — the player's REAL screen: 27 main + 9 hotbar + 4 armor +
      // offhand + the 2×2 craft grid. Same geometry as the survival inventory,
      // shifted clear of the tab strip.
      defs.push(...this.inventoryTabDefs(panel));
    } else {
      this.scroll = Math.min(this.scroll, this.maxScroll());
      const list = this.paletteList();
      for (let r = 0; r < CV.ROWS; r++) {
        for (let c = 0; c < CV.COLS; c++) {
          const cell = (this.scroll + r) * CV.COLS + c;
          const id = list[cell];
          if (id === undefined) continue;
          const item = ITEMS.get(id);
          defs.push({
            x: CV.GRID_X + c * 18, y: CV.GRID_Y + r * 18,
            region: 'palette', paletteId: id, hideCount: true,
            // A palette cell is a source, never storage: `get` mints a fresh
            // full stack and `set` is a no-op sink (§6.3).
            get: () => ({ id, count: item.stack ?? 64 }),
            set: () => {},
          });
        }
      }
      this.addScrollbar(panel);
      if (this.tab === TAB.SEARCH) this.addSearchBox(panel);
      defs.push(...this.creativeStorageDefs());
    }
    defs.push(this.destroyDef());

    for (const def of defs) this.addSlot(panel, def);
    this.root.appendChild(panel);
    // §6.1 — the grid scrolls on the wheel. Bound to the panel, not the slots:
    // the gaps between cells must scroll too.
    panel.addEventListener('wheel', e => {
      if (this.tab === TAB.INVENTORY) return;
      e.preventDefault();
      const next = Math.min(this.maxScroll(), Math.max(0, this.scroll + Math.sign(e.deltaY)));
      if (next !== this.scroll) { this.scroll = next; this.build(); }
    }, { passive: false });
    this.refresh();
  }

  /** Personal 9×3 + hotbar beneath the palette (§6.1). */
  creativeStorageDefs() {
    const p = this.game.player;
    const defs = [];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 9; col++) {
        const i = 9 + row * 9 + col;
        defs.push({
          x: CV.GRID_X + col * 18, y: CV.MAIN_Y + row * 18, region: 'main', slotIndex: i,
          get: () => p.inventory[i], set: v => { p.inventory[i] = v; },
        });
      }
    }
    for (let col = 0; col < 9; col++) {
      const i = col;
      defs.push({
        x: CV.GRID_X + col * 18, y: CV.HOTBAR_Y, region: 'hotbar', slotIndex: i, hotbarIndex: i,
        get: () => p.inventory[i], set: v => { p.inventory[i] = v; },
      });
    }
    return defs;
  }

  /** §6.2 tab 10 — the survival inventory, offset clear of the tab strip. */
  inventoryTabDefs(panel) {
    const p = this.game.player;
    const dx = CV.INV_DX, dy = CV.INV_DY;
    const defs = [];
    const armorY = [8, 26, 44, 62];
    for (let i = 0; i < 4; i++) {
      const slot = i;
      defs.push({
        x: dx + 8, y: dy + armorY[i], region: 'armor', armorIndex: slot,
        placeholder: ['helmet', 'chestplate', 'leggings', 'boots'][i],
        get: () => p.armor[slot],
        set: v => {
          if (v && !p.armor[slot]) {
            const name = ITEMS.get(v.id)?.name ?? '';
            emitSound(name.startsWith('leather') ? 'player.armor_equip.leather' : 'player.armor_equip', null);
          }
          p.armor[slot] = v;
        },
        canPut: s => ITEMS.get(s.id)?.armorSlot === slot,
      });
    }
    defs.push({
      x: dx + 77, y: dy + 62, region: 'offhand', slotIndex: 45, placeholder: 'shield',
      get: () => p.offhand, set: v => { p.offhand = v; },
    });
    const gxy = [[98, 18], [116, 18], [98, 36], [116, 36]];
    for (let i = 0; i < 4; i++) {
      defs.push({
        x: dx + gxy[i][0], y: dy + gxy[i][1], region: 'craft', slotIndex: 40 + i,
        get: () => this.craftGrid[i], set: v => { this.craftGrid[i] = v; },
      });
    }
    defs.push(this.resultDef(dx + 154, dy + 28));
    this.addArrow(panel, dx + 130, dy + 27);
    this.addPlayerPreview(panel, dx + 26, dy + 8, 50, 70);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 9; col++) {
        const i = 9 + row * 9 + col;
        defs.push({
          x: dx + 8 + col * 18, y: dy + 84 + row * 18, region: 'main', slotIndex: i,
          get: () => p.inventory[i], set: v => { p.inventory[i] = v; },
        });
      }
    }
    for (let col = 0; col < 9; col++) {
      const i = col;
      defs.push({
        x: dx + 8 + col * 18, y: dy + 142, region: 'hotbar', slotIndex: i, hotbarIndex: i,
        get: () => p.inventory[i], set: v => { p.inventory[i] = v; },
      });
    }
    return defs;
  }

  /** §6.4 — the trash cell at the hotbar row's right end. */
  destroyDef() {
    const y = this.tab === TAB.INVENTORY ? CV.INV_DY + 142 : CV.HOTBAR_Y;
    return {
      x: CV.DESTROY_X, y, region: 'destroy', placeholder: 'destroy',
      tooltip: 'Destroy Item',
      get: () => null, set: () => {},
    };
  }

  addTabStrip(panel, tabs) {
    const strip = document.createElement('div');
    strip.className = 'cv-tabs';
    strip.style.left = `calc(${CV.GRID_X} * var(--gpx))`;
    strip.style.top = `calc(${CV.TAB_Y} * var(--gpx))`;
    for (const t of tabs) {
      const b = document.createElement('div');
      b.className = 'cv-tab' + (t.id === this.tab ? ' selected' : '');
      b.title = t.label;
      if (t.glyph) {
        b.textContent = t.glyph;
      } else {
        const icon = document.createElement('div');
        iconCss(icon, tileForItemId(this.game, t.icon));
        b.appendChild(icon);
      }
      b.addEventListener('mousedown', e => {
        e.preventDefault(); e.stopPropagation();
        emitSound('ui.click', null);
        if (this.tab === t.id) return;
        this.tab = t.id;
        this.scroll = 0;
        this.build();
        // §6.2 tab 9: "Selecting this tab auto-focuses the field."
        if (t.id === TAB.SEARCH) this.root.querySelector('.cv-search')?.focus();
      });
      strip.appendChild(b);
    }
    panel.appendChild(strip);
  }

  addScrollbar(panel) {
    const max = this.maxScroll();
    const bar = document.createElement('div');
    bar.className = 'cv-scrollbar';
    bar.style.left = `calc(${CV.BAR_X} * var(--gpx))`;
    bar.style.top = `calc(${CV.GRID_Y} * var(--gpx))`;
    const knob = document.createElement('div');
    knob.className = 'cv-knob';
    const frac = max > 0 ? this.scroll / max : 0;
    knob.style.height = `${max > 0 ? Math.max(12, 100 / (max + 1)) : 100}%`;
    knob.style.top = `calc(${frac} * (100% - ${knob.style.height}))`;
    bar.appendChild(knob);
    const drag = e => {
      const r = bar.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      const next = Math.round(f * max);
      if (next !== this.scroll) { this.scroll = next; this.build(); }
    };
    bar.addEventListener('mousedown', e => {
      e.preventDefault(); e.stopPropagation();
      if (max === 0) return;
      drag(e);
      const move = ev => drag(ev);
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    panel.appendChild(bar);
  }

  addSearchBox(panel) {
    const box = document.createElement('input');
    box.className = 'cv-search';
    box.setAttribute('aria-label', 'Search items');
    box.placeholder = 'Search…';
    box.value = this.search;
    box.style.left = `calc(${CV.GRID_X} * var(--gpx))`;
    box.style.top = `calc(${CV.SEARCH_Y} * var(--gpx))`;
    box.addEventListener('input', () => {
      this.search = box.value;
      this.scroll = 0;
      this.build();
      const next = this.root.querySelector('.cv-search');
      // Rebuilding replaces the node, so the caret has to be restored or every
      // keystroke would blur the field.
      if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
    });
    // The document-level hotbar/F/Q handler must not eat typing (it reads
    // `hovered`, which a keystroke in the box does not clear).
    box.addEventListener('keydown', e => e.stopPropagation());
    box.addEventListener('mousedown', e => e.stopPropagation());
    panel.appendChild(box);
  }

  /** §6.3 — palette cells are infinite sources; the destroy slot is a sink. */
  onPaletteClick(slot, e) {
    const id = slot.paletteId;
    const max = stackMax(id);
    if (e.shiftKey && e.button === 0) {
      // "Send a full stack directly to the personal inventory, no cursor step"
      this.game.player.give({ id, count: max });
      return;
    }
    if (e.button === 2) { this.cursor = { id, count: 1 }; return; }
    if (this.cursor && this.cursor.id === id) { this.cursor.count = max; return; }
    // Cursor holding a different item: replaced, old stack discarded (§6.3).
    if (this.cursor) emitSound('ui.item.destroy', null);
    this.cursor = { id, count: max };
  }

  onDestroyClick(e) {
    const p = this.game.player;
    if (e.shiftKey) {
      // §6.4 — clears the ENTIRE personal inventory: 36 slots + armor +
      // offhand + the 2×2 craft grid.
      p.inventory.fill(null);
      p.armor.fill(null);
      p.offhand = null;
      if (this.craftGrid) this.craftGrid.fill(null);
      this.cursor = null;
      emitSound('ui.item.destroy', null);
      return;
    }
    if (!this.cursor) return;
    this.cursor = null;
    emitSound('ui.item.destroy', null);
  }

  addSlot(panel, def) {
    const el = document.createElement('div');
    el.className = 'slot-abs' + (def.takeOnly ? ' take-only' : '');
    if (def.placeholder) el.dataset.ph = def.placeholder;
    el.style.left = `calc(${def.x - 1} * var(--gpx))`;
    el.style.top = `calc(${def.y - 1} * var(--gpx))`;
    el.innerHTML = `<div></div><div class="slot-count"></div><div class="slot-ph"></div>`;
    const index = this.slots.length;
    this.slots.push({ ...def, el });
    el.addEventListener('mousedown', e => { this.onSlotClick(index, e); e.preventDefault(); e.stopPropagation(); });
    el.addEventListener('mouseenter', () => { this.hovered = index; this.showTooltip(index); });
    el.addEventListener('mouseleave', () => { if (this.hovered === index) this.hovered = null; this.tooltipEl.style.display = 'none'; });
    panel.appendChild(el);
  }

  // procedural right-pointing arrow (grid → result); optional fill gauge id
  addArrow(panel, x, y, id = null) {
    const a = document.createElement('div');
    a.className = 'craft-arrow';
    a.style.left = `calc(${x} * var(--gpx))`;
    a.style.top = `calc(${y} * var(--gpx))`;
    a.innerHTML = `<div class="arrow-shaft">${id ? `<div id="${id}" class="arrow-fill"></div>` : ''}</div><div class="arrow-head"></div>`;
    panel.appendChild(a);
  }

  // player preview panel — procedural blocky silhouette (no dead space)
  addPlayerPreview(panel, x, y, w, h) {
    const box = document.createElement('div');
    box.className = 'player-preview';
    box.style.left = `calc(${x} * var(--gpx))`;
    box.style.top = `calc(${y} * var(--gpx))`;
    box.style.width = `calc(${w} * var(--gpx))`;
    box.style.height = `calc(${h} * var(--gpx))`;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, w, h);
    const cx = Math.floor(w / 2);
    ctx.fillStyle = '#3a4152';
    ctx.fillRect(cx - 8, 6, 16, 16);          // head
    ctx.fillRect(cx - 8, 24, 16, 22);         // body
    ctx.fillRect(cx - 13, 24, 5, 20);         // arms
    ctx.fillRect(cx + 8, 24, 5, 20);
    ctx.fillRect(cx - 8, 48, 7, 17);          // legs
    ctx.fillRect(cx + 1, 48, 7, 17);
    ctx.fillStyle = '#5b6680';
    ctx.fillRect(cx - 6, 10, 4, 3);           // eye glints
    ctx.fillRect(cx + 2, 10, 4, 3);
    box.appendChild(c);
    panel.appendChild(box);
  }

  markBeDirty() {
    if (!this.pos) return;
    const chunk = this.game.world.getChunkAt(this.pos.x, this.pos.z);
    if (chunk) chunk.modified = true;
  }

  // ---------------------------------------------------- interaction (06 §14.2)

  onSlotClick(index, e) {
    const slot = this.slots[index];
    const cur = this.cursor;
    const inSlot = slot.get();

    // Every slot in every container funnels here (06 §14.2) — one emit covers
    // them all. Above the takeOnly branch so result slots click too.
    emitSound('ui.click', null);

    // 18 §6.3/§6.4 — a palette cell and the destroy cell are a source and a
    // sink; neither obeys the storage click table below. §6.3's "dragging a
    // stack back onto the palette deletes it" falls out of onPaletteClick's
    // different-item branch, which discards the old cursor.
    if (slot.region === 'palette') { this.onPaletteClick(slot, e); this.refresh(); return; }
    if (slot.region === 'destroy') { this.onDestroyClick(e); this.refresh(); return; }

    if (slot.takeOnly) {
      this.takeResult(slot, e.shiftKey);
      this.refresh();
      return;
    }

    if (e.shiftKey && e.button === 0) {
      this.shiftMove(slot);
    } else if (e.button === 0) {
      const now = performance.now();
      if (cur && now - this.lastClick.time < 300 && this.lastClick.index === index) {
        this.collectAll();
      } else if (!cur && inSlot) {
        slot.set(null);
        this.cursor = inSlot;
      } else if (cur && inSlot && same(cur, inSlot)) {
        const add = Math.min(stackMax(cur.id) - inSlot.count, cur.count);
        inSlot.count += add;
        cur.count -= add;
        if (cur.count <= 0) this.cursor = null;
      } else if (cur) {
        if (!slot.canPut || slot.canPut(cur)) {
          slot.set(cur);
          this.cursor = inSlot;
        }
      }
      this.lastClick = { time: now, index };
    } else if (e.button === 2) {
      if (!cur && inSlot) {
        const take = Math.ceil(inSlot.count / 2);       // split-half
        const taken = withCount(inSlot, take);      // own tags (08 §1 rule 4)
        inSlot.count -= take;
        if (inSlot.count <= 0) slot.set(null);
        this.cursor = taken;
      } else if (cur && (!inSlot || (same(cur, inSlot) && inSlot.count < stackMax(cur.id)))) {
        if (!slot.canPut || slot.canPut(cur)) {
          if (inSlot) inSlot.count++;
          else slot.set(withCount(cur, 1));
          cur.count--;
          if (cur.count <= 0) this.cursor = null;
        }
      }
    }
    this.refresh();
  }

  takeResult(slot, shift) {
    const out = slot.get();
    if (!out) return;
    if (slot.region === 'result') {
      if (shift) {
        // craft-max: until ingredients run out or inventory is full (§4.6)
        for (let n = 0; n < 576; n++) {
          const r = slot.get();
          if (!r) break;
          if (this.game.player.give({ ...r }) > 0) break;
          slot.onCraft();
        }
      } else {
        if (this.cursor && !(same(this.cursor, out) &&
            this.cursor.count + out.count <= stackMax(out.id))) return;
        if (this.cursor) this.cursor.count += out.count;
        else this.cursor = cloneStack(out);   // 08 §1 rule 4 — E4's anvil output flows here
        slot.onCraft();                                  // consume exactly one each
      }
    } else {
      if (shift) {
        const leftover = this.game.player.give(out);
        if (leftover > 0) out.count = leftover;
        else slot.set(null);
        slot.onTakeOut?.();
      } else {
        if (this.cursor && !(same(this.cursor, out) &&
            this.cursor.count + out.count <= stackMax(out.id))) return;
        if (this.cursor) this.cursor.count += out.count;
        else this.cursor = cloneStack(out);   // 08 §1 rule 4 — E4's anvil output flows here
        slot.set(null);
        slot.onTakeOut?.();
      }
    }
  }

  shiftMove(slot) {
    const s = slot.get();
    if (!s) return;
    const targets = this.shiftTargets(slot, s);
    for (const t of targets) {
      const dst = t.get();
      if (dst && same(dst, s)) {
        const add = Math.min(stackMax(s.id) - dst.count, s.count);
        dst.count += add;
        s.count -= add;
        if (s.count <= 0) { slot.set(null); return; }
      }
    }
    for (const t of targets) {
      if (!t.get() && (!t.canPut || t.canPut(s))) {
        t.set(s);
        slot.set(null);
        return;
      }
    }
  }

  shiftTargets(slot, stack) {
    const bySel = regions => this.slots.filter(x => regions.includes(x.region) && !x.takeOnly);
    const item = ITEMS.get(stack.id);
    if (['container', 'furnaceIn', 'furnaceFuel', 'furnaceOut', 'craft', 'armor', 'result', 'offhand']
        .includes(slot.region)) {
      return bySel(['hotbar', 'main']);
    }
    // from player storage:
    if (this.kind === 'chest') return bySel(['container']);
    if (this.kind === 'furnace') {
      if (SMELTING.has(stack.id)) return bySel(['furnaceIn']);
      if (fuelValue(stack.id) > 0) return bySel(['furnaceFuel']);
      return [];
    }
    if (item?.armorSlot !== undefined && item.armorSlot !== null && this.kind === 'inventory') {
      const armor = bySel(['armor']).filter(t => !t.canPut || t.canPut(stack));
      if (armor.length && !armor[0].get()) return armor;
    }
    return bySel(slot.region === 'hotbar' ? ['main'] : ['hotbar']);
  }

  collectAll() {
    const cur = this.cursor;
    if (!cur) return;
    for (const slot of this.slots) {
      if (slot.takeOnly) continue;
      const s = slot.get();
      if (s && same(s, cur)) {
        const add = Math.min(stackMax(cur.id) - cur.count, s.count);
        cur.count += add;
        s.count -= add;
        if (s.count <= 0) slot.set(null);
        if (cur.count >= stackMax(cur.id)) break;
      }
    }
  }

  numberSwap(index, hotbarN) {
    const slot = this.slots[index];
    if (!slot || slot.takeOnly) return;
    const p = this.game.player;
    const tmp = p.inventory[hotbarN];
    const s = slot.get();
    if (slot.canPut && tmp && !slot.canPut(tmp)) return;
    p.inventory[hotbarN] = s;
    slot.set(tmp);
    this.refresh();
  }

  // F: swap hovered ↔ offhand slot 45 (UPDATE-08 §7)
  offhandSwap(index) {
    const slot = this.slots[index];
    if (!slot || slot.takeOnly || slot.region === 'offhand') return;
    const p = this.game.player;
    const s = slot.get();
    const off = p.offhand;
    if (slot.canPut && off && !slot.canPut(off)) return;
    p.offhand = s ?? null;
    slot.set(off ?? null);
    this.refresh();
  }

  dropFromSlot(index, whole) {
    const slot = this.slots[index];
    if (!slot || slot.takeOnly) return;
    const s = slot.get();
    if (!s) return;
    const n = whole ? s.count : 1;
    this.game.throwStack(withCount(s, n));
    s.count -= n;
    if (s.count <= 0) slot.set(null);
    this.refresh();
  }

  showTooltip(index) {
    const slot = this.slots[index];
    const s = slot?.get();
    if (!s) {
      // §6.4 — the destroy cell is permanently empty but still labelled.
      if (slot?.tooltip) {
        this.tooltipEl.textContent = slot.tooltip;
        this.tooltipEl.style.display = 'block';
        this.tooltipEl.style.left = (this.mouseX + 14) + 'px';
        this.tooltipEl.style.top = (this.mouseY - 22) + 'px';
        return;
      }
      this.tooltipEl.style.display = 'none';
      return;
    }
    const item = ITEMS.get(s.id);
    let text = item?.displayName ?? '?';
    if (item?.durability && s.damage > 0) text += ` ${item.durability - s.damage}/${item.durability}`;
    this.tooltipEl.textContent = text;
    this.tooltipEl.style.display = 'block';
    this.tooltipEl.style.left = (this.mouseX + 14) + 'px';
    this.tooltipEl.style.top = (this.mouseY - 22) + 'px';
  }

  // ---------------------------------------------------- rendering

  renderStackInto(el, stack, hideCount = false) {
    const icon = el.children[0], count = el.children[1];
    if (stack) {
      iconCss(icon, tileForItemId(this.game, stack.id));
      icon.style.display = 'block';
      // §6.3: a palette cell is a source, not a stack — a wall of "64"s across
      // 45 cells reads as inventory the player owns. Matches Java.
      count.textContent = (!hideCount && stack.count > 1) ? stack.count : '';
    } else {
      icon.style.display = 'none';
      icon.className = '';
      count.textContent = '';
    }
  }

  renderCursor() {
    if (this.cursor) {
      this.cursorEl.style.display = 'block';
      this.cursorEl.style.left = this.mouseX + 'px';
      this.cursorEl.style.top = this.mouseY + 'px';
      this.renderStackInto(this.cursorEl, this.cursor);
    } else {
      this.cursorEl.style.display = 'none';
    }
  }

  refresh() {
    for (const slot of this.slots) {
      this.renderStackInto(slot.el, slot.get(), slot.hideCount);
      slot.el.classList.toggle('empty-ph', !slot.get() && !!slot.placeholder);
    }
    this.renderCursor();
    if (this.kind === 'furnace' && this.be) {
      const f = this.be.data;
      const flame = document.getElementById('g-flame');
      const arrow = document.getElementById('g-arrow');
      if (flame) flame.style.height = `${f.fuelTotal > 0 ? (f.burn / f.fuelTotal) * 100 : 0}%`;
      if (arrow) arrow.style.width = `${(f.cook / 200) * 100}%`;
    }
  }

  tickOpen() {
    if (!this.isOpen()) return;
    if (this.pos) {
      const p = this.game.player;
      const d = Math.hypot(this.pos.x + 0.5 - p.pos.x, this.pos.y + 0.5 - (p.pos.y + 1), this.pos.z + 0.5 - p.pos.z);
      const id = this.game.world.getBlock(this.pos.x, this.pos.y, this.pos.z);
      const stillThere = this.kind === 'furnace' ? (id === 35 || id === 36) : this.kind === 'chest' ? id === 37 : true;
      if (d > 8 || !stillThere) { this.game.closeContainerScreen?.(); return; }
    }
    if (this.game.world.time % 4 === 0) this.refresh();
  }
}
