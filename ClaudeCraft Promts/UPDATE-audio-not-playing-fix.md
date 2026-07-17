# UPDATE PROMPT — No audio at all (in-game SFX + menu/background music)

**For:** the build executor (Claude in Ultra Code), in the existing **ClaudeCraft** codebase (repo root).
**Type:** integration bug-fix — **completes phase E1 (16-AUDIO)**, whose DSP modules were written but never wired in. Base specs 01–06 stay frozen; conform to `ClaudeCraft Promts/16-AUDIO.md` and log divergences in `DEVIATIONS.md`.

## Symptom
On both localhost and Vercel: **no audio of any kind** — no in-game sounds, no menu/background music, nothing.

## Root causes (both confirmed in the current code)

### Cause 1 — the in-game audio engine is never integrated
`src/audio/engine.js`, `events.js`, `primitives.js` exist, but:
- They are **imported nowhere** (`main.js` only imports `themeMusic.js`).
- The engine is **never constructed or booted**, its context is **never unlocked** on a user gesture, and there is **no `audio.updateFrame()` / `audio.tick()` in the loop**.
- **`emitSound` is never called** by any gameplay code — the 16 §5.2 hook table was not applied.

In other words, 16-AUDIO's **Amendments to base files** (AMENDS 01 §2 module wiring, §3 loop steps, §15.2 gesture-unlock, §15.3 options) and its §5.2 hook-point table were skipped. Result: total in-game silence.

### Cause 2 — the theme-music layer has no served files (and isn't cleared)
- `src/audio/themeManifest.js` lists `theme-music/*.mp3`, but **`public/theme-music/` does not exist** — every fetch 404s → silent menu. `themeMusic.js` unlock/resume wiring looks fine; it has nothing to load.
- The manifest sets `THEME_CLEARED = false`, and the source tracks (`CC-assets/CC-sounds/`) are the **copyrighted C418 OST** — gitignored, never copied to `public/`, absent from `dist/`. So Vercel is guaranteed silent for music, by design of the copyright ship-gate (16 §4A / 17-SHIP §3).

## Fix

### Part A — wire up the in-game audio engine (the main fix)
Apply 16-AUDIO's integration exactly as its spec's **"Amendments to base files"** and §5.2 hook table describe. Concretely:
1. **Boot it.** In `main.js` `boot()` (or `Game`), construct the audio engine from `src/audio/engine.js` (create a suspended `AudioContext`, build the master graph + buses, bake the primitive buffers per 16 §1.1/§2.1). Confirm `engine.js` exports the boot + `emitSound` / `startLoop` surface (16 §5.1); if it exports a factory/singleton, use it.
2. **Unlock on first gesture** (16 §1.1 / AMENDS 01 §15.2). Call `audio.unlock()` (resume the context) from **every** first-gesture path: the title/press-start handler, each menu button handler, and the canvas pointer-lock click. This is the single most common "engine present but silent" cause — without a gesture resume, the context stays `suspended` and nothing is heard. (Pass the **same** `AudioContext` + `musicBus` into `createThemeMusic()` so the theme layer shares E1's graph — `main.js` already leaves a TODO for this at the `createThemeMusic()` call.)
3. **Tick it** (AMENDS 01 §3). Add `audio.updateFrame()` to the render loop (listener sync, tracked-voice positions, music lookahead) and `audio.tick()` to the 20 TPS sim tick (ambience sampling, timers).
4. **Fire events** (16 §5.2 hook-point table). Wire `emitSound(eventId, pos?, pitch?, gain?)` into the gameplay hooks: block dig-tick / break / place (per material class), footsteps (walk/sprint/sneak), player hurt/eat/drink/level-up, mob idle/hurt/death, explosions, UI clicks/inventory, fluid + weather ambience. Use the event ids already defined in `src/audio/events.js` (§3 registry).
5. **Options** (AMENDS 01 §15.3): make sure the Master/Music/Ambient/SFX/UI sliders map to the bus gains and persist (`localStorage` key `claudecraft.options.v1`); verify none default to 0.

### Part B — theme / background music
1. **Local dev audibility:** create `public/theme-music/` and place playable tracks there, then regenerate the manifest (`node scripts/gen-theme-manifest.mjs`, per the manifest header). For **local testing only**, the `CC-assets/CC-sounds/` files may be copied in — but keep `public/theme-music/` **gitignored** and out of `dist/`.
2. **Shipping (Vercel):** the C418 tracks must **never** be bundled or served publicly (16 §4A + 17-SHIP §3 hard gate). For a public build, either point the manifest at **original/cleared** tracks (set `THEME_CLEARED = true` only when they genuinely are) or leave the theme layer **off** — in which case in-game background falls back to 16 §4's synth generative composer (so gameplay still has music). Confirm `themeMusic.start({context})` is actually invoked on press-start and on world-enter, and that a missing/empty manifest fails silently without throwing.
3. **Decide the in-game background source:** with no cleared tracks, set `musicMode` so in-game uses the **synth generative composer** (16 §4) rather than the empty theme layer — that gives you compliant in-game music today with zero assets.

## Diagnostic (do this first)
Open DevTools console on the running game and reproduce:
- If the console is silent and no audio nodes are created → the engine never boots (Cause 1). Grep `main.js`/`Game.js` for any `engine`/`emitSound` construction — there is none currently.
- If you see 404s for `theme-music/*.mp3` → Cause 2 (missing served files).
- Check `AudioContext.state` after a click — if it's still `suspended`, the gesture-unlock isn't wired.

## Acceptance tests (browser)
- [ ] After the first click/press-start, `AudioContext.state === 'running'` (log it once).
- [ ] Mining, walking, placing, breaking, mob sounds, damage, and UI clicks are all audible in-game and positional (per 16's acceptance checklist).
- [ ] In-game background music plays (synth generative composer if no cleared theme tracks; theme layer if cleared tracks are present).
- [ ] Menu: theme music plays when `public/theme-music/` has playable tracks; when it's empty, the menu is silent but throws no errors and the game is otherwise fully audible.
- [ ] Production build (`npm run build` → `vite preview`): audio works after the start gesture; **no** C418/copyrighted track is bundled or served (network tab); if the theme layer is off, in-game synth music still plays.
- [ ] Vercel deploy: same as preview — SFX + synth music audible; no copyrighted audio served.

## Guardrails
- This completes E1 per `ClaudeCraft Promts/16-AUDIO.md` — apply its Amendments + §5.2 hooks; don't re-architect the DSP that already exists in `src/audio/`.
- Copyright ship-gate is absolute: C418 tracks are local dev placeholders only; never in a public build. Original/cleared or synth-only for anything that ships.
- Keep the ≤1.5 ms/frame audio budget (16 §6); base specs 01–06 stay frozen; log divergences in `DEVIATIONS.md`.
