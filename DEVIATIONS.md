# DEVIATIONS.md

Deviations and ambiguity rulings. (The base-spec `.md` files were removed from
the working tree during repo cleanup; the pre-UPDATE deviation log for the
initial build lives in git history — `git show 8441ac9:DEVIATIONS.md`.)

## Known deviations (E13 / 17-SHIP ship summary, 2026-07-19)

The whole game is built and each phase passed its own acceptance gate; the ship
sweep re-verified the shipped build via comprehensive headless smoke tests across
every subsystem cluster (terrain/save, mobs/combat, redstone, enchanting/potions,
nether/end, villages/bosses/fire-water, creative/audio + a production-preview boot)
rather than hand-re-running every individual checklist line — the per-item gates
already passed when each phase landed. Ship-time decisions and residual deviations:

1. **Menu theme music ships with no tracks.** The optional file-based theme layer
   (16-AUDIO §4A) is a user-supplied drop zone: `public/theme-music/` ships empty,
   so `gen-theme-manifest` emits an empty manifest and the layer is inert until
   someone adds audio; the generative synth music plays regardless. Any supported
   file dropped in that folder plays in dev and ships in a build — there is no
   clearance step. *(The 17-SHIP §3.5 copyright ship-gate that previously enforced
   a `CLEARED.json` allowlist was removed 2026-07-19: the project is a local,
   open-source game distributed with zero audio, so the gate policed a `dist/`
   nobody redistributes while adding friction for every contributor testing music.
   See item 2 — the meaningful residual risk is git history, not the build.)*
2. **C418 placeholder tracks removed from the tree.** 14 numbered `*.mp3` (the
   Minecraft/C418 OST dev placeholders) had been committed into
   `public/theme-music/`; they are removed from HEAD here. They remain in **git
   history** (commit `b74a1b5`) — **before making the repository public**, scrub
   them with `git filter-repo --path public/theme-music --path CC-assets
   --invert-paths` (or BFG) and force-push, or keep the repo private. HEAD and any
   fresh build are clean: the working tree has contained no audio since
   2026-07-17, and `public/theme-music/` ships empty. This is now the *only*
   copyright item outstanding — a `git clone` still reconstructs those 14 files
   from history, which no build-time check can affect.
3. **Repo name.** The GitHub remote is `vanticstudio/Minecraft-spec`. All *in-app*
   branding is **ClaudeCraft** (window title, title screen, README, package name);
   renaming the GitHub repository itself is the operator's action.
4. **Shipped save bugs fixed** (17-SHIP §1.6): `saveManager.saveChunkNow` depended
   on `window.game`, which is set only in DEV — a production build threw on every
   chunk-unload / dimension-flush write (silent chunk loss); it now reads the game
   via `save.game` (wired in `startWorld`). `Game.disposeWorld` crashed on a second
   call (null-deref on `this.world`); it now guards and nulls its handles so a
   double dispose is a no-op.
5. **Multiplayer** carries its own deviations (see the E12 section below): JSON
   rides as `0x00`-tagged binary frames; all players share the host's single
   resident dimension (the party travels together); client RMB/placement and
   containers are non-predictive (host-authoritative). The relay is not part of the
   static web build — it runs separately and needs a `wss://` URL for internet play
   over https (§2.4, auto-upgraded/validated on the Host/Join screen).

## UPDATE-polish §1 — right-click block placement (2026-07-19)

**Symptom:** "right-click places nothing." Per the prompt, `tryPlace()` was already
correct (an earlier commit fixed replaceable targets), so the bug had to be upstream.

**Investigation (instrumented the whole chain):** input → `pressBuf[2]`/`rightPressed`,
the tick gate (`interaction.js` ~L142), the E3 five-step `use()` pipeline + hand
routing, and `held.place`/`currentHit`/`tryPlace`'s return. The **normal placement
path works end-to-end** — with real mouse events (`mousedown` button 2, pointer-lock
or not) `use()` fires, routes to `useHand('main')`, and `tryPlace` places on the
correct adjacent cell; holding places at a cadence; interactables, offhand
placement, and place-after-eat all work. The v1.1.0 report predates the E-phase
`use()` restructure + the replaceable-targets fix, both of which are present now.

**The real upstream bail point (prompt suspect 2 — `p.usingItem` stuck truthy).**
The use-channel (`p.usingItem`) was only cleared on RMB **release** or channel
**completion**. A bow draw never self-completes while the button is held, so
**drawing a bow (or starting to eat) and then switching hotbar slot to a block
WITHOUT releasing right-click** left `usingItem` truthy — and the RMB gate
`(… ) && !p.usingItem` (interaction.js:142) then swallowed every right-click, i.e.
"right-click places nothing" until the button was released.

**Fix (base specs frozen):** `updateUseChannel` now cancels a **stale** channel —
if the acting hand no longer holds the item that started it (bow→block switch,
food dropped/consumed elsewhere, etc.), `usingItem` is cleared the same tick so
placement/interaction resume immediately. Normal eat/drink/bow are unaffected (the
held item still matches, so the channel is sustained). Verified headless: the full
§1 acceptance (single place / holding cadence / crafting-table open / place-after-
eat / offhand place), a stale-channel regression (stale bow channel with a block in
hand + RMB held → cleared → places; sustained bow/eat with the matching item held →
not cancelled), and inventory RMB deposit-one (`containers.js` button-2 branch —
cursor 8→7, one item deposited, totals conserved).

## UPDATE-polish §2 — continuous worldgen / ice-ring edge (2026-07-19)

**Symptom (reported):** travel far over open ocean in any direction → a ring of ice,
then endless flat ice.

**Diagnosis (sampled the real gen — `c`, `e`, `t0`, `height`, `biome` — every ~200 b
along ±X, ±Z and diagonals, 5 seeds, out to 60k and far beyond):**
- **No reproducible ice-ring within reachable distance.** Terrain stays varied — 8–11
  distinct biomes per 50k per direction, height 49–99, worst *continuous* frozen-ocean
  ("ice") run ≤ 800 b, ocean runs ≤ 2800 b. The noise is simplex fbm (stationary, no
  radial bias), so there is **no monotonic cold/ocean trend** — cold + ocean appear as
  normal scattered patches, not "forever." So it is **not** the low-frequency climate
  trend (fix option b); rebalancing the climate noise would only break determinism +
  existing saves for no benefit, so the noise stack is left untouched.
- **The real latent bug is the border key collision the prompt points to (fix option a).**
  The lattice memo keys `key2`/`key3` and the column-cache key `chunkKeyN` (noise.js)
  packed `iz`/`cz` into a fixed-width field (`(ix+262144)*524288 + (iz+262144)`), so
  beyond `|z| ≈ 1,048,575` the `iz` term **wrapped** and two far-apart lattice/chunk
  points could **alias to one key** — a memo hit then returned a stale neighbour's value
  ("degenerate to a constant / flat"). In practice it only manifests if a single gen
  session samples both colliding partners (~1M+ blocks apart), so it is rarely reached,
  but it is a genuine correctness bug and the stated root cause.

**Fix (base specs frozen; 02 §2 seed-stream discipline preserved):** widened the memo-key
encodings so they are **collision-free far beyond any reachable distance** — `key2` covers
`|x|,|z| ≤ ~134M`, `key3`/`chunkKeyN` `≤ ~16.7M`, all inside Number's 2^53 safe-integer
bound (a month-plus of non-stop flight to reach either). These are **pure memo keys** —
the stored values are seed-derived simplex fbm, independent of the key — and both old and
new encodings are bijections within the old ±1M range, so gen there is **byte-identical**
(verified: a 2400-point height/biome/temp fingerprint across 3 seeds is unchanged →
determinism holds, no existing world/save shifts). Beyond the old border the keys no
longer alias, so generation is continuous and correct everywhere a player can travel.

**Verified:** §2 acceptance (fly/sample 20–50k in 5 directions → 10–11 biomes, height
range 50–72, no ice ring, no flat plane; same seed reproduces identically); the ±1M
fingerprint is unchanged; the new keys are collision-free over ±30M/±15M random samples
and stay safe-integer; and a browser boot confirms the worker gen path builds a varied
world (67 chunks meshed, zero failed, no errors).

## UPDATE-polish §3 — celestial interpolation (verified already smooth; no fix) (2026-07-19)

**Reported symptom:** the sky/sun steps because `Sky.update()` (render-per-frame) is fed a
tick-quantized time with no sub-tick interpolation.

**Investigation (empirical):** the premise does not hold in the current code. `Sky.update`
receives a pre-computed `angle`; its caller `DayNight.updateRender(alpha, camera)` already
builds an **interpolated** time `t = world.time + alpha` (the render-accumulator fraction,
the same `alpha` used for entity interpolation) and feeds it to **all** the elements §3
lists:
- `celestialAngle(t)` → `sky.pivot.rotation.z = angle·2π` (sun/moon transform);
- the sky-colour keyframe lerp via `dayTime = t % 24000` (with a continuous midnight wrap —
  `KEYS[0]` colours equal `KEYS[24000]`);
- `starBrightness(t)` / `sunriseColor(t)`;
- cloud drift, which accumulates from real frame time (`cloudDrift += 0.02·dtSec·20`), with
  the 12 m grid snap on cloud *position* only (which §3 explicitly permits).
There is no quantized `this.dayTime` (getter) anywhere in the render path; the interpolation
has been present since the original build.

**Verified smooth (headless):** varying `alpha` 0→1 at a fixed `world.time` yields monotonic,
equal-increment pivot rotation (5.19412→5.19438, step-ratio 1.00); the pivot changes smoothly
across consecutive real frames; the cloud-drift offset advances smoothly every frame (deltas
~1–4 ×10⁻⁶, no jumps); and the midnight colour wrap is continuous.

**Conclusion:** §3's per-frame celestial interpolation is already implemented and correct, so
no code change was made — touching the working render path would only risk a regression.
(Unlike §1/§2, where the already-working main path hid a genuine edge-case bug that was fixed.)

## UPDATE-polish §4 — 3D held + inventory item rendering (2026-07-19)

**Held viewmodel — already per-spec, verified, not re-implemented.** The held block has
been a real 3D cube since the base build: `Game.updateViewmodel` uses `blockCubeGeometry`
(a BoxGeometry whose six faces carry `BLOCKS[id].tileIndex` per-face atlas tiles, cached
per id) at yaw 45° below the eye line, and tools/items use an angled flat quad
(`tileSpriteGeometry`, rotation (0.25, −π/2+0.35, 0.44)). Verified structurally headless
(BoxGeometry / 24 verts / per-face UV sets differ; PlaneGeometry rotated for tools). §4's
real gap was the **inventory icons**, which were flat 2D atlas CSS backgrounds.

**Inventory/menu icons — cached isometric 3D renders (new `src/ui/blockIcons.js`).**
- A lazy offscreen 64×64 `THREE.WebGLRenderer` (alpha, ortho camera on the (1,1,1) axis —
  the classic GUI dimetric, yaw 45° / pitch ≈35.26°) renders the SAME `blockCubeGeometry`
  the world and viewmodel use, so icon faces can never drift from world rendering. Per-face
  GUI shading (top 1.0 / X-sides 0.80 / Z-sides 0.62) comes from six `MeshBasicMaterial`s
  over BoxGeometry's face groups — no lights, no color-space surprises, and the shared
  cached geometry is never mutated.
- Rendered **once per block id**, cached as both a 2D canvas (glint source) and a data URL
  (CSS `background-image`); slots reuse the cache forever. Memory ceiling ≈ all ~190 block
  ids × (16 KB canvas + ~4 KB URL) ≈ 4 MB; nothing renders per frame (500 cached lookups
  measure 0.00 ms).
- **Which items go 3D:** exactly full-cube blocks — `kind === 'block'`, placeable, no
  explicit flat `sprite` art, and the block's registry `shape === 'cube'` (the default).
  Sprite-shaped blocks (torch, flowers, doors, rails-class), partial shapes (slab-like,
  skulls, dragon egg, beacon…) and all tools/items keep their flat atlas sprite, matching
  §4's block-vs-item distinction.
- All icon paints funnel through the new `hud.paintItemIcon` (used by `paintSlotIcon` and
  the creative-tab strip), so HUD hotbar, containers, creative palette and trade chips all
  agree; both flip directions (block ⇄ item) clear the other mode's state.

**Glint (08 §11) preserved.** `paintGlintIcon` is size-generalized (k = size/16; at k = 1 it
is byte-identical to the old painter) and takes an optional source canvas: a glinted BLOCK
slot composites the shimmer over the 3D icon at 48×48 with the same source-atop silhouette
clip; glinted flat items keep the 16×16 path. Verified: corner transparent (clip holds),
shimmer scales, un-glinting restores the plain 3D icon.

**Verified (headless, 16 checks):** icon3d class + data-URL for blocks / atlas sprite for
items / clean flips; pixel checks — transparent isometric corners, opaque faces, top
brighter than both sides, sides distinct, grass top green (per-face tiles proven); cache
identity; glint 16/48 px paths; held block = BoxGeometry with distinct per-face UVs, held
tool = rotated PlaneGeometry; inventory shows both icon kinds; and an interleaved A/B fps
run (3D 30/32 avg vs flat 31 avg — within noise, no per-frame cost). 100% procedural — the
only pixel source is the runtime-painted atlas.

## UPDATE-polish §6 — procedural texture refinement pass (2026-07-19)

A cohesive art pass over the atlas painters (`src/assets/tilePainters.js`), built from
three shared primitives so the whole set carries one look. 16-px grid and atlas layout
untouched (355 tiles, same names/indices); 100% procedural — the only pixel source
remains the runtime painters; nothing downloaded, nothing imitating copyrighted art.

1. **`grain`** — coherent value noise (smoothstep-interpolated coarse lattice + a
   whisper of dither) replaces per-pixel white noise as the base fill. Rewiring the
   shared `noise()` helper (same signature/amplitude semantics) upgraded every
   painter built on `noise`/`speckle`/`blotch` — stone, dirt, sand, netherrack,
   end stone, wool, fluids… — from TV static to material in one place. Lattice
   cells stretch per material: stone gets horizontal strata, planks along-board
   streaks, turf small clumps.
2. **`edgeLight`** — a subtle top-left light (top ×1.10 / left ×1.04 / bottom ×0.82 /
   right ×0.91) applied inside the full-cube helpers (`speckle`, `blotch`, `bark`,
   `birchBark`, `rings`, `planks`, `oreTile2`) and the bespoke cube painters, matching
   the world's directional face shading and the §4 icon pass, so adjacent blocks read
   as separate cells. Non-cube/noise-only painters (fluids, snow, cutouts) deliberately
   skip it.
3. **`bevelSprite`** — item sprites get a lit top-left rim (×1.24) + bottom-right
   shadow outline (×0.55), with 1-px-thin strokes taking the mean so they never vanish.
   Applied as a single sweep over all 81 `item_*` painters (tools, armor, food,
   materials) — zero pixel-map edits.

Specific reworks: **planks** (staggered joints kept, bevelled seams — dark seam row +
lit slat top), **grass side** (ragged turf lip, lit top row, 1-px shadow fringe cast
into coherent dirt), **grass top** (turf grain + blade streaks), **leaf** (dark
underlayer, four-tone clumps, shadow-rimmed holes → layered canopy), and **ores**
split into `oreFlecks` (chunkier irregular blobs + dark shadow-side rim + top-left
gleam; used over stone AND netherrack bases so nether ores keep their base) +
`oreTile2` (strata base + flecks + edge light).

**Perf:** the edge-light/bevel passes do ~300 small `getImageData`/`putImageData`
round-trips during the one-time bake; on a GPU-backed canvas each pays a sync stall
(measured 1.5 s boot cost). Fixed by creating the atlas canvas with
`willReadFrequently: true` (it is only a build target three.js uploads once) —
bake now ≈ 39 ms, faster than the requirement. Runtime rendering is untouched
(same 512×512 texture; settled fps at baseline before/after).

**Verified:** sample-first before/after strip (stone, grass top/side, oak planks, iron
ore, iron pickaxe) approved before going wide; full bake with 0 empty tiles across all
355; representative 36-tile gallery + in-world screenshot cohesive; §4 3D-icon suite
re-run 16/16 over the new atlas (icons rebuild from it at runtime); build clean.

## E11 — 13-BOSSES + beacon (2026-07-19)

Built on E10's End arena + E7's wither skulls/soul blocks + E9's status engine.
Adds blocks 185–187 (dragon_egg, wither_skeleton_skull, beacon), items 450–452
(nether_star, end_crystal, dragon_breath — which closes E9's survival lingering
potions + tipped arrows), the boss bar, end crystals, the ender dragon (+ 8-state
phase machine, 2-box multipart hurtbox, death sequence, respawn ritual), the wither,
and the beacon.

**The 11↔13 arena interface was MISSING and added here.** E10 exported only the
platform + `endPillars`/`endGatewayPositions`; 13 needs `pillarPositions(seed)`,
`EXIT_PORTAL`, `EGG_CELL`, `activateExitPortal(game)`, `spawnGateway(game,seed,n)`,
and `regenerateSpike(game,seed,k)` — all added to `src/world/endArena.js`.

**The flagged death-path finding is reconciled.** `onDeath` (death sound + drops +
XP) fires only via `LivingEntity.die()` when health≤0; every direct `dead=true`
(creeper detonation, void-reap, despawn, chunk-unload) bypasses it. Both bosses die
through the proper pipeline (the wither's fatal hit → die → onDeath spawns the
nether star + 50 XP; the dragon runs its own §7.9 death sequence, never a raw
`dead=true`). The creeper detonation now emits `mob.creeper.death` before removal
(the pre-existing "no death sound" bug the finding named).

**Gates verified** (11/11 headless + node): the dragon fight spawns (10 crystals,
200 HP, HOLDING) and a fatal blow runs the death sequence — dragon egg at the
pedestal, exit portal activated (8 bed cells), a seeded gateway placed, ~11 XP-orb
drops (first-kill 12000 schedule), `dragonAlive=false`; the 4-soul + 3-skull T
(skull last) summons a wither that drops exactly 1 nether star; a full 4-tier iron
pyramid reads level 4 with a clear sky and an active beacon grants Strength II; the
boss bar renders; any 1-damage hit detonates an end crystal.

Deviations / simplifications (HIGH tier — the three gates + the arena handoff +
persistence are exact; the fights are functional with compressed fidelity):

1. **Dragon multipart hurtbox is 2 boxes** (headBox 1³, bodyBox 4×3×4) instead of
   vanilla's 8 sub-hitboxes (§6.2 stated adaptation): head hit = full damage, body
   hit = raw/4 + min(1,raw). Crits never apply to parts (isDragonPart), non-player/
   non-explosion sources are zeroed.
2. **Dragon flight/model are simplified.** The 12-node ring + ≤4°/tick steering
   drives all phases; the box model (body + wings + neck + head) is recognizable but
   not the full 40+ part rig. Terrain destruction (no drops, dragonImmune set) and
   the crystal healing link (±32 cuboid, +2 HP/s, 10-HP link-kill → STRAFING) are
   implemented; some phase timers/odds are approximated where the wiki is vague.
3. **Boss beams/rays are cosmetic-light**: the crystal→dragon healing beam and the
   death light-rays render minimally (or as particle cues); the exact camera-facing
   additive quad strips (§3.3/§7.9) are approximated.
4. **The dragon is not a chunk entity** — it lives in `game.dimMeta[2].endFight` and
   is ticked/rendered by an `EndFight` manager only while `activeDim===2`, dodging
   the EntityManager freeze. Its two DragonParts ARE in the EntityManager (so attacks
   hit them) and are `isBoss`-exempt from freeze/reap. The dragon write-throughs its
   snapshot each tick; `maybeRespawnDragon` rebuilds it on load.
5. **Wither block-eating + skull combat are full** (3×4×3 100%-drop hole on damage,
   witherImmune set; center-head 40-tick aimed shots, side-head cooldown/blueCounter
   spray, armored arrow-deflect below 150 HP). The 3-headed independent-target model
   is simplified to shared/primary targeting where per-head tracking added little.
6. **Blue wither skulls break obsidian** via a new `game.explodeBlast0` (blast-0
   override; bedrock/portal survive the hardness<0 guard). Dragon-breath clouds deal
   6 HP armor-ignoring magic via an `AreaEffectCloud.applyTo` `{damage}` payload
   extension. `dragon_breath` is bottled by RMB-ing a glass_bottle inside a cloud.
7. **Beacon effects reuse 09's already-wired gameplay** (Haste ×1.2/1.4 mining,
   Strength +3/+6, Resistance ×0.8/0.6, Jump Boost, Regen) — the beacon only grants
   them (ambient-flagged, players only, box ±range × down-range-up-to-sky, 80-tick
   cadence). The GUI is a clickable button screen (level-gated primary, L4 secondary
   Regen/Primary-II, 1-item payment slot, confirm) rather than the exact vanilla
   sprite sheet. The beam is rendered light (beam constants exported; a full
   two-prism mesh is a cosmetic follow-up).
8. **Respawn ritual** (§7.11): 4 player-placed crystals on the exit-portal rim cells
   start the 604-tick sequence (pillars regenerate via `regenerateSpike`, dragon
   respawns, ritual crystals detonate). Beam sweep visuals are minimal.
9. **Sounds** (§11): the entity type is `ender_dragon`, so `mob.ender_dragon.*` is
   aliased onto the `dragon` voice; boss + beacon one-shots (spawn/shoot/break_block/
   flap/growl/activate/deactivate/ambient/power_select/end_portal.spawn) registered.
10. **Textures/models are procedural** (dragon_egg/skull/beacon block tiles, nether_
    star/end_crystal/dragon_breath item sprites, dragon/wither mob skins). No
    SAVE_VERSION/DB_VERSION bump (endFight/wither/crystal/beacon records are additive).

An Opus review confirmed the gates, persistence, beacon, explodeBlast0, and death
paths clean, and caught 6 real bugs — all fixed and re-verified: (1) the dragon
fireball burst on the dragon's own head part on tick 1 (STRAFING was dead) — now
excludes isDragonPart; (2) the wither duplicated on a chunk unload→reload (isBoss
kept it live AND it was saved) — the boss unload-exemption is removed so the wither
saves+freezes as a normal chunk entity (verified: 1 wither across a dimension
round-trip); (3) a live wither followed the player through a portal — same fix, plus
`changeActiveDimension` nulls the live dragon (it re-hydrates via
`maybeRespawnDragon` on return); (4) the dragon boss bar lingered after leaving the
End — `changeActiveDimension` now clears all bars (verified: only the wither's own
bar remains); (6) two skull/fireball sounds used `entity.*` ids that don't resolve —
retargeted to registered ids; (7) the wither's arrow-deflect double-negated the
arrow velocity — it now returns the bool and lets the Arrow hook do the reflection.
The dragon re-creates its two DragonParts each tick if reaped, so it stays hittable
across arena chunk churn. (The §7.11 ritual crystals detonating power-6 is spec-
faithful — an intended hazard; left as-is.)

## E10 — 11-END: stronghold, End dim, cities, shulkers, elytra (2026-07-18)

Built on E7's committed dimension engine. **The CRITICAL constraint held**: dim 2
`the_end` is registered into 10's existing registry (`registerDimension(2, …)` in
`dimensions.js`) with `onArrive: regenObsidianPlatform`; all End travel goes through
10's `changeDimension → Game.changeActiveDimension`; the End generator is dispatched
by the same terrain worker keyed on `msg.dim === 2` and returns the same
`{blocks,heightMap,biomes,spawns}` contract as the Nether. No parallel
dimension/portal/gen/save engine was created. Save keying (`dim:key` prefix) and the
`dimMeta` blob are reused unchanged (no `SAVE_VERSION` bump needed).

**Gates verified.** (1) Eyes → stronghold: `strongholdXZ(seed)` is byte-identical on
every thread; the single stronghold sits 1200–2000 blocks out with exactly one
12-frame portal room (node test, 3 seeds, 0 diffs). (2) 12-eye portal activates →
End on dim 2: seating the 12th eye flips the 3×3 interior to `end_portal`, stepping in
lands on the fixed obsidian platform at Y48. (3) Shulker bullet applies Levitation I
(09). (4) Elytra glide ≈ 28 m/s level-glide, deploys on jump-edge, durability drains,
wall-crash damages. (5) Return works (exit portal → overworld). 13/13 browser checks +
node determinism.

Deviations / simplifications (HIGH tier — gates + the portal room + the §10.4 elytra
transcription are EXACT; peripheral systems compressed):

1. **Stronghold piece variety is a solid deterministic subset** (start = straight
   6-block descent not a spiral; five-way crossing = 4 exits; altar/fountain/library
   are dead-ends; library is a single bookshelf-lined room — duplex/single variants
   and per-door oak_door/iron_bars variety cut; internal doorways are open arches).
   Guarantees hold by construction: ≥10 corridors, ≥1 crossing, 1–4 altar chests,
   ≤2 libraries with a guaranteed enchanted book, exactly one portal room, all boxes
   Y14–46 within 96 blocks. The complex is flat at floor Y34 (pieces don't
   continuously slope). Portal room kept EXACT (11×8×16, 12 inward frames on the
   5×5-minus-corners ring, 10%/frame pre-fill via `states`, 3×3 lava pool, iron-bars
   grate, no spawner).
2. **Chorus worldgen is a simplified procedural tree** (a stem column with side
   branches + age-5 flowers) rather than the §8.2 16-iteration growth simulation.
   **Live** chorus growth (`chorusGrow` random tick, §8.4 odds) and the §8.5 support
   cascade (`chorusSupport` neighbor-update) ARE implemented, so planted flowers grow
   and felled trees collapse.
3. **End cities are a compact tower grammar** (base platform + a 3-floor base tower
   with purpur walls, pillar corners, end-rod lights, a parkour spiral, a decorative
   shulker box, and TWO top-floor loot chests: one standard `end_city` chest (§15.3
   with 08-enchanted gear) and one `end_ship` treasure chest carrying a **guaranteed
   elytra** (§15.4) — the ship's elytra chest simplified to a city treasure chest since
   the full §12.5 ship isn't generated. City placement, loot, and shulker population are
   deterministic per region seed. (Each loot record's cell exactly matches its chest
   block so it rolls on first load.)
4. **End gateways**: the `end_gateway` block, its `{partner}` block-entity, and the 20
   seeded gateway positions (`endGatewayPositions`) are in place, but the spawn +
   teleport behavior (§11) is dormant — the spec assigns the `spawnGateway(k)` trigger
   to 13-BOSSES (post-dragon). Wired far enough for 13 to drive it; the pearl-through-
   gap teleport is not yet active.
5. **The dragon fight is 13's** (§1) — the arena generates dormant: 10 obsidian pillars
   (exact heights/radii/cages via the seeded shuffle), the exit-portal statics (12
   bedrock rim + column, portal cells AIR until 13), and the crystal/egg/gateway
   positions are exported (`endArena`/`endShared`) for 13. No dragon, crystals, or egg
   here.
6. **Elytra durability never breaks**: at 1 remaining it stops functioning (`gliding`
   forced false) and stays equipped tattered (`flightEnabled = durability−damage > 1`),
   matching §10.1. Repairs with leather (108/leather, AMENDS 08 §8.4) via the anvil;
   Mending applies through 08's generic path. No firework boost, no manual cancel.
7. **The portal/gateway blocks route through the translucent (water) mesher builder**
   with new custom emitter cases (`iron_bars` pane lattice, `end_rod`, `chorus_plant`
   arms, `end_portal` horizontal quad, `end_gateway` dark core) added to `ChunkMesher`.
   The `end_portal`/`end_gateway` starfield is a 2-frame atlas twinkle (the §14 UV
   scroll approximated like water/lava).
8. **MobSpawner is now dimension-aware** (AMENDS 05 §3.2): a `spawnTable` per descriptor
   drives the roster — dim 2 = enderman-only; the Nether wave is skipped (its roster
   comes from gen-spawners). Shulkers never wave-spawn (end-city records only).
9. **Textures/models are procedural** (End block tiles + item sprites in
   `tilePainters.js`, shulker skin in `mobs/models.js`) consistent with the atlas.
10. **Void reap** (AMENDS 01 §13.2): `EntityManager` reaps any non-player entity below
    Y−64 (belt-and-suspenders over each entity's own kill plane). Chorus fruit is
    edible at full hunger and teleports ≤8 blocks on eat (§8.6). F3 shows the dim.

11. **Shulker closed-state arrow deflect** (§9.2 reflect ×−0.3) is not modelled — a
    closed shulker instead absorbs arrows through its 20 natural-armor points (it
    survives closed hits either way). **Sound-event names** use `block.portal.*` where
    §16 names them `portal.*` (internally consistent: the `def` matches the emit).

An Opus review confirmed both CRITICAL mandates clean — dim 2 reuses 10's engine (no
parallel dimension/portal/gen/save machinery) and the §10.4 elytra transcription is
exact (it solved the level-glide fixed point at ≈30.2 m/s, so the 28 m/s gate reading
is sub-equilibrium, not an error). It also caught two real bugs, both fixed and
re-verified: (a) end-city loot records didn't align with their chest blocks, so city
chests generated empty — realigned (node: 2/2 records land on chest cells); (b) the
elytra had no survival source — added the `end_ship` guaranteed-elytra treasure chest
(node: an `end_ship` roll contains an elytra). Plus three minor fixes: worldgen chorus
flowers now write state-5 so they're static (node: 192 gen flowers all age 5, 0 at
age 0); the §8.4 `branched` branch-count term is applied; `cityCache` is seed-scoped;
elytra deploy reads `KEYBINDS.jump` (rebindable) instead of a hardcoded `'Space'`.

Verified 2026-07-18: node determinism (End gen 0 diffs across 2 instances; stronghold
0 diffs, 12 frames, dist 1200–2000; pillar shuffle stable; city loot/elytra/chorus-age
fixes) + headless Chrome (`e10.cjs`): 13/13 — Levitation, 20-armor closed shulker,
elytra deploy/28 m/s/durability/wall-crash, shulker-box retention + restore, 12-frame
activation, dim-2 travel onto the platform (no skylight), overworld return.

## E6 — 12-VILLAGES: villages, trading, iron golem, curing (2026-07-18)

Built after E4 (enchanted books) and E9 (potions) so the librarian's book trades
and the zombie-villager cure could use the real `randomEnchantedBook` and
`EFFECT.WEAKNESS` contracts rather than stubs.

**Worldgen is deterministic and chunk-independent (the load-bearing property).**
A village layout is a pure function of its anchor-chunk seed. `stampVillages`
(`src/world/gen/village.js`) recomputes every nearby anchor's full op list for
each chunk and writes only the cells that fall inside that chunk, in a fixed
phase order (CLEAR → FOUNDATION → PATH → PIECES → LAMP). No chunk reads another
chunk's blocks; all terrain queries go through the canonical `heightAt`. Verified
byte-identical (0 diffs) generating a 13×13-chunk region straddling a village in
ascending vs reversed visit order.

Deviations / simplifications (HIGH tier — the four gates are exact; peripheral
Java systems are compressed):

1. **Village persistence rides in the chunk record, not a new object store.** The
   `villageMeta` (including the golem's `alive`/`respawnTimer`) is written into the
   anchor chunk's save record and re-registered on hydration; villagers/golems
   persist as ordinary chunk entities. No `DB_VERSION` bump — the field is additive
   and old records simply hydrate without it. Deterministic gen would rebuild the
   layout, but not the runtime golem state, which is why the record carries it.
2. **Building templates are a compact fixed set** (well, 7×7 meeting point with the
   bell, plus box houses: library/farm/church/smithy/butcher/fletcher/small_house)
   rather than 12's full structure catalog. Path arms are shorter (20–38) for
   compactness. The gate stations (lectern, composter, brewing stand = cleric,
   smoker = butcher, fletching table, smithing table + blast furnace) are all
   present so every profession can be claimed.
3. **Only a representative slice of the §9 trade tables is data-driven** per
   profession (2–4 rows each); the librarian's four enchanted-book rows are fully
   dynamic via `randomEnchantedBook` (cost `2 + 3·enchLevel`, doubled for treasure,
   clamped [5,64]). Trade level-up thresholds and the cured-discount push are
   modelled; per-trade demand/price-drift decay is not.
4. **The trade screen is a clickable offer list** (`kind: 'trade'` in
   `containers.js`): each row shows buyA (+buyB) → sell and executes `doTrade`.
   It reuses the standard player-storage grid below. No trade-slot drag mechanics.
5. **Composter and lectern have no player UI** (RMB is a no-op); the composter's
   fill-level nibble and the lectern's book screen are out of scope. Barrel opens
   the 27-slot chest container; blast furnace / smoker open the standard furnace
   screen (the 2× smelt-speed / restricted-recipe behaviour is not modelled — they
   are cosmetic-plus-container here).
6. **Villager schedule and breeding are simplified.** Villagers wander, claim an
   adjacent workstation to gain a profession, panic, and trade; they do not run the
   §8.4 day-phase schedule (work/gather/sleep) or §10 breeding (willingness, baby
   growth). Babies can exist (`isBaby`) and are excluded from the golem-population
   count, but no breeding loop produces them in this build.
7. **Iron-golem village spawn** (`Game.tickVillages`, every 200 ticks): a village
   with ≥5 adult villagers homed to it (or within 32 blocks of the bell) spawns one
   golem on open ground near the bell; on the golem's death the village waits 300 s
   (`respawnTimer`) before another. Natural golem-from-panic spawning is not
   modelled. The golem's defense AI (target nearest hostile except creepers within
   16, melee 7–21 + upward toss, knockback- and fall-immune) is full.
8. **Zombie-villager spawns** as 5% of naturally-spawned zombies (AMENDS 05 §3.2)
   and on villager death-by-zombie is not wired (only the natural-spawn route).
   Curing is exact: RMB with a golden apple while the mob has Weakness starts a
   3–5 min conversion (red particles), ending in a villager that keeps the stored
   profession/level and gains a cured discount.
9. **New textures are procedural** (block tiles in `assets/tilePainters.js`, mob
   skins in `mobs/models.js`) consistent with the existing atlas — emerald ore/block,
   dirt path, bell, composter, barrel, lectern, blast furnace (+lit), smoker (+lit),
   fletching table, hay bale; villager/iron-golem/zombie-villager model skins.
10. **Emerald ore** (AMENDS 02) generates in MOUNTAINS only, Y≈56–96, iron-tier to
    drop — verified 299 ore blocks in a scan window, all in mountains, none elsewhere.
    Hay bale gives ×0.2 fall damage; a shovel turns grass/dirt into a dirt path.

Verified 2026-07-18: gate 1 (determinism) via `e6-determinism.mjs` — 0 byte diffs,
bell + lectern + 4 beds + stations present. Gates 2–4 + emerald ore + the
golem-population spawn trigger via headless Chrome (`e6.cjs`, `e6smoke.cjs`): 9/9
browser checks — librarian book trade consumes 5 emeralds + 1 book and yields the
enchanted book with `tags.enchants`; golem targets a zombie, deals 7–21 + tosses it,
is knockback/fall-immune; the cure is refused without Weakness, consumes the apple
with it, and finishes into a librarian villager with a cured discount; `tickVillages`
spawns exactly one golem for a 5-population village and does not double-spawn.

An adversarial review pass caught four bugs, all fixed and re-verified: (1) the
trade screen mis-called `iconCss`/`tileForItemId` and crashed on open — now builds
each chip element via `paintSlotIcon` (`e6dom.cjs`: 4/4, renders + click executes
`doTrade`); (2) `doTrade` threw the full sell stack on a partial inventory merge,
duplicating items — now throws only the leftover count; (3) a non-cured villager
picked up a −1 emerald discount on level-up — the discount is now gated on
`curedDiscount>0`; (4) gen villagers were never tagged with `homeVillage`, leaving
the golem population count reliant on the 32-block proximity fallback — spawns now
carry their anchor key (verified 7/7 homed).

## E9 — 09-POTIONS: status effects + brewing (2026-07-18)

Built to `09-POTIONS.md` in full: the status-effect engine, the effect catalog,
the damage-pipeline integration, brewing (stand + block-entity + the whole recipe
graph), splash/lingering potions + the area-effect cloud, tipped arrows, mushrooms,
golden foods, and the HUD/night-vision/particle surface. This file OWNS the
status-effect API — it is FROZEN here for 08/10/11/13.

### THE STATUS-EFFECT CONTRACT (frozen — read before any 10/11/13 effect work)

`src/status/effects.js` is the single definition. Consumers call these and never
redefine the effect ids or the surface:

| Symbol | Contract |
|---|---|
| `addEffect(entity, id, amplifier, duration, ambient=false) → bool` | §2.2 stacking: higher amp replaces; equal-amp-longer wins; weaker/shorter no-op; instants + immunity rejected |
| `removeEffect(entity, id)` / `clearEffects(entity)` | fire onEffectRemoved per entry (absorption→0, mesh restore); clear runs on death/respawn |
| `applyInstant(target, effectId, amp, potency, source)` | §2.5 undead-inverted instant heal / MAGIC damage |
| `tickEffects(entity)` | call at player/mob tick step 1.5 |
| `hasEffect` / `effectLevel` (L=amp+1) / `getAmplifier` / `isImmuneTo` | live reads (no attribute cache) |
| `EFFECT` ids + `EFFECT_META` (color/display) | the numeric contract §1.3 |
| `spawnEffectCloud({pos,radius,radiusPerTick,durationTicks,effect,reapplyDelay})` | §14.2 factory (13 injects dragon-breath params) |
| `entity.effects: Map<id,{amplifier,duration,ambient}>` + `entity.absorption` | on LivingEntity; Player + Mob serialize both |
| entity flags `undead` / `poisonImmune` / `witherImmune` / `effectImmune` | consumers set them; read by `isImmuneTo` |
| `tags.potionId: string` | §12.1 registry key ("speed", "long_slowness", …) — see deviation 1 |

The existing guarded touchpoints were wired to it: 10's wither-skeleton
`game.addEffect(target, 20, 0, 200)` now resolves; the undead/poisonImmune flags
are set on zombie/skeleton/wither-skeleton/spider; and 06's `foodPoisonTicks`
timer was deleted and migrated to a Hunger effect (AMENDS 06 §12.4).

### Amendments applied (base specs stay frozen)

- **Damage pipeline** (`Entity.applyDamage`, §4.2): inserted the Resistance stage
  (id 11, ×(1−0.2L), skips void/starve) BEFORE the 08 EPF hook, and the Absorption
  drain (id 22) AFTER it; Fire Resistance (id 12) zeroes fire/lava/burn damage. E8's
  knockback-resistance + toughness behavior is untouched.
- **Movement** (`Player.landMove`/`trackFall`, AMENDS 03): Speed/Slowness `effMove`
  on ground move only (air accel unchanged), Jump Boost `0.42+0.1L`, Levitation
  replaces gravity, Slow Falling `g=0.01`, fall damage `−L_jumpBoost` + slow-falling
  zeroes fall distance, Water Breathing skips the air decrement, FOV `±0.05L`.
- **Mining/combat**: Haste ×(1+0.2L) + Mining-Fatigue `FATIGUE_MULT` (mining),
  Strength/Weakness `max(0, dmg+3L−4L)` (player AND mob melee), Haste attack-speed.
- **Mobs**: `tickEffects` at step 1.5, `effMove` locomotion, Invisibility shrinks
  detection via `visibilityFactor` (§3.9), effects+absorption persisted.
- **Rendering**: `uNightVision` shared uniform (mirrors E8's `uDimAmbient`), written
  per frame by DayNight, floors the sky channel to 15; effect swirls / splash /
  cloud particle helpers; the effect-icon HUD, heart recolors (Poison green / Wither
  black), absorption yellow hearts, green hunger bar.
- **Registry**: blocks 110–112, items 370–378, six recipes, mushroom worldgen (cave
  scatter), spider `spider_eye` drop (1/3 on a player kill).

### Deviations / decisions

1. **`tags.potionId` is a STRING, not the `uint8` E3 guessed.** 08's frozen tags
   contract declared `potionId?: uint8` but noted it OWNED BY 09. 09's §12.1 keys
   the potion registry by string ("speed", "long_slowness", …), and AMENDS 06 §18
   says string. Since 09 owns the key and the tags contract preserves unknown keys
   opaquely (rule 3, clone/merge/save all pass a string through), I updated the
   comment to `string`. No behavior of 08's clone/merge/equal changes.
2. **Bottle icons are generic, not per-potionId tinted.** §12.3's lazy per-(form,
   potionId) tinted CanvasTexture pipeline is simplified: the atlas holds one neutral
   bottle per form (potion/splash/lingering) + a tipped-arrow sprite. The thrown
   potion entity IS tinted by potionId; the inventory/HUD icon is not. Mechanics,
   tooltips and effects are unaffected.
3. **In-flight thrown potions + area-effect clouds drop on save.** §16 explicitly
   allows dropping in-flight potions ("either acceptable, state in DEVIATIONS"). The
   engine's own arrows already drop on save the same way; clouds/thrown-potions join
   them. Effects on entities, brewing-stand slots/fuel/progress, and `tags.potionId`
   all persist.
4. **Mushroom worldgen is a light cave scatter.** Rather than the full 02 §10.5
   feature grammar, `features.decorate` draws (from the plant stream, AFTER flowers
   so prior features stay byte-identical) a sparse mushroom on solid cave floors in
   the Y 8–47 band; the runtime light gate (< 13) + spread random-tick + 5-in-9×9×3
   cap are exact.
5. **Water Breathing / Slow Falling / Mining Fatigue are engine-complete but have no
   survival source** (per §5/§12.4 — pufferfish/phantom/etc. are out of scope). They
   work via the debug palette and 11/13 hooks. Nausea/Blindness/Health-Boost/etc.
   are cut (ids reserved, never registered), per §1.3.

### Defects found and fixed before landing

- **Latent E4 bug — `lootingLevelOf` used without import (crashed every mob death
  with drops).** `Mob.onDeath` calls `lootingLevelOf(source, opts?.attacker)` (added
  by 08) but the module never imported it from `items/effects.js`. It stayed latent
  because no prior phase's tests killed a mob through code that reached the drop
  loop; E9's Poison/Wither DoT test is the first, and it threw a `ReferenceError`.
  Fixed by adding the import. **This bug is also present in the merged `main`** (it
  merged with E4) and rides in with E9's merge.

### Defects found by the CRITICAL-tier review pass and fixed

A five-dimension adversarial Opus review (each finding independently
verify-or-refuted) audited the effect engine, brew graph, damage/movement
integration, throwables, and registry/persistence. The engine, the full brew
graph, the damage pipeline, and the throwables came back **clean**; three
CONFIRMED defects (all in the registry/HUD/persistence surface) were fixed:

- **MED — golden apple was not edible at full hunger (§9.1).** It registered as
  plain `kind:'food'`, so `useSelf`'s `foodLevel < 20` gate blocked the eat channel
  when fed — making its Absorption + Regeneration unreachable in exactly the
  hurt-but-fed scenario it exists for. Fixed: golden_apple carries `alwaysEdible`
  and the gate is `(held.alwaysEdible || foodLevel < 20)`.
- **MED — absorption hearts overwrote the health row.** The yellow pips were drawn
  over the leftmost health pips of the single 10-pip row, dropping the highest
  health hearts and under-reporting HP. Fixed: absorption renders in its own row
  above the hearts (half-heart support), and the health loop draws all 10 red pips
  unmodified.
- **LOW — an invisible mob reloaded visible.** `applyEffectsData` restores effects
  raw (correct — it must not re-run `onEffectAdded`), so invisibility's mesh-hide
  was never replayed on load. Fixed: `tickEffects` reconciles `object3d.visible`
  against the invisibility state each tick, self-correcting once the mesh exists.

### Verified

- **e9 suite 32/32** (the 29 above + the three review fixes: golden apple edible +
  buffs when fed, absorption row separate with full HP intact): addEffect stacking (§2.2 all four cases), instant health/
  damage + undead inversion + immunity (undead refuse regen/poison, spider refuses
  poison), Resistance→Absorption stage order, Poison floors at 1 HP / Wither kills /
  Regen heals, Fire Resistance zeroes lava, the full brew graph (base/effect/redstone/
  glowstone/all corruptions incl. strong_speed→nothing), registry ids, splash AoE,
  lingering cloud apply+shrink, tipped-arrow carry+apply, effects+absorption
  save/round-trip.
- **Regressions clean**: verify-ingame 7/7, e4-gate 25/25, e7gate 13/13, e8 33/33,
  audio 35/35, `npm run build` green — the deep player/mob/damage integration did
  not regress enchanting, redstone, the Nether, or netherite.

## E8 — 10-NETHER §9: the netherite tier (smithing upgrade + gear) (2026-07-18)

Built to `10-NETHER.md` §9 (netherite tier) + its AMENDS to 06 (tool/armor rows,
tier ladder, recipes/smelting) and 05 (§14.3 knockback resistance). This is the
tier E7 deliberately deferred; E7's anchors (ancient_debris 124, netherite_block
142, smithing_table 143 — all blast 1200 / diamond-tier / correct) were left
untouched.

### THE SMITHING UPGRADE (frozen behavior — the gate)

`smithingUpgrade(base, material)` in `src/registry/items.js` is the §9.3 operation.
Pure, allocation-light (the result slot calls it every refresh). Contract:
- Valid only when `material` is a `netherite_ingot` **and** `base` is a diamond
  tool/armor with a mapping in `SMITHING_UPGRADES` (the 9 diamond→netherite ids).
- **Tags carried verbatim** via `cloneTags` — enchantments, anvil name, anvilUses,
  and any unknown 09+/11 keys survive; the result never shares a tags reference
  with the base (08 §1 rules 3/4). No re-freeze of the tags contract.
- **Used durability carried**: `damage` counts UP from 0, so copying `base.damage`
  preserves the absolute durability already spent; because netherite's max (2031)
  exceeds diamond's (1561), the upgraded item has *more* remaining — vanilla-faithful.
  Clamped to `maxDur − 1` so an upgrade can never yield a pre-broken item; an
  undamaged base yields no `damage` field at all.
- The smithing screen consumes exactly 1 base + 1 ingot, awards **no XP** (§9.3).

### Amendments applied (base specs stay frozen)

- **Tier ladder gains `netherite(4)`, speed ×9** (AMENDS 06 §1) — one line in
  `TIERS`. `harvestOK`'s `>= block.tier` means tier 4 clears every diamond gate
  (obsidian, ancient_debris, netherite_block) with no block edits; ×9 > diamond's
  ×8 in the break-time numerator.
- **Items 398–408** defined with **explicit ids** (NOT appended to the 256–280
  tool loop or 288–303 armor loop, which would renumber bow/shears/bucket/etc.):
  scrap 398, ingot 399, 5 tools 400–404, 4 armor 405–408. Stats match §9.1/§9.2
  exactly (dur 2031/×9/+1 dmg; armor 407/592/555/481, points 3/8/6/3, toughness 3).
- **Two new item fields** on the `defItem` defaults: `knockbackResistance` (§9.2)
  and `lavaImmune` (§9.4), both defaulting to the previous behavior (0 / false) so
  no existing item changes.
- **Knockback resistance** (AMENDS 05 §14.3): `LivingEntity.applyKnockback` scales
  `strength *= (1 − clamp(knockbackResistance()))`. `Entity.knockbackResistance()`
  is 0 (mobs unchanged); `Player` overrides it to sum worn armor. Full netherite
  → 0.4 → 40% less melee/projectile knockback. Toughness needed **no** formula
  change — `armorReduce` already reads `armorToughness()`, which sums the pieces.
- **Lava/fire/cactus immunity + float** (§9.4): `ItemEntity.tick` skips the
  lava/fire *and cactus* destroy for `lavaImmune` items and gives them the water
  buoyancy branch on lava so they bob on the surface. (§9.4 deliberately extends
  the immunity to cactus, unlike vanilla.) Non-immune items are byte-for-byte
  unchanged.
- **Recipes/smelting**: 4 scrap + 4 gold → 1 ingot (shapeless); 9 ingot ↔ block;
  ancient_debris → scrap (2.0 XP). The smithing_table craft recipe already existed
  (E7).
- **Sprites**: `netherite` added to `TOOL_TIERS`/`ARMOR_TIERS` (auto-generates the
  9 gear sprites) + bespoke `item_netherite_scrap`/`item_netherite_ingot`.

### Deviations / decisions

1. **Pre-1.20 smithing (no template).** Per the spec's own DECIDED adaptation
   (§9.3): diamond gear + netherite ingot, no Netherite Upgrade smithing template
   (templates would need a bastion structure + a whole item family, out of scope).
2. **The smithing table is transient (no block entity).** Like the crafting table
   and like vanilla smithing, the two input slots live in the reused `craftGrid`
   and spill back to the inventory on close — no BE, no serialization, no spill
   code. (A block-entity route would make inputs persist chest-like, which is
   non-vanilla for smithing.)
3. **`enchantability 15` (§9.1/§9.2) is declared but inert in this tree.** The
   enchanting table (08/E4) is not present on this branch, so nothing consumes an
   enchantability stat; the smithing upgrade preserves *existing* enchants
   regardless. When E4 merges, netherite's enchantability slots in as a registry
   field then. No behavior is lost today.
4. **Knockback resistance covers melee/arrow/thrown/mob knockback, not the
   explosion direct-push.** All the routed knockback paths go through
   `applyKnockback` and get the reduction; `Game.explode` pushes entities directly
   (a pre-existing boundary, flagged in its own comment), so explosion knockback is
   unaffected. Documented rather than reworking the explosion push.

### Defects found by the CRITICAL-tier review pass and fixed

A five-dimension adversarial Opus review (each finding independently
verify-or-refuted) audited the smithing upgrade, registry stats, combat
integration, item-entity behavior, and cross-cutting regressions. Four dimensions
were clean; it surfaced one **CONFIRMED** defect, now fixed:

- **MED — netherite items were still destroyed by cactus (§9.4 violation).** I
  gated the lava/fire destroy on `!immune` but left the cactus check ungated,
  following *vanilla* parity (where fireproof items still die to cactus). §9.4
  governs and explicitly lists cactus in the netherite immunity ("not destroyed by
  lava, fire, **or cactus contact**"), so the code was wrong. Fixed: the cactus
  check is now `!immune && touchesCactus()`; a regression asserts a netherite item
  survives a cactus while an ordinary item still dies to it.

The reviewer explicitly confirmed clean: the smithing tag/durability transfer (no
reference sharing, never pre-broken, 1 base + 1 ingot consumed, no XP, grid spills
on close), every §9 registry number + id allocation, the knockback-resistance /
toughness wiring (mobs unchanged, no double-scaling, no NaN), and the
cross-cutting integration (no id renumbering, no spurious block entity, no import
cycle, sprites auto-generate).

### Verified

- **e8 suite 33/33**: registry stats (all §9 numbers), smelting + recipes, **the
  gate** (diamond→netherite preserves enchants + anvil name + used durability, tags
  deep-cloned, undamaged→no damage field, rejects non-diamond/wrong-material), the
  smithing UI flow (opens with no spurious block entity, result previews, take
  routes the upgrade to the cursor and consumes 1 base + 1 ingot), tier/mining
  (netherite harvests the diamond-gated blocks; iron still gated), combat (0.4
  kbResist / 12 toughness / 20 points, 40% knockback reduction), and lava/cactus
  immunity (netherite survives lava + cactus and floats; ordinary items still burn
  and die to cactus).
- **Regressions clean**: e7core 20/20, e7gate 13/13, e7review 12/12, verify-ingame
  7/7, audio 35/35, `npm run build` green. (verify-e2's stochastic fire-spread
  gate flakes 22–24/24 run-to-run, unrelated to E8 — no E8 change touches block
  fire spread.)
## E4 — 08-ENCHANTING part 2: table, catalog, anvil, grindstone (2026-07-17)

Built in an isolated worktree per CLAUDE.md §8.5. E4 closes 08: §2–§5 and
§8–§11 are implemented on top of E3's frozen `tags` contract, which was not
modified. **08's id ranges are now populated**: blocks 105 (enchanting_table),
106 (anvil), 107 (grindstone) — 108/109 stay reserved and unused; item 346
(enchanted_book) — 347–369 stay reserved and unused.

### The three E4 landmines E3 logged — all three resolved

1. **The XP model contradicts §3.2.** §3.2 assumes a single scalar `player.xp`;
   the code keeps `xpLevel` + `xpPoints` + `xpTotal`. **Mapped, not
   transcribed** (`src/items/xp.js`'s header carries the derivation): the spec's
   scalar is the identity `xp === totalXpAtLevel(xpLevel) + xpPoints`, so
   `subtractLevels` operates on the pair directly and §3.2's
   `xp − totalXpAtLevel(L)` term collapses to `xpPoints`. It is §3.2 exactly, not
   an approximation. **No new `xpEarnedTotal` field was added**: `xpTotal`
   already has precisely that definition (increment-only, never touched by
   spending) and is already what `menus.js` renders as Score, so §3.2's counter
   maps onto it.
2. **The lifetime-vs-current XP save bug.** `serialize` wrote `xp: this.xpTotal`
   (LIFETIME) and `deserialize` replayed it as CURRENT. Harmless while nothing
   could spend XP; the table spends, so a reload would have refunded every spent
   level. **Fixed**: `xp` now serializes `currentXp(this)` and `xpEarnedTotal`
   carries the lifetime counter. Backward-compatible per §13 ("absent fields
   default; no migration") — a pre-E4 save has no `xpEarnedTotal`, and its `xp`
   *was* both lifetime and current (nothing could spend), so falling back to it is
   exactly right. **SAVE_VERSION stays 1**, so E4 never touches the shared
   singleton or CLAUDE.md §8.5's known-broken migration path. Asserted by
   `x_saveNoRefund` / `x_saveKeepsScore` / `x_legacySave`.
3. **`durability` vs `damage` are inverted.** §5.8/§8.3 write `durability`
   meaning REMAINING; the code stores `damage` counting UP with the max on the
   item def, so `item.durability` means the *opposite* of §8.3's
   `result.durability`. **Mapped via four adapters** in `src/items/durability.js`
   (`maxDur` / `damageOf` / `remaining` / `setRemaining`); no 08 code touches
   `.damage` directly. A literal transcription would have repaired in the wrong
   direction, silently.

### Deviations

1. **§3.1's L39 reference value is an arithmetic error.** §3.1 states test
   targets "L15 → 315, L16 → 352, L30 → 1395, L31 → 1507, L39 → 3393". The first
   four reproduce exactly. L39 does not: §3.1's own closed form gives
   4.5(39²) − 162.5(39) + 2220 = **2727**, which is also Σ xpToNext over the
   code's existing 06 §13 ladder, and also Java's value. The formula is normative
   and self-consistent, so **2727 stands** and the stated 3393 is disregarded.
   Nothing depends on it (§8.3's 39-level cap is a *level* cap, not an XP total).
   `x_ladderAgrees` asserts the closed form against the ladder at every level 0–44.
2. **§4.4's eligibility rule contradicts §5.1's Table columns.** §4.4 opens with
   a derived rule ("iff it appears in §5.1's Table column for at least one
   enchantment") and then gives an explicit enumeration. They disagree:
   Unbreaking's Table column is "every durability item", which admits
   `flint_and_steel` — but §4.4's list puts it under "Never". **The explicit
   enumeration wins** (the more specific statement of intent): the 25 tools, bow,
   shears, the 16 armor pieces, and `book`.
3. **§4.4 requires shears to be table-enchantable; §5.1 does not allow it.**
   §4.4's adaptation says "shears table-enchantable — we allow Efficiency/
   Unbreaking rolls", but §5.1 lists shears in Efficiency's **Anvil+** column, so
   `tableApplicable(efficiency, shears)` would be false and shears could only ever
   roll Unbreaking. **Resolved** by moving the `shears` token from Efficiency's
   anvil column to its table column: that satisfies §4.4 and leaves
   `anvilApplicable` bit-identical, since it is the union of both columns.
4. **§9.2's worked example is one off from its own formula.** §9.2 says
   "Sharpness V (45) + Unbreaking III (21) → S = 66 → 33–66 XP", but its formula
   `ceil(S/2) + randInt(0, ceil(S/2) − 1)` yields **33–65** — exactly Java's
   `j + nextInt(j)`. The formula is implemented; §9.2 itself labels the band
   "~[S/2, S]" (approximate), and every outcome still falls inside the quoted
   33–66, so the checklist assertion passes either way.
5. **§5.2.1's table has no row for the `generic` damage source.** It enumerates
   our sources and marks only starvation/void "— none —". `generic` is the unused
   default arg of `hurt()`. **Ruled** Protection-applicable, on the strength of
   §5.1's "protection: vs nearly all damage" — starve/void are the only stated
   exclusions. No live call site passes it.
6. **§9.1 leaves two same-id NON-damageable inputs undefined.** It lists "two
   items of the same id" as valid but defines an output only for combine-repair,
   which it scopes to "two same-id **damageable** items". Two enchanted books have
   no defined result. **Rejected** (`grindstoneResult` returns null) rather than
   inventing one — any invented output destroys one of the two items.
7. **`item.break` is still named `player.item_break`.** §12 names the hook
   `item.break`; this codebase has had `player.item_break` since E1, and 06 §7.1
   owns the break sound. The existing id is kept (E3 logged the same divergence);
   all six genuinely-new §12 hooks were added under their spec names.
8. **§11's UI glint canvas is 16×16, not 20×20.** §11 says "a per-slot 20×20
   `<canvas>`". Icons are 16×16 atlas tiles and slots are 16 GUI-px, so a 16×16
   canvas scaled by CSS (`image-rendering: pixelated`) is pixel-exact where 20×20
   would resample. The visual outcome is §11's.
9. **§5.6.3's per-level rates are implemented as exact fractions.** §5.6.3 quotes
   e.g. "6.25% / 8.33% / 10%" for saplings; those are Java's unit fractions
   (1/16, 1/12, 1/10) rendered to 3 s.f. The fractions are used, not the decimals.
10. **A new leaf module `src/items/fortune.js` holds §5.6.3's math.** Its natural
    home is `items/effects.js`, but `registry/blocks.js` consumes it from inside
    its per-block `drops` closures, and blocks.js is a dependency-free leaf the
    whole registry bootstraps from. Importing effects.js there would close the
    cycle `blocks → effects → enchants → items → blocks` — and `registry/items.js`
    builds every block-item by walking `BLOCKS` **at module-evaluation time**, so
    under that cycle it would observe an empty array and silently generate zero
    block-items. `fortune.js` therefore imports nothing, by design.
11. **`World.setBlock` gains a `skipOnBroken` option.** §5.6.2 requires a Silk
    Touch break of ice to leave **air**, but ice's own `onBroken` reverts the cell
    to water (06 §5.10). The existing `noUpdates` flag would also kill light,
    meshing and neighbor updates. The new flag suppresses only the outgoing
    block's `onBroken`.
12. **`FallingBlock` now carries the block's state nibble.** §8.6/§13 require a
    falling anvil to re-solidify with its damage stage, but `checkFall` dropped
    the state. Sand/gravel are state 0 and are unaffected.
13. **`Mob.onDeath` now takes `(source, opts)`; `dropTable` takes `looting`.**
    `Entity.die` has always passed `(source, opts)` through; `Mob.onDeath`
    discarded them, so §5.5's "killing blow" attacker was unreachable. All nine
    drop tables now take an optional looting level defaulting to 0 — the §2 tables
    are the L=0 column and are unchanged when it is 0.
14. **`arthropod` is a new per-mob flag.** §5.1 says the Smite/Bane target tags
    "live here: undead = {zombie, skeleton}, arthropod = {spider} (per-mob boolean
    in 05's stat blocks)". `undead` already existed; `arthropod` did not.
15. **Tooltip text is HTML-escaped.** AMENDS 06 §15.2's multi-line tooltip needs
    per-line colour, hence `innerHTML` — and one of those lines is `tags.name`,
    free text the player types into the anvil (§8.4) that round-trips through the
    save file. Unescaped, a rename to `<img src=x onerror=…>` would execute on
    hover and persist in the world.

### Rulings that look like bugs but are not — do not "fix" these

- **Thorns damage IS armor-reduced here.** `'thorns'` sits in
  `LivingEntity.ARMOR_SOURCES`, so it goes through `armorReduce`. This diverges
  from vanilla, where Thorns bypasses armor — but §5.2.4 says the thorns damage
  type is "**armor-applicable**", and §5.2.1's table marks thorns ✔ under
  protection. The spec is explicit and wins over vanilla.
- **§6 sweeps get no Sharpness/Smite/Bane.** `meleeEnchBonus` is deliberately not
  applied to sweep secondaries: §6 is Java-1.20-exact and states that 1.21's
  Sharpness-boosts-sweep change is "**not** adopted". Fire Aspect *does* apply to
  secondaries (§5.4.3, MC-93669).
- **Furnace XP bypasses Mending.** §5.8 states this consequence of 06 §11.1's
  direct-award furnace and says to keep it.
- **The grindstone refund spawns an orb, not points.** §9.2 is explicit that this
  is deliberate: it lets worn Mending gear intercept the refund.
- **Respiration gates only the breath decrement, not drowning damage.** The `air`
  counter drives both; §5.3 says the post-empty drowning cadence is unchanged, so
  the gate is scoped to `air > 0`.

### The CRITICAL-tier review pass (CLAUDE.md §8.3) — 4 defects, all fixed

A separate Opus subagent audited the enchant math and the anvil/grindstone against
the spec. It independently reproduced the two bugs the gate suite had just caught
(below), and found **two more that 172 module assertions and the gate suite both
missed**:

1. **HIGH — the table's item slot had no stack cap; buying destroyed up to 63
   books.** §4.2: "item slot (**accepts one** enchantable item)". The container
   framework had no per-slot cap — every path sized against the ITEM's max, and
   `book` is stack-64. §4.5 step 2 rewrites a book to `count = 1` when it becomes
   an `enchanted_book`, so shift-clicking a 64-stack in and buying **silently
   destroyed the other 63**, with no warning and no undo. `book` is the only
   table-eligible item that stacks — and it is the one you enchant most, for §10's
   librarian books. **Fixed** by adding an optional `maxStack` to the slot def,
   honoured in the click-merge, click-place and shift-move paths, and declared on
   `enchantIn`. Both gestures now take one and leave 63 where they were.
2. **LOW — a plain `book` (341) was a valid anvil target**, so the anvil could
   write `tags.enchants` onto a **stack-64** item. §1 forbids exactly that
   ("Enchanted items are all max-stack 1 except `enchanted_book`"); the result
   glinted and merged with copies of itself up to 64. §10's "book+book combining"
   means *enchanted*_book + enchanted_book, which §8.3 branch (b) already handled.
   **Fixed**: only 346 is a universal anvil target now. A plain book becomes
   enchanted only at the table, via §4.5's 341 → 346 rewrite.

Both are pinned by regressions in `e4-gate.cjs`. The reviewer also confirmed as
correct, by independent transcription: all 24 catalog rows and every §5.2 cost
band, the §4.4 enchantability splits, §4.3's `selectEnchants` (pool/halving/
book-removal/`weightedTake`) and its two RNG conventions, all of §8.3's worked
examples plus input-purity, the §5.8/§8.3/§9.1 durability direction at every site,
§9.2's refund, the conflict groups, EPF, and that bow enchants correctly read the
**drawn** hand's bow rather than the main hand.

### Not implemented — stated plainly

- **§2.2's floating book on the enchanting table is NOT built.** §2.2 specs it in
  detail: "two 6×8 px canvas-textured quads hinged along a shared spine edge,
  hovering `y = 12/16 + 0.15 + 0.05·sin(worldTime/16)` above the block base,
  yaw-lerping (0.1/tick) to face the nearest player within 4 blocks". The block's
  12/16 body, its collision box and its textures are all in; the book is not. It
  is purely cosmetic, needs a per-block animated render hook this codebase has no
  precedent for (chunk geometry is static; the book animates per frame), and no
  acceptance-checklist item or gate clause covers it. §2.4's "book floating on
  table" texture row is likewise unused. **The table is fully functional without
  it** — the §2.2 glyph particles that drift from the bookshelves while the UI is
  open ARE implemented, and they aim at where the book would hover.

### Carried forward (found here, not fixed here)

- **`Arrow.serialize` does not carry the bow enchants.** §13 says "stuck arrows
  already aren't persisted (base); no change from flame/punch flags" — so this is
  spec-sanctioned, not a defect. Noted only because a future reader of
  `serialize()` will notice `powerLvl`/`flame` missing.
- **E2's wool-catches gate remains seed-flaky** (E3 logged it). Re-confirmed here
  as pre-existing, not an E4 regression: four consecutive runs against identical
  code gave 24/24, 23/1, 24/24, 24/24, and `src/world/fire.js` is byte-identical
  to `07d9919`. E4's only World.js changes are `setBlock`'s `skipOnBroken` (default
  false → inert unless passed) and `checkFall` forwarding the state nibble (0 for
  sand/gravel → inert). Untouched.

### Verified

**172 browser assertions, 0 console errors** (`scratchpad/e4.cjs`): §2 registry +
id ranges + recipes, §3 XP math incl. the save-refund landmine and a legacy save,
§4 shelf power / offer ranges / purity / enchantability / eligibility, §10
enchanted book incl. Mending-only-via-treasure, §5.1/§5.2 catalog incl. every
cost band and anvil multiplier, §5.4 melee bonuses, §5.5 looting, §5.6 fortune +
silk, §5.7 unbreaking rates, §5.2.1 EPF, §8 anvil incl. all four worked examples,
§9 grindstone, §11 glint, §12 hooks, plus 28 live in-world checks.

Gate items measured — a level-30 offer on a 15-shelf ring (the bottom slot is
exactly 30 across all 3000 seeds); Fortune III on diamond ore over 600 real
breaks averages 2.20 with max 4; Silk Touch lifts glass→glass, stone→stone,
diamond_ore→ore at 0 XP, ice→ice leaving air; Looting III gives flesh 0–5 and
pearls 0–4; Mending repairs 14 durability from a 7-XP orb and banks 0 XP.
A second suite (`scratchpad/e4-gate.cjs`, **25/25**) drives the assigned gate
through the real container screens and the real click path rather than the
modules. **It earned its keep — it caught two bugs 172 module assertions could
not see, both in the seam between the 08 logic and the container framework:**

- **Stale offers after a purchase.** `buyOffer` forced a recompute by setting
  `offerKey = null` — but `null` is *also* the legitimate key of an ineligible
  item, so `refreshOffers`'s `if (key === this.offerKey) return` early-out fired
  and left the purchased item's offers on screen, which §4.5 step 3 forbids.
  (The buttons did correctly disable, so it was cosmetic, not exploitable.)
  Fixed with a `Symbol` sentinel that no key can equal.
- **The anvil/grindstone output slots were never takeable — and would have
  thrown.** They used custom regions (`anvilOut` / `grindOut`), so
  `takeResult` took its *other* branch: `slot.set(null)` (my defs have no `set`
  → TypeError) then `slot.onTakeOut?.()` (I had wired `onCraft`) → the inputs
  would never be consumed. **My own gate test hid this by calling
  `takeAnvilOutput()` directly instead of clicking.** Fixed by using the
  framework's `result` region — the computed-output shape these slots always
  were — whose shift path also correctly refuses to consume when the inventory
  is full. The test now goes through `onSlotClick`.
  A follow-on that surfaced with it: `takeResult` hands the stack to the cursor
  **before** the take handler runs, so an unaffordable/"Too Expensive!" anvil
  result would have been a **free item**. `takeResult` now consults an optional
  `canTake()` first (asserted: cost > 39 yields nothing, keeps both inputs, and
  spends no levels).

Regression: E3 59/59, E2 24/24, E1 audio 35/35, RMB 16/16, in-game 7/7 —
**338 assertions total, all passing**; `npx vite build` clean. (E2 is 24/24 or
23/24 depending on the world seed — see the flake note above.)

## E5 — 07-REDSTONE: power, components, automation (2026-07-18)

Built in an isolated worktree per CLAUDE.md §8.5, branched from `main` (07d9919).
The full redstone layer: the 0–15 power model (§3), dust with the vanilla
connection graph (§4), the event-driven dust solver + delayed-component scheduler
(§5), every component (torch/lever/buttons/plates/repeater/comparator/observer,
§6–§8), pistons (§9), dispenser/dropper/hopper (§10–§11), lamp/note block, and
redstone control of base TNT and doors (§12). Blocks 70–89 (90–104 reserved);
item 342 places wire; no new item ids. New module dir `src/redstone/`.

**Note on branch base:** E5 branched from `main`, which contains E3 but NOT E4
(08-ENCHANTING, on `e4-enchanting`, unmerged). E5 and E4 both touch shared files
(`registry/blocks.js`, `items.js`, `ui/containers.js`, `player/interaction.js`,
`Game.js`, `World.js`, `LightEngine.js`) in different regions; they must be
sequenced at merge time.

### Reused existing hooks instead of adding new callback names (AMENDS 01 §5)

The spec's AMENDS asks for new block callbacks `onNeighborChanged` /
`onScheduledTick`. The codebase already has `neighborUpdate` and `scheduledTick`
serving exactly that dispatch (from `World.neighborUpdates` and `blockTick`), so
redstone components attach to those rather than adding parallel names. New fields
added: `conductive` (§3.2), `onUse` (§6–§12 right-click), `onMoved` (§6.6/§9),
`emissionFor` (state-dependent torch light). Handlers are attached at runtime by
`installComponentHooks()` so `registry/blocks.js` stays a dependency-free leaf.

### Deviations

1. **§4.5 dust rendering — one tinted tile, not 16 power variants.** §4.5 bakes
   16 pre-tinted dust tiles into the atlas. This build ships a single grayscale
   dust tile; the power gradient is not rendered as 16 discrete brightnesses. The
   stored power (states bits0–3) and all LOGIC are exact — only the visual ramp
   is simplified. The custom wire/lever/button/plate/repeater/comparator/piston-
   head/hopper meshes are likewise **approximate boxes** (the logic reads state,
   never the mesh); wall levers/torches render floor-style.
2. **§9.2 piston render — instant move (as the spec's own adaptation allows).**
   No moving-block entity or animation; blocks teleport one cell on the
   completion tick. The spec explicitly rejects animated interpolation.
3. **§6.6 observer state-change detection is scoped.** §6.6 lists observers
   triggering on "any states[] byte change" including crop stage/fluid level.
   `World.setState → onStateChanged → notifyObservers` covers every state change,
   so this is honored — but a state change made by a raw `chunk.states[]` write
   that bypasses `setState` would be missed. All engine paths use `setState`.
4. **§3.2 conductivity defaults from the opaque flag.** As §3.2's own adaptation
   notes, glowstone and redstone lamps conduct here (they are opaque cubes),
   unlike vanilla's transparent classification. Difference visible only in exotic
   builds. Pistons/observer/redstone_block/hopper/glass/leaves opt out explicitly.
5. **§15 recipe substitutions (spec-directed).** Nether quartz → `lapis_lazuli`
   (comparator, observer); slimeball → `sugar` (sticky piston); per §15's
   adaptation, until 10-NETHER supplies the originals. The lamp recipe ships now
   though glowstone is debug-palette-only until 10.
6. **§8 comparator worked-example labels.** The checklist's "6,7,4 → 0" (compare)
   and "5,2,9 → 4" (subtract) are verified as formulas: compare
   `(max(A,C)≤R)?R:0` and subtract `max(R−max(A,C),0)`. For "→4" the subtract
   inputs are (R=9, A=5, C=2). Both formulas are asserted exactly.
7. **Approximate hopper / piston-head collision = full cube**, per §13.2's own
   `(approx)` notes.

### Bugs found by the acceptance harness (all fixed)

The engine test (`scratchpad/e5.cjs`, 37/37) surfaced five real defects during
development, each fixed:

1. **Dust line power output.** A straight-line dust must weakly power the block
   it *points at* (both axis ends), not only its graph connections — else Case A's
   lamp and the block past a diode never powered. `dustOutputDirs` now extends a
   single connection to the full axis (§4.2's "line" rendering).
2. **Fan-out didn't re-solve dust past a conductive block.** When a block's
   strong power changed, adjacent dust wasn't re-solved (the fan-out ran the
   wire's support-check, not a network re-solve). `poke` now queues wire cells
   for re-solve. This was the Case-B failure.
3. **Torch light not seeded on placement.** The torch shares one id for lit/unlit
   with state-dependent emission; `LightEngine.onBlockChanged` read the static
   `emission` (0). Now it consults `emissionFor`, so placing a lit torch lights.
4. **Sticky retract destroyed its own base.** `tryRetract` removes the head via
   `setBlock(air)`, which fired the head's `onBroken` → `headBroken` → broke the
   base. Guarded with a `game.pistonMoving` flag.
5. **Stale per-cell transient state.** `repPending` / `torchOff` / `burnedOut`
   are keyed by cell and were never cleared on break, so a new repeater/torch at
   the same cell inherited a stale latch (a stuck `repPending` suppressed all
   future scheduling). Cleared in the components' `onBroken`. **A genuine engine
   bug, not just a test artifact.**

### The CRITICAL-tier review pass (CLAUDE.md §8.3) — 8 findings, all fixed

A separate Opus subagent audited the tick scheduler and component interactions.
It verified the core (power model, dust solver, re-entrancy/termination, repeater
latch, comparator, piston move transaction, burnout, observer geometry, tick
order) CORRECT by trace, and found 8 defects — all in placement geometry and
container/piston edge cases the state-driven suite didn't reach:

- **HIGH — east/west wall components attached to the wrong cell.** The X-axis
  ATTACH mapping in `redstonePlaceState` was swapped: a lever/torch/button on a
  ±X block face strong-powered the air behind it and popped on the next update.
  (Z-faces, floor, ceiling were fine — a confusing "half my walls don't work".)
- **HIGH — a hopper above a furnace loaded the FUEL slot.** `pushRule` tested
  `hopperFace === 1` for input, but a downward-facing hopper is FACE6 0, so the
  input branch was dead and ore jammed the fuel slot — breaking the canonical
  auto-smelter. Now `=== 0`.
- **MEDIUM — observer double-pulsed.** The "drop triggers while the on-pulse is
  pending" guard was an empty `if`; a trigger on the next tick scheduled a
  duplicate. Now guarded with `hasScheduled`.
- **MEDIUM — breaking an extended piston base orphaned its head.** The base had
  no `onBroken`; mining it left a floating immovable head that survived
  save/reload (violating §9.1/§17). Added a base `onBroken` that removes the head.
- **LOW ×4:** hopper interval was 9 gt not the stated 8 (cooldown 8→7); a
  dispensed TNT deleted whatever block was in the front cell (removed the erase);
  the solver budget was per-call not per-tick (now accumulated across the tick);
  the wooden-button arrow re-poll was 10 gt (tightened to 2).

All four substantive fixes are pinned by regressions in `e5.cjs` (h1_attachX +
h1_powersBlock, h2_hopperToInput, m2_noOrphanHead).

### Verified

**41/41 browser assertions, 0 console errors** (`scratchpad/e5.cjs`): registry +
conductivity (3); §4.3 dust falloff 15→0 (3); §3.6 Case A (weak stops dust, lamp
still lights) + Case B (strong conducts through) (4); §6.4 torch inversion +
light 7 (3); §7 repeater delays 2/8 gt (2); §8 comparator compare/subtract +
live compare + furnace fullness 32→3 / 64→5 (5); §9 piston push-12 / refuse-13 /
immovable / sticky-pull (4); plus the gate circuits — T1 torch light, T3 2×2
sticky door open+close, T4 hopper chain into a chest + lock, T5 comparator
gradient 3→2→1→0, dispenser fires one arrow per edge, note-block 25-click wrap +
instrument-below table, observer pulse.

Gate items measured: a repeater clock's delay is exactly 8 gt; a 2×2 sticky-piston
door seals and re-opens with no lost blocks; a two-hopper chain drains 5 items
into a chest and a powered middle hopper locks; a comparator reads furnace
fullness (32/64 cobble → signal 3). Performance: steady-state tick with 20
redstone circuits ≈ **0.73 ms** total (redstone's share a fraction of that),
inside the §5.5 ≤1 ms budget. `npx vite build` clean.

## E7 — 10-NETHER: the multi-dimension engine (registry + portals + Nether) (2026-07-18)

Built to `10-NETHER.md` §1–§9, §11–§14, §16 **minus the netherite tier (§8) and
minus §10's bartering/huge-fungi content**, which are deliberately deferred (see
below). This file OWNS the dimension engine; 11-END will build the End on exactly
the surface frozen here without editing this module.

### THE DIMENSION CONTRACT (frozen — read before any 11-END / cross-dim work)

`src/world/dimensions.js` is the single definition of the multi-dimension API,
per 10 §2 and CLAUDE.md §8.2's build-order gate. Three public functions and one
data shape; **do not add a fourth entry point, do not reach past `changeDimension`
to move the player, do not mutate a registered descriptor after boot.**

| Symbol | Contract |
|---|---|
| `registerDimension(id, descriptor)` | ids never overlap; 0=overworld, 1=nether, 2=End (11 registers 2) |
| `getDimension(id) → descriptor` | pure data + flags every existing system reads |
| `changeDimension(entity, targetDim, targetPos, opts)` | the ONE teleport door; non-player entities retag+freeze to disk, the local player calls `Game.changeActiveDimension` |
| descriptor `{ hasSkyLight, ambientLight, sky, scale, evaporatesWater, explodesBeds, lavaFast, bedrockRoof, spawnTable, onArrive? }` | the flags read by LightEngine / DayNight / interaction / trySleep / the spawner |

**SINGLE-ACTIVE-DIMENSION model** (10 §2.3's endorsed simplification). One live
`World`/`ChunkManager`/`EntityManager` set. `changeActiveDimension` flushes the
active dim's chunks to disk (dim-prefixed keys), swaps `world.activeDim` +
`world.hasSkyLight`, repositions the player, and re-streams the target through the
LOADING veil. Inactive dimensions live on disk and hydrate on return. In-memory
chunk keys stay **dim-agnostic** (only one dim is ever resident); the dim prefix
is applied ONLY at the save layer. 11-END gets the same API whether or not a
later refactor makes multiple dims co-resident — the public surface doesn't change.

### THE SAVE MIGRATION (v1 → v2, frozen path)

`SAVE_VERSION` bumped 1 → 2 for dim-prefixed chunk keys (`"<dim>:cx,cz"`, via
`saveManager.keyFor`). Per the phase prompt and CLAUDE.md §8.5, `open()` now
**migrates forward instead of nulling `meta`** (the old code discarded the entire
world on any version mismatch, which would have broken every future bump). The
migration clears the chunk store (the overworld regenerates deterministically from
the seed), preserves `meta.player` (inventory + position), sets `player.dimension
= 0`, and seeds `meta.dimensions = {}`. A Nether edit and an Overworld edit at the
same `cx,cz` coexist as separate records because the key is dim-prefixed.

### Amendments applied to the codebase (base specs stay frozen)

- **Registered netherrack (block 115) and the whole §11 block range (115–143)** —
  without netherrack the Nether would generate as air. Item range 390–397 + 409
  (brewing/§9 ingredients) added; netherite items 398–408 left empty for E8.
- **`uDimAmbient` shader uniform** (materials.js §13.1) — a per-dimension ambient
  floor (Nether 0.10) so unlit caverns are dim, not pitch black. `max(light,
  vec3(uDimAmbient))`; overworld leaves it 0.0 so nothing changes there.
- **LightEngine / World sky-light gated on `world.hasSkyLight`** — no-sky dims
  never seed sky light and the bedrock roof can't leak daylight.
- **DayNight per-dimension branch** — no-sky dims render a flat fog void, hide
  sun/moon/stars/clouds, force `uSkyDarken` 0, and drive `uDimAmbient` from the
  descriptor.
- **Ghast fireball made deflectable by extending `LivingEntity`** (§7.3) — a
  fireball is targetable by the melee attack path; its `hurt()` override reverses
  velocity toward the attacker's look and reassigns owner instead of taking
  damage, so a deflected direct hit one-shots the ghast. Elegant reuse of the
  existing attack→hurt plumbing rather than a bespoke ray test.
- **`Mob.fireImmune` flag** — Nether mobs skip the lava/fire/undead-daylight
  environment ticks; the daylight-burn guard also checks `world.hasSkyLight`.

### Deviations (endorsed simplifications, declared not skipped)

1. **Single live dimension instead of `Map<dimId, DimensionState>`.** 10 §2.3
   explicitly allows one resident dimension with the others on disk. The public
   API (registry + `changeDimension`) is identical to the full model, so this is
   invisible to 11-END. Blast radius stayed sane; the deep engine refactor did not
   regress the overworld (regressions below).
2. **Fortress uses a simplified piece placement, not the full corridor grammar.**
   One fortress per 27×27-chunk region (seed-jittered, deterministic across chunk
   borders), built as a nether-brick platform over lava with a blaze-spawner room,
   a fence-caged wart garden, and a loot chest. The §5 room/bridge/corridor
   grammar is condensed to these guaranteed pieces — the gate items (blaze
   spawner, wart garden + chest, cross-border determinism) all hold.
3. **Nether mob AI is goal-based, not full navmesh pathing.** Ghast drift/charge/
   shoot, blaze burst-fire, zombified-piglin anger propagation, magma-cube hop +
   split, wither-skeleton melee+wither, piglin hostility+zombification are all
   implemented with the stat/flag/drop numbers **exact**; the locomotion is
   drift/hop/step rather than A* around obstacles. Meshes are tinted boxes, no
   bespoke skins.

### Deferred (declared, not silently skipped)

- **Netherite tier (§8): entirely E8.** Items 398–408, the smithing-table upgrade
  math, netherite tool/armor stats, and lava-float/fire-survive item behavior are
  NOT built here. The smithing_table block (id in §11 range) and ancient_debris
  ore generate, so E8 has its anchors.
- **Piglin bartering (§7.8).** Piglins are hostile to gold-less players and
  zombify outside the Nether, but the gold-ingot barter → reward table is not
  wired. Deferred with the rest of the piglin economy.
- **Huge crimson/warped fungi (§6).** Crimson/warped forests generate nylium plus
  small fungus/roots cross-plants and shroomlight; the multi-block huge-fungus
  "trees" are not grown. Biome identity + surface still reads correctly.
- **§11 textures are procedural approximations** — all 34 Nether block tiles and 9
  item sprites are painted (no missing-texture magenta in the common view), but
  they are stylistic stand-ins, not pixel-faithful to vanilla.

### Defects found and fixed before landing

- **Save migration crashed on the real v1→v2 path.** `open()` called `migrate()`
  *before* `this.savedChunkKeys` was assigned, and the constructor never
  initialized it — so `migrate()`'s `savedChunkKeys.clear()` ran on `undefined`
  and threw, on exactly the upgrade scenario the phase prompt told me to get
  right. Even past the throw, the subsequent `savedChunkKeys = new Set(oldKeys)`
  would have overwritten the clear with the stale pre-clear keys. Fixed: the
  constructor seeds `savedChunkKeys = new Set()`, and `open()` now assigns the key
  set *before* calling `migrate()` so the clear wins.
- **Duplicate `wood:` material key in blocks.js** — a second `wood:` array would
  have shadowed the first; merged crimson/warped stems+planks into the existing
  array.
- **`ZombifiedPiglin.dropTable` syntax error** and **`GhastFireball` placeholder
  solidity check** — both cleaned up during authoring (malformed ternary; bogus
  `require`/`_solid` block-collision test replaced with the real
  `BLOCKS[...].collidable` lookup).
- **Bed explosion tried a non-existent `explode(...,{fire:true})` option** — the
  signature is `explode(x,y,z,power)`; dropped the fire arg (documented nicety).

### Defects found by the CRITICAL-tier review pass and fixed

A separate Opus subagent audited the dimension API, gen determinism, and the
SAVE_VERSION migration. It confirmed the migration, dim-prefixed round-trip,
`changeActiveDimension`, gen determinism (no `Date`/`random`, disjoint `nether:`
streams, no cross-chunk reads), light gating, portal validation/collapse, and the
chunk-key-collision safety were all correct. It surfaced these real defects, now
fixed:

- **H-1 (HIGH) — a Nether save rebooted into the Overworld.** The player's
  dimension was never serialized/deserialized and `startWorld` never restored
  `world.activeDim` / `save.activeDim` / `hasSkyLight` from the save, so on reload
  `ChunkManager` streamed dim 0, `save.hasChunk` queried the `"0:"` prefix, missed
  every `"1:"` Nether record, and **regenerated the Overworld** — orphaning all
  Nether edits. Fixed: `Player.serialize/deserialize` carry `dimension`, and
  `startWorld` applies the saved dim (world + save + `hasSkyLight`) BEFORE
  streaming. The 33/33 suite missed it because nothing round-tripped a Nether save
  through `startWorld`; **e7review** now does (marker block survives reload).
- **M-2 (MED) — ancient debris lined cavern walls.** The `vein` predicate had two
  identical OR branches and its `replaceAir` param was never passed, so §4.5's
  air-discard was a no-op. Fixed: debris veins now skip any cell touching carved
  air (`exposedToAir`), so debris is fully buried (strip-mine only) — RNG stream
  unchanged, so gen stays byte-deterministic.
- **M-3 (MED) — `meta.dimensions` did not round-trip.** `buildMeta` wrote
  `game.dimMeta` but `startWorld` never restored it, silently dropping the frozen
  contract's per-dim blob (portal links, fortress registry, 11's `endFight`) every
  reload. Fixed: `startWorld` restores `this.dimMeta = savedMeta.dimensions ?? {}`.
- **M-4 / M-5 (MED) — portal pairing.** The destination search was ±16 blocks
  (spec §3.5 requires 128) and the §3.6 link cache was absent, risking portal
  proliferation. Fixed: the search now sweeps loaded chunks within a 128-block
  horizontal radius (direct block-array scan, once per travel), and a §3.6
  `portalLinks` fast-path (stored in `dimMeta`, so it round-trips) records the
  forward link. NOTE: pairing is search-primary with a forward cache — not a full
  bidirectional link registry; return trips rely on the 128-block search (which
  correctly reuses the existing portal).
- **L-6 — misleading sync save + double chunk write** at dim change: `saveAll(...,
  {sync:true})` was ignored (always async) and re-wrote every dirty chunk that
  `flushAllChunks` also wrote. Reordered: `flushAllChunks` (durable via
  `saveChunkNow`) first, then a single meta-only checkpoint after the swap.
- **L-8 — Nether/End music never selected.** The mood selector read the
  renamed-away `world.dimension`; now reads the numeric `world.activeDim` (1→
  nether, 2→end).
- **L-9 — heightMap type mismatch.** The Nether returned a `Uint16Array`; every
  other producer uses `Uint8Array`. Aligned (values ≤ 127).
- **L-7 — already fixed** independently this session before the review ran (the
  `savedChunkKeys.clear()`-then-overwrite ordering — see "Defects found and fixed
  before landing" above).
- **Secondary — bare biomes.** `decorate` only swapped the top block. Added
  deterministic surface scatter (crimson/warped roots + fungus + shroomlight
  accents, soul-sand-valley bone fossils) so each forest reads distinctly; the
  multi-block huge fungi stay deferred.

### Verified

- **e7core 20/20** (registry API + descriptors, deterministic gen with bedrock
  floor/roof + netherrack body + carved caverns + lava sea, fortress blaze
  spawner + block-entity record, **all 3 migration assertions**, portal frame
  validation + fill + dim swap + safe landing + cooldown), **e7gate 13/13** (mob
  roster flags, ghast-fireball deflect reverses/reassigns/no-damage/explodes, bed
  explodes in the Nether, water evaporates in the Nether), and **e7review 12/12**
  (H-1 Nether save round-trips through `startWorld` with the edit intact, M-2 no
  debris exposed to air across sampled chunks, M-3 `dimMeta` round-trips, overworld
  reload control) — headless swiftshader against the e7 dev build.
- **Regressions clean** after the engine refactor: verify-ingame 7/7, audio 35/35,
  verify-e2 24/24, `npm run build` green.

## E3 — 08-ENCHANTING part 1: the `tags` contract, sweep attack, offhand (2026-07-17)

Built to `08-ENCHANTING.md` §1, §6, §7, §12 (the sweep hook), §13. **§2–§5 and
§8–§11 are E4's and are deliberately not built** — no enchanting table, anvil,
grindstone, catalog, enchanted book or glint exists yet.

**Registry footprint: ZERO.** E3 allocates no block id, no item id, no state bit.
08's range (blocks 105–109, items 346–369) stays empty until E4. The one shared
namespace addition is §12's `player.attack.sweep` sound event. 15's bit-7
contract is untouched — E3 introduces no block states at all.

### THE `tags` CONTRACT (frozen — read before any 09/10/11/12/13 work)

`src/items/tags.js` is the single definition, per 08 §1's "**This section is the
single definition used by all expansion files (07–16).**" and CLAUDE.md §8.2's
build-order gate. The module header carries the schema, the five invariants and
the reserved-key note. Consumers: **do not redefine the shape, do not compare
tags with JSON.stringify, do not spread a stack.**

| Key | Owner | Status at E3 |
|---|---|---|
| `enchants: [{id,lvl}]` | 08 §5.1 | container shape frozen; ids arrive in E4 |
| `name: string` | 08 §8.4 | frozen; written by E4's anvil |
| `anvilUses: uint8` | 08 §8.2 | frozen; written by E4's anvil |
| `potionId: uint8` | **09-POTIONS** | key reserved, no shape, no code |
| `containerItems` | **11-END** (inferred) | reserved only — see the ruling below |

### Deviations

**1. `containerItems` is reserved, not defined — CLAUDE.md §8.2 and 08 §1 conflict.**
§8.2 describes 08's schema as "(enchants / **containerItems** / potionId)", but
08 §1 does not define `containerItems` at all. 08 §1 is the owning text and says
"**This section is the single definition**"; §2 precedence puts the owning
expansion's body above the orchestration doc's prose. On the evidence it is
11-END's shulker box. **Ruling:** reserved in `RESERVED_KEYS` and named to
11-END, arriving via §1's own forward-compat clause ("future keys may be added
by other expansion files; unknown keys must be preserved on load/save") — exactly
how §1 treats `potionId` as 09's. 08 defines no shape and writes no code for it.
Unknown keys are provably preserved through clone, merge-compat and save/load
(tests `t_unknownPreserved`, `t_neqUnknown`, `p_offhandTagsRoundTrip`), so 11 can
land its shape without touching this module. **11-END must not assume 08 defined it.**

**2. F-swap mid-bow-draw: 08 §7.2 and AMENDS 03 §3 contradict each other.**
§7.2: "Swapping counts as a main-hand item switch → resets the attack-charge
timer t and cancels an in-progress bow draw or eat on either hand." AMENDS 03 §3:
"F is **ignored** while an item-use channel is active mid-bow-draw (draw cancels,
no arrow fired)." One says the swap happens and cancels the draw; the other says
F is ignored. Both are 08, so §2 precedence cannot separate them. **Ruling:** the
only reading that leaves both sentences true — mid-bow-draw, F cancels the draw
(no arrow) and does **not** swap; mid-eat, F cancels the eat **and** swaps.
Implemented in `Interaction.swapOffhand`. Java would swap in both cases; the
AMENDS note is the more specific and unambiguous statement about the observable
outcome, so it wins for the bow. Revisit if E4 finds a third statement.

**3. Entity interaction (feeding/shearing) sits outside §7.3's step list.**
§7.3 is declared "the single **canonical** RMB step list" and begins at the block
raycast; it never mentions entities. The shipped code interacts with the nearest
entity on the ray before anything else (03 §16.1). Kept as-is — ahead of step 1,
main-hand only — rather than dropped or renumbered, since deleting it would break
feeding/shearing and §7.3 gives no instruction either way. Offhand entity
interaction is not implemented (vanilla has it; §7.3 does not ask for it).

**4. §7.3's step order fixed a live bug: carrots and potatoes could never be planted.**
Items 315/316 carry **both** `kind:'food'` and `plantsCrop`. The shipped `use()`
ran place → food → … → `plantsCrop`, and the food branch returned
unconditionally, so the `plantsCrop` branch was unreachable for the only two
items that are both. §7.3's canonical order puts block-targeted uses (step 2)
**before** self-use (step 4), which makes a carrot plant on farmland and feed the
player anywhere else — vanilla's `useOn` → PASS → `use()`. This is a **behavior
change against shipped v1**, caused by applying the spec. Verified both ways
(`r_carrotPlants`, `r_carrotEatsOnStone`). Consequence: the step-2 helpers
(`plantSeed`, `useHoe`, `useBoneMeal`, `useFlintSteel`, `useBucketEmpty`,
`useBucketFilled`) now return a boolean "did it perform" — a wrong return there
either swallows the press or leaks it to the offhand.

**5. `game.hud` never existed — three calls were silently dead.**
The HUD lives at `game.ui.hud` (`main.js:100`). `interaction.js` called
`this.game.hud?.onHotbarChange?.()` at three sites; the optional chain swallowed
it, so the item-name popup (06 §15.2) has never fired on a hotbar switch in the
shipped build. Repointed to `game.ui?.hud?.…`, which resurrects that popup —
a **visible behavior change** beyond E3's scope, but the alternative was to copy
a known-dead call into the new F-swap path. `ItemEntity.js:168`'s
`game.hud?.flashPickup?.(…)` is left alone: `flashPickup` is not defined on `Hud`
either, so it is doubly dead and belongs to whoever writes that method.

**6. Six stack-copy sites shared their `tags` object (08 §1 rule 4).**
`{...stack}` is a shallow copy, so a split/drop left both halves pointing at one
tags object — a later anvil rename on one would silently rewrite the other. Found
and fixed at `Game.js` ×2 (`dropStackAt`, `throwStack`), `containers.js` ×3
(shift-click leftover, right-click split-half, right-click place-one),
`interaction.js` ×1 (`dropHeld`, which additionally **dropped tags entirely** —
Q on an enchanted sword returned a plain one). All now route through
`cloneStack`/`withCount`. Regression-tested (`t_deepClone`, `m_giveClones`).

**7. `pickBlock` compared tags with `JSON.stringify` (18 §5.4).**
Key order makes stringify report equal objects unequal and vice versa — the exact
anti-pattern §1 rule 5 forbids. Inert today (18's `pickTags` hook returns
`undefined` for every block, deliberately, pending 08), but it must not be the
pattern E4 copies. Switched to `tagsEqual`. **18's `pickTags` hook is now
unblocked** — it deferred explicitly "until 08 lands" and can be wired whenever
someone owns that decision; E3 did not, as it is 18's call, not 08's.

**8. Sweeping Edge is hardcoded to level 0 until E4.**
§6.3's `ratio = sweepingEdgeLvl/(sweepingEdgeLvl+1)` needs the enchant's catalog
id from §5.1, which is E4's. `sweepLvl = 0` → ratio 0 → `sweepDmg` is exactly 1,
which is precisely §6.3's own reference number ("plain iron sword → 1 HP to
victims"). The seam is one line, marked, and named in a comment
(`getEnchantLvl(p.heldStack, ENCH.SWEEPING_EDGE)`). The acceptance line "Iron
sword + Sweeping Edge I deals exactly 4 HP to secondaries" is **E4's to close**.

**9. The acceptance checklist's "1 HP" is pre-armor.**
"all zombies … flash red for **1 HP** (plain sword)" — §6.3 says victims take
`sweepDmg` "through the normal `hurt()` pipeline", and zombies carry
`naturalArmor = 2`, so 05 §14.2's armor formula lands 0.94 HP, not 1.00. The
sweep damage handed to `hurt()` **is** exactly 1. Tested both ways
(`s_secondaryRawDmg1`, `s_secondaryAfterArmor`); not a code deviation, but the
checklist line reads as an HP delta and is not one.

### Defects found by the CRITICAL-tier review pass and fixed

A separate Opus review subagent audited the frozen contract + the combat and
offhand changes (CLAUDE.md §8.3: the check must not be run by the context that
wrote the code). It cleared §6's formulas and ordering, §7.3's pipeline, rule-4
aliasing across the whole tree, and every E3 amendment, and found six defects —
all fixed, all regression-tested.

1. **HIGH — `tagsEqual` silently returned `true` for ANY two bare tags objects.**
   The frozen §1 helper list names this one `tagsEqual(a, b)` while every sibling
   says `stack`, so a downstream author reading the spec writes
   `tagsEqual(a.tags, b.tags)` — and `.tags` on a tags object is `undefined`,
   collapsing both sides to null and returning **true for every pair**. Proven by
   execution: a Sharpness V sword compared equal to a vanilla one, and
   `{potionId:7}` equal to `{potionId:9}`. Failure scenario: 09 implements potion
   stack-compat per §1's literal signature and every potion merges with every
   other — no error, no warning, on a contract frozen for five files. **Fixed** by
   accepting both call shapes (`asTags`); a frozen contract must not answer
   wrongly in silence. This was the highest-blast-radius item in the phase and
   testing had not caught it.
2. **MEDIUM — a failed main-hand throwable PASSED to the offhand.** `throwHeld`
   returns false when an ender_pearl is on cooldown, which `useSelf` propagated
   as PASS. Repro: pearl in main, torch in offhand, hold RMB → the offhand placed
   ~5 torches across the 20-tick cooldown. §7.3: "a failed main-hand action …
   still consumes the attempt and blocks the offhand that press" — a cooldown is
   a failed action, not "no action". **Fixed**; the food-at-20 and failed-place
   cases were already correct.
3. **LOW-MEDIUM — step 2's `hand` parameter was a decoy.** `useOnBlock(hand, hit)`
   read `itemIn(hand)` but every helper it dispatches to spends the MAIN hand
   unconditionally (`consumeHeld`/`damageHeld`/`heldStack`). Correct today (step 2
   is main-only and only ever called with `'main'`), but §7.3 explicitly invites
   **12 §7.1's shovel→dirt_path at step 2b** — and 12 is being built now. The
   first caller to pass `'off'` would read one hand and consume the other, with
   no test failing. **Fixed** by removing the parameter, so the signature stops
   advertising a capability it does not have. Steps 3–4 were confirmed fully
   hand-threaded.
4. **LOW — dead `'debugCreative'` guard.** `p.gameMode !== 'debugCreative'` in
   `tryPlace` survived the string→`GameMode` int-enum migration; both `0` and `1`
   are `!== 'debugCreative'`, so the guard was always true and did nothing. Inert
   only because `consumeIn` re-checks creative internally. It read as a live
   guard, so anyone "fixing" it while refactoring `consumeIn` would get infinite
   block depletion in creative. **Removed**; 18 §5.3's choke point holds it.
5. **LOW — `cloneTags` propagated a malformed `{enchants: []}`.** Unreachable via
   the module's own API, but `cloneStack` is the documented one-true-way to copy
   a stack and would carry a hand-edited-save/`direct-build` violation forward
   forever — and it is *invisible*: `hasTags()` says tagged, `tagsEqual()` says
   vanilla. **Fixed**: `cloneTags` now heals invariant 2 at the choke point, and
   `setEnchant(…, 0)` prunes a pre-existing empty `{}`.
6. **LOW (latent) — four stack spreads left in `containers.js`.** None live
   defects (each aliased object was either handed to a now-cloning `throwStack`
   or was the last surviving reference), but they contradict `tags.js`'s own
   header six lines from the correct helper, and two of them are exactly where
   **E4's anvil output will flow**. **Fixed** to `withCount`/`cloneStack`.

The reviewer also noted §12 names the durability hook `item.break` while the code
emits 16-AUDIO's pre-existing `player.item_break` at the right trigger. 16 owns
the sound namespace (CLAUDE.md §3), so the existing name stands — not a defect.

### Not an E3 regression: E2's wool-catches gate is seed-flaky

`verify-e2`'s "a wool floor CATCHES" gate asserts `peakFire >= 3` on an
RNG-driven spread with a **random world seed per headless run**. Observed peaks
across 5 runs: **1, 1, 1, 3, 8** — it fails ~60% of the time. Its companion
assertion ("burns out: fuel consumed, no fire left") passes even at peak 1, so
fire genuinely spreads and consumes. **E3 cannot be the cause:**
`src/world/fire.js`, `src/world/World.js` and `src/registry/blocks.js` are
byte-identical to the E2 commit `9a953c8` (`git diff --quiet 9a953c8 --` is
clean), and E3 touches no fire, world or fluid code. The exact driver is not
pinned (a quick repro at distant coords failed to load chunks; it is not rain —
`raining` was false on a failing run). **Left for E2's owner**: the gate should
pin a seed or measure a distribution rather than threshold one sample. Flagged
rather than "fixed" by loosening someone else's assertion.

### Carried forward to E4 (found here, not fixed here)

- **The XP model contradicts §3.2.** The spec assumes a single scalar
  `player.xp`; the code keeps `xpLevel` + `xpPoints` + `xpTotal`, so §3.2's
  `subtractLevels` cannot be dropped in as written.
- **Latent save bug.** `Player.serialize` writes `xp: this.xpTotal` (lifetime)
  and `deserialize` replays it as *current* XP. Harmless today; the moment E4's
  enchanting **spends** levels, a reload hands them back. Untouched by E3 — no
  E3 path spends XP — but E4 must fix it before the table ships.
- **`durability` vs `damage` are inverted** relative to §8.3/§5.8's pseudocode
  (spec: remaining; code: damage counting up). Every anvil/grindstone/Mending
  formula must be mapped, not transcribed.

### Verified

59 browser assertions, 0 console errors (`scratchpad/e3.cjs`): the §1 contract
(14), the 9 review-finding regressions, stack-compatibility (3), F-swap + §7.4
ammo order (7), the §6 sweep (12), §7.3's two-hand pipeline + §7.5 HUD +
persistence (12), the carrot regression (2).
Gate items measured — a plain iron sword at full charge, standing, hands 1.0
sweep damage to every zombie in the halo and none to one 5.5 blocks away, fires
the arc particle once and the `player.attack.sweep` hook, and pushes all victims
along the look direction (vel.x > 0.15, |vel.z| < 0.1); sprinting, falling, an
axe, sub-0.848 charge and 0.30 b/t movement each correctly refuse to sweep while
walking at 0.10 b/t sweeps; F swaps both ways and zeroes the charge timer;
pickaxe main + torch offhand places the torch from the offhand; offhand bread is
eaten out of the offhand only when the main hand has no use. Regression: E1 audio
35/35, E2 24/24, RMB 16/16, in-game 7/7 — 132 assertions total, all passing.

## EC — 18-CREATIVE: game mode, flight, instant-build, creative inventory (2026-07-17)

Built to `18-CREATIVE.md`. **Registry footprint: ZERO new block ids, ZERO new
item ids, no `states` bit, no effect/dimension id** — verified by a registry dump
(blocks 0–66, items ≤ 345, unchanged). The only additions to any shared namespace
are §8's two `ui.*` sound events. 15's bit-7 contract is untouched.

New module: `src/ui/creativeTabs.js` (the §6.2 tab set + classifier). The screen
itself lives in `containers.js` per AMENDS 01 §15.3.

### Amendments applied to the codebase (base specs stay frozen)

| AMENDS | Applied as |
|---|---|
| 01 §16.1 | `gameMode` is the integer enum `{SURVIVAL:0, CREATIVE:1}` (`constants.js`); `normalizeGameMode()` migrates legacy `"survival"→0`, `"debugCreative"\|"creative"→1`, missing→0. `SAVE_VERSION` deliberately **not** bumped — §1.2 says the format is unchanged, and the migration is value-keyed |
| 01 §15.1 | `KEYBINDS.debugMode` → `KEYBINDS.gameMode` |
| 01 §15.3 | F3 gains a `gameMode survival\|creative` line; the creative inventory is a `PLAYING_UI` screen in `containers.js` |
| 03 §2.4 | `gameMode` enum; `flying` forced `false` in `deserialize()` and on any switch to survival |
| 03 §3 | `Space` double-tap toggles flight in creative (was `debugCreative`) |
| 03 §20.2 | `beforeHurt` early-outs on `creative && source !== 'void'`; `applyKnockback` overridden to early-out (§4.4) |
| 03 §21 | Retitled to Creative mode: instant-break gains the 6-tick hold cooldown + the hardness-−1 carve-out; flight auto-cancels on the ground; §1.4 resets; reach stays 5.2 |
| 03 §23 | Badge is `CREATIVE` (`#mode-badge`); `hud.rebuild()` hides hearts/hunger/air/XP, keeps crosshair + hotbar |
| 05 §5 | `Mob.updateTarget` rejects a creative candidate **and** drops an existing creative target in the give-up branch; `Mob.onHurt` skips the retaliation clause for a creative attacker; Enderman's stare + damage provocations both guarded |
| 06 §14.2 | Pick-block active whenever creative (§5.4); source stacks not decremented on place/use |
| 06 §15.4 | The F4 debug palette is **deleted** from `menus.js`, replaced wholesale by §6's creative inventory |
| 06 §15.1 / §12 | Hunger/saturation/exhaustion frozen; survival HUD hidden; eating is an explicit no-op |
| 06 break/drop path | `breakBlock(x,y,z,{drops,xp,durability})`; creative passes all three false. Container spill is unaffected — it lives in `World.setBlock` |
| 16 §3 | `ui.gamemode.switch` + `ui.item.destroy` registered on the `ui` bus |

### Deviations

1. **F4 is read from the input snapshot inside `player.tick()`, not from
   `main.js`'s `onKeyEdge`.** §1.4 requires the switch to land "inside
   `player.tick()`, **before** the movement branch". The keydown listener fires
   mid-frame and would flip `flying` and the damage guard partway through a
   tick's own movement/damage pass. Consequence: F4 does nothing while paused or
   with a screen open, because `Game.tick()` feeds `NEUTRAL_FRAME` in those
   states. That is arguably more correct, but it *is* a behaviour change from the
   old always-on debug toggle.
2. **Sprint-fly FOV is 1.21 `(approx)`.** §2.3 says flying is ×1.10 and
   "increased further when holding sprint" without a number; 1.10² is the natural
   reading. The pre-existing expression was
   `(sprinting || (flying && sprinting)) ? 1.10 : 1.0`, whose second arm is
   subsumed by the first — flight FOV was identical to walking. Now fixed.
3. **Flight's ground-cancel is gated on a downward move.** §2.4's headline is
   "if `onGround` becomes true while `flying`, set `flying = false`", but its own
   next sentence says "on a downward move". The headline alone is unimplementable:
   the tick a double-tap *enables* flight from a standing start, `onGround` is
   still true, and flight would cancel before it began. Gate: `onGround && pos.y < y0`.
   Side effect: a creative player hovering exactly at ground level keeps flight,
   where Java would cancel it.
4. **Ctrl+pick-block's `tags` copy is a declared no-op stub.** §5.4 asks Ctrl to
   "copy the block-entity/`tags` payload (08's `tags`…)". 08-ENCHANTING owns that
   schema and CLAUDE.md §8.2 freezes it **before** consumers build against it —
   18 §0 says this file "only reads it". So `Interaction.pickTags()` exists as the
   hook and returns `undefined` for every block; inventing a shape here would be
   18 defining 08's frozen contract. **The §9 line "Ctrl+pick copies the block's
   `tags`/state" therefore passes only for state and not for tags** — see Deferred.
   Non-Ctrl state *does* work: §5.4 expresses state through item choice (a lit
   furnace picks `furnace`, a wall torch picks `torch`), which is implemented and
   tested.
5. **Buckets: the source stack is untouched, diverging from MC.** §5.3 names
   "buckets (06 §6.4)" under "Consumption does not deplete" and states the rule as
   "using any item in creative leaves the source stack untouched". Taken
   literally: a water bucket stays filled after pouring (matches MC), *and* an
   empty bucket stays empty after scooping (MC would hand you a filled one). The
   literal reading won because it is the spec's own stated rule; creative players
   take filled buckets from the palette. Not covered by §9's checklist either way.
6. **Arrows must still be present to fire a bow, they are just not consumed.**
   §5.3 does not mention arrows. `takeItem` now returns `hasItem` in creative —
   removing the depletion without inventing "shoot from an empty quiver", which
   is a behaviour §5.3 never grants.
7. **Weapons are classified before tools.** §6.2's pseudocode tests
   `entry.toolClass` first, which assumes `toolClass ∈ {pickaxe,axe,shovel,hoe,
   shears}`. This registry also files swords under `toolClass` (`items.js:93`), so
   the spec's own order puts every sword in **Tools** and contradicts tab 5's
   stated contents ("swords, bow, arrow…"). The tab tables win.
8. **TNT is routed to Combat by an explicit `COMBAT_BLOCKS` set.** §6.2 tab 5
   lists TNT, but the block branch of the classifier has no rule that reaches
   Combat — TNT would fall through to Building.
9. **Empty tabs are hidden, not rendered.** §6.2 defines ten tabs, but 07's
   Redstone and 09's Brewing enumerate ids that do not exist yet. A tab appears
   exactly when its registry range is populated, so Redstone/Brewing will light up
   at E5/E9 with no code change. Today: 8 tabs (Building, Decoration, Tools,
   Combat, Food, Misc, Search, Survival Inventory).
10. **The creative screen uses its own 196×218 reference panel**, not the survival
    176×166 one, which cannot hold a tab strip + a 9×5 palette + 27+9 personal
    slots + a destroy slot. All slot geometry keeps the 18-px pitch and `--gpx`
    scale. The Survival-Inventory tab renders 06 §14.1's exact layout, offset
    clear of the tab strip.
11. **Palette cells hide their stack count.** §6.3 is silent; 45 cells each
    reading "64" reads as inventory the player owns. Matches Java.
12. **`consumeHeld` is the single choke point for §5.3**, rather than a guard at
    each of the seven call sites. (Since superseded by 08's `consumeIn(hand, n)`
    refactor, which preserved the creative early-out.)

### Deferred (declared, not silently skipped)

**§5.4's Ctrl+`tags` copy** — blocked on 08-ENCHANTING's `tags` schema by design
(deviation 4). `Interaction.pickTags()` is the wired hook; it needs one line once
08 freezes. Until then Ctrl+pick behaves as a clean pick.

**§1.3's `/gamemode` command** — §1.3 itself makes this conditional ("if a chat/
command input exists… 14 adds one") and says "do **not** invent a bespoke console
for this file". `Player.pendingGameMode` is the seam 14 will set.

### Verified

**68 browser assertions, 0 console errors** (headless Chromium, dev server),
covering every §9 checklist line. Highlights, measured:

| Gate | Measured |
|---|---|
| walk-fly / sprint-fly | 10.67 / 21.34 m/s (spec 10.89 / 21.78) |
| FOV | ground 1.000 → fly 1.100 → sprint-fly 1.210 |
| Ground-cancel | flight off 13 ticks into a descent, `onGround` true |
| Damage immunity | 11/11 sources nulled (fall/drown/fire/burn/lava/suffocate/starve/melee/arrow/explosion/cactus); void still takes 4 |
| Knockback | melee \|v\|=0; point-blank creeper-power explosion \|v\|=0, hp 20 |
| Instant break | 0 drops, 0 orbs, 0 tool damage, crack stage −1 |
| Hold cooldown | gaps `[6,6,6]` held; `[1,1,1]` re-clicking |
| Unbreakable | bedrock/water/lava all survive |
| Chest spill | 2 stacks ejected |
| Infinite place | a stack of **1** placed 6/6, count still 1 |
| Palette coverage | **146/146 ids, 0 duplicates, 0 unreachable** |
| Scrolling | Search's 146 ids page 45 at a time, maxScroll 12 |
| Save | `gameMode` round-trips as int 1; legacy `debugCreative`/`creative`→1, `survival`/missing→0 |
| Registry | blocks 0–66, items ≤345 — **zero allocated** |

Survival regression re-run in the same suite: reach 4.5, mining not instant,
drops + durability intact, placement depletes, damage + knockback land, `E` opens
the survival inventory.

## E2 — 15-FIRE-WATERLOGGING: fire spread + the global bit-7 allocation (2026-07-17)

Built to `15-FIRE-WATERLOGGING.md`. **CRITICAL tier: this phase allocates the
global `states` bit 7 = waterlogged. That layout is now FROZEN — every later
block-state consumer must honor it.**

### THE BIT-7 CONTRACT (frozen — read before touching any block state)

Written at the head of `src/registry/blocks.js`, where every state consumer will
see it. Verbatim rules:

```
bit 7 (0x80) of every voxel's `states` byte = WATERLOGGED. Owned by 15 for every
block in the game; NO other file may assign it.
Per-block nibble meanings occupy bits 0-3 ONLY. Bits 4-6 remain free.
```

Invariants, each enforced in code and pinned by a test:

| Invariant | Where it lives |
|---|---|
| `setBlock` CLEARS bit 7 whenever the new id is not `waterloggable` | `World.setBlock`, **before** the no-op early-return |
| A bit-7 cell IS a water source for EVERY system | `isWaterCellAt` / `isWaterSourceAt`, exported from the registry |
| Nibble reads MUST mask (`state & 0x0F`) | `Fluids.isSource` — a bare `state === 0` is the bug that deleted fences |
| Toggling bit 7 runs the light edit AND neighbor updates despite an unchanged id | `World.setBlock`'s `waterlogFlip` |
| Removing a bit-7 block leaves a water SOURCE, never air | `World.clearedCell`, used by every erase path |

The API later phases should use: `WATERLOGGED`, `STATE_NIBBLE`, `isWaterCellAt(id, state)`,
`isWaterSourceAt(id, state)`, `effFireEnc/effFireBurn(id, state)`,
`world.isWaterCell/isWaterSource(x,y,z)`, `world.setWaterlogged(x,y,z,on)`,
`world.clearedCell(x,y,z)`.

### Amendments applied to the codebase (base specs stay frozen)

| AMENDS | Applied as |
|---|---|
| 06 §5.14 | fire's registry entry now delegates to `world/fire.js`; the "never spreads" stub is gone |
| 06 §5.6 | fire no longer primes TNT on placement — only when `tryBurn` CONSUMES it (burn 100, fuse 80) |
| 06 §1 | the bit-7 contract block in `blocks.js` |
| 06 §6.1/§6.2/§6.3 | `Fluids`: `isSource` masks the nibble; `strength` returns 8 for bit 7; `adjacentSources`/`solidOrSource` count bit-7 cells; `checkInteractions` treats a bit-7 neighbor as water |
| 06 §5.11 / §5.9 | farmland moisture and sugar-cane support use `isWaterCellAt` |
| 06 §17 | fire scheduled tick (30+rand(10)); lava randomTick → fire attempt; fire survival on neighbor update |
| 01 §5 | registry gains `fireEnc` / `fireBurn` / `lavaIgnite` / `waterloggable` / `infiniteBurn` |
| 01 §4.6 / §4.2 | `setBlock` relights on a bit-7 flip; `terminatesSky(id, state)` terminates the heightmap on a bit-7 cell |
| 01 §8.1/§8.4 | mesher's same-fluid water test is `isWaterCell`; §12 dual emission |
| 03 §10 | `overlapsFluid` (the single writer of `inWater`, player AND mobs) and `eyeSubmerged` use bit 7 |
| 03 §16.2 | placement into a water source waterlogs; breaking a bit-7 block leaves a source |
| 04 §8 | `LightEngine.opacity` = `max(opacity(id), bit7 ? 1 : 0)` |
| 04 §12.6 | lightning → `lightningIgnite`: canSurvive + 4 extra ±1 attempts, origins registered |
| 05 §12 | per-cell blast resistance = `bit7 ? max(blast, 100) : blast` |

### Deviations

1. **`BLOCKS[id].skyOpacity` does not exist.** AMENDS 01 §4.6/§4.2 specifies
   `max(BLOCKS[id].skyOpacity, bit7 ? 1 : 0)`. This codebase has no such field —
   the heightmap predicate is `terminatesSky(id)` in `LightEngine.js`. The
   amendment lands as `terminatesSky(id, state)` instead. The gen-side heightmap
   (`features.js`, in the worker) stays id-only and still agrees, because
   worldgen never emits bit 7.
2. **`LightEngine.onBlockChanged` gained `oldState`/`newState` params.** It
   derived everything from `BLOCKS[oldId]`/`BLOCKS[newId]`, so a waterlog toggle
   (same id) compared `oldB === newB`, every opacity test read false, and it did
   **no light work at all**. Bit 7 is unexpressible in an id-only signature.
3. **The fire-origin map is keyed by string, not bit-packed.** §6 says
   `packedPos(x,y,z)`. World coords span ±1e6 (01 §4), so packing x/y/z into one
   JS number overflows `Number.MAX_SAFE_INTEGER` and silently aliases distant
   fires onto each other — in a *safety valve*. The map holds ≤ 512 entries and
   is touched once per fire tick (every 30-39 t); correctness wins.
4. **`world.igniteTnt` is called for fire-consumed TNT** rather than a local
   `primeTNT` (§2.5). Same thing: `igniteTnt(x, y, z, 80)` is the base's single
   prime choke point and already carries the §3.5 fuse loop from E1.
5. **The MAX_ACTIVE cap gates the new fire but NOT the fuel; the RADIUS cap gates
   both.** §6.3 folds both into one `fireBudgetAllows` and says a failure must not
   consume the fuel — but §6 also promises a direct ignition "can't cascade
   further **until the count drops**", and with fuel never consumed at the cap the
   count *cannot* drop: on a wool field §2.4a returns early (flammable neighbor)
   and §2.4b never fires (the floor is fuel), so 512 fires would burn eternally
   and nothing could ever spread again. That is a deadlock, not the "plateaus
   ≤ 512" the acceptance list describes. §6.3's "don't consume" rationale is
   explicitly spatial — "the fire front stalls instead of silently deleting the
   world edge" — so it is scoped to `RADIUS_CAP`; the concurrency cap withholds
   only the fire (§6: "MAX_ACTIVE only gates new spread fires"), letting the
   cascade drain. Found by the review.
6. **`HUMID_BURNOUT_BIOMES` = `{SNOWY_TUNDRA, MOUNTAINS}`** by id from
   `biomes.js`, per §2.6's own adaptation note (02 has no jungle/swamp).
7. **Fire's rolls use `Math.random()`, never `world.rng`.** §2's note permits it,
   and it is load-bearing: `world.rng` is a seeded stream shared with weather and
   worldgen, so drawing fire rolls from it would desync the simulation.
8. **`§7 rendering (4-frame animated tiles) is NOT implemented in this pass.**
   See "Deferred" below — it is the one acceptance item outstanding.

### Defects found and fixed before landing

- **A waterlogged fence deleted itself on its first fluid tick.** `isSource(state)`
  was a bare `state === 0`; a bit-7 fence (`0x80`) read as non-source, entered the
  re-derive branch, and hit `best <= 0 → setBlock(AIR)`. Found by the scout, not
  by testing.
- **A waterlogged cell spread FENCES.** The spread branch passes the current
  cell's `id` to `setFluid` — for a bit-7 fence that replicated fences sideways
  and downward. Now spreads `B.WATER`.
- **`blockTick` never routed a waterlogged cell to `fluids.step`** (its id has no
  `.fluid`), so its water could never spread at all.
- **The fire-origin map leaked on five removal paths.** §6.4 requires *any*
  removal to drop its entry, but fire is removed by water flowing in, punching,
  explosions, block placement and the engine itself — only the last called
  `forgetFire`. A leaked map silently starves `MAX_ACTIVE` until nothing may
  spread. Now hooked in `World.setBlock`, the one chokepoint every write funnels
  through. `forgetFireInChunk` was also never called; now wired to
  `Game.onChunkUnloading` per §6.4.
- **§6.3's stall rule was inverted.** The budget check sat inside the placeFire
  condition, so an out-of-leash fuel block still burned away. The gate now
  precedes the branch: the front stalls without consuming fuel.
- **`world.popBlock` / `removeBlock` erased waterlogged cells to air**, silently
  contradicting §10.6 — a support-pop would drink the lake even though
  `breakBlock` did it right. Both now route through `World.clearedCell`.
- **The creative insta-break bypassed `breakBlock`** and had the same bug.
- **Farmland and sugar cane used a bare `=== B.WATER`** (§13.4), so a waterlogged
  fence irrigated nothing.
- **Flint & steel could only light the TOP face** and tested `isSolidSupport`
  rather than §1.2's `canSurvive` — you could not light a wooden wall from the
  side, which is exactly what `anyFlammableNeighbor` exists for.
- **Lightning used a strict subset of `canSurvive`** (`isSolidSupport` only), made
  no extra attempts, and bypassed the origin map.
- **`Game.explode` read the cell state six lines AFTER the blast-resistance gate**,
  so §13.6 needed the read hoisted.

### Defects found by the CRITICAL-tier review pass and fixed

A 3-dimension Opus review (bit-7 contract / fire engine / Part-B integration),
each finding then put to an independent refuter. Confirmed and fixed:

- **A waterlogged ladder popped itself within ~5 ticks.** `ladderNeighbor` read
  the RAW state as a `WALL_DIR` key; a bit-7 ladder is `0x81`–`0x84`, `WALL_DIR`
  has keys 1–4, so the lookup returned `undefined` and the `?? WALL_DIR[1]`
  fallback probed the *wrong wall* — found no support and destroyed the ladder.
  This is precisely the "bare state read" the contract exists to prevent, and it
  landed in the one wall-mounted waterloggable block. Every `WALL_DIR` lookup now
  masks the nibble.
- **§2.4/§2.5/§2.6 were driven by the post-aging `newAge`.** The spec binds
  `newAge` for the state write and uses the PRE-tick `age` for every decision —
  deliberate, and vanilla (`FireBlock#tick` stores `j` but passes `i` to
  `checkBurnOut` and the spread odds). My first pass called this a spec
  inconsistency and used `newAge` throughout, which shifts every fire probability
  on the ~1/3 of ticks that bump the age. The reviewer was right and that
  "deviation" is withdrawn.
- **Water directly under any waterlogged cell blinked out every 5 ticks.** The
  re-derive branch's `fromAbove` feeder test was a bare `.fluid` compare, so a
  bit-7 cell above did not count as a feeder; the cell below found none, hit
  `best <= 0` and deleted itself.
- **The MAX_ACTIVE deadlock** (deviation 5 above).
- **`ChunkManager.hydrate` rebuilt the heightmap id-only**, so every waterlogged
  column lost its sky terminator across a save/reload — the live and reloaded
  worlds disagreed about identical voxel data, and `isRainingAt` below a bit-7
  cell flipped from false to true. It had `states` in scope two lines earlier.
- **`emitLadder` dispatched on the whole state byte**, so every waterlogged ladder
  rendered on the wrong wall (all three `===` tests missed and it fell through to
  the state-4 branch).
- **`World.neighborUpdates` never woke a waterlogged neighbor** (bare `.fluid`
  test), so a bit-7 cell could never re-spread after an adjacent block opened up.
- **§1.3's neighbor-update removal was silent** — §15 makes the quiet age-out of
  §2.4 the *only* silent removal.
- **§2.3's age write dirtied the chunk**, forcing a remesh the spec explicitly
  says is unnecessary ("no remesh needed (texture ageless)"); a burning floor
  remeshed its chunks several times a second for no visual change. `setState`
  gained a `noRemesh` option.

### Deferred (declared, not silently skipped)

**§7 — the 4-frame animated-tile pipeline is not built.** Fire/water/lava still
animate by the existing atlas-repaint path (`atlas.js`'s `animate()`, 2 frames at
4 Hz), which is 06 §3's mechanism and remains fully functional — nothing
regressed. §7's `anim` vertex attribute + `uAnimFrame` UV shift (AMENDS 01
§7.1/§8.5/§8.7) is unimplemented, and the acceptance line "fire/water/lava render
4-frame animation at 4 Hz via `uAnimFrame`" therefore FAILS.

The scout surfaced why this is not a mechanical port, and the reasons are worth
recording for whoever picks it up:

- **The three tiles cannot get 4 consecutive same-row slots where they sit.**
  `water` = tile 93 (row 2, col 29), `lava` = 94 (col 30), `fire` = 95 (col 31).
  §7.2's UV shift is pure `+u` and cannot wrap rows, so naive allocation samples
  garbage from the next row. TILE_NAMES needs a row-aware allocator or a reorder.
- **The spec's tile names don't exist**: it lists `water_still`/`lava_still`/
  `portal`; the code has `water`/`lava`/`fire` and no portal.
- **§7.2 omits a 4th animated tile that already exists** — `furnace_front_lit`.
  `anim` is a 0/1 flag and cannot express its 2 frames, so deleting the repaint
  path would silently freeze it.
- The "2 existing noise seeds" §7.2 refers to are `seed(name+':0')`/`':1'` — an
  rng nudge, not two authored looks — and adopting §7.2's `'#'` convention
  changes water/lava/fire pixels (cosmetic, but a visible diff).

Everything else in §7 (shape, light 15, cutout bucket, item icons showing frame 0)
already holds today.

### Verified

**33 browser assertions, 0 console errors** (24 core + 5 lava/infinite-source +
4 review-fix regressions), plus the E1 suites re-run for regressions
(35 audio + 7 in-game + 16 RMB, all green).

Gate items, measured: a wool floor **catches** (peak 4 simultaneous fire cells)
and **burns out** (13/25 consumed, 0 fire left); **rain extinguishes** an age-0
fire with median 4 fire-ticks; fire on an `infiniteBurn` block survives **400
rainy fire-ticks** and ages to 15; a submerged fence **shows water** (water-bucket
verts 404 logged vs 384 dry) and **breaks to a source** (id 63, state 0).

Also pinned: fire re-schedules every 30-39 t; `canSurvive` refuses mid-air but
accepts a flammable wall; bare stone fire self-extinguishes (median 10 fire-ticks);
a bit-7 cell survives its own fluid ticks and spreads water at S-1 = 7 without
replicating itself; sky light drops 15→14 through a waterlogged cell and the
heightmap terminates on it; a soaked fence reads enc/burn 0; it survives a
point-blank creeper while a dry one does not; `setBlock` scrubs bit 7 from every
non-waterloggable id; bit 7 round-trips through `serializeChunk` (state byte 0x80);
every fire-removal path drops its origin entry; all three §11.3 lava rows
(flowing→cobblestone, source→obsidian, on-top→no conversion) and §11.2's
infinite-source promotion.

## UPDATE — theme-music drop zone made Vercel-ready (2026-07-17)

The C418 placeholders were deleted from the working tree by the repo owner. This
readies `public/theme-music/` as the drop zone for original/licensed tracks, so
files placed there play locally **and reach the Vercel deploy**.

### Two real defects fixed (both would have shipped a broken deploy)

1. **`public/theme-music/` was gitignored — tracks would never have reached
   Vercel.** Vercel builds from the repo, so anything not committed is simply
   absent from the deploy: tracks would play perfectly in `npm run dev`, then be
   silently missing in production. The ignore rule dated from when the directory
   was a symlink to the C418 placeholders; with those gone, the shipped set must
   be committed. Now un-ignored, with the rule documented in `.gitignore` and
   `public/theme-music/README.md`: only original/licensed audio goes here, and
   every file must be declared in `CLEARED.json`.

2. **The ship gate counted `README.md` as an undeclared track and deleted the
   whole folder — while the manifest still referenced the tracks.** The build
   reported "1 cleared track(s)", baked `theme-music/x.wav` into the bundle, and
   then `closeBundle` removed `dist/theme-music` entirely: **every theme URL in
   the shipped bundle would have 404'd.** The gate now polices only AUDIO files
   against `CLEARED.json`, and strips non-audio companions (`README.md`,
   `CLEARED.json`) from `dist/` rather than counting them — they are
   documentation and a licence record, not tracks, and do not belong on a public
   URL. `AUDIO_EXT` is now exported from `gen-theme-manifest.mjs` and shared with
   the gate so the two lists cannot drift. A non-audio file is still deleted from
   `dist/`, so a renamed track (`song.mp3.txt`) cannot smuggle itself onto the
   deploy either.

### Added

- **`npm run theme:clear -- --license "…"`** (`scripts/clear-theme-tracks.mjs`):
  declares every audio file in `public/theme-music/` in one command, preserving
  any existing per-file licence text. The `--license` argument is mandatory and
  has no default — it is a human assertion of provenance, the one part of the
  gate a machine cannot verify. Tooling can check that a file is *declared*; it
  cannot check that the declaration is *true*.
- **`public/theme-music/README.md`** — the drop-in workflow, and why the
  declaration step stays manual.
- **`public/theme-music/CLEARED.json`** — empty `tracks: []` template.

### Verified end-to-end with a generated 2 s tone standing in for a delivered track

| Step | Result |
|---|---|
| drop a file in, `npm run dev` | appears in the manifest, plays |
| `npm run build` **undeclared** | gate withholds it — 0 audio in `dist/` |
| `npm run theme:clear -- --license …` | `CLEARED.json` written |
| `npm run build` **declared** | 1 track in `dist/theme-music/`, README/CLEARED.json **not** shipped |
| `vite preview` (the deploy path) | track fetched and **audible**, 0 × 404, 0 console errors |

Fixture removed afterwards; the drop zone ships empty. 80 assertions green
across every suite (35 audio + 8 regression + 7 in-game + 4 unlock + 16 RMB +
3 music + 3 prod + 4 prod-music).

**Unchanged:** the C418 audio remains in the pushed history (`b74a1b5`,
`6a16a13`, `v1.0.4`). Deleting the working-tree files does not remove it —
`git rm -r --cached CC-assets/CC-sounds` plus a history rewrite is still required.

## UPDATE — right-click fix (2026-07-17)

Work order: `UPDATE-rightclick-fix.md`. Reproduced both reported bugs with
instrumentation before changing anything. **One was real; the other does not
exist.**

### Bug A (world RMB placement) — REAL. Root cause: `air` was not `replaceable`

The work order's checklist suspected delivery/interception (steps A1-A3), or a
missing `held.place` (A4, "the most likely world-side cause"). Instrumenting the
whole chain showed all of those are fine — RMB arrives, the snapshot latches the
edge, `use()` runs, and `tryPlace()` is *called*:

```
A1  document mousedown(button=2) fired : 1
A2  snapshot saw rightPressed          : 1
A1  interaction.use() ran              : 2
A5  tryPlace() called / returned true  : 2 / 0     <- fails INSIDE tryPlace
A4  held item: dirt | item.place = 3               <- A4 was fine all along
```

`tryPlace` rejected at `if (!BLOCKS[targetId].replaceable) return false`, because
**`defBlock(0, 'air', …)` never set `replaceable` and the default is `false`.**
03 §16.2 defines the set verbatim:

> `blockAt(placePos) is in the replaceable set: {air, water, lava, fire,
> short_grass, dandelion, poppy, dead_bush} (06 §5.7)`

The code had only 5 of those 8 — `air`, `water` and `lava` were all missing. So a
block could only ever be placed *over a flower*, which is exactly the reported
"nothing, or nothing reliably". **Fix: add `replaceable: true` to air, water and
lava**, making the code's set match 03 §16.2 exactly (verified by comparing the
two sets programmatically). No spec change; base specs stay frozen.

The same guard gated three other paths that were therefore *also* silently
broken, and all three now work: **filled buckets could not be poured into air**
(06 §6.4), and **doors and beds could not be placed** at all (06 §5.13/§5.7).

### Bug B (crafting-grid RMB deposit-one) — NOT REPRODUCIBLE

The report says a single item cannot be right-clicked into a grid slot and that
"left-click-drag-distribute … is the sole working path", forcing groups of four.
Tested with **real** `mousedown/mouseup button:2` events against the **unmodified**
code, on both grids:

- 2×2 (inventory): three successive right-clicks → slot 1, 2, 3; cursor 31, 30, 29.
- 3×3 (table): same handler, same result.
- Empty cursor on a filled slot → picks up `ceil(9/2) = 5`, leaves 4.
- Result slot take-only; live recipe recompute after each single deposit.

All pass **before** my change. Two further points against the report's model:
there is **no drag-distribute code in this codebase at all** (the only `mousemove`
handler positions the cursor sprite; the only root `mousedown` is the
throw-stack path, already split by button), so the hypothesised "drag state that
begins on any button eats the RMB click" (checklist step 7) has nothing to
attach to; and 06 §14.2's stated adaptation already logged right-click
drag-painting as out of scope. **Nothing changed for Bug B** — inventing a fix
for a working path would only risk the behaviour the tests now pin down.

Most likely the report describes the live Vercel build, which predates this work.
Worth re-checking there after deploy.

### Verified

16 browser assertions, 0 console errors. An A/B against the reverted fix proves
the one-line change is responsible for exactly the world-placement failures and
nothing else: pre-fix **9 passed / 4 failed** (all four world-place), post-fix
**16 / 0**. Audio suites re-run for regressions (35 + 8 + 7, all green) — the
`block.place.*` events fire from the path this unblocks.

## UPDATE — audio-not-playing fix: E1 integration audit (2026-07-17)

Work order: `UPDATE-audio-not-playing-fix.md`. **Its two stated root causes were
already fixed** by the E1 commit (`e918c83`), which landed after the prompt was
written — verified rather than assumed:

| Prompt's claim | Actual state |
|---|---|
| "imported nowhere (`main.js` only imports `themeMusic.js`)" | `engine.js` imported by **16** files |
| "never constructed or booted" | `audio.boot()` at `main.js:34` |
| "context never unlocked on a user gesture" | **4** `audio.unlock()` sites |
| "no `audio.updateFrame()` / `audio.tick()` in the loop" | both wired (`Game.js:209`, `:254`, `:261`) |
| "`emitSound` is never called by any gameplay code" | **57** emit sites across **15** gameplay files |
| "`public/theme-music/` does not exist — every fetch 404s" | dev serves from `CC-assets/CC-sounds` via the `apply:'serve'` middleware; 0 × 404 |
| "set `musicMode` so in-game uses the synth composer" | already the `'menu'` default |

Re-verified against the **real browser autoplay policy** (no
`--autoplay-policy` override, a genuine trusted click): context is `suspended`
pre-gesture and `running` after press-start, with audio flowing immediately —
the prompt's prime suspect ("the single most common engine-present-but-silent
cause") is clean. Production build likewise: gesture unlocks, walking produces
synthesized footsteps at peak 0.60, **0 audio requests**, no 404s, no console
errors.

### One real defect the audit did find, now fixed

- **`musicMode: 'full'` with no cleared tracks was total in-game silence.**
  `Music.onOptions` suspended the §4 composer whenever the mode was `'full'`,
  but `menus.show()` only starts the theme layer `if (this.music?.available)`.
  Every public build today has an empty manifest, so `'full'` gave neither
  theme nor composer. §16's intro is explicit that the composer "remains the
  default and **the fallback**, so a fully-synthesized, zero-download ship is
  always possible" — so §4 now suspends only when the theme layer can actually
  play something.

### Deviation from the work order's Part B.1

**The C418 placeholders were NOT copied into `public/theme-music/`.** Part B.1
suggests copying them there for local audibility, gitignored. That reintroduces
the exact hazard E1's gate was designed around: Vite's `copyDir` dereferences
and copies `publicDir` into `dist/` at `renderStart`, so the placeholders would
land in every build and the ship gate would be racing a delete. The existing
dev-only middleware already achieves Part B.1's stated goal — 14 tracks audible
locally, 0 × 404 — while keeping a leak structurally impossible. `public/theme-music/`
stays reserved for genuinely cleared tracks + `CLEARED.json`.

### Known papercut (not a defect)

`npm run build` regenerates `src/audio/themeManifest.js` **empty** (`prebuild`,
by design — a shipped build has no cleared tracks). If a dev server is running,
it HMRs that empty manifest and the menu goes silent until `npm run dev` (whose
`predev` hook regenerates the 14 dev tracks) restarts. Building in a second
terminal while testing is therefore a plausible "the menu music stopped working"
report. In-game SFX and the synth composer are unaffected.

Verified 2026-07-17: **7 in-game + 4 real-autoplay-policy + 4 production
assertions**, plus the full E1 suite still green (35 acceptance + 8 regression +
3 music + 3 production). Menu: 14 tracks, running, themeGain 0.45.

## E1 — 16-AUDIO: synthesized SFX, positional sound, generative music (2026-07-17)

Built to `16-AUDIO.md`. New modules `src/audio/{engine,primitives,events,music,
ambience}.js` (the sixth, `themeMusic.js`, pre-existed from side-prompt 19).
**Everything is synthesized at runtime — zero sample files, zero audio fetches.**
The §4A theme layer stays OFF/empty (side-prompt 19 owns it).

### Amendments applied to the codebase (base specs stay frozen)

| AMENDS | Applied as |
|---|---|
| CLAUDE.md §6 / §7 | Already satisfied — §6 reads "and now audio (16's rule)"; audio is absent from §7. No edit. |
| 01 §2 | `src/audio/` with the six named files; `main.js`'s header now reads "build atlas, boot audio…". |
| 01 §3 | `audio.updateFrame()` in `Game.render()` (render step 6); `audio.tick()` in `Game.tick()` immediately after `save?.tick(this)` (tick step 10). |
| 01 §15.2 | `audio.unlock()` on every title/pause/death button + the canvas pointer-lock click + the keyboard PRESS START; `onPause`/`onResume` off `Game.setState`'s single funnel. |
| 01 §15.3 | Options screen: five sliders, Theme-music selector, mouse sensitivity, view bobbing — reachable from TITLE **and** PAUSE. |
| 01 §17.1 | `Game.debug.audioMs` + the F3 line (§6). |
| 04 §12.6 | `weather.thunder` emitted from the existing `DayNight.strikeLightning(x,y,z)`. |
| 06 §2 | `Mat` column: `BLOCKS[id].mat` + `matOf(id)` in `src/registry/blocks.js`. |
| 06 §12.4 | chew at use-ticks 8/16/24, swallow at 32, burp 10 ticks later. |

### Deviations

1. **`block.door` split into `block.door.open` / `block.door.close`.** §3.3 gives
   one id with two recipe variants ("380→640 Hz (open) / 640→380 (close)"), but
   §5.1's signature `emitSound(eventId, pos, pitchMult, gainMult)` has no param
   channel to carry open/close. Splitting matches what §3.6 already does for the
   `block.button.*.on/.off` family. Same reasoning for `block.lever.click.on/.off`
   (§3.6 says "param on/off") and `item.bucket.fill.lava`.
2. **`block.note` split into `block.note.<instrument>` (10 ids).** §3.5 says 16
   "supplies exactly one voice per instrument name that 07 emits in `block.note`'s
   `instrument` param" — again, no param channel exists. 07 calls
   `emitSound('block.note.' + instrument, pos, 2 ** ((n - 12) / 12))`; the pitch
   multiplier carries the note value exactly. `block.note` aliases the harp default.
3. **The event id is `weather.thunder`, not `weather.lightning`.** 16 contradicts
   itself: the AMENDS to 04 §12.6 says emit `weather.lightning`, while §3.5's
   table defines `weather.thunder`. The file's own intro says "**This file's
   registry (§3) is the master list**", so §3 wins.
4. **`weather.thunder` needs distance but is non-positional.** §3.5 marks it
   "ambient, non-positional" yet its recipe needs `d` for the <24-block crack gate
   and the `t0 + d × 0.06 s` rumble delay. Added a `distanceOnly` flag: the engine
   measures the distance to `pos` but allocates a FLAT (unpanned, unculled) voice.
   The alternative — smuggling distance through `pitchMult` — would have been a lie
   in the signature.
5. **Mob footsteps get their own `mob.step.<class>` family.** §3.2 gives them a
   distinct `capKey: 'mobStep'`, cap 4 and gain 0.3 against the player's cap 2 /
   gain 0.35. Reusing `block.step.*` with a gain multiplier would have let a crowd
   of mobs starve the player's own steps out of the shared cap.
6. **Creeper and Wither hurt/death derive from an invented timbre.** §3.4 gives
   both "*no idle*", but the generic rule derives hurt/death **from** the idle, and
   a creeper killed by a sword still calls `die()`. Creeper hurt/death derive from
   its fuse hiss; the Wither's from its klaxon sweep. No `.idle` id is registered
   for either, so the silent-creeper dread of §3.4 is structural.
7. **`voice.envGain` is a fade handle, not a volume stage.** §1.4's voice is
   `{envGain, panner, …}` and §2 says primitives build "into `voice.envGain`".
   Applying `gainMult` there *and* passing it to the recipe squares it — a
   10-damage fall peaked at 3.47 instead of 1.44 and slammed the limiter. Gain is
   now applied exactly once, inside each primitive's own gain node; `envGain` sits
   at 1.0 and exists for steals, loop releases and `handle.stop()`.
8. **`swellDir` materialised on the Creeper.** 05 §8.3 defines the field and 16
   §3.4 keys the fuse release off "its flip to −1", but the shipped code inlined it
   as `(pressure ? 1 : -1)` and stored nothing. Added `m.swellDir` (code was ground
   truth per CLAUDE.md §1; this restores the base spec's own field).
9. **Music lookahead schedules a bar at a time, not 100 ms.** §1.5 says "schedule
   every pending note with `noteTime < ctx.currentTime + 0.1`". The composer is
   bar-structured (chord walk + 1/8 grid), so it schedules whole bars — up to
   ~3.3 s ahead at 72 BPM. The two-clock property §1.5 actually cares about
   (JS picks *what*, the audio clock decides *when*) holds either way, and a
   partial bar cannot be scheduled without splitting the chord walk.
10. **Ambience adds a fire/furnace proximity scan.** §3.5's `ambient.fire.loop`
    names no sampling rule (unlike the fluid clusters' explicit 48-cell pass), so
    it reuses the same once-per-second pattern with a 24-cell scan at radius 8.
11. **`ambient.wind.loop`/`weather.rain.loop` recipes start at gain 0** and are
    driven by `ambience.js` from `rainLevel`/altitude on the same tick. The §3.5
    gains are formulas, not constants, so a recipe-side fade-in to full would blast
    one loud half-second at every rain onset.
12. **F3 audio line** (§6) reads `voices/pool · drops/s · ctx state · ms · mood#piece`.
    §6 also asks for "ctx.currentTime drift vs worldTime `(approx)`" — omitted: the
    context suspends with the game (§1.1), so the two clocks are decoupled by
    design and a drift number would be noise, not a diagnostic.
13. **Options: `musicMode` and the two 03 settings are now wired, not just stored.**
    Side-prompt 19 shipped the full §15.3 *schema* with only 3 of 5 sliders in the
    UI and no consumer for `mouseSensitivity`/`viewBobbing`/`musicMode`. E1 adds the
    Ambient/UI sliders, the Theme-music selector, and wires sensitivity into
    `Game.applyMouseLook` (clamped 0.1–3.0 — `loadOptions()` does not validate) and
    bobbing into `Game.updateCamera` (zeroing the offset, never `bobPhase`, which is
    deterministic tick state).
14. **The Options panel is a top-level sheet, not a child of `#screen-title`.**
    `.screen { display: none }` made the 19-era panel structurally unreachable from
    PAUSE, which this amendment requires. It moved to `screensEl`, the `--cc-*`
    palette moved from `#screen-title` to `:root`, and it gains an `.over-pause`
    scrim variant so it does not black out the live world behind it.
15. **`game.hud` is dead in three places** (`interaction.js:66/68`
    `hud?.onHotbarChange?.()`, `ItemEntity.js` `hud?.flashPickup?.()`). The HUD is
    at `game.ui.hud`, so all three are silent no-ops today. Logged per CLAUDE.md §1
    (code is ground truth); the `ui.hotbar` and `player.item_pickup` emits are
    placed as their own statements, never chained onto them. **Not fixed here** —
    out of E1's scope.
16. **`entity.arrow.hit_block` is the thud layer only.** §3.3's recipe is "thud +
    the *struck block's* `step` recipe at 0.5", which needs the block class —
    again no param channel. The hook emits `block.step.<class>` alongside it at
    gain 0.5, from the block actually hit.

### Defects found and fixed before landing

Found by hand while re-reading the gain path:

- **`gainMult` was squared** (deviation 7) — a 10-damage landing peaked at 3.47
  against the spec's 1.44, slamming the limiter.
- **Ambience loops played forever on the title screen.** `Game.tick()` early-returns
  once `disposeWorld()` nulls `world`, so `audio.tick()` — and ambience's own
  silence path — never ran again. Now stopped from `setState(TITLE)`.
- **A stolen loop's handle reported `alive === true`.** Voices are recycled, so
  handles now capture a generation counter.
- **Loop leaks on paths that never reach the owner:** TNT fuse (chunk unload) and
  creeper fuse (detonation sets `dead` directly, bypassing the goal) now stop from
  `onRemoved()`, the one hook every removal path calls. The bow draw loop stops on
  death, which returns before `updateUseChannel` and leaves `usingItem` set.
- **The level-up chime machine-gunned on every world load** — `deserialize()`
  replays the whole XP ladder through `addXp()`.
- **Enderman screamed on every hit** — the damage path sets `aggro = true`
  unconditionally, unlike the stare path's `!aggro` guard. Now edge-detected.
- **The dig gate would never have fired** — `swingLoop()` calls `swing()`, which
  resets `swingTicks` to 0, so the 6-tick test has to be read before it.
- **`ui.hotbar` double-fired** on a tick with both wheel and digit input, and fired
  when pressing the already-selected slot.
- **Rain/wind onset blasted** at full gain for ~0.5 s (deviation 11).

A multi-agent adversarial review (5 dimensions → per-finding refutation) raised 20
candidates; **7 confirmed, 12 refuted**, 1 inconclusive (its verifier errored) and
checked by hand. All 8 fixed:

- **Every looping voice self-released after ~1 s.** `crackle`/`hiss`/`noiseBurst`/
  `sweep` returned a finite `stopTime` even for `loop: true`, so the engine
  released the voice while the source played on — un-stoppable (its ref was
  cleared) and audible into whatever sound recycled the voice next. Loops now
  return `Infinity`. This silently broke the TNT fuse, the bow draw and the fire
  loop.
- **The title screen went permanently silent after 16 clicks.** §1.4's ≤16
  starts/tick counter resets in `audio.tick()`, which `Game.tick()` never reaches
  while `world` is null. `updateFrame` now mirrors that exact guard.
- **Save & Quit killed audio for the session.** `onResume` was keyed to
  PAUSED→PLAYING, but Quit is PAUSED→TITLE — leaving `masterGain` ramped to 0 and
  the context suspended. Now any exit from PAUSED resumes.
- **The per-family cap stole across sub-pools.** `item.bow.shoot` is flat for the
  player and positional for skeletons under one `capKey`, so the player's own shot
  could seize a skeleton's positional voice and render at its stale coordinates.
  The family is still counted across both pools; only the requested pool is
  returned.
- **The 5 ms declick was dead code** — `emitSound` cancelled the victim's fade from
  `now`. Both writes now land at `t0`, after the fade completes.
- **`ambient.fire.loop`'s brown bed went silent after 1 s** — `noiseBurst` applied
  its one-shot decay envelope even when looping, leaving a source running behind a
  gain pinned to 0. §3.5's second layer was effectively unimplemented.
- **No chime had its inharmonic partial.** §2.10's pack defaults `partial2 = 0.3`,
  but a truthiness check made it opt-in and no caller passed it — so every bell,
  glint and level-up chime lost the ×2.76 partial that makes struck metal read as
  struck.
- **The creeper fuse never restarted after winding down.** The re-arm was keyed to
  the swell leaving 0, but a creeper that winds down to swell 3 and re-approaches
  never returns to 0 — it detonated in silence, losing exactly the cue the event
  exists to give. Now keyed to "rising with no live voice".
- **Three registered events were never emitted:** `entity.arrow.hit_block` /
  `.hit_mob` (arrow impacts were silent), `mob.chicken.egg`, and
  `player.armor_equip` (both the use-path and the inventory-slot path). A registry
  sweep confirms the only remaining unemitted E1 event is `player.drink.gulp`,
  whose trigger §3.3 explicitly assigns to 09.

Verified 2026-07-17 (headless Chromium, dev + production build): **35 acceptance
+ 8 regression + 3 production + 3 music assertions**, zero console errors. Highlights: SFX
audible off a real analyser tap; stone vs sand and wool vs stone measured by
zero-crossing rate from isolated `OfflineAudioContext` renders (stone ZCR 3.5k vs
sand 9.7k; wool 155 vs stone 3.6k); explosion LP muffle 6000/985/200 Hz at
5/40/120 blocks; 100 simultaneous sounds never exceed the 32-voice pool and never
drop a UI click; starts throttle at 16/tick; note-block n0→n24 ratio exactly
4.0000; SFX slider 50 → 0.25 on `sfxBus` only; thunder at 150 blocks rumbles 12.6 s
out; piece 0 identical across two runs of one seed and different across seeds;
pause suspends the context with masterGain 0.0004. Perf: `updateFrame` worst
0.600 ms / avg 0.015 ms with 24 mobs + thunderstorm + music (budget ≤ 1.5 ms);
baked buffers 3.61 MB (budget ≤ 4 MB). **Production build: 0 audio files in
`dist/`, 0 audio requests in the network tab, 0 `/theme-music/` requests**;
`grep` for `fetch`/`decodeAudioData` outside `themeMusic.js` returns nothing.

## UPDATE — main menu (desert theme) + menu music (2026-07-17)

Built to `19-MAIN-MENU`, conforming to `16-AUDIO §4A` (the shared theme-music
module), `16-AUDIO`'s AMENDS to `01 §15.3` (Options), and `01 §14`/`§15.3`.

**Scoped exception to `16-AUDIO §5`'s synth-only rule (mandated by 19 §0/§7):**
the menu uses file-based (sampled) music. This applies to the **menu only** —
in-game audio remains 100 % synthesized, and the §4 generative composer stays
the default and fallback. **Shipped menu tracks must be original or
properly-licensed** (ship gate below).

### Audio copyright ship-gate — how it works

`CC-assets/CC-sounds/` (the C418 OST) is a **local dev placeholder set only**.
Rather than gate a leak after the fact, the two track sources are asymmetric so
a leak is structurally impossible:

| | location | reaches `dist/`? |
|---|---|---|
| Dev placeholders | `CC-assets/CC-sounds/` — **outside** `publicDir` | never; Vite only copies `publicDir` |
| Shipped set | `public/theme-music/` | only when declared in `CLEARED.json` |

- Dev playback comes from a **dev-only Vite middleware** (`theme-music-dev-serve`,
  `apply:'serve'`) that serves `CC-assets/CC-sounds` at `/theme-music/*`.
  This replaced an earlier `public/theme-music` **symlink**: Vite's `copyDir`
  dereferences symlinks at `renderStart`, so that design copied all 106 MB into
  `dist/` on every build and left the gate racing to delete it.
- `scripts/gen-theme-manifest.mjs --build` (wired to `prebuild`/`prepreview`)
  reads **only** `public/theme-music/` and emits an **empty** manifest unless
  every file is declared in `public/theme-music/CLEARED.json` — so a build with
  no cleared tracks ships with the theme layer off, per `17-SHIP §3.5`.
- `vite.config.js`'s `theme-music-ship-gate` plugin deletes any undeclared
  `dist/theme-music` in `closeBundle` (which also runs when a build throws).

**To ship music:** put original/licensed files in `public/theme-music/` and add
`public/theme-music/CLEARED.json`:

```json
{ "tracks": [ { "file": "dunes.mp3", "license": "original — © Vantic Studio" } ] }
```

**⚠ Outstanding, needs a human decision:** the 14 C418 mp3s are **already
committed** at `CC-assets/CC-sounds/` (commit `b74a1b5`, 106 MB, unpushed at the
time of writing) with remote `github.com/vanticstudio/Minecraft-spec`. The new
`.gitignore` rule does **not** untrack them and no build-time gate can — the
audio would be distributed by the repo itself. Fix before any push:
`git rm -r --cached CC-assets/CC-sounds` + a history rewrite (still cheap while
`b74a1b5` is unpushed).

### Deviations

1. **Options screen is a title-screen settings panel with 3 of the 5 spec'd
   sliders** (Master / Music / SFX). `16-AUDIO`'s AMENDS to `01 §15.3` wants
   five sliders (+ Ambient, UI), a Theme-music selector, mouse sensitivity and
   view bobbing, reachable from TITLE **and** PAUSE. 19 §3.2 only requires
   "at minimum: Master, Music (menu), SFX" on the title. Ambient/UI/musicMode
   have no consumer until 16-AUDIO E1 lands, and sensitivity/bobbing belong to
   03's settings — so the UI ships with what is wired. The **persisted schema is
   already the full §15.3 shape** (`src/ui/options.js`: master/music/ambient/
   sfx/ui/musicMode/mouseSensitivity/viewBobbing at `claudecraft.options.v1`,
   migrating `voxelcraft.options.v1`), so E1 adds rows, never a migration.
2. **`themeMusic` builds its own AudioContext + bus chain** (sanctioned by
   19 §4.4 — "if 16 isn't built yet"). The fallback graph is a byte-for-byte
   subset of `16 §1.2` (`themeGain → musicBus → masterGain → DynamicsCompressor
   → destination`, same compressor constants, `busGain = (slider/100)²`), and
   `createThemeMusic({ context, musicBus })` takes E1's nodes when they exist.
   While the bus is ours we drive its gain; when it is E1's we never touch it,
   so E1's `§4.3` damage-duck cannot double-apply (`duck()` is a no-op hook).
3. **Decode guard is by bytes, not just count.** `16 §4A.1` says decode ≤ N
   (default 6) *short* tracks. "Short" is load-bearing: six 3-minute stereo
   tracks decode to ~414 MB of Float32 PCM. Added `DECODE_MAX_BYTES = 2.5e6`
   per track and a `DECODE_BUDGET_BYTES = 96e6` resident ceiling `(approx)`;
   anything larger streams via `HTMLAudioElement`. With the 14 placeholders this
   measures 1 decoded / 13 streamed / 34.6 MB PCM.
4. **Menu art is scaled by its ink, not its canvas.** `logo-primary.png` is
   2360×760 with only 1747×255 of opaque pixels (34 % of canvas height), and the
   button plates are 61 %. Sizing the boxes to 19 §3.1's `clamp(46px,9vw,120px)`
   rendered a ~39 px wordmark, so the CSS scales each box by 1/inkFraction and
   negates the transparent padding with negative margins — the *visible* art then
   matches the spec's metrics and flex gaps lay out against the art.
5. **No Delete/Back button art exists**, so those two are styled text buttons
   (`.cc-textbtn`), and **Delete World moved into the Settings panel** — 19 §3.2
   fixes the title row at New Game / Continue / Settings / Quit, and reusing the
   QUIT/CONTINUE plates for other actions would mislabel them. The `onDelete`
   hook is unchanged and still reachable (19 §3.2 "reuse their hooks").
6. **`.screen h1` / `.screen button` / `.screen input` were narrowed** to
   `#screen-loading|#screen-pause|#screen-death`. As element-qualified selectors
   (0,0,1,1) they beat every single-class `.cc-*` rule (0,0,1,0) and silently
   restyled the title's wordmark and image buttons. The three stock screens keep
   their exact look.
7. **`Quit` on the title returns to the PRESS START state** (19 §3.2 — web build
   has no process to exit).
8. **`src/audio/themeManifest.js` is generated and gitignored**; `predev` /
   `prebuild` / `prepreview` always regenerate it, so a fresh clone can never
   import a stale or missing manifest (it emits `[]` when no tracks exist).
9. **Fonts are self-hosted** (`public/menu/fonts/`, Bungee + VT323 latin-subset
   WOFF2, 21 KB total, OFL texts bundled alongside) per 19 §3.1 — no runtime CDN.
10. **`package.json` gained `"version": "1.0.2"`**, surfaced to the badge via a
    Vite `define` (`__APP_VERSION__`). No version existed anywhere before;
    `SAVE_VERSION`/`DB_VERSION` are save-format numbers and deliberately unused
    here.

### Defects found by adversarial review and fixed before landing

A multi-agent review (3 dimensions → per-finding refutation) confirmed 14 real
defects; all are fixed and regression-tested:

- **Ship gate resolved `outDir` against `process.cwd()`.** `build.outDir` stays
  the relative string `"dist"` after `resolveConfig`, so a build launched from
  any other directory checked the wrong path and waved the tracks through. Now
  `resolve(cfg.root, cfg.build.outDir)`.
- **`npx vite build` bypassed the gate entirely** — pre* npm hooks don't run, so
  a manifest left over from `npm run dev` baked all 14 C418 filenames into the
  production bundle (verified: `dist/assets/index.js` contained the playlist).
  The generator now also runs from the plugin's `buildStart`.
- **A directory named in `CLEARED.json` shipped its whole subtree unchecked**
  (`readdir` returned dir names as if files). Entries must now be real files.
- **`stop()`'s post-await tail tore down a `start()`** that arrived during its
  1 s fade — the menu went permanently silent for the session. Both are now
  epoch-guarded.
- **The stream branch never re-checked `running` after `await el.play()`**,
  orphaning a live `<audio>` node after `stop()`.
- **`_scheduleNext()` could resurrect a gapTimer** after `stop()` cleared it.
- **Track timers ran on the wall clock** while the AudioContext was suspended,
  truncating a track by the length of any tab switch. Deadlines now use
  `ctx.currentTime`, and stream elements park/resume with the context.
- **Quit-to-title left the music playing**, after which PRESS START no-op'd.
- **Settings dialog had no focus trap** (Tab reached the title buttons hidden
  behind the opaque overlay — Enter there would start or delete a world), no
  Escape, and restored focus to New Game rather than the opener.
- **Arrow-key navigation was missing** (19 §3.2 requires "arrow/Tab + Enter").
- **`claudecraft:start` was never dispatched** (19 §3.2 says keep that event).
- Seed input had no accessible name; `_load()` had no in-flight dedupe; the dev
  middleware threw an uncaught `URIError` on malformed percent-encoding.

Verified 2026-07-17 (headless Chromium, dev + production build): 54 browser
assertions pass — scene/badge/tagline/logo render, PRESS START gates the button
row and the music, Continue only with a save, shuffle has 0 immediate repeats in
400 draws across reshuffles, gaps land in 10–20 s, fades in/out, level 0.45,
zero audio requested before the gesture, Music slider changes gain live
((70/100)² = 0.49) and persists across reload, world load fades out in ~1 s and
suspends the context, quit-to-title rearms and restarts, tab hide/show
suspends/resumes, `prefers-reduced-motion` stills every animation, no horizontal
overflow from 560 px to 4K, zero console errors. Plus 10 regression assertions
for the review fixes above (start-during-stop survives, Quit stops/restarts,
Escape + focus trap + focus restore, arrow nav, `claudecraft:start`, seed label).
Production build: **0 audio files in `dist/`**, no track references in the
bundle, theme layer off, no `VoxelCraft` string, no font-CDN reference.
Gate re-tested adversarially: placeholders hand-copied into `public/theme-music/`
plus a `CLEARED.json` falsely declaring a *directory* → whole `dist/theme-music`
removed, 0 mp3s shipped. `vite preview` returns the SPA fallback (652 B of HTML),
not audio, for a track URL — the dev middleware is `apply:'serve'` only.

## UPDATE — sky/sun render fix (2026-07-17)

Conformed to `04 §5.2/§5.3/§5.5/§6` and `01 §8.7/§14`. Root causes fixed:
(1) sun/moon/sunrise-band materials had `depthTest: false` — being
`transparent`, they draw **after** the opaque terrain pass, so they painted
over leaves/terrain/clouds instead of being occluded (the dusk "hard white
square" and the persistent grey blob at spawn, which was the moon rendering
through the ground from below the horizon); (2) no `dir.y > −0.3` visibility
gate on sun/moon, so the moon was drawn all day (at world time 0 it sits ~12°
*below* the −X horizon — the "static grey square at ground level");
(3) the sun billboard was never dimmed/warmed at dusk; (4) the sun texture's
outermost alpha ring was 0.125, not 0, stamping a faint square edge; (5) the
new-moon cell was painted near-opaque instead of `#1A1A2A` at 25 % alpha
(`04 §5.3`).

1. **Sun/moon/band use `depthTest: true`** — diverges from `01 §14`'s
   `depthTest: false` on the sun. With `transparent` materials three.js
   renders the whole sky *after* the opaque pass regardless of
   `renderOrder ≤ −1`, so a depth test is the only mechanism that realizes
   `04 §5`'s draw-order intent (terrain/leaves occlude sky objects; leaves
   work because the cutout pass keeps `depthWrite: true` per `01 §8.4`).
   The dome still doesn't write depth, so nothing occludes wrongly.
2. **Sun billboard modulated by `sunIntensity` + sunset-band warming**
   (UPDATE mandate; extra-spec vs `04 §5.2`, which only gates visibility and
   fades by rain): per frame `sunColor = sunIntensity × #FFFFE5`, then within
   the `§5.5` band window `g ×= 1 − 0.35·band.a`, `b ×= 1 − 0.6·band.a`.
   Opacity stays `1 − rainLevel` per `§5.2`.
3. **Moon alpha × `(0.6 + 0.4 · MOON_BRIGHTNESS)`** — `04 §5.3` says the
   phase factor scales "star/moon alpha slightly" but gives no formula;
   stars keep `§5.4`'s exact opacity formula (resolving the self-conflict in
   favor of the verbatim code), the moon takes the phase scaling.
4. **Sun texture samples with `LinearFilter`** (other canvas textures stay
   `NearestFilter`): the spec's "soft 4-px falloff" renders as visible
   banding steps at nearest sampling on a 240-unit quad; spec is silent on
   filtering. Falloff now reaches exactly 0 at the texture border, corners
   rounded via a Chebyshev/Euclidean blend.

Verified 2026-07-17 (headless Chromium, fresh world, seed `skyfix`): additive
sun soft square at midday; a placed leaf wall fully occludes the sun (glints
only through alpha-test holes); dusk 12000→12786 dims/warms the disc
(probe: color 1.0 → 0.496/0.338/0.203 → 0.35/0.228/0.126) with the sunset
band; sun hidden at 14500 (gate); moon rises +X opposite the sunset, tracked
under clouds, full-moon square overhead at 18000 with 1500 stars; 360° spawn
pan at dawn shows no grey blob and no stray quads; zero console errors.

## UPDATE — crafting/inventory UI fix (2026-07-17)

Conformed to `06 §9/§10/§14/§15`, `03 §3/§16.3/§23`, UPDATE-08 §7. Root causes
fixed: (1) the shaped matcher trimmed the grid's bounding box but not the
**pattern's** — axe `MM./MS./.S.` and hoe `MM./.S./.S.` carry an empty third
column, so they could never match; both boxes are now trimmed per §4.2 and the
horizontal mirror is applied on the trimmed box. (2) Screens now use absolute
GUI-px geometry on the 176×166 reference panel (§2.2/§3.1 coordinates) instead
of stacked CSS grids.

1. **GUI scale is 3×, not the 2× named in `06 §15.3`** — the existing icon
   pipeline (`--px: 3`) renders atlas tiles at 3 css px per texture px; the
   panel scales uniformly via `--gpx: 3px` to match. Pure scale factor; all
   §2.2/§3.1 GUI-px coordinates are used verbatim.
2. **Offhand (UPDATE-08 §7.1) is held-item storage + rendering**: slot 45 in
   the inventory screen (77,62) with shield-silhouette placeholder, `F` swap
   with the hovered slot, persistence (`meta.player.offhand`, backward
   compatible — old saves load with an empty offhand), death-drop, and a
   left-hand viewmodel render. No offhand *use* actions (place/eat from
   offhand) — 06's interaction pipeline has no offhand use channel and the
   UPDATE's guardrails restrict this change to UI/resolver paths.
3. **Armor/offhand placeholders and the grid→result arrow are CSS/canvas
   procedural** (clip-path silhouettes, border-triangle arrow, canvas player
   silhouette in the preview panel) — no downloaded art, per guardrails.
4. **Furnace/chest screens were re-anchored** to the same 176×166 absolute
   panel (furnace input 56,17 / fuel 56,53 / output 116,35; chest 9×3 from
   (8,18)) so all containers share one geometry system. The UPDATE mandates
   only the inventory + crafting-table screens; this is a consistency choice.
5. **`resolveCraft` consumption**: returns the matched recipe; consumption is
   uniformly "decrement one item from every non-empty grid cell", which is
   exact for the entire `06 §10` recipe set (no recipe consumes multiples per
   cell or leaves container items).
6. **Right-click drag-painting** remains out of scope per `06 §14.2`'s stated
   adaptation (right-click-place-one covers it).

Verified 2026-07-17 (headless Chrome): 46 slots, zero overlapping rects,
result at (154,28), offhand at (77,62); sticks resolve in the 2×2 and at
top-left/center/bottom-right offsets of the 3×3; `PP/PP` in both grids;
furnace/chest resolve only in the 3×3; axe normal + mirrored + offset; hoe;
shears; shapeless log→variant planks anywhere and `coal_block → 9 coal`;
live result recompute on every grid mutation; take-one consumes exactly one
per cell; shift-craft loops to depletion routing hotbar-first; result slot
refuses deposits; `F`-swap, number-swap, Q-drop, double-click collect,
click-outside drop, and close-returns-grid all pass.

---

## E12 — 14-MULTIPLAYER (host-authoritative co-op over a WebSocket relay)

1. **SAVE_VERSION realized as v2→v3, not the spec's "version becomes 2".** E7
   (10-NETHER) already occupied v2, so the multiplayer `meta.player → meta.players`
   reshape is a **v2→v3** bump instead. `migrate()` gains a NON-destructive `v<3`
   branch that wraps the legacy single player under the host's `localPlayerId`
   (chunks untouched); it composes with the destructive v1→v2 branch. The
   single-bump rule (CLAUDE.md §8.5) is preserved — each phase bumps once.

2. **In-session JSON messages ride as `0x00`-tagged BINARY frames**, not raw
   WebSocket text frames. §3.1 describes JSON as "text frames" and §1.2 describes
   the relay's routing as a one-byte prefix on binary data frames — these can't
   both hold. Resolution: after the relay handshake (which IS a text control
   frame), EVERY frame is binary with the routing byte; a JSON message is msgId
   `0x00` + UTF-8. This keeps the relay's single binary routing path (§1.2) fully
   opaque and covers JSON uniformly. Byte-exact and round-trip tested.

3. **All players share the host's single resident dimension.** The v1 world engine
   holds ONE active dimension at a time (`flushAllChunks` wipes on change). So the
   "staying client keeps the overworld while another travels to the Nether" case is
   NOT supported — instead the **party travels together**: any player completing a
   portal transit drives `changeActiveDimension`, which moves every player to the
   destination and broadcasts `dimChange`. Concurrent cross-dimension play needs a
   second resident world (a v2/dedicated-server concern, per the spec's own §9 note).

4. **Client RMB (use/place/interact) is non-predictive; LMB break IS predicted.**
   Mining feel is the latency-sensitive case, so breaks predict locally (drops/xp
   are host-only) and send a `blockEdit`. RMB (placement, chest/door/bed/bucket)
   sends a `useBlock` and waits for the host — placement therefore appears ~RTT
   later for the placing client (§7's feel table already permits use/place
   stickiness). Other players see every edit via `blockSet` as normal. The host
   reuses the canonical `interaction.breakBlock/tryPlace/use` for remote players
   via a temporary active-player swap (`interaction._activePlayer`).

5. **Networked containers are host-authoritative and non-predictive, chest-class
   only.** Chests/dispensers/droppers/hoppers/shulker boxes/furnaces replicate via
   `containerOpen`/`containerClick`/`containerResult` with a headless click applier
   (`applyNetContainerClick`) covering pickup/place/swap/split/drop-one/shift-move.
   The client re-renders from the authoritative result (no client prediction — so
   clicks feel RTT-delayed, and item conservation is guaranteed by the single host
   arbiter; a 10-click shift-storm audits identical before/after). Crafting tables,
   enchanting, anvils, grindstones and villager trades opened BY A CLIENT are not
   supported in this version (the host player uses them normally).

6. **Remote-player continuous-use (eating a held food, drawing a bow via the
   `useHeld` bit) is not wired for clients.** Movement is driven by the input frame;
   discrete actions (break/place/use/attack/drop) arrive as explicit request
   messages. A remote client's own arrows/eating are a known gap (§5.2's `useHeld`
   eating/bow); the host player's are unaffected.

7. **Redstone-torch light state (`updateEmission`) is not separately replicated.**
   Ordinary block/state changes (including redstone dust/repeater/lamp id+nibble)
   ride `blockSet`; the redstone torch shares one id for lit/unlit and changes only
   its emission, so a client may briefly mis-light a torch until a neighbouring
   `blockSet` refreshes the column. Cosmetic only.

8. **New module `src/net/identity.js`** (playerId/name in localStorage + deterministic
   skin hue) and **`src/ui/netContainer.js`** (client chest screen) are additions
   beyond the spec's 01 §2 module list, in the spirit of its `net/` grouping.

Verified 2026-07-19 (headless Chrome, two contexts over the live relay — 92 checks):
relay transport (rooms/join-codes/sender-tagging/routing/broadcast/full-refusal/
disconnect, 12); binary wire round-trips incl. negative coords + RLE + chunkData
(42); two-browser sync — join in <10 s, mutual visibility, block edits both ways,
client input driving the host-side player (Δ 4.45 m), nearest-player mob targeting,
HOSTILE_CAP 40→60 (13); solo regression byte-clean + save `version===3` + `meta.players`
+ rejoin restores inventory in place + sleep skips only when both are in bed (16);
200 ms simulated RTT — RTT 208 ms, predicted pos agrees with host Δ 0.00 m, zero
hard-snaps/rubber-banding (6); chest shift-click storm conserves every item (3).
