# UPDATE PROMPT — Sky/Sun render bug + persistent grey blob

**For:** the build executor (Claude Opus 4.8 in Claude Code), working in the existing **VoxelCraft** codebase.
**Type:** code bug-fix / visual polish. **Not** a spec change.

You are fixing two rendering bugs in the already-shipped VoxelCraft build. Both are cases where the **code has drifted from the frozen base spec `04-TIME-LIGHT-WEATHER.md`** (and `01-ARCHITECTURE.md`). The spec describes the *intended* behavior; the running code does not match it. Make the code match the spec, and where you must diverge, log it in `DEVIATIONS.md`.

**Hard rules (unchanged):** base specs `01`–`06` are frozen documentation — do **not** edit them. Fix the code only. Keep the v1 perf budget (60 fps; time-of-day visuals are O(1)/frame per `04 §15` — never remesh/relight on a sky change). Textures stay 100% procedural (no downloaded art). Log any code/spec divergence in `DEVIATIONS.md`.

---

## Bug A — The sun renders as a hard opaque square: doesn't fade, and bleeds through clouds and tree leaves

### Observed (from live build, dusk)
The sun is a **hard-edged bright white/grey square** with visible grey banding. It does **not** dim or warm toward sunset (sky is orange but the sun stays blown-out white), and it **draws over/through** the cloud plane and through **tree-leaf** blocks that are physically in front of it — you can see the square through the canopy and clipping across the clouds.

### Intended behavior — `04 §5` (make the code match this exactly)
- **`04 §5` (sky group):** all sky objects live in a `skyGroup` repositioned to `camera.position` each frame, rendered **first** with `renderOrder ≤ −1`, and **every** sky material has `depthWrite: false` and `fog: false`. `R_SKY = 400`, camera far ≥ 600.
- **`04 §5.2` (sun):** `PlaneGeometry` half-size `0.3·R_SKY = 120`, positioned at `sunDir·R_SKY`, `lookAt` camera. Material = `MeshBasicMaterial`, **additive blending**, `transparent: true`, texture = **32×32 procedural white-yellow `#FFFFE5` rounded square with a soft 4-px alpha falloff** (vanilla sun is a soft square, not a hard-edged one and not a disc). Visible only while `sunDir.y > −0.3`; alpha `×(1 − rainLevel)`.
- **`04 §6` (tint/intensity):** the sky/sun warm and dim over the day via the `sunIntensity` keyframe column (1.00 midday → 0.35 at 12786 → 0.06 at midnight) plus the sunset horizon band (`04 §5.5`). The sun billboard must be modulated by this so it fades and warms at dusk — it must not stay full-white at sunset.

### Most-likely root causes — check in this order
1. **Blending is `Normal`, not `Additive`.** A normal-blended quad with an imperfect alpha texture shows exactly this "hard grey/white square with banding." Set `material.blending = THREE.AdditiveBlending`. Additive means the transparent border adds ~nothing and the core glows into the sky instead of stamping a square.
2. **The sun texture has no real alpha falloff** (alpha channel flat/opaque, or drawn as a solid fill). Rebuild the 32×32 procedurally per `§5.2`: white-yellow core, **radial/rounded-square alpha ramp to 0 over the outer ~4 px**, `premultiplyAlpha` consistent with the blend mode. The grey banding is the hard alpha edge beating against the cloud plane.
3. **Depth is wrong so leaves/clouds don't occlude it.** The sun should sit in `skyGroup` (drawn first, `depthWrite:false`) so opaque **terrain draws over it** afterward via normal depth testing — leaves in front must occlude the sun. If the sun shows *through* leaves, check: (a) the sun isn't accidentally `depthTest:false` **and** on a high `renderOrder` that forces it last (that combo paints it over everything); it should be `renderOrder ≤ −1`, `depthWrite:false`, `depthTest:true`. (b) Leaf blocks must be in the **opaque/alpha-tested (cutout)** mesh pass with `depthWrite:true`, not the translucent pass — foliage rendered as translucent with `depthWrite:false` will fail to occlude the sky. Confirm the leaf material is alpha-**test** (cutout), not alpha-**blend** (see `01 §8.7` chunk shader / material passes).
4. **Sun not modulated by `sunIntensity`/sunset tint** (`§6`) — multiply the sun material color/opacity by the per-frame `sunIntensity` (and warm it via the sunset band window) so it fades and reddens at dusk instead of staying blown-out.
5. **Cloud interaction (`04 §13`):** clouds are a translucent plane at `y=110`, `opacity 0.75`, `depthWrite:false`, `fog:false`, rendered **after** the sky group and **before** terrain. If the sun banding appears *on* the clouds, verify draw order is sky-group → clouds → terrain, and that both the sun and clouds keep `depthWrite:false` so they don't z-fight. The sun bleeding "through" a cloud is expected to look like *soft glow*, not a hard square — fixing (1)+(2) resolves the banding.

### Fix
Restore `§5.2` exactly: additive blend, soft-alpha 32×32 texture, `renderOrder ≤ −1`, `depthWrite:false`, `depthTest:true`, alpha `×(1−rainLevel)`, color/opacity `× sunIntensity` (§6) with sunset warming. Verify leaf blocks are in the cutout pass (`01 §8.7`) so they occlude sky objects. Apply the identical blend/alpha/depth discipline to the **moon** (`§5.3`, but **normal** blending per spec) and **stars** (`§5.4`, additive).

---

## Bug B — A persistent grey/white blob sits at spawn and never disappears

### Observed
Turning around at spawn reveals a **flat, untextured grey/white square** floating near ground level that **never culls or moves** (a second, taller stone-textured artifact is also visible off to the side). A blank grey quad is the classic signature of either a **mis-positioned celestial billboard** or an **entity/particle rendered with a missing texture**.

### Diagnose — identify which mesh it is first
Have the renderer name the object (temporary `object.name`/material inspect, or click-ray in a debug build). It will be one of:

1. **A mis-parented celestial quad (most likely).** `04 §5.3` describes the **moon** as a light-grey `#C3C3C3` square (`MeshBasicMaterial`, normal blend, half-size 80). `§5.4`/`§5.3` require sun+moon+stars to be parented under a **single pivot** with `pivot.rotation.z = celestialAngle·2π`, sun at local `(0, R_SKY, 0)`, moon at `(0, −R_SKY, 0)`, and the whole `skyGroup` re-centered on `camera.position` each frame. If the moon (or sun) is **not** parented to that pivot / not re-centered on the camera, it renders as a stray grey square parked at world origin or on the horizon that never tracks the sky — exactly this symptom. **Fix:** correct the pivot parenting and per-frame `skyGroup.position.copy(camera.position)` so the moon rides the sky sphere and drops below the horizon (`visible` gate) on schedule. Also enforce the `dir.y > −0.3` visibility gate so it hides below the horizon.
2. **An untextured entity / dropped-item / particle billboard (missing-texture placeholder).** A blank quad with no texture = a material whose `map` failed to load or an atlas-UV lookup returned empty → three.js shows the flat base color (grey/white). Check the entity/item-entity render path (`01 §13` entity system, `§14` sky & environment rendering) and the particle system: a spawn-time particle or a dropped item at the spawn point with a bad/missing atlas region will hang as a static quad. **Fix:** ensure every entity/particle material resolves a valid procedural texture/atlas UV; cull item entities/particles on their TTL; verify the spawn routine isn't emitting a stray debug/placeholder mesh.
3. **A leftover debug/placeholder mesh.** Grep for any hard-coded `PlaneGeometry`/`BoxGeometry` test object, "placeholder", "TODO", or a default-material mesh added at init and never removed. Remove it.

### The second (stone-textured, tall) artifact
The upright stone-textured slab is likely either (a) a **mis-meshed block/entity** (an entity model falling back to a cuboid with the stone/cobblestone atlas tile) or (b) a **greedy-mesh/geometry glitch** at a chunk seam. Identify the object the same way; if it's an entity model fallback, fix the model/texture binding; if it's terrain geometry, check the chunk mesher (`01 §8`) for a degenerate face at that position.

### Fix
Once identified: if celestial → fix pivot parenting + per-frame camera-centering + horizon visibility gate (`04 §5.3/§5.4`); if entity/particle/placeholder → bind a valid procedural texture and enforce culling/TTL, or delete the stray mesh. The blob must be gone at spawn and the moon must correctly rise/set opposite the sun.

---

## Acceptance tests (browser-verifiable)
- [ ] At midday the sun is a **soft** warm square that glows into the sky (no hard grey edge, no banding); tree leaves in front **occlude** it; it does not stamp over the cloud plane.
- [ ] From ~11000→13000 ticks the sun **warms and dims** toward the horizon (matches the `§6` `sunIntensity` fade) and disappears below `dir.y = −0.3`; the sunset band (`§5.5`) shows.
- [ ] The **moon** rises opposite the sun, tracks the sky sphere centered on the camera, and sets on schedule — it is never a static square parked in the world.
- [ ] No grey/white placeholder quad exists at spawn from any camera angle; turning 360° at spawn shows clean sky/terrain only.
- [ ] The tall stone artifact is gone (entity model bound correctly, or the terrain seam fixed).
- [ ] Perf unchanged: sky/sun/moon updates remain O(1)/frame (`04 §15`); no new per-frame allocations.

## Guardrails
- Base specs `01`–`06` stay frozen; this is a **code** fix to match them. Log any intentional divergence (e.g. cloud Y, sun size) in `DEVIATIONS.md`.
- Conform to `04 §5` (sky group / sun / moon / stars), `04 §6` (tint), `04 §13` (clouds), `01 §8.7` (chunk/leaf material passes), `01 §13`/`§14` (entities, sky & environment rendering).
- Procedural textures only; no downloaded assets. Keep the 60 fps budget.
