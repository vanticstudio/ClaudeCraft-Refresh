#!/usr/bin/env node
// ============================================================================
// U23 — B10 "Post-processing 'Fancy' pass" (19-BUILDOUT-v1.3 §B10). Self-
// contained ESM; mirrors the smoke harness's conventions (real imports, no
// frameworks, exit 0 = PASS / 1 = FAIL). Run: node scripts/checks/u23-postfx.mjs
//
// (a) GLSL3 CONTRACT on src/render/post.js (static string checks mirroring
//     smoke U13's approach, on the RAW source because the shader bodies live
//     in template literals): every post material compiles as ES 3.0 —
//     glslVersion: THREE.GLSL3 present, no gl_FragColor (GLSL3 ShaderMaterial
//     provides no compatibility define), no GLSL1 attribute/varying keywords,
//     every fragment declares its own `out vec4` (bright/blur/composite = 3),
//     no texture2D (removed in ES 3.0), texture() in use, and the quad vertex
//     shader does NOT redeclare position/uv (three injects them for
//     ShaderMaterial — a redeclaration is a link error).
// (b) SIZING MATH: the exported pure functions. targetSizeFor mirrors
//     renderer.setSize's Math.floor(width × pixelRatio) semantics and clamps
//     to ≥1; halfSizeFor (bright pass) ≥1; blurSizeFor (quarter-res blur
//     chain) stays ≥2 and EVEN across a sweep of degenerate and odd sizes.
// (c) TUNED CONSTANTS: threshold 0.85, intensity 0.6, vignette 0.22,
//     saturation 1.06 — exported consts, and each is injected into the GLSL
//     (identifier appears in the raw source as a template interpolation).
// (d) PostFX CLASS: exists, and the prototype carries resize/composite/
//     dispose (+ renderScene) — prototype check only, NO instantiation
//     (constructor allocates WebGL render targets; there is no WebGL in node).
// (e) GAME INTEGRATION ORDERING (static on src/Game.js raw source): the fancy
//     gate reads options?.fancy, the PostFX allocation is lazy (`??=`), and
//     postfx.composite() is ordered BEFORE the viewmodel branch's clearDepth —
//     the hand must draw on top of the composited frame into the default
//     framebuffer (§B10 2).
// ============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const POST = join(ROOT, 'src', 'render', 'post.js');
const GAME = join(ROOT, 'src', 'Game.js');

let failures = 0;
let checks = 0;
function report(id, title, fails, notes = []) {
  checks++;
  const ok = fails.length === 0;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  U23.${id}  ${title}`);
  for (const n of notes) console.log(`        note: ${n}`);
  for (const f of fails) console.log(`      - ${f}`);
}

async function main() {
  // ---------------------------------------------------------------- (a)
  const failsA = [], notesA = [];
  if (!existsSync(POST)) { report('a', 'GLSL3 contract', ['src/render/post.js not found']); }
  else {
    const src = readFileSync(POST, 'utf8');
    // RAW source (shader bodies are template literals) — anchor regexes to GLSL
    // usage so comment text cannot false-positive, exactly like smoke U13.
    if (!/glslVersion:\s*THREE\.GLSL3/.test(src))
      failsA.push('post materials missing glslVersion: THREE.GLSL3');
    if (/gl_FragColor/.test(src))
      failsA.push('shader writes gl_FragColor — illegal in explicit GLSL3 (declare out vec4)');
    if (/\battribute\s+(vec|float|mat|in)\b/.test(src) || /\bvarying\s+(vec|float|mat|in)\b/.test(src))
      failsA.push('GLSL1 attribute/varying keywords present — convert to in/out');
    const outs = [...src.matchAll(/out\s+vec4\s+\w+/g)].length;
    if (outs < 3) failsA.push(`expected ≥3 fragment out vec4 declarations (bright/blur/composite), found ${outs}`);
    if (/texture2D\s*\(/.test(src))
      failsA.push('texture2D() present — removed in GLSL ES 3.0, use texture()');
    if (!/texture\s*\(/.test(src)) failsA.push('no texture() sampling found in post shaders');
    // three injects `in vec3 position; in vec2 uv;` for ShaderMaterial — a
    // redeclaration in the quad vertex shader would be a compile/link error.
    if (/\bin\s+vec3\s+position\b/.test(src)) failsA.push('vertex redeclares `position` — three injects it for ShaderMaterial');
    if (/\bin\s+vec2\s+uv\b/.test(src)) failsA.push('vertex redeclares `uv` — three injects it for ShaderMaterial');
    // and the quad shader must actually USE the injected attributes
    if (!/position\.xy/.test(src)) failsA.push('quad vertex shader does not use position');
    if (!/vUv\s*=\s*uv/.test(src)) failsA.push('quad vertex shader does not pass uv through');
    notesA.push(`GLSL3 + ${outs} out vec4 + no GLSL1 keywords + injected attributes used, not redeclared`);
    report('a', 'GLSL3 contract — explicit out vec4, no gl_FragColor/GLSL1, quad uses injected position/uv', failsA, notesA);
  }

  // ---------------------------------------------------------------- (b)(c)(d)
  let post = null;
  try { post = await import(new URL('../../src/render/post.js', import.meta.url).href); }
  catch (e) {
    report('bcd', 'sizing math + constants + PostFX class', [`import failed: ${(e.stack || e).split('\n')[0]}`]);
  }
  if (post) {
    // (b) — sizing math
    const failsB = [], notesB = [];
    const { targetSizeFor, halfSizeFor, blurSizeFor } = post;
    if (typeof targetSizeFor !== 'function') failsB.push('targetSizeFor not exported');
    if (typeof halfSizeFor !== 'function') failsB.push('halfSizeFor not exported');
    if (typeof blurSizeFor !== 'function') failsB.push('blurSizeFor not exported');
    if (typeof targetSizeFor === 'function') {
      // mirrors renderer.setSize: canvas.width = Math.floor(width × pixelRatio)
      const eq = (got, w, h, tag) => {
        if (got.width !== w || got.height !== h) failsB.push(`${tag}: got ${got.width}×${got.height}, expected ${w}×${h}`);
      };
      eq(targetSizeFor(1920, 1080, 2), 3840, 2160, 'dpr 2');
      eq(targetSizeFor(1280.7, 720.9, 1), 1280, 720, 'fractional CSS px floors');
      eq(targetSizeFor(100, 50, 0.5), 50, 25, 'dpr 0.5 (resolutionScale)');
      eq(targetSizeFor(0.4, 0.2, 1), 1, 1, 'degenerate size clamps to ≥1');
      const t = targetSizeFor(1920, 1080, 2);
      eq(halfSizeFor(t.width, t.height), 1920, 1080, 'bright pass = half res');
      eq(halfSizeFor(1, 1), 1, 1, 'half of 1 clamps to ≥1');
      eq(blurSizeFor(t.width, t.height), 960, 540, 'blur chain = quarter res');
      // sweep: quarter dims must stay ≥2 AND even for any input, however odd
      let sweepBad = 0;
      for (let w = 1; w <= 64; w++) {
        for (let h = 1; h <= 64; h++) {
          const q = blurSizeFor(w, h);
          if (q.width < 2 || q.height < 2 || q.width % 2 !== 0 || q.height % 2 !== 0) sweepBad++;
        }
      }
      if (sweepBad) failsB.push(`${sweepBad}/4096 sweep sizes violate quarter ≥2 and even`);
      eq(blurSizeFor(7, 5), 2, 2, 'tiny window: quarter clamps to 2×2');
      notesB.push('floor(dpr×css) parity with setSize; half ≥1; quarter ≥2 and even across a 64² sweep');
    }
    report('b', 'sizing math — floor parity, ≥1 main/half, quarter ≥2 and even', failsB, notesB);

    // (c) — tuned constants
    const failsC = [], notesC = [];
    const want = [
      ['BLOOM_THRESHOLD', 0.85], ['BLOOM_INTENSITY', 0.6],
      ['BLOOM_VIGNETTE', 0.22], ['BLOOM_SATURATION', 1.06],
    ];
    for (const [k, v] of want) {
      if (post[k] !== v) failsC.push(`${k} = ${post[k]}, expected ${v}`);
    }
    if (existsSync(POST)) {
      const src = readFileSync(POST, 'utf8');
      for (const [k] of want) {
        // each const must be injected into the GLSL too (single source of truth)
        const uses = [...src.matchAll(new RegExp(`\\$\\{${k}\\}`, 'g'))].length;
        if (uses < 1) failsC.push(`${k} never injected into the shaders`);
      }
    }
    notesC.push('threshold 0.85, intensity 0.6, vignette 0.22, saturation 1.06 — all injected');
    report('c', 'tuned constants exported and injected into the GLSL', failsC, notesC);

    // (d) — PostFX class surface (prototype only; NO instantiation: the ctor
    // allocates WebGL render targets and node has no WebGL context)
    const failsD = [], notesD = [];
    if (typeof post.PostFX !== 'function') failsD.push('PostFX is not an exported class');
    else {
      for (const m of ['renderScene', 'composite', 'resize', 'dispose']) {
        if (typeof post.PostFX.prototype[m] !== 'function')
          failsD.push(`PostFX.prototype.${m} missing/not a function`);
      }
      notesD.push('prototype carries renderScene/composite/resize/dispose; not instantiated (no WebGL in node)');
    }
    report('d', 'PostFX class — resize/composite/dispose on the prototype (no instantiation)', failsD, notesD);
  }

  // ---------------------------------------------------------------- (e)
  const failsE = [], notesE = [];
  if (!existsSync(GAME)) { failsE.push('src/Game.js not found'); }
  else {
    const src = readFileSync(GAME, 'utf8');
    if (!/import\s*\{\s*PostFX\s*\}\s*from\s*'\.\/render\/post\.js'/.test(src))
      failsE.push('Game.js does not import PostFX from ./render/post.js');
    if (!/options\?\.fancy\s*===\s*true/.test(src))
      failsE.push('render path gate missing `this.options?.fancy === true`');
    if (!/\?\?=\s*new PostFX\(/.test(src))
      failsE.push('PostFX allocation is not lazy (`??= new PostFX(`) — would allocate when fancy is off');
    const iRenderScene = src.indexOf('postfx.renderScene(');
    const iComposite = src.indexOf('postfx.composite()');
    const iClearDepth = src.indexOf('this.renderer.clearDepth()');
    if (iRenderScene < 0 || iComposite < 0) failsE.push('fancy path missing postfx.renderScene()/composite() calls');
    else if (iClearDepth < 0) failsE.push('viewmodel branch lost its clearDepth() — manual depth clear contract broken');
    else if (iComposite > iClearDepth)
      failsE.push('composite() must run BEFORE the viewmodel branch — the hand draws on top of the composited frame');
    // baseline path must survive untouched: the plain scene render still exists
    if (!/this\.renderer\.render\(this\.scene,\s*this\.camera\);/.test(src))
      failsE.push('baseline `renderer.render(scene, camera)` no longer present');
    notesE.push('fancy gate → renderScene → composite → (viewmodel clearDepth + render); baseline render intact');
  }
  report('e', 'Game.render integration — fancy gate, lazy alloc, composite before the viewmodel depth clear', failsE, notesE);

  console.log(`\nU23 ${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks green`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('U23 harness threw:', e.stack || e);
  process.exit(1);
});