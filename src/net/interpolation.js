// 14-MULTIPLAYER §4.4 — remote-entity interpolation. Every replicated entity keeps
// a ring of recent snapshot samples; puppets render 100 ms in the past (Valve's
// cl_interp shape) with ≤50 ms extrapolation to absorb TCP stalls.
import { lerp, lerpAngle } from '../entities/Entity.js';

const BUFFER = 12;               // samples per entity
export const INTERP_DELAY = 100; // ms behind newest
export const EXTRAP_MAX = 50;    // ms

export class Interpolator {
  constructor() {
    this.tracks = new Map();     // entityId → { samples:[], newest }
    this.interpTime = 0;         // host-clock ms domain
    this.hostEpochOffset = 0;    // hostTick*50 → client performance.now() (§7.1)
    this.haveClock = false;
    this.newestSampleTime = 0;
  }

  // hostTick timestamp (ms on host clock) → client clock ms.
  setClock(hostEpochOffset) { this.hostEpochOffset = hostEpochOffset; this.haveClock = true; }

  // Add a snapshot sample for an entity. `time` = hostTick*50 (host clock ms).
  addSample(id, time, s) {
    let t = this.tracks.get(id);
    if (!t) { t = { samples: [] }; this.tracks.set(id, t); }
    // drop out-of-order / duplicate
    const last = t.samples[t.samples.length - 1];
    if (last && time <= last.time) return;
    t.samples.push({ time, ...s });
    if (t.samples.length > BUFFER) t.samples.shift();
    if (time > this.newestSampleTime) this.newestSampleTime = time;
  }

  remove(id) { this.tracks.delete(id); }
  has(id) { return this.tracks.has(id); }
  clear() { this.tracks.clear(); this.newestSampleTime = 0; }

  // Advance the render clock each frame (§4.4). renderNow = performance.now().
  advance(frameDeltaMs) {
    // target = newest host-clock sample time − INTERP_DELAY, mapped to client clock
    const target = this.newestSampleTime - INTERP_DELAY;
    if (!this._init && this.newestSampleTime > 0) { this.interpTime = target; this._init = true; }
    this.interpTime += frameDeltaMs;
    this.interpTime += (target - this.interpTime) * 0.05;   // soft re-anchor
  }

  // Sample an entity at the current interpTime → interpolated transform, or null.
  sample(id) {
    const t = this.tracks.get(id);
    if (!t || t.samples.length === 0) return null;
    const s = t.samples;
    const it = this.interpTime;
    if (it <= s[0].time) return { ...s[0], vel: { x: s[0].vx, y: s[0].vy, z: s[0].vz } };
    const newest = s[s.length - 1];
    if (it >= newest.time) {
      // stall → extrapolate along velocity, then freeze (§4.4)
      const dt = Math.min(it - newest.time, EXTRAP_MAX);
      return {
        x: newest.x + newest.vx * dt / 50,
        y: newest.y + newest.vy * dt / 50,
        z: newest.z + newest.vz * dt / 50,
        yaw: newest.yaw, pitch: newest.pitch, flags: newest.flags,
        stateByte: newest.stateByte, health: newest.health,
        vel: { x: newest.vx, y: newest.vy, z: newest.vz },
      };
    }
    // find bracketing samples
    for (let i = 0; i < s.length - 1; i++) {
      const a = s[i], b = s[i + 1];
      if (it >= a.time && it <= b.time) {
        const u = (it - a.time) / Math.max(1, b.time - a.time);
        return {
          x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), z: lerp(a.z, b.z, u),
          yaw: lerpAngle(a.yaw, b.yaw, u), pitch: lerp(a.pitch, b.pitch, u),
          flags: b.flags, stateByte: b.stateByte, health: b.health,
          vel: { x: b.vx, y: b.vy, z: b.vz },
        };
      }
    }
    return { ...newest, vel: { x: newest.vx, y: newest.vy, z: newest.vz } };
  }
}
