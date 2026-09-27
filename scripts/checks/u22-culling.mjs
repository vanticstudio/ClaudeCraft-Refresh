#!/usr/bin/env node
// ============================================================================
// U22 — B9 "Occlusion culling" (19-BUILDOUT-v1.3 §B9): the per-chunk
// visibility summary the mesher folds into the existing face pass, and the
// render gate ChunkManager derives from it. Self-contained ESM; mirrors the
// smoke harness's conventions (real imports, no frameworks, exit 0 = PASS /
// 1 = FAIL). Run: node scripts/checks/u22-culling.mjs
//
// (a) SYNC SUMMARY on U9-style generated grids (overworld + nether): every
//     meshed chunk reports a vis object (Uint8Array(256) topExposed + 6-bit
//     sideView) and every chunk with ≥1 visible face reports a NON-zero
//     summary. On the overworld every column of a surface chunk shows sky,
//     so the greedy up-face hook must mark ALL 256 columns (exactness of the
//     rect-span math).
// (b) FULLY-BURIED chunk: a 3×3 solid-stone hood around a solid center
//     reports zero exposure → the pure gate (exported from ChunkManager)
//     returns SKIP. A sealed interior cavern in the same hood reports
//     exposure (draw) — pinning the brief's conservative topExposed rule —
//     and an air cell in the east neighbour must set exactly the center's
//     +X border bit (the stone behind it faces that plane).
// (c) GATE SAFETY: the same buried chunk must DRAW when any neighbour's
//     facing bit is set, when a neighbour is unmeshed/summary-less, when
//     there are no neighbours at all, or when the center itself reports any
//     exposure. Any doubt = draw.
// (d) WORKER PARITY: buildFromSnapshot's summary is byte-equal to the sync
//     path's for the same chunks (meshWorker transfers that same buffer, so
//     the in-browser path ships exactly what is tested here).
// (e) RENDER GATE (instance level): a real ChunkManager against a stub scene
//     pulls a sealed chunk's group OUT of the scene, puts it back on
//     markDirty / neighbour view / player approach, and re-seals after.
// ============================================================================

const imp = p => import(new URL('../../src/' + p, import.meta.url).href);

let failures = 0;
let checks = 0;
function report(id, title, fails, notes = []) {
  checks++;
  const ok = fails.length === 0;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  U22.${id}  ${title}`);
  for (const n of notes) console.log(`        note: ${n}`);
  for (const f of fails) console.log(`      - ${f}`);
}

// Node-safe import chain: World.js reaches audio/engine.js's module-scope
// AudioEngine, which touches localStorage in its ctor (same stub as smoke U9).
globalThis.localStorage = {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

// U9's exact atlas tileUV construction (half-texel inset, §7.2).
async function makeTileUV() {
  const { finalizeBlockTiles } = await imp('registry/blocks.js');
  const { TILE_NAMES } = await imp('assets/atlas.js');
  const { ATLAS_COLS, ATLAS_CELL, ATLAS_SIZE, TILE_PX, ATLAS_GUTTER } = await imp('constants.js');
  finalizeBlockTiles(Object.fromEntries(TILE_NAMES.map((n, i) => [n, i])));
  const tileUV = new Float32Array(1024 * 4);
  for (let t = 0; t < 1024; t++) {
    const x0 = (t & (ATLAS_COLS - 1)) * ATLAS_CELL + ATLAS_GUTTER;
    const y0 = (t >> 5) * ATLAS_CELL + ATLAS_GUTTER;
    tileUV[t * 4] = (x0 + 0.5) / ATLAS_SIZE;
    tileUV[t * 4 + 1] = (y0 + 0.5) / ATLAS_SIZE;
    tileUV[t * 4 + 2] = (x0 + TILE_PX - 0.5) / ATLAS_SIZE;
    tileUV[t * 4 + 3] = (y0 + TILE_PX - 0.5) / ATLAS_SIZE;
  }
  return tileUV;
}

// U9's meshGrid fixture, reduced to what U22 needs: a 5×5 generated grid in a
// real World, every chunk LIT (promote()'s contract), the inner 3×3 meshable.
async function buildGrid(label, makeGenerator, dim, hasSky) {
  const { World } = await imp('world/World.js');
  const { Chunk } = await imp('world/Chunk.js');
  const world = new World('u22-' + label);
  world.activeDim = dim;
  world.hasSkyLight = hasSky;
  const gen = makeGenerator('u22-seed');
  const chunks = new Map();
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const c = new Chunk(dx, dz, dim);
      const r = gen.generateChunk(dx, dz);
      c.install(r.blocks, r.heightMap, r.biomes, r.states ?? null);
      chunks.set(c.key, c);
      world.chunks.set(c.key, c);
    }
  }
  world.chunkVersion += 25;
  for (const c of world.chunks.values()) world.light.initialLight(c);
  return { world, chunks };
}

const visZero = () => ({ topExposed: new Uint8Array(256), sideView: 0 });
const visSummary = (vis) => {
  let n = 0;
  for (let i = 0; i < 256; i++) if (vis.topExposed[i]) n++;
  return { columns: n, sideView: vis.sideView };
};
const vertsOf = (geos) =>
  ['opaque', 'cutout', 'water'].reduce((s, b) => s + (geos[b] ? geos[b].attributes.position.count : 0), 0);

async function main() {
  const [{ ChunkMesher }, { Chunk, ChunkState }, terrain, nether,
         { cullGateSkip }, { B }] = await Promise.all([
    imp('mesh/ChunkMesher.js'), imp('world/Chunk.js'),
    imp('world/gen/terrain.js'), imp('world/gen/nether.js'),
    imp('world/ChunkManager.js'), imp('registry/blocks.js'),
  ]);
  const { createGenerator } = terrain;
  const { createNetherGenerator } = nether;
  const tileUV = await makeTileUV();
  const mesher = new ChunkMesher(tileUV);

  // ---------------------------------------------------------------- (a) + (d)
  // Sync-path summary correctness on the U9 grids, and byte parity of the
  // worker-snapshot summary against it (both in one walk: each inner chunk is
  // meshed on BOTH paths from the same world state, exactly like U9 does).
  const failsAD = [], notesAD = [];
  const grids = [
    ['overworld', createGenerator, 0, true],
    ['nether', createNetherGenerator, 1, false],
  ];
  for (const [label, makeGen, dim, hasSky] of grids) {
    const { world, chunks } = await buildGrid(label, makeGen, dim, hasSky);
    let meshed = 0, withFaces = 0, overworldColsMin = 256;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const c = chunks.get(`${dx},${dz}`);
        if (!c) { failsAD.push(`${label}: chunk ${dx},${dz} missing`); continue; }
        const geos = mesher.build(world, c);
        if (!geos) { failsAD.push(`${label}: sync build returned null for ${c.key}`); continue; }
        meshed++;
        // shape of the summary itself
        if (!(geos.vis?.topExposed instanceof Uint8Array) || geos.vis.topExposed.length !== 256)
          failsAD.push(`${label} ${c.key}: vis.topExposed missing/not Uint8Array(256)`);
        if (!Number.isInteger(geos.vis?.sideView) || geos.vis.sideView < 0 || geos.vis.sideView > 63)
          failsAD.push(`${label} ${c.key}: vis.sideView not a 6-bit mask (${geos.vis?.sideView})`);
        // (a) — ≥1 visible face ⇒ non-zero mask/topExposed
        const v = vertsOf(geos);
        const s = geos.vis ? visSummary(geos.vis) : { columns: 0, sideView: 0 };
        if (v > 0 && s.columns === 0 && s.sideView === 0)
          failsAD.push(`${label} ${c.key}: ${v} verts but an all-zero summary`);
        if (v > 0) withFaces++;
        if (label === 'overworld') overworldColsMin = Math.min(overworldColsMin, s.columns);
        // (d) — worker snapshot summary must be byte-equal to the sync one
        const snap = { hood: [], center: null };
        for (let ax = -1; ax <= 1; ax++) {
          for (let az = -1; az <= 1; az++) {
            const h = world.chunks.get(`${dx + ax},${dz + az}`);
            snap.hood[(ax + 1) * 3 + (az + 1)] = {
              blocks: h.blocks.slice(), states: h.states.slice(),
              skyLight: h.skyLight.slice(), blockLight: h.blockLight.slice(),
              biomes: h.biomes.slice(),
            };
          }
        }
        snap.center = { blocks: c.blocks.slice(), states: c.states.slice(), minY: c.minY, maxY: c.maxY };
        const raw = mesher.buildFromSnapshot(snap);
        if (!raw.vis || !(raw.vis.topExposed instanceof Uint8Array))
          failsAD.push(`${label} ${c.key}: snapshot vis missing`);
        else {
          const gv = geos.vis, rv = raw.vis;
          if (gv.sideView !== rv.sideView)
            failsAD.push(`${label} ${c.key}: sideView sync ${gv.sideView} vs snapshot ${rv.sideView}`);
          for (let i = 0; i < 256; i++) {
            if (gv.topExposed[i] !== rv.topExposed[i]) {
              failsAD.push(`${label} ${c.key}: topExposed differs at byte ${i} (sync ${gv.topExposed[i]} vs snapshot ${rv.topExposed[i]})`);
              break;
            }
          }
        }
      }
    }
    if (meshed !== 9) failsAD.push(`${label}: only ${meshed}/9 inner chunks meshed`);
    if (withFaces === 0) failsAD.push(`${label}: no chunk produced any visible face — fixture broken`);
    // (a) exactness: on the overworld every column of a surface chunk shows
    // sky (terrain top or water top), so the greedy up-face hook must mark
    // ALL 256 columns in every inner chunk. Nether columns can be fully
    // solid netherrack, so only the non-zero rule applies there.
    if (label === 'overworld' && overworldColsMin < 256)
      failsAD.push(`overworld: a fully-surface chunk reported only ${overworldColsMin}/256 exposed columns`);
    notesAD.push(`${label}: 9/9 meshed both paths; overworld min exposed columns ${overworldColsMin}/256`);
  }
  report('a+d', 'sync summary non-zero whenever faces exist; worker summary byte-equal', failsAD, notesAD);

  // ---------------------------------------------------------------- (b) + (c)
  // Synthetic buried fixtures: a 3×3 solid-stone hood around a solid center.
  // `carve(dcx, dcz, blocks)` can hollow cells in ANY of the 9 chunks — a
  // border-plane face of the CENTER needs its air OUTSIDE the chunk (faces
  // belong to blocks; the center cannot carry a +X face past x=16).
  const failsBC = [], notesBC = [];
  const stoneWorld = (carve) => {
    const world = { chunks: new Map() };       // the mesher's hood accessor shape
    const hood = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const c = new Chunk(dx, dz, 0);
        const arr = new Uint8Array(32768).fill(B.STONE);
        if (carve) carve(dx, dz, arr);
        c.install(arr, new Uint8Array(256).fill(128), new Uint8Array(256).fill(3), null);
        c.state = ChunkState.LIT;              // captureHood's precondition; face visibility never reads light
        hood[(dx + 1) * 3 + (dz + 1)] = c;
        world.chunks.set(c.key, c);
      }
    }
    return { world, center: hood[4] };
  };
  const buildBuried = (carve) => {
    const { world, center } = stoneWorld(carve);
    const geos = mesher.build(world, center);
    if (!geos) { failsBC.push('buried fixture: mesher.build returned null'); return null; }
    return geos;
  };
  const sealedNeighbors = () => {
    const vis = visZero();
    const mk = () => ({ meshed: true, vis });
    return [mk(), mk(), mk(), mk()];           // east, west, south, north
  };

  // (b1) solid center + solid hood: every interior face is culled; the ONLY
  // geometry is the y=127 top quad opening into the void ABOVE the build
  // limit (flight has no clamp there, so the face is real and emitted — but
  // it must NOT count as exposure: it is reported as voidTop instead, and the
  // gate's camera guard owns it). Summary: zero columns, sideView 0, voidTop 1.
  const buried = buildBuried(null);
  if (buried) {
    const s = visSummary(buried.vis);
    if (vertsOf(buried) !== 4) failsBC.push(`fully-buried chunk emitted ${vertsOf(buried)} verts (expected exactly the merged y=127 top quad: 4)`);
    if (s.columns !== 0 || s.sideView !== 0) failsBC.push(`fully-buried chunk reports in-world exposure (${s.columns} cols, sideView ${s.sideView})`);
    if (buried.vis.voidTop !== 1) failsBC.push('fully-buried chunk must report voidTop=1 (its only faces face the build-limit void)');
    if (cullGateSkip(buried.vis, ...sealedNeighbors()) !== true)
      failsBC.push('gate must SKIP a fully-buried chunk sealed by 4 meshed clear neighbours');
    notesBC.push('fully-buried: 1 void-facing top quad, 0/256 columns, sideView 0, voidTop 1 → gate SKIP (camera-guarded)');
  }
  // (b2) sealed interior cavern — the brief's topExposed rule is CONSERVATIVE
  // on purpose (a cavern floor is a visible up face): the chunk must report
  // exposure and DRAW. Interior walls must NOT set any border bit.
  const cavern = buildBuried((dcx, dcz, b) => {
    if (dcx !== 0 || dcz !== 0) return;
    for (let y = 30; y <= 31; y++) for (let x = 6; x <= 7; x++) for (let z = 6; z <= 7; z++) {
      b[(y << 8) | (z << 4) | x] = 0;
    }
  });
  if (cavern) {
    const s = visSummary(cavern.vis);
    if (vertsOf(cavern) === 0) failsBC.push('cavern chunk emitted no geometry — carve failed');
    if (s.columns !== 4) failsBC.push(`cavern must mark exactly its 4 floor columns exposed (got ${s.columns})`);
    if (s.sideView !== ((1 << 2) | (1 << 3))) failsBC.push(`cavern sideView must be exactly up|down (got ${s.sideView})`);
    if (cullGateSkip(cavern.vis, ...sealedNeighbors()) !== false)
      failsBC.push('gate must DRAW a chunk with an exposed interior cavern (conservative contract)');
    notesBC.push(`sealed cavern: 4/256 columns, sideView ${s.sideView} (up|down, no border bits) → gate DRAW`);
  }
  // (b3) ONE air cell in the EAST neighbour at its x=0 column: the center's
  // stone at x=15 then faces the east border plane → exactly bit0, and
  // nothing else (the pocket's own floor/ceiling faces live in the neighbour).
  const pocket = buildBuried((dcx, dcz, b) => {
    if (dcx !== 1 || dcz !== 0) return;
    b[(30 << 8) | (8 << 4) | 0] = 0;
  });
  if (pocket) {
    const s = visSummary(pocket.vis);
    if ((s.sideView & 1) === 0) failsBC.push('air in the east neighbour must set the center +X border bit (bit0)');
    if (s.sideView !== 1) failsBC.push(`east-facing view must set ONLY bit0 (got sideView ${s.sideView})`);
    if (s.columns !== 0) failsBC.push(`east-facing view must expose no column of the center (got ${s.columns})`);
    if (cullGateSkip(pocket.vis, ...sealedNeighbors()) !== false)
      failsBC.push('gate must DRAW a chunk with a border-plane view');
    notesBC.push('air cell in east neighbour: center sideView = exactly bit0, 0 columns → gate DRAW');
  }

  // (c) — the same buried chunk must DRAW on ANY doubt. Neighbour slots are
  // [east, west, south, north]; a neighbour's bit facing the center is its
  // −X/+X/−Z/+Z face bit respectively.
  const centerVis = buried ? buried.vis : visZero();
  const nb = (sideView, meshed = true) => ({ meshed, vis: { topExposed: new Uint8Array(256), sideView, voidTop: 0 } });
  const sealed4 = () => [nb(0), nb(0), nb(0), nb(0)];
  const facingBits = [[1 << 1, 0, 'east(−X)'], [1 << 0, 1, 'west(+X)'], [1 << 5, 2, 'south(−Z)'], [1 << 4, 3, 'north(+Z)']];
  for (const [bit, slot, name] of facingBits) {
    const n = sealed4();
    n[slot] = nb(bit);
    if (cullGateSkip(centerVis, ...n) !== false)
      failsBC.push(`gate must DRAW when the ${name} neighbour's facing bit is set`);
  }
  if (cullGateSkip(centerVis, nb(0), nb(0, false), nb(0), nb(0)) !== false)
    failsBC.push('gate must DRAW when a neighbour is not MESHED');
  if (cullGateSkip(centerVis, nb(0), { meshed: true, vis: null }, nb(0), nb(0)) !== false)
    failsBC.push('gate must DRAW when a neighbour has no summary');
  if (cullGateSkip(centerVis, null, null, null, null) !== false)
    failsBC.push('gate must DRAW with no neighbours at all (edge of the loaded world)');
  if (cullGateSkip(null, ...sealed4()) !== false)
    failsBC.push('gate must DRAW a chunk without a summary');
  const exposed = visZero();
  exposed.topExposed[0] = 1;
  if (cullGateSkip({ topExposed: exposed.topExposed, sideView: 0 }, ...sealed4()) !== false)
    failsBC.push('gate must DRAW when a single topExposed bit is set');
  if (cullGateSkip({ topExposed: new Uint8Array(256), sideView: 1 }, ...sealed4()) !== false)
    failsBC.push('gate must DRAW when the center reports any border view');
  notesBC.push('gate DRAW on: each facing bit, unmeshed neighbour, summary-less neighbour, no neighbours, no summary, any exposure');
  report('b+c', 'buried chunk → SKIP; any doubt (facing bit / unmeshed / exposure) → DRAW', failsBC, notesBC);

  // ---------------------------------------------------------------- (e)
  // Instance-level render gate: a REAL ChunkManager against a stub scene —
  // the sealed chunk's group must leave the scene, come back on markDirty,
  // and never stay hidden while the player stands in its columns.
  const failsE = [], notesE = [];
  try {
    const { ChunkManager } = await imp('world/ChunkManager.js');
    const inScene = new Set();
    const sceneStub = {
      add(o) { inScene.add(o); },
      remove(o) { inScene.delete(o); },
    };
    const worldStub = { chunks: new Map(), playerChunk: { cx: 10, cz: 10 }, activeDim: 0, hasSkyLight: true, chunkVersion: 0, players: [] };
    // The ctor's worker spawns throw (no Worker global in Node) and degrade
    // to the documented main-thread fallback — exactly the paths used here.
    const mgr = new ChunkManager(worldStub, sceneStub, { opaque: {}, cutout: {}, water: {} }, tileUV);
    // 3×3 sealed neighbourhood: all stone, all MESHED with zero summaries,
    // except the center which goes through the REAL applyGeometry path.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const c = new Chunk(dx, dz, 0);
        c.install(new Uint8Array(32768).fill(B.STONE), new Uint8Array(256).fill(128), new Uint8Array(256).fill(3), null);
        c.state = dx === 0 && dz === 0 ? ChunkState.LIT : ChunkState.MESHED;
        c.vis = visZero();
        worldStub.chunks.set(c.key, c);
      }
    }
    const center = worldStub.chunks.get('0,0');
    mgr.applyGeometry(center, { opaque: null, cutout: null, water: null }, visZero());
    if (center.state !== ChunkState.MESHED) failsE.push('applyGeometry must promote LIT → MESHED');
    if (inScene.has(center.group)) failsE.push('sealed chunk group was NOT removed from the scene');
    if (center.cullHidden !== true) failsE.push('cullHidden flag not recorded for the sealed chunk');
    // a NEIGHBOUR gaining a facing view must pull the center back in
    worldStub.chunks.get('1,0').vis = { topExposed: new Uint8Array(256), sideView: 1 << 1 };
    mgr.updateCullGate(center);
    if (!inScene.has(center.group)) failsE.push('group not restored after the east neighbour grew a −X view');
    // …and losing it seals the center again
    worldStub.chunks.get('1,0').vis = visZero();
    mgr.updateCullGate(center);
    if (inScene.has(center.group)) failsE.push('group not removed again after the neighbour view cleared');
    // an edit (markDirty) draws the chunk until a fresh proof arrives
    mgr.markDirty('0,0');
    if (!inScene.has(center.group)) failsE.push('markDirty must re-add the group (edit may have exposed the chunk)');
    // the player standing in the column forbids the skip entirely
    worldStub.playerChunk = { cx: 0, cz: 0 };
    mgr.updateCullGate(center);
    if (!inScene.has(center.group)) failsE.push('gate hid a chunk the player is standing in');
    worldStub.playerChunk = { cx: 10, cz: 10 };
    mgr.updateCullGate(center);
    if (inScene.has(center.group)) failsE.push('group not re-sealed after the player left the column');
    // void-plane guard: a summary that is all-zero EXCEPT voidTop must draw
    // while a camera is above the build limit and skip again below it.
    worldStub.chunks.get('1,0').vis = { topExposed: new Uint8Array(256), sideView: 0, voidTop: 0 };
    center.vis = { topExposed: new Uint8Array(256), sideView: 0, voidTop: 1 };
    worldStub.players = [{ pos: { x: 0, y: 200, z: 0 } }];
    mgr.updateCullGate(center);
    if (!inScene.has(center.group)) failsE.push('void-only chunk was hidden while a camera is above the build limit');
    worldStub.players = [{ pos: { x: 0, y: 10, z: 0 } }];
    mgr.updateCullGate(center);
    if (inScene.has(center.group)) failsE.push('void-only chunk not re-sealed once every camera is below the build limit');
    center.vis = visZero();
    notesE.push('real ChunkManager + stub scene: remove when sealed; restore on neighbour view, markDirty, player, above-limit camera; re-seal after');
  } catch (e) {
    failsE.push('instance gate threw: ' + (e.stack || e).split('\n').slice(0, 3).join(' | '));
  }
  report('e', 'render gate — sealed group leaves the scene; doubt restores it', failsE, notesE);

  console.log(`\nU22 ${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks green`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('U22 harness threw:', e.stack || e);
  process.exit(1);
});
