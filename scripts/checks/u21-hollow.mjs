#!/usr/bin/env node
// ============================================================================
// U21 — B12 "The Hollow" (19-BUILDOUT-v1.3 §B12): biome selection, block
// registry, Sentinel miniboss integrity, and gen determinism. Self-contained
// ESM; mirrors the smoke harness's conventions (real imports, no frameworks,
// exit 0 = PASS / 1 = FAIL). Run: node scripts/checks/u21-hollow.mjs
//
// (a) BIOME SELECTION — a generated region must report HOLLOW columns (the
//     per-column stand-in for the spec's `y < 24 && caveNoise > threshold`),
//     never on ocean/submerged columns (only in stone, not near oceans), never
//     with the surface inside the band (the y>=24 exclusion, encoded as the
//     selector's 64 surface floor), and the chunk-centre column must stay
//     unmasked (the stability contract that keeps village/tree re-derivation
//     order-independent — see features.js stampHollow's header).
// (b) REGISTRY — the three blocks exist with the spec'd shape/hardness/blast/
//     tier/emission and their drops resolve (U5 machinery: the harvest gate
//     drops nothing without the tier; echo_ore pays emerald until the
//     orchestrator lands the echo_shard item — documented deviation).
// (c) SENTINEL — imports, extends Mob, carries the spec'd stat block, its
//     2-tick melee windup fires, and its loot resolves (3–6 emerald + 25%
//     totem, per the same echo_shard deviation).
// (d) DETERMINISM — a second generator instance over the same seed produces
//     byte-identical blocks/biomes/spawn records, and the pinned seed yields
//     at least one Sentinel spawn record (the 1/32-per-hollow-chunk roll).
// ============================================================================

const imp = p => import(new URL('../../src/' + p, import.meta.url).href);

let failures = 0;
let checks = 0;
function report(id, title, fails, notes = []) {
  checks++;
  const ok = fails.length === 0;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  U21.${id}  ${title}`);
  for (const n of notes) console.log(`        note: ${n}`);
  for (const f of fails) console.log(`      - ${f}`);
}

// Node-safe import chain: World.js reaches audio/engine.js's module-scope
// AudioEngine, which touches localStorage in its ctor (same stub as smoke U9).
globalThis.localStorage = {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

async function main() {
  // ---------------------------------------------------------------- fixtures
  const [{ createGenerator }, biomes, blocks, { Mob }, { Sentinel },
         { idOf }, { matOf }, { createNoiseCtx }, { hashString }] = await Promise.all([
    imp('world/gen/terrain.js'), imp('world/gen/biomes.js'), imp('registry/blocks.js'),
    imp('entities/mobs/Mob.js'), imp('entities/mobs/Sentinel.js'),
    imp('registry/items.js'), imp('registry/blocks.js'), imp('world/gen/noise.js'),
    imp('math/rng.js'),
  ]);
  const { BIOMES, HOLLOW_SURFACE_MIN, HOLLOW_Y_MAX, HOLLOW_CAVE_THRESHOLD, hollowAt, ID } = biomes;
  const { BLOCKS, B } = blocks;
  const SEED = 'hollow-2';   // pinned: 41×41 region carries ≥1 sentinel + a wide hollow field
  const R = 20;              // 41×41 chunks

  // ---------------------------------------------------------------- (a) + (d)
  const t0 = Date.now();
  const gen = createGenerator(SEED);
  const gen2 = createGenerator(SEED);   // fresh instance, same seed — (d)
  // The mask gates on the TERRAIN height (colD.h — the pre-carve surface), not
  // the post-decoration heightMap: ravines can carve a dry column's surface
  // below 64 without any water present. The "ocean column" test therefore reads
  // the same source of truth the mask does — a fresh noise ctx over the seed.
  const nctx = createNoiseCtx(hashString(SEED));
  let hollowCols = 0, badLow = 0, badCenter = 0, caveAir = 0, sentinels = [];
  const digests = [];
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      const r = gen.generateChunk(dx, dz);
      const cd = nctx.columnData(dx, dz);
      for (let ci = 0; ci < 256; ci++) {
        const biome = r.biomes[ci];
        const colH = cd.h[ci];
        if (biome === BIOMES.HOLLOW) {
          hollowCols++;
          if (colH < HOLLOW_SURFACE_MIN) badLow++;        // submerged/ocean terrain — §B12 exclusion
          if (r.heightMap[ci] <= HOLLOW_Y_MAX) badLow++;  // surface must sit above the y<24 band
          for (let y = 2; y < HOLLOW_Y_MAX; y++) {        // the band must actually be carved somewhere
            if (r.blocks[(y << 8) | ci] === 0) { caveAir++; break; }
          }
        }
        if (colH <= 59 && biome === BIOMES.HOLLOW) badLow++;   // OCEAN band (selectBiome's height <= 59)
      }
      if (r.biomes[(8 << 4) | 8] === BIOMES.HOLLOW) badCenter++;          // centre never masked
      for (const s of r.spawns) if (s.type === 'sentinel') sentinels.push(s);
      digests.push([dx, dz, Buffer.from(r.blocks).toString('base64'),
        Buffer.from(r.biomes).toString('base64'), JSON.stringify(r.spawns)]);
    }
  }

  const failsA = [], notesA = [];
  if (hollowCols === 0) failsA.push('no HOLLOW columns in the 41×41 region — mask/selector broken');
  if (badLow > 0) failsA.push(`${badLow} HOLLOW columns below the ${HOLLOW_SURFACE_MIN} surface floor (ocean/submerged band leaked in)`);
  if (badCenter > 0) failsA.push(`${badCenter} chunk-centre columns masked — village/tree stability contract broken`);
  if (caveAir === 0) failsA.push('no HOLLOW column has cave air at y<24 — noise band sample is wrong');
  // The y>=24 exclusion lives in the selector's surface floor: a column whose
  // whole body sits inside the band (height 20) can never be HOLLOW; a dry-land
  // column with a cavernous band is; the threshold itself is strict (y=24-band
  // only — the sample ys are 8/14/20, never above 24).
  if (hollowAt(20, 0.9) !== false) failsA.push('hollowAt(20, 0.9) must be false — surface inside the band');
  if (hollowAt(HOLLOW_SURFACE_MIN - 1, 0.9) !== false) failsA.push(`hollowAt(${HOLLOW_SURFACE_MIN - 1}, 0.9) must be false`);
  if (hollowAt(HOLLOW_SURFACE_MIN, 0.9) !== true) failsA.push(`hollowAt(${HOLLOW_SURFACE_MIN}, 0.9) must be true`);
  if (hollowAt(HOLLOW_SURFACE_MIN, HOLLOW_CAVE_THRESHOLD) !== false) failsA.push('threshold must be strict (>)');
  notesA.push(`41×41 @seed '${SEED}': ${hollowCols} HOLLOW columns, ${sentinels.length} Sentinel spawn(s), ${Date.now() - t0} ms`);
  report('a', 'biome selection — HOLLOW only deep under dry land, centre columns untouched', failsA, notesA);

  // ---------------------------------------------------------------- (b)
  const failsB = [], notesB = [];
  const hs = BLOCKS[B.HOLLOW_STONE], eo = BLOCKS[B.ECHO_ORE], gr = BLOCKS[B.HOLLOW_GROWTH];
  if (B.HOLLOW_STONE !== 145 || hs?.name !== 'hollow_stone') failsB.push(`hollow_stone must be id 145 (got ${B.HOLLOW_STONE})`);
  if (B.ECHO_ORE !== 146 || eo?.name !== 'echo_ore') failsB.push(`echo_ore must be id 146 (got ${B.ECHO_ORE})`);
  if (B.HOLLOW_GROWTH !== 147 || gr?.name !== 'hollow_growth') failsB.push(`hollow_growth must be id 147 (got ${B.HOLLOW_GROWTH})`);
  if (!hs || hs.shape !== 'cube' || hs.hardness !== 2.0 || hs.blast !== 9.0 ||
      hs.tool !== 'pickaxe' || hs.tier !== 0) failsB.push('hollow_stone row wrong (cube, hardness 2, blast 9, pickaxe tier 0)');
  if (!eo || eo.tier !== 1 || eo.hardness !== 3.0) failsB.push('echo_ore row wrong (hardness 3, iron-pick tier 1)');
  if (!gr || gr.shape !== 'cross' || gr.emission !== 4 || gr.needsSupport !== 'below') failsB.push('hollow_growth row wrong (cross, emission 4, needsSupport below)');
  // U5 machinery: the harvest gate drops nothing below the tier, the item at/above it.
  const ctxFull = { rng: () => 0.99, fortune: 0, toolClass: 'pickaxe', toolTier: 1 };
  const ctxLow = { ...ctxFull, toolTier: 0 };
  if (JSON.stringify(hs.drops(ctxFull)) !== JSON.stringify([{ name: 'hollow_stone', count: 1 }]))
    failsB.push('hollow_stone must drop itself with a pickaxe');
  if (JSON.stringify(hs.drops({ ...ctxFull, toolClass: 'shovel' })) !== '[]')
    failsB.push('hollow_stone must drop nothing without a pickaxe (gated)');
  if (JSON.stringify(eo.drops(ctxLow)) !== '[]') failsB.push('echo_ore must drop nothing below iron tier (gated)');
  const eoDrop = eo.drops(ctxFull);
  if (eoDrop.length !== 1 || eoDrop[0].name !== 'emerald' || eoDrop[0].count !== 1)
    failsB.push(`echo_ore drop must resolve to emerald ×1 (echo_shard deviation): ${JSON.stringify(eoDrop)}`);
  if (idOf('emerald') === undefined) failsB.push("drop target 'emerald' missing from the item registry");
  if (matOf(B.HOLLOW_STONE) !== 'stone' || matOf(B.ECHO_ORE) !== 'ore' || matOf(B.HOLLOW_GROWTH) !== 'grass')
    failsB.push('MAT classes wrong (16 §3.1: stone / ore / grass)');
  notesB.push('ids 145/146/147 registered; echo_ore drop deviation (emerald for echo_shard) pinned');
  report('b', 'registry — Hollow blocks carry the spec’d shape/tier/emission and resolvable drops', failsB, notesB);

  // ---------------------------------------------------------------- (c)
  const failsC = [], notesC = [];
  if (typeof Sentinel !== 'function' || !(Sentinel.prototype instanceof Mob))
    failsC.push('Sentinel must extend Mob');
  let s = null;
  try { s = new Sentinel({ rng: () => 0.5 }, 0, 10, 0); } catch (e) { failsC.push('ctor threw: ' + e.message); }
  if (s) {
    if (s.type !== 'sentinel') failsC.push(`type must be 'sentinel'`);
    if (s.hostile !== true) failsC.push('Sentinel must be hostile');
    if (s.width !== 1.2 || s.height !== 2.9) failsC.push(`box must be 1.2×2.9 (got ${s.width}×${s.height})`);
    if (s.health !== 100 || s.maxHealth !== 100) failsC.push('health must be 100');
    if (s.detectionRange !== 24) failsC.push('detectionRange must be 24');
    if (s.xpValue !== 20) failsC.push('xpValue must be 20');
    if (!(s.walkSpeed < 0.1) || !(s.chaseSpeed < 0.1)) failsC.push('Sentinel must be slow (walkSpeed/chaseSpeed < 0.1)');
    // melee windup: doMeleeAttack defers 2 ticks, then the strike lands once
    const hits = [];
    s.pos.x = 0; s.pos.y = 10; s.pos.z = 0;
    const target = { pos: { x: 1, y: 10, z: 0 }, height: 1.8, dead: false,
      hurt(dmg, kind, opts) { hits.push([dmg, kind, opts?.knockback]); } };
    s.target = target;
    s.doMeleeAttack(target);
    if (s.strikeTimer !== 2 || s.attackAnim !== 0) failsC.push('melee must set a 2-tick windup + attackAnim');
    s.postMove();                                  // tick 1 — no strike yet
    if (hits.length !== 0) failsC.push('strike landed before the windup elapsed');
    s.postMove();                                  // tick 2 — strike lands
    if (hits.length !== 1 || hits[0][0] !== 8 || hits[0][1] !== 'melee' || hits[0][2] !== 0.9)
      failsC.push(`melee must hit 8 with knockback 0.9 after the windup (got ${JSON.stringify(hits)})`);
    if (s.postMove(), hits.length !== 1) failsC.push('strike must not double-fire');
    // loot: the 25% totem rides the same seeded stream as the 3–6 count
    // (lootedRange rolls first, then lootedRareChance). common-side roll (0.0):
    // minimum count AND the totem; rare-side roll (0.99): maximum count, no totem.
    s.world.rng = () => 0.99;
    const rare = s.dropTable(0);
    if (rare.length !== 1 || rare[0].name !== 'emerald' || rare[0].count !== 6)
      failsC.push(`loot at a rare-side roll must be emerald ×6, no totem: ${JSON.stringify(rare)}`);
    s.world.rng = () => 0.0;
    const common = s.dropTable(0);
    if (common.length !== 2 || common[0].name !== 'emerald' || common[0].count !== 3 ||
        common[1].name !== 'totem_of_undying') failsC.push(`loot at a common-side roll must be emerald ×3 + totem: ${JSON.stringify(common)}`);
    if (idOf('totem_of_undying') === undefined) failsB.push("loot target 'totem_of_undying' missing from the item registry");
    notesC.push('stats/melee-windup/loot pinned; sentinel voice rows pending in events.js (deviation)');
  }
  report('c', 'Sentinel — Mob subclass with the §B12 stat block, 2-tick windup, resolvable loot', failsC, notesC);

  // ---------------------------------------------------------------- (d)
  const failsD = [], notesD = [];
  let mismatch = 0;
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      const r = gen2.generateChunk(dx, dz);
      const d = [dx, dz, Buffer.from(r.blocks).toString('base64'),
        Buffer.from(r.biomes).toString('base64'), JSON.stringify(r.spawns)];
      const ref = digests[(dx + R) * (2 * R + 1) + (dz + R)];
      if (d[2] !== ref[2] || d[3] !== ref[3] || d[4] !== ref[4]) mismatch++;
    }
  }
  if (mismatch > 0) failsD.push(`${mismatch} chunks differ between two generator instances (seed '${SEED}') — mask/spawn roll is not deterministic`);
  if (sentinels.length === 0) failsD.push('pinned seed produced no Sentinel spawn record — the 1/32 roll or the cell finder is broken');
  for (const rec of sentinels) {
    if (rec.y < 8 || rec.y > 20) failsD.push(`sentinel at y=${rec.y} outside the 8..20 band`);
    if (!Number.isInteger(rec.y)) failsD.push(`sentinel y=${rec.y} is not a standable cell (feet on a block boundary)`);
  }
  notesD.push(`two instances over 41×41 chunks byte-identical; ${sentinels.length} sentinel record(s) identical across both`);
  report('d', 'determinism — mask + Sentinel roll identical across generator instances', failsD, notesD);

  console.log(`\nU21 ${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks green`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('U21 harness threw:', e.stack || e);
  process.exit(1);
});
