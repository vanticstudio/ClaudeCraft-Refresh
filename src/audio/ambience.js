// Loop voices: rain, wind, fluid clusters, fire proximity (16 §3.5, §5).
// Driven from audio.tick() (AMENDS 01 §3 tick step 10) — never from render.
import { BLOCKS } from '../registry/blocks.js';
import { STATE } from '../constants.js';

const SAMPLE_CELLS = 48;        // §3.5: 48 getBlock/s — noise in the budget
const SAMPLE_RADIUS = 12;
const BUCKET = 4;               // 4x4x4 grid cells
const MAX_CLUSTERS = 2;         // per fluid type
const FIRE_RADIUS = 8;
const MAX_FIRE = 3;

export class Ambience {
  constructor(engine) {
    this.engine = engine;
    this.rain = null;
    this.wind = null;
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

    // fire proximity: separate short scan (§3.5 ambient.fire.loop, within 8)
    for (let i = 0; i < 24; i++) {
      const x = Math.floor(p.x + (Math.random() * 2 - 1) * FIRE_RADIUS);
      const y = Math.floor(p.y + (Math.random() * 2 - 1) * FIRE_RADIUS);
      const z = Math.floor(p.z + (Math.random() * 2 - 1) * FIRE_RADIUS);
      if (y < 0 || y > 127) continue;
      const id = world.getBlock(x, y, z);
      if (BLOCKS[id]?.name === 'fire' || BLOCKS[id]?.name === 'furnace_lit') {
        fires.push({ x: x + 0.5, y: y + 0.5, z: z + 0.5 });
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
