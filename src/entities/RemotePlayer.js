// 14-MULTIPLAYER §4.4/§8.4 — the client-side player puppet + the shared humanoid
// model. A RemotePlayer runs NO physics and NO AI: its transform + animation come
// from interpolated snapshot state (NetClient drives pos/prevPos/flags each frame).
// The same buildHumanoid()/animateHumanoid() power Player.buildMesh() so the HOST
// renders its connected players (real Player entities) identically.
import * as THREE from 'three';
import { LivingEntity, lerp, lerpAngle } from './Entity.js';
import { EFLAG } from '../net/protocol.js';

// hsl → three color, deterministic skin from playerId hue (§8.4).
function hsl(h, s, l) { const c = new THREE.Color(); c.setHSL((h % 360) / 360, s, l); return c; }

function part(w, h, d, color) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const mat = new THREE.MeshBasicMaterial({ color: color.clone() });
  mat.userData.baseColor = { r: color.r, g: color.g, b: color.b };   // for applyLightScalar
  return new THREE.Mesh(geo, mat);
}

// Build a 0.6×1.8 humanoid whose shirt+trouser hue rotate deterministically from
// the player's hue. Returns a THREE.Group with named pivots for animation.
export function buildHumanoid(hue = 0, armorTier = 0) {
  const g = new THREE.Group();
  const skin = hsl(28, 0.45, 0.62);
  const shirt = hsl(hue, 0.55, armorTier > 0 ? 0.7 : 0.5);
  const trouser = hsl((hue + 200) % 360, 0.45, 0.4);

  // torso: 0.5w × 0.6h × 0.25d, centered at y≈1.05 (feet=0)
  const body = part(0.5, 0.6, 0.25, shirt);
  body.position.y = 1.05;
  g.add(body);

  // head: 0.5 cube on top of torso
  const headPivot = new THREE.Group();
  headPivot.position.y = 1.35;
  const head = part(0.5, 0.5, 0.5, skin);
  head.position.y = 0.25;
  headPivot.add(head);
  g.add(headPivot);
  g.userData.head = headPivot;

  // arms: pivot at shoulder (y≈1.35), hang down 0.6
  const mkArm = sign => {
    const pivot = new THREE.Group();
    pivot.position.set(sign * 0.375, 1.35, 0);
    const arm = part(0.24, 0.6, 0.24, shirt);
    arm.position.y = -0.3;
    pivot.add(arm);
    g.add(pivot);
    return pivot;
  };
  g.userData.armR = mkArm(1);
  g.userData.armL = mkArm(-1);

  // legs: pivot at hip (y≈0.75), hang down 0.75
  const mkLeg = sign => {
    const pivot = new THREE.Group();
    pivot.position.set(sign * 0.13, 0.75, 0);
    const leg = part(0.24, 0.75, 0.24, trouser);
    leg.position.y = -0.375;
    pivot.add(leg);
    g.add(pivot);
    return pivot;
  };
  g.userData.legR = mkLeg(1);
  g.userData.legL = mkLeg(-1);

  // right-hand held-item mount (driven by equip)
  const hand = new THREE.Group();
  hand.position.set(0.375, 0.75, 0);
  g.userData.armR.add(hand);
  g.userData.hand = hand;

  return g;
}

// Animate a humanoid group from motion state (05 §16.3 style).
export function animateHumanoid(g, s) {
  const ud = g.userData;
  const swing = Math.sin(s.walkPhase) * Math.min(1, s.hSpeed * 12) * 0.9;
  if (ud.legR) ud.legR.rotation.x = swing;
  if (ud.legL) ud.legL.rotation.x = -swing;
  // arm swing: opposite of legs, plus a punch swing overlay
  const punch = s.swinging ? Math.sin(s.punchPhase) * 1.2 : 0;
  if (ud.armR) ud.armR.rotation.x = -swing + punch;
  if (ud.armL) ud.armL.rotation.x = swing;
  if (ud.head) ud.head.rotation.x = -(s.pitch || 0);
  // sneak: tilt torso forward, lower whole model a touch
  g.rotation.x = s.sneaking ? 0.4 : 0;
  g.position.y = (g.userData._baseY || 0) + (s.sneaking ? -0.15 : 0);
}

export class RemotePlayer extends LivingEntity {
  constructor(world, { playerId, name, hue = 0, slot = 0, entityId = 0 }) {
    super(world, 0, 80, 0);
    this.type = 'player';
    this.isRemotePlayer = true;
    this.width = 0.6; this.height = 1.8;
    this.playerId = playerId;
    this.name = name || 'Player';
    this.hue = hue;
    this.slot = slot;
    this.netId = entityId;                 // host entity id
    this.persistent = true;
    // interpolated/animation state
    this.walkPhase = 0;
    this.punchPhase = 0;
    this.sneaking = false;
    this.sprinting = false;
    this.swinging = false;
    this.gliding = false;
    this.heldItemId = null;
    this.armorTier = 0;
    this.nameplate = null;
  }

  // A puppet never simulates; NetClient positions it from the interpolation buffer.
  tick() {}
  serialize() { return null; }             // never persisted (kept out of chunk saves)

  buildMesh() {
    const g = buildHumanoid(this.hue, this.armorTier);
    g.userData._baseY = 0;
    this.makeNameplate(g);
    return g;
  }

  makeNameplate(g) {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(this.name, 64, 16);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(this.name, 64, 16);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true });
    mat.userData.shared = false;
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.9, 0.225, 1);
    sprite.position.y = 2.2;
    g.add(sprite);
    this.nameplate = sprite;
  }

  updateRender(alpha) {
    if (!this.object3d) return;
    const x = lerp(this.prevPos.x, this.pos.x, alpha);
    const y = lerp(this.prevPos.y, this.pos.y, alpha);
    const z = lerp(this.prevPos.z, this.pos.z, alpha);
    this.object3d.position.set(x, y, z);
    this.object3d.rotation.y = lerpAngle(this.prevYaw, this.yaw, alpha);
    const hSpeed = Math.hypot(this.pos.x - this.prevPos.x, this.pos.z - this.prevPos.z);
    this.walkPhase += hSpeed * 14 + (hSpeed > 0.001 ? 0 : 0);
    if (this.swinging) this.punchPhase += 0.9; else this.punchPhase = 0;
    animateHumanoid(this.object3d, {
      walkPhase: this.walkPhase, hSpeed, swinging: this.swinging,
      punchPhase: this.punchPhase, sneaking: this.sneaking, pitch: this.pitch,
    });
    // nameplate: hide beyond 48 m / while sneaking (§8.2), fade with light
    if (this.nameplate) {
      const cam = this.world.game?.camera;
      let show = !this.sneaking;
      if (cam) {
        const d = Math.hypot(cam.position.x - x, cam.position.y - y, cam.position.z - z);
        if (d > 48) show = false;
      }
      this.nameplate.visible = show;
    }
    this.applyLightScalar();
  }

  // NetClient calls this each snapshot flags/state update.
  applyFlags(flags, stateByte) {
    this.onGround = (flags & EFLAG.ON_GROUND) !== 0;
    this.sprinting = (flags & EFLAG.SPRINTING) !== 0;
    this.sneaking = (flags & EFLAG.SNEAKING) !== 0;
    this.fireTicks = (flags & EFLAG.BURNING) ? Math.max(this.fireTicks, 1) : 0;
    this.swinging = (flags & EFLAG.SWINGING) !== 0;
    this.gliding = (flags & EFLAG.GLIDING) !== 0;
    this.hurtTime = (flags & EFLAG.HURT) ? 10 : 0;
  }
}
