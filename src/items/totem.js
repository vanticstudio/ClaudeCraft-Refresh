// B4 — Totem of Undying (19-BUILDOUT §B4). PURE over the entity shape so U17
// can pin the contract without a live Player. Player.die() calls totemSave()
// BEFORE clearing effects; when it returns true the death is undone.
import { addEffect, EFFECT } from '../status/effects.js';

let TOTEM_ID = null;
/** Lazily resolve the registry id (call once from Player/interaction init). */
export function setTotemId(id) { TOTEM_ID = id; }
export function isTotem(stack) {
  return TOTEM_ID != null && stack?.id === TOTEM_ID;
}

/**
 * Consume the totem in `entity.offhand` and undo a lethal damage event:
 * 1 HP + Absorption II (8 pt pool) + Regeneration II 40 t + Fire out.
 * Returns true when a totem was consumed (caller skips death entirely).
 */
export function totemSave(entity, world) {
  const stack = entity.offhand;
  if (!isTotem(stack)) return false;
  entity.offhand = null;                    // consume BEFORE any re-entry
  entity.health = 1;
  entity.dead = false;
  addEffect(entity, EFFECT.ABSORPTION, 1, 2000);   // Absorption II — 5:00
  addEffect(entity, EFFECT.REGENERATION, 1, 800);  // Regeneration II — 40:00… 40 s
  entity.fireTicks = 0;
  entity.onTotemSave?.(world);              // particles/sound hook (Player)
  return true;
}
