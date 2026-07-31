// Tiny cube-sprite particles (01 §2): block break, crit stars, explosion puffs,
// hearts, teleport motes. (No pool: every spawn allocates its own Mesh, and the
// record is dropped on expiry — the header used to claim pooling that the
// implementation never had.)
import * as THREE from 'three';
import { BLOCKS } from '../registry/blocks.js';
import { EFFECT_META } from '../status/effects.js';
const EFFECT_META_COLOR = id => EFFECT_META[id]?.color ?? 0xffffff;
import { blockCubeGeometry, makeAtlasMaterial } from '../entities/ItemEntity.js';

const MAX = 256;

// 08 §6.4 — the sweep arc tile: 24×6 px, a flat white crescent. Procedural like
// every other texture in the build (CLAUDE.md §6); built once, shared by every
// swing. The material can't be shared (per-particle opacity), the texture can.
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
    // 01 §17.2 — ONE atlas material for every block-break particle. It is never
    // tinted or faded, so the per-particle material makeAtlasMaterial() used to
    // mint (16 per broken block, none of them ever disposed — the expiry path
    // only frees map-less materials) bought nothing but GL bookkeeping and 16
    // extra material switches per burst. Lazy because ATLAS is wired at boot.
    this._atlasMat = null;
  }

  atlasMat() {
    if (!this._atlasMat) {
      this._atlasMat = makeAtlasMaterial();
      this._atlasMat.userData.shared = true;   // the disposal predicates opt out on this
    }
    return this._atlasMat;
  }

  // opts (all optional, used by sweep()): {scale0, scale1, alpha0}.
  // Absent for every other caller, so their records behave exactly as before.
  // A null mesh means the emitter declined at the cap (see colored()).
  spawn(mesh, x, y, z, vx, vy, vz, life, gravity = 0.04, opts = null) {
    if (!mesh || this.active.length >= MAX) return;
    mesh.position.set(x, y, z);
    const rec = { mesh, vx, vy, vz, life, gravity };
    if (opts) Object.assign(rec, opts, { maxLife: life });
    this.active.push(rec);
    this.scene.add(mesh);
  }

  colored(color, size = 0.1) {
    // The MAX gate lives HERE, not only in spawn(): every caller allocated its
    // Mesh + MeshBasicMaterial first and spawn() then dropped it on the floor, so
    // at the cap — the normal state during combat or mining — 100% of the churn
    // was immediate garbage. Declining up front makes the emitters no-ops.
    if (this.active.length >= MAX) return null;
    const mat = new THREE.MeshBasicMaterial({ color });
    const m = new THREE.Mesh(this.colorGeo, mat);
    m.scale.setScalar(size / 0.1);
    return m;
  }

  blockBreak(x, y, z, blockId) {
    const rng = Math.random;
    const geo = blockCubeGeometry(blockId, 0.1);
    for (let i = 0; i < 16; i++) {
      if (this.active.length >= MAX) return;   // same up-front cap as colored()
      const m = new THREE.Mesh(geo, this.atlasMat());
      const ang = rng() * Math.PI * 2;
      const sp = rng() * 0.1;
      this.spawn(m, x + 0.2 + rng() * 0.6, y + 0.2 + rng() * 0.6, z + 0.2 + rng() * 0.6,
        Math.cos(ang) * sp, 0.05 + rng() * 0.1, Math.sin(ang) * sp,
        10 + (rng() * 10) | 0);
    }
  }

  crit(target) {
    for (let i = 0; i < 8; i++) {
      const m = this.colored(0x332211, 0.06);
      this.spawn(m,
        target.pos.x + (Math.random() - 0.5) * target.width,
        target.pos.y + target.height * 0.8,
        target.pos.z + (Math.random() - 0.5) * target.width,
        (Math.random() - 0.5) * 0.04, 0.02 + Math.random() * 0.02, (Math.random() - 0.5) * 0.04,
        10 + (Math.random() * 6) | 0, 0.01);
    }
  }

  // 08 §6.4 — one flat white arc quad, 1.7 m in front of the player at hip
  // height, lying horizontally, widening 0.8 → 1.6 m and fading over 6 ticks.
  // `yaw` is the player's yaw; the geometry is pre-laid flat (see constructor).
  sweep(px, py, pz, yaw) {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const mat = new THREE.MeshBasicMaterial({
      map: sweepTexture(), transparent: true, opacity: 0.4,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(this.sweepGeo, mat);
    m.rotation.y = yaw;
    m.scale.setScalar(0.8);
    this.spawn(m, px + fx * 1.7, py + 0.9, pz + fz * 1.7, 0, 0, 0, 6, 0,
      { scale0: 0.8, scale1: 1.6, alpha0: 0.4 });
  }

  explosion(x, y, z, power) {
    for (let i = 0; i < 24; i++) {
      const gray = 0.4 + Math.random() * 0.5;
      const m = this.colored(new THREE.Color(gray, gray, gray), 0.25);
      const ang = Math.random() * Math.PI * 2;
      const up = Math.random();
      const sp = Math.random() * 0.15 * power / 3;
      this.spawn(m, x, y, z,
        Math.cos(ang) * sp, up * 0.15, Math.sin(ang) * sp,
        14 + (Math.random() * 10) | 0, 0.002);
    }
  }

  hearts(x, y, z) {
    const m = this.colored(0xd0342c, 0.09);
    this.spawn(m, x + (Math.random() - 0.5) * 0.6, y, z + (Math.random() - 0.5) * 0.6,
      0, 0.03, 0, 16, -0.001);
  }

  // 07-REDSTONE §6.4 — redstone-torch burnout smoke: grey puffs drifting up out
  // of the torch head. Negative gravity is this file's idiom for "rises"
  // (hearts does the same); the pool/dispose path is the shared one.
  smoke(x, y, z) {
    for (let i = 0; i < 5; i++) {
      const g = 0.25 + Math.random() * 0.25;
      const m = this.colored(new THREE.Color(g, g, g), 0.05);
      this.spawn(m, x + (Math.random() - 0.5) * 0.2, y + Math.random() * 0.15, z + (Math.random() - 0.5) * 0.2,
        (Math.random() - 0.5) * 0.01, 0.02 + Math.random() * 0.01, (Math.random() - 0.5) * 0.01,
        16 + (Math.random() * 8) | 0, -0.0015);
    }
  }

  // 07-REDSTONE §12.2 — one note particle above the note block, rising and
  // fading. `hue` is note/24 (0..1), mapped straight onto the HSL wheel.
  note(x, y, z, hue) {
    const m = this.colored(new THREE.Color().setHSL(hue, 1, 0.6), 0.07);
    this.spawn(m, x + (Math.random() - 0.5) * 0.2, y, z + (Math.random() - 0.5) * 0.2,
      0, 0.035, 0, 14, -0.0008);
  }

  // 07-REDSTONE §4.5 — one red spark off a lit dust cell. Cosmetic only; the
  // 1/8 roll and the position live in block 70's randomTick.
  redstoneSpark(x, y, z) {
    const m = this.colored(0xd22b2b, 0.045);
    this.spawn(m, x, y, z,
      (Math.random() - 0.5) * 0.01, 0, (Math.random() - 0.5) * 0.01,
      8 + (Math.random() * 6) | 0, 0);
  }

  // 10-NETHER §6.2 — the spawner's flame cue, fired every tick by tickSpawner
  // while a player is inside activationRange. Without it an active fortress
  // spawner is completely inert: nothing signals that the player is in range.
  // The 50% roll keeps it near 10 particles/s per spawner against MAX.
  spawnerFlame(x, y, z) {
    if (Math.random() < 0.5) return;
    const m = this.colored(0xff8800, 0.05);
    this.spawn(m, x + (Math.random() - 0.5) * 0.6, y + (Math.random() - 0.5) * 0.6,
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
    const bx = pos.x + 0.5, by = pos.y + 12 / 16 + 0.15, bz = pos.z + 0.5;
    for (let i = 0; i < count; i++) {
      const sx = from ? from.x + 0.5 : bx + (Math.random() - 0.5) * 1.2;
      const sy = from ? from.y + 0.5 : by + Math.random() * 0.4;
      const sz = from ? from.z + 0.5 : bz + (Math.random() - 0.5) * 1.2;
      const life = 20 + ((Math.random() * 11) | 0);
      // Drift toward the book: velocity is the remaining gap spread over life.
      const m = this.colored(0xffffff, 0.045);
      this.spawn(m, sx, sy, sz,
        (bx - sx) / life, (by - sy) / life, (bz - sz) / life,
        life, 0);
    }
  }

  teleport(x, y, z, height = 2.9) {
    for (let i = 0; i < 12; i++) {
      const m = this.colored(0xe079fa, 0.06);
      this.spawn(m, x + (Math.random() - 0.5) * 0.8, y + Math.random() * height,
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
      const m = this.colored(EFFECT_META_COLOR(fx.id), 0.05);
      this.spawn(m, entity.pos.x + (Math.random() - 0.5) * entity.width,
        entity.pos.y + entity.height * (0.4 + Math.random() * 0.6),
        entity.pos.z + (Math.random() - 0.5) * entity.width,
        (Math.random() - 0.5) * 0.02, 0.02, (Math.random() - 0.5) * 0.02, 12, 0);
    }
  }

  // §13.2 — splash break: swirl + shard burst at the impact point.
  splashPotion(x, y, z, color, count = 30) {
    for (let i = 0; i < count; i++) {
      const m = this.colored(color, 0.06);
      this.spawn(m, x, y + 0.1, z,
        (Math.random() - 0.5) * 0.3, Math.random() * 0.2, (Math.random() - 0.5) * 0.3, 10 + (Math.random() * 6 | 0), 0.03);
    }
  }

  // §14.3 — area-effect cloud swirls across the disc.
  effectCloud(x, y, z, radius, color) {
    const n = Math.ceil(Math.PI * radius * radius / 3);
    for (let i = 0; i < Math.min(n, 10); i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * radius;
      const m = this.colored(color, 0.06);
      this.spawn(m, x + Math.cos(a) * r, y + (Math.random() - 0.5) * 0.4, z + Math.sin(a) * r,
        0, 0.02 + Math.random() * 0.02, 0, 10 + (Math.random() * 6 | 0), 0);
    }
  }

  // 01 §3 — a pure per-TICK integrator: every spawn site supplies tick-domain
  // units (velocities in blocks/tick, `life` in ticks, gravity 0.04 b/t²), so
  // this must be driven from the 20 Hz clock, never from render().
  update() {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      p.mesh.position.x += p.vx;
      p.mesh.position.y += p.vy;
      p.mesh.position.z += p.vz;
      p.vy -= p.gravity;
      p.vx *= 0.95; p.vy *= 0.98; p.vz *= 0.95;
      if (p.scale0 !== undefined) {
        const k = 1 - (p.life - 1) / p.maxLife;      // 0 → 1 across its life
        p.mesh.scale.setScalar(p.scale0 + (p.scale1 - p.scale0) * k);
        p.mesh.material.opacity = p.alpha0 * (1 - k);
      }
      if (--p.life <= 0) {
        this.scene.remove(p.mesh);
        // `userData.shared`, not "has a map": makeAtlasMaterial() mints a NEW
        // material per call, so the old map!=null proxy for "shared" silently
        // skipped 16 live materials per broken block. Only atlasMat() opts out.
        if (p.mesh.material.userData?.shared !== true) p.mesh.material.dispose();
        this.active.splice(i, 1);
      }
    }
  }

  dispose() {
    // Same rule as update()'s expiry path: everything except the one shared
    // atlas material, which this instance owns and frees below. The two shared
    // geometries are per-Particles instances, so they go with it.
    for (const p of this.active) {
      this.scene.remove(p.mesh);
      if (p.mesh.material.userData?.shared !== true) p.mesh.material.dispose();
    }
    this.active.length = 0;
    this._atlasMat?.dispose();
    this._atlasMat = null;
    this.colorGeo.dispose();
    this.sweepGeo.dispose();
  }
}
