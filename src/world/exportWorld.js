// B11 — world export/import: the .ccworld container.
//
// Layout (all integers little-endian u32):
//   [4b  magic 'CCW1']
//   [4b  metaLen   ][meta JSON utf8]     — SaveManager.buildMeta() shape verbatim
//   [4b  chunksLen ][chunks JSON utf8]   — [{ key, record }] — record = serializeChunk() shape
//   [4b  playerLen ][player JSON utf8]   — the host's player record (or null)
//
// We deliberately do NOT invent a second record format: meta and chunk records
// are the same objects saveManager writes to IndexedDB. The ONE transformation
// is transport-only: chunk records carry ArrayBuffer fields (blocks/states/
// biomes), which JSON cannot express — those three fields are base64-encoded on
// encode and decoded back to real ArrayBuffers on import. Everything else
// round-trips byte-exact.
import { SAVE_VERSION } from '../constants.js';

export const CCW_MAGIC = 'CCW1';

// B11 deviation note — the phase wants a world thumbnail in meta; that needs a
// render hook in main.js/Game (off-limits this wave). We stamp the placeholder
// note into the EXPORTED meta copy so future files carry the intent without
// rewriting the live IndexedDB meta.
const THUMB_NOTE = 'Thumbnails deferred to a later wave (needs a render hook outside B11\'s file scope).';

// The only fields of a chunk record that are ArrayBuffers. Keep in lockstep
// with serializeChunk() in saveManager.js.
const BUFFER_FIELDS = ['blocks', 'states', 'biomes'];

function abToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64ToAb(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Chunk record → JSON-safe copy (buffers become base64 strings, in place on a shallow copy). */
function encodeChunkRec(rec) {
  const out = { ...rec };
  for (const f of BUFFER_FIELDS) {
    if (out[f] instanceof ArrayBuffer) out[f] = abToB64(out[f]);
  }
  return out;
}

/** JSON-safe chunk record → real record (base64 fields back to ArrayBuffers). */
function decodeChunkRec(rec) {
  const out = { ...rec };
  for (const f of BUFFER_FIELDS) {
    if (typeof out[f] === 'string') out[f] = b64ToAb(out[f]);
  }
  return out;
}

/**
 * Serialize { meta, chunks, player } into the CCW1 byte layout.
 * Exported for tests; exportWorld() is the saveManager-facing entry point.
 */
export function encodeWorld({ meta, chunks, player }) {
  const metaJson = enc.encode(JSON.stringify(meta));
  const chunksJson = enc.encode(JSON.stringify(
    chunks.map(c => ({ key: c.key, record: encodeChunkRec(c.record) }))
  ));
  const playerJson = enc.encode(JSON.stringify(player ?? null));
  const buf = new ArrayBuffer(4 + 12 + metaJson.length + chunksJson.length + playerJson.length);
  const dv = new DataView(buf);
  let off = 0;
  const magic = enc.encode(CCW_MAGIC);
  new Uint8Array(buf, 0, 4).set(magic);
  off = 4;
  for (const section of [metaJson, chunksJson, playerJson]) {
    dv.setUint32(off, section.length, true);
    new Uint8Array(buf, off + 4, section.length).set(section);
    off += 4 + section.length;
  }
  return buf;
}

/**
 * Parse + validate a CCW1 buffer. Throws (with a human-readable message) on a
 * wrong magic, truncation, or malformed section JSON — the full world-version
 * gate lives in importWorld().
 */
export function decodeWorld(arrayBuffer) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  if (bytes.length < 4 || dec.decode(bytes.subarray(0, 4)) !== CCW_MAGIC) {
    throw new Error('Not a ClaudeCraft world file (missing CCW1 header)');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = start => {
    if (start + 4 > bytes.length) throw new Error('Truncated world file');
    const len = dv.getUint32(start, true);
    if (start + 4 + len > bytes.length) throw new Error('Truncated world file');
    return JSON.parse(dec.decode(bytes.subarray(start + 4, start + 4 + len)));
  };
  let off = 4;
  const meta = read(off); off += 4 + dv.getUint32(off, true);
  if (!meta || typeof meta !== 'object' || typeof meta.seed === 'undefined') {
    throw new Error('World file has no meta record');
  }
  const chunks = read(off); off += 4 + dv.getUint32(off, true);
  if (!Array.isArray(chunks)) throw new Error('World file has no chunk list');
  const player = read(off); off += 4 + dv.getUint32(off, true);
  return { meta, chunks, player };
}

/**
 * Gather the CURRENT world via saveManager and return the .ccworld bytes.
 * Resolves null-safe: throws when there is nothing to export (no db/meta).
 */
export async function exportWorld(save) {
  const data = await save.exportAll();
  if (!data || !data.meta) throw new Error('No world to export');
  return encodeWorld({
    meta: { ...data.meta, thumbnail: null, thumbnailNote: THUMB_NOTE },
    chunks: data.chunks,
    player: data.player ?? null,
  });
}

/**
 * Validate + install a .ccworld into `save` (SaveManager-shaped: needs
 * installWorld()). Installs as a NEW world — a fresh worldId is stamped so the
 * imported copy never claims to be the same world it was exported from (the
 * single-DB layout means import replaces the browser's one save slot).
 * Resolves with the installed meta.
 */
export async function importWorld(save, arrayBuffer) {
  const data = decodeWorld(arrayBuffer);
  const meta = data.meta;
  if (typeof meta.version !== 'number') throw new Error('World file has no save version');
  if (meta.version > SAVE_VERSION) {
    throw new Error(`World was saved by a NEWER version of the game (v${meta.version} > v${SAVE_VERSION})`);
  }
  const chunks = data.chunks.map(c => {
    if (!c || typeof c.key !== 'string' || !c.record) {
      throw new Error('World file has a malformed chunk record');
    }
    return { key: c.key, record: decodeChunkRec(c.record) };
  });

  // Mirror saveManager.migrate() up-converts, WITHOUT a live db (install wipes
  // the chunk store anyway, so the v1 chunk-clear step needs no equivalent —
  // but v1 keys were bare "cx,cz" and must gain the v2 "0:" dimension prefix).
  let player = data.player ?? null;
  if (meta.version < 2) {
    meta.dimensions = meta.dimensions ?? {};
    for (const c of chunks) if (!/^\d+:/.test(c.key)) c.key = '0:' + c.key;
    if (player) player.dimension = 0;
  }
  if (meta.version < 3 && !meta.players) {
    const hostId = save.hostId || 'host';
    meta.players = {};
    if (meta.player) { meta.players[hostId] = { ...meta.player, name: meta.player.name || 'Player', lastSeen: 0 }; delete meta.player; }
    else if (player) meta.players[hostId] = { ...player, name: player.name || 'Player', lastSeen: 0 };
  }
  meta.version = SAVE_VERSION;

  // NEW world identity (§brief: "installs as a NEW world") + provenance. The
  // id is additive metadata — buildMeta() rewrites meta on the next save, so
  // it survives only until then; the seed remains the real world identity.
  meta.worldId = globalThis.crypto?.randomUUID?.() ?? ('w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  meta.importedAt = Date.now();
  if (meta.thumbnailNote === undefined) {
    meta.thumbnailNote = THUMB_NOTE;
    meta.thumbnail = meta.thumbnail ?? null;
  }
  await save.installWorld({ meta, chunks });
  return meta;
}