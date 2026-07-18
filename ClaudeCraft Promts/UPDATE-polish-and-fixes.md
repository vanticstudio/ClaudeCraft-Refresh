# UPDATE PROMPT — Post-build polish & fixes (single builder, one section per gate)

**For:** the build executor (Claude in Ultra Code), in the **ClaudeCraft** repo root (game is complete at v1.1.0).
**Type:** code fixes + polish on the shipped game. Base specs 01–06 frozen; conform to them and log divergences in `DEVIATIONS.md`. **Do these one at a time on `main`, verify in the browser, commit each at its gate, then move on** (§8.5). Order below is by priority — **§1 (right-click) is CRITICAL, do it first.**

---

## 1. CRITICAL — right-click places no block/item

**Symptom:** right-click never places a single block (or item) in the world.

**Key finding:** `Interaction.tryPlace()` (`src/player/interaction.js:883`) is **correct** — it computes `placePosFor(hit)`, checks reach/bounds/`replaceable`/collision, sets per-block state, `setBlock`, `consumeIn(hand,1)`. An earlier commit already fixed replaceable targets. So **the bug is upstream of `tryPlace`** — placement is never reaching it. Reproduce with logging and walk this chain:

1. **DOM → snapshot.** `src/player/input.js` sets `pressBuf[2]`/`buttons[2]`; snapshot exposes `rightPressed`/`mouseRight`. Confirm a right-click actually flips these (mining/LMB works, so the listener is alive — verify RMB specifically).
2. **The tick gate** (`interaction.js` ~line 100): `if ((input.rightPressed || (input.mouseRight && this.useDelay === 0)) && !p.usingItem) this.use(input);`. Log here. Suspects: `rightPressed` cleared before the tick reads it (snapshot/reset ordering); `p.usingItem` stuck truthy from a prior eat/bow; `useDelay` never reaching 0.
3. **`use()` pipeline order.** E3 restructured `use()` into the canonical 5 steps with a `hand` param and a main-then-offhand rerun. Placement is step 3 (`interaction.js:693` `if (held.place != null && hit) { this.tryPlace(held, hit, hand); return true; }`). Log which step fires. Suspects: an earlier step (entity-interact / interactable-block) swallows the event so step 3 never runs; the offhand rerun clobbers the main-hand result; or `held` is resolved from the wrong hand so `held.place` is undefined for the block you're holding.
4. **`held` + `hit`.** Confirm `p.heldItem()` returns the selected hotbar block (with `place != null`), and `this.currentHit` is populated on the RMB tick (not null). Log `held.place`, `hit`, and `tryPlace`'s return.

**Fix:** whatever the log shows is bailing — most likely (2) the gate/`usingItem`/`rightPressed` edge, or (3) the pipeline step order / hand resolution from the E3 refactor. Also re-check inventory single-item RMB (the `containers.js onSlotClick` button-2 branch) still deposits one, in case the same hand/gate refactor touched it.

**Acceptance:** hold a block, aim at a face, right-click → exactly one block places on the correct adjacent cell; holding RMB places at a steady cadence; right-click still opens interactables (crafting table/furnace/chest); offhand item use still works; inventory RMB deposits one item into a slot.

---

## 2. Worldgen — kill the "island → ice ring → forever flat ice" edge; make the world continuous & progressive

**Symptom:** travel far over open ocean in any direction and you hit a ring of ice, then endless flat ice.

**Where:** height = `composeColumn()` (`src/world/gen/noise.js:69`); biome = `selectBiome()` (`src/world/gen/biomes.js:62`, cold branch `t < -0.45 → SNOWY_TUNDRA/TAIGA`); the freeze is `features.js:214` (`water at top 63 → ice`). Note the hard **world border at |x|,|z| ≈ 1,048,575** baked into the lattice key (`noise.js:113` `key2 = (ix+262144)*524288 + (iz+262144)`) — beyond it the key collides and gen degenerates to a constant (flat).

**Likely cause:** either (a) the continentalness/temperature fbm trends monotonically toward cold ocean at distance (so `height ≤ 59` flat sea + `t < -0.45` → surface water freezes → "forever flat ice"), or (b) you actually reached the ±1M lattice border and it's returning a constant. Diagnose: fly out along +X logging `c, e, t0, height, biome` every ~1000 blocks; find the radius where they stop varying or saturate cold, and whether it's before or at the ±1M border.

**Fix:**
- If it's the border: either extend the lattice key range so the world is effectively unbounded at any reachable distance, or if a finite border is intentional, make the approach graceful (not a flat ice ring). Prefer **continuous, progressive generation** — terrain and biomes keep varying as far as anyone can travel.
- If it's a low-frequency cold/ocean trend: rebalance the continentalness + temperature noise (domain-warp or raise the base frequency / remove any radial bias) so land, ocean, and climate keep alternating at all distances instead of degenerating to one cold flat sea. Keep gen deterministic from the seed (02 §2 seed-stream discipline).

**Acceptance:** fly 20–50k blocks in several directions from spawn — terrain stays varied (land, hills, oceans, mixed biomes), no ice ring, no endless flat plane; two runs with the same seed are identical.

---

## 3. Sky — smooth the stepping celestial motion

**Symptom:** the sky/sun doesn't move smoothly; it bumps/steps as it crosses.

**Where:** `Sky.update()` (`src/render/Sky.js:211`, "called every frame") sets `pivot.rotation.z = angle * 2π` from `angle` = `celestialAngle(t)` (`src/env/DayNight.js:21`). The renderer path is per-frame, so the step means **`angle` is fed a quantized time** — `worldTime`/`dayTime` as an integer that only advances on the 20 TPS tick (or coarser), with no sub-tick interpolation.

**Fix:** compute the celestial angle (and sky color/sun/moon/cloud-drift) from an **interpolated time each frame** — `dayTime + partialTick`, where `partialTick` is the render accumulator fraction (the same alpha used for entity render interpolation). Feed that smooth time into `celestialAngle`, the keyframe lerp, and the cloud drift so motion is continuous, not tick-stepped. Don't change the tick logic; only interpolate the visual.

**Acceptance:** at any time speed the sun/moon glide smoothly with no visible stepping; day/night color transitions are continuous; clouds drift smoothly (the 12-block grid snap on cloud *position* is fine; the drift offset must be smooth).

---

## 4. Held & inventory items — render 3D, not flat 2D

**Symptom:** held items and inventory/menu icons are flat 2D sprites; want 3D (like Minecraft).

**Where:** inventory/HUD icons are 2D atlas backgrounds (`src/ui/hud.js:7` `iconCss` → `backgroundPosition`); the held viewmodel uses the fixed-FOV `viewmodelCamera` (`src/render/renderer.js:24`).

**Approach:**
- **Held blocks:** render the held *block* as a real 3D cube in the viewmodel — a `BoxGeometry` textured with the block's six face tiles (`BLOCKS[id].tileIndex`), at the vanilla first-person angle/scale. Held *tools/items* stay flat but angled (a thin quad tilted in-hand), matching Minecraft's item-vs-block distinction.
- **Inventory icons:** render blocks as **isometric 3D icons**. Cheapest robust route: an offscreen WebGL pass that renders each block cube to a small texture once (cache per block id), then use that as the slot image; flat items keep their atlas sprite. Keep enchant glint (`src/render/glint.js`) working over the new icons.
- Keep it in the existing render/atlas pipeline; no external assets; watch the 60 fps + memory budget (cache the isometric renders, don't re-render per frame).

**Acceptance:** a held block shows a 3D cube with correct top/side/front faces; inventory shows blocks as isometric 3D icons and tools as flat icons; glint still renders; no frame-rate regression.

---

## 5. Settings tab — move Debug + Creative in, add a render-distance slider

**Symptom:** debug overlay and creative mode are only on F3/F4; want them in the in-game settings tab, plus a render-distance control there.

**Where:** the Options screen lives in `menus.js` (16-AUDIO AMENDS 01 §15.3), backed by `src/ui/options.js` (`DEFAULTS`, `KEY = claudecraft.options.v1`). Keybinds `debugOverlay:'F3'`, `gameMode:'F4'` (`src/constants.js:70`); `RENDER_RADIUS = 8` (`constants.js:23`).

**Fix:** add to the in-game Options tab (reachable from PAUSE):
- **Debug overlay** toggle → same action as F3.
- **Creative mode** toggle → same action as F4 (survival ⇄ creative).
- **Render distance** slider (e.g. 4–16 chunks) → drives `RENDER_RADIUS` at runtime (re-stream/unload chunks to the new radius live) and persists in `options.js`.
- Persist all three in `options.v1`; load at boot. Keep the F3/F4 keys as shortcuts (don't remove them) unless you'd rather the toggles be settings-only — either is fine, state which.

**Acceptance:** the Options tab has working Debug, Creative, and Render-distance controls; changing render distance visibly loads/unloads chunks and holds 60 fps at the chosen value; settings persist across reload; F3/F4 still work (or are cleanly retired if you chose settings-only).

---

## 6. Texture refinement pass — overall polish

**Symptom:** textures feel unpolished; want everything looking more designed and cohesive.

**Where:** procedural 16px textures baked in the atlas pipeline (`src/assets/atlas.js` + the per-block/-item painter functions).

**Approach (keep it 100% procedural — no downloaded/imitated assets):** a cohesive art pass over the painters — consistent palette + shading direction, better dithering/noise so faces read as material (stone grain, wood rings, ore fleck contrast, leaf depth), cleaner tool/item silhouettes with a subtle outline, and consistent edge/bevel lighting across blocks so they sit together. Do it as a reviewable sweep (before/after a few key blocks) rather than a rewrite; keep the 16px grid and the atlas layout stable so nothing else breaks.

**Acceptance:** side-by-side, the common blocks (stone/dirt/grass/wood/ores/sand) and core tools look noticeably more polished and cohesive; the atlas still builds; no tile misalignment; frame rate unchanged.

---

## Guardrails (all sections)
- One section at a time, commit each at its gate; base specs 01–06 frozen; log divergences in `DEVIATIONS.md`.
- 100% procedural assets (textures + the new 3D-icon renders); no downloaded/imitated art.
- Hold the perf budget: 60 fps, remesh ≤ 4 chunks/frame; cache the isometric icon renders; interpolate visuals without touching tick logic.
