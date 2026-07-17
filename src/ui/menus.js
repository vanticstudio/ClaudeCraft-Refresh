// Title / loading / pause / death screens + F4 debug item palette (01 §15.3, 06 §15.4).
// Title screen = the desert/badlands sunset scene from 19-MAIN-MENU §3.
import { ITEMS } from '../registry/items.js';
import { iconCss, tileForItemId } from './hud.js';
import { loadOptions, saveOptions } from './options.js';
import { emitSound, audio } from '../audio/engine.js';

// The five audio buses (16 AMENDS 01 §15.3). Order is the display order.
const OPT_ROWS = [
  ['master', 'Master'], ['music', 'Music'], ['ambient', 'Ambient'],
  ['sfx', 'SFX'], ['ui', 'UI'],
];
// §4A musicMode
const THEME_MODES = [
  ['off', 'Off'], ['menu', 'Menu only'], ['full', 'Menu + gameplay'],
];

export class Menus {
  constructor(game, screensEl, hooks) {
    this.game = game;
    this.hooks = hooks;
    this.started = false;      // PRESS START pressed? (drives the button row)
    this.hasSave = false;
    this.music = null;         // set via attachMusic() once the player exists
    // Share Game's object — a second loadOptions() here would diverge from the
    // copy Game reads for sensitivity/bobbing on every slider drag.
    this.options = game.options ?? loadOptions();
    screensEl.insertAdjacentHTML('beforeend', `
      <div id="screen-title" class="screen">
        <div class="cc-title">
          <div class="cc-sky"></div>
          <div class="cc-sun"></div>
          <div class="cc-cloud one"></div>
          <div class="cc-cloud two"></div>
          <div class="cc-range-far"></div>
          <div class="cc-range-near"></div>
          <div class="cc-range-near tex"></div>
          <div class="cc-ground"></div>
          <div class="cc-ground seams"></div>
          <div class="cc-vignette"></div>

          <div class="cc-badge">CLAUDECRAFT &middot; v${__APP_VERSION__} ALPHA</div>

          <div class="cc-center">
            <img class="cc-logo" id="cc-logo" src="menu/logo-primary.png" alt="ClaudeCraft">
            <h1 class="cc-wordmark" id="cc-wordmark" hidden><span style="color:var(--cc-rust)">C</span><span style="color:var(--cc-terra-d)">l</span><span style="color:var(--cc-clay)">a</span><span style="color:var(--cc-terra)">u</span><span style="color:var(--cc-cobble)">d</span><span style="color:#a95a2c">e</span><span style="color:var(--cc-clay)">C</span><span style="color:var(--cc-cobble-d)">r</span><span style="color:var(--cc-rust)">a</span><span style="color:var(--cc-terra-d)">f</span><span style="color:var(--cc-clay-l)">t</span></h1>
            <div class="cc-tagline">ENDLESS WORLDS AWAIT</div>
          </div>

          <button class="cc-prompt" id="cc-start">&#9654; PRESS START</button>

          <div class="cc-menu" id="cc-menu" hidden>
            <input id="seed-input" class="cc-seed" placeholder="Seed (blank = random)"
                   aria-label="World seed (blank = random)" spellcheck="false">
            <button class="cc-btn" id="btn-new" title="New Game">
              <img src="menu/buttons/btn-new-game.png" alt="New Game"></button>
            <button class="cc-btn" id="btn-continue" title="Continue" hidden>
              <img src="menu/buttons/btn-continue.png" alt="Continue"></button>
            <button class="cc-btn" id="btn-settings" title="Settings">
              <img src="menu/buttons/btn-settings.png" alt="Settings"></button>
            <button class="cc-btn" id="btn-quit-title" title="Quit">
              <img src="menu/buttons/btn-quit.png" alt="Quit"></button>
          </div>

        </div>
      </div>
      <div id="screen-loading" class="screen">
        <h1>Building terrain…</h1>
        <div id="loading-bar-outer"><div id="loading-bar"></div></div>
        <div id="loading-label"></div>
      </div>
      <div id="screen-pause" class="screen">
        <h1>Paused</h1>
        <button id="btn-resume">Resume</button>
        <button id="btn-pause-settings">Options…</button>
        <button id="btn-quit">Save &amp; Quit to Title</button>
        <div style="opacity:0.6;font-size:14px">Sprint: double-tap W · Drop stack: Shift+Q · Debug: F3/F4</div>
      </div>
      <div id="screen-death" class="screen">
        <h1>You Died!</h1>
        <div id="death-score" style="font-size:20px"></div>
        <button id="btn-respawn">Respawn</button>
        <button id="btn-death-title">Title Screen</button>
      </div>
      <!-- Options (16 AMENDS 01 §15.3): a TOP-LEVEL sheet, deliberately not
           nested in #screen-title — .screen{display:none} would make it
           unreachable from PAUSE, which the amendment requires. -->
      <div class="cc-settings" id="cc-settings" hidden>
        <div class="cc-panel" role="dialog" aria-modal="true" aria-label="Settings">
          <h2>Options</h2>
          ${OPT_ROWS.map(([k, label]) => `
          <label class="cc-row">
            <span>${label}</span>
            <input type="range" min="0" max="100" step="1" id="opt-${k}">
            <output id="out-${k}"></output>
          </label>`).join('')}
          <label class="cc-row">
            <span>Theme music</span>
            <select id="opt-musicMode">
              ${THEME_MODES.map(([v, label]) => `<option value="${v}">${label}</option>`).join('')}
            </select>
            <output></output>
          </label>
          <label class="cc-row">
            <span>Sensitivity</span>
            <input type="range" min="0.1" max="3" step="0.05" id="opt-mouseSensitivity">
            <output id="out-mouseSensitivity"></output>
          </label>
          <label class="cc-row">
            <span>View bobbing</span>
            <input type="checkbox" id="opt-viewBobbing">
            <output></output>
          </label>
          <div class="cc-note">Menu music plays original/cleared tracks only.
            In-game audio is fully synthesized.</div>
          <!-- text buttons: the art pack has no Back/Delete plates, and
               reusing CONTINUE/QUIT art here would mislabel the action -->
          <div class="cc-actions">
            <button class="cc-textbtn" id="btn-settings-back">&#9664; Back</button>
            <button class="cc-textbtn danger" id="btn-delete" hidden>Delete World</button>
          </div>
        </div>
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
      logo: $('cc-logo'), wordmark: $('cc-wordmark'),
      start: $('cc-start'), menu: $('cc-menu'), settings: $('cc-settings'),
      stage: document.querySelector('#screen-title .cc-title'),
    };
    // wordmark fallback: swap in the CSS-text twin if the logo PNG fails (§3.1)
    this.el.logo.addEventListener('error', () => {
      this.el.logo.hidden = true;
      this.el.wordmark.hidden = false;
    }, { once: true });

    // Every button is a gesture: unlock the context and tick, then act (§1.1 —
    // idempotent and cheap, so no first-click tracking). unlock() must run
    // synchronously inside the handler; the async hooks await past the gesture.
    const btn = (id, fn) => {
      $(id).onclick = e => {
        audio.unlock();
        emitSound('ui.click', null);
        fn(e);
      };
    };

    this.el.start.onclick = () => this.pressStart();
    btn('btn-new', () => hooks.onNewWorld(this.el.seed.value.trim()));
    btn('btn-continue', () => hooks.onContinue());
    btn('btn-delete', () => hooks.onDelete());
    btn('btn-settings', () => this.showSettings(true));
    btn('btn-pause-settings', () => this.showSettings(true));
    btn('btn-settings-back', () => this.showSettings(false));
    // web build: no process exit — return to the PRESS START state (§3.2)
    btn('btn-quit-title', () => this.resetTitle());
    btn('btn-resume', () => hooks.onResume());
    btn('btn-quit', () => hooks.onQuit());
    btn('btn-respawn', () => hooks.onRespawn());
    btn('btn-death-title', () => hooks.onQuit());
    this.el.paletteFilter.addEventListener('input', () => this.fillPalette());
    this.paletteBuilt = false;
    // scoped to the title screen, so it cannot swallow keys during play
    this.el.title.addEventListener('keydown', e => this._onTitleKey(e));
    // The panel is no longer inside #screen-title, so Escape and the focus trap
    // need their own binding — otherwise both die the moment PAUSE hosts it.
    this.el.settings.addEventListener('keydown', e => this._onSettingsKey(e));

    for (const [key] of OPT_ROWS) {
      const slider = $(`opt-${key}`), out = $(`out-${key}`);
      slider.value = this.options[key];
      out.textContent = this.options[key];
      slider.addEventListener('input', () => {
        this.options[key] = Number(slider.value);
        out.textContent = slider.value;
        this.applyOptions();
      });
    }

    const mode = $('opt-musicMode');
    mode.value = this.options.musicMode;
    mode.addEventListener('change', () => {
      this.options.musicMode = mode.value;
      this.applyOptions();
      this.applyMusicMode();
    });

    const sens = $('opt-mouseSensitivity'), sensOut = $('out-mouseSensitivity');
    sens.value = this.options.mouseSensitivity;
    sensOut.textContent = Number(this.options.mouseSensitivity).toFixed(2);
    sens.addEventListener('input', () => {
      this.options.mouseSensitivity = Number(sens.value);
      sensOut.textContent = Number(sens.value).toFixed(2);
      this.applyOptions();
    });

    const bob = $('opt-viewBobbing');
    bob.checked = this.options.viewBobbing !== false;
    bob.addEventListener('change', () => {
      this.options.viewBobbing = bob.checked;
      this.applyOptions();
    });

    this.applyTitleButtons();
  }

  /** One writer for the shared options object: buses live, then persist (§15.3). */
  applyOptions() {
    audio.setOptions(this.options);
    this.music?.setOptions(this.options);
    this.hooks.onOptions?.(this.options);
    saveOptions(this.options);
  }

  /** §4A: 'off' silences the theme layer; 'menu'/'full' rearm it on the title. */
  applyMusicMode() {
    const m = this.options.musicMode;
    if (m === 'off') this.music?.stop(0.8);
    else if (this.game.state === 'TITLE' && this.started) this.music?.start({ context: 'title' });
  }

  /** The §4A theme player, handed in once main.js has built it. */
  attachMusic(music) {
    this.music = music;
    music.setOptions(this.options);
  }

  /** First user gesture: reveal the buttons and start the music (§3.2/§4.5). */
  pressStart() {
    if (this.started) return;
    this.started = true;
    audio.unlock();               // covers the button AND the keyboard path
    emitSound('ui.click', null);
    this.applyTitleButtons();
    this.el.menu.querySelector('button:not([hidden])')?.focus();
    // autoplay-safe: gesture-driven. 'off' means no theme layer at all (§4A).
    if (this.options.musicMode !== 'off') this.music?.start({ context: 'title' });
    // the reference screen's public hook (§3.2) — kept so external wiring works
    document.dispatchEvent(new CustomEvent('claudecraft:start'));
  }

  /** Back to the pre-start state — Quit (§3.2) and every fresh title entry. */
  resetTitle() {
    this.started = false;
    this.showSettings(false);
    this.applyTitleButtons();
    this.music?.stop();       // PRESS START is the gesture that starts it again
    this.el.start.focus({ preventScroll: true });
  }

  showSettings(on) {
    if (on) this.settingsOpener = document.activeElement;
    this.el.settings.hidden = !on;
    // Over PAUSE the world is still rendered behind: use a scrim instead of the
    // title's opaque desert sheet, which would black the game out.
    this.el.settings.classList.toggle('over-pause', on && this.game.state === 'PAUSED');
    if (on) {
      this.el.settings.querySelector('input')?.focus();
    } else {
      // restore focus to whatever opened the panel, not to a destructive button.
      // The fallback follows the host screen — from PAUSE the title's button row
      // is display:none and focusing it would drop focus on the floor.
      const fallback = this.game.state === 'PAUSED'
        ? this.el.pause.querySelector('button')
        : (this.started ? this.el.menu.querySelector('button:not([hidden])') : this.el.start);
      const back = this.settingsOpener?.isConnected && !this.settingsOpener.hidden
        ? this.settingsOpener
        : fallback;
      back?.focus();
    }
  }

  /** Roving focus for the title row + settings panel (§3.2 "arrow/Tab + Enter"). */
  _onTitleKey(e) {
    if (!this.el.settings.hidden) return;      // the panel owns its own keys now
    this._roveOrTrap(e, this.el.menu);
  }

  _onSettingsKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.showSettings(false);
      return;
    }
    this._roveOrTrap(e, this.el.settings);
  }

  _roveOrTrap(e, scope) {
    const modal = scope === this.el.settings;
    if (modal && e.key === 'Tab') {
      // focus trap: the panel is modal and covers the screen — Tab must not
      // reach the buttons behind it (Enter there would start/delete a world).
      // 'select' belongs in this list: the theme-mode dropdown is neither a
      // button nor an input, and without it Tab escapes the modal.
      const f = [...scope.querySelectorAll('button, input, select')].filter(el => !el.hidden);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    // let arrows drive sliders and the theme dropdown natively
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    const btns = [...scope.querySelectorAll('button')].filter(b => !b.hidden);
    if (!btns.length) return;
    e.preventDefault();
    const i = btns.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown'
      ? (i + 1) % btns.length
      : (i <= 0 ? btns.length - 1 : i - 1);
    btns[next].focus();
  }

  /** Single place that derives title-button visibility from (started, hasSave). */
  applyTitleButtons() {
    this.el.start.hidden = this.started;
    this.el.menu.hidden = !this.started;
    this.el.stage.classList.toggle('cc-started', this.started);
    this.el.btnContinue.hidden = !this.hasSave;
    this.el.btnDelete.hidden = !this.hasSave;   // lives in the settings panel
  }

  setHasSave(has) {
    this.hasSave = has;           // intent only — visibility is derived, and this
    this.applyTitleButtons();     // is called at boot, long before PRESS START
  }

  show(name) {
    for (const key of ['title', 'loading', 'pause', 'death']) {
      this.el[key].classList.toggle('visible', key === name);
    }
    if (name === 'title') {
      // every title entry (boot, quit-to-title, failed world start) rearms
      // PRESS START; music restarts from that gesture (§4.5)
      this.resetTitle();
    } else {
      // §4A.3 menu → world: fade the menu track out ~1 s, then hand off — to the
      // in-game theme layer on musicMode 'full', else to the §4 composer.
      this.music?.stop();
      if (name === null && this.options.musicMode === 'full' && this.music?.available) {
        setTimeout(() => {
          if (this.game.state !== 'TITLE') this.music?.start({ context: 'game' });
        }, 1100);
      }
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
