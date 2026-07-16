// WebGLRenderer + camera + resize (01 §1).
import * as THREE from 'three';
import { CAMERA_FOV, CAMERA_NEAR, CAMERA_FAR } from '../constants.js';

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // gamma pass-through (01 §1)
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.sortObjects = true;
  renderer.autoClear = false;   // viewmodel pass clears depth manually

  const camera = new THREE.PerspectiveCamera(
    CAMERA_FOV, window.innerWidth / window.innerHeight, CAMERA_NEAR, CAMERA_FAR);
  camera.rotation.order = 'YXZ';

  // separate fixed-FOV camera for the held-item viewmodel (03 §19)
  const viewmodelCamera = new THREE.PerspectiveCamera(
    CAMERA_FOV, window.innerWidth / window.innerHeight, 0.01, 10);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    viewmodelCamera.aspect = camera.aspect;
    viewmodelCamera.updateProjectionMatrix();
  });

  return { renderer, camera, viewmodelCamera };
}
