// Theme-music layer — the single file-based music module (16-AUDIO §4A), shared
// by the title screen (19-MAIN-MENU §4) and, later, the soft in-game background.
// Everything else in the audio system is synthesized; this layer is 16-AUDIO
// §5's one scoped exception. The playlist comes from whatever audio sits in
// public/theme-music/ (see scripts/gen-theme-manifest.mjs).
//
// E1 (16-AUDIO) is built and main.js constructs this with E1's { context, musicBus }
// (`externalBus`), so in every real path we ride E1's graph and never touch its
// gain (E1 owns the §4.3 damage-duck on musicBus — see duck()). The local
// _buildFallbackGraph() below is a byte-for-byte subset of 16 §1.2's chain,
// retained only as a defensive path for a caller that passes no bus:
//   themeSource → themeGain → musicBus → masterGain → compressor → destination
import { THEME_TRACKS } from './themeManifest.js';
import { busGain } from '../ui/options.js';

// ---- §4A.2 constants, quoted from spec ----
const FADE_IN = 1.5;                                  // "in 1.5 s"
const FADE_OUT = 0.8;                                 // "out 0.8 s"
const HANDOFF_FADE = 1.0;                             // §4A.3 "fade ... out ~1 s"
export const TITLE_GAIN = 0.45;                       // "themeGain ≈ 0.45"
export const WORLD_GAIN = 0.30;                       // "≈ 0.28–0.32 (approx)"
const titleGap = () => 10 + Math.random() * 10;       // "10–20 s random"
const worldGap = () => 180 + Math.random() * 240;     // "180 + rng()×240"

// §1.2 compressor — identical constants to E1's engine.js so its graph is a superset
const COMPRESSOR = { threshold: -18, knee: 24, ratio: 6, attack: 0.003, release: 0.25 };

// §4A.1 memory guard. The spec's "decode up to N (default 6)" says N *short*
// tracks — "short" is load-bearing: 6 × 3-min stereo @48k decodes to ~414 MB of
// Float32 PCM. Gate on bytes as well as count; anything bigger streams.
const DECODE_MAX = 6;
const DECODE_MAX_BYTES = 2.5e6;      // (approx) per-track "short" ceiling
const DECODE_BUDGET_BYTES = 96e6;    // (approx) resident PCM ceiling

const clamp01 = v => Math.min(1, Math.max(0, v));
const pcmBytes = b => b.duration * b.sampleRate * b.numberOfChannels * 4;

/** Fisher–Yates (§4A.2). */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class ThemeMusic {
  /**
   * @param {object} [opts]
   * @param {AudioContext} [opts.context]  E1's context; else one is made on unlock
   * @param {GainNode}     [opts.musicBus] E1's musicBus; else a local fallback chain
   * @param {string[]}     [opts.tracks]   defaults to the generated manifest
   */
  constructor({ context, musicBus, tracks = THEME_TRACKS } = {}) {
    this.ctx = context ?? null;
    this.musicBus = musicBus ?? null;
    this.externalBus = !!musicBus;      // E1 owns it → never write its gain
    this.ownsContext = !context;
    this.tracks = (tracks ?? []).slice();

    this.themeGain = null;
    this.masterGain = null;
    this.buffers = new Map();          // url → AudioBuffer, held in RAM (§4A.1)
    this.streams = new Map();          // url → { el, src } for oversized tracks
    this.pcmUsed = 0;
    this.node = null;                  // the one live source (§4A.2 budget ≤ 2)
    this.order = [];
    this.index = 0;
    this.lastPlayed = null;
    this.gapTimer = null;
    this.endTimer = null;
    this.running = false;
    // Bumped by every start()/stop(). Any async continuation that resumed after
    // a newer call must not touch state — stop()'s tail waits a full second for
    // its fade, and a start() arriving inside that window would otherwise be
    // torn down (silencing the menu for the rest of the session).
    this.epoch = 0;
    this.level = TITLE_GAIN;
    this.opts = { master: 100, music: 70 };
    this.inFlight = new Map();     // url → Promise, so concurrent _load()s dedupe
    // Only self-manage visibility while we own the context. Once 16-AUDIO E1
    // passes { context, musicBus }, the engine drives onPause/onResume — two
    // listeners would race our themeGain fade against its masterGain ramp.
    if (this.ownsContext) {
      this._onVisibility = () => (document.hidden ? this.onPause() : this.onResume());
      document.addEventListener('visibilitychange', this._onVisibility);
    }
  }

  /** False when the manifest is empty — e.g. a shipped build with no cleared tracks. */
  get available() { return this.tracks.length > 0; }

  // ------------------------------------------------------------ graph (§1.2)

  _buildFallbackGraph() {
    const compressor = this.ctx.createDynamicsCompressor();
    for (const [k, v] of Object.entries(COMPRESSOR)) compressor[k].value = v;
    compressor.connect(this.ctx.destination);
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(compressor);
    this.musicBus = this.ctx.createGain();
    this.musicBus.connect(this.masterGain);
  }

  /** Idempotent; call from every gesture handler (16 §1.1 `unlock`). */
  unlock() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    }
    if (!this.musicBus) this._buildFallbackGraph();
    if (!this.themeGain) {
      this.themeGain = this.ctx.createGain();
      this.themeGain.gain.value = 0.0001;
      this.themeGain.connect(this.musicBus);
      this._applyLevels();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  _applyLevels() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.masterGain) this.masterGain.gain.setTargetAtTime(busGain(this.opts.master), t, 0.03);
    // only drive musicBus while it is ours — E1 owns it (and §4.3's duck) otherwise
    if (this.musicBus && !this.externalBus) {
      this.musicBus.gain.setTargetAtTime(busGain(this.opts.music), t, 0.03);
    }
  }

  /** Options wiring (§3.2 / §15.3) — live, no restart. Sliders are 0–100. */
  setOptions({ master, music } = {}) {
    if (master !== undefined) this.opts.master = master;
    if (music !== undefined) this.opts.music = music;
    this._applyLevels();
  }

  /** §4.3 damage-duck hook — a no-op stand-in until E1 owns musicBus. */
  duck(_amount, _seconds) { /* E1's damage pipeline drives musicBus directly */ }

  // ------------------------------------------------------------ loading (§4A.1)

  _url(track) {
    // manifest paths are BASE_URL-relative; resolve against the document so this
    // works in dev, `vite preview`, and under a subpath deploy (base:'./')
    return new URL(import.meta.env.BASE_URL + track, document.baseURI).href;
  }

  _drop(track, why) {
    console.warn(`[themeMusic] skipping ${track}: ${why}`);
    this.tracks = this.tracks.filter(t => t !== track);
    this.order = this.order.filter(t => t !== track);
  }

  /** fetch → decodeAudioData → AudioBuffer in RAM; oversized tracks stream instead. */
  _load(track) {
    if (this.buffers.has(track) || this.streams.has(track)) return Promise.resolve();
    // dedupe: _preload()'s lazy walk and _playNext() can ask for the same track
    // at once, which would double-fetch and double-count it against the budget
    let p = this.inFlight.get(track);
    if (!p) {
      p = this._loadNow(track).finally(() => this.inFlight.delete(track));
      this.inFlight.set(track, p);
    }
    return p;
  }

  async _loadNow(track) {
    const url = this._url(track);

    let bytes = Infinity;
    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (!head.ok) return this._drop(track, `HTTP ${head.status}`);
      bytes = Number(head.headers.get('content-length')) || Infinity;
    } catch (err) {
      return this._drop(track, err.message);
    }

    const canDecode = this.buffers.size < DECODE_MAX &&
                      bytes <= DECODE_MAX_BYTES &&
                      this.pcmUsed < DECODE_BUDGET_BYTES;
    if (!canDecode) {
      const el = new Audio();
      el.preload = 'none';        // stream on demand — do not pull 100 MB at boot
      el.src = url;
      this.streams.set(track, { el, src: null });
      return;
    }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.buffers.set(track, buf);
      this.pcmUsed += pcmBytes(buf);
    } catch (err) {
      this._drop(track, err.message);
    }
  }

  /** First track eagerly so the menu is audible fast; the rest lazily (§4A.1). */
  async _preload() {
    if (!this.order.length) return;
    await this._load(this.order[0]);
    (async () => {
      for (const t of this.order.slice(1)) {
        if (!this.running) return;
        await this._load(t);
      }
    })();
  }

  // ------------------------------------------------------------ playback

  _nextTrack() {
    if (this.index >= this.order.length) {
      const next = shuffle(this.tracks);
      // never the same track twice in a row across reshuffles (§4A.2)
      if (next.length > 1 && next[0] === this.lastPlayed) {
        [next[0], next[next.length - 1]] = [next[next.length - 1], next[0]];
      }
      this.order = next;
      this.index = 0;
    }
    return this.order[this.index++];
  }

  _fade(to, seconds) {
    if (!this.themeGain) return;
    const p = this.themeGain.gain;
    const now = this.ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(Math.max(p.value, 0.0001), now);
    p.exponentialRampToValueAtTime(Math.max(to, 0.0001), now + seconds);
  }

  async _playNext(attempt = 0) {
    if (!this.running || !this.available) return;
    const epoch = this.epoch;
    const track = this._nextTrack();
    if (!track) return;
    await this._load(track);
    if (!this.running || epoch !== this.epoch) return;
    if (!this.buffers.has(track) && !this.streams.has(track)) {
      // dropped mid-load — try the next, but never spin forever if all fail
      return attempt < this.tracks.length ? this._playNext(attempt + 1) : undefined;
    }
    this.lastPlayed = track;
    this._stopNode();

    let durationMs;
    const buf = this.buffers.get(track);
    if (buf) {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.themeGain);
      src.start();
      this.node = { kind: 'buffer', src };   // one-shot, recreated per play (§4A.3)
      durationMs = buf.duration * 1000;
    } else {
      const entry = this.streams.get(track);
      // MediaElementSource can only be created once per element — cache it
      entry.src ??= this.ctx.createMediaElementSource(entry.el);
      entry.src.connect(this.themeGain);
      entry.el.currentTime = 0;
      try { await entry.el.play(); } catch { return this._scheduleNext(0); }
      // play() is async: stop() may have landed while it resolved, which would
      // leave this <audio> playing with no way to reach it again
      if (!this.running || epoch !== this.epoch) {
        entry.el.pause();
        entry.src.disconnect();
        return;
      }
      this.node = { kind: 'stream', ...entry };
      durationMs = (Number.isFinite(entry.el.duration) ? entry.el.duration : 180) * 1000;
    }

    this._fade(this.level, FADE_IN);
    // Deadline on the AUDIO clock, not the wall clock: ctx.currentTime freezes
    // while the context is suspended, so a tab switch would otherwise eat into
    // the track and cut it short by however long the tab was hidden.
    this.fadeOutAtCtx = this.ctx.currentTime + Math.max(0, durationMs / 1000 - FADE_OUT);
    this._armEndTimer();
  }

  _armEndTimer() {
    clearTimeout(this.endTimer);
    if (!this.running || this.fadeOutAtCtx == null) return;
    const remainingMs = Math.max(0, (this.fadeOutAtCtx - this.ctx.currentTime) * 1000);
    this.endTimer = setTimeout(() => {
      if (!this.running) return;
      this._fade(0, FADE_OUT);              // soft exit, never a hard cut
      this._scheduleNext(FADE_OUT * 1000);
    }, remainingMs);
  }

  _scheduleNext(afterMs) {
    clearTimeout(this.gapTimer);
    if (!this.running) return;   // a cleared timer must not come back after stop()
    const epoch = this.epoch;
    const gap = (this.inGame ? worldGap() : titleGap()) * 1000;   // audible pause (§4.3)
    this.gapTimer = setTimeout(() => {
      if (!this.running || epoch !== this.epoch) return;
      this._stopNode();
      this._playNext();
    }, afterMs + gap);
  }

  _stopNode() {
    const n = this.node;
    this.node = null;
    if (!n) return;
    try {
      if (n.kind === 'buffer') { n.src.stop(); n.src.disconnect(); }
      else { n.el.pause(); n.src.disconnect(); }
    } catch { /* already stopped/disconnected */ }
  }

  // ------------------------------------------------------------ lifecycle (§4A.3)

  /** Start on a user gesture. `context` picks the title vs in-game profile. */
  async start({ context = 'title' } = {}) {
    if (this.running || !this.available) return;
    const epoch = ++this.epoch;
    this.inGame = context === 'game';
    this.level = this.inGame ? WORLD_GAIN : TITLE_GAIN;
    this.running = true;
    this.unlock();
    this.order = shuffle(this.tracks);
    this.index = 0;
    await this._preload();
    if (this.running && epoch === this.epoch) this._playNext();
  }

  /** Menu → world load: fade out ~1 s and suspend. */
  async stop({ fade = HANDOFF_FADE } = {}) {
    if (!this.running) return;
    const epoch = ++this.epoch;
    this.running = false;
    clearTimeout(this.gapTimer);
    clearTimeout(this.endTimer);
    this._fade(0, fade);
    await new Promise(r => setTimeout(r, fade * 1000));
    // a start() during the fade owns the player now — leave it alone
    if (epoch !== this.epoch) return;
    this._stopNode();
    if (this.ownsContext && this.ctx?.state === 'running') this.ctx.suspend().catch(() => {});
  }

  /** 16 §1.1 — tab hidden: fade to 0 then suspend. */
  onPause() {
    if (!this.running || !this.themeGain) return;
    this._fade(0, 0.25);
    clearTimeout(this.endTimer);
    clearTimeout(this._suspendTimer);
    this._suspendTimer = setTimeout(() => {
      if (!document.hidden) return;
      // a media element runs off its own clock and would keep streaming (and
      // downloading) into the suspended context — park it with the graph
      if (this.node?.kind === 'stream') this.node.el.pause();
      if (this.ownsContext && this.ctx?.state === 'running') this.ctx.suspend().catch(() => {});
    }, 300);
  }

  /** 16 §1.1 — tab visible: resume then fade back. */
  onResume() {
    if (!this.running || !this.ctx) return;
    clearTimeout(this._suspendTimer);
    this.ctx.resume().then(() => {
      if (!this.running) return;
      if (this.node?.kind === 'stream') this.node.el.play().catch(() => {});
      this._fade(this.level, 0.4);
      this._armEndTimer();      // re-armed off the audio clock, so nothing truncates
    }).catch(() => {});
  }

  dispose() {
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.running = false;
    clearTimeout(this.gapTimer);
    clearTimeout(this.endTimer);
    clearTimeout(this._suspendTimer);
    this._stopNode();
    this.buffers.clear();
    this.pcmUsed = 0;
    for (const { el } of this.streams.values()) { el.pause(); el.removeAttribute('src'); el.load(); }
    this.streams.clear();
    if (this.ownsContext) this.ctx?.close().catch(() => {});
  }
}

/** 16-AUDIO E1 drops in by passing its own context/bus (§4.4). */
export function createThemeMusic(opts) { return new ThemeMusic(opts); }
