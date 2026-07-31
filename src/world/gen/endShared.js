// 11-END §4.2 + §6.3 — pure, worker-safe seed math shared by the eye-of-ender
// navigation (main thread), the stronghold generator (worker), the End generator
// (worker), and the arena export (main thread). Keeping these in ONE module means
// strongholdXZ / pillar heights are byte-identical on every thread.
import { hashString, mix32, splitmix32 } from '../../math/rng.js';

// The 'sys:stronghold' stream (02 §2.2 machinery) — the spec pins strongholdXZ,
// the pillar shuffle, and gateway permutation all to this one substream.
export const strongholdSeed = ws => mix32(ws ^ hashString('sys:stronghold'));

/**
 * §4.2 — the single overworld stronghold's XZ (3 RNG draws; cheap, main-safe).
 * distance 800–1600; the 3rd draw pins the start-piece rotation.
 *
 * UPDATE-structure-density DEVIATES from §4.2's pinned 1200–2000. There is exactly
 * ONE stronghold per world and it gates the entire End progression, making it by
 * far the rarest structure in the game; 800–1600 (mean 1200, not 1600) puts it
 * inside a typical explored radius. Clearance is ample: 800 − stronghold RADIUS 96
 * = 704 blocks from origin, and findWorldSpawn only searches out to 256.
 *
 * CRITICAL COUPLED INVARIANT — THIS FUNCTION MUST CONSUME EXACTLY THREE DRAWS.
 * stronghold.js mirrors them with a bare `rng(); rng(); rng();` before continuing
 * the SAME stream into buildPlan, so adding or removing a draw here silently
 * reshuffles the whole stronghold plan (piece types, library/altar placement,
 * portal socket). Changing the numeric constants keeps the count at 3 and is
 * therefore safe. Consumers inherit the new position with no code change:
 * terrain.js (the single stamper) and entities/EyeOfEnder.js (eye navigation).
 */
export function strongholdXZ(worldSeed) {
  const ws = typeof worldSeed === 'number' ? (worldSeed >>> 0) : hashString(String(worldSeed ?? ''));
  const rng = splitmix32(strongholdSeed(ws));
  const ang = rng() * 2 * Math.PI;
  const dist = 800 + rng() * 800;
  const rot = rng();
  return { SX: Math.round(Math.cos(ang) * dist), SZ: Math.round(Math.sin(ang) * dist), rot: (rot * 4) | 0 };
}

// §6.3 — the vanilla 10-pillar cap-height set, radii aligned to sorted heights,
// and the caged flag (2nd + 3rd shortest = 79, 82).
const HEIGHT_SET = [76, 79, 82, 85, 88, 91, 94, 97, 100, 103];
const RADIUS_SET = [3, 3, 3, 4, 4, 4, 5, 5, 5, 6];

/**
 * §6.3 — the 10 obsidian pillars on the radius-43 circle. Positions are fixed
 * (i=0 at +X, CCW); the height/radius/cage set is assigned to positions by a
 * seeded Fisher–Yates shuffle. Deterministic per worldSeed.
 */
export function endPillars(worldSeed) {
  const ws = typeof worldSeed === 'number' ? (worldSeed >>> 0) : hashString(String(worldSeed ?? ''));
  const perm = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const rng = splitmix32((strongholdSeed(ws) ^ 0x51ab) >>> 0);
  for (let i = perm.length - 1; i > 0; i--) {   // Fisher–Yates
    const j = Math.floor(rng() * (i + 1));
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  const pillars = [];
  for (let i = 0; i < 10; i++) {
    const a = 2 * Math.PI * i / 10;
    const x = Math.round(43 * Math.cos(a)), z = Math.round(43 * Math.sin(a));
    const k = perm[i];
    const capY = HEIGHT_SET[k], r = RADIUS_SET[k];
    const caged = capY === 79 || capY === 82;
    pillars.push({ x, z, r, capY, caged, crystal: { x: x + 0.5, y: capY + 1, z: z + 0.5 } });
  }
  return pillars;
}

// §11.1 — the 20 vanilla gateway positions (radius-96 circle, Y 75, 18° apart),
// permuted per seed; spawnGateway(k) uses the k-th.
const GATEWAY_POS = [
  [96, 0], [91, 29], [77, 56], [56, 77], [29, 91], [-1, 96], [-30, 91], [-57, 77],
  [-78, 56], [-92, 29], [-96, -1], [-92, -30], [-78, -57], [-57, -78], [-30, -92],
  [0, -96], [29, -92], [56, -78], [77, -57], [91, -30],
];
export function endGatewayPositions(worldSeed) {
  const ws = typeof worldSeed === 'number' ? (worldSeed >>> 0) : hashString(String(worldSeed ?? ''));
  const perm = GATEWAY_POS.map((p, i) => i);
  const rng = splitmix32((strongholdSeed(ws) ^ 0x9e77) >>> 0);
  for (let i = perm.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  return perm.map(k => ({ x: GATEWAY_POS[k][0], z: GATEWAY_POS[k][1] }));
}
