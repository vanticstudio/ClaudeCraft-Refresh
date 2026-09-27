// Every engine tunable lives here (01 §2). Gameplay numbers owned by other
// spec files stay in their owning modules; these are the engine-level knobs.

// --- Core loop (01 §3) ---
export const MS_PER_TICK = 50;            // 20 TPS
export const TPS = 20;
export const MAX_TICKS_PER_FRAME = 5;     // catch-up cap

// --- World dimensions (01 §4) ---
export const WORLD_HEIGHT = 128;          // y ∈ [0, 127]
export const MAX_Y = 127;
export const SEA_LEVEL = 63;
export const WORLD_BORDER = 1_000_000;    // ±blocks, physics clamp + generator refusal
export const CHUNK_SIZE = 16;
export const CHUNK_CELLS = 16 * 128 * 16; // 32768

// x,z ∈ [0,15], y ∈ [0,127] → i ∈ [0, 32767]  (Y-major, 01 §4.2)
export const blockIndex = (x, y, z) => (y << 8) | (z << 4) | x;
export const chunkKey = (cx, cz) => cx + ',' + cz;

// --- Streaming radii (01 §4.3) ---
// UPDATE-polish §5 — RENDER_RADIUS is runtime-adjustable (settings slider 4–16).
// `let` + ESM live bindings: every importer reads the current value inside its
// methods, so setRenderRadius takes effect on the next chunk tick / fog frame.
// GENERATE (+1) and UNLOAD (+3) keep their base ratios; SIM_RADIUS is gameplay
// range and deliberately stays fixed at 6 (UNLOAD ≥ SIM+1 holds at minimum 4).
export let GENERATE_RADIUS = 9;
export let RENDER_RADIUS = 8;
export const SIM_RADIUS = 6;
export let UNLOAD_RADIUS = 11;
export function setRenderRadius(r) {
  // OVERHAUL §B — slider widened to 4–20. All per-frame/per-tick costs stay
  // budget-clamped, so high radii degrade gracefully (longer streaming fills,
  // not frame spikes). Fog derives from RENDER_RADIUS per frame in DayNight.
  RENDER_RADIUS = Math.max(4, Math.min(20, r | 0));
  GENERATE_RADIUS = RENDER_RADIUS + 1;
  UNLOAD_RADIUS = RENDER_RADIUS + 3;
  return RENDER_RADIUS;
}
export const WORKER_COUNT = 2;
// OVERHAUL §W — meshing pool: chunk meshing moves off the main thread into its
// own worker pool (terrain gen already has WORKER_COUNT workers). Sized from
// hardwareConcurrency with a sane floor; the main-thread synchronous path
// (player edits) is kept for zero-latency feedback and as a fallback.
export const MESH_WORKER_COUNT =
  (typeof navigator !== 'undefined' && navigator.hardwareConcurrency > 4)
    ? Math.min(4, Math.max(2, (navigator.hardwareConcurrency - 2) >> 1))
    : 2;
// 01 §9 — a terrain worker that never reports `ready` (blocked Worker
// constructor, a throw inside its init branch) used to park the player on
// "Building terrain…" forever with nothing able to observe it. ChunkManager arms
// this as a watchdog on initWorkers and clears it on the ready message; it is
// deliberately generous, since a cold first generate on a slow machine is slow.
export const WORKER_READY_TIMEOUT_MS = 20000;
export const MAX_JOBS_IN_FLIGHT = 24;
// OVERHAUL §W — background remeshing now drains through the worker pool; the
// main-thread budget only governs the synchronous fallback + player edits.
export const REMESH_FRAME_BUDGET_MS = 3;
export const REMESH_FRAME_MAX = 2;
export const INITIAL_MESH_PER_TICK = 8;   // during LOADING screen (01 §4.4)

// --- Atlas (01 §7) ---
// OVERHAUL §A — HD texture pack: 32px tiles on a 32×32 grid, each tile padded
// with a GUTTER of edge-replicated texels so the mipmap chain can blur across
// cell boundaries without bleeding into neighbours (MC-style mipmapping with
// atlas padding). ATLAS_SIZE = ATLAS_COLS × CELL; uv rects in atlas.js always
// address the inner TILE_PX² region, never the gutter.
export const TILE_PX = 32;
export const ATLAS_GUTTER = 4;
export const ATLAS_CELL = TILE_PX + ATLAS_GUTTER * 2;   // 40
export const ATLAS_COLS = 32;             // 32×32 grid of 40px cells → 1280²
export const ATLAS_SIZE = ATLAS_COLS * ATLAS_CELL;

// --- Lighting (01 §10, 04) ---
export const MAX_LIGHT = 15;
export const LIGHT_NODE_BUDGET = 100_000; // safety valve per onBlockChanged (01 §10.3)
export const AMBIENT_FLOOR = 0.04;        // 04 §11.1

// --- Save (01 §16) ---
export const AUTOSAVE_INTERVAL = 600;     // ticks (30 s)
export const DB_NAME = 'mc-world';
export const DB_VERSION = 1;
// v2 (10-NETHER §2.4): chunk keys are dim-prefixed "<dim>:cx,cz"; meta gains
// player.dimension + meta.dimensions. The v1→v2 migration (saveManager.open)
// preserves the player and clears the chunk store — the overworld regenerates
// deterministically from the same seed (player builds in it are lost; a testing
// env, per DEVIATIONS).
// v3 (14-MULTIPLAYER §2.4 / AMENDS 01 §16): meta.player → meta.players keyed by
// playerId; the v2→v3 migration wraps the old single player under the host id
// (NON-destructive, chunks untouched). The spec's "version becomes 2" is realised
// as 2→3 because E7 already occupied v2 — the single-bump rule (§8.5) is preserved.
export const SAVE_VERSION = 3;

// --- Multiplayer (14 §2, §5, §11) ---
export const PROTO_VERSION = 1;                // wire-format version (mirrors net/protocol.js)
export const DEFAULT_RELAY_URL = 'ws://localhost:8971';
export const JOIN_RADIUS = 5;                  // 11×11 = 121 chunks streamed before spawn (§2.2)
export const STREAM_RADIUS = 8;                // per-client chunk interest / stream radius (§2.3)
export const ENTITY_INTEREST_RADIUS = 6;       // Chebyshev chunks, 96 m (§5.3)
export const INTEREST_ENTITY_CAP = 64;         // entities/client snapshot cap (§5.3)
export const CHUNKS_PER_TICK_CLIENT = 6;       // §2.3 stream budget
export const CHUNKS_PER_TICK_TOTAL = 12;
export const SNAPSHOT_INTERVAL = 2;            // build+send snapshots every 2nd tick = 10 Hz (§5.1)
export const KEYFRAME_INTERVAL = 30;           // every 30th snapshot = full interest set, 3 s (§3.3)
export const INPUT_QUEUE_TARGET = 2;           // per-client jitter buffer depth (§5.2)
export const SLEEP_PERCENT = 100;              // AMENDS 04 §14 — every connected player must be in bed
export const HOSTILE_CAP_BASE = 40;            // AMENDS 05 §3.2 — 40 + 20×(min(count,4)−1)
export const ALLOW_CLIENT_DEBUG = false;       // §10 — clients may not self-grant creative

/** AMENDS 05 §3.2 — global hostile cap scales with connected player count. */
export function hostileCap(playerCount) {
  return HOSTILE_CAP_BASE + 20 * (Math.min(Math.max(playerCount, 1), 4) - 1);
}

// --- Render (01 §1, §14) ---
export const CAMERA_FOV = 70;
export const CAMERA_NEAR = 0.05;
export const CAMERA_FAR = 1000;

// --- Input map (01 §15.1; e.code values) ---
export const KEYBINDS = {
  forward: 'KeyW',
  left: 'KeyA',
  back: 'KeyS',
  right: 'KeyD',
  jump: 'Space',
  sneak: 'ShiftLeft',
  sprint: 'ControlLeft',
  inventory: 'KeyE',
  drop: 'KeyQ',
  swapOffhand: 'KeyF',            // AMENDS 01 §15.1 (08 §7.2)
  chat: 'KeyT',                   // AMENDS 01 §15.1 (14 §8.3) — open chat
  playerList: 'Tab',             // AMENDS 01 §15.1 (14 §8.2) — hold for player list
  debugOverlay: 'F3',
  gameMode: 'F4',                 // AMENDS 01 §15.1 — was "debug creative toggle"
  hotbar: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
           'Digit6', 'Digit7', 'Digit8', 'Digit9'],
};

// --- Game mode (18 §1.1; AMENDS 01 §16.1 / 03 §2.4) ---
// Integer enum, persisted verbatim in the player record. Only these two exist:
// Adventure and Spectator are explicitly out of scope (18 §1.1). The values are
// stable — a future file may add Spectator without renumbering.
export const GameMode = { SURVIVAL: 0, CREATIVE: 1 };

/** 18 §1.2 — legacy save migration: pre-EC worlds stored a string. */
export function normalizeGameMode(v) {
  if (v === 1 || v === GameMode.CREATIVE) return GameMode.CREATIVE;
  if (v === 'creative' || v === 'debugCreative') return GameMode.CREATIVE;
  return GameMode.SURVIVAL;                       // 0, 'survival', or missing
}

// --- Game screen states (01 §15.2) ---
export const STATE = {
  TITLE: 'TITLE',
  LOADING: 'LOADING',
  CONNECTING: 'CONNECTING',   // 14 §2.2 — client join handshake + chunk stream
  PLAYING: 'PLAYING',
  PLAYING_UI: 'PLAYING_UI',
  PAUSED: 'PAUSED',
  DEAD: 'DEAD',
};
