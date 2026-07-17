// Entry point: build atlas, construct Game + UI, title-screen wiring (01 §2).
import './ui/style.css';
import './ui/title.css';
import { createThemeMusic } from './audio/themeMusic.js';
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
import { STATE } from './constants.js';

async function boot() {
  const canvas = document.getElementById('game-canvas');
  const overlayEl = document.getElementById('overlay');
  const screensEl = document.getElementById('screens');

  // atlas + registry tile resolution (phase 2)
  const atlas = buildAtlas();
  finalizeBlockTiles(atlas.TILE);
  document.documentElement.style.setProperty('--atlas-url', `url(${atlas.atlasDataURL})`);

  const input = new Input(canvas);
  const { renderer, camera, viewmodelCamera } = createRenderer(canvas);
  const game = new Game({ canvas, input, renderer, camera, viewmodelCamera, atlas });

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

  // Theme music (16-AUDIO §4A / 19-MAIN-MENU §4). Standalone context + gain
  // chain until 16-AUDIO E1 lands — then pass E1's { context, musicBus } here.
  const themeMusic = createThemeMusic();
  menus.attachMusic(themeMusic);
  menus.setHasSave(save.hasWorld());

  game.ui = {
    hud, menus, containers, debug,
    toast: msg => hud.toast(msg),
    setSleepFade: on => hud.setSleepFade(on),
    setLoadingProgress: (m, n) => menus.setLoadingProgress(m, n),
    onStateChange: next => {
      if (next === STATE.TITLE) menus.show('title');
      else if (next === STATE.LOADING) menus.show('loading');
      else if (next === STATE.PAUSED) menus.show('pause');
      else if (next === STATE.DEAD) menus.show('death');
      else menus.show(null);
      if (next !== STATE.PLAYING_UI && containers.isOpen()) containers.close(true);
      menus.setPaletteVisible(next === STATE.PLAYING_UI &&
        game.player?.gameMode === 'debugCreative');
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
    } else if (code === 'F4' && game.player) {
      const p = game.player;
      p.gameMode = p.gameMode === 'survival' ? 'debugCreative' : 'survival';
      if (p.gameMode === 'survival') p.flying = false;
      hud.toast(p.gameMode === 'debugCreative' ? 'Debug creative ON (double-Space to fly)' : 'Survival mode');
      menus.setPaletteVisible(game.state === STATE.PLAYING_UI && p.gameMode === 'debugCreative');
    } else if (code === 'KeyE') {
      if (game.state === STATE.PLAYING) game.openContainer('inventory');
      else if (game.state === STATE.PLAYING_UI) containers.close();
    } else if (code === 'Escape') {
      if (game.state === STATE.PLAYING_UI) containers.close();
    }
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
