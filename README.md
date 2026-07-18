# VoxelCraft

A faithful single-player recreation of Minecraft's full survival loop, built **from
scratch in the browser** — vanilla JavaScript + [three.js](https://threejs.org),
no game engine, no physics library, no asset files. Every texture is generated
procedurally at runtime.

![VoxelCraft gameplay](docs/screenshot.png)

## Play

- **Web**: deployed on Vercel from this repo (auto-deploys from `main`)
- **Local**:

```bash
npm install
npm run dev        # → http://localhost:5173
```

Click **New World**, then click the screen to grab the mouse. Your world
autosaves to the browser's IndexedDB every 30 seconds — close the tab and
**Continue World** picks up where you left off.

## Controls

| Input | Action |
|---|---|
| Mouse | Look |
| W A S D | Move · double-tap **W** to sprint |
| Space / Shift | Jump / sneak (sneaking won't fall off edges) |
| Left-click (hold) | Mine / attack |
| Right-click | Place block · use item · open chests, crafting, doors, beds |
| 1–9 / wheel | Hotbar |
| E | Inventory (2×2 crafting grid) |
| Q / Shift+Q | Drop item / stack |
| Esc | Pause (autosaves) |
| F3 | Debug overlay |
| F4 | Debug creative: flight (double-tap Space), instant break, item palette |

## Features

- **Infinite deterministic worlds** — 11 biomes, caves & ravines, rivers and
  oceans, ore veins at authentic depths, trees, villagesless wilderness. Same
  seed ⇒ same world, generated in a web worker at ~3 ms/chunk.
- **Java-accurate mechanics** — movement speeds (4.317 walk / 5.612 sprint m/s),
  mining times per tool tier, the 1.9 attack-cooldown combat system, armor
  math, hunger/saturation/exhaustion, XP levels, fall damage, drowning.
- **Full lighting engine** — per-voxel sky + block light BFS with smooth
  per-vertex lighting and ambient occlusion; torches flood caves, day/night
  never remeshes a chunk.
- **9 mobs** — zombies, skeletons (strafing archers), creepers, spiders
  (wall-climbing, light-gated), endermen (stare provocation, teleports), plus
  breedable cows/pigs/sheep/chickens — goal-based AI with A* pathfinding.
- **Survival loop** — punch trees → craft tools → mine ores → smelt iron →
  build a shelter → farm wheat → fight the night → sleep in a bed → respawn.
- **Blocks with behavior** — flowing water & lava (obsidian/cobblestone
  interactions), falling sand, TNT chain explosions, farmland & crops, doors,
  furnaces, chests, saplings that grow real trees, grass spread, leaf decay,
  snow and ice in cold biomes, weather with lightning.
- **20 TPS fixed-timestep** simulation with interpolated rendering; 60+ fps at
  render distance 8.

## How it's built

| Layer | Approach |
|---|---|
| Rendering | three.js `WebGLRenderer`, 3 shared shader materials for all chunks, culled-face meshing with per-vertex AO/light |
| Textures | One 512×512 atlas, all 197 tiles painted onto a canvas at startup (zero image requests) |
| Worldgen | Seeded simplex-noise stack in a worker; chunks are pure functions of `(seed, cx, cz)` |
| Physics | Axis-separated AABB vs voxel grid, swept collision |
| Persistence | IndexedDB — only modified chunks are saved; the seed regenerates the rest |
| Specs | The entire game was implemented from six frozen spec documents (preserved in git history); deviations are logged in [DEVIATIONS.md](DEVIATIONS.md) |

## Additions log

*This section is updated as new features land.*

- **2026-07-18** — **Villages, trading & iron golems (expansion phase E6, `12`)**:
  the world now grows **villages** — clusters of houses, farms, paths, a central
  well and a **meeting-point bell** — that generate **identically no matter which
  chunk loads first** (the whole layout is a pure function of the village's seed).
  **Villagers** wander, claim a job from an adjacent workstation, and **trade**:
  right-click one to open its offer list and buy with **emeralds** (a new gem that
  mines from **emerald ore** high in the **mountains**, or crafts to/from an emerald
  block). A **librarian** at a **lectern** sells **enchanted books** — real ones,
  rolled through the same enchanting system as the table, priced by enchant level
  (treasure enchants cost double). Other pros come from the **composter** (farmer),
  **brewing stand** (cleric), **blast furnace** (armorer), **smoker** (butcher),
  **fletching table** (fletcher), **smithing table** and **grindstone** (tool/weapon
  smiths). Every village with **five or more villagers** raises an **iron golem**
  that patrols and **hammers hostile mobs** (7–21 damage and a launch into the air),
  shrugging off knockback and fall damage; kill one and the village forges another
  after a cooldown. **Zombie villagers** now spawn among the undead — splash one with
  a **Weakness** potion, feed it a **golden apple**, and after a few minutes it
  **converts back into a villager**, keeping its profession and giving you a standing
  discount for the rescue. New blocks come with it: **dirt paths** (make them with a
  shovel), **barrels** (portable chests), **hay bales** (break your fall), plus
  bells, composters, lecterns, blast furnaces, smokers and fletching tables.
- **2026-07-18** — **Potions & status effects (expansion phase E9, `09`)**: the
  full brewing and status-effect layer is in. Craft a **brewing stand** (blaze rod
  + cobblestone), fill glass **bottles** at any water, and brew: water + **nether
  wart** → awkward, then an ingredient picks the effect — **sugar → Speed, blaze
  powder → Strength, ghast tear → Regeneration, magma cream → Fire Resistance,
  spider eye → Poison, golden carrot → Night Vision, golden apple → Healing**.
  **Redstone** lengthens a potion, **glowstone** strengthens it, a **fermented
  spider eye** corrupts it (Speed → Slowness, Healing → Harming, Night Vision →
  Invisibility), and **gunpowder** makes it a **splash** potion. Drink one and the
  effect shows in a **top-right HUD stack with a live timer**; **21 effects** are
  modelled to Java-exact numbers — Speed/Slowness change walk speed and FOV, Jump
  Boost clears higher ledges and softens falls, Haste/Mining Fatigue rescale mining,
  Strength/Weakness swing the damage math, **Regeneration** heals over time (green
  hearts for Poison, black for Wither, which *can* kill), **Resistance** and
  **Absorption** (yellow hearts) soak damage, **Fire Resistance** makes lava free,
  **Night Vision** lights the dark, and **Invisibility** shrinks how far mobs see
  you. **Splash potions** hit everything in an area with a distance falloff;
  **lingering potions** leave a shrinking cloud that re-doses whoever stands in it;
  **tipped arrows** carry a potion's effect onto whatever they hit. Golden apples
  grant Absorption + Regen, spider eyes poison you, rotten flesh now gives real
  Hunger, brown & red **mushrooms** grow in dark caves, and it all saves and reloads
  — effects, absorption, and every brewing stand mid-brew.

- **2026-07-18** — **Netherite: the endgame gear tier (expansion phase E8, `10` §9)**:
  the full progression is now live. Mine **ancient debris** with a diamond (or
  better) pickaxe deep in the Nether, **smelt** it into netherite scrap, combine
  **4 scrap + 4 gold ingots** into a **netherite ingot**, then take a diamond tool
  or armor piece to a **smithing table** — [gear] + [ingot] → its netherite
  counterpart. The upgrade **keeps every enchantment, the item's anvil name, and
  its used durability** (a worn Efficiency-V diamond pickaxe becomes an
  Efficiency-V netherite pickaxe with the same wear and a bigger bar). Netherite
  tools have **2031 durability**, mine at **×9 speed** (faster than diamond), and
  hit for **+1 damage**; netherite armor keeps diamond's 20 armor points but adds
  **toughness** (soaks big hits better) and **knockback resistance** (a full set
  shrugs off 40% of melee knockback). And the signature perk: **netherite items
  float on lava and survive fire** — drop your gear in a lava lake and you can fish
  it back out instead of losing it. *(Pre-1.20 smithing: no upgrade template
  needed, just the ingot.)*

- **2026-07-17** — **Enchanting: table, anvil, grindstone (expansion phase E4, `08` part 2)**:
  the whole enchanting stack is in. Ring an **enchanting table** with bookshelves
  (keep the gaps clear — a torch in one blocks the shelves behind it) and spend
  lapis + levels on one of three offers; a full 15-shelf ring puts the bottom slot
  at level 30. The **24-enchantment catalog** now does what it says: **Fortune**
  multiplies ore drops, **Silk Touch** lifts glass and ore blocks whole,
  **Looting** widens mob drops, **Efficiency** and **Aqua Affinity** speed up
  mining, **Unbreaking** stretches durability, **Mending** repairs gear straight
  from XP orbs, **Protection / Thorns / Feather Falling** cut what you take, and
  **Power / Punch / Flame / Infinity** rework the bow. The **anvil** combines,
  repairs and renames — with the vanilla prior-work penalty, the 39-level wall,
  and a 12% chance to chip on each use; it also falls, and it hurts. The
  **grindstone** strips enchants and refunds XP. **Enchanted books** come off the
  table, and every enchanted item shimmers in the inventory and in the world. Six
  new synthesized sounds. Save format unchanged — old worlds load untouched.

- **2026-07-18** — **Redstone (expansion phase E5, `07`)**: the full circuit
  layer is in. **Redstone dust** carries a 0–15 signal that fades one level per
  block and auto-shapes to its neighbours; **redstone torches** invert and burn
  out if you flick them too fast; **levers, buttons, and pressure plates** are
  the inputs (wooden plates trip on any entity, stone only on the living).
  **Repeaters** delay and lock; **comparators** compare/subtract and read how
  full a container is. **Pistons and sticky pistons** shove up to 12 blocks (and
  pull one back); **observers** pulse on any change they watch. **Dispensers**
  fire arrows, place water, and prime TNT; **droppers** and **hoppers** move
  items — a hopper chain fills a chest, and powering a hopper locks it.
  **Redstone lamps** light instantly, **note blocks** play by the block beneath
  them, and redstone now triggers **TNT** and opens **doors**. The whole thing is
  event-driven and stays well under a millisecond a tick even with dozens of live
  circuits. Save format unchanged — component state rides in the block bytes.

- **2026-07-18** — **The Nether + a multi-dimension engine (expansion phase E7, `10`)**:
  light a 4×5 obsidian frame with **flint & steel** and step through — after 4
  seconds the world dissolves and you arrive in the **Nether**, a claustrophobic
  cavern hell of netherrack, lava seas, and dense red fog with no sky. Travel is
  **8:1**: a step in the Nether is eight in the Overworld, and a return trip drops
  you back at your own portal. Four biomes generate — nether wastes, crimson and
  warped forests (glowing nylium, fungi, roots, shroomlight) and soul-sand valleys
  with bone fossils — threaded with **fortresses** built of nether brick over lava,
  each guarding a **blaze spawner** and a nether-wart garden with a loot chest.
  New mobs: **ghasts** (shoot fireballs you can **deflect back** with a well-timed
  hit to one-shot them), **blazes**, **zombified piglins** (neutral until you swing
  first — then the whole pack turns on you), **magma cubes** that split when killed,
  **wither skeletons**, and **piglins**. Mine **quartz, nether gold, ancient debris,
  glowstone, and magma blocks**; grow **nether wart** on soul sand for brewing.
  Nether rules bite: **water evaporates**, **lava spreads fast**, magma blocks burn
  your feet, and **sleeping in a bed explodes it**. Under the hood this lands the
  frozen multi-dimension engine (dimension registry, portal/teleport API, and
  per-dimension world/sky/lighting/save keys) that the End will build on — and your
  Nether builds now persist and reload correctly per dimension. *(Netherite gear
  and piglin bartering arrive in a later phase.)*

- **2026-07-17** — **Sweep attack + offhand slot (expansion phase E3, `08` part 1)**:
  a full-charge sword swing while standing now **sweeps** — every mob in the halo
  around the one you hit takes damage, gets shoved the way you're looking, and the
  arc flashes with a new synthesized `player.attack.sweep` sound. Sprinting,
  jumping, or swinging an axe won't sweep, same as vanilla. The **offhand slot**
  is live: `F` swaps your held item with it (in the world and over a hovered
  inventory slot), the slot appears left of the hotbar only when it holds
  something, and right-click runs the real two-hand pipeline — pickaxe in main +
  torch in offhand places torches, offhand food is eaten only when your main hand
  has nothing to do, and bows fire offhand arrows first. Under the hood this lands
  the item-stack `tags` schema that enchanting, potions, the Nether, the End,
  villages and bosses all build on. Also fixes two long-standing bugs found along
  the way: **carrots and potatoes could never be planted** (they were always eaten
  instead), and the item-name popup on switching hotbar slots never appeared.

- **2026-07-17** — **Creative mode (expansion phase EC, `18`)**: the old F4
  debug-creative flag is now a first-class, persisted **game mode**. `F4` toggles
  survival ⇄ creative; double-tap `Space` to fly (`Space` up, `Shift` down, both
  to hover, `Ctrl` to sprint-fly at ~21.8 m/s). In creative you take **no damage
  from anything but the void** and no knockback at all, hunger and health freeze,
  blocks break instantly with no drops/XP/tool wear (bedrock, water and lava stay
  unbreakable, and chests still spill), placing never depletes the stack, and
  middle-click **pick-block** grabs whatever you're looking at. `E` opens a new
  **tabbed, searchable creative inventory** — every registered item across 8
  categories, a search tab, the real survival inventory with its craft grid, and
  a destroy slot (shift-click it to empty everything). Hostile mobs ignore you
  entirely and won't retaliate, but still spawn and still drop loot when you kill
  them. Creative adds **zero new block or item ids**. *(Ctrl+pick's `tags` copy is
  deferred until 08 freezes that schema — see DEVIATIONS.md.)*

- **2026-07-17** — **Fire spread & waterlogging (expansion phase E2, `15`)**: the
  full Java 1.20 fire-spread engine replaces the old "fire never spreads" stub —
  age-nibble state, the exact scheduled-tick algorithm, a flammability table for
  the whole block set, ignition by flint & steel / lava random ticks / lightning,
  eternal fire on `infiniteBurn` blocks, and a film-safe 24-block spread leash
  (set `FIRE_SAFETY` to `Infinity` for unbounded vanilla behaviour). Wool floors
  catch and burn out; rain douses; TNT primes when fire consumes it.
  **Waterlogging** arrives via the globally reserved `states` bit 7: fences,
  ladders and chests can hold a water source, which now behaves as water for
  fluid spread, buckets, swimming, drowning, light filtering, crop hydration,
  lava conversion and infinite-source formation — and is explosion-proof. This
  phase **freezes the bit-7 layout**; the contract is documented at the head of
  `src/registry/blocks.js`. *(§7's 4-frame animated tiles are deferred — see
  DEVIATIONS.md.)*
- **2026-07-17** — **Theme-music drop zone is Vercel-ready**: drop original or
  licensed tracks into `public/theme-music/`, run `npm run theme:clear --
  --license "…"` to record provenance, and they play locally *and* on the deploy.
  Fixed two defects that would each have shipped a broken build: the folder was
  gitignored (tracks would play in dev then be absent from Vercel), and the ship
  gate counted `README.md` as an undeclared track and deleted the folder while
  the bundle still referenced the tracks — every theme URL would have 404'd. See
  [`public/theme-music/README.md`](public/theme-music/README.md).
- **2026-07-17** — **Right-click placement fix** (`UPDATE-rightclick-fix`): `air`
  was never marked `replaceable` (nor were `water`/`lava`), so `tryPlace` rejected
  every placement into empty space — you could only ever place a block *over a
  flower*. The replaceable set now matches 03 §16.2 exactly. The same guard had
  also silently broken filled buckets, doors and beds; all now work. The reported
  crafting-grid right-click bug did not reproduce — RMB already deposits one item
  at a time in both the 2×2 and 3×3 grids, verified with real mouse events.
- **2026-07-17** — Audio integration audit (`UPDATE-audio-not-playing-fix`):
  re-verified the whole E1 chain against the **real** browser autoplay policy
  (suspended → running on a genuine gesture, audio flowing immediately) and
  against the production build (walking produces synthesized footsteps, zero
  audio requests). Fixed one real hole: `musicMode: "Menu + gameplay"` with no
  cleared theme tracks suspended the synth composer without anything to replace
  it — silence in every shipped build. The composer is now the fallback §16
  mandates, so music always plays with zero assets.
- **2026-07-17** — **Audio (expansion phase E1, `16-AUDIO`)**: a full Web Audio
  layer, **100 % synthesized at runtime — zero sample files, zero audio
  downloads**. Every sound is built from oscillators, noise and math: a boot-time
  buffer bakery (pink/brown/impulse beds, baked Karplus–Strong plucks, seamless
  ambience loops — 3.6 MB, seeded so it sounds identical every run), 11 synth
  primitives, and a master event registry covering block step/dig/break/place for
  12 material classes, player hurt/fall/eat/XP, nine mob voices with idle
  cadence, explosions that muffle with distance, weather, and fluid-cluster
  ambience. Positional audio via a 32-voice pool with priority stealing and
  per-event caps; an all-original generative composer (seeded random walks over
  scale tables — the same world always replays the same piece); and an Options
  screen reachable from the title *and* pause with five bus sliders, theme-music
  mode, mouse sensitivity and view bobbing (the last two were previously stored
  but unread). Audio costs ~0.015 ms/frame typical against a 1.5 ms budget.
- **2026-07-17** — Main menu + menu music: desert/badlands-sunset title screen
  (animated CSS scene, ClaudeCraft wordmark, version badge, PRESS START →
  New Game / Continue / Settings / Quit on the supplied art, self-hosted OFL
  fonts, reduced-motion aware), a settings panel with live-persisted Master /
  Music / SFX sliders, and the 16-AUDIO §4A theme-music player (shuffled, no
  immediate repeats, RAM-guarded preload, 1.5 s/0.8 s fades, 10–20 s gaps,
  gesture-started, fades out on world load). Renamed VoxelCraft → ClaudeCraft.
  **Menu tracks are gated:** the C418 files in `CC-assets/CC-sounds/` are local
  dev placeholders that can never reach a build — see DEVIATIONS.md "Audio
  copyright ship-gate" before shipping music.
- **2026-07-17** — Sky/sun render fix: sun, moon and sunset band now depth-test
  against terrain (leaves/hills occlude them; the "grey blob at spawn" was the
  moon drawing through the ground), horizon visibility gates at `dir.y > −0.3`,
  the sun dims and warms through dusk via the §6 `sunIntensity` curve and the
  sunset-band window, soft zero-edge sun texture (no more hard square), moon
  alpha scales with phase and the new-moon cell is 25 % alpha per spec.
- **2026-07-17** — Crafting/inventory UI overhaul: canonical 176×166 GUI-px
  layout (armor / player preview / offhand / 2×2 grid / arrow / result), fixed
  shaped-recipe matching (pattern bounding-box trim — axes and hoes craft now,
  recipes match at any grid offset and mirrored), offhand slot 45 with F-swap
  and left-hand rendering.
- **2026-07-17** — Mouse look fix: pointer-lock deltas now drive the camera
  (0.15°/count, ±90° pitch clamp).
- **2026-07-17** — Performance: chunk-lookup caching in the lighting/world hot
  paths; worst tick 29 ms → 8.7 ms.
- **2026-07-16** — Initial complete build: worldgen, engine, player, mobs,
  combat, lighting, day/night & weather, crafting/smelting, hunger/XP,
  save/load — verified against the specs' acceptance checklists headlessly.

## Out of scope (by design)

Redstone circuits, enchanting, potions, the Nether/End, villages, multiplayer,
audio. See `CLAUDE.md` for the master plan and stretch goals.
