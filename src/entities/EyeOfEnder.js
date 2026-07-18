// 11-END §3 — the eye of ender: a short-lived, collision-free navigation entity
// launched by RMB in the overworld. It eases toward the stronghold's XZ (rising
// while > 12 blocks away, diving within 12), trails magenta portal motes, then at
// the end of its 80-tick life either drops back as an item (80%) or shatters
// (20%). The survive/shatter outcome is rolled ONCE at launch (vanilla exact).
//
// Constructor design: `constructor(world, x, y, z, owner)`. The target is computed
// INTERNALLY from `world.worldSeed` via strongholdXZ (§4.2) — the launcher only
// has to hand over the spawn position (eye pos + look·0.5) and an owner, and the
// navigation stays byte-identical to the worker's stronghold placement. Not
// persisted (serialize → null).
import * as THREE from 'three';
import { Entity, lerp } from './Entity.js';
import { strongholdXZ } from '../world/gen/endShared.js';
import { emitSound, at } from '../audio/engine.js';
import { rngInt } from '../math/rng.js';
import { tileSpriteGeometry, itemTileFor, makeAtlasMaterial } from './ItemEntity.js';
import { idOf } from '../registry/items.js';

const LIFETIME = 80;        // §3 — 80 ticks total
const HOVER = 20;           // §3 — last 20 ticks: v ×0.5
const SPEED = 0.35;         // §3 — target approach speed
const SY = 40;              // §4.2 — start-piece floor Y (dive target)
const PORTAL_COLOR = 0xe079fa;   // §3 / 05 §16.3 enderman magenta
const SHATTER_COLOR = 0x9b30ff;  // §3 — crit-style purple burst

export class EyeOfEnder extends Entity {
  constructor(world, x, y, z, owner) {
    super(world, x, y, z);
    this.type = 'eye_of_ender';
    this.width = 0.25; this.height = 0.25;   // §3 — AABB 0.25³
    this.owner = owner;
    this.life = LIFETIME;
    this.vel.x = this.vel.y = this.vel.z = 0;

    // §3 target math from §4.2's (SX, SZ).
    const { SX, SZ } = strongholdXZ(world.worldSeed);
    const dx = SX - x, dz = SZ - z;
    const f = Math.hypot(dx, dz);
    if (f > 12) {
      this.target = { x: x + dx / f * 12, y: y + 8, z: z + dz / f * 12 };  // rise & point
    } else {
      this.target = { x: SX, y: SY, z: SZ };                              // dive — dig here
    }

    // §3 death roll AT LAUNCH: survives = randInt(5) > 0 → 80% drop / 20% shatter.
    this.survives = rngInt(world.rng, 5) > 0;
  }

  tick() {
    this.baseTick();

    // §3 motion: ease toward target, no gravity, flies through blocks.
    const p = this.pos, v = this.vel, t = this.target;
    const dx = t.x - p.x, dy = t.y - p.y, dz = t.z - p.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    v.x = lerp(v.x, dx / len * SPEED, 0.25);
    v.y = lerp(v.y, dy / len * SPEED, 0.25);
    v.z = lerp(v.z, dz / len * SPEED, 0.25);
    if (this.life <= HOVER) { v.x *= 0.5; v.y *= 0.5; v.z *= 0.5; }   // hover
    p.x += v.x; p.y += v.y; p.z += v.z;

    this.trail();

    if (--this.life <= 0) { this.expire(); this.dead = true; }
  }

  // §3 — 2 magenta portal motes/tick.
  trail() {
    const parts = this.world.game?.particles;
    if (!parts) return;
    const p = this.pos;
    for (let i = 0; i < 2; i++) {
      const m = parts.colored(PORTAL_COLOR, 0.06);
      parts.spawn(m,
        p.x + (Math.random() - 0.5) * 0.25,
        p.y + (Math.random() - 0.5) * 0.25,
        p.z + (Math.random() - 0.5) * 0.25,
        (Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * 0.02,
        8 + (Math.random() * 6 | 0), 0);
    }
  }

  // §3 end-of-life resolution using the launch roll.
  expire() {
    const game = this.world.game;
    const p = this.pos;
    if (this.survives) {
      // spawnItemById gives the item entity pickupDelay 10 (§3). Keep it in place.
      game?.spawnItemByName?.('eye_of_ender', 1, p.x, p.y, p.z, { x: 0, y: 0.1, z: 0 });
      emitSound('eye_of_ender.drop', at(p.x, p.y, p.z));
    } else {
      emitSound('eye_of_ender.shatter', at(p.x, p.y, p.z));
      this.shatter();
    }
  }

  // §3 — 12 crit-style purple particles; nothing drops.
  shatter() {
    const parts = this.world.game?.particles;
    if (!parts) return;
    const p = this.pos;
    for (let i = 0; i < 12; i++) {
      const m = parts.colored(SHATTER_COLOR, 0.06);
      const ang = Math.random() * Math.PI * 2;
      const sp = Math.random() * 0.08;
      parts.spawn(m, p.x, p.y, p.z,
        Math.cos(ang) * sp, 0.03 + Math.random() * 0.04, Math.sin(ang) * sp,
        10 + (Math.random() * 6 | 0), 0.02);
    }
  }

  buildMesh() {
    const group = new THREE.Group();
    const tile = itemTileFor(idOf('eye_of_ender'));
    const mesh = new THREE.Mesh(tileSpriteGeometry(tile, 0.35), makeAtlasMaterial({ doubleSide: true }));
    group.add(mesh);
    return group;
  }

  serialize() { return null; }   // §3 — not persisted
}
