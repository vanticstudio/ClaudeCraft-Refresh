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
export const GENERATE_RADIUS = 9;
export const RENDER_RADIUS = 8;
export const SIM_RADIUS = 6;
export const UNLOAD_RADIUS = 11;
export const WORKER_COUNT = 2;
export const MAX_JOBS_IN_FLIGHT = 16;
export const REMESH_FRAME_BUDGET_MS = 6;
export const REMESH_FRAME_MAX = 4;
export const INITIAL_MESH_PER_TICK = 8;   // during LOADING screen (01 §4.4)

// --- Atlas (01 §7) ---
export const ATLAS_SIZE = 512;
export const TILE_PX = 16;
export const ATLAS_COLS = 32;             // 32×32 grid of 16px tiles

// --- Lighting (01 §10, 04) ---
export const MAX_LIGHT = 15;
export const LIGHT_NODE_BUDGET = 100_000; // safety valve per onBlockChanged (01 §10.3)
export const AMBIENT_FLOOR = 0.04;        // 04 §11.1

// --- Save (01 §16) ---
export const AUTOSAVE_INTERVAL = 600;     // ticks (30 s)
export const DB_NAME = 'mc-world';
export const DB_VERSION = 1;
export const SAVE_VERSION = 1;

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
  PLAYING: 'PLAYING',
  PLAYING_UI: 'PLAYING_UI',
  PAUSED: 'PAUSED',
  DEAD: 'DEAD',
};
