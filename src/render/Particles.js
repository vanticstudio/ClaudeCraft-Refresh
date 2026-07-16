// Tiny pooled cube-sprite particles (01 §2): block break, crit stars,
// explosion puffs, hearts, teleport motes.
import * as THREE from 'three';
import { BLOCKS } from '../registry/blocks.js';
import { blockCubeGeometry, makeAtlasMaterial } from '../entities/ItemEntity.js';

const MAX = 256;

export class Particles {
  constructor(scene) {
    this.scene = scene;
    this.pool = [];
    this.active = [];
    this.colorGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
  }

  obtain(mesh) {
    mesh.visible = true;
    this.scene.add(mesh);
    return mesh;
  }

  spawn(mesh, x, y, z, vx, vy, vz, life, gravity = 0.04) {
    if (this.active.length >= MAX) return;
    mesh.position.set(x, y, z);
    this.active.push({ mesh, vx, vy, vz, life, gravity });
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
      if (--p.life <= 0) {
        this.scene.remove(p.mesh);
        if (p.mesh.material.map == null) p.mesh.material.dispose();
        this.active.splice(i, 1);
      }
    }
  }

  dispose() {
    for (const p of this.active) this.scene.remove(p.mesh);
    this.active.length = 0;
  }
}
