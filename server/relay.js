// 14-MULTIPLAYER §1.2 — the WebSocket relay. Pure passthrough: rooms, join codes,
// sender tagging, routing, heartbeat, caps. It NEVER parses game payloads — the
// one-byte target/sender convention (§1.2) is its entire game-facing API.
//
//   npm run relay                 → listen on :8971 (env PORT overrides)
//   npm run relay -- --port 9000  → custom port
//   npm run relay -- --delay 100  → +100 ms one-way latency each direction (RTT≈200)
//   npm run relay -- --jitter 30  → +0–30 ms uniform random extra delay (§13)
import { WebSocketServer } from 'ws';
import { randomInt } from 'node:crypto';

// ------------------------------------------------------------------ flags
function flag(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const PORT = Number(process.env.PORT ?? flag('port', 8971));
const DELAY = Number(flag('delay', 0));            // one-way ms
const JITTER_MAX = Number(flag('jitter', 0));      // uniform 0..jitter ms
const RELAY_V = 1;                                 // relay protocol version (independent of game PROTO_VERSION)

// §10 caps
const MAX_ROOMS = 64;
const ROOM_CAP = 8;                                // host slot 0 + clients 1..7
const CLIENT_MAX_FRAME = 16 * 1024;
const HOST_MAX_FRAME = 256 * 1024;
const MSG_BUCKET = 200;                            // token bucket size
const MSG_REFILL_PER_S = 100;                      // tokens/s
const JOIN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 31 chars, no 0/O/1/I/L

const rooms = new Map();   // code → { host: ws, clients: Map<slot, ws> }

function newCode() {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let c = '';
    for (let i = 0; i < 6; i++) c += JOIN_ALPHABET[randomInt(JOIN_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
const send = (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* closing */ } };
function jitter() { return DELAY + (JITTER_MAX ? randomInt(JITTER_MAX + 1) : 0); }
function fwd(sock, buf) {
  if (!sock || sock.readyState !== sock.OPEN) return;
  const d = jitter();
  if (d > 0) setTimeout(() => { if (sock.readyState === sock.OPEN) sock.send(buf); }, d);
  else sock.send(buf);
}

const wss = new WebSocketServer({ port: PORT, perMessageDeflate: false, maxPayload: HOST_MAX_FRAME });

function createRoom(ws) {
  if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'err', reason: 'relay-full' });
  const code = newCode();
  if (!code) return send(ws, { t: 'err', reason: 'relay-full' });
  const room = { host: ws, clients: new Map() };
  rooms.set(code, room);
  ws.room = room; ws.roomCode = code; ws.slot = 0;
  send(ws, { t: 'room', code });
}

function joinRoom(ws, code) {
  const room = code && rooms.get(String(code).toUpperCase());
  if (!room) return send(ws, { t: 'err', reason: 'nocode' });
  if (room.clients.size + 1 >= ROOM_CAP) return send(ws, { t: 'err', reason: 'full' });
  let slot = 1;
  while (room.clients.has(slot)) slot++;      // lowest free 1..7
  if (slot > ROOM_CAP - 1) return send(ws, { t: 'err', reason: 'full' });
  room.clients.set(slot, ws);
  ws.room = room; ws.roomCode = String(code).toUpperCase(); ws.slot = slot;
  send(ws, { t: 'joined', slot });
  send(room.host, { t: 'peer+', slot });
}

function route(ws, buf) {
  const room = ws.room;
  if (!room) return;
  if (ws.slot === 0) {                         // host → clients
    if (buf.length < 1) return;
    const target = buf[0];
    const payload = buf.subarray(1);
    if (target === 0xFF) for (const c of room.clients.values()) fwd(c, payload);
    else fwd(room.clients.get(target), payload);
  } else {                                     // client → host: prepend senderSlot
    if (buf.length > CLIENT_MAX_FRAME) return ws.close(1009, 'frame');
    const tagged = Buffer.allocUnsafe(buf.length + 1);
    tagged[0] = ws.slot;
    buf.copy ? buf.copy(tagged, 1) : Buffer.from(buf).copy(tagged, 1);
    fwd(room.host, tagged);
  }
}

function closeRoom(room, code) {
  for (const c of room.clients.values()) { send(c, { t: 'hostGone' }); try { c.close(1000, 'host gone'); } catch {} }
  rooms.delete(code);
}

function onDisconnect(ws) {
  const room = ws.room;
  if (!room) return;
  if (ws.slot === 0) {                         // host left → room dies (§1.2)
    closeRoom(room, ws.roomCode);
  } else {                                      // client left → notify host, free slot
    room.clients.delete(ws.slot);
    send(room.host, { t: 'peer-', slot: ws.slot });
  }
  ws.room = null;
}

wss.on('connection', (ws, req) => {
  req.socket.setNoDelay(true);                 // kill Nagle (§1.2)
  ws.isAlive = true;
  ws.tokens = MSG_BUCKET;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.once('message', (data, isBinary) => {     // first frame = control (JSON)
    if (isBinary) return ws.close(1002, 'expected control');
    let m; try { m = JSON.parse(data.toString()); } catch { return ws.close(1002, 'bad json'); }
    if (m.v !== RELAY_V) return (send(ws, { t: 'err', reason: 'relay-version' }), ws.close());
    if (m.t === 'host') createRoom(ws);
    else if (m.t === 'join') joinRoom(ws, m.code);
    else return ws.close(1002, 'bad control');
    ws.on('message', (buf, bin) => {           // subsequent frames = data (binary)
      if (!bin) return;                        // in-session JSON rides binary frames post-handshake
      // §10 — the token bucket is the CLIENT message-rate cap (100/s, bucket 200).
      // The HOST (slot 0) is exempt: it fans snapshots, playerState and the chunk
      // stream out to every peer, which is well past 100 msgs/s at even one client
      // (§11), so metering it kills a healthy room. Host abuse is moot — it owns
      // the room and can close it at will.
      if (ws.slot !== 0 && --ws.tokens < 0) return ws.close(1008, 'rate');
      route(ws, buf);
    });
  });
  ws.on('close', () => onDisconnect(ws));
  ws.on('error', () => onDisconnect(ws));
});

setInterval(() => wss.clients.forEach(ws => {  // 5 s heartbeat, 10 s timeout (§1.2)
  if (!ws.isAlive) return ws.terminate();
  ws.isAlive = false;
  try { ws.ping(); } catch {}
}), 5000);
setInterval(() => wss.clients.forEach(ws => { ws.tokens = Math.min(MSG_BUCKET, ws.tokens + MSG_REFILL_PER_S); }), 1000);

console.log(`[relay] ws://localhost:${PORT}  (delay=${DELAY}ms jitter=${JITTER_MAX}ms rooms<=${MAX_ROOMS})`);
