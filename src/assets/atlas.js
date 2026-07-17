// 512×512 texture atlas: 32×32 grid of 16×16 procedurally painted tiles
// (01 §7). Tile order is fixed by TILE_NAMES below; index 0 is the magenta
// 'missing' checker fallback.
import * as THREE from 'three';
import { PAINTERS, ANIMATED } from './tilePainters.js';
import { xmur3, mulberry32 } from '../math/rng.js';

// Canonical order: blocks, destroy stages, then item sprites (alphabetical).
const BLOCK_TILES = [
  'stone', 'grass_top', 'grass_side', 'dirt', 'cobblestone',
  'oak_planks', 'birch_planks', 'spruce_planks',
  'oak_log_side', 'oak_log_top', 'birch_log_side', 'birch_log_top',
  'spruce_log_side', 'spruce_log_top',
  'oak_leaves', 'birch_leaves', 'spruce_leaves',
  'oak_sapling', 'birch_sapling', 'spruce_sapling',
  'bedrock', 'sand', 'gravel',
  'sandstone_top', 'sandstone_side', 'sandstone_bottom',
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'redstone_ore', 'lapis_ore',
  'coal_block', 'iron_block', 'gold_block', 'diamond_block',
  'glass', 'glowstone', 'obsidian',
  'crafting_table_top', 'crafting_table_side',
  'furnace_front', 'furnace_front_lit', 'furnace_side', 'furnace_top',
  'chest_front', 'chest_side', 'chest_top',
  'torch', 'ladder', 'snow', 'ice',
  'cactus_side', 'cactus_top',
  'pumpkin_side', 'pumpkin_top', 'jack_o_lantern_front',
  'wool_white', 'wool_red', 'wool_blue', 'wool_black',
  'bookshelf', 'tnt_side', 'tnt_top', 'tnt_bottom',
  'oak_door_upper', 'oak_door_lower',
  'bed_head_top', 'bed_foot_top', 'bed_side',
  'farmland_dry', 'farmland_wet',
  'wheat_0', 'wheat_1', 'wheat_2', 'wheat_3',
  'wheat_4', 'wheat_5', 'wheat_6', 'wheat_7',
  'carrot_0', 'carrot_1', 'carrot_2', 'carrot_3',
  'potato_0', 'potato_1', 'potato_2', 'potato_3',
  'sugar_cane', 'short_grass', 'dandelion', 'poppy',
  'water', 'lava', 'fire', 'dead_bush',
  // 08-ENCHANTING §2.4 (the table's bottom face reuses 'obsidian', already above)
  'enchanting_table_top', 'enchanting_table_side',
  'anvil_top_0', 'anvil_top_1', 'anvil_top_2', 'anvil_side',
  'grindstone_side', 'grindstone_tread',
];
const DESTROY_TILES = Array.from({ length: 10 }, (_, i) => 'destroy_' + i);
const ITEM_TILES = Object.keys(PAINTERS).filter(n => n.startsWith('item_')).sort();

export const TILE_NAMES = ['missing', ...BLOCK_TILES, ...DESTROY_TILES, ...ITEM_TILES];

function paintMissing(ctx, x0, y0) {
  ctx.fillStyle = '#f800f8';
  ctx.fillRect(x0, y0, 16, 16);
  ctx.fillStyle = '#000000';
  ctx.fillRect(x0, y0, 8, 8);
  ctx.fillRect(x0 + 8, y0 + 8, 8, 8);
}

export function buildAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  const TILE = {};
  for (let t = 0; t < TILE_NAMES.length; t++) {
    const name = TILE_NAMES[t];
    TILE[name] = t;
    const x0 = (t & 31) * 16, y0 = (t >> 5) * 16;
    if (name === 'missing') { paintMissing(ctx, x0, y0); continue; }
    const painter = PAINTERS[name];
    if (!painter) { paintMissing(ctx, x0, y0); continue; }
    painter(ctx, x0, y0, mulberry32(xmur3(name)()));
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;   // no mipmap variant
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;   // gamma-space pipeline (01 §1)
  texture.flipY = false;                     // v measured from canvas top

  // Precomputed UV rects with half-texel inset (01 §7.2): [u0,v0,u1,v1] × 1024
  const tileUV = new Float32Array(1024 * 4);
  for (let t = 0; t < 1024; t++) {
    const col = t & 31, row = t >> 5;
    tileUV[t * 4 + 0] = (col * 16 + 0.5) / 512;
    tileUV[t * 4 + 1] = (row * 16 + 0.5) / 512;
    tileUV[t * 4 + 2] = (col * 16 + 15.5) / 512;
    tileUV[t * 4 + 3] = (row * 16 + 15.5) / 512;
  }

  const atlasDataURL = canvas.toDataURL('image/png');

  // Swap animated tiles between their two frames every 5 ticks by repainting
  // their atlas slots; all chunk geometry picks the change up for free.
  let lastFrame = 0;
  function animate(tick) {
    const frame = ((tick / 5) | 0) & 1;
    if (frame === lastFrame || tick % 5 !== 0) return;
    lastFrame = frame;
    for (const [name, frames] of Object.entries(ANIMATED)) {
      const t = TILE[name];
      if (t === undefined) continue;
      const x0 = (t & 31) * 16, y0 = (t >> 5) * 16;
      ctx.clearRect(x0, y0, 16, 16);
      frames[frame](ctx, x0, y0, mulberry32(xmur3(name + ':' + frame)()));
    }
    texture.needsUpdate = true;
  }

  return { canvas, texture, TILE, tileUV, atlasDataURL, animate };
}
