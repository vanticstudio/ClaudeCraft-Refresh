# 14 — MULTIPLAYER: Host-Authoritative Co-op over a WebSocket Relay

This expansion turns VoxelCraft into a 2–8 player co-op game. **The architecture is decided: one player's browser (the HOST) runs the entire authoritative simulation** — world, mobs, redstone (07), fluids (06/15), time/weather (04), villagers (12), bosses (13) — while thin CLIENTS predict only their own movement and render everything else from host snapshots. Transport is a tiny Node.js WebSocket **relay** (`server/relay.js`, ~80 lines) that knows nothing about the game: it groups sockets into rooms by 6-char join code and passes binary frames through with sender tagging. The design follows the canon of the genre: Gabriel Gambetta's *Fast-Paced Multiplayer* series (client-side prediction + server reconciliation via input sequence numbers), the Valve Source *Multiplayer Networking* model (snapshot entity interpolation, render 100 ms in the past), and Gaffer On Games' snapshot quantization/jitter guidance — adapted to a 20 TPS browser host on TCP WebSockets. This file owns: the relay, the wire protocol, session/handshake flow, prediction/reconciliation, host-side multi-player simulation rules, multiplayer UI, and the multi-profile save contract. Sibling expansions ride this protocol generically (§12).

**Rejected alternative — WebRTC mesh (P2P):** every peer simulating or cross-sending state needs either lockstep determinism (impossible with our float physics + `Math.random()` mob jitter) or an authority anyway; DataChannel setup needs signaling + STUN/TURN and still fails on symmetric NAT without a TURN server — which is just a relay with more moving parts. A WS relay demos reliably on LAN and over one tunnel command; WebRTC does not.

**Rejected alternative — dedicated authoritative Node server:** would require porting the entire simulation (chunks, lighting, AI, fluids, 06 registries) out of the browser into Node, doubling the codebase surface and forking every future expansion into two runtimes. The host browser already runs a proven single-player sim at <3 ms/tick; promoting it to authority reuses 100% of that code. A headless server is the correct v2 if this project ever needs >8 players or host-crash resilience — not before.

---

## Amendments to base files

- **AMENDS CLAUDE.md §7:** multiplayer is already in-scope in the v2 master plan (14 owns it) — confirm it is not listed under "Out of scope v2". The game is single-player by default; multiplayer is opt-in per 14-MULTIPLAYER.md.
- **AMENDS 01 §1 (package.json):** add script `"relay": "node server/relay.js"` and devDependency `"ws": "^8.20.1"` (verified current July 2026). `ws` is used ONLY by the Node relay; the browser bundle gains zero dependencies (browsers use native `WebSocket`).
- **AMENDS 01 §2 (module map):** add exactly these files (module count 52 → 61): `server/relay.js`, `src/net/protocol.js` (message ids, binary encode/decode, JSON schemas), `src/net/NetHost.js` (host session: sockets, per-client state, interest sets, snapshot build), `src/net/NetClient.js` (client session: handshake, world intake, dispatch), `src/net/prediction.js` (input ring, reconciliation), `src/net/interpolation.js` (remote-entity buffers, puppets), `src/entities/RemotePlayer.js` (client-side player puppet), `src/ui/chat.js` (chat overlay + player list), `src/ui/netMenus.js` (Host/Join/Connecting screens).
- **AMENDS 01 §3 (tick order):** insert step **1.5** `net.drainInbound()` — decode all queued client messages; apply each remote player's newest eligible input frame as that player entity's virtual input snapshot (§5.2); enqueue block-edit/use/attack requests for step 2.5. Replace step 2 with **2. all player entities tick** — local player first, then remote players in slot order, each via 03 §4 with its own input struct. Insert step **2.5** `net.applyRequests()` — validate + execute queued block edits, uses, attacks (§5.6, §7.3). Insert step **9.5** `net.outboundTick()` — build + send snapshots every 2nd tick, flush event queues, 1 Hz player list, 100-tick time sync (§3).
- **AMENDS 01 §3 + §15.2 (pause rule):** while a session has ≥1 connected client, entering `PAUSED` does NOT freeze the accumulator — ticking continues; the menu only captures local input. Menu subtitle: "World keeps running while players are connected." Solo host (0 clients) pauses normally.
- **AMENDS 01 §4.3 / §6.1 / §6.2:** all player-distance-based streaming and simulation predicates (`GENERATE/RENDER/SIM/UNLOAD` radii, random ticks, scheduled-tick re-scheduling) are evaluated against the **nearest connected player** (host's local player included); chunk keep-alive is the union of all players' radii (§5.3).
- **AMENDS 01 §13.2 (EntityManager):** entity ids allocate from a wrapping u16 counter skipping live ids; ids are host-authoritative — clients never allocate sim entity ids. Chunk-unload entity discard never applies to player entities. Each entity type gains `netStatic()` (spawn payload, §3.5) and a `netDirty` change flag.
- **AMENDS 01 §15.1 (keybinds):** add `KeyT` → open chat, `Tab` (hold) → player list overlay, `Enter`/`Escape` → send/close chat. While the chat input is focused, all movement/game keys are suppressed (buttons bitfield sent as 0) and `Tab` is `preventDefault()`ed.
- **AMENDS 01 §15.2 (screen state machine):** add states `CONNECTING` (join handshake + chunk stream, shows progress) and title-screen flows `HOST` / `JOIN` (§8.1).
- **AMENDS 01 §16 (save schema):** `meta.version` becomes **2**. The `player` field is replaced by `players: { [playerId]: PlayerRecord }` where `PlayerRecord` = the 01 §16.1 player object + `{ name, dim, effects: [], lastSeen: epochMs }`. Migration v1→v2 on load: wrap the existing `player` object under the host's own playerId, set `version = 2`. Chunk records: the `entities` array never contains player entities (players persist only in `meta.players`).
- **AMENDS 03 §2.3 (model):** the Player class gains `buildMesh()` — a humanoid box model per 05 §16.1 conventions (head 8×8×8 px-scale, body, 4 limbs; 0.6×1.8 proportions) with a procedurally painted skin whose hue rotates deterministically from playerId (§8.4). The **local** player still renders nothing (first person); the mesh is built for player entities viewed by others.
- **AMENDS 03 §3 + §4 (input/tick):** Player becomes instantiable once per connected player. `tickPlayer(p, input)` is unchanged, but `input` is an explicit `InputFrame` struct — the local player's comes from `input.snapshot()`, a remote player's from its network input queue (§5.2). Camera, viewmodel, HUD, overlays, and pointer lock exist only for the local player. Add `KeyT`/`Tab` per the 01 §15.1 amendment.
- **AMENDS 03 §16.2 (placement):** the entity-overlap check tests ALL player entities' AABBs, not just the local player.
- **AMENDS 03 §20.5–§20.6 + §22 (death/respawn):** death and respawn execute host-side per player; `spawnPoint` reads from that player's `meta.players` record; the dying player's client is driven by `playerState`/`forceMove` messages (§3.5, §7.4).
- **AMENDS 04 §12.1 (weather):** `tickWeather()` runs on the host only; clients apply replicated `raining/thundering/rainLevel/thunderLevel` from `timeSync` and never roll weather RNG.
- **AMENDS 04 §14 (sleep):** night skips only when **every** connected player is in a valid bed (config `SLEEP_PERCENT = 100`, a constant in `constants.js`); the skip fires when `min(bedTicks over all players) >= 100`. Per-bed checks (§14.1–14.2) run host-side per player. Broadcast "`n`/`m` players sleeping" chat lines on each bed enter/leave.
- **AMENDS 05 §1 (sim range) + §4 (despawn):** the 64-block AI range, the >128 instant despawn, and the >32 random despawn all measure distance to the **nearest** player.
- **AMENDS 05 §3.2 (spawn cycle):** the 20-tick spawn wave centers on one player per wave, **round-robin** over connected players (wave `w` → player `w mod playerCount`). Global hostile cap `HOSTILE_CAP = 40 + 20 × (min(playerCount, 4) − 1)` → 40 / 60 / 80 / 100 for 1/2/3/≥4 players. `validSpawnPos` distance check: ≥ 24 from **every** player.
- **AMENDS 05 §6 (targeting):** hostile target acquisition iterates all players: candidates = players with `dist ≤ detectionRange` (sneak ×0.8) AND line-of-sight; pick the **nearest**. Retaliation targets the attacker. Enderman stare-trigger and creeper swell test each player independently.
- **AMENDS 06 §14 (click semantics):** every click in §14.2 executes **host-side** against authoritative inventories; the client applies the same table optimistically to a *predicted* cursor + screen and rolls back to the host result on mismatch (§6.2). §14.1 closing-returns and shift-routing run host-side.
- **AMENDS 06 §16 (item pickup):** pickup scanning is host-only; when multiple players' pickup boxes overlap the same item entity in one tick, the lowest slot number wins (deterministic first-toucher, §5.6).

---

## Contents

1. [Topology, roles & relay server](#1-topology-roles--relay-server)
2. [Identity, session flow & chunk streaming](#2-identity-session-flow--chunk-streaming)
3. [Wire protocol & message catalog](#3-wire-protocol--message-catalog)
4. [Client prediction, reconciliation & interpolation](#4-client-prediction-reconciliation--interpolation)
5. [Host simulation with N players](#5-host-simulation-with-n-players)
6. [Inventory & containers over the network](#6-inventory--containers-over-the-network)
7. [Latency, clocks & combat](#7-latency-clocks--combat)
8. [Multiplayer UI](#8-multiplayer-ui)
9. [Host lifecycle & persistence](#9-host-lifecycle--persistence)
10. [Security & trust model](#10-security--trust-model)
11. [Performance & bandwidth budgets](#11-performance--bandwidth-budgets)
12. [Expansion interop](#12-expansion-interop)
13. [Dev & test guide](#13-dev--test-guide)
14. [Acceptance checklist](#acceptance-checklist)

---

## 1. Topology, roles & relay server

### 1.1 Who runs what

| System | Host browser | Client browser |
|---|---|---|
| Terrain gen workers (01 §9) | yes | **no** (workers never constructed; chunks arrive over the wire) |
| Block updates, scheduled ticks, fluids, random ticks (01 §6) | yes | no |
| Mob AI, spawning, pathfinding (05) | yes | no |
| worldTime / weather advance (04) | yes | visual `worldTime++` between syncs only |
| Redstone (07), fire/waterlogging (15), villagers (12), bosses (13) | yes | no |
| Own player physics (03 §4) | yes (locally, zero latency) | **yes — predicted**, reconciled per §4 |
| Other players / mobs / items / arrows | simulated | interpolated puppets (§4.4) |
| Lighting engine (01 §10) | yes | yes — recomputed locally from replicated blocks (deterministic, visual-only) |
| Meshing, sky, particles, HUD | yes | yes |
| IndexedDB save (01 §16) | yes (sole owner of world data) | **never** (clients persist only settings + identity in localStorage) |
| Inventory/containers/crafting/XP/hunger (06) | authoritative | predicted cursor + replicated state (§6) |

Player count: 2–8 (host + up to 7 clients). One WebSocket per participant to the relay; the host holds no direct sockets to clients — everything routes through the relay, so the demo works the moment the relay port is reachable.

### 1.2 Relay server spec (`server/relay.js`)

Pure passthrough. **The relay never parses game payloads** — its only jobs: rooms, join codes, sender tagging, routing, heartbeat, caps.

| Property | Value |
|---|---|
| Runtime | Node ≥ 20.19 (same floor as Vite, 01 §1), `ws@^8.20.1` |
| Start | `npm run relay` → `node server/relay.js`; flags `--port 8971` (default; env `PORT` overrides), `--delay <ms>` artificial one-way latency, `--jitter <ms>` uniform random extra delay (§13) |
| Rooms | `Map<code, { host: ws, clients: Map<slot, ws> }>`; max 64 rooms; room dies when the host socket closes (clients get `hostGone` then are closed) |
| Join code | 6 chars from alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (31 chars, no 0/O/1/I/L ambiguity), `crypto.randomInt` per char; regenerate on collision |
| Slots | host = slot 0; clients get lowest free slot 1–7; **room capacity 8 total** — 9th join is refused `{t:'err', reason:'full'}` |
| Control frames (text/JSON) | first frame from a new socket: `{t:'host', v:1}` → reply `{t:'room', code}`; or `{t:'join', code, v:1}` → reply `{t:'joined', slot}` + notify host `{t:'peer+', slot}`. On any disconnect: host gets `{t:'peer-', slot}` / clients get `{t:'hostGone'}`. `v` is the RELAY protocol version (independent of the game's `PROTO_VERSION`); mismatch → `{t:'err', reason:'relay-version'}` |
| Data frames (binary) | client→relay: raw payload; relay **prepends 1 byte senderSlot** and forwards to the host. host→relay: first byte = target (`0..7` = that slot, `0xFF` = broadcast to all clients); relay strips the byte and forwards. That one-byte convention is the relay's entire game-facing API |
| Heartbeat | `ws.ping()` every 5 s per socket; no pong within **10 s** → `terminate()` (fires the disconnect notifications above) |
| Socket options | `perMessageDeflate: false` (hot-path payloads are already RLE'd/quantized; deflate adds latency jitter), `socket.setNoDelay(true)` on upgrade (kill Nagle — 50 ms coalescing would eat the entire tick budget), `maxPayload` per §10 |
| Size | ~80 lines. No auth, no TLS termination (put a tunnel or reverse proxy in front for `wss://`), no persistence, no game constants |

Reference skeleton (normative behavior, condensed):

```js
// server/relay.js  (ws@^8.20.1)
import { WebSocketServer } from 'ws';
const rooms = new Map(); const PORT = process.env.PORT ?? argv.port ?? 8971;
const wss = new WebSocketServer({ port: PORT, perMessageDeflate: false,
                                  maxPayload: 262144 });
wss.on('connection', (ws, req) => {
  req.socket.setNoDelay(true);
  ws.isAlive = true; ws.on('pong', () => ws.isAlive = true);
  ws.once('message', (data, isBinary) => {           // control frame
    if (isBinary) return ws.close();
    const m = JSON.parse(data);
    if (m.t === 'host')      createRoom(ws);          // → {t:'room', code}
    else if (m.t === 'join') joinRoom(ws, m.code);    // → {t:'joined', slot} | {t:'err'}
    else ws.close();
    ws.on('message', (buf, bin) => bin && route(ws, buf));   // data frames
  });
});
function route(ws, buf) {
  const room = ws.room; if (!room) return;
  const fwd = (sock, b) => DELAY ? setTimeout(() => sock.send(b), DELAY + JITTER())
                                 : sock.send(b);
  if (ws.slot === 0) {                                // host → clients
    const target = buf[0], payload = buf.subarray(1);
    if (target === 0xFF) for (const c of room.clients.values()) fwd(c, payload);
    else { const c = room.clients.get(target); if (c) fwd(c, payload); }
  } else {                                            // client → host (tag sender)
    const tagged = Buffer.concat([Buffer.from([ws.slot]), buf]);
    fwd(room.host, tagged);
  }
}
setInterval(() => wss.clients.forEach(ws => {         // 5 s heartbeat, 10 s timeout
  if (!ws.isAlive) return ws.terminate();
  ws.isAlive = false; ws.ping();
}), 5000);
```

**Internet play:** the relay binds one plain TCP port. For play beyond LAN, run it on any VPS, or tunnel a local instance: `cloudflared tunnel --url http://localhost:8971` (or ngrok/tailscale-serve) and give friends the resulting `wss://` URL — the game's relay-URL field (§8.1) accepts `ws://` and `wss://`. No NAT traversal logic exists anywhere in the game.

---

## 2. Identity, session flow & chunk streaming

### 2.1 Player identity

- `playerId` = `crypto.randomUUID()` generated once and stored in `localStorage['voxelcraft.playerId']`; it is the permanent key for save records, skin hue, and rejoin.
- `playerName` = `localStorage['voxelcraft.playerName']`, 1–16 chars `[A-Za-z0-9_]`, prompted on first Join/Host; host truncates/sanitizes on receipt.
- The host's own playerId identifies its record inside `meta.players` exactly like a client's (v1→v2 migration puts the old single `player` there).
- `PROTO_VERSION = 1` (int in `net/protocol.js`). Bump on ANY wire-format change; mismatch refuses the join with a readable error.

### 2.2 Handshake sequence (client join)

```
C = joining client, H = host, R = relay.  [J] = JSON, [B] = binary (§3).

1  C→R  {t:'join', code, v:1}            R validates room; assigns slot; → C {t:'joined', slot}
                                          → H {t:'peer+', slot}
2  C→H  [J] hello { v: PROTO_VERSION, playerId, name }
3  H:   v mismatch          → [J] reject {reason:'version', hostV} → drop
        playerId online now → [J] reject {reason:'dupe'}          → drop
4  H→C  [J] welcome { slot, seed, worldTime, weather:{...04 §12.1 scalars},
                      dim:'overworld', hostTick,
                      you: PlayerRecord,          // saved record if returning, else fresh
                      spawnPos:{x,y,z},           // record pos, else bed, else worldSpawn (02)
                      players:[{playerId,name,slot,hue}...],
                      rules:{ sleepPercent:100, hostileCap } }
5  H→C  [B] chunkData × N  — spiral nearest-first around spawnPos's chunk (§2.3);
        all 121 chunks of JOIN_RADIUS=5 (11×11) must arrive before spawn
6  C:   installs chunks → runs LightEngine.initialLight → meshes; when the 7×7
        around spawn is MESHED (base LOADING gate, 01 §15.2):
   C→H  [J] spawnReady
7  H:   creates the Player entity (host-sim), inserts into meta.players if new,
        broadcasts [J] playerJoin {playerId,name,slot,hue,entityId} + entitySpawn
   H→C  [J] spawnConfirm { entityId, pos, yaw, pitch, state:playerState payload }
8  C:   state → PLAYING; prediction starts at seq 0; chat line "<name> joined".
```

The client shows `CONNECTING` with a progress bar = `chunksReceived / 121` during step 5, then "Entering world…" during meshing. Every step has a 15 s timeout → error screen → title.

**Late join** is the same flow against a live world — `welcome` carries current time/weather, and snapshots begin immediately after `spawnConfirm`. **Host** performs no handshake: it IS the authority; hosting = normal single-player boot + `{t:'host'}` to the relay (§8.1).

### 2.3 Chunk streaming protocol

- Host tracks per-client `sentChunks: Set<'dim:cx,cz'>` and a per-client stream cursor. Wanted set = spiral (ascending Chebyshev, then squared distance) within radius **8** of the client's current chunk, minus `sentChunks`. Chunks the host doesn't have yet are requested through its normal ChunkManager (worker gen or save hydrate) and stream when GENERATED.
- Budget: ≤ **6 chunks/tick per client**, ≤ **12 chunks/tick total** across clients (join bursts throttle each other, ~700 KB/s worst case, §11).
- Payload (message `0x05`, §3.4): `blocks` + `states` RLE-compressed, `biomes` raw 256 B. RLE = repeated `(runLen u8 ≥1, value u8)` pairs per stream, decoded until 32,768 cells; Y-major layout (01 §4.2) yields long horizontal runs — typical terrain chunk ≈ 1.5–5 KB total `(approx)`. Client recomputes `heightMap` (top-down scan, <1 ms — same as save hydrate, 01 §9) and light (01 §10 initialLight when the 3×3 neighborhood has arrived).
- `blockEntities` are **not** streamed — container contents live host-side only; clients see contents exclusively through container sessions (§6). Furnace lit state is already the `furnace_lit` block id; nothing visual is lost.
- Client-side eviction mirrors base `UNLOAD_RADIUS = 11` (dispose mesh, drop arrays). The host evicts that client's `sentChunks` entry at Chebyshev > 11 too, so re-approach re-sends fresh data — this is also the coherence mechanism: a chunk edited while outside a client's interest is simply re-sent on re-entry. Within interest, `blockSet` broadcasts (§3.4) keep it current.
- Ongoing play: as a client crosses a chunk border, the host streams newly-wanted chunks by the same budget. Client render distance is assumed 8 (base constant); the host does not negotiate it (decision — one constant, zero config drift).

### 2.4 Rejoin & per-player persistence

`meta.players[playerId]` (01 §16 amendment) stores per player: `name, pos, vel, yaw, pitch, dim, health, hunger, saturation, exhaustion, foodPoisonTicks, xp, air, fireTicks, fallDistance, gameMode, inventory[36], armor[4], selectedSlot, spawnPoint (bedSpawn), effects[] (09), lastSeen`. Written on: autosave (host, every 600 ticks), that player's disconnect, host shutdown. A rejoining playerId gets its record back verbatim — inventory, XP, bed spawn, effects, position (host loads that chunk first if needed). Records persist indefinitely; the host's world "remembers" every friend. A client who dies while connected and quits at the death screen rejoins alive at their spawn point with post-death state (empty inventory — death already dropped it).

---

## 3. Wire protocol & message catalog

### 3.1 Encoding decision: manual binary + JSON, no MessagePack

**Decision: hot-path messages (input, snapshot, blockEdit/blockSet, chunkData, ping/pong) are hand-packed ArrayBuffers via `DataView` (little-endian); everything infrequent is a JSON text frame `{"t":"...", ...}`.** MessagePack (`@msgpack/msgpack@3.1.3`, ~30 KB min bundle) is rejected: it still ships field names or needs tuple conventions (at which point it IS a manual layout with overhead), generic encode costs more than a dozen fixed `setUint16` calls, and it can't express our quantization (int16 chunk-relative positions, u8 angles) — the wins all come from quantization, not from the container format (Gaffer On Games, *Snapshot Compression*). JSON for rare messages keeps them debuggable in devtools for free. This also matches the base project's zero-wrapper-library rule (01 §1).

Framing: binary payloads are detected by `data instanceof ArrayBuffer` (client sockets set `binaryType='arraybuffer'`); byte 0 is the message id. JSON messages are text frames. The relay's routing byte (§1.2) is outside the payload and stripped before decode.

### 3.2 Reliability model

WebSocket = TCP: **every message is reliable and globally ordered per direction.** Consequences the design leans on: no acks, no resend logic, no sequence gaps — `seq` numbers exist for *reconciliation matching*, not loss recovery. The cost is head-of-line blocking under packet loss (one lost TCP segment stalls everything behind it ~1 RTT): mitigations are small frames, `setNoDelay`, no deflate, and the interpolation buffer + ≤50 ms extrapolation absorbing stalls (§4.4). `(approx)` On links with >2% loss, hitching is expected and accepted — WebTransport/datagrams are out of scope.

### 3.3 Message catalog

Rates are steady-state targets; "burst" = event-driven. Enc `B` = binary (§3.4), `J` = JSON (§3.5).

| # | Name | Dir | Enc | Rate | Payload (summary) | Notes |
|---|---|---|---|---|---|---|
| 0x01 | `input` | C→H | B | 20 Hz | seq, buttons u16, yaw, pitch, hotbar | one per client tick; host jitter-buffers (§5.2); stale frames dropped, buttons are hold-state so drops are safe |
| 0x02 | `snapshot` | H→C | B | 10 Hz | header: hostTick, keyframe flag, ack {lastInputSeq, pos, vel, ownFlags}, anchor chunk; N entity records | per-client interest set (§5.3); every 30th is a keyframe (all entities, 3 s); non-keyframes carry only changed entities |
| 0x03 | `blockEdit` | C→H | B | ≤10/s | action (break/place), editSeq, pos, face, hotbarSlot | client predicted; host validates reach 4.5 + rate + gamemode + replaceability; reject → targeted `blockSet` revert |
| 0x04 | `blockSet` | H→C | B | burst, batched/tick | dim, count, records {pos, id, state} | authoritative; sent to clients whose interest covers the chunk; idempotent (01 §4.6 early-out kills re-apply flicker) |
| 0x05 | `chunkData` | H→C | B | ≤6/tick/client | dim, cx, cz, RLE blocks, RLE states, biomes | §2.3; largest message (≤ ~130 KB worst, ~4 KB typical) |
| 0x06 | `ping` | C→H | B | 1 Hz | clientNow f64 | RTT + clock offset (§7.1) |
| 0x07 | `pong` | H→C | B | 1 Hz | echo t0, hostTick, hostNow | immediate reply, bypasses tick batching |
| — | `hello` | C→H | J | once | v, playerId, name | §2.2 |
| — | `welcome` / `reject` | H→C | J | once | world meta / reason | §2.2 |
| — | `spawnReady` / `spawnConfirm` | C↔H | J | once | — / entityId, pos, state | gates PLAYING |
| — | `playerJoin` / `playerLeave` | H→C | J | burst | playerId, name, slot, hue, entityId / playerId, reason | drives player list + chat sysline |
| — | `playerList` | H→C | J | 1 Hz | [{playerId, name, slot, rttMs, dim}] | Tab overlay + nameplate ping dots |
| — | `playerState` | H→C (owner only) | J | on change, ≤4/s | health, hunger, saturation, air, fireTicks, xp, effects[], gameMode, inventory?, armor? | private channel; inventory/armor arrays included only when they changed (≈1 KB); authoritative overwrite of client copy |
| — | `equip` | H→C | J | burst | entityId, heldItemId, armorTier | remote players' visible held item/armor; sent on change |
| — | `entitySpawn` | H→C | J | burst | id, type, pos, vel, yaw, static {…per type, §3.5} | full state on spawn or interest-entry |
| — | `entityDespawn` | H→C | J | burst | id, reason: 'died'\|'removed'\|'range' | 'died' plays 05 §16 death anim before removal |
| — | `hurt` | H→C | J | burst | entityId, srcDir?, byPlayerId? | red-flash/tilt/knockback visual on puppets; own hurt also arrives via playerState delta |
| — | `useBlock` | C→H | J | burst, ≤10/s | pos, face, hotbarSlot | RMB interact path (03 §16.1): doors, beds, buckets, flint&steel, chests, tables; host resolves priority |
| — | `attack` | C→H | J | burst | targetEntityId, yaw, pitch | melee claim; host validates per §7.3 |
| — | `dropItem` | C→H | J | burst | stack: bool | Q / Shift+Q from hotbar (UI-open drops ride container ops §6) |
| — | container ops (5 msgs) | C↔H | J | burst | §6: `containerOpen`, `containerClick`, `containerResult`, `containerSlot`, `containerClose` | host-resolved click semantics per 06 §14 |
| — | `chat` | C→H→all | J | ≤3/s | text ≤200 chars; H rebroadcasts {from, text}; system lines {from:null} | sanitized via `textContent` (§8.3) |
| — | `timeSync` | H→C | J | every 100 ticks + on change | worldTime, raining, thundering, rainLevel, thunderLevel | "on change" = weather toggle, sleep skip; client snaps worldTime (drift ≤ ±2 ticks between syncs) |
| — | `dimChange` | H→C (owner) | J | rare | dim, spawnPos | client wipes chunks, shows portal screen, re-runs §2.3 stream for new dim, then `forceMove` (10/11 interop) |
| — | `forceMove` | H→C (owner) | J | rare | pos, yaw, pitch, dim? | teleport/respawn: client clears input ring + prediction, hard-snaps (§4.3) |
| — | `respawn` | C→H | J | rare | — | death-screen Respawn click; host runs 03 §20.6 |
| — | `sound` | H→C | J | burst, ≤30/s/client | name, x, y, z, vol? | 16's event names pass through opaquely; sent to clients within 32 m; client-local predicted sounds (own steps/mining) never hit the wire (16 interop) |
| — | `sleepStatus` | H→C | J | burst | sleeping, total | HUD line + chat |
| — | `bossBar` | H→C | J | burst | id, name, hpFrac, style | owned by 13; carried opaquely (§12) |
| — | `hostShutdown` | H→C | J | once | seconds: 3 | §9.2 countdown |

### 3.4 Binary layouts (byte-exact, all little-endian)

**0x01 `input` — 10 B, 20 Hz.** `seq` is the client's tick counter mod 65536.

| Off | Type | Field | Encoding |
|---|---|---|---|
| 0 | u8 | msgId | 0x01 |
| 1 | u16 | seq | wraps; ring index = `seq % 128` |
| 3 | u16 | buttons | bit0 fwd, 1 back, 2 left, 3 right, 4 jump, 5 sneak, 6 sprint, 7 useHeld, 8 attackHeld, 9 flying(F4), 10–15 reserved (expansions may claim from bit15 downward) |
| 5 | u16 | yawQ | `yaw/(2π) × 65536` (0.0055° steps — full precision needed: host uses it for that player's raycasts and arrow aim) |
| 7 | i16 | pitchQ | `pitch_deg × 364` (±90° → ±32760) |
| 9 | u8 | hotbar | 0–8 |

**0x02 `snapshot` — 42 B header + 19 B/entity, 10 Hz per client.**

Header:

| Off | Type | Field | Notes |
|---|---|---|---|
| 0 | u8 | msgId | 0x02 |
| 1 | u32 | hostTick | timestamp: `hostTick × 50 ms` on the host clock |
| 5 | u8 | flags | bit0 keyframe |
| 6 | u16 | lastInputSeq | newest input seq the host applied for THIS client before building |
| 8 | f32×3 | ownPos | authoritative feet pos after that input |
| 20 | f32×3 | ownVel | b/t |
| 32 | u8 | ownFlags | bit0 onGround, 1 inWater, 2 inLava, 3 onLadder, 4 sprinting, 5 burning, 6 sleeping, 7 flying |
| 33 | i32×2 | acx, acz | anchor chunk = host's view of this client's chunk (full range — world border ±62,500 chunks overflows i16, hence anchor+delta) |
| 41 | u8 | count | entity records follow (≤64) |

Entity record (fixed 19 B):

| Off | Type | Field | Encoding |
|---|---|---|---|
| +0 | u16 | id | EntityManager id |
| +2 | u8 | type | enum: 1 player, 2 zombie, 3 skeleton, 4 creeper, 5 spider, 6 enderman, 7 cow, 8 pig, 9 sheep, 10 chicken, 16 item, 17 arrow, 18 fallingBlock, 19 primedTnt, 20 xpOrb, 21 thrownProjectile; 32–63 reserved for expansions (12 villager=32, 13 bosses=48+, 10 nether mobs=40+) |
| +3 | i8×2 | dcx, dcz | entity chunk minus anchor (interest ⊆ ±8 chunks; ±127 headroom) |
| +5 | u16 | relX | `(x − ecx×16) × 2048` — 0.49 mm steps |
| +7 | u16 | relY | `y × 256` — 3.9 mm steps, y ∈ [0,128) |
| +9 | u16 | relZ | as relX |
| +11 | i8×3 | velX/Y/Z | `vel × 32`, clamp ±3.96 b/t (terminal velocity fits) |
| +14 | u8 | yawQ | `yaw/(2π) × 256` (1.4°) |
| +15 | i8 | pitchQ | `pitch_deg/90 × 127` |
| +16 | u8 | flags | bit0 onGround, 1 sprinting, 2 sneaking, 3 burning, 4 swinging (arm), 5 gliding (11), 6 hurt (`hurtTime>0`), 7 dead |
| +17 | u8 | stateByte | per type: creeper swell 0–30; sheep bit0 sheared + bits1–4 color; zombie bit0 baby; item render-count bucket 1–4; player bit0 sleeping, bit1 eating; villager profession (12); else 0 |
| +18 | u8 | health | `ceil(health)` clamp 255; 0 for non-living |

Non-keyframe snapshots include only entities whose quantized fields changed since the last snapshot sent to that client (position, vel, angles, flags, stateByte, health — compare post-quantization so idle entities cost zero). Keyframes (every 30th, 3 s) include the **entire** interest set; a client may garbage-collect any known entity absent from a keyframe `(approx safety net — entityDespawn is the primary removal path)`.

**0x03 `blockEdit` — 15 B, C→H.**

| Off | Type | Field |
|---|---|---|
| 0 | u8 | 0x03 |
| 1 | u8 | action: 0 break, 1 place |
| 2 | u16 | editSeq (per client, for debugging; not acked) |
| 4 | i32 | x |
| 8 | u8 | y |
| 9 | i32 | z |
| 13 | u8 | face 0–5 (01 §8.2 order) — host derives torch orientation etc. per 03 §16.4 |
| 14 | u8 | hotbarSlot — the slot the client used (place: identifies the block item; guards against in-flight hotbar switches) |

**0x04 `blockSet` — 4 B header + 11 B/record, H→C.** `u8 0x04, u8 dim, u16 count`, then per record `i32 x, u8 y, i32 z, u8 blockId, u8 state`. All world mutations in a tick batch into one frame per client (explosions, fluid steps, pistons (07), fire (15) — everything funnels through `World.setBlock`, which in host mode appends to the per-tick broadcast list, filtered per client interest).

**0x05 `chunkData`.** `u8 0x05, u8 dim, i32 cx, i32 cz, u32 lenB, bytes(RLE blocks), u32 lenS, bytes(RLE states), u32 lenBio(=256), bytes(biomes)`.

**0x06 `ping` — 9 B:** `u8 0x06, f64 clientNow`. **0x07 `pong` — 21 B:** `u8 0x07, f64 t0, u32 hostTick, f64 hostNow`.

### 3.5 JSON payload details

- `entitySpawn.static` per type: item → `{itemId, count, damage?}`; arrow → `{ownerId}`; fallingBlock → `{blockId}`; sheep → `{woolTint}`; player → `{playerId, name, hue, heldItemId}`; tnt → `{fuse}`; xpOrb → `{value}`; expansions append fields freely (clients ignore unknown keys — the forward-compat rule for the whole JSON layer).
- `playerState` is the ONLY channel for authoritative survival stats; the client HUD renders exclusively from it (plus predicted air bubbles between updates `(approx)` — air ticks are deterministic enough to lerp). It also carries `dead: true` to trigger the death screen (03 §20.5 visuals run client-side).
- All JSON messages are ≤ 2 KB except `welcome` (~3 KB) and `playerState` with inventory (~1.5 KB).

---

## 4. Client prediction, reconciliation & interpolation

### 4.1 Local prediction

The client simulates its own player every client tick with **03 §4's pipeline verbatim** — same constants, same order, real collisions against its replicated world — then sends the input frame. Mining (03 §15), placement prediction (§4.5), camera, bobbing, FOV all run locally: **your own movement never waits for the network** (Gambetta part II). The client's `Game.tick()` runs steps: input snapshot → predict own player → prediction bookkeeping → interpolation advance → particles/HUD. No world logic (01 §3 steps 4–7 are host-only).

### 4.2 Reconciliation (input ring + rewind/replay)

```js
const RING = 128;                       // 6.4 s of inputs
const RECONCILE_EPS = 0.01;             // m — below this, prediction accepted
const SNAP_DIST     = 0.25;             // m — above this, hard snap (no smoothing)
ring = new Array(RING);                 // {seq, frame, predPos, predVel}

clientTick():
  frame = captureInput(); frame.seq = nextSeq++ & 0xFFFF;
  tickPlayer(localPlayer, frame);                       // 03 §4, real physics
  ring[frame.seq % RING] = { seq: frame.seq, frame,
                             predPos: copy(localPlayer.pos),
                             predVel: copy(localPlayer.vel) };
  send(INPUT, frame);

onSnapshot(s):
  r = ring[s.lastInputSeq % RING];
  if (!r || r.seq !== s.lastInputSeq) {                 // ring overrun / post-teleport
    hardSnap(s.ownPos, s.ownVel); return;
  }
  err = dist(r.predPos, s.ownPos);
  if (err > RECONCILE_EPS) {
    const renderBefore = interpolatedRenderPos();
    localPlayer.pos = copy(s.ownPos);                   // rewind to authority
    localPlayer.vel = copy(s.ownVel);
    localPlayer.onGround = s.ownFlags & 1;              // medium flags re-derived next step
    for (seq = s.lastInputSeq+1; seqLE(seq, nextSeq-1); seq++) {   // replay unacked
      g = ring[seq % RING];
      tickPlayer(localPlayer, g.frame);                 // SAME physics, current world
      g.predPos = copy(localPlayer.pos); g.predVel = copy(localPlayer.vel);
    }
    if (err <= SNAP_DIST)
      renderOffset = sub(renderBefore, interpolatedRenderPos());   // §4.3 smoothing
    else renderOffset = ZERO;                           // hard snap: visible teleport
  }
  bufferRemoteEntities(s);                              // §4.4
```

Notes: `seqLE` compares with u16 wraparound. Replay cost = unacked count ≈ `RTT/50 + 2` physics steps (≈6 at 250 ms RTT, <0.05 ms total) — negligible. Divergence sources (why `err > 0.01` ever happens): host-applied knockback/damage, mob pushes (01 §13), a block edited under the client's feet before the `blockSet` arrived, input frames dropped by the host's jitter buffer. Health/hunger/air/fire are **never predicted** — `playerState` overwrites them (a hit registers visually when `hurt`/`playerState` arrives, RTT/2 late; accepted).

### 4.3 Correction smoothing

`renderOffset` is a render-only vector added to the camera/viewmodel position, decayed `renderOffset *= 0.85` per frame and zeroed below 1 mm — corrections ≤ 0.25 m dissolve over ~150 ms instead of popping. Game logic (raycasts, physics) always uses the true corrected position; only the eye lies briefly. `forceMove` (respawn/teleport/dim change) clears the ring, sets `nextSeq` fresh, zeroes `renderOffset`, and snaps hard.

### 4.4 Remote entity interpolation (players AND mobs — same path)

Per replicated entity the client keeps a ring of the last 12 snapshot samples `{tick, pos, vel, yaw, pitch, flags, stateByte, health}`.

```
INTERP_DELAY = 100 ms   (= 2 snapshot intervals @10 Hz — Valve's cl_interp shape)
EXTRAP_MAX   =  50 ms   (vs Source's 250 ms; our mobs change direction too often)

renderTimeTarget = newestSnapshotTime − INTERP_DELAY        // host-clock ms (§7.1)
interpTime += frameDelta;                                    // advances at 1×
interpTime += (renderTimeTarget − interpTime) * 0.05;        // soft re-anchor, absorbs jitter

for each puppet:
  find samples s0, s1 with s0.time ≤ interpTime ≤ s1.time
  → pos = lerp(s0.pos, s1.pos, u); yaw = lerpAngleShortest(...); flags from s1
  if interpTime > newest.time:                               // stall / HOL blocking
      dt = min(interpTime − newest.time, EXTRAP_MAX)
      pos = newest.pos + newest.vel × dt/50; beyond that → freeze in place
```

Puppets (`RemotePlayer.js` + a thin `MobPuppet` mode on the 05 mob classes) run **no physics and no AI** — `updateRender` drives 05 §16.3 animations from interpolated state: limb swing rate from `|vel|`, sneak/sprint pose from flags, arm swing on flag-bit4 toggle, red tint while flag-bit6, burning overlay from bit3, death anim on `entityDespawn(reason:'died')` or flag-bit7. Item/arrow/orb puppets reuse their base visuals with interpolated transforms. Snapshot `vel` exists purely to feed extrapolation + animations.

### 4.5 Client-predicted world edits

Break/place apply **instantly** to the client's local world (same-frame remesh per 01 §4.5) and simultaneously send `blockEdit`. The host's answering `blockSet` broadcast is idempotent on success (01 §4.6 step-2 early-out → no flicker). On rejection the host sends a targeted `blockSet` carrying the true cell content → the client's world self-heals (block "pops back", drops it predicted never existed — item drops are NEVER predicted; they arrive as `entitySpawn` ~RTT later, the one visible mining latency `(approx)`). Client-side mining progress/cracks use the client's replicated inventory for tool speed — identical formula, so timing matches the host's expectation. Doors predict their open/close state toggle; buckets, fire, TNT ignition do NOT predict (fluid/fire sim is host-only) — they go through `useBlock` and feel RTT-delayed.

---

## 5. Host simulation with N players

### 5.1 Amended tick order (01 §3)

| # | Step | Delta from base |
|---|---|---|
| 1 | `input.snapshot()` | unchanged (local player) |
| **1.5** | `net.drainInbound()` | decode frames; refresh each remote player's input queue; queue edit/use/attack requests; handle handshakes/pings (pong sent immediately, not batched) |
| 2 | **all player entities tick** | local first, then slot order; each `tickPlayer(p, inputFor(p))` per 03 §4 — remote players' exhaustion, air, fire, fall damage etc. all compute host-side from host sim |
| **2.5** | `net.applyRequests()` | block edits (validate → `World.setBlock`), useBlock (03 §16.1 dispatch), attacks (§7.3), drops, container clicks (§6) — in arrival order |
| 3–7 | entities, scheduled ticks, random ticks, dayNight, mobSpawner | unchanged logic; player-distance predicates per the §Amendments (nearest player / union) |
| 8 | `chunkManager.tick()` | + per-client chunk streaming cursors (§2.3) |
| 9 | `saveManager.tick()` | unchanged (host-only) |
| **9.5** | `net.outboundTick()` | every 2nd tick: build+send per-client snapshots; flush blockSet batches + JSON event queues; 1 Hz playerList; timeSync every 100 ticks |

### 5.2 Remote player entities & input queues

Each connected client owns one host-side `Player` entity (03), fed by a per-client input queue:

- Target queue depth **2** (100 ms jitter buffer). Per tick: pop the oldest frame and apply it; record its `seq` as `lastInputSeq` for the next snapshot header.
- Queue empty (late/stalled packets): **reuse the last frame** (buttons are hold-state, so the player keeps walking through a one-frame gap — the standard choice). Empty > 20 ticks (1 s): zero the buttons (the player halts rather than sprinting into a cave unmanned) and flag `lagging` in `playerList`.
- Queue > 4 (client burst after a stall): drop oldest down to 2. Dropped frames cause a small reconciliation correction on that client — by design, corrections are the universal repair path.
- Yaw/pitch from the applied frame drive that entity's look (mob stare checks, arrow aim, `useHeld` eating/bow per 06 §12.4 / 05 §11 — bow release = `useHeld` bit falling edge). `hotbar` selects held item (equip broadcast on change).
- Remote players are full `LivingEntity` participants: mobs collide with, target, and hit them identically to the host player.

### 5.3 Interest sets

Per client, recomputed when they cross a chunk border (and every 20 ticks):

| Set | Rule |
|---|---|
| Chunk interest | Chebyshev ≤ 8 chunks around their player chunk, current dim — drives chunk streaming (§2.3) and `blockSet` filtering |
| Entity interest | same dim, entity chunk within Chebyshev ≤ 6 (96 m) — sorted by squared distance, **cap 64**; all player entities rank first regardless of distance cap (players never vanish from the radar within 96 m); own entity excluded (it lives in the snapshot header) |
| Keep-alive | host chunk streaming/sim radii use union over players (§Amendments) — a chunk stays loaded while ANY player needs it; `UNLOAD_RADIUS` measures distance to the nearest player |

Interest transitions emit `entitySpawn` (with full static+dynamic state) on entry and `entityDespawn{reason:'range'}` on exit.

### 5.4 Mobs with N players

Covered by the 05 amendments: nearest-player targeting/despawn/sim-range, round-robin spawn waves, `HOSTILE_CAP = 40/60/80/100`. XP orb magnets pull toward the nearest player within 7.25 (05 §15). Worst case host AI load = 100 hostiles with 8 spread-out players — pathfinding budget note in §11.

### 5.5 Sleep (SLEEP_PERCENT = 100)

Bed use arrives as `useBlock`; the host runs 04 §14.1–14.2 per player (monster check around THAT bed). Sleeping players' entities lie in bed (flags bit — stateByte bit0), input buttons ignored except sneak = leave bed. When ALL connected players have `bedTicks ≥ 100` → 04 §14.3 skip fires once (time jump, weather reset, spawn points already set on entry), everyone is ejected, `timeSync` broadcasts immediately. Any player leaving a bed resets nothing for others (their own timer keeps counting while they remain).

### 5.6 Conflicts & races (host order wins)

| Race | Resolution |
|---|---|
| Two clients edit the same block in one tick | requests execute in arrival order; the second fails validation (cell no longer matches: break-of-air / place-into-occupied) → targeted revert `blockSet` to the second sender only. No tombstones, no CRDTs — TCP ordering + single-threaded host IS the arbiter |
| Edit vs fluid/gravity update same tick | tick order: client edits apply at step 2.5, world updates at step 4 — edits win the tick, physics reacts next tick |
| Item pickup, two players overlap same tick | host scans in slot order → lowest slot wins (deterministic); loser's predicted nothing (pickup is never predicted); winner sees the item fly via `entityDespawn` + `playerState` inventory delta |
| Container double-open | both may view (chest screens multicast slot updates §6); clicks serialize in arrival order |
| Same-cell placement by host player vs client | host player's edit applies inside step 2 (synchronous, 01 §4.6), client's request at 2.5 → host wins |
| Attack on an entity that died this tick | request validation checks `dead` → silently ignored |

---

## 6. Inventory & containers over the network

Authoritative inventories (player 36+4+cursor, chest 27, furnace 3) live host-side. Clients hold a replicated copy of their OWN inventory (`playerState`) — needed for held-item rendering, mining speed, placement prediction — and a per-session view of any open container.

Flow (AMENDS 06 §14):

```
C→H containerOpen? — no: opening rides useBlock (RMB chest/table/furnace).
H validates (reach 4.5, block still there, not exploded) →
H→C containerOpen { windowId (u8, host counter), type:'chest'|'furnace'|'crafting'|
                    'inventory'|... , pos, slots:[{id,count,damage}...] }
C opens the 06 screen bound to windowId.

C→H containerClick { windowId, actionId (u16 counter), slotIndex, button:0|1,
                     mode:'click'|'shift'|'double'|'number'|'dropOne'|'dropStack', num? }
H applies 06 §14.2 exactly → H→C containerResult { actionId, cursor:{...},
                     changed:[{slot, stack}...] }          // to the clicker
                 → H→C containerSlot { windowId, slot, stack }  // to OTHER viewers
C on containerResult: compare with its predicted outcome; mismatch → overwrite
  cursor + affected slots with host values (visual rollback, no re-prediction).

C→H containerClose { windowId } → host runs 06 §14.1 return rules (craft grid/cursor
  back to inventory, overflow drops at the player). Host force-closes viewers with
  containerClose if the container block is destroyed.
```

- The client predicts every click with the same 06 §14.2 table for zero-latency cursor feel; `actionId` matching makes rollback exact. Prediction never *creates* items — a desync just snaps the screen to truth.
- Furnace progress (`burn/fuelTotal`, `cook/200`) streams as `containerSlot`-style `containerState {windowId, burn, fuelTotal, cook}` at 2 Hz **only while someone views it** `(approx — no global furnace gauge replication)`.
- Crafting: the 2×2/3×3 grid lives in the host-side window; result computation, shift-craft-max, recipe matching — all host code paths from 06 §9–10 untouched.
- Chest lid visual + "in use" state: host broadcasts `blockSet`-independent `sound`/state via containerOpen/Close to viewers only `(approx — distant lid animations skipped)`.
- Trades (12-VILLAGES) and enchanting (08) declare new `type` strings and reuse this window plumbing unchanged (§12).

---

## 7. Latency, clocks & combat

### 7.1 RTT & clock offset

Client sends `ping` 1 Hz; host replies `pong` immediately. `rtt = now − t0` (EWMA, α = 0.2). `hostClockOffset = (hostNow + rtt/2) − now` (EWMA α = 0.1). Snapshot times map to client clock as `hostTick × 50 + hostEpochOffset`; the interpolation anchor (§4.4) consumes this. Host tracks each client's RTT from its own perspective too (relayed in `playerList` for the Tab overlay).

### 7.2 Input delay compensation: NONE (decision)

The client predicts immediately; the host applies inputs on arrival (~RTT/2 late in host time). There is no server-side input delay, no client-side artificial delay, and no lockstep. **State-error window math:** a host-side impulse the client didn't predict (knockback `0.9 b/t`, mob push) goes uncorrected for `RTT + jitterBuffer(100 ms)`; positional error at correction ≈ `Δv × ticks × friction-decay` — at 200 ms RTT (4 ticks + 2 buffer): `0.9 × 6 × ~0.55avg ≈ 3.0 m` → hard snap. At 60 ms LAN: `0.9 × 3 × 0.6 ≈ 1.6 m` → still a snap on knockback; ordinary walking mispredicts stay under 0.01 m and never correct. Getting hit is the one rubber-band moment in the design — accepted and stated.

### 7.3 Combat validation (host-side, no lag compensation)

Client `attack {targetEntityId}` claims a melee hit on what it SAW (its 3.0 m targeting per 05 §13.3 against interpolated puppets, which run 100 ms + RTT/2 behind host truth). Host validation, using **its own current positions**:

```
valid = target exists && !target.dead
     && distance(attacker.eye, closestPointOnAABB(target)) ≤ 4.5 + 0.5   // slack
     && raycast(attacker.eye → target) not blocked by opaque blocks
on valid: damage = 05 §13.1–13.4 with host-tracked cooldown t (host ticks since that
          player's last attack/item switch), crit from host-side vy/onGround,
          knockback along attacker→target; sprint-knockback per 05 §14.3.
on invalid: silently ignored (client already played its swing).
```

> Adaptation: no lag-compensated rewind (Source-style position history is rejected — it needs per-tick pose archives for every entity and re-collision in the past; disproportionate for 8-player co-op vs mobs). Instead the reach test is deliberately generous: **4.5 + 0.5 m** (vs the client's 3.0 m targeting rule) absorbs interpolation delay + prediction divergence — a target sprinting at 5.6 m/s moves ≈ 1.1 m during a 100 ms interp + 100 ms transit window, well inside the slack. PvP is possible but tuned for PvE honesty, not esports.

Arrows: host-simulated entirely (charge from `useHeld` duration, spawn, flight, hit — 05 §11); the shooter sees their own arrow ~RTT/2 late `(approx, accepted)`.

**Expected feel by ping (document in the pause menu's Connection panel):**

| RTT | Own movement | Mining/placing | Combat |
|---|---|---|---|
| ≤ 30 ms (LAN) | perfect | instant; drops appear ≤ 60 ms | crisp; knockback correction imperceptible |
| ~100 ms | perfect | instant place/break; drops ~120 ms | hits reliable; ~1.5 m rubber-band when YOU get hit |
| ~200 ms | perfect between hits | fine; rare revert pops on contested blocks | lead moving targets slightly; ~3 m snap on received knockback; playable |
| ≥ 300 ms | corrections noticeable | container clicks feel sticky | not recommended (state in UI when RTT > 250 sustained: "poor connection" icon) |

---

## 8. Multiplayer UI

### 8.1 Title screen flows (AMENDS 01 §15.3 menus)

```
TITLE ─ Singleplayer (unchanged base flow)
     ├─ Host Game  → world select/create (base UI) → connect relay → LOADING (world)
     │              → PLAYING + persistent top-right badge: "Code: KF3PQX ⧉" (click = copy)
     │              relay URL field (default ws://localhost:8971, persisted localStorage)
     └─ Join Game  → { name, code (6-char, auto-uppercase), relay URL } → CONNECTING
                    → progress bar (chunks 0/121 → meshing) → PLAYING
Errors (relay down / bad code / full / version / dupe) → message + Back. Query params
?relay=…&join=CODE prefill and auto-join (dev affordance, §13).
```

Disconnect handling: client loses socket → modal "Connection lost — Reconnect / Title" (Reconnect re-runs the §2.2 handshake; the host treats it as a rejoin). Host loses relay → badge turns red "Relay lost — session ended", clients already got `hostGone`; host keeps playing solo, world intact.

### 8.2 Player list (Tab) & nameplates

- Hold `Tab`: centered translucent panel listing name, ping (from `playerList`), dim badge, sleeping/lagging icons. Host row marked ⌂.
- Nameplates: 128×32 offscreen canvas (name, monospace, black outline) → `THREE.Sprite` 0.6 m wide, 0.4 m above the head, `depthTest: true` (occluded by walls — decision `(approx vs MC's through-wall dim pass)`), hidden when > **48 m** or target sneaking, fades with entity `lightScalar`.

### 8.3 Chat overlay (AMENDS 01 §15.3)

Bottom-left DOM column, max **10 lines**, each line fades out after 10 s (opacity transition; history retained). `T` focuses the input row (pointer lock KEPT — typing needs no mouse; decision), `Enter` sends (≤200 chars, rate 3/s client-enforced + host-enforced), `Escape` closes. All text inserted via `textContent` (no HTML injection). System lines (`{from:null}`): joins/leaves, deaths ("<name> was slain by Zombie" — source string from the 05 damage source), sleep status, host countdown. While chat is focused the input frame's buttons = 0 (the player stands still and blinks, as is tradition).

### 8.4 Remote player rendering

Base has no player model (03 §2.3) — this expansion adds one (see Amendments): humanoid box model on 05 §16.1's part system (head/body/arms/legs, 0.6×1.8), skin painted by a `tilePainters`-style routine into a small per-player canvas: base humanoid recipe (skin tone, shirt, trousers) with **hue = xmur3(playerId)() mod 360** applied to shirt+trouser layers — deterministic on every machine with zero skin data on the wire. Held item rendered in the right hand (mini-cube/flat quad reusing ItemEntity visuals, driven by `equip`); armor tier tints shoulder/chest pixels `(approx — no separate armor overlay meshes)`. Walk/sneak/swing animations per §4.4. The local player remains unrendered first-person.

---

## 9. Host lifecycle & persistence

### 9.1 Saving

Autosave is UNCHANGED (01 §16.2: every 600 ticks, meta + modified chunks) and host-only, now writing `meta.players` for every known playerId (connected: live state; disconnected: last-seen state). Clients save nothing but localStorage identity/settings. `visibilitychange→hidden` on the HOST autosaves but does NOT pause while clients are connected (per the §Amendments pause rule — beware: a fully backgrounded Chrome tab throttles rAF; the host shows a warning toast "backgrounding the host degrades the session" after 2 s hidden `(approx mitigation; setInterval fallback ticking is out of scope)`).

### 9.2 Host quit & client death tolerance

- Host "Save & Quit": broadcast `hostShutdown {seconds:3}` → clients show a 3-2-1 countdown overlay (input stays live) → host autosaves (awaited) → relay room closes → clients to TITLE "Host ended the session."
- Host tab killed: relay heartbeat detects ≤ 10 s → `hostGone` → clients to title. World state = last autosave (≤ 30 s loss, same guarantee as single player).
- **Host migration: OUT OF SCOPE (stated).** The world lives in the host's IndexedDB; no other peer has chunks, entity state, or save history. A migration would be a full world upload + authority handover — v2 territory at best.
- Client disconnect/crash: host broadcasts `playerLeave`, despawns the entity (no death — inventory intact), snapshots their record into `meta.players` immediately. Rejoin per §2.4 restores them in place. A client crashing mid-container-interaction: host force-closes the window with normal 06 §14.1 return rules.

---

## 10. Security & trust model

**Friends-only trust. There is NO anti-cheat (stated, deliberate):** clients self-report mining completion and melee claims; a modified client could speed-mine or teleport-mine within reach. The host validates only *physics-plausibility-free* invariants (reach, rate, existence, gamemode) to keep honest clients consistent — not to defeat hostile ones. Do not run public rooms.

The relay validates exactly: room membership (frames from sockets not in a room are dropped), capacity (8), and the caps below. It cannot read game state (payloads are opaque) and holds no persistent data.

| Cap | Value | Enforced by | On violation |
|---|---|---|---|
| Max frame size, client→relay | 16 KB | relay `maxPayload` check per sender slot ≠ 0 `(approx: single 256 KB maxPayload + relay-side length check for client slots)` | close socket |
| Max frame size, host→relay | 256 KB | relay maxPayload | close socket |
| Client message rate | 100 msgs/s (token bucket 200) | relay | close socket |
| blockEdit / useBlock rate | 10/s each (20/s in debugCreative) | host | targeted revert; excess silently dropped |
| chat | 200 chars, 3/s | client + host | dropped |
| attack rate | 10/s | host | dropped |
| Joins per room | 8 total; 10 join attempts/min/IP | relay | `{t:'err'}` |
| Rooms per relay | 64; idle room (0 sockets) reaped immediately, host-only room after 4 h | relay | close |
| hello sanity | name regex, playerId UUID format, JSON ≤ 2 KB | host | reject |

Host-side decode is defensive: every binary message length-checks before `DataView` reads; malformed frame → disconnect that client. `gameMode` is host-assigned (clients request F4 debugCreative via `chat` command `/debug` → host toggles ONLY if `constants.ALLOW_CLIENT_DEBUG = true`, default false).

---

## 11. Performance & bandwidth budgets

| Metric | Budget | Expected |
|---|---|---|
| Snapshot encode+send, host, 8 players | ≤ 1 ms/tick | ~0.3 ms (7 clients × ≤64 records × ~14 DataView writes into one reused 16 KB scratch buffer; zero allocation steady-state) |
| Aggregate snapshot payload @ 8 players | ≤ 8 KB per snapshot round | typical 7 × ~450 B ≈ 3 KB; worst (7 keyframes coinciding — phase-stagger keyframe indices per client so they never do) ≤ 7 × 1.26 KB |
| `net.drainInbound` | ≤ 0.5 ms/tick | ~0.1 ms (7 × 20 Hz inputs + events) |
| Host tick total @ 8 players, 100 hostiles | ≤ 12 ms (vs 10 base) | pathfinding is the risk: 05's repath cadence caps A* calls; if tick p95 > 12 ms, halve `HOSTILE_CAP` (log once) `(approx safety valve)` |
| Host loaded chunks (8 players spread out) | ≤ 1600 chunks (~205 MB at 128 KB) | if exceeded: reduce per-player `GENERATE_RADIUS` 9→7 and stream radius 8→6 until under (log) |
| Interest set | ≤ 64 entities/client; players always included | — |
| Chunk stream | ≤ 6 chunks/tick/client, ≤ 12/tick total | join transfer ≈ 121 × ~4 KB ≈ 0.5 MB in ~2–4 s |
| Client added cost | ≤ 1 ms/frame | interp update ≤64 puppets + one decode |

Bandwidth (steady-state, excluding join bursts; WS frame overhead included `(approx)`):

| Players (host+clients) | Host up | Host down | Per client up / down |
|---|---|---|---|
| 2 (1 client) | ~6–15 KB/s | ~0.6 KB/s | 0.6 KB/s / 6–15 KB/s |
| 4 | ~20–45 KB/s | ~2 KB/s | same per client |
| 8 | ~45–105 KB/s | ~4.5 KB/s | same per client |

Every figure fits a phone hotspot; the design goal is CPU headroom on the host, not bytes.

---

## 12. Expansion interop

The protocol carries sibling expansions without new transport concepts: **all new sims are host-only; clients receive the same block/state/entity/event streams.**

| Expansion | Interop contract (one line each) |
|---|---|
| 07 Redstone | wire/piston/door state changes are ordinary `blockSet` records (id+state); zero redstone-specific messages; client never simulates circuits |
| 08 Enchanting | enchanting table = container window `type:'enchant'`; option rolls host-side; enchanted item data rides the stack `{id,count,damage,ench?}` in container/playerState payloads |
| 09 Potions | `effects[]` replicates in `playerState` (own HUD) and as a stateByte particle bit on entities `(approx: visible swirls, not per-effect color)` |
| 10 Nether | every chunk key/`chunkData`/`blockSet` already carries `dim u8` (0 overworld, 1 nether, 2 end); portal transit = host-side logic → `dimChange` → client streams the new dim per §2.3; snapshots only ever contain the client's current dim |
| 11 End | elytra glide = snapshot flags bit5 (puppet pose); dragon = boss entity type + `bossBar` messages |
| 12 Villages | villagers are entity types 32+ in snapshots (profession in stateByte); trading = container window `type:'trade'` with 06-style click ops |
| 13 Bosses | boss HP/phase UI via `bossBar {id,name,hpFrac,style}` (precise HP never squeezed into the u8 health field); spawn ceremonies are `sound` + `entitySpawn` |
| 15 Fire/Waterlogging | spread/extinguish are host `blockSet` storms — already batched per tick; waterlogged flag lives in the state byte that `blockSet`/`chunkData` already ship |
| 16 Audio | host-emitted world sounds relay as `sound {name,x,y,z}` (names opaque to this file); client-predicted personal sounds (own steps, UI clicks, own mining) play locally, never wired |

---

## 13. Dev & test guide

- **Two-tab local test:** `npm run relay` + `npm run dev`; tab A: Host Game; tab B: normal + incognito window (separate localStorage → distinct playerId) → Join with the code, relay `ws://localhost:8971`. URL affordance: `http://localhost:5173/?relay=ws://localhost:8971&join=KF3PQX&name=Dev2` auto-joins on load.
- **Artificial latency knob:** `npm run relay -- --delay 100` (adds 100 ms each way → RTT ≈ 200 ms), `--jitter 30` adds 0–30 ms uniform. Test matrix: 0 / 100 / 100+jitter30.
- **F3 additions (both roles):** role + slot, RTT, clock offset, in/out KB/s (1 s window), corrections/min + last correction magnitude, interp buffer depth (ms), snapshot size last/avg, input queue depth (host, per client), streamed-chunk backlog.
- **Console hooks (dev builds):** `game.net.stats()`, `game.net.dropNext(n)` (client: skip sending n inputs — forces reconciliation), `game.net.fakeLag(ms)` (client-side outbound delay).
- Deterministic textures mean screenshots from host and client of the same scene must match pixel-wise except entities mid-interpolation — a cheap visual regression check.

---

## Acceptance checklist

Protocol & session:
- [ ] `npm run relay` starts on 8971; host shows a 6-char code; a second browser joins by code and reaches PLAYING in ≤ 10 s on localhost with a loading bar that visibly tracks 121 chunks then meshing.
- [ ] Version skew (bump `PROTO_VERSION` on one side) → clean "version mismatch" screen, no hang; wrong/full/dead codes → readable errors.
- [ ] 8 total players connect; a 9th is refused with "room full".
- [ ] Kill a client tab: host chat shows the leave line within 10 s (heartbeat), its entity despawns, no host errors; rejoin with the same browser profile restores position, inventory, XP, and bed spawn exactly (verified after host autosave + full host restart too).
- [ ] Host "Save & Quit": clients get a 3 s countdown then land on the title screen; reloading the host world restores every connected player's record in `meta.players` (inspect IndexedDB: `meta.version === 2`).

Prediction & sync:
- [ ] With `--delay 100`, own walking/jumping/sprinting feels identical to single player (no rubber-banding while unhurt); F3 shows corrections ≈ 0/min while solo-roaming.
- [ ] Getting melee-hit at `--delay 100` produces exactly one visible correction (snap ≤ ~3 m) and consistent final position on both screens.
- [ ] Remote players/mobs move smoothly (no teleport-stutter) at 0 and 100 ms delay; unplugging the relay for 300 ms freezes puppets after ≤ 50 ms extrapolation, then they catch up without desync.
- [ ] Two players mining the same block: one gets it, the other sees an instant revert + no drop duplication; item dropped between two players is picked up by exactly one.
- [ ] Block edits by either player appear on the other's screen ≤ RTT + 100 ms; a client placing water via bucket sees host-simulated flow arrive as blockSets.
- [ ] Chest opened by two players simultaneously: both see live slot updates; shift-click storms produce no item duplication or loss (count audit before/after).

Gameplay parity (the demo bar):
- [ ] Two players together: mine, build a shelter, fight a night wave (mobs split targets between them — observe a zombie switching to the nearer player), trade items via chest, both sleep → night skips ONLY when both are in bed ("1/2 players sleeping" shown otherwise).
- [ ] A skeleton kills a client: death screen on that client, death chat line for all, drops at the death point; Respawn returns them at their bed with 20 HP.
- [ ] With 10-NETHER installed: both players portal to the Nether together — the traveling client streams nether chunks, the staying client keeps playing the overworld; snapshots never leak cross-dim entities.
- [ ] Nameplates render above remote players, hide beyond 48 m and while sneaking; Tab lists names + pings; chat lines fade after 10 s; `T` typing never moves the player.
- [ ] 200 ms simulated RTT (`--delay 100`): full survival loop remains playable per the §7.3 feel table — mining/building unaffected, combat requires slight lead, no desync accumulates over 30 min.
- [ ] Host F3 tick time ≤ 12 ms with 4 clients + 60 hostiles; per-client snapshot avg ≤ 1 KB; host uplink ≤ 105 KB/s at 8 players (F3 net counters).
- [ ] Solo host (no clients) behaves byte-identically to base single player: pause freezes, saves match, zero net overhead (NetHost dormant).
