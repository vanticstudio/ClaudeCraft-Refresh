// The 3 shared chunk ShaderMaterials (01 §8.7). Uniform objects are shared so
// one write updates every chunk. Light math per 04 §11.1–11.2.
// OVERHAUL §M — dual UV path: non-merged faces keep ABSOLUTE atlas UVs in
// `uv` (aSpan = 1,1 → step() selects the plain sample); greedy-merged quads
// emit TILE-LOCAL uv (0..span) + the tile's atlas origin in aTileUV, and the
// fragment shader folds them back with fract(). Adds per-vertex biome tint,
// and turns the light curve's ambient floor into a uniform (brightness option).
// B2 — GLSL3 + textureGrad: the merged path's fract() has a 1→0 discontinuity
// at every cell boundary inside a merged quad; with implicit derivatives the
// GPU spikes the mip level at the seam texel and samples the tile's average
// color — a visible grid on flat terrain. textureGrad() with the gradient
// taken from the UNFOLDED vUv (scaled into tile space) feeds the sampler a
// continuous derivative, so mip selection never sees the wrap. three r185 is
// WebGL2-only, so ES 3.0 core dFdx/dFdy/textureGrad need no extensions.
import * as THREE from 'three';
import { AMBIENT_FLOOR, TILE_PX, ATLAS_SIZE } from '../constants.js';

const VERT = /* glsl */`
in vec4 color;
in vec2 aSpan;
in vec2 aTileUV;
in vec3 tint;
out vec2 vUv; out vec4 vCol; out float vDist;
out vec2 vSpan; out vec2 vTileUV; out vec3 vTint;
void main() {
  vUv = uv; vCol = color;
  vSpan = aSpan; vTileUV = aTileUV; vTint = tint;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
uniform sampler2D uAtlas;
uniform float uSkyDarken;
uniform vec3 uSkyTint;
uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar;
uniform float uAlphaTest; uniform float uAlpha;
uniform float uDimAmbient;
uniform float uNightVision;
uniform float uBright;
in vec2 vUv; in vec4 vCol; in float vDist;
in vec2 vSpan; in vec2 vTileUV; in vec3 vTint;
out vec4 fragColor;
const vec3 BLOCK_TINT = vec3(1.00, 0.89, 0.69);
// inner tile span in atlas UV (TILE_PX-1 texels). aTileUV carries the tile's
// ALREADY-inset origin (uvRect u0 = (x0+0.5)/ATLAS_SIZE), so the merged path
// adds only the span — texel 0 centers and the far edge land exactly where the
// static path's (u0..u1) window does.
const float TILE_INNER = ${(((TILE_PX - 1) / ATLAS_SIZE)).toFixed(7)};
float brightness(float l) {
  float x = clamp(l, 0.0, 15.0) / 15.0;
  return uBright + (1.0 - uBright) * (x / (4.0 - 3.0 * x));
}
void main() {
  // merged path: fract() walks the tile texture across the quad's span; the
  // +1e-4-below-span vertex UVs keep the last texel sampled exactly. The mip
  // gradient rides the UNFOLDED vUv — continuous across the fract() wrap.
  float merged = step(2.01, vSpan.x + vSpan.y);
  vec2 f = fract(vUv);
  vec2 auv = mix(vUv, vTileUV + f * TILE_INNER, merged);
  vec4 tex = (merged > 0.5)
    ? textureGrad(uAtlas, auv, dFdx(vUv) * TILE_INNER, dFdy(vUv) * TILE_INNER)
    : texture(uAtlas, auv);
  if (tex.a < uAlphaTest) discard;
  float effSky = max(vCol.r * 15.0 - uSkyDarken, 0.0);
  // 09-POTIONS §6.5 / AMENDS 04 §11.2 — Night Vision floors the sky channel to 15.
  effSky = max(effSky, uNightVision * 15.0);
  vec3 light = max(brightness(vCol.g * 15.0) * BLOCK_TINT, brightness(effSky) * uSkyTint);
  // 10-NETHER §13.1 — per-dimension ambient floor; no cell renders below it.
  light = max(light, vec3(uDimAmbient));
  vec3 rgb = tex.rgb * vTint * light * vCol.b;
  float fog = smoothstep(uFogNear, uFogFar, vDist);
  fragColor = vec4(mix(rgb, uFogColor, fog), tex.a * uAlpha * vCol.a);
}`;

// Shared uniform objects — mutate .value only, never replace the objects.
export const sharedUniforms = {
  uAtlas: { value: null },
  uSkyDarken: { value: 0 },
  uSkyTint: { value: new THREE.Color(1, 1, 1) },
  uFogColor: { value: new THREE.Color(0.75, 0.85, 1.0) },
  uFogNear: { value: 96 },
  uFogFar: { value: 128 },
  // 10-NETHER §13.1 — per-dimension ambient floor (Nether 0.10).
  uDimAmbient: { value: 0.0 },
  // 09-POTIONS §6.5 — Night Vision sky-channel floor (0..1), written per frame.
  uNightVision: { value: 0.0 },
  // OVERHAUL §M — brightness option lifts the light-curve floor (0.04..0.22).
  uBright: { value: AMBIENT_FLOOR },
};

export function createChunkMaterials(atlasTexture) {
  sharedUniforms.uAtlas.value = atlasTexture;

  const make = (alphaTest, alpha, opts) => new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    glslVersion: THREE.GLSL3,
    uniforms: {
      ...sharedUniforms,
      uAlphaTest: { value: alphaTest },
      uAlpha: { value: alpha },
    },
    ...opts,
  });

  const opaque = make(0.0, 1.0, { side: THREE.FrontSide });
  const cutout = make(0.5, 1.0, { side: THREE.DoubleSide });
  // water tile alpha (0.7) lives in the atlas texel; lava texels are opaque —
  // one shared material serves both, so uAlpha stays 1.0 here.
  const water = make(0.0, 1.0, {
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
  });
  return { opaque, cutout, water };
}
