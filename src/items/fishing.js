// B4 — fishing catch rolls + bite timing (19-BUILDOUT §B4). PURE: every fn
// takes its rng, so U17 pins the distributions and the bobber/interaction
// layers stay thin. Items are resolved by NAME at the call site (idOf), never
// here — this module must stay registry-free for node testing.
//
// Catch categories: fish 85% (cod 60 / salmon 25 / tropical 10 / pufferfish 5
// of the fish roll), treasure 10% — 15% with the open-water bonus — junk the
// remainder. Open water = no solid/fluid in the 5×4×5 box above the hook
// (computed by the caller; bobber state machine owns the geometry).

const FISH = [
  ['raw_cod', 60], ['raw_salmon', 25], ['tropical_fish', 10], ['pufferfish', 5],
];
const TREASURE = [
  ['book', 30, 'enchanted'], ['bow', 25], ['fishing_rod', 20, 'damaged'],
  ['emerald', 10], ['gold_ingot', 10], ['iron_ingot', 5],
];
const JUNK = [
  ['stick', 25], ['string', 20], ['bone', 15], ['rotten_flesh', 15],
  ['leather', 10], ['glass_bottle', 10], ['feather', 5],
];

function pick(rng, table) {
  let total = 0;
  for (const e of table) total += e[1];
  let r = rng() * total;
  for (const e of table) { if (r < e[1]) return e; r -= e[1]; }
  return table[table.length - 1];
}

/** @returns {{category:'fish'|'treasure'|'junk', item:string, count:number, meta?:object}} */
export function rollCatch(rng, openWater) {
  const treasureChance = openWater ? 0.15 : 0.10;
  const r = rng();
  if (r < 0.85) {
    const [item] = pick(rng, FISH);
    return { category: 'fish', item, count: 1 };
  }
  if (r < 0.85 + treasureChance) {
    const [item, , tag] = pick(rng, TREASURE);
    // enchanted books arrive as a tags-shaped stack the caller enchants; the
    // damaged rod arrives at half durability
    return { category: 'treasure', item, count: 1, meta: tag };
  }
  const [item] = pick(rng, JUNK);
  return { category: 'junk', item, count: item === 'string' ? 2 : 1 };
}

/** Ticks until the next bite. Open water halves the wait (MC Lure-less parity). */
export function biteDelay(rng, openWater) {
  const base = 100 + Math.floor(rng() * 200);       // 5–15 s
  return openWater ? Math.floor(base / 2) : base;
}
