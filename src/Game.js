// Game: fixed-timestep loop, system wiring, screen state machine (01 §3, §15).
import * as THREE from 'three';
import {
  MS_PER_TICK, MAX_TICKS_PER_FRAME, STATE, AUTOSAVE_INTERVAL, chunkKey, SIM_RADIUS,
} from './constants.js';
import { BLOCKS, B, blockByName, FACING_DIR, WATERLOGGED } from './registry/blocks.js';
import { ITEMS, idOf, SMELTING, fuelValue } from './registry/items.js';
import { cloneStack, packContainer } from './items/tags.js';
import { rollChestLoot } from './world/gen/endLoot.js';
import { explosionKnockbackScale } from './items/effects.js';   // 08 — blast-protection KB scale
import { World } from './world/World.js';
import { ChunkManager } from './world/ChunkManager.js';
import { ChunkState } from './world/Chunk.js';
import { createChunkMaterials } from './mesh/materials.js';
import { EntityManager } from './entities/EntityManager.js';
import { Player } from './entities/Player.js';
import {
  ItemEntity, initEntityVisuals, blockCubeGeometry, tileSpriteGeometry,
  makeAtlasMaterial, itemTileFor,
} from './entities/ItemEntity.js';
import { FallingBlock } from './entities/FallingBlock.js';
import { XpOrb } from './entities/XpOrb.js';
import { EndCrystal } from './entities/EndCrystal.js';   // 13-BOSSES §3
import { EndFight } from './entities/EnderDragon.js';    // 13-BOSSES §7
import { pyramidLevels, skyClear, applyBeaconEffects } from './world/Beacon.js';   // 13-BOSSES §9
import { PrimedTnt } from './entities/PrimedTnt.js';
import { ThrownProjectile } from './entities/ThrownProjectile.js';
import { Arrow } from './entities/Arrow.js';
import { ThrownPotion } from './entities/ThrownPotion.js';
import { AreaEffectCloud, spawnEffectCloud } from './entities/AreaEffectCloud.js';
import { LivingEntity, lerp, lerpAngle } from './entities/Entity.js';
import { Interaction } from './player/interaction.js';
import { placeTree } from './world/gen/features.js';
import { hasLineOfSight } from './world/raycast.js';
import { DayNight } from './env/DayNight.js';
import { Particles } from './render/Particles.js';
import { isGlinted, addGlintPass, tickGlint } from './render/glint.js';
import { AABB } from './math/aabb.js';
import { createMob, MobSpawner, HOSTILE_TYPES } from './entities/mobs/index.js';
import { emitSound, startLoop, at } from './audio/engine.js';
import { forgetFireInChunk } from './world/fire.js';
import { RedstoneEngine } from './redstone/RedstoneEngine.js';
import { RedstoneComponents, installComponentHooks } from './redstone/components.js';
import { installBossHooks } from './world/bossHooks.js';   // 13-BOSSES
import { RedstoneContainers } from './redstone/containersRedstone.js';
import { getDimension } from './world/dimensions.js';
import { findOrCreatePortal } from './world/Portal.js';
import { buildObsidianPlatform, END_SPAWN } from './world/endArena.js';
import { installNetherBehaviors, tickSpawner } from './world/nether.js';
import { tickBrewing } from './world/brewing.js';
import { addEffect as engineAddEffect, applyInstant as engineApplyInstant, applyEffectsData, serializeEffects } from './status/effects.js';
// 14-MULTIPLAYER — host/client sessions + shared player identity.
import { getLocalPlayerId, getLocalPlayerName, hueFromId } from './net/identity.js';
import { RemotePlayer } from './entities/RemotePlayer.js';
import { hostileCap } from './constants.js';
import { ETYPE, ETYPE_REV, indexToFace } from './net/protocol.js';
import { currentXp } from './items/xp.js';

const NEUTRAL_FRAME = {
  forward: 0, strafe: 0, jump: false, sneak: false, sprintKey: false,
  mouseLeft: false, mouseRight: false, leftPressed: false, rightPressed: false,
  middlePressed: false, pressed: new Set(), wheel: 0, hotbar: -1, shift: false,
  ctrl: false,
};

export class Game {
  constructor({ canvas, input, renderer, camera, viewmodelCamera, atlas, ui, audio, options }) {
    this.canvas = canvas;
    this.input = input;
    this.renderer = renderer;
    this.camera = camera;
    this.viewmodelCamera = viewmodelCamera;
    this.atlas = atlas;                 // { canvas, texture, TILE, tileUV, animate, atlasDataURL }
    this.ui = ui;                       // wired by main.js after UI construction
    this.audio = audio;                 // 16 §1; null-safe everywhere (?.)
    this.options = options;             // shared with Menus — one object, one source

    this.scene = new THREE.Scene();
    this.viewmodelScene = new THREE.Scene();
    this.viewmodelScene.add(new THREE.AmbientLight(0xffffff, 1.0));

    this.materials = createChunkMaterials(atlas.texture);
    initEntityVisuals(atlas);

    this.state = STATE.TITLE;
    this.accumulator = 0;
    this.lastTime = performance.now();
    this.tickCount = 0;
    this.slowTicks = 0;

    this.world = null;
    this.chunkManager = null;
    this.entities = null;
    this.player = null;
    this.interaction = null;
    this.dayNight = null;
    this.mobSpawner = null;
    this.save = null;                   // saveManager, wired by main.js
    this.particles = null;
    this.sleeping = null;               // { ticks }
    this.debug = { fps: 0, frameMs: 0, remeshCount: 0, lastRemeshes: 0, audioMs: 0, redstoneMs: 0 };
    this._fpsWindow = [];

    // 14-MULTIPLAYER — session + identity. net is a NetHost, NetClient, or null (solo).
    this.net = null;
    this.players = [];                  // all player entities (host: local + remotes; client: [local])
    this.localPlayerId = getLocalPlayerId();
    this.localPlayerName = getLocalPlayerName() || 'Player';
    this._savedPlayers = null;          // meta.players awaiting rejoin restore (host)
    this._effectsApi = { applyEffectsData };   // NetClient hook
    this._audioApi = { emitSound, at };        // NetClient sound replay hook

    this.buildOverlays();
    this.viewmodel = { group: new THREE.Group(), itemId: undefined, switchAnim: 0 };
    this.viewmodelScene.add(this.viewmodel.group);

    this.frame = this.frame.bind(this);
    if (import.meta.env?.DEV) window.game = this;
  }

  // ---------------------------------------------------------------- world lifecycle

  async startWorld(seedString, savedMeta = null) {
    this.disposeWorld();
    this.world = new World(seedString);
    this.world.game = this;
    this.chunkManager = new ChunkManager(this.world, this.scene, this.materials, this.atlas.tileUV);
    this.chunkManager.game = this;
    this.chunkManager.save = this.save;
    if (this.save) this.save.game = this;      // 17-SHIP §1.6 — saveChunkNow needs the game in prod (window.game is DEV-only)
    this.world.chunkManager = this.chunkManager;
    this.entities = new EntityManager(this.world, this.scene);
    this.player = new Player(this.world);
    this.entities.add(this.player);
    this.players = [this.player];              // 14 — player registry (solo: just the local player)
    this.interaction = new Interaction(this);
    installNetherBehaviors();                 // 10-NETHER — attach runtime block behaviors (idempotent)
    this.dayNight = new DayNight(this);
    this.particles = new Particles(this.scene);
    this.mobSpawner = new MobSpawner(this);
    // 07-REDSTONE §5 — the circuit engine + component/container logic. Hooks are
    // attached to block defs once (idempotent across worlds).
    this.redstone = new RedstoneEngine(this.world);
    this.redstone.game = this;
    this.redstoneComponents = new RedstoneComponents(this);
    this.redstoneContainers = new RedstoneContainers(this);
    installComponentHooks();
    installBossHooks();   // 13-BOSSES — wither summon + beacon BE + dragon-egg teleport
    this.endFight = new EndFight(this);   // 13-BOSSES §7 — owns dimMeta[2].endFight + the dragon

    if (savedMeta) {
      this.world.time = savedMeta.worldTime ?? 0;
      this.dayNight.deserialize(savedMeta.weather);
      // 14 AMENDS 01 §16 — meta.players keyed by playerId; the host's own record is
      // its localPlayerId (v2→v3 migration wraps a legacy single `player` there).
      const players = savedMeta.players ?? (savedMeta.player ? { [this.localPlayerId]: savedMeta.player } : {});
      const hostRec = players[this.localPlayerId] ?? Object.values(players)[0] ?? null;
      if (hostRec) this.player.deserialize(hostRec);
      this._savedPlayers = { ...players };     // NetHost restores rejoining clients from here
      // 10-NETHER §2.4 — restore the per-dimension blob (portal links, fortress
      // registry, 11's endFight) so the frozen contract round-trips.
      this.dimMeta = savedMeta.dimensions ?? {};
      // Apply the saved active dimension BEFORE any chunk streams — ChunkManager
      // tags new chunks with world.activeDim and saveManager queries save.activeDim,
      // so a Nether save must swap these before initWorkers or it reboots into the
      // Overworld and orphans every Nether edit (audit H-1).
      const savedDim = this.player.dim ?? 0;
      const desc = getDimension(savedDim) ?? getDimension(0);
      this.world.activeDim = savedDim;
      this.world.hasSkyLight = desc.hasSkyLight;
      if (this.save) this.save.activeDim = savedDim;
    } else {
      this.dimMeta = {};
    }

    this.setState(STATE.LOADING);
    const spawn = await new Promise(resolve => {
      this.chunkManager.onReady = resolve;
      this.chunkManager.initWorkers(seedString);
    });
    this.worldSpawn = spawn;
    if (!savedMeta) {
      this.player.setPos(spawn.x, spawn.y, spawn.z);
      this.player.prevPos.x = spawn.x; this.player.prevPos.y = spawn.y; this.player.prevPos.z = spawn.z;
    }
  }

  disposeWorld() {
    // 17-SHIP §1.6 — guard `this.world` so a double dispose (e.g. quit-then-quit,
    // or a failed startWorld that already nulled world but not chunkManager) is a
    // no-op instead of a null-deref crash. Everything is nulled at the end so the
    // second call short-circuits.
    if (this.chunkManager && this.world) {
      this.chunkManager.dispose();
      for (const chunk of this.world.chunks.values()) this.chunkManager.disposeChunkMeshes(chunk);
    }
    if (this.entities) {
      for (const e of [...this.entities.entities.values()]) this.entities.remove(e);
    }
    this.dayNight?.dispose?.();
    this.particles?.dispose?.();
    this.world = null;
    this.player = null;
    this.chunkManager = null;
    this.entities = null;
  }

  setState(next) {
    const prev = this.state;
    this.state = next;
    if (next === STATE.PAUSED && prev === STATE.PLAYING) this.save?.saveAll(this);
    if (next === STATE.PLAYING) {
      this.lastTime = performance.now();
      this.accumulator = 0;
      // §4.3: first piece 45-90 s after entering PLAYING. Idempotent — the
      // PLAYING_UI and PAUSED round-trips must not restart the scarcity timer.
      if (this.world) this.audio?.music?.arm(this.world.seedString);
    }
    if (next === STATE.TITLE) {
      this.audio?.music?.disarm();
      // Game.tick() early-returns once disposeWorld() nulls this.world, so
      // audio.tick() — and with it ambience's own silence path — never runs
      // again. Without this, rain/wind/fluid loops play on forever at the title.
      this.audio?.ambience?.silence();
    }
    this.ui?.onStateChange?.(next, prev);
  }

  // ---------------------------------------------------------------- main loop (01 §3)

  start() { requestAnimationFrame(this.frame); }

  frame(now) {
    requestAnimationFrame(this.frame);
    const frameDelta = Math.min(now - this.lastTime, 250);
    this.lastTime = now;
    this._frameDelta = frameDelta;

    const t0 = performance.now();
    // 14 AMENDS 01 §3 — a host with ≥1 connected client keeps ticking while PAUSED
    // (the world "keeps running while players are connected"); solo host pauses.
    // CONNECTING (client join) ticks so streamed chunks mesh toward the spawn gate.
    const hostTicking = this.state === STATE.PAUSED && this.net?.isHost && this.net.hasClients();
    if (this.state === STATE.PLAYING || this.state === STATE.PLAYING_UI ||
        this.state === STATE.LOADING || this.state === STATE.DEAD ||
        this.state === STATE.CONNECTING || hostTicking) {
      this.accumulator += frameDelta;
      let ran = 0;
      while (this.accumulator >= MS_PER_TICK && ran < MAX_TICKS_PER_FRAME) {
        this.tick();
        this.accumulator -= MS_PER_TICK;
        ran++;
      }
      if (ran === MAX_TICKS_PER_FRAME) this.accumulator = 0;
    }
    const alpha = Math.min(1, this.accumulator / MS_PER_TICK);
    this.render(alpha);

    this.debug.frameMs = performance.now() - t0;
    this._fpsWindow.push(now);
    while (this._fpsWindow.length && this._fpsWindow[0] < now - 1000) this._fpsWindow.shift();
    this.debug.fps = this._fpsWindow.length;
  }

  tick() {
    if (!this.world) return;
    this.tickCount++;
    // 14-MULTIPLAYER §4.1 — a CLIENT runs no world logic; it predicts its own
    // player and renders host snapshots. Entirely separate tick path.
    if (this.net?.isClient) { this.clientTick(); return; }
    const tickStart = performance.now();

    const playing = this.state === STATE.PLAYING;
    const frame = playing && !this.sleeping ? this.input.snapshot() : (this.input.snapshot(), NEUTRAL_FRAME);

    if (this.state !== STATE.LOADING) {
      // 07 §5.2 — process any dust-solve seeds carried over from last tick,
      // before this tick's player/entity edits queue more.
      this.redstoneContainers?.clearTickGuards();
      this.redstone?.drainAtTickStart();
      // 14 §5.1 step 1.5 — decode client frames, refresh input queues, queue requests.
      this.net?.drainInbound?.();
      this.refreshPlayers();          // rebuild the player list once/tick (mob AI reads it)
      this.player.tick(frame);
      // 14 §5.1 step 2 — every remote player ticks in slot order with its own input.
      this.net?.tickRemotePlayers?.();
      this.interaction.tick(frame);
      // 14 §5.1 step 2.5 — validate + execute queued edits/uses/attacks/container ops.
      this.net?.applyRequests?.();
      this.entities.tick(this.player);
      // 07 §6.3 — pressure-plate presses are entity-driven; scan after entities
      // move (the player is in the manager, so this covers them too).
      this.redstoneComponents?.tickPlates(this.entities.entities.values());
      this.world.scheduled.run();
      this.world.randomTicks();
      this.dayNight.tick();
      this.mobSpawner?.tick();
      this.tickVillages();
      // 13-BOSSES §7.1 — the dragon fight (dragon + parts + respawn ritual) ticks
      // outside the EntityManager while the End is active (AMENDS 05 §1).
      if (this.world.activeDim === 2) this.endFight?.tick(this.world.seedString);
    }
    this.chunkManager.tick(this.player.pos.x, this.player.pos.z);
    if (this.state !== STATE.LOADING) {
      this.tickBlockEntities();
      this.tickSleep();
    }
    this.save?.tick(this);
    // 14 §5.1 step 9.5 — build+send snapshots (every 2nd tick), flush blockSets,
    // stream chunks, 1 Hz player list, 100-tick time sync.
    if (this.state !== STATE.LOADING) this.net?.outboundTick?.();
    this.audio?.tick();                 // AMENDS 01 §3 tick step 10
    this.atlas.animate?.(this.world.time);
    this.ui?.containers?.tickOpen?.();
    // 07 §5.5 — publish the tick's total solver cost once every entry point has
    // run, so the F3 line reports the whole tick rather than one drain.
    this.debug.redstoneMs = this.redstone?.tickSolveMs ?? 0;

    // LOADING → PLAYING gate: 7×7 around player meshed (01 §15.2)
    if (this.state === STATE.LOADING) {
      const pcx = Math.floor(this.player.pos.x) >> 4, pcz = Math.floor(this.player.pos.z) >> 4;
      // let the render-side queue mesh chunks during loading too
      this.chunkManager.drainRemesh(this.player.pos.x, this.player.pos.z, 40, 12);
      const { meshed, needed } = this.chunkManager.loadingProgress(pcx, pcz);
      this.ui?.setLoadingProgress?.(meshed, needed);
      if (meshed >= needed) {
        this.chunkManager.loading = false;
        // 10-NETHER §3.5 — a portal travel deferred the destination build until
        // the ring streamed. Now that blocks exist, find-or-create the portal and
        // drop the player on its stand cell.
        if (this.pendingPortalBuild) {
          const b = this.pendingPortalBuild; this.pendingPortalBuild = null;
          const link = b.fromDim != null ? { fromDim: b.fromDim, srcKey: b.srcKey } : null;
          const stand = findOrCreatePortal(this, b.x, b.y, b.z, link);
          this.player.setPos(stand.x, stand.y, stand.z);
          this.player.prevPos.x = stand.x; this.player.prevPos.y = stand.y; this.player.prevPos.z = stand.z;
          this.player.portalCooldown = 300;
          this.chunkManager.rebuildNow([]);   // any edited chunks re-mesh next frame
        } else if (this.pendingEndArrival) {
          // 11-END §5.5/§5.6 — build the fixed obsidian platform now that chunks
          // exist, then drop the player on it facing the island.
          this.pendingEndArrival = false;
          buildObsidianPlatform(this);
          this.player.setPos(END_SPAWN.x, END_SPAWN.y, END_SPAWN.z);
          this.player.prevPos.x = END_SPAWN.x; this.player.prevPos.y = END_SPAWN.y; this.player.prevPos.z = END_SPAWN.z;
          this.player.yaw = END_SPAWN.yaw; this.player.prevYaw = END_SPAWN.yaw; this.player.pitch = 0;
          this.player.vel.x = this.player.vel.y = this.player.vel.z = 0;
          this.player.portalCooldown = 300;
          this.chunkManager.rebuildNow([]);
        } else {
          this.snapPlayerToGround();
        }
        // 13-BOSSES §7.1 — the arena ring is now streamed. On the first End entry
        // spawn the dragon + 10 crystals; on any dim-2 activation, restore a saved
        // dragon. Both no-op when not applicable.
        if (this.world.activeDim === 2) {
          const seed = this.world.seedString;
          this.endFight?.spawnFight(seed);
          this.endFight?.maybeRespawnDragon(seed);
        }
        this.setState(STATE.PLAYING);
        this.input.requestLock();
      }
    }

    const dt = performance.now() - tickStart;
    if (dt > 40 && this.state !== STATE.LOADING) {
      if (++this.slowTicks >= 2) console.warn(`[game] slow tick: ${dt.toFixed(1)} ms`);
    } else this.slowTicks = 0;
  }

  snapPlayerToGround() {
    const p = this.player;
    const x = Math.floor(p.pos.x), z = Math.floor(p.pos.z);
    for (let y = 127; y >= 0; y--) {
      if (BLOCKS[this.world.getBlock(x, y, z)].collidable) {
        if (p.pos.y < y + 1) p.setPos(p.pos.x, y + 1, p.pos.z);
        break;
      }
    }
    p.prevPos.y = p.pos.y;
  }

  /**
   * 10-NETHER §2.5 — swap the active dimension for the LOCAL PLAYER.
   * Flushes the source dim's chunks to disk (dim-prefixed), retargets every live
   * subsystem to the new dim, repositions the player, and re-enters the loading
   * veil so the target ring streams before control returns. The teleport door
   * (dimensions.changeDimension) routes here for the player.
   */
  changeActiveDimension(targetDim, targetPos, opts = {}) {
    const desc = getDimension(targetDim);
    if (!desc) { console.warn('[dim] unknown dimension', targetDim); return; }
    const p = this.player;
    // 13-BOSSES — bosses don't tick across dimensions, so drop their bars now
    // (the dragon can't remove its own once the End stops ticking).
    this.ui?.bossBar?.clearAll?.();
    if (this.endFight) this.endFight.liveDragon = null;   // the dragon re-hydrates via maybeRespawnDragon on return

    // 1. durably persist + unload the source dim's chunks. flushAllChunks writes
    //    every modified chunk synchronously via saveChunkNow (keyed by chunk.dim),
    //    then clears world.chunks — so the meta checkpoint below writes no chunks
    //    and there is no double-write.
    this.chunkManager.flushAllChunks();

    // 2. retarget the world + save layer to the new dim
    this.world.activeDim = targetDim;
    this.world.hasSkyLight = desc.hasSkyLight;
    if (this.save) this.save.activeDim = targetDim;
    this.dimMeta = this.dimMeta ?? {};
    this.dimMeta[targetDim] = this.dimMeta[targetDim] ?? {};

    // 3. place the player
    p.dim = targetDim;
    p.setPos(targetPos.x, targetPos.y, targetPos.z);
    p.prevPos.x = p.pos.x; p.prevPos.y = p.pos.y; p.prevPos.z = p.pos.z;
    p.vel.x = p.vel.y = p.vel.z = 0;
    p.fallDistance = 0;
    p.portalCooldown = 300;                      // §3.6 no instant bounce

    // 14 — the world has ONE resident dimension, so the party travels together:
    // move every connected player to the destination and tell each client to
    // wipe + restream the new dim. (Concurrent cross-dim play is out of scope —
    // single-world-dim engine; see DEVIATIONS.)
    if (this.net?.isHost) {
      for (const c of this.net.clients.values()) {
        if (!c.player) continue;
        c.player.dim = targetDim;
        c.player.setPos(targetPos.x, targetPos.y, targetPos.z);
        c.player.prevPos.x = targetPos.x; c.player.prevPos.y = targetPos.y; c.player.prevPos.z = targetPos.z;
        c.player.vel.x = c.player.vel.y = c.player.vel.z = 0;
        c.player.portalCooldown = 300;
        this.net.sendDimChange(c, targetDim, targetPos);
      }
    }

    // 4. dimension-arrival hook (dim 2 sets onArrive = regenObsidianPlatform, 11)
    desc.onArrive?.(p, targetPos);

    // 5. meta checkpoint AFTER the swap so a crash mid-travel restores into the
    //    new dim/pos (chunks already durable via step 1; world.chunks now empty).
    this.save?.saveAll?.(this);

    // 6. re-enter the loading veil so the target ring streams synchronously
    this.chunkManager.loading = true;
    this.setState(STATE.LOADING);
    emitSound('block.portal.travel', null);
  }

  // ---------------------------------------------------------------- rendering

  render(alpha) {
    this.renderer.clear(true, true, true);
    // 08 §11 — animate the shared glint texture offset (0.008 / 0.004 per frame).
    // One material instance drives every glinted mesh, which §11 accepts.
    tickGlint();
    if (!this.world || this.state === STATE.TITLE) {
      // Still drive the audio frame with no listener: the music lookahead
      // scheduler (16 §1.5) and the §4A theme layer must run on the title
      // screen and in the disposeWorld→setState(TITLE) window.
      this.audio?.updateFrame(null);
      return;
    }

    this.applyMouseLook();
    this.debug.lastRemeshes = this.chunkManager.drainRemesh(this.player.pos.x, this.player.pos.z);
    // 14 §4.4 — advance remote-entity interpolation + drive puppets before render.
    if (this.net?.isClient) this.net.renderTick(this._frameDelta ?? 16);
    this.updateCamera(alpha);
    this.audio?.updateFrame(this.camera);   // AMENDS 01 §3 render step 6
    this.debug.audioMs = this.audio?.debug.budgetMs ?? 0;
    this.dayNight.updateRender(alpha, this.camera);
    this.entities.updateRender(alpha, this.player);
    if (this.world.activeDim === 2) this.endFight?.updateRender(alpha);   // 13-BOSSES — dragon self-renders
    this.particles.update(alpha);
    this.updateSelectionBox();

    this.renderer.render(this.scene, this.camera);

    if (this.state === STATE.PLAYING || this.state === STATE.PLAYING_UI) {
      this.updateViewmodel(alpha);
      this.renderer.clearDepth();
      this.renderer.render(this.viewmodelScene, this.viewmodelCamera);
    }
    this.ui?.hud?.update?.();
    this.ui?.debug?.update?.();
  }

  // Mouse-look applied per FRAME (03 §18.1): 0.15°/count at sensitivity 1.0
  applyMouseLook() {
    const p = this.player;
    if (!p || this.state !== STATE.PLAYING || !this.input.locked || this.sleeping) {
      this.input.consumeMouseDelta();   // discard stale deltas
      return;
    }
    const { dx, dy } = this.input.consumeMouseDelta();
    if (!dx && !dy) return;
    // 0.15°/count at sensitivity 1.0; the slider (01 §15.3) scales it. Clamped
    // because loadOptions() spreads raw localStorage over the defaults.
    const sens = Math.min(3, Math.max(0.1, this.options?.mouseSensitivity ?? 1));
    const RATE = 0.15 * Math.PI / 180 * sens;
    p.yaw -= dx * RATE;
    p.pitch -= dy * RATE;
    const lim = Math.PI / 2;
    if (p.pitch > lim) p.pitch = lim;
    else if (p.pitch < -lim) p.pitch = -lim;
    if (p.yaw > Math.PI * 4 || p.yaw < -Math.PI * 4) {
      const w = p.yaw % (Math.PI * 2);
      p.prevYaw += w - p.yaw;   // keep interpolation continuous across the wrap
      p.yaw = w;
    }
  }

  updateCamera(alpha) {
    const p = this.player;
    const px = lerp(p.prevPos.x, p.pos.x, alpha);
    const py = lerp(p.prevPos.y + p.prevEyeHeight, p.pos.y + p.eyeHeight, alpha);
    const pz = lerp(p.prevPos.z, p.pos.z, alpha);

    // view bobbing (03 §18.4); the 01 §15.3 toggle zeroes the offset here rather
    // than freezing bobPhase — that phase is tick state and must stay deterministic.
    const phase = lerp(p.prevBobPhase, p.bobPhase, alpha);
    const inten = lerp(p.prevBobIntensity, p.bobIntensity, alpha);
    const bob = this.options?.viewBobbing === false ? 0 : 1;
    const bobY = Math.abs(Math.cos(phase)) * 0.05 * inten * bob;
    const bobR = Math.sin(phase) * 0.025 * inten * bob;
    const rightX = Math.cos(p.yaw), rightZ = -Math.sin(p.yaw);

    // 14 §4.3 — render-only prediction correction offset (decays to 0); game logic
    // always uses the true corrected pos, only the eye lies briefly.
    const ro = this.net?.isClient ? this.net.predictor?.renderOffset : null;
    const ox = ro ? ro.x : 0, oy = ro ? ro.y : 0, oz = ro ? ro.z : 0;
    this.camera.position.set(px + rightX * bobR + ox, py + bobY + oy, pz + rightZ * bobR + oz);
    this.camera.rotation.set(p.pitch, p.yaw, (p.hurtTilt * p.hurtTiltDir) * Math.PI / 180);

    const fov = 70 * p.fovScale;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  buildOverlays() {
    // selection wireframe (01 §11)
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
    this.selectionBox = new THREE.LineSegments(edges,
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 }));
    this.selectionBox.visible = false;
    this.selectionBox.renderOrder = 11;

    // crack overlay (03 §15.4)
    this.crackMesh = null;
    this.crackStage = -1;
  }

  updateSelectionBox() {
    if (!this.selectionBox.parent) this.scene.add(this.selectionBox);
    const hit = this.interaction?.currentHit;
    if (hit && (this.state === STATE.PLAYING || this.state === STATE.PLAYING_UI)) {
      this.selectionBox.visible = true;
      this.selectionBox.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    } else {
      this.selectionBox.visible = false;
    }
  }

  updateCrack(pos, stage) {
    if (stage < 0 || !pos) {
      if (this.crackMesh) this.crackMesh.visible = false;
      this.crackStage = -1;
      return;
    }
    if (!this.crackMesh) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.atlas.texture, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      this.crackMesh = new THREE.Mesh(new THREE.BoxGeometry(1.001, 1.001, 1.001), mat);
      this.scene.add(this.crackMesh);
    }
    if (stage !== this.crackStage) {
      const tile = this.atlas.TILE['destroy_' + stage] ?? 0;
      const t4 = tile * 4;
      const uvr = this.atlas.tileUV;
      const uv = this.crackMesh.geometry.attributes.uv;
      const base = new THREE.BoxGeometry(1, 1, 1).attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i,
          uvr[t4] + (uvr[t4 + 2] - uvr[t4]) * base.getX(i),
          uvr[t4 + 1] + (uvr[t4 + 3] - uvr[t4 + 1]) * (1 - base.getY(i)));
      }
      uv.needsUpdate = true;
      this.crackStage = stage;
    }
    this.crackMesh.visible = true;
    this.crackMesh.position.set(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
  }

  // held-item viewmodel (03 §19)
  updateViewmodel(alpha) {
    const vm = this.viewmodel;
    const held = this.player.heldStack;
    const id = held?.id;
    // 08 §11 — the held viewmodel glints too, so the rebuild key must include
    // whether the stack is enchanted: two swords of the same id, one enchanted,
    // would otherwise share a cached mesh and the glint would not follow the swap.
    const glint = isGlinted(held);
    if (id !== vm.itemId || glint !== vm.glint) {
      vm.itemId = id;
      vm.glint = glint;
      vm.group.clear();
      if (id !== undefined && id !== null) {
        const item = ITEMS.get(id);
        let mesh;
        if (item?.kind === 'block' && item.place != null) {
          mesh = new THREE.Mesh(blockCubeGeometry(item.place, 0.4), makeAtlasMaterial());
          mesh.position.y = -0.2;
          mesh.rotation.y = Math.PI / 4;
        } else {
          mesh = new THREE.Mesh(tileSpriteGeometry(itemTileFor(id), 0.5), makeAtlasMaterial({ doubleSide: true }));
          mesh.position.y = -0.25;
          mesh.rotation.set(0.25, -Math.PI / 2 + 0.35, 0.44);
        }
        vm.group.add(mesh);
        if (glint) addGlintPass(mesh);
      }
      vm.switchAnim = 3;
    }
    if (vm.switchAnim > 0) vm.switchAnim -= alpha < 0.01 ? 1 : 0;

    // base transform + swing (03 §19.1)
    const s = Math.min(1, (this.interaction?.swingTicks ?? 99) / 6);
    const k = s < 1 ? Math.sin(s * Math.PI) : 0;
    const drop = vm.switchAnim > 0 ? 0.3 : 0;
    vm.group.position.set(0.56 - 0.10 * k, -0.52 - 0.25 * k - drop, -0.72);
    vm.group.rotation.set(-75 * k * Math.PI / 180, -25 * k * Math.PI / 180, 0);
    // offhand item in the left hand (UPDATE-08 §7.1), mirrored transform
    const offId = this.player.offhand?.id;
    if (offId !== vm.offhandId) {
      vm.offhandId = offId;
      if (!vm.offGroup) {
        vm.offGroup = new THREE.Group();
        this.viewmodelScene.add(vm.offGroup);
      }
      vm.offGroup.clear();
      if (offId !== undefined && offId !== null) {
        const item = ITEMS.get(offId);
        let mesh;
        if (item?.kind === 'block' && item.place != null) {
          mesh = new THREE.Mesh(blockCubeGeometry(item.place, 0.32), makeAtlasMaterial());
          mesh.position.y = -0.16;
          mesh.rotation.y = -Math.PI / 4;
        } else {
          mesh = new THREE.Mesh(tileSpriteGeometry(itemTileFor(offId), 0.4), makeAtlasMaterial({ doubleSide: true }));
          mesh.position.y = -0.2;
          mesh.rotation.set(0.25, Math.PI / 2 - 0.35, -0.44);
        }
        vm.offGroup.add(mesh);
      }
    }
    if (vm.offGroup) vm.offGroup.position.set(-0.56, -0.56, -0.72);

    // brightness follows the player's light
    const ls = this.player.lightScalar;
    for (const grp of [vm.group, vm.offGroup]) {
      grp?.traverse(o => {
        if (o.isMesh && o.material?.userData?.baseColor) o.material.color.setRGB(ls, ls, ls);
      });
    }
  }

  // ---------------------------------------------------------------- block entities

  getBlockEntity(x, y, z) {
    const chunk = this.world.getChunkAt(x, z);
    if (!chunk) return null;
    const i = (y << 8) | ((z & 15) << 4) | (x & 15);
    let be = chunk.blockEntities.get(i);
    if (!be) {
      const kind = BLOCKS[chunk.blocks[i]].blockEntity;
      if (!kind) return null;
      // 07 §17 — dispenser/dropper are 9 slots; hopper is 5 slots + cooldown.
      be = kind === 'chest' ? { type: 'chest', data: { slots: new Array(27).fill(null) } }
        : kind === 'dispenser' ? { type: 'dispenser', data: { slots: new Array(9).fill(null) } }
        : kind === 'dropper' ? { type: 'dropper', data: { slots: new Array(9).fill(null) } }
        : kind === 'hopper' ? { type: 'hopper', data: { slots: new Array(5).fill(null), cooldown: 0 } }
        // 09-POTIONS §10 — brewing stand: 3 bottles + ingredient + fuel.
        : kind === 'brewing' ? { type: 'brewing', data: { slots: new Array(5).fill(null), brewTime: 0, fuel: 0 } }
        // 10-NETHER §6.1 — spawner block-entity defaults.
        : kind === 'spawner' ? { type: 'spawner', data: {
          mobType: 'blaze', delay: 20, minDelay: 200, maxDelay: 800,
          spawnCount: 4, maxNearby: 6, activationRange: 16, spawnRange: 4 } }
        // 11-END §9.4 — shulker box (27 slots, distinct type for spill branching).
        : kind === 'shulker_box' ? { type: 'shulker_box', data: { slots: new Array(27).fill(null) } }
        // 11-END §11 — end gateway (paired-teleport block-entity).
        : kind === 'end_gateway' ? { type: 'end_gateway', data: { partner: null } }
        // 13-BOSSES §9.1 — beacon (primary/secondary power; levels recomputed).
        : kind === 'beacon' ? { type: 'beacon', data: { primaryEffect: null, secondary: null, levels: 0, active: false, beamHandle: null } }
        : { type: 'furnace', data: { slots: new Array(3).fill(null), burn: 0, fuelTotal: 0, cook: 0, xpBank: 0 } };
      chunk.blockEntities.set(i, be);
      chunk.modified = true;
    }
    return be;
  }

  tickBlockEntities() {
    const p = this.world.playerChunk;
    if (!p) return;
    for (let dcx = -SIM_RADIUS; dcx <= SIM_RADIUS; dcx++) {
      for (let dcz = -SIM_RADIUS; dcz <= SIM_RADIUS; dcz++) {
        const chunk = this.world.chunks.get(chunkKey(p.cx + dcx, p.cz + dcz));
        if (!chunk || chunk.state < ChunkState.GENERATED || chunk.blockEntities.size === 0) continue;
        for (const [i, be] of chunk.blockEntities) {
          const x = chunk.cx * 16 + (i & 15), y = i >> 8, z = chunk.cz * 16 + ((i >> 4) & 15);
          if (be.type === 'furnace') this.tickFurnace(be.data, x, y, z, chunk);
          else if (be.type === 'hopper') this.redstoneContainers.tickHopper(be, x, y, z);   // 07 §11.3
          else if (be.type === 'spawner') tickSpawner(this, be, x, y, z);   // 10-NETHER §6.2
          else if (be.type === 'brewing') tickBrewing(this, be.data, x, y, z, chunk);        // 09-POTIONS §10.2
          else if (be.type === 'beacon') this.tickBeacon(be, x, y, z);      // 13-BOSSES §9
        }
      }
    }
  }

  // 13-BOSSES §9.2/§9.3/§9.5 — every 80 ticks recompute the pyramid + sky access;
  // apply the primary power to nearby players; fire activate/deactivate transitions.
  tickBeacon(be, x, y, z) {
    if (this.world.getBlock(x, y, z) !== B.BEACON) return;
    if (this.world.time % 80 !== 0) return;
    const levels = pyramidLevels(this.world, x, y, z);
    const active = levels >= 1 && skyClear(this.world, x, y, z);
    be.data.levels = levels;
    if (active !== be.data.active) {
      emitSound(active ? 'block.beacon.activate' : 'block.beacon.deactivate', at(x + 0.5, y + 0.5, z + 0.5));
      be.data.active = active;
    }
    if (active && be.data.primaryEffect != null) applyBeaconEffects(this, be, x, y, z, levels);
  }

  // 06 §11.1
  tickFurnace(f, x, y, z, chunk) {
    const [input, fuel] = [f.slots[0], f.slots[1]];
    const recipe = input ? SMELTING.get(input.id) : null;
    const out = f.slots[2];
    const canSmelt = !!recipe && (!out || (out.id === recipe.out && out.count + 1 <= (ITEMS.get(out.id)?.stack ?? 64)));

    if (f.burn > 0) f.burn--;
    if (f.burn === 0 && canSmelt && fuel) {
      const v = fuelValue(fuel.id);
      if (v > 0) {
        f.burn = f.fuelTotal = v;
        if (fuel.id === idOf('lava_bucket')) {
          f.slots[1] = { id: idOf('bucket'), count: 1 };
        } else {
          fuel.count--;
          if (fuel.count <= 0) f.slots[1] = null;
        }
        this.swapFurnaceBlock(x, y, z, true);
        chunk.modified = true;
      }
    }
    if (f.burn > 0 && canSmelt) {
      f.cook++;
      if (f.cook >= 200) {
        f.cook = 0;
        if (out) out.count++;
        else f.slots[2] = { id: recipe.out, count: 1 };
        input.count--;
        if (input.count <= 0) f.slots[0] = null;
        f.xpBank += recipe.xp;
        chunk.modified = true;
      }
    } else {
      f.cook = Math.max(0, f.cook - 2);
    }
    if (f.burn === 0 && this.world.getBlock(x, y, z) === B.FURNACE_LIT) {
      this.swapFurnaceBlock(x, y, z, false);
    }
  }

  swapFurnaceBlock(x, y, z, lit) {
    const cur = this.world.getBlock(x, y, z);
    const want = lit ? B.FURNACE_LIT : B.FURNACE;
    if (cur === want || (cur !== B.FURNACE && cur !== B.FURNACE_LIT)) return;
    const state = this.world.getState(x, y, z);
    this.world.setBlock(x, y, z, want, { state, noUpdates: true });
  }

  spillBlockEntity(be, x, y, z) {
    // audit M7 — a destroyed container force-closes every remote viewer's window
    // (§6/§9.2), so no client is left staring at a stale, now-spilled container.
    if (this.net?.isHost) {
      for (const c of this.net.clients.values()) {
        if (c.window && c.window.x === x && c.window.y === y && c.window.z === z) {
          this.net._jsonTo(c.slot, { t: 'containerResult', windowId: c.window.id, close: true });
          this.hostContainerClose(c);
        }
      }
    }
    const data = be.data;
    // 11-END §9.4 — a shulker box drops ONE item retaining its 27 slots in
    // tags.containerItems (not a loose spill). Both break + explosion route here.
    if (be.type === 'shulker_box') {
      const containerItems = packContainer(data.slots ?? []);
      const stack = { id: B.SHULKER_BOX, count: 1 };
      if (containerItems.length) stack.tags = { containerItems };
      this.dropStackAt(stack, x + 0.5, y + 0.5, z + 0.5);
      if (data?.slots) data.slots.fill(null);
      return;
    }
    if (data?.slots) {
      for (const s of data.slots) if (s) this.dropStackAt(s, x + 0.5, y + 0.5, z + 0.5);
      data.slots.fill(null);
    }
    if (data?.xpBank >= 1) this.spawnXpOrb(x + 0.5, y + 0.5, z + 0.5, Math.floor(data.xpBank));
  }

  // ---------------------------------------------------------------- explosions (05 §12)

  // 13-BOSSES §8.7 — the blue wither skull treats every destructible block as
  // blast-0 (breaks obsidian, removes fluids); only hardness<0 blocks (bedrock +
  // portal family = witherImmune) survive via the existing guard below.
  explodeBlast0(x, y, z, power) { this.explode(x, y, z, power, { blastZero: true }); }

  explode(x, y, z, power, opts = {}) {
    const world = this.world;
    const rng = world.rng;
    // block destruction: sphere with falloff (05 §12.2 adaptation)
    const maxR = 1.3 * power + 0.6;
    const centerIsWater = BLOCKS[world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))].fluid === 'water';
    if (!centerIsWater) {
      const r0 = Math.ceil(maxR);
      for (let dy = -r0; dy <= r0; dy++) {
        for (let dz = -r0; dz <= r0; dz++) {
          for (let dx = -r0; dx <= r0; dx++) {
            const bx = Math.floor(x) + dx, by = Math.floor(y) + dy, bz = Math.floor(z) + dz;
            if (by < 0 || by > 127) continue;
            const r = Math.hypot(bx + 0.5 - x, by + 0.5 - y, bz + 0.5 - z);
            if (r > maxR) continue;
            const id = world.getBlock(bx, by, bz);
            if (id === B.AIR) continue;
            const blk = BLOCKS[id];
            if (blk.hardness < 0 && !blk.fluid) continue;   // bedrock
            const state = world.getState(bx, by, bz);
            // AMENDS 05 §12 / 15 §13.6 — a waterlogged cell is explosion-proof
            // like water: resistance = max(blast, 100). A creeper cannot crater
            // a submerged fence line. Hoisted above the gate; the drops call
            // below needs the same read.
            const blast = opts.blastZero ? 0 : ((state & WATERLOGGED) ? Math.max(blk.blast, 100) : blk.blast);
            const strength = power * (0.7 + 0.6 * rng()) * (1 - r / (1.3 * power));
            if (strength <= (blast + 0.3) * 0.3) continue;
            if (id === B.TNT) {
              world.setBlock(bx, by, bz, B.AIR);
              this.igniteTnt(bx, by, bz, 10 + Math.floor(rng() * 21));
              continue;
            }
            world.setBlock(bx, by, bz, B.AIR);
            // drops with probability 1/power, as if mined by diamond tool
            if (rng() < 1 / power && blk.drops) {
              const drops = blk.drops({ state, toolClass: blk.tool ?? 'pickaxe', toolTier: 3, rng });
              for (const d of drops) this.spawnItemByName(d.name, d.count, bx + 0.5, by + 0.5, bz + 0.5);
            }
          }
        }
      }
    }

    // entity damage + knockback (05 §12.3)
    const range = 2 * power;
    const box = new AABB(x - range, y - range, z - range, x + range, y + range, z + range);
    for (const e of this.entities.getEntitiesInBox(box, ent => !ent.dead)) {
      const cx = e.pos.x, cy = e.pos.y + e.height / 2, cz = e.pos.z;
      const dist = Math.hypot(cx - x, cy - y, cz - z);
      if (dist >= range) continue;
      // exposure: 8 AABB corners + center (adaptation)
      const bb = e.getAABB();
      let clear = 0;
      const samples = [
        [cx, cy, cz],
        [bb.min[0], bb.min[1], bb.min[2]], [bb.max[0], bb.min[1], bb.min[2]],
        [bb.min[0], bb.min[1], bb.max[2]], [bb.max[0], bb.min[1], bb.max[2]],
        [bb.min[0], bb.max[1], bb.min[2]], [bb.max[0], bb.max[1], bb.min[2]],
        [bb.min[0], bb.max[1], bb.max[2]], [bb.max[0], bb.max[1], bb.max[2]],
      ];
      for (const [sx, sy, sz] of samples) {
        if (hasLineOfSight(world, sx, sy, sz, x, y, z)) clear++;
      }
      const exposure = clear / samples.length;
      const impact = (1 - dist / range) * exposure;
      const dmg = Math.floor((impact * impact + impact) / 2 * 7 * range + 1);
      const len = dist || 1;
      if (e instanceof LivingEntity) {
        e.hurt(dmg, 'explosion', {});
      }
      // 18 §4.4 — a creative player takes no knockback from explosions. This
      // push is applied directly, NOT through applyKnockback, so the Player
      // override cannot cover it: 05 §12.3's blast shove is its own code path.
      // Blocks and every other entity are still thrown normally (§4.2).
      if (e.creative) continue;
      // 08 §5.2.1 — Blast Protection scales the explosion knockback impact by
      // (1 − 0.15 × L), from the HIGHEST single level among worn pieces. Only
      // the player wears armor; every other entity keeps impact unscaled.
      const kbImpact = impact * (e.armor ? explosionKnockbackScale(e.armor) : 1);
      e.vel.x += (cx - x) / len * kbImpact;
      e.vel.y += (cy - y) / len * kbImpact;
      e.vel.z += (cz - z) / len * kbImpact;
    }
    this.particles?.explosion?.(x, y, z, power);
    // One emit covers both §5.2 triggers (creeper 05 §12 and TNT 06 §5.6); the
    // §3.5 distance-muffle LP is per-voice from the listener, so power is unused.
    emitSound('world.explosion', at(x, y, z));
    this.dayNight?.flash?.(2);
  }

  // ---------------------------------------------------------------- entity spawning hooks

  spawnItemById(id, count, x, y, z, vel) {
    if (this.net?.isClient) return null;   // 14 §4.5 — drops are host-authoritative
    if (!ITEMS.has(id) || count <= 0) return null;
    const e = new ItemEntity(this.world, x, y, z, { id, count }, 10);
    const r = this.world.rng;
    e.vel.x = vel?.x ?? (r() - 0.5) * 0.2;
    e.vel.y = vel?.y ?? 0.2;
    e.vel.z = vel?.z ?? (r() - 0.5) * 0.2;
    return this.entities.add(e);
  }

  spawnItemByName(name, count, x, y, z, vel) {
    try { return this.spawnItemById(idOf(name), count, x, y, z, vel); }
    catch { console.warn('[game] unknown item drop', name); return null; }
  }

  dropStackAt(stack, x, y, z) {
    if (this.net?.isClient) return null;   // 14 §4.5 — host-authoritative
    // cloneStack: a spread would leave the entity and the source stack sharing
    // one tags object (08 §1 invariant 4).
    const e = new ItemEntity(this.world, x, y, z, cloneStack(stack), 40);
    const r = this.world.rng;
    e.vel.x = (r() - 0.5) * 0.4;
    e.vel.y = 0.2;
    e.vel.z = (r() - 0.5) * 0.4;
    return this.entities.add(e);
  }

  // Q-drop / UI drag-out: gentle toss forward from the eye (03 §17)
  throwStack(stack) {
    if (this.net?.isClient) return null;   // 14 §4.5 — host spawns the item
    const p = this.player;
    const d = this.interaction.lookDir();
    const r = this.world.rng;
    const e = new ItemEntity(this.world,
      p.pos.x, p.pos.y + p.eyeHeight - 0.3, p.pos.z, cloneStack(stack), 40);
    e.vel.x = d.x * 0.3 + (r() - 0.5) * 0.04;
    e.vel.y = d.y * 0.3 + 0.1 + (r() - 0.5) * 0.04;
    e.vel.z = d.z * 0.3 + (r() - 0.5) * 0.04;
    return this.entities.add(e);
  }

  spawnXpOrb(x, y, z, value) {
    if (this.net?.isClient) return null;   // 14 §4.5 — host-authoritative
    return this.entities.add(new XpOrb(this.world, x, y, z, value));
  }

  spawnArrow(x, y, z, vx, vy, vz, owner, opts) {
    return this.entities.add(new Arrow(this.world, x, y, z, vx, vy, vz, owner, opts));
  }

  spawnThrown(kind, x, y, z, vx, vy, vz, owner) {
    return this.entities.add(new ThrownProjectile(this.world, kind, x, y, z, vx, vy, vz, owner));
  }

  // 09-POTIONS §2 — the frozen effect entry points (10/11/13 call these on game).
  addEffect(entity, id, amplifier, duration, ambient = false) {
    return engineAddEffect(entity, id, amplifier, duration, ambient);
  }
  applyInstant(target, effectId, amplifier, potency, source = null) {
    engineApplyInstant(target, effectId, amplifier, potency, source);
  }

  // 09-POTIONS §13/§14 — spawn a thrown splash/lingering potion.
  spawnPotion(potionId, form, x, y, z, vx, vy, vz, owner) {
    return this.entities.add(new ThrownPotion(this.world, potionId, form, x, y, z, vx, vy, vz, owner));
  }
  // §14.2 factory (13-BOSSES injects dragon-breath params through this).
  spawnAreaEffectCloud(params) {
    return this.entities.add(spawnEffectCloud(this.world, params));
  }

  spawnFallingBlock(id, x, y, z, state = 0) {
    return this.entities.add(new FallingBlock(this.world, id, x + 0.5, y, z + 0.5, state));
  }

  igniteTnt(x, y, z, fuse = 80) {
    if (this.world.getBlock(x, y, z) === B.TNT) this.world.setBlock(x, y, z, B.AIR);
    const e = this.entities.add(new PrimedTnt(this.world, x + 0.5, y, z + 0.5, fuse));
    e.fuseVoice = startLoop('world.tnt.fuse', e);   // §3.5: tracked to the entity
    return e;
  }

  spawnMobAt(type, x, y, z, opts = {}) {
    const mob = createMob(this.world, type, x, y, z, opts);
    if (!mob) return null;
    return this.entities.add(mob);
  }

  onChunkGenerated(chunk) {
    // 12-VILLAGES §2.7 — register a village record for AI/golem/trading + persistence.
    if (chunk.villageMeta) {
      this.villages ??= new Map();
      const key = chunk.villageMeta.anchor.join(',');
      if (!this.villages.has(key)) this.villages.set(key, chunk.villageMeta);
    }
    if (chunk.pendingSpawns && !chunk.spawnsDone) {
      for (const rec of chunk.pendingSpawns) {
        if (rec.be === 'spawner') this.configureSpawner(rec.x, rec.y, rec.z, rec.mobType);
        else if (rec.be === 'chest') this.rollGenChest(rec.x, rec.y, rec.z, rec.loot);
        else if (rec.type === 'villager') {
          // 12-VILLAGES §8.6 — gen villagers spawn unemployed near the bell.
          this.spawnMobAt('villager', rec.x, rec.y, rec.z, { persistent: true, homeVillage: rec.homeVillage ?? null });
        } else this.spawnMobAt(rec.type, rec.x, rec.y, rec.z, { persistent: true });
      }
      chunk.spawnsDone = true;
      chunk.pendingSpawns = null;
      chunk.modified = true;
    }
  }

  // 12-VILLAGES §11 — iron-golem population spawn. A village with ≥5 adult
  // villagers gets one defending golem near the bell, re-spawned 300s after death.
  tickVillages() {
    if (!this.villages || this.villages.size === 0) return;
    if (this.world.time % 200 !== 0) return;
    for (const meta of this.villages.values()) {
      const g = meta.golem ??= { alive: false, respawnTimer: 0 };
      if (g.respawnTimer > 0) g.respawnTimer -= 200;
      const [bx, by, bz] = meta.bellPos;
      if (!this.world.isLoaded(bx, bz)) continue;
      // confirm the tracked golem is still alive; otherwise start the respawn clock.
      if (g.alive) {
        const still = this.entities.count(e => e.type === 'iron_golem' &&
          Math.hypot(e.pos.x - bx, e.pos.z - bz) < 48) > 0;
        if (!still) { g.alive = false; g.respawnTimer = 6000; }
        continue;
      }
      if (g.respawnTimer > 0) continue;
      // count adult villagers homed to this village within its radius.
      const key = meta.anchor.join(',');
      const pop = this.entities.count(e => e.type === 'villager' && !e.isBaby &&
        (e.homeVillage === key || Math.hypot(e.pos.x - bx, e.pos.z - bz) < 32));
      if (pop < 5) continue;
      const spot = this.golemSpawnSpot(bx, by, bz);
      if (!spot) continue;
      const golem = this.spawnMobAt('iron_golem', spot[0], spot[1], spot[2], { persistent: true, homeVillage: key });
      if (golem) { g.alive = true; g.respawnTimer = 0; }
    }
  }

  // find open ground (2-tall air on a solid block) within a small ring of the bell.
  golemSpawnSpot(bx, by, bz) {
    const w = this.world;
    for (let r = 2; r <= 6; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        const x = bx + dx, z = bz + dz;
        for (let dy = -2; dy <= 2; dy++) {
          const y = by + dy;
          if (BLOCKS[w.getBlock(x, y - 1, z)]?.collidable &&
              !BLOCKS[w.getBlock(x, y, z)]?.collidable &&
              !BLOCKS[w.getBlock(x, y + 1, z)]?.collidable)
            return [x + 0.5, y, z + 0.5];
        }
      }
    }
    return null;
  }

  // 12-VILLAGES §9.1 — open the villager trade screen.
  openTrade(villager) {
    this.tradingVillager = villager;
    villager.tradingWith = this.player;
    this.ui?.containers?.open?.('trade');
  }

  /** 10-NETHER §6 — set a gen-placed spawner block's block-entity mob type. */
  configureSpawner(x, y, z, mobType) {
    if (this.world.getBlock(x, y, z) !== 141) return;   // spawner id
    const be = this.getBlockEntity(x, y, z);
    if (be?.data) be.data.mobType = mobType;
  }

  // 11-END §15 — fill a gen-placed chest from a loot table, seeded by position so
  // save/reload is stable (the BE persists once rolled, so it never re-rolls).
  rollGenChest(x, y, z, table) {
    if (this.world.getBlock(x, y, z) !== 37) return;   // chest id
    const be = this.getBlockEntity(x, y, z);
    if (be?.data?.slots) rollChestLoot(be.data.slots, table, this.world.seedString ?? this.world.seed ?? 0, x, y, z);
  }

  onChunkHydrated(chunk, record) {
    // 12-VILLAGES §2.7 — restore the persisted village record (golem timers etc.).
    if (record.villageMeta) {
      chunk.villageMeta = record.villageMeta;
      this.villages ??= new Map();
      const key = record.villageMeta.anchor.join(',');
      if (!this.villages.has(key)) this.villages.set(key, record.villageMeta);
    }
    if (record.entities) {
      for (const rec of record.entities) this.restoreEntity(rec);
    }
    if (!chunk.spawnsDone && record.spawns?.length) {
      chunk.pendingSpawns = record.spawns;
      this.onChunkGenerated(chunk);
    }
  }

  restoreEntity(rec) {
    let e = null;
    let restoredTnt = false;
    if (rec.type === 'item') e = ItemEntity.deserialize(this.world, rec);
    else if (rec.type === 'primed_tnt') { e = PrimedTnt.deserialize(this.world, rec); restoredTnt = true; }
    else if (rec.type === 'xp_orb') { e = new XpOrb(this.world, rec.pos[0], rec.pos[1], rec.pos[2], rec.value); }
    else if (rec.type === 'end_crystal') e = EndCrystal.deserialize(this.world, rec);   // 13-BOSSES §3
    else {
      e = createMob(this.world, rec.type, rec.pos[0], rec.pos[1], rec.pos[2], {});
      if (e) e.deserialize(rec);
    }
    if (e) this.entities.add(e);
    // Mid-fuse TNT restored from a save never passes through igniteTnt, so it
    // would tick down silently without this.
    if (e && restoredTnt) e.fuseVoice = startLoop('world.tnt.fuse', e);
  }

  onChunkUnloading(chunk) {
    this.entities.onChunkUnloading(chunk, this.player);
    // 15 §6.4 — "chunk unload deletes that chunk's entries". Fires in an
    // unloaded chunk never tick again, so without this their origins sit in the
    // map forever and slowly starve MAX_ACTIVE until nothing may spread.
    forgetFireInChunk(chunk.cx, chunk.cz);
  }

  // ---------------------------------------------------------------- tree growth (sapling → 02 placer)

  growTree(species, x, y, z) {
    const world = this.world;
    const saplingId = world.getBlock(x, y, z);
    world.setBlock(x, y, z, B.AIR, { noUpdates: true });
    const isLeaf = id => id === B.OAK_LEAVES || id === B.BIRCH_LEAVES || id === B.SPRUCE_LEAVES;
    const ok = placeTree(species, x, y - 1, z, world.rng, world.detailSeed(),
      (wx, wy, wz, id, mode) => {
        const cur = world.getBlock(wx, wy, wz);
        if (mode === 'leaf' && cur !== B.AIR) return;
        if (mode === 'log' && !(cur === B.AIR || isLeaf(cur))) return;
        if (mode === 'dirt' && !(cur === B.GRASS_BLOCK || cur === B.DIRT)) return;
        world.setBlock(wx, wy, wz, mode === 'dirt' ? B.DIRT : id, { noUpdates: true });
      },
      (tx, ty, tz) => world.getBlock(tx, ty, tz) === B.AIR || (tx === x && ty === y && tz === z));
    if (ok === false) world.setBlock(x, y, z, saplingId, { noUpdates: true });
  }

  // ---------------------------------------------------------------- sleep (04 §14, 06 §5.7)

  trySleep(x, y, z) {
    const p = this.player;
    // 10-NETHER §10.2 — in an explodesBeds dimension, RMB detonates the bed
    // (power-5 + fire) instead of sleeping; no spawn set, no sleep.
    if (getDimension(this.world.activeDim)?.explodesBeds) {
      this.world.setBlock(x, y, z, B.AIR, { byPlayer: true });   // onBroken clears the other half
      this.explode(x + 0.5, y + 0.5, z + 0.5, 5);                // §10.2 power-5 (fire is a documented nicety)
      return;
    }
    // 11-END §7 — the End denies sleep (no explosion, no spawn set).
    if (getDimension(this.world.activeDim)?.noSleep) { this.toast('You may not rest here'); return; }
    // 14 §5.5 — a REMOTE player's bed use is a per-player sleep, not the host's.
    const actor = this._netActor;
    const sleeper = actor ? actor.player : p;
    sleeper.spawnPoint = { x, y, z };            // always set on click (06 §5.7)
    if (!this.dayNight.canSleepNow()) {
      if (!actor) this.toast('You can only sleep at night');
      return;
    }
    const hostiles = this.entities.getEntitiesInBox(
      new AABB(x - 8, y - 5, z - 8, x + 9, y + 6, z + 9),
      e => HOSTILE_TYPES.has(e.type));
    if (hostiles.length > 0) {
      if (!actor) this.toast('You may not rest now; there are monsters nearby');
      return;
    }
    if (actor) { actor.sleeping = true; this.net?.broadcastSleepStatus?.(this.sleepingCount(), this.net.connectedPlayerCount()); return; }
    this.sleeping = { ticks: 0 };
    this.ui?.setSleepFade?.(true);
    if (this.net?.isHost) this.net.broadcastSleepStatus(this.sleepingCount(), this.net.connectedPlayerCount());
  }

  sleepingCount() {
    let n = this.sleeping ? 1 : 0;
    if (this.net?.isHost) for (const c of this.net.clients.values()) if (c.sleeping) n++;
    return n;
  }

  tickSleep() {
    // 14 §5.5 — multiplayer: night skips only when EVERY connected player is in
    // bed for ≥100 continuous ticks (SLEEP_PERCENT = 100).
    if (this.net?.isHost && this.net.hasClients()) {
      const total = this.net.connectedPlayerCount();
      const inBed = this.sleepingCount();
      if (this.sleeping && inBed === total) {
        this._mpSleepTicks = (this._mpSleepTicks || 0) + 1;
        if (this._mpSleepTicks >= 100) {
          this.dayNight.sleepSkip();
          this._mpSleepTicks = 0;
          this.sleeping = null; this.ui?.setSleepFade?.(false);
          for (const c of this.net.clients.values()) c.sleeping = false;
          this.net.broadcastTimeSync();
          this.net.broadcastSleepStatus(0, total);
        }
      } else {
        this._mpSleepTicks = 0;
      }
      return;
    }
    if (!this.sleeping) return;
    if (++this.sleeping.ticks >= 100) {
      this.dayNight.sleepSkip();
      this.sleeping = null;
      this.ui?.setSleepFade?.(false);
    }
  }

  validateBedSpawn(sp) {
    const w = this.world;
    if (w.getBlock(sp.x, sp.y, sp.z) !== B.BED_BLOCK) return null;
    const spots = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of spots) {
      const x = sp.x + dx, z = sp.z + dz;
      const feetId = w.getBlock(x, sp.y, z);
      const headId = w.getBlock(x, sp.y + 1, z);
      if (!BLOCKS[feetId].collidable && !BLOCKS[headId].collidable) {
        return { x: x + 0.5, y: sp.y, z: z + 0.5 };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- player events

  onPlayerHurt() {
    this.ui?.hud?.onDamage?.();
  }

  // 18 §7.1 — every hostile chasing this player drops its target the instant the
  // switch lands. Mob.updateTarget's give-up rule would also catch this on its
  // next run, but the enderman's `aggro` flag is separate state that no give-up
  // rule clears, and it gates that mob's whole chase behaviour.
  onPlayerEnteredCreative(player) {
    if (!this.entities) return;
    for (const e of this.entities.entities.values()) {
      if (e.target === player) {
        e.target = null;
        if (e.aggro) { e.aggro = false; e.aggroLostTicks = 0; }
      }
    }
  }

  // 18 §1.4 — hud.rebuild() toggles the survival cluster rather than
  // per-frame branching; the switch is rare.
  onGameModeChanged(mode) {
    this.ui?.hud?.rebuild?.();
    this.ui?.onGameModeChanged?.(mode);
  }

  onPlayerDeath(player = this.player) {
    // 14 AMENDS 03 §20 — a REMOTE player's death is host-side: broadcast a death
    // line; that client learns it via playerState.dead and shows its own screen.
    if (this.net?.isHost && player !== this.player) {
      const c = this.net.clientForPlayer(player);
      const name = c?.name ?? player.netName ?? 'A player';
      this.net.broadcastEntityDespawn?.(player.id, 'died');
      this.net._broadcastJson?.({ t: 'chat', from: null, text: `${name} died` });
      if (c) this.net._sendPlayerState?.(c, true);
      this.ui?.chat?.addSystem?.(`${name} died`);
      return;
    }
    document.exitPointerLock?.();
    this.setState(STATE.DEAD);
  }

  respawnPlayer() {
    // On a CLIENT, the host runs the respawn; we ask for it and wait for forceMove.
    if (this.net?.isClient) { this.net.sendRespawn(); return; }
    this.player.respawn(this.worldSpawn);
    this.setState(STATE.PLAYING);
    this.input.requestLock();
  }

  toast(msg) { this.ui?.toast?.(msg); }

  openContainer(kind, x, y, z) {
    // 14 §6 — a REMOTE player's container open is host-resolved into a net window,
    // not the host's own screen. _netActor is set while applying that client's use.
    if (this._netActor) { this.hostOpenNetContainer(this._netActor, kind, x, y, z); return; }
    this.ui?.containers?.open?.(kind, x, y, z);
  }

  // ================================================================ 14-MULTIPLAYER

  // ---------------------------------------------------------------- player registry
  refreshPlayers() {
    const arr = this.players;
    arr.length = 0;
    if (this.player) arr.push(this.player);
    if (this.net?.isHost) for (const c of this.net.clients.values()) if (c.player && !c.player.dead) arr.push(c.player);
  }
  isPlayer(e) { return !!e && (e === this.player || e.type === 'player'); }
  // nearest live player in 3D — AMENDS 05 §1/§4/§6. Solo returns game.player.
  nearestPlayerTo(x, y, z) {
    const arr = this.players.length ? this.players : (this.player ? [this.player] : []);
    let best = null, bd = Infinity;
    for (const p of arr) {
      if (!p || p.dead) continue;
      const d = (p.pos.x - x) ** 2 + (p.pos.y - y) ** 2 + (p.pos.z - z) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  eachPlayer(fn) { for (const p of this.players) if (p && !p.dead) fn(p); }
  // chunk centers of every player (host union keep-alive / sim range, AMENDS 01 §4.3).
  playerChunkCenters() {
    const out = [];
    for (const p of this.players) if (p && !p.dead) out.push({ cx: Math.floor(p.pos.x) >> 4, cz: Math.floor(p.pos.z) >> 4 });
    return out.length ? out : (this.world?.playerChunk ? [this.world.playerChunk] : []);
  }
  currentHostileCap() { return hostileCap(this.net?.isHost ? this.net.connectedPlayerCount() : 1); }
  withActivePlayer(player, fn) {
    const it = this.interaction, prev = it._activePlayer;
    it._activePlayer = player;
    try { return fn(); } finally { it._activePlayer = prev; }
  }

  // ---------------------------------------------------------------- host session
  startHosting(url) {
    const NetHostP = import('./net/NetHost.js');
    return NetHostP.then(({ NetHost }) => {
      const net = new NetHost(this);
      this.net = net;
      net.onCode = code => this.ui?.netMenus?.setHostCode?.(code);
      net.onError = reason => this.ui?.netMenus?.onHostError?.(reason);
      net.host(url);
      return net;
    });
  }

  playerRecordFor(p, name) {
    return { ...p.serialize(), name, lastSeen: this._nowMs() };
  }
  _nowMs() { try { return Date.now(); } catch { return 0; } }

  buildPlayerRecords() {
    const out = { ...(this._savedPlayers ?? {}) };
    if (this.player) out[this.localPlayerId] = this.playerRecordFor(this.player, this.localPlayerName);
    if (this.net?.isHost) for (const c of this.net.clients.values()) if (c.player) out[c.playerId] = this.playerRecordFor(c.player, c.name);
    return out;
  }

  takeSavedPlayerRecord(playerId) { return this._savedPlayers?.[playerId] ?? null; }
  saveNetPlayerRecord(client) {
    if (!client.player) return;
    this._savedPlayers ??= {};
    this._savedPlayers[client.playerId] = this.playerRecordFor(client.player, client.name);
  }

  hostSpawnPosFor(rec) {
    if (rec?.spawnPoint) { const bs = this.validateBedSpawn?.(rec.spawnPoint); if (bs) return bs; }
    const base = this.player?.pos ?? this.worldSpawn ?? { x: 0, y: 80, z: 0 };
    const x = Math.floor(base.x) + 1, z = Math.floor(base.z) + 1;
    for (let y = 127; y >= 1; y--) {
      if (BLOCKS[this.world.getBlock(x, y - 1, z)]?.collidable && !BLOCKS[this.world.getBlock(x, y, z)].collidable) return { x: x + 0.5, y, z: z + 0.5 };
    }
    return { x: x + 0.5, y: this.worldSpawn?.y ?? 80, z: z + 0.5 };
  }

  // Build a host-side Player entity for a joining client (restore record if returning).
  createNetPlayer(client, rec) {
    const p = new Player(this.world);
    p.isNetPlayer = true;
    p.netName = client.name;
    p.netPlayerId = client.playerId;
    p.hue = client.hue;
    let spawn;
    if (rec && (rec.dimension ?? 0) === this.world.activeDim) {
      p.deserialize(rec);
      spawn = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
    } else {
      if (rec) { p.deserialize(rec); }           // keep inventory/xp, relocate to host dim
      spawn = this.hostSpawnPosFor(rec);
      p.setPos(spawn.x, spawn.y, spawn.z);
      p.prevPos.x = spawn.x; p.prevPos.y = spawn.y; p.prevPos.z = spawn.z;
    }
    p.dim = this.world.activeDim;                 // clients share the host's resident dim
    p.vel.x = p.vel.y = p.vel.z = 0;
    this.entities.add(p);
    client.player = p;
    this.refreshPlayers();
    return spawn;
  }

  serializeNetPlayer(p, client, full = false) {
    const packStacks = arr => arr.map(s => (s ? cloneStack(s) : null));
    const base = {
      health: p.health, hunger: p.foodLevel, saturation: p.saturation, air: p.air,
      fireTicks: p.fireTicks, xpLevel: p.xpLevel, xpPoints: p.xpPoints, xp: currentXp(p),
      gameMode: p.gameMode, effects: serializeEffects(p),
      inventory: packStacks(p.inventory), armor: packStacks(p.armor),
      offhand: p.offhand ? cloneStack(p.offhand) : null, selectedSlot: p.selectedSlot,
      dead: p.dead,
    };
    if (full) return { ...p.serialize(), ...base, name: client?.name ?? p.netName };
    return base;
  }

  removeNetPlayer(player) {
    if (!player) return;
    this.entities.remove(player);
    this.refreshPlayers();
    this.net?.broadcastEntityDespawn?.(player.id, 'removed');
  }

  netStaticFor(e) {
    const t = e.type;
    if (e.isRemotePlayer || t === 'player') {
      return { playerId: e.netPlayerId, name: e.netName, hue: e.hue ?? 0, heldItemId: e.heldStack?.id ?? null };
    }
    if (t === 'item') return { itemId: e.stack?.id, count: e.stack?.count, damage: e.stack?.damage };
    if (t === 'arrow') return { ownerId: e.owner?.id ?? null };
    if (t === 'falling_block') return { blockId: e.blockId };
    if (t === 'primed_tnt') return { fuse: e.fuse };
    if (t === 'xp_orb') return { value: e.value };
    if (t === 'sheep') return { woolColor: e.woolColor ?? 0 };
    return {};
  }

  // ---- host request application (reuses interaction via active-player swap) ----
  hostApplyBlockEdit(client, d) {
    const w = this.world, p = client.player;
    if (d.action === 0) {
      if (w.getBlock(d.x, d.y, d.z) === B.AIR) return false;
      this.withActivePlayer(p, () => this.interaction.breakBlock(d.x, d.y, d.z, {}));
      return true;
    }
    p.selectedSlot = d.hotbarSlot & 7;
    const held = p.heldStack;
    if (!held) return false;
    const hit = { x: d.x, y: d.y, z: d.z, id: w.getBlock(d.x, d.y, d.z), face: indexToFace(d.face), t: 0 };
    this.withActivePlayer(p, () => this.interaction.tryPlace(held, hit, 'main'));
    return true;   // placement is not client-predicted → no revert semantics needed
  }

  hostApplyUseBlock(client, m) {
    const p = client.player, it = this.interaction;
    // audit M2 / §10 — reach-validate a targeted use before opening/actuating.
    if (!m.self) {
      const dist = Math.hypot((m.x + 0.5) - p.pos.x, (m.y + 0.5) - (p.pos.y + p.eyeHeight), (m.z + 0.5) - p.pos.z);
      if (dist > (p.creative ? 5.2 : 4.5) + 0.5) return;
    }
    const prevHit = it.currentHit, prevActor = this._netActor;
    this._netActor = client;
    it._activePlayer = p;
    try {
      if (m.self) it.currentHit = null;
      else {
        p.selectedSlot = (m.hotbarSlot ?? 0) & 7;
        it.currentHit = { x: m.x, y: m.y, z: m.z, id: this.world.getBlock(m.x, m.y, m.z), face: indexToFace(m.face), t: 0 };
      }
      const input = {
        pressed: new Set(), shift: p.sneaking, ctrl: false, hotbar: -1, wheel: 0,
        middlePressed: false, rightPressed: true, mouseRight: true, mouseLeft: false,
        leftPressed: false, forward: 0, strafe: 0, jump: false, sneak: p.sneaking, sprintKey: false,
      };
      it.use(input);
    } finally { it.currentHit = prevHit; it._activePlayer = null; this._netActor = prevActor; }
  }

  hostApplyAttack(client, m) {
    const target = this.entities.entities.get(m.target);
    if (!target || target.dead || !(target instanceof LivingEntity)) return;
    const p = client.player;
    const eye = { x: p.pos.x, y: p.pos.y + p.eyeHeight, z: p.pos.z };
    const bb = target.getAABB();
    const cx = Math.max(bb.min[0], Math.min(eye.x, bb.max[0]));
    const cy = Math.max(bb.min[1], Math.min(eye.y, bb.max[1]));
    const cz = Math.max(bb.min[2], Math.min(eye.z, bb.max[2]));
    const dist = Math.hypot(cx - eye.x, cy - eye.y, cz - eye.z);
    if (dist > 4.5 + 0.5) return;                 // §7.3 generous reach
    this.withActivePlayer(p, () => this.interaction.attack(target));
    this.net?.broadcastHurt?.(target.id, 0, client.playerId);
  }

  hostApplyDrop(client, m) {
    this.withActivePlayer(client.player, () => this.interaction.dropHeld(!!m.stack));
  }

  hostRespawnPlayer(client) {
    const p = client.player;
    p.respawn(this.worldSpawn);
    p.dim = this.world.activeDim;
    if (!this.entities.entities.has(p.id)) this.entities.add(p);   // re-add if it was ever reaped
    this.refreshPlayers();
    this.net?.sendForceMove?.(client, { x: p.pos.x, y: p.pos.y, z: p.pos.z }, p.yaw, p.pitch);
    this.net?._sendPlayerState?.(client, true);
  }

  // ---------------------------------------------------------------- net containers (chest-class)
  hostOpenNetContainer(client, kind, x, y, z) {
    // Only "storage" containers replicate (chest/dispenser/dropper/hopper/shulker/furnace).
    const be = this.getBlockEntity(x, y, z);
    if (!be?.data?.slots) return;
    const windowId = (client._winSeq = (client._winSeq || 0) + 1);
    client.window = { id: windowId, kind, x, y, z, be, cursor: null };
    this.net?._jsonTo?.(client.slot, {
      t: 'containerOpen', windowId, kind, pos: { x, y, z },
      slots: be.data.slots.map(s => s ? cloneStack(s) : null),
      inv: client.player.inventory.map(s => s ? cloneStack(s) : null),
    });
  }

  hostContainerClick(client, m) {
    const win = client.window;
    if (!win || win.id !== m.windowId) return;
    if (this.world.getBlock(win.x, win.y, win.z) === B.AIR) { this.hostContainerClose(client); return; }
    applyNetContainerClick(win, client.player, m, ITEMS);
    win.be.modified = true;
    const slotsCopy = () => win.be.data.slots.map(s => s ? cloneStack(s) : null);
    // reflect the full authoritative state to the CLICKER (cursor + inv + slots),
    // echoing actionId so a predictive client could match its rollback (§6).
    this.net?._jsonTo?.(client.slot, {
      t: 'containerResult', windowId: win.id, actionId: m.actionId, cursor: win.cursor,
      slots: slotsCopy(), inv: client.player.inventory.map(s => s ? cloneStack(s) : null),
    });
    // audit M6 — OTHER viewers get slot-only updates (no cursor/inv), so their own
    // predicted cursor + inventory are not clobbered by another player's click.
    if (this.net?.isHost) for (const c of this.net.clients.values()) {
      if (c !== client && c.window && c.window.x === win.x && c.window.y === win.y && c.window.z === win.z) {
        this.net._jsonTo(c.slot, { t: 'containerResult', windowId: c.window.id, slots: slotsCopy() });
      }
    }
  }

  hostContainerClose(client) {
    const win = client.window;
    if (!win) return;
    if (win.cursor) {
      const left = client.player.give(win.cursor);
      if (left > 0) { win.cursor.count = left; this.dropStackAt(win.cursor, client.player.pos.x, client.player.pos.y + 0.6, client.player.pos.z); }
      win.cursor = null;
    }
    client.window = null;
  }

  // ---------------------------------------------------------------- CLIENT session
  async startClientWorld(welcome, net) {
    this.disposeWorld();
    this.net = net;
    this.world = new World(welcome.seed);
    this.world.game = this;
    this.world.time = welcome.worldTime ?? 0;
    this.chunkManager = new ChunkManager(this.world, this.scene, this.materials, this.atlas.tileUV);
    this.chunkManager.game = this;
    this.chunkManager.netClient = true;         // no terrain workers; chunks arrive over the wire
    this.chunkManager.loading = true;
    this.world.chunkManager = this.chunkManager;
    this.entities = new EntityManager(this.world, this.scene);
    this.player = new Player(this.world);
    if (welcome.you) this.player.deserialize(welcome.you);
    if (welcome.spawnPos) { this.player.setPos(welcome.spawnPos.x, welcome.spawnPos.y, welcome.spawnPos.z); this.player.prevPos.x = welcome.spawnPos.x; this.player.prevPos.y = welcome.spawnPos.y; this.player.prevPos.z = welcome.spawnPos.z; }
    this.player.isLocalNetPlayer = true;
    this.entities.add(this.player);
    this.players = [this.player];
    this.interaction = new Interaction(this);
    this.dayNight = new DayNight(this);
    this.dayNight.deserialize?.(welcome.weather);
    this.particles = new Particles(this.scene);
    // client is in the host's active dim
    const desc = getDimension(welcome.dim ?? 0) ?? getDimension(0);
    this.world.activeDim = welcome.dim ?? 0;
    this.world.hasSkyLight = desc.hasSkyLight;
    this.dimMeta = {};
    this.setState(STATE.CONNECTING);
  }

  // physics tick used by the client predictor (03 §4 pipeline verbatim)
  tickClientPlayer(player, frame) { player.tick(frame); }

  clientTick() {
    const frame = (this.state === STATE.PLAYING && !this.sleeping) ? this.input.snapshot() : (this.input.snapshot(), NEUTRAL_FRAME);
    // predict + interaction (block-edit prediction) happen inside net.clientTick
    this.net.clientTick(frame);
    if (this.state === STATE.PLAYING) this.interaction.tick(frame);
    // 14 §1.1 — visual worldTime advance between syncs (host snaps it via timeSync).
    if (this.state === STATE.PLAYING) {
      this.world.time++;
      this.world.skyDarken = this.dayNight.computeSkyDarken(this.world.time);
    }
    // LOADING→PLAYING gate is driven by NetClient (spawnReady → spawnConfirm).
  }

  createPuppet(typeName, rec, staticData) {
    const st = staticData || {};
    if (typeName === 'player') {
      const info = this.net?.players?.get?.(st.playerId) || {};
      const pl = new RemotePlayer(this.world, {
        playerId: st.playerId || info.playerId, name: st.name || info.name || 'Player',
        hue: st.hue ?? info.hue ?? 0, slot: info.slot ?? 0, entityId: rec.id,
      });
      pl.heldItemId = st.heldItemId ?? null;
      pl.dim = this.world.activeDim;
      return pl;
    }
    // mob / item / projectile puppet — build via the real class for correct visuals,
    // but it never ticks AI (the client runs no world sim) and takes no local damage.
    let e = null;
    if (typeName === 'item') e = new ItemEntity(this.world, rec.x, rec.y, rec.z, { id: st.itemId ?? 1, count: st.count ?? 1, damage: st.damage }, 0);
    else if (typeName === 'xp_orb') e = new XpOrb(this.world, rec.x, rec.y, rec.z, st.value ?? 1);
    else if (typeName === 'primed_tnt') e = new PrimedTnt(this.world, rec.x, rec.y, rec.z, st.fuse ?? 80);
    else if (typeName === 'falling_block') e = new FallingBlock(this.world, st.blockId ?? 1, rec.x, rec.y, rec.z);
    else if (typeName === 'arrow') e = new Arrow(this.world, rec.x, rec.y, rec.z, 0, 0, 0, null);
    else e = createMob(this.world, typeName, rec.x, rec.y, rec.z, {});
    if (e) { e.isPuppet = true; e.beforeHurt = () => false; e.tick = () => {}; if (e.isBaby !== undefined && rec.stateByte & 1) { /* baby via stateByte */ } }
    return e;
  }

  clientDimChange(m) {
    // wipe chunks + entities and restream the new dim (§3.3 dimChange)
    this.net.interp.clear();
    this.net.puppets.clear();
    this.net.staticData.clear();
    for (const e of [...this.entities.entities.values()]) if (e !== this.player) this.entities.remove(e);
    this.chunkManager.flushAllChunks();
    const desc = getDimension(m.dim ?? 0) ?? getDimension(0);
    this.world.activeDim = m.dim ?? 0;
    this.world.hasSkyLight = desc.hasSkyLight;
    if (m.spawnPos) { this.player.setPos(m.spawnPos.x, m.spawnPos.y, m.spawnPos.z); this.player.prevPos.x = m.spawnPos.x; this.player.prevPos.y = m.spawnPos.y; this.player.prevPos.z = m.spawnPos.z; }
    this.chunkManager.loading = true;
    this.setState(STATE.CONNECTING);
  }
}

// ---- headless container click applier (14 §6, chest-class; no dupes, host-authoritative) ----
function applyNetContainerClick(win, player, m, ITEMS) {
  const slots = win.be.data.slots;
  const inv = player.inventory;
  const stackMax = s => (s ? (ITEMS.get(s.id)?.stack ?? 64) : 64);
  const region = m.region === 'inv' ? inv : slots;
  const i = m.slotIndex | 0;
  if (i < 0 || i >= region.length) return;
  const same = (a, b) => a && b && a.id === b.id && (a.damage ?? 0) === (b.damage ?? 0);
  if (m.button === 2) {                            // right click
    if (!win.cursor) {                             // split half to cursor
      const s = region[i];
      if (s && s.count > 0) { const half = Math.ceil(s.count / 2); win.cursor = { ...s, count: half }; s.count -= half; if (s.count <= 0) region[i] = null; }
    } else {                                        // drop one
      const s = region[i];
      if (!s) { region[i] = { ...win.cursor, count: 1 }; if (--win.cursor.count <= 0) win.cursor = null; }
      else if (same(s, win.cursor) && s.count < stackMax(s)) { s.count++; if (--win.cursor.count <= 0) win.cursor = null; }
    }
    return;
  }
  // left click / shift
  if (m.shift) {                                   // shift-move whole stack across regions
    const s = region[i]; if (!s) return;
    const dest = region === inv ? slots : inv;
    // merge then fill empties (lowest slot wins)
    for (let k = 0; k < dest.length && s.count > 0; k++) { const d = dest[k]; if (d && same(d, s) && d.count < stackMax(d)) { const add = Math.min(stackMax(d) - d.count, s.count); d.count += add; s.count -= add; } }
    for (let k = 0; k < dest.length && s.count > 0; k++) { if (!dest[k]) { dest[k] = { ...s }; s.count = 0; } }
    if (s.count <= 0) region[i] = null;
    return;
  }
  const s = region[i];
  if (!win.cursor) { if (s) { win.cursor = s; region[i] = null; } return; }
  if (!s) { region[i] = win.cursor; win.cursor = null; return; }
  if (same(s, win.cursor)) { const add = Math.min(stackMax(s) - s.count, win.cursor.count); s.count += add; win.cursor.count -= add; if (win.cursor.count <= 0) win.cursor = null; return; }
  const tmp = region[i]; region[i] = win.cursor; win.cursor = tmp;   // swap
}
