# CLAUDE.md — ClaudeCraft Master Plan v2: The Expansion Build

You are **Claude Opus 4.8 running in Ultra Code (Claude Code)** with a 1M-token context window. Use it: read this file, then every spec file in this folder, then the existing codebase, before writing a line.

**Where this project stands:** ClaudeCraft v1 (the retired working codename was *VoxelCraft*) — the complete Minecraft survival loop in the browser (Vite + `three` r185 + vanilla JS, 20 TPS, procedural textures, IndexedDB saves) — is **already built and shipped**. All 15 v1 phases passed: infinite terrain, biomes, caves/ores, mining/crafting/smelting, lighting engine, day/night, 9 mobs with AI and combat, hunger, fluids, save/load. Name is changed to now ClaudeCraft.

**Your job now:** build the expansions — redstone, enchanting, potions, the Nether, the End, villages, bosses, multiplayer, fire spread, waterlogging, audio, and a full creative mode — on top of that living codebase.

---

## 1. How to treat the files in this folder

- **Base specs `01`–`06` (and v1 phase history): DO NOT BUILD FROM THEM.** They are documentation of what already exists. Read them to understand the architecture you're integrating into — the chunk arrays, registries, tick order, save schema, AI framework — and to locate integration points. Nothing in them is a to-do.
- **The codebase is ground truth for what exists.** If code and a base spec disagree on something already built, the code wins — note it in `DEVIATIONS.md` and move on. (Optionally spot-check key systems against 01/06 on first read; don't audit exhaustively.)
- **Expansion specs `07`–`16`: these are the build.** Each is a complete, self-contained spec with exact Minecraft Java 1.20 values, adaptations marked, and an acceptance checklist.
- **Never edit base spec files.** Each expansion file opens with an **`## Amendments to base files`** section — those are precise change instructions to apply **to the codebase** (and they override the corresponding base-spec text). Apply them as you build that expansion, not all upfront.

## 2. Expansion file map & ownership

| File | Owns | Status |
|---|---|---|
| **07-REDSTONE.md** | Power model, dust, torches, repeaters, comparators, pistons, observers, dispensers/droppers, hoppers (supersedes 06's "hopper: no"), lamps, note blocks, redstone tick scheduling | Ready |
| **08-ENCHANTING.md** | Enchanting table + full enchant catalog (incl. **looting/fortune/silk touch**), anvil, grindstone, enchanted books, **sweep attack** (supersedes 05's skip), **offhand slot**, the item-stack `tags` extension (all files reference 08's definition) | Ready |
| **09-POTIONS.md** | **Status-effect engine** (consumed by 08/10/11/13), brewing stand + full recipe graph with stated cuts, splash/lingering, tipped arrows, golden apple, mushrooms | Ready |
| **10-NETHER.md** | **Multi-dimension engine** (dim registry, per-dim gen/sky/save — 11 builds on it), portals, nether gen + biomes, fortress, spawner block, ghast/blaze/zombified piglin/magma cube/wither skeleton/piglin, brewing ingredients, gold nugget, **netherite tier**, smithing table | Ready |
| **11-END.md** | Eye of ender, stronghold + portal room, End terrain + pillars (crystal *positions*), outer islands, chorus, end cities, shulkers + shulker box, **elytra** (exact glide physics), gateways | Ready |
| **12-VILLAGES.md** | Village worldgen (deterministic multi-chunk), building templates, villagers + professions/schedules, full trade tables, breeding, iron golem, zombie villagers + curing, bell/composter/barrel/blast furnace/smoker, emerald ore | Ready |
| **13-BOSSES.md** | Boss bar system, end crystal entity + dragon fight state machine + egg + respawn ritual, wither (summon/phases/skulls), nether star, **beacon** (pyramid/effects/beam) | Ready |
| **14-MULTIPLAYER.md** | Host-authoritative browser host + Node WebSocket relay (`server/relay.js`), join codes, chunk streaming, message catalog, client prediction/reconciliation, interest management, per-player saves, 2–8 players | Ready |
| **15-FIRE-WATERLOGGING.md** | Full fire spread (flammability tables, safety valve) replacing 06's minimal fire; **waterlogging** via the globally reserved `states` **bit7** | Ready |
| **16-AUDIO.md** | WebAudio synthesis engine (supersedes the v1 "no audio" rule), synth primitive library, master sound-event registry, positional audio, generative original music. **100% synthesized — no samples, no copyrighted/C418 material, ever** | Ready |
| **18-CREATIVE.md** | Creative game mode: mode state + toggle, flight, damage/hunger immunity, instant-break with no drops, infinite placement, middle-click pick-block, tabbed + searchable creative inventory. **No new block/item ids** — pure mode + UI + player behavior, wired via AMENDS. Despite the file number, build it before 17-SHIP. | Ready |
| **17-SHIP.md** | Final correction sweep, relay-server cleanup, repo hygiene, GitHub push, Vercel deploy. **Run once, only after every other phase passes** | Ready |

**Precedence on conflict:** expansion `AMENDS` instructions > 06's registry data > base domain owner (02 worldgen, 03 player, 04 time/light, 05 mobs/combat) > 01 > prose. Genuine contradiction → resolve per this order, log in `DEVIATIONS.md`, don't stall.

## 3. Registry governance (hard limits)

Base occupies block ids 0–66 and item ids 256–345. Expansion allocations — never exceed your file's range, never touch another's:

| File | Block ids | Item ids | Also owns |
|---|---|---|---|
| 07 | 70–104 | 460–469 | — |
| 08 | 105–109 | 346–369 | item `tags` object schema |
| 09 | 110–114 | 370–389 | effect ids |
| 10 | 115–149 | 390–419 | dimension ids, netherite tier rows |
| 11 | 150–169 | 420–434 | — |
| 12 | 170–184 | 435–449 | — |
| 13 | 185–189 | 450–459 | boss-bar API |
| 15 | — (states bit7) | — | waterlogged flag, fire behavior |
| 16 | — | — | sound-event namespace |
| 18 | — | — | game-mode field + creative inventory palette (references existing ids; allocates none) |

State bytes are interpreted per-block-type; **bit7 is globally reserved for waterlogged** (15).

## 4. Expansion build phases

Same discipline as v1: **acceptance gate must pass in the browser before the next phase starts.** Gates below are summaries — the owning file's acceptance checklist is the real test plan.

| Phase | Build | Spec | Gate |
|---|---|---|---|
| E1 | Audio engine + full base-game sound pass | 16 | Mining/footsteps/mobs/UI audible, positional, distance-muffled explosions; zero downloaded assets |
| E2 | Fire spread + waterlogging | 15 | Wool floor burns out, rain extinguishes, netherrack-ready flags in place; submerged fence shows water, breaking it leaves a source |
| E3 | Sweep attack + offhand slot | 08 | Sweep hits crowds with particle + sound; F swaps hands; offhand torch/food works |
| E4 | Enchanting: table, anvil, grindstone, full catalog | 08 | Level-30 enchant on bookshelf ring; fortune multiplies diamonds; silk touch lifts glass; looting boosts drops; mending repairs from orbs |
| E5 | Redstone | 07 | Repeater clock blinks a lamp; 2×2 sticky-piston door opens; hopper chain fills a chest; comparator reads furnace |
| E6 | Villages & trading | 12 | Village generates across chunk borders deterministically; librarian sells enchanted books; golem defends; zombie villager cured |
| E7 | Nether: dimension engine, portals, gen, mobs, fortress | 10 | Portal round-trip at 8:1 coords; fortress has blaze spawner; ghast fireball deflectable; beds explode |
| E8 | Netherite tier | 10 | Debris → scrap → ingot → smithing upgrade keeps enchants |
| E9 | Status effects + brewing | 09 | Effect HUD; speed/strength/regen/poison verified against timers; splash + lingering clouds work |
| E10 | End: stronghold, End gen, cities, shulkers, elytra | 11 | Eyes lead to stronghold; 12-eye portal activates; shulker levitates you; elytra glide matches spec physics |
| E11 | Bosses + beacon | 13 | Dragon full fight loop (crystals/perch/breath) → egg + gateway; wither summon → nether star; 4-tier beacon buffs |
| E12 | Multiplayer | 14 | Two browsers via relay: mine/build/fight/sleep together; client rejoin restores state; playable at 200 ms simulated ping |
| EC | Creative mode | 18 | Toggle to creative → double-jump fly (ascend/descend); zero fall/lava/mob damage; instant-break with no drops; place blocks without depleting the stack; creative inventory search + grab; middle-click pick-block; toggle back restores survival physics + finite stacks |
| E13 | Final pass & ship | 17 | Clean clone builds; all checklists pass; pushed to GitHub; live and playable on Vercel |

Dependency notes: E9 needs E7's ingredients (nether wart, blaze powder, etc.); E10's eyes of ender need E7's blaze powder; E11 needs E10's arena + E7's wither skulls; E6's librarian/cleric trades reference 08/09 items (12 specs which trades unlock as dependencies land). E1–E5 are independent of each other. **EC (Creative mode)** is independent of every other expansion — it depends only on the built v1 player/inventory/render systems, so it can slot in any time after E1, but it must land **before** E13/17-SHIP so the ship checklist covers it. **E9 caveat:** its gate clause "lingering clouds work" ultimately depends on `dragon_breath` (13, item 452) — an E11 drop — so survival-obtained lingering potions and tipped arrows only close at E11; 09's own E9 acceptance checklist exercises lingering clouds via the debug palette until then.

**If a listed spec file is absent or truncated in this folder, skip its phases, continue with the next independent phase, and do not improvise the missing content** — the file will be supplied.

## 5. Known gaps (read before starting)

- **10-NETHER.md is delivered and complete.** Its id ranges (blocks 115–149, items 390–419, dim ids, netherite tier) are populated. E7/E8 are unblocked; the downstream dependencies it feeds — E9's brewing ingredients, E10's blaze powder (eyes of ender), E11's wither skulls and dimension engine — are all satisfied.
- **12-VILLAGES.md is delivered and complete.** E6 is unblocked (deterministic village worldgen, full trade tables, iron golem, curing).
- **A Round-2 cross-file audit HAS now been run over 07–16** (see `AUDIT-ROUND2.md`); its 4 critical + 18 minor findings are applied across the expansion files. If you hit any *further* inter-file contradiction, apply §2 precedence and log it in `DEVIATIONS.md`.
- **18-CREATIVE.md is delivered and complete** (phase EC). It allocates no ids; it AMENDS 01/03/05/06/16 to add the game mode, flight, immunities, instant-break/no-drops, infinite placement, pick-block, and the creative inventory. Include it in the E13 ship checklist.
- **Standalone code fix-prompts (not spec phases):** `UPDATE-crafting-inventory-fix.md` and `UPDATE-sky-sun-visual-fix.md` are paste-ready work orders that fix drift between the **shipped v1 code** and the frozen base specs (survival crafting-grid layout + recipe resolver conforming to 06; sun/moon/cloud billboard rendering + a stray placeholder mesh, conforming to 04). They are codebase fixes — base specs stay frozen; log divergences in `DEVIATIONS.md`. Apply them opportunistically (they don't gate the E-phases).

## 6. Working practices

- Read all specs + skim the codebase modules before coding. Keep 01 §2's module layout; new systems get new modules (16 lists its `audio/` files, 14 its `net/` + `server/relay.js`).
- Commit at every passing gate. Keep the F3 overlay current (add dim, effect list, redstone power under crosshair, audio voice count).
- v1 perf budgets still bind (60 fps, remesh ≤ 4 chunks/frame, light ≤ 10k nodes/tick); redstone ≤ 1 ms/tick typical (07), snapshot encode ≤ 1 ms (14), audio ≤ 1.5 ms/frame (16).
- Determinism rules extend to the new dimensions and structures: all worldgen RNG from seed streams (02 §2 pattern).
- Assets stay 100% procedural — textures (base rule) and audio SFX + generative music (16's rule): nothing downloaded, nothing imitating copyrighted Minecraft/C418 assets. **One scoped exception:** 16-AUDIO §4A's optional file-based *theme-music* layer (title screen + soft in-game background) may play **original or cleared/licensed** tracks; copyrighted/C418 audio is never bundled or served in a public build (the current `CC-assets/CC-sounds` files are dev placeholders only — 17-SHIP §3 enforces the gate).
- **Naming (permanent):** the product is **ClaudeCraft**. All user-facing strings — window/tab title, title screen, README, repo name, deploy URL — read ClaudeCraft. *VoxelCraft* is the retired working codename and may persist only in internal module/spec identifiers; it must never appear in user-facing UI or the shipped repo/brand.

## 7. Out of scope v2 (do not build)

Rails & minecarts, raids/pillagers/patrols, fishing, ocean monuments & guardians, shields/crossbows/fireworks (elytra is glide-only), horses/wolves/cats & taming, maps & cartography/looms/banners, cauldrons, curses, trial chambers, host migration, anti-cheat, mod/datapack support.

## 8. Model Routing & Orchestration

Self-managed policy: route each phase to the right model at its boundary, without a human in the loop. **Convention for this build: Claude Fable 5 is the strongest / most careful model; Claude Opus 4.8 is the cheaper / faster model.** The map below uses that convention.

**Routing principle — route by blast radius, not raw difficulty.** A phase that *defines a contract other phases consume*, or *mutates global/shared state*, runs on Fable 5 even if it's mechanically simple — a subtle bug in a shared primitive silently corrupts every consumer. Isolated leaf phases (nothing depends on them) may run on Opus 4.8.

### 8.1 Phase → model map

| Phase | File | Model | Class | Why |
|---|---|---|---|---|
| E5 | 07-REDSTONE | **Fable 5** | LOCKED | Hard tick-scheduled engine; its components (hoppers/pistons/observers) are consumed by downstream systems |
| E3 + E4 | 08-ENCHANTING | **Fable 5** | LOCKED | Item-stack `tags` extension referenced by every file |
| E9 | 09-POTIONS | **Fable 5** | LOCKED | Status-effect engine consumed by 08/10/11/13 |
| E7 + E8 | 10-NETHER | **Fable 5** | LOCKED | Multi-dimension engine; 11 builds on it |
| E2 | 15-FIRE-WATERLOGGING | **Fable 5** | LOCKED | Waterlogging via the globally reserved `states` bit7 |
| E12 | 14-MULTIPLAYER | **Fable 5** | LOCKED | Host-authoritative sync touches all game state |
| E13 | 17-SHIP | **Fable 5** | LOCKED | Final correction sweep; needs whole-system context; runs last |
| E10 | 11-END | **Fable 5** | DEFAULT | Hard but self-contained; Opus-eligible only on explicit "parallelise" instruction |
| E6 | 12-VILLAGES | **Fable 5** | DEFAULT | Hard but self-contained; Opus-eligible only on explicit "parallelise" instruction |
| E11 | 13-BOSSES | **Fable 5** | DEFAULT | Hard but self-contained; Opus-eligible only on explicit "parallelise" instruction |
| EC | 18-CREATIVE | **Fable 5** | DEFAULT | Assigned here (post-dates the original map). Touches the `gameMode` save field + break/drop path (shared state) → default Fable; but near-leaf (nothing consumes it), so Opus-eligible on explicit "parallelise" instruction |
| E1 | 16-AUDIO | **Opus 4.8** | LEAF | True leaf; supersedes the prior no-audio rule; nothing consumes it |

**LOCKED = never downgrade to Opus, regardless of throughput.** DEFAULT = Fable 5 unless Jake explicitly says to parallelise that phase onto Opus.

### 8.2 Build-order gate — freeze foundational contracts first

Lock and freeze these interfaces **before any dependent phase starts**; no dependent phase runs against an unfrozen contract:

- **08's `tags` object schema** (enchants / potionId / containerItems) — consumed by 09/10/11/12/13.
- **09's status-effect API** (effect ids + application/tick surface) — consumed by 08/10/11/13.
- **10's dimension registry** + portal/teleport API + per-dim gen/sky/save keys — 11 builds on it.
- **15's global `states` bit7** (waterlogged) allocation — globally reserved; every block-state consumer must honor it.

Practically: build these LOCKED contract phases early, run the §8.3 review pass on each until its interface is stable, then let consumers build against the frozen surface. E9(09) also depends on E7(10) ingredients, and E10/E11(11/13) depend on E7(10) — so 10's registry must freeze before them.

### 8.3 Self-management rules

1. **Before starting a phase**, check its assignment in §8.1 and set/switch to the correct model at the phase boundary.
2. **Escalate** an Opus-assigned phase to Fable 5 mid-build if it turns out to define something other phases consume, touch global-state encoding, or modify a frozen contract.
3. **Never downgrade a LOCKED phase to Opus.**
4. **After each phase, run a review pass**; mark it done only once its interface is stable enough for downstream phases to build against.

### 8.4 Mechanism (wired for this environment)

**Primary: model-pinned subagents via the Task tool.** The Task/Agent tool exposes a `model` parameter (`fable` | `opus` | `sonnet` | `haiku`) — verified available in this environment. Dispatch each phase to a subagent pinned to its assigned model; the orchestrator itself stays model-agnostic and each phase's work runs under the right model. Caveat: a `fork` subagent inherits the parent's model and cannot be pinned — use a general-purpose (or dedicated build) subagent, not a fork, whenever the phase's model differs from the orchestrator's.

**Fallback (interactive, human-driven Ultra Code session only):** `/model` switch at each phase boundary before the phase begins.

At runtime, confirm the environment actually supports the `model` parameter (or `/model`). If neither is available, **halt and report** rather than silently building every phase on a single model.

---

**Definition of done v2:** starting from a fresh world, a player can progress the entire arc — survive, enchant diamond gear, light a portal, raid a fortress, brew potions, upgrade to netherite, find the stronghold, kill the dragon, summon the wither, light a 4-tier beacon — with sound the whole way, fire that spreads and water that logs; then a mate joins over the relay and plays the same world beside them. That's Minecraft. All of it.
