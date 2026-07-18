// Day/night cycle, sky darken, weather machine, snow/ice loop, lightning,
// sleep skip (04 §1–4, §6–7, §12, §14). Feeds shader uniforms + Sky plumbing.
import * as THREE from 'three';
import { sharedUniforms } from '../mesh/materials.js';
import { Sky } from '../render/Sky.js';
import { BLOCKS, B, isSolidSupport } from '../registry/blocks.js';
import { emitSound, at } from '../audio/engine.js';
import { getDimension } from '../world/dimensions.js';
import { lightningIgnite } from '../world/fire.js';
import { BIOME_TEMPS } from '../world/gen/biomes.js';
import { RENDER_RADIUS, chunkKey, SIM_RADIUS } from '../constants.js';
import { ChunkState } from '../world/Chunk.js';
import { AABB } from '../math/aabb.js';
import { LivingEntity } from '../entities/Entity.js';

const frac = x => x - Math.floor(x);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

// 04 §3 — vanilla time → sun-position mapping
export function celestialAngle(t) {
  const f = frac(t / 24000 - 0.25);
  const g = 0.5 - Math.cos(f * Math.PI) / 2;
  return (f * 2 + g) / 3;
}

// 04 §5.4 — star alpha
function starBrightness(t) {
  let f = 1 - (Math.cos(celestialAngle(t) * 2 * Math.PI) * 2 + 0.25);
  f = clamp(f, 0, 1);
  return f * f * 0.5;
}

// 04 §5.5 — sunrise/sunset band color
function sunriseColor(t) {
  const c = Math.cos(celestialAngle(t) * 2 * Math.PI);
  if (c < -0.4 || c > 0.4) return null;
  const s = c / 0.4 * 0.5 + 0.5;
  let a = 1 - (1 - Math.sin(s * Math.PI)) * 0.99;
  a *= a;
  return { r: s * 0.3 + 0.7, g: s * s * 0.7 + 0.2, b: 0.2, a };
}

// 04 §6 — sky color keyframes [dayTime, zenith, horizon, fog, sunIntensity, ambient]
const KEYS = [
  [0,     0x4A73C4, 0xFFB877, 0xC7A177, 0.45, 0.45],
  [1000,  0x78A7FF, 0xC6DBFF, 0xC0D8FF, 1.00, 0.90],
  [6000,  0x78A7FF, 0xC6DBFF, 0xC0D8FF, 1.00, 0.90],
  [11000, 0x78A7FF, 0xC6DBFF, 0xC0D8FF, 0.95, 0.85],
  [12000, 0x6E9BF2, 0xE8C79E, 0xD6B489, 0.75, 0.65],
  [12786, 0x2E3D74, 0xFF9040, 0x9E7052, 0.35, 0.35],
  [13670, 0x050815, 0x131A33, 0x0C101F, 0.08, 0.14],
  [18000, 0x000208, 0x0A0F22, 0x060912, 0.06, 0.12],
  [22331, 0x0A1030, 0x1B2447, 0x121830, 0.10, 0.16],
  [23215, 0x274073, 0xE2894C, 0x8F6E51, 0.30, 0.32],
  [24000, 0x4A73C4, 0xFFB877, 0xC7A177, 0.45, 0.45],   // wrap to key 0
];

const MOON_BRIGHTNESS = [1.0, 0.75, 0.5, 0.25, 0.0, 0.25, 0.5, 0.75];

const cScratch = [new THREE.Color(), new THREE.Color(), new THREE.Color()];

function keyframeAt(dayTime, out) {
  let i = 0;
  while (i < KEYS.length - 1 && KEYS[i + 1][0] <= dayTime) i++;
  const a = KEYS[i], b = KEYS[Math.min(i + 1, KEYS.length - 1)];
  const span = Math.max(1, b[0] - a[0]);
  const t = clamp((dayTime - a[0]) / span, 0, 1);
  out.zenith.setHex(a[1]).lerp(cScratch[0].setHex(b[1]), t);
  out.horizon.setHex(a[2]).lerp(cScratch[1].setHex(b[2]), t);
  out.fog.setHex(a[3]).lerp(cScratch[2].setHex(b[3]), t);
  out.sunIntensity = lerp(a[4], b[4], t);
  out.ambient = lerp(a[5], b[5], t);
  return out;
}

// 04 §6 — weather desaturation
function weatherTint(color, rainLevel, thunderLevel) {
  let gray = (0.3 * color.r + 0.59 * color.g + 0.11 * color.b) * 0.6;
  color.lerp(cScratch[0].setRGB(gray, gray, gray), rainLevel * 0.75);
  gray = (0.3 * color.r + 0.59 * color.g + 0.11 * color.b) * 0.2;
  color.lerp(cScratch[0].setRGB(gray, gray, gray), thunderLevel * 0.75);
  return color;
}

export class DayNight {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.sky = new Sky(game.scene);
    this.scene = game.scene;

    // weather state (04 §12.1)
    this.raining = false;
    this.thundering = false;
    this.rainTimer = this.randInt(12000, 180000);
    this.thunderTimer = this.randInt(12000, 180000);
    this.rainLevel = 0;
    this.thunderLevel = 0;

    this.flashTicks = 0;
    this.lightningMeshes = [];
    this.kf = {
      zenith: new THREE.Color(), horizon: new THREE.Color(), fog: new THREE.Color(),
      sunIntensity: 1, ambient: 0.9,
    };
    this.skyTint = new THREE.Color(1, 1, 1);
    this.fogColor = new THREE.Color();
    this.scene.fog = new THREE.Fog(0xc0d8ff, 96, 128);
    this.lastFrameTime = performance.now();
    this.moonPhase = -1;
  }

  randInt(a, b) { return a + Math.floor(this.world.rng() * (b - a + 1)); }

  get dayTime() { return this.world.time % 24000; }
  get dayCount() { return Math.floor(this.world.time / 24000); }
  get isThunderstorm() { return this.raining && this.thundering; }
  get isDay() { return this.world.skyDarken < 4; }

  moonBrightness() { return MOON_BRIGHTNESS[this.dayCount % 8]; }

  // 04 §4
  computeSkyDarken(t, floor = true) {
    const a = celestialAngle(t);
    const day = 0.5 + 2 * clamp(Math.cos(a * 2 * Math.PI), -0.25, 0.25);
    const rainMul = 1 - (this.rainLevel * 5) / 16;
    const thunderMul = 1 - (this.thunderLevel * 5) / 16;
    const v = (1 - day * rainMul * thunderMul) * 11;
    return floor ? Math.floor(v) : v;
  }

  tick() {
    this.world.time++;
    this.world.skyDarken = this.computeSkyDarken(this.world.time);

    // weather machine (04 §12.1)
    if (--this.rainTimer <= 0) {
      this.raining = !this.raining;
      this.rainTimer = this.raining ? this.randInt(12000, 24000) : this.randInt(12000, 180000);
    }
    if (--this.thunderTimer <= 0) {
      this.thundering = !this.thundering;
      this.thunderTimer = this.thundering ? this.randInt(3600, 15600) : this.randInt(12000, 180000);
    }
    this.rainLevel = clamp(this.rainLevel + (this.raining ? 0.01 : -0.01), 0, 1);
    this.thunderLevel = clamp(this.thunderLevel + (this.thundering ? 0.01 : -0.01), 0, 1);

    if (this.flashTicks > 0) this.flashTicks--;

    if (this.raining) this.snowIceLoop();
    if (this.isThunderstorm) this.lightningLoop();
    this.tickLightningMeshes();
  }

  // 04 §12.4 — biome temperature with altitude falloff
  temperatureAt(x, y, z) {
    const biome = this.world.biomeAt(Math.floor(x), Math.floor(z));
    return (BIOME_TEMPS[biome] ?? 0.8) - Math.max(0, y - 80) * 0.00125;
  }

  isRainingAt(x, y, z) {
    return this.raining &&
      this.world.canSeeSky(x, Math.floor(y), z) &&
      this.temperatureAt(x, y, z) > 0.15;
  }

  isSnowAtColumn(x, z) {
    const top = this.world.heightTop(Math.floor(x), Math.floor(z));
    return this.temperatureAt(x, top, z) <= 0.15;
  }

  // 04 §12.5 — snow layers + ice while raining
  snowIceLoop() {
    const w = this.world;
    const p = w.playerChunk;
    if (!p) return;
    for (let dcx = -SIM_RADIUS; dcx <= SIM_RADIUS; dcx++) {
      for (let dcz = -SIM_RADIUS; dcz <= SIM_RADIUS; dcz++) {
        if (w.rng() > 1 / 16) continue;
        const chunk = w.chunks.get(chunkKey(p.cx + dcx, p.cz + dcz));
        if (!chunk || chunk.state < ChunkState.GENERATED) continue;
        const lx = (w.rng() * 16) | 0, lz = (w.rng() * 16) | 0;
        const x = chunk.cx * 16 + lx, z = chunk.cz * 16 + lz;
        const top = chunk.heightMap[(lz << 4) | lx];
        if (top <= 0 || top > 127) continue;
        if (this.temperatureAt(x, top, z) > 0.15) continue;   // raining, not snowing
        const belowId = w.getBlock(x, top - 1, z);
        if (belowId === B.WATER && w.getState(x, top - 1, z) === 0) {
          if (w.getBlockLight(x, top - 1, z) < 10) w.setBlock(x, top - 1, z, B.ICE);
        } else if (w.getBlock(x, top, z) === B.AIR && isSolidSupport(belowId) &&
                   w.getBlockLight(x, top, z) < 10) {
          w.setBlock(x, top, z, B.SNOW_LAYER);
        }
      }
    }
  }

  // 04 §12.6 — lightning
  lightningLoop() {
    const w = this.world;
    const p = w.playerChunk;
    if (!p) return;
    for (let dcx = -SIM_RADIUS; dcx <= SIM_RADIUS; dcx++) {
      for (let dcz = -SIM_RADIUS; dcz <= SIM_RADIUS; dcz++) {
        if (w.rng() >= 1 / 100000) continue;
        const chunk = w.chunks.get(chunkKey(p.cx + dcx, p.cz + dcz));
        if (!chunk || chunk.state < ChunkState.GENERATED) continue;
        const lx = (w.rng() * 16) | 0, lz = (w.rng() * 16) | 0;
        const x = chunk.cx * 16 + lx, z = chunk.cz * 16 + lz;
        const y = chunk.heightMap[(lz << 4) | lx];
        this.strikeLightning(x + 0.5, y, z + 0.5);
      }
    }
  }

  strikeLightning(x, y, z) {
    const w = this.world;
    this.flash(3);
    // AMENDS 04 §12.6 — 04 deleted the sound, not the strike, so this is purely
    // additive. The recipe derives both the <24-block crack and the
    // t0 + d x 0.06 s rumble from the distance to this position (16 §3.5).
    emitSound('weather.thunder', at(x, y, z));
    // visual: white column with jogs
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color: 0xf4f8ff, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.9,
      depthWrite: false, fog: false,
    });
    let cx = x, cz = z;
    let prevY = y;
    for (let s = 0; s < 4; s++) {
      const nextY = y + (s + 1) * 16;
      const seg = new THREE.Mesh(new THREE.BoxGeometry(0.3, nextY - prevY, 0.3), mat);
      seg.position.set(cx, (prevY + nextY) / 2, cz);
      group.add(seg);
      cx += (w.rng() - 0.5) * 4;
      cz += (w.rng() - 0.5) * 4;
      prevY = nextY;
    }
    this.scene.add(group);
    this.lightningMeshes.push({ group, life: 6 });

    // gameplay: fire + 10 dmg within 3 m (04 §12.6, numbers per 05)
    // AMENDS 04 §12.6 / 15 §4.3 — fire (age 0) at the strike cell if canSurvive,
    // then 4 extra ±1-per-axis attempts, each only if air + canSurvive. Each
    // registers a §6 ignition origin. The old test was isSolidSupport-only: a
    // strict subset of §1.2's canSurvive (which also accepts a flammable
    // neighbor), and it bypassed the origin map entirely.
    lightningIgnite(w, Math.floor(x), y, Math.floor(z));
    const box = new AABB(x - 3, y - 3, z - 3, x + 3, y + 3, z + 3);
    for (const e of w.getEntitiesInBox(box, ent => ent instanceof LivingEntity)) {
      e.hurt(10, 'lightning');
      if (e.fireTicks !== undefined) e.fireTicks = Math.max(e.fireTicks, 160);
    }
  }

  tickLightningMeshes() {
    for (let i = this.lightningMeshes.length - 1; i >= 0; i--) {
      const L = this.lightningMeshes[i];
      if (--L.life <= 0) {
        this.scene.remove(L.group);
        this.lightningMeshes.splice(i, 1);
      }
    }
  }

  flash(ticks) { this.flashTicks = Math.max(this.flashTicks, ticks); }

  // 04 §14
  canSleepNow() {
    if (this.isThunderstorm) return true;
    return this.world.skyDarken >= 4;
  }

  sleepSkip() {
    this.world.time = (Math.floor(this.world.time / 24000) + 1) * 24000;
    if (this.raining) {
      this.raining = false;
      this.thundering = false;
      this.rainTimer = this.randInt(12000, 180000);
      this.thunderTimer = this.randInt(12000, 180000);
    }
    this.world.skyDarken = this.computeSkyDarken(this.world.time);
  }

  // ------------------------------------------------------------ per-frame

  updateRender(alpha, camera) {
    const now = performance.now();
    const dtSec = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    const t = this.world.time + alpha;
    const dayTime = t % 24000;
    const angle = celestialAngle(t);
    let skyDarkenF = this.computeSkyDarken(t, false);
    if (this.flashTicks > 0) skyDarkenF = 0;   // lightning flash (04 §11.2)

    keyframeAt(dayTime, this.kf);
    weatherTint(this.kf.zenith, this.rainLevel, this.thunderLevel);
    weatherTint(this.kf.horizon, this.rainLevel, this.thunderLevel);
    weatherTint(this.kf.fog, this.rainLevel, this.thunderLevel);
    let sunIntensity = this.kf.sunIntensity *
      (1 - 0.65 * this.rainLevel) * (1 - 0.5 * this.thunderLevel);
    let ambient = this.kf.ambient * (1 - 0.5 * this.rainLevel);
    if (this.flashTicks > 0) {
      this.kf.zenith.lerp(cScratch[0].setRGB(1, 1, 1), 0.5);
      this.kf.horizon.lerp(cScratch[0].setRGB(1, 1, 1), 0.5);
      sunIntensity = 1;
    }

    // uSkyTint (04 §11.2): night tint eased
    const dayFactor = clamp((15 - skyDarkenF) / 15, 0, 1);
    const e2 = dayFactor * dayFactor * (3 - 2 * dayFactor);
    this.skyTint.setRGB(lerp(0.65, 1, e2), lerp(0.72, 1, e2), lerp(1.0, 1, e2));

    // fog (04 §7)
    const R = RENDER_RADIUS * 16;
    const rEff = R * lerp(1.0, 0.85, this.rainLevel) * lerp(1.0, 0.75, this.thunderLevel);
    let fogNear = 0.75 * rEff, fogFar = rEff;
    this.fogColor.copy(this.kf.fog);
    const camBlock = this.world.getBlock(
      Math.floor(camera.position.x), Math.floor(camera.position.y), Math.floor(camera.position.z));
    let underFluid = false;
    if (camBlock === B.WATER) {
      this.fogColor.setHex(0x050533); fogNear = 0; fogFar = 32; underFluid = true;
    } else if (camBlock === B.LAVA) {
      this.fogColor.setHex(0x991900); fogNear = 0.25; fogFar = 1.0; underFluid = true;
    }

    // 10-NETHER §13.1 — no-sky dimensions override the sky/fog/ambient. A flat
    // fog-colored void, dense short fog, no time darkening, and the ambient floor.
    const dim = getDimension(this.world.activeDim);
    const netherLike = dim && dim.sky?.kind === 'nether';
    if (dim && !dim.hasSkyLight) {
      if (!underFluid) {
        this.fogColor.setHex(netherLike ? dim.sky.clearColor : 0x000000);
        const R = 128;
        fogNear = 0;
        fogFar = netherLike ? dim.sky.fogFar * R : R;
      }
      skyDarkenF = 0;
      this.skyTint.setRGB(1, 1, 1);
      sharedUniforms.uDimAmbient.value = dim.ambientLight;
    } else {
      sharedUniforms.uDimAmbient.value = 0;
    }

    // shared chunk-shader uniforms (01 §8.7)
    sharedUniforms.uSkyDarken.value = skyDarkenF;
    sharedUniforms.uSkyTint.value.copy(this.skyTint);
    sharedUniforms.uFogColor.value.copy(this.fogColor);
    sharedUniforms.uFogNear.value = fogNear;
    sharedUniforms.uFogFar.value = fogFar;
    this.scene.fog.color.copy(this.fogColor);
    this.scene.fog.near = fogNear;
    this.scene.fog.far = fogFar;

    // moon phase
    const phase = this.dayCount % 8;
    if (phase !== this.moonPhase) {
      this.moonPhase = phase;
      this.sky.setMoonPhase(phase);
    }

    const a2 = angle * Math.PI * 2;
    const sunDir = { x: -Math.sin(a2), y: Math.cos(a2), z: 0 };
    this.sky.update({
      camera, angle,
      // 10-NETHER §13.1 — flat fog-colored void, no sun/moon/stars in no-sky dims.
      zenith: (underFluid || netherLike) ? this.fogColor : this.kf.zenith,
      horizon: (underFluid || netherLike) ? this.fogColor : this.kf.horizon,
      starAlpha: netherLike ? 0 : starBrightness(t) * (1 - this.rainLevel),
      sunAlpha: netherLike ? 0 : (1 - this.rainLevel),
      sunrise: sunriseColor(t),
      cloudTint: (0.16 + 0.84 * sunIntensity) * (1 - 0.3 * this.rainLevel),
      sunIntensity, ambient,
      sunDir: sunDir.y > 0 ? sunDir : { x: -sunDir.x, y: -sunDir.y, z: 0 },
      world: this.world,
      rainLevel: this.rainLevel,
      moonBright: this.moonBrightness(),
      isSnowAt: (x, z) => this.isSnowAtColumn(x, z),
      dtSec,
    });
    if (sunDir.y <= 0) this.sky.sunLight.intensity = sunIntensity * 0.25;   // moonlight
  }

  serialize() {
    return {
      raining: this.raining, thundering: this.thundering,
      rainTimer: this.rainTimer, thunderTimer: this.thunderTimer,
      rainLevel: this.rainLevel, thunderLevel: this.thunderLevel,
    };
  }

  deserialize(rec) {
    if (!rec) return;
    this.raining = rec.raining ?? false;
    this.thundering = rec.thundering ?? false;
    this.rainTimer = rec.rainTimer ?? this.rainTimer;
    this.thunderTimer = rec.thunderTimer ?? this.thunderTimer;
    this.rainLevel = rec.rainLevel ?? 0;
    this.thunderLevel = rec.thunderLevel ?? 0;
  }

  dispose() { this.sky.dispose(); }
}
