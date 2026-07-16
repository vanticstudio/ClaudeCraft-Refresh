// Sky dome, sun/moon/stars, sunrise band, clouds, rain/snow, env lights
// (01 §14 plumbing; 04 §5–§7, §12.3, §13 values).
import * as THREE from 'three';
import { mulberry32, xmur3 } from '../math/rng.js';

const R_SKY = 400;

function makeCanvasTexture(w, h, paint) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  paint(c.getContext('2d'));
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export class Sky {
  constructor(scene) {
    this.group = new THREE.Group();       // repositioned to camera every frame
    this.group.renderOrder = -10;
    scene.add(this.group);

    // --- dome ---
    this.zenith = new THREE.Color('#78A7FF');
    this.horizon = new THREE.Color('#C6DBFF');
    const domeMat = new THREE.ShaderMaterial({
      uniforms: { uZenith: { value: this.zenith }, uHorizon: { value: this.horizon } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uZenith; uniform vec3 uHorizon; varying vec3 vDir;
        void main(){
          if (vDir.y < 0.0) { gl_FragColor = vec4(uHorizon * 0.8, 1.0); return; }
          gl_FragColor = vec4(mix(uHorizon, uZenith, clamp(vDir.y * 1.4, 0.0, 1.0)), 1.0);
        }`,
      side: THREE.BackSide, depthWrite: false, fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.IcosahedronGeometry(R_SKY, 2), domeMat);
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    this.group.add(this.dome);

    // --- celestial pivot (04 §5.4): rotation.z = celestialAngle × 2π ---
    this.pivot = new THREE.Group();
    this.group.add(this.pivot);

    // sun: white-yellow rounded square, additive (04 §5.2)
    const sunTex = makeCanvasTexture(32, 32, ctx => {
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
          const d = Math.max(Math.abs(x - 15.5), Math.abs(y - 15.5));
          const a = d < 12 ? 1 : Math.max(0, 1 - (d - 12) / 4);
          if (a > 0) { ctx.fillStyle = `rgba(255,255,229,${a})`; ctx.fillRect(x, y, 1, 1); }
        }
      }
    });
    this.sunMat = new THREE.MeshBasicMaterial({
      map: sunTex, blending: THREE.AdditiveBlending, transparent: true,
      depthWrite: false, depthTest: false, fog: false,
    });
    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), this.sunMat);
    this.sun.position.set(0, R_SKY, 0);
    this.sun.lookAt(0, 0, 0);
    this.sun.renderOrder = -9;
    this.pivot.add(this.sun);

    // moon: 4×2 phase sheet (04 §5.3)
    const moonTex = makeCanvasTexture(128, 64, ctx => {
      for (let phase = 0; phase < 8; phase++) {
        const cx = (phase % 4) * 32, cy = phase < 4 ? 0 : 32;
        ctx.fillStyle = '#C3C3C3';
        ctx.fillRect(cx + 8, cy + 8, 16, 16);
        if (phase === 4) {
          ctx.fillStyle = 'rgba(26,26,42,0.95)';
          ctx.fillRect(cx + 8, cy + 8, 16, 16);
        } else if (phase !== 0) {
          // shadowed lune: offset dark square
          const frac = [0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25][phase];
          const dir = phase < 4 ? 1 : -1;
          ctx.fillStyle = '#0A0A14';
          ctx.fillRect(cx + 8 + (dir > 0 ? 16 - 16 * frac : 0), cy + 8, 16 * frac, 16);
        }
      }
    });
    moonTex.repeat.set(0.25, 0.5);
    this.moonTex = moonTex;
    this.moonMat = new THREE.MeshBasicMaterial({
      map: moonTex, transparent: true, depthWrite: false, depthTest: false, fog: false,
    });
    this.moon = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), this.moonMat);
    this.moon.position.set(0, -R_SKY, 0);
    this.moon.lookAt(0, 0, 0);
    this.moon.renderOrder = -9;
    this.pivot.add(this.moon);

    // stars: 1500, seeded (04 §5.4)
    const rng = mulberry32(xmur3('stars')());
    const starPos = new Float32Array(1500 * 3);
    for (let i = 0; i < 1500; i++) {
      // uniform on sphere
      const u = rng() * 2 - 1, phi = rng() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      starPos[i * 3] = s * Math.cos(phi) * R_SKY * 0.9;
      starPos[i * 3 + 1] = u * R_SKY * 0.9;
      starPos[i * 3 + 2] = s * Math.sin(phi) * R_SKY * 0.9;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 1.8, sizeAttenuation: true, transparent: true,
      opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.stars.renderOrder = -9;
    this.stars.frustumCulled = false;
    this.pivot.add(this.stars);

    // sunrise/sunset band: radial-fade disc on the horizon (04 §5.5)
    this.bandMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(1, 0.5, 0.2) }, uAlpha: { value: 0 } },
      vertexShader: `varying vec2 vXY; void main(){ vXY = position.xy / 140.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; uniform float uAlpha; varying vec2 vXY;
        void main(){ float r = length(vXY);
          gl_FragColor = vec4(uColor, uAlpha * max(0.0, 1.0 - r)); }`,
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: false, fog: false, side: THREE.DoubleSide,
    });
    this.band = new THREE.Mesh(new THREE.CircleGeometry(140, 12), this.bandMat);
    this.band.renderOrder = -9;
    this.group.add(this.band);

    // --- clouds (04 §13) ---
    const cloudTex = makeCanvasTexture(256, 256, ctx => {
      const crng = mulberry32(xmur3('clouds')());
      // seeded value noise thresholded at ~30% coverage
      const grid = [];
      const N = 32;
      for (let i = 0; i <= N; i++) { grid[i] = []; for (let j = 0; j <= N; j++) grid[i][j] = crng(); }
      for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 256; x++) {
          const gx = (x / 256) * N, gy = (y / 256) * N;
          const i = Math.floor(gx), j = Math.floor(gy);
          const fx = gx - i, fy = gy - j;
          const v = grid[i][j] * (1 - fx) * (1 - fy) + grid[i + 1][j] * fx * (1 - fy) +
                    grid[i][j + 1] * (1 - fx) * fy + grid[i + 1][j + 1] * fx * fy;
          if (v > 0.58) { ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, 1, 1); }
        }
      }
    });
    cloudTex.wrapS = cloudTex.wrapT = THREE.RepeatWrapping;
    this.cloudTex = cloudTex;
    this.cloudMat = new THREE.MeshBasicMaterial({
      map: cloudTex, transparent: true, opacity: 0.75, depthWrite: false,
      fog: false, side: THREE.DoubleSide, color: 0xffffff, alphaTest: 0.1,
    });
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(3072, 3072), this.cloudMat);
    this.clouds.rotation.x = -Math.PI / 2;
    this.clouds.position.y = 110;
    this.clouds.renderOrder = -8;
    this.clouds.frustumCulled = false;
    scene.add(this.clouds);
    this.cloudDrift = 0;

    // --- scene lights for entities (04 §5.6) ---
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.9);
    scene.add(this.sunLight, this.ambient);

    // --- rain / snow instancing (04 §12.3) ---
    const rainTex = makeCanvasTexture(2, 16, ctx => {
      ctx.fillStyle = 'rgba(159,184,208,0.35)';
      ctx.fillRect(0, 0, 2, 16);
    });
    this.rainMat = new THREE.MeshBasicMaterial({
      map: rainTex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.rain = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.04 * 8, 0.6), this.rainMat, 750);
    this.rain.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rain.count = 0;
    this.rain.frustumCulled = false;
    scene.add(this.rain);
    this.rainDrops = [];
    const rrng = mulberry32(xmur3('rain')());
    for (let i = 0; i < 750; i++) {
      this.rainDrops.push({
        x: (rrng() - 0.5) * 24, z: (rrng() - 0.5) * 24, y: rrng() * 16,
        snow: false, drift: rrng() * Math.PI * 2,
      });
    }
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
    this._v = new THREE.Vector3();
  }

  setMoonPhase(phase) {
    this.moonTex.offset.set((phase % 4) / 4, phase < 4 ? 0.5 : 0);
  }

  // Called every frame by DayNight
  update({ camera, angle, zenith, horizon, starAlpha, sunAlpha, sunrise,
           cloudTint, sunIntensity, ambient, sunDir, world, rainLevel, isSnowAt, dtSec }) {
    this.group.position.copy(camera.position);
    this.pivot.rotation.z = angle * Math.PI * 2;
    this.zenith.copy(zenith);
    this.horizon.copy(horizon);
    this.starMat.opacity = starAlpha;
    this.sunMat.opacity = sunAlpha;
    this.moonMat.opacity = sunAlpha;

    if (sunrise) {
      this.bandMat.uniforms.uColor.value.setRGB(sunrise.r, sunrise.g, sunrise.b);
      this.bandMat.uniforms.uAlpha.value = sunrise.a;
      // on the sun's horizon side
      const rising = angle > 0.5;
      this.band.position.set(rising ? R_SKY * 0.9 : -R_SKY * 0.9, 0, 0);
      this.band.lookAt(this.group.position.x + this.band.position.x * 2, this.group.position.y, this.group.position.z);
      this.band.rotation.set(0, rising ? -Math.PI / 2 : Math.PI / 2, 0);
      this.band.visible = true;
    } else {
      this.band.visible = false;
    }

    // clouds: world-anchored, snapped to 12 m grid (04 §13)
    this.cloudDrift += 0.02 * dtSec * 20;
    this.clouds.position.x = Math.floor(camera.position.x / 12) * 12;
    this.clouds.position.z = Math.floor(camera.position.z / 12) * 12;
    this.cloudTex.offset.set((this.clouds.position.x + this.cloudDrift) / 3072, this.clouds.position.z / 3072);
    this.cloudMat.color.setScalar(cloudTint);

    // env lights
    this.sunLight.intensity = sunIntensity;
    this.ambient.intensity = ambient;
    this.sunLight.position.set(sunDir.x * 100, Math.abs(sunDir.y) * 100 + 10, sunDir.z * 100);

    // rain
    const visible = Math.floor(750 * rainLevel);
    this.rain.count = visible;
    if (visible > 0 && world) {
      const camX = camera.position.x, camZ = camera.position.z;
      const camY = camera.position.y;
      const yaw = Math.atan2(camera.position.x - (camX + 1), 0);   // billboard toward camera yaw
      for (let i = 0; i < visible; i++) {
        const d = this.rainDrops[i];
        const wx = camX + d.x, wz = camZ + d.z;
        const snow = isSnowAt ? isSnowAt(wx, wz) : false;
        const fall = snow ? 2 : 14;
        d.y -= fall * dtSec;
        const ground = world.heightTop(Math.floor(wx), Math.floor(wz));
        if (camY - 8 + d.y < ground || d.y < 0) d.y = 16;
        const px = wx + (snow ? Math.sin(d.drift + d.y) * 0.5 : 0);
        const py = camY - 8 + d.y;
        if (py < ground) continue;
        this._v.set(px, py, wz);
        this._q.setFromAxisAngle(UP, Math.atan2(camX - px, camZ - wz));
        this._s.setScalar(snow ? 0.5 : 1);
        this._m4.compose(this._v, this._q, this._s);
        this.rain.setMatrixAt(i, this._m4);
      }
      this.rain.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.clouds.parent?.remove(this.clouds);
    this.rain.parent?.remove(this.rain);
    this.sunLight.parent?.remove(this.sunLight);
    this.ambient.parent?.remove(this.ambient);
  }
}

const UP = new THREE.Vector3(0, 1, 0);
