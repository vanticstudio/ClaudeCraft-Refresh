// 09-POTIONS §2/§3 — the status-effect ENGINE.   *** FROZEN CONTRACT ***
// =============================================================================
// This module is the single definition of the status-effect API for all
// consumers (08 enchanting, 10 nether, 11 end, 13 bosses). Do not redefine the
// effect ids or the addEffect/tickEffects/applyInstant surface elsewhere.
//
// Data model (AMENDS 01 §13.1): every LivingEntity carries
//   effects: Map<effectId, { amplifier:int(0=I), duration:int(ticks), ambient:bool }>
//   absorption: float ≥ 0
// Instant effects (6,7) never enter the map — applyInstant resolves them at once.
//
// Public surface consumers may call:
//   addEffect(entity, id, amplifier, duration, ambient?) → bool
//   removeEffect(entity, id) / clearEffects(entity)
//   hasEffect(entity, id) / effectLevel(entity, id) [L = amp+1, 0 if absent]
//   applyInstant(target, effectId, amplifier, potency, source)
//   tickEffects(entity)            — call at player/mob tick step 1.5
//   isImmuneTo(entity, id)
// Entity flags read here (consumers set them): undead, poisonImmune,
//   witherImmune, effectImmune.

// §1.3 — vanilla Java numeric ids (stable in saves). Reserved-but-unimplemented:
// 9 nausea, 15 blindness, 21 health_boost, 23 saturation, 24 glowing, 26/27 luck.
export const EFFECT = {
  SPEED: 1, SLOWNESS: 2, HASTE: 3, MINING_FATIGUE: 4, STRENGTH: 5,
  INSTANT_HEALTH: 6, INSTANT_DAMAGE: 7, JUMP_BOOST: 8, REGENERATION: 10,
  RESISTANCE: 11, FIRE_RESISTANCE: 12, WATER_BREATHING: 13, INVISIBILITY: 14,
  NIGHT_VISION: 16, HUNGER: 17, WEAKNESS: 18, POISON: 19, WITHER: 20,
  ABSORPTION: 22, LEVITATION: 25, SLOW_FALLING: 28,
};

// §3 catalog — name, display, color (Java 1.20 particle/potion palette), sign.
export const EFFECT_META = {
  1:  { name: 'speed', display: 'Speed', color: 0x33EBFF, positive: true },
  2:  { name: 'slowness', display: 'Slowness', color: 0x8BAFE0, positive: false },
  3:  { name: 'haste', display: 'Haste', color: 0xD9C043, positive: true },
  4:  { name: 'mining_fatigue', display: 'Mining Fatigue', color: 0x4A4217, positive: false },
  5:  { name: 'strength', display: 'Strength', color: 0xFCC500, positive: true },
  6:  { name: 'instant_health', display: 'Instant Health', color: 0xF82423, positive: true, instant: true },
  7:  { name: 'instant_damage', display: 'Instant Damage', color: 0xA9656A, positive: false, instant: true },
  8:  { name: 'jump_boost', display: 'Jump Boost', color: 0xFDFF84, positive: true },
  10: { name: 'regeneration', display: 'Regeneration', color: 0xCD5CAB, positive: true },
  11: { name: 'resistance', display: 'Resistance', color: 0x8F45ED, positive: true },
  12: { name: 'fire_resistance', display: 'Fire Resistance', color: 0xFF9900, positive: true },
  13: { name: 'water_breathing', display: 'Water Breathing', color: 0x96D7BE, positive: true },
  14: { name: 'invisibility', display: 'Invisibility', color: 0xF6F6F6, positive: true },
  16: { name: 'night_vision', display: 'Night Vision', color: 0xC2FF66, positive: true },
  17: { name: 'hunger', display: 'Hunger', color: 0x587653, positive: false },
  18: { name: 'weakness', display: 'Weakness', color: 0x484D48, positive: false },
  19: { name: 'poison', display: 'Poison', color: 0x87A363, positive: false },
  20: { name: 'wither', display: 'Wither', color: 0x352A27, positive: false },
  22: { name: 'absorption', display: 'Absorption', color: 0x2552A5, positive: true },
  25: { name: 'levitation', display: 'Levitation', color: 0xCEFFFF, positive: false },
  28: { name: 'slow_falling', display: 'Slow Falling', color: 0xFFEFD1, positive: true },
};

// -------------------------------------------------- helpers (read live, §2.6)
export function hasEffect(entity, id) { return entity.effects?.has(id) ?? false; }
export function getEffect(entity, id) { return entity.effects?.get(id) ?? null; }
/** L = amplifier + 1, or 0 when absent — the value every formula in §3 reads. */
export function effectLevel(entity, id) {
  const fx = entity.effects?.get(id);
  return fx ? fx.amplifier + 1 : 0;
}
/** Raw amplifier (0 = level I), or -1 when absent. */
export function getAmplifier(entity, id) {
  const fx = entity.effects?.get(id);
  return fx ? fx.amplifier : -1;
}

// §4.3 immunity table. undead: no regen/poison. spider: poisonImmune. wither
// boss: witherImmune. ender dragon: effectImmune (all).
export function isImmuneTo(entity, id) {
  if (entity.effectImmune) return true;
  if (entity.undead && (id === EFFECT.REGENERATION || id === EFFECT.POISON)) return true;
  if (entity.poisonImmune && id === EFFECT.POISON) return true;
  if (entity.witherImmune && id === EFFECT.WITHER) return true;
  return false;
}

// §2.2 — addEffect with the Java-exact upgrade path.
export function addEffect(entity, id, amplifier, duration, ambient = false) {
  if (!entity.effects) return false;
  if (isImmuneTo(entity, id)) return false;
  if (EFFECT_META[id]?.instant) return false;   // instants never enter the map
  const cur = entity.effects.get(id);
  if (!cur) {
    entity.effects.set(id, { amplifier, duration, ambient });
    onEffectAdded(entity, id, amplifier);
    return true;
  }
  if (amplifier > cur.amplifier) {
    cur.amplifier = amplifier; cur.duration = duration; cur.ambient = ambient;
    onEffectAdded(entity, id, amplifier);        // re-grant (absorption refresh etc.)
    return true;
  }
  if (amplifier === cur.amplifier && duration > cur.duration) {
    cur.duration = duration; cur.ambient = ambient;   // same level, longer wins
    return true;
  }
  return false;                                   // weaker/shorter: no-op
}

export function removeEffect(entity, id) {
  if (entity.effects?.delete(id)) onEffectRemoved(entity, id);
}

// §16 persistence — effects serialize as a flat array; absorption is a plain field.
export function serializeEffects(entity) {
  if (!entity.effects?.size) return undefined;
  const out = [];
  for (const [id, fx] of entity.effects) out.push({ id, amplifier: fx.amplifier, duration: fx.duration, ambient: fx.ambient });
  return out;
}
// `replace` = 14 §5's "authoritative overwrite of client copy": ids absent from
// `arr` are REMOVED, so a host that cleared its effects (respawn, milk) actually
// clears the client's copy instead of leaving it to run out on its own. Removal
// goes through removeEffect so onEffectRemoved still fires (absorption reset,
// invisibility un-hide). Save-path callers keep the additive default — the
// entity they load into starts with an empty map.
export function applyEffectsData(entity, arr, replace = false) {
  if (!Array.isArray(arr)) return;
  if (replace && entity.effects) {
    const keep = new Set(arr.map(e => e && e.id));
    for (const id of [...entity.effects.keys()]) if (!keep.has(id)) removeEffect(entity, id);
  }
  for (const e of arr) {
    if (e && typeof e.id === 'number') entity.effects.set(e.id, { amplifier: e.amplifier | 0, duration: e.duration | 0, ambient: !!e.ambient });
  }
}
export function clearEffects(entity) {
  if (!entity.effects) return;
  for (const id of [...entity.effects.keys()]) removeEffect(entity, id);
  entity.absorption = 0;
}

// §2.6 side effects.
function onEffectAdded(entity, id, amplifier) {
  if (id === EFFECT.ABSORPTION) entity.absorption = 4 * (amplifier + 1);   // re-grant resets to full
  else if (id === EFFECT.INVISIBILITY) setMeshVisible(entity, false);
}
function onEffectRemoved(entity, id) {
  if (id === EFFECT.ABSORPTION) entity.absorption = 0;
  else if (id === EFFECT.INVISIBILITY) setMeshVisible(entity, true);
}
function setMeshVisible(entity, visible) {
  // players have no third-person body; only mobs hide their mesh (§6.6).
  if (entity.type !== 'player' && entity.object3d) entity.object3d.visible = visible;
}

// §2.5 applyInstant — instant health/damage with undead inversion (§4.3).
export function applyInstant(target, effectId, amplifier, potency, source = null) {
  if (target.effectImmune) return;
  const isHeal = (effectId === EFFECT.INSTANT_HEALTH) !== !!target.undead;
  if (isHeal) target.heal?.(potency * 4 * 2 ** amplifier);                 // float heal, no i-frames
  else target.hurt(Math.floor(potency * 6 * 2 ** amplifier + 0.5), 'magic', { attacker: source });
}

// §3.5 timing — period tables by amplifier (>> amp, floor 1).
const period = (base, amp) => Math.max(base >> amp, 1);

// §2.4 tickEffects — the per-tick loop. Guard the empty case (§18).
export function tickEffects(entity) {
  if (!entity.effects || (entity.effects.size === 0 && !entity.absorption)) return;
  for (const [id, fx] of entity.effects) {
    periodicAction(entity, id, fx);          // uses fx.duration BEFORE decrement
    fx.duration -= 1;
    if (fx.duration <= 0) { entity.effects.delete(id); onEffectRemoved(entity, id); }
  }
  // Reconcile the invisibility mesh state — onEffectAdded's hide is not replayed
  // on load (applyEffectsData restores raw), and object3d may be null at that time;
  // this self-corrects on the first tick once the mesh exists.
  if (entity.type !== 'player' && entity.object3d) {
    const shouldHide = entity.effects.has(EFFECT.INVISIBILITY);
    if (entity.object3d.visible === shouldHide) entity.object3d.visible = !shouldHide;
  }
  emitEffectParticles(entity);
}

// §3 periodic actions — only regen/poison/wither/hunger act per tick; the rest
// are read live by movement/mining/combat or handled on add/remove.
function periodicAction(entity, id, fx) {
  const amp = fx.amplifier, L = amp + 1;
  switch (id) {
    case EFFECT.REGENERATION: {
      const p = period(50, amp);                          // I=50, II=25, III=12, IV=6
      const maxHp = entity.maxHealth ?? 20;
      if (fx.duration % p === 0 && entity.health < maxHp) entity.heal?.(1);
      break;
    }
    case EFFECT.POISON: {
      const p = period(25, amp);                          // I=25, II=12, III=6, IV=3
      if (fx.duration % p === 0 && entity.health > 1) entity.hurt(1, 'poison');   // cannot kill
      break;
    }
    case EFFECT.WITHER: {
      const p = period(40, amp);                          // I=40, II=20, III=10, IV=5
      if (fx.duration % p === 0) entity.hurt(1, 'wither');                        // CAN kill
      break;
    }
    case EFFECT.HUNGER:
      if (entity.type === 'player') entity.exhaustion += 0.005 * L;               // §3.6
      break;
  }
}

// §6.4 — request effect-swirl particles for this entity's active effects. Kept
// decoupled: reaches the game's particle system defensively (no hard dep).
function emitEffectParticles(entity) {
  const p = entity.world?.game?.particles;
  if (!p?.emitEffectSwirls) return;
  p.emitEffectSwirls(entity);
}
