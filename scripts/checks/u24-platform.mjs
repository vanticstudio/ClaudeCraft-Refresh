// B11/U24 — platform-wave self-check (self-contained; exit 0/1).
// Run: node scripts/checks/u24-platform.mjs
// Covers: (a) .ccworld encode→decode round-trip record equality, (b) magic/
// truncation rejection, (c) gamepad mapping completeness, (d) webmanifest sanity.
// This file uses console.log — it is a script, not src/ (smoke U8 only binds src/).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GAMEPAD_MAPPING, GAMEPAD_DEADZONE } from '../../src/player/input.js';
import { exportWorld, importWorld, encodeWorld, decodeWorld, CCW_MAGIC } from '../../src/world/exportWorld.js';
import { SAVE_VERSION } from '../../src/constants.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fails = [];
const check = (name, ok, note = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  — ${note}` : ''}`);
  if (!ok) fails.push(name);
};

// ---- fixture: fake saveManager-shaped object with in-memory records ----
// Shapes mirror saveManager.js verbatim:
//   meta   = buildMeta(): { version, seed, worldTime, weather, players, dimensions, lastSaved }
//   chunk  = serializeChunk(): { cx, cz, blocks|states|biomes: ArrayBuffer,
//             blockEntities: [{i,type,data}], spawnsDone, spawns, villageMeta, entities }
//   player = the host's record inside meta.players
function chunkFixture(cx, cz) {
  const blocks = new ArrayBuffer(32768);
  const states = new ArrayBuffer(32768);
  const biomes = new ArrayBuffer(256);
  new Uint8Array(blocks)[5] = 3;      // non-trivial buffer content
  new Uint8Array(states)[7] = 200;
  new Uint8Array(biomes)[0] = 9;
  return {
    cx, cz, blocks, states, biomes,
    blockEntities: [{ i: 42, type: 'chest', data: { slots: [] } }],
    spawnsDone: true,
    spawns: null,
    villageMeta: cx === 0 ? { houses: 3, golemTimer: 12 } : null,
    entities: [{ type: 'zombie', x: 8.5, y: 64, z: 8.5 }],
  };
}
const playerRec = { name: 'Tester', health: 17, pos: { x: 8.5, y: 70, z: 8.5 }, gameMode: 0 };
const metaFixture = {
  version: SAVE_VERSION,
  seed: 'roundtrip-seed',
  worldTime: 4242,
  weather: { time: 0.5, rain: 0 },
  players: { host: playerRec },
  dimensions: { 1: { portalLinks: [] } },
  lastSaved: 1759000000000,
};

function fakeSave() {
  const chunks = [
    { key: '0:0,0', record: chunkFixture(0, 0) },
    { key: '0:1,-3', record: chunkFixture(1, -3) },
    { key: '1:-2,5', record: chunkFixture(-2, 5) },   // a Nether-dim chunk
  ];
  return {
    hostId: 'host',
    meta: metaFixture,
    chunks,
    installed: null,
    async exportAll() { return { meta: this.meta, chunks: this.chunks, player: this.meta.players[this.hostId] }; },
    async installWorld(payload) { this.installed = payload; return payload.meta; },
  };
}

// Byte-exact comparison helper: ArrayBuffers → base64, then JSON equality.
const b64 = buf => Buffer.from(buf).toString('base64');
const normChunk = r => JSON.stringify({
  ...r,
  blocks: b64(r.blocks), states: b64(r.states), biomes: b64(r.biomes),
});
const normPlayer = p => JSON.stringify(p);

try {
  // (a) round-trip: exportWorld(fake) → bytes → importWorld(fake2, bytes)
  const src = fakeSave();
  const bytes = await exportWorld(src);
  check('U24a1 exportWorld returns a CCW1 ArrayBuffer',
    bytes instanceof ArrayBuffer && new TextDecoder().decode(new Uint8Array(bytes, 0, 4)) === CCW_MAGIC);

  const dst = fakeSave();
  const installedMeta = await importWorld(dst, bytes);
  check('U24a2 importWorld installs via save.installWorld', !!dst.installed && dst.installed.meta === installedMeta);

  // meta: every original field survives; import may ADD fields (worldId, importedAt)
  const a = JSON.parse(JSON.stringify(src.meta));
  const b = JSON.parse(JSON.stringify(dst.installed.meta));
  const extra = Object.keys(b).filter(k => !(k in a));
  const metaEqual = Object.keys(a).every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));
  check('U24a3 meta record round-trips field-for-field',
    metaEqual && ['worldId', 'importedAt'].every(k => extra.includes(k)));

  const chunksEqual = dst.installed.chunks.length === src.chunks.length &&
    dst.installed.chunks.every((c, i) =>
      c.key === src.chunks[i].key && normChunk(c.record) === normChunk(src.chunks[i].record));
  check('U24a4 chunk records round-trip byte-equal (buffers → base64 compare)', chunksEqual);

  const dstPlayer = dst.installed.meta.players?.host ?? dst.installed.meta.player;
  check('U24a5 player record round-trips', normPlayer(dstPlayer) === normPlayer(playerRec));

  check('U24a6 import stamps a NEW world identity',
    typeof installedMeta.worldId === 'string' && installedMeta.worldId.length > 0 &&
    typeof installedMeta.importedAt === 'number');

  // (b) garbage rejection
  const garbage = [
    ['empty', new ArrayBuffer(0)],
    ['wrong magic', encodeText('NOPE0000...')],
    ['truncated header', new Uint8Array(bytes).slice(0, 8).buffer],
    ['truncated body', new Uint8Array(bytes).slice(0, 4 + 4 + 10).buffer],
  ];
  for (const [name, buf] of garbage) {
    let threw = null;
    try { await importWorld(fakeSave(), buf); } catch (err) { threw = err; }
    check(`U24b reject: ${name}`, threw instanceof Error, threw?.message ?? 'NO THROW');
  }

  // (c) gamepad mapping completeness — every required action id covered, or an
  // explicit null declaration (per 19-BUILDOUT §5's "binding or explicit null").
  const requiredButtons = ['jump', 'drop', 'inventory', 'attack', 'use'];
  const mappingOk = requiredButtons.every(k => typeof GAMEPAD_MAPPING.buttons[k] === 'number') &&
    typeof GAMEPAD_MAPPING.buttons.hotbarPrev === 'number' &&
    typeof GAMEPAD_MAPPING.buttons.hotbarNext === 'number';
  const explicitNulls = ['sneak', 'sprint'].every(k => GAMEPAD_MAPPING.buttons[k] === null);
  const axesOk = ['moveX', 'moveY', 'lookX', 'lookY'].every(k => typeof GAMEPAD_MAPPING.axes[k] === 'number');
  check('U24c gamepad mapping covers move/look/jump/attack/use/drop/inventory/hotbar',
    mappingOk && axesOk && explicitNulls,
    `deadzone ${GAMEPAD_DEADZONE}`);
  check('U24c2 standard-mapping indices in range', (() => {
    const idx = Object.values(GAMEPAD_MAPPING.buttons).filter(v => v !== null)
      .concat(Object.values(GAMEPAD_MAPPING.axes));
    return idx.every(v => typeof v === 'number' && v >= 0 && v <= 17);
  })());

  // (d) webmanifest parses with required fields
  const mf = JSON.parse(readFileSync(join(HERE, '..', '..', 'public', 'manifest.webmanifest'), 'utf8'));
  const mfOk = mf.name === 'ClaudeCraft' && mf.display === 'fullscreen' &&
    mf.orientation === 'landscape' && typeof mf.start_url === 'string' &&
    Array.isArray(mf.icons) && mf.icons.some(i => /192/.test(i.sizes)) &&
    mf.icons.some(i => /512/.test(i.sizes));
  check('U24d manifest.webmanifest parses + required fields', mfOk);
  check('U24d2 manifest icons reference the shipped logo',
    mf.icons.every(i => i.src === 'menu/logo-primary.png' && i.type === 'image/png'));
} catch (err) {
  console.log(`FAIL  U24 harness — unexpected error: ${err?.stack ?? err}`);
  fails.push('harness');
}

function encodeText(s) {
  const u8 = new TextEncoder().encode(s);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

console.log(fails.length ? `\nU24 FAIL — ${fails.length} check(s) red` : '\nU24 PASS — all checks green');
process.exit(fails.length ? 1 : 0);