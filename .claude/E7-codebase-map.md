

<!-- ===== a9693dd8cb3cb872c ===== -->
I have the full picture.

# Audio subsystem integration map — `src/audio/*`

## 0. Module graph / boot order

| Step | Call site | Effect |
|---|---|---|
| 1 | `src/main.js:34` `audio.boot()` | after `buildAtlas()`, before `new Game(...)` |
| 2 | `src/main.js:35` `audio.setOptions(options)` | `options = loadOptions()` (`src/main.js:33`) |
| 3 | `src/main.js:40` `audio.game = game` | back-ref used by `Music.selectMood`, `Ambience.game`, `engine.updateFrame` |
| 4 | `src/main.js:95` `createThemeMusic({ context: audio.ctx, musicBus: audio.buses.music })` | E1 owns the ctx/bus → `externalBus=true`, `ownsContext=false` |
| 5 | `src/main.js:96-97` `audio.themeMusic = themeMusic; menus.attachMusic(themeMusic)` | |

`engine.boot()` (`src/audio/engine.js:83-107`) does: `new (window.AudioContext||window.webkitAudioContext)({latencyHint:'interactive'})` → `bakeBuffers(this.ctx)` → `buildGraph()` → registers its **own** `visibilitychange` listener (`engine.js:98-101`) → `this.music = new Music(this)`, `this.ambience = new Ambience(this)` → `this.ready = true`. If no `AudioContext` ctor: `console.warn('[audio] Web Audio unavailable — running silent')` and **returns with `ready=false`** (`engine.js:85`) — every entry point is null-guarded on `ready`.

Graph (`buildGraph`, `engine.js:109-139`): `voice.tail → buses[name] → masterGain → compressor → ctx.destination`. Buses: `BUS_NAMES = ['sfx','ambient','music','ui']` (`engine.js:16`). Compressor `{threshold:-18, knee:24, ratio:6, attack:0.003, release:0.25}` (`engine.js:15`). Pool: `POSITIONAL_VOICES = 24`, `FLAT_VOICES = 8` (`engine.js:12-13`).

## 1. The public surface (what integrators call)

`src/audio/engine.js:473-481`:
```js
export const audio = new AudioEngine();
export const emitSound = (id, pos, pitch, gain) => audio.emitSound(id, pos, pitch, gain);
export const startLoop = (id, target) => audio.startLoop(id, target);
export function at(x, y, z) { _pos.x = x; _pos.y = y; _pos.z = z; return _pos; }
```

**`emitSound(eventId, pos = null, pitchMult = 1, gainMult = 1)`** (`engine.js:272`) → returns a **loop handle** if `def.loop`, else `null` (`engine.js:359`). There is **no param channel** — this is why `block.door` is split into `.open`/`.close` (`events.js:272-287`), `block.note` into one id per instrument (`events.js:786-815`), and why `entity.arrow.hit_block` only emits the thud layer and the caller separately emits `block.step.<class>` at gain 0.5 (`events.js:259-266`, done at `src/entities/Arrow.js:90-92`).

`at(x,y,z)` returns a **shared module-scope object** `_pos` (`engine.js:480`) — safe only because `emitSound` reads `pos` synchronously and never retains it (`engine.js:477-479`). Never hold the return value.

**`startLoop(eventId, target = null)`** (`engine.js:363-369`):
```js
startLoop(eventId, target = null) {
  const pos = !target ? null : (typeof target.x === 'number' ? target : (target.pos ?? null));
  const h = this.emitSound(eventId, pos, 1, 1);
  if (h && target && target.pos) h.voice.tracked = target;
  return h;
}
```
`target` is `{x,y,z}` | entity (has `.pos`) | `null`. Entity targets get per-frame re-panning in `updateFrame` (`engine.js:436-441`).

**Engine methods other modules call:** `boot()` `unlock()` `onPause()` `onResume()` `setOptions(opts)` `duck()` `tick()` `updateFrame(camera)` `poolSize()` `musicBusTarget()`. Fields read externally: `audio.ctx`, `audio.buses.music`, `audio.game`, `audio.themeMusic`, `audio.music`, `audio.ambience`, `audio.debug` (`{voices, drops, state, budgetMs, bakedMB}`, `engine.js:79`, `106`).

**Loop handle** (`handleFor`, `engine.js:371-399`) — the only object a loop owner holds:
- `voice` (raw Voice)
- `get alive()` → `v.busy && v.gen === gen` (generation guard, `engine.js:52-53`, `373-374`)
- `setParam(name, value, tau = 0.05)` → `v.mod[name].setTargetAtTime(...)`
- `setPosition(x, y, z)` (no-op if not positional)
- `stop(fadeSec = 0.4)` → fades, stops nodes at `now+fadeSec`, sets `releaseAt = now+fadeSec+0.05`, sets `v.loop = false`

Every method silently no-ops if `!mine()`, so a stale handle is harmless. `v.gen++` on every `release()` (`engine.js:267`).

**`v.mod` names exposed by primitives** (what `setParam` can target): `burstGain` (`primitives.js:260`), `crackleRate` / `crackleFreq` (`primitives.js:390-391`), `droneGain` / `droneLp` (`primitives.js:431-432`), `hissFreq` / `hissGain` (`primitives.js:496-497`), `whooshFreq` / `whooshGain` (`primitives.js:547-548`), and from `events.js`'s local `loopBuffer`: `loopGain` (`events.js:841`), `coverLp` (`events.js:834`, only when `opts.lp` is passed).

## 2. Event-id namespace conventions

Generated families (`events.js:87-115`), one per class in `MAT_CLASSES = Object.keys(STEP_DUR)` = `['stone','ore','metal','wood','gravel','sand','grass','glass','wool','snow','nether','end']` (`events.js:79-84`):
- `block.step.<cls>` · `mob.step.<cls>` · `block.dig.<cls>` · `block.break.<cls>` · `block.place.<cls>`

Hand-written namespaces: `player.*` (`events.js:122-224`), `item.*` (`events.js:225-258`), `entity.arrow.*` (`events.js:263-270`), `block.*` (door/chest/extinguish + all §3.6 redstone via `mech()`, `events.js:736-783`), `ui.*` (`events.js:309-316`), `mob.<type>.{idle,hurt,death}` (`events.js:590-608`), mob specials (`events.js:611-638`), `world.*` (`events.js:642-671`), `ambient.*.loop` (`events.js:672-686`), `weather.*` (`events.js:687-732`), `block.note.<instrument>` (`events.js:809-814`).

`MOB_IDLE` types (`events.js:322-579`): `zombie, skeleton, spider, enderman, cow, pig, sheep, chicken, creeper, villager, iron_golem, ghast, blaze, magma_cube, wither_skeleton, shulker, dragon, wither`. `NO_IDLE = new Set(['creeper','wither'])` (`events.js:582`) — those two get `.hurt`/`.death` but **no `.idle` id**. `MOB_DIST` overrides (`events.js:584-588`): `ghast {maxDist:48, refDist:4}`, `dragon` and `wither` `{maxDist:96, refDist:8}`.

`NOTE` instruments (`events.js:791-808`): `harp, bass, snare, hat, bell, basedrum, guitar, iron_xylophone, pling, didgeridoo`. `EVENTS['block.note'] = EVENTS['block.note.harp']` (`events.js:815`). Note pitch convention: `rate = 2^((n-12)/12)` passed as `pitchMult`; `n=12` → F#4, `FSHARP4 = 369.994` (`events.js:788-790`).

**Fallback resolution** — `resolveEvent(id)` (`events.js:848-862`, exported), memoized in `_resolved` (a `Map`, `events.js:847`):
```js
if (EVENTS[id]) return EVENTS[id];
// 'mob.<type>.<verb>' → EVENTS[`mob.${type}.${verb}`] || `mob.${type}.idle` || `mob.${type}.hurt` || null
// id.startsWith('block.') → EVENTS['block.break.stone']
// anything else → null  → console.warn('[audio] unknown event', id) ONCE (engine.js:276-280, this.unknown Set)
```
Note the `mob.` branch's first term is dead: `EVENTS[\`mob.${type}.${verb}\`]` reconstructs exactly `id`, which already missed at the top of the function. Only the `.idle`/`.hurt` fallbacks can hit.

## 3. Registering a new sound event

Add to `src/audio/events.js` via the module-local `function def(id, o) { EVENTS[id] = o; return o; }` (`events.js:15`). Not exported — new events must live in this file (or be assigned onto the exported `EVENTS` object, `events.js:13`, which is `Object.create(null)`).

**Entry schema** (`events.js:5-6`, enforced by reads in `emitSound`):

| Field | Read at | Default |
|---|---|---|
| `recipe(v, t0, pitch, gain) -> stopTime` | `engine.js:351` | required; throws → `console.warn('[audio] recipe failed', ...)` + `release(v)` + return null (`engine.js:352-356`) |
| `bus` | `engine.js:346-347` | `'sfx'` |
| `refDist` | `engine.js:340` | `1` |
| `maxDist` | `engine.js:292`, `341` | `16` |
| `cap` | `engine.js:300` | `2` |
| `capKey` | `engine.js:300`, `314` | `null` (no cap enforcement) |
| `priority` | `engine.js:296` | `panned ? (dist<16 ? P.NEAR : P.FAR) : P.PLAYER` |
| `jitter` | `engine.js:305` | on — **only `jitter: 0` disables**; any other value (incl. `1`) enables |
| `loop` | `engine.js:317`, `359` | `false` |
| `muffle` | `engine.js:329` | `false` (adds per-voice LP, `engine.js:329-337`) |
| `distanceOnly` | `engine.js:286` | `false` (measure dist, render flat/unculled — only `weather.thunder`, `events.js:705`) |
| `replicate` | **never read by engine.js** — declarative only, for a future net layer | |

`P = { FAR: 0, NEAR: 1, PLAYER: 2, UI: 3 }` (`events.js:11`, exported).

Shared spreads: `const SELF = { bus:'sfx', priority:P.PLAYER, replicate:false }` and `const UI = { bus:'ui', priority:P.UI, jitter:0, cap:4, capKey:'ui', replicate:false }` (`events.js:119-120`); `mech(id, recipe, extra = {})` for redstone (`events.js:736-737`, `capKey: id` = each mech gets its own cap-2 family).

A recipe returns the **stop time**; `Infinity` for loops (`engine.js:357` → `v.releaseAt`). Returning a finite time from a looping recipe leaks an unstoppable source (`primitives.js:266-268`).

**Recipes must apply gain exactly once**, in their own gain node — `v.envGain` sits at 1.0 and is the engine's fade handle, not a volume stage (`engine.js:318-324`, `primitives.js:8-11`). The `g` arg already includes jitter × caller's `gainMult`.

## 4. Emit path, in order (`engine.js:272-360`)

1. `!this.ready || this.ctx.state !== 'running'` → **return null** (pre-gesture sounds are dropped, not queued).
2. `resolveEvent(eventId)`; miss → warn-once, null.
3. `this.starts >= VOICE_STARTS_PER_TICK` (**16**, `engine.js:14`) → drop.
4. `panned = !!pos && !def.distanceOnly`; `dist = Math.hypot(...)` vs `this.listenerPos`.
5. Cull **before allocation**: `if (panned && dist > (def.maxDist ?? 16)) return null`.
6. Priority resolution (`engine.js:296-298`): flat non-UI is floored to `P.PLAYER`; `bus==='ui'` forces `P.UI`.
7. `acquire(panned, priority, def.capKey, def.cap ?? 2)` (`engine.js:208-239`): cap-family steal counts across **both** sub-pools but only returns a voice from the requested pool; then first free; then steal oldest **strictly lower** priority non-loop; else `drops++`, null.
8. Jitter (`engine.js:305-308`): `pm *= 2^(rand*0.3-0.15)` (±15% pitch), `gm *= 0.85 + rand*0.15` — note gain jitter is `[0.85, 1.0)`, an attenuation-only band despite the ±comment framing.
9. `t0 = ctx.currentTime + 0.005` (5 ms guard); `envGain` writes are **at t0, never now** (`engine.js:325-326`).
10. muffle LP → panner params → `tail.connect(buses[def.bus||'sfx'])` → `def.recipe(v,t0,pm,gm)`.

`this.starts` is reset in `tick()` (`engine.js:452`) and defensively zeroed in `updateFrame` when `!this.game?.world` (`engine.js:413`) — because `Game.tick()` early-returns with no world, which would otherwise permanently silence the title menu.

**Frame/tick hooks** (owned by Game): `Game.js:210` `this.audio?.tick()`, `Game.js:262` `this.audio?.updateFrame(this.camera)`, `Game.js:255` `this.audio?.updateFrame(null)`. `updateFrame` syncs listener pos/orientation from the **interpolated** camera (`engine.js:415-430`, handles both `positionX` AudioParam and legacy `setPosition`/`setOrientation`), releases finished voices (`releaseAt <= now`), re-pans tracked loops, and calls `music.updateFrame(now)`. `tick()` resets `starts`, updates `debug.voices`, rolls the drop window every 20 ticks, then `ambience.tick(this._tickCount)` and `music.tick(this._tickCount)` (`Music.tick()` takes no args, `music.js:354`).

## 5. Unlock path

`unlock()` (`engine.js:143-147`) — idempotent and cheap; docs say call from **every** gesture handler:
```js
unlock() { if (!this.ctx) return; if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); }
```
Call sites: `src/ui/menus.js:156` (options interactions), `src/ui/menus.js:246` (`pressStart()` — covers button + keyboard), `src/main.js:79` (`onResume`, "must land inside the gesture, before the await"), `src/main.js:175` (unconditional, above the guard).

`ThemeMusic.unlock()` (`themeMusic.js:108-120`) is separate: lazily creates ctx (only if none injected), builds the fallback graph (only if no `musicBus`), creates `themeGain` at `0.0001` → `musicBus`, resumes if `'suspended'`.

Pause/resume: `onPause()` (`engine.js:149-157`) ramps `masterGain` to 0 with `setTargetAtTime(0, now, 0.02)` then `ctx.suspend()` after a **150 ms** `setTimeout`. `onResume()` (`engine.js:159-170`) resumes then ramps back to `busGain(this.opts.master)` over 0.15 s. Two independent drivers: the engine's own `visibilitychange` listener (`engine.js:98-101`, which also forwards to `themeMusic?.onPause?.()/onResume?.()` and refuses to un-mute when `game.state === STATE.PAUSED`), and `main.js:117-118` on state transitions into/out of `STATE.PAUSED`.

`duck()` (`engine.js:191-204`): music bus → `musicBusTarget() * 0.5` (tau 0.15), `duckUntil = now + 3`, a 3000 ms `setTimeout` recovers with tau 0.5. `setOptions` skips the music bus while `now < this.duckUntil` (`engine.js:182`). Sole caller: `src/entities/Player.js:636`.

## 6. Options coupling

`loadOptions()` / `busGain` from `src/ui/options.js`. `busGain = slider => (clamp(slider,0,100)/100) ** 2` (`options.js:44`). `DEFAULTS` (`options.js:11-13`): `master:100, music:70, ambient:100, sfx:100, ui:100, musicMode:'menu'` (`'off'|'menu'|'full'`). `SLIDER_OF = { sfx:'sfx', ambient:'ambient', music:'music', ui:'ui' }` (`engine.js:19`) — identity map; `master` is handled separately.

`setOptions(opts)` (`engine.js:174-186`) ramps master + each bus with tau 0.03, then `this.music?.onOptions(opts)`. It does **not** forward to `themeMusic` — `Menus.attachMusic` (`menus.js:237-241`) and `menus.js:223` drive `themeMusic.setOptions` independently.

## 7. Primitives (`src/audio/primitives.js`)

Contract: `prim(voice, t0, p) -> stopTime`; builds its own graph into `voice.envGain`; owns its own gain node; applies `p.pitch` (default 1) to **every** frequency-ish param it owns (`primitives.js:1-15`).

Exports: `BUFFERS`, `bakePluck(freq, blend, dur, sr, rng)`, `bakeBuffers(ctx)`, `bakedBytes()`, `expOut(param, t, gain, dur)`, `noiseBurst`, `thud`, `pluck`, `blip`, `sweep`, `crackle`, `drone`, `chime`, `hiss`, `gulp`, `whoosh`, and `PRIMS = { noiseBurst, thud, pluck, blip, sweep, crackle, drone, chime, hiss, gulp, whoosh }` (`primitives.js:552-554`).

`BUFFERS` keys after `bakeBuffers` (`primitives.js:148-210`): `white`, `pink`, `brown`, `impulses`, `pluckA` (220 Hz, blend 0.996, 1.2 s), `pluckBass` (55 Hz, 0.998, 2.0 s), `loopRain`, `loopWater`, `loopLava`, `loopWind`. All noise beds are `sr * 2` samples. Deterministic per-buffer streams: `streamFor(name) = mulberry32(xmur3('audio:' + name)())` (`primitives.js:22`). `BUFFERS` is filled **in place** — reads must be deferred to recipe-call time, never hoisted (`events.js:819-820`).

`drone` is exported and fully implemented (`primitives.js:396-437`) but **no event in `events.js` uses it** — `events.js:7-9` imports only `BUFFERS, noiseBurst, thud, pluck, blip, sweep, crackle, chime, hiss, gulp, whoosh`. It is a live extension point for pads/portals/beacons/boss beds. `PRIMS` likewise has no importer.

Loop-aware primitives (`p.loop` → return `Infinity`, no `src.stop()`, no decay): `noiseBurst`, `sweep`, `crackle`, `hiss`, `whoosh`, `drone`. `thud`, `pluck`, `blip`, `chime`, `gulp` are one-shot only. `expOut` exists because `exponentialRampToValueAtTime` can never target 0 (`primitives.js:220-224`). `WOBBLE` in `gulp` is a module-scope `Float32Array(3)` reused per call (`primitives.js:502`) — `setValueCurveAtTime` copies synchronously, but the array is shared.

## 8. `Music` (composer, `src/audio/music.js`)

Constructed by the engine (`engine.js:102`). Class `Music`, exported. Methods: `onOptions(opts)`, `arm(worldSeed)`, `disarm()`, `stop(fadeSec = 2)`, `scarcityGap()`, `selectMood()`, `startPiece(mood)`, `updateFrame(now)`, `scheduleBar(t)`, `schedulePad`, `scheduleMelodyBar`, `scheduleAccents`, `scheduleRhythm`, `playNote`, `playChime`, `tempVoice(pc, endsAt)`, `endPiece()`, `tick()`.

**Originality guard** (`music.js:3-9`): no hand-authored note sequences may be added to this file. Hand-authored *rules* only.

`MOODS` keys (`music.js:23-30`): `boss, nether, end, underground, 'overworld-night', 'overworld-day'`. `SCALES`: `majorPentatonic [0,2,4,7,9]`, `minorPentatonic [0,3,5,7,10]`, `dorian [0,2,3,5,7,9,10]`, `lydian [0,2,4,6,7,9,11]`, `phrygianFragment [0,1,5,7,8]`. `PROGRESSION` rows `I, IV, V, vi, III`; `DEGREE_INDEX = { I:0, IV:3, V:4, vi:5, III:2 }`. `FORM`: intro 8 → A 16 → B 16 → A2 16 (+12) → outro 8 (`music.js:43-49`).

`selectMood()` reads `game.bossActive`, `game.world.dimension`, `game.player.pos/eyeHeight`, `game.world.getSkyLight(...)`, `game.world.skyDarken >= 4` (`music.js:129-139`) — these are the game-side contract fields.

Music voices **do not touch the SFX pool**: `tempVoice` (`music.js:335-344`) is a shim `{ ctx, envGain, nodes: [], mod: null, dist: 0 }` on a throwaway gain into `piece.out`, self-budgeted at `this.voices >= 8` (`music.js:315`, checked in `playNote` only — `playChime` and `scheduleRhythm` bypass the check). Seeding: `mulberry32(xmur3(this.worldSeed + ':music:' + this.pieceIndex)())` (`music.js:145`). `arm()` rewinds `pieceIndex` to 0 on a different `worldSeed` (`music.js:100`). Scarcity: first piece 45–90 s after PLAYING (`music.js:102`); `scarcityGap() = 180 + Math.random()*240` (`music.js:122`). `tick()` only interrupts for `boss` (`music.js:356-361`).

`onOptions` (`music.js:79-89`): `this.suspended = opts.musicMode === 'full' && !!this.engine.themeMusic?.available` — the composer only stands down when the theme layer can actually play. With `THEME_TRACKS = []` (see §10), `available` is `false`, so `'full'` keeps the composer running.

## 9. `Ambience` (`src/audio/ambience.js`)

Constructed by the engine (`engine.js:103`). Driven **only** from `audio.tick()` → `ambience.tick(tickCount)`. Class `Ambience` exported. Methods: `tick(tickCount)`, `updateRain(g)`, `updateWind(g)`, `sampleFluids(g)`, `reconcile(live, want, eventId)`, `silence()`. Getter `game` → `this.engine.game`.

Constants (`ambience.js:6-11`): `SAMPLE_CELLS = 48`, `SAMPLE_RADIUS = 12`, `BUCKET = 4`, `MAX_CLUSTERS = 2` (per fluid), `FIRE_RADIUS = 8`, `MAX_FIRE = 3`. Fluid sampling runs `if (tickCount % 20 === 0)` (once/sec, `ambience.js:33`); the fire scan is a separate hard-coded 24-sample loop (`ambience.js:97`).

State: `this.rain`, `this.wind` (single handles), `this.clusters = { water: [], lava: [] }`, `this.fires` — all arrays of `{x,y,z,handle}`. Gains: rain `0.6 * level` + `coverLp` 1200 (covered) / 20000 (open) (`ambience.js:49-50`); wind `0.12 * clamp((y-88)/24, 0, 1)` only when `canSeeSky` (`ambience.js:56-58`).

Game-side contract: `g.dayNight?.rainLevel`, `g.world.canSeeSky(x,y,z)`, `g.world.getBlock`, `g.world.getState`, `BLOCKS[id].fluid` (`'water'|'lava'`), `BLOCKS[id].name === 'fire' | 'furnace_lit'`, `g.state === STATE.PLAYING`. Y range hard-clamped to `0..127` (`ambience.js:82`, `101`). Uses `Math.random()` deliberately, **never `world.rng`** — that stream is seeded and shared with weather/worldgen (`ambience.js:71-72`).

`tick` bails and calls `silence()` unless state is `PLAYING`, except it preserves loops during `PLAYING_UI` (`ambience.js:27-29`). `Game.setState(TITLE)` calls `ambience.silence()` explicitly (`Game.js:152`) because `Game.tick()` early-returns once the world is null.

## 10. `ThemeMusic` (`src/audio/themeMusic.js`) — the one file-based layer

Exports: `class ThemeMusic`, `createThemeMusic(opts)`, `TITLE_GAIN = 0.45`, `WORLD_GAIN = 0.30`. Constants: `FADE_IN = 1.5`, `FADE_OUT = 0.8`, `HANDOFF_FADE = 1.0`, `titleGap = () => 10 + Math.random()*10`, `worldGap = () => 180 + Math.random()*240` (`themeMusic.js:19-24`). Memory guard (`themeMusic.js:32-34`): `DECODE_MAX = 6`, `DECODE_MAX_BYTES = 2.5e6`, `DECODE_BUDGET_BYTES = 96e6` — over budget → `<audio>` streaming path instead of `decodeAudioData`.

Public methods: `get available()` (`tracks.length > 0`), `unlock()`, `setOptions({master, music})`, `duck(_amount, _seconds)` (**no-op**, `themeMusic.js:140`), `start({ context = 'title' })`, `stop({ fade = HANDOFF_FADE })`, `onPause()`, `onResume()`, `dispose()`.

`src/audio/themeManifest.js` is **generated** and currently `export const THEME_TRACKS = []; export const THEME_CLEARED = false;` — "0 track(s) · ship gate: uncleared tracks withheld". So in every current build `available === false`, `start()` returns immediately (`themeMusic.js:324`), and the composer never suspends.

Because `main.js:95` injects `{context, musicBus}`: `ownsContext = false`, `externalBus = true` → `_buildFallbackGraph()` never runs, `masterGain` stays `null`, `_applyLevels()` never writes `musicBus.gain` (`themeMusic.js:125-129`), and `themeMusic` registers **no** `visibilitychange` listener of its own (`themeMusic.js:86-89`) — the engine forwards instead (`engine.js:99-100`). The file's header TODO (`themeMusic.js:8-13`) says E1 is "not built yet" and `_buildFallbackGraph()` should be deleted; that is stale — E1 is wired, and `main.js:93-94` already notes "the standalone fallback graph retires here". The dead fallback code path remains.

`epoch` (`themeMusic.js:76-79`) is bumped by every `start()`/`stop()`; every async continuation re-checks `epoch !== this.epoch` before touching state.

**Signature mismatch:** `src/ui/menus.js:232` calls `this.music?.stop(0.8)`, but `stop({ fade = HANDOFF_FADE } = {})` destructures its arg — `Number(0.8).fade` is `undefined`, so the fade silently falls back to `HANDOFF_FADE = 1.0`. No throw; the 0.8 is ignored. Every other call site (`menus.js:261`, `menus.js:355`) passes nothing.

Theme call sites: `menus.js:251` `start({context:'title'})` from `pressStart()`; `menus.js:355` `stop()` on menu→world; `menus.js:356-360` restarts with `{context:'game'}` after a **1100 ms `setTimeout`** when `musicMode === 'full' && music.available`.

## 11. Extension points, condensed

- **New one-shot**: `def('<ns>.<verb>', { recipe, bus, maxDist, cap, capKey, priority })` in `events.js`; emit via `emitSound(id, at(x,y,z))` or `emitSound(id, null)` for self.
- **New loop**: add `loop: true`, return `Infinity` from the recipe, expose params through `v.mod.<name>`; hold the handle from `startLoop(id, target)`; drive with `handle.setParam(name, value, tau)`; end with `handle.stop(fadeSec)`; re-check `handle.alive` before every use.
- **New material class**: add to `STEP_DUR` + `CORES` + `BREAK_LAYERS` (may be `null`, as `wool` is) → all five verb families generate automatically (`events.js:87-115`).
- **New mob**: add to `MOB_IDLE` with signature `(v, t, p, g, s)` where `s = { dur, fall }` → `.idle`/`.hurt`/`.death` derive automatically (hurt = pitch ×1.19, dur ×0.4, gain ×1.1; death = pitch ×0.79, dur ×1.5, fall 0.3) unless listed in `NO_IDLE`; optionally add `MOB_DIST[type]`.
- **New note instrument**: add to `NOTE` → `block.note.<inst>` generates (`events.js:809-814`).
- **New primitive**: export from `primitives.js` following `prim(voice, t0, p) -> stopTime`, honor `p.pitch` on every frequency param, connect to `voice.envGain`, push sources onto `voice.nodes`, register any modulatable AudioParam on `voice.mod`. `drone` is the unused precedent.
- **New bus**: `BUS_NAMES` (`engine.js:16`) + `SLIDER_OF` (`engine.js:19`) + a slider in `options.js` `DEFAULTS`.

## 12. Hard constraints

- `emitSound`/`startLoop` are **tick-only** — never render (`engine.js:2-3`, enforced by convention; `src/ui/debug.js:35` explicitly notes render code must not emit).
- Nothing is audible before `ctx.state === 'running'`; pre-gesture emits are dropped, not queued (`engine.js:273`).
- Max **16** voice starts per tick, **24** positional + **8** flat voices total.
- No allocation in the emit path (`at()`'s shared `_pos`, `_fwd`/`_up` scratch vectors at `engine.js:470-471`, `WOBBLE` at `primitives.js:502`).
- Loops are never stolen by priority (`engine.js:232`) — only by their own cap family, or after `handle.stop()` clears `v.loop`.


<!-- ===== a29419d3b83374031 ===== -->
# Integration Map — `src/registry/blocks.js`, `src/registry/items.js`, `src/constants.js`

Absolute paths:
- `/Users/jakevolkanovski/Desktop/ClaudeCraft/src/registry/blocks.js` (823 lines)
- `/Users/jakevolkanovski/Desktop/ClaudeCraft/src/registry/items.js` (291 lines)
- `/Users/jakevolkanovski/Desktop/ClaudeCraft/src/constants.js` (79 lines)

Line refs below are `file:line` relative to `src/`.

---

## 1. ID ranges actually in use

| Range | Contents | Storage |
|---|---|---|
| **0–66** | Blocks. Dense array `BLOCKS[]`, `blocks.js:56`. 67 entries, no holes: `air`=0 (`blocks.js:308`) … `dead_bush`=66 (`blocks.js:685`). | `Uint8Array(32768)` per chunk — `world/Chunk.js:18`, `world/Chunk.js:39`. **Hard ceiling: block id ≤ 255.** Free: **67–255**. |
| **0–66 (subset)** | Block-items. Share the block id (`items.js:64` `defItem(block.id, block.name, …)`). 11 ids excluded by `NO_BLOCK_ITEM` (`items.js:55–59`) → **56 block-items**. | — |
| **256–280** | Tools/weapons. 5 materials × 5 kinds, `id` incremented in loop `items.js:89–98`. Order per material: sword, pickaxe, axe, shovel, hoe. | — |
| **281–287** | `bow`, `arrow`, `shears`, `flint_and_steel`, `bucket`, `water_bucket`, `lava_bucket` (`items.js:100–106`). | — |
| **288–303** | Armor. 4 materials × 4 slots, `id = 288` reset at `items.js:116`, loop `items.js:117–124`. Order per material: helmet, chestplate, leggings, boots. | — |
| **304–317** | Food, ids hard-coded in the `FOOD` table (`items.js:128–143`). | — |
| **318–345** | Materials & misc, each id hard-coded (`items.js:153–180`). Last = `oak_door` item 345 (`items.js:180`). | — |

Item ids **256–345 are contiguous with no gaps**. First free item id: **346**. `ITEMS` is a `Map` (`items.js:7`), not an array — no density requirement.

`states` is also `Uint8Array(32768)` (`world/Chunk.js:19`, `:39`) — one byte per voxel, which is what makes the bit-7 contract a byte-level contract.

---

## 2. `defBlock` — signature and EVERY field

```js
function defBlock(id, name, opts = {})            // blocks.js:248
```
Not exported. Computes `displayName` as `opts.displayName ?? name.replace(/_/g,' ').replace(/\b\w/g, c=>c.toUpperCase())` (`blocks.js:249–250`). Builds the object with defaults, then **`...opts` spreads LAST** (`blocks.js:293`) — so `opts` can override `id`, `name`, `displayName`, anything. Side effects: `BLOCKS[id] = block` (`blocks.js:295`), `B[name.toUpperCase()] = id` (`blocks.js:296`). Returns the block.

Complete default table (`blocks.js:251–293`), exact values:

| Field | Default | Meaning / consumers |
|---|---|---|
| `id`, `name`, `displayName` | args | — |
| `shape` | `'cube'` | Mesher switch, `mesh/ChunkMesher.js:148–159`. Values in use: `cube`, `none` (air), `liquid`, `cross`, `hash`, `torch`, `ladder`, `snow_layer`, `cactus`, `fence`, `door`, `bed`, `farmland`. `'none'` hits no case (air is skipped upstream). `mesh/ChunkMesher.js:439` special-cases `shape === 'fence'`. |
| `bucket` | `'opaque'` | Geometry builder select: `builders[blk.bucket] \|\| builders.opaque` (`mesh/ChunkMesher.js:185`). Values: `'opaque'`, `'cutout'`, `'water'`, `null` (air). `'water'` → `renderOrder = 10` (`world/ChunkManager.js:315`). |
| `opaque` | `true` | Face culling; `isSolidSupport` (`blocks.js:91`); ice/grass ticks. |
| `collidable` | `true` | Physics. |
| `targetable` | `true` | Raycast (3 external refs). `false` on air/water/lava. |
| `renderSameIdFaces` | `false` | Only `true` on the 3 leaves (`blocks.js:345`). 1 external ref (mesher). |
| `emission` | `0` | Block light 0–15. Non-zero: glowstone 15, jack_o_lantern 15, lava 15, fire 15, torch 14, furnace_lit 13. |
| `opacity` | `15` | Light attenuation. Leaves/ice = 1, water = 1, **lava = 15** (`blocks.js:657`). |
| `hardness` | `0` | Break time. `-1` = unbreakable (air, bedrock, water, lava). |
| `blast` | `0` | Explosion resistance. Bedrock 3600000 (`blocks.js:358`), obsidian 1200, water/lava 100. |
| `tool` | `null` | `'pickaxe' \| 'axe' \| 'shovel' \| 'shears'`. Never `'sword'`/`'hoe'`. |
| `tier` | `null` | `null` \| `'class'` \| `0..3`. See §5. |
| `gravity` | `false` | `true` on sand (`:360`), gravel (`:362`). 10 external refs. |
| `climbable` | `false` | `true` only on ladder (`:454`). |
| `slipperiness` | `0.6` | `0.98` only on ice (`:486`). |
| `replaceable` | `false` | See §7. |
| `fluid` | `null` | `'water'` (`:652`), `'lava'` (`:659`). |
| `fluidAlpha` | `1.0` | water `0.7` (`:652`). |
| `blockEntity` | `null` | `'furnace'` (35, 36), `'chest'` (37). Read at `Game.js:461`, `world/World.js:133`. |
| `interactable` | `null` | `'crafting'`, `'furnace'`, `'chest'`, `'door'`, `'bed'`. Dispatch: `player/interaction.js:394`, `:457`. |
| `needsSupport` | `null` | `'below'` \| `'attach'`. **ZERO consumers outside the registry** — purely declarative; `canPlaceAt`/`neighborUpdate` do the real work. |
| `collisionBox` | `null` | `[x0,y0,z0,x1,y1,z1]` or the string `'door'` (`:551`) → `doorBox(state)`. 6 external refs. |
| `tiles` | `all(name)` | 6-array in face order **`[+X, −X, +Y(top), −Y(bottom), +Z, −Z]`** (`blocks.js:59`). `null` on air. |
| `tilesFor` | `null` | `(state, face) => tileName`. Called as a **plain function** (no `this`) at `blocks.js:816`. |
| `drops` | `dropSelf(name)` | `(ctx) => [{name, count}]`. See §6. |
| `xpForMine` | `null` | `(ctx) => number`. Only ores. Called **as a method** at `player/interaction.js:273` — the ore fns use `this` (`blocks.js:378`, `:382`, `:384`, `:386`). |
| `randomTick` | `null` | `(world, x, y, z, state) => void`. |
| `scheduledTick` | `null` | Only fire (`:677`). |
| `neighborUpdate` | `null` | `(world, x, y, z, state) => void`. |
| `onPlaced` | `null` | Only fire (`:674`). |
| `onBroken` | `null` | ice (`:494`), oak_door (`:559`), bed_block (`:583`). |
| `canPlaceAt` | `null` | `(world, x, y, z, state?) => bool`. Torch defaults `state = 0` (`:443`), ladder defaults `state = 1` (`:456`). |
| `species` | `null` | `'oak' \| 'birch' \| 'spruce'` on logs, leaves, saplings. 26 external refs. Read by `saplingTick` (`:123`). |
| `mat` | `'none'` | Overwritten by the MAT loop, §8. |
| `fireEnc` | `0` | Overwritten by the FIRE loop, §9. |
| `fireBurn` | `0` | Overwritten by the FIRE loop, §9. |
| `lavaIgnite` | `false` | Overwritten by the FIRE loop, §9. |
| `waterloggable` | `false` | Overwritten by the loop at `blocks.js:783–787`, §10. |
| `infiniteBurn` | `false` | "eternal fire below (declared by 10, consumed 15 §2)" (`blocks.js:292`). **No block in the table ever sets it true.** Its only reader is `world/fire.js:197` (`BLOCKS[below]?.infiniteBurn === true`), so that branch is currently unreachable. |

`CROSS` preset (`blocks.js:301–304`), spread into 10 blocks:
```js
const CROSS = { shape:'cross', bucket:'cutout', opaque:false, collidable:false, opacity:0, hardness:0, blast:0 };
```

---

## 3. `defItem` — signature and EVERY field

```js
function defItem(id, name, opts = {})             // items.js:10
```
Not exported. Same `displayName` derivation (`items.js:11–12`). `...opts` spreads last (`items.js:36`). Side effects: `ITEMS.set(id, item)` (`items.js:38`); `NAME_TO_ID.set(name, id)` **only if absent** — first registration wins (`items.js:39`).

Complete default table (`items.js:13–36`):

| Field | Default | Notes |
|---|---|---|
| `id`, `name`, `displayName` | args | — |
| `stack` | `64` | `1` on tools/armor/bow/shears/flint_and_steel/water_bucket/lava_bucket/bed; `16` on `bucket` (`:104`) and the 3 throwables (`:168–170`). |
| `kind` | `'material'` | In use: `'material'`, `'block'`, `'tool'`, `'sword'`, `'shears'`, `'bow'`, `'flint_and_steel'`, `'bucket'`, `'armor'`, `'food'`, `'throwable'`, `'seed'`, `'bed'`, `'door'`. |
| `toolClass` | `null` | `'sword' \| 'pickaxe' \| 'axe' \| 'shovel' \| 'hoe' \| 'shears'`. |
| `tier` | `null` | `0..3`. Note **`shears` has `tier: null`** (`items.js:102`). |
| `speedMult` | `1` | Swords forced back to `1` (`items.js:93`); shears `15` (`:102`). |
| `attackDamage` | `1` | |
| `attackSpeed` | `4.0` | "hand / any non-tool (05 §13.2)". |
| `durability` | `0` | `0` = indestructible. |
| `armorSlot` | `null` | `0..3` = helmet/chestplate/leggings/boots. Consumer guards on `!== undefined && !== null` (`ui/containers.js:554`). |
| `armorPoints` | `0` | |
| `toughness` | `0` | `2` only on diamond armor (`items.js:113`). |
| `hunger` | `0` | |
| `saturation` | `0` | |
| `poisonChance` | `0` | `0.3` chicken, `0.8` rotten_flesh (`items.js:135`, `:139`). |
| `fuel` | `0` | Ticks. Read only via `fuelValue()` (`items.js:288`). |
| `place` | `null` | Block id placed by RMB. |
| `placesAs` | `null` | `'bed'` (344) \| `'door'` (345). Dispatch `player/interaction.js:407`, `:576`, `:588`. |
| `plantsCrop` | `null` | Crop block id. `wheat_seeds` (`:172`); carrot/potato **patched post-hoc** at `items.js:149–150`. Dispatch `player/interaction.js:449`, `:609`. |
| `bucketFluid` | `undefined` | **Tri-state**: `undefined` = not a bucket; `null` = empty bucket (`:104`); `'water'` (`:105`) / `'lava'` (`:106`). |
| `sprite` | `` `item_${name}` `` | Block-items get `sprite: null` (`items.js:69`); HUD falls back to `BLOCKS[item.place].tileIndex[4]` (`ui/hud.js:17`). |
| `debugOnly` | `false` | Set from `DEBUG_ONLY` = `{BEDROCK, GLOWSTONE, WOOL_RED, WOOL_BLUE, WOOL_BLACK}` (`items.js:60`, `:70`). **ZERO consumers anywhere in `src/`** — dead field today. |

---

## 4. Item-stack shape — **there is NO `tags` field**

`grep -rn "tags" src/` returns **zero hits**. Neither registry defines it, nothing reads it.

Two distinct shapes exist and must not be confused:

- **Inventory stack**: `{ id, count, damage? }`. `damage` is added lazily and only when non-`undefined` (`entities/Player.js:112–114`); durability spend writes `s.damage = (s.damage ?? 0) + n` (`entities/Player.js:134`). Merge rule (`entities/Player.js:96–104`):
  ```js
  const stackable = max > 1 && stack.damage === undefined;
  … if (s && s.id === stack.id && (s.damage ?? 0) === (stack.damage ?? 0) && s.count < max)
  ```
  Anything with `damage` defined is unstackable regardless of `item.stack`. Save serialization packs exactly `{id, count, damage}` (`entities/Player.js:683`, `:696`) — **any new stack field would be dropped on save/load unless added there**.
- **Drop descriptor** returned by `block.drops`: `{ name, count }` — a *name*, not an id (`blocks.js:65`, `:83–86`, `:554`, `:579`). Converted at the spawn sites: `game.spawnItemByName(d.name, d.count, …)` (`player/interaction.js:281`, `world/World.js:294`, `Game.js:584`, `entities/mobs/Mob.js:268`).

---

## 5. Tool tiers

Block-side gate (`blocks.js:70–74`), exact:
```js
export function harvestOK(block, toolClass, toolTier) {
  if (block.tier == null) return true;
  if (block.tier === 'class') return toolClass === block.tool;
  return toolClass === block.tool && (toolTier ?? -1) >= block.tier;
}
```
Three-valued `tier`: `null` → always harvest; `'class'` → correct class, any tier (only `snow_layer` `blocks.js:467` and `snow_block` `blocks.js:480`); number → correct class **and** `toolTier >= tier`. Missing tier coerces to `-1`.

Wrapper (`blocks.js:75–77`) — returns `[]` on failure, **relies on `this` being the block**:
```js
const gated = fn => function (ctx) {
  return harvestOK(this, ctx.toolClass, ctx.toolTier) ? fn.call(this, ctx) : [];
};
```

Item-side tiers (`items.js:75–81`), exact:
```js
const TIERS = {
  wooden:  { tier: 0, speedMult: 2,  dur: 59 },
  stone:   { tier: 1, speedMult: 4,  dur: 131 },
  iron:    { tier: 2, speedMult: 6,  dur: 250 },
  golden:  { tier: 0, speedMult: 12, dur: 32 },   // gold harvests as tier 0, speed 12
  diamond: { tier: 3, speedMult: 8,  dur: 1561 },
};
```
Damage/speed tables at `items.js:82–87`: `SWORD_DMG`, `AXE_DMG`, `PICK_DMG`, `SHOVEL_DMG` (fractional: 2.5/3.5/4.5/2.5/5.5), `AXE_SPD`, `HOE_SPD`. Wooden tools/sword/bow carry `fuel: 200` (`items.js:93–97`); `bow` 300 (`:100`).

Block tier requirements in the table: `tier:0` → stone, cobblestone, sandstone, coal_ore, coal_block, furnace, furnace_lit; `tier:1` → iron_ore, lapis_ore, iron_block; `tier:2` → gold_ore, diamond_ore, redstone_ore, gold_block, diamond_block; `tier:3` → obsidian only (`blocks.js:400`).

`shears` (`items.js:102`) has `toolClass:'shears'` but `tier: null` — every shears-gated block (`leaves`, `wool_*`, `short_grass`, `dead_bush`) also has `tier: null`, so `harvestOK` short-circuits `true` for anyone. Shears behavior is instead implemented by explicit `ctx.toolClass === 'shears'` tests inside the drop fns (`blocks.js:81`, `:635`, `:687`).

---

## 6. Drops contract

`drops(ctx)` where `ctx = { state, toolClass, toolTier, rng }` — constructed identically at `player/interaction.js:271–272` and `world/World.js:288–289`. `Game.js:583` (TNT/explosion path) calls it with **`toolClass: blk.tool ?? 'pickaxe', toolTier: 3`** — explosion drops always pass `harvestOK`, and `Game.js` never calls `xpForMine`, so explosions grant no XP.

Helpers: `ri(rng,a,b)` inclusive (`blocks.js:64`), `dropSelf(name)` (`:65`), `noDrop` (`:66`), `leafDrops(sapling, withApple)` (`:80–87`: shears→self; 5% sapling; 2% 1–2 stick; 0.5% apple if `withApple`).

---

## 7. `replaceable` set — exactly 8 blocks

Doc comment at `blocks.js:311–315` names the set `{air, water, lava, fire, short_grass, dandelion, poppy, dead_bush}`; the code matches exactly:

| Block | id | line |
|---|---|---|
| `air` | 0 | `blocks.js:315` |
| `short_grass` | 60 | `blocks.js:634` |
| `dandelion` / `poppy` | 61 / 62 | `blocks.js:644` |
| `water` | 63 | `blocks.js:653` |
| `lava` | 64 | `blocks.js:660` |
| `fire` | 65 | `blocks.js:671` |
| `dead_bush` | 66 | `blocks.js:686` |

The comment at `blocks.js:312–314` records why air needs it: `tryPlace`'s `if (!BLOCKS[targetId].replaceable) return false` would otherwise reject every placement into empty space.

---

## 8. `mat` / `matOf`

Assigned **outside** `defBlock` by a name→class loop (`blocks.js:726–732`), reading the `MAT` table (`blocks.js:707–724`). Unknown names `console.warn` and continue (`blocks.js:729`). A second loop (`blocks.js:734–738`) warns for any block left at `mat:'none'` other than `air`/`fire`. Neither throws.

Exact classes and members (`blocks.js:708–723`):
- `stone`: stone, cobblestone, sandstone, bedrock, obsidian, furnace, furnace_lit, **coal_block**
- `ore`: coal_ore, iron_ore, gold_ore, diamond_ore, redstone_ore, lapis_ore
- `metal`: iron_block, gold_block, diamond_block
- `wood`: oak/birch/spruce planks, oak/birch/spruce log, crafting_table, chest, bookshelf, ladder, oak_fence, oak_door, bed_block, **torch**, **pumpkin**, **jack_o_lantern**
- `gravel`: gravel, **dirt**, **farmland**
- `sand`: sand
- `grass`: grass_block, 3× leaves, 3× saplings, wheat/carrot/potato crop, sugar_cane_block, short_grass, dandelion, poppy, dead_bush, **tnt**
- `glass`: glass, **ice**, **glowstone**
- `wool`: wool_white/red/blue/black, **cactus**
- `snow`: snow_layer, snow_block
- `fluid`: water, lava
- `none`: air, fire

`blocks.js:705–706` explicitly flags the counter-intuitive assignments as correct-per-spec: `tnt→grass, cactus→wool, glowstone→glass, ice→glass, coal_block→stone, dirt/farmland→gravel, sandstone→stone, dead_bush→grass`. Extension default per `blocks.js:701`: `'nether'` / `'end'`.

```js
export function matOf(id) {                       // blocks.js:791–794
  const m = BLOCKS[id]?.mat;
  return m === 'none' || m === 'fluid' || !m ? null : m;
}
```
Returns `null` for `none`/`fluid`/missing — callers skip silently. Consumers: `entities/Arrow.js:91`, `entities/Player.js:250`, `entities/mobs/Mob.js:159`, `player/interaction.js:242`, `:293`, `:564`.

---

## 9. `fireEnc` / `fireBurn` / `lavaIgnite`

Assigned outside `defBlock` by the `FIRE` loop (`blocks.js:771–778`) over the table at `blocks.js:748–769`, tuple order `[enc, burn, lavaIgnite]`. Unknown names warn and continue (`blocks.js:773`). Anything not listed stays `0 / 0 / false`.

| Block(s) | Enc | Burn | lavaIgnite |
|---|---|---|---|
| oak/birch/spruce_planks | 5 | 20 | true |
| oak/birch/spruce_log | 5 | 5 | true |
| oak/birch/spruce_leaves | 30 | 60 | true |
| coal_block | 5 | 5 | true |
| crafting_table | 0 | 0 | true |
| chest | 0 | 0 | true |
| bookshelf | 30 | 20 | true |
| tnt | 15 | 100 | true |
| oak_fence | 5 | 20 | true |
| oak_door | 0 | 0 | true |
| bed_block | 0 | 0 | true |
| wool_white/red/blue/black | 30 | 60 | true |
| short_grass | 60 | 100 | true |
| dandelion, poppy | 60 | 100 | **false** |
| dead_bush | 60 | 100 | true |

`blocks.js:767–768` enumerates the explicit zeroes: saplings, crops, farmland, sugar_cane, cactus, pumpkin, jack_o_lantern, torch, ladder, snow, ice, glass, stone/ores/minerals, fluids.

Waterlog-aware accessors (`blocks.js:49–50`) — the only correct way to read these:
```js
export const effFireEnc  = (id, state) => ((state & WATERLOGGED) ? 0 : (BLOCKS[id]?.fireEnc  ?? 0));
export const effFireBurn = (id, state) => ((state & WATERLOGGED) ? 0 : (BLOCKS[id]?.fireBurn ?? 0));
```
Used at `world/fire.js:65`, `:80`, `:166`. `lavaIgnite` is read **raw** at `world/fire.js:307` and `:320`, with the bit-7 exclusion open-coded at those sites rather than via a helper.

---

## 10. The bit-7 contract (verbatim, `blocks.js:19–39`)

```
// ============================================================================
// THE BIT-7 CONTRACT — GLOBAL, FROZEN by 15-FIRE-WATERLOGGING §8. (AMENDS 06 §1)
// ============================================================================
//   bit 7 (0x80) of every voxel's `states` byte = WATERLOGGED. Owned by 15 for
//   every block in the game; NO other file may assign it.
//   Per-block nibble meanings occupy bits 0–3 ONLY. Bits 4–6 remain free.
//
//   Invariants every state consumer must honor:
//     * `states & 0x80` is meaningful only where BLOCKS[id].waterloggable.
//       setBlock CLEARS bit 7 whenever the new id is not waterloggable (§8).
//     * A bit-7 cell IS a water source for EVERY system: fluid spread, buckets,
//       swimming/drowning, light filtering, hydration, lava interaction,
//       infinite-source formation. Use isWaterCell/isWaterSource — never a bare
//       `id === B.WATER`.
//     * Nibble reads must mask: `state & 0x0F`. A bare `state === 0` test for
//       "fluid source" is WRONG on a waterlogged cell.
//     * Toggling bit 7 must run the light edit AND neighbor updates even though
//       the id is unchanged (AMENDS 01 §4.6/§4.2).
// ============================================================================
export const WATERLOGGED = 0x80;
export const STATE_NIBBLE = 0x0F;
```

**Bits 4–6 are the only free state bits** — the resource a new stateful block must claim.

Enforcement points: `world/World.js:111` `if (!BLOCKS[id]?.waterloggable) state &= ~WATERLOGGED;`; flip detection `world/World.js:117`, `:188`; re-schedule `world/World.js:164`; `setWaterlogged` guard `world/World.js:219–221`.

Predicates (`blocks.js:42`, `:45–46`):
```js
export const isWaterCellAt   = (id, state) => id === B.WATER || (state & WATERLOGGED) !== 0;
export const isWaterSourceAt = (id, state) =>
  (id === B.WATER && (state & STATE_NIBBLE) === 0) || (state & WATERLOGGED) !== 0;
```
Wrapped as `world.isWaterCell` / `isWaterSource` at `world/World.js:204`, `:209`.

**`waterloggable` = exactly 3 blocks** (`blocks.js:783–787`): `oak_fence` (52), `ladder` (39), `chest` (37). Leaves are explicitly excluded as a documented deviation (`blocks.js:781–782`: "our leaves are full cubes carrying persistence bits — see DEVIATIONS"). Fire is never waterlogged by construction (`blocks.js:668–669`).

### State-nibble conventions (`blocks.js:4–17`)
- FACING (furnace bits0–1, door bits2–3, bed bits0–1): `0=+Z(south) 1=−X(west) 2=−Z(north) 3=+X(east)`, `FACING_DIR = [[0,0,1],[-1,0,0],[0,0,-1],[1,0,0]]` (`blocks.js:52`).
- TORCH/LADDER wall states 1–4 = direction the block **faces**; support cell = `pos − WALL_DIR[state]`. `WALL_DIR = {1:[0,0,1], 2:[0,0,-1], 3:[1,0,0], 4:[-1,0,0]}` (`blocks.js:53`) — **keys 1–4 only, no key 0**. Torch state 0 = floor.
- Door: bit0 upper, bit1 open, bits2–3 facing. Bed: bits0–1 facing, bit2 part (1=head). Crops: bits0–2 stage. Farmland: bit3 wet. Leaves: bit0 persistent. Cactus/cane: nibble = age 0–15. Fluids: bit3 falling, bits0–2 spread (source = 0). Fire: nibble = age 0–15.

Masking hazard is called out twice in-code (`blocks.js:217–220`, `:457–460`): a waterlogged ladder is `0x81..0x84`, so `WALL_DIR[state]` without `& STATE_NIBBLE` returns `undefined` and the `?? WALL_DIR[1]` fallback probes the wrong wall, popping the ladder.

`farmlandTick` preserves the high bits defensively: `const newState = (state & ~0x0F) | (state & 7) | (wet ? 8 : 0);` (`blocks.js:184`) — comment at `:182–183` notes farmland is not waterloggable so bit 7 is always clear there.

`Game.js:572` treats bit 7 as blast-resistant: `const blast = (state & WATERLOGGED) ? Math.max(blk.blast, 100) : blk.blast;`

---

## 11. Public surface

### `blocks.js` exports
| Export | Line | Signature / value |
|---|---|---|
| `WATERLOGGED` | 38 | `0x80` |
| `STATE_NIBBLE` | 39 | `0x0F` |
| `isWaterCellAt` | 42 | `(id, state) => bool` |
| `isWaterSourceAt` | 45 | `(id, state) => bool` |
| `effFireEnc` | 49 | `(id, state) => number` |
| `effFireBurn` | 50 | `(id, state) => number` |
| `FACING_DIR` | 52 | `[[0,0,1],[-1,0,0],[0,0,-1],[1,0,0]]` |
| `WALL_DIR` | 53 | `{1:[0,0,1],2:[0,0,-1],3:[1,0,0],4:[-1,0,0]}` |
| `BLOCKS` | 56 | dense array 0–66 |
| `B` | 57 | `{ UPPERCASE_NAME: id }` |
| `harvestOK` | 70 | `(block, toolClass, toolTier) => bool` |
| `isSolidSupport` | 89 | `(id) => !!b && (b.opaque \|\| b.name === 'glass')` |
| `doorBox` | 236 | `(state) => [x0,y0,z0,x1,y1,z1]`, `T3 = 3/16` |
| `matOf` | 791 | `(id) => string \| null` |
| `blockByName` | 796 | `(name) => block \| undefined` |
| `finalizeBlockTiles` | 802 | `(TILE) => void` |

`DIRS6` (`blocks.js:54`) is module-private. 24 modules import from `registry/blocks.js`.

### `items.js` exports
| Export | Line | Notes |
|---|---|---|
| `ITEMS` | 7 | `Map<id, item>` |
| `NAME_TO_ID` | 8 | `Map<name, id>` — **0 external refs** |
| `idOf` | 182 | `name => id`, **throws** `unknown item/block name: ${name}` on miss. 21 external refs. |
| `itemById` | 187 | `i => ITEMS.get(i)` — **0 external refs**; callers use `ITEMS.get()` directly (e.g. `entities/Player.js:89`, `:94`). |
| `RECIPES` | 198 | array, populated `items.js:205–262` |
| `SMELTING` | 272 | `Map<inputId, {out, xp}>`, 12 entries |
| `fuelValue` | 288 | `(itemId) => ITEMS.get(itemId)?.fuel ?? 0` |

10 modules import from `registry/items.js`.

### `constants.js` exports (all 26)
`MS_PER_TICK=50`, `TPS=20`, `MAX_TICKS_PER_FRAME=5` (`:5–7`); `WORLD_HEIGHT=128`, `MAX_Y=127`, `SEA_LEVEL=63`, `WORLD_BORDER=1_000_000`, `CHUNK_SIZE=16`, `CHUNK_CELLS=32768` (`:10–15`); `blockIndex = (x,y,z) => (y<<8)|(z<<4)|x` (Y-major, `:18`), `chunkKey = (cx,cz) => cx+','+cz` (`:19`); `GENERATE_RADIUS=9`, `RENDER_RADIUS=8`, `SIM_RADIUS=6`, `UNLOAD_RADIUS=11`, `WORKER_COUNT=2`, `MAX_JOBS_IN_FLIGHT=16`, `REMESH_FRAME_BUDGET_MS=6`, `REMESH_FRAME_MAX=4`, `INITIAL_MESH_PER_TICK=8` (`:23–30`); `ATLAS_SIZE=512`, `TILE_PX=16`, `ATLAS_COLS=32` (`:33–35`); `MAX_LIGHT=15`, `LIGHT_NODE_BUDGET=100_000`, `AMBIENT_FLOOR=0.04` (`:38–40`); `AUTOSAVE_INTERVAL=600`, `DB_NAME='mc-world'`, `DB_VERSION=1`, `SAVE_VERSION=1` (`:43–46`); `CAMERA_FOV=70`, `CAMERA_NEAR=0.05`, `CAMERA_FAR=1000` (`:49–51`); `KEYBINDS` (`:54–68`); `STATE = {TITLE, LOADING, PLAYING, PLAYING_UI, PAUSED, DEAD}` (`:71–78`).

`constants.js` contains **no registry ids, no atlas budget beyond `ATLAS_COLS × ATLAS_COLS = 1024` tile slots**, and no block/item-count knob.

---

## 12. Extension points (mechanics as written)

1. **New block** → `defBlock(id, name, opts)`. Must then be added to `MAT` (`blocks.js:707`) or the warn loop at `:734` fires; optionally `FIRE` (`:748`) and the waterloggable list (`:783`). All three are name-keyed tables *outside* `defBlock` — deliberately, per `blocks.js:696–700` ("24 of the 67 blocks are loop-generated").
2. **New item** → `defItem(id, name, opts)` with id ≥ 346. Block-items are auto-generated by the loop at `items.js:62–72`; to suppress one, add to `NO_BLOCK_ITEM` (`items.js:55`).
3. **Tiles** → `finalizeBlockTiles(TILE)` (`blocks.js:802`), called once, main thread only, from `main.js:27`. Builds `block.tileIndex = Uint16Array(6)` and, if `tilesFor` exists, `block.tileIndexFor(state, face)` with cache key `((state & 15) << 3) | face` (`blocks.js:815`) — **the key masks to the nibble, so `tilesFor` may never read bits 4–7**. Unknown tile names warn and resolve to index `0` (`blocks.js:805`).
4. **Recipes** → `shaped(output, count, pattern, key)` / `shapeless(output, count, ingredients)` (`items.js:199–202`). Format documented `items.js:190–192`: shaped matching also tries the horizontally mirrored pattern; `key` values are **arrays of ids**.
5. **Smelting/fuel** → `SMELTING` map entry (`items.js:272`) / `fuel` field or `FUEL_BLOCKS` (`items.js:44`).

---

## 13. Observed inconsistencies / dead code (facts, not proposals)

1. `infiniteBurn` (`blocks.js:292`) is never set true by any block; sole reader `world/fire.js:197` can never take that branch.
2. `needsSupport` (`blocks.js:281`) has **zero** consumers outside `blocks.js`. It's set on 9 blocks (saplings, torch, ladder, snow_layer, crops, sugar_cane, short_grass, flowers, dead_bush) and read by nothing.
3. `debugOnly` (`items.js:35`, `:70`) and its `DEBUG_ONLY` set (`items.js:60`) have **zero** consumers in `src/`.
4. `itemById` (`items.js:187`) and `NAME_TO_ID` (`items.js:8`) are exported but never imported.
5. `blocks.js:456–462` — the `ladder.canPlaceAt` body carries a mis-indented comment block copy-pasted from `ladderNeighbor` (`blocks.js:217–220`); the code is correct, the indentation is broken.
6. `this`-binding is load-bearing and asymmetric: `gated`/`leafDrops`/ore `xpForMine` use `this` and work only because call sites use method syntax (`block.drops(ctx)` at `player/interaction.js:271`, `world/World.js:288`, `Game.js:583`; `block.xpForMine(ctx)` at `player/interaction.js:273`). `tilesFor` is invoked as a bare `fn(state, face)` (`blocks.js:816`) — `this` is `undefined` inside it.
7. `Game.js:583–584` (explosion drops) calls `blk.drops` but never `blk.xpForMine` — ore XP is mining-only.
8. `validCactus` (`blocks.js:143`) does `BLOCKS[world.getBlock(...)].collidable` with no `?.` — it assumes `getBlock` always returns a valid id (other sites in the same file use `BLOCKS[id]?.`).
9. Several predicates depend on **id contiguity** and will silently mis-classify if ids are inserted between them: `leafDecayTick` `id >= B.OAK_LEAVES && id <= B.SPRUCE_LEAVES` (11–13) and `id >= B.OAK_LOG && id <= B.SPRUCE_LOG` (8–10) at `blocks.js:98–99`; `farmlandTick` `above >= B.WHEAT_CROP && above <= B.POTATO_CROP` (56–58) at `blocks.js:180`.
10. `ui/containers.js:673` hard-codes block ids as literals (`id === 35 || id === 36` for furnace, `id === 37` for chest) rather than using `B`.
11. Registry validation (`blocks.js:729`, `:736`, `:773`, `:785`, `:805`; `items.js` has none) is `console.warn`-only — a typo'd name silently yields default values.
12. `jack_o_lantern` carries an explicit simplification note (`blocks.js:518`): glowing face on all 4 sides, no facing state — unlike furnace/chest which use `FACING_FACE = [4, 1, 5, 0]` (`blocks.js:408`).


<!-- ===== a4183ed6cd9bccc7d ===== -->
I have what I need. Here is the map.

---

# ClaudeCraft — Game / main / saveManager Integration Map

## 1. Module surface

### `src/Game.js` — `export class Game` (Game.js:40)
Constructor: `constructor({ canvas, input, renderer, camera, viewmodelCamera, atlas, ui, audio, options })` (Game.js:41). Note `ui` is destructured but **main.js does not pass it** (main.js:39) — it is assigned post-hoc at main.js:100. Every `this.ui?.*` call is optional-chained for exactly this window.

Fields set in constructor (Game.js:42–83):
- `scene`, `viewmodelScene` (+ one `AmbientLight(0xffffff, 1.0)`, Game.js:54)
- `materials = createChunkMaterials(atlas.texture)` (Game.js:56); `initEntityVisuals(atlas)` (Game.js:57)
- `state = STATE.TITLE`, `accumulator = 0`, `lastTime = performance.now()`, `tickCount = 0`, `slowTicks = 0` (Game.js:59–63)
- Nulled subsystem slots: `world, chunkManager, entities, player, interaction, dayNight, mobSpawner, save, particles, sleeping` (Game.js:65–74)
- `debug = { fps: 0, frameMs: 0, remeshCount: 0, lastRemeshes: 0, audioMs: 0 }` (Game.js:75)
- `viewmodel = { group: THREE.Group, itemId: undefined, switchAnim: 0 }` (Game.js:79)
- `if (import.meta.env?.DEV) window.game = this;` (Game.js:83) — **DEV-only**; see §9.1.

Methods (public surface): `startWorld`, `disposeWorld`, `setState`, `start`, `frame`, `tick`, `snapPlayerToGround`, `render`, `applyMouseLook`, `updateCamera`, `buildOverlays`, `updateSelectionBox`, `updateCrack`, `updateViewmodel`, `getBlockEntity`, `tickBlockEntities`, `tickFurnace`, `swapFurnaceBlock`, `spillBlockEntity`, `explode`, `spawnItemById`, `spawnItemByName`, `dropStackAt`, `throwStack`, `spawnXpOrb`, `spawnArrow`, `spawnThrown`, `spawnFallingBlock`, `igniteTnt`, `spawnMobAt`, `onChunkGenerated`, `onChunkHydrated`, `restoreEntity`, `onChunkUnloading`, `growTree`, `trySleep`, `tickSleep`, `validateBedSpawn`, `onPlayerHurt`, `onPlayerDeath`, `respawnPlayer`, `toast`, `openContainer`.

**Monkey-patched onto the instance by main.js** (not class members): `game.ui` (main.js:100), `game.save` (main.js:44), `game.onContainerOpened` (main.js:126), `game.onContainerClosed` (main.js:130), `game.closeContainerScreen` (main.js:136). `audio.game = game` (main.js:40) is the back-reference.

`NEUTRAL_FRAME` (Game.js:34–38) — module-private frozen-by-convention input frame: `{ forward:0, strafe:0, jump:false, sneak:false, sprintKey:false, mouseLeft:false, mouseRight:false, leftPressed:false, rightPressed:false, middlePressed:false, pressed:new Set(), wheel:0, hotbar:-1, shift:false }`. **Not** deep-copied per use — the same `pressed` Set instance is handed to `player.tick()` on every non-playing tick.

### `src/save/saveManager.js` — `export class SaveManager` (saveManager.js:4)
`constructor()` → `{ db:null, savedChunkKeys:new Set(), meta:null, autosaveCounter:0, saving:false }` (saveManager.js:5–11).
Methods: `open()`, `hasWorld()`, `hasChunk(key)`, `loadChunk(key)`, `serializeChunk(chunk, game)`, `buildMeta(game)`, `saveChunkNow(chunk)`, `saveAll(game, { sync = false } = {})`, `tick(game)`, `deleteWorld()`.

### `src/main.js` — no exports; `async function boot()` (main.js:20), invoked at main.js:193.

---

## 2. Boot order (main.js:20–191)

1. `canvas = getElementById('game-canvas')`, `overlayEl = getElementById('overlay')`, `screensEl = getElementById('screens')` (main.js:21–23)
2. `atlas = buildAtlas()` → `finalizeBlockTiles(atlas.TILE)` → sets CSS var `--atlas-url` (main.js:26–28)
3. `options = loadOptions()`; `audio.boot()`; `audio.setOptions(options)` (main.js:33–35). One `options` object is shared by reference with `Menus` (comment main.js:30–32).
4. `input = new Input(canvas)`; `{ renderer, camera, viewmodelCamera } = createRenderer(canvas)` (main.js:37–38)
5. `game = new Game({...})`; `audio.game = game` (main.js:39–40)
6. `save = new SaveManager(); await save.open(); game.save = save;` (main.js:42–44)
7. UI: `hud`, `debug = new DebugOverlay(game, overlayEl)`, `containers` (main.js:47–49)
8. `menus = new Menus(game, screensEl, {...callbacks})` (main.js:61–91)
9. `themeMusic = createThemeMusic({ context: audio.ctx, musicBus: audio.buses.music })`; `audio.themeMusic = themeMusic`; `menus.attachMusic(themeMusic)`; `menus.setHasSave(save.hasWorld())` (main.js:95–98)
10. `game.ui = {...}` (main.js:100–123)
11. Container hooks (main.js:126–136), `input.onKeyEdge` (main.js:139), document keydown for PRESS START (main.js:158), `input.onLockChange` (main.js:167), canvas click (main.js:174), `visibilitychange` (main.js:180), `pagehide` (main.js:185)
12. `game.setState(STATE.TITLE); game.start();` (main.js:189–190)

**Ordering hazard**: `game.save = save` lands at main.js:44, but `Game.startWorld` copies it into `chunkManager.save` at Game.js:94 — so `save` must be set before any `startWorld`. It is.

---

## 3. State machine

`STATE` (constants.js:71–78) — **six** states, not four:
```js
STATE = { TITLE:'TITLE', LOADING:'LOADING', PLAYING:'PLAYING',
          PLAYING_UI:'PLAYING_UI', PAUSED:'PAUSED', DEAD:'DEAD' }
```

### `setState(next)` (Game.js:136–155) — exact body order
1. `const prev = this.state; this.state = next;`
2. `if (next === STATE.PAUSED && prev === STATE.PLAYING) this.save?.saveAll(this);` (Game.js:139) — **only** from PLAYING; PLAYING_UI→PAUSED does not save.
3. `if (next === STATE.PLAYING)` → `lastTime = performance.now()`, `accumulator = 0`, and `if (this.world) this.audio?.music?.arm(this.world.seedString)` (Game.js:140–145)
4. `if (next === STATE.TITLE)` → `audio?.music?.disarm()`, `audio?.ambience?.silence()` (Game.js:148–153). The comment (Game.js:149–151) states the reason: `Game.tick()` early-returns once `disposeWorld()` nulls `this.world`, so `audio.tick()` never runs again.
5. `this.ui?.onStateChange?.(next, prev)` (Game.js:154) — **always last**.

### `ui.onStateChange(next, prev)` (main.js:105–122)
- Screen routing: TITLE→`menus.show('title')`, LOADING→`'loading'`, PAUSED→`'pause'`, DEAD→`'death'`, else `menus.show(null)` (main.js:106–110). PLAYING and PLAYING_UI both fall to `null`.
- `if (next === STATE.PAUSED) audio.onPause(); else if (prev === STATE.PAUSED) audio.onResume();` (main.js:117–118) — resume on **any** exit from PAUSED (comment main.js:114–116 cites Save&Quit going PAUSED→TITLE).
- `if (next !== STATE.PLAYING_UI && containers.isOpen()) containers.close(true);` (main.js:119)
- `menus.setPaletteVisible(next === STATE.PLAYING_UI && game.player?.gameMode === 'debugCreative')` (main.js:120–121)

### Transition sources
| Transition | Site |
|---|---|
| → TITLE | main.js:189 (boot); main.js:57 (startWorld catch); main.js:88 (onQuit) |
| → LOADING | Game.js:110 (`startWorld` before chunk wait) |
| LOADING → PLAYING | Game.js:224, gated on `meshed >= needed` |
| → PLAYING | main.js:81 (onResume, only `if (ok !== false)`); Game.js:818 (`respawnPlayer`); main.js:132 (`onContainerClosed`) |
| PLAYING → PLAYING_UI | main.js:128 (`onContainerOpened`) |
| PLAYING → PAUSED | main.js:169 (pointer-lock loss, `&& !game.sleeping`); main.js:182 (`visibilitychange` + `document.hidden`) |
| → DEAD | Game.js:813 (`onPlayerDeath`, after `document.exitPointerLock?.()`) |

**There is no Escape→PAUSED handler in main.js.** `onKeyEdge` for `Escape` only closes containers when `state === PLAYING_UI` (main.js:152–153). Pausing while PLAYING happens indirectly: Escape releases pointer lock → `input.onLockChange(false)` → PAUSED (main.js:167–171).

`STATE.DEAD` **ticks**. `frame()` includes DEAD in the tick set (Game.js:167–168), and `tick()` gates only on `state !== STATE.LOADING` (Game.js:195) — so while dead, `player.tick(NEUTRAL_FRAME)` (because `playing` is false, Game.js:192–193), entities, scheduled, randomTicks, dayNight, mobSpawner all keep running. Only the viewmodel render is skipped (Game.js:271).

---

## 4. Frame → tick order

### `frame(now)` (Game.js:161–185)
1. `requestAnimationFrame(this.frame)` — **re-armed first**, before any work (Game.js:162)
2. `frameDelta = Math.min(now - this.lastTime, 250)`; `this.lastTime = now` (Game.js:163–164)
3. `t0 = performance.now()`
4. If `state ∈ {PLAYING, PLAYING_UI, LOADING, DEAD}` (Game.js:167–168): `accumulator += frameDelta`, then `while (accumulator >= MS_PER_TICK && ran < MAX_TICKS_PER_FRAME) { tick(); accumulator -= MS_PER_TICK; ran++ }`; `if (ran === MAX_TICKS_PER_FRAME) accumulator = 0` (spiral-of-death bleed, Game.js:176). **TITLE and PAUSED do not tick.**
5. `alpha = Math.min(1, accumulator / MS_PER_TICK)` (Game.js:178)
6. `this.render(alpha)` (Game.js:179)
7. `debug.frameMs = performance.now() - t0` — **includes render** (Game.js:181)
8. FPS: push `now` into `_fpsWindow`, shift entries `< now - 1000`, `debug.fps = _fpsWindow.length` (Game.js:182–184)

Constants: `MS_PER_TICK = 50` (20 TPS), `TPS = 20`, `MAX_TICKS_PER_FRAME = 5` (constants.js:5–7).

### `tick()` (Game.js:187–233) — numbered
0. `if (!this.world) return;` (Game.js:188) — the master gate. `this.tickCount++`; `tickStart = performance.now()`.
1. `const playing = this.state === STATE.PLAYING` (Game.js:192)
2. `const frame = playing && !this.sleeping ? this.input.snapshot() : (this.input.snapshot(), NEUTRAL_FRAME)` (Game.js:193) — `input.snapshot()` is called **unconditionally** (comma operator) so edge state drains, but the result is discarded when not playing or sleeping.

**Block A — `if (this.state !== STATE.LOADING)`** (Game.js:195–203):
3. `this.player.tick(frame)`
4. `this.interaction.tick(frame)`
5. `this.entities.tick(this.player)`
6. `this.world.scheduled.run()`
7. `this.world.randomTicks()`
8. `this.dayNight.tick()`
9. `this.mobSpawner?.tick()`

**Always:**
10. `this.chunkManager.tick(this.player.pos.x, this.player.pos.z)` (Game.js:204) — runs during LOADING too.

**Block B — `if (this.state !== STATE.LOADING)`** (Game.js:205–208):
11. `this.tickBlockEntities()`
12. `this.tickSleep()`

**Always:**
13. `this.save?.tick(this)` (Game.js:209) — **autosave counter advances during LOADING**
14. `this.audio?.tick()` (Game.js:210)
15. `this.atlas.animate?.(this.world.time)` (Game.js:211)
16. `this.ui?.containers?.tickOpen?.()` (Game.js:212)

**LOADING gate** (Game.js:215–227): compute `pcx/pcz` from player pos; `chunkManager.drainRemesh(px, pz, 40, 12)` (budgetMs 40, maxCount 12 — overrides the `REMESH_FRAME_BUDGET_MS = 6` / `REMESH_FRAME_MAX = 4` defaults); `{meshed, needed} = chunkManager.loadingProgress(pcx, pcz)`; `ui?.setLoadingProgress?.(meshed, needed)`; if `meshed >= needed` → `chunkManager.loading = false`, `snapPlayerToGround()`, `setState(STATE.PLAYING)`, `input.requestLock()`.

**Slow-tick warn** (Game.js:229–232): `dt > 40 && state !== LOADING` → `if (++this.slowTicks >= 2) console.warn(...)`; else `slowTicks = 0`. Note `slowTicks` is never reset on the warn branch, so it keeps climbing and every subsequent slow tick warns.

`loadingProgress(pcx, pcz)` (ChunkManager.js:327–337) is a **7×7** (`dx,dz ∈ [-3,3]`), `needed = 49`, counting only `state === ChunkState.MESHED`.

### `render(alpha)` (Game.js:249–278) — numbered
1. `this.renderer.clear(true, true, true)` (Game.js:250)
2. **Early-out**: `if (!this.world || this.state === STATE.TITLE)` → `this.audio?.updateFrame(null); return;` (Game.js:251–257). The comment (Game.js:252–255) states the music lookahead scheduler and §4A theme layer must run at the title and in the `disposeWorld→setState(TITLE)` window.
3. `this.applyMouseLook()` (Game.js:259)
4. `this.debug.lastRemeshes = this.chunkManager.drainRemesh(this.player.pos.x, this.player.pos.z)` (Game.js:260) — default budgets (6 ms / 4 chunks)
5. `this.updateCamera(alpha)` (Game.js:261)
6. `this.audio?.updateFrame(this.camera)` (Game.js:262); `this.debug.audioMs = this.audio?.debug.budgetMs ?? 0` (Game.js:263)
7. `this.dayNight.updateRender(alpha, this.camera)` (Game.js:264)
8. `this.entities.updateRender(alpha, this.player)` (Game.js:265)
9. `this.particles.update(alpha)` (Game.js:266)
10. `this.updateSelectionBox()` (Game.js:267)
11. `this.renderer.render(this.scene, this.camera)` (Game.js:269)
12. `if (state === PLAYING || state === PLAYING_UI)`: `updateViewmodel(alpha)`, `renderer.clearDepth()`, `renderer.render(this.viewmodelScene, this.viewmodelCamera)` (Game.js:271–275)
13. `this.ui?.hud?.update?.()` (Game.js:276)
14. `this.ui?.debug?.update?.()` (Game.js:277)

`render` runs in **every** state except the TITLE/no-world early-out — including PAUSED and DEAD (world still drawn behind the menu).

**Render-order constants**: `selectionBox.renderOrder = 11` (Game.js:336); chunk water bucket `renderOrder = 10`, opaque/cutout `0` (ChunkManager.js:315). Crack mesh uses `polygonOffsetFactor: -2, polygonOffsetUnits: -2`, `depthWrite: false` (Game.js:362–363).

---

## 5. F3 debug overlay

`DebugOverlay` (debug.js:4) — `constructor(game, overlayEl)` creates `div#debug-overlay`, `visible = false`, `lastUpdate = 0`. `toggle()` (debug.js:14) flips `visible` and sets `style.display`. Bound to `F3` in `input.onKeyEdge` (main.js:140–141); `KEYBINDS.debugOverlay = 'F3'` (constants.js:64) is **not** what wires it — main.js hardcodes the `'F3'` string.

`update()` (debug.js:19): returns if `!visible`; throttles to **250 ms (4 Hz)** (debug.js:22); returns if `!p || !g.world` (debug.js:26).

Exact 8 lines emitted (debug.js:40–48):
1. `ClaudeCraft F3 | ${g.debug.fps} fps ${g.debug.frameMs.toFixed(1)} ms`
2. `XYZ ${p.pos.x.toFixed(2)} / ${p.pos.y.toFixed(2)} / ${p.pos.z.toFixed(2)}`
3. `chunk ${x>>4},${z>>4} facing ${facing} biome ${biome}`
4. `light sky ${g.world.getSkyLight(x,y,z)} block ${g.world.getBlockLight(x,y,z)} darken ${g.world.skyDarken}`
5. `chunks R${counts.requested} G${counts.generated} L${counts.lit} M${counts.meshed} F${counts.failed} | remeshQ ${g.chunkManager.remeshQueue.size}`
6. `draws ${info.render.calls} tris ${(info.render.triangles/1000).toFixed(0)}k geoms ${info.memory.geometries}`
7. `entities ${g.entities.count()} time ${g.world.time} (day ${Math.floor(g.world.time/24000)} ${(Math.floor((g.world.time%24000)/1000)+6)%24}:00)${heap}`
8. `weather ${raining?'rain':'clear'}${thundering?'+thunder':''} seed ${g.world.seedString}`
9. `audio ${a.voices}/${g.audio?.poolSize?.() ?? 0} voices drops ${a.drops}/s ${a.state} ${a.budgetMs.toFixed(2)} ms music ${music}`

Derived locals: `facing = ['S +Z','W -X','N -Z','E +X'][Math.round(((-p.yaw % (2*Math.PI)) + 2*Math.PI) / (Math.PI/2)) % 4]` (debug.js:30–31); `heap` only when `performance.memory` exists, `usedJSHeapSize / 1048576` MB (debug.js:32–33); `biome = BIOME_NAMES[g.world.biomeAt(x,z)] ?? '?'` (debug.js:34); `a = g.audio?.debug ?? { voices:0, drops:0, state:'off', budgetMs:0 }` (debug.js:36); `music = mus?.piece ? `${mus.piece.mood}#${mus.pieceIndex - 1}` : 'silent'` (debug.js:37–38).

`counts` from `chunkManager.countByState()` (ChunkManager.js:339–348) — `failed` is the **else** branch, so it counts any state that isn't REQUESTED/GENERATED/LIT/MESHED, not only `FAILED`.

**Dead debug fields**: `debug.remeshCount` (Game.js:75) is initialized and **never written or read** anywhere. `debug.lastRemeshes` is written every frame (Game.js:260) but **never read** — the overlay shows `remeshQueue.size` instead (debug.js:44). `debug.audioMs` is written (Game.js:263) but the overlay reads `a.budgetMs` directly from `g.audio.debug` (debug.js:48), not `g.debug.audioMs`.

---

## 6. `explode(x, y, z, power)` — Game.js:548–627

Signature: `explode(x, y, z, power)`. RNG is `world.rng` (Game.js:550) — the **world** RNG, so explosions consume the deterministic world stream.

**Phase 1 — block destruction** (Game.js:552–589):
- `maxR = 1.3 * power + 0.6` (Game.js:552)
- `centerIsWater = BLOCKS[world.getBlock(floor(x),floor(y),floor(z))].fluid === 'water'` (Game.js:553). If true, **the entire block-destruction phase is skipped** (Game.js:554) — entity damage still applies.
- Cube scan `r0 = Math.ceil(maxR)`, `dy/dz/dx ∈ [-r0, r0]` (Game.js:555–558); skip `by < 0 || by > 127` (Game.js:560)
- `r = Math.hypot(bx+0.5-x, by+0.5-y, bz+0.5-z)`; skip `r > maxR` (Game.js:561–562)
- Skip `B.AIR` (Game.js:564); skip `blk.hardness < 0 && !blk.fluid` (bedrock, Game.js:566)
- `blast = (state & WATERLOGGED) ? Math.max(blk.blast, 100) : blk.blast` (Game.js:572) — waterlogged cells are explosion-proof
- `strength = power * (0.7 + 0.6 * rng()) * (1 - r / (1.3 * power))` (Game.js:573)
- Skip `if (strength <= (blast + 0.3) * 0.3)` (Game.js:574)
- **TNT chaining**: `if (id === B.TNT)` → `world.setBlock(bx,by,bz,B.AIR)` then `this.igniteTnt(bx, by, bz, 10 + Math.floor(rng() * 21))` → fuse ∈ [10, 30] ticks; `continue` (Game.js:575–579)
- Otherwise `world.setBlock(bx,by,bz,B.AIR)`, then drops at probability `rng() < 1 / power` with `blk.drops({ state, toolClass: blk.tool ?? 'pickaxe', toolTier: 3, rng })` — "as if mined by diamond tool" — each via `spawnItemByName(d.name, d.count, bx+0.5, by+0.5, bz+0.5)` (Game.js:580–585)

**Phase 2 — entity damage/knockback** (Game.js:591–621):
- `range = 2 * power`; box = `new AABB(x-range, y-range, z-range, x+range, y+range, z+range)` (Game.js:592–593)
- `this.entities.getEntitiesInBox(box, ent => !ent.dead)` (Game.js:594)
- Center: `cx = e.pos.x, cy = e.pos.y + e.height/2, cz = e.pos.z` (Game.js:595); skip `dist >= range` (Game.js:597)
- **Exposure**: 9 samples — AABB center + 8 corners (Game.js:600–607); `clear` counts `hasLineOfSight(world, sx,sy,sz, x,y,z)`; `exposure = clear / 9` (Game.js:611)
- `impact = (1 - dist/range) * exposure` (Game.js:612)
- `dmg = Math.floor((impact*impact + impact) / 2 * 7 * range + 1)` (Game.js:613)
- `if (e instanceof LivingEntity) e.hurt(dmg, 'explosion', {})` (Game.js:615–617) — **non-living entities take no damage but still get knockback**
- Knockback: `e.vel.{x,y,z} += (c{x,y,z} - {x,y,z}) / len * impact` where `len = dist || 1` (Game.js:618–620)

**Phase 3 — FX** (Game.js:622–626): `this.particles?.explosion?.(x,y,z,power)`; `emitSound('world.explosion', at(x,y,z))` — one emit covers both creeper and TNT triggers, `power` unused because the §3.5 distance-muffle LP is per-voice (comment Game.js:623–624); `this.dayNight?.flash?.(2)`.

## 7. `igniteTnt(x, y, z, fuse = 80)` — Game.js:684–689

```js
igniteTnt(x, y, z, fuse = 80) {
  if (this.world.getBlock(x, y, z) === B.TNT) this.world.setBlock(x, y, z, B.AIR);
  const e = this.entities.add(new PrimedTnt(this.world, x + 0.5, y, z + 0.5, fuse));
  e.fuseVoice = startLoop('world.tnt.fuse', e);   // §3.5: tracked to the entity
  return e;
}
```
Default fuse **80 ticks (4 s)**. The `B.TNT` guard means it is safe to call on an already-cleared cell — which is what `explode` does (it clears TNT itself at Game.js:576 *before* calling, Game.js:577). Spawn offset is `x+0.5, y, z+0.5` (block center, feet at block bottom). `fuseVoice` is the tracked loop handle.

The parallel restore path: `restoreEntity` (Game.js:718–732) reconstructs `PrimedTnt.deserialize` and re-attaches `e.fuseVoice = startLoop('world.tnt.fuse', e)` at Game.js:731 because mid-fuse TNT from a save never passes through `igniteTnt` (comment Game.js:729–730).

## 8. `onChunkUnloading(chunk)` — Game.js:734–740

```js
onChunkUnloading(chunk) {
  this.entities.onChunkUnloading(chunk, this.player);
  forgetFireInChunk(chunk.cx, chunk.cz);
}
```
Called from `ChunkManager.unloadPass` (ChunkManager.js:226), **after** `saveChunkNow` (ChunkManager.js:225) and **before** `disposeChunkMeshes` / `world.chunks.delete` (ChunkManager.js:227–228). Order matters: entities must still be in `chunk.entities` when serialization runs.

`EntityManager.onChunkUnloading(chunk, player)` (EntityManager.js:121–128) iterates `[...chunk.entities]`, skips `player`, and for each sets `e.deathTime = 0; e.dead = true; this.remove(e)`.

`forgetFireInChunk(cx, cz)` (fire.js:37–42) scans **all** `fireOrigins` keys, splits the `"x,y,z"` string, and deletes where `(+c[0] >> 4) === cx && (+c[2] >> 4) === cz`. Module-level `Map` capped at `MAX_ACTIVE (512)` (fire.js comment:24). Rationale in Game.js:736–738: fires in unloaded chunks never tick again, so their origins would sit forever and starve `MAX_ACTIVE`.

Sibling hooks: `onChunkGenerated(chunk)` (Game.js:697–706) — drains `chunk.pendingSpawns` via `spawnMobAt(..., { persistent: true })`, sets `spawnsDone = true`, `pendingSpawns = null`, `modified = true`. Called from ChunkManager.js:79. `onChunkHydrated(chunk, record)` (Game.js:708–716) — restores `record.entities` via `restoreEntity`, and if `!chunk.spawnsDone && record.spawns?.length` sets `pendingSpawns = record.spawns` then calls `onChunkGenerated(chunk)`. Called from ChunkManager.js:120.

---

## 9. Save subsystem

### Constants (constants.js:42–46)
```js
AUTOSAVE_INTERVAL = 600;   // ticks (30 s @ 20 TPS)
DB_NAME = 'mc-world';
DB_VERSION = 1;
SAVE_VERSION = 1;
```

### `open()` (saveManager.js:13–39)
`indexedDB.open(DB_NAME, DB_VERSION)`. `onupgradeneeded` creates object stores `'meta'` and `'chunks'` (keyPath-less; explicit keys). On success, one readonly tx over both stores: `meta.get('world')` + `chunks.getAllKeys()`. On `tx.oncomplete`: `this.meta = metaReq.result ?? null`; **version gate** — `if (this.meta && this.meta.version !== SAVE_VERSION) { console.warn('[save] incompatible save version — offering new world only'); this.meta = null; }` (saveManager.js:28–31). Strict `!==`, no migration path. `savedChunkKeys = new Set(keysReq.result ?? [])`.

### Meta schema — `buildMeta(game)` (saveManager.js:80–89)
```js
{
  version: SAVE_VERSION,            // 1
  seed: game.world.seedString,
  worldTime: game.world.time,
  weather: game.dayNight?.serialize() ?? null,
  player: game.player.serialize(),
  lastSaved: Date.now(),
}
```
`weather` = `{ raining, thundering, rainTimer, thunderTimer, rainLevel, thunderLevel }` (DayNight.js:369–375).

`player` = `Player.serialize()` (Player.js:682–699):
```js
{
  pos: [x,y,z], vel: [x,y,z], yaw, pitch,
  health,
  hunger: this.foodLevel, saturation, exhaustion, foodPoisonTicks,
  xp: this.xpTotal,
  air, fireTicks, fallDistance,
  gameMode,                          // 'survival' | 'debugCreative'  ← PERSISTS
  inventory: packStacks(this.inventory),   // 36 slots, {id,count,damage}|null
  armor: packStacks(this.armor),           // 4 slots
  offhand: this.offhand ? {id,count,damage} : null,   // ← PERSISTS
  selectedSlot,
  spawnPoint,                        // {x,y,z} | null  ← PERSISTS (bed spawn)
}
```
**Both `gameMode` and `offhand` persist.** `deserialize` (Player.js:702–724) reads them back: `gameMode: rec.gameMode ?? 'survival'` (Player.js:713), `offhand = rec.offhand || null` (Player.js:717), `spawnPoint = rec.spawnPoint ?? null` (Player.js:715). XP is stored as a single `xpTotal` and replayed through `addXp` with `_silentXp = true` bracketing (Player.js:719–723) to suppress the level-up chime. **Not persisted**: `flying`, `sprinting`, `sneaking`, `usingItem`, `invulnTicks`, `foodTickTimer`.

### Chunk schema — `serializeChunk(chunk, game)` (saveManager.js:53–78)
```js
{
  cx, cz,
  blocks: chunk.blocks.buffer,     // ArrayBuffer, structured-cloned
  states: chunk.states.buffer,
  biomes: chunk.biomes ? chunk.biomes.buffer : new ArrayBuffer(256),
  blockEntities: [{ i, type, data }],
  spawnsDone: chunk.spawnsDone,
  spawns: chunk.pendingSpawns ?? null,
  entities: [...],
}
```
Entity filter (saveManager.js:59–66): skip `e === game.player || e.dead`; keep only records where `rec && rec.type && rec.type !== 'player' && rec.type !== 'arrow' && !rec.type.startsWith('thrown')`. So **arrows and thrown projectiles never persist**; items, primed TNT, XP orbs and mobs do.

### Write paths
- `saveChunkNow(chunk)` (saveManager.js:92–104) — fire-and-forget, unload path. `tx.oncomplete → chunk.modified = false`. Whole body in `try/catch` → `console.warn('[save] chunk write failed', err)`.
- `saveAll(game, { sync = false } = {})` (saveManager.js:107–135) — guards `if (!this.db || !game?.world || !game.player) return Promise.resolve()`; re-entrancy guard `if (this.saving) { console.warn('[save] save overlapping previous — skipped'); return Promise.resolve(); }`. Collects `dirty = chunks where chunk.modified && chunk.blocks`. One readwrite tx over `['meta','chunks']`: `meta.put(buildMeta(game), 'world')` + one `store.put` per dirty chunk. `oncomplete` → clear `modified` on all dirty, `this.meta = this.buildMeta(game)` (**builds meta a second time**, saveManager.js:128), `saving = false`. `onerror`/`onabort` → `saving = false; resolve()` — **resolves, never rejects; caller cannot detect failure**.
- `tick(game)` (saveManager.js:137–142) — `if (++this.autosaveCounter >= AUTOSAVE_INTERVAL) { autosaveCounter = 0; saveAll(game); }`. Never awaited.
- `deleteWorld()` (saveManager.js:144–153) — closes db, nulls `db`/`meta`, clears `savedChunkKeys`, `indexedDB.deleteDatabase(DB_NAME)`; resolves on `onsuccess`/`onerror`/`onblocked` alike.

`saveAll` call sites: Game.js:139 (PLAYING→PAUSED), main.js:86 (onQuit), main.js:186 (`pagehide`, `if (game.world)`), saveManager.js:140 (autosave).

### 9.1 — `saveChunkNow` resolves `game` from a DEV-only global
saveManager.js:94: `const game = chunk?.gameRef ?? window.game;`
`gameRef` **is never assigned anywhere in `src/`** (grep: the only occurrence is this read). `Chunk` has no such field (Chunk.js:26–34). So this always falls through to `window.game`, which is assigned **only under `import.meta.env?.DEV`** (Game.js:83). In a production Vite build `window.game` is `undefined`, so `serializeChunk(chunk, undefined)` reaches `if (e === game.player || e.dead)` (saveManager.js:60) and throws `TypeError` — swallowed by the `try/catch` (saveManager.js:102–103) as `[save] chunk write failed`. Consequence in prod: **any chunk that has entities fails to persist on the unload path**; `savedChunkKeys.add` and `chunk.modified = false` are both skipped (the throw precedes them), so the chunk stays dirty and is picked up by the next `saveAll` only if it is still resident — which it is not, since `unloadPass` deletes it from `world.chunks` immediately after (ChunkManager.js:228). Chunks with **zero** entities serialize fine (the loop body never runs).

### 9.2 — `saveAll`'s `sync` option is dead
`saveAll(game, { sync = false } = {})` (saveManager.js:107) destructures `sync` and **never references it**. No call site passes it. The `pagehide` handler (main.js:185–187) therefore issues an ordinary async IDB transaction during page teardown with no synchronous fallback.

---

## 10. World lifecycle

### `async startWorld(seedString, savedMeta = null)` (Game.js:88–120) — exact order
1. `this.disposeWorld()` (Game.js:89)
2. `this.world = new World(seedString)`; `this.world.game = this` (Game.js:90–91)
3. `this.chunkManager = new ChunkManager(this.world, this.scene, this.materials, this.atlas.tileUV)`; `chunkManager.game = this`; `chunkManager.save = this.save`; `world.chunkManager = this.chunkManager` (Game.js:92–95)
4. `this.entities = new EntityManager(this.world, this.scene)` (Game.js:96)
5. `this.player = new Player(this.world)`; `this.entities.add(this.player)` (Game.js:97–98)
6. `this.interaction = new Interaction(this)` (Game.js:99)
7. `this.dayNight = new DayNight(this)` (Game.js:100)
8. `this.particles = new Particles(this.scene)` (Game.js:101)
9. `this.mobSpawner = new MobSpawner(this)` (Game.js:102)
10. `if (savedMeta)`: `world.time = savedMeta.worldTime ?? 0`; `dayNight.deserialize(savedMeta.weather)`; `player.deserialize(savedMeta.player)` (Game.js:104–108)
11. `this.setState(STATE.LOADING)` (Game.js:110)
12. `await new Promise(resolve => { this.chunkManager.onReady = resolve; this.chunkManager.initWorkers(seedString); })` (Game.js:111–114) — resolves with `msg.worldSpawn` from the first `'ready'` worker message (ChunkManager.js:49–54, guarded by `if (!this.worldSpawn)` so only the first of `WORKER_COUNT = 2` workers resolves)
13. `this.worldSpawn = spawn` (Game.js:115)
14. `if (!savedMeta)`: `player.setPos(spawn.x, spawn.y, spawn.z)` and `prevPos.{x,y,z} = spawn.{x,y,z}` (Game.js:116–119)

`startWorld` is only reached via `main.js`'s local `startWorld(seed, meta)` wrapper (main.js:51–59), which shows the loading menu and wraps in `try/catch` → `console.error('world start failed', err); game.setState(STATE.TITLE)`.

Entry points: `onNewWorld` (main.js:63–68) → `await save.deleteWorld(); await save.open();` then seed = `seedInput || String(Date.now() >>> 0)`, `startWorld(seed, null)`. `onContinue` (main.js:69–72) → `const meta = save.meta; if (meta) await startWorld(meta.seed, meta)`.

### `disposeWorld()` (Game.js:122–134)
```js
disposeWorld() {
  if (this.chunkManager) {
    this.chunkManager.dispose();
    for (const chunk of this.world.chunks.values()) this.chunkManager.disposeChunkMeshes(chunk);
  }
  if (this.entities) {
    for (const e of [...this.entities.entities.values()]) this.entities.remove(e);
  }
  this.dayNight?.dispose?.();
  this.particles?.dispose?.();
  this.world = null;
  this.player = null;
}
```
`chunkManager.dispose()` (ChunkManager.js:43–46) only terminates workers and clears `this.workers`. It does **not** clear `remeshQueue`, `pending`, `requestList`, `retries`, or `worldSpawn`.

**Nulled**: `world`, `player` only.
**Left dangling (stale, non-null)**: `chunkManager`, `entities`, `interaction`, `dayNight`, `particles`, `mobSpawner`, `worldSpawn`, `sleeping`.

### 10.1 — Second `disposeWorld()` throws: Save & Quit → Continue is broken in-session
`disposeWorld` guards on `this.chunkManager` (Game.js:123) but dereferences `this.world.chunks` (Game.js:125), and it never nulls `chunkManager`. Sequence:
1. `onQuit` (main.js:85–89): `await save.saveAll(game); game.disposeWorld();` → `world = null`, `chunkManager` still set → `setState(STATE.TITLE)`.
2. User clicks Continue or New Game → `main.js startWorld` → `game.startWorld(...)` → **`this.disposeWorld()` at Game.js:89** → `if (this.chunkManager)` is **true** → `this.chunkManager.dispose()` OK → `for (const chunk of this.world.chunks.values())` → **`TypeError: Cannot read properties of null (reading 'chunks')`**.
3. Caught by main.js:54–58 → `console.error('world start failed', err)` → `setState(STATE.TITLE)`.

Net effect: after a Save & Quit, no world can be started again without a page reload. The first-ever `startWorld` is unaffected (`chunkManager` is `null` from the constructor, Game.js:66).

### 10.2 — `fireOrigins` is not cleared on world dispose
`clearFireOrigins()` is exported (fire.js:31) and has **zero call sites** in `src/` (grep). `disposeWorld` does not call it. `forgetFireInChunk` only runs on chunk unload (Game.js:739). Origins from a disposed world survive into the next `startWorld` and count against `MAX_ACTIVE (512)`.

### 10.3 — `worldSpawn` lives on two objects
`Game.worldSpawn` (Game.js:115) and `ChunkManager.worldSpawn` (ChunkManager.js:27, set at ChunkManager.js:51). The `if (!this.worldSpawn)` guard in `onWorkerMessage` is on the ChunkManager's copy. Since `startWorld` constructs a fresh `ChunkManager` each time, the guard resets per world.

---

## 11. Extension points

**Game hooks called by other modules** (assign or override on the instance):
| Hook | Caller | Signature |
|---|---|---|
| `game.ui.*` | Game.js, all `?.`-guarded | `{ hud, menus, containers, debug, toast, setSleepFade, setLoadingProgress, onStateChange }` |
| `game.onContainerOpened` | containers.js:176 | `() => void` |
| `game.onContainerClosed` | containers.js:210 (skipped when `silent`) | `() => void` |
| `game.closeContainerScreen` | containers.js:674 (distance > 8 or block gone) | `() => void` |
| `game.onChunkGenerated` | ChunkManager.js:79 | `(chunk)` |
| `game.onChunkHydrated` | ChunkManager.js:120 | `(chunk, record)` |
| `game.onChunkUnloading` | ChunkManager.js:226 | `(chunk)` |
| `game.onPlayerHurt` | Game.js:807 → `ui.hud.onDamage()` | `()` |
| `game.onPlayerDeath` | Player.js:656 | `()` |
| `world.game` | Player.js:641, 662 | back-reference set at Game.js:91 |
| `audio.game` | main.js:40 | back-reference |

**UI contract that `Game` requires** (all optional-chained, so partial UIs are legal): `ui.onStateChange(next, prev)`, `ui.setLoadingProgress(m, n)`, `ui.setSleepFade(on)`, `ui.toast(msg)`, `ui.hud.update()`, `ui.hud.onDamage()`, `ui.debug.update()`, `ui.containers.open(kind,x,y,z)`, `ui.containers.tickOpen()`.

**Audio contract Game requires**: `audio.tick()`, `audio.updateFrame(camera|null)`, `audio.debug.budgetMs`, `audio.music.arm(seedString)`, `audio.music.disarm()`, `audio.ambience.silence()`. Plus, from main.js: `audio.boot()`, `audio.setOptions(opts)`, `audio.unlock()`, `audio.onPause()`, `audio.onResume()`, `audio.ctx`, `audio.buses.music`.

**Options read by Game**: `options.mouseSensitivity` — clamped `Math.min(3, Math.max(0.1, ?? 1))` (Game.js:291), rate `0.15 * PI/180 * sens` per mouse count; `options.viewBobbing === false` → zeroes the bob offset but **not** `bobPhase`, which stays deterministic tick state (comment Game.js:311–312, code Game.js:315).

**Block-entity extension**: `getBlockEntity(x,y,z)` (Game.js:455–470) lazily creates from `BLOCKS[id].blockEntity`, index `i = (y << 8) | ((z & 15) << 4) | (x & 15)`. Two kinds only: `'chest'` → `{ type:'chest', data:{ slots: new Array(27).fill(null) } }`; anything else → `{ type:'furnace', data:{ slots:new Array(3).fill(null), burn:0, fuelTotal:0, cook:0, xpBank:0 } }` (Game.js:463–465) — the furnace shape is the **else** branch, so an unrecognized `blockEntity` string silently yields a furnace. `tickBlockEntities` (Game.js:472–486) scans `SIM_RADIUS = 6` chunks around `world.playerChunk`, skipping chunks with `state < ChunkState.GENERATED` or `blockEntities.size === 0`, and ticks **only** `be.type === 'furnace'` (Game.js:480). Furnace timings (Game.js:489–527): cook completes at `f.cook >= 200`, cooldown `f.cook = Math.max(0, f.cook - 2)`, lava bucket → `{ id: idOf('bucket'), count: 1 }` rather than decrement.

**Spawn helpers**: `spawnItemById(id, count, x, y, z, vel)` (guards `!ITEMS.has(id) || count <= 0`, default vel `(r()-0.5)*0.2, 0.2, (r()-0.5)*0.2`, lifetime arg `10`), `spawnItemByName(name, count, x, y, z, vel)` (try/catch → `console.warn('[game] unknown item drop', name)`), `dropStackAt(stack, x, y, z)` (lifetime `40`, vel spread `0.4`), `throwStack(stack)` (from eye − 0.3, `d * 0.3` + jitter, lifetime `40`), `spawnXpOrb(x,y,z,value)`, `spawnArrow(x,y,z,vx,vy,vz,owner,opts)`, `spawnThrown(kind,x,y,z,vx,vy,vz,owner)`, `spawnFallingBlock(id,x,y,z)` (offsets to `x+0.5, y, z+0.5`), `spawnMobAt(type,x,y,z,opts = {})`.

---

## 12. Other observations

- **Unused imports in Game.js**: `AUTOSAVE_INTERVAL` (Game.js:4), `blockByName`, `FACING_DIR` (Game.js:6), `lerpAngle` (Game.js:23) — each appears exactly once in the file, on its import line. `AUTOSAVE_INTERVAL` is genuinely owned by saveManager.js:2.
- **`NEUTRAL_FRAME` is shared mutable state** (Game.js:34–38). Its `pressed: new Set()` is one instance passed to `player.tick()`/`interaction.tick()` on every non-PLAYING tick. Nothing currently writes to it, but a consumer that did would corrupt all future neutral frames.
- **`snapPlayerToGround()`** (Game.js:235–245) scans `y = 127 → 0` for the first `BLOCKS[...].collidable`, then `if (p.pos.y < y + 1) p.setPos(p.pos.x, y+1, p.pos.z)` — it only ever raises the player, never lowers. `p.prevPos.y = p.pos.y` afterward. If the column is entirely non-collidable the loop completes with no `setPos`.
- **`updateViewmodel` switch-anim decrement is alpha-dependent**: `if (vm.switchAnim > 0) vm.switchAnim -= alpha < 0.01 ? 1 : 0;` (Game.js:410). This is render code decrementing on the condition `alpha < 0.01`, i.e. only on frames that land within 0.5 ms of a tick boundary. At high FPS the 3-count (`vm.switchAnim = 3`, Game.js:408) drains erratically; at low FPS it may never hit the condition and the `drop = 0.3` offset (Game.js:415) sticks.
- **`updateCrack` allocates a throwaway `BoxGeometry` per stage change**: `const base = new THREE.BoxGeometry(1, 1, 1).attributes.uv;` (Game.js:373) — created inside the `stage !== this.crackStage` branch and never `.dispose()`d.
- **`crackMesh` is never removed on `disposeWorld`** — it is added to `this.scene` (Game.js:366) and `disposeWorld` does not touch it; `selectionBox` likewise re-adds itself lazily via `if (!this.selectionBox.parent) this.scene.add(this.selectionBox)` (Game.js:344). Since `this.scene` outlives worlds, both persist across `startWorld` calls (mostly benign — `selectionBox` re-parents fine).
- **`trySleep`** (Game.js:763–779) sets `p.spawnPoint = { x, y, z }` **unconditionally on click**, before any of the night/monster checks (Game.js:765). Hostile check box is asymmetric: `new AABB(x-8, y-5, z-8, x+9, y+6, z+9)` (Game.js:771). `tickSleep` (Game.js:781–788) fires `dayNight.sleepSkip()` at `++this.sleeping.ticks >= 100` (5 s).
- **Sleeping suppresses pause**: `input.onLockChange` checks `&& !game.sleeping` (main.js:168), and `applyMouseLook` early-outs on `this.sleeping` (Game.js:283).
- **`respawnPlayer`** (Game.js:816–820) calls `player.respawn(this.worldSpawn)` → `setState(STATE.PLAYING)` → `input.requestLock()`. `Player.respawn` (Player.js:659–678) tries `validateBedSpawn(spawnPoint)` first and toasts `'You have no home bed, or it was obstructed'` on failure, falling back to `worldSpawn`. It resets `yaw = 0; pitch = 0` but **does not reset `prevYaw`/`prevPitch`**, so the first post-respawn frame interpolates from the old angle.
- **`validateBedSpawn(sp)`** (Game.js:790–803) requires `w.getBlock(sp.x, sp.y, sp.z) === B.BED_BLOCK`, then tries offsets `[[0,0],[1,0],[-1,0],[0,1],[0,-1]]` returning `{ x: x+0.5, y: sp.y, z: z+0.5 }` for the first spot where both feet and head blocks are non-collidable; else `null`.
- **F4 gamemode toggle lives in main.js**, not Game (main.js:143–147): flips `p.gameMode` between `'survival'` and `'debugCreative'`, forces `p.flying = false` on return to survival, toasts, and refreshes palette visibility. It is not gated on game state — F4 during LOADING or DEAD will toggle (guarded only by `game.player` truthiness).
- **`menus.setPaletteVisible`** is called from two places with the same predicate (main.js:120–121 and main.js:147); they must stay in sync manually.
- **`emitSound`/`startLoop`/`at`** are imported from `./audio/engine.js` (Game.js:31) and used directly in `explode` (Game.js:625) and `igniteTnt` (Game.js:687) — Game bypasses `this.audio` for these, so they are not null-safe the way `this.audio?.*` is.


<!-- ===== aef4a5507336c2521 ===== -->
# World Subsystem Integration Map

`/Users/jakevolkanovski/Desktop/ClaudeCraft/src/world/` — World.js, ChunkManager.js, LightEngine.js, fluids.js, fire.js, raycast.js (+ Chunk.js, scheduledTicks.js, constants.js, registry/blocks.js as load-bearing dependencies).

---

## 1. Chunk data layout

`Chunk` — `/Users/jakevolkanovski/Desktop/ClaudeCraft/src/world/Chunk.js:13`. A chunk is 16×128×16 = **32768** cells (`CHUNK_CELLS`, `constants.js:15`).

| Field | Type | Set at | Cite |
|---|---|---|---|
| `blocks` | `Uint8Array(32768)` | `install()` | Chunk.js:18 |
| `states` | `Uint8Array(32768)` | `install()` | Chunk.js:19 |
| `skyLight` | `Uint8Array(32768)` 0–15 | `install()` | Chunk.js:20 |
| `blockLight` | `Uint8Array(32768)` 0–15 | `install()` | Chunk.js:21 |
| `heightMap` | `Uint8Array(256)`, `(z<<4)\|x` → y+1 of top sky-terminating block | worker / rehydrate scan | Chunk.js:22 |
| `biomes` | `Uint8Array(256)` | `install()` | Chunk.js:23 |
| `blockEntities` | `Map<blockIndex, {type,data}>` | — | Chunk.js:27 |
| `entities` | `Set` (feet-in-chunk) | — | Chunk.js:28 |
| `key` | `cx + ',' + cz` | ctor | Chunk.js:17 |
| `state` | `ChunkState` | ctor / `install` / `initialLight` / `buildChunk` | Chunk.js:24 |
| `modified` | bool — differs from generator output → must save | Chunk.js:26 |
| `minY`/`maxY` | tight Y bounds from last mesh | 0 / 127 | Chunk.js:31-32 |

**Indexing is Y-major:** `i = (y << 8) | (z << 4) | x`, `blockIndex` at `constants.js:18`. Note `blockIndex` does **not** mask x/z, so it is only valid on chunk-local coords. Every World/LightEngine accessor inlines the masked world-coord form `(y << 8) | ((z & 15) << 4) | (x & 15)` instead (World.js:53, 60, 68, 75, 105, 182; LightEngine.js:93, 100, 114). Inverse: `x = i & 15`, `y = i >> 8`, `z = (i >> 4) & 15` (World.js:336).

**`blockIndex` is imported into World.js:3 and never used** — dead import.

```js
install(blocks, heightMap, biomes, states = null)   // Chunk.js:37
```
`states`/`skyLight`/`blockLight` are freshly zeroed when omitted (Chunk.js:39-41). The worker path calls `install(msg.blocks, msg.heightMap, msg.biomes)` with **no states** (ChunkManager.js:77) — so **worldgen never emits any state byte, and never bit 7**. The save path passes states explicitly (ChunkManager.js:114). This is exactly the invariant `LightEngine.js:52-54` relies on.

**`ChunkState`** — `Chunk.js:5`: `REQUESTED: 0, GENERATED: 1, LIT: 2, MESHED: 3, FAILED: -1`. Promotion `REQUESTED → GENERATED` (`install`, Chunk.js:44) → `LIT` (`initialLight`, LightEngine.js:252) → `MESHED` (`buildChunk`, ChunkManager.js:322). `FAILED` set after two worker errors (ChunkManager.js:66).

**Read gate:** `World.getChunkAt` returns a chunk only at `state >= ChunkState.GENERATED` (World.js:40); `LightEngine.chunkAt` uses the identical gate (LightEngine.js:80). Both keep an independent **1-entry cache** invalidated by `world.chunkVersion` (World.js:36-43, LightEngine.js:76-83). `chunkVersion` bumps only on chunk add (ChunkManager.js:141) and remove (ChunkManager.js:229).

---

## 2. The bit-7 waterlogged contract

Frozen contract text: `registry/blocks.js:20-37`. Constants:

```js
export const WATERLOGGED = 0x80;      // blocks.js:38
export const STATE_NIBBLE = 0x0F;     // blocks.js:39
```
Bits 0–3 = per-block nibble; **bits 4–6 are free/unused** (blocks.js:24). Predicates (blocks.js:42-50):
```js
export const isWaterCellAt   = (id, state) => id === B.WATER || (state & WATERLOGGED) !== 0;
export const isWaterSourceAt = (id, state) => (id === B.WATER && (state & STATE_NIBBLE) === 0) || (state & WATERLOGGED) !== 0;
export const effFireEnc  = (id, state) => ((state & WATERLOGGED) ? 0 : (BLOCKS[id]?.fireEnc  ?? 0));
export const effFireBurn = (id, state) => ((state & WATERLOGGED) ? 0 : (BLOCKS[id]?.fireBurn ?? 0));
```
**The complete waterloggable set is 3 blocks** — `oak_fence`, `ladder`, `chest` (blocks.js:783). Ids: chest 37 (blocks.js:429), ladder 39 (blocks.js:452), oak_fence 52 (blocks.js:541). Leaves are a documented deviation (blocks.js:781-782).

World-level API (World.js:200-224):
```js
isWaterCell(x, y, z)                 // World.js:203
isWaterSource(x, y, z)               // World.js:208
setWaterlogged(x, y, z, on)          // World.js:217 — returns false if !waterloggable or no-op; else routes to setBlock({state: next, byPlayer: true})
clearedCell(x, y, z)                 // World.js:276 — {id: B.WATER, state: 0} if bit7 else {id: B.AIR, state: 0}
```

**Enforcement points:**
- `setBlock` **clears bit 7 for every non-waterloggable id**: `if (!BLOCKS[id]?.waterloggable) state &= ~WATERLOGGED;` (World.js:111) — runs *before* the no-op check at World.js:112.
- `setState` **refuses to half-apply** a bit-7 toggle: an XOR test reroutes to `setBlock` (World.js:188-191). Bare nibble writes (fire age, crop stage) fall through and skip light + neighbor updates by design (World.js:184-187).
- Every erase path goes through `clearedCell` — `popBlock` (World.js:291) and `removeBlock` (World.js:300).
- Light: effective opacity = `max(opacity(id), bit7 ? 1 : 0)` — `LightEngine.opacity` (LightEngine.js:116) and `onBlockChanged` (LightEngine.js:269-270).
- Heightmap: `terminatesSky(id, state)` returns true on any bit-7 cell (LightEngine.js:56).
- Fluids: `strength()` returns 8 for any bit-7 cell on the water track (fluids.js:32); `isSource(state)` masks `STATE_NIBBLE` (fluids.js:23).
- Fire: bit-7 cells are inert fuel via `effFireEnc`/`effFireBurn` (fire.js:65, 80, 166) and excluded from lava ignition (fire.js:307, 319).

**Contract violation / fragility — `raycast.js:25`:** `world.getState(x, y, z) === 0` is a bare, unmasked state test for "fluid source", which blocks.js:33-34 explicitly names as WRONG. It is *currently* safe only because water (id 63) is not waterloggable so bit 7 is always cleared there — but it is the one file in this set that does not mask. Also note `fluidMode` does **not** stop at waterlogged cells even though they are water sources per §11.1.

---

## 3. `setBlock` — the write chokepoint

```js
setBlock(x, y, z, id, { state = 0, byPlayer = false, noUpdates = false } = {})   // World.js:101
```
Returns `false` on: `y < 0 || y > MAX_Y` (World.js:102), unloaded/ungenerated chunk (World.js:104), or exact no-op `old === id && oldState === state` (World.js:112). **Everything else in the engine funnels through here.**

Exact ordering:

| # | Step | Cite |
|---|---|---|
| 1 | Bounds + chunk gate | World.js:102-104 |
| 2 | Read `old`, `oldState` | World.js:106-107 |
| 3 | **Bit-7 clear** for non-waterloggable id | World.js:111 |
| 4 | No-op bail | World.js:112 |
| 5 | Compute `waterlogFlip = (oldState & WATERLOGGED) !== (state & WATERLOGGED)` | World.js:117 |
| 6 | Write `blocks[i]`, `states[i]`, set `chunk.modified = true` | World.js:119-121 |
| 7 | **`if (old === B.FIRE && id !== B.FIRE) forgetFire(x,y,z)`** | World.js:130 |
| 8 | Block-entity spill when `oldBlock.blockEntity !== newBlock.blockEntity` → `game.spillBlockEntity` + `blockEntities.delete(i)` | World.js:133-139 |
| 9 | **Synchronous relight** iff `old !== id \|\| waterlogFlip` → `light.onBlockChanged(x,y,z,old,id,oldState,state)` | World.js:144-146 |
| 10 | `collectDirtyKeys` → `chunkManager.markDirty(k)` for each; **`if (byPlayer) chunkManager.rebuildNow(keys)`** | World.js:149-153 |
| 11 | *(if `!noUpdates`)* `oldBlock.onBroken?.` then `newBlock.onPlaced?.` — only when `old !== id` | World.js:156-159 |
| 12 | `if (newBlock.fluid) fluids.schedule(x,y,z,newBlock.fluid)` | World.js:161 |
| 13 | `if (state & WATERLOGGED) fluids.schedule(x,y,z,'water')` | World.js:164 |
| 14 | `if (newBlock.gravity) checkFall(x,y,z)` | World.js:165 |
| 15 | `neighborUpdates(x,y,z)` | World.js:166 |

Notes for integrators:
- Step 9's guard is `old !== id || waterlogFlip` — **a pure nibble change through `setBlock` does no light work** but *does* still run steps 10–15.
- Step 11 is gated on `old !== id`; **a state-only `setBlock` fires neither `onBroken` nor `onPlaced`, but still fires `neighborUpdates`.**
- `noUpdates: true` skips 11–15 but *not* the relight or remesh.
- `byPlayer: true` forces a **synchronous** mesh rebuild of every dirty key (World.js:152 → ChunkManager.js:256). `setState`'s bit-7 reroute (World.js:190) and `setWaterlogged` (World.js:223) both pass `byPlayer: true`.
- **`setBlock` throws on an unregistered id.** World.js:111 uses `BLOCKS[id]?.waterloggable` (optional-chained), but World.js:114 `const newBlock = BLOCKS[id]` is then dereferenced unguarded at World.js:133 (`newBlock.blockEntity`) → TypeError.
- **Re-entrancy is safe by ordering, not by lock.** `light.dirtied` is a single shared `Set` (LightEngine.js:65) cleared at the top of both `initialLight` (LightEngine.js:193) and `onBlockChanged` (LightEngine.js:266). `setBlock` copies it into a fresh Set at step 10 (`collectDirtyKeys`, World.js:238) *before* any hook at steps 11–15 can re-enter `setBlock`. Any new code that holds the returned `dirtied` Set across a nested write will observe it cleared.
- **`neighborUpdates` → `setBlock` recursion is unbounded** — no depth counter or work queue exists.

```js
setState(x, y, z, state, opts)   // World.js:178 — opts.noRemesh skips remesh dirtying
```
Returns false on bounds, missing chunk, or identical state (World.js:179-183). Bit-7 XOR reroutes to `setBlock` (World.js:188-191). Otherwise writes `states[i]`, sets `modified`, and dirties remesh keys unless `opts.noRemesh` (World.js:192-196). **`setState` never touches light and never fires neighbor updates.** Sole `noRemesh: true` caller is fire aging (fire.js:227).

---

## 4. Neighbor-update fan-out

```js
neighborUpdates(x, y, z)   // World.js:242
```
Iterates `DIRS6 = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]` (World.js:11) — **6 face neighbors, no diagonals, and never the source cell itself.**

Per neighbor (World.js:243-256):
1. Skip if `ny < 0 || ny > MAX_Y` (World.js:245).
2. **Skip if `nId === B.AIR`** (World.js:247) — air cells never receive `neighborUpdate`.
3. `nBlk.neighborUpdate?.(this, nx, ny, nz, this.getState(nx, ny, nz))` (World.js:249).
4. `if (nBlk.fluid || (this.getState(nx,ny,nz) & WATERLOGGED)) this.fluids.wake(nx, ny, nz)` (World.js:254).
5. `if (nBlk.gravity) this.checkFall(nx, ny, nz)` (World.js:255).

**Remesh fan-out is separate** — `collectDirtyKeys(chunk, x, z, extra)` (World.js:226): own chunk key, plus the `lx===0/15`, `lz===0/15` border neighbors, plus the 4 corner diagonals, plus every key in `extra` (the light-dirtied set). World.js:228-239.

`checkFall(x, y, z)` (World.js:260): no-op at `y <= 0`; returns if `BLOCKS[below].collidable`; returns if `!BLOCKS[id].gravity`; else `setBlock(x,y,z,B.AIR)` + `game.spawnFallingBlock(id,x,y,z)`.

---

## 5. Tick surface

**Driver order inside `Game.tick()`** (`/Users/jakevolkanovski/Desktop/ClaudeCraft/src/Game.js:187`), all gated on `state !== STATE.LOADING`:
```
player.tick → interaction.tick → entities.tick
→ world.scheduled.run()        // Game.js:199
→ world.randomTicks()          // Game.js:200
→ dayNight.tick()              // Game.js:201  ← this is where world.time++ happens
→ mobSpawner.tick()
chunkManager.tick(px, pz)      // Game.js:204 — runs even during LOADING
```
**`world.time` is incremented by `DayNight.tick()` at `src/env/DayNight.js:133`, i.e. *after* `scheduled.run()` in the same tick.** `skyDarken` is recomputed on the next line (DayNight.js:134).

### Scheduled ticks
`ScheduledTicks` — `scheduledTicks.js:5`. Bucket queue: `buckets: Map<dueTick, {keys: Set<string>, arr: number[]}>` (scheduledTicks.js:8).
```js
schedule(x, y, z, delayTicks)   // scheduledTicks.js:11
run()                           // scheduledTicks.js:21
clear()                         // scheduledTicks.js:42 — nothing is persisted across save/load
```
- `due = world.time + Math.max(1, delayTicks | 0)` — **minimum delay is 1 tick; delay 0 becomes 1** (scheduledTicks.js:12).
- Dedup by string key `x+','+y+','+z` per bucket; a second schedule for the same due tick is dropped (scheduledTicks.js:15-17). **Different due ticks are not deduped** — one cell can hold many pending entries.
- `run()` processes only the exact bucket `buckets.get(world.time)` and deletes it (scheduledTicks.js:23-25). A bucket whose due tick is skipped is never drained.
- **Sim-radius deferral:** if chebyshev chunk distance from `world.playerChunk` exceeds `SIM_RADIUS` (6), the tick is **rescheduled +40 and not run** (scheduledTicks.js:31-32).
- Dispatch → `world.blockTick(x, y, z)` (scheduledTicks.js:36).

`World.scheduleTick(x, y, z, delay)` (World.js:306) is the thin facade.

### `blockTick` — the scheduled-tick dispatch chokepoint
```js
blockTick(x, y, z)   // World.js:308
```
```js
if (id === B.AIR) return;                                    // World.js:310
if (blk.fluid || (state & WATERLOGGED)) this.fluids.step(x, y, z);   // World.js:318
else blk.scheduledTick?.(this, x, y, z, state);              // World.js:319
```
**Latent constraint:** the fluid branch **shadows `scheduledTick` for any waterlogged cell**. World.js:315-317 asserts this is safe because "a waterloggable block has no scheduledTick of its own" — true today (chest/ladder/oak_fence declare none). **Any new waterloggable block with a `scheduledTick` will silently never receive it while waterlogged.**

### Random ticks
```js
randomTicks()   // World.js:323
```
- No-op if `playerChunk` is null (World.js:324).
- Iterates `dcx,dcz ∈ [-SIM_RADIUS, +SIM_RADIUS]` = **13×13 = 169 chunks** (`SIM_RADIUS = 6`, constants.js:24), skipping chunks below `GENERATED` (World.js:329).
- **24 cells per chunk per tick** (World.js:330) → **4056 draws/tick from the seeded stream**.
- `const i = (this.rng() * 32768) | 0;` (World.js:331) — one `world.rng` draw per attempt, **taken whether or not the block has a `randomTick`**.
- Skips `B.AIR` and blocks with no `randomTick` (World.js:332-335).
- Calls `blk.randomTick(this, x, y, z, c.states[i])` (World.js:337).

`world.rng` is seeded `mulberry32(xmur3('world:' + seedString))` (World.js:27-28). **fire.js deliberately uses `Math.random()` everywhere** to avoid consuming from this shared stream and desyncing weather/worldgen — fire.js:4-7, `randInt` at fire.js:44.

---

## 6. LightEngine

Two channels: `SKY = 0`, `BLOCK = 1` (LightEngine.js:8, re-exported LightEngine.js:334). `DIRS` at LightEngine.js:9; `DOWN = 3` indexes `[0,-1,0]` (LightEngine.js:10).

**`Queue4`** (LightEngine.js:13) — flat `Int32Array` ring, 4 lanes/node `(x, y, z, level)`, default cap `1 << 14` nodes = 65536 int32s. `push` compacts when `head >= a.length >> 1` else doubles (LightEngine.js:21-31). `length` is `(tail - head) / 4` (LightEngine.js:19).

Engine state: `propQ = [Queue4, Queue4]`, `unlightQ = [Queue4, Queue4]`, `dirtied = Set`, `node = Int32Array(4)` scratch (LightEngine.js:63-66).

### Budget
`LIGHT_NODE_BUDGET = 100_000` — `constants.js:39`, "safety valve per onBlockChanged".
- `propagate` guard: `if (++guard > LIGHT_NODE_BUDGET * 4)` = **400,000 popped nodes** → `console.warn('[light] propagate guard hit')`, `q.clear()`, break (LightEngine.js:154).
- `removeLight` guard: `if (++guard > LIGHT_NODE_BUDGET)` = **100,000** → `console.warn('[light] remove guard hit')`, `uq.clear()`, break — **then `propagate(channel)` still runs** (LightEngine.js:185-187).
- Both guards are **per-call locals**, reset every invocation. There is **no cross-call or per-tick light budget** — an N-block edit does N unbudgeted floods.

### Methods
```js
terminatesSky(id, state = 0)                                    // LightEngine.js:55  (module export)
chunkAt(x, z)                                                   // LightEngine.js:73
getLightArr(channel, c)                                         // LightEngine.js:86
light(channel, x, y, z)                                         // LightEngine.js:88
setLight(channel, x, y, z, v)                                   // LightEngine.js:96
opacity(x, y, z)                                                // LightEngine.js:109
markDirty(c, x, z)                                              // LightEngine.js:119
propagate(channel)                                              // LightEngine.js:131
removeLight(channel, x, y, z)                                   // LightEngine.js:160
initialLight(chunk)                                             // LightEngine.js:192
onBlockChanged(x, y, z, oldId, newId, oldState = 0, newState = 0) // LightEngine.js:265
getLight(x, y, z)                                               // LightEngine.js:329 → {sky, block}
```

`terminatesSky` (LightEngine.js:55-58): `true` if bit 7; else `BLOCKS[id].opacity > 0 || id === B.SNOW_LAYER || id === B.CACTUS`. Header comment LightEngine.js:50-52 records that **the spec's `BLOCKS[id].skyOpacity` field does not exist in this codebase** — `terminatesSky` *is* the heightmap predicate.

`opacity` (LightEngine.js:109-117): `y < 0 → 15`; `y > MAX_Y → 0`; **unloaded chunk → 15 (BFS wall)**; else `(states[i] & WATERLOGGED) ? Math.max(o, 1) : o`.

`light` out-of-range: `y > MAX_Y` → 15 for SKY, 0 for BLOCK; `y < 0` → 0; missing chunk → 0 (LightEngine.js:89-92). `setLight` **silently drops writes** into missing/ungenerated chunks, returning `false` (LightEngine.js:99).

`markDirty` (LightEngine.js:119-127) adds the owning chunk key plus **edge-adjacent chunks only** (`lx===0`/`15`, `lz===0`/`15`) — **note this uses `else if`, so it adds at most one X-neighbor and one Z-neighbor and never a corner diagonal**, unlike `World.collectDirtyKeys` (World.js:234-237) which does add all 4 corners.

`propagate` (LightEngine.js:131-156):
- **Re-reads `L` from the array** (`const L = this.light(channel, x, y, z)`, LightEngine.js:138) — **the queued level lane `n[3]` is written by every `push` but discarded here.** Only `removeLight` consumes `n[3]` (LightEngine.js:170).
- `if (L <= 1 && channel === BLOCK) continue;` — block light 1 does not propagate (LightEngine.js:139).
- `if (o >= 15) continue;` — opaque wall (LightEngine.js:146).
- **Rule 3 sky shortcut:** `if (channel === SKY && d === DOWN && L === 15 && o === 0) newL = 15;` else `newL = L - Math.max(1, o)` (LightEngine.js:148-149). A waterlogged cell has effective opacity ≥ 1, so the shortcut fails for it automatically — same as plain water (LightEngine.js:105-108).

`removeLight` (LightEngine.js:160-188) — two-queue unlight. Descent test:
```js
const descended = nL < L || (channel === SKY && d === DOWN && L === 15 && nL === 15);   // LightEngine.js:177-178
```
Non-descended neighbors are pushed to `propQ` as refill frontier (LightEngine.js:182). Ends with `this.propagate(channel)` (LightEngine.js:187).

`initialLight(chunk)` (LightEngine.js:192-254) — 5 phases, returns `this.dirtied`, sets `chunk.state = ChunkState.LIT` (LightEngine.js:252):
1. Column seed: `skyLight = 15` from `MAX_Y` down to `heightMap[col]` (LightEngine.js:200-205).
2. Sky frontier: for each column, push level-15 nodes for `y ∈ [H, hMax)` where `hMax` = max heightTop of the 4 horizontal neighbors (LightEngine.js:208-219).
3. Emitters: full 32768 scan, `chunk.blockLight[i] = em` + push (LightEngine.js:222-228).
4. Border import: 4×16 columns from neighbors **at `state >= ChunkState.LIT` only**, pushing every `y ∈ [0, MAX_Y]` with light `>= 2` (LightEngine.js:231-246).
5. `propagate(SKY)` then `propagate(BLOCK)` (LightEngine.js:249-250).

`onBlockChanged` (LightEngine.js:265-327) — **`oldState`/`newState` are REQUIRED for bit-7 correctness** (LightEngine.js:258-263 records the prior bug: a waterlog toggle compared `oldB === newB`, every opacity test read false, and it did no light work at all).
- Effective opacities folded at LightEngine.js:269-270.
- Returns `this.dirtied` early if chunk missing (LightEngine.js:272).
- **Heightmap maintenance** (LightEngine.js:277-287): raise if `terminatesSky(newId,newState) && y+1 > oldH`; if `y+1 === oldH` and no longer terminating, **downward rescan from `y` to 0**, `newH = 0` if none.
- BLOCK channel: remove if `oldB.emission > 0 || (newO > 0 && light(BLOCK) > 0)` (LightEngine.js:290-292); seed new emitter if brighter (LightEngine.js:293-298); if `newO < oldO`, push all 6 neighbors with `l > 1` (LightEngine.js:299-304); `propagate(BLOCK)` (LightEngine.js:305).
- SKY channel: `newO > oldO` → `removeLight(SKY, x, y, z)` (LightEngine.js:309). `newO < oldO` → if the column opened (`newH < oldH && y+1 === oldH`) set 15 directly for `yy ∈ [newH, oldH-1]` and push (LightEngine.js:311-316); else push the 6 neighbors with `l > 0` (LightEngine.js:318-321); then `propagate(SKY)` (LightEngine.js:323). **When `newO === oldO`, the SKY channel does nothing at all** — no `propagate(SKY)` is called on that path.

`World.internalLight(x,y,z) = Math.max(getBlockLight, getSkyLight - skyDarken)` (World.js:80). `skyDarken` is an int 0–11 owned by DayNight (World.js:20, DayNight.js:128/134).

---

## 7. Fluids

`fluids.js` — water/lava CA on scheduled ticks. State nibble: **bit3 (`FALLING = 8`, fluids.js:18) = falling; bits 0–2 = spread; source = nibble 0.** Effective strength `S = 8 − spread`; source/falling = 8 (fluids.js:2-3).

```js
export const FLUID_INTERVAL = { water: 5, lava: 30 };   // fluids.js:13
const FLUID_DROP = { water: 1, lava: 2 };               // fluids.js:14
const H4 = [[1,0],[-1,0],[0,1],[0,-1]];                 // fluids.js:16
function isSource(state) { return (state & STATE_NIBBLE) === 0; }   // fluids.js:23
```

Class `Fluids` (fluids.js:25), constructed at `World.js:26` as `world.fluids`:
```js
strength(id, state, fluid)          // fluids.js:31
canReplace(id)                      // fluids.js:41
schedule(x, y, z, fluid)            // fluids.js:50 → world.scheduleTick(x,y,z, FLUID_INTERVAL[fluid])
wake(x, y, z)                       // fluids.js:54
wakeNeighbors(x, y, z)              // fluids.js:64 — 6 faces
setFluid(x, y, z, fluidId, state)   // fluids.js:71
interact(x, y, z, incomingId, existingId)   // fluids.js:90 → bool "handled"
checkInteractions(x, y, z)          // fluids.js:107
step(x, y, z)                       // fluids.js:137 — the per-tick entry point
```

`strength` (fluids.js:31-39): **water + bit 7 → 8 unconditionally, whatever the id**; else `blk.fluid !== fluid → 0`; `isSource → 8`; `state & FALLING → 8`; else `8 - (state & 7)`.

`canReplace` (fluids.js:41-48): `AIR` and `FIRE` → true; `LADDER` → **false (ladders dam fluids)**; else `!blk.collidable && !blk.fluid && blk.shape !== 'none'` (fluid-destructible → pops with drops).

`wake` (fluids.js:54-62): schedules by `blk.fluid`, **else schedules `'water'` if the cell carries bit 7**.

`setFluid` (fluids.js:71-87): if occupied by a different id — opposite fluid → `interact()` (return if handled); `canReplace` → `popBlock`; else **return without writing**. Then `setBlock(x,y,z,fluidId,{state})` + `schedule`.

`interact` (fluids.js:90-104): lava existing + water incoming → `isSource(exState) ? B.OBSIDIAN : B.COBBLESTONE`; water existing + lava incoming → `B.STONE`. Both `emitQuench` (fluids.js:8-11: `block.extinguish` + `block.place.stone`).

`checkInteractions` (fluids.js:107-134): scans 5 neighbors — `[0,1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]` — **`[0,-1,0]` (below) is deliberately absent**. Lava touched by any `isWaterCellAt` neighbor converts **the lava cell** to OBSIDIAN/COBBLESTONE by its own `isSource(state)`; the waterlogged block itself is never written (fluids.js:114-119).

`step(x, y, z)` (fluids.js:137-241):
- `logged = (state & WATERLOGGED) !== 0` (fluids.js:145); bail if `!logged && !blk.fluid` (fluids.js:146).
- `fluid = logged ? 'water' : blk.fluid`; `outId = logged ? B.WATER : id` — **a bit-7 fence pours WATER, not fences** (fluids.js:147, 153).
- **Re-derive branch, `if (!logged && !isSource(state))`** (fluids.js:158-211) — waterlogged cells never enter it (fluids.js:155-157: entering is fatal, the `best <= 0` path would `setBlock(AIR)` and delete the block itself).
  - Feeder from above: water uses `isWaterCellAt(upId, ...)`, lava uses `BLOCKS[upId].fluid === fluid` (fluids.js:166-168). `fromAbove → best = 8`; else max over `H4` of `s - drop` (fluids.js:170-179).
  - `best <= 0` → `setBlock(x,y,z,B.AIR)` + `wakeNeighbors` + return (fluids.js:180-184).
  - `newState = fromAbove ? FALLING : (8 - best)`; on change → `setState` + `wakeNeighbors` (fluids.js:185-191).
  - **Infinite water** (fluids.js:196-210): `sources >= 2` over `H4` counted by `isWaterSourceAt` (bit-7 neighbors count) **and** below is `BLOCKS[belowId].opaque || isWaterSourceAt(below)` → `setState(x,y,z,0)`, `cur = 8`.
- **Spread branch** (fluids.js:213-239) — the only branch a waterlogged cell runs:
  - Down: `y > 0 && (canReplace(belowId) || (belowBlk.fluid && belowBlk.fluid !== fluid))` → `setFluid(x, y-1, z, outId, FALLING)`, **and does NOT also spread sideways**.
  - Sideways: `else if (belowBlk.collidable || belowBlk.opaque || belowBlk.fluid === fluid || (getState(x,y-1,z) & WATERLOGGED) || y === 0)` — `out = strength(...) - drop`; for each `H4`, opposite fluid → `setFluid(nx,y,nz,outId, 8-out)`; else `(canReplace(nId) || nBlk.fluid === fluid) && nS < out` → `setFluid(nx,y,nz,outId, 8-out)`.
- Always ends with `checkInteractions(x, y, z)` (fluids.js:240).

**Dead option:** `fluids.js:79` calls `world.popBlock(x, y, z, { silent: false })`, but `popBlock`'s signature destructures only `{ toolClass = null, toolTier = null } = {}` (World.js:283) — **`silent` is silently ignored.**

**Unused locals in `step`:** `cur` is assigned at fluids.js:149, 189, 208 and never read; the spread branch recomputes strength fresh at fluids.js:223.

---

## 8. Fire

`fire.js` — vanilla Java 1.20, **Normal difficulty hard-coded** (fire.js:3-4). All RNG is `Math.random()` via `randInt(a,b) = a + Math.floor(Math.random() * (b - a + 1))` (fire.js:44) — never `world.rng` (fire.js:5-7).

```js
export const FIRE_SAFETY = { RADIUS_CAP: 24, MAX_ACTIVE: 512 };   // fire.js:16 — both Infinity = unbounded vanilla
```
**Module-level singleton state:** `const fireOrigins = new Map()` — `posKey(x,y,z) = \`${x},${y},${z}\`` → `{ox, oz}` (fire.js:27-28). **String keys, not bit-packed** — world coords span ±1e6 so packing overflows `Number.MAX_SAFE_INTEGER` and aliases distant fires (fire.js:21-26). **Never saved** (fire.js:20-22); hydrated fires self-register on first tick (fire.js:200-205).

### Public exports
```js
fireCount()                                  // fire.js:30
clearFireOrigins()                           // fire.js:31
forgetFire(x, y, z)                          // fire.js:34
forgetFireInChunk(cx, cz)                    // fire.js:37
solidTopBelow(world, x, y, z)                // fire.js:54
anyFlammableNeighbor(world, x, y, z)         // fire.js:62
canSurvive(world, x, y, z)                   // fire.js:71
isNearRain(world, x, y, z)                   // fire.js:91
placeFire(world, x, y, z, age = 0, origin)   // fire.js:134
igniteAt(world, x, y, z)                     // fire.js:146
removeFire(world, x, y, z, douse = false)    // fire.js:156
fireTick(world, x, y, z, state)              // fire.js:191
lavaFireAttempt(world, x, y, z)              // fire.js:283
lightningIgnite(world, x, y, z)              // fire.js:332
```
Internal: `igniteOdds` (fire.js:76), `withinLeash` (fire.js:116), `underActiveCap` (fire.js:122), `originOf` (fire.js:125), `tryBurn` (fire.js:164), `hasLavaIgniteNeighbor` (fire.js:316).

### The origin-map leak guard
The **only** thing keeping `fireOrigins` from leaking is `World.setBlock:130` (`if (old === B.FIRE && id !== B.FIRE) forgetFire(x, y, z)`) plus `Game.onChunkUnloading` → `forgetFireInChunk` (`src/Game.js:739`, imported Game.js:32). World.js:124-129 enumerates the five removal routes that never touch the fire engine (water/lava flow-in, punch-out, explosion, block placed into the cell, `removeFire`). **`ChunkManager.unloadPass` does not call `forgetFireInChunk` itself** — it goes through the `game?.onChunkUnloading?.(chunk)` hook at ChunkManager.js:226. A leaked map starves `MAX_ACTIVE` until nothing may spread.

### Safety valve semantics (deliberately split — fire.js:99-119)
- `withinLeash(x, z, origin)` = `chebyshev((x,z), (ox,oz)) <= 24`; **no origin → true** (fire.js:117). On failure the fire is not created **and the fuel is NOT consumed** — checked *before* the burn/replace branch (fire.js:173).
- `underActiveCap()` = `fireOrigins.size < 512` (fire.js:122). Gates **new spread fires only**; **fuel still burns at the cap** so the count drains. fire.js:105-114 documents this as a resolution of a spec deadlock (512 eternal wool fires). **`igniteAt` bypasses `MAX_ACTIVE` entirely** (fire.js:143-145).

### `fireTick` order (fire.js:191-275)
1. **Re-schedule first**: `world.scheduleTick(x, y, z, 30 + randInt(0, 9))` (fire.js:193).
2. `age = state & STATE_NIBBLE`; `infinite = BLOCKS[below]?.infiniteBurn === true` (fire.js:195-197).
3. Self-register origin if absent (fire.js:200-205).
4. §2.1 `!canSurvive` → `removeFire` (silent), return (fire.js:208).
5. §2.2 rain: `!infinite && isNearRain && Math.random() < 0.2 + age * 0.03` → `removeFire(..., true)` (audible), return (fire.js:212-215). 20% at age 0 → 65% at age 15.
6. §2.3 aging: `newAge = Math.min(15, age + (randInt(0,2) >> 1))` → 1/3 chance +1; written via `setState(..., (state & 0xF0) | newAge, { noRemesh: true })` (fire.js:223-228). **`newAge` is written and read by nothing else — every decision below uses the PRE-tick `age`** (fire.js:218-222, matches vanilla `FireBlock#tick`).
7. §2.4a barren burnout: `!anyFlammableNeighbor` → remove if `!solidTopBelow || age > 3`; **return unconditionally** (fire.js:232-235).
8. §2.4b old-age: `age === 15 && randInt(0,3) === 0 && (BLOCKS[below]?.fireBurn ?? 0) === 0` → remove, return (fire.js:237-240).
9. `humid = HUMID_BURNOUT_BIOMES.has(world.biomeAt(x, z))` → `k = humid ? -50 : 0` (fire.js:243-244). `HUMID_BURNOUT_BIOMES = new Set([BIOMES.SNOWY_TUNDRA, BIOMES.MOUNTAINS])` (fire.js:49) — a documented substitution, since 02's biome set has no jungle/swamp (fire.js:46-48).
10. §2.5 `tryBurn` × 6 in **exact vanilla order**: `+X(300+k)`, `-X(300+k)`, `-Y(250+k)`, `+Y(250+k)`, `+Z(300+k)`, `-Z(300+k)` (fire.js:247-252).
11. §2.6 propagate into air: `dx,dz ∈ [-1,1]`, **`dy ∈ [-1, 4]`**, skipping the origin cell, clamped to `ty ∈ [0,127]` (fire.js:257-262). `bound = 100 + (dy > 1 ? (dy - 1) * 100 : 0)`; `odds = Math.floor((enc + 54) / (age + 30))` (**+54 = Normal difficulty +40+7*2**); `if (humid) odds = Math.floor(odds / 2)`; place iff `odds > 0 && randInt(0, bound-1) <= odds && !isNearRain && withinLeash && underActiveCap` (fire.js:263-271). The volume is anchored on the **fire block, not its fuel** — interposed non-flammable blocks do not shield cells above (fire.js:255-256).

`tryBurn(world, x, y, z, bound, age, origin)` (fire.js:164-186): `burn = effFireBurn(id, state)`; bail if `burn <= 0 || randInt(0, bound-1) >= burn`; **leash gate**; then `randInt(0, age+9) < 5 && !world.isRainingAt(x,y,z) && underActiveCap()` → `placeFire(..., Math.min(15, age + (randInt(0,4) >> 2)), origin)`, else `setBlock(x,y,z,B.AIR)` — **which bypasses the loot table** (vanilla for every fuel here; leaves drop nothing) (fire.js:181-184). `wasTNT` → `world.igniteTnt?.(x, y, z, 80)` (fire.js:185).

`placeFire` (fire.js:134-139): hard bounds `y < 0 || y > 127`; `setBlock(x,y,z,B.FIRE,{state: Math.min(15,age) & STATE_NIBBLE})`; `fireOrigins.set(posKey, origin ?? {ox: x, oz: z})`. **Deliberately does NOT pre-check `canSurvive`** — vanilla lets an invalid fire die on its next tick (fire.js:130-131).

`igniteAt` (fire.js:146-149): requires `getBlock === B.AIR && canSurvive`; always a **new** origin at its own cell; always succeeds regardless of `MAX_ACTIVE`.

`removeFire` (fire.js:156-160): `forgetFire` → `setBlock(x,y,z,B.AIR)` → `if (douse) emitSound('block.extinguish', ...)`. The **quiet age-out of §2.4 is the only silent removal** (fire.js:151-155).

`solidTopBelow` (fire.js:54-59): `b.opaque === true || (b.collidable === true && b.shape === 'cube')` — chest yes, fence no.

`lavaFireAttempt` (fire.js:283-313): `i = randInt(0,2)`. `i > 0` → walk upward `i` steps, each `(randInt(-1,1), +1, randInt(-1,1))`; bail on `cy` out of `[0,127]`; on AIR + `hasLavaIgniteNeighbor` + `canSurvive` → `igniteAt`, return; on `collidable` → return. `i === 0` → **3 attempts** at `(randInt(-1,1), 0, randInt(-1,1))`: if the cell is **not bit-7**, is `lavaIgnite`, and the cell above is AIR → `igniteAt(tx, y+1, tz)`.

`lightningIgnite` (fire.js:332-337): `igniteAt(x,y,z)` then **4 extra attempts** at `randInt(-1,1)` **per axis including Y**. Called from `src/env/DayNight.js:249`.

### Registry wiring (fire is the reference pattern)
`blocks.js` is a **pure, worker-safe module and must never import the engine** (World.js:353-356). So the fire block's hooks call **World facade methods**, which delegate to `fire.js`:

| Registry hook (blocks.js) | World facade | Engine |
|---|---|---|
| `scheduledTick: (world,x,y,z,state) => world.fireTick?.(x,y,z,state)` — blocks.js:677 | `World.fireTick` — World.js:357 | `fireTick` — fire.js:191 |
| `neighborUpdate: (world,x,y,z) => world.fireNeighborUpdate?.(x,y,z)` — blocks.js:682 | `World.fireNeighborUpdate` — World.js:363 | `canSurvive` + `removeFire(...,true)` |
| lava `randomTick: (world,x,y,z) => world.lavaFireAttempt?.(x,y,z)` — blocks.js:663 | `World.lavaFireAttempt` — World.js:368 | `lavaFireAttempt` — fire.js:283 |
| fire `onPlaced` → `world.scheduleTick(x,y,z, 30 + Math.floor(Math.random()*10))` — blocks.js:676 | `World.scheduleTick` — World.js:306 | `ScheduledTicks.schedule` |

Fire block def: `defBlock(65, 'fire', { ...CROSS, emission: 15, replaceable: true, drops: noDrop, ... })` (blocks.js:670-683). State nibble = age 0–15; **bit 7 is never set on fire — water destroys it** (blocks.js:667-669).

---

## 9. ChunkManager

```js
constructor(world, scene, materials, tileUV)   // ChunkManager.js:13
```
Fields: `mesher = new ChunkMesher(tileUV)` (:16), `save` (wired by Game, :18), `game` (:19), `workers[]` (:20), `pending: Map<jobId, chunkKey>` (:22), `requestList: [key,cx,cz][]` nearest-first (:24), `remeshQueue: Set<chunkKey>` (:26), `retries: Map` (:29), `loading = true` — relaxes budgets during LOADING (:30).

### Public methods
```js
initWorkers(seedString)              // ChunkManager.js:33
dispose()                            // ChunkManager.js:43
onWorkerMessage(msg)                 // ChunkManager.js:48
requestGenerate(chunk)               // ChunkManager.js:83
async hydrate(chunk, record)         // ChunkManager.js:91
tick(playerX, playerZ)               // ChunkManager.js:125
rebuildRequestList(pcx, pcz)         // ChunkManager.js:161
promote(pcx, pcz)                    // ChunkManager.js:175
hoodAtLeast(chunk, state)            // ChunkManager.js:206
unloadPass(pcx, pcz)                 // ChunkManager.js:218
disposeChunkMeshes(chunk)            // ChunkManager.js:234
markDirty(key)                       // ChunkManager.js:250
rebuildNow(keys)                     // ChunkManager.js:256
drainRemesh(playerX, playerZ, budgetMs = REMESH_FRAME_BUDGET_MS, maxCount = REMESH_FRAME_MAX)   // ChunkManager.js:267
buildChunk(chunk)                    // ChunkManager.js:290
loadingProgress(pcx, pcz)            // ChunkManager.js:327
countByState()                       // ChunkManager.js:339
```

### Radii & budgets (constants.js:21-30)
`GENERATE_RADIUS = 9`, `RENDER_RADIUS = 8`, `SIM_RADIUS = 6`, `UNLOAD_RADIUS = 11`, `WORKER_COUNT = 2`, `MAX_JOBS_IN_FLIGHT = 16`, `REMESH_FRAME_BUDGET_MS = 6`, `REMESH_FRAME_MAX = 4`, `INITIAL_MESH_PER_TICK = 8`.

### Game hooks (all optional-chained)
`game.onChunkGenerated?.(chunk)` (:79), `game.onChunkHydrated?.(chunk, record)` (:120), `game.onChunkUnloading?.(chunk)` (:226).

### Flow
`tick` (:125-159): sets `world.playerChunk = {cx, cz}` (:128) — **this is what gates `randomTicks` and `ScheduledTicks.run`'s sim-radius test**. Rebuilds `requestList` only on chunk crossing (:130-133). Dispatch loop `while (pending.size < MAX_JOBS_IN_FLIGHT && requestList.length > 0)` (:136): creates the `Chunk`, inserts into `world.chunks`, **bumps `chunkVersion`** (:139-141); if `save.hasChunk(key)` → **skip the worker entirely**, async `save.loadChunk` → `hydrate`, else `ChunkState.FAILED` (:142-150); else `requestGenerate` (:152). Then `promote(pcx, pcz)` (:156) and `if (world.time % 20 === 0) unloadPass(...)` (:158).

`onWorkerMessage` (:48-81): `'ready'` → captures `worldSpawn`, fires `onReady` once (:49-55). `'error'` → **one retry**, second failure → `ChunkState.FAILED` ("visible hole = loud bug signal") (:56-69). **`retries` is never cleared on success** — the map grows for the session. `'chunk'` → staleness gate `chunk.state !== ChunkState.REQUESTED || key !== chunk.key` (:75); `chunk.install(msg.blocks, msg.heightMap, msg.biomes)` — **transferred views used as-is, zero-copy** (:76-77).

`hydrate` (:91-121): re-gates on `chunks.has(chunk.key) && state === REQUESTED` (:92). **Recomputes the heightMap by top-down column scan**, `terminatesSky(blocks[i], states[i])` — **the state MUST be passed**; hydrate is the *other* heightmap producer besides `onBlockChanged` and it loads player-authored bit-7 cells (:96-113, rationale :103-106). Sets `chunk.modified = false` (:115).

`promote` (:175-204): budget = `loading ? INITIAL_MESH_PER_TICK (8) : 2` (:177). Candidates = `GENERATED` chunks with a full `hoodAtLeast(chunk, GENERATED)` 3×3 (:179-184), sorted by squared distance (:185). Per promotion: `world.light.initialLight(chunk)` → sets `LIT`, returns dirtied keys → any `MESHED` neighbor is re-queued (:188-192). Then the 3×3 around it: any `LIT` chunk with a full `LIT` hood **within `RENDER_RADIUS` (chebyshev)** is queued (:194-202).

`hoodAtLeast(chunk, state)` (:206-216): all 9 of the 3×3 must be `>= state` — **`FAILED` chunks count as satisfying** (:211), so a failed neighbor does not stall promotion.

`unloadPass` (:218-232): chebyshev `> UNLOAD_RADIUS (11)` → `if (chunk.modified && save) save.saveChunkNow(chunk)` → `game.onChunkUnloading?.` → dispose meshes → delete from `world.chunks` → **bump `chunkVersion`** → drop from `remeshQueue`.

`markDirty(key)` (:250-253): enqueues **only if `chunk.state >= ChunkState.LIT`** — writes into `GENERATED`-but-unlit chunks are dropped from the remesh queue.

`rebuildNow(keys)` (:256-264): synchronous, **only rebuilds chunks at exactly `ChunkState.MESHED`** — a `LIT`-but-never-meshed chunk is skipped and stays queued.

`drainRemesh` (:267-288): prunes `state < LIT` entries (:273); sorts by squared distance; stops at `built >= maxCount || performance.now() - t0 > budgetMs` (:281); **skips (without dequeuing) chunks failing `hoodAtLeast(chunk, LIT)`** (:282). Returns the count built. Called at `Game.js:260` with defaults (6ms/4) and at `Game.js:218` during LOADING with **(40ms, 12)**.

`buildChunk` (:290-324): `mesher.build(world, chunk)` → three buckets `['opaque','cutout','water']`; `renderOrder = bucket === 'water' ? 10 : 0` (:315); `setChunkBoundingSphere(geo, chunk.minY, chunk.maxY)`; `matrixAutoUpdate = false` on group and meshes; **`if (chunk.state === ChunkState.LIT) chunk.state = ChunkState.MESHED`** (:322).

---

## 10. raycast.js

```js
export function raycastBlocks(world, ox, oy, oz, dx, dy, dz, maxDist, opts = {})   // raycast.js:7
export function hasLineOfSight(world, ax, ay, az, bx, by, bz)                      // raycast.js:42
```
Amanatides & Woo DDA. `opts.fluidMode` — also stop at fluid **source** cells (bucket use); `opts.opaqueOnly` — only stop at opaque blocks (mob LOS) (raycast.js:5-6).

Hit test (raycast.js:23-25):
```js
const hit = opaqueOnly ? b.opaque
  : (b.targetable || (fluidMode && b.shape === 'liquid' && world.getState(x, y, z) === 0));
```
Loop is **hard-capped at 256 steps** and `t <= maxDist` (raycast.js:20). Returns `{ x, y, z, id, face: [faceX, faceY, faceZ], t, px, py, pz }` or `null` (raycast.js:27-28, 38). `face` is the **negated step** of the axis last crossed (raycast.js:31-35) — i.e. the outward normal of the entered face.

`hasLineOfSight` normalizes, early-returns `true` under `1e-6`, and is `raycastBlocks(..., {opaqueOnly: true}) === null` (raycast.js:43-48).

`raycast.js` imports only `BLOCKS` — **it has no dependency on the chunk/light/tick machinery** and reads world exclusively through `world.getBlock` / `world.getState`.

---

## 11. World public surface

`class World` — World.js:13. Constructed with `seedString`.

**Fields:** `seedString` (:15), `worldSeed = hashString(seedString)` (:16), `chunks: Map<"cx,cz", Chunk>` (:17), `chunkVersion` (:18), `time` (persisted; DayNight advances) (:19), `skyDarken` int 0–11 (:20), `playerChunk {cx,cz}` set by ChunkManager each tick (:21), `game` back-ref (:22), `chunkManager` (:23), `light = new LightEngine(this)` (:24), `scheduled = new ScheduledTicks(this)` (:25), `fluids = new Fluids(this)` (:26), `rng` (:27-28).

**Reads:** `getChunkAt(x,z)` :34 · `isLoaded(x,z)` :46 · `getBlock(x,y,z)` :48 (**`y<0 → B.BEDROCK`, `y>MAX_Y → B.AIR`, unloaded → `B.AIR`**) · `getState(x,y,z)` :56 (out of range → 0) · `getSkyLight` :63 (**`y>MAX_Y → 15`**) · `getBlockLight` :71 · `internalLight` :79 · `heightTop(x,z)` :84 (**unloaded → 0**) · `canSeeSky(x,y,z)` :90 · `biomeAt(x,z)` :92 (**fallback 3 = plains**).

**Writes:** `setBlock` :101 · `setState` :178 · `setWaterlogged` :217 · `collectDirtyKeys` :226 · `neighborUpdates` :242 · `checkFall` :260 · `clearedCell` :276 · `popBlock(x,y,z,{toolClass,toolTier})` :283 · `removeBlock(x,y,z)` :299.

**Ticking:** `scheduleTick(x,y,z,delay)` :306 · `blockTick(x,y,z)` :308 · `randomTicks()` :323.

**Game-delegating hooks** (all `this.game?.`): `growTree(species,x,y,z)` :347 · `igniteTnt(x,y,z,fuse)` :351 · `spawnItem(name,count,x,y,z)` :370 · `isRainingAt(x,y,z)` :372 (`?? false`) · `getEntitiesInBox(box, filter)` :374 (`[]` when no game) · `detailSeed()` :378. Also referenced but **not defined on World** — `game.spillBlockEntity` (:136) and `game.spawnFallingBlock` (:267).

**Fire facade:** `fireTick` :357 · `fireNeighborUpdate` :363 · `lavaFireAttempt` :368.

`popBlock` (:283-297): returns false on AIR; `drops = blk.drops({state, toolClass, toolTier, rng: this.rng})` (:288-290) — **loot draws from the seeded `world.rng`**; writes `clearedCell`; spawns each drop at `(x+0.5, y+0.5, z+0.5)` via `game.spawnItemByName` (:293-296).

---

## 12. Extension points — how a new block type hooks in

**Registry field surface** (defaults block, blocks.js:255-293) — the hooks a new block declares:

| Field | Signature / value | Consumed at |
|---|---|---|
| `scheduledTick` | `(world, x, y, z, state) => void` | World.blockTick — World.js:319 |
| `randomTick` | `(world, x, y, z, state) => void` | World.randomTicks — World.js:337 |
| `neighborUpdate` | `(world, x, y, z, state) => void` | World.neighborUpdates — World.js:249 |
| `onPlaced` | `(world, x, y, z, state) => void` | setBlock step 11 — World.js:158 |
| `onBroken` | `(world, x, y, z, oldState) => void` | setBlock step 11 — World.js:157 |
| `drops` | `({state, toolClass, toolTier, rng}) => [{name, count}]` | popBlock — World.js:288-290 |
| `fluid` | `'water' \| 'lava' \| null` | blockTick :318, setBlock :161, neighborUpdates :254, Fluids.strength fluids.js:35 |
| `gravity` | bool (default `false`, blocks.js:265) | setBlock :165, neighborUpdates :255, checkFall :263 |
| `waterloggable` | bool (default `false`, blocks.js:291) | setBlock bit-7 clear :111, setWaterlogged :219 |
| `emission` | 0–15 (default 0, blocks.js:259) | initialLight :223, onBlockChanged :290-298 |
| `opacity` | 0–15 (default 15, blocks.js:260) | LightEngine.opacity :115, terminatesSky :57 |
| `fireEnc` / `fireBurn` / `lavaIgnite` / `infiniteBurn` | blocks.js:288-292 | fire.js via `effFireEnc`/`effFireBurn` |
| `blockEntity` | `'furnace' \| 'chest' \| null` | setBlock spill :133-139 |
| `canPlaceAt`, `needsSupport`, `interactable`, `collisionBox`, `shape`, `bucket`, `targetable`, `replaceable`, `renderSameIdFaces`, `climbable`, `slipperiness`, `tier`, `tool`, `hardness`, `blast`, `mat` | blocks.js:255-292 | mesher / interaction / physics |

**Flammability + waterloggable are assigned post-hoc from tables**, not per-`defBlock` — `FIRE` table at blocks.js:750-773 applied at blocks.js:774-778; waterloggable list at blocks.js:783-787. Both `console.warn` on unknown names rather than throwing.

### The architectural rule for a new engine (redstone-style)
**`registry/blocks.js` is pure and worker-safe and must never import the engine** (World.js:353-356, fire.js is the worked example). The established pattern, verbatim:

1. New engine module lives at `src/world/<name>.js`, importing only `registry/blocks.js`, `constants.js`, and leaf helpers (`audio/engine.js`, `world/gen/biomes.js`). Compare fire.js:8-10, fluids.js:4-5.
2. `World` imports it (World.js:8) and exposes **thin facade methods** (World.js:353-368).
3. The block's registry hooks call `world.<facade>?.(...)` with optional chaining (blocks.js:663, 677, 682).
4. Scheduling is re-armed **inside the tick handler itself** (fire.js:193) and seeded from `onPlaced` (blocks.js:676).

### Non-obvious constraints a new tick engine must respect
- **Everything routes through `setBlock`** (World.js:101). Any per-cell side-table (like `fireOrigins`) must be torn down from `setBlock`'s chokepoint (the World.js:130 pattern) **and** from `Game.onChunkUnloading` (Game.js:739) — World.js:124-129 enumerates the five removal paths that never touch the owning engine.
- **`blockTick` fluid/bit-7 branch shadows `scheduledTick`** (World.js:318). A new waterloggable block with its own `scheduledTick` will never receive it while waterlogged.
- **Minimum scheduled delay is 1** (scheduledTicks.js:12) — same-tick scheduling is impossible.
- **`world.time++` happens after `scheduled.run()`** (Game.js:199 vs 201 → DayNight.js:133). `schedule(delay=1)` from inside a tick lands on the *next* `run()`.
- **Per-cell dedup is per due-tick only** (scheduledTicks.js:15-17).
- **Outside `SIM_RADIUS` (6), scheduled ticks are deferred +40, not dropped** (scheduledTicks.js:31-32).
- **Simulation RNG discipline:** `world.rng` is seeded and shared with weather/worldgen; `randomTicks` already draws 4056/tick from it. Decision/cosmetic RNG must use `Math.random()` (fire.js:4-7).
- **Light has no cross-call budget.** Each `setBlock` that changes id or flips bit 7 runs an unbudgeted synchronous BFS; only per-call guards exist (LightEngine.js:154, :185). A bulk edit (explosion, structure placement) does N floods and N `rebuildNow` passes if `byPlayer: true`.
- **`neighborUpdates` recursion is unbounded and synchronous** — no depth cap, no deferred update queue.
- **Bits 4–6 of `states` are free** (blocks.js:24) — the only unclaimed per-voxel storage. There is no per-cell extra-data map besides `chunk.blockEntities` (Chunk.js:27), which persists via `save`/`hydrate` (ChunkManager.js:117-119).


<!-- ===== ad21716d4915c63ac ===== -->
# Integration Map — Player / Interaction / Input / Collision

All paths relative to `/Users/jakevolkanovski/Desktop/ClaudeCraft`.

---

## 1. Module surface & wiring

| Module | Exports | Constructed / called from |
|---|---|---|
| `src/entities/Player.js` | `class Player extends LivingEntity` (:12) | `new Player(this.world)` — `src/Game.js:97`; ticked `this.player.tick(frame)` — `src/Game.js:196` |
| `src/player/interaction.js` | `class Interaction` (:22), `function rayAABB(origin, dir, box)` (:783) | `new Interaction(this)` — `src/Game.js:99`; `this.interaction.tick(frame)` — `src/Game.js:197` |
| `src/player/input.js` | `class Input` (:10) | `snapshot()` called at `src/Game.js:193` |
| `src/physics/collision.js` | `getCellBox(id, state)` (:11), `collideAxis(world, box, axis, d, blockUnloaded=false)` (:20), `moveEntity(world, entity, dx, dy, dz)` (:58), `moveEntitySubstepped(...)` (:75), `forEachOverlappedCell(box, cb)` (:86), `overlapsFluid(world, box, fluid)` (:103), `overlapsBlockId(world, box, id)` (:112), `overlapsClimbable(world, box)` (:116), `collidesAny(world, box)` (:124); re-exports `doorBox`, `FACING_DIR` (:8) and `B` (:145) | `Entity.move` → `moveEntity` (`src/entities/Entity.js:74`); `Entity.updateMedium` → `overlapsFluid`/`overlapsClimbable` (`src/entities/Entity.js:82-87`) |

**Tick order** (`src/Game.js:187-208`): `player.tick(frame)` → `interaction.tick(frame)` → `entities.tick(player)` → `world.scheduled.run()` → `world.randomTicks()` → `dayNight.tick()` → `mobSpawner?.tick()`. Player and Interaction receive the **same frame object** (including the same `pressed` Set); neither consumes edges from it.

**Frame gating** (`src/Game.js:193`):
```js
const frame = playing && !this.sleeping ? this.input.snapshot() : (this.input.snapshot(), NEUTRAL_FRAME);
```
`snapshot()` always runs (drains edge buffers) but the result is discarded outside `STATE.PLAYING`. `NEUTRAL_FRAME` is a module-level **mutable shared object** with a shared `pressed: new Set()` — `src/Game.js:34-38`.

---

## 2. Player fields (constructor `src/entities/Player.js:13-80`)

### Inherited — `src/entities/Entity.js`
`world, id, type, pos{x,y,z}` (feet center), `prevPos, vel{x,y,z}` (m/tick), `yaw, pitch, prevYaw, width, height, onGround, hitWall, hitCeiling, inWater, inLava, onLadder, age, dead, object3d, lightScalar, chunkKey, gravityBlocked, blockAgainstUnloaded, persistent` (:24-47).
From `LivingEntity` (:147-158): `health = 20`, `maxHealth = 20`, `invulnTicks = 0`, `lastHurtAmount = 0`, `hurtTime = 0`, `deathTime = 0`, `fallDistance = 0`, `fireTicks = 0`.
Static: `LivingEntity.ARMOR_SOURCES = new Set(['melee','arrow','explosion','cactus','thorns'])` (:164).

### Player-owned

| Field | Line | Init | Notes |
|---|---|---|---|
| `type` | 15 | `'player'` | |
| `width` / `height` | 16 | `0.6` / `1.8` | |
| `takesFallDamage` | 17 | `true` | read in `LivingEntity.trackFall` :236 |
| `blockAgainstUnloaded` | 18 | `true` | → `collideAxis(..., blockUnloaded)` treats unloaded chunks as solid (`collision.js:32-34`) |
| `persistent` | 19 | `true` | |
| `eyeHeight` / `prevEyeHeight` | 22-23 | `1.62` | camera at `src/Game.js:308` |
| `fovScale` | 24 | `1.0` | `70 * p.fovScale` — `src/Game.js:323` |
| `bobPhase`/`prevBobPhase`/`bobIntensity`/`prevBobIntensity` | 25-28 | `0` | lerped `src/Game.js:313-314` |
| `sneaking` | 31 | `false` | |
| `sprinting` | 32 | `false` | |
| **`flying`** | 33 | `false` | |
| **`gameMode`** | 34 | `'survival'` | comment: `'survival' \| 'debugCreative'` |
| `jumpCooldown` | 35 | `0` | |
| `ticksSinceForward` / `ticksSinceSpace` | 36-37 | `99` | double-tap latches |
| `eyeSubmerged` | 38 | `false` | read by `interaction.js:198`, `src/ui/hud.js:207` |
| `air` | 41 | `300` | |
| `foodLevel` | 42 | `20` | |
| `saturation` | 43 | `5.0` | |
| `exhaustion` | 44 | `0` | |
| `foodTickTimer` | 45 | `0` | |
| `foodPoisonTicks` | 46 | `0` | |
| `xpTotal` / `xpLevel` / `xpPoints` | 49-51 | `0` | |
| `xpPickupCooldown` | 52 | `0` | written `src/entities/XpOrb.js:57` (`= 2`) |
| **`inventory`** | 56 | `new Array(36).fill(null)` | hotbar 0–8, main 9–35 |
| **`armor`** | 57 | `new Array(4).fill(null)` | `[helmet, chest, legs, boots]`; index = `item.armorSlot` |
| **`offhand`** | 58 | `null` | comment claims "slot 45"; it is a **standalone field, not an inventory index** |
| `selectedSlot` | 59 | `0` | |
| `ticksSinceAttack` | 62 | `100` | |
| `lastHeldId` | 63 | `null` | |
| `usingItem` | 66 | `null` | `{kind:'eat'\|'bow', ticks}` |
| `spawnPoint` | 67 | `null` | |
| `hurtTilt` / `hurtTiltDir` | 68-69 | `0` / `1` | camera roll `src/Game.js:321` |
| `_moveDist` | 72 | `0` | **dead** — never read or written anywhere in the repo despite its comment |
| `stepAccum` / `swimAccum` | 75-76 | `0` | |
| `burpTimer` | 77 | `0` | set to `10` at `interaction.js:319` |
| `orbStreak` / `orbStreakTimer` | 78-79 | `0` | written by `src/entities/XpOrb.js:53-54` (cap 24, timer 40) |
| `_silentXp` | 721 | (set in `deserialize`) | suppresses `player.levelup` |

Stack shape everywhere: `{ id, count, damage? }` (`damage` absent ⇒ undamaged; presence makes a stack non-mergeable, :97).

---

## 3. Player methods

```js
get heldStack()            // :84  → this.inventory[this.selectedSlot]
set heldStack(v)           // :85
heldItem()                 // :87  → ITEMS.get(heldStack.id) | null
give(stack)                // :93  → leftover count
consumeHeld(n = 1)         // :121
damageHeld(n = 1)          // :129 → true if tool broke
armorPoints()              // :146
armorToughness()           // :152
damageArmor(dmg)           // :158
xpToNext(L)                // :175
addXp(n)                   // :181
addExhaustion(v)           // :196
tickHunger()               // :201
eat(item)                  // :236
emitStep(gainMult)         // :247
tick(input)                // :255
facingXZ()                 // :380 → {x: -sin(yaw), z: -cos(yaw)}
inputAccel(strafe, forward, speed)  // :384
moveInputs(input)          // :396
groundSlip()               // :403
landMove(input)            // :409
waterMove(input)           // :455
lavaMove(input)            // :470
flightMove(input)          // :483
snapTinyVel()              // :498
isClearForHop()            // :504
sneakEdgeClamp(dx, dz)     // :510 → [dx, dz]
updateSneak(input)         // :527
canSprint(input)           // :531
updateSprint(input)        // :539
stopSprint()               // :569
tickEnvironment()          // :573
beforeHurt(amount, source) // :620 → false blocks the hit
onHurt(dmg, source, opts)  // :625
onDeath()                  // :640
respawn(worldSpawn)        // :659
serialize()                // :682
deserialize(rec)           // :702
```

**`give()` (:93-119)** — `max = item?.stack ?? 64`; `stackable = max > 1 && stack.damage === undefined` (:97). Fill order is `[0..8, 9..35]` (:98) — hotbar first, then main. Merge pass only if stackable; then empty-slot pass. Never touches `armor` or `offhand`. Returns leftover.

**`damageHeld()` (:129-144)** — `if (this.gameMode === 'debugCreative') return false` (:130). No-op unless `item.durability` truthy. Emits `player.item_break` at :140 and nulls `heldStack`.
**`damageArmor()` (:158-171)** — **no `gameMode` guard**; `loss = Math.max(1, Math.floor(dmg / 4))` applied to **all four** slots.

**`xpToNext(L)` (:175-179)**: `L<=15 → 2L+7`; `L<=30 → 5L-38`; else `9L-158`.

---

## 4. `Player.tick(input)` — exact order (`:255-376`)

1. `baseTick()` (Entity :64 — snapshots prevPos/prevYaw, `age++`, `sampleLight()` every 4 ticks); latch `prevEyeHeight/prevBobPhase/prevBobIntensity` (:257-259).
2. `tickTimers()` (:262 → `invulnTicks--`, `hurtTime--`); `jumpCooldown--`, `xpPickupCooldown--` (:263-264); `burpTimer` → `player.eat.burp` at 0 (:266); `orbStreakTimer` → `orbStreak = 0` (:268); `hurtTilt = max(0, hurtTilt - 0.8)` (:269); `ticksSinceForward++`, `ticksSinceSpace++`, `ticksSinceAttack++` (:270-272); **held-item id change resets `ticksSinceAttack = 0`** (:273-276).
3. `if (this.dead) return;` (:279) — everything below is skipped while dead.
4. `updateSneak(input)` (:282), `updateSprint(input)` (:283).
5. `wasInWater = this.inWater` → `updateMedium()` (:289-290); splash on entry if `inWater && !wasInWater && vel.y < -0.3`, gain `min(0.8, 0.3 + |vel.y| * 0.5)` (:291-295).
6. `eyeSubmerged = isWaterCellAt(eyeBlock, state)` at `floor(pos.x), floor(pos.y + eyeHeight), floor(pos.z)` (:296-301). `isWaterCellAt = (id, state) => id === B.WATER || (state & WATERLOGGED) !== 0` — `src/registry/blocks.js:42`.
7. **Movement branch** (:306-309), strictly ordered:
   ```js
   if (this.flying) this.flightMove(input);
   else if (this.inLava) this.lavaMove(input);
   else if (this.inWater) this.waterMove(input);
   else this.landMove(input);
   ```
   `flying` wins over every medium.
8. Fall: `if (!this.flying) this.trackFall(velYBefore, this.pos.y - y0); else this.fallDistance = 0;` (:315-319). Landing SFX gated on `!flying && onGround && fdBefore > 0 && !inWater && !inLava && !onLadder` (:323-334); `dmg = Math.ceil(fdBefore - 3)`.
9. `tickEnvironment()` (:337), `tickHunger()` (:340).
10. Bob (:343-350): `hSpeed = hypot(pos.x-prevPos.x, pos.z-prevPos.z)`; grounded & `!flying` → `target = min(1, hSpeed / 0.2806)`, `bobIntensity += (target - bobIntensity) * 0.4`, `bobPhase += hSpeed * 1.5`; else `bobIntensity *= 0.8`.
11. Footsteps (:354-367): grounded && `!inWater` && `!flying` → `stepAccum += hSpeed`, fire at `>= 1.5`, gain `sneaking ? 0.5 : 1`. `inWater` → `swimAccum` threshold `1.8`, `player.splash` gain `0.35`.
12. Eye lerp: `targetEye = sneaking ? 1.27 : 1.62`, `eyeHeight += (target - eyeHeight) * 0.5` (:370-371).
13. FOV: `targetFov = (this.sprinting || (this.flying && this.sprinting)) ? 1.10 : 1.0` (:374) — the second disjunct is **subsumed by the first**; flight has no distinct FOV. `fovScale += (target - fovScale) * 0.5`.

---

## 5. Movement / physics constants (exact)

**Shared**
- `moveInputs` (:396-401): `strafe = input.strafe * 0.98`, `forward = input.forward * 0.98`; if `sneaking` both `*= 0.3`.
- `inputAccel` (:384-394): `d2 < 1e-7` → `{ax:0, az:0}`; `scale = speed / Math.max(Math.sqrt(d2), 1.0)`; right vector `= (-fwd.z, fwd.x)`.
- `snapTinyVel` (:498-502): zero any component with `|v| < 0.003`.
- `groundSlip` (:403-407): `BLOCKS[getBlock(floor(x), floor(y-0.5), floor(z))].slipperiness ?? 0.6`.

**`landMove` (:409-453)**
- `mult = sprinting ? 1.3 : 1.0`; `speed = onGround ? 0.1 * mult * Math.pow(0.6 / slip, 3) : 0.02 * mult`.
- Jump **before** move (:418-429): `vel.y = 0.42`; sprint-jump adds `0.2 * fwd` to x/z and `addExhaustion(0.2)`, else `addExhaustion(0.05)`; `jumpCooldown = 10`.
- Ladder (:435-444): clamp `vel.x/z` to `±0.15`; any of `strafe|forward|jump` → `vel.y = max(vel.y, 0.2)`; `sneaking` → `vel.y = max(vel.y, 0)`; floor `vel.y = max(vel.y, -0.15)`; `fallDistance = 0`.
- `sneakEdgeClamp` then `move(dx, vel.y, dz)` (:446-447).
- Friction `onGround ? slip * 0.91 : 0.91`; gravity `vel.y = (vel.y - 0.08) * 0.98` (:449-451).

**`waterMove` (:455-468)** — `jump → vel.y += 0.04`; accel speed `0.02`; drag `0.8` on all three axes; gravity `vel.y -= 0.005`; `addExhaustion(0.01 * horizontalDist)`; shore hop `vel.y = 0.3` when `hitWall && isClearForHop()`; `fallDistance = 0`.

**`lavaMove` (:470-481)** — `jump → vel.y += 0.04`; accel `0.02`; drag `0.5` all axes; gravity `vel.y -= 0.02`; hop `0.3`; `fallDistance *= 0.5`.

**`flightMove` (:483-496)** — `speed = 0.049 * (this.sprinting ? 2.0 : 1.0)`; `input.jump → vel.y += 0.15`; `input.sneak → vel.y -= 0.15` (**raw input**, not `this.sneaking`, which `updateSneak` forces false while flying); horizontal drag `0.91`; `vel.y *= (input.jump || input.sneak) ? 0.91 : 0.6`; clamp `vel.y` to `±0.375`; `fallDistance = 0`. **No collision-mode change** — flight still uses `move()` → full solid collision.

**`sneakEdgeClamp` (:510-523)** — early-returns `[dx,dz]` if `!sneaking || vel.y > 0 || this.flying`. Support probe = `collidesAny(world, box.offset(0, -0.6, 0))`; `STEP = 0.05`; shrinks dx, then dz, then both.
**`isClearForHop` (:504-507)** — `!collidesAny(world, getAABB().translate(vel.x, 0.6, vel.z))`. Note `translate` **mutates** (`src/math/aabb.js:29`) but the box is a fresh `getAABB()`, so it is safe.

**State machines**
- `updateSneak` (:527-529): `this.sneaking = !!input.sneak && !this.flying`.
- `canSprint` (:531-537): `input.forward * 0.98 >= 0.8 && foodLevel > 6 && !sneaking && !usingItem && !inWater && !inLava`. **Does not check `flying`** ⇒ Ctrl while flying sets `sprinting = true` and doubles flight speed.
- `updateSprint` (:539-567): `pressed.has('KeyW')` + `ticksSinceForward <= 7 && onGround && canSprint()` → sprint; **also owns the flight toggle** (:547-553): `input.pressed.has('Space') && gameMode === 'debugCreative'` and `ticksSinceSpace <= 7` → `this.flying = !this.flying; this.vel.y = 0`. `sprintKey && canSprint()` → sprint (:554). Stop conditions (:556-561): `forward*0.98 < 0.8 || hitWall || foodLevel <= 6 || inWater || inLava || usingItem`. Sprint exhaustion `0.1 * horizontalDist` per grounded tick (:563-566).

**Environment (`tickEnvironment` :573-616)** — creative early-out `{ air = 300; fireTicks = 0; return; }` (:574).
- Drown: `air -= 1` when `eyeSubmerged`; `air <= -20` → `air = 0; hurt(2, 'drown')`; else `air = min(300, air + 7.5)`.
- Lava: `age % 10 === 0 → hurt(4, 'lava')`, `fireTicks = 300`. Fire block overlap (`overlapsBlockId(world, getAABB(), B.FIRE)`): `age % 10 === 0 → hurt(1, 'fire')`, `fireTicks = max(fireTicks, 160)`.
- Burn: `fireTicks--`; `age % 20 === 0 && !inLava → hurt(1, 'burn')`; `inWater || world.isRainingAt(...)` → `fireTicks = 0`.
- Suffocate: `BLOCKS[getBlock(floor(x), floor(y + eyeHeight), floor(z))].opaque` → `age % 10 === 0 → hurt(1, 'suffocate')`.
- Void: `pos.y < -64 → die('void')`; `pos.y < -8 && age % 10 === 0 → hurt(4, 'void')`.

**Hunger (`tickHunger` :201-234)** — creative early-out (:202). `foodPoisonTicks > 0` → decrement + `exhaustion += 0.005`. `while (exhaustion >= 4.0)`: `-= 4.0`, drain saturation by `1.0` else `foodLevel--`. Regen fast: `foodLevel >= 20 && saturation > 0 && health < 20`, every 10 ticks `heal = min(1.0, saturation/6.0)`, `exhaustion += 6.0 * heal`. Regen slow: `foodLevel >= 18 && health < 20`, every 80 ticks `+1 HP`, `exhaustion += 6.0`. Starve: `foodLevel <= 0`, every 80 ticks `if (health > 1) hurt(1, 'starve')` — floors at 1 HP, never kills.

**Damage/death**
- `beforeHurt(amount, source)` (:620-623): `if (gameMode === 'debugCreative' && source !== 'void') return false` — creative is invulnerable except void.
- `onHurt` (:625-638): `hurtTilt = 8`; exhaustion `0.1` for `ARMOR_SOURCES`; SFX suppressed for `source === 'fall'`; `audio.duck()`; `world.game?.onPlayerHurt?.(dmg, source)`.
- `onDeath` (:640-657): drops inventory[0..35], armor[0..3], offhand via `game.dropStackAt(stack, pos.x, pos.y + 0.6, pos.z)`; `orbXp = Math.min(7 * xpLevel, 100)` → `game.spawnXpOrb`; zeroes xp/fire/air/fallDistance/vel; `game?.onPlayerDeath?.()`. **No `gameMode` check — creative death drops everything.**
- `respawn(worldSpawn)` (:659-678): validates `spawnPoint` via `game.validateBedSpawn?.()`; resets health 20, food 20, saturation 5.0, air 300, `sprinting/sneaking/flying = false`, `usingItem = null`, `dead = false`, `yaw = 0; pitch = 0`. Called from `src/Game.js:817`.

**Persistence** — `serialize()` (:682-699) writes `pos, vel, yaw, pitch, health, hunger, saturation, exhaustion, foodPoisonTicks, xp (=xpTotal), air, fireTicks, fallDistance, gameMode, inventory, armor, offhand, selectedSlot, spawnPoint`. **`flying` is not serialized**; neither are `usingItem`, `sprinting`, `sneaking`, `invulnTicks`, `xpLevel`/`xpPoints` (rebuilt by replaying `xp` through `addXp` under `_silentXp`, :719-723). `deserialize` (:702-725) restores `gameMode = rec.gameMode ?? 'survival'`.

---

## 6. Input snapshot & edge latching (`src/player/input.js`)

`KEYBINDS` — `src/constants.js:54-68`: `forward:'KeyW'`, `left:'KeyA'`, `back:'KeyS'`, `right:'KeyD'`, `jump:'Space'`, `sneak:'ShiftLeft'`, `sprint:'ControlLeft'`, `inventory:'KeyE'`, `drop:'KeyQ'`, `debugOverlay:'F3'`, `debugMode:'F4'`, `hotbar:['Digit1'..'Digit9']`.
`GAME_KEYS` (input.js:4-8) — used only for `preventDefault` gating; **omits `ShiftRight`**, and includes `F5` which is not in `KEYBINDS`.

**State**: `keys:Set` (held), `pressedBuf:Set` (keydown edges), `releasedBuf:Set`, `mouseDX/mouseDY`, `buttons[3]`, `pressBuf[3]`, `wheelBuf`, `locked`, `onKeyEdge` (:11-22).

**Listeners** (:24-58): `keydown` — `e.repeat` early-returns (auto-repeat never re-latches an edge); adds to `keys` + `pressedBuf`; `preventDefault` for F3/F4/F5 always, other `GAME_KEYS` only when `locked`; fires `this.onKeyEdge?.(e.code, e)` **synchronously, outside the tick loop**. `mousemove` accumulates only while `locked`. `mousedown` sets `buttons[b]` and `pressBuf[b]` for `b <= 2`. `wheel` (canvas, `{passive:false}`) accumulates `Math.sign(e.deltaY)` only while `locked`. `pointerlockchange` → `clearMovement()` on unlock + `this.onLockChange?.(locked)` (**`onLockChange` is never initialized in the constructor**, unlike `onKeyEdge`).

**`snapshot()` (:67-93)** returns:
```js
{ forward, strafe, jump, sneak, sprintKey,
  mouseLeft, mouseRight, leftPressed, rightPressed, middlePressed,
  pressed, wheel, hotbar, shift }
```
- `forward = (KeyW?1:0) - (KeyS?1:0)`, `strafe = (KeyD?1:0) - (KeyA?1:0)` — range `[-1,1]`.
- `mouseLeft = buttons[0]`, `mouseRight = buttons[2]` (**button 2 = right**); `leftPressed = pressBuf[0]`, `rightPressed = pressBuf[2]`, `middlePressed = pressBuf[1]`.
- `pressed = new Set(this.pressedBuf)` — cloned defensive copy.
- `hotbar` (:85-87): loop over 0..8, **last match wins** (highest digit if several down in one tick); `-1` if none.
- `shift = keys.has('ShiftLeft') || keys.has('ShiftRight')` — distinct from `sneak`, which is `ShiftLeft` only.
- Drains at :88-91: `pressedBuf.clear()`, `releasedBuf.clear()`, `pressBuf[*] = false`, `wheelBuf = 0`.
- **`releasedBuf` is populated (:33) and cleared (:89) but never exposed** — no release edges reach any consumer.

`consumeMouseDelta()` (:95-99) — separate from the tick; drained by the render/camera path. `requestLock()` (:101-109) — tries `{unadjustedMovement:true}`, falls back to plain.
`clearMovement()` (:61-64) clears `keys` and `buttons` but **not** `pressedBuf`/`pressBuf`/`wheelBuf` — edges latched before a pointer-lock loss survive to the next `snapshot()`.

**Immediate (non-tick) key handling** — `input.onKeyEdge` in `src/main.js:139-154`: `F3` debug toggle; **`F4` toggles `p.gameMode` between `'survival'` and `'debugCreative'` (:144), forcing `p.flying = false` on return to survival (:145)**, toasts (:146), and re-evaluates the creative block palette (:147); `KeyE` opens/closes inventory; `Escape` closes containers.

---

## 7. `Interaction` — fields & tick

**Constructor (:23-35)**: `game`, `targetPos = null`, `progress = 0`, `mineDelay = 0`, `useDelay = 0`, `swingTicks = 99`, `currentHit = null`, `crackStage = -1`, `prevMouseRight = false`, `pearlCooldown = 0`, `bowLoop = null`.
**Accessors**: `get player()` (:42), `get world()` (:43).
**`reach()` (:45)**: `this.player.gameMode === 'debugCreative' ? 5.2 : 4.5`.
**`lookDir()` (:47-51)**: `{x: -sin(yaw)*cos(pitch), y: sin(pitch), z: -cos(yaw)*cos(pitch)}`.
**`eyePos()` (:53-56)**: `{x: pos.x, y: pos.y + eyeHeight, z: pos.z}`.
**`rayHit(dist = this.reach(), opts = {})` (:58-61)** → `raycastBlocks(world, ex, ey, ez, dx, dy, dz, dist, opts)`.

Hit shape (`src/world/raycast.js:27-28`): `{ x, y, z, id, face: [fx,fy,fz], t, px, py, pz }`; `face` is the **outward normal of the entered face**. Targeting rule (:22-24): `opaqueOnly ? b.opaque : (b.targetable || (fluidMode && b.shape === 'liquid' && world.getState(x,y,z) === 0))` — fluids are only hit in `fluidMode` **and only sources** (state 0). Max 256 steps.

**`tick(input)` (:65-131)** order:
1. Decrement `mineDelay`, `useDelay`, `pearlCooldown`; `swingTicks++` while `< 99` (:67-70).
2. `if (p.dead) { resetMining(); stopBowLoop(); p.usingItem = null; return; }` (:73).
3. Hotbar (:76-85): `input.hotbar >= 0 → selectedSlot = input.hotbar`; `input.wheel → selectedSlot = ((selectedSlot + wheel) % 9 + 9) % 9`; `ui.hotbar` SFX only on actual change (:85). Both digit and wheel can apply in one tick, wheel applied after digit.
4. `this.currentHit = this.rayHit()` (:87) — one raycast per tick, at survival/creative reach.
5. `input.pressed.has('KeyQ') → dropHeld(input.shift)` (:90) — **hardcoded `'KeyQ'`, ignores `KEYBINDS.drop`**.
6. Middle-click pick-block, creative-only (:93-97): `p.inventory[p.selectedSlot] = { id, count: item.stack ?? 64 }` — **overwrites the slot outright**, no `give()`.
7. Attack on `input.leftPressed` if `pickEntityTarget()` hits (:101-108) → `attack(target)`, `attacked = true`, `resetMining()`.
8. `if (input.mouseLeft && !attacked) updateMining(); else resetMining();` (:111-112).
9. `updateUseChannel(input)` (:115).
10. RMB gate (:118-120): `if ((input.rightPressed || (input.mouseRight && this.useDelay === 0)) && !p.usingItem) this.use(input);`
11. `this.prevMouseRight = input.mouseRight` (:121) — **write-only; never read anywhere in the repo.**
12. Crack (:124-130): `stage = targetPos && progress > 0 ? min(9, floor(progress * 10)) : -1`; condition `(this.targetPos && this.crackPos !== undefined)` at :127 is **permanently false — `this.crackPos` is never assigned anywhere**, so the OR branch is dead and updates fire on stage change only. Sink: `Game.updateCrack(pos, stage)` — `src/Game.js:354`.

---

## 8. Break pipeline

**`miningDamagePerTick(block)` (:185-203)**
```js
if (block.hardness < 0) return 0;      // unbreakable
if (block.hardness === 0) return 1;    // instant
let speed = 1.0;
if (toolClass && toolClass === block.tool) {
  speed = item.speedMult ?? 1;
  if (toolClass === 'shears') speed = block.name.startsWith('wool') ? 5 : 15;
}
if (p.eyeSubmerged) speed /= 5;
if (!p.onGround) speed /= 5;           // also applies while flying
let damage = speed / block.hardness;
damage /= harvestOK(block, toolClass, item?.tier ?? null) ? 30 : 100;
```
`harvestOK(block, toolClass, toolTier)` — `src/registry/blocks.js:70-74`. Tier table `src/registry/items.js:76-80`: wooden `{tier:0, speedMult:2, dur:59}`, stone `{1,4,131}`, iron `{2,6,250}`, golden `{0,12,32}`, diamond `{3,8,1561}`.

**`updateMining()` (:205-251)**
- `mineDelay > 0` → `swingLoop(); return;` (:207).
- No hit → `resetMining()` (:209).
- **Creative insta-break (:212-222)** — bypasses `breakBlock` entirely:
  ```js
  if (block.hardness < 0) return;                       // bedrock still immune
  const cleared = this.world.clearedCell(hit.x, hit.y, hit.z);
  this.world.setBlock(hit.x, hit.y, hit.z, cleared.id, { state: cleared.state, byPlayer: true });
  this.game.particles?.blockBreak?.(...); this.swing(); this.mineDelay = 4;
  ```
  ⇒ **no drops, no XP, no exhaustion, no tool damage, and no `block.break.*` / `block.extinguish` SFX** in creative. Rate = one block per 4 ticks (`mineDelay` is decremented at :67 before this runs).
- Target change resets `progress` (:224-227).
- `d <= 0` → `swingLoop(); return;` (:229). `d >= 1` → `breakBlock(); resetMining(); swing();` with **no `mineDelay`** (:230-235).
- Accumulate `progress += d` (:236); dig SFX when `swingTicks >= 6`, read **before** `swingLoop()` (:241-244); `progress >= 1` → `breakBlock(); resetMining(); mineDelay = 6;` (:246-250).
- `swingLoop()` (:253-255): `if (swingTicks >= 6) swing()`. `swing()` (:63): `swingTicks = 0`. `resetMining()` (:257-260): `targetPos = null; progress = 0`.

**`breakBlock(x, y, z)` (:262-297)** — signature `breakBlock(x, y, z)`; **survival path only** (creative never calls it).
1. Read `id`, `block = BLOCKS[id]`, `state = world.getState(x,y,z)` **before** the erase (:264-266).
2. `drops = block.drops ? block.drops({ state, toolClass, toolTier, rng: this.world.rng }) : []` (:271-272) — drops are `{name, count}`; harvest gating lives in the block's own `gated()` wrapper (`src/registry/blocks.js:75-77`), **not here**.
3. `xp = block.xpForMine ? block.xpForMine({ state, toolClass, toolTier, rng }) : 0` (:273).
4. Erase (:278-279): `state & WATERLOGGED` → `setBlock(x,y,z, B.WATER, { state: 0, byPlayer: true })`, else `setBlock(x,y,z, B.AIR, { byPlayer: true })`.
5. `for (const d of drops) if (d.count > 0) this.game.spawnItemByName(d.name, d.count, x+0.5, y+0.5, z+0.5)` (:280-282).
6. `if (xp > 0) this.game.spawnXpOrb(x+0.5, y+0.5, z+0.5, xp)` (:283).
7. `if (block.hardness > 0 && item?.durability) p.damageHeld(toolClass === 'sword' ? 2 : 1)` (:284-286).
8. `p.addExhaustion(0.005)` (:287).
9. SFX: `id === B.FIRE` → `block.extinguish`, else `block.break.${matOf(id)}` (:290-295). `matOf` returns `null` for `mat` of `'none'`/`'fluid'`/missing (`src/registry/blocks.js:791-794`).
10. `this.game.particles?.blockBreak?.(x, y, z, id)` (:296).

---

## 9. Place pipeline

**`use(input)` (:376-453)** — dispatch order:
0. **Entity interact** (:382-389): `pickEntityTarget()` → `entTarget.interact(p, p.heldStack)`; truthy → `useDelay = 4; swing(); return;`
1. **Interactable block** (:392-399): `block.interactable && !p.sneaking` → `useDelay = 4; interactWith(block, hit); return;` — sneaking is the only bypass.
2. `if (!held) return;` (:401).
3. `held.place != null && hit` → `tryPlace(held, hit)` (:404-406); `held.placesAs && hit` → `tryPlaceSpecial(held, hit)` (:407-409). Each sets `useDelay = 4` only on success.
4. Item kinds, in order (:412-452): `kind === 'food'` (requires `foodLevel < 20 && !usingItem`, sets `usingItem = {kind:'eat', ticks:0}`, **returns without setting `useDelay`**); `name === 'bow'` (requires `hasItem('arrow')`, starts `bowLoop = startLoop('item.bow.draw', null)`); `kind === 'throwable'` → `throwHeld`; `kind === 'armor'` → equips into `p.armor[held.armorSlot]` **only if that slot is `null`** (:432-440); `name === 'bucket'` → `useBucketEmpty()`; `water_bucket|lava_bucket` → `useBucketFilled(held)`; then `if (!hit) return;` (:446); `toolClass === 'hoe'` → `useHoe`; `plantsCrop != null` → `plantSeed`; `bone_meal` → `useBoneMeal`; `flint_and_steel` → `useFlintSteel`; `shears` branch (:452) is an **empty no-op block**.

**`placePosFor(hit)` (:500-503)** — `REPLACEABLE_TARGET(hit.id)` (`= id => BLOCKS[id]?.replaceable`, :13) → place **into** the hit cell `{x, y, z, replaced: true}`; else offset by `hit.face` → `{..., replaced: false}`.
**`entityBlocksPlacement(x, y, z)` (:505-509)** — `getEntitiesInBox(new AABB(x,y,z,x+1,y+1,z+1), e => e instanceof LivingEntity && !e.dead)`; **includes the player itself** (no `!== this.player` filter, unlike `pickEntityTarget` at :144).

**`tryPlace(held, hit)` (:511-560)** → `boolean`. Guards in order:
1. `if (hit.t > this.reach()) return false;` (:518)
2. `if (y < 0 || y > 127) return false;` (:519)
3. `if (!BLOCKS[targetId].replaceable) return false;` (:521)
4. `if (block.collidable && this.entityBlocksPlacement(x, y, z)) return false;` (:522)
5. Per-block state (:526-540): `B.TORCH` — `face[1] === 1` → `state 0`; `face[1] === -1` → **return false** (no ceiling torches); side face and `!pos.replaced` → wall states `1..4` from `face[2]===1?1:face[2]===-1?2:face[0]===1?3:4`. `B.LADDER` — `face[1] !== 0 || pos.replaced` → return false; same 1..4 mapping. `B.FURNACE`/`B.CHEST` and `B.PUMPKIN`/`B.JACK_O_LANTERN` (when `tilesFor`) — `state = (this.playerFacing() + 2) % 4`.
6. `if (block.canPlaceAt && !block.canPlaceAt(w, x, y, z, state)) return false;` (:542)
7. Waterlog (:549-552): `block.waterloggable && targetId === B.WATER && (getState(x,y,z) & STATE_NIBBLE) === 0` → `state |= WATERLOGGED`. **Sources only** (`STATE_NIBBLE = 0x0F`, `WATERLOGGED = 0x80` — `src/registry/blocks.js:38-39`).
8. Commit (:554-559): `w.setBlock(x, y, z, blockId, { state, byPlayer: true })`; `this.emitPlace(blockId, x, y, z)`; **`if (p.gameMode !== 'debugCreative') p.consumeHeld(1);`** (:557); `this.swing(); return true;`

**`playerFacing()` (:490-498)** — best dot against `FACING_DIR = [[0,0,1], [-1,0,0], [0,0,-1], [1,0,0]]` (`blocks.js:52`) → index `0=+Z, 1=−X, 2=−Z, 3=+X`.
**`emitPlace(blockId, x, y, z)` (:563-566)** — `block.place.${matOf(blockId)}`, skipped when `matOf` is null.

**`tryPlaceSpecial(held, hit)` (:568-601)** — `y < 0 || y > 126` (:573, **126 not 127**, unlike `tryPlace`); target must be replaceable.
- `'door'` (:576-587): upper cell replaceable, `isSolidSupport(getBlock(x, y-1, z))`, `!entityBlocksPlacement(x,y,z)`; two `setBlock`s — lower `state: f << 2`, upper `state: (f << 2) | 1`; one `emitPlace`; **`p.consumeHeld(1)` unconditional — no `gameMode` guard**.
- `'bed'` (:588-599): head at `x + FACING_DIR[f][0], z + FACING_DIR[f][2]`; both cells replaceable + solid support; `setBlock` foot `state: f`, head `state: f | 4`; **`p.consumeHeld(1)` unconditional**.

**Other placers, all unconditional on `gameMode`**: `plantSeed` (:603-613, requires `face[1] === 1`, target `B.FARMLAND`, cell above `B.AIR`; `consumeHeld(1)` :611); `useHoe` (:615-624, `GRASS_BLOCK|DIRT` + air above → `B.FARMLAND`, `damageHeld(1)`); `useBoneMeal` (:626-655, crops `stage = min(7, (st & 7) + 2 + floor(rng()*4))`; sapling `rng() < 0.45 → growTree`; grass spread 8 attempts in ±3, `0.9` short grass else `0.5` dandelion/poppy; `consumeHeld(1)` :652); `useFlintSteel` (:657-680, TNT → `setBlock AIR` + `w.igniteTnt(x,y,z,80)`; else `igniteAt(w, hit + face)` from `src/world/fire.js`, `damageHeld(1)`); `useBucketEmpty` (:682-707) / `fillBucketStack(filledId)` (:710-719) / `useBucketFilled(held)` (:721-753); `throwHeld(held)` (:755-767, `ender_pearl` gated by `pearlCooldown = 20`, speed `1.5`, `consumeHeld(1)`); `dropHeld(wholeStack)` (:769-779, `n = wholeStack ? s.count : 1`, preserves `damage`, `game.throwStack(drop)`).

**Combat — `attack(target)` (:151-181)**
```js
const base = item?.attackDamage ?? 1;          // ITEMS default 1     (items.js:20)
const speed = item?.attackSpeed ?? 4.0;        // ITEMS default 4.0   (items.js:21)
const T = 20 / speed;
const charge = Math.min(1, Math.max(0, (p.ticksSinceAttack + 0.5) / T));
let dmg = base * (0.2 + 0.8 * charge * charge);
const crit = p.vel.y < 0 && !p.onGround && charge >= 0.848 && !p.sprinting && !p.inWater && !p.onLadder;
if (crit) dmg *= 1.5;
let kb = 0.4; if (p.sprinting) { kb += 0.5; p.stopSprint(); p.vel.x *= 0.6; p.vel.z *= 0.6; }
target.hurt(dmg, 'melee', { dirX, dirZ, knockback: kb, attacker: p });
if (item?.toolClass) p.damageHeld(item.toolClass === 'sword' ? 1 : 2);
p.addExhaustion(0.1); p.ticksSinceAttack = 0; this.swing();
```
`pickEntityTarget()` (:135-149) — range capped at `min(3.0, blockHit ? blockHit.t : 3.0)`; candidate box = the 3 m ray segment inflated by ±1 on each axis; filter `x instanceof LivingEntity && x !== this.player && !x.dead`; picks smallest `rayAABB` `t`. **No `gameMode` reach bonus** — attacks stay at 3 m in creative.

**Use channel — `updateUseChannel(input) (:301-333)`** — returns unless `p.usingItem`. `!input.mouseRight` → bow release (`releaseBow(chan.ticks)`), `stopBowLoop()`, `usingItem = null`. Else `chan.ticks++`; eat chews at 8/16/24, swallows at `>= 32` → `player.eat.swallow`, `p.burpTimer = 10`, `if (item?.kind === 'food') { p.eat(item); p.consumeHeld(1); }` (**consumes in creative too**), `usingItem = null`. Bow draw ramp: `k = min(1, ticks/20)`, `crackleRate = 0.6 + 1.2k`, `crackleFreq = 350 + 200k`.
**`releaseBow(ticks)` (:335-354)** — `f0 = ticks/20`; `charge = min(1, (f0*f0 + 2*f0)/3)`; `charge < 0.1` → abort; `takeItem('arrow')` required (**creative consumes an arrow**); `damageHeld(1)`; `speed = 3 * charge`; `inacc = 0.0172275 * 1`; spawns at `(e.x, e.y - 0.1, e.z)` with `{crit: charge >= 1, fromPlayer: true}`.
`hasItem(name)` (:356-359) / `takeItem(name)` (:361-372) — scan `inventory[0..35]` only; **never see `offhand` or `armor`**.
`gaussian(rng)` (:15-20) — Box–Muller, module-private.

**Game/World API consumed by `Interaction`**: `game.hud?.onHotbarChange?.()`, `game.particles?.blockBreak?.() / .crit?.()`, `game.updateCrack?.()`, `game.openContainer(kind, x?, y?, z?)`, `game.trySleep(x,y,z)`, `game.spawnItemByName(name, count, x, y, z)`, `game.spawnXpOrb(x, y, z, xp)`, `game.spawnArrow(...)`, `game.spawnThrown(name, x, y, z, vx, vy, vz, owner)`, `game.throwStack(stack)`, `game.dropStackAt(stack, x, y, z)`; `world.getBlock/getState/setBlock/setState/setWaterlogged/clearedCell/growTree/igniteTnt/isLoaded/getEntitiesInBox/rng`, `world.fluids.{schedule, wakeNeighbors, checkInteractions}`.

---

## 10. Collision & fluid overlap (`src/physics/collision.js`)

- `EPS = 1e-7` (:6). `MAX_Y = 127` (`src/constants.js:11`).
- **`collideAxis` (:20-55)**: sweeps `box.clone().expandByDisplacement(axis, d)`; iterates `y` from `Math.max(y0 - 1, -1)` to `Math.min(y1, MAX_Y)` — the `-1` catches boxes taller than their cell (fence 1.5). `y < 0` → `cellBox = [0,0,0,1,1,1]` (below-world floor is solid, :31). `blockUnloaded && !world.isLoaded(x, z)` → same solid cube (:33) — this is the `Player.blockAgainstUnloaded` path. Cell box = `blk.collisionBox === 'door' ? doorBox(state) : blk.collisionBox || [0,0,0,1,1,1]`. Clamp is one-sided: only cells strictly ahead clamp (`lo >= box.max[axis] - EPS` / `hi <= box.min[axis] + EPS`), so an interpenetrating entity is never ejected backward (:44-50).
- **`moveEntity` (:58-72)**: axis order **fixed Y → X → Z** (:61-63). Then `entity.onGround = dy < 0 && cdy !== dy`; `entity.hitWall = cdx !== dx || cdz !== dz`; `entity.hitCeiling = dy > 0 && cdy !== dy`; zeroes each blocked velocity component (:68-70). Returns `{cdx, cdy, cdz}`. `Entity.move` wraps it and applies `WORLD_BORDER` clamping on x/z (`src/entities/Entity.js:73-80`).
- `moveEntitySubstepped` (:75-82): `steps = max(1, ceil(max(|dx|,|dy|,|dz|) / 0.5))`; breaks early on `hitWall || onGround || hitCeiling`.
- **`forEachOverlappedCell` (:86-94)**: `y0 = Math.max(0, floor(box.min[1]))`, `y1 = Math.min(MAX_Y, ceil(box.max[1]) - 1)` — **clamped to `[0, 127]`, so no fluid/climbable/fire is detected below y=0**, unlike `collideAxis` which treats y=-1 as solid.
- **`overlapsFluid(world, box, fluid)` (:103-110)** — the **only writer of `inWater`/`inLava`** (via `Entity.updateMedium`, `src/entities/Entity.js:82-87`):
  ```js
  const water = fluid === 'water';
  return forEachOverlappedCell(box, (x, y, z) => {
    const blk = BLOCKS[world.getBlock(x, y, z)];
    if (blk && blk.fluid === fluid) return true;
    return water && (world.getState(x, y, z) & WATERLOGGED) !== 0;
  });
  ```
  Waterlogging counts as water for physics; lava never absorbs the bit. **Flowing water counts identically to a source here** — no depth/level weighting.
- `overlapsBlockId` (:112-114) — used by `Player.tickEnvironment` for `B.FIRE` (:592). `overlapsClimbable` (:116-121) — `blk.climbable` → `onLadder`.
- **`collidesAny(world, box)` (:124-143)** — used by `Player.isClearForHop` (:506) and `sneakEdgeClamp` (:513). `y0 = Math.max(0, floor(box.min[1]) - 1)` — **clamps at 0, so it does not see the below-world solid floor that `collideAxis` synthesizes at y<0**, and it ignores `blockAgainstUnloaded` entirely (unloaded chunks read as empty). Same door/unit-cube box resolution as `collideAxis`.

---

## 11. `gameMode` and flight — every existing site

`gameMode` **already exists** as a Player field (`Player.js:34`), is serialized (:693) and deserialized (:713), and is toggled by F4 in `src/main.js:144`. Two values only: `'survival'` | `'debugCreative'`. Complete list of readers:

| Site | Effect |
|---|---|
| `Player.js:130` `damageHeld` | creative → no durability spend |
| `Player.js:197` `addExhaustion` | creative → exhaustion ignored |
| `Player.js:202` `tickHunger` | creative → no drain, **no regen either** |
| `Player.js:547` `updateSprint` | creative → double-Space toggles `flying` |
| `Player.js:574` `tickEnvironment` | creative → `air = 300; fireTicks = 0;` early return (skips drown/lava/fire/suffocate/**void**) |
| `Player.js:621` `beforeHurt` | creative → all damage blocked except `source === 'void'` |
| `Player.js:693 / :713` | serialize / deserialize (`?? 'survival'`) |
| `interaction.js:45` `reach()` | `5.2` vs `4.5` (block ray only; entity attack stays 3 m) |
| `interaction.js:93` | middle-click pick-block gate |
| `interaction.js:212` `updateMining` | creative insta-break branch |
| `interaction.js:557` `tryPlace` | creative → skip `consumeHeld(1)` |
| `src/main.js:121, 144-147` | F4 toggle; forces `flying = false` on → survival; palette visibility |
| `src/ui/menus.js:392` | creative block palette guard |
| `src/ui/hud.js:205, 208` | hides fire overlay; shows mode badge |
| `src/entities/mobs/Mob.js:229` | hostiles do not target a creative player |
| `src/entities/mobs/Enderman.js:66` | enderman ignores a creative player |

`flying` sites (complete): declared `Player.js:33`; toggled `Player.js:549` (inside `updateSprint`); branch `Player.js:306` → `flightMode(input)` `:483`; suppresses sneak `:528`; suppresses `sneakEdgeClamp` `:511`; zeroes `fallDistance` instead of `trackFall` `:315-319`; gates landing SFX `:323`; gates bob `:344` and footsteps `:354`; referenced in FOV `:374` (dead disjunct); reset in `respawn` `:674`; forced false on mode switch `src/main.js:145`. **Not serialized** — `serialize()` (:682-699) has no `flying` key, so flight is lost across save/load while `gameMode` survives.

---

## 12. Observed defects / inconsistencies (reported, not fixed)

1. **`interaction.js:127`** — `this.crackPos` is never assigned in the repo; `this.crackPos !== undefined` is always false, making the OR branch of the crack-update condition dead code.
2. **`interaction.js:32, 121`** — `prevMouseRight` is initialized and written every tick but never read.
3. **`Player.js:72`** — `_moveDist` is declared ("updated in movement") but never written or read anywhere.
4. **`Player.js:374`** — `(this.sprinting || (this.flying && this.sprinting))` — second disjunct is logically subsumed by the first.
5. **`Player.js:7`** — `import { AABB } from '../math/aabb.js'` is unused (no `new AABB` in the file). **`interaction.js:3`** — `WALL_DIR` is imported but unused. **`Player.js:10`** — `const DEG = Math.PI / 180` is unused.
6. **Creative consumption is inconsistent.** `tryPlace` guards with `gameMode` (:557), but `tryPlaceSpecial` door/bed (:584, :596), `plantSeed` (:611), `useBoneMeal` (:652), `throwHeld` (:765), `dropHeld` (:777), eat (`:324`), `fillBucketStack` (:716), `useBucketFilled` (:739, :751) and `releaseBow`'s `takeItem('arrow')` (:340) all consume unconditionally.
7. **`damageArmor` (:158)** has no creative guard, while `damageHeld` (:130) does.
8. **`onDeath` (:640-657)** drops the full inventory/armor/offhand and wipes XP regardless of `gameMode`; the only creative death vector is `source === 'void'` (`beforeHurt` :621) reachable via `pos.y < -8` — but `tickEnvironment` returns at :574 in creative, so the periodic `hurt(4, 'void')` never fires; only `die('void')` at `y < -64` would, and that is also unreachable because of the same early return. **Creative players cannot die at all.**
9. **`tryPlace` bounds `y > 127` (:519) vs `tryPlaceSpecial` bounds `y > 126` (:573)** — different ceilings for the same world height.
10. **`entityBlocksPlacement` (:505-509)** does not exclude `this.player`, whereas `pickEntityTarget` (:144) does — the player's own body blocks placement of any collidable block into a cell it overlaps.
11. **`canSprint` (:531-537) does not check `flying`** — `ControlLeft` while flying sets `sprinting`, doubling `flightMove` speed (:484) and triggering the `1.10` FOV.
12. **Flight toggle lives inside `updateSprint` (:547-553)**, not in a dedicated flight state machine, and consumes `Space` (also the jump key).
13. **`interaction.js:90`** hardcodes `'KeyQ'` rather than `KEYBINDS.drop`; `Player.js:540/547` hardcode `'KeyW'`/`'Space'` rather than `KEYBINDS.forward`/`KEYBINDS.jump`. Rebinding those keys in `src/constants.js` would silently break double-tap sprint, flight toggle, and drop.
14. **`input.js:33, 89`** — `releasedBuf` is maintained but never surfaced by `snapshot()`; no consumer can see release edges.
15. **`input.js:61-64`** — `clearMovement()` on pointer-lock loss does not clear `pressedBuf`/`pressBuf`/`wheelBuf`; edges latched pre-unlock are delivered on the next snapshot.
16. **`input.js:4-8`** — `GAME_KEYS` omits `ShiftRight` (so `frame.shift` at :83 can be set by a key that is never `preventDefault`ed) and includes `F5`, which has no `KEYBINDS` entry.
17. **`Game.js:34-38`** — `NEUTRAL_FRAME` is a shared mutable module-level object whose `pressed` Set is shared across every non-playing tick; any consumer mutating it would corrupt all later neutral frames.
18. **`collidesAny` (:127) clamps `y0` to `>= 0`** and ignores `blockAgainstUnloaded`, while `collideAxis` (:26-34) synthesizes a solid floor at `y < 0` and solid unloaded chunks — so `sneakEdgeClamp` and `isClearForHop` disagree with the actual collision solver near y=0 and at chunk borders.
19. **`interaction.js:452`** — `if (held.name === 'shears' && hit) { }` is an empty statement block.
20. **`Player.js:54-58`** — the comment declares "offhand = slot 45", but `offhand` is a standalone field; `give()` (:93), `hasItem` (:356) and `takeItem` (:361) all iterate `inventory[0..35]` only and never reach it.


<!-- ===== a528b07f6e512d9c9 ===== -->
I have the full picture. Here is the map.

# ClaudeCraft Render/Atlas/UI Integration Map

## 1. Mesher — `src/mesh/ChunkMesher.js` (509 lines)

### 1.1 Buckets

Exactly **three** module-level singleton builders, `ChunkMesher.js:72`:

```js
const builders = { opaque: new Builder(), cutout: new Builder(), water: new Builder() };
```

Named `water`, **not** `transparent`. These are module singletons, not per-instance — `build()` is not reentrant and cannot be moved to a worker without refactor.

Bucket selection happens in **only one place** — `emitCube`, `ChunkMesher.js:185`:
```js
const builder = builders[blk.bucket] || builders.opaque;
```
Every other emitter hardcodes its bucket:
- `emitLiquid` → `builders.water` (`:269`)
- `emitWaterlogged` → `builders.water` (`:300`)
- `emitCross` / `emitHash` / `emitLadder` → `builders.cutout` (`:375,386,415`)
- `emitBox` → `builders.cutout` (`:455`, `const bld = builders.cutout;`)

**Inconsistency (real, cite before relying on `bucket`):** `blk.bucket` is honored *only* for `shape:'cube'`. `snow_layer` (`blocks.js:466`), `fence` (`:542`), and `bed` (`:570`) all declare `bucket: 'opaque'` but route through `emitBox`, which unconditionally emits into `builders.cutout`. Their geometry lands in the cutout material (`alphaTest 0.5`, `DoubleSide`) despite the declared bucket. `torch`/`door`/`farmland`/`cactus` also go through `emitBox` and declare `cutout`, so they happen to agree by accident.

Bucket → mesh/material binding is in `ChunkManager.js:300-318`:
```js
for (const bucket of ['opaque', 'cutout', 'water']) { ... }
mesh.renderOrder = bucket === 'water' ? 10 : 0;   // :315
```
Same literal array at `ChunkManager.js:236` (`disposeChunkMeshes`). A fourth bucket requires editing both arrays plus `builders` and `build()`'s return object.

### 1.2 Vertex attributes

`Builder` (`ChunkMesher.js:14-64`) holds 4 parallel typed arrays; `toGeometry()` (`:54`) emits:

| attribute | type | itemSize | normalized | source |
|---|---|---|---|---|
| `position` | Float32Array | 3 | no | `this.pos` |
| `normal` | Float32Array | 3 | no | `this.nrm` |
| `uv` | Float32Array | 2 | no | `this.uv` |
| `color` | **Uint8Array** | **4** | **true** | `this.col` |
| index | Uint32Array | 1 | — | `this.idx` |

`toGeometry()` returns `null` when `this.v === 0` (`:55`).

**`color` is not a color.** Signature `vertex(x, y, z, nx, ny, nz, u, v, r, g, b, a = 255)` (`:40`), and the channels carry:
- **r** = `Math.round(skyV * 17)` — skylight 0–15 packed ×17 (`:258`); shader recovers `vCol.r * 15.0` (`materials.js:32`) — 17·15/255 = 1.0 exactly.
- **g** = `Math.round(blkV * 17)` — blocklight 0–15 ×17.
- **b** = `Math.round(255 * AO_CURVE[ao[c]] * shade)` — AO × directional shade baked together (`:259`). Flat-lit paths use `Math.round(255 * shade)` with no AO (`emitFlatFace:335`, `emitBox:481`).
- **a** = per-vertex alpha; 255 everywhere except liquids, which pass `Math.round((blk.fluidAlpha ?? 1) * 255)` (`:285`, `:302`).

Growth: `ensure(nv, ni)` (`:27`) doubles `cap` (init 4096 verts) / `idxCap` (init 8192) via `grow()` (`:66`).

`quad(v0,v1,v2,v3, flipped)` (`:48`) — `flipped` picks the anti-AO-seam triangulation; only `emitCubeFace` passes it non-false: `ao[0]+ao[2] > ao[1]+ao[3]` (`:262`).

### 1.3 Shape dispatch — where a new render shape is added

Single `switch (blk.shape)` in `build()`, `ChunkMesher.js:147-161`:

```js
case 'cube':       this.emitCube(x, y, z, blk, st); break;
case 'liquid':     this.emitLiquid(x, y, z, blk); break;
case 'cross':      this.emitCross(x, y, z, blk, st); break;
case 'hash':       this.emitHash(x, y, z, blk, st); break;
case 'torch':      this.emitTorch(x, y, z, blk, st); break;
case 'ladder':     this.emitLadder(x, y, z, blk, st); break;
case 'snow_layer': this.emitBox(x, y, z, blk, st, [0, 0, 0, 1, 2 / 16, 1], true); break;
case 'cactus':     this.emitCactus(x, y, z, blk, st); break;
case 'fence':      this.emitFence(x, y, z, blk, st); break;
case 'door':       this.emitBox(x, y, z, blk, st, doorBox(st), false); break;
case 'bed':        this.emitBox(x, y, z, blk, st, [0, 0, 0, 1, 9 / 16, 1], true); break;
case 'farmland':   this.emitBox(x, y, z, blk, st, [0, 0, 0, 1, 15 / 16, 1], true); break;
default: break;   // 'none'
```

**11 shape strings + `'none'`.** A new shape = one `case` here + an emitter. The generic emitter is:

```js
emitBox(x, y, z, blk, st, box, cull, opts = {})     // ChunkMesher.js:452
```
- `box` = `[x0, y0, z0, x1, y1, z1]` in 0..1 cell space.
- `cull` = true → flush faces (`x1===1`, `x0===0`, `y1===1`, `y0===0`, `z1===1`, `z0===0`) are dropped against opaque neighbors (`:460-469`). Only flush faces; a 15/16 box never culls.
- `opts.skipTop` (face 2) / `opts.skipBottom` (face 3) — used only by `emitCactus` (`:425-428`).
- Lighting is **flat, own-cell**: `ownLight(x,y,z)` (`:352`) → no AO, no smoothing.
- UVs are **cropped to the box** in tile space (`:474-478`); note the top/bottom (`f===2||f===3`) v-crop uses `z0/z1`, all other faces use `1-y1 .. 1-y0`.

Other reusable emitters: `emitCubeFace(builder,x,y,z,f,tile)` (`:212`, full AO+smooth light), `emitFlatFace(builder,x,y,z,f,tile,h,skyV,blkV,alpha=255)` (`:328`, `h` scales the top; face 3 stays flat, `:339`), `emitSpriteQuad(builder,tile,p0,p1,p2,p3,r,g)` (`:358`, hardcodes normal `(0,1,0)` and `a=255`).

### 1.4 Face visibility

```js
faceVisible(a, bId)             // :194 — AIR→true; opaque→false; same id→a.renderSameIdFaces; else true
waterFaceVisible(wx, wy, wz)    // :207 — !isWaterCell && !opaque
isWaterCell(wx, wy, wz)         // :123 — blocks[i]===B.WATER || (states[i] & WATERLOGGED)
```
**`waterFaceVisible` is dead code** — defined at `:207`, called nowhere. `emitLiquid`/`emitWaterlogged` inline the equivalent tests instead (`:274-282`, `:313-316`).

### 1.5 Waterlogging (second contribution)

`build()` runs the shape switch, then unconditionally (`:165`):
```js
if (st & WATERLOGGED) this.emitWaterlogged(x, y, z, blk);
```
`emitWaterlogged` (`:294`) early-returns for `blk.shape === 'cube'` (`:298`) — full cubes emit no water sleeve. Otherwise: top face at `h=0.875` only if nothing above (`:308`), sides `[0,1,4,5]` at `sideTop` (1.0 if water above, else 0.875) (`:312-319`), bottom at `h=1` (`:321-324`). Any new non-cube shape gets waterlogging for free.

`STATE_NIBBLE = 0x0F` / `WATERLOGGED = 0x80` (`blocks.js:38-39`). **`emitLadder` is the only emitter that masks the nibble** (`:413`, `const st = st0 & STATE_NIBBLE;`) — comment at `:410-412` explains a waterlogged ladder is `0x81..0x84`. `emitTorch` (`:396-401`) compares raw `st === 1..4` and `emitBox`'s `tileFor` masks via `tilesFor`'s own `(state & 15)` in `finalizeBlockTiles` (`blocks.js:814`). `doorBox(state)` (`blocks.js:236`) uses `(state >> 2) & 3` and `state & 2`, unaffected by bit 7.

### 1.6 Tile lookup + neighborhood

```js
tileFor(blk, state, face)   // :130 — blk.tileIndexFor ? blk.tileIndexFor(state, face) : blk.tileIndex[face]
```
Both are produced by `finalizeBlockTiles(TILE)` (`blocks.js:801`): `tileIndex = Uint16Array.from(block.tiles.map(lookup))`, and `tileIndexFor` is a memoized wrapper over `block.tilesFor` keyed `((state & 15) << 3) | face` (`:815`). Unknown tile names `console.warn` and resolve to **0** (the magenta `missing` checker).

Hood: `captureHood(world, chunk)` (`:85`) requires all 9 chunks at `state >= ChunkState.LIT`, else `build()` returns `null` (`:136`). Index = `(dx+1)*3 + (dz+1)`. Accessors `blockAt`/`stateAt`/`opaqueAt`/`skyAt`/`blockLightAt` (`:98-120`) index `(wy << 8) | ((wz & 15) << 4) | (wx & 15)`. Y guards: `wy < 0` → `B.BEDROCK`/opaque/sky 0; `wy > MAX_Y` → `B.AIR`/sky 15.

`build()` also writes `chunk.minY` / `chunk.maxY` from `trackY(y0,y1)` (`:177`), consumed by:
```js
export function setChunkBoundingSphere(geometry, minY, maxY)   // :504
// Sphere(center (8, (minY+maxY)/2, 8), radius hypot(8, (maxY-minY)/2 + 1, 8))
```
**`emitFence` never calls `trackY`** (`:431-449`) — it relies on `emitBox`'s calls (`:496`), which is fine, but `emitCactus`/`emitTorch` likewise inherit it.

### 1.7 Face tables — `src/mesh/faceTables.js`

Face order **`[+X, −X, +Y, −Y, +Z, −Z]`** = indices 0..5.
- `FACE_NORMALS`, `FACE_CORNERS` (4 corners/face, CCW from outside), `FACE_UVS` ((0,0) = tile top-left, since `flipY=false`).
- `FACE_TANGENTS = [[1,2],[1,2],[0,2],[0,2],[0,1],[0,1]]` (axis ids 0=X,1=Y,2=Z).
- `FACE_SHADE = [0.6, 0.6, 1.0, 0.5, 0.8, 0.8]` — top 1.0, bottom 0.5, ±Z 0.8, ±X 0.6.
- `AO_CURVE = [0.4, 0.6, 0.8, 1.0]`.

## 2. Materials — `src/mesh/materials.js` (73 lines)

Exports exactly two things:

```js
export const sharedUniforms = { uAtlas, uSkyDarken, uSkyTint, uFogColor, uFogNear, uFogFar }   // :40
export function createChunkMaterials(atlasTexture)   // :49  → { opaque, cutout, water }
```

Defaults (`:40-47`): `uSkyDarken 0`, `uSkyTint Color(1,1,1)`, `uFogColor Color(0.75,0.85,1.0)`, `uFogNear 96`, `uFogFar 128`.

**Contract: mutate `.value` only, never replace the uniform objects** (`:39`). `make()` spreads `{...sharedUniforms}` into each material (`:56`), copying *references*, so one write hits all three materials. Replacing `sharedUniforms.uFogColor` itself would silently desync.

The three materials (`:63-71`):
| name | alphaTest | uAlpha | side | transparent | depthWrite |
|---|---|---|---|---|---|
| `opaque` | 0.0 | 1.0 | FrontSide | – | – |
| `cutout` | 0.5 | 1.0 | DoubleSide | – | – |
| `water` | 0.0 | 1.0 | DoubleSide | true | false |

Water's translucency comes from the **atlas texel alpha (0.7)** and the vertex `a` channel, not `uAlpha` — comment `:65-66`: "lava texels are opaque — one shared material serves both, so uAlpha stays 1.0".

Shader (`VERT :6`, `FRAG :16`): `attribute vec4 color` → `vCol`; `vDist = length(modelViewMatrix * position)`. Fragment:
```glsl
const vec3 BLOCK_TINT = vec3(1.00, 0.89, 0.69);            // :23
float brightness(float l) { x = clamp(l,0,15)/15;
  return AMBIENT_FLOOR + (1.0-AMBIENT_FLOOR)*(x/(4.0-3.0*x)); }   // :25-28
effSky = max(vCol.r*15.0 - uSkyDarken, 0.0);               // :32
light  = max(brightness(vCol.g*15.0)*BLOCK_TINT, brightness(effSky)*uSkyTint);  // :33
rgb    = tex.rgb * light * vCol.b;                          // :34 — vCol.b = AO×shade
fog    = smoothstep(uFogNear, uFogFar, vDist);
gl_FragColor = vec4(mix(rgb, uFogColor, fog), tex.a * uAlpha * vCol.a);
```
`AMBIENT_FLOOR` is inlined at shader-compile time from `../constants.js` via `${AMBIENT_FLOOR.toFixed(3)}` (`:24`).

## 3. Atlas — `src/assets/atlas.js` (105 lines)

**512×512 canvas, 32×32 grid of 16×16 tiles = 1024 slots.**

`TILE_NAMES` (`:42`):
```js
export const TILE_NAMES = ['missing', ...BLOCK_TILES, ...DESTROY_TILES, ...ITEM_TILES];
```
- index **0** = `'missing'` (magenta `#f800f8` / black 8×8 checker, `paintMissing:44`) — also the fallback for any name with no painter (`:64`).
- indices **1–96** = `BLOCK_TILES` (96 entries, `:9-38`), `'stone'`=1 … `'dead_bush'`=96.
- indices **97–106** = `DESTROY_TILES` = `Array.from({length:10}, (_,i) => 'destroy_'+i)` (`:39`).
- indices **107+** = `ITEM_TILES` = `Object.keys(PAINTERS).filter(n => n.startsWith('item_')).sort()` (`:40`) — **49 item tiles**, alphabetical.

Total occupied ≈ **156 of 1024**; ~868 free slots. **Item tile indices are not stable**: adding one `item_*` painter re-sorts and shifts every later item index. `BLOCK_TILES` order is manual/fixed; appending to that array shifts destroy+item indices. Nothing persists tile indices, so shifting is safe at runtime, but any hardcoded index would break.

```js
export function buildAtlas()   // :52
// → { canvas, texture, TILE, tileUV, atlasDataURL, animate }
```
- `TILE` = `{ [name]: index }`, built in the same loop that paints (`:58-66`).
- Slot position: `x0 = (t & 31) * 16, y0 = (t >> 5) * 16` (`:61`).
- Painter call: `painter(ctx, x0, y0, mulberry32(xmur3(name)()))` — RNG seeded **per tile name**, so painting is deterministic.
- `texture`: `CanvasTexture`, `NearestFilter` both, `generateMipmaps=false`, `colorSpace = NoColorSpace`, **`flipY = false`** (`:68-73`).
- `tileUV`: `Float32Array(1024*4)` = `[u0,v0,u1,v1]` per tile with **half-texel inset** (`:76-83`): `(col*16 + 0.5)/512` … `(col*16 + 15.5)/512`. Computed for all 1024 slots regardless of `TILE_NAMES.length`.
- `atlasDataURL` = `canvas.toDataURL('image/png')` (`:85`) — consumed by `main.js:28` as CSS var `--atlas-url` for all DOM icons.

### `animate(tick)` (`:90-102`)
```js
function animate(tick) {
  const frame = ((tick / 5) | 0) & 1;
  if (frame === lastFrame || tick % 5 !== 0) return;
  lastFrame = frame;
  for (const [name, frames] of Object.entries(ANIMATED)) {
    const t = TILE[name]; if (t === undefined) continue;
    const x0 = (t & 31) * 16, y0 = (t >> 5) * 16;
    ctx.clearRect(x0, y0, 16, 16);
    frames[frame](ctx, x0, y0, mulberry32(xmur3(name + ':' + frame)()));
  }
  texture.needsUpdate = true;
}
```
- **2 frames only**, `frames[0]` / `frames[1]`, swapping every **5 ticks**.
- Repaints the atlas slot in place → all chunk geometry picks it up with zero remesh.
- Called from `Game.js:211`: `this.atlas.animate?.(this.world.time)`, i.e. tick = absolute world time.
- The `tick % 5 !== 0` clause is redundant given `frame` only changes on multiples of 5; harmless.
- `ANIMATED` members must be registered in `TILE_NAMES` or they're silently skipped (`:96`).
- `ctx.clearRect` before repaint means frame painters **must** fill all 16×16 or leave intended transparency — `fire` relies on this (40% transparent, `tilePainters.js:504`).

## 4. Tile painters — `src/assets/tilePainters.js` (1083 lines)

Exports **two** objects:
```js
export const PAINTERS = {};     // :203  (alias `const P = PAINTERS;` :204)
export const ANIMATED = { ... } // :516
```
Painter signature: **`(ctx, x0, y0, rng) => void`**, painting one 16×16 tile at `(x0,y0)`. Module is pure canvas-2d: no three.js, no DOM at module level (`:1-3`).

### Helpers (all module-private)
`hexToRgb :7`, `css(r,g,b,a=1) :11`, `scaleHex :14`, `shadeHex :18`, `lerpHex :22`, `clamp15 :26`, `px(ctx,x0,y0,x,y,style) :29` (clamps to 0–15), `rect :33`, `solid :37`, `noise(…,c,a) :41` (±a% brightness jitter), `speckle(…,c,f,d) :48`, `blotch(…,c1,c2,n) :53` (2–5px random-walk blobs + outline), `planks :76` (4 boards, seam row ×0.7, staggered joint), `bark :88`, `birchBark :104`, `rings :112`, `oreTile(…,mineral) :121`, `leaf(…,c1,c2) :134` (12% transparent holes), `grassSide :140`, **`crossSprite(ctx,x0,y0,map,palette) :151`** (rows of chars, `'.'`/`' '` = transparent, letters index palette), `cropTile(…,stage,cLo,cHi) :162`, `glassy :177`, `fluid :188`, `border :191`, `disc(…,cx,cy,rad,c) :197`.

### ANIMATED (`:516-521`)
```js
export const ANIMATED = {
  water:             [waterFrame, (c,x,y,r) => { r(); waterFrame(c,x,y,r); }],
  lava:              [lavaFrame,  (c,x,y,r) => { r(); lavaFrame(c,x,y,r); }],
  fire:              [fireFrame,  (c,x,y,r) => { r(); fireFrame(c,x,y,r); }],
  furnace_front_lit: [furnaceLitFrame(false), furnaceLitFrame(true)],
};
P.water = ANIMATED.water[0];   // :522-525 — frame 0 is also the static painter
```
The `r()` prefix in frame 1 of water/lava/fire is a **deliberate RNG advance** so frame 1 differs from frame 0 (they'd otherwise be identical, since `animate()` reseeds per `name + ':' + frame`… note the reseed already differs, so the `r()` is redundant but harmless).

### Generated painter families
- destroy stages: `for (let s = 0; s < 10; s++) P['destroy_'+s] = …` (`:553-562`) — one deterministic `crackPattern()` (`:530`, seeded `mulberry32(0xC0FFEE)`, 6 walkers × 40 steps, memoized in `CRACKS`); stage `s` draws prefix `floor(len*(s+1)/10)`.
- crops: `wheat_0..7` (`:441-443`), `carrot_0..3` / `potato_0..3` (`:444-454`, stage `= i*2+1`, last stage adds root pixels).
- tools: `TOOL_TIERS = { wooden:'#8b6f47', stone:'#9a9a9a', iron:'#d8d8d8', golden:'#fdf55f', diamond:'#4aedd9' }` (`:567`) × `TOOL_MAPS = { sword, pickaxe, axe, shovel, hoe }` (`:837`) → **25** `item_${tier}_${shape}` painters (`:841-843`), palette from `toolPalette(color, extra={})` (`:831`): `{ H: tier, h: shadeHex(tier,0.72), S: STICK '#6b4f2a', s: STICK_S '#4a3620' }`.
- armor: `ARMOR_TIERS = { leather:'#a0522d', golden:'#fdf55f', iron:'#d8d8d8', diamond:'#4aedd9' }` (`:570`) × `ARMOR_MAPS = { helmet, chestplate, leggings, boots }` (`:845`) → **16** painters (`:849-851`), palette `{ A: color, a: shadeHex(color,0.72) }`.
- `spriteFromMap(map, palette)` (`:828`) is the wrapper: `(c,x,y) => crossSprite(c,x,y,map,palette)`.

**A new item sprite = one `P.item_<name> = …` entry.** It is auto-picked-up by `ITEM_TILES` (`atlas.js:40`) with no atlas edit. A new *block* tile additionally requires an entry in `BLOCK_TILES` (`atlas.js:9-38`) — a `P.foo` with no `TILE_NAMES` entry is never painted and `TILE['foo']` is `undefined`.

`P.item_sugar_cane = P.sugar_cane;` (`:1083`) — the one alias.

## 5. Container / screen framework — `src/ui/containers.js` (678 lines)

### 5.1 Public surface
```js
export function findRecipe(grid, gw)        // :85
export const resolveCraft = findRecipe      // :91  (alias)
export class Containers                     // :97
```
Methods other modules call: `open(kind, x, y, z)` (`:163`), `close(silent = false)` (`:179`), `isOpen()` (`:159`), `tickOpen()` (`:667`).

Constructed once: `main.js:49` `new Containers(game, screensEl)`. Reached only via `Game.openContainer(kind, x, y, z)` (`Game.js:824`) → `this.ui?.containers?.open?.(...)`.

### 5.2 The four screen kinds — hardcoded

`this.kind` is one of **`'inventory' | 'crafting' | 'furnace' | 'chest'`**. Adding a fifth (enchanting table / brewing stand) touches these exact sites:

1. **`open()` `:168-172`** — craft-grid allocation is keyed on kind:
   ```js
   if (kind === 'inventory' || kind === 'crafting') {
     this.craftW = kind === 'crafting' ? 3 : 2;
     this.craftGrid = new Array(this.craftW * this.craftW).fill(null);
   } else { this.craftGrid = null; }
   ```
2. **`build()` title map `:264`** — an object literal, **no fallback**; an unknown kind yields `title === undefined` and renders the string `"undefined"` in `.panel-title`:
   ```js
   const title = { inventory: 'Inventory', crafting: 'Crafting', furnace: 'Furnace', chest: 'Chest' }[this.kind];
   ```
3. **`build()` if/else chain `:270-359`** — one branch per kind, each pushing slot defs.
4. **`shiftTargets()` `:540-559`** — routes shift-click; has `if (this.kind === 'chest')` / `if (this.kind === 'furnace')` and falls through to `bySel(slot.region === 'hotbar' ? ['main'] : ['hotbar'])` (`:558`) for unknown kinds.
5. **`tickOpen()` `:673`** — the still-there test, with **magic numeric block ids**:
   ```js
   const stillThere = this.kind === 'furnace' ? (id === 35 || id === 36) : this.kind === 'chest' ? id === 37 : true;
   ```
   35/36 = `furnace`/`furnace_lit`, 37 = `chest` (`blocks.js:417,420,429`). Not derived from `blockEntity`/`interactable`. A new positional screen defaults to `true` — it will never auto-close on block removal.
6. **`refresh()` `:658-664`** — furnace gauge update is `if (this.kind === 'furnace' && this.be)`, reading `document.getElementById('g-flame')` / `'g-arrow'`.

### 5.3 Slot def contract

`addSlot(panel, def)` (`:366`) consumes these fields; `this.slots.push({ ...def, el })` (`:374`) — index into `this.slots` is the click/hover handle.

| field | meaning | cite |
|---|---|---|
| `x`, `y` | **absolute GUI-px, top-left INNER corner** on a 176×166 reference panel. Rendered at `left: calc(${def.x - 1} * var(--gpx))` (the −1 is the 1px border) | `:370-371` |
| `get: () => stack \| null` | **required** — reads live, never cached | `:430` |
| `set: v => void` | **required** unless `takeOnly` | `:459` |
| `region` | string, drives `shiftTargets`. Live values: `'main'`, `'hotbar'`, `'armor'`, `'offhand'`, `'craft'`, `'result'`, `'container'`, `'furnaceIn'`, `'furnaceFuel'`, `'furnaceOut'` | `:223,231,275,293,300,240,328,337,341,346` |
| `takeOnly` | routes clicks to `takeResult()`; excluded from `shiftMove` targets / `collectAll` / `numberSwap` / `offhandSwap` / `dropFromSlot` | `:436,541,566,579,592,604` |
| `canPut: stack => bool` | placement filter. Honored in left-click place (`:457`), right-click place (`:471`), `shiftMove` (`:532`), `numberSwap` (`:583`), `offhandSwap` (`:596`) — **not** in `set()` directly | |
| `placeholder` | string → `el.dataset.ph`; CSS `.slot-abs[data-ph="…"] .slot-ph` at `style.css:269-289`. Existing: `helmet`, `chestplate`, `leggings`, `boots`, `shield` | `:369,276,293` |
| `onCraft()` | called by `takeResult` for `region === 'result'` — consumes one from each non-empty grid cell | `:245-253,499` |
| `onTakeOut()` | called by `takeResult` for non-result take-only slots (furnace output XP drain) | `:348-351,506,513` |
| `slotIndex`, `hotbarIndex`, `armorIndex` | informational; `hotbarIndex` unused by the class | |

`resultDef(x, y)` (`:238`) is the reusable factory for a crafting result slot — it closes over `this.craftGrid` / `this.craftW` and `findRecipe`. A non-crafting output slot (enchant/brew result) should supply its own `takeOnly` def with `onTakeOut`, not `resultDef`.

`playerStorageDefs()` (`:215`) returns the 27 main (`x: 8 + col*18, y: 84 + row*18`) + 9 hotbar (`x: 8 + col*18, y: 142`) defs. **Every kind calls it** (`:307,321,333,358`).

Decorations: `addArrow(panel, x, y, id = null)` (`:382`) — procedural CSS arrow; passing an `id` inserts `<div id="${id}" class="arrow-fill">` for a progress gauge (furnace passes `'g-arrow'`, `:353`). `addPlayerPreview(panel, x, y, w, h)` (`:392`) — canvas silhouette, inventory only.

### 5.4 Existing geometry (GUI-px)

- inventory: armor `x:8, y:[8,26,44,62]` (`:272-273`); offhand `(77,62)` (`:293`); 2×2 craft `[[98,18],[116,18],[98,36],[116,36]]` (`:297`); result `(154,28)` (`:304`); arrow `(130,27)` (`:305`); preview `(26,8,50,70)` (`:306`).
- crafting: 3×3 at `x: 30+col*18, y: 17+row*18` (`:314`); result `(124,35)` (`:319`); arrow `(94,34)` (`:320`).
- chest: 27 at `x: 8+col*18, y: 18+row*18` (`:328`).
- furnace: in `(56,17)`, fuel `(56,53)` w/ `canPut: s => fuelValue(s.id) > 0`, out `(116,35)` takeOnly (`:337-352`); arrow `(80,34,'g-arrow')`; flame `.gauge-flame-abs` w/ `#g-flame` (`:354-357`).

CSS: `:root { --gpx: 3px }` (`style.css:209`), `.panel-abs` = `176×166 * --gpx` (`:222-223`), `.slot-abs` = `16×16 * --gpx` + 1gpx border (`:245-250`).

### 5.5 Click semantics (`onSlotClick(index, e)` `:427`)

`emitSound('ui.click', null)` fires **first, for every slot in every container** (`:434`), above the takeOnly branch. Then:
- `takeOnly` → `takeResult(slot, e.shiftKey)` → `refresh()` → return (`:436-440`).
- shift + LMB → `shiftMove(slot)` (`:442`).
- LMB: double-click within **300 ms** on the same index with a cursor → `collectAll()` (`:446`); else pick up / merge (capped at `stackMax`) / swap (`:448-461`).
- RMB: split-half `Math.ceil(count/2)` (`:465`), or place one (`:470-477`).

`takeResult` shift-craft loop is bounded at **576 iterations** (`:488`). Cursor-merge guard: refuses if `cursor.count + out.count > stackMax` (`:495`, `:508`).

Keyboard (document-level, guarded by `isOpen() && hovered != null`, `:131-141`): `Digit1..9` → `numberSwap(hovered, n)` (`:577`); `KeyF` → `offhandSwap(hovered)` (`:590`); `KeyQ` → `dropFromSlot(hovered, e.shiftKey)` (`:602`).

Click on `#container-root` background with a cursor stack → throw (LMB whole / RMB one), `:142-155`.

### 5.6 Lifecycle

`open()` calls `this.close(true)` first (`:164`), sets `this.be = this.pos ? this.game.getBlockEntity(x, y, z) : null` (`:167`), `build()`, adds `.visible`, then `this.game.onContainerOpened?.()` (`:176`).

`close(silent=false)` (`:179`): returns craft grid to inventory via `p.give()` + `game.throwStack()` for leftovers (`:185-193`), then the cursor (`:194-198`), then nulls kind/pos/be, then `emitSound('block.chest.close', …)` if `wasChest && chestPos && !silent` (`:207`), then `this.game.onContainerClosed?.()` if `!silent` (`:210`).

`tickOpen()` (`:667`): if positional, closes when `d > 8` (measured to `p.pos.y + 1`) or `!stillThere` (`:671-675`); refreshes every 4 world ticks (`:676`).

Host hooks live in `main.js`: `game.onContainerOpened` → `exitPointerLock` + `setState(STATE.PLAYING_UI)` (`:126-129`); `game.onContainerClosed` → back to `PLAYING` + `requestLock()` (`:130-135`); `game.closeContainerScreen = () => containers.close()` (`:136`). `onStateChange` force-closes on any exit from `PLAYING_UI` (`main.js:119`).

**Note:** `containers.js:8` imports `audio` from `../audio/engine.js` but never uses it (unused import).

### 5.7 Block-entity path (what a new container needs)

**There is no block-entity registry.** `Game.getBlockEntity(x, y, z)` (`Game.js:455-470`) hardcodes a **ternary over exactly two types**:
```js
be = kind === 'chest'
  ? { type: 'chest', data: { slots: new Array(27).fill(null) } }
  : { type: 'furnace', data: { slots: new Array(3).fill(null), burn: 0, fuelTotal: 0, cook: 0, xpBank: 0 } };
```
Any `blocks.js` entry with a `blockEntity` string other than `'chest'` **falls into the furnace branch** and silently gets furnace data. Ticking is likewise hardcoded: `tickBlockEntities` (`Game.js:472`) filters `if (be.type !== 'furnace') continue;` (`:480`) then `tickFurnace(be.data, x, y, z, chunk)` (`Game.js:490`). `spillBlockEntity` (`Game.js:~532`) drops anything with `data.slots`, so a new container's inventory spills for free.

Persistence: mutations must call `this.markBeDirty()` (`containers.js:419`), which sets `chunk.modified = true` on the containing chunk.

Interaction dispatch: `blocks.js` field `interactable` (string), switched in `interaction.js:457-471`:
```js
case 'crafting': g.openContainer('crafting'); break;
case 'furnace':  g.openContainer('furnace', hit.x, hit.y, hit.z); break;
case 'chest':    /* blocked if opaque above */ g.openContainer('chest', ...); break;
case 'bed':      g.trySleep(...); break;
case 'door':     this.toggleDoor(...); break;
```
Gated upstream by `if (block.interactable && !p.sneaking)` (`interaction.js:394`).

**Summary of the add-a-screen checklist (all real sites):** `blocks.js` (`interactable`, `blockEntity`, `tiles`/`tilesFor`) → `Game.getBlockEntity` ternary → `Game.tickBlockEntities` type filter → `interaction.js` switch → `containers.js` `open()` grid alloc, `build()` title map, `build()` if/else branch, `shiftTargets()`, `tickOpen()` `stillThere` ids, `refresh()` gauges → `style.css` for any new gauge/placeholder.

### 5.8 Recipe matching (`findRecipe`)

`findRecipe(grid, gw)` (`:85`) linearly scans `RECIPES`, dispatching on `r.shaped`:
- `matchShaped(recipe, grid, gw)` (`:46`) — compares the grid's non-empty bounding box (`gridBounds :17`) against the **trimmed pattern** bounding box (`patternBounds :31`, memoized as `recipe._pb` at `:50`), then tries unmirrored then mirrored (`:68`). `recipe.key[ch]` is an **array of ids**; match is `ids.includes(cell.id)`.
- `matchShapeless(recipe, grid)` (`:71`) — exact count match, greedy pool consume.
- Consumption is always "one from each non-empty cell" (`:245-252`), hardcoded in `resultDef.onCraft`.

Locals: `stackMax = id => ITEMS.get(id)?.stack ?? 64` (`:10`), `same = (a,b) => a && b && a.id === b.id && (a.damage ?? 0) === (b.damage ?? 0)` (`:11`) — **`same` ignores every field but id+damage**, so any future NBT/enchantment data would merge incorrectly.

## 6. HUD — `src/ui/hud.js` (210 lines)

```js
export function iconCss(el, tile)              // :6
export function tileForItemId(game, id)        // :13
export class Hud                               // :21
```

`iconCss(el, tile)` (`:6-11`): adds class `icon`, sets `backgroundPosition` to `calc(-16 * ${col} * var(--px)) calc(-16 * ${row} * var(--px))` where `col = tile & 31, row = tile >> 5`. The atlas image itself comes from CSS `--atlas-url` (set at `main.js:28`); `.icon` is `16*--px` square with `background-size: calc(512 * var(--px))` (`style.css:33-37`). `:root { --px: 3px }` (`style.css:3`).

`tileForItemId(game, id)` (`:13-19`) resolution order: `item.sprite` → `game.atlas.TILE[item.sprite]`; else `item.place != null` → `BLOCKS[item.place]?.tileIndex[4]` (**face 4 = +Z / south**); else `0` (missing).

### DOM structure (`overlayEl.innerHTML`, `:25-47`)
```
#hud
  #crosshair
  #vignette-damage
  #overlay-fire
  #overlay-water
  #status-rows
    .row-pair > #armor-row.row-half + #air-row.row-half
    .row-pair > #hearts-row.row-half + #hunger-row.row-half
    #xp-bar > #xp-fill + #xp-level
  #hotbar
  #item-name
  #toast
  #sleep-fade
  #debug-badge      ("DEBUG CREATIVE (F4)")
```
`this.el` map at `:48-64` (keys: `hearts, hunger, armor, air, xpFill, xpLevel, hotbar, itemName, toast, vignette, fire, water, sleep, badge, hud`).

**9 hotbar slots** built in the constructor (`:66-72`), each `.hotbar-slot` → `<div class="slot-icon"></div><div class="slot-count"></div><div class="dur-bar"><div></div></div>`. **4 pip rows of 10** each via `pips(rowEl, n)` (`:73-76, :82`).

### Public methods
`onDamage()` (`:90`) — `damageFlash = 10`, vignette opacity 1 → 0 after **250 ms**.
`onHotbarChange()` (`:96`) — shows `ITEMS.get(s.id)?.displayName`, fades after **2000 ms**.
`toast(msg)` (`:108`) — fades after **2500 ms**. Exposed as `game.ui.toast` (`main.js:102`).
`setSleepFade(on)` (`:115`).
`setDirty(key, value)` (`:117`) — the dirty-check primitive; returns false if unchanged.
`update()` (`:123`) — called per frame.

### `update()` element-by-element
| element | dirty key | signature | behavior |
|---|---|---|---|
| hearts | `'hp'` | `hp + '|' + p.hurtTime` | 10 pips, `hp = Math.ceil(p.health)`, 2 HP/heart. Glyphs `'❤'` / `'❥'` / `'❤'`; **full and empty use the same glyph** — the state is carried by `style.color` `#e0241c` vs `#3a0d0d` (`:133-134`). Shake: `translateX(±2px)` while `hurtTime > 0` (`:136`) |
| hunger | `'food'` | `food + '|' + (p.foodPoisonTicks > 0)` | glyphs `'🍗'`/`'🍖'`/`'·'`; poison → `filter: hue-rotate(90deg)` (`:147`) |
| armor | `'armor'` | `p.armorPoints()` | row `display: none` when `ap === 0` (`:156`); `'🛡'`/`'◗'`/`''` |
| air | `'air'` | `bubbles` | `bubbles = p.air >= 300 ? -1 : Math.ceil(max(0,p.air)/30)` (`:164`); hidden at −1; `'🫧'` |
| XP | `'xp'` | `fill + '|' + p.xpLevel` | `fill = floor(p.xpPoints / p.xpToNext(p.xpLevel) * 100)`; level text blank at 0 (`:175`) |
| hotbar ×9 | `'hb'+i` | `${s.id}|${s.count}|${s.damage ?? ''}|${i === p.selectedSlot}` or `e|${…}` | `.selected` class; count hidden at 1; durability bar shown iff `item?.durability && s.damage > 0`, width `(1 - damage/durability)*100%`, color `hsl(${f*120}, 90%, 45%)` (`:191-195`) |
| fire overlay | `'fire'` | `p.fireTicks > 0 && p.gameMode !== 'debugCreative'` | |
| water overlay | `'eye'` | `p.eyeSubmerged` | |
| debug badge | `'mode'` | `p.gameMode` | shown iff `'debugCreative'` |

All HUD status glyphs are **emoji/unicode text**, not atlas tiles — only hotbar icons use `iconCss`.

## 7. F3 overlay — `src/ui/debug.js` (50 lines)

```js
export class DebugOverlay {
  constructor(game, overlayEl)   // :5 — creates div#debug-overlay, appends to overlayEl
  toggle()                       // :14 — flips this.visible, sets display block/none
  update()                       // :19
}
```
Bound at `main.js:48` (`new DebugOverlay(game, overlayEl)`) and `main.js:140` (`if (code === 'F3') debug.toggle();`).

`update()` early-returns if `!this.visible` (`:20`) and throttles to **250 ms = 4 Hz** (`:22-23`). Guards `if (!p || !g.world) return` (`:26`). Writes **one `textContent`** template literal (`:39-48`) — **8 lines**, exactly:

```
1  ClaudeCraft F3 | ${g.debug.fps} fps ${g.debug.frameMs.toFixed(1)} ms
2  XYZ ${p.pos.x.toFixed(2)} / ${p.pos.y.toFixed(2)} / ${p.pos.z.toFixed(2)}
3  chunk ${x >> 4},${z >> 4} facing ${facing} biome ${biome}
4  light sky ${g.world.getSkyLight(x,y,z)} block ${g.world.getBlockLight(x,y,z)} darken ${g.world.skyDarken}
5  chunks R${counts.requested} G${counts.generated} L${counts.lit} M${counts.meshed} F${counts.failed} | remeshQ ${g.chunkManager.remeshQueue.size}
6  draws ${info.render.calls} tris ${(info.render.triangles/1000).toFixed(0)}k geoms ${info.memory.geometries}
7  entities ${g.entities.count()} time ${g.world.time} (day ${floor(time/24000)} ${(floor((time%24000)/1000)+6)%24}:00)${heap}
8  weather ${g.dayNight.raining ? 'rain' : 'clear'}${g.dayNight.thundering ? '+thunder' : ''} seed ${g.world.seedString}
9  audio ${a.voices}/${g.audio?.poolSize?.() ?? 0} voices drops ${a.drops}/s ${a.state} ${a.budgetMs.toFixed(2)} ms music ${music}
```
(9 template lines; line 1 is the header.)

Precomputed locals: `counts = g.chunkManager.countByState()` (`:28`), `info = g.renderer.info` (`:29`), `facing` from `['S +Z','W -X','N -Z','E +X'][round(((-p.yaw % 2π) + 2π)/(π/2)) % 4]` (`:30-31`), `heap` from `performance.memory.usedJSHeapSize / 1048576` when available (`:32-33`), `biome = BIOME_NAMES[g.world.biomeAt(x,z)] ?? '?'` (`:34`), audio `a = g.audio?.debug ?? { voices:0, drops:0, state:'off', budgetMs:0 }` (`:36`), `music = mus?.piece ? \`${mus.piece.mood}#${mus.pieceIndex - 1}\` : 'silent'` (`:38`).

**Constraint documented in-file (`:35`):** "16 §6: read-only — this is render code and must never emitSound (§5.1)."

Adding an F3 line = extending this one template literal. There is no line registry, no `addLine` API.

## 8. Menus — `src/ui/menus.js` (400 lines)

```js
export class Menus { constructor(game, screensEl, hooks) }   // :18
```
Built at `main.js:61` with a `hooks` object. Hooks consumed: `onNewWorld(seed)` (`:163`), `onContinue()` (`:164`), `onDelete()` (`:165`), `onResume()` (`:171`), `onQuit()` (`:172`, also `btn-death-title` `:174`), `onRespawn()` (`:173`), `onOptions?.(options)` (`:225`).

Public methods: `applyOptions()` (`:222`), `applyMusicMode()` (`:230`), `attachMusic(music)` (`:237`), `pressStart()` (`:243`), `resetTitle()` (`:256`), `showSettings(on)` (`:265`), `applyTitleButtons()` (`:331`), `setHasSave(has)` (`:339`), `show(name)` (`:344`), `setLoadingProgress(meshed, needed)` (`:367`), `setPaletteVisible(on)` (`:373`), `fillPalette()` (`:378`).

Screens injected via one `insertAdjacentHTML('beforeend', …)` (`:28-130`): `#screen-title`, `#screen-loading`, `#screen-pause`, `#screen-death`, `.cc-settings#cc-settings`, `#debug-palette`.

`show(name)` (`:344`) toggles `.visible` across exactly `['title','loading','pause','death']` (`:345-347`); `show(null)` hides all (the PLAYING state). Driven from `main.js:105-110` `onStateChange`.

**Options panel is deliberately top-level, not nested in `#screen-title`** (`:85-87`) — `.screen{display:none}` would make it unreachable from PAUSE. `.over-pause` class swaps the opaque desert sheet for a scrim (`:270`).

`OPT_ROWS = [['master','Master'],['music','Music'],['ambient','Ambient'],['sfx','SFX'],['ui','UI']]` (`:9-12`) — five audio buses, 0–100 sliders. `THEME_MODES = [['off','Off'],['menu','Menu only'],['full','Menu + gameplay']]` (`:14-16`). Plus `opt-mouseSensitivity` (0.1–3, step 0.05) and `opt-viewBobbing` (checkbox).

`applyOptions()` (`:222`) is the **single writer**: `audio.setOptions` → `music?.setOptions` → `hooks.onOptions?.` → `saveOptions`. Options object is **shared with Game** (`this.options = game.options ?? loadOptions()`, `:27`) — a second `loadOptions()` would diverge.

Every button is wrapped by `btn(id, fn)` (`:154-160`) which does `audio.unlock(); emitSound('ui.click', null); fn(e);` synchronously inside the handler. `this.el.start.onclick` is the one exception, bound directly to `pressStart()` (`:162`), which unlocks internally (`:246`).

F4 palette (`:373-399`): `#debug-palette` is inline-styled (`:124-130`), 7×48px grid, filters by `item.name.includes(filter)`, built lazily once (`paletteBuilt`, `:375`). Click gives `item.stack ?? 64`; RMB gives 1 (`:393`). Guarded to `p.gameMode === 'debugCreative'` (`:392`). Visibility derived in `main.js:121-122` and `main.js:146`.

Keyboard: `_onTitleKey` (`:288`, scoped to `#screen-title` so it can't swallow in-game keys), `_onSettingsKey` (`:293`, Escape closes), `_roveOrTrap(e, scope)` (`:302`) — Tab focus-trap for the modal (queries `'button, input, select'`, `:309`), Arrow rove for buttons, arrows pass through to `INPUT`/`SELECT` (`:318-319`).

`__APP_VERSION__` is a build-time define used at `:42`.

## 9. DayNight — `src/env/DayNight.js` (388 lines)

```js
export function celestialAngle(t)     // :20 — f = frac(t/24000 - 0.25); g = 0.5 - cos(f·π)/2; return (f*2 + g)/3
export class DayNight { constructor(game) }   // :85
```
Module-private: `starBrightness(t)` (`:27`), `sunriseColor(t)` (`:34`, returns `null` outside `|cos| ≤ 0.4`), `keyframeAt(dayTime, out)` (`:62`), `weatherTint(color, rainLevel, thunderLevel)` (`:77`).

### Fields
`sky` (a `Sky`), `scene`, `world`, `game`; weather: `raining`, `thundering`, `rainTimer`, `thunderTimer`, `rainLevel`, `thunderLevel` (`:93-98`); `flashTicks`, `lightningMeshes` (`:100-101`); `kf = { zenith, horizon, fog, sunIntensity, ambient }` (`:102-105`); `skyTint`, `fogColor` (`:106-107`); `moonPhase` (`:110`). `scene.fog = new THREE.Fog(0xc0d8ff, 96, 128)` (`:108`).

Initial timers: `randInt(12000, 180000)` for both (`:95-96`).

### Getters / API
| member | cite | value |
|---|---|---|
| `get dayTime()` | `:115` | `world.time % 24000` |
| `get dayCount()` | `:116` | `floor(world.time / 24000)` |
| `get isThunderstorm()` | `:117` | `raining && thundering` |
| `get isDay()` | `:118` | `world.skyDarken < 4` |
| `randInt(a, b)` | `:113` | uses `world.rng()` |
| `moonBrightness()` | `:120` | `MOON_BRIGHTNESS[dayCount % 8]`, `= [1.0,0.75,0.5,0.25,0.0,0.25,0.5,0.75]` (`:58`) |
| `computeSkyDarken(t, floor = true)` | `:123` | `day = 0.5 + 2*clamp(cos(a·2π), -0.25, 0.25)`; `rainMul = 1 - rainLevel*5/16`; `thunderMul = 1 - thunderLevel*5/16`; `v = (1 - day*rainMul*thunderMul) * 11` |
| `tick()` | `:132` | `world.time++`, recompute `world.skyDarken`, weather machine, `snowIceLoop`, `lightningLoop`, `tickLightningMeshes` |
| `temperatureAt(x, y, z)` | `:156` | `(BIOME_TEMPS[biome] ?? 0.8) - max(0, y - 80) * 0.00125` |
| `isRainingAt(x, y, z)` | `:161` | `raining && canSeeSky && temp > 0.15` |
| `isSnowAtColumn(x, z)` | `:167` | `temperatureAt(x, heightTop(x,z), z) <= 0.15` |
| `snowIceLoop()` | `:172` | per SIM_RADIUS chunk, `1/16` chance; ICE if water below + `blockLight < 10`; SNOW_LAYER if air + `isSolidSupport` + `blockLight < 10` |
| `lightningLoop()` | `:199` | per SIM_RADIUS chunk, `rng() >= 1/100000` → skip |
| `strikeLightning(x, y, z)` | `:216` | `flash(3)`, `emitSound('weather.thunder', at(x,y,z))`, 4-segment 16m box column (life 6), `lightningIgnite(w, floor(x), y, floor(z))`, 10 dmg + `fireTicks = max(fireTicks, 160)` to LivingEntities in a ±3 AABB |
| `flash(ticks)` | `:267` | `flashTicks = max(flashTicks, ticks)` |
| `canSleepNow()` | `:270` | `isThunderstorm \|\| world.skyDarken >= 4` |
| `sleepSkip()` | `:275` | snaps `world.time` to next `*24000`, clears rain/thunder, re-rolls timers, recomputes skyDarken |
| `updateRender(alpha, camera)` | `:288` | see below |
| `serialize()` / `deserialize(rec)` | `:369` / `:377` | 6 weather fields only — **no `time`** (that lives on `world`) |
| `dispose()` | `:387` | `this.sky.dispose()` |

Weather machine (`:137-146`): rain toggles on `--rainTimer <= 0`, next timer `randInt(12000,24000)` if now raining else `randInt(12000,180000)`; thunder `randInt(3600,15600)` / `randInt(12000,180000)`. `rainLevel`/`thunderLevel` ramp **±0.01 per tick**, clamped 0..1 (100 ticks = 5 s to full).

### Sky keyframes (`KEYS`, `:44-56`)
`[dayTime, zenith, horizon, fog, sunIntensity, ambient]`, 11 rows, last wraps to key 0:
```
0     0x4A73C4 0xFFB877 0xC7A177 0.45 0.45
1000  0x78A7FF 0xC6DBFF 0xC0D8FF 1.00 0.90
6000  0x78A7FF 0xC6DBFF 0xC0D8FF 1.00 0.90
11000 0x78A7FF 0xC6DBFF 0xC0D8FF 0.95 0.85
12000 0x6E9BF2 0xE8C79E 0xD6B489 0.75 0.65
12786 0x2E3D74 0xFF9040 0x9E7052 0.35 0.35
13670 0x050815 0x131A33 0x0C101F 0.08 0.14
18000 0x000208 0x0A0F22 0x060912 0.06 0.12
22331 0x0A1030 0x1B2447 0x121830 0.10 0.16
23215 0x274073 0xE2894C 0x8F6E51 0.30 0.32
24000 0x4A73C4 0xFFB877 0xC7A177 0.45 0.45
```
`keyframeAt` does a linear scan + `lerp` into `out` (`:62-74`), reusing `cScratch` (`:60`).

### `updateRender(alpha, camera)` (`:288-367`) — the per-frame contract
1. `dtSec = min(0.1, (now - lastFrameTime)/1000)` (`:290`).
2. `t = world.time + alpha`; `angle = celestialAngle(t)`; `skyDarkenF = computeSkyDarken(t, false)`; **`if (flashTicks > 0) skyDarkenF = 0`** (`:297`).
3. `keyframeAt` → `weatherTint` on zenith/horizon/fog (`:299-302`).
4. `sunIntensity = kf.sunIntensity * (1 - 0.65*rainLevel) * (1 - 0.5*thunderLevel)`; `ambient = kf.ambient * (1 - 0.5*rainLevel)` (`:303-305`). Flash lerps zenith/horizon 50% to white and forces `sunIntensity = 1` (`:306-310`).
5. `skyTint` (`:313-315`): `dayFactor = clamp((15 - skyDarkenF)/15, 0, 1)`, smoothstep `e2`, `setRGB(lerp(0.65,1,e2), lerp(0.72,1,e2), lerp(1.0,1,e2))`.
6. Fog (`:318-329`): `rEff = RENDER_RADIUS*16 * lerp(1,0.85,rainLevel) * lerp(1,0.75,thunderLevel)`; `fogNear = 0.75*rEff`, `fogFar = rEff`. Camera in `B.WATER` → `0x050533`, near 0, far 32; in `B.LAVA` → `0x991900`, near 0.25, far 1.0; both set `underFluid = true`.
7. **Writes the shared chunk uniforms** (`:332-336`): `uSkyDarken`, `uSkyTint`, `uFogColor`, `uFogNear`, `uFogFar` — plus `scene.fog.color/near/far` (`:337-339`). This is the *only* writer of `sharedUniforms` outside `createChunkMaterials`.
8. Moon phase changes → `sky.setMoonPhase(phase)` (`:342-346`).
9. `sunDir = { x: -sin(a2), y: cos(a2), z: 0 }` (`:349`), then `sky.update({...})` (`:350-365`) with the payload below.
10. `if (sunDir.y <= 0) this.sky.sunLight.intensity = sunIntensity * 0.25;` — moonlight (`:366`), applied **after** `sky.update` already set intensity.

### `sky.update` payload (the DayNight↔Sky contract, `:350-365`)
```js
{ camera, angle,
  zenith: underFluid ? this.fogColor : this.kf.zenith,
  horizon: underFluid ? this.fogColor : this.kf.horizon,
  starAlpha: starBrightness(t) * (1 - this.rainLevel),
  sunAlpha: 1 - this.rainLevel,
  sunrise: sunriseColor(t),                       // null outside the window
  cloudTint: (0.16 + 0.84 * sunIntensity) * (1 - 0.3 * this.rainLevel),
  sunIntensity, ambient,
  sunDir: sunDir.y > 0 ? sunDir : { x: -sunDir.x, y: -sunDir.y, z: 0 },
  world: this.world,
  rainLevel: this.rainLevel,
  moonBright: this.moonBrightness(),
  isSnowAt: (x, z) => this.isSnowAtColumn(x, z),
  dtSec }
```
Called from `Game.js:264`: `this.dayNight.updateRender(alpha, this.camera)`.

## 10. Sky — `src/render/Sky.js` (297 lines)

```js
export class Sky {
  constructor(scene)                  // :21
  setMoonPhase(phase)                 // :207
  update({ camera, angle, zenith, horizon, starAlpha, sunAlpha, sunrise,
           cloudTint, sunIntensity, ambient, sunDir, world, rainLevel, isSnowAt,
           moonBright = 1, dtSec })   // :212
  dispose()                           // :288
}
```
`R_SKY = 400` (`:6`). Private helper `makeCanvasTexture(w, h, paint)` (`:8`) — NearestFilter, no mipmaps, `NoColorSpace`.

Scene graph:
- `this.group` (`:22`) — `renderOrder = -10`, repositioned to `camera.position` every frame (`:214`). Holds `dome`, `pivot`, `band`.
- `this.dome` (`:40`) — `IcosahedronGeometry(400, 2)`, `BackSide`, `depthWrite: false`, `fog: false`, `renderOrder = -10`, `frustumCulled = false`. Uniforms `uZenith` / `uHorizon` are **bound to `this.zenith` / `this.horizon` `THREE.Color` instances** (`:30`), which `update()` `.copy()`s into (`:217-218`) — never reassign them.
- `this.pivot` (`:46`) — `rotation.z = angle * 2π` (`:215`). Holds sun, moon, stars.
- `this.sun` (`:68`) — `PlaneGeometry(240,240)` at `(0, 400, 0)`, additive, `renderOrder = -9`. Texture: 32×32 rounded-square, LinearFilter (`:62-63`).
- `this.moon` (`:100`) — `PlaneGeometry(160,160)` at `(0, -400, 0)`. Texture: **128×64, 4×2 phase sheet**, `repeat.set(0.25, 0.5)` (`:95`). Phase 4 = new moon (`rgba(26,26,42,0.25)`, `:80`).
- `this.stars` (`:123`) — `Points`, **1500** verts on a sphere of `R_SKY*0.9`, seeded `mulberry32(xmur3('stars')())` (`:107`), `size 1.8`, additive, `opacity` driven by `starAlpha`, `frustumCulled = false`.
- `this.band` (`:139`) — `CircleGeometry(140, 12)`, radial-fade shader, additive, added to `group` (not pivot). Positioned at `±R_SKY*0.9` on X depending on `rising = angle > 0.5` (`:240-242`); `visible = false` when `sunrise` is null (`:245`).
- `this.clouds` (`:167`) — **added directly to `scene`, not `group`** (`:172`). `PlaneGeometry(3072,3072)`, `y = 110`, `renderOrder = -8`, `frustumCulled = false`, `alphaTest 0.1`, `opacity 0.75`. Texture 256×256 seeded value noise on a 32×32 grid thresholded at `v > 0.58` (`:157`). Snapped to a **12 m grid**: `position.x = floor(camera.x/12)*12` (`:250`); `cloudDrift += 0.02 * dtSec * 20` (`:249`).
- `this.sunLight` = `DirectionalLight(0xffffff, 1.0)`, `this.ambient` = `AmbientLight(0xffffff, 0.9)` (`:176-178`) — **entity lighting only**; chunks use the shader.
- `this.rain` (`:188`) — `InstancedMesh(PlaneGeometry(0.32, 0.6), rainMat, 750)`, `DynamicDrawUsage`, `count = 0`, `frustumCulled = false`, added to `scene`. `rainDrops` = 750 `{x, z, y, snow, drift}` seeded from `xmur3('rain')` in a ±12 box (`:194-200`).

`update()` behavior worth citing:
- Horizon gates: `sunY = cos(angle*2π)`; `sun.visible = sunY > -0.3`; `moon.visible = -sunY > -0.3` (`:222-224`).
- `sunMat.color.setRGB(sunIntensity, sunIntensity, sunIntensity * 0.898)` (`:229`); sunrise warms it: `color.g *= 1 - 0.35*sunrise.a`, `color.b *= 1 - 0.6*sunrise.a` (`:231-232`).
- `moonMat.opacity = sunAlpha * (0.6 + 0.4 * moonBright)` (`:234`).
- Rain (`:261-285`): `visible = floor(750 * rainLevel)` → `rain.count`. Per drop: `fall = snow ? 2 : 14` m/s; respawn at `y = 16` when below ground or `y < 0`; snow drifts `sin(d.drift + d.y) * 0.5` and scales 0.5. Billboards via `_q.setFromAxisAngle(UP, atan2(camX - px, camZ - wz))` (`:279`). Requires `world.heightTop(x, z)` (`:273`).

**Dead code:** `Sky.js:266` — `const yaw = Math.atan2(camera.position.x - (camX + 1), 0);` is computed and never used; it also evaluates to `atan2(-1, 0)` = a constant `-π/2`, since `camX === camera.position.x`.

`dispose()` (`:288`) removes `group`, `clouds`, `rain`, `sunLight`, `ambient` from their parents but **disposes no geometries, materials, or textures**.

## 11. Particles — `src/render/Particles.js` (111 lines)

```js
export class Particles {
  constructor(scene)                                          // :10
  obtain(mesh)                                                // :17
  spawn(mesh, x, y, z, vx, vy, vz, life, gravity = 0.04)      // :23
  colored(color, size = 0.1)                                  // :30
  blockBreak(x, y, z, blockId)                                // :37
  crit(target)                                                // :50
  explosion(x, y, z, power)                                   // :62
  hearts(x, y, z)                                             // :75
  teleport(x, y, z, height = 2.9)                             // :81
  update()                                                    // :91
  dispose()                                                   // :107
}
```
`const MAX = 256` (`:7`) — `spawn` silently drops when `this.active.length >= MAX` (`:24`).

Effect parameters:
| method | count | color/geom | life (frames) | gravity |
|---|---|---|---|---|
| `blockBreak` | 16 | `blockCubeGeometry(blockId, 0.1)` + `makeAtlasMaterial()` | `10 + rng()*10\|0` | 0.04 (default) |
| `crit` | 8 | `0x332211`, size 0.06 | `10 + rand*6\|0` | 0.01 |
| `explosion` | 24 | gray `0.4 + rand*0.5`, size 0.25 | `14 + rand*10\|0` | 0.002 |
| `hearts` | 1 | `0xd0342c`, size 0.09 | 16 | **−0.001** (floats up) |
| `teleport` | 12 | `0xe079fa`, size 0.06 | `14 + rand*8\|0` | 0.001 |

`update()` (`:91-105`): position += v; `vy -= gravity`; drag `vx *= 0.95; vy *= 0.98; vz *= 0.95`; on `--life <= 0` remove from scene and `if (p.mesh.material.map == null) p.mesh.material.dispose()` (`:101`) — i.e. **only non-atlas materials are disposed**; `blockBreak`'s `makeAtlasMaterial()` results leak by design (shared map).

Real problems worth citing before extending:
- **`update()` takes no parameters** but `Game.js:266` calls `this.particles.update(alpha)`. All velocities/lives are **per-frame, not per-tick** — particle behavior is framerate-dependent.
- **`obtain(mesh)` (`:17`) and `this.pool` (`:12`) are dead** — nothing in the repo calls `obtain`, and `pool` is never pushed to. Despite the file header ("Tiny **pooled** cube-sprite particles"), there is no pooling: `colored()` allocates a fresh `MeshBasicMaterial` per particle (`:31`).
- **`import { BLOCKS } from '../registry/blocks.js'` (`:4`) is unused.**
- `spawn()` calls `this.scene.add(mesh)` (`:27`) and `obtain()` would add it a second time.
- `dispose()` (`:107`) removes meshes from the scene but disposes no materials or `colorGeo`.

Callers: `Game.js:622` (`explosion`), `Mob.js:100,104` (`hearts`), `Enderman.js:147,155` (`teleport`), `interaction.js:176` (`crit`), `interaction.js:218,296` (`blockBreak`) — all optional-chained (`game.particles?.crit?.(…)`).

## 12. Cross-cutting boot order (`src/main.js`)

```
:26  const atlas = buildAtlas();
:27  finalizeBlockTiles(atlas.TILE);          // must precede any tileIndex read
:28  document.documentElement.style.setProperty('--atlas-url', `url(${atlas.atlasDataURL})`);
:47  const hud = new Hud(game, overlayEl);          // overlayEl = #overlay
:48  const debug = new DebugOverlay(game, overlayEl);
:49  const containers = new Containers(game, screensEl);   // screensEl = #screens
:61  const menus = new Menus(game, screensEl, { …hooks });
:100 game.ui = { hud, menus, containers, debug, toast, setSleepFade, setLoadingProgress, onStateChange };
```
In `Game`: `this.atlas = atlas` (`Game.js:47`), `this.materials = createChunkMaterials(atlas.texture)` (`:56`), `this.particles = new Particles(this.scene)` (`:101`). `ChunkManager` builds `this.mesher = new ChunkMesher(tileUV)` (`ChunkManager.js:17`).

Per-tick: `atlas.animate?.(world.time)` (`Game.js:211`), `ui.containers.tickOpen()` (`:212`), `dayNight.tick()` (`:201`).
Per-frame: `dayNight.updateRender(alpha, camera)` (`Game.js:264`), `particles.update(alpha)` (`:266`).

Destroy-stage overlay reads `this.atlas.TILE['destroy_' + stage] ?? 0` (`Game.js:369`). `ItemEntity.js` keeps its own module-level `ATLAS` (`:11`) and mirrors `tileForItemId`'s sprite lookup at `:76`.


<!-- ===== a5d9b4b71bc050c8c ===== -->
I have complete coverage of the subsystem and its consumers. Writing the map.

# Worldgen + Worker Integration Map — `src/world/gen/*`, `src/workers/*`

## 1. Module inventory & dependency graph

| File | Lines | Imports (local) | Imported by |
|---|---|---|---|
| `src/world/gen/biomes.js` | 116 | **none** (leaf module, `biomes.js:2`) | `noise.js:13`, `caves.js:15`, `ores.js:7`, `features.js:6`, `terrain.js:10`, `ui/debug.js:2`, `world/fire.js:9`, `env/DayNight.js:9` |
| `src/world/gen/noise.js` | 291 | `math/rng.js`, `biomes.js` | `terrain.js:6` **only** |
| `src/world/gen/terrain.js` | 106 | `math/rng.js`, `noise.js`, `caves.js`, `ores.js`, `features.js`, `biomes.js` | `workers/terrainWorker.js:6` **only** |
| `src/world/gen/caves.js` | 182 | `math/rng.js`, `biomes.js` | `terrain.js:7` |
| `src/world/gen/ores.js` | 99 | `math/rng.js`, `biomes.js` | `terrain.js:9` |
| `src/world/gen/features.js` | 295 | `math/rng.js`, `biomes.js` | `terrain.js:9`, `Game.js:25` |
| `src/workers/terrainWorker.js` | 33 | `world/gen/terrain.js` | instantiated at `ChunkManager.js:35` |

`src/workers/` contains exactly one file. The gen subsystem's only cross-thread-shared dependency is `src/math/rng.js` (declared pure: `rng.js:2`).

**Main-thread consumers of gen** (the only four): `Game.js:25` → `placeTree`; `ui/debug.js:2` → `BIOME_NAMES`; `world/fire.js:9` → `BIOMES`; `env/DayNight.js:9` → `BIOME_TEMPS`. `noise.js`, `caves.js`, `ores.js` are **worker-only** — nothing on the main thread imports them.

## 2. Seed-stream RNG pattern (02 §2)

### Primitives (`src/math/rng.js`)
```js
export function xmur3(str)                       // rng.js:6   → seed-generator fn
export function mulberry32(a)                    // rng.js:19  → float [0,1)
export function hashString(s)                    // rng.js:29  FNV-1a 32, h=0x811c9dc5, prime 0x01000193
export function mix32(h)                         // rng.js:39  murmur3 finalizer, 0x85ebca6b / 0xc2b2ae35
export function splitmix32(a)                    // rng.js:46  gamma 0x9e3779b9, 0x21f0aaad / 0x735a2d97
export function chunkSeed(sysSeed, cx, cz)       // rng.js:55
export function posHash(seed, x, y, z)           // rng.js:63  stateless → float [0,1)
export function triSample(rng, lo, peak, hi)     // rng.js:72  asymmetric triangular
export const rngInt = (rng, n) => Math.floor(rng() * n);        // rng.js:79
export const rngRange = (rng, a, b) => a + rng() * (b - a);     // rng.js:80
export const tsin = a => SIN[((a * 651.8986469) | 0) & 4095];   // rng.js:85
export const tcos = a => SIN[(((a * 651.8986469) | 0) + 1024) & 4095];  // rng.js:86
```
`SIN` is a 4096-entry `Float32Array` built at module load (`rng.js:83-84`). `tsin`/`tcos` exist so carver/vein stepping is bit-identical across engines — `Math.sin` is not. **Any new structure generator that walks a path must use `tsin`/`tcos`, not `Math.sin`.**

### The four-level hierarchy

1. **World seed** — `terrain.js:15-17`:
   ```js
   const worldSeed = typeof seed === 'number' ? (seed >>> 0) : hashString(String(seed ?? ''));
   ```
2. **System sub-seeds** — `noise.js:120-123`. Exactly **seven** streams, no more:
   ```js
   for (const s of ['terrain', 'carver', 'ore', 'tree', 'plant', 'herd', 'detail'])
     seeds[s] = mix32(worldSeed ^ hashString('sys:' + s));
   ```
   Exposed as `ctx.seeds` (`noise.js:287`). **There is no `structure` stream.** A new subsystem adds its name to this array; the derivation is order-independent (keyed by string), so inserting a name does **not** shift existing streams.
3. **Per-chunk stream** — `splitmix32(chunkSeed(ctx.seeds.<sys>, ocx, ocz))`. Instances: `caves.js:62-63`, `ores.js:33`, `features.js:103` (tree), `features.js:124` (plant), `features.js:270` (herd).
4. **Stateless per-position** — `posHash(seed, x, y, z)`, always on `ctx.seeds.detail`: `terrain.js:46` (bedrock jaggedness), `ores.js:71` (ore air-exposure discard), `features.js:35` (leaf corners), `features.js:198` (dandelion vs poppy).

### The two invariants that make neighborhood re-simulation work

Chunk C is generated by enumerating origin chunks in a radius around C and writing only cells inside C. Every origin chunk is therefore re-simulated by many different chunks, which must all agree.

- **Invariant A — draws are always consumed in spec order, regardless of skip decisions.** `caves.js:64-78` draws *all* worm parameters (`sx, sz, y, pitch, yaw, thick, length`) before the reach test at `caves.js:79`. `features.js:111-112` comments `// roll always drawn` / `// draw kept aligned` — species and height are drawn *before* the ground/surface rejections at `features.js:114-117`. `ores.js:39-42` draws `ox, oz, oy` then `continue`s on out-of-range `oy` with the comment `// clipped tail; draws consumed`.
- **Invariant B — skip decisions run on independent child streams.** Documented at `caves.js:6-12`. A tunnel's *stepping* uses a child stream so a whole tunnel can be skipped without desyncing siblings:
  ```js
  const tRng = splitmix32(mix32(originSeed ^ Math.imul(w + 1, 0x9E3779B9)));   // caves.js:80 (worms)
  const tRng = splitmix32(mix32(originSeed ^ 0x5bd1e995));                     // caves.js:94 (ravines)
  ```
  Ores/trees do **not** use child streams — they rely on Invariant A alone, which is sound because their radius (±1) is small enough that every attempt is always fully drawn.

- **Cross-chunk purity rule:** any predicate consulted during a neighborhood pass must be a *pure function of the seed*, never a block read, because the neighbor's blocks don't exist. This is why `surfaceBlockFor(biome, height)` exists (`biomes.js:77-82`, comment at `biomes.js:75-76`: "never block reads"), why `isGenWater` exists (`noise.js:228`), and why `carvedByCheese` exists (`noise.js:273-284`). `ores.js:86-97` `touchesAir` switches on in-chunk vs out-of-chunk: in-chunk reads real carved blocks, out-of-chunk falls back to `ctx.carvedByCheese` (worm carves are **not** reproduced in that fallback — an acknowledged asymmetry, `ores.js:85`).

- **Main-thread mirror:** `World.detailSeed()` at `World.js:378` re-derives `mix32(this.worldSeed ^ hashString('sys:detail'))` — byte-identical to `noise.js:122`. This is how runtime sapling growth (`Game.js:749`) gets leaf-corner parity with worldgen. `World.worldSeed = hashString(seedString)` (`World.js:16`) matches `terrain.js:16`. Note `World.rng` (`World.js:27-28`) is a **separate, non-deterministic-order** `mulberry32(xmur3('world:' + seedString)())` stream used for drops/loot — it is *not* part of the worldgen stream family.

## 3. Noise stack & the stride-4 lattice

### Layer table — `noise.js:43-51`, "the complete layer table; no other noise exists"
| name | oct | freq | pers | ridged |
|---|---|---|---|---|
| `continental` | 4 | 1/1100 | 0.5 | no |
| `erosion` | 4 | 1/700 | 0.5 | no |
| `rough` | 5 | 1/140 | **0.55** | no |
| `mountain` | 4 | 1/380 | 0.5 | **yes** |
| `river` | 3 | 1/850 | 0.5 | no |
| `temp` | 3 | 1/1600 | 0.5 | no |
| `humid` | 3 | 1/1300 | 0.5 | no |

Each layer: `createNoise2D(alea(`${worldSeed}:${name}`))` (`noise.js:128`) — `simplex-noise` + `alea`. Defaults `lac = 2.0, pers = 0.5` (`noise.js:23`, `noise.js:32`). `fbm2` at `noise.js:23-30`; `ridged2` at `noise.js:32-40` (`n = (1-|noise|)²`). Cheese: `createNoise3D(alea(`${worldSeed}:cheese`))` (`noise.js:131`).

### The lattice contract (02 §4.4) — `noise.js:3-8`
Everything is sampled on a **world-aligned stride-4 lattice**. Full fbm is evaluated only at coords divisible by 4 and interpolated; lattice values are memoized per layer so the batch (per-chunk) path and single-cell queries return **bit-identical** numbers. 2D layers → bilinear (`bilerp`, `noise.js:87-88`); cheese → trilinear (`trilerp`, `noise.js:90-94`).

- `latticePoint(layer, ix, iz)` (`noise.js:135-146`) — memo key `key2`; **flushes hard at >200000 entries** (`noise.js:142`: `layer.memo.clear()`), not LRU.
- `cheeseLatticePoint(ix, iy, iz)` (`noise.js:149-161`) — anisotropic composite:
  ```js
  const n1 = cheese3(x / 56, y / 24, z / 56);
  const n2 = cheese3(x / 28, y / 12, z / 28);
  v = (n1 + 0.45 * n2) / 1.45;
  ```
  Same 200000-entry hard flush (`noise.js:157`).

**Cache keys** (`noise.js:113-116`):
```js
const key2 = (ix, iz) => (ix + 262144) * 524288 + (iz + 262144);
const key3 = (ix, iy, iz) => ((ix + 262144) * 33 + iy) * 524288 + (iz + 262144);
const chunkKeyN = (cx, cz) => cx * 131072 + cz;
```
`key3`'s `* 33` hard-codes the 33-plane Y lattice (y 0..128 at stride 4) — **a change to `MAX_Y` (currently 127, `constants.js:11`) requires changing this constant and the `gy <= 32` loop bound at `noise.js:235`.** `chunkKeyN` is injective only while `|cz| < 65536`; with `WORLD_BORDER = 1_000_000` (`constants.js:13`) max `|cz|` is 62500, so it is safe *as configured* — raising the border past ±1,048,576 blocks breaks it.

### Height composition
`splineC(c)` (`noise.js:56-65`) over 8 knots (`noise.js:54-55`):
```
SPLINE_C = [-1.00, -0.50, -0.20, -0.10, 0.00, 0.30, 0.60, 1.00]
SPLINE_H = [   46,    48,    54,    62,   66,   69,   72,   74]
```
```js
export function composeColumn(c, e, r, m, rv)    // noise.js:69 → { height, riv }
```
`noise.js:70-85`, exact: `flatness = clamp01(0.5*(e+1))`; `landMask = smoothstep(-0.10, 0.05, c)`; `hillAmp = lerp(16, 3, flatness)`; `hills = r * hillAmp * landMask`; `seabed = r * 2.5 * (1 - landMask)`; `mtnMask = smoothstep(0.18,0.55,c) * (1 - smoothstep(-0.35,0.35,e))`; `mtn = m * 52 * mtnMask`. River cut fires only when `riv > 0 && height > 56`, targeting `bedTarget = 59 - 2*riv` (`noise.js:80-83`). **Final clamp: `Math.max(40, Math.min(124, Math.round(height)))`** — the terrain surface is hard-bounded to **y ∈ [40, 124]**.

## 4. Two different "heightmaps" — do not conflate

| | `colD.h` | `chunk.heightMap` |
|---|---|---|
| Produced by | `columnData()` `noise.js:181, 198` | `computeHeightMap(blocks)` `features.js:258-266` |
| Type | `Uint8Array(256)` | `Uint8Array(256)` |
| Index | `(z << 4) | x` (`noise.js:197`) | `ci` = same layout |
| Meaning | terrain **surface y** from noise, pre-carve, range 40..124 | **y+1 of top sky-terminating block**, post-decoration |
| Consumers | all of gen; `ctx.heightAt` (`noise.js:208-211`) | `World.heightTop`/`canSeeSky` (`World.js:87,90`), `LightEngine.js:274,287`, `DayNight.js:184,210` |

`colD.h` is authoritative *during* generation and is a **pure seed function** — carving never updates it. `chunk.heightMap` is the runtime sky index.

**Three producers of `chunk.heightMap`, two different predicates:**
- `computeHeightMap` (`features.js:258-266`) skips the `HM_SKIP` set (`features.js:248-256`): air, short_grass, dandelion, poppy, dead_bush, sugar_cane_block, 3 saplings.
- `ChunkManager.hydrate` (`ChunkManager.js:96-113`) uses `terminatesSky(blocks[i], states[i])` (`LightEngine.js:55-58`).
- `LightEngine.js:287` incremental update on block change.

**These two rules do agree** for every gen-emitted block, and I verified it rather than trusting the comment at `LightEngine.js:52-54`: `defBlock` defaults `opacity: 15` (`blocks.js:260`), so all solids terminate; every `HM_SKIP` member uses the `CROSS` spread with `opacity: 0` (`blocks.js:301-304`); the three blocks that would otherwise disagree are covered explicitly — `snow_layer` `opacity: 0` (`blocks.js:466`) and `cactus` `opacity: 0` (`blocks.js:501`) are special-cased in `terminatesSky`, while `ice` `opacity: 1` (`blocks.js:486`), `water` `opacity: 1` (`blocks.js:650`) and `lava` `opacity: 15` (`blocks.js:657`) terminate under both. The agreement is **load-bearing and unenforced**: adding a gen-emitted block with `opacity: 0` that isn't snow/cactus, without also adding it to `HM_SKIP`, silently desyncs generated vs. reloaded chunks.

## 5. Biomes (`biomes.js`)

`BIOMES` enum (`biomes.js:43-47`), 11 ids: `OCEAN:0, BEACH:1, RIVER:2, PLAINS:3, FOREST:4, BIRCH_FOREST:5, DESERT:6, SAVANNA:7, TAIGA:8, SNOWY_TUNDRA:9, MOUNTAINS:10`. Stored per column, saved with the chunk. `BIOME_NAMES` (`biomes.js:49-52`), `BIOME_TEMPS = [0.5, 0.8, 0.5, 0.8, 0.7, 0.6, 2.0, 1.2, 0.25, 0.0, 0.18]` (`biomes.js:55`).

```js
export function selectBiome(height, c, riv, t0, h)   // biomes.js:62
export function surfaceBlockFor(biome, height)       // biomes.js:77
```
Selection order is canonical and short-circuiting (`biomes.js:63-72`): altitude cooling `t = t0 - Math.max(0, height - 80) * 0.008`; `height <= 59` → OCEAN; `riv > 0.5 && height <= 62` → RIVER; `height <= 64 && c < 0.05` → BEACH; `height >= 92` → MOUNTAINS; then humidity column `col = h < -0.2 ? 0 : h <= 0.3 ? 1 : 2` and temperature bands `t < -0.45`, `t < -0.10`, `t < 0.40`.

Six parallel per-biome tables, **all indexed by biome id and all length-11** — a new biome requires editing every one: `BIOME_NAMES` (`:49`), `BIOME_TEMPS` (`:55`), `TREE_CFG` (`:86-98`), `GRASS_COUNT = [0,0,0,40,12,12,0,50,8,0,6]` (`:100`), `FLOWER_COUNT = [0,0,0,6,3,3,0,2,0,0,0]` (`:101`), `HERD_WEIGHTS` (`:106-116`). Plus two Sets: `CANE_BIOMES` (`:102`), `PUMPKIN_BIOMES` (`:103`). `BIOME_TEMPS` is read defensively (`DayNight.js:158` uses `?? 0.8`); the others are not.

The altitude-cooling constant `0.008` is duplicated in three places with **two different values**: `biomes.js:63` (`0.008`), `features.js:209` (`0.008`), and `DayNight.js:158` (`0.00125`, applied to `y` rather than column height).

## 6. `generateChunk` pipeline

```js
export function createGenerator(seed)   // terrain.js:12
  → { worldSeed, generateChunk, findWorldSpawn, heightAt: ctx.heightAt, biomeAt: ctx.biomeAt }   // terrain.js:99-105
```

```js
function generateChunk(cx, cz) {           // terrain.js:62
  const blocks = new Uint8Array(32768);    // terrain.js:63
  const colD = ctx.columnData(cx, cz);     // terrain.js:64
  fillTerrain(blocks, cx, cz, colD);       // terrain.js:65
  carveCheese(ctx, blocks, cx, cz, colD);  // terrain.js:66
  carveWorms(ctx, blocks, cx, cz);         // terrain.js:67
  lavaFlood(blocks);                       // terrain.js:68
  placeOresAndPockets(ctx, blocks, cx, cz);// terrain.js:69
  decorate(ctx, blocks, cx, cz, colD);     // terrain.js:70
  const heightMap = computeHeightMap(blocks);        // terrain.js:71
  const biomes = Uint8Array.from(colD.biome);        // terrain.js:72 — copy: cache stays live
  const spawns = rollHerd(ctx, cx, cz);              // terrain.js:73
  return { blocks, heightMap, biomes, spawns };      // terrain.js:74
}
```
**Block index formula, used everywhere:** `(y << 8) | (z << 4) | x`, `blocks` is `Uint8Array(32768)` = 16×128×16. Column index `ci = (z << 4) | x`.

**`terrain.js:72` is load-bearing**: `colD.biome` belongs to the live LRU entry, so it must be copied before transfer — otherwise the transfer detaches the cache's buffer.

`fillTerrain` (`terrain.js:21-60`): y=0 always `bedrock`; y=1 jagged via `posHash(ctx.seeds.terrain, wx0+x, 1, wz0+z) < 0.5` (`terrain.js:46`); surface/filler/sandstone bands from `(surf, fill, fd, ss)` chosen at `terrain.js:29-43`; water fill `for (let y = h + 1; y <= 63; y++)` (`terrain.js:57`). Sea level 63 is hard-coded here, **not** read from `constants.js:12`'s `SEA_LEVEL`.

`findWorldSpawn()` (`terrain.js:86-97`): rings of 8-block steps out to radius 256 (`ring <= 32`, `ringPositions(ring * 8, 8)`), accepting `h` in 64..90, rejecting OCEAN/RIVER/BEACH, requiring `surfaceBlockOf === grass_block`. Fallback `{ x: 0.5, y: ctx.heightAt(0,0) + 1, z: 0.5 }` (`terrain.js:96`).

## 7. Neighborhood radii — the multi-chunk table

| Pass | Origin radius | Constant | Reach guard |
|---|---|---|---|
| `carveCheese` | 0 (local) | — | per-column, `caves.js:23-49` |
| `carveWorms` / ravines | **±7** Chebyshev | `CARVE_R = 7` `caves.js:17` | `TUNNEL_REACH = 115` `caves.js:20`, tested `caves.js:79, 93` |
| `placeOresAndPockets` | **±1** | inline `ores.js:31-32` | none (vein ≤ ~12 blocks) |
| trees (`decorate` step 1) | **±1** | inline `features.js:101-102` | none |
| plants (steps 2–3) | 0 (local) | `features.js:124` | none |
| snow/ice (step 4) | 0 (local) | `features.js:205-217` | none |
| `rollHerd` | 0 (local) | `features.js:270` | ±4 block jitter `features.js:286` |

**This ±7 / 115 pair is the widest existing multi-chunk mechanism and is the closest working precedent for a village/fortress generator.** Its shape: iterate origin chunks in a square; derive `originSeed = chunkSeed(ctx.seeds.<sys>, ocx, ocz)`; draw *all* parameters unconditionally; test a conservative reach bound; simulate on a child stream; clip every write to the current chunk.

Rates: worms fire on `rng() < 1/7` per chunk with `wormCount = 1 + Math.floor(rng() * rng() * 3)` (`caves.js:64-65`); ravines on `rng() < 0.02` (`caves.js:86`, "1 in 50 chunks"). Surface-entrance worms: `rng() < 0.12` → `y = heightAt(sx,sz)+1`, `pitch = -(0.35 + rng()*0.55)` (`caves.js:69-71`); else `y = 6 + rng()*rng()*72`, `pitch = (rng()-0.5)*0.5` (`caves.js:72-74`).

`carveTunnel` (`caves.js:103`) — signature `(ctx, blocks, cx, cz, rng, x, y, z, yaw, pitch, thick, length, vScale, canBranch)`. `vScale` 0.72 for worms, 3.0 for ravines. Branch at `i === (length >> 1)` when `thick > 1.8 && rng() < 0.5`, into two half-thickness arms at `yaw ∓ Math.PI/2` (`caves.js:121-127`). Rough walls: `if (rng() < 0.20) continue;` (`caves.js:128`). Displacement clamp `(x-ox)² + (z-oz)² > 100*100` → return (`caves.js:129`) — note `ox, oz` are **re-captured per call** (`caves.js:105`), so a branch gets a *fresh* 100-block budget from the branch point.

`carveEllipsoid` (`caves.js:135-172`) clips to the chunk **first** (`caves.js:141-146`, "no writes possible ⇒ nothing to decide"), then applies the water guard over the *full unclipped* bbox+1 using `ctx.heightAt` (`caves.js:150-155`) so every simulating chunk reaches the same decision. Never carves `y <= 1` (`caves.js:145`). `lavaFlood` (`caves.js:175-182`) converts all air at y 2..9 to lava.

### ⚠ `CARVE_R` and `TUNNEL_REACH` are mutually inconsistent
`CARVE_R = 7` enumerates origins at Chebyshev distance ≤ 7 (`caves.js:60-61`), but the reach test admits any origin within Euclidean 115 of the chunk rect (`caves.js:79`). A worm starting at the **near edge of a distance-8 chunk** sits at `distToChunkXZ` ≈ 112 — inside `TUNNEL_REACH = 115`, but outside `CARVE_R`. Concretely: for `ocx = cx - 8`, starts land in `[cx*16 - 128, cx*16 - 112)`, so any start with `sx ∈ (cx*16 - 115, cx*16 - 112)` passes the reach bound yet is never enumerated. Because chunk `(cx+1, cz)` *does* enumerate `cx-7..cx+8`, the same worm is simulated by the neighbor but not by `(cx, cz)` — producing a **hard-edged cave truncation exactly on the chunk border**, not merely a shortened tunnel. Rare (requires a near-maximal ~109-step tunnel to actually travel 112+ blocks), but it is a genuine radius/bound mismatch, not a conservative margin. The comment at `caves.js:18-19` derives 115 correctly; `CARVE_R = 7` covers only 112.

## 8. Ores (`ores.js`)

`FEATURES` table, `ores.js:11-28`, row layout `[block, attempts, size, kind, p0, p1, p2, discard]` (`ores.js:9-10`). `kind 'u'` = `rngRange(rng, p0, p1)`; `kind 't'` = `triSample(rng, p0, p1, p2)`. **Negative `attempts` is a fractional-chance encoding**: `n = rng() < -attempts ? 1 : 0` (`ores.js:36`).

| block | attempts | size | kind | p0,p1,p2 | discard |
|---|---|---|---|---|---|
| dirt | 3 | 18 | u | 34, 88 | 0 |
| gravel | 2 | 18 | u | 0, 88 | 0 |
| coal_ore | 7 | 17 | u | 82, 127 | 0 |
| coal_ore | 7 | 17 | t | 32, 72, 96 | 0.5 |
| iron_ore | 17 | 9 | t | 68, 106, 127 | 0 |
| iron_ore | 5 | 9 | t | 20, 40, 60 | 0 |
| iron_ore | 5 | 4 | u | 0, 66 | 0 |
| gold_ore | 2 | 9 | t | 0, 24, 48 | 0.5 |
| gold_ore | **-0.25** | 9 | u | 0, 8 | 0.5 |
| redstone_ore | 2 | 8 | u | 0, 39 | 0 |
| redstone_ore | 4 | 8 | t | -16, 0, 16 | 0 |
| lapis_ore | 1 | 7 | t | 16, 32, 48 | 0 |
| lapis_ore | 2 | 7 | u | 0, 64 | 1.0 |
| diamond_ore | 4 | 4 | t | -40, 0, 40 | 0.5 |
| diamond_ore | 2 | 8 | t | -40, 0, 40 | 1.0 |
| diamond_ore | **-1/9** | 12 | t | -40, 0, 40 | 0.7 |

```js
export function placeOresAndPockets(ctx, blocks, cx, cz)   // ores.js:30
```
`placeVein` (`ores.js:51`) — line of overlapping spheres, `r = 0.6 + tsin(t * Math.PI) * (0.4 + size / 16)` (`ores.js:58`), step 0.7 (`ores.js:76-78`), pitch clamped ±1.2 (`ores.js:80`). **Veins replace `ID.stone` only** (`ores.js:69`), which is why pockets and ores never overwrite each other (`ores.js:3-4`) and why dirt/gravel rows are listed first. Fixed iteration order x→y→z (`ores.js:60-63`). Clipping consumes no rng (`ores.js:66-67`).

Rows with `t` kind and negative `p0` (e.g. `-40, 0, 40`) intentionally sample below 0 and are discarded at `ores.js:42` — this is a **density-shaping device**, halving effective attempts, not a bug.

## 9. Features (`features.js`)

```js
export function rollTreeHeight(species, rng)                                          // features.js:14
export function placeTreeH(species, H, x, groundY, z, detailSeed, put, canPlaceTrunk) // features.js:24
export function placeTree(species, x, groundY, z, rng, detailSeed, put, canPlaceTrunk)// features.js:71
export function decorate(ctx, blocks, cx, cz, colD)                                   // features.js:96
export function computeHeightMap(blocks)                                              // features.js:258
export function rollHerd(ctx, cx, cz)                                                 // features.js:269
```
Trunk heights (`features.js:15-17`): oak `4 + rngInt(rng,3)` → 4–6; birch `5 + rngInt(rng,3)` → 5–7; spruce `7 + rngInt(rng,4)` → 7–10.

`placeTreeH` is the **shared worldgen/runtime tree writer** — the `put(wx, wy, wz, id, mode)` callback abstracts the block sink so the same code drives both the worker's `Uint8Array` (`makePut`, `features.js:76-88`) and the main thread's `world.setBlock` (`Game.js:750-756`). `mode` ∈ `'leaf'` (air only), `'log'` (air/leaves), `'dirt'` (replaces ground). Optional `canPlaceTrunk` is checked for **every** trunk cell before any write, returning false ⇒ nothing placed (`features.js:27-31`) — this is the runtime-sapling path (`Game.js:757`). **This callback-sink pattern is the established precedent for any generator that must run both in-worker and at runtime.**

`decorate` order is fixed and must not be reordered (shared `plant` stream): trees (±1, `tree` stream) → cactus ×3 → dead bush ×2 → sugar cane ×6 → pumpkin (`rng() < 1/64`, 6 tries ±3, each 50%) → grass `GRASS_COUNT[biome]` → flowers `FLOWER_COUNT[biome]` → snow/ice.

Biome for decoration is sampled at **chunk center**, not per column: `ctx.biomeAt(ocx*16+8, ocz*16+8)` (`features.js:104`) and `ctx.biomeAt(wx0+8, wz0+8)` (`features.js:125`). Tree placement then uses per-column `ctx.heightAt(x, z)` / `ctx.surfaceBlockOf(x, z)` (`features.js:113-116`).

Snow/ice rule (`features.js:205-217`): `tEff = colD.t[ci] - Math.max(0, h - 80) * 0.008`; fires when `tEff < -0.45 || h >= 104`; scans down from y=127 for the first non-air; `water` at exactly `top === 63` → `ice`, else `SOLID_TOP[id]` → `snow_layer` above.

`rollHerd` (`features.js:269-295`): `rng() >= 0.10` → `[]`; `size = 2 + rngInt(rng,3)` (2–4); weighted species pick from `HERD_WEIGHTS[biomeAt(hx,hz)]`; up to 4 placement tries per member within ±4, requiring `h >= 63` and `surfaceBlockOf === grass_block`. Returns `[{ type, x, y, z }]` — plain objects, **structured-cloned not transferred**.

## 10. Worker partition

**There is no spatial partitioning.** `WORKER_COUNT = 2` (`constants.js:26`). Assignment is plain round-robin (`ChunkManager.js:86-87`):
```js
const worker = this.workers[this.nextWorker];
this.nextWorker = (this.nextWorker + 1) % this.workers.length;
```
Each worker holds its **own independent `createGenerator`** (`terrainWorker.js:13`), therefore its own `colCache` (LRU 128, `noise.js:164`), its own per-layer `memo` Maps and its own `cheeseMemo`. Adjacent chunks routed to different workers **duplicate all lattice work**; the caches are never shared and there is no affinity to exploit locality.

`findWorldSpawn()` runs on **every** worker at init (`terrainWorker.js:14`) — both compute the identical spawn; `ChunkManager.js:50-53` keeps the first `ready` and ignores the second (`if (!this.worldSpawn)`).

### Protocol (`terrainWorker.js`, `ChunkManager.js:33-89`)
- **main → worker**: `{ type: 'init', seed }` once (`ChunkManager.js:38`, seed is the raw **string**); then `{ type: 'generate', cx, cz, jobId }` (`ChunkManager.js:88`).
- **worker → main**: `{ type: 'ready', worldSpawn }` (`terrainWorker.js:14`); `{ type: 'chunk', cx, cz, jobId, blocks, heightMap, biomes, spawns }` with `[r.blocks.buffer, r.heightMap.buffer, r.biomes.buffer]` **transferred** (`terrainWorker.js:18-25`); `{ type: 'error', jobId, cx, cz, message }` on throw (`terrainWorker.js:26-32`).
- **Flow control**: `MAX_JOBS_IN_FLIGHT = 16` (`constants.js:27`) gates dispatch at `ChunkManager.js:136`. `this.pending: Map<jobId, chunkKey>` (`ChunkManager.js:22`). The same `pending` map and `jobId` counter are shared by worker jobs **and** IndexedDB hydrate jobs (`ChunkManager.js:144-146`).
- **Retry**: one retry, then `ChunkState.FAILED` (`ChunkManager.js:60-68`) — "visible hole = loud bug signal".
- **Stale guard**: `ChunkManager.js:75` drops results whose chunk left `REQUESTED` or whose key moved.
- **Radii**: `GENERATE_RADIUS = 9` (361 chunks), `RENDER_RADIUS = 8`, `UNLOAD_RADIUS = 11` (`constants.js:22-25`). Request list is rebuilt on chunk crossing, sorted nearest-first by squared distance (`ChunkManager.js:161-173`).
- **Saved chunks skip the worker entirely** (`ChunkManager.js:142-150`).

`initWorkers` uses `new Worker(new URL('../workers/terrainWorker.js', import.meta.url), { type: 'module' })` (`ChunkManager.js:35`) — ES-module worker, bundler-resolved.

## 11. Chunk serialization — three distinct formats

### (a) Worker → main (in-flight)
`{ type, cx, cz, jobId, blocks: Uint8Array(32768), heightMap: Uint8Array(256), biomes: Uint8Array(256), spawns: Array|[] }` — `terrainWorker.js:18-25`. Three buffers transferred; `spawns` cloned. Received views are installed **as-is, zero-copy** (`ChunkManager.js:76-77`).

### (b) IndexedDB chunk record — `saveManager.js:67-77`
```js
{
  cx, cz,
  blocks:  chunk.blocks.buffer,     // ArrayBuffer 32768
  states:  chunk.states.buffer,     // ArrayBuffer 32768
  biomes:  chunk.biomes ? chunk.biomes.buffer : new ArrayBuffer(256),
  blockEntities,                    // [{ i, type, data }]
  spawnsDone,                       // bool
  spawns,                           // chunk.pendingSpawns ?? null
  entities,                         // [e.serialize()]
}
```
Stored via `store.put(record, chunk.key)` where `chunk.key = cx + ',' + cz` (`Chunk.js:17`, `constants.js:19`). Structured clone copies the buffers, so they are **not** detached (`saveManager.js:68`).

**Deliberately absent and recomputed on load:** `heightMap` (rebuilt by top-down scan, `ChunkManager.js:96-113`), `skyLight`/`blockLight` (`Chunk.install` zero-fills, `Chunk.js:40-41`; `LightEngine.initialLight` refills). **Also absent: any per-record version field** — only the meta record carries `version`.

Entity filter at `saveManager.js:60-65`: skips `game.player`, `e.dead`, and types `'player'`, `'arrow'`, and anything `startsWith('thrown')`.

Only `chunk.modified` chunks are written (`saveManager.js:116`, `ChunkManager.js:225`) — unmodified chunks are regenerated from seed. **This makes the generator's output part of the save contract: any gen change silently rewrites all unmodified terrain in existing worlds, and `SAVE_VERSION` does not gate it.**

### (c) Meta record — `saveManager.js:80-89`
```js
{ version: SAVE_VERSION /* = 1, constants.js:46 */, seed: game.world.seedString,
  worldTime, weather, player, lastSaved }
```
Key `'world'` in store `'meta'`. Version mismatch discards the world (`saveManager.js:28-31`), but **the chunk store is not cleared** — stale chunk records survive a meta rejection.

Object stores `'meta'` and `'chunks'` created at `saveManager.js:18-19`.

## 12. Extension points

### Where a multi-chunk structure (village/fortress/stronghold) hooks in
- **Pipeline slot**: a new call in `generateChunk` (`terrain.js:62-75`). Ordering constraints are real: it must land after `fillTerrain` (needs terrain), and its position relative to `carveWorms`/`placeOresAndPockets`/`decorate` determines whether carvers cut it and whether `ores.js:69`'s stone-only rule can still fire inside it.
- **Seed stream**: add a name to `noise.js:121`. Derivation is string-keyed, so insertion does not perturb existing streams. `ctx.seeds` is already threaded into every pass.
- **Radius pattern**: copy `carveWorms`'s shape (`caves.js:59-101`) — the only existing pass with radius > 1. Both invariants of §2 apply. If the structure's footprint exceeds `CARVE_R = 7`'s 15×15 window, the origin loop and reach bound must be co-derived (see the §7 mismatch — the existing pair is already 3 blocks short).
- **Purity constraint**: placement predicates may only use `ctx.heightAt`, `ctx.biomeAt`, `ctx.surfaceBlockOf`, `ctx.isGenWater`, `ctx.carvedByCheese`, `posHash` — never `blocks[]` reads outside the current chunk (`noise.js:286-290` is the whole pure surface; rationale at `biomes.js:75-76`, `ores.js:85`).
- **Write clipping**: reuse `makePut` (`features.js:76-88`) or the `put` callback contract of `placeTreeH` — the established sink abstraction that lets one generator serve both worker and runtime.
- **Blocked by**: `generateChunk`'s return shape `{ blocks, heightMap, biomes, spawns }` (`terrain.js:74`) has no channel for structure metadata (bounding boxes, piece graphs, loot seeds). The worker message (`terrainWorker.js:18-25`) and the save record (`saveManager.js:67-77`) would each need a new field; `blockEntities` (`Chunk.js:27`, `ChunkManager.js:117-119`) is the only existing per-chunk metadata channel and is keyed by block index.
- **`chunk.modified` interaction**: structures written by the generator are *not* `modified`, so they are regenerated rather than saved — meaning a structure's block layout must stay a pure seed function forever, or existing worlds will mutate.

### Where a new dimension hooks in
- **`world.dimension` is read but never written.** `music.js:129-131` reads `g.world.dimension` and branches on `'nether'` / `'end'`; `World`'s constructor (`World.js:14-29`) never assigns `dimension`, and no `grep` hit assigns it anywhere. The property is permanently `undefined`, so both branches are dead. This is a pre-wired but unconnected hook.
- Related dead-but-present scaffolding: `audio/events.js:40-41` ("reserved: 10's blocks default nether, 11's default end"), `blocks.js:701` (nether/end sound classes), `music.js:25` (a full `nether` mood: `phrygianFragment`, 40 BPM, `padLp: 600`, `gain: 0.22`).
- **Worker protocol has no dimension field**: `{ type: 'init', seed }` (`terrainWorker.js:12-14`) and `{ type: 'generate', cx, cz, jobId }` (`ChunkManager.js:88`). One generator per worker, bound at init (`terrainWorker.js:13`) — a second dimension needs either a dimension arg on `generate` plus a generator map, or a second worker pool.
- **Chunk keys have no dimension component**: `chunkKey = (cx, cz) => cx + ',' + cz` (`constants.js:19`), `Chunk.key` (`Chunk.js:17`), `World.chunks: Map<"cx,cz", Chunk>` (`World.js:17`). The IndexedDB `chunks` store is keyed by that same string (`saveManager.js:98, 123`) — **two dimensions would collide in one object store.**
- **Fixed vertical geometry**: `MAX_Y = 127` (`constants.js:11`), `Uint8Array(32768)` (`terrain.js:63`), the `* 33` in `key3` (`noise.js:115`), `gy <= 32` (`noise.js:235`), the `(y << 8)` index shift everywhere, and the hard-coded 63 sea level (`terrain.js:57`, `noise.js:228`, `caves.js:150-154`, `features.js:214`).
- `constants.js:13` comments `WORLD_BORDER = 1_000_000; // ±blocks, physics clamp + generator refusal` — **the "generator refusal" does not exist.** `WORLD_BORDER` is imported only by `Entity.js:4` and used only as a position clamp (`Entity.js:76-79`). Nothing in `gen/` or `ChunkManager` consults it; chunk requests past the border generate normally.

### Extension points that already exist and work
- `ctx.seeds` (`noise.js:287`) — open-ended stream registry.
- The `put(wx, wy, wz, id, mode)` sink (`features.js:24, 76-88`) — dual worker/runtime block writer.
- `chunk.blockEntities` (`Chunk.js:27`) + its save round-trip (`saveManager.js:55-57`, `ChunkManager.js:117-119`) — per-chunk metadata channel.
- `chunk.pendingSpawns` / `spawnsDone` (`Chunk.js:33-34`) — the pattern for "generator emits deferred records, main thread consumes once": produced `terrain.js:73`, transported `ChunkManager.js:78`, consumed `Game.js:697-706`, persisted `saveManager.js:74-75`, restored `Game.js:708-715`. **This is the working template for structure-driven spawns or loot.**
- `game.onChunkGenerated` / `onChunkHydrated` / `onChunkUnloading` hooks (`ChunkManager.js:79, 120, 226`).

## 13. Dead / unreachable public surface

- `noise.js` exports `clamp01` (`:15`), `lerp` (`:16`), `smoothstep` (`:17`), `composeColumn` (`:69`) — **no module imports any of them.** `terrain.js:6` imports only `createNoiseCtx`. `themeMusic.js:36` and `materials.js:35` define their own `clamp01`/`smoothstep` independently.
- `ctx.tempAt` (`noise.js:216-219`, returned at `:288`) — **zero callers**; `decorate` reads `colD.t` directly (`features.js:209`).
- `ctx.cheeseAt` (`noise.js:257`, returned at `:289`) — no external caller; used only internally by `carvedByCheese` (`noise.js:277`).
- `createGenerator` returns `heightAt` / `biomeAt` (`terrain.js:103-104`) — unused; `terrainWorker.js` calls only `generateChunk` and `findWorldSpawn`. The main thread's `World.biomeAt` (`World.js:92-96`) reads `chunk.biomes` with a **plains (3) fallback** for missing chunks, never the generator.

## 14. Inconsistencies found (factual, not proposed fixes)

1. **`CARVE_R = 7` vs `TUNNEL_REACH = 115`** (`caves.js:17, 20, 60-61, 79`) — enumeration covers 112 blocks; the reach bound admits 115. Origins at Chebyshev 8 whose start lands in a ~3-block strip pass the reach test but are never simulated, and *are* simulated by the adjacent chunk → hard cave truncation on the chunk border. Detailed in §7.
2. **`world.dimension` read but never assigned** (`music.js:129-131` vs `World.js:14-29`) — permanently `undefined`; the nether/end mood branches are unreachable.
3. **`WORLD_BORDER` "generator refusal" does not exist** (`constants.js:13` comment vs sole usage `Entity.js:76-79`).
4. **`terrain.js:13-14` comment is wrong**: "saves store the int; both routes yield the same worldSeed". `saveManager.js:83` stores `seed: game.world.seedString` (a **string**), and `main.js:71` passes `meta.seed` straight back to `startWorld`. The number branch at `terrain.js:16` is never exercised by the save path. The code tolerates both; only the comment is inaccurate.
5. **Altitude-cooling constant diverges**: `0.008` on column height (`biomes.js:63`, `features.js:209`) vs `0.00125` on entity `y` (`DayNight.js:158`).
6. **`SEA_LEVEL` (`constants.js:12`) is unused by gen** — 63 is hard-coded at `terrain.js:57`, `noise.js:228`, `caves.js:150-154`, `features.js:214`. `MAX_Y` is likewise re-hard-coded as 127 throughout gen (`noise.js:115`'s `* 33`, `caves.js:145`, `features.js:261`, `ores.js:67`).
7. **`saveManager.js:94`** `const game = chunk?.gameRef ?? window.game;` — the unload-path chunk write depends on a global; `Chunk` (`Chunk.js:13-35`) never defines `gameRef`, so this **always** falls through to `window.game`.
8. **Version mismatch discards meta but not chunks** (`saveManager.js:28-31`) — `savedChunkKeys` is still populated from the old store at `saveManager.js:32`, so a new world on a rejected save version will hydrate stale chunk records via `ChunkManager.js:142`.
9. **Heightmap-predicate agreement is load-bearing but unenforced** — `HM_SKIP` (`features.js:248-256`) and `terminatesSky` (`LightEngine.js:55-58`) agree today only by coincidence of the `CROSS` opacity default; see §4.
10. **Per-layer memo flush is a hard clear, not eviction** (`noise.js:142, 157`) — at >200000 entries the entire memo is dropped, so the sample after a flush re-evaluates full fbm. Correctness holds (values are pure); it is a latency cliff, and with `WORKER_COUNT = 2` each worker pays it independently.


<!-- ===== aa6ba5973583da270 ===== -->
# Entity Subsystem Integration Map — ClaudeCraft

All paths relative to `/Users/jakevolkanovski/Desktop/ClaudeCraft`.

---

## 1. Module inventory & public exports

| File | Exports |
|---|---|
| `src/entities/Entity.js` | `brightness(l)`, `lerp(a,b,t)`, `lerpAngle(a,b,t)`, `class Entity`, `class LivingEntity` |
| `src/entities/EntityManager.js` | `class EntityManager` |
| `src/entities/ItemEntity.js` | `initEntityVisuals(atlas)`, `entityAtlas()`, `makeAtlasMaterial(opts)`, `blockCubeGeometry(blockId,size)`, `tileSpriteGeometry(tile,size)`, `itemTileFor(itemId)`, `class ItemEntity` |
| `src/entities/Arrow.js` | `class Arrow` |
| `src/entities/XpOrb.js` | `class XpOrb` |
| `src/entities/PrimedTnt.js` | `class PrimedTnt` |
| `src/entities/ThrownProjectile.js` | `class ThrownProjectile` |
| `src/entities/FallingBlock.js` | `class FallingBlock` |
| `src/entities/Player.js` | `class Player extends LivingEntity` (`Player.js:12`) |
| `src/entities/mobs/Mob.js` | `class Mob extends LivingEntity` |
| `src/entities/mobs/ai.js` | `standable`, `astarBudgetOk`, `findPath`, `MOVE`, `LOOK`, `Goal`, `SwimGoal`, `WanderGoal`, `LookAtPlayerGoal`, `IdleLookGoal`, `MeleeAttackGoal`, `PanicGoal`, `TemptGoal`, `FollowParentGoal`, `BreedGoal`, `EatGrassGoal`, `FleeSunGoal`, re-export `hasLineOfSight` (`ai.js:371`) |
| `src/entities/mobs/index.js` | `HOSTILE_TYPES`, `createMob(world,type,x,y,z,opts)`, `class MobSpawner` |
| `src/entities/mobs/models.js` | `mobTexture(name)`, `part(texName,w,h,d,pivot,offset,faceTexName)`, `humanoidModel`, `endermanModel`, `creeperModel`, `spiderModel`, `quadrupedModel`, `cowModel`, `pigModel`, `sheepModel`, `chickenModel`, `skeletonBow` |
| `src/entities/mobs/{Zombie,Skeleton,Creeper,Spider,Enderman}.js` | one class each |
| `src/entities/mobs/passive.js` | `Cow`, `Pig`, `Sheep`, `Chicken` (internal base `class Passive extends Mob`, `passive.js:11` — **not exported**) |

Constants consumed: `AMBIENT_FLOOR = 0.04`, `WORLD_BORDER = 1_000_000`, `SIM_RADIUS = 6`, `chunkKey(cx,cz)` (`src/constants.js:40,13,24`).

---

## 2. `Entity` base class — `Entity.js:23`

`constructor(world, x = 0, y = 0, z = 0)` (`Entity.js:24`). Fields set in ctor (`Entity.js:25–47`):

`world`, `id = 0` (set by EntityManager), `type = 'entity'`, `pos {x,y,z}` (**feet center**), `prevPos`, `vel` (m/tick), `yaw/pitch/prevYaw = 0`, `width = 0.5`, `height = 0.5`, `onGround`, `hitWall`, `hitCeiling`, `inWater`, `inLava`, `onLadder` (all `false`), `age = 0`, `dead = false`, `object3d = null`, `lightScalar = 1`, `chunkKey = null`, `gravityBlocked = false`, `blockAgainstUnloaded = false`, `persistent = false`.

Methods:

- `getAABB()` → `AABB.fromEntity(pos.x,pos.y,pos.z,width,height)` (`Entity.js:49`)
- `setPosFromAABB(box)` (`:53`), `setPos(x,y,z)` (`:59`)
- `baseTick()` (`:64`) — **"MUST be called first from every subclass tick()"**. Copies `pos→prevPos`, `yaw→prevYaw`, `age++`, and `if ((this.age & 3) === 0) this.sampleLight()`.
- `tick()` (`:71`) — base impl is just `baseTick()`.
- `move(dx,dy,dz)` (`:73`) — delegates to `moveEntity(this.world, this, dx, dy, dz)` from `src/physics/collision.js`, then clamps `pos.x`/`pos.z` to ±`WORLD_BORDER`.
- `updateMedium()` (`:82`) — sets `inWater`/`inLava` via `overlapsFluid(world, box, 'water'|'lava')`, `onLadder` via `overlapsClimbable`.
- `eyeY()` (`:89`) → `pos.y + height * 0.85`.
- `sampleLight()` (`:91`) — `level = max(getBlockLight(x,y,z), getSkyLight(x,y,z) - world.skyDarken)`, y clamped `[0,127]`; `lightScalar = brightness(level)`.
- `buildMesh()` (`:101`) → `null`. **Primary render extension point** — "override; THREE.Group of parts".
- `updateRender(alpha)` (`:103`) — lerps `object3d.position` from `prevPos→pos`, sets `rotation.y = lerpAngle(prevYaw, yaw, alpha)`, calls `applyLightScalar()`.
- `applyLightScalar()` (`:114`) — traverses `object3d`; for each material with `mat.userData.baseColor` sets `color = base * lightScalar`, with `hurtMul = this.hurtTime > 0 ? 0.35 : 1` applied to **g and b only** (red tint). Note `hurtTime` is undefined on plain `Entity` (only `LivingEntity` declares it, `Entity.js:154`) → `undefined > 0` is `false`, so `hurtMul` is 1.
- `serialize()` (`:129`) → `{ type, pos:[x,y,z], vel:[x,y,z], yaw }`
- `deserialize(rec)` (`:138`) — instance method; restores pos/vel/yaw.

`brightness(l)` (`Entity.js:7`): `x = clamp(l,0,15)/15; return AMBIENT_FLOOR + (1-AMBIENT_FLOOR) * (x/(4-3*x))` — JS mirror of the shader curve.

Dead code: `let SCRATCH = new AABB();` (`Entity.js:21`) is never referenced.

---

## 3. `LivingEntity` — `Entity.js:147`

Adds (`:150–157`): `health = 20`, `maxHealth = 20`, `invulnTicks = 0`, `lastHurtAmount = 0`, `hurtTime = 0`, `deathTime = 0`, `fallDistance = 0`, `fireTicks = 0`.

`static ARMOR_SOURCES = new Set(['melee','arrow','explosion','cactus','thorns'])` (`Entity.js:164`).

### Damage pipeline (exact order)

```js
hurt(amount, source = 'generic', opts = {})            // Entity.js:167
applyDamage(dmg, source, opts, noNewWindow)            // Entity.js:185
armorReduce(damage)                                    // Entity.js:200
applyKnockback(strength, dirX, dirZ)                   // Entity.js:209
die(source, opts)                                      // Entity.js:215
tickTimers()                                           // Entity.js:221
trackFall(velYBeforeMove, actualDy)                    // Entity.js:227
armorPoints() { return 0; }  armorToughness() { return 0; }   // Entity.js:160-161
```

`hurt` flow (`:167–183`):
1. `if (this.dead) return false;`
2. **`beforeHurt(amount, source, opts)` hook** — if it returns exactly `false`, the hit is cancelled and `hurt` returns `false`. Optional (`this.beforeHurt && ...`).
3. i-frames: if `invulnTicks > 0` **and** source is neither `'void'` nor `'starve'`: if `amount <= lastHurtAmount` → `return false`; else apply only `excess = amount - lastHurtAmount`, set `lastHurtAmount = amount`, `applyDamage(excess, …, noNewWindow = true)`.
4. Otherwise `invulnTicks = 10`, `lastHurtAmount = amount`, `applyDamage(amount, …, false)`.

`applyDamage` (`:185–197`):
1. If `ARMOR_SOURCES.has(source)` → `dmg = this.armorReduce(dmg)` then **`this.damageArmor?.(dmg)`** (optional hook).
2. `this.health -= dmg; this.hurtTime = 10;`
3. Knockback **only if** `!noNewWindow && opts.dirX !== undefined` → `applyKnockback(opts.knockback ?? 0.4, opts.dirX, opts.dirZ)`. (I-frame excess damage never knocks back.)
4. **`this.onHurt?.(dmg, source, opts)`** — post-armor, post-knockback.
5. `if (this.health <= 0) this.die(source, opts);`

`armorReduce` (`:200`): `eff = min(20, max(armor/5, armor - damage/(2 + toughness/4)))`; returns `damage * (1 - eff/25)`. Returns `damage` unchanged when `armorPoints() <= 0`.

`applyKnockback` (`:209`): `vel.x = vel.x/2 + dirX*strength`, same for z; `if (onGround) vel.y = min(0.4, vel.y/2 + strength)`.

`die(source, opts)` (`:215`): `health = 0; dead = true; this.onDeath?.(source, opts);` — **`onDeath` is called from nowhere else in the codebase** (grep: only `Entity.js:218`).

`trackFall(velYBeforeMove, actualDy)` (`:227`): zeroes `fallDistance` on ladder/water; halves it in lava; accumulates `-actualDy` when `velYBeforeMove < 0 && !onGround && actualDy < 0`; on landing, `dmg = Math.ceil(fallDistance - 3)`, applied as `hurt(dmg,'fall')` **gated on `this.takesFallDamage !== false`**.

### `opts` contract for `hurt`
`{ dirX, dirZ, knockback = 0.4, attacker }` (`Entity.js:166`). Real callers:
- `src/player/interaction.js:174` — `target.hurt(dmg,'melee',{dirX,dirZ,knockback:kb,attacker:p})`
- `src/entities/mobs/Mob.js:436` — `doMeleeAttack`
- `src/entities/Arrow.js:75` — `'arrow'`
- `src/Game.js:616` — `e.hurt(dmg,'explosion',{})` (**empty opts → no `hurt`-driven knockback**; `Game.js:618-620` adds velocity directly instead)
- `src/env/DayNight.js:252` — `e.hurt(10,'lightning')`
- `src/entities/ThrownProjectile.js:75,90` — `'melee'` (0 dmg), `'pearl'`

Sources seen in-tree: `melee`, `arrow`, `explosion`, `cactus`, `thorns`, `fall`, `void`, `starve`, `lava`, `burn`, `fire`, `water`, `drown`, `suffocate`, `lightning`, `pearl`, `generic`.

---

## 4. `EntityManager` — `EntityManager.js:5`

`constructor(world, scene)` → `this.entities = new Map()` (**id → Entity, insertion order = tick order**), `this.nextId = 1`. Constructed once at `Game.js:96`; `Game.js:98` immediately does `this.entities.add(this.player)`.

- `add(entity)` (`:13`) — `entity.id = this.nextId++`; inserts into map; `register(entity)`; returns the entity. **This is the only registration path.**
- `register(entity)` (`:20`) — computes `chunkKey(floor(pos.x)>>4, floor(pos.z)>>4)`; early-returns if unchanged; removes from old `chunk.entities` Set, sets `entity.chunkKey`, adds to new `chunk.entities` (`chunk?.entities.add` — silently no-ops if the chunk isn't loaded). `Chunk.entities` is a `Set` declared at `src/world/Chunk.js:28`.
- `tick(player)` (`:32`):
  - `if (player) this.register(player)` — "player ticks separately but must stay indexed".
  - Pass 1 over `entities.values()`: skips `player`; if `entity.dead` → `if (entity.deathAnimTicks) entity.deathTime++;` then `continue` (**`tick()` is never called on a dead entity**); freeze gate — skip if `max(|ecx-p.cx|,|ecz-p.cz|) > SIM_RADIUS` (6) or the chunk is missing / `chunk.state < ChunkState.GENERATED`; else `entity.tick(); this.register(entity);`
  - Pass 2 (reap): for each dead entity, `if (entity.deathTime < (entity.deathAnimTicks ?? 0)) continue; this.remove(entity);`
- `remove(entity)` (`:58`) — deletes from map; removes from `chunk.entities`; nulls `chunkKey`; if `object3d`: `scene.remove`, traverse and `m.dispose()` for every material **unless `m.userData?.shared`**, then `object3d = null`; finally **`entity.onRemoved?.()`**.
- `updateRender(alpha, player)` (`:76`) — skips `player`; honours **`entity.needsMeshRebuild`** (removes group from scene, nulls `object3d`, clears the flag); lazily calls `entity.buildMesh()` and `scene.add(mesh)` when `object3d` is null and the mesh is non-null; then `entity.updateRender(alpha)`.
- `getEntitiesInBox(box, filter)` (`:96`) — scans chunks over `[floor(box.min)>>4 - 1 … floor(box.max)>>4 + 1]` in x and z (**±1 chunk margin**), skips `e.dead`, applies `filter`, requires `box.intersects(e.getAABB())`. Proxied by `World.getEntitiesInBox` (`src/world/World.js:374-376`) which returns `[]` when `world.game` is unset.
- `count(filter)` (`:114`) — counts non-dead entities matching `filter`.
- `onChunkUnloading(chunk, player)` (`:121`) — for each entity in the chunk except the player: `deathTime = 0; dead = true; this.remove(e)` (immediate, bypasses the death animation and `die()`/`onDeath`).

### Lifecycle hooks the manager honours
| Hook / field | Where read | Semantics |
|---|---|---|
| `entity.tick()` | `:47` | only when alive, in-sim, chunk GENERATED |
| `entity.dead` | `:37,52` | set it directly for instant reap (with `deathTime >= deathAnimTicks`) |
| `entity.deathAnimTicks` | `:39,53` | undefined → `?? 0` → reaped on the next tick |
| `entity.deathTime` | `:39,53` | auto-incremented by the manager while dead |
| `entity.onRemoved?.()` | `:73` | **called on every removal path** (reap and chunk unload). The one reliable teardown hook. |
| `entity.buildMesh()` | `:85` | called every frame until it returns non-null |
| `entity.needsMeshRebuild` | `:79` | forces mesh teardown + rebuild |
| `entity.updateRender(alpha)` | `:91` | |
| `mat.userData.shared` | `:69` | opt out of material disposal |

`onRemoved` implementers: `Creeper.onRemoved` (`Creeper.js:81`) and `PrimedTnt.onRemoved` (`PrimedTnt.js:32`), both stopping a tracked `fuseVoice` audio loop.

---

## 5. `Mob` base — `Mob.js:11`

`constructor(world, x, y, z)` (`Mob.js:12`) — **does not accept `opts`**; subclasses that need it declare their own. Fields (`:13–61`):

`hostile = false`, `undead = false`, `detectionRange = 16`, `attackDamage = 0`, `attackReach = 2.0`, `walkSpeed = 0.09`, `chaseSpeed = 0.09`, `xpValue = 5`, `deathAnimTicks = 20`, `deathTime = 0`, `goals = []` (comment: "ascending priority"), `target = null`, `losMemory = 0`, `idleTime = 0` (hostile-despawn timer), `nextIdle = 80 + floor(world.rng()*80)`, `stepAccum = 0`, `hurtTimer = 0`, `attackCooldown = 0`, `moveIntent = null`, `moveSpeed = 0`, `wantJump = false`, `path = null`, `pathIndex = 0`, `pathGoal = null`, `lastPathTick = -99`, `stallPos = null`, `stallTicks = 0`, `directSteerUntil = 0`, `headYawRel = 0`, `headPitch = 0`, `lookPoint = null`, `walkCycle = 0`, `prevWalkCycle = 0`, `swingAmount = 0`, `attackAnim = 99`, `isBaby = false`, `ageTicks = 0`, `breedCooldown = 0`, `loveTicks = 0`, `mate = null`, `eating = false`.

`const TURN_RATE = 30 * Math.PI / 180` (`Mob.js:9`).

### `Mob.tick()` — canonical order (`Mob.js:82–163`)
1. `baseTick()`; `prevWalkCycle = walkCycle`.
2. `if (this.dead) { this.deathTime++; return; }` (`:86`).
3. Timers: `tickTimers()` (invuln/hurtTime), then `attackCooldown--`, `hurtTimer--`, `breedCooldown--`, `loveTicks--`, `attackAnim++` (while `< 99`).
4. Baby maturity (`:97`): `if (--this.ageTicks <= 0) this.growUp();`.
5. `updateMedium()`; **`tickEnvironment()`**; `if (this.dead) return;`
6. `if (this.tickDespawn()) return;`
7. AI gate: `const pd = player ? this.distTo(player) : 999;` `moveIntent = null; wantJump = false;` **`if (pd <= 64) { this.updateTarget(player); this.runGoals(); }`**
8. `applyLocomotion()`
9. **`this.postMove?.()`** — subclass quirk hook (`:129`).
10. `updateYaw()`
11. Animation state: `hSpeed = hypot(pos.x-prevPos.x, pos.z-prevPos.z)`; `walkCycle += hSpeed*4`; `swingAmount = swingAmount*0.9 + min(1,hSpeed*8)*0.1`.
12. Idle voice (`:140`): on `--nextIdle <= 0` reset to `80 + floor(rng()*80)`; emits `mob.${this.type}.idle` when `pd <= 16` and not silent (`silent = type === 'creeper' || (type === 'spider' && this.target)`).
13. Footsteps (`:152`): `stepAccum += hSpeed`; threshold `thr = (type === 'chicken' || type === 'spider') ? 1.0 : 1.5`; emits `mob.step.${matOf(blockBelow)}`.

### Other `Mob` methods
- `distTo(e)` (`:64`) — feet-to-feet 3D. `centerDistTo(e)` (`:66`) — center-to-center.
- `canSee(e)` (`:72`) — `hasLineOfSight` from `this.pos.y + height*0.85` to `e.pos.y + e.height*0.85`.
- `lookAt(x,y,z)` (`:78`) — sets `lookPoint`, consumed and cleared by `updateYaw`.
- `growUp()` (`:165`) — `isBaby = false; width = adultWidth ?? width*2; height = adultHeight ?? height*2; needsMeshRebuild = true;`
- `tickEnvironment()` (`:172`) — lava: `hurt(4,'lava')` every 10 ticks + `fireTicks = 300`; fire: `hurt(1,'burn')` every 20 ticks, cleared by water; **undead daylight burn** (`:183`) every 4 ticks when `!isBaby && world.skyDarken < 4 && canSeeSky(x, floor(pos.y+height), z) && !inWater && !isRainingAt(...)` → `fireTicks = max(fireTicks, 160)`; `if (pos.y < -64) { deathTime = deathAnimTicks; dead = true; }` (**no `die()`, no drops, no death sound**).
- `tickDespawn()` (`:196`) — returns `false` immediately when `!this.hostile || this.persistent`. `d > 128` → `despawn()`; `d > 32` → `idleTime++`, and `idleTime > 600 && rng() < 1/800` → `despawn()`.
- `despawn()` (`:209`) — `dead = true; deathTime = deathAnimTicks; noDrops = true;` (**bypasses `die()`/`onDeath`**).
- `updateTarget(player)` (`:217`) — drops target if `target.dead || distTo(target) > detectionRange*1.5`; every 10 ticks re-checks LOS, dropping the target after `losMemory >= 10`. Acquisition (every 10 ticks): requires `this.hostile && player && !player.dead && player.gameMode !== 'debugCreative'`, `range = detectionRange * (player.sneaking ? 0.8 : 1)`, **`this.acquireGate(player)`**, and `this.canSee(player)`.
- `acquireGate() { return true; }` (`:238`) — **override point** ("spider light gate, enderman stare override"). Called with `player` as an argument, but neither the base nor any override declares a parameter.
- `onHurtBy(source)` (`:240`) — `hurtTimer = 100; idleTime = 0;`
- `onHurt(dmg, source, opts)` (`:245`) — calls `onHurtBy(source)`; emits `mob.${type}.hurt` when `dmg > 0`; **retaliation**: `if (opts?.attacker && this.retaliates !== false) { this.target = opts.attacker; this.forcedAggro = true; this.losMemory = 0; }`
- `onDeath()` (`:259`) — emits `mob.${type}.death` **first**; `if (this.noDrops) return;`; `const game = this.world.game; if (!game) return;`; drops via **`this.dropTable?.() ?? []`** (skipped for babies unless `type === 'zombie'`), each `{name,count}` with `count > 0` → `game.spawnItemByName(d.name, d.count, pos.x, pos.y+height/2, pos.z)`; XP: `const xp = this.isBaby && !this.hostile ? 0 : this.xpValue;` → `game.spawnXpOrb(pos.x, pos.y+height/2, pos.z, xp)`.
- `doMeleeAttack(t)` (`:433`) — `t.hurt(this.attackDamage, 'melee', { dirX, dirZ, knockback: 0.4, attacker: this }); this.attackAnim = 0;`
- `buildMesh()` (`:444`) — calls **`this.buildModel?.()`**; expects `{ group, parts }`; stores `this.parts`; if `isBaby`: `group.scale.setScalar(0.5)` and `parts.head?.scale.setScalar(1.4)`; returns `built.group`.
- `updateRender(alpha)` (`:455`) — lerps position; **`rotation.y = lerpAngle(prevYaw,yaw,alpha) + Math.PI`** ("model faces +Z; entity yaw 0 faces −Z"); death fall-over: `t = min(1, sqrt(min(1, deathTime/10)))`, `rotation.z = t*π/2`, sinks `0.2*(deathTime-10)/10` after tick 10, and **sets `this.hurtTime = 5` every frame to hold the red tint**; then `applyLightScalar()`; then `animate(alpha)`.
- `animate(alpha)` (`:476`) — drives `parts` by convention: `legFL/legFR/legBL/legBR` (quadruped, diagonal pairs in phase), `legL/legR` (+ optional `legL2/legR2`), `armL/armR` (unless `this.armsForward`), `legs[]` (spider splay, reads `userData.baseRotY` and `userData.side`), `head` (`rotation.y = headYawRel`; `rotation.x = eating ? 40°+sin(age*0.8)*0.1 : -headPitch`). Leg curve: `leg(phase) = cos(cyc*0.6662 + phase) * 1.4 * swingAmount`. Ends with **`this.animateExtra?.(alpha, cyc, sw)`**.

### Locomotion contract — `applyLocomotion()` (`Mob.js:300`)
Goals write **`moveIntent = {x,z}` (normalized), `moveSpeed`, `wantJump`**; `applyLocomotion` consumes them:
- Grounded: `vel.x = vel.x*0.5 + dir.x*speed*0.5` (same z). Airborne: `vel.x += dir.x*speed*0.05`.
- No intent + grounded: `vel.x *= 0.5; vel.z *= 0.5;`
- In water: if the block at `floor(pos.y + height*0.75)` has `fluid === 'water'` → `vel.y += 0.04`; `vel.x *= 0.8; vel.z *= 0.8;`
- `if (wantJump && (onGround || inWater)) vel.y = inWater ? 0.2 : 0.42;`
- `move(vel.x,vel.y,vel.z)`; `trackFall(vy0, pos.y - y0)`; `vel.y = (vel.y - 0.08) * 0.98`; airborne drag `vel.x *= 0.91` (z too); deadzone `|vel| < 0.003 → 0`.

### Pathing — `Mob.js:364–431`
```js
pathTo(x, y, z, speed)                                   // Mob.js:364
clearPath()                                              // Mob.js:376
followPath(speed = this.pathSpeed ?? this.walkSpeed)     // Mob.js:382
chaseTarget(t, speed = this.chaseSpeed)                  // Mob.js:408
```
- `pathTo` — budget check `astarBudgetOk(w.time)`; on failure sets `directSteerUntil = w.time + 10` and returns `false`. Calls `findPath(w, this, floor(pos), x, y, z)`, sets `pathIndex = 0`, `pathGoal`, `pathSpeed`, `lastPathTick = w.time`.
- `followPath` — waypoint reached when `hd < 0.35 && |wp.y - pos.y| < 1.2` (recurses to the next); sets `moveIntent`/`moveSpeed`; `wantJump = true` when `wp.y > pos.y + 0.5 && hd < 1.4`, or when `hitWall && onGround`; **stall detection** every 20 ticks — if displacement since the last sample `< 0.5`, `this.path = null`.
- `chaseTarget` — repath when no path, or goal moved `>= 1` block and `w.time - lastPathTick >= 10`, or `w.time - lastPathTick >= 40`; gated on `w.time >= directSteerUntil`; on repath failure sets `directSteerUntil = max(directSteerUntil, w.time + 60)`. Fallback is direct steering toward the target with jump-on-wall.

### `updateYaw()` (`Mob.js:333`)
Body yaw turns toward the target (`atan2(-(dx), -(dz))`) or, absent a target, toward motion; clamped to `TURN_RATE` per tick. Head: `headYawRel` clamped ±75°, `headPitch` clamped ±40°, both lerped at 0.3 toward the want; with no `lookPoint`, both decay `*= 0.7`.

### `Mob` persistence (`Mob.js:515–547`)
`serialize()` → `{ type, pos, vel, yaw, health, persistent, isBaby, ageTicks, breedCooldown, loveTicks, sheared, woolTint, eggTimer, swell, aggro }` — **a flat union of all subclass fields**; fields absent on a given mob serialize as `undefined`. `deserialize(rec)` calls `super.deserialize(rec)` then restores `health`, `persistent`, baby state (halving `width`/`height` and setting `adultWidth`/`adultHeight`), `breedCooldown`, `loveTicks`, and conditionally `sheared`, `woolTint`, `eggTimer`, `swell`, `aggro`.

---

## 6. Goal framework — `ai.js:116–369`

`export const MOVE = 1, LOOK = 2;` (`ai.js:118`).

```js
export class Goal {                       // ai.js:120
  constructor(mob) { this.mob = mob; this.active = false; }
  get flags() { return MOVE; }
  canStart() { return false; }
  shouldContinue() { return this.canStart(); }
  start() {}
  stop() {}
  tick() {}
}
```

`Mob.runGoals()` (`Mob.js:278–296`) — single pass over `this.goals` in array order with a `claimed` bitmask:
```js
for (const goal of this.goals) {
  if (goal.active) {
    if ((goal.flags & claimed) === 0 && goal.shouldContinue()) { goal.tick(); claimed |= goal.flags; }
    else { goal.stop(); goal.active = false; }
  } else if ((goal.flags & claimed) === 0 && goal.canStart()) {
    goal.start(); goal.active = true; goal.tick(); claimed |= goal.flags;
  }
}
```
Consequences: **earlier array index wins** (the ctor comment at `Mob.js:26` says "ascending priority", meaning ascending priority *number* = decreasing precedence). A goal with `flags === 0` never blocks and is never blocked. `start()` is always followed by `tick()` in the same pass. A goal cannot be pre-empted mid-run by a higher-priority goal unless the higher one claims its flags first in the same pass.

| Goal | `flags` | `canStart()` | Notes |
|---|---|---|---|
| `SwimGoal` (`:130`) | **`0`** | `mob.inWater` | `wantJump = true` every 10 ticks |
| `WanderGoal` (`:138`) | `MOVE` | `rng() < 1/120` | 8 attempts, ±10 x/z, ±7 y, snaps down ≤6; `shouldContinue`: `path && world.time - started < 300` |
| `LookAtPlayerGoal(mob, range = 8)` (`:166`) | `LOOK` | player within `range` && `rng() < 1/50` | `duration = 40 + floor(rng()*41)` |
| `IdleLookGoal` (`:187`) | `LOOK` | `rng() < 1/50` | `duration = 20 + floor(rng()*21)` |
| `MeleeAttackGoal` (`:203`) | `MOVE` | `!!mob.target` | `chaseTarget`; hits when `centerDistTo(t) <= attackReach && attackCooldown <= 0 && canSee(t)`, then `attackCooldown = 20` |
| `PanicGoal(mob, mult)` (`:219`) | `MOVE` | `mob.hurtTimer > 0` | flees 5–8 blocks at `walkSpeed * mult` |
| `TemptGoal(mob, foodIds)` (`:241`) | `MOVE` | player holding `foodIds` within 10 | continues to 12; stops approaching at 2.5 |
| `FollowParentGoal` (`:272`) | `MOVE` | `isBaby` && same-type adult within (16,8,16) && `distTo > 3` | |
| `BreedGoal` (`:289`) | `MOVE` | `mob.loveTicks > 0` | mate search every 10 ticks in (8,4,8); after `kissTicks >= 60` within 1.5 → `game.spawnMobAt(type, …, {isBaby:true, persistent:true})`, `spawnXpOrb(…, 1 + floor(rng()*7))`, both parents `loveTicks = 0`, `breedCooldown = 6000` |
| `EatGrassGoal` (`:320`) | `MOVE` | `rng() < (isBaby ? 1/50 : 1/1000)` && grass at/below | 40-tick timer; consumes `SHORT_GRASS` or `GRASS_BLOCK→DIRT`; calls **`mob.onAteGrass?.()`** |
| `FleeSunGoal` (`:343`) | `MOVE` | `fireTicks > 0 && skyDarken < 4 && canSeeSky(...)` | seeks a shaded/water cell within ±10 |

Mob-local goal classes (not exported): `SwellGoal` (`Creeper.js:7`), `ChaseGoal extends MeleeAttackGoal` (`Creeper.js:46`), `BowAttackGoal` (`Skeleton.js:8`), `LeapAtTargetGoal` (`Spider.js:6`), `StareDownGoal` (`Enderman.js:9`, `get flags() { return 3; }` = MOVE|LOOK).

### A* — `ai.js:1–114`
```js
export function standable(w, x, y, z, mob)                                        // ai.js:14
export function astarBudgetOk(worldTime)                                          // ai.js:28
export function findPath(w, mob, sx, sy, sz, gx, gy, gz, maxRange = 32, maxNodes = 512)  // ai.js:35
```
- `standable` requires solid below, and neither solid nor liquid at `y` and `y+1`; **`mob.tall3`** also requires `y+2` clear; **`mob.wide3`** requires the full 3×3 at `y` clear. These two flags are the mob-shape extension points into pathing (`Enderman.tall3 = true` at `Enderman.js:29`; `Spider.wide3 = true` at `Spider.js:30`).
- Budget: module-level `astarBudgetTick`/`astarRuns`; **max 2 full runs per world tick** (`ai.js:26–31`).
- 4-connected (`DIRS4`, `ai.js:33`). Costs: flat `+1.0`, jump-up `+1.5` (requires `!solidAt(n.x, n.y+2, n.z)`), drop of 1–3 `+1.0 + drop*0.5`. Penalties applied in `relax`: liquid `+4`, orthogonally adjacent `LAVA`/`FIRE` `+16`. Goal snaps down ≤4 to a standable cell or returns `null`. Terminates on exact goal or `h < 0.8`; otherwise returns the best-`h` partial path (or `null` if that is the start). `reconstruct` shifts off the start node.

---

## 7. Declaring a new mob — the concrete checklist the code enforces

1. **Class** extends `Mob` (`Mob.js:11`); ctor signature in-tree is `constructor(world, x, y, z, opts = {})` (Zombie/Passive) or `constructor(world, x, y, z)` (Skeleton/Creeper/Spider/Enderman — **`opts` is silently dropped by these four**).
2. Set `this.type` **after** `super()` (Entity defaults it to `'entity'`). `type` is load-bearing: it keys sound ids `mob.<type>.{idle,hurt,death}` (`Mob.js:147,250,262`), the silent-idle test (`Mob.js:145`), the footstep threshold (`Mob.js:154`), `serialize().type` → `restoreEntity` dispatch (`Game.js:718–728`), `HOSTILE_TYPES` (`index.js:10`), and same-species matching in `FollowParentGoal`/`BreedGoal` (`ai.js:277,299`).
3. Set `width`/`height`, `health = maxHealth = N`, `hostile`, `undead`, `detectionRange`, `attackDamage`, `attackReach`, `walkSpeed`, `chaseSpeed`, `xpValue`; optional flags `tall3`, `wide3`, `armsForward`, `retaliates`, `takesFallDamage`, `persistent`.
4. `this.goals = [...]` — array order = precedence.
5. Optional overrides/hooks: `acquireGate()`, `updateTarget(player)`, `postMove()`, `tickEnvironment()`, `onHurt()`, `onHurtBy()`, `onDeath()`, `onRemoved()`, `armorPoints()`, `armorToughness()`, `damageArmor(dmg)`, `beforeHurt()`, `dropTable()`, `buildModel()`, `animateExtra(alpha, cyc, sw)`, `interact(player, held)`, `onAteGrass()`, `tryDodgeProjectile()`.
6. **Register in `CTORS`** (`index.js:12–15`) — the sole factory table. `createMob` (`index.js:17`) warns `'[mobs] unknown type'` and returns `null` for anything absent.
7. Add to `HOSTILE_TYPES` (`index.js:10`) if hostile — it is what `MobSpawner.hostileCount()` (`index.js:53`) counts against the cap of 40.
8. Add to `SPAWN_WEIGHTS` (`index.js:28`) for natural spawning.
9. Audio: add a `MOB_IDLE[type]` recipe in `src/audio/events.js:322`; `.hurt` and `.death` are **auto-derived** from it in the loop at `events.js:590–607` (hurt = idle @ pitch ×1.19, dur ×0.4, gain ×1.1; death = idle @ pitch ×0.79, dur ×1.5, pitch fall 30%). `NO_IDLE = new Set(['creeper','wither'])` (`events.js:582`); `MOB_DIST` overrides the default 16-block radius (`events.js:584`: `ghast {maxDist:48,refDist:4}`, `dragon`/`wither` `{maxDist:96,refDist:8}`). Unlisted siblings fall back through `resolveEvent` (`events.js:848–858`).

### `createMob` (`index.js:17`)
```js
export function createMob(world, type, x, y, z, opts = {})
```
`new Ctor(world, x, y, z, opts)`; `if (opts.persistent) mob.persistent = true;`; **`mob.yaw = world.rng() * Math.PI * 2; mob.prevYaw = mob.yaw;`** (consumes one RNG draw per creation, including on save restore).

### `MobSpawner` (`index.js:48`)
`constructor(game)`; ticked at `Game.js:202`. `tick()` runs only when `world.time % 20 === 0`; bails at `hostileCount() >= 40`; 8 attempts per wave at `dist = 24 + rng()*72` from the player; `y = 1 + floor(rng()*heightTop(x,z))`; pack size `enderman ? 1+floor(rng()*2) : 1+floor(rng()*4)`; returns after the first successful pack. `validSpawnPos` (`:92`) requires `y in [1,126]`, `spawnableBelow` (`opaque && shape === 'cube' && opacity === 15`, `index.js:44`), two clear cells, species-specific clearance (enderman `y+2`, spider 3×3), `canSpawnHostileAt`, and player distance `>= 24`. `canSpawnHostileAt` (`:115`): `sky > floor(rng()*32)` → false; `getBlockLight !== 0` → false; `spawnLight = max(blockLight, (thundering ? min(sky,10) : sky) - skyDarken)`; returns `spawnLight <= floor(rng()*8)`.

---

## 8. Concrete mobs — exact stats

| Mob | file:line | w×h | health | detect | dmg / reach | walk / chase | xp | flags | goals (in order) |
|---|---|---|---|---|---|---|---|---|---|
| Zombie | `Zombie.js:6` | 0.6×1.95 | 20 | 35 | 3 / 2.0 | 0.12 / 0.12 | 5 | `undead`, `naturalArmor = 2` → `armorPoints()` (`:39`), `armsForward` | Swim, Melee, Wander, LookAtPlayer(8), IdleLook |
| Zombie (baby) | `Zombie.js:21` | 0.3×0.975 | 20 | 35 | 3 | 0.18 / 0.18 (×1.5) | **12** | `ageTicks = Infinity` (never grows) | same |
| Skeleton | `Skeleton.js:85` | 0.6×1.99 | 20 | 16 | — | 0.13 / 0.13 | 5 | `undead` | Swim, **FleeSun**, **BowAttack**, Wander, LookAtPlayer(8), IdleLook |
| Creeper | `Creeper.js:55` | 0.6×1.7 | 20 | 16 | — | 0.13 / 0.13 | 5 | `swell = 0`, `swellDir = -1`, `fuseVoice` | Swim, **Swell**, **Chase**, Wander, LookAtPlayer(8), IdleLook |
| Spider | `Spider.js:24` | 1.4×0.9 | 16 | 16 | 2 / 2.0 | 0.17 / 0.17 | 5 | `wide3`, `forcedAggro`, `postAggroWalk` | Swim, **Leap**, Melee, Wander, LookAtPlayer(8), IdleLook |
| Enderman | `Enderman.js:25` | 0.6×2.9 | **40** | 16 | 7 / 2.5 | 0.14 / **0.30** | 5 | `tall3`, `aggro`, `stareTicks`, `screamTicks` | Swim, **StareDown**, Melee, Wander, LookAtPlayer(8), IdleLook |
| Cow | `passive.js:59` | 0.9×1.4 | 10 | — | — | 0.09 | `1+floor(rng()*3)` | breed: `wheat`, panic ×2.0 | Swim, Panic, Breed, Tempt, FollowParent, Wander, LookAtPlayer(6), IdleLook |
| Pig | `passive.js:79` | 0.9×0.9 | 10 | — | — | 0.09 | `1+floor(rng()*3)` | breed: `carrot`, panic ×1.25 | same |
| Sheep | `passive.js:101` | 0.9×1.3 | 8 | — | — | 0.09 | `1+floor(rng()*3)` | breed: `wheat`, panic ×1.25, `sheared`, `woolTint` | same + **EatGrass** |
| Chicken | `passive.js:169` | 0.4×0.7 | 4 | — | — | 0.09 | `1+floor(rng()*3)` | breed: `wheat_seeds`, panic ×1.4, `takesFallDamage = false`, `eggTimer` | same |

`class Passive extends Mob` (`passive.js:11`) sets `hostile = false`, **`persistent = true`** ("passives never despawn"), `walkSpeed = 0.09`, **`retaliates = false`**, and `opts.isBaby → ageTicks = 6000`. Helpers: `interact(player, held)` (`:25`), `setupGoals(panicMult, extras = [])` (`:38`), `applyBabyBox(w, h)` (`:52`).

Drop tables (all `dropTable()`, `{name, count}[]`, `count <= 0` entries are filtered by `Mob.onDeath`):
- Zombie (`:41`): `rotten_flesh × floor(rng()*3)`; `rng() < 0.025` → `carrot`|`potato` ×1
- Skeleton (`:106`): `bone × floor(rng()*3)`, `arrow × floor(rng()*3)`
- Creeper (`:86`): `gunpowder × floor(rng()*3)`
- Spider (`:78`): `string × floor(rng()*3)`
- Enderman (`:198`): `rng() < 0.5` → `ender_pearl ×1`, else `[]`
- Cow (`:69`): `beef × 1+floor(rng()*3)`, `leather × floor(rng()*3)`
- Pig (`:89`): `porkchop × 1+floor(rng()*3)`
- Sheep (`:145`): `mutton × 1+floor(rng()*2)`, plus `wool_white ×1` if `!sheared`
- Chicken (`:195`): `chicken ×1`, `feather × floor(rng()*3)`

Notable per-mob behaviour:
- **Creeper `SwellGoal`** (`Creeper.js:7`): starts when `target && distTo < 3 && canSee`; `pressure = t && distTo(t) <= 7 && canSee(t)`; `swell = clamp(swell + (pressure ? 1 : -1), 0, 30)`; at `swell >= 30` → `noDrops = true; dead = true; deathTime = deathAnimTicks;` then `game.explode(pos.x, pos.y+height/2, pos.z, 3)` (removed before the blast so it never hurts itself). `animateExtra` (`:92`) scales `1 + 0.3*(swell/30)` and flashes `setRGB(2.2,2.2,2.2)` on a period of 2 (`s >= 0.5`) or 5 ticks.
- **Skeleton `BowAttackGoal`** (`Skeleton.js:8`): needs `seeTime >= 5` and `d <= 15`; strafes at `chaseSpeed*0.6`, backing off (`-0.5`) inside 11.25; draw 20 ticks → `shoot`, then `attackTimer = 60`. `shoot` (`:61`): `speed = 1.6`, gravity compensation `ay += hypot(ax,az)*0.2`, Box-Muller gaussian spread `inacc = 0.0172275 * 6`; `w.game?.entities.add(new Arrow(w, ex,ey,ez, vx,vy,vz, m, { fromPlayer: false }))`.
- **Spider**: `lightHere()` = `world.internalLight(floor pos)`; `acquireGate() { return this.lightHere() <= 11; }` (`:54`); `updateTarget` (`:56`) drops the target in light > 11 **unless `forcedAggro`**, setting `postAggroWalk = 40`; `postMove()` (`:66`) climbs with `vel.y = 0.2` while `(target || postAggroWalk > 0) && hitWall`.
- **Enderman**: `tick()` (`:56`) calls `tickEnderman()` **before** `super.tick()`. Stare detection: `dot > 1 - 0.025/d` plus LOS, `stareTicks >= 5 && !aggro` → `aggro = true, screamTicks = 10, target = p`, scream. Water/rain → `hurt(1,'water')` + `teleportRandom()` every 20 ticks. Aggro maintenance: `noLosTicks >= 40 || outOfReachTicks >= 60` → `teleportNear(target)`; `skyDarken < 4 && rng() < 1/500` → teleport + drop aggro; `aggroLostTicks > 800` → clear aggro. `tryDodgeProjectile()` (`:129`) → `teleportRandom()` — **the hook `Arrow.tick` calls** (`Arrow.js:69`). `teleportRandom` (`:160`): 16 tries, ±32 x/z, ±16 y, `seekDownStandable(...,16)`. `teleportNear` (`:172`): 16 tries, ±8 x/z, ±4 y, depth 8. `onHurt` (`:184`) calls `super.onHurt` first, then always sets `aggro = true`, screams only on the `!wasAggro` edge, and `if (!this.dead) this.teleportRandom()`.
- **Sheep**: `shear(player)` (`:122`) → `spawnItemByName('wool_white', 1+floor(rng()*3), …)`; `interact` (`:131`) handles `shears` then defers to `super.interact`. `buildModel` (`:151`) clones wool materials and rewrites `userData.baseColor` from `woolTint`, then `setTimeout(() => this.updateWoolVisibility(), 0)`. `SHEEP_TINTS` (`:96`): `[0.81836, 0xe9e9e9], [0.05, 0x1f1f23], [0.05, 0x6e6e6e], [0.05, 0xa8a8a8], [0.03, 0x5d4033], [0.00164, 0xe8a5a5]`.
- **Chicken**: `tick()` (`:182`) calls `super.tick()` then `if (vel.y < 0) vel.y *= 0.6` and lays an egg when `!isBaby && --eggTimer <= 0` (`eggTimer = 6000 + floor(rng()*6001)`).

---

## 9. Non-mob entities

| Class | type | w×h | Key constants |
|---|---|---|---|
| `ItemEntity(world,x,y,z,stack,pickupDelay=10)` `ItemEntity.js:85` | `'item'` | 0.25×0.25 | `despawnAge = 6000`; gravity `-0.04`; drag `0.98`; ground friction `0.6`; merge every 40 ticks; destroyed by lava, block id `65` (fire), and cactus (id `43`, `touchesCactus()` `:121`) |
| `Arrow(world,x,y,z,vx,vy,vz,owner,{crit=false,fromPlayer=false})` `Arrow.js:11` | `'arrow'` | 0.5×0.5 | lifetime 1200 (`:41`); stuck lifetime 1200 (`:37`); `dmg = ceil(speed*2)`, crit `+= floor(rng()*(floor(dmg/2)+2))`; drag 0.99 (0.6 in water); gravity `-0.05` |
| `XpOrb(world,x,y,z,value)` `XpOrb.js:26` | `'xp_orb'` | 0.5×0.5 | `value = max(1, value|0)`; lifetime 6000; magnet radius **7.25**, `f = 0.1*(1-d/7.25)**2`; gravity `-0.03`; `applyLightScalar()` overridden to a **no-op** (`:88`) |
| `PrimedTnt(world,x,y,z,fuse=80)` `PrimedTnt.js:8` | `'primed_tnt'` | 0.98×0.98 | `vel.y = 0.2` initial hop; gravity `-0.04`; ground friction 0.7; on `--fuse <= 0` → `dead = true` + `game.explode(pos.x, pos.y+height/2, pos.z, 4, {fire:false})`; `applyLightScalar()` no-op (`:60`) |
| `ThrownProjectile(world,kind,x,y,z,vx,vy,vz,owner)` `ThrownProjectile.js:10` | `'thrown_' + kind` | 0.25×0.25 | `kind ∈ {'egg','snowball','ender_pearl'}`; lifetime 1200; gravity `-0.03`; egg → `1/8` chance `spawnMobAt('chicken', …, {isBaby:true})`; ender_pearl teleports `owner` and `owner.hurt(5,'pearl')` |
| `FallingBlock(world,blockId,x,y,z)` `FallingBlock.js:8` | `'falling_block'` | 0.98×0.98 | gravity `-0.04`, drag 0.98; **moves on Y only** (`this.move(0, this.vel.y, 0)`); `age > 600` → dead; `land()` (`:27`) sets the block, pops a non-collidable occupant first, or drops it as an item |

`XpOrb.tick` pickup (`XpOrb.js:50`) requires `player.xpPickupCooldown === 0` and a raw AABB intersection; it drives `player.orbStreak = min(24, orbStreak+1)`, `player.orbStreakTimer = 40`, `emitSound('player.xp_pickup', null, 2**(orbStreak/12))`, `player.addXp(this.value)`, `player.xpPickupCooldown = 2`.

`ItemEntity.tryPickup` (`:151`) uses `player.getAABB().expand(1.0, 0.5, 1.0)` and `player.give(stack)`; on full absorption emits `player.item_pickup` and `game.hud?.flashPickup?.(stack)`; otherwise writes back `stack.count = leftover`.

`Arrow` / `ThrownProjectile` target filter is **`e instanceof LivingEntity && !e.dead && (this.age > 5 || e !== this.owner)`** (`Arrow.js:62`, `ThrownProjectile.js:42-44`) — a 5-tick owner-immunity window.

### Shared visual helpers (`ItemEntity.js:9–79`)
Module-level `ATLAS` set once by `initEntityVisuals(atlas)` (`:15`, called at `Game.js:57`); `entityAtlas()` (`:16`) exposes `{ texture, TILE, tileUV }`. `makeAtlasMaterial(opts)` (`:18`) → `MeshBasicMaterial` with `alphaTest: 0.5`, `mat.userData.baseColor = new THREE.Color(1,1,1)`. `blockCubeGeometry` / `tileSpriteGeometry` are **cached by `id|size`** in `cubeGeoCache`/`spriteGeoCache` (`:11-12`) and therefore shared — `EntityManager.remove` disposes materials only, never geometries.

### `models.js` conventions
`part(texName, w, h, d, pivot, offset, faceTexName = null)` (`models.js:142`) — dims in px, **1 px = 1/16 m**; `pivot` is the rotation origin in model space (y up from feet); `offset` positions the box center relative to the pivot; a `faceTexName` produces a 6-material array with the face on **+Z** (BoxGeometry order `+X, −X, +Y, −Y, +Z, −Z`). Every material carries `userData.baseColor`. Model builders return `{ group, parts }`; **models face +Z and `Mob.updateRender` adds π** (`Mob.js:462`). Textures are procedurally painted onto 16×16 canvases via the `PAINT` recipe table (`models.js:43–131`) and cached in `texCache` by name (`models.js:5`), seeded deterministically with `mulberry32(xmur3('mobtex:' + name)())`.

---

## 10. `Game.js` integration surface

```js
this.world.game = this;                                   // Game.js:91
this.entities = new EntityManager(this.world, this.scene);// Game.js:96
this.entities.add(this.player);                           // Game.js:98
this.mobSpawner = new MobSpawner(this);                   // Game.js:102
```
Tick order (`Game.js:187–212`): `player.tick(frame)` → `interaction.tick(frame)` → **`entities.tick(this.player)`** → `world.scheduled.run()` → `world.randomTicks()` → `dayNight.tick()` → `mobSpawner?.tick()`. All gated on `this.state !== STATE.LOADING`.

Spawn API (all return the entity or `null`):
```js
spawnItemById(id, count, x, y, z, vel)     // Game.js:631 — default vel {(r()-0.5)*0.2, 0.2, (r()-0.5)*0.2}, pickupDelay 10
spawnItemByName(name, count, x, y, z, vel) // Game.js:641 — idOf(name), warns '[game] unknown item drop'
dropStackAt(stack, x, y, z)                // Game.js:646 — pickupDelay 40
throwStack(stack)                          // Game.js:656
spawnXpOrb(x, y, z, value)                 // Game.js:668
spawnArrow(x, y, z, vx, vy, vz, owner, opts) // Game.js:672
spawnThrown(kind, x, y, z, vx, vy, vz, owner) // Game.js:676
spawnFallingBlock(id, x, y, z)             // Game.js:680 — offsets +0.5 x/z
igniteTnt(x, y, z, fuse = 80)              // Game.js:684 — clears the TNT block, attaches e.fuseVoice = startLoop('world.tnt.fuse', e)
spawnMobAt(type, x, y, z, opts = {})       // Game.js:691 — createMob + entities.add
```

`explode(x, y, z, power, opts)` entity phase (`Game.js:591–621`): `range = 2*power`; queries `entities.getEntitiesInBox(box, ent => !ent.dead)`; exposure = fraction of 9 samples (center + 8 AABB corners) with LOS; `impact = (1 - dist/range) * exposure`; `dmg = floor((impact² + impact)/2 * 7 * range + 1)`; **`if (e instanceof LivingEntity) e.hurt(dmg, 'explosion', {})`**; then velocity is added to **every** entity: `vel += (center - origin)/dist * impact`.

Player melee (`src/player/interaction.js:151–181`): `attack(target)` — `base = item?.attackDamage ?? 1`, `speed = item?.attackSpeed ?? 4.0`, `T = 20/speed`, `charge = clamp((ticksSinceAttack+0.5)/T, 0, 1)`, `dmg = base * (0.2 + 0.8*charge²)`; crit ×1.5 when `vel.y < 0 && !onGround && charge >= 0.848 && !sprinting && !inWater && !onLadder`; sprint adds `kb += 0.5`. Target picking (`interaction.js:143`) filters `x instanceof LivingEntity && x !== this.player && !x.dead` over a ≤3-block ray.

**Entity right-click dispatch** (`interaction.js:380–388`): `use()` picks the nearest entity on the ray ≤3 and calls `entTarget.interact(p, p.heldStack)` — **`interact(player, held)` is the entity-side hook**; a truthy return sets `useDelay = 4`, swings, and consumes the click. Only `Passive.interact` (`passive.js:25`) and `Sheep.interact` (`passive.js:131`) implement it.

Chunk lifecycle: `onChunkGenerated(chunk)` (`Game.js:697`) drains `chunk.pendingSpawns` via `spawnMobAt(rec.type, rec.x, rec.y, rec.z, { persistent: true })`; `onChunkHydrated(chunk, record)` (`Game.js:708`) restores `record.entities` then `record.spawns`; `restoreEntity(rec)` (`Game.js:718`); `onChunkUnloading(chunk)` (`Game.js:734`).

---

## 11. Persistence

`saveManager.serializeChunk(chunk, game)` (`src/save/saveManager.js:53–78`) iterates `chunk.entities`, skipping `game.player` and `e.dead`, calls `e.serialize?.()`, and keeps the record only if `rec.type && rec.type !== 'player' && rec.type !== 'arrow' && !rec.type.startsWith('thrown')` (`:62-63`). **Arrows and thrown projectiles are intentionally not persisted.**

`Game.restoreEntity(rec)` (`Game.js:718–732`) dispatches:
- `'item'` → `ItemEntity.deserialize(world, rec)` (static, `ItemEntity.js:210`)
- `'primed_tnt'` → `PrimedTnt.deserialize(world, rec)` (static, `PrimedTnt.js:71`), then re-attaches `fuseVoice = startLoop('world.tnt.fuse', e)` (`Game.js:731`)
- `'xp_orb'` → `new XpOrb(world, pos…, rec.value)` (**velocity not restored**)
- **everything else** → `createMob(world, rec.type, …, {})` then `e.deserialize(rec)`

So there are **two deserialize conventions**: a `static deserialize(world, rec)` for `ItemEntity`/`PrimedTnt`, and the instance `deserialize(rec)` used for mobs. A new non-mob entity type must be added to the `restoreEntity` if-chain **and** must not be caught by the mob fallback.

---

## 12. Boss / status-effect attachment — what actually exists

**There is no status-effect system anywhere in `src`.** `grep -riE "statusEffect|effects\b|potion|addEffect|hasEffect" src` returns zero hits. There is no effect list, no tick-down, no attribute-modifier layer, no `LivingEntity.effects`. The only per-entity timed states are the ad-hoc fields: `invulnTicks`, `hurtTime`, `fireTicks`, `fallDistance` (`Entity.js:150–157`), and on `Mob`: `hurtTimer`, `attackCooldown`, `breedCooldown`, `loveTicks`, `ageTicks`, `nextIdle`, `idleTime`, `directSteerUntil` (`Mob.js:28–61`).

The hooks a status-effect holder or boss would attach to, all of which already exist and are already used by at least one class:

| Attachment point | Signature / field | Site | Used by |
|---|---|---|---|
| Damage veto | `beforeHurt(amount, source, opts) → false` | `Entity.js:169` | `Player.beforeHurt` (`Player.js:620`) — vetoes all non-`'void'` damage in `debugCreative` |
| Post-damage reaction | `onHurt(dmg, source, opts)` | `Entity.js:195` | `Mob.onHurt` (`Mob.js:245`), `Enderman.onHurt` (`Enderman.js:184`, calls `super` first), `Player.onHurt` (`Player.js:625`) |
| Armor | `armorPoints()` / `armorToughness()` / `damageArmor(dmg)` | `Entity.js:160,161,188` | `Zombie.armorPoints` (`Zombie.js:39`), `Player.armorPoints/armorToughness/damageArmor` (`Player.js:146,152,158`) |
| Death | `onDeath(source, opts)` | `Entity.js:218` | `Mob.onDeath` (`Mob.js:259`), `Player.onDeath` (`Player.js:640`) |
| Teardown | `onRemoved()` | `EntityManager.js:73` | `Creeper` (`:81`), `PrimedTnt` (`:32`) — **the only hook guaranteed on every removal path** |
| Per-tick quirk | `postMove()` | `Mob.js:129` | `Spider.postMove` (`Spider.js:66`) |
| Environment override | `tickEnvironment()` | `Mob.js:109` | base only |
| Projectile evasion | `tryDodgeProjectile() → bool` | `Arrow.js:69` | `Enderman.tryDodgeProjectile` (`Enderman.js:129`) |
| Right-click | `interact(player, held) → bool` | `interaction.js:384` | `Passive` (`passive.js:25`), `Sheep` (`passive.js:131`) |
| Fall-damage opt-out | `takesFallDamage !== false` | `Entity.js:236` | `Chicken` (`passive.js:177`) |
| Retaliation opt-out | `retaliates !== false` | `Mob.js:252` | `Passive` (`passive.js:19`) |
| Death animation length | `deathAnimTicks` | `EntityManager.js:39,53` | `Mob` = 20 |
| Despawn immunity | `persistent` | `Mob.js:197` | `Passive` = `true`; `createMob` honours `opts.persistent` |
| Pathing shape | `tall3` / `wide3` | `ai.js:16,17` | `Enderman`, `Spider` |
| Mesh invalidation | `needsMeshRebuild` | `EntityManager.js:79` | `Mob.growUp` (`Mob.js:169`) |

**Boss-relevant facts already in the tree:**
- `src/audio/events.js` `MOB_IDLE` already defines voices for **unimplemented** types: `villager`, `iron_golem`, `ghast` (`:505`), `blaze` (`:526`), `magma_cube` (`:530`), `wither_skeleton` (`:534`), `shulker` (`:544`), `dragon` (`:548`), `wither` (`:575`). `MOB_DIST` (`events.js:584`) already gives `dragon`/`wither` `{maxDist: 96, refDist: 8}` and `ghast` `{maxDist: 48, refDist: 4}`; `NO_IDLE` (`:582`) already contains `'wither'`. None of these appear in `CTORS` (`index.js:12`) or `HOSTILE_TYPES` (`index.js:10`).
- There is no health-bar UI hook, no boss-bar, no `Mob` field for one.
- The AI gate `if (pd <= 64)` (`Mob.js:120`) and the `SIM_RADIUS = 6` freeze (`EntityManager.js:44`, ≈96 blocks) are hard-coded and apply to every entity.
- `astarBudgetOk` caps pathing at **2 A* runs per world tick globally** (`ai.js:26–31`) — shared across all mobs.
- Nothing scales `xpValue`, drops, or `deathAnimTicks` by mob size; all are per-class literals.

---

## 13. Broken / inconsistent things (as-written)

1. **`Mob.onDeath`'s `noDrops` guard is unreachable.** `noDrops = true` is assigned in exactly two places — `Mob.despawn` (`Mob.js:212`) and `Creeper` `SwellGoal` (`Creeper.js:37`) — and both set `this.dead = true` **directly**, never calling `die()`. Since `onDeath` is invoked only from `LivingEntity.die` (`Entity.js:218`, the sole call site in the tree), `if (this.noDrops) return;` (`Mob.js:263`) can never execute. The comment at `Mob.js:260-261` justifying the death-sound ordering ("would silence the death of any no-drop mob") describes a path that cannot be taken; a detonating creeper and a despawning mob emit **no** `mob.*.death` at all. Same for the void kill at `Mob.js:193`.

2. **Restoring a saved adult zombie has a 5% chance of turning it into a baby.** `Game.restoreEntity` calls `createMob(world, rec.type, …, {})` (`Game.js:725`), and `Zombie`'s ctor rolls `(!opts.noBabyRoll && world.rng() < 0.05)` (`Zombie.js:21`) before `deserialize(rec)` runs. `Mob.deserialize` only has an `if (rec.isBaby)` branch (`Mob.js:534`) — there is no else to undo a ctor-rolled baby.

3. **Restoring a saved baby zombie can double-halve its hitbox.** If the ctor's 5% roll also fires, `width` is already 0.3 (`Zombie.js:24`), and `Mob.deserialize` then does `adultWidth = this.width` (0.3) and `width /= 2` → **0.15 × 0.4875**, with `growUp()` restoring only to 0.3. Passives are unaffected because `Passive` only sets `isBaby` from `opts` (`passive.js:18`).

4. **Saved `FallingBlock`s are dropped on load with a console warning.** `FallingBlock.serialize` (`:54`) emits `type: 'falling_block'`, `saveManager.serializeChunk`'s filter (`saveManager.js:62-63`) excludes only `player`/`arrow`/`thrown*`, so the record is written; `restoreEntity` (`Game.js:724`) then falls through to `createMob(world, 'falling_block', …)`, which logs `'[mobs] unknown type'` and returns `null` (`index.js:19`). The comment at `FallingBlock.js:55` claims this is "handled by saveManager" — `saveManager.js` contains no such write-back.

5. **The player is silently removed from `EntityManager.entities` on first death.** `EntityManager.tick`'s first loop skips `entity === player` (`:36`) and `updateRender` skips it (`:78`), but the **reap loop does not** (`:51-55`). `Player` has no `deathAnimTicks`, so `0 < (undefined ?? 0)` is false → `this.remove(player)` runs while `state === STATE.DEAD` (`Game.js:195,198` still tick entities). `Player.respawn` sets `dead = false` (`Player.js:676`) but never re-adds to the Map. `register(player)` (`:34`) repairs `chunk.entities`, so `getEntitiesInBox` self-heals; the lasting effect is that `entities.count(filter)` (`:114`) no longer sees the player.

6. **Snowball/egg knockback is applied twice.** `ThrownProjectile.impact` (`:75`) calls `entityHit.hurt(0, 'melee', {dirX, dirZ, attacker})` — which itself applies knockback inside `applyDamage` (`Entity.js:192-194`, since `opts.dirX !== undefined`) — and then line `:76` calls `entityHit.applyKnockback?.(0.4, …)` again. Because `applyKnockback` at `:76` is unguarded, a snowball also knocks back through i-frames and against already-`dead` targets, where `hurt` returns `false` early (`Entity.js:168`).

7. **`ThrownProjectile` hits the first candidate, not the nearest.** The comment at `ThrownProjectile.js:34` says "nearest living entity", but `:45` is `const entityHit = candidates.length ? candidates[0] : null;` — `getEntitiesInBox` returns chunk-iteration order. `Arrow.tick` (`:61-65`) does do a real nearest-scan.

8. **`Spider.forcedAggro` is never reset.** `Mob.onHurt` sets `this.forcedAggro = true` on **every** mob for any attacker-bearing hit (`Mob.js:254`), and nothing clears it. Since `Spider.updateTarget` (`:58`) only drops the target when `!this.forcedAggro`, a spider that is hit once has its light gate disabled permanently. (`acquireGate()` at `:54` still gates fresh acquisitions.)

9. **`Mob.tick`'s dead branch is unreachable via the manager.** `EntityManager.tick` `continue`s on `entity.dead` before calling `tick()` (`:37-40`), so `if (this.dead) { this.deathTime++; return; }` (`Mob.js:86`) never runs from the normal loop — `deathTime` is advanced solely by `EntityManager.js:39`.

10. **`Creeper`, `Skeleton`, `Spider`, `Enderman` silently ignore `opts`.** Their ctors are `constructor(world, x, y, z)` (`Creeper.js:56`, `Skeleton.js:86`, `Spider.js:25`, `Enderman.js:26`) while `createMob` passes `opts` as the 5th argument (`index.js:20`). `spawnMobAt('creeper', x, y, z, { isBaby: true })` is a no-op for the baby flag (`opts.persistent` still works — `createMob` applies it externally at `index.js:21`).

11. **Baby heart particles double-fire.** `Mob.tick` emits hearts inside the `isBaby` block (`:99-102`, at `pos.y + height`) and again unconditionally (`:103-105`, at `pos.y + height + 0.3`) when `loveTicks > 0 && age % 10 === 0`. Unreachable in practice because `Passive.interact` (`:32`) only sets `loveTicks` on non-babies.

12. **`Mob.serialize` writes a union of foreign fields.** `sheared, woolTint, eggTimer, swell, aggro` (`Mob.js:526`) are serialized for every mob type, `undefined` for most. `Creeper.swell` round-trips but `swellDir` and `fuseVoice` do not — a restored mid-swell creeper resumes with `swellDir = -1`.

13. **`Entity.applyLightScalar` reads `this.hurtTime`, which only `LivingEntity` declares** (`Entity.js:117` vs `Entity.js:154`). Benign (`undefined > 0` → `false`), but plain `Entity` subclasses never red-tint. Separately, `Mob.updateRender` **writes** `this.hurtTime = 5` every render frame while dead (`Mob.js:469`) to pin the tint — a render method mutating tick state.

14. **Unused imports / dead code**: `MOVE, LOOK` and `B` imported in `Mob.js:4,6` are never referenced there; `let SCRATCH = new AABB();` (`Entity.js:21`) is never used; `Mob.stallTicks` (`:45`) is initialized and never read or written again; `Mob.acquireGate(player)` is called with an argument (`Mob.js:232`) that no implementation declares.

15. **`Sheep.buildModel` defers visibility via `setTimeout(…, 0)`** (`passive.js:164`) because `this.parts` is only assigned by `Mob.buildMesh` **after** `buildModel()` returns (`Mob.js:445-446`) — wool visibility is therefore applied one macrotask after the mesh enters the scene.


<!-- ===== a90c5f931134973c3 ===== -->
Verified the load-bearing claims (setBlock ordering, `tags` absent, `world.dimension` unassigned, `disposeWorld` null-deref, `saveChunkNow`'s `window.game` fallthrough). Merging now.

---

# ClaudeCraft — Integration Reference for Expansion Phases E3–E12, EC

Paths are `src/`-relative. Every citation verified against the tree at commit `b248d39` (v1.0.5).

---

## 1. Tick order & render order

Every new system inserts here. These are the only two ordered sequences in the engine.

### 1.1 `Game.frame(now)` — `Game.js:161-185`

```
161  frame(now) {
162    requestAnimationFrame(this.frame);            // re-armed FIRST, before any work
163    const frameDelta = Math.min(now - this.lastTime, 250);
164    this.lastTime = now;
167    if (state ∈ {PLAYING, PLAYING_UI, LOADING, DEAD}) {
         accumulator += frameDelta;
         while (accumulator >= MS_PER_TICK && ran < MAX_TICKS_PER_FRAME) { tick(); accumulator -= MS_PER_TICK; ran++; }
176      if (ran === MAX_TICKS_PER_FRAME) accumulator = 0;   // spiral-of-death bleed
       }
178    const alpha = Math.min(1, accumulator / MS_PER_TICK);
179    this.render(alpha);
181    this.debug.frameMs = performance.now() - t0;   // includes render
```
`MS_PER_TICK = 50`, `TPS = 20`, `MAX_TICKS_PER_FRAME = 5` — `constants.js:5-7`. **TITLE and PAUSED do not tick. DEAD does.**

### 1.2 `Game.tick()` — `Game.js:187-233`, verbatim

```js
187  tick() {
188    if (!this.world) return;                       // master gate
189    this.tickCount++;
190    const tickStart = performance.now();
192    const playing = this.state === STATE.PLAYING;
193    const frame = playing && !this.sleeping ? this.input.snapshot() : (this.input.snapshot(), NEUTRAL_FRAME);
195    if (this.state !== STATE.LOADING) {
196      this.player.tick(frame);
197      this.interaction.tick(frame);
198      this.entities.tick(this.player);
199      this.world.scheduled.run();
200      this.world.randomTicks();
201      this.dayNight.tick();
202      this.mobSpawner?.tick();
203    }
204    this.chunkManager.tick(this.player.pos.x, this.player.pos.z);
205    if (this.state !== STATE.LOADING) {
206      this.tickBlockEntities();
207      this.tickSleep();
208    }
209    this.save?.tick(this);
210    this.audio?.tick();                 // AMENDS 01 §3 tick step 10
211    this.atlas.animate?.(this.world.time);
212    this.ui?.containers?.tickOpen?.();
215    if (this.state === STATE.LOADING) { … drainRemesh(px,pz,40,12); loadingProgress; meshed>=needed → PLAYING }
229    const dt = performance.now() - tickStart;
230    if (dt > 40 && this.state !== STATE.LOADING) { if (++this.slowTicks >= 2) console.warn(`[game] slow tick: ${dt.toFixed(1)} ms`); }
232    else this.slowTicks = 0;
```

**Ordering facts every new tick system must respect:**
- `world.time++` happens at `env/DayNight.js:133`, i.e. **inside step 201, after `scheduled.run()` at 199.** A `schedule(delay=1)` issued from inside a tick lands on the *next* `run()`.
- `chunkManager.tick` (204) sets `world.playerChunk` — this gates `randomTicks` (`World.js:324`) and `ScheduledTicks.run`'s sim-radius test (`scheduledTicks.js:31`). It runs during LOADING; nothing else in 195-208 does.
- `save?.tick` (209) advances the autosave counter **during LOADING**.
- `tickBlockEntities` (206) runs *after* `scheduled.run()` and `entities.tick()`, not with them.

### 1.3 `Game.render(alpha)` — `Game.js:249-278`, verbatim

```js
250    this.renderer.clear(true, true, true);
251    if (!this.world || this.state === STATE.TITLE) { this.audio?.updateFrame(null); return; }
259    this.applyMouseLook();
260    this.debug.lastRemeshes = this.chunkManager.drainRemesh(this.player.pos.x, this.player.pos.z);
261    this.updateCamera(alpha);
262    this.audio?.updateFrame(this.camera);   // AMENDS 01 §3 render step 6
263    this.debug.audioMs = this.audio?.debug.budgetMs ?? 0;
264    this.dayNight.updateRender(alpha, this.camera);
265    this.entities.updateRender(alpha, this.player);
266    this.particles.update(alpha);
267    this.updateSelectionBox();
269    this.renderer.render(this.scene, this.camera);
271    if (this.state === STATE.PLAYING || this.state === STATE.PLAYING_UI) {
272      this.updateViewmodel(alpha); this.renderer.clearDepth(); this.renderer.render(this.viewmodelScene, this.viewmodelCamera);
274    }
276    this.ui?.hud?.update?.();
277    this.ui?.debug?.update?.();
```
`render` runs in **every** state except the TITLE/no-world early-out — including PAUSED and DEAD. Render order constants: `selectionBox.renderOrder = 11` (`Game.js:336`); chunk water bucket `10`, opaque/cutout `0` (`world/ChunkManager.js:315`); Sky `group` `-10`, sun `-9`, clouds `-8` (`render/Sky.js:22,68,167`).

**Hard rule (`audio/engine.js:2-3`, restated `ui/debug.js:35`):** `emitSound`/`startLoop` are tick-only. Render code must never emit.

### 1.4 States — `constants.js:71-78`

`STATE = { TITLE, LOADING, PLAYING, PLAYING_UI, PAUSED, DEAD }` — **six**, not four. `setState` (`Game.js:136-155`) saves only on `PLAYING → PAUSED` (`:139`); `ui.onStateChange(next, prev)` is always last (`:154`). There is **no Escape→PAUSED handler**; pausing is indirect via pointer-lock loss (`main.js:167-171`).

---

## 2. World & chunk data

### 2.1 Chunk arrays — `world/Chunk.js:13`

| Field | Type | Cite |
|---|---|---|
| `blocks` | `Uint8Array(32768)` | `Chunk.js:18` |
| `states` | `Uint8Array(32768)` | `Chunk.js:19` |
| `skyLight` / `blockLight` | `Uint8Array(32768)`, 0–15 | `Chunk.js:20-21` |
| `heightMap` | `Uint8Array(256)`, `(z<<4)|x` → y+1 of top sky-terminating block | `Chunk.js:22` |
| `biomes` | `Uint8Array(256)` | `Chunk.js:23` |
| `blockEntities` | `Map<blockIndex, {type,data}>` | `Chunk.js:27` |
| `entities` | `Set` (feet-in-chunk) | `Chunk.js:28` |
| `pendingSpawns` / `spawnsDone` | deferred-record channel | `Chunk.js:33-34` |
| `modified` | differs from generator output → must save | `Chunk.js:26` |
| `minY` / `maxY` | tight Y bounds from last mesh | `Chunk.js:31-32` |

Index is **Y-major**: `i = (y << 8) | (z << 4) | x` (`constants.js:18`). `blockIndex` does not mask x/z — every World/LightEngine accessor inlines the masked world-coord form `(y << 8) | ((z & 15) << 4) | (x & 15)` (`World.js:105` et al). Inverse: `x = i & 15`, `y = i >> 8`, `z = (i >> 4) & 15` (`World.js:336`).

`ChunkState = { REQUESTED:0, GENERATED:1, LIT:2, MESHED:3, FAILED:-1 }` (`Chunk.js:5`). Read gate: `World.getChunkAt` returns only at `state >= GENERATED` (`World.js:40`); `LightEngine.chunkAt` identical (`LightEngine.js:80`). Both hold an independent **1-entry cache** invalidated by `world.chunkVersion`, which bumps only on chunk add (`ChunkManager.js:141`) and remove (`:229`).

**`Chunk.install(blocks, heightMap, biomes, states = null)`** (`Chunk.js:37`) zero-fills `states`/`skyLight`/`blockLight` when omitted. The worker path omits `states` (`ChunkManager.js:77`) — **worldgen never emits a state byte and never bit 7.** The save path passes them (`ChunkManager.js:114`).

### 2.2 The frozen bit-7 waterlogged contract — `registry/blocks.js:19-39`, verbatim

```
//   bit 7 (0x80) of every voxel's `states` byte = WATERLOGGED. Owned by 15 for
//   every block in the game; NO other file may assign it.
//   Per-block nibble meanings occupy bits 0–3 ONLY. Bits 4–6 remain free.
//
//   Invariants every state consumer must honor:
//     * `states & 0x80` is meaningful only where BLOCKS[id].waterloggable.
//       setBlock CLEARS bit 7 whenever the new id is not waterloggable (§8).
//     * A bit-7 cell IS a water source for EVERY system: fluid spread, buckets,
//       swimming/drowning, light filtering, hydration, lava interaction,
//       infinite-source formation. Use isWaterCell/isWaterSource — never a bare
//       `id === B.WATER`.
//     * Nibble reads must mask: `state & 0x0F`. A bare `state === 0` test for
//       "fluid source" is WRONG on a waterlogged cell.
//     * Toggling bit 7 must run the light edit AND neighbor updates even though
//       the id is unchanged (AMENDS 01 §4.6/§4.2).
export const WATERLOGGED = 0x80;      // blocks.js:38
export const STATE_NIBBLE = 0x0F;     // blocks.js:39
```

**Bits 4–6 are the only unclaimed per-voxel storage in the game** (`blocks.js:24`). There is no per-cell extra-data map besides `chunk.blockEntities` (`Chunk.js:27`).

Waterloggable set is **exactly 3 blocks** — `chest` (37), `ladder` (39), `oak_fence` (52) — assigned post-hoc at `blocks.js:783-787`. Leaves are a documented deviation (`blocks.js:781-782`).

Predicates (`blocks.js:42-50`): `isWaterCellAt(id,state)`, `isWaterSourceAt(id,state)`, `effFireEnc(id,state)`, `effFireBurn(id,state)`. Facades: `World.isWaterCell` (`:204`), `isWaterSource` (`:209`), `setWaterlogged` (`:217`), `clearedCell` (`:276`).

Enforcement: `World.js:111` (clear), `:117` / `:188-191` (flip detect + `setState` reroute), `:164` (re-schedule), `LightEngine.js:116` / `:269-270` (opacity), `LightEngine.js:56` (`terminatesSky`), `fluids.js:32` (strength 8), `fire.js:65,80,166` (inert fuel), `Game.js:572` (blast-proof: `Math.max(blk.blast, 100)`).

**Masking hazard, called out twice in-code** (`blocks.js:217-220`, `:457-460`): a waterlogged ladder is `0x81..0x84`; `WALL_DIR[state]` without `& STATE_NIBBLE` returns `undefined`. Only `ChunkMesher.emitLadder` masks (`mesh/ChunkMesher.js:413`).

### 2.3 `setBlock` — the write chokepoint

```js
setBlock(x, y, z, id, { state = 0, byPlayer = false, noUpdates = false } = {})   // World.js:101
```
Exact order (verified `World.js:101-169`):

| # | Step | Cite |
|---|---|---|
| 1 | `y < 0 \|\| y > MAX_Y` → false; chunk gate | `:102-104` |
| 2 | read `old`, `oldState` | `:106-107` |
| 3 | **`if (!BLOCKS[id]?.waterloggable) state &= ~WATERLOGGED;`** | `:111` |
| 4 | no-op bail `old === id && oldState === state` | `:112` |
| 5 | `waterlogFlip = (oldState & WATERLOGGED) !== (state & WATERLOGGED)` | `:117` |
| 6 | write `blocks[i]`, `states[i]`, `chunk.modified = true` | `:119-121` |
| 7 | `if (old === B.FIRE && id !== B.FIRE) forgetFire(x,y,z)` | `:130` |
| 8 | block-entity spill when `oldBlock.blockEntity !== newBlock.blockEntity` | `:133-139` |
| 9 | **synchronous relight iff `old !== id \|\| waterlogFlip`** | `:144-146` |
| 10 | `collectDirtyKeys` → `markDirty(k)`; **`if (byPlayer) rebuildNow(keys)`** | `:149-153` |
| 11 | *(if `!noUpdates`)* `onBroken?` then `onPlaced?` — **only when `old !== id`** | `:156-159` |
| 12 | `if (newBlock.fluid) fluids.schedule(x,y,z,newBlock.fluid)` | `:161` |
| 13 | `if (state & WATERLOGGED) fluids.schedule(x,y,z,'water')` | `:164` |
| 14 | `if (newBlock.gravity) checkFall(x,y,z)` | `:165` |
| 15 | `neighborUpdates(x,y,z)` | `:166` |

- A pure nibble change through `setBlock` does **no light work** but still runs 10–15.
- A state-only `setBlock` fires **neither** `onBroken` nor `onPlaced` but **does** fire `neighborUpdates`.
- `noUpdates: true` skips 11–15 but **not** relight or remesh.
- **`setBlock` throws on an unregistered id**: `:111` optional-chains, `:114` does not, `:133` dereferences → TypeError.
- **Re-entrancy is safe by ordering, not by lock.** `light.dirtied` is one shared Set (`LightEngine.js:65`) cleared at the top of `initialLight` (`:193`) and `onBlockChanged` (`:266`). `setBlock` copies it at step 10 *before* any hook can re-enter.

`setState(x,y,z,state,opts)` (`World.js:178`) — bit-7 XOR reroutes to `setBlock` (`:188-191`); otherwise **never touches light and never fires neighbor updates**. `opts.noRemesh` skips remesh dirtying; sole caller is fire aging (`fire.js:227`).

### 2.4 Scheduled ticks & neighbor updates

`ScheduledTicks` — `world/scheduledTicks.js:5`. `buckets: Map<dueTick, {keys:Set<string>, arr:number[]}>` (`:8`).
- `due = world.time + Math.max(1, delayTicks | 0)` — **minimum delay 1; delay 0 becomes 1** (`:12`).
- Dedup by `"x,y,z"` **per bucket only** (`:15-17`) — one cell can hold many pending entries at different due ticks.
- `run()` drains only `buckets.get(world.time)` (`:23-25`). **A skipped due tick is never drained.**
- Sim-radius deferral: chebyshev > `SIM_RADIUS` (6) → **rescheduled +40, not run** (`:31-32`).
- `clear()` (`:42`) — **nothing is persisted across save/load.**
- Dispatch → `World.blockTick` (`:36`).

`blockTick(x,y,z)` (`World.js:308`):
```js
310  if (id === B.AIR) return;
318  if (blk.fluid || (state & WATERLOGGED)) this.fluids.step(x, y, z);
319  else blk.scheduledTick?.(this, x, y, z, state);
```
**The fluid branch shadows `scheduledTick` for any waterlogged cell.** `World.js:315-317` asserts this is safe because no waterloggable block declares one — true today.

`neighborUpdates(x,y,z)` (`World.js:242`) — `DIRS6` (`:11`), **6 face neighbors, no diagonals, never the source cell**. Per neighbor: skip out-of-Y (`:245`); **skip if `nId === B.AIR`** (`:247`) — air cells never receive `neighborUpdate`; `nBlk.neighborUpdate?.()` (`:249`); `fluids.wake` if fluid or bit-7 (`:254`); `checkFall` if gravity (`:255`). **Recursion is unbounded** — no depth counter, no deferred queue.

`randomTicks()` (`World.js:323`) — 13×13 = **169 chunks** (`SIM_RADIUS = 6`, `constants.js:24`), **24 cells/chunk/tick** (`:330`) → **4056 draws/tick from `world.rng`** (`:331`), taken whether or not the block has a `randomTick`.

`world.rng = mulberry32(xmur3('world:' + seedString))` (`World.js:27-28`) — seeded, shared with weather/worldgen/loot. **fire.js deliberately uses `Math.random()` everywhere** to avoid consuming it (`fire.js:4-7`).

### 2.5 Light budget

`LIGHT_NODE_BUDGET = 100_000` (`constants.js:39`). `propagate` guard 400,000 popped nodes (`LightEngine.js:154`); `removeLight` guard 100,000 (`:185-187`). **Both are per-call locals. There is no cross-call or per-tick light budget** — an N-block edit does N unbudgeted synchronous BFS floods, and N `rebuildNow` passes if `byPlayer: true`.

`markDirty` (`LightEngine.js:119-127`) uses `else if` → adds at most one X-neighbor and one Z-neighbor, **never a corner diagonal** — unlike `World.collectDirtyKeys` (`World.js:234-237`) which does add all 4.

### 2.6 The architectural rule for a new engine — `World.js:353-356`, `fire.js` is the worked example

1. New module at `src/world/<name>.js`, importing **only** `registry/blocks.js`, `constants.js`, and leaf helpers. `registry/blocks.js` is pure and worker-safe and **must never import the engine**.
2. `World` imports it (`World.js:8`) and exposes **thin facade methods** (`World.js:353-368`).
3. Block registry hooks call `world.<facade>?.(...)` with optional chaining (`blocks.js:663,677,682`).
4. Scheduling is re-armed **inside the tick handler itself** (`fire.js:193`) and seeded from `onPlaced` (`blocks.js:676`).
5. Any per-cell side-table must be torn down from **both** `setBlock`'s chokepoint (the `World.js:130` pattern) **and** `Game.onChunkUnloading` (`Game.js:739`). `World.js:124-129` enumerates the five removal routes that never touch the owning engine.

---

## 3. Registry

### 3.1 ID ranges occupied

| Range | Contents | Storage |
|---|---|---|
| **0–66** | Blocks. Dense array `BLOCKS[]` (`blocks.js:56`), 67 entries, no holes. `air`=0 (`:308`) … `dead_bush`=66 (`:685`) | `Uint8Array(32768)` → **hard ceiling id ≤ 255. Free: 67–255.** |
| 0–66 (subset) | Block-items sharing the block id (`items.js:64`); 11 excluded by `NO_BLOCK_ITEM` (`items.js:55-59`) → 56 block-items |
| **256–280** | Tools: 5 materials × 5 kinds, loop-assigned (`items.js:89-98`), per material order sword, pickaxe, axe, shovel, hoe |
| **281–287** | `bow, arrow, shears, flint_and_steel, bucket, water_bucket, lava_bucket` (`items.js:100-106`) |
| **288–303** | Armor: 4 materials × 4 slots, loop from 288 (`items.js:116-124`), order helmet, chestplate, leggings, boots |
| **304–317** | Food, hard-coded ids (`items.js:128-143`) |
| **318–345** | Materials & misc, hard-coded (`items.js:153-180`); last = `oak_door` 345 |

**Item ids 256–345 are contiguous with no gaps. First free item id: 346.** `ITEMS` is a `Map` (`items.js:7`) — no density requirement. **The tool and armor loops assign ids in iteration order — inserting a material into `TIERS` (`items.js:75-81`) or `ARMOR` shifts every later id. Append only.**

### 3.2 `defBlock(id, name, opts = {})` — `blocks.js:248`, every supported field

Not exported. `...opts` **spreads last** (`:293`) — opts can override anything. Side effects: `BLOCKS[id] = block` (`:295`), `B[name.toUpperCase()] = id` (`:296`).

| Field | Default | Consumed at |
|---|---|---|
| `shape` | `'cube'` | Mesher switch `mesh/ChunkMesher.js:147-161`. 11 values + `'none'` |
| `bucket` | `'opaque'` | `mesh/ChunkMesher.js:185` — **honored only for `shape:'cube'`** |
| `opaque` | `true` | culling; `isSolidSupport` (`:91`) |
| `collidable` | `true` | physics |
| `targetable` | `true` | raycast |
| `renderSameIdFaces` | `false` | true only on the 3 leaves (`:345`) |
| `emission` | `0` | `LightEngine.js:223`, `:290-298` |
| `opacity` | `15` | `LightEngine.js:115`, `terminatesSky :57` |
| `hardness` | `0` | `-1` = unbreakable |
| `blast` | `0` | `Game.explode :572` |
| `tool` | `null` | `'pickaxe'|'axe'|'shovel'|'shears'` — never `'sword'`/`'hoe'` |
| `tier` | `null` | `null` \| `'class'` \| `0..3` — see §3.4 |
| `gravity` | `false` | `setBlock :165`, `neighborUpdates :255`, `checkFall :263` |
| `climbable` | `false` | ladder only |
| `slipperiness` | `0.6` | ice `0.98` |
| `replaceable` | `false` | exactly 8 blocks (`:311-315`) |
| `fluid` | `null` | `blockTick :318`, `setBlock :161`, `fluids.strength :35` |
| `fluidAlpha` | `1.0` | water `0.7` |
| `blockEntity` | `null` | `'furnace'|'chest'` — `setBlock` spill `:133-139`, `Game.js:461` |
| `interactable` | `null` | dispatch `player/interaction.js:394, :457` |
| `needsSupport` | `null` | **ZERO consumers outside the registry** |
| `collisionBox` | `null` | `[x0,y0,z0,x1,y1,z1]` or the string `'door'` (`:551`) |
| `tiles` | `all(name)` | 6-array, face order **`[+X, −X, +Y, −Y, +Z, −Z]`** (`:59`) |
| `tilesFor` | `null` | `(state, face) => tileName`; called as a **plain function** (`:816`), `this` undefined |
| `drops` | `dropSelf(name)` | `({state, toolClass, toolTier, rng}) => [{name, count}]` |
| `xpForMine` | `null` | called **as a method** (`interaction.js:273`); ore fns use `this` |
| `randomTick` / `scheduledTick` / `neighborUpdate` / `onPlaced` / `onBroken` | `null` | see §2 |
| `canPlaceAt` | `null` | `(world,x,y,z,state?) => bool` |
| `species` | `null` | `'oak'|'birch'|'spruce'` |
| `mat` | `'none'` | overwritten by MAT loop `:726-732` |
| `fireEnc` / `fireBurn` / `lavaIgnite` | `0/0/false` | overwritten by FIRE loop `:771-778` |
| `infiniteBurn` | `false` | **never set true by any block; sole reader `fire.js:197` is unreachable** |
| `waterloggable` | `false` | overwritten by the list `:783-787` |

`CROSS` preset (`:301-304`) spread into 10 blocks. **`mat`, `fireEnc`/`fireBurn`/`lavaIgnite`, and `waterloggable` are assigned post-hoc from name-keyed tables outside `defBlock`** (`:707-732`, `:748-778`, `:783-787`) — deliberately (`:696-700`). All validation is `console.warn`-only (`:729, :736, :773, :785, :805`) — a typo'd name silently yields defaults.

`finalizeBlockTiles(TILE)` (`:802`) is called once, main thread only, from `main.js:27`. It builds `block.tileIndex = Uint16Array(6)` and memoizes `tileIndexFor(state, face)` with cache key `((state & 15) << 3) | face` (`:815`) — **the key masks to the nibble, so `tilesFor` may never read bits 4–7.**

### 3.3 `defItem(id, name, opts = {})` — `items.js:10`, every supported field

`...opts` spreads last (`:36`). `ITEMS.set(id, item)` (`:38`); `NAME_TO_ID.set(name, id)` **only if absent — first registration wins** (`:39`).

| Field | Default | Notes |
|---|---|---|
| `stack` | `64` | `1` on tools/armor/bow/shears/flint_and_steel/filled buckets/bed; `16` on `bucket` and the 3 throwables |
| `kind` | `'material'` | in use: `material, block, tool, sword, shears, bow, flint_and_steel, bucket, armor, food, throwable, seed, bed, door` |
| `toolClass` | `null` | `sword|pickaxe|axe|shovel|hoe|shears` |
| `tier` | `null` | `0..3`. **`shears` has `tier: null`** (`:102`) |
| `speedMult` | `1` | swords forced to 1 (`:93`); shears 15 |
| `attackDamage` | `1` | |
| `attackSpeed` | `4.0` | hand / any non-tool |
| `durability` | `0` | 0 = indestructible |
| `armorSlot` | `null` | `0..3`; guard is `!== undefined && !== null` (`ui/containers.js:554`) |
| `armorPoints` / `toughness` | `0` / `0` | toughness 2 only on diamond |
| `hunger` / `saturation` / `poisonChance` | `0` | |
| `fuel` | `0` | ticks; read only via `fuelValue()` (`:288`) |
| `place` | `null` | block id placed by RMB |
| `placesAs` | `null` | `'bed'|'door'`; dispatch `interaction.js:407, :576, :588` |
| `plantsCrop` | `null` | carrot/potato patched post-hoc (`:149-150`) |
| `bucketFluid` | `undefined` | **tri-state**: undefined / `null` (empty) / `'water'` / `'lava'` |
| `sprite` | `` `item_${name}` `` | block-items get `null` (`:69`); HUD falls back to `BLOCKS[item.place].tileIndex[4]` (`ui/hud.js:17`) |
| `debugOnly` | `false` | `DEBUG_ONLY` set (`:60`) — **ZERO consumers anywhere in `src/`** |

### 3.4 Tool tiers

```js
export function harvestOK(block, toolClass, toolTier) {   // blocks.js:70-74
  if (block.tier == null) return true;
  if (block.tier === 'class') return toolClass === block.tool;
  return toolClass === block.tool && (toolTier ?? -1) >= block.tier;
}
const gated = fn => function (ctx) {                       // blocks.js:75-77
  return harvestOK(this, ctx.toolClass, ctx.toolTier) ? fn.call(this, ctx) : [];
};
```
`gated` **relies on `this` being the block** — works only because call sites use method syntax (`interaction.js:271`, `World.js:288`, `Game.js:583`).

```js
const TIERS = {                                            // items.js:75-81
  wooden:  { tier: 0, speedMult: 2,  dur: 59 },
  stone:   { tier: 1, speedMult: 4,  dur: 131 },
  iron:    { tier: 2, speedMult: 6,  dur: 250 },
  golden:  { tier: 0, speedMult: 12, dur: 32 },
  diamond: { tier: 3, speedMult: 8,  dur: 1561 },
};
```
**Obsidian is the only `tier: 3` block** (`blocks.js:400`).

### 3.5 Item-stack shape today — **there is no `tags` field**

`grep -rn "tags" src/` returns **zero hits.** Verified.

Two distinct shapes, not interchangeable:
- **Inventory stack**: `{ id, count, damage? }`. `damage` added lazily, only when non-`undefined` (`entities/Player.js:112-114`); spend writes `s.damage = (s.damage ?? 0) + n` (`:134`). Merge rule (`:96-104`):
  ```js
  const stackable = max > 1 && stack.damage === undefined;
  … if (s && s.id === stack.id && (s.damage ?? 0) === (stack.damage ?? 0) && s.count < max)
  ```
  **Anything with `damage` defined is unstackable regardless of `item.stack`.** Save packs exactly `{id, count, damage}` (`Player.js:683, :696`) — **any new stack field is dropped on save/load unless added there.**
- **Drop descriptor** from `block.drops`: `{ name, count }` — a *name*, not an id (`blocks.js:65, :83-86`). Converted at spawn: `game.spawnItemByName(d.name, d.count, …)` (`interaction.js:281`, `World.js:294`, `Game.js:584`, `mobs/Mob.js:268`). **This channel cannot carry per-stack data.**

Third merge rule, in the GUI: `same = (a,b) => a && b && a.id === b.id && (a.damage ?? 0) === (b.damage ?? 0)` (`ui/containers.js:11`) — **ignores every other field.**

---

## 4. Worldgen

### 4.1 Seed-stream pattern

Four levels:
1. **World seed** — `terrain.js:15-17`: `typeof seed === 'number' ? (seed >>> 0) : hashString(String(seed ?? ''))`. Mirrored on the main thread at `World.worldSeed = hashString(seedString)` (`World.js:16`).
2. **System sub-seeds** — `noise.js:120-123`, exactly **seven**, no more:
   ```js
   for (const s of ['terrain','carver','ore','tree','plant','herd','detail'])
     seeds[s] = mix32(worldSeed ^ hashString('sys:' + s));
   ```
   Exposed as `ctx.seeds` (`noise.js:287`). **There is no `structure` stream.** Derivation is string-keyed → **inserting a name does not perturb existing streams.**
3. **Per-chunk** — `splitmix32(chunkSeed(ctx.seeds.<sys>, ocx, ocz))`: `caves.js:62-63`, `ores.js:33`, `features.js:103, :124, :270`.
4. **Stateless per-position** — `posHash(seed, x, y, z)`, always on `ctx.seeds.detail`: `terrain.js:46`, `ores.js:71`, `features.js:35, :198`. Main-thread mirror: `World.detailSeed()` (`World.js:378`) re-derives `mix32(worldSeed ^ hashString('sys:detail'))` byte-identically.

**`World.rng` (`World.js:27-28`) is a separate, non-deterministic-order stream** used for drops/loot/explosions/weather — it is *not* part of the worldgen family.

**Two invariants that make neighborhood re-simulation work:**
- **A — draws are always consumed in spec order, regardless of skip decisions.** `caves.js:64-78` draws all worm params before the reach test at `:79`. `features.js:111-112` (`// roll always drawn`). `ores.js:39-42` (`// clipped tail; draws consumed`).
- **B — skip decisions run on independent child streams.** Documented `caves.js:6-12`:
  ```js
  const tRng = splitmix32(mix32(originSeed ^ Math.imul(w + 1, 0x9E3779B9)));   // caves.js:80
  ```
  Ores/trees rely on A alone — sound only because their ±1 radius means every attempt is always fully drawn.

**Cross-chunk purity rule:** any predicate consulted during a neighborhood pass must be a pure function of the seed, never a block read — the neighbor's blocks don't exist. Hence `surfaceBlockFor` (`biomes.js:77-82`, rationale `:75-76`), `isGenWater` (`noise.js:228`), `carvedByCheese` (`noise.js:273-284`). The **whole pure surface** is `noise.js:286-290`.

**Path-walking must use `tsin`/`tcos`** (`math/rng.js:85-86`, 4096-entry `Float32Array`), not `Math.sin` — bit-identical across engines.

### 4.2 Pipeline — `terrain.js:62-75`

```js
62  function generateChunk(cx, cz) {
63    const blocks = new Uint8Array(32768);
64    const colD = ctx.columnData(cx, cz);
65    fillTerrain(blocks, cx, cz, colD);
66    carveCheese(ctx, blocks, cx, cz, colD);
67    carveWorms(ctx, blocks, cx, cz);
68    lavaFlood(blocks);
69    placeOresAndPockets(ctx, blocks, cx, cz);
70    decorate(ctx, blocks, cx, cz, colD);
71    const heightMap = computeHeightMap(blocks);
72    const biomes = Uint8Array.from(colD.biome);        // copy: cache stays live — load-bearing
73    const spawns = rollHerd(ctx, cx, cz);
74    return { blocks, heightMap, biomes, spawns };
75  }
```

Terrain surface is hard-bounded to **y ∈ [40, 124]** (`noise.js:85`). Sea level 63 is hard-coded at `terrain.js:57`, `noise.js:228`, `caves.js:150-154`, `features.js:214` — **`SEA_LEVEL` (`constants.js:12`) is unused by gen.**

### 4.3 Neighborhood radii

| Pass | Origin radius | Constant | Reach guard |
|---|---|---|---|
| `carveCheese` | 0 | — | per-column `caves.js:23-49` |
| `carveWorms` / ravines | **±7** Chebyshev | `CARVE_R = 7` `caves.js:17` | `TUNNEL_REACH = 115` `caves.js:20`, tested `:79, :93` |
| `placeOresAndPockets` | ±1 | inline `ores.js:31-32` | none |
| trees | ±1 | inline `features.js:101-102` | none |
| plants / snow / herd | 0 | | |

**The ±7 / 115 pair is the widest existing multi-chunk mechanism and the closest working precedent for a village/fortress/stronghold generator.** Its shape: iterate origin chunks in a square → `originSeed = chunkSeed(ctx.seeds.<sys>, ocx, ocz)` → draw **all** parameters unconditionally → test a conservative reach bound → simulate on a child stream → clip every write to the current chunk.

**It is also mutually inconsistent — see §11.1. Copying it copies the bug.**

### 4.4 Worker boundary — `workers/terrainWorker.js` (33 lines, the only file in `src/workers/`)

- **main → worker**: `{ type:'init', seed }` once (`ChunkManager.js:38`, seed is the raw **string**); `{ type:'generate', cx, cz, jobId }` (`:88`).
- **worker → main**: `{ type:'ready', worldSpawn }` (`terrainWorker.js:14`); `{ type:'chunk', cx, cz, jobId, blocks, heightMap, biomes, spawns }` with 3 buffers **transferred** (`:18-25`); `{ type:'error', jobId, cx, cz, message }` (`:26-32`).
- **No spatial partitioning.** `WORKER_COUNT = 2` (`constants.js:26`), plain round-robin (`ChunkManager.js:86-87`). Each worker holds its **own** `createGenerator` (`terrainWorker.js:13`) → own `colCache` (LRU 128, `noise.js:164`), own per-layer memos. Adjacent chunks on different workers duplicate all lattice work.
- Flow control `MAX_JOBS_IN_FLIGHT = 16` (`ChunkManager.js:136`). The same `pending` map and `jobId` counter serve **both** worker jobs and IndexedDB hydrate jobs (`:144-146`).
- **Saved chunks skip the worker entirely** (`ChunkManager.js:142-150`).
- One retry, then `ChunkState.FAILED` (`:60-68`) — "visible hole = loud bug signal". `retries` is never cleared on success.

### 4.5 Where a new dimension hooks in

- **`world.dimension` is read but never written.** Verified: the only reference in the tree is `audio/music.js:129` (`const dim = g.world.dimension;`). `World`'s constructor (`World.js:14-29`) never assigns it. The `'nether'`/`'end'` mood branches (`music.js:129-131`) are permanently dead.
- Pre-wired but unconnected scaffolding: `audio/events.js:40-41` ("reserved: 10's blocks default nether, 11's default end"); `blocks.js:701` (nether/end sound classes); `music.js:25` (a full `nether` mood — `phrygianFragment`, 40 BPM, `padLp: 600`, `gain: 0.22`); `MAT_CLASSES` already contains `'nether'` and `'end'` (`events.js:79-84`) → `block.{step,dig,break,place}.nether` **already generate**.
- **BLOCKER — chunk keys have no dimension component**: `chunkKey = (cx,cz) => cx + ',' + cz` (`constants.js:19`), `Chunk.key` (`Chunk.js:17`), `World.chunks: Map<"cx,cz", Chunk>` (`World.js:17`). The IndexedDB `chunks` store is keyed by that same string (`saveManager.js:98, :123`) — **two dimensions collide in one object store.**
- **BLOCKER — worker protocol has no dimension field**; one generator per worker, bound at init (`terrainWorker.js:13`).
- **Fixed vertical geometry**: `MAX_Y = 127` (`constants.js:11`), `Uint8Array(32768)` (`terrain.js:63`), the `* 33` in `key3` (`noise.js:115`, hard-codes the 33-plane Y lattice), `gy <= 32` (`noise.js:235`), the `(y << 8)` shift everywhere.
- `chunkKeyN = (cx,cz) => cx * 131072 + cz` (`noise.js:116`) is injective only while `|cz| < 65536`; `WORLD_BORDER = 1_000_000` caps `|cz|` at 62500 — safe *as configured*.

### 4.6 Where a multi-chunk structure hooks in

- **Pipeline slot**: a new call in `generateChunk` (`terrain.js:62-75`). Position relative to `carveWorms`/`placeOresAndPockets`/`decorate` determines whether carvers cut it and whether `ores.js:69`'s stone-only rule still fires inside it.
- **Seed stream**: add a name to `noise.js:121`.
- **Radius pattern**: copy `carveWorms` (`caves.js:59-101`); co-derive the origin loop and reach bound.
- **Write clipping**: reuse `makePut` (`features.js:76-88`) or the `put(wx,wy,wz,id,mode)` callback of `placeTreeH` (`features.js:24`) — **the established sink abstraction that lets one generator serve both worker and runtime** (`Game.js:750-756` drives it with `world.setBlock`).
- **BLOCKER — no metadata channel**: `generateChunk`'s return shape (`terrain.js:74`) has no field for bounding boxes, piece graphs, or loot seeds. The worker message (`terrainWorker.js:18-25`) and the save record (`saveManager.js:67-77`) would each need one. `chunk.blockEntities` (`Chunk.js:27`) is the only existing per-chunk metadata channel and is keyed by block index.
- **`chunk.pendingSpawns` / `spawnsDone` is the working template** for "generator emits deferred records, main thread consumes once": produced `terrain.js:73` → transported `ChunkManager.js:78` → consumed `Game.js:697-706` → persisted `saveManager.js:74-75` → restored `Game.js:708-715`.
- **`chunk.modified` interaction**: generator-written structures are *not* `modified`, so they are regenerated rather than saved (`saveManager.js:116`, `ChunkManager.js:225`) — **a structure's block layout must stay a pure seed function forever, or existing worlds mutate.** `SAVE_VERSION` does not gate this.

---

## 5. Player, break/place pipeline, inventory

### 5.1 Inventory shape

- `inventory = new Array(36).fill(null)` — hotbar 0–8, main 9–35 (`Player.js:56`)
- `armor = new Array(4).fill(null)` — `[helmet, chest, legs, boots]`, index = `item.armorSlot` (`:57`)
- **`offhand = null`** (`:58`) — a **standalone field, not an inventory index**, despite the comment claiming "slot 45"
- `selectedSlot = 0` (`:59`); `get heldStack()` → `inventory[selectedSlot]` (`:84`)

`give(stack)` (`:93-119`) fills `[0..8, 9..35]` — hotbar first. **Never touches `armor` or `offhand`.** `hasItem(name)` (`interaction.js:356`) and `takeItem(name)` (`:361`) scan `inventory[0..35]` only — **neither sees `offhand` or `armor`.**

### 5.2 Break pipeline — exact call chain

```
Game.tick :197 → Interaction.tick(frame) :65
  → this.currentHit = this.rayHit()                        interaction.js:87  (one raycast/tick)
  → if (input.mouseLeft && !attacked) this.updateMining()  interaction.js:111
      → mineDelay > 0 → swingLoop(); return                :207
      → CREATIVE BRANCH :212-222 — bypasses breakBlock entirely:
          if (block.hardness < 0) return;                  // bedrock immune
          const cleared = world.clearedCell(x,y,z);
          world.setBlock(x,y,z, cleared.id, { state: cleared.state, byPlayer: true });
          particles.blockBreak(); swing(); mineDelay = 4;
      → d = miningDamagePerTick(block)                     :229 → :185-203
      → progress += d; progress >= 1 → breakBlock(); resetMining(); mineDelay = 6;   :236-250
```
```
breakBlock(x, y, z)                                        interaction.js:262-297
  1 read id / block / state BEFORE the erase               :264-266
  2 drops = block.drops({state, toolClass, toolTier, rng: world.rng})   :271-272
  3 xp    = block.xpForMine({...})                         :273
  4 erase: (state & WATERLOGGED) ? setBlock(B.WATER,{state:0,byPlayer:true})
                                 : setBlock(B.AIR,{byPlayer:true})      :278-279
  5 for (d of drops) game.spawnItemByName(d.name, d.count, x+.5,y+.5,z+.5)  :280-282
  6 if (xp > 0) game.spawnXpOrb(...)                       :283
  7 if (block.hardness > 0 && item?.durability) p.damageHeld(toolClass==='sword'?2:1)  :284-286
  8 p.addExhaustion(0.005)                                 :287
  9 SFX: id===B.FIRE ? 'block.extinguish' : `block.break.${matOf(id)}`  :290-295
 10 game.particles?.blockBreak?.(x,y,z,id)                 :296
```
`miningDamagePerTick` (`:185-203`): `damage = speed / hardness`, then `/= harvestOK(...) ? 30 : 100`; `speed /= 5` if `eyeSubmerged`; `/= 5` if `!onGround` (**also while flying**).

### 5.3 Place pipeline — exact call chain

```
Interaction.tick :118-120 → if ((input.rightPressed || (input.mouseRight && useDelay===0)) && !p.usingItem) this.use(input)
use(input)                                                 interaction.js:376-453
  0 entity interact: pickEntityTarget() → entTarget.interact(p, p.heldStack)  :382-389
  1 block.interactable && !p.sneaking → interactWith()     :392-399   (sneak is the only bypass)
  2 if (!held) return                                      :401
  3 held.place != null && hit  → tryPlace(held, hit)       :404-406
    held.placesAs && hit       → tryPlaceSpecial(held,hit) :407-409
  4 kind switch: food / bow / throwable / armor / bucket / hoe / plantsCrop / bone_meal / flint_and_steel   :412-452
```
```
tryPlace(held, hit) -> bool                                interaction.js:511-560
  1 hit.t > reach()                    → false             :518
  2 y < 0 || y > 127                   → false             :519
  3 !BLOCKS[targetId].replaceable      → false             :521
  4 block.collidable && entityBlocksPlacement(x,y,z) → false  :522
  5 per-block state: TORCH / LADDER / FURNACE / CHEST / PUMPKIN   :526-540
  6 block.canPlaceAt && !canPlaceAt(...) → false           :542
  7 waterlog: block.waterloggable && targetId===B.WATER && (getState & STATE_NIBBLE)===0
              → state |= WATERLOGGED   (SOURCES ONLY)      :549-552
  8 w.setBlock(x,y,z, blockId, { state, byPlayer: true })  :554
    this.emitPlace(blockId, x, y, z)                       :556
    if (p.gameMode !== 'debugCreative') p.consumeHeld(1)   :557
    this.swing(); return true                              :558-559
```
`placePosFor(hit)` (`:500-503`): `REPLACEABLE_TARGET(hit.id)` → place **into** the hit cell; else offset by `hit.face`. `hit.face` is the **outward normal of the entered face** (`world/raycast.js:31-35`).

### 5.4 Combat — `attack(target)` `interaction.js:151-181`

```js
const base = item?.attackDamage ?? 1;           // ITEMS default 1
const speed = item?.attackSpeed ?? 4.0;         // ITEMS default 4.0
const T = 20 / speed;
const charge = Math.min(1, Math.max(0, (p.ticksSinceAttack + 0.5) / T));
let dmg = base * (0.2 + 0.8 * charge * charge);
const crit = p.vel.y < 0 && !p.onGround && charge >= 0.848 && !p.sprinting && !p.inWater && !p.onLadder;
if (crit) dmg *= 1.5;
let kb = 0.4; if (p.sprinting) { kb += 0.5; p.stopSprint(); p.vel.x *= 0.6; p.vel.z *= 0.6; }
target.hurt(dmg, 'melee', { dirX, dirZ, knockback: kb, attacker: p });
if (item?.toolClass) p.damageHeld(item.toolClass === 'sword' ? 1 : 2);
p.addExhaustion(0.1); p.ticksSinceAttack = 0; this.swing();
```
`pickEntityTarget()` (`:135-149`) — **single target**, range capped at `min(3.0, blockHit?.t ?? 3.0)`, filter `x instanceof LivingEntity && x !== this.player && !x.dead`, picks smallest `rayAABB` t. **No `gameMode` reach bonus.**

### 5.5 `Player.tick(input)` movement branch — `Player.js:306-309`, strict if/else

```js
if (this.flying) this.flightMove(input);
else if (this.inLava) this.lavaMove(input);
else if (this.inWater) this.waterMove(input);
else this.landMove(input);
```
`flying` wins over every medium. **`flightMove` (`:483`) applies no collision-mode change** — flight still uses `move()` → full solid collision.

### 5.6 `gameMode` — every existing site (it already exists)

`Player.gameMode` (`Player.js:34`), values `'survival' | 'debugCreative'`. Serialized (`:693`), deserialized `?? 'survival'` (`:713`). Toggled by **F4 in `main.js:144`**, not in Game.

| Site | Effect |
|---|---|
| `Player.js:130` `damageHeld` | no durability spend |
| `Player.js:197` `addExhaustion` | exhaustion ignored |
| `Player.js:202` `tickHunger` | no drain — **and no regen** |
| `Player.js:547` `updateSprint` | double-Space toggles `flying` |
| `Player.js:574` `tickEnvironment` | `air=300; fireTicks=0;` early return — skips drown/lava/fire/suffocate/**void** |
| `Player.js:621` `beforeHurt` | all damage blocked except `source === 'void'` |
| `interaction.js:45` `reach()` | 5.2 vs 4.5 — **block ray only; entity attack stays 3 m** |
| `interaction.js:93` | middle-click pick-block gate |
| `interaction.js:212` | insta-break branch |
| `interaction.js:557` | skip `consumeHeld(1)` |
| `main.js:121, 144-147` | F4 toggle; forces `flying=false` → survival; palette visibility |
| `ui/menus.js:392` | creative block palette guard |
| `ui/hud.js:205, 208` | hides fire overlay; shows mode badge |
| `mobs/Mob.js:229` | hostiles don't target a creative player |
| `mobs/Enderman.js:66` | enderman ignores a creative player |

`flying` (`Player.js:33`) — toggled inside `updateSprint` (`:547-553`), branch `:306`, suppresses sneak `:528` and `sneakEdgeClamp` `:511`, zeroes `fallDistance` `:315-319`, gates landing SFX `:323` / bob `:344` / footsteps `:354`, reset in `respawn` `:674`, forced false `main.js:145`. **Not serialized** (`:682-699`).

---

## 6. Entities & mob AI framework

### 6.1 Base classes

`Entity` — `entities/Entity.js:23`. `baseTick()` (`:64`) **"MUST be called first from every subclass tick()"** — copies pos→prevPos, yaw→prevYaw, `age++`, `sampleLight()` every 4 ticks. `buildMesh()` (`:101`) → `null`; **primary render extension point**.

`LivingEntity` — `Entity.js:147`. Adds `health/maxHealth/invulnTicks/lastHurtAmount/hurtTime/deathTime/fallDistance/fireTicks` (`:150-157`). `static ARMOR_SOURCES = new Set(['melee','arrow','explosion','cactus','thorns'])` (`:164`).

Damage pipeline, exact order:
```
hurt(amount, source='generic', opts={})                    Entity.js:167
  1 if (this.dead) return false
  2 beforeHurt(amount, source, opts) — returns exactly false → cancel        :169
  3 i-frames: invulnTicks > 0 && source ∉ {'void','starve'}
       amount <= lastHurtAmount → return false
       else applyDamage(amount - lastHurtAmount, …, noNewWindow = true)
  4 else invulnTicks = 10; lastHurtAmount = amount; applyDamage(amount, …, false)
applyDamage(dmg, source, opts, noNewWindow)                Entity.js:185
  1 if (ARMOR_SOURCES.has(source)) { dmg = armorReduce(dmg); this.damageArmor?.(dmg); }
  2 this.health -= dmg; this.hurtTime = 10;
  3 if (!noNewWindow && opts.dirX !== undefined) applyKnockback(opts.knockback ?? 0.4, dirX, dirZ)
  4 this.onHurt?.(dmg, source, opts)
  5 if (this.health <= 0) this.die(source, opts)
```
`die(source, opts)` (`:215`) → `onDeath?.()`. **`Entity.js:218` is the sole call site of `onDeath` in the tree.**

`opts` contract: `{ dirX, dirZ, knockback = 0.4, attacker }` (`Entity.js:166`).

### 6.2 `EntityManager` — `entities/EntityManager.js:5`

`entities = new Map()` — **id → Entity, insertion order = tick order.** `add(entity)` (`:13`) is the only registration path.

`tick(player)` (`:32`): registers the player; pass 1 skips the player, `continue`s on `entity.dead` (incrementing `deathTime`), freezes anything beyond `SIM_RADIUS` (6) chebyshev or in a chunk `< GENERATED`; pass 2 reaps at `deathTime >= (deathAnimTicks ?? 0)`.

Lifecycle hooks the manager honours:

| Hook / field | Read at | Semantics |
|---|---|---|
| `tick()` | `:47` | only when alive, in-sim, chunk GENERATED |
| `dead` | `:37, :52` | set directly for instant reap |
| `deathAnimTicks` / `deathTime` | `:39, :53` | manager auto-increments `deathTime` while dead |
| **`onRemoved?.()`** | `:73` | **called on every removal path** (reap and chunk unload) — the one reliable teardown hook |
| `buildMesh()` | `:85` | called every frame until non-null |
| `needsMeshRebuild` | `:79` | forces teardown + rebuild |
| `mat.userData.shared` | `:69` | opt out of material disposal |

### 6.3 `Mob` — `entities/mobs/Mob.js:11`

`Mob.tick()` canonical order (`:82-163`): `baseTick()` → dead check `:86` → `tickTimers()` + cooldowns → baby maturity `:97` → `updateMedium()` + **`tickEnvironment()`** `:109` → `tickDespawn()` → **AI gate `if (pd <= 64) { updateTarget(player); runGoals(); }`** `:120` → `applyLocomotion()` → **`postMove?.()`** `:129` → `updateYaw()` → anim state → idle voice `:140` → footsteps `:152`.

`runGoals()` (`:278-296`) — single pass, array order, `claimed` bitmask. **Earlier index wins.** `MOVE = 1, LOOK = 2` (`ai.js:118`). A goal with `flags === 0` never blocks and is never blocked (`SwimGoal`, `ai.js:130`). `start()` is always followed by `tick()` in the same pass. **A goal cannot be pre-empted mid-run unless a higher-priority goal claims its flags first in the same pass.**

Locomotion contract: goals write **`moveIntent = {x,z}` (normalized), `moveSpeed`, `wantJump`**; `applyLocomotion` (`:300`) consumes them, then applies gravity `vel.y = (vel.y - 0.08) * 0.98` **unconditionally**.

Pathing: `pathTo` (`:364`), `followPath` (`:382`), `chaseTarget` (`:408`). **`astarBudgetOk` caps A* at 2 full runs per world tick, globally, shared across all mobs** (`ai.js:26-31`). `standable` (`ai.js:14`) reads **`mob.tall3`** (also needs `y+2`) and **`mob.wide3`** (needs the full 3×3) — the two mob-shape extension points into pathing.

### 6.4 Declaring a new mob — the checklist the code enforces

1. Class extends `Mob`. Ctor in-tree is `(world,x,y,z,opts={})` (Zombie/Passive) or `(world,x,y,z)` (Creeper/Skeleton/Spider/Enderman — **these four silently drop `opts`**).
2. Set `this.type` **after** `super()`. It keys: sound ids `mob.<type>.{idle,hurt,death}` (`Mob.js:147, :250, :262`), silent-idle test (`:145`), footstep threshold (`:154`), `serialize().type` → `Game.restoreEntity` dispatch (`Game.js:718-728`), `HOSTILE_TYPES` (`index.js:10`), same-species matching in `FollowParentGoal`/`BreedGoal` (`ai.js:277, :299`).
3. Set `width/height`, `health = maxHealth`, `hostile`, `undead`, `detectionRange`, `attackDamage`, `attackReach`, `walkSpeed`, `chaseSpeed`, `xpValue`; flags `tall3`, `wide3`, `armsForward`, `retaliates`, `takesFallDamage`, `persistent`.
4. `this.goals = [...]` — array order = precedence.
5. Optional overrides: `acquireGate()`, `updateTarget()`, `postMove()`, `tickEnvironment()`, `onHurt()`, `onHurtBy()`, `onDeath()`, `onRemoved()`, `armorPoints()`, `armorToughness()`, `damageArmor()`, `beforeHurt()`, `dropTable()`, `buildModel()`, `animateExtra()`, `interact(player, held)`, `onAteGrass()`, `tryDodgeProjectile()`.
6. **Register in `CTORS`** (`index.js:12-15`) — the sole factory table. `createMob` warns `'[mobs] unknown type'` and returns `null` otherwise (`index.js:17-19`).
7. Add to `HOSTILE_TYPES` (`index.js:10`) if hostile — counts against `MobSpawner`'s cap of 40 (`index.js:53`).
8. Add to `SPAWN_WEIGHTS` (`index.js:28`) for natural spawning.
9. Audio: add `MOB_IDLE[type]` (`events.js:322`) → `.hurt`/`.death` **auto-derive** (`events.js:590-607`).

`createMob` (`index.js:17`) consumes **one `world.rng` draw per creation** for yaw — including on save restore.

### 6.5 Non-mob entities

| Class | type | Key facts |
|---|---|---|
| `ItemEntity` `ItemEntity.js:85` | `'item'` | despawn 6000; merges every 40 ticks; killed by lava / fire (65) / cactus (43) |
| `Arrow` `Arrow.js:11` | `'arrow'` | lifetime 1200; `dmg = ceil(speed*2)`; **calls `tryDodgeProjectile()` at `:69`** |
| `XpOrb` `XpOrb.js:26` | `'xp_orb'` | magnet radius 7.25; `applyLightScalar()` no-op (`:88`) |
| `PrimedTnt` `PrimedTnt.js:8` | `'primed_tnt'` | `onRemoved` stops `fuseVoice` (`:32`) |
| `ThrownProjectile` `ThrownProjectile.js:10` | `'thrown_'+kind` | kinds hard-coded `{'egg','snowball','ender_pearl'}` |
| `FallingBlock` `FallingBlock.js:8` | `'falling_block'` | moves on Y only; **not restorable — see §11.9** |

Owner-immunity window: `(this.age > 5 || e !== this.owner)` (`Arrow.js:62`, `ThrownProjectile.js:42-44`).

### 6.6 Status-effect surface — **there is none**

`grep -riE "statusEffect|effects\b|potion|addEffect|hasEffect" src/` → **zero hits.** No effect list, no tick-down, no attribute-modifier layer, no `LivingEntity.effects`. The only per-entity timed states are ad-hoc fields: `invulnTicks`, `hurtTime`, `fireTicks`, `fallDistance` (`Entity.js:150-157`); on `Mob`: `hurtTimer`, `attackCooldown`, `breedCooldown`, `loveTicks`, `ageTicks`, `nextIdle`, `idleTime`, `directSteerUntil` (`Mob.js:28-61`).

### 6.7 Boss-relevant scaffolding already in the tree

- `MOB_IDLE` already defines voices for **unimplemented** types: `villager`, `iron_golem`, `ghast` (`events.js:505`), `blaze` (`:526`), `magma_cube` (`:530`), `wither_skeleton` (`:534`), `shulker` (`:544`), `dragon` (`:548`), `wither` (`:575`). None appear in `CTORS` (`index.js:12`) or `HOSTILE_TYPES` (`:10`).
- `MOB_DIST` already gives `dragon`/`wither` `{maxDist:96, refDist:8}` and `ghast` `{maxDist:48, refDist:4}` (`events.js:584`); `NO_IDLE` already contains `'wither'` (`:582`).
- **`Music.selectMood` already reads `game.bossActive`** (`music.js:129`) and `MOODS.boss` exists (`:23-30`); `Music.tick()` interrupts only for boss (`:356-361`). **`bossActive` is never assigned anywhere.**
- **No boss-bar UI hook, no `Mob` field for one.**

---

## 7. Render, atlas, UI screens

### 7.1 Mesher buckets — `mesh/ChunkMesher.js:72`

```js
const builders = { opaque: new Builder(), cutout: new Builder(), water: new Builder() };
```
**Module singletons — `build()` is not reentrant and cannot be moved to a worker without refactor.** Named `water`, not `transparent`.

`blk.bucket` is honored in **exactly one place** — `emitCube` (`:185`). Every other emitter hardcodes: `emitLiquid`/`emitWaterlogged` → `builders.water` (`:269, :300`); `emitCross`/`emitHash`/`emitLadder` → `builders.cutout` (`:375, :386, :415`); `emitBox` → `builders.cutout` unconditionally (`:455`).

Bucket → material binding: `ChunkManager.js:300-318`, `renderOrder = bucket === 'water' ? 10 : 0` (`:315`). The same literal array `['opaque','cutout','water']` appears at `ChunkManager.js:236`. **A fourth bucket requires editing both arrays plus `builders` and `build()`'s return object.**

Vertex `color` attribute is **`Uint8Array`, itemSize 4, normalized — not a color** (`:59`): **r** = skylight ×17, **g** = blocklight ×17, **b** = `AO_CURVE[ao] * shade` baked together, **a** = per-vertex alpha (255 except liquids). Shader recovers `vCol.r * 15.0` (`materials.js:32`).

Shape dispatch — one `switch (blk.shape)` at `ChunkMesher.js:147-161`. **11 shape strings + `'none'`.** A new shape = one `case` + an emitter. The generic emitter is `emitBox(x, y, z, blk, st, box, cull, opts = {})` (`:452`) — flat own-cell lighting, no AO, UVs cropped to the box.

Waterlogging is free for any new non-cube shape: `build()` runs the shape switch then unconditionally `if (st & WATERLOGGED) this.emitWaterlogged(x, y, z, blk)` (`:165`), which early-returns for `shape === 'cube'` (`:298`).

### 7.2 Materials — `mesh/materials.js`

`sharedUniforms` (`:40`) = `{ uAtlas, uSkyDarken, uSkyTint, uFogColor, uFogNear, uFogFar }`. **Contract: mutate `.value` only, never replace the uniform objects** (`:39`) — `make()` spreads references into all three materials (`:56`), so one write hits all three. **`DayNight.updateRender` (`env/DayNight.js:332-336`) is the only writer outside `createChunkMaterials`.**

`AMBIENT_FLOOR` is inlined at shader-compile time from `constants.js` via `${AMBIENT_FLOOR.toFixed(3)}` (`materials.js:24`).

### 7.3 Atlas tile allocation — `assets/atlas.js`

**512×512 canvas, 32×32 grid of 16×16 tiles = 1024 slots.** `ATLAS_SIZE = 512`, `TILE_PX = 16`, `ATLAS_COLS = 32` (`constants.js:33-35`).

```js
export const TILE_NAMES = ['missing', ...BLOCK_TILES, ...DESTROY_TILES, ...ITEM_TILES];   // atlas.js:42
```
- **0** = `'missing'` (magenta checker) — also the fallback for any name with no painter (`:64`) and for any unknown tile name in `finalizeBlockTiles` (`blocks.js:805`, warn-only).
- **1–96** = `BLOCK_TILES` (manual/fixed order, `:9-38`)
- **97–106** = `DESTROY_TILES` = `destroy_0..9` (`:39`)
- **107+** = `ITEM_TILES` = `Object.keys(PAINTERS).filter(n => n.startsWith('item_')).sort()` (`:40`) — **49 item tiles, alphabetical**

**≈156 of 1024 occupied; ~868 free.** **Item tile indices are not stable** — adding one `item_*` painter re-sorts and shifts every later index. Nothing persists tile indices, so this is safe at runtime, but any hardcoded index breaks.

**A new item sprite = one `P.item_<name> = …` entry in `assets/tilePainters.js`** — auto-picked-up, no atlas edit. **A new block tile additionally requires an entry in `BLOCK_TILES`** — a `P.foo` with no `TILE_NAMES` entry is never painted and `TILE['foo']` is `undefined`.

Painter signature: **`(ctx, x0, y0, rng) => void`**, RNG seeded per tile name (`atlas.js:63`). `animate(tick)` (`:90-102`) — **2 frames only**, swapping every 5 ticks, repainting the slot in place → **zero remesh**. Members must be in `TILE_NAMES` or they're silently skipped (`:96`).

### 7.4 How a new container GUI is added — the complete site list

`this.kind` is one of **`'inventory' | 'crafting' | 'furnace' | 'chest'`**, hardcoded. Adding a fifth touches, in order:

1. **`blocks.js`** — `interactable` (string), `blockEntity` (string), `tiles`/`tilesFor`.
2. **`Game.getBlockEntity(x,y,z)`** (`Game.js:455-470`) — a **ternary over exactly two types**:
   ```js
   be = kind === 'chest'
     ? { type:'chest', data:{ slots: new Array(27).fill(null) } }
     : { type:'furnace', data:{ slots:new Array(3).fill(null), burn:0, fuelTotal:0, cook:0, xpBank:0 } };
   ```
   **Any `blockEntity` string other than `'chest'` falls into the furnace branch and silently gets furnace data.**
3. **`Game.tickBlockEntities`** (`:472-486`) — `if (be.type !== 'furnace') continue;` (`:480`). A new ticking container needs its own branch.
4. **`player/interaction.js:457-471`** — the `interactable` switch. Gated upstream by `if (block.interactable && !p.sneaking)` (`:394`).
5. **`ui/containers.js:168-172`** — `open()` craft-grid allocation, keyed on kind.
6. **`ui/containers.js:264`** — `build()` title map, an object literal with **no fallback**; an unknown kind renders the string `"undefined"`.
7. **`ui/containers.js:270-359`** — `build()` if/else chain, one branch per kind.
8. **`ui/containers.js:540-559`** — `shiftTargets()` routing.
9. **`ui/containers.js:673`** — `tickOpen()`'s `stillThere` test, with **magic numeric ids**:
   ```js
   const stillThere = this.kind === 'furnace' ? (id === 35 || id === 36) : this.kind === 'chest' ? id === 37 : true;
   ```
   **A new positional screen defaults to `true` — it will never auto-close on block removal.**
10. **`ui/containers.js:658-664`** — `refresh()` gauges.
11. **`style.css`** — any new gauge / placeholder.

**Slot def contract** — `addSlot(panel, def)` (`:366`), `this.slots.push({...def, el})` (`:374`):

| field | meaning |
|---|---|
| `x`, `y` | **absolute GUI-px, top-left INNER corner** on a 176×166 reference panel; rendered `left: calc(${def.x - 1} * var(--gpx))` |
| `get: () => stack\|null` | **required** — reads live, never cached (`:430`) |
| `set: v => void` | **required** unless `takeOnly` (`:459`) |
| `region` | drives `shiftTargets`. Live: `main, hotbar, armor, offhand, craft, result, container, furnaceIn, furnaceFuel, furnaceOut` |
| `takeOnly` | routes to `takeResult()`; excluded from shift targets / `collectAll` / `numberSwap` / `offhandSwap` / `dropFromSlot` |
| `canPut: stack => bool` | honored in place/shift/number/offhand paths — **not in `set()` directly** |
| `placeholder` | → `el.dataset.ph`; CSS at `style.css:269-289`. Existing: `helmet, chestplate, leggings, boots, shield` |
| `onCraft()` | `takeResult` for `region === 'result'` — consumes one from each non-empty grid cell |
| `onTakeOut()` | `takeResult` for non-result take-only slots — **the furnace XP-drain precedent** (`:348-351`) |

`playerStorageDefs()` (`:215`) returns the 27 main + 9 hotbar defs — **every kind calls it** (`:307, :321, :333, :358`). Mutations must call `this.markBeDirty()` (`:419`), which sets `chunk.modified = true`.

`resultDef(x, y)` (`:238`) closes over `this.craftGrid`/`this.craftW` and `findRecipe` — **a non-crafting output slot must supply its own `takeOnly` def with `onTakeOut`, not `resultDef`.**

Host hooks live in `main.js`: `game.onContainerOpened` → `exitPointerLock` + `setState(PLAYING_UI)` (`:126-129`); `game.onContainerClosed` → `PLAYING` + `requestLock()` (`:130-135`); `onStateChange` force-closes on any exit from `PLAYING_UI` (`:119`).

### 7.5 HUD / F3

`Hud` (`ui/hud.js:21`) — one `overlayEl.innerHTML` (`:25-47`), 9 hotbar slots (`:66-72`), 4 pip rows of 10 (`:73-76`). All status glyphs are **emoji/unicode text**, not atlas tiles; only hotbar icons use `iconCss` (`:6`). `setDirty(key, value)` (`:117`) is the dirty primitive. **No effect display, no boss bar.**

`DebugOverlay.update()` (`ui/debug.js:19`) — throttled to **250 ms**, writes **one `textContent` template literal** (`:39-48`). **Adding an F3 line = extending that one literal. There is no line registry, no `addLine` API.**

---

## 8. Save schema

`SAVE_VERSION = 1`, `DB_NAME = 'mc-world'`, `DB_VERSION = 1`, `AUTOSAVE_INTERVAL = 600` ticks (`constants.js:43-46`). Object stores `'meta'` and `'chunks'` (`save/saveManager.js:18-19`).

### 8.1 Meta record — `saveManager.js:80-89`, key `'world'`

```js
{ version: SAVE_VERSION, seed: game.world.seedString, worldTime: game.world.time,
  weather: game.dayNight?.serialize() ?? null, player: game.player.serialize(), lastSaved: Date.now() }
```
`weather` = `{raining, thundering, rainTimer, thunderTimer, rainLevel, thunderLevel}` (`DayNight.js:369-375`) — **no `time`; that lives on `world`.**

`player` = `Player.serialize()` (`Player.js:682-699`): `pos, vel, yaw, pitch, health, hunger, saturation, exhaustion, foodPoisonTicks, xp (=xpTotal), air, fireTicks, fallDistance, gameMode, inventory, armor, offhand, selectedSlot, spawnPoint`. **`gameMode`, `offhand` and `spawnPoint` all persist. `flying` does not.** XP is stored as a single `xpTotal` and replayed through `addXp` under `_silentXp` (`:719-723`).

### 8.2 Chunk record — `saveManager.js:67-77`, key `chunk.key = "cx,cz"`

```js
{ cx, cz, blocks: chunk.blocks.buffer, states: chunk.states.buffer,
  biomes: chunk.biomes ? chunk.biomes.buffer : new ArrayBuffer(256),
  blockEntities: [{ i, type, data }], spawnsDone, spawns: chunk.pendingSpawns ?? null, entities: [...] }
```
**Deliberately absent, recomputed on load:** `heightMap` (top-down scan, `ChunkManager.js:96-113`), `skyLight`/`blockLight` (`Chunk.install` zero-fills, `LightEngine.initialLight` refills). **Also absent: any per-record version field** — only meta carries `version`.

Entity filter (`:59-66`): skip `game.player`, `e.dead`, and types `'player'`, `'arrow'`, anything `startsWith('thrown')`.

**Only `chunk.modified` chunks are written** (`:116`, `ChunkManager.js:225`). **This makes the generator's output part of the save contract: any gen change silently rewrites all unmodified terrain in existing worlds, and `SAVE_VERSION` does not gate it.**

### 8.3 Migration pattern — there isn't one

`open()` (`:28-31`): strict `!==` version gate → `console.warn('[save] incompatible save version — offering new world only')`, `this.meta = null`. **No migration path. And the chunk store is not cleared** — `savedChunkKeys` is still populated at `:32`, so a new world on a rejected save version will hydrate stale chunk records via `ChunkManager.js:142`.

**Not persisted at all:** `ScheduledTicks.buckets` (`scheduledTicks.js:42` — `clear()`, nothing survives save/load); `fireOrigins` (module-level Map, `fire.js:20-22`; hydrated fires self-register on first tick, `:200-205`); `EntityManager.nextId`.

`saveAll` (`:107-135`) **resolves, never rejects** on `onerror`/`onabort` — the caller cannot detect failure. Its `sync` option is destructured and **never referenced** (`:107`).

---

## 9. Audio surface

```js
export const audio = new AudioEngine();                                    // engine.js:473
export const emitSound = (id, pos, pitch, gain) => audio.emitSound(...);   // engine.js:474
export const startLoop = (id, target) => audio.startLoop(id, target);      // engine.js:475
export function at(x, y, z) { _pos.x = x; … return _pos; }                 // engine.js:480
```
`emitSound(eventId, pos = null, pitchMult = 1, gainMult = 1)` (`:272`) → a **loop handle** if `def.loop`, else `null` (`:359`). **There is no param channel** — this is why `block.door` splits into `.open`/`.close` and `block.note` into one id per instrument.

`at()` returns a **shared module-scope object** — never hold the return value (`:477-479`).

`startLoop(eventId, target = null)` (`:363`) — `target` is `{x,y,z}` | entity (has `.pos`) | `null`. Handle: `{ voice, get alive, setParam(name, value, tau=0.05), setPosition, stop(fadeSec=0.4) }` (`:371-399`). Every method no-ops on a stale handle (generation guard, `:52-53`).

**Registering a new event** — `def(id, o)` in `audio/events.js:15` (module-local; new events must live in that file). Schema: `recipe(v,t0,pitch,gain) -> stopTime` (required; `Infinity` for loops), `bus` (`'sfx'`), `refDist` (1), `maxDist` (16), `cap` (2), `capKey` (null), `priority`, `jitter` (**only `jitter: 0` disables**), `loop`, `muffle`, `distanceOnly`, `replicate` (**never read by `engine.js` — declarative only, for a future net layer**).

**Auto-generating families:** add a class to `STEP_DUR`/`CORES`/`BREAK_LAYERS` → all five of `block.step/dig/break/place.<cls>` + `mob.step.<cls>` generate (`events.js:87-115`). `MAT_CLASSES` **already contains `'nether'` and `'end'`** (`:79-84`). Add `MOB_IDLE[type]` → `.idle/.hurt/.death` auto-derive (`:590-607`).

**Hard constraints:** tick-only (`:2-3`); nothing audible before `ctx.state === 'running'` — pre-gesture emits are **dropped, not queued** (`:273`); max **16** voice starts/tick (`:14`), **24** positional + **8** flat voices (`:12-13`); no allocation in the emit path; loops are never stolen by priority (`:232`).

`drone` (`primitives.js:396-437`) is exported, fully implemented, and **used by zero events** — a live extension point for pads / portals / beacons / boss beds.

---

## 10. Integration points per upcoming phase

### E3/E4 — enchanting (`tags` schema, sweep attack, offhand, table/anvil/grindstone GUIs)

**`tags` does not exist. Adding it touches every stack-identity site:**

| Site | Change | Hazard if missed |
|---|---|---|
| `Player.js:96-104` `give()` merge | `stackable = max > 1 && stack.damage === undefined` → also `&& stack.tags === undefined` | enchanted books merge into one stack |
| `Player.js:683, :696` `packStacks` | packs exactly `{id,count,damage}` | **enchantments silently vanish on save/load** |
| `ui/containers.js:11` `same` | `a.id === b.id && (a.damage??0) === (b.damage??0)` — **ignores every other field** | enchanted + plain merge in the GUI |
| `blocks.js:65` drop descriptor `{name,count}` | no channel for tags | enchanted drops impossible via `spawnItemByName` |
| `Game.js:641` `spawnItemByName` → `idOf(name)` | name→id only | same |
| `ItemEntity.js:210` static `deserialize(world, rec)` | | dropped enchanted items lose tags |

Bits 4–6 of `states` (`blocks.js:24`) are irrelevant here — `tags` is item-side, not voxel-side.

**Sweep attack**: `interaction.js:151-181` `attack(target)` is strictly single-target; the target comes from `pickEntityTarget()` (`:135-149`). A sweep needs `entities.getEntitiesInBox(box, filter)` (`EntityManager.js:96`) — which exists and already carries a **±1 chunk margin** (`:97`). No hook exists; add it inside `attack` after the primary `target.hurt`.

**Offhand — already fully wired:** `Player.offhand` (`:58`), serialized (`:695`), deserialized (`:717`), GUI slot at `(77,62)` with `placeholder: 'shield'` (`containers.js:293`), `region: 'offhand'`, keyboard `KeyF` → `offhandSwap(hovered)` (`:590`), dropped on death (`Player.js:640-657`).
**HAZARD:** `give()` (`Player.js:93`), `hasItem` (`interaction.js:356`) and `takeItem` (`:361`) iterate `inventory[0..35]` only — **an offhand item is invisible to every "do I have X" query**, including `releaseBow`'s `takeItem('arrow')` (`:340`).

**Three new GUIs**: follow the 11-site checklist in §7.4. Specific hazards:
- `Game.getBlockEntity`'s ternary (`Game.js:463-465`) → **anvil/grindstone/enchant table silently get furnace data** unless the ternary becomes a registry.
- `tickOpen()`'s `stillThere` (`containers.js:673`) returns `true` for unknown kinds → **the screen never auto-closes when the block is broken.**
- `build()`'s title map (`:264`) has no fallback → renders `"undefined"`.
- Anvil/enchant need XP: `Player.addXp` (`:181`), `xpToNext(L)` (`:175`). The furnace `xpBank` + `onTakeOut` pattern (`Game.js:465`, `containers.js:348-351`) is the precedent.
- Grindstone (disenchant) must return XP — same path.
- New item ids ≥ 346 (`items.js:180` is the last, 345). **Append; do not insert into `TIERS`.**
- Audio: `ui.click` fires **first, for every slot in every container** (`containers.js:434`), above the takeOnly branch — a new `block.enchant`/`block.anvil_use` event goes in `events.js` via `def()`.

### E5 — redstone (tick-scheduled power engine, pistons, hoppers, observers)

**Engine placement**: follow §2.6 verbatim — `src/world/redstone.js`, importing only `registry/blocks.js` + `constants.js`; `World` facade methods next to `fireTick`/`fireNeighborUpdate`/`lavaFireAttempt` (`World.js:357-368`); block hooks `world.<facade>?.()` (the `blocks.js:663,677,682` pattern).

| Hazard | Cite |
|---|---|
| **Air cells never receive `neighborUpdate`** (`if (nId === B.AIR) continue`) | `World.js:247` |
| **No diagonal neighbor updates** — `DIRS6` only, 6 faces | `World.js:11, :242` |
| **`neighborUpdates` recursion is unbounded and synchronous** — no depth cap, no work queue | `World.js:242-256` |
| **Min scheduled delay is 1** — same-tick scheduling impossible | `scheduledTicks.js:12` |
| **`world.time++` is at step 201, after `scheduled.run()` at 199** — `schedule(1)` from inside a tick lands on the next `run()` | `Game.js:199-201` → `DayNight.js:133` |
| **Dedup is per due-tick only** — one cell can hold many pending entries | `scheduledTicks.js:15-17` |
| **Outside `SIM_RADIUS`(6), ticks are deferred +40, not dropped** — long circuits stall, then fire late in a burst | `scheduledTicks.js:31-32` |
| **`ScheduledTicks` is not persisted** (`clear()`) — **a mid-propagation circuit is lost on save/load** | `scheduledTicks.js:42` |
| **`blockTick`'s fluid/bit-7 branch shadows `scheduledTick`** — a waterloggable repeater/observer would never tick while waterlogged | `World.js:318` |
| **Only bits 4–6 are free** — dust power 0–15 needs 4 bits; the nibble is already spoken for on any block with facing | `blocks.js:24` |
| **State-only `setBlock` fires neither `onPlaced` nor `onBroken`** but does fire `neighborUpdates` — an observer watching a state change gets the neighbor update, not the hook | `World.js:156-159, :166` |
| **`setBlock` throws on an unregistered id** | `World.js:111` vs `:114, :133` |

**Pistons**: each moved cell is one `setBlock` → one **unbudgeted synchronous light BFS** (no cross-call budget, §2.5) plus, with `byPlayer: true`, one synchronous `rebuildNow` pass (`World.js:152`). A 12-block push = 12 floods + 12 rebuilds. The piston head / moving-block needs a new `shape` case (`ChunkMesher.js:147-161`) + `collisionBox` (`blocks.js:281`, string `'door'` is the only non-array precedent, `:551`).

**Hoppers**: block entity → the `Game.getBlockEntity` ternary hazard and the `tickBlockEntities` furnace-only filter (`Game.js:480`). That scan already skips chunks with `blockEntities.size === 0` and anything `< GENERATED` within `SIM_RADIUS` — the right shape, wrong filter.

**Already free**: **all §3.6 redstone sounds exist** (`events.js:736-783` via `mech(id, recipe, extra)`, `capKey: id` so each mech gets its own cap-2 family). `block.note.<instrument>` exists for 10 instruments (`events.js:791-814`); note pitch is `2^((n-12)/12)` as `pitchMult`, `FSHARP4 = 369.994` (`:788-790`).

**RNG**: redstone is deterministic — draw nothing. Do **not** touch `world.rng` (it is already at 4056 draws/tick from `randomTicks`, `World.js:330-331`).

### E6 — villages (multi-chunk structures, villagers + trading GUI)

**Worldgen** — §4.6 applies in full. Additionally:
- **The `CARVE_R`/`TUNNEL_REACH` mismatch (§11.1) is in the exact code you'll copy.** Co-derive the origin radius from the reach bound, don't inherit 7/115.
- Biome for decoration is sampled at **chunk center**, not per column (`features.js:104, :125`) — a village straddling a biome edge must not use that shortcut.
- Six parallel per-biome tables are all length-11 and indexed by biome id (`biomes.js:49, :55, :86-98, :100, :101, :106-116`) — a village-biome gate must edit whichever it reads. `BIOME_TEMPS` is read defensively (`DayNight.js:158` `?? 0.8`); the others are not.
- Structures are **not `chunk.modified`** → regenerated from seed, never saved. **A village's block layout must stay a pure seed function forever.** Loot chests must go through `chunk.blockEntities` (the only per-chunk metadata channel), which *is* persisted (`saveManager.js:55-57`, `ChunkManager.js:117-119`) — but a chest written by the generator is not `modified`, so it must be marked explicitly (the `Game.onChunkGenerated` pattern does exactly this at `Game.js:705`).

**Villagers**: `MOB_IDLE['villager']` and `['iron_golem']` **already exist** → `.hurt`/`.death` auto-derive. Register in `CTORS` (`index.js:12-15`); **not** in `HOSTILE_TYPES`, **not** in `SPAWN_WEIGHTS` (village-spawned, not natural). Set `persistent = true` (the `Passive` precedent, `passive.js:19`) so `tickDespawn` returns false immediately (`Mob.js:197`).

**Spawn delivery**: `chunk.pendingSpawns` / `spawnsDone` is the working template (§4.6) — `terrain.js:73` produces `[{type,x,y,z}]`, `Game.js:697-706` drains it with `{persistent: true}`.

**Trading GUI hazards**:
- Trades live on the **entity**, not a block entity. `open(kind, x, y, z)` sets `be = this.pos ? getBlockEntity(x,y,z) : null` (`containers.js:167`) — an entity-backed container has `be = null`, and `tickOpen`'s `stillThere` returns `true` for unknown kinds (`:673`) → **the trade screen never closes when the villager dies or walks away.** Both the distance check (`d > 8` to `p.pos.y + 1`, `:671`) and the still-there test need entity variants.
- `markBeDirty()` (`:419`) sets `chunk.modified` — useless for an entity-backed container; villager trade state must ride `Mob.serialize()` (`Mob.js:515-547`), which is already a flat union of foreign fields.
- Right-click entry is `entTarget.interact(p, p.heldStack)` (`interaction.js:384`); a truthy return consumes the click. `Passive.interact` (`passive.js:25`) and `Sheep.interact` (`:131`) are the only implementers.

### E7/E8 — nether (multi-dimension engine; netherite tier)

**Three hard blockers, in dependency order:**

1. **Chunk keys have no dimension component** — `constants.js:19`, `Chunk.js:17`, `World.js:17`, and the IndexedDB store key (`saveManager.js:98, :123`). **Two dimensions collide in one object store.** Every consumer of `chunkKey` must change together: `ChunkManager.pending` (`:22`), `requestList` (`:24`), `remeshQueue` (`:26`), `retries` (`:29`), `savedChunkKeys` (`saveManager.js:9`), `Entity.chunkKey` (`Entity.js:45`), `EntityManager.register` (`:20`), `World.collectDirtyKeys` (`:226`), `LightEngine.markDirty` (`:119`), and `fire.js`'s `posKey` origin map (`fire.js:27-28` — **string keys, world coords, already deliberately not bit-packed because ±1e6 overflows `MAX_SAFE_INTEGER`**).
2. **Worker protocol has no dimension field** — `{type:'init', seed}` (`terrainWorker.js:12-14`), `{type:'generate', cx, cz, jobId}` (`ChunkManager.js:88`). One generator per worker, bound at init (`terrainWorker.js:13`). Needs either a dimension arg on `generate` plus a generator map, or a second worker pool. Note `findWorldSpawn()` runs on **every** worker at init (`terrainWorker.js:14`) and `ChunkManager.js:50-53` keeps the first.
3. **`world.dimension` is read but never assigned** (`music.js:129`). Assigning it is the cheapest possible first step — it immediately activates the pre-built `nether`/`end` music moods (`music.js:25`) and the `Music.selectMood` branches (`:129-131`).

**Already free**: `MAT_CLASSES` contains `'nether'`/`'end'` → `block.{step,dig,break,place}.nether` already generate (`events.js:79-115`); `blocks.js:701` documents nether/end as the extension default for `mat`; `events.js:40-41` reserves the id ranges.

**Fixed vertical geometry** (all must move together for a 128-high nether with a bedrock roof): `MAX_Y = 127` (`constants.js:11`), `Uint8Array(32768)` (`terrain.js:63`), the `* 33` in `key3` (`noise.js:115`), `gy <= 32` (`noise.js:235`), `(y << 8)` everywhere, hard-coded sea level 63 (`terrain.js:57`, `noise.js:228`, `caves.js:150-154`, `features.js:214`), `caves.js:145`, `features.js:261`, `ores.js:67`.

**Per-dim sky**: `DayNight.updateRender` (`env/DayNight.js:288-367`) is the **only writer** of `sharedUniforms` (`:332-336`). A nether sky = a `dimension` branch there, plus the `sky.update({...})` payload (`:350-365`). The underwater/lava fog override (`:318-329`) is the precedent for a fixed-fog dimension.

**Per-dim save**: the meta record has one `worldTime`, one `weather`, one `player` (`saveManager.js:80-89`). Per-dim time/weather needs a schema change → `SAVE_VERSION` bump → **and the version gate discards meta but not chunks (§11.4)**, so the bump must also clear the chunk store.

**Portals**: bulk `setBlock` → N unbudgeted light floods (§2.5). Teleport precedents: `Enderman.teleportRandom` (`Enderman.js:160`), `ThrownProjectile` ender_pearl (`:90`). Neither crosses a dimension.

**Netherite tier**: `harvestOK` (`blocks.js:70-74`) already does a numeric `>=` compare — tier 4 needs no gate change. Add to `TIERS` (`items.js:75-81`) **at the end** — the tool loop (`:89-98`) and armor loop (`:117-124`) assign ids in iteration order, so **inserting shifts every later item id.** Obsidian is currently the only `tier: 3` block (`blocks.js:400`). New blocks must be added to `MAT` (`blocks.js:707`) or the warn loop at `:734` fires; new tiles need `BLOCK_TILES` entries (`atlas.js:9-38`), which shifts destroy+item indices (harmless — nothing persists them).

### E9 — potions (status-effect engine, brewing stand GUI)

**There is no status-effect system** (§6.6). Building one:

**Where the tick lives**: `LivingEntity` has no `tick()`. `tickTimers()` (`Entity.js:221`) is called from `Player.tick` (`:262`) and `Mob.tick` (`:90`) — the natural insertion point, and the only one both share.
**HAZARD: `EntityManager.tick` `continue`s on `entity.dead` before calling `tick()`** (`EntityManager.js:37-40`) → **effects on a dying entity never tick down**, and `Mob.tick`'s own dead branch (`Mob.js:86`) is unreachable from the manager.

**Attachment points that already exist and are already used**:

| Point | Signature | Cite | Existing user |
|---|---|---|---|
| Damage veto | `beforeHurt(amount, source, opts) → false` | `Entity.js:169` | `Player.beforeHurt` (`:620`) |
| Post-damage | `onHurt(dmg, source, opts)` | `Entity.js:195` | `Mob` (`:245`), `Enderman` (`:184`), `Player` (`:625`) |
| Armor (→ Resistance) | `armorPoints()` / `armorToughness()` / `damageArmor(dmg)` | `Entity.js:160, :161, :188` | `Zombie.armorPoints` (`:39`), `Player` (`:146-158`) |
| Death | `onDeath(source, opts)` | `Entity.js:218` | `Mob` (`:259`), `Player` (`:640`) |
| **Teardown** | `onRemoved()` | `EntityManager.js:73` | `Creeper` (`:81`), `PrimedTnt` (`:32`) — **the only hook guaranteed on every removal path** |
| Environment | `tickEnvironment()` | `Mob.js:109`, `Player.js:337` | base only / Player |

**BLOCKER — there is no attribute layer.** Speed/Strength/Haste have nowhere to attach:
- `Player.landMove` computes `speed = onGround ? 0.1 * mult * Math.pow(0.6/slip, 3) : 0.02 * mult` inline (`Player.js:414`); `mult` is `sprinting ? 1.3 : 1.0`.
- `Mob.walkSpeed`/`chaseSpeed` are per-class literals (`Mob.js:20-21`).
- `attack()` reads `item?.attackDamage ?? 1` directly (`interaction.js:152`).
- `miningDamagePerTick` reads `item.speedMult` directly (`interaction.js:191`).
Each needs a multiplier hook that does not exist today.

**Persistence**: `Player.serialize()` (`:682-699`) and `Mob.serialize()` (`Mob.js:515-547`, already a flat union) both need an `effects` field. `packStacks` (`:683`) drops unknown stack fields — potion items with per-stack data hit the same wall as E3's `tags`.

**Brewing GUI**: the §7.4 checklist, plus a `tickBlockEntities` branch (`Game.js:480` is furnace-only). Potion items: `defItem` id ≥ 346, a new `kind`. **`use()`'s kind dispatch (`interaction.js:412-452`) and the use-channel (`:301-333`) hard-code exactly two kinds — `'eat'` and `'bow'`.** Drinking is a third. Splash potions ride `kind: 'throwable'` → `throwHeld` (`:755`) → `ThrownProjectile`, whose kinds are hard-coded `{'egg','snowball','ender_pearl'}` (`ThrownProjectile.js:10`).

**HUD**: no effect display. `#status-rows` is one `innerHTML` template (`hud.js:25-47`); `setDirty(key, value)` (`:117`) is the primitive.

**Audio**: `drone` (`primitives.js:396-437`) is the unused loop primitive for a brewing bubble loop.

### E10 — end (stronghold, end gen, elytra physics, shulker box)

- **Stronghold** = E6's multi-chunk problem + the §11.1 hazard.
- **End gen** = E7/E8's three blockers, in full.
- **Elytra**: `Player.tick`'s movement branch (`:306-309`) is a strict if/else — elytra needs a new branch, ordered against `flying`. `flightMove` (`:483`) is the precedent (`speed = 0.049 * (sprinting ? 2.0 : 1.0)`, clamp `vel.y` to ±0.375, no collision-mode change). **HAZARD: `flying` is not serialized** (`:682-699`) — glide state will be lost across save/load unless explicitly added. **HAZARD: `canSprint` (`:531-537`) does not check `flying`** — Ctrl already doubles flight speed; elytra will inherit that.
  Armor slot: `armorSlot` 0..3 (`items.js:22`), chestplate = 1; `Player.armor = new Array(4)` indexed by `item.armorSlot` (`:57`). Equip path (`interaction.js:432-440`) **only equips if the slot is `null`** — no swap. Fall damage: `takesFallDamage !== false` (`Entity.js:236`); `Chicken` (`passive.js:177`) is the opt-out precedent.
- **Shulker box**: **inverts the existing block-entity contract.** `setBlock` step 8 (`World.js:133-139`) **spills** block-entity contents via `game.spillBlockEntity` whenever `oldBlock.blockEntity !== newBlock.blockEntity`. A shulker box must instead capture contents into the dropped item — **which requires E3's `tags` first.** The `blockEntities` save round-trip (`saveManager.js:55-57`, `ChunkManager.js:117-119`) works as-is once placed.
- `MOB_IDLE['shulker']` (`events.js:544`) and `['dragon']` (`:548`) already exist.
- Chorus/end-stone blocks: new ids 67+ (free), `MAT` entry required (`blocks.js:707`, else warn at `:734`), `BLOCK_TILES` entry (`atlas.js:9-38`), `'end'` mat class already reserved (`blocks.js:701`, `events.js:79-84`).

### E11 — bosses (boss bar, dragon/wither state machines, beacon)

**Already scaffolded**: `MOB_IDLE['dragon']` (`events.js:548`), `['wither']` (`:575`); `NO_IDLE` contains `'wither'` (`:582`); `MOB_DIST` gives both `{maxDist:96, refDist:8}` (`:584`). **`Music.selectMood` already reads `game.bossActive`** (`music.js:129`), `MOODS.boss` exists (`:23-30`), and `Music.tick()` interrupts only for boss (`:356-361`) — **assign `game.bossActive` and boss music works with zero audio work.**

**Hard limits that break a boss fight:**

| Limit | Cite | Effect |
|---|---|---|
| `if (pd <= 64)` AI gate in `Mob.tick` | `Mob.js:120` | a boss further than 64 blocks runs no goals at all |
| `SIM_RADIUS = 6` entity freeze (~96 blocks) | `EntityManager.js:44`, `constants.js:24` | dragon leaves sim range mid-fight |
| **2 A\* runs per world tick, globally** | `ai.js:26-31` | a boss competes with every other mob for pathing |
| `detectionRange` default 16 | `Mob.js:17` | per-class, easily raised |
| `applyLocomotion` applies gravity unconditionally | `Mob.js:300` | a flying boss must **override `applyLocomotion`**, not use `postMove` (`:129`) |
| `deathAnimTicks = 20` | `Mob.js:24` | reaped at `deathTime >= deathAnimTicks` (`EntityManager.js:53`) |

**HAZARD — `Mob.onDeath`'s `noDrops` guard is unreachable** (§11.7): `noDrops = true` is set only in `Mob.despawn` (`:212`) and `Creeper`'s `SwellGoal` (`Creeper.js:37`), and **both set `dead = true` directly, never calling `die()`.** Since `onDeath` runs only from `LivingEntity.die` (`Entity.js:218`), a boss that ends itself the same way emits **no death sound and drops nothing**. Bosses must call `die()`.

**Boss bar**: no hook exists. `Hud` is one `innerHTML` template (`hud.js:25-47`) with `setDirty(key, value)` (`:117`) as the only primitive. `#status-rows` (`:31-36`) is the container to extend.

**Beacon**: block entity (→ the `getBlockEntity` ternary hazard) + a beam. No beam precedent — `Sky`'s `band` (`Sky.js:139`, `CircleGeometry` + radial-fade shader, additive) is the closest existing custom-shader mesh. Beacon effects depend on **E9**.

**Wither skulls**: `ThrownProjectile`'s kinds are hard-coded (`ThrownProjectile.js:10`); `Arrow` is the better template (real nearest-scan at `:61-65`, `tryDodgeProjectile` hook at `:69`).

### E12 — multiplayer (host-authoritative sync of all game state)

**Determinism audit — what is and isn't reproducible:**

| Stream | Seeded? | Cite |
|---|---|---|
| Worldgen (7 sub-streams) | **yes**, fully | `noise.js:120-123` |
| `world.rng` | seeded, but **order-dependent** — `mulberry32(xmur3('world:'+seed))` | `World.js:27-28` |
| — consumed by `randomTicks` | **4056 draws/tick** | `World.js:330-331` |
| — consumed by `popBlock` loot | `World.js:288-290` |
| — consumed by `Game.explode` | `Game.js:550` |
| — consumed by `DayNight` weather | `DayNight.js:113` |
| — consumed by `createMob` yaw | **one draw per creation, including on save restore** (`index.js`) |
| **`fire.js`** | **`Math.random()` everywhere, deliberately** | `fire.js:4-7, :44` |
| `ambience.js` | `Math.random()`, deliberately (client-only) | `ambience.js:71-72` |
| `Music` | `mulberry32(xmur3(seed+':music:'+pieceIndex))` (client-only) | `music.js:145` |

**→ Fire cannot be lockstepped.** It must be host-authoritative and replicated. Everything drawing from `world.rng` is reproducible *only if call order is identical* — any client-side divergence (a mob spawn, an explosion, a loot roll) desyncs the whole stream.

**State that must sync**, and what is missing:

| State | Where | Missing |
|---|---|---|
| `chunk.blocks` / `states` / `blockEntities` | `Chunk.js:18-27` | serializable today (`saveManager.js:67-77`) |
| `entities` Map | `EntityManager.js:6` | **`nextId` is a local counter** (`:11`) → id collisions across hosts |
| `Player` | `Player.serialize()` `:682-699` | one player per meta record (`saveManager.js:85`) |
| `world.time` / `skyDarken` | `World.js:19-20` | fine |
| weather | `DayNight.serialize()` `:369-375` | fine |
| **`ScheduledTicks.buckets`** | `scheduledTicks.js:8` | **`clear()` only — no serializer exists** (`:42`) |
| **`fireOrigins`** | `fire.js:27-28` | **module-level Map, never saved** (`:20-22`) |

**Input**: `Input.snapshot()` (`input.js:67-93`) already produces the right shape and drains its own edge buffers — but **`pressed` is a `Set`** (not JSON) and `NEUTRAL_FRAME` (`Game.js:34-38`) is a **shared mutable module-level object whose `pressed` Set is handed to `player.tick()` on every non-playing tick.** `releasedBuf` is maintained (`input.js:33`) and cleared (`:89`) but **never surfaced** — no consumer can see release edges.

**The lockstep boundary** is `Game.tick()` (`Game.js:187-232`) — steps 196–202 are the simulation; 204–212 are presentation + chunk streaming.

**`replicate` is already annotated per-event** in `events.js` and is **never read by `engine.js`** — the audio layer's net contract is pre-declared and waiting.

**HAZARD — `window.game` is DEV-only** (`Game.js:83`), and `saveManager.saveChunkNow` depends on it (§11.2). Any host/client split must not inherit that.

### EC — creative mode (gameMode save field, flight, instant-break/no-drops, creative inventory)

**Everything on the headline list already exists** (§5.6). The real work is fixing the inconsistencies the maps surfaced:

| # | Defect | Cite |
|---|---|---|
| 1 | **Creative consumption is inconsistent.** `tryPlace` guards (`:557`), but `tryPlaceSpecial` door/bed (`:584, :596`), `plantSeed` (`:611`), `useBoneMeal` (`:652`), `throwHeld` (`:765`), `dropHeld` (`:777`), eat (`:324`), `fillBucketStack` (`:716`), `useBucketFilled` (`:739, :751`) and `releaseBow`'s `takeItem('arrow')` (`:340`) all consume unconditionally | `interaction.js` |
| 2 | `damageArmor` has **no creative guard** while `damageHeld` does | `Player.js:158` vs `:130` |
| 3 | `onDeath` drops the full inventory/armor/offhand and wipes XP **regardless of `gameMode`** | `Player.js:640-657` |
| 4 | **Creative players cannot die at all.** `beforeHurt` (`:621`) blocks everything but `'void'`; `tickEnvironment` (`:574`) early-returns before the void checks ever run, so neither `hurt(4,'void')` (y<−8) nor `die('void')` (y<−64) is reachable | `Player.js:574, :621` |
| 5 | `tickHunger` creative early-out → **no drain, but also no regen** | `Player.js:202` |
| 6 | `canSprint` **does not check `flying`** — Ctrl while flying sets `sprinting`, doubling `flightMove` speed (`:484`) and triggering the 1.10 FOV | `Player.js:531-537` |
| 7 | Flight toggle lives **inside `updateSprint`**, not a flight state machine, and consumes `Space` (also the jump key) | `Player.js:547-553` |
| 8 | **`flying` is not serialized** — lost across save/load while `gameMode` survives | `Player.js:682-699` |
| 9 | Insta-break **bypasses `breakBlock` entirely** → no drops, no XP, no exhaustion, no tool damage, **and no `block.break.*` / `block.extinguish` SFX**. Bedrock still immune (`hardness < 0`). Rate = 1 block / 4 ticks | `interaction.js:212-222` |
| 10 | `reach()` is 5.2 vs 4.5 for **blocks only** — entity attack stays at 3 m (`pickEntityTarget` `:135-149`) | `interaction.js:45` |
| 11 | **`debugOnly` and its `DEBUG_ONLY` set have zero consumers** — the field exists for exactly this feature and is unused | `items.js:35, :60, :70` |
| 12 | F4 lives in `main.js`, **not gated on game state** — toggles during LOADING or DEAD (guarded only by `game.player` truthiness) | `main.js:143-147` |
| 13 | `setPaletteVisible` is called from **two sites with the same predicate** that must stay in sync manually | `main.js:120-121` and `:147` |
| 14 | Middle-click pick-block **overwrites the slot outright**, no `give()` | `interaction.js:93-97` |
| 15 | `entityBlocksPlacement` **does not exclude the player** — your own body blocks placement of any collidable block into a cell you overlap | `interaction.js:505-509` vs `:144` |
| 16 | `tryPlace` bounds `y > 127` (`:519`) vs `tryPlaceSpecial` `y > 126` (`:573`) — different ceilings for the same world height | `interaction.js` |
| 17 | `'KeyQ'` is hardcoded rather than `KEYBINDS.drop`; `Player.js:540/547` hardcode `'KeyW'`/`'Space'` — **rebinding in `constants.js` silently breaks double-tap sprint, flight toggle, and drop** | `interaction.js:90` |

**Creative inventory**: `#debug-palette` (`menus.js:373-399`) is inline-styled (`:124-130`), a 7×48px grid, built lazily once (`paletteBuilt`, `:375`), filtered by `item.name.includes(filter)`, LMB gives `item.stack ?? 64` / RMB gives 1 (`:393`), guarded to `gameMode === 'debugCreative'` (`:392`).

---

## 11. Known broken / suspicious code found while mapping

Ordered by blast radius for the phases above.

1. **`CARVE_R = 7` and `TUNNEL_REACH = 115` are mutually inconsistent** — `caves.js:17, :20, :60-61, :79`. Enumeration covers 112 blocks; the reach test admits 115. For `ocx = cx - 8`, starts land in `[cx*16 − 128, cx*16 − 112)`, so any start with `sx ∈ (cx*16 − 115, cx*16 − 112)` passes the reach bound yet is **never enumerated** — while chunk `(cx+1, cz)` *does* enumerate it. Result: a **hard-edged cave truncation exactly on the chunk border**, not a shortened tunnel. Rare (needs a near-maximal ~109-step tunnel), but a genuine radius/bound mismatch. The comment at `caves.js:18-19` derives 115 correctly; `CARVE_R = 7` covers only 112. **E6/E10 copy this code.**

2. **`saveManager.saveChunkNow` resolves `game` from a DEV-only global** — `saveManager.js:94`: `const game = chunk?.gameRef ?? window.game;`. **`gameRef` is never assigned anywhere in `src/`** (verified: that line is the only occurrence); `Chunk` has no such field (`Chunk.js:26-34`). `window.game` is assigned **only under `import.meta.env?.DEV`** (`Game.js:83`). **In a production Vite build, any chunk that has entities fails to persist on the unload path**: `serializeChunk(chunk, undefined)` throws at `if (e === game.player || e.dead)` (`:60`), swallowed by the try/catch (`:102-103`) as `[save] chunk write failed`. The throw precedes `savedChunkKeys.add` and `chunk.modified = false`, and `unloadPass` deletes the chunk immediately after (`ChunkManager.js:228`), so it is never retried. Chunks with zero entities serialize fine.

3. **A second `disposeWorld()` throws — Save & Quit → Continue is broken in-session.** `Game.js:122-134` guards on `this.chunkManager` (`:123`) but dereferences `this.world.chunks` (`:125`), and never nulls `chunkManager`. After `onQuit` (`main.js:85-89`) sets `world = null` while leaving `chunkManager` set, the next `startWorld` → `disposeWorld()` (`Game.js:89`) → **`TypeError: Cannot read properties of null (reading 'chunks')`** → caught at `main.js:54-58` → back to TITLE. **No world can be started again without a page reload.** The first-ever `startWorld` is unaffected (`chunkManager` is `null` from the ctor, `Game.js:66`). Verified.

4. **Version mismatch discards meta but not chunks** — `saveManager.js:28-31`. `savedChunkKeys` is still populated from the old store at `:32`, so a new world on a rejected save version **hydrates stale chunk records** via `ChunkManager.js:142`. Any `SAVE_VERSION` bump (E7/E8, E9, E12 all need one) must also clear the chunk store.

5. **`world.dimension` is read but never assigned** — `music.js:129` is the only reference in the tree; `World`'s ctor (`World.js:14-29`) never sets it. The nether/end mood branches are permanently dead. Verified.

6. **Restoring a saved adult zombie has a 5% chance of turning it into a baby.** `Game.restoreEntity` calls `createMob(world, rec.type, …, {})` (`Game.js:725`); `Zombie`'s ctor rolls `(!opts.noBabyRoll && world.rng() < 0.05)` (`Zombie.js:21`) **before** `deserialize(rec)` runs, and `Mob.deserialize` has only an `if (rec.isBaby)` branch (`Mob.js:534`) — no else to undo it. **If the roll also fires on a saved baby, the hitbox is double-halved** to 0.15 × 0.4875, and `growUp()` restores only to 0.3.

7. **`Mob.onDeath`'s `noDrops` guard is unreachable.** `noDrops = true` is set only at `Mob.js:212` (`despawn`) and `Creeper.js:37` (`SwellGoal`), and **both set `dead = true` directly, never calling `die()`.** `onDeath` runs only from `LivingEntity.die` (`Entity.js:218`, the sole call site), so `if (this.noDrops) return;` (`Mob.js:263`) can never execute — and a detonating creeper or despawning mob emits **no `mob.*.death` at all**. The comment at `Mob.js:260-261` justifying the sound ordering describes a path that cannot be taken. Same for the void kill at `Mob.js:193`. **Directly relevant to E11.**

8. **The player is silently removed from `EntityManager.entities` on first death.** `tick`'s first loop skips the player (`:36`) and `updateRender` skips it (`:78`), but the **reap loop does not** (`:51-55`). `Player` has no `deathAnimTicks` → `0 < (undefined ?? 0)` is false → `remove(player)` runs while `state === DEAD` (entities still tick, `Game.js:195-198`). `Player.respawn` sets `dead = false` (`Player.js:676`) but never re-adds. `register(player)` (`:34`) repairs `chunk.entities`, so `getEntitiesInBox` self-heals; the lasting effect is that **`entities.count(filter)` no longer sees the player.**

9. **Saved `FallingBlock`s are dropped on load with a console warning.** `FallingBlock.serialize` emits `type: 'falling_block'` (`:54`); `saveManager`'s filter excludes only `player`/`arrow`/`thrown*` (`:62-63`), so the record is written; `restoreEntity` (`Game.js:724`) falls through to `createMob(world, 'falling_block', …)` → `'[mobs] unknown type'` → `null` (`index.js:19`). The comment at `FallingBlock.js:55` claims saveManager handles this; **it does not.**

10. **`Spider.forcedAggro` is never reset.** `Mob.onHurt` sets it on **every** mob for any attacker-bearing hit (`Mob.js:254`); nothing clears it. `Spider.updateTarget` (`:58`) only drops the target when `!forcedAggro` → **a spider hit once has its light gate disabled permanently.**

11. **Snowball/egg knockback is applied twice.** `ThrownProjectile.impact` (`:75`) calls `hurt(0, 'melee', {dirX, dirZ, attacker})` — which applies knockback inside `applyDamage` (`Entity.js:192-194`) — then line `:76` calls `applyKnockback?.(0.4, …)` again, **unguarded**, so it also knocks back through i-frames and against already-dead targets.

12. **`ThrownProjectile` hits the first candidate, not the nearest** — `:45` is `candidates[0]`, and `getEntitiesInBox` returns chunk-iteration order. The comment at `:34` says "nearest". `Arrow.tick` (`:61-65`) does a real nearest-scan.

13. **`Creeper`, `Skeleton`, `Spider`, `Enderman` silently ignore `opts`** — their ctors are `(world, x, y, z)` while `createMob` passes `opts` as the 5th arg (`index.js:20`). `spawnMobAt('creeper', x, y, z, {isBaby: true})` is a no-op for the baby flag (`persistent` still works — applied externally at `index.js:21`).

14. **`Mob.updateRender` writes tick state from render code** — `this.hurtTime = 5` every frame while dead (`Mob.js:469`) to pin the red tint.

15. **`raycast.js:25` is the one file that violates the bit-7 masking rule.** `world.getState(x, y, z) === 0` is a bare, unmasked "fluid source" test — exactly what `blocks.js:33-34` names as WRONG. Currently safe only because water (63) is not waterloggable. Separately, `fluidMode` does not stop at waterlogged cells even though they *are* water sources per §11.1 of the spec.

16. **`Particles.update()` takes no parameters** but `Game.js:266` calls `particles.update(alpha)`. All velocities/lives are **per-frame, not per-tick** → particle behavior is framerate-dependent. Also: `obtain(mesh)` (`:17`) and `this.pool` (`:12`) are **dead** despite the file header claiming pooling — `colored()` allocates a fresh material per particle (`:31`).

17. **`updateViewmodel`'s switch-anim decrement is alpha-dependent** — `if (vm.switchAnim > 0) vm.switchAnim -= alpha < 0.01 ? 1 : 0;` (`Game.js:410`). Render code decrementing only on frames landing within 0.5 ms of a tick boundary: at high FPS the 3-count drains erratically; at low FPS the `drop = 0.3` offset sticks.

18. **`collidesAny` disagrees with the real collision solver.** It clamps `y0` to `>= 0` (`collision.js:127`) and **ignores `blockAgainstUnloaded` entirely**, while `collideAxis` synthesizes a solid floor at `y < 0` (`:31`) and treats unloaded chunks as solid (`:33`). So `sneakEdgeClamp` and `isClearForHop` disagree with actual collision near y=0 and at chunk borders. Similarly `forEachOverlappedCell` clamps to `[0,127]` (`:86-94`) → **no fluid/climbable/fire is detected below y=0.**

19. **`ThemeMusic.stop(0.8)` silently ignores its argument** — `ui/menus.js:232` passes a number, but the signature destructures `{ fade = HANDOFF_FADE } = {}` (`themeMusic.js:~`); `Number(0.8).fade` is `undefined` → falls back to 1.0. No throw.

20. **Bucket geometry lies about its bucket.** `snow_layer` (`blocks.js:466`), `fence` (`:542`) and `bed` (`:570`) declare `bucket: 'opaque'` but route through `emitBox`, which emits into `builders.cutout` unconditionally (`ChunkMesher.js:455`) — their geometry lands in the cutout material (`alphaTest 0.5`, `DoubleSide`).

21. **`saveAll`'s `sync` option is dead** — destructured at `saveManager.js:107`, never referenced, no call site passes it. The `pagehide` handler (`main.js:185-187`) therefore issues an ordinary async IDB transaction during page teardown with no synchronous fallback.

22. **`clearFireOrigins()` is exported (`fire.js:31`) with zero call sites.** `disposeWorld` does not call it; `forgetFireInChunk` only runs on chunk unload (`Game.js:739`). **Origins from a disposed world survive into the next `startWorld` and count against `MAX_ACTIVE (512)`.**

23. **Heightmap-predicate agreement is load-bearing and unenforced.** `HM_SKIP` (`features.js:248-256`) and `terminatesSky` (`LightEngine.js:55-58`) agree today only by coincidence of the `CROSS` `opacity: 0` default, with `snow_layer`/`cactus` special-cased. **Adding a gen-emitted block with `opacity: 0` that isn't snow/cactus, without adding it to `HM_SKIP`, silently desyncs generated vs. reloaded chunks.**

24. **`Mob.serialize` writes a union of foreign fields** — `sheared, woolTint, eggTimer, swell, aggro` (`Mob.js:526`) are written for every mob type. `Creeper.swell` round-trips but `swellDir` and `fuseVoice` do not.

25. **Two different `disposeWorld` leaks**: `crackMesh` is added to `this.scene` (`Game.js:366`) and never removed; `updateCrack` allocates a throwaway `BoxGeometry` per stage change and never disposes it (`Game.js:373`). `Sky.dispose()` (`Sky.js:288`) removes objects from parents but **disposes no geometries, materials, or textures**.

26. **Dead code inventory** (relevant when grepping for extension points): `blockIndex` imported unused (`World.js:3`); `waterFaceVisible` defined and never called (`ChunkMesher.js:207`); `needsSupport` — 9 blocks set it, **zero readers** (`blocks.js:281`); `infiniteBurn` — never set true (`blocks.js:292`); `debugOnly`/`DEBUG_ONLY` — zero consumers (`items.js:35, :60`); `itemById` and `NAME_TO_ID` exported, never imported (`items.js:8, :187`); `noise.js`'s `clamp01`/`lerp`/`smoothstep`/`composeColumn` — no importers; `ctx.tempAt` (`noise.js:216`) and `ctx.cheeseAt` (`:257`) — zero external callers; `createGenerator`'s returned `heightAt`/`biomeAt` (`terrain.js:103-104`) — unused; `drone` primitive — zero events (`primitives.js:396`); `PRIMS` — no importers (`primitives.js:552`); `interaction.js:452` — `if (held.name === 'shears' && hit) { }`, empty block; `interaction.js:127` — `this.crackPos` never assigned anywhere → the OR branch is permanently dead; `interaction.js:32, :121` — `prevMouseRight` written every tick, never read; `Player.js:72` — `_moveDist` never written or read; `Player.js:374` — `(this.sprinting || (this.flying && this.sprinting))`, second disjunct subsumed; `Entity.js:21` — `let SCRATCH = new AABB()` unused; `Mob.js:45` — `stallTicks` initialized, never read again; `Sky.js:266` — `const yaw = Math.atan2(camera.position.x - (camX + 1), 0)` computed, unused, and constant; `Game.js:75` — `debug.remeshCount` never written or read, `debug.lastRemeshes` written every frame (`:260`) never read, `debug.audioMs` written (`:263`) but the overlay reads `g.audio.debug.budgetMs` directly (`debug.js:48`).

27. **Registry predicates depend on id contiguity** and will silently mis-classify if ids are inserted between them: `leafDecayTick`'s `id >= B.OAK_LEAVES && id <= B.SPRUCE_LEAVES` (11–13) and `id >= B.OAK_LOG && id <= B.SPRUCE_LOG` (8–10) at `blocks.js:98-99`; `farmlandTick`'s `above >= B.WHEAT_CROP && above <= B.POTATO_CROP` (56–58) at `:180`. `ui/containers.js:673` hard-codes 35/36/37 as literals rather than using `B`.

28. **`validCactus` (`blocks.js:143`)** does `BLOCKS[world.getBlock(...)].collidable` with **no `?.`** — it assumes `getBlock` always returns a valid id, unlike every other site in the file.

29. **Altitude-cooling constant diverges**: `0.008` on column height (`biomes.js:63`, `features.js:209`) vs `0.00125` on entity `y` (`DayNight.js:158`).

30. **`WORLD_BORDER`'s documented "generator refusal" does not exist** — `constants.js:13` comments it; the sole usage is a position clamp in `Entity.js:76-79`. Nothing in `gen/` or `ChunkManager` consults it; chunk requests past the border generate normally.

31. **`terrain.js:13-14`'s comment is wrong**: "saves store the int; both routes yield the same worldSeed". `saveManager.js:83` stores `seed: game.world.seedString` (a **string**), and `main.js:71` passes `meta.seed` straight back. The number branch at `terrain.js:16` is never exercised by the save path.

32. **`slowTicks` never resets on the warn branch** (`Game.js:229-232`) — once it crosses 2, every subsequent slow tick warns.

33. **`ChunkManager.dispose()` (`:43-46`) only terminates workers.** It does not clear `remeshQueue`, `pending`, `requestList`, `retries`, or `worldSpawn`. `retries` is never cleared on success (`:56-69`) and grows for the session.

34. **`countByState()`'s `failed` is the else branch** (`ChunkManager.js:339-348`) — it counts any state that isn't REQUESTED/GENERATED/LIT/MESHED, not only `FAILED`.

35. **`fluids.js:79` passes a dead option**: `world.popBlock(x, y, z, { silent: false })`, but `popBlock` destructures only `{ toolClass = null, toolTier = null } = {}` (`World.js:283`) — **`silent` is silently ignored.** Also, `cur` is assigned at `fluids.js:149, :189, :208` and never read.

36. **`Sheep.buildModel` defers visibility via `setTimeout(…, 0)`** (`passive.js:164`) because `this.parts` is assigned by `Mob.buildMesh` only **after** `buildModel()` returns (`Mob.js:445-446`).

37. **`Game.js:583-584` (explosion drops) calls `blk.drops` but never `blk.xpForMine`** — ore XP is mining-only. It passes `toolClass: blk.tool ?? 'pickaxe', toolTier: 3`, so explosion drops always pass `harvestOK`.

38. **`trySleep` sets `p.spawnPoint` unconditionally on click** (`Game.js:765`), before any of the night/monster checks. Hostile check box is asymmetric: `new AABB(x-8, y-5, z-8, x+9, y+6, z+9)` (`:771`).

39. **`Player.respawn` resets `yaw`/`pitch` but not `prevYaw`/`prevPitch`** (`Player.js:659-678`) → the first post-respawn frame interpolates from the old angle.

40. **`per-layer memo flush is a hard clear, not eviction`** (`noise.js:142, :157`) — at >200000 entries the entire memo is dropped. Correctness holds (values are pure); it is a latency cliff, paid independently by each of the 2 workers.