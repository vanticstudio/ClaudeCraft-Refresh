// Culled-face chunk mesher with per-vertex AO + smooth light (01 §8).
// Runs on the main thread against a 3×3 LIT neighborhood (01 §8.6).
import * as THREE from 'three';
import { BLOCKS, B, WATERLOGGED, STATE_NIBBLE } from '../registry/blocks.js';
import {
  FACE_NORMALS, FACE_CORNERS, FACE_UVS, FACE_TANGENTS, FACE_SHADE, AO_CURVE,
} from './faceTables.js';
import { doorBox } from '../registry/blocks.js';
import { MAX_Y, chunkKey } from '../constants.js';
import { ChunkState } from '../world/Chunk.js';

// ---------------------------------------------------------------- builders

class Builder {
  constructor() {
    this.cap = 4096;
    this.pos = new Float32Array(this.cap * 3);
    this.nrm = new Float32Array(this.cap * 3);
    this.uv = new Float32Array(this.cap * 2);
    this.col = new Uint8Array(this.cap * 4);
    this.idxCap = 8192;
    this.idx = new Uint32Array(this.idxCap);
    this.v = 0;
    this.i = 0;
  }
  reset() { this.v = 0; this.i = 0; }
  ensure(nv, ni) {
    if (this.v + nv > this.cap) {
      this.cap = Math.max(this.cap * 2, this.v + nv);
      this.pos = grow(this.pos, this.cap * 3);
      this.nrm = grow(this.nrm, this.cap * 3);
      this.uv = grow(this.uv, this.cap * 2);
      this.col = grow(this.col, this.cap * 4);
    }
    if (this.i + ni > this.idxCap) {
      this.idxCap = Math.max(this.idxCap * 2, this.i + ni);
      this.idx = grow(this.idx, this.idxCap);
    }
  }
  vertex(x, y, z, nx, ny, nz, u, v, r, g, b, a = 255) {
    const p = this.v * 3, q = this.v * 2, k = this.v * 4;
    this.pos[p] = x; this.pos[p + 1] = y; this.pos[p + 2] = z;
    this.nrm[p] = nx; this.nrm[p + 1] = ny; this.nrm[p + 2] = nz;
    this.uv[q] = u; this.uv[q + 1] = v;
    this.col[k] = r; this.col[k + 1] = g; this.col[k + 2] = b; this.col[k + 3] = a;
    return this.v++;
  }
  quad(v0, v1, v2, v3, flipped) {
    const a = this.idx, i = this.i;
    if (flipped) { a[i] = v1; a[i + 1] = v2; a[i + 2] = v3; a[i + 3] = v1; a[i + 4] = v3; a[i + 5] = v0; }
    else { a[i] = v0; a[i + 1] = v1; a[i + 2] = v2; a[i + 3] = v0; a[i + 4] = v2; a[i + 5] = v3; }
    this.i += 6;
  }
  toGeometry() {
    if (this.v === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.v * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.slice(0, this.v * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, this.v * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, this.v * 4), 4, true));
    g.setIndex(new THREE.BufferAttribute(this.idx.slice(0, this.i), 1));
    return g;
  }
}

function grow(arr, n) {
  const out = new arr.constructor(n);
  out.set(arr);
  return out;
}

const builders = { opaque: new Builder(), cutout: new Builder(), water: new Builder() };

// ---------------------------------------------------------------- mesher

export class ChunkMesher {
  constructor(tileUV) {
    this.tileUV = tileUV;      // Float32Array(1024*4): u0,v0,u1,v1 per tile
    this.hood = new Array(9);
    this.minY = 0;
    this.maxY = 0;
  }

  // 9 chunks, index (dcx+1)*3 + (dcz+1); all must be ≥ LIT (01 §8.6)
  captureHood(world, chunk) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const c = world.chunks.get(chunkKey(chunk.cx + dx, chunk.cz + dz));
        if (!c || c.state < ChunkState.LIT) return false;
        this.hood[(dx + 1) * 3 + (dz + 1)] = c;
      }
    }
    return true;
  }

  chunkOf(wx, wz) { return this.hood[((wx >> 4) + 1) * 3 + ((wz >> 4) + 1)]; }

  blockAt(wx, wy, wz) {
    if (wy < 0) return B.BEDROCK;
    if (wy > MAX_Y) return B.AIR;
    return this.chunkOf(wx, wz).blocks[(wy << 8) | ((wz & 15) << 4) | (wx & 15)];
  }
  stateAt(wx, wy, wz) {
    if (wy < 0 || wy > MAX_Y) return 0;
    return this.chunkOf(wx, wz).states[(wy << 8) | ((wz & 15) << 4) | (wx & 15)];
  }
  opaqueAt(wx, wy, wz) {
    if (wy < 0) return true;
    if (wy > MAX_Y) return false;
    return BLOCKS[this.chunkOf(wx, wz).blocks[(wy << 8) | ((wz & 15) << 4) | (wx & 15)]].opaque;
  }
  skyAt(wx, wy, wz) {
    if (wy < 0) return 0;
    if (wy > MAX_Y) return 15;
    return this.chunkOf(wx, wz).skyLight[(wy << 8) | ((wz & 15) << 4) | (wx & 15)];
  }
  blockLightAt(wx, wy, wz) {
    if (wy < 0 || wy > MAX_Y) return 0;
    return this.chunkOf(wx, wz).blockLight[(wy << 8) | ((wz & 15) << 4) | (wx & 15)];
  }
  // 15 §12.3 — the same-fluid test for WATER everywhere in the mesher. Lava is
  // untouched. Mirrors the Y guards of its siblings: out of range is never water.
  isWaterCell(wx, wy, wz) {
    if (wy < 0 || wy > MAX_Y) return false;
    const c = this.chunkOf(wx, wz);
    const i = (wy << 8) | ((wz & 15) << 4) | (wx & 15);
    return c.blocks[i] === B.WATER || (c.states[i] & WATERLOGGED) !== 0;
  }

  tileFor(blk, state, face) {
    return blk.tileIndexFor ? blk.tileIndexFor(state, face) : blk.tileIndex[face];
  }

  // Build all three bucket geometries for the center chunk of the hood.
  build(world, chunk) {
    if (!this.captureHood(world, chunk)) return null;
    builders.opaque.reset(); builders.cutout.reset(); builders.water.reset();
    this.minY = 127; this.maxY = 0;

    const blocks = chunk.blocks, states = chunk.states;
    for (let i = 0; i < 32768; i++) {
      const id = blocks[i];
      if (id === 0) continue;
      const x = i & 15, z = (i >> 4) & 15, y = i >> 8;
      const blk = BLOCKS[id];
      const st = states[i];
      switch (blk.shape) {
        case 'cube': this.emitCube(x, y, z, blk, st); break;
        case 'liquid': this.emitLiquid(x, y, z, blk); break;
        case 'cross': this.emitCross(x, y, z, blk, st); break;
        case 'hash': this.emitHash(x, y, z, blk, st); break;
        case 'torch': this.emitTorch(x, y, z, blk, st); break;
        case 'ladder': this.emitLadder(x, y, z, blk, st); break;
        case 'snow_layer': this.emitBox(x, y, z, blk, st, [0, 0, 0, 1, 2 / 16, 1], true); break;
        case 'cactus': this.emitCactus(x, y, z, blk, st); break;
        case 'fence': this.emitFence(x, y, z, blk, st); break;
        case 'door': this.emitBox(x, y, z, blk, st, doorBox(st), false); break;
        case 'bed': this.emitBox(x, y, z, blk, st, [0, 0, 0, 1, 9 / 16, 1], true); break;
        case 'farmland': this.emitBox(x, y, z, blk, st, [0, 0, 0, 1, 15 / 16, 1], true); break;
        // --- 08-ENCHANTING §2.2 ---
        // The table is a 12/16-height box; its floating book is a separate
        // cosmetic mesh (it animates per-frame, so it is not chunk geometry).
        case 'enchanting_table':
          this.emitBox(x, y, z, blk, st, [0, 0, 0, 1, 12 / 16, 1], true); break;
        // §2.2's three stacked boxes: base 12×4×12 px, waist 6×5×8, top 16×5×10.
        case 'anvil':
          this.emitBox(x, y, z, blk, st, [2 / 16, 0, 2 / 16, 14 / 16, 4 / 16, 14 / 16], true);
          this.emitBox(x, y, z, blk, st, [5 / 16, 4 / 16, 4 / 16, 11 / 16, 9 / 16, 12 / 16], true);
          this.emitBox(x, y, z, blk, st, [0, 9 / 16, 3 / 16, 1, 14 / 16, 13 / 16], true);
          break;
        // §2.2's wheel 8×12×12 px + two 2×7×2 leg posts.
        case 'grindstone':
          this.emitBox(x, y, z, blk, st, [4 / 16, 4 / 16, 2 / 16, 12 / 16, 1, 14 / 16], true);
          this.emitBox(x, y, z, blk, st, [2 / 16, 0, 6 / 16, 4 / 16, 7 / 16, 8 / 16], true);
          this.emitBox(x, y, z, blk, st, [12 / 16, 0, 6 / 16, 14 / 16, 7 / 16, 8 / 16], true);
          break;
        // 07-REDSTONE §13.2 — approximate custom shapes (orientation is cosmetic;
        // the logic reads state, not the mesh). See DEVIATIONS.
        case 'wire': this.emitBox(x, y, z, blk, st, [0, 0, 0, 1, 1 / 64, 1], false); break;
        case 'lever': this.emitBox(x, y, z, blk, st, [5 / 16, 0, 5 / 16, 11 / 16, 6 / 16, 11 / 16], false); break;
        case 'button': this.emitBox(x, y, z, blk, st, [5 / 16, 0, 6 / 16, 11 / 16, 2 / 16, 10 / 16], false); break;
        case 'plate': this.emitBox(x, y, z, blk, st, [1 / 16, 0, 1 / 16, 15 / 16, 1 / 16, 15 / 16], false); break;
        case 'repeater':
        case 'comparator': this.emitBox(x, y, z, blk, st, [0, 0, 0, 1, 2 / 16, 1], false); break;
        case 'piston_head': this.emitBox(x, y, z, blk, st, [0, 0, 0, 1, 1, 1], true); break;
        case 'hopper': this.emitBox(x, y, z, blk, st, [0, 0, 0, 1, 1, 1], true); break;
        // 09-POTIONS §7.2 — brewing stand: a low base + a central post.
        case 'brewing_stand':
          this.emitBox(x, y, z, blk, st, [1 / 16, 0, 1 / 16, 15 / 16, 2 / 16, 15 / 16], true);
          this.emitBox(x, y, z, blk, st, [7 / 16, 2 / 16, 7 / 16, 9 / 16, 14 / 16, 9 / 16], true);
          break;
        default: break;   // 'none'
      }
      // 15 §12 — the SECOND contribution. The block mesh above is emitted
      // exactly as dry; this adds the water into the water bucket. Done after
      // the switch so every waterloggable shape gets it for free.
      if (st & WATERLOGGED) this.emitWaterlogged(x, y, z, blk);
    }

    if (this.minY > this.maxY) { this.minY = 0; this.maxY = 0; }
    chunk.minY = this.minY; chunk.maxY = this.maxY;
    return {
      opaque: builders.opaque.toGeometry(),
      cutout: builders.cutout.toGeometry(),
      water: builders.water.toGeometry(),
    };
  }

  trackY(y0, y1) {
    if (y0 < this.minY) this.minY = Math.max(0, Math.floor(y0));
    if (y1 > this.maxY) this.maxY = Math.min(127, Math.ceil(y1));
  }

  // ------------------------------------------------------------ cube path

  emitCube(x, y, z, blk, st) {
    const builder = builders[blk.bucket] || builders.opaque;
    for (let f = 0; f < 6; f++) {
      const n = FACE_NORMALS[f];
      const nId = this.blockAt(x + n[0], y + n[1], z + n[2]);
      if (!this.faceVisible(blk, nId)) continue;
      this.emitCubeFace(builder, x, y, z, f, this.tileFor(blk, st, f));
    }
  }

  faceVisible(a, bId) {
    if (bId === B.AIR) return true;
    const b = BLOCKS[bId];
    if (b.opaque) return false;
    if (a.id === bId) return a.renderSameIdFaces;
    return true;
  }

  /**
   * 15 §12.3 — the water-bucket variant of faceVisible. Water hides its face
   * against any other water CELL, which now includes a waterlogged block: an
   * ocean-floor chest must sit flush, not behind a pane of water.
   */
  waterFaceVisible(wx, wy, wz) {
    if (this.isWaterCell(wx, wy, wz)) return false;
    return !BLOCKS[this.blockAt(wx, wy, wz)].opaque;
  }

  emitCubeFace(builder, x, y, z, f, tile) {
    builder.ensure(4, 6);
    const n = FACE_NORMALS[f];
    const bx = x + n[0], by = y + n[1], bz = z + n[2];
    const [t1a, t2a] = FACE_TANGENTS[f];
    const uvr = this.tileUV, t4 = tile * 4;
    const u0 = uvr[t4], v0 = uvr[t4 + 1], u1 = uvr[t4 + 2], v1 = uvr[t4 + 3];
    const shade = FACE_SHADE[f];
    const ao = AO4; const verts = V4;

    for (let c = 0; c < 4; c++) {
      const co = FACE_CORNERS[f][c];
      const s1 = co[t1a] ? 1 : -1;
      const s2 = co[t2a] ? 1 : -1;
      // AO sample cells in the layer the face opens into (01 §8.3)
      let c1x = bx, c1y = by, c1z = bz;
      if (t1a === 0) c1x += s1; else if (t1a === 1) c1y += s1; else c1z += s1;
      let c2x = bx, c2y = by, c2z = bz;
      if (t2a === 0) c2x += s2; else if (t2a === 1) c2y += s2; else c2z += s2;
      const c3x = c1x + (c2x - bx), c3y = c1y + (c2y - by), c3z = c1z + (c2z - bz);

      const side1 = this.opaqueAt(c1x, c1y, c1z) ? 1 : 0;
      const side2 = this.opaqueAt(c2x, c2y, c2z) ? 1 : 0;
      const cornerOcc = this.opaqueAt(c3x, c3y, c3z) ? 1 : 0;
      ao[c] = (side1 && side2) ? 0 : 3 - (side1 + side2 + cornerOcc);

      // smooth light: average the same 4 cells, skipping opaque ones
      let skySum = 0, blkSum = 0, cnt = 0;
      // base cell (never opaque for a visible cube face, but guard anyway)
      if (!this.opaqueAt(bx, by, bz)) {
        skySum += this.skyAt(bx, by, bz); blkSum += this.blockLightAt(bx, by, bz); cnt++;
      }
      if (!side1) { skySum += this.skyAt(c1x, c1y, c1z); blkSum += this.blockLightAt(c1x, c1y, c1z); cnt++; }
      if (!side2) { skySum += this.skyAt(c2x, c2y, c2z); blkSum += this.blockLightAt(c2x, c2y, c2z); cnt++; }
      if (!(side1 && side2) && !cornerOcc) {
        skySum += this.skyAt(c3x, c3y, c3z); blkSum += this.blockLightAt(c3x, c3y, c3z); cnt++;
      }
      let skyV, blkV;
      if (cnt === 0) { skyV = this.skyAt(bx, by, bz); blkV = this.blockLightAt(bx, by, bz); }
      else { skyV = skySum / cnt; blkV = blkSum / cnt; }

      const uu = FACE_UVS[f][c][0], vv = FACE_UVS[f][c][1];
      verts[c] = builder.vertex(
        x + co[0], y + co[1], z + co[2],
        n[0], n[1], n[2],
        u0 + (u1 - u0) * uu, v0 + (v1 - v0) * vv,
        Math.round(skyV * 17), Math.round(blkV * 17),
        Math.round(255 * AO_CURVE[ao[c]] * shade),
      );
    }
    builder.quad(verts[0], verts[1], verts[2], verts[3], ao[0] + ao[2] > ao[1] + ao[3]);
    this.trackY(y, y + 1);
  }

  // ------------------------------------------------------------ liquids

  emitLiquid(x, y, z, blk) {
    const builder = builders.water;
    const water = blk.fluid === 'water';
    // 15 §12.3 — for water, "same fluid" means isWaterCell: a plain water cell
    // culls its face toward a waterlogged neighbor, so an ocean-floor fence line
    // reads as continuous water with no phantom walls. Lava keeps the id test.
    const sameFluid = (wx, wy, wz) => water
      ? this.isWaterCell(wx, wy, wz)
      : BLOCKS[this.blockAt(wx, wy, wz)].fluid === blk.fluid;
    const h = sameFluid(x, y + 1, z) ? 1 : 0.875;
    for (let f = 0; f < 6; f++) {
      const n = FACE_NORMALS[f];
      const nx = x + n[0], ny = y + n[1], nz = z + n[2];
      if (sameFluid(nx, ny, nz)) continue;    // same-fluid faces never render
      if (BLOCKS[this.blockAt(nx, ny, nz)].opaque) continue;
      this.emitFlatFace(builder, x, y, z, f, blk.tileIndex[f], h,
        this.skyAt(nx, ny, nz), this.blockLightAt(nx, ny, nz),
        Math.round((blk.fluidAlpha ?? 1) * 255));
    }
  }

  /**
   * 15 §12 — a bit-7 cell emits TWO contributions in the same sweep: its normal
   * block mesh (emitted by the shape switch, unchanged) AND this water geometry
   * in the water bucket.
   */
  emitWaterlogged(x, y, z, blk) {
    // §12.2 full-cube rule: a chest emits NO water of its own — the water is
    // logically present but visually inside the cube, and neighbouring water
    // culls toward it via isWaterCell, so it sits flush with no phantom sleeve.
    if (blk.shape === 'cube') return;

    const builder = builders.water;
    const water = BLOCKS[B.WATER];
    const alpha = Math.round((water.fluidAlpha ?? 1) * 255);
    const aboveWater = this.isWaterCell(x, y + 1, z);
    const sideTop = aboveWater ? 1.0 : 0.875;

    // top face at the standard lowered source surface, only if nothing above
    if (!aboveWater) {
      this.emitFlatFace(builder, x, y, z, 2, water.tileIndex[2], 0.875,
        this.skyAt(x, y + 1, z), this.blockLightAt(x, y + 1, z), alpha);
    }
    // sides at the exact cell-boundary plane
    for (const f of [0, 1, 4, 5]) {
      const n = FACE_NORMALS[f];
      const nx = x + n[0], ny = y + n[1], nz = z + n[2];
      if (this.isWaterCell(nx, ny, nz)) continue;
      if (BLOCKS[this.blockAt(nx, ny, nz)].opaque) continue;
      this.emitFlatFace(builder, x, y, z, f, water.tileIndex[f], sideTop,
        this.skyAt(nx, ny, nz), this.blockLightAt(nx, ny, nz), alpha);
    }
    // bottom
    if (!this.isWaterCell(x, y - 1, z) && !BLOCKS[this.blockAt(x, y - 1, z)].opaque) {
      this.emitFlatFace(builder, x, y, z, 3, water.tileIndex[3], 1,
        this.skyAt(x, y - 1, z), this.blockLightAt(x, y - 1, z), alpha);
    }
  }

  // Flat-lit cube face with a scaled top (liquids)
  emitFlatFace(builder, x, y, z, f, tile, h, skyV, blkV, alpha = 255) {
    builder.ensure(4, 6);
    const n = FACE_NORMALS[f];
    const uvr = this.tileUV, t4 = tile * 4;
    const u0 = uvr[t4], v0 = uvr[t4 + 1], u1 = uvr[t4 + 2], v1 = uvr[t4 + 3];
    const shade = FACE_SHADE[f];
    const r = Math.round(skyV * 17), g = Math.round(blkV * 17);
    const b = Math.round(255 * shade);
    const verts = V4;
    for (let c = 0; c < 4; c++) {
      const co = FACE_CORNERS[f][c];
      const cy = f === 3 ? co[1] : co[1] * h;   // bottom face stays flat
      const uu = FACE_UVS[f][c][0], vv = FACE_UVS[f][c][1];
      verts[c] = builder.vertex(
        x + co[0], y + cy, z + co[2], n[0], n[1], n[2],
        u0 + (u1 - u0) * uu, v0 + (v1 - v0) * vv, r, g, b, alpha,
      );
    }
    builder.quad(verts[0], verts[1], verts[2], verts[3], false);
    this.trackY(y, y + 1);
  }

  // ------------------------------------------------------------ sprites

  ownLight(x, y, z) {
    const i = (y << 8) | ((z & 15) << 4) | (x & 15);
    const c = this.chunkOf(x, z);
    return [c.skyLight[i], c.blockLight[i]];
  }

  emitSpriteQuad(builder, tile, p0, p1, p2, p3, r, g) {
    builder.ensure(4, 6);
    const uvr = this.tileUV, t4 = tile * 4;
    const u0 = uvr[t4], v0 = uvr[t4 + 1], u1 = uvr[t4 + 2], v1 = uvr[t4 + 3];
    // corners: p0,p1 bottom (v=1), p2,p3 top (v=0); p0/p3 at u=0, p1/p2 at u=1
    const a = builder.vertex(p0[0], p0[1], p0[2], 0, 1, 0, u0, v1, r, g, 255);
    const b = builder.vertex(p1[0], p1[1], p1[2], 0, 1, 0, u1, v1, r, g, 255);
    const c = builder.vertex(p2[0], p2[1], p2[2], 0, 1, 0, u1, v0, r, g, 255);
    const d = builder.vertex(p3[0], p3[1], p3[2], 0, 1, 0, u0, v0, r, g, 255);
    builder.quad(a, b, c, d, false);
  }

  emitCross(x, y, z, blk, st) {
    const [sky, bl] = this.ownLight(x, y, z);
    const r = Math.round(sky * 17), g = Math.round(bl * 17);
    const tile = this.tileFor(blk, st, 0);
    const lo = 0.15, hi = 0.85;
    this.emitSpriteQuad(builders.cutout, tile,
      [x + lo, y, z + lo], [x + hi, y, z + hi], [x + hi, y + 1, z + hi], [x + lo, y + 1, z + lo], r, g);
    this.emitSpriteQuad(builders.cutout, tile,
      [x + hi, y, z + lo], [x + lo, y, z + hi], [x + lo, y + 1, z + hi], [x + hi, y + 1, z + lo], r, g);
    this.trackY(y, y + 1);
  }

  emitHash(x, y, z, blk, st) {
    const [sky, bl] = this.ownLight(x, y, z);
    const r = Math.round(sky * 17), g = Math.round(bl * 17);
    const tile = this.tileFor(blk, st, 0);
    const bld = builders.cutout;
    this.emitSpriteQuad(bld, tile, [x + 0.25, y, z], [x + 0.25, y, z + 1], [x + 0.25, y + 1, z + 1], [x + 0.25, y + 1, z], r, g);
    this.emitSpriteQuad(bld, tile, [x + 0.75, y, z], [x + 0.75, y, z + 1], [x + 0.75, y + 1, z + 1], [x + 0.75, y + 1, z], r, g);
    this.emitSpriteQuad(bld, tile, [x, y, z + 0.25], [x + 1, y, z + 0.25], [x + 1, y + 1, z + 0.25], [x, y + 1, z + 0.25], r, g);
    this.emitSpriteQuad(bld, tile, [x, y, z + 0.75], [x + 1, y, z + 0.75], [x + 1, y + 1, z + 0.75], [x, y + 1, z + 0.75], r, g);
    this.trackY(y, y + 1);
  }

  // Torch: 2/16 box; wall states offset toward the supporting block
  // (state 1..4 = facing +Z/−Z/+X/−X, support on the opposite side).
  emitTorch(x, y, z, blk, st) {
    let ox = 0, oy = 0, oz = 0;
    if (st === 1) { oz = -0.30; oy = 3 / 16; }
    else if (st === 2) { oz = 0.30; oy = 3 / 16; }
    else if (st === 3) { ox = -0.30; oy = 3 / 16; }
    else if (st === 4) { ox = 0.30; oy = 3 / 16; }
    const b = [7 / 16 + ox, oy, 7 / 16 + oz, 9 / 16 + ox, 10 / 16 + oy, 9 / 16 + oz];
    this.emitBox(x, y, z, blk, st, b, false);
  }

  emitLadder(x, y, z, blk, st0) {
    const [sky, bl] = this.ownLight(x, y, z);
    const r = Math.round(sky * 17), g = Math.round(bl * 17);
    const tile = this.tileFor(blk, st0, 0);
    // 15 §8: MASK the nibble. A waterlogged ladder is 0x81..0x84 — every ===
    // test below would miss and all four orientations would fall through to the
    // state-4 branch, rendering the ladder on the wrong wall.
    const st = st0 & STATE_NIBBLE;
    const e = 1 / 16;
    const bld = builders.cutout;
    if (st === 1) this.emitSpriteQuad(bld, tile, [x, y, z + e], [x + 1, y, z + e], [x + 1, y + 1, z + e], [x, y + 1, z + e], r, g);
    else if (st === 2) this.emitSpriteQuad(bld, tile, [x, y, z + 1 - e], [x + 1, y, z + 1 - e], [x + 1, y + 1, z + 1 - e], [x, y + 1, z + 1 - e], r, g);
    else if (st === 3) this.emitSpriteQuad(bld, tile, [x + e, y, z], [x + e, y, z + 1], [x + e, y + 1, z + 1], [x + e, y + 1, z], r, g);
    else this.emitSpriteQuad(bld, tile, [x + 1 - e, y, z], [x + 1 - e, y, z + 1], [x + 1 - e, y + 1, z + 1], [x + 1 - e, y + 1, z], r, g);
    this.trackY(y, y + 1);
  }

  emitCactus(x, y, z, blk, st) {
    const inset = 1 / 16;
    this.emitBox(x, y, z, blk, st, [inset, 0, inset, 1 - inset, 1, 1 - inset], false, {
      skipTop: this.blockAt(x, y + 1, z) === blk.id,
      skipBottom: this.blockAt(x, y - 1, z) === blk.id,
    });
  }

  emitFence(x, y, z, blk, st) {
    // center post
    this.emitBox(x, y, z, blk, st, [6 / 16, 0, 6 / 16, 10 / 16, 1, 10 / 16], false);
    // rails toward connecting neighbors (fence or opaque cube)
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of dirs) {
      const nId = this.blockAt(x + dx, y, z + dz);
      const nb = BLOCKS[nId];
      if (!(nb.shape === 'fence' || nb.opaque)) continue;
      for (const [ry0, ry1] of [[6 / 16, 9 / 16], [12 / 16, 15 / 16]]) {
        let bx0 = 7 / 16, bx1 = 9 / 16, bz0 = 7 / 16, bz1 = 9 / 16;
        if (dx === 1) { bx0 = 10 / 16; bx1 = 1; }
        else if (dx === -1) { bx0 = 0; bx1 = 6 / 16; }
        else if (dz === 1) { bz0 = 10 / 16; bz1 = 1; }
        else { bz0 = 0; bz1 = 6 / 16; }
        this.emitBox(x, y, z, blk, st, [bx0, ry0, bz0, bx1, ry1, bz1], false);
      }
    }
  }

  // Generic box emitter: flat own-cell light, directional shade, cropped UVs.
  emitBox(x, y, z, blk, st, box, cull, opts = {}) {
    const [sky, bl] = this.ownLight(x, y, z);
    const r = Math.round(sky * 17), g = Math.round(bl * 17);
    const bld = builders.cutout;
    const [x0, y0, z0, x1, y1, z1] = box;
    for (let f = 0; f < 6; f++) {
      if (opts.skipTop && f === 2) continue;
      if (opts.skipBottom && f === 3) continue;
      if (cull) {
        // flush faces culled against opaque neighbors
        const flush = (f === 0 && x1 === 1) || (f === 1 && x0 === 0) ||
                      (f === 2 && y1 === 1) || (f === 3 && y0 === 0) ||
                      (f === 4 && z1 === 1) || (f === 5 && z0 === 0);
        if (flush) {
          const n = FACE_NORMALS[f];
          if (this.opaqueAt(x + n[0], y + n[1], z + n[2])) continue;
        }
      }
      const n = FACE_NORMALS[f];
      const tile = this.tileFor(blk, st, f);
      const uvr = this.tileUV, t4 = tile * 4;
      const U0 = uvr[t4], V0 = uvr[t4 + 1], U1 = uvr[t4 + 2], V1 = uvr[t4 + 3];
      // crop intervals in tile space per face
      let uLo, uHi, vLo, vHi;
      if (f === 0) { uLo = z0; uHi = z1; } else if (f === 1) { uLo = 1 - z1; uHi = 1 - z0; }
      else if (f === 5) { uLo = 1 - x1; uHi = 1 - x0; } else { uLo = x0; uHi = x1; }
      if (f === 2 || f === 3) { vLo = z0; vHi = z1; } else { vLo = 1 - y1; vHi = 1 - y0; }

      const shade = FACE_SHADE[f];
      const bcol = Math.round(255 * shade);
      bld.ensure(4, 6);
      const verts = V4;
      for (let c = 0; c < 4; c++) {
        const co = FACE_CORNERS[f][c];
        const px = co[0] ? x1 : x0, py = co[1] ? y1 : y0, pz = co[2] ? z1 : z0;
        const uu = FACE_UVS[f][c][0], vv = FACE_UVS[f][c][1];
        const cu = uLo + (uHi - uLo) * uu, cv = vLo + (vHi - vLo) * vv;
        verts[c] = bld.vertex(
          x + px, y + py, z + pz, n[0], n[1], n[2],
          U0 + (U1 - U0) * cu, V0 + (V1 - V0) * cv, r, g, bcol,
        );
      }
      bld.quad(verts[0], verts[1], verts[2], verts[3], false);
    }
    this.trackY(y + y0, y + y1);
  }
}

const AO4 = [0, 0, 0, 0];
const V4 = [0, 0, 0, 0];

// Manual bounding sphere from tracked Y bounds (01 §8.5)
export function setChunkBoundingSphere(geometry, minY, maxY) {
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(8, (minY + maxY) / 2, 8),
    Math.hypot(8, (maxY - minY) / 2 + 1, 8),
  );
}
