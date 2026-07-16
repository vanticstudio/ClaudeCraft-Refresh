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

// ---------------------------------------------------------------- texture recipes (05 §16.2)

const PAINT = {
  zombie_skin: (c, s, r) => noiseFill(c, s, '#44aa44', 12, r),
  zombie_shirt: (c, s, r) => noiseFill(c, s, '#2d6b2d', 12, r),
  zombie_pants: (c, s, r) => noiseFill(c, s, '#345d8a', 12, r),
  zombie_face: (c, s, r) => {
    noiseFill(c, s, '#44aa44', 12, r);
    px(c, 3, 6, '#000', 2, 2); px(c, 11, 6, '#000', 2, 2);
    px(c, 6, 11, '#1a331a', 4, 1);
  },
  skeleton_bone: (c, s, r) => {
    noiseFill(c, s, '#d8d8c8', 8, r);
    for (let y = 3; y < s; y += 4) px(c, 0, y, '#9c9c8c', s, 1);
  },
  skeleton_face: (c, s, r) => {
    noiseFill(c, s, '#d8d8c8', 8, r);
    px(c, 3, 6, '#000', 2, 2); px(c, 11, 6, '#000', 2, 2);
    px(c, 7, 8, '#555548', 1, 2);
    px(c, 5, 12, '#3a3a30', 6, 1);
  },
  creeper_skin: (c, s, r) => {
    const cols = ['#0da70b', '#3ecb3a', '#7ee87b', '#1b8a1a'];
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) px(c, x, y, cols[(r() * 4) | 0]);
  },
  creeper_face: (c, s, r) => {
    PAINT.creeper_skin(c, s, r);
    px(c, 3, 5, '#000', 3, 3); px(c, 10, 5, '#000', 3, 3);
    px(c, 6, 8, '#000', 4, 3);
    px(c, 5, 10, '#000', 2, 4); px(c, 9, 10, '#000', 2, 4);
  },
  spider_skin: (c, s, r) => noiseFill(c, s, '#1e1a17', 10, r),
  spider_face: (c, s, r) => {
    noiseFill(c, s, '#1e1a17', 10, r);
    for (let i = 0; i < 4; i++) { px(c, 3 + i * 3, 5, '#cc3333'); px(c, 4 + i * 3, 8, '#aa2222'); }
  },
  enderman_skin: (c, s, r) => noiseFill(c, s, '#0d0d12', 5, r),
  enderman_face: (c, s, r) => {
    noiseFill(c, s, '#0d0d12', 5, r);
    px(c, 2, 7, '#e079fa', 4, 1); px(c, 10, 7, '#e079fa', 4, 1);
    px(c, 3, 7, '#ffffff', 2, 1); px(c, 11, 7, '#ffffff', 2, 1);
  },
  enderman_face_jaw: (c, s, r) => {
    PAINT.enderman_face(c, s, r);
    px(c, 4, 11, '#e079fa', 8, 2);
  },
  cow_skin: (c, s, r) => {
    noiseFill(c, s, '#5d4033', 10, r);
    for (let i = 0; i < 5; i++) {
      let bx = (r() * s) | 0, by = (r() * s) | 0;
      for (let j = 0; j < 5; j++) {
        px(c, Math.min(s - 2, bx), Math.min(s - 2, by), '#e6e6e6', 2, 2);
        bx += ((r() * 3) | 0) - 1; by += ((r() * 3) | 0) - 1;
        bx = Math.max(0, bx); by = Math.max(0, by);
      }
    }
  },
  cow_face: (c, s, r) => {
    noiseFill(c, s, '#5d4033', 10, r);
    px(c, 5, 2, '#e6e6e6', 6, 8);
    px(c, 3, 4, '#000', 2, 2); px(c, 11, 4, '#000', 2, 2);
    px(c, 5, 11, '#e8a5a5', 6, 4);
  },
  pig_skin: (c, s, r) => noiseFill(c, s, '#f0a5a2', 6, r),
  pig_face: (c, s, r) => {
    noiseFill(c, s, '#f0a5a2', 6, r);
    px(c, 3, 5, '#000', 1, 2); px(c, 12, 5, '#000', 1, 2);
    px(c, 5, 9, '#d18784', 6, 4);
    px(c, 6, 10, '#5e2e2c', 1, 2); px(c, 9, 10, '#5e2e2c', 1, 2);
  },
  sheep_wool: (c, s, r) => noiseFill(c, s, '#e6e6e6', 10, r),
  sheep_skin: (c, s, r) => noiseFill(c, s, '#d1b28a', 8, r),
  sheep_face: (c, s, r) => {
    noiseFill(c, s, '#d1b28a', 8, r);
    px(c, 3, 6, '#000', 2, 2); px(c, 11, 6, '#000', 2, 2);
    px(c, 2, 3, '#e8a5a5', 2, 2); px(c, 12, 3, '#e8a5a5', 2, 2);
  },
  chicken_skin: (c, s, r) => noiseFill(c, s, '#f4f4f4', 8, r),
  chicken_face: (c, s, r) => {
    noiseFill(c, s, '#f4f4f4', 8, r);
    px(c, 4, 6, '#000'); px(c, 11, 6, '#000');
    px(c, 6, 8, '#e0b23c', 4, 2);
    px(c, 7, 10, '#b02525', 2, 2);
  },
  chicken_wing: (c, s, r) => {
    noiseFill(c, s, '#f4f4f4', 8, r);
    px(c, 0, s - 3, '#d0d0d0', s, 3);
  },
  chicken_legs: (c, s, r) => noiseFill(c, s, '#e0b23c', 6, r),
  bow_stick: (c, s, r) => noiseFill(c, s, '#6b4f2a', 8, r),
};

export function mobTexture(name) {
  const paint = PAINT[name];
  return canvasTex(name, 16, paint ?? ((c, s, r) => noiseFill(c, s, '#ff00ff', 0, r)));
}

// ---------------------------------------------------------------- parts

// Box part: dims in px; pivot = rotation origin in px (model space, y up from
// feet); offset = box center relative to pivot, in px.
export function part(texName, w, h, d, pivot, offset, faceTexName = null) {
  const geo = new THREE.BoxGeometry(w / 16, h / 16, d / 16);
  const mats = [];
  const side = new THREE.MeshLambertMaterial({ map: mobTexture(texName) });
  side.userData.baseColor = new THREE.Color(1, 1, 1);
  if (faceTexName) {
    const face = new THREE.MeshLambertMaterial({ map: mobTexture(faceTexName) });
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
  return m;
}

export function pigModel() {
  const m = quadrupedModel('pig_skin', 'pig_face',
    { bodyW: 10, bodyH: 8, bodyL: 16, bodyY: 10, headS: 8, headD: 8, headY: 12, legH: 6, legW: 4 });
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
