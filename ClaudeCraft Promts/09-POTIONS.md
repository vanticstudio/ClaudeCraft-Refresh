# 09 — Status Effects & Brewing

EXPANSION file. Adds the **general status-effect engine** (owned here; consumed by 08-ENCHANTING, 10-NETHER, 11-END, 13-BOSSES), the full effect catalog with exact per-tick math, brewing (brewing stand block + block entity, glass bottles, the complete recipe graph), drinkable / splash / lingering potions, the area-effect-cloud entity, tipped arrows, golden apple, golden carrot, spider eye + fermented spider eye, and brown/red mushrooms (blocks, worldgen, spread). Baseline: Minecraft Java Edition 1.20 exact values from minecraft.wiki unless marked `(approx)`; Normal difficulty. 20 ticks/s; 1 block = 1 m.

Ownership boundaries: item ingredient items from the Nether — **nether_wart, blaze_rod, blaze_powder, magma_cream, ghast_tear, glowstone_dust, gold_nugget** — are registered and sourced by **10-NETHER** (referenced here by name only). **dragon_breath** is registered by **13-BOSSES**. The item-stack `tags` object (serialization, stack-merge rules) is defined by **08-ENCHANTING**; this file adds one key, `tags.potionId`. Beacon effect application is 13's; shulker levitation is 11's; wither-skeleton wither is 10's — all three call this file's `addEffect`. Sound event names in §17 are for **16-AUDIO**. Multiplayer: all effect state, brew progress, and cloud entities are host-authoritative and replicate via 14-MULTIPLAYER's entity/block-entity sync (one line — 14 owns netcode).

## Amendments to base files

- **AMENDS CLAUDE.md §7 (Out of scope v2):** ensure "brewing/potions" is absent from the out-of-scope list (coordination/arbitration is governed globally by CLAUDE.md).
- **AMENDS 01 §13.1:** `LivingEntity` gains fields `effects = Map<effectId, {amplifier, duration, ambient}>` (empty by default) and `absorption = 0` (float HP). Add entity subclasses to the hierarchy list: `Entity → ThrownPotion` (§13) and `Entity → AreaEffectCloud` (§14). Entity lighting: after computing `lightScalar`, apply `lightScalar = max(lightScalar, nightVisionScale())` when the **local player** has Night Vision (§6.5).
- **AMENDS 02 §10.2:** decoration order gains step `3.5 cave mushrooms (local, stream "plant", drawn after flowers)` — appended draws keep all existing streams byte-identical (same seed ⇒ same world as base for all pre-existing features).
- **AMENDS 02 §10.5:** add the two mushroom feature rows specified in §7.4 of this file.
- **AMENDS 03 §2.4:** persistent player state gains `effects: [{id, amplifier, duration, ambient}]` and `absorption: float`.
- **AMENDS 03 §4:** insert pipeline step `1.5 tickEffects(p)` (§2.4 of this file) between timer decrement and `updateSneak`. Effects must tick before movement so speed changes apply the same tick.
- **AMENDS 03 §5.3:** ground speed becomes `speedGround = 0.1 * mult * effMove * (0.6/slip)^3` where `effMove = max(0, (1 + 0.2·L_speed) · (1 − 0.15·L_slowness))` (levels `L` = amplifier + 1, 0 when absent). `speedAir` is **unchanged** (Java: the movement-speed attribute does not affect air acceleration).
- **AMENDS 03 §6.2:** jump velocity becomes `v.y = 0.42 + 0.1 * L_jumpBoost`.
- **AMENDS 03 §6.1:** while Slow Falling is active and `v.y <= 0`, gravity constant is `0.01` instead of `0.08` (drag ×0.98 unchanged).
- **AMENDS 03 §10.2:** while Water Breathing is active, skip the `air -= 1` decrement entirely (air also refills normally when not submerged).
- **AMENDS 03 §11.2/11.3:** while Fire Resistance is active, `damage()` calls with source FIRE, LAVA, or BURNING apply 0 damage (fireTicks still accumulate; the flame overlay still renders).
- **AMENDS 03 §12.1:** fall damage becomes `ceil(fallDistance − 3 − L_jumpBoost)`; while Slow Falling is active, `fallDistance = 0` continuously. Strike the §12.3 note "No Jump Boost / Feather Falling modifiers" → Jump Boost now applies (Feather Falling is 08's).
- **AMENDS 03 §15.2:** activate the dormant hook line: `speed *= (1 + 0.2 * L_haste)` then `speed *= FATIGUE_MULT[amp_fatigue]` per §3.3 of this file (Efficiency's term is activated by 08).
- **AMENDS 03 §16.1** (as restructured by 08 §7.3's canonical step list): **step 4** (self-use items) now includes potions (item 371): drinkable regardless of hunger, 32-tick use channel like food.
- **AMENDS 03 §18.3:** `targetFovScale = (sprinting ? 1.10 : 1.0) + 0.05·L_speed − 0.05·L_slowness`, clamped to [0.85, 1.30] `(approx — vanilla derives FOV from the speed attribute ratio)`.
- **AMENDS 03 §20.2:** inside `damage()`, after armor reduction insert the §4.2 magic-reduction stage (Resistance → 08 protection hook → Absorption) before subtracting health. Add heart-bar recolor triggers per §6.3.
- **AMENDS 03 §23:** HUD table gains rows: effect icon stack (§6.1), absorption hearts row (§6.3), heart recolors (§6.3).
- **AMENDS 04 §11.2:** add uniform `uNightVision` (float 0–1, updated per frame from §6.5's `nightVisionScale()`). After `bSky` is computed: `bSky = max(bSky, uNightVision)` — an internal-light floor of 15 on the sky channel. No remesh, no relight; identical hook pattern to `uSkyDarken`.
- **AMENDS 05 §1:** per-mob tick order gains step `1.5 tickEffects(mob)` (after timers, before environment). Persisted mob fields gain `effects` (same schema as the player's).
- **AMENDS 05 §2:** spider drop table: replace "Spider eye: skipped" with **"1/3 chance of 1 spider_eye (player-caused death only, additive to string)"**. Stat blocks gain a `flags` row: zombie `undead`, skeleton `undead`, spider `poisonImmune`. (10 marks wither skeleton `undead`; 13 marks the wither `undead, witherImmune` and the ender dragon `effectImmune`.)
- **AMENDS 05 §6:** target acquisition: replace the sneak factor line with `effectiveRange = detectionRange × visibilityFactor(player)` per §3.9 of this file (covers sneaking ×0.8 **and** Invisibility).
- **AMENDS 05 §11:** the arrow entity gains an optional `potionId` field (tint + effect pass-through, §15). Stuck-arrow pickup returns a `tipped_arrow` item carrying the same `tags.potionId` when the field is set.
- **AMENDS 05 §13.1:** attack damage becomes `baseDamage = max(0, weaponDamage + 3·L_strength − 4·L_weakness)` before the `(0.2 + 0.8p²)` multiplier and crits. Applies to mob melee too (a Weakness-I zombie deals max(0, 3−4) = 0). Strength/Weakness never affect arrows.
- **AMENDS 05 §13.2:** attack-speed table note: `attackSpeed *= (1 + 0.1 · L_haste)` (Haste also speeds the cooldown recovery; Mining Fatigue does not affect attack speed — Java parity).
- **AMENDS 05 §14:** `applyRest` gains the §4.2 stage order (armor → Resistance → 08 hook → Absorption → health). `armorApplies(source)` table gains rows MAGIC / POISON / WITHER → armor **no**, durability **no**, knockback **no** (MAGIC = instant health/harming).
- **AMENDS 06 §1:** registry extended: blocks 110–112 (113–114 reserved), items 370–378 (379–389 reserved) — tables live in §§7–8 of this file. Blocks 110–112 auto-generate block-items per 06's convention.
- **AMENDS 06 §2 (id 32 glowstone):** drop note becomes "2–4 glowstone_dust (item owned by 10)" once 10 lands; until then base note stands.
- **AMENDS 06 §7.4 (id 339 sugar):** replace "reserved — no consumer in scope" with "brewing ingredient (09 §12) + fermented spider eye ingredient (09 §11)".
- **AMENDS 06 §10.4:** strike "golden apple" from the deliberately-no-recipe list; recipes for golden apple / golden carrot / glass bottle / fermented spider eye / brewing stand / tipped arrows live in 09.
- **AMENDS 06 §12.4:** food poisoning is no longer a hardcoded timer. Eating rotten flesh (80%) or raw chicken (30%) now calls `addEffect(player, HUNGER, amp 0, 600 ticks)`. Delete the `foodPoisonTicks` field (persistence migrates it to an effects entry); the green hunger bar renders while the Hunger effect is active; the 0.005/t exhaustion line in §12.1 becomes the Hunger effect's per-tick action (§3.6 here). Strike the "> Adaptation: single hardcoded timer" note.
- **AMENDS 06 §14.1/§15.3:** containers gain the brewing stand screen (5 slots, §10.4); screens list gains "brewing stand".
- **AMENDS 06 §18:** persistence rows gain: brewing stand `{5 × slot, brewTime, fuel}`; per-living-entity `effects` + `absorption`; item stacks may carry `tags` (schema owned by 08; this file uses `tags.potionId: string`).

## Contents

1. ID assignments (final)
2. Status-effect engine
3. Effect catalog — exact per-tick math
4. Damage-pipeline integration & immunity table
5. Effect sources summary
6. HUD, rendering & particles
7. New blocks: mushrooms & brewing stand
8. New items registry
9. Golden apple & golden carrot
10. Brewing stand: block entity & UI
11. Bottles, water bottles & fermented spider eye
12. The brewing graph (recipes, modifiers, corruptions, cut list)
13. Splash potions
14. Lingering potions & the area-effect cloud
15. Tipped arrows
16. Persistence
17. Sound events (for 16-AUDIO)
18. Performance notes
19. Acceptance checklist

---

## 1. ID assignments (final)

### 1.1 Blocks (allotted range 110–114)

| ID | Name | Section |
|---:|---|---|
| 110 | brown_mushroom | §7.1 |
| 111 | red_mushroom | §7.1 |
| 112 | brewing_stand | §7.2 |
| 113–114 | **reserved, unused by 09** | — |

### 1.2 Items (allotted range 370–389)

| ID | Name | Stack | Section |
|---:|---|---:|---|
| 370 | glass_bottle | 64 | §11.1 |
| 371 | potion | 1 | §11.2 (uses `tags.potionId`) |
| 372 | splash_potion | 1 | §13 (uses `tags.potionId`) |
| 373 | lingering_potion | 1 | §14 (uses `tags.potionId`) |
| 374 | spider_eye | 64 | §8 (food) |
| 375 | fermented_spider_eye | 64 | §11.3 |
| 376 | golden_apple | 64 | §9.1 (food) |
| 377 | golden_carrot | 64 | §9.2 (food) |
| 378 | tipped_arrow | 64 | §15 (uses `tags.potionId`) |
| 379–389 | **reserved, unused by 09** | — | — |

**Potion representation (decision):** exactly **one item id per bottle form** — 371 drinkable, 372 splash, 373 lingering — plus 378 for tipped arrows. The potion variant lives in `tags.potionId` (string key into §12.1's potion registry; `"water"` for water bottles). Stacks with different `tags` never merge (rule owned by 08). There is **no** per-potion item id and no mundane/thick/uncraftable ids.

### 1.3 Effect ids (vanilla Java numeric ids; stable in saves)

Implemented: 1 speed, 2 slowness, 3 haste, 4 mining_fatigue, 5 strength, 6 instant_health, 7 instant_damage, 8 jump_boost, 10 regeneration, 11 resistance, 12 fire_resistance, 13 water_breathing, 14 invisibility, 16 night_vision, 17 hunger, 18 weakness, 19 poison, 20 wither, 22 absorption, 25 levitation, 28 slow_falling. **Not implemented** (ids reserved, never registered): 9 nausea, 15 blindness, 21 health_boost, 23 saturation, 24 glowing, 26 luck, 27 bad_luck.

> Adaptation: **Nausea is cut.** Its only vanilla survival source (pufferfish) is out of scope, and the screen-warp shader is dead weight with no source. Id 9 stays reserved.

---

## 2. Status-effect engine

### 2.1 Data model

Every `LivingEntity` (player + all mobs) carries:

```js
effects: Map<effectId, { amplifier: int,   // 0-based: amplifier 0 = level I
                         duration:  int,   // remaining ticks
                         ambient:   bool }> // true = beacon-style (13); dimmer particles, blue HUD frame
absorption: float                           // extra-health pool, ≥ 0 (§3.7)
```

Instant effects (6, 7) never enter the map — they resolve immediately via `applyInstant` (§2.5).

### 2.2 addEffect — stacking rules (Java-exact upgrade path)

```js
function addEffect(entity, id, amplifier, duration, ambient = false) {
  if (entity.isImmuneTo(id)) return false;          // §4.3 immunity table
  const cur = entity.effects.get(id);
  if (!cur) {
    entity.effects.set(id, { amplifier, duration, ambient });
    onEffectAdded(entity, id, amplifier);           // §2.6 side effects
    return true;
  }
  if (amplifier > cur.amplifier) {                  // stronger replaces outright
    cur.amplifier = amplifier; cur.duration = duration; cur.ambient = ambient;
    onEffectAdded(entity, id, amplifier);           // re-grant (absorption refresh etc.)
    return true;
  }
  if (amplifier === cur.amplifier && duration > cur.duration) {
    cur.duration = duration; cur.ambient = ambient; // same level, longer wins
    return true;
  }
  return false;                                     // weaker/shorter: no-op
}
```

> Adaptation: vanilla queues a downgraded instance as a "hidden effect" that resumes when the stronger one expires. Skipped — a weaker application onto a stronger active effect is simply ignored.

### 2.3 removeEffect / clear

`removeEffect(entity, id)` deletes the entry and runs `onEffectRemoved` (§2.6). `clearEffects(entity)` removes all (used on death). **There is no milk bucket in scope** (06 excludes cake/milk): death is the only full-clear a survival player can trigger; effects otherwise run out.

### 2.4 tickEffects — the per-tick loop

Called at player pipeline step 1.5 (03 §4) and mob tick step 1.5 (05 §1):

```js
function tickEffects(e) {
  for (const [id, fx] of e.effects) {
    periodicAction(id, fx, e);            // §3 table; uses fx.duration BEFORE decrement
    fx.duration -= 1;
    if (fx.duration <= 0) { e.effects.delete(id); onEffectRemoved(e, id); }
  }
  emitEffectParticles(e);                 // §6.4
}
```

Periodic actions fire when `fx.duration % period == 0` (vanilla predicate — first tick of a fresh effect qualifies when duration is a multiple of the period).

### 2.5 applyInstant (instant health / instant damage)

```js
function applyInstant(target, effectId, amplifier, potency /*0..1*/, source /*owner or null*/) {
  const isHeal = (effectId === INSTANT_HEALTH) !== target.undead;   // undead inversion (§4.3)
  if (isHeal) target.heal(potency * 4 * 2**amplifier);                       // float heal, no i-frames
  else hurt(target, floor(potency * 6 * 2**amplifier + 0.5), MAGIC, source); // 05 §14 pipeline
}
```

MAGIC damage: no armor reduction, no armor durability loss, no knockback (§4.1). If `source` is the player, resulting mob deaths count as player kills (drops + XP per 05 §15).

### 2.6 onEffectAdded / onEffectRemoved side effects

| Effect | On add | On remove |
|---|---|---|
| absorption | `entity.absorption = 4 × (amplifier+1)` (re-grant resets the pool to full) | `entity.absorption = 0` |
| invisibility | hide mob mesh (§6.6) | show mesh |
| night_vision (player) | start `uNightVision` ramp (§6.5) | ramp handled by flash formula |
| all others | none — multipliers are read live from the map | none |

Speed/slowness/haste/strength etc. are **not** cached into attributes; the movement/mining/combat formulas read `L(id) = effects.has(id) ? effects.get(id).amplifier + 1 : 0` each tick (cheap Map lookups; ≤ a handful of effects at once).

---

## 3. Effect catalog — exact per-tick math

Level `L` = amplifier + 1 in every formula below. Color column = Java 1.20 particle/potion color (post-1.19.4 palette — 1.19.4 recolored speed/slowness/strength/harming/jump-boost/resistance/fire-res/water-breathing/invisibility/night-vision/poison; the rest kept their classic constants).

| id | Effect | Type | Color | Mechanic (exact) |
|---:|---|---|---|---|
| 1 | Speed | + | `#33EBFF` | ground-move ×(1 + 0.2L) — 03 §5.3 hook. Walk I = 5.18 m/s, sprint I = 6.73 m/s |
| 2 | Slowness | − | `#8BAFE0` | ground-move ×(1 − 0.15L), floor 0 (Slowness VII+ = frozen). Slowness IV sprint ≈ 2.25 m/s |
| 3 | Haste | + | `#D9C043` | mining speed ×(1 + 0.2L) (03 §15.2); attack speed ×(1 + 0.1L) (05 §13.2) |
| 4 | Mining Fatigue | − | `#4A4217` | mining speed × FATIGUE_MULT (§3.3); attack speed unaffected |
| 5 | Strength | + | `#FCC500` | melee baseDamage +3L (05 §13.1) |
| 18 | Weakness | − | `#484D48` | melee baseDamage −4L, floored at 0 |
| 6 | Instant Health | + | `#F82423` | instant heal 4·2^amp HP; **damages undead** 6·2^amp (§2.5) |
| 7 | Instant Damage | − | `#A9656A` | instant 6·2^amp MAGIC damage; **heals undead** 4·2^amp |
| 8 | Jump Boost | + | `#FDFF84` | jump velocity 0.42 + 0.1L (apex I ≈ 1.84, II ≈ 2.52 blocks); fall damage −1 block per L |
| 10 | Regeneration | + | `#CD5CAB` | heal 1 HP every `max(50 >> amp, 1)` ticks (I=50, II=25, III=12) if health < 20 |
| 19 | Poison | − | `#87A363` | 1 MAGIC dmg every `max(25 >> amp, 1)` ticks (I=25, II=12), **only while health > 1** — cannot kill |
| 20 | Wither | − | `#352A27` | 1 WITHER dmg every `max(40 >> amp, 1)` ticks (I=40, II=20) — **CAN kill**; hearts render black (§6.3). Durations set by sources: wither skeleton I 0:10 (10), wither boss II 0:10 Normal (13 — confirmed with 13) |
| 11 | Resistance | + | `#8F45ED` | incoming damage ×(1 − 0.2L) after armor; L ≥ 5 = immune. Never reduces VOID or STARVATION |
| 12 | Fire Resistance | + | `#FF9900` | FIRE/LAVA/BURNING damage → 0 (03 §11 hook); overlay/fireTicks unchanged |
| 13 | Water Breathing | + | `#96D7BE` | air never depletes (03 §10.2 hook) |
| 16 | Night Vision | + | `#C2FF66` | render-only: sky-channel brightness floor 1.0 via `uNightVision` (04 §11.2 hook, §6.5) |
| 14 | Invisibility | ± | `#F6F6F6` | mob detection shrinks per §3.9; mesh hidden; particles still emit |
| 17 | Hunger | − | `#587653` | player only: exhaustion +0.005L per tick (0.1L/s); hunger bar renders green |
| 22 | Absorption | + | `#2552A5` | grants 4L absorption HP (yellow hearts); pool eats damage first (§4.2); not regenerated; zeroed on expiry |
| 25 | Levitation | − | `#CEFFFF` | `v.y += (0.05L − v.y) × 0.2` per tick, replaces gravity that tick → steady rise 0.9L m/s. Used by 11's shulkers |
| 28 | Slow Falling | + | `#FFEFD1` | gravity 0.01 while `v.y ≤ 0` (03 §6.1); no fall damage (`fallDistance = 0`) |

### 3.1 Speed / Slowness application point (03 §5.3, verbatim target)

```
effMove     = max(0, (1 + 0.2·L_speed) · (1 − 0.15·L_slowness))
speedGround = 0.1 · sprintMult · effMove · (0.6/slip)^3
speedAir    = 0.02 · sprintMult              // NOT scaled by effects (Java parity)
```

Equilibrium checks (±1%): Speed I walk **5.18 m/s**, Speed I sprint **6.73 m/s**, Speed II sprint **7.85 m/s**, Slowness I walk **3.67 m/s**, Slowness IV walk **1.73 m/s**. Mobs: multiply `mob.moveSpeed` by `effMove` in 05 §1's locomotion blend.

### 3.2 Jump Boost (03 §6.2)

`v.y = 0.42 + 0.1·L`. Model apex: I ≈ 1.836, II ≈ 2.517 blocks (wiki lists 1.83 / 2.51 (approx model variance)). Fall damage: `ceil(fallDistance − 3 − L_jumpBoost)`.

### 3.3 Haste / Mining Fatigue (03 §15.2)

```
speed *= (1 + 0.2 · L_haste)
FATIGUE_MULT = [0.3, 0.09, 0.0027, 0.00081]   // amplifier 0,1,2,3+ — Java's exact table
speed *= FATIGUE_MULT[min(amp_fatigue, 3)]     // when Mining Fatigue present
```

Note the table is **not** a clean 0.3^L progression (0.0027 ≠ 0.027) — copy it verbatim. Haste II + iron pick on stone: `6×1.4/1.5/30 → 0.187/tick → 6 ticks = 0.3 s`.

### 3.4 Strength / Weakness (05 §13.1)

`baseDamage = max(0, weapon + 3·L_strength − 4·L_weakness)`, then cooldown `(0.2 + 0.8p²)`, then crit ×1.5. Diamond sword + Strength II full-charge crit: `(7 + 6) × 1.5 = 19.5`.

### 3.5 Regeneration / Poison / Wither timing table

| Effect / amp | 0 (I) | 1 (II) | 2 (III) | 3 (IV) |
|---|---|---|---|---|
| Regeneration heals 1 HP every | 50 t | 25 t | 12 t | 6 t |
| Poison deals 1 every | 25 t | 12 t | 6 t | 3 t |
| Wither deals 1 every | 40 t | 20 t | 10 t | 5 t |

Poison checks `health > 1` before each hit — floors at half a heart. Wither has no floor. Both deal typed damage through 05 §14's `hurt()`; the 10-tick i-frame excess rule naturally caps stacked DoT at ~1 HP per 10 ticks — keep it, vanilla behaves the same way.

### 3.6 Hunger (players only)

Per tick: `exhaustion += 0.005 × L` (06 §12.1's food-poisoning row, now generalized). Mobs ignore it.

### 3.7 Absorption

- On add/re-add: `absorption = 4 × L` (I = 2 yellow hearts, IV = 8 — enchanted-apple tier, unused here but 13's beacon may grant higher).
- Damage: absorbed before health (§4.2). Pool never regenerates; it persists at its damaged value until the effect expires (then 0).
- HUD: yellow hearts stacked in a row **above** the red hearts, same sprite recolored `#F5C51E`, ceil(absorption/2) icons with half-heart support.

### 3.8 Levitation

```
v.y += (0.05 · L − v.y) * 0.2      // replaces the gravity step that tick
fallDistance = 0 while v.y >= 0
```

Rise speed converges to `0.05L` b/t = **0.9L m/s** `(1 m/s nominal, wiki lists 0.9 (approx))`. When it expires mid-air, normal gravity resumes and fall distance accumulates from that point (lethal — vanilla parity, and 11's shulker fights rely on it).

### 3.9 Invisibility — mob detection (05 §6 replacement)

```js
function visibilityFactor(player) {
  let f = player.sneaking ? 0.8 : 1.0;
  if (player.effects.has(INVISIBILITY)) {
    const pieces = countWornArmorPieces(player);        // 0–4
    f *= (pieces === 0) ? 0.07 : 0.175 * pieces;        // wiki-exact: 7%, else 17.5%/piece
  }
  return f;
}
effectiveRange = max(2, detectionRange * visibilityFactor(player));  // floor of 2 blocks
```

Already-aggroed mobs keep their target until normal give-up rules fire (vanilla). **Armor stays visible** in vanilla; our player has no third-person body and our mobs wear no armor, so the render rule reduces to: invisible **mobs** hide their whole mesh (`object3d.visible = false`), invisible **players** change nothing visually first-person except that effect particles keep emitting.

---

## 4. Damage-pipeline integration & immunity table

### 4.1 New damage sources (extends 05 §14 / 03 §20.4)

| Source | Armor reduces? | Armor durability? | Knockback? | Notes |
|---|---|---|---|---|
| MAGIC (instant damage, healing-vs-undead) | no | no | no | i-frames apply normally |
| POISON | no | no | no | cannot reduce below 1 HP |
| WITHER | no | no | no | can kill |

### 4.2 Stage order inside `applyRest` (05 §14, player + mobs)

```
dmg = incoming
1. armor reduction            (existing, armorApplies sources only)
2. dmg *= (1 − 0.2·L_resistance)   // floor 0; skipped for VOID/STARVATION
3. [08 hook: Protection enchantment reduction inserts here]
4. absorbed = min(entity.absorption, dmg)
   entity.absorption -= absorbed;  dmg -= absorbed
5. entity.health -= dmg            (existing death check follows)
```

Worked example: creeper 43 → full diamond (27.1) → Resistance I (×0.8 = 21.7) → Absorption I pool 4 (→ 17.7 to health). i-frame `lastHurtAmount` keeps storing the **pre-armor** incoming value (unchanged base rule).

### 4.3 Immunities & the undead flag

| Entity class | Rule |
|---|---|
| `undead` (zombie, skeleton; wither skeleton per 10; wither per 13) | Instant Health **damages** (6·2^amp), Instant Damage **heals** (4·2^amp); **immune to Regeneration and Poison** (addEffect returns false) |
| spider | immune to Poison (Java parity) |
| ender dragon (13) | immune to ALL effects — 13 sets `effectImmune` |
| wither boss (13) | additionally immune to the Wither effect |
| player in debugCreative | effects can be added but deal no damage (03 §20.2 early-out already covers) |

`clearEffects` + `absorption = 0` run on any entity death and on player respawn.

---

## 5. Effect sources summary

| Source | Effect(s) | Exact | Owner |
|---|---|---|---|
| Potions (drink/splash/lingering/tipped arrow) | per §12.1 table | this file | 09 |
| Golden apple | Absorption I 2:00 + Regeneration II 0:05 | §9.1 | 09 |
| Spider eye (eaten) | Poison I 0:05 | §8 | 09 |
| Rotten flesh (80%) / raw chicken (30%) | Hunger I 0:30 | 06 §12.4 as amended | 06/09 |
| Beacon | Speed/Haste/Resistance/Jump Boost/Strength (+ secondary Regeneration), `ambient = true` | 13's table | 13 |
| Wither skeleton melee | Wither I 0:10 | on-hit | 10 |
| Wither boss skull | Wither II 0:10 (Normal) | on-hit | 13 |
| Shulker bullet | Levitation I 0:10 | on-hit | 11 |
| Dragon's breath / dragon fireball cloud | Instant Damage (via area-effect cloud, §14) | cloud params | 13 |
| Water Breathing / Slow Falling / Mining Fatigue | **no survival source in scope** — engine-complete, debug palette only (see cut list §12.4) | — | 09 |

---

## 6. HUD, rendering & particles

### 6.1 Active-effect icons (in-world HUD)

- Stack of 24×24 px (GUI-scaled) icons in the **top-right corner**, newest below, max 8 shown.
- Icon = rounded-corner square filled with the effect color at 85% + a 1-px dark border + a white procedural glyph (16×16 pixel-map, legend format of 06 §8.1). Glyphs: speed »chevrons, slowness «chevrons, haste pick+, fatigue pick−, strength arm, weakness broken arm, jump boost ↑, regen pulsing heart, poison skull-drop, wither black skull, resistance shield, fire res flame, water breathing bubble, night vision eye, invisibility dotted outline, hunger green shank, absorption yellow heart, levitation float-lines, slow falling feather.
- Below each icon: `m:ss` remaining (ceil to seconds). Icon **blinks** (alpha 1.0↔0.3, 4-tick period) when duration < 200 ticks. `ambient` effects render the border cyan-blue instead of dark.
- Instant effects never appear (no duration).

### 6.2 Inventory-screen effect list

While the inventory (E) is open: a column on the right edge of the panel, one row per active effect — icon, name + level in Roman numerals ("Speed II"), duration `m:ss`. Scrolls if > 6.

### 6.3 Heart-bar recolors (03 §23 hook)

| Condition | Hearts render |
|---|---|
| Poison active | sickly green-olive `#739B00` fill (empty outlines unchanged) |
| Wither active | black-brown `#2B1F1B` fill |
| Both | wither wins |
| Absorption > 0 | extra yellow `#F5C51E` hearts row above (§3.7) |
| Hunger active | hunger bar (not hearts) tinted green `#6D9930` (06 rule retained) |

### 6.4 Effect particles (base Particles helper, render/Particles.js)

Per living entity per tick, if it has ≥ 1 effect: probability 0.25 (ambient-only: 0.1) spawn one swirl particle — 2×2 px quad tinted the color of a random active effect, spawned at a random point in the entity AABB, velocity `(±0.02, +0.03..0.06, ±0.02)` b/t, lifetime 12–20 ticks, alpha 0.9 (ambient 0.4). The local player's own swirls are skipped in first person (camera can't see its body). Invisible entities still emit (vanilla tell).

### 6.5 Night Vision rendering (04 §11.2 uniform)

```js
function nightVisionScale(player) {              // 0..1, evaluated per frame
  const fx = player.effects.get(NIGHT_VISION);
  if (!fx) return 0;
  return fx.duration > 200 ? 1.0
       : 0.3 + 0.7 * Math.sin((fx.duration - partialTick) * Math.PI * 0.2);  // 10-tick flash, Java-exact
}
```

Shader: `bSky = max(bSky, uNightVision)` — terrain floors at full sky brightness (night tint `uSkyTint` still applies, giving vanilla's cool blue NV nights; torch pools stay warm via the block channel max). Entities: `lightScalar = max(lightScalar, uNightVision)` (01 §13.1 amendment). Fog and sky dome are unchanged `(approx — vanilla also brightens water fog)`.

### 6.6 Invisibility rendering

Mobs: `object3d.visible = false` while invisible (arrows stuck, none — we have no visible attachments). Sheep wool, spider eyes etc. vanish with the mesh `(approx — vanilla keeps spider eyes glowing)`.

---

## 7. New blocks: mushrooms & brewing stand

### 7.1 Brown & red mushroom (blocks 110–111)

Gameplay table rows (06 §2 format):

| ID | Name | Hard | Blast | Tool | Tier | Drops | XP |
|---:|---|---:|---:|---|---|---|---|
| 110 | brown_mushroom | 0 | 0 | — | — | self | 0 |
| 111 | red_mushroom | 0 | 0 | — | — | self | 0 |

Light/render/physics rows (06 §3 format):

| ID | Emit | Opac | Pass | Shape | Grav | Solid |
|---:|---:|:---:|:---:|---|:---:|---|
| 110 | **1** | T | co | cross | — | no |
| 111 | 0 | T | co | cross | — | no |

(Brown mushrooms emit light level 1 — wiki-exact, and a nice cave tell.)

Behavior (06 §5 addendum):

- **Placement:** only on a solid opaque full cube **and** `internalLight(cell) ≤ 12` at the mushroom's cell (04 §4's internalLight). Denied otherwise. `(No podzol/mycelium in scope — the any-light substrates are cut.)`
- **Neighbor update:** pops as its item if support is gone **or** `internalLight ≥ 13` at the cell (vanilla checks light only on update, not random tick — a lit mushroom survives until something updates it; keep this quirk).
- **Spread (random tick):** 1/25 chance; count same-type mushrooms in the 9×9×3 box centered on it (±4 x/z, ±1 y); if < 5, pick one random cell in the 3×3×3 neighborhood `(approx — vanilla does two chained ±1 hops)`; place a same-type mushroom there if that cell is air with an opaque full cube below and `internalLight ≤ 12`. Makes dark mushroom farms viable (fermented spider eye is a consumable sink).
- **Bone meal → huge mushrooms: cut** (no huge-mushroom structures; bone meal on a mushroom does nothing).
- Flooded by fluids → pops (add both ids to 06 §6.1's fluid-destructible set).
- Not a food: raw mushrooms are inedible (mushroom stew is cut — no bowl item).

Textures (06 §4 vocabulary): `cross_sprite` — brown: 5×3 px tan cap `#9C7248` on a 2-px `#D8CBB4` stem, cap underside darker; red: 7×5 px dome `#C42D2D` with 4 white 1-px spots on a 2-px `#E8E0D0` stem.

### 7.2 Brewing stand (block 112)

| ID | Name | Hard | Blast | Tool | Tier | Drops | XP |
|---:|---|---:|---:|---|---|---|---|
| 112 | brewing_stand | 0.5 | 0.5 | pickaxe | **tool!** | self + all 5 slots spill | 0 |

(`tool!` = any pickaxe required for the drop, wiki-exact; hand-breaking drops nothing but still spills the slots.)

| ID | Emit | Opac | Pass | Shape | Grav | Solid |
|---:|---:|:---:|:---:|---|:---:|---|
| 112 | **1** | T | co | custom: stand | — | no |

Emission 1 matches 04 §8's pre-listed "brewing stand 1". Custom mesh: 16×2×16 px stone base slab + centered 2×14×2 px rod, plus three 6×1×6 px pad quads at 120° spacing around the rod `(approx — vanilla's model)`. No collision box (like torch) `(approx — vanilla has a 2/16 slab + rod shape; with stepHeight 0 a partial box is pure annoyance)`. Targetable + `interactable` (RMB opens §10.4's UI; sneak-place rule per 03 §16.1 applies).

Texture: base top/side `blotch(#7a7a7a,#565656,9)` (cobble family); rod `noise(#d8a03c,8)` with `#8a5a1a` shading column (blaze-gold); pads `#3a3a3a`. Item icon: flat 16×16 sprite — rod + base silhouette per 06 §8.1 legend.

**Crafting** (3×3 required):

| Output | Pattern | Key |
|---|---|---|
| brewing_stand ×1 | `.B./CCC` | B blaze_rod (item owned by 10), C cobblestone |

Comparator note for **07-REDSTONE**: the brewing stand is a comparator-readable container (5 slots, standard container-fill formula — 07 owns the formula).

### 7.3 Fuel note

The brewing stand is **not** furnace fuel and has no furnace interaction. Its own fuel is blaze powder only (§10.2).

### 7.4 Mushroom worldgen (the 02 §10.5 amendment, full text)

Append to 02 §10.5's feature table (stream `"plant"`, drawn **after** flowers — new step 3.5 in §10.2's order):

| Feature | Where | Attempts /chunk | Rule |
|---|---|---|---|
| Cave brown mushrooms | all biomes | 8 | pick `x,z` in chunk, `y = 2 + rngInt(max(1, heightAt(x,z) − 4))`; require: cell is air (a carved cave cell — decoration runs after carving in the gen worker), block below is stone/dirt/gravel/cobblestone with a full top face; place brown_mushroom |
| Cave red mushrooms | all biomes | 6 | same rule, red_mushroom |

Expected yield ≈ 0.5–1.5 mushrooms per chunk (most attempts land in solid rock and fail) — sparse, cave-flavored `(approx — vanilla generates 1/4-chance patches at light ≤ 12; light doesn't exist at gen time, but carved caves are dark by construction)`. Surface/swamp/huge mushrooms: cut. If 10-NETHER wants Nether mushrooms it references block ids 110/111 in its own gen amendment (10's call).

---

## 8. New items registry

06 §7 format. `Dmg` — none of these are weapons.

| ID | Name | Stack | Class | Data |
|---:|---|---:|---|---|
| 370 | glass_bottle | 64 | tool-like use | fills to water bottle on water RMB (§11.1) |
| 371 | potion | 1 | drinkable | `tags.potionId`; drink 32 t; returns glass_bottle |
| 372 | splash_potion | 1 | throwable | `tags.potionId`; §13 |
| 373 | lingering_potion | 1 | throwable | `tags.potionId`; §14 |
| 374 | spider_eye | 64 | **food** | hunger 2, saturation 3.2, on eat: Poison I 100 t (0:05) — wiki-exact; brewing ingredient |
| 375 | fermented_spider_eye | 64 | material | §11.3; brewing modifier |
| 376 | golden_apple | 64 | **food** | §9.1 |
| 377 | golden_carrot | 64 | **food** | hunger 6, saturation 14.4 (best saturation food in scope); brewing ingredient |
| 378 | tipped_arrow | 64 | ammo | `tags.potionId`; §15; consumed by bow before plain arrows? **No — see §15.3 selection rule** |

Spider eye is the first food whose "poison" is the real Poison effect (bypasses 06's Hunger-based food-poisoning path entirely).

Item sprites (06 §8.1 legend): spider eye = 6×6 crimson `#8C1010` orb, black slit pupil, 1-px `#E06060` sheen; fermented = same at 7×7, sickly `#7A5B8E` purple-gray, drooping outline; golden apple = 06's apple map with palette swap to `#FCE34C`/`#D4A017` + 2 white sparkle pixels; golden carrot = carrot silhouette in `#FFB821` with `#FFE973` highlights; glass bottle = 06 §8.1-style flask outline `#C9DBDC` with 30% fill; tipped arrow = 06 arrow map with head recolored per potion color. Potion bottle icon: §12.3.

---

## 9. Golden apple & golden carrot

### 9.1 Golden apple (item 376)

- Food: **hunger 4, saturation 9.6**. **Always edible**, even at food 20 (bypasses 06 §12.4's full-hunger gate). Eat time 32 t.
- On eat: `addEffect(ABSORPTION, amp 0, 2400 t)` (2:00, 4 absorption HP) + `addEffect(REGENERATION, amp 1, 100 t)` (0:05 — heals 4 HP at 1 per 25 t). Wiki-exact Java values.
- Crafting: `GGG/GAG/GGG` — G gold_ingot (06 id 324), A apple (06 id 304) → 1 golden_apple.
- **Enchanted golden apple: OUT.** Not craftable since Java 1.9 and we ship no loot chests in base — no item id, no recipe, stated here so nobody adds one.
- Brewing role: Instant Health ingredient (§12 — Adaptation).

### 9.2 Golden carrot (item 377)

- Food: **hunger 6, saturation 14.4**. Normal edibility rules. Eat time 32 t.
- Crafting: `NNN/NCN/NNN` — N **gold_nugget (item owned by 10-NETHER**, which also owns ingot↔nugget conversion recipes**)**, C carrot (06 id 315) → 1 golden_carrot.
- Brewing role: Night Vision ingredient (§12).
- Availability chain: carrot bootstraps from 06's zombie rare drop → farm → nuggets from 10. Night Vision is therefore gated on first Nether entry, like fire resistance — intended.

---

## 10. Brewing stand: block entity & UI

### 10.1 Slots

| Slot | Accepts |
|---|---|
| bottle 0–2 | potion / splash_potion / lingering_potion (any potionId), 1 each |
| ingredient | any item in §12.2's ingredient column (incl. modifiers) |
| fuel | blaze_powder only (item owned by 10) |

Fields: `slots[5]`, `brewTime` (0 idle, else counts **down** 400→0), `fuel` (0–20 charges).

### 10.2 Tick algorithm (each game tick)

```
canBrew = ingredient non-empty
          AND at least one bottle slot holds a potion P where mix(P.potionId, ingredient) exists (§12.2)
if fuel == 0 and fuelSlot non-empty and canBrew-or-brewing:
    fuel = 20; fuelSlot.count -= 1                        # 1 blaze powder = 20 brews, wiki-exact
if brewTime > 0:
    if not canBrew: brewTime = 0                          # ingredient pulled → hard reset (vanilla)
    else:
        brewTime -= 1
        if brewTime == 0:
            for each bottle slot with valid mix: bottle.tags.potionId = mix(...)
                                                  # gunpowder/dragon-breath swap the ITEM id instead (§12.2)
            ingredient.count -= 1; fuel -= 1
            emit sound "block.brewing.done" (§17); comparator update (07)
elif canBrew and fuel > 0:
    brewTime = 400                                        # 20 s, wiki-exact
```

- One ingredient converts **all** matching bottles simultaneously (1–3 per operation) — potion economy scales ×3 per brew, vanilla-exact.
- Non-matching bottles are untouched (e.g., water + awkward side by side: nether wart converts only the water).
- No XP from brewing (vanilla parity).
- Breaking the stand spills all 5 slots + itself (pickaxe only for the block drop, §7.2).

### 10.3 Brew validity = `mix(potionId, ingredient)`

A lookup into §12.2's edge table, extended over item forms: effect ingredients and redstone/glowstone/fermented-eye act on the `tags.potionId` of any bottle form (drinkable, splash, lingering alike — vanilla rule); `gunpowder` maps item 371→372 (any potionId, including water); `dragon_breath` maps 372→373. Invalid combos simply never start a brew (mundane/thick dead-ends are cut, §12.4).

### 10.4 UI (06 §15.3 screen family)

Panel layout: ingredient slot top-center; the 3 bottle slots in a shallow arc bottom-center; fuel slot far-left with a horizontal blaze-flame bar showing `fuel/20`; a bubble column between ingredient and bottles animating while `brewTime > 0`; a progress arrow filling `1 − brewTime/400`. Standard 27+9 player inventory below. Shift-click routing: potions → first free bottle slot; blaze powder → fuel; §12.2 ingredients → ingredient; else no-op.

---

## 11. Bottles, water bottles & fermented spider eye

### 11.1 Glass bottle (item 370)

- Crafting: `G.G/.G.` — G glass (06 id 31, from smelting sand) → **3 glass_bottle**.
- RMB targeting a **water source or flowing water cell** (raycast per 03 §14, fluid cells targetable for this item only): consume 1 bottle → give 1 `potion` with `tags.potionId = "water"`. Infinite (does not remove the water). Sound: `item.bottle.fill`.
- RMB elsewhere: nothing.

### 11.2 Water bottle & drinking

- Drinking any `potion` (371): hold RMB 32 ticks (same use channel as food, 03 §16.1 as amended; **no hunger requirement**), then: apply the potionId's effect via `addEffect`/`applyInstant`, consume the potion, return 1 `glass_bottle` to inventory (drops at feet if full). Gulp sounds every 4 ticks (§17).
- `"water"` and `"awkward"` potionIds apply nothing (drinkable no-ops; still return the bottle).
- Eating/drinking cancels sprint (03 §7 rule already covers `usingItem`).

### 11.3 Fermented spider eye (item 375)

- Crafting (**shapeless**, fits 2×2): 1 spider_eye + 1 sugar (06 id 339) + 1 **brown_mushroom** (block-item 110) → 1 fermented_spider_eye.
- **Decision:** mushrooms are added as real blocks (§7.1/§7.4) rather than substituting the recipe — vanilla recipe preserved exactly, and caves gain a forageable. Red mushroom ships alongside for worldgen pairing and spread symmetry; it has **no crafting consumer** (collectible/decoration — precedent: base's lapis "collectible only").
- Not edible. Sole use: brewing corruption modifier (§12.2).

### 11.4 Spider eye sourcing (05 §2 amendment)

Spider drops become: `0–2 string` + **1/3 chance of 1 spider_eye** (player-caused death only). Expected eyes ≈ 0.33/kill, matching Java's 0–1 @ 1/3.

---

## 12. The brewing graph

### 12.1 Potion registry (`potionId` → payload) — Java 1.20 exact

Durations in ticks (mm:ss). `amp` = amplifier (0-based). One effect per potion (no mixed-effect potions in scope — turtle master cut).

| potionId | Effect | amp | Ticks | Time | Bottle tint |
|---|---|---:|---:|---|---|
| water | — | — | — | — | `#385DC6` |
| awkward | — | — | — | — | `#385DC6` |
| speed | Speed | 0 | 3600 | 3:00 | `#33EBFF` |
| long_speed | Speed | 0 | 9600 | 8:00 | `#33EBFF` |
| strong_speed | Speed | 1 | 1800 | 1:30 | `#33EBFF` |
| strength | Strength | 0 | 3600 | 3:00 | `#FCC500` |
| long_strength | Strength | 0 | 9600 | 8:00 | `#FCC500` |
| strong_strength | Strength | 1 | 1800 | 1:30 | `#FCC500` |
| regeneration | Regeneration | 0 | 900 | 0:45 | `#CD5CAB` |
| long_regeneration | Regeneration | 0 | 1800 | 1:30 | `#CD5CAB` |
| strong_regeneration | Regeneration | 1 | 450 | 0:22.5 | `#CD5CAB` |
| fire_resistance | Fire Resistance | 0 | 3600 | 3:00 | `#FF9900` |
| long_fire_resistance | Fire Resistance | 0 | 9600 | 8:00 | `#FF9900` |
| poison | Poison | 0 | 900 | 0:45 | `#87A363` |
| long_poison | Poison | 0 | 1800 | 1:30 | `#87A363` |
| strong_poison | Poison | 1 | 432 | 0:21.6 | `#87A363` |
| night_vision | Night Vision | 0 | 3600 | 3:00 | `#C2FF66` |
| long_night_vision | Night Vision | 0 | 9600 | 8:00 | `#C2FF66` |
| invisibility | Invisibility | 0 | 3600 | 3:00 | `#F6F6F6` |
| long_invisibility | Invisibility | 0 | 9600 | 8:00 | `#F6F6F6` |
| healing | Instant Health | 0 | — | instant | `#F82423` |
| strong_healing | Instant Health | 1 | — | instant | `#F82423` |
| harming | Instant Damage | 0 | — | instant | `#A9656A` |
| strong_harming | Instant Damage | 1 | — | instant | `#A9656A` |
| weakness | Weakness | 0 | 1800 | 1:30 | `#484D48` |
| long_weakness | Weakness | 0 | 4800 | 4:00 | `#484D48` |
| slowness | Slowness | 0 | 1800 | 1:30 | `#8BAFE0` |
| long_slowness | Slowness | 0 | 4800 | 4:00 | `#8BAFE0` |
| strong_slowness | Slowness | **3** | 400 | 0:20 | `#8BAFE0` |

(29 ids. `strong_slowness` is Slowness IV — Java 1.16+ exact.)

### 12.2 Recipe graph — every edge

**Base chain:** `water` + **nether_wart** (10) → `awkward`.

**Effect ingredients** (act on `awkward` only):

| Ingredient (owner) | awkward → |
|---|---|
| sugar (06) | speed |
| blaze_powder (10) | strength |
| ghast_tear (10) | regeneration |
| magma_cream (10) | fire_resistance |
| spider_eye (09) | poison |
| golden_carrot (09) | night_vision |
| **golden_apple (09)** | **healing** — `> Adaptation:` glistering melon slice is cut (no melons in any file). The healing ingredient is the golden apple: thematically exact, uses an existing item, and one apple + 8 gold ingots yields **three** healing potions per brew — comparable cost-per-bottle to vanilla late-game. |

**Corruption (fermented_spider_eye)** — Java-exact mapping over our set:

| Input | → Output |
|---|---|
| water | weakness (the only potion brewable without nether wart — vanilla quirk, keep) |
| speed | slowness |
| long_speed | long_slowness |
| strong_speed | **nothing** (enhanced Swiftness cannot be corrupted — wiki-exact) |
| night_vision | invisibility |
| long_night_vision | long_invisibility |
| healing | harming |
| strong_healing | strong_harming |
| poison | harming |
| long_poison | harming |
| strong_poison | strong_harming |
| anything else | nothing (brew does not start) |

**Modifiers:**

| Modifier (owner) | Rule |
|---|---|
| redstone (06 id 342) | base form → `long_` form (8:00 / 4:00 / 1:30 per §12.1). Invalid on `long_`/`strong_` forms and on instants except: none. `water`+redstone → nothing (mundane cut) |
| glowstone_dust (10) | base form → `strong_` form (II at halved-ish duration; slowness → Slowness IV 0:20). Invalid on `long_`/`strong_` forms; invalid where no strong form exists (fire res, night vision, invisibility, weakness). `water`+glowstone → nothing (thick cut) |
| gunpowder (06 id 329) | item 371 → 372 (splash), any potionId incl. water; potionId unchanged |
| dragon_breath (13) | item 372 → 373 (lingering), any potionId; **only from splash** (vanilla-exact) |

Modifiers and ingredients apply identically to splash/lingering forms (a splash awkward + sugar → splash speed — vanilla rule).

### 12.3 Bottle icon pipeline

One 16×16 base bottle sprite (glass outline + cork) + a liquid-region mask; at icon-bake time (06 §8.2) generate one icon per *(item form, potionId)* pair actually seen `(lazy: bake on first use, cache by "form:potionId")` — liquid pixels filled with the §12.1 tint ±6% noise. Splash form adds a 1-px rounded cork band `#8A8A8A`; lingering adds 3 trailing mist pixels below the bottle. Tooltip shows potion display name + effect line + duration ("Potion of Swiftness — Speed (3:00)"); no enchantment glint (vanilla 1.19.4+ removed it from potions).

### 12.4 Explicit CUT LIST

| Cut | Reason |
|---|---|
| Leaping potion | rabbit's foot — no rabbits in any file |
| Water Breathing potion | pufferfish — no fishing (06 exclusion); effect stays engine-supported |
| Slow Falling potion | phantom membrane — no phantoms; effect stays (11/13 may use) |
| Turtle Master | turtle shell — no turtles; also the only multi-effect potion |
| Mundane / Thick / uncraftable potions | dead-end no-effect potions; invalid combos simply don't brew |
| Glistering melon slice | no melons; healing ingredient substituted with golden apple (§12.2) |
| Enchanted golden apple | uncraftable in 1.20, no loot-chest source in scope |
| Luck / Decay / Oozing / Weaving / Infestation / Wind Charging | JE-unbrewable or post-1.20 content |
| Nausea, Blindness, Glowing, Health Boost, Saturation effects | no source in scope; ids reserved (§1.3) |
| Milk bucket (effect clear) | 06 excludes milk; death is the only effect wipe |
| Cauldron bottle-filling | no cauldron block; water sources fill bottles |
| Huge mushrooms / mushroom stew / podzol-mycelium substrates | structure + item budget; mushrooms are brewing reagents first |

---

## 13. Splash potions (item 372)

### 13.1 Throw physics (Java-exact; reuses 05 §11's collide→move→drag integration order)

| Property | Value |
|---|---|
| Entity (`ThrownPotion`) AABB | 0.25 × 0.25 |
| Launch | from eye; direction = look with pitch **raised 20°** (−20° x-rot offset); speed **0.5 b/t**; inaccuracy gaussian ×0.0172275 per axis (inacc 1.0) |
| Gravity | −0.05 b/t² |
| Drag | ×0.99/t (in water ×0.6 `(approx, arrow parity)`) |
| Max range | ≈ 8 blocks at optimal angle |
| Use cooldown | none; consumes the item on throw; bottle is **lost** |
| Render | the potion item sprite as a camera-facing billboard, slight spin `(approx)` |

Impact = first block face hit (DDA per 01 §11) or first entity AABB (inflated 0.3) intersected after 2 ticks of flight `(approx owner-grace)`.

### 13.2 Impact resolution (Java-exact)

```js
onImpact(hitPos, directHitEntity):
  playSound("entity.splash_potion.break"); spawnSplashParticles(color(potionId), 30, hitPos)   // §6.4 swirls + glass shards
  box = AABB(hitPos).inflate(4.0, 2.0, 4.0)                 // 8.25 × 4.25 × 8.25 cuboid
  for (e of livingEntitiesIn(box)) {
    d2 = distSqClosestPointOfAABB(e.aabb, hitPos);          // closest point, NOT center — wiki-exact
    if (d2 >= 16) continue;                                  // 4-block euclidean gate
    w = (e === directHitEntity) ? 1.0 : 1.0 - sqrt(d2)/4;    // linear potency falloff
    P = potionRegistry[potionId];
    if (P.instant) applyInstant(e, P.effect, P.amp, w, thrower);
    else { dur = floor(w * P.ticks + 0.5);
           if (dur > 20) addEffect(e, P.effect, P.amp, dur); }   // ≤1 s → not applied, Java-exact
  }
```

Splash duration on a direct hit equals the drinkable duration (Java; Bedrock's flat 75% is **not** used — noted to preempt the common mix-up). The thrower is affected by their own splash if inside the AoE.

### 13.3 Splash water bottles

potionId `"water"`: applies no effects; instead — extinguish `fire` blocks at the hit cell and its 4 horizontal neighbors (15-FIRE consumes this event); set `fireTicks = 0` on entities in the AoE; deal 1 MAGIC damage to endermen in the AoE (05 §8.5's water-hurt + teleport reaction fires). The blaze (10) takes 1 too — 10's stat block hooks the same `hurtByWater` flag.

---

## 14. Lingering potions & the area-effect cloud

### 14.1 Item & throw

Item 373; throw physics identical to §13.1. On impact: splash sound + particles, **no immediate effect application**; spawn an `AreaEffectCloud` entity at the impact point. Lingering **water** bottles behave as §13.3 but leave **no cloud** (Java-exact).

### 14.2 AreaEffectCloud entity (owned here; 13's dragon breath attack spawns these with its own parameters)

| Field | Lingering-potion value (Java-exact) |
|---|---|
| radius | 3.0 |
| duration | 600 t (30 s) |
| waitTime | 10 t (no effect and center-only particles until age ≥ 10; wiki prose says "about a second") |
| radiusOnUse | −0.5 per entity application |
| radiusPerTick | −radius/duration = −0.005/t (3 → 0 over the full 30 s) |
| reapplicationDelay | 20 t per victim |
| remove when | radius < 0.5 or age > waitTime + duration |
| physics | none — anchored where it spawned; no gravity, no collision `(approx: vanilla clouds also don't move)` |

```js
tick():
  age++; radius += radiusPerTick;
  if (radius < 0.5 || age > waitTime + duration) { discard(); return; }
  spawnCloudParticles();                      // §14.3
  if (age < waitTime || age % 5 != 0) return; // scan every 5 ticks, Java-exact
  for (e of livingEntities with horizDistSq(e, center) <= radius²) {
    if (victims.get(e.id) > age) continue;
    victims.set(e.id, age + 20);              // reapplication cooldown
    P = potionRegistry[potionId];
    if (P.instant) applyInstant(e, P.effect, P.amp, 0.5, thrower);   // instants at HALF potency
    else addEffect(e, P.effect, P.amp, floor(P.ticks / 4));          // duration ÷ 4, Java-exact
    radius -= 0.5;                            // each application shaves ~5 s of cloud life
    if (radius < 0.5) { discard(); return; }
  }
```

A mob standing in a Healing II cloud re-triggers every 20 ticks (~5 applications ≈ 20 HP total — matches the wiki's worked example). Effects with `duration/4 == 0` never (instants handled separately).

**`spawnEffectCloud(params)` factory (exported; called by 13 for dragon clouds).** 13-BOSSES spawns its fireball/perch breath clouds through this factory rather than constructing the entity itself. It builds an AreaEffectCloud (the §14.2 entity, same `tick()` loop) mapping 13's argument names onto this file's fields; 13's values override the lingering-potion defaults per the stated precedence (13 §Amendments-09(b): "this file's cloud params win for dragon clouds"):

```js
spawnEffectCloud({ pos, radius, radiusPerTick, durationTicks, effect, reapplyDelay }) → AreaEffectCloud {
  center:             pos,
  radius:             radius,
  radiusPerTick:      radiusPerTick,   // 13 supplies its own (e.g. +4/600 growth for fireball clouds, 0 for perch)
  duration:           durationTicks,   // → §14.2 `duration`
  reapplicationDelay: reapplyDelay,    // → §14.2 `reapplicationDelay` (13 uses 20)
  effect:             effect,          // {id, amp} or a direct harming/magic payload — 13 passes its armor-ignoring breath damage
  waitTime:           0,               // dragon clouds arm immediately (no 10-t player-lingering delay)
  radiusOnUse:        0                // dragon clouds don't self-shrink per hit (the bottle-collect −0.5 shrink is 13 §6.5)
}
```

Player-thrown lingering potions construct the same entity directly with the §14.2 defaults (waitTime 10, radiusOnUse −0.5); the factory exists only so 13 can inject its own parameter set through one entry point.

### 14.3 Cloud rendering

Per tick spawn `ceil(π·radius²/3)` effect-swirl particles (§6.4 style, tinted `color(potionId)`) at uniform random points on the disc `y ± 0.2`, drifting up 0.02–0.04 b/t, lifetime 10–16 t, alpha 0.7. During waitTime: 2 particles/t at the center only. No mesh — the cloud is pure particles (vanilla look).

### 14.4 Creeper interaction

If a creeper explodes while it has active duration effects, spawn an AreaEffectCloud (radius 2.5, duration 600, its remaining effects at their current amplifiers/durations ÷ 4 on application) — vanilla Easter-egg parity `(approx params)`. Requires someone to have splashed a creeper first; zero cost, keep.

### 14.5 Dragon breath handoff

13-BOSSES spawns AreaEffectClouds directly (dragon fireball / perching breath) with its own radius/duration table and a `harming`-family payload, and registers the `dragon_breath` item (collected by clicking a glass bottle on the dragon's cloud — 13 §, referenced here only as the §12.2 lingering modifier).

---

## 15. Tipped arrows (item 378)

### 15.1 Crafting

`AAA/ALA/AAA` — A arrow (06 id 282) ×8 around L lingering_potion (373) → **8 tipped_arrow** carrying the lingering potion's `tags.potionId`. The bottle is consumed (not returned — vanilla-exact). This is the only source (no cauldron path in Java).

### 15.2 Entity pass-through (05 §11 amendment)

The `Arrow` entity gains `potionId: string|null`. Player shots copy it from the consumed ammo stack's `tags.potionId`; skeleton arrows keep `null` (no tipped-skeleton variants in scope). Render: arrow head tinted `color(potionId)` + 1 effect-swirl particle every 2 flight ticks. Stuck-arrow pickup returns `tipped_arrow` with the same tag (§Amendments).

### 15.3 Ammo selection rule (decision)

The bow consumes the **first arrow-class stack scanning hotbar 0→8 then main inventory** (plain arrow 282 or tipped 378, whichever comes first in scan order) — deterministic and lets the player choose by hotbar placement. State: no offhand exists (06), so no offhand priority rule.

### 15.4 On-hit effect (Java-exact)

```
on entity hit (after normal arrow damage from 05 §11):
  P = potionRegistry[arrow.potionId]
  if P.instant: applyInstant(target, P.effect, P.amp, 1.0, owner)     // full potency
  else:         addEffect(target, P.effect, P.amp, max(1, floor(P.ticks / 8)))   // 1/8 duration
```

Duration is 1/8 of the **drinkable** base (e.g., tipped arrow of Poison: 900/8 = 112 t ≈ 0:05). Applied even at minimum bow charge (any hit counts). Arrows stuck in blocks keep the tag for their 1200-tick lifetime.

---

## 16. Persistence (06 §18 / 01 §16 integration)

| Data | Fields |
|---|---|
| Living entities (player 03 §2.4 + mobs 05 §1) | `effects: [{id:u8, amplifier:u8, duration:u32, ambient:bool}]`, `absorption: f32` |
| Brewing stand block entity | `slots[5] × {id, count, tags?}`, `brewTime: u16`, `fuel: u8` |
| ThrownPotion entity | `{pos, vel, potionId, form: splash|lingering, owner?}` — in-flight potions persist `(or drop on save — either acceptable, state in DEVIATIONS if dropped)` |
| AreaEffectCloud | `{pos, potionId, radius: f32, age: u16, waitTime, duration, victims: omitted}` — victim cooldowns reset on load `(approx)` |
| Item stacks | `tags.potionId` rides 08's `tags` serialization |
| Arrows | existing arrow record + `potionId?` |

Effects tick only while their chunk is simulated (01 §13.2 tick gating) — durations effectively pause for frozen mobs; the player is always simulated. `(approx — vanilla time-skips don't advance effects either.)`

---

## 17. Sound events (registry for 16-AUDIO — names final, synthesis 16's)

| Event key (16 namespace) | Vanilla analogue | Trigger |
|---|---|---|
| `block.brewing.done` | block.brewing_stand.brew | §10.2 brew finishes (bubbling gurgle); one-shot sibling of 16's `block.brewing.loop` |
| `item.bottle.fill` | item.bottle.fill | §11.1 filling from water |
| `player.drink.gulp` | entity.generic.drink | every 4 ticks during a 32-t potion drink (16 §3.3 recipe) |
| `entity.splash_potion.throw` | entity.splash_potion.throw | §13.1 / §14.1 throw (also lingering) |
| `entity.splash_potion.break` | entity.splash_potion.break | §13.2 impact glass-shatter |
| `entity.lingering_potion.break` | entity.lingering_potion.break | §14.1 impact (deeper shatter) |
| `block.extinguish` | block.fire.extinguish | §13.3 splash-water dousing — the canonical douse key (16 §3.3), shared with 10/15 |
| `block.place.grass` / `block.break.grass` | block.grass.* | mushroom place/break: reuse 16's generic plant events (no new key) |

No audio is *played* by this file's code paths beyond emitting these event keys through 16's dispatcher.

## 18. Performance notes

- `tickEffects` is O(active effects) per entity; the Map is usually empty — guard with `if (effects.size === 0 && absorption === 0) return` before the loop.
- Effect multiplier lookups (speed/haste/strength) are ≤ 3 Map.get per tick per entity — no attribute-cache layer needed at this scale.
- Cloud particle budget: worst case (radius 3) ≈ 10 particles/tick/cloud; cap live clouds' particles at 400 total via the base Particles helper's pool.
- Icon baking is lazy-cached (§12.3); no per-frame canvas work.
- `uNightVision` is one uniform write per frame, same cost class as `uSkyDarken` (04 §15 budget unchanged).

---

## Acceptance checklist

Effect engine
- [ ] `addEffect` follows §2.2 exactly: higher amplifier replaces; equal amplifier keeps the longer duration; lower amplifier is a no-op (verify Speed II over Speed I over Speed II-short sequence).
- [ ] Speed I: walk 5.18 m/s ±1%, sprint 6.73 m/s ±1%; Slowness IV walk 1.73 m/s; air acceleration measurably unchanged by Speed.
- [ ] Jump Boost I apex 1.84 ±0.02 blocks and a 4-block drop deals 0 damage (3+1 reduction); Jump Boost II clears a 2-block ledge.
- [ ] Haste II stone + iron pick = 0.3 s; Mining Fatigue I/II/III multiply by exactly 0.3/0.09/0.0027.
- [ ] Strength II diamond sword full-charge crit = 19.5; Weakness I zombie deals 0.
- [ ] Regen I heals 1 HP per 50 ticks; Poison I damages 1 per 25 ticks and stops at exactly 1 HP; Wither I damages 1 per 40 ticks and kills; hearts recolor green/black respectively.
- [ ] Instant Health on a zombie deals 6 damage (12 at II); Instant Damage on a zombie heals it; regen/poison refuse to apply to undead; spiders refuse poison.
- [ ] Resistance stacks after armor per §4.2 (creeper worked example ≈ 17.7 with Res I + Abs I over full diamond); Fire Resistance makes standing in lava free (overlay still shows); Water Breathing freezes the bubble row.
- [ ] Absorption shows yellow hearts, absorbs before health, doesn't refill, disappears on expiry; golden apple grants exactly 4 for 2400 t + Regen II 100 t and is edible at full hunger.
- [ ] Levitation I rises at 0.9 m/s steady; Slow Falling floats down (gravity 0.01) with zero fall damage.
- [ ] Invisibility: unarmored player walks within ~2.4 blocks of a zombie (35 × 0.07) before aggro; each armor piece worsens it by 17.5 %; sneak stacks ×0.8; floor of 2 blocks holds.
- [ ] Night vision: midnight terrain renders at full sky brightness with the blue night tint, caves render bright, flash-blinks below 10 s (10-tick sine), zero remeshes triggered.
- [ ] HUD: icons top-right with mm:ss, blink < 10 s, ambient (debug-granted) shows the blue frame; inventory screen lists effects; effect swirls tinted correctly and skipped for own first-person body.

Brewing & items
- [ ] Blocks 110–112 and items 370–378 registered exactly per §1; nothing outside blocks 110–114 / items 370–389 is allocated by this file.
- [ ] Mushrooms: generate only in carved cave air, refuse placement at internalLight ≥ 13, pop on update in bright light, spread ~1/25 random tick respecting the 5-in-9×9×3 cap; brown emits light 1.
- [ ] Brewing stand: blaze rod + 3 cobblestone recipe; drops only to a pickaxe; light 1; RMB opens the 5-slot UI; comparator-readable (07).
- [ ] Water bottle from any water cell (source not consumed); 3 glass → 3 bottles; drinking returns the empty bottle and works at full hunger; 32-tick drink with gulps.
- [ ] Brew cycle: exactly 400 ticks; 1 blaze powder = exactly 20 operations; one ingredient transforms all matching bottles (3 water + 1 nether wart → 3 awkward); pulling the ingredient resets progress to zero.
- [ ] Full graph: water→awkward→{speed, strength, regen, fire res, poison, night vision, healing(golden apple)}; redstone/glowstone produce the §12.1 long/strong forms and refuse already-modified inputs; water + glowstone/redstone does nothing (mundane/thick absent).
- [ ] Corruptions: water→weakness; speed→slowness (long→long, strong→nothing); night vision→invisibility; healing→harming; poison→harming (strong→strong, long→plain harming).
- [ ] Fermented spider eye = spider eye + sugar + brown mushroom (shapeless, 2×2-able); spiders drop an eye on ~1/3 of player kills; eating a spider eye gives 2 hunger + Poison I 0:05.
- [ ] Golden carrot = carrot + 8 gold nuggets (6 hunger / 14.4 sat); golden apple = apple + 8 gold ingots; enchanted apple confirmed absent.
- [ ] Splash: 0.5 b/t at −20° pitch, gravity 0.05, drag 0.99; AoE 8.25×4.25×8.25 + 4-block euclidean; direct hit = 100%, duration falloff to 0 at 4 blocks with the ≤ 20-tick discard; splash water extinguishes fire (hit cell + 4 neighbors) and burning entities, hurts endermen 1.
- [ ] Lingering: cloud radius 3→0 over 30 s, active after 10 ticks, scans every 5, per-victim 20-tick cooldown, −0.5 radius per application, duration effects ÷ 4, instants × 0.5; Healing II cloud stood in heals ≈ 20 HP while eating the cloud; lingering water leaves no cloud.
- [ ] Tipped arrows: 8 arrows + lingering potion → 8 tipped (bottle consumed); tinted head + trail; on hit applies base duration ÷ 8 (Poison ≈ 0:05) or full instant; stuck player arrows return the tipped item; skeleton arrows never tipped.
- [ ] Persistence: active effects (player + mobs), absorption, brewing stand slots/fuel/progress, cloud entities, and `tags.potionId` on every form all survive save/reload; rotten-flesh poisoning round-trips as a Hunger effect entry.
- [ ] Sound events of §17 are emitted at their triggers (verify via 16's debug event log); no other audio calls exist in 09 code paths.
