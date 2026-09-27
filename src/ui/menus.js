// Title / loading / pause / death screens + Options sheet (01 §15.3).
// Title screen = the desert/badlands sunset scene from 19-MAIN-MENU §3.
import { loadOptions, saveOptions } from './options.js';
import { emitSound, audio } from '../audio/engine.js';
import { exportWorld, importWorld } from '../world/exportWorld.js';
import { setupPWA, promptInstall } from '../pwa.js';

// B11 — PWA registration runs from HERE (module scope of menus.js, imported by
// main.js at boot): main.js is off-limits in the platform wave's file contract,
// and menus.js is the natural owner of the install hint anyway. One guard so
// multiple Menus instances never double-register.
let PWA_SET_UP = false;

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
          <div class="cc-credit">Made by Vantic</div>

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
            <!-- B11 — platform row: world export/import + the quiet PWA install
                 hint. Text buttons: the art pack has no Export/Install plates. -->
            <div class="cc-platform-row">
              <button class="cc-btn-text" id="btn-export" title="Download this world as a .ccworld file" hidden>Export world</button>
              <button class="cc-btn-text" id="btn-import" title="Install a .ccworld file as a new world">Import world&hellip;</button>
              <button class="cc-btn-text" id="cc-install" title="Install ClaudeCraft as an app" hidden>Install app</button>
            </div>
            <!-- one-line status channel (B11): import results, offline
                 multiplayer notice — there is no toast surface on the title
                 screen, so this stands in -->
            <div id="cc-status" class="cc-status" role="status" aria-live="polite"></div>
            <input type="file" id="cc-import-file" accept=".ccworld" hidden>
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
        <div style="opacity:0.6;font-size:14px">Sprint: double-tap W · Drop stack: Shift+Q · Debug: F3 · Game mode: F4<span id="cc-touch-hint"></span></div>
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
        <div class="cc-panel" role="dialog" aria-modal="true" aria-label="Settings" tabindex="-1">
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
          <!-- UPDATE-polish §5 — game controls: render distance / debug / creative -->
          <label class="cc-row">
            <span>Render distance</span>
            <input type="range" min="4" max="20" step="1" id="opt-renderDistance">
            <output id="out-renderDistance"></output>
          </label>
          <!-- OVERHAUL §O — graphics rows -->
          <label class="cc-row">
            <span>FOV</span>
            <input type="range" min="60" max="110" step="1" id="opt-fov">
            <output id="out-fov"></output>
          </label>
          <label class="cc-row">
            <span>Resolution scale</span>
            <input type="range" min="50" max="200" step="5" id="opt-resolutionScale">
            <output id="out-resolutionScale"></output>
          </label>
          <label class="cc-row">
            <span>Brightness</span>
            <input type="range" min="0" max="100" step="1" id="opt-brightness">
            <output id="out-brightness"></output>
          </label>
          <label class="cc-row">
            <span>Smooth textures (mipmaps)</span>
            <input type="checkbox" id="opt-mipmaps">
            <output></output>
          </label>
          <!-- B3 §4 — screen shake (DEFAULT OFF, accessibility: forced camera
               motion is a vestibular trigger). Persisted via the shared
               loadOptions/saveOptions object like every other row. -->
          <label class="cc-row">
            <span>Screen shake</span>
            <input type="checkbox" id="opt-screenShake">
            <output></output>
          </label>
          <label class="cc-row">
            <span>Particles</span>
            <select id="opt-particles">
              <option value="all">All</option>
              <option value="decreased">Decreased</option>
              <option value="minimal">Minimal</option>
            </select>
            <output></output>
          </label>
          <label class="cc-row">
            <span>Debug overlay</span>
            <input type="checkbox" id="opt-debugOverlay">
            <output></output>
          </label>
          <label class="cc-row" id="row-creative">
            <span>Creative mode</span>
            <input type="checkbox" id="opt-creative">
            <output></output>
          </label>
          <div class="cc-note">Menu music plays original/cleared tracks only.
            In-game audio is fully synthesized.</div>
          <div class="cc-note cc-credit-note">Made by Vantic.</div>
          <!-- text buttons: the art pack has no Back/Delete plates, and
               reusing CONTINUE/QUIT art here would mislabel the action -->
          <div class="cc-actions">
            <button class="cc-textbtn" id="btn-settings-back">&#9664; Back</button>
            <button class="cc-textbtn danger" id="btn-delete" hidden>Delete World</button>
          </div>
        </div>
      </div>`);
    // AMENDS 06 §15.4 — the F4 debug item palette (#debug-palette) is retired.
    // 18 §6's creative inventory replaces it wholesale: tabs, search, a destroy
    // slot and the real player slots, in containers.js.

    const $ = id => document.getElementById(id);
    this.el = {
      title: $('screen-title'), loading: $('screen-loading'),
      pause: $('screen-pause'), death: $('screen-death'),
      bar: $('loading-bar'), label: $('loading-label'),
      score: $('death-score'), seed: $('seed-input'),
      btnContinue: $('btn-continue'), btnDelete: $('btn-delete'),
      logo: $('cc-logo'), wordmark: $('cc-wordmark'),
      start: $('cc-start'), menu: $('cc-menu'), settings: $('cc-settings'),
      stage: document.querySelector('#screen-title .cc-title'),
      // B11 — platform row + status channel
      btnExport: $('btn-export'), btnImport: $('btn-import'),
      install: $('cc-install'), status: $('cc-status'),
      importFile: $('cc-import-file'),
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
        // 17-SHIP §1.6 — five of these hooks are async and their promises were
        // discarded, so a rejecting save.deleteWorld() made New Game silently
        // dead with nothing in the console. main.js's global unhandledrejection
        // catches it now; this adds the per-button context.
        const r = fn(e);
        if (r && typeof r.catch === 'function') r.catch(err => console.error('[ui]', id, err));
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
    // B11 — export/import + install hint
    btn('btn-export', () => this.exportWorldFile());
    btn('btn-import', () => this.el.importFile.click());
    btn('cc-install', async () => {
      await promptInstall();
      // accepted → appinstalled hides it anyway; dismissed → hide now (quiet
      // UX: never nag twice for the same criteria window)
      this.setInstallHint(false);
    });
    this.el.importFile.addEventListener('change', () => {
      const file = this.el.importFile.files?.[0];
      this.el.importFile.value = '';   // re-selecting the same file must re-fire
      this.importWorldFile(file);
    });
    // scoped to the title screen, so it cannot swallow keys during play
    this.el.title.addEventListener('keydown', e => this._onTitleKey(e));
    // The panel is no longer inside #screen-title, so Escape and the focus trap
    // need their own binding — otherwise both die the moment PAUSE hosts it.
    // Bound on `document`, gated on visibility: an element listener only fires
    // while focus is INSIDE the sheet, and one mousedown on dead space (the <h2>,
    // the .cc-note) drops focus to body — killing Escape and letting Tab walk to
    // #btn-new behind the opaque backdrop. No document-level Escape covers the
    // panel (main.js's onKeyEdge handles only PLAYING_UI / netContainer).
    document.addEventListener('keydown', e => {
      if (!this.el.settings.hidden) this._onSettingsKey(e);
    });

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

    // UPDATE-polish §5 — render distance: persists in options; main.js's
    // onOptions hook applies setRenderRadius live (chunks stream in/out).
    const rd = $('opt-renderDistance'), rdOut = $('out-renderDistance');
    rd.value = this.options.renderDistance ?? 8;
    rdOut.textContent = rd.value;
    rd.addEventListener('input', () => {
      this.options.renderDistance = Number(rd.value);
      rdOut.textContent = rd.value;
      this.applyOptions();
    });

    // OVERHAUL §O — graphics rows: fov / resolutionScale / brightness sliders,
    // mipmaps + particles. All persist via the shared options object; main.js's
    // onOptions hook applies them live (fov + brightness also read per frame).
    const bindSlider = (id, outId, fmt, get, set) => {
      const el = $(id), out = $(outId);
      el.value = get();
      out.textContent = fmt(Number(el.value));
      el.addEventListener('input', () => {
        set(Number(el.value));
        out.textContent = fmt(Number(el.value));
        this.applyOptions();
      });
    };
    bindSlider('opt-fov', 'out-fov', v => String(v),
      () => this.options.fov ?? 70, v => { this.options.fov = v; });
    bindSlider('opt-resolutionScale', 'out-resolutionScale',
      v => (v / 100).toFixed(2) + '×',
      () => Math.round((this.options.resolutionScale ?? 1) * 100),
      v => { this.options.resolutionScale = v / 100; });
    bindSlider('opt-brightness', 'out-brightness', v => String(v),
      () => this.options.brightness ?? 0, v => { this.options.brightness = v; });

    const mip = $('opt-mipmaps');
    mip.checked = this.options.mipmaps !== false;
    mip.addEventListener('change', () => {
      this.options.mipmaps = mip.checked;
      this.applyOptions();
    });

    // B3 §4 — screen shake checkbox, the mipmaps row's pattern: read the shared
    // options object, persist via applyOptions (DayNight re-reads
    // game.options.screenShake per frame, so the toggle applies live mid-world).
    const shake = $('opt-screenShake');
    shake.checked = this.options.screenShake === true;
    shake.addEventListener('change', () => {
      this.options.screenShake = shake.checked;
      this.applyOptions();
    });

    const part = $('opt-particles');
    part.value = this.options.particles ?? 'all';
    part.addEventListener('change', () => {
      this.options.particles = part.value;
      this.applyOptions();
    });

    // §5 — debug overlay: same state as F3 (main.js keeps key + option in sync).
    const dbg = $('opt-debugOverlay');
    dbg.checked = this.options.debugOverlay === true;
    dbg.addEventListener('change', () => {
      this.options.debugOverlay = dbg.checked;
      this.applyOptions();
    });

    // §5 — creative mode: same action as F4, driving the LIVE player via
    // pendingGameMode (applied inside Player.tick per 18 §1.4's atomicity).
    // Persistence rides the per-world save (gameMode), NOT options — a global
    // override would stomp every world's own mode. Refreshed on sheet open;
    // disabled on the title screen where no player exists.
    const cr = $('opt-creative');
    cr.addEventListener('change', () => {
      const pl = this.game.player;
      if (!pl) return;
      pl.pendingGameMode = cr.checked ? 1 : 0;   // GameMode.CREATIVE : SURVIVAL
    });

    this.applyTitleButtons();

    // B11 — PWA: register the SW + capture the install prompt (module-owned
    // here, not main.js — see the header note). The hint only ever shows when
    // the browser says it can install.
    if (!PWA_SET_UP) {
      PWA_SET_UP = true;
      setupPWA({
        onInstallAvailable: () => this.setInstallHint(true),
        onInstalled: () => this.setInstallHint(false),
      });
    }

    // B11 — offline guard for multiplayer: the Host/Join buttons are injected
    // by NetMenus AFTER this constructor runs, so the guard is a capture-phase
    // listener on the menu itself, matching the injected labels. stopPropagation
    // in capture phase prevents the button's own onclick from firing.
    this.el.menu.addEventListener('click', e => {
      if (navigator.onLine) return;
      const label = (e.target?.closest?.('button')?.textContent ?? '').trim();
      if (/multiplayer/i.test(label)) {
        e.stopPropagation();
        e.preventDefault();
        this.setStatus('Multiplayer needs a connection');
      }
    }, true);

    // B11 — touch-friendly hint on the pause sheet (coarse pointers only)
    if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) {
      const hint = document.getElementById('cc-touch-hint');
      if (hint) hint.textContent = ' · Touch: left stick moves, right side looks/mine, buttons right';
    }
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
    // §5 — sync the game-control rows to live state on every open: F3/F4 may
    // have flipped them since, and creative is meaningless without a player.
    if (on) {
      const pl = this.game.player;
      const cr = document.getElementById('opt-creative');
      const dbg = document.getElementById('opt-debugOverlay');
      if (cr) {
        cr.disabled = !pl;
        cr.checked = !!pl && (pl.pendingGameMode ?? pl.gameMode) === 1;
        document.getElementById('row-creative')?.classList.toggle('disabled', !pl);
      }
      if (dbg) dbg.checked = this.options.debugOverlay === true;
    }
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
      // Membership, not first/last identity: a click on the panel's dead space
      // (the <h2>, the .cc-note) parks focus on body or on the panel div itself,
      // and neither comparison matched — Tab then walked straight to #btn-new
      // behind the opaque backdrop. Anything off the list re-enters the trap.
      const i = f.indexOf(document.activeElement);
      if (i < 0) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
      if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && i === 0) { e.preventDefault(); last.focus(); }
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
    this.el.btnExport.hidden = !this.hasSave;   // B11 — nothing to export without a world
  }

  // -------- B11: status line + platform actions --------
  /** The title screen's one-line status channel (no toast surface exists here). */
  setStatus(msg, ms = 3200) {
    if (!this.el.status) return;
    this.el.status.textContent = msg;
    clearTimeout(this._statusTimer);
    if (ms > 0) this._statusTimer = setTimeout(() => { this.el.status.textContent = ''; }, ms);
  }

  setInstallHint(on) {
    this.el.install.hidden = !on;
  }

  /** Download the current world as a .ccworld blob (Export button). */
  async exportWorldFile() {
    const save = this.game.save;
    if (!save?.hasWorld()) { this.setStatus('Nothing to export yet'); return; }
    try {
      const buf = await exportWorld(save);
      const slug = String(save.meta.seed || 'world').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 24) || 'world';
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `claudecraft-${slug}.ccworld`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      this.setStatus('World exported');
    } catch (err) {
      this.setStatus('Export failed: ' + (err?.message ?? err));
    }
  }

  /** Install a .ccworld file as a NEW world (Import button → file input). */
  async importWorldFile(file) {
    if (!file) return;
    try {
      // The layout is one save slot per browser: an import overwrites it —
      // ask before destroying an existing world (exporting first is the escape hatch).
      if (this.game.save?.hasWorld() && !confirm('Importing replaces the current world. Continue?')) return;
      const buf = await file.arrayBuffer();
      const meta = await importWorld(this.game.save, buf);
      // refresh the title's world "list" — a single-slot UI, so the render
      // function is applyTitleButtons via setHasSave (Continue appears)
      this.setHasSave(true);
      this.setStatus(`Imported "${meta.seed}" — press Continue to play`);
    } catch (err) {
      this.setStatus('Import failed: ' + (err?.message ?? err));
    }
  }

  setHasSave(has) {
    this.hasSave = has;           // intent only — visibility is derived, and this
    this.applyTitleButtons();     // is called at boot, long before PRESS START
  }

  show(name) {
    const prev = this._shown;
    this._shown = name;
    for (const key of ['title', 'loading', 'pause', 'death']) {
      this.el[key].classList.toggle('visible', key === name);
    }
    if (name === 'title') {
      // every title entry (boot, quit-to-title, failed world start) rearms
      // PRESS START; music restarts from that gesture (§4.5)
      this.resetTitle();
    } else if (prev === undefined || prev === 'title' || prev === 'loading') {
      // §4A.3 menu → world: fade the menu track out ~1 s, then hand off — to the
      // in-game theme layer on musicMode 'full', else to the §4 composer.
      // Gated on the MENU→WORLD transition, not on every non-title show(): main.js
      // funnels PLAYING_UI, the PAUSED→PLAYING resume and CONNECTING through here
      // too, so opening a chest used to stop() + restart(), reshuffling the
      // playlist and bypassing §4A.2's 180–420 s in-game gap and no-repeat rule.
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

}
