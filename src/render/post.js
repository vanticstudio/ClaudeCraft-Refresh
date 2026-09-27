// B10 — Post-processing "Fancy" pass (19-BUILDOUT-v1.3 §B10). Optional bloom +
// vignette + subtle grade over the unlit voxel pipeline, OFF by default.
//
// WHY a single fixed chain: the pipeline is flat unlit colors, so the ONLY
// high-luminance texels are emissive surfaces (lava / glowstone / portal /
// fire) — a hard luminance threshold is a reliable emissive selector with no
// HDR buffer needed. Everything is LDR UnsignedByte targets: the chunk
// ShaderMaterials write raw values (no colorspace_fragment include, renderer
// gamma pass-through), so blitting scene→RT→screen with raw ShaderMaterials is
// pixel-identical to the baseline before bloom/vignette/grade touch it.
//
// WHY these target sizes: the scene pass targets the DRAWING BUFFER (canvas
// width/height — already pixelRatio-scaled by renderer.setSize's Math.floor),
// matching the baseline's antialias resolution. `samples: 4` gives the
// offscreen pass MSAA parity with the antialias:true default framebuffer, so
// Fancy never looks jaggier than Fast. Bloom is half-res bright pass + two
// quarter-res separable blurs — the spec's ~2 ms @ 1080p iGPU budget.
//
// WHY per-frame size check instead of a resize listener: renderer.js owns the
// window resize handler (out of bounds); the drawing-buffer dims are the
// single authority (they change on window resize AND setResolutionScale), so
// comparing canvas.width to the target each frame catches every resizer with
// zero allocation and zero new listeners.
import * as THREE from 'three';

// Tuned constants — module-level so u23 can assert them and the GLSL below
// injects the SAME values (single source of truth).
export const BLOOM_THRESHOLD = 0.85;   // luminance gate; flat colors ⇒ only emissive texels pass
export const BLOOM_INTENSITY = 0.6;    // bloom add scale on composite
export const BLOOM_VIGNETTE = 0.22;    // max corner darkening (smoothstep radial, corners only)
export const BLOOM_SATURATION = 1.06;  // luma→color mix factor (subtle grade)

// Sizing math (pure, u23-tested). renderer.setSize floors width × pixelRatio
// into the canvas drawing buffer — mirror that exactly, clamped to ≥1 so a
// degenerate/fractional size can never allocate a 0-wide target.
export function targetSizeFor(width, height, pixelRatio) {
  return {
    width: Math.max(1, Math.floor(width * pixelRatio)),
    height: Math.max(1, Math.floor(height * pixelRatio)),
  };
}

// Bright-pass target: half res, ≥1 (pure downsample of the scene texture).
export function halfSizeFor(width, height) {
  return {
    width: Math.max(1, Math.floor(width / 2)),
    height: Math.max(1, Math.floor(height / 2)),
  };
}

// Blur-chain targets: quarter res, EVEN dims (≥2) so the ±4-tap offsets stay
// symmetric around texel centers and a tiny window never degenerates.
export function blurSizeFor(width, height) {
  const even = n => Math.max(2, Math.floor(n / 4) & ~1);
  return { width: even(width), height: even(height) };
}

// Fullscreen triangle in clip space — one geometry shared by every post pass
// (the mesh's material is swapped per pass). ShaderMaterial with GLSL3: three
// injects the standard position/uv attribute declarations itself, so they must
// NOT be redeclared here (a redeclaration is a link error).
const QUAD_VERT = /* glsl */`
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const BRIGHT_FRAG = /* glsl */`
uniform sampler2D tScene;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 c = texture(tScene, vUv).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // keep only luminance above the threshold, scaled so the cut is smooth —
  // flat unlit colors make this an exact emissive selector
  float w = max(lum - ${BLOOM_THRESHOLD}, 0.0) / max(lum, 1e-4);
  fragColor = vec4(c * w, 1.0);
}`;

// 9-tap separable gaussian (5 unique weights mirrored; sum = 1.0). uDir is the
// SOURCE texel step for the current direction, set per pass in renderScene().
const BLUR_FRAG = /* glsl */`
uniform sampler2D tInput;
uniform vec2 uDir;
in vec2 vUv;
out vec4 fragColor;
void main() {
  const float w0 = 0.2270270270;
  const float w1 = 0.1945945946;
  const float w2 = 0.1216216216;
  const float w3 = 0.0540540541;
  const float w4 = 0.0162162162;
  vec3 acc = texture(tInput, vUv).rgb * w0;
  vec2 o1 = uDir * 1.0; vec2 o2 = uDir * 2.0; vec2 o3 = uDir * 3.0; vec2 o4 = uDir * 4.0;
  acc += (texture(tInput, vUv + o1).rgb + texture(tInput, vUv - o1).rgb) * w1;
  acc += (texture(tInput, vUv + o2).rgb + texture(tInput, vUv - o2).rgb) * w2;
  acc += (texture(tInput, vUv + o3).rgb + texture(tInput, vUv - o3).rgb) * w3;
  acc += (texture(tInput, vUv + o4).rgb + texture(tInput, vUv - o4).rgb) * w4;
  fragColor = vec4(acc, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */`
uniform sampler2D tScene;
uniform sampler2D tBloom;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 c = texture(tScene, vUv).rgb;
  // bloom add — the blurred emissive halo from the quarter-res chain
  c += texture(tBloom, vUv).rgb * ${BLOOM_INTENSITY};
  // vignette: radial mask reaching full strength only at the corners
  // (elliptical in screen space, so the outer edge = corner distance 0.7071)
  float vig = 1.0 - ${BLOOM_VIGNETTE} * smoothstep(0.45, 0.7071, length(vUv - 0.5));
  c *= vig;
  // grade: push saturation slightly past neutral
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(lum), c, ${BLOOM_SATURATION});
  fragColor = vec4(c, 1.0);
}`;

export class PostFX {
  // Allocated ONCE per Game lifetime (lazy — Game constructs it on the first
  // fancy frame) and kept across toggle-off frames: the spec's "the toggle
  // drops all passes (no swapchain churn)".
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;             // renderScene() defaults to these — Game passes explicit args
    this.camera = camera;

    // Main target = the drawing buffer (already pixelRatio-scaled device px).
    const el = renderer.domElement;
    const main = targetSizeFor(el.width, el.height, 1);
    const bright = halfSizeFor(main.width, main.height);
    const blur = blurSizeFor(main.width, main.height);
    this.sceneRT = new THREE.WebGLRenderTarget(main.width, main.height, {
      samples: 4,             // MSAA parity with the antialias:true default framebuffer
      depthBuffer: true,      // the scene pass depth-tests as usual
      stencilBuffer: false,   // context created with stencil: false
    });
    this.brightRT = new THREE.WebGLRenderTarget(bright.width, bright.height, { depthBuffer: false });
    this.blurA = new THREE.WebGLRenderTarget(blur.width, blur.height, { depthBuffer: false });
    this.blurB = new THREE.WebGLRenderTarget(blur.width, blur.height, { depthBuffer: false });

    const mk = (fragmentShader, uniforms) => new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader,
      glslVersion: THREE.GLSL3,
      uniforms,
      // post passes are fullscreen overwrites: no depth state, no blending,
      // values land in the target exactly as computed
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.brightMat = mk(BRIGHT_FRAG, {
      tScene: { value: this.sceneRT.texture },
    });
    this.blurMat = mk(BLUR_FRAG, {
      tInput: { value: null },
      uDir: { value: new THREE.Vector2() },
    });
    this.compositeMat = mk(COMPOSITE_FRAG, {
      tScene: { value: this.sceneRT.texture },
      tBloom: { value: this.blurB.texture },
    });

    this.quad = new THREE.Mesh(this.makeQuadGeometry(), this.brightMat);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  makeQuadGeometry() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(
      new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    return geo;
  }

  // Resize ALL targets. w/h are drawing-buffer px (Game's per-frame check reads
  // renderer.domElement.width/height); ratio 1 because they are already device px.
  resize(w, h) {
    const main = targetSizeFor(w, h, 1);
    const bright = halfSizeFor(main.width, main.height);
    const blur = blurSizeFor(main.width, main.height);
    // setSize keeps the same texture objects, so the material uniform refs
    // above stay valid — no re-wiring needed.
    this.sceneRT.setSize(main.width, main.height);
    this.brightRT.setSize(bright.width, bright.height);
    this.blurA.setSize(blur.width, blur.height);
    this.blurB.setSize(blur.width, blur.height);
  }

  // Offscreen chain: scene → full-res MSAA target → bright (half) → blur H then
  // V (quarter). Leaves the render target set; composite() owns the switch back
  // to the default framebuffer (the two are always called as a pair from Game).
  renderScene(scene = this.scene, camera = this.camera) {
    const r = this.renderer;
    const el = r.domElement;
    if (el.width !== this.sceneRT.width || el.height !== this.sceneRT.height) {
      this.resize(el.width, el.height);
    }
    // autoClear is false globally (viewmodel contract), so clear the scene
    // target explicitly — mirrors the frame-start clear the baseline path does.
    r.setRenderTarget(this.sceneRT);
    r.clear(true, true, false);
    r.render(scene, camera);

    this.quad.material = this.brightMat;
    r.setRenderTarget(this.brightRT);
    r.render(this.quadScene, this.quadCam);

    this.quad.material = this.blurMat;
    // horizontal: source is the half-res bright target
    this.blurMat.uniforms.tInput.value = this.brightRT.texture;
    this.blurMat.uniforms.uDir.value.set(1 / this.brightRT.width, 0);
    r.setRenderTarget(this.blurA);
    r.render(this.quadScene, this.quadCam);
    // vertical: source is the horizontal result
    this.blurMat.uniforms.tInput.value = this.blurA.texture;
    this.blurMat.uniforms.uDir.value.set(0, 1 / this.blurA.height);
    r.setRenderTarget(this.blurB);
    r.render(this.quadScene, this.quadCam);
  }

  // Composite to the DEFAULT framebuffer (scene + bloom + vignette + grade).
  // Game's viewmodel branch runs right after this, unchanged: its clearDepth +
  // render land on the same default framebuffer, so the hand draws on top.
  composite() {
    const r = this.renderer;
    this.quad.material = this.compositeMat;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
  }

  // No Game-level teardown hook exists (disposeWorld is world-scoped; the
  // renderer/materials are never disposed) — this is here for a future
  // pagehide/destroy path and for symmetry with every other render resource.
  dispose() {
    this.sceneRT.dispose();
    this.brightRT.dispose();
    this.blurA.dispose();
    this.blurB.dispose();
    this.brightMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this.quad.geometry.dispose();
  }
}