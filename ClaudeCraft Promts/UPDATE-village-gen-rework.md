# UPDATE PROMPT — Village generation: heavy rework

**For:** the build executor (Claude in Ultra Code), in the **ClaudeCraft** repo root.
**Type:** heavy rework of one module — `src/world/gen/village.js`. Base specs 01–06 frozen; conform to `ClaudeCraft Promts/12-VILLAGES.md` (esp. §3.1 building templates, §3.2 layout, §5 palette); log divergences in `DEVIATIONS.md`. Single builder, commit at the gate.

## Symptom
Villages are tiny, rare, cramped, and malformed: identical little boxes jammed together, clipping into the terraced terrain, a dark sunken farm pit, doors facing the wrong way. See the reference screenshot.

## Keep this — it's correct
The **deterministic multi-chunk stamp architecture is sound; do not rewrite it.** Preserve: village = pure function of anchor-chunk seed (`villageForRegion`/`buildLayout`); phase-ordered op list (1 CLEAR → 2 FOUNDATION → 3 PATH → 4 PIECES → 5 LAMP); each chunk replays the same ops and writes only its own cells (`stampVillages`); no cross-chunk block reads (terrain via `ctx.heightAt`); never overwrite bedrock. **The bug is the layout CONTENT and terrain adaptation, not the stamping.**

## Root causes (verified in `village.js`) → what to fix

### 1. Every building is one tiny 5×5×2 flat box
`buildLayout` hardcodes `bw = 5, bd = 5`; `buildHouse` builds a height-2 perimeter with a flat plank roof for **every** type — `type` only swaps the workstation. So all houses are identical cookie-cutter boxes.
**Fix:** implement the real template set from **12-VILLAGES §3.1** — multiple footprints and shapes (small house, large house, library, farm, church, smithy, butcher, fletcher, etc.), each with its own width/depth (varying, larger than 5×5 where the spec says so), **interior height ≥ 3**, proper **pitched/stepped roofs** (not flat slabs), windows, and per-type interior furnishings. Draw templates as the spec's layer diagrams. Variety is the point — a village should read as a village.

### 2. No terrain leveling → clipping and floating
Each building uses a single corner height `yb = ctx.heightAt(ox, oz)` with **one** foundation layer (`found(x0+dx, yb-1, z0+dz, …)`). The relief-≤3 accept still leaves buildings cut into hillsides and floating on the downhill side.
**Fix:** for each accepted footprint, **level a flat platform**: pick a target grade (e.g. median/most-common `heightAt` over the footprint), CLEAR everything above it inside the footprint, and **fill a foundation DOWN to terrain** on every column (foundation posts / wall of `pal.floor` from `yb-1` down to the local ground) so nothing floats and nothing clips. Tighten the accept test so a building only lands where it can be leveled cleanly (or always level it and drop the strict relief reject). Do the same for paths — they should follow grade smoothly, not float.

### 3. The farm is a dark sunken pit
`buildHouse` type `'farm'` (H=1) clears a volume and lays FARMLAND + WHEAT + a center WATER strip with **no border and below grade** → the black pit with a blue channel in the screenshot.
**Fix:** build the farm **at grade** as a proper plot: a bordered field (fence or path/log frame) on leveled ground, tilled farmland with crops at multiple growth stages, a central water source one block *into* the soil (not a trench pit), a composter on the edge, and enough light (the pit is dark — keep it open to sky / add a torch). No digging a dark hole.

### 4. Doors face the wrong way and render wrong
`buildHouse` receives `doorFrom` (the connecting path cell) **but never uses it** — the door is always on the −Z edge center. And lower/upper door use the same id ("state simplified").
**Fix:** place the door on the wall edge **facing `doorFrom`/the nearest path**, with a 2-block clear approach to the path. Emit the correct door **state** for lower and upper halves (facing + half + hinge) per 06's door block, so it renders and opens correctly.

### 5. Cramped + rare
Arms are "shorter than spec" (`len = 20 + rngInt(18)`), buildings sit only 4 blocks off the path (`sx*(2+2)`) with 1-block AABB margins, and spawn is 1 candidate per 32×32-chunk `REGION` × `rng()<0.40` × biome+height gate.
**Fix:** longer arms and a larger min gap between buildings (bump the AABB margin so they don't touch), set the building offset so the door approach clears the path, and **tune findability** — either shrink `REGION`, raise the placement probability, or (preferred) keep the spacing but make villages big enough (more buildings actually placed, bigger footprints) that they're obvious when found. Aim for the spec's building count actually landing (few get rejected once leveling replaces the strict relief reject).

## Investigation steps (do first)
1. Force-spawn a village near origin (temp: make `villageForRegion` return a candidate at a fixed nearby anchor) so you can iterate without hunting.
2. Fly the result and catalog every defect against §3.1/§3.2: footprint sizes, roof shape, wall height, floating/clipping columns, the farm, door facing, spacing, path grade.
3. Rework `buildLayout` + `buildHouse` (or split templates into a `villageTemplates` table) per the fixes above, keeping the op-phase/determinism contract intact.
4. Remove the force-spawn; verify natural villages.

## Acceptance (browser)
- [ ] A found village has **varied** buildings (different sizes/shapes/roofs), not identical boxes; interiors are ≥3 high and a villager fits.
- [ ] Every building sits **flush on the ground** — no floating, no clipping into hillsides; foundations fill to grade on slopes; paths follow terrain smoothly.
- [ ] The farm is an **at-grade, lit, bordered** plot with crops + water + composter — no dark sunken pit.
- [ ] Doors **face the path** with a clear approach and open correctly (correct lower/upper state).
- [ ] Buildings have real gaps between them; the village reads as a proper settlement, and is findable in plains/savanna/desert/taiga.
- [ ] Villagers spawn inside/near buildings; bell, well, and meeting point intact.
- [ ] **Determinism preserved:** the same seed regenerates the identical village; crossing chunk borders shows no seams (the multi-chunk stamp still agrees byte-for-byte).
- [ ] Trades/professions still work (E4 books, E9 cure) — the rework is worldgen only; don't break the villager/station wiring.

## Guardrails
- Keep the pure-function/phase-ordered/in-chunk-only stamp contract (§2.4) — determinism is non-negotiable; test cross-border agreement.
- Conform to 12-VILLAGES §3.1/§3.2/§5; base specs 01–06 frozen; log deviations in `DEVIATIONS.md`.
- Hold the perf budget (worldgen off-thread; remesh ≤ 4 chunks/frame). 100% procedural.
