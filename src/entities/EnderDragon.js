// 13-BOSSES §6/§7 — the Ender Dragon: boss, two damage parts, and the per-End
// fight manager. The dragon is NOT a chunk entity — EndFight ticks and renders
// it (serialize() -> null; the fight state lives in game.dimMeta[2].endFight).
// Its two DragonParts ARE added to game.entities so melee/arrows can hit them;
// every accepted hit is funnelled into the dragon's shared damagePool.
import * as THREE from 'three';
import { LivingEntity, lerp, lerpAngle } from './Entity.js';
import { AABB } from '../math/aabb.js';
import { B } from '../registry/blocks.js';
import { hasLineOfSight } from '../world/raycast.js';
import { emitSound, at } from '../audio/engine.js';
import { mobTexture } from './mobs/models.js';
import { EndCrystal } from './EndCrystal.js';
import DragonFireball from './DragonFireball.js';
import {
  pillarPositions, EXIT_PORTAL, EGG_CELL,
  activateExitPortal, spawnGateway, regenerateSpike,
} from '../world/endArena.js';

// §7.8 — blocks the dragon's body/head never destroy.
const DRAGON_IMMUNE = new Set([
  B.BEDROCK, B.OBSIDIAN, B.IRON_BARS, B.END_STONE,
  B.END_PORTAL_FRAME, B.END_PORTAL, B.END_GATEWAY,
]);
// fluids + fire (63/64/65) are skipped rather than deleted.
const SKIP_IDS = new Set([63, 64, 65]);

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

// Perch geometry: the body hovers above the exit fountain, head reaching down.
const PERCH_BODY_Y = EXIT_PORTAL.topY + 5;

// ==========================================================================
// §6.1 — a head/body damage box that follows the dragon and forwards hits.
// ==========================================================================
export class DragonPart extends LivingEntity {
  constructor(world, dragon, partType, w, h, d) {
    super(world, dragon.pos.x, dragon.pos.y, dragon.pos.z);
    this.type = 'ender_dragon_part';
    this.dragon = dragon;
    this.partType = partType;          // 'head' | 'body'
    this.boxW = w; this.boxH = h; this.boxD = d;
    this.width = w; this.height = h;
    this.health = this.maxHealth = 200;
    this.noGravity = true;
    this.takesFallDamage = false;
    this.fireImmune = true;
    this.isBoss = true;                // AI-gate + void-reap + chunk-unload exempt
    this.isDragonPart = true;          // interaction crit-gate flag
    this.deathAnimTicks = 0;
  }

  center() {
    const d = this.dragon;
    if (!d) return { x: this.pos.x, y: this.pos.y, z: this.pos.z };
    return this.partType === 'head' ? d.headPos : d.bodyPos;
  }

  // §6.1 — box recomputed each query so hit-tests always track the live dragon.
  getAABB() {
    const c = this.center();
    const hw = this.boxW / 2, hh = this.boxH / 2, hd = this.boxD / 2;
    return new AABB(c.x - hw, c.y - hh, c.z - hd, c.x + hw, c.y + hh, c.z + hd);
  }

  // Endermen use tryDodgeProjectile; the dragon reuses it (and tryDeflectArrow)
  // to bounce arrows harmlessly while perched/breathing (§7.7).
  tryDeflectArrow() {
    const s = this.dragon?.state;
    return s === 'PERCHED' || s === 'BREATH';
  }
  tryDodgeProjectile() { return this.tryDeflectArrow(); }

  // §6.1/§7.7 — accept only player-driven melee/arrow or any explosion.
  hurt(amount, source = 'generic', opts = {}) {
    const d = this.dragon;
    if (!d || d.dead) return false;
    if (source === 'arrow' && this.tryDeflectArrow()) return false;
    if (source !== 'melee' && source !== 'arrow' && source !== 'explosion') return false;
    const atk = opts?.attacker;
    const playerish = source === 'explosion' || (atk && atk.type === 'player');
    if (!playerish) return false;

    const raw = amount;
    const applied = this.partType === 'head' ? raw : raw / 4 + Math.min(1, raw);
    d.damagePool(applied, source, opts);
    return true;
  }

  tick() {
    this.baseTick();
    this.tickTimers();
    const c = this.center();
    this.pos.x = c.x; this.pos.y = c.y; this.pos.z = c.z;   // keep spatial index live
  }

  buildMesh() { return null; }     // invisible — the dragon renders the visuals
  serialize() { return null; }
}

// ==========================================================================
// §6/§7 — the Ender Dragon.
// ==========================================================================
export class EnderDragon extends LivingEntity {
  constructor(world, x, y, z) {
    super(world, x, y, z);
    this.type = 'ender_dragon';
    this.isBoss = true;
    this.health = this.maxHealth = 200;
    this.width = 2; this.height = 2;      // nominal; hits go through the parts
    this.effectImmune = true;             // §6/§4.3
    this.noGravity = true;
    this.fireImmune = true;
    this.takesFallDamage = false;

    // flight
    this.heading = { x: 0, y: 0, z: 1 };
    this.ringR = 55; this.ringHeight = 100;
    this.nodeIndex = 0;

    // state machine (§7.3)
    this.state = 'HOLDING';
    this.perchPhase = 0;
    this.perchTicks = 0;
    this.breathCount = 0;
    this.perchDamage = 0;
    this.noPlayerApproach = 0;
    this.chargeTimer = 0;
    this.breathTimer = 0;

    // damage bookkeeping
    this.poolIFrames = 0;
    this.hurtSuppress = 0;
    this.healAccum = 0;
    this.linkedCrystal = null;

    // death
    this.deathTicks = 0;
    this.reachedCenter = false;
    this.firstKill = false;

    this.endFight = null;                 // set by EndFight
    this.wingPhase = 0;

    // live world-space box centers (read by the parts every query)
    this.headPos = { x, y, z };
    this.bodyPos = { x, y, z };

    // §6.1 — two damage parts, added so melee/arrows can hit them.
    this.headPart = new DragonPart(world, this, 'head', 1, 1, 1);
    this.bodyPart = new DragonPart(world, this, 'body', 4, 3, 4);
    world.game?.entities.add(this.headPart);
    world.game?.entities.add(this.bodyPart);
  }

  // damage never reaches the dragon directly — only via the parts / crystals.
  hurt() { return false; }
  knockbackResistance() { return 1.0; }

  // §6.2 — shared 10-tick i-frames, then health drain; perch tally; death gate.
  damagePool(amount) {
    if (this.dead || this.state === 'DYING') return;
    if (this.poolIFrames > 0) return;
    this.poolIFrames = 10;
    this.hurtSuppress = 10;          // §6.4 — suppress contact for 10 t after a hit
    this.hurtTime = 10;
    this.health -= amount;
    if (this.state === 'PERCHED' || this.state === 'BREATH') this.perchDamage += amount;
    if (this.health <= 0 && this.state !== 'DYING') this.setState('DYING');
  }

  // ---------------------------------------------------------------- helpers
  nearestPlayer() {
    const p = this.world.game?.player;
    return (p && !p.dead) ? p : null;
  }

  nodePos(index) {
    const a = index * 30 * DEG;
    return { x: Math.cos(a) * this.ringR, y: this.ringHeight, z: Math.sin(a) * this.ringR };
  }

  pickNearestNode() {
    let best = 0, bd = Infinity;
    for (let k = 0; k < 12; k++) {
      const n = this.nodePos(k);
      const d = (n.x - this.pos.x) ** 2 + (n.z - this.pos.z) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    this.nodeIndex = best;
  }

  // Turn heading toward (dx,dy,dz unit) by <=maxAngle, then advance `speed`.
  flyToward(gx, gy, gz, speed) {
    let dx = gx - this.pos.x, dy = gy - this.pos.y, dz = gz - this.pos.z;
    const dist = Math.hypot(dx, dy, dz) || 1e-4;
    dx /= dist; dy /= dist; dz /= dist;
    const h = this.heading;
    const dot = clamp(h.x * dx + h.y * dy + h.z * dz, -1, 1);
    const ang = Math.acos(dot);
    if (ang > 1e-4) {
      const t = Math.min(1, (4 * DEG) / ang);
      let nx = h.x + (dx - h.x) * t, ny = h.y + (dy - h.y) * t, nz = h.z + (dz - h.z) * t;
      const l = Math.hypot(nx, ny, nz) || 1;
      h.x = nx / l; h.y = ny / l; h.z = nz / l;
    }
    this.pos.x += h.x * speed; this.pos.y += h.y * speed; this.pos.z += h.z * speed;
    this.yaw = Math.atan2(-h.x, h.z);
    this.pitch = Math.asin(clamp(h.y, -1, 1));
    return Math.hypot(gx - this.pos.x, gy - this.pos.y, gz - this.pos.z);
  }

  updateParts() {
    const h = this.heading;
    this.bodyPos = { x: this.pos.x, y: this.pos.y, z: this.pos.z };
    this.headPos = { x: this.pos.x + h.x * 5, y: this.pos.y + h.y * 5 + 0.5, z: this.pos.z + h.z * 5 };
  }

  // ---------------------------------------------------------------- tick
  tick(worldSeed) {
    this.baseTick();
    this.tickTimers();
    if (this.poolIFrames > 0) this.poolIFrames--;
    if (this.hurtSuppress > 0) this.hurtSuppress--;
    this.wingPhase = this.age;

    const game = this.world.game;
    // 13-BOSSES — the DragonParts live in the EntityManager and can be reaped when
    // the arena chunks unload (player on the far platform). Re-create them so the
    // dragon always has hittable head/body boxes while it lives.
    if (this.state !== 'DYING') {
      if (!this.headPart || this.headPart.dead) { this.headPart = new DragonPart(this.world, this, 'head', 1, 1, 1); game?.entities.add(this.headPart); }
      if (!this.bodyPart || this.bodyPart.dead) { this.bodyPart = new DragonPart(this.world, this, 'body', 4, 3, 4); game?.entities.add(this.bodyPart); }
    }
    const pillars = pillarPositions(worldSeed);
    let sum = 0; for (const p of pillars) sum += p.topY;
    this.ringHeight = Math.min(124, (pillars.length ? sum / pillars.length : 70) + 6);
    const crystalsAlive = this.countCrystals(game);
    this.ringR = crystalsAlive > 0 ? 43 + 12 : 43 - 12;

    this.updateParts();
    this.tickCrystalHealing(game);
    this.tickState(game, worldSeed, crystalsAlive);
    this.updateParts();
    if (!this.dead) {
      this.tickContact(game);
      this.tickTerrain();
      this.tickBossBar(game);
    }
  }

  countCrystals(game) {
    let n = 0;
    for (const e of game.entities.entities.values())
      if (!e.dead && e.type === 'end_crystal' && !e.playerPlaced) n++;
    return n;
  }

  // §6.3 — nearest crystal within ±32 heals the dragon; linked-crystal death hurts.
  tickCrystalHealing(game) {
    if (this.linkedCrystal && this.linkedCrystal.dead) {
      this.linkedCrystal = null;
      this.damagePool(10);
      if (this.state !== 'DYING') this.setState('STRAFING');
    }
    let best = null, bd = Infinity;
    const bx = this.bodyPos.x, by = this.bodyPos.y, bz = this.bodyPos.z;
    for (const e of game.entities.entities.values()) {
      if (e.dead || e.type !== 'end_crystal') continue;
      const cx = e.pos.x, cy = e.pos.y + e.height / 2, cz = e.pos.z;
      if (Math.abs(cx - bx) > 32 || Math.abs(cy - by) > 32 || Math.abs(cz - bz) > 32) { e.beamTarget = null; continue; }
      const d = (cx - bx) ** 2 + (cy - by) ** 2 + (cz - bz) ** 2;
      if (d < bd) { bd = d; best = e; }
      e.beamTarget = null;
    }
    if (best) {
      best.beamTarget = { x: this.headPos.x, y: this.headPos.y, z: this.headPos.z };
      this.linkedCrystal = best;
      if (++this.healAccum >= 10) { this.healAccum = 0; if (this.health < 200) this.health = Math.min(200, this.health + 1); }
    } else {
      this.linkedCrystal = null;
    }
  }

  // ---------------------------------------------------------------- state
  setState(s) {
    this.state = s;
    if (s === 'STRAFING') this.fireFireball();
    else if (s === 'APPROACH_PERCH') {
      this.perchPhase = 0; this.perchTicks = 0;
      this.breathCount = 0; this.perchDamage = 0; this.noPlayerApproach = 0;
    } else if (s === 'BREATH') { this.doBreath(); this.breathTimer = 20; }
    else if (s === 'CHARGING') this.chargeTimer = 0;
    else if (s === 'TAKEOFF') this.pickNearestNode();
    else if (s === 'DYING') {
      this.reachedCenter = false; this.deathTicks = 0;
      this.firstKill = (this.endFight?.ensureRecord().dragonKilledCount ?? 0) === 0;
      emitSound('mob.ender_dragon.growl', at(this.bodyPos.x, this.bodyPos.y, this.bodyPos.z));
    }
  }

  tickState(game, worldSeed, crystalsAlive) {
    switch (this.state) {
      case 'HOLDING': {
        const d = this.flyToward(...this.nodeVec(), 0.6);
        if (d < 6) {
          this.nodeIndex = (this.nodeIndex + 1) % 12;
          if (this.world.rng() < 1 / (3 + crystalsAlive)) this.setState('APPROACH_PERCH');
        }
        break;
      }
      case 'STRAFING': {
        const d = this.flyToward(...this.nodeVec(), 0.6);
        if (d < 6) { this.nodeIndex = (this.nodeIndex + 1) % 12; this.setState('HOLDING'); }
        break;
      }
      case 'APPROACH_PERCH': {
        if (this.perchPhase === 0) {
          const d = this.flyToward(0, EXIT_PORTAL.topY + 20, 0, 0.6);
          if (d < 6) this.perchPhase = 1;
        } else {
          const d = this.flyToward(0, PERCH_BODY_Y, 0, 0.6);
          if (d < 3) this.setState('PERCHED');
        }
        break;
      }
      case 'PERCHED': this.handlePerched(); break;
      case 'BREATH':
        this.hoverPerch();
        if (--this.breathTimer <= 0) this.state = 'PERCHED';
        break;
      case 'CHARGING': {
        const p = this.nearestPlayer();
        if (!p) { this.setState('TAKEOFF'); break; }
        this.chargeTimer++;
        const d = this.flyToward(p.pos.x, p.pos.y + p.height * 0.5, p.pos.z, 1.0);
        if (d < 10 || this.chargeTimer >= 100) this.setState('TAKEOFF');
        break;
      }
      case 'TAKEOFF': {
        const d = this.flyToward(...this.nodeVec(), 0.6);
        if (d < 6) this.setState('HOLDING');
        break;
      }
      case 'DYING': this.tickDying(game, worldSeed); break;
    }
  }

  nodeVec() { const n = this.nodePos(this.nodeIndex); return [n.x, n.y, n.z]; }

  hoverPerch() {
    this.pos.x += (0 - this.pos.x) * 0.2;
    this.pos.y += (PERCH_BODY_Y - this.pos.y) * 0.2;
    this.pos.z += (0 - this.pos.z) * 0.2;
    // head reaches down toward the fountain center
    let dx = 0 - this.pos.x, dy = EXIT_PORTAL.topY - this.pos.y, dz = 0 - this.pos.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    this.heading = { x: dx / l, y: dy / l, z: dz / l };
    this.yaw = Math.atan2(-this.heading.x, this.heading.z);
    this.pitch = Math.asin(clamp(this.heading.y, -1, 1));
  }

  handlePerched() {
    this.hoverPerch();
    this.perchTicks++;
    const p = this.nearestPlayer();
    const cdist = p ? Math.hypot(p.pos.x, p.pos.y - EXIT_PORTAL.topY, p.pos.z) : Infinity;
    if (!p || cdist > 150) { this.setState('TAKEOFF'); return; }
    if (this.breathCount >= 4 || this.perchDamage > 50) { this.setState('TAKEOFF'); return; }
    if (cdist <= 20) { this.noPlayerApproach = 0; this.setState('BREATH'); return; }
    if (++this.noPlayerApproach >= 100) this.setState('CHARGING');
  }

  // §7.4 — one dragon fireball at the nearest player within 64 with LOS.
  fireFireball() {
    const game = this.world.game;
    const p = this.nearestPlayer();
    if (!p) return;
    const h = this.headPos;
    const tx = p.pos.x, ty = p.pos.y + p.height * 0.5, tz = p.pos.z;
    if (Math.hypot(tx - h.x, ty - h.y, tz - h.z) > 64) return;
    if (!hasLineOfSight(this.world, h.x, h.y, h.z, tx, ty, tz)) return;
    game.entities.add(new DragonFireball(this.world, h.x, h.y, h.z, tx - h.x, ty - h.y, tz - h.z, this));
    emitSound('mob.ender_dragon.shoot', at(h.x, h.y, h.z));
  }

  // §7.5 — perch breath: roar + a stationary acid cloud on the fountain.
  doBreath() {
    const game = this.world.game;
    emitSound('mob.ender_dragon.growl', at(0, EXIT_PORTAL.topY, 0));
    game.spawnAreaEffectCloud({
      pos: { x: 0, y: EXIT_PORTAL.topY, z: 0 },
      radius: 3, radiusPerTick: 0, durationTicks: 200, reapplyDelay: 20,
      effect: { damage: 6 },
    });
    this.breathCount++;
  }

  // §6.4 — body/head contact damage + direct-velocity launch (bypasses kbResist).
  tickContact(game) {
    if (this.hurtSuppress > 0) return;
    const hBox = new AABB(
      this.headPos.x - 0.5, this.headPos.y - 0.5, this.headPos.z - 0.5,
      this.headPos.x + 0.5, this.headPos.y + 0.5, this.headPos.z + 0.5);
    const bBox = new AABB(
      this.bodyPos.x - 2, this.bodyPos.y - 1.5, this.bodyPos.z - 2,
      this.bodyPos.x + 2, this.bodyPos.y + 1.5, this.bodyPos.z + 2);
    const scan = bBox.clone().expand(1, 1, 1);
    for (const e of this.world.getEntitiesInBox(scan, e =>
        e instanceof LivingEntity && !e.dead && !e.isDragonPart && e !== this)) {
      const box = e.getAABB();
      const inHead = box.intersects(hBox);
      const inBody = box.intersects(bBox);
      if (!inHead && !inBody) continue;
      const dmg = inHead ? 10 : 5;
      if (!e.hurt(dmg, 'mob', { attacker: this })) continue;
      let dx = e.pos.x - this.bodyPos.x, dz = e.pos.z - this.bodyPos.z;
      const l = Math.hypot(dx, dz) || 1;
      e.vel.x += (dx / l) * 2.0; e.vel.z += (dz / l) * 2.0; e.vel.y += 0.8;
    }
  }

  // §7.8 — carve any non-immune, non-fluid block overlapping the body/head boxes.
  tickTerrain() {
    const w = this.world;
    const carve = (cx, cy, cz, hw, hh, hd) => {
      const x0 = Math.floor(cx - hw), x1 = Math.floor(cx + hw);
      const y0 = Math.floor(cy - hh), y1 = Math.floor(cy + hh);
      const z0 = Math.floor(cz - hd), z1 = Math.floor(cz + hd);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const id = w.getBlock(x, y, z);
        if (id === 0 || DRAGON_IMMUNE.has(id) || SKIP_IDS.has(id)) continue;
        w.setBlock(x, y, z, B.AIR, { noUpdates: true });
      }
    };
    carve(this.bodyPos.x, this.bodyPos.y, this.bodyPos.z, 2, 1.5, 2);
    carve(this.headPos.x, this.headPos.y, this.headPos.z, 0.5, 0.5, 0.5);
  }

  // §7.9 — death: reach center, then ascend 200 ticks spraying XP.
  tickDying(game, worldSeed) {
    if (!this.reachedCenter) {
      const d = this.flyToward(0, PERCH_BODY_Y, 0, 0.6);
      if (d < 3) { this.reachedCenter = true; this.deathTicks = 0; }
      return;
    }
    this.pos.x += (0 - this.pos.x) * 0.1;
    this.pos.z += (0 - this.pos.z) * 0.1;
    this.vel.y = 0.03; this.pos.y += 0.03;
    this.heading = { x: 0, y: 1, z: 0 }; this.pitch = Math.PI / 2;

    if (this.firstKill && this.deathTicks >= 155 && this.deathTicks <= 200 && (this.deathTicks - 155) % 5 === 0)
      game.spawnXpOrb(this.pos.x, this.pos.y, this.pos.z, 960);
    if (this.deathTicks >= 200) {
      game.spawnXpOrb(this.pos.x, this.pos.y, this.pos.z, this.firstKill ? 2400 : 500);
      this.finalize(worldSeed);
      return;
    }
    this.deathTicks++;
  }

  finalize(worldSeed) {
    if (this.dead) return;
    const game = this.world.game;
    const r = this.endFight.ensureRecord();
    if (this.headPart) { this.headPart.dead = true; this.headPart.deathTime = 0; }
    if (this.bodyPart) { this.bodyPart.dead = true; this.bodyPart.deathTime = 0; }
    game.ui?.bossBar?.remove(this.id);
    if (this.object3d) { game.scene.remove(this.object3d); this.object3d = null; }

    activateExitPortal(game); r.exitPortalActive = true;
    if (this.firstKill) { game.world.setBlock(EGG_CELL.x, EGG_CELL.y, EGG_CELL.z, B.DRAGON_EGG); r.eggPlaced = true; }
    if (r.gatewaysSpawned < 20) { spawnGateway(game, worldSeed, r.gatewaysSpawned); r.gatewaysSpawned++; }
    r.dragonAlive = false; r.dragonKilledCount++; r.dragon = null;
    emitSound('mob.ender_dragon.death', at(0, PERCH_BODY_Y, 0));
    this.dead = true;
  }

  // §6.6 — boss bar (id keyed; add() is idempotent).
  tickBossBar(game) {
    game.ui?.bossBar?.add(this.id, { name: 'Ender Dragon', color: '#ec00d1' });
    game.ui?.bossBar?.set(this.id, this.health / 200);
  }

  // ---------------------------------------------------------------- render
  // Called by EndFight (the dragon is not in the EntityManager render pass).
  updateRenderStandalone(scene, alpha) {
    if (this.dead) return;
    if (!this.object3d) { this.object3d = this.buildMesh(); if (this.object3d) scene.add(this.object3d); }
    const o = this.object3d; if (!o) return;
    o.position.set(
      lerp(this.prevPos.x, this.pos.x, alpha),
      lerp(this.prevPos.y, this.pos.y, alpha),
      lerp(this.prevPos.z, this.pos.z, alpha));
    o.rotation.order = 'YXZ';
    o.rotation.y = lerpAngle(this.prevYaw, this.yaw, alpha) + Math.PI;
    o.rotation.x = -this.pitch;
    if (this.parts) {
      const flap = Math.sin((this.wingPhase + alpha) * 0.05) * 0.5;
      if (this.parts.wingL) this.parts.wingL.rotation.z = -flap;
      if (this.parts.wingR) this.parts.wingR.rotation.z = flap;
    }
  }

  // §7.10 — a simplified dragon (body + neck + head + 2 wings). Model faces +Z.
  buildMesh() {
    const g = new THREE.Group();
    this.parts = {};
    const bodyMat = new THREE.MeshLambertMaterial({ map: mobTexture('dragon_body') });
    bodyMat.userData.baseColor = new THREE.Color(1, 1, 1);
    const wingMat = new THREE.MeshLambertMaterial({ map: mobTexture('dragon_wing'), transparent: true, opacity: 0.95 });
    wingMat.userData.baseColor = new THREE.Color(1, 1, 1);

    const box = (w, h, d, mat, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      return m;
    };
    g.add(box(2.0, 1.4, 3.0, bodyMat, 0, 0, 0));         // body
    g.add(box(1.6, 0.6, 2.5, bodyMat, 0, -0.2, -2.4));    // tail
    g.add(box(0.8, 0.8, 2.0, bodyMat, 0, 0.4, 2.0));      // neck
    g.add(box(1.2, 1.0, 1.4, bodyMat, 0, 0.7, 3.4));      // head

    const wingL = new THREE.Group();
    wingL.add(box(3.0, 0.15, 1.8, wingMat, -1.5, 0, -0.2));
    wingL.position.set(-1.0, 0.5, 0);
    const wingR = new THREE.Group();
    wingR.add(box(3.0, 0.15, 1.8, wingMat, 1.5, 0, -0.2));
    wingR.position.set(1.0, 0.5, 0);
    g.add(wingL); g.add(wingR);
    this.parts.wingL = wingL; this.parts.wingR = wingR;
    return g;
  }

  // §6 — persistence lives in the EndFight record, not the entity list.
  serialize() { return null; }

  snapshot() {
    return {
      pos: [this.pos.x, this.pos.y, this.pos.z],
      heading: [this.heading.x, this.heading.y, this.heading.z],
      yaw: this.yaw, pitch: this.pitch,
      state: this.state, health: this.health, nodeIndex: this.nodeIndex,
      perchPhase: this.perchPhase, perchTicks: this.perchTicks,
      breathCount: this.breathCount, perchDamage: this.perchDamage,
      noPlayerApproach: this.noPlayerApproach, chargeTimer: this.chargeTimer,
      deathTicks: this.deathTicks, reachedCenter: this.reachedCenter, firstKill: this.firstKill,
    };
  }

  static fromSnapshot(world, snap, endFight) {
    const d = new EnderDragon(world, 0, 100, 0);
    d.endFight = endFight;
    if (snap) {
      if (snap.pos) { d.pos.x = snap.pos[0]; d.pos.y = snap.pos[1]; d.pos.z = snap.pos[2]; d.prevPos = { ...d.pos }; }
      if (snap.heading) d.heading = { x: snap.heading[0], y: snap.heading[1], z: snap.heading[2] };
      d.yaw = snap.yaw ?? 0; d.pitch = snap.pitch ?? 0;
      d.state = snap.state ?? 'HOLDING';
      d.health = snap.health ?? 200;
      d.nodeIndex = snap.nodeIndex ?? 0;
      d.perchPhase = snap.perchPhase ?? 0;
      d.perchTicks = snap.perchTicks ?? 0;
      d.breathCount = snap.breathCount ?? 0;
      d.perchDamage = snap.perchDamage ?? 0;
      d.noPlayerApproach = snap.noPlayerApproach ?? 0;
      d.chargeTimer = snap.chargeTimer ?? 0;
      d.deathTicks = snap.deathTicks ?? 0;
      d.reachedCenter = !!snap.reachedCenter;
      d.firstKill = !!snap.firstKill;
    }
    return d;
  }
}

// ==========================================================================
// §10.1 — per-End fight manager. Owns game.dimMeta[2].endFight and the live
// dragon reference. Ticked/rendered by Game while activeDim === 2.
// ==========================================================================
export class EndFight {
  constructor(game) {
    this.game = game;
    this.liveDragon = null;
  }

  ensureRecord() {
    const game = this.game;
    game.dimMeta = game.dimMeta ?? {};
    const meta = (game.dimMeta[2] = game.dimMeta[2] ?? {});
    return meta.endFight ?? (meta.endFight = {
      dragonAlive: false, dragonKilledCount: 0,
      crystalsAlive: [true, true, true, true, true, true, true, true, true, true],
      gatewaysSpawned: 0, eggPlaced: false, exitPortalActive: false,
      respawnSequence: null, dragon: null,
    });
  }

  // §10.2 — first-ever End entry: spawn 10 crystals + the dragon (once).
  spawnFight(worldSeed) {
    const r = this.ensureRecord();
    if (this.liveDragon && !this.liveDragon.dead) return;
    if (r.dragonAlive) { this.maybeRespawnDragon(worldSeed); return; }
    if (r.dragonKilledCount > 0) return;      // already beaten; no auto-respawn

    const world = this.game.world;
    const pills = pillarPositions(worldSeed);
    for (let k = 0; k < pills.length; k++) {
      const c = pills[k].crystal;
      this.game.entities.add(new EndCrystal(world, c.x, c.y, c.z, { hasBase: true }));
    }
    const d = new EnderDragon(world, 0, 100, 0);
    d.endFight = this;
    this.liveDragon = d;
    r.dragonAlive = true;
    r.dragon = d.snapshot();
  }

  // Every game tick while activeDim === 2.
  tick(worldSeed) {
    const r = this.ensureRecord();
    if (this.liveDragon && !this.liveDragon.dead) {
      this.liveDragon.tick(worldSeed);
      if (!this.liveDragon.dead) r.dragon = this.liveDragon.snapshot();
    } else if (this.liveDragon && this.liveDragon.dead) {
      this.liveDragon = null;
    }
    if (r.respawnSequence) this.tickRitual(worldSeed);
  }

  updateRender(alpha) {
    if (this.liveDragon && !this.liveDragon.dead)
      this.liveDragon.updateRenderStandalone(this.game.scene, alpha);
  }

  crystalAtRim(rim, playerOnly) {
    const y = EXIT_PORTAL.topY + 1;
    for (const e of this.game.entities.entities.values()) {
      if (e.dead || e.type !== 'end_crystal') continue;
      if (playerOnly && !e.playerPlaced) continue;
      if (Math.floor(e.pos.x) === rim.x && Math.floor(e.pos.y) === y && Math.floor(e.pos.z) === rim.z) return e;
    }
    return null;
  }

  // §7.11 — a player-placed crystal on each of the 4 rim cells starts the ritual.
  checkRitual(worldSeed) {
    const r = this.ensureRecord();
    if (r.dragonAlive || r.respawnSequence) return;
    if (this.liveDragon && !this.liveDragon.dead) return;
    for (const rim of EXIT_PORTAL.rimCells) if (!this.crystalAtRim(rim, true)) return;
    r.respawnSequence = { tick: 0 };
  }

  tickRitual(worldSeed) {
    const r = this.ensureRecord();
    const seq = r.respawnSequence;
    const t = seq.tick;
    if (t % 54 === 0) {
      const k = t / 54;
      if (k >= 0 && k < 10) {
        regenerateSpike(this.game, worldSeed, k);
        const c = pillarPositions(worldSeed)[k].crystal;
        this.game.entities.add(new EndCrystal(this.game.world, c.x, c.y, c.z, { hasBase: true }));
      }
    }
    if (t === 604) {
      const d = new EnderDragon(this.game.world, 0, 100, 0);
      d.endFight = this;
      this.liveDragon = d;
      r.dragonAlive = true;
      r.dragon = d.snapshot();
      for (const rim of EXIT_PORTAL.rimCells) this.crystalAtRim(rim, false)?.hurt(6, 'generic', {});
      r.respawnSequence = null;
      return;
    }
    seq.tick++;
  }

  // On load: an alive-but-absent dragon is rebuilt from the record + re-added.
  maybeRespawnDragon(worldSeed) {
    const r = this.ensureRecord();
    if (!r.dragonAlive) return;
    if (this.liveDragon && !this.liveDragon.dead) return;
    this.liveDragon = EnderDragon.fromSnapshot(this.game.world, r.dragon, this);
  }
}
