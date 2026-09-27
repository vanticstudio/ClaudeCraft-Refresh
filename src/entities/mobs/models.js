// Procedural mob box-models + canvas textures (05 §16.1–16.2). 1 px = 1/16 m.
import * as THREE from 'three';
import { mulberry32, xmur3 } from '../../math/rng.js';

const texCache = new Map();

function canvasTex(name, size, paint) {
  let t = texCache.get(name);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  paint(ctx, size, mulberry32(xmur3('mobtex:' + name)()));
  t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace;
  texCache.set(name, t);
  return t;
}

function hex2rgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function noiseFill(ctx, size, base, amp, rng) {
  const [r, g, b] = hex2rgb(base);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const f = 1 + (rng() * 2 - 1) * amp / 100;
      ctx.fillStyle = `rgb(${r * f | 0},${g * f | 0},${b * f | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

const px = (ctx, x, y, c, w = 1, h = 1) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };

// ---- texture-overhaul helpers ---------------------------------------------
// The original recipes were one noiseFill per body part: coherent-looking at a
// glance, but per-pixel RNG noise reads as TV static in motion, and flat bases
// go dead under the unlit material. Three cheap primitives fix both.

// Baked fake-AO gradient: every box face samples the SAME canvas on all six
// sides, so a light top / dark bottom gives each part dimensional shading.
// Drawn LAST so it sits over the pattern.
function vShade(ctx, s, top = 0.10, bottom = 0.16) {
  ctx.fillStyle = `rgba(255,255,255,${top})`;
  ctx.fillRect(0, 0, s, 2);
  ctx.fillStyle = `rgba(255,255,255,${top * 0.5})`;
  ctx.fillRect(0, 2, s, 1);
  ctx.fillStyle = `rgba(0,0,0,${bottom})`;
  ctx.fillRect(0, s - 3, s, 3);
  ctx.fillStyle = `rgba(0,0,0,${bottom * 0.5})`;
  ctx.fillRect(0, s - 4, s, 1);
}

// Coherent blotch clusters: short random walks stamp 1-2px cells, producing
// connected patches (cow markings, creeper camo, mottle) instead of static.
function blobs(ctx, s, rng, color, count, size = 3) {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    let x = (rng() * s) | 0, y = (rng() * s) | 0;
    const n = 1 + ((rng() * size) | 0);
    for (let j = 0; j < n; j++) {
      ctx.fillRect(x, y, 1, 1);
      if (rng() < 0.6) ctx.fillRect(x + 1, y, 1, 1);
      if (rng() < 0.3) ctx.fillRect(x, y + 1, 1, 1);
      x = (x + ((rng() * 3) | 0) - 1 + s) % s;
      y = (y + ((rng() * 3) | 0) - 1 + s) % s;
    }
  }
}

// 1px streaks along an axis: hair, wood grain, feather barbs, bone striations.
function streaks(ctx, s, rng, color, count, horiz, len = 4) {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    if (horiz) {
      ctx.fillRect((rng() * s) | 0, (rng() * s) | 0, 2 + ((rng() * len) | 0), 1);
    } else {
      ctx.fillRect((rng() * s) | 0, (rng() * s) | 0, 1, 2 + ((rng() * len) | 0));
    }
  }
}

// ---------------------------------------------------------------- texture recipes (05 §16.2)

// Exported for the smoke harness's U10 painter regression (stub-canvas run).
export const PAINT = {
  zombie_skin: (c, s, r) => {
    noiseFill(c, s, '#4f9e44', 9, r);
    blobs(c, s, r, '#3d7d34', 6, 4);            // mottled decay patches
    blobs(c, s, r, '#66b957', 4, 3);
    for (let i = 0; i < 3; i++) px(c, (r() * s) | 0, (r() * s) | 0, '#28401f');   // scabs
    vShade(c, s);
  },
  zombie_shirt: (c, s, r) => {
    noiseFill(c, s, '#2f8f8a', 9, r);
    blobs(c, s, r, '#25716d', 5, 4);
    for (let x = 0; x < s; x++) if (r() < 0.4) px(c, x, s - 1, '#1c4a47');        // torn hem
    vShade(c, s);
  },
  zombie_pants: (c, s, r) => {
    noiseFill(c, s, '#3b4f8a', 9, r);
    blobs(c, s, r, '#2e3f70', 5, 4);
    for (let x = 0; x < s; x++) if (r() < 0.3) px(c, x, s - 1, '#232f54');        // worn cuffs
    vShade(c, s);
  },
  zombie_face: (c, s, r) => {
    PAINT.zombie_skin(c, s, r);
    px(c, 3, 6, '#0c0c0c', 2, 2); px(c, 11, 6, '#0c0c0c', 2, 2);                  // sockets
    px(c, 6, 11, '#1a331a', 4, 1);                                                 // grim mouth
    px(c, 7, 10, '#d8d8c8'); px(c, 8, 10, '#c8c8b0');                              // teeth
  },
  skeleton_bone: (c, s, r) => {
    noiseFill(c, s, '#e8e5d4', 6, r);
    for (let y = 3; y < s; y += 4) px(c, 0, y, '#c9c5b0', s, 1);                   // striations
    streaks(c, s, r, '#d4d0bc', 5, true, 3);
    vShade(c, s, 0.08, 0.12);
  },
  skeleton_face: (c, s, r) => {
    PAINT.skeleton_bone(c, s, r);
    px(c, 3, 6, '#14140f', 2, 2); px(c, 11, 6, '#14140f', 2, 2);                   // sockets
    px(c, 7, 9, '#b0ac96', 1, 2);                                                  // nose slit
    px(c, 5, 12, '#9c9c8c', 6, 1);                                                 // jaw line
    px(c, 6, 13, '#7a786a', 1, 1); px(c, 9, 13, '#7a786a', 1, 1);
  },
  creeper_skin: (c, s, r) => {
    noiseFill(c, s, '#4fae46', 7, r);
    // camo blotching — MC's creeper reads as patchy camo, never per-pixel static
    blobs(c, s, r, '#3a8f33', 5, 5);
    blobs(c, s, r, '#71d466', 5, 5);
    blobs(c, s, r, '#2a6f26', 3, 4);
    blobs(c, s, r, '#8fe485', 3, 3);
    vShade(c, s, 0.08, 0.14);
  },
  creeper_face: (c, s, r) => {
    PAINT.creeper_skin(c, s, r);
    // canonical creeper face: 2×2 eyes + 4×3 mouth with 1×2 fangs
    px(c, 3, 5, '#0a0a0a', 2, 2); px(c, 11, 5, '#0a0a0a', 2, 2);
    px(c, 6, 8, '#0a0a0a', 4, 3);
    px(c, 5, 9, '#0a0a0a', 1, 3); px(c, 10, 9, '#0a0a0a', 1, 3);
    px(c, 5, 12, '#0a0a0a'); px(c, 10, 12, '#0a0a0a');
  },
  spider_skin: (c, s, r) => {
    noiseFill(c, s, '#2b2118', 8, r);
    streaks(c, s, r, '#3a2c1e', 10, false, 5);    // leg hair
    streaks(c, s, r, '#1c150e', 8, true, 3);
    vShade(c, s, 0.06, 0.20);
  },
  spider_face: (c, s, r) => {
    PAINT.spider_skin(c, s, r);
    // two rows of red eyes, MC-arc: large pair above, small pair below-outward
    px(c, 3, 5, '#cc3333', 2, 2); px(c, 11, 5, '#cc3333', 2, 2);
    px(c, 6, 7, '#aa2222'); px(c, 9, 7, '#aa2222');
    px(c, 3, 5, '#ff8877'); px(c, 11, 5, '#ff8877');                               // glints
  },
  enderman_skin: (c, s, r) => {
    noiseFill(c, s, '#141418', 4, r);
    streaks(c, s, r, '#1d1d24', 6, true, 4);      // faint dimensional sheen
    vShade(c, s, 0.05, 0.10);
  },
  enderman_face: (c, s, r) => {
    PAINT.enderman_skin(c, s, r);
    px(c, 2, 7, '#c85ffa', 4, 1); px(c, 10, 7, '#c85ffa', 4, 1);                   // iris
    px(c, 3, 7, '#f4d9ff', 2, 1); px(c, 11, 7, '#f4d9ff', 2, 1);                   // glow core
  },
  enderman_face_jaw: (c, s, r) => {
    PAINT.enderman_face(c, s, r);
    px(c, 4, 11, '#b45bd8', 8, 2);                                                 // open jaw
  },
  cow_skin: (c, s, r) => {
    noiseFill(c, s, '#5d4033', 8, r);
    blobs(c, s, r, '#e8e8e4', 4, 9);            // large connected white patches
    blobs(c, s, r, '#4a3328', 3, 3);
    vShade(c, s, 0.07, 0.15);
  },
  cow_face: (c, s, r) => {
    PAINT.cow_skin(c, s, r);
    px(c, 5, 0, '#e8e8e4', 6, 7);                                                  // blaze
    px(c, 3, 4, '#101010', 2, 2); px(c, 11, 4, '#101010', 2, 2);                   // eyes
    px(c, 4, 10, '#e8b5b5', 8, 5);                                                 // muzzle
    px(c, 5, 12, '#8a5555', 1, 2); px(c, 10, 12, '#8a5555', 1, 2);                 // nostrils
  },
  pig_skin: (c, s, r) => {
    noiseFill(c, s, '#efa3a0', 5, r);
    blobs(c, s, r, '#e0908d', 4, 3);
    for (let i = 0; i < 3; i++) px(c, (r() * s) | 0, (r() * s) | 0, '#8a6f5a');    // mud flecks
    vShade(c, s, 0.09, 0.13);
  },
  pig_face: (c, s, r) => {
    PAINT.pig_skin(c, s, r);
    px(c, 3, 5, '#101010', 1, 2); px(c, 12, 5, '#101010', 1, 2);                   // eyes
    px(c, 4, 8, '#d98f8c', 8, 6);                                                  // snout patch
    px(c, 6, 10, '#7a4a48', 1, 3); px(c, 9, 10, '#7a4a48', 1, 3);                  // nostrils
  },
  sheep_wool: (c, s, r) => {
    noiseFill(c, s, '#ece8de', 6, r);
    streaks(c, s, r, '#f8f6f0', 8, true, 3);      // wool curls
    streaks(c, s, r, '#d8d2c4', 8, true, 3);
    c.fillStyle = 'rgba(110,130,60,0.25)';                                          // grass stains
    c.fillRect(0, s - 2, s, 2);
    vShade(c, s, 0.08, 0.10);
  },
  sheep_skin: (c, s, r) => {
    noiseFill(c, s, '#cfa878', 7, r);
    blobs(c, s, r, '#b98f60', 4, 3);
    vShade(c, s);
  },
  sheep_face: (c, s, r) => {
    PAINT.sheep_skin(c, s, r);
    px(c, 3, 6, '#14140f', 2, 2); px(c, 11, 6, '#14140f', 2, 2);                   // eyes
    px(c, 2, 3, '#e8a5a5', 2, 2); px(c, 12, 3, '#e8a5a5', 2, 2);                   // ears
    px(c, 6, 11, '#e8c0c0', 4, 3);                                                 // nose
  },
  chicken_skin: (c, s, r) => {
    noiseFill(c, s, '#f2efe8', 5, r);
    streaks(c, s, r, '#dcd8cc', 10, true, 3);     // feather rows
    for (let i = 0; i < 4; i++) px(c, (r() * s) | 0, (r() * s) | 0, '#c8c4b8');
    vShade(c, s, 0.08, 0.10);
  },
  chicken_face: (c, s, r) => {
    PAINT.chicken_skin(c, s, r);
    px(c, 4, 6, '#101010'); px(c, 11, 6, '#101010');                               // eyes
    px(c, 6, 8, '#e0b23c', 4, 2);                                                  // beak base
    px(c, 7, 10, '#b02525', 2, 2);                                                 // wattle
  },
  chicken_wing: (c, s, r) => {
    PAINT.chicken_skin(c, s, r);
    // layered feather rows: staggered segments with a darker separator line
    for (let y = 3; y < s - 2; y += 4) {
      px(c, 0, y, '#d4d0c4', s, 1);
      for (let x = ((r() * 4) | 0); x < s; x += 4 + ((r() * 3) | 0)) px(c, x, y + 1, '#e8e4da', 3, 1);
    }
    vShade(c, s, 0.06, 0.12);
  },
  chicken_legs: (c, s, r) => {
    noiseFill(c, s, '#dfa33c', 5, r);
    blobs(c, s, r, '#c08a28', 6, 1);            // scale dots
    vShade(c, s, 0.07, 0.12);
  },
  bow_stick: (c, s, r) => {
    noiseFill(c, s, '#7a5a30', 7, r);
    streaks(c, s, r, '#5e4423', 8, false, 5);     // grain
    px(c, 0, 10, '#3f2f18', s, 2);                                                 // grip wrap
    px(c, 0, 9, '#8a6a3a', s, 1);
  },
  // 12-VILLAGES §16 — villager skin/robe, and the iron golem's metal body.
  villager_skin: (c, s, r) => {
    noiseFill(c, s, '#bd8f63', 6, r);
    blobs(c, s, r, '#a8794f', 4, 3);
    vShade(c, s, 0.08, 0.12);
  },
  villager_face: (c, s, r) => {
    PAINT.villager_skin(c, s, r);
    px(c, 5, 5, '#5a4028', 6, 1);                                                  // unibrow
    px(c, 4, 6, '#ffffff', 2, 2); px(c, 10, 6, '#ffffff', 2, 2);                   // eye whites
    px(c, 5, 7, '#3a7a3a'); px(c, 10, 7, '#3a7a3a');                               // green pupils
    px(c, 7, 7, '#9a7048', 2, 5);                                                  // big nose
    px(c, 6, 13, '#8a6444', 4, 1);                                                 // mouth
  },
  villager_robe: (c, s, r) => {
    noiseFill(c, s, '#7a5a3a', 7, r);
    streaks(c, s, r, '#6a4c30', 5, false, 6);     // cloth folds
    px(c, 4, 6, '#9a7a52', 8, 7);                                                  // apron
    for (let x = 4; x < 12; x += 2) px(c, x, 13, '#5a4028');                       // stitching
    px(c, 0, 5, '#8a5a2a', s, 2);                                                  // apron trim
    vShade(c, s, 0.07, 0.13);
  },
  iron_golem: (c, s, r) => {
    noiseFill(c, s, '#d5c8b4', 5, r);
    for (let y = 2; y < s; y += 5) px(c, 0, y, '#b3a28a', s, 1);                   // plate seams
    for (let y = 4; y < s; y += 5) { px(c, 1, y, '#8a7a64'); px(c, s - 2, y, '#8a7a64'); }   // rivets
    streaks(c, s, r, '#c4b69e', 4, false, 4);
    px(c, 6, 9, '#6a8a4a', 4, 3);                                                  // vine patch
    px(c, 4, 6, '#4a4038', 2, 2); px(c, 10, 6, '#4a4038', 2, 2);                   // eyes
  },
  // 11-END §9 — shulker shell (purpur-toned) with a lid seam + a small face.
  shulker: (c, s, r) => {
    noiseFill(c, s, '#a877a8', 6, r);
    streaks(c, s, r, '#8a5f8a', 6, false, 5);     // shell plates
    px(c, 0, Math.floor(s / 2), '#6e4a6e', s, 1);                                  // lid seam
    px(c, 5, 6, '#3a2a3a', 2, 2); px(c, 9, 6, '#3a2a3a', 2, 2);                    // eyes
    px(c, 5, 6, '#d8a8d8'); px(c, 9, 6, '#d8a8d8');                                // glints
  },
  // 13-BOSSES §2.5 — ender dragon + wither skins.
  dragon_body: (c, s, r) => {
    noiseFill(c, s, '#1a1a20', 5, r);
    for (let y = 1; y < s; y += 3) for (let x = (y % 2) * 2; x < s; x += 4) px(c, x, y, '#2c2c36');   // scales
    px(c, 4, 5, '#e079fa', 2, 1); px(c, 10, 5, '#e079fa', 2, 1);                   // eye glints
    px(c, 6, 9, '#4a3a5a', 4, 1);
    vShade(c, s, 0.05, 0.12);
  },
  dragon_wing: (c, s, r) => {
    noiseFill(c, s, '#2a2033', 4, r);
    // membrane veins radiating from the shoulder corner
    for (let i = 0; i < 5; i++) {
      let x = 1, y = 1 + i * 3;
      for (let j = 0; j < 9; j++) { px(c, x, y, '#1a1422'); x++; y += (i & 1) ? 0 : 1; }
    }
    vShade(c, s, 0.06, 0.14);
  },
  wither_body: (c, s, r) => {
    noiseFill(c, s, '#26262c', 6, r);
    for (let y = 2; y < s; y += 4) px(c, 0, y, '#141418', s, 1);                   // rib seams
    blobs(c, s, r, '#303038', 4, 2);
    vShade(c, s, 0.05, 0.12);
  },
  wither_head: (c, s, r) => {
    PAINT.wither_body(c, s, r);
    px(c, 4, 5, '#0e0e12', 2, 2); px(c, 10, 5, '#0e0e12', 2, 2);                   // sockets
    px(c, 6, 10, '#3a3a3a', 4, 1);
  },
};

export function mobTexture(name) {
  const paint = PAINT[name];
  return canvasTex(name, 16, paint ?? ((c, s, r) => noiseFill(c, s, '#ff00ff', 0, r)));
}

// ---------------------------------------------------------------- parts

// 01 §13 — box geometry is shared by dimensions. Every model builder runs per mob
// INSTANCE, and EntityManager.remove disposes materials only, so a fresh
// BoxGeometry per part leaked its GL buffers on every spawn/despawn cycle. No
// code in src/entities reads or mutates a part's `.geometry` (the per-part offset
// lives on the Mesh transform), so one cache entry per size is safe. `shared`
// marks it off-limits to any future geometry.dispose() sweep.
const geoCache = new Map();
function boxGeo(w, h, d) {
  const k = w + '|' + h + '|' + d;
  let g = geoCache.get(k);
  if (!g) {
    g = new THREE.BoxGeometry(w / 16, h / 16, d / 16);
    g.userData.shared = true;
    geoCache.set(k, g);
  }
  return g;
}

// Box part: dims in px; pivot = rotation origin in px (model space, y up from
// feet); offset = box center relative to pivot, in px.
export function part(texName, w, h, d, pivot, offset, faceTexName = null) {
  const geo = boxGeo(w, h, d);
  const mats = [];
  // MeshBasicMaterial (unlit) — MC entities shade by the light level AT THEIR
  // POSITION (applyLightScalar's brightness(level) scalar), exactly like the
  // chunk shader. MeshLambertMaterial applied the scene lights ON TOP of that
  // scalar, double-darkening every mob: at sunset the Lambert term and the
  // scalar each took ~0.25, leaving mobs at ~6% brightness — black silhouettes.
  const side = new THREE.MeshBasicMaterial({ map: mobTexture(texName) });
  side.userData.baseColor = new THREE.Color(1, 1, 1);
  if (faceTexName) {
    const face = new THREE.MeshBasicMaterial({ map: mobTexture(faceTexName) });
    face.userData.baseColor = new THREE.Color(1, 1, 1);
    // BoxGeometry material order: +X, −X, +Y, −Y, +Z, −Z; face on +Z (model front)
    mats.push(side, side, side, side, face, side);
  }
  const mesh = mats.length ? new THREE.Mesh(geo, mats) : new THREE.Mesh(geo, side);
  const group = new THREE.Group();
  group.position.set(pivot[0] / 16, pivot[1] / 16, pivot[2] / 16);
  mesh.position.set(offset[0] / 16, offset[1] / 16, offset[2] / 16);
  group.add(mesh);
  return group;
}

// Model builders return { group, parts } — parts keyed for animation (05 §16.3).
// Convention: model faces +Z; Mob.updateRender rotates the group by yaw+π so
// entity yaw (facing −Z at 0) matches.

export function humanoidModel(skin, face, opts = {}) {
  const armW = opts.slimArms ? 2 : 4;
  const g = new THREE.Group();
  const parts = {};
  parts.head = part(skin, 8, 8, 8, [0, 24, 0], [0, 4, 0], face);
  parts.body = part(opts.shirt ?? skin, 8, 12, 4, [0, 24, 0], [0, -6, 0]);
  parts.armL = part(skin, armW, 12, armW, [-6, 22, 0], [0, -5, 0]);
  parts.armR = part(skin, armW, 12, armW, [6, 22, 0], [0, -5, 0]);
  parts.legL = part(opts.pants ?? skin, armW, 12, armW, [-2, 12, 0], [0, -6, 0]);
  parts.legR = part(opts.pants ?? skin, armW, 12, armW, [2, 12, 0], [0, -6, 0]);
  for (const k in parts) g.add(parts[k]);
  return { group: g, parts };
}

export function endermanModel() {
  const g = new THREE.Group();
  const parts = {};
  parts.head = part('enderman_skin', 8, 8, 8, [0, 38, 0], [0, 4, 0], 'enderman_face');
  parts.body = part('enderman_skin', 8, 12, 4, [0, 38, 0], [0, -6, 0]);
  parts.armL = part('enderman_skin', 2, 30, 2, [-5, 36, 0], [0, -14, 0]);
  parts.armR = part('enderman_skin', 2, 30, 2, [5, 36, 0], [0, -14, 0]);
  parts.legL = part('enderman_skin', 2, 30, 2, [-2, 30, 0], [0, -15, 0]);
  parts.legR = part('enderman_skin', 2, 30, 2, [2, 30, 0], [0, -15, 0]);
  for (const k in parts) g.add(parts[k]);
  return { group: g, parts };
}

export function creeperModel() {
  const g = new THREE.Group();
  const parts = {};
  parts.head = part('creeper_skin', 8, 8, 8, [0, 18, 0], [0, 4, 0], 'creeper_face');
  parts.body = part('creeper_skin', 8, 12, 4, [0, 18, 0], [0, -6, 0]);
  parts.legL = part('creeper_skin', 4, 6, 4, [-2, 6, -2], [0, -3, 0]);
  parts.legR = part('creeper_skin', 4, 6, 4, [2, 6, -2], [0, -3, 0]);
  parts.legL2 = part('creeper_skin', 4, 6, 4, [-2, 6, 2], [0, -3, 0]);
  parts.legR2 = part('creeper_skin', 4, 6, 4, [2, 6, 2], [0, -3, 0]);
  for (const k in parts) g.add(parts[k]);
  return { group: g, parts };
}

export function spiderModel() {
  const g = new THREE.Group();
  const parts = {};
  parts.head = part('spider_skin', 8, 8, 8, [0, 9, 7], [0, 0, 2], 'spider_face');
  parts.body = part('spider_skin', 6, 6, 6, [0, 9, 0], [0, 0, 0]);
  parts.abdomen = part('spider_skin', 10, 8, 12, [0, 9, -6], [0, 0, -4]);
  parts.legs = [];
  const yawSplay = [35, 55, 75, 95];
  for (let i = 0; i < 4; i++) {
    for (const side of [-1, 1]) {
      const leg = part('spider_skin', 16, 2, 2, [side * 3, 9, 4 - i * 3], [side * 8, 0, 0]);
      leg.rotation.y = side * (yawSplay[i] - 65) * Math.PI / 180;
      leg.rotation.z = -side * 20 * Math.PI / 180;
      leg.userData.baseRotY = leg.rotation.y;
      leg.userData.side = side;
      parts.legs.push(leg);
      g.add(leg);
    }
  }
  g.add(parts.head, parts.body, parts.abdomen);
  return { group: g, parts };
}

export function quadrupedModel(skin, face, dims) {
  // dims: { bodyW, bodyH, bodyL, bodyY, headS, headY, legH, legW }
  const g = new THREE.Group();
  const parts = {};
  parts.body = part(skin, dims.bodyW, dims.bodyH, dims.bodyL, [0, dims.bodyY, 0], [0, 0, 0]);
  parts.head = part(skin, dims.headS, dims.headS, dims.headD ?? 6,
    [0, dims.headY, dims.bodyL / 2], [0, 0, (dims.headD ?? 6) / 2], face);
  const lx = dims.bodyW / 2 - dims.legW / 2;
  const lz = dims.bodyL / 2 - dims.legW / 2;
  const legY = dims.bodyY - dims.bodyH / 2;
  parts.legFL = part(skin, dims.legW, dims.legH, dims.legW, [-lx, legY, lz], [0, -dims.legH / 2, 0]);
  parts.legFR = part(skin, dims.legW, dims.legH, dims.legW, [lx, legY, lz], [0, -dims.legH / 2, 0]);
  parts.legBL = part(skin, dims.legW, dims.legH, dims.legW, [-lx, legY, -lz], [0, -dims.legH / 2, 0]);
  parts.legBR = part(skin, dims.legW, dims.legH, dims.legW, [lx, legY, -lz], [0, -dims.legH / 2, 0]);
  for (const k in parts) g.add(parts[k]);
  return { group: g, parts };
}

export function cowModel() {
  const m = quadrupedModel('cow_skin', 'cow_face',
    { bodyW: 12, bodyH: 10, bodyL: 18, bodyY: 16, headS: 8, headD: 6, headY: 20, legH: 11, legW: 4 });
  const udder = part('pig_skin', 4, 2, 6, [0, 11, -4], [0, 0, 0]);
  m.group.add(udder);
  // 05 §16.1 "2 horns 1×3×1". Parented to the head so they track head yaw/pitch:
  // the head pivot is [0,20,9] and its 8×8×6 box is centred at head-local
  // (0,0,3) spanning y16–24, so local y 5.5 puts the horns at y24–27.
  // sheep_skin's tan reads as bone — no new texture.
  for (const sx of [-3, 3]) m.parts.head.add(part('sheep_skin', 1, 3, 1, [sx, 5.5, 3], [0, 0, 0]));
  return m;
}

export function pigModel() {
  const m = quadrupedModel('pig_skin', 'pig_face',
    { bodyW: 10, bodyH: 8, bodyL: 16, bodyY: 10, headS: 8, headD: 8, headY: 12, legH: 6, legW: 4 });
  // 05 §16.1 "snout 4×3×1", protruding from the head's +Z face (head-local box
  // centre (0,0,4) spanning head-local z0–8, so the face plane is z=8). pig_skin,
  // not pig_face — a face texture would squash a whole face onto the 4×3×1 box.
  m.parts.head.add(part('pig_skin', 4, 3, 1, [0, -1, 8.5], [0, 0, 0]));
  return m;
}

export function sheepModel() {
  const m = quadrupedModel('sheep_skin', 'sheep_face',
    { bodyW: 8, bodyH: 6, bodyL: 16, bodyY: 12, headS: 6, headD: 8, headY: 16, legH: 9, legW: 4 });
  // wool overlay (hidden when sheared)
  const wool = part('sheep_wool', 11.5, 9.5, 19.5, [0, 12, 0], [0, 0, 0]);
  wool.userData.isWool = true;
  m.parts.wool = wool;
  m.group.add(wool);
  const headWool = part('sheep_wool', 7.5, 7.5, 7.5, [0, 16, 8], [0, 0, 2]);
  headWool.userData.isWool = true;
  m.parts.headWool = headWool;
  m.group.add(headWool);
  return m;
}

export function chickenModel() {
  const g = new THREE.Group();
  const parts = {};
  parts.body = part('chicken_skin', 6, 6, 8, [0, 8, 0], [0, 0, 0]);
  parts.body.rotation.x = -15 * Math.PI / 180;
  parts.head = part('chicken_skin', 4, 6, 3, [0, 12, 3], [0, 2, 0], 'chicken_face');
  const beak = part('chicken_legs', 4, 2, 2, [0, 14, 5], [0, 0, 1]);
  const wattle = part('chicken_face', 2, 2, 2, [0, 12, 5], [0, 0, 0.5]);
  parts.wingL = part('chicken_wing', 1, 4, 6, [-3.5, 11, 0], [0, -2, 0]);
  parts.wingR = part('chicken_wing', 1, 4, 6, [3.5, 11, 0], [0, -2, 0]);
  parts.legL = part('chicken_legs', 2, 5, 2, [-1.5, 5, 0], [0, -2.5, 0]);
  parts.legR = part('chicken_legs', 2, 5, 2, [1.5, 5, 0], [0, -2.5, 0]);
  g.add(parts.body, parts.head, beak, wattle, parts.wingL, parts.wingR, parts.legL, parts.legR);
  return { group: g, parts };
}

export function skeletonBow() {
  return part('bow_stick', 1, 10, 1, [0, 0, 0], [0, 0, 0]);
}
