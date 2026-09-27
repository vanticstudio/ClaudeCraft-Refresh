// Loop voices: rain, wind, fluid clusters, fire proximity (16 §3.5, §5).
// v1.3.1 world-bed expansion: day chorus, night bed, cave/dimension beds and a
// shore wash — still driven from audio.tick() (AMENDS 01 §3 tick step 10), never
// from render, and still 100% procedural (every voice below is synthesized).
import { BLOCKS, B } from '../registry/blocks.js';
import { STATE } from '../constants.js';
import { BIOMES } from '../world/gen/biomes.js';
import { EVENTS, P } from './events.js';
import { drone, noiseBurst, thud, blip, whoosh } from './primitives.js';

// ============================================================================
// B12 — "The Hollow" ambience cue (19-BUILDOUT §B12: "low drone via the
// existing ambience.js table"). ADDITIVE ENTRY, defined here because events.js
// is outside this phase's file list — the entry shape is copied verbatim from
// the §3.5 loop rows in events.js (same bus/cap/priority/loop columns) and
// should be relocated there (and gain a mob.sentinel.* voice row) when the
// orchestrator sweeps. The recipe starts SILENT under the exact contract of
// weather.rain.loop/ambient.wind.loop: ambience.js drives `droneGain` from the
// gate on the same tick, so there is never a loud first half-second.
// §2.9 drone: two detuned saws an octave apart under a sine, LP'd to 260 Hz,
// with a slow 0.11 Hz cutoff wobble so the dark reads as breathing, not static.
// ============================================================================
EVENTS['ambient.hollow.loop'] = {
  bus: 'ambient', maxDist: 24, cap: 1, capKey: 'hollowLoop', priority: P.FAR,
  replicate: false, loop: true, jitter: 0,
  recipe: (v, t, p, g) => drone(v, t, {
    freqs: [55, 55.7, 110], waves: ['sawtooth', 'sawtooth', 'sine'],
    gain: 0, lpFreq: 260, attack: 2.5,
    lfo: { rate: 0.11, depth: 0.35, target: 'lp' }, loop: true,
  }),
};

// ============================================================================
// v1.3.1 — WORLD BED EXPANSION (Agent C, audio overhaul). ADDITIVE rows, same
// shape and placement rule as B12's hollow loop above: defined here because
// events.js is outside this phase's file list, relocatable by the orchestrator
// sweep. Gating reuses ONLY the mechanics already in this file — canSeeSky,
// biomeAt, activeDim, dayNight.rainLevel, world.skyDarken (the same night test
// music.js §4.1 and the mob spawners use) — and the sparse one-shots are fired
// from Ambience's own tick deadlines, so no new engine hooks exist.
//
// GAIN CEILINGS (final audible level per entry, driver + engine jitter incl.;
// everything at or under rain's 0.6 / wind's 0.15 / hollow's 0.16 so the bed
// layers without any single voice dominating):
//   ambient.bird.chirp           0.16 peak/note, refDist 4, 1 voice / 6-14 s
//   ambient.cricket.chirp        0.10 peak/note, refDist 3, 1 voice / 3-5 s
//   ambient.owl.hoot             0.26 peak, refDist 6, spawned 10-16 blocks off
//   ambient.cave.drip            0.14 plip + 0.08 puddle + 0.05 echo, refDist 3
//   ambient.desert.gust          0.09 peak, refDist 6, 1 gust / 4-9 s
//   ambient.nether.breath        0.12 peak, refDist 10, 1 breath / 10-25 s
//   ambient.desert.whistle.loop  ≤ 0.045 (tick-driven gust swell)
//   ambient.cave.air.loop        ≤ 0.06
//   ambient.nether.rumble.loop   ≤ 0.10 drone layer + 0.05 brown-noise layer
//   ambient.end.void.loop        ≤ 0.05 (slow reversed-pad swell)
//   ambient.wave.loop            ≤ 0.07 (ducked toward 0 while rainLevel > 0)
//
// All five loop beds obey the exact weather.rain.loop/ambient.wind.loop
// contract: the recipe starts at gain 0 and Ambience drives the primitive's
// mod param (whooshGain/burstGain/droneGain) from the same tick, so a gate
// flipping on never blasts a loud first half-second, and every loop is a real
// oscillator/graph voice started ONCE per activation — one-shots are scheduled
// off the tick, never per-frame, and share one module-scope position scratch.
// ============================================================================

const { OCEAN, BEACH, RIVER, DESERT, PLAINS, FOREST, BIRCH_FOREST, SAVANNA,
        TAIGA, MOUNTAINS } = BIOMES;

// Day-chorus roster (SNOWY_TUNDRA stays silent — winter hush; OCEAN/BEACH/RIVER
// belong to the wave wash; DESERT owns its whistle bed).
const BIRD_BIOMES = new Set([PLAINS, FOREST, BIRCH_FOREST, SAVANNA, TAIGA, MOUNTAINS]);
const CRICKET_BIOMES = new Set([PLAINS, FOREST, BIRCH_FOREST, DESERT, SAVANNA, TAIGA, MOUNTAINS]);
const OWL_BIOMES = new Set([FOREST, BIRCH_FOREST, TAIGA, PLAINS]);
const WATER_BIOMES = new Set([OCEAN, BEACH, RIVER]);

// Species-pitch per biome (pitchMult onto the shared chirp recipe — same trick
// §3.5's note-block and player.fall.big use to ride a param through §5.1).
const BIRD_SPECIES = {
  [PLAINS]: 1.0,          // meadowlark register
  [FOREST]: 0.88,         // thrush-ish, lower
  [BIRCH_FOREST]: 1.14,   // small bright warbler
  [SAVANNA]: 0.72,        // low ground roller
  [TAIGA]: 0.95,          // crossbill
  [MOUNTAINS]: 1.28,      // thin high canyon whistle
};

// Dry heat shimmer: one narrow band (~2.1 kHz, Q 7) of white noise that never
// swells past 0.045 — the gusts carry the drama, the bed just breathes.
EVENTS['ambient.desert.whistle.loop'] = {
  bus: 'ambient', maxDist: 24, cap: 1, capKey: 'desertWhistle', priority: P.FAR,
  replicate: false, loop: true, jitter: 0,
  recipe: (v, t, p, g) => whoosh(v, t, {
    src: 'white', f0: 2100, Q: 7, dur: 1, gain: 0, pitch: p, loop: true,
  }),
};

// Soft surf: pink noise through a broad 640 Hz band, gain driven from the tick
// as a two-sine swell (the long/short period mix keeps the 2 s looped buffer
// from ever repeating audibly).
EVENTS['ambient.wave.loop'] = {
  bus: 'ambient', maxDist: 24, cap: 1, capKey: 'waveWash', priority: P.FAR,
  replicate: false, loop: true, jitter: 0,
  recipe: (v, t, p, g) => noiseBurst(v, t, {
    src: 'pink', filter: 'bp', freq: 640, Q: 0.5, dur: 1, gain: 0, pitch: p,
    loop: true, attack: 1.2,
  }),
};

// Cave air: a near-subsonic twin-sine octave, LP'd to 120 Hz with a 0.07 Hz
// wobble — air pressure rather than a tone. Silent start, 0.06 ceiling.
EVENTS['ambient.cave.air.loop'] = {
  bus: 'ambient', maxDist: 24, cap: 1, capKey: 'caveAir', priority: P.FAR,
  replicate: false, loop: true, jitter: 0,
  recipe: (v, t, p, g) => drone(v, t, {
    freqs: [40, 40.3, 80.2], waves: ['sine', 'sine', 'sine'],
    gain: 0, lpFreq: 120, attack: 3,
    lfo: { rate: 0.07, depth: 0.3, target: 'lp' }, loop: true,
  }),
};

// Nether bed: detuned 33 Hz saw pair (LP 150) over a brown-noise floor (LP 90).
// Both layers start silent; the tick drives droneGain and burstGain separately.
EVENTS['ambient.nether.rumble.loop'] = {
  bus: 'ambient', maxDist: 24, cap: 1, capKey: 'netherRumble', priority: P.FAR,
  replicate: false, loop: true, jitter: 0,
  recipe: (v, t, p, g) => {
    drone(v, t, {
      freqs: [33, 33.4, 66.2], waves: ['sawtooth', 'sawtooth', 'sine'],
      gain: 0, lpFreq: 150, attack: 3,
      lfo: { rate: 0.09, depth: 0.4, target: 'lp' }, loop: true,
    });
    return noiseBurst(v, t, {
      src: 'brown', filter: 'lp', freq: 90, Q: 0.7, dur: 1, gain: 0,
      pitch: p, loop: true, attack: 2,
    });
  },
};

// End bed: airy reversed-pad stand-in — four near-unison sines (220/221.8 Hz +
// major third), LP 2400, 5 s attack, and the tick's slow asymmetric swell on
// droneGain plays the "reverse" (long swell, quicker release) a live graph
// cannot literally flip.
EVENTS['ambient.end.void.loop'] = {
  bus: 'ambient', maxDist: 24, cap: 1, capKey: 'endVoid', priority: P.FAR,
  replicate: false, loop: true, jitter: 0,
  recipe: (v, t, p, g) => drone(v, t, {
    freqs: [220, 221.8, 329.6, 331.2],
    waves: ['sine', 'sine', 'sine', 'sine'],
    gain: 0, lpFreq: 2400, attack: 5,
    lfo: { rate: 0.05, depth: 0.25, target: 'lp' }, loop: true,
  }),
};

// One-shots (fired from Ambience's tick deadlines, 3-40 s apart by family).
EVENTS['ambient.bird.chirp'] = {
  bus: 'ambient', refDist: 4, maxDist: 14, cap: 1, capKey: 'birdChirp', priority: P.FAR,
  replicate: false,
  // two-note species call; biome species pitch arrives as `p`, engine ±15%
  // jitter (default on) varies every rendition on top of it
  recipe: (v, t, p, g) => {
    blip(v, t, { wave: 'triangle', freq: 1750, f1: 2350, dur: 0.06, gain: 0.16 * g, pitch: p });
    return blip(v, t + 0.1 + Math.random() * 0.08, {
      wave: 'triangle', freq: 2150, f1: 1520, dur: 0.09, gain: 0.14 * g, pitch: p,
    });
  },
};
EVENTS['ambient.cricket.chirp'] = {
  bus: 'ambient', refDist: 3, maxDist: 10, cap: 1, capKey: 'cricketChirp', priority: P.FAR,
  replicate: false,
  // rapid triplet — the stridulation pulse
  recipe: (v, t, p, g) => {
    let end = t;
    for (let i = 0; i < 3; i++) {
      end = blip(v, t + i * 0.042, { wave: 'square', freq: 4200, dur: 0.018, gain: 0.1 * g, pitch: p });
    }
    return end;
  },
};
EVENTS['ambient.owl.hoot'] = {
  bus: 'ambient', refDist: 6, maxDist: 22, cap: 1, capKey: 'owlHoot', priority: P.FAR,
  replicate: false,
  // low two-note hoot, spawned 10-16 blocks off so the panner distances it
  recipe: (v, t, p, g) => {
    blip(v, t, { wave: 'triangle', freq: 320, f1: 262, dur: 0.3, gain: 0.26 * g, pitch: p });
    return blip(v, t + 0.44, { wave: 'triangle', freq: 300, f1: 240, dur: 0.42, gain: 0.22 * g, pitch: p });
  },
};
EVENTS['ambient.cave.drip'] = {
  bus: 'ambient', refDist: 3, maxDist: 12, cap: 2, capKey: 'caveDrip', priority: P.FAR,
  replicate: false,
  // plip + puddle thud + one late quieter copy = the "echoing" read
  recipe: (v, t, p, g) => {
    blip(v, t, { wave: 'sine', freq: 980, f1: 420, dur: 0.06, gain: 0.14 * g, pitch: p });
    thud(v, t + 0.015, { f0: 150, f1: 58, dur: 0.09, gain: 0.08 * g, pitch: p });
    return blip(v, t + 0.3 + Math.random() * 0.1, {
      wave: 'sine', freq: 760, f1: 360, dur: 0.08, gain: 0.05 * g, pitch: p,
    });
  },
};
EVENTS['ambient.desert.gust'] = {
  bus: 'ambient', refDist: 6, maxDist: 18, cap: 1, capKey: 'desertGust', priority: P.FAR,
  replicate: false,
  // a whoosh that either builds or dies — random direction keeps gusts organic
  recipe: (v, t, p, g) => {
    const rising = Math.random() < 0.5;
    return whoosh(v, t, {
      src: 'white', f0: rising ? 1200 : 2600, f1: rising ? 2800 : 900,
      dur: 1.4 + Math.random() * 1.2, Q: 2, gain: 0.09 * g, pitch: p,
    });
  },
};
EVENTS['ambient.nether.breath'] = {
  bus: 'ambient', refDist: 10, maxDist: 26, cap: 1, capKey: 'netherBreath', priority: P.FAR,
  replicate: false,
  // distant furnace breath: falling airy band over a brown body, sub-thud late
  recipe: (v, t, p, g) => {
    whoosh(v, t, { src: 'white', f0: 340, f1: 140, dur: 2.4, Q: 1.2, gain: 0.12 * g, pitch: p });
    noiseBurst(v, t + 0.1, { src: 'brown', filter: 'lp', freq: 160, Q: 0.7, dur: 2.0, gain: 0.05 * g, pitch: p });
    return thud(v, t + 1.2, { f0: 68, f1: 44, dur: 0.5, gain: 0.07 * g, pitch: p });
  },
};

const SAMPLE_CELLS = 48;        // §3.5: 48 getBlock/s — noise in the budget
const SAMPLE_RADIUS = 12;
const BUCKET = 4;               // 4x4x4 grid cells
const MAX_CLUSTERS = 2;         // per fluid type
const FIRE_SCAN = 4;            // half-extent of the fire box scan (see sampleFluids)
const MAX_FIRE = 3;

export class Ambience {
  constructor(engine) {
    this.engine = engine;
    this.rain = null;
    this.wind = null;
    this.hollow = null;         // B12 — the Hollow's low drone (single loop, like wind)
    // v1.3.1 world-bed loops (each single-handle, same discipline as wind/hollow)
    this.desertWhistle = null;
    this.caveAir = null;
    this.netherRumble = null;
    this.endVoid = null;
    this.waveWash = null;
    // v1.3.1 one-shot deadlines, in ticks (0 = disarmed — gate is off)
    this.nextBirdAt = 0;
    this.nextCricketAt = 0;
    this.nextOwlAt = 0;
    this.nextDripAt = 0;
    this.nextGustAt = 0;
    this.nextBreathAt = 0;
    // v1.3.1 per-tick gate snapshot, refreshed in tick() (fields, not objects)
    this.dim = 0;
    this.sky = false;
    this.biome = -1;
    this.rainLevel = 0;
    this.night = false;
    this.clusters = { water: [], lava: [] };   // [{ x,y,z, handle }]
    this.fires = [];
  }

  get game() { return this.engine.game; }

  tick(tickCount) {
    const g = this.game;
    if (!this.engine.ready || this.engine.ctx.state !== 'running') return;
    if (!g || !g.world || !g.player || g.state !== STATE.PLAYING) {
      if (g?.state !== STATE.PLAYING_UI) this.silence();
      return;
    }
    this.updateRain(g);
    this.updateWind(g);
    this.updateHollow(g);       // B12
    // v1.3.1 world bed — one shared gate snapshot (heightmap/biome-LRU reads,
    // no allocation), then the beds read fields instead of re-querying the world
    const p = g.player.pos;
    this.dim = g.world.activeDim;                    // 0 overworld / 1 nether / 2 end
    this.sky = g.world.canSeeSky(p.x, p.y, p.z);
    this.biome = g.world.biomeAt(Math.floor(p.x), Math.floor(p.z));
    this.rainLevel = g.dayNight?.rainLevel ?? 0;
    this.night = (g.world.skyDarken ?? 0) >= 4;      // §4.1's night test
    this.updateFauna(g, tickCount);
    this.updateDesert(g, tickCount);
    this.updateCave(g, tickCount);
    this.updateNether(g, tickCount);
    this.updateEnd(g);
    this.updateWaterEdge(g);
    if (tickCount % 20 === 0) this.sampleFluids(g);   // §3.5: once per second
  }

  // §3.5: gain = 0.6 x rainLevel; LP 1.2 kHz when the player is under cover
  updateRain(g) {
    const level = g.dayNight?.rainLevel ?? 0;
    if (level <= 0.001) {
      if (this.rain) { this.rain.stop(1.0); this.rain = null; }
      return;
    }
    if (!this.rain) {
      this.rain = this.engine.startLoop('weather.rain.loop', null);
      if (!this.rain) return;
    }
    const p = g.player.pos;
    const covered = !g.world.canSeeSky(p.x, p.y, p.z);
    this.rain.setParam('loopGain', 0.6 * level, 0.3);
    this.rain.setParam('coverLp', covered ? 1200 : 20000, 0.3);   // duller indoors
  }

  // §3.5: gain = 0.12 x clamp((y - 88)/24, 0, 1) when canSeeSky.
  // v1.3.1 night bed: +25% after dark (ceiling 0.15 — still a quarter of rain's
  // 0.6); unchanged underground, where it has always been 0.
  updateWind(g) {
    const p = g.player.pos;
    const alt = Math.min(1, Math.max(0, (p.y - 88) / 24));
    const sky = g.world.canSeeSky(p.x, p.y, p.z);
    const night = (g.world.skyDarken ?? 0) >= 4;
    const gain = sky ? 0.12 * alt * (night ? 1.25 : 1) : 0;
    if (gain <= 0.001) {
      if (this.wind) { this.wind.stop(1.5); this.wind = null; }
      return;
    }
    if (!this.wind) {
      this.wind = this.engine.startLoop('ambient.wind.loop', null);
      if (!this.wind) return;
    }
    this.wind.setParam('loopGain', gain, 0.5);
  }

  // B12 — the Hollow's low drone. Gate mirrors updateWind's shape (single
  // non-positional loop, param-driven gain): active only when the player's
  // column IS the Hollow biome AND the sky is sealed above them — the biome
  // describes the column's deep caves (02 §6.1 storage is per column), so the
  // canSeeSky test keeps the drone underground where the biome actually plays.
  updateHollow(g) {
    const p = g.player.pos;
    const biome = g.world.biomeAt(Math.floor(p.x), Math.floor(p.z));
    const active = biome === BIOMES.HOLLOW && !g.world.canSeeSky(p.x, p.y, p.z);
    if (!active) {
      if (this.hollow) { this.hollow.stop(1.5); this.hollow = null; }
      return;
    }
    if (!this.hollow) {
      this.hollow = this.engine.startLoop('ambient.hollow.loop', null);
      if (!this.hollow) return;
    }
    this.hollow.setParam('droneGain', 0.16, 1.0);
  }

  // ==========================================================================
  // v1.3.1 world bed updaters. Every gate reads the tick()'s snapshot fields
  // (dim/sky/biome/rainLevel/night); every loop follows the updateWind/updateHollow
  // single-handle pattern (start once, drive a param, stop with a fade on gate
  // off — never two live voices for one bed); every one-shot goes through due().
  // ==========================================================================

  // Sparse one-shot scheduler. `0` means DISARMED (gate is off): the first
  // active tick arms a deadline min..min+span ticks out, so walking into a
  // biome never chirps on frame one. Math.random(), never world.rng — the
  // seeded stream belongs to the simulation (same rule as sampleFluids).
  due(key, tickCount, min, span) {
    if (this[key] === 0) { this[key] = tickCount + min + ((Math.random() * span) | 0); return false; }
    if (tickCount < this[key]) return false;
    this[key] = tickCount + min + ((Math.random() * span) | 0);
    return true;
  }

  // DAY CHORUS / NIGHT BED, above ground. Day: per-biome bird chirps (6-14 s,
  // species pitch from BIRD_SPECIES) only while rainLevel < 0.15 — birds fall
  // silent in rain. Night: cricket triplets every 3-5 s, distant owl every
  // 20-40 s in the woodland biomes. Snowy tundra stays hush; shore/water
  // columns belong to the wave wash.
  updateFauna(g, tickCount) {
    if (this.dim !== 0 || !this.sky) {
      this.nextBirdAt = this.nextCricketAt = this.nextOwlAt = 0;
      return;
    }
    if (!this.night) {
      if (this.rainLevel < 0.15 && BIRD_BIOMES.has(this.biome)
          && this.due('nextBirdAt', tickCount, 120, 160)) {
        this.engine.emitSound('ambient.bird.chirp',
          around(g.player.pos, 4, 9, 0, 4), BIRD_SPECIES[this.biome] || 1, 1);
      }
    } else {
      if (this.rainLevel < 0.15 && CRICKET_BIOMES.has(this.biome)
          && this.due('nextCricketAt', tickCount, 60, 40)) {
        this.engine.emitSound('ambient.cricket.chirp', around(g.player.pos, 2, 5, 0, 1), 1, 1);
      }
      if (this.rainLevel < 0.15 && OWL_BIOMES.has(this.biome)
          && this.due('nextOwlAt', tickCount, 400, 400)) {
        this.engine.emitSound('ambient.owl.hoot', around(g.player.pos, 10, 16, 2, 8), 1, 1);
      }
    }
  }

  // Desert day bed: a narrow dry whistle drone (breathing swell + cutoff drift,
  // both tick-driven) plus a gust one-shot every 4-9 s. Night hands the desert
  // over to the cricket bed; rain (rare) kills it with the rest of the chorus.
  updateDesert(g, tickCount) {
    const active = this.dim === 0 && this.sky && !this.night
      && this.biome === DESERT && this.rainLevel < 0.15;
    if (!active) {
      if (this.desertWhistle) { this.desertWhistle.stop(1.5); this.desertWhistle = null; }
      this.nextGustAt = 0;
      return;
    }
    if (!this.desertWhistle) {
      this.desertWhistle = this.engine.startLoop('ambient.desert.whistle.loop', null);
      if (!this.desertWhistle) return;
    }
    const now = this.engine.ctx.currentTime;
    const swell = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(now * 0.31));
    this.desertWhistle.setParam('whooshGain', 0.045 * swell, 1.2);
    this.desertWhistle.setParam('whooshFreq', 2100 + 420 * Math.sin(now * 0.13), 2.0);
    if (this.due('nextGustAt', tickCount, 80, 100)) {
      this.engine.emitSound('ambient.desert.gust', around(g.player.pos, 6, 14, -2, 6), 1, 1);
    }
  }

  // UNDERGROUND (overworld only — the nether/end own their whole soundscape
  // below): cave-air drone ≤ 0.06, drip one-shot every 8-20 s pitched by depth
  // (deeper = duller). Deliberately NOT excluded in Hollow columns: the drips
  // layer UNDER B12's drone there, as the bed expansion requires.
  updateCave(g, tickCount) {
    const active = this.dim === 0 && !this.sky;
    if (!active) {
      if (this.caveAir) { this.caveAir.stop(2.0); this.caveAir = null; }
      this.nextDripAt = 0;
      return;
    }
    if (!this.caveAir) {
      this.caveAir = this.engine.startLoop('ambient.cave.air.loop', null);
      if (!this.caveAir) return;
    }
    this.caveAir.setParam('droneGain', 0.06, 1.5);
    if (this.due('nextDripAt', tickCount, 160, 240)) {
      const p = g.player.pos;
      const depth = Math.max(0, 64 - p.y);
      const pitch = Math.max(0.62, Math.min(1.05, 1.05 - depth * 0.012));
      this.engine.emitSound('ambient.cave.drip', around(p, 2, 7, -2, 5), pitch, 1);
    }
  }

  // NETHER: deep rumble bed (0.10 drone + 0.05 brown floor, both slow-breathing)
  // plus a distant furnace breath every 10-25 s.
  updateNether(g, tickCount) {
    if (this.dim !== 1) {
      if (this.netherRumble) { this.netherRumble.stop(1.5); this.netherRumble = null; }
      this.nextBreathAt = 0;
      return;
    }
    if (!this.netherRumble) {
      this.netherRumble = this.engine.startLoop('ambient.nether.rumble.loop', null);
      if (!this.netherRumble) return;
    }
    const now = this.engine.ctx.currentTime;
    this.netherRumble.setParam('droneGain', 0.10 * (0.75 + 0.25 * Math.sin(now * 0.19)), 1.5);
    this.netherRumble.setParam('burstGain', 0.05 * (0.7 + 0.3 * Math.sin(now * 0.11 + 1.7)), 2.0);
    if (this.due('nextBreathAt', tickCount, 200, 300)) {
      this.engine.emitSound('ambient.nether.breath', around(g.player.pos, 10, 18, -4, 4), 1, 1);
    }
  }

// THE END: airy reversed-pad drone, ≤ 0.05, swelled slowly (the slow 5 s
// attack plus the tick's breathing swell reads as the pad "reversing" in).
  updateEnd(g) {
    if (this.dim !== 2) {
      if (this.endVoid) { this.endVoid.stop(2.0); this.endVoid = null; }
      return;
    }
    if (!this.endVoid) {
      this.endVoid = this.engine.startLoop('ambient.end.void.loop', null);
      if (!this.endVoid) return;
    }
    const now = this.engine.ctx.currentTime;
    const breathe = 0.5 + 0.5 * Math.sin(now * 0.11);
    this.endVoid.setParam('droneGain', 0.05 * (0.35 + 0.65 * breathe), 2.5);
  }

  // OCEAN/BEACH/RIVER columns in the open air: soft surf wash, gain swelling on
  // a long+short sine pair, ducked toward 0 as rainLevel rises (rain owns the
  // soundscape then).
  updateWaterEdge(g) {
    const active = this.dim === 0 && this.sky && WATER_BIOMES.has(this.biome);
    if (!active) {
      if (this.waveWash) { this.waveWash.stop(1.5); this.waveWash = null; }
      return;
    }
    if (!this.waveWash) {
      this.waveWash = this.engine.startLoop('ambient.wave.loop', null);
      if (!this.waveWash) return;
    }
    const now = this.engine.ctx.currentTime;
    const swell = Math.min(1, Math.max(0,
      0.72 + 0.28 * Math.sin(now * 0.92) + 0.08 * Math.sin(now * 0.23)));
    const duck = 1 - Math.min(1, this.rainLevel * 1.4);
    this.waveWash.setParam('burstGain', 0.07 * duck * swell, 1.0);
  }

  // §3.5 fluid cluster loops — positional ambience without scanning the world.
  // Math.random() here, never world.rng: that stream is seeded and shared with
  // weather/worldgen, and sampling from it would desync the simulation.
  sampleFluids(g) {
    const world = g.world, p = g.player.pos;
    const hits = { water: new Map(), lava: new Map() };
    const fires = [];

    for (let i = 0; i < SAMPLE_CELLS; i++) {
      const x = Math.floor(p.x + (Math.random() * 2 - 1) * SAMPLE_RADIUS);
      const y = Math.floor(p.y + (Math.random() * 2 - 1) * SAMPLE_RADIUS);
      const z = Math.floor(p.z + (Math.random() * 2 - 1) * SAMPLE_RADIUS);
      if (y < 0 || y > 127) continue;
      const id = world.getBlock(x, y, z);
      const blk = BLOCKS[id];
      if (!blk) continue;
      if (blk.fluid && world.getState(x, y, z) === 0) {     // source cells only
        const key = `${Math.floor(x / BUCKET)},${Math.floor(y / BUCKET)},${Math.floor(z / BUCKET)}`;
        const m = hits[blk.fluid];
        if (!m) continue;
        const b = m.get(key) || { n: 0, x: 0, y: 0, z: 0 };
        b.n++; b.x += x + 0.5; b.y += y + 0.5; b.z += z + 0.5;
        m.set(key, b);
      }
    }

    // Fire proximity (§3.5 ambient.fire.loop, "fire blocks / burning furnace
    // within 8"). Deliberately NOT the random pass the fluids use: §3.5's
    // sampling rule is written for fluids, which come in hundred-cell bodies,
    // while a fire is a single cell — 24 random draws out of a ~16^3 box find it
    // 0.6% of the time, and reconcile() treats every pass as ground truth, so a
    // lucky hit is torn down a second later. A deterministic box scan finds it
    // every pass: 729 getBlock/s against §6's budget, next to the fluid pass's
    // 48/s and still noise. DEVIATION: half-extent 4, so a fire 5-8 blocks away
    // is missed where §3.5 says "within 8".
    const cx = Math.floor(p.x), cy = Math.floor(p.y), cz = Math.floor(p.z);
    for (let dy = -FIRE_SCAN; dy <= FIRE_SCAN; dy++) {
      const y = cy + dy;
      if (y < 0 || y > 127) continue;
      for (let dz = -FIRE_SCAN; dz <= FIRE_SCAN; dz++) {
        for (let dx = -FIRE_SCAN; dx <= FIRE_SCAN; dx++) {
          const id = world.getBlock(cx + dx, y, cz + dz);
          if (id === B.FIRE || id === B.FURNACE_LIT) {
            fires.push({ x: cx + dx + 0.5, y: y + 0.5, z: cz + dz + 0.5 });
          }
        }
      }
    }

    for (const kind of ['water', 'lava']) {
      const centroids = [...hits[kind].values()]
        .map(b => ({ x: b.x / b.n, y: b.y / b.n, z: b.z / b.n }))
        .map(c => ({ ...c, d: Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_CLUSTERS);
      this.reconcile(this.clusters[kind], centroids, `ambient.${kind}.loop`);
    }
    this.reconcile(this.fires, dedupe(fires, p).slice(0, MAX_FIRE), 'ambient.fire.loop');
  }

  // Keep <= N loop voices alive, re-positioning survivors and fading the rest.
  reconcile(live, want, eventId) {
    for (let i = live.length - 1; i >= 0; i--) {
      if (i >= want.length || !live[i].handle?.alive) {
        live[i].handle?.stop(0.5);                 // §3.5 0.5 s fade on vanish
        live.splice(i, 1);
      }
    }
    for (let i = 0; i < want.length; i++) {
      const c = want[i];
      if (live[i]) {
        live[i].x = c.x; live[i].y = c.y; live[i].z = c.z;
        live[i].handle.setPosition(c.x, c.y, c.z);     // re-position each pass
      } else {
        const handle = this.engine.startLoop(eventId, { x: c.x, y: c.y, z: c.z });
        if (handle) live.push({ x: c.x, y: c.y, z: c.z, handle });
      }
    }
  }

  silence() {
    this.rain?.stop(0.5); this.rain = null;
    this.wind?.stop(0.5); this.wind = null;
    this.hollow?.stop(0.5); this.hollow = null;   // B12
    this.desertWhistle?.stop(0.5); this.desertWhistle = null;   // v1.3.1 beds
    this.caveAir?.stop(0.5); this.caveAir = null;
    this.netherRumble?.stop(0.5); this.netherRumble = null;
    this.endVoid?.stop(0.5); this.endVoid = null;
    this.waveWash?.stop(0.5); this.waveWash = null;
    this.nextBirdAt = this.nextCricketAt = this.nextOwlAt = 0;  // disarm deadlines
    this.nextDripAt = this.nextGustAt = this.nextBreathAt = 0;
    for (const kind of ['water', 'lava']) {
      for (const c of this.clusters[kind]) c.handle?.stop(0.3);
      this.clusters[kind].length = 0;
    }
    for (const f of this.fires) f.handle?.stop(0.3);
    this.fires.length = 0;
  }
}

// v1.3.1 one-shot spawn points. Module-scope scratch (§1.6 discipline, same
// trick as engine.js's at()): read the player's pos synchronously into _at,
// never retain it — emitSound consumes it within the call.
const _at = { x: 0, y: 0, z: 0 };
function around(p, rMin, rMax, dyMin, dyMax) {
  const a = Math.random() * Math.PI * 2;
  const r = rMin + Math.random() * (rMax - rMin);
  _at.x = p.x + Math.cos(a) * r;
  _at.z = p.z + Math.sin(a) * r;
  _at.y = p.y + dyMin + Math.random() * (dyMax - dyMin);
  return _at;
}

// Collapse fire cells into <= 3 nearest-first cluster points.
function dedupe(cells, p) {
  const out = [];
  for (const c of cells) {
    let merged = false;
    for (const o of out) {
      if (Math.abs(o.x - c.x) <= 4 && Math.abs(o.y - c.y) <= 4 && Math.abs(o.z - c.z) <= 4) { merged = true; break; }
    }
    if (!merged) out.push(c);
  }
  return out
    .map(c => ({ ...c, d: Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z) }))
    .sort((a, b) => a.d - b.d);
}
