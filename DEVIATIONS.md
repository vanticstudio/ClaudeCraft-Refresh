# DEVIATIONS.md

Deviations and ambiguity rulings. (The base-spec `.md` files were removed from
the working tree during repo cleanup; the pre-UPDATE deviation log for the
initial build lives in git history — `git show 8441ac9:DEVIATIONS.md`.)

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
