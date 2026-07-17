// Creative-inventory tab set + classifier (18 §6.2).
// AMENDS 06 §15.4 — this replaces the F4 debug item palette wholesale.
//
// Allocates NOTHING: every entry here is an EXISTING registry id, enumerated
// from the live registries at boot. The tab strip is UI chrome, not registry
// data (18 §0).
import { BLOCKS, B } from '../registry/blocks.js';
import { ITEMS } from '../registry/items.js';

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
// The small static id-lists §6.2 names. Each expansion file owns its own set —
// 07 fills REDSTONE_BLOCKS, 09 fills BREWING_INGREDIENTS — so they are empty
// until those phases land, and the classifier already routes around them.
// ---------------------------------------------------------------------------

const REDSTONE_BLOCKS = new Set();            // 07 (blocks 70–104)
const BREWING_INGREDIENTS = new Set();        // 09 (items 370–389)

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

  // Weapons are tested BEFORE tools. §6.2's pseudocode puts `entry.toolClass`
  // first, which assumes toolClass ∈ {pickaxe,axe,shovel,hoe,shears} — but this
  // registry also files swords under toolClass ('sword', items.js:93), so the
  // spec's own order would put every sword in Tools and contradict tab 5's
  // stated contents ("swords, bow, arrow…"). The tab tables are the intent.
  if (entry.kind === 'sword' || entry.kind === 'bow' || entry.kind === 'armor' ||
      entry.name === 'arrow') {
    return TAB.COMBAT;
  }
  if (entry.toolClass || TOOL_ITEMS.has(entry.name)) return TAB.TOOLS;
  if (entry.kind === 'food') return TAB.FOOD;
  if (entry.isPotion || BREWING_INGREDIENTS.has(entry.name)) return TAB.BREWING;
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
 * §6.2 lists ten tabs, but 07's Redstone and 09's Brewing enumerate ids that do
 * not exist yet — an empty tab today is noise, and hard-coding the visible set
 * would need editing again at E5/E9. A tab appears exactly when its registry
 * range is populated. Search and Survival Inventory are never registry-driven.
 */
export function visibleTabs() {
  const { byTab } = buildPalette();
  return TABS.filter(t =>
    t.id === TAB.SEARCH || t.id === TAB.INVENTORY || byTab.get(t.id).length > 0);
}
