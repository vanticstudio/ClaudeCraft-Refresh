# DEVIATIONS.md

Deviations and ambiguity rulings. (The base-spec `.md` files were removed from
the working tree during repo cleanup; the pre-UPDATE deviation log for the
initial build lives in git history — `git show 8441ac9:DEVIATIONS.md`.)

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
