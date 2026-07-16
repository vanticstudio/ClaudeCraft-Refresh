// HUD: hotbar, hearts, hunger, armor, air, XP, overlays (06 §15.1, 03 §23).
// Dirty-checked DOM writes only (01 §15.3).
import { ITEMS } from '../registry/items.js';
import { BLOCKS } from '../registry/blocks.js';

export function iconCss(el, tile) {
  const col = tile & 31, row = tile >> 5;
  el.classList.add('icon');
  el.style.backgroundPosition =
    `calc(-16 * ${col} * var(--px)) calc(-16 * ${row} * var(--px))`;
}

export function tileForItemId(game, id) {
  const item = ITEMS.get(id);
  if (!item) return 0;
  if (item.sprite && game.atlas.TILE[item.sprite] !== undefined) return game.atlas.TILE[item.sprite];
  if (item.place != null && BLOCKS[item.place]?.tileIndex) return BLOCKS[item.place].tileIndex[4];
  return 0;
}

export class Hud {
  constructor(game, overlayEl) {
    this.game = game;
    this.cache = {};
    overlayEl.innerHTML = `
      <div id="hud">
        <div id="crosshair"></div>
        <div id="vignette-damage"></div>
        <div id="overlay-fire"></div>
        <div id="overlay-water"></div>
        <div id="status-rows">
          <div class="row-pair">
            <div id="armor-row" class="row-half"></div>
            <div id="air-row" class="row-half"></div>
          </div>
          <div class="row-pair">
            <div id="hearts-row" class="row-half"></div>
            <div id="hunger-row" class="row-half"></div>
          </div>
          <div id="xp-bar"><div id="xp-fill"></div><div id="xp-level"></div></div>
        </div>
        <div id="hotbar"></div>
        <div id="item-name"></div>
        <div id="toast"></div>
        <div id="sleep-fade"></div>
        <div id="debug-badge">DEBUG CREATIVE (F4)</div>
      </div>`;
    this.el = {
      hearts: document.getElementById('hearts-row'),
      hunger: document.getElementById('hunger-row'),
      armor: document.getElementById('armor-row'),
      air: document.getElementById('air-row'),
      xpFill: document.getElementById('xp-fill'),
      xpLevel: document.getElementById('xp-level'),
      hotbar: document.getElementById('hotbar'),
      itemName: document.getElementById('item-name'),
      toast: document.getElementById('toast'),
      vignette: document.getElementById('vignette-damage'),
      fire: document.getElementById('overlay-fire'),
      water: document.getElementById('overlay-water'),
      sleep: document.getElementById('sleep-fade'),
      badge: document.getElementById('debug-badge'),
      hud: document.getElementById('hud'),
    };
    this.slots = [];
    for (let i = 0; i < 9; i++) {
      const d = document.createElement('div');
      d.className = 'hotbar-slot';
      d.innerHTML = `<div class="slot-icon"></div><div class="slot-count"></div><div class="dur-bar" style="display:none"><div></div></div>`;
      this.el.hotbar.appendChild(d);
      this.slots.push(d);
    }
    this.pips(this.el.hearts, 10);
    this.pips(this.el.hunger, 10);
    this.pips(this.el.armor, 10);
    this.pips(this.el.air, 10);
    this.damageFlash = 0;
    this.nameFlash = 0;
    this.toastTimer = 0;
  }

  pips(rowEl, n) {
    for (let i = 0; i < n; i++) {
      const p = document.createElement('div');
      p.className = 'pip';
      rowEl.appendChild(p);
    }
  }

  onDamage() {
    this.damageFlash = 10;
    this.el.vignette.style.opacity = '1';
    setTimeout(() => { this.el.vignette.style.opacity = '0'; }, 250);
  }

  onHotbarChange() {
    const s = this.game.player?.heldStack;
    if (s) {
      this.el.itemName.textContent = ITEMS.get(s.id)?.displayName ?? '';
      this.el.itemName.style.opacity = '1';
      clearTimeout(this.nameFlash);
      this.nameFlash = setTimeout(() => { this.el.itemName.style.opacity = '0'; }, 2000);
    } else {
      this.el.itemName.style.opacity = '0';
    }
  }

  toast(msg) {
    this.el.toast.textContent = msg;
    this.el.toast.style.opacity = '1';
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.el.toast.style.opacity = '0'; }, 2500);
  }

  setSleepFade(on) { this.el.sleep.style.opacity = on ? '1' : '0'; }

  setDirty(key, value) {
    if (this.cache[key] === value) return false;
    this.cache[key] = value;
    return true;
  }

  update() {
    const p = this.game.player;
    if (!p) return;

    // hearts (2 HP per heart)
    const hp = Math.ceil(p.health);
    if (this.setDirty('hp', hp + '|' + p.hurtTime)) {
      const pips = this.el.hearts.children;
      for (let i = 0; i < 10; i++) {
        const v = hp - i * 2;
        pips[i].textContent = v >= 2 ? '❤' : v === 1 ? '❥' : '❤';
        pips[i].style.color = v >= 2 ? '#e0241c' : v === 1 ? '#e0241c' : '#3a0d0d';
      }
      this.el.hearts.style.transform = p.hurtTime > 0
        ? `translateX(${(p.hurtTime % 2 ? 1 : -1) * 2}px)` : '';
    }

    // hunger
    const food = p.foodLevel;
    if (this.setDirty('food', food + '|' + (p.foodPoisonTicks > 0))) {
      const pips = this.el.hunger.children;
      for (let i = 0; i < 10; i++) {
        const v = food - i * 2;
        pips[i].textContent = v >= 2 ? '🍗' : v === 1 ? '🍖' : '·';
        pips[i].style.filter = p.foodPoisonTicks > 0
          ? 'hue-rotate(90deg)' : v >= 1 ? 'none' : 'grayscale(1) brightness(0.4)';
      }
    }

    // armor
    const ap = p.armorPoints();
    if (this.setDirty('armor', ap)) {
      const pips = this.el.armor.children;
      this.el.armor.style.display = ap > 0 ? 'flex' : 'none';
      for (let i = 0; i < 10; i++) {
        const v = ap - i * 2;
        pips[i].textContent = v >= 2 ? '🛡' : v === 1 ? '◗' : '';
      }
    }

    // air bubbles (03 §10.3)
    const bubbles = p.air >= 300 ? -1 : Math.ceil(Math.max(0, p.air) / 30);
    if (this.setDirty('air', bubbles)) {
      this.el.air.style.display = bubbles < 0 ? 'none' : 'flex';
      const pips = this.el.air.children;
      for (let i = 0; i < 10; i++) pips[i].textContent = i < bubbles ? '🫧' : '';
    }

    // XP
    const fill = Math.floor(p.xpPoints / p.xpToNext(p.xpLevel) * 100);
    if (this.setDirty('xp', fill + '|' + p.xpLevel)) {
      this.el.xpFill.style.width = fill + '%';
      this.el.xpLevel.textContent = p.xpLevel > 0 ? p.xpLevel : '';
    }

    // hotbar
    for (let i = 0; i < 9; i++) {
      const s = p.inventory[i];
      const sig = s ? `${s.id}|${s.count}|${s.damage ?? ''}|${i === p.selectedSlot}` : `e|${i === p.selectedSlot}`;
      if (!this.setDirty('hb' + i, sig)) continue;
      const d = this.slots[i];
      d.classList.toggle('selected', i === p.selectedSlot);
      const icon = d.children[0], count = d.children[1], dur = d.children[2];
      if (s) {
        iconCss(icon, tileForItemId(this.game, s.id));
        icon.style.display = 'block';
        count.textContent = s.count > 1 ? s.count : '';
        const item = ITEMS.get(s.id);
        if (item?.durability && s.damage > 0) {
          const f = 1 - s.damage / item.durability;
          dur.style.display = 'block';
          dur.firstElementChild.style.width = `${f * 100}%`;
          dur.firstElementChild.style.background = `hsl(${f * 120}, 90%, 45%)`;
        } else dur.style.display = 'none';
      } else {
        icon.style.display = 'none';
        count.textContent = '';
        dur.style.display = 'none';
      }
    }

    // overlays
    const fire = p.fireTicks > 0 && p.gameMode !== 'debugCreative';
    if (this.setDirty('fire', fire)) this.el.fire.style.display = fire ? 'block' : 'none';
    if (this.setDirty('eye', p.eyeSubmerged)) this.el.water.style.display = p.eyeSubmerged ? 'block' : 'none';
    if (this.setDirty('mode', p.gameMode)) this.el.badge.style.display = p.gameMode === 'debugCreative' ? 'block' : 'none';
  }
}
