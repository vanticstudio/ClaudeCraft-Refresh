# DEVIATIONS.md

Deviations, ambiguity resolutions, and conflict rulings made during implementation.
Items marked `> Adaptation:` in the specs are not repeated here — only decisions
the implementation added on top of them.

## Spec-conflict rulings (per CLAUDE.md §2 precedence)

1. **Water light opacity = 1**, not 2. 01 §5's comment says "water 2 (approx; 04
   owns the propagation rule)"; 04 §8 rule 3 and 06's acceptance ("3 blocks of
   water reads 12 beneath") both require 1. 04 owns lighting → 1.
2. **Heightmap "sky-terminating" test** unified as `opacity > 0 OR snow_layer OR
   cactus` so the generator's heightmap (02 §13.1 counts snow/cactus) and the
   runtime recompute agree byte-for-byte. Light stays correct either way because
   the straight-down 15 rule re-floods through opacity-0 cells.
3. **Carver determinism vs the 02 §14 early-out**: skipping a whole tunnel's
   simulation would desynchronize later draws from the shared per-origin-chunk
   stream when different chunks make different skip decisions. Each worm/ravine
   therefore gets a child stream derived from the origin-chunk stream; the
   origin stream only rolls counts/positions/parameters. Whole-tunnel AABB
   early-outs are then stream-safe. Verified: byte-identical chunks regardless
   of generation order.
4. **Ore Y-band acceptance**: 02 §9.3 distributions govern vein *origins*; the
   §9.2 vein walk drifts a few blocks, so ≤1 % of placed ore blocks sit just
   outside the band (e.g. coal slightly below Y32). Matches the algorithm as
   specced.

## Registry / blocks

5. Jack o'lantern face on all four side faces (no facing state; noted in 06 as
   acceptable simplification).
6. Chest gets a cosmetic facing state using the shared FACING convention (06
   defines none).
7. Door: single hinge; closed panel on the cell edge opposite facing, open =
   facing rotated 90° CW. `doorBox()` is shared by mesher + collision.
8. `dead_bush` placeable on sand **or dirt**; flowers/grass/saplings on
   grass_block or dirt.
9. Torch/ladder wall states: 1–4 = facing +Z/−Z/+X/−X, support on the opposite
   side (documented in `registry/blocks.js`).

## Rendering

10. Water/lava tiles are painted opaque; translucency is a per-vertex alpha
    (water 0.7, lava 1.0) so both fluids share one material. Ice bakes α 0.8
    into its tile and renders in the translucent bucket.
11. All custom shapes (torch, ladder, snow layer, cactus, fence, door, bed,
    farmland, crops) render in the cutout bucket regardless of their 06 §3 pass
    column — visually identical for opaque texels, one less material switch.
12. Torch renders as a 2/16 box with side-cropped tile UVs; wall torches offset
    toward the support block without tilt.
13. Fluid side faces don't crop UVs to the 14/16 surface height (invisible on
    the noise texture).
14. No biome tinting of grass/foliage/water — the specs' render path defines no
    tint pipeline; grass_top is painted plains-green.
15. Mob textures: procedural 16×16 canvases per body-role following 05 §16.2
    palettes; the face detail sits on the model's +Z face. Sheep wool tint is a
    material color multiply.
16. Inventory icons use flat atlas tiles for blocks (06 §8.2's 48×48 isometric
    WebGL pre-render skipped); items use their sprite tiles.
17. F3 draw-call/triangle counters reflect the last render pass of the frame
    (world + viewmodel are separate passes; `renderer.info` resets per pass).
18. EnvLights lives inside `render/Sky.js`; the mob AI/goals live in
    `entities/mobs/{ai,models,passive,index}.js` instead of an `ai/` subdir —
    same responsibilities, fewer files.

## Gameplay

19. Sleep completes once started (getting out of bed mid-skip not implemented);
    the spawn point is still set on first click per 06 §5.7.
20. Item pickup is instant inside the expanded pickup box (the ~3-tick fly-to-
    player animation is skipped).
21. Explosion exposure sampling = 8 AABB corners + center (the adaptation 05
    §12.3 itself suggests).
22. Falling blocks are persisted as falling-block entities rather than being
    written back as solid blocks on save (they resume falling on load).
23. Autosave serializes all modified chunks synchronously; heavy-edit sessions
    can show one ~40–80 ms tick at the 30 s autosave boundary.
24. Bed "monsters nearby" check uses a single AABB (±8 horizontal / ±5 vertical)
    without wall-occlusion, per 04 §14.2's box semantics.
25. Egg-throw chick spawning (1/8) is implemented (06 lists it as an optional
    hook).
26. Player arrows use inaccuracy 1 (05 §11); skeleton arrows frequently miss at
    range with Normal inaccuracy 6 — authentic to MC.

27. **Creative item transactions are all-or-nothing.** 18 §5.3. In creative, an
    item use that would consume a source stack and mint a product applies the
    WORLD-side effect (potion effect, bucket scoop, dragon-breath cloud shrink,
    composter layer) but neither spends the source nor mints the product. Cited
    by `interaction.js` `fillBucketStack` / `drinkPotion` / `fillBottle` (x2) and
    `useComposter` **by name**, not by number — the rulings are one running
    sequence and 5 is the jack o'lantern face entry.

28. **07 §9.3 piston entity push bypasses collision resolution.**
    `redstone/PistonMover.js:pushEntities` displaces a pushed entity with a direct
    `e.pos` write (`shove`) rather than `moveEntity`, so the entity is not
    collision-resolved and can be pushed into a wall. Item entities are excluded
    from the push entirely, which §9.3 does not exempt. Entities are now shoved
    exactly **once** per push (hits are deduped into a `Set` across overlapping
    push cells — previously an entity straddling two collinear push cells was
    flung 2 blocks). Swapping in a collision-resolved move is a behavioural
    change beyond the defect, so it is deferred, not applied.
29. **01 §12's `ceil(dist / 0.5)` projectile sub-step is SUPERSEDED, not
    implemented.** `moveEntitySubstepped` and `getCellBox` were removed from
    `physics/collision.js` — both had zero callers tree-wide. Projectiles advance
    with `pos += vel` and resolve collisions themselves at three fidelities:
    `Arrow` / `ThrownProjectile` (egg, snowball, ender_pearl) / `ThrownPotion`
    sweep the segment with `raycastBlocks`, which is exact rather than sampled and
    genuinely supersedes the sub-step; `GhastFireball` and `WitherSkull`
    (independent classes, **not** `ThrownProjectile` subclasses) point-sample
    `getBlock` at the destination cell and can tunnel through a thin wall at
    speed; `EyeOfEnder` does no block collision at all, by design.

## Verified against acceptance checklists (headless Chrome, 2026-07-17)

- Worldgen: deterministic across generation order and generator instances;
  2.7 ms/chunk average (budget 12); sea-level/bedrock/water-guard/lava-flood
  rules hold; ore bands correct.
- Movement: walk 4.317 / sprint 5.612 / sneak 1.295 m/s (exact); jump apex
  1.252; sneak edge-guard holds; ladder climb ≈2.35 m/s; 10-block fall = 7 HP;
  water cancels fall damage.
- Lighting: sealed cave 0/0; torch 14→13 adjacent→12 diagonal; removal restores
  prior values exactly; day/night causes zero remeshes.
- Time: celestialAngle(6000)=0, (18000)=0.5; skyDarken 0 noon / 11 midnight.
- Mining: stone+wooden pick 23 ticks; drops spawn; durability spends; instant
  breaks skip the inter-block delay.
- Mobs: zombie acquires/paths/attacks; skeleton strafes, draws 20 ticks, fires
  every 60; creeper swells and craters terrain; explosion damage + knockback
  reach the player; night packs spawn only in darkness ≥24 blocks away.
- Survival: exhaustion→saturation→hunger drain exact; bread +5 hunger; eating
  takes 32 ticks; starvation floors at 1 HP; XP orbs magnet + collect.
- Systems: water spreads exactly 7 and drains on source removal; furnace smelts
  in 200 ticks and swaps lit/unlit; crafting matcher handles shaped, shapeless,
  mirrored, and 2×2-in-3×3; sand falls and re-lands; TNT chains; doors toggle;
  beds deny by day, skip to dawn at night and advance the day counter.
- Save/load: seed, worldTime, block edits, torch light, chest contents, damaged
  tools, XP, hunger, position, entities all restored after reload; unmodified
  chunks regenerate identically.
- Performance: 95 fps minimum (avg 109) sprint-flying 844 blocks at render
  distance 8 in headless Chrome/SwiftShader; ~777 k scene triangles; no
  geometry leak after a fly-out-and-back pass.
