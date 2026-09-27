// 12-VILLAGES §8–§11 — Villager (professions + trading), IronGolem (village
// defense), ZombieVillager (curing). Trading's librarian rows source enchanted
// books through E4's randomEnchantedBook; curing uses E9's Weakness effect.
import { Mob } from './Mob.js';
import { Zombie } from './Zombie.js';
import { SwimGoal, WanderGoal, LookAtPlayerGoal, IdleLookGoal, MeleeAttackGoal, PanicGoal } from './ai.js';
import { humanoidModel } from './models.js';
import { splitmix32 } from '../../math/rng.js';
import { rng32 } from '../../items/xp.js';
import { randomEnchantedBook, selectEnchants, applyOffer } from '../../items/enchanting.js';
import { CATALOG } from '../../items/enchants.js';
import { EFFECT, hasEffect, effectLevel } from '../../status/effects.js';   // B6 §5 — HERO discount
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

// §9 — per-profession trade pools by tier. Each entry:
// [buyA, buyB|null, sell, maxUses, xp, opts?, lvl] with opts = { hi, ench, mult }:
// `hi` makes buyA's count a §9 emerald RANGE [count, hi] rolled from the villager
// seed; `ench` routes the sold stack through 08's selectEnchants (§9.5–§9.7,
// §9.9); `mult` is §9.10's priceMult (0.05 default, 0.2 for enchant rows).
// (id, count) tuples; a representative subset of the §9 tables. Librarian's book
// rows are generated dynamically (§9.3).
// `lvl` (1..5 = Novice..Master) is the §9.2–§9.9 "Lvl" column: doTrade refuses a
// row above the villager's current level, so a fresh Novice no longer offers the
// Master enchanted-diamond rows. Two rows carry a deliberately LOWER tier than
// the spec table (marked below): this file only keeps a subset of each pool, and
// a profession with no Novice row could never earn the XP to unlock anything.
const TRADES = {
  farmer: [
    [[336, 20], null, [EMERALD, 1], 16, 2, {}, 1], [[316, 26], null, [EMERALD, 1], 16, 2, {}, 1],
    [[EMERALD, 1], null, [305, 6], 16, 1, {}, 1], [[EMERALD, 3], null, [377, 3], 12, 30, {}, 5],
  ],
  cleric: [
    [[314, 32], null, [EMERALD, 1], 16, 2, {}, 1], [[EMERALD, 1], null, [342, 2], 12, 1, {}, 1],
    [[EMERALD, 5], null, [334, 1], 12, 15, {}, 4], [[EMERALD, 4], null, [32, 1], 12, 30, {}, 3],
    [[370, 9], null, [EMERALD, 1], 12, 30, {}, 4],     // §9.4 Expert — 09's glass_bottle
    [[390, 22], null, [EMERALD, 1], 12, 30, {}, 5],    // §9.4 Master — 10's nether_wart
  ],
  // §9.5–§9.7 — the Expert/Master smith rows sell ENCHANTED diamond gear.
  armorer: [
    [[319, 15], null, [EMERALD, 1], 16, 2, {}, 1], [[EMERALD, 5], null, [296, 1], 12, 1, {}, 1],
    [[322, 4], null, [EMERALD, 1], 12, 10, {}, 2],
    [[EMERALD, 19], null, [302, 1], 3, 15, { hi: 33, ench: true, mult: 0.2 }, 4],
    [[EMERALD, 13], null, [303, 1], 3, 30, { hi: 27, ench: true, mult: 0.2 }, 5],
  ],
  toolsmith: [
    [[319, 15], null, [EMERALD, 1], 16, 2, {}, 1], [[326, 30], null, [EMERALD, 1], 12, 20, {}, 3],
    [[EMERALD, 6], null, [267, 1], 3, 10, { hi: 20, ench: true, mult: 0.2 }, 3],
    [[325, 1], null, [EMERALD, 1], 12, 30, {}, 4],
    [[EMERALD, 18], null, [277, 1], 3, 30, { hi: 32, ench: true, mult: 0.2 }, 5],
  ],
  weaponsmith: [
    [[319, 15], null, [EMERALD, 1], 16, 2, {}, 1], [[EMERALD, 3], null, [268, 1], 12, 1, {}, 1],
    [[EMERALD, 7], null, [266, 1], 3, 1, { hi: 21, ench: true, mult: 0.2 }, 1],
    [[325, 1], null, [EMERALD, 1], 12, 30, {}, 4],
    [[EMERALD, 13], null, [276, 1], 3, 30, { hi: 27, ench: true, mult: 0.2 }, 5],
  ],
  // beef is §9.8 Journeyman, kept at Novice: it is this pool's only buy row and
  // the butcher would otherwise open with nothing to trade and never level.
  butcher: [[[308, 10], null, [EMERALD, 1], 16, 20, {}, 1], [[EMERALD, 1], null, [307, 5], 16, 1, {}, 2]],
  fletcher: [
    [[327, 16], null, [EMERALD, 1], 16, 2, {}, 1], [[EMERALD, 1], null, [282, 16], 12, 1, {}, 1],
    [[EMERALD, 7], null, [281, 1], 3, 15, { hi: 21, ench: true, mult: 0.2 }, 4],
  ],
};

// §9.5 — enchanted gear rows roll through 08's own selector at level 5–19 with
// treasure excluded, so the sold stack carries real `tags.enchants`.
function enchantTags(itemId, rng) {
  const stack = { id: itemId, count: 1 };
  const picked = selectEnchants(rng, stack, 5 + rng.int(0, 14), false);
  return picked.length ? applyOffer(stack, picked).tags : null;
}

function mkTrade(buyA, buyB, sell, maxUses, xp, opts = {}, seed = 0, slot = 0, lvl = 1) {
  // Distinct from librarianBookTrade's mix so the two seed streams never collide.
  const rng = (opts.hi || opts.ench) ? rng32((seed ^ (slot * 0x85ebca6b)) >>> 0) : null;
  const count = opts.hi ? rng.int(buyA[1], opts.hi) : buyA[1];
  const tags = opts.ench ? enchantTags(sell[0], rng) : (sell[2] ?? null);
  return {
    buyA: { id: buyA[0], count }, buyB: buyB ? { id: buyB[0], count: buyB[1] } : null,
    sell: { id: sell[0], count: sell[1], ...(tags ? { tags } : {}) },
    maxUses, uses: 0, xp, lvl, priceMult: opts.mult ?? 0.05, demand: 0, specialPrice: 0,
  };
}

// §9.3 — a librarian enchanted-book offer via E4's helper. Deterministic from
// (villagerSeed, tradeSlot). cost = 2 + 3·enchLevel, doubled for treasure, [5,64].
function librarianBookTrade(villagerSeed, tradeSlot, tier) {
  const seedRng = splitmix32((villagerSeed ^ (tradeSlot * 0x9e3779b9)) >>> 0);
  const lvl = 5 + Math.floor(seedRng() * 15);                       // 5–19
  const book = randomEnchantedBook(rng32((villagerSeed ^ tradeSlot) >>> 0), lvl, true);
  if (!book) return null;
  const primary = book.tags.enchants.reduce((a, b) => (b.lvl > a.lvl ? b : a), book.tags.enchants[0]);
  const meta = CATALOG.find(e => e.id === primary.id);
  const treasure = !!meta?.treasure;
  let cost = 2 + 3 * primary.lvl; if (treasure) cost *= 2;
  cost = Math.max(5, Math.min(64, cost));
  return mkTrade([EMERALD, cost], [BOOK, 1], [ENCHANTED_BOOK, 1, book.tags], 12, treasure ? 30 : 5, { mult: 0.2 }, 0, 0, tier);
}

export function generateTrades(profession, seed) {
  if (!profession || profession === 'nitwit' || profession === 'none') return [];
  if (profession === 'librarian') {
    const out = [
      mkTrade([340, 24], null, [EMERALD, 1], 16, 2, {}, 0, 0, 1),   // 24 paper → 1 emerald (Novice)
      mkTrade([EMERALD, 9], null, [50, 1], 12, 1, {}, 0, 0, 1),     // 9 emerald → bookshelf (Novice)
    ];
    // §9.3 — the four book slots are Novice / Apprentice / Journeyman / Master.
    const bookLvl = [1, 2, 3, 5];
    for (let slot = 0; slot < 4; slot++) { const t = librarianBookTrade(seed, slot, bookLvl[slot]); if (t) out.push(t); }
    return out;
  }
  return (TRADES[profession] ?? []).map((t, i) => mkTrade(t[0], t[1], t[2], t[3], t[4], t[5] ?? {}, seed, i, t[6] ?? 1));
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
    this.restocksToday = 0; this.lastRestockDay = -1;             // §9.10
    // §11.5 step 4 — the cure discount lands AT CURE TIME, not at some later
    // level-up: finishCure spawns this villager with curedDiscount already set.
    if (this.curedDiscount > 0) this.refreshPrices();
    if (opts.isBaby) { this.isBaby = true; this.adultWidth = 0.6; this.adultHeight = 1.95; this.width = 0.3; this.height = 0.975; this.ageTicks = opts.ageTicks ?? 6000; }
    this.goals = [new SwimGoal(this), new PanicGoal(this, 1.6), new WanderGoal(this), new LookAtPlayerGoal(this, 8), new IdleLookGoal(this)];
  }

  // §8.3 — claim a profession from an adjacent workstation block.
  claimStation() {
    if (this.profession !== 'none' || this.nitwit || this.isBaby) return;
    const w = this.world, px = Math.floor(this.pos.x), py = Math.floor(this.pos.y), pz = Math.floor(this.pos.z);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) {
      const prof = STATION_PROFESSION[w.getBlock(px + dx, py + dy, pz + dz)];
      if (prof) { this.profession = prof; this.workstation = [px + dx, py + dy, pz + dz]; this.trades = generateTrades(prof, this.seed); this.refreshPrices(); return; }
    }
  }

  // §9.10 — effective emerald cost = clamp(base + demandSurcharge + cureDiscount,
  // 1, 64), folded into the one `specialPrice` number doTrade and the trade UI
  // both read. Reputation (§9.10's third term) is not modeled — see the report.
  refreshPrices() {
    const cureFrac = this.curedDiscount > 0 ? Math.min(0.3 * this.curedDiscount, 0.85) : 0;
    for (const t of this.trades) {
      if (t.buyA.id !== EMERALD) { t.specialPrice = 0; continue; }
      const base = t.buyA.count;
      let sp = Math.round(base * (t.priceMult ?? 0.05) * (t.demand ?? 0));
      if (cureFrac > 0) sp -= Math.max(1, Math.round(base * cureFrac));
      t.specialPrice = Math.max(1, Math.min(64, base + sp)) - base;   // MC-exact clamps
    }
  }

  // §9.10 — restock: up to 2×/day, at the workstation, during WORK (T 2000–9000).
  // This is what unlocks used-up trades; without it a trade locks forever.
  tryRestock() {
    const day = Math.floor(this.world.time / 24000), t = this.world.time % 24000;
    if (day !== this.lastRestockDay) { this.restocksToday = 0; this.lastRestockDay = day; }
    if (t < 2000 || t >= 9000 || this.restocksToday >= 2) return;
    // "A jobless-but-locked villager cannot restock until it reclaims one."
    if (!this.workstation || !this.trades.some(tr => tr.uses > 0)) return;
    const [sx, sy, sz] = this.workstation;
    if (Math.abs(this.pos.x - (sx + 0.5)) > 3 || Math.abs(this.pos.z - (sz + 0.5)) > 3
      || Math.abs(this.pos.y - sy) > 3) return;
    for (const tr of this.trades) {
      tr.demand = Math.max(0, (tr.demand ?? 0) + (tr.uses - tr.maxUses / 2));
      tr.uses = 0;
    }
    this.refreshPrices();
    this.restocksToday++;
  }

  tick() {
    super.tick();
    if (this.dead) return;
    if (this.profession === 'none' && !this.nitwit && !this.isBaby && this.age % 40 === 0) this.claimStation();
    if (this.profession !== 'none' && !this.isBaby && this.age % 20 === 0) this.tryRestock();
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
    // §9.1 — a tier's rows unlock only when the villager reaches it. Trades saved
    // before `lvl` existed have none, so an absent field reads as Novice.
    if (!t || (t.lvl ?? 1) > this.level || t.uses >= t.maxUses) return false;
    // B6 §5 — HERO of the Village: % discount on emerald buys. Vanilla's
    // per-level gcd table is not modeled here (no reputation system); instead
    // HERO level L shaves L × 15% off the emerald cost, floor 1 — stacking
    // AFTER the cure discount so both read in one place (doTrade, not
    // refreshPrices: the specialPrice field is the villager's own state, the
    // hero discount is a per-buyer live read off the trading player).
    const heroL = player ? effectLevel(player, EFFECT.HERO) : 0;
    const cost = a => a.id === EMERALD
      ? Math.max(1, Math.round((a.count + t.specialPrice) * (1 - Math.min(0.45, 0.15 * heroL))))
      : a.count;
    const has = a => !a || countItem(player, a.id) >= cost(a);
    if (!has(t.buyA) || !has(t.buyB)) return false;
    takeItem(player, t.buyA.id, cost(t.buyA));
    if (t.buyB) takeItem(player, t.buyB.id, cost(t.buyB));
    // give() returns the leftover count; throw only the leftover, not the whole
    // stack, or a partial merge duplicates items.
    const give = cloneStack(t.sell); const left = player.give(give);
    if (left > 0) this.world.game?.throwStack?.({ ...give, count: left });
    t.uses++; this.villagerXP += t.xp;
    // §9.1 — crossing a threshold levels up AND restocks. Pricing (cure discount
    // + demand) is not level-gated; refreshPrices owns it.
    while (this.level < 5 && this.villagerXP >= XP_THRESHOLDS[this.level]) {
      this.level++;
      for (const tr of this.trades) tr.uses = 0;
    }
    emitSound('villager.trade', at(this.pos.x, this.pos.y + 1, this.pos.z));
    return true;
  }

  buildModel() { return humanoidModel('villager_skin', 'villager_face', { shirt: 'villager_robe', pants: 'villager_robe' }); }

  serialize() {
    return { ...super.serialize(), profession: this.profession, nitwit: this.nitwit, level: this.level, villagerXP: this.villagerXP,
      workstation: this.workstation, bed: this.bed, homeVillage: this.homeVillage, curedDiscount: this.curedDiscount, seed: this.seed, trades: this.trades,
      restocksToday: this.restocksToday, lastRestockDay: this.lastRestockDay };
  }
  deserialize(rec) { super.deserialize(rec); Object.assign(this, { profession: rec.profession ?? 'none', nitwit: !!rec.nitwit, level: rec.level ?? 1, villagerXP: rec.villagerXP ?? 0, workstation: rec.workstation ?? null, bed: rec.bed ?? null, homeVillage: rec.homeVillage ?? null, curedDiscount: rec.curedDiscount ?? 0, seed: rec.seed ?? this.seed, trades: rec.trades ?? this.trades, restocksToday: rec.restocksToday ?? 0, lastRestockDay: rec.lastRestockDay ?? -1 }); }
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
    // §11.1/§11.3 — the golem's attack cooldown is 10 ticks, not the roster's 20.
    this.goals = [new SwimGoal(this), new MeleeAttackGoal(this, 10), new WanderGoal(this), new IdleLookGoal(this)];
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
    // §11.5 step 3 assumes the mob survives the 3–5 minute cure. zombie_villager
    // is in HOSTILE_TYPES and spawns non-persistent, so without this the 05 §4
    // random despawn eats the villager (and the golden apple) ~98% of the time
    // when the player walks 32+ blocks away and waits.
    this.persistent = true;
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
