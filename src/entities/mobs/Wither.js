// 13-BOSSES §8 — the Wither: summoned three-headed boss.
//
// A bespoke flying boss (overrides tick() fully, never calls applyLocomotion,
// calls this.tickTimers() itself). Summoned by the block-place listener
// witherSummonDetector (§8.2). Birth phase (§8.3) is an invulnerable 220-tick
// growth that heals to full then detonates. Combat fires wither skulls from a
// center head + two independent side heads (§8.6), eats blocks when hurt
// (§8.8), and armors up below half health (§8.9). Drops a nether star (§8.10).
import * as THREE from 'three';
import { Mob } from './Mob.js';
import { LivingEntity } from '../Entity.js';
import { part } from './models.js';
import { WitherSkull } from '../WitherSkull.js';
import { BLOCKS, B } from '../../registry/blocks.js';
import { hasLineOfSight } from '../../world/raycast.js';
import { emitSound } from '../../audio/engine.js';

// §8.8 — blocks the wither will never break (Java `wither_immune` + liquids).
const WITHER_IMMUNE = new Set([17, 162, 161, 163, 63, 64]);

export class Wither extends Mob {
  constructor(world, x, y, z) {
    super(world, x, y, z);
    this.type = 'wither';
    this.isBoss = true;                 // AI-gate + reaper exemptions (orchestrator)
    this.hostile = true;
    this.persistent = true;
    this.fireImmune = true;             // §8.1 fire/lava immune
    this.effectImmune = true;           // §8.1 immune to all status effects
    this.noGravity = true;              // flying
    this.takesFallDamage = false;
    this.width = 0.9; this.height = 3.5;
    this.maxHealth = 300;
    this.health = 100;                  // §8.3 birth starts at ⅓
    this.detectionRange = 40;
    this.xpValue = 50;

    // §8.3 birth phase
    this.invulnTicks = 220;
    this.birthing = true;
    this.explosionGrace = 0;            // self-damage guard after birth blast

    // §8.6 skull firing state
    this.mainCooldown = 40;
    this.sideCooldown = [10 + this._ri(10), 10 + this._ri(10)];
    this.blueCounter = [0, 0];
    this.sideTarget = [null, null];

    // §8.8 block eating
    this.breakCounter = 0;

    this.regenTimer = 0;
    this.barShown = false;
  }

  _ri(n) { return Math.floor(this.world.rng() * n); }

  // §8.1 — natural armor; knockback immune.
  armorPoints() { return 4; }
  knockbackResistance() { return 1.0; }

  // §8.3/§8.1/§8.9 — cancel-a-hit gate.
  beforeHurt(amount, source, opts) {
    if (this.birthing) return false;                                 // §8.3 fully immune during birth
    if (this.explosionGrace > 0 && source === 'explosion') return false; // ignore own birth blast
    if (opts?.attacker?.undead) return false;                        // §8.1 immune to undead attackers
    if (source === 'arrow' && this.health < 150) return false;       // §8.9 armored deflects arrows
    // §8.6/§8.8 — a real damage event (even if fully i-frame-absorbed) re-arms
    // the side-head blue counters and the block-eating volley.
    this.blueCounter[0] += 3;
    this.blueCounter[1] += 3;
    this.breakCounter = 20;
    return true;
  }

  // §8.9 — arrow deflection hook. Return true only when armored (health<150); the
  // Arrow hook does the velocity reflection itself, so DON'T mutate vel here (that
  // would double-negate and leave the arrow crawling forward).
  tryDeflectArrow() {
    return this.health < 150;
  }

  // ------------------------------------------------------------ tick (custom)
  tick() {
    this.baseTick();
    this.prevWalkCycle = this.walkCycle;
    if (this.dead) { this.deathTime++; return; }

    this.tickTimers();                          // decays birth invulnTicks + i-frames + hurtTime
    if (this.hurtTimer > 0) this.hurtTimer--;
    if (this.explosionGrace > 0) this.explosionGrace--;

    const armored = this.health < 150;

    // --- birth phase (§8.3) ------------------------------------------------
    if (this.birthing) {
      if (this.invulnTicks % 10 === 0) this.heal(10);               // +10 HP / 10 t → 300 by ~tick 200
      if (this.invulnTicks <= 0) {
        this.birthing = false;
        this.explosionGrace = 3;                                     // ignore own blast for a few ticks
        this.world.game?.explode(this.pos.x, this.pos.y + this.height / 2, this.pos.z, 7);
        emitSound('mob.wither.spawn', null);                         // §8.3 global klaxon
      }
      this._updateBossBar();
      return;                                                        // immobile, no attacks during birth
    }

    // --- regeneration (§8.1) — +1 HP / 20 t always -------------------------
    if (++this.regenTimer >= 20) { this.regenTimer = 0; this.heal(1); }

    // --- block eating (§8.8) ----------------------------------------------
    if (this.breakCounter > 0 && --this.breakCounter === 0) this._eatBlocks();

    // --- primary targeting (§8.4), re-eval every 20 t ----------------------
    if (this.age % 20 === 0 || (this.target && (this.target.dead || this.distTo(this.target) > 40))) {
      this.target = this._pickPrimaryTarget();
    }
    const t = this.target;

    // --- movement / hover (§8.5) ------------------------------------------
    let gx, gy, gz;
    if (t) {
      gx = t.pos.x + Math.max(-3, Math.min(3, t.pos.x - this.pos.x));
      gy = t.pos.y + (armored ? 0 : 5);
      gz = t.pos.z + Math.max(-3, Math.min(3, t.pos.z - this.pos.z));
      const dx = gx - this.pos.x, dy = gy - this.pos.y, dz = gz - this.pos.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      this.vel.x += dx / len * 0.03;
      this.vel.y += dy / len * 0.03;
      this.vel.z += dz / len * 0.03;
    } else {
      this.vel.y -= 0.01;                                            // idle: drift down, no altitude gain
    }
    this.vel.x *= 0.91; this.vel.y *= 0.91; this.vel.z *= 0.91;
    this.pos.x += this.vel.x; this.pos.y += this.vel.y; this.pos.z += this.vel.z;

    // body yaw toward primary target (≤ ~10°/tick)
    if (t) {
      const want = Math.atan2(-(t.pos.x - this.pos.x), -(t.pos.z - this.pos.z));
      let d = want - this.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.yaw += Math.max(-0.175, Math.min(0.175, d));
    }

    // --- skull firing (§8.6) ----------------------------------------------
    this._fireCenterHead(t);
    this._fireSideHead(0, armored);
    this._fireSideHead(1, armored);

    this._updateBossBar();
  }

  // ------------------------------------------------------------ targeting (§8.4)
  _validTargets() {
    const out = [];
    const p = this.world.game?.player;
    if (p && !p.dead && !p.creative && this.distTo(p) <= 40) out.push(p);
    for (const e of this.world.getEntitiesInBox(this.getAABB().expand(40, 40, 40),
      e => e instanceof LivingEntity && !e.dead && e !== this &&
        e.type !== 'wither' && e.type !== 'player' && !e.undead)) {
      if (this.distTo(e) <= 40) out.push(e);
    }
    return out;
  }

  _pickPrimaryTarget() {
    const p = this.world.game?.player;
    if (p && !p.dead && !p.creative && this.distTo(p) <= 40) return p;
    let best = null, bd = 40;
    for (const e of this.world.getEntitiesInBox(this.getAABB().expand(40, 40, 40),
      e => e instanceof LivingEntity && !e.dead && e !== this &&
        e.type !== 'wither' && e.type !== 'player' && !e.undead)) {
      const d = this.distTo(e); if (d <= bd) { bd = d; best = e; }
    }
    return best;
  }

  _losFrom(sx, sy, sz, e) {
    return hasLineOfSight(this.world, sx, sy, sz,
      e.pos.x, e.pos.y + e.height * 0.5, e.pos.z);
  }

  // ------------------------------------------------------------ firing (§8.6)
  _headPos(i) {
    // i = -1 center; 0 left, 1 right side head.
    if (i < 0) return [this.pos.x, this.pos.y + 3.1, this.pos.z];
    const sign = i === 0 ? -1 : 1;
    const rx = Math.cos(this.yaw) * 1.3 * sign;
    const rz = Math.sin(this.yaw) * 1.3 * sign;
    return [this.pos.x + rx, this.pos.y + 2.2, this.pos.z + rz];
  }

  _fireAt(sx, sy, sz, tx, ty, tz, blue) {
    const sk = new WitherSkull(this.world, sx, sy, sz, tx - sx, ty - sy, tz - sz, this, { blue });
    this.world.game?.entities.add(sk);
    emitSound(blue ? 'mob.wither.shoot' : 'mob.wither.shoot', { x: sx, y: sy, z: sz });
  }

  _fireCenterHead(t) {
    if (--this.mainCooldown > 0) return;
    this.mainCooldown = 40;
    if (!t) return;
    const [sx, sy, sz] = this._headPos(-1);
    if (!this._losFrom(sx, sy, sz, t)) return;
    const blue = this.world.rng() < 0.001;                          // §8.6 0.1% blue
    this._fireAt(sx, sy, sz, t.pos.x, t.pos.y + t.height * 0.5, t.pos.z, blue);
  }

  _fireSideHead(i, armored) {
    if (--this.sideCooldown[i] > 0) return;
    this.sideCooldown[i] = 10 + this._ri(10);                       // 10..19
    const [sx, sy, sz] = this._headPos(i);
    this.blueCounter[i]++;
    if (this.blueCounter[i] > 15) {                                 // Normal-difficulty blue spray
      this.blueCounter[i] = 0;
      const a = this.world.rng() * Math.PI * 2, b = this.world.rng() * Math.PI - Math.PI / 2;
      this._fireAt(sx, sy, sz, sx + Math.cos(b) * Math.cos(a),
        sy + Math.sin(b), sz + Math.cos(b) * Math.sin(a), true);
    }
    // §8.4 — side head keeps its own target (may reuse the primary).
    let ht = this.sideTarget[i];
    if (!ht || ht.dead || this.distTo(ht) > 40 || !this._losFrom(sx, sy, sz, ht)) ht = null;
    if (!ht && this.target && this._losFrom(sx, sy, sz, this.target)) ht = this.target;
    if (ht && this._losFrom(sx, sy, sz, ht)) {
      this._fireAt(sx, sy, sz, ht.pos.x, ht.pos.y + ht.height * 0.5, ht.pos.z, false);
      this.sideCooldown[i] = 40 + this._ri(20);                     // 40..59 aimed cadence
      this.blueCounter[i] = 0;
      this.sideTarget[i] = ht;
    } else {
      // acquireRandomTarget: a random valid entity within 40 with LOS from head.
      const cands = this._validTargets().filter(e => this._losFrom(sx, sy, sz, e));
      this.sideTarget[i] = cands.length ? cands[this._ri(cands.length)] : null;
    }
  }

  // ------------------------------------------------------------ block eating (§8.8)
  _eatBlocks() {
    const w = this.world, game = w.game;
    const px = Math.floor(this.pos.x), py = Math.floor(this.pos.y), pz = Math.floor(this.pos.z);
    let broke = false;
    for (let x = px - 1; x <= px + 1; x++)
      for (let y = py; y <= py + 3; y++)
        for (let z = pz - 1; z <= pz + 1; z++) {
          const id = w.getBlock(x, y, z);
          if (id === B.AIR || WITHER_IMMUNE.has(id)) continue;
          const blk = BLOCKS[id];
          if (blk?.drops && game) {
            const state = w.getState(x, y, z);
            for (const d of blk.drops({ state, toolClass: 'pickaxe', toolTier: 3, rng: w.rng }) ?? []) {
              if (d.count > 0) game.spawnItemByName(d.name, d.count, x + 0.5, y + 0.5, z + 0.5);
            }
          }
          w.setBlock(x, y, z, B.AIR);
          broke = true;
        }
    if (broke) emitSound('mob.wither.break_block', { x: this.pos.x, y: this.pos.y, z: this.pos.z });
  }

  // ------------------------------------------------------------ boss bar (§1)
  _updateBossBar() {
    const bar = this.world.game?.ui?.bossBar;
    if (!bar) return;
    const p = this.world.game?.player;
    const inRange = p && !p.dead && this.distTo(p) <= 128;
    if (inRange) {
      if (!this.barShown) { bar.add(this.id, { name: 'Wither', color: '#7b2fbe' }); this.barShown = true; }
      bar.set(this.id, this.health / 300);
    } else if (this.barShown) {
      bar.remove(this.id); this.barShown = false;
    }
  }

  // ------------------------------------------------------------ death (§8.10)
  onDeath(source, opts) {
    emitSound('mob.wither.death', { x: this.pos.x, y: this.pos.y + this.height / 2, z: this.pos.z });
    const game = this.world.game;
    if (game) {
      const cx = this.pos.x, cy = this.pos.y + this.height / 2, cz = this.pos.z;
      game.spawnItemByName('nether_star', 1, cx, cy, cz, { x: 0, y: 0, z: 0 });
      game.spawnXpOrb(cx, cy, cz, 50);
    }
    if (this.barShown && game?.ui?.bossBar) { game.ui.bossBar.remove(this.id); this.barShown = false; }
  }

  // no natural loot table (drops handled in onDeath)
  dropTable() { return []; }

  // ------------------------------------------------------------ model (§8.11)
  buildModel() {
    const g = new THREE.Group();
    const parts = {};
    parts.tail = part('wither_body', 4, 10, 4, [0, 0, 0], [0, 5, 0]);
    parts.spine = part('wither_body', 6, 30, 6, [0, 0, 0], [0, 25, 0]);
    parts.ribcage = part('wither_body', 18, 14, 10, [0, 0, 0], [0, 23, 0]);
    parts.shoulders = part('wither_body', 34, 6, 8, [0, 0, 0], [0, 43, 0]);
    parts.head = part('wither_head', 12, 12, 12, [0, 50, 0], [0, 0, 0]);
    parts.headL = part('wither_head', 10, 10, 10, [-11, 45, 0], [0, 0, 0]);
    parts.headR = part('wither_head', 10, 10, 10, [11, 45, 0], [0, 0, 0]);
    for (const k in parts) g.add(parts[k]);
    return { group: g, parts };
  }

  animateExtra() {
    // birth growth scale 0.5 → 1.0 + gentle body bob (§8.11).
    if (this.object3d) {
      const s = this.birthing ? 0.5 + 0.5 * (1 - Math.max(0, this.invulnTicks) / 220) : 1;
      this.object3d.scale.setScalar(s);
    }
    const p = this.parts;
    if (p?.headL) p.headL.rotation.y = Math.sin(this.age * 0.05) * 0.2;
    if (p?.headR) p.headR.rotation.y = Math.cos(this.age * 0.05) * 0.2;
  }

  // ------------------------------------------------------------ persistence
  serialize() {
    return {
      ...super.serialize(),
      invulnTicks: this.invulnTicks,
      birthing: this.birthing,
      blueCounter: [this.blueCounter[0], this.blueCounter[1]],
      sideCooldown: [this.sideCooldown[0], this.sideCooldown[1]],
      breakCounter: this.breakCounter,
    };
  }

  deserialize(rec) {
    super.deserialize(rec);
    this.invulnTicks = rec.invulnTicks ?? 0;
    this.birthing = rec.birthing ?? (this.invulnTicks > 0 && this.health < 300);
    this.blueCounter = rec.blueCounter ?? [0, 0];
    this.sideCooldown = rec.sideCooldown ?? [10, 10];
    this.breakCounter = rec.breakCounter ?? 0;
  }
}

// ==========================================================================
// §8.2 — Wither summon detector. Called after a wither_skeleton_skull (186) is
// placed at (x,y,z). Scans the T-structure (2 soul blocks tall base + a 3-wide
// soul arm + 3 skulls on top). On a match it clears the 7 cells and spawns a
// Wither with its feet at the lowest soul cell. Returns true if it summoned.
// ==========================================================================
export function witherSummonDetector(world, x, y, z) {
  const isSoul = id => id === 119 || id === 120;
  const g = world.getBlock.bind(world);
  const axes = [[1, 0], [0, 1]];                       // X then Z
  for (const axis of axes) {
    for (let offset = -1; offset <= 1; offset++) {
      const cx = x - offset * axis[0];
      const cz = z - offset * axis[1];
      const a1x = cx - axis[0], a1z = cz - axis[1];
      const a3x = cx + axis[0], a3z = cz + axis[1];
      if (g(a1x, y, a1z) === 186 && g(cx, y, cz) === 186 && g(a3x, y, a3z) === 186 &&
          isSoul(g(a1x, y - 1, a1z)) && isSoul(g(cx, y - 1, cz)) && isSoul(g(a3x, y - 1, a3z)) &&
          isSoul(g(cx, y - 2, cz))) {
        world.setBlock(a1x, y, a1z, B.AIR);
        world.setBlock(cx, y, cz, B.AIR);
        world.setBlock(a3x, y, a3z, B.AIR);
        world.setBlock(a1x, y - 1, a1z, B.AIR);
        world.setBlock(cx, y - 1, cz, B.AIR);
        world.setBlock(a3x, y - 1, a3z, B.AIR);
        world.setBlock(cx, y - 2, cz, B.AIR);
        world.game?.entities.add(new Wither(world, cx + 0.5, y - 2, cz + 0.5));
        return true;
      }
    }
  }
  return false;
}
