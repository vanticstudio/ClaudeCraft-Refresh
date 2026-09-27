// OVERHAUL §A — HD texture atlas: a 32×32 grid of 40px cells on a 1280² canvas;
// each cell holds a 32px painted tile padded by a 4px edge-replicated gutter so
// the mipmap chain can average across cell borders without cross-tile bleed.
// Public API is unchanged from 01 §7 (canvas, texture, TILE, tileUV,
// atlasDataURL, animate) plus setRenderer() for the staged-animation path.
// Tile order is fixed by TILE_NAMES below; index 0 is the magenta 'missing'
// checker fallback.
import * as THREE from 'three';
import { PAINTERS, ANIMATED } from './tilePainters.js';
import { xmur3, mulberry32 } from '../math/rng.js';
import {
  TILE_PX, ATLAS_GUTTER, ATLAS_CELL, ATLAS_COLS, ATLAS_SIZE,
} from '../constants.js';

// Canonical order: blocks, destroy stages, then item sprites (alphabetical).
const BLOCK_TILES = [
  'stone', 'grass_top', 'grass_side', 'dirt', 'cobblestone', 'mossy_cobblestone',
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
  // 07-REDSTONE §14 — dust: 16 power-tinted variants of each of the two shapes
  // (§4.5 ramp baked in at paint time; the mesher picks the variant by power).
  ...Array.from({ length: 16 }, (_, p) => 'dust_dot_' + p),
  ...Array.from({ length: 16 }, (_, p) => 'dust_line_' + p),
  'redstone_torch', 'redstone_torch_off', 'lever', 'stone_button', 'wooden_button',
  'repeater_top', 'comparator_top', 'smooth_stone_side', 'smooth_stone_bottom',
  'piston_side', 'piston_face', 'piston_face_sticky', 'piston_inner',
  'observer_side', 'observer_face', 'observer_back',
  'dispenser_side', 'dispenser_front', 'dropper_front',
  'hopper_top', 'hopper_side', 'redstone_lamp', 'redstone_lamp_lit',
  'note_block', 'redstone_block',
  // 10-NETHER §11
  'netherrack', 'nether_bricks', 'soul_sand', 'soul_soil', 'magma_block',
  'nether_quartz_ore', 'nether_gold_ore', 'ancient_debris_top', 'ancient_debris_side',
  'crimson_nylium', 'warped_nylium', 'crimson_stem', 'crimson_stem_top',
  'warped_stem', 'warped_stem_top', 'crimson_planks', 'warped_planks',
  'nether_wart_block', 'warped_wart_block', 'shroomlight',
  'crimson_fungus', 'warped_fungus', 'crimson_roots', 'warped_roots',
  'nether_wart_0', 'nether_wart_1', 'nether_wart_2',
  'bone_block_top', 'bone_block_side', 'nether_portal', 'spawner',
  'netherite_block', 'smithing_table_top', 'smithing_table_side',
  // 09-POTIONS §7
  'brown_mushroom', 'red_mushroom', 'brewing_stand',
  // 12-VILLAGES §7 — village blocks
  'dirt_path_top', 'bell', 'composter_top', 'composter_side',
  // 12-VILLAGES §12.2 — one baked variant per fill level 0–8 (blocks.js tilesFor)
  ...Array.from({ length: 9 }, (_, l) => 'composter_top_' + l),
  ...Array.from({ length: 9 }, (_, l) => 'composter_side_' + l),
  'barrel_top', 'barrel_side', 'lectern_top', 'lectern_side',
  'blast_furnace_top', 'blast_furnace_side', 'blast_furnace_front', 'blast_furnace_front_lit',
  'smoker_top', 'smoker_side', 'smoker_front', 'smoker_front_lit',
  'fletching_table_top', 'fletching_table_side', 'hay_bale_top', 'hay_bale_side',
  'emerald_ore', 'emerald_block',
  // 11-END §14 — End blocks
  'stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'iron_bars',
  'end_stone', 'end_stone_bricks', 'purpur_block', 'purpur_pillar_top', 'purpur_pillar_side',
  'end_rod', 'chorus_plant', 'chorus_flower',
  'end_portal_frame_top', 'end_portal_frame_top_eye', 'end_portal_frame_side',
  'end_portal', 'end_gateway',
  'shulker_box_top', 'shulker_box_side', 'shulker_box_bottom',
  // 13-BOSSES §2.5 — boss blocks
  'dragon_egg', 'wither_skeleton_skull', 'beacon_base', 'beacon_shell', 'beacon_core',
];
const DESTROY_TILES = Array.from({ length: 10 }, (_, i) => 'destroy_' + i);
const ITEM_TILES = Object.keys(PAINTERS).filter(n => n.startsWith('item_')).sort();

export const TILE_NAMES = ['missing', ...BLOCK_TILES, ...DESTROY_TILES, ...ITEM_TILES];

// 07-REDSTONE §4.5 — power (0..15) → atlas tile for each dust shape. Fixed by
// TILE_NAMES order at module load, so the mesher can resolve a variant without
// the runtime TILE map (it only carries tileUV) and without a per-quad lookup.
export const DUST_DOT_TILE = Uint16Array.from({ length: 16 }, (_, p) => TILE_NAMES.indexOf('dust_dot_' + p));
export const DUST_LINE_TILE = Uint16Array.from({ length: 16 }, (_, p) => TILE_NAMES.indexOf('dust_line_' + p));

// Cell origin of tile t on the atlas canvas (top-left of its 40px cell). The
// painted tile itself starts GUTTER pixels inside — everything UV-facing uses
// cellToInner below, everything pixel-facing (DOM icons, glint compositing)
// uses these plus TILE_PX.
export const cellX = t => (t & (ATLAS_COLS - 1)) * ATLAS_CELL;
export const cellY = t => (t >> 5) * ATLAS_CELL;

function paintMissing(ctx, x0, y0) {
  const s = TILE_PX, h = s >> 1;
  ctx.fillStyle = '#f800f8';
  ctx.fillRect(x0, y0, s, s);
  ctx.fillStyle = '#000000';
  ctx.fillRect(x0, y0, h, h);
  ctx.fillRect(x0 + h, y0 + h, h, h);
}

// Replicate each painted tile's edge texels outward into its gutter so mip
// levels blend into copies of the tile's own border (never a neighbour's).
function stampGutters(ctx) {
  const g = ATLAS_GUTTER, s = TILE_PX;
  for (let t = 0; t < TILE_NAMES.length; t++) {
    const x0 = cellX(t) + g, y0 = cellY(t) + g;
    // rows/cols (drawImage self-copy is legal: regions don't overlap)
    ctx.drawImage(ctx.canvas, x0, y0, s, 1, x0, y0 - g, s, g);              // top
    ctx.drawImage(ctx.canvas, x0, y0 + s - 1, s, 1, x0, y0 + s, s, g);      // bottom
    ctx.drawImage(ctx.canvas, x0, y0, 1, s, x0 - g, y0, g, s);              // left
    ctx.drawImage(ctx.canvas, x0 + s - 1, y0, 1, s, x0 + s, y0, g, s);      // right
    // corners (1×1 pixel stretched into each corner block)
    ctx.drawImage(ctx.canvas, x0, y0, 1, 1, x0 - g, y0 - g, g, g);
    ctx.drawImage(ctx.canvas, x0 + s - 1, y0, 1, 1, x0 + s, y0 - g, g, g);
    ctx.drawImage(ctx.canvas, x0, y0 + s - 1, 1, 1, x0 - g, y0 + s, g, g);
    ctx.drawImage(ctx.canvas, x0 + s - 1, y0 + s - 1, 1, 1, x0 + s, y0 + s, g, g);
  }
}

export function buildAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ATLAS_SIZE;
  // §6 — willReadFrequently: the edge-light/bevel passes do ~300 small
  // getImageData/putImageData round-trips during the bake; a GPU-backed canvas
  // pays a sync stall for each (~1.5 s total). CPU-backed, the whole bake stays
  // fast — and this canvas is only a build target that three.js uploads once.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const TILE = {};
  for (let t = 0; t < TILE_NAMES.length; t++) {
    const name = TILE_NAMES[t];
    TILE[name] = t;
    const x0 = cellX(t) + ATLAS_GUTTER, y0 = cellY(t) + ATLAS_GUTTER;
    if (name === 'missing') { paintMissing(ctx, x0, y0); continue; }
    const painter = PAINTERS[name];
    if (!painter) { paintMissing(ctx, x0, y0); continue; }
    // Animated tiles' build-time paint is frame 0 of ANIMATED — seeded exactly
    // like animate()'s step-0 repaint (name+':0') so the first animation step
    // does not pop the texture.
    const seed = ANIMATED[name] ? name + ':0' : name;
    painter(ctx, x0, y0, mulberry32(xmur3(seed)()));
  }
  stampGutters(ctx);

  // OVERHAUL §A — mipmapped filtering: crisp nearest magnification up close,
  // bilinear-blended mip levels in the distance (kills the old full-tile
  // shimmer). Anisotropy is raised by main.js once the renderer exists.
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;   // gamma-space pipeline (01 §1)
  texture.flipY = false;                     // v measured from canvas top

  // Precomputed UV rects with half-texel inset (01 §7.2): [u0,v0,u1,v1] × 1024.
  // Rects address the INNER tile; the gutter is never sampled by the static
  // path, it only feeds the mip chain.
  const tileUV = new Float32Array(1024 * 4);
  for (let t = 0; t < 1024; t++) {
    const x0 = cellX(t) + ATLAS_GUTTER, y0 = cellY(t) + ATLAS_GUTTER;
    tileUV[t * 4 + 0] = (x0 + 0.5) / ATLAS_SIZE;
    tileUV[t * 4 + 1] = (y0 + 0.5) / ATLAS_SIZE;
    tileUV[t * 4 + 2] = (x0 + TILE_PX - 0.5) / ATLAS_SIZE;
    tileUV[t * 4 + 3] = (y0 + TILE_PX - 0.5) / ATLAS_SIZE;
  }

  const atlasDataURL = canvas.toDataURL('image/png');

  // ---------------------------------------------------------- animation
  // OVERHAUL §A — staged animation. Frame painters run into a tiny staging
  // canvas; renderer.copyTextureToTexture then pushes JUST the changed tiles
  // into the atlas texture. The old path re-uploaded the whole 512² canvas
  // every 5 ticks; the new one uploads N × 32² px and never regenerates mips
  // in the hot path (a periodic full refresh below re-syncs the mip chain).
  const ANIM_ENTRIES = Object.entries(ANIMATED)
    .filter(([name]) => TILE[name] !== undefined);
  const animCanvas = document.createElement('canvas');
  animCanvas.width = Math.max(1, ANIM_ENTRIES.length) * TILE_PX;
  animCanvas.height = TILE_PX;
  const animCtx = animCanvas.getContext('2d', { willReadFrequently: true });
  const animTexture = new THREE.CanvasTexture(animCanvas);
  animTexture.magFilter = THREE.NearestFilter;
  animTexture.minFilter = THREE.NearestFilter;
  animTexture.generateMipmaps = false;
  animTexture.colorSpace = THREE.NoColorSpace;
  animTexture.flipY = false;

  let renderer = null;          // set via setRenderer(); copies start after
  let lastStep = -1;
  const FULL_REFRESH_TICKS = 1200;   // 60 s — re-upload canvas + rebuild mips

  function paintFrames(step) {
    for (let i = 0; i < ANIM_ENTRIES.length; i++) {
      const [name, frames] = ANIM_ENTRIES[i];
      const f = frames[((step % frames.length) + frames.length) % frames.length] ?? frames[0];
      const ax = i * TILE_PX, ay = 0;
      const t = TILE[name];
      const x0 = cellX(t) + ATLAS_GUTTER, y0 = cellY(t) + ATLAS_GUTTER;
      // Stable per-frame seeds (step % N): the painters' wrap-around phases
      // (water sine, lava drift, flame heights) then loop exactly as authored
      // instead of re-rolling their noise lattice every 250 ms — and the
      // build-time frame-0 paint (seeded name+':0' above) matches frame 0
      // here, so there is no one-time texture pop on the first animation tick.
      const seed = name + ':' + (((step % frames.length) + frames.length) % frames.length);
      // staging cell (source of the GPU push) AND the main canvas cell (so the
      // periodic full refresh — and mips derived from the canvas — see the
      // same current frame).
      animCtx.clearRect(ax, ay, TILE_PX, TILE_PX);
      f(animCtx, ax, ay, mulberry32(xmur3(seed)()));
      ctx.clearRect(x0, y0, TILE_PX, TILE_PX);
      f(ctx, x0, y0, mulberry32(xmur3(seed)()));
    }
    // CRITICAL: bump the staging texture's version or the GPU never sees the
    // repaint. setTexture2D uploads only when `version > 0 && __version !==
    // version` — the ctor's single needsUpdate made version 1, and initTexture
    // below was a permanent no-op afterwards, so every copyTextureToTexture
    // pushed the BOOT-TIME BLANK staging canvas over the water/lava/fire/
    // furnace-lit/portal atlas regions (invisible water, frozen animation).
    animTexture.needsUpdate = true;
    // The framebuffer copy path reads the STAGING TEXTURE from GPU memory, so
    // the CPU-side repaint above must actually reach it: initTexture processes
    // the version bump and re-uploads the tiny (N·32×32) staging canvas
    // BEFORE any copy runs. (needsUpdate alone would queue an upload that
    // nothing ever binds — the staging texture lives in no material.)
    if (renderer) {
      renderer.initTexture(animTexture);
      for (let i = 0; i < ANIM_ENTRIES.length; i++) {
        const t = TILE[ANIM_ENTRIES[i][0]];
        const ax = i * TILE_PX;
        const x0 = cellX(t) + ATLAS_GUTTER, y0 = cellY(t) + ATLAS_GUTTER;
        renderer.copyTextureToTexture(animTexture, texture,
          { min: { x: ax, y: 0 }, max: { x: ax + TILE_PX, y: TILE_PX } },
          { x: x0, y: y0 });
        // copyTextureToTexture regenerates the dst mip chain whenever
        // dst.generateMipmaps — so the chain stays in sync with level 0 here
        // (a 1280² mip rebuild per step is ~0.5 ms GPU; accepted). The
        // periodic full refresh below remains as a belt-and-braces re-sync.
      }
    }
  }

  function animate(tick) {
    if (tick % 5 !== 0) return;
    const step = (tick / 5) | 0;
    if (step === lastStep) return;
    lastStep = step;
    paintFrames(step);
    if (step % FULL_REFRESH_TICKS === 0) texture.needsUpdate = true;   // mip re-sync
  }

  // setRenderer — OVERHAUL §A: the staged copy reads the SOURCE from GPU
  // memory (framebuffer path), so the staging texture must be uploaded before
  // the first copy — initTexture does exactly that, once, here. paintFrames
  // re-uploads it per step (it is N·32² px — negligible). Anisotropy is raised
  // here too — oblique-angle shimmer the mip chain can't fix alone (capped by
  // the driver's maximum).
  return {
    canvas, texture, TILE, tileUV, atlasDataURL, animate,
    setRenderer(r) {
      renderer = r;
      texture.anisotropy = Math.min(8, r.capabilities.getMaxAnisotropy());
      if (ANIM_ENTRIES.length) r.initTexture(animTexture);
    },
    // OVERHAUL §O — mipmaps toggle (settings). Toggling re-uploads the whole
    // canvas once — a settings action, never a per-frame path.
    setMipmaps(on) {
      if (on) {
        texture.generateMipmaps = true;
        texture.minFilter = THREE.NearestMipmapLinearFilter;
      } else {
        texture.generateMipmaps = false;
        texture.minFilter = THREE.NearestFilter;
      }
      texture.needsUpdate = true;
    },
  };
}
