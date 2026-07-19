// HUD: hotbar, hearts, hunger, armor, air, XP, overlays (06 §15.1, 03 §23).
// Dirty-checked DOM writes only (01 §15.3).
import { ITEMS } from '../registry/items.js';
import { BLOCKS } from '../registry/blocks.js';
import { isGlinted, paintGlintIcon } from '../render/glint.js';
import { EFFECT, EFFECT_META } from '../status/effects.js';
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

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

// 08 §11 — the shared glint frame. Advanced at 4 Hz by Hud.update (one counter
// for the whole UI, so every enchanted slot shimmers in step). §11: "Re-composited
// at 4 Hz, only for enchanted slots currently on screen".
export const glintFrame = { n: 0 };

/**
 * 08 §11 — paint one slot icon. An enchanted stack gets a <canvas> with the
 * silhouette-clipped shimmer; everything else keeps the plain atlas-background
 * div, which costs nothing.
 *
 * Both the HUD hotbar and every container slot funnel through here, so the two
 * cannot drift apart on which stacks glint.
 */
export function paintSlotIcon(el, game, stack) {
  const tile = tileForItemId(game, stack.id);
  if (!isGlinted(stack)) {
    if (el._glintCanvas) { el._glintCanvas.remove(); el._glintCanvas = null; }
    iconCss(el, tile);
    return;
  }
  let c = el._glintCanvas;
  if (!c) {
    c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    c.className = 'glint-canvas';
    el.appendChild(c);
    el._glintCanvas = c;
  }
  // The div's own atlas background would show through the canvas's transparent
  // pixels, so it must be cleared once the canvas takes over.
  el.classList.remove('icon');
  el.style.backgroundPosition = '';
  paintGlintIcon(c, game.atlas, tile, glintFrame.n);
}

export class Hud {
  constructor(game, overlayEl) {
    this.game = game;
    this.cache = {};
    overlayEl.innerHTML = `
      <div id="hud">
        <div id="boss-bars"></div>
        <div id="crosshair"></div>
        <div id="vignette-damage"></div>
        <div id="overlay-fire"></div>
        <div id="overlay-water"></div>
        <div id="status-rows">
          <div class="row-pair">
            <div id="armor-row" class="row-half"></div>
            <div id="air-row" class="row-half"></div>
          </div>
          <div id="absorption-row" class="row-half"></div>
          <div class="row-pair">
            <div id="hearts-row" class="row-half"></div>
            <div id="hunger-row" class="row-half"></div>
          </div>
          <div id="xp-bar"><div id="xp-fill"></div><div id="xp-level"></div></div>
        </div>
        <div id="effect-stack"></div>
        <div id="offhand-slot"></div>
        <div id="hotbar"></div>
        <div id="item-name"></div>
        <div id="toast"></div>
        <div id="sleep-fade"></div>
        <div id="mode-badge">CREATIVE</div>
        <div id="join-badge" hidden title="Click to copy the join code"></div>
      </div>`;
    this.el = {
      effectStack: document.getElementById('effect-stack'),
      absorption: document.getElementById('absorption-row'),
      hearts: document.getElementById('hearts-row'),
      hunger: document.getElementById('hunger-row'),
      armor: document.getElementById('armor-row'),
      air: document.getElementById('air-row'),
      xpBar: document.getElementById('xp-bar'),
      xpFill: document.getElementById('xp-fill'),
      xpLevel: document.getElementById('xp-level'),
      hotbar: document.getElementById('hotbar'),
      offhand: document.getElementById('offhand-slot'),
      itemName: document.getElementById('item-name'),
      toast: document.getElementById('toast'),
      vignette: document.getElementById('vignette-damage'),
      fire: document.getElementById('overlay-fire'),
      water: document.getElementById('overlay-water'),
      sleep: document.getElementById('sleep-fade'),
      badge: document.getElementById('mode-badge'),
      hud: document.getElementById('hud'),
    };
    this.creative = false;
    this.slots = [];
    for (let i = 0; i < 9; i++) {
      const d = document.createElement('div');
      d.className = 'hotbar-slot';
      d.innerHTML = `<div class="slot-icon"></div><div class="slot-count"></div><div class="dur-bar" style="display:none"><div></div></div>`;
      this.el.hotbar.appendChild(d);
      this.slots.push(d);
    }
    // 08 §7.5 — the offhand slot: same markup and style as a hotbar slot, in
    // its own frame left of the hotbar. Shown only when non-empty (vanilla);
    // the frame's visibility is the `filled` class on the wrapper.
    this.offhandSlot = document.createElement('div');
    this.offhandSlot.className = 'hotbar-slot';
    this.offhandSlot.innerHTML = `<div class="slot-icon"></div><div class="slot-count"></div><div class="dur-bar" style="display:none"><div></div></div>`;
    this.el.offhand.appendChild(this.offhandSlot);
    this.pips(this.el.hearts, 10);
    this.pips(this.el.hunger, 10);
    this.pips(this.el.armor, 10);
    this.pips(this.el.absorption, 10);   // 09-POTIONS §3.7 — yellow row above hearts
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

  // 14 §8.1 — persistent host badge showing the join code (click = copy).
  setJoinCode(code) {
    const b = document.getElementById('join-badge');
    if (!b) return;
    this._joinCode = code;
    b.hidden = false;
    b.classList.remove('relay-lost');
    b.textContent = `Code: ${code} ⧉`;
    b.onclick = () => { try { navigator.clipboard?.writeText(code); this.toast('Join code copied'); } catch {} };
  }
  setRelayLost() {
    const b = document.getElementById('join-badge');
    if (!b) return;
    b.classList.add('relay-lost');
    b.textContent = 'Relay lost — session ended';
    b.onclick = null;
  }

  /**
   * AMENDS 03 §23 / 18 §1.4 — show/hide the survival cluster on a mode switch
   * instead of branching every frame. Hearts, hunger, air and the XP bar are
   * meaningless in creative (§4.3); the crosshair, hotbar and selection/crack
   * overlays stay. The armor row keeps its own `points > 0` rule — §23's amend
   * enumerates four rows and armor is not among them.
   */
  rebuild() {
    this.creative = !!this.game.player?.creative;
    const vis = this.creative ? 'none' : '';
    this.el.hearts.style.display = vis;
    this.el.hunger.style.display = vis;
    this.el.xpBar.style.display = vis;
    if (this.creative) this.el.air.style.display = 'none';
    this.el.badge.style.display = this.creative ? 'block' : 'none';
    // The dirty cache would otherwise suppress the re-render on the way back:
    // update() compares against the value it last WROTE, which is still the
    // live one, so every row would stay hidden.
    this.cache = {};
  }

  setDirty(key, value) {
    if (this.cache[key] === value) return false;
    this.cache[key] = value;
    return true;
  }

  // 09-POTIONS §6.1 — active-effect icon stack (top-right, mm:ss, blink < 10 s,
  // blue frame for ambient/beacon effects). Max 8 shown, newest below.
  updateEffects(p) {
    const el = this.el.effectStack;
    if (!el) return;
    const active = [...p.effects.entries()].slice(0, 8);
    const t = this.game.world?.time ?? 0;
    const key = active.map(([id, fx]) => id + ':' + Math.ceil(fx.duration / 20) + ':' + fx.ambient).join('|')
      + '|' + (Math.floor(t / 5) & 1);
    if (!this.setDirty('effects', key)) return;
    el.innerHTML = '';
    for (const [id, fx] of active) {
      const meta = EFFECT_META[id];
      const secs = Math.ceil(fx.duration / 20);
      const mm = Math.floor(secs / 60), ss = secs % 60;
      const blink = secs < 10 && (Math.floor(t / 5) & 1) ? 0.35 : 1;
      const d = document.createElement('div');
      d.className = 'effect-icon' + (fx.ambient ? ' ambient' : '');
      d.style.opacity = blink;
      d.style.borderLeftColor = '#' + ((meta?.color ?? 0xffffff) >>> 0).toString(16).padStart(6, '0');
      d.innerHTML = `<span class="ei-name">${meta?.display ?? id}${fx.amplifier ? ' ' + ROMAN[fx.amplifier + 1] : ''}</span>`
        + `<span class="ei-time">${mm}:${ss.toString().padStart(2, '0')}</span>`;
      el.appendChild(d);
    }
  }

  update() {
    const p = this.game.player;
    if (!p) return;

    // 13-BOSSES §1 — ease the boss bars every frame (independent of the survival rows).
    this.game.ui?.bossBar?.update?.();

    // 08 §11 — advance the shared glint frame at 4 Hz (every 5 ticks at 20 TPS).
    glintFrame.n = ((this.game.world?.time ?? 0) / 5) | 0;

    // 18 §4.3 — the survival rows are hidden in creative; skip their writes
    // entirely, or update() would immediately undo rebuild()'s display:none
    // (the air row in particular sets its own display every frame).
    if (this.creative) { this.updateHotbar(p); this.updateOverlays(p); return; }

    // hearts (2 HP per heart) — 09-POTIONS §6.3 recolors: Wither black, Poison green.
    const hp = Math.ceil(p.health);
    const wither = p.effects.has(EFFECT.WITHER), poison = p.effects.has(EFFECT.POISON);
    const full = wither ? '#4a4a4a' : poison ? '#7aa060' : '#e0241c';
    if (this.setDirty('hp', hp + '|' + p.hurtTime + '|' + full)) {
      const pips = this.el.hearts.children;
      for (let i = 0; i < 10; i++) {
        const v = hp - i * 2;
        pips[i].textContent = v >= 2 ? '❤' : v === 1 ? '❥' : '❤';
        pips[i].style.color = v >= 1 ? full : '#3a0d0d';
      }
      this.el.hearts.style.transform = p.hurtTime > 0
        ? `translateX(${(p.hurtTime % 2 ? 1 : -1) * 2}px)` : '';
    }

    // 09-POTIONS §3.7 — absorption: a separate yellow-heart row above the red
    // hearts, half-heart support, hidden when the pool is empty.
    const abs = p.absorption;
    if (this.setDirty('absorption', Math.round(abs * 2))) {
      this.el.absorption.style.display = abs > 0 ? 'flex' : 'none';
      const pips = this.el.absorption.children;
      for (let i = 0; i < 10; i++) {
        const v = abs - i * 2;
        pips[i].textContent = v >= 2 ? '❤' : v >= 1 ? '❥' : '';
        pips[i].style.color = '#F5C51E';
      }
    }

    // hunger — green while the Hunger effect (§6.3) is active.
    const food = p.foodLevel;
    const hungerFx = p.effects.has(EFFECT.HUNGER);
    if (this.setDirty('food', food + '|' + hungerFx)) {
      const pips = this.el.hunger.children;
      for (let i = 0; i < 10; i++) {
        const v = food - i * 2;
        pips[i].textContent = v >= 2 ? '🍗' : v === 1 ? '🍖' : '·';
        pips[i].style.filter = hungerFx
          ? 'hue-rotate(90deg)' : v >= 1 ? 'none' : 'grayscale(1) brightness(0.4)';
      }
    }

    this.updateEffects(p);

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

    this.updateHotbar(p);
    this.updateOverlays(p);
  }

  // Icon / count / durability bar for one slot frame. Shared by the hotbar and
  // the offhand slot so they cannot drift apart in style (08 §7.5).
  paintSlot(d, s) {
    const icon = d.children[0], count = d.children[1], dur = d.children[2];
    if (s) {
      paintSlotIcon(icon, this.game, s);      // 08 §11 — glints when enchanted
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

  updateHotbar(p) {
    for (let i = 0; i < 9; i++) {
      const s = p.inventory[i];
      // 08 §11 — the glint frame joins the signature ONLY for an enchanted
      // stack, so it re-composites at 4 Hz while every plain slot keeps its
      // "nothing changed → don't touch the DOM" path ("only for enchanted slots
      // currently on screen").
      const gs = s && isGlinted(s) ? `|${glintFrame.n}` : '';
      const sig = s ? `${s.id}|${s.count}|${s.damage ?? ''}|${i === p.selectedSlot}${gs}` : `e|${i === p.selectedSlot}`;
      if (!this.setDirty('hb' + i, sig)) continue;
      const d = this.slots[i];
      d.classList.toggle('selected', i === p.selectedSlot);
      this.paintSlot(d, s);
    }
    // 08 §7.5 — offhand slot, rendered only when the offhand is non-empty.
    const o = p.offhand;
    const osig = o ? `${o.id}|${o.count}|${o.damage ?? ''}${isGlinted(o) ? `|${glintFrame.n}` : ''}` : 'e';
    if (this.setDirty('offhand', osig)) {
      this.el.offhand.classList.toggle('filled', !!o);
      this.paintSlot(this.offhandSlot, o);
    }
  }

  updateOverlays(p) {
    // 18 §4.2 — no flame overlay in creative; fireTicks is forced to 0 anyway,
    // so this guard is belt-and-braces against a same-tick ignition.
    const fire = p.fireTicks > 0 && !p.creative;
    if (this.setDirty('fire', fire)) this.el.fire.style.display = fire ? 'block' : 'none';
    // §4.2: the underwater tint still renders in creative (cosmetic honesty).
    if (this.setDirty('eye', p.eyeSubmerged)) this.el.water.style.display = p.eyeSubmerged ? 'block' : 'none';
  }
}
