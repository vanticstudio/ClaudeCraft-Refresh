# 16 — AUDIO: Synthesized SFX, Positional Sound & Generative Music

This expansion adds a complete audio layer to ClaudeCraft: a Web Audio engine (context lifecycle, buses, 3D panning, voice pool), a library of synthesis primitives, the master **sound event registry** every other system fires into, an all-original generative music system, and an optional file-based **theme-music layer** (§4A) used by the title screen (19-MAIN-MENU) and, softly, as in-game background music. It reverses the base plan's "no audio" ruling — the Amendments below supersede CLAUDE.md §1's "No audio" sentence and re-add the thunder that 04 deleted. Baseline behavior model: Minecraft Java ~1.20 *sound behavior* (what triggers a sound, how it varies, how far it carries) — never its sound *content*.

**THE ORIGINALITY RULE (non-negotiable, same standing as the procedural-texture rule):** every sound and every note of music is **100% synthesized at runtime from oscillators, noise, and math**. No sample files, no downloads, no embedded base64 audio, no `fetch()` of any audio resource, no recording, and no recreation of copyrighted audio — do not transcribe, approximate by ear, or "cover" any Minecraft sound effect or any C418/Lena Raine composition. Recipes below describe sounds by physical character (band-passed noise, FM bell, plucked string) with original parameters; music is generated from seeded random walks over scale tables. For SFX and the generative composer, the production build's network tab must show **zero audio requests**, and no melody in the codebase may be a transcription of an existing work.

**SCOPED EXCEPTION — the theme-music layer (§4A).** One layer is exempt from the synth-only rule: an optional file-based **theme-music** layer that plays a playlist of tracks on the title screen and softly in-game. This is the *only* part of the audio system permitted to load audio files. It carries an **absolute copyright ship-gate**: only **original or properly-licensed/royalty-free** tracks may ever be bundled or served in a public build. The files currently in `CC-assets/CC-sounds/` are the copyrighted C418 Minecraft soundtrack and are **local development placeholders only** — gitignored and excluded from `dist/`; they must be swapped for original/cleared audio before any public ship (17-SHIP enforces this). The synth-only generative composer (§4) remains the default and the fallback, so a fully-synthesized, zero-download ship is always possible. Everything else in this file stays 100% synthesized, forever.

Sibling expansion files (07–15) each ship a sound-event table naming events they trigger. **This file's registry (§3) is the master list**: it owns every event's synthesis recipe, bus, and distance parameters; siblings own only the trigger conditions. Where a sibling's table omits an obvious event, the defaults defined here apply.

---

## Amendments to base files

- **AMENDS CLAUDE.md §6** (Working practices — the "100% procedural assets" bullet): the never-download rule extends to sound. All audio is synthesized at runtime via the Web Audio API per 16-AUDIO.md — no sample files, no embedded audio data, no copied melodies. (v2's §6 already reads "and now audio (16's rule)"; this pins the standing.)
- **AMENDS CLAUDE.md §7 (Out of scope v2):** ensure "audio" is absent from the out-of-scope list (now owned by 16-AUDIO.md).
- **AMENDS 01 §2** (module map): add a `src/audio/` directory with exactly six files (module count 52 → 58):
  - `audio/engine.js` — AudioContext lifecycle, master graph, buses, listener sync, voice pool, `emitSound` (§1)
  - `audio/primitives.js` — synth primitive library + buffer bakery (§2)
  - `audio/events.js` — the sound event registry: event id → recipe/bus/distance/caps (§3)
  - `audio/music.js` — generative composer, mood selector, note scheduler (§4)
  - `audio/ambience.js` — loop voices: rain, wind, fluid clusters, fire proximity (§3.5, §5)
  - `audio/themeMusic.js` — optional file-based theme-music layer (§4A): manifest, RAM/stream loader, shuffle, fades, inter-track pauses; the single module shared by the title screen (19-MAIN-MENU) and the soft in-game background
  Also amend `main.js`'s one-line responsibility to "…build atlas, **boot audio (create suspended context, bake buffers)**, construct Game…".
- **AMENDS 01 §3** (core loop): append render step 6: `audio.updateFrame()` (listener sync, tracked-voice positions, music lookahead scheduler); append tick step 10 (after `saveManager.tick()`): `audio.tick()` (ambience sampling, idle-voice timers, streak/duck timers).
- **AMENDS 01 §15.2**: the pointer-lock click handler and every TITLE-screen button handler additionally call `audio.unlock()` (§1.1). Entering `PAUSED` (incl. `visibilitychange → hidden`) calls `audio.onPause()`; returning to `PLAYING` calls `audio.onResume()`.
- **AMENDS 01 §15.3**: add an **Options screen** to `menus.js`, reachable from both TITLE and PAUSE. Contents: five audio sliders 0–100 (`Master`, `Music`, `Ambient`, `SFX`, `UI` — defaults 100/70/100/100/100; the `Music` slider governs both the generative composer and the §4A theme-music layer, whichever is active), a **Theme music** selector (`Off` / `Menu only` / `Menu + gameplay` — default `Menu only`, driving `musicMode` in §4A), plus the two settings 03 already references (mouse sensitivity 0.1–3.0, view bobbing toggle). Persist all options to `localStorage` key `claudecraft.options.v1` as JSON on change (migrate a legacy `voxelcraft.options.v1` if found); load at boot. Options are per-browser, not per-world — they do NOT enter the IndexedDB save (decision: settings survive world deletion).
- **AMENDS 01 §17.1** (budget table): add row — Audio CPU (main thread: emit + updateFrame) | ≤ 1.5 ms/frame | 0.1–0.4 ms.
- **AMENDS 04 §12.6** (lightning): re-add thunder. Append to the gameplay-event list: "emit `weather.lightning` with the strike position to the audio layer (16 §3.5): an immediate crack when the listener is within 24 blocks, and a delayed rumble at `delay = dist × 0.06 s` (16's scaled speed of sound)."
- **AMENDS 06 §2** (block registry — gameplay table): add a **`Mat`** (material class) column; values per the complete mapping table in this file §3.1. Blocks added by later expansions must fill this column (nether-family blocks default `nether`, end-family `end` per §3.1).
- **AMENDS 06 §12.4** (eating): the 32-tick eat channel emits `player.eat.chew` at use-ticks 8, 16, 24 and `player.eat.swallow` at 32 (hook only; recipes in §3.3).

All other integrations are listen-only hooks (no base behavior changes); the full hook-point table is §5.2.

---

## Contents

1. [Audio engine](#1-audio-engine)
2. [Synth primitive library](#2-synth-primitive-library)
3. [Sound event registry](#3-sound-event-registry)
4. [Generative music system](#4-generative-music-system)
4A. [Theme / background music (file-based, optional)](#4a-theme--background-music-file-based-optional)
5. [Event wiring & API](#5-event-wiring--api)
6. [Performance budget](#6-performance-budget)
7. [Acceptance checklist](#acceptance-checklist)

---

## 1. Audio engine

### 1.1 AudioContext lifecycle & the gesture rule

Browsers refuse to start audio without a user gesture: a context created before the first user interaction begins in the `suspended` state and must be `resume()`d from inside a gesture handler (MDN autoplay policy). ClaudeCraft's flow already funnels every session through clicks (TITLE buttons, canvas click for pointer lock — 01 §15.2), so:

```js
// audio/engine.js — boot (called from main.js during LOADING, after atlas build)
const ctx = new AudioContext({ latencyHint: 'interactive' });   // starts 'suspended' pre-gesture
bakeBuffers(ctx.sampleRate);          // §2.1 — all noise/pluck/loop buffers, once, ≤ 80 ms
buildGraph();                         // §1.2 — master, compressor, buses, voice pool

unlock() {                            // wired into TITLE buttons + pointer-lock click (Amendment)
  if (ctx.state !== 'running') ctx.resume();   // must be inside the gesture handler
}
```

- `unlock()` is idempotent and cheap; call it from **every** button/canvas gesture handler rather than tracking "first click" state. The context is guaranteed running by the time PLAYING starts (the Play click and the lock click are both gestures).
- **Pause / tab hidden** (01 §15.2 enters `PAUSED` on both): `onPause()` ramps master gain to 0 over 80 ms (`setTargetAtTime`, τ=0.02) then `ctx.suspend()` 150 ms later (`setTimeout`) — suspending after the fade prevents the hard-cut click. `onResume()`: `ctx.resume().then(() => ramp master back over 150 ms)`. Suspension freezes all scheduled events in place, matching the frozen game accumulator — nothing desyncs.
- Safari's nonstandard `interrupted` state (phone call, etc.) is treated as `suspended`: `ctx.onstatechange` re-arms `unlock()` on the next gesture.
- The context is never `close()`d; it is a process-lifetime singleton like the texture atlas.

### 1.2 Master graph & buses

```
                    ┌─ sfxBus (Gain) ──────┐
 voices/loops ──────┼─ ambientBus (Gain) ──┤
 music voices ──────┼─ musicBus (Gain) ────┼─▶ masterGain ─▶ DynamicsCompressor ─▶ ctx.destination
 ui one-shots ──────┴─ uiBus (Gain) ───────┘
```

- **DynamicsCompressor settings** (safety limiter — keeps stacked explosions from clipping, near-transparent otherwise): `threshold −18 dB, knee 24, ratio 6, attack 0.003 s, release 0.25 s`.
- Bus gains map from the options sliders: `busGain = (slider/100)²` (square law ≈ perceptual loudness taper; slider 50 → −12 dB). `masterGain` likewise from the Master slider. Slider writes use `setTargetAtTime(v, now, 0.03)` — no zipper noise while dragging.
- Bus roles: `sfx` = every world/entity/player one-shot; `ambient` = weather, fluid loops, wind, fire loops, thunder, block ambience; `music` = §4 only, never positional; `ui` = clicks, inventory sounds, XP/level chimes — never positional, unaffected by world state.

### 1.3 Positional chain, panning model & listener

Per positional voice: `source(s) → envGain → PannerNode → bus`.

```js
new PannerNode(ctx, {
  panningModel: 'equalpower',      // decision, below
  distanceModel: 'inverse',
  refDistance: 1,                  // 1 block = 1 m; overridden per event (§3 tables)
  maxDistance: 24,                 // per event; inverse model clamps distance to [ref, max]
  rolloffFactor: 1,
  coneInnerAngle: 360              // no directional cones anywhere in v1
});
```

**Decision — `equalpower`, not `'HRTF'`:** HRTF runs a per-source convolution with measured head impulse responses — noticeably higher CPU per voice and audible latency/coloration differences across browsers; equalpower is the spec default, costs ~nothing, and reads clearly for gameplay ("creeper is left and close"). With up to 32 concurrent voices on a mid-range laptop, equalpower is the only budget-honest choice. Vertical cues are sacrificed `(approx)` — acceptable: gameplay directionality in a blocky world is dominantly horizontal.

- Gain vs distance (inverse, rolloff 1, ref 1): `g = 1/max(d,1)` → −6 dB at 2 blocks, ~−24 dB at 16. Loud events raise `refDistance` instead of gain (explosion ref 8): same curve, shifted outward.
- **Cull radius = the event's `maxDistance`**: events farther from the listener than `maxDistance` are not played at all (the inverse model would otherwise sustain a floor gain forever). Check before voice allocation — free voices are never spent on inaudible sounds.
- One-shot voices are **positionally static**: `panner.positionX/Y/Z.value` set once at spawn (block/mob positions don't move audibly within a 100–600 ms sound). Only voices with `tracked` set (loop voices bound to an entity or fluid cluster) update position — once per frame for entity-tracked, once per second for cluster loops.
- **Listener sync** — every frame in `audio.updateFrame()`, from the *interpolated* camera (01 §3 render step 2):

```js
const l = ctx.listener, p = camPos, f = camForward, u = camUp;
if (l.positionX) {                            // modern AudioParam form
  l.positionX.value = p.x; l.positionY.value = p.y; l.positionZ.value = p.z;
  l.forwardX.value  = f.x; l.forwardY.value  = f.y; l.forwardZ.value  = f.z;
  l.upX.value = u.x;       l.upY.value = u.y;       l.upZ.value = u.z;
} else { l.setPosition(p.x,p.y,p.z); l.setOrientation(f.x,f.y,f.z,u.x,u.y,u.z); } // old-Safari fallback
```

Direct `.value` writes at display fps are artifact-free in practice for listener params `(approx)`; no ramps needed.

### 1.4 Voice pool, priority & concurrency

**Decision — pooled voice chains + fire-and-forget source nodes.** Web Audio source nodes (`AudioBufferSourceNode`, `OscillatorNode`) are one-shot by specification — they cannot be restarted, and the platform is engineered for them to be created per play and garbage-collected after `onended` (they are lightweight handles to audio-thread objects). What IS worth pooling: the `Gain → Panner → bus` chain (PannerNode construction is the expensive part) and every `AudioBuffer` (allocation-free playback). So:

- **Pool: 32 voices** = 24 positional (`envGain → panner`) + 8 flat (`envGain` only — self/UI/non-positional). Pre-built at boot, never destroyed. A voice is `{ envGain, panner|null, busy, startTime, priority, capKey, tracked }`.
- Acquire: connect the chain's tail to the target bus, set panner params/position, create source node(s) per the recipe, connect to `envGain`, schedule, mark busy. Release (source `onended` or steal): disconnect tail from bus, cancel scheduled values on `envGain.gain`, `busy = false`.
- **Priority classes**: `UI 3 > PLAYER 2 > NEAR 1 (event dist < 16) > FAR 0`. When the needed sub-pool is exhausted: steal the **oldest** busy voice whose priority is *lower* than the incoming event's (fade 5 ms → `source.stop()`); if none is lower, **drop the new sound**. Dropping distant sounds is inaudible; dropping UI/player feedback is not — hence the ordering.
- **Per-event concurrency caps** (`capKey` = event family): a new emit whose family is at cap steals the oldest voice *of that family* (not a drop — newest information wins). Defaults: 2 unless the §3 tables say otherwise (footsteps 2, explosions 4, mining dig 1, mob idles 4, UI 4).
- Global throttle: ≤ **16 voice starts per game tick**; excess emits are dropped lowest-priority-first (log at debug level).

### 1.5 Clocks & scheduling

- All scheduling uses `ctx.currentTime` (the audio hardware clock), never `performance.now()`.
- **One-shots**: start at `ctx.currentTime + 0.005` — a 5 ms guard so every envelope's `setValueAtTime(…, t0)` lands before playback reaches `t0` (prevents first-sample clicks).
- **Music & sequenced events** (note blocks tested by 07, music §4): lookahead scheduler in `audio.updateFrame()` — each call schedules every pending note with `noteTime < ctx.currentTime + 0.1`. With frames at 60 Hz the effective lookahead is ≥ 50 ms (two game ticks), the classic two-clock pattern: JS picks *what* plays; the audio clock decides *exactly when*. Tab-hidden stalls are safe because the context suspends with the game (§1.1).
- Envelope rule: `exponentialRampToValueAtTime` can never target 0 — ramp to `0.001`, then `setValueAtTime(0, t + 0.005)`. Loop releases use `setTargetAtTime(0, now, 0.05)` + `stop(now + 0.4)`.

### 1.6 Hot-path allocation policy

Zero allocation in the emit path except the platform-mandated source nodes:

| Resource | Policy |
|---|---|
| Noise / pluck / loop `AudioBuffer`s | Baked once at boot (§2.1), shared by every voice forever |
| Voice chains (Gain, Panner) | Pooled (§1.4) |
| Source nodes | Fire-and-forget per play (spec-mandated one-shots; ~µs to create, GC'd after `onended`) |
| Filters in recipes | Created with the source, same fire-and-forget lifetime; ≤ 3 nodes per one-shot |
| Param curve arrays | Module-scope reused `Float32Array`s (`setValueCurveAtTime` copies internally) |
| Event lookup | `Map<string, EventDef>` built once from §3; `emitSound` allocates no closures/objects (options passed as 3 scalar args) |

**Decision — no AudioWorklet.** Every recipe below is expressible with native nodes plus pre-baked buffers; native nodes already run compiled code on the audio thread. A worklet would add an async module load, cross-thread messaging, and a hand-rolled DSP surface for zero capability gain. Revisit only if a future expansion needs per-sample custom DSP.

---

## 2. Synth primitive library

`audio/primitives.js`. Each primitive is a pure function `prim(voice, t0, params) → stopTime`: it builds its small node graph into `voice.envGain`, schedules envelopes at `t0`, calls `source.start(t0)` / `stop(stopTime)`, and returns. Recipes in §3 are named primitive calls with parameter packs.

### 2.1 Buffer bakery (boot, deterministic)

All stochastic source material is baked once into `AudioBuffer`s at `ctx.sampleRate` using the seeded PRNG from 01 `math/rng.js` (`mulberry32(xmur3('audio:'+name)())`) — identical sound every run, mirroring the texture rule. Bake list (mono, ≈ 3.5 MB total at 48 kHz):

| Buffer | Len | Content |
|---|---|---|
| `white` | 2 s | uniform noise in [−1, 1] |
| `pink` | 2 s | white through Paul Kellett's economy pink filter (code below), peak-normalized |
| `brown` | 2 s | integrated white: `b = (b + 0.02·w) / 1.02`, ×3.5 |
| `impulses` | 2 s | sparse Poisson impulse train, mean 30 impulses/s, amplitude ±uniform(0.4,1) — crackle source |
| `pluckA` | 1.2 s | Karplus-Strong bake at 220 Hz, blend 0.996 (§2.4) |
| `pluckBass` | 2 s | Karplus-Strong bake at 55 Hz, blend 0.998 |
| `loopRain` | 2 s | pink×0.7 through BP 1.1 kHz Q0.5 + 40 baked droplet blips (600–2400 Hz, 15 ms) `(approx)` |
| `loopWater` | 2 s | brown×0.6 LP 900 Hz + slow 0.5 Hz amplitude wobble + 6 baked burble chirps |
| `loopLava` | 2 s | brown×0.8 LP 300 Hz + 8 baked "glop" thuds (sine 90→50 Hz) + sparse crackle |
| `loopWind` | 2 s | pink through BP 400 Hz Q0.4, amplitude wobble 0.3 Hz |

```js
// pink filter (Kellett economy), run over white noise w[i]:
b0 = 0.99765*b0 + w*0.0990460;  b1 = 0.96300*b1 + w*0.2965164;
b2 = 0.57000*b2 + w*1.0526913;  out = b0 + b1 + b2 + w*0.1848;   // then normalize peak to 1
```

Every `loop*` buffer is made seamless in the bake: the final 100 ms is equal-power crossfaded into the first 100 ms. Baking is plain JS loops over `Float32Array`s (< 80 ms total on the LOADING screen).

### 2.2 Global variation rule (MC-style)

Every play of every event applies, unless the event sets `jitter: 0` (music notes, note blocks, UI):

```
pitchMult = 2^(uniform(−0.15, +0.15))        // ≈ ±10% frequency / playbackRate
gainMult  = uniform(0.85, 1.0)
```

`Math.random()` is permitted here (cosmetic jitter per CLAUDE.md §4). Pitch applies to `playbackRate` (buffer sources) or all `frequency` params (oscillators) — filter frequencies scale with pitch too, so timbre transposes coherently.

### 2.3 `noiseBurst` — the workhorse (digs, steps, breaks, rattles)

```
params { src:'white'|'pink', filter:'bp'|'lp'|'hp', freq, Q, dur, attack=0.002, gain }

white/pink buffer source (random start offset 0..1 s, playbackRate=pitchMult)
  → BiquadFilter(filter, freq×pitchMult, Q)
  → envGain: 0 → gain (attack) → exp 0.001 (dur)
```

Random buffer offset makes every burst a different noise slice — no machine-gun effect.

### 2.4 `thud` — impacts, falls, heavy landings

```
params { f0=160, f1=55, dur=0.12, noiseGain=0.4, gain }

sine osc: freq f0 → exponentialRamp f1 over dur;   env: 0→gain (2 ms) → exp decay dur
+ layer: noiseBurst(white, lp 300 Hz, Q 0.7, dur×0.7, gain×noiseGain)
```

### 2.5 `pluck` — Karplus-Strong plucked string (notes, pickups, twangs)

The physical model: a burst of noise circulates in a delay line of length `1/f` seconds; a damping low-pass in the loop bleeds off highs each pass — the noise rings into a string tone.

```
reference node-graph form (do NOT ship — see decision):
  noiseBurst(1/f s) ─▶ Delay(1/f) ─┬▶ out
                        ▲          └▶ LP(f×8) ─▶ Gain(0.98) ─┐
                        └────────────────────────────────────┘   (feedback loop)
```

> Adaptation: **the pluck is baked, not run live.** The Web Audio spec clamps any delay inside a feedback cycle to at least one render quantum (128 samples), so a live loop cannot play above ≈ `sampleRate/128` ≈ 344 Hz and detunes approaching it. Instead the identical difference equation is run in plain JS into the `pluckA`/`pluckBass` buffers at boot, and pitch comes free via `playbackRate` — zero play-time cost, implementation-proof tuning.

```js
function bakePluck(freq, blend, dur, sr, rng) {     // blend 0.990 (dull) .. 0.999 (ringing)
  const N = Math.round(sr / freq), out = new Float32Array(Math.round(dur * sr));
  for (let i = 0; i <= N; i++) out[i] = rng() * 2 - 1;              // noise excitation
  for (let i = N + 1; i < out.length; i++)
    out[i] = blend * 0.5 * (out[i - N] + out[i - N - 1]);           // delay + averaging LP
  return out;                                                        // peak-normalize
}
// play: bufferSource(pluckA).playbackRate = (targetHz / 220) × pitchMult
```

Valid `playbackRate` range ±2 octaves from the bake frequency before the timbre thins `(approx)`; use `pluckBass` below 110 Hz.

### 2.6 `blip` — UI ticks, pops, small mechanics

```
params { wave:'square'|'triangle', freq, dur=0.05, gain }
osc(wave, freq) → envGain: 0→gain (2 ms) → exp 0.001 (dur)
```

### 2.7 `sweep` — risers, zaps, fuses

```
params { src:'osc'|'noise', wave?, f0, f1, dur, filter?{type,Q}, gain }
osc:   osc(wave, f0) with frequency.exponentialRampToValueAtTime(f1, t0+dur)
noise: white source → BiquadFilter(bp, f0→f1 ramp, Q)
env: 0→gain (10% dur) → hold → exp 0.001 (last 20% dur)
```

### 2.8 `crackle` — fire, embers, creaks

```
params { density=1, freq=1800, Q=1.5, dur, gain, loop=false }
impulses buffer source (playbackRate = density; random offset; loop for loops)
  → BiquadFilter(bp, freq, Q) → envGain
```

`playbackRate` scales the baked 30 impulses/s: density 0.6 → sparse pops, 2 → roaring fire.

### 2.9 `drone` — pads, portals, beacons, boss beds

```
params { waves:['sawtooth','sawtooth','triangle'], freqs:[f, f×1.005, f×0.5], lpFreq, lfo:{rate, depth, target:'lp'|'gain'}, gain, dur|loop }
2–3 detuned oscs → mix Gain → BiquadFilter(lp, lpFreq)
LFO: osc(sine, rate) → Gain(depth) → (lp.frequency | mixGain.gain)
env: 0→gain over ≥ 0.5 s attack; release setTargetAtTime(0, tEnd, 0.4)
```

### 2.10 `chime` — bells, sparkles, level-ups (2-op FM)

```
params { freq, ratio=3.53, index=3, dur=1.2, partial2=0.3, gain }
mod  = osc(sine, freq×ratio) → modGain(freq×index, exp-decays to 0 over dur×0.7)
mod → modGain → carrier.frequency        // AudioParam connection = FM
carrier = osc(sine, freq) → envGain: 0→gain (3 ms) → exp 0.001 (dur)
+ partial: osc(sine, freq×2.76) at gain×partial2, same env (approx)
```

Non-integer ratios (3.53, 2.76) give the inharmonic clang of struck metal/glass; ratio 1.4 + long decay reads as a church bell.

### 2.11 `hiss` — fuses, air, hats

```
params { freq=6000, Q=0.7, dur, gain }
white source → BiquadFilter(hp or bp, freq, Q) → envGain (attack 5 ms, linear decay dur)
```

### 2.12 `gulp` — eating, drinking, bubbles, squelches

```
params { dur=0.12, wobble:[300,180,260], gain }
sine osc: frequency setValueCurveAtTime(wobble curve, t0, dur×0.8)
  → envGain (attack 5 ms, exp decay dur)
+ layer: noiseBurst(white, lp 600, Q 1, dur×0.6, gain×0.5)
```

### 2.13 `whoosh` — flybys, wind, wings, travel

```
params { f0, f1, Q=0.8, dur, gain, loop=false }
white/pink source → BiquadFilter(bp, f0→f1 exponential ramp, Q) → envGain (swell: linear up 40% dur, down 60%)
loop form: bp frequency + gain driven per-frame from a speed input (elytra/wind, §3.5)
```

---

## 3. Sound event registry

`audio/events.js` — master table. Registry entry schema:

```js
EVENTS['mob.creeper.fuse'] = {
  recipe,               // (voice, t0, pitchMult, gainMult) → calls §2 primitives
  bus: 'sfx',           // sfx | ambient | music | ui
  refDist: 1, maxDist: 24,   // positional params; maxDist is also the cull radius (§1.3)
  cap: 2, capKey: 'creeperFuse',
  priority: P.NEAR,     // upgraded to P.PLAYER automatically when pos is omitted (self)
  jitter: 1,            // 0 disables §2.2 variation
  replicate: true       // multiplayer relay flag (§5.3); default true for positional events
};
```

Defaults when a column below is blank: bus `sfx`, refDist 1, maxDist 16 (steps 12, breaks/places 16), cap 2, jitter on, replicate = positional.

### 3.1 Material classes (AMENDS 06 §2 — the `Mat` column)

Twelve classes + two reserved for later dimensions. **No `slime` class** — no slime blocks exist in any current file; add the class only when a block needs it.

| Class | Blocks (06 §2 names) |
|---|---|
| `stone` | stone, cobblestone, sandstone, bedrock, obsidian, furnace, furnace_lit, coal_block |
| `ore` | coal_ore, iron_ore, gold_ore, diamond_ore, redstone_ore, lapis_ore |
| `metal` | iron_block, gold_block, diamond_block |
| `wood` | oak/birch/spruce_planks, oak/birch/spruce_log, crafting_table, chest, bookshelf, ladder, oak_fence, oak_door, bed_block, torch, pumpkin, jack_o_lantern |
| `gravel` | gravel, dirt, farmland |
| `sand` | sand |
| `grass` | grass_block, oak/birch/spruce_leaves, all saplings, all crops, sugar_cane_block, short_grass, dandelion, poppy, dead_bush, tnt |
| `glass` | glass, ice, glowstone |
| `wool` | wool_white/red/blue/black, cactus |
| `snow` | snow_layer, snow_block |
| `fluid` | water, lava (no dig/step verbs — splash/bucket events instead, §3.3/§3.5) |
| `none` | air, fire (fire's voice is the crackle loop, §3.5 — punching fire emits `block.extinguish`) |
| `nether` *(reserved — 10's blocks default here)* | gravel recipe pitched ×0.84 + hiss layer 3 kHz at 0.25 gain `(approx — soft, dense, organic)` |
| `end` *(reserved — 11's blocks default here)* | stone recipe pitched ×1.12 through extra BP 620 Hz Q3 + chime glint at gain 0.1 `(approx — hollow, glassy)` |

### 3.2 Block verbs: step / dig / break / place per class

Four generated event families per class: `block.step.<class>`, `block.dig.<class>`, `block.break.<class>`, `block.place.<class>`.

**Verb rules (uniform across classes):**

| Verb | Derivation from the class core recipe | Gain | maxDist | Trigger |
|---|---|---|---|---|
| step | core at `dur` from table | 0.35 | 12 | distance accumulator, below |
| dig | core at dur×1.6 | 0.5 | 14 | every 6 ticks while mining, aligned to 03 §15.3's `playSwing()` loop (swing = 6 ticks); not on instant breaks |
| break | dig + the class's break layer, pitch ×0.9 | 0.8 | 16 | 03 §15.3 `breakBlock()` |
| place | dig recipe, pitch ×0.8 | 0.7 | 16 | 03 §16.2 successful placement |

**Class core recipes** (all `noiseBurst` unless noted; freq/Q are the filter; step dur listed, dig = ×1.6):

| Class | Core | Step dur | Break layer |
|---|---|---|---|
| stone | white BP 900 Hz Q1.2 | 70 ms | thud(f0 220, f1 90, 80 ms) at 0.5 |
| ore | stone core | 70 ms | stone layer + chime(2700 Hz, ratio 3.53, 0.15 s) at 0.12 — the "glint" |
| metal | white BP 1200 Hz Q4 | 60 ms | chime(2400 Hz, ratio 2.76, 0.3 s) at 0.4 — clank ring |
| wood | pink LP 700 Hz Q0.7 | 80 ms | thud(160→70, 0.1 s) at 0.6 |
| gravel | white LP 1400 Hz Q0.5 | 90 ms | crackle(density 1.4, 1.1 kHz, 0.12 s) at 0.4 |
| sand | white BP 2200 Hz Q0.6 | 90 ms | second sand burst at +20 ms, 0.5 gain (soft double-shuff) |
| grass | pink LP 1000 Hz Q0.5, extra pitch jitter ±15% | 65 ms | gulp(0.08 s, wobble [500,300,380]) at 0.3 — moist snap |
| glass | white BP 2800 Hz Q2 | 55 ms | chime cluster: 3× chime(1800/2390/3170 Hz, ratio 3.98, 0.35 s) at 0.35 — shatter |
| wool | pink LP 400 Hz Q0.5, gain ×0.7 | 90 ms | none (muffled thump only) |
| snow | white BP 500 Hz Q0.5, two stacked bursts 25 ms apart | 90 ms | crunch = 3 stacked bursts |
| nether / end | per §3.1 derivation | 85 / 70 ms | inherit source class layer |

**Footstep trigger rule (player — exact):** each tick while `onGround && !inWater` (03 §4 step 7 context): `stepAccum += horizontal distance moved this tick`. When `stepAccum ≥ 1.5` blocks: `stepAccum −= 1.5`; emit `block.step.<class>` for the block at `(x, y−0.5, z)` (03 §5.3's under-feet cell); skip silently for `none`/`fluid` classes. Cadence is therefore emergent from 03 §5's speeds: walk 4.317 m/s → 2.9 steps/s, sprint 5.612 → 3.7/s, sneak 1.295 → 0.86/s. **Sneaking: steps still play at −6 dB** (gain ×0.5) — audible to the sneaker, effectively inaudible to others at range. Landing from a fall > 0.5 blocks emits one step at gain ×1.5; jumping itself is silent (MC parity). Swimming replaces steps with `player.splash` every 1.8 m moved in water.

**Mob footsteps:** same accumulator rule per mob (threshold 1.5, chicken/spider 1.0), capKey `mobStep`, cap 4, maxDist 12, gain 0.3 — this is the "zombie scraping toward you in the dark" channel.

### 3.3 Player events

Self-emitted events use the flat (non-positional) pool at priority PLAYER; in multiplayer, *other* players' copies render positionally with the listed distances.

| Event id | Recipe | Trigger (base ref) |
|---|---|---|
| `player.hurt` | triangle sweep 200→140 Hz 0.15 s + white LP 800 burst 0.1 s, gain 0.8 — a dry "uh" grunt, no voice acting | 03 §20.2 damage lands (post i-frame check) |
| `player.hurt.fire` | `player.hurt` + hiss(4 kHz, 0.2 s, 0.3) | fire/lava/burn damage tick (03 §11) |
| `player.hurt.drown` | `player.hurt` + 2× gulp(0.1 s) bubbles | drowning tick (03 §10.2) |
| `player.death` | sweep osc saw 300→60 Hz 0.6 s LP 900 + thud(120→45, 0.3 s), gain 0.9 | 03 §20.5 |
| `player.fall.small` | thud(160→80, 0.1 s) gain 0.5 | landing, fallDistance 0.5–3 (03 §12) |
| `player.fall.big` | thud(140→40, 0.25 s, noiseGain 0.7), gain 0.6 + 0.1×min(damage,10) | landing with fall damage (03 §12.3) |
| `player.eat.chew` | gulp(90 ms, wobble [420,280,360]) gain 0.5 | use-ticks 8/16/24 of the 32-tick eat (06 §12.4 amendment) |
| `player.eat.swallow` | gulp(0.18 s, wobble [300,140,90]) + blip(triangle 180 Hz, 60 ms) gain 0.6 | use-tick 32 |
| `player.eat.burp` | saw osc 85→50 Hz, LP 400, 0.3 s, gain 0.5 | 10 ticks after swallow, always |
| `player.drink.gulp` | gulp(0.12 s, wobble [350,220,300]) gain 0.5 | drinkable use-channel ticks 8/16/24/32 (09 owns triggers; default = eat channel) |
| `player.xp_pickup` | pluck at `520 × 2^(min(orbStreak,24)/12)` Hz, 90 ms, gain 0.4, jitter 0 | XP orb collected (05 §15). `orbStreak` increments per orb, resets after 40 ticks without a pickup — collecting a spray plays a rising run |
| `player.levelup` | 3× chime(660/990/1320 Hz, ratio 2.0, 0.5 s) at t0/+120/+240 ms, gain 0.5, bus ui | XP level integer increases (06 §13) |
| `player.item_pickup` | pluck 1300 Hz 70 ms + blip(triangle 900 Hz, 40 ms), gain 0.35, bus ui, cap 3 | item entity absorbed (06 §16 pickup) |
| `player.item_break` | metal break layer at 0.5 + whoosh(1200→300, 0.15 s) 0.3 — the "poof + break sound" 06 §7.1 already names | tool/armor durability hits 0 (06 §7.1) |
| `item.bow.draw` | crackle loop, density ramping 0.6→1.8 and BP 350→550 Hz over the 20-tick draw, gain 0.25 | RMB-hold with bow (06 §7.1, per 05 §8.2 timing); stops on release/cancel |
| `item.bow.shoot` | pluck 140 Hz (pluckBass rate) 0.25 s + whoosh(900→2200, 0.18 s) 0.4 — twang | arrow spawned (05 §11; skeletons reuse, maxDist 24) |
| `entity.arrow.hit_block` | thud(300→150, 60 ms) 0.4 + struck block's `step` recipe at 0.5 | arrow block impact (05 §11) |
| `entity.arrow.hit_mob` | thud(220→110, 80 ms, noiseGain 0.8) 0.5 | arrow entity impact (05 §11) |
| `player.armor_equip` | metal: chime(2400, ratio 2.76, 0.15 s) 0.3; leather: wool step ×1.2 | armor slot content changes (06 §14.2), bus ui |
| `player.splash` | white BP 1500→600 Hz sweep 0.25 s + 2 gulps, gain scaled by fall speed (0.3–0.8) | entering water with `vy < −0.3`, or swim-step (above) |
| `item.bucket.fill` | 2× gulp(0.1 s) + splash 0.4 | 06 §6.4 bucket scoop (lava: gulps ×0.6 rate + crackle 0.2) |
| `item.bucket.pour` | splash + hiss(2 kHz, 0.3 s) 0.35 | 06 §6.4 placement |
| `block.door` | pluck 90 Hz 0.15 s (pluckBass) + sweep osc triangle 380→640 Hz 0.18 s (open) / 640→380 (close), gain 0.5, maxDist 16 | 06 §5.13 toggle |
| `block.chest.open` | sweep osc saw 240→170 Hz 0.3 s LP 600 (creak) + wood step 0.4 | chest UI opened (06 §5.3) |
| `block.chest.close` | thud(180→80, 0.12 s) + wood step 0.4 | chest UI closed |
| `block.extinguish` | hiss(3 kHz, 0.25 s) 0.5 + gulp 0.3 | fire punched out (06 §5.14), lava→cobble/obsidian (01 §6.3), TNT/fire doused by rain (15) |
| `ui.click` | blip(square 800 Hz, 30 ms) gain 0.25, bus ui, jitter 0, cap 4 | every button/slot click (06 §14.2, menus) |
| `ui.hotbar` | blip(square 1200 Hz, 20 ms) gain 0.2, bus ui, jitter 0 | hotbar selection change (06 §14.3) |

### 3.4 Mob voices

**Generic rules** — each mob defines one *idle timbre*; then: `hurt` = idle recipe at pitch ×1.19 (+3 st), duration ×0.4, gain ×1.1; `death` = idle at pitch ×0.79 (−4 st), duration ×1.5, with a linear pitch fall of −30% across the tail. Exceptions listed. **Idle cadence:** each mob rolls `nextIdle = 80 + randInt(80)` ticks (4–8 s); on expiry, emit the idle event only if the player is within 16 blocks (creepers and spiders in stalk mode stay silent — MC's silent-creeper dread is a feature). All mob voices: bus sfx, refDist 1, maxDist 16 (boss/large mobs noted), capKey per mob, cap 3.

| Mob | Idle voice recipe (timbre spec — build from §2 primitives) | Specials |
|---|---|---|
| Zombie | saw osc 82 Hz, ±7 Hz sine wobble at 5 Hz, LP 500 Hz, 0.6 s swell-decay + pink BP 250 growl layer 0.3 gain — a hollow moan-growl | — |
| Skeleton | bone rattle: 5× noiseBurst(white BP 2400 Hz Q8, 25 ms) at 22 ms spacing, gain 0.5 | death: 8-burst rattle descending BP 2400→900 Hz over 0.8 s |
| Creeper | *no idle* | `mob.creeper.fuse`: sweep(noise BP 700→4500 Hz Q2, 1.5 s) + hiss(5 kHz) 0.3 — starts when 05 §8.3's swell leaves 0 rising; on `swellDir` flip to −1, release-fade 0.2 s; the 1.5 s ramp = 30 swell ticks, the player's reaction window |
| Spider | chitter: 10 noiseBurst(white BP 3000 Hz Q6, 15 ms) at random 30–60 ms gaps, gain 0.4, pitch jitter ±20% | hurt: chitter ×0.5 dur + gulp squelch |
| Enderman | FM warble: carrier sine 110 Hz, mod 13 Hz index 25→5, LP 800, 1.2 s, gain 0.6 — alien throb | `mob.enderman.scream` on provocation (05 §8.5): warble + saw layer +12 st + white BP 1.5 kHz Q1, 1.0 s, gain 0.9, maxDist 24. `mob.enderman.teleport`: sweep osc sine 1600→150 Hz 0.18 s + hiss 0.1 s, at BOTH endpoints (dual emit) |
| Cow | formant blend: saw 88→62 Hz over 0.8 s through two parallel BPs (F1 320 Hz Q5, F2 700 Hz Q6, mixed 1:0.6), swell-decay — a synthetic bovine vowel, deliberately not a recorded moo | — |
| Pig | double chirp: triangle 240→170 Hz 0.14 s ×2 at 180 ms gap, BP 900 Hz Q4 (nasal), gain 0.6 | — |
| Sheep | saw 175 Hz with 8 Hz square AM (depth 0.8 — bleat stutter), BP 1.1 kHz Q2, 0.7 s | — |
| Chicken | 3–4× triangle 750→520 Hz clucks 90 ms at random 120–200 ms gaps, gain 0.45 | egg laid (05 §9.4): `player.item_pickup` pop at pitch ×0.7 positional |
| Villager *(12)* | "hrmm": triangle 165 Hz through BP formant sweep 500→900→600 Hz over 0.4 s, gain 0.6 | trade-yes: recipe pitched +5 st rising; trade-no: −4 st falling with head-shake double pulse (12 owns triggers) |
| Iron golem *(12)* | slow metal clank: metal break layer ×1.4 + thud(90→40) — footfalls every step (accumulator 1.2) | attack: whoosh + clank, gain 0.9 |
| Ghast *(10)* | FM wail: carrier 700 Hz, ratio 1.5, index 2, pitch curve 700→880→460 Hz over 1.8 s, gain 0.7, maxDist 48, refDist 4 | shoot: whoosh(400→2000, 0.4 s) + crackle; all ghast voices route through the **nether delay send** (§3.5) for canyon echo |
| Blaze *(10)* | crackle(density 1.6, BP 2 kHz) 0.6 s + hiss breath with 1.2 Hz LFO, gain 0.5 | shoot ×3: whoosh(600→2400, 0.25 s) + blip |
| Magma cube *(10)* | squelch thud: thud(90→38, 0.2 s) + gulp(0.15 s, wobble [200,90,140]) — lands each hop | — |
| Wither skeleton *(10)* | skeleton rattle at pitch ×0.75, BP 1600 Hz, gain 0.6 | — |
| Shulker *(11)* | pop open: blip(triangle 300→520 Hz rise, 0.12 s) + white LP 900 pop; close: reverse (520→300 fall) | bullet: sweep sine 900→1400 Hz with 8 Hz vibrato, 0.4 s loop while flying, maxDist 24 |
| Dragon *(13)* | roar: 2 saws 55/56.5 Hz LP 900 + pink BP 250 Hz Q2 growl + 3 Hz AM, 2.5 s, gain 1.0, refDist 8, maxDist 96 | flap: whoosh(pink BP 160→60 Hz, 0.5 s) 0.6 per wing cycle; fireball: ghast-shoot ×1.2 |
| Wither *(13)* | *no idle* | spawn klaxon: 3× sweep(saw 200→800 Hz, 0.4 s) + drone swell 2 s, gain 1.0, refDist 8, maxDist 96 (13's spawn hook); skull: sweep 1200→300 + hiss 0.3 s; block-break crunch: stone break at ×1.3 per block destroyed |

All mob `hurt` events fire from 05 §14's damage pipeline (post-armor, damage > 0); `death` from 05 §15 step 1. Trigger refs for 10–13 mobs live in those files; recipes above are canonical.

### 3.5 World & system events

| Event id | Recipe | Bus / distances | Trigger |
|---|---|---|---|
| `world.explosion` | 3 layers: (a) sub sine 60→28 Hz 0.8 s gain 1.0; (b) white noise, LP sweeping 3000→300 Hz over 1.2 s, gain 0.9; (c) crackle tail (density 1.2, BP 900) 1.5 s gain 0.25. **Distance muffle rule:** per-voice extra LP with `cutoff = clamp(6000 × (12/max(d,12))^1.5, 200, 6000) Hz` — full crunch inside 12 blocks, a soft *whump* at 100+ | sfx, ref 8, max 192, cap 4 | 05 §12 (creeper), TNT (06 §5.6) |
| `world.tnt.fuse` | hiss(5 kHz, Q1, loop) + crackle(density 0.8, 3 kHz) gain 0.35, tracked to the PrimedTnt entity | sfx, max 24 | fuse ignition → detonation (06 §5.6) |
| `ambient.fire.loop` | crackle(density 1.8, BP 1.8 kHz, loop) + brown LP 350 bed 0.3 — one tracked loop voice per burning cluster, ≤ 3 voices, nearest-first | ambient, max 16 | fire blocks / burning furnace within 8 (15 owns spread; furnace per 06 §5.5) |
| `ambient.water.loop` / `ambient.lava.loop` | `loopWater` / `loopLava` buffer, looped, gain 0.4 / 0.5 | ambient, max 14 / 18 | fluid clusters, rule below |
| `weather.rain.loop` | `loopRain` looped, gain = `0.6 × rainLevel` (04 §12.1), LP 1.2 kHz when the player is under cover (`!canSeeSky`) `(approx)` | ambient, non-positional | rainLevel > 0 |
| `weather.thunder` | crack (d < 24 only): white HP 1.5 kHz burst 0.15 s gain 1.0; rumble at `t0 + d × 0.06 s`: brown noise LP sweeping 160→55 Hz, swell-decay `2 + rand()×2` s, gain `clamp(1.2 − d/200, 0.15, 1)` | ambient, non-positional | 04 §12.6 strike (amendment). `(approx — sound speed scaled ~20× slower than 343 m/s so gameplay distances give a dramatic 1–6 s flash-to-rumble gap)` |
| `ambient.wind.loop` | `loopWind` looped; gain = `0.12 × clamp((y − 88)/24, 0, 1)` when `canSeeSky` `(approx)` | ambient, non-positional | player altitude |
| `item.elytra.loop` *(11)* | whoosh loop: BP center `250 + 45×speed` Hz, gain `clamp((speed − 6)/24, 0, 1) × 0.6`, updated per frame from player speed (m/s) | sfx, non-positional (self) | gliding (11 owns state) |
| `world.portal.loop` *(10)* | drone: 3 sines 180/181.2/90 Hz, LP 1.2 kHz, LFO 0.3 Hz on gain depth 0.3 + a chime(random 900–1800 Hz, 0.8 s, gain 0.15) every 2–5 s | ambient, ref 2, max 20 | portal block cluster active |
| `world.portal.travel` *(10)* | whoosh(300→2400→200 Hz, 1.2 s, Q1.5) gain 0.8 + drone swell | sfx, non-positional | dimension transit |
| `world.beacon.loop` *(13)* | drone: sine 110 + 220.7 Hz, LP 600, gain LFO 0.25 Hz depth 0.2, gain 0.3 | ambient, ref 4, max 32 | active beacon |
| `block.brewing.loop` *(09)* | gulp(0.1 s, random wobble) every 0.5–1.5 s + blip(triangle 500 Hz, 30 ms) 0.2 | ambient, max 12 | brewing in progress |
| `block.enchant.sparkle` *(08)* | 4× chime(random from 1200/1600/2000/2700 Hz, ratio 3.53, 0.4 s) at 60 ms spacing, gain 0.4 | sfx, max 16 | enchant applied |
| `village.bell` *(12)* | chime(660 Hz, ratio 1.4, index 4, dur 2.5 s, partial2 0.4 at ×2.0) gain 0.8 | sfx, ref 4, max 64 | bell used |
| `block.note` *(07)* | instrument map below, `jitter: 0` | sfx, max 32, cap 8 | note block plays |

**Note block instrument map** (07's instrument table consumes this; defaults here if 07's table omits a row — instrument selected by the material class of the block *below*, per 07):

| Instrument | Class below | Voice |
|---|---|---|
| harp *(default)* | anything not listed | `pluckA` buffer |
| bass | wood | `pluckBass` buffer, 2 octaves down |
| snare | sand, gravel, snow | noiseBurst(white BP 1800 Hz Q1, 0.11 s) |
| hat | glass | hiss(7 kHz, Q2, 45 ms) |
| bell | metal, ore (gold_block) | chime(ratio 3.53, index 4, 0.9 s), 2 octaves up |
| basedrum | stone (per 07 §12.2) | thud(f0 120 → f1 45, 0.18 s, noiseGain 0.5) — pitched kick |
| guitar | wool (per 07 §12.2) | `pluckA` buffer through LP 1.2 kHz (muted/damped), 1 octave down |
| iron_xylophone | iron_block (per 07 §12.2) | chime(ratio 2.0, index 3, 0.6 s) — pure mallet tone |
| pling | glowstone (per 07 §12.2) | chime(ratio 1.0, index 1, 0.3 s) + square `blip` layer at gain 0.3 — electric "pling" |
| didgeridoo | pumpkin (per 07 §12.2) | saw osc → LP 500 Hz, 0.5 s, slow 40 ms attack — drone, 2 octaves down |

All 10 of 07's instruments now have a voice. Where 16's coarse material classes collide (iron_block vs gold_block both `metal`; glowstone in `glass`; pumpkin in `wood`), **07 §12.2's specific block-below table — not the material class — selects the instrument**; the "Class below" column above is only the representative block. 16 supplies exactly one voice per instrument name that 07 emits in `block.note`'s `instrument` param.

Pitch for note value `n ∈ [0, 24]`: `rate = 2^((n − 12) / 12)` applied as `playbackRate` (buffers) or frequency multiplier (osc voices) against the instrument's base tuned so `n = 12` sounds F#4 ≈ 370 Hz (bass F#2, bell F#6). No pitch/gain jitter — note blocks are a tuned instrument.

**Fluid cluster loops** — positional ambience for water/lava without scanning the world:

> Adaptation: once per second (`audio.tick`, every 20th), sample 48 random cells in a 12-block radius around the listener; collect hits where the block is a fluid **source**. Bucket hits into 4×4×4 grid cells; each non-empty bucket is a *cluster* with centroid = mean hit position. Keep the nearest ≤ 2 clusters per fluid type; each holds one pooled loop voice positioned at its centroid (re-positioned each sampling pass, faded in/out over 0.5 s on cluster appear/vanish). Cost: 48 `getBlock` calls/s — noise in the budget.

**Nether delay send** *(10)* — fake cavern reverb without a ConvolverNode (no impulse asset exists, and convolution is the wrong cost class): one shared `DelayNode(0.31 s) → Gain(0.45) → LP 2 kHz → back into delay` feedback loop, output mixed into `ambientBus` at 0.5. While the current dimension is the nether, every mob/world voice ALSO connects `envGain → delaySend` at 0.25 gain. One graph, process-lifetime, zero per-voice cost.

### 3.6 Redstone & mechanism events *(07 / 15)*

07's components and the base flint & steel now have explicit recipes (positional, bus `sfx`, defaults refDist 1 / maxDist 16 / cap 2). The note block (`block.note`) and TNT fuse (`world.tnt.fuse`, which 07/15 both emit) live in §3.5.

| Event id | Recipe | Trigger |
|---|---|---|
| `block.lever.click` | blip(square, 650 Hz on / 470 Hz off, 40 ms) gain 0.4 | lever toggled (07, param on/off) |
| `block.button.wood.on` / `.off` | `block.dig.wood` ×0.6 + blip(triangle 900 / 680 Hz, 30 ms) gain 0.4 | wooden button press / release |
| `block.button.stone.on` / `.off` | `block.dig.stone` ×0.6 + blip(square 1000 / 820 Hz, 25 ms) gain 0.4 | stone button press / release |
| `block.pressure_plate.wood.on` / `.off` | `block.button.wood.*` pitched ×0.85 | plate activate / deactivate |
| `block.pressure_plate.stone.on` / `.off` | `block.button.stone.*` pitched ×0.85 | plate activate / deactivate |
| `block.redstone_torch.burnout` | hiss(3 kHz, Q1, 0.2 s) gain 0.4 + descending blip(triangle 500 → 200 Hz) — fizzle | torch burns out (07) |
| `block.repeater.click` / `block.comparator.click` | blip(square 520 Hz, 22 ms) gain 0.3 — stone tick | delay / mode cycled |
| `block.piston.extend` / `block.piston.retract` | thud(f0 130 → f1 60, 0.12 s) + noiseBurst(white BP 700 Hz Q1, 80 ms) 0.4 — mechanical grind | piston move completes |
| `block.dispenser.fire` | blip(square 300 Hz, 40 ms) 0.4 + short noiseBurst click | dispenser fires |
| `block.dispenser.fail` | blip(square 200 Hz, 60 ms) 0.3 — dull empty click | dispenser empty-click |
| `block.dropper.drop` | `block.dispenser.fire` pitched ×0.85 | dropper ejects |
| `item.flintandsteel.use` | blip(square 1400 Hz, 18 ms) "snick" + crackle(density 1.2, 2.5 kHz, 0.12 s) ignite | flint & steel ignition / TNT prime (15, 06) |

Hoppers, lamps, and observers are silent (07). Other reconciled sibling one-shots not tabled above (`block.brewing.done`, `item.bottle.fill`, `entity.splash_potion.throw`/`.break`, `entity.lingering_potion.break`, `mob.villager.yes`/`.no`/`.trade`, `entity.zombie_villager.converting`/`.cure`, `block.composter.*`, `block.barrel.*`) resolve through the §3-default derivation rule (§3 intro + §5.2): each maps to its namespace's nearest generated family (`block.*` → the block-class verb, `mob.*` → the mob's idle-derived hurt/idle voices).

---

## 4. Generative music system

`audio/music.js`. All-original, generated at runtime, scarce like MC's: long silences, then a piece surfaces.

**ORIGINALITY GUARD:** the composer never contains, references, or reproduces existing melodies. Every pitch sequence is produced by the seeded random walks below over abstract scale tables; every chord comes from the progression matrix; no lookup table of hand-authored note sequences is permitted anywhere in `music.js` (hand-authored *rules*, yes; hand-authored *tunes*, no). It is impossible for this system to play a C418 piece, a Lena Raine piece, or any transcription — and it must stay that way. Do not "tune" the generator by ear toward any existing soundtrack.

### 4.1 Composer architecture

- **Seeding:** `musicRng = mulberry32(xmur3(worldSeed + ':music:' + pieceIndex)())` — piece N of a given world is always the same piece (deterministic, shareable), different across worlds. `pieceIndex` increments per piece and persists in the save meta `(approx — if omitted from the save, resuming a world restarts at piece 0; acceptable)`.
- **Root note:** chosen per piece: MIDI `48 + musicRng()×12` floored (C3–B3); all scale degrees are semitone offsets from it. `freq = 440 × 2^((midi − 69)/12)`.
- **Scale pools (semitone sets):**

| Scale | Degrees | Used by moods |
|---|---|---|
| major pentatonic | 0 2 4 7 9 | overworld-day |
| minor pentatonic | 0 3 5 7 10 | overworld-night |
| dorian | 0 2 3 5 7 9 10 | underground |
| lydian | 0 2 4 6 7 9 11 | end |
| phrygian-fragment | 0 1 5 7 8 | nether accents, boss |

- **Mood selector** (evaluated when a new piece is due, and re-evaluated only at piece boundaries except boss):

| Mood | Condition (priority top-down) | Palette | BPM |
|---|---|---|---|
| boss *(13)* | boss fight active | pulsing low drone (root −24), noiseBurst hits on beats 1/3, phrygian; ducks `ambientBus` −12 dB | 84 |
| nether *(10)* | player in nether | low drones only, **no melody line**; metallic accents: metal-clank chime pitched to scale root/5th every 4–9 s | 40 |
| end *(11)* | player in end | sparse bell dyads: chime pairs (root + tritone or maj7) every 3–8 s over a near-silent drone, lydian | 50 |
| underground | feet `y < 52` AND skyLight at eye = 0 (04 predicate) | drones + distant chimes on dorian, melody rest prob 0.8, LP 1.5 kHz on the whole music bus | 56 |
| overworld-night | `skyDarken ≥ 4` (04 §4) | minor pentatonic, slower, darker pad LP 900 Hz | 56 |
| overworld-day | default | warm pads + sparse plucks, major pentatonic | 72 |

- **Progression matrix** — chords are triads on scale degrees; a seeded random walk over this transition table (rows = current, weights normalized over the scale's available degrees):

| From \ To | I | IV | V | vi | III |
|---|---|---|---|---|---|
| I | .20 | .35 | .20 | .25 | — |
| IV | .40 | — | .30 | .30 | — |
| V | .40 | .20 | — | .40 | — |
| vi | .30 | .40 | — | — | .30 |
| III | — | .50 | — | .50 | — |

Chord duration: 2 bars, or 1 bar with probability 0.25. Pentatonic scales approximate triads with degree stacks (1-2-5 / 1-4-5 within the pool) `(approx)`.

### 4.2 Piece structure & voices

- **Form:** intro (8 bars, pad only) → A (16 bars, pad + melody) → B (16 bars, melody rests, chime accents) → A′ (16 bars, melody register +12) → outro (8 bars, pad fading). 4/4 bars; at the mood BPMs this yields **≈ 90–180 s** per piece.
- **Pad voice** = `drone` primitive on the music bus: 3 oscs on chord tones (root at octave 2–3, fifth and third at octave 3–4), LP 1200 Hz, LFO 0.15 Hz on the filter, gain 0.25; chord changes crossfade over 0.8 s (two overlapping drones).
- **Melody voice** = `pluckA` (day/underground) or `chime` (night/end) on a 1/8-note grid: at each grid slot, **rest probability 0.6**; else pitch = random walk over the scale, step ∈ {0, ±1, ±2} degrees weighted {.3, .25/.25, .1/.1}, register clamped to octaves 4–6, snapped to the current chord's tones on beat 1 of each bar. Phrase rule: after 4 bars of activity, force a 2-bar rest. Velocity: gain 0.18 ± 0.05 seeded.
- **Rhythm (boss only):** noiseBurst(white BP 300 Hz Q1, 90 ms, gain 0.4) on beats 1 and 3; drone gain LFO at 2× beat rate, depth 0.5 — a pulse, not a drum kit.
- Scheduling via §1.5's lookahead loop; music sources are fire-and-forget onto the music bus and do **not** consume the SFX voice pool (self-budget: ≤ 8 concurrent music sources).

### 4.3 Playback rules

- **Scarcity:** after a piece ends, the next begins after `180 + musicRng()×240` s of silence (3–7 min). The first piece of a session starts 45–90 s after entering PLAYING.
- **Music is never positional** — voices connect straight to `musicBus`.
- **Interrupt:** only the boss mood interrupts a playing piece: current piece fades over 2 s, boss loop starts; on boss end, 2 s fade out, then a fresh scarcity timer. All other mood changes wait for the natural piece boundary.
- **Damage ducking:** any player damage sets `musicBus` −6 dB via `setTargetAtTime(busGain×0.5, now, 0.15)` for 3 s, then recovers (τ 0.5 s) — music steps aside while you panic.
- Pause/menu: music suspends with the context (§1.1); it resumes mid-piece.

---

## 4A. Theme / background music (file-based, optional)

`audio/themeMusic.js`. A file-based music layer that plays a playlist of **original or cleared/licensed** tracks — on the title screen (per 19-MAIN-MENU) and, softly, as in-game background music. It is the single §5 scoped exception to the synth-only rule; the generative composer (§4) stays the synth-only default and fallback. The title screen and the in-game background share this **one** module: 19-MAIN-MENU specifies the title-screen behavior, this section the in-game behavior and the shared engine.

**Copyright ship-gate (absolute).** No copyrighted / C418 / Minecraft-soundtrack audio may be bundled or served in any public build. The tracks in `CC-assets/CC-sounds/` are the C418 OST — **local dev placeholders only**, gitignored and excluded from `dist/`. Before ship, the manifest must point exclusively at original or properly-licensed tracks (or original tracks rendered offline from this engine's primitives). 17-SHIP §3 enforces the gate.

**musicMode** (option, persisted per §Amendments 01 §15.3): `off` | `menu` (default — theme on the title screen only, generative composer in-game) | `full` (theme layer on the title screen **and** in-game, replacing the generative composer). The generative composer (§4) and the theme layer never play at once on `musicBus`; when `musicMode = full`, §4 is suspended in-game.

### 4A.1 Manifest & loading ("in RAM")
- `audio/themeManifest.js` — ordered list of served URLs built from the theme-music folder (`public/theme-music/`, dev placeholders symlinked/copied from `CC-assets/CC-sounds/`). No hardcoded count; the player adapts to however many tracks are present.
- Load: `fetch` → `decodeAudioData` → hold the `AudioBuffer`s **in memory** for gapless playback. Memory guard: decode up to `N` short tracks (default 6); stream anything larger/longer via a pooled `HTMLAudioElement` instead of full decode. Preload the first track eagerly, the rest lazily so the menu is audible fast. (The 14 placeholder mp3s total ~120 MB — a reason the shipped set should be a small curated group of short original loops.)

### 4A.2 Routing, levels & playback
- Chain: `themeSource → themeGain → musicBus → masterGain` — the Options **Music** slider governs it; **never positional**; obeys §4.3's damage-duck and boss-interrupt; suspends/resumes with the context (§1.1).
- Order: **shuffle** (Fisher–Yates), never the same track twice in a row across reshuffles.
- Fades: **in 1.5 s / out 0.8 s** (equal-power on `themeGain`) — soft entries/exits, never a hard cut.
- **Inter-track pause** (silence gap) and **level**, by context:
  - **Title screen** (19-MAIN-MENU): gap **10–20 s** random `(approx)`; `themeGain` ≈ **0.45** — soft, but a touch louder than in-game.
  - **In-game background**: scarcer per §4.3 — gap `180 + rng()×240` s (3–7 min); `themeGain` ≈ **0.28–0.32** `(approx)` — softer than the menu, sits under SFX; first in-game track 45–90 s after entering PLAYING.
- Never consumes the SFX voice pool (self-budget ≤ 2 concurrent theme sources during a crossfade).

### 4A.3 Lifecycle
- Starts on the first user gesture (autoplay rule, §1.1).
- Menu → world load: fade the menu track out ~1 s, then hand off — to the in-game theme layer if `musicMode = full`, else to the generative composer (§4).
- World → title: restart the menu theme layer.
- Tab hidden (`visibilitychange`) → fade to 0 + `context.suspend()`; visible → `resume()` + fade back. No state loss; one-shot `AudioBufferSourceNode`s are recreated per play (never reused).

---

## 5. Event wiring & API

### 5.1 `emitSound`

```js
// the ONLY audio entry point for gameplay code (exported from audio/engine.js)
emitSound(eventId, pos = null, pitchMult = 1, gainMult = 1)
//  pos: {x,y,z} world coords → positional voice; null → flat pool (self/UI)
//  returns a handle { stop(fadeSec) } ONLY for loop events; one-shots return null
startLoop(eventId, target)   // target: {x,y,z} | entity (tracked) | null; returns handle
```

Rules: `emitSound` is callable from tick code only (render code never emits — 01 §3's mutation rule extends to audio). Unknown event id → console.warn once per id, no throw. Calls before the context unlocks are silently dropped (nothing meaningful fires pre-gesture). Distance cull, caps, priority, jitter all resolve inside the call.

### 5.2 Hook-point table into base systems

Every integration is one `emitSound` line at an existing base-spec site — no base logic changes:

| Base site | Event(s) | Condition |
|---|---|---|
| 03 §5.4 land move | `block.step.<class>` | step accumulator rule (§3.2) |
| 03 §8 sneak state | step gain −6 dB | while sneaking |
| 03 §10/§11 water/lava | `player.splash`, swim-step | entry velocity / distance rule |
| 03 §12.1 landing | `player.fall.small/.big` | fallDistance thresholds |
| 03 §15.3 mining loop | `block.dig.<class>` every 6 ticks; `block.break.<class>` in `breakBlock()` | not on instant break / always |
| 03 §16.2 placement | `block.place.<class>` | success path |
| 03 §20.2 / §20.5 | `player.hurt[.*]`, `player.death` | damage lands / death |
| 04 §12.1 weather tick | `weather.rain.loop` gain ← rainLevel | per tick |
| 04 §12.6 lightning | `weather.thunder` | amendment above |
| 05 §8.3 creeper swell | `mob.creeper.fuse` start/release | swell leaves 0 / swellDir flips |
| 05 §8.5 enderman | `mob.enderman.scream`, `.teleport` | provocation / both teleport endpoints |
| 05 §11 arrow | `item.bow.shoot`, `entity.arrow.hit_*` | spawn / impacts |
| 05 §12 explosion | `world.explosion` | blast center |
| 05 §14 damage pipeline | `mob.<type>.hurt` | post-armor damage > 0 |
| 05 §15 death / XP orbs | `mob.<type>.death`, `player.xp_pickup` | death step 1 / orb collect |
| 05 §2/§6 mob AI idle | `mob.<type>.idle` | cadence rule §3.4 |
| 06 §5.3 / §5.13 / §5.6 | chest open/close, door, TNT fuse | interactions |
| 06 §12.4 eating | chew/swallow/burp | amendment ticks |
| 06 §13 XP levels | `player.levelup` | level integer up |
| 06 §14.2 / §14.3 UI | `ui.click`, `ui.hotbar` | every click / selection |
| 06 §16 item pickup | `player.item_pickup` | absorbed into inventory |
| 06 §7.1 durability | `player.item_break` | tool reaches 0 |
| 01 §6.3 fluid mix | `block.extinguish` + stone place | obsidian/cobble forms |
| 07–15 sibling tables | their listed event ids | siblings own conditions; this registry owns recipes; missing events → §3 defaults |

### 5.3 Multiplayer relay *(14)*

Sound follows 14's authority model: events fire **only in the authoritative simulation**; clients render, never decide. The host serializes every emit whose registry entry has `replicate: true` (default for positional events; flat/ui/music events never replicate) as `{eventId, x, y, z, pitchMult, gainMult}` piggybacked on the state stream; remote clients call `emitSound` with it verbatim. Echo suppression: the host does not relay an event back to the client whose predicted action already played it locally (own steps, digs, places, UI) — 14's input-ownership table defines "own". Music and ambience are always computed locally per client (each player hears their own mood/weather mix).

### 5.4 Explicitly out of scope

Subtitle/caption system ("♪ creeper hisses ♪") — OUT. The visual channel already carries the critical cues (creeper swell animation, damage flash); a caption feed is UI surface with no spec backing in 06 §15. Also out: HRTF toggle, per-ear occlusion/obstruction raycasts, ConvolverNode reverb, Doppler (removed from the Web Audio spec), and audio worklets (§1.6).

---

## 6. Performance budget

| Metric | Budget | Notes |
|---|---|---|
| `audio.updateFrame()` | ≤ 0.5 ms typical, 1.5 ms worst | listener writes + tracked voices + music lookahead |
| `audio.tick()` | ≤ 0.3 ms | ambience sampling amortized (48 getBlock/s), timers |
| Voice starts | ≤ 16 per tick | §1.4 throttle |
| Concurrent voices | 32 SFX + 8 music + ≤ 6 ambience loops | pool-enforced hard caps |
| Baked buffer memory | ≤ 4 MB | §2.1 list |
| Allocations in emit path | source nodes only | §1.6 policy; heap growth from audio ≈ 0 between GCs |
| Audio-thread load | untracked but bounded | ≤ ~46 simultaneous nodes×3 avg — trivial for native nodes |

Debug overlay (01 §15.3 F3) gains one line: active voices / pool size, drops this second, ctx state, ctx.currentTime drift vs worldTime `(approx)`.

---

## Acceptance checklist

- [ ] **Zero downloaded assets (SFX + generative music):** production build's network tab shows no audio requests from the engine, primitives, events, music, or ambience modules; the bundle contains no base64 audio blobs; grep for `fetch`/`decodeAudioData` outside `src/audio/themeMusic.js` returns nothing. (The §4A theme layer is the sole exception and only when enabled.)
- [ ] **Theme-music layer (§4A):** with a manifest present, tracks play shuffled with no immediate repeat, preloaded so the next starts gaplessly after a soft pause, each fading in/out; the title screen plays at a soft level slightly above in-game; in-game background is scarcer and softer, sits under SFX, and ducks on damage; the Music slider and the Theme-music selector (Off/Menu/Menu+gameplay) change it live and persist; `off` falls back to the synth composer with zero audio requests.
- [ ] **Copyright ship-gate:** `public/theme-music/` is gitignored and excluded from `dist/`; a production build bundles/serves **no** copyrighted or C418 track; every shipped theme track is original or cleared (verified before deploy per 17-SHIP §3).
- [ ] First click on the title screen (or first canvas click) unlocks audio — no console autoplay warnings; before any gesture the game runs silently without errors.
- [ ] Mining stone audibly differs from digging sand (band-passed knock vs soft shuffle); dig ticks repeat every 0.3 s in sync with the swing; the break pop is distinct from the dig ticks; placing plays a lower-pitched dig.
- [ ] Walking on wool vs stone is obviously different (muffled thump vs sharp tap); step cadence audibly rises walk → sprint; sneaking steps are −6 dB; two successive steps on the same block never sound identical (jitter).
- [ ] A creeper behind you gives a full 1.5 s hiss ramp before the explosion — enough to sprint clear; breaking LOS mid-fuse audibly winds the hiss down.
- [ ] Explosions at 5, 40, and 120 blocks are respectively a crunching blast, a boom, and a muffled distant whump (LP-by-distance rule audible); the compressor prevents clipping when 4 TNT detonate together.
- [ ] Positional truth: a mob to your left is left-weighted; turning 180° flips it; sounds beyond their maxDistance never play (verify via voice counter with a far-away zombie farm).
- [ ] Standing near a river then a lava pool produces distinct localized loops that follow the nearest fluid cluster and fade when you leave.
- [ ] Rain fades in with rainLevel; thunder cracks immediately when close and rumbles seconds after the flash when far (delay ≈ 0.06 s/block); undercover rain sounds duller.
- [ ] Idle at night: within 7 minutes a music piece begins, plays 1.5–3 min, and ends back into silence; night music is audibly darker/slower than day; two different world seeds produce different pieces; the same world replays the same piece 0. No piece resembles any existing composition (originality guard holds by construction).
- [ ] Nether (with 10 installed) sounds unmistakably different from the overworld: no melody, low drones, echoing mob cries (delay send), different block-class voices.
- [ ] Eating plays 3 chews + swallow + burp on the 06 §12.4 ticks; collecting a spray of XP orbs plays a rising pitch run; leveling up chimes; every UI click ticks.
- [ ] Note block (with 07 installed): 5 instruments map per the class-below table; pitch steps 0–24 are exact semitones (`2^((n−12)/12)`), jitter-free.
- [ ] Options sliders (Master/Music/Ambient/SFX/UI) each affect only their bus, persist across reloads via localStorage, and survive world deletion.
- [ ] Pause/Esc and tab-hide fade audio out within ~0.2 s and suspend the context (CPU meter for the tab drops); resume restores mid-sound without pops.
- [ ] Perf: with 20+ mobs active in a thunderstorm with music playing, `audio.updateFrame + emit` cost stays ≤ 1.5 ms/frame (Performance panel), frame rate holds 60, and JS heap shows no audio-driven growth over 10 min.
- [ ] Voice pool honesty: spawning 100 simultaneous sounds (debug console) never exceeds 32 SFX voices, drops far sounds first, and never drops UI clicks.
