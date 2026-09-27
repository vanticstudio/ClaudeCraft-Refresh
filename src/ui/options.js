// Persisted user options (16-AUDIO AMENDS 01 §15.3). Per-browser, NOT part of
// the IndexedDB save — settings survive world deletion.
//
// The full §15.3 shape is written today even though only master/music have a
// consumer (the §4A theme layer): ambient/sfx/ui/musicMode/mouseSensitivity/
// viewBobbing land with 16-AUDIO E1 and 03's settings, and writing the schema
// now means E1 never has to migrate a second time.
const KEY = 'claudecraft.options.v1';
const LEGACY_KEY = 'voxelcraft.options.v1';

export const DEFAULTS = Object.freeze({
  master: 100, music: 70, ambient: 100, sfx: 100, ui: 100,   // §15.3 sliders 0–100
  musicMode: 'menu',       // §4A: 'off' | 'menu' | 'full'
  mouseSensitivity: 1.0,   // 03 §18.1 — range 0.1–3.0
  viewBobbing: true,       // 03 §18.4
  // UPDATE-polish §5 — settings-tab additions. Creative mode is deliberately NOT
  // here: gameMode is per-world state persisted in the save (a global override
  // would corrupt survival worlds); the settings toggle drives the live player.
  renderDistance: 8,       // chunks, 4–20 — drives RENDER_RADIUS at runtime
  debugOverlay: false,     // F3 overlay state (F3 key stays a shortcut)
  // OVERHAUL §O — graphics options. fov is the base vertical FOV (sprint's
  // fovScale still multiplies); resolutionScale multiplies devicePixelRatio
  // (0.5–2.0) — the main smoothness lever on weak GPUs; brightness lifts the
  // light curve's ambient floor; mipmaps enable the HD atlas's mip chain;
  // particles scales every emitter's spawn count.
  fov: 70,                 // 60–110
  resolutionScale: 1,      // 0.5–2.0 (slider stores 50–200)
  brightness: 0,           // 0–100
  mipmaps: true,
  particles: 'all',        // 'all' | 'decreased' | 'minimal'
  // B3 §4 — screen shake on player damage / nearby explosions. DEFAULT OFF on
  // purpose (accessibility: forced camera motion is a vestibular trigger); the
  // DayNight camera offset only applies while this is true.
  screenShake: false,
  // B10 §1 — "Fancy graphics": bloom (lava/glowstone/portal/fire) + subtle
  // vignette + grade. OFF by default per spec; Game.render re-reads this per
  // frame (the screenShake pattern), so the toggle applies on the next frame.
  fancy: false,
});

export function loadOptions() {
  let raw = localStorage.getItem(KEY);
  if (raw == null) {
    const legacy = localStorage.getItem(LEGACY_KEY);   // §15.3 migration
    if (legacy != null) {
      raw = legacy;
      localStorage.setItem(KEY, legacy);
      localStorage.removeItem(LEGACY_KEY);
    }
  }
  try {
    return { ...DEFAULTS, ...JSON.parse(raw ?? '{}') };
  } catch {
    return { ...DEFAULTS };   // corrupt JSON → defaults, never throw at boot
  }
}

export function saveOptions(opts) {
  try {
    localStorage.setItem(KEY, JSON.stringify(opts));
  } catch (err) {
    console.warn('[options] cannot persist:', err.message);   // private mode / quota
  }
}

/** 16-AUDIO §1.2: bus gain is the squared slider — perceptual taper. */
export const busGain = slider => (Math.min(100, Math.max(0, slider)) / 100) ** 2;
