// 08 §11 — the enchantment glint.
//
// §11's chosen adaptation is a SCROLLING GLINT TILE composited per surface — not
// the vanilla dual-UV shader. One 16×16 tile is generated at startup and reused
// everywhere: clipped to the icon silhouette for UI slots (source-atop), and
// blended additively over world geometry.
//
// Applies to any stack with `tags.enchants`, and always to item 346.

import * as THREE from 'three';
import { ENCHANTED_BOOK_ID } from '../items/enchants.js';

/** §11 — does this stack glint? */
export const isGlinted = stack =>
  !!stack && (stack.id === ENCHANTED_BOOK_ID || (stack.tags?.enchants?.length ?? 0) > 0);

// -------------------------------------------------- the tile

let _tile = null;

/**
 * §11 — "transparent canvas + two 3-px-wide diagonal streaks (45°) colored
 * #a56dff→#e2c7ff gradient with 1-px white cores, wrapping (drawn 3× at
 * x-offsets −16/0/+16)".
 */
export function glintTile() {
  if (_tile) return _tile;
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 16, 16);
  grad.addColorStop(0, '#a56dff');
  grad.addColorStop(1, '#e2c7ff');
  // Two streaks, each drawn at three x-offsets so the 45° diagonals wrap
  // seamlessly when the tile repeats.
  for (const streak of [0, 8]) {
    for (const off of [-16, 0, 16]) {
      g.strokeStyle = grad;
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(off + streak - 4, -4);
      g.lineTo(off + streak + 20, 20);
      g.stroke();
      g.strokeStyle = '#ffffff';        // 1-px white core
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(off + streak - 4, -4);
      g.lineTo(off + streak + 20, 20);
      g.stroke();
    }
  }
  _tile = c;
  return c;
}

// -------------------------------------------------- UI icons (§11 bullet 1)

/**
 * Composite one enchanted item icon: the atlas sprite, then the glint clipped to
 * its silhouette via `source-atop`.
 *
 * `frame` advances at 4 Hz (see Hud/Containers); the offset is §11's
 * ((frame*2) % 16, frame % 16).
 */
export function paintGlintIcon(canvas, atlas, tile, frame, srcCanvas = null) {
  // UPDATE-polish §4 — size-generic: 16×16 for flat atlas sprites (k = 1,
  // byte-identical to the original), or larger (48×48) when `srcCanvas` carries
  // a cached isometric 3D block icon; the shimmer scales by k so its speed and
  // period match at every size.
  const S = canvas.width, k = S / 16;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.imageSmoothingEnabled = false;
  if (srcCanvas) {
    g.drawImage(srcCanvas, 0, 0, S, S);
  } else {
    const col = tile & 31, row = tile >> 5;
    g.drawImage(atlas.canvas, col * 16, row * 16, 16, 16, 0, 0, S, S);
  }

  // source-atop keeps only the pixels that land ON the icon — that clip is the
  // whole trick: without it the shimmer would paint the empty slot corners too.
  g.save();
  g.globalCompositeOperation = 'source-atop';
  g.globalAlpha = 0.4;
  const ox = ((frame * 2) % 16) * k, oy = (frame % 16) * k;
  const t = glintTile();
  for (let dx = -1; dx <= 0; dx++) {
    for (let dy = -1; dy <= 0; dy++) g.drawImage(t, ox + dx * 16 * k, oy + dy * 16 * k, 16 * k, 16 * k);
  }
  g.restore();
}

// -------------------------------------------------- world surfaces (§11 bullet 2)

let _worldMat = null;

/**
 * §11 — ONE shared additive material for every glinted mesh in the world
 * (dropped items, the held viewmodel). The texture offset animates globally,
 * which §11 explicitly accepts.
 */
export function glintMaterial() {
  if (_worldMat) return _worldMat;
  const tex = new THREE.CanvasTexture(glintTile());
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  // §11 — "the scrolling streaks ARE the effect". The pass shares the source
  // geometry, whose uv attribute carries ATLAS coordinates: one 16-px tile of
  // the 512-px atlas spans ~1/32, so repeat 2 sampled a SINGLE texel per face —
  // a flat wash that blinked as the offset scrolled. 64 puts ~2 streak repeats
  // back on every face. The offset is applied after the repeat scale, so
  // tickGlint's scroll speed is unchanged.
  tex.repeat.set(64, 64);
  _worldMat = new THREE.MeshBasicMaterial({
    map: tex,
    blending: THREE.AdditiveBlending,
    opacity: 0.35,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,          // kill z-fighting with the surface beneath
    polygonOffsetUnits: -1,
  });
  // 01 §17.2 — this is a process-lifetime singleton. EntityManager.remove()
  // disposes every mesh material lacking this flag, so reaping any glinted drop
  // used to dispose the shared material and force a shader relink on the next
  // glinted draw.
  _worldMat.userData.shared = true;
  return _worldMat;
}

/** Advance the shared scroll. Called once per frame. */
export function tickGlint() {
  if (!_worldMat) return;
  _worldMat.map.offset.x += 0.008;
  _worldMat.map.offset.y += 0.004;
}

/**
 * Add the additive glint pass to a mesh tree, sharing each mesh's geometry.
 * Idempotent: a second call on the same tree is a no-op.
 */
export function addGlintPass(object3d) {
  if (!object3d || object3d.userData.glinted) return;
  object3d.userData.glinted = true;
  const targets = [];
  object3d.traverse(o => { if (o.isMesh && !o.userData.isGlintPass) targets.push(o); });
  for (const m of targets) {
    const pass = new THREE.Mesh(m.geometry, glintMaterial());
    pass.userData.isGlintPass = true;
    m.add(pass);
  }
}
