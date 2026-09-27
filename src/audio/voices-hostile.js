// 16-AUDIO v1.3.1 — hostile mob voices (Agent A of the audio overhaul).
//
// One synthesised voice trio (idle / hurt / death) per hostile mob type, plus the
// two boss death ids and the Specials Agent D wires emitters for. 100%
// procedural: every layer is a primitives.js call — nothing sampled, nothing
// copied, every voice built from oscillators and noise beds.
//
// These ids are emitted by the base Mob cadence (src/entities/mobs/Mob.js
// 186-330: idle every 80+randInt(80) ticks, hurt in onHurt, death in onDeath).
// events.js already derives generic trios from its §3.4 MOB_IDLE table; this
// module registers over the SAME ids with hand-tuned per-mob voices — def()
// assigns into the shared EVENTS registry, so importing this file after
// events.js (the orchestrator's wiring) replaces the generic derivation with
// the characterful one. Schema is identical either way.
//
// Entry schema (16 §3): { recipe, bus, refDist, maxDist, cap, capKey, priority,
// jitter, replicate, loop, muffle }. Defaults when a column is blank: bus
// 'sfx', refDist 1, maxDist 16, cap 2, jitter on, replicate = positional.
// Every entry here: bus 'sfx', positional, jitter on — the engine's §2.2 global
// variation is the only randomiser, because recipes themselves are
// deterministic: a mob's stagger rhythm is its identity, and §2.3 already
// decorrelates repeats inside the primitives. capKey 'mob_<type>' shares one
// budget across the trio (idle cap 3, hurt/death cap 2). Idle sits quiet in
// gain but carries on the mob's full maxDist; hurt is sharper; death is the
// loudest of the three.
//
// Voice identity (self-audit — every voice must be tellable apart):
//
//   mob              pitch zone       timbre identity
//   ---------------  ---------------  -------------------------------------------
//   zombie           ~82 Hz saw       sagging LP groan + pink chest rattle
//   zombie_villager  x1.30 of zombie  nasal 900 bp double-grunt, shorter breaths
//   skeleton         2.4 kHz bp Q8    bone-rattle run + dry 1.8 kHz square click
//   wither_skeleton  x0.78 skeleton   deeper 1.6 kHz rattle + charcoal crackle
//   creeper          4.5-5.6 kHz      all-breath hisses; no tonal core anywhere
//   spider           x1.25, 3.4 kHz   skitter chirp runs + hp leg ticks
//   enderman         110/111.5 beat   beating-pair drone throb + sub thud
//   ghast            400-900 Hz sine  airy falling wail + 2.6 kHz breath sheen
//   blaze            x1.15, 2.2 kHz   fire whoosh band + dense hot crackle
//   magma_cube       x0.90, <200 Hz   wet gulp squelch over a soft sub thud
//   piglin           x1.05, 150 saw   grunt consonant + nasal 950 bp formant
//   shulker          x1.15, 2.6 kHz   shell clacks + 300-520 triangle warble
//   wither           x0.85, sub 55    triple sub-throbs + dark bp breath
//   sentinel         x0.85, 55/82.5   beating stone drone + 1.9 kHz tick rhythm
//   marauder         x1.08, 145 saw   gruff grunts + 1.6 kHz crossbow ratchet
//   ender_dragon     x0.90, sub 70    pink wing whoosh over a 30-70 Hz thump bed
//
// Far-field rows: ghast 4/48, wither and ender_dragon 8/96, sentinel 2/24,
// enderman 1/24 — the voices you must hear coming.
import { EVENTS, P } from './events.js';
import {
  noiseBurst, thud, blip, sweep, crackle, chime, hiss, gulp, whoosh, drone,
} from './primitives.js';

// events.js keeps def() private; recreate the identical one-liner so this module
// can register into the same shared registry without touching that file.
const def = (id, o) => { EVENTS[id] = o; return o; };

// Per-mob registration. Each verb gets its own hand-written recipe (not §3.4's
// generic dur/fall derivation) so hurt can sharpen and death can sag.
function trio(type, dist, idle, hurt, death) {
  const base = {
    bus: 'sfx', refDist: dist.rd ?? 1, maxDist: dist.md ?? 16,
    capKey: 'mob_' + type, priority: P.NEAR, replicate: true,
  };
  def(`mob.${type}.idle`, { ...base, cap: 3, recipe: idle });
  def(`mob.${type}.hurt`, { ...base, cap: 2, recipe: hurt });
  def(`mob.${type}.death`, { ...base, cap: 2, recipe: death });
}

// ---------------------------------------------------------------- zombie

// The rotting baseline every undead voice is measured against: a sawtooth
// groan sagging 82->62 Hz under an LP 500, with a pink chest rattle beneath.
trio('zombie', {}, (v, t, p, g) => {
  const groan = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 82, f1: 62, dur: 0.65, gain: 0.42 * g, pitch: p,
    filter: { type: 'lp', freq: 500, Q: 1 },
  });
  noiseBurst(v, t, { src: 'pink', filter: 'bp', freq: 250, Q: 1, dur: 0.55, gain: 0.13 * g, pitch: p });
  return groan;
}, (v, t, p, g) => {
  const yelp = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 95, f1: 70, dur: 0.26, gain: 0.55 * g, pitch: p * 1.1,
    filter: { type: 'lp', freq: 700, Q: 1 },
  });
  noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 380, Q: 2, dur: 0.14, gain: 0.3 * g, pitch: p });
  return Math.max(yelp, thud(v, t, { f0: 120, f1: 70, dur: 0.12, gain: 0.3 * g, pitch: p }));
}, (v, t, p, g) => {
  const moan = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 80, f1: 40, dur: 1.1, gain: 0.6 * g, pitch: p * 0.9,
    filter: { type: 'lp', freq: 420, Q: 1 },
  });
  thud(v, t + 0.55, { f0: 110, f1: 50, dur: 0.35, gain: 0.5 * g, pitch: p });
  noiseBurst(v, t, { src: 'pink', filter: 'bp', freq: 220, Q: 1, dur: 0.8, gain: 0.2 * g, pitch: p });
  return Math.max(moan, t + 0.92);
});

// Pitched-up sickly variant: same undead family, nasal formant, two short
// grunts instead of one long groan.
trio('zombie_villager', {}, (v, t, p, g) => {
  sweep(v, t, {
    src: 'osc', wave: 'triangle', f0: 108, f1: 88, dur: 0.28, gain: 0.35 * g, pitch: p * 1.3,
    filter: { type: 'lp', freq: 800, Q: 1 },
  });
  noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 900, Q: 3, dur: 0.2, gain: 0.22 * g, pitch: p * 1.3 });
  return sweep(v, t + 0.22, {
    src: 'osc', wave: 'triangle', f0: 100, f1: 82, dur: 0.24, gain: 0.3 * g, pitch: p * 1.3,
    filter: { type: 'lp', freq: 800, Q: 1 },
  });
}, (v, t, p, g) => {
  const yelp = sweep(v, t, {
    src: 'osc', wave: 'triangle', f0: 130, f1: 95, dur: 0.2, gain: 0.5 * g, pitch: p * 1.42,
    filter: { type: 'lp', freq: 1000, Q: 1 },
  });
  return Math.max(yelp, noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 1100, Q: 4, dur: 0.12, gain: 0.35 * g, pitch: p * 1.3 }));
}, (v, t, p, g) => {
  const moan = sweep(v, t, {
    src: 'osc', wave: 'triangle', f0: 100, f1: 55, dur: 0.9, gain: 0.55 * g, pitch: p * 1.2,
    filter: { type: 'lp', freq: 600, Q: 1 },
  });
  noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 800, Q: 3, dur: 0.6, gain: 0.25 * g, pitch: p * 1.3 });
  return Math.max(moan, thud(v, t + 0.5, { f0: 130, f1: 60, dur: 0.3, gain: 0.4 * g, pitch: p }));
});

// ---------------------------------------------------------------- skeleton family

// Bone rattle: a run of tight bp bursts with a dry square click between them.
trio('skeleton', {}, (v, t, p, g) => {
  let last = t;
  for (let i = 0; i < 4; i++) {
    last = noiseBurst(v, t + i * 0.03, { src: 'white', filter: 'bp', freq: 2400, Q: 8, dur: 0.03, gain: 0.4 * g, pitch: p });
  }
  blip(v, t + 0.045, { wave: 'square', freq: 1800, dur: 0.014, gain: 0.25 * g, pitch: p });
  hiss(v, t, { freq: 6000, dur: 0.1, gain: 0.08 * g, pitch: p });
  return last;
}, (v, t, p, g) => {
  let last = t;
  for (let i = 0; i < 6; i++) {
    last = noiseBurst(v, t + i * 0.022, { src: 'white', filter: 'bp', freq: 2700, Q: 8, dur: 0.025, gain: 0.5 * g, pitch: p * 1.1 });
  }
  blip(v, t + 0.05, { wave: 'square', freq: 2200, dur: 0.014, gain: 0.3 * g, pitch: p * 1.1 });
  return Math.max(last, thud(v, t, { f0: 200, f1: 90, dur: 0.08, noiseGain: 0.6, gain: 0.3 * g, pitch: p }));
}, (v, t, p, g) => {
  let last = t;
  for (let i = 0; i < 8; i++) {                                  // the pile collapsing
    last = noiseBurst(v, t + i * 0.05, {
      src: 'white', filter: 'bp', freq: 2600 - 1700 * (i / 7), Q: 8, dur: 0.03, gain: 0.5 * g, pitch: p * 0.9,
    });
  }
  crackle(v, t, { density: 2, freq: 2000, dur: 0.25, gain: 0.2 * g, pitch: p * 0.9 });
  return Math.max(last, thud(v, t + 0.3, { f0: 170, f1: 60, dur: 0.3, gain: 0.5 * g, pitch: p * 0.9 }));
});

// Deeper skeleton: the same rattle an octave down, dried out over coals.
trio('wither_skeleton', {}, (v, t, p, g) => {
  let last = t;
  for (let i = 0; i < 4; i++) {
    last = noiseBurst(v, t + i * 0.034, { src: 'white', filter: 'bp', freq: 1600, Q: 6, dur: 0.035, gain: 0.42 * g, pitch: p * 0.78 });
  }
  blip(v, t + 0.05, { wave: 'square', freq: 1200, dur: 0.016, gain: 0.2 * g, pitch: p * 0.78 });
  return Math.max(last, crackle(v, t, { density: 1, freq: 900, dur: 0.18, gain: 0.18 * g, pitch: p * 0.78 }));
}, (v, t, p, g) => {
  let last = t;
  for (let i = 0; i < 6; i++) {
    last = noiseBurst(v, t + i * 0.024, { src: 'white', filter: 'bp', freq: 1750, Q: 6, dur: 0.03, gain: 0.55 * g, pitch: p * 0.82 });
  }
  crackle(v, t, { density: 1.2, freq: 1100, dur: 0.2, gain: 0.25 * g, pitch: p * 0.82 });
  return Math.max(last, thud(v, t, { f0: 150, f1: 70, dur: 0.1, gain: 0.35 * g, pitch: p * 0.82 }));
}, (v, t, p, g) => {
  let last = t;
  for (let i = 0; i < 8; i++) {
    last = noiseBurst(v, t + i * 0.055, {
      src: 'white', filter: 'bp', freq: 1600 - 900 * (i / 7), Q: 6, dur: 0.035, gain: 0.55 * g, pitch: p * 0.78,
    });
  }
  crackle(v, t, { density: 1.2, freq: 800, dur: 0.4, gain: 0.3 * g, pitch: p * 0.78 });
  return Math.max(last, thud(v, t + 0.35, { f0: 140, f1: 50, dur: 0.35, gain: 0.55 * g, pitch: p * 0.78 }));
});

// ---------------------------------------------------------------- creeper

// No voice at all — only breath. Three dry hisses with a paper-dry rustle.
// (Mob.js never emits this id — the silent-creeper dread is a feature — but the
// trio is registered so any future caller and the §5.2 fallback resolve here.)
trio('creeper', {}, (v, t, p, g) => {
  hiss(v, t, { freq: 4800, dur: 0.1, gain: 0.3 * g, pitch: p });
  hiss(v, t + 0.18, { freq: 5200, dur: 0.09, gain: 0.26 * g, pitch: p });
  noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 2500, Q: 0.8, dur: 0.35, gain: 0.1 * g, pitch: p });
  return hiss(v, t + 0.36, { freq: 4800, dur: 0.11, gain: 0.3 * g, pitch: p });
}, (v, t, p, g) => {
  const exhale = sweep(v, t, { src: 'noise', f0: 3000, f1: 1200, dur: 0.12, gain: 0.25 * g, pitch: p, filter: { Q: 2 } });
  noiseBurst(v, t, { src: 'white', filter: 'hp', freq: 3500, Q: 1, dur: 0.08, gain: 0.35 * g, pitch: p });
  return Math.max(exhale, hiss(v, t, { freq: 5600, dur: 0.14, gain: 0.5 * g, pitch: p }));
}, (v, t, p, g) => {
  const deflate = sweep(v, t, { src: 'noise', f0: 2600, f1: 500, dur: 0.55, gain: 0.45 * g, pitch: p, filter: { Q: 1.5 } });
  hiss(v, t, { freq: 4200, dur: 0.5, gain: 0.3 * g, pitch: p });
  return Math.max(deflate, thud(v, t + 0.45, { f0: 150, f1: 60, dur: 0.15, gain: 0.25 * g, pitch: p }));
});

// ---------------------------------------------------------------- spider

// Skitter: a chirp run in the 3.4 kHz band plus dry leg ticks underneath.
trio('spider', {}, (v, t, p, g) => {
  let last = t;
  for (let i = 0; i < 6; i++) {
    last = noiseBurst(v, t + i * 0.05, { src: 'white', filter: 'bp', freq: 3400, Q: 6, dur: 0.02, gain: 0.35 * g, pitch: p * 1.25 });
  }
  for (let i = 0; i < 3; i++) {
    last = noiseBurst(v, t + 0.025 + i * 0.09, { src: 'white', filter: 'hp', freq: 4800, Q: 1, dur: 0.01, gain: 0.2 * g, pitch: p * 1.25 });
  }
  return last;
}, (v, t, p, g) => {
  const shriek = noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 3800, Q: 6, dur: 0.03, gain: 0.5 * g, pitch: p * 1.35 });
  noiseBurst(v, t + 0.035, { src: 'white', filter: 'bp', freq: 3800, Q: 6, dur: 0.03, gain: 0.45 * g, pitch: p * 1.35 });
  let last = shriek;
  for (let i = 0; i < 5; i++) {
    last = noiseBurst(v, t + 0.08 + i * 0.018, { src: 'white', filter: 'hp', freq: 5200, Q: 1, dur: 0.01, gain: 0.25 * g, pitch: p * 1.3 });
  }
  return Math.max(last, hiss(v, t, { freq: 5000, dur: 0.08, gain: 0.2 * g, pitch: p }));
}, (v, t, p, g) => {
  let last = t;
  for (let i = 0; i < 8; i++) {
    last = noiseBurst(v, t + i * 0.045, {
      src: 'white', filter: 'bp', freq: 3600 - 2100 * (i / 7), Q: 6, dur: 0.022, gain: 0.45 * g, pitch: p * 1.2,
    });
  }
  for (let i = 0; i < 4; i++) {
    last = noiseBurst(v, t + 0.03 + i * 0.075, { src: 'white', filter: 'hp', freq: 4600, Q: 1, dur: 0.01, gain: 0.2 * g, pitch: p * 1.2 });
  }
  return Math.max(last, thud(v, t + 0.36, { f0: 220, f1: 100, dur: 0.12, gain: 0.3 * g, pitch: p }));
});

// ---------------------------------------------------------------- enderman

// A vocal-ish warble: two sines 1.5 Hz apart beat against each other inside an
// LP 700 while an LFO throbs the gain — the closest thing to speech here.
trio('enderman', { md: 24 }, (v, t, p, g) => {
  const warble = drone(v, t, {
    freqs: [110, 111.5], dur: 0.9, gain: 0.3 * g, lpFreq: 700, attack: 0.15, pitch: p,
    lfo: { rate: 6, depth: 0.8, target: 'gain' },
  });
  noiseBurst(v, t, { src: 'pink', filter: 'bp', freq: 500, Q: 1, dur: 0.7, gain: 0.1 * g, pitch: p });
  return Math.max(warble, thud(v, t, { f0: 60, f1: 38, dur: 0.4, gain: 0.25 * g, pitch: p }));
}, (v, t, p, g) => {
  const yelp = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 260, f1: 110, dur: 0.22, gain: 0.5 * g, pitch: p * 1.2,
    filter: { type: 'bp', freq: 1400, Q: 3 },
  });
  noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 1800, Q: 2, dur: 0.12, gain: 0.35 * g, pitch: p });
  return Math.max(yelp, thud(v, t, { f0: 90, f1: 45, dur: 0.15, gain: 0.4 * g, pitch: p }));
}, (v, t, p, g) => {
  const sink = drone(v, t, {
    freqs: [105, 107], dur: 1.4, gain: 0.35 * g, lpFreq: 500, attack: 0.1, pitch: p * 0.9,
    lfo: { rate: 4, depth: 1.0, target: 'gain' },
  });
  noiseBurst(v, t, { src: 'pink', filter: 'bp', freq: 400, Q: 1, dur: 1.1, gain: 0.12 * g, pitch: p * 0.9 });
  return Math.max(sink, thud(v, t, { f0: 55, f1: 30, dur: 0.9, gain: 0.35 * g, pitch: p * 0.9 }));
});

// ---------------------------------------------------------------- ghast

// Huge airy wail: a sine gliding down through an LP 1600 with a wide breath
// sheen and one eerie FM overtone. refDist 4 / maxDist 48 — audible across the
// whole Nether ceiling.
trio('ghast', { rd: 4, md: 48 }, (v, t, p, g) => {
  const wail = sweep(v, t, {
    src: 'osc', wave: 'sine', f0: 640, f1: 380, dur: 1.6, gain: 0.4 * g, pitch: p,
    filter: { type: 'lp', freq: 1600, Q: 1 },
  });
  hiss(v, t, { freq: 2600, Q: 0.5, dur: 1.4, gain: 0.18 * g, pitch: p });
  chime(v, t, { freq: 620, ratio: 1.5, index: 2, dur: 1.3, gain: 0.1 * g, pitch: p });
  return wail;
}, (v, t, p, g) => {
  const puncture = noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 1800, Q: 8, dur: 0.06, gain: 0.4 * g, pitch: p });
  const wail = sweep(v, t, {
    src: 'osc', wave: 'sine', f0: 700, f1: 500, dur: 0.7, gain: 0.5 * g, pitch: p * 1.1,
    filter: { type: 'lp', freq: 1800, Q: 1 },
  });
  return Math.max(puncture, wail, hiss(v, t, { freq: 3000, Q: 0.5, dur: 0.5, gain: 0.2 * g, pitch: p }));
}, (v, t, p, g) => {
  const collapse = sweep(v, t, {
    src: 'osc', wave: 'sine', f0: 560, f1: 170, dur: 2.2, gain: 0.55 * g, pitch: p * 0.85,
    filter: { type: 'lp', freq: 1200, Q: 1 },
  });
  sweep(v, t, { src: 'noise', f0: 2200, f1: 500, dur: 1.8, gain: 0.25 * g, pitch: p * 0.85, filter: { Q: 0.8 } });
  return Math.max(collapse, thud(v, t + 1.6, { f0: 90, f1: 40, dur: 0.5, gain: 0.4 * g, pitch: p * 0.85 }));
});

// ---------------------------------------------------------------- blaze

// Fire breath: a rising whoosh band carrying dense hot crackle.
trio('blaze', {}, (v, t, p, g) => {
  const breath = whoosh(v, t, { f0: 500, f1: 1400, dur: 0.5, gain: 0.35 * g, pitch: p, Q: 1 });
  crackle(v, t, { density: 1.6, freq: 2200, dur: 0.5, gain: 0.3 * g, pitch: p * 1.15 });
  return Math.max(breath, hiss(v, t, { freq: 4000, dur: 0.45, gain: 0.15 * g, pitch: p }));
}, (v, t, p, g) => {
  const flare = whoosh(v, t, { f0: 800, f1: 2200, dur: 0.28, gain: 0.5 * g, pitch: p * 1.15, Q: 1 });
  crackle(v, t, { density: 2, freq: 2600, dur: 0.3, gain: 0.4 * g, pitch: p * 1.2 });
  return Math.max(flare, blip(v, t, { wave: 'square', freq: 900, f1: 500, dur: 0.08, gain: 0.3 * g, pitch: p * 1.2 }));
}, (v, t, p, g) => {
  const die = sweep(v, t, { src: 'noise', f0: 2400, f1: 400, dur: 0.8, gain: 0.45 * g, pitch: p * 0.9, filter: { Q: 1 } });
  crackle(v, t, { density: 1.2, freq: 1800, dur: 0.7, gain: 0.35 * g, pitch: p * 0.9 });
  return Math.max(die, hiss(v, t, { freq: 3000, dur: 0.6, gain: 0.2 * g, pitch: p * 0.9 }));
});

// ---------------------------------------------------------------- magma cube

// Wet squish: a gulp's wobble curve over a soft sub thud, pitched down.
trio('magma_cube', {}, (v, t, p, g) => {
  const squish = gulp(v, t, { dur: 0.16, wobble: [220, 100, 150], gain: 0.35 * g, pitch: p * 0.9 });
  return Math.max(squish, thud(v, t, { f0: 95, f1: 40, dur: 0.18, gain: 0.3 * g, pitch: p * 0.9 }));
}, (v, t, p, g) => {
  const a = gulp(v, t, { dur: 0.13, wobble: [260, 120, 170], gain: 0.5 * g, pitch: p * 0.95 });
  const b = gulp(v, t + 0.1, { dur: 0.15, wobble: [180, 80, 120], gain: 0.45 * g, pitch: p * 0.8 });
  return Math.max(a, b, thud(v, t, { f0: 80, f1: 35, dur: 0.2, gain: 0.4 * g, pitch: p * 0.85 }));
}, (v, t, p, g) => {
  const burst = gulp(v, t, { dur: 0.22, wobble: [200, 70, 90], gain: 0.55 * g, pitch: p * 0.8 });
  crackle(v, t, { density: 1.5, freq: 700, dur: 0.3, gain: 0.2 * g, pitch: p * 0.8 });
  return Math.max(burst, thud(v, t + 0.05, { f0: 85, f1: 30, dur: 0.3, gain: 0.55 * g, pitch: p * 0.8 }));
});

// ---------------------------------------------------------------- piglin

// Grunt-snort: a bp consonant, a nasal formant sweep, then the snort.
trio('piglin', {}, (v, t, p, g) => {
  const grunt = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 150, f1: 112, dur: 0.16, gain: 0.35 * g, pitch: p * 1.05,
    filter: { type: 'bp', freq: 950, Q: 4 },
  });
  noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 700, Q: 1.5, dur: 0.08, gain: 0.4 * g, pitch: p * 1.05 });
  return Math.max(grunt, hiss(v, t + 0.2, { freq: 1400, filter: 'bp', Q: 1, dur: 0.09, gain: 0.25 * g, pitch: p * 1.05 }));
}, (v, t, p, g) => {
  const bark = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 190, f1: 130, dur: 0.12, gain: 0.45 * g, pitch: p * 1.2,
    filter: { type: 'bp', freq: 1100, Q: 4 },
  });
  noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 850, Q: 2, dur: 0.07, gain: 0.5 * g, pitch: p * 1.2 });
  return Math.max(bark, hiss(v, t + 0.06, { freq: 1600, filter: 'bp', Q: 1, dur: 0.07, gain: 0.3 * g, pitch: p * 1.2 }));
}, (v, t, p, g) => {
  const groan = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 150, f1: 70, dur: 0.7, gain: 0.5 * g, pitch: p * 0.9,
    filter: { type: 'bp', freq: 800, Q: 3 },
  });
  noiseBurst(v, t + 0.5, { src: 'white', filter: 'bp', freq: 600, Q: 1.5, dur: 0.12, gain: 0.35 * g, pitch: p * 0.9 });
  return Math.max(groan, thud(v, t + 0.62, { f0: 130, f1: 55, dur: 0.25, gain: 0.4 * g, pitch: p * 0.9 }));
});

// ---------------------------------------------------------------- shulker

// Shell voice: hard clacks in the 2.6 kHz band over a low triangle warble.
trio('shulker', {}, (v, t, p, g) => {
  let last = t;
  for (let i = 0; i < 3; i++) {
    last = noiseBurst(v, t + i * 0.09, { src: 'white', filter: 'bp', freq: 2600, Q: 3, dur: 0.03, gain: 0.4 * g, pitch: p * 1.15 });
  }
  blip(v, t + 0.04, { wave: 'triangle', freq: 300, f1: 520, dur: 0.1, gain: 0.3 * g, pitch: p * 1.15 });
  hiss(v, t, { freq: 6000, dur: 0.06, gain: 0.08 * g, pitch: p * 1.15 });
  return last;
}, (v, t, p, g) => {
  const clack = noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 2300, Q: 2, dur: 0.055, gain: 0.6 * g, pitch: p * 1.2 });
  chime(v, t, { freq: 2400, ratio: 2.76, index: 2, dur: 0.1, gain: 0.25 * g, pitch: p * 1.2 });
  return Math.max(clack, blip(v, t + 0.01, { wave: 'square', freq: 700, f1: 400, dur: 0.05, gain: 0.25 * g, pitch: p * 1.2 }));
}, (v, t, p, g) => {
  let last = t;
  for (let i = 0; i < 5; i++) {
    last = noiseBurst(v, t + i * 0.07, {
      src: 'white', filter: 'bp', freq: 2600 - 1400 * (i / 4), Q: 3, dur: 0.035, gain: 0.5 * g, pitch: p * 1.1,
    });
  }
  const creak = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 420, f1: 240, dur: 0.5, gain: 0.3 * g, pitch: p * 1.1,
    filter: { type: 'lp', freq: 900, Q: 2 },
  });
  return Math.max(last, creak, thud(v, t + 0.38, { f0: 180, f1: 70, dur: 0.2, gain: 0.3 * g, pitch: p * 1.1 }));
});

// ---------------------------------------------------------------- wither

// The three-vertebra knock: triple sub-throbs under a dark bandpassed breath.
// refDist 8 / maxDist 96 — the boss carries across the battlefield.
trio('wither', { rd: 8, md: 96 }, (v, t, p, g) => {
  let last = t;
  for (let i = 0; i < 3; i++) {
    last = thud(v, t + i * 0.24, { f0: 55, f1: 32, dur: 0.3, gain: 0.5 * g, pitch: p * 0.85 });
  }
  hiss(v, t, { freq: 700, filter: 'bp', Q: 0.8, dur: 0.9, gain: 0.15 * g, pitch: p * 0.85 });
  return Math.max(last, sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 120, f1: 85, dur: 0.8, gain: 0.12 * g, pitch: p * 0.85,
    filter: { type: 'lp', freq: 300, Q: 1 },
  }));
}, (v, t, p, g) => {
  const crunch = thud(v, t, { f0: 90, f1: 35, dur: 0.25, noiseGain: 0.9, gain: 0.6 * g, pitch: p * 0.85 });
  crackle(v, t, { density: 1.2, freq: 600, dur: 0.25, gain: 0.3 * g, pitch: p * 0.85 });
  return Math.max(crunch, sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 150, f1: 65, dur: 0.3, gain: 0.35 * g, pitch: p * 0.85,
    filter: { type: 'lp', freq: 500, Q: 1 },
  }));
}, (v, t, p, g) => {
  const roar = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 180, f1: 45, dur: 1.6, gain: 0.55 * g, pitch: p * 0.85,
    filter: { type: 'lp', freq: 400, Q: 1 },
  });
  let last = roar;
  for (let i = 0; i < 3; i++) {
    last = thud(v, t + 0.2 + i * 0.5, { f0: 60, f1: 28, dur: 0.35, gain: 0.5 * g, pitch: p * 0.85 });
  }
  return Math.max(last, hiss(v, t, { freq: 500, filter: 'bp', Q: 0.8, dur: 1.4, gain: 0.18 * g, pitch: p * 0.85 }));
});

// ---------------------------------------------------------------- sentinel

// Living construction: a beating stone drone (55 + 82.5 Hz) with a slow gain
// throb, and a metronome of 1.9 kHz ticks. refDist 2 / maxDist 24.
trio('sentinel', { rd: 2, md: 24 }, (v, t, p, g) => {
  const hum = drone(v, t, {
    freqs: [55, 82.5], dur: 1.2, gain: 0.3 * g, lpFreq: 520, attack: 0.25, pitch: p * 0.85,
    lfo: { rate: 2.5, depth: 0.6, target: 'gain' },
  });
  let last = hum;
  for (let i = 0; i < 3; i++) {
    last = Math.max(last, blip(v, t + 0.1 + i * 0.18, { wave: 'square', freq: 1900, dur: 0.02, gain: 0.22 * g, pitch: p * 0.85 }));
  }
  return Math.max(last, noiseBurst(v, t + 0.19, { src: 'white', filter: 'bp', freq: 800, Q: 4, dur: 0.03, gain: 0.15 * g, pitch: p * 0.85 }));
}, (v, t, p, g) => {
  const crunch = thud(v, t, { f0: 120, f1: 50, dur: 0.25, noiseGain: 0.9, gain: 0.6 * g, pitch: p * 0.85 });
  noiseBurst(v, t, { src: 'white', filter: 'lp', freq: 1400, Q: 0.7, dur: 0.2, gain: 0.45 * g, pitch: p * 0.85 });
  return Math.max(crunch, crackle(v, t, { density: 1.4, freq: 500, dur: 0.3, gain: 0.3 * g, pitch: p * 0.85 }));
}, (v, t, p, g) => {
  const fall = sweep(v, t, { src: 'noise', f0: 900, f1: 120, dur: 1.4, gain: 0.5 * g, pitch: p * 0.85, filter: { Q: 0.7 } });
  const rumble = noiseBurst(v, t, { src: 'brown', filter: 'lp', freq: 300, Q: 0.7, dur: 1.2, gain: 0.4 * g, pitch: p * 0.85 });
  crackle(v, t, { density: 0.8, freq: 400, dur: 0.9, gain: 0.25 * g, pitch: p * 0.85 });
  return Math.max(fall, rumble, thud(v, t + 1.0, { f0: 90, f1: 30, dur: 0.4, gain: 0.5 * g, pitch: p * 0.85 }));
});

// ---------------------------------------------------------------- marauder

// A raider's throat: gruff saw grunts with a bp consonant, plus the idle
// flourish of fingers on a crossbow ratchet.
trio('marauder', {}, (v, t, p, g) => {
  const grunt = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 145, f1: 108, dur: 0.15, gain: 0.32 * g, pitch: p * 1.08,
    filter: { type: 'bp', freq: 750, Q: 3 },
  });
  noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 500, Q: 1.5, dur: 0.08, gain: 0.38 * g, pitch: p * 1.08 });
  blip(v, t + 0.26, { wave: 'square', freq: 1600, dur: 0.015, gain: 0.2 * g, pitch: p * 1.08 });
  return Math.max(grunt, blip(v, t + 0.3, { wave: 'square', freq: 1600, dur: 0.015, gain: 0.2 * g, pitch: p * 1.08 }));
}, (v, t, p, g) => {
  const bark = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 190, f1: 125, dur: 0.11, gain: 0.42 * g, pitch: p * 1.25,
    filter: { type: 'bp', freq: 900, Q: 4 },
  });
  noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 800, Q: 2, dur: 0.06, gain: 0.5 * g, pitch: p * 1.25 });
  return Math.max(bark, blip(v, t + 0.09, { wave: 'square', freq: 1600, dur: 0.012, gain: 0.18 * g, pitch: p * 1.25 }));
}, (v, t, p, g) => {
  const groan = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 150, f1: 60, dur: 0.8, gain: 0.45 * g, pitch: p * 0.95,
    filter: { type: 'bp', freq: 650, Q: 2.5 },
  });
  noiseBurst(v, t + 0.55, { src: 'white', filter: 'bp', freq: 450, Q: 1.5, dur: 0.15, gain: 0.3 * g, pitch: p * 0.95 });
  blip(v, t + 0.95, { wave: 'square', freq: 1100, dur: 0.015, gain: 0.15 * g, pitch: p * 0.95 });
  return Math.max(groan, thud(v, t + 0.7, { f0: 140, f1: 55, dur: 0.3, gain: 0.4 * g, pitch: p * 0.95 }));
});

// ---------------------------------------------------------------- ender dragon

// Colossal wing-thump breath: a pink whoosh fanning 180->70 Hz over a 70->30 Hz
// thump bed. refDist 8 / maxDist 96, matching events.js's dragon family.
trio('ender_dragon', { rd: 8, md: 96 }, (v, t, p, g) => {
  const wing = whoosh(v, t, { src: 'pink', f0: 180, f1: 70, dur: 0.7, gain: 0.45 * g, pitch: p, Q: 0.8 });
  hiss(v, t, { freq: 300, filter: 'bp', Q: 0.8, dur: 0.6, gain: 0.15 * g, pitch: p });
  return Math.max(wing, thud(v, t + 0.1, { f0: 70, f1: 30, dur: 0.3, noiseGain: 0.5, gain: 0.45 * g, pitch: p }));
}, (v, t, p, g) => {
  const roar = drone(v, t, { freqs: [58, 87], dur: 1.0, gain: 0.5 * g, lpFreq: 700, attack: 0.05, pitch: p * 0.9 });
  const crunch = noiseBurst(v, t, { src: 'white', filter: 'lp', freq: 900, Q: 0.7, dur: 0.3, gain: 0.4 * g, pitch: p * 0.9 });
  crackle(v, t, { density: 1, freq: 400, dur: 0.4, gain: 0.2 * g, pitch: p * 0.9 });
  return Math.max(roar, crunch, thud(v, t, { f0: 75, f1: 30, dur: 0.35, gain: 0.5 * g, pitch: p * 0.9 }));
}, (v, t, p, g) => {
  const roar = drone(v, t, {
    freqs: [65, 97], dur: 2.6, gain: 0.55 * g, lpFreq: 600, attack: 0.1, pitch: p * 0.85,
    lfo: { rate: 3, depth: 0.8, target: 'gain' },
  });
  const fall = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 160, f1: 40, dur: 2.4, gain: 0.45 * g, pitch: p * 0.85,
    filter: { type: 'lp', freq: 500, Q: 1 },
  });
  let last = Math.max(roar, fall);
  for (let i = 0; i < 3; i++) {                                  // the ground shakes
    last = Math.max(last, thud(v, t + 0.9 + i * 0.75, { f0: 70 - 20 * i, f1: 30 - 8 * i, dur: 0.4, gain: 0.5 * g, pitch: p * 0.85 }));
  }
  return last;
});

// ---------------------------------------------------------------- specials

// Sentinel sonic attack (Agent D wires the emitter): a charged rising sweep
// that detonates into a sub slam.
def('mob.sentinel.pulse', {
  bus: 'sfx', refDist: 2, maxDist: 32, cap: 2, capKey: 'sentinel_pulse',
  priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    const charge = sweep(v, t, {
      src: 'osc', wave: 'sawtooth', f0: 220, f1: 880, dur: 0.45, gain: 0.4 * g, pitch: p * 0.85,
      filter: { type: 'bp', freq: 1200, Q: 2 },
    });
    const slam = thud(v, t + 0.45, { f0: 70, f1: 28, dur: 0.4, noiseGain: 0.9, gain: 0.6 * g, pitch: p * 0.85 });
    return Math.max(charge, slam, crackle(v, t + 0.45, { density: 1.2, freq: 300, dur: 0.5, gain: 0.3 * g, pitch: p * 0.85 }));
  },
});

// Magma cube jump (Agent D wires the emitter): the squish that launches it.
def('mob.magma_cube.jump', {
  bus: 'sfx', maxDist: 16, cap: 2, capKey: 'magma_jump', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    const launch = gulp(v, t, { dur: 0.14, wobble: [280, 140, 190], gain: 0.4 * g, pitch: p * 0.95 });
    noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 600, Q: 1.5, dur: 0.08, gain: 0.2 * g, pitch: p * 0.95 });
    return Math.max(launch, whoosh(v, t, { f0: 300, f1: 900, dur: 0.22, gain: 0.25 * g, pitch: p * 0.95, Q: 1 }));
  },
});

// Blaze fireball launch (Agent D wires the emitter): single shot, not the
// three-round volley events.js's entity.blaze.shoot owns.
def('mob.blaze.shoot', {
  bus: 'sfx', maxDist: 24, cap: 2, capKey: 'blaze_fireball', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    const shot = whoosh(v, t, { f0: 600, f1: 2400, dur: 0.35, gain: 0.5 * g, pitch: p, Q: 1 });
    crackle(v, t, { density: 1.4, freq: 2400, dur: 0.4, gain: 0.35 * g, pitch: p });
    return Math.max(shot, hiss(v, t, { freq: 5000, dur: 0.15, gain: 0.2 * g, pitch: p }));
  },
});
