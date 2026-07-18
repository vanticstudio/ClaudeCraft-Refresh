// Game: fixed-timestep loop, system wiring, screen state machine (01 §3, §15).
import * as THREE from 'three';
import {
  MS_PER_TICK, MAX_TICKS_PER_FRAME, STATE, AUTOSAVE_INTERVAL, chunkKey, SIM_RADIUS,
} from './constants.js';
import { BLOCKS, B, blockByName, FACING_DIR, WATERLOGGED } from './registry/blocks.js';
import { ITEMS, idOf, SMELTING, fuelValue } from './registry/items.js';
import { cloneStack } from './items/tags.js';
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
import { RedstoneContainers } from './redstone/containersRedstone.js';
import { getDimension } from './world/dimensions.js';
import { findOrCreatePortal } from './world/Portal.js';
import { installNetherBehaviors, tickSpawner } from './world/nether.js';
import { tickBrewing } from './world/brewing.js';
import { addEffect as engineAddEffect, applyInstant as engineApplyInstant } from './status/effects.js';

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
    this.debug = { fps: 0, frameMs: 0, remeshCount: 0, lastRemeshes: 0, audioMs: 0 };
    this._fpsWindow = [];

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
    this.world.chunkManager = this.chunkManager;
    this.entities = new EntityManager(this.world, this.scene);
    this.player = new Player(this.world);
    this.entities.add(this.player);
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

    if (savedMeta) {
      this.world.time = savedMeta.worldTime ?? 0;
      this.dayNight.deserialize(savedMeta.weather);
      this.player.deserialize(savedMeta.player);
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
    if (this.chunkManager) {
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

    const t0 = performance.now();
    if (this.state === STATE.PLAYING || this.state === STATE.PLAYING_UI ||
        this.state === STATE.LOADING || this.state === STATE.DEAD) {
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
    const tickStart = performance.now();

    const playing = this.state === STATE.PLAYING;
    const frame = playing && !this.sleeping ? this.input.snapshot() : (this.input.snapshot(), NEUTRAL_FRAME);

    if (this.state !== STATE.LOADING) {
      // 07 §5.2 — process any dust-solve seeds carried over from last tick,
      // before this tick's player/entity edits queue more.
      this.redstoneContainers?.clearTickGuards();
      this.redstone?.drainAtTickStart();
      this.player.tick(frame);
      this.interaction.tick(frame);
      this.entities.tick(this.player);
      // 07 §6.3 — pressure-plate presses are entity-driven; scan after entities
      // move (the player is in the manager, so this covers them too).
      this.redstoneComponents?.tickPlates(this.entities.entities.values());
      this.world.scheduled.run();
      this.world.randomTicks();
      this.dayNight.tick();
      this.mobSpawner?.tick();
      this.tickVillages();
    }
    this.chunkManager.tick(this.player.pos.x, this.player.pos.z);
    if (this.state !== STATE.LOADING) {
      this.tickBlockEntities();
      this.tickSleep();
    }
    this.save?.tick(this);
    this.audio?.tick();                 // AMENDS 01 §3 tick step 10
    this.atlas.animate?.(this.world.time);
    this.ui?.containers?.tickOpen?.();

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
        } else {
          this.snapPlayerToGround();
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
    this.updateCamera(alpha);
    this.audio?.updateFrame(this.camera);   // AMENDS 01 §3 render step 6
    this.debug.audioMs = this.audio?.debug.budgetMs ?? 0;
    this.dayNight.updateRender(alpha, this.camera);
    this.entities.updateRender(alpha, this.player);
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

    this.camera.position.set(px + rightX * bobR, py + bobY, pz + rightZ * bobR);
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
        }
      }
    }
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
    const data = be.data;
    if (data?.slots) {
      for (const s of data.slots) if (s) this.dropStackAt(s, x + 0.5, y + 0.5, z + 0.5);
      data.slots.fill(null);
    }
    if (data?.xpBank >= 1) this.spawnXpOrb(x + 0.5, y + 0.5, z + 0.5, Math.floor(data.xpBank));
  }

  // ---------------------------------------------------------------- explosions (05 §12)

  explode(x, y, z, power) {
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
            const blast = (state & WATERLOGGED) ? Math.max(blk.blast, 100) : blk.blast;
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
    p.spawnPoint = { x, y, z };            // always set on click (06 §5.7)
    if (!this.dayNight.canSleepNow()) {
      this.toast('You can only sleep at night');
      return;
    }
    const hostiles = this.entities.getEntitiesInBox(
      new AABB(x - 8, y - 5, z - 8, x + 9, y + 6, z + 9),
      e => HOSTILE_TYPES.has(e.type));
    if (hostiles.length > 0) {
      this.toast('You may not rest now; there are monsters nearby');
      return;
    }
    this.sleeping = { ticks: 0 };
    this.ui?.setSleepFade?.(true);
  }

  tickSleep() {
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

  onPlayerDeath() {
    document.exitPointerLock?.();
    this.setState(STATE.DEAD);
  }

  respawnPlayer() {
    this.player.respawn(this.worldSpawn);
    this.setState(STATE.PLAYING);
    this.input.requestLock();
  }

  toast(msg) { this.ui?.toast?.(msg); }

  openContainer(kind, x, y, z) {
    this.ui?.containers?.open?.(kind, x, y, z);
  }
}
