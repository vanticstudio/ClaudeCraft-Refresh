// Creative-inventory tab set + classifier (18 §6.2).
// AMENDS 06 §15.4 — this replaces the F4 debug item palette wholesale.
//
// Allocates NOTHING: every entry here is an EXISTING registry id, enumerated
// from the live registries at boot. The tab strip is UI chrome, not registry
// data (18 §0).
import { BLOCKS, B } from '../registry/blocks.js';
import { ITEMS } from '../registry/items.js';
import { isIngredient } from '../status/potions.js';

export const TAB = {
  BUILDING: 'building',
  DECORATION: 'decoration',
  REDSTONE: 'redstone',
  TOOLS: 'tools',
  COMBAT: 'combat',
  FOOD: 'food',
  BREWING: 'brewing',
  MISC: 'misc',
  SEARCH: 'search',
  INVENTORY: 'inventory',
};

// §6.2's ten tabs, in order. `icon` is a representative id; `glyph` is used for
// the two tabs that show no registry entry of their own.
export const TABS = [
  { id: TAB.BUILDING, label: 'Building Blocks', icon: B.STONE },
  { id: TAB.DECORATION, label: 'Decoration', icon: B.POPPY },
  { id: TAB.REDSTONE, label: 'Redstone', icon: 342 },
  { id: TAB.TOOLS, label: 'Tools & Utilities', icon: 267 },
  { id: TAB.COMBAT, label: 'Combat', icon: 266 },
  { id: TAB.FOOD, label: 'Food', icon: 304 },
  { id: TAB.BREWING, label: 'Brewing', icon: 373 },
  { id: TAB.MISC, label: 'Ingredients / Misc', icon: 318 },
  { id: TAB.SEARCH, label: 'Search', glyph: '⌕' },
  { id: TAB.INVENTORY, label: 'Survival Inventory', glyph: '☰' },
];

// ---------------------------------------------------------------------------
// The small id-lists §6.2 names. Each is DERIVED from the live registry over its
// owning expansion's id range (18 "Registry footprint"), so an id a later phase
// registers lands in its tab without this file being edited again.
// ---------------------------------------------------------------------------

// §6.2 tab 3 — "every id 07 registers". 07's ranges are blocks 70–104 (70–89 in
// use) and items 460–469 (07 registers none today). The dust ITEM is base 06's
// 342, which tab 8 names under "redstone/lapis items", so it stays in Misc.
const REDSTONE_BLOCKS = new Set(BLOCKS.filter(b => b && b.id >= 70 && b.id <= 104).map(b => b.id));
const REDSTONE_ITEMS = new Set(
  [...ITEMS.values()].filter(i => i.id >= 460 && i.id <= 469).map(i => i.name));

// §6.2 tab 7 — 09's own item range 370–389 (glass bottle, the three potion forms,
// fermented spider eye…) plus every ingredient 09 §12's live mix() graph names
// that an expansion registered (nether wart, blaze powder, magma cream, ghast
// tear, glowstone dust, dragon's breath). Base-06 ingredients — gunpowder 329,
// sugar 339, redstone 342 — deliberately stay out: §6.2 tab 8 names them under
// Ingredients / Misc. Combat and Food are tested first, so tipped arrow and the
// golden apple/carrot keep the tabs §6.2 files THEM under.
const BREWING_ITEMS = new Set(
  [...ITEMS.values()]
    .filter(i => (i.id >= 370 && i.id <= 389) || (i.id > 345 && isIngredient(i.name)))
    .map(i => i.name));

// §6.2 tab 4 — "crafting_table, furnace, chest … enchanting_table + anvil +
// grindstone (08), brewing_stand (09), smithing_table (10), beacon (13)".
// furnace/chest already carry `blockEntity`, so only crafting_table needs
// naming today; the rest join as their phases land.
const UTILITY_BLOCKS = new Set([B.CRAFTING_TABLE]);

// §6.2 tab 5 lists TNT among Combat's contents, but the block branch of the
// classifier has no rule that would route it there — it would fall through to
// Building. Named explicitly.
const COMBAT_BLOCKS = new Set([B.TNT]);

// §6.2 tab 4 — "shears, flint & steel, buckets (+water/lava)". `shears` also
// has a toolClass, so it matches either way; the rest have none.
const TOOL_ITEMS = new Set(['shears', 'flint_and_steel', 'bucket', 'water_bucket', 'lava_bucket']);

// §6.2 tab 2's contents, verbatim. dirt/grass/sand/gravel and the ore blocks
// carry neither `needsSupport` nor `shape:'cross'`, so without this list the
// pseudocode's fallthrough would file them under Building.
const DECOR_SET = new Set([
  B.DIRT, B.GRASS_BLOCK, B.SAND, B.GRAVEL,
  B.OAK_LEAVES, B.BIRCH_LEAVES, B.SPRUCE_LEAVES,
  B.OAK_SAPLING, B.BIRCH_SAPLING, B.SPRUCE_SAPLING,
  B.DANDELION, B.POPPY, B.SHORT_GRASS,
  B.TORCH, B.LADDER, B.OAK_FENCE,
  B.PUMPKIN, B.JACK_O_LANTERN, B.BOOKSHELF, B.GLOWSTONE,
  // "ores (as blocks)" — §6.2 files the ORES under Decoration and the refined
  // mineral blocks (coal/iron/gold/diamond/redstone/lapis) under Building.
  B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.DIAMOND_ORE, B.REDSTONE_ORE, B.LAPIS_ORE,
]);

// The two-block placers (06 §5.7/§5.13) are items, not block-items, so the
// block branch never sees them — but §6.2 tab 2 lists "door, bed".
const DECOR_ITEMS = new Set(['bed', 'oak_door']);

/** §6.2's block branch. `entry` is a BLOCKS row. */
function blockTab(block) {
  if (REDSTONE_BLOCKS.has(block.id)) return TAB.REDSTONE;
  if (COMBAT_BLOCKS.has(block.id)) return TAB.COMBAT;
  if (block.blockEntity || UTILITY_BLOCKS.has(block.id)) return TAB.TOOLS;
  if (block.shape === 'cross' || block.needsSupport || DECOR_SET.has(block.id)) {
    return TAB.DECORATION;
  }
  return TAB.BUILDING;                       // full opaque structural cubes
}

/**
 * §6.2's classifier — every id lands in EXACTLY one tab, first match wins.
 * `entry` is an ITEMS row (block-items included; they classify by their block).
 */
export function creativeTab(entry) {
  if (entry.kind === 'block' && entry.place != null) return blockTab(BLOCKS[entry.place]);
  if (REDSTONE_ITEMS.has(entry.name)) return TAB.REDSTONE;   // 07's non-placing items

  // Weapons are tested BEFORE tools. §6.2's pseudocode puts `entry.toolClass`
  // first, which assumes toolClass ∈ {pickaxe,axe,shovel,hoe,shears} — but this
  // registry also files swords under toolClass ('sword', items.js:93), so the
  // spec's own order would put every sword in Tools and contradict tab 5's
  // stated contents ("swords, bow, arrow…"). The tab tables are the intent.
  // §6.2 tab 5 lists "tipped arrows (09)" here, ahead of Brewing's claim on 09's
  // item range — it is ammo, not a brewable.
  if (entry.kind === 'sword' || entry.kind === 'bow' || entry.kind === 'armor' ||
      entry.name === 'arrow' || entry.name === 'tipped_arrow') {
    return TAB.COMBAT;
  }
  if (entry.toolClass || TOOL_ITEMS.has(entry.name)) return TAB.TOOLS;
  if (entry.kind === 'food') return TAB.FOOD;
  // §6.2's pseudocode tests `entry.isPotion`, which no registry row carries — the
  // potion FORMS are `kind` values inside 09's item range, so BREWING_ITEMS covers
  // them and the ingredients in one lookup.
  if (BREWING_ITEMS.has(entry.name)) return TAB.BREWING;
  if (DECOR_ITEMS.has(entry.name)) return TAB.DECORATION;
  return TAB.MISC;      // sticks, ingots, gems, pearls, emeralds… (§6.2)
}

let cache = null;

/**
 * Built once at first open by iterating the live registries (§6.2). Returns
 * { byTab: Map<tabId, id[]>, all: id[] }. `debugOnly` is deliberately ignored:
 * 06 §15.4's palette gated on it, and creative grants everything outright.
 */
export function buildPalette() {
  if (cache) return cache;
  const byTab = new Map(TABS.map(t => [t.id, []]));
  const all = [];
  for (const [id, entry] of ITEMS) {
    const tab = creativeTab(entry);
    byTab.get(tab).push(id);
    all.push(id);
  }
  for (const list of byTab.values()) list.sort((a, b) => a - b);
  all.sort((a, b) => a - b);
  cache = { byTab, all };
  return cache;
}

/** §6.2 tab 9 — substring of display name, case-insensitive, over ALL ids. */
export function searchPalette(query) {
  const { all } = buildPalette();
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter(id => (ITEMS.get(id)?.displayName ?? '').toLowerCase().includes(q));
}

/**
 * §6.2 lists ten tabs, but a tab whose expansion has not landed enumerates ids
 * that do not exist yet — an empty tab is noise, and hard-coding the visible set
 * would need editing again per phase. A tab appears exactly when its registry
 * range is populated. Search and Survival Inventory are never registry-driven.
 */
export function visibleTabs() {
  const { byTab } = buildPalette();
  return TABS.filter(t =>
    t.id === TAB.SEARCH || t.id === TAB.INVENTORY || byTab.get(t.id).length > 0);
}
