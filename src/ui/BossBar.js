// 13-BOSSES §1 — the boss-bar HUD manager. Up to 3 stacked bars, top-center.
// Bosses call add/set/remove each tick; update() (driven from Hud.update every
// frame) eases each bar's fill toward its true fraction.
export class BossBar {
  constructor(hostEl) {
    // a #boss-bars container inside #hud (created by Hud's template, or made here)
    this.root = hostEl.querySelector('#boss-bars') || (() => {
      const d = document.createElement('div'); d.id = 'boss-bars'; hostEl.appendChild(d); return d;
    })();
    this.bars = new Map();   // id → { name, color, actual, display, el, fillEl, removing }
  }

  add(id, { name, color }) {
    let b = this.bars.get(id);
    // Re-add of a bar mid-fade: clearing `removing` alone leaves the element on
    // whatever opacity update() had already decremented it to (the Wither drops
    // and re-adds its bar across the 128-block range edge), so the bar comes back
    // permanently translucent and dims further on every crossing.
    if (b) { b.name = name; b.color = color; b.removing = false; b.el.style.opacity = '1'; return b; }
    const el = document.createElement('div');
    el.className = 'boss-bar';
    el.innerHTML = `<div class="bb-name"></div><div class="bb-track"><div class="bb-fill"></div></div>`;
    el.querySelector('.bb-name').textContent = name;
    const fillEl = el.querySelector('.bb-fill');
    fillEl.style.background = color;
    this.root.appendChild(el);
    b = { name, color, actual: 1, display: 1, el, fillEl, removing: false };
    this.bars.set(id, b);
    return b;
  }

  set(id, fraction) {
    const b = this.bars.get(id);
    if (b) b.actual = Math.max(0, Math.min(1, fraction));
  }

  remove(id) {
    const b = this.bars.get(id);
    if (b) b.removing = true;   // slides out (fade) then unmounts in update()
  }

  // 13-BOSSES — drop every bar immediately (e.g. on a dimension change, where the
  // boss that owned the bar stops ticking and can't remove it itself).
  clearAll() {
    for (const b of this.bars.values()) b.el.remove();
    this.bars.clear();
  }

  // Per-frame: ease display→actual, repaint fill width; fade+drop removed bars.
  update() {
    if (this.bars.size === 0) return;
    for (const [id, b] of this.bars) {
      if (b.removing) {
        b.el.style.opacity = (parseFloat(b.el.style.opacity || '1') - 0.1).toString();
        if (parseFloat(b.el.style.opacity) <= 0) { b.el.remove(); this.bars.delete(id); }
        continue;
      }
      b.display += (b.actual - b.display) * 0.1;
      b.fillEl.style.width = (b.display * 100).toFixed(1) + '%';
    }
  }
}
