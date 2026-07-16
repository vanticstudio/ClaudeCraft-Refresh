# CLAUDE.md — VoxelCraft Master Plan

You are building **VoxelCraft**: a faithful, single-player recreation of Minecraft's full survival loop, from scratch, in the browser. This file is the entry point. The six numbered spec files beside it contain everything you need — mechanics, exact values, formulas, algorithms, and data tables. Read them fully before writing code; you have the context window for it.

**The goal:** a playable game where a player spawns in an infinite procedurally generated world, punches trees, crafts tools, mines ores, smelts iron, builds a shelter, survives the night against zombies/skeletons/creepers/spiders/endermen, manages hunger and health, farms and breeds animals, sleeps in a bed, and can quit and reload the same world. Runs at 60 fps in Chrome on a mid-range machine.

---

## 1. Non-negotiable ground rules

- **Stack:** Vite + `three` (r185, pinned per 01) + vanilla JS ES modules. No frameworks, no physics libraries, no game engines. UI is DOM/CSS overlay.
- **Units & time:** 1 block = 1.0 world unit = 1 m. Game logic runs at a fixed **20 ticks/second** (1 tick = 50 ms) with an accumulator; rendering at display FPS with interpolation (01 §3).
- **World:** Y range **0–127**, sea level **Y=63**, bedrock at Y=0. Chunks are 16×16 full-height columns (16×128×16). Real Minecraft Y values in the specs are already remapped to this range.
- **Fidelity:** Baseline is Minecraft Java Edition ~1.20 mechanics on **Normal difficulty (hard-coded)**. Where a spec gives an exact value or formula, use it exactly — do not "improve" gameplay numbers. Deliberate simplifications are marked `> Adaptation:` or `(approx)` in the specs; follow those as written.
- **Assets:** Every texture is generated procedurally at runtime (16×16 canvas tiles → one atlas). Texture recipes live in 06 §4/§8, atlas pipeline in 01 §7. **Never** download, embed, or imitate copyrighted Minecraft asset files. No audio.
- **Single player, no networking.** Persistence is IndexedDB (01 §16).

## 2. Spec file map & ownership

Each file **owns** its domain. When two files touch the same topic, the owner below wins; the other file is cross-referencing.

| File | Owns |
|---|---|
| **01-ARCHITECTURE.md** | Project structure, module map, game loop, chunk data model & streaming, meshing + AO, texture atlas, workers, voxel raycast (DDA), AABB physics primitives, entity base system, lighting **data structures & scheduling**, sky-dome rendering plumbing, input/UI shell, IndexedDB save schema, perf budgets |
| **02-WORLD-GENERATION.md** | Seeds/determinism, noise stack, height composition, biomes, caves/carvers, ore distribution, decoration (trees/plants), worldgen animal herds, world spawn, gen-worker payload |
| **03-PLAYER.md** | Player constants, movement physics (walk/sprint/sneak/jump/gravity), collision behavior, ladders, water/lava movement, drowning/fire/fall damage, block targeting/breaking formula/placing, camera & viewmodel, health & death/respawn, F4 debug flight, input map |
| **04-TIME-LIGHT-WEATHER.md** | worldTime & phase table, celestial angle, sky colors/sun/moon/stars, fog, sky+block light **algorithms** (BFS propagate & two-queue removal), rendered brightness curve, gameplay light predicates (spawn/burn/crops), weather state machine, clouds, bed time-skip |
| **05-MOBS-COMBAT.md** | All 9 mob stat blocks, spawn/despawn cycles, daylight burning, goal-based AI, A* pathfinding, per-mob behaviors, breeding, arrows, explosions, player combat math (cooldown/crits/knockback/armor formula), damage pipeline & i-frames, XP orbs, mob box-models & animation |
| **06-ITEMS-CRAFTING-SURVIVAL.md** | **Canonical block & item registries** (ids, hardness, tools, drops, light, textures), special block behaviors (chest/furnace/TNT/bed/farmland/…), fluids, full crafting recipe list, smelting & fuel, hunger/saturation/exhaustion, XP levels, inventory click semantics, HUD/UI, item entities, persistence contract |

**Precedence on conflict:** 06's registry data > the domain owner above > 01 > this file's prose. If you hit a genuine contradiction, resolve it in favor of the owner, note it in a `DEVIATIONS.md`, and move on — do not stall.

## 3. Build phases

Follow 01 §18's order. Each phase has an acceptance gate — **do not start the next phase until the gate passes in the browser.** Test by running `npm run dev` and playing.

| Phase | Build | Gate (must observe in browser) |
|---|---|---|
| 1 | Vite scaffold, renderer, temp fly-cam, one hardcoded stone chunk | Chunk renders, 60 fps, resize works |
| 2 | Atlas builder + starter tile painters + UV table | Atlas visible in debug; textures crisp (Nearest, no bleeding) |
| 3 | Chunk data model + culled-face mesher with AO + render buckets | Single chunk with mixed blocks; correct faces, AO visible in corners |
| 4 | Terrain worker + ChunkManager streaming + remesh queue | Fly across an endless flat-noise world; no seams, no hitches |
| 5 | Full worldgen per 02 | Biomes, caves, ores at correct depths, trees; same seed ⇒ same world |
| 6 | Player physics + collision + pointer lock per 03 | Walk 4.32 m/s, sprint 5.61, jump 1.25 blocks; no clipping, no falling through chunk borders |
| 7 | Raycast + break/place + crack overlay + instant remesh | Mine and build; correct breaking times per tool tier; can't place inside self |
| 8 | Lighting engine per 04 | Caves are dark; torch placement/removal floods/unfloods correctly across chunk borders |
| 9 | Day/night cycle per 04 | Full 20-min cycle: sunrise colors, stars, moon phases, fog lerp, smooth brightness |
| 10 | Inventory + crafting + furnace + containers + HUD per 06 | Log→planks→table→pickaxe loop works; furnace smelts with fuel; chest persists contents |
| 11 | Entity system + item drops | Broken blocks drop, merge, get picked up, land in inventory |
| 12 | Mobs, AI, combat, spawning, arrows, fluids, falling blocks | Night spawns hostiles; zombies path to you; creeper explodes terrain; skeleton arrows hurt; water flows |
| 13 | Hunger, regen, death/respawn screens | Sprint drains hunger; eating restores; starvation floors at 1 HP; death drops inventory |
| 14 | Save/load per 01 §16 | Reload page → same world, edits, position, inventory, time of day |
| 15 | Perf & polish pass | 60 fps at render distance 8 while mobs active; all six acceptance checklists pass |

Each spec file ends with an **Acceptance checklist** — treat those as the test plan for phases touching that file.

## 4. Working practices

- **Read all seven files first.** Then code. The specs are dense on purpose; nearly every "how should X work?" question is already answered with a number.
- Keep the module layout from 01 §2. Small files, one responsibility each.
- Commit (or at minimum, checkpoint) at every passing phase gate.
- When debugging visuals, use the F3 debug overlay (position, fps, chunk counts, light values under crosshair) — build it early, in phase 4.
- Performance is a feature: respect the perf budgets (01 §17: remesh ≤ 4 chunks/frame; 04 §15: light updates ≤ 10k nodes/tick; 02 §14: gen ≤ 12 ms/chunk in worker).
- Deterministic worldgen is sacred: any RNG in generation must derive from the seed streams in 02 §2. `Math.random()` is allowed only for cosmetic effects and mob decision jitter.
- If a mechanic seems ambiguous, check the owner file's section before inventing; if still ambiguous, pick the simplest behavior consistent with the acceptance checklist and log it in `DEVIATIONS.md`.

## 5. Explicitly out of scope (do not build)

Redstone circuitry, enchanting, brewing/potions, the Nether/End, villages & villagers, boss mobs, multiplayer, offhand slot, sweep attacks, looting/fortune/silk touch, waterlogging, fire spread, audio. Some are listed as stretch goals below — none block "done."

## 6. Stretch goals (only after phase 15 passes)

Sprint order if time remains: (1) more biomes/structures, (2) enchanting table + 3 basic enchants, (3) simple redstone (wire/torch/door/pressure plate), (4) ambient audio via WebAudio synthesis, (5) third-person camera.

---

**Definition of done:** a fresh player can survive three full day/night cycles — mine, craft, build, fight, eat, sleep, die at least once, respawn — then reload the browser and continue the same world. That's Minecraft.
