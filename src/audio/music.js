// Generative music system (16 §4). All-original, generated at runtime.
//
// ORIGINALITY GUARD (§4, non-negotiable): this file contains NO hand-authored
// note sequences. Every pitch comes from a seeded random walk over the abstract
// scale tables below; every chord comes from the progression matrix. Hand-
// authored RULES are permitted; hand-authored TUNES are not. Do not add a
// lookup table of melodies here, and do not tune the generator by ear toward
// any existing soundtrack. It is structurally impossible for this system to
// play an existing piece, and it must stay that way.
import { mulberry32, xmur3 } from '../math/rng.js';
import { busGain } from '../ui/options.js';
import { noiseBurst, pluck, chime } from './primitives.js';

// §4.1 scale pools (semitone sets)
const SCALES = {
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  phrygianFragment: [0, 1, 5, 7, 8],
};

// §4.1 mood table: condition priority is resolved in selectMood()
const MOODS = {
  boss: { scale: 'phrygianFragment', bpm: 84, melody: null, padLp: 700, gain: 0.28 },
  nether: { scale: 'phrygianFragment', bpm: 40, melody: null, padLp: 600, gain: 0.22 },
  end: { scale: 'lydian', bpm: 50, melody: 'chime', padLp: 900, gain: 0.2, sparse: true },
  underground: { scale: 'dorian', bpm: 56, melody: 'pluck', padLp: 1200, gain: 0.22, restProb: 0.8, busLp: 1500 },
  'overworld-night': { scale: 'minorPentatonic', bpm: 56, melody: 'chime', padLp: 900, gain: 0.25 },
  'overworld-day': { scale: 'majorPentatonic', bpm: 72, melody: 'pluck', padLp: 1200, gain: 0.25 },
};

// §4.1 progression matrix — rows = current chord, weights over reachable degrees
const PROGRESSION = {
  I: { I: 0.20, IV: 0.35, V: 0.20, vi: 0.25 },
  IV: { I: 0.40, V: 0.30, vi: 0.30 },
  V: { I: 0.40, IV: 0.20, vi: 0.40 },
  vi: { I: 0.30, IV: 0.40, III: 0.30 },
  III: { IV: 0.50, vi: 0.50 },
};
const DEGREE_INDEX = { I: 0, IV: 3, V: 4, vi: 5, III: 2 };

// §4.2 form: intro 8 (pad) -> A 16 -> B 16 -> A' 16 (+12) -> outro 8
const FORM = [
  { name: 'intro', bars: 8, pad: true, melody: false },
  { name: 'A', bars: 16, pad: true, melody: true, octave: 0 },
  { name: 'B', bars: 16, pad: true, melody: true, octave: 0, restBoost: 0.25, accents: true },
  { name: 'A2', bars: 16, pad: true, melody: true, octave: 12 },
  { name: 'outro', bars: 8, pad: true, melody: false, fade: true },
];

const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);

function pickWeighted(rng, table) {
  const keys = Object.keys(table);
  let total = 0;
  for (const k of keys) total += table[k];
  let r = rng() * total;
  for (const k of keys) { r -= table[k]; if (r <= 0) return k; }
  return keys[keys.length - 1];
}

export class Music {
  constructor(engine) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.pieceIndex = 0;
    this.piece = null;            // active piece state
    this.nextPieceAt = 0;         // ctx.currentTime deadline (§4.3 scarcity)
    this.scheduledUpTo = 0;
    this.mood = 'overworld-day';
    this.pendingMood = null;
    this.enabled = true;
    this.suspended = false;       // musicMode 'full' hands the bus to §4A
    this.busLp = null;
    this.ambientDucked = false;   // §4.1 boss mood ducks ambientBus -12 dB
    this._armed = false;
    this.voices = 0;              // §4.2 self-budget: <= 8 concurrent
  }

  onOptions(opts) {
    // §4A: on musicMode 'full' the theme layer REPLACES the composer in-game, so
    // §4 suspends — but only when that layer can actually play something. With no
    // cleared tracks the manifest is empty (every public build today), and
    // suspending unconditionally left 'full' with no theme AND no composer: total
    // in-game silence. §16's intro makes the composer "the default and the
    // fallback, so a fully-synthesized, zero-download ship is always possible".
    const themeCanPlay = !!this.engine.themeMusic?.available;
    this.suspended = opts.musicMode === 'full' && themeCanPlay;
    if (this.suspended) { this.stop(2); this.setAmbientDuck(false); }
    // engine.setOptions() rewrites every bus gain straight from the sliders and
    // THEN calls this, so a slider move mid-boss would otherwise cancel the duck.
    else if (this.ambientDucked) this.applyAmbientDuck();
  }

  // Called when PLAYING begins; §4.3 first piece 45-90 s after entering PLAYING.
  arm(worldSeed) {
    if (this._armed) return;
    this._armed = true;
    // §4.1: piece N of a given world is always the same piece, and a resumed
    // world "restarts at piece 0" (pieceIndex is not in the save). Music is a
    // process-lifetime singleton, so entering a DIFFERENT world must rewind the
    // counter — otherwise world B's first piece is whatever index world A left
    // behind, and the same seed sounds different depending on play order.
    if (worldSeed !== this.worldSeed) this.pieceIndex = 0;
    this.worldSeed = worldSeed;
    this.nextPieceAt = this.ctx.currentTime + 45 + Math.random() * 45;
  }

  disarm() {
    this._armed = false;
    this.stop(1);
    this.setAmbientDuck(false);
  }

  stop(fadeSec = 2) {
    if (!this.piece) return;
    const now = this.ctx.currentTime;
    this.piece.out.gain.cancelScheduledValues(now);
    this.piece.out.gain.setValueAtTime(this.piece.out.gain.value, now);
    this.piece.out.gain.linearRampToValueAtTime(0, now + fadeSec);
    const dying = this.piece;
    setTimeout(() => { try { dying.out.disconnect(); } catch { /* */ } }, fadeSec * 1000 + 200);
    this.piece = null;
    this.nextPieceAt = now + fadeSec + this.scarcityGap();
  }

  scarcityGap() { return 180 + Math.random() * 240; }    // §4.3: 3-7 min of silence

  // §4.1 "boss fight active" / §4.3's boss interrupt. Nothing in the codebase
  // owns a global boss flag — 13's bosses only add/remove their own HUD bar — so
  // the live boss bar IS the fight state. A bar that is fading out (`removing`)
  // has already lost its boss and does not count.
  bossFightActive() {
    const bars = this.engine.game?.ui?.bossBar?.bars;
    if (!bars || bars.size === 0) return false;
    for (const b of bars.values()) if (!b.removing) return true;
    return false;
  }

  // §4.1 boss mood "ducks ambientBus -12 dB" — x0.25, matching §4.3's -6 dB = x0.5.
  setAmbientDuck(on) {
    if (on === this.ambientDucked) return;
    this.ambientDucked = on;
    this.applyAmbientDuck();
  }

  applyAmbientDuck() {
    const bus = this.engine.buses?.ambient;
    if (!bus) return;
    const now = this.ctx.currentTime;
    bus.gain.cancelScheduledValues(now);
    bus.gain.setTargetAtTime(busGain(this.engine.opts.ambient) * (this.ambientDucked ? 0.25 : 1), now, 0.15);
  }

  // §4.1 mood selector — priority top-down.
  selectMood() {
    const g = this.engine.game;
    if (!g || !g.world || !g.player) return 'overworld-day';
    if (this.bossFightActive()) return 'boss';
    // 10-NETHER §2 — dims are numeric ids now (0 overworld / 1 nether / 2 end).
    const dim = g.world.activeDim;
    if (dim === 1) return 'nether';
    if (dim === 2) return 'end';
    const p = g.player;
    const eyeY = Math.floor(p.pos.y + p.eyeHeight);
    if (p.pos.y < 52 && g.world.getSkyLight(Math.floor(p.pos.x), eyeY, Math.floor(p.pos.z)) === 0) {
      return 'underground';
    }
    if (g.world.skyDarken >= 4) return 'overworld-night';    // §4.1: skyDarken lives on World
    return 'overworld-day';
  }

  startPiece(mood) {
    const ctx = this.ctx;
    const spec = MOODS[mood];
    // §4.1 seeding: piece N of a given world is always the same piece
    const rng = mulberry32(xmur3(this.worldSeed + ':music:' + this.pieceIndex)());
    const root = 48 + Math.floor(rng() * 12);               // C3-B3
    const scale = SCALES[spec.scale];

    const out = ctx.createGain();
    out.gain.value = 1;
    if (spec.busLp) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = spec.busLp;
      out.connect(lp); lp.connect(this.engine.buses.music);
    } else {
      out.connect(this.engine.buses.music);
    }

    const beat = 60 / spec.bpm;
    this.piece = {
      mood, spec, rng, root, scale, out,
      beat, barDur: beat * 4,
      startTime: ctx.currentTime + 0.2,
      section: 0, bar: 0, slot: 0,
      chord: 'I', chordBarsLeft: 0,
      melodyDegree: Math.floor(rng() * scale.length),
      activeBars: 0, restBars: 0,
      velocity: 0.18 + (rng() - 0.5) * 0.1,
    };
    this.scheduledUpTo = this.piece.startTime;
    this.pieceIndex++;
  }

  // §1.5 lookahead scheduler: schedule everything with noteTime < now + 0.1
  updateFrame(now) {
    if (!this.engine.ready || this.suspended || !this._armed) return;
    if (!this.piece) {
      if (now >= this.nextPieceAt && this.nextPieceAt > 0) {
        this.mood = this.selectMood();
        this.startPiece(this.mood);
      }
      return;
    }
    const horizon = now + 0.1;
    let guard = 0;
    while (this.scheduledUpTo < horizon && guard++ < 64) {
      if (!this.scheduleBar(this.scheduledUpTo)) return;    // piece ended
    }
  }

  scheduleBar(t) {
    const pc = this.piece;
    const form = FORM[pc.section];
    if (!form) { this.endPiece(); return false; }

    // §4.2 outro: "8 bars, pad fading" — the fade spans the whole SECTION, so it
    // is armed once on the section's first bar. Hanging it off schedulePad would
    // scope it to the current chord (1-2 bars) and leave 6 bars of dead silence.
    if (form.fade && pc.bar === 0) {
      const total = form.bars * pc.barDur;
      pc.out.gain.setValueAtTime(pc.out.gain.value, t);
      pc.out.gain.linearRampToValueAtTime(0.0001, t + total);
    }

    // chord walk (§4.1): 2 bars, or 1 bar with probability 0.25
    if (pc.chordBarsLeft <= 0) {
      pc.chord = pickWeighted(pc.rng, PROGRESSION[pc.chord] || PROGRESSION.I);
      pc.chordBarsLeft = pc.rng() < 0.25 ? 1 : 2;
      this.schedulePad(t, pc, form);
    }
    pc.chordBarsLeft--;

    if (form.melody) this.scheduleMelodyBar(t, pc, form);
    if (form.accents) this.scheduleAccents(t, pc);
    if (pc.mood === 'boss') this.scheduleRhythm(t, pc);

    pc.bar++;
    this.scheduledUpTo = t + pc.barDur;
    if (pc.bar >= form.bars) { pc.bar = 0; pc.section++; }
    return true;
  }

  // §4.2 pad: 3 oscs on chord tones, crossfaded over 0.8 s on chord change
  schedulePad(t, pc, form) {
    const ctx = this.ctx;
    const deg = DEGREE_INDEX[pc.chord] ?? 0;
    const sc = pc.scale;
    const tone = i => pc.root + sc[(deg + i) % sc.length] + 12 * Math.floor((deg + i) / sc.length);
    // root at oct 2-3, fifth and third at oct 3-4 (pentatonics approximate the
    // triad with a 1-2-5 / 1-4-5 degree stack — §4.1 (approx))
    const freqs = [midiToFreq(tone(0) - 12), midiToFreq(tone(2)), midiToFreq(tone(4))];
    const dur = pc.barDur * pc.chordBarsLeft || pc.barDur * 2;

    const mix = ctx.createGain();
    mix.gain.setValueAtTime(0, t);
    mix.gain.linearRampToValueAtTime(0.25, t + 0.8);                 // 0.8 s crossfade in
    mix.gain.setValueAtTime(0.25, t + dur);
    mix.gain.linearRampToValueAtTime(0, t + dur + 0.8);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = pc.spec.padLp;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 0.15;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = pc.spec.padLp * 0.25;
    lfo.connect(lfoAmt); lfoAmt.connect(lp.frequency);
    lfo.start(t); lfo.stop(t + dur + 1);

    for (const f of freqs) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(mix);
      o.start(t); o.stop(t + dur + 1);
    }
    mix.connect(lp); lp.connect(pc.out);
  }

  // §4.2 melody: 1/8 grid, rest prob 0.6, random walk over the scale
  scheduleMelodyBar(t, pc, form) {
    // phrase rule: after 4 bars of activity, force a 2-bar rest
    if (pc.activeBars >= 4) { pc.restBars = 2; pc.activeBars = 0; }
    if (pc.restBars > 0) { pc.restBars--; return; }
    pc.activeBars++;

    const restProb = (pc.spec.restProb ?? 0.6) + (form.restBoost ?? 0);
    const eighth = pc.beat / 2;
    for (let i = 0; i < 8; i++) {
      const at = t + i * eighth;
      if (pc.rng() < restProb) continue;
      // step +/- degrees, weighted {0:.3, +/-1:.25 ea, +/-2:.1 ea}
      const r = pc.rng();
      let step = 0;
      if (r < 0.30) step = 0;
      else if (r < 0.55) step = 1;
      else if (r < 0.80) step = -1;
      else if (r < 0.90) step = 2;
      else step = -2;
      pc.melodyDegree += step;
      // beat 1 snaps to a chord tone
      if (i === 0) pc.melodyDegree = (DEGREE_INDEX[pc.chord] ?? 0) % pc.scale.length;

      const sc = pc.scale;
      let d = pc.melodyDegree;
      let oct = Math.floor(d / sc.length);
      let idx = ((d % sc.length) + sc.length) % sc.length;
      let midi = pc.root + sc[idx] + 12 * oct + 12 + (form.octave || 0);
      // register clamp to octaves 4-6
      while (midi < 60) midi += 12;
      while (midi > 96) midi -= 12;
      pc.melodyDegree = idx + oct * sc.length;

      this.playNote(pc, at, midiToFreq(midi), pc.velocity);
    }
  }

  // §4.1 end/underground accents: sparse bell dyads / distant chimes
  scheduleAccents(t, pc) {
    if (pc.rng() > 0.35) return;
    const sc = pc.scale;
    const base = pc.root + sc[Math.floor(pc.rng() * sc.length)] + 36;
    this.playChime(pc, t + pc.rng() * pc.barDur, midiToFreq(base), 0.12);
  }

  // §4.2 boss rhythm: noiseBurst hits on beats 1 and 3 — a pulse, not a drum kit
  scheduleRhythm(t, pc) {
    for (const b of [0, 2]) {
      const at = t + b * pc.beat;
      const v = this.tempVoice(pc, at + 0.09);
      noiseBurst(v, at, {
        src: 'white', filter: 'bp', freq: 300, Q: 1, dur: 0.09, gain: 0.4,
      });
    }
  }

  playNote(pc, at, freq, gain) {
    if (this.voices >= 8) return;                 // §4.2 self-budget
    const dur = pc.spec.melody === 'chime' ? 1.2 : 0.8;
    const v = this.tempVoice(pc, at + dur);
    if (pc.spec.melody === 'chime') chime(v, at, { freq, ratio: 2.0, index: 2, dur, gain });
    else pluck(v, at, { freq, dur, gain });
  }

  playChime(pc, at, freq, gain) {
    const v = this.tempVoice(pc, at + 1.6);
    chime(v, at, { freq, ratio: 3.53, index: 3, dur: 1.6, gain });
  }

  // Music sources are fire-and-forget onto the music bus and do NOT consume the
  // SFX voice pool (§4.2) — this is a throwaway shim matching the voice shape
  // the §2 primitives expect.
  //
  // `endsAt` is a ctx-clock deadline, not a fixed wall-clock delay: notes are
  // scheduled up to a bar ahead, and a bar is 6 s at the nether's 40 BPM — a flat
  // 4 s timeout would disconnect an accent before it ever sounded. The extra
  // second covers the release tail.
  tempVoice(pc, endsAt) {
    const g = this.ctx.createGain();
    g.gain.value = 1;
    g.connect(pc.out);
    this.voices++;
    const v = { ctx: this.ctx, envGain: g, nodes: [], mod: null, dist: 0 };
    const ms = Math.max(500, (endsAt - this.ctx.currentTime + 1) * 1000);
    setTimeout(() => { this.voices--; try { g.disconnect(); } catch { /* */ } }, ms);
    return v;
  }

  endPiece() {
    const now = this.ctx.currentTime;
    const dying = this.piece;
    if (dying) setTimeout(() => { try { dying.out.disconnect(); } catch { /* */ } }, 2000);
    this.piece = null;
    this.nextPieceAt = now + this.scarcityGap();     // §4.3 scarcity
  }

  tick() {
    // The duck is evaluated before the early-out so it always releases — an idle
    // or suspended composer must not leave ambience stuck 12 dB down.
    this.setAmbientDuck(this._armed && !this.suspended && this.bossFightActive());
    if (!this._armed || this.suspended) return;
    // §4.3 interrupt: only the boss mood interrupts a playing piece
    const m = this.selectMood();
    if (this.piece && m === 'boss' && this.piece.mood !== 'boss') {
      this.stop(2);
      this.nextPieceAt = this.ctx.currentTime + 2;
    }
  }
}
