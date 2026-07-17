# UPDATE PROMPT — Right-click (RMB): world placement + single-item into crafting slots

**For:** the build executor (Claude in Ultra Code), in the existing **ClaudeCraft** codebase (repo root).
**Type:** code bug-fix. **Not** a spec change — base specs 01–06 stay frozen; conform to them and log any divergence in `DEVIATIONS.md`. This is a follow-up to `UPDATE-crafting-inventory-fix.md` (the crafting layout/resolver fix already landed — `containers.js` references `UPDATE §2.2/§3.1`); this one is specifically about **right-click behavior**.

## The bug (observed on the live build)
1. **World:** right-click does not place blocks — RMB in the world does nothing (or nothing reliably).
2. **Crafting grid:** right-click does not drop a *single* item into a crafting-grid slot. The only way items reach the 2×2 (and 3×3) grid is in **groups of four** — i.e. left-click-drag-distribute across the four slots is the sole working path, so everything lands in multiples of the slot count.

Target = vanilla Minecraft behaviour: **RMB on a block face places one block; RMB in a container with a held stack deposits exactly one item into the slot; RMB on a slot with an empty cursor picks up half.** Left-drag-distribute should still exist, but must not be the *only* way to fill slots.

## Where this lives (confirmed in the code)
- **World place:** `src/player/interaction.js` → `use(input)` (the RMB "use" channel). It's gated in the tick by:
  `if ((input.rightPressed || (input.mouseRight && this.useDelay === 0)) && !p.usingItem) this.use(input);`
  and `use()` reaches block placement at `if (held.place != null && hit) { if (this.tryPlace(held, hit)) { this.useDelay = 4; return; } }`.
- **RMB plumbing:** `src/player/input.js` — `mousedown`/`mouseup` set `buttons[e.button]` + `pressBuf[e.button]`; the snapshot exposes `mouseRight = buttons[2]`, `rightPressed = pressBuf[2]`. `canvas` has a `contextmenu` → `preventDefault`.
- **Inventory place-one:** `src/ui/containers.js` → `onSlotClick(index, e)`, the `else if (e.button === 2)` branch (split-half when cursor empty; deposit-one when holding a stack). Slots bind via `el.addEventListener('mousedown', e => { this.onSlotClick(index, e); e.preventDefault(); e.stopPropagation(); })`. There is also a `document` `mousemove` handler and a root `mousedown` handler (throw-stack / drag) — suspect these for intercepting RMB.

Both code paths *look* correct on paper, so the fault is in **delivery or interception**, not the branch logic. Reproduce first, then fix.

## Root-cause checklist (work top-down; reproduce each in the running game)

### A — World RMB placement
1. **Is RMB even arriving?** Add a temporary log in `input.js` mousedown for `e.button === 2` and in `interaction.js use()`. Right-click in the world (pointer locked, a placeable block selected in the hotbar). If `use()` never runs → the gate or the edge flag is the problem; if it runs but nothing places → step 4/5.
2. **`rightPressed` edge vs. `pressBuf` clear timing.** Confirm `pressBuf[2]` is set on mousedown and cleared exactly once per snapshot *after* the tick reads it — not cleared before `interaction.tick` consumes it (an ordering bug makes `rightPressed` always false). Verify the input snapshot is taken once per tick and `pressBuf` is reset only at snapshot end.
3. **Gate stuck:** check `p.usingItem` isn't left truthy from a prior action (e.g. an interrupted eat/bow), and `this.useDelay` actually reaches 0 (it decrements in the tick). If `usingItem` sticks, RMB is swallowed.
4. **`held.place` is set on block items.** In `use()`, placement only fires when `held.place != null`. Verify block items in the registry actually carry a `place` (or `placesAs`) field — if it's missing/renamed, `use()` falls through and nothing places. This is the most likely world-side cause.
5. **`hit` present + `tryPlace` works.** Confirm `this.currentHit` (the ray target) is populated on the RMB tick and `tryPlace(held, hit)` computes the adjacent cell, checks collision/replaceable, decrements the stack, and writes the block. Test: hold a dirt/plank stack, aim at a face, RMB → one block appears on the correct side; holding RMB places every 4 ticks (the `useDelay = 4` cadence), not continuously.

### B — Crafting-grid single-item (RMB deposit-one)
6. **Does `onSlotClick` receive `e.button === 2`?** Log at the top of `onSlotClick`. Right-click a grid slot while holding a stack on the cursor. If it never fires for button 2 → the event is being intercepted (step 7); if it fires but deposits wrong → step 8.
7. **Interception by the drag/root handlers.** The `document` `mousemove` handler and the root `mousedown` handler (throw-stack / left-drag-distribute) must **ignore button 2** and must not `preventDefault`/consume RMB before the per-slot `mousedown` runs. Ensure: left-drag-distribute arms only on `e.button === 0`; the root `mousedown` throw-stack path is `button 0` only; nothing starts a "paint" drag on RMB. A drag state that begins on any button will eat the single RMB click and leave drag-distribute (the "groups of four") as the only path — this is the most likely inventory-side cause.
8. **Deposit-one branch correctness.** In the `e.button === 2` branch: with a held cursor stack over an empty or same-type non-full slot → place exactly **one** (`inSlot.count++` or `slot.set({...cur, count:1})`, `cur.count--`, clear cursor at 0); with an empty cursor over a filled slot → take `ceil(count/2)`. Confirm the crafting-grid slots' `canPut` doesn't reject single deposits, and that the **result slot** is take-only (never accepts RMB deposits). Both the **2×2** (inventory) and **3×3** (table) grids must use this same handler.
9. **Result recompute.** After any RMB deposit into a grid slot, the shared recipe resolver re-runs and the result slot updates live (per `UPDATE-crafting-inventory-fix.md`).

### C — Don't regress the drag
10. Keep left-click-drag-distribute working (hold a stack, LMB-drag across slots, release → even split), but it is now **one** option, not the only one. Right-drag-distribute (deposit one per dragged slot) is a nice-to-have if cheap; single RMB click is the must-fix.

## Acceptance tests (in the browser)
- [ ] Hold a placeable block, aim at a face, **right-click → one block places** on the correct adjacent cell; holding RMB places at a steady cadence; sneaking+RMB on an interactable still places (doesn't only open the block).
- [ ] Right-click still opens interactables (crafting table, furnace, chest) — placement vs. interact precedence unchanged from 06/spec.
- [ ] In the 2×2 and 3×3 grids: holding a stack, **right-click a slot deposits exactly one** item; repeat to add 1, 2, 3…; right-click a filled slot with an empty cursor **picks up half**.
- [ ] Items can be placed **one at a time** into any grid slot — no longer forced into groups of four.
- [ ] Left-drag-distribute still works and is no longer the only way to fill the grid; the result slot updates live and is take-only.
- [ ] Left-click (place-whole-stack / pick-up / swap) and shift-click (transfer) are unaffected.

## Guardrails
- Base specs 01–06 frozen; this is a code fix (conform to 03 §16.1 use/place precedence and 06 §14.2 click semantics). Log divergences in `DEVIATIONS.md`.
- Keep the 60 fps budget; no new per-frame allocations in the input path.
- Don't break the `contextmenu` preventDefault (RMB must never pop the browser menu over the canvas or inventory).
