// 14-MULTIPLAYER §2/§4 — the CLIENT session. Connects to the relay, runs the join
// handshake, streams the world (no terrain workers), predicts its own player, and
// renders everything else from host snapshots. Clients never own world data.
import { STATE, CHUNK_CELLS, MS_PER_TICK, JOIN_RADIUS } from '../constants.js';
import {
  MSG, PROTO_VERSION, RELAY_VERSION, BTN,
  encodeJson, decodeJson, encodeInput, decodeSnapshot, encodeBlockEdit,
  decodeBlockSet, decodeChunkData, encodePing, decodePong,
} from './protocol.js';
import { getLocalPlayerId, getLocalPlayerName, hueFromId } from './identity.js';
import { Predictor } from './prediction.js';
import { Interpolator } from './interpolation.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import { ETYPE_REV } from './protocol.js';

const REQUIRED_CHUNKS = (JOIN_RADIUS * 2 + 1) ** 2;   // 121

export class NetClient {
  constructor(game, { url, code, name }) {
    this.game = game;
    this.isClient = true;
    this.url = url;
    this.code = (code || '').toUpperCase();
    this.playerId = getLocalPlayerId();
    this.name = name || getLocalPlayerName() || 'Player';
    this.slot = -1;
    this.phase = 'connecting';         // connecting → welcomed → streaming → ready → playing
    this.ws = null;
    this.chunksReceived = 0;
    this.spawnReadySent = false;
    this.predictor = null;
    this.interp = new Interpolator();
    this.puppets = new Map();          // netId → entity puppet
    this.staticData = new Map();       // netId → entitySpawn.static (for lazy puppet creation)
    this.players = new Map();          // playerId → {name, slot, hue, entityId, rttMs, dim}
    this.rtt = 0;
    this.lastPingAt = 0;
    this.onError = null;               // (reason) set by netMenus
    this.stats = { in: 0, out: 0, inBytes: 0, outBytes: 0, snapSize: 0, corrections: 0 };
    this._statWindow = 0;
  }

  // ---------------------------------------------------------------- transport
  connect() {
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this._fail('badurl'); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => this._sendControl({ t: 'join', code: this.code, v: RELAY_VERSION });
    ws.onmessage = ev => {
      if (typeof ev.data === 'string') this._onControl(JSON.parse(ev.data));
      else this._onData(new Uint8Array(ev.data));
    };
    ws.onclose = () => { if (this.phase !== 'closed') this._fail('lost'); };
    ws.onerror = () => {};
  }

  _sendControl(obj) { try { this.ws.send(JSON.stringify(obj)); } catch {} }
  _send(u8) { try { this.ws.send(u8); this.stats.out++; this.stats.outBytes += u8.length; } catch {} }
  sendJson(obj) { this._send(encodeJson(obj)); }

  _fail(reason) {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    try { this.ws?.close(); } catch {}
    this.onError?.(reason);
  }

  disconnect() {
    this.phase = 'closed';
    try { this.ws?.close(); } catch {}
  }

  // ---------------------------------------------------------------- relay control frames
  _onControl(m) {
    if (m.t === 'joined') { this.slot = m.slot; this._sendHello(); }
    else if (m.t === 'hostGone') this._fail('hostGone');
    else if (m.t === 'err') this._fail(m.reason || 'err');
  }

  _sendHello() {
    this.sendJson({ t: 'hello', v: PROTO_VERSION, playerId: this.playerId, name: this.name });
  }

  // ---------------------------------------------------------------- data frames
  _onData(u8) {
    this.stats.in++; this.stats.inBytes += u8.length;
    const id = u8[0];
    try {
      switch (id) {
        case MSG.JSON: this._onJson(decodeJson(u8)); break;
        case MSG.SNAPSHOT: this._onSnapshot(u8); break;
        case MSG.BLOCK_SET: this._onBlockSet(decodeBlockSet(u8)); break;
        case MSG.CHUNK_DATA: this._onChunkData(decodeChunkData(u8, CHUNK_CELLS)); break;
        case MSG.PONG: this._onPong(decodePong(u8)); break;
        default: break;
      }
    } catch (e) { console.warn('[net] client decode error', id, e); }
  }

  _onJson(m) {
    const g = this.game;
    switch (m.t) {
      case 'welcome': this._onWelcome(m); break;
      case 'reject': this._fail(m.reason || 'reject'); break;
      case 'spawnConfirm': this._onSpawnConfirm(m); break;
      case 'playerState': this._onPlayerState(m); break;
      case 'entitySpawn': this._onEntitySpawn(m); break;
      case 'entityDespawn': this._onEntityDespawn(m); break;
      case 'playerJoin': this._onPlayerJoin(m); break;
      case 'playerLeave': this._onPlayerLeave(m); break;
      case 'playerList': this._onPlayerList(m); break;
      case 'equip': this._onEquip(m); break;
      case 'hurt': this._onHurt(m); break;
      case 'sound': g.net?.playRemoteSound?.(m); this._playSound(m); break;
      case 'chat': g.ui?.chat?.addLine(m.from, m.text); break;
      case 'timeSync': this._onTimeSync(m); break;
      case 'sleepStatus': g.ui?.chat?.setSleepStatus?.(m.sleeping, m.total); break;
      case 'bossBar': this._onBossBar(m); break;
      case 'dimChange': this._onDimChange(m); break;
      case 'forceMove': this._onForceMove(m); break;
      case 'hostShutdown': this._onHostShutdown(m); break;
      case 'containerOpen': g.ui?.netContainer?.open(m); break;
      case 'containerResult': g.ui?.netContainer?.applyResult(m); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- handshake → world
  _onWelcome(m) {
    this.phase = 'welcomed';
    this.welcome = m;
    for (const p of m.players || []) this.players.set(p.playerId, { ...p });
    this.game.startClientWorld(m, this);
    this.predictor = new Predictor(this.game.player, (pl, fr) => this.game.tickClientPlayer(pl, fr));
    this.phase = 'streaming';
  }

  _onChunkData(d) {
    const cm = this.game.chunkManager;
    if (!cm) return;
    cm.installNetChunk(d.cx, d.cz, d.blocks, d.states, d.biomes, d.dim);
    this.chunksReceived++;
    if (this.phase === 'streaming') {
      this.game.ui?.netMenus?.setProgress?.(Math.min(this.chunksReceived, REQUIRED_CHUNKS), REQUIRED_CHUNKS);
    }
  }

  _onSpawnConfirm(m) {
    const p = this.game.player;
    if (m.pos) { p.setPos(m.pos.x, m.pos.y, m.pos.z); p.prevPos.x = m.pos.x; p.prevPos.y = m.pos.y; p.prevPos.z = m.pos.z; }
    if (m.yaw !== undefined) p.yaw = p.prevYaw = m.yaw;
    if (m.pitch !== undefined) p.pitch = m.pitch;
    this.netEntityId = m.entityId;
    this.predictor.reset();
    this.phase = 'playing';
    this.game.setState(STATE.PLAYING);
    this.game.input.requestLock();
  }

  // ---------------------------------------------------------------- per-tick (client)
  clientTick(frame) {
    const g = this.game;
    if (this.phase === 'streaming' || this.phase === 'ready') {
      // drive meshing during CONNECTING; announce ready when the spawn ring is meshed
      g.chunkManager.tick(g.player.pos.x, g.player.pos.z);
      g.chunkManager.drainRemesh(g.player.pos.x, g.player.pos.z, 40, 12);
      const pcx = Math.floor(g.player.pos.x) >> 4, pcz = Math.floor(g.player.pos.z) >> 4;
      const { meshed, needed } = g.chunkManager.loadingProgress(pcx, pcz);
      if (!this.spawnReadySent && meshed >= needed && this.chunksReceived >= REQUIRED_CHUNKS - 4) {
        this.spawnReadySent = true;
        this.phase = 'ready';
        this.sendJson({ t: 'spawnReady' });
      }
      return;
    }
    if (this.phase !== 'playing') return;

    // predict own movement (03 §4) and send the input frame (§4.1/§4.2)
    const seq = this.predictor.predict(frame);
    this._sendInput(seq, frame);
    // local prediction of block edits / interactions (§4.5) runs in interaction.tick,
    // driven by Game.tick; net send hooks fire from there.
    g.chunkManager.tick(g.player.pos.x, g.player.pos.z);

    // 1 Hz ping
    const now = performance.now();
    if (now - this.lastPingAt >= 1000) { this.lastPingAt = now; this._send(encodePing(now)); }
    // 1 s F3 stat window
    if (++this._statWindow >= 20) { this._statWindow = 0; this.stats.snapSize = this._lastSnapSize || 0; }
  }

  _sendInput(seq, frame) {
    let buttons = 0;
    if (frame.forward > 0) buttons |= 1 << BTN.FWD;
    if (frame.forward < 0) buttons |= 1 << BTN.BACK;
    if (frame.strafe < 0) buttons |= 1 << BTN.LEFT;
    if (frame.strafe > 0) buttons |= 1 << BTN.RIGHT;
    if (frame.jump) buttons |= 1 << BTN.JUMP;
    if (frame.sneak) buttons |= 1 << BTN.SNEAK;
    if (frame.sprintKey) buttons |= 1 << BTN.SPRINT;
    if (frame.mouseRight) buttons |= 1 << BTN.USE;
    if (frame.mouseLeft) buttons |= 1 << BTN.ATTACK;
    const p = this.game.player;
    this._send(encodeInput(seq, buttons, p.yaw, p.pitch, p.selectedSlot));
  }

  // ---------------------------------------------------------------- outbound actions
  sendBlockEdit(action, x, y, z, face, hotbarSlot) {
    this._editSeq = ((this._editSeq || 0) + 1) & 0xffff;
    this._send(encodeBlockEdit(action, this._editSeq, x, y, z, face, hotbarSlot));
  }
  sendUseBlock(x, y, z, face, hotbarSlot) { this.sendJson({ t: 'useBlock', x, y, z, face, hotbarSlot }); }
  sendAttack(targetEntityId) { this.sendJson({ t: 'attack', target: targetEntityId, yaw: this.game.player.yaw, pitch: this.game.player.pitch }); }
  sendDropItem(stack) { this.sendJson({ t: 'dropItem', stack: !!stack }); }
  sendChat(text) { this.sendJson({ t: 'chat', text }); }
  sendRespawn() { this.sendJson({ t: 'respawn' }); }
  sendContainerOpen(x, y, z) { this.sendJson({ t: 'useBlock', x, y, z, face: 1, hotbarSlot: this.game.player.selectedSlot }); }
  sendContainerClick(payload) { this.sendJson({ t: 'containerClick', ...payload }); }
  sendContainerClose(windowId) { this.sendJson({ t: 'containerClose', windowId }); }

  // ---------------------------------------------------------------- snapshot intake
  _onSnapshot(u8) {
    this._lastSnapSize = u8.length;
    const { header, entities } = decodeSnapshot(u8);
    // own-player reconciliation
    this.predictor.reconcile(header);
    this.stats.corrections = this.predictor.corrections;
    // remote entities → interpolation buffers
    const time = header.hostTick * MS_PER_TICK;
    const seen = header.keyframe ? new Set() : null;
    for (const e of entities) {
      if (seen) seen.add(e.id);
      this.interp.addSample(e.id, time, {
        x: e.x, y: e.y, z: e.z, vx: e.vx, vy: e.vy, vz: e.vz,
        yaw: e.yaw, pitch: e.pitch, flags: e.flags, stateByte: e.stateByte, health: e.health,
      });
      this._ensurePuppet(e);
    }
    // keyframe GC: drop puppets absent from the full interest set (§3.4 safety net)
    if (seen) {
      for (const [id, pup] of this.puppets) {
        if (!seen.has(id)) this._removePuppet(id);
      }
    }
  }

  _ensurePuppet(e) {
    if (this.puppets.has(e.id)) return;
    const typeName = ETYPE_REV[e.type];
    if (!typeName) return;
    const pup = this.game.createPuppet(typeName, e, this.staticData.get(e.id));
    if (pup) { pup.netId = e.id; this.puppets.set(e.id, pup); this.game.entities.add(pup); }
  }

  _removePuppet(id) {
    const pup = this.puppets.get(id);
    if (pup) { this.game.entities.remove(pup); this.puppets.delete(id); }
    this.interp.remove(id);
    this.staticData.delete(id);
  }

  // per-frame: advance interpolation, drive puppets (called from Game.render)
  renderTick(frameDeltaMs) {
    this.interp.advance(frameDeltaMs);
    for (const [id, pup] of this.puppets) {
      const s = this.interp.sample(id);
      if (!s) continue;
      pup.prevPos.x = pup.pos.x; pup.prevPos.y = pup.pos.y; pup.prevPos.z = pup.pos.z;
      pup.prevYaw = pup.yaw;
      pup.pos.x = s.x; pup.pos.y = s.y; pup.pos.z = s.z;
      pup.yaw = s.yaw; pup.pitch = s.pitch;
      if (pup.applyFlags) pup.applyFlags(s.flags, s.stateByte);
      pup.health = s.health;
      pup.stateByte = s.stateByte;
    }
    if (this.predictor) this.predictor.decayOffset();
  }

  // ---------------------------------------------------------------- world state msgs
  _onBlockSet({ dim, records }) {
    const g = this.game;
    if (dim !== g.world.activeDim) return;
    for (const r of records) g.world.setBlock(r.x, r.y, r.z, r.id, { state: r.state, noUpdates: true, remote: true });
  }

  _onPlayerState(m) {
    const p = this.game.player;
    if (m.health !== undefined) p.health = m.health;
    if (m.hunger !== undefined) p.foodLevel = m.hunger;
    if (m.saturation !== undefined) p.saturation = m.saturation;
    if (m.air !== undefined) p.air = m.air;
    if (m.fireTicks !== undefined) p.fireTicks = m.fireTicks;
    if (m.xp !== undefined) { p.xpLevel = m.xpLevel ?? p.xpLevel; p.xpPoints = m.xpPoints ?? p.xpPoints; }
    if (m.gameMode !== undefined) p.gameMode = m.gameMode;
    if (m.inventory) m.inventory.forEach((s, i) => { p.inventory[i] = s || null; });
    if (m.armor) m.armor.forEach((s, i) => { p.armor[i] = s || null; });
    if (m.offhand !== undefined) p.offhand = m.offhand || null;
    if (m.selectedSlot !== undefined) p.selectedSlot = m.selectedSlot;
    if (m.effects) { const { applyEffectsData } = this.game._effectsApi || {}; applyEffectsData?.(p, m.effects); }
    if (m.dead && this.game.state !== STATE.DEAD) { document.exitPointerLock?.(); this.game.setState(STATE.DEAD); }
    if (!m.dead && this.game.state === STATE.DEAD) { /* handled by respawn/forceMove */ }
  }

  _onEntitySpawn(m) { this.staticData.set(m.id, m.static || {}); }
  _onEntityDespawn(m) { this._removePuppet(m.id); }

  _onPlayerJoin(m) {
    this.players.set(m.playerId, { name: m.name, slot: m.slot, hue: m.hue, entityId: m.entityId, dim: this.game.world.activeDim });
    if (m.static) this.staticData.set(m.entityId, m.static);
    this.game.ui?.chat?.addSystem(`${m.name} joined`);
    this.game.ui?.playerList?.refresh?.();
  }
  _onPlayerLeave(m) {
    const info = this.players.get(m.playerId);
    this.players.delete(m.playerId);
    if (info?.entityId) this._removePuppet(info.entityId);
    if (info) this.game.ui?.chat?.addSystem(`${info.name} left`);
    this.game.ui?.playerList?.refresh?.();
  }
  _onPlayerList(m) {
    for (const row of m.list || []) {
      const info = this.players.get(row.playerId) || {};
      this.players.set(row.playerId, { ...info, ...row });
    }
    this.game.ui?.playerList?.refresh?.();
  }

  _onEquip(m) {
    const pup = this.puppets.get(m.entityId);
    if (pup && pup.isRemotePlayer) { pup.heldItemId = m.heldItemId; pup.armorTier = m.armorTier || 0; pup.needsMeshRebuild = true; }
  }
  _onHurt(m) {
    const pup = this.puppets.get(m.entityId);
    if (pup) pup.hurtTime = 10;
  }
  _onTimeSync(m) {
    const w = this.game.world;
    if (m.worldTime !== undefined) w.time = m.worldTime;
    this.game.dayNight?.applyNetWeather?.(m);
  }
  _onBossBar(m) {
    const bb = this.game.ui?.bossBar;
    if (!bb) return;
    if (m.remove) bb.remove(m.id);
    else { bb.add(m.id, { name: m.name, color: m.style }); bb.set(m.id, m.hpFrac); }
  }
  _onDimChange(m) {
    this.game.clientDimChange(m);
    this.chunksReceived = 0;
    this.spawnReadySent = false;
    this.phase = 'streaming';
  }
  _onForceMove(m) {
    const p = this.game.player;
    this.predictor.hardSnap(m.pos, { x: 0, y: 0, z: 0 });
    if (m.yaw !== undefined) p.yaw = p.prevYaw = m.yaw;
    if (m.pitch !== undefined) p.pitch = m.pitch;
    this.predictor.reset();
    if (this.game.state === STATE.DEAD) { this.game.setState(STATE.PLAYING); this.game.input.requestLock(); }
  }
  _onHostShutdown(m) {
    this.game.ui?.netMenus?.showCountdown?.(m.seconds ?? 3);
    setTimeout(() => this._fail('hostEnded'), (m.seconds ?? 3) * 1000 + 200);
  }

  _onPong({ t0, hostTick, hostNow }) {
    const now = performance.now();
    const rtt = now - t0;
    this.rtt = this.rtt ? this.rtt * 0.8 + rtt * 0.2 : rtt;
  }

  _playSound(m) {
    // 16 interop — replay host world sounds locally
    const { emitSound, at } = this.game._audioApi || {};
    if (emitSound) emitSound(m.name, m.x !== undefined ? at(m.x, m.y, m.z) : null, m.pitch ?? 1, m.vol ?? 1);
  }

  hasClients() { return false; }
}
