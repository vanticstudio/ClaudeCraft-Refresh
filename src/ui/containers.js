// Inventory / crafting / furnace / chest screens + click semantics (06 §9, §14).
import { ITEMS, RECIPES, SMELTING, fuelValue } from '../registry/items.js';
import { iconCss, tileForItemId } from './hud.js';

const stackMax = id => ITEMS.get(id)?.stack ?? 64;
const same = (a, b) => a && b && a.id === b.id && (a.damage ?? 0) === (b.damage ?? 0);

// ---------------------------------------------------------------- recipe matching (06 §9)

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

function matchShaped(recipe, grid, gw) {
  const b = gridBounds(grid, gw);
  if (!b) return false;
  const rows = recipe.pattern;
  const rh = rows.length, rw = rows[0].length;
  if (b.w !== rw || b.h !== rh) return false;
  const tryMirror = mirror => {
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const ch = rows[y][mirror ? rw - 1 - x : x];
        const cell = grid[(b.y0 + y) * gw + (b.x0 + x)];
        if (ch === '.' || ch === ' ') {
          if (cell) return false;
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

export function findRecipe(grid, gw) {
  for (const r of RECIPES) {
    if (r.shaped ? matchShaped(r, grid, gw) : matchShapeless(r, grid)) return r;
  }
  return null;
}

// ---------------------------------------------------------------- containers

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

    this.cursor = null;         // stack on the mouse
    this.kind = null;
    this.pos = null;            // block entity position
    this.slots = [];            // slot descriptors
    this.craftGrid = null;      // array(4|9)
    this.craftW = 2;
    this.hovered = null;
    this.lastClick = { time: 0, index: -1 };

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
      const digit = 'Digit123456789'.indexOf(e.code.slice(0, 6)) === 0 ? +e.code[5] - 1 : -1;
      if (e.code.startsWith('Digit')) {
        const n = +e.code.slice(5) - 1;
        if (n >= 0 && n < 9) this.numberSwap(this.hovered, n);
      } else if (e.code === 'KeyQ') {
        this.dropFromSlot(this.hovered, e.shiftKey);
      }
    });
    this.root.addEventListener('mousedown', e => {
      if (e.target === this.root && this.cursor) {
        // click outside panel: drop cursor (06 §14.2)
        if (e.button === 0) { this.game.throwStack(this.cursor); this.cursor = null; }
        else if (e.button === 2) {
          const one = { ...this.cursor, count: 1 };
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
    this.kind = kind === 'crafting' ? 'crafting' : kind;
    this.pos = x !== undefined ? { x, y, z } : null;
    this.be = this.pos ? this.game.getBlockEntity(x, y, z) : null;
    if (kind === 'inventory' || kind === 'crafting') {
      this.craftW = kind === 'crafting' ? 3 : 2;
      this.craftGrid = new Array(this.craftW * this.craftW).fill(null);
    } else {
      this.craftGrid = null;
    }
    this.build();
    this.root.classList.add('visible');
    this.game.onContainerOpened?.();
  }

  close(silent = false) {
    if (!this.kind) return;
    const p = this.game.player;
    // return craft grid + cursor (06 §14.1)
    if (this.craftGrid) {
      for (let i = 0; i < this.craftGrid.length; i++) {
        const s = this.craftGrid[i];
        if (!s) continue;
        const leftover = p.give(s);
        if (leftover > 0) this.game.throwStack({ ...s, count: leftover });
        this.craftGrid[i] = null;
      }
    }
    if (this.cursor) {
      const leftover = p.give(this.cursor);
      if (leftover > 0) this.game.throwStack({ ...this.cursor, count: leftover });
      this.cursor = null;
    }
    this.kind = null;
    this.pos = null;
    this.be = null;
    this.root.classList.remove('visible');
    this.renderCursor();
    this.tooltipEl.style.display = 'none';
    if (!silent) this.game.onContainerClosed?.();
  }

  // ---------------------------------------------------- slot model

  playerSlots() {
    const p = this.game.player;
    const out = [];
    for (let i = 9; i < 36; i++) out.push({ region: 'main', get: () => p.inventory[i], set: v => { p.inventory[i] = v; } });
    for (let i = 0; i < 9; i++) out.push({ region: 'hotbar', hotbarIndex: i, get: () => p.inventory[i], set: v => { p.inventory[i] = v; } });
    return out;
  }

  armorSlots() {
    const p = this.game.player;
    return [0, 1, 2, 3].map(i => ({
      region: 'armor', armorIndex: i,
      get: () => p.armor[i],
      set: v => { p.armor[i] = v; },
      canPut: s => ITEMS.get(s.id)?.armorSlot === i,
    }));
  }

  craftSlots() {
    return this.craftGrid.map((_, i) => ({
      region: 'craft',
      get: () => this.craftGrid[i],
      set: v => { this.craftGrid[i] = v; },
    }));
  }

  resultSlot() {
    return {
      region: 'result', takeOnly: true,
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
    this.root.innerHTML = '';
    this.slots = [];
    const panel = document.createElement('div');
    panel.className = 'panel';
    const title = { inventory: 'Inventory', crafting: 'Crafting', furnace: 'Furnace', chest: 'Chest' }[this.kind];
    panel.innerHTML = `<h3>${title}</h3>`;

    const addGrid = (slotDefs, cols) => {
      const grid = document.createElement('div');
      grid.className = 'slot-grid';
      grid.style.gridTemplateColumns = `repeat(${cols}, var(--slot))`;
      for (const def of slotDefs) {
        const el = document.createElement('div');
        el.className = 'slot' + (def.takeOnly ? ' take-only' : '');
        el.innerHTML = `<div></div><div class="slot-count"></div>`;
        const index = this.slots.length;
        this.slots.push({ ...def, el });
        el.addEventListener('mousedown', e => { this.onSlotClick(index, e); e.preventDefault(); e.stopPropagation(); });
        el.addEventListener('mouseenter', () => { this.hovered = index; this.showTooltip(index); });
        el.addEventListener('mouseleave', () => { if (this.hovered === index) this.hovered = null; this.tooltipEl.style.display = 'none'; });
        grid.appendChild(el);
      }
      panel.appendChild(grid);
      return grid;
    };

    if (this.kind === 'inventory') {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '20px';
      const armorGrid = document.createElement('div');
      panel.appendChild(row);
      addGrid(this.armorSlots(), 1);
      addGrid(this.craftSlots(), 2);
      addGrid([this.resultSlot()], 1);
    } else if (this.kind === 'crafting') {
      addGrid(this.craftSlots(), 3);
      addGrid([this.resultSlot()], 1);
    } else if (this.kind === 'chest') {
      const be = this.be.data;
      addGrid(be.slots.map((_, i) => ({
        region: 'container',
        get: () => be.slots[i],
        set: v => { be.slots[i] = v; this.markBeDirty(); },
      })), 9);
    } else if (this.kind === 'furnace') {
      const f = this.be.data;
      const widgets = document.createElement('div');
      widgets.className = 'furnace-widgets';
      addGrid([{
        region: 'furnaceIn',
        get: () => f.slots[0], set: v => { f.slots[0] = v; this.markBeDirty(); },
      }], 1);
      widgets.innerHTML = `<div class="gauge-flame"><div id="g-flame"></div></div>
        <div class="gauge-arrow"><div id="g-arrow"></div></div>`;
      panel.appendChild(widgets);
      addGrid([{
        region: 'furnaceFuel',
        get: () => f.slots[1], set: v => { f.slots[1] = v; this.markBeDirty(); },
        canPut: s => fuelValue(s.id) > 0,
      }], 1);
      addGrid([{
        region: 'furnaceOut', takeOnly: true,
        get: () => f.slots[2], set: v => { f.slots[2] = v; this.markBeDirty(); },
        onTakeOut: n => {
          // banked XP payout (06 §11.1)
          const xp = Math.floor(f.xpBank);
          if (xp > 0) { this.game.player.addXp(xp); f.xpBank -= xp; }
        },
      }], 1);
    }

    const spacer = document.createElement('div');
    spacer.className = 'spacer-row';
    panel.appendChild(spacer);
    addGrid(this.playerSlots().slice(0, 27), 9);
    const spacer2 = document.createElement('div');
    spacer2.className = 'spacer-row';
    panel.appendChild(spacer2);
    addGrid(this.playerSlots().slice(27), 9);

    this.root.appendChild(panel);
    this.refresh();
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

    if (slot.takeOnly) {
      this.takeResult(slot, e.shiftKey);
      this.refresh();
      return;
    }

    if (e.shiftKey && e.button === 0) {
      this.shiftMove(slot);
    } else if (e.button === 0) {
      // double-click collect
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
        const take = Math.ceil(inSlot.count / 2);
        const taken = { ...inSlot, count: take };
        inSlot.count -= take;
        if (inSlot.count <= 0) slot.set(null);
        this.cursor = taken;
      } else if (cur && (!inSlot || (same(cur, inSlot) && inSlot.count < stackMax(cur.id)))) {
        if (!slot.canPut || slot.canPut(cur)) {
          if (inSlot) inSlot.count++;
          else slot.set({ ...cur, count: 1 });
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
        // craft repeatedly (06 §9)
        for (let n = 0; n < 64; n++) {
          const r = slot.get();
          if (!r) break;
          if (this.game.player.give({ ...r }) > 0) break;
          slot.onCraft();
        }
      } else {
        if (this.cursor && !(same(this.cursor, out) &&
            this.cursor.count + out.count <= stackMax(out.id))) return;
        if (this.cursor) this.cursor.count += out.count;
        else this.cursor = { ...out };
        slot.onCraft();
      }
    } else {
      // furnace output
      if (shift) {
        const leftover = this.game.player.give(out);
        if (leftover > 0) out.count = leftover;
        else slot.set(null);
        slot.onTakeOut?.();
      } else {
        if (this.cursor && !(same(this.cursor, out) &&
            this.cursor.count + out.count <= stackMax(out.id))) return;
        if (this.cursor) this.cursor.count += out.count;
        else this.cursor = { ...out };
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
    if (slot.region === 'container' || slot.region === 'furnaceIn' ||
        slot.region === 'furnaceFuel' || slot.region === 'furnaceOut' ||
        slot.region === 'craft' || slot.region === 'armor' || slot.region === 'result') {
      return bySel(['hotbar', 'main']);
    }
    // from player inventory:
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

  dropFromSlot(index, whole) {
    const slot = this.slots[index];
    if (!slot || slot.takeOnly) return;
    const s = slot.get();
    if (!s) return;
    const n = whole ? s.count : 1;
    this.game.throwStack({ ...s, count: n });
    s.count -= n;
    if (s.count <= 0) slot.set(null);
    this.refresh();
  }

  showTooltip(index) {
    const s = this.slots[index]?.get();
    if (!s) { this.tooltipEl.style.display = 'none'; return; }
    const item = ITEMS.get(s.id);
    let text = item?.displayName ?? '?';
    if (item?.durability && s.damage > 0) text += ` ${item.durability - s.damage}/${item.durability}`;
    this.tooltipEl.textContent = text;
    this.tooltipEl.style.display = 'block';
    this.tooltipEl.style.left = (this.mouseX + 14) + 'px';
    this.tooltipEl.style.top = (this.mouseY - 22) + 'px';
  }

  // ---------------------------------------------------- rendering

  renderStackInto(el, stack) {
    const icon = el.children[0], count = el.children[1];
    if (stack) {
      iconCss(icon, tileForItemId(this.game, stack.id));
      icon.style.display = 'block';
      count.textContent = stack.count > 1 ? stack.count : '';
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
    for (const slot of this.slots) this.renderStackInto(slot.el, slot.get());
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
    // block gone or player walked away → close
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
