// Mob AI: A* pathfinding over the voxel grid + the goal classes (05 §6–§7).
import { BLOCKS, B } from '../../registry/blocks.js';
import { hasLineOfSight } from '../../world/raycast.js';

// ---------------------------------------------------------------- A*

const solidAt = (w, x, y, z) => BLOCKS[w.getBlock(x, y, z)].collidable;
const liquidAt = (w, x, y, z) => !!BLOCKS[w.getBlock(x, y, z)].fluid;
const solidOrLiquid = (w, x, y, z) => {
  const b = BLOCKS[w.getBlock(x, y, z)];
  return b.collidable || !!b.fluid;
};

export function standable(w, x, y, z, mob) {
  if (!solidAt(w, x, y - 1, z) || solidOrLiquid(w, x, y, z) || solidOrLiquid(w, x, y + 1, z)) return false;
  if (mob?.tall3 && solidAt(w, x, y + 2, z)) return false;
  if (mob?.wide3) {
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        if (solidOrLiquid(w, x + dx, y, z + dz)) return false;
  }
  return true;
}

// budget: max 2 full A* runs per tick (05 §7)
let astarBudgetTick = -1;
let astarRuns = 0;
export function astarBudgetOk(worldTime) {
  if (worldTime !== astarBudgetTick) { astarBudgetTick = worldTime; astarRuns = 0; }
  return astarRuns < 2;
}

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function findPath(w, mob, sx, sy, sz, gx, gy, gz, maxRange = 32, maxNodes = 512) {
  astarRuns++;
  // snap goal down ≤ 4 to a standable cell
  let goalY = gy;
  let ok = false;
  for (let d = 0; d <= 4; d++) {
    if (standable(w, gx, goalY - d, gz, mob)) { goalY -= d; ok = true; break; }
  }
  if (!ok) return null;

  const key = (x, y, z) => x + ',' + y + ',' + z;
  const open = [];   // small binary-ish: linear scan (≤512 nodes)
  const gScore = new Map();
  const parent = new Map();
  const h = (x, y, z) => Math.hypot(x - gx, y - goalY, z - gz);
  const startKey = key(sx, sy, sz);
  gScore.set(startKey, 0);
  open.push({ x: sx, y: sy, z: sz, g: 0, f: h(sx, sy, sz), key: startKey });
  let expanded = 0;
  let best = open[0], bestH = h(sx, sy, sz);

  const relax = (nx, ny, nz, ng, fromKey) => {
    const k = key(nx, ny, nz);
    if (gScore.has(k) && gScore.get(k) <= ng) return;
    // cost penalties: lava/fire adjacency +16, water +4
    let penalty = 0;
    if (liquidAt(w, nx, ny, nz)) penalty += 4;
    for (const [dx, dz] of DIRS4) {
      const nb = w.getBlock(nx + dx, ny, nz + dz);
      if (nb === B.LAVA || nb === B.FIRE) { penalty += 16; break; }
    }
    gScore.set(k, ng);
    parent.set(k, fromKey);
    open.push({ x: nx, y: ny, z: nz, g: ng + penalty, f: ng + penalty + h(nx, ny, nz), key: k });
  };

  while (open.length && expanded < maxNodes) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const n = open.splice(bi, 1)[0];
    expanded++;
    const hn = h(n.x, n.y, n.z);
    if (hn < bestH) { bestH = hn; best = n; }
    if ((n.x === gx && n.y === goalY && n.z === gz) || hn < 0.8) {
      return reconstruct(parent, n.key, sx, sy, sz);
    }
    if (Math.hypot(n.x - sx, n.y - sy, n.z - sz) > maxRange) continue;

    for (const [dx, dz] of DIRS4) {
      const cx = n.x + dx, cz = n.z + dz;
      if (standable(w, cx, n.y, cz, mob)) {
        relax(cx, n.y, cz, n.g + 1.0, n.key);
      } else if (standable(w, cx, n.y + 1, cz, mob) && !solidAt(w, n.x, n.y + 2, n.z)) {
        relax(cx, n.y + 1, cz, n.g + 1.5, n.key);       // jump-up
      } else {
        for (let drop = 1; drop <= 3; drop++) {
          if (standable(w, cx, n.y - drop, cz, mob)) {
            relax(cx, n.y - drop, cz, n.g + 1.0 + drop * 0.5, n.key);
            break;
          }
          if (solidOrLiquid(w, cx, n.y - drop, cz)) break;
        }
      }
    }
  }
  return best.key === startKey ? null : reconstruct(parent, best.key, sx, sy, sz);
}

function reconstruct(parent, endKey, sx, sy, sz) {
  const path = [];
  let k = endKey;
  while (k) {
    const [x, y, z] = k.split(',').map(Number);
    path.push({ x, y, z });
    k = parent.get(k);
  }
  path.reverse();
  if (path.length && path[0].x === sx && path[0].y === sy && path[0].z === sz) path.shift();
  return path.length ? path : null;
}

// ---------------------------------------------------------------- goals

export const MOVE = 1, LOOK = 2;

export class Goal {
  constructor(mob) { this.mob = mob; this.active = false; }
  get flags() { return MOVE; }
  canStart() { return false; }
  shouldContinue() { return this.canStart(); }
  start() {}
  stop() {}
  tick() {}
}

export class SwimGoal extends Goal {
  get flags() { return 0; }   // never blocks other goals (05 §6)
  canStart() { return this.mob.inWater; }
  tick() {
    if (this.mob.age % 10 === 0) this.mob.wantJump = true;   // surface hop
  }
}

export class WanderGoal extends Goal {
  canStart() { return this.mob.world.rng() < 1 / 120; }
  start() {
    const m = this.mob, w = m.world;
    for (let i = 0; i < 8; i++) {
      const x = Math.floor(m.pos.x) + Math.floor(w.rng() * 21) - 10;
      const y = Math.floor(m.pos.y) + Math.floor(w.rng() * 15) - 7;
      const z = Math.floor(m.pos.z) + Math.floor(w.rng() * 21) - 10;
      let sy = y;
      let found = false;
      for (let d = 0; d <= 6; d++) {
        if (standable(w, x, sy - d, z, m)) { sy -= d; found = true; break; }
      }
      if (found) {
        m.pathTo(x, sy, z, m.walkSpeed);
        this.started = m.world.time;
        return;
      }
    }
    this.started = m.world.time;
  }
  shouldContinue() {
    return this.mob.path && this.mob.world.time - this.started < 300;
  }
  tick() { this.mob.followPath(); }
  stop() { this.mob.clearPath(); }
}

export class LookAtPlayerGoal extends Goal {
  constructor(mob, range = 8) { super(mob); this.range = range; }
  get flags() { return LOOK; }
  canStart() {
    const p = this.mob.world.game?.player;
    if (!p || p.dead) return false;
    if (this.mob.distTo(p) > this.range) return false;
    if (this.mob.world.rng() >= 1 / 50) return false;
    this.duration = 40 + Math.floor(this.mob.world.rng() * 41);
    return true;
  }
  shouldContinue() {
    const p = this.mob.world.game?.player;
    return --this.duration > 0 && p && this.mob.distTo(p) <= this.range;
  }
  tick() {
    const p = this.mob.world.game?.player;
    if (p) this.mob.lookAt(p.pos.x, p.pos.y + p.eyeHeight, p.pos.z);
  }
}

export class IdleLookGoal extends Goal {
  get flags() { return LOOK; }
  canStart() {
    if (this.mob.world.rng() >= 1 / 50) return false;
    const a = this.mob.world.rng() * Math.PI * 2;
    this.dir = { x: -Math.sin(a), z: -Math.cos(a) };
    this.duration = 20 + Math.floor(this.mob.world.rng() * 21);
    return true;
  }
  shouldContinue() { return --this.duration > 0; }
  tick() {
    const m = this.mob;
    m.lookAt(m.pos.x + this.dir.x * 4, m.pos.y + m.height * 0.85, m.pos.z + this.dir.z * 4);
  }
}

export class MeleeAttackGoal extends Goal {
  canStart() { return !!this.mob.target; }
  tick() {
    const m = this.mob, t = m.target;
    if (!t) return;
    m.lookAt(t.pos.x, t.pos.y + t.height * 0.85, t.pos.z);
    m.chaseTarget(t);
    const dist = m.centerDistTo(t);
    if (dist <= m.attackReach && m.attackCooldown <= 0 && m.canSee(t)) {
      m.doMeleeAttack(t);
      m.attackCooldown = 20;
    }
  }
  stop() { this.mob.clearPath(); }
}

export class PanicGoal extends Goal {
  constructor(mob, mult) { super(mob); this.mult = mult; }
  canStart() { return this.mob.hurtTimer > 0; }
  shouldContinue() { return this.mob.hurtTimer > 0; }
  tick() {
    const m = this.mob, w = m.world;
    if (!m.path) {
      const a = w.rng() * Math.PI * 2;
      const d = 5 + w.rng() * 3;
      const x = Math.floor(m.pos.x + Math.cos(a) * d);
      const z = Math.floor(m.pos.z + Math.sin(a) * d);
      let y = Math.floor(m.pos.y);
      for (let dy = 4; dy >= -4; dy--) {
        if (standable(w, x, y + dy, z, m)) { y += dy; break; }
      }
      m.pathTo(x, y, z, m.walkSpeed * this.mult);
    }
    m.followPath(m.walkSpeed * this.mult);
  }
  stop() { this.mob.clearPath(); }
}

export class TemptGoal extends Goal {
  constructor(mob, foodIds) { super(mob); this.foodIds = foodIds; }
  playerHoldingFood() {
    const p = this.mob.world.game?.player;
    if (!p || p.dead) return null;
    const held = p.heldStack;
    return held && this.foodIds.includes(held.id) ? p : null;
  }
  canStart() {
    const p = this.playerHoldingFood();
    return p && this.mob.distTo(p) <= 10;
  }
  shouldContinue() {
    const p = this.playerHoldingFood();
    return p && this.mob.distTo(p) <= 12;
  }
  tick() {
    const m = this.mob;
    const p = this.playerHoldingFood();
    if (!p) return;
    m.lookAt(p.pos.x, p.pos.y + p.eyeHeight, p.pos.z);
    if (m.distTo(p) > 2.5) {
      m.chaseTarget(p, m.walkSpeed * 1.1);
    } else {
      m.clearPath();
      m.moveIntent = null;
    }
  }
  stop() { this.mob.clearPath(); }
}

export class FollowParentGoal extends Goal {
  canStart() {
    const m = this.mob;
    if (!m.isBaby) return false;
    const near = m.world.getEntitiesInBox(m.getAABB().expand(16, 8, 16),
      e => e.type === m.type && !e.isBaby && !e.dead);
    if (!near.length) return false;
    this.parent = near[0];
    return m.distTo(this.parent) > 3;
  }
  shouldContinue() {
    return this.parent && !this.parent.dead && this.mob.distTo(this.parent) > 3;
  }
  tick() { this.mob.chaseTarget(this.parent, this.mob.walkSpeed * 1.1); }
  stop() { this.mob.clearPath(); this.parent = null; }
}

export class BreedGoal extends Goal {
  canStart() { return this.mob.loveTicks > 0; }
  shouldContinue() { return this.mob.loveTicks > 0; }
  start() { this.kissTicks = 0; }
  tick() {
    const m = this.mob, w = m.world;
    if (!m.mate || m.mate.dead || m.mate.loveTicks <= 0) {
      m.mate = null;
      if (m.age % 10 === 0) {
        const near = w.getEntitiesInBox(m.getAABB().expand(8, 4, 8),
          e => e !== m && e.type === m.type && !e.isBaby && e.loveTicks > 0 && !e.dead);
        if (near.length) { m.mate = near[0]; near[0].mate = m; }
      }
    }
    if (!m.mate) return;
    m.chaseTarget(m.mate, m.walkSpeed * 1.1);
    if (m.distTo(m.mate) < 1.5 && ++this.kissTicks >= 60) {
      const mate = m.mate;
      const bx = (m.pos.x + mate.pos.x) / 2, by = m.pos.y, bz = (m.pos.z + mate.pos.z) / 2;
      w.game?.spawnMobAt(m.type, bx, by, bz, { isBaby: true, persistent: true });
      w.game?.spawnXpOrb(bx, by + 0.5, bz, 1 + Math.floor(w.rng() * 7));
      for (const par of [m, mate]) {
        par.loveTicks = 0;
        par.breedCooldown = 6000;
        par.mate = null;
      }
    }
  }
  stop() { this.kissTicks = 0; this.mob.clearPath(); }
}

export class EatGrassGoal extends Goal {
  canStart() {
    const m = this.mob, w = m.world;
    const chance = m.isBaby ? 1 / 50 : 1 / 1000;
    if (w.rng() >= chance) return false;
    const x = Math.floor(m.pos.x), y = Math.floor(m.pos.y), z = Math.floor(m.pos.z);
    return w.getBlock(x, y, z) === B.SHORT_GRASS || w.getBlock(x, y - 1, z) === B.GRASS_BLOCK;
  }
  start() { this.timer = 40; this.mob.eating = true; }
  shouldContinue() { return this.timer > 0; }
  tick() {
    const m = this.mob, w = m.world;
    m.moveIntent = null;
    if (--this.timer === 0) {
      const x = Math.floor(m.pos.x), y = Math.floor(m.pos.y), z = Math.floor(m.pos.z);
      if (w.getBlock(x, y, z) === B.SHORT_GRASS) w.removeBlock(x, y, z);
      else if (w.getBlock(x, y - 1, z) === B.GRASS_BLOCK) w.setBlock(x, y - 1, z, B.DIRT);
      m.onAteGrass?.();
    }
  }
  stop() { this.mob.eating = false; }
}

export class FleeSunGoal extends Goal {
  canStart() {
    const m = this.mob;
    return m.fireTicks > 0 && m.world.skyDarken < 4 &&
      m.world.canSeeSky(m.pos.x, Math.floor(m.pos.y + m.height), m.pos.z);
  }
  start() {
    const m = this.mob, w = m.world;
    for (let i = 0; i < 10; i++) {
      const x = Math.floor(m.pos.x) + Math.floor(w.rng() * 21) - 10;
      const z = Math.floor(m.pos.z) + Math.floor(w.rng() * 21) - 10;
      let y = Math.floor(m.pos.y);
      let found = false;
      for (let dy = 2; dy >= -5; dy--) {
        if (standable(w, x, y + dy, z, m)) { y += dy; found = true; break; }
      }
      if (!found) continue;
      if (!w.canSeeSky(x, y, z) || BLOCKS[w.getBlock(x, y, z)].fluid === 'water') {
        m.pathTo(x, y, z, m.chaseSpeed);
        return;
      }
    }
  }
  shouldContinue() { return this.mob.fireTicks > 0 && !!this.mob.path; }
  tick() { this.mob.followPath(this.mob.chaseSpeed); }
  stop() { this.mob.clearPath(); }
}

export { hasLineOfSight };
