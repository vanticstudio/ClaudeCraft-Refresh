// Game: fixed-timestep loop, system wiring, screen state machine (01 §3, §15).
import * as THREE from 'three';
import {
  MS_PER_TICK, MAX_TICKS_PER_FRAME, STATE, AUTOSAVE_INTERVAL, chunkKey, SIM_RADIUS,
} from './constants.js';
import { BLOCKS, B, blockByName, FACING_DIR } from './registry/blocks.js';
import { ITEMS, idOf, SMELTING, fuelValue } from './registry/items.js';
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
import { LivingEntity, lerp, lerpAngle } from './entities/Entity.js';
import { Interaction } from './player/interaction.js';
import { placeTree } from './world/gen/features.js';
import { hasLineOfSight } from './world/raycast.js';
import { DayNight } from './env/DayNight.js';
import { Particles } from './render/Particles.js';
import { AABB } from './math/aabb.js';
import { createMob, MobSpawner, HOSTILE_TYPES } from './entities/mobs/index.js';

const NEUTRAL_FRAME = {
  forward: 0, strafe: 0, jump: false, sneak: false, sprintKey: false,
  mouseLeft: false, mouseRight: false, leftPressed: false, rightPressed: false,
  middlePressed: false, pressed: new Set(), wheel: 0, hotbar: -1, shift: false,
};

export class Game {
  constructor({ canvas, input, renderer, camera, viewmodelCamera, atlas, ui }) {
    this.canvas = canvas;
    this.input = input;
    this.renderer = renderer;
    this.camera = camera;
    this.viewmodelCamera = viewmodelCamera;
    this.atlas = atlas;                 // { canvas, texture, TILE, tileUV, animate, atlasDataURL }
    this.ui = ui;                       // wired by main.js after UI construction

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
    this.debug = { fps: 0, frameMs: 0, remeshCount: 0, lastRemeshes: 0 };
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
    this.dayNight = new DayNight(this);
    this.particles = new Particles(this.scene);
    this.mobSpawner = new MobSpawner(this);

    if (savedMeta) {
      this.world.time = savedMeta.worldTime ?? 0;
      this.dayNight.deserialize(savedMeta.weather);
      this.player.deserialize(savedMeta.player);
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
      this.player.tick(frame);
      this.interaction.tick(frame);
      this.entities.tick(this.player);
      this.world.scheduled.run();
      this.world.randomTicks();
      this.dayNight.tick();
      this.mobSpawner?.tick();
    }
    this.chunkManager.tick(this.player.pos.x, this.player.pos.z);
    if (this.state !== STATE.LOADING) {
      this.tickBlockEntities();
      this.tickSleep();
    }
    this.save?.tick(this);
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
        this.snapPlayerToGround();
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

  // ---------------------------------------------------------------- rendering

  render(alpha) {
    this.renderer.clear(true, true, true);
    if (!this.world || this.state === STATE.TITLE) return;

    this.debug.lastRemeshes = this.chunkManager.drainRemesh(this.player.pos.x, this.player.pos.z);
    this.updateCamera(alpha);
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

  updateCamera(alpha) {
    const p = this.player;
    const px = lerp(p.prevPos.x, p.pos.x, alpha);
    const py = lerp(p.prevPos.y + p.prevEyeHeight, p.pos.y + p.eyeHeight, alpha);
    const pz = lerp(p.prevPos.z, p.pos.z, alpha);

    // view bobbing (03 §18.4)
    const phase = lerp(p.prevBobPhase, p.bobPhase, alpha);
    const inten = lerp(p.prevBobIntensity, p.bobIntensity, alpha);
    const bobY = Math.abs(Math.cos(phase)) * 0.05 * inten;
    const bobR = Math.sin(phase) * 0.025 * inten;
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
    if (id !== vm.itemId) {
      vm.itemId = id;
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
    // brightness follows the player's light
    const ls = this.player.lightScalar;
    vm.group.traverse(o => {
      if (o.isMesh && o.material?.userData?.baseColor) o.material.color.setRGB(ls, ls, ls);
    });
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
      be = kind === 'chest'
        ? { type: 'chest', data: { slots: new Array(27).fill(null) } }
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
          if (be.type !== 'furnace') continue;
          const x = chunk.cx * 16 + (i & 15), y = i >> 8, z = chunk.cz * 16 + ((i >> 4) & 15);
          this.tickFurnace(be.data, x, y, z, chunk);
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
            const strength = power * (0.7 + 0.6 * rng()) * (1 - r / (1.3 * power));
            if (strength <= (blk.blast + 0.3) * 0.3) continue;
            if (id === B.TNT) {
              world.setBlock(bx, by, bz, B.AIR);
              this.igniteTnt(bx, by, bz, 10 + Math.floor(rng() * 21));
              continue;
            }
            const state = world.getState(bx, by, bz);
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
      e.vel.x += (cx - x) / len * impact;
      e.vel.y += (cy - y) / len * impact;
      e.vel.z += (cz - z) / len * impact;
    }
    this.particles?.explosion?.(x, y, z, power);
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
    const e = new ItemEntity(this.world, x, y, z, { ...stack }, 40);
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
      p.pos.x, p.pos.y + p.eyeHeight - 0.3, p.pos.z, { ...stack }, 40);
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

  spawnFallingBlock(id, x, y, z) {
    return this.entities.add(new FallingBlock(this.world, id, x + 0.5, y, z + 0.5));
  }

  igniteTnt(x, y, z, fuse = 80) {
    if (this.world.getBlock(x, y, z) === B.TNT) this.world.setBlock(x, y, z, B.AIR);
    return this.entities.add(new PrimedTnt(this.world, x + 0.5, y, z + 0.5, fuse));
  }

  spawnMobAt(type, x, y, z, opts = {}) {
    const mob = createMob(this.world, type, x, y, z, opts);
    if (!mob) return null;
    return this.entities.add(mob);
  }

  onChunkGenerated(chunk) {
    if (chunk.pendingSpawns && !chunk.spawnsDone) {
      for (const rec of chunk.pendingSpawns) {
        this.spawnMobAt(rec.type, rec.x, rec.y, rec.z, { persistent: true });
      }
      chunk.spawnsDone = true;
      chunk.pendingSpawns = null;
      chunk.modified = true;
    }
  }

  onChunkHydrated(chunk, record) {
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
    if (rec.type === 'item') e = ItemEntity.deserialize(this.world, rec);
    else if (rec.type === 'primed_tnt') e = PrimedTnt.deserialize(this.world, rec);
    else if (rec.type === 'xp_orb') { e = new XpOrb(this.world, rec.pos[0], rec.pos[1], rec.pos[2], rec.value); }
    else {
      e = createMob(this.world, rec.type, rec.pos[0], rec.pos[1], rec.pos[2], {});
      if (e) e.deserialize(rec);
    }
    if (e) this.entities.add(e);
  }

  onChunkUnloading(chunk) {
    this.entities.onChunkUnloading(chunk, this.player);
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
