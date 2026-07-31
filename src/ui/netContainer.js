// 14-MULTIPLAYER §6 — the CLIENT-side networked container screen (chest-class).
// Host-authoritative + non-predictive: clicks are sent to the host, which applies
// the 06 §14.2-style semantics and returns the authoritative slots/cursor; the
// screen re-renders from that result. Guarantees no dupe/loss (host is the sole
// arbiter). Crafting/enchant/anvil for clients are out of scope (host declines).
import { STATE } from '../constants.js';
import { ITEMS } from '../registry/items.js';

export class NetContainer {
  constructor(game, screensEl) {
    this.game = game;
    this.windowId = null;
    this.slots = [];
    this.inv = [];
    this.cursor = null;
    this._build(screensEl);
  }

  _build(screensEl) {
    const root = document.createElement('div');
    root.id = 'net-container';
    root.className = 'screen';
    root.innerHTML = `<div class="nc-panel">
      <div class="nc-title" id="nc-title">Chest</div>
      <div class="nc-grid" id="nc-chest"></div>
      <div class="nc-sep"></div>
      <div class="nc-grid nc-inv" id="nc-inv"></div>
      <div class="nc-cursor" id="nc-cursor"></div>
    </div>`;
    screensEl.appendChild(root);
    this.root = root;
    this.chestEl = root.querySelector('#nc-chest');
    this.invEl = root.querySelector('#nc-inv');
    this.cursorEl = root.querySelector('#nc-cursor');
    this.titleEl = root.querySelector('#nc-title');
    document.addEventListener('mousemove', e => { if (this.isOpen()) { this.cursorEl.style.left = e.clientX + 'px'; this.cursorEl.style.top = e.clientY + 'px'; } });
  }

  isOpen() { return this.windowId != null; }

  open(m) {
    this.windowId = m.windowId;
    this.slots = m.slots || [];
    this.inv = m.inv || [];
    this.cursor = null;
    this.titleEl.textContent = (m.kind ? m.kind[0].toUpperCase() + m.kind.slice(1) : 'Container');
    this.root.classList.add('visible');
    document.exitPointerLock?.();
    this.game.setState(STATE.PLAYING_UI);
    this._render();
  }

  applyResult(m) {
    if (m.windowId !== this.windowId) return;
    if (m.close) { this.windowId = null; this.root.classList.remove('visible'); if (this.game.state === STATE.PLAYING_UI) { this.game.setState(STATE.PLAYING); this.game.input.requestLock(); } return; }
    if (m.slots) this.slots = m.slots;
    if (m.inv) this.inv = m.inv;
    // a co-viewer's slot-only update omits cursor — don't clobber our own (audit M6).
    if ('cursor' in m) this.cursor = m.cursor || null;
    this._render();
  }

  close() {
    if (!this.isOpen()) return;
    this.game.net?.sendContainerClose?.(this.windowId);
    this.windowId = null;
    this.root.classList.remove('visible');
    if (this.game.state === STATE.PLAYING_UI) { this.game.setState(STATE.PLAYING); this.game.input.requestLock(); }
  }

  _cell(stack, region, i) {
    const d = document.createElement('div');
    d.className = 'nc-slot';
    if (stack) {
      const item = ITEMS.get(stack.id);
      // The registry field is `displayName` (items.js §1) — `display` exists only
      // on EFFECT_META, so every cell fell back to the raw id.
      d.title = item?.displayName ?? String(stack.id);
      d.textContent = (item?.displayName ?? ('#' + stack.id)).slice(0, 3);
      if (stack.count > 1) { const c = document.createElement('span'); c.className = 'nc-count'; c.textContent = stack.count; d.appendChild(c); }
    }
    d.oncontextmenu = e => e.preventDefault();
    d.onmousedown = e => {
      e.preventDefault();
      this.game.net?.sendContainerClick?.({ windowId: this.windowId, region, slotIndex: i, button: e.button, shift: e.shiftKey });
    };
    return d;
  }

  _render() {
    this.chestEl.innerHTML = '';
    this.slots.forEach((s, i) => this.chestEl.appendChild(this._cell(s, 'chest', i)));
    this.invEl.innerHTML = '';
    this.inv.forEach((s, i) => this.invEl.appendChild(this._cell(s, 'inv', i)));
    // cursor
    if (this.cursor) { const item = ITEMS.get(this.cursor.id); this.cursorEl.textContent = (item?.displayName ?? '#' + this.cursor.id).slice(0, 3) + (this.cursor.count > 1 ? ' ' + this.cursor.count : ''); this.cursorEl.hidden = false; }
    else this.cursorEl.hidden = true;
  }
}
