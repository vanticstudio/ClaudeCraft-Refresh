// Sound event registry (16 §3) — the master table. Siblings (07-15) own trigger
// conditions; this file owns every recipe, bus, and distance parameter.
//
// Entry schema (§3): { recipe, bus, refDist, maxDist, cap, capKey, priority,
// jitter, replicate, loop, muffle }. Defaults when a column is blank: bus 'sfx',
// refDist 1, maxDist 16, cap 2, jitter on, replicate = positional.
import {
  BUFFERS, noiseBurst, thud, pluck, blip, sweep, crackle, chime, hiss, gulp, whoosh,
} from './primitives.js';

export const P = { FAR: 0, NEAR: 1, PLAYER: 2, UI: 3 };

export const EVENTS = Object.create(null);

function def(id, o) { EVENTS[id] = o; return o; }

// ---------------------------------------------------------------- §3.1/§3.2 block verbs

// Class core recipes. Each is core(voice, t0, pitch, gain, dur) — the step/dig
// duration is passed in by the verb generator (dig = step x1.6 per §3.2).
const CORES = {
  stone: (v, t, p, g, d) => noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 900, Q: 1.2, dur: d, gain: g, pitch: p }),
  ore: (v, t, p, g, d) => CORES.stone(v, t, p, g, d),
  metal: (v, t, p, g, d) => noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 1200, Q: 4, dur: d, gain: g, pitch: p }),
  wood: (v, t, p, g, d) => noiseBurst(v, t, { src: 'pink', filter: 'lp', freq: 700, Q: 0.7, dur: d, gain: g, pitch: p }),
  gravel: (v, t, p, g, d) => noiseBurst(v, t, { src: 'white', filter: 'lp', freq: 1400, Q: 0.5, dur: d, gain: g, pitch: p }),
  sand: (v, t, p, g, d) => noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 2200, Q: 0.6, dur: d, gain: g, pitch: p }),
  // grass carries extra pitch jitter +/-15% on top of §2.2's global variation
  grass: (v, t, p, g, d) => noiseBurst(v, t, {
    src: 'pink', filter: 'lp', freq: 1000, Q: 0.5, dur: d, gain: g,
    pitch: p * Math.pow(2, Math.random() * 0.3 - 0.15),
  }),
  glass: (v, t, p, g, d) => noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 2800, Q: 2, dur: d, gain: g, pitch: p }),
  wool: (v, t, p, g, d) => noiseBurst(v, t, { src: 'pink', filter: 'lp', freq: 400, Q: 0.5, dur: d, gain: g * 0.7, pitch: p }),
  // snow: two stacked bursts 25 ms apart
  snow: (v, t, p, g, d) => {
    noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 500, Q: 0.5, dur: d, gain: g, pitch: p });
    return noiseBurst(v, t + 0.025, { src: 'white', filter: 'bp', freq: 500, Q: 0.5, dur: d, gain: g * 0.8, pitch: p });
  },
  // §3.1 reserved: 10's blocks default nether, 11's default end
  nether: (v, t, p, g, d) => {
    CORES.gravel(v, t, p * 0.84, g, d);
    return hiss(v, t, { freq: 3000, Q: 1, dur: d, gain: g * 0.25, pitch: p });
  },
  end: (v, t, p, g, d) => {
    CORES.stone(v, t, p * 1.12, g, d);
    noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 620, Q: 3, dur: d, gain: g * 0.5, pitch: p * 1.12 });
    return chime(v, t, { freq: 2400, ratio: 3.53, index: 3, dur: 0.2, gain: g * 0.1, pitch: p });
  },
};

// Break layers (§3.2 table) — added on top of the dig recipe at pitch x0.9.
const BREAK_LAYERS = {
  stone: (v, t, p, g) => thud(v, t, { f0: 220, f1: 90, dur: 0.08, gain: g * 0.5, pitch: p }),
  ore: (v, t, p, g) => {
    BREAK_LAYERS.stone(v, t, p, g);
    return chime(v, t, { freq: 2700, ratio: 3.53, index: 3, dur: 0.15, gain: g * 0.12, pitch: p });  // the glint
  },
  metal: (v, t, p, g) => chime(v, t, { freq: 2400, ratio: 2.76, index: 3, dur: 0.3, gain: g * 0.4, pitch: p }),
  wood: (v, t, p, g) => thud(v, t, { f0: 160, f1: 70, dur: 0.1, gain: g * 0.6, pitch: p }),
  gravel: (v, t, p, g) => crackle(v, t, { density: 1.4, freq: 1100, dur: 0.12, gain: g * 0.4, pitch: p }),
  sand: (v, t, p, g) => noiseBurst(v, t + 0.02, { src: 'white', filter: 'bp', freq: 2200, Q: 0.6, dur: 0.09, gain: g * 0.5, pitch: p }),
  grass: (v, t, p, g) => gulp(v, t, { dur: 0.08, wobble: [500, 300, 380], gain: g * 0.3, pitch: p }),
  glass: (v, t, p, g) => {                       // shatter cluster
    chime(v, t, { freq: 1800, ratio: 3.98, index: 3, dur: 0.35, gain: g * 0.35, pitch: p });
    chime(v, t + 0.01, { freq: 2390, ratio: 3.98, index: 3, dur: 0.35, gain: g * 0.35, pitch: p });
    return chime(v, t + 0.02, { freq: 3170, ratio: 3.98, index: 3, dur: 0.35, gain: g * 0.35, pitch: p });
  },
  wool: null,                                    // muffled thump only (§3.2)
  snow: (v, t, p, g) => {                        // crunch = 3 stacked bursts
    noiseBurst(v, t + 0.05, { src: 'white', filter: 'bp', freq: 500, Q: 0.5, dur: 0.09, gain: g * 0.7, pitch: p });
    return noiseBurst(v, t + 0.075, { src: 'white', filter: 'bp', freq: 500, Q: 0.5, dur: 0.09, gain: g * 0.6, pitch: p });
  },
  nether: (v, t, p, g) => BREAK_LAYERS.gravel(v, t, p, g),   // inherit source class layer
  end: (v, t, p, g) => BREAK_LAYERS.stone(v, t, p, g),
};

// §3.2 step durations
const STEP_DUR = {
  stone: 0.070, ore: 0.070, metal: 0.060, wood: 0.080, gravel: 0.090, sand: 0.090,
  grass: 0.065, glass: 0.055, wool: 0.090, snow: 0.090, nether: 0.085, end: 0.070,
};

export const MAT_CLASSES = Object.keys(STEP_DUR);

// Generate the four verb families per class (§3.2 verb rules table).
for (const cls of MAT_CLASSES) {
  const core = CORES[cls], layer = BREAK_LAYERS[cls], sd = STEP_DUR[cls];

  def(`block.step.${cls}`, {
    recipe: (v, t, p, g) => core(v, t, p, 0.35 * g, sd),
    bus: 'sfx', maxDist: 12, cap: 2, capKey: 'step', priority: P.NEAR, replicate: true,
  });
  // §3.2 mob footsteps: same cores, but their own cap family (4, not 2) and a
  // quieter 0.3 — a crowd of mobs must not starve the player's own steps.
  def(`mob.step.${cls}`, {
    recipe: (v, t, p, g) => core(v, t, p, 0.3 * g, sd),
    bus: 'sfx', maxDist: 12, cap: 4, capKey: 'mobStep', priority: P.NEAR, replicate: true,
  });
  def(`block.dig.${cls}`, {
    recipe: (v, t, p, g) => core(v, t, p, 0.5 * g, sd * 1.6),
    bus: 'sfx', maxDist: 14, cap: 1, capKey: 'dig', priority: P.NEAR, replicate: true,
  });
  def(`block.break.${cls}`, {
    recipe: (v, t, p, g) => {
      const r = core(v, t, p * 0.9, 0.8 * g, sd * 1.6);
      return layer ? Math.max(r, layer(v, t, p * 0.9, 0.8 * g)) : r;
    },
    bus: 'sfx', maxDist: 16, cap: 2, capKey: 'break', priority: P.NEAR, replicate: true,
  });
  def(`block.place.${cls}`, {
    recipe: (v, t, p, g) => core(v, t, p * 0.8, 0.7 * g, sd * 1.6),
    bus: 'sfx', maxDist: 16, cap: 2, capKey: 'place', priority: P.NEAR, replicate: true,
  });
}

// ---------------------------------------------------------------- §3.3 player events

const SELF = { bus: 'sfx', priority: P.PLAYER, replicate: false };
const UI = { bus: 'ui', priority: P.UI, jitter: 0, cap: 4, capKey: 'ui', replicate: false };

def('player.hurt', {
  ...SELF, cap: 2, capKey: 'playerHurt',
  recipe: (v, t, p, g) => {
    sweep(v, t, { src: 'osc', wave: 'triangle', f0: 200, f1: 140, dur: 0.15, gain: 0.8 * g, pitch: p });
    return noiseBurst(v, t, { src: 'white', filter: 'lp', freq: 800, Q: 1, dur: 0.1, gain: 0.5 * g, pitch: p });
  },
});
def('player.hurt.fire', {
  ...SELF, cap: 2, capKey: 'playerHurt',
  recipe: (v, t, p, g) => {
    EVENTS['player.hurt'].recipe(v, t, p, g);
    return hiss(v, t, { freq: 4000, dur: 0.2, gain: 0.3 * g, pitch: p });
  },
});
def('player.hurt.drown', {
  ...SELF, cap: 2, capKey: 'playerHurt',
  recipe: (v, t, p, g) => {
    EVENTS['player.hurt'].recipe(v, t, p, g);
    gulp(v, t, { dur: 0.1, gain: 0.4 * g, pitch: p });
    return gulp(v, t + 0.12, { dur: 0.1, gain: 0.4 * g, pitch: p * 1.1 });
  },
});
def('player.death', {
  ...SELF, cap: 1, capKey: 'playerDeath',
  recipe: (v, t, p, g) => {
    sweep(v, t, { src: 'osc', wave: 'sawtooth', f0: 300, f1: 60, dur: 0.6, gain: 0.9 * g, pitch: p, filter: { type: 'lp', freq: 900, Q: 1 } });
    return thud(v, t, { f0: 120, f1: 45, dur: 0.3, gain: 0.9 * g, pitch: p });
  },
});
def('player.fall.small', {
  ...SELF, capKey: 'fall',
  recipe: (v, t, p, g) => thud(v, t, { f0: 160, f1: 80, dur: 0.1, gain: 0.5 * g, pitch: p }),
});
def('player.fall.big', {
  ...SELF, capKey: 'fall',
  // gain 0.6 + 0.1 x min(damage,10) arrives via gainMult from the hook site
  recipe: (v, t, p, g) => thud(v, t, { f0: 140, f1: 40, dur: 0.25, noiseGain: 0.7, gain: 0.6 * g, pitch: p }),
});
def('player.eat.chew', {
  ...SELF, capKey: 'eat',
  recipe: (v, t, p, g) => gulp(v, t, { dur: 0.09, wobble: [420, 280, 360], gain: 0.5 * g, pitch: p }),
});
def('player.eat.swallow', {
  ...SELF, capKey: 'eat',
  recipe: (v, t, p, g) => {
    gulp(v, t, { dur: 0.18, wobble: [300, 140, 90], gain: 0.6 * g, pitch: p });
    return blip(v, t + 0.1, { wave: 'triangle', freq: 180, dur: 0.06, gain: 0.6 * g, pitch: p });
  },
});
def('player.eat.burp', {
  ...SELF, capKey: 'eat',
  recipe: (v, t, p, g) => sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: 85, f1: 50, dur: 0.3, gain: 0.5 * g, pitch: p,
    filter: { type: 'lp', freq: 400, Q: 1 },
  }),
});
def('player.drink.gulp', {
  ...SELF, capKey: 'eat',
  recipe: (v, t, p, g) => gulp(v, t, { dur: 0.12, wobble: [350, 220, 300], gain: 0.5 * g, pitch: p }),
});
def('player.xp_pickup', {
  ...UI, cap: 3, capKey: 'xp',
  // pitch = 520 x 2^(min(orbStreak,24)/12) arrives as pitchMult from the hook
  recipe: (v, t, p, g) => pluck(v, t, { freq: 520 * p, dur: 0.09, gain: 0.4 * g }),
});
def('player.levelup', {
  ...UI, cap: 2, capKey: 'levelup', jitter: 0,
  recipe: (v, t, p, g) => {
    chime(v, t, { freq: 660, ratio: 2.0, index: 3, dur: 0.5, gain: 0.5 * g, pitch: p });
    chime(v, t + 0.12, { freq: 990, ratio: 2.0, index: 3, dur: 0.5, gain: 0.5 * g, pitch: p });
    return chime(v, t + 0.24, { freq: 1320, ratio: 2.0, index: 3, dur: 0.5, gain: 0.5 * g, pitch: p });
  },
});
def('player.item_pickup', {
  ...UI, cap: 3, capKey: 'pickup', jitter: 1,
  recipe: (v, t, p, g) => {
    pluck(v, t, { freq: 1300, dur: 0.07, gain: 0.35 * g, pitch: p });
    return blip(v, t, { wave: 'triangle', freq: 900, dur: 0.04, gain: 0.35 * g, pitch: p });
  },
});
def('player.item_break', {
  ...SELF, capKey: 'itemBreak',
  recipe: (v, t, p, g) => {
    BREAK_LAYERS.metal(v, t, p, 0.5 * g);
    return whoosh(v, t, { f0: 1200, f1: 300, dur: 0.15, gain: 0.3 * g, pitch: p });
  },
});
// 08 §12 hook `player.attack.sweep` (vanilla entity.player.attack.sweep): a
// broad falling swoosh — the blade's arc — with a thin band of noise across it
// for the edge. Self event, so it plays flat rather than positionally.
def('player.attack.sweep', {
  ...SELF, capKey: 'attackSweep',
  recipe: (v, t, p, g) => {
    whoosh(v, t, { f0: 2600, f1: 700, dur: 0.22, gain: 0.45 * g, pitch: p });
    return noiseBurst(v, t, {
      src: 'white', filter: 'bp', freq: 1800, Q: 1.5, dur: 0.12, gain: 0.22 * g, pitch: p,
    });
  },
});
def('player.armor_equip', {
  ...UI, capKey: 'armor', jitter: 1,
  recipe: (v, t, p, g) => chime(v, t, { freq: 2400, ratio: 2.76, index: 3, dur: 0.15, gain: 0.3 * g, pitch: p }),
});
def('player.armor_equip.leather', {
  ...UI, capKey: 'armor', jitter: 1,
  recipe: (v, t, p, g) => CORES.wool(v, t, p, 0.35 * g, STEP_DUR.wool * 1.2),
});
def('player.splash', {
  ...SELF, capKey: 'splash',
  recipe: (v, t, p, g) => {
    sweep(v, t, { src: 'noise', f0: 1500, f1: 600, dur: 0.25, gain: g, pitch: p, filter: { Q: 1 } });
    gulp(v, t, { dur: 0.1, gain: 0.5 * g, pitch: p });
    return gulp(v, t + 0.08, { dur: 0.1, gain: 0.4 * g, pitch: p * 0.9 });
  },
});
def('item.bucket.fill', {
  bus: 'sfx', maxDist: 16, capKey: 'bucket', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    gulp(v, t, { dur: 0.1, gain: 0.5 * g, pitch: p });
    gulp(v, t + 0.1, { dur: 0.1, gain: 0.5 * g, pitch: p * 0.95 });
    return EVENTS['player.splash'].recipe(v, t, p, 0.4 * g);
  },
});
def('item.bucket.fill.lava', {
  bus: 'sfx', maxDist: 16, capKey: 'bucket', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    gulp(v, t, { dur: 0.1 / 0.6, gain: 0.5 * g, pitch: p * 0.6 });
    gulp(v, t + 0.15, { dur: 0.1 / 0.6, gain: 0.5 * g, pitch: p * 0.57 });
    return crackle(v, t, { density: 1, freq: 1200, dur: 0.3, gain: 0.2 * g, pitch: p });
  },
});
def('item.bucket.pour', {
  bus: 'sfx', maxDist: 16, capKey: 'bucket', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    EVENTS['player.splash'].recipe(v, t, p, g);
    return hiss(v, t, { freq: 2000, dur: 0.3, gain: 0.35 * g, pitch: p });
  },
});
def('item.bow.draw', {
  ...SELF, loop: true, cap: 1, capKey: 'bowDraw',
  recipe: (v, t, p, g) => crackle(v, t, { density: 0.6, freq: 350, Q: 1.5, gain: 0.25 * g, pitch: p, loop: true }),
});
def('item.bow.shoot', {
  bus: 'sfx', maxDist: 24, capKey: 'bowShoot', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    pluck(v, t, { freq: 140, bass: true, dur: 0.25, gain: 0.4 * g, pitch: p });
    return whoosh(v, t, { f0: 900, f1: 2200, dur: 0.18, gain: 0.4 * g, pitch: p });
  },
});
// §3.3's recipe is "thud + the STRUCK BLOCK's step recipe at 0.5". emitSound has
// no channel to carry the block class, so this id is the thud layer only and the
// hook site emits `block.step.<class>` alongside it at gain 0.5 — same two layers,
// same instant, and the class comes from the block actually hit.
def('entity.arrow.hit_block', {
  bus: 'sfx', maxDist: 16, capKey: 'arrowHit', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => thud(v, t, { f0: 300, f1: 150, dur: 0.06, gain: 0.4 * g, pitch: p }),
});
def('entity.arrow.hit_mob', {
  bus: 'sfx', maxDist: 16, capKey: 'arrowHit', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => thud(v, t, { f0: 220, f1: 110, dur: 0.08, noiseGain: 0.8, gain: 0.5 * g, pitch: p }),
});

// §3.3 gives `block.door` one id with open/close variants, but §5.1's signature
// has no param channel — split into two ids (see DEVIATIONS).
def('block.door.open', {
  bus: 'sfx', maxDist: 16, capKey: 'door', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    pluck(v, t, { freq: 90, bass: true, dur: 0.15, gain: 0.5 * g, pitch: p });
    return sweep(v, t, { src: 'osc', wave: 'triangle', f0: 380, f1: 640, dur: 0.18, gain: 0.5 * g, pitch: p });
  },
});
def('block.door.close', {
  bus: 'sfx', maxDist: 16, capKey: 'door', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    pluck(v, t, { freq: 90, bass: true, dur: 0.15, gain: 0.5 * g, pitch: p });
    return sweep(v, t, { src: 'osc', wave: 'triangle', f0: 640, f1: 380, dur: 0.18, gain: 0.5 * g, pitch: p });
  },
});
def('block.chest.open', {
  bus: 'sfx', maxDist: 16, capKey: 'chest', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    sweep(v, t, { src: 'osc', wave: 'sawtooth', f0: 240, f1: 170, dur: 0.3, gain: 0.5 * g, pitch: p, filter: { type: 'lp', freq: 600, Q: 1 } });
    return CORES.wood(v, t, p, 0.4 * 0.35 * g, STEP_DUR.wood);
  },
});
def('block.chest.close', {
  bus: 'sfx', maxDist: 16, capKey: 'chest', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    thud(v, t, { f0: 180, f1: 80, dur: 0.12, gain: 0.5 * g, pitch: p });
    return CORES.wood(v, t, p, 0.4 * 0.35 * g, STEP_DUR.wood);
  },
});
def('block.extinguish', {
  bus: 'sfx', maxDist: 16, capKey: 'extinguish', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    hiss(v, t, { freq: 3000, dur: 0.25, gain: 0.5 * g, pitch: p });
    return gulp(v, t, { dur: 0.12, gain: 0.3 * g, pitch: p });
  },
});
def('ui.click', {
  ...UI,
  recipe: (v, t, p, g) => blip(v, t, { wave: 'square', freq: 800, dur: 0.03, gain: 0.25 * g }),
});
def('ui.hotbar', {
  ...UI, cap: 2, capKey: 'hotbar',
  recipe: (v, t, p, g) => blip(v, t, { wave: 'square', freq: 1200, dur: 0.02, gain: 0.2 * g }),
});

// AMENDS 16 §3 by 18-CREATIVE §8 — the mode's only two new events. Every other
// creative interaction reuses the events above (block.break/place, ui.click).

// 18 §8: "short two-note rising (creative) / falling (survival) blip". §5.1's
// signature has no channel for direction, so the caller passes pitchMult 1 for
// creative and 0.5 for survival and the recipe reads it — same trick §3.3's
// `player.fall.big` uses to carry damage.
def('ui.gamemode.switch', {
  ...UI, cap: 1, capKey: 'gamemode',
  recipe: (v, t, p, g) => {
    const rising = p >= 0.75;
    const [f0, f1] = rising ? [660, 990] : [990, 660];
    blip(v, t, { wave: 'triangle', freq: f0, dur: 0.06, gain: 0.3 * g });
    return blip(v, t + 0.07, { wave: 'triangle', freq: f1, dur: 0.08, gain: 0.3 * g });
  },
});

// 18 §8: "brief downward noise 'poof'". §2.7's noise sweep is exactly this
// shape — noiseBurst has a fixed filter frequency and cannot fall.
def('ui.item.destroy', {
  ...UI, cap: 2, capKey: 'destroy',
  recipe: (v, t, p, g) => sweep(v, t, {
    src: 'noise', f0: 1400, f1: 180, dur: 0.16, gain: 0.25 * g, pitch: p,
    filter: { Q: 0.8 },
  }),
});

// ---------------------------------------------------------------- §3.4 mob voices

// Each mob's idle timbre. Shape s = { dur, fall } lets the generic derivation
// rule (§3.4) reshape it into hurt/death without a second hand-written recipe.
const MOB_IDLE = {
  zombie: (v, t, p, g, s) => {
    const d = 0.6 * s.dur;
    const osc = v.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(82 * p, t);
    if (s.fall) osc.frequency.linearRampToValueAtTime(82 * p * (1 - s.fall), t + d);
    const wob = v.ctx.createOscillator();
    wob.type = 'sine'; wob.frequency.value = 5;
    const wobAmt = v.ctx.createGain(); wobAmt.gain.value = 7 * p;
    wob.connect(wobAmt); wobAmt.connect(osc.frequency);
    const lp = v.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 500 * p;
    const eg = v.ctx.createGain();
    eg.gain.setValueAtTime(0, t);
    eg.gain.linearRampToValueAtTime(g, t + d * 0.25);          // swell
    eg.gain.exponentialRampToValueAtTime(Math.max(1e-4, g * 0.001), t + d);
    osc.connect(lp); lp.connect(eg); eg.connect(v.envGain);
    osc.start(t); osc.stop(t + d + 0.02);
    wob.start(t); wob.stop(t + d + 0.02);
    v.nodes.push(osc, wob);
    noiseBurst(v, t, { src: 'pink', filter: 'bp', freq: 250, Q: 1, dur: d, gain: g * 0.3, pitch: p });
    return t + d + 0.03;
  },
  skeleton: (v, t, p, g, s) => {                 // bone rattle
    let last = t;
    const n = s.fall ? 8 : 5;
    for (let i = 0; i < n; i++) {
      const k = i / Math.max(1, n - 1);
      const freq = s.fall ? 2400 - 1500 * k : 2400;             // death: descending
      last = noiseBurst(v, t + i * (s.fall ? 0.8 / n : 0.022), {
        src: 'white', filter: 'bp', freq, Q: 8, dur: 0.025 * s.dur, gain: 0.5 * g, pitch: p,
      });
    }
    return last;
  },
  spider: (v, t, p, g, s) => {                   // chitter
    let last = t, at = t;
    for (let i = 0; i < 10; i++) {
      last = noiseBurst(v, at, {
        src: 'white', filter: 'bp', freq: 3000, Q: 6, dur: 0.015 * s.dur, gain: 0.4 * g,
        pitch: p * Math.pow(2, Math.random() * 0.4 - 0.2),      // +/-20% extra jitter
      });
      at += 0.03 + Math.random() * 0.03;
    }
    return last;
  },
  enderman: (v, t, p, g, s) => {                 // FM warble, alien throb
    const d = 1.2 * s.dur;
    const carrier = v.ctx.createOscillator();
    carrier.type = 'sine'; carrier.frequency.setValueAtTime(110 * p, t);
    if (s.fall) carrier.frequency.linearRampToValueAtTime(110 * p * (1 - s.fall), t + d);
    const mod = v.ctx.createOscillator();
    mod.type = 'sine'; mod.frequency.value = 13;
    const modGain = v.ctx.createGain();
    modGain.gain.setValueAtTime(110 * p * 25, t);               // index 25 -> 5
    modGain.gain.exponentialRampToValueAtTime(110 * p * 5, t + d);
    mod.connect(modGain); modGain.connect(carrier.frequency);
    const lp = v.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 800 * p;
    const eg = v.ctx.createGain();
    eg.gain.setValueAtTime(0, t);
    eg.gain.linearRampToValueAtTime(0.6 * g, t + 0.05);
    eg.gain.exponentialRampToValueAtTime(Math.max(1e-4, g * 0.0006), t + d);
    carrier.connect(lp); lp.connect(eg); eg.connect(v.envGain);
    carrier.start(t); carrier.stop(t + d + 0.02);
    mod.start(t); mod.stop(t + d + 0.02);
    v.nodes.push(carrier, mod);
    return t + d + 0.03;
  },
  cow: (v, t, p, g, s) => {                      // formant blend, synthetic bovine vowel
    const d = 0.8 * s.dur;
    const osc = v.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(88 * p, t);
    osc.frequency.linearRampToValueAtTime(62 * p * (1 - (s.fall || 0)), t + d);
    const eg = v.ctx.createGain();
    eg.gain.setValueAtTime(0, t);
    eg.gain.linearRampToValueAtTime(g, t + d * 0.2);
    eg.gain.exponentialRampToValueAtTime(Math.max(1e-4, g * 0.001), t + d);
    for (const [f, q, mix] of [[320, 5, 1], [700, 6, 0.6]]) {   // F1 / F2, mixed 1:0.6
      const bp = v.ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = f * p; bp.Q.value = q;
      const mg = v.ctx.createGain(); mg.gain.value = mix;
      osc.connect(bp); bp.connect(mg); mg.connect(eg);
    }
    eg.connect(v.envGain);
    osc.start(t); osc.stop(t + d + 0.02);
    v.nodes.push(osc);
    return t + d + 0.03;
  },
  pig: (v, t, p, g, s) => {                      // double chirp, nasal
    const one = (at) => {
      const osc = v.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(240 * p, at);
      osc.frequency.exponentialRampToValueAtTime(170 * p * (1 - (s.fall || 0)), at + 0.14 * s.dur);
      const bp = v.ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 900 * p; bp.Q.value = 4;
      const eg = v.ctx.createGain();
      eg.gain.setValueAtTime(0, at);
      eg.gain.linearRampToValueAtTime(0.6 * g, at + 0.01);
      eg.gain.exponentialRampToValueAtTime(Math.max(1e-4, g * 0.0006), at + 0.14 * s.dur);
      osc.connect(bp); bp.connect(eg); eg.connect(v.envGain);
      osc.start(at); osc.stop(at + 0.16 * s.dur);
      v.nodes.push(osc);
    };
    one(t); one(t + 0.18);
    return t + 0.18 + 0.16 * s.dur + 0.02;
  },
  sheep: (v, t, p, g, s) => {                    // bleat stutter (8 Hz square AM)
    const d = 0.7 * s.dur;
    const osc = v.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(175 * p, t);
    if (s.fall) osc.frequency.linearRampToValueAtTime(175 * p * (1 - s.fall), t + d);
    const am = v.ctx.createOscillator();
    am.type = 'square'; am.frequency.value = 8;
    const amG = v.ctx.createGain(); amG.gain.value = 0.4;       // depth 0.8 around 0.5
    const bp = v.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1100 * p; bp.Q.value = 2;
    const eg = v.ctx.createGain();
    eg.gain.setValueAtTime(0, t);
    eg.gain.linearRampToValueAtTime(g * 0.5, t + 0.03);
    eg.gain.exponentialRampToValueAtTime(Math.max(1e-4, g * 0.0005), t + d);
    am.connect(amG); amG.connect(eg.gain);
    osc.connect(bp); bp.connect(eg); eg.connect(v.envGain);
    osc.start(t); osc.stop(t + d + 0.02);
    am.start(t); am.stop(t + d + 0.02);
    v.nodes.push(osc, am);
    return t + d + 0.03;
  },
  chicken: (v, t, p, g, s) => {                  // 3-4 clucks
    let at = t, last = t;
    const n = 3 + (Math.random() < 0.5 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const osc = v.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(750 * p, at);
      osc.frequency.exponentialRampToValueAtTime(520 * p * (1 - (s.fall || 0)), at + 0.09 * s.dur);
      const eg = v.ctx.createGain();
      eg.gain.setValueAtTime(0, at);
      eg.gain.linearRampToValueAtTime(0.45 * g, at + 0.005);
      eg.gain.exponentialRampToValueAtTime(Math.max(1e-4, g * 0.0005), at + 0.09 * s.dur);
      osc.connect(eg); eg.connect(v.envGain);
      osc.start(at); osc.stop(at + 0.1 * s.dur);
      v.nodes.push(osc);
      last = at + 0.1 * s.dur;
      at += 0.12 + Math.random() * 0.08;
    }
    return last + 0.02;
  },
  // Creeper has NO idle (§3.4) but CAN be killed by a sword, so hurt/death still
  // need a timbre — derived from its fuse hiss (see DEVIATIONS).
  creeper: (v, t, p, g, s) => {
    const d = 0.5 * s.dur;
    hiss(v, t, { freq: 5000, Q: 1, dur: d, gain: 0.6 * g, pitch: p });
    return sweep(v, t, { src: 'noise', f0: 700 * (s.fall ? 1 - s.fall : 1), f1: 2600, dur: d, gain: 0.4 * g, pitch: p, filter: { Q: 2 } });
  },
  villager: (v, t, p, g, s) => {                 // "hrmm" formant sweep
    const d = 0.4 * s.dur;
    const osc = v.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(165 * p, t);
    if (s.fall) osc.frequency.linearRampToValueAtTime(165 * p * (1 - s.fall), t + d);
    const bp = v.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 4;
    bp.frequency.setValueAtTime(500 * p, t);
    bp.frequency.linearRampToValueAtTime(900 * p, t + d * 0.5);
    bp.frequency.linearRampToValueAtTime(600 * p, t + d);
    const eg = v.ctx.createGain();
    eg.gain.setValueAtTime(0, t);
    eg.gain.linearRampToValueAtTime(0.6 * g, t + 0.02);
    eg.gain.exponentialRampToValueAtTime(Math.max(1e-4, g * 0.0006), t + d);
    osc.connect(bp); bp.connect(eg); eg.connect(v.envGain);
    osc.start(t); osc.stop(t + d + 0.02);
    v.nodes.push(osc);
    return t + d + 0.03;
  },
  iron_golem: (v, t, p, g, s) => {
    BREAK_LAYERS.metal(v, t, p, g * 1.4);
    return thud(v, t, { f0: 90, f1: 40, dur: 0.2 * s.dur, gain: g, pitch: p });
  },
  ghast: (v, t, p, g, s) => {                    // FM wail
    const d = 1.8 * s.dur;
    const carrier = v.ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.setValueAtTime(700 * p, t);
    carrier.frequency.linearRampToValueAtTime(880 * p, t + d * 0.4);
    carrier.frequency.linearRampToValueAtTime(460 * p * (1 - (s.fall || 0)), t + d);
    const mod = v.ctx.createOscillator();
    mod.type = 'sine'; mod.frequency.value = 700 * p * 1.5;     // ratio 1.5
    const modGain = v.ctx.createGain(); modGain.gain.value = 700 * p * 2;   // index 2
    mod.connect(modGain); modGain.connect(carrier.frequency);
    const eg = v.ctx.createGain();
    eg.gain.setValueAtTime(0, t);
    eg.gain.linearRampToValueAtTime(0.7 * g, t + d * 0.15);
    eg.gain.exponentialRampToValueAtTime(Math.max(1e-4, g * 0.0007), t + d);
    carrier.connect(eg); eg.connect(v.envGain);
    carrier.start(t); carrier.stop(t + d + 0.02);
    mod.start(t); mod.stop(t + d + 0.02);
    v.nodes.push(carrier, mod);
    return t + d + 0.03;
  },
  blaze: (v, t, p, g, s) => {
    crackle(v, t, { density: 1.6, freq: 2000, dur: 0.6 * s.dur, gain: 0.5 * g, pitch: p });
    return hiss(v, t, { freq: 4000, dur: 0.6 * s.dur, gain: 0.3 * g, pitch: p });
  },
  magma_cube: (v, t, p, g, s) => {
    thud(v, t, { f0: 90, f1: 38, dur: 0.2 * s.dur, gain: g, pitch: p });
    return gulp(v, t, { dur: 0.15 * s.dur, wobble: [200, 90, 140], gain: 0.6 * g, pitch: p });
  },
  wither_skeleton: (v, t, p, g, s) => {
    let last = t;
    const n = s.fall ? 8 : 5;
    for (let i = 0; i < n; i++) {
      last = noiseBurst(v, t + i * 0.022, {
        src: 'white', filter: 'bp', freq: 1600, Q: 8, dur: 0.025 * s.dur, gain: 0.6 * g, pitch: p * 0.75,
      });
    }
    return last;
  },
  shulker: (v, t, p, g, s) => {
    blip(v, t, { wave: 'triangle', freq: 300, f1: 520, dur: 0.12 * s.dur, gain: 0.5 * g, pitch: p });
    return noiseBurst(v, t, { src: 'white', filter: 'lp', freq: 900, Q: 1, dur: 0.1 * s.dur, gain: 0.4 * g, pitch: p });
  },
  dragon: (v, t, p, g, s) => {                   // roar
    const d = 2.5 * s.dur;
    const eg = v.ctx.createGain();
    eg.gain.setValueAtTime(0, t);
    eg.gain.linearRampToValueAtTime(g, t + d * 0.2);
    eg.gain.exponentialRampToValueAtTime(Math.max(1e-4, g * 0.0005), t + d);
    const lp = v.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900 * p;
    for (const f of [55, 56.5]) {
      const osc = v.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f * p, t);
      if (s.fall) osc.frequency.linearRampToValueAtTime(f * p * (1 - s.fall), t + d);
      osc.connect(lp);
      osc.start(t); osc.stop(t + d + 0.02);
      v.nodes.push(osc);
    }
    const am = v.ctx.createOscillator();
    am.type = 'sine'; am.frequency.value = 3;
    const amG = v.ctx.createGain(); amG.gain.value = 0.3 * g;
    am.connect(amG); amG.connect(eg.gain);
    am.start(t); am.stop(t + d + 0.02);
    v.nodes.push(am);
    lp.connect(eg); eg.connect(v.envGain);
    noiseBurst(v, t, { src: 'pink', filter: 'bp', freq: 250, Q: 2, dur: d, gain: 0.5 * g, pitch: p });
    return t + d + 0.03;
  },
  wither: (v, t, p, g, s) => {                   // no idle; hurt/death derive from this
    const d = 0.8 * s.dur;
    return sweep(v, t, { src: 'osc', wave: 'sawtooth', f0: 300 * (s.fall ? 1 - s.fall : 1), f1: 120, dur: d, gain: g, pitch: p, filter: { type: 'lp', freq: 900, Q: 1 } });
  },
};

// Mobs that get no `.idle` id at all (§3.4: "no idle").
const NO_IDLE = new Set(['creeper', 'wither']);
// Larger mobs override the default 16-block audible radius.
const MOB_DIST = {
  ghast: { maxDist: 48, refDist: 4 },
  dragon: { maxDist: 96, refDist: 8 },
  wither: { maxDist: 96, refDist: 8 },
};

for (const type of Object.keys(MOB_IDLE)) {
  const idle = MOB_IDLE[type];
  const dist = MOB_DIST[type] || {};
  const base = {
    bus: 'sfx', refDist: dist.refDist ?? 1, maxDist: dist.maxDist ?? 16,
    cap: 3, capKey: 'mob_' + type, priority: P.NEAR, replicate: true,
  };
  if (!NO_IDLE.has(type)) {
    def(`mob.${type}.idle`, { ...base, recipe: (v, t, p, g) => idle(v, t, p, g, { dur: 1, fall: 0 }) });
  }
  // §3.4 generic derivation: hurt = idle @ pitch x1.19, dur x0.4, gain x1.1
  def(`mob.${type}.hurt`, {
    ...base, recipe: (v, t, p, g) => idle(v, t, p * 1.19, g * 1.1, { dur: 0.4, fall: 0 }),
  });
  // death = idle @ pitch x0.79, dur x1.5, linear pitch fall of -30% across the tail
  def(`mob.${type}.death`, {
    ...base, cap: 2, recipe: (v, t, p, g) => idle(v, t, p * 0.79, g, { dur: 1.5, fall: 0.3 }),
  });
}

// Mob specials (§3.4 "Specials" column)
def('mob.creeper.fuse', {
  bus: 'sfx', refDist: 1, maxDist: 24, cap: 2, capKey: 'creeperFuse',
  priority: P.NEAR, replicate: true, loop: true,
  recipe: (v, t, p, g) => {
    // 1.5 s ramp = 30 swell ticks = the player's reaction window
    sweep(v, t, { src: 'noise', f0: 700, f1: 4500, dur: 1.5, gain: 0.3 * g, pitch: p, filter: { Q: 2 } });
    return hiss(v, t, { freq: 5000, dur: 1.5, gain: 0.3 * g, pitch: p });
  },
});
def('mob.enderman.scream', {
  bus: 'sfx', refDist: 1, maxDist: 24, cap: 2, capKey: 'endermanScream', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    MOB_IDLE.enderman(v, t, p, 0.9 * g, { dur: 0.85, fall: 0 });
    sweep(v, t, { src: 'osc', wave: 'sawtooth', f0: 220 * p, f1: 180 * p, dur: 1.0, gain: 0.5 * g });
    return noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 1500, Q: 1, dur: 1.0, gain: 0.5 * g, pitch: p });
  },
});
def('mob.enderman.teleport', {
  bus: 'sfx', refDist: 1, maxDist: 24, cap: 4, capKey: 'endermanTp', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    sweep(v, t, { src: 'osc', wave: 'sine', f0: 1600, f1: 150, dur: 0.18, gain: 0.5 * g, pitch: p });
    return hiss(v, t, { freq: 5000, dur: 0.1, gain: 0.35 * g, pitch: p });
  },
});
def('mob.chicken.egg', {
  bus: 'sfx', maxDist: 16, capKey: 'egg', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => EVENTS['player.item_pickup'].recipe(v, t, p * 0.7, g),
});

// ---------------------------------------------------------------- §3.5 world & system

def('world.explosion', {
  bus: 'sfx', refDist: 8, maxDist: 192, cap: 4, capKey: 'explosion',
  priority: P.NEAR, replicate: true, muffle: true,
  recipe: (v, t, p, g) => {
    // (a) sub
    const sub = v.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(60 * p, t);
    sub.frequency.exponentialRampToValueAtTime(28 * p, t + 0.8);
    const sg = v.ctx.createGain();
    sg.gain.setValueAtTime(0, t);
    sg.gain.linearRampToValueAtTime(1.0 * g, t + 0.01);
    sg.gain.exponentialRampToValueAtTime(Math.max(1e-4, g * 0.001), t + 0.8);
    sub.connect(sg); sg.connect(v.envGain);
    sub.start(t); sub.stop(t + 0.85);
    v.nodes.push(sub);
    // (b) body: white noise, LP sweeping 3000 -> 300 over 1.2 s
    sweep(v, t, { src: 'noise', f0: 3000, f1: 300, dur: 1.2, gain: 0.9 * g, pitch: p, filter: { Q: 0.7 } });
    // (c) crackle tail
    crackle(v, t, { density: 1.2, freq: 900, dur: 1.5, gain: 0.25 * g, pitch: p });
    return t + 1.6;
  },
});
def('world.tnt.fuse', {
  bus: 'sfx', maxDist: 24, cap: 4, capKey: 'tntFuse', priority: P.NEAR, replicate: true, loop: true,
  recipe: (v, t, p, g) => {
    hiss(v, t, { freq: 5000, Q: 1, gain: 0.35 * g, pitch: p, loop: true });
    return crackle(v, t, { density: 0.8, freq: 3000, gain: 0.35 * g, pitch: p, loop: true });
  },
});
def('ambient.fire.loop', {
  bus: 'ambient', maxDist: 16, cap: 3, capKey: 'fireLoop', priority: P.FAR, replicate: false, loop: true,
  recipe: (v, t, p, g) => {
    crackle(v, t, { density: 1.8, freq: 1800, gain: g, pitch: p, loop: true });
    return noiseBurst(v, t, { src: 'brown', filter: 'lp', freq: 350, Q: 0.7, gain: 0.3 * g, pitch: p, loop: true, dur: 1 });
  },
});
def('ambient.water.loop', {
  bus: 'ambient', maxDist: 14, cap: 2, capKey: 'waterLoop', priority: P.FAR, replicate: false, loop: true, jitter: 0,
  recipe: (v, t, p, g) => loopBuffer(v, t, 'loopWater', 0.4 * g),
});
def('ambient.lava.loop', {
  bus: 'ambient', maxDist: 18, cap: 2, capKey: 'lavaLoop', priority: P.FAR, replicate: false, loop: true, jitter: 0,
  recipe: (v, t, p, g) => loopBuffer(v, t, 'loopLava', 0.5 * g),
});
def('weather.rain.loop', {
  bus: 'ambient', cap: 1, capKey: 'rainLoop', priority: P.FAR, replicate: false, loop: true, jitter: 0,
  // Starts SILENT: ambience.js drives `loopGain` from rainLevel on the same tick
  // (§3.5 gain = 0.6 x rainLevel). Ramping to full first would blast one loud
  // half-second at every rain onset. `coverLp` likewise: 1.2 kHz under cover
  // (§3.5 approx), 20 kHz (transparent) with sky above.
  recipe: (v, t, p, g) => loopBuffer(v, t, 'loopRain', 0, { lp: 20000 }),
});
def('ambient.wind.loop', {
  bus: 'ambient', cap: 1, capKey: 'windLoop', priority: P.FAR, replicate: false, loop: true, jitter: 0,
  // likewise driven from altitude by ambience.js (§3.5)
  recipe: (v, t, p, g) => loopBuffer(v, t, 'loopWind', 0),
});
def('weather.thunder', {
  bus: 'ambient', cap: 3, capKey: 'thunder', priority: P.PLAYER, replicate: false, jitter: 0,
  // §3.5 says non-positional, but the recipe needs the strike distance for the
  // crack gate and the rumble delay. `distanceOnly` makes the engine measure the
  // distance to `pos` yet still allocate a FLAT (unpanned, unculled) voice.
  distanceOnly: true,
  recipe: (v, t, p, g) => {
    const d = v.dist;
    let end = t;
    if (d < 24) {                               // immediate crack
      end = noiseBurst(v, t, { src: 'white', filter: 'hp', freq: 1500, Q: 0.7, dur: 0.15, gain: 1.0 * g });
    }
    const delay = d * 0.06;                     // §3.5 scaled speed of sound
    const dur = 2 + Math.random() * 2;
    const rg = Math.min(1, Math.max(0.15, 1.2 - d / 200));
    const src = v.ctx.createBufferSource();
    const bp = v.ctx.createBiquadFilter();
    bp.type = 'lowpass';
    bp.frequency.setValueAtTime(160, t + delay);
    bp.frequency.exponentialRampToValueAtTime(55, t + delay + dur);
    const eg = v.ctx.createGain();
    eg.gain.setValueAtTime(0, t + delay);
    eg.gain.linearRampToValueAtTime(rg * g, t + delay + dur * 0.25);
    eg.gain.exponentialRampToValueAtTime(Math.max(1e-4, rg * g * 0.001), t + delay + dur);
    src.buffer = BUFFERS.brown;
    src.loop = true;
    src.connect(bp); bp.connect(eg); eg.connect(v.envGain);
    src.start(t + delay);
    src.stop(t + delay + dur + 0.05);
    v.nodes.push(src);
    return Math.max(end, t + delay + dur + 0.1);
  },
});

// ---------------------------------------------------------------- §3.6 redstone (07/15)

const mech = (id, recipe, extra = {}) =>
  def(id, { bus: 'sfx', refDist: 1, maxDist: 16, cap: 2, capKey: id, priority: P.NEAR, replicate: true, recipe, ...extra });

mech('block.lever.click.on', (v, t, p, g) => blip(v, t, { wave: 'square', freq: 650, dur: 0.04, gain: 0.4 * g, pitch: p }));
mech('block.lever.click.off', (v, t, p, g) => blip(v, t, { wave: 'square', freq: 470, dur: 0.04, gain: 0.4 * g, pitch: p }));
mech('block.button.wood.on', (v, t, p, g) => {
  CORES.wood(v, t, p, 0.6 * 0.5 * g, STEP_DUR.wood * 1.6);
  return blip(v, t, { wave: 'triangle', freq: 900, dur: 0.03, gain: 0.4 * g, pitch: p });
});
mech('block.button.wood.off', (v, t, p, g) => {
  CORES.wood(v, t, p, 0.6 * 0.5 * g, STEP_DUR.wood * 1.6);
  return blip(v, t, { wave: 'triangle', freq: 680, dur: 0.03, gain: 0.4 * g, pitch: p });
});
mech('block.button.stone.on', (v, t, p, g) => {
  CORES.stone(v, t, p, 0.6 * 0.5 * g, STEP_DUR.stone * 1.6);
  return blip(v, t, { wave: 'square', freq: 1000, dur: 0.025, gain: 0.4 * g, pitch: p });
});
mech('block.button.stone.off', (v, t, p, g) => {
  CORES.stone(v, t, p, 0.6 * 0.5 * g, STEP_DUR.stone * 1.6);
  return blip(v, t, { wave: 'square', freq: 820, dur: 0.025, gain: 0.4 * g, pitch: p });
});
for (const [mat, kind] of [['wood', 'wood'], ['stone', 'stone']]) {
  for (const st of ['on', 'off']) {
    mech(`block.pressure_plate.${mat}.${st}`,
      (v, t, p, g) => EVENTS[`block.button.${kind}.${st}`].recipe(v, t, p * 0.85, g));
  }
}
mech('block.redstone_torch.burnout', (v, t, p, g) => {
  hiss(v, t, { freq: 3000, Q: 1, dur: 0.2, gain: 0.4 * g, pitch: p });
  return blip(v, t, { wave: 'triangle', freq: 500, f1: 200, dur: 0.2, gain: 0.4 * g, pitch: p });
});
mech('block.repeater.click', (v, t, p, g) => blip(v, t, { wave: 'square', freq: 520, dur: 0.022, gain: 0.3 * g, pitch: p }));
mech('block.comparator.click', (v, t, p, g) => blip(v, t, { wave: 'square', freq: 520, dur: 0.022, gain: 0.3 * g, pitch: p }));
mech('block.piston.extend', (v, t, p, g) => {
  thud(v, t, { f0: 130, f1: 60, dur: 0.12, gain: 0.4 * g, pitch: p });
  return noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 700, Q: 1, dur: 0.08, gain: 0.4 * g, pitch: p });
});
mech('block.piston.retract', (v, t, p, g) => EVENTS['block.piston.extend'].recipe(v, t, p * 0.95, g));
mech('block.dispenser.fire', (v, t, p, g) => {
  blip(v, t, { wave: 'square', freq: 300, dur: 0.04, gain: 0.4 * g, pitch: p });
  return noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 1800, Q: 1, dur: 0.03, gain: 0.3 * g, pitch: p });
});
mech('block.dispenser.fail', (v, t, p, g) => blip(v, t, { wave: 'square', freq: 200, dur: 0.06, gain: 0.3 * g, pitch: p }));
mech('block.dropper.drop', (v, t, p, g) => EVENTS['block.dispenser.fire'].recipe(v, t, p * 0.85, g));
mech('item.flintandsteel.use', (v, t, p, g) => {
  blip(v, t, { wave: 'square', freq: 1400, dur: 0.018, gain: 0.4 * g, pitch: p });     // snick
  return crackle(v, t, { density: 1.2, freq: 2500, dur: 0.12, gain: 0.4 * g, pitch: p });
});

// ---------------------------------------------------------------- note block (§3.5, 07)

// §3.5 gives block.note an `instrument` param, but §5.1's emitSound signature has
// no param channel — one id per instrument instead (see DEVIATIONS). Pitch for
// note n: rate = 2^((n-12)/12) passed as pitchMult; n=12 sounds F#4 ~ 370 Hz.
const FSHARP4 = 369.994;
const NOTE = {
  harp: (v, t, p, g) => pluck(v, t, { freq: FSHARP4 * p, dur: 0.9, gain: 0.5 * g }),
  bass: (v, t, p, g) => pluck(v, t, { freq: (FSHARP4 / 4) * p, bass: true, dur: 1.2, gain: 0.5 * g }),
  snare: (v, t, p, g) => noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 1800, Q: 1, dur: 0.11, gain: 0.5 * g, pitch: p }),
  hat: (v, t, p, g) => hiss(v, t, { freq: 7000, Q: 2, filter: 'bp', dur: 0.045, gain: 0.4 * g, pitch: p }),
  bell: (v, t, p, g) => chime(v, t, { freq: FSHARP4 * 4 * p, ratio: 3.53, index: 4, dur: 0.9, gain: 0.4 * g }),
  basedrum: (v, t, p, g) => thud(v, t, { f0: 120, f1: 45, dur: 0.18, noiseGain: 0.5, gain: 0.6 * g, pitch: p }),
  guitar: (v, t, p, g) => pluck(v, t, { freq: (FSHARP4 / 2) * p, dur: 0.7, gain: 0.5 * g, lp: 1200 }),
  iron_xylophone: (v, t, p, g) => chime(v, t, { freq: FSHARP4 * p, ratio: 2.0, index: 3, dur: 0.6, gain: 0.4 * g }),
  pling: (v, t, p, g) => {
    chime(v, t, { freq: FSHARP4 * p, ratio: 1.0, index: 1, dur: 0.3, gain: 0.4 * g });
    return blip(v, t, { wave: 'square', freq: FSHARP4 * p, dur: 0.3, gain: 0.3 * 0.4 * g });
  },
  didgeridoo: (v, t, p, g) => sweep(v, t, {
    src: 'osc', wave: 'sawtooth', f0: (FSHARP4 / 4) * p, f1: (FSHARP4 / 4) * p,
    dur: 0.5, gain: 0.5 * g, filter: { type: 'lp', freq: 500, Q: 1 },
  }),
};
for (const inst of Object.keys(NOTE)) {
  def(`block.note.${inst}`, {
    bus: 'sfx', maxDist: 32, cap: 8, capKey: 'note', priority: P.NEAR,
    jitter: 0, replicate: true, recipe: NOTE[inst],
  });
}
EVENTS['block.note'] = EVENTS['block.note.harp'];      // default instrument

// ------------------------------------------------- 08-ENCHANTING §12 hooks
//
// 08 §12 names eight hooks. Two already existed and are unchanged:
// `player.attack.sweep` (defined above, E3) and the durability-break voice,
// which this codebase calls `player.item_break` — 08 §12 names that one
// `item.break`. The existing id is kept rather than renamed: it predates 08,
// 06 §7.1 owns the break sound, and E3 already logged the naming divergence.
// The six below are new. All are 100% synthesized (16's absolute rule).

// Vanilla block.enchantment_table.use: the shimmer of the deal closing. Self
// event — the table is always right in front of you.
def('enchant.apply', {
  ...UI, cap: 2, capKey: 'enchant', jitter: 0,
  recipe: (v, t, p, g) => {
    chime(v, t, { freq: 880, ratio: 3.53, index: 4, dur: 0.6, gain: 0.4 * g, pitch: p });
    chime(v, t + 0.06, { freq: 1320, ratio: 3.53, index: 4, dur: 0.5, gain: 0.3 * g, pitch: p });
    return whoosh(v, t, { f0: 600, f1: 3000, dur: 0.45, gain: 0.2 * g, pitch: p });
  },
});

// block.anvil.use — a worked clang: iron core + a short ring-out.
def('anvil.use', {
  bus: 'sfx', maxDist: 16, capKey: 'anvil', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    thud(v, t, { f0: 260, f1: 110, dur: 0.09, gain: 0.5 * g, pitch: p });
    return BREAK_LAYERS.metal(v, t, p, 0.5 * g);
  },
});

// block.anvil.land — heavier and lower than .use: mass hitting ground.
// `pitchMult` carries fall severity from the call site (the ui.gamemode.switch
// trick), so a longer drop lands duller.
def('anvil.land', {
  bus: 'sfx', maxDist: 32, capKey: 'anvilLand', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    thud(v, t, { f0: 180, f1: 60, dur: 0.22, gain: 0.7 * g, pitch: p });
    return BREAK_LAYERS.metal(v, t + 0.01, p * 0.6, 0.35 * g);
  },
});

// block.anvil.destroy — the clang collapsing into debris.
def('anvil.destroy', {
  bus: 'sfx', maxDist: 32, capKey: 'anvilDestroy', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    BREAK_LAYERS.metal(v, t, p, 0.6 * g);
    crackle(v, t + 0.03, { density: 2.0, freq: 800, dur: 0.3, gain: 0.45 * g, pitch: p });
    return whoosh(v, t, { f0: 900, f1: 180, dur: 0.3, gain: 0.35 * g, pitch: p });
  },
});

// block.grindstone.use — stone-on-metal rasp, no clang.
def('grindstone.use', {
  bus: 'sfx', maxDist: 16, capKey: 'grindstone', priority: P.NEAR, replicate: true,
  recipe: (v, t, p, g) => {
    noiseBurst(v, t, { src: 'white', filter: 'bp', freq: 2600, Q: 0.8, dur: 0.28, gain: 0.4 * g, pitch: p });
    return sweep(v, t, { src: 'osc', wave: 'sawtooth', f0: 420, f1: 260, dur: 0.3, gain: 0.18 * g, pitch: p });
  },
});

// §5.8 — the orb going into gear instead of the bar. A variant of the xp-pickup
// voice: same family, but it resolves upward rather than chiming.
def('mending.repair', {
  ...UI, cap: 2, capKey: 'mending', jitter: 1,
  recipe: (v, t, p, g) => {
    chime(v, t, { freq: 1180, ratio: 2.0, index: 2, dur: 0.28, gain: 0.3 * g, pitch: p });
    return pluck(v, t + 0.03, { freq: 1560, dur: 0.09, gain: 0.25 * g, pitch: p });
  },
});

// ---------------------------------------------------------------- helpers

// BUFFERS is filled in place by bakeBuffers(), so reads must be deferred to
// recipe-call time — never hoisted to module scope.
function loopBuffer(v, t, name, gain, opts = {}) {
  const src = v.ctx.createBufferSource();
  src.buffer = BUFFERS[name];
  src.loop = true;
  const g = v.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.5);       // §3.5 0.5 s cluster fade-in
  v.mod = v.mod || {};
  if (opts.lp) {
    const lp = v.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = opts.lp;
    src.connect(lp); lp.connect(g);
    v.mod.coverLp = lp.frequency;
  } else {
    src.connect(g);
  }
  g.connect(v.envGain);
  src.start(t);
  v.nodes.push(src);
  v.mod.loopGain = g.gain;
  return Infinity;
}

// §3 intro + §5.2 default derivation: an unlisted sibling event resolves to its
// namespace's nearest generated family rather than warning.
const _resolved = new Map();
export function resolveEvent(id) {
  if (EVENTS[id]) return EVENTS[id];
  if (_resolved.has(id)) return _resolved.get(id);
  let hit = null;
  if (id.startsWith('mob.')) {
    const parts = id.split('.');
    const verb = parts[parts.length - 1];
    const type = parts.slice(1, -1).join('.');
    hit = EVENTS[`mob.${type}.${verb}`] || EVENTS[`mob.${type}.idle`] || EVENTS[`mob.${type}.hurt`] || null;
  } else if (id.startsWith('block.')) {
    hit = EVENTS['block.break.stone'];
  }
  _resolved.set(id, hit);
  return hit;
}
