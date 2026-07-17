# DEVIATIONS.md

Deviations and ambiguity rulings. (The base-spec `.md` files were removed from
the working tree during repo cleanup; the pre-UPDATE deviation log for the
initial build lives in git history — `git show 8441ac9:DEVIATIONS.md`.)

## UPDATE — theme-music drop zone made Vercel-ready (2026-07-17)

The C418 placeholders were deleted from the working tree by the repo owner. This
readies `public/theme-music/` as the drop zone for original/licensed tracks, so
files placed there play locally **and reach the Vercel deploy**.

### Two real defects fixed (both would have shipped a broken deploy)

1. **`public/theme-music/` was gitignored — tracks would never have reached
   Vercel.** Vercel builds from the repo, so anything not committed is simply
   absent from the deploy: tracks would play perfectly in `npm run dev`, then be
   silently missing in production. The ignore rule dated from when the directory
   was a symlink to the C418 placeholders; with those gone, the shipped set must
   be committed. Now un-ignored, with the rule documented in `.gitignore` and
   `public/theme-music/README.md`: only original/licensed audio goes here, and
   every file must be declared in `CLEARED.json`.

2. **The ship gate counted `README.md` as an undeclared track and deleted the
   whole folder — while the manifest still referenced the tracks.** The build
   reported "1 cleared track(s)", baked `theme-music/x.wav` into the bundle, and
   then `closeBundle` removed `dist/theme-music` entirely: **every theme URL in
   the shipped bundle would have 404'd.** The gate now polices only AUDIO files
   against `CLEARED.json`, and strips non-audio companions (`README.md`,
   `CLEARED.json`) from `dist/` rather than counting them — they are
   documentation and a licence record, not tracks, and do not belong on a public
   URL. `AUDIO_EXT` is now exported from `gen-theme-manifest.mjs` and shared with
   the gate so the two lists cannot drift. A non-audio file is still deleted from
   `dist/`, so a renamed track (`song.mp3.txt`) cannot smuggle itself onto the
   deploy either.

### Added

- **`npm run theme:clear -- --license "…"`** (`scripts/clear-theme-tracks.mjs`):
  declares every audio file in `public/theme-music/` in one command, preserving
  any existing per-file licence text. The `--license` argument is mandatory and
  has no default — it is a human assertion of provenance, the one part of the
  gate a machine cannot verify. Tooling can check that a file is *declared*; it
  cannot check that the declaration is *true*.
- **`public/theme-music/README.md`** — the drop-in workflow, and why the
  declaration step stays manual.
- **`public/theme-music/CLEARED.json`** — empty `tracks: []` template.

### Verified end-to-end with a generated 2 s tone standing in for a delivered track

| Step | Result |
|---|---|
| drop a file in, `npm run dev` | appears in the manifest, plays |
| `npm run build` **undeclared** | gate withholds it — 0 audio in `dist/` |
| `npm run theme:clear -- --license …` | `CLEARED.json` written |
| `npm run build` **declared** | 1 track in `dist/theme-music/`, README/CLEARED.json **not** shipped |
| `vite preview` (the deploy path) | track fetched and **audible**, 0 × 404, 0 console errors |

Fixture removed afterwards; the drop zone ships empty. 80 assertions green
across every suite (35 audio + 8 regression + 7 in-game + 4 unlock + 16 RMB +
3 music + 3 prod + 4 prod-music).

**Unchanged:** the C418 audio remains in the pushed history (`b74a1b5`,
`6a16a13`, `v1.0.4`). Deleting the working-tree files does not remove it —
`git rm -r --cached CC-assets/CC-sounds` plus a history rewrite is still required.

## UPDATE — right-click fix (2026-07-17)

Work order: `UPDATE-rightclick-fix.md`. Reproduced both reported bugs with
instrumentation before changing anything. **One was real; the other does not
exist.**

### Bug A (world RMB placement) — REAL. Root cause: `air` was not `replaceable`

The work order's checklist suspected delivery/interception (steps A1-A3), or a
missing `held.place` (A4, "the most likely world-side cause"). Instrumenting the
whole chain showed all of those are fine — RMB arrives, the snapshot latches the
edge, `use()` runs, and `tryPlace()` is *called*:

```
A1  document mousedown(button=2) fired : 1
A2  snapshot saw rightPressed          : 1
A1  interaction.use() ran              : 2
A5  tryPlace() called / returned true  : 2 / 0     <- fails INSIDE tryPlace
A4  held item: dirt | item.place = 3               <- A4 was fine all along
```

`tryPlace` rejected at `if (!BLOCKS[targetId].replaceable) return false`, because
**`defBlock(0, 'air', …)` never set `replaceable` and the default is `false`.**
03 §16.2 defines the set verbatim:

> `blockAt(placePos) is in the replaceable set: {air, water, lava, fire,
> short_grass, dandelion, poppy, dead_bush} (06 §5.7)`

The code had only 5 of those 8 — `air`, `water` and `lava` were all missing. So a
block could only ever be placed *over a flower*, which is exactly the reported
"nothing, or nothing reliably". **Fix: add `replaceable: true` to air, water and
lava**, making the code's set match 03 §16.2 exactly (verified by comparing the
two sets programmatically). No spec change; base specs stay frozen.

The same guard gated three other paths that were therefore *also* silently
broken, and all three now work: **filled buckets could not be poured into air**
(06 §6.4), and **doors and beds could not be placed** at all (06 §5.13/§5.7).

### Bug B (crafting-grid RMB deposit-one) — NOT REPRODUCIBLE

The report says a single item cannot be right-clicked into a grid slot and that
"left-click-drag-distribute … is the sole working path", forcing groups of four.
Tested with **real** `mousedown/mouseup button:2` events against the **unmodified**
code, on both grids:

- 2×2 (inventory): three successive right-clicks → slot 1, 2, 3; cursor 31, 30, 29.
- 3×3 (table): same handler, same result.
- Empty cursor on a filled slot → picks up `ceil(9/2) = 5`, leaves 4.
- Result slot take-only; live recipe recompute after each single deposit.

All pass **before** my change. Two further points against the report's model:
there is **no drag-distribute code in this codebase at all** (the only `mousemove`
handler positions the cursor sprite; the only root `mousedown` is the
throw-stack path, already split by button), so the hypothesised "drag state that
begins on any button eats the RMB click" (checklist step 7) has nothing to
attach to; and 06 §14.2's stated adaptation already logged right-click
drag-painting as out of scope. **Nothing changed for Bug B** — inventing a fix
for a working path would only risk the behaviour the tests now pin down.

Most likely the report describes the live Vercel build, which predates this work.
Worth re-checking there after deploy.

### Verified

16 browser assertions, 0 console errors. An A/B against the reverted fix proves
the one-line change is responsible for exactly the world-placement failures and
nothing else: pre-fix **9 passed / 4 failed** (all four world-place), post-fix
**16 / 0**. Audio suites re-run for regressions (35 + 8 + 7, all green) — the
`block.place.*` events fire from the path this unblocks.

## UPDATE — audio-not-playing fix: E1 integration audit (2026-07-17)

Work order: `UPDATE-audio-not-playing-fix.md`. **Its two stated root causes were
already fixed** by the E1 commit (`e918c83`), which landed after the prompt was
written — verified rather than assumed:

| Prompt's claim | Actual state |
|---|---|
| "imported nowhere (`main.js` only imports `themeMusic.js`)" | `engine.js` imported by **16** files |
| "never constructed or booted" | `audio.boot()` at `main.js:34` |
| "context never unlocked on a user gesture" | **4** `audio.unlock()` sites |
| "no `audio.updateFrame()` / `audio.tick()` in the loop" | both wired (`Game.js:209`, `:254`, `:261`) |
| "`emitSound` is never called by any gameplay code" | **57** emit sites across **15** gameplay files |
| "`public/theme-music/` does not exist — every fetch 404s" | dev serves from `CC-assets/CC-sounds` via the `apply:'serve'` middleware; 0 × 404 |
| "set `musicMode` so in-game uses the synth composer" | already the `'menu'` default |

Re-verified against the **real browser autoplay policy** (no
`--autoplay-policy` override, a genuine trusted click): context is `suspended`
pre-gesture and `running` after press-start, with audio flowing immediately —
the prompt's prime suspect ("the single most common engine-present-but-silent
cause") is clean. Production build likewise: gesture unlocks, walking produces
synthesized footsteps at peak 0.60, **0 audio requests**, no 404s, no console
errors.

### One real defect the audit did find, now fixed

- **`musicMode: 'full'` with no cleared tracks was total in-game silence.**
  `Music.onOptions` suspended the §4 composer whenever the mode was `'full'`,
  but `menus.show()` only starts the theme layer `if (this.music?.available)`.
  Every public build today has an empty manifest, so `'full'` gave neither
  theme nor composer. §16's intro is explicit that the composer "remains the
  default and **the fallback**, so a fully-synthesized, zero-download ship is
  always possible" — so §4 now suspends only when the theme layer can actually
  play something.

### Deviation from the work order's Part B.1

**The C418 placeholders were NOT copied into `public/theme-music/`.** Part B.1
suggests copying them there for local audibility, gitignored. That reintroduces
the exact hazard E1's gate was designed around: Vite's `copyDir` dereferences
and copies `publicDir` into `dist/` at `renderStart`, so the placeholders would
land in every build and the ship gate would be racing a delete. The existing
dev-only middleware already achieves Part B.1's stated goal — 14 tracks audible
locally, 0 × 404 — while keeping a leak structurally impossible. `public/theme-music/`
stays reserved for genuinely cleared tracks + `CLEARED.json`.

### Known papercut (not a defect)

`npm run build` regenerates `src/audio/themeManifest.js` **empty** (`prebuild`,
by design — a shipped build has no cleared tracks). If a dev server is running,
it HMRs that empty manifest and the menu goes silent until `npm run dev` (whose
`predev` hook regenerates the 14 dev tracks) restarts. Building in a second
terminal while testing is therefore a plausible "the menu music stopped working"
report. In-game SFX and the synth composer are unaffected.

Verified 2026-07-17: **7 in-game + 4 real-autoplay-policy + 4 production
assertions**, plus the full E1 suite still green (35 acceptance + 8 regression +
3 music + 3 production). Menu: 14 tracks, running, themeGain 0.45.

## E1 — 16-AUDIO: synthesized SFX, positional sound, generative music (2026-07-17)

Built to `16-AUDIO.md`. New modules `src/audio/{engine,primitives,events,music,
ambience}.js` (the sixth, `themeMusic.js`, pre-existed from side-prompt 19).
**Everything is synthesized at runtime — zero sample files, zero audio fetches.**
The §4A theme layer stays OFF/empty (side-prompt 19 owns it).

### Amendments applied to the codebase (base specs stay frozen)

| AMENDS | Applied as |
|---|---|
| CLAUDE.md §6 / §7 | Already satisfied — §6 reads "and now audio (16's rule)"; audio is absent from §7. No edit. |
| 01 §2 | `src/audio/` with the six named files; `main.js`'s header now reads "build atlas, boot audio…". |
| 01 §3 | `audio.updateFrame()` in `Game.render()` (render step 6); `audio.tick()` in `Game.tick()` immediately after `save?.tick(this)` (tick step 10). |
| 01 §15.2 | `audio.unlock()` on every title/pause/death button + the canvas pointer-lock click + the keyboard PRESS START; `onPause`/`onResume` off `Game.setState`'s single funnel. |
| 01 §15.3 | Options screen: five sliders, Theme-music selector, mouse sensitivity, view bobbing — reachable from TITLE **and** PAUSE. |
| 01 §17.1 | `Game.debug.audioMs` + the F3 line (§6). |
| 04 §12.6 | `weather.thunder` emitted from the existing `DayNight.strikeLightning(x,y,z)`. |
| 06 §2 | `Mat` column: `BLOCKS[id].mat` + `matOf(id)` in `src/registry/blocks.js`. |
| 06 §12.4 | chew at use-ticks 8/16/24, swallow at 32, burp 10 ticks later. |

### Deviations

1. **`block.door` split into `block.door.open` / `block.door.close`.** §3.3 gives
   one id with two recipe variants ("380→640 Hz (open) / 640→380 (close)"), but
   §5.1's signature `emitSound(eventId, pos, pitchMult, gainMult)` has no param
   channel to carry open/close. Splitting matches what §3.6 already does for the
   `block.button.*.on/.off` family. Same reasoning for `block.lever.click.on/.off`
   (§3.6 says "param on/off") and `item.bucket.fill.lava`.
2. **`block.note` split into `block.note.<instrument>` (10 ids).** §3.5 says 16
   "supplies exactly one voice per instrument name that 07 emits in `block.note`'s
   `instrument` param" — again, no param channel exists. 07 calls
   `emitSound('block.note.' + instrument, pos, 2 ** ((n - 12) / 12))`; the pitch
   multiplier carries the note value exactly. `block.note` aliases the harp default.
3. **The event id is `weather.thunder`, not `weather.lightning`.** 16 contradicts
   itself: the AMENDS to 04 §12.6 says emit `weather.lightning`, while §3.5's
   table defines `weather.thunder`. The file's own intro says "**This file's
   registry (§3) is the master list**", so §3 wins.
4. **`weather.thunder` needs distance but is non-positional.** §3.5 marks it
   "ambient, non-positional" yet its recipe needs `d` for the <24-block crack gate
   and the `t0 + d × 0.06 s` rumble delay. Added a `distanceOnly` flag: the engine
   measures the distance to `pos` but allocates a FLAT (unpanned, unculled) voice.
   The alternative — smuggling distance through `pitchMult` — would have been a lie
   in the signature.
5. **Mob footsteps get their own `mob.step.<class>` family.** §3.2 gives them a
   distinct `capKey: 'mobStep'`, cap 4 and gain 0.3 against the player's cap 2 /
   gain 0.35. Reusing `block.step.*` with a gain multiplier would have let a crowd
   of mobs starve the player's own steps out of the shared cap.
6. **Creeper and Wither hurt/death derive from an invented timbre.** §3.4 gives
   both "*no idle*", but the generic rule derives hurt/death **from** the idle, and
   a creeper killed by a sword still calls `die()`. Creeper hurt/death derive from
   its fuse hiss; the Wither's from its klaxon sweep. No `.idle` id is registered
   for either, so the silent-creeper dread of §3.4 is structural.
7. **`voice.envGain` is a fade handle, not a volume stage.** §1.4's voice is
   `{envGain, panner, …}` and §2 says primitives build "into `voice.envGain`".
   Applying `gainMult` there *and* passing it to the recipe squares it — a
   10-damage fall peaked at 3.47 instead of 1.44 and slammed the limiter. Gain is
   now applied exactly once, inside each primitive's own gain node; `envGain` sits
   at 1.0 and exists for steals, loop releases and `handle.stop()`.
8. **`swellDir` materialised on the Creeper.** 05 §8.3 defines the field and 16
   §3.4 keys the fuse release off "its flip to −1", but the shipped code inlined it
   as `(pressure ? 1 : -1)` and stored nothing. Added `m.swellDir` (code was ground
   truth per CLAUDE.md §1; this restores the base spec's own field).
9. **Music lookahead schedules a bar at a time, not 100 ms.** §1.5 says "schedule
   every pending note with `noteTime < ctx.currentTime + 0.1`". The composer is
   bar-structured (chord walk + 1/8 grid), so it schedules whole bars — up to
   ~3.3 s ahead at 72 BPM. The two-clock property §1.5 actually cares about
   (JS picks *what*, the audio clock decides *when*) holds either way, and a
   partial bar cannot be scheduled without splitting the chord walk.
10. **Ambience adds a fire/furnace proximity scan.** §3.5's `ambient.fire.loop`
    names no sampling rule (unlike the fluid clusters' explicit 48-cell pass), so
    it reuses the same once-per-second pattern with a 24-cell scan at radius 8.
11. **`ambient.wind.loop`/`weather.rain.loop` recipes start at gain 0** and are
    driven by `ambience.js` from `rainLevel`/altitude on the same tick. The §3.5
    gains are formulas, not constants, so a recipe-side fade-in to full would blast
    one loud half-second at every rain onset.
12. **F3 audio line** (§6) reads `voices/pool · drops/s · ctx state · ms · mood#piece`.
    §6 also asks for "ctx.currentTime drift vs worldTime `(approx)`" — omitted: the
    context suspends with the game (§1.1), so the two clocks are decoupled by
    design and a drift number would be noise, not a diagnostic.
13. **Options: `musicMode` and the two 03 settings are now wired, not just stored.**
    Side-prompt 19 shipped the full §15.3 *schema* with only 3 of 5 sliders in the
    UI and no consumer for `mouseSensitivity`/`viewBobbing`/`musicMode`. E1 adds the
    Ambient/UI sliders, the Theme-music selector, and wires sensitivity into
    `Game.applyMouseLook` (clamped 0.1–3.0 — `loadOptions()` does not validate) and
    bobbing into `Game.updateCamera` (zeroing the offset, never `bobPhase`, which is
    deterministic tick state).
14. **The Options panel is a top-level sheet, not a child of `#screen-title`.**
    `.screen { display: none }` made the 19-era panel structurally unreachable from
    PAUSE, which this amendment requires. It moved to `screensEl`, the `--cc-*`
    palette moved from `#screen-title` to `:root`, and it gains an `.over-pause`
    scrim variant so it does not black out the live world behind it.
15. **`game.hud` is dead in three places** (`interaction.js:66/68`
    `hud?.onHotbarChange?.()`, `ItemEntity.js` `hud?.flashPickup?.()`). The HUD is
    at `game.ui.hud`, so all three are silent no-ops today. Logged per CLAUDE.md §1
    (code is ground truth); the `ui.hotbar` and `player.item_pickup` emits are
    placed as their own statements, never chained onto them. **Not fixed here** —
    out of E1's scope.
16. **`entity.arrow.hit_block` is the thud layer only.** §3.3's recipe is "thud +
    the *struck block's* `step` recipe at 0.5", which needs the block class —
    again no param channel. The hook emits `block.step.<class>` alongside it at
    gain 0.5, from the block actually hit.

### Defects found and fixed before landing

Found by hand while re-reading the gain path:

- **`gainMult` was squared** (deviation 7) — a 10-damage landing peaked at 3.47
  against the spec's 1.44, slamming the limiter.
- **Ambience loops played forever on the title screen.** `Game.tick()` early-returns
  once `disposeWorld()` nulls `world`, so `audio.tick()` — and ambience's own
  silence path — never ran again. Now stopped from `setState(TITLE)`.
- **A stolen loop's handle reported `alive === true`.** Voices are recycled, so
  handles now capture a generation counter.
- **Loop leaks on paths that never reach the owner:** TNT fuse (chunk unload) and
  creeper fuse (detonation sets `dead` directly, bypassing the goal) now stop from
  `onRemoved()`, the one hook every removal path calls. The bow draw loop stops on
  death, which returns before `updateUseChannel` and leaves `usingItem` set.
- **The level-up chime machine-gunned on every world load** — `deserialize()`
  replays the whole XP ladder through `addXp()`.
- **Enderman screamed on every hit** — the damage path sets `aggro = true`
  unconditionally, unlike the stare path's `!aggro` guard. Now edge-detected.
- **The dig gate would never have fired** — `swingLoop()` calls `swing()`, which
  resets `swingTicks` to 0, so the 6-tick test has to be read before it.
- **`ui.hotbar` double-fired** on a tick with both wheel and digit input, and fired
  when pressing the already-selected slot.
- **Rain/wind onset blasted** at full gain for ~0.5 s (deviation 11).

A multi-agent adversarial review (5 dimensions → per-finding refutation) raised 20
candidates; **7 confirmed, 12 refuted**, 1 inconclusive (its verifier errored) and
checked by hand. All 8 fixed:

- **Every looping voice self-released after ~1 s.** `crackle`/`hiss`/`noiseBurst`/
  `sweep` returned a finite `stopTime` even for `loop: true`, so the engine
  released the voice while the source played on — un-stoppable (its ref was
  cleared) and audible into whatever sound recycled the voice next. Loops now
  return `Infinity`. This silently broke the TNT fuse, the bow draw and the fire
  loop.
- **The title screen went permanently silent after 16 clicks.** §1.4's ≤16
  starts/tick counter resets in `audio.tick()`, which `Game.tick()` never reaches
  while `world` is null. `updateFrame` now mirrors that exact guard.
- **Save & Quit killed audio for the session.** `onResume` was keyed to
  PAUSED→PLAYING, but Quit is PAUSED→TITLE — leaving `masterGain` ramped to 0 and
  the context suspended. Now any exit from PAUSED resumes.
- **The per-family cap stole across sub-pools.** `item.bow.shoot` is flat for the
  player and positional for skeletons under one `capKey`, so the player's own shot
  could seize a skeleton's positional voice and render at its stale coordinates.
  The family is still counted across both pools; only the requested pool is
  returned.
- **The 5 ms declick was dead code** — `emitSound` cancelled the victim's fade from
  `now`. Both writes now land at `t0`, after the fade completes.
- **`ambient.fire.loop`'s brown bed went silent after 1 s** — `noiseBurst` applied
  its one-shot decay envelope even when looping, leaving a source running behind a
  gain pinned to 0. §3.5's second layer was effectively unimplemented.
- **No chime had its inharmonic partial.** §2.10's pack defaults `partial2 = 0.3`,
  but a truthiness check made it opt-in and no caller passed it — so every bell,
  glint and level-up chime lost the ×2.76 partial that makes struck metal read as
  struck.
- **The creeper fuse never restarted after winding down.** The re-arm was keyed to
  the swell leaving 0, but a creeper that winds down to swell 3 and re-approaches
  never returns to 0 — it detonated in silence, losing exactly the cue the event
  exists to give. Now keyed to "rising with no live voice".
- **Three registered events were never emitted:** `entity.arrow.hit_block` /
  `.hit_mob` (arrow impacts were silent), `mob.chicken.egg`, and
  `player.armor_equip` (both the use-path and the inventory-slot path). A registry
  sweep confirms the only remaining unemitted E1 event is `player.drink.gulp`,
  whose trigger §3.3 explicitly assigns to 09.

Verified 2026-07-17 (headless Chromium, dev + production build): **35 acceptance
+ 8 regression + 3 production + 3 music assertions**, zero console errors. Highlights: SFX
audible off a real analyser tap; stone vs sand and wool vs stone measured by
zero-crossing rate from isolated `OfflineAudioContext` renders (stone ZCR 3.5k vs
sand 9.7k; wool 155 vs stone 3.6k); explosion LP muffle 6000/985/200 Hz at
5/40/120 blocks; 100 simultaneous sounds never exceed the 32-voice pool and never
drop a UI click; starts throttle at 16/tick; note-block n0→n24 ratio exactly
4.0000; SFX slider 50 → 0.25 on `sfxBus` only; thunder at 150 blocks rumbles 12.6 s
out; piece 0 identical across two runs of one seed and different across seeds;
pause suspends the context with masterGain 0.0004. Perf: `updateFrame` worst
0.600 ms / avg 0.015 ms with 24 mobs + thunderstorm + music (budget ≤ 1.5 ms);
baked buffers 3.61 MB (budget ≤ 4 MB). **Production build: 0 audio files in
`dist/`, 0 audio requests in the network tab, 0 `/theme-music/` requests**;
`grep` for `fetch`/`decodeAudioData` outside `themeMusic.js` returns nothing.

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
