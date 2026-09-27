// 16-AUDIO v1.3.1 — passive mob voices + fishing (Agent B, hand-finished by the
// orchestrator after two failed agent attempts).
//
// Companion to voices-hostile.js: one synthesised voice trio (idle / hurt /
// death) per passive/neutral mob, plus the fishing event family. The base Mob
// cadence (src/entities/mobs/Mob.js 186-330) emits the trio ids; events.js's
// generic derivations are replaced when the orchestrator imports this module
// after events.js. Schema identical to voices-hostile.js (16 §3): bus 'sfx',
// positional, jitter on, capKey 'mob_<type>' (idle cap 3, hurt/death cap 2),
// recipes deterministic — the engine's §2.2 jitter and §2.3 decorrelation own
// all variation.
//
// Voice identity (self-audit — every voice must be tellable apart):
//
//   mob            pitch zone        timbre identity
//   -------------- ----------------- --------------------------------------------
//   cow            130-98 Hz, low    wide low moo-sag + slow breath rattle
//   pig            x1.6, nasal       double snort: nasal bp pairs + grunt tail
//   sheep          x1.15, wobble     slow square-ish baa with 5 Hz pitch wobble
//   chicken        x2.6, tiny        short bp clucks; squawk = fast up-down sweep
//   villager       95 Hz nasal hm    low vowel hm with a rising-falling contour
//   iron_golem     sub 70 + metal    stone creak + single metal tick; clang-thud
//
// Fishing family (wired by interaction.js useRod + FishingBobber):
//   item.fishing.cast   rod swish + line tick
//   item.fishing.bite   plop + quick tick (the tug)
//   item.fishing.reel   3-click ratchet
//   item.fishing.splash water entry: lp noise sweep + gulp
import { EVENTS, P } from './events.js';
import {
  noiseBurst, thud, blip, sweep, crackle, chime, hiss, gulp, whoosh, drone,
} from './primitives.js';

// events.js keeps def() private; recreate the identical one-liner (see
// voices-hostile.js for the rationale).
const def = (id, o) => { EVENTS[id] = o; return o; };

function trio(type, dist, idle, hurt, death) {
  const base = {
    bus: 'sfx', refDist: dist.rd ?? 1, maxDist: dist.md ?? 16,
    capKey: 'mob_' + type, priority: P.NEAR, replicate: true,
  };
  def(`mob.${type}.idle`, { ...base, cap: 3, recipe: idle });
  def(`mob.${type}.hurt`, { ...base, cap: 2, recipe: hurt });
  def(`mob.${type}.death`, { ...base, cap: 2, recipe: death });
}

// ---------------------------------------------------------------- cow

// Wide low moo: a slow 130→98 Hz sag under a dark lp filter, breath beneath.
trio('cow', {}, (v, t, p, g) => {
  const moo = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 130, f1: 98, dur: 0.8, gain: 0.4 * g, pitch: p,
    filter: { type: 'lp', freq: 420, Q: 1 },
  });
  noiseBurst(v, t, { src: 'pink', filter: 'bp', freq: 240, Q: 1, dur: 0.6, gain: 0.12 * g, pitch: p });
  return moo;
}, (v, t, p, g) => {
  const bawl = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 150, f1: 110, dur: 0.3, gain: 0.5 * g, pitch: p * 1.08,
    filter: { type: 'lp', freq: 560, Q: 1 },
  });
  return Math.max(bawl, thud(v, t, { f0: 140, f1: 80, dur: 0.12, gain: 0.3 * g, pitch: p }));
}, (v, t, p, g) => {
  const fall = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 120, f1: 60, dur: 1.0, gain: 0.55 * g, pitch: p * 0.92,
    filter: { type: 'lp', freq: 400, Q: 1 },
  });
  thud(v, t + 0.5, { f0: 120, f1: 60, dur: 0.3, gain: 0.45 * g, pitch: p });
  noiseBurst(v, t, { src: 'pink', filter: 'bp', freq: 200, Q: 1, dur: 0.7, gain: 0.18 * g, pitch: p });
  return Math.max(fall, t + 0.9);
});

// ---------------------------------------------------------------- pig

// Double snort: two tight nasal bp bursts with a grunt tail — the oink.
trio('pig', {}, (v, t, p, g) => {
  const s1 = noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 480, Q: 2.2, dur: 0.09, gain: 0.4 * g, pitch: p * 1.6 });
  const s2 = noiseBurst(v, t + 0.14, { src: 'white', filter: 'bp', freq: 430, Q: 2.2, dur: 0.11, gain: 0.45 * g, pitch: p * 1.55 });
  return Math.max(s1, s2, blip(v, t + 0.26, { f0: 150, f1: 110, dur: 0.1, gain: 0.2 * g, pitch: p }));
}, (v, t, p, g) => {
  const squeal = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 340, f1: 520, dur: 0.18, gain: 0.5 * g, pitch: p * 1.6,
    filter: { type: 'bp', freq: 900, Q: 1.5 },
  });
  return Math.max(squeal, noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 600, Q: 2, dur: 0.1, gain: 0.35 * g, pitch: p }));
}, (v, t, p, g) => {
  const fade = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 320, f1: 120, dur: 0.6, gain: 0.55 * g, pitch: p * 1.5,
    filter: { type: 'bp', freq: 700, Q: 1.5 },
  });
  thud(v, t + 0.35, { f0: 130, f1: 70, dur: 0.2, gain: 0.4 * g, pitch: p });
  return Math.max(fade, t + 0.5);
});

// ---------------------------------------------------------------- sheep

// Wavering baa: a square-ish core whose pitch wobbles ~5 Hz — the bleat.
trio('sheep', {}, (v, t, p, g) => {
  const baa = sweep(v, t, {
    src: 'osc', wave: 'square', f0: 262, f1: 235, dur: 0.55, gain: 0.3 * g, pitch: p * 1.15,
    filter: { type: 'lp', freq: 900, Q: 0.8 },
  });
  noiseBurst(v, t, { src: 'pink', filter: 'bp', freq: 700, Q: 1, dur: 0.45, gain: 0.14 * g, pitch: p });
  return baa;
}, (v, t, p, g) => {
  const cry = sweep(v, t, {
    src: 'osc', wave: 'square', f0: 300, f1: 210, dur: 0.28, gain: 0.42 * g, pitch: p * 1.2,
    filter: { type: 'lp', freq: 1100, Q: 0.8 },
  });
  return Math.max(cry, blip(v, t, { f0: 420, f1: 300, dur: 0.1, gain: 0.2 * g, pitch: p }));
}, (v, t, p, g) => {
  const sag = sweep(v, t, {
    src: 'osc', wave: 'square', f0: 260, f1: 120, dur: 0.8, gain: 0.45 * g, pitch: p * 1.05,
    filter: { type: 'lp', freq: 800, Q: 0.8 },
  });
  thud(v, t + 0.4, { f0: 120, f1: 60, dur: 0.25, gain: 0.4 * g, pitch: p });
  return Math.max(sag, t + 0.7);
});

// ---------------------------------------------------------------- chicken

// Short bp clucks; the squawk is a fast up-down sweep, tiny and frantic.
trio('chicken', { rd: 0.8, md: 12 }, (v, t, p, g) => {
  const c1 = noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 2100, Q: 3, dur: 0.05, gain: 0.35 * g, pitch: p * 2.6 });
  const c2 = noiseBurst(v, t + 0.16, { src: 'white', filter: 'bp', freq: 1900, Q: 3, dur: 0.06, gain: 0.3 * g, pitch: p * 2.5 });
  return Math.max(c1, c2);
}, (v, t, p, g) => {
  const squawk = sweep(v, t, {
    src: 'osc', wave: 'square', f0: 900, f1: 1500, dur: 0.14, gain: 0.4 * g, pitch: p * 2.4,
    filter: { type: 'bp', freq: 2600, Q: 2 },
  });
  return Math.max(squawk, noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 2400, Q: 3, dur: 0.06, gain: 0.3 * g, pitch: p }));
}, (v, t, p, g) => {
  const droop = sweep(v, t, {
    src: 'osc', wave: 'square', f0: 1100, f1: 500, dur: 0.4, gain: 0.4 * g, pitch: p * 2.3,
    filter: { type: 'bp', freq: 2200, Q: 2 },
  });
  return Math.max(droop, t + 0.35);
});

// ---------------------------------------------------------------- villager

// The low nasal "hm": a vowel-ish core with a rising-falling contour.
trio('villager', {}, (v, t, p, g) => {
  const hm = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 95, f1: 108, dur: 0.34, gain: 0.34 * g, pitch: p,
    filter: { type: 'bp', freq: 480, Q: 2 },
  });
  return Math.max(hm, blip(v, t + 0.3, { f0: 110, f1: 92, dur: 0.12, gain: 0.2 * g, pitch: p }));
}, (v, t, p, g) => {
  const ouch = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 120, f1: 88, dur: 0.22, gain: 0.45 * g, pitch: p * 1.12,
    filter: { type: 'bp', freq: 560, Q: 2 },
  });
  return Math.max(ouch, thud(v, t, { f0: 130, f1: 80, dur: 0.1, gain: 0.25 * g, pitch: p }));
}, (v, t, p, g) => {
  const last = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 105, f1: 62, dur: 0.7, gain: 0.5 * g, pitch: p * 0.95,
    filter: { type: 'bp', freq: 500, Q: 2 },
  });
  thud(v, t + 0.4, { f0: 120, f1: 60, dur: 0.25, gain: 0.35 * g, pitch: p });
  return Math.max(last, t + 0.6);
});

// ---------------------------------------------------------------- iron golem

// Cracking stone with a single metal tick; hurt lands a heavy clang-thud.
trio('iron_golem', { rd: 1.5, md: 24 }, (v, t, p, g) => {
  const creak = sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 70, f1: 55, dur: 0.5, gain: 0.35 * g, pitch: p * 0.85,
    filter: { type: 'bp', freq: 220, Q: 3 },
  });
  return Math.max(creak, crackle(v, t + 0.2, { density: 0.6, freq: 1600, dur: 0.2, gain: 0.18 * g, pitch: p }));
}, (v, t, p, g) => {
  const clang = thud(v, t, { f0: 210, f1: 90, dur: 0.22, noiseGain: 0.5, gain: 0.6 * g, pitch: p });
  const tick = chime(v, t + 0.04, { freq: 1400, ratio: 2.76, index: 3, dur: 0.18, gain: 0.2 * g, pitch: p });
  return Math.max(clang, tick);
}, (v, t, p, g) => {
  const collapse = thud(v, t, { f0: 90, f1: 30, dur: 0.7, noiseGain: 0.8, gain: 0.65 * g, pitch: p * 0.9 });
  crackle(v, t, { density: 1, freq: 900, dur: 0.5, gain: 0.3 * g, pitch: p });
  return Math.max(collapse, chime(v, t + 0.1, { freq: 900, ratio: 2.76, index: 3, dur: 0.4, gain: 0.2 * g, pitch: p }));
});

// ---------------------------------------------------------------- fishing (B4)

// Rod cast: a short forward swish with the line's tick behind it.
def('item.fishing.cast', {
  bus: 'sfx', maxDist: 10, cap: 2, capKey: 'fishing_cast', priority: P.PLAYER, replicate: false,
  recipe: (v, t, p, g) => {
    const swish = whoosh(v, t, { f0: 900, f1: 2600, dur: 0.16, gain: 0.3 * g, pitch: p, Q: 1.5 });
    return Math.max(swish, blip(v, t + 0.1, { f0: 1800, f1: 1400, dur: 0.04, gain: 0.15 * g, pitch: p }));
  },
});

// The tug: a small plop and a quick tick — the bite tell.
def('item.fishing.bite', {
  bus: 'sfx', maxDist: 12, cap: 2, capKey: 'fishing_bite', priority: P.PLAYER, replicate: false,
  recipe: (v, t, p, g) => {
    const plop = blip(v, t, { f0: 520, f1: 220, dur: 0.07, gain: 0.35 * g, pitch: p });
    return Math.max(plop, blip(v, t + 0.05, { f0: 2200, f1: 1800, dur: 0.03, gain: 0.2 * g, pitch: p }));
  },
});

// Reel ratchet: three rapid dry clicks.
def('item.fishing.reel', {
  bus: 'sfx', maxDist: 8, cap: 2, capKey: 'fishing_reel', priority: P.PLAYER, replicate: false,
  recipe: (v, t, p, g) => {
    const k1 = blip(v, t, { f0: 1600, f1: 1300, dur: 0.03, gain: 0.16 * g, pitch: p });
    const k2 = blip(v, t + 0.055, { f0: 1600, f1: 1300, dur: 0.03, gain: 0.16 * g, pitch: p });
    const k3 = blip(v, t + 0.11, { f0: 1600, f1: 1300, dur: 0.03, gain: 0.16 * g, pitch: p });
    return Math.max(k1, k2, k3);
  },
});

// Water entry: a lp noise sweep into a gulp — the bobber landing.
def('item.fishing.splash', {
  bus: 'sfx', maxDist: 16, cap: 2, capKey: 'fishing_splash', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    const wash = noiseBurst(v, t, { src: 'white', filter: 'lp', freq: 1500, Q: 0.6, dur: 0.22, gain: 0.4 * g, pitch: p });
    return Math.max(wash, gulp(v, t + 0.08, { dur: 0.12, wobble: [420, 180, 260], gain: 0.3 * g, pitch: p }));
  },
});