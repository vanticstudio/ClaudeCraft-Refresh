// 09-POTIONS §10.2 — the brewing-stand tick. slots[0..2] bottles, [3] ingredient,
// [4] fuel (blaze_powder). brewTime counts DOWN 400→0; fuel is 0–20 charges.
import { mix } from '../status/potions.js';
import { ITEMS, idOf } from '../registry/items.js';
import { emitSound, at } from '../audio/engine.js';

const POTION = idOf('potion'), SPLASH = idOf('splash_potion'), LINGERING = idOf('lingering_potion');
const BLAZE_POWDER = idOf('blaze_powder');

/** The result of applying `ingredientName` to one bottle stack, or null. Returns
 *  { id, potionId } — id changes only for the gunpowder/dragon_breath form swaps. */
export function brewResult(bottle, ingredientName) {
  if (!bottle || (bottle.id !== POTION && bottle.id !== SPLASH && bottle.id !== LINGERING)) return null;
  // §12.1 — an UNTAGGED bottle IS a water bottle. Rejecting it made the whole
  // brew graph unreachable in creative: the palette mints bare stacks (no tags),
  // the Brewing tab hands them out and the stand's bottle slots accept them, so
  // canBrew was permanently false. drinkPotion already defaults the same way.
  // The id gate keeps tipped arrows (which also carry tags.potionId) out.
  const pid = bottle.tags?.potionId ?? 'water';
  if (ingredientName === 'gunpowder') return bottle.id === POTION ? { id: SPLASH, potionId: pid } : null;
  if (ingredientName === 'dragon_breath') return bottle.id === SPLASH ? { id: LINGERING, potionId: pid } : null;
  const np = mix(pid, ingredientName);          // effect / redstone / glowstone / fermented / nether_wart
  return np ? { id: bottle.id, potionId: np } : null;
}

export function tickBrewing(game, b, x, y, z, chunk) {
  const ingredient = b.slots[3];
  const ingName = ingredient ? ITEMS.get(ingredient.id)?.name : null;
  // canBrew: an ingredient plus at least one bottle it can transform.
  const results = [null, null, null];
  let canBrew = false;
  if (ingName) {
    for (let i = 0; i < 3; i++) {
      results[i] = brewResult(b.slots[i], ingName);
      if (results[i]) canBrew = true;
    }
  }

  // Fuel: one blaze powder charges 20 brews. Consume when empty and there is work.
  if (b.fuel === 0 && b.slots[4] && b.slots[4].id === BLAZE_POWDER && (canBrew || b.brewTime > 0)) {
    b.fuel = 20;
    if (--b.slots[4].count <= 0) b.slots[4] = null;
    chunk.modified = true;
  }

  if (b.brewTime > 0) {
    if (!canBrew) { b.brewTime = 0; chunk.modified = true; }   // ingredient pulled → hard reset
    else {
      b.brewTime -= 1;
      chunk.modified = true;
      if (b.brewTime === 0) {
        for (let i = 0; i < 3; i++) {
          const r = results[i];
          if (!r) continue;
          const s = b.slots[i];
          s.id = r.id;
          s.tags = { ...(s.tags || {}), potionId: r.potionId };   // preserve other tag keys (08 §1)
        }
        if (--ingredient.count <= 0) b.slots[3] = null;
        b.fuel -= 1;
        emitSound('block.brewing.done', at(x + 0.5, y + 0.5, z + 0.5));
        game.redstone?.containerChanged?.(x, y, z);              // 07 comparator update
      }
    }
  } else if (canBrew && b.fuel > 0) {
    b.brewTime = 400;                                            // 20 s, wiki-exact
    chunk.modified = true;
  }
}
