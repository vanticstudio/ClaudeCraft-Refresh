# UPDATE — Fix the Crafting / Inventory UI (survival inventory + crafting table)

**You are fixing the crafting/inventory UI in the existing, already-shipped VoxelCraft codebase.** This is a
**code fix**, not a new feature and not a spec change. The base specs `01`–`06` are FROZEN documentation of the
game as built; do not edit them. Where the running code has drifted from the spec, the **spec is the intended
behavior** and you bring the code back to it. Log any place where you must diverge from a base spec in
`DEVIATIONS.md`.

Owning modules (from `01-ARCHITECTURE.md` §2 module map):
- `src/ui/containers.js` — Inventory, crafting-table, furnace, chest screens *(owner: 06)*. **Primary file.**
- `src/ui/style.css` — all UI styling; `image-rendering: pixelated`; the GUI-scale CSS var.
- `src/registry/items.js`, `src/registry/blocks.js` — registries; the recipe list/resolver lives with these or in
  `containers.js`. **Find where the recipe table + matcher actually are before editing** (grep for the §10 recipe
  patterns like `PP/PP`, `stick`, `crafting_table`, `matchRecipe`, `resolveRecipe`, `shaped`, `shapeless`).
- `index.html` `#screens` div — the 2D grid of slot `<div>`s (structure owned by 06; drag/click semantics in 06).

Governing spec sections you MUST conform to (cite these in commits):
`06 §9` crafting system, `06 §10` full recipe list, `06 §14.1` inventory layout & slot indices, `06 §14.2` click
semantics + shift-routing, `06 §14.3` hotbar, `06 §15.3` screens, `06 §8.2` icon pipeline; `03 §3` input (E/F),
`03 §16.3` UI-open/pointer-lock, `03 §23` player-owned HUD; `08 §7` (7.1) offhand slot + the `08` AMENDS to
`06 §14.1`/`§14.2` (offhand = slot **45**, rendered left of the 2×2 craft grid, `F` swaps hovered↔offhand).

---

## 1. Summary of the problem

On the live build the survival inventory screen renders **jumbled** and crafting **does not resolve correctly**.
There are two independent failure classes and you must fix **both**:

1. **Layout geometry is wrong.** The 2×2 personal crafting grid is jammed against the armor column with **no
   result slot and no arrow**, the offhand slot is mis-placed, and a large grey **dead-space** sits in the
   upper-right where the grid + arrow + result + player preview belong. Slot rectangles are overlapping / using a
   bad origin.
2. **Recipe resolution is broken.** Recipes fail to match unless items sit in an exact corner (the shaped matcher
   is **not normalizing the ingredient pattern's position** within the grid), and/or the 3×3 crafting-table grid is
   **not wired to the same resolver**, and/or the result slot **does not recompute** when the grid mutates. Per
   Jake: "you can't craft properly in a 2×2 then a 3×3 in crafting table."

Fix the geometry so nothing overlaps and no dead-space remains, and make **one shared resolver** serve both grids
with correct shaped-offset/mirror normalization and shapeless multiset matching, recomputing on every change.

---

## 2. Correct SURVIVAL INVENTORY screen layout (opened with `E`)

Slots present (per `06 §14.1` + `08 §7.1` amendment): **2×2 crafting grid (40–43) + result (44)**, **4 armor
(36–39)**, **1 offhand (45)**, **3×9 main storage (9–35)**, **9 hotbar (0–8)**, plus a **player preview** panel and
the title "Inventory".

### 2.1 Geometry model (use this unit system)

Work in **GUI pixels** on a reference panel **176 × 166 GUI-px**, then let the existing GUI-scale var (2×) scale
the whole panel uniformly — do NOT hand-scale individual slots. One **slot cell = 18 GUI-px pitch** = a 16×16 icon
with a 1 px gutter on each side. A slot's on-screen rect is its 16×16 icon; place each slot `<div>` by its
**top-left inner corner** `(x, y)` from the tables below (these are the canonical Java 1.20 survival-inventory
coordinates — reuse them verbatim so the layout reads as Minecraft). `(approx)` only where noted.

Row/col helper for the storage + hotbar blocks: `x = 8 + col*18`, `y = originY + row*18`.

### 2.2 Exact slot coordinates (top-left inner corner, GUI-px)

| Group | Slot index | x | y |
|---|---|---:|---:|
| Armor: helmet / chest / legs / boots | 39 / 38 / 37 / 36 | 8 | 8 / 26 / 44 / 62 |
| Offhand *(08 §7.1)* | 45 | 77 | 62 |
| Crafting grid 2×2 (TL,TR / BL,BR) | 40,41 / 42,43 | 98,116 / 98,116 | 18,18 / 36,36 |
| Craft **result** (take-only) | 44 | 154 | 28 |
| Main storage 3×9 | 9–35 | 8 + col*18 | 84 / 102 / 120 |
| Hotbar 1×9 | 0–8 | 8 + col*18 | 142 |

- **Arrow** (decorative, points grid → result): sprite region ≈ `x 128–150, y 26–32`, a right-pointing arrow
  procedurally drawn (no downloaded art). It sits **between** the 2×2 grid and the result slot — its absence is the
  visible bug.
- **Player preview** panel: box `x 26–75, y 8–78 (approx)`, between the armor column and the offhand/grid. Render
  the existing player view-model or, if none is cheap here, a flat placeholder silhouette — **but the panel must
  occupy that region so it is not dead grey space.** Do not leave the upper area empty.
- **Offhand empty state**: draw a faint shield-silhouette placeholder icon when slot 45 is empty (`08 §7.1`).
- **Title** "Inventory" top-left of the panel, above the armor column.

### 2.3 Plan diagram (survival inventory)

```
 +-------------------------------------------------------------+
 |  Inventory                                                  |
 |  [helmet]                                                   |
 |  [chest ]     +-----------------+        [40][41]           |
 |  [legs  ]     |  player         |        [42][43]  =>  (44) |   <- 2x2 grid, arrow, RESULT
 |  [boots ]     |  preview        |   [45offhand]             |
 |               +-----------------+                           |
 |                                                             |
 |   [ 9][10][11][12][13][14][15][16][17]                      |
 |   [18][19][20][21][22][23][24][25][26]   <- 3x9 storage     |
 |   [27][28][29][30][31][32][33][34][35]                      |
 |                                                             |
 |   [ 0][ 1][ 2][ 3][ 4][ 5][ 6][ 7][ 8]   <- 9 hotbar        |
 +-------------------------------------------------------------+
```

Left→right in the top band must read: **armor column → player preview → offhand → 2×2 grid → arrow → result.**
The current build collapses the grid leftward against the armor and drops the arrow/result — that is exactly what
you are correcting. No two slot rects may overlap; no grey dead-space may remain in the upper-right.

---

## 3. Correct CRAFTING-TABLE screen layout (right-click a crafting table)

Slots: **3×3 grid + result**, plus the player's **3×9 storage** and **9 hotbar**. **No armor, no offhand, no player
preview** on this screen (`06 §14.1`: container screens show only the player's 27+9 slots).

### 3.1 Exact slot coordinates (top-left inner corner, GUI-px; reference panel 176×166)

| Group | x | y |
|---|---:|---:|
| Crafting grid 3×3 (cols) | 30, 48, 66 | rows 17, 35, 53 |
| **Arrow** (grid → result) | region ≈ 90–110 | 33–39 |
| **Result** (take-only) | 124 | 35 |
| Main storage 3×9 | 8 + col*18 | 84 / 102 / 120 |
| Hotbar 1×9 | 8 + col*18 | 142 |

The 3×3 grid indices should be a contiguous run (e.g. table slots `1..9` row-major, result `0`), mapped so the
**same resolver** (§4) reads them. Confirm the mapping matches whatever `containers.js` already assigns; do not
renumber player inventory indices (0–45 are fixed by `06 §14.1`/`08 §7`).

### 3.2 Plan diagram (crafting table)

```
 +--------------------------------------------+
 |  Crafting                                  |
 |        [ ][ ][ ]                           |
 |        [ ][ ][ ]      =>      (result)     |   <- 3x3 grid, arrow, take-only result
 |        [ ][ ][ ]                           |
 |                                            |
 |   [ 9][10]...[17]                          |
 |   [18][19]...[26]   <- shared 3x9 storage  |
 |   [27][28]...[35]                          |
 |   [ 0][ 1]...[ 8]   <- shared 9 hotbar     |
 +--------------------------------------------+
```

On close (`06 §5.4`), 3×3 grid contents return to the player inventory (overflow drops at the player).

---

## 4. Shared recipe resolver (the core of the second bug)

There must be **exactly one** resolver function, called by **both** the 2×2 and the 3×3 grids. Do not maintain two
matchers. Do not invent a new recipe format — consume the existing `06 §10` registry data (`shaped` = pattern rows
`/`-separated + a `key` char→item-id map; `shapeless` = ingredient list). If two resolvers exist today, delete one
and route both grids through the survivor.

### 4.1 Function contract

```
resolveCraft(gridItems, W, H) -> { outId, outCount, consume[] } | null
```
- `gridItems` = flat array of `W*H` slot stacks (`null` for empty). `W×H` is `2×2` for the inventory grid and
  `3×3` for the table. **The same function handles both by size** — a 2×2 recipe MUST resolve inside a 3×3 grid
  (see 4.4).
- Returns the output stack + which grid cells to decrement (one item each), or `null` for no match.

### 4.2 Shaped matching — pattern normalization (this is the classic root cause)

Per `06 §9` and Java rules (minecraft.wiki: a shaped recipe's shape "can be moved to any position within the grid"
and many are matched "horizontally" mirrored):

1. Compute the **minimal bounding box** of the grid's non-empty cells (trim all empty rows and columns).
2. Compute the recipe pattern's own trimmed bounding box (trim its empty rows/cols too).
3. Match **cell-by-cell** between the two trimmed boxes. **Position within the grid is irrelevant** — a `P/P`
   (stick) recipe matches whether the two planks sit top-left, center, or bottom-right of a 3×3. This offset
   normalization is what is missing when "recipes only match in a corner."
4. Also test the pattern **mirrored horizontally** (needed for axe / hoe / bow — the `Mirror ✔` rows in
   `06 §10.2`). Orientation beyond horizontal mirror is NOT matched (no rotation).
5. Empty pattern cells must correspond to **empty** grid cells inside the bounding box (a filled cell where the
   pattern is blank → no match).
6. "Any planks" (`P`) / "any log" ingredient classes accept all three wood variants mixed freely; planks-consuming
   recipes output the **variant of the input** where `06 §10` says so (e.g. `log → 4 planks` of the same species).

### 4.3 Shapeless matching

Multiset (bag) equality: the grid's non-empty stacks, compared **ignoring position**, must equal the recipe's
ingredient list (same items, same counts-of-distinct). Order-independent. Applies to `06 §10` shapeless rows
(planks-from-log, `coal_block → 9 coal`, bone_meal, sugar, book, flint_and_steel, etc.).

### 4.4 The 2×2-in-3×3 requirement (explicit)

Every recipe whose **trimmed pattern bounding box fits within 2×2** must resolve in **both** grids. Concretely:
`stick (P/P)`, `crafting_table (PP/PP)`, `torch (C/S)`, `shears (.I/I.)`, `sandstone/snow_block/wool (SS/SS)`, and
the 2×2-eligible shapeless recipes all work in the personal grid **and** anywhere inside the 3×3 table. Recipes
whose trimmed box is larger than 2×2 (`furnace CCC/C.C/CCC`, `chest`, `ladder`, `door`, 3×3 mineral blocks, armor,
`bow`, etc.) resolve **only** in the 3×3 table. Add this to your acceptance run (§7).

### 4.5 Result slot behavior

- The result slot is **virtual**: `resolveCraft` is re-run and the result preview re-rendered on **every** grid
  mutation (any place / pick-up / split / shift-move touching a grid cell). Failing to re-run on mutation is a
  distinct bug from the matcher — fix both.
- **Taking the result** (left/right-click on slot 44 / table result) crafts **once**: it consumes **exactly one**
  of each item named in `consume[]`, then immediately re-resolves (so a fresh preview appears if inputs remain).
  The result slot is **take-only** — it never accepts placed items, and clicking it with a compatible cursor stack
  merges the crafted output onto the cursor (up to max stack) rather than depositing.
- No container-item returns are needed (no in-scope recipe uses buckets).

### 4.6 Shift-click on the result = craft-max loop

Per `06 §9` / `§14.2`: shift-clicking the result crafts **repeatedly** until an ingredient runs out **or** the
player inventory is full; each crafted output stack routes to the inventory **hotbar-first, then main** (`06 §14.2`
shift-routing "Craft result → craft max, route to player inventory (hotbar first)"). Stop cleanly when the next
craft cannot be fully placed.

### 4.7 Performance

Resolver runs only on grid mutation (not per frame). Linear scan over the `06 §10` recipe list is fine (a few
dozen recipes). Keep it well under a frame; do not rebuild the recipe table on every call — build it once at
startup alongside the registries.

---

## 5. Click / drag / transfer semantics (verify against `06 §14.2`)

Implement/confirm this table exactly (cursor = the stack "held" by the mouse):

| Input | Context | Behavior |
|---|---|---|
| Left click | cursor empty | pick up whole stack |
| Left click | cursor = same item | merge into slot up to 64; remainder stays on cursor |
| Left click | cursor = different item | swap cursor ↔ slot |
| Right click | cursor empty | pick up `ceil(count/2)` (split-half) |
| Right click | cursor holds item | place exactly 1 into empty/same-type slot (respect max stack) |
| Left/Right on **result** | — | craft once; output merges onto cursor if same type & fits (take-only, never deposits) |
| Shift + left click | any slot | move whole stack to the "other" region (routing below) |
| Double left click | cursor holds item | collect all matching stacks on screen onto cursor up to 64 |
| `1`–`9` | hovering a slot | swap hovered slot ↔ hotbar slot n−1 |
| `F` | hovering a slot | swap hovered slot ↔ **offhand (45)** *(08 §7 / 06 §14.2 amendment)* |
| `Q` / Shift+`Q` | hovering a slot | drop 1 / whole stack as thrown item |
| Click outside panel | cursor holds item | left = drop whole cursor; right = drop 1 |
| `Esc` / `E` | any screen | close; craft-grid + cursor contents return to inventory (overflow drops) |

**Shift-click routing (player inventory screen):** hotbar ↔ main; armor items go to their armor slot first from
either region; from an armor slot → main; a grid result → craft-max into inventory (hotbar first). Right-click
drag-painting is intentionally out of scope (`06 §14.2` adaptation) — do not add it; right-click-place-one covers
it.

**Likely-broken items to check specifically:** (a) the result slot accepting placed items (it must not); (b) result
not merging correctly onto a matching cursor; (c) `F`-swap not wired in the inventory screen (only in-world);
(d) armor slots accepting the wrong item type (they accept only their piece); (e) shift-click into the 2×2/3×3 grid
not re-triggering resolve.

---

## 6. Root-cause diagnostic checklist (do these in order; reproduce → fix → verify each)

1. **Slot rect origin / overlap (LAYOUT).** Inspect how `containers.js` positions the survival-screen slot `<div>`s.
   The cramped render + dead-space means the crafting grid, arrow, and result are computed from a wrong origin or a
   missing offset. Re-anchor every group to the §2.2 coordinates; confirm in the browser that armor, preview,
   offhand, 2×2 grid, arrow, and result occupy their own non-overlapping rects and the upper-right grey area is
   gone.
2. **Grid → slot-index mapping.** Verify the 2×2 grid cells map to indices 40–43 and result to 44; verify the 3×3
   table cells map to a contiguous run the resolver reads. A mis-map makes items appear in the grid but never feed
   the matcher.
3. **Missing offset normalization in the shaped matcher (RESOLUTION).** This is the top suspect for "only matches in
   a corner." Confirm the matcher trims empty rows/cols of BOTH the grid selection and the pattern before comparing
   (§4.2). Add it if absent.
4. **3×3 not wired to the shared resolver.** Confirm the table screen calls the *same* `resolveCraft` with `W=H=3`,
   not a separate/stub function. If a second matcher exists, unify.
5. **Result not recomputing on mutation.** Confirm every grid-cell change re-runs the resolver and repaints the
   result preview (§4.5). If the result only updates on open, fix the mutation hook.
6. **2×2 recipes failing inside 3×3.** Directly test `P/P` sticks and `PP/PP` table at several offsets in the table
   (§4.4). If they fail, the offset normalization (step 3) or the shared-resolver wiring (step 4) is still wrong.
7. **Armor / offhand overlapping or absent.** Confirm slot 45 renders left of the 2×2 grid with the shield
   placeholder when empty, and the 4 armor slots stack at `x=8`; neither overlaps the crafting grid.
8. **Take-one consumption + shift-craft loop.** Verify taking the result decrements exactly one of each ingredient
   and shift-click loops to depletion/full (§4.6).

---

## 7. Acceptance tests (all browser-verifiable — run every one before you commit)

Layout:
- [ ] Survival inventory (`E`) renders with **no overlapping slots and no grey dead-space**; visible left→right:
      armor column, player preview, offhand, 2×2 grid, **arrow**, **result**.
- [ ] Offhand slot (45) sits left of the 2×2 grid and shows a shield-silhouette placeholder when empty; putting a
      torch/food in it works, and in-world it functions as the offhand.
- [ ] Crafting-table screen renders 3×3 + arrow + result + 3×9 storage + 9 hotbar, with **no** armor/offhand/preview.
- [ ] All 4 armor slots and the offhand are clickable and correctly positioned (no overlap with the crafting grid).

Recipe resolution:
- [ ] **Sticks:** 2 planks stacked vertically craft `stick ×4` in the **2×2** grid.
- [ ] **Sticks in the table:** the same 2 vertical planks craft sticks in the **3×3** grid at **multiple offsets**
      (top-left, center, bottom-right) — proving offset normalization.
- [ ] **Crafting table:** `PP/PP` (4 planks) crafts `crafting_table ×1` in the 2×2 grid.
- [ ] **Table-only recipe:** a chest (`PPP/P.P/PPP`) and a furnace (`CCC/C.C/CCC`) craft **only** in the 3×3 table,
      and do **not** resolve in the 2×2 grid.
- [ ] **Mirror:** an axe (`MM./MS./.S.`) crafts in both its normal and horizontally-mirrored arrangement.
- [ ] **Shapeless:** 1 log anywhere in either grid yields 4 planks of the matching species; `coal_block → 9 coal`.
- [ ] **Live result:** the result preview updates immediately on every grid change (add/remove/split an ingredient).
- [ ] **Take-one:** taking the result consumes exactly one of each ingredient and re-previews if inputs remain.
- [ ] **Shift-craft:** shift-clicking the result mass-crafts until inputs deplete or inventory fills, routing
      hotbar-first.
- [ ] Click semantics from §5 all behave (right-click split-half, place-one, double-click collect, `1`–`9` swap,
      `F` offhand swap, `Q` drop, click-outside drop, close returns grid contents).

---

## 8. Guardrails

- **Base specs `01`–`06` stay frozen.** This is a code fix; do not edit any `0x-*.md` base spec. Conform the code to
  `06 §9/§10/§14/§15`, `03 §3/§16.3/§23`, and `08 §7`.
- If you must diverge from a base spec (e.g. an existing code choice you keep, or an unavoidable geometry tweak),
  **log it in `DEVIATIONS.md`** with the section number and the reason. Do not stall on a contradiction — apply
  `CLAUDE.md §2` precedence (expansion AMENDS > 06 > domain owner > 01 > prose) and move on.
- **Keep the v1 perf budgets** (60 fps; UI is DOM/canvas overlay at 2× GUI scale per `06 §15.3` / `01 §15`).
  Resolver runs on mutation only, not per frame.
- **Procedural assets only** — the arrow, shield placeholder, slot frames, and any preview graphic are drawn
  procedurally (canvas / CSS). **Nothing downloaded, nothing imitating copyrighted Minecraft art.** Icons come from
  the existing startup-built icon atlas (`06 §8.2`).
- Do not renumber the fixed slot indices (0–8 hotbar, 9–35 main, 36–39 armor, 40–43 grid, 44 result, 45 offhand).
- Touch only the UI/resolver code paths; do not alter unrelated registry data, worldgen, or save schema. The item
  stack `{id, count, damage?, tags?}` shape (`06 §18` + `08` amendment) must round-trip unchanged.
- **Commit** once every §7 checkbox passes in the browser, referencing the spec sections above.
