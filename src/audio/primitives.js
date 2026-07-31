// Synth primitive library + buffer bakery (16 §2).
//
// Every primitive is `prim(voice, t0, p) -> stopTime`: it builds its own small
// node graph, connects it INTO `voice.envGain`, schedules envelopes at t0, and
// returns the time its tail ends. Layering works because each primitive owns a
// private gain node holding its own `p.gain`.
//
// `voice.envGain` sits at 1.0 and is NOT a volume stage — it is the engine's
// fade handle for steals, loop releases and handle.stop(). Loudness arrives via
// each recipe's `g` argument (event gain x §2.2 jitter x the caller's gainMult),
// applied exactly once, in the primitive's own gain node.
//
// `p.pitch` (default 1) is §2.2's pitchMult: primitives apply it to every
// frequency-ish param they own — oscillator/buffer rate AND filter cutoff — so
// timbre transposes coherently rather than shifting one layer against another.
import { mulberry32, xmur3 } from '../math/rng.js';

export const BUFFERS = {};        // name -> AudioBuffer, filled by bakeBuffers()
let SR = 48000;

// Deterministic per-buffer stream (§2.1): identical sound every run.
const streamFor = name => mulberry32(xmur3('audio:' + name)());

// ---------------------------------------------------------------- offline DSP

// RBJ cookbook biquad, run over a Float32Array in place. The bake needs filters
// before any AudioContext graph exists, so these mirror BiquadFilterNode in JS.
function biquad(data, type, freq, Q, sr) {
  const w0 = 2 * Math.PI * Math.min(freq, sr * 0.49) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === 'hp') {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else {                                  // 'bp' (constant 0 dB peak gain)
    b0 = alpha; b1 = 0; b2 = -alpha;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    data[i] = y;
  }
  return data;
}

function normalize(data, peak = 1) {
  let m = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > m) m = a; }
  if (m > 1e-6) { const k = peak / m; for (let i = 0; i < data.length; i++) data[i] *= k; }
  return data;
}

function whiteData(n, rng) {
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = rng() * 2 - 1;
  return d;
}

// Paul Kellett economy pink filter (§2.1, verbatim coefficients).
function pinkData(n, rng) {
  const d = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    d[i] = b0 + b1 + b2 + w * 0.1848;
  }
  return normalize(d);
}

function brownData(n, rng) {
  const d = new Float32Array(n);
  let b = 0;
  for (let i = 0; i < n; i++) {
    b = (b + 0.02 * (rng() * 2 - 1)) / 1.02;
    d[i] = b * 3.5;
  }
  return d;
}

// Sparse Poisson impulse train, mean 30/s, amplitude +/-uniform(0.4, 1).
function impulseData(n, rng, sr) {
  const d = new Float32Array(n);
  const p = 30 / sr;                        // per-sample strike probability
  for (let i = 0; i < n; i++) {
    if (rng() < p) d[i] = (0.4 + rng() * 0.6) * (rng() < 0.5 ? -1 : 1);
  }
  return d;
}

// Karplus-Strong (§2.5): baked, not live — the spec's feedback DelayNode is
// clamped to one render quantum (128 samples), capping a live loop near 344 Hz.
export function bakePluck(freq, blend, dur, sr, rng) {
  const N = Math.round(sr / freq);
  const out = new Float32Array(Math.round(dur * sr));
  for (let i = 0; i <= N && i < out.length; i++) out[i] = rng() * 2 - 1;
  for (let i = N + 1; i < out.length; i++) {
    out[i] = blend * 0.5 * (out[i - N] + out[i - N - 1]);
  }
  return normalize(out);
}

// Additive helpers used while baking the loop beds.
function addSine(d, at, dur, f0, f1, gain, sr) {
  const n = Math.round(dur * sr), start = Math.round(at * sr);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const j = start + i;
    if (j >= d.length) break;
    const k = i / n;
    const f = f0 * Math.pow(f1 / f0, k);
    phase += 2 * Math.PI * f / sr;
    d[j] += Math.sin(phase) * gain * (1 - k) * (1 - k);
  }
}

// Equal-power crossfade of the tail into the head so a looped buffer is seamless.
function makeSeamless(d, sr, fadeSec = 0.1) {
  const f = Math.round(fadeSec * sr);
  if (f * 2 >= d.length) return d;
  const out = d.slice(0, d.length - f);
  for (let i = 0; i < f; i++) {
    const k = i / f;
    const a = Math.cos(k * Math.PI / 2), b = Math.sin(k * Math.PI / 2);
    out[i] = d[i] * b + d[d.length - f + i] * a;
  }
  return out;
}

function toBuffer(ctx, data) {
  const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buf.copyToChannel(data, 0);
  return buf;
}

// ---------------------------------------------------------------- bake list (§2.1)

export function bakeBuffers(ctx) {
  const sr = SR = ctx.sampleRate;
  const n2 = sr * 2;

  BUFFERS.white = toBuffer(ctx, whiteData(n2, streamFor('white')));
  BUFFERS.pink = toBuffer(ctx, pinkData(n2, streamFor('pink')));
  BUFFERS.brown = toBuffer(ctx, brownData(n2, streamFor('brown')));
  BUFFERS.impulses = toBuffer(ctx, impulseData(n2, streamFor('impulses'), sr));
  BUFFERS.pluckA = toBuffer(ctx, bakePluck(220, 0.996, 1.2, sr, streamFor('pluckA')));
  BUFFERS.pluckBass = toBuffer(ctx, bakePluck(55, 0.998, 2.0, sr, streamFor('pluckBass')));

  // loopRain: pink x0.7 through BP 1.1 kHz Q0.5 + 40 droplet blips (approx)
  {
    const rng = streamFor('loopRain');
    const d = pinkData(n2, rng);
    for (let i = 0; i < n2; i++) d[i] *= 0.7;
    biquad(d, 'bp', 1100, 0.5, sr);
    for (let i = 0; i < 40; i++) {
      const f = 600 + rng() * 1800;
      addSine(d, rng() * 1.98, 0.015, f, f * 0.8, 0.25, sr);
    }
    BUFFERS.loopRain = toBuffer(ctx, makeSeamless(normalize(d, 0.8), sr));
  }

  // loopWater: brown x0.6 LP 900 + 0.5 Hz wobble + 6 burble chirps
  {
    const rng = streamFor('loopWater');
    const d = brownData(n2, rng);
    for (let i = 0; i < n2; i++) d[i] *= 0.6;
    biquad(d, 'lp', 900, 0.7, sr);
    for (let i = 0; i < n2; i++) {
      d[i] *= 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.5 * i / sr);
    }
    for (let i = 0; i < 6; i++) {
      const f = 400 + rng() * 500;
      addSine(d, rng() * 1.9, 0.08, f, f * 1.7, 0.2, sr);
    }
    BUFFERS.loopWater = toBuffer(ctx, makeSeamless(normalize(d, 0.8), sr));
  }

  // loopLava: brown x0.8 LP 300 + 8 glop thuds (sine 90->50) + sparse crackle
  {
    const rng = streamFor('loopLava');
    const d = brownData(n2, rng);
    for (let i = 0; i < n2; i++) d[i] *= 0.8;
    biquad(d, 'lp', 300, 0.7, sr);
    for (let i = 0; i < 8; i++) addSine(d, rng() * 1.85, 0.12, 90, 50, 0.35, sr);
    const crack = impulseData(n2, streamFor('loopLavaCrackle'), sr);
    biquad(crack, 'bp', 1600, 1.5, sr);
    for (let i = 0; i < n2; i++) d[i] += crack[i] * 0.12;
    BUFFERS.loopLava = toBuffer(ctx, makeSeamless(normalize(d, 0.85), sr));
  }

  // loopWind: pink through BP 400 Hz Q0.4, amplitude wobble 0.3 Hz
  {
    const d = pinkData(n2, streamFor('loopWind'));
    biquad(d, 'bp', 400, 0.4, sr);
    for (let i = 0; i < n2; i++) {
      d[i] *= 0.7 + 0.3 * Math.sin(2 * Math.PI * 0.3 * i / sr);
    }
    BUFFERS.loopWind = toBuffer(ctx, makeSeamless(normalize(d, 0.8), sr));
  }
}

export function bakedBytes() {
  let n = 0;
  for (const k in BUFFERS) n += BUFFERS[k].length * 4;
  return n;
}

// ---------------------------------------------------------------- envelope helpers

// §1.5: exponentialRampToValueAtTime can never target 0.
export function expOut(param, t, gain, dur) {
  param.exponentialRampToValueAtTime(Math.max(1e-4, gain * 0.001), t + dur);
  param.setValueAtTime(0, t + dur + 0.005);
}

// Attack-decay envelope. `loop` holds after the attack instead of decaying —
// a looping source behind a decayed gain node is silent but still running.
function ar(ctx, t0, gain, attack, dur, envTo, loop = false) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + attack);
  if (!loop) expOut(g.gain, t0 + attack, gain, dur);
  g.connect(envTo);
  return g;
}

function bufSource(ctx, name, rate, loop = false) {
  const s = ctx.createBufferSource();
  s.buffer = BUFFERS[name] || BUFFERS.white;
  s.playbackRate.value = rate;
  s.loop = loop;
  return s;
}

// Random slice of the noise bed, so no two bursts are the same sample run (§2.3).
const offsetOf = buf => Math.random() * Math.max(0, buf.duration - 1.05);

// §2.3/§2.8's random offset is NOT conditioned on `loop` — a looping source wraps
// at loopEnd, so any offset inside the buffer is legal and two loops started from
// the same JS task (two fluid clusters found on one sampling pass, four TNT fuses
// lit together) decorrelate instead of summing coherently at +6 dB.
const startOffset = (buf, loop) => (loop ? Math.random() * buf.duration : offsetOf(buf));

// ---------------------------------------------------------------- primitives

// §2.3 noiseBurst — digs, steps, breaks, rattles
export function noiseBurst(voice, t0, p) {
  const ctx = voice.ctx, pitch = p.pitch ?? 1;
  const src = bufSource(ctx, p.src || 'white', pitch, !!p.loop);
  const filt = ctx.createBiquadFilter();
  filt.type = p.filter === 'lp' ? 'lowpass' : p.filter === 'hp' ? 'highpass' : 'bandpass';
  filt.frequency.value = p.freq * pitch;
  filt.Q.value = p.Q ?? 1;
  const g = ar(ctx, t0, p.gain, p.attack ?? 0.002, p.dur, voice.envGain, !!p.loop);
  src.connect(filt); filt.connect(g);
  if (p.loop) { voice.mod = voice.mod || {}; voice.mod.burstGain = g.gain; }
  src.start(t0, startOffset(src.buffer, p.loop));
  const stop = t0 + p.dur + 0.02;
  if (!p.loop) src.stop(stop);
  voice.nodes.push(src);
  // A looping source has no end: returning a finite time would make the engine
  // release the voice while the source plays on, un-stoppable and audible into
  // whatever sound recycles the voice next.
  return p.loop ? Infinity : stop;
}

// §2.4 thud — impacts, falls, heavy landings
export function thud(voice, t0, p) {
  const ctx = voice.ctx, pitch = p.pitch ?? 1;
  const dur = p.dur ?? 0.12;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime((p.f0 ?? 160) * pitch, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, (p.f1 ?? 55) * pitch), t0 + dur);
  const g = ar(ctx, t0, p.gain, 0.002, dur, voice.envGain);
  osc.connect(g);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
  voice.nodes.push(osc);
  noiseBurst(voice, t0, {
    src: 'white', filter: 'lp', freq: 300, Q: 0.7,
    dur: dur * 0.7, gain: p.gain * (p.noiseGain ?? 0.4), pitch,
  });
  return t0 + dur + 0.02;
}

// §2.5 pluck — Karplus-Strong, baked; pitch comes free via playbackRate
export function pluck(voice, t0, p) {
  const ctx = voice.ctx, pitch = p.pitch ?? 1;
  // `??`, not `||`: the 110 Hz auto-pick is a DEFAULT, and a caller that wants one
  // bake across its whole range (§3.5's note-block guitar, 92.5-370 Hz) must be
  // able to say `bass: false` without the auto-pick flipping it back mid-scale.
  const bass = p.bass ?? (p.freq < 110);
  const base = bass ? 55 : 220;
  const src = bufSource(ctx, bass ? 'pluckBass' : 'pluckA', (p.freq / base) * pitch);
  const dur = p.dur ?? 0.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(p.gain, t0 + 0.003);
  expOut(g.gain, t0 + 0.003, p.gain, dur);
  g.connect(voice.envGain);
  if (p.lp) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = p.lp * pitch;
    src.connect(f); f.connect(g);
  } else {
    src.connect(g);
  }
  src.start(t0); src.stop(t0 + dur + 0.02);
  voice.nodes.push(src);
  return t0 + dur + 0.02;
}

// §2.6 blip — UI ticks, pops, small mechanics
export function blip(voice, t0, p) {
  const ctx = voice.ctx, pitch = p.pitch ?? 1;
  const dur = p.dur ?? 0.05;
  const osc = ctx.createOscillator();
  osc.type = p.wave || 'square';
  osc.frequency.setValueAtTime(p.freq * pitch, t0);
  if (p.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, p.f1 * pitch), t0 + dur);
  const g = ar(ctx, t0, p.gain, 0.002, dur, voice.envGain);
  osc.connect(g);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
  voice.nodes.push(osc);
  return t0 + dur + 0.02;
}

// §2.7 sweep — risers, zaps, fuses
export function sweep(voice, t0, p) {
  const ctx = voice.ctx, pitch = p.pitch ?? 1;
  const dur = p.dur;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(p.gain, t0 + dur * 0.1);
  g.gain.setValueAtTime(p.gain, t0 + dur * 0.8);
  expOut(g.gain, t0 + dur * 0.8, p.gain, dur * 0.2);
  g.connect(voice.envGain);

  if (p.src === 'noise') {
    const src = bufSource(ctx, 'white', pitch, !!p.loop);
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.Q.value = p.filter?.Q ?? 1;
    filt.frequency.setValueAtTime(p.f0 * pitch, t0);
    filt.frequency.exponentialRampToValueAtTime(Math.max(1, p.f1 * pitch), t0 + dur);
    src.connect(filt); filt.connect(g);
    src.start(t0, startOffset(src.buffer, p.loop));
    if (!p.loop) src.stop(t0 + dur + 0.02);
    voice.nodes.push(src);
  } else {
    const osc = ctx.createOscillator();
    osc.type = p.wave || 'sine';
    osc.frequency.setValueAtTime(p.f0 * pitch, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, p.f1 * pitch), t0 + dur);
    let tail = g;
    if (p.filter?.type) {
      const f = ctx.createBiquadFilter();
      f.type = p.filter.type === 'lp' ? 'lowpass' : p.filter.type === 'hp' ? 'highpass' : 'bandpass';
      f.frequency.value = (p.filter.freq ?? 900) * pitch;
      f.Q.value = p.filter.Q ?? 1;
      f.connect(g); tail = f;
    }
    osc.connect(tail);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
    voice.nodes.push(osc);
  }
  return p.loop ? Infinity : t0 + dur + 0.03;
}

// §2.8 crackle — fire, embers, creaks
export function crackle(voice, t0, p) {
  const ctx = voice.ctx, pitch = p.pitch ?? 1;
  const src = bufSource(ctx, 'impulses', p.density ?? 1, !!p.loop);
  const filt = ctx.createBiquadFilter();
  filt.type = 'bandpass';
  filt.frequency.value = (p.freq ?? 1800) * pitch;
  filt.Q.value = p.Q ?? 1.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(p.gain, t0 + 0.01);
  if (!p.loop) expOut(g.gain, t0 + 0.01, p.gain, p.dur);
  g.connect(voice.envGain);
  src.connect(filt); filt.connect(g);
  src.start(t0, startOffset(src.buffer, p.loop));
  const stop = t0 + (p.dur ?? 1) + 0.02;
  if (!p.loop) src.stop(stop);
  voice.nodes.push(src);
  voice.mod = voice.mod || {};
  voice.mod.crackleRate = src.playbackRate;
  voice.mod.crackleFreq = filt.frequency;
  return p.loop ? Infinity : stop;
}

// §2.9 drone — pads, portals, beacons, boss beds
export function drone(voice, t0, p) {
  const ctx = voice.ctx, pitch = p.pitch ?? 1;
  const mix = ctx.createGain();
  mix.gain.value = 1 / Math.max(1, p.freqs.length);
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = (p.lpFreq ?? 1200) * pitch;
  const g = ctx.createGain();
  const attack = p.attack ?? 0.5;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(p.gain, t0 + attack);
  mix.connect(filt); filt.connect(g); g.connect(voice.envGain);

  for (let i = 0; i < p.freqs.length; i++) {
    const osc = ctx.createOscillator();
    osc.type = (p.waves && p.waves[i]) || 'sawtooth';
    osc.frequency.value = p.freqs[i] * pitch;
    osc.connect(mix);
    osc.start(t0);
    // §2.9's release is setTargetAtTime(0, tEnd, 0.4); +1.6 s = 4 tau (e^-4 =
    // 0.018, inaudible) and matches the releaseAt this returns below. The old
    // +0.6 cut the saws at 1.5 tau — still at 0.22 of gain, an audible step —
    // and left the voice `busy` for a further second with nothing playing.
    if (!p.loop && p.dur) osc.stop(t0 + p.dur + 1.6);
    voice.nodes.push(osc);
  }
  if (p.lfo) {
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = p.lfo.rate;
    const amt = ctx.createGain();
    amt.gain.value = p.lfo.target === 'gain' ? p.lfo.depth * p.gain : p.lfo.depth * (p.lpFreq ?? 1200);
    lfo.connect(amt);
    amt.connect(p.lfo.target === 'gain' ? mix.gain : filt.frequency);
    lfo.start(t0);
    if (!p.loop && p.dur) lfo.stop(t0 + p.dur + 1.6);
    voice.nodes.push(lfo);
  }
  voice.mod = voice.mod || {};
  voice.mod.droneGain = g.gain;
  voice.mod.droneLp = filt.frequency;

  if (p.loop || !p.dur) return Infinity;
  g.gain.setTargetAtTime(0, t0 + p.dur, 0.4);
  return t0 + p.dur + 1.6;
}

// §2.10 chime — bells, sparkles, level-ups (2-op FM)
export function chime(voice, t0, p) {
  const ctx = voice.ctx, pitch = p.pitch ?? 1;
  const f = p.freq * pitch, dur = p.dur ?? 1.2;
  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.value = f;

  const mod = ctx.createOscillator();
  mod.type = 'sine';
  mod.frequency.value = f * (p.ratio ?? 3.53);
  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(f * (p.index ?? 3), t0);
  modGain.gain.exponentialRampToValueAtTime(1, t0 + dur * 0.7);
  mod.connect(modGain);
  modGain.connect(carrier.frequency);            // AudioParam connection = FM

  const g = ar(ctx, t0, p.gain, 0.003, dur, voice.envGain);
  carrier.connect(g);
  carrier.start(t0); carrier.stop(t0 + dur + 0.02);
  mod.start(t0); mod.stop(t0 + dur + 0.02);
  voice.nodes.push(carrier, mod);

  // §2.10's pack is `{ ..., partial2=0.3 }` — a DEFAULT, not an opt-in. The
  // non-integer ratio is what gives struck metal/glass its inharmonic clang.
  const partial2 = p.partial2 ?? 0.3;
  if (partial2 > 0) {
    const p2 = ctx.createOscillator();
    p2.type = 'sine';
    p2.frequency.value = f * (p.partialRatio ?? 2.76);
    const g2 = ar(ctx, t0, p.gain * partial2, 0.003, dur, voice.envGain);
    p2.connect(g2);
    p2.start(t0); p2.stop(t0 + dur + 0.02);
    voice.nodes.push(p2);
  }
  return t0 + dur + 0.03;
}

// §2.11 hiss — fuses, air, hats
export function hiss(voice, t0, p) {
  const ctx = voice.ctx, pitch = p.pitch ?? 1;
  const src = bufSource(ctx, 'white', pitch, !!p.loop);
  const filt = ctx.createBiquadFilter();
  filt.type = p.filter === 'bp' ? 'bandpass' : 'highpass';
  filt.frequency.value = (p.freq ?? 6000) * pitch;
  filt.Q.value = p.Q ?? 0.7;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(p.gain, t0 + 0.005);
  if (!p.loop) g.gain.linearRampToValueAtTime(0, t0 + p.dur);   // §2.11 linear decay
  g.connect(voice.envGain);
  src.connect(filt); filt.connect(g);
  src.start(t0, startOffset(src.buffer, p.loop));
  const stop = t0 + (p.dur ?? 1) + 0.02;
  if (!p.loop) src.stop(stop);
  voice.nodes.push(src);
  voice.mod = voice.mod || {};
  voice.mod.hissFreq = filt.frequency;
  voice.mod.hissGain = g.gain;
  return p.loop ? Infinity : stop;
}

// §2.12 gulp — eating, drinking, bubbles, squelches
const WOBBLE = new Float32Array(3);          // §1.6: module-scope reuse
export function gulp(voice, t0, p) {
  const ctx = voice.ctx, pitch = p.pitch ?? 1;
  const dur = p.dur ?? 0.12;
  const w = p.wobble || [300, 180, 260];
  WOBBLE[0] = w[0] * pitch; WOBBLE[1] = w[1] * pitch; WOBBLE[2] = w[2] * pitch;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueCurveAtTime(WOBBLE, t0, dur * 0.8);
  const g = ar(ctx, t0, p.gain, 0.005, dur, voice.envGain);
  osc.connect(g);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
  voice.nodes.push(osc);
  noiseBurst(voice, t0, {
    src: 'white', filter: 'lp', freq: 600, Q: 1,
    dur: dur * 0.6, gain: p.gain * 0.5, pitch,
  });
  return t0 + dur + 0.02;
}

// §2.13 whoosh — flybys, wind, wings, travel
export function whoosh(voice, t0, p) {
  const ctx = voice.ctx, pitch = p.pitch ?? 1;
  const dur = p.dur;
  // §2.13's pack names f0/f1 with no defaults. AudioParam's IDL takes a RESTRICTED
  // float, so a missing one would throw TypeError on NaN and take the whole recipe
  // (every layer of it) down with it — these fallbacks are the belt to the recipes'
  // braces, never a substitute for a recipe passing its own band.
  const f0 = p.f0 ?? 900, f1 = p.f1 ?? 300;
  const src = bufSource(ctx, p.src || 'white', pitch, !!p.loop);
  const filt = ctx.createBiquadFilter();
  filt.type = 'bandpass';
  filt.Q.value = p.Q ?? 0.8;
  filt.frequency.setValueAtTime(f0 * pitch, t0);
  if (!p.loop) filt.frequency.exponentialRampToValueAtTime(Math.max(1, f1 * pitch), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  if (p.loop) {
    g.gain.linearRampToValueAtTime(p.gain, t0 + 0.3);
  } else {
    g.gain.linearRampToValueAtTime(p.gain, t0 + dur * 0.4);     // swell up 40%
    g.gain.linearRampToValueAtTime(0, t0 + dur);                // down 60%
  }
  g.connect(voice.envGain);
  src.connect(filt); filt.connect(g);
  src.start(t0, startOffset(src.buffer, p.loop));
  const stop = t0 + (p.loop ? 1 : dur) + 0.02;
  if (!p.loop) src.stop(stop);
  voice.nodes.push(src);
  voice.mod = voice.mod || {};
  voice.mod.whooshFreq = filt.frequency;       // §3.5 elytra/wind per-frame drive
  voice.mod.whooshGain = g.gain;
  return p.loop ? Infinity : stop;
}

export const PRIMS = {
  noiseBurst, thud, pluck, blip, sweep, crackle, drone, chime, hiss, gulp, whoosh,
};
