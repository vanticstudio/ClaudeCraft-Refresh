// The 3 shared chunk ShaderMaterials (01 §8.7). Uniform objects are shared so
// one write updates every chunk. Light math per 04 §11.1–11.2.
import * as THREE from 'three';
import { AMBIENT_FLOOR } from '../constants.js';

const VERT = /* glsl */`
attribute vec4 color;
varying vec2 vUv; varying vec4 vCol; varying float vDist;
void main() {
  vUv = uv; vCol = color;
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
varying vec2 vUv; varying vec4 vCol; varying float vDist;
const vec3 BLOCK_TINT = vec3(1.00, 0.89, 0.69);
const float AMBIENT_FLOOR = ${AMBIENT_FLOOR.toFixed(3)};
float brightness(float l) {
  float x = clamp(l, 0.0, 15.0) / 15.0;
  return AMBIENT_FLOOR + (1.0 - AMBIENT_FLOOR) * (x / (4.0 - 3.0 * x));
}
void main() {
  vec4 tex = texture2D(uAtlas, vUv);
  if (tex.a < uAlphaTest) discard;
  float effSky = max(vCol.r * 15.0 - uSkyDarken, 0.0);
  vec3 light = max(brightness(vCol.g * 15.0) * BLOCK_TINT, brightness(effSky) * uSkyTint);
  // 10-NETHER §13.1 — per-dimension ambient floor; no cell renders below it.
  light = max(light, vec3(uDimAmbient));
  vec3 rgb = tex.rgb * light * vCol.b;
  float fog = smoothstep(uFogNear, uFogFar, vDist);
  gl_FragColor = vec4(mix(rgb, uFogColor, fog), tex.a * uAlpha * vCol.a);
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
};

export function createChunkMaterials(atlasTexture) {
  sharedUniforms.uAtlas.value = atlasTexture;

  const make = (alphaTest, alpha, opts) => new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
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
