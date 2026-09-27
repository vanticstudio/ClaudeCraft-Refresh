// WebGLRenderer + camera + resize (01 §1).
// OVERHAUL §C — antialiasing on (voxel edges were the #1 aliasing source at
// DPR≤2), and a live resolution scale: setResolutionScale() multiplies the
// device-pixel-ratio cap by a user factor (0.5–2.0) without recreating the
// context. Everything else (gamma pass-through, manual clear for the two-pass
// viewmodel render) is unchanged from 01 §1.
import * as THREE from 'three';
import { CAMERA_FOV, CAMERA_NEAR, CAMERA_FAR } from '../constants.js';

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
  });
  const basePixelRatio = Math.min(window.devicePixelRatio, 2);
  let resScale = 1;
  renderer.setPixelRatio(basePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // gamma pass-through (01 §1)
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.sortObjects = true;
  renderer.autoClear = false;   // viewmodel pass clears depth manually

  // OVERHAUL §C — live resolution scale. cheapSize() re-applies the CURRENT
  // ratio on window resizes (setSize resets nothing here, but the base ratio
  // must ride along because setPixelRatio is sticky, not per-resize).
  const applySize = () => {
    renderer.setPixelRatio(basePixelRatio * resScale);
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  renderer.setResolutionScale = (scale) => {
    const s = Math.min(2, Math.max(0.5, Number(scale) || 1));
    if (s === resScale) return;
    resScale = s;
    applySize();
  };

  const camera = new THREE.PerspectiveCamera(
    CAMERA_FOV, window.innerWidth / window.innerHeight, CAMERA_NEAR, CAMERA_FAR);
  camera.rotation.order = 'YXZ';

  // separate fixed-FOV camera for the held-item viewmodel (03 §19)
  const viewmodelCamera = new THREE.PerspectiveCamera(
    CAMERA_FOV, window.innerWidth / window.innerHeight, 0.01, 10);

  window.addEventListener('resize', () => {
    applySize();
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    viewmodelCamera.aspect = camera.aspect;
    viewmodelCamera.updateProjectionMatrix();
  });

  return { renderer, camera, viewmodelCamera };
}
