// 14-MULTIPLAYER §3 — the wire protocol. Hot-path messages are hand-packed
// little-endian ArrayBuffers (§3.4); infrequent messages are JSON. Both travel as
// BINARY frames post-handshake so the relay's single one-byte routing path (§1.2)
// covers them uniformly — a JSON message is a 0x00-tagged UTF-8 payload (see
// DEVIATIONS; §3.1's "text frame" is realized as msgId 0x00). Byte 0 of every
// decoded payload is the message id.
//
// Framing asymmetry (§1.2):
//   client→host: NetClient sends the bare payload (msgId at byte 0); the relay
//                prepends senderSlot, so the host reads [slot][msgId..].
//   host→client: NetHost prepends a target byte (slot|0xFF); the relay strips it,
//                so the client reads [msgId..].

export const PROTO_VERSION = 1;   // bump on ANY wire-format change (§2.1)
export const RELAY_VERSION = 1;   // relay handshake version (§1.2)

export const MSG = {
  JSON: 0x00,
  INPUT: 0x01,
  SNAPSHOT: 0x02,
  BLOCK_EDIT: 0x03,
  BLOCK_SET: 0x04,
  CHUNK_DATA: 0x05,
  PING: 0x06,
  PONG: 0x07,
};

// Snapshot entity type enum (§3.4). Maps entity.type string ↔ wire byte.
export const ETYPE = {
  player: 1, zombie: 2, skeleton: 3, creeper: 4, spider: 5, enderman: 6,
  cow: 7, pig: 8, sheep: 9, chicken: 10,
  item: 16, arrow: 17, falling_block: 18, primed_tnt: 19, xp_orb: 20, thrown: 21,
  // 32–63 reserved for expansions
  villager: 32, iron_golem: 33, zombie_villager: 34,
  blaze: 40, ghast: 41, magma_cube: 42, wither_skeleton: 43,
  zombified_piglin: 44, piglin: 45, shulker: 46,
  ender_dragon: 48, wither: 49, end_crystal: 50,
};
export const ETYPE_REV = Object.fromEntries(Object.entries(ETYPE).map(([k, v]) => [v, k]));

// Input button bit positions (§3.4, message 0x01)
export const BTN = {
  FWD: 0, BACK: 1, LEFT: 2, RIGHT: 3, JUMP: 4, SNEAK: 5, SPRINT: 6,
  USE: 7, ATTACK: 8, FLYING: 9,   // 10–15 reserved
};

// Snapshot entity flag bits (§3.4 record +16)
export const EFLAG = {
  ON_GROUND: 1, SPRINTING: 2, SNEAKING: 4, BURNING: 8,
  SWINGING: 16, GLIDING: 32, HURT: 64, DEAD: 128,
};
// Snapshot ownFlags bits (§3.4 header +32)
export const OWNFLAG = {
  ON_GROUND: 1, IN_WATER: 2, IN_LAVA: 4, ON_LADDER: 8,
  SPRINTING: 16, BURNING: 32, SLEEPING: 64, FLYING: 128,
};

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const enc = new TextEncoder();
const dec = new TextDecoder();
const clampI8 = v => v < -127 ? -127 : v > 127 ? 127 : v;

// ------------------------------------------------------------------ JSON frames
export function encodeJson(obj) {
  const body = enc.encode(JSON.stringify(obj));
  const out = new Uint8Array(body.length + 1);
  out[0] = MSG.JSON;
  out.set(body, 1);
  return out;
}
export function decodeJson(u8) {
  return JSON.parse(dec.decode(u8.subarray(1)));
}

// ------------------------------------------------------------------ 0x01 input
export function encodeInput(seq, buttons, yaw, pitch, hotbar) {
  const b = new ArrayBuffer(10), v = new DataView(b);
  v.setUint8(0, MSG.INPUT);
  v.setUint16(1, seq & 0xffff, true);
  v.setUint16(3, buttons & 0xffff, true);
  let yq = Math.round((((yaw % TAU) + TAU) % TAU) / TAU * 65536) & 0xffff;
  v.setUint16(5, yq, true);
  let pq = Math.round((pitch / DEG) * 364);
  pq = pq < -32760 ? -32760 : pq > 32760 ? 32760 : pq;
  v.setInt16(7, pq, true);
  v.setUint8(9, hotbar & 0xff);
  return new Uint8Array(b);
}
export function decodeInput(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return {
    seq: v.getUint16(1, true),
    buttons: v.getUint16(3, true),
    yaw: v.getUint16(5, true) / 65536 * TAU,
    pitch: v.getInt16(7, true) / 364 * DEG,
    hotbar: v.getUint8(9),
  };
}

// ------------------------------------------------------------------ 0x02 snapshot
// Entity record layout (19 B). ecx = floor(x)>>4 is the entity chunk.
export const SNAP_HEADER = 42;
export const SNAP_REC = 19;

export function encodeSnapshotHeader(v, off, { hostTick, keyframe, lastInputSeq, ownPos, ownVel, ownFlags, acx, acz, count }) {
  v.setUint8(off, MSG.SNAPSHOT);
  v.setUint32(off + 1, hostTick >>> 0, true);
  v.setUint8(off + 5, keyframe ? 1 : 0);
  v.setUint16(off + 6, lastInputSeq & 0xffff, true);
  v.setFloat32(off + 8, ownPos.x, true); v.setFloat32(off + 12, ownPos.y, true); v.setFloat32(off + 16, ownPos.z, true);
  v.setFloat32(off + 20, ownVel.x, true); v.setFloat32(off + 24, ownVel.y, true); v.setFloat32(off + 28, ownVel.z, true);
  v.setUint8(off + 32, ownFlags & 0xff);
  v.setInt32(off + 33, acx | 0, true); v.setInt32(off + 37, acz | 0, true);
  v.setUint8(off + 41, count & 0xff);
}

// Write one 19-B entity record at `off`. `anchor` = {acx,acz}.
export function encodeEntityRecord(v, off, r, acx, acz) {
  const ecx = Math.floor(r.x) >> 4, ecz = Math.floor(r.z) >> 4;
  v.setUint16(off, r.id & 0xffff, true);
  v.setUint8(off + 2, r.type & 0xff);
  v.setInt8(off + 3, clampI8(ecx - acx));
  v.setInt8(off + 4, clampI8(ecz - acz));
  let relX = Math.round((r.x - ecx * 16) * 2048); relX = relX < 0 ? 0 : relX > 65535 ? 65535 : relX;
  let relY = Math.round(Math.min(127.99, Math.max(0, r.y)) * 256);
  let relZ = Math.round((r.z - ecz * 16) * 2048); relZ = relZ < 0 ? 0 : relZ > 65535 ? 65535 : relZ;
  v.setUint16(off + 5, relX, true);
  v.setUint16(off + 7, relY & 0xffff, true);
  v.setUint16(off + 9, relZ, true);
  v.setInt8(off + 11, clampI8(Math.round(r.vx * 32)));
  v.setInt8(off + 12, clampI8(Math.round(r.vy * 32)));
  v.setInt8(off + 13, clampI8(Math.round(r.vz * 32)));
  v.setUint8(off + 14, Math.round((((r.yaw % TAU) + TAU) % TAU) / TAU * 256) & 0xff);
  v.setInt8(off + 15, clampI8(Math.round((r.pitch / DEG) / 90 * 127)));
  v.setUint8(off + 16, r.flags & 0xff);
  v.setUint8(off + 17, r.stateByte & 0xff);
  v.setUint8(off + 18, Math.min(255, Math.max(0, Math.ceil(r.health || 0))));
}

export function decodeSnapshot(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const acx = v.getInt32(33, true), acz = v.getInt32(37, true);
  const header = {
    hostTick: v.getUint32(1, true),
    keyframe: (v.getUint8(5) & 1) !== 0,
    lastInputSeq: v.getUint16(6, true),
    ownPos: { x: v.getFloat32(8, true), y: v.getFloat32(12, true), z: v.getFloat32(16, true) },
    ownVel: { x: v.getFloat32(20, true), y: v.getFloat32(24, true), z: v.getFloat32(28, true) },
    ownFlags: v.getUint8(32),
    acx, acz,
  };
  const count = v.getUint8(41);
  const entities = [];
  for (let i = 0; i < count; i++) {
    const o = SNAP_HEADER + i * SNAP_REC;
    const ecx = acx + v.getInt8(o + 3), ecz = acz + v.getInt8(o + 4);
    entities.push({
      id: v.getUint16(o, true),
      type: v.getUint8(o + 2),
      x: ecx * 16 + v.getUint16(o + 5, true) / 2048,
      y: v.getUint16(o + 7, true) / 256,
      z: ecz * 16 + v.getUint16(o + 9, true) / 2048,
      vx: v.getInt8(o + 11) / 32, vy: v.getInt8(o + 12) / 32, vz: v.getInt8(o + 13) / 32,
      yaw: v.getUint8(o + 14) / 256 * TAU,
      pitch: v.getInt8(o + 15) / 127 * 90 * DEG,
      flags: v.getUint8(o + 16),
      stateByte: v.getUint8(o + 17),
      health: v.getUint8(o + 18),
    });
  }
  return { header, entities };
}

// ------------------------------------------------------------------ 0x03 blockEdit
export function encodeBlockEdit(action, editSeq, x, y, z, face, hotbarSlot) {
  const b = new ArrayBuffer(15), v = new DataView(b);
  v.setUint8(0, MSG.BLOCK_EDIT);
  v.setUint8(1, action & 0xff);
  v.setUint16(2, editSeq & 0xffff, true);
  v.setInt32(4, x | 0, true);
  v.setUint8(8, y & 0xff);
  v.setInt32(9, z | 0, true);
  v.setUint8(13, face & 0xff);
  v.setUint8(14, hotbarSlot & 0xff);
  return new Uint8Array(b);
}
export function decodeBlockEdit(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return {
    action: v.getUint8(1), editSeq: v.getUint16(2, true),
    x: v.getInt32(4, true), y: v.getUint8(8), z: v.getInt32(9, true),
    face: v.getUint8(13), hotbarSlot: v.getUint8(14),
  };
}

// ------------------------------------------------------------------ 0x04 blockSet
// records: [{x,y,z,id,state}] — 11 B each.
export function encodeBlockSet(dim, records) {
  const n = records.length;
  const b = new ArrayBuffer(4 + n * 11), v = new DataView(b);
  v.setUint8(0, MSG.BLOCK_SET);
  v.setUint8(1, dim & 0xff);
  v.setUint16(2, n & 0xffff, true);
  let o = 4;
  for (const r of records) {
    v.setInt32(o, r.x | 0, true);
    v.setUint8(o + 4, r.y & 0xff);
    v.setInt32(o + 5, r.z | 0, true);
    v.setUint8(o + 9, r.id & 0xff);
    v.setUint8(o + 10, r.state & 0xff);
    o += 11;
  }
  return new Uint8Array(b);
}
export function decodeBlockSet(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const dim = v.getUint8(1), n = v.getUint16(2, true);
  const records = [];
  let o = 4;
  for (let i = 0; i < n; i++) {
    records.push({
      x: v.getInt32(o, true), y: v.getUint8(o + 4), z: v.getInt32(o + 5, true),
      id: v.getUint8(o + 9), state: v.getUint8(o + 10),
    });
    o += 11;
  }
  return { dim, records };
}

// ------------------------------------------------------------------ RLE (§2.3)
// (runLen u8 ≥1, value u8) pairs; a run longer than 255 splits into several pairs.
export function rleEncode(arr) {
  const out = [];
  let i = 0;
  const n = arr.length;
  while (i < n) {
    const val = arr[i];
    let run = 1;
    while (i + run < n && arr[i + run] === val && run < 255) run++;
    out.push(run, val);
    i += run;
  }
  return Uint8Array.from(out);
}
export function rleDecode(bytes, cells) {
  const out = new Uint8Array(cells);
  let o = 0;
  for (let i = 0; i + 1 < bytes.length && o < cells; i += 2) {
    const run = bytes[i], val = bytes[i + 1];
    for (let k = 0; k < run && o < cells; k++) out[o++] = val;
  }
  return out;
}

// ------------------------------------------------------------------ 0x05 chunkData
export function encodeChunkData(dim, cx, cz, blocksU8, statesU8, biomesU8) {
  const rb = rleEncode(blocksU8), rs = rleEncode(statesU8);
  const bio = biomesU8 && biomesU8.length === 256 ? biomesU8 : new Uint8Array(256);
  const total = 1 + 1 + 4 + 4 + 4 + rb.length + 4 + rs.length + 4 + 256;
  const b = new ArrayBuffer(total), v = new DataView(b), out = new Uint8Array(b);
  v.setUint8(0, MSG.CHUNK_DATA);
  v.setUint8(1, dim & 0xff);
  v.setInt32(2, cx | 0, true);
  v.setInt32(6, cz | 0, true);
  let o = 10;
  v.setUint32(o, rb.length, true); o += 4; out.set(rb, o); o += rb.length;
  v.setUint32(o, rs.length, true); o += 4; out.set(rs, o); o += rs.length;
  v.setUint32(o, 256, true); o += 4; out.set(bio, o); o += 256;
  return out;
}
export function decodeChunkData(u8, cells) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const dim = v.getUint8(1), cx = v.getInt32(2, true), cz = v.getInt32(6, true);
  let o = 10;
  const lenB = v.getUint32(o, true); o += 4;
  const blocks = rleDecode(u8.subarray(o, o + lenB), cells); o += lenB;
  const lenS = v.getUint32(o, true); o += 4;
  const states = rleDecode(u8.subarray(o, o + lenS), cells); o += lenS;
  const lenBio = v.getUint32(o, true); o += 4;
  const biomes = u8.slice(o, o + lenBio); o += lenBio;
  return { dim, cx, cz, blocks, states, biomes };
}

// ------------------------------------------------------------------ 0x06 ping / 0x07 pong
export function encodePing(clientNow) {
  const b = new ArrayBuffer(9), v = new DataView(b);
  v.setUint8(0, MSG.PING); v.setFloat64(1, clientNow, true);
  return new Uint8Array(b);
}
export function decodePing(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return { clientNow: v.getFloat64(1, true) };
}
export function encodePong(t0, hostTick, hostNow) {
  const b = new ArrayBuffer(21), v = new DataView(b);
  v.setUint8(0, MSG.PONG);
  v.setFloat64(1, t0, true);
  v.setUint32(9, hostTick >>> 0, true);
  v.setFloat64(13, hostNow, true);
  return new Uint8Array(b);
}
export function decodePong(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return { t0: v.getFloat64(1, true), hostTick: v.getUint32(9, true), hostNow: v.getFloat64(13, true) };
}

// u16 seq comparison with wraparound (§4.2 seqLE)
export function seqLE(a, b) { return ((b - a) & 0xffff) < 0x8000; }

// Block-face index ↔ normal, round-tripped through the blockEdit `face` byte so
// host and client agree regardless of the raycaster's internal naming (§3.4).
export const FACE6 = [
  [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0],
];
export function faceToIndex(f) {
  if (!f) return 1;
  for (let i = 0; i < 6; i++) if (FACE6[i][0] === f[0] && FACE6[i][1] === f[1] && FACE6[i][2] === f[2]) return i;
  return 1;
}
export function indexToFace(i) { return FACE6[i & 7] || FACE6[1]; }
