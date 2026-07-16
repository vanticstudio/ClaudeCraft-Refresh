// Title / loading / pause / death screens + F4 debug item palette (01 §15.3, 06 §15.4).
import { ITEMS } from '../registry/items.js';
import { iconCss, tileForItemId } from './hud.js';

export class Menus {
  constructor(game, screensEl, hooks) {
    this.game = game;
    this.hooks = hooks;
    screensEl.insertAdjacentHTML('beforeend', `
      <div id="screen-title" class="screen">
        <h1>VoxelCraft</h1>
        <button id="btn-continue" style="display:none">Continue World</button>
        <input id="seed-input" placeholder="Seed (blank = random)" spellcheck="false">
        <button id="btn-new">New World</button>
        <button id="btn-delete" style="display:none">Delete World</button>
      </div>
      <div id="screen-loading" class="screen">
        <h1>Building terrain…</h1>
        <div id="loading-bar-outer"><div id="loading-bar"></div></div>
        <div id="loading-label"></div>
      </div>
      <div id="screen-pause" class="screen">
        <h1>Paused</h1>
        <button id="btn-resume">Resume</button>
        <button id="btn-quit">Save &amp; Quit to Title</button>
        <div style="opacity:0.6;font-size:14px">Sprint: double-tap W · Drop stack: Shift+Q · Debug: F3/F4</div>
      </div>
      <div id="screen-death" class="screen">
        <h1>You Died!</h1>
        <div id="death-score" style="font-size:20px"></div>
        <button id="btn-respawn">Respawn</button>
        <button id="btn-death-title">Title Screen</button>
      </div>
      <div id="debug-palette" style="display:none; position:absolute; right:8px; top:8px; bottom:8px;
           width:390px; overflow-y:auto; background:rgba(20,20,28,0.92); border:2px solid #555;
           padding:6px; pointer-events:auto; z-index:30">
        <input id="palette-filter" placeholder="filter…" style="width:100%;margin-bottom:6px;
               background:#111;color:#eee;border:1px solid #555;font-family:inherit;padding:4px">
        <div id="palette-grid" style="display:grid;grid-template-columns:repeat(7,48px);gap:3px"></div>
      </div>`);

    const $ = id => document.getElementById(id);
    this.el = {
      title: $('screen-title'), loading: $('screen-loading'),
      pause: $('screen-pause'), death: $('screen-death'),
      bar: $('loading-bar'), label: $('loading-label'),
      score: $('death-score'), seed: $('seed-input'),
      btnContinue: $('btn-continue'), btnDelete: $('btn-delete'),
      palette: $('debug-palette'), paletteGrid: $('palette-grid'),
      paletteFilter: $('palette-filter'),
    };
    $('btn-new').onclick = () => hooks.onNewWorld(this.el.seed.value.trim());
    this.el.btnContinue.onclick = () => hooks.onContinue();
    this.el.btnDelete.onclick = () => hooks.onDelete();
    $('btn-resume').onclick = () => hooks.onResume();
    $('btn-quit').onclick = () => hooks.onQuit();
    $('btn-respawn').onclick = () => hooks.onRespawn();
    $('btn-death-title').onclick = () => hooks.onQuit();
    this.el.paletteFilter.addEventListener('input', () => this.fillPalette());
    this.paletteBuilt = false;
  }

  setHasSave(has) {
    this.el.btnContinue.style.display = has ? 'block' : 'none';
    this.el.btnDelete.style.display = has ? 'block' : 'none';
  }

  show(name) {
    for (const key of ['title', 'loading', 'pause', 'death']) {
      this.el[key].classList.toggle('visible', key === name);
    }
    if (name === 'death' && this.game.player) {
      this.el.score.textContent = `Score: ${this.game.player.xpTotal}`;
    }
  }

  setLoadingProgress(meshed, needed) {
    this.el.bar.style.width = `${Math.min(100, meshed / needed * 100)}%`;
    this.el.label.textContent = `${meshed} / ${needed} chunks`;
  }

  // F4 debug palette (06 §15.4)
  setPaletteVisible(on) {
    this.el.palette.style.display = on ? 'block' : 'none';
    if (on && !this.paletteBuilt) { this.fillPalette(); this.paletteBuilt = true; }
  }

  fillPalette() {
    const filter = this.el.paletteFilter.value.toLowerCase();
    this.el.paletteGrid.innerHTML = '';
    for (const [id, item] of ITEMS) {
      if (filter && !item.name.includes(filter)) continue;
      const d = document.createElement('div');
      d.style.cssText = 'width:48px;height:48px;background:#333;border:1px solid #555;display:flex;align-items:center;justify-content:center;cursor:pointer';
      d.title = item.displayName;
      const icon = document.createElement('div');
      iconCss(icon, tileForItemId(this.game, id));
      d.appendChild(icon);
      d.addEventListener('mousedown', e => {
        e.preventDefault();
        const p = this.game.player;
        if (!p || p.gameMode !== 'debugCreative') return;
        const count = e.button === 2 ? 1 : (item.stack ?? 64);
        p.give({ id, count });
      });
      d.addEventListener('contextmenu', e => e.preventDefault());
      this.el.paletteGrid.appendChild(d);
    }
  }
}
