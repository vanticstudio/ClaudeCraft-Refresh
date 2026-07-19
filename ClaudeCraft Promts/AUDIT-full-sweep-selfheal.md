# AUDIT — Full front-to-back sweep + self-correction (autonomous)

**For:** the build executor, **strongest available model** (Fable 5 if usage is available, else Opus 4.8 in Ultra Code), **CRITICAL-tier rigor**. May spawn review subagents (pin to the same model / `opus`).

**Mode: AUTONOMOUS. Do NOT ask the operator anything.** Read everything, verify the whole game against every spec, and **self-correct every defect you find**. When something is ambiguous, resolve it by CLAUDE.md §2 precedence (expansion AMENDS > 06 registry > domain owner > 01 > prose), make the call, and **log it in `DEVIATIONS.md`** — never block, never ask. Work in a fresh worktree per §8.5, commit fixes as you go, and finish with a written report.

## Scope — read front to back
Every file in `ClaudeCraft Promts/`: `CLAUDE.md`, base `01`–`06` (frozen reference — never edit; fix the code to match), expansions `07`–`18`, `19-MAIN-MENU`, `17-SHIP`, `AUDIT-ROUND2.md`, `DEVIATIONS.md`, and every `UPDATE-*.md` backlog prompt. Then the whole `src/` + `server/` codebase and git history. Base specs 01–06 stay frozen; all fixes land in code (or expansion/governance docs), logged in `DEVIATIONS.md`.

## Phase 1 — spec → code verification matrix (built correctly?)
For each phase E1–E13 + EC (files 07–18) and the side-prompts (19 + every UPDATE-*), mark **Built / Partial / Broken** from three independent signals, not commit messages:
1. **Git** — the phase's commits exist.
2. **Registry** — its owned block/item ids (CLAUDE.md §3 ranges) are actually populated, in range, no collisions, nothing outside range.
3. **Modules + behavior** — its modules exist and its acceptance-critical code runs (e.g. `world/dimensions.js`+`changeDimension` for 10; `items/tags.js` for 08; effect engine for 09; End gen/elytra/shulker for 11; village gen for 12; boss/beacon for 13; relay+net for 14; creative flight/instant-break for 18).

Any row that is Partial/Broken → **fix it** (finish the wiring, register the missing ids, apply the un-applied AMENDS). Don't just report it.

## Phase 2 — cross-file contract audit + self-heal
Re-run the AUDIT-ROUND2 class of checks against the *code*, and fix violations:
- **ID governance:** no block/item id outside its file's range; no id defined twice; `states` bit7 exclusively waterlogged; effect/dimension ids single-owned.
- **Frozen contracts honored:** 08 `tags` (enchants/name/anvilUses; potionId→09; containerItems→11) used consistently everywhere a stack merges/splits/serializes; 09 effect API applied by 08/10/11/13; 10 dimension registry used by 11 (no duplicate engine); 15 bit7 honored by every block-state consumer.
- **Orphan/mismatched refs:** every cross-file item/block reference resolves to the owner's real id+name (09↔10 brewing ingredients, 12↔08/09 trades, 13↔10 skulls / 11 arena, 11↔10 dimension API, 13 `dragon_breath` 452). Fix mismatches.
- **AMENDS applied:** every `AMENDS <file> §<n>` across 07–19 is actually reflected in the code. Apply any that were skipped.
- **Sound events:** every emitted event id resolves to a 16 recipe (no silent drops); namespaces consistent.

## Phase 3 — run every acceptance suite + the golden path
- Run all headless verify suites in `scratchpad/` (E1 audio, E2 fire/water, E3, EC, RMB, in-game, and any others) + `npm run build` + `vite preview`. Fix every failure. Where a suite is flaky by design (e.g. E2 wool-catches thresholds one random-seed sample), **pin a seed or measure a distribution** so it's deterministic.
- Manually (headless-drive `window.game`) walk the **golden path** end to end and fix whatever breaks: survive → enchant diamond gear → light a nether portal → raid a fortress (blaze) → brew potions → upgrade to netherite → find the stronghold → activate the End portal → kill the dragon (egg + gateway) → summon the wither → nether star → light a 4-tier beacon → toggle creative & fly → (relay up) a second client joins. Audio present throughout; fire spreads; water logs.

## Phase 4 — clear the known backlog
Confirm each of these landed and is passing; **finish any that didn't**:
`UPDATE-rightclick-fix`, `UPDATE-audio-not-playing-fix`, `UPDATE-crafting-inventory-fix`, `UPDATE-sky-sun-visual-fix`, `UPDATE-polish-and-fixes` (RMB, worldgen ice-ring/continuity, smooth sky, 3D items, settings-tab toggles + render distance, texture pass), `UPDATE-village-gen-rework`, and `19-MAIN-MENU` (desert title + theme music). For anything missing/partial, implement it per its MD, then verify.

## Phase 5 — shipped-stability bugs (fix these; they bite real players)
- **`saveManager.saveChunkNow` resolves `game` via `window.game` (DEV-only)** → in a production build every chunk with entities silently fails to persist. Wire a real game ref; verify chunks persist in `vite preview`.
- **`disposeWorld()` throws on a second call** → Save & Quit → Continue is broken in-session. Fix the guard.
- **Version gate discards `meta` but not chunks**, and `saveManager.open()` nulls `meta` on a mismatch before any migration hook runs → any future `SAVE_VERSION` bump rejects saves and hydrates stale chunks. Fix the migration path and clear the chunk store on bump (unblocks dim/multiplayer saves).
- **Mob death path** (`despawn`/creeper `SwellGoal` set `dead=true` without `die()`) → `noDrops`/death-sound skipped. Reconcile so deaths route through `die()`.

## Phase 6 — hygiene, ship-gate, integrity
- Console clean (no errors/warn spam / stray `console.log`; keep the F3 overlay + startup banner). Remove dead code / resolved `TODO|FIXME|HACK`.
- **Copyright ship-gate:** no C418/copyrighted audio bundled or served in a production build (`public/theme-music` gitignored + stripped from `dist`; theme layer off or original-only; in-game music falls back to the synth composer). Textures/audio 100% procedural.
- Perf budgets (CLAUDE.md §6): 60 fps at render distance 8 with mobs + a redstone clock + audio; no unbounded heap growth over 10 min; redstone ≤ 1 ms/tick; audio ≤ 1.5 ms/frame.
- Save integrity: fresh world → play → reload → identical; old-save load never crashes.
- Determinism: same seed reproduces terrain, structures, villages, and music piece 0.

## Self-correction rules
- **Fix, don't ask.** Every defect above is yours to resolve autonomously. Ambiguity → §2 precedence → decide → log in `DEVIATIONS.md`.
- Base specs 01–06 are frozen — express any base-level fix as a code change (or an amending expansion), never a base-spec edit.
- Commit in logical units as you fix (e.g. `fix(audit): <area>`), with a green build at each commit. Keep the whole sweep on one worktree, merge to `main` when green.
- Where a fix is too large to complete safely in this pass, implement the safe part, and log the remainder as a precise, self-contained TODO in `DEVIATIONS.md` (still no operator question).

## Deliverable
Write `BUILD-STATE.md` at the repo root: the Phase-1 Built/Partial/Broken matrix (final, post-fix), every defect found with its fix (or logged remainder), the acceptance-suite results, and the golden-path result. Commit it. Then return a ≤25-line summary: what was already correct, what you fixed, what (if anything) remains and why — but do not ask for input.
