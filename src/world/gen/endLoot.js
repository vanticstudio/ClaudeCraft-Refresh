// 11-END §15 — loot tables for gen-placed chests (stronghold altar/library, end
// city). Rolled on the MAIN thread (needs the registry + 08's enchant helpers),
// seeded by chest position so save/reload is stable. Enchanted books/gear use
// 08-ENCHANTING's real enchant selection (levels per §15).
import { idOf, ITEMS } from '../../registry/items.js';
import { hashString, mix32, splitmix32 } from '../../math/rng.js';
import { rng32 } from '../../items/xp.js';
import { randomEnchantedBook, selectEnchants, applyOffer } from '../../items/enchanting.js';

const id = n => { try { return idOf(n); } catch { return null; } };
const iri = (rng, a, b) => a + Math.floor(rng() * (b - a + 1));

// §15.1/§15.2/§15.3 pools. Each entry: [name, weight, min, max].
const POOLS = {
  stronghold: { rolls: [2, 3], pool: [
    ['ender_pearl', 10, 1, 1], ['diamond', 3, 1, 3], ['iron_ingot', 10, 1, 5], ['gold_ingot', 5, 1, 3],
    ['redstone', 8, 4, 9], ['bread', 15, 1, 3], ['apple', 15, 1, 3], ['iron_pickaxe', 5, 1, 1],
  ], book: [20, 30] },
  stronghold_library: { rolls: [2, 10], pool: [
    ['book', 20, 1, 3], ['paper', 20, 2, 7],
  ], book: [20, 30] },
  end_city: { rolls: [2, 6], pool: [
    ['gold_ingot', 15, 2, 7], ['iron_ingot', 10, 4, 8], ['diamond', 5, 2, 7], ['emerald', 2, 2, 6],
    // enchanted gear (§15.3, levels 20-39) — resolved specially below
    ['@ench_diamond', 21, 1, 1], ['@ench_iron', 21, 1, 1],
  ] },
  // §15.4 — the ship's elytra chest: 1 guaranteed elytra + 3 end_city rolls.
  end_ship: { rolls: [3, 3], guaranteed: 'elytra', pool: [
    ['gold_ingot', 15, 2, 7], ['iron_ingot', 10, 4, 8], ['diamond', 5, 2, 7], ['emerald', 2, 2, 6],
    ['@ench_diamond', 21, 1, 1], ['@ench_iron', 21, 1, 1],
  ] },
  // B5 — overworld dungeon chests: mid-tier utility + a chance at early enchants
  dungeon: { rolls: [3, 6], pool: [
    ['bread', 15, 1, 4], ['apple', 12, 1, 3], ['iron_ingot', 10, 1, 4], ['gold_ingot', 6, 1, 3],
    ['redstone', 10, 2, 6], ['string', 10, 1, 4], ['bone', 10, 1, 4], ['rotten_flesh', 8, 1, 3],
    ['bucket', 5, 1, 1], ['iron_pickaxe', 4, 1, 1], ['iron_sword', 4, 1, 1],
    ['emerald', 2, 1, 2], ['diamond', 2, 1, 2], ['gold_nugget', 8, 2, 6],
  ], book: [15, 25] },
  // B5 — desert ruin chest: emerald/gold weighted, rare enchanted gear
  desert_ruin: { rolls: [2, 4], pool: [
    ['emerald', 12, 1, 3], ['gold_ingot', 12, 1, 4], ['gold_nugget', 10, 2, 5],
    ['iron_ingot', 8, 1, 3], ['bread', 10, 1, 2], ['apple', 8, 1, 2],
    ['@ench_iron', 6, 1, 1],
  ] },
};
const DIAMOND_GEAR = ['diamond_sword', 'diamond_pickaxe', 'diamond_shovel', 'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'];
const IRON_GEAR = ['iron_sword', 'iron_pickaxe', 'iron_shovel', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];

function pickWeighted(rng, pool) {
  const total = pool.reduce((s, e) => s + e[1], 0);
  let r = rng() * total;
  for (const e of pool) { if (r < e[1]) return e; r -= e[1]; }
  return pool[0];
}

function enchantedGear(name, level, erng) {
  const gid = id(name);
  if (gid == null) return null;
  const stack = { id: gid, count: 1 };
  const picked = selectEnchants(erng, stack, level, true);
  return picked.length ? applyOffer(stack, picked) : stack;
}

/**
 * Fill `slots` (27-wide) from `table` deterministically. worldSeed may be a
 * string or int; (x,y,z) makes each chest unique.
 */
export function rollChestLoot(slots, table, worldSeed, x, y, z) {
  const cfg = POOLS[table] || POOLS.stronghold;
  const ws = typeof worldSeed === 'number' ? (worldSeed >>> 0) : hashString(String(worldSeed ?? ''));
  const seed = mix32(ws ^ mix32((x * 374761393) ^ (y * 668265263) ^ (z * 2246822519)));
  const rng = splitmix32(seed);
  const erng = rng32(seed ^ 0xa5a5);
  const free = [];
  for (let i = 0; i < slots.length; i++) if (!slots[i]) free.push(i);
  const place = stack => { if (stack && free.length) { const k = Math.floor(rng() * free.length); slots[free.splice(k, 1)[0]] = stack; } };

  const nRolls = iri(rng, cfg.rolls[0], cfg.rolls[1]);
  for (let r = 0; r < nRolls; r++) {
    const [name, , mn, mx] = pickWeighted(rng, cfg.pool);
    if (name === '@ench_diamond' || name === '@ench_iron') {
      const gearList = name === '@ench_diamond' ? DIAMOND_GEAR : IRON_GEAR;
      const g = gearList[Math.floor(rng() * gearList.length)];
      place(enchantedGear(g, 20 + Math.floor(rng() * 20), erng));   // levels 20-39
    } else {
      const iid = id(name);
      if (iid != null) place({ id: iid, count: iri(rng, mn, mx) });
    }
  }
  // guaranteed enchanted book for strongholds (§15.1/§15.2)
  if (cfg.book) {
    const book = randomEnchantedBook(erng, cfg.book[0] + Math.floor(rng() * (cfg.book[1] - cfg.book[0] + 1)), true);
    if (book) place(book);
  }
  // §15.4 — a guaranteed item (the ship's elytra, full durability)
  if (cfg.guaranteed) { const gid = id(cfg.guaranteed); if (gid != null) place({ id: gid, count: 1 }); }
}
