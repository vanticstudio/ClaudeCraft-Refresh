// Entry point: build atlas, boot audio (create suspended context, bake buffers),
// construct Game + UI, title-screen wiring (01 §2, AMENDS 16 §1.1).
import './ui/style.css';
import './ui/title.css';
import { createThemeMusic } from './audio/themeMusic.js';
import { audio } from './audio/engine.js';
import { loadOptions, saveOptions } from './ui/options.js';
import { buildAtlas } from './assets/atlas.js';
import { finalizeBlockTiles } from './registry/blocks.js';
import { Game } from './Game.js';
import { createRenderer } from './render/renderer.js';
import { Input } from './player/input.js';
import { Hud } from './ui/hud.js';
import { BossBar } from './ui/BossBar.js';
import { Menus } from './ui/menus.js';
import { Containers } from './ui/containers.js';
import { DebugOverlay } from './ui/debug.js';
import { SaveManager } from './save/saveManager.js';
import { STATE, GameMode, KEYBINDS, setRenderRadius, RENDER_RADIUS } from './constants.js';
import { Chat } from './ui/chat.js';
import { NetMenus } from './ui/netMenus.js';
import { NetClient } from './net/NetClient.js';
import { NetContainer } from './ui/netContainer.js';
import { getLocalPlayerId } from './net/identity.js';

// 01 §2 — the startup failure surface. `boot()` was invoked bare with nothing
// awaiting or catching it, so a blacklisted WebGL context, a rejecting
// save.open() or a null 2d context out of buildAtlas() all produced a blank page
// with nothing on screen and nothing in the console. DOM only — no asset, no dep.
function fatal(err, phase) {
  console.error('[boot]', phase, err);
  document.body.dataset.fatal = '1';
  const host = document.getElementById('screens') || document.body;
  const box = document.createElement('div');
  box.className = 'fatal-screen';
  // Styled inline: a fatal may be a CSS/import failure, so this must not depend
  // on ui/style.css having loaded.
  box.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;gap:12px;padding:24px;background:#101014;' +
    'color:#e8e8ee;font:14px/1.5 monospace;text-align:center';
  const h = document.createElement('h1');
  h.textContent = 'ClaudeCraft could not start';
  h.style.cssText = 'font-size:22px;margin:0';
  const pre = document.createElement('pre');
  pre.textContent = String(err?.message ?? err);
  pre.style.cssText = 'max-width:min(90vw,720px);max-height:40vh;overflow:auto;white-space:pre-wrap;' +
    'margin:0;padding:10px;background:#000;border:1px solid #333;text-align:left';
  const btn = document.createElement('button');
  btn.textContent = 'Reload';
  btn.style.cssText = 'padding:8px 20px;font:inherit;cursor:pointer';
  btn.onclick = () => location.reload();
  box.append(h, pre, btn);
  host.appendChild(box);
}

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
  // UPDATE-polish §5 — apply the persisted render distance before any world
  // streams (setRenderRadius also derives GENERATE/UNLOAD from it).
  setRenderRadius(options.renderDistance ?? 8);
  audio.boot();
  audio.setOptions(options);

  const input = new Input(canvas);
  const { renderer, camera, viewmodelCamera } = createRenderer(canvas);
  const game = new Game({ canvas, input, renderer, camera, viewmodelCamera, atlas, audio, options });
  audio.game = game;

  const save = new SaveManager();
  save.hostId = getLocalPlayerId();     // v2→v3 migration wraps the legacy player under this
  await save.open();
  game.save = save;

  // ---------------- UI ----------------
  const hud = new Hud(game, overlayEl);
  const bossBar = new BossBar(overlayEl);   // 13-BOSSES §1 — mounts inside Hud's #boss-bars
  const debug = new DebugOverlay(game, overlayEl);
  if (options.debugOverlay) debug.toggle();          // §5 — persisted F3 state
  const containers = new Containers(game, screensEl);
  const chat = new Chat(game, overlayEl);
  const netContainer = new NetContainer(game, screensEl);   // 14 §6 — client chest UI
  // 01 §16 — SaveManager degrades to an unsaved session (db null) rather than
  // failing boot when storage is blocked; say so once instead of silently.
  if (save.unavailable) hud.toast('Storage unavailable — this session will not be saved');

  const startWorld = async (seed, meta) => {
    menus.show('loading');
    try {
      await game.startWorld(seed, meta);
    } catch (err) {
      console.error('world start failed', err);
      // disposeWorld is double-dispose safe (Game.js §17-SHIP 1.6) and terminates
      // the terrain workers; without it a failed start left two live Workers and
      // the whole chunk map pinned for the rest of the session.
      game.disposeWorld();
      hud.toast('Could not start that world');
      game.setState(STATE.TITLE);
    }
  };

  // 01 §16.2 / 14 §9 — quit-to-title is a MULTI-SECOND async teardown for a host
  // (the shutdown countdown below), so it needs re-entrancy state that outlives
  // one hook call. `quitting` locks out Resume and a second Quit for the whole
  // window; `quitForced` latches a failed write so the player is never trapped.
  let quitting = false, quitForced = false;

  const menus = new Menus(game, screensEl, {
    onOptions: opts => {
      audio.setOptions(opts);
      // §5 — live render-distance: update the radii and force the chunk manager
      // to rebuild its request list next tick (unloadPass trims within a second).
      const applied = setRenderRadius(opts.renderDistance ?? 8);
      if (game.chunkManager) game.chunkManager.lastPlayerChunk = null;
      // §5 — debug toggle from the sheet mirrors F3 exactly.
      if (!!opts.debugOverlay !== debug.visible) debug.toggle();
    },
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
      // A quit is already running: its host-shutdown wait leaves this sheet on
      // screen for 3.2 s, and resuming inside that window put the player back in
      // a world the parked onQuit then disposed out from under them.
      if (quitting) return;
      audio.unlock();                 // must land inside the gesture, before the await
      const ok = await input.requestLock();
      if (ok !== false) game.setState(STATE.PLAYING);
      else menus.el.pause.querySelector('#btn-resume').textContent = 'Click to resume';
    },
    onQuit: async () => {
      // Re-entry guard: both the pause sheet and the death screen bind here, and
      // the host branch below parks for 3.2 s with the buttons still clickable. A
      // second click would fire a second hostShutdown broadcast and a second
      // timer against an already-disposed world.
      if (quitting) return;
      quitting = true;
      const btnQuit = menus.el.pause.querySelector('#btn-quit');
      const quitLabel = btnQuit.textContent;
      try {
        // 01 §16.2 — saveAll resolves FALSE on an aborted/failed transaction. The
        // flags it restores on the dirty chunks are meaningless once disposeWorld
        // drops world.chunks, so ignoring the result silently discarded the whole
        // session. Test `=== false` specifically: the no-op cases (client / no db /
        // overlapping save) resolve undefined and must not block the quit.
        const ok = await save.saveAll(game);
        if (ok === false && !quitForced) {
          // A write failure is normally PERMANENT (quota exhausted, storage
          // evicted, connection closed by a versionchange), so an unconditional
          // `return` made the title screen — and therefore New World and Join —
          // unreachable for the rest of the page's life. The session data is
          // already lost; refusing to quit does not recover it. Latch instead.
          quitForced = true;
          hud.toast('Save failed — click Save & Quit again to leave without saving');
          return;
        }
        if (ok === false) hud.toast('Save failed — leaving without saving');
        // 14 §9 — a HOST must tear its session down here. hostShutdown() had ZERO
        // call sites: the relay socket stayed open (so no hostGone ever fired) and
        // Game.tick early-returns once world is null, so every client hung on a
        // frozen world forever with no countdown. Nulling game.net is what stops a
        // stale NetHost from ticking the NEXT world against a destroyed World.
        if (game.net?.isHost) {
          game.net.hostShutdown();
          // The sheet stays up through the countdown, so say what it is waiting
          // on and make the dead buttons look dead.
          btnQuit.textContent = 'Shutting down session…';
          btnQuit.disabled = true;
          await new Promise(r => setTimeout(r, 3200));
          await save.saveAll(game);          // catch anything the countdown ticked
        }
        game.net?.stop?.();
        game.net?.disconnect?.();
        game.net = null;
        game.disposeWorld();
        game.setState(STATE.TITLE);
        menus.setHasSave(save.hasWorld());
        quitForced = false;
      } finally {
        btnQuit.textContent = quitLabel;
        btnQuit.disabled = false;
        quitting = false;
      }
    },
    onRespawn: () => game.respawnPlayer(),
  });

  // Theme music (16-AUDIO §4A / 19-MAIN-MENU §4). E1 now owns the context and
  // the music bus, so the standalone fallback graph retires here.
  // `audio.ready` is false when AudioEngine.boot bailed (no Web Audio at all).
  // Passing `{ context: null, musicBus: undefined }` made ThemeMusic take the
  // owns-context path, and its unlock() then threw a TypeError out of an async
  // start() on the very first PRESS START. `{}` makes the intent explicit.
  const themeMusic = createThemeMusic(audio.ready ? { context: audio.ctx, musicBus: audio.buses.music } : {});
  audio.themeMusic = themeMusic;
  menus.attachMusic(themeMusic);
  menus.setHasSave(save.hasWorld());

  // 14-MULTIPLAYER — Host / Join flows.
  const netMenus = new NetMenus(game, screensEl, {
    onHost: async url => {
      // host the existing world if one exists (so per-player saves persist), else new.
      if (save.hasWorld()) await startWorld(save.meta.seed, save.meta);
      else { await save.deleteWorld(); await save.open(); await startWorld(String(Date.now() >>> 0), null); menus.setHasSave(true); }
      await game.startHosting(url);
    },
    onJoin: ({ url, code, name }) => {
      const client = new NetClient(game, { url, code, name });
      client.onError = reason => netMenus.onClientError(reason);
      game.net = client;
      client.connect();
    },
  });

  game.ui = {
    hud, bossBar, menus, containers, debug, chat, netMenus, netContainer,
    playerList: chat,
    toast: msg => hud.toast(msg),
    setSleepFade: on => hud.setSleepFade(on),
    setLoadingProgress: (m, n) => menus.setLoadingProgress(m, n),
    onStateChange: (next, prev) => {
      if (next === STATE.TITLE) { menus.show('title'); netMenus.hideAll(); }
      else if (next === STATE.LOADING) menus.show('loading');
      else if (next === STATE.CONNECTING) { menus.show(null); }   // netMenus owns the connecting screen
      else if (next === STATE.PAUSED) menus.show('pause');
      else if (next === STATE.DEAD) menus.show('death');
      else { menus.show(null); netMenus.hideAll(); }
      if (next === STATE.PLAYING && prev === STATE.CONNECTING) netMenus.hideAll();
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
    // 14 §8.3 — chat is open: swallow game keys (the input handles Enter/Escape).
    if (chat.open) return;
    if (code === 'F3') {
      debug.toggle();
      // §5 — F3 stays a shortcut; mirror its state into the persisted option so
      // the settings checkbox and the key never diverge.
      options.debugOverlay = debug.visible;
      saveOptions(options);
    } else if ((code === KEYBINDS.chat || code === 'Enter' || code === 'NumpadEnter') && game.net && game.state === STATE.PLAYING) {
      // 14 §8.3 — T (or Enter) opens chat; pointer lock is kept.
      chat.openInput();
    } else if (code === KEYBINDS.playerList && game.net && (game.state === STATE.PLAYING || game.state === STATE.PLAYING_UI)) {
      chat.showList(true);
    } else if (code === 'KeyE') {
      // 18 §6 — E opens the creative palette while creative, the survival
      // inventory otherwise. Both are PLAYING_UI screens (AMENDS 01 §15.3).
      if (game.state === STATE.PLAYING) {
        game.openContainer(game.player?.creative ? 'creative' : 'inventory');
      } else if (game.state === STATE.PLAYING_UI) containers.close();
    } else if (code === 'Escape') {
      if (netContainer.isOpen()) netContainer.close();
      else if (game.state === STATE.PLAYING_UI) containers.close();
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

  // 14 §8.2 — release Tab hides the player list.
  document.addEventListener('keyup', e => {
    if (e.code === KEYBINDS.playerList) chat.showList(false);
  });

  // pointer-lock loss while PLAYING ⇒ pause (01 §15.2). Chat keeps pointer lock,
  // so a lock loss while chat is open must NOT pause (14 §8.3).
  input.onLockChange = locked => {
    if (!locked && game.state === STATE.PLAYING && !game.sleeping && !chat.open) {
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
    if (!document.hidden) return;
    // 01 §15.2/§16.2 — "visibilitychange → hidden" is an UNCONDITIONAL save
    // trigger. setState covers the PLAYING case (its PLAYING→PAUSED edge saves);
    // every OTHER live state — PLAYING_UI with a chest open, DEAD, CONNECTING, a
    // host ticking while PAUSED — saved nothing at all, and rAF stops in a hidden
    // tab so the 600-tick autosave could not fire later either. saveAll already
    // early-returns for clients and for a missing db/world.
    if (game.state === STATE.PLAYING) game.setState(STATE.PAUSED);
    else if (game.world) save.saveAll(game);
  });
  window.addEventListener('pagehide', () => {
    if (game.world) save.saveAll(game);
  });

  // 01 §1 — three reinstalls its own GL state on webglcontextrestored, so the app
  // survives a GPU switch or GPU-process crash — but nothing here reacted, so
  // Game.frame kept running the FULL simulation against a frozen picture for 1–5
  // seconds: mobs attack, hunger drains, fall damage lands, the player can die
  // without ever seeing it. Pause instead; the Resume button already handles the
  // way back, so no new state is involved.
  canvas.addEventListener('webglcontextlost', () => {
    if (game.state === STATE.PLAYING || game.state === STATE.PLAYING_UI) game.setState(STATE.PAUSED);
    hud.toast('Graphics context lost — reconnecting');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    // The atlas is PAINTED, not loaded, so force one re-upload — atlas.animate()
    // only repaints on a 5-tick boundary and the GPU copy can otherwise stay
    // stale — and make the streamer re-evaluate its request list.
    atlas.texture.needsUpdate = true;
    if (game.chunkManager) game.chunkManager.lastPlayerChunk = null;
    hud.toast('Graphics context restored');
  });

  game.setState(STATE.TITLE);
  game.start();
}

// These two are ERROR paths, not the console spam the house rules forbid: without
// them a rejected promise anywhere in the UI or net layer is completely silent.
window.addEventListener('unhandledrejection', e => console.error('[unhandled]', e.reason));
window.addEventListener('error', e => console.error('[error]', e.error ?? e.message));

boot().catch(err => fatal(err, 'boot'));
