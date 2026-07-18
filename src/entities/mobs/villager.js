// 12-VILLAGES §8–§11 — Villager (professions + trading), IronGolem (village
// defense), ZombieVillager (curing). Trading's librarian rows source enchanted
// books through E4's randomEnchantedBook; curing uses E9's Weakness effect.
import { Mob } from './Mob.js';
import { Zombie } from './Zombie.js';
import { SwimGoal, WanderGoal, LookAtPlayerGoal, IdleLookGoal, MeleeAttackGoal, PanicGoal } from './ai.js';
import { humanoidModel } from './models.js';
import { splitmix32 } from '../../math/rng.js';
import { rng32 } from '../../items/xp.js';
import { randomEnchantedBook } from '../../items/enchanting.js';
import { CATALOG } from '../../items/enchants.js';
import { EFFECT, hasEffect } from '../../status/effects.js';
import { cloneStack } from '../../items/tags.js';
import { idOf } from '../../registry/items.js';
import { emitSound, at } from '../../audio/engine.js';

const EMERALD = 435, BOOK = 341, ENCHANTED_BOOK = 346;
// station block id → profession (§8.2)
export const STATION_PROFESSION = {
  174: 'librarian', 172: 'farmer', 112: 'cleric', 175: 'armorer',
  143: 'toolsmith', 107: 'weaponsmith', 177: 'butcher', 179: 'fletcher',
};
const XP_THRESHOLDS = [0, 10, 70, 150, 250];   // Novice..Master (§9.1)

// §9 — per-profession trade pools by tier. Each entry: [buyA, buyB|null, sell, maxUses, xp].
// (id, count) tuples; a representative subset of the §9 tables. Librarian's book
// rows are generated dynamically (§9.3).
const TRADES = {
  farmer: [
    [[336, 20], null, [EMERALD, 1], 16, 2], [[316, 26], null, [EMERALD, 1], 16, 2],
    [[EMERALD, 1], null, [305, 6], 16, 1], [[EMERALD, 3], null, [377, 3], 12, 30],
  ],
  cleric: [
    [[314, 32], null, [EMERALD, 1], 16, 2], [[EMERALD, 1], null, [342, 2], 12, 1],
    [[EMERALD, 5], null, [334, 1], 12, 15], [[EMERALD, 4], null, [32, 1], 12, 30],
  ],
  armorer: [[[EMERALD, 5], null, [322, 4], 16, 2], [[EMERALD, 12], null, [301, 1], 3, 30]],  // iron ingot / diamond chest
  toolsmith: [[[EMERALD, 6], null, [325, 1], 12, 5], [[EMERALD, 8], null, [277, 1], 3, 30]],
  weaponsmith: [[[EMERALD, 7], null, [276, 1], 12, 5], [[EMERALD, 12], null, [325, 1], 3, 30]],
  butcher: [[[309, 10], null, [EMERALD, 1], 16, 2], [[EMERALD, 1], null, [307, 5], 16, 1]],
  fletcher: [[[327, 16], null, [EMERALD, 1], 16, 2], [[EMERALD, 1], null, [282, 16], 12, 1]],
};

function mkTrade(buyA, buyB, sell, maxUses, xp) {
  return {
    buyA: { id: buyA[0], count: buyA[1] }, buyB: buyB ? { id: buyB[0], count: buyB[1] } : null,
    sell: { id: sell[0], count: sell[1], ...(sell[2] ? { tags: sell[2] } : {}) },
    maxUses, uses: 0, xp, specialPrice: 0,
  };
}

// §9.3 — a librarian enchanted-book offer via E4's helper. Deterministic from
// (villagerSeed, tradeSlot). cost = 2 + 3·enchLevel, doubled for treasure, [5,64].
function librarianBookTrade(villagerSeed, tradeSlot) {
  const seedRng = splitmix32((villagerSeed ^ (tradeSlot * 0x9e3779b9)) >>> 0);
  const lvl = 5 + Math.floor(seedRng() * 15);                       // 5–19
  const book = randomEnchantedBook(rng32((villagerSeed ^ tradeSlot) >>> 0), lvl, true);
  if (!book) return null;
  const primary = book.tags.enchants.reduce((a, b) => (b.lvl > a.lvl ? b : a), book.tags.enchants[0]);
  const meta = CATALOG.find(e => e.id === primary.id);
  const treasure = !!meta?.treasure;
  let cost = 2 + 3 * primary.lvl; if (treasure) cost *= 2;
  cost = Math.max(5, Math.min(64, cost));
  return mkTrade([EMERALD, cost], [BOOK, 1], [ENCHANTED_BOOK, 1, book.tags], 12, treasure ? 30 : 5);
}

export function generateTrades(profession, seed) {
  if (!profession || profession === 'nitwit' || profession === 'none') return [];
  if (profession === 'librarian') {
    const out = [
      mkTrade([340, 24], null, [EMERALD, 1], 16, 2),      // 24 paper → 1 emerald
      mkTrade([EMERALD, 9], null, [50, 1], 12, 1),        // 9 emerald → bookshelf
    ];
    for (let slot = 0; slot < 4; slot++) { const t = librarianBookTrade(seed, slot); if (t) out.push(t); }
    return out;
  }
  return (TRADES[profession] ?? []).map(t => mkTrade(...t));
}

export class Villager extends Mob {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z);
    this.type = 'villager';
    this.hostile = false; this.persistent = true; this.retaliates = false;
    this.width = 0.6; this.height = 1.95;
    this.health = this.maxHealth = 20;
    this.walkSpeed = this.chaseSpeed = 0.12;
    this.xpValue = 0; this.detectionRange = 0;
    this.profession = opts.profession ?? 'none';
    this.nitwit = opts.nitwit ?? (world.rng() < 0.05);
    this.level = 1; this.villagerXP = 0;
    this.workstation = null; this.bed = null; this.homeVillage = opts.homeVillage ?? null;
    this.foodPoints = 0; this.curedDiscount = opts.curedDiscount ?? 0;
    this.seed = opts.seed ?? ((world.rng() * 0xffffffff) >>> 0);
    this.trades = opts.trades ?? (this.profession !== 'none' ? generateTrades(this.profession, this.seed) : []);
    if (opts.isBaby) { this.isBaby = true; this.adultWidth = 0.6; this.adultHeight = 1.95; this.width = 0.3; this.height = 0.975; this.ageTicks = opts.ageTicks ?? 6000; }
    this.goals = [new SwimGoal(this), new PanicGoal(this, 1.6), new WanderGoal(this), new LookAtPlayerGoal(this, 8), new IdleLookGoal(this)];
  }

  // §8.3 — claim a profession from an adjacent workstation block.
  claimStation() {
    if (this.profession !== 'none' || this.nitwit || this.isBaby) return;
    const w = this.world, px = Math.floor(this.pos.x), py = Math.floor(this.pos.y), pz = Math.floor(this.pos.z);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) {
      const prof = STATION_PROFESSION[w.getBlock(px + dx, py + dy, pz + dz)];
      if (prof) { this.profession = prof; this.workstation = [px + dx, py + dy, pz + dz]; this.trades = generateTrades(prof, this.seed); return; }
    }
  }

  tick() {
    super.tick();
    if (this.dead) return;
    if (this.profession === 'none' && !this.nitwit && !this.isBaby && this.age % 40 === 0) this.claimStation();
  }

  // §9.1 — RMB opens the trade screen (not baby, not fleeing).
  interact(player) {
    if (this.isBaby || this.hurtTimer > 0) return false;
    this.world.game?.openTrade?.(this);
    return true;
  }

  // §9.1 — execute trade index i for the player. Returns true if completed.
  doTrade(i, player) {
    const t = this.trades[i];
    if (!t || t.uses >= t.maxUses) return false;
    const cost = a => a.id === EMERALD ? Math.max(1, a.count + t.specialPrice) : a.count;
    const has = a => !a || countItem(player, a.id) >= cost(a);
    if (!has(t.buyA) || !has(t.buyB)) return false;
    takeItem(player, t.buyA.id, cost(t.buyA));
    if (t.buyB) takeItem(player, t.buyB.id, cost(t.buyB));
    // give() returns the leftover count; throw only the leftover, not the whole
    // stack, or a partial merge duplicates items.
    const give = cloneStack(t.sell); const left = player.give(give);
    if (left > 0) this.world.game?.throwStack?.({ ...give, count: left });
    t.uses++; this.villagerXP += t.xp;
    // level up; §9.4 — a cured villager (curedDiscount>0) also cheapens its
    // emerald-cost trades. Plain leveling carries no discount.
    while (this.level < 5 && this.villagerXP >= XP_THRESHOLDS[this.level]) {
      this.level++;
      if (this.curedDiscount > 0) {
        for (const tr of this.trades) {
          if (tr.buyA.id !== EMERALD) continue;
          const disc = Math.max(1, Math.round(tr.buyA.count * Math.min(0.3 * this.curedDiscount, 0.85)));
          tr.specialPrice = Math.min(tr.specialPrice, -disc);
        }
      }
    }
    emitSound('villager.trade', at(this.pos.x, this.pos.y + 1, this.pos.z));
    return true;
  }

  buildModel() { return humanoidModel('villager_skin', 'villager_face', { shirt: 'villager_robe', pants: 'villager_robe' }); }

  serialize() {
    return { ...super.serialize(), profession: this.profession, nitwit: this.nitwit, level: this.level, villagerXP: this.villagerXP,
      workstation: this.workstation, bed: this.bed, homeVillage: this.homeVillage, curedDiscount: this.curedDiscount, seed: this.seed, trades: this.trades };
  }
  deserialize(rec) { super.deserialize(rec); Object.assign(this, { profession: rec.profession ?? 'none', nitwit: !!rec.nitwit, level: rec.level ?? 1, villagerXP: rec.villagerXP ?? 0, workstation: rec.workstation ?? null, bed: rec.bed ?? null, homeVillage: rec.homeVillage ?? null, curedDiscount: rec.curedDiscount ?? 0, seed: rec.seed ?? this.seed, trades: rec.trades ?? this.trades }); }
}

export class IronGolem extends Mob {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z);
    this.type = 'iron_golem';
    this.hostile = false; this.persistent = true; this.retaliates = false;
    this.width = 1.4; this.height = 2.7;
    this.health = this.maxHealth = 100;
    this.walkSpeed = this.chaseSpeed = 0.125;
    this.attackReach = 2.4; this.attackDamage = 14;
    this.detectionRange = 16; this.xpValue = 0;
    this.takesFallDamage = false;                 // §11.1 fall immune
    this.homeVillage = opts.homeVillage ?? null;
    this.goals = [new SwimGoal(this), new MeleeAttackGoal(this), new WanderGoal(this), new IdleLookGoal(this)];
  }

  knockbackResistance() { return 1.0; }           // §11.1 immune (AMENDS 05 §2)

  // §11.3 — target the nearest hostile (NOT creeper) within 16 of the golem.
  updateTarget() {
    if (this.target && (this.target.dead || this.distTo(this.target) > 24)) this.target = null;
    if (this.target || this.age % 10 !== 0) return;
    let best = null, bd = 16;
    for (const e of this.world.getEntitiesInBox(this.getAABB().expand(16, 8, 16),
      e => e.type === 'zombie' || e.type === 'zombie_villager' || e.type === 'spider' || e.type === 'skeleton' || e.type === 'wither_skeleton')) {
      const d = this.distTo(e); if (d < bd) { bd = d; best = e; }
    }
    this.target = best;
  }

  doMeleeAttack(t) {
    const dx = t.pos.x - this.pos.x, dz = t.pos.z - this.pos.z, h = Math.hypot(dx, dz) || 1;
    const dmg = 7 + Math.floor(this.world.rng() * 15);   // 7–21
    t.hurt(dmg, 'melee', { dirX: dx / h, dirZ: dz / h, knockback: 0.8, attacker: this });
    if (t.vel) t.vel.y += 0.4;                            // §11.1 toss
    this.attackAnim = 0;
  }

  dropTable() { return [{ name: 'iron_ingot', count: 3 + Math.floor(this.world.rng() * 3) }, { name: 'poppy', count: Math.floor(this.world.rng() * 3) }]; }

  buildModel() { const m = humanoidModel('iron_golem', 'iron_golem', {}); if (m.group) m.group.scale.set(1.6, 1.5, 1.6); return m; }

  serialize() { return { ...super.serialize(), homeVillage: this.homeVillage }; }
  deserialize(rec) { super.deserialize(rec); this.homeVillage = rec.homeVillage ?? null; }
}

export class ZombieVillager extends Zombie {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    this.type = 'zombie_villager';
    this.profession = opts.profession ?? 'none';
    this.level = opts.level ?? 1; this.villagerXP = opts.villagerXP ?? 0;
    this.trades = opts.trades ?? null;
    this.converting = false; this.convertTimer = 0; this.curedDiscount = opts.curedDiscount ?? 0;
  }

  // §11.5 — RMB a WEAKENED zombie villager with a golden_apple starts the cure.
  interact(player) {
    const held = player.heldItem?.() ?? (player.heldStack ? player.world.game?.ITEMS?.get?.(player.heldStack.id) : null);
    if (!held || held.name !== 'golden_apple') return false;
    if (!hasEffect(this, EFFECT.WEAKNESS) || this.converting) return false;
    player.consumeIn?.('main', 1);
    this.converting = true;
    this.convertTimer = 3600 + Math.floor(this.world.rng() * 2401);   // 3–5 min
    emitSound('zombie_villager.converting', at(this.pos.x, this.pos.y + 1, this.pos.z));
    return true;
  }

  tick() {
    super.tick();
    if (this.dead || !this.converting) return;
    if (this.age % 20 === 0) this.world.game?.particles?.effectCloud?.(this.pos.x, this.pos.y + 1, this.pos.z, 0.5, 0xff4040);
    if (--this.convertTimer <= 0) this.finishCure();
  }

  finishCure() {
    const g = this.world.game;
    const v = g.spawnMobAt?.('villager', this.pos.x, this.pos.y, this.pos.z, {
      profession: this.profession, trades: this.trades, curedDiscount: this.curedDiscount + 1, persistent: true,
    });
    if (v) { v.level = this.level; v.villagerXP = this.villagerXP; }
    this.dead = true;
    emitSound('zombie_villager.cure', at(this.pos.x, this.pos.y + 1, this.pos.z));
    g.particles?.effectCloud?.(this.pos.x, this.pos.y + 1, this.pos.z, 1.5, 0x40ff40);
  }

  buildModel() { const m = humanoidModel('zombie_skin', 'zombie_face', { shirt: 'villager_robe', pants: 'zombie_pants' }); m.parts.armL.rotation.x = -Math.PI / 2; m.parts.armR.rotation.x = -Math.PI / 2; return m; }

  serialize() { return { ...super.serialize(), profession: this.profession, level: this.level, villagerXP: this.villagerXP, trades: this.trades, converting: this.converting, convertTimer: this.convertTimer, curedDiscount: this.curedDiscount }; }
  deserialize(rec) { super.deserialize(rec); Object.assign(this, { profession: rec.profession ?? 'none', level: rec.level ?? 1, villagerXP: rec.villagerXP ?? 0, trades: rec.trades ?? null, converting: !!rec.converting, convertTimer: rec.convertTimer ?? 0, curedDiscount: rec.curedDiscount ?? 0 }); }
}

// inventory helpers
function countItem(p, id) { let n = 0; for (const s of p.inventory) if (s && s.id === id) n += s.count; return n; }
function takeItem(p, id, need) { for (let i = 0; i < p.inventory.length && need > 0; i++) { const s = p.inventory[i]; if (s && s.id === id) { const take = Math.min(s.count, need); s.count -= take; need -= take; if (s.count <= 0) p.inventory[i] = null; } } }
