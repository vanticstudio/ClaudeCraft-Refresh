// Day/night cycle, sky darken, weather machine, snow/ice loop + B8 snow-layer
// scheduling, B8 thunder, sleep skip (04 §1–4, §6–7, §12, §14; 19-BUILDOUT B8).
// Feeds shader uniforms + Sky plumbing.
import * as THREE from 'three';
import { sharedUniforms } from '../mesh/materials.js';
import { Sky } from '../render/Sky.js';
import { B } from '../registry/blocks.js';
import { getDimension } from '../world/dimensions.js';
import { BIOME_TEMPS, BIOMES } from '../world/gen/biomes.js';
import { RENDER_RADIUS, chunkKey, SIM_RADIUS } from '../constants.js';
import { ChunkState } from '../world/Chunk.js';
import { EFFECT } from '../status/effects.js';
// B8 (19-BUILDOUT-v1.3.md) — thunder scheduling, snow-layer ticks, biome fog.
import { weatherTick } from '../world/thunder.js';                                        // B8 §1
import { scheduleSnowTick, snowTickDelay, tickSnow, MELT_TEMP } from '../world/snow.js';  // B8 §2
import { FOG_BY_BIOME, blendFog } from './fogTable.js';                                   // B8 §3

// 09-POTIONS §6.5 — Night Vision sky floor: steady 1.0, flash-blinking in the
// last 10 s (200 t) via a 10-tick sine (~1.0 → 0.4).
function nightVisionScale(player) {
  const fx = player?.effects?.get(EFFECT.NIGHT_VISION);
  if (!fx) return 0;
  if (fx.duration > 200) return 1.0;
  return 0.7 + 0.3 * Math.sin(fx.duration * Math.PI / 10);
}

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
// 11-END §7 — reused per-frame targets for the End's static dome colors. Sky.update
// copies them immediately, so allocating a THREE.Color here every frame was pure
// garbage during the dragon fight (the worst moment for the frame budget).
const endZenith = new THREE.Color(), endHorizon = new THREE.Color();

// B8 §3 — scratch target for the per-frame biome-fog blend: blendFog reads it
// synchronously and retains nothing, so one shared object is safe (same
// discipline as cScratch — no allocation in the render loop).
const fogTarget = { near: 0, far: 0, r: 0, g: 0, b: 0 };

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
    this.kf = {
      zenith: new THREE.Color(), horizon: new THREE.Color(), fog: new THREE.Color(),
      sunIntensity: 1, ambient: 0.9,
    };
    this.skyTint = new THREE.Color(1, 1, 1);
    this.fogColor = new THREE.Color();
    // B8 §3 — the LIVE blended fog, stored on the instance: an exponential
    // 2-second approach (fogTable.blendFog) toward the per-biome target each
    // frame, so biome-border crossings never pop. Seeded from the pre-B8
    // clear-sky defaults (96/128 + the 0xC0D8FF day color) — the first frame
    // after boot matches today's plains baseline exactly.
    this.biomeFog = { near: 96, far: 128, r: 192 / 255, g: 216 / 255, b: 1 };
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

    // 10-NETHER §13.1 / 11-END §7 — weather does not TICK in a no-sky dimension:
    // no snow/ice conversion, no strikes (in the End the heightMap follows the
    // island, so ungated bolts dealt 10 damage + fire mid-dragon-fight). The
    // timer/level machine above stays global (10-NETHER §2.6 keeps weather timers
    // global).
    const hasSky = getDimension(this.world.activeDim)?.hasSkyLight !== false;
    if (hasSky) {
      // 04 §12.5 freeze + B8 §2 snow scheduling — the loop now runs in BOTH
      // weather states: raining → freeze/accumulate rolls, clear → melt rolls.
      this.snowIceLoop();
      // B8 §1 — thunder: one 1/20000 roll per tick while rainLevel > 0.6, strike
      // ≤ 64 blocks from the player. Supersedes 04 §12.6's per-chunk 1/100000
      // loop (expansion spec > base); all strike effects live in thunder.js.
      if (this.rainLevel > 0.6) weatherTick(this);
    }
    // B8 §2 — drain the snow scheduled-tick queue (same cadence slot
    // world.scheduled.run() occupies in Game.tick). Runs even in no-sky dims so
    // overworld ticks pending during a Nether/End trip re-validate on return
    // instead of silently leaking in the bucket map.
    tickSnow(this.world);
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

  // 04 §12.5 — ice freeze + B8 §2 snow scheduling. One roll budget (1/16 per
  // chunk, one random cell per rolled chunk per tick) in both weather states:
  //   raining  → snow-temperature cells schedule an ACCUMULATE tick (the tick,
  //              not the roll, places/stacks the layer — B8 §2 "scheduled tick
  //              adds/stacks"); the §12.5 water→ice freeze stays a direct write.
  //   clear    → warm cells holding a snow layer schedule a MELT tick.
  // Accumulate gating stays 04 §12.5's snowfall predicate (temperatureAt ≤ 0.15)
  // rather than the raw SNOWY id: SNOWY is the canonical case (temp 0.0), and
  // altitude-cold MOUNTAINS keep their v1 snowfall — with melt gated on the same
  // threshold the two predicates stay symmetric and mountain caps persist.
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
        if (this.raining) {
          if (this.temperatureAt(x, top, z) > 0.15) continue;   // raining, not snowing
          const belowId = w.getBlock(x, top - 1, z);
          if (belowId === B.WATER && w.getState(x, top - 1, z) === 0) {
            if (w.getBlockLight(x, top - 1, z) < 10) w.setBlock(x, top - 1, z, B.ICE);
          } else {
            // B8 §2 — placement/stacking decided at consume (snowTick
            // re-validates air, support and the §12.5 light gate).
            scheduleSnowTick(w, x, top, z, snowTickDelay(w.rng));
          }
        } else if (w.getBlock(x, top, z) === B.SNOW_LAYER &&
                   (BIOME_TEMPS[w.biomeAt(x, z)] ?? 0.8) > MELT_TEMP) {
          // B8 §2 — warm biome + clear sky: one layer per scheduled melt tick.
          scheduleSnowTick(w, x, top, z, snowTickDelay(w.rng), 'melt');
        }
      }
    }
  }

  // 04 §12.6 strike visuals/effects superseded by B8 §1 — the scheduling roll
  // and the strike bundle (flash 2 t, particle bolt column, igniteAt fire,
  // 5 dmg fire-type box) live in src/world/thunder.js and are invoked from
  // tick() above. flash()/flashTicks remain here: they are the shared white-out
  // channel the strike rides.

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
      // B8 §1 — the strike's 2-tick white flash also rides the EXISTING ambient
      // channel (Sky.ambient.intensity, line below): a uFlash-like transient
      // without a new shader uniform. Floor at 1.0 so a night strike lights up.
      ambient = Math.max(ambient, 1);
    }

    // uSkyTint (04 §11.2): night tint eased
    const dayFactor = clamp((15 - skyDarkenF) / 15, 0, 1);
    const e2 = dayFactor * dayFactor * (3 - 2 * dayFactor);
    this.skyTint.setRGB(lerp(0.65, 1, e2), lerp(0.72, 1, e2), lerp(1.0, 1, e2));

    // fog (04 §7) + B8 §3 per-biome blend. The table's near/far are fractions
    // of R, scaled by the same rain/thunder shrink the pre-B8 fog applied; the
    // TINT multiplies kf.fog — the day-cycle + weather-desaturated color — so
    // night darkens and rain grays every biome before the hue shift lands.
    // Target = biome at the (camera =) player position; blendFog approaches it
    // exponentially over 2 s, stored on this.biomeFog, so a biome-border
    // crossing slides instead of popping. No-sky dims skip the blend (their fog
    // is fully overridden below); under-fluid frames keep blending — invisible
    // and it means surfacing is already on-target.
    const R = RENDER_RADIUS * 16;
    const dim = getDimension(this.world.activeDim);
    if (dim?.hasSkyLight !== false) {
      const camBiome = this.world.biomeAt(
        Math.floor(camera.position.x), Math.floor(camera.position.z));
      const fb = FOG_BY_BIOME[camBiome] ?? FOG_BY_BIOME[BIOMES.PLAINS];
      const rainMul = lerp(1.0, 0.85, this.rainLevel) * lerp(1.0, 0.75, this.thunderLevel);
      fogTarget.near = R * fb.near * rainMul;
      fogTarget.far = R * fb.far * rainMul;
      fogTarget.r = this.kf.fog.r * fb.tint[0];
      fogTarget.g = this.kf.fog.g * fb.tint[1];
      fogTarget.b = this.kf.fog.b * fb.tint[2];
      blendFog(this.biomeFog, fogTarget, dtSec);
    }
    let fogNear = this.biomeFog.near, fogFar = this.biomeFog.far;
    // B8 §3 — near and far blend independently, so crossing two distant rows
    // (e.g. OCEAN → DESERT) can transiently order them wrong — and
    // smoothstep(uFogNear, uFogFar, …) with edge0 ≥ edge1 is undefined GLSL.
    // Enforce a minimum band instead of risking the shader edge case.
    if (fogFar < fogNear + 8) fogFar = fogNear + 8;
    this.fogColor.setRGB(this.biomeFog.r, this.biomeFog.g, this.biomeFog.b);
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
    // (`dim` is fetched above the fog block — the B8 §3 blend gates on it.)
    const netherLike = dim && dim.sky?.kind === 'nether';
    // 11-END §7 — static void-purple sky: its own gradient + faint fog, no day cycle.
    const endLike = dim && dim.sky?.kind === 'end';
    // 10-NETHER §13.1 "no sunrise band, no clouds … weather does not render" /
    // 11-END §7 — one flag for every celestial/weather feed below.
    const noSky = !!dim && !dim.hasSkyLight;
    if (dim && !dim.hasSkyLight) {
      if (!underFluid) {
        this.fogColor.setHex((netherLike || endLike) ? dim.sky.clearColor : 0x000000);
        const R = 128;
        fogNear = endLike ? 0.5 * R : 0;              // §7 near 0.5·R
        fogFar = (netherLike || endLike) ? dim.sky.fogFar * R : R;
      }
      skyDarkenF = 0;
      this.skyTint.setRGB(1, 1, 1);
      sharedUniforms.uDimAmbient.value = dim.ambientLight;
    } else {
      sharedUniforms.uDimAmbient.value = 0;
    }
    // §7 — the End's scene lights are constant (DirectionalLight 0.12 / Ambient 0.25).
    if (endLike) { sunIntensity = 0.12; ambient = 0.25; }

    // 09-POTIONS §6.5 — Night Vision sky-channel floor, flash-blinking below 10 s.
    sharedUniforms.uNightVision.value = nightVisionScale(this.game.player);
    // OVERHAUL §M — brightness option lifts the light curve's ambient floor
    // (0 → 0.04 default; 100 → 0.24 "bright" MC parity).
    sharedUniforms.uBright.value = 0.04 + ((this.game.options?.brightness ?? 0) / 100) * 0.20;

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
      zenith: endLike ? endZenith.setHex(dim.sky.zenith) : (underFluid || netherLike) ? this.fogColor : this.kf.zenith,
      horizon: endLike ? endHorizon.setHex(dim.sky.horizon) : (underFluid || netherLike) ? this.fogColor : this.kf.horizon,
      starAlpha: (netherLike || endLike) ? 0 : starBrightness(t) * (1 - this.rainLevel),
      sunAlpha: (netherLike || endLike) ? 0 : (1 - this.rainLevel),
      // a null sunrise hides the band (Sky.update): it is additive with fog:false at
      // ±360 m, so ungated it blazed on the Nether/End horizon twice per game day.
      sunrise: noSky ? null : sunriseColor(t),
      cloudTint: (0.16 + 0.84 * sunIntensity) * (1 - 0.3 * this.rainLevel),
      sunIntensity, ambient,
      sunDir: sunDir.y > 0 ? sunDir : { x: -sunDir.x, y: -sunDir.y, z: 0 },
      world: this.world,
      rainLevel: noSky ? 0 : this.rainLevel,   // rain.count → 0 in dim 1 / dim 2
      moonBright: this.moonBrightness(),
      isSnowAt: (x, z) => this.isSnowAtColumn(x, z),
      dtSec,
    });
    // §13.1 — the cloud plane is parented to the scene, not to the sky group, and
    // its .visible was never touched: it hung at y = 110 over the End's void and
    // sliced through the Nether's high caverns (carved to y ≈ 122).
    this.sky.clouds.visible = !noSky;
    // 11-END §7 — the void-purple "static": the dome's grain term (Sky.js uStatic)
    // was declared and sampled but never raised, so dim 2 rendered a perfectly
    // smooth two-colour gradient that bands on large displays. On in the End only.
    this.sky.setStatic(endLike ? 1 : 0);
    if (endLike) {
      // §7 — pin the End's constant scene lights (defeat the day-cycle moonlight dim).
      this.sky.sunLight.intensity = 0.12;
      this.sky.ambient.intensity = 0.25;
    } else if (sunDir.y <= 0) {
      this.sky.sunLight.intensity = sunIntensity * 0.25;   // moonlight
    }
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

  // 14 AMENDS 04 §12.1 — a CLIENT never rolls weather RNG; it applies the host's
  // replicated scalars from timeSync and recomputes skyDarken from worldTime.
  applyNetWeather(m) {
    if (m.raining !== undefined) this.raining = m.raining;
    if (m.thundering !== undefined) this.thundering = m.thundering;
    if (m.rainLevel !== undefined) this.rainLevel = m.rainLevel;
    if (m.thunderLevel !== undefined) this.thunderLevel = m.thunderLevel;
    this.world.skyDarken = this.computeSkyDarken(this.world.time);
  }

  // 17-SHIP §1.5 — Sky.dispose() frees the dome/sun/moon/star/cloud/rain rig.
  // The B8 strike renders through the pooled particle system (no per-strike
  // meshes, no in-flight bolts to unwind here).
  dispose() {
    this.sky.dispose();
  }
}
