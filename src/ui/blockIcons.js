// UPDATE-polish §4 — cached isometric 3D block icons for inventory/menu slots.
// A tiny offscreen WebGL pass renders blockCubeGeometry — the SAME per-face
// atlas-tiled cube the world mesher and the held viewmodel use — at the classic
// GUI dimetric angle into a 64×64 canvas, ONCE per block id. Slots reuse the
// cached image forever (a Map of ~n-blocks canvases + data URLs, a few MB at
// most; nothing renders per frame). 100% procedural: the only source is the
// runtime-painted atlas.
import * as THREE from 'three';
import { BLOCKS } from '../registry/blocks.js';
import { ITEMS } from '../registry/items.js';
import { blockCubeGeometry, entityAtlas } from '../entities/ItemEntity.js';

const SIZE = 64;                   // physical icon resolution (CSS scales it)
let rig = null;                    // lazy offscreen renderer, built on first use
const canvasCache = new Map();     // blockId → 64×64 2D canvas (glint source)
const urlCache = new Map();        // blockId → data URL (CSS background-image)

// Face brightness by BoxGeometry group order (+X, −X, +Y, −Y, +Z, −Z): top at
// full light, X sides mid, Z sides dark — mirrors the world's directional face
// shading so the icon reads as the same material.
const FACE_LIGHT = [0.80, 0.80, 1.0, 0.45, 0.62, 0.62];

function ensureRig() {
  if (rig) return rig;
  const atlas = entityAtlas();
  const canvas = document.createElement('canvas');
  canvas.width = SIZE; canvas.height = SIZE;
  // preserveDrawingBuffer: toDataURL/drawImage read-back happens after render()
  // returns; without it the buffer may already be cleared by compositing.
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  // One material per BoxGeometry face group; fixed per-face color = GUI shading
  // (MeshBasicMaterial so no light-rig/color-space surprises across contexts).
  const mats = FACE_LIGHT.map(l => new THREE.MeshBasicMaterial({
    map: atlas.texture, alphaTest: 0.5, color: new THREE.Color(l, l, l),
  }));
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mats);
  mesh.position.y = -0.5;          // blockCubeGeometry puts the cube's feet at y=0
  scene.add(mesh);
  // Classic GUI dimetric: camera on the (1,1,1) axis (yaw 45°, pitch ≈35.26°).
  // Ortho half-extent 0.87 ≈ the unit cube's projected circumradius + margin.
  const s = 0.87;
  const camera = new THREE.OrthographicCamera(-s, s, s, -s, 0.1, 10);
  camera.position.set(2, 2, 2);
  camera.lookAt(0, 0, 0);
  rig = { renderer, scene, camera, mesh };
  return rig;
}

/**
 * The block id this item should render as a 3D cube icon, or null → keep the
 * flat atlas sprite. 3D applies exactly to full-cube blocks (`shape: 'cube'`,
 * the registry default); sprite-shaped blocks (torch, flowers, doors…) and all
 * tools/items keep their 2D art, per §4's block-vs-item distinction.
 */
export function icon3dBlockIdFor(itemId) {
  const item = ITEMS.get(itemId);
  if (!item || item.kind !== 'block' || item.place == null) return null;
  if (item.sprite && entityAtlas()?.TILE[item.sprite] !== undefined) return null;   // explicit flat art wins
  const blk = BLOCKS[item.place];
  return blk && blk.shape === 'cube' ? item.place : null;
}

/** 64×64 2D canvas of the isometric icon (the glint compositing source). Cached. */
export function blockIconCanvas(blockId) {
  let c = canvasCache.get(blockId);
  if (c) return c;
  const { renderer, scene, camera, mesh } = ensureRig();
  mesh.geometry = blockCubeGeometry(blockId, 1);
  renderer.render(scene, camera);
  c = document.createElement('canvas');
  c.width = SIZE; c.height = SIZE;
  c.getContext('2d').drawImage(renderer.domElement, 0, 0);
  canvasCache.set(blockId, c);
  return c;
}

/** data URL of the icon for CSS background-image. Cached per block id. */
export function blockIconUrl(blockId) {
  let u = urlCache.get(blockId);
  if (!u) { u = blockIconCanvas(blockId).toDataURL(); urlCache.set(blockId, u); }
  return u;
}
