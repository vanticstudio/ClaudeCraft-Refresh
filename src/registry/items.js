// Canonical item registry (06 §7), crafting recipes (06 §10), smelting (06
// §11.2) and fuel values (06 §11.3). Item ids 256–345; block-items share
// their block's id (0–66).

import { BLOCKS, B } from './blocks.js';
import { cloneTags } from '../items/tags.js';

export const ITEMS = new Map();
export const NAME_TO_ID = new Map();

function defItem(id, name, opts = {}) {
  const displayName = opts.displayName
    ?? name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const item = {
    id, name, displayName,
    stack: 64,
    kind: 'material',
    toolClass: null,
    tier: null,
    speedMult: 1,
    attackDamage: 1,
    attackSpeed: 4.0,       // hand / any non-tool (05 §13.2)
    durability: 0,
    armorSlot: null,
    armorPoints: 0,
    toughness: 0,
    knockbackResistance: 0, // 10-NETHER §9.2 — worn armor sums into entity KB resist
    lavaImmune: false,      // 10-NETHER §9.4 — item entity survives lava/fire, floats on lava
    hunger: 0,
    saturation: 0,
    poisonChance: 0,
    fuel: 0,
    place: null,            // block id placed by right-click
    placesAs: null,         // 'bed' | 'door' (two-block placers)
    plantsCrop: null,       // crop block id for seeds/carrot/potato
    bucketFluid: undefined, // null = empty bucket, 'water' | 'lava'
    sprite: `item_${name}`,
    debugOnly: false,
    ...opts,
  };
  ITEMS.set(id, item);
  if (!NAME_TO_ID.has(name)) NAME_TO_ID.set(name, id);
  return item;
}

// Block-item fuel values (06 §11.3)
const FUEL_BLOCKS = {
  [B.COAL_BLOCK]: 16000,
  [B.OAK_LOG]: 300, [B.BIRCH_LOG]: 300, [B.SPRUCE_LOG]: 300,
  [B.OAK_PLANKS]: 300, [B.BIRCH_PLANKS]: 300, [B.SPRUCE_PLANKS]: 300,
  [B.CRAFTING_TABLE]: 300, [B.CHEST]: 300, [B.BOOKSHELF]: 300,
  [B.LADDER]: 300, [B.OAK_FENCE]: 300,
  [B.OAK_SAPLING]: 100, [B.BIRCH_SAPLING]: 100, [B.SPRUCE_SAPLING]: 100,
  [B.WOOL_WHITE]: 100, [B.WOOL_RED]: 100, [B.WOOL_BLUE]: 100, [B.WOOL_BLACK]: 100,
  // 07-REDSTONE AMENDS 06 §11.3 (§12.2 — note block is wood, fuel 300 t)
  [B.NOTE_BLOCK]: 300,
  // 12-VILLAGES AMENDS 06 §11.3
  [B.BARREL]: 300, [B.LECTERN]: 300, [B.FLETCHING_TABLE]: 300, [B.COMPOSTER]: 300,
};

// --- auto block-items (06 §1) ---
const NO_BLOCK_ITEM = new Set([
  B.AIR, B.WATER, B.LAVA, B.FIRE, B.FURNACE_LIT,
  B.WHEAT_CROP, B.CARROT_CROP, B.POTATO_CROP,
  B.BED_BLOCK, B.OAK_DOOR, B.FARMLAND,
  // 07 §2: wire places from item 342; the lit lamp/piston head place from their
  // base ids, never as their own block-item.
  B.REDSTONE_WIRE, B.REDSTONE_LAMP_LIT, B.PISTON_HEAD,
  // 10-NETHER §1.1 — no survival block-item.
  B.NETHER_PORTAL, B.SPAWNER, B.NETHER_WART,
  // 12-VILLAGES §1.1 — dirt_path is shovel-created; lit variants place from base.
  B.DIRT_PATH, B.BLAST_FURNACE_LIT, B.SMOKER_LIT,
  // 11-END §2.2 — end_portal/end_gateway have no block-item.
  B.END_PORTAL, B.END_GATEWAY,
]);
const DEBUG_ONLY = new Set([B.BEDROCK, B.GLOWSTONE, B.WOOL_RED, B.WOOL_BLUE, B.WOOL_BLACK,
  B.END_PORTAL_FRAME]);   // 11-END §2.2 — frame is debug-palette-only

for (const block of BLOCKS) {
  if (!block || NO_BLOCK_ITEM.has(block.id)) continue;
  defItem(block.id, block.name, {
    displayName: block.displayName,
    kind: 'block',
    place: block.id,
    fuel: FUEL_BLOCKS[block.id] ?? 0,
    sprite: null,
    debugOnly: DEBUG_ONLY.has(block.id),
  });
}

// --- tools & weapons (06 §7.1; attack speed 05 §13.2) ---
const TIERS = {
  wooden: { tier: 0, speedMult: 2, dur: 59 },
  stone:  { tier: 1, speedMult: 4, dur: 131 },
  iron:   { tier: 2, speedMult: 6, dur: 250 },
  golden: { tier: 0, speedMult: 12, dur: 32 },   // gold harvests as tier 0, speed 12
  diamond:{ tier: 3, speedMult: 8, dur: 1561 },
  // 10-NETHER AMENDS 06 §1 — netherite(4), speed ×9, dur 2031 (§9.1)
  netherite: { tier: 4, speedMult: 9, dur: 2031 },
};
const SWORD_DMG = { wooden: 4, stone: 5, iron: 6, golden: 4, diamond: 7, netherite: 8 };
const AXE_DMG = { wooden: 7, stone: 9, iron: 9, golden: 7, diamond: 9, netherite: 10 };
const PICK_DMG = { wooden: 2, stone: 3, iron: 4, golden: 2, diamond: 5, netherite: 6 };
const SHOVEL_DMG = { wooden: 2.5, stone: 3.5, iron: 4.5, golden: 2.5, diamond: 5.5, netherite: 6.5 };
const AXE_SPD = { wooden: 0.8, stone: 0.8, iron: 0.9, golden: 1.0, diamond: 1.0, netherite: 1.0 };
const HOE_SPD = { wooden: 1.0, stone: 2.0, iron: 3.0, golden: 1.0, diamond: 4.0, netherite: 4.0 };

let id = 256;
for (const mat of ['wooden', 'stone', 'iron', 'golden', 'diamond']) {
  const t = TIERS[mat];
  const base = { stack: 1, tier: t.tier, speedMult: t.speedMult, durability: t.dur };
  defItem(id++, `${mat}_sword`, { ...base, kind: 'sword', toolClass: 'sword', speedMult: 1, attackDamage: SWORD_DMG[mat], attackSpeed: 1.6, fuel: mat === 'wooden' ? 200 : 0 });
  defItem(id++, `${mat}_pickaxe`, { ...base, kind: 'tool', toolClass: 'pickaxe', attackDamage: PICK_DMG[mat], attackSpeed: 1.2, fuel: mat === 'wooden' ? 200 : 0 });
  defItem(id++, `${mat}_axe`, { ...base, kind: 'tool', toolClass: 'axe', attackDamage: AXE_DMG[mat], attackSpeed: AXE_SPD[mat], fuel: mat === 'wooden' ? 200 : 0 });
  defItem(id++, `${mat}_shovel`, { ...base, kind: 'tool', toolClass: 'shovel', attackDamage: SHOVEL_DMG[mat], attackSpeed: 1.0, fuel: mat === 'wooden' ? 200 : 0 });
  defItem(id++, `${mat}_hoe`, { ...base, kind: 'tool', toolClass: 'hoe', attackDamage: 1, attackSpeed: HOE_SPD[mat], fuel: mat === 'wooden' ? 200 : 0 });
}
// ids 256–280 consumed above
defItem(281, 'bow', { kind: 'bow', stack: 1, durability: 384, fuel: 300 });
defItem(282, 'arrow', { kind: 'material' });
defItem(283, 'shears', { kind: 'shears', toolClass: 'shears', stack: 1, durability: 238, speedMult: 15, attackDamage: 1 });
defItem(284, 'flint_and_steel', { displayName: 'Flint and Steel', kind: 'flint_and_steel', stack: 1, durability: 64, attackDamage: 1 });
defItem(285, 'bucket', { kind: 'bucket', stack: 16, bucketFluid: null });
defItem(286, 'water_bucket', { kind: 'bucket', stack: 1, bucketFluid: 'water' });
defItem(287, 'lava_bucket', { kind: 'bucket', stack: 1, bucketFluid: 'lava', fuel: 20000 });

// --- armor (06 §7.2) ---
const ARMOR = [
  ['leather', [[55, 1], [80, 3], [75, 2], [65, 1]], 0],
  ['golden',  [[77, 2], [112, 5], [105, 3], [91, 1]], 0],
  ['iron',    [[165, 2], [240, 6], [225, 5], [195, 2]], 0],
  ['diamond', [[363, 3], [528, 8], [495, 6], [429, 3]], 2],
];
const PIECES = ['helmet', 'chestplate', 'leggings', 'boots'];
id = 288;
for (const [mat, pieces, tough] of ARMOR)
  for (let slot = 0; slot < 4; slot++) {
    const [dur, pts] = pieces[slot];
    defItem(id++, `${mat}_${PIECES[slot]}`, {
      kind: 'armor', stack: 1, durability: dur,
      armorSlot: slot, armorPoints: pts, toughness: tough,
    });
  }
// ids 288–303 consumed above

// --- food (06 §7.3) ---
const FOOD = [
  [304, 'apple', 4, 2.4, 0],
  [305, 'bread', 5, 6.0, 0],
  [306, 'porkchop', 3, 1.8, 0, 'Raw Porkchop'],
  [307, 'cooked_porkchop', 8, 12.8, 0],
  [308, 'beef', 3, 1.8, 0, 'Raw Beef'],
  [309, 'cooked_beef', 8, 12.8, 0, 'Steak'],
  [310, 'chicken', 2, 1.2, 0.3, 'Raw Chicken'],
  [311, 'cooked_chicken', 6, 7.2, 0],
  [312, 'mutton', 2, 1.2, 0, 'Raw Mutton'],
  [313, 'cooked_mutton', 6, 9.6, 0],
  [314, 'rotten_flesh', 4, 0.8, 0.8],
  [315, 'carrot', 3, 3.6, 0],
  [316, 'potato', 1, 0.6, 0],
  [317, 'baked_potato', 5, 6.0, 0],
];
for (const [fid, name, hunger, sat, poison, display] of FOOD)
  defItem(fid, name, {
    kind: 'food', hunger, saturation: sat, poisonChance: poison,
    ...(display ? { displayName: display } : {}),
  });
ITEMS.get(315).plantsCrop = B.CARROT_CROP;
ITEMS.get(316).plantsCrop = B.POTATO_CROP;

// --- materials & misc (06 §7.4) ---
defItem(318, 'stick', { fuel: 100 });
defItem(319, 'coal', { fuel: 1600 });
defItem(320, 'charcoal', { fuel: 1600 });
defItem(321, 'raw_iron', {});
defItem(322, 'iron_ingot', {});
defItem(323, 'raw_gold', {});
defItem(324, 'gold_ingot', {});
defItem(325, 'diamond', {});
defItem(326, 'flint', {});
defItem(327, 'string', {});
defItem(328, 'feather', {});
defItem(329, 'gunpowder', {});
defItem(330, 'leather', {});
defItem(331, 'bone', {});
defItem(332, 'bone_meal', {});
defItem(333, 'egg', { kind: 'throwable', stack: 16 });
defItem(334, 'ender_pearl', { kind: 'throwable', stack: 16 });
defItem(335, 'snowball', { kind: 'throwable', stack: 16 });
defItem(336, 'wheat', {});
defItem(337, 'wheat_seeds', { kind: 'seed', plantsCrop: B.WHEAT_CROP });
defItem(338, 'sugar_cane', { place: B.SUGAR_CANE_BLOCK });
defItem(339, 'sugar', {});
defItem(340, 'paper', {});
defItem(341, 'book', {});
// AMENDS 06 §7.4 (07 §4.1): redstone dust places wire (block 70) on the top face
// of a supporting block; still a crafting ingredient.
defItem(342, 'redstone', { place: B.REDSTONE_WIRE });
defItem(343, 'lapis_lazuli', {});
defItem(344, 'bed', { kind: 'bed', stack: 1, placesAs: 'bed' });
defItem(345, 'oak_door', { kind: 'door', placesAs: 'door' });

// --- 08-ENCHANTING §10 (items 346–369; 347–369 reserved, unused by 08) ---
// Stack 1, always glinted (§11). Not equippable, not usable, not fuel: its only
// consumers are the anvil (§8.3 case b, incl. book+book) and the grindstone
// (→ plain book). The default `kind: 'material'` is what makes it inert — with
// no place/plantsCrop/hunger/bucketFluid, 03 §16.1's RMB pipeline finds no
// action for it and passes to the offhand (08 §7.3).
defItem(346, 'enchanted_book', { stack: 1 });

// --- 09-POTIONS §1.2 — items 370-378. Potion FORM is the item id (371 drink /
// 372 splash / 373 lingering / 378 tipped); the variant lives in tags.potionId. ---
defItem(370, 'glass_bottle', { kind: 'bottle' });                    // §11.1 RMB fills from water
defItem(371, 'potion', { kind: 'potion', stack: 1 });                // §11.2 drinkable (32-t channel)
defItem(372, 'splash_potion', { kind: 'splash_potion', stack: 1 });  // §13 thrown
defItem(373, 'lingering_potion', { kind: 'lingering_potion', stack: 1 }); // §14 thrown
defItem(374, 'spider_eye', { kind: 'food', hunger: 2, saturation: 3.2 });  // §8; eaten → Poison I 0:05
defItem(375, 'fermented_spider_eye', {});                            // §11.3 corruption modifier
defItem(376, 'golden_apple', { kind: 'food', hunger: 4, saturation: 9.6, alwaysEdible: true });  // §9.1 Absorption I + Regen II, edible at full hunger
defItem(377, 'golden_carrot', { kind: 'food', hunger: 6, saturation: 14.4 }); // §9.2
defItem(378, 'tipped_arrow', {});                                    // §15 ammo (uses tags.potionId)

// --- 10-NETHER §1.2 — brewing ingredients + materials (390-419). Netherite
// tier (398-408) is E8; only the non-tier items are defined here now. ---
defItem(390, 'nether_wart', { plantsCrop: B.NETHER_WART });   // plants crop 138 on soul_sand
defItem(391, 'blaze_rod', { fuel: 2400 });                    // brewing stand (09); fuel
defItem(392, 'blaze_powder', {});
defItem(393, 'magma_cream', {});
defItem(394, 'ghast_tear', {});
defItem(395, 'glowstone_dust', {});
defItem(396, 'gold_nugget', {});
defItem(397, 'nether_quartz', {});
defItem(409, 'nether_brick', {});                             // smelt netherrack; nether_bricks family

// --- 12-VILLAGES §1.2 — emerald (435): trade currency, drops from emerald_ore ---
defItem(435, 'emerald', {});

// --- 10-NETHER §9 — netherite tier (398-408). Tools/armor come ONLY from the
// smithing upgrade (§9.3), never a grid recipe. netherite_scrap (398) is a plain
// smelting product; the ingot + all gear (399-408) are fire/lava-immune (§9.4). ---
const N = TIERS.netherite;
defItem(398, 'netherite_scrap', {});
defItem(399, 'netherite_ingot', { lavaImmune: true });
defItem(400, 'netherite_sword',   { stack: 1, tier: N.tier, speedMult: 1, durability: N.dur, kind: 'sword', toolClass: 'sword', attackDamage: SWORD_DMG.netherite, attackSpeed: 1.6, lavaImmune: true });
defItem(401, 'netherite_pickaxe', { stack: 1, tier: N.tier, speedMult: N.speedMult, durability: N.dur, kind: 'tool', toolClass: 'pickaxe', attackDamage: PICK_DMG.netherite, attackSpeed: 1.2, lavaImmune: true });
defItem(402, 'netherite_axe',     { stack: 1, tier: N.tier, speedMult: N.speedMult, durability: N.dur, kind: 'tool', toolClass: 'axe', attackDamage: AXE_DMG.netherite, attackSpeed: AXE_SPD.netherite, lavaImmune: true });
defItem(403, 'netherite_shovel',  { stack: 1, tier: N.tier, speedMult: N.speedMult, durability: N.dur, kind: 'tool', toolClass: 'shovel', attackDamage: SHOVEL_DMG.netherite, attackSpeed: 1.0, lavaImmune: true });
defItem(404, 'netherite_hoe',     { stack: 1, tier: N.tier, speedMult: N.speedMult, durability: N.dur, kind: 'tool', toolClass: 'hoe', attackDamage: 1, attackSpeed: HOE_SPD.netherite, lavaImmune: true });
// armor: points identical to diamond (20 total); toughness 3/piece (12); kbResist 0.1/piece (0.4)
const NETHERITE_ARMOR = [[407, 3], [592, 8], [555, 6], [481, 3]];
for (let slot = 0; slot < 4; slot++) {
  const [dur, pts] = NETHERITE_ARMOR[slot];
  defItem(405 + slot, `netherite_${PIECES[slot]}`, {
    kind: 'armor', stack: 1, durability: dur,
    armorSlot: slot, armorPoints: pts, toughness: 3, knockbackResistance: 0.1, lavaImmune: true,
  });
}
// the netherite_block BLOCK-item (auto-registered at id 142) is also lava-immune (§9.4)
ITEMS.get(B.NETHERITE_BLOCK).lavaImmune = true;

// --- 11-END §2.3 — items 420-424 ---
// eye_of_ender: RMB launches it (overworld) or fills a frame (custom, §3/§5.2).
defItem(420, 'eye_of_ender', { kind: 'eye_of_ender', stack: 64 });
// chorus_fruit: food, edible at full hunger, teleports on eat (§8.6).
defItem(421, 'chorus_fruit', { kind: 'food', hunger: 4, saturation: 2.4, alwaysEdible: true, eatCooldown: 20, teleportOnEat: true });
defItem(422, 'popped_chorus_fruit', {});                 // §13 crafting material
defItem(423, 'shulker_shell', {});                       // §9.1 shulker drop
// elytra: chest-slot armor, 0 defense; glide via §10. flightEnabled once durability>1.
defItem(424, 'elytra', { kind: 'armor', stack: 1, durability: 432, armorSlot: 1, armorPoints: 0, toughness: 0, elytra: true });

// --- 13-BOSSES §2.3 — boss items (450-452) ---
// nether_star: wither drop; its item entity never despawns (AMENDS 06 §16).
defItem(450, 'nether_star', { neverDespawn: true });
// end_crystal: places a crystal entity on obsidian/bedrock only (§3.4).
defItem(451, 'end_crystal', { kind: 'end_crystal', stack: 64 });
// dragon_breath: bottled from a breath cloud (§6.5); 09's splash→lingering modifier.
defItem(452, 'dragon_breath', {});

export const idOf = name => {
  const v = NAME_TO_ID.get(name);
  if (v === undefined) throw new Error(`unknown item/block name: ${name}`);
  return v;
};
export const itemById = i => ITEMS.get(i);

// ================== 10-NETHER §9.3 — smithing-table upgrade ==================
// diamond gear id → its netherite counterpart. The upgrade keeps the source's
// tags (08's enchants/rename) and its used durability. No template (pre-1.20).
export const SMITHING_UPGRADES = new Map(
  ['sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'helmet', 'chestplate', 'leggings', 'boots']
    .map(p => [idOf(`diamond_${p}`), idOf(`netherite_${p}`)])
);

/**
 * §9.3 upgrade(base, material). Returns the netherite result STACK (with tags +
 * carried durability) or null when the pairing is invalid. Pure — safe to call
 * every render. `damage` counts UP from 0, so copying it preserves the absolute
 * durability already spent (netherite's higher max ⇒ more remaining, per vanilla).
 */
export function smithingUpgrade(base, material) {
  if (!base || !material || material.id !== idOf('netherite_ingot')) return null;
  const outId = SMITHING_UPGRADES.get(base.id);
  if (outId === undefined) return null;
  const out = { id: outId, count: 1 };
  const used = base.damage ?? 0;
  if (used > 0) out.damage = Math.min(used, ITEMS.get(outId).durability - 1);  // never pre-broken
  const t = cloneTags(base.tags);        // deep clone; preserves unknown 09+/11 keys (08 §1)
  if (t) out.tags = t;
  return out;
}

// ========================= CRAFTING (06 §10) =========================
// Shaped: {shaped:true, pattern:['MMM','.S.'], key:{M:[ids],S:[ids]}, output}.
// Matching also tries the horizontally mirrored pattern. Shapeless:
// {shaped:false, ingredients:[[ids],[ids],…], output}.

const PLANKS = [B.OAK_PLANKS, B.BIRCH_PLANKS, B.SPRUCE_PLANKS];
const LOGS = [B.OAK_LOG, B.BIRCH_LOG, B.SPRUCE_LOG];
const WOOLS = [B.WOOL_WHITE, B.WOOL_RED, B.WOOL_BLUE, B.WOOL_BLACK];

export const RECIPES = [];
const shaped = (output, count, pattern, key) =>
  RECIPES.push({ shaped: true, pattern, key, output: { id: output, count } });
const shapeless = (output, count, ingredients) =>
  RECIPES.push({ shaped: false, ingredients, output: { id: output, count } });

// 10.1 blocks & utility
shapeless(B.OAK_PLANKS, 4, [[B.OAK_LOG]]);
shapeless(B.BIRCH_PLANKS, 4, [[B.BIRCH_LOG]]);
shapeless(B.SPRUCE_PLANKS, 4, [[B.SPRUCE_LOG]]);
shaped(318, 4, ['P', 'P'], { P: PLANKS });
shaped(B.CRAFTING_TABLE, 1, ['PP', 'PP'], { P: PLANKS });
shaped(B.FURNACE, 1, ['CCC', 'C.C', 'CCC'], { C: [B.COBBLESTONE] });
shaped(B.CHEST, 1, ['PPP', 'P.P', 'PPP'], { P: PLANKS });
shaped(B.TORCH, 4, ['C', 'S'], { C: [319, 320], S: [318] });
shaped(B.LADDER, 3, ['S.S', 'SSS', 'S.S'], { S: [318] });
shaped(345, 3, ['PP', 'PP', 'PP'], { P: PLANKS });          // oak_door item
shaped(B.OAK_FENCE, 3, ['PSP', 'PSP'], { P: PLANKS, S: [318] });
shaped(344, 1, ['WWW', 'PPP'], { W: WOOLS, P: PLANKS });    // bed item
shaped(B.TNT, 1, ['GSG', 'SGS', 'GSG'], { G: [329], S: [B.SAND] });
shaped(B.BOOKSHELF, 1, ['PPP', 'BBB', 'PPP'], { P: PLANKS, B: [341] });

// 08-ENCHANTING §2.3
shaped(B.ENCHANTING_TABLE, 1, ['.B.', 'DOD', 'OOO'], { B: [341], D: [325], O: [B.OBSIDIAN] });
shaped(B.ANVIL, 1, ['III', '.i.', 'iii'], { I: [B.IRON_BLOCK], i: [322] });   // 31 ingots total
// §2.3 Adaptation: the grindstone's vanilla centre ingredient is a stone SLAB;
// no slabs exist in this registry, so full `stone` (smelted from cobblestone,
// 06 §11.2) substitutes.
shaped(B.GRINDSTONE, 1, ['SCS', 'P.P'], { S: [318], C: [B.STONE], P: PLANKS });
shaped(B.JACK_O_LANTERN, 1, ['P', 'T'], { P: [B.PUMPKIN], T: [B.TORCH] });
shaped(B.SANDSTONE, 1, ['SS', 'SS'], { S: [B.SAND] });
shaped(B.SNOW_BLOCK, 1, ['SS', 'SS'], { S: [335] });
shaped(B.SNOW_LAYER, 6, ['SSS'], { S: [B.SNOW_BLOCK] });
shaped(B.WOOL_WHITE, 1, ['SS', 'SS'], { S: [327] });
shaped(B.COAL_BLOCK, 1, ['CCC', 'CCC', 'CCC'], { C: [319] });   // coal only, NOT charcoal
shaped(B.IRON_BLOCK, 1, ['III', 'III', 'III'], { I: [322] });

// --- 09-POTIONS recipes (§7.2, §9, §11) ---
shaped(370, 3, ['G.G', '.G.'], { G: [B.GLASS] });              // §11.1 glass → 3 glass_bottle
shaped(B.BREWING_STAND, 1, ['.B.', 'CCC'], { B: [391], C: [B.COBBLESTONE] });  // §7.2 blaze_rod + cobble
shapeless(375, 1, [[374], [339], [110]]);                     // §11.3 spider_eye + sugar + brown_mushroom
shaped(376, 1, ['GGG', 'GAG', 'GGG'], { G: [324], A: [304] }); // §9.1 golden_apple (apple + 8 gold_ingot)
shaped(377, 1, ['NNN', 'NCN', 'NNN'], { N: [396], C: [315] }); // §9.2 golden_carrot (carrot + 8 gold_nugget)
shaped(378, 8, ['AAA', 'ALA', 'AAA'], { A: [282], L: [373] }); // §15.1 tipped_arrow (potionId copied on craft)

// --- 12-VILLAGES §6.3 emerald + hay_bale storage recipes ---
shaped(B.EMERALD_BLOCK, 1, ['EEE', 'EEE', 'EEE'], { E: [435] });   // 9 emerald → block
shapeless(435, 9, [[B.EMERALD_BLOCK]]);                            // block → 9 emerald
shaped(B.HAY_BALE, 1, ['WWW', 'WWW', 'WWW'], { W: [336] });        // 9 wheat → hay_bale
shapeless(336, 9, [[B.HAY_BALE]]);                                 // hay_bale → 9 wheat

// ========================= 11-END §13 — crafting =========================
shapeless(420, 1, [[334], [392]]);                                // eye_of_ender = ender_pearl + blaze_powder
shaped(B.STONE_BRICKS, 4, ['SS', 'SS'], { S: [B.STONE] });        // 4 stone → 4 stone_bricks
shaped(B.END_STONE_BRICKS, 4, ['EE', 'EE'], { E: [B.END_STONE] });
shaped(B.PURPUR_BLOCK, 4, ['PP', 'PP'], { P: [422] });            // popped_chorus_fruit
shaped(B.PURPUR_PILLAR, 2, ['B', 'B'], { B: [B.PURPUR_BLOCK] });
shaped(B.END_ROD, 4, ['B', 'P'], { B: [391], P: [422] });         // blaze_rod + popped
shaped(B.SHULKER_BOX, 1, ['S', 'C', 'S'], { S: [423], C: [B.CHEST] });

// ========================= 13-BOSSES §2.4 — crafting =========================
shaped(B.BEACON, 1, ['GGG', 'GNG', 'OOO'], { G: [B.GLASS], N: [450], O: [B.OBSIDIAN] });   // glass/nether_star/obsidian
shaped(451, 1, ['GGG', 'GEG', 'GTG'], { G: [B.GLASS], E: [420], T: [394] });               // end_crystal = glass/eye_of_ender/ghast_tear

// --- 10-NETHER §1.3 ---
// §9: 4 netherite_scrap + 4 gold_ingot → 1 netherite_ingot (shapeless); block ↔ 9 ingot
shapeless(399, 1, [[398], [398], [398], [398], [324], [324], [324], [324]]);
shaped(B.NETHERITE_BLOCK, 1, ['III', 'III', 'III'], { I: [399] });
shapeless(399, 9, [[B.NETHERITE_BLOCK]]);
shapeless(392, 2, [[391]]);                                    // blaze_rod → 2 blaze_powder
shaped(B.GLOWSTONE, 1, ['DD', 'DD'], { D: [395] });            // glowstone_dust → block 32
shapeless(396, 9, [[324]]);                                    // gold_ingot → 9 gold_nugget
shaped(324, 1, ['NNN', 'NNN', 'NNN'], { N: [396] });           // 9 gold_nugget → gold_ingot
shaped(B.NETHER_BRICKS, 1, ['RR', 'RR'], { R: [409] });        // 4 nether_brick → nether_bricks
shaped(B.NETHER_BRICK_FENCE, 6, ['BRB', 'BRB'], { B: [B.NETHER_BRICKS], R: [409] });
shaped(B.NETHER_BRICK_STAIRS, 4, ['B..', 'BB.', 'BBB'], { B: [B.NETHER_BRICKS] });
shapeless(B.CRIMSON_PLANKS, 4, [[B.CRIMSON_STEM]]);
shapeless(B.WARPED_PLANKS, 4, [[B.WARPED_STEM]]);
shaped(B.SMITHING_TABLE, 1, ['II', 'PP', 'PP'], { I: [322], P: [...PLANKS, B.CRIMSON_PLANKS, B.WARPED_PLANKS] });
shaped(B.GOLD_BLOCK, 1, ['GGG', 'GGG', 'GGG'], { G: [324] });
shaped(B.DIAMOND_BLOCK, 1, ['DDD', 'DDD', 'DDD'], { D: [325] });
shapeless(319, 9, [[B.COAL_BLOCK]]);
shapeless(322, 9, [[B.IRON_BLOCK]]);
shapeless(324, 9, [[B.GOLD_BLOCK]]);
shapeless(325, 9, [[B.DIAMOND_BLOCK]]);

// 10.2 tools — M ∈ {planks, cobblestone, iron, gold, diamond}, S = stick
const TOOL_MATS = [
  ['wooden', PLANKS],
  ['stone', [B.COBBLESTONE]],
  ['iron', [322]],
  ['golden', [324]],
  ['diamond', [325]],
];
for (const [mat, M] of TOOL_MATS) {
  const key = { M, S: [318] };
  shaped(idOf(`${mat}_pickaxe`), 1, ['MMM', '.S.', '.S.'], key);
  shaped(idOf(`${mat}_axe`), 1, ['MM.', 'MS.', '.S.'], key);
  shaped(idOf(`${mat}_shovel`), 1, ['M', 'S', 'S'], key);
  shaped(idOf(`${mat}_sword`), 1, ['M', 'M', 'S'], key);
  shaped(idOf(`${mat}_hoe`), 1, ['MM.', '.S.', '.S.'], key);
}
shaped(281, 1, ['.ST', 'S.T', '.ST'], { S: [318], T: [327] });
shaped(282, 4, ['F', 'S', 'E'], { F: [326], S: [318], E: [328] });
shaped(283, 1, ['.I', 'I.'], { I: [322] });
shapeless(284, 1, [[322], [326]]);
shaped(285, 1, ['I.I', '.I.'], { I: [322] });

// 10.3 armor — A ∈ {leather, gold, iron, diamond}
const ARMOR_MATS = [['leather', [330]], ['golden', [324]], ['iron', [322]], ['diamond', [325]]];
for (const [mat, A] of ARMOR_MATS) {
  shaped(idOf(`${mat}_helmet`), 1, ['AAA', 'A.A'], { A });
  shaped(idOf(`${mat}_chestplate`), 1, ['A.A', 'AAA', 'AAA'], { A });
  shaped(idOf(`${mat}_leggings`), 1, ['AAA', 'A.A', 'A.A'], { A });
  shaped(idOf(`${mat}_boots`), 1, ['A.A', 'A.A'], { A });
}

// 10.4 food & materials
shaped(305, 1, ['WWW'], { W: [336] });
shapeless(332, 3, [[331]]);
shapeless(339, 1, [[338]]);
shaped(340, 3, ['CCC'], { C: [338] });
shapeless(341, 1, [[340], [340], [340], [330]]);

// ========================= 07-REDSTONE §15 =========================
// Adaptation: nether quartz → lapis_lazuli (343); slimeball → sugar (339); until
// 10-NETHER supplies the originals (logged in DEVIATIONS). Glowstone (32) is
// debug-palette-only until 10 generates it, but the lamp recipe ships now.
const STICK = 318, RS = 342, LAPIS = 343, SUGAR = 339;
const STONE = B.STONE, COBBLE = B.COBBLESTONE, IRON = 322, GLOW = B.GLOWSTONE;
shaped(B.REDSTONE_TORCH, 1, ['R', 'S'], { R: [RS], S: [STICK] });
shaped(B.LEVER, 1, ['S', 'C'], { S: [STICK], C: [COBBLE] });
shapeless(B.STONE_BUTTON, 1, [[STONE]]);
shapeless(B.WOODEN_BUTTON, 1, [PLANKS]);
shaped(B.STONE_PRESSURE_PLATE, 1, ['AA'], { A: [STONE] });
shaped(B.WOODEN_PRESSURE_PLATE, 1, ['PP'], { P: PLANKS });
shaped(B.REPEATER, 1, ['TRT', 'AAA'], { T: [B.REDSTONE_TORCH], R: [RS], A: [STONE] });
shaped(B.COMPARATOR, 1, ['.T.', 'TLT', 'AAA'], { T: [B.REDSTONE_TORCH], L: [LAPIS], A: [STONE] });
shaped(B.PISTON, 1, ['PPP', 'CIC', 'CRC'], { P: PLANKS, C: [COBBLE], I: [IRON], R: [RS] });
shapeless(B.STICKY_PISTON, 1, [[B.PISTON], [SUGAR]]);
shaped(B.OBSERVER, 1, ['CCC', 'RRL', 'CCC'], { C: [COBBLE], R: [RS], L: [LAPIS] });
shaped(B.DISPENSER, 1, ['CCC', 'CBC', 'CRC'], { C: [COBBLE], B: [281], R: [RS] });   // B = bow (281)
shaped(B.DROPPER, 1, ['CCC', 'C.C', 'CRC'], { C: [COBBLE], R: [RS] });
shaped(B.HOPPER, 1, ['I.I', 'ICI', '.I.'], { I: [IRON], C: [B.CHEST] });
shaped(B.REDSTONE_LAMP, 1, ['.R.', 'RGR', '.R.'], { R: [RS], G: [GLOW] });
shaped(B.NOTE_BLOCK, 1, ['PPP', 'PRP', 'PPP'], { P: PLANKS, R: [RS] });
shaped(B.REDSTONE_BLOCK, 1, ['RRR', 'RRR', 'RRR'], { R: [RS] });
shapeless(RS, 9, [[B.REDSTONE_BLOCK]]);

// ========================= SMELTING (06 §11.2) =========================
export const SMELTING = new Map([
  [321, { out: 322, xp: 0.7 }],       // raw_iron → iron_ingot
  [323, { out: 324, xp: 1.0 }],       // raw_gold → gold_ingot
  [B.SAND, { out: B.GLASS, xp: 0.1 }],
  [B.COBBLESTONE, { out: B.STONE, xp: 0.1 }],
  // 10-NETHER §1.4 / §9 — ancient_debris → netherite_scrap (2.0 XP, 200 t base)
  [B.ANCIENT_DEBRIS, { out: 398, xp: 2.0 }],
  [B.NETHERRACK, { out: 409, xp: 0.1 }],       // netherrack → nether_brick
  [B.NETHER_GOLD_ORE, { out: 324, xp: 1.0 }],  // silk-touched ore → gold_ingot
  [B.NETHER_QUARTZ_ORE, { out: 397, xp: 0.2 }],
  [B.OAK_LOG, { out: 320, xp: 0.15 }],
  [B.BIRCH_LOG, { out: 320, xp: 0.15 }],
  [B.SPRUCE_LOG, { out: 320, xp: 0.15 }],
  [306, { out: 307, xp: 0.35 }],      // porkchop
  [308, { out: 309, xp: 0.35 }],      // beef
  [310, { out: 311, xp: 0.35 }],      // chicken
  [312, { out: 313, xp: 0.35 }],      // mutton
  [316, { out: 317, xp: 0.35 }],      // potato
  // 11-END §13 — chorus_fruit → popped; stone_bricks → cracked (both 0.1 XP)
  [421, { out: 422, xp: 0.1 }],
  [B.STONE_BRICKS, { out: B.CRACKED_STONE_BRICKS, xp: 0.1 }],
]);

// ========================= FUEL (06 §11.3) =========================
export function fuelValue(itemId) {
  return ITEMS.get(itemId)?.fuel ?? 0;
}
