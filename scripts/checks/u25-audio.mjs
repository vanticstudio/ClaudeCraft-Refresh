#!/usr/bin/env node
// U25 (16-AUDIO v1.3.1) — the definitive audio completeness check. Self-contained
// ESM, Node builtins only (same hard rule as scripts/smoke.mjs). Exit 0 = green.
//
//   (a) registry + voice files load — src/audio/events.js plus BOTH v1.3.1 voice
//       modules (voices-hostile.js / voices-passive.js). A missing voice module
//       is reported BY NAME and fails: Agents A/B run in parallel with the
//       wiring, so the orchestrator re-runs this check after they land.
//   (b) per-type voice coverage — for every type in mobs/index.js's CTORS table
//       (all 22) plus 'ender_dragon': mob.<type>.idle / .hurt / .death must all
//       be registered in EVENTS (the base Mob class emits those dynamically, so
//       a missing row is a permanently silent mob, not a cosmetic gap).
//   (c) v1.3.1 specials — mob.sentinel.pulse, mob.magma_cube.jump,
//       mob.blaze.shoot, item.fishing.cast/bite/reel/splash.
//   (d) pre-existing specials still registered — creeper fuse, enderman
//       scream/teleport, ghast warn/shoot, the full wither + ender_dragon voice
//       sets, chicken egg, villager trade (a voice sweep must not clobber them).
//   (e) ambience — the module loads, exports its Ambience class, and the
//       ambient loop table it drives (EVENTS rows with bus 'ambient' +
//       loop:true, one installed by ambience.js itself) holds > 5 entries;
//       every loop id ambience.js startLoop()s resolves in EVENTS.
//   (f) wiring pins — the v1.3.1 emit sites really emit the agreed literal ids
//       (and the FishingBobber does NOT own cast/reel — interaction.js does).
//
// Module-scope localStorage shim BEFORE the dynamic imports: the mob graph
// reaches audio/engine.js's `new AudioEngine()` ctor, which reads localStorage —
// legal browser code absent in Node (same shim smoke U9/U12 use).

globalThis.localStorage = {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SRC = join(ROOT, 'src');
const imp = p => import(pathToFileURL(join(SRC, p)).href);

let failures = 0;
let checks = 0;
function report(id, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? '  — ' + detail : ''}`);
}

async function main() {
  // ---------------------------------------------------------- (a) registry load
  const events = await imp('audio/events.js');
  const EVENTS = events.EVENTS;

  let voicesMissing = 0;
  for (const f of ['audio/voices-hostile.js', 'audio/voices-passive.js']) {
    try {
      await imp(f);
      report(`(a) ${f} loads`, true);
    } catch (e) {
      voicesMissing++;
      report(`(a) ${f} loads`, false,
        `MISSING or unloadable: ${String(e.message ?? e).split('\n')[0]}`);
    }
  }

  // ------------------------------------------------ (b) type roster + voices
  // CTORS is not exported, so read its keys out of the module source (comments
  // stripped first — the table carries inline phase annotations).
  const idxRaw = readFileSync(join(SRC, 'entities', 'mobs', 'index.js'), 'utf8');
  const idxSrc = idxRaw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const ctorsBody = /const\s+CTORS\s*=\s*\{([\s\S]*?)\};/.exec(idxSrc)?.[1] ?? '';
  const types = [...new Set([...ctorsBody.matchAll(/([A-Za-z_][\w$]*)\s*:/g)].map(m => m[1]))];
  report('(b) CTORS type list extracted', types.length >= 22,
    `${types.length} types${types.length < 22 ? ' (expected 22 — extraction broke or roster shrank)' : ''}`);

  // the import must actually load under Node (mob graph incl. audio/engine.js)
  try {
    await imp('entities/mobs/index.js');
    report('(b) entities/mobs/index.js imports clean', true);
  } catch (e) {
    report('(b) entities/mobs/index.js imports clean', false,
      String(e.message ?? e).split('\n')[0]);
  }

  const voiceOf = id => {
    const d = EVENTS[id];
    if (!d) return 'MISSING';
    return d.silent ? 'silent' : 'ok';
  };
  const roster = [...types, 'ender_dragon'].sort();
  for (const t of roster) {
    const v = ['idle', 'hurt', 'death'].map(verb => voiceOf(`mob.${t}.${verb}`));
    const ok = v.every(x => x !== 'MISSING');
    report(`(b) mob.${t}.{idle,hurt,death}`, ok, v.join(' / '));
  }

  // ---------------------------------------------------------- (c) new specials
  for (const id of ['mob.sentinel.pulse', 'mob.magma_cube.jump', 'mob.blaze.shoot',
    'item.fishing.cast', 'item.fishing.bite', 'item.fishing.reel', 'item.fishing.splash']) {
    report(`(c) ${id} registered`, !!EVENTS[id]);
  }

  // -------------------------------------------------- (d) pre-existing specials
  for (const id of ['mob.creeper.fuse', 'mob.enderman.scream', 'mob.enderman.teleport',
    'entity.ghast.shoot', 'entity.ghast.warn',
    'mob.wither.spawn', 'mob.wither.shoot', 'mob.wither.break_block', 'mob.wither.death',
    'mob.ender_dragon.ambient', 'mob.ender_dragon.growl', 'mob.ender_dragon.flap',
    'mob.ender_dragon.shoot', 'mob.ender_dragon.death',
    'mob.chicken.egg', 'villager.trade']) {
    report(`(d) ${id} still registered`, !!EVENTS[id]);
  }

  // -------------------------------------------------------------- (e) ambience
  try {
    const amb = await imp('audio/ambience.js');
    report('(e) ambience.js loads and exports Ambience', typeof amb.Ambience === 'function');
    // the ambience loop table: every EVENTS row ambience-style loops ride on
    const loops = Object.entries(EVENTS).filter(([, d]) => d && d.bus === 'ambient' && d.loop === true);
    report('(e) ambient loop table > 5 entries', loops.length > 5, `${loops.length} rows`);
    // every loop id ambience.js actually startLoop()s must resolve
    const ambSrc = readFileSync(join(SRC, 'audio', 'ambience.js'), 'utf8');
    const loopIds = [...new Set([...ambSrc.matchAll(/startLoop\(\s*'([^']+)'/g)].map(m => m[1]))];
    const unresolved = loopIds.filter(id => !EVENTS[id]);
    report('(e) every startLoop id in ambience.js resolves in EVENTS',
      loopIds.length > 0 && unresolved.length === 0,
      `${loopIds.length} ids${unresolved.length ? ' — unresolved: ' + unresolved.join(', ') : ''}`);
  } catch (e) {
    report('(e) ambience.js loads and exports Ambience', false, String(e.message ?? e).split('\n')[0]);
  }

  // ------------------------------------------------------------ (f) wiring pins
  const srcOf = rel => readFileSync(join(SRC, rel), 'utf8');
  const has = (rel, id) => srcOf(rel).includes(`'${id}'`);
  report("(f) FishingBobber emits 'item.fishing.splash'", has('entities/FishingBobber.js', 'item.fishing.splash'));
  report("(f) FishingBobber emits 'item.fishing.bite'", has('entities/FishingBobber.js', 'item.fishing.bite'));
  report('(f) FishingBobber does NOT own cast/reel (interaction.js does)',
    !has('entities/FishingBobber.js', 'item.fishing.cast') && !has('entities/FishingBobber.js', 'item.fishing.reel'));
  report("(f) Sentinel emits 'mob.sentinel.pulse'", has('entities/mobs/Sentinel.js', 'mob.sentinel.pulse'));
  report("(f) MagmaCube emits 'mob.magma_cube.jump'", has('entities/mobs/nether/mobs.js', 'mob.magma_cube.jump'));
  report("(f) Blaze emits 'mob.blaze.shoot'", has('entities/mobs/nether/mobs.js', 'mob.blaze.shoot'));
  report("(f) Blaze's old 'entity.blaze.shoot' emit site is retired",
    !has('entities/mobs/nether/mobs.js', 'entity.blaze.shoot'));

  // ------------------------------------------------------------------ summary
  console.log(`\nU25 AUDIO — ${checks - failures}/${checks} green` +
    (voicesMissing ? `  (${voicesMissing} voice module(s) not landed yet — Agents A/B run in parallel)` : ''));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
