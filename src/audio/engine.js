// Audio engine: context lifecycle, master graph, buses, listener sync, voice
// pool, emitSound (16 §1). The ONLY audio entry point for gameplay code is
// emitSound/startLoop (§5.1) — callable from tick code only, never render.
import * as THREE from 'three';
import { bakeBuffers, bakedBytes } from './primitives.js';
import { EVENTS, P, resolveEvent } from './events.js';
import { Ambience } from './ambience.js';
import { Music } from './music.js';
import { loadOptions, busGain } from '../ui/options.js';
import { STATE } from '../constants.js';

const POSITIONAL_VOICES = 24;
const FLAT_VOICES = 8;
const VOICE_STARTS_PER_TICK = 16;      // §1.4 global throttle
const COMPRESSOR = { threshold: -18, knee: 24, ratio: 6, attack: 0.003, release: 0.25 };
const BUS_NAMES = ['sfx', 'ambient', 'music', 'ui'];

// options slider key -> bus
const SLIDER_OF = { sfx: 'sfx', ambient: 'ambient', music: 'music', ui: 'ui' };

class Voice {
  constructor(ctx, positional) {
    this.ctx = ctx;
    this.envGain = ctx.createGain();
    this.panner = null;
    if (positional) {
      this.panner = new PannerNode(ctx, {
        panningModel: 'equalpower',      // §1.3 decision: not HRTF
        distanceModel: 'inverse',
        refDistance: 1,
        maxDistance: 24,
        rolloffFactor: 1,
        coneInnerAngle: 360,
      });
      this.envGain.connect(this.panner);
    }
    this.tail = this.panner || this.envGain;
    this.busy = false;
    this.startTime = 0;
    this.releaseAt = 0;
    this.priority = 0;
    this.capKey = null;
    this.tracked = null;                // entity | {x,y,z} | null
    this.dist = 0;
    this.nodes = [];                    // fire-and-forget sources, for steal-stop
    this.mod = null;                    // primitive-exposed AudioParams (loops)
    this.bus = null;
    this.loop = false;
    this.eventId = null;
    this.extra = null;                  // per-voice filter (explosion muffle)
    // Bumped on every release. A handle captures the gen it was issued for, so a
    // recycled voice can never be mistaken for the caller's own still-live loop.
    this.gen = 0;
  }
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.buses = {};
    this.masterGain = null;
    this.voices = [];
    this.flat = [];
    this.positional = [];
    this.starts = 0;                    // per-tick throttle counter
    this.drops = 0;
    this.dropsThisSecond = 0;
    this._dropWindow = 0;
    this.opts = loadOptions();
    this.listenerPos = { x: 0, y: 0, z: 0 };
    this.game = null;
    this.music = null;
    this.ambience = null;
    this.unknown = new Set();
    this.duckUntil = 0;
    this.themeMusic = null;             // §4A layer, wired by main.js
    this._tickCount = 0;
    this.debug = { voices: 0, drops: 0, state: 'none', budgetMs: 0 };
  }

  // §1.1 boot — called from main.js during LOADING, after atlas build.
  boot() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) { console.warn('[audio] Web Audio unavailable — running silent'); return; }
    this.ctx = new Ctor({ latencyHint: 'interactive' });   // starts 'suspended' pre-gesture
    bakeBuffers(this.ctx);
    this.buildGraph();
    this.ctx.onstatechange = () => {
      // Safari's nonstandard 'interrupted' is treated as suspended (§1.1)
      this.debug.state = this.ctx.state;
    };
    // AMENDS 01 §15.2 wants onPause on "PAUSED incl. visibilitychange → hidden",
    // but main.js's visibilitychange only calls setState when state === PLAYING —
    // so hiding the tab on TITLE/PAUSED/PLAYING_UI/DEAD would never reach a
    // setState-only hook and audio would keep playing in a hidden tab. Own the
    // listener here instead, and never un-mute a deliberately PAUSED game.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.onPause(); this.themeMusic?.onPause?.(); }
      else if (this.game?.state !== STATE.PAUSED) { this.onResume(); this.themeMusic?.onResume?.(); }
    });
    this.music = new Music(this);
    this.ambience = new Ambience(this);
    this.ready = true;
    this.debug.state = this.ctx.state;
    this.debug.bakedMB = +(bakedBytes() / 1e6).toFixed(2);
  }

  buildGraph() {
    const ctx = this.ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = COMPRESSOR.threshold;
    comp.knee.value = COMPRESSOR.knee;
    comp.ratio.value = COMPRESSOR.ratio;
    comp.attack.value = COMPRESSOR.attack;
    comp.release.value = COMPRESSOR.release;
    comp.connect(ctx.destination);
    this.compressor = comp;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = busGain(this.opts.master);
    this.masterGain.connect(comp);

    for (const name of BUS_NAMES) {
      const g = ctx.createGain();
      g.gain.value = busGain(this.opts[SLIDER_OF[name]]);
      g.connect(this.masterGain);
      this.buses[name] = g;
    }

    for (let i = 0; i < POSITIONAL_VOICES; i++) {
      const v = new Voice(ctx, true);
      this.voices.push(v); this.positional.push(v);
    }
    for (let i = 0; i < FLAT_VOICES; i++) {
      const v = new Voice(ctx, false);
      this.voices.push(v); this.flat.push(v);
    }
  }

  // ---------------------------------------------------------------- lifecycle (§1.1)

  // Idempotent + cheap: call from EVERY gesture handler, don't track "first click".
  unlock() {
    if (!this.ctx) return;
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  onPause() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    this.masterGain.gain.setTargetAtTime(0, now, 0.02);   // 80 ms fade, tau 0.02
    clearTimeout(this._suspendTimer);
    this._suspendTimer = setTimeout(() => {
      if (this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
    }, 150);                                              // suspend AFTER the fade
  }

  onResume() {
    if (!this.ctx) return;
    clearTimeout(this._suspendTimer);
    const restore = () => {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.linearRampToValueAtTime(busGain(this.opts.master), now + 0.15);
    };
    if (this.ctx.state !== 'running') this.ctx.resume().then(restore).catch(() => {});
    else restore();
  }

  // ---------------------------------------------------------------- options (§1.2)

  setOptions(opts) {
    this.opts = opts;
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this.masterGain.gain.setTargetAtTime(busGain(opts.master), now, 0.03);
    for (const name of BUS_NAMES) {
      // the music bus may be ducked (§4.3) — duck logic re-reads opts, so only
      // write it directly when no duck is in flight
      if (name === 'music' && now < this.duckUntil) continue;
      this.buses[name].gain.setTargetAtTime(busGain(opts[SLIDER_OF[name]]), now, 0.03);
    }
    this.music?.onOptions(opts);
  }

  musicBusTarget() { return busGain(this.opts.music); }

  // §4.3 damage ducking: musicBus -6 dB for 3 s, recover with tau 0.5
  duck() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const bus = this.buses.music.gain;
    bus.cancelScheduledValues(now);
    bus.setTargetAtTime(this.musicBusTarget() * 0.5, now, 0.15);
    this.duckUntil = now + 3;
    clearTimeout(this._duckTimer);
    this._duckTimer = setTimeout(() => {
      const t = this.ctx.currentTime;
      this.buses.music.gain.setTargetAtTime(this.musicBusTarget(), t, 0.5);
      this.duckUntil = 0;
    }, 3000);
  }

  // ---------------------------------------------------------------- voice pool (§1.4)

  acquire(positional, priority, capKey, cap) {
    const pool = positional ? this.positional : this.flat;

    // per-event concurrency cap: at cap -> steal the oldest OF THAT FAMILY
    // (not a drop — §1.4: newest information wins).
    // Count the family across BOTH sub-pools (item.bow.shoot is flat for the
    // player and positional for skeletons, one capKey), but only ever hand back
    // a voice from the requested pool — returning a positional voice to a flat
    // emit would replay it at whatever 3D position the stolen voice still held.
    if (capKey) {
      let n = 0, oldest = null;
      for (const v of this.voices) {
        if (!v.busy || v.capKey !== capKey) continue;
        n++;
        if (pool.includes(v) && (!oldest || v.startTime < oldest.startTime)) oldest = v;
      }
      if (n >= cap && oldest) { this.steal(oldest); return oldest; }
    }

    for (const v of pool) if (!v.busy) return v;

    // pool exhausted: steal the oldest busy voice of STRICTLY lower priority
    let victim = null;
    for (const v of pool) {
      if (v.loop) continue;                       // loops are owned by their holder
      if (v.priority >= priority) continue;
      if (!victim || v.startTime < victim.startTime) victim = v;
    }
    if (victim) { this.steal(victim); return victim; }
    this.drops++; this.dropsThisSecond++;
    return null;                                  // drop the new sound (§1.4)
  }

  // §1.4: fade 5 ms, then stop. The fade lands entirely BEFORE t0 (= now + 5 ms,
  // §1.5's guard), so the stealing emit's `setValueAtTime(1, t0)` cannot cancel
  // it — which would have reinstated the very click this exists to prevent.
  steal(v) {
    const now = this.ctx.currentTime;
    v.envGain.gain.cancelScheduledValues(now);
    v.envGain.gain.setValueAtTime(v.envGain.gain.value, now);
    v.envGain.gain.linearRampToValueAtTime(0, now + 0.004);
    for (const n of v.nodes) { try { n.stop(now + 0.005); } catch { /* already stopped */ } }
    this.release(v, true);
  }

  release(v, stolen = false) {
    try { v.tail.disconnect(); } catch { /* not connected */ }
    if (v.extra) { try { v.extra.disconnect(); } catch { /* */ } v.extra = null; }
    if (!stolen) {
      const now = this.ctx.currentTime;
      v.envGain.gain.cancelScheduledValues(now);
    }
    v.nodes.length = 0;
    v.mod = null;
    v.busy = false;
    v.loop = false;
    v.tracked = null;
    v.capKey = null;
    v.eventId = null;
    v.gen++;
  }

  // ---------------------------------------------------------------- emit (§5.1)

  emitSound(eventId, pos = null, pitchMult = 1, gainMult = 1) {
    // 14 §12 (16 interop) — the HOST relays positional world sounds to nearby
    // clients (opaque event id). Client-replayed sounds set _relaying to avoid a
    // loop. Runs before the pre-gesture drop so a muted host still broadcasts.
    if (this.game?.net?.isHost && pos && !this._relaying) {
      const rdef = resolveEvent(eventId);
      if (rdef?.replicate) this.game.net.broadcastSound(eventId, pos.x, pos.y, pos.z, pitchMult, gainMult);
    }
    if (!this.ready || this.ctx.state !== 'running') return null;   // pre-gesture: drop
    const def = resolveEvent(eventId);
    if (!def) {
      if (!this.unknown.has(eventId)) {
        this.unknown.add(eventId);
        console.warn('[audio] unknown event', eventId);
      }
      return null;
    }
    if (this.starts >= VOICE_STARTS_PER_TICK) { this.drops++; this.dropsThisSecond++; return null; }

    // `distanceOnly` events (thunder) measure distance but render unpanned and
    // are never culled — the whole map hears the storm.
    const panned = !!pos && !def.distanceOnly;
    let dist = 0;
    if (pos) {
      const l = this.listenerPos;
      dist = Math.hypot(pos.x - l.x, pos.y - l.y, pos.z - l.z);
      // §1.3 cull radius = maxDistance, checked BEFORE voice allocation
      if (panned && dist > (def.maxDist ?? 16)) return null;
    }

    // priority: self (no pos) is upgraded to PLAYER automatically (§3 schema)
    let priority = def.priority ?? (panned ? (dist < 16 ? P.NEAR : P.FAR) : P.PLAYER);
    if (!panned && priority < P.PLAYER && def.bus !== 'ui') priority = P.PLAYER;
    if (def.bus === 'ui') priority = P.UI;

    const v = this.acquire(panned, priority, def.capKey, def.cap ?? 2);
    if (!v) return null;

    // §2.2 global variation
    let pm = pitchMult, gm = gainMult;
    if (def.jitter !== 0) {
      pm *= Math.pow(2, (Math.random() * 0.3 - 0.15));
      gm *= 0.85 + Math.random() * 0.15;
    }

    const t0 = this.ctx.currentTime + 0.005;    // §1.5 5 ms guard
    v.busy = true;
    v.startTime = t0;
    v.priority = priority;
    v.capKey = def.capKey || null;
    v.eventId = eventId;
    v.dist = dist;
    v.loop = !!def.loop;
    // envGain is the voice's FADE handle (steal/stop/loop release), not a volume
    // stage: gm is already applied inside the recipe, which receives it as `g`.
    // Setting it here too would square gainMult — a 10-damage fall would peak at
    // 3.5 instead of 1.44 and slam the limiter.
    // Both writes are AT t0, never `now`: a steal in flight is fading to 0 across
    // [now, now+4ms] and must be allowed to finish. Every recipe's own envelope
    // also starts at 0 at t0, so restoring unity gain there is silent.
    v.envGain.gain.cancelScheduledValues(t0);
    v.envGain.gain.setValueAtTime(1, t0);

    let tail = v.tail;
    if (def.muffle && panned) {
      // §3.5 explosion distance muffle: per-voice extra LP
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(6000, Math.max(200, 6000 * Math.pow(12 / Math.max(dist, 12), 1.5)));
      v.tail.connect(lp);
      v.extra = lp;
      tail = lp;
    }

    if (panned && v.panner) {
      v.panner.refDistance = def.refDist ?? 1;
      v.panner.maxDistance = def.maxDist ?? 16;
      v.panner.positionX.value = pos.x;
      v.panner.positionY.value = pos.y;
      v.panner.positionZ.value = pos.z;
    }
    tail.connect(this.buses[def.bus || 'sfx']);
    v.bus = def.bus || 'sfx';

    let stopAt;
    try {
      stopAt = def.recipe(v, t0, pm, gm);
    } catch (err) {
      console.warn('[audio] recipe failed', eventId, err);
      this.release(v);
      return null;
    }
    v.releaseAt = Number.isFinite(stopAt) ? stopAt : Infinity;
    this.starts++;
    return v.loop ? this.handleFor(v) : null;    // §5.1: handles only for loops
  }

  // §5.1 startLoop(eventId, target) -> handle. target: {x,y,z} | entity | null
  startLoop(eventId, target = null) {
    const pos = !target ? null
      : (typeof target.x === 'number' ? target : (target.pos ?? null));
    const h = this.emitSound(eventId, pos, 1, 1);
    if (h && target && target.pos) h.voice.tracked = target;   // entity-tracked
    return h;
  }

  handleFor(v) {
    const engine = this;
    const gen = v.gen;
    const mine = () => v.busy && v.gen === gen;
    return {
      voice: v,
      get alive() { return mine(); },
      setParam(name, value, tau = 0.05) {
        if (!mine() || !v.mod || !v.mod[name]) return;
        v.mod[name].setTargetAtTime(value, engine.ctx.currentTime, tau);
      },
      setPosition(x, y, z) {
        if (!mine() || !v.panner) return;
        v.panner.positionX.value = x;
        v.panner.positionY.value = y;
        v.panner.positionZ.value = z;
      },
      stop(fadeSec = 0.4) {
        if (!mine()) return;
        const now = engine.ctx.currentTime;
        v.envGain.gain.cancelScheduledValues(now);
        v.envGain.gain.setValueAtTime(v.envGain.gain.value, now);
        v.envGain.gain.setTargetAtTime(0, now, Math.max(0.01, fadeSec * 0.25));
        for (const n of v.nodes) { try { n.stop(now + fadeSec); } catch { /* */ } }
        v.releaseAt = now + fadeSec + 0.05;
        v.loop = false;                         // now stealable / releasable
      },
    };
  }

  // ---------------------------------------------------------------- frame + tick

  // AMENDS 01 §3 render step 6. Listener from the INTERPOLATED camera.
  updateFrame(camera) {
    if (!this.ready) return;
    const t0 = performance.now();
    const now = this.ctx.currentTime;

    // §1.4's throttle window is the game tick, and audio.tick() is reset there —
    // but Game.tick() early-returns while world is null, so on the title screen
    // `starts` would climb to 16 and never clear, silencing every menu click for
    // the rest of the session. Mirror that exact guard here.
    if (!this.game?.world) this.starts = 0;

    if (camera) {
      const p = camera.position;
      this.listenerPos.x = p.x; this.listenerPos.y = p.y; this.listenerPos.z = p.z;
      const l = this.ctx.listener;
      // camera looks down -Z in its own space; up is +Y
      _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
      _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      if (l.positionX) {
        l.positionX.value = p.x; l.positionY.value = p.y; l.positionZ.value = p.z;
        l.forwardX.value = _fwd.x; l.forwardY.value = _fwd.y; l.forwardZ.value = _fwd.z;
        l.upX.value = _up.x; l.upY.value = _up.y; l.upZ.value = _up.z;
      } else {
        l.setPosition(p.x, p.y, p.z);
        l.setOrientation(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
      }
    }

    // release finished one-shots; follow tracked loops
    for (const v of this.voices) {
      if (!v.busy) continue;
      if (v.releaseAt <= now) { this.release(v); continue; }
      if (v.tracked && v.panner) {
        const p = v.tracked.pos || v.tracked;
        v.panner.positionX.value = p.x;
        v.panner.positionY.value = p.y;
        v.panner.positionZ.value = p.z;
      }
    }

    this.music?.updateFrame(now);
    this.debug.budgetMs = performance.now() - t0;
    this.debug.state = this.ctx.state;
  }

  // AMENDS 01 §3 tick step 10 (after saveManager.tick()).
  tick() {
    if (!this.ready) return;
    this.starts = 0;                    // reset the per-tick throttle
    this._tickCount++;
    let n = 0;
    for (const v of this.voices) if (v.busy) n++;
    this.debug.voices = n;
    if (++this._dropWindow >= 20) {
      this._dropWindow = 0;
      this.debug.drops = this.dropsThisSecond;
      this.dropsThisSecond = 0;
    }
    this.ambience?.tick(this._tickCount);
    this.music?.tick(this._tickCount);
  }

  poolSize() { return this.voices.length; }
}

// scratch vectors for listener orientation (§1.6: no per-frame allocation)
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();

export const audio = new AudioEngine();
export const emitSound = (id, pos, pitch, gain) => audio.emitSound(id, pos, pitch, gain);
export const startLoop = (id, target) => audio.startLoop(id, target);

// Scratch position for emit sites (§1.6: no allocation in the emit path).
// Safe to share because emitSound reads pos synchronously and never retains it —
// only `tracked` entity refs are held, and those are real entities.
const _pos = { x: 0, y: 0, z: 0 };
export function at(x, y, z) { _pos.x = x; _pos.y = y; _pos.z = z; return _pos; }
