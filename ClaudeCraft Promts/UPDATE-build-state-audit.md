# UPDATE PROMPT — Build-state audit + reconcile (run before more phases)

**For:** the build executor (Claude in Ultra Code), in the **ClaudeCraft** repo root.
**Type:** audit + reconcile — establish exactly what is actually built, fix partial/out-of-order/duplicate work, restore anything lost. **Do NOT build new phases here.** Base specs 01–06 frozen; log everything in `DEVIATIONS.md`.

## Why
There's a mismatch between what the operator believes is submitted (E1, E2, EC/18-creative, E6/12-villages, E10/11-end, plus the crafting / sky-sun / main-menu side-prompts) and what this repo's git history + code actually contain. Establish the truth in THIS working tree before continuing.

## Step 1 — Build a true completion matrix
For each phase, mark **Built / Partial / Absent** using three independent signals (don't trust commit messages alone):
1. **Git:** `git log --oneline -40` — list the phase commits present.
2. **Registry:** does the phase's owned id range have real entries? (CLAUDE.md §3: 07 blocks 70–104/items 460–469; 08 blocks 105–109/items 346–369; 09 blocks 110–114/items 370–389; 10 blocks 115–149/items 390–419; 11 blocks 150–169/items 420–434; 12 blocks 170–184/items 435–449; 13 blocks 185–189/items 450–459.) Grep the registry for the marker blocks/items (e.g. enchanting_table, piston, brewing_stand, netherrack, end_stone, emerald, composter, beacon, shulker_box).
3. **Modules/behavior:** do the phase's modules + acceptance-critical code exist and run? (e.g. a `world/dimensions.js` with `changeDimension` for 10; End gen + elytra for 11; village gen + trades for 12; `gameMode` creative flight/instant-break for 18.)

Output a table: `Phase | File | Git commit? | Registry ids? | Modules? | Verdict`. Cover E1–E13 + EC.

## Step 2 — Flag the mismatches explicitly
List any phase the operator thinks is done but this repo scores **Absent** or **Partial** (expected suspects from the operator's report: 12-VILLAGES, 11-END, 18-CREATIVE, plus the main-menu/sky-sun side-prompts). For each, state the evidence (no commit / no registry ids / no module). This tells the operator whether that work lives on another branch/clone or never landed — do not re-create it here; just report it precisely so they can decide to merge it in or rebuild.

## Step 3 — Out-of-order / duplicate-contract check
If any later-phase code DID land ahead of a contract owner, reconcile it:
- **End before Nether:** if 11-END code exists but 10-NETHER's dimension engine does not, the End likely rolled its own dimension/portal/`changeDimension`/per-dim save code. Inventory it, quarantine it behind a single clean seam, and write a `DEVIATIONS.md` note so 10-NETHER (E7) can take ownership without a collision. If neither exists, note "no conflict."
- **Villages trades:** if 12-VILLAGES exists, confirm its librarian/cleric trade rows that reference 08/09 items **fail gracefully** (no crash) while those phases are absent.
- **Creative:** if 18 exists, confirm the `gameMode` save field + break/drop changes don't corrupt survival saves.
- General: grep for any allocation outside a phase's granted id range, and any two files defining the same block/item id.

## Step 4 — Fix the known partials in this repo
- **Menu art deleted:** `git status` shows `CC-assets/CC-menu-logo/*` deleted from the working tree. Either `git checkout -- CC-assets/CC-menu-logo` to restore them, or if a menu build moved them into `public/menu/`, confirm they're there and intact. The menu source art must not be lost.
- **Crafting / sky-sun / RMB / audio fixes:** verify each `UPDATE-*.md` fix is actually applied and passing its acceptance tests in this tree; finish any that aren't. (RMB world-place and audio integration are committed; confirm crafting-inventory and sky-sun.)
- Ensure the game **builds and runs clean at the current state** (`npm run build` + `vite preview`, console clean).

## Step 5 — Record + commit
- Write the completion matrix to a new `BUILD-STATE.md` at the repo root (or append to `DEVIATIONS.md`), dated, so the true state is tracked going forward.
- Commit: `chore: build-state audit + reconcile (BUILD-STATE.md)`. Do not tag.

## Report back
Return the completion matrix table + the mismatch list + any reconciliations done. **Do not build E3+ in this run** — the operator will submit those next in order once the true baseline is known.

## Guardrails
- No new feature phases in this pass; audit + stabilize only.
- Base specs 01–06 frozen; conform to CLAUDE.md §3 id governance and §8 order; log everything in `DEVIATIONS.md`.
