// Tiny cube-sprite particles (01 §2): block break, crit stars, explosion puffs,
// hearts, teleport motes.
//
// Internals are pooled + instanced: three shared InstancedMesh pools live for
// the app lifetime — colored boxes (per-instance RGB via instanceColor), atlas
// debris cubes (per-instance per-face atlas rects injected through
// onBeforeCompile), and the sweep arc (per-instance opacity) — and every spawn
// claims a slot from a free list instead of minting a Mesh + Material. Zero
// per-particle allocations in the hot paths: records recycle, matrices/colors
// go through module scratch objects.
//
// Simulation stays exactly where 05 §16.3 put it: update() integrates ONE tick
// in blocks/tick off the 20 Hz clock (gravity, damping, lifetimes, the sweep
// scale/alpha envelope) and is the only place time advances. Each record keeps
// its previous-tick position; render(alpha, camera) (or the pools' own
// onBeforeRender hook, which measures the tick fraction from the wall clock)
// lerps prev→cur into the instance matrices, so motion is smooth at any
// framerate without ever stepping the simulation twice.
import * as THREE from 'three';
import { BLOCKS } from '../registry/blocks.js';
import { EFFECT_META } from '../status/effects.js';
const EFFECT_META_COLOR = id => EFFECT_META[id]?.color ?? 0xffffff;
import { blockCubeGeometry, makeAtlasMaterial } from '../entities/ItemEntity.js';

const MAX = 1024;
const TICK_MS = 50;                     // 20 Hz tick domain (05 §16.3)

const POOL_COLOR = 0, POOL_DEBRIS = 1, POOL_SWEEP = 2;

// Scratch — reused by every matrix/color write; nothing here is per particle.
const _mat = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _UP = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();
const _colA = new THREE.Color();        // emitter-side scratch (distinct from _col)
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

// 08 §6.4 — the sweep arc tile: 24×6 px, a flat white crescent. Procedural like
// every other texture in the build (CLAUDE.md §6); built once, module-cached
// and never disposed (the sweep material references it for the app lifetime).
let SWEEP_TEX = null;
function sweepTexture() {
  if (SWEEP_TEX) return SWEEP_TEX;
  const c = document.createElement('canvas');
  c.width = 24; c.height = 6;
  const g = c.getContext('2d');
  g.strokeStyle = '#ffffff';
  g.lineWidth = 1.6;
  g.lineCap = 'round';
  g.beginPath();
  // Shallow crescent: an ellipse arc whose centre sits below the tile, so only
  // the upper sliver lands inside the 6 rows — spans x≈1..23, y≈1..6.
  g.ellipse(12, 7.5, 11, 6.5, 0, Math.PI * 1.08, Math.PI * 1.92);
  g.stroke();
  SWEEP_TEX = new THREE.CanvasTexture(c);
  SWEEP_TEX.magFilter = THREE.NearestFilter;
  SWEEP_TEX.minFilter = THREE.NearestFilter;
  return SWEEP_TEX;
}

export class Particles {
  constructor(scene) {
    this.scene = scene;
    this.active = [];
    this.colorGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    // Baked flat so the arc needs only a single yaw rotation at spawn — setting
    // rotation.x and rotation.z together would depend on Euler order.
    this.sweepGeo = new THREE.PlaneGeometry(1, 0.25);
    this.sweepGeo.rotateX(-Math.PI / 2);
    // 01 §17.2 — ONE pure atlas material, kept for the public atlasMat() API.
    // The debris pool builds its own instance (patched with per-instance atlas
    // rects, below) so this one stays unpatched for any direct consumer.
    // Lazy because ATLAS is wired at boot.
    this._atlasMat = null;
    this._density = 1;
    this._lastTick = 0;
    this._manualRender = false;
    this._recFree = [];                   // pooled particle records
    this._pools = [null, null, null];     // built lazily on first use
    this._rectCache = new Map();          // blockId → 6 atlas rects (Float32Array(24))
  }

  atlasMat() {
    if (!this._atlasMat) {
      this._atlasMat = makeAtlasMaterial();
      this._atlasMat.userData.shared = true;   // the disposal predicates opt out on this
    }
    return this._atlasMat;
  }

  /**
   * Cosmetic density multiplier (0..1): every emitter's spawn COUNT scales by
   * it. A count that would round to zero still emits exactly one particle —
   * an emitter that fires at all stays visible — except at density 0, which
   * suppresses particles entirely (the performance floor).
   */
  setDensity(mult) {
    this._density = Math.min(1, Math.max(0, Number(mult) || 0));
  }

  _n(base) {
    const d = this._density;
    if (d >= 1) return base;
    if (d <= 0) return 0;
    return Math.max(1, Math.round(base * d));
  }

  // ---- pool machinery ------------------------------------------------------

  // Lazily builds one of the three shared pools. The free list is initialised
  // descending so pop() hands out slot 0 first and the drawn instance count
  // (the high-water mark) grows only with real usage.
  _pool(i) {
    let pool = this._pools[i];
    if (pool) return pool;
    const free = [];
    for (let s = MAX - 1; s >= 0; s--) free.push(s);
    let mesh, geo = null, mat;
    if (i === POOL_COLOR) {
      // Per-instance RGB rides instanceColor (setColorAt). instanceColor has no
      // alpha channel, and nothing colored fades by opacity today — the only
      // alpha/scale envelope user is the sweep, on its own pool below.
      mat = new THREE.MeshBasicMaterial();
      mesh = new THREE.InstancedMesh(this.colorGeo, mat, MAX);
    } else if (i === POOL_DEBRIS) {
      // One cube for every block: per-vertex aFace (0..5, BoxGeometry face
      // order +X −X +Y −Y +Z −Z, same order the registry's tileIndex uses) plus
      // per-instance atlas rects select each face's tile in the shader — the
      // same per-face mapping blockCubeGeometry bakes, without per-block
      // geometry. Feet at y=0 like blockCubeGeometry (translate size/2).
      geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
      geo.translate(0, 0.05, 0);
      const faces = new Float32Array(24);
      for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) faces[f * 4 + v] = f;
      geo.setAttribute('aFace', new THREE.BufferAttribute(faces, 1));
      mat = makeAtlasMaterial();
      mat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>',
            '#include <common>\nattribute float aFace;\nattribute vec4 aRect0;\nattribute vec4 aRect1;\nattribute vec4 aRect2;\nattribute vec4 aRect3;\nattribute vec4 aRect4;\nattribute vec4 aRect5;')
          .replace('#include <uv_vertex>', `#include <uv_vertex>
	#ifdef USE_MAP
	vec4 _pr = aRect0;
	if (aFace > 0.5) _pr = aRect1;
	if (aFace > 1.5) _pr = aRect2;
	if (aFace > 2.5) _pr = aRect3;
	if (aFace > 3.5) _pr = aRect4;
	if (aFace > 4.5) _pr = aRect5;
	vMapUv = vec2(mix(_pr.x, _pr.z, uv.x), mix(_pr.y, _pr.w, 1.0 - uv.y));
	#endif`);
      };
      mesh = new THREE.InstancedMesh(geo, mat, MAX);
    } else {
      // The sweep arc keeps its per-particle opacity — instanceColor can't
      // carry alpha, so a tiny per-instance float rides the patched basic
      // material instead (identical blending/depth rules as the old material).
      mat = new THREE.MeshBasicMaterial({
        map: sweepTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide,
      });
      mat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float aOpacity;\nvarying float vOp;')
          .replace('#include <uv_vertex>', '#include <uv_vertex>\nvOp = aOpacity;');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vOp;')
          .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vOp;');
      };
      mesh = new THREE.InstancedMesh(this.sweepGeo, mat, MAX);
    }
    // Instances span the whole world; a per-object frustum test would wrongly
    // cull the pool whenever its (origin-centred) bounds leave the frustum.
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Every slot starts hidden: a zero-scale matrix collapses each cube to a
    // point (degenerate triangles rasterise nothing). The constructor's raw
    // zero-filled matrices would be homogeneous-zero — undefined after divide.
    for (let s = 0; s < MAX; s++) mesh.setMatrixAt(s, _zero);
    pool = { index: i, mesh, mat, geo, free, live: 0, hw: 0, flushFrame: -1, rects: null, op: null };
    if (i === POOL_DEBRIS) {
      pool.rects = [];
      for (let k = 0; k < 6; k++) {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
        a.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('aRect' + k, a);
        pool.rects.push(a);
      }
    } else if (i === POOL_SWEEP) {
      const op = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
      op.setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.setAttribute('aOpacity', op);
      pool.op = op;
    } else {
      for (let s = 0; s < MAX; s++) mesh.setColorAt(s, _col.set(1, 1, 1));
    }
    // Render-domain interpolation without any Game.js wiring: when the
    // renderer draws a pool, refresh its matrices against the tick fraction.
    mesh.onBeforeRender = (renderer) => this._autoFlush(pool, renderer);
    this._pools[i] = pool;
    this.scene.add(mesh);
    return pool;
  }

  // Claims one instance slot (global MAX enforced up front, before anything is
  // allocated) or returns -1 at the cap.
  _alloc(pool) {
    if (this.active.length >= MAX) return -1;
    const slot = pool.free.pop();
    if (slot === undefined) return -1;
    if (slot >= pool.hw) { pool.hw = slot + 1; pool.mesh.count = pool.hw; }
    pool.live++;
    return slot;
  }

  // Fixed-shape record, every field assigned, so recycled records never leak
  // one emitter's envelope state into another's.
  _newRec() {
    const r = this._recFree.pop();
    if (r) {
      r.pool = 0; r.slot = 0; r.mesh = null;
      r.x = 0; r.y = 0; r.z = 0; r.px = 0; r.py = 0; r.pz = 0;
      r.vx = 0; r.vy = 0; r.vz = 0; r.gravity = 0;
      r.life = 0; r.maxLife = 0;
      r.curScale = 1; r.yaw = 0; r.opacity = 1;
      r.scale0 = undefined; r.scale1 = undefined; r.alpha0 = undefined;
      return r;
    }
    return {
      pool: 0, slot: 0, mesh: null,
      x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0,
      vx: 0, vy: 0, vz: 0, gravity: 0,
      life: 0, maxLife: 0,
      curScale: 1, yaw: 0, opacity: 1,
      scale0: undefined, scale1: undefined, alpha0: undefined,
    };
  }

  // Expiry: release the instance slot (hidden with a zero-scale matrix —
  // degenerate triangles rasterise nothing) and recycle the record. Legacy
  // mesh records leave the scene exactly as the old expiry path did.
  _killRec(i) {
    const p = this.active[i];
    if (p.pool >= 0) {
      const pool = this._pools[p.pool];
      pool.mesh.setMatrixAt(p.slot, _zero);
      pool.mesh.instanceMatrix.needsUpdate = true;
      if (p.pool === POOL_SWEEP) { pool.op.setX(p.slot, 0); pool.op.needsUpdate = true; }
      pool.free.push(p.slot);
      pool.live--;
    } else {
      this.scene.remove(p.mesh);
      // `userData.shared`, not "has a map": makeAtlasMaterial() mints a NEW
      // material per call, so the old map!=null proxy for "shared" silently
      // skipped 16 live materials per broken block. Only atlasMat() opts out.
      if (p.mesh.material.userData?.shared !== true) p.mesh.material.dispose();
    }
    this.active[i] = this.active[this.active.length - 1];
    this.active.pop();
    this._recFree.push(p);
  }

  _writeMatrix(pool, rec) {
    _pos.set(rec.x, rec.y, rec.z);
    if (rec.yaw) _quat.setFromAxisAngle(_UP, rec.yaw); else _quat.identity();
    _scl.setScalar(rec.curScale);
    _mat.compose(_pos, _quat, _scl);
    pool.mesh.setMatrixAt(rec.slot, _mat);
    pool.mesh.instanceMatrix.needsUpdate = true;
  }

  // Writes every live instance of one pool: position lerped prev→cur by the
  // tick fraction, plus the tick-domain scale envelope. Idempotent — safe to
  // run from both update() and every render pass.
  _flushPool(pool, alpha) {
    if (pool.live === 0) return;
    const act = this.active;
    for (let i = 0; i < act.length; i++) {
      const p = act[i];
      if (p.pool !== pool.index) continue;
      _pos.set(p.px + (p.x - p.px) * alpha, p.py + (p.y - p.py) * alpha, p.pz + (p.z - p.pz) * alpha);
      if (p.yaw) _quat.setFromAxisAngle(_UP, p.yaw); else _quat.identity();
      _scl.setScalar(p.curScale);
      _mat.compose(_pos, _quat, _scl);
      pool.mesh.setMatrixAt(p.slot, _mat);
    }
    pool.mesh.instanceMatrix.needsUpdate = true;
  }

  // onBeforeRender hook: once per render() call per pool, refresh matrices
  // with the wall-clock tick fraction. Manual render(alpha) calls take over.
  _autoFlush(pool, renderer) {
    if (this._manualRender) return;
    const frame = renderer.info ? renderer.info.render.frame : 0;
    if (pool.flushFrame === frame) return;
    pool.flushFrame = frame;
    const a = this._lastTick > 0
      ? Math.min(1, Math.max(0, (performance.now() - this._lastTick) / TICK_MS))
      : 1;
    this._flushPool(pool, a);
  }

  // ---- emitters ------------------------------------------------------------

  // opts (all optional, used by sweep()): {scale0, scale1, alpha0}.
  // Absent for every other caller, so their records behave exactly as before.
  // A null handle means the emitter declined at the cap (see colored()).
  // A real THREE.Mesh handed in still takes the legacy per-mesh path.
  spawn(handle, x, y, z, vx, vy, vz, life, gravity = 0.04, opts = null) {
    if (!handle) return;
    if (handle.isMesh) {
      if (this.active.length >= MAX) return;
      handle.position.set(x, y, z);
      const rec = this._newRec();
      rec.pool = -1; rec.mesh = handle;
      rec.x = rec.px = x; rec.y = rec.py = y; rec.z = rec.pz = z;
      rec.vx = vx; rec.vy = vy; rec.vz = vz;
      rec.life = life; rec.gravity = gravity;
      if (opts) { rec.scale0 = opts.scale0; rec.scale1 = opts.scale1; rec.alpha0 = opts.alpha0; rec.maxLife = life; }
      this.active.push(rec);
      this.scene.add(handle);
      return;
    }
    this._spawnColored(handle.color, handle.size, x, y, z, vx, vy, vz, life, gravity, opts);
  }

  _spawnColored(color, size, x, y, z, vx, vy, vz, life, gravity, opts = null) {
    const pool = this._pool(POOL_COLOR);
    const slot = this._alloc(pool);
    if (slot < 0) return;
    const rec = this._newRec();
    rec.pool = POOL_COLOR; rec.slot = slot;
    rec.x = rec.px = x; rec.y = rec.py = y; rec.z = rec.pz = z;
    rec.vx = vx; rec.vy = vy; rec.vz = vz;
    rec.life = life; rec.gravity = gravity;
    rec.curScale = size / 0.1;                    // 0.1 base cube, as before
    if (opts) { rec.scale0 = opts.scale0; rec.scale1 = opts.scale1; rec.alpha0 = opts.alpha0; rec.maxLife = life; }
    pool.mesh.setColorAt(slot, _col.set(color));
    pool.mesh.instanceColor.needsUpdate = true;
    this._writeMatrix(pool, rec);
    this.active.push(rec);
  }

  colored(color, size = 0.1) {
    // The MAX gate lives HERE, not only in spawn(): callers get a null at the
    // cap — the normal state during combat or mining — instead of allocating.
    // The returned handle is a plain descriptor; spawn() turns it into a slot.
    if (this.active.length >= MAX) return null;
    return { pool: POOL_COLOR, color, size };
  }

  // Six atlas rects per blockId, extracted from the module-cached
  // blockCubeGeometry UVs (min/max over each face's four baked corners), so
  // debris keeps the registry's per-face tiles (grass top / dirt sides, logs…).
  _rectsFor(blockId) {
    let rects = this._rectCache.get(blockId);
    if (rects) return rects;
    const uv = blockCubeGeometry(blockId, 0.1).attributes.uv;
    rects = new Float32Array(24);
    for (let f = 0; f < 6; f++) {
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
      for (let i = 0; i < 4; i++) {
        const u = uv.getX(f * 4 + i), v = uv.getY(f * 4 + i);
        if (u < u0) u0 = u; if (u > u1) u1 = u;
        if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      rects[f * 4] = u0; rects[f * 4 + 1] = v0; rects[f * 4 + 2] = u1; rects[f * 4 + 3] = v1;
    }
    this._rectCache.set(blockId, rects);
    return rects;
  }

  _spawnDebris(rects, x, y, z, vx, vy, vz, life) {
    const pool = this._pool(POOL_DEBRIS);
    const slot = this._alloc(pool);
    if (slot < 0) return;
    const rec = this._newRec();
    rec.pool = POOL_DEBRIS; rec.slot = slot;
    rec.x = rec.px = x; rec.y = rec.py = y; rec.z = rec.pz = z;
    rec.vx = vx; rec.vy = vy; rec.vz = vz;
    rec.life = life; rec.gravity = 0.04;
    for (let f = 0; f < 6; f++) pool.rects[f].array.set(rects.subarray(f * 4, f * 4 + 4), slot * 4);
    for (let f = 0; f < 6; f++) pool.rects[f].needsUpdate = true;
    this._writeMatrix(pool, rec);
    this.active.push(rec);
  }

  blockBreak(x, y, z, blockId) {
    const rng = Math.random;
    const rects = this._rectsFor(blockId);
    // B3 §6 — 8–14 debris (was a flat 16): the per-break variance reads as
    // "stuff flying off the block" while the lower ceiling keeps mining combat
    // (blockBreak + crit + sweep in one tick) away from the MAX cap.
    const n = this._n(8 + (rng() * 7) | 0);
    for (let i = 0; i < n; i++) {
      if (this.active.length >= MAX) return;   // same up-front cap as colored()
      const ang = rng() * Math.PI * 2;
      const sp = rng() * 0.1;
      const bx = x + 0.2 + rng() * 0.6, by = y + 0.2 + rng() * 0.6, bz = z + 0.2 + rng() * 0.6;
      this._spawnDebris(rects, bx, by, bz,
        Math.cos(ang) * sp, 0.05 + rng() * 0.1, Math.sin(ang) * sp,
        10 + (rng() * 10) | 0);
    }
  }

  // B3 §6 — place feedback: 4 debris cubes cut from the placed block's own
  // atlas faces, biased upward (the block "pops" into place) and short-lived so
  // build sprees stay cheap. Hooked from interaction.emitPlace, the shared
  // placement-success point (tryPlace / tryPlaceSpecial / plantSeed).
  blockPlace(x, y, z, blockId) {
    const rects = this._rectsFor(blockId);
    const n = this._n(4);
    for (let i = 0; i < n; i++) {
      if (this.active.length >= MAX) return;
      const ang = Math.random() * Math.PI * 2;
      const sp = Math.random() * 0.05;
      this._spawnDebris(rects,
        x + 0.3 + Math.random() * 0.4, y + 0.1 + Math.random() * 0.4, z + 0.3 + Math.random() * 0.4,
        Math.cos(ang) * sp, 0.08 + Math.random() * 0.06, Math.sin(ang) * sp,
        8 + (Math.random() * 6) | 0);
    }
  }

  // B3 §3 — the crit confirm: gold burst at the struck entity's chest, the same
  // 0xffd54a the totem-pop uses (Player.die), so "crit" reads as one idea
  // everywhere. Rides the PUBLIC spawn(colored(...)) channel — the same pattern
  // every entity-side emitter uses (Shulker's trail / pop) — instead of the
  // pool internals; the pool path behind spawn() is unchanged.
  crit(target) {
    const n = this._n(12);
    for (let i = 0; i < n; i++) {
      this.spawn(this.colored(0xffd54a, 0.07),
        target.pos.x + (Math.random() - 0.5) * target.width,
        target.pos.y + target.height * 0.8,
        target.pos.z + (Math.random() - 0.5) * target.width,
        (Math.random() - 0.5) * 0.1, 0.04 + Math.random() * 0.06, (Math.random() - 0.5) * 0.1,
        10 + (Math.random() * 6) | 0, 0.01);
    }
  }

  // 08 §6.4 — one flat white arc quad, 1.7 m in front of the player at hip
  // height, lying horizontally, widening 0.8 → 1.6 m and fading over 6 ticks.
  // `yaw` is the player's yaw; the geometry is pre-laid flat (see constructor).
  sweep(px, py, pz, yaw) {
    if (!this._n(1)) return;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const pool = this._pool(POOL_SWEEP);
    const slot = this._alloc(pool);
    if (slot < 0) return;
    const rec = this._newRec();
    rec.pool = POOL_SWEEP; rec.slot = slot;
    rec.x = rec.px = px + fx * 1.7; rec.y = rec.py = py + 0.9; rec.z = rec.pz = pz + fz * 1.7;
    rec.life = 6; rec.maxLife = 6; rec.gravity = 0;
    rec.scale0 = 0.8; rec.scale1 = 1.6; rec.alpha0 = 0.4;
    rec.curScale = 0.8; rec.yaw = yaw; rec.opacity = 0.4;
    pool.op.setX(slot, 0.4);
    pool.op.needsUpdate = true;
    this._writeMatrix(pool, rec);
    this.active.push(rec);
  }

  explosion(x, y, z, power) {
    // B3 §4 — the blast→shake trigger fires BEFORE the puffs so DayNight's hook
    // (wired onto this instance at its first updateRender) sees the same tick.
    // Optional: unset until DayNight subscribes, never throws without it.
    this.explosionHook?.(x, y, z, power);
    const n = this._n(24);
    for (let i = 0; i < n; i++) {
      const gray = 0.4 + Math.random() * 0.5;
      const ang = Math.random() * Math.PI * 2;
      const up = Math.random();
      const sp = Math.random() * 0.15 * power / 3;
      this._spawnColored(_colA.setRGB(gray, gray, gray), 0.25, x, y, z,
        Math.cos(ang) * sp, up * 0.15, Math.sin(ang) * sp,
        14 + (Math.random() * 10) | 0, 0.002);
    }
  }

  hearts(x, y, z) {
    if (!this._n(1)) return;
    this._spawnColored(0xd0342c, 0.09,
      x + (Math.random() - 0.5) * 0.6, y, z + (Math.random() - 0.5) * 0.6,
      0, 0.03, 0, 16, -0.001);
  }

  // 07-REDSTONE §6.4 — redstone-torch burnout smoke: grey puffs drifting up out
  // of the torch head. Negative gravity is this file's idiom for "rises"
  // (hearts does the same); the pooled expiry path is the shared one.
  smoke(x, y, z) {
    const n = this._n(5);
    for (let i = 0; i < n; i++) {
      const g = 0.25 + Math.random() * 0.25;
      this._spawnColored(_colA.setRGB(g, g, g), 0.05,
        x + (Math.random() - 0.5) * 0.2, y + Math.random() * 0.15, z + (Math.random() - 0.5) * 0.2,
        (Math.random() - 0.5) * 0.01, 0.02 + Math.random() * 0.01, (Math.random() - 0.5) * 0.01,
        16 + (Math.random() * 8) | 0, -0.0015);
    }
  }

  // 07-REDSTONE §12.2 — one note particle above the note block, rising and
  // fading. `hue` is note/24 (0..1), mapped straight onto the HSL wheel.
  note(x, y, z, hue) {
    if (!this._n(1)) return;
    this._spawnColored(_colA.setHSL(hue, 1, 0.6), 0.07,
      x + (Math.random() - 0.5) * 0.2, y, z + (Math.random() - 0.5) * 0.2,
      0, 0.035, 0, 14, -0.0008);
  }

  // 07-REDSTONE §4.5 — one red spark off a lit dust cell. Cosmetic only; the
  // 1/8 roll and the position live in block 70's randomTick.
  redstoneSpark(x, y, z) {
    if (!this._n(1)) return;
    this._spawnColored(0xd22b2b, 0.045, x, y, z,
      (Math.random() - 0.5) * 0.01, 0, (Math.random() - 0.5) * 0.01,
      8 + (Math.random() * 6) | 0, 0);
  }

  // 10-NETHER §6.2 — the spawner's flame cue, fired every tick by tickSpawner
  // while a player is inside activationRange. Without it an active fortress
  // spawner is completely inert: nothing signals that the player is in range.
  // The 50% roll keeps it near 10 particles/s per spawner against MAX.
  spawnerFlame(x, y, z) {
    if (Math.random() < 0.5) return;
    if (!this._n(1)) return;
    this._spawnColored(0xff8800, 0.05,
      x + (Math.random() - 0.5) * 0.6, y + (Math.random() - 0.5) * 0.6,
      z + (Math.random() - 0.5) * 0.6, 0, 0.01, 0, 8, 0);
  }

  /**
   * 08 §2.2 / §4.5 — the enchanting table's glyphs: white 1-px sprites drifting
   * from a bookshelf position toward the table's floating book, lifetime 20–30
   * ticks. Cosmetic only.
   *
   * §2.2 spawns 2/tick from random ACTIVE bookshelf positions while the UI is
   * open; §4.5 fires a burst of 8–12 at the item slot on purchase. Both land
   * here — `from` is a shelf position when there is one, else the table itself.
   */
  enchantGlyphs(pos, from = null, count = 10) {
    if (!pos) return;
    const n = this._n(count);
    const bx = pos.x + 0.5, by = pos.y + 12 / 16 + 0.15, bz = pos.z + 0.5;
    for (let i = 0; i < n; i++) {
      const sx = from ? from.x + 0.5 : bx + (Math.random() - 0.5) * 1.2;
      const sy = from ? from.y + 0.5 : by + Math.random() * 0.4;
      const sz = from ? from.z + 0.5 : bz + (Math.random() - 0.5) * 1.2;
      const life = 20 + ((Math.random() * 11) | 0);
      // Drift toward the book: velocity is the remaining gap spread over life.
      this._spawnColored(0xffffff, 0.045, sx, sy, sz,
        (bx - sx) / life, (by - sy) / life, (bz - sz) / life,
        life, 0);
    }
  }

  teleport(x, y, z, height = 2.9) {
    const n = this._n(12);
    for (let i = 0; i < n; i++) {
      this._spawnColored(0xe079fa, 0.06,
        x + (Math.random() - 0.5) * 0.8, y + Math.random() * height,
        z + (Math.random() - 0.5) * 0.8,
        (Math.random() - 0.5) * 0.03, -0.01, (Math.random() - 0.5) * 0.03,
        14 + (Math.random() * 8) | 0, 0.001);
    }
  }

  // 09-POTIONS §6.4 — effect swirls around an entity, tinted per active effect.
  // Skipped for the local player's first-person body (no visible model).
  emitEffectSwirls(entity) {
    if (entity.type === 'player') return;
    if ((entity.age ?? 0) % 8 !== 0) return;                 // throttle
    for (const fx of entity.effects.values()) {
      if (fx.ambient && Math.random() < 0.5) continue;       // dimmer for ambient (beacon)
      if (!this._n(1)) continue;
      this._spawnColored(EFFECT_META_COLOR(fx.id), 0.05,
        entity.pos.x + (Math.random() - 0.5) * entity.width,
        entity.pos.y + entity.height * (0.4 + Math.random() * 0.6),
        entity.pos.z + (Math.random() - 0.5) * entity.width,
        (Math.random() - 0.5) * 0.02, 0.02, (Math.random() - 0.5) * 0.02, 12, 0);
    }
  }

  // §13.2 — splash break: swirl + shard burst at the impact point.
  splashPotion(x, y, z, color, count = 30) {
    const n = this._n(count);
    for (let i = 0; i < n; i++) {
      this._spawnColored(color, 0.06, x, y + 0.1, z,
        (Math.random() - 0.5) * 0.3, Math.random() * 0.2, (Math.random() - 0.5) * 0.3, 10 + (Math.random() * 6 | 0), 0.03);
    }
  }

  // §14.3 — area-effect cloud swirls across the disc.
  effectCloud(x, y, z, radius, color) {
    const n0 = Math.ceil(Math.PI * radius * radius / 3);
    const n = n0 ? this._n(Math.min(n0, 10)) : 0;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * radius;
      this._spawnColored(color, 0.06,
        x + Math.cos(a) * r, y + (Math.random() - 0.5) * 0.4, z + Math.sin(a) * r,
        0, 0.02 + Math.random() * 0.02, 0, 10 + (Math.random() * 6 | 0), 0);
    }
  }

  // 01 §3 — a pure per-TICK integrator: every spawn site supplies tick-domain
  // units (velocities in blocks/tick, `life` in ticks, gravity 0.04 b/t²), so
  // this must be driven from the 20 Hz clock, never from render(). Positions
  // advance cur and shift the old cur into prev for the render-domain lerp;
  // with no render pass wired the alpha-1 flush below reproduces the old
  // post-tick snapshots exactly.
  update() {
    this._lastTick = performance.now();
    const act = this.active;
    for (let i = act.length - 1; i >= 0; i--) {
      const p = act[i];
      p.px = p.x; p.py = p.y; p.pz = p.z;
      p.x += p.vx; p.y += p.vy; p.z += p.vz;
      p.vy -= p.gravity;
      p.vx *= 0.95; p.vy *= 0.98; p.vz *= 0.95;
      if (p.scale0 !== undefined) {
        const k = 1 - (p.life - 1) / p.maxLife;      // 0 → 1 across its life
        p.curScale = p.scale0 + (p.scale1 - p.scale0) * k;
        p.opacity = p.alpha0 * (1 - k);
        if (p.pool === POOL_SWEEP) {
          const pool = this._pools[POOL_SWEEP];
          pool.op.setX(p.slot, p.opacity);
          pool.op.needsUpdate = true;
        } else if (p.mesh) {
          p.mesh.scale.setScalar(p.curScale);
          p.mesh.material.opacity = p.opacity;
        }
      }
      if (p.pool === -1) p.mesh.position.set(p.x, p.y, p.z);
      if (--p.life <= 0) this._killRec(i);
    }
    // Fallback flush at alpha 1: instance matrices always land even if the
    // render-domain pass never runs (visual parity with the old snapshots).
    for (const pool of this._pools) if (pool) this._flushPool(pool, 1);
  }

  /**
   * Render-domain pass (call once per frame): rewrites every live instance
   * matrix as prev→cur lerped by `alpha` (0..1 tick fraction; pass nothing to
   * let the pools measure it from the wall clock). Simulation is NOT stepped
   * here — update() remains the only clock. The `camera` argument is accepted
   * for signature symmetry; culling is handled by frustumCulled=false.
   */
  render(alpha, camera) {
    this._manualRender = true;
    const a = alpha == null
      ? (this._lastTick > 0
        ? Math.min(1, Math.max(0, (performance.now() - this._lastTick) / TICK_MS))
        : 1)
      : alpha;
    for (const pool of this._pools) if (pool) this._flushPool(pool, a);
  }

  dispose() {
    // The pools live for the instance's lifetime and go as one teardown: no
    // per-particle geometry or material was ever minted. The two shared
    // geometries are per-Particles instances, so they go with it; the atlas
    // texture and the module-cached sweep texture are owned elsewhere.
    for (const pool of this._pools) {
      if (!pool) continue;
      this.scene.remove(pool.mesh);
      pool.mesh.dispose();
      if (pool.geo) pool.geo.dispose();
      pool.mat.dispose();
    }
    this._pools = [null, null, null];
    for (const p of this.active) {
      if (p.pool === -1) {
        this.scene.remove(p.mesh);
        if (p.mesh.material.userData?.shared !== true) p.mesh.material.dispose();
      }
    }
    this.active.length = 0;
    this._recFree.length = 0;
    this._rectCache.clear();
    this._atlasMat?.dispose();
    this._atlasMat = null;
    this.colorGeo.dispose();
    this.sweepGeo.dispose();
  }
}
