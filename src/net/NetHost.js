// 14-MULTIPLAYER §5 — the HOST session. The host runs the entire authoritative
// simulation; NetHost owns the relay socket, per-client state, input jitter
// buffers, request validation, interest-managed snapshots and chunk streaming.
// One socket to the relay carries every client (sender-slot tagged, §1.2).
import * as THREE from 'three';
import {
  STATE, MS_PER_TICK, SNAPSHOT_INTERVAL, KEYFRAME_INTERVAL, INPUT_QUEUE_TARGET,
  STREAM_RADIUS, ENTITY_INTEREST_RADIUS, INTEREST_ENTITY_CAP,
  CHUNKS_PER_TICK_CLIENT, CHUNKS_PER_TICK_TOTAL, chunkKey, CHUNK_CELLS, SLEEP_PERCENT,
} from '../constants.js';
import {
  MSG, PROTO_VERSION, RELAY_VERSION, ETYPE, EFLAG, OWNFLAG, BTN,
  encodeJson, decodeJson, decodeInput, decodeBlockEdit, encodeBlockSet,
  encodeChunkData, decodePing, encodePong,
  encodeSnapshotHeader, encodeEntityRecord, SNAP_HEADER, SNAP_REC,
} from './protocol.js';
import { sanitizeName, hueFromId } from './identity.js';
import { ChunkState } from '../world/Chunk.js';

const SCRATCH = new Uint8Array(16384);       // reused snapshot buffer (§11 zero-alloc)
const SCRATCH_VIEW = new DataView(SCRATCH.buffer);

let WINDOW_SEQ = 1;

function etypeOf(e) {
  if (e.isRemotePlayer || e.type === 'player') return ETYPE.player;
  return ETYPE[e.type] ?? (e.type?.startsWith?.('thrown') ? ETYPE.thrown : 0);
}

class Client {
  constructor(slot) {
    this.slot = slot;
    this.playerId = null;
    this.name = 'Player';
    this.hue = 0;
    this.player = null;          // host-side Player entity
    this.phase = 'joining';      // joining → streaming → playing
    this.inbox = [];             // decoded messages awaiting drainInbound
    this.inputQueue = [];        // decoded input frames (jitter buffer)
    this.lastFrame = null;
    this.lastButtons = 0;
    this.lastInputSeq = 0;
    this.emptyTicks = 0;
    this.sentChunks = new Set(); // 'cx,cz' streamed
    this.interest = new Set();   // entity ids currently in interest
    this.lastQuant = new Map();  // entityId → quantized signature (delta detection)
    this.keyCounter = 0;
    this.window = null;          // open container {id, kind, x,y,z, be, cursor}
    this.rtt = 0;
    this.bedTicks = 0;
    this.wasSleeping = false;
    this.dim = 0;
    this.chunkCenter = null;     // {cx,cz}
    this.lastEquipHeld = undefined;  // §3.3 equip-on-change latch (undefined ≠ any id → first send)
    this.lastEquipArmor = -1;
  }
}

export class NetHost {
  constructor(game) {
    this.game = game;
    this.isHost = true;
    this.ws = null;
    this.code = null;
    this.clients = new Map();    // slot → Client
    this.blockSetBatch = [];     // {dim,x,y,z,id,state} accumulated this tick
    this.tickCount = 0;
    this.onCode = null;          // (code) → UI badge
    this.onError = null;
    this.lastEquipHeld = undefined;  // §3.3 equip-on-change latch for the host's own player
    this.lastEquipArmor = -1;
    this.stats = { out: 0, in: 0, outBytes: 0, inBytes: 0 };
  }

  get active() { return this.clients.size > 0; }
  hasClients() { return this.clients.size > 0; }

  // ---------------------------------------------------------------- transport
  host(url) {
    let ws;
    try { ws = new WebSocket(url); } catch { this.onError?.('badurl'); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => { try { ws.send(JSON.stringify({ t: 'host', v: RELAY_VERSION })); } catch {} };
    ws.onmessage = ev => {
      if (typeof ev.data === 'string') this._onControl(JSON.parse(ev.data));
      else this._onData(new Uint8Array(ev.data));
    };
    ws.onclose = () => { this._teardownRelayLoss(); this.onError?.('relay-lost'); };
    ws.onerror = () => {};
  }

  // audit M8 — relay dropped: save + despawn every remote player and clear the
  // roster so ghost entities don't linger and hasClients() → false (the host
  // reverts to normal solo play, world intact, §8.1).
  _teardownRelayLoss() {
    for (const c of [...this.clients.values()]) {
      if (c.player) { this.game.saveNetPlayerRecord(c); this.game.removeNetPlayer(c.player); }
    }
    this.clients.clear();
  }

  stop() { this._teardownRelayLoss(); try { this.ws?.close(); } catch {} }

  _onControl(m) {
    if (m.t === 'room') { this.code = m.code; this.onCode?.(m.code); }
    else if (m.t === 'peer+') { this.clients.set(m.slot, new Client(m.slot)); }
    else if (m.t === 'peer-') { this._dropClient(m.slot); }
    else if (m.t === 'err') { this.onError?.(m.reason || 'err'); }
  }

  // client→host binary frame: byte0 = senderSlot, rest = payload
  _onData(tagged) {
    this.stats.in++; this.stats.inBytes += tagged.length;
    if (tagged.length < 2) return;
    const slot = tagged[0];
    const client = this.clients.get(slot);
    if (!client) return;
    const u8 = tagged.subarray(1);
    const id = u8[0];
    // §10 — every binary read length-checks first; a malformed frame disconnects
    // that client rather than throwing out of the socket handler.
    try {
      if (id === MSG.PING) {                     // pong immediately (§3.3, bypasses batching)
        if (u8.length < 9) throw 0;
        const { clientNow } = decodePing(u8);
        this._sendTo(slot, encodePong(clientNow, this.tickCount, performance.now()));
        return;
      }
      if (id === MSG.INPUT) { if (u8.length < 10) throw 0; client.inbox.push({ k: 'input', d: decodeInput(u8) }); return; }
      if (id === MSG.BLOCK_EDIT) { if (u8.length < 15) throw 0; client.inbox.push({ k: 'edit', d: decodeBlockEdit(u8) }); return; }
      if (id === MSG.JSON) {
        const m = decodeJson(u8);
        client.inbox.push({ k: 'json', d: m });
        return;
      }
      // unknown message id from a client — ignore
    } catch {
      // malformed / oversized frame → drop this client (defensive, §10)
      this._jsonTo(slot, { t: 'reject', reason: 'protocol' });
      this._dropClient(slot);
    }
  }

  _sendRaw(u8) { try { this.ws?.send(u8); this.stats.out++; this.stats.outBytes += u8.length; } catch {} }
  _sendTo(slot, payload) {
    const out = new Uint8Array(payload.length + 1);
    out[0] = slot; out.set(payload, 1);
    this._sendRaw(out);
  }
  _broadcast(payload) {
    const out = new Uint8Array(payload.length + 1);
    out[0] = 0xff; out.set(payload, 1);
    this._sendRaw(out);
  }
  _jsonTo(slot, obj) { this._sendTo(slot, encodeJson(obj)); }
  _broadcastJson(obj) { this._broadcast(encodeJson(obj)); }

  // ---------------------------------------------------------------- tick order hooks
  // step 1.5 — drain queued client messages, refresh input queues, queue requests
  drainInbound() {
    for (const client of this.clients.values()) {
      for (const msg of client.inbox) {
        if (msg.k === 'input') { client.inputQueue.push(msg.d); if (client.inputQueue.length > 6) client.inputQueue.splice(0, client.inputQueue.length - 4); }
        else if (msg.k === 'edit') client.requests ? client.requests.push(msg) : (client.requests = [msg]);
        else if (msg.k === 'json') this._handleJson(client, msg.d);
      }
      client.inbox.length = 0;
    }
  }

  _handleJson(client, m) {
    switch (m.t) {
      case 'hello': this._handleHello(client, m); break;
      case 'spawnReady': this._handleSpawnReady(client); break;
      case 'chat': this._handleChat(client, m); break;
      case 'useBlock': case 'attack': case 'dropItem': case 'containerClick':
      case 'containerClose': case 'respawn':
        (client.requests ??= []).push({ k: 'json', d: m }); break;
      default: break;
    }
  }

  // step 2b — tick every remote player with its jitter-buffered input
  tickRemotePlayers() {
    for (const client of this.clients.values()) {
      const p = client.player;
      if (!p || client.phase !== 'playing') continue;
      const frame = this._nextFrame(client);
      p.tick(frame);
      this._tickRemoteUse(client, frame);
    }
  }

  _nextFrame(client) {
    let input;
    if (client.inputQueue.length > 0) {
      // keep the jitter buffer near INPUT_QUEUE_TARGET; drop excess (§5.2)
      while (client.inputQueue.length > INPUT_QUEUE_TARGET + 2) client.inputQueue.shift();
      input = client.inputQueue.shift();
      client.lastInputSeq = input.seq;
      client.emptyTicks = 0;
    } else {
      // empty queue: reuse last frame ≤1 s, then halt (§5.2)
      client.emptyTicks++;
      input = client.lastFrame ? client.lastFrame._raw : { buttons: 0, yaw: client.player.yaw, pitch: client.player.pitch, hotbar: client.player.selectedSlot, seq: client.lastInputSeq };
      if (client.emptyTicks > 20) input = { ...input, buttons: 0 };
    }
    const frame = this._frameFromInput(client, input);
    client.lastFrame = frame;
    return frame;
  }

  // Reconstruct a NEUTRAL_FRAME-shaped struct + edge `pressed` set from the bitfield.
  _frameFromInput(client, input) {
    const b = input.buttons;
    const bit = n => (b & (1 << n)) !== 0;
    const rising = client.lastButtons != null ? (b & ~client.lastButtons) : b;
    const pressed = new Set();
    if (rising & (1 << BTN.FWD)) pressed.add('KeyW');
    if (rising & (1 << BTN.JUMP)) pressed.add('Space');
    // §10 (audit C1) — game mode is HOST-assigned. The FLYING/F4 bit is NEVER
    // mapped to the game-mode toggle: doing so let a modified client self-grant
    // Creative (flight, instant-break, invincibility). Creative for a client would
    // route through a /debug chat command gated on ALLOW_CLIENT_DEBUG, not here.
    client.lastButtons = b;
    const p = client.player;
    p.yaw = input.yaw; p.pitch = input.pitch;
    if (input.hotbar >= 0 && input.hotbar <= 8) p.selectedSlot = input.hotbar;
    const frame = {
      forward: (bit(BTN.FWD) ? 1 : 0) - (bit(BTN.BACK) ? 1 : 0),
      strafe: (bit(BTN.RIGHT) ? 1 : 0) - (bit(BTN.LEFT) ? 1 : 0),
      jump: bit(BTN.JUMP), sneak: bit(BTN.SNEAK), sprintKey: bit(BTN.SPRINT),
      mouseLeft: bit(BTN.ATTACK), mouseRight: bit(BTN.USE),
      leftPressed: false, rightPressed: false, middlePressed: false,
      pressed, wheel: 0, hotbar: -1, shift: bit(BTN.SNEAK), ctrl: bit(BTN.SPRINT),
      _raw: input,
    };
    return frame;
  }

  // §5.2 — remote players tick like the local one. A client's `useBlock {self}`
  // runs Interaction.useSelf host-side, which OPENS a use channel (`usingItem`);
  // nothing else ever advances or closes it, so without this the channel is stuck
  // forever: 03 §7.1 canSprint gates on `!usingItem` (permanent sprint loss) and
  // Interaction's `!p.usingItem` right-click gate swallows every later use request
  // (that client can never eat, drink or draw a bow again).
  _tickRemoteUse(client, frame) {
    const p = client.player;
    if (!p?.usingItem) return;
    if (p.dead) { p.usingItem = null; return; }   // matches Interaction.tick's death path
    const g = this.game;
    g.withActivePlayer(p, () => g.interaction.updateUseChannel(frame));
  }

  // step 2.5 — apply queued block edits / uses / attacks / drops / container clicks
  applyRequests() {
    // §10 (audit M1) — refill per-client action budgets once/second: 10 edits+uses
    // /s (20 in creative), 10 attacks/s. Excess is silently dropped.
    const refill = this.game.tickCount % 20 === 0;
    for (const client of this.clients.values()) {
      if (refill) { client.editBudget = client.player?.creative ? 20 : 10; client.attackBudget = 10; }
      if (!client.requests || client.phase !== 'playing') { if (client.requests) client.requests.length = 0; continue; }
      for (const req of client.requests) {
        if (req.k === 'edit') { if ((client.editBudget = (client.editBudget ?? 10) - 1) >= 0) this._applyBlockEdit(client, req.d); }
        else if (req.k === 'json') this._applyJsonReq(client, req.d);
      }
      client.requests.length = 0;
    }
  }

  _applyJsonReq(client, m) {
    switch (m.t) {
      case 'useBlock': if ((client.editBudget = (client.editBudget ?? 10) - 1) >= 0) this._applyUseBlock(client, m); break;
      case 'attack': if ((client.attackBudget = (client.attackBudget ?? 10) - 1) >= 0) this._applyAttack(client, m); break;
      case 'dropItem': this._applyDrop(client, m); break;
      case 'containerClick': this._applyContainerClick(client, m); break;
      case 'containerClose': this._applyContainerClose(client); break;
      case 'respawn': this._applyRespawn(client); break;
      default: break;
    }
  }

  // step 9.5 — outbound: chunk stream, snapshots, blockSets, events
  outboundTick() {
    this.tickCount = this.game.tickCount;
    this._streamChunks();
    // flush per-tick blockSet batch to interested clients
    if (this.blockSetBatch.length) { this._flushBlockSets(); this.blockSetBatch.length = 0; }
    // snapshots every 2nd tick (10 Hz)
    if (this.tickCount % SNAPSHOT_INTERVAL === 0) {
      for (const client of this.clients.values()) {
        if (client.phase === 'playing') this._sendSnapshot(client);
      }
    }
    // playerState deltas (≤4/s cap ≈ every 5 ticks) + equip on change
    if (this.tickCount % 5 === 0) {
      for (const client of this.clients.values()) {
        if (client.phase !== 'playing') continue;
        this._sendPlayerState(client);
        this._checkEquip(client.player, client);
      }
      // the host's own held item/armor too — nobody is watching with no peers, and
      // a joiner gets the current held item from entitySpawn.static (netStaticFor)
      if (this.clients.size) this._checkEquip(this.game.player, this);
    }
    // 1 Hz player list
    if (this.tickCount % 20 === 0) this._sendPlayerList();
    // 100-tick time sync
    if (this.tickCount % 100 === 0) this._sendTimeSync();
  }

  // Called from World.setBlock (host mode) for every mutation (§3.4).
  recordBlockSet(dim, x, y, z, id, state) {
    this.blockSetBatch.push({ dim, x, y, z, id, state });
  }

  _flushBlockSets() {
    const byDim = new Map();
    for (const r of this.blockSetBatch) {
      let a = byDim.get(r.dim); if (!a) { a = []; byDim.set(r.dim, a); }
      a.push(r);
    }
    for (const client of this.clients.values()) {
      if (client.phase !== 'playing') continue;
      const recs = byDim.get(client.dim);
      if (!recs) continue;
      const filtered = recs.filter(r => client.sentChunks.has(chunkKey(r.x >> 4, r.z >> 4)));
      if (filtered.length) this._sendTo(client.slot, encodeBlockSet(client.dim, filtered));
    }
  }

  // ---------------------------------------------------------------- handshake
  _handleHello(client, m) {
    if (m.v !== PROTO_VERSION) { this._jsonTo(client.slot, { t: 'reject', reason: 'version', hostV: PROTO_VERSION }); this._dropClient(client.slot); return; }
    // dupe playerId already online
    for (const c of this.clients.values()) if (c !== client && c.playerId === m.playerId) { this._jsonTo(client.slot, { t: 'reject', reason: 'dupe' }); this._dropClient(client.slot); return; }
    client.playerId = String(m.playerId || '').slice(0, 64) || ('slot' + client.slot);
    client.name = sanitizeName(m.name);
    client.hue = hueFromId(client.playerId);
    // build the host-side player entity (restore saved record if returning)
    const rec = this.game.takeSavedPlayerRecord(client.playerId);
    const spawn = this.game.createNetPlayer(client, rec);
    client.dim = client.player.dim ?? 0;
    client.phase = 'streaming';
    const w = this.game.world;
    this._jsonTo(client.slot, {
      t: 'welcome', slot: client.slot, seed: w.seedString, worldTime: w.time,
      weather: this.game.dayNight?.serialize() ?? null, dim: client.dim, hostTick: this.game.tickCount,
      you: this.game.serializeNetPlayer(client.player, client),
      spawnPos: spawn,
      players: this._playerRoster(),
      rules: { sleepPercent: SLEEP_PERCENT, hostileCap: this.game.currentHostileCap?.() ?? 40 },
    });
    // begin streaming chunks around the spawn immediately (JOIN_RADIUS burst)
    client.chunkCenter = { cx: Math.floor(spawn.x) >> 4, cz: Math.floor(spawn.z) >> 4 };
  }

  _handleSpawnReady(client) {
    if (!client.player) return;
    const p = client.player;
    const firstJoin = !client.joinedOnce;      // audit M5 — re-stream after dimChange is NOT a join
    client.phase = 'playing';
    this._jsonTo(client.slot, { t: 'spawnConfirm', entityId: p.id, pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z }, yaw: p.yaw, pitch: p.pitch });
    this._sendPlayerState(client, true);
    if (firstJoin) {
      client.joinedOnce = true;
      // broadcast the join to everyone ONCE (a dimension re-stream must not re-announce)
      this._broadcastJson({ t: 'playerJoin', playerId: client.playerId, name: client.name, slot: client.slot, hue: client.hue, entityId: p.id, static: { playerId: client.playerId, name: client.name, hue: client.hue } });
      this.game.ui?.chat?.addSystem(`${client.name} joined`);
      this._broadcastJson({ t: 'chat', from: null, text: `${client.name} joined` });
    }
  }

  _dropClient(slot) {
    const client = this.clients.get(slot);
    if (!client) return;
    if (client.player) {
      this.game.saveNetPlayerRecord(client);       // snapshot record before removal (§9.2)
      this._applyContainerClose(client);
      this.game.removeNetPlayer(client.player);
      this._broadcastJson({ t: 'playerLeave', playerId: client.playerId, reason: 'left' });
      this._broadcastJson({ t: 'chat', from: null, text: `${client.name} left` });
      this.game.ui?.chat?.addSystem(`${client.name} left`);
    }
    this.clients.delete(slot);
  }

  _playerRoster() {
    const out = [];
    // host's own player
    out.push({ playerId: this.game.localPlayerId, name: this.game.localPlayerName, slot: 0, hue: hueFromId(this.game.localPlayerId) });
    for (const c of this.clients.values()) if (c.player) out.push({ playerId: c.playerId, name: c.name, slot: c.slot, hue: c.hue, entityId: c.player.id });
    return out;
  }

  // ---------------------------------------------------------------- requests
  _applyBlockEdit(client, d) {
    const p = client.player;
    if (!p || p.dead) return;
    const g = this.game, w = g.world;
    if (client.dim !== w.activeDim) return;              // cross-dim edit ignored
    const dist = Math.hypot((d.x + 0.5) - p.pos.x, (d.y + 0.5) - (p.pos.y + p.eyeHeight), (d.z + 0.5) - p.pos.z);
    const reach = (p.creative ? 5.2 : 4.5) + 0.5;
    if (dist > reach) { this._revertCell(client, d.x, d.y, d.z); return; }
    const ok = g.hostApplyBlockEdit(client, d);
    if (!ok) this._revertCell(client, d.x, d.y, d.z);    // targeted revert (§5.6)
  }

  _revertCell(client, x, y, z) {
    const w = this.game.world;
    const id = w.getBlock(x, y, z), state = w.getState(x, y, z);
    this._sendTo(client.slot, encodeBlockSet(client.dim, [{ x, y, z, id, state }]));
  }

  _applyUseBlock(client, m) {
    const p = client.player;
    if (!p || p.dead) return;
    this.game.hostApplyUseBlock(client, m);
  }
  _applyAttack(client, m) {
    const p = client.player;
    if (!p || p.dead) return;
    this.game.hostApplyAttack(client, m);
  }
  _applyDrop(client, m) {
    const p = client.player;
    if (!p || p.dead) return;
    this.game.hostApplyDrop(client, m);
  }
  _applyRespawn(client) {
    this.game.hostRespawnPlayer(client);
  }

  // ---------------------------------------------------------------- containers (chest-class)
  _applyContainerClick(client, m) { this.game.hostContainerClick?.(client, m); }
  _applyContainerClose(client) {
    if (client.window) { this.game.hostContainerClose?.(client); client.window = null; }
  }

  _handleChat(client, m) {
    const now = performance.now();
    client._chatTimes = (client._chatTimes || []).filter(t => now - t < 1000);
    if (client._chatTimes.length >= 3) return;           // 3/s cap (§10)
    client._chatTimes.push(now);
    const text = String(m.text ?? '').slice(0, 200);
    if (!text) return;
    this._broadcastJson({ t: 'chat', from: client.name, text });
    this.game.ui?.chat?.addLine(client.name, text);
  }

  // ---------------------------------------------------------------- chunk streaming (§2.3)
  _streamChunks() {
    const g = this.game, w = g.world;
    let totalBudget = CHUNKS_PER_TICK_TOTAL;
    for (const client of this.clients.values()) {
      if (!client.player || (client.phase !== 'streaming' && client.phase !== 'playing')) continue;
      if (client.dim !== w.activeDim) continue;          // only current resident dim (§9 gotcha)
      const pcx = Math.floor(client.player.pos.x) >> 4, pcz = Math.floor(client.player.pos.z) >> 4;
      client.chunkCenter = { cx: pcx, cz: pcz };
      let budget = Math.min(CHUNKS_PER_TICK_CLIENT, totalBudget);
      // evict far chunks from sentChunks so re-approach re-sends fresh (coherence, §2.3)
      for (const key of client.sentChunks) {
        const [cx, cz] = key.split(',').map(Number);
        if (Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz)) > STREAM_RADIUS + 3) client.sentChunks.delete(key);
      }
      // spiral nearest-first within STREAM_RADIUS
      const wanted = this._spiral(pcx, pcz, STREAM_RADIUS);
      for (const [cx, cz] of wanted) {
        if (budget <= 0) break;
        const key = chunkKey(cx, cz);
        if (client.sentChunks.has(key)) continue;
        const chunk = w.chunks.get(key);
        if (!chunk || chunk.state < ChunkState.GENERATED || !chunk.blocks) {
          g.chunkManager.ensureLoadedAround?.(pcx, pcz, STREAM_RADIUS);   // host loads it (union keep-alive)
          continue;
        }
        this._sendTo(client.slot, encodeChunkData(client.dim, cx, cz, chunk.blocks, chunk.states, chunk.biomes));
        client.sentChunks.add(key);
        budget--; totalBudget--;
      }
      if (totalBudget <= 0) break;
    }
  }

  _spiral(pcx, pcz, r) {
    const out = [];
    for (let dcx = -r; dcx <= r; dcx++) for (let dcz = -r; dcz <= r; dcz++) out.push([pcx + dcx, pcz + dcz, Math.max(Math.abs(dcx), Math.abs(dcz)) * 1000 + dcx * dcx + dcz * dcz]);
    out.sort((a, b) => a[2] - b[2]);
    return out;
  }

  // ---------------------------------------------------------------- snapshots (§5.3)
  _buildInterest(client) {
    const g = this.game, w = g.world;
    const pcx = client.chunkCenter?.cx ?? 0, pcz = client.chunkCenter?.cz ?? 0;
    const own = client.player;
    const cands = [];
    for (const e of g.entities.entities.values()) {
      if (e === own || e.dead) continue;
      if ((e.dim ?? 0) !== client.dim) continue;
      const ecx = Math.floor(e.pos.x) >> 4, ecz = Math.floor(e.pos.z) >> 4;
      const cheb = Math.max(Math.abs(ecx - pcx), Math.abs(ecz - pcz));
      if (cheb > ENTITY_INTEREST_RADIUS) continue;
      const type = etypeOf(e);
      if (!type) continue;
      const d2 = (e.pos.x - own.pos.x) ** 2 + (e.pos.z - own.pos.z) ** 2;
      cands.push({ e, type, d2, isPlayer: type === ETYPE.player });
    }
    // players first, then nearest, cap 64
    cands.sort((a, b) => (b.isPlayer - a.isPlayer) || (a.d2 - b.d2));
    return cands.slice(0, INTEREST_ENTITY_CAP);
  }

  _entityRecord(e, type) {
    let flags = 0;
    if (e.onGround) flags |= EFLAG.ON_GROUND;
    if (e.sprinting) flags |= EFLAG.SPRINTING;
    if (e.sneaking) flags |= EFLAG.SNEAKING;
    if (e.fireTicks > 0) flags |= EFLAG.BURNING;
    if ((e.swingTime > 0) || (e.swingAmount > 0.4)) flags |= EFLAG.SWINGING;
    if (e.gliding) flags |= EFLAG.GLIDING;
    if (e.hurtTime > 0) flags |= EFLAG.HURT;
    if (e.dead) flags |= EFLAG.DEAD;
    let stateByte = 0;
    if (e.type === 'creeper') stateByte = Math.max(0, Math.min(30, e.swell ?? e.fuse ?? 0));
    else if (e.type === 'sheep') stateByte = (e.sheared ? 1 : 0) | ((e.woolColor ?? 0) << 1);
    else if (e.isBaby) stateByte = 1;
    else if (e.type === 'item') stateByte = Math.min(4, Math.max(1, e.stack?.count ? 1 : 1));
    else if (e.type === 'player') stateByte = (e.sleeping ? 1 : 0);
    return {
      id: e.id, type, x: e.pos.x, y: e.pos.y, z: e.pos.z,
      vx: e.vel.x, vy: e.vel.y, vz: e.vel.z, yaw: e.yaw, pitch: e.pitch ?? 0,
      flags, stateByte, health: e.health ?? 0,
    };
  }

  _quant(r) {
    // coarse signature to detect "changed since last sent" (post-quantization)
    return (Math.round(r.x * 2048) & 0xffff) + ',' + (Math.round(r.y * 256) & 0xffff) + ',' +
      (Math.round(r.z * 2048) & 0xffff) + ',' + (r.flags) + ',' + r.stateByte + ',' +
      Math.ceil(r.health) + ',' + (Math.round(r.yaw / (Math.PI * 2) * 256) & 0xff);
  }

  _sendSnapshot(client) {
    const g = this.game;
    const own = client.player;
    client.keyCounter = (client.keyCounter + 1) % KEYFRAME_INTERVAL;
    // stagger keyframes per client so they never coincide (§11)
    const keyframe = (client.keyCounter === (client.slot % KEYFRAME_INTERVAL));
    const interest = this._buildInterest(client);
    const acx = client.chunkCenter?.cx ?? 0, acz = client.chunkCenter?.cz ?? 0;

    // interest transitions → entitySpawn (enter) / entityDespawn (exit)
    const nowIds = new Set();
    for (const c of interest) {
      nowIds.add(c.e.id);
      if (!client.interest.has(c.e.id)) {
        this._sendEntitySpawn(client, c.e, c.type);
        // audit M3 — force the first record after (re)entry: a stale lastQuant
        // signature would otherwise skip it and leave the puppet un-created.
        client.lastQuant.delete(c.e.id);
      }
    }
    for (const id of client.interest) if (!nowIds.has(id)) this._jsonTo(client.slot, { t: 'entityDespawn', id, reason: 'range' });
    client.interest = nowIds;

    // assemble records (delta unless keyframe)
    const recs = [];
    for (const c of interest) {
      const r = this._entityRecord(c.e, c.type);
      const q = this._quant(r);
      if (!keyframe && client.lastQuant.get(c.e.id) === q) continue;
      client.lastQuant.set(c.e.id, q);
      recs.push(r);
      if (recs.length >= 64) break;
    }
    if (keyframe) { client.lastQuant.clear(); for (const c of interest) client.lastQuant.set(c.e.id, this._quant(this._entityRecord(c.e, c.type))); }

    const v = SCRATCH_VIEW;
    let ownFlags = 0;
    if (own.onGround) ownFlags |= OWNFLAG.ON_GROUND;
    if (own.inWater) ownFlags |= OWNFLAG.IN_WATER;
    if (own.inLava) ownFlags |= OWNFLAG.IN_LAVA;
    if (own.onLadder) ownFlags |= OWNFLAG.ON_LADDER;
    if (own.sprinting) ownFlags |= OWNFLAG.SPRINTING;
    if (own.fireTicks > 0) ownFlags |= OWNFLAG.BURNING;
    if (own.sleeping) ownFlags |= OWNFLAG.SLEEPING;
    if (own.flying) ownFlags |= OWNFLAG.FLYING;
    encodeSnapshotHeader(v, 0, {
      hostTick: this.game.tickCount, keyframe, lastInputSeq: client.lastInputSeq,
      ownPos: own.pos, ownVel: own.vel, ownFlags, acx, acz, count: recs.length,
    });
    for (let i = 0; i < recs.length; i++) encodeEntityRecord(v, SNAP_HEADER + i * SNAP_REC, recs[i], acx, acz);
    const len = SNAP_HEADER + recs.length * SNAP_REC;
    this._sendTo(client.slot, SCRATCH.subarray(0, len));
  }

  _sendEntitySpawn(client, e, type) {
    const stat = this.game.netStaticFor(e);
    this._jsonTo(client.slot, { t: 'entitySpawn', id: e.id, type, static: stat });
    if (type === ETYPE.player && e.isRemotePlayer) { /* host doesn't render puppets */ }
  }

  // ---------------------------------------------------------------- playerState / events
  _sendPlayerState(client, full = false) {
    const p = client.player;
    if (!p) return;
    const msg = this.game.serializeNetPlayer(p, client, full);
    msg.t = 'playerState';
    this._jsonTo(client.slot, msg);
  }

  broadcastHurt(entityId, srcDir, byPlayerId) {
    this._broadcastJson({ t: 'hurt', entityId, srcDir, byPlayerId });
  }
  broadcastEquip(entityId, heldItemId, armorTier) {
    this._broadcastJson({ t: 'equip', entityId, heldItemId, armorTier });
  }

  // §3.3 "equip on change" — the snapshot record carries no equipment, so a player's
  // held item and armor reach the other clients' puppets ONLY through this broadcast.
  // `store` holds the last-sent pair (the Client for a remote player, `this` for the
  // host's own player) so the message goes out on change, not every 5 ticks.
  _checkEquip(p, store) {
    if (!p) return;
    const heldItemId = p.heldStack?.id ?? null;
    let armorTier = 0;
    for (const a of p.armor) if (a) armorTier++;
    if (store.lastEquipHeld === heldItemId && store.lastEquipArmor === armorTier) return;
    store.lastEquipHeld = heldItemId; store.lastEquipArmor = armorTier;
    this.broadcastEquip(p.id, heldItemId, armorTier);
  }
  broadcastSound(name, x, y, z, pitch, vol) {
    // only clients within 32 m (§3.3) — cheap dim/interest gate
    for (const c of this.clients.values()) {
      if (c.phase !== 'playing' || !c.player) continue;
      if (x !== undefined && Math.hypot(c.player.pos.x - x, c.player.pos.y - y, c.player.pos.z - z) > 32) continue;
      this._jsonTo(c.slot, { t: 'sound', name, x, y, z, pitch, vol });
    }
  }
  broadcastEntityDespawn(id, reason) { this._broadcastJson({ t: 'entityDespawn', id, reason }); for (const c of this.clients.values()) c.interest.delete(id); }

  _sendPlayerList() {
    const list = this._playerRoster().map(r => ({ ...r, rttMs: r.slot === 0 ? 0 : Math.round(this.clients.get(r.slot)?.rtt ?? 0), dim: r.slot === 0 ? this.game.world.activeDim : this.clients.get(r.slot)?.dim ?? 0 }));
    this._broadcastJson({ t: 'playerList', list });
    this.game.ui?.playerList?.refresh?.();
  }

  _sendTimeSync() {
    const w = this.game.world, wx = this.game.dayNight?.serialize() ?? {};
    this._broadcastJson({ t: 'timeSync', worldTime: w.time, raining: wx.raining, thundering: wx.thundering, rainLevel: wx.rainLevel, thunderLevel: wx.thunderLevel });
  }

  broadcastTimeSync() { this._sendTimeSync(); }   // immediate on weather/sleep change
  broadcastSleepStatus(sleeping, total) { this._broadcastJson({ t: 'sleepStatus', sleeping, total }); }
  broadcastBossBar(m) { this._broadcastJson({ t: 'bossBar', ...m }); }

  // dim change for a specific client (owner-only; §3.3)
  sendDimChange(client, dim, spawnPos) {
    client.dim = dim;
    client.sentChunks.clear();
    client.interest.clear();
    client.lastQuant.clear();
    if (client.window) { this.game.hostContainerClose?.(client); client.window = null; }   // audit M7 — dim change closes any open window
    this._jsonTo(client.slot, { t: 'dimChange', dim, spawnPos });
  }
  sendForceMove(client, pos, yaw, pitch, dim) {
    this._jsonTo(client.slot, { t: 'forceMove', pos, yaw, pitch, dim });
  }

  clientForPlayer(player) {
    for (const c of this.clients.values()) if (c.player === player) return c;
    return null;
  }

  connectedPlayerCount() { return 1 + this.clients.size; }

  hostShutdown() {
    this._broadcastJson({ t: 'hostShutdown', seconds: 3 });
  }
}
