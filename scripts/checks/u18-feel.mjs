#!/usr/bin/env node
// ============================================================================
// U18 — B3 "Feel & combat polish" (19-BUILDOUT-v1.3 §B3). Self-contained ESM,
// mirroring the smoke harness's conventions (real imports, no frameworks,
// exit 0 = PASS / 1 = FAIL). Run: node scripts/checks/u18-feel.mjs
//
// (a) OPTIONS SURFACE — DEFAULTS.screenShake === false (the accessibility
//     default: forced camera motion stays opt-in; loadOptions spreads stored
//     values OVER the defaults, so absence in localStorage must yield false).
// (b) SOUND IDS — every sound-event id THIS PHASE adds resolves to an EXACT
//     recipe in src/audio/events.js, using the same oracle as smoke U6
//     (EVENTS[id] itself, never the §5.2 namespace fallback).
// (c) FOOTSTEP MAPPING — the under-feet block → step-event mapping exported
//     from Player.js (B3 §5) resolves to an exact `block.step.*` recipe for a
//     representative surface list (the canonical grass/sand/stone/wood/snow
//     five plus every remaining voice family), and stays null for the verb-less
//     classes (air, fluids) exactly as the old matOf-based emitStep did.
// (d) SHAKE CLAMP — DayNight's exported pure helpers can never exceed the spec
//     ceiling: clampShake folds garbage/negatives/huge values into [0, 0.15],
//     and every shakeOffset axis component stays within the clamped magnitude
//     (≤ 0.15 always). Also pinned: same seed → byte-identical offset (stable
//     across a tick's interpolated frames).
// ============================================================================

const imp = p => import(new URL('../../src/' + p, import.meta.url).href);

let failures = 0;
let checks = 0;
function report(id, title, fails, notes = []) {
  checks++;
  const ok = fails.length === 0;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  U18.${id}  ${title}`);
  for (const n of notes) console.log(`        note: ${n}`);
  for (const f of fails) console.log(`      - ${f}`);
}

// Node-safe import chain: Player.js reaches audio/engine.js's module-scope
// AudioEngine, which touches localStorage in its ctor (same stub as smoke U9
// and U21). Stub BEFORE any import below.
globalThis.localStorage = {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

async function main() {
  let options, events, player, blocks, dayNight;
  try {
    [options, events, player, blocks, dayNight] = await Promise.all([
      imp('ui/options.js'), imp('audio/events.js'), imp('entities/Player.js'),
      imp('registry/blocks.js'), imp('env/DayNight.js'),
    ]);
  } catch (e) {
    report('imports', 'module load', ['could not import a module: ' + e.message]);
    finish();
    return;
  }
  const { DEFAULTS } = options;
  const { EVENTS } = events;
  const { stepEventFor } = player;
  const { B, BLOCKS } = blocks;
  const { SHAKE_MAX, clampShake, shakeOffset } = dayNight;

  // ---------------------------------------------------------------- (a)
  {
    const fails = [];
    if (DEFAULTS.screenShake !== false) {
      fails.push(`DEFAULTS.screenShake is ${JSON.stringify(DEFAULTS.screenShake)}, expected false (B3 §4 default OFF)`);
    }
    // the persistence path keeps the default when the key is absent
    const loaded = options.loadOptions();
    if (loaded.screenShake !== false) {
      fails.push(`loadOptions() with empty storage yielded screenShake ${JSON.stringify(loaded.screenShake)}, expected false`);
    }
    report('a', 'options surface — screenShake defaults to false and persists', fails,
      ['toggle lives in the settings sheet; DayNight re-reads game.options.screenShake per frame']);
  }

  // ---------------------------------------------------------------- (b)
  {
    const fails = [];
    // B3's new ids. U6 oracle: an EXACT EVENTS key — the §5.2 namespace
    // fallback (unknown block.* → block.break.stone) must never rescue one.
    const NEW_IDS = ['player.attack.crit'];
    for (const id of NEW_IDS) {
      if (!EVENTS[id]) fails.push(`sound event '${id}' has no exact recipe in src/audio/events.js`);
    }
    // the crit recipe shares the sweep's cap family and is a self event — pin
    // the shape so a future rename of the SELF spread cannot silently detach it
    const crit = EVENTS['player.attack.crit'];
    if (crit && crit.bus !== 'sfx') fails.push(`player.attack.crit bus is '${crit.bus}', expected 'sfx'`);
    if (crit && typeof crit.recipe !== 'function') fails.push('player.attack.crit has no recipe function');
    report('b', 'sound ids — every B3-added event id resolves to an exact recipe', fails,
      [`${NEW_IDS.length} new id(s) checked; footstep ids reuse the generated block.step.* families (see (c))`]);
  }

  // ---------------------------------------------------------------- (c)
  {
    const fails = [];
    const exact = id => !!EVENTS[id];
    // the canonical five surfaces (B3 §5) + the remaining voice families, as
    // block NAMES — resolved through B so the test tracks the registry.
    const NAMES = [
      // canonical five
      'grass_block', 'sand', 'stone', 'oak_planks', 'snow_block',
      // the rest of the walkable surface families
      'cobblestone', 'oak_log', 'oak_leaves', 'snow_layer', 'dirt', 'gravel',
      'ice', 'wool_white', 'iron_block', 'coal_ore', 'netherrack', 'end_stone',
    ];
    for (const name of NAMES) {
      const id = B[name.toUpperCase()];
      if (id === undefined) { fails.push(`registry: block '${name}' missing (B[name] undefined)`); continue; }
      if (!BLOCKS[id]) { fails.push(`registry: BLOCKS[${id}] missing for '${name}'`); continue; }
      const evt = stepEventFor(id);
      if (!evt) { fails.push(`stepEventFor(${name}) returned null — walking on ${name} would be silent`); continue; }
      if (!exact(evt)) fails.push(`stepEventFor(${name}) → '${evt}' has no exact recipe in src/audio/events.js`);
    }
    // the canonical five must hit their OWN family, not drift to a fallback
    const PINNED = [
      ['grass_block', 'block.step.grass'], ['sand', 'block.step.sand'],
      ['stone', 'block.step.stone'], ['oak_planks', 'block.step.wood'],
      ['snow_block', 'block.step.snow'],
    ];
    for (const [name, want] of PINNED) {
      const got = stepEventFor(B[name.toUpperCase()]);
      if (got !== want) fails.push(`stepEventFor(${name}) = '${got}', expected '${want}'`);
    }
    // verb-less classes stay silent, exactly as the matOf-based emitStep did
    for (const name of ['air', 'water', 'lava']) {
      const id = B[name.toUpperCase()];
      const got = stepEventFor(id);
      if (got !== null) fails.push(`stepEventFor(${name}) = '${got}', expected null (no step verb)`);
    }
    report('c', 'footstep mapping — block-under-player → exact step event', fails,
      [`${NAMES.length} surface ids + 3 silent classes checked against the events registry`]);
  }

  // ---------------------------------------------------------------- (d)
  {
    const fails = [];
    if (SHAKE_MAX !== 0.15) fails.push(`SHAKE_MAX is ${SHAKE_MAX}, expected 0.15 (spec: ~0.15-block offset)`);
    // clampShake folds everything into [0, 0.15]
    const CASES = [-5, 0, 0.05, 0.149, 0.15, 0.151, 0.3, 1, 1e9, NaN, Infinity, -Infinity, undefined, null, '0.2', 'junk'];
    for (const c of CASES) {
      const v = clampShake(c);
      if (!(v >= 0 && v <= SHAKE_MAX)) fails.push(`clampShake(${String(c)}) = ${v}, outside [0, ${SHAKE_MAX}]`);
    }
    if (clampShake(NaN) !== 0) fails.push('clampShake(NaN) must be 0');
    if (clampShake(0.3) !== SHAKE_MAX) fails.push('clampShake(0.3) must clamp to SHAKE_MAX');
    if (clampShake(-1) !== 0) fails.push('clampShake(-1) must floor to 0');
    // every offset axis stays within the clamped magnitude — for a sweep of
    // seeds and magnitudes, including ones an unchecked caller might pass
    for (const mag of [0, 0.05, 0.15, 0.4, 2, -1, NaN]) {
      const m = clampShake(mag);
      for (let seed = 0; seed < 2000; seed++) {
        const o = shakeOffset(seed, mag);
        for (const ax of ['x', 'y', 'z']) {
          if (!(Math.abs(o[ax]) <= m + 1e-12)) {
            fails.push(`shakeOffset(${seed}, ${String(mag)}).${ax} = ${o[ax]} exceeds clamped magnitude ${m}`);
            seed = 2000; break;   // one line per magnitude is enough
          }
        }
      }
      // determinism: same seed → identical offset (stable across interpolated frames)
      const a = shakeOffset(77123, 0.15), b = shakeOffset(77123, 0.15);
      if (a.x !== b.x || a.y !== b.y || a.z !== b.z) fails.push('shakeOffset is not deterministic for a fixed seed');
    }
    // the magnitude that Player.onHurt requests is exactly the ceiling
    if (clampShake(0.15) !== SHAKE_MAX) fails.push('the 0.15 damage-shake request must pass through unclamped');
    report('d', 'shake clamp — magnitude never exceeds 0.15', fails,
      ['pure helpers exported from src/env/DayNight.js; the offset itself applies only in updateRender behind options.screenShake']);
  }

  finish();
}

function finish() {
  console.log(`\n${failures === 0 ? 'U18 PASS' : 'U18 FAIL'} — ${checks - failures}/${checks} checks green`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
