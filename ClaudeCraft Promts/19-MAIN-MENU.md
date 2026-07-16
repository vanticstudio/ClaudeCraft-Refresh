# 19 — MAIN MENU (desert theme) + menu music

**Standalone side-prompt / work order — NOT a CLAUDE.md build phase.** Manual entry; do not wire it into the CLAUDE.md phase table or ID governance. Paste this into the build session when you want the title screen + menu music built. It touches only UI + a new menu-audio module; it allocates no block/item ids.

**For:** the build executor (Claude in Ultra Code), working in the existing **ClaudeCraft** codebase at repo root (`src/`, `public/`, `index.html`, Vite).

---

## 0. Read-me-first: audio copyright ship-gate (do not skip)

The files currently in `CC-assets/CC-sounds/` are the **copyrighted C418 Minecraft soundtrack** (Subwoofer Lullaby, Sweden, Mice on Venus, Haggstrom, Aria Math, Wet Hands, Clark, Dreiton, Taswell, …). They are treated here as **local development placeholders only.**

- **These must NOT be bundled into or served by any public deployment.** Shipping them on Vercel is copyright infringement and violates this project's own absolute rule (`16-AUDIO`: "100% synthesized — no samples, no copyrighted/C418 material, ever"; `17-SHIP`: no-Mojang-assets disclaimer).
- The menu-music system below is built **asset-agnostic** — it plays whatever tracks a manifest points at. Before any public ship, the placeholder set MUST be swapped for **original or properly-licensed/royalty-free audio** (or original menu music synthesized via the `16-AUDIO` engine).
- Add a **SHIP GATE** to the `17-SHIP` checklist (now landed as 17-SHIP §3 item 5): "the `public/theme-music/` folder contains zero copyrighted/C418 tracks; every shipped track is original or cleared." Until then, keep the placeholders out of `git` (gitignore the theme-music asset dir) and out of `dist/`.
- Log the scoped exception in `DEVIATIONS.md`: *"Menu screen uses file-based (sampled) music, a deliberate exception to 16's synth-only rule, for the menu ONLY. In-game audio remains 100% synthesized. Shipped menu tracks must be original/cleared (ship gate)."*

Everything below is safe to build now with the placeholders for local testing; only the *shipped* asset set is gated.

---

## 1. Scope

Two deliverables:
1. **Desert-theme main menu / title screen** — replace the current plain `#screen-title` ("VoxelCraft" + bare buttons) in `src/ui/menus.js` with the badlands-sunset ClaudeCraft title screen, using the supplied art in `CC-assets/CC-menu-logo/`.
2. **Menu music system** — a new module that plays the menu tracks at random, preloaded in RAM, at a soft level (slightly louder than the in-game generative music), with fades and a pause between tracks; starts on the menu, stops/hands off when a world loads.

Out of scope: in-game music (that's `16-AUDIO`), settings persistence beyond a volume slider, controller input.

## 2. Asset inventory (source → destination)

Source pack: `CC-assets/CC-menu-logo/` (see its `README.txt`) and `CC-assets/CC-sounds/`.

Move the art into the Vite static pipeline so it's served and cache-friendly, and keep audio **served, not JS-bundled** (large files must stream, not inflate the bundle):

| Source | Destination (served) | Use |
|---|---|---|
| `CC-menu-logo/backgrounds/bg-sunset.png` | `public/menu/bg-sunset.png` | Title backdrop (static fallback) |
| `CC-menu-logo/backgrounds/bg-dark.png` | `public/menu/bg-dark.png` | Settings/overlay backdrop |
| `CC-menu-logo/logos/logo-primary.png` | `public/menu/logo-primary.png` | Wordmark (single-line, matches sunset) |
| `CC-menu-logo/logos/logo-stacked.png`, `logo-emerald.png` | `public/menu/` | Alternates (not used by default) |
| `CC-menu-logo/buttons/btn-*.png` | `public/menu/buttons/` | Menu buttons (terracotta = primary, stone = secondary) |
| `CC-menu-logo/claudecraft-title.html` | reference only | Source of truth for layout/CSS (see §3) |
| `CC-sounds/*.mp3` | `public/theme-music/` **(gitignored; dev only)** | Menu playlist placeholders (§4) |

> Decision: use `bg-sunset.png` as a static fallback, but render the **animated CSS scene** from `claudecraft-title.html` as the default backdrop (parallax sun/clouds/mesas, scales to any viewport, honors `prefers-reduced-motion`). It's framework-free and self-contained.

## 3. Title screen (desert theme)

Port `claudecraft-title.html` into the game's screen system (`src/ui/menus.js`), preserving its structure and CSS custom properties. Do **not** load it as an iframe — inline the markup + CSS into the existing `#screens` container.

### 3.1 Structure & theme
- Reuse the HTML's layer stack: `.cc-sky` gradient → `.cc-sun` (animated) → `.cc-cloud`s → `.cc-range-far/.cc-range-near` mesas → `.cc-ground` → `.cc-vignette`, with the `.cc-badge` version tag and centered wordmark.
- **Palette (CSS custom props, keep verbatim):** `--cc-ink:#17100a`, `--cc-terra:#b9662f`, `--cc-terra-d:#a24d27`, `--cc-clay:#cf9152`, `--cc-clay-l:#b98c66`, `--cc-cobble:#9296a0`, `--cc-cobble-d:#8a8a90`, `--cc-rust:#c07235`. Sky gradient `#2d1b4e → #7a3b6e → #c96a4f → #f2a65a → #f8ca70`.
- **Wordmark:** render `public/menu/logo-primary.png` (crisp, transparent) as the title image, sized `clamp(46px,9vw,120px)` tall equivalent; keep the CSS Bungee text wordmark (per-letter terracotta/clay/cobble colors from the HTML) as a no-image fallback. Float animation + layered extrusion shadow as in the HTML.
- **Tagline:** "ENDLESS WORLDS AWAIT" (VT323, letter-spacing, semi-opaque terracotta plate) — keep or let user edit copy.
- **Version badge:** top-left, "CLAUDECRAFT · v0.1 ALPHA" (pull version from `package.json`).
- **Fonts:** Bungee (wordmark) + VT323 (UI). **Self-host the WOFF2** in `public/menu/fonts/` and `@font-face` them — do not depend on the Google Fonts CDN at runtime (keeps the static ship self-contained and offline-safe). Both fonts are OFL-licensed; fine to bundle.
- `prefers-reduced-motion: reduce` → disable sun/cloud/wordmark/prompt animations (already in the HTML).

### 3.2 Interaction flow
- Initial state: title scene + wordmark + blinking **`▶ PRESS START`** (`#cc-start`), exactly as the HTML. The HTML dispatches `claudecraft:start` on click / Enter / Space — keep that event.
- On `claudecraft:start` (first user gesture), **reveal the button row** and **start menu music** (§4 — audio needs a user gesture to begin). Buttons use the supplied PNGs:
  - **New Game** (`btn-new-game.png`, terracotta) → existing `hooks.onNewWorld(seedValue)`. Show the seed input (styled to match: VT323, terracotta frame) near/under the button.
  - **Continue** (`btn-continue.png`, terracotta) → existing `hooks.onContinue()`. Only shown when a save exists (reuse the current `btnContinue` display logic).
  - **Settings** (`btn-settings.png`, stone) → open a settings panel over `bg-dark.png` with at minimum: Master volume, Music (menu) volume, SFX volume sliders (wired to §4 / `16`'s buses). Persist to `localStorage`.
  - **Quit** (`btn-quit.png`, stone) → return to the PRESS-START state (web build: no process exit).
- Hover/active states: scale 1.04 + brightness bump; keyboard navigable (arrow/Tab + Enter), focus ring; buttons are real `<button>`s wrapping the PNGs for a11y.
- Keep the existing **loading / pause / death** screens; only restyle the title. Reuse their hooks (`onResume`, `onQuit`, `onRespawn`, `onDelete`).

### 3.3 Rename
The game is **ClaudeCraft**. Replace the remaining `VoxelCraft` title string in `menus.js` (and any window title in `index.html`) with `ClaudeCraft`. (Internal module/spec names can stay; this is the user-facing brand, and 17-SHIP wants no "Minecraft" branding anywhere.)

## 4. Menu music system

This is the shared theme-music module defined in **16-AUDIO §4A** (`src/audio/themeMusic.js`) — the same player drives both this title screen and the soft in-game background; this section specifies its title-screen behavior. Create `src/audio/` if absent (16-AUDIO also lives there). Behavior, matching the request: **random order, preloaded in RAM, soft but slightly louder than in-game music, with pauses between tracks.**

### 4.1 Manifest
- Generate `src/audio/themeManifest.js` exporting an ordered array of served URLs, built from the files present in `public/theme-music/`. Provide a tiny build step or hand-list; the player must not hardcode a fixed count.
- Current placeholder set (⚠ C418 — dev only, replace before ship, §0): the 14 mp3s in `CC-sounds/`.

### 4.2 Preload into RAM
- On first gesture, `fetch()` each track → `arrayBuffer` → `AudioContext.decodeAudioData` → hold the resulting **`AudioBuffer` in memory** (that's the "in RAM" requirement; decoded PCM is instantly, gaplessly playable).
- **Memory caveat:** 14 decoded C418 tracks is very large (100 MB+ of mp3 → several hundred MB decoded PCM). For the shipped original set, keep it to a **small curated set of short loops/tracks** (e.g. 3–6 tracks, ≤ ~2–3 min each), or stream large files via `HTMLAudioElement` instead of full decode. Implement: decode-to-buffer for ≤ N tracks (N configurable, default 6); beyond that, fall back to a streamed `Audio` element per track. Preload the first track eagerly, the rest lazily in the background so the menu is audible fast.

### 4.3 Playback loop
- Order: **shuffle** the manifest (Fisher–Yates); play sequentially; never play the same track twice in a row across reshuffles.
- Between tracks: a **pause** (silence gap) of `MENU_MUSIC_GAP` = **10–20 s random** `(approx — tune to taste; the request calls for audible pauses between songs)`.
- Each track **fades in** over `1.5 s` and **fades out** over `0.8 s` (equal-power ramp on the music-bus gain), so entries/exits are soft, never a hard cut.
- Loop forever while the menu is up.

### 4.4 Levels (soft, slightly louder than in-game)
- Route through `16-AUDIO`'s graph: `themeSource → themeGain → musicBus → masterGain → destination`. If `16` isn't built yet, create a **minimal standalone** `AudioContext` + gain chain now and refactor to route through `16`'s master bus when E1 lands (leave a `// TODO: route via 16 masterBus` marker).
- `themeGain` default ≈ **0.45** `(approx)` — soft, but a touch above the in-game theme-music target (≈ 0.28–0.32 per 16 §4A). Exposed to the Settings "Music" slider (0–1); persist to `localStorage`. Master mute overrides.
- Respect a prefers-reduced-audio / user-mute state; obey the browser autoplay policy (only start after the `claudecraft:start` gesture).

### 4.5 Lifecycle
- **Start:** on `claudecraft:start` (menu revealed).
- **Stop/handoff:** when a world begins loading (`onNewWorld` / `onContinue`), **fade out over ~1 s and suspend** the menu player; hand off to `16`'s in-game music (or silence if 16 not built). Returning to the title (`onQuit`) restarts the menu player.
- **Tab visibility:** on `visibilitychange` hidden → fade to 0 + `context.suspend()`; visible → `resume()` + fade back. Pauses cleanly, no state loss.
- **Cleanup:** stop nodes and free buffers on quit-to-desktop; no dangling `AudioBufferSourceNode`s (one-shot nodes must be recreated per play).

## 5. Integration points
- `src/ui/menus.js` — replace the `#screen-title` innerHTML with the §3 markup + CSS; add button handlers; own the `claudecraft:start` listener; construct/hold the theme-music player (16 §4A `themeMusic.js`); call `themeMusic.stop()` inside the `onNewWorld`/`onContinue` paths and `themeMusic.start()` on return-to-title.
- `src/main.js` — where `Menus` is constructed (`new Menus(game, screensEl, {…})`): pass an audio handle (the `16` master bus if available) into `Menus` so the theme-music player can route through it; ensure the first-gesture audio unlock happens on the title screen.
- `src/audio/themeMusic.js`, `src/audio/themeManifest.js` — new files.
- `index.html` — window `<title>` → "ClaudeCraft"; add `@font-face` (self-hosted) or the font `<link>` if you keep CDN (self-host preferred).
- Settings panel — Master / Music / SFX sliders → gains; persist.

## 6. Acceptance tests (browser-verifiable)
- [ ] Title screen shows the animated badlands-sunset scene, ClaudeCraft wordmark (image, with CSS fallback), version badge, tagline, and blinking PRESS START; scales from ~560px up to 4K; `prefers-reduced-motion` stills the animations.
- [ ] PRESS START (click / Enter / Space) reveals New Game / Continue / Settings / Quit using the terracotta/stone button art; Continue only appears with an existing save; all buttons keyboard-navigable with focus rings.
- [ ] New Game (with seed) and Continue call the existing hooks and load a world; loading/pause/death screens still work.
- [ ] Menu music begins on PRESS START (never before — autoplay-policy safe), plays tracks in random no-immediate-repeat order, preloaded so the next track starts gaplessly after a **soft 10–20 s pause**, each track fades in/out.
- [ ] Menu music sits at a soft level, slightly above the in-game music target; the Settings Music slider changes it live and persists across reload; master mute silences it.
- [ ] Starting/continuing a world fades the menu music out within ~1 s and stops it; returning to title restarts it; hiding the tab suspends it and showing resumes it.
- [ ] No "VoxelCraft" text remains user-facing; window title reads ClaudeCraft.
- [ ] **Ship gate:** `public/theme-music/` is gitignored and excluded from `dist/`; no C418/copyrighted track is bundled or served in a public build (verified before deploy).

## 7. Guardrails
- No `localStorage`/asset rule conflicts with the game's other systems; this is additive UI + one audio module. Allocate **no** block/item ids.
- The file-based menu music is a **scoped, logged exception** to `16`'s synth-only rule (menu only; in-game stays synth). Record it in `DEVIATIONS.md` (§0).
- Keep the 60 fps budget: the CSS scene is GPU-cheap (transforms/gradients); don't add per-frame JS work on the title screen. Menu music is off the render path.
- Fonts self-hosted (OFL) — no reliance on external CDNs at runtime for a static ship.
- Shipped audio must be original or cleared. If you want, generate an original ClaudeCraft menu track set via the `16-AUDIO` synth engine and point the manifest at those instead of any sampled files — fully compliant and free.
