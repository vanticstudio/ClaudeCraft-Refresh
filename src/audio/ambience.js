// Loop voices: rain, wind, fluid clusters, fire proximity (16 §3.5, §5).
// Driven from audio.tick() (AMENDS 01 §3 tick step 10) — never from render.
import { BLOCKS, B } from '../registry/blocks.js';
import { STATE } from '../constants.js';
import { BIOMES } from '../world/gen/biomes.js';
import { EVENTS, P } from './events.js';
import { drone } from './primitives.js';

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

  // §3.5: gain = 0.12 x clamp((y - 88)/24, 0, 1) when canSeeSky
  updateWind(g) {
    const p = g.player.pos;
    const alt = Math.min(1, Math.max(0, (p.y - 88) / 24));
    const sky = g.world.canSeeSky(p.x, p.y, p.z);
    const gain = sky ? 0.12 * alt : 0;
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
    for (const kind of ['water', 'lava']) {
      for (const c of this.clusters[kind]) c.handle?.stop(0.3);
      this.clusters[kind].length = 0;
    }
    for (const f of this.fires) f.handle?.stop(0.3);
    this.fires.length = 0;
  }
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
