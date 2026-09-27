#!/usr/bin/env node
// U19 (B8 §4, 19-BUILDOUT-v1.3.md) — weather expansion checks. Self-contained
// ESM, Node builtins only (same hard rule as scripts/smoke.mjs). Exit 0 = green.
//
//   (a) fog table coverage — every BIOMES enum id has a row with numeric
//       near < far and a 3-channel rgb tint; PLAINS pinned to the pre-B8
//       baseline (0.75 / 1.0 / neutral) so the default biome is zero-regression.
//   (b) snow accumulate/melt state machine — snowTick/snowMeltTick driven over
//       a mock world: stacks 1→2→3 (+cap at 8), melts back to air; holds while
//       snowing; the schedule queue drains on world.time like ScheduledTicks.
//   (c) thunder strike-roll determinism — pickStrikeCell/rollStrike with a
//       seeded rng: same seed → same target, target within 64 of the player,
//       y = heightTop, unloaded columns → null.
//   (d) fog blend convergence — blendFog approaches the target over a 2 s
//       window of frame steps, no overshoot, dt=0 is a no-op.
//
// Module-scope localStorage shim BEFORE the dynamic imports: thunder.js's
// import chain reaches audio/engine.js's `new AudioEngine()` ctor, which reads
// localStorage — legal browser code absent in Node (same shim smoke U9 uses).

globalThis.localStorage = {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', 'src');
const imp = p => import(pathToFileURL(join(SRC, p)).href);

let failures = 0;
let checks = 0;
function report(id, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? '  — ' + detail : ''}`);
}
function fail(msg) { throw new Error(msg); }
function expect(cond, msg) { if (!cond) fail(msg); }
function near(a, b, eps, what) {
  expect(Math.abs(a - b) <= eps, `${what}: |${a} - ${b}| > ${eps}`);
  return true;
}
function mulberry32a(seed) {  // small local LCG — keeps this file self-contained
  let s = seed | 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

async function main() {
  const { BIOMES } = await imp('world/gen/biomes.js');
  const { B } = await imp('registry/blocks.js');
  const { FOG_BY_BIOME, FOG_TAU, blendFog } = await imp('env/fogTable.js');
  const snow = await imp('world/snow.js');
  const thunder = await imp('world/thunder.js');

  // ---------------------------------------------------------- (a) fog table
  {
    let bad = 0;
    for (const [name, id] of Object.entries(BIOMES)) {
      const e = FOG_BY_BIOME[id];
      const ok = e &&
        Number.isFinite(e.near) && Number.isFinite(e.far) && e.near > 0 && e.near < e.far &&
        Array.isArray(e.tint) && e.tint.length === 3 &&
        e.tint.every(v => Number.isFinite(v) && v >= 0 && v <= 1);
      if (!ok) { bad++; console.log(`        biome ${name} (${id}): ${JSON.stringify(e)}`); }
    }
    report('(a) fogTable covers all 12+ biome ids (near<far, rgb triple) incl. HOLLOW(12)', bad === 0 && FOG_BY_BIOME.length >= 12 && FOG_BY_BIOME[12] !== undefined,
      `${FOG_BY_BIOME.length} rows`);
    const p = FOG_BY_BIOME[BIOMES.PLAINS];
    report('(a) PLAINS pinned to pre-B8 baseline (0.75/1.0/neutral)',
      p.near === 0.75 && p.far === 1.0 && p.tint[0] === 1 && p.tint[1] === 1 && p.tint[2] === 1);
    report('(a) FOG_TAU = 2 s window', FOG_TAU === 2);
  }

  // ---------------------------------------------------------- (b) snow machine
  {
    const mkWorld = (biome = BIOMES.SNOWY_TUNDRA, ground = true) => {
      const cells = new Map();                       // 'x,y,z' → { id, state }
      const k = (x, y, z) => `${x},${y},${z}`;
      const w = {
        time: 500,
        playerChunk: null,
        chunks: { has: () => true },
        game: { dayNight: { raining: true } },
        biome,
        getBlock: (x, y, z) => cells.get(k(x, y, z))?.id ?? 0,
        getState: (x, y, z) => cells.get(k(x, y, z))?.state ?? 0,
        setState: (x, y, z, state) => { const c = cells.get(k(x, y, z)); if (!c) return false; c.state = state; return true; },
        setBlock: (x, y, z, id, opts = {}) => { cells.set(k(x, y, z), { id, state: opts.state ?? 0 }); return true; },
        removeBlock: (x, y, z) => { cells.set(k(x, y, z), { id: 0, state: 0 }); return true; },
        canSeeSky: () => true,
        getBlockLight: () => 0,
        biomeAt: () => w.biome,
      };
      if (ground) w.setBlock(X, Y - 1, Z, B.STONE);  // solid support under the test cell
      return w;
    };
    const SNOWING = { snowing: true };
    const CLEAR = { snowing: false };
    const X = 5, Y = 64, Z = -3;

    const w = mkWorld();
    let r = snow.snowTick(w, X, Y, Z, 0, SNOWING);
    report('(b) accumulate places a layer (depth 1)',
      r === 'place' && w.getBlock(X, Y, Z) === B.SNOW_LAYER && w.getState(X, Y, Z) === 1);
    r = snow.snowTick(w, X, Y, Z, w.getState(X, Y, Z), SNOWING);
    const d2 = w.getState(X, Y, Z);
    r = snow.snowTick(w, X, Y, Z, w.getState(X, Y, Z), SNOWING);
    const d3 = w.getState(X, Y, Z);
    report('(b) stacks 1→2→3', d2 === 2 && d3 === 3 && r === 'stack');
    let capped = false;
    for (let i = 0; i < 16; i++) {
      const rr = snow.snowTick(w, X, Y, Z, w.getState(X, Y, Z), SNOWING);
      if (rr === 'full') { capped = w.getState(X, Y, Z) === snow.SNOW_MAX; break; }
    }
    report('(b) stacks cap at depth 8 (state nibble height 1..8)', capped);
    r = snow.snowTick(w, X, Y, Z, w.getState(X, Y, Z), CLEAR);
    report('(b) clear sky over a cold biome holds the snow', r === 'hold' && w.getState(X, Y, Z) === snow.SNOW_MAX);

    // melt back: warm biome + clear sky, one layer per tick — fresh stub stacked
    // 1→2→3 (the cap subtest above leaves depth 8 on its own world)
    const wm = mkWorld();
    expect(snow.snowTick(wm, X, Y, Z, 0, SNOWING) === 'place');
    snow.snowTick(wm, X, Y, Z, 1, SNOWING);
    snow.snowTick(wm, X, Y, Z, 2, SNOWING);
    expect(wm.getState(X, Y, Z) === 3);
    wm.biome = BIOMES.PLAINS;                       // BIOME_TEMPS[3] = 0.8 > MELT_TEMP
    wm.game.dayNight.raining = false;
    const m1 = snow.snowMeltTick(wm, X, Y, Z, 3, CLEAR);
    const s1 = wm.getState(X, Y, Z);
    const m2 = snow.snowMeltTick(wm, X, Y, Z, 2, CLEAR);
    const s2 = wm.getState(X, Y, Z);
    const m3 = snow.snowMeltTick(wm, X, Y, Z, 1, CLEAR);
    report('(b) melts back 3→2→1→air (one layer per tick)',
      m1 === 'melt' && s1 === 2 &&
      m2 === 'melt' && s2 === 1 &&
      m3 === 'clear' && wm.getBlock(X, Y, Z) === 0);
    report('(b) melt holds while snowing / in a cold biome', (() => {
      w.setBlock(X, Y, Z, B.SNOW_LAYER, { state: 3 });
      const holdSnowing = snow.snowMeltTick(w, X, Y, Z, 3, SNOWING) === 'hold';
      w.biome = BIOMES.SNOWY_TUNDRA;                // temp 0.0 ≤ MELT_TEMP
      const holdCold = snow.snowMeltTick(w, X, Y, Z, 3, CLEAR) === 'hold';
      return holdSnowing && holdCold && w.getState(X, Y, Z) === 3;
    })());
    report('(b) accumulate re-validates support + light at consume', (() => {
      const s = mkWorld(BIOMES.SNOWY_TUNDRA, false);   // no ground → no support
      if (snow.snowTick(s, X, Y, Z, 0, SNOWING) !== 'noop') return false;
      const s2 = mkWorld();
      s2.getBlockLight = () => 12;                  // 04 §12.5 light gate
      return snow.snowTick(s2, X, Y, Z, 0, SNOWING) === 'noop';
    })());

    // schedule queue: mirrors ScheduledTicks' bucket drain on world.time
    {
      const q = mkWorld();
      snow.clearSnowTicks();
      snow.scheduleSnowTick(q, X, Y, Z, 5);         // due at 505
      snow.tickSnow(q);                             // t=500: nothing yet
      const early = q.getBlock(X, Y, Z) === 0;
      q.time = 505;
      snow.tickSnow(q);                             // due: tick consumes the cell
      report('(b) schedule queue drains on world.time (SchedTicks mirror)',
        early && q.getBlock(X, Y, Z) === B.SNOW_LAYER && q.getState(X, Y, Z) === snow.SNOW_MIN);
      // deferral: outside SIM_RADIUS the tick re-queues instead of running
      const q2 = mkWorld();
      q2.playerChunk = { cx: 100, cz: 100 };        // cell chunk (0,-1) is far outside ±6
      snow.clearSnowTicks();
      snow.scheduleSnowTick(q2, X, Y, Z, 1);
      q2.time += 1;
      snow.tickSnow(q2);
      const deferred = q2.getBlock(X, Y, Z) === 0;
      q2.playerChunk = null;
      q2.time += 40;
      snow.tickSnow(q2);
      report('(b) out-of-sim ticks defer 40 t and run once in range',
        deferred && q2.getBlock(X, Y, Z) === B.SNOW_LAYER);
      snow.clearSnowTicks();
    }
  }

  // ---------------------------------------------------------- (c) thunder roll
  {
    const ht = (x, z) => 60 + (((x * 7 + z * 13) & 7) + 8) % 8;   // fixed stub surface
    const a = thunder.pickStrikeCell(mulberry32a(1337), ht, 500, -900);
    const b = thunder.pickStrikeCell(mulberry32a(1337), ht, 500, -900);
    report('(c) pickStrikeCell deterministic under a seeded rng',
      !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z);
    report('(c) strike target within ±64 of the player, y = heightTop',
      !!a && Math.max(Math.abs(a.x - 500), Math.abs(a.z - -900)) <= thunder.STRIKE_RANGE &&
      a.y === ht(a.x, a.z));
    report('(c) unloaded column (heightTop 0) → null roll', (() => {
      const c = thunder.pickStrikeCell(mulberry32a(9), () => 0, 0, 0);
      return c === null;
    })());
    report('(c) STRIKE_CHANCE = 1/20000', thunder.STRIKE_CHANCE === 1 / 20000);
    {
      let strikes = 0;
      const r = mulberry32a(4242);
      for (let i = 0; i < 20000; i++) if (thunder.rollStrike(r)) strikes++;
      report('(c) rollStrike rate over 20000 rolls in [0..5]', strikes >= 0 && strikes <= 5,
        `${strikes} strikes`);
    }
  }

  // ---------------------------------------------------------- (d) fog blend
  {
    const cur = { near: 0, far: 0, r: 0, g: 0, b: 0 };
    const tgt = { near: 100, far: 200, r: 1, g: 0.5, b: 0.25 };
    blendFog(cur, tgt, 0);
    report('(d) dt=0 is a no-op', cur.near === 0 && cur.r === 0);
    let monotone = true, overshoot = false, prev = 0, between = true;
    for (let i = 0; i < 120; i++) {               // 2 s of 60 Hz frames
      blendFog(cur, tgt, 1 / 60);
      if (cur.near < prev) monotone = false;      // monotone approach, no backslide
      if (cur.near > tgt.near + 1e-9 || cur.far > tgt.far + 1e-9) overshoot = true;
      prev = cur.near;
      if (i === 59 && !(cur.near > 0 && cur.near < tgt.near)) between = false;
    }
    report('(d) monotone approach, between start and target mid-window',
      monotone && between && !overshoot);
    report('(d) converges after the 2 s window (≤0.5 % residual)',
      near(cur.near, tgt.near, tgt.near * 0.005 + 1e-6, 'near') &&
      near(cur.far, tgt.far, tgt.far * 0.005 + 1e-6, 'far') &&
      near(cur.r, tgt.r, 0.005 + 1e-6, 'r') &&
      near(cur.g, tgt.g, 0.005 + 1e-6, 'g') &&
      near(cur.b, tgt.b, 0.005 + 1e-6, 'b'));
  }

  console.log(`\nU19 WEATHER — ${checks - failures}/${checks} green`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });