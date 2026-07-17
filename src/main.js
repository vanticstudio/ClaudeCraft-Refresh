// Entry point: build atlas, boot audio (create suspended context, bake buffers),
// construct Game + UI, title-screen wiring (01 §2, AMENDS 16 §1.1).
import './ui/style.css';
import './ui/title.css';
import { createThemeMusic } from './audio/themeMusic.js';
import { audio } from './audio/engine.js';
import { loadOptions } from './ui/options.js';
import { buildAtlas } from './assets/atlas.js';
import { finalizeBlockTiles } from './registry/blocks.js';
import { Game } from './Game.js';
import { createRenderer } from './render/renderer.js';
import { Input } from './player/input.js';
import { Hud } from './ui/hud.js';
import { Menus } from './ui/menus.js';
import { Containers } from './ui/containers.js';
import { DebugOverlay } from './ui/debug.js';
import { SaveManager } from './save/saveManager.js';
import { STATE, GameMode } from './constants.js';

async function boot() {
  const canvas = document.getElementById('game-canvas');
  const overlayEl = document.getElementById('overlay');
  const screensEl = document.getElementById('screens');

  // atlas + registry tile resolution (phase 2)
  const atlas = buildAtlas();
  finalizeBlockTiles(atlas.TILE);
  document.documentElement.style.setProperty('--atlas-url', `url(${atlas.atlasDataURL})`);

  // Audio boot (16 §1.1): suspended context + buffer bake, before Game so the
  // engine can be constructor-injected. One options object is loaded here and
  // shared with Menus — two copies would diverge on every slider drag.
  const options = loadOptions();
  audio.boot();
  audio.setOptions(options);

  const input = new Input(canvas);
  const { renderer, camera, viewmodelCamera } = createRenderer(canvas);
  const game = new Game({ canvas, input, renderer, camera, viewmodelCamera, atlas, audio, options });
  audio.game = game;

  const save = new SaveManager();
  await save.open();
  game.save = save;

  // ---------------- UI ----------------
  const hud = new Hud(game, overlayEl);
  const debug = new DebugOverlay(game, overlayEl);
  const containers = new Containers(game, screensEl);

  const startWorld = async (seed, meta) => {
    menus.show('loading');
    try {
      await game.startWorld(seed, meta);
    } catch (err) {
      console.error('world start failed', err);
      game.setState(STATE.TITLE);
    }
  };

  const menus = new Menus(game, screensEl, {
    onOptions: opts => audio.setOptions(opts),
    onNewWorld: async seedInput => {
      await save.deleteWorld();
      await save.open();
      const seed = seedInput || String(Date.now() >>> 0);
      await startWorld(seed, null);
    },
    onContinue: async () => {
      const meta = save.meta;
      if (meta) await startWorld(meta.seed, meta);
    },
    onDelete: async () => {
      await save.deleteWorld();
      await save.open();
      menus.setHasSave(false);
    },
    onResume: async () => {
      audio.unlock();                 // must land inside the gesture, before the await
      const ok = await input.requestLock();
      if (ok !== false) game.setState(STATE.PLAYING);
      else menus.el.pause.querySelector('#btn-resume').textContent = 'Click to resume';
    },
    onQuit: async () => {
      await save.saveAll(game);
      game.disposeWorld();
      game.setState(STATE.TITLE);
      menus.setHasSave(save.hasWorld());
    },
    onRespawn: () => game.respawnPlayer(),
  });

  // Theme music (16-AUDIO §4A / 19-MAIN-MENU §4). E1 now owns the context and
  // the music bus, so the standalone fallback graph retires here.
  const themeMusic = createThemeMusic({ context: audio.ctx, musicBus: audio.buses.music });
  audio.themeMusic = themeMusic;
  menus.attachMusic(themeMusic);
  menus.setHasSave(save.hasWorld());

  game.ui = {
    hud, menus, containers, debug,
    toast: msg => hud.toast(msg),
    setSleepFade: on => hud.setSleepFade(on),
    setLoadingProgress: (m, n) => menus.setLoadingProgress(m, n),
    onStateChange: (next, prev) => {
      if (next === STATE.TITLE) menus.show('title');
      else if (next === STATE.LOADING) menus.show('loading');
      else if (next === STATE.PAUSED) menus.show('pause');
      else if (next === STATE.DEAD) menus.show('death');
      else menus.show(null);
      // AMENDS 01 §15.2. The single funnel for every transition — covers the
      // Resume button, LOADING→PLAYING, respawn, and container close alike.
      // PLAYING_UI must NOT pause: opening a chest is not leaving the world.
      // Resume on ANY exit from PAUSED, not just PAUSED→PLAYING: Save & Quit
      // goes PAUSED→TITLE, which would otherwise leave masterGain ramped to 0
      // and the context suspended — silence for the rest of the session.
      if (next === STATE.PAUSED) audio.onPause();
      else if (prev === STATE.PAUSED) audio.onResume();
      if (next !== STATE.PLAYING_UI && containers.isOpen()) containers.close(true);
    },
    // 18 §1.4 — the toggle's UI half. hud.rebuild() is driven from Game.
    onGameModeChanged: mode => {
      hud.toast(mode === GameMode.CREATIVE
        ? 'Creative mode (double-tap Space to fly)' : 'Survival mode');
      // The open screen belongs to the mode that opened it: E in creative shows
      // the palette, in survival the inventory. Switching with one open would
      // otherwise leave the wrong screen up, still wired to the old semantics.
      if (containers.isOpen()) containers.close();
    },
  };

  // container flow: interaction → Game.openContainer → containers.open → hooks
  game.onContainerOpened = () => {
    document.exitPointerLock?.();
    game.setState(STATE.PLAYING_UI);
  };
  game.onContainerClosed = () => {
    if (game.state === STATE.PLAYING_UI) {
      game.setState(STATE.PLAYING);
      input.requestLock();
    }
  };
  game.closeContainerScreen = () => containers.close();

  // ---------------- global keys ----------------
  input.onKeyEdge = code => {
    if (code === 'F3') {
      debug.toggle();
    } else if (code === 'KeyE') {
      // 18 §6 — E opens the creative palette while creative, the survival
      // inventory otherwise. Both are PLAYING_UI screens (AMENDS 01 §15.3).
      if (game.state === STATE.PLAYING) {
        game.openContainer(game.player?.creative ? 'creative' : 'inventory');
      } else if (game.state === STATE.PLAYING_UI) containers.close();
    } else if (code === 'Escape') {
      if (game.state === STATE.PLAYING_UI) containers.close();
    }
    // F4 is deliberately NOT handled here: 18 §1.4 requires the switch to land
    // inside player.tick(), before the movement branch, so the new mode's
    // physics take effect the same tick. Player.tick() reads the F4 down-edge
    // off the input snapshot instead.
  };

  // PRESS START via keyboard (19-MAIN-MENU §3.2). Guarded to TITLE: this is a
  // document listener and would otherwise eat Space while playing.
  document.addEventListener('keydown', e => {
    if (game.state !== STATE.TITLE || e.repeat) return;
    if (e.code !== 'Enter' && e.code !== 'NumpadEnter' && e.code !== 'Space') return;
    if (menus.started) return;   // once started, keys belong to the buttons
    e.preventDefault();
    menus.pressStart();
  });

  // pointer-lock loss while PLAYING ⇒ pause (01 §15.2)
  input.onLockChange = locked => {
    if (!locked && game.state === STATE.PLAYING && !game.sleeping) {
      game.setState(STATE.PAUSED);
    }
  };

  // click on canvas resumes lock when playing without lock (e.g. after UI close race)
  canvas.addEventListener('click', () => {
    audio.unlock();                 // AMENDS 01 §15.2: unconditional, above the guard
    if (game.state === STATE.PLAYING && !input.locked) input.requestLock();
  });

  // background/close saves (01 §16.2)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.state === STATE.PLAYING) {
      game.setState(STATE.PAUSED);
    }
  });
  window.addEventListener('pagehide', () => {
    if (game.world) save.saveAll(game);
  });

  game.setState(STATE.TITLE);
  game.start();
}

boot();
