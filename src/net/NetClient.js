// 14-MULTIPLAYER §2/§4 — the CLIENT session. Connects to the relay, runs the join
// handshake, streams the world (no terrain workers), predicts its own player, and
// renders everything else from host snapshots. Clients never own world data.
import { STATE, CHUNK_CELLS, MS_PER_TICK, JOIN_RADIUS } from '../constants.js';
import {
  MSG, PROTO_VERSION, RELAY_VERSION, BTN, EFLAG, PROFESSION_LIST,
  encodeJson, decodeJson, encodeInput, decodeSnapshot, encodeBlockEdit,
  decodeBlockSet, decodeChunkData, encodePing, decodePong,
} from './protocol.js';
import { getLocalPlayerId, getLocalPlayerName, hueFromId } from './identity.js';
import { Predictor } from './prediction.js';
import { Interpolator } from './interpolation.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import { ETYPE_REV } from './protocol.js';

const REQUIRED_CHUNKS = (JOIN_RADIUS * 2 + 1) ** 2;   // 121
const HANDSHAKE_TIMEOUT_MS = 15000;   // §2.2 — "Every step has a 15 s timeout"

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
    this._deathTimers = new Set();     // §3.3 pending death-anim removals
    this._statWindow = 0;
  }

  // ---------------------------------------------------------------- transport
  connect() {
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this._fail('badurl'); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => this._sendControl({ t: 'join', code: this.code, v: RELAY_VERSION });
    // 14 §16 — a proxy error page or a truncated frame must not throw out of the
    // socket handler and leave the connection half-configured. The guard covers
    // the Uint8Array construction too; _onData keeps its own inner try.
    ws.onmessage = ev => {
      try {
        if (typeof ev.data === 'string') this._onControl(JSON.parse(ev.data));
        else this._onData(new Uint8Array(ev.data));
      } catch (e) { console.warn('[net] bad relay frame', e); }
    };
    ws.onclose = () => { if (this.phase !== 'closed') this._fail('lost'); };
    ws.onerror = () => {};
    this._armHandshake();
  }

  // §2.2 — every handshake step is bounded by 15 s. Without it a stall with the
  // socket still open (relay accepted the join but the host never answered hello,
  // or the chunk stream died mid-join) parks the player on CONNECTING forever,
  // since `onclose` never fires. Re-armed on each phase advance, cleared at PLAYING.
  _armHandshake() {
    clearTimeout(this._hsTimer);
    this._hsTimer = setTimeout(() => {
      if (this.phase !== 'playing' && this.phase !== 'closed') this._fail('timeout');
    }, HANDSHAKE_TIMEOUT_MS);
  }

  _clearHandshake() { clearTimeout(this._hsTimer); this._hsTimer = null; }

  /** §3.3 — drop every pending death-anim removal (see _onEntityDespawn). */
  _clearDeathTimers() {
    for (const t of this._deathTimers) clearTimeout(t);
    this._deathTimers.clear();
  }

  _sendControl(obj) { try { this.ws.send(JSON.stringify(obj)); } catch {} }
  _send(u8) { try { this.ws.send(u8); this.stats.out++; this.stats.outBytes += u8.length; } catch {} }
  sendJson(obj) { this._send(encodeJson(obj)); }

  _fail(reason) {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this._clearHandshake();
    this._clearDeathTimers();
    try { this.ws?.close(); } catch {}
    this.onError?.(reason);
  }

  disconnect() {
    this.phase = 'closed';
    this._clearHandshake();
    this._clearDeathTimers();
    try { this.ws?.close(); } catch {}
  }

  // ---------------------------------------------------------------- relay control frames
  _onControl(m) {
    if (m.t === 'joined') { this.slot = m.slot; this._armHandshake(); this._sendHello(); }
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
      case 'sound': this._playSound(m); break;
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
    // 14 §2.2 — a throw in world construction (a malformed `welcome.you` reaching
    // Player.deserialize) used to be swallowed: startClientWorld was `async`, so
    // the rejection was unobserved and the handshake carried on binding a
    // Predictor to a half-built player, surfacing 15 s later as a bogus 'timeout'.
    // The method is synchronous now, so this guard actually catches it.
    try { this.game.startClientWorld(m, this); }
    catch (err) { console.error('[net] client world init failed', err); this._fail('worldinit'); return; }
    this.predictor = new Predictor(this.game.player, (pl, fr) => this.game.tickClientPlayer(pl, fr));
    this.phase = 'streaming';
    this._armHandshake();
  }

  _onChunkData(d) {
    const cm = this.game.chunkManager;
    if (!cm) return;
    cm.installNetChunk(d.cx, d.cz, d.blocks, d.states, d.biomes, d.dim);
    this.chunksReceived++;
    if (this.phase === 'streaming') {
      this.game.ui?.netMenus?.setProgress?.(Math.min(this.chunksReceived, REQUIRED_CHUNKS), REQUIRED_CHUNKS);
      // progress resets the §2.2 deadline: the stream is slow, not stalled (the host
      // may still be generating terrain for a first join). 15 s of NO chunk fails.
      this._armHandshake();
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
    this._clearHandshake();          // §2.2 — handshake complete
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
        this._armHandshake();        // §2.2 — bound the wait for spawnConfirm
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
    // §4.4 — mark EVERY puppet, players included (Game.createPuppet's RemotePlayer
    // branch returns before its own isPuppet assignment). updateRender uses the flag
    // to skip the fixed-timestep lerp: renderTick below already wrote the final
    // interpolated position, and re-lerping it with the tick residual modulates
    // apparent speed ~4:1 at 20 Hz — the teleport-stutter §Acceptance forbids.
    if (pup) { pup.netId = e.id; pup.isPuppet = true; this.puppets.set(e.id, pup); this.game.entities.add(pup); }
  }

  _removePuppet(id) {
    const pup = this.puppets.get(id);
    // entities is null after disposeWorld — a late death-anim timer must not deref it.
    if (pup) { this.game.entities?.remove(pup); this.puppets.delete(id); }
    this.interp.remove(id);
    this.staticData.delete(id);
  }

  // per-frame: advance interpolation, drive puppets (called from Game.render)
  // §4.4 — on a CLIENT this is the ONLY pass that touches puppets: Game.tick short-
  // circuits into clientTick(), which never calls entities.tick(), so nothing that
  // Entity.baseTick / Entity.tickTimers normally does for them happens anywhere else.
  renderTick(frameDeltaMs) {
    this.interp.advance(frameDeltaMs);
    const dt = Math.min(4, frameDeltaMs / MS_PER_TICK);      // ticks elapsed this frame
    for (const [id, pup] of this.puppets) {
      const s = this.interp.sample(id);
      if (!s) continue;
      pup.prevPos.x = pup.pos.x; pup.prevPos.y = pup.pos.y; pup.prevPos.z = pup.pos.z;
      pup.prevYaw = pup.yaw;
      pup.pos.x = s.x; pup.pos.y = s.y; pup.pos.z = s.z;
      pup.yaw = s.yaw; pup.pitch = s.pitch;
      // Entity.baseTick's every-4-ticks light sample. Without it lightScalar keeps its
      // constructor value 1 and applyLightScalar renders every mob and remote player
      // full-bright in an unlit cave.
      pup._lightAcc = (pup._lightAcc ?? 0) + dt;
      if (pup._lightAcc >= 4) { pup._lightAcc = 0; pup.sampleLight?.(); }
      // Entity.tickTimers' hurt decay. The authoritative HURT flag rewrites hurtTime
      // just below, but the `hurt` event sets 10 with nothing behind it — without this
      // one punch left a puppet red-tinted for the rest of the session.
      if (pup.hurtTime > 0) pup.hurtTime = Math.max(0, pup.hurtTime - dt);
      if (pup.applyFlags) pup.applyFlags(s.flags, s.stateByte);
      else this._applyPuppetState(pup, s.flags, s.stateByte, dt);
      pup.health = s.health;
      pup.stateByte = s.stateByte;
    }
    if (this.predictor) this.predictor.decayOffset();
  }

  // §4.4 — flag/stateByte decode for every puppet that is NOT a RemotePlayer (mobs,
  // items, projectiles): those classes carry no applyFlags of their own, so the whole
  // snapshot flag byte and stateByte used to be decoded and then thrown away.
  _applyPuppetState(pup, flags, stateByte, dt) {
    pup.onGround = (flags & EFLAG.ON_GROUND) !== 0;
    pup.sprinting = (flags & EFLAG.SPRINTING) !== 0;
    pup.sneaking = (flags & EFLAG.SNEAKING) !== 0;
    pup.fireTicks = (flags & EFLAG.BURNING) ? Math.max(pup.fireTicks ?? 0, 1) : 0;
    pup.swinging = (flags & EFLAG.SWINGING) !== 0;
    pup.gliding = (flags & EFLAG.GLIDING) !== 0;
    pup.hurtTime = (flags & EFLAG.HURT) ? 10 : 0;
    const wasDead = pup.dead;
    pup.dead = (flags & EFLAG.DEAD) !== 0;
    // 05 §16.3 keel-over: deathTime is advanced by Mob.tick host-side, which a puppet
    // never runs — drive it here so Mob.updateRender's fall-over actually plays out.
    if (pup.dead) pup.deathTime = wasDead ? (pup.deathTime ?? 0) + dt : 0;
    // §4.4 limb swing: walkCycle/swingAmount are only advanced in Mob.tick, so without
    // this every mob slides across the ground with frozen legs. Same shape as Mob's
    // travel step (walkCycle += hSpeed*4, swingAmount smoothed toward min(1,hSpeed*8)),
    // rebased from per-tick onto this frame's interpolated displacement.
    if (pup.walkCycle !== undefined) {
      const step = Math.hypot(pup.pos.x - pup.prevPos.x, pup.pos.z - pup.prevPos.z);
      pup.prevWalkCycle = pup.walkCycle;
      pup.walkCycle += step * 4;
      const k = 1 - Math.pow(0.9, dt);
      pup.swingAmount += (Math.min(1, (step / Math.max(1e-6, dt)) * 8) - pup.swingAmount) * k;
    }
    // per-type stateByte (§3.4). A visual field change needs a mesh rebuild, which
    // EntityManager.updateRender performs from `needsMeshRebuild`.
    switch (pup.type) {
      case 'creeper': pup.swell = stateByte; break;
      // bit0 sheared; the wool parts toggle visibility in place (no rebuild). The
      // dye colour is a 24-bit woolTint that does not fit the stateByte and never
      // changes after spawn, so it rides entitySpawn.static instead (§3.2).
      case 'sheep':
        pup.sheared = (stateByte & 1) !== 0;
        pup.updateWoolVisibility?.();   // no-op until parts exist, hence every frame
        break;
      case 'villager': case 'zombie_villager': {
        const prof = PROFESSION_LIST[stateByte & 0x0f] ?? 'none', baby = (stateByte & 0x10) !== 0;
        if (pup.profession !== prof) pup.profession = prof;      // trade/robe data only
        if (pup.isBaby !== baby) { pup.isBaby = baby; pup.needsMeshRebuild = true; }
        break;
      }
      case 'item': {
        // render-count bucket 1–4 → a representative count on ItemEntity.buildMesh's
        // own cluster thresholds, so a host-side stack merge re-clusters the puppet.
        if (pup.stack) {
          const want = stateByte >= 4 ? 33 : stateByte >= 3 ? 17 : stateByte >= 2 ? 2 : 1;
          const c = pup.stack.count;
          const have = c >= 33 ? 33 : c >= 17 ? 17 : c >= 2 ? 2 : 1;
          if (have !== want) { pup.stack.count = want; pup.needsMeshRebuild = true; }
        }
        break;
      }
      default: {
        if (pup.isBaby === undefined) break;
        const baby = (stateByte & 1) !== 0;
        if (pup.isBaby !== baby) { pup.isBaby = baby; pup.needsMeshRebuild = true; }
        break;
      }
    }
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
    // §5 — playerState is an "authoritative overwrite of client copy", so effects
    // REPLACE rather than merge: ids the host dropped (respawn clearEffects, milk)
    // must go, or the client keeps predicting Speed/Slowness and drawing the HUD
    // until the stale durations expire. `!== undefined` (not truthiness) so an empty
    // `[]` still clears, while NetHost's _invSig dedupe — which deletes the key when
    // unchanged — correctly leaves the local copy alone.
    if (m.effects !== undefined) { const { applyEffectsData } = this.game._effectsApi || {}; applyEffectsData?.(p, m.effects, true); }
    if (m.dead && this.game.state !== STATE.DEAD) { document.exitPointerLock?.(); this.game.setState(STATE.DEAD); }
    if (!m.dead && this.game.state === STATE.DEAD) { /* handled by respawn/forceMove */ }
  }

  _onEntitySpawn(m) { this.staticData.set(m.id, m.static || {}); }
  // §3.3 — reason 'died' plays the 05 §16.3 death anim BEFORE removal. Only puppets
  // that own an anim (Mob.deathAnimTicks) get the grace period; everything else, and
  // reasons 'range'/'removed', goes immediately as before.
  _onEntityDespawn(m) {
    const pup = this.puppets.get(m.id);
    if (m.reason === 'died' && pup && pup.deathAnimTicks) {
      pup.dead = true;
      if (!(pup.deathTime > 0)) pup.deathTime = 0;
      // The handle is tracked so teardown can cancel it: an untracked timer
      // fired against a disposed game (Save & Quit inside the ~1 s anim) threw
      // out of a bare timer callback, outside frame()'s guard entirely.
      const t = setTimeout(() => { this._deathTimers.delete(t); this._removePuppet(m.id); },
        pup.deathAnimTicks * MS_PER_TICK);
      this._deathTimers.add(t);
      return;
    }
    this._removePuppet(m.id);
  }

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
    // 14 §12 — the host emits add (id/name/style), set (id/hpFrac) and remove as
    // SEPARATE frames. Treating every non-remove frame as an add re-wrote the
    // bar's name to `undefined` on each hp update.
    if (m.remove) { bb.remove(m.id); return; }
    if (m.name !== undefined) bb.add(m.id, { name: m.name, color: m.style });
    if (m.hpFrac !== undefined) bb.set(m.id, m.hpFrac);
  }
  _onDimChange(m) {
    this.game.clientDimChange(m);
    this.chunksReceived = 0;
    this.spawnReadySent = false;
    this.phase = 'streaming';
    this._armHandshake();            // §2.2 — a dimension re-stream is a handshake too
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
    // §7.1 — relay the measurement back so the host's playerList carries a real
    // rttMs for the Tab overlay (it has no timing of its own; the pong is fired and
    // forgotten). 1 Hz, same cadence as the ping. Ignored by pre-rttReport hosts.
    this.sendJson({ t: 'rttReport', ms: Math.round(this.rtt) });
  }

  _playSound(m) {
    // 16 interop — replay host world sounds locally
    const { emitSound, at } = this.game._audioApi || {};
    if (emitSound) emitSound(m.name, m.x !== undefined ? at(m.x, m.y, m.z) : null, m.pitch ?? 1, m.vol ?? 1);
  }

  hasClients() { return false; }
}
