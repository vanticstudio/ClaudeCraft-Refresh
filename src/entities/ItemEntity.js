// Dropped item entity (06 §16) + shared atlas-visual helpers for entities.
import * as THREE from 'three';
import { Entity } from './Entity.js';
import { BLOCKS } from '../registry/blocks.js';
import { ITEMS } from '../registry/items.js';
import { AABB } from '../math/aabb.js';
import { emitSound, at } from '../audio/engine.js';
import { tagsEqual, cloneTags } from '../items/tags.js';
import { isGlinted, addGlintPass } from '../render/glint.js';

// ---- shared visual helpers (initialised once from main with the atlas) ----

let ATLAS = null;   // { texture, TILE, tileUV }
const cubeGeoCache = new Map();     // blockId|size → BufferGeometry
const spriteGeoCache = new Map();   // tile|size → BufferGeometry

export function initEntityVisuals(atlas) { ATLAS = atlas; }
export function entityAtlas() { return ATLAS; }

export function makeAtlasMaterial(opts = {}) {
  const mat = new THREE.MeshBasicMaterial({
    map: ATLAS.texture,
    alphaTest: 0.5,
    side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    transparent: !!opts.transparent,
  });
  mat.userData.baseColor = new THREE.Color(1, 1, 1);
  return mat;
}

// Cube with per-face block tiles, centered at origin, feet at y=0
export function blockCubeGeometry(blockId, size) {
  const key = blockId + '|' + size;
  let geo = cubeGeoCache.get(key);
  if (geo) return geo;
  const blk = BLOCKS[blockId];
  geo = new THREE.BoxGeometry(size, size, size);
  geo.translate(0, size / 2, 0);
  // BoxGeometry face order: +X, −X, +Y, −Y, +Z, −Z (matches registry tiles)
  const uv = geo.attributes.uv;
  const tiles = blk.tileIndex || new Uint16Array(6);
  for (let f = 0; f < 6; f++) {
    const t4 = tiles[f] * 4;
    const u0 = ATLAS.tileUV[t4], v0 = ATLAS.tileUV[t4 + 1];
    const u1 = ATLAS.tileUV[t4 + 2], v1 = ATLAS.tileUV[t4 + 3];
    for (let i = 0; i < 4; i++) {
      const vi = f * 4 + i;
      uv.setXY(vi, u0 + (u1 - u0) * uv.getX(vi), v0 + (v1 - v0) * (1 - uv.getY(vi)));
    }
  }
  uv.needsUpdate = true;
  // 01 §17.2 — module-level cache: EntityManager's disposal sweep must leave it
  // alone or reaping one drop would free the geometry every other drop draws with
  // (same contract as models.js boxGeo).
  geo.userData.shared = true;
  cubeGeoCache.set(key, geo);
  return geo;
}

// Vertical quad with an atlas tile, centered at origin, feet at y=0
export function tileSpriteGeometry(tile, size) {
  const key = tile + '|' + size;
  let geo = spriteGeoCache.get(key);
  if (geo) return geo;
  geo = new THREE.PlaneGeometry(size, size);
  geo.translate(0, size / 2, 0);
  const t4 = tile * 4;
  const u0 = ATLAS.tileUV[t4], v0 = ATLAS.tileUV[t4 + 1];
  const u1 = ATLAS.tileUV[t4 + 2], v1 = ATLAS.tileUV[t4 + 3];
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + (u1 - u0) * uv.getX(i), v0 + (v1 - v0) * (1 - uv.getY(i)));
  }
  uv.needsUpdate = true;
  geo.userData.shared = true;      // 01 §17.2 — cached; see blockCubeGeometry
  spriteGeoCache.set(key, geo);
  return geo;
}

/**
 * 06 §16 — the same sprite as two quads crossed at 90°, so an item sprite has
 * some thickness instead of vanishing to a hairline when viewed edge-on (the
 * dropped-item spin and the first-person viewmodel both pass through that
 * angle every cycle). three's mergeGeometries lives in examples/ and must not
 * be imported, so the two buffers are concatenated by hand.
 */
export function crossedSpriteGeometry(tile, size) {
  const key = tile + '|' + size + '|X';
  let geo = spriteGeoCache.get(key);
  if (geo) return geo;
  const a = tileSpriteGeometry(tile, size);          // cached + shared: never mutate
  const b = a.clone();
  b.rotateY(Math.PI / 2);
  geo = new THREE.BufferGeometry();
  const base = a.attributes.position.count;
  for (const name of ['position', 'normal', 'uv']) {
    const pa = a.attributes[name], pb = b.attributes[name], its = pa.itemSize;
    const arr = new Float32Array((pa.count + pb.count) * its);
    arr.set(pa.array, 0);
    arr.set(pb.array, pa.count * its);
    geo.setAttribute(name, new THREE.BufferAttribute(arr, its));
  }
  const ia = a.index, ib = b.index;
  const idx = new Uint16Array(ia.count + ib.count);
  idx.set(ia.array, 0);
  for (let i = 0; i < ib.count; i++) idx[ia.count + i] = ib.array[i] + base;
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  b.dispose();
  geo.userData.shared = true;      // 01 §17.2 — cached; see blockCubeGeometry
  spriteGeoCache.set(key, geo);
  return geo;
}

export function itemTileFor(itemId) {
  const item = ITEMS.get(itemId);
  if (!item) return 0;
  if (item.sprite && ATLAS.TILE[item.sprite] !== undefined) return ATLAS.TILE[item.sprite];
  if (item.place != null && BLOCKS[item.place]?.tileIndex) return BLOCKS[item.place].tileIndex[4];
  return 0;
}

// 06 §16 "Visual" — the rendered pile is 1 / 2 / 3 / 4 sprites, chosen from the
// stack count by these thresholds. buildMesh below is the only consumer of the
// shape; every count MUTATION consults this so a rebuild is only requested when
// the pile would actually look different (a rebuild is a full dispose + realloc).
const countBucket = n => (n >= 33 ? 3 : n >= 17 ? 2 : n >= 2 ? 1 : 0);

// ---------------------------------------------------------------------------

export class ItemEntity extends Entity {
  // stack: {id, count, damage?}
  constructor(world, x, y, z, stack, pickupDelay = 10) {
    super(world, x, y, z);
    this.type = 'item';
    this.width = 0.25; this.height = 0.25;
    this.stack = stack;
    this.pickupDelay = pickupDelay;
    this.despawnAge = 6000;
  }

  tick() {
    this.baseTick();
    if (this.pickupDelay > 0) this.pickupDelay--;
    // 13-BOSSES AMENDS 06 §16 — the nether_star item entity never despawns.
    if (this.age >= this.despawnAge && !ITEMS.get(this.stack?.id)?.neverDespawn) { this.dead = true; return; }

    this.updateMedium();
    // 10-NETHER §9.4 — netherite items (lavaImmune) are not destroyed by lava,
    // fire, OR cactus, and float on lava; every other item burns per 06 §16. (The
    // spec deliberately extends the immunity to cactus, unlike vanilla.)
    const immune = ITEMS.get(this.stack.id)?.lavaImmune;
    if (!immune && (this.inLava || this.world.getBlock(
        Math.floor(this.pos.x), Math.floor(this.pos.y), Math.floor(this.pos.z)) === 65 /* fire */)) {
      this.dead = true;
      return;
    }
    // cactus contact destroys items (06 §5.8), except lava-immune netherite (§9.4)
    if (!immune && this.touchesCactus()) { this.dead = true; return; }

    if (this.inWater || (immune && this.inLava)) {
      this.vel.y = Math.min(this.vel.y + 0.06, 0.06);   // buoyancy (approx) — floats on lava too
    } else {
      this.vel.y -= 0.04;
    }
    this.move(this.vel.x, this.vel.y, this.vel.z);
    this.vel.x *= 0.98; this.vel.y *= 0.98; this.vel.z *= 0.98;
    if (this.onGround) { this.vel.x *= 0.6; this.vel.z *= 0.6; }

    // 06 §16 "every 40 t AND on spawn". baseTick() already incremented age, so
    // the first tick of a fresh entity is age 1 — register() ran in add() before
    // it, so the neighbours are already in the spatial index.
    if (this.age === 1 || (this.age % 40) === 0) this.tryMerge();
    this.tryPickup();
  }

  touchesCactus() {
    const box = this.getAABB();
    const x0 = Math.floor(box.min[0]), x1 = Math.floor(box.max[0]);
    const y0 = Math.floor(box.min[1]), y1 = Math.floor(box.max[1]);
    const z0 = Math.floor(box.min[2]), z1 = Math.floor(box.max[2]);
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++)
          if (this.world.getBlock(x, y, z) === 43 /* cactus */) return true;
    return false;
  }

  tryMerge() {
    const item = ITEMS.get(this.stack.id);
    const max = item?.stack ?? 64;
    if (this.stack.count >= max) return;
    const box = this.getAABB().expand(0.5, 0.25, 0.5);
    // AMENDS 06 §16 (08 §1): merge only when id, durability AND deep-equal tags
    // all match — two differently-enchanted swords must never fuse on the floor.
    const near = this.world.getEntitiesInBox(box,
      e => e !== this && e.type === 'item' && !e.dead &&
           e.stack.id === this.stack.id && (e.stack.damage ?? 0) === (this.stack.damage ?? 0) &&
           tagsEqual(e.stack, this.stack));
    for (const other of near) {
      if (this.stack.count + other.stack.count > max) continue;
      const before = this.stack.count;
      this.stack.count += other.stack.count;
      this.despawnAge = Math.max(this.despawnAge - this.age, other.despawnAge - other.age) + this.age;
      other.deathTime = 0;
      other.dead = true;
      // 06 §16 "Visual" — the sprite count (1 / 2 / 3 / 4) is chosen in
      // buildMesh, so a changed count only shows if the mesh is rebuilt.
      // needsMeshRebuild is the flag EntityManager.updateRender honours, and it
      // costs a full teardown (dispose + fresh Group/material), so raise it only
      // when the count crosses a BUCKET boundary — inside one bucket the mesh
      // that would be rebuilt is identical to the one already on screen.
      if (countBucket(this.stack.count) !== countBucket(before)) this.needsMeshRebuild = true;
    }
  }

  tryPickup() {
    if (this.pickupDelay > 0) return;
    const game = this.world.game;
    if (!game) return;
    // 14 AMENDS 06 §16 — pickup is host-authoritative; when several players' boxes
    // overlap the same item in one tick the LOWEST slot (roster order) wins.
    const players = (game.players && game.players.length) ? game.players : (game.player ? [game.player] : []);
    const box = this.getAABB();
    for (const player of players) {
      if (!player || player.dead) continue;
      const pbox = player.getAABB().expand(1.0, 0.5, 1.0);
      if (!pbox.intersects(box)) continue;
      const before = this.stack.count;
      const leftover = player.give(this.stack);
      if (leftover <= 0) {
        this.dead = true;
        emitSound('player.item_pickup', at(this.pos.x, this.pos.y, this.pos.z));
        if (player === game.player) game.ui?.hud?.flashPickup?.(this.stack);
        return;
      }
      // §16 Visual — a partial pickup shrank the pile. Player.give returns the
      // FULL count when NOTHING fit (36 occupied slots, no mergeable stack), so
      // an unconditional flag here rebuilt the model 20×/s for as long as a
      // full-inventory player stood on the drop. Same bucket rule as tryMerge.
      this.stack.count = leftover;
      if (countBucket(leftover) !== countBucket(before)) this.needsMeshRebuild = true;
    }
  }

  buildMesh() {
    const group = new THREE.Group();
    const item = ITEMS.get(this.stack.id);
    const mat = makeAtlasMaterial({ doubleSide: true });
    let inner;
    if (item && item.kind === 'block' && item.place != null) {
      inner = new THREE.Mesh(blockCubeGeometry(item.place, 0.25), mat);
      inner.position.x = -0;   // centered
    } else {
      inner = new THREE.Mesh(crossedSpriteGeometry(itemTileFor(this.stack.id), 0.5), mat);
    }
    group.add(inner);
    // stacked visuals for larger counts (06 §16)
    const extra = countBucket(this.stack.count);
    for (let i = 0; i < extra; i++) {
      const dup = inner.clone();
      dup.position.set((i + 1) * 0.06 - 0.09, i * 0.02, (i + 1) * 0.05 - 0.08);
      group.add(dup);
    }
    // 08 §11 — a dropped enchanted stack gets the additive glint pass, sharing
    // each mesh's geometry. Added last so the count-duplicates are covered too.
    if (isGlinted(this.stack)) addGlintPass(group);
    return group;
  }

  updateRender(alpha) {
    super.updateRender(alpha);
    if (!this.object3d) return;
    const t = this.age + alpha;
    this.object3d.rotation.y = t * 0.03;                       // spin (06 §16)
    this.object3d.position.y += 0.1 + 0.1 * Math.sin(t / 10);  // bob
  }

  serialize() {
    return {
      type: 'item',
      itemId: this.stack.id, count: this.stack.count, damage: this.stack.damage,
      // 08 §13: item entities round-trip `tags` like every other stack.
      tags: cloneTags(this.stack.tags),
      pos: [this.pos.x, this.pos.y, this.pos.z],
      vel: [this.vel.x, this.vel.y, this.vel.z],
      age: this.age, pickupDelay: this.pickupDelay,
    };
  }

  static deserialize(world, rec) {
    const stack = { id: rec.itemId, count: rec.count, damage: rec.damage };
    const tags = cloneTags(rec.tags);
    if (tags) stack.tags = tags;
    const e = new ItemEntity(world, rec.pos[0], rec.pos[1], rec.pos[2],
      stack, rec.pickupDelay ?? 0);
    e.vel.x = rec.vel[0]; e.vel.y = rec.vel[1]; e.vel.z = rec.vel[2];
    e.age = rec.age ?? 0;
    return e;
  }
}
