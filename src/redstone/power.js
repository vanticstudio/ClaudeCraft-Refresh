// 07-REDSTONE §3 — the power model. Strong/weak emission, block power, and the
// mechanism-activation predicate. This is the load-bearing core: every §3.3
// source's geometry lives in `emitInto`, and the two §3.4 rules ("dust reads
// only STRONG, mechanisms read WEAK") live in `dustInjection` / `isActivated`.
//
// Power is computed ON DEMAND from world state — there is no cached power field.
// A source occupies a cell and injects a {strong, weak} level into specific
// TARGET cells; to find a target cell's power we scan its 6 neighbours and ask
// each what it injects here.

import { BLOCKS, B } from '../registry/blocks.js';
import { FACE6_DIR, FACE6_OPP, ATTACH_DIR, HFACE_DIR } from './dirs.js';
import { dustOutputDirs } from './dust.js';

// State decoders (mirror §13.3). Kept here so both power.js and components.js
// read the byte identically.
export const wirePower = st => st & 0x0f;                 // wire 70: bits0-3
export const attachOf = st => st & 0x07;                  // torch/lever/button: bits0-2
export const leverOn = st => (st & 0x08) !== 0;
export const buttonPressed = st => (st & 0x08) !== 0;
export const platePressed = st => (st & 0x01) !== 0;
export const torchLit = st => (st & 0x08) !== 0;
export const face6Of = st => st & 0x07;
export const repHface = st => st & 0x03;
export const repDelay = st => (st >> 2) & 0x03;           // 0-3 → delay (d+1)*2 gt
export const repOn = st => (st & 0x10) !== 0;
export const repLocked = st => (st & 0x20) !== 0;
export const cmpHface = st => st & 0x03;
export const cmpSubtract = st => (st & 0x04) !== 0;
export const cmpOut = st => (st >> 3) & 0x0f;             // bits3-6
export const obsFace = st => st & 0x07;                   // watched dir
export const obsPulsing = st => (st & 0x08) !== 0;
export const hopperLocked = st => (st & 0x08) !== 0;
export const noteLatched = st => (st & 0x20) !== 0;

/** §3.2 — does the block at this cell conduct power? (static per id) */
export function conductive(world, x, y, z) {
  const b = BLOCKS[world.getBlock(x, y, z)];
  return !!b && b.conductive;
}

/**
 * §3.3 — how much strong/weak power the source at (sx,sy,sz) injects into the
 * face-adjacent cell (tx,ty,tz). Returns {s, w}. Non-sources return {0,0}.
 *
 * The delta (t − s) is one of the 6 unit vectors; callers only pass neighbours.
 */
export function emitInto(world, sx, sy, sz, tx, ty, tz) {
  const id = world.getBlock(sx, sy, sz);
  const st = world.getState(sx, sy, sz);
  const dx = tx - sx, dy = ty - sy, dz = tz - sz;
  const isUp = dy === 1, isDown = dy === -1;

  switch (id) {
    case B.LEVER: {
      if (!leverOn(st)) return ZERO;
      const a = ATTACH_DIR[attachOf(st)];
      const strong = (dx === a[0] && dy === a[1] && dz === a[2]) ? 15 : 0;
      return { s: strong, w: 15 };                          // weak to all 6
    }
    case B.STONE_BUTTON:
    case B.WOODEN_BUTTON: {
      if (!buttonPressed(st)) return ZERO;
      const a = ATTACH_DIR[attachOf(st)];
      const strong = (dx === a[0] && dy === a[1] && dz === a[2]) ? 15 : 0;
      return { s: strong, w: 15 };
    }
    case B.STONE_PRESSURE_PLATE:
    case B.WOODEN_PRESSURE_PLATE: {
      if (!platePressed(st)) return ZERO;
      return { s: isDown ? 15 : 0, w: 15 };                 // strong below, weak all 6
    }
    case B.REDSTONE_TORCH: {
      if (!torchLit(st)) return ZERO;
      const a = ATTACH_DIR[attachOf(st)];
      const isAttach = dx === a[0] && dy === a[1] && dz === a[2];
      return { s: isUp ? 15 : 0, w: isAttach ? 0 : 15 };    // strong up, weak all but attach
    }
    case B.REDSTONE_BLOCK:
      return { s: 0, w: 15 };                               // weak all 6, never strong
    case B.REPEATER: {
      if (!repOn(st)) return ZERO;
      const f = HFACE_DIR[repHface(st)];
      const faced = dy === 0 && dx === f[0] && dz === f[2];
      return faced ? { s: 15, w: 15 } : ZERO;
    }
    case B.COMPARATOR: {
      const out = cmpOut(st);
      if (out === 0) return ZERO;
      const f = HFACE_DIR[cmpHface(st)];
      const faced = dx === f[0] && dz === f[2] && dy === 0;
      return faced ? { s: out, w: out } : ZERO;
    }
    case B.OBSERVER: {
      if (!obsPulsing(st)) return ZERO;
      const back = FACE6_DIR[FACE6_OPP[obsFace(st)]];
      const atBack = dx === back[0] && dy === back[1] && dz === back[2];
      return atBack ? { s: 15, w: 15 } : ZERO;
    }
    case B.REDSTONE_WIRE: {
      const p = wirePower(st);
      if (p === 0) return ZERO;
      if (isDown) return { s: 0, w: p };                    // weak into block below
      if (dy !== 0) return ZERO;                            // never powers upward
      // weak p into each horizontal cell it points into
      const dirs = dustOutputDirs(world, sx, sy, sz);
      for (const d of dirs) if (d[0] === dx && d[2] === dz) return { s: 0, w: p };
      return ZERO;
    }
    default:
      return ZERO;
  }
}
const ZERO = { s: 0, w: 0 };

/**
 * §3.3 — {strong, weak} injected INTO cell (x,y,z) by its 6 neighbours.
 * `skipDust` excludes wire sources, for the dust solver's §3.4-1 rule (a).
 */
export function directPowerInto(world, x, y, z, skipDust = false) {
  let strong = 0, weak = 0;
  for (const [dx, dy, dz] of FACE6_DIR) {
    const nx = x + dx, ny = y + dy, nz = z + dz;
    if (skipDust && world.getBlock(nx, ny, nz) === B.REDSTONE_WIRE) continue;
    const e = emitInto(world, nx, ny, nz, x, y, z);
    if (e.s > strong) strong = e.s;
    if (e.w > weak) weak = e.w;
  }
  return { strong, weak: Math.max(strong, weak) };
}

/** §3.3 — strong(B): the max strong power injected into a conductive block B. */
export function strongPower(world, x, y, z) {
  return directPowerInto(world, x, y, z).strong;
}

/** §3.3 — weak(B): a conductive block is "powered" iff this is > 0. */
export function weakPower(world, x, y, z) {
  return directPowerInto(world, x, y, z).weak;
}

/**
 * §3.4-1 — the level injected into a DUST cell: max of
 *  (a) weak emissions from NON-dust sources into this cell, and
 *  (b) strong(B) of each face-adjacent conductive block.
 * A merely weakly-powered block never feeds dust (no dust→block→dust).
 */
export function dustInjection(world, x, y, z) {
  let inj = directPowerInto(world, x, y, z, /*skipDust*/ true).weak;   // (a)
  for (const [dx, dy, dz] of FACE6_DIR) {
    const nx = x + dx, ny = y + dy, nz = z + dz;
    if (conductive(world, nx, ny, nz)) {
      const s = strongPower(world, nx, ny, nz);               // (b)
      if (s > inj) inj = s;
    }
  }
  return inj;
}

/**
 * §3.5 — a mechanism at (x,y,z) is activated iff its own cell has weak power
 * injected directly, OR any face-adjacent conductive block is powered (weak>0).
 * Mechanisms read WEAK. Quasi-connectivity is excluded (§1) — only this cell.
 */
export function isActivated(world, x, y, z) {
  if (directPowerInto(world, x, y, z).weak > 0) return true;
  for (const [dx, dy, dz] of FACE6_DIR) {
    const nx = x + dx, ny = y + dy, nz = z + dz;
    if (conductive(world, nx, ny, nz) && weakPower(world, nx, ny, nz) > 0) return true;
  }
  return false;
}
