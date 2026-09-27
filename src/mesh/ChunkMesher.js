// Culled-face chunk mesher with per-vertex AO + smooth light (01 §8).
// OVERHAUL §G — greedy quad merging: full-cube faces whose 4-corner light, AO,
// tile and biome tint all match are merged into rects (flat plains drop from
// ~1 quad/block to ~1 quad/rect). Merged quads emit TILE-LOCAL uvs (0..span)
// plus the tile's atlas origin (aTileUV) and a span attribute (aSpan); the
// chunk shader folds them back with fract(). Every other shape emitter is
// byte-identical to 01 §8 and rides the absolute-UV path (aSpan 1,1).
// Runs on the main thread against a 3×3 LIT neighborhood (01 §8.6), and — via
// loadSnapshot/buildFromSnapshot — inside meshWorker.js from plain typed-array
// hood snapshots (OVERHAUL §W).
import * as THREE from 'three';
import { BLOCKS, B, WATERLOGGED, STATE_NIBBLE, WALL_DIR } from '../registry/blocks.js';
import {
  FACE_NORMALS, FACE_CORNERS, FACE_UVS, FACE_TANGENTS, FACE_SHADE, AO_CURVE,
} from './faceTables.js';
import { doorBox } from '../registry/blocks.js';
// 07-REDSTONE §4.5 — the 16 power-tinted dust tile variants, and the ONE
// connection-graph implementation (§4.2). The mesher never re-derives the graph:
// shape and logic must agree by construction.
import { DUST_DOT_TILE, DUST_LINE_TILE, cellX, cellY } from '../assets/atlas.js';
import { dustConnections, CONN } from '../redstone/dust.js';
// 07-REDSTONE §2 — ATTACH 0-5 → the vector from a component TO its support.
// redstone_torch encodes ATTACH in bits0-2 (§13.3), NOT 06 §3's torch nibble.
// FACE6_DIR is the piston/piston_head extension direction (§13.3 rows 79-81).
import { ATTACH_DIR, FACE6_DIR } from '../redstone/dirs.js';
import { MAX_Y, chunkKey, TILE_PX, ATLAS_GUTTER, ATLAS_SIZE } from '../constants.js';
import { ChunkState } from '../world/Chunk.js';
import { biomeTint } from './biomeTints.js';

// Greedy-merged quads span (w, h) cells; vertex UVs stop EPS short of the span
// so fract() samples the LAST texel exactly (fract(1.0) would wrap to 0).
const UV_EPS = 1 / 256;
// aSpan sentinel: non-merged faces carry (1,1) (sum 2.0); merged faces carry
// (w+Δ, h+Δ) (sum ≥ 2.02) — the shader's step() test tells the paths apart.
const SPAN_EPS = 0.01;

// ---------------------------------------------------------------- builders

class Builder {
  constructor() {
    this.cap = 4096;
    this.pos = new Float32Array(this.cap * 3);
    this.nrm = new Float32Array(this.cap * 3);
    this.uv = new Float32Array(this.cap * 2);
    this.span = new Float32Array(this.cap * 2);
    this.tileUV = new Float32Array(this.cap * 2);
    this.col = new Uint8Array(this.cap * 4);
    this.tnt = new Uint8Array(this.cap * 3);
    this.idxCap = 8192;
    this.idx = new Uint32Array(this.idxCap);
    this.v = 0;
    this.i = 0;
    // per-quad state (see quad()'s reset): span sentinels, merged-tile origin,
    // biome tint. Non-greedy emitters never touch these and ride the defaults.
    this.su = 1; this.sv = 1;
    this.tu = 0; this.tv = 0;
    this.tr = 255; this.tg = 255; this.tb = 255;
  }
  reset() { this.v = 0; this.i = 0; }
  ensure(nv, ni) {
    if (this.v + nv > this.cap) {
      this.cap = Math.max(this.cap * 2, this.v + nv);
      this.pos = grow(this.pos, this.cap * 3);
      this.nrm = grow(this.nrm, this.cap * 3);
      this.uv = grow(this.uv, this.cap * 2);
      this.span = grow(this.span, this.cap * 2);
      this.tileUV = grow(this.tileUV, this.cap * 2);
      this.col = grow(this.col, this.cap * 4);
      this.tnt = grow(this.tnt, this.cap * 3);
    }
    if (this.i + ni > this.idxCap) {
      this.idxCap = Math.max(this.idxCap * 2, this.i + ni);
      this.idx = grow(this.idx, this.idxCap);
    }
  }
  vertex(x, y, z, nx, ny, nz, u, v, r, g, b, a = 255) {
    const p = this.v * 3, q = this.v * 2, k = this.v * 4, m = this.v * 3;
    this.pos[p] = x; this.pos[p + 1] = y; this.pos[p + 2] = z;
    this.nrm[p] = nx; this.nrm[p + 1] = ny; this.nrm[p + 2] = nz;
    this.uv[q] = u; this.uv[q + 1] = v;
    this.span[q] = this.su; this.span[q + 1] = this.sv;
    this.tileUV[q] = this.tu; this.tileUV[q + 1] = this.tv;
    this.col[k] = r; this.col[k + 1] = g; this.col[k + 2] = b; this.col[k + 3] = a;
    this.tnt[m] = this.tr; this.tnt[m + 1] = this.tg; this.tnt[m + 2] = this.tb;
    return this.v++;
  }
  quad(v0, v1, v2, v3, flipped) {
    const a = this.idx, i = this.i;
    if (flipped) { a[i] = v1; a[i + 1] = v2; a[i + 2] = v3; a[i + 3] = v1; a[i + 4] = v3; a[i + 5] = v0; }
    else { a[i] = v0; a[i + 1] = v1; a[i + 2] = v2; a[i + 3] = v0; a[i + 4] = v2; a[i + 5] = v3; }
    this.i += 6;
    // reset per-quad state — emitters that set tint/span/tile never leak it
    this.su = 1; this.sv = 1;
    this.tu = 0; this.tv = 0;
    this.tr = 255; this.tg = 255; this.tb = 255;
  }
  /** Exact-size copies for BufferAttribute construction. */
  toGeometry() {
    if (this.v === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.v * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.slice(0, this.v * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, this.v * 2), 2));
    g.setAttribute('aSpan', new THREE.BufferAttribute(this.span.slice(0, this.v * 2), 2));
    g.setAttribute('aTileUV', new THREE.BufferAttribute(this.tileUV.slice(0, this.v * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, this.v * 4), 4, true));
    g.setAttribute('tint', new THREE.BufferAttribute(this.tnt.slice(0, this.v * 3), 3, true));
    g.setIndex(new THREE.BufferAttribute(indexTyped(this.idx, this.i), 1));
    return g;
  }
  /** Plain arrays for the mesh-worker transfer (same data, no three.js). */
  toRaw() {
    if (this.v === 0) return null;
    return {
      pos: this.pos.slice(0, this.v * 3),
      nrm: this.nrm.slice(0, this.v * 3),
      uv: this.uv.slice(0, this.v * 2),
      span: this.span.slice(0, this.v * 2),
      tileUV: this.tileUV.slice(0, this.v * 2),
      col: this.col.slice(0, this.v * 4),
      tint: this.tnt.slice(0, this.v * 3),
      idx: indexTyped(this.idx, this.i),
    };
  }
}

// Uint16 indices whenever the bucket stays under the 64k limit (nearly always
// with greedy merging) — half the index bandwidth of Uint32 for free.
function indexTyped(src, n) {
  if (n < 65536) {
    const out = new Uint16Array(n);
    for (let k = 0; k < n; k++) out[k] = src[k];
    return out;
  }
  return src.slice(0, n);
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
    // 07-REDSTONE §4.2 — a World-shaped view of the captured 3×3 hood, so
    // dustConnections() can run inside the mesher unchanged. Coordinates are the
    // mesher's hood-local ones (centre chunk 0..15, neighbours −1 / 16), which is
    // exactly what blockAt/stateAt already take. Allocated once, not per cell.
    this.hoodWorld = {
      getBlock: (x, y, z) => this.blockAt(x, y, z),
      getState: (x, y, z) => this.stateAt(x, y, z),
    };
    this.center = null;        // snapshot-mode center chunk shim (loadSnapshot)
  }

  // 9 chunks, index (dcx+1)*3 + (dcz+1); all must be ≥ LIT (01 §8.6).
  // AMENDS 01 §8.6 — one exemption, matching ChunkManager.hoodAtLeast: a FAILED
  // neighbour (state −1) counts as satisfied. markChunkFailed() installs empty
  // blocks/states/skyLight/blockLight on every FAILED chunk, so the hood
  // accessors are safe; without this the two predicates disagree and the 8
  // neighbours of a FAILED chunk can NEVER mesh — 01 §9's intended 1×1 hole
  // becomes a permanent invisible-but-solid 3×3 one.
  captureHood(world, chunk) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const c = world.chunks.get(chunkKey(chunk.cx + dx, chunk.cz + dz));
        if (!c || (c.state < ChunkState.LIT && !(c.state === ChunkState.FAILED && c.blocks))) return false;
        this.hood[(dx + 1) * 3 + (dz + 1)] = c;
      }
    }
    return true;
  }

  // OVERHAUL §W — worker mode: install a plain-data snapshot of the 3×3 hood
  // (9 × {blocks, states, skyLight, blockLight, biomes}, typed arrays). The
  // hood accessors only touch those five fields, so shims stand in for Chunk
  // objects and three.js never enters the worker.
  loadSnapshot(snap) {
    for (let i = 0; i < 9; i++) this.hood[i] = snap.hood[i];
    this.center = snap.center;
    return true;
  }

  chunkOf(wx, wz) { return this.hood[((wx >> 4) + 1) * 3 + ((wz >> 4) + 1)]; }

  // OVERHAUL §B — biome id per column (heightMap/biomes layout: z<<4 | x).
  biomeAt(wx, wz) {
    return this.chunkOf(wx, wz).biomes[((wz & 15) << 4) | (wx & 15)] ?? 3;
  }

  blockAt(wx, wy, wz) {
    if (wy < 0) return B.BEDROCK;
    if (wy > MAX_Y) return B.AIR;
    return this.chunkOf(wx, wz).blocks[(wy << 8) | ((wz & 15) << 4) | (wx & 15)];
  }
  // 01 §8.6 / 15 §12.4 — part of the hood contract; no in-file caller today
  // (hoodWorld.getState routes through it for dustConnections).
  stateAt(wx, wy, wz) {
    if (wy < 0 || wy > MAX_Y) return 0;
    return this.chunkOf(wx, wz).states[(wy << 8) | ((wz & 15) << 4) | (wx & 15)];
  }
  opaqueAt(wx, wy, wz) {
    if (wy < 0) return true;
    if (wy > MAX_Y) return false;
    return BLOCKS[this.chunkOf(wx, wz).blocks[(wy << 8) | ((wz & 15) << 4) | (wx & 15)]].opaque;
  }
  // AMENDS 01 §8.1 — occlusion is a RENDER property, not a light one. Only a
  // full-cube render seals a neighbour's flush face; farmland (15/16) and
  // soul_sand (14/16) are opacity-15 light blockers but SHORT boxes, so culling
  // against them leaves a see-through slit at the boundary. The registry owns
  // the flag (defBlock derives it like `conductive`); until it does, fall back
  // to `opaque` so this is a no-op. AO/smooth-light keep using opaqueAt, where
  // treating them as solid is correct.
  occludesAt(wx, wy, wz) {
    if (wy < 0) return true;
    if (wy > MAX_Y) return false;
    const b = BLOCKS[this.chunkOf(wx, wz).blocks[(wy << 8) | ((wz & 15) << 4) | (wx & 15)]];
    return b.occludes ?? b.opaque;
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
    return this.toGeometries(this.buildCenter(chunk));
  }

  // OVERHAUL §W — worker entry: build from a plain-data snapshot; returns
  // transferable raw arrays (three.js never enters the worker) plus the
  // chunk's Y bounds (computed worker-side on the shim).
  buildFromSnapshot(snap) {
    this.loadSnapshot(snap);
    const raw = this.buildCenter(snap.center);
    raw.minY = this.minY;
    raw.maxY = this.maxY;
    return raw;
  }

  toGeometries(raw) {
    return {
      opaque: raw.opaque && rawToGeometry(raw.opaque),
      cutout: raw.cutout && rawToGeometry(raw.cutout),
      water: raw.water && rawToGeometry(raw.water),
    };
  }

  buildCenter(chunk) {
    builders.opaque.reset(); builders.cutout.reset(); builders.water.reset();
    this.minY = 127; this.maxY = 0;
    this.center = chunk;

    const blocks = chunk.blocks, states = chunk.states;
    for (let i = 0; i < 32768; i++) {
      const id = blocks[i];
      if (id === 0) continue;
      const x = i & 15, z = (i >> 4) & 15, y = i >> 8;
      const blk = BLOCKS[id];
      const st = states[i];
      switch (blk.shape) {
        // OVERHAUL §G — full cubes (incl. the spawner cage cube) are emitted by
        // the dedicated greedy pass below; the scan skips them.
        case 'cube': case 'spawner': break;
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
        // 12-VILLAGES §12.1 — composter: 14/16 hollow box (floor + four walls).
        case 'composter':
          this.emitBox(x, y, z, blk, st, [0, 0, 0, 1, 2 / 16, 1], true);
          this.emitBox(x, y, z, blk, st, [0, 2 / 16, 0, 2 / 16, 1, 1], true);
          this.emitBox(x, y, z, blk, st, [14 / 16, 2 / 16, 0, 1, 1, 1], true);
          this.emitBox(x, y, z, blk, st, [2 / 16, 2 / 16, 0, 14 / 16, 1, 2 / 16], true);
          this.emitBox(x, y, z, blk, st, [2 / 16, 2 / 16, 14 / 16, 14 / 16, 1, 1], true);
          break;
        // §12.1 — lectern: 12/16 base + slant desk (approximated as a raised box).
        case 'lectern':
          this.emitBox(x, y, z, blk, st, [0, 0, 0, 1, 12 / 16, 1], true);
          this.emitBox(x, y, z, blk, st, [1 / 16, 12 / 16, 1 / 16, 15 / 16, 1, 15 / 16], true);
          break;
        // 07-REDSTONE §4.5 — dust is a composed flat figure, not a box.
        case 'wire': this.emitDust(x, y, z, st); break;
        // 07-REDSTONE §13.2 — approximate custom shapes; the base plate/box is
        // rotated ONTO the attach face (§13.3 ATTACH 0-5 in bits0-2). The lever's
        // stick cross-quads and tilt are still skipped. See DEVIATIONS.
        case 'lever': this.emitBox(x, y, z, blk, st, this.attachBox(st, [5 / 16, 0, 5 / 16, 11 / 16, 6 / 16, 11 / 16]), false); break;
        case 'button': this.emitBox(x, y, z, blk, st, this.attachBox(st, [5 / 16, 0, 6 / 16, 11 / 16, 2 / 16, 10 / 16]), false); break;
        case 'plate': this.emitBox(x, y, z, blk, st, [1 / 16, 0, 1 / 16, 15 / 16, 1 / 16, 15 / 16], false); break;
        case 'repeater':
        case 'comparator': this.emitBox(x, y, z, blk, st, [0, 0, 0, 1, 2 / 16, 1], false); break;
        case 'piston_head': this.emitPistonHead(x, y, z, blk, st); break;
        case 'hopper': this.emitBox(x, y, z, blk, st, [0, 0, 0, 1, 1, 1], true); break;
        // 10-NETHER §1.1 — Nether custom shapes. soul_sand's Shape column is
        // "custom: 14/16 top box", so the render box matches its collisionBox.
        case 'soul_sand': this.emitBox(x, y, z, blk, st, [0, 0, 0, 1, 14 / 16, 1], true); break;
        case 'stairs': this.emitStairs(x, y, z, blk, st); break;
        case 'portal': this.emitPortal(x, y, z, blk, st); break;
        // 11-END §2.2 — custom End shapes.
        case 'iron_bars': this.emitPane(x, y, z, blk, st); break;
        case 'end_rod': this.emitEndRod(x, y, z, blk, st); break;
        case 'chorus_plant': this.emitChorus(x, y, z, blk, st); break;
        case 'chorus_flower': this.emitBox(x, y, z, blk, st, [1 / 16, 0, 1 / 16, 15 / 16, 14 / 16, 15 / 16], true); break;
        case 'end_portal': this.emitEndPortal(x, y, z, blk, st, false); break;
        case 'end_gateway': this.emitEndPortal(x, y, z, blk, st, true); break;
        // 13-BOSSES §2.2 — dragon egg (stacked centered tiers), skull box, beacon.
        case 'dragon_egg': this.emitDragonEgg(x, y, z, blk, st); break;
        case 'wither_skull_block': this.emitBox(x, y, z, blk, st, [4 / 16, 0, 4 / 16, 12 / 16, 8 / 16, 12 / 16], false); break;
        case 'beacon': this.emitBeacon(x, y, z, blk, st); break;
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

    this.emitCubesGreedy(chunk);

    if (this.minY > this.maxY) { this.minY = 0; this.maxY = 0; }
    chunk.minY = this.minY; chunk.maxY = this.maxY;
    return {
      opaque: builders.opaque.toRaw(),
      cutout: builders.cutout.toRaw(),
      water: builders.water.toRaw(),
    };
  }

  trackY(y0, y1) {
    if (y0 < this.minY) this.minY = Math.max(0, Math.floor(y0));
    if (y1 > this.maxY) this.maxY = Math.min(127, Math.ceil(y1));
  }

  // ------------------------------------------- OVERHAUL §G — greedy cubes
  // Full-cube faces (incl. the spawner cage) with rect merging. Per face
  // direction and 16×16 layer, every visible cell computes its 4-corner AO +
  // smooth light once (identical math to the old emitCubeFace) and interns a
  // merge key of (tile, tint, corners); cells with the SAME key merge into
  // rects. Light uniformity inside a rect is guaranteed by the key, so a
  // rect's corners reuse the START cell's per-corner values — bit-identical
  // output to the unmerged path, minus an order of magnitude of quads on
  // flat terrain. The ice DOWN-face drop (emitCube's 04 §12.5 guard) and the
  // bucket routing carry over unchanged.

  emitCubesGreedy(chunk) {
    this.keyMap = new Map();
    const blocks = chunk.blocks, states = chunk.states;
    for (let f = 0; f < 6; f++) {
      const n = FACE_NORMALS[f];
      const axis = n[0] !== 0 ? 0 : n[1] !== 0 ? 1 : 2;
      const [t1, t2] = FACE_TANGENTS[f];
      // The chunk is 16×128×16: a Y-normal layer is 128 deep and an X/Z
      // face's tangent grid is 16×128. The original pass scanned every
      // extent as 16 — only the bottom 16³ ever produced faces, so every
      // chunk above y=15 meshed EMPTY (invisible world).
      const dMax = axis === 1 ? 128 : 16;
      const aMax = t1 === 1 ? 128 : 16;
      const bMax = t2 === 1 ? 128 : 16;
      for (let d = 0; d < dMax; d++) this.greedyLayer(blocks, states, f, axis, t1, t2, d, aMax, bMax);
    }
    this.keyMap = null;
  }

  greedyLayer(blocks, states, f, axis, t1, t2, d, aMax, bMax) {
    const mKey = GREEDY_KEYS;                 // Int32Array(2048); 0 = no face
    mKey.fill(0);
    const n = FACE_NORMALS[f];
    const hood = this.hood;                   // local refs for the hot loop
    for (let b = 0; b < bMax; b++) {
      const rowBase = b * aMax;
      for (let a = 0; a < aMax; a++) {
        // mask grid (a along t1, b along t2) → cell coords; d carries the
        // normal axis. (a,b,d) partition the three axes — the old hardcoded
        // x=d/a, y=d/a, z=b table collapsed Z faces onto the x=y diagonal.
        const x = axis === 0 ? d : (t1 === 0 ? a : b);
        const y = axis === 1 ? d : (t1 === 1 ? a : b);
        const z = axis === 2 ? d : (t1 === 2 ? a : b);
        const ci = (y << 8) | (z << 4) | x;
        const id = blocks[ci];
        if (id === 0) continue;
        const blk = BLOCKS[id];
        if (blk.shape !== 'cube' && blk.shape !== 'spawner') continue;
        const builder = builders[blk.bucket] || builders.opaque;
        const nx = x + n[0], ny = y + n[1], nz = z + n[2];
        // 04 §12.5 — ice's DOWN face against open water is dropped (see the
        // emitCube history comment; ice is the only water-bucket cube).
        if (f === 3 && builder === builders.water && this.isWaterCell(nx, ny, nz)) continue;
        if (!this.faceVisible(blk, this.blockAt(nx, ny, nz))) continue;
        this.cornerLight(x, y, z, f, n);
        // OVERHAUL §B — biome tint rides the merge key (grass tops + foliage);
        // tint changes at biome borders break merges exactly there.
        let tr = 255, tg = 255, tb = 255;
        if (blk.tint === 'grass_top') {
          if (f === 2) {
            const t = biomeTint(this.biomeAt(x, z)).grass;
            tr = t[0]; tg = t[1]; tb = t[2];
          }
        } else if (blk.tint === 'foliage') {
          const t = biomeTint(this.biomeAt(x, z)).foliage;
          tr = t[0]; tg = t[1]; tb = t[2];
        }
        const k0 = (CSKY[0] << 10) | (CBLK[0] << 2) | CAO[0];
        const k1 = (CSKY[1] << 10) | (CBLK[1] << 2) | CAO[1];
        const k2 = (CSKY[2] << 10) | (CBLK[2] << 2) | CAO[2];
        const k3 = (CSKY[3] << 10) | (CBLK[3] << 2) | CAO[3];
        const tile = this.tileFor(blk, states[ci], f);
        // blk.id in the key: no two cube blocks share a tile today, but the
        // bucket lives on the interned tuple — a future tile-sharing pair
        // would otherwise merge across a bucket boundary.
        const key = tile + ',' + blk.id + ',' + tr + ',' + tg + ',' + tb + ','
          + k0 + ',' + k1 + ',' + k2 + ',' + k3;
        let tuple = this.keyMap.get(key);
        if (tuple === undefined) {
          tuple = {
            tile, tr, tg, tb, bld: builder,
            sky: [CSKY[0], CSKY[1], CSKY[2], CSKY[3]],
            blk: [CBLK[0], CBLK[1], CBLK[2], CBLK[3]],
            ao: [CAO[0], CAO[1], CAO[2], CAO[3]],
          };
          this.keyMap.set(key, tuple);
        }
        mKey[rowBase | a] = 1;
        GREEDY_TUPLES[rowBase | a] = tuple;
      }
    }
    // 0fps greedy rect expansion: grow w along t1, then h along t2.
    for (let b = 0; b < bMax; b++) {
      const rowBase = b * aMax;
      for (let a = 0; a < aMax; ) {
        if (!mKey[rowBase | a]) { a++; continue; }
        const tuple = GREEDY_TUPLES[rowBase | a];
        let w = 1;
        while (a + w < aMax && mKey[rowBase | (a + w)] && GREEDY_TUPLES[rowBase | (a + w)] === tuple) w++;
        let h = 1;
        outer: while (b + h < bMax) {
          for (let ww = 0; ww < w; ww++) {
            const m = (b + h) * aMax | (a + ww);
            if (!mKey[m] || GREEDY_TUPLES[m] !== tuple) break outer;
          }
          h++;
        }
        for (let hh = 0; hh < h; hh++) {
          for (let ww = 0; ww < w; ww++) mKey[(b + hh) * aMax | (a + ww)] = 0;
        }
        this.emitCubeRect(f, axis, t1, t2, d, a, b, w, h, tuple);
        a += w;
      }
    }
  }

  emitCubeRect(f, axis, t1, t2, d, a, b, w, h, tuple) {
    const builder = tuple.bld;
    builder.ensure(4, 6);
    const n = FACE_NORMALS[f];
    const x = axis === 0 ? d : (t1 === 0 ? a : b);
    const y = axis === 1 ? d : (t1 === 1 ? a : b);
    const z = axis === 2 ? d : (t1 === 2 ? a : b);
    const uvr = this.tileUV, t4 = tuple.tile * 4;
    const shade = FACE_SHADE[f];
    // span sentinels + merged-tile origin — the shader's fract() path keys
    // off the span sum (see materials.js), so single-tile rects (1,1) use it
    // too and non-greedy emitters' absolute UVs are untouched.
    builder.su = w + SPAN_EPS; builder.sv = h + SPAN_EPS;
    builder.tu = uvr[t4]; builder.tv = uvr[t4 + 1];
    builder.tr = tuple.tr; builder.tg = tuple.tg; builder.tb = tuple.tb;
    // texture repeats once per merged cell: u runs along UV_U_T[f]'s axis
    // (which of the two tangent axes FACE_UVS varies u on), v along UV_V_T's.
    const uS = (UV_U_T[f] === t1 ? w : h) - UV_EPS;
    const vS = (UV_V_T[f] === t1 ? w : h) - UV_EPS;
    const verts = V4;
    for (let c = 0; c < 4; c++) {
      const co = FACE_CORNERS[f][c];
      const sco = SCRATCH3;
      sco[0] = co[0]; sco[1] = co[1]; sco[2] = co[2];
      sco[t1] = co[t1] ? w : 0;
      sco[t2] = co[t2] ? h : 0;
      const uu = FACE_UVS[f][c][0], vv = FACE_UVS[f][c][1];
      verts[c] = builder.vertex(
        x + sco[0], y + sco[1], z + sco[2], n[0], n[1], n[2],
        uu ? uS : 0, vv ? vS : 0,
        tuple.sky[c], tuple.blk[c],
        Math.round(255 * AO_CURVE[tuple.ao[c]] * shade),
      );
    }
    builder.quad(verts[0], verts[1], verts[2], verts[3],
      tuple.ao[0] + tuple.ao[2] > tuple.ao[1] + tuple.ao[3]);
    // the rect may span many cells along Y (tangent axis 1) — track the full
    // extent or the bounding sphere clips merged cliff faces
    this.trackY(y, y + (t1 === 1 ? w : t2 === 1 ? h : 1));
  }

  faceVisible(a, bId) {
    if (bId === B.AIR) return true;
    const b = BLOCKS[bId];
    if (b.occludes ?? b.opaque) return false;   // see occludesAt (AMENDS §8.1)
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
    return !this.occludesAt(wx, wy, wz);
  }

  // OVERHAUL §G — the 01 §8.3 per-corner AO + smooth-light math, extracted
  // from the old emitCubeFace so the greedy mask can key on it. Fills the
  // module-scratch CSKY/CBLK/CAO arrays (corner order = FACE_CORNERS[f]);
  // light channels are pre-quantized to the vCol scale (×17).
  cornerLight(x, y, z, f, n) {
    const bx = x + n[0], by = y + n[1], bz = z + n[2];
    const [t1a, t2a] = FACE_TANGENTS[f];
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
      CAO[c] = (side1 && side2) ? 0 : 3 - (side1 + side2 + cornerOcc);

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
      if (cnt === 0) {
        CSKY[c] = this.skyAt(bx, by, bz) * 17;
        CBLK[c] = this.blockLightAt(bx, by, bz) * 17;
      } else {
        CSKY[c] = Math.round(skySum / cnt * 17);
        CBLK[c] = Math.round(blkSum / cnt * 17);
      }
    }
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
    // 04 §12.5 — the freeze loop replaces the TOP water block of a cold lake
    // with ice, a full cube in the SAME translucent bucket (ice is opacity 1,
    // not water, so neither sameFluid nor occludesAt catches it). Cap the
    // surface at y+1 and drop its top face, or the water floats 1/8 below the
    // ice with a see-through band between them and a doubled blend from above.
    const capped = water && this.blockAt(x, y + 1, z) === B.ICE;
    const h = (capped || sameFluid(x, y + 1, z)) ? 1 : 0.875;
    // OVERHAUL §B — water takes its biome color; lava stays intrinsic
    const wTint = water ? biomeTint(this.biomeAt(x, z)).water : null;
    for (let f = 0; f < 6; f++) {
      // with h = 1 the top face is coplanar with the ice's bottom face: z-fight.
      if (f === 2 && capped) continue;
      const n = FACE_NORMALS[f];
      const nx = x + n[0], ny = y + n[1], nz = z + n[2];
      // §12.3 lives in ONE place: water routes through waterFaceVisible (which
      // folds in the same-fluid test); lava keeps the plain id/opaque test.
      if (water) { if (!this.waterFaceVisible(nx, ny, nz)) continue; }
      else if (sameFluid(nx, ny, nz) || this.occludesAt(nx, ny, nz)) continue;
      this.emitFlatFace(builder, x, y, z, f, blk.tileIndex[f], h,
        this.skyAt(nx, ny, nz), this.blockLightAt(nx, ny, nz),
        Math.round((blk.fluidAlpha ?? 1) * 255), wTint);
    }
  }

  /**
   * 15 §12 — a bit-7 cell emits TWO contributions in the same sweep: its normal
   * block mesh (emitted by the shape switch, unchanged) AND this water geometry
   * in the water bucket.
   */
  emitWaterlogged(x, y, z, blk) {
    // §12.2 full-cube rule: a chest (or the spawner cage cube) emits NO water of
    // its own — the water is logically present but visually inside the cube, and
    // neighbouring water culls toward it via isWaterCell, so it sits flush with
    // no phantom sleeve.
    if (blk.shape === 'cube' || blk.shape === 'spawner') return;

    const builder = builders.water;
    const water = BLOCKS[B.WATER];
    const alpha = Math.round((water.fluidAlpha ?? 1) * 255);
    // OVERHAUL §B — waterlogged geometry wears the same biome water color.
    const wTint = biomeTint(this.biomeAt(x, z)).water;
    const aboveWater = this.isWaterCell(x, y + 1, z);
    // 04 §12.5 — the same cap emitLiquid applies: ice above is a full cube in
    // THIS bucket and now culls its down face toward a water cell, so raise the
    // surface to the cell boundary and drop the top face here too. Without it a
    // waterlogged cell under ice would show a 1/8 see-through band, and with it
    // there is exactly one translucent layer at the boundary instead of two.
    const capped = this.blockAt(x, y + 1, z) === B.ICE;
    const sideTop = (capped || aboveWater) ? 1.0 : 0.875;

    // top face at the standard lowered source surface, only if nothing above
    if (!aboveWater && !capped) {
      this.emitFlatFace(builder, x, y, z, 2, water.tileIndex[2], 0.875,
        this.skyAt(x, y + 1, z), this.blockLightAt(x, y + 1, z), alpha, wTint);
    }
    // sides at the exact cell-boundary plane
    for (const f of [0, 1, 4, 5]) {
      const n = FACE_NORMALS[f];
      const nx = x + n[0], ny = y + n[1], nz = z + n[2];
      if (!this.waterFaceVisible(nx, ny, nz)) continue;   // §12.3, the one helper
      this.emitFlatFace(builder, x, y, z, f, water.tileIndex[f], sideTop,
        this.skyAt(nx, ny, nz), this.blockLightAt(nx, ny, nz), alpha, wTint);
    }
    // bottom
    if (this.waterFaceVisible(x, y - 1, z)) {
      this.emitFlatFace(builder, x, y, z, 3, water.tileIndex[3], 1,
        this.skyAt(x, y - 1, z), this.blockLightAt(x, y - 1, z), alpha, wTint);
    }
  }

  // Flat-lit cube face with a scaled top (liquids).
  // OVERHAUL §B — `tint` is an [r,g,b] biome color (water surfaces) or null;
  // it rides the builder's per-quad state (quad() resets it).
  emitFlatFace(builder, x, y, z, f, tile, h, skyV, blkV, alpha = 255, tint = null) {
    builder.ensure(4, 6);
    const n = FACE_NORMALS[f];
    const uvr = this.tileUV, t4 = tile * 4;
    const u0 = uvr[t4], v0 = uvr[t4 + 1], u1 = uvr[t4 + 2], v1 = uvr[t4 + 3];
    const shade = FACE_SHADE[f];
    const r = Math.round(skyV * 17), g = Math.round(blkV * 17);
    const b = Math.round(255 * shade);
    if (tint) { builder.tr = tint[0]; builder.tg = tint[1]; builder.tb = tint[2]; }
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

  // Torch: 2/16 box; wall states offset toward the supporting block.
  // The two torch ids encode their orientation DIFFERENTLY, so the raw state
  // byte must never be compared directly:
  //   06 §3 torch (38): nibble 1-4 = the direction the torch FACES, support at
  //     pos − WALL_DIR[nibble].
  //   07 §13.3 redstone_torch (71): bits0-2 = ATTACH (support direction) and
  //     bit3 = lit, so a lit wall torch is 9-12 — it used to match no branch and
  //     snap to the cell centre on every toggle, while an unlit one offset with
  //     the wrong (WALL_DIR) mapping.
  emitTorch(x, y, z, blk, st) {
    let dx = 0, dz = 0;
    if (blk.id === B.REDSTONE_TORCH) {
      const a = st & 0x07;
      if (a >= 1 && a <= 4) { const d = ATTACH_DIR[a]; dx = d[0]; dz = d[2]; }
    } else {
      const d = WALL_DIR[st & STATE_NIBBLE];
      if (d) { dx = -d[0]; dz = -d[2]; }
    }
    const ox = dx * 0.30, oz = dz * 0.30, oy = (dx || dz) ? 3 / 16 : 0;
    const b = [7 / 16 + ox, oy, 7 / 16 + oz, 9 / 16 + ox, 10 / 16 + oy, 9 / 16 + oz];
    this.emitBox(x, y, z, blk, st, b, false);
  }

  // 07-REDSTONE §13.2 — lever/button boxes sit ON their attach face, not on the
  // cell floor; §13.3 puts ATTACH 0-5 in bits0-2 (written by redstonePlaceState,
  // read by checkSupport). `b` is the floor form: its Y interval is the mount
  // thickness, so map that onto the attach axis and the two broad axes onto the
  // remaining pair. Wall states used to leave the box lying on the floor with a
  // visible gap between it and the wall it is electrically attached to.
  attachBox(st, b) {
    const [x0, y0, z0, x1, y1, z1] = b;
    switch (st & 0x07) {
      case 1: return [x0, z0, y0, x1, z1, y1];               // support −Z (north wall)
      case 2: return [1 - y1, x0, z0, 1 - y0, x1, z1];       // support +X (east wall)
      case 3: return [x0, z0, 1 - y1, x1, z1, 1 - y0];       // support +Z (south wall)
      case 4: return [y0, x0, z0, y1, x1, z1];               // support −X (west wall)
      case 5: return [x0, 1 - y1, z0, x1, 1 - y0, z1];       // ceiling
      default: return b;                                     // 0 floor
    }
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

  // ------------------------------------------------------------ 07-REDSTONE §4.5 dust

  /**
   * §4.5 — redstone dust. Not a box: a flat figure at y + 1/64 in the cutout
   * bucket, composed of a centred 6×6 px `dust_dot` quad plus one 5×6 px
   * `dust_line` arm per rendered direction, in the power-tinted variant picked
   * by state bits0–3 (§13.3). The registry's single `dust_line_0` tile is
   * bypassed on purpose — tilesFor() is keyed on (nibble, face) and can only
   * name ONE tile per face, while a dust cell needs both dot and line.
   * Unlit by AO/shade (§4.5): AO = 1.0, shade = 1.0, so vCol.b = 255 and the
   * cell's own sky/block light is the only modulation. Never culled.
   * §4.2 shape rule, kept identical to dustOutputDirs(): 0 connections render as
   * a CROSS, exactly 1 as a straight LINE along that axis, else the connected
   * arms. The graph itself comes from dustConnections() — never re-derived here.
   */
  emitDust(x, y, z, st) {
    const p = st & 0x0f;                      // §13.3 power, bits0–3
    const dot = DUST_DOT_TILE[p], line = DUST_LINE_TILE[p];
    const [sky, bl] = this.ownLight(x, y, z);
    const r = Math.round(sky * 17), g = Math.round(bl * 17);
    const bld = builders.cutout;
    const yy = y + 1 / 64;
    const lo = 5 / 16, hi = 11 / 16;           // the centre dot's 6 px footprint

    const conns = dustConnections(this.hoodWorld, x, y, z);
    const on = [conns[0] !== CONN.NONE, conns[1] !== CONN.NONE,
                conns[2] !== CONN.NONE, conns[3] !== CONN.NONE];
    const count = on[0] + on[1] + on[2] + on[3];
    let arms;
    if (count === 0) arms = [true, true, true, true];             // cross
    else if (count === 1) {                                        // straight line
      const i = on[0] ? 0 : on[1] ? 1 : on[2] ? 2 : 3;
      arms = [false, false, false, false];
      arms[i] = true; arms[(i + 2) & 3] = true;                    // same axis, both ways
    } else arms = on;

    // centre dot: tile px 5..11 over the cell's centre 6 px, u→X, v→Z.
    this.emitDustQuad(bld, dot, x + lo, z + lo, x + hi, z + hi, yy, 5, 5, 11, 11, false, r, g);
    // arms in HFACE order N(−Z), E(+X), S(+Z), W(−X). The line tile's 4 px band
    // runs along its u axis, so the ±Z arms sample it with u/v SWAPPED — the line
    // must run along the arm, not across it. Each arm takes the tile half on its
    // own side (px 0..5 for −X/−Z, px 11..16 for +X/+Z); the band is featureless
    // along its length so the halves are interchangeable.
    if (arms[0]) this.emitDustQuad(bld, line, x + lo, z, x + hi, z + lo, yy, 0, 5, 5, 11, true, r, g);
    if (arms[1]) this.emitDustQuad(bld, line, x + hi, z + lo, x + 1, z + hi, yy, 11, 5, 16, 11, false, r, g);
    if (arms[2]) this.emitDustQuad(bld, line, x + lo, z + hi, x + hi, z + 1, yy, 11, 5, 16, 11, true, r, g);
    if (arms[3]) this.emitDustQuad(bld, line, x, z + lo, x + lo, z + hi, yy, 0, 5, 5, 11, false, r, g);
    this.trackY(y, y + 1 / 64);

    // §4.5 — an UP_SLOPE additionally climbs the neighbour block's facing side.
    for (let i = 0; i < 4; i++) {
      if (conns[i] === CONN.UP_SLOPE) this.emitDustRiser(bld, x, y, z, i, line, r, g);
    }
  }

  /**
   * §4.5 — one flat dust quad at height `yy` covering [x0,x1]×[z0,z1], textured
   * from the tile-local pixel rect (px0,py0)–(px1,py1). UVs are built from the
   * tile index directly rather than lerped inside this.tileUV, whose rect is
   * already half-texel inset (0.5..15.5) — lerping it would squeeze the window.
   * The same half-texel convention is applied to the sub-rect here.
   * `swap` maps the tile's u axis to world Z instead of world X.
   * Winding follows FACE_CORNERS[+Y]: (x0,z1),(x1,z1),(x1,z0),(x0,z0).
   */
  emitDustQuad(bld, tile, x0, z0, x1, z1, yy, px0, py0, px1, py1, swap, r, g) {
    bld.ensure(4, 6);
    // OVERHAUL §A — cell/gutter atlas layout: px coords are tile-local 16ths,
    // scaled by the tile resolution (K = TILE_PX/16); the half-texel inset and
    // /ATLAS_SIZE replace the old /512 literals.
    const K = TILE_PX / 16;
    const cx = cellX(tile) + ATLAS_GUTTER, cy = cellY(tile) + ATLAS_GUTTER;
    const u0 = (cx + px0 * K + 0.5) / ATLAS_SIZE, u1 = (cx + px1 * K - 0.5) / ATLAS_SIZE;
    const v0 = (cy + py0 * K + 0.5) / ATLAS_SIZE, v1 = (cy + py1 * K - 0.5) / ATLAS_SIZE;
    const a = bld.vertex(x0, yy, z1, 0, 1, 0, swap ? u1 : u0, swap ? v0 : v1, r, g, 255);
    const b = bld.vertex(x1, yy, z1, 0, 1, 0, u1, v1, r, g, 255);
    const c = bld.vertex(x1, yy, z0, 0, 1, 0, swap ? u0 : u1, swap ? v1 : v0, r, g, 255);
    const d = bld.vertex(x0, yy, z0, 0, 1, 0, u0, v0, r, g, 255);
    bld.quad(a, b, c, d, false);
  }

  /**
   * §4.5 — the UP_SLOPE riser: a full 16×16 `dust_line` quad flat against the
   * side of the neighbour block the dust climbs, offset 1/64 out of that face so
   * it never z-fights. `hf` is the HFACE the dust connects along (0 N, 1 E, 2 S,
   * 3 W). u→Y and v→the horizontal axis, so the band runs vertically — along the
   * climb. Own-cell light, AO/shade 1.0, as the flat part.
   */
  emitDustRiser(bld, x, y, z, hf, tile, r, g) {
    bld.ensure(4, 6);
    const uvr = this.tileUV, t4 = tile * 4;
    const u0 = uvr[t4], v0 = uvr[t4 + 1], u1 = uvr[t4 + 2], v1 = uvr[t4 + 3];
    const e = 1 / 64, y1 = y + 1;
    let a, b, c, d;
    if (hf === 1) {          // E: the neighbour's −X face
      const px = x + 1 - e;
      a = bld.vertex(px, y, z + 1, -1, 0, 0, u0, v1, r, g, 255);
      b = bld.vertex(px, y1, z + 1, -1, 0, 0, u1, v1, r, g, 255);
      c = bld.vertex(px, y1, z, -1, 0, 0, u1, v0, r, g, 255);
      d = bld.vertex(px, y, z, -1, 0, 0, u0, v0, r, g, 255);
    } else if (hf === 3) {   // W: the neighbour's +X face
      const px = x + e;
      a = bld.vertex(px, y, z, 1, 0, 0, u0, v0, r, g, 255);
      b = bld.vertex(px, y1, z, 1, 0, 0, u1, v0, r, g, 255);
      c = bld.vertex(px, y1, z + 1, 1, 0, 0, u1, v1, r, g, 255);
      d = bld.vertex(px, y, z + 1, 1, 0, 0, u0, v1, r, g, 255);
    } else if (hf === 2) {   // S: the neighbour's −Z face
      const pz = z + 1 - e;
      a = bld.vertex(x + 1, y, pz, 0, 0, -1, u0, v1, r, g, 255);
      b = bld.vertex(x, y, pz, 0, 0, -1, u0, v0, r, g, 255);
      c = bld.vertex(x, y1, pz, 0, 0, -1, u1, v0, r, g, 255);
      d = bld.vertex(x + 1, y1, pz, 0, 0, -1, u1, v1, r, g, 255);
    } else {                 // N: the neighbour's +Z face
      const pz = z + e;
      a = bld.vertex(x, y, pz, 0, 0, 1, u0, v0, r, g, 255);
      b = bld.vertex(x + 1, y, pz, 0, 0, 1, u0, v1, r, g, 255);
      c = bld.vertex(x + 1, y1, pz, 0, 0, 1, u1, v1, r, g, 255);
      d = bld.vertex(x, y1, pz, 0, 0, 1, u1, v0, r, g, 255);
    }
    bld.quad(a, b, c, d, false);
    this.trackY(y, y1);
  }

  // 07-REDSTONE §13.2 row 81 — the head is a 4/16 plate on the EXTENSION side
  // plus a 4×4 px arm running back to the base, NOT a full cube. §13.3: bits0-2
  // FACE6 (PistonMover.headStateFor copies the base's), bit3 sticky. The block's
  // tilesFor is face-blind, so the plate wears the (sticky) face tile on every
  // side; the arm overrides it with the piston's own side tile (§14 recipe).
  // The arm stops 2/16 inside the plate: reaching the plate's outer plane would
  // put two coplanar quads on it (the cutout material is DoubleSide) and
  // z-fight. Its base-side end IS flush, so it is emitted with cull = true and
  // the flush test drops it against the piston base.
  emitPistonHead(x, y, z, blk, st) {
    const d = FACE6_DIR[st & 0x07];
    const axis = d[0] ? 0 : d[1] ? 1 : 2;
    const plate = [0, 0, 0, 1, 1, 1];
    const arm = [6 / 16, 6 / 16, 6 / 16, 10 / 16, 10 / 16, 10 / 16];
    if (d[axis] > 0) { plate[axis] = 12 / 16; arm[axis] = 0; arm[axis + 3] = 14 / 16; }
    else { plate[axis + 3] = 4 / 16; arm[axis] = 2 / 16; arm[axis + 3] = 1; }
    this.emitBox(x, y, z, blk, st, plate, true);
    this.emitBox(x, y, z, blk, st, arm, true, { tile: BLOCKS[B.PISTON].tileIndex[0] });
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

  // 10-NETHER §1.1 — stairs: the 2-box L profile. bits0-1 = facing, using the
  // registry's shared facing enum (0 = +Z, 1 = −X, 2 = −Z, 3 = +X, as doorBox);
  // bit2 = half (0 bottom, 1 top). The half-step sits on the facing side.
  emitStairs(x, y, z, blk, st) {
    // 15 §8 — MASK the nibble: bit7 waterlogging is not part of the orientation.
    const s = st & STATE_NIBBLE;
    const facing = s & 3, top = (s & 4) !== 0;
    const slab = top ? [0, 8 / 16, 0, 1, 1, 1] : [0, 0, 0, 1, 8 / 16, 1];
    const y0 = top ? 0 : 8 / 16, y1 = top ? 8 / 16 : 1;
    let step;
    if (facing === 0) step = [0, y0, 8 / 16, 1, y1, 1];         // +Z half
    else if (facing === 1) step = [0, y0, 0, 8 / 16, y1, 1];    // −X half
    else if (facing === 2) step = [0, y0, 0, 1, y1, 8 / 16];    // −Z half
    else step = [8 / 16, y0, 0, 1, y1, 1];                      // +X half
    this.emitBox(x, y, z, blk, st, slab, true);
    this.emitBox(x, y, z, blk, st, step, true);
  }

  // 10-NETHER §3.3 — nether portal: a 2/16-thick vertical pane centered in the
  // cell, filling the frame interior. state bit0 = axis (0 = frame spans X, so
  // the pane faces ±Z; 1 = spans Z, faces ±X). The spec's `tr` bucket is the
  // mesher's translucent (water) builder, as 11's end_portal.
  emitPortal(x, y, z, blk, st) {
    const [sky, bl] = this.ownLight(x, y, z);
    const box = (st & 1)
      ? [7 / 16, 0, 0, 9 / 16, 1, 1]
      : [0, 0, 7 / 16, 1, 1, 9 / 16];
    this.emitWaterBox(x, y, z, box, this.tileFor(blk, st, 4), sky, bl, 220);
  }

  // 11-END §2.2 — iron_bars: 2/16 center post + flat panes toward connecting
  // neighbors (iron_bars or opaque cube), fence-style scan.
  emitPane(x, y, z, blk, st) {
    this.emitBox(x, y, z, blk, st, [7 / 16, 0, 7 / 16, 9 / 16, 1, 9 / 16], false);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of dirs) {
      const nb = BLOCKS[this.blockAt(x + dx, y, z + dz)];
      if (!(nb.shape === 'iron_bars' || nb.opaque)) continue;
      let b;
      if (dx === 1) b = [8 / 16, 0, 7 / 16, 1, 1, 9 / 16];
      else if (dx === -1) b = [0, 0, 7 / 16, 8 / 16, 1, 9 / 16];
      else if (dz === 1) b = [7 / 16, 0, 8 / 16, 9 / 16, 1, 1];
      else b = [7 / 16, 0, 0, 9 / 16, 1, 8 / 16];
      this.emitBox(x, y, z, blk, st, b, false);
    }
  }

  // 11-END §2.2 — end_rod: 4/16 rod along its facing axis + 6/16 base knob.
  // state bits0-2: 0 up, 1 down, 2 N(−Z), 3 S(+Z), 4 W(−X), 5 E(+X).
  emitEndRod(x, y, z, blk, st) {
    const f = (st & 7);
    if (f <= 1) {   // vertical
      this.emitBox(x, y, z, blk, st, [6 / 16, 0, 6 / 16, 10 / 16, 1, 10 / 16], false);
      const ky = f === 0 ? 0 : 15 / 16;
      this.emitBox(x, y, z, blk, st, [5 / 16, ky, 5 / 16, 11 / 16, ky + 1 / 16, 11 / 16], false);
    } else if (f === 2 || f === 4) {   // §2.2 enum 2 = N(-Z), 4 = S(+Z) — along Z
      this.emitBox(x, y, z, blk, st, [6 / 16, 6 / 16, 0, 10 / 16, 10 / 16, 1], false);
    } else {   // 3 = E(+X), 5 = W(-X) — along X
      this.emitBox(x, y, z, blk, st, [0, 6 / 16, 6 / 16, 1, 10 / 16, 10 / 16], false);
    }
  }

  // 11-END §2.2 — chorus_plant: 10/16 core box + 6/16 arms toward chorus/end_stone.
  emitChorus(x, y, z, blk, st) {
    this.emitBox(x, y, z, blk, st, [3 / 16, 3 / 16, 3 / 16, 13 / 16, 13 / 16, 13 / 16], false);
    const dirs6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const [dx, dy, dz] of dirs6) {
      const nid = this.blockAt(x + dx, y + dy, z + dz);
      const nb = BLOCKS[nid];
      if (!(nb.shape === 'chorus_plant' || nid === 160 /*flower*/ || nid === 154 /*end_stone*/)) continue;
      let b = [5 / 16, 5 / 16, 5 / 16, 11 / 16, 11 / 16, 11 / 16];
      if (dx === 1) b = [11 / 16, 5 / 16, 5 / 16, 1, 11 / 16, 11 / 16];
      else if (dx === -1) b = [0, 5 / 16, 5 / 16, 5 / 16, 11 / 16, 11 / 16];
      else if (dy === 1) b = [5 / 16, 11 / 16, 5 / 16, 11 / 16, 1, 11 / 16];
      else if (dy === -1) b = [5 / 16, 0, 5 / 16, 11 / 16, 5 / 16, 11 / 16];
      else if (dz === 1) b = [5 / 16, 5 / 16, 11 / 16, 11 / 16, 11 / 16, 1];
      else b = [5 / 16, 5 / 16, 0, 11 / 16, 11 / 16, 5 / 16];
      this.emitBox(x, y, z, blk, st, b, false);
    }
  }

  // 11-END §2.2/§14 — end_portal: horizontal starfield quad at 12/16; end_gateway
  // adds a full dark core. Rendered translucent via the water builder.
  emitEndPortal(x, y, z, blk, st, gateway) {
    const [sky, bl] = this.ownLight(x, y, z);
    const tile = this.tileFor(blk, st, 2);
    if (gateway) {
      // full-cube dark core into the water (translucent) builder — reuse the box
      // path but re-route: emit each face manually into builders.water.
      this.emitWaterCube(x, y, z, tile, sky, bl);
    } else {
      this.emitFlatFace(builders.water, x, y, z, 2, tile, 12 / 16, sky, bl, 220);
    }
  }

  // 13-BOSSES §2.2 — dragon egg: 8 stacked centered box tiers (px widths
  // 2,6,10,14,16,14,10,6 bottom→top over heights 1,1,2,3,4,2,2,1).
  emitDragonEgg(x, y, z, blk, st) {
    const tiers = [[2, 1], [6, 1], [10, 2], [14, 3], [16, 4], [14, 2], [10, 2], [6, 1]];
    let yy = 0;
    for (const [w, h] of tiers) {
      const o = (16 - w) / 2 / 16, w16 = w / 16;
      this.emitBox(x, y, z, blk, st, [o, yy / 16, o, o + w16, (yy + h) / 16, o + w16], false);
      yy += h;
    }
  }

  // 13-BOSSES §2.2 — beacon: 2px obsidian base (cutout) + full glass shell +
  // floating emissive core (both translucent via the water builder).
  emitBeacon(x, y, z, blk, st) {
    // 13 §2.2 — ALL six faces of the 2px plinth are the obsidian base tile.
    // beacon's tilesFor is written for the 16³ shell (face 2 = core, 3 = base,
    // else shell), so without the override the plinth wore the emissive core on
    // top and glass on its sides, and the obsidian tile appeared nowhere.
    this.emitBox(x, y, z, blk, st, [0, 0, 0, 1, 2 / 16, 1], false, { tile: this.tileFor(blk, st, 3) });
    const [sky, bl] = this.ownLight(x, y, z);
    this.emitWaterCube(x, y, z, this.tileFor(blk, st, 4), sky, bl);   // glass shell (beacon_shell, side faces)
    // floating 10³ emissive core
    this.emitWaterBox(x, y, z, [3 / 16, 3 / 16, 3 / 16, 13 / 16, 13 / 16, 13 / 16], this.tileFor(blk, st, 2), sky, bl);
  }

  // A sub-cube box into the translucent water builder (beacon core, portal pane).
  emitWaterBox(x, y, z, box, tile, skyV, blkV, alpha = 255) {
    const bld = builders.water;
    const [x0, y0, z0, x1, y1, z1] = box;
    const uvr = this.tileUV, t4 = tile * 4;
    const U0 = uvr[t4], V0 = uvr[t4 + 1], U1 = uvr[t4 + 2], V1 = uvr[t4 + 3];
    const r = Math.round(skyV * 17), g = Math.round(blkV * 17);
    for (let f = 0; f < 6; f++) {
      const n = FACE_NORMALS[f];
      const bcol = Math.round(255 * FACE_SHADE[f]);
      bld.ensure(4, 6);
      const verts = V4;
      for (let c = 0; c < 4; c++) {
        const co = FACE_CORNERS[f][c];
        const px = co[0] ? x1 : x0, py = co[1] ? y1 : y0, pz = co[2] ? z1 : z0;
        const uu = FACE_UVS[f][c][0], vv = FACE_UVS[f][c][1];
        verts[c] = bld.vertex(x + px, y + py, z + pz, n[0], n[1], n[2],
          U0 + (U1 - U0) * uu, V0 + (V1 - V0) * vv, r, g, bcol, alpha);
      }
      bld.quad(verts[0], verts[1], verts[2], verts[3], false);
    }
    this.trackY(y + y0, y + y1);
  }

  // Full cube into the translucent water builder (end_gateway core).
  emitWaterCube(x, y, z, tile, skyV, blkV) {
    const bld = builders.water;
    const uvr = this.tileUV, t4 = tile * 4;
    const U0 = uvr[t4], V0 = uvr[t4 + 1], U1 = uvr[t4 + 2], V1 = uvr[t4 + 3];
    const r = Math.round(skyV * 17), g = Math.round(blkV * 17);
    for (let f = 0; f < 6; f++) {
      const n = FACE_NORMALS[f];
      const shade = FACE_SHADE[f], bcol = Math.round(255 * shade);
      bld.ensure(4, 6);
      const verts = V4;
      for (let c = 0; c < 4; c++) {
        const co = FACE_CORNERS[f][c];
        const uu = FACE_UVS[f][c][0], vv = FACE_UVS[f][c][1];
        verts[c] = bld.vertex(
          x + co[0], y + co[1], z + co[2], n[0], n[1], n[2],
          U0 + (U1 - U0) * uu, V0 + (V1 - V0) * vv, r, g, bcol, 235,
        );
      }
      bld.quad(verts[0], verts[1], verts[2], verts[3], false);
    }
    this.trackY(y, y + 1);
  }

  // Generic box emitter: flat own-cell light, directional shade, cropped UVs.
  emitBox(x, y, z, blk, st, box, cull, opts = {}) {
    // 01 §8.4 — custom shapes light from their OWN cell. farmland (55) and
    // soul_sand (119) are the only opacity-15 box shapes (06 §3 / 10 §1.1 both
    // give Opac = O), and 04 §9.2's BFS never writes light into an opacity-15
    // cell, so ownLight reads 0/0 and they render at the ambient floor. Both are
    // top-boxes whose visible faces open upward: sample the cell above instead.
    const [sky, bl] = blk.opacity >= 15
      ? [this.skyAt(x, y + 1, z), this.blockLightAt(x, y + 1, z)]
      : this.ownLight(x, y, z);
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
          // occludesAt, not opaqueAt (AMENDS 01 §8.1): farmland (15/16) and
          // soul_sand (14/16) block light but do not seal the cell, so a flush
          // face against them must still be drawn or the boundary slits open.
          const n = FACE_NORMALS[f];
          if (this.occludesAt(x + n[0], y + n[1], z + n[2])) continue;
        }
      }
      const n = FACE_NORMALS[f];
      const tile = opts.tile ?? this.tileFor(blk, st, f);
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

const V4 = [0, 0, 0, 0];

// OVERHAUL §G — greedy scratch: per-corner light (cornerLight), the layer
// mask (16×128 max — X/Z-face tangent grids span the full chunk height),
// per-cell merge tuples, and a reused position scratch. All
// module-level, so a build() allocates nothing in the hot path beyond the
// keyMap/tuple objects (which the worker's GC absorbs off-thread).
const CSKY = new Uint8Array(4);
const CBLK = new Uint8Array(4);
const CAO = new Uint8Array(4);
const GREEDY_KEYS = new Int32Array(2048);
const GREEDY_TUPLES = new Array(2048);
const SCRATCH3 = [0, 0, 0];
// FACE_UVS varies u along this tangent axis per face (±X faces run u along Z,
// every other face along X or Y per faceTables) — greedy spans resolve the
// u/v repeat counts from these.
const UV_U_T = [2, 2, 0, 0, 0, 0];
const UV_V_T = [1, 1, 2, 2, 2, 2];

// OVERHAUL §W — wrap worker-transferred raw arrays into a BufferGeometry.
// Zero copies: the transferred ArrayBuffers ARE the attribute buffers.
export function rawToGeometry(raw) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(raw.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(raw.nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(raw.uv, 2));
  g.setAttribute('aSpan', new THREE.BufferAttribute(raw.span, 2));
  g.setAttribute('aTileUV', new THREE.BufferAttribute(raw.tileUV, 2));
  g.setAttribute('color', new THREE.BufferAttribute(raw.col, 4, true));
  g.setAttribute('tint', new THREE.BufferAttribute(raw.tint, 3, true));
  g.setIndex(new THREE.BufferAttribute(raw.idx, 1));
  return g;
}

// Manual bounding sphere from tracked Y bounds (01 §8.5)
export function setChunkBoundingSphere(geometry, minY, maxY) {
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(8, (minY + maxY) / 2, 8),
    Math.hypot(8, (maxY - minY) / 2 + 1, 8),
  );
}
