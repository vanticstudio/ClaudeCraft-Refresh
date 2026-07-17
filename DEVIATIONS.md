# DEVIATIONS.md

Deviations and ambiguity rulings. (The base-spec `.md` files were removed from
the working tree during repo cleanup; the pre-UPDATE deviation log for the
initial build lives in git history — `git show 8441ac9:DEVIATIONS.md`.)

## UPDATE — main menu (desert theme) + menu music (2026-07-17)

Built to `19-MAIN-MENU`, conforming to `16-AUDIO §4A` (the shared theme-music
module), `16-AUDIO`'s AMENDS to `01 §15.3` (Options), and `01 §14`/`§15.3`.

**Scoped exception to `16-AUDIO §5`'s synth-only rule (mandated by 19 §0/§7):**
the menu uses file-based (sampled) music. This applies to the **menu only** —
in-game audio remains 100 % synthesized, and the §4 generative composer stays
the default and fallback. **Shipped menu tracks must be original or
properly-licensed** (ship gate below).

### Audio copyright ship-gate — how it works

`CC-assets/CC-sounds/` (the C418 OST) is a **local dev placeholder set only**.
Rather than gate a leak after the fact, the two track sources are asymmetric so
a leak is structurally impossible:

| | location | reaches `dist/`? |
|---|---|---|
| Dev placeholders | `CC-assets/CC-sounds/` — **outside** `publicDir` | never; Vite only copies `publicDir` |
| Shipped set | `public/theme-music/` | only when declared in `CLEARED.json` |

- Dev playback comes from a **dev-only Vite middleware** (`theme-music-dev-serve`,
  `apply:'serve'`) that serves `CC-assets/CC-sounds` at `/theme-music/*`.
  This replaced an earlier `public/theme-music` **symlink**: Vite's `copyDir`
  dereferences symlinks at `renderStart`, so that design copied all 106 MB into
  `dist/` on every build and left the gate racing to delete it.
- `scripts/gen-theme-manifest.mjs --build` (wired to `prebuild`/`prepreview`)
  reads **only** `public/theme-music/` and emits an **empty** manifest unless
  every file is declared in `public/theme-music/CLEARED.json` — so a build with
  no cleared tracks ships with the theme layer off, per `17-SHIP §3.5`.
- `vite.config.js`'s `theme-music-ship-gate` plugin deletes any undeclared
  `dist/theme-music` in `closeBundle` (which also runs when a build throws).

**To ship music:** put original/licensed files in `public/theme-music/` and add
`public/theme-music/CLEARED.json`:

```json
{ "tracks": [ { "file": "dunes.mp3", "license": "original — © Vantic Studio" } ] }
```

**⚠ Outstanding, needs a human decision:** the 14 C418 mp3s are **already
committed** at `CC-assets/CC-sounds/` (commit `b74a1b5`, 106 MB, unpushed at the
time of writing) with remote `github.com/vanticstudio/Minecraft-spec`. The new
`.gitignore` rule does **not** untrack them and no build-time gate can — the
audio would be distributed by the repo itself. Fix before any push:
`git rm -r --cached CC-assets/CC-sounds` + a history rewrite (still cheap while
`b74a1b5` is unpushed).

### Deviations

1. **Options screen is a title-screen settings panel with 3 of the 5 spec'd
   sliders** (Master / Music / SFX). `16-AUDIO`'s AMENDS to `01 §15.3` wants
   five sliders (+ Ambient, UI), a Theme-music selector, mouse sensitivity and
   view bobbing, reachable from TITLE **and** PAUSE. 19 §3.2 only requires
   "at minimum: Master, Music (menu), SFX" on the title. Ambient/UI/musicMode
   have no consumer until 16-AUDIO E1 lands, and sensitivity/bobbing belong to
   03's settings — so the UI ships with what is wired. The **persisted schema is
   already the full §15.3 shape** (`src/ui/options.js`: master/music/ambient/
   sfx/ui/musicMode/mouseSensitivity/viewBobbing at `claudecraft.options.v1`,
   migrating `voxelcraft.options.v1`), so E1 adds rows, never a migration.
2. **`themeMusic` builds its own AudioContext + bus chain** (sanctioned by
   19 §4.4 — "if 16 isn't built yet"). The fallback graph is a byte-for-byte
   subset of `16 §1.2` (`themeGain → musicBus → masterGain → DynamicsCompressor
   → destination`, same compressor constants, `busGain = (slider/100)²`), and
   `createThemeMusic({ context, musicBus })` takes E1's nodes when they exist.
   While the bus is ours we drive its gain; when it is E1's we never touch it,
   so E1's `§4.3` damage-duck cannot double-apply (`duck()` is a no-op hook).
3. **Decode guard is by bytes, not just count.** `16 §4A.1` says decode ≤ N
   (default 6) *short* tracks. "Short" is load-bearing: six 3-minute stereo
   tracks decode to ~414 MB of Float32 PCM. Added `DECODE_MAX_BYTES = 2.5e6`
   per track and a `DECODE_BUDGET_BYTES = 96e6` resident ceiling `(approx)`;
   anything larger streams via `HTMLAudioElement`. With the 14 placeholders this
   measures 1 decoded / 13 streamed / 34.6 MB PCM.
4. **Menu art is scaled by its ink, not its canvas.** `logo-primary.png` is
   2360×760 with only 1747×255 of opaque pixels (34 % of canvas height), and the
   button plates are 61 %. Sizing the boxes to 19 §3.1's `clamp(46px,9vw,120px)`
   rendered a ~39 px wordmark, so the CSS scales each box by 1/inkFraction and
   negates the transparent padding with negative margins — the *visible* art then
   matches the spec's metrics and flex gaps lay out against the art.
5. **No Delete/Back button art exists**, so those two are styled text buttons
   (`.cc-textbtn`), and **Delete World moved into the Settings panel** — 19 §3.2
   fixes the title row at New Game / Continue / Settings / Quit, and reusing the
   QUIT/CONTINUE plates for other actions would mislabel them. The `onDelete`
   hook is unchanged and still reachable (19 §3.2 "reuse their hooks").
6. **`.screen h1` / `.screen button` / `.screen input` were narrowed** to
   `#screen-loading|#screen-pause|#screen-death`. As element-qualified selectors
   (0,0,1,1) they beat every single-class `.cc-*` rule (0,0,1,0) and silently
   restyled the title's wordmark and image buttons. The three stock screens keep
   their exact look.
7. **`Quit` on the title returns to the PRESS START state** (19 §3.2 — web build
   has no process to exit).
8. **`src/audio/themeManifest.js` is generated and gitignored**; `predev` /
   `prebuild` / `prepreview` always regenerate it, so a fresh clone can never
   import a stale or missing manifest (it emits `[]` when no tracks exist).
9. **Fonts are self-hosted** (`public/menu/fonts/`, Bungee + VT323 latin-subset
   WOFF2, 21 KB total, OFL texts bundled alongside) per 19 §3.1 — no runtime CDN.
10. **`package.json` gained `"version": "1.0.2"`**, surfaced to the badge via a
    Vite `define` (`__APP_VERSION__`). No version existed anywhere before;
    `SAVE_VERSION`/`DB_VERSION` are save-format numbers and deliberately unused
    here.

### Defects found by adversarial review and fixed before landing

A multi-agent review (3 dimensions → per-finding refutation) confirmed 14 real
defects; all are fixed and regression-tested:

- **Ship gate resolved `outDir` against `process.cwd()`.** `build.outDir` stays
  the relative string `"dist"` after `resolveConfig`, so a build launched from
  any other directory checked the wrong path and waved the tracks through. Now
  `resolve(cfg.root, cfg.build.outDir)`.
- **`npx vite build` bypassed the gate entirely** — pre* npm hooks don't run, so
  a manifest left over from `npm run dev` baked all 14 C418 filenames into the
  production bundle (verified: `dist/assets/index.js` contained the playlist).
  The generator now also runs from the plugin's `buildStart`.
- **A directory named in `CLEARED.json` shipped its whole subtree unchecked**
  (`readdir` returned dir names as if files). Entries must now be real files.
- **`stop()`'s post-await tail tore down a `start()`** that arrived during its
  1 s fade — the menu went permanently silent for the session. Both are now
  epoch-guarded.
- **The stream branch never re-checked `running` after `await el.play()`**,
  orphaning a live `<audio>` node after `stop()`.
- **`_scheduleNext()` could resurrect a gapTimer** after `stop()` cleared it.
- **Track timers ran on the wall clock** while the AudioContext was suspended,
  truncating a track by the length of any tab switch. Deadlines now use
  `ctx.currentTime`, and stream elements park/resume with the context.
- **Quit-to-title left the music playing**, after which PRESS START no-op'd.
- **Settings dialog had no focus trap** (Tab reached the title buttons hidden
  behind the opaque overlay — Enter there would start or delete a world), no
  Escape, and restored focus to New Game rather than the opener.
- **Arrow-key navigation was missing** (19 §3.2 requires "arrow/Tab + Enter").
- **`claudecraft:start` was never dispatched** (19 §3.2 says keep that event).
- Seed input had no accessible name; `_load()` had no in-flight dedupe; the dev
  middleware threw an uncaught `URIError` on malformed percent-encoding.

Verified 2026-07-17 (headless Chromium, dev + production build): 54 browser
assertions pass — scene/badge/tagline/logo render, PRESS START gates the button
row and the music, Continue only with a save, shuffle has 0 immediate repeats in
400 draws across reshuffles, gaps land in 10–20 s, fades in/out, level 0.45,
zero audio requested before the gesture, Music slider changes gain live
((70/100)² = 0.49) and persists across reload, world load fades out in ~1 s and
suspends the context, quit-to-title rearms and restarts, tab hide/show
suspends/resumes, `prefers-reduced-motion` stills every animation, no horizontal
overflow from 560 px to 4K, zero console errors. Plus 10 regression assertions
for the review fixes above (start-during-stop survives, Quit stops/restarts,
Escape + focus trap + focus restore, arrow nav, `claudecraft:start`, seed label).
Production build: **0 audio files in `dist/`**, no track references in the
bundle, theme layer off, no `VoxelCraft` string, no font-CDN reference.
Gate re-tested adversarially: placeholders hand-copied into `public/theme-music/`
plus a `CLEARED.json` falsely declaring a *directory* → whole `dist/theme-music`
removed, 0 mp3s shipped. `vite preview` returns the SPA fallback (652 B of HTML),
not audio, for a track URL — the dev middleware is `apply:'serve'` only.

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
