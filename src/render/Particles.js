// Tiny pooled cube-sprite particles (01 §2): block break, crit stars,
// explosion puffs, hearts, teleport motes.
import * as THREE from 'three';
import { BLOCKS } from '../registry/blocks.js';
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
    this.pool = [];
    this.active = [];
    this.colorGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    // Baked flat so the arc needs only a single yaw rotation at spawn — setting
    // rotation.x and rotation.z together would depend on Euler order.
    this.sweepGeo = new THREE.PlaneGeometry(1, 0.25);
    this.sweepGeo.rotateX(-Math.PI / 2);
  }

  obtain(mesh) {
    mesh.visible = true;
    this.scene.add(mesh);
    return mesh;
  }

  // opts (all optional, used by sweep()): {scale0, scale1, alpha0, disposeMat}.
  // Absent for every other caller, so their records behave exactly as before.
  spawn(mesh, x, y, z, vx, vy, vz, life, gravity = 0.04, opts = null) {
    if (this.active.length >= MAX) return;
    mesh.position.set(x, y, z);
    const rec = { mesh, vx, vy, vz, life, gravity };
    if (opts) Object.assign(rec, opts, { maxLife: life });
    this.active.push(rec);
    this.scene.add(mesh);
  }

  colored(color, size = 0.1) {
    const mat = new THREE.MeshBasicMaterial({ color });
    const m = new THREE.Mesh(this.colorGeo, mat);
    m.scale.setScalar(size / 0.1);
    return m;
  }

  blockBreak(x, y, z, blockId) {
    const rng = Math.random;
    const geo = blockCubeGeometry(blockId, 0.1);
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(geo, makeAtlasMaterial());
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
      { scale0: 0.8, scale1: 1.6, alpha0: 0.4, disposeMat: true });
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

  teleport(x, y, z, height = 2.9) {
    for (let i = 0; i < 12; i++) {
      const m = this.colored(0xe079fa, 0.06);
      this.spawn(m, x + (Math.random() - 0.5) * 0.8, y + Math.random() * height,
        z + (Math.random() - 0.5) * 0.8,
        (Math.random() - 0.5) * 0.03, -0.01, (Math.random() - 0.5) * 0.03,
        14 + (Math.random() * 8) | 0, 0.001);
    }
  }

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
        // Mapped materials are normally shared and must not be disposed; the
        // sweep's is per-particle (it animates opacity) and opts in explicitly.
        if (p.disposeMat || p.mesh.material.map == null) p.mesh.material.dispose();
        this.active.splice(i, 1);
      }
    }
  }

  dispose() {
    for (const p of this.active) this.scene.remove(p.mesh);
    this.active.length = 0;
  }
}
