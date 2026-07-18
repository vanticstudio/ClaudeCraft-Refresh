// 09-POTIONS §12 — the potion registry (potionId → payload) and the brewing
// recipe graph (every edge). Pure data + a `mix()` lookup; no engine/DOM deps so
// it is safe to import from the registry, brewing tick, and throwables alike.
//
// potionId is a STRING key (09 owns tags.potionId; §12.1 "decision"). One item id
// per bottle FORM (371 drink / 372 splash / 373 lingering / 378 tipped); the
// variant lives in tags.potionId.

import { EFFECT } from './effects.js';

// §12.1 — Java 1.20 exact. { effect, amp, ticks, instant?, tint }. water/awkward
// carry no effect (drinkable no-ops).
export const POTIONS = {
  water:               { tint: 0x385DC6 },
  awkward:             { tint: 0x385DC6 },
  speed:               { effect: EFFECT.SPEED, amp: 0, ticks: 3600, tint: 0x33EBFF },
  long_speed:          { effect: EFFECT.SPEED, amp: 0, ticks: 9600, tint: 0x33EBFF },
  strong_speed:        { effect: EFFECT.SPEED, amp: 1, ticks: 1800, tint: 0x33EBFF },
  strength:            { effect: EFFECT.STRENGTH, amp: 0, ticks: 3600, tint: 0xFCC500 },
  long_strength:       { effect: EFFECT.STRENGTH, amp: 0, ticks: 9600, tint: 0xFCC500 },
  strong_strength:     { effect: EFFECT.STRENGTH, amp: 1, ticks: 1800, tint: 0xFCC500 },
  regeneration:        { effect: EFFECT.REGENERATION, amp: 0, ticks: 900, tint: 0xCD5CAB },
  long_regeneration:   { effect: EFFECT.REGENERATION, amp: 0, ticks: 1800, tint: 0xCD5CAB },
  strong_regeneration: { effect: EFFECT.REGENERATION, amp: 1, ticks: 450, tint: 0xCD5CAB },
  fire_resistance:     { effect: EFFECT.FIRE_RESISTANCE, amp: 0, ticks: 3600, tint: 0xFF9900 },
  long_fire_resistance:{ effect: EFFECT.FIRE_RESISTANCE, amp: 0, ticks: 9600, tint: 0xFF9900 },
  poison:              { effect: EFFECT.POISON, amp: 0, ticks: 900, tint: 0x87A363 },
  long_poison:         { effect: EFFECT.POISON, amp: 0, ticks: 1800, tint: 0x87A363 },
  strong_poison:       { effect: EFFECT.POISON, amp: 1, ticks: 432, tint: 0x87A363 },
  night_vision:        { effect: EFFECT.NIGHT_VISION, amp: 0, ticks: 3600, tint: 0xC2FF66 },
  long_night_vision:   { effect: EFFECT.NIGHT_VISION, amp: 0, ticks: 9600, tint: 0xC2FF66 },
  invisibility:        { effect: EFFECT.INVISIBILITY, amp: 0, ticks: 3600, tint: 0xF6F6F6 },
  long_invisibility:   { effect: EFFECT.INVISIBILITY, amp: 0, ticks: 9600, tint: 0xF6F6F6 },
  healing:             { effect: EFFECT.INSTANT_HEALTH, amp: 0, instant: true, tint: 0xF82423 },
  strong_healing:      { effect: EFFECT.INSTANT_HEALTH, amp: 1, instant: true, tint: 0xF82423 },
  harming:             { effect: EFFECT.INSTANT_DAMAGE, amp: 0, instant: true, tint: 0xA9656A },
  strong_harming:      { effect: EFFECT.INSTANT_DAMAGE, amp: 1, instant: true, tint: 0xA9656A },
  weakness:            { effect: EFFECT.WEAKNESS, amp: 0, ticks: 1800, tint: 0x484D48 },
  long_weakness:       { effect: EFFECT.WEAKNESS, amp: 0, ticks: 4800, tint: 0x484D48 },
  slowness:            { effect: EFFECT.SLOWNESS, amp: 0, ticks: 1800, tint: 0x8BAFE0 },
  long_slowness:       { effect: EFFECT.SLOWNESS, amp: 0, ticks: 4800, tint: 0x8BAFE0 },
  strong_slowness:     { effect: EFFECT.SLOWNESS, amp: 3, ticks: 400, tint: 0x8BAFE0 },  // Slowness IV
};

export const WATER_TINT = 0x385DC6;
export function potionTint(potionId) { return (POTIONS[potionId] ?? POTIONS.water).tint; }
export function isValidPotion(id) { return Object.prototype.hasOwnProperty.call(POTIONS, id); }

// §12.2 — the recipe edges. Ingredient item NAME → (potionId → potionId').
// The brewing tick resolves ingredients by item name; §12.2 owner ids are wired
// where the ingredients are registered (nether_wart, blaze_powder, etc.).

// awkward + effect ingredient → effect potion (base forms only)
const AWKWARD_INGREDIENT = {
  sugar: 'speed',
  blaze_powder: 'strength',
  ghast_tear: 'regeneration',
  magma_cream: 'fire_resistance',
  spider_eye: 'poison',
  golden_carrot: 'night_vision',
  golden_apple: 'healing',
};

// fermented_spider_eye corruption (Java-exact over our set)
const CORRUPTION = {
  water: 'weakness',
  speed: 'slowness',
  long_speed: 'long_slowness',
  // strong_speed → nothing (enhanced Swiftness cannot be corrupted)
  night_vision: 'invisibility',
  long_night_vision: 'long_invisibility',
  healing: 'harming',
  strong_healing: 'strong_harming',
  poison: 'harming',
  long_poison: 'harming',
  strong_poison: 'strong_harming',
};

// redstone: base → long_ form (only where a long_ form exists)
const REDSTONE_LONG = {
  speed: 'long_speed', strength: 'long_strength', regeneration: 'long_regeneration',
  fire_resistance: 'long_fire_resistance', poison: 'long_poison',
  night_vision: 'long_night_vision', invisibility: 'long_invisibility',
  weakness: 'long_weakness', slowness: 'long_slowness',
};

// glowstone: base → strong_ form (only where a strong_ form exists)
const GLOWSTONE_STRONG = {
  speed: 'strong_speed', strength: 'strong_strength', regeneration: 'strong_regeneration',
  poison: 'strong_poison', healing: 'strong_healing', harming: 'strong_harming',
  slowness: 'strong_slowness',
};

/**
 * §10.3 mix(potionId, ingredientName) → new potionId or null. Effect/redstone/
 * glowstone/fermented-eye act on tags.potionId; gunpowder/dragon_breath swap the
 * item FORM instead (handled by the brewing tick, not here — they return null).
 */
export function mix(potionId, ingredientName) {
  if (ingredientName === 'nether_wart') return potionId === 'water' ? 'awkward' : null;
  if (ingredientName === 'fermented_spider_eye') return CORRUPTION[potionId] ?? null;
  if (ingredientName === 'redstone') return REDSTONE_LONG[potionId] ?? null;
  if (ingredientName === 'glowstone_dust') return GLOWSTONE_STRONG[potionId] ?? null;
  if (potionId === 'awkward') return AWKWARD_INGREDIENT[ingredientName] ?? null;
  return null;
}

// The item-FORM modifiers (§12.2): gunpowder makes a drink→splash, dragon_breath
// makes a splash→lingering. Reported by name so the brewing tick can swap the item
// id while leaving potionId untouched.
export const FORM_MODIFIERS = { gunpowder: 'splash', dragon_breath: 'lingering' };
export function isIngredient(name) {
  return name === 'nether_wart' || name === 'fermented_spider_eye' || name === 'redstone'
    || name === 'glowstone_dust' || name in AWKWARD_INGREDIENT || name in FORM_MODIFIERS;
}
