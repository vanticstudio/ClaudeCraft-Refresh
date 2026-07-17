// XP orb entity (05 §15): magnet, pickup, lifetime.
import * as THREE from 'three';
import { Entity } from './Entity.js';
import { emitSound } from '../audio/engine.js';

let orbTexture = null;
function getOrbTexture() {
  if (orbTexture) return orbTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(4, 4, 0.5, 4, 4, 4);
  g.addColorStop(0, '#eaff6a');
  g.addColorStop(0.6, '#7dfa4c');
  g.addColorStop(1, 'rgba(60,220,60,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, 8);
  orbTexture = new THREE.CanvasTexture(c);
  orbTexture.magFilter = THREE.NearestFilter;
  orbTexture.minFilter = THREE.NearestFilter;
  orbTexture.colorSpace = THREE.NoColorSpace;
  return orbTexture;
}

export class XpOrb extends Entity {
  constructor(world, x, y, z, value) {
    super(world, x, y, z);
    this.type = 'xp_orb';
    this.width = 0.5; this.height = 0.5;
    this.value = Math.max(1, value | 0);
  }

  tick() {
    this.baseTick();
    if (this.age >= 6000) { this.dead = true; return; }
    this.updateMedium();

    const player = this.world.game?.player;
    if (player && !player.dead) {
      const dx = player.pos.x - this.pos.x;
      const dy = (player.pos.y + player.height / 2) - (this.pos.y + 0.25);
      const dz = player.pos.z - this.pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 7.25 && d > 1e-4) {                      // magnet (05 §15)
        const f = 0.1 * (1 - d / 7.25) ** 2;
        this.vel.x += (dx / d) * f;
        this.vel.y += (dy / d) * f;
        this.vel.z += (dz / d) * f;
      }
      if (player.xpPickupCooldown === 0 && player.getAABB().intersects(this.getAABB())) {
        // §3.3: collecting a spray plays a rising run. xpPickupCooldown is a
        // 2-tick anti-double-pickup latch, NOT this timer — different period.
        player.orbStreak = Math.min(24, player.orbStreak + 1);
        player.orbStreakTimer = 40;
        emitSound('player.xp_pickup', null, Math.pow(2, player.orbStreak / 12));
        // 08 §5.8 / AMENDS 05 §15 — Mending intercepts the orb's value before it
        // reaches the bar. onOrbPickup does the repair, then adds the leftover.
        player.onOrbPickup(this.value);
        player.xpPickupCooldown = 2;
        this.dead = true;
        return;
      }
    }

    this.vel.y -= 0.03;
    this.move(this.vel.x, this.vel.y, this.vel.z);
    this.vel.x *= 0.98; this.vel.y *= 0.98; this.vel.z *= 0.98;
    if (this.onGround) { this.vel.x *= 0.6; this.vel.z *= 0.6; }
  }

  buildMesh() {
    const group = new THREE.Group();
    const mat = new THREE.SpriteMaterial({ map: getOrbTexture(), transparent: true });
    mat.userData.baseColor = new THREE.Color(1, 1, 1);
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.3, 0.3, 1);
    sprite.position.y = 0.2;
    group.add(sprite);
    return group;
  }

  updateRender(alpha) {
    super.updateRender(alpha);
    if (!this.object3d) return;
    const s = 0.3 + 0.05 * Math.sin((this.age + alpha) * 0.6);   // pulse
    const sprite = this.object3d.children[0];
    if (sprite) sprite.scale.set(s, s, 1);
  }

  applyLightScalar() {
    // orbs glow: skip light dimming
  }

  serialize() {
    return { type: 'xp_orb', value: this.value, ...super.serialize() };
  }
}
